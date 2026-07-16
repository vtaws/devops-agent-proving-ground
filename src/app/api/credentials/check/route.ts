import { NextRequest } from "next/server";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

/**
 * GET /api/credentials/check
 *
 * Checks if current AWS credentials are valid.
 * Returns account ID if valid, error if expired/missing.
 */
export async function GET(request: NextRequest) {
  try {
    const client = new STSClient({ region: process.env.AWS_REGION || "us-east-1" });
    const command = new GetCallerIdentityCommand({});
    const result = await client.send(command);

    return new Response(
      JSON.stringify({
        valid: true,
        accountId: result.Account,
        arn: result.Arn,
        userId: result.UserId,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        valid: false,
        error: error.name || "CredentialsError",
        message: error.message || "AWS credentials are missing or expired",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
}
