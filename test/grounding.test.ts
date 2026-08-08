import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkCitations } from "../src/tools/healthcare/citations.js";
import { POS_CODES, classifyPos, renderPos, searchPos } from "../src/tools/healthcare/pos.js";
import { ToolRegistry, defineTool } from "../src/tools/registry.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { FACILITY_POS, OFFICE_POS } from "../src/tools/healthcare/compliance/incident-to.js";
import { httpFailure } from "../src/tools/web-fetch.js";
import { datasetStatuses, renderDatasetStatus } from "../src/tools/healthcare/datasets.js";

// Every case here traces to an observed failure: a model in this system stated a
// regulatory fact from memory, and the fact was wrong. The tests hold the
// countermeasures, not the model.

describe("policy citation guard", () => {
  it("refuses identifier-shaped citations that were not verified", () => {
    const check = checkCitations(["CMS NCD 310.2 — Evaluation and Management Services"], false);
    expect(check.ok).toBe(false);
    expect(check.identifierCitations).toHaveLength(1);
    expect(check.identifierCitations[0].kinds).toContain("NCD");
    expect(check.refusal).toMatch(/coverage_search_national/);
  });

  it("catches LCD, article, CFR and transmittal identifiers", () => {
    const cases: Array<[string, string]> = [
      ["Per LCD L33797, the service is covered", "LCD"],
      ["Billing and Coding Article A56902", "Article"],
      ["42 CFR § 410.32 permits this", "CFR"],
      ["CMS-1784-F preamble", "CMS manual/transmittal"],
    ];
    for (const [citation, kind] of cases) {
      const check = checkCitations([citation], false);
      expect(check.ok, citation).toBe(false);
      expect(check.identifierCitations[0].kinds, citation).toContain(kind);
    }
  });

  it("lets unverified free-text clinical reasoning through", () => {
    // The practice's own assertion about its own patient is not a citation.
    const check = checkCitations(
      ["The documentation records two chronic conditions with exacerbation and prescription drug management."],
      false,
    );
    expect(check.ok).toBe(true);
    expect(check.identifierCitations).toHaveLength(0);
  });

  it("allows identifiers once the caller states they were verified", () => {
    expect(checkCitations(["LCD L33797"], true).ok).toBe(true);
  });

  it("allows a letter with no citations at all", () => {
    expect(checkCitations([], false).ok).toBe(true);
  });
});

describe("place of service codes", () => {
  it("knows POS 22 is an outpatient hospital, not telehealth", () => {
    // The literal fabrication: "22 — Remote Telehealth (store-and-forward)".
    const r = classifyPos("22");
    expect(r.status).toBe("known");
    expect(r.entry?.name).toBe("On Campus-Outpatient Hospital");
    expect(r.entry?.name).not.toMatch(/telehealth/i);
    expect(renderPos(r)).toMatch(/not a telehealth code/i);
    // ...and the disambiguating note must not make 22 a telehealth search hit.
    expect(searchPos("telehealth").map((h) => h.code)).toEqual(["02", "10"]);
  });

  it("names 02 and 10 as the telehealth codes", () => {
    expect(POS_CODES["02"].name).toMatch(/Telehealth/);
    expect(POS_CODES["10"].name).toMatch(/Telehealth/);
    expect(POS_CODES["02"].description).toMatch(/NOT located in their home/);
    expect(POS_CODES["10"].description).toMatch(/IS located in their home/);
  });

  it("distinguishes on-campus 22 from off-campus 19", () => {
    expect(POS_CODES["19"].name).toMatch(/^Off Campus/);
    expect(POS_CODES["22"].name).toMatch(/^On Campus/);
  });

  it("reports unassigned ranges as unassigned rather than unknown", () => {
    // 28-30, 35-40, 43-48, 59, 63-64, 67-70, 73-80, 82-98 carry no meaning.
    for (const code of ["28", "38", "45", "59", "64", "70", "77", "90"]) {
      const r = classifyPos(code);
      expect(r.status, code).toBe("unassigned");
      expect(renderPos(r)).toMatch(/POS 99/); // points at the real "other"
    }
  });

  it("rejects things that are not POS codes", () => {
    expect(classifyPos("abc").status).toBe("invalid");
    expect(classifyPos("123").status).toBe("invalid");
  });

  it("pads a single digit the way a claim form would", () => {
    expect(classifyPos("2").entry?.name).toBe("Telehealth Provided Other than in Patient's Home");
  });

  it("searches by setting", () => {
    const hits = searchPos("ambulatory surgical");
    expect(hits.map((h) => h.code)).toContain("24");
  });

  it("agrees with the facility/office sets the compliance rules use", () => {
    // Two independent tables describing the same code set is exactly how a
    // system ends up contradicting itself; assert they cannot drift apart.
    for (const code of FACILITY_POS) expect(POS_CODES[code], code).toBeDefined();
    for (const code of OFFICE_POS) expect(POS_CODES[code], code).toBeDefined();
    expect(FACILITY_POS.has("22")).toBe(true);
    expect(OFFICE_POS.has("22")).toBe(false);
  });
});

describe("unknown tool recovery", () => {
  const registry = new ToolRegistry();
  registry.registerAll([
    defineTool({
      name: "web_search",
      description: "Search the web for pages matching a query.",
      schema: z.object({ query: z.string() }),
      execute: async () => ({ content: "" }),
    }),
    defineTool({
      name: "denial_explain",
      description: "Explain a CARC or RARC denial code.",
      schema: z.object({ carc: z.string() }),
      execute: async () => ({ content: "" }),
    }),
  ]);

  const ctx = {
    workspaceRoot: "/tmp",
    sessionId: "s",
    approvalPolicy: "never" as const,
    requestApproval: async () => true,
    services: {},
  };

  it("names the near match instead of aliasing the invented name", async () => {
    const result = await registry.execute("search", { query: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Unknown tool: search/);
    expect(result.content).toMatch(/web_search/);
    // The call still fails. Aliasing would have made the wrong name work and
    // taught the model nothing.
    expect(result.content).not.toMatch(/Searching/);
  });

  it("splits underscores so a near-miss name still finds its neighbour", async () => {
    const result = await registry.execute("explain_denial", {}, ctx);
    expect(result.content).toMatch(/denial_explain/);
  });

  it("falls back to tool_search when nothing is close", async () => {
    const result = await registry.execute("zzzz", {}, ctx);
    expect(result.content).toMatch(/tool_search/);
  });
});

describe("dataset inventory", () => {
  it("says what a missing table blocks, and does not call it a negative result", () => {
    const statuses = [
      {
        file: "ncci-ptp.json",
        purpose: "NCCI PTP bundling edits",
        installed: false,
        source: "CMS NCCI page",
        absentMeans: "Bundling cannot be checked at all. Not 'no edit found' — no table was read.",
      },
    ];
    const out = renderDatasetStatus(statuses, false);
    expect(out).toMatch(/MISSING/);
    expect(out).toMatch(/Not 'no edit found'/);
    expect(out).toMatch(/limits on what can be checked, not findings/);
  });

  it("reports CPT separately, as licensing rather than a missing download", () => {
    expect(renderDatasetStatus([], false)).toMatch(/AMA-licensed/);
    expect(renderDatasetStatus([], true)).toMatch(/configured/);
  });

  it("lists every dataset the tools actually read", () => {
    const files = datasetStatuses().map((s) => s.file);
    for (const f of ["ncci-ptp.json", "mue.json", "hcpcs.json", "mpfs.json", "mpfs-cf.json", "gpci.json"]) {
      expect(files).toContain(f);
    }
  });
});

describe("web fetch failure guidance", () => {
  it("names a 403 as the site's decision, not a transient error", () => {
    const msg = httpFailure(403, new URL("https://www.cms.gov/medicare/coverage"));
    expect(msg).toMatch(/do not retry/i);
    expect(msg).toMatch(/coverage_search_national/);
  });

  it("refuses to suggest looking like a browser", () => {
    expect(httpFailure(403, new URL("https://example.com/x"))).toMatch(/do not retry it or try to look like a browser/);
  });

  it("distinguishes rate limiting from refusal", () => {
    expect(httpFailure(429, new URL("https://example.com/x"))).toMatch(/rate-limiting/);
  });

  it("tells the caller a 404 is a wrong URL", () => {
    expect(httpFailure(404, new URL("https://example.com/x"))).toMatch(/does not exist/);
  });

  it("leaves other statuses plain", () => {
    expect(httpFailure(500, new URL("https://example.com/x"))).toBe("HTTP 500 from example.com");
  });
});

describe("system prompt grounding rules", () => {
  const prompt = buildSystemPrompt("/tmp/ws");

  it("is present unconditionally, not only when tools are deferred", () => {
    expect(prompt).toMatch(/do not answer regulatory questions from memory/i);
  });

  it("covers each observed failure mode", () => {
    expect(prompt).toMatch(/Place-of-service codes/); // POS 22 fabrication
    expect(prompt).toMatch(/Never invent a policy identifier/); // NCD 310.2
    expect(prompt).toMatch(/Never assert a negative/); // "not bundled" with no NCCI data
    expect(prompt).toMatch(/that refusal is the answer/); // invented MPFS rate
    expect(prompt).toMatch(/verified/); // filling citations_verified without verifying
  });
});
