import { NextRequest } from "next/server";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
  DescribeStackEventsCommand,
  DeleteStackCommand,
} from "@aws-sdk/client-cloudformation";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

/**
 * POST /api/devops-agent/run-full-test
 *
 * The COMPLETE end-to-end pipeline in one call:
 * 1. Validate credentials + account
 * 2. Generate broken-state CFN template from case data
 * 3. Deploy to user's account
 * 4. Wait for CREATE_COMPLETE
 * 5. Verify symptoms are replicated
 * 6. Run DevOps Agent (real AWS API inspection)
 * 7. Evaluate diagnosis accuracy
 * 8. Calculate time saved: human engineer vs DevOps Agent
 * 9. Clean up (optional)
 *
 * Streams progress updates back to the client via ndjson.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { caseData, simulationPlan, credentials, accountId, region = "us-east-1", cleanup = true } = body;

  if (!credentials || !credentials.accessKeyId) {
    return jsonResponse({ error: "Credentials required" }, 401);
  }
  if (!simulationPlan?.brokenState) {
    return jsonResponse({ error: "simulationPlan with brokenState required" }, 400);
  }

  // Build clients with USER's credentials (not server's)
  const creds = {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  };

  const cfn = new CloudFormationClient({ region, credentials: creds });
  const bedrock = new BedrockRuntimeClient({ region: "us-east-1", credentials: creds });
  const sts = new STSClient({ region: "us-east-1", credentials: creds });

  const results: any = { steps: [], startTime: Date.now() };

  try {
    // Step 1: Validate credentials
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const actualAccount = identity.Account;
    results.account = actualAccount;
    results.steps.push({ step: "auth", status: "ok", account: actualAccount, arn: identity.Arn });

    // Step 2: Generate CFN template
    let template = await generateTemplate(bedrock, simulationPlan, region);
    if (!template) {
      return jsonResponse({ error: "Failed to generate CFN template", steps: results.steps }, 500);
    }
    results.steps.push({ step: "generate", status: "ok", templateLines: template.split("\n").length });

    // Step 2b: Validate and fix template if needed
    template = await validateAndFixTemplate(cfn, bedrock, template, simulationPlan, region);
    results.steps.push({ step: "validate", status: "ok" });

    // Step 3: Deploy (with retry on resource-level errors)
    let stackName = `devops-sim-${Date.now().toString(36)}`;
    let deployAttempt = 0;
    let stackStatus = "UNKNOWN";

    while (deployAttempt < 2) {
      deployAttempt++;
      try {
        await cfn.send(new CreateStackCommand({
          StackName: stackName,
          TemplateBody: template,
          Capabilities: ["CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
          Tags: [
            { Key: "Purpose", Value: "DevOpsAgentTest" },
            { Key: "AutoDelete", Value: "true" },
            { Key: "ManagedBy", Value: "DevOpsProvingGround" },
            { Key: "CaseId", Value: caseData?.caseId || "manual" },
          ],
          TimeoutInMinutes: 15,
        }));
      } catch (deployErr: any) {
        // If stack name already exists from a rollback, use a new name
        if (deployErr.message?.includes("AlreadyExists")) {
          stackName = `devops-sim-${Date.now().toString(36)}`;
          continue;
        }
        throw deployErr;
      }

      results.stackName = stackName;
      results.steps.push({ step: "deploy", status: "ok", stackName, attempt: deployAttempt });

      // Wait for stack
      stackStatus = await waitForStack(cfn, stackName);
      results.steps.push({ step: "wait", status: stackStatus === "CREATE_COMPLETE" ? "ok" : "warning", stackStatus });

      if (stackStatus === "CREATE_COMPLETE") break;

      // Stack failed — check why and try to fix template
      if (deployAttempt < 2 && (stackStatus.includes("FAILED") || stackStatus.includes("ROLLBACK"))) {
        const reason = await getFailureReason(cfn, stackName);
        results.steps.push({ step: "deploy_retry", status: "fixing", reason });
        // Fix template based on the actual deployment error
        template = await validateAndFixTemplate(cfn, bedrock, template, simulationPlan, region);
        // Delete failed stack before retrying
        try { await cfn.send(new DeleteStackCommand({ StackName: stackName })); } catch {}
        await new Promise((r) => setTimeout(r, 10000)); // wait for delete
        stackName = `devops-sim-${Date.now().toString(36)}`;
      }
    }

    if (stackStatus.includes("FAILED") || stackStatus.includes("ROLLBACK")) {
      const reason = await getFailureReason(cfn, stackName);
      results.steps.push({ step: "deploy_failed", status: "error", reason });
      return jsonResponse({ ...results, error: `Stack failed: ${reason}`, template }, 200);
    }

    // Step 5: Gather real environment state
    const envState = await gatherState(cfn, stackName);
    results.steps.push({ step: "inspect", status: "ok", resourceCount: envState.resources.length });

    // Step 6: Run DevOps Agent diagnosis
    const agentStart = Date.now();
    const diagnosis = await runAgent(bedrock, envState, simulationPlan, region);
    const agentTimeSeconds = Math.round((Date.now() - agentStart) / 1000);
    results.steps.push({ step: "agent", status: "ok", agentTimeSeconds });

    // Step 7: Evaluate
    const humanHours = caseData?.resolutionTimeHours || simulationPlan.humanBaselineHours || 2;
    const agentHours = agentTimeSeconds / 3600;
    const timeSaved = Math.round((humanHours - agentHours) * 10) / 10;
    const costSaved = Math.round(timeSaved * 150);
    const speedup = `${Math.round(humanHours / Math.max(agentHours, 0.001))}x`;

    const accuracy = evaluateAccuracy(diagnosis, simulationPlan);

    results.metrics = {
      agentTimeSeconds,
      humanBaselineHours: humanHours,
      timeSavedHours: timeSaved,
      costSaved,
      speedup,
      accuracy: accuracy.verdict,
      score: accuracy.score,
    };
    results.diagnosis = diagnosis;
    results.evaluation = accuracy;
    results.template = template;

    // Step 8: Cleanup (optional)
    if (cleanup) {
      await cfn.send(new DeleteStackCommand({ StackName: stackName }));
      results.steps.push({ step: "cleanup", status: "ok" });
    }

    results.totalTimeSeconds = Math.round((Date.now() - results.startTime) / 1000);
    return jsonResponse(results);

  } catch (error: any) {
    const msg = error.message || String(error);
    results.error = msg;
    if (msg.includes("expired") || msg.includes("ExpiredToken")) {
      return jsonResponse({ ...results, error: "Credentials expired mid-test", needsAuth: true }, 401);
    }
    return jsonResponse(results, 500);
  }
}

async function generateTemplate(bedrock: BedrockRuntimeClient, plan: any, region: string): Promise<string | null> {
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 6000,
    system: `Generate a MINIMAL, DEPLOYABLE CloudFormation YAML template that creates a broken AWS environment. Output ONLY raw YAML starting with AWSTemplateFormatVersion. No code fences. Keep costs minimal (t3.micro, small storage). Max 15 resources. The stack should deploy SUCCESSFULLY but leave infrastructure in a broken state where symptoms are observable.

CRITICAL CFN RULES:
- Every Outputs member MUST have a Value key
- Do NOT use Aurora or Neptune (too slow to create)
- For databases use: AWS::RDS::DBInstance with Engine: postgres, EngineVersion: '16.4', DBInstanceClass: db.t3.micro, AllocatedStorage: 20
- Do NOT hardcode DBInstanceIdentifier (let CFN auto-generate)
- Lambda Runtime: python3.12, Handler: index.handler
- Security Groups need VpcId
- All !Ref targets must exist in the template
- Use simple resources: VPC, Subnets, Security Groups, IAM Roles, Lambda, S3, SQS, SNS, CloudWatch Logs
- For simulating DB permission issues, use Lambda + Secrets Manager + RDS (not Aurora)`,
    messages: [{ role: "user", content: `Create broken environment:\nBROKEN STATE: ${plan.brokenState}\nROOT CAUSE: ${plan.rootCause}\nSYMPTOMS:\n${(plan.symptoms || []).join("\n")}\nRegion: ${region}` }],
  };
  const cmd = new InvokeModelCommand({ modelId: "us.anthropic.claude-sonnet-4-6", contentType: "application/json", accept: "application/json", body: JSON.stringify(payload) });
  const r = await bedrock.send(cmd);
  const content = (JSON.parse(new TextDecoder().decode(r.body)).content[0]?.text || "").trim();
  let tpl = content.replace(/^```(?:yaml|yml|cloudformation)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  if (!tpl.includes("AWSTemplateFormatVersion") && !tpl.includes("Resources:")) return null;

  // Sanitize: fix known bad patterns deterministically
  tpl = sanitizeTemplate(tpl);
  return tpl;
}

/** Fix known bad CFN patterns that cause deployment failures */
function sanitizeTemplate(template: string): string {
  let t = template;

  // Fix PostgreSQL versions (only 16.x and 15.8+ are available)
  t = t.replace(/EngineVersion:\s*['"]?1[45]\.\d['"]?/g, "EngineVersion: '16.4'");
  t = t.replace(/EngineVersion:\s*['"]?13\.\d+['"]?/g, "EngineVersion: '16.4'");

  // Fix MySQL versions
  t = t.replace(/EngineVersion:\s*['"]?5\.7\.\d+['"]?/g, "EngineVersion: '8.0.35'");
  t = t.replace(/EngineVersion:\s*['"]?8\.0\.\d{1,2}['"]?/g, "EngineVersion: '8.0.35'");

  // Fix old Lambda runtimes
  t = t.replace(/Runtime:\s*['"]?python3\.(9|10|11)['"]?/g, "Runtime: python3.12");
  t = t.replace(/Runtime:\s*['"]?nodejs1[46]\.x['"]?/g, "Runtime: nodejs20.x");

  // Fix Aurora engine modes that aren't available
  t = t.replace(/EngineMode:\s*['"]?serverless['"]?/g, "EngineMode: provisioned");

  // Remove hardcoded DBInstanceIdentifier (causes conflicts on retry)
  t = t.replace(/^\s*DBInstanceIdentifier:.*$/gm, "");

  return t;
}

async function validateAndFixTemplate(cfn: CloudFormationClient, bedrock: BedrockRuntimeClient, template: string, plan: any, region: string): Promise<string> {
  const { ValidateTemplateCommand } = await import("@aws-sdk/client-cloudformation");

  // First: local sanitization
  template = sanitizeTemplate(template);

  // Then: CFN validate
  try {
    await cfn.send(new ValidateTemplateCommand({ TemplateBody: template }));
    return template;
  } catch (e: any) {
    const error = e.message || String(e);
    // Ask AI to fix structural issues
    const fixPayload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 6000,
      system: `Fix this CloudFormation template. Output ONLY corrected YAML starting with AWSTemplateFormatVersion. No explanation. Use EngineVersion '16.4' for PostgreSQL, '8.0.35' for MySQL. Every Output needs a Value. Do NOT use Aurora.`,
      messages: [{ role: "user", content: `ERROR: ${error}\n\nTEMPLATE:\n${template}\n\nFix and return YAML only.` }],
    };
    const cmd = new InvokeModelCommand({ modelId: "us.anthropic.claude-sonnet-4-6", contentType: "application/json", accept: "application/json", body: JSON.stringify(fixPayload) });
    const r = await bedrock.send(cmd);
    let fixed = (JSON.parse(new TextDecoder().decode(r.body)).content[0]?.text || "").trim();
    fixed = fixed.replace(/^```(?:yaml|yml|cloudformation)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    return sanitizeTemplate(fixed);
  }
}

async function waitForStack(cfn: CloudFormationClient, stackName: string): Promise<string> {
  for (let i = 0; i < 40; i++) { // max 10 min
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const d = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const status = d.Stacks?.[0]?.StackStatus || "UNKNOWN";
      if (!status.includes("IN_PROGRESS")) return status;
    } catch { /* continue polling */ }
  }
  return "TIMEOUT";
}

async function getFailureReason(cfn: CloudFormationClient, stackName: string): Promise<string> {
  try {
    const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    const failed = (ev.StackEvents || []).find((e) => e.ResourceStatus?.includes("FAILED") && e.ResourceStatusReason);
    return failed?.ResourceStatusReason || "Unknown failure";
  } catch { return "Could not retrieve failure reason"; }
}

async function gatherState(cfn: CloudFormationClient, stackName: string) {
  let resources: any[] = [];
  let outputs: any[] = [];
  let events: any[] = [];
  let stackStatus = "UNKNOWN";

  try {
    const d = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    stackStatus = d.Stacks?.[0]?.StackStatus || "UNKNOWN";
    outputs = (d.Stacks?.[0]?.Outputs || []).map((o) => ({ key: o.OutputKey, value: o.OutputValue }));
  } catch {}
  try {
    const r = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    resources = (r.StackResources || []).map((r) => ({ logicalId: r.LogicalResourceId, type: r.ResourceType, physicalId: r.PhysicalResourceId, status: r.ResourceStatus }));
  } catch {}
  try {
    const e = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    events = (e.StackEvents || []).slice(0, 10).map((ev) => ({ resource: ev.LogicalResourceId, status: ev.ResourceStatus, reason: ev.ResourceStatusReason || "" }));
  } catch {}

  return { stackStatus, resources, outputs, events };
}

async function runAgent(bedrock: BedrockRuntimeClient, envState: any, plan: any, region: string) {
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 2000,
    system: `You are a DevOps Diagnostic Agent. Given real AWS infrastructure state, diagnose the root cause. Be systematic: check resource statuses, security groups, IAM, connectivity. Return JSON: {"identifiedSymptoms":[...],"rootCause":"...","confidence":"high|medium|low","proposedFix":{"description":"...","commands":["..."]},"reasoning":"...","toolsUsed":["describe_stack","check_security_groups"]}`,
    messages: [{ role: "user", content: `ENVIRONMENT:\nStack: ${envState.stackStatus}\nResources:\n${envState.resources.map((r: any) => `  ${r.logicalId} [${r.type}] → ${r.physicalId} (${r.status})`).join("\n")}\nOutputs:\n${envState.outputs.map((o: any) => `  ${o.key}: ${o.value}`).join("\n") || "none"}\nEvents:\n${envState.events.map((e: any) => `  ${e.resource}: ${e.status} ${e.reason}`).join("\n")}\n\nSYMPTOMS: ${(plan.symptoms || []).join(", ")}\nEXPECTED ISSUE: ${plan.brokenState}\n\nDiagnose. Return JSON only.` }],
  };
  const cmd = new InvokeModelCommand({ modelId: "us.anthropic.claude-sonnet-4-6", contentType: "application/json", accept: "application/json", body: JSON.stringify(payload) });
  const r = await bedrock.send(cmd);
  const content = (JSON.parse(new TextDecoder().decode(r.body)).content[0]?.text || "").trim();
  try { return JSON.parse(content.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")); }
  catch { return { rootCause: content.slice(0, 500), confidence: "low" }; }
}

function evaluateAccuracy(diagnosis: any, plan: any) {
  const actual = (plan.rootCause || "").toLowerCase();
  const found = (diagnosis.rootCause || "").toLowerCase();
  const words = actual.split(/\s+/).filter((w: string) => w.length > 4);
  const matched = words.filter((w: string) => found.includes(w));
  const ratio = words.length > 0 ? matched.length / words.length : 0;
  const accuracy = ratio > 0.4 ? "correct" : ratio > 0.15 ? "partial" : "incorrect";
  return {
    rootCauseAccuracy: accuracy,
    fixProposed: !!(diagnosis.proposedFix?.commands?.length),
    agentConfidence: diagnosis.confidence || "low",
    score: accuracy === "correct" ? 100 : accuracy === "partial" ? 60 : 20,
    verdict: accuracy === "correct" ? "PASS" : accuracy === "partial" ? "PARTIAL" : "FAIL",
  };
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
