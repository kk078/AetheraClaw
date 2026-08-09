import { describe, expect, it } from "vitest";
import {
  contentTerms,
  dedupeQueries,
  extractEntities,
  planPolicyWatch,
  planResearch,
} from "../src/research/plan.js";
import {
  dedupeResults,
  decodeEntities,
  duckDuckGoUrl,
  filterByDomains,
  normalizeUrl,
  parseDuckDuckGoHtml,
  parseResultsFromText,
  rankResults,
  unwrapDdgRedirect,
  type SearchResult,
} from "../src/research/search.js";
import { describeTiers, registrableDomain, sourceTier } from "../src/research/credibility.js";
import {
  numericTokens,
  renderCited,
  splitSentences,
  synthesizeFindings,
  type SourceDoc,
} from "../src/research/synthesize.js";
import {
  classifyChange,
  extractEffectiveDate,
  filterMatchesSince,
  matchPolicyToBilledCodes,
  summarizeImpact,
  type PolicyFinding,
} from "../src/research/policy-watch.js";
import { researchDeepTool, researchPayerPolicyTool, researchTools } from "../src/research/tools.js";

// A trimmed but structurally faithful html.duckduckgo.com results page: every
// destination is behind the /l/?uddg= redirector, the title carries HTML
// entities, and one "result" is DuckDuckGo's own navigation.
const DDG_HTML = `
<div class="serp__results">
  <div id="links" class="results">
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cms.gov%2Fmedicare%2Fpayment%2Ffee-schedules%2Fphysician%3Futm_source%3Dnewsletter&amp;rut=9f1c">Centers for Medicare &amp; Medicaid Services &#8212; Physician Fee Schedule</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cms.gov%2F&amp;rut=9f1c">The <b>CY 2026</b> Physician Fee Schedule final rule is effective January 1, 2026.</a>
        <div class="result__extras"><span class="result__url">www.cms.gov</span></div>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.aetna.com%2Fhealth-care-professionals%2Fpolicy.html&amp;rut=22ab">Aetna Reimbursement Policy &#8211; Office Visits</a>
        </h2>
        <div class="result__snippet">Aetna&#39;s policy for <b>99213</b> office visits.</div>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cms.gov%2Fmedicare%2Fpayment%2Ffee-schedules%2Fphysician%2F&amp;rut=77de">CMS Physician Fee Schedule (duplicate link)</a>
        </h2>
        <div class="result__snippet">Same page, different campaign tag.</div>
      </div>
    </div>
    <div class="result results_links">
      <div class="links_main result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="https://duckduckgo.com/html/?q=more+results&amp;s=30">More results</a>
        </h2>
      </div>
    </div>
  </div>
</div>
`;

// ── Planning ─────────────────────────────────────────────────────────────────

describe("research planning", () => {
  it("recognizes the entities that decide which document answers the question", () => {
    const e = extractEntities("Does UnitedHealthcare cover CPT 99213 via telehealth in 2026, and how is it reported on the 837P?");
    expect(e.codes).toContain("99213");
    expect(e.payers).toContain("UnitedHealthcare");
    expect(e.years).toContain("2026");
    expect(e.forms).toContain("837P");
    expect(e.keywords).toContain("telehealth");
    // Entities are removed from the topic residue so queries do not repeat them.
    expect(e.keywords).not.toContain("99213");
    expect(e.keywords).not.toContain("unitedhealthcare");
    expect(e.keywords).not.toContain("2026");
  });

  it("does not read a diagnosis code out of the middle of a HCPCS code", () => {
    // The ICD-10 pattern matches "J18" inside "J1885" unless it is anchored on
    // both ends; that false positive would send a search after a pneumonia code.
    const e = extractEntities("What documentation does Medicare want for J1885?");
    expect(e.codes).toContain("J1885");
    expect(e.diagnoses).toEqual([]);
  });

  it("still finds a real ICD-10 code alongside a procedure code", () => {
    const e = extractEntities("Is E11.9 an acceptable diagnosis for 95251?");
    expect(e.diagnoses).toContain("E11.9");
    expect(e.codes).toContain("95251");
  });

  it("normalizes paper form numbers", () => {
    expect(extractEntities("How do I complete box 24J on the CMS 1500?").forms).toContain("CMS-1500");
    expect(extractEntities("Reading a 835 remittance").forms).toContain("835");
  });

  it("treats two queries that differ only in word order as one query", () => {
    const deduped = dedupeQueries([
      "99213 telehealth coverage policy",
      "coverage policy telehealth 99213",
      "telehealth 99213 policy coverage",
      "99213 telehealth billing guidelines",
    ]);
    expect(deduped).toEqual(["99213 telehealth coverage policy", "99213 telehealth billing guidelines"]);
  });

  it("emits distinct sub-queries and never more than the cap", () => {
    const plan = planResearch("Does UnitedHealthcare cover CPT 99213 via telehealth in 2026?");
    expect(plan.subQueries.length).toBeGreaterThan(1);
    expect(plan.subQueries.length).toBeLessThanOrEqual(4);
    const keys = plan.subQueries.map((q) => [...new Set(contentTerms(q))].sort().join(" "));
    expect(new Set(keys).size).toBe(plan.subQueries.length);
    expect(plan.subQueries.some((q) => q.includes("99213"))).toBe(true);
    expect(plan.rationale).toContain("99213");
  });

  it("is deterministic — the same question always plans the same searches", () => {
    const q = "Cigna prior authorization for 97110 in 2026";
    expect(planResearch(q)).toEqual(planResearch(q));
  });

  it("honours maxQueries", () => {
    const plan = planResearch("Aetna coverage for 99213 97110 J1885 telehealth 2026", { maxQueries: 2 });
    expect(plan.subQueries).toHaveLength(2);
  });

  it("falls back to the question's own words when nothing is recognizable", () => {
    const plan = planResearch("What is a clearinghouse rejection?");
    expect(plan.subQueries.length).toBeGreaterThan(0);
    expect(plan.rationale).toContain("No code, payer, form or year was recognizable");
    expect(plan.subQueries.some((q) => q.includes("clearinghouse"))).toBe(true);
  });

  it("aims the policy plan at bulletins and transmittals for the supplied codes", () => {
    const plan = planPolicyWatch({ payer: "Aetna", codes: ["99213", "97110"], since: "20260101" });
    expect(plan.subQueries.some((q) => q.includes("99213"))).toBe(true);
    expect(plan.subQueries.join(" ")).toMatch(/bulletin|policy update|reimbursement policy/i);
    expect(plan.rationale).toContain("Aetna");
  });
});

// ── Search-result parsing ────────────────────────────────────────────────────

describe("DuckDuckGo result parsing", () => {
  const results = parseDuckDuckGoHtml(DDG_HTML);

  it("unwraps the /l/?uddg= redirect to the real destination", () => {
    expect(results[0].url).toBe(
      "https://www.cms.gov/medicare/payment/fee-schedules/physician?utm_source=newsletter",
    );
    expect(results.every((r) => !r.url.includes("duckduckgo.com"))).toBe(true);
  });

  it("decodes HTML entities in titles and snippets", () => {
    expect(results[0].title).toBe("Centers for Medicare & Medicaid Services — Physician Fee Schedule");
    expect(results[0].snippet).toContain("CY 2026");
    expect(results[1].title).toBe("Aetna Reimbursement Policy – Office Visits");
    expect(results[1].snippet).toBe("Aetna's policy for 99213 office visits.");
  });

  it("keeps the engine's ordering and drops DuckDuckGo's own navigation links", () => {
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(results).toHaveLength(3);
  });

  it("unwraps a redirect href on its own, and passes through anything that is not one", () => {
    expect(unwrapDdgRedirect("//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cms.gov%2Ffoo&amp;rut=1")).toBe(
      "https://www.cms.gov/foo",
    );
    expect(unwrapDdgRedirect("https://www.cms.gov/foo")).toBe("https://www.cms.gov/foo");
    expect(unwrapDdgRedirect("//www.cms.gov/foo")).toBe("https://www.cms.gov/foo");
  });

  it("decodes named, decimal and hex character references", () => {
    expect(decodeEntities("A &amp; B &#8212; C &#x2014; D &quot;E&quot;")).toBe('A & B — C — D "E"');
  });

  it("recovers leads from a results page whose markup was already stripped", () => {
    // fetchTextGuarded strips HTML from text/html responses, so the parser has to
    // cope with a page that arrives as prose.
    const stripped = "Physician Fee Schedule www.cms.gov/medicare/payment CMS billing https://www.aapc.com/blog/99213";
    const recovered = parseResultsFromText(stripped);
    expect(recovered.map((r) => r.url)).toEqual([
      "https://www.cms.gov/medicare/payment",
      "https://www.aapc.com/blog/99213",
    ]);
    expect(parseDuckDuckGoHtml(stripped).map((r) => r.url)).toEqual(recovered.map((r) => r.url));
  });

  it("builds the search URL the project already uses", () => {
    expect(duckDuckGoUrl("99213 coverage")).toBe("https://html.duckduckgo.com/html/?q=99213%20coverage");
  });
});

// ── Dedupe and ranking ───────────────────────────────────────────────────────

const result = (url: string, rank: number): SearchResult => ({ title: url, url, snippet: "", rank });

describe("result dedupe and ranking", () => {
  it("normalizes away scheme, www., trailing slash and tracking parameters", () => {
    expect(normalizeUrl("https://www.cms.gov/policy/")).toBe("cms.gov/policy");
    expect(normalizeUrl("http://cms.gov/policy?utm_source=x&utm_campaign=y")).toBe("cms.gov/policy");
    expect(normalizeUrl("https://cms.gov/policy?fbclid=abc&gclid=def")).toBe("cms.gov/policy");
    // A parameter that actually selects content is NOT tracking and must survive.
    expect(normalizeUrl("https://cms.gov/policy?id=42&utm_medium=email")).toBe("cms.gov/policy?id=42");
  });

  it("collapses the same page arriving with different campaign tags", () => {
    const deduped = dedupeResults([
      result("https://www.cms.gov/policy?utm_source=newsletter", 1),
      result("http://cms.gov/policy/", 2),
      result("https://cms.gov/policy?gclid=zz", 3),
      result("https://www.cms.gov/other", 4),
    ]);
    expect(deduped.map((r) => r.url)).toEqual([
      "https://www.cms.gov/policy?utm_source=newsletter",
      "https://www.cms.gov/other",
    ]);
  });

  it("dedupes the fixture's duplicate CMS link", () => {
    const deduped = dedupeResults(parseDuckDuckGoHtml(DDG_HTML));
    expect(deduped).toHaveLength(2);
    expect(deduped.map((r) => r.url)).toEqual([
      "https://www.cms.gov/medicare/payment/fee-schedules/physician?utm_source=newsletter",
      "https://www.aetna.com/health-care-professionals/policy.html",
    ]);
  });

  it("orders by tier, then by the engine's own rank", () => {
    const ranked = rankResults([
      result("https://billingblog.example.com/post", 1),
      result("https://www.aapc.com/blog/x", 2),
      result("https://www.cms.gov/b", 3),
      result("https://www.aetna.com/p", 4),
      result("https://www.cms.gov/a", 5),
    ]);
    expect(ranked.map((r) => r.url)).toEqual([
      "https://www.cms.gov/b",
      "https://www.cms.gov/a",
      "https://www.aetna.com/p",
      "https://www.aapc.com/blog/x",
      "https://billingblog.example.com/post",
    ]);
  });

  it("filters by domain on the host, so a lookalike domain is not included", () => {
    const results = [
      result("https://mcd.cms.gov/a", 1),
      result("https://cms.gov.evil.com/a", 2),
      result("https://www.aetna.com/a", 3),
    ];
    expect(filterByDomains(results, { include: ["cms.gov"] }).map((r) => r.url)).toEqual(["https://mcd.cms.gov/a"]);
    expect(filterByDomains(results, { exclude: ["aetna.com"] })).toHaveLength(2);
    expect(filterByDomains(results, {})).toHaveLength(3);
  });
});

// ── Credibility ──────────────────────────────────────────────────────────────

describe("source credibility", () => {
  it("reduces a host to the domain someone had to register", () => {
    expect(registrableDomain("www.cms.gov")).toBe("cms.gov");
    expect(registrableDomain("mcd.cms.gov")).toBe("cms.gov");
    expect(registrableDomain("a.b.c.example.co.uk")).toBe("example.co.uk");
  });

  it("tiers subdomains of a primary source as primary", () => {
    expect(sourceTier("https://www.cms.gov/medicare").tier).toBe("primary");
    expect(sourceTier("https://mcd.cms.gov/view/lcd.aspx?lcdid=33822").tier).toBe("primary");
    expect(sourceTier("https://www.federalregister.gov/documents/2025/11/01/x").tier).toBe("primary");
    expect(sourceTier("https://x12.org/products/technical-reports").tier).toBe("primary");
  });

  it("does NOT treat a lookalike domain as the government", () => {
    // The whole reason tiering runs on the registrable domain: a substring test
    // for "cms.gov" would score this spoofed host as primary.
    const spoofed = sourceTier("https://cms.gov.evil.com/medicare/payment");
    expect(spoofed.tier).not.toBe("primary");
    expect(spoofed.tier).toBe("vendor");
    expect(sourceTier("https://cms.gov.evil.com/x").score).toBeLessThan(sourceTier("https://cms.gov/x").score);
    expect(sourceTier("https://notcms.gov.attacker.io/x").tier).not.toBe("primary");
    expect(sourceTier("https://uhcprovider.com.phish.net/x").tier).not.toBe("payer");
  });

  it("tiers payers, blue plans, trade bodies and vendors apart", () => {
    expect(sourceTier("https://www.uhcprovider.com/policies").tier).toBe("payer");
    expect(sourceTier("https://www.bcbsil.com/provider").tier).toBe("payer");
    expect(sourceTier("https://www.aapc.com/blog/12345").tier).toBe("trade");
    expect(sourceTier("https://www.somebillingcompany.com/blog/99213").tier).toBe("vendor");
    expect(sourceTier("not a url at all").tier).toBe("unknown");
  });

  it("treats a state Medicaid .gov site as primary", () => {
    expect(sourceTier("https://medicaid.ohio.gov/providers/billing").tier).toBe("primary");
  });

  it("says out loud when nothing authoritative was reached", () => {
    const note = describeTiers([{ url: "https://www.somebillingcompany.com/blog/99213" }]);
    expect(note).toContain("vendor");
    expect(note).toContain("No primary or payer source");
    expect(describeTiers([])).toContain("No sources were read");
  });
});

// ── Synthesis ────────────────────────────────────────────────────────────────

const QUESTION = "Does Medicare cover CPT 99213 furnished via telehealth in 2026?";

const CMS_SOURCE: SourceDoc = {
  url: "https://www.cms.gov/medicare/payment/telehealth",
  title: "Medicare Telehealth Services",
  text: "Medicare covers CPT 99213 furnished via telehealth for dates of service in 2026 when the originating site requirements are met. Unrelated background about the agency follows.",
};

const PAYER_SOURCE: SourceDoc = {
  url: "https://www.uhcprovider.com/telehealth",
  title: "UnitedHealthcare Telehealth Policy",
  text: "Medicare covers CPT 99213 furnished via telehealth for dates of service in 2026 when the originating site requirements are met, and the plan follows that policy.",
};

const VENDOR_SOURCE: SourceDoc = {
  url: "https://www.somebillingcompany.com/blog/telehealth",
  title: "Telehealth billing tips",
  text: "Telehealth billing can be confusing. Ask your biller.",
};

describe("cited synthesis", () => {
  it("splits prose into sentences without breaking on decimals", () => {
    expect(splitSentences("Medicare allows $92.05 for 99213. That rate is national.")).toEqual([
      "Medicare allows $92.05 for 99213.",
      "That rate is national.",
    ]);
  });

  it("pulls the checkable numbers out of a claim", () => {
    expect(numericTokens("Medicare allows $92.05 for 99213 in 2026")).toEqual(["92.05", "99213", "2026"]);
  });

  it("emits a claim with every source that states it", () => {
    const out = synthesizeFindings([CMS_SOURCE, PAYER_SOURCE, VENDOR_SOURCE], QUESTION);
    expect(out.claims.length).toBeGreaterThan(0);
    const claim = out.claims[0];
    expect(claim.text).toContain("99213");
    expect(claim.sourceUrls).toContain(CMS_SOURCE.url);
    expect(claim.sourceUrls).toContain(PAYER_SOURCE.url);
    expect(claim.tier).toBe("primary");
    // Every emitted claim carries at least one citation, always.
    expect(out.claims.every((c) => c.sourceUrls.length > 0)).toBe(true);
  });

  it("moves a claim no source supports to `unsupported` instead of emitting it", () => {
    const out = synthesizeFindings([CMS_SOURCE, VENDOR_SOURCE], QUESTION, {
      candidateClaims: ["Medicare requires modifier 95 on every telehealth 99213 claim in 2026."],
    });
    expect(out.unsupported).toContain("Medicare requires modifier 95 on every telehealth 99213 claim in 2026.");
    expect(out.claims.some((c) => c.text.includes("modifier 95"))).toBe(false);
  });

  it("refuses to call a number supported by a page that never states it", () => {
    // A page about 99213 is not evidence for a dollar figure it does not contain.
    const out = synthesizeFindings([CMS_SOURCE], QUESTION, {
      candidateClaims: ["Medicare allows $92.05 for CPT 99213 via telehealth in 2026."],
    });
    expect(out.unsupported).toHaveLength(1);
    expect(out.claims.some((c) => c.text.includes("92.05"))).toBe(false);
  });

  it("will not cite a source that has no URL", () => {
    const anonymous: SourceDoc = { url: "  ", title: "Pasted text", text: CMS_SOURCE.text };
    const out = synthesizeFindings([anonymous], QUESTION);
    expect(out.claims).toHaveLength(0);
    expect(out.unsupported.length).toBeGreaterThan(0);
  });

  it("measures coverage as the share of sub-questions answered by a primary or payer source", () => {
    const subQuestions = ["99213 Medicare coverage policy 2026", "telehealth documentation requirements audit"];
    const out = synthesizeFindings(
      [
        {
          url: "https://www.cms.gov/x",
          title: "CMS",
          text: "Medicare coverage policy for 99213 in 2026 is described in the fee schedule.",
        },
        VENDOR_SOURCE,
      ],
      QUESTION,
      { subQuestions },
    );
    expect(out.coverage).toBe(0.5);
  });

  it("reports zero coverage when only vendor pages were reached", () => {
    const out = synthesizeFindings([VENDOR_SOURCE], QUESTION, { subQuestions: ["99213 telehealth coverage"] });
    expect(out.coverage).toBe(0);
  });

  it("renders claims with their sources, and the unsupported list as a warning", () => {
    const out = synthesizeFindings([CMS_SOURCE, VENDOR_SOURCE], QUESTION, {
      candidateClaims: ["Modifier 95 is always required."],
    });
    const rendered = renderCited(out);
    expect(rendered).toContain(CMS_SOURCE.url);
    expect(rendered).toContain("NOT SUPPORTED");
    expect(rendered).toContain("Modifier 95 is always required.");
    expect(rendered).toContain("Sources (best provenance first)");
    expect(rendered).toContain("Coverage:");
  });

  it("says plainly when nothing could be cited", () => {
    expect(renderCited(synthesizeFindings([], QUESTION))).toContain("Nothing below is an answer");
  });
});

// ── Policy → billed codes ────────────────────────────────────────────────────

const finding = (text: string, over: Partial<PolicyFinding> = {}): PolicyFinding => ({
  title: "MAC Bulletin",
  url: "https://mcd.cms.gov/bulletin/1",
  text,
  tier: "primary",
  ...over,
});

describe("matching policy text to billed codes", () => {
  it("matches a code only on a word boundary", () => {
    const inside = matchPolicyToBilledCodes(
      [finding("Line item 992130 was adjusted and 199213 was reported in error.")],
      ["99213"],
    );
    expect(inside).toHaveLength(0);

    const real = matchPolicyToBilledCodes([finding("Coverage for 99213 has been revised.")], ["99213"]);
    expect(real).toHaveLength(1);
    expect(real[0].code).toBe("99213");
  });

  it("still matches a code next to punctuation or a modifier", () => {
    expect(matchPolicyToBilledCodes([finding("Report 99213-25 with the E/M service.")], ["99213"])).toHaveLength(1);
    expect(matchPolicyToBilledCodes([finding("Codes 99212, 99213, and 99214 are affected.")], ["99213"])).toHaveLength(1);
  });

  it("never reports a code the practice does not bill", () => {
    const matches = matchPolicyToBilledCodes(
      [finding("This revision affects 97110, 97140 and 99213 for all providers.")],
      ["99213"],
    );
    expect(matches.map((m) => m.code)).toEqual(["99213"]);
    expect(matchPolicyToBilledCodes([finding("97110 is affected.")], ["99213"])).toEqual([]);
    expect(matchPolicyToBilledCodes([finding("Anything at all.")], [])).toEqual([]);
    expect(matchPolicyToBilledCodes([finding("Anything at all.")], ["   "])).toEqual([]);
  });

  it("reports one entry per code per document, not one per mention", () => {
    const matches = matchPolicyToBilledCodes(
      [finding("99213 is revised. See the 99213 table below. 99213 appears again in the appendix.")],
      ["99213"],
    );
    expect(matches).toHaveLength(1);
  });

  it("classifies what kind of change the surrounding language describes", () => {
    expect(classifyChange("The allowed amount under the physician fee schedule increases.")).toBe("pricing");
    expect(classifyChange("This service is not covered without documented medical necessity.")).toBe("coverage");
    expect(classifyChange("A new NCCI edit pair bundles these procedures.")).toBe("edit");
    expect(classifyChange("Documentation requirements changed; the medical record must include time.")).toBe(
      "documentation",
    );
    expect(classifyChange("The table was reformatted.")).toBe("unclear");
  });

  it("carries the classification and an excerpt through to the match", () => {
    const [match] = matchPolicyToBilledCodes(
      [finding("Effective January 1, 2026, the allowed amount for 99213 under the physician fee schedule changes.")],
      ["99213"],
    );
    expect(match.kind).toBe("pricing");
    expect(match.excerpt).toContain("99213");
    expect(match.url).toBe("https://mcd.cms.gov/bulletin/1");
  });

  it("pulls an effective date only when the document says it is one", () => {
    expect(extractEffectiveDate("Effective January 1, 2026, this policy applies.")).toBe("20260101");
    expect(extractEffectiveDate("This policy takes effect on 03/15/2026.")).toBe("20260315");
    expect(extractEffectiveDate("Applies to dates of service on or after 2026-04-01.")).toBe("20260401");
    expect(extractEffectiveDate("Becomes effective 1 Oct 2026 for all contractors.")).toBe("20261001");
    // A publication date is not an effective date and must not be reported as one.
    expect(extractEffectiveDate("Published March 3, 2025. The table was reformatted.")).toBeUndefined();
    expect(extractEffectiveDate("No dates here.")).toBeUndefined();
  });

  it("attaches the stated effective date to the match", () => {
    const [match] = matchPolicyToBilledCodes(
      [finding("Effective January 1, 2026, coverage for 99213 requires prior authorization.")],
      ["99213"],
    );
    expect(match.effectiveDate).toBe("20260101");
    expect(match.kind).toBe("coverage");
  });

  it("drops matches whose stated effective date is older than `since`, and keeps undated ones", () => {
    const matches = matchPolicyToBilledCodes(
      [
        finding("Effective January 1, 2024, 99213 pricing changed.", { url: "https://cms.gov/old" }),
        finding("Effective January 1, 2026, 99213 pricing changed.", { url: "https://cms.gov/new" }),
        finding("99213 appears in this table with no date at all.", { url: "https://cms.gov/undated" }),
      ],
      ["99213"],
    );
    expect(matches).toHaveLength(3);
    const kept = filterMatchesSince(matches, "20250101");
    expect(kept.map((m) => m.url)).toEqual(["https://cms.gov/new", "https://cms.gov/undated"]);
    expect(filterMatchesSince(matches, undefined)).toHaveLength(3);
  });

  it("summarizes impact grouped by code, and says so when there is nothing", () => {
    const matches = matchPolicyToBilledCodes(
      [
        finding("Effective January 1, 2026, the allowed amount for 99213 under the fee schedule changes."),
        finding("A new NCCI edit pair bundles 97110 with therapy codes.", { url: "https://cms.gov/ncci" }),
      ],
      ["99213", "97110"],
    );
    const summary = summarizeImpact(matches);
    expect(summary).toContain("99213");
    expect(summary).toContain("97110");
    expect(summary).toContain("pricing");
    expect(summary).toContain("edit");
    expect(summary).toContain("20260101");
    expect(summarizeImpact([])).toContain("No policy document mentioned any of the codes");
  });
});

// ── Tool wiring ──────────────────────────────────────────────────────────────

describe("research tools", () => {
  it("exports both tools under stable names, read-only", () => {
    expect(researchDeepTool.name).toBe("research_deep");
    expect(researchPayerPolicyTool.name).toBe("research_payer_policy");
    expect(researchTools.map((t) => t.name)).toEqual(["research_deep", "research_payer_policy"]);
    expect(researchDeepTool.assessRisk({}).level).toBe("safe");
    expect(researchPayerPolicyTool.assessRisk({}).level).toBe("safe");
  });

  it("defaults and caps maxSources, and requires at least one code for the policy tool", () => {
    const parsed = researchDeepTool.schema.parse({ question: "x" }) as { maxSources: number };
    expect(parsed.maxSources).toBe(5);
    expect(researchDeepTool.schema.safeParse({ question: "x", maxSources: 25 }).success).toBe(false);
    expect(researchPayerPolicyTool.schema.safeParse({ codes: [] }).success).toBe(false);
    expect(researchPayerPolicyTool.schema.safeParse({ codes: ["99213"], since: "2026" }).success).toBe(false);
    expect(researchPayerPolicyTool.schema.safeParse({ codes: ["99213"], since: "20260101" }).success).toBe(true);
  });
});
