import { NextRequest } from "next/server";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

/**
 * GET /api/devops-agent/customers
 *
 * Fetches customers by calling the aws-support-mcp Python tool directly.
 */

const PYTHON_BIN = join(homedir(), ".toolbox/tools/aws-support-mcp/1.0.1.78.0/bin/python3");
const SCRIPT_PATH = join(process.cwd(), "scripts/mcp-call.py");

export async function GET(request: NextRequest) {
  try {
    const result = execSync(
      `${PYTHON_BIN} ${SCRIPT_PATH} cmc_get_customers '{}'`,
      { timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    const data = JSON.parse(result);

    if (data.success && data.customers) {
      const customers = data.customers.map((c: any) => ({
        id: c.id,
        name: c.name,
        role: c.role || "TAM",
        domain: c.primaryWebDomain,
        organization: c.organization,
      }));

      return new Response(
        JSON.stringify({ customers, source: "aws-support-mcp" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ customers: [], error: data.error || "No customers returned" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        customers: [],
        error: error.message,
        hint: "Ensure aws-support-mcp is installed: toolbox install aws-support-mcp",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
}
