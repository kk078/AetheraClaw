import { z } from "zod";
import { defineTool } from "../registry.js";
import { fetchTextGuarded } from "../web-fetch.js";

const CMS = "https://api.coverage.cms.gov/v1";

async function cms(pathAndQuery: string): Promise<string> {
  const body = await fetchTextGuarded(`${CMS}${pathAndQuery}`);
  return body.slice(0, 12_000);
}

export const coverageSearchNationalTool = defineTool({
  name: "coverage_search_national",
  description:
    "Search Medicare NATIONAL coverage documents (NCDs) by keyword via the CMS Coverage API. Use for 'does Medicare cover X' questions — check national policy first, then local (LCD).",
  schema: z.object({ keyword: z.string().describe("Service, procedure, or condition keyword") }),
  execute: async (input) => ({
    content: await cms(`/reports/national-coverage-ncd?keyword=${encodeURIComponent(input.keyword)}`),
  }),
});

export const coverageSearchLocalTool = defineTool({
  name: "coverage_search_local",
  description:
    "Search Medicare LOCAL coverage documents (LCDs/articles) by keyword, optionally filtered by state, via the CMS Coverage API. LCDs are contractor(MAC)-specific medical-necessity policy.",
  schema: z.object({
    keyword: z.string(),
    state: z.string().optional().describe("Two-letter state code to scope to the applicable MAC"),
  }),
  execute: async (input) => {
    const q = new URLSearchParams({ keyword: input.keyword });
    if (input.state) q.set("state", input.state);
    return { content: await cms(`/reports/local-coverage-final-lcds?${q.toString()}`) };
  },
});

export const macLookupTool = defineTool({
  name: "mac_lookup",
  description: "Find the Medicare Administrative Contractor (MAC) serving a given US state.",
  schema: z.object({ state: z.string().describe("Two-letter state code, e.g. TX") }),
  execute: async (input) => ({
    content: await cms(`/metadata/contractors?state=${encodeURIComponent(input.state.toUpperCase())}`),
  }),
});

export const sadExclusionTool = defineTool({
  name: "sad_exclusion_check",
  description:
    "Fetch the Medicare Self-Administered Drug (SAD) exclusion list entries — drugs excluded from Part B coverage because they are usually self-administered.",
  schema: z.object({ keyword: z.string().optional().describe("Optional drug name filter") }),
  execute: async (input) => {
    const q = input.keyword ? `?keyword=${encodeURIComponent(input.keyword)}` : "";
    return { content: await cms(`/reports/sad-exclusion-list${q}`) };
  },
});
