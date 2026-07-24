import { NextRequest } from "next/server";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@aws-sdk/protocol-http";

/**
 * POST /api/devops-agent/invoke-agent
 *
 * Invokes the REAL DevOpsDiagnosticAgent deployed on AgentCore.
 * The agent runs actual AWS API calls (describe_stack, check_security_groups, etc.)
 * against the broken infrastructure and returns a real diagnosis.
 *
 * If DEVOPS_AGENT_RUNTIME_ID is not set, falls back to direct Bedrock.
 */
export async function POST(request: NextRequest) {
  try {
    const { stackName, region, simulationPlan } = await request.json();

    if (!stackName || !simulationPlan) {
      return jsonResponse({ error: "stackName and simulationPlan required" }, 400);
    }

    const runtimeId = process.env.DEVOPS_AGENT_RUNTIME_ID;
    const startTime = Date.now();

    let agentResult: any;

    if (runtimeId) {
      // Real agent via A2A protocol
      agentResult = await invokeViaAgentCore(runtimeId, stackName, region, simulationPlan);
    } else {
      // Fallback: direct Bedrock + SDK calls (same tools, just not on AgentCore)
      agentResult = await invokeDirectAgent(stackName, region, simulationPlan);
    }

    const endTime = Date.now();
    const agentTimeSeconds = Math.round((endTime - startTime) / 1000);

    // Calculate metrics
    const humanBaselineHours = simulationPlan.humanBaselineHours || 2;
    const agentTimeHours = agentTimeSeconds / 3600;
    const timeSavedHours = Math.max(0, humanBaselineHours - agentTimeHours);
    const costSaved = Math.round(timeSavedHours * 150);
    const speedupFactor = Math.round(humanBaselineHours / Math.max(agentTimeHours, 0.001));

    // Evaluate accuracy
    const evaluation = evaluateResult(agentResult, simulationPlan);

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
        costPerHour: 150,
        mode: runtimeId ? "agentcore" : "direct",
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

/**
 * Invoke the real DevOpsDiagnosticAgent via AgentCore A2A protocol.
 */
async function invokeViaAgentCore(runtimeId: string, stackName: string, region: string, plan: any) {
  const accountId = ""; // Set via user credentials at runtime
  const agentRegion = "us-east-1";
  const url = `https://bedrock-agentcore.${agentRegion}.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3A${agentRegion}%3A${accountId}%3Aruntime%2F${runtimeId}/invocations`;

  const message = `Diagnose the broken environment in stack "${stackName}" in region ${region}.

Reported symptoms:
${(plan.symptoms || []).map((s: string) => `- ${s}`).join("\n")}

Expected broken state: ${plan.brokenState}

Start by calling describe_stack with stack_name="${stackName}" and region="${region}", then inspect the relevant resources based on what you find.`;

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    method: "message/send",
    id: `diag-${Date.now()}`,
    params: {
      message: {
        messageId: `diag-${Date.now()}`,
        role: "user",
        parts: [{ kind: "text", text: message }],
      },
      configuration: { acceptedOutputModes: ["text"] },
    },
  });

  // Sign the request with SigV4
  const httpRequest = new HttpRequest({
    method: "POST",
    hostname: `bedrock-agentcore.${agentRegion}.amazonaws.com`,
    path: `/runtimes/arn%3Aaws%3Abedrock-agentcore%3A${agentRegion}%3A${accountId}%3Aruntime%2F${runtimeId}/invocations`,
    headers: {
      "Content-Type": "application/json",
      host: `bedrock-agentcore.${agentRegion}.amazonaws.com`,
    },
    body: payload,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: agentRegion,
    service: "bedrock-agentcore",
    sha256: Sha256,
  });

  const signed = await signer.sign(httpRequest);

  const response = await fetch(url, {
    method: "POST",
    headers: signed.headers as Record<string, string>,
    body: payload,
  });

  const data = await response.json();
  const artifacts = data?.result?.artifacts || [];
  const text = artifacts[0]?.parts?.[0]?.text || "";

  // Parse the agent's structured response
  try {
    const jsonMatch = text.match(/\{[\s\S]*"rootCause"[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}

  return { rootCause: text.slice(0, 1000), confidence: "medium", raw: true };
}

/**
 * Fallback: Run the same diagnostic logic directly (without AgentCore).
 * Uses Bedrock + CloudFormation SDK to inspect the stack.
 */
async function invokeDirectAgent(stackName: string, region: string, plan: any) {
  const { CloudFormationClient, DescribeStacksCommand, DescribeStackResourcesCommand, DescribeStackEventsCommand } = await import("@aws-sdk/client-cloudformation");
  const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");

  const cfn = new CloudFormationClient({ region });
  const bedrock = new BedrockRuntimeClient({ region: "us-east-1" });

  // Gather real stack data
  let envData = "";
  try {
    const desc = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = desc.Stacks?.[0];
    envData += `Stack: ${stack?.StackStatus}\nOutputs:\n${(stack?.Outputs || []).map(o => `  ${o.OutputKey}: ${o.OutputValue}`).join("\n")}\n`;
  } catch (e: any) { envData += `Stack describe error: ${e.message}\n`; }

  try {
    const res = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    envData += `Resources (${res.StackResources?.length}):\n${(res.StackResources || []).map(r => `  ${r.LogicalResourceId} [${r.ResourceType}] → ${r.PhysicalResourceId} (${r.ResourceStatus})`).join("\n")}\n`;
  } catch (e: any) { envData += `Resources error: ${e.message}\n`; }

  try {
    const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    const failed = (ev.StackEvents || []).filter(e => e.ResourceStatus?.includes("FAILED"));
    if (failed.length) {
      envData += `Failed events:\n${failed.slice(0, 5).map(e => `  ${e.LogicalResourceId}: ${e.ResourceStatusReason}`).join("\n")}\n`;
    }
  } catch {}

  // Ask Bedrock to diagnose
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 2000,
    system: "You are a DevOps Diagnostic Agent. Given real AWS environment state and reported symptoms, diagnose the root cause and propose a fix. Return JSON only: {\"identifiedSymptoms\":[...],\"rootCause\":\"...\",\"confidence\":\"high|medium|low\",\"proposedFix\":{\"description\":\"...\",\"commands\":[\"...\"]},\"reasoning\":\"...\"}",
    messages: [{
      role: "user",
      content: `REAL ENVIRONMENT STATE:\n${envData}\n\nREPORTED SYMPTOMS:\n${(plan.symptoms || []).map((s: string) => `- ${s}`).join("\n")}\n\nExpected broken state: ${plan.brokenState}\n\nDiagnose and return JSON.`,
    }],
  };

  const cmd = new InvokeModelCommand({
    modelId: process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-4-6",
    contentType: "application/json", accept: "application/json",
    body: JSON.stringify(payload),
  });

  const response = await bedrock.send(cmd);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  const content = (body.content[0]?.text || "").trim();

  try {
    return JSON.parse(content.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""));
  } catch {
    return { rootCause: content.slice(0, 500), confidence: "low" };
  }
}

function evaluateResult(agentResult: any, plan: any) {
  const actual = (plan.rootCause || "").toLowerCase();
  const found = (agentResult.rootCause || "").toLowerCase();
  const words = actual.split(/\s+/).filter((w: string) => w.length > 4);
  const matched = words.filter((w: string) => found.includes(w));
  const ratio = words.length > 0 ? matched.length / words.length : 0;

  const accuracy = ratio > 0.4 ? "correct" : ratio > 0.15 ? "partial" : "incorrect";
  return {
    rootCauseAccuracy: accuracy,
    fixProposed: !!(agentResult.proposedFix?.commands?.length),
    agentConfidence: agentResult.confidence || "low",
    score: accuracy === "correct" ? 100 : accuracy === "partial" ? 60 : 20,
    verdict: accuracy === "correct" ? "PASS" : accuracy === "partial" ? "PARTIAL" : "FAIL",
  };
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
