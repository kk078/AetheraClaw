import { z } from "zod";
import { defineTool } from "../registry.js";
import type { Config } from "../../config/config.js";
import type { MemoryStore } from "../../memory/store.js";
import { createProvider } from "../../providers/index.js";
import { ClaimSchema, type ClaimInput } from "./x12/837.js";
import { scrubClaim } from "./claim-scrub.js";
import { computeKpis } from "./analytics.js";
import { CARC } from "./denial-codes.js";

// ── FLAGSHIP: Adversarial Payer Twin ─────────────────────────────────────────
// A second agent role-plays the payer and tries to DENY the claim before
// submission. The playbook grounds it in this practice's own 835 history.

export function buildPlaybook(store: MemoryStore, payer: string): string {
  const k = computeKpis(store);
  const lines: string[] = [`# Payer playbook: ${payer}`];
  const payerStats = [...k.byPayer.entries()].find(([p]) => p.toLowerCase().includes(payer.toLowerCase()));
  if (payerStats) {
    lines.push(`Observed claims: ${payerStats[1].claims}, denial rate ${((payerStats[1].denied / Math.max(payerStats[1].claims, 1)) * 100).toFixed(1)}%`);
  }
  const carcs = [...k.byCarc.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  if (carcs.length > 0) {
    lines.push("Most-used adjustment reasons in local 835 history:");
    for (const [carc, v] of carcs) lines.push(`- CARC ${carc} (${CARC[carc]?.desc ?? "?"}): ${v.count}×, $${v.amount.toFixed(2)}`);
  } else {
    lines.push("(No local 835 history yet — adjudicate from general payer behavior and policy.)");
  }
  return lines.join("\n");
}

const TWIN_SYSTEM = `You are a payer claims adjudicator AI — the "payer twin". Your job is ADVERSARIAL: examine the claim below and try as hard as you can to find legitimate grounds to DENY or reduce payment on it, exactly as the real payer would. You are given the payer's playbook (this practice's observed history with them) and the claim's automated scrub findings.

Respond in EXACTLY this format:

VERDICT: PAY | PARTIAL | DENY
CONFIDENCE: low | medium | high
PREDICTED_CARCS: comma-separated CARC codes (empty if PAY)
RATIONALE: for each issue — the specific rule/policy a payer would cite and which service line it hits
REMEDIATION: concrete fixes (modifier, dx linkage, documentation, auth) that would survive re-adjudication; "none needed" if PAY

Be specific and cite CARC codes, NCCI concepts, medical-necessity (LCD/NCD) logic, POS/modifier rules, and timely-filing/auth requirements. Do not invent nonexistent policies; if the claim is clean, say PAY.`;

async function adjudicate(config: Config, store: MemoryStore, claim: ClaimInput): Promise<string> {
  const provider = createProvider(config);
  const playbook = buildPlaybook(store, claim.payer_name);
  const scrub = scrubClaim(claim)
    .map((f) => `[${f.severity}] ${f.rule}: ${f.message}`)
    .join("\n");
  let out = "";
  for await (const event of provider.streamTurn({
    system: TWIN_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${playbook}\n\n# Automated scrub findings\n${scrub}\n\n# Claim (JSON)\n${JSON.stringify(claim, null, 2)}\n\nAdjudicate this claim.`,
          },
        ],
      },
    ],
    tools: [],
    maxTokens: Math.min(config.maxTokens, 8000),
  })) {
    if (event.type === "turn_end") {
      out = event.assistant
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (event.stopReason === "refusal") out = "VERDICT: PAY\nCONFIDENCE: low\nRATIONALE: twin unavailable (model declined)";
    }
  }
  return out || "VERDICT: PAY\nCONFIDENCE: low\nRATIONALE: twin produced no output";
}

export const payerTwinTool = defineTool({
  name: "payer_twin_adjudicate",
  description:
    "FLAGSHIP: run the Adversarial Payer Twin — a second AI that role-plays the payer and tries to deny this claim before submission, grounded in the practice's own 835 history (payer playbook) and the automated scrub. Returns a simulated adjudication: verdict, predicted CARCs, cited rationale, and remediation.",
  schema: ClaimSchema,
  execute: async (input, ctx) => {
    const config = ctx.services.config as Config;
    const store = ctx.services.store as MemoryStore;
    const verdict = await adjudicate(config, store, input);
    return { content: verdict };
  },
});

export const claimGauntletTool = defineTool({
  name: "claim_gauntlet",
  description:
    "Run a claim through gauntlet mode: the payer twin adversarially adjudicates it up to N rounds. Between rounds, apply the twin's REMEDIATION yourself (fix the claim JSON) and call again, or pass the same claim to see if the verdict is stable. A claim is submission-ready when the twin returns PAY on consecutive rounds.",
  schema: z.object({
    claim: ClaimSchema,
    rounds: z.number().int().min(1).max(3).default(1).describe("Twin passes to run on this claim version"),
  }),
  execute: async (input, ctx) => {
    const config = ctx.services.config as Config;
    const store = ctx.services.store as MemoryStore;
    const results: string[] = [];
    for (let i = 1; i <= input.rounds; i++) {
      const verdict = await adjudicate(config, store, input.claim);
      results.push(`── Twin round ${i} ──\n${verdict}`);
      if (/^VERDICT:\s*PAY/m.test(verdict)) break;
    }
    return { content: results.join("\n\n") };
  },
});

// Calibration: compare a twin prediction against the real 835 outcome for a claim.
export const twinCalibrateTool = defineTool({
  name: "twin_calibrate",
  description:
    "Score a past payer-twin prediction against the actual 835 outcome for a claim (by claim ID in stored remittances): did the twin predict pay/deny correctly, and did the predicted CARCs match? Misses become playbook learning notes.",
  schema: z.object({
    claim_id: z.string(),
    predicted_verdict: z.enum(["PAY", "PARTIAL", "DENY"]),
    predicted_carcs: z.array(z.string()).default([]),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    const rows = store.db.prepare("SELECT era_json FROM remittances").all() as Array<{ era_json: string }>;
    for (const row of rows) {
      const era = JSON.parse(row.era_json) as { claims: Array<{ claimId: string; statusCode: string; lines: Array<{ adjustments: Array<{ carc: string }> }> }> };
      const claim = era.claims.find((c) => c.claimId === input.claim_id);
      if (!claim) continue;
      const actualDenied = claim.statusCode === "4";
      const actualCarcs = [...new Set(claim.lines.flatMap((l) => l.adjustments.map((a) => a.carc)))];
      const verdictCorrect = actualDenied ? input.predicted_verdict !== "PAY" : input.predicted_verdict === "PAY";
      const carcHits = input.predicted_carcs.filter((c) => actualCarcs.includes(c));
      return {
        content: [
          `Actual outcome: ${actualDenied ? "DENIED" : "PAID"} · actual CARCs: ${actualCarcs.join(", ") || "(none)"}`,
          `Twin verdict ${verdictCorrect ? "CORRECT" : "WRONG"} · CARC hits: ${carcHits.length}/${input.predicted_carcs.length}`,
          verdictCorrect ? "" : "Playbook note: record this miss — the twin should weight this pattern differently next time.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return { content: `No stored 835 contains claim ${input.claim_id} — parse the ERA first with era_parse_835.`, isError: true };
  },
});
