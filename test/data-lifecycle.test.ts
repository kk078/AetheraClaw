import { describe, expect, it } from "vitest";
import {
  PROFILE_DATA_NEEDS,
  assessDataset,
  assessReadiness,
  fiscalYearToEffective,
  renderReadiness,
  renderStartupWarning,
  type DatasetProbe,
} from "../src/tools/healthcare/data-lifecycle.js";
import type { DatasetStatus } from "../src/tools/healthcare/datasets.js";

// Every assertion here fixes `asOf` to a literal date. Nothing in the module
// under test reads a clock, which is what makes "is this quarter's NCCI file
// stale" a question a test can ask in March and again in November and get the
// same answer.

function status(file: string, installed: boolean): DatasetStatus {
  return {
    file,
    purpose: "purpose",
    installed,
    source: "CMS",
    absentMeans: "The check does not run.",
  };
}

function probe(file: string, over: Partial<DatasetProbe> = {}): DatasetProbe {
  return {
    status: status(file, true),
    installedOn: "20260210",
    declaredEffective: "",
    ...over,
  };
}

describe("assessDataset", () => {
  it("reports a missing file as missing, with what stops working", () => {
    const l = assessDataset({ ...probe("mue.json"), status: status("mue.json", false), installedOn: "" }, "20260210");
    expect(l.verdict).toBe("missing");
    expect(l.message).toContain("The check does not run.");
  });

  it("believes an edition the file declares, over the filesystem", () => {
    // Downloaded this morning, but the table says FY2025 — which expired last
    // October. The file wins: mtime is when it arrived, not what is in it.
    const l = assessDataset(
      probe("icd10.json", { installedOn: "20260210", declaredEffective: fiscalYearToEffective(2025) }),
      "20260210",
    );
    expect(l.verdict).toBe("stale");
    expect(l.missedReleases).toBeGreaterThan(0);
  });

  it("reports a current declared edition as current", () => {
    // FY2026 took effect 1 October 2025 and is the edition in force in February.
    const l = assessDataset(
      probe("icd10.json", { declaredEffective: fiscalYearToEffective(2026) }),
      "20260210",
    );
    expect(l.verdict).toBe("current");
    expect(l.missedReleases).toBe(0);
  });

  it("gets the fiscal-year conversion the right way round", () => {
    // Backwards, every current table would report as a year stale — and the
    // warning that fires on a correct install is the one people disable.
    expect(fiscalYearToEffective(2026)).toBe("20251001");
  });

  it("calls an undated file downloaded BEFORE the current release provably stale", () => {
    // NCCI publishes on 1 January. A file that landed in December cannot hold
    // the January edits. This is the one sound inference mtime supports.
    const l = assessDataset(probe("ncci-ptp.json", { installedOn: "20251215" }), "20260210");
    expect(l.verdict).toBe("stale");
    expect(l.message).toContain("cannot contain");
  });

  it("does NOT call an undated file current just because it arrived recently", () => {
    // The load-bearing assertion of the whole module. A file copied from a
    // colleague's laptop this morning can hold last quarter's data, and
    // reporting it as current would turn not knowing into a statement of safety.
    const l = assessDataset(probe("ncci-ptp.json", { installedOn: "20260210" }), "20260210");
    expect(l.verdict).toBe("unknown-edition");
    expect(l.verdict).not.toBe("current");
    expect(l.message).toContain("NOT the same");
  });

  it("says nothing about cadence for a file no release governs", () => {
    const l = assessDataset(probe("cpt.csv"), "20260210");
    expect(l.codeSet).toBeNull();
    expect(l.verdict).toBe("unknown-edition");
  });
});

describe("assessReadiness", () => {
  const asOf = "20260210";
  const lifecycles = (files: Array<[string, boolean, string?]>) =>
    files.map(([file, installed, installedOn]) =>
      assessDataset(
        { status: status(file, installed), installedOn: installed ? (installedOn ?? asOf) : "", declaredEffective: "" },
        asOf,
      ),
    );

  it("warns when a file the profile REQUIRES is absent", () => {
    const r = assessReadiness(lifecycles([["ncci-ptp.json", false], ["mue.json", true]]), "claims");
    expect(r.warn).toBe(true);
    expect(r.missingRequired.map((l) => l.file)).toContain("ncci-ptp.json");
    expect(r.because).toContain("no bundling edit found");
  });

  it("does not warn about a file the profile only finds useful", () => {
    // gpci.json is optional on revenue. Warning about optional data trains
    // people to ignore the banner, which costs the required warnings too.
    const r = assessReadiness(lifecycles([["mpfs.json", true], ["mpfs-cf.json", true], ["gpci.json", false]]), "revenue");
    expect(r.warn).toBe(false);
  });

  it("warns about an installed file that has provably fallen behind", () => {
    const r = assessReadiness(lifecycles([["ncci-ptp.json", true, "20251215"]]), "denials");
    expect(r.warn).toBe(true);
    expect(r.stale).toHaveLength(1);
  });

  it("does NOT warn about undated files, which is the normal state of a correct install", () => {
    const r = assessReadiness(lifecycles([["ncci-ptp.json", true, "20260210"]]), "denials");
    expect(r.unknownEdition).toHaveLength(1);
    expect(r.warn).toBe(false);
  });

  it("requires nothing on the profiles that do no clinical checking", () => {
    for (const p of ["ops", "all"]) {
      expect(assessReadiness(lifecycles([["ncci-ptp.json", false]]), p).warn).toBe(false);
    }
  });

  it("gives every profile that requires data a reason a reader can act on", () => {
    for (const need of PROFILE_DATA_NEEDS) {
      if (need.required.length > 0) expect(need.because.length).toBeGreaterThan(40);
    }
  });

  it("names every profile that exists, so a new one is not silently unchecked", () => {
    const named = new Set(PROFILE_DATA_NEEDS.map((p) => p.profile));
    for (const p of ["coding", "claims", "denials", "revenue", "operations", "ops", "all"]) {
      expect(named.has(p)).toBe(true);
    }
  });
});

describe("rendering", () => {
  const asOf = "20260210";
  const stale = assessDataset(
    { status: status("ncci-ptp.json", true), installedOn: "20251215", declaredEffective: "" },
    asOf,
  );
  const missing = assessDataset(
    { status: status("mue.json", false), installedOn: "", declaredEffective: "" },
    asOf,
  );

  it("says nothing at startup when there is nothing to say", () => {
    const clean = assessDataset({ status: status("mue.json", true), installedOn: asOf, declaredEffective: "" }, asOf);
    expect(renderStartupWarning(assessReadiness([clean], "denials"))).toBe("");
  });

  it("names the file, the profile and the fix in the startup warning", () => {
    const w = renderStartupWarning(assessReadiness([missing, stale], "claims"));
    expect(w).toContain("mue.json");
    expect(w).toContain("claims");
    expect(w).toContain("orion data refresh");
  });

  it("puts the problems first in the full report", () => {
    const current = assessDataset(
      { status: status("icd10.json", true), installedOn: asOf, declaredEffective: fiscalYearToEffective(2026) },
      asOf,
    );
    const out = renderReadiness(assessReadiness([current, missing, stale], "claims"), [current, missing, stale]);
    expect(out.indexOf("MISSING")).toBeLessThan(out.indexOf("current"));
  });

  it("explains why undated is not reported as current", () => {
    const undated = assessDataset(
      { status: status("ncci-ptp.json", true), installedOn: asOf, declaredEffective: "" },
      asOf,
    );
    const out = renderReadiness(assessReadiness([undated], "denials"), [undated]);
    expect(out).toContain("statement of safety");
  });
});
