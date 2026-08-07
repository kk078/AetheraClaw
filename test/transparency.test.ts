import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RECORD_BYTES,
  ObjectStreamer,
  chunked,
  extractRates,
  ingestRates,
  renderIngest,
  type RateRecord,
} from "../src/transparency/ingest.js";
import {
  DOLLAR_TYPES,
  MIN_RATES_FOR_BENCHMARK,
  benchmarkGroup,
  buildBenchmarks,
  comparabilityKey,
  groupRates,
  isDollarRate,
  percentile,
  percentileRank,
  positionAgainst,
  renderBenchmarks,
} from "../src/transparency/rates.js";
import {
  ADMIN_FEE_BEFORE_JUNE_2026_CENTS,
  ADMIN_FEE_CENTS,
  ADMIN_FEE_CHANGE_DATE,
  COOLING_OFF_CALENDAR_DAYS,
  IDRE_FEE_BATCHED_CENTS,
  IDRE_FEE_SINGLE_CENTS,
  INITIATION_WINDOW_BUSINESS_DAYS,
  MAX_BATCH_LINE_ITEMS,
  OPEN_NEGOTIATION_BUSINESS_DAYS,
  adminFeeCents,
  disputeEconomics,
  idrDeadlines,
  renderDispute,
} from "../src/transparency/idr.js";
import { businessDaysBetween } from "../src/tools/healthcare/operations/gfe.js";

// ── Streaming ────────────────────────────────────────────────────────────────

function feed(streamer: ObjectStreamer, text: string, chunkSize = 7): string[] {
  const out: string[] = [];
  for (const chunk of chunked(text, chunkSize)) out.push(...streamer.push(chunk));
  return out;
}

describe("ObjectStreamer", () => {
  it("emits each top-level object in an array", () => {
    const out = feed(new ObjectStreamer(), '[{"a":1},{"b":2},{"c":3}]');
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("handles nested objects without emitting them separately", () => {
    const out = feed(new ObjectStreamer(), '[{"a":{"b":{"c":1}}},{"d":2}]');
    expect(out).toEqual(['{"a":{"b":{"c":1}}}', '{"d":2}']);
  });

  it("does not close on a brace inside a string", () => {
    // The trap that catches every first attempt. A naive depth counter closes
    // here early, and everything after is misaligned garbage that still parses
    // often enough to look like it worked.
    const text = '[{"name":"Removal of foreign body {see note}","code":"10120"},{"code":"99213"}]';
    const out = feed(new ObjectStreamer(), text);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]).code).toBe("10120");
    expect(JSON.parse(out[1]).code).toBe("99213");
  });

  it("handles an escaped quote inside a string", () => {
    const text = '[{"name":"a \\" brace } here","code":"1"},{"code":"2"}]';
    const out = feed(new ObjectStreamer(), text);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]).code).toBe("1");
  });

  it("handles an escaped backslash before a quote", () => {
    const text = '[{"path":"C:\\\\","code":"1"},{"code":"2"}]';
    const out = feed(new ObjectStreamer(), text);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]).code).toBe("1");
  });

  it("does not care where the chunk boundaries fall", () => {
    const text = '[{"name":"a } b","code":"10120"},{"code":"99213"}]';
    for (const size of [1, 2, 3, 5, 13, 1000]) {
      const out = feed(new ObjectStreamer(), text, size);
      expect(out.map((o) => JSON.parse(o).code)).toEqual(["10120", "99213"]);
    }
  });

  it("bounds memory to one record rather than the file", () => {
    // The whole design. A file far larger than the buffer streams through with
    // peak usage the size of its largest single record.
    const record = `{"billing_code":"99213","pad":"${"x".repeat(2000)}"}`;
    const text = `[${Array.from({ length: 500 }, () => record).join(",")}]`;
    const streamer = new ObjectStreamer(64 * 1024);
    const out = feed(streamer, text, 4096);
    expect(out).toHaveLength(500);
    expect(streamer.stats.consumed).toBeGreaterThan(1_000_000);
    expect(streamer.stats.peakRecordBytes).toBeLessThan(4000);
  });

  it("abandons an oversized record and resynchronizes on the next one", () => {
    const huge = `{"code":"BIG","pad":"${"x".repeat(5000)}"}`;
    const small = '{"code":"OK"}';
    const streamer = new ObjectStreamer(1000);
    const out = feed(streamer, `[${huge},${small}]`, 256);
    expect(streamer.stats.oversize).toBe(1);
    expect(out.map((o) => JSON.parse(o).code)).toEqual(["OK"]);
  });

  it("reports a part-read record when the file is truncated", () => {
    const streamer = new ObjectStreamer();
    feed(streamer, '[{"a":1},{"b":');
    expect(streamer.pending).toBe(true);
  });

  it("is not pending after a clean finish", () => {
    const streamer = new ObjectStreamer();
    feed(streamer, '[{"a":1}]');
    expect(streamer.pending).toBe(false);
  });

  it("defaults to a sane record bound", () => {
    expect(DEFAULT_MAX_RECORD_BYTES).toBe(8 * 1024 * 1024);
  });
});

// ── Extraction ───────────────────────────────────────────────────────────────

const RECORD = {
  billing_code: "99213",
  billing_code_type: "CPT",
  name: "Office visit, established patient",
  negotiated_rates: [
    {
      provider_groups: [{ tin: { value: "12-3456789" }, npi: [1234567893] }],
      negotiated_prices: [
        { negotiated_type: "negotiated", negotiated_rate: 112.5, billing_class: "professional", service_code: ["11"] },
        { negotiated_type: "percentage", negotiated_rate: 145, billing_class: "professional" },
      ],
    },
    {
      provider_references: [7, 9],
      negotiated_prices: [{ negotiated_type: "negotiated", negotiated_rate: 98.0, billing_class: "professional" }],
    },
  ],
};

describe("extractRates", () => {
  it("pulls every price out of every rate group", () => {
    const rates = extractRates(RECORD, "test");
    expect(rates).toHaveLength(3);
    expect(rates.map((r) => r.rate)).toEqual([112.5, 145, 98]);
  });

  it("keeps the negotiated type, which decides what the number means", () => {
    const rates = extractRates(RECORD, "test");
    expect(rates[0].negotiatedType).toBe("negotiated");
    expect(rates[1].negotiatedType).toBe("percentage");
  });

  it("identifies the provider side by TIN, NPI or reference", () => {
    const rates = extractRates(RECORD, "test");
    expect(rates[0].providerRef).toContain("12-3456789");
    expect(rates[2].providerRef).toBe("7,9");
  });

  it("skips a price with no usable rate", () => {
    const broken = { billing_code: "99213", negotiated_rates: [{ negotiated_prices: [{ negotiated_rate: undefined }] }] };
    expect(extractRates(broken, "test")).toEqual([]);
  });

  it("returns nothing for a record with no billing code", () => {
    expect(extractRates({ negotiated_rates: [] }, "test")).toEqual([]);
  });
});

describe("ingestRates", () => {
  const file = `[${JSON.stringify(RECORD)},${JSON.stringify({ ...RECORD, billing_code: "99214" })}]`;

  it("keeps only the codes asked for", async () => {
    const result = await ingestRates(chunked(file, 32), { codes: ["99213"], source: "s" });
    expect(new Set(result.rates.map((r) => r.billingCode))).toEqual(new Set(["99213"]));
    expect(result.skipped).toBe(1);
  });

  it("normalizes the code so 99213 and 99213 with whitespace agree", async () => {
    const result = await ingestRates(chunked(file, 32), { codes: [" 99213 "], source: "s" });
    expect(result.rates.length).toBeGreaterThan(0);
  });

  it("warns when no filter was given, which is the case it exists to avoid", async () => {
    const result = await ingestRates(chunked(file, 32), { codes: [], source: "s" });
    expect(result.warnings.join(" ")).toContain("this module exists to avoid");
  });

  it("stops at the limit and says there is more", async () => {
    const result = await ingestRates(chunked(file, 32), { codes: [], source: "s", limit: 2 });
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(" ")).toContain("more in the file");
  });

  it("survives one unparseable record without losing the file", async () => {
    const broken = `[{"billing_code":"99213","bad":,},${JSON.stringify({ ...RECORD, billing_code: "99215" })}]`;
    const result = await ingestRates(chunked(broken, 16), { codes: [], source: "s" });
    expect(result.rates.some((r) => r.billingCode === "99215")).toBe(true);
  });

  it("warns on a truncated file", async () => {
    const result = await ingestRates(chunked('[{"billing_code":"99213","negotiated', 8), { codes: [], source: "s" });
    expect(result.warnings.join(" ")).toContain("truncated in transit");
  });

  it("says the file itself was never held", async () => {
    const result = await ingestRates(chunked(file, 32), { codes: ["99213"], source: "s" });
    expect(renderIngest(result)).toContain("never held");
  });
});

// ── Rates ────────────────────────────────────────────────────────────────────

function rate(over: Partial<RateRecord> = {}): RateRecord {
  return {
    billingCode: "99213",
    billingCodeType: "CPT",
    description: "",
    negotiatedType: "negotiated",
    billingClass: "professional",
    rate: 100,
    serviceCodes: [],
    expirationDate: "",
    providerRef: "p",
    source: "a",
    ...over,
  };
}

describe("comparability", () => {
  it("separates dollars from percentages", () => {
    // A rate of 250 is $250 under 'negotiated' and 250% of Medicare under
    // 'percentage'. Averaging them yields a number that is neither.
    const groups = groupRates([rate({ rate: 250 }), rate({ rate: 250, negotiatedType: "percentage" })]);
    expect(groups).toHaveLength(2);
    expect(comparabilityKey(rate())).not.toBe(comparabilityKey(rate({ negotiatedType: "percentage" })));
  });

  it("separates professional from institutional", () => {
    const groups = groupRates([rate(), rate({ billingClass: "institutional" })]);
    expect(groups).toHaveLength(2);
  });

  it("knows which types are dollar amounts", () => {
    expect(DOLLAR_TYPES).toEqual(["negotiated", "derived", "fee schedule"]);
    expect(isDollarRate("percentage")).toBe(false);
    expect(isDollarRate("per diem")).toBe(false);
    expect(isDollarRate("negotiated")).toBe(true);
  });

  it("labels the unit so a percentage never prints with a dollar sign", () => {
    const [dollars, percent] = buildBenchmarks([rate(), rate({ negotiatedType: "percentage", rate: 145 })]);
    expect([dollars.unit, percent.unit].sort()).toEqual(["dollars", "percent"]);
    const text = renderBenchmarks([rate({ negotiatedType: "percentage", rate: 145 })].map((r) => benchmarkGroup(groupRates([r])[0])));
    expect(text).toContain("145.0%");
    expect(text).not.toContain("$145");
  });
});

describe("percentile", () => {
  it("interpolates between values", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBeCloseTo(25, 5);
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 1)).toBe(40);
  });

  it("handles an empty list", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("percentileRank", () => {
  it("puts a value at the middle of its ties", () => {
    expect(percentileRank(20, [10, 20, 20, 30])).toBeCloseTo(0.5, 5);
  });

  it("is 0 below everything and 1 above everything", () => {
    expect(percentileRank(1, [10, 20])).toBe(0);
    expect(percentileRank(99, [10, 20])).toBe(1);
  });
});

describe("positionAgainst", () => {
  const many = (values: number[]) => groupRates(values.map((v) => rate({ rate: v, providerRef: String(v) })))[0];

  it("calls out a bottom-quartile rate as the strongest case", () => {
    const p = positionAgainst(70, many([70, 100, 105, 110, 115, 120, 125, 130, 135, 140]));
    expect(p.percentileRank).toBeLessThan(0.25);
    expect(p.verdict).toContain("strongest case");
    expect(p.gapToMedian).toBeGreaterThan(0);
  });

  it("says to spend the negotiation elsewhere when already top quartile", () => {
    const p = positionAgainst(200, many([70, 100, 105, 110, 115, 120, 125, 130, 135, 140]));
    expect(p.verdict).toContain("elsewhere");
  });

  it("refuses to call a handful of rates a market", () => {
    const p = positionAgainst(70, many([100, 110, 120]));
    expect(p.benchmark.thin).toBe(true);
    expect(p.verdict).toContain("no good answer");
    expect(MIN_RATES_FOR_BENCHMARK).toBe(8);
  });

  it("reports a mid-range rate as a weak argument", () => {
    const p = positionAgainst(115, many([70, 100, 105, 110, 115, 120, 125, 130, 135, 140]));
    expect(p.verdict).toContain("weak argument");
  });
});

describe("renderBenchmarks", () => {
  it("always warns that the providers behind the rates matter", () => {
    expect(renderBenchmarks(buildBenchmarks([rate()]))).toContain("academic medical centre");
  });

  it("explains why non-dollar groups are listed apart", () => {
    const text = renderBenchmarks(buildBenchmarks([rate(), rate({ negotiatedType: "percentage", rate: 250 })]));
    expect(text).toContain("can mean $250 or 250% of Medicare");
  });

  it("handles nothing to benchmark", () => {
    expect(renderBenchmarks([])).toBe("No rates to benchmark.");
  });
});

// ── IDR deadlines ────────────────────────────────────────────────────────────

describe("idrDeadlines", () => {
  it("runs open negotiation for 30 business days", () => {
    const d = idrDeadlines("20260601");
    expect(businessDaysBetween("20260601", d.openNegotiationEnds)).toBe(OPEN_NEGOTIATION_BUSINESS_DAYS);
  });

  it("opens the initiation window on the 31st business day and keeps it four wide", () => {
    const d = idrDeadlines("20260601");
    expect(businessDaysBetween("20260601", d.initiationOpens)).toBe(OPEN_NEGOTIATION_BUSINESS_DAYS + 1);
    expect(businessDaysBetween(d.initiationOpens, d.initiationCloses)).toBe(INITIATION_WINDOW_BUSINESS_DAYS - 1);
  });

  it("puts the portal response on the 15th business day", () => {
    const d = idrDeadlines("20260601");
    expect(businessDaysBetween("20260601", d.responseDue)).toBe(15);
  });

  it("lands the windows on weekdays", () => {
    const d = idrDeadlines("20260601");
    for (const date of [d.responseDue, d.openNegotiationEnds, d.initiationOpens, d.initiationCloses]) {
      const day = new Date(
        Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))),
      ).getUTCDay();
      expect(day).toBeGreaterThan(0);
      expect(day).toBeLessThan(6);
    }
  });

  it("extends the window when a cooling-off period swallows the negotiation", () => {
    // The one forgiving corner of this process: 30 business days instead of 4.
    const d = idrDeadlines("20260601", { priorDeterminationOn: "20260701" });
    expect(d.coolingOff).toBe(true);
    expect(businessDaysBetween(d.initiationOpens, d.initiationCloses)).toBe(29);
    expect(d.notes.join(" ")).toContain(String(COOLING_OFF_CALENDAR_DAYS));
  });

  it("does not call an extended window four days wide", () => {
    const d = idrDeadlines("20260601", { priorDeterminationOn: "20260701" });
    const notes = d.notes.join(" ");
    expect(notes).toContain("30 business days rather than the usual 4");
    expect(notes).not.toContain("is 4 business days wide");
  });

  it("ignores a prior determination that is long past", () => {
    expect(idrDeadlines("20260601", { priorDeterminationOn: "20250101" }).coolingOff).toBe(false);
  });

  it("says outright that there is no late filing", () => {
    expect(idrDeadlines("20260601").notes.join(" ")).toContain("no late filing");
  });
});

describe("adminFeeCents", () => {
  it("uses the reduced fee from 11 June 2026", () => {
    expect(adminFeeCents(ADMIN_FEE_CHANGE_DATE)).toBe(ADMIN_FEE_CENTS);
    expect(adminFeeCents("20260701")).toBe(1_500);
  });

  it("uses the old fee before that", () => {
    expect(adminFeeCents("20260610")).toBe(ADMIN_FEE_BEFORE_JUNE_2026_CENTS);
    expect(adminFeeCents("20260610")).toBe(11_500);
  });
});

// ── IDR economics ────────────────────────────────────────────────────────────

describe("disputeEconomics", () => {
  const base = { winProbability: 0.5, initiatedOn: "20260701" };

  it("says no to a small claim filed alone", () => {
    // At even odds a loss costs the arbitrator's fee, and $300 does not cover it.
    const e = disputeEconomics({ ...base, amountInDisputeCents: 30_000, lineItems: 1 });
    expect(e.worthIt).toBe(false);
    expect(e.expectedValueCents).toBeLessThan(0);
  });

  it("says yes to the same claim batched fifty ways", () => {
    // The lever the whole module points at: fifty line items share one fee.
    const e = disputeEconomics({ ...base, amountInDisputeCents: 30_000 * 50, lineItems: 50 });
    expect(e.worthIt).toBe(true);
    expect(e.reasons.join(" ")).toContain("biggest lever");
  });

  it("evaluates at the top of the fee range, not the bottom", () => {
    const e = disputeEconomics({ ...base, amountInDisputeCents: 60_000, lineItems: 1 });
    expect(e.expectedValueOptimisticCents).toBeGreaterThan(e.expectedValueCents);
    expect(e.idreFeeHighCents).toBe(IDRE_FEE_SINGLE_CENTS.max);
  });

  it("refuses a case that only works with a cheap arbitrator", () => {
    const e = disputeEconomics({ ...base, amountInDisputeCents: 40_000, lineItems: 1 });
    expect(e.expectedValueOptimisticCents).toBeGreaterThan(0);
    expect(e.expectedValueCents).toBeLessThan(0);
    expect(e.worthIt).toBe(false);
    expect(e.reasons.join(" ")).toContain("Treat that as a no");
  });

  it("uses the batched fee range once there is more than one item", () => {
    const single = disputeEconomics({ ...base, amountInDisputeCents: 100_000, lineItems: 1 });
    const batched = disputeEconomics({ ...base, amountInDisputeCents: 100_000, lineItems: 10 });
    expect(single.idreFeeHighCents).toBe(IDRE_FEE_SINGLE_CENTS.max);
    expect(batched.idreFeeHighCents).toBe(IDRE_FEE_BATCHED_CENTS.max);
  });

  it("refuses a batch over the line-item limit", () => {
    const e = disputeEconomics({ ...base, amountInDisputeCents: 10_000_000, lineItems: MAX_BATCH_LINE_ITEMS + 1 });
    expect(e.overBatchLimit).toBe(true);
    expect(e.worthIt).toBe(false);
    expect(e.reasons.join(" ")).toContain("the second batch is not free");
  });

  it("computes a break-even that matches the verdict", () => {
    const e = disputeEconomics({ ...base, amountInDisputeCents: 1, lineItems: 1 });
    const atBreakEven = disputeEconomics({
      ...base,
      amountInDisputeCents: Math.ceil(e.breakEvenCents) + 1,
      lineItems: 1,
    });
    expect(atBreakEven.worthIt).toBe(true);
    const below = disputeEconomics({ ...base, amountInDisputeCents: Math.floor(e.breakEvenCents) - 1, lineItems: 1 });
    expect(below.worthIt).toBe(false);
  });

  it("names the batch limit as the blocker rather than calling good economics bad", () => {
    const e = disputeEconomics({ ...base, amountInDisputeCents: 10_000_000, lineItems: MAX_BATCH_LINE_ITEMS + 10 });
    expect(e.expectedValueCents).toBeGreaterThan(0);
    expect(e.worthIt).toBe(false);
    const text = renderDispute(e);
    expect(text).toContain("Cannot be filed as one batch");
    expect(text).not.toContain("Not worth disputing");
    expect(text).not.toContain("Treat that as a no");
  });

  it("questions an over-confident win probability", () => {
    const e = disputeEconomics({ ...base, winProbability: 0.95, amountInDisputeCents: 100_000, lineItems: 1 });
    expect(e.reasons.join(" ")).toContain("baseball arbitration");
  });

  it("handles a zero win probability without dividing by zero", () => {
    const e = disputeEconomics({ ...base, winProbability: 0, amountInDisputeCents: 100_000, lineItems: 1 });
    expect(e.breakEvenCents).toBe(Number.POSITIVE_INFINITY);
    expect(e.worthIt).toBe(false);
  });

  it("charges the old admin fee for a dispute initiated before the change", () => {
    const before = disputeEconomics({ ...base, amountInDisputeCents: 100_000, lineItems: 1, initiatedOn: "20260101" });
    expect(before.adminFeeCents).toBe(ADMIN_FEE_BEFORE_JUNE_2026_CENTS);
  });
});

describe("renderDispute", () => {
  it("says the loser pays the arbitrator", () => {
    const text = renderDispute(
      disputeEconomics({ amountInDisputeCents: 100_000, lineItems: 1, winProbability: 0.5, initiatedOn: "20260701" }),
    );
    expect(text).toContain("paid entirely by the loser");
  });

  it("explains that there is no meeting in the middle", () => {
    const text = renderDispute(
      disputeEconomics({ amountInDisputeCents: 100_000, lineItems: 1, winProbability: 0.5, initiatedOn: "20260701" }),
    );
    expect(text).toContain("no meeting in the middle");
  });

  it("warns that business days are not calendar days", () => {
    const text = renderDispute(
      disputeEconomics({ amountInDisputeCents: 100_000, lineItems: 1, winProbability: 0.5, initiatedOn: "20260701" }),
      idrDeadlines("20260601"),
    );
    expect(text).toContain("six calendar weeks");
  });
});
