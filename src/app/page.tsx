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
}
type InputMode = "auto" | "manual";

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

  useEffect(() => { checkCreds(); fetchCustomers(); }, []);

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
    const id = `sim-${Date.now()}`;
    setScenarios((p) => [{ id, case: caseData, status: "generating" }, ...p]);
    setError(null);
    setTimeout(() => document.getElementById("sim-section")?.scrollIntoView({ behavior: "smooth" }), 100);

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

  const deployScenario = async (scenarioId: string) => {
    const scenario = scenarios.find((s) => s.id === scenarioId);
    if (!scenario?.plan) return;
    if (!userCreds) { setShowCredModal(true); return; }

    setScenarios((p) => p.map((s) => s.id === scenarioId ? { ...s, status: "deploying" as const } : s));

    try {
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
      const d = await r.json();

      if (d.error) {
        if (d.needsAuth) setShowCredModal(true);
        setScenarios((p) => p.map((s) => s.id === scenarioId ? { ...s, status: "failed" as const, error: d.error, deployResult: d } : s));
        return;
      }

      setScenarios((p) => p.map((s) => s.id === scenarioId ? {
        ...s,
        status: "complete" as const,
        deployResult: { stackName: d.stackName, template: d.template, account: d.account },
        agentResult: d.diagnosis,
        metrics: d.metrics,
        verification: { steps: d.steps, totalTimeSeconds: d.totalTimeSeconds },
      } : s));
    } catch (e: any) {
      setScenarios((p) => p.map((s) => s.id === scenarioId ? { ...s, status: "failed" as const, error: e.message } : s));
    }
  };

  // Poll not needed anymore — run-full-test does everything in one call
  

  const handleManualSimulate = () => {
    if (!manualSubject.trim()) { setError("Enter a case subject"); return; }
    startSimulation({ caseId: `manual-${Date.now()}`, subject: manualSubject, service: manualService || "Unknown",
      severity: "normal", status: "resolved", createdDate: new Date().toISOString(),
      category: "Technical support", description: manualDesc });
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
          </div>

          {inputMode === "manual" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-gray-700">AWS Service</label>
                  <input className="input-field" placeholder="EC2, EKS, SES, MWAA..." value={manualService} onChange={(e) => setManualService(e.target.value)} /></div>
                <div><label className="text-xs font-medium text-gray-700">Issue Subject *</label>
                  <input className="input-field" placeholder="e.g. EC2 unreachable after SG change" value={manualSubject} onChange={(e) => setManualSubject(e.target.value)} /></div>
              </div>
              <div><label className="text-xs font-medium text-gray-700">Additional Context</label>
                <textarea className="input-field min-h-[60px]" placeholder="Optional details..." value={manualDesc} onChange={(e) => setManualDesc(e.target.value)} /></div>
              <button onClick={handleManualSimulate} disabled={!manualSubject.trim()} className="btn-primary disabled:opacity-50">🚀 Generate & Deploy Simulation</button>
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
        </div>

        {/* Simulations Section */}
        {scenarios.length > 0 && (
          <div className="space-y-4 mb-6" id="sim-section">
            <h2 className="font-semibold text-lg">🧪 Simulations</h2>
            {scenarios.map((s) => (
              <div key={s.id} className="card border-l-4 border-l-blue-500">
                <div className="flex items-start justify-between mb-2">
                  <div><h3 className="font-medium text-sm">{s.case.subject}</h3>
                    <p className="text-xs text-gray-500">{s.case.service}</p></div>
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
                  <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-center gap-2 text-blue-700 text-sm animate-pulse">
                      <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin inline-block"/>
                      Running full test pipeline...
                    </div>
                    <p className="text-xs text-blue-600 mt-2">Deploy CFN → Wait for stack → Inspect resources → Run DevOps Agent → Calculate savings</p>
                    <p className="text-[10px] text-blue-500 mt-1">This may take 2-5 minutes depending on stack complexity</p>
                  </div>
                )}

                {s.status === "complete" && s.metrics && s.agentResult && (
                  <div className="mt-3 space-y-4">
                    {/* Metrics Dashboard */}
                    <div className="grid grid-cols-5 gap-3">
                      <div className="p-3 bg-blue-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-blue-700">{s.metrics.agentTimeSeconds}s</p>
                        <p className="text-[10px] text-blue-600">Agent Time</p>
                      </div>
                      <div className="p-3 bg-gray-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-gray-700">{s.metrics.humanBaselineHours}h</p>
                        <p className="text-[10px] text-gray-600">Human Time</p>
                      </div>
                      <div className="p-3 bg-emerald-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-emerald-700">{s.metrics.timeSavedHours}h</p>
                        <p className="text-[10px] text-emerald-600">Time Saved</p>
                      </div>
                      <div className="p-3 bg-green-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-green-700">${s.metrics.costSaved}</p>
                        <p className="text-[10px] text-green-600">Cost Saved</p>
                      </div>
                      <div className="p-3 bg-purple-50 rounded-lg text-center">
                        <p className="text-xl font-bold text-purple-700">{s.metrics.speedupFactor}</p>
                        <p className="text-[10px] text-purple-600">Speed-up</p>
                      </div>
                    </div>

                    {/* Verdict */}
                    <div className={`p-4 rounded-lg border ${
                      s.metrics.evaluation.verdict === "PASS" ? "bg-green-50 border-green-300" :
                      s.metrics.evaluation.verdict === "PARTIAL" ? "bg-yellow-50 border-yellow-300" :
                      "bg-red-50 border-red-300"
                    }`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-lg mr-2">{s.metrics.evaluation.verdict === "PASS" ? "✅" : s.metrics.evaluation.verdict === "PARTIAL" ? "⚠️" : "❌"}</span>
                          <span className="font-bold text-sm">{s.metrics.evaluation.verdict}</span>
                          <span className="text-xs ml-2 text-gray-600">— Root cause: {s.metrics.evaluation.rootCauseAccuracy} | Confidence: {s.metrics.evaluation.agentConfidence} | Score: {s.metrics.evaluation.score}/100</span>
                        </div>
                      </div>
                    </div>

                    {/* Agent Diagnosis */}
                    <details open>
                      <summary className="text-sm font-medium text-gray-700 cursor-pointer">🤖 Agent Diagnosis</summary>
                      <div className="mt-2 space-y-2">
                        <div className="p-3 bg-gray-50 rounded-lg">
                          <p className="text-[10px] font-bold text-gray-600 uppercase">Root Cause Identified</p>
                          <p className="text-sm text-gray-900 mt-1">{s.agentResult.rootCause}</p>
                        </div>
                        {s.agentResult.reasoning && (
                          <div className="p-3 bg-gray-50 rounded-lg">
                            <p className="text-[10px] font-bold text-gray-600 uppercase">Reasoning</p>
                            <p className="text-xs text-gray-700 mt-1">{s.agentResult.reasoning}</p>
                          </div>
                        )}
                        {s.agentResult.proposedFix?.commands?.length > 0 && (
                          <div className="p-3 bg-gray-900 rounded-lg">
                            <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Proposed Fix</p>
                            <p className="text-xs text-gray-300 mb-2">{s.agentResult.proposedFix.description}</p>
                            {s.agentResult.proposedFix.commands.map((cmd: string, i: number) => (
                              <code key={i} className="block text-xs text-green-400 font-mono bg-gray-800 px-2 py-1 rounded mb-1">$ {cmd}</code>
                            ))}
                          </div>
                        )}
                      </div>
                    </details>

                    {/* Deploy info + cleanup */}
                    {s.deployResult && (
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
                        <span className="text-xs text-gray-500">Stack: {s.deployResult.stackName} {s.deployResult.cleaned ? "(deleted)" : ""}</span>
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
                )}
              </div>
            ))}
          </div>
        )}

        {/* Ranked Cases */}
        {rankedCases.length > 0 && (
          <div className="card mb-6">
            <h2 className="font-semibold text-lg mb-2">📊 AI-Ranked Cases ({cases.length} total, {rankedCases.length} ranked)</h2>
            <p className="text-xs text-gray-500 mb-3">Ranked by reproducibility, resolution time, and agent success likelihood.</p>
            <div className="space-y-3">
              {rankedCases.map((rc, idx) => (
                <div key={rc.caseId} className={`p-3 rounded-lg border ${idx === 0 ? "border-emerald-300 bg-emerald-50" : "border-gray-200"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        {idx === 0 && <span className="text-[10px] bg-emerald-200 text-emerald-800 px-2 py-0.5 rounded-full font-medium">⭐ Best</span>}
                        <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{rc.service}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${rc.estimatedAgentSuccess === "high" ? "bg-green-100 text-green-700" : rc.estimatedAgentSuccess === "medium" ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>{rc.estimatedAgentSuccess}</span>
                      </div>
                      <h3 className="font-medium text-sm truncate">{rc.subject}</h3>
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">{rc.reasoning}</p>
                      <div className="flex gap-3 mt-1 text-[10px] text-gray-500">
                        <span>{rc.resolutionTimeHours}h</span><span>Score: {rc.score}</span><span className="text-green-600">${rc.estimatedCostSaved} saved</span>
                      </div>
                    </div>
                    <button onClick={() => startSimulation(rc)} className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 shrink-0">▶ Simulate</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {ranking && <div className="card mb-6 text-center text-purple-600 animate-pulse">🤖 AI ranking cases...</div>}
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

function StatusBadge({ status }: { status: Scenario["status"] }) {
  const c: Record<string, string> = { generating: "text-purple-600", ready: "text-blue-600", deploying: "text-orange-600", complete: "text-green-600", failed: "text-red-600" };
  const t: Record<string, string> = { generating: "⏳ Generating Plan...", ready: "✓ Plan Ready", deploying: "🔄 Running Full Test...", complete: "✅ Complete", failed: "❌ Failed" };
  return <span className={`text-xs font-medium ${c[status] || ""} ${["generating", "deploying"].includes(status) ? "animate-pulse" : ""}`}>{t[status]}</span>;
}
