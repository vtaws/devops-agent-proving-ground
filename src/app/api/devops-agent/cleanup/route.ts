import { NextRequest } from "next/server";
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

/**
 * POST /api/devops-agent/cleanup
 * Deletes a simulation stack from the user's account.
 */
export async function POST(request: NextRequest) {
  try {
    const { stackName, credentials, region = "us-east-1" } = await request.json();

    if (!stackName || !credentials?.accessKeyId) {
      return new Response(JSON.stringify({ error: "stackName and credentials required" }), { status: 400 });
    }

    const cfn = new CloudFormationClient({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });

    await cfn.send(new DeleteStackCommand({ StackName: stackName }));

    return new Response(JSON.stringify({ success: true, message: `Stack ${stackName} deletion initiated` }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
