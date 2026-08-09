import { z } from "zod";
import { defineTool } from "../registry.js";
import { fetchTextGuarded } from "../web-fetch.js";
import { icd10Table } from "./datasets.js";
import { renderSearch, renderValidation, search as searchLocal } from "./icd10-local.js";

// Local CMS data first, NLM second, and the answer always says which one served
// it. Two sources that can disagree and do not say which spoke is a worse
// failure than the network dependency this replaces: a stale FY2025 table
// answering as though it were current is invisible unless the edition is named.

const NLM_BASE = "https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search";

async function nlmSearch(terms: string, maxList = 15): Promise<Array<{ code: string; name: string }>> {
  const url = `${NLM_BASE}?sf=code,name&terms=${encodeURIComponent(terms)}&maxList=${maxList}`;
  const body = await fetchTextGuarded(url);
  const parsed = JSON.parse(body) as [number, string[], unknown, Array<[string, string]>];
  return (parsed[3] ?? []).map(([code, name]) => ({ code, name }));
}

const NLM_NOTE = "Source: NLM Clinical Tables (live API). Install the CMS code set with `node scripts/fetch-cms-data.mjs --only=icd10` to answer offline and against a named fiscal year.";

export const icd10SearchTool = defineTool({
  name: "icd10_search",
  description:
    "Search ICD-10-CM diagnosis codes by clinical term or code prefix. Answers from the locally installed CMS code set when present — naming its fiscal year — and falls back to the NLM Clinical Tables API otherwise. Use before answering any diagnosis-coding question.",
  schema: z.object({
    query: z.string().describe("Clinical term (e.g. 'type 2 diabetes neuropathy') or code prefix (e.g. 'E11')"),
    max_results: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (input) => {
    const max = input.max_results ?? 15;
    const table = icd10Table();
    if (table) return { content: renderSearch(searchLocal(table, input.query, max), input.query, table.fy) };

    const rows = await nlmSearch(input.query, max);
    if (rows.length === 0) return { content: `No ICD-10-CM matches for "${input.query}".\n\n${NLM_NOTE}` };
    return { content: `${rows.map((r) => `${r.code}  ${r.name}`).join("\n")}\n\n${NLM_NOTE}` };
  },
});

export const icd10ValidateTool = defineTool({
  name: "icd10_validate",
  description:
    "Validate a specific ICD-10-CM code: does it exist, and is it billable (valid at full specificity)? A category header is a real code that will still be rejected on a claim. When the CMS code set is installed locally, billable status comes from CMS's own order file rather than being inferred, and the answer names the fiscal year.",
  schema: z.object({ code: z.string().describe("ICD-10-CM code, e.g. E11.65") }),
  execute: async (input) => {
    const table = icd10Table();
    if (table) return { content: renderValidation(table, input.code) };

    const code = input.code.trim().toUpperCase();
    const exact = await nlmSearch(code, 30);
    const match = exact.find((r) => r.code.toUpperCase() === code);
    if (!match) {
      // The NLM table returns only full-specificity leaves, so a real CATEGORY
      // HEADER (E11) never hits exactly — but the search returns its children
      // (E11.00, …). If the queried code is a validly-shaped ICD-10 code and the
      // results extend it, it is a real header (non-billable), not invalid.
      const wellFormed = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/.test(code);
      const headerChildren = exact.filter((r) => {
        const rc = r.code.toUpperCase();
        return rc !== code && (rc.startsWith(`${code}.`) || rc.startsWith(code));
      });
      if (wellFormed && headerChildren.length > 0) {
        return {
          content:
            `${code} is a valid ICD-10-CM CATEGORY HEADER — a real code, but NOT billable. A claim must use one of the more specific codes:\n` +
            headerChildren.slice(0, 8).map((c) => `  ${c.code}  ${c.name}`).join("\n") +
            `\n\n${NLM_NOTE}`,
        };
      }
      const near = exact.slice(0, 5).map((r) => `${r.code}  ${r.name}`).join("\n");
      return {
        content: `${code} is NOT a valid ICD-10-CM code.${near ? `\nNearby codes:\n${near}` : ""}\n\n${NLM_NOTE}`,
        isError: false,
      };
    }
    // The NLM billable-code table only returns codes at full specificity — an exact hit
    // here means billable. Children check: any other returned code extending this one.
    const children = exact.filter((r) => r.code.toUpperCase() !== code && r.code.toUpperCase().startsWith(code));
    const billable = children.length === 0;
    return {
      content:
        `${match.code}  ${match.name}\n` +
        (billable
          ? "BILLABLE: yes — valid at full specificity."
          : `BILLABLE: likely a category header — more specific codes exist:\n${children
              .slice(0, 8)
              .map((c) => `  ${c.code}  ${c.name}`)
              .join("\n")}`) +
        `\n\n${NLM_NOTE}`,
    };
  },
});
