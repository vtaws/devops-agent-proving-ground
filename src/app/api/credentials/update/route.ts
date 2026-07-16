import { NextRequest } from "next/server";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";

/**
 * POST /api/credentials/update
 *
 * Updates the .env.local file with new AWS credentials.
 * Used when credentials expire mid-session.
 */
export async function POST(request: NextRequest) {
  try {
    const { accessKeyId, secretAccessKey, sessionToken } = await request.json();

    if (!accessKeyId || !secretAccessKey || !sessionToken) {
      return new Response(
        JSON.stringify({ error: "All three credential fields are required" }),
        { status: 400 }
      );
    }

    // Read existing .env.local
    const envPath = join(process.cwd(), ".env.local");
    let envContent = "";
    try {
      envContent = readFileSync(envPath, "utf-8");
    } catch {
      envContent = "";
    }

    // Replace or add credential lines
    const lines = envContent.split("\n");
    const updatedLines = lines.filter(
      (line) =>
        !line.startsWith("AWS_ACCESS_KEY_ID=") &&
        !line.startsWith("AWS_SECRET_ACCESS_KEY=") &&
        !line.startsWith("AWS_SESSION_TOKEN=")
    );

    updatedLines.push(`AWS_ACCESS_KEY_ID=${accessKeyId}`);
    updatedLines.push(`AWS_SECRET_ACCESS_KEY=${secretAccessKey}`);
    updatedLines.push(`AWS_SESSION_TOKEN=${sessionToken}`);

    writeFileSync(envPath, updatedLines.join("\n"));

    // Also update process.env for the current running server
    process.env.AWS_ACCESS_KEY_ID = accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
    process.env.AWS_SESSION_TOKEN = sessionToken;

    return new Response(
      JSON.stringify({ success: true, message: "Credentials updated. No restart needed." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500 }
    );
  }
}
