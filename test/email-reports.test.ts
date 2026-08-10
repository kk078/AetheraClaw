import { describe, expect, it } from "vitest";
import {
  MBI_PATTERN,
  classify,
  detectPhi,
  extractAmountsCents,
  extractClaimRefs,
  extractDeadlines,
  redact,
  renderClassification,
  type InboundMessage,
} from "../src/channels/email/classify.js";
import {
  AGING_LABELS,
  bucketFor,
  buildReport,
  claimCharge,
  computeArAging,
  computeDenialSummary,
  computeProduction,
  earliestServiceDate,
  type StoredClaim,
  type StoredEra,
} from "../src/reports/aggregate.js";
import { arAgingCsv, csvEscape, summaryMarkdown, toCsv } from "../src/reports/render.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";
import type { Era, EraServiceLine } from "../src/tools/healthcare/x12/835.js";

const mail = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  id: "1",
  from: "provider.services@examplepayer.test",
  subject: "",
  text: "",
  receivedAt: Date.UTC(2026, 7, 7),
  ...over,
});

// ── Classification ───────────────────────────────────────────────────────────

describe("correspondence classification", () => {
  it("recognizes an additional documentation request", () => {
    const c = classify(
      mail({
        subject: "Additional Documentation Request",
        text: "Please submit the medical records for the claim below within 45 days of the date of this letter.",
      }),
    );
    expect(c.kind).toBe("records_request");
    expect(c.routeTo).toBe("audit_track");
    expect(c.why).toMatch(/response clock/);
  });

  it("recognizes a contractor audit notice", () => {
    expect(classify(mail({ subject: "TPE round 1 notification", text: "Targeted Probe and Educate review." })).kind).toBe(
      "audit_notice",
    );
    expect(classify(mail({ text: "This is a Recovery Audit Contractor (RAC) post-payment review." })).kind).toBe(
      "audit_notice",
    );
  });

  it("recognizes an overpayment demand and routes it to the ledger", () => {
    const c = classify(
      mail({ subject: "Overpayment demand letter", text: "A refund is due in the amount of $1,240.50. We will recoup." }),
    );
    expect(c.kind).toBe("overpayment_demand");
    expect(c.routeTo).toBe("credit_balance_add");
    expect(c.amountsCents).toContain(124050);
  });

  it("recognizes a revalidation notice", () => {
    const c = classify(mail({ text: "You must revalidate your enrollment in PECOS by 09/30/2026." }));
    expect(c.kind).toBe("revalidation");
    expect(c.routeTo).toBe("credentialing_track");
    expect(c.deadlines).toContainEqual(expect.objectContaining({ date: "20260930" }));
  });

  it("recognizes an appeal determination", () => {
    expect(classify(mail({ subject: "Redetermination decision", text: "Unfavorable decision." })).kind).toBe(
      "appeal_determination",
    );
  });

  it("recognizes a clearinghouse rejection", () => {
    expect(classify(mail({ subject: "Batch rejection report", text: "Your file was rejected." })).kind).toBe(
      "clearinghouse_rejection",
    );
  });

  it("recognizes a policy bulletin", () => {
    expect(classify(mail({ subject: "LCD policy update", text: "Coverage criteria change effective soon." })).kind).toBe(
      "policy_bulletin",
    );
  });

  it("separates patient correspondence from payer correspondence", () => {
    const c = classify(mail({ from: "patient@example.test", text: "I want to dispute this bill on my account." }));
    expect(c.kind).toBe("patient_billing");
    expect(c.why).toMatch(/belongs to patient billing/);
  });

  it("prefers the costlier-to-miss kind when a letter matches several", () => {
    // A records request that also mentions a denial is still a records request:
    // missing the ADR window loses the claim outright.
    const c = classify(
      mail({ text: "The claim was denied. Please submit the medical records within 45 days. Additional Documentation Request." }),
    );
    expect(c.kind).toBe("records_request");
  });

  it("admits when it does not recognize a message", () => {
    const c = classify(mail({ subject: "Lunch?", text: "Are you free Thursday?" }));
    expect(c.kind).toBe("other");
    expect(c.confidence).toBe(0);
    expect(c.why).toMatch(/Read it before filing it/);
  });

  it("never claims certainty, since these are keyword rules", () => {
    const c = classify(
      mail({
        subject: "Additional Documentation Request ADR",
        text: "request for medical records — please submit the medical records. Documentation request letter.",
      }),
    );
    expect(c.confidence).toBeLessThanOrEqual(0.9);
  });
});

describe("deadline extraction", () => {
  it("reads a relative window", () => {
    expect(extractDeadlines("respond within 45 days")).toContainEqual(expect.objectContaining({ days: 45 }));
    expect(extractDeadlines("within 30 calendar days")).toContainEqual(expect.objectContaining({ days: 30 }));
    expect(extractDeadlines("120 days from the date of this notice")).toContainEqual(
      expect.objectContaining({ days: 120 }),
    );
  });

  it("reads an absolute date and normalizes it", () => {
    expect(extractDeadlines("no later than 12/31/2026")).toContainEqual(expect.objectContaining({ date: "20261231" }));
    expect(extractDeadlines("due by 1/5/2027")).toContainEqual(expect.objectContaining({ date: "20270105" }));
  });

  it("reads both forms from the same letter", () => {
    const found = extractDeadlines("Respond within 45 days, and in any case before 10/15/2026.");
    expect(found.some((d) => d.days === 45)).toBe(true);
    expect(found.some((d) => d.date === "20261015")).toBe(true);
  });

  it("keeps the quote so the reader can check it against the letter", () => {
    expect(extractDeadlines("respond within 45 days")[0].quote).toMatch(/within 45 days/);
  });

  it("finds nothing in a letter with no deadline", () => {
    expect(extractDeadlines("Thank you for your submission.")).toEqual([]);
  });

  it("ignores an impossible month or day", () => {
    expect(extractDeadlines("by 13/45/2026")).toEqual([]);
  });
});

describe("amount and claim reference extraction", () => {
  it("reads dollar amounts into cents", () => {
    expect(extractAmountsCents("$1,240.50 and $75")).toEqual([124050, 7500]);
  });

  it("reads labelled claim identifiers", () => {
    expect(extractClaimRefs("Claim Number: 2026123456789")).toContain("2026123456789");
    expect(extractClaimRefs("ICN# 12345678901")).toContain("12345678901");
    expect(extractClaimRefs("DCN: ABC-123456")).toContain("ABC-123456");
  });

  it("does not treat every number as a claim reference", () => {
    expect(extractClaimRefs("We processed 12 claims in 2026.")).toEqual([]);
  });
});

// ── PHI ──────────────────────────────────────────────────────────────────────

describe("PHI detection", () => {
  it("matches the documented MBI shape", () => {
    // 1EG4-TE5-MK73 is the format example CMS publishes.
    expect("1EG4TE5MK73".match(MBI_PATTERN)).not.toBeNull();
  });

  it("rejects an MBI containing an excluded letter", () => {
    // S, L, O, I, B and Z are never used — they read too much like digits.
    expect("1SG4TE5MK73".match(MBI_PATTERN)).toBeNull();
    expect("1EG4TE5MO73".match(MBI_PATTERN)).toBeNull();
  });

  it("rejects an MBI with a letter where a digit belongs", () => {
    expect("1EGATE5MK73".match(MBI_PATTERN)).toBeNull();
  });

  it("flags a Social Security number", () => {
    expect(detectPhi("SSN 123-45-6789").map((p) => p.kind)).toContain("ssn");
  });

  it("flags a labelled date of birth", () => {
    expect(detectPhi("DOB: 01/02/1950").map((p) => p.kind)).toContain("dob");
  });

  it("flags a legacy Medicare number", () => {
    expect(detectPhi("HICN 123456789A").map((p) => p.kind)).toContain("hicn");
  });

  it("stays quiet on a letter with no identifiers", () => {
    expect(detectPhi("Please submit records for claim 2026123456789 within 45 days.")).toEqual([]);
  });

  it("reports a hint rather than the value itself", () => {
    const signals = detectPhi("SSN 123-45-6789");
    expect(JSON.stringify(signals)).not.toContain("123-45-6789");
  });

  it("redacts identifier-shaped text", () => {
    const out = redact("SSN 123-45-6789, MBI 1EG4TE5MK73, DOB: 01/02/1950");
    expect(out).not.toMatch(/123-45-6789/);
    expect(out).not.toMatch(/1EG4TE5MK73/);
    expect(out).toMatch(/REDACTED-SSN/);
    expect(out).toMatch(/REDACTED-MBI/);
    expect(out).toMatch(/REDACTED-DOB/);
  });

  it("says redaction is not a guarantee, because prose has no pattern", () => {
    const m = mail({ subject: "Records", text: "Please submit records. SSN 123-45-6789." });
    const out = renderClassification(m, classify(m));
    expect(out).toMatch(/POSSIBLE PHI/);
    expect(out).toMatch(/no pattern to match/);
  });

  it("explains the receipt rule only when a window is actually relative", () => {
    const relative = mail({ text: "Please submit the medical records within 45 days." });
    expect(renderClassification(relative, classify(relative))).toMatch(/runs from RECEIPT/);
    // A letter that names a fixed date has no receipt-relative window to explain.
    const absolute = mail({ text: "You must revalidate your enrollment by 10/31/2026." });
    const out = renderClassification(absolute, classify(absolute));
    expect(out).not.toMatch(/runs from RECEIPT/);
    expect(out).toMatch(/pulled by pattern/);
  });

  it("carries the PHI signal through classification", () => {
    const c = classify(mail({ text: "Member MBI 1EG4TE5MK73 was denied." }));
    expect(c.phi.map((p) => p.kind)).toContain("mbi");
  });
});

// ── Reports ──────────────────────────────────────────────────────────────────

const claim = (over: Partial<ClaimInput> = {}, lines?: Array<{ code: string; charge: number; date: string }>): ClaimInput =>
  ({
    claim_id: "C1",
    payer_name: "ACME",
    payer_id: "P1",
    billing_provider_npi: "1234567893",
    billing_provider_name: "CLINIC",
    subscriber_id: "M1",
    patient_last: "DOE",
    patient_first: "JANE",
    patient_dob: "19700101",
    patient_sex: "F",
    diagnoses: ["E11.65"],
    service_lines: (lines ?? [{ code: "99214", charge: 200, date: "20260501" }]).map((l) => ({
      cpt_hcpcs: l.code,
      charge: l.charge,
      units: 1,
      dx_pointers: [1],
      service_date: l.date,
      place_of_service: "11",
    })),
    ...over,
  }) as ClaimInput;

const stored = (id: string, over: Partial<StoredClaim> = {}, lines?: Array<{ code: string; charge: number; date: string }>): StoredClaim => ({
  claimId: id,
  payer: "ACME",
  claim: claim({ claim_id: id }, lines),
  createdAt: Date.UTC(2026, 4, 1),
  status: "submitted",
  ...over,
});

const NOW = Date.UTC(2026, 7, 7); // 2026-08-07

const eraFor = (claimId: string, statusCode: string, lines: EraServiceLine[], payer = "ACME"): StoredEra => ({
  payer,
  receivedAt: NOW,
  era: {
    payer,
    payee: "CLINIC",
    checkOrEftAmount: 0,
    claims: [
      {
        claimId,
        statusCode,
        charged: 200,
        paid: 0,
        patientResponsibility: 0,
        payerControlNumber: "PCN",
        lines,
      },
    ],
  } as Era,
});

const line = (over: Partial<EraServiceLine> = {}): EraServiceLine => ({
  procedure: "HC:99214",
  charged: 200,
  paid: 160,
  units: 1,
  adjustments: [{ group: "CO", carc: "45", amount: 40 }],
  rarcs: [],
  ...over,
});

describe("AR aging", () => {
  it("buckets by age", () => {
    expect(bucketFor(0)).toBe("0-30");
    expect(bucketFor(30)).toBe("0-30");
    expect(bucketFor(31)).toBe("31-60");
    expect(bucketFor(120)).toBe("91-120");
    expect(bucketFor(121)).toBe("120+");
  });

  it("ages from the date of service, not the date the claim was built", () => {
    // Service 2026-05-01, evaluated 2026-08-07 → 98 days.
    const ar = computeArAging([stored("C1")], [], NOW);
    expect(ar.rows[0].ageDays).toBe(98);
    expect(ar.rows[0].bucket).toBe("91-120");
  });

  it("drops a claim once a remittance names it", () => {
    const ar = computeArAging([stored("C1")], [eraFor("C1", "1", [line()])], NOW);
    expect(ar.rows).toEqual([]);
    expect(ar.adjudicated).toBe(1);
  });

  it("drops a DENIED claim from AR too", () => {
    // A denial is a denial to work, not accounts receivable. Leaving it in AR
    // double-counts it against the denial report.
    const ar = computeArAging([stored("C1")], [eraFor("C1", "4", [line({ paid: 0 })])], NOW);
    expect(ar.rows).toEqual([]);
  });

  it("matches claim identifiers regardless of case", () => {
    const ar = computeArAging([stored("c1")], [eraFor("C1", "1", [line()])], NOW);
    expect(ar.rows).toEqual([]);
  });

  it("totals by bucket and by payer", () => {
    const ar = computeArAging(
      [stored("C1"), stored("C2", { payer: "UHC" }, [{ code: "99213", charge: 100, date: "20260801" }])],
      [],
      NOW,
    );
    expect(ar.total).toBe(300);
    expect(ar.byBucket["91-120"].amount).toBe(200);
    expect(ar.byBucket["0-30"].amount).toBe(100);
    expect(ar.byPayer[0]).toEqual({ payer: "ACME", count: 1, amount: 200, oldestDays: 98 });
  });

  it("weights average age by dollars rather than by claim count", () => {
    // A large old claim should move the average more than a small new one.
    const ar = computeArAging(
      [
        stored("BIG", {}, [{ code: "X", charge: 900, date: "20260501" }]),
        stored("SMALL", {}, [{ code: "Y", charge: 100, date: "20260801" }]),
      ],
      [],
      NOW,
    );
    expect(ar.averageAgeDays).toBeGreaterThan(80);
  });

  it("falls back to the created date when a claim has no service date", () => {
    const noDate = stored("C1", {}, [{ code: "99214", charge: 200, date: "" }]);
    expect(computeArAging([noDate], [], NOW).rows[0].ageDays).toBe(98);
  });

  it("reports nothing outstanding when everything is adjudicated", () => {
    const ar = computeArAging([stored("C1")], [eraFor("C1", "1", [line()])], NOW);
    expect(ar.total).toBe(0);
    expect(ar.averageAgeDays).toBe(0);
  });
});

describe("denial summary", () => {
  it("ranks reasons by dollars rather than by count", () => {
    const eras = [
      eraFor("C1", "4", [
        line({ paid: 0, adjustments: [{ group: "CO", carc: "50", amount: 900 }] }),
        line({ paid: 0, adjustments: [{ group: "CO", carc: "16", amount: 10 }] }),
        line({ paid: 0, adjustments: [{ group: "CO", carc: "16", amount: 10 }] }),
      ]),
    ];
    const summary = computeDenialSummary(eras);
    // CARC 16 occurs more often; CARC 50 costs far more.
    expect(summary.byCarc[0].carc).toBe("50");
    expect(summary.byCarc[0].amount).toBe(900);
  });

  it("excludes patient responsibility, which is not a denial", () => {
    const eras = [
      eraFor("C1", "1", [line({ paid: 100, adjustments: [{ group: "PR", carc: "2", amount: 100 }] })]),
    ];
    expect(computeDenialSummary(eras).byCarc).toEqual([]);
  });

  it("resolves reason codes to their descriptions", () => {
    const eras = [eraFor("C1", "4", [line({ paid: 0, adjustments: [{ group: "CO", carc: "45", amount: 40 }] })])];
    expect(computeDenialSummary(eras).byCarc[0].description).toMatch(/fee schedule/i);
  });

  it("says so rather than guessing for a code outside the dataset", () => {
    const eras = [eraFor("C1", "4", [line({ paid: 0, adjustments: [{ group: "CO", carc: "ZZ9", amount: 5 }] })])];
    expect(computeDenialSummary(eras).byCarc[0].description).toMatch(/not in the bundled dataset/);
  });

  it("computes a per-payer denial rate", () => {
    const summary = computeDenialSummary([
      eraFor("C1", "4", [line({ paid: 0 })], "ACME"),
      eraFor("C2", "1", [line()], "ACME"),
    ]);
    const acme = summary.byPayer.find((p) => p.payer === "ACME")!;
    expect(acme.lines).toBe(2);
    expect(acme.denied).toBe(1);
    expect(acme.rate).toBe(0.5);
  });

  it("skips the synthetic claim-level line", () => {
    const summary = computeDenialSummary([
      eraFor("C1", "1", [line({ procedure: "(claim level)" }), line()]),
    ]);
    expect(summary.lines).toBe(1);
  });
});

describe("production", () => {
  it("groups charges by service month", () => {
    const p = computeProduction([
      stored("C1", {}, [{ code: "99214", charge: 200, date: "20260501" }]),
      stored("C2", {}, [{ code: "99213", charge: 100, date: "20260515" }]),
      stored("C3", {}, [{ code: "99213", charge: 100, date: "20260601" }]),
    ]);
    expect(p.rows.map((r) => r.period)).toEqual(["2026-05", "2026-06"]);
    expect(p.rows[0].charges).toBe(300);
    expect(p.totalCharges).toBe(400);
  });

  it("ranks procedures by charges", () => {
    const p = computeProduction([
      stored("C1", {}, [
        { code: "99214", charge: 200, date: "20260501" },
        { code: "36415", charge: 25, date: "20260501" },
      ]),
    ]);
    expect(p.byProcedure[0].code).toBe("99214");
  });

  it("computes a claim's charge across lines and units", () => {
    expect(claimCharge(claim({}, [{ code: "A", charge: 10, date: "20260101" }]))).toBe(10);
    expect(earliestServiceDate(claim({}, [{ code: "A", charge: 1, date: "20260601" }, { code: "B", charge: 1, date: "20260101" }]))).toBe(
      "20260101",
    );
  });
});

describe("report rendering", () => {
  const report = buildReport(
    [stored("C1"), stored("C2", { payer: "UHC" }, [{ code: "99213", charge: 100, date: "20260801" }])],
    [eraFor("C3", "4", [line({ paid: 0, adjustments: [{ group: "CO", carc: "50", amount: 200 }] })])],
    NOW,
  );

  it("quotes CSV fields containing commas", () => {
    expect(csvEscape("ACME, INC")).toBe('"ACME, INC"');
    expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe('a,b\n1,"x,y"');
  });

  it("writes one AR row per outstanding claim", () => {
    const rows = arAgingCsv(report).split("\n");
    expect(rows[0]).toMatch(/^claimId,payer,serviceDate/);
    expect(rows).toHaveLength(3);
  });

  it("shows every aging bucket, including the empty ones", () => {
    const md = summaryMarkdown(report);
    for (const label of AGING_LABELS) expect(md).toContain(`| ${label} |`);
  });

  it("warns about AR past ninety days and points at the filing check", () => {
    const md = summaryMarkdown(report);
    expect(md).toMatch(/over 90 days old/);
    expect(md).toMatch(/timely_filing_sweep/);
  });

  it("says the denial table is ranked by dollars", () => {
    expect(summaryMarkdown(report)).toMatch(/Ranked by dollars rather than by count/);
  });

  it("states what the numbers do not include", () => {
    expect(summaryMarkdown(report)).toMatch(/Claims submitted outside Orion/);
  });

  it("says plainly when no remittances have been parsed", () => {
    const bare = buildReport([stored("C1")], [], NOW);
    expect(summaryMarkdown(bare)).toMatch(/No remittances parsed yet/);
  });

  it("says plainly when nothing is outstanding", () => {
    const clean = buildReport([stored("C1")], [eraFor("C1", "1", [line()])], NOW);
    expect(summaryMarkdown(clean)).toMatch(/Nothing outstanding/);
  });
});
