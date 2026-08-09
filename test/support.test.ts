import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleTrace, normalizeClaimId, renderTrace, type TraceEvent } from "../src/support/trace.js";
import { classifyFailure, diagnoseBatch, diagnoseRecord, diagnoseRecords, renderBatch } from "../src/support/fmea.js";
import { OVERDUE_JOB_HOURS, STUCK_ATTEMPTS, renderFailedOps, summarize, type StalledItem } from "../src/support/failed-ops.js";
import {
  DIFF_SAMPLE,
  MAX_SNAPSHOT_ROWS,
  checkApply,
  checkStatement,
  diffRows,
  normalizeStatement,
  previewToken,
  renderPreview,
} from "../src/support/remediate.js";
import { MemoryStore } from "../src/memory/store.js";
import { loadChain } from "../src/audit/store.js";
import { verifyChain } from "../src/audit/chain.js";
import {
  MAX_ERROR_TEXT,
  inputShapeOf,
  outcomeOf,
  renderCallSummary,
  retentionPlan,
  scrubErrorText,
  summarizeCalls,
  type ToolCallRecord,
} from "../src/support/tool-log.js";
import { SUPPORT_TOOLS } from "../src/support/tools.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { META_TOOLS } from "../src/tools/meta.js";

describe("claim lifecycle trace", () => {
  const ev = (at: number, source: TraceEvent["source"], label: string, adverse = false): TraceEvent => ({
    at,
    source,
    label,
    detail: "",
    adverse,
  });

  it("normalizes claim ids the way the AR report does", () => {
    expect(normalizeClaimId("  c-1 ")).toBe("C-1");
  });

  it("orders events and measures the span", () => {
    const r = assembleTrace("C-1", [ev(3 * 86_400_000, "remittance", "paid"), ev(0, "claim", "built")]);
    expect(r.events.map((e) => e.source)).toEqual(["claim", "remittance"]);
    expect(r.spanDays).toBe(3);
  });

  it("NAMES the stages that never happened", () => {
    // A support engineer is nearly always looking for the step that did not
    // occur; a timeline of what did occur makes them infer the gap.
    const r = assembleTrace("C-1", [ev(0, "claim", "built")]);
    expect(r.missingStages).toEqual([
      "Front-end acknowledgment (277CA)",
      "Acknowledgment received",
    ].slice(0, 1).concat(["Remittance received (835)"]));
  });

  it("counts filing proof as satisfying the acknowledgment stage", () => {
    const r = assembleTrace("C-1", [ev(0, "claim", "built"), ev(1, "filing_proof", "banked"), ev(2, "remittance", "paid")]);
    expect(r.missingStages).toEqual([]);
  });

  it("treats a total absence as a finding, not an empty result", () => {
    const out = renderTrace(assembleTrace("C-9", []));
    expect(out).toMatch(/That is itself a finding/);
    expect(out).toMatch(/different tenant/);
  });

  it("refuses to call itself a distributed trace", () => {
    const out = renderTrace(assembleTrace("C-1", [ev(0, "claim", "built")]));
    expect(out).toMatch(/not a distributed trace/);
  });

  it("surfaces adverse events separately", () => {
    const out = renderTrace(assembleTrace("C-1", [ev(0, "claim", "built"), ev(1, "remittance", "DENIED", true)]));
    expect(out).toMatch(/1 adverse event/);
  });
});

describe("failure classification", () => {
  it("names credential failures and says retrying will not help", () => {
    const d = classifyFailure("Request failed with status code 401 Unauthorized");
    expect(d.category).toBe("auth");
    expect(d.nextSteps.join(" ")).toMatch(/Retrying will not help/);
  });

  it("separates a rate limit, which IS transient, from the rest", () => {
    const d = classifyFailure("HTTP 429 Too Many Requests");
    expect(d.category).toBe("rate_limit");
    expect(d.nextSteps.join(" ")).toMatch(/this one IS transient/);
  });

  it("distinguishes nothing-answered from answered-slowly", () => {
    expect(classifyFailure("connect ECONNREFUSED 127.0.0.1:11434").category).toBe("network");
    expect(classifyFailure("The operation was aborted due to timeout").category).toBe("timeout");
  });

  it("matches the specific rule before the general one", () => {
    // "401" must beat a generic HTTP rule; ECONNREFUSED must beat prose.
    expect(classifyFailure("fetch failed: connect ECONNREFUSED").category).toBe("network");
    expect(classifyFailure("401 fetch failed").category).toBe("auth");
  });

  it("recognizes missing reference data as a limit, not a claim failure", () => {
    const d = classifyFailure("MPFS RVU data not installed — drop mpfs.json into ~/.aetheraclaw/data");
    expect(d.category).toBe("missing_reference_data");
    expect(d.nextSteps.join(" ")).toMatch(/not a failure of the claim/);
  });

  it("reads a 277CA rejection category", () => {
    const d = classifyFailure("Status: A3:21:85 — acknowledgment rejected for missing information");
    expect(d.category).toBe("payer_rejection");
    expect(d.nextSteps.join(" ")).toMatch(/no appeal rights/);
  });

  it("says UNCLASSIFIED rather than guessing", () => {
    // A confident wrong category sends an engineer down the wrong path for an
    // hour, and they trust it because it sounded certain.
    const d = classifyFailure("the flux capacitor emitted a purple noise");
    expect(d.category).toBe("unclassified");
    expect(d.nextSteps.join(" ")).toMatch(/deliberately not a guess/);
    expect(d.evidence).toMatch(/flux capacitor/);
  });

  it("calls a single shared cause one incident", () => {
    const out = renderBatch(diagnoseBatch(Array.from({ length: 40 }, () => "ECONNREFUSED")));
    expect(out).toMatch(/single incident/);
  });

  it("flags many distinct causes as something changed underneath", () => {
    const out = renderBatch(diagnoseBatch(["401", "ECONNREFUSED", "ENOSPC", "database is locked", "timed out"]));
    expect(out).toMatch(/look for something that changed underneath/);
  });

  it("reports the unclassified count instead of burying it", () => {
    expect(renderBatch(diagnoseBatch(["401", "purple noise"]))).toMatch(/reported as unclassified rather than guessed at/);
  });
});

describe("stalled operations", () => {
  const item = (over: Partial<StalledItem> = {}): StalledItem => ({
    kind: "quarantined_mail",
    id: "m1",
    label: "records_request: ADR",
    ageDays: 3,
    detail: "",
    losing: true,
    ...over,
  });

  it("sorts losing items first, then oldest", () => {
    const r = summarize([
      item({ id: "a", losing: false, ageDays: 90 }),
      item({ id: "b", losing: true, ageDays: 1 }),
    ]);
    expect(r.items.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("says plainly when nothing is stalled", () => {
    expect(renderFailedOps(summarize([]))).toMatch(/Nothing stalled/);
  });

  it("explains that the delay itself is the loss", () => {
    expect(renderFailedOps(summarize([item()]))).toMatch(/not merely untidy/);
  });

  it("refuses the DLQ framing, because there is no queue", () => {
    expect(renderFailedOps(summarize([item()]))).toMatch(/not a message-queue DLQ/);
  });

  it("keeps the thresholds nameable", () => {
    expect(OVERDUE_JOB_HOURS).toBeGreaterThan(0);
    expect(STUCK_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe("remediation safety", () => {
  it("REFUSES an UPDATE with no WHERE, with no override", () => {
    // The single most common way production data is destroyed.
    const c = checkStatement("UPDATE claims SET status = 'paid'");
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/touches every row/);
    expect(c.reason).toMatch(/no override/);
  });

  it("REFUSES a DELETE with no WHERE", () => {
    expect(checkStatement("DELETE FROM worklist_items").ok).toBe(false);
  });

  it("accepts a bounded UPDATE and names the table", () => {
    expect(checkStatement("UPDATE claims SET status='paid' WHERE id='C-1'")).toEqual({
      ok: true,
      kind: "update",
      table: "claims",
    });
  });

  it("REFUSES a second statement, because it is the one nobody reviewed", () => {
    const c = checkStatement("UPDATE claims SET status='x' WHERE id='1'; DROP TABLE claims");
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/more than one statement/);
  });

  it("does not mistake a semicolon inside a string literal for a batch", () => {
    expect(checkStatement("UPDATE claims SET status='a;b' WHERE id='1'").ok).toBe(true);
  });

  it("REFUSES DDL, PRAGMA, ATTACH and transaction control", () => {
    for (const sql of [
      "DROP TABLE claims",
      "ALTER TABLE claims ADD COLUMN x TEXT",
      "PRAGMA foreign_keys = OFF",
      "ATTACH DATABASE '/other/tenant.db' AS other",
      "ROLLBACK",
      "RELEASE remediate_preview",
    ]) {
      expect(checkStatement(sql).ok, sql).toBe(false);
    }
  });

  it("REFUSES a SELECT, which changes nothing", () => {
    expect(checkStatement("SELECT * FROM claims").ok).toBe(false);
  });

  it("accepts an INSERT without demanding a WHERE", () => {
    expect(checkStatement("INSERT INTO claims (id) VALUES ('C-2')").kind).toBe("insert");
    expect(checkStatement("INSERT OR REPLACE INTO claims (id) VALUES ('C-2')").kind).toBe("insert");
  });

  it("ignores whitespace but not content when hashing", () => {
    expect(normalizeStatement("UPDATE  a\n SET b=1 WHERE c=2;")).toBe("UPDATE a SET b=1 WHERE c=2");
    expect(previewToken("UPDATE a SET b=1 WHERE c='A'")).toBe(previewToken("UPDATE  a SET b=1  WHERE c='A' "));
    expect(previewToken("UPDATE a SET b=1 WHERE c='A'")).not.toBe(previewToken("UPDATE a SET b=1 WHERE c='B'"));
  });

  it("rejects an apply whose token does not match the statement", () => {
    const sql = "UPDATE claims SET status='paid' WHERE id='C-1'";
    expect(checkApply(sql, previewToken(sql))).toEqual({ ok: true });
    const edited = "UPDATE claims SET status='paid' WHERE id='C-2'";
    const bad = checkApply(edited, previewToken(sql));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/the difference is the point/);
  });

  it("diffs only the columns that actually changed", () => {
    const before = [{ rowid: 1, a: "x", b: "y" }];
    const after = [{ rowid: 1, a: "x", b: "z" }];
    expect(diffRows(before, after, "rowid")).toEqual([{ before: before[0], after: after[0], changed: ["b"] }]);
  });

  it("omits rows the statement did not touch", () => {
    const rows = [{ rowid: 1, a: "x" }];
    expect(diffRows(rows, rows, "rowid")).toEqual([]);
  });

  it("warns when a bulk change was probably meant to be one row", () => {
    const out = renderPreview(
      { ok: true, kind: "update", table: "claims", rowsAffected: 400, diffs: [], notShown: 380, token: "t" },
      "UPDATE claims SET status='x' WHERE 1=1",
    );
    expect(out).toMatch(/is the failure this preview exists to catch/);
    expect(out).toMatch(/The COUNT above is exact/);
  });

  it("says nothing was written, unconditionally", () => {
    const out = renderPreview({ ok: true, kind: "update", table: "claims", rowsAffected: 1, diffs: [], notShown: 0, token: "t" }, "x");
    expect(out).toMatch(/rolled back unconditionally/);
  });
});

describe("remediation against a real database", () => {
  let dir: string;
  let store: MemoryStore;
  let registry: ToolRegistry;
  const ctx = () => ({
    workspaceRoot: dir,
    sessionId: "support:test",
    approvalPolicy: "never" as const,
    requestApproval: async () => true,
    services: { store },
  });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-remediate-"));
    store = new MemoryStore(path.join(dir, "db.sqlite"));
    registry = new ToolRegistry();
    registry.registerAll(SUPPORT_TOOLS);
    const now = Date.now();
    for (const id of ["C-1", "C-2"]) {
      store.db
        .prepare("INSERT INTO claims (id, payer, claim_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(id, "Medicare", JSON.stringify({ claim_id: id, service_lines: [] }), "submitted", now, now);
    }
  });
  afterAll(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const status = (id: string) =>
    (store.db.prepare("SELECT status FROM claims WHERE id = ?").get(id) as { status: string }).status;

  it("PREVIEW WRITES NOTHING", async () => {
    const r = await registry.execute(
      "support_remediate_preview",
      { sql: "UPDATE claims SET status='paid' WHERE id='C-1'" },
      ctx(),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/1 row\(s\) affected/);
    expect(r.content).toMatch(/status: submitted  →  paid/);
    // The whole point.
    expect(status("C-1")).toBe("submitted");
  });

  it("refuses to preview an unbounded statement", async () => {
    const r = await registry.execute("support_remediate_preview", { sql: "UPDATE claims SET status='paid'" }, ctx());
    expect(r.isError).toBe(true);
    expect(status("C-1")).toBe("submitted");
  });

  it("refuses to touch the append-only audit tables", async () => {
    const r = await registry.execute(
      "support_remediate_preview",
      { sql: "UPDATE audit_chain SET summary='x' WHERE seq=1" },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/append-only evidence/);
  });

  it("refuses a table outside the remediable set", async () => {
    const r = await registry.execute("support_remediate_preview", { sql: "UPDATE sessions SET title='x' WHERE id='1'" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not a remediable table/);
  });

  it("will not apply without a matching token", async () => {
    const sql = "UPDATE claims SET status='paid' WHERE id='C-1'";
    const r = await registry.execute("support_remediate_apply", { sql, token: "deadbeef", reason: "testing the gate" }, ctx());
    expect(r.isError).toBe(true);
    expect(status("C-1")).toBe("submitted");
  });

  it("applies with the right token, and records it in the audit chain", async () => {
    const sql = "UPDATE claims SET status='paid' WHERE id='C-1'";
    const r = await registry.execute(
      "support_remediate_apply",
      { sql, token: previewToken(sql), reason: "payer confirmed payment by phone, ref 88213" },
      ctx(),
    );
    expect(r.isError).toBeFalsy();
    expect(status("C-1")).toBe("paid");
    expect(status("C-2")).toBe("submitted");

    const chain = loadChain(store);
    const entry = chain.find((e) => e.kind === "remediation");
    expect(entry).toBeDefined();
    expect(entry?.summary).toMatch(/UPDATE claims: 1 row/);
    expect(entry?.summary).toMatch(/ref 88213/);
    expect(verifyChain(chain).ok).toBe(true);
  });

  it("diagnoses a broken statement instead of leaking the raw error", async () => {
    const r = await registry.execute(
      "support_remediate_preview",
      { sql: "UPDATE claims SET nosuchcolumn='x' WHERE id='C-1'" },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/nothing was written/);
    expect(r.content).toMatch(/SCHEMA MISMATCH/);
  });
});

describe("snapshot bound", () => {
  it("names the bound and keeps the count exact when the diff is skipped", () => {
    // The diff materializes the table twice. Measured at ~130 ms for 20k rows
    // and linear — half a million claims would spike hundreds of MB, during an
    // incident, which is the worst moment to pressure a struggling process.
    const out = renderPreview(
      { ok: true, kind: "update", table: "claims", rowsAffected: 1, diffs: [], notShown: 0, diffSkippedRows: 400_000, token: "abc" },
      "UPDATE claims SET status='paid' WHERE id='C-1'",
    );
    expect(out).toMatch(/row-level diff was skipped/);
    expect(out).toMatch(/400,000 rows/);
    expect(out).toMatch(/count above IS exact/);
    expect(out).toMatch(/token: abc/);
    expect(MAX_SNAPSHOT_ROWS).toBeGreaterThan(DIFF_SAMPLE);
  });
});

describe("tool call log", () => {
  it("reduces input to KEY NAMES, never values", () => {
    // Tool input carries claim data. A log that stored it would become the
    // largest copy of that data in the system, with weaker access control than
    // the tables it copied from.
    const shape = inputShapeOf({ subscriber_id: "TEST-999", diagnoses: ["E11.65"], claim_id: "C-1" });
    expect(shape).toBe("claim_id, diagnoses, subscriber_id");
    expect(shape).not.toMatch(/TEST-999|E11\.65/);
  });

  it("sorts keys so the same call shape groups", () => {
    expect(inputShapeOf({ b: 1, a: 2 })).toBe(inputShapeOf({ a: 2, b: 1 }));
  });

  it("describes non-objects without inspecting them", () => {
    expect(inputShapeOf(null)).toBe("");
    expect(inputShapeOf([1, 2, 3])).toBe("[3]");
    expect(inputShapeOf("secret")).toBe("string");
  });

  it("SCRUBS error text rather than refusing it", () => {
    // Opposite of the PHI access log next door, and deliberately: there a caller
    // passing an identifier has a bug worth surfacing; here the string came from
    // a library and refusing would throw away the diagnosis.
    const scrubbed = scrubErrorText("Invalid input: expected NPI, received 123-45-6789 for jane@example.com");
    expect(scrubbed).toMatch(/\[redacted:SSN\]/);
    expect(scrubbed).toMatch(/\[redacted:email\]/);
    expect(scrubbed).not.toMatch(/123-45-6789|jane@example/);
    // The diagnosis survives.
    expect(scrubbed).toMatch(/Invalid input: expected NPI/);
  });

  it("labels the redaction rather than leaving a hole", () => {
    // A silent gap reads as a truncation bug.
    expect(scrubErrorText("dob 1950-01-01")).toBe("dob [redacted:date]");
  });

  it("caps error text", () => {
    expect(scrubErrorText("x".repeat(MAX_ERROR_TEXT + 500))).toMatch(/…\[truncated\]$/);
  });

  it("derives the outcome from the registry's own error shapes", () => {
    expect(outcomeOf("anything", false)).toBe("ok");
    expect(outcomeOf("Unknown tool: search\nClosest…", true)).toBe("unknown_tool");
    expect(outcomeOf("Invalid input for claim_scrub: …", true)).toBe("invalid_input");
    expect(outcomeOf("User denied permission to run this tool call.", true)).toBe("denied");
    expect(outcomeOf("Tool error: boom", true)).toBe("error");
  });

  it("ranks by failure RATE, not count", () => {
    // 20 failures of 5,000 is healthy; 3 of 3 is broken. Sorting by count puts
    // them in the wrong order.
    const rec = (tool: string, ok: boolean): ToolCallRecord => ({
      sessionId: "s", toolName: tool, ok, outcome: ok ? "ok" : "error",
      durationMs: 1, inputShape: "", errorText: ok ? "" : "boom", depth: 0, at: 1,
    });
    const records = [
      ...Array.from({ length: 4980 }, () => rec("icd10_search", true)),
      ...Array.from({ length: 20 }, () => rec("icd10_search", false)),
      ...Array.from({ length: 3 }, () => rec("claim_build_837p", false)),
    ];
    const s = summarizeCalls(records);
    expect(s.byTool[0].tool).toBe("claim_build_837p");
    expect(s.byTool[0].failureRate).toBe(1);
    expect(renderCallSummary(s, "today")).toMatch(/the busiest tool is not the broken one/);
  });

  it("says an empty window means nothing ran, not that nothing failed", () => {
    expect(renderCallSummary(summarizeCalls([]), "today")).toMatch(/not that nothing failed/);
  });

  it("bounds retention by age AND by row count", () => {
    // A burst inside the retention window outruns the age rule entirely, and the
    // age rule alone would let it fill the disk while every row was recent.
    const plan = retentionPlan(1_000_000_000_000);
    expect(plan.cutoff).toBeLessThan(1_000_000_000_000);
    expect(plan.maxRows).toBeGreaterThan(0);
  });
});

describe("tool call log against a real database", () => {
  let dir: string;
  let store: MemoryStore;
  let registry: ToolRegistry;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-toollog-"));
    store = new MemoryStore(path.join(dir, "db.sqlite"));
    registry = new ToolRegistry();
    registry.registerAll(SUPPORT_TOOLS);
  });
  afterAll(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ctx = () => ({
    workspaceRoot: dir,
    sessionId: "s1",
    approvalPolicy: "never" as const,
    requestApproval: async () => true,
    services: { store },
    onToolCall: (r: ToolCallRecord) => store.recordToolCall(r),
  });

  it("records a call at the choke point, whatever the outcome", async () => {
    await registry.execute("support_failed_ops", { limit: 5 }, ctx());
    await registry.execute("nosuchtool", {}, ctx());
    await registry.execute("support_remediate_preview", { sql: "UPDATE claims SET a=1" }, ctx());

    const calls = store.loadToolCalls(0);
    expect(calls).toHaveLength(3);
    const byTool = Object.fromEntries(calls.map((c) => [c.toolName, c]));
    expect(byTool.support_failed_ops.ok).toBe(true);
    expect(byTool.nosuchtool.outcome).toBe("unknown_tool");
    expect(byTool.support_remediate_preview.ok).toBe(false);
  });

  it("stores the input shape and no values", async () => {
    await registry.execute("support_trace_claim", { claim_id: "PCN-SECRET-9" }, ctx());
    const call = store.loadToolCalls(0).find((c) => c.toolName === "support_trace_claim");
    expect(call?.inputShape).toBe("claim_id");
    expect(JSON.stringify(call)).not.toMatch(/PCN-SECRET-9/);
  });

  it("filters to failures and to one tool", () => {
    expect(store.loadToolCalls(0, { failuresOnly: true }).every((c) => !c.ok)).toBe(true);
    expect(store.loadToolCalls(0, { tool: "nosuchtool" })).toHaveLength(1);
  });

  it("a broken logger does not take down the tool call", async () => {
    const result = await registry.execute("support_failed_ops", { limit: 5 }, {
      ...ctx(),
      onToolCall: () => {
        throw new Error("log is on fire");
      },
    });
    expect(result.isError).toBeFalsy();
  });

  it("prunes by age and then by ceiling", () => {
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      store.recordToolCall({
        sessionId: "s", toolName: "old_tool", ok: true, outcome: "ok",
        durationMs: 1, inputShape: "", errorText: "", depth: 0, at: now - 90 * 86_400_000,
      });
    }
    const removedByAge = store.pruneToolCalls(retentionPlan(now));
    expect(removedByAge).toBeGreaterThanOrEqual(50);
    expect(store.loadToolCalls(0, { tool: "old_tool" })).toHaveLength(0);

    // Ceiling, independent of age.
    for (let i = 0; i < 30; i++) {
      store.recordToolCall({
        sessionId: "s", toolName: "burst", ok: true, outcome: "ok",
        durationMs: 1, inputShape: "", errorText: "", depth: 0, at: now,
      });
    }
    store.pruneToolCalls({ cutoff: 0, maxRows: 5 });
    expect(store.loadToolCalls(0).length).toBe(5);
  });

  it("FMEA reads the log without anyone pasting errors into it", async () => {
    store.recordToolCall({
      sessionId: "s", toolName: "reimbursement_estimate", ok: false, outcome: "error",
      durationMs: 12, inputShape: "code, units", errorText: "Tool error: connect ECONNREFUSED 127.0.0.1:11434", depth: 0, at: Date.now(),
    });
    const r = await registry.execute("support_fmea_diagnose", {}, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/tool call\(s\) in the last 24h/);
    expect(r.content).toMatch(/network/);
  });

  it("still classifies text passed in directly", async () => {
    const r = await registry.execute("support_fmea_diagnose", { failures: ["HTTP 429 Too Many Requests"] }, ctx());
    expect(r.content).toMatch(/RATE LIMIT/);
  });
});

describe("nested calls through the catalogue", () => {
  const rec = (tool: string, ok: boolean, depth: number): ToolCallRecord => ({
    sessionId: "s", toolName: tool, ok, outcome: ok ? "ok" : "error",
    durationMs: 1, inputShape: "", errorText: ok ? "" : "boom", depth, at: 1,
  });

  it("does not blame the router for the tool it routed to", () => {
    // tool_invoke returns the inner result unchanged, so one logical failure
    // produces two failing rows. Counting both puts the router at the top of
    // the list every time discovery is used, and the engineer reads the router.
    const s = summarizeCalls([rec("reimbursement_estimate", false, 1), rec("tool_invoke", false, 0)]);
    expect(s.byTool.map((t) => t.tool)).toEqual(["reimbursement_estimate"]);
    expect(s.failures).toBe(1);
  });

  it("still counts a wrapper's successful calls, for latency", () => {
    const s = summarizeCalls([rec("tool_invoke", true, 0), rec("tool_invoke", true, 0)]);
    expect(s.slowest.some((x) => x.tool === "tool_invoke")).toBe(true);
  });

  it("keeps the headline count and the per-tool table in agreement", () => {
    const s = summarizeCalls([rec("a", false, 0), rec("tool_invoke", false, 0), rec("a", false, 1)]);
    expect(s.failures).toBe(s.byTool.reduce((n, t) => n + t.failures, 0));
  });

  it("records the depth through a real tool_invoke", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-depth-"));
    const store = new MemoryStore(path.join(dir, "db.sqlite"));
    const reg = new ToolRegistry();
    reg.registerAll([...META_TOOLS, ...SUPPORT_TOOLS]);
    const ctx = {
      workspaceRoot: dir, sessionId: "s", approvalPolicy: "never" as const,
      requestApproval: async () => true, services: { store, registry: reg },
      onToolCall: (r: ToolCallRecord) => store.recordToolCall(r),
    };
    try {
      await reg.execute("tool_invoke", { name: "support_failed_ops", input: { limit: 5 } }, ctx);
      const rows = store.loadToolCalls(0);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.toolName === "tool_invoke")?.depth).toBe(0);
      expect(rows.find((r) => r.toolName === "support_failed_ops")?.depth).toBe(1);
      // Depth is restored, so a later direct call is not mislabelled as nested.
      await reg.execute("support_failed_ops", { limit: 5 }, ctx);
      expect(store.loadToolCalls(0).filter((r) => r.toolName === "support_failed_ops" && r.depth === 0)).toHaveLength(1);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("diagnosing from the log's own outcome", () => {
  it("uses the recorded outcome instead of re-deriving it from prose", () => {
    // Found by running it end to end: an unknown-tool failure came back
    // UNCLASSIFIED because the classifier was fed the error TEXT, while the row
    // right next to it already said outcome=unknown_tool. That threw away a fact
    // for a guess, and the guess was worse.
    const d = diagnoseRecord({
      toolName: "nosuchtool",
      outcome: "unknown_tool",
      errorText: "Unknown tool: nosuchtool\nClosest available tools: …",
    });
    expect(d.category).toBe("schema_mismatch");
    expect(d.confidence).toBe("certain");
    expect(d.cause).toMatch(/does not exist/);
  });

  it("names a schema rejection as certain, not a guess", () => {
    const d = diagnoseRecord({ toolName: "claim_scrub", outcome: "invalid_input", errorText: "Invalid input for claim_scrub" });
    expect(d.confidence).toBe("certain");
    expect(d.nextSteps.join(" ")).toMatch(/wrong input SHAPE repeating is the signal/);
  });

  it("does not call a human declining an approval a fault", () => {
    const d = diagnoseRecord({ toolName: "run_command", outcome: "denied", errorText: "User denied permission" });
    expect(d.cause).toMatch(/human denied/);
    expect(d.nextSteps.join(" ")).toMatch(/Not a fault/);
  });

  it("still falls through to the text rules for a genuine execution error", () => {
    const d = diagnoseRecord({ toolName: "web_fetch", outcome: "error", errorText: "Tool error: connect ECONNREFUSED" });
    expect(d.category).toBe("network");
  });

  it("groups records the same way it groups text", () => {
    const b = diagnoseRecords([
      { toolName: "a", outcome: "unknown_tool", errorText: "" },
      { toolName: "b", outcome: "error", errorText: "ECONNREFUSED" },
    ]);
    expect(b.total).toBe(2);
    expect(b.byCategory.map((c) => c.category).sort()).toEqual(["network", "schema_mismatch"]);
  });
});
