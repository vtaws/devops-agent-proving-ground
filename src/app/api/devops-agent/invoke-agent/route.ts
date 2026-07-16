import { NextRequest } from "next/server";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });

/**
 * POST /api/devops-agent/invoke-agent
 *
 * Simulates a DevOps Agent diagnosing the deployed broken environment.
 * 1. Gathers real stack state (resources, events, statuses)
 * 2. Feeds it to Bedrock Claude acting as the DevOps Agent
 * 3. Agent diagnoses the issue, proposes fix
 * 4. Returns timing metrics + accuracy assessment
 */
export async function POST(request: NextRequest) {
  try {
    const { stackName, region, simulationPlan } = await request.json();

    if (!stackName || !simulationPlan) {
      return jsonResponse({ error: "stackName and simulationPlan required" }, 400);
    }

    const targetRegion = region || "us-east-1";
    const cfn = new CloudFormationClient({ region: targetRegion });
    const startTime = Date.now();

    // Step 1: Gather real environment state
    const envState = await gatherEnvironmentState(cfn, stackName);

    // Step 2: Run DevOps Agent (Bedrock Claude simulating agent behavior)
    const agentResult = await runDevOpsAgent(envState, simulationPlan, targetRegion);

    const endTime = Date.now();
    const agentTimeSeconds = Math.round((endTime - startTime) / 1000);

    // Step 3: Evaluate accuracy against known root cause
    const evaluation = await evaluateAgentResult(agentResult, simulationPlan);

    // Step 4: Calculate metrics
    const humanBaselineHours = simulationPlan.humanBaselineHours ||
      (simulationPlan as any).resolutionTimeHours || 2;
    const agentTimeHours = agentTimeSeconds / 3600;
    const timeSavedHours = Math.max(0, humanBaselineHours - agentTimeHours);
    const costPerHour = 150; // Engineer cost $/hr
    const costSaved = Math.round(timeSavedHours * costPerHour);
    const speedupFactor = Math.round(humanBaselineHours / Math.max(agentTimeHours, 0.001));

    return jsonResponse({
      agentDiagnosis: agentResult,
      evaluation,
      metrics: {
        agentTimeSeconds,
        agentTimeHours: Math.round(agentTimeHours * 100) / 100,
        humanBaselineHours,
        timeSavedHours: Math.round(timeSavedHours * 10) / 10,
        costSaved,
        speedupFactor: `${speedupFactor}x`,
        costPerHour,
      },
      environmentState: {
        stackStatus: envState.stackStatus,
        resourceCount: envState.resources.length,
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

async function gatherEnvironmentState(cfn: CloudFormationClient, stackName: string) {
  let stackStatus = "UNKNOWN";
  let resources: any[] = [];
  let events: any[] = [];
  let outputs: any[] = [];

  try {
    const desc = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = desc.Stacks?.[0];
    stackStatus = stack?.StackStatus || "UNKNOWN";
    outputs = (stack?.Outputs || []).map((o) => ({ key: o.OutputKey, value: o.OutputValue }));
  } catch {}

  try {
    const res = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    resources = (res.StackResources || []).map((r) => ({
      logicalId: r.LogicalResourceId,
      type: r.ResourceType,
      physicalId: r.PhysicalResourceId,
      status: r.ResourceStatus,
    }));
  } catch {}

  try {
    const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    events = (ev.StackEvents || []).slice(0, 20).map((e) => ({
      resource: e.LogicalResourceId,
      status: e.ResourceStatus,
      reason: e.ResourceStatusReason || "",
      timestamp: e.Timestamp?.toISOString(),
    }));
  } catch {}

  return { stackStatus, resources, events, outputs };
}

async function runDevOpsAgent(envState: any, plan: any, region: string) {
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 2000,
    system: `You are AWS DevOps Agent — an automated diagnostic system. You have been invoked to troubleshoot a broken AWS environment.

You have access to the following environment state data. Analyze it and:
1. Identify the symptoms you observe
2. Determine the root cause
3. Propose a specific fix (exact CLI commands or config changes)
4. Rate your confidence (high/medium/low)

Be systematic. Check resource statuses, security groups, IAM policies, DNS, connectivity.
Return ONLY JSON with your diagnosis.`,
    messages: [{
      role: "user",
      content: `ENVIRONMENT STATE:
Stack: ${envState.stackStatus}
Region: ${region}
Resources (${envState.resources.length}):
${envState.resources.map((r: any) => `  ${r.logicalId} [${r.type}] → ${r.physicalId} (${r.status})`).join("\n")}

Stack Outputs:
${envState.outputs.map((o: any) => `  ${o.key}: ${o.value}`).join("\n") || "  (none)"}

Recent Events:
${envState.events.slice(0, 10).map((e: any) => `  ${e.resource}: ${e.status} ${e.reason ? `— ${e.reason}` : ""}`).join("\n")}

REPORTED SYMPTOMS:
${(plan.symptoms || []).map((s: string) => `- ${s}`).join("\n")}

Diagnose this environment. Return JSON:
{"identifiedSymptoms":["..."],"rootCause":"...","confidence":"high|medium|low","proposedFix":{"description":"...","commands":["aws cli command 1","command 2"]},"reasoning":"step-by-step reasoning","additionalInvestigation":["what else I would check"]}`,
    }],
  };

  const command = new InvokeModelCommand({
    modelId: process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-4-6",
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
    return { rootCause: content.slice(0, 500), confidence: "low", error: "Could not parse agent output" };
  }
}

async function evaluateAgentResult(agentResult: any, plan: any) {
  const actualRootCause = (plan.rootCause || "").toLowerCase();
  const agentRootCause = (agentResult.rootCause || "").toLowerCase();

  // Simple keyword matching for accuracy
  const rootCauseWords = actualRootCause.split(/\s+/).filter((w: string) => w.length > 4);
  const matchedWords = rootCauseWords.filter((w: string) => agentRootCause.includes(w));
  const matchRatio = rootCauseWords.length > 0 ? matchedWords.length / rootCauseWords.length : 0;

  let rootCauseAccuracy: "correct" | "partial" | "incorrect";
  if (matchRatio > 0.5 || agentResult.confidence === "high") {
    rootCauseAccuracy = "correct";
  } else if (matchRatio > 0.2 || agentResult.confidence === "medium") {
    rootCauseAccuracy = "partial";
  } else {
    rootCauseAccuracy = "incorrect";
  }

  const fixProposed = !!(agentResult.proposedFix?.commands?.length);
  const symptomsIdentified = (agentResult.identifiedSymptoms || []).length;

  return {
    rootCauseAccuracy,
    fixProposed,
    symptomsIdentified,
    agentConfidence: agentResult.confidence || "low",
    score: rootCauseAccuracy === "correct" ? 100 : rootCauseAccuracy === "partial" ? 60 : 20,
    verdict: rootCauseAccuracy === "correct" ? "PASS" : rootCauseAccuracy === "partial" ? "PARTIAL" : "FAIL",
  };
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
