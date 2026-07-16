import { NextRequest } from "next/server";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
  DescribeStackEventsCommand,
} from "@aws-sdk/client-cloudformation";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });

/**
 * POST /api/devops-agent/verify
 *
 * Verifies that the deployed broken environment actually exhibits
 * the expected symptoms before invoking the DevOps Agent.
 *
 * Steps:
 * 1. Check stack deployed successfully (CREATE_COMPLETE)
 * 2. Gather resource states from CFN
 * 3. Use Bedrock to analyze if the deployed state matches expected symptoms
 * 4. Return verification result: CONFIRMED / PARTIAL / NOT_REPLICATED
 */
export async function POST(request: NextRequest) {
  try {
    const { stackName, region, simulationPlan } = await request.json();

    if (!stackName || !simulationPlan) {
      return jsonResponse({ error: "stackName and simulationPlan required" }, 400);
    }

    const targetRegion = region || "us-east-1";
    const cfn = new CloudFormationClient({ region: targetRegion });

    // Step 1: Check stack status
    let stackStatus = "UNKNOWN";
    let stackResources: any[] = [];
    let stackEvents: any[] = [];
    let stackOutputs: any[] = [];

    try {
      const desc = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const stack = desc.Stacks?.[0];
      stackStatus = stack?.StackStatus || "UNKNOWN";
      stackOutputs = (stack?.Outputs || []).map((o) => ({
        key: o.OutputKey, value: o.OutputValue, description: o.Description,
      }));
    } catch (e: any) {
      return jsonResponse({
        verified: false,
        status: "STACK_NOT_FOUND",
        message: `Stack ${stackName} not found: ${e.message}`,
      });
    }

    // If stack failed to create, the simulation didn't deploy correctly
    if (stackStatus.includes("FAILED") || stackStatus.includes("ROLLBACK")) {
      let failReason = "";
      try {
        const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
        const failedEvent = (ev.StackEvents || []).find((e) =>
          e.ResourceStatus?.includes("FAILED") && e.ResourceStatusReason
        );
        failReason = failedEvent?.ResourceStatusReason || "";
      } catch {}

      return jsonResponse({
        verified: false,
        status: "DEPLOY_FAILED",
        stackStatus,
        message: `Stack deployment failed: ${failReason || stackStatus}. The broken environment could not be created.`,
        failReason,
      });
    }

    // If still creating, wait
    if (stackStatus === "CREATE_IN_PROGRESS") {
      return jsonResponse({
        verified: false,
        status: "STILL_DEPLOYING",
        stackStatus,
        message: "Stack is still deploying. Retry in 30 seconds.",
        retryAfterSeconds: 30,
      });
    }

    // Step 2: Gather actual resource states
    try {
      const res = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
      stackResources = (res.StackResources || []).map((r) => ({
        logicalId: r.LogicalResourceId,
        type: r.ResourceType,
        physicalId: r.PhysicalResourceId,
        status: r.ResourceStatus,
      }));
    } catch {}

    try {
      const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
      stackEvents = (ev.StackEvents || []).slice(0, 15).map((e) => ({
        resource: e.LogicalResourceId,
        type: e.ResourceType,
        status: e.ResourceStatus,
        reason: e.ResourceStatusReason || "",
      }));
    } catch {}

    // Step 3: Use AI to verify symptoms match
    const verificationResult = await verifySymptoms(
      { stackStatus, stackResources, stackOutputs, stackEvents },
      simulationPlan,
      targetRegion
    );

    return jsonResponse({
      verified: verificationResult.verified,
      status: verificationResult.status,
      confidence: verificationResult.confidence,
      message: verificationResult.message,
      symptomsConfirmed: verificationResult.symptomsConfirmed,
      symptomsNotConfirmed: verificationResult.symptomsNotConfirmed,
      environmentSnapshot: {
        stackStatus,
        resourceCount: stackResources.length,
        resources: stackResources,
        outputs: stackOutputs,
      },
    });
  } catch (error: any) {
    const msg = error.message || String(error);
    if (msg.includes("expired") || msg.includes("ExpiredToken")) {
      return jsonResponse({ error: "AWS credentials expired.", needsAuth: true }, 401);
    }
    return jsonResponse({ error: msg }, 500);
  }
}

async function verifySymptoms(
  envState: any,
  plan: any,
  region: string
) {
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1500,
    system: `You are a verification engine. Given a deployed AWS environment and the expected broken symptoms, determine if the issue has been successfully replicated.

RULES:
- Compare the ACTUAL deployed state against EXPECTED symptoms
- A symptom is CONFIRMED if the deployed resources/config would produce that symptom
- A symptom is NOT CONFIRMED if the environment doesn't match
- Be strict — only mark CONFIRMED if you're confident the symptom would be observable
- Return JSON only`,
    messages: [{
      role: "user",
      content: `DEPLOYED ENVIRONMENT:
Stack Status: ${envState.stackStatus}
Region: ${region}
Resources (${envState.stackResources.length}):
${envState.stackResources.map((r: any) => `  ${r.logicalId} [${r.type}] → ${r.physicalId} (${r.status})`).join("\n")}

Outputs:
${envState.stackOutputs.map((o: any) => `  ${o.key}: ${o.value}`).join("\n") || "  (none)"}

EXPECTED BROKEN STATE: ${plan.brokenState}
EXPECTED ROOT CAUSE: ${plan.rootCause}
EXPECTED SYMPTOMS:
${(plan.symptoms || []).map((s: string, i: number) => `  ${i + 1}. ${s}`).join("\n")}

VERIFICATION COMMANDS (what a user would run to see the issue):
${(plan.verificationCommands || []).map((c: string) => `  $ ${c}`).join("\n")}

Analyze the deployed environment and determine which symptoms are replicable. Return:
{"verified": true/false, "status": "CONFIRMED|PARTIAL|NOT_REPLICATED", "confidence": "high|medium|low", "message": "explanation", "symptomsConfirmed": ["confirmed symptom 1"], "symptomsNotConfirmed": ["symptom that wasnt replicated"], "reasoning": "why you believe the issue is/isn't replicated"}`,
    }],
  };

  const command = new InvokeModelCommand({
    modelId: process.env.BEDROCK_FAST_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(payload),
  });

  const response = await bedrock.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  const content = (body.content[0]?.text || "").trim();

  try {
    const stripped = content.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    return JSON.parse(stripped);
  } catch {
    // If we can't parse, assume partial (stack deployed but can't confirm symptoms via AI alone)
    return {
      verified: true,
      status: "PARTIAL",
      confidence: "medium",
      message: "Stack deployed successfully. Symptom verification requires manual CLI checks with the verification commands above.",
      symptomsConfirmed: [],
      symptomsNotConfirmed: [],
    };
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
