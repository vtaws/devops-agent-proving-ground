import { NextRequest } from "next/server";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
});

/**
 * POST /api/devops-agent/simulate
 *
 * Given a support case, generates:
 * 1. A simulation plan (what broken environment to create)
 * 2. CloudFormation/Terraform IaC to deploy the broken state
 * 3. Symptoms the agent should detect
 * 4. Expected root cause and fix
 * 5. Evaluation criteria
 */
export async function POST(request: NextRequest) {
  try {
    const { caseData, mode = "plan" } = await request.json();

    if (!caseData || !caseData.subject) {
      return jsonResponse({ error: "Case data with subject required" }, 400);
    }

    if (mode === "plan") {
      return await generateSimulationPlan(caseData);
    } else if (mode === "evaluate") {
      return await evaluateAgentResult(caseData);
    }

    return jsonResponse({ error: `Unknown mode: ${mode}` }, 400);
  } catch (error: any) {
    console.error("Simulation error:", error);
    const msg = error.message || String(error);
    if (msg.includes("expired") || msg.includes("ExpiredToken")) {
      return jsonResponse({ error: "AWS credentials expired. Please refresh credentials (the modal should appear on page reload)." }, 401);
    }
    return jsonResponse({ error: msg }, 500);
  }
}

async function generateSimulationPlan(caseData: any) {
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 4000,
    system: `You are an AWS infrastructure engineer creating broken environment simulations for testing DevOps Agent capabilities.

Given a support case, generate a plan to reproduce the broken state in a sandbox AWS account.

IMPORTANT OUTPUT RULES:
- Return ONLY valid JSON, nothing else — no markdown, no code fences, no explanation text
- Do NOT embed a full CloudFormation template in the JSON — just describe what it would create
- Keep the response under 3000 characters total
- All string values must be properly escaped (no literal newlines inside strings)`,
    messages: [{
      role: "user",
      content: `Generate a simulation plan for this support case:

Case: "${caseData.subject}"
Service: ${caseData.service || "Unknown"}
Category: ${caseData.category || "Technical support"}
Severity: ${caseData.severity || "normal"}
Resolution Time: ${caseData.resolutionTimeHours || "unknown"}h
Additional: ${caseData.description || caseData.reasoning || "None"}

Return this exact JSON structure:
{"simulationPlan":{"title":"short title","description":"what broken state we create","targetService":"primary AWS service","brokenState":"what is wrong","rootCause":"actual root cause","symptoms":["symptom 1","symptom 2"],"verificationCommands":["aws cli command to observe symptom"],"fixSteps":["step 1","step 2"],"difficulty":"easy|medium|hard","estimatedDeployTime":"5 minutes","prerequisites":["what needs to exist"]},"iac":{"type":"cloudformation","description":"Brief description of what the CFN template would create","resources":["AWS::EC2::Instance","AWS::IAM::Role"],"deployCommand":"aws cloudformation deploy --template-file sim.yaml --stack-name sim-test --capabilities CAPABILITY_NAMED_IAM"},"evaluation":{"successCriteria":["agent identifies root cause","agent suggests correct fix"],"partialCriteria":["agent finds symptoms but not root cause"],"failureCriteria":["agent cannot diagnose within time limit"],"maxTimeSeconds":120,"humanBaselineHours":${caseData.resolutionTimeHours || 2}}}`,
    }],
  };

  const command = new InvokeModelCommand({
    modelId: process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-4-6",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(payload),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const content = (responseBody.content[0]?.text || "").trim();

  let plan: any = null;

  // Method 1: Try parsing the entire response as JSON directly
  try {
    plan = JSON.parse(content);
  } catch { /* not pure JSON */ }

  // Method 2: Strip markdown code fences and try again
  if (!plan) {
    const stripped = content.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    try {
      plan = JSON.parse(stripped);
    } catch { /* continue */ }
  }

  // Method 3: Find JSON object starting with {"simulationPlan"
  if (!plan) {
    const startIdx = content.indexOf('{"simulationPlan"');
    if (startIdx !== -1) {
      const substr = content.slice(startIdx);
      // Find matching closing brace by counting
      let depth = 0;
      let endIdx = -1;
      for (let i = 0; i < substr.length; i++) {
        if (substr[i] === "{") depth++;
        else if (substr[i] === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
      }
      if (endIdx > 0) {
        try { plan = JSON.parse(substr.slice(0, endIdx + 1)); } catch { /* give up */ }
      }
    }
  }

  if (!plan || !plan.simulationPlan) {
    return jsonResponse({
      plan: null,
      error: "Failed to generate simulation plan. The AI response could not be parsed.",
      raw: content.slice(0, 300),
      caseId: caseData.caseId,
    });
  }

  return jsonResponse({
    plan,
    caseId: caseData.caseId || "manual-entry",
    generatedAt: new Date().toISOString(),
  });
}

async function evaluateAgentResult(caseData: any) {
  // Placeholder for Phase 2: actually invoke the DevOps Agent and evaluate
  return jsonResponse({
    message: "Evaluation mode — Phase 2 (requires AgentCore integration)",
    caseId: caseData.caseId,
  });
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
