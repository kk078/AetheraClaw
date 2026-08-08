import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildClaimScrubView,
  buildEmMeter,
  buildKpiTiles,
  buildVarianceWaterfall,
  lineNumberOf,
} from "../src/views/build.js";
import { autohealClaim } from "../src/tools/healthcare/autoheal.js";
import { scrubClaim } from "../src/tools/healthcare/claim-scrub.js";
import { assessEmLevel } from "../src/tools/healthcare/presubmit.js";
import { computeExecutiveKpis } from "../src/reports/kpi.js";
import { MemoryStore } from "../src/memory/store.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";
import type { ScrubFinding } from "../src/tools/healthcare/finding.js";
import type { VarianceFinding } from "../src/tools/healthcare/intelligence/variance.js";

const claim = (over: Partial<ClaimInput> = {}): ClaimInput => ({
  claim_id: "C-1",
  payer_name: "Medicare",
  payer_id: "MCR",
  billing_provider_npi: "1234567893",
  billing_provider_name: "Clinic",
  subscriber_id: "S1",
  patient_last: "T",
  patient_first: "P",
  patient_dob: "19700101",
  patient_sex: "U",
  diagnoses: ["E11.9"],
  service_lines: [
    { cpt_hcpcs: "99214", charge: 200, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
    { cpt_hcpcs: "93000", charge: 50, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "22" },
  ],
  ...over,
});

describe("claim scrub view", () => {
  it("recovers the line number a finding names", () => {
    expect(lineNumberOf("Line 2 (99214) has no diagnosis pointers")).toBe(2);
    expect(lineNumberOf("line 10: something")).toBe(10);
    expect(lineNumberOf("Claim has no billing provider")).toBeUndefined();
  });

  it("puts a finding with no recoverable line at the CLAIM level, not on line 1", () => {
    // Attaching it to the wrong line is worse than showing it above the table.
    const findings: ScrubFinding[] = [{ severity: "error", rule: "npi-invalid", message: "Billing NPI fails Luhn" }];
    const v = buildClaimScrubView(claim(), findings);
    expect(v.claimFindings).toHaveLength(1);
    expect(v.lines[0].findings).toHaveLength(0);
    expect(v.lines[0].severity).toBe("clean");
  });

  it("escalates a line to its worst finding", () => {
    const findings: ScrubFinding[] = [
      { severity: "warning", rule: "modifier-25", message: "Line 1: modifier 25 on non-E/M" },
      { severity: "error", rule: "dx-pointer-missing", message: "Line 1 (99214) has no diagnosis pointers" },
    ];
    const v = buildClaimScrubView(claim(), findings);
    expect(v.lines[0].severity).toBe("error");
    expect(v.lines[0].findings).toHaveLength(2);
    expect(v.counts.error).toBe(1);
    expect(v.counts.clean).toBe(1);
  });

  it("drops the engine's 'clean' marker rather than rendering it as a finding", () => {
    const v = buildClaimScrubView(claim(), [{ severity: "info", rule: "clean", message: "No scrub findings" }]);
    expect(v.claimFindings).toHaveLength(0);
    expect(v.lines.every((l) => l.findings.length === 0)).toBe(true);
  });

  it("resolves the place of service NAME, which is the fact models get wrong", () => {
    const v = buildClaimScrubView(claim(), []);
    expect(v.lines[0].posName).toBe("Office");
    expect(v.lines[1].posName).toBe("On Campus-Outpatient Hospital");
  });

  it("names an unassigned POS instead of leaving it blank", () => {
    const c = claim();
    c.service_lines[0].place_of_service = "38";
    expect(buildClaimScrubView(c, []).lines[0].posName).toBe("unassigned code");
  });

  it("offers a fix ONLY for repairs that invent nothing", () => {
    // A date reformat writes down what the claim already said → button.
    const c = claim();
    c.service_lines[0].service_date = "2026-01-15";
    const v = buildClaimScrubView(c, [], { autoheal: autohealClaim(c) });
    const fixes = v.lines[0].findings.filter((f) => f.fix);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].fix).toEqual({ from: "2026-01-15", to: "20260115", describe: expect.any(String) });
  });

  it("renders a telehealth mismatch as a QUESTION with no fix attached", () => {
    // A one-click "accept" here would put a false statement on a Medicare claim.
    const c = claim();
    c.service_lines[0].modifiers = ["95"];
    const v = buildClaimScrubView(c, [], { autoheal: autohealClaim(c) });
    const mismatch = v.lines[0].findings.find((f) => f.rule === "telehealth-mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.fix).toBeUndefined();
    expect(mismatch?.question).toMatch(/false statement on a Medicare claim/);
  });

  it("carries blind spots and the verdict without folding them together", () => {
    const v = buildClaimScrubView(claim(), [], { blindSpots: ["NCCI not installed"], verdict: "clear" });
    expect(v.verdict).toBe("clear");
    expect(v.blindSpots).toEqual(["NCCI not installed"]);
  });

  it("totals charges by units, not by line count", () => {
    const c = claim();
    c.service_lines[0].units = 3;
    expect(buildClaimScrubView(c, []).totalCharge).toBe(650);
  });
});

describe("money waterfall", () => {
  const finding = (over: Partial<VarianceFinding> = {}): VarianceFinding => ({
    severity: "error",
    basis: "contract",
    payer: "Aetna",
    claimId: "C1",
    code: "99214",
    expectedPerUnit: 128.5,
    actualPerUnit: 110,
    units: 2,
    shortfall: 37,
    pctBelow: 14.4,
    message: "",
    ...over,
  });

  it("names the reclaimable total", () => {
    const v = buildVarianceWaterfall([finding()], { basis: "contract", linesExamined: 40 });
    expect(v.reclaimable).toBe(37);
    expect(v.steps.map((s) => s.kind)).toEqual(["start", "reduction", "end"]);
  });

  it("returns null rather than 0 when nothing was found", () => {
    // Zero reads as "we checked and you are owed nothing"; null reads as
    // "nothing surfaced", which is what actually happened.
    const v = buildVarianceWaterfall([], { basis: "payer_history", linesExamined: 40 });
    expect(v.reclaimable).toBeNull();
  });

  it("warns that a Medicare basis is not a recovery claim against a commercial payer", () => {
    const v = buildVarianceWaterfall([finding()], { basis: "fee_schedule", linesExamined: 5 });
    expect(v.caveat).toMatch(/NOT a recovery claim/);
  });

  it("says a payer-history basis describes habit, not obligation", () => {
    const v = buildVarianceWaterfall([finding()], { basis: "payer_history", linesExamined: 5 });
    expect(v.caveat).toMatch(/habit, not its obligation/);
  });

  it("calls a contract basis a contractual claim", () => {
    expect(buildVarianceWaterfall([finding()], { basis: "contract", linesExamined: 5 }).caveat).toMatch(/contractual claim/);
  });
});

describe("E/M meter", () => {
  const mdm = {
    patient_type: "established" as const,
    problems: { minor_problems: 0, stable_chronic: 0, exacerbated_chronic: 1, acute_uncomplicated: 0, acute_complicated_or_systemic: 0, threat_to_life: false },
    data: { tests_reviewed: 2, tests_ordered: 1, external_notes: 0, independent_historian: false, independent_interpretation: false, discussed_with_external: false },
    risk: "moderate" as const,
  };

  it("picks the established ladder for an established code", () => {
    const risk = assessEmLevel("99215", mdm);
    if ("error" in risk) throw new Error(risk.error);
    expect(buildEmMeter(risk, []).ladder).toEqual(["99212", "99213", "99214", "99215"]);
  });

  it("picks the new-patient ladder for a new-patient code", () => {
    const risk = assessEmLevel("99205", { ...mdm, patient_type: "new" });
    if ("error" in risk) throw new Error(risk.error);
    expect(buildEmMeter(risk, []).ladder).toEqual(["99202", "99203", "99204", "99205"]);
  });

  it("carries both positions so the UI can show them side by side", () => {
    const risk = assessEmLevel("99215", mdm);
    if ("error" in risk) throw new Error(risk.error);
    const m = buildEmMeter(risk, [{ label: "Risk", level: "moderate" }]);
    expect(m.billedCode).toBe("99215");
    expect(m.supportedCode).toBe("99214");
    expect(m.direction).toBe("above_documentation");
    expect(m.elements).toHaveLength(1);
  });
});

describe("KPI tiles", () => {
  it("renders an uncomputable metric as null, never as zero", () => {
    // Zero reads as a measurement. Every one of these refuses rather than guessing.
    const tiles = buildKpiTiles(computeExecutiveKpis([], [], [], Date.now())).tiles;
    expect(tiles.every((t) => t.value === null)).toBe(true);
    expect(tiles.every((t) => t.fraction === undefined)).toBe(true);
  });

  it("keeps the two clean-claim rates as separate tiles", () => {
    const labels = buildKpiTiles(computeExecutiveKpis([], [], [], Date.now())).tiles.map((t) => t.label);
    expect(labels).toContain("First-pass acceptance");
    expect(labels).toContain("First-pass payment");
  });
});

describe("views are stored outside the model's context", () => {
  let dir: string;
  let store: MemoryStore;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-views-"));
    store = new MemoryStore(path.join(dir, "db.sqlite"));
  });
  afterAll(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a view by tool_use_id", () => {
    const s = store.createSession("t");
    store.saveToolView(s.id, "tu_1", { kind: "claim_scrub", data: { claimId: "C-1" } });
    expect(store.loadToolViews(s.id)).toEqual({ tu_1: { kind: "claim_scrub", data: { claimId: "C-1" } } });
  });

  it("keeps view payloads OUT of the message rows the runner replays", () => {
    // This is the whole economic argument: runner.ts rebuilds provider context
    // from messages.content_json, so anything stored there is re-sent every
    // turn. A rendered claim form would silently double the cost of every tool
    // call that draws something.
    const s = store.createSession("t2");
    store.saveToolView(s.id, "tu_2", { kind: "claim_scrub", data: { secret: "LARGE_PAYLOAD" } });
    store.appendMessage(s.id, "user", [{ type: "tool_result", toolUseId: "tu_2", content: "text only" }]);

    const raw = store.db
      .prepare("SELECT content_json FROM messages WHERE session_id = ?")
      .all(s.id) as Array<{ content_json: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].content_json).not.toContain("LARGE_PAYLOAD");
    expect(raw[0].content_json).toContain("text only");
  });

  it("keeps one session's views out of another's", () => {
    const a = store.createSession("a");
    const b = store.createSession("b");
    store.saveToolView(a.id, "tu_x", { kind: "kpi_tiles", data: {} });
    expect(Object.keys(store.loadToolViews(b.id))).toEqual([]);
  });

  it("survives a malformed row without losing the rest", () => {
    const s = store.createSession("c");
    store.saveToolView(s.id, "ok", { kind: "kpi_tiles", data: { a: 1 } });
    store.db
      .prepare("INSERT INTO tool_views (session_id, tool_use_id, kind, data_json, created_at) VALUES (?,?,?,?,?)")
      .run(s.id, "bad", "kpi_tiles", "{not json", 1);
    const views = store.loadToolViews(s.id);
    expect(Object.keys(views)).toEqual(["ok"]);
  });

  it("replaces rather than duplicating on a re-run of the same tool call", () => {
    const s = store.createSession("d");
    store.saveToolView(s.id, "tu_r", { kind: "kpi_tiles", data: { v: 1 } });
    store.saveToolView(s.id, "tu_r", { kind: "kpi_tiles", data: { v: 2 } });
    expect(store.loadToolViews(s.id).tu_r.data).toEqual({ v: 2 });
  });
});

describe("finding duplication", () => {
  it("collapses an identical finding repeated by a per-date check", () => {
    // Caught by looking at a rendered screenshot: NCCI edits run once per
    // distinct service date, and the "data not installed" notice was inside
    // that loop, so a claim spanning three dates showed it three times.
    const dup: ScrubFinding = { severity: "info", rule: "ncci-data", message: "NCCI/MUE data not installed" };
    const v = buildClaimScrubView(claim(), [dup, dup, dup]);
    expect(v.claimFindings).toHaveLength(1);
  });

  it("keeps same-rule findings that say different things", () => {
    const v = buildClaimScrubView(claim(), [
      { severity: "error", rule: "dx-pointer-range", message: "Line 1 points to diagnosis 4" },
      { severity: "error", rule: "dx-pointer-range", message: "Line 2 points to diagnosis 7" },
    ]);
    expect(v.lines[0].findings).toHaveLength(1);
    expect(v.lines[1].findings).toHaveLength(1);
  });

  it("emits the NCCI data notice once for a multi-date claim", () => {
    const c = claim();
    c.service_lines = [
      { cpt_hcpcs: "99214", charge: 200, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      { cpt_hcpcs: "93000", charge: 50, units: 1, dx_pointers: [1], service_date: "20260116", place_of_service: "11" },
      { cpt_hcpcs: "36415", charge: 18, units: 1, dx_pointers: [1], service_date: "20260117", place_of_service: "11" },
    ];
    const findings = scrubClaim(c, { telehealthPolicyWasStored: false, policyRules: [] });
    expect(findings.filter((f) => f.rule === "ncci-data")).toHaveLength(1);
  });
});
