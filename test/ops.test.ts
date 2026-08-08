import { describe, expect, it } from "vitest";
import {
  FRAGMENTATION_WARN,
  WAL_WARN_BYTES,
  analyzeBoundary,
  analyzeTenant,
  permissionProblem,
  renderIntegrity,
  type TenantDbFacts,
} from "../src/ops/integrity.js";
import { MIN_PLAUSIBLE_BYTES, analyzeDataset, hashOf, renderHealth } from "../src/ops/dataset-health.js";
import { VRAM_RESIDENT_WARN, analyzeTelemetry, parsePs, renderTelemetry, type OllamaSnapshot } from "../src/ops/ollama.js";
import {
  MIN_PER_PERIOD,
  MIN_POINT_CHANGE,
  detectPolicyDrift,
  proportionsDiffer,
  renderDrift,
  withDenominators,
  type DenialObservation,
} from "../src/ops/drift.js";
import type { Era } from "../src/tools/healthcare/x12/835.js";

const facts = (over: Partial<TenantDbFacts> = {}): TenantDbFacts => ({
  slug: "acme",
  path: "/srv/ac/tenants/acme/aetheraclaw.db",
  exists: true,
  mode: 0o600,
  sizeBytes: 1_000_000,
  walBytes: 1000,
  integrity: "ok",
  foreignKeyViolations: 0,
  pageCount: 1000,
  freelistCount: 10,
  missingTables: [],
  ...over,
});

describe("tenant database integrity", () => {
  it("passes a healthy database", () => {
    expect(analyzeTenant(facts())).toEqual([]);
  });

  it("treats a world- or group-accessible file as CRITICAL", () => {
    // In this architecture the isolation boundary IS the filesystem.
    expect(permissionProblem(0o644)).toMatch(/world-accessible/);
    expect(permissionProblem(0o640)).toMatch(/group-accessible/);
    expect(permissionProblem(0o600)).toBeNull();
    const f = analyzeTenant(facts({ mode: 0o644 }));
    expect(f[0].severity).toBe("critical");
    expect(f[0].remedy).toMatch(/no amount of correct application code compensates/);
  });

  it("does not invent a permission finding where modes are meaningless", () => {
    // Windows does not model POSIX permissions; reporting one would describe
    // the emulation, not the file.
    expect(permissionProblem(null)).toBeNull();
    expect(analyzeTenant(facts({ mode: null }))).toEqual([]);
  });

  it("reports corruption and says not to keep writing", () => {
    const f = analyzeTenant(facts({ integrity: "*** in database main *** row 3 missing" }));
    expect(f[0].check).toBe("integrity");
    expect(f[0].remedy).toMatch(/Do not write to it/);
  });

  it("flags a missing file rather than treating it as clean", () => {
    const f = analyzeTenant(facts({ exists: false }));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("database-missing");
  });

  it("warns on WAL growth and explains what actually causes it", () => {
    const f = analyzeTenant(facts({ walBytes: WAL_WARN_BYTES + 1 }));
    expect(f[0].check).toBe("wal-size");
    expect(f[0].remedy).toMatch(/long-lived read transaction/);
  });

  it("rates fragmentation as info, not as a fault", () => {
    const f = analyzeTenant(facts({ pageCount: 1000, freelistCount: Math.ceil(FRAGMENTATION_WARN * 1000) + 1 }));
    expect(f[0].check).toBe("fragmentation");
    expect(f[0].severity).toBe("info");
  });

  it("catches two tenants sharing one database file", () => {
    // The worst outcome this architecture can produce, and invisible to every
    // per-file check.
    const f = analyzeBoundary(
      [
        { slug: "acme", path: "/srv/ac/tenants/acme/db" },
        { slug: "beta", path: "/srv/ac/tenants/acme/db" },
      ],
      "/srv/ac/tenants",
    );
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("shared-path");
    expect(f[0].severity).toBe("critical");
    expect(f[0].detail).toMatch(/same database file/);
  });

  it("catches a tenant path outside the managed root", () => {
    const f = analyzeBoundary([{ slug: "acme", path: "/elsewhere/db" }], "/srv/ac/tenants");
    expect(f[0].check).toBe("path-escape");
  });

  it("orders the report by cost and calls out boundary findings", () => {
    const out = renderIntegrity({
      tenantsChecked: 2,
      findings: [
        ...analyzeTenant(facts({ pageCount: 100, freelistCount: 90 })),
        ...analyzeTenant(facts({ mode: 0o644 })),
      ],
    });
    expect(out.indexOf("CRITICAL")).toBeLessThan(out.indexOf("INFO"));
    expect(out).toMatch(/the boundary IS the filesystem/);
  });

  it("says plainly when there is no boundary to check", () => {
    expect(renderIntegrity({ tenantsChecked: 0, findings: [] })).toMatch(/no isolation boundary to verify/);
  });
});

describe("dataset health", () => {
  const ds = (over = {}) => ({
    file: "ncci-ptp.json",
    installed: true,
    sizeBytes: 500_000,
    modifiedAt: Date.UTC(2026, 6, 5),
    sha256: hashOf("a"),
    ...over,
  });

  it("passes a current, plausible file", () => {
    expect(analyzeDataset({ ...ds(), codeSet: "ncci" }, "20260710")).toEqual([]);
  });

  it("treats a truncated file as CRITICAL, worse than absence", () => {
    // The loader parses it, gets an empty object, and every edit silently
    // passes — absence at least reports itself.
    const f = analyzeDataset(ds({ sizeBytes: MIN_PLAUSIBLE_BYTES - 1 }), "20260101");
    expect(f[0].check).toBe("truncated");
    expect(f[0].severity).toBe("critical");
    expect(f[0].remedy).toMatch(/worse than the file being absent/);
  });

  it("reports a hash change against the recorded baseline", () => {
    const f = analyzeDataset(ds({ knownSha256: hashOf("b") }), "20260101");
    expect(f[0].check).toBe("changed");
    expect(f[0].remedy).toMatch(/partial write or an edit nobody logged/);
  });

  it("says nothing about the hash when no baseline was recorded", () => {
    expect(analyzeDataset(ds(), "20260101").filter((f) => f.check === "changed")).toEqual([]);
  });

  it("flags a file predating the edition in effect", () => {
    const f = analyzeDataset({ ...ds({ modifiedAt: Date.UTC(2025, 0, 5) }), codeSet: "ncci" }, "20260710");
    expect(f[0].check).toBe("stale");
    expect(f[0].remedy).toMatch(/DATE OF SERVICE/);
  });

  it("refuses to claim verification against CMS", () => {
    // CMS publishes no manifest hash and blocks automated fetches; a green
    // check would prove nothing while looking like proof.
    expect(renderHealth({ checked: 1, findings: [], asOf: "20260101" })).toMatch(/not verification against CMS/);
  });

  it("calls an absent file a limit rather than a pass", () => {
    const f = analyzeDataset(ds({ installed: false }), "20260101");
    expect(f[0].check).toBe("not-installed");
    expect(f[0].remedy).toMatch(/not a clean result/);
  });
});

describe("Ollama telemetry", () => {
  const snap = (over: Partial<OllamaSnapshot> = {}): OllamaSnapshot => ({
    reachable: true,
    baseUrl: "http://localhost:11434",
    cloud: false,
    models: [],
    probeMs: 12,
    ...over,
  });

  it("parses /api/ps, including the fields that matter", () => {
    const models = parsePs({
      models: [{ name: "qwen3:8b", size: 8_000_000_000, size_vram: 8_000_000_000, context_length: 8192, expires_at: "2026-01-01T00:05:00Z" }],
    });
    expect(models[0]).toEqual({
      name: "qwen3:8b",
      sizeBytes: 8_000_000_000,
      vramBytes: 8_000_000_000,
      contextLength: 8192,
      expiresAt: "2026-01-01T00:05:00Z",
    });
  });

  it("survives a payload shaped differently", () => {
    expect(parsePs({})).toEqual([]);
    expect(parsePs(null)).toEqual([]);
  });

  it("reports unreachable as critical and says every turn will fail", () => {
    const f = analyzeTelemetry(snap({ reachable: false, error: "ECONNREFUSED" }), 8192);
    expect(f[0].severity).toBe("critical");
    expect(f[0].remedy).toMatch(/ollama serve/);
  });

  it("flags a model spilled out of VRAM as the usual cause of slowness", () => {
    const f = analyzeTelemetry(
      snap({ models: [{ name: "m", sizeBytes: 100, vramBytes: 40, contextLength: 8192, expiresAt: "" }] }),
      8192,
    );
    expect(f[0].severity).toBe("critical");
    expect(f[0].detail).toMatch(/40% of/);
    expect(f[0].remedy).toMatch(/No amount of application tuning compensates/);
  });

  it("accepts a fully resident model", () => {
    const f = analyzeTelemetry(
      snap({ models: [{ name: "m", sizeBytes: 100, vramBytes: 100, contextLength: 8192, expiresAt: "" }] }),
      8192,
    );
    expect(f).toEqual([]);
    expect(VRAM_RESIDENT_WARN).toBeLessThanOrEqual(1);
  });

  it("catches a context budget larger than the loaded model can hold", () => {
    // Ollama truncates silently, so the model answers about a conversation it
    // cannot fully see.
    const f = analyzeTelemetry(
      snap({ models: [{ name: "m", sizeBytes: 100, vramBytes: 100, contextLength: 4096, expiresAt: "" }] }),
      150_000,
    );
    expect(f[0].detail).toMatch(/4096-token context/);
    expect(f[0].remedy).toMatch(/silently truncate/);
  });

  it("says there is no local GPU when running on Cloud", () => {
    expect(analyzeTelemetry(snap({ cloud: true }), 8192)[0].detail).toMatch(/no local GPU/);
  });

  it("names the metrics it deliberately does not show", () => {
    expect(renderTelemetry(snap(), [])).toMatch(/does not expose them/);
    expect(renderTelemetry(snap(), [])).toMatch(/nvidia-smi/);
  });
});

describe("payer policy drift", () => {
  const obs = (payer: string, carc: string, denied: boolean, at: number): DenialObservation => ({ payer, carc, denied, at });

  function series(beforeDenied: number, beforeN: number, afterDenied: number, afterN: number): DenialObservation[] {
    const out: DenialObservation[] = [];
    for (let i = 0; i < beforeN; i++) out.push(obs("Aetna", "96", i < beforeDenied, 1000 + i));
    for (let i = 0; i < afterN; i++) out.push(obs("Aetna", "96", i < afterDenied, 100000 + i));
    return out;
  }

  it("detects a real, sustained rate change", () => {
    const r = detectPolicyDrift(series(4, 100, 30, 100));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].beforeRate).toBe(4);
    expect(r.findings[0].afterRate).toBe(30);
    expect(r.findings[0].pointChange).toBe(26);
  });

  it("REFUSES to alert on a small-sample swing", () => {
    // 3-of-10 to 8-of-20 looks like a doubling and is noise. An alerting tool
    // nobody trusts gets muted, and then the real change goes unnoticed too.
    const r = detectPolicyDrift(series(3, 10, 8, 20));
    expect(r.findings).toEqual([]);
    expect(r.skippedThin).toBe(1);
  });

  it("explains the silence rather than reporting nothing found", () => {
    expect(renderDrift(detectPolicyDrift(series(3, 10, 8, 20)))).toMatch(/indistinguishable from a policy change/);
  });

  it("ignores a move too small to act on even when significant", () => {
    const r = detectPolicyDrift(series(200, 4000, 280, 4000));
    // 5.0 → 7.0 points is a 2-point move, under the floor.
    expect(r.findings.filter((f) => Math.abs(f.pointChange) < MIN_POINT_CHANGE)).toEqual([]);
  });

  it("requires the minimum denominator on BOTH sides", () => {
    // The split is the MEDIAN observation time, so the periods carry roughly
    // equal counts — a total under 2× the floor cannot satisfy both sides.
    const total = (MIN_PER_PERIOD - 1) * 2;
    expect(detectPolicyDrift(series(0, total / 2, total / 2, total / 2)).skippedThin).toBe(1);
  });

  it("splits by observation count, not by calendar", () => {
    // Worth asserting because it is surprising: with 24 old and 200 recent
    // observations, the median time falls INSIDE the recent block, so "before"
    // is the older half of the observations rather than the older half of the
    // year. Equal denominators is what gives the test its power.
    const lopsided = series(1, 24, 20, 200);
    const split = detectPolicyDrift(lopsided).splitAt;
    expect(split).toBeGreaterThan(100000);
  });

  it("uses a two-proportion test, not a ratio", () => {
    expect(proportionsDiffer(4, 100, 30, 100)).toBe(true);
    expect(proportionsDiffer(3, 10, 8, 20)).toBe(false);
    expect(proportionsDiffer(0, 0, 5, 10)).toBe(false);
  });

  it("measures a RATE, so a code that stops appearing shows as a fall", () => {
    // Counting occurrences alone cannot see this: 40 then 40 is flat, while
    // 40-of-40 then 40-of-800 collapsed.
    const era = (carcs: string[][], receivedAt: number) => ({
      era: {
        payer: "Aetna",
        payee: "C",
        checkOrEftAmount: 0,
        claims: carcs.map((codes, i) => ({
          claimId: `C${receivedAt}-${i}`,
          statusCode: "1",
          charged: 100,
          paid: 80,
          patientResponsibility: 0,
          payerControlNumber: "P",
          lines: [{ procedure: "99214", charged: 100, paid: 80, units: 1, rarcs: [], adjustments: codes.map((c) => ({ group: "CO", carc: c, amount: 1 })) }],
        })),
      } as Era,
      receivedAt,
    });

    const before = era(Array.from({ length: 40 }, () => ["96"]), 1000);
    const after = era(
      Array.from({ length: 40 }, (_, i) => (i < 2 ? ["96"] : [])),
      100000,
    );
    const r = detectPolicyDrift(withDenominators([before, after]));
    const f = r.findings.find((x) => x.carc === "96");
    expect(f).toBeDefined();
    expect(f!.beforeRate).toBe(100);
    expect(f!.afterRate).toBe(5);
  });

  it("says so plainly when there is no history", () => {
    expect(renderDrift(detectPolicyDrift([]))).toMatch(/No remittance history/);
  });

  it("warns that behaviour also moves when your own coding changes", () => {
    expect(renderDrift(detectPolicyDrift(series(4, 100, 30, 100)))).toMatch(/your own coding changes/);
  });
});
