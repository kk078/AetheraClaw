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
import { batchHeal, renderBatchHeal } from "../src/ops/batch-heal.js";
import {
  MIN_ACKS_PER_PERIOD,
  NEW_CODE_THRESHOLD,
  analyzeRejections,
  renderRejectionAnalysis,
  type AcceptanceObservation,
  type RejectionObservation,
} from "../src/ops/rejection-analysis.js";
import {
  SYSTEMIC_AFFECTED,
  buildRca,
  diagnoseTrace,
  fingerprint,
  ownershipFor,
  renderTicketNote,
  severityOf,
} from "../src/ops/rca.js";
import { classifyFailure } from "../src/support/fmea.js";
import { assembleTrace } from "../src/support/trace.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";

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

// ── Batch auto-heal preview ──────────────────────────────────────────────────

const bhClaim = (over: Partial<ClaimInput> = {}): ClaimInput => ({
  claim_id: "C1",
  payer_name: "Medicare",
  payer_id: "MCR",
  billing_provider_npi: "1234567893",
  billing_provider_name: "Test Clinic",
  subscriber_id: "TEST123",
  patient_last: "Test",
  patient_first: "Pat",
  patient_dob: "19700101",
  patient_sex: "U",
  diagnoses: ["E11.9"],
  service_lines: [
    { cpt_hcpcs: "99214", charge: 200, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
  ],
  ...over,
});

const bhLine = (over: Partial<ClaimInput["service_lines"][number]> = {}) => ({
  cpt_hcpcs: "99214",
  charge: 200,
  units: 1,
  dx_pointers: [1],
  service_date: "20260115",
  place_of_service: "11",
  ...over,
});

describe("batch auto-heal preview", () => {
  it("splits three ways, and a repairable claim is NOT counted as needing a human", () => {
    // The whole point of the tool is the third number. A claim a safe repair
    // covers must not inflate it, or the ops lead schedules staff against work
    // that does not exist.
    const s = batchHeal([
      bhClaim({ claim_id: "CLEAN" }),
      bhClaim({ claim_id: "FIXABLE", service_lines: [bhLine({ service_date: "2026-01-15" })] }),
      bhClaim({ claim_id: "HUMAN", service_lines: [bhLine({ modifiers: ["95"], place_of_service: "11" })] }),
    ]);
    expect(s.total).toBe(3);
    expect(s.clean).toBe(1);
    expect(s.repaired).toBe(1);
    expect(s.review).toBe(1);
    expect(s.results.find((r) => r.claimId === "FIXABLE")!.status).toBe("repaired");
  });

  it("counts a claim needing review as review even when it also has a safe repair", () => {
    // Otherwise a claim would be reported as handled while still blocked.
    const s = batchHeal([
      bhClaim({ service_lines: [bhLine({ service_date: "2026-01-15", modifiers: ["95"], place_of_service: "11" })] }),
    ]);
    expect(s.review).toBe(1);
    expect(s.repaired).toBe(0);
    expect(s.results[0].applied.length).toBeGreaterThan(0);
  });

  it("groups one rule hitting many claims as one problem", () => {
    const s = batchHeal(
      Array.from({ length: 8 }, (_, i) =>
        bhClaim({ claim_id: `C${i}`, service_lines: [bhLine({ service_date: "2026-01-15" })] }),
      ),
    );
    expect(s.repairsByRule).toHaveLength(1);
    expect(s.repairsByRule[0].count).toBe(8);
    expect(renderBatchHeal(s)).toMatch(/one upstream fault, not many independent ones/);
  });

  it("states that nothing was written and that there is no batch apply", () => {
    const out = renderBatchHeal(batchHeal([bhClaim()]));
    expect(out).toMatch(/NOTHING WAS WRITTEN/);
    expect(out).toMatch(/deliberately no batch apply/);
  });

  it("carries the review question, not just the rule name", () => {
    const s = batchHeal([bhClaim({ service_lines: [bhLine({ modifiers: ["95"], place_of_service: "11" })] })]);
    expect(s.reviewsByRule[0].question).not.toBe("");
    expect(renderBatchHeal(s)).toMatch(s.reviewsByRule[0].question.slice(0, 30));
  });
});

// ── 277CA rejection analysis ─────────────────────────────────────────────────

describe("clearinghouse rejection analysis", () => {
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 0, 1);
  const rej = (payer: string, code: string, at: number): RejectionObservation => ({
    payer,
    statusCode: code,
    entity: "41",
    at,
  });
  const acc = (payer: string, at: number): AcceptanceObservation => ({ payer, at });

  /** n acceptances spread over the window so the split lands where intended. */
  const spread = (payer: string, n: number, from: number) =>
    Array.from({ length: n }, (_, i) => acc(payer, from + i * DAY));

  it("catches a code that never appeared and now appears repeatedly", () => {
    // Rejections placed AFTER every acceptance, so the count-based split cannot
    // land inside the burst and score half of it as "before".
    const rejections = Array.from({ length: NEW_CODE_THRESHOLD + 2 }, (_, i) => rej("Aetna", "21", T0 + (200 + i) * DAY));
    const acceptances = [...spread("Aetna", 40, T0), ...spread("Aetna", 40, T0 + 60 * DAY)];
    const a = analyzeRejections(rejections, acceptances);
    const e = a.emerging.find((x) => x.statusCode === "21");
    expect(e).toBeDefined();
    expect(e!.brandNew).toBe(true);
    expect(e!.before).toBe(0);
    expect(renderRejectionAnalysis(a)).toMatch(/NEW — never seen before this window/);
  });

  it("refuses to call a change on a payer with too few acknowledgments", () => {
    // Three rejections out of five is not a rate, and reporting it as one is
    // how an alerter gets muted before it ever says anything true.
    const a = analyzeRejections(
      [rej("Tiny", "21", T0), rej("Tiny", "21", T0 + DAY), rej("Tiny", "21", T0 + 2 * DAY)],
      spread("Tiny", 2, T0 + 3 * DAY),
    );
    expect(a.emerging).toEqual([]);
    expect(a.thin.join(" ")).toMatch(/Tiny/);
    expect(renderRejectionAnalysis(a)).toMatch(new RegExp(`fewer than ${MIN_ACKS_PER_PERIOD}`));
  });

  it("does not report a code that FELL", () => {
    // A front end relaxing an edit is good news, and reporting it under
    // "emerging edits" would train people to skim the section.
    const rejections = [
      ...Array.from({ length: 15 }, (_, i) => rej("Cigna", "21", T0 + i * DAY)),
      ...Array.from({ length: 2 }, (_, i) => rej("Cigna", "21", T0 + (60 + i) * DAY)),
    ];
    const acceptances = [...spread("Cigna", 30, T0), ...spread("Cigna", 30, T0 + 60 * DAY)];
    const a = analyzeRejections(rejections, acceptances);
    expect(a.emerging.filter((e) => e.statusCode === "21")).toEqual([]);
  });

  it("resolves the status code against the bundled dataset and says so when it cannot", () => {
    const a = analyzeRejections([rej("Aetna", "ZZZ", T0)], spread("Aetna", 30, T0));
    expect(a.groups[0].description).toMatch(/not in the bundled 277CA dataset/);
    expect(a.groups[0].fix).toMatch(/guessing at it/);
  });

  it("withholds a rejection rate below the sample floor but still lists the groups", () => {
    const a = analyzeRejections([rej("Aetna", "21", T0)], []);
    expect(a.rejectionRate).toBeNull();
    expect(renderRejectionAnalysis(a)).toMatch(/too few to state a rate/);
    expect(a.groups).toHaveLength(1);
  });

  it("says the rejections are recoverable and why that is time-limited", () => {
    const rejections = Array.from({ length: 6 }, (_, i) => rej("Aetna", "21", T0 + (200 + i) * DAY));
    const a = analyzeRejections(rejections, [...spread("Aetna", 40, T0), ...spread("Aetna", 40, T0 + 60 * DAY)]);
    const out = renderRejectionAnalysis(a);
    expect(out).toMatch(/never entered adjudication/);
    expect(out).toMatch(/no appeal rights to fall back on/);
    expect(out).toMatch(/timely filing kept running/);
  });

  it("distinguishes an empty acknowledgment history from a clean one", () => {
    expect(renderRejectionAnalysis(analyzeRejections([], []))).toMatch(/No acknowledgments recorded/);
  });
});

// ── Root cause analysis ──────────────────────────────────────────────────────

describe("RCA report", () => {
  const NOW = Date.UTC(2026, 0, 20);

  it("raises severity when the data is at risk, regardless of how few occurrences", () => {
    // One ENOSPC is worse than fifty schema mismatches, because the next write
    // makes it worse rather than making the backlog longer.
    expect(severityOf("disk", 1).severity).toBe("sev1");
    expect(severityOf("schema_mismatch", 50).severity).toBe("sev2");
    expect(severityOf("schema_mismatch", 1).severity).toBe("sev3");
  });

  it("treats a filing clock on many claims as worse than on one", () => {
    expect(severityOf("payer_rejection", 1).severity).toBe("sev2");
    expect(severityOf("payer_rejection", SYSTEMIC_AFFECTED).severity).toBe("sev1");
  });

  it("fingerprints the CAUSE, not the evidence, so a recurrence deduplicates", () => {
    // The evidence carries the claim id and the timestamp. Fingerprinting it
    // would make every occurrence unique — the exact duplicate-ticket pile a
    // fingerprint exists to prevent.
    const a = buildRca({
      incidentRef: "batch",
      diagnoses: [classifyFailure("ECONNREFUSED 127.0.0.1:11434 at 10:02")],
      affected: 1,
      generatedAt: NOW,
    });
    const b = buildRca({
      incidentRef: "batch",
      diagnoses: [classifyFailure("ECONNREFUSED 127.0.0.1:11434 at 14:51")],
      affected: 1,
      generatedAt: NOW + 86_400_000,
    });
    expect(a.ticket.fingerprint).toBe(b.ticket.fingerprint);
  });

  it("gives a different fingerprint to a different cause", () => {
    const a = fingerprint("network", "nothing answered", "C-1");
    const b = fingerprint("auth", "nothing answered", "C-1");
    expect(a).not.toBe(b);
  });

  it("names an OWNER, not just a tier — the two are different questions", () => {
    // Both are Tier 1. Sending a payer rejection to support and a rate limit to
    // billing is how a ticket bounces twice before anyone touches it.
    expect(ownershipFor("payer_rejection").owner).toMatch(/billing/i);
    expect(ownershipFor("network").owner).toMatch(/support/i);
    expect(ownershipFor("payer_rejection").tier).toBe(1);
    expect(ownershipFor("network").tier).toBe(1);
  });

  it("quotes the evidence rather than summarising it", () => {
    const r = buildRca({
      incidentRef: "C-1",
      diagnoses: [classifyFailure("SQLITE_BUSY: database is locked")],
      affected: 1,
      generatedAt: NOW,
    });
    expect(r.markdown).toMatch(/database is locked/);
    expect(r.markdown).toMatch(/take the category on trust/);
  });

  it("reports the never-happened stages, because the gap is the finding", () => {
    const trace = assembleTrace("C-9", [
      { at: NOW - 30 * 86_400_000, source: "claim", label: "Claim built", detail: "status=submitted" },
    ]);
    const r = buildRca({ incidentRef: "C-9", diagnoses: [], trace, affected: 0, generatedAt: NOW });
    expect(r.markdown).toMatch(/Stages that never happened/);
    expect(r.markdown).toMatch(/Remittance received/);
  });

  it("says UNCLASSIFIED rather than picking the nearest category", () => {
    const r = buildRca({
      incidentRef: "C-2",
      diagnoses: [classifyFailure("the flux capacitor emitted a shrug")],
      affected: 1,
      generatedAt: NOW,
    });
    expect(r.primary).toBe("unclassified");
    expect(r.markdown).toMatch(/rather than picking the nearest one/);
  });

  it("warns when several distinct causes are being called one incident", () => {
    const r = buildRca({
      incidentRef: "window",
      diagnoses: [
        classifyFailure("ECONNREFUSED"),
        classifyFailure("HTTP 401 unauthorized"),
        classifyFailure("ENOSPC no space left"),
      ],
      affected: 3,
      generatedAt: NOW,
    });
    expect(r.categories.length).toBe(3);
    expect(r.markdown).toMatch(/usually not one incident/);
  });

  it("keeps a claim's OWN record as the root cause, not whatever else was noisy", () => {
    // The regression this exists for: a claim that sat 95 days unacknowledged
    // was filed as a network incident and addressed to engineering, because
    // Ollama happened to be down that afternoon.
    const trace = assembleTrace("C-STUCK", [
      { at: NOW - 95 * 86_400_000, source: "claim", label: "Claim built", detail: "status=submitted" },
    ]);
    const claimCause = diagnoseTrace(trace, NOW)!;
    const r = buildRca({
      incidentRef: "C-STUCK",
      diagnoses: [claimCause],
      ambient: [classifyFailure("ECONNREFUSED"), classifyFailure("ECONNREFUSED")],
      trace,
      affected: 1,
      generatedAt: NOW,
    });
    expect(r.primary).toBe("submission_gap");
    expect(r.ownership.owner).toMatch(/billing/i);
    expect(r.severity).toBe("sev2");
    expect(r.markdown).toMatch(/Also failing in this window/);
    expect(r.markdown).toMatch(/NOT the root cause above/);
  });

  it("reads the right gap: never acknowledged vs accepted and never paid", () => {
    const built = { at: NOW - 95 * 86_400_000, source: "claim" as const, label: "Claim built", detail: "" };
    const unacked = diagnoseTrace(assembleTrace("C-1", [built]), NOW)!;
    const accepted = diagnoseTrace(
      assembleTrace("C-1", [
        built,
        { at: NOW - 94 * 86_400_000, source: "filing_proof", label: "Acceptance banked", detail: "" },
      ]),
      NOW,
    )!;
    expect(unacked.category).toBe("submission_gap");
    expect(accepted.category).toBe("no_payer_response");
    // The distinction that matters: one has a banked acceptance to defend with.
    expect(accepted.nextSteps.join(" ")).toMatch(/Acceptance is banked/);
    expect(unacked.nextSteps.join(" ")).toMatch(/whether it was actually transmitted/);
  });

  it("does not fork a new ticket every day an incident stays open", () => {
    // The cause carries an age in days, so a naive fingerprint changes at
    // midnight — worst on precisely the incidents that last longest.
    const at = NOW - 95 * 86_400_000;
    const day1 = diagnoseTrace(assembleTrace("C-1", [{ at, source: "claim", label: "Claim built", detail: "" }]), NOW)!;
    const day2 = diagnoseTrace(
      assembleTrace("C-1", [{ at, source: "claim", label: "Claim built", detail: "" }]),
      NOW + 86_400_000,
    )!;
    expect(day1.cause).not.toBe(day2.cause);
    expect(fingerprint(day1.category, day1.cause, "C-1")).toBe(fingerprint(day2.category, day2.cause, "C-1"));
  });

  it("names WHICH clock is running rather than one generic sentence", () => {
    expect(severityOf("submission_gap", 1).because).toMatch(/no banked acceptance/);
    expect(severityOf("no_payer_response", 1).because).toMatch(/Acceptance is banked/);
    expect(severityOf("payer_denial", 1).because).toMatch(/appeal rights/);
  });

  it("counts occurrences consistently between the header and the rationale", () => {
    expect(severityOf("schema_mismatch", 2).because).toMatch(/2 occurrences/);
    expect(severityOf("schema_mismatch", 1).because).toMatch(/One occurrence/);
  });

  it("explains why there is no Jira client instead of pretending there is one", () => {
    const r = buildRca({
      incidentRef: "C-3",
      diagnoses: [classifyFailure("HTTP 429 rate limit")],
      affected: 1,
      generatedAt: NOW,
    });
    const note = renderTicketNote(r.ticket);
    expect(note).toMatch(/Match on the fingerprint BEFORE creating/);
    expect(note).toMatch(/first be exercised during an incident/);
    expect(r.ticket.labels).toContain("cause:rate_limit");
  });
});
