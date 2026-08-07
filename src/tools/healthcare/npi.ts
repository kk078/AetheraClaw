import { z } from "zod";
import { defineTool } from "../registry.js";
import { fetchTextGuarded } from "../web-fetch.js";

// NPI check digit: Luhn over the 10-digit NPI with the industry prefix 80840.
export function npiLuhnValid(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = ("80840" + npi.slice(0, 9)).split("").map(Number);
  let sum = 0;
  let dbl = true; // rightmost of the 14-digit base gets doubled
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(npi[9]);
}

export const npiValidateTool = defineTool({
  name: "npi_validate",
  description: "Validate an NPI number's format and Luhn check digit (offline; catches typos instantly).",
  schema: z.object({ npi: z.string().describe("10-digit NPI number") }),
  execute: async (input) => {
    const ok = npiLuhnValid(input.npi.trim());
    return { content: ok ? `${input.npi} passes NPI check-digit validation.` : `${input.npi} is NOT a valid NPI (format or check digit fails).` };
  },
});

const NPPES = "https://npiregistry.cms.hhs.gov/api/?version=2.1";

export const npiLookupTool = defineTool({
  name: "npi_lookup",
  description: "Look up a provider or organization by NPI in the CMS NPPES registry — name, taxonomy/specialty, practice address, license info.",
  schema: z.object({ npi: z.string().describe("10-digit NPI number") }),
  execute: async (input) => {
    const body = await fetchTextGuarded(`${NPPES}&number=${encodeURIComponent(input.npi.trim())}`);
    const data = JSON.parse(body) as { result_count: number; results?: unknown[] };
    if (!data.result_count) return { content: `No NPPES record for NPI ${input.npi}` };
    return { content: JSON.stringify(data.results?.[0], null, 2).slice(0, 8000) };
  },
});

export const npiSearchTool = defineTool({
  name: "npi_search",
  description: "Search the NPPES registry for providers by name, organization, state, and/or taxonomy description.",
  schema: z.object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    organization_name: z.string().optional(),
    state: z.string().optional().describe("Two-letter state code"),
    taxonomy_description: z.string().optional().describe("e.g. 'Internal Medicine'"),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (input) => {
    const params = new URLSearchParams();
    if (input.first_name) params.set("first_name", input.first_name);
    if (input.last_name) params.set("last_name", input.last_name);
    if (input.organization_name) params.set("organization_name", input.organization_name);
    if (input.state) params.set("state", input.state);
    if (input.taxonomy_description) params.set("taxonomy_description", input.taxonomy_description);
    params.set("limit", String(input.limit ?? 10));
    const body = await fetchTextGuarded(`${NPPES}&${params.toString()}`);
    const data = JSON.parse(body) as {
      result_count: number;
      results?: Array<{ number: string; basic?: Record<string, string>; taxonomies?: Array<{ desc: string; primary: boolean }> }>;
    };
    if (!data.result_count) return { content: "No providers matched." };
    const lines = (data.results ?? []).map((r) => {
      const b = r.basic ?? {};
      const name = b.organization_name ?? `${b.first_name ?? ""} ${b.last_name ?? ""}`.trim();
      const tax = r.taxonomies?.find((t) => t.primary)?.desc ?? "";
      return `${r.number}  ${name}  ${tax}`;
    });
    return { content: lines.join("\n") };
  },
});
