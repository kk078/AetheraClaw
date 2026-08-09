import { describe, expect, it } from "vitest";
import { renderTriage, sniffAttachment, triageAttachments } from "../src/channels/email/attachments.js";
import {
  CRITICAL_DAYS,
  daysToNearestDeadline,
  recommend,
  renderRecommendation,
  type LocalFacts,
} from "../src/channels/email/recommend.js";
import {
  MIN_LATENCY_SAMPLE,
  buildBriefing,
  denialHotspots,
  payerLatency,
  renderBriefing,
  renderLatency,
  type CorrespondenceRecord,
} from "../src/channels/email/mis.js";
import type { Classification } from "../src/channels/email/classify.js";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("attachment triage", () => {
  it("identifies an 835 by its ISA envelope, not its extension", () => {
    // Extensions lie constantly: an 835 arrives as .txt, .dat, .era or with none.
    const era = "ISA*00*          *00*          *ZZ*S*ZZ*R*260115*1200*^*00501*1*0*P*:~GS*HP*S*R*20260115*1200*1*X*005010X221A1~ST*835*0001~";
    for (const name of ["remit.txt", "FILE.DAT", "noextension", "x.era"]) {
      const a = sniffAttachment(name, buf(era));
      expect(a.kind, name).toBe("x12_835");
      expect(a.routeTo, name).toBe("era_parse_835");
    }
  });

  it("reads the transaction set, not the envelope, to pick the parser", () => {
    // One ISA can carry 835s or 277s and the filename says neither.
    const ack = "ISA*00*x~GS*HN*a*b*20260115*1200*1*X*005010X214~ST*277*0001~";
    const a = sniffAttachment("whatever.txt", buf(ack));
    expect(a.kind).toBe("x12_277");
    expect(a.routeTo).toBe("ack_parse_277ca");
  });

  it("names an 837 as something WE sent, not something to parse", () => {
    const a = sniffAttachment("claim.txt", buf("ISA*00*x~ST*837*0001~"));
    expect(a.kind).toBe("x12_837");
    expect(a.routeTo).toBe("");
    expect(a.note).toMatch(/something YOU sent/);
  });

  it("REFUSES to pretend it can read a PDF", () => {
    // Returning the ASCII fragments visible in a raw PDF stream would look like
    // a reading and be worse than nothing.
    const a = sniffAttachment("adr.pdf", Buffer.from("%PDF-1.7\n%âãÏÓ\nstream", "latin1"));
    expect(a.kind).toBe("pdf");
    expect(a.routeTo).toBe("");
    expect(a.text).toBeUndefined();
    expect(a.note).toMatch(/No text extraction is available/);
    expect(a.note).toMatch(/take the deadline from the email body/);
  });

  it("declines to guess a CSV's columns", () => {
    const a = sniffAttachment("denials.csv", buf("claim,payer,reason\nC-1,Aetna,96\nC-2,Aetna,197"));
    expect(a.kind).toBe("csv");
    expect(a.routeTo).toBe("");
    expect(a.note).toMatch(/guessing which column is the claim id/);
  });

  it("holds an attachment carrying identifier-shaped text", () => {
    const t = triageAttachments([{ filename: "list.txt", content: buf("Patient SSN 123-45-6789") }]);
    expect(t.withPhi).toHaveLength(1);
    expect(renderTriage(t)).toMatch(/HELD: identifier-shaped text/);
  });

  it("separates what a tool can take now from what it cannot", () => {
    const t = triageAttachments([
      { filename: "a.txt", content: buf("ISA*00*x~ST*835*1~") },
      { filename: "b.pdf", content: Buffer.from("%PDF-1.4", "latin1") },
    ]);
    expect(t.actionable.map((a) => a.filename)).toEqual(["a.txt"]);
    expect(renderTriage(t)).toMatch(/1 can be parsed now/);
  });

  it("does not include attachment content in the rendering", () => {
    const t = triageAttachments([{ filename: "a.txt", content: buf("ISA*00*x~ST*835*1~SECRETPAYLOAD") }]);
    expect(renderTriage(t)).not.toMatch(/SECRETPAYLOAD/);
  });
});

describe("action recommendation", () => {
  const c = (over: Partial<Classification> = {}): Classification => ({
    kind: "records_request",
    confidence: 0.9,
    matched: [],
    routeTo: "",
    why: "",
    deadlines: [],
    amountsCents: [],
    claimRefs: ["C-1"],
    phi: [],
    ...over,
  });
  const facts = (over: Partial<LocalFacts> = {}): LocalFacts => ({
    knownClaims: ["C-1"],
    claimsWithOpenItem: [],
    claimsWithFilingProof: [],
    claimsAdjudicated: [],
    ...over,
  });
  const NOW = Date.UTC(2026, 0, 15);

  it("counts a RELATIVE deadline from receipt, not from now", () => {
    // Measuring "within 30 days" from now would reset the clock every time
    // somebody looked at the inbox — the one direction it must never move.
    const received = NOW - 25 * 86_400_000;
    const days = daysToNearestDeadline(c({ deadlines: [{ days: 30, quote: "within 30 days" }] }), NOW, received);
    expect(days).toBe(5);
  });

  it("handles an absolute date too, and takes the sooner of the two", () => {
    const received = NOW - 25 * 86_400_000;
    const cls = c({ deadlines: [{ days: 30, quote: "" }, { date: "20260117", quote: "" }] });
    expect(daysToNearestDeadline(cls, NOW, received)).toBe(2);
  });

  it("lets a near deadline escalate ABOVE the category floor", () => {
    const soon = recommend(c({ deadlines: [{ date: "20260118", quote: "" }] }), facts(), NOW, NOW);
    const later = recommend(c({ deadlines: [{ date: "20260401", quote: "" }] }), facts(), NOW, NOW);
    expect(soon.urgency).toBe("critical");
    // Still high, not normal: a records request has a hard deadline whose miss
    // loses the claim, so the category sets a floor the distance cannot lower.
    expect(later.urgency).toBe("high");
    expect(soon.why).toMatch(/loses the claim outright/);
  });

  it("lets distance lower a category with no floor", () => {
    const soon = recommend(c({ kind: "denial", deadlines: [{ date: "20260118", quote: "" }] }), facts(), NOW, NOW);
    const later = recommend(c({ kind: "denial", deadlines: [{ date: "20260401", quote: "" }] }), facts(), NOW, NOW);
    expect(soon.urgency).toBe("critical");
    expect(later.urgency).toBe("normal");
  });

  it("REFUSES to open an item for a claim that does not exist here", () => {
    // A queue full of phantom claims is worse than an empty one.
    const r = recommend(c({ claimRefs: ["C-999"] }), facts({ knownClaims: [] }), NOW, NOW);
    expect(r.action).toMatch(/No claim here matches C-999/);
    expect(r.why).toMatch(/Do NOT open a worklist item/);
    expect(r.tools).toContain("support_trace_claim");
  });

  it("stops when an item is already open rather than duplicating it", () => {
    const r = recommend(c(), facts({ claimsWithOpenItem: ["C-1"] }), NOW, NOW);
    expect(r.action).toMatch(/Already being worked/);
    expect(r.why).toMatch(/noisy queue is one nobody reads/);
  });

  it("treats a deadline-less overpayment demand as high anyway", () => {
    // The 60-day statutory clock runs whether or not the letter says so.
    const r = recommend(c({ kind: "overpayment_demand", deadlines: [] }), facts(), NOW, NOW);
    expect(r.urgency).toBe("high");
    expect(r.why).toMatch(/runs from IDENTIFICATION/);
  });

  it("notes that an emailed denial is invisible to remittance analytics", () => {
    const r = recommend(c({ kind: "denial" }), facts(), NOW, NOW);
    expect(r.why).toMatch(/will not appear in remittance analytics/);
  });

  it("says a front-end rejection has no appeal rights but a running clock", () => {
    const r = recommend(c({ kind: "clearinghouse_rejection" }), facts(), NOW, NOW);
    expect(r.why).toMatch(/no appeal rights/);
    expect(r.tools).toContain("timely_filing_check");
  });

  it("reports an unplaced letter as unplaced", () => {
    const r = recommend(c({ kind: "other", claimRefs: [] }), facts(), NOW, NOW);
    expect(r.why).toMatch(/wrong queue looks handled/);
  });

  it("marks urgency visibly in the rendering", () => {
    const r = recommend(c({ deadlines: [{ date: "20260116", quote: "" }] }), facts(), NOW, NOW);
    expect(renderRecommendation(r, "ADR")).toMatch(/CRITICAL/);
    expect(CRITICAL_DAYS).toBeGreaterThan(0);
  });
});

describe("MIS reporting", () => {
  const rec = (over: Partial<CorrespondenceRecord> = {}): CorrespondenceRecord => ({
    kind: "denial",
    sender: "noreply@aetna.example",
    payer: "aetna.example",
    claimRefs: ["C-1"],
    amountsCents: [25_000],
    receivedAt: Date.UTC(2026, 0, 20),
    quarantined: false,
    confidence: 0.9,
    ...over,
  });

  it("uses a MEDIAN, so one nine-month letter does not move it", () => {
    const built = new Map<string, number>();
    const correspondence: CorrespondenceRecord[] = [];
    for (let i = 0; i < MIN_LATENCY_SAMPLE; i++) {
      const ref = `C-${i}`;
      built.set(ref, Date.UTC(2026, 0, 1));
      // One outlier at 270 days; the rest at 10.
      const days = i === 0 ? 270 : 10;
      correspondence.push(rec({ claimRefs: [ref], receivedAt: Date.UTC(2026, 0, 1) + days * 86_400_000 }));
    }
    const r = payerLatency(correspondence, built);
    expect(r.stats[0].medianDays).toBe(10);
    expect(r.stats[0].p90Days).toBeGreaterThan(10);
  });

  it("withholds a median below the sample floor", () => {
    const built = new Map([["C-1", Date.UTC(2026, 0, 1)]]);
    const r = payerLatency([rec()], built);
    expect(r.stats).toEqual([]);
    expect(r.thin[0]).toMatch(/\(1\)/);
    expect(renderLatency(r)).toMatch(/one payer's mood rather than its behaviour/);
  });

  it("excludes letters naming a claim built nowhere here", () => {
    // Counting them would score an unknown claim as an instant response.
    const r = payerLatency([rec({ claimRefs: ["NOPE"] })], new Map());
    expect(r.unmatched).toBe(1);
    expect(renderLatency(r)).toMatch(/excluded rather than counted as instant responses/);
  });

  it("counts only informal denials as reclaimable", () => {
    // Dollar amounts in a bulletin are not money anyone can recover.
    const hot = denialHotspots([
      rec({ kind: "denial", amountsCents: [10_000] }),
      rec({ kind: "clearinghouse_rejection", amountsCents: [5_000] }),
      rec({ kind: "policy_bulletin", amountsCents: [999_999] }),
    ]);
    expect(hot.reduce((n, h) => n + h.amountCents, 0)).toBe(15_000);
  });

  it("says why the informal denials matter", () => {
    const b = buildBriefing({ correspondence: [rec()], critical: 0, high: 1, unclassified: 0, windowHours: 24 });
    expect(renderBriefing(b, 24)).toMatch(/invisible to remittance analytics/);
    expect(renderBriefing(b, 24)).toMatch(/not discoverable from the remittances/);
  });

  it("distinguishes an empty inbox from nothing needing attention", () => {
    const b = buildBriefing({ correspondence: [], critical: 0, high: 0, unclassified: 0, windowHours: 24 });
    expect(renderBriefing(b, 24)).toMatch(/not that nothing needs attention/);
  });

  it("names the critical count as the only number that expires", () => {
    const b = buildBriefing({ correspondence: [rec()], critical: 2, high: 0, unclassified: 0, windowHours: 24 });
    expect(renderBriefing(b, 24)).toMatch(/only number here that expires/);
  });

  it("reports held mail without pretending its body was read", () => {
    const b = buildBriefing({ correspondence: [rec({ quarantined: true })], critical: 0, high: 0, unclassified: 0, windowHours: 24 });
    expect(renderBriefing(b, 24)).toMatch(/bodies never stored/);
  });
});
