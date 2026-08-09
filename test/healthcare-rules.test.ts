import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkMueEdits, checkPtpEdits } from "../src/tools/healthcare/intelligence/ncci.js";
import { earlierInCalendarYear, monthDay, determineCobOrder } from "../src/tools/healthcare/cob.js";
import { lookupRole, searchRole } from "../src/tools/healthcare/reference-routes.js";
import { openDatabase } from "../src/memory/sqlite.js";

describe("NCCI MUE — date-of-service edits sum across lines", () => {
  it("catches an MAI-2 limit split across two lines", () => {
    const rules = checkMueEdits({ J1885: { units: 4, mai: "2" } }, [
      { cpt_hcpcs: "J1885", units: 3 },
      { cpt_hcpcs: "J1885", units: 3 },
    ]);
    expect(rules.map((f) => f.rule)).toContain("mue-absolute");
  });
  it("still catches the same overage on one line", () => {
    expect(checkMueEdits({ J1885: { units: 4, mai: "2" } }, [{ cpt_hcpcs: "J1885", units: 6 }]).map((f) => f.rule)).toContain("mue-absolute");
  });
  it("does NOT sum an MAI-1 line edit — separate lines are legitimate", () => {
    const rules = checkMueEdits({ J1885: { units: 4, mai: "1" } }, [
      { cpt_hcpcs: "J1885", units: 3 },
      { cpt_hcpcs: "J1885", units: 3 },
    ]);
    expect(rules).toHaveLength(0);
  });
});

describe("NCCI PTP — split lines and the full bypass-modifier set", () => {
  it("emits one finding for a repeated code and sees a modifier on any of its lines", () => {
    const out = checkPtpEdits([{ column1: "11042", column2: "97597", modifierIndicator: "1" }], [
      { cpt_hcpcs: "11042", units: 1 },
      { cpt_hcpcs: "97597", units: 1 },
      { cpt_hcpcs: "97597", units: 1, modifiers: ["XU"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe("ncci-ptp-bypassed");
  });
  it("treats an E/M modifier 25 as a legitimate bypass, not a false error", () => {
    const out = checkPtpEdits([{ column1: "11042", column2: "99213", modifierIndicator: "1" }], [
      { cpt_hcpcs: "11042", units: 1 },
      { cpt_hcpcs: "99213", units: 1, modifiers: ["25"] },
    ]);
    expect(out.map((f) => f.rule)).toEqual(["ncci-ptp-bypassed"]);
  });
});

describe("COB birthday rule — numeric month/day", () => {
  it("orders July before November regardless of digit-string length", () => {
    expect(earlierInCalendarYear("7/4", "11/22")).toBe("a");
    expect(earlierInCalendarYear("11/22", "7/4")).toBe("b");
  });
  it("parses contiguous and dated forms", () => {
    expect(monthDay("0704")).toEqual({ month: 7, day: 4 });
    expect(monthDay("07/04/1980")).toEqual({ month: 7, day: 4 });
    expect(monthDay("garbage")).toBeNull();
  });
  it("names the July parent primary, without a spurious warning", () => {
    const det = determineCobOrder({
      medicareEntitled: false,
      patientIsDependentChild: true,
      parentABirthdayMmdd: "7/4",
      parentBBirthdayMmdd: "11/22",
    });
    expect(det.order[0].payer).toBe("Parent A's plan");
    expect(det.warnings).toHaveLength(0);
  });
  it("warns rather than silently guessing when a birthday is unparseable", () => {
    const det = determineCobOrder({
      medicareEntitled: false,
      patientIsDependentChild: true,
      parentABirthdayMmdd: "not-a-date",
      parentBBirthdayMmdd: "11/22",
    });
    expect(det.warnings.some((w) => /could not read/i.test(w))).toBe(true);
  });
});

describe("reference routes — column casing", () => {
  let home: string;
  let dbf: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-ref-"));
    dbf = path.join(home, "ref.db");
    const db = openDatabase(dbf);
    db.exec("CREATE TABLE ref_carc (CODE TEXT, DESCRIPTION TEXT)");
    db.prepare("INSERT INTO ref_carc VALUES (?, ?)").run("253", "Sequestration - reduction in federal payment");
    db.close();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("reads rows from a table whose columns are upper-case when the spec is lower-case", () => {
    const hit = lookupRole({ referenceDbPath: dbf }, "carc", "253");
    expect(hit?.description).toBe("Sequestration - reduction in federal payment");
    expect(searchRole({ referenceDbPath: dbf }, "carc", "Sequestration")).toHaveLength(1);
  });
});
