import { z } from "zod";
import { defineTool } from "../registry.js";
import { fetchTextGuarded } from "../web-fetch.js";

const NLM_BASE = "https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search";

async function nlmSearch(terms: string, maxList = 15): Promise<Array<{ code: string; name: string }>> {
  const url = `${NLM_BASE}?sf=code,name&terms=${encodeURIComponent(terms)}&maxList=${maxList}`;
  const body = await fetchTextGuarded(url);
  const parsed = JSON.parse(body) as [number, string[], unknown, Array<[string, string]>];
  return (parsed[3] ?? []).map(([code, name]) => ({ code, name }));
}

export const icd10SearchTool = defineTool({
  name: "icd10_search",
  description:
    "Search ICD-10-CM diagnosis codes by clinical term or code prefix (NLM Clinical Tables). Returns code + description pairs. Use before answering any diagnosis-coding question.",
  schema: z.object({
    query: z.string().describe("Clinical term (e.g. 'type 2 diabetes neuropathy') or code prefix (e.g. 'E11')"),
    max_results: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (input) => {
    const rows = await nlmSearch(input.query, input.max_results ?? 15);
    if (rows.length === 0) return { content: `No ICD-10-CM matches for "${input.query}"` };
    return { content: rows.map((r) => `${r.code}  ${r.name}`).join("\n") };
  },
});

export const icd10ValidateTool = defineTool({
  name: "icd10_validate",
  description:
    "Validate a specific ICD-10-CM code: does it exist, and is it billable (i.e., at full specificity)? A code with child codes in the hierarchy is a category header and NOT billable.",
  schema: z.object({ code: z.string().describe("ICD-10-CM code, e.g. E11.65") }),
  execute: async (input) => {
    const code = input.code.trim().toUpperCase();
    const exact = await nlmSearch(code, 30);
    const match = exact.find((r) => r.code.toUpperCase() === code);
    if (!match) {
      const near = exact.slice(0, 5).map((r) => `${r.code}  ${r.name}`).join("\n");
      return {
        content: `${code} is NOT a valid ICD-10-CM code.${near ? `\nNearby codes:\n${near}` : ""}`,
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
              .join("\n")}`),
    };
  },
});
