import { NextRequest } from "next/server";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

/**
 * POST /api/devops-agent/cases
 *
 * Fetches support cases for a customer using aws-support-mcp Python tool.
 */

const PYTHON_BIN = join(homedir(), ".toolbox/tools/aws-support-mcp/1.0.1.78.0/bin/python3");
const SCRIPT_PATH = join(process.cwd(), "scripts/mcp-call.py");

export async function POST(request: NextRequest) {
  try {
    const { customerId, customerName, monthsBack = 6 } = await request.json();

    if (!customerId && !customerName) {
      return jsonResponse({ error: "Customer ID or name required" }, 400);
    }

    // Calculate start date
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - monthsBack);
    const startDateStr = startDate.toISOString().slice(0, 10);

    const args = JSON.stringify({
      customer_id: customerId || "",
      start_date: startDateStr,
      case_status: "",
      payer_id: "",
    });

    const result = execSync(
      `${PYTHON_BIN} ${SCRIPT_PATH} caseapi_fetch_cases '${args}'`,
      { timeout: 60000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    const data = JSON.parse(result);

    if (data.cases && data.cases.length > 0) {
      const cases = normalizeCases(data.cases);
      return jsonResponse({
        cases,
        source: "aws-support-mcp",
        total: data.totals?.cases?.total || cases.length,
        pagination: data.pagination || null,
      });
    }

    if (data.error) {
      return jsonResponse({ cases: [], error: data.error, source: "aws-support-mcp" });
    }

    return jsonResponse({ cases: [], source: "aws-support-mcp", message: "No cases found" });
  } catch (error: any) {
    console.error("Case fetch error:", error.message);
    return jsonResponse({
      cases: [],
      error: error.message,
      hint: "Ensure aws-support-mcp is installed and midway is authenticated",
    }, 500);
  }
}

function normalizeCases(cases: any[]): any[] {
  return cases.map((c: any) => {
    const sys = c.system || {};
    const counts = c.counts || {};

    // Parse duration from "X hours" or "X days Y hours Z mins" format
    let resolutionTimeHours = 0;
    if (counts.duration_hours) {
      resolutionTimeHours = parseFloat(counts.duration_hours) || 0;
    }

    return {
      caseId: c.caseId || sys.caseId,
      subject: sys.subject || "Unknown",
      service: sys.type || sys.resolver || sys.item || "Unknown",
      severity: (sys.severity || "Normal").toLowerCase(),
      status: (sys.status || "Resolved").toLowerCase(),
      createdDate: sys.creationDate || "",
      resolvedDate: sys.resolutionDate || "",
      resolutionTimeHours: Math.round(resolutionTimeHours * 10) / 10,
      communications: parseInt(sys.communicationsReceived || "0") + parseInt(sys.communicationsSent || "0"),
      category: sys.category || "Technical support",
      accountName: sys.accountName || "",
      accountId: sys.accountId || "",
    };
  });
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
