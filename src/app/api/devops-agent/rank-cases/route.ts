import { NextRequest } from "next/server";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

/**
 * POST /api/devops-agent/rank-cases
 *
 * Uses Bedrock to rank support cases by:
 * 1. Reproducibility (has enough info to recreate the environment)
 * 2. Resolution time (longer = more value to save)
 * 3. Repeat frequency (repeated cases = higher ROI)
 * 4. DevOps Agent likelihood of success (config/permissions > performance/timing)
 * 5. Ease of environment creation (IaC-friendly)
 */
export async function POST(request: NextRequest) {
  try {
    const { cases, credentials } = await request.json();

    if (!cases || cases.length === 0) {
      return new Response(JSON.stringify({ rankedCases: [] }), { status: 200 });
    }

    // Use user's credentials if provided, else fall back to ambient env
    const client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
      ...(credentials?.accessKeyId ? {
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        },
      } : {}),
    });

    // Filter out trivial cases (account support, limit increases resolved in < 1 min)
    const technicalCases = cases.filter((c: any) => {
      const isTrivial =
        c.resolutionTimeHours < 0.1 ||
        c.category === "Account and billing support" ||
        c.category === "Service limit increase";
      return !isTrivial;
    });

    // If all cases are trivial, still rank the original list
    const casesToRank = technicalCases.length > 0 ? technicalCases.slice(0, 20) : cases.slice(0, 10);

    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4000,
      system: `You rank AWS support cases for DevOps Agent simulation testing. Score each case 0-100 based on:
- Reproducibility: Can we recreate this broken environment with IaC? (config issues = high, timing/load issues = low)
- Resolution time: Longer = more value to demonstrate
- Repeat frequency: Look for similar subjects (repeated patterns = higher value)
- Agent success likelihood: HIGH for config/permissions/connectivity issues, MEDIUM for service issues, LOW for performance/timing
- Info completeness: Does the subject describe the problem clearly enough?

IMPORTANT: Use the EXACT index numbers provided. Return ONLY valid JSON array with no extra text.`,
      messages: [{
        role: "user",
        content: `Rank these ${casesToRank.length} support cases for DevOps Agent testing. For each, provide a score and reasoning.

Cases:
${casesToRank.map((c: any, idx: number) => `[${idx}] caseId="${c.caseId}" service="${c.service}" subject="${c.subject}" resolution=${c.resolutionTimeHours}h severity=${c.severity} category="${c.category}" account="${c.accountName || ""}"`).join("\n")}

Return JSON array (top 15, sorted by score desc). Use the EXACT caseId string from above:
[{"index": 0, "caseId": "exact_case_id_string", "score": 0-100, "reasoning": "why", "reproducible": true/false, "repeatCount": number, "estimatedAgentSuccess": "high|medium|low", "estimatedTimeSaved": hours, "estimatedCostSaved": dollars}]`,
      }],
    };

    const command = new InvokeModelCommand({
      modelId: process.env.BEDROCK_FAST_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const content = responseBody.content[0]?.text || "[]";

    let ranked: any[] = [];
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) ranked = JSON.parse(jsonMatch[0]);
    } catch {
      ranked = [];
    }

    // Merge AI ranking back with original case data using BOTH caseId match and index fallback
    const rankedCases = ranked.map((r: any) => {
      // Try exact caseId match first
      let originalCase = casesToRank.find((c: any) => c.caseId === r.caseId);

      // Fallback to index if caseId doesn't match
      if (!originalCase && r.index !== undefined && r.index < casesToRank.length) {
        originalCase = casesToRank[r.index];
      }

      // Last resort: skip this entry if we can't find the case
      if (!originalCase) return null;

      return {
        ...originalCase,
        score: r.score || 50,
        reasoning: r.reasoning || "Ranked by AI",
        reproducible: r.reproducible !== false,
        repeatCount: r.repeatCount || 1,
        estimatedAgentSuccess: r.estimatedAgentSuccess || "medium",
        estimatedTimeSaved: r.estimatedTimeSaved || originalCase.resolutionTimeHours || 2,
        estimatedCostSaved: r.estimatedCostSaved || Math.round((originalCase.resolutionTimeHours || 2) * 150),
      };
    }).filter(Boolean);

    return new Response(
      JSON.stringify({ rankedCases }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Case ranking error:", error);
    return new Response(
      JSON.stringify({ error: error.message, rankedCases: [] }),
      { status: 500 }
    );
  }
}
