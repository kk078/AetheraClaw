import { describe, expect, it } from "vitest";
import {
  DAYS_IN_AR_TARGET,
  FILING_JEOPARDY_DAYS,
  SPOKEN_MAX_CHARS,
  buildBriefing,
  orderItems,
  renderBriefing,
  type BriefingItem,
} from "../src/reports/briefing.js";
import type { KpiSet } from "../src/reports/kpi.js";
import type { StoredClaim, StoredEra } from "../src/reports/aggregate.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";
import type { Era } from "../src/tools/healthcare/x12/835.js";
import { DEFAULT_FILING_WINDOWS } from "../src/tools/healthcare/prediction/timely-filing.js";
import { speakCode } from "../src/speech/spoken-codes.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1); // 2026-06-01

// ── Synthetic inputs, no store ───────────────────────────────────────────────

function claim(id: string, charge: number, serviceDate: string, payer = "Medicare"): StoredClaim {
  const c: ClaimInput = {
    claim_id: id,
    payer_name: payer,
    payer_id: "P",
    billing_provider_npi: "1234567893",
    billing_provider_name: "Clinic",
    subscriber_id: "S1",
    patient_last: "T",
    patient_first: "P",
    patient_dob: "19700101",
    patient_sex: "U",
    diagnoses: ["E11.9"],
    service_lines: [
      { cpt_hcpcs: "99214", charge, units: 1, dx_pointers: [1], service_date: serviceDate, place_of_service: "11" },
    ],
  };
  return { claimId: id, payer, claim: c, createdAt: NOW - 30 * DAY, status: "submitted" };
}

function era(entries: Array<{ id: string; charged: number; paid: number; denied?: boolean }>, receivedAt: number): StoredEra {
  const e: Era = {
    payer: "Medicare",
    payee: "Clinic",
    checkOrEftAmount: 0,
    claims: entries.map((x) => ({
      claimId: x.id,
      statusCode: x.denied ? "4" : "1",
      charged: x.charged,
      paid: x.paid,
      patientResponsibility: 0,
      payerControlNumber: `PC-${x.id}`,
      lines: [
        {
          procedure: "99214",
          charged: x.charged,
          paid: x.paid,
          units: 1,
          rarcs: [],
          adjustments: [{ group: "CO", carc: x.denied ? "29" : "45", amount: x.charged - x.paid }],
        },
      ],
    })),
  };
  return { era: e, receivedAt, payer: "Medicare" };
}

/** Every figure computable and on target, so no KPI produces an item or a gap. */
function healthyKpis(): KpiSet {
  return {
    daysInAr: {
      days: 31,
      totalAr: 10_000,
      averageDailyCharges: 322.58,
      chargeWindowDays: 90,
      historyDays: 120,
      note: "Daily charges averaged over the trailing 90 days.",
    },
    cleanClaim: {
      acceptanceRate: 98.5,
      acceptedFirstPass: 197,
      acknowledged: 200,
      firstPassPaymentRate: 94.2,
      paidFirstPass: 188,
      adjudicated: 200,
      note: "",
    },
    netCollection: {
      rate: 97.1,
      payments: 97_100,
      recoupments: 0,
      unattributedRecoupments: 0,
      charges: 140_000,
      contractualAdjustments: 40_000,
      collectable: 100_000,
      claimsMeasured: 120,
      cohortEndsAt: NOW - 120 * DAY,
      note: "Measured over 120 settled claims.",
    },
  };
}

/** Nothing computable — the 8am case this module exists to get right. */
function nullKpis(): KpiSet {
  return {
    daysInAr: {
      days: null,
      totalAr: 0,
      averageDailyCharges: 0,
      chargeWindowDays: 1,
      historyDays: 1,
      note: "No charges in the measurement window, so there is nothing to divide by.",
    },
    cleanClaim: {
      acceptanceRate: null,
      acceptedFirstPass: 0,
      acknowledged: 0,
      firstPassPaymentRate: null,
      paidFirstPass: 0,
      adjudicated: 0,
      note: "No 277CA acknowledgments recorded, so front-end acceptance cannot be measured.",
    },
    netCollection: {
      rate: null,
      payments: 0,
      recoupments: 0,
      unattributedRecoupments: 0,
      charges: 0,
      contractualAdjustments: 0,
      collectable: 0,
      claimsMeasured: 0,
      cohortEndsAt: NOW - 120 * DAY,
      note: "No claims old enough to have finished paying have a remittance.",
    },
  };
}

function build(over: Partial<Parameters<typeof buildBriefing>[0]> = {}, opts?: Parameters<typeof buildBriefing>[1]) {
  return buildBriefing(
    {
      kpis: healthyKpis(),
      claims: [],
      eras: [],
      filingWindows: DEFAULT_FILING_WINDOWS,
      now: NOW,
      ...over,
    },
    opts,
  );
}

// ── Rule 1: ordered by what is lost, not by category ─────────────────────────

describe("ordering", () => {
  it("puts a closing filing window ahead of a KPI that moved", () => {
    const kpis = healthyKpis();
    kpis.daysInAr.days = 63; // well above target, so it produces an attention item

    // Medicare is one calendar year from the date of service: 2025-06-04 closes
    // 2026-06-04, three days after "now".
    const b = build({ kpis, claims: [claim("C1", 900, "20250604")] });

    expect(b.items[0].urgency).toBe("critical");
    expect(b.items[0].headline).toContain("final stretch");
    expect(b.items[0].deadlineDays).toBe(3);

    const kpiIndex = b.items.findIndex((i) => i.headline.includes("Days in accounts receivable"));
    expect(kpiIndex).toBeGreaterThan(0);
    expect(b.items[kpiIndex].urgency).toBe("attention");
  });

  it("sorts by urgency, then deadline proximity, then money", () => {
    const items: BriefingItem[] = [
      { urgency: "informational", headline: "info", detail: "", amount: 999_999 },
      { urgency: "attention", headline: "big money, no clock", detail: "", amount: 500_000 },
      { urgency: "critical", headline: "closing in 3 days, small", detail: "", amount: 100, deadlineDays: 3 },
      { urgency: "critical", headline: "closing in 3 days, large", detail: "", amount: 90_000, deadlineDays: 3 },
      { urgency: "critical", headline: "already expired", detail: "", amount: 50, deadlineDays: -12 },
    ];
    expect(orderItems(items).map((i) => i.headline)).toEqual([
      "already expired",
      "closing in 3 days, large",
      "closing in 3 days, small",
      "big money, no clock",
      "info",
    ]);
  });

  it("is a total order — the same items always render in the same sequence", () => {
    const items: BriefingItem[] = [
      { urgency: "attention", headline: "b", detail: "" },
      { urgency: "attention", headline: "a", detail: "" },
      { urgency: "attention", headline: "c", detail: "" },
    ];
    expect(orderItems(items).map((i) => i.headline)).toEqual(["a", "b", "c"]);
    expect(orderItems([...items].reverse()).map((i) => i.headline)).toEqual(["a", "b", "c"]);
  });
});

// ── Rule 2: a figure that cannot be computed is a gap, never a zero ──────────

describe("gaps", () => {
  it("reports every null KPI as a gap carrying the reason, and never speaks it as zero", () => {
    const b = build({ kpis: nullKpis() });

    expect(b.gaps.some((g) => g.startsWith("Net collection rate"))).toBe(true);
    expect(b.gaps.some((g) => g.startsWith("Days in A/R"))).toBe(true);
    expect(b.gaps.some((g) => g.startsWith("First-pass payment rate"))).toBe(true);
    expect(b.gaps.some((g) => g.includes("No claims old enough to have finished paying"))).toBe(true);

    // No item claims a rate, because no rate exists.
    expect(b.items.some((i) => /percent/.test(i.headline))).toBe(false);
    expect(b.spoken).not.toMatch(/zero percent/i);
    expect(b.spoken).not.toMatch(/\b0(\.0)?\s*(%|percent)/);
    expect(b.written).not.toMatch(/\b0(\.0)?%/);

    // Said out loud as a gap, with the abbreviation pronounced.
    expect(b.spoken).toContain("could not be computed");
    expect(b.spoken).toContain("Days in accounts receivable");
    expect(b.spoken).toContain("gaps, not zeros");
  });

  it("names outstanding claims whose payer has no filing window instead of passing them as safe", () => {
    const b = build({ claims: [claim("C9", 300, "20250101", "Weird Local Plan")] });
    expect(b.gaps.some((g) => g.includes("no filing window on file"))).toBe(true);
    expect(b.items.some((i) => i.urgency === "critical")).toBe(false);
  });
});

// ── Rule 3: timely filing is the critical band ───────────────────────────────

describe("timely filing", () => {
  it("counts the claims in the final stretch with the money and the nearest deadline", () => {
    const b = build({
      claims: [
        claim("C1", 400, "20250604"), // closes 2026-06-04 — 3 days out
        claim("C2", 600, "20250620"), // closes 2026-06-20 — 19 days out
        claim("C3", 900, "20251201"), // closes 2026-12-01 — far outside the band
      ],
    });

    const jeopardy = b.items.find((i) => i.headline.includes("final stretch"));
    expect(jeopardy).toBeDefined();
    expect(jeopardy?.urgency).toBe("critical");
    expect(jeopardy?.count).toBe(2);
    expect(jeopardy?.amount).toBe(1000);
    expect(jeopardy?.deadlineDays).toBe(3);
    expect(jeopardy?.detail).toContain("2026-06-04");
  });

  it("separates claims already past the deadline and sorts them first", () => {
    const b = build({ claims: [claim("C1", 400, "20250604"), claim("C2", 250, "20240101")] });
    expect(b.items[0].headline).toContain("past the filing deadline");
    expect(b.items[0].deadlineDays).toBeLessThan(0);
    expect(b.items[1].headline).toContain("final stretch");
  });

  it("ignores claims a remittance has already answered", () => {
    const claims = [claim("C1", 400, "20250604")];
    const b = build({ claims, eras: [era([{ id: "C1", charged: 400, paid: 300 }], NOW - 10 * DAY)] });
    expect(b.items.some((i) => i.headline.includes("final stretch"))).toBe(false);
  });

  it("honours a wider horizon", () => {
    const claims = [claim("C1", 400, "20250901")]; // closes 2026-09-01, 92 days out
    expect(build({ claims }).items.some((i) => i.headline.includes("final stretch"))).toBe(false);
    const wide = build({ claims }, { jeopardyDays: 120 });
    expect(wide.items.find((i) => i.headline.includes("final stretch"))?.deadlineDays).toBe(92);
    expect(FILING_JEOPARDY_DAYS).toBe(30);
  });
});

// ── Rule 4: one list of items, rendered twice ────────────────────────────────

describe("spoken and written", () => {
  it("are built from the same items and agree on how many there are", () => {
    const kpis = healthyKpis();
    kpis.daysInAr.days = DAYS_IN_AR_TARGET + 23;
    const b = build({
      kpis,
      claims: [claim("C1", 400, "20250604"), claim("C2", 250, "20240101")],
      eras: [era([{ id: "X1", charged: 500, paid: 0, denied: true }], NOW - 2 * 3_600_000)],
      policyChanges: [{ code: "99213", title: "Office visit policy revised", url: "https://example.test/policy" }],
    });

    expect(b.items.length).toBeGreaterThan(3);
    // Every item is numbered once in the written briefing.
    expect(b.written.match(/^\d+\. \[/gm)?.length).toBe(b.items.length);
    // And every item is in both renderings, in the same order.
    for (const item of b.items) {
      expect(b.written).toContain(item.headline);
      expect(b.spoken).toContain(item.headline);
    }
    const positions = b.items.map((i) => b.spoken.indexOf(i.headline));
    expect(positions).toEqual([...positions].sort((a, c) => a - c));

    // renderBriefing is the same renderer that produced `written`.
    expect(renderBriefing(b)).toBe(b.written);

    // Built for the ear: no tables, no URLs, no markdown.
    expect(b.spoken).not.toContain("http");
    expect(b.spoken).not.toContain("|");
    expect(b.spoken).not.toContain("#");
    expect(b.written).toContain("https://example.test/policy");
  });

  it("speaks codes and dollar figures the way a person says them", () => {
    const b = build({
      claims: [claim("C1", 4200, "20250604")],
      policyChanges: [{ code: "99213", title: "Office visit policy revised", url: "https://example.test/p" }],
    });

    expect(b.spoken).toContain("nine nine two one three"); // 99213, not "ninety-nine thousand"
    expect(b.spoken).toContain("four thousand two hundred dollars"); // $4200.00
    expect(b.spoken).not.toContain("$");
    expect(b.spoken).toContain("June fourth, twenty twenty six"); // the deadline, not "20260604"
  });
});

// ── Rule 5: a quiet morning is reported as a quiet morning ───────────────────

describe("quiet morning", () => {
  it("says so plainly and briefly rather than manufacturing bullet points", () => {
    const b = build();
    expect(b.items).toEqual([]);
    expect(b.gaps).toEqual([]);
    expect(b.spoken).toContain("Nothing needs a person this morning");
    expect(b.spoken.length).toBeLessThan(300);
    expect(b.written).toContain("Nothing needs a person this morning");
    expect(b.written.match(/^\d+\. \[/gm)).toBeNull();
  });

  it("still reports gaps on a quiet morning — silence about a missing figure is not good news", () => {
    const b = build({ kpis: nullKpis() });
    expect(b.items).toEqual([]);
    expect(b.gaps.length).toBeGreaterThan(0);
    expect(b.written).toContain("GAPS");
  });
});

// ── Rule 6: the two-minute cap cuts whole items ──────────────────────────────

describe("spoken length cap", () => {
  const WORDS = [
    "alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliett", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray",
    "yankee", "zulu",
  ];

  function manyChanges() {
    return WORDS.map((w, i) => ({
      code: String(91_000 + i),
      title: `Payer policy update ${w}`,
      url: `https://example.test/${w}`,
    }));
  }

  it("stays inside roughly two minutes and never cuts an item in half", () => {
    const changes = manyChanges();
    const b = build({ policyChanges: changes });

    expect(b.items.length).toBe(changes.length);
    expect(b.spoken.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    expect(b.written.match(/^\d+\. \[/gm)?.length).toBe(changes.length);

    // Whole items only: an item's headline is present exactly when its code is.
    for (const change of changes) {
      const headlinePresent = b.spoken.includes(`Policy change: ${change.title}`);
      const codePresent = b.spoken.includes(speakCode(change.code));
      expect(headlinePresent).toBe(codePresent);
    }
  });

  it("says how many items were not read out, and the arithmetic adds up", () => {
    const changes = manyChanges();
    const b = build({ policyChanges: changes });

    const read = changes.filter((c) => b.spoken.includes(`Policy change: ${c.title}`)).length;
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(changes.length);

    const remainder = /(\d+) further items? (?:was|were) not read out/.exec(b.spoken);
    expect(remainder).not.toBeNull();
    expect(Number(remainder?.[1])).toBe(changes.length - read);

    // The written briefing keeps all of them — nothing is lost, only unread.
    for (const change of changes) expect(b.written).toContain(change.title);
  });

  it("adds no remainder sentence when everything fits", () => {
    const b = build({ policyChanges: [{ code: "99213", title: "One small change", url: "https://example.test/x" }] });
    expect(b.spoken).not.toMatch(/not read out/);
    expect(b.spoken).toContain("Policy change: One small change");
  });
});
