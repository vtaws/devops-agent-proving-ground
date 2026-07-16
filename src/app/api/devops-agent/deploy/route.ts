import { NextRequest } from "next/server";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  DeleteStackCommand,
} from "@aws-sdk/client-cloudformation";

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });

/**
 * POST /api/devops-agent/deploy
 *
 * Generates a deployable CFN template from the simulation plan and deploys it.
 * Steps:
 * 1. Take the simulation plan (broken state description)
 * 2. Generate a MINIMAL CloudFormation template that creates the broken environment
 * 3. Deploy it to the user's Isengard account
 * 4. Return stack status + console URL
 */
export async function POST(request: NextRequest) {
  try {
    const { simulationPlan, action, stackName: existingStack, region } = await request.json();

    const targetRegion = region || process.env.AWS_REGION || "us-east-1";
    const cfn = new CloudFormationClient({ region: targetRegion });

    // Action: delete (cleanup)
    if (action === "delete" && existingStack) {
      await cfn.send(new DeleteStackCommand({ StackName: existingStack }));
      return jsonResponse({ status: "DELETE_IN_PROGRESS", stackName: existingStack });
    }

    // Action: status check
    if (action === "status" && existingStack) {
      const desc = await cfn.send(new DescribeStacksCommand({ StackName: existingStack }));
      const stack = desc.Stacks?.[0];
      return jsonResponse({
        status: stack?.StackStatus || "UNKNOWN",
        outputs: stack?.Outputs?.map((o) => ({ key: o.OutputKey, value: o.OutputValue })),
      });
    }

    // Default: generate template and deploy
    if (!simulationPlan) {
      return jsonResponse({ error: "simulationPlan required" }, 400);
    }

    // Step 1: Generate minimal CFN template from the plan
    const template = await generateDeployableTemplate(simulationPlan, targetRegion);
    if (!template) {
      return jsonResponse({ error: "Failed to generate deployable template" }, 500);
    }

    // Step 2: Deploy
    const stackName = `devops-sim-${Date.now().toString(36)}`;
    try {
      await cfn.send(new CreateStackCommand({
        StackName: stackName,
        TemplateBody: template,
        Capabilities: ["CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
        Tags: [
          { Key: "Purpose", Value: "DevOpsAgentSimulation" },
          { Key: "AutoDelete", Value: "true" },
          { Key: "ManagedBy", Value: "DevOpsProvingGround" },
        ],
        TimeoutInMinutes: 15,
      }));

      const desc = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const stack = desc.Stacks?.[0];

      return jsonResponse({
        status: stack?.StackStatus || "CREATE_IN_PROGRESS",
        stackName,
        stackId: stack?.StackId,
        template,
        region: targetRegion,
        consoleUrl: `https://${targetRegion}.console.aws.amazon.com/cloudformation/home?region=${targetRegion}#/stacks/stackinfo?stackId=${encodeURIComponent(stack?.StackId || "")}`,
      });
    } catch (deployErr: any) {
      return jsonResponse({
        error: deployErr.message,
        template,
        stackName,
        hint: deployErr.message.includes("AlreadyExists")
          ? "Stack exists. Delete it first or wait for cleanup."
          : undefined,
      }, 400);
    }
  } catch (error: any) {
    const msg = error.message || String(error);
    if (msg.includes("expired") || msg.includes("ExpiredToken")) {
      return jsonResponse({ error: "AWS credentials expired. Please refresh.", needsAuth: true }, 401);
    }
    return jsonResponse({ error: msg }, 500);
  }
}

async function generateDeployableTemplate(plan: any, region: string): Promise<string | null> {
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 6000,
    system: `You generate MINIMAL, DEPLOYABLE AWS CloudFormation YAML templates that create broken infrastructure for DevOps Agent testing.

CRITICAL RULES:
- Output ONLY the YAML template. No markdown fences. No explanation. Just raw YAML starting with AWSTemplateFormatVersion.
- Keep costs MINIMAL: t3.micro, gp2 small volumes, no NAT gateways unless essential
- The template must CREATE the broken state described — it should deploy successfully but leave the environment in a state where the described symptoms are observable
- Use ${region} as the region
- Include a Metadata section noting this is a simulation
- Max 10-15 resources to keep it simple and fast to deploy
- Use Parameters for anything that might need customization
- Include Outputs for key resource IDs needed to verify symptoms`,
    messages: [{
      role: "user",
      content: `Generate a deployable CloudFormation template that creates this broken environment:

BROKEN STATE: ${plan.brokenState || plan.description}
ROOT CAUSE: ${plan.rootCause}
TARGET SERVICE: ${plan.targetService}
SYMPTOMS THAT SHOULD BE OBSERVABLE:
${(plan.symptoms || []).map((s: string) => `- ${s}`).join("\n")}

VERIFICATION (these commands should show the problem after deployment):
${(plan.verificationCommands || []).map((c: string) => `$ ${c}`).join("\n")}

Generate the YAML template now. Remember: the stack should DEPLOY SUCCESSFULLY but leave infrastructure in a state where the symptoms above are observable.`,
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

  // Extract YAML
  let template = content;

  // Strip code fences if present
  template = template.replace(/^```(?:yaml|yml|cloudformation)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

  // Validate it looks like CFN
  if (!template.includes("AWSTemplateFormatVersion") && !template.includes("Resources:")) {
    return null;
  }

  return template;
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
