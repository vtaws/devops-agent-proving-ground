"use client";

import React, { useState, useEffect } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────
interface Customer { id: string; name: string; role?: string; }
interface SupportCase {
  caseId: string; subject: string; service: string; severity: string;
  status: string; createdDate: string; resolvedDate?: string;
  resolutionTimeHours?: number; communications?: number;
  category?: string; accountName?: string; description?: string;
}
interface RankedCase extends SupportCase {
  score: number; reasoning: string; reproducible: boolean;
  repeatCount: number; estimatedAgentSuccess: "high" | "medium" | "low";
  estimatedTimeSaved: number; estimatedCostSaved: number;
}
interface SimPlan {
  simulationPlan: { title: string; description: string; targetService: string;
    brokenState: string; rootCause: string; symptoms: string[];
    verificationCommands: string[]; fixSteps: string[]; difficulty: string;
    estimatedDeployTime: string; prerequisites: string[]; };
  iac: { type: string; description: string; resources: string[]; deployCommand: string; };
  evaluation: { successCriteria: string[]; partialCriteria: string[];
    failureCriteria: string[]; maxTimeSeconds: number; humanBaselineHours: number; };
}
interface Scenario {
  id: string; case: RankedCase | SupportCase;
  status: "generating" | "ready" | "deploying" | "complete" | "failed";
  plan?: SimPlan; deployResult?: any; verification?: any; agentResult?: any; metrics?: any; error?: string;
  pipelineStage?: string; // current active stage for live progress
  archived?: boolean; // moved to history on new fetch
}
type InputMode = "auto" | "manual" | "history";

export default function DevOpsAgentProvingGround() {
  const [inputMode, setInputMode] = useState<InputMode>("auto");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [timeRange, setTimeRange] = useState<6 | 12>(6);
  const [cases, setCases] = useState<SupportCase[]>([]);
  const [loadingCases, setLoadingCases] = useState(false);
  const [rankedCases, setRankedCases] = useState<RankedCase[]>([]);
  const [ranking, setRanking] = useState(false);
  const [manualSubject, setManualSubject] = useState("");
  const [manualService, setManualService] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCredModal, setShowCredModal] = useState(false);
  const [credText, setCredText] = useState("");
  const [credLoading, setCredLoading] = useState(false);
  const [credsValid, setCredsValid] = useState<boolean | null>(null);
  // Session credentials (per-user, stored in browser only)
  const [userCreds, setUserCreds] = useState<{accessKeyId: string; secretAccessKey: string; sessionToken: string} | null>(null);
  const [userAccount, setUserAccount] = useState("");
  const [targetAccount, setTargetAccount] = useState("");
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(new Set());

  useEffect(() => { checkCreds(); fetchCustomers(); loadHistory(); }, []);

  // Persist scenarios to localStorage
  useEffect(() => {
    if (scenarios.length > 0) {
      try { localStorage.setItem("devops-proving-ground-history", JSON.stringify(scenarios)); } catch {}
    }
  }, [scenarios]);

  const loadHistory = () => {
    try {
      const saved = localStorage.getItem("devops-proving-ground-history");
      if (saved) setScenarios(JSON.parse(saved));
    } catch {}
  };

  const clearHistory = () => {
    // Check if any stacks haven't been deleted
    const undeletedStacks = scenarios.filter((s) => s.deployResult?.stackName && !s.deployResult?.cleaned);
    if (undeletedStacks.length > 0) {
      const stackNames = undeletedStacks.map((s) => s.deployResult.stackName).join(", ");
      const confirmDelete = window.confirm(
        `You have ${undeletedStacks.length} stack(s) still running:\n${stackNames}\n\nDo you want to delete them before clearing history?`
      );
      if (confirmDelete) {
        // Delete stacks one by one
        undeletedStacks.forEach(async (s) => {
          try {
            await fetch("/api/devops-agent/cleanup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ stackName: s.deployResult.stackName, credentials: userCreds }),
            });
          } catch {}
        });
      }
    }
    localStorage.removeItem("devops-proving-ground-history");
    setScenarios([]);
  };

  const checkCreds = async () => {
    try {
      const r = await fetch("/api/credentials/check");
      const d = await r.json();
      setCredsValid(d.valid);
      if (!d.valid) setShowCredModal(true);
    } catch { setCredsValid(false); setShowCredModal(true); }
  };

  const refreshCreds = async () => {
    if (!credText.trim()) return;
    setCredLoading(true); setError(null);
    const keyMatch = credText.match(/AWS_ACCESS_KEY_ID[=\s"]+([A-Z0-9]+)/);
    const secretMatch = credText.match(/AWS_SECRET_ACCESS_KEY[=\s"]+([A-Za-z0-9/+=]+)/);
    const tokenMatch = credText.match(/AWS_SESSION_TOKEN[=\s"]+([A-Za-z0-9/+=]+)/);
    if (!keyMatch || !secretMatch || !tokenMatch) {
      setError("Could not parse. Paste the full export block."); setCredLoading(false); return;
    }
    const creds = { accessKeyId: keyMatch[1], secretAccessKey: secretMatch[1], sessionToken: tokenMatch[1] };
    try {
      const r = await fetch("/api/credentials/update", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      const d = await r.json();
      if (d.success) {
        setShowCredModal(false); setCredText(""); setCredsValid(true); setError(null);
        setUserCreds(creds);
        setUserAccount(d.accountId || "");
        if (!targetAccount) setTargetAccount(d.accountId || "");
      }
      else setError(d.error);
    } catch (e: any) { setError(e.message); }
    finally { setCredLoading(false); }
  };

  const fetchCustomers = async () => {
    setLoadingCustomers(true);
    try { const r = await fetch("/api/devops-agent/customers"); const d = await r.json();
      if (d.customers?.length) setCustomers(d.customers);
    } catch {} finally { setLoadingCustomers(false); }
  };

  const fetchCases = async () => {
    if (!selectedCustomer) return;
    setLoadingCases(true); setError(null);
    // Move all current completed/failed scenarios out of the main view
    // They remain in localStorage (History tab) but won't show on the main page
    setScenarios((prev) => prev.map((s) => 
      (s.status === "complete" || s.status === "failed") ? { ...s, archived: true } : s
    ));
    setSelectedCaseIds(new Set());
    try { const r = await fetch("/api/devops-agent/cases", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: selectedCustomer.id, monthsBack: timeRange }) });
      const d = await r.json();
      if (d.cases?.length) { setCases(d.cases); rankCases(d.cases); }
      else setError(d.message || d.error || "No cases found");
    } catch (e: any) { setError(e.message); } finally { setLoadingCases(false); }
  };

  const rankCases = async (c: SupportCase[]) => {
    setRanking(true);
    try { const r = await fetch("/api/devops-agent/rank-cases", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cases: c }) });
      const d = await r.json();
      if (d.rankedCases?.length) setRankedCases(d.rankedCases);
    } catch (e: any) { setError(e.message); } finally { setRanking(false); }
  };

  // ─── SIMULATE + DEPLOY ────────────────────────────────────────────────────
  const startSimulation = async (caseData: SupportCase | RankedCase) => {
    // Archive previous completed/failed simulations
    setScenarios((prev) => prev.map((s) =>
      (s.status === "complete" || s.status === "failed") ? { ...s, archived: true } : s
    ));
    const id = `sim-${Date.now()}`;
    setScenarios((p) => [{ id, case: caseData, status: "generating" }, ...p]);
    setError(null);
    setTimeout(() => document.getElementById("sim-section")?.scrollIntoView({ behavior: "smooth" }), 300);

    try {
      const r = await fetch("/api/devops-agent/simulate", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseData, mode: "plan" }) });
      const d = await r.json();
      if (d.error) {
        if (d.error.includes("expired")) { setShowCredModal(true); }
        setScenarios((p) => p.map((s) => s.id === id ? { ...s, status: "failed" as const, error: d.error } : s));
        return;
      }
      if (d.plan?.simulationPlan) {
        setScenarios((p) => p.map((s) => s.id === id ? { ...s, status: "ready" as const, plan: d.plan } : s));
      } else {
        setScenarios((p) => p.map((s) => s.id === id ? { ...s, status: "failed" as const, error: d.raw || "Parse failed" } : s));
      }
    } catch (e: any) {
      setScenarios((p) => p.map((s) => s.id === id ? { ...s, status: "failed" as const, error: e.message } : s));
    }
  };

  const updateStage = (scenarioId: string, stage: string) => {
    setScenarios((p) => p.map((s) => s.id === scenarioId ? { ...s, pipelineStage: stage } : s));
  };

  // Run multiple cases in parallel — each gets its own stack
  const runSelectedCases = async () => {
    if (selectedCaseIds.size === 0) return;
    if (!userCreds) { setShowCredModal(true); return; }
    // Archive any previous completed/failed simulations before starting new batch
    setScenarios((prev) => prev.map((s) =>
      (s.status === "complete" || s.status === "failed") ? { ...s, archived: true } : s
    ));
    const casesToRun = rankedCases.filter((rc) => selectedCaseIds.has(rc.caseId));
    setSelectedCaseIds(new Set());
    // Start all simulations in parallel (generate plans first, then auto-deploy)
    for (const caseData of casesToRun) {
      startSimulationAndDeploy(caseData);
    }
    // Auto-scroll to simulation section
    setTimeout(() => document.getElementById("sim-section")?.scrollIntoView({ behavior: "smooth" }), 300);
  };

  // Generate plan AND auto-deploy in one shot (for batch mode)
  const startSimulationAndDeploy = async (caseData: SupportCase | RankedCase) => {
    const id = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setScenarios((p) => [{ id, case: caseData, status: "generating" }, ...p]);

    try {
      // Step 1: Generate plan
      const r = await fetch("/api/devops-agent/simulate", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseData, mode: "plan" }) });
      const d = await r.json();
      if (d.error || !d.plan?.simulationPlan) {
        setScenarios((p) => p.map((s) => s.id === id ? { ...s, status: "failed" as const, error: d.error || "Plan generation failed" } : s));
        return;
      }
      setScenarios((p) => p.map((s) => s.id === id ? { ...s, status: "deploying" as const, plan: d.plan, pipelineStage: "auth" } : s));

      // Step 2: Auto-deploy immediately
      const startTime = Date.now();
      const stageTimer = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        let stage = "auth";
        if (elapsed > 3) stage = "generate";
        if (elapsed > 15) stage = "deploy";
        if (elapsed > 30) stage = "waiting";
        if (elapsed > 120) stage = "agent_setup";
        if (elapsed > 130) stage = "agent_running";
        if (elapsed > 280) stage = "evaluate";
        setScenarios((p) => p.map((s) => s.id === id && s.status === "deploying" ? { ...s, pipelineStage: stage } : s));
      }, 2000);

      const testR = await fetch("/api/devops-agent/run-full-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseData,
          simulationPlan: d.plan.simulationPlan,
          credentials: userCreds,
          accountId: targetAccount,
          region: "us-east-1",
          cleanup: false,
        }),
      });

      clearInterval(stageTimer);
      const testD = await testR.json();

      if (testD.error) {
        const displayError = testD.userMessage || testD.error;
        setScenarios((p) => p.map((s) => s.id === id ? { ...s, status: "failed" as const, error: displayError, pipelineStage: "failed", deployResult: testD } : s));
        return;
      }

      setScenarios((p) => p.map((s) => s.id === id ? {
        ...s,
        status: "complete" as const,
        pipelineStage: "done",
        plan: d.plan,
        deployResult: { stackName: testD.stackName, template: testD.template, account: testD.account },
        agentResult: testD.diagnosis,
        metrics: { ...testD.metrics, evaluation: testD.evaluation || {} },
        verification: { steps: testD.steps, totalTimeSeconds: testD.totalTimeSeconds, consoleUrl: testD.consoleUrl },
      } : s));
    } catch (e: any) {
      setScenarios((p) => p.map((s) => s.id === id ? { ...s, status: "failed" as const, error: e.message, pipelineStage: "failed" } : s));
    }
  };

  const deployScenario = async (scenarioId: string) => {
    const scenario = scenarios.find((s) => s.id === scenarioId);
    if (!scenario?.plan) return;
    if (!userCreds) { setShowCredModal(true); return; }

    setScenarios((p) => p.map((s) => s.id === scenarioId ? { ...s, status: "deploying" as const, pipelineStage: "auth" } : s));

    try {
      // All-in-one call — but we update the stage estimate based on time
      const startTime = Date.now();
      const stageTimer = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        let stage = "auth";
        if (elapsed > 3) stage = "generate";
        if (elapsed > 15) stage = "deploy";
        if (elapsed > 30) stage = "waiting";
        if (elapsed > 120) stage = "agent_setup";
        if (elapsed > 130) stage = "agent_running";
        if (elapsed > 280) stage = "evaluate";
        setScenarios((p) => p.map((s) => s.id === scenarioId && s.status === "deploying" ? { ...s, pipelineStage: stage } : s));
      }, 2000);

      const r = await fetch("/api/devops-agent/run-full-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseData: scenario.case,
          simulationPlan: scenario.plan.simulationPlan,
          credentials: userCreds,
          accountId: targetAccount,
          region: "us-east-1",
          cleanup: false,
        }),
      });

      clearInterval(stageTimer);
      const d = await r.json();

      if (d.error) {
        if (d.needsAuth) setShowCredModal(true);
        // Friendly message for simulation failures (show customer-safe text)
        const displayError = d.userMessage || d.error;
        const failedStep = d.steps?.find((s: any) => s.status === "error")?.step || "";
        setScenarios((p) => p.map((s) => s.id === scenarioId ? { ...s, status: "failed" as const, error: displayError, pipelineStage: failedStep || "failed", deployResult: d } : s));
        return;
      }

      setScenarios((p) => p.map((s) => s.id === scenarioId ? {
        ...s,
        status: "complete" as const,
        pipelineStage: "done",
        deployResult: { stackName: d.stackName, template: d.template, account: d.account },
        agentResult: d.diagnosis,
        metrics: { ...d.metrics, evaluation: d.evaluation || {} },
        verification: { steps: d.steps, totalTimeSeconds: d.totalTimeSeconds, consoleUrl: d.consoleUrl },
      } : s));
    } catch (e: any) {
      setScenarios((p) => p.map((s) => s.id === scenarioId ? { ...s, status: "failed" as const, error: e.message, pipelineStage: "failed" } : s));
    }
  };

  

  const handleManualSimulate = () => {
    if (!manualSubject.trim()) { setError("Enter a case subject"); return; }
    startSimulation({ caseId: `manual-${Date.now()}`, subject: manualSubject, service: manualService || "Unknown",
      severity: "normal", status: "resolved", createdDate: new Date().toISOString(),
      category: "Technical support", description: manualDesc });
  };

  const handleManualCaseLookup = async () => {
    const caseId = manualSubject.trim();
    if (!caseId) { setError("Enter a case number"); return; }
    if (!userCreds) { setShowCredModal(true); return; }
    setLoadingCases(true); setError(null);
    try {
      // Fetch the specific case by ID
      const r = await fetch("/api/devops-agent/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseIds: [caseId] }),
      });
      const d = await r.json();
      if (d.cases?.length) {
        const caseData = d.cases[0];
        setManualSubject(""); // clear input
        // Auto-start simulation and deploy
        startSimulationAndDeploy(caseData);
      } else {
        setError(d.error || `Case ${caseId} not found. Check the case number and try again.`);
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoadingCases(false); }
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-gray-900 text-white px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">🤖 DevOps Agent Proving Ground</h1>
            <p className="text-gray-400 text-xs mt-1">Fetch real cases → AI generates broken infra → Deploy to your account → Test DevOps Agent</p>
          </div>
          <div className="flex items-center gap-3">
            {credsValid === true && <span className="text-green-400 text-xs">✓ {userAccount || "Authenticated"}</span>}
            {credsValid === false && <button onClick={() => setShowCredModal(true)} className="text-red-400 text-xs underline">⚠️ Credentials expired</button>}
            {credsValid === true && (
              <a href="https://us-east-1.console.aws.amazon.com/devops-agent/home?region=us-east-1#/agent-spaces"
                target="_blank" rel="noopener noreferrer"
                className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-500 no-underline">
                🔗 Agent Console
              </a>
            )}
            {credsValid === true && (
              <input className="bg-gray-800 text-gray-200 text-xs px-2 py-1 rounded border border-gray-600 w-32"
                placeholder="Target Account"
                value={targetAccount}
                onChange={(e) => setTargetAccount(e.target.value.replace(/\D/g, "").slice(0, 12))}
                title="12-digit AWS account to deploy into"
              />
            )}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-6">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-500 underline text-xs">dismiss</button>
          </div>
        )}

        {/* Mode tabs */}
        <div className="card mb-6">
          <div className="flex gap-2 mb-4">
            <button onClick={() => setInputMode("auto")}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${inputMode === "auto" ? "bg-emerald-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              🔄 Auto-Fetch Customer Cases
            </button>
            <button onClick={() => setInputMode("manual")}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${inputMode === "manual" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              ✏️ Manual Ticket Entry
            </button>
            <button onClick={() => setInputMode("history")}
              className={`px-4 py-2 rounded-lg text-sm font-medium relative ${inputMode === "history" ? "bg-purple-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              📋 History
              {scenarios.filter((s) => s.status === "complete" || s.status === "failed").length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-purple-500 text-white text-[10px] rounded-full flex items-center justify-center">
                  {scenarios.filter((s) => s.status === "complete" || s.status === "failed").length}
                </span>
              )}
            </button>
          </div>

          {inputMode === "manual" && (
            <div className="space-y-3">
              <div><label className="text-xs font-medium text-gray-700">Case Number</label>
                <div className="flex gap-2">
                  <input className="input-field flex-1" placeholder="e.g. 176589194700734" value={manualSubject} onChange={(e) => setManualSubject(e.target.value.replace(/\s/g, ""))} />
                  <button onClick={handleManualCaseLookup} disabled={!manualSubject.trim() || loadingCases} className="btn-primary disabled:opacity-50 shrink-0">
                    {loadingCases ? "⏳ Fetching..." : "🔍 Fetch & Run"}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mt-1">Enter the AWS Support case ID — the app will fetch case details and run the full test automatically.</p>
              </div>
            </div>
          )}

          {inputMode === "auto" && (
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs font-medium text-gray-700">Customer</label>
                {loadingCustomers ? <p className="text-sm text-gray-400 animate-pulse">Loading...</p> :
                  customers.length > 0 ? (
                    <select className="input-field" value={selectedCustomer?.id || ""} onChange={(e) => setSelectedCustomer(customers.find((c) => c.id === e.target.value) || null)}>
                      <option value="">Select customer...</option>
                      {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  ) : <input className="input-field" placeholder="Customer name" onChange={(e) => setSelectedCustomer(e.target.value ? { id: e.target.value, name: e.target.value } : null)} />
                }
              </div>
              <div><label className="text-xs font-medium text-gray-700">Range</label>
                <select className="input-field" value={timeRange} onChange={(e) => setTimeRange(Number(e.target.value) as 6|12)}>
                  <option value={6}>6 months</option><option value={12}>12 months</option></select></div>
              <button onClick={fetchCases} disabled={!selectedCustomer || loadingCases} className="btn-primary disabled:opacity-50">
                {loadingCases ? "⏳ Fetching..." : "Fetch Cases"}</button>
            </div>
          )}

          {inputMode === "history" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-500">{scenarios.filter((s) => s.status === "complete" || s.status === "failed").length} completed tests</p>
                <button onClick={clearHistory} className="text-xs text-red-400 hover:text-red-600">🗑️ Clear All History</button>
              </div>
              {scenarios.filter((s) => s.status === "complete" || s.status === "failed").length === 0 && (
                <p className="text-sm text-gray-400 text-center py-8">No test history yet. Run a simulation to see results here.</p>
              )}
              {scenarios.filter((s) => s.status === "complete" || s.status === "failed").map((s) => (
                <details key={s.id} className="border border-gray-200 rounded-lg overflow-hidden">
                  <summary className={`flex items-center justify-between p-3 cursor-pointer hover:bg-gray-50 ${
                    s.status === "complete" ? "bg-green-50/50" : "bg-red-50/50"
                  }`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <span>{s.status === "complete" ? "✅" : "❌"}</span>
                      <div className="min-w-0">
                        <h3 className="font-medium text-sm truncate">{s.case.subject}</h3>
                        <p className="text-[10px] text-gray-500">{s.case.service} • <span className="font-mono">{s.case.caseId}</span> • {s.metrics?.agentTimeSeconds ? `${formatAgentTime(s.metrics.agentTimeSeconds)}` : "—"} • Score: {s.metrics?.evaluation?.score ?? "—"}/100</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {s.metrics?.evaluation?.verdict && (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                          s.metrics.evaluation.verdict === "PASS" ? "bg-green-100 text-green-700" :
                          s.metrics.evaluation.verdict === "PARTIAL" ? "bg-yellow-100 text-yellow-700" :
                          "bg-red-100 text-red-700"
                        }`}>{s.metrics.evaluation.verdict}</span>
                      )}
                    </div>
                  </summary>
                  <div className="p-4 border-t border-gray-200 space-y-3">
                    {s.status === "failed" && <div className="p-3 bg-red-50 rounded-lg text-sm text-red-700">⚠️ {s.error}</div>}
                    {s.status === "complete" && s.metrics && s.agentResult && (
                      <>
                        <div className="grid grid-cols-4 gap-2">
                          <div className="p-2 bg-blue-50 rounded text-center"><p className="text-lg font-bold text-blue-700">{formatAgentTime(s.metrics.agentTimeSeconds)}</p><p className="text-[10px] text-blue-600">Agent RCA</p></div>
                          <div className="p-2 bg-gray-50 rounded text-center"><p className="text-lg font-bold text-gray-700">{s.metrics.humanRcaHours ? `${s.metrics.humanRcaHours}h` : "N/A"}</p><p className="text-[10px] text-gray-600">Human RCA</p>{s.metrics.isPhoneCase && <p className="text-[9px] text-amber-600">⚠️ approx</p>}{s.metrics.noHumanTimeData && <p className="text-[9px] text-gray-400">No data</p>}</div>
                          <div className="p-2 bg-emerald-50 rounded text-center"><p className="text-lg font-bold text-emerald-700">{s.metrics.timeSavedHours != null ? `${s.metrics.timeSavedHours}h` : "—"}</p><p className="text-[10px] text-emerald-600">Saved</p></div>
                          <div className="p-2 bg-purple-50 rounded text-center"><p className="text-lg font-bold text-purple-700">{s.metrics.speedup || s.metrics.speedupFactor || "—"}</p><p className="text-[10px] text-purple-600">Speed</p></div>
                        </div>
                        {s.agentResult.identifiedSymptoms?.length > 0 && (
                          <div className="p-3 bg-orange-50 rounded-lg">
                            <p className="text-[10px] font-bold text-orange-700 uppercase">Symptoms</p>
                            <ul className="text-xs text-orange-900 mt-1">{s.agentResult.identifiedSymptoms.map((sym: string, i: number) => <li key={i}>• {sym}</li>)}</ul>
                          </div>
                        )}
                        <div className="p-3 bg-blue-50 rounded-lg">
                          <p className="text-[10px] font-bold text-blue-700 uppercase">Root Cause</p>
                          <p className="text-xs text-blue-900 mt-1">{typeof s.agentResult.rootCause === "string" ? s.agentResult.rootCause : JSON.stringify(s.agentResult.rootCause)}</p>
                        </div>
                        {s.agentResult.reasoning && (
                          <details>
                            <summary className="text-[10px] font-bold text-gray-600 uppercase cursor-pointer">Full Reasoning</summary>
                            <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap p-3 bg-gray-50 rounded-lg max-h-60 overflow-y-auto">{s.agentResult.reasoning}</p>
                          </details>
                        )}
                        {s.agentResult.proposedFix?.description && (
                          <div className="p-3 bg-gray-900 rounded-lg">
                            <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Proposed Fix</p>
                            <p className="text-xs text-gray-300">{s.agentResult.proposedFix.description}</p>
                          </div>
                        )}
                      </>
                    )}
                    {s.deployResult && (
                      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Stack: {s.deployResult.stackName} {s.deployResult.cleaned ? "(deleted)" : ""}</span>
                          <a href="https://us-east-1.console.aws.amazon.com/devops-agent/home?region=us-east-1#/agent-spaces" target="_blank" rel="noopener noreferrer"
                            className="text-xs px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200 no-underline">🔗 Console</a>
                        </div>
                        <button
                          onClick={async () => {
                            if (!userCreds || !s.deployResult?.stackName) return;
                            try {
                              await fetch("/api/devops-agent/cleanup", { method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ stackName: s.deployResult.stackName, credentials: userCreds }) });
                              setScenarios((p) => p.map((sc) => sc.id === s.id ? { ...sc, deployResult: { ...sc.deployResult, cleaned: true } } : sc));
                            } catch {}
                          }}
                          disabled={s.deployResult.cleaned}
                          className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-40 disabled:cursor-not-allowed"
                        >{s.deployResult.cleaned ? "✓ Deleted" : "🗑️ Delete Stack"}</button>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>

        {/* Ranked Cases — shown ABOVE simulations */}
        {ranking && <div className="card mb-6 text-center text-purple-600 animate-pulse">🤖 AI ranking cases...</div>}
        {rankedCases.length > 0 && inputMode !== "history" && (
          <div className="card mb-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold text-lg">📊 AI-Ranked Cases ({cases.length} total, {rankedCases.length} ranked)</h2>
              {selectedCaseIds.size > 0 && (
                <button onClick={runSelectedCases} className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium animate-pulse">
                  🚀 Run Selected ({selectedCaseIds.size}) in Parallel
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 mb-3">Select multiple cases (up to 10) for parallel testing, or run individually.</p>
            <div className="space-y-3">
              {rankedCases.map((rc, idx) => {
                const wasTested = scenarios.some((s) => s.case.caseId === rc.caseId && (s.status === "complete" || s.status === "failed"));
                return (
                <div key={rc.caseId} className={`p-3 rounded-lg border ${selectedCaseIds.has(rc.caseId) ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-300" : wasTested ? "border-gray-300 bg-gray-50" : idx === 0 ? "border-emerald-300 bg-emerald-50/50" : "border-gray-200"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <input type="checkbox" checked={selectedCaseIds.has(rc.caseId)}
                        onChange={(e) => {
                          const next = new Set(selectedCaseIds);
                          if (e.target.checked) { if (next.size < 10) next.add(rc.caseId); }
                          else next.delete(rc.caseId);
                          setSelectedCaseIds(next);
                        }}
                        className="mt-1 w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                        title={selectedCaseIds.size >= 10 && !selectedCaseIds.has(rc.caseId) ? "Max 10 cases" : "Select for batch run"}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          {wasTested && <span className="text-[10px] bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full font-medium">✓ Tested</span>}
                          {idx === 0 && !wasTested && <span className="text-[10px] bg-emerald-200 text-emerald-800 px-2 py-0.5 rounded-full font-medium">⭐ Best</span>}
                          <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{rc.service}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full ${rc.estimatedAgentSuccess === "high" ? "bg-green-100 text-green-700" : rc.estimatedAgentSuccess === "medium" ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>{rc.estimatedAgentSuccess}</span>
                        </div>
                        <h3 className={`font-medium text-sm truncate ${wasTested ? "text-gray-500" : ""}`}>{rc.subject}</h3>
                        <p className="text-xs text-gray-500 mt-1 line-clamp-2">{rc.reasoning}</p>
                        <div className="flex gap-3 mt-1 text-[10px] text-gray-500">
                          <span className="font-mono text-gray-400">{rc.caseId}</span><span>{rc.resolutionTimeHours}h</span><span>Score: {rc.score}</span><span className="text-green-600">~{rc.estimatedTimeSaved}h saved</span>
                        </div>
                      </div>
                    </div>
                    <button onClick={() => startSimulation(rc)} className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 shrink-0">{wasTested ? "↻ Rerun" : "▶ Run"}</button>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Consolidated Batch Results Summary */}
        {scenarios.filter((s) => s.status === "complete" && !s.archived).length > 1 && inputMode !== "history" && (
          <div className="card mb-6 border-l-4 border-l-green-500">
            <h2 className="font-semibold text-lg mb-3">📊 Batch Results Summary</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-gray-200 text-left">
                  <th className="py-2 pr-3">Service</th><th className="py-2 pr-3">Case ID</th><th className="py-2 pr-3">Agent RCA</th><th className="py-2 pr-3">Human RCA</th><th className="py-2 pr-3">Saved</th><th className="py-2 pr-3">Verdict</th>
                </tr></thead>
                <tbody>
                  {scenarios.filter((s) => s.status === "complete" && s.metrics && !s.archived).map((s) => (
                    <tr key={s.id} className="border-b border-gray-100">
                      <td className="py-2 pr-3 font-medium">{s.case.service}</td>
                      <td className="py-2 pr-3 font-mono text-gray-400">{s.case.caseId}</td>
                      <td className="py-2 pr-3 text-blue-700 font-medium">{formatAgentTime(s.metrics.agentTimeSeconds)}</td>
                      <td className="py-2 pr-3">{s.metrics.humanRcaHours ? `${s.metrics.humanRcaHours}h` : "N/A"}</td>
                      <td className="py-2 pr-3 text-emerald-700">{s.metrics.timeSavedHours != null ? `${s.metrics.timeSavedHours}h` : "—"}</td>
                      <td className="py-2 pr-3"><span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        s.metrics.evaluation?.verdict === "PASS" ? "bg-green-100 text-green-700" :
                        s.metrics.evaluation?.verdict === "PARTIAL" ? "bg-yellow-100 text-yellow-700" :
                        "bg-red-100 text-red-700"
                      }`}>{s.metrics.evaluation?.verdict || "—"} {s.metrics.evaluation?.score}/100</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Active Simulations — shown below ranked cases */}
        {scenarios.filter((s) => !s.archived && (s.status === "generating" || s.status === "ready" || s.status === "deploying" || s.status === "complete" || s.status === "failed")).length > 0 && inputMode !== "history" && (
          <div className="space-y-4 mb-6" id="sim-section">
            <h2 className="font-semibold text-lg">🧪 Simulations ({scenarios.filter((s) => !s.archived && s.status !== "complete" && s.status !== "failed").length} active, {scenarios.filter((s) => !s.archived && (s.status === "complete" || s.status === "failed")).length} completed)</h2>
            {scenarios.filter((s) => !s.archived && (s.status === "generating" || s.status === "ready" || s.status === "deploying" || s.status === "complete" || s.status === "failed")).map((s) => (
              <div key={s.id} className="card border-l-4 border-l-blue-500">
                <div className="flex items-start justify-between mb-2">
                  <div><h3 className="font-medium text-sm">{s.case.subject}</h3>
                    <p className="text-xs text-gray-500">{s.case.service} • <span className="font-mono">{s.case.caseId}</span></p></div>
                  <StatusBadge status={s.status} />
                </div>

                {s.status === "generating" && <div className="text-purple-600 text-sm animate-pulse flex items-center gap-2"><span className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin inline-block"/>Generating simulation plan...</div>}
                {s.status === "failed" && <div className="p-3 bg-red-50 rounded-lg text-sm text-red-700">⚠️ {s.error}</div>}

                {s.plan && s.status === "ready" && (
                  <div className="space-y-3 mt-3">
                    <div className="p-3 bg-blue-50 rounded-lg">
                      <h4 className="font-medium text-sm text-blue-900">{s.plan.simulationPlan.title}</h4>
                      <p className="text-xs text-blue-700 mt-1">{s.plan.simulationPlan.description}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 bg-red-50 rounded-lg"><p className="text-[10px] font-bold text-red-700 uppercase">Broken State</p><p className="text-xs text-red-900 mt-1">{s.plan.simulationPlan.brokenState}</p></div>
                      <div className="p-3 bg-green-50 rounded-lg"><p className="text-[10px] font-bold text-green-700 uppercase">Root Cause</p><p className="text-xs text-green-900 mt-1">{s.plan.simulationPlan.rootCause}</p></div>
                    </div>
                    <div className="p-3 bg-gray-900 rounded-lg">
                      <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Verification Commands</p>
                      {s.plan.simulationPlan.verificationCommands.map((cmd, i) => (
                        <code key={i} className="block text-xs text-green-400 font-mono bg-gray-800 px-2 py-1 rounded mb-1">$ {cmd}</code>
                      ))}
                    </div>
                    <button onClick={() => deployScenario(s.id)} className="btn-primary w-full py-3 text-base">
                      🚀 Run Full Test (Deploy → Agent → Metrics)
                    </button>
                  </div>
                )}

                {s.status === "deploying" && (
                  <div className="mt-3 p-4 bg-gray-800 border border-gray-700 rounded-lg">
                    <div className="flex items-center gap-2 text-blue-400 text-sm mb-3">
                      <span className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin inline-block"/>
                      Running full test pipeline...
                    </div>
                    <PipelineStages activeStage={s.pipelineStage || "auth"} />
                  </div>
                )}

                {s.status === "complete" && s.metrics && s.agentResult && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium text-green-700 hover:text-green-800">
                      ✅ {s.metrics.evaluation?.verdict} — Score: {s.metrics.evaluation?.score}/100 | Agent: {formatAgentTime(s.metrics.agentTimeSeconds)} | Click to expand
                    </summary>
                    <div className="mt-3 space-y-4">
                    {/* Metrics Dashboard */}
                    <div className="grid grid-cols-4 gap-3">
                      <div className="p-3 bg-blue-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-blue-700">{formatAgentTime(s.metrics.agentTimeSeconds)}</p>
                        <p className="text-[10px] text-blue-600">Agent Time to RCA</p>
                      </div>
                      <div className="p-3 bg-gray-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-gray-700">{s.metrics.humanRcaHours ? `${s.metrics.humanRcaHours}h` : "N/A"}</p>
                        <p className="text-[10px] text-gray-600">Human Time to RCA</p>
                        {s.metrics.isPhoneCase && <p className="text-[9px] text-amber-600 mt-0.5">⚠️ Phone case — approximate</p>}
                        {s.metrics.noHumanTimeData && <p className="text-[9px] text-gray-400 mt-0.5">No timestamp data</p>}
                      </div>
                      <div className="p-3 bg-emerald-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-emerald-700">{s.metrics.timeSavedHours != null ? `${s.metrics.timeSavedHours}h` : "—"}</p>
                        <p className="text-[10px] text-emerald-600">Time Saved</p>
                      </div>
                      <div className="p-3 bg-purple-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-purple-700">{s.metrics.speedup || s.metrics.speedupFactor || "—"}</p>
                        <p className="text-[10px] text-purple-600">Speed-up</p>
                      </div>
                    </div>

                    {/* Verdict */}
                    <div className={`p-4 rounded-lg border ${
                      s.metrics?.evaluation?.verdict === "PASS" ? "bg-green-50 border-green-300" :
                      s.metrics?.evaluation?.verdict === "PARTIAL" ? "bg-yellow-50 border-yellow-300" :
                      "bg-red-50 border-red-300"
                    }`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-lg mr-2">{s.metrics?.evaluation?.verdict === "PASS" ? "✅" : s.metrics?.evaluation?.verdict === "PARTIAL" ? "⚠️" : "❌"}</span>
                          <span className="font-bold text-sm">{s.metrics?.evaluation?.verdict}</span>
                          <span className="text-xs ml-2 text-gray-600">— Root cause: {s.metrics?.evaluation?.rootCauseAccuracy} | Confidence: {s.metrics?.evaluation?.agentConfidence} | Score: {s.metrics?.evaluation?.score}/100</span>
                        </div>
                      </div>
                    </div>

                    {/* Agent Diagnosis */}
                    <details open>
                      <summary className="text-sm font-medium text-gray-700 cursor-pointer">🤖 Agent Diagnosis</summary>
                      <div className="mt-2 space-y-2">
                        {s.agentResult.identifiedSymptoms?.length > 0 && (
                          <div className="p-3 bg-orange-50 rounded-lg">
                            <p className="text-[10px] font-bold text-orange-700 uppercase">Symptoms Identified</p>
                            <ul className="text-xs text-orange-900 mt-1 space-y-0.5">
                              {s.agentResult.identifiedSymptoms.map((sym: string, i: number) => <li key={i}>• {sym}</li>)}
                            </ul>
                          </div>
                        )}
                        <div className="p-3 bg-blue-50 rounded-lg">
                          <p className="text-[10px] font-bold text-blue-700 uppercase">Root Cause Identified</p>
                          <p className="text-sm text-blue-900 mt-1">{typeof s.agentResult.rootCause === "string" ? s.agentResult.rootCause : JSON.stringify(s.agentResult.rootCause)}</p>
                        </div>
                        {s.agentResult.reasoning && (
                          <div className="p-3 bg-gray-50 rounded-lg">
                            <p className="text-[10px] font-bold text-gray-600 uppercase">Reasoning</p>
                            <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap">{s.agentResult.reasoning}</p>
                          </div>
                        )}
                        {s.agentResult.proposedFix && (
                          <div className="p-3 bg-gray-900 rounded-lg">
                            <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Proposed Fix</p>
                            {s.agentResult.proposedFix.description && (
                              <p className="text-xs text-gray-300 mb-2">{s.agentResult.proposedFix.description}</p>
                            )}
                            {s.agentResult.proposedFix.commands?.map((cmd: string, i: number) => (
                              <code key={i} className="block text-xs text-green-400 font-mono bg-gray-800 px-2 py-1 rounded mb-1">$ {cmd}</code>
                            ))}
                          </div>
                        )}
                        {s.agentResult.additionalInvestigation?.length > 0 && (
                          <div className="p-3 bg-purple-50 rounded-lg">
                            <p className="text-[10px] font-bold text-purple-700 uppercase">Additional Investigation Needed</p>
                            <ul className="text-xs text-purple-900 mt-1 space-y-0.5">
                              {s.agentResult.additionalInvestigation.map((item: string, i: number) => <li key={i}>• {item}</li>)}
                            </ul>
                          </div>
                        )}
                      </div>
                    </details>

                    {/* Deploy info + cleanup */}
                    {s.deployResult && (
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-500">Stack: {s.deployResult.stackName} {s.deployResult.cleaned ? "(deleted)" : ""}</span>
                          {s.verification?.consoleUrl && (
                            <a href="https://us-east-1.console.aws.amazon.com/devops-agent/home?region=us-east-1#/agent-spaces" target="_blank" rel="noopener noreferrer"
                              className="text-xs px-2 py-1 bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200 no-underline">
                              🔗 View in Console
                            </a>
                          )}
                        </div>
                        <button
                          onClick={async () => {
                            if (!userCreds || !s.deployResult?.stackName) return;
                            try {
                              await fetch("/api/devops-agent/cleanup", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ stackName: s.deployResult.stackName, credentials: userCreds }),
                              });
                              setScenarios((p) => p.map((sc) => sc.id === s.id ? { ...sc, deployResult: { ...sc.deployResult, cleaned: true } } : sc));
                            } catch {}
                          }}
                          disabled={s.deployResult.cleaned}
                          className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {s.deployResult.cleaned ? "✓ Deleted" : "🗑️ Delete Stack"}
                        </button>
                      </div>
                    )}
                  </div>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}

      </div>

      {/* Credential Modal */}
      {showCredModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-xl shadow-2xl max-w-lg w-full p-6 border border-gray-700">
            <h3 className="font-semibold text-lg text-white mb-2">🔑 AWS Credentials</h3>
            <p className="text-xs text-gray-400 mb-3">Paste your <code className="text-blue-400">isengardcli credentials</code> export block:</p>
            <textarea className="w-full bg-gray-900 text-green-400 font-mono text-xs rounded-lg px-3 py-3 min-h-[120px] border border-gray-600 focus:border-blue-500 focus:outline-none"
              placeholder={'export AWS_ACCESS_KEY_ID="ASIA..."\nexport AWS_SECRET_ACCESS_KEY="..."\nexport AWS_SESSION_TOKEN="..."'}
              value={credText} onChange={(e) => setCredText(e.target.value)} />
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowCredModal(false)} className="text-xs px-3 py-2 bg-gray-700 text-gray-300 rounded-lg">Cancel</button>
              <button onClick={refreshCreds} disabled={!credText.trim() || credLoading} className="text-xs px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50">
                {credLoading ? "Updating..." : "✓ Update Credentials"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatAgentTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function StatusBadge({ status }: { status: Scenario["status"] }) {
  const c: Record<string, string> = { generating: "text-purple-600", ready: "text-blue-600", deploying: "text-orange-600", complete: "text-green-600", failed: "text-red-600" };
  const t: Record<string, string> = { generating: "⏳ Generating Plan...", ready: "✓ Plan Ready", deploying: "🔄 Running Full Test...", complete: "✅ Complete", failed: "❌ Failed" };
  return <span className={`text-xs font-medium ${c[status] || ""} ${["generating", "deploying"].includes(status) ? "animate-pulse" : ""}`}>{t[status]}</span>;
}


function PipelineStages({ activeStage }: { activeStage: string }) {
  const stages = [
    { id: "auth", label: "Auth", icon: "🔑" },
    { id: "generate", label: "Generate CFN", icon: "📝" },
    { id: "deploy", label: "Deploy", icon: "🚀" },
    { id: "waiting", label: "Stack Creating", icon: "⏳" },
    { id: "agent_setup", label: "Agent Setup", icon: "🔧" },
    { id: "agent_running", label: "Agent Diagnosing", icon: "🤖" },
    { id: "evaluate", label: "Evaluate", icon: "📊" },
  ];

  const activeIdx = stages.findIndex((s) => s.id === activeStage);

  return (
    <div className="space-y-1">
      {stages.map((stage, idx) => {
        const isDone = idx < activeIdx;
        const isActive = idx === activeIdx;
        const isPending = idx > activeIdx;
        return (
          <div key={stage.id} className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs ${
            isDone ? "bg-green-900/30 text-green-400" :
            isActive ? "bg-blue-900/40 text-blue-300 font-medium" :
            "text-gray-600"
          }`}>
            <span className="w-5 text-center">
              {isDone ? "✓" : isActive ? <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"/> : stage.icon}
            </span>
            <span>{stage.label}</span>
            {isActive && <span className="ml-auto text-[10px] text-blue-400 animate-pulse">running...</span>}
          </div>
        );
      })}
    </div>
  );
}
