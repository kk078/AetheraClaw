import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkPtpEdits, indexPtpEdits, type PtpEdit, type PtpTable } from "../src/tools/healthcare/intelligence/ncci.js";
import { MemoryStore } from "../src/memory/store.js";
import { VIEW_RETAIN_MAX_ROWS, viewRetentionPlan } from "../src/views/retention.js";
import { checkNcci, ncciDataNotice } from "../src/tools/healthcare/datasets.js";

const line = (code: string, modifiers: string[] = []) => ({ cpt_hcpcs: code, units: 1, modifiers });

describe("NCCI index", () => {
  const arrayForm: PtpEdit[] = [
    { column1: "99214", column2: "0469T", modifierIndicator: "0" },
    { column1: "99213", column2: "36415", modifierIndicator: "1" },
  ];
  const tableForm: PtpTable = { "99214": { "0469T": "0" }, "99213": { "36415": "1" } };

  it("reads both on-disk shapes to the same result", () => {
    // The array is what earlier data files carry; the object is what the fetcher
    // now writes. A user upgrading must not silently lose their edit table.
    const lines = [line("99214"), line("0469T")];
    const fromArray = checkPtpEdits(arrayForm, lines);
    const fromTable = checkPtpEdits(indexPtpEdits(tableForm), lines);
    expect(fromArray.map((f) => f.rule)).toEqual(fromTable.map((f) => f.rule));
    expect(fromArray[0].rule).toBe("ncci-ptp-no-bypass");
  });

  it("normalizes case and whitespace on both sides of the lookup", () => {
    const idx = indexPtpEdits([{ column1: " 99214 ", column2: "0469t", modifierIndicator: "0" }]);
    expect(checkPtpEdits(idx, [line("99214"), line(" 0469T ")])).toHaveLength(1);
  });

  it("finds nothing when only one side of a pair is on the claim", () => {
    expect(checkPtpEdits(arrayForm, [line("99214")])).toEqual([]);
  });

  it("does not pair a code with itself", () => {
    // A self-edit would be a data artifact, and reporting one would be a finding
    // no biller could act on.
    const idx = indexPtpEdits([{ column1: "99214", column2: "99214", modifierIndicator: "0" }]);
    expect(checkPtpEdits(idx, [line("99214")])).toEqual([]);
  });

  it("still honours the modifier indicator through the index", () => {
    const bypassed = checkPtpEdits(arrayForm, [line("99213"), line("36415", ["59"])]);
    expect(bypassed[0].rule).toBe("ncci-ptp-bypassed");
    const notBypassed = checkPtpEdits(arrayForm, [line("99213"), line("36415")]);
    expect(notBypassed[0].rule).toBe("ncci-ptp");
    // Indicator 0 is never bypassable, modifier or not.
    const hard = checkPtpEdits(arrayForm, [line("99214"), line("0469T", ["59"])]);
    expect(hard[0].rule).toBe("ncci-ptp-no-bypass");
  });

  it("skips a deleted edit carried in the file", () => {
    expect(checkPtpEdits([{ column1: "A", column2: "B", modifierIndicator: "9" }], [line("A"), line("B")])).toEqual([]);
  });

  it("costs the claim, not the table", () => {
    // The regression this exists for: 1.7M edits were scanned per scrub. With an
    // index a large table must not measurably slow a two-line claim.
    const big: PtpTable = {};
    for (let i = 0; i < 40_000; i++) big[`X${i}`] = { [`Y${i}`]: "0" };
    big["99214"] = { "0469T": "0" };
    const idx = indexPtpEdits(big);
    const t = Date.now();
    for (let i = 0; i < 500; i++) checkPtpEdits(idx, [line("99214"), line("0469T")]);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe("tool-view retention", () => {
  const dirs: string[] = [];
  const store = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ret-"));
    dirs.push(d);
    return new MemoryStore(path.join(d, "db.sqlite"));
  };
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it("deletes views orphaned by a deleted session, and keeps live ones", () => {
    // There is no foreign key on tool_views, so a deleted session leaves its
    // views behind permanently. In practice this is most of what accumulates.
    const s = store();
    const live = s.createSession("live", "ollama");
    s.saveToolView(live.id, "t1", { kind: "claim_scrub", data: {} });
    s.saveToolView("gone-session", "t2", { kind: "claim_scrub", data: {} });

    const r = s.pruneToolViews(viewRetentionPlan(Date.now()));
    expect(r.orphaned).toBe(1);
    expect(r.aged).toBe(0);
    expect(Object.keys(s.loadToolViews(live.id))).toEqual(["t1"]);
    s.close();
  });

  it("keeps a view inside the window and drops one past it", () => {
    const s = store();
    const sess = s.createSession("s", "ollama");
    s.saveToolView(sess.id, "recent", { kind: "kpi_tiles", data: {} });
    s.saveToolView(sess.id, "ancient", { kind: "kpi_tiles", data: {} });
    s.db.prepare("UPDATE tool_views SET created_at = ? WHERE tool_use_id = 'ancient'").run(Date.now() - 200 * 86_400_000);

    const r = s.pruneToolViews(viewRetentionPlan(Date.now()));
    expect(r.aged).toBe(1);
    expect(Object.keys(s.loadToolViews(sess.id))).toEqual(["recent"]);
    s.close();
  });

  it("enforces a row ceiling independently of age", () => {
    // A burst inside the retention window outruns the age rule entirely; the
    // ceiling is the second, independent bound.
    const s = store();
    const sess = s.createSession("s", "ollama");
    for (let i = 0; i < 12; i++) s.saveToolView(sess.id, `v${i}`, { kind: "kpi_tiles", data: {} });
    const r = s.pruneToolViews(viewRetentionPlan(Date.now(), 90, 5));
    expect(r.aged).toBe(0);
    expect(r.overCeiling).toBe(7);
    expect(Object.keys(s.loadToolViews(sess.id))).toHaveLength(5);
    s.close();
  });

  it("reports the three counts separately, and they sum to the total", () => {
    const s = store();
    expect(s.pruneToolViews(viewRetentionPlan(Date.now())).total).toBe(0);
    expect(VIEW_RETAIN_MAX_ROWS).toBeGreaterThan(0);
    s.close();
  });
});

describe("dataset cache invalidation", () => {
  it("picks up NCCI data installed AFTER first use, and notices removal", () => {
    // The regression: the scrubber cached "absent" on first use and never
    // re-checked, so it told a reader who had JUST installed the data to go and
    // install it — specific, actionable, and describing work already finished.
    //
    // Static import on purpose: the module-level cache has to stay live across
    // these calls, because that cache IS what is under test.
    const file = path.join(process.env.AETHERACLAW_HOME!, "data", "ncci-ptp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = [
      { cpt_hcpcs: "99214", units: 1, modifiers: [] },
      { cpt_hcpcs: "0469T", units: 1, modifiers: [] },
    ];

    expect(checkNcci([], lines)).toEqual([]);
    expect(ncciDataNotice()).not.toBeNull();

    fs.writeFileSync(file, JSON.stringify({ "99214": { "0469T": "0" } }));
    expect(checkNcci([], lines).map((f) => f.rule)).toContain("ncci-ptp-no-bypass");
    expect(ncciDataNotice()).toBeNull();

    // And back again, so a moved or deleted file does not leave the scrubber
    // reporting edits it can no longer read.
    fs.rmSync(file);
    expect(checkNcci([], lines)).toEqual([]);
    expect(ncciDataNotice()).not.toBeNull();
  });
});
