import { z } from "zod";
import { defineTool } from "../../registry.js";
import { newId } from "../../../shared/ids.js";
import type { Config } from "../../../config/config.js";
import type { MemoryStore } from "../../../memory/store.js";
import { createProvider } from "../../../providers/index.js";
import { ClaimSchema, type ClaimInput } from "../x12/837.js";
import { scrubClaim } from "../claim-scrub.js";
import { loadEras } from "../analytics.js";
import { collectPaidLines, deriveAllowed } from "../intelligence/variance.js";
import { baseProcedureCode } from "../x12/segments.js";
import { parseTwinVerdict, renderVerdict, type TwinVerdict } from "./verdict.js";
import {
  calibrate,
  playbookNoteFor,
  renderCalibration,
  scorePrediction,
  type Outcome,
  type Prediction,
  type ScoredPrediction,
} from "./calibration.js";
import {
  assessGauntlet,
  claimsDiffer,
  diffClaims,
  fingerprintKey,
  renderGauntlet,
  type GauntletRound,
} from "./gauntlet.js";
import { buildPlaybook, payerKey, type PayerStats, type PlaybookNote } from "./playbook.js";

function db(ctx: { services: Record<string, unknown> }) {
  return (ctx.services.store as MemoryStore).db;
}

// ── Playbook assembly ────────────────────────────────────────────────────────

function payerStats(store: MemoryStore, payer: string): { stats: PayerStats | null; total: number } {
  const eras = loadEras(store);
  const lines = collectPaidLines(eras);
  const needle = payer.toLowerCase();
  let claims = 0;
  let denied = 0;
  const carcs = new Map<string, { count: number; amount: number }>();

  for (const { era } of eras) {
    if (!era.payer.toLowerCase().includes(needle)) continue;
    for (const claim of era.claims) {
      claims++;
      if (claim.statusCode === "4") denied++;
      for (const line of claim.lines) {
        if (line.procedure === "(claim level)") continue;
        for (const a of line.adjustments) {
          if (a.group === "PR") continue;
          const slot = carcs.get(a.carc) ?? { count: 0, amount: 0 };
          slot.count++;
          slot.amount += a.amount;
          carcs.set(a.carc, slot);
        }
      }
    }
  }
  const stats: PayerStats | null =
    claims === 0
      ? null
      : {
          payer,
          claims,
          denied,
          carcs: [...carcs.entries()]
            .map(([carc, v]) => ({ carc, ...v }))
            .sort((a, b) => b.amount - a.amount),
        };
  return { stats, total: lines.length };
}

function playbookNotes(store: MemoryStore, payer: string): PlaybookNote[] {
  const rows = store.db
    .prepare("SELECT kind, note, created_at FROM twin_playbook_notes WHERE payer_key = ? ORDER BY created_at DESC LIMIT 40")
    .all(payerKey(payer)) as Array<{ kind: string; note: string; created_at: number }>;
  return rows.map((r) => ({ kind: r.kind as PlaybookNote["kind"], note: r.note, createdAt: r.created_at }));
}

export function playbookFor(store: MemoryStore, payer: string): string {
  const { stats, total } = payerStats(store, payer);
  return buildPlaybook({ payer, stats, notes: playbookNotes(store, payer), totalObservations: total });
}

// ── The twin ─────────────────────────────────────────────────────────────────

const TWIN_SYSTEM = `You are a payer claims adjudicator — the "payer twin". Your job is ADVERSARIAL: find the legitimate grounds a real payer would use to DENY or reduce payment on the claim below.

Respond in EXACTLY this format:

VERDICT: PAY | PARTIAL | DENY
CONFIDENCE: low | medium | high
PREDICTED_CARCS: comma-separated CARC codes (empty if PAY)
RATIONALE: for each issue, the specific rule or policy a payer would cite and which service line it hits
REMEDIATION: concrete fixes that would survive re-adjudication; "none needed" if PAY

Rules you must hold to:
- Cite real policy: CARC codes, NCCI concepts, medical-necessity (LCD/NCD) logic, POS and modifier rules, authorization and timely-filing requirements. Do not invent policies. If the claim is clean, say PAY.
- Your REMEDIATION must never be "bill more". Do not suggest raising an E/M level, adding a distinct-service or increased-procedure modifier, adding units, or adding lines as a way to clear an objection. Those change what was billed rather than how it was documented, and if the record does not support them they are upcoding.
- Where the fix depends on what the documentation says, say that instead of assuming it. "If the note documents X, then Y" is a better answer than a confident instruction.`;

const BILLER_SYSTEM = `You are a medical biller correcting a claim in response to a payer's objections.

Return ONLY a JSON object for the corrected claim, in the same shape as the claim you were given. No prose, no code fence, no commentary.

Rules you must hold to:
- Fix only what the objection identifies, and only in ways the existing documentation would support. You have not seen the chart.
- NEVER resolve an objection by billing more. Do not raise an E/M level, add units, add service lines, increase charges, or append a distinct-service or increased-procedure modifier (22, 25, 50, 59, XE, XP, XS, XU) unless the objection itself is that a required modifier is MISSING and the record plainly establishes it.
- Removing an unsupported line, lowering a level to what is documented, or correcting a pointer, place of service or date is usually the right fix.
- If the objection cannot be fixed without information you do not have, return the claim UNCHANGED. An unchanged claim is a correct answer here — inventing a fix is not.`;

async function askModel(config: Config, system: string, user: string, maxTokens: number): Promise<string> {
  const provider = createProvider(config);
  let out = "";
  for await (const event of provider.streamTurn({
    system,
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    tools: [],
    maxTokens: Math.min(config.maxTokens, maxTokens),
  })) {
    if (event.type === "turn_end") {
      out = event.assistant
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (event.stopReason === "refusal") return "";
    }
  }
  return out;
}

async function adjudicate(config: Config, store: MemoryStore, claim: ClaimInput): Promise<TwinVerdict> {
  const playbook = playbookFor(store, claim.payer_name);
  const scrub = scrubClaim(claim)
    .map((f) => `[${f.severity}] ${f.rule}: ${f.message}`)
    .join("\n");
  const raw = await askModel(
    config,
    TWIN_SYSTEM,
    `${playbook}\n\n# Automated scrub findings\n${scrub || "(none)"}\n\n# Claim (JSON)\n${JSON.stringify(claim, null, 2)}\n\nAdjudicate this claim.`,
    8000,
  );
  return parseTwinVerdict(raw);
}

function recordPrediction(
  store: MemoryStore,
  claim: ClaimInput,
  verdict: TwinVerdict,
  gauntletId: string,
  round: number,
): void {
  if (!verdict.verdict) return; // An unreadable answer is not a prediction to score.
  store.db
    .prepare(
      `INSERT INTO twin_predictions
         (id, claim_id, payer, verdict, confidence, predicted_carcs_json, rationale, remediation, gauntlet_id, round, claim_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("tp"),
      claim.claim_id,
      claim.payer_name,
      verdict.verdict,
      verdict.confidence ?? "",
      JSON.stringify(verdict.predictedCarcs),
      verdict.rationale,
      verdict.remediation,
      gauntletId,
      round,
      fingerprintKey(claim),
      Date.now(),
    );
}

export const payerTwinTool = defineTool({
  name: "payer_twin_adjudicate",
  description:
    "FLAGSHIP: run the Adversarial Payer Twin — a second model that role-plays the payer and tries to deny this claim before submission, grounded in this practice's own remittance history with that payer plus the notes calibration has written about where the twin was wrong before. The prediction is stored, so it is scored automatically when the real remittance arrives.",
  schema: ClaimSchema,
  execute: async (input, ctx) => {
    const config = ctx.services.config as Config;
    const store = ctx.services.store as MemoryStore;
    const verdict = await adjudicate(config, store, input);
    recordPrediction(store, input, verdict, "", 1);
    return { content: renderVerdict(verdict) };
  },
});

export const claimGauntletTool = defineTool({
  name: "claim_gauntlet",
  description:
    "Run a claim through the gauntlet: the twin attacks, a biller model applies the remediation, the twin attacks the corrected claim, until it survives the required consecutive clean passes or the rounds run out. Reports every change made along the way and flags any that increase what the claim bills — a loop told only to silence the objection will reach for those first, and they are upcoding unless the record supports them. Converging without the claim ever changing is reported as the model being inconsistent rather than as a fix.",
  schema: z.object({
    claim: ClaimSchema,
    max_rounds: z.number().int().min(1).max(6).default(4),
    clean_passes: z.number().int().min(1).max(3).default(2).describe("Consecutive PAY verdicts required"),
    auto_fix: z.boolean().default(true).describe("Let the biller model apply remediation between rounds"),
  }),
  execute: async (input, ctx) => {
    const config = ctx.services.config as Config;
    const store = ctx.services.store as MemoryStore;
    const gauntletId = newId("gnt");

    const rounds: GauntletRound[] = [];
    let claim = input.claim;
    let cleanStreak = 0;

    for (let round = 1; round <= input.max_rounds; round++) {
      const previous = rounds[rounds.length - 1]?.claim;
      const changes = previous ? diffClaims(previous, claim) : [];
      const verdict = await adjudicate(config, store, claim);
      recordPrediction(store, claim, verdict, gauntletId, round);
      rounds.push({ round, claim, verdict, changes });

      cleanStreak = verdict.verdict === "PAY" ? cleanStreak + 1 : 0;
      if (cleanStreak >= input.clean_passes) break;
      if (round === input.max_rounds) break;
      if (!input.auto_fix) break;
      if (verdict.verdict === "PAY") continue; // Re-attack the same claim to test stability.
      if (!verdict.remediation) break;

      const revised = await askModel(
        config,
        BILLER_SYSTEM,
        `# The payer's objections\n${verdict.rationale}\n\n# Suggested remediation\n${verdict.remediation}\n\n# Current claim (JSON)\n${JSON.stringify(claim, null, 2)}\n\nReturn the corrected claim JSON.`,
        8000,
      );
      const parsed = safeParseClaim(revised);
      if (!parsed) break; // Could not produce a usable claim; stop rather than loop on nothing.
      if (!claimsDiffer(claim, parsed)) break; // No progress — another round would say the same thing.
      claim = parsed;
    }

    const outcome = assessGauntlet(rounds, input.clean_passes);
    const finalClaim = rounds[rounds.length - 1]?.claim ?? input.claim;
    return {
      content: [
        renderGauntlet(outcome),
        "",
        "── Final claim ──",
        JSON.stringify(finalClaim, null, 2),
        "",
        "This is a prediction of how one payer might adjudicate, not an approval. Nothing here has been submitted.",
      ].join("\n"),
    };
  },
});

function safeParseClaim(raw: string): ClaimInput | null {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return ClaimSchema.parse(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

// ── Calibration ──────────────────────────────────────────────────────────────

/** Actual outcomes from stored remittances, keyed by claim ID. */
function actualOutcomes(store: MemoryStore): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  for (const { era } of loadEras(store)) {
    for (const claim of era.claims) {
      const key = claim.claimId.trim().toUpperCase();
      const carcs = new Set<string>();
      let paid = 0;
      let contractual = 0;
      for (const line of claim.lines) {
        if (line.procedure === "(claim level)") {
          for (const a of line.adjustments) if (a.group !== "PR") carcs.add(a.carc);
          continue;
        }
        const derived = deriveAllowed(line);
        paid += derived.paid;
        contractual += derived.contractual;
        for (const a of line.adjustments) if (a.group !== "PR") carcs.add(a.carc);
      }
      out.set(key, {
        claimId: claim.claimId,
        denied: claim.statusCode === "4" || (paid <= 0 && contractual > 0),
        actualCarcs: [...carcs],
      });
    }
  }
  return out;
}

function storedPredictions(store: MemoryStore): Prediction[] {
  const rows = store.db
    .prepare(
      // One prediction per claim: the last one, which is the version that would
      // actually have been submitted after a gauntlet.
      `SELECT claim_id, payer, verdict, confidence, predicted_carcs_json, MAX(created_at) AS created_at
       FROM twin_predictions GROUP BY claim_id`,
    )
    .all() as Array<{
    claim_id: string;
    payer: string;
    verdict: string;
    confidence: string;
    predicted_carcs_json: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    claimId: r.claim_id,
    payer: r.payer,
    verdict: r.verdict as Prediction["verdict"],
    confidence: (r.confidence || null) as Prediction["confidence"],
    predictedCarcs: JSON.parse(r.predicted_carcs_json) as string[],
    createdAt: r.created_at,
  }));
}

export const twinCalibrateTool = defineTool({
  name: "twin_calibrate",
  description:
    "Score every stored twin prediction against the remittance that actually arrived. Reports denial recall (of the claims the payer denied, how many the twin warned about — what the twin is for), precision (what those warnings cost in false alarms), and whether accuracy beats simply guessing the commoner outcome, because on a low-denial book accuracy alone flatters a twin that never warns about anything. Misses become playbook notes the twin reads next time.",
  schema: z.object({
    learn: z.boolean().default(true).describe("Write misses back into the payer playbooks"),
    payer: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    const outcomes = actualOutcomes(store);
    let predictions = storedPredictions(store);
    if (input.payer) {
      const needle = input.payer.toLowerCase();
      predictions = predictions.filter((p) => p.payer.toLowerCase().includes(needle));
    }
    if (predictions.length === 0) {
      return {
        content:
          "No twin predictions stored yet. Run payer_twin_adjudicate or claim_gauntlet; predictions are recorded automatically and scored here once the remittance is parsed.",
      };
    }

    const scored: ScoredPrediction[] = [];
    let unmatched = 0;
    for (const prediction of predictions) {
      const outcome = outcomes.get(prediction.claimId.trim().toUpperCase());
      if (!outcome) {
        unmatched++;
        continue;
      }
      scored.push(scorePrediction(prediction, outcome));
    }

    let learned = 0;
    if (input.learn) {
      const insert = store.db.prepare(
        `INSERT OR IGNORE INTO twin_playbook_notes (id, payer_key, kind, note, source_claim_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const s of scored) {
        const note = playbookNoteFor(s);
        if (!note) continue;
        const kind = s.falseNegative ? "miss" : s.falsePositive ? "over_call" : "wrong_reason";
        const res = insert.run(newId("tn"), payerKey(s.payer), kind, note, s.claimId, Date.now());
        learned += Number(res.changes);
      }
    }

    const report = calibrate(scored);
    return {
      content: [
        renderCalibration(report),
        unmatched > 0
          ? `\n${unmatched} prediction(s) have no remittance yet and were not scored — they will be counted once the ERA is parsed.`
          : "",
        learned > 0 ? `${learned} new playbook note(s) written. The twin reads these on its next run against that payer.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const twinPlaybookTool = defineTool({
  name: "twin_playbook",
  description:
    "Show the briefing the twin gets for a payer: what that payer has actually done to this practice's claims, and the notes calibration has written about where the twin was wrong before. Statistics and corrections are kept apart so it stays clear which is evidence about the payer and which is a correction to the twin.",
  schema: z.object({ payer: z.string() }),
  execute: async (input, ctx) => ({
    content: playbookFor(ctx.services.store as MemoryStore, input.payer),
  }),
});

export const twinNoteTool = defineTool({
  name: "twin_playbook_note",
  description:
    "Add a note to a payer's playbook by hand — something a coder knows that the remittance history does not show. It goes in alongside the notes calibration writes and is read by the twin on its next run.",
  schema: z.object({ payer: z.string(), note: z.string() }),
  execute: async (input, ctx) => {
    db(ctx)
      .prepare(
        `INSERT OR IGNORE INTO twin_playbook_notes (id, payer_key, kind, note, source_claim_id, created_at)
         VALUES (?, ?, 'manual', ?, ?, ?)`,
      )
      .run(newId("tn"), payerKey(input.payer), input.note, `manual-${Date.now()}`, Date.now());
    return { content: `Added a note to the ${input.payer} playbook.` };
  },
});

// ── Self-heal ────────────────────────────────────────────────────────────────

export const twinSelfHealTool = defineTool({
  name: "twin_self_heal",
  description:
    "Take a claim the payer actually denied, show the twin what happened, and get an analysis of why plus what would survive resubmission. Produces a draft only: nothing is corrected, submitted, or appealed. Compares the real denial against what the twin predicted beforehand, when there was a prediction — the gap between those is usually more informative than either alone.",
  schema: z.object({
    claim_id: z.string(),
    claim: ClaimSchema.optional().describe("The claim as billed; omit to use the recorded version"),
  }),
  execute: async (input, ctx) => {
    const config = ctx.services.config as Config;
    const store = ctx.services.store as MemoryStore;

    const outcome = actualOutcomes(store).get(input.claim_id.trim().toUpperCase());
    if (!outcome) {
      return {
        content: `No parsed remittance mentions ${input.claim_id}. Parse the ERA with era_parse_835 first — this tool works from what the payer actually did, not from a guess.`,
        isError: true,
      };
    }
    if (!outcome.denied) {
      return { content: `${input.claim_id} was paid, not denied. Nothing to heal.` };
    }

    let claim = input.claim;
    if (!claim) {
      const row = store.db
        .prepare("SELECT claim_json FROM claims WHERE json_extract(claim_json, '$.claim_id') = ?")
        .get(input.claim_id) as { claim_json: string } | undefined;
      if (!row) {
        return {
          content: `${input.claim_id} was denied, but no recorded version of it exists to work from. Pass the claim JSON explicitly.`,
          isError: true,
        };
      }
      claim = ClaimSchema.parse(JSON.parse(row.claim_json));
    }

    const prior = store.db
      .prepare("SELECT verdict, predicted_carcs_json FROM twin_predictions WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(input.claim_id) as { verdict: string; predicted_carcs_json: string } | undefined;

    const priorLine = prior
      ? `Before submission the twin predicted ${prior.verdict} with ${(JSON.parse(prior.predicted_carcs_json) as string[]).join(", ") || "no codes"}.`
      : "There was no prediction on file for this claim before it went out.";

    const analysis = await askModel(
      config,
      TWIN_SYSTEM,
      `${playbookFor(store, claim.payer_name)}\n\n# What actually happened\nThis claim was DENIED with ${outcome.actualCarcs.join(", ") || "no stated reason codes"}.\n${priorLine}\n\n# Claim as billed (JSON)\n${JSON.stringify(claim, null, 2)}\n\nExplain why this denied and what would survive resubmission. Remember: remediation must never be to bill more.`,
      8000,
    );
    const verdict = parseTwinVerdict(analysis);

    const procedures = [...new Set(claim.service_lines.map((l) => baseProcedureCode(l.cpt_hcpcs)))];
    return {
      content: [
        `${input.claim_id} — denied by ${claim.payer_name} with ${outcome.actualCarcs.join(", ") || "no stated reason codes"}.`,
        priorLine,
        prior && prior.verdict === "PAY"
          ? "The twin called this one clean and it was not. That miss is recorded as a playbook note the next run will read."
          : "",
        `Procedures: ${procedures.join(", ")}`,
        "",
        renderVerdict(verdict),
        "",
        "This is a draft analysis. Nothing has been corrected, resubmitted, or appealed — decide what the record supports, then use claim_build_837p or appeal_draft.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});
