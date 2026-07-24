import { NextRequest } from "next/server";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

/**
 * POST /api/devops-agent/cases
 *
 * Fetches support cases for a customer using aws-support-mcp Python tool.
 */

const SCRIPT_PATH = join(process.cwd(), "scripts/mcp-call.py");

// Auto-detect MCP Python binary (version may differ across machines)
function getMcpPythonBin(): string {
  const fs = require("fs");
  const mcpDir = join(homedir(), ".toolbox/tools/aws-support-mcp");
  try {
    const versions = fs.readdirSync(mcpDir)
      .filter((f: string) => /^\d/.test(f) && fs.statSync(join(mcpDir, f)).isDirectory())
      .sort().reverse();
    if (versions.length > 0) return join(mcpDir, versions[0], "bin/python3");
  } catch {}
  return join(mcpDir, "1.0.1.78.0/bin/python3");
}
const PYTHON_BIN = getMcpPythonBin();

export async function POST(request: NextRequest) {
  try {
    const { customerId, customerName, monthsBack = 6, caseIds } = await request.json();

    // Mode 1: Fetch specific case(s) by ID
    if (caseIds && caseIds.length > 0) {
      const args = JSON.stringify({ case_ids: caseIds });
      const result = execSync(
        `${PYTHON_BIN} ${SCRIPT_PATH} caseapi_fetch_cases '${args}'`,
        { timeout: 60000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const data = JSON.parse(result);
      if (data.cases && data.cases.length > 0) {
        return jsonResponse({ cases: normalizeCases(data.cases), source: "aws-support-mcp" });
      }
      return jsonResponse({ cases: [], error: `Case(s) not found: ${caseIds.join(", ")}`, source: "aws-support-mcp" });
    }

    // Mode 2: Fetch by customer
    if (!customerId && !customerName) {
      return jsonResponse({ error: "Customer ID, name, or case IDs required" }, 400);
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

    // Extract correspondence text for RCA extraction
    let correspondence = "";
    if (c.communications && Array.isArray(c.communications)) {
      correspondence = c.communications
        .filter((m: any) => m.sentBy === "engineer" || m.sentBy === "aws" || m.direction === "sent")
        .map((m: any) => `[${m.timestamp || m.date || ""}] ${m.body || m.text || m.content || ""}`)
        .join("\n\n");
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
      correspondence: correspondence || c.correspondence || "",
      description: sys.description || c.description || "",
    };
  });
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
