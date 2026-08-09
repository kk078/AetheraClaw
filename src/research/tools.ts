import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { fetchTextGuarded } from "../tools/web-fetch.js";
import { planPolicyWatch, planResearch } from "./plan.js";
import {
  dedupeResults,
  duckDuckGoUrl,
  filterByDomains,
  parseDuckDuckGoHtml,
  rankResults,
  type SearchResult,
} from "./search.js";
import { describeTiers, sourceTier } from "./credibility.js";
import { renderCited, synthesizeFindings, type SourceDoc } from "./synthesize.js";
import { filterMatchesSince, matchPolicyToBilledCodes, summarizeImpact, type PolicyFinding } from "./policy-watch.js";

// I/O and formatting only. Every decision these tools appear to make — what to
// search, which source outranks which, what counts as support for a claim, which
// billed code a policy touches — is a pure function in this directory, tested
// without a network. What is left here is: call them in order, fetch, and say
// plainly what could not be reached.

const MAX_OUTPUT = 24_000;
/** Per-page text kept for synthesis. Enough for a policy PDF's body, bounded so ten of them are not. */
const MAX_SOURCE_CHARS = 40_000;

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n\n[output truncated at ${MAX_OUTPUT} characters]`
    : text;
}

/** Run the planned queries, keeping every failure as a note instead of an exception. */
async function runSearches(queries: string[], notes: string[]): Promise<SearchResult[]> {
  const found: SearchResult[] = [];
  for (const query of queries) {
    try {
      const body = await fetchTextGuarded(duckDuckGoUrl(query));
      const results = parseDuckDuckGoHtml(body);
      if (results.length === 0) notes.push(`Search "${query}" returned no usable results.`);
      found.push(...results);
    } catch (err) {
      notes.push(`Search "${query}" failed — ${why(err)}`);
    }
  }
  return found;
}

/**
 * Fetch every candidate page at once.
 *
 * `allSettled`, not `all`: one dead host in a list of six must cost that one
 * source, not the whole answer. A research tool that throws because the fourth
 * result timed out is a research tool nobody runs twice.
 */
async function fetchSources(results: SearchResult[], notes: string[]): Promise<SourceDoc[]> {
  const settled = await Promise.allSettled(results.map((r) => fetchTextGuarded(r.url)));
  const sources: SourceDoc[] = [];
  settled.forEach((outcome, i) => {
    const result = results[i];
    if (outcome.status === "fulfilled") {
      const text = outcome.value.slice(0, MAX_SOURCE_CHARS);
      if (text.trim().length === 0) {
        notes.push(`${result.url} returned no readable text.`);
        return;
      }
      sources.push({ url: result.url, title: result.title || result.url, text });
    } else {
      notes.push(`Could not read ${result.url} — ${why(outcome.reason)}`);
    }
  });
  return sources;
}

function partialWarning(notes: string[], reached: number, attempted: number): string[] {
  if (notes.length === 0) return [];
  return [
    "",
    `PARTIAL — ${reached} of ${attempted} source(s) were read. What follows is based only on those; the rest could not be reached:`,
    ...notes.map((n) => `  - ${n}`),
  ];
}

export const researchDeepTool = defineTool({
  name: "research_deep",
  description:
    "Answer a billing or policy question from the open web with citations. Decomposes the question into distinct searches (recognizing CPT/HCPCS and ICD-10 codes, payer names, X12 transaction and form numbers, and years), searches each, unwraps DuckDuckGo's redirect links to real destinations, ranks results by source tier (CMS/Federal Register/X12 first, then the payer's own site, then trade bodies, then vendor pages), fetches the top pages in parallel, and returns only findings a fetched source actually states — anything unsupported is listed separately as NOT an answer rather than written into the summary. Network failures degrade to a partial answer that names what it could not reach.",
  schema: z.object({
    question: z.string().describe("The question to research, in full — codes, payer and year are extracted from it"),
    maxSources: z.number().int().min(1).max(10).default(5).describe("Pages to fetch and read"),
    includeDomains: z.array(z.string()).optional().describe("Only use results on these domains, e.g. ['cms.gov']"),
    excludeDomains: z.array(z.string()).optional().describe("Never use results on these domains"),
  }),
  execute: async (input) => {
    const notes: string[] = [];
    try {
      const plan = planResearch(input.question);
      if (plan.subQueries.length === 0) {
        return { content: "No searchable query could be built from that question — state what you want to know about which code, payer or rule." };
      }

      const found = await runSearches(plan.subQueries, notes);
      const candidates = rankResults(
        dedupeResults(filterByDomains(found, { include: input.includeDomains, exclude: input.excludeDomains })),
      );
      if (candidates.length === 0) {
        return {
          content: cap(
            [
              plan.rationale,
              "",
              "No search result survived filtering, so nothing could be read. Nothing below this line is an answer.",
              ...partialWarning(notes, 0, 0),
            ].join("\n"),
          ),
        };
      }

      const shortlist = candidates.slice(0, input.maxSources);
      const sources = await fetchSources(shortlist, notes);
      const synthesis = synthesizeFindings(sources, input.question, { subQuestions: plan.subQueries });

      return {
        content: cap(
          [
            plan.rationale,
            "",
            `Ranked ${candidates.length} distinct result(s); read ${sources.length} of the top ${shortlist.length}.`,
            "",
            renderCited(synthesis),
            "",
            describeTiers(sources),
            ...partialWarning(notes, sources.length, shortlist.length),
          ].join("\n"),
        ),
      };
    } catch (err) {
      // Reached only by a bug in the pipeline itself — every network path above
      // already degrades. Still returned as content rather than thrown, because
      // a half-finished research answer is worth more than a stack trace.
      return {
        content: cap(
          [`Research did not complete — ${why(err)}`, ...notes.map((n) => `  - ${n}`)].join("\n"),
        ),
        isError: true,
      };
    }
  },
});

export const researchPayerPolicyTool = defineTool({
  name: "research_payer_policy",
  description:
    "Search payer and CMS policy sources for changes affecting specific codes this practice bills, then report only the codes that were actually supplied — never a code the practice does not bill. Aims at bulletins, transmittals and reimbursement-policy pages rather than coding references, matches each billed code by word boundary (so 99213 never matches inside 992130), classifies what kind of change the surrounding language describes (coverage, pricing, NCCI/units edit, or documentation), and pulls the effective date when the document states one. Optionally drops anything effective before a given date.",
  schema: z.object({
    payer: z.string().optional().describe("Payer name, e.g. 'UnitedHealthcare'. Omit to search CMS transmittals and bulletins."),
    codes: z.array(z.string()).min(1).describe("CPT/HCPCS codes this practice actually bills"),
    since: z.string().regex(/^\d{8}$/).optional().describe("YYYYMMDD; drop changes with a stated effective date before this"),
    maxSources: z.number().int().min(1).max(10).default(6).describe("Policy pages to fetch and read"),
  }),
  execute: async (input) => {
    const notes: string[] = [];
    try {
      const plan = planPolicyWatch({ payer: input.payer, codes: input.codes, since: input.since });
      if (plan.subQueries.length === 0) {
        return { content: "No searchable query could be built — supply at least one code." };
      }

      const found = await runSearches(plan.subQueries, notes);
      const candidates = rankResults(dedupeResults(found));
      if (candidates.length === 0) {
        return {
          content: cap([plan.rationale, "", "No policy source could be reached.", ...partialWarning(notes, 0, 0)].join("\n")),
        };
      }

      const shortlist = candidates.slice(0, input.maxSources);
      const sources = await fetchSources(shortlist, notes);
      const findings: PolicyFinding[] = sources.map((s) => ({
        title: s.title,
        url: s.url,
        text: s.text,
        tier: sourceTier(s.url).tier,
      }));

      const matches = filterMatchesSince(matchPolicyToBilledCodes(findings, input.codes), input.since);
      return {
        content: cap(
          [
            plan.rationale,
            "",
            `Read ${sources.length} of the top ${shortlist.length} policy source(s) out of ${candidates.length} found.`,
            "",
            summarizeImpact(matches),
            "",
            describeTiers(sources),
            ...partialWarning(notes, sources.length, shortlist.length),
          ].join("\n"),
        ),
      };
    } catch (err) {
      return {
        content: cap([`Policy research did not complete — ${why(err)}`, ...notes.map((n) => `  - ${n}`)].join("\n")),
        isError: true,
      };
    }
  },
});

export const researchTools = [researchDeepTool, researchPayerPolicyTool];
