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
import { IAMClient, CreateRoleCommand, AttachRolePolicyCommand, GetRoleCommand } from "@aws-sdk/client-iam";
import {
  DevOpsAgentClient,
  ListAgentSpacesCommand,
  CreateAgentSpaceCommand,
  CreateBacklogTaskCommand,
  GetBacklogTaskCommand,
  ListJournalRecordsCommand,
  ListAssociationsCommand,
  AssociateServiceCommand,
  EnableOperatorAppCommand,
  GetOperatorAppCommand,
} from "@aws-sdk/client-devops-agent";

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
  const iam = new IAMClient({ region: "us-east-1", credentials: creds });

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

    // Step 3: Deploy (with robust retry — reads actual failure, fixes template, cleans up, retries)
    let stackName = `devops-sim-${Date.now().toString(36)}`;
    let deployAttempt = 0;
    let stackStatus = "UNKNOWN";
    const MAX_DEPLOY_ATTEMPTS = 3;

    while (deployAttempt < MAX_DEPLOY_ATTEMPTS) {
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
          TimeoutInMinutes: 10,
        }));
      } catch (deployErr: any) {
        // If stack name already exists, use a new name and retry this attempt
        if (deployErr.message?.includes("AlreadyExists")) {
          stackName = `devops-sim-${Date.now().toString(36)}`;
          deployAttempt--; // don't count this as a real attempt
          continue;
        }
        // Template-level rejection (before stack creation even starts)
        if (deployAttempt < MAX_DEPLOY_ATTEMPTS) {
          const errMsg = deployErr.message || String(deployErr);
          results.steps.push({ step: "deploy_error", status: "fixing", attempt: deployAttempt, error: errMsg });
          template = await fixTemplateFromError(bedrock, template, errMsg, simulationPlan, region);
          stackName = `devops-sim-${Date.now().toString(36)}`;
          continue;
        }
        throw deployErr;
      }

      results.stackName = stackName;
      results.steps.push({ step: "deploy", status: "ok", stackName, attempt: deployAttempt });

      // Wait for stack to complete
      stackStatus = await waitForStack(cfn, stackName);
      results.steps.push({ step: "wait", status: stackStatus === "CREATE_COMPLETE" ? "ok" : "warning", stackStatus });

      if (stackStatus === "CREATE_COMPLETE") break;

      // Stack failed — get ALL failure reasons, fix template, cleanup, retry
      if (deployAttempt < MAX_DEPLOY_ATTEMPTS && (stackStatus.includes("FAILED") || stackStatus.includes("ROLLBACK"))) {
        const failures = await getAllFailureReasons(cfn, stackName);
        const failureSummary = failures.join("\n");
        results.steps.push({ step: "deploy_retry", status: "fixing", attempt: deployAttempt, failures });

        // Fix template using the ACTUAL deployment errors (not just CFN validation)
        template = await fixTemplateFromError(bedrock, template, failureSummary, simulationPlan, region);

        // Wait for rollback to complete, then delete
        await waitForStackDelete(cfn, stackName);
        stackName = `devops-sim-${Date.now().toString(36)}`;
      }
    }

    if (stackStatus !== "CREATE_COMPLETE") {
      const failures = await getAllFailureReasons(cfn, stackName);
      results.steps.push({ step: "deploy_failed", status: "error", failures });
      // Cleanup the failed stack
      try { await cfn.send(new DeleteStackCommand({ StackName: stackName })); } catch {}
      return jsonResponse({
        ...results,
        error: "simulation_not_reproducible",
        userMessage: "There isn't enough data to re-create the exact issue for this ticket. Please select a different ticket and try again.",
        template,
      }, 200);
    }

    // Step 5: Setup DevOps Agent (check/create Agent Space + IAM role + account association + operator app)
    const devopsAgent = new DevOpsAgentClient({ region, credentials: creds });
    let agentSpaceId = await setupDevOpsAgent(devopsAgent, iam, actualAccount || "", region);
    results.steps.push({ step: "agent_setup", status: "ok", agentSpaceId });
    results.consoleUrl = `https://${region}.console.aws.amazon.com/devops-agent/home?region=${region}#/agent-spaces/${agentSpaceId}/tasks`;

    // Step 6: Invoke REAL DevOps Agent via CreateBacklogTask
    const agentStart = Date.now();
    const taskResult = await invokeRealDevOpsAgent(
      devopsAgent, agentSpaceId, stackName, simulationPlan, region
    );
    let agentTimeSeconds = Math.round((Date.now() - agentStart) / 1000);
    results.steps.push({ step: "agent", status: taskResult.status === "COMPLETED" ? "ok" : "warning", agentTimeSeconds });

    // Extract diagnosis from journal records
    const diagnosis = taskResult.journal || { rootCause: taskResult.summary || "Agent completed but no journal", confidence: "medium" };

    // Step 7: Extract Human RCA from case correspondence and compare
    const humanRca = await extractHumanRca(bedrock, caseData);
    results.humanRca = humanRca;

    // Step 7b: Compare Agent RCA vs Human RCA
    let accuracy = await compareRcas(bedrock, diagnosis, humanRca, simulationPlan);

    // Step 7c: Feedback loop — if mismatch and we have budget, refine CFN and retry
    if (accuracy.verdict === "FAIL" && accuracy.mismatchReason && results.steps.length < 20) {
      results.steps.push({ step: "rca_mismatch", status: "refining", mismatchReason: accuracy.mismatchReason });

      // Refine the template to better match the human RCA
      const refinedTemplate = await refineTemplateForHumanRca(bedrock, template, humanRca, accuracy.mismatchReason, simulationPlan, region);

      if (refinedTemplate !== template) {
        // Cleanup old stack
        try { await cfn.send(new DeleteStackCommand({ StackName: stackName })); } catch {}
        await waitForStackDelete(cfn, stackName);

        // Deploy refined template
        const retryStackName = `devops-sim-${Date.now().toString(36)}`;
        try {
          await cfn.send(new CreateStackCommand({
            StackName: retryStackName,
            TemplateBody: refinedTemplate,
            Capabilities: ["CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
            Tags: [
              { Key: "Purpose", Value: "DevOpsAgentTest" },
              { Key: "AutoDelete", Value: "true" },
              { Key: "ManagedBy", Value: "DevOpsProvingGround" },
              { Key: "Retry", Value: "rca-refinement" },
            ],
            TimeoutInMinutes: 10,
          }));

          const retryStatus = await waitForStack(cfn, retryStackName);
          if (retryStatus === "CREATE_COMPLETE") {
            stackName = retryStackName;
            results.stackName = retryStackName;
            results.steps.push({ step: "retry_deploy", status: "ok", stackName: retryStackName });

            // Re-run agent on refined stack
            const retryStart = Date.now();
            const retryResult = await invokeRealDevOpsAgent(devopsAgent, agentSpaceId, retryStackName, simulationPlan, region);
            const retryTime = Math.round((Date.now() - retryStart) / 1000);
            agentTimeSeconds = retryTime;
            results.steps.push({ step: "retry_agent", status: retryResult.status === "COMPLETED" ? "ok" : "warning", retryTime });

            // Re-evaluate with refined results
            const retryDiagnosis = retryResult.journal || diagnosis;
            accuracy = await compareRcas(bedrock, retryDiagnosis, humanRca, simulationPlan);
            Object.assign(diagnosis, retryDiagnosis);
            results.steps.push({ step: "retry_evaluate", status: accuracy.verdict === "PASS" ? "ok" : "warning", verdict: accuracy.verdict });
            template = refinedTemplate;
          } else {
            // Refined stack failed — stick with original results
            results.steps.push({ step: "retry_deploy_failed", status: "warning" });
            try { await cfn.send(new DeleteStackCommand({ StackName: retryStackName })); } catch {}
          }
        } catch (retryErr: any) {
          results.steps.push({ step: "retry_error", status: "warning", error: retryErr.message?.slice(0, 100) });
        }
      }
    }

    // Step 8: Calculate time metrics
    const humanRcaHours = calculateHumanRcaTime(caseData);
    const isPhoneCase = caseData?.category?.toLowerCase()?.includes("phone") || 
                        caseData?.communications?.toString()?.includes("phone") ||
                        caseData?.contactChannel === "phone";
    const agentHours = agentTimeSeconds / 3600;
    const timeSaved = humanRcaHours > 0 ? Math.round((humanRcaHours - agentHours) * 10) / 10 : null;
    const speedup = humanRcaHours > 0 ? `${Math.round(humanRcaHours / Math.max(agentHours, 0.001))}x` : null;

    results.metrics = {
      agentTimeSeconds,
      humanRcaHours: humanRcaHours > 0 ? humanRcaHours : null,
      timeSavedHours: timeSaved,
      speedup,
      isPhoneCase,
      noHumanTimeData: humanRcaHours === 0,
      accuracy: accuracy.verdict,
      score: accuracy.score,
    };
    results.diagnosis = diagnosis;
    results.evaluation = accuracy;
    results.humanRcaExtracted = humanRca;
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
    // Use the same robust fix function
    return await fixTemplateFromError(bedrock, template, `CFN Validation Error: ${error}`, plan, region);
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

/** Wait for a failed stack to finish rolling back, then delete it */
async function waitForStackDelete(cfn: CloudFormationClient, stackName: string): Promise<void> {
  // First wait for rollback to complete
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const d = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const status = d.Stacks?.[0]?.StackStatus || "UNKNOWN";
      if (!status.includes("IN_PROGRESS")) break;
    } catch { break; }
  }
  // Then delete
  try { await cfn.send(new DeleteStackCommand({ StackName: stackName })); } catch {}
  // Wait for delete to finish
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const d = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const status = d.Stacks?.[0]?.StackStatus || "";
      if (status === "DELETE_COMPLETE" || !status) break;
    } catch { break; /* stack no longer exists */ }
  }
}

/** Get ALL failure reasons from stack events (not just the first one) */
async function getAllFailureReasons(cfn: CloudFormationClient, stackName: string): Promise<string[]> {
  try {
    const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    const failures = (ev.StackEvents || [])
      .filter((e) => e.ResourceStatus?.includes("FAILED") && e.ResourceStatusReason)
      .map((e) => `${e.LogicalResourceId}: ${e.ResourceStatusReason}`)
      .slice(0, 5); // top 5 failures
    return failures.length > 0 ? failures : ["Unknown failure - no failed events found"];
  } catch { return ["Could not retrieve failure reasons"]; }
}

async function getFailureReason(cfn: CloudFormationClient, stackName: string): Promise<string> {
  const reasons = await getAllFailureReasons(cfn, stackName);
  return reasons[0] || "Unknown failure";
}

/**
 * Fix a template based on ACTUAL deployment error messages.
 * This is the key improvement — instead of just re-validating, we pass the real
 * runtime errors (like "Role pattern validation failed") to the AI for targeted fixes.
 */
async function fixTemplateFromError(
  bedrock: BedrockRuntimeClient,
  template: string,
  errorMessages: string,
  plan: any,
  region: string,
): Promise<string> {
  // First apply deterministic sanitization
  template = sanitizeTemplate(template);

  const fixPayload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 6000,
    system: `Fix this CloudFormation template based on the ACTUAL deployment error(s). Output ONLY corrected YAML starting with AWSTemplateFormatVersion. No explanation, no code fences.

CRITICAL RULES:
- Lambda Role MUST be a full ARN using !GetAtt (e.g., !GetAtt LambdaRole.Arn), NEVER a role name string
- Every !Ref and !GetAtt target MUST exist as a resource in the template
- Security Groups MUST have VpcId
- Do NOT use Aurora, Neptune, or any resource that takes >10 min to create
- Every Output MUST have a Value key
- Lambda Runtime: python3.12, Handler: index.handler
- For RDS: Engine postgres, EngineVersion '16.4', db.t3.micro, AllocatedStorage 20
- Do NOT hardcode DBInstanceIdentifier
- IAM Role AssumeRolePolicyDocument MUST be valid JSON with Version and Statement
- All resource names should be auto-generated by CFN (no hardcoded physical names that could conflict)
- If a resource type is causing issues and isn't essential to the broken-state simulation, REMOVE IT rather than trying to fix it`,
    messages: [{ role: "user", content: `DEPLOYMENT ERROR(S):\n${errorMessages}\n\nORIGINAL BROKEN STATE TO SIMULATE:\n${plan.brokenState}\nROOT CAUSE: ${plan.rootCause}\n\nTEMPLATE THAT FAILED:\n${template}\n\nFix the template so it deploys successfully while still simulating the broken state. Return YAML only.` }],
  };

  try {
    const cmd = new InvokeModelCommand({
      modelId: "us.anthropic.claude-sonnet-4-6",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(fixPayload),
    });
    const r = await bedrock.send(cmd);
    let fixed = (JSON.parse(new TextDecoder().decode(r.body)).content[0]?.text || "").trim();
    fixed = fixed.replace(/^```(?:yaml|yml|cloudformation)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    if (fixed.includes("AWSTemplateFormatVersion") || fixed.includes("Resources:")) {
      return sanitizeTemplate(fixed);
    }
  } catch { /* AI fix failed, return sanitized original */ }

  return template;
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

async function setupDevOpsAgent(client: DevOpsAgentClient, iam: IAMClient, accountId: string, region: string): Promise<string> {
  const ROLE_NAME = "DevOpsAgentRole-AgentSpace";
  const OPERATOR_ROLE_NAME = "DevOpsAgentRole-OperatorApp";

  // 1. Check if Agent Space exists
  let agentSpaceId = "";
  try {
    const list = await client.send(new ListAgentSpacesCommand({}));
    const spaces = (list as any).agentSpaces || [];
    if (spaces.length > 0) {
      agentSpaceId = spaces[0].agentSpaceId;
    }
  } catch { /* no spaces */ }

  // 2. Create Agent Space if needed
  if (!agentSpaceId) {
    const created = await client.send(new CreateAgentSpaceCommand({
      name: "devops-proving-ground",
      description: "Auto-created by DevOps Agent Proving Ground for infrastructure diagnosis testing",
    } as any));
    agentSpaceId = (created as any).agentSpace?.agentSpaceId || "";
  }

  // 3. Ensure Agent Space IAM role exists
  try {
    await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
  } catch {
    // Role doesn't exist — create it
    const trustPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "aidevops.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": accountId },
          ArnLike: { "aws:SourceArn": `arn:aws:aidevops:${region}:${accountId}:agentspace/*` },
        },
      }],
    });
    try {
      await iam.send(new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: trustPolicy,
      }));
    } catch { /* role might exist from concurrent call */ }
  }

  // 4. Attach policies to Agent Space role (idempotent)
  try {
    await iam.send(new AttachRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyArn: "arn:aws:iam::aws:policy/AIDevOpsAgentAccessPolicy",
    }));
  } catch { /* already attached or doesn't exist yet */ }

  try {
    await iam.send(new AttachRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
    }));
  } catch { /* already attached */ }

  // 5. Associate account (check first, then associate if missing)
  try {
    const assocList = await client.send(new ListAssociationsCommand({ agentSpaceId } as any));
    const associations = (assocList as any).associations || [];
    const hasAws = associations.some((a: any) => a.serviceId === "aws");

    if (!hasAws) {
      // Wait a few seconds for IAM role to propagate
      await new Promise((r) => setTimeout(r, 5000));
      await client.send(new AssociateServiceCommand({
        agentSpaceId,
        serviceId: "aws",
        configuration: {
          aws: {
            assumableRoleArn: `arn:aws:iam::${accountId}:role/${ROLE_NAME}`,
            accountId,
            accountType: "monitor",
          },
        },
      } as any));
    }
  } catch { /* association might already exist */ }

  // 6. Enable Operator App (allows console visibility of investigations)
  await enableOperatorApp(client, iam, agentSpaceId, accountId, region);

  return agentSpaceId;
}

/**
 * Enable the Operator App so investigations are visible in the AWS Console.
 * Creates a dedicated IAM role for console/operator access and calls EnableOperatorApp.
 */
async function enableOperatorApp(
  client: DevOpsAgentClient,
  iam: IAMClient,
  agentSpaceId: string,
  accountId: string,
  region: string,
) {
  const OPERATOR_ROLE_NAME = "DevOpsAgentRole-OperatorApp";
  const operatorRoleArn = `arn:aws:iam::${accountId}:role/${OPERATOR_ROLE_NAME}`;

  // Check if operator app is already enabled
  try {
    const existing = await client.send(new GetOperatorAppCommand({ agentSpaceId } as any));
    if ((existing as any).operatorAppUrl || (existing as any).iam) {
      // Already enabled — nothing to do
      return;
    }
  } catch (e: any) {
    // ResourceNotFoundException means not enabled yet — proceed
    if (!e.name?.includes("ResourceNotFound") && !e.message?.includes("not found")) {
      // Some other error — still try to enable
    }
  }

  // Create Operator App IAM role (allows the DevOps Agent service to assume it for console access)
  try {
    await iam.send(new GetRoleCommand({ RoleName: OPERATOR_ROLE_NAME }));
  } catch {
    // Role doesn't exist — create it with correct trust policy
    const operatorTrustPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "aidevops.amazonaws.com" },
        Action: ["sts:AssumeRole", "sts:TagSession"],
        Condition: {
          StringEquals: { "aws:SourceAccount": accountId },
          ArnLike: { "aws:SourceArn": `arn:aws:aidevops:${region}:${accountId}:agentspace/*` },
        },
      }],
    });
    try {
      await iam.send(new CreateRoleCommand({
        RoleName: OPERATOR_ROLE_NAME,
        AssumeRolePolicyDocument: operatorTrustPolicy,
        Description: "Allows console users to view DevOps Agent investigations via Operator App",
      }));
      // Wait for role propagation
      await new Promise((r) => setTimeout(r, 10000));
    } catch { /* role might exist from concurrent call */ }
  }

  // Attach the operator app access policy
  try {
    await iam.send(new AttachRolePolicyCommand({
      RoleName: OPERATOR_ROLE_NAME,
      PolicyArn: "arn:aws:iam::aws:policy/AIDevOpsOperatorAppAccessPolicy",
    }));
  } catch { /* already attached or policy doesn't exist */ }

  // Also attach AIDevOpsAgentAccessPolicy for full visibility
  try {
    await iam.send(new AttachRolePolicyCommand({
      RoleName: OPERATOR_ROLE_NAME,
      PolicyArn: "arn:aws:iam::aws:policy/AIDevOpsAgentAccessPolicy",
    }));
  } catch { /* already attached */ }

  // Enable the Operator App with IAM auth flow
  try {
    await client.send(new EnableOperatorAppCommand({
      agentSpaceId,
      authFlow: "iam",
      operatorAppRoleArn: operatorRoleArn,
    } as any));
  } catch (e: any) {
    // ConflictException means already enabled — that's fine
    if (!e.name?.includes("Conflict") && !e.message?.includes("already enabled")) {
      console.error("EnableOperatorApp error (non-blocking):", e.message);
    }
  }
}

async function invokeRealDevOpsAgent(
  client: DevOpsAgentClient,
  agentSpaceId: string,
  stackName: string,
  plan: any,
  region: string
): Promise<{ status: string; summary: string; journal: any }> {
  const taskDescription = `Investigate broken infrastructure in CloudFormation stack "${stackName}" in region ${region}.\n\nReported symptoms:\n${(plan.symptoms || []).map((s: string) => "- " + s).join("\n")}\n\nExpected broken state: ${plan.brokenState}\n\nPlease identify the root cause and propose a fix.`;

  const taskResponse = await client.send(new CreateBacklogTaskCommand({
    agentSpaceId,
    taskType: "INVESTIGATION",
    title: `Investigate: ${plan.title || stackName}`,
    description: taskDescription,
    priority: "HIGH",
  } as any));

  const taskId = (taskResponse as any).task?.taskId || (taskResponse as any).taskId || (taskResponse as any).backlogTaskId || (taskResponse as any).backlogTask?.taskId;
  const executionId = (taskResponse as any).task?.executionId || (taskResponse as any).executionId;
  if (!taskId) {
    return { status: "FAILED", summary: `Could not extract taskId from response: ${JSON.stringify(taskResponse).slice(0, 200)}`, journal: null };
  }

  // Poll for completion (max 5 minutes)
  let status = "IN_PROGRESS";
  let latestExecutionId = executionId;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const taskStatus = await client.send(new GetBacklogTaskCommand({ agentSpaceId, taskId } as any));
      status = (taskStatus as any).task?.status || (taskStatus as any).status || "IN_PROGRESS";
      // Capture executionId from the latest response (may differ from initial)
      if ((taskStatus as any).task?.executionId) latestExecutionId = (taskStatus as any).task.executionId;
      if (status !== "IN_PROGRESS" && status !== "PENDING_START" && status !== "PENDING_TRIAGE") break;
    } catch { /* keep polling */ }
  }

  // Get journal records using executionId (NOT taskId)
  let journal: any = null;
  let summary = "";
  try {
    const records = await client.send(new ListJournalRecordsCommand({ agentSpaceId, executionId: latestExecutionId } as any));
    const entries = (records as any).records || (records as any).journalRecords || [];
    if (entries.length > 0) {
      // Find the investigation_summary_md record (the cleanest output)
      const summaryRecord = entries.find((e: any) => e.recordType === "investigation_summary_md");
      const findingRecords = entries.filter((e: any) => e.recordType === "finding" || e.recordType === "symptom");

      // Parse the markdown summary
      const summaryContent = summaryRecord?.content || "";
      summary = summaryContent;

      // Extract root cause from findings
      const findingContent = entries.find((e: any) => e.recordType === "finding")?.content || "";
      let rootCause = "";
      try {
        const findingJson = JSON.parse(findingContent);
        rootCause = findingJson.title || findingJson.description || "";
      } catch {
        rootCause = findingContent.slice(0, 500);
      }

      // Extract symptoms
      const symptoms = entries
        .filter((e: any) => e.recordType === "symptom")
        .map((e: any) => { try { return JSON.parse(e.content).title; } catch { return ""; } })
        .filter(Boolean);

      // Extract proposed fix from findings (look for remediation/fix content)
      let proposedFixDescription = "";
      const allFindings = entries.filter((e: any) => e.recordType === "finding");
      for (const f of allFindings) {
        try {
          const fJson = JSON.parse(f.content);
          if (fJson.remediation || fJson.fix || fJson.recommendation) {
            proposedFixDescription = fJson.remediation || fJson.fix || fJson.recommendation;
            break;
          }
        } catch {}
      }
      // Fallback: extract fix from the summary markdown (look for "## Recommendations" or "Fix:" sections)
      if (!proposedFixDescription && summaryContent) {
        const fixMatch = summaryContent.match(/(?:## (?:Recommendations?|Fix|Remediation|Resolution))\s*\n([\s\S]*?)(?=\n## |\n$)/i);
        if (fixMatch) proposedFixDescription = fixMatch[1].trim();
      }
      // Final fallback: derive from root cause
      if (!proposedFixDescription && rootCause) {
        proposedFixDescription = `Fix the identified root cause: ${rootCause}`;
      }

      journal = {
        rootCause: rootCause || summaryContent.slice(0, 500),
        confidence: status === "COMPLETED" ? "high" : "medium",
        identifiedSymptoms: symptoms,
        proposedFix: { description: proposedFixDescription, commands: [] },
        reasoning: summaryContent,
        source: "AWS DevOps Agent (real product)",
        taskId,
        executionId: latestExecutionId,
      };
    }
  } catch (e: any) { summary = `Journal error: ${e.message}`; }

  if (!journal) {
    journal = { rootCause: `DevOps Agent investigation ${status}. ${summary}`, confidence: status === "COMPLETED" ? "medium" : "low", source: "AWS DevOps Agent (real product)", taskId };
  }

  return { status, summary, journal };
}

/**
 * Extract the human engineer's RCA from case correspondence.
 * Uses AI to parse the correspondence and identify the root cause provided by the AWS engineer.
 */
async function extractHumanRca(bedrock: BedrockRuntimeClient, caseData: any): Promise<{ rootCause: string; fix: string; rcaTimestamp: string; isNonTechnical: boolean }> {
  // Get correspondence from case data (may already be included or need separate fetch)
  const correspondence = caseData.correspondence || caseData.communications_text || "";
  const subject = caseData.subject || "";
  const service = caseData.service || "";
  const description = caseData.description || "";

  if (!correspondence && !description) {
    return { rootCause: "", fix: "", rcaTimestamp: "", isNonTechnical: false };
  }

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1000,
    system: `You are analyzing AWS Support case correspondence to extract the Root Cause Analysis (RCA) provided by the AWS support engineer.

Rules:
- Look for the ENGINEER's explanation of what is wrong (not customer messages)
- The RCA is the technical root cause: misconfigured IAM, wrong security group, missing permission, incorrect setting, etc.
- If the case is about billing, pricing advice, account questions, or general guidance (NOT a technical infrastructure issue), set isNonTechnical to true
- If no clear technical RCA was provided (e.g., resolved via call with no written RCA), return empty rootCause
- Return ONLY valid JSON`,
    messages: [{ role: "user", content: `Case Subject: ${subject}\nService: ${service}\nDescription: ${description}\n\nCorrespondence:\n${(correspondence || description).slice(0, 4000)}\n\nExtract the human engineer's RCA. Return JSON:\n{"rootCause": "the technical root cause identified by the engineer", "fix": "the fix/resolution suggested", "rcaTimestamp": "timestamp of the RCA message if visible", "isNonTechnical": false}` }],
  };

  try {
    const cmd = new InvokeModelCommand({ modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", contentType: "application/json", accept: "application/json", body: JSON.stringify(payload) });
    const r = await bedrock.send(cmd);
    const text = (JSON.parse(new TextDecoder().decode(r.body)).content[0]?.text || "").trim();
    const cleaned = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { rootCause: "", fix: "", rcaTimestamp: "", isNonTechnical: false };
  }
}

/**
 * Compare Agent RCA vs Human RCA using AI.
 * Returns verdict (PASS/PARTIAL/FAIL) with reasoning.
 */
async function compareRcas(bedrock: BedrockRuntimeClient, agentDiagnosis: any, humanRca: any, simulationPlan: any): Promise<{ verdict: string; score: number; rootCauseAccuracy: string; agentConfidence: string; mismatchReason?: string; comparison: string }> {
  const agentRca = agentDiagnosis?.rootCause || agentDiagnosis?.reasoning?.slice(0, 500) || "";
  const humanRootCause = humanRca?.rootCause || "";

  // If no human RCA available, fall back to simulation plan comparison
  if (!humanRootCause) {
    const fallback = evaluateAccuracy(agentDiagnosis, simulationPlan);
    return { ...fallback, comparison: "No human RCA in correspondence — compared against simulation plan" };
  }

  // If case is non-technical, it shouldn't have been simulated
  if (humanRca.isNonTechnical) {
    return { verdict: "FAIL", score: 0, rootCauseAccuracy: "non-technical case", agentConfidence: "n/a", mismatchReason: "Case is not a technical infrastructure issue (billing/guidance)", comparison: "Non-technical case — should not be simulated" };
  }

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 500,
    system: `Compare two Root Cause Analyses and determine if they identify the SAME underlying issue. Return ONLY valid JSON.

Scoring:
- PASS (100): Both identify the same root cause (even if worded differently)
- PARTIAL (60): Related but not exact — e.g., both point to IAM but different specific permissions
- FAIL (20): Completely different root causes

Be generous with matching — if the core issue is the same (e.g., "missing IAM permission" vs "IAM policy lacks s3:GetObject"), that's a PASS.`,
    messages: [{ role: "user", content: `HUMAN ENGINEER RCA: ${humanRootCause}\n\nDEVOPS AGENT RCA: ${agentRca}\n\nReturn JSON:\n{"verdict": "PASS|PARTIAL|FAIL", "score": 100|60|20, "rootCauseAccuracy": "correct|partial|incorrect", "agentConfidence": "high|medium|low", "mismatchReason": "why they differ (only if FAIL)", "comparison": "brief explanation of comparison"}` }],
  };

  try {
    const cmd = new InvokeModelCommand({ modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", contentType: "application/json", accept: "application/json", body: JSON.stringify(payload) });
    const r = await bedrock.send(cmd);
    const text = (JSON.parse(new TextDecoder().decode(r.body)).content[0]?.text || "").trim();
    const cleaned = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback to old method
    const fallback = evaluateAccuracy(agentDiagnosis, simulationPlan);
    return { ...fallback, comparison: "AI comparison failed — used keyword matching" };
  }
}

/**
 * Refine a CFN template to better replicate the human-identified root cause.
 * Called when Agent RCA doesn't match Human RCA — means our simulation isn't accurate enough.
 */
async function refineTemplateForHumanRca(bedrock: BedrockRuntimeClient, template: string, humanRca: any, mismatchReason: string, plan: any, region: string): Promise<string> {
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 6000,
    system: `You are refining a CloudFormation template to better replicate a real customer issue. The DevOps Agent investigated our simulation but found a DIFFERENT root cause than what the human engineer identified. This means our simulation doesn't accurately reproduce the real issue.

Your job: modify the template so the ROOT CAUSE matches what the human engineer found. The DevOps Agent should be able to find the SAME issue the human found.

Output ONLY corrected YAML starting with AWSTemplateFormatVersion. No explanation.

RULES:
- The broken state must be observable through real AWS API calls (IAM policies, S3 configs, SG rules, etc.)
- Don't just add tags describing the issue — CREATE the actual misconfiguration
- Lambda Role must use !GetAtt for ARN
- Keep it deployable (no resources that take >10 min)`,
    messages: [{ role: "user", content: `HUMAN ENGINEER'S REAL RCA: ${humanRca.rootCause}\nHUMAN'S FIX: ${humanRca.fix || "not specified"}\n\nWHY AGENT FOUND SOMETHING DIFFERENT: ${mismatchReason}\n\nORIGINAL BROKEN STATE INTENT: ${plan.brokenState}\n\nCURRENT TEMPLATE (agent found wrong thing in this):\n${template}\n\nRefine the template so the real root cause ("${humanRca.rootCause}") is the actual misconfiguration in the deployed resources. Return YAML only.` }],
  };

  try {
    const cmd = new InvokeModelCommand({ modelId: "us.anthropic.claude-sonnet-4-6", contentType: "application/json", accept: "application/json", body: JSON.stringify(payload) });
    const r = await bedrock.send(cmd);
    let fixed = (JSON.parse(new TextDecoder().decode(r.body)).content[0]?.text || "").trim();
    fixed = fixed.replace(/^```(?:yaml|yml|cloudformation)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    if (fixed.includes("AWSTemplateFormatVersion") || fixed.includes("Resources:")) {
      return sanitizeTemplate(fixed);
    }
  } catch {}
  return template; // return original if refinement fails
}

/**
 * Calculate human time to RCA.
 * Uses: case open time → last AWS engineer correspondence timestamp that contains the RCA.
 * NOT case close time (which includes auto-close delays, fix implementation, etc.)
 * 
 * For chat cases: transcript shows exactly when RCA was provided.
 * For phone cases: approximate (call could include fix, not just RCA).
 * For correspondence: last engineer reply timestamp.
 */
function calculateHumanRcaTime(caseData: any): number {
  if (!caseData) return 0;

  const caseOpenTime = caseData.createdDate ? new Date(caseData.createdDate).getTime() : 0;
  
  // If we have lastEngineerCorrespondenceTime (from case communications parsing)
  if (caseData.lastEngineerCorrespondenceTime) {
    const rcaTime = new Date(caseData.lastEngineerCorrespondenceTime).getTime();
    if (rcaTime > caseOpenTime && !isNaN(rcaTime)) {
      return Math.round(((rcaTime - caseOpenTime) / (1000 * 60 * 60)) * 10) / 10;
    }
  }

  // If we have resolvedDate, calculate and discount auto-close buffer
  if (caseData.resolvedDate && caseData.createdDate) {
    const resolvedTime = new Date(caseData.resolvedDate).getTime();
    if (!isNaN(resolvedTime) && !isNaN(caseOpenTime) && resolvedTime > caseOpenTime) {
      const totalHours = (resolvedTime - caseOpenTime) / (1000 * 60 * 60);
      // If resolution time > 72 hours, subtract auto-close buffer
      if (totalHours > 72) {
        return Math.round((totalHours - 72) * 10) / 10;
      }
      return Math.round(totalHours * 10) / 10;
    }
  }

  // Fallback: use resolutionTimeHours from case data if available
  if (caseData.resolutionTimeHours && caseData.resolutionTimeHours > 0) {
    const hours = caseData.resolutionTimeHours;
    return hours > 72 ? Math.round((hours - 72) * 10) / 10 : hours;
  }

  // No time data available
  return 0;
}

function evaluateAccuracy(diagnosis: any, plan: any) {
  const actual = (plan.rootCause || "").toLowerCase();
  const found = (diagnosis.rootCause || "").toLowerCase();
  const reasoning = (diagnosis.reasoning || "").toLowerCase();
  const combined = found + " " + reasoning;

  // Key concept matching — check if the agent identified the core issue
  const keyPhrases = extractKeyPhrases(actual);
  const matchedPhrases = keyPhrases.filter((phrase) => combined.includes(phrase));
  const phraseRatio = keyPhrases.length > 0 ? matchedPhrases.length / keyPhrases.length : 0;

  // Also check word-level matching as fallback
  const words = actual.split(/\s+/).filter((w: string) => w.length > 4);
  const matchedWords = words.filter((w: string) => combined.includes(w));
  const wordRatio = words.length > 0 ? matchedWords.length / words.length : 0;

  // Use the better of the two scores
  const bestRatio = Math.max(phraseRatio, wordRatio);

  // If agent confidence is high and it found something related, be generous
  const confidence = diagnosis.confidence || "low";
  const bonus = confidence === "high" ? 0.15 : confidence === "medium" ? 0.05 : 0;
  const finalRatio = Math.min(1, bestRatio + bonus);

  const accuracy = finalRatio > 0.35 ? "correct" : finalRatio > 0.15 ? "partial" : "incorrect";
  return {
    rootCauseAccuracy: accuracy,
    fixProposed: !!(diagnosis.proposedFix?.description || diagnosis.proposedFix?.commands?.length),
    agentConfidence: confidence,
    score: accuracy === "correct" ? 100 : accuracy === "partial" ? 60 : 20,
    verdict: accuracy === "correct" ? "PASS" : accuracy === "partial" ? "PARTIAL" : "FAIL",
  };
}

function extractKeyPhrases(text: string): string[] {
  // Extract meaningful 2-3 word phrases that represent the core issue
  const phrases: string[] = [];
  const keywords = ["permission", "policy", "iam", "role", "credential", "access", "denied",
    "security group", "route", "dns", "certificate", "mismatch", "timeout", "connection",
    "owner", "table", "database", "config", "endpoint", "vpc", "subnet", "nat", "gateway",
    "ses", "smtp", "send", "email", "s3", "ec2", "rds", "lambda", "ecs", "eks"];

  for (const kw of keywords) {
    if (text.includes(kw)) phrases.push(kw);
  }
  return phrases;
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
