import { z } from "zod";
import { defineTool } from "../../registry.js";
import { finding, type ScrubFinding } from "../finding.js";
import type { ComplianceContext } from "./context.js";
import type { MemoryStore } from "../../../memory/store.js";

// ── Telehealth billing rules ─────────────────────────────────────────────────
// Medicare's current convention: POS 10 = telehealth in the patient's home
// (paid at the non-facility rate), POS 02 = telehealth elsewhere (facility rate),
// with modifier 95 for synchronous audio-video and 93 for audio-only.
// Many commercial payers diverge — some still want the office POS (11) plus a
// modifier, some still require the legacy GT. Those differences live in an
// editable per-payer policy table rather than being hard-coded.

export interface TelehealthPolicy {
  payer: string;
  posRule: "medicare_02_10" | "originating_office_11";
  requiredModifier: string; // "95" | "GT" | "" (none)
  audioOnlyModifier: string; // "93" | "FQ" | "" (not covered)
  audioOnlyCovered: boolean;
  notes: string;
}

export const MEDICARE_TELEHEALTH_POLICY: TelehealthPolicy = {
  payer: "medicare",
  posRule: "medicare_02_10",
  requiredModifier: "95",
  audioOnlyModifier: "93",
  audioOnlyCovered: true,
  notes:
    "POS 10 (patient home) pays the non-facility rate; POS 02 (other site) pays the facility rate. Modifier 95 = synchronous audio-video, 93 = audio-only. Verify the service is on the Medicare Telehealth Services List.",
};

const TELEHEALTH_POS = new Set(["02", "10"]);
const TELEHEALTH_MODIFIERS = new Set(["95", "93", "GT", "GQ", "FQ", "FR"]);

export function loadTelehealthPolicy(store: MemoryStore | undefined, payer: string): TelehealthPolicy {
  const key = payer.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (store) {
    const row = store.db
      .prepare("SELECT policy_json FROM payer_policies WHERE kind = 'telehealth' AND payer_key = ?")
      .get(key) as { policy_json: string } | undefined;
    if (row) return JSON.parse(row.policy_json) as TelehealthPolicy;
  }
  // Medicare-style default; a payer with no stored policy is treated as Medicare-like
  // and the caller is told the assumption so they can record the real policy.
  return { ...MEDICARE_TELEHEALTH_POLICY, payer };
}

export function checkTelehealthLine(
  line: { cpt_hcpcs: string; modifiers?: string[]; place_of_service: string },
  lineNumber: number,
  policy: TelehealthPolicy,
  ctx: ComplianceContext | undefined,
  policyWasStored: boolean,
): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const mods = (line.modifiers ?? []).map((m) => m.toUpperCase());
  const posIsTelehealth = TELEHEALTH_POS.has(line.place_of_service);
  const hasTelehealthModifier = mods.some((m) => TELEHEALTH_MODIFIERS.has(m));
  const declaredTelehealth = ctx?.telehealth === true;
  const isTelehealth = posIsTelehealth || hasTelehealthModifier || declaredTelehealth;
  if (!isTelehealth) return out;

  const L = `Line ${lineNumber} (${line.cpt_hcpcs})`;

  if (!policyWasStored) {
    out.push(
      finding(
        "info",
        "telehealth-policy-assumed",
        `${L}: no stored telehealth policy for "${policy.payer}" — applying Medicare rules. Record the real policy with telehealth_policy_set to silence this.`,
      ),
    );
  }

  // POS consistency
  if (policy.posRule === "medicare_02_10") {
    if (!posIsTelehealth) {
      out.push(
        finding(
          "error",
          "telehealth-pos",
          `${L}: billed as telehealth but POS is ${line.place_of_service}. ${policy.payer} expects POS 10 (patient home) or 02 (other originating site).`,
        ),
      );
    } else if (ctx?.patient_at_home === true && line.place_of_service !== "10") {
      out.push(
        finding(
          "warning",
          "telehealth-pos-home",
          `${L}: patient was at home but POS is 02 — POS 10 is the home code and pays at the higher non-facility rate.`,
        ),
      );
    } else if (ctx?.patient_at_home === false && line.place_of_service !== "02") {
      out.push(
        finding(
          "warning",
          "telehealth-pos-site",
          `${L}: patient was not at home but POS is 10 — POS 02 applies to originating sites other than the home.`,
        ),
      );
    }
  } else if (policy.posRule === "originating_office_11") {
    if (line.place_of_service !== "11") {
      out.push(
        finding(
          "error",
          "telehealth-pos-payer",
          `${L}: ${policy.payer} requires the originating-site POS 11 with a telehealth modifier, not POS ${line.place_of_service}.`,
        ),
      );
    }
  }

  // Modality / modifier consistency
  const modality = ctx?.telehealth_modality;
  if (modality === "audio_only") {
    if (!policy.audioOnlyCovered) {
      out.push(
        finding("error", "telehealth-audio-only", `${L}: ${policy.payer} does not cover audio-only telehealth for this service.`),
      );
    } else if (policy.audioOnlyModifier && !mods.includes(policy.audioOnlyModifier)) {
      out.push(
        finding(
          "error",
          "telehealth-modifier-audio",
          `${L}: audio-only telehealth requires modifier ${policy.audioOnlyModifier} for ${policy.payer}; found ${mods.join(", ") || "none"}.`,
        ),
      );
    }
    if (mods.includes("95")) {
      out.push(
        finding(
          "error",
          "telehealth-modifier-mismatch",
          `${L}: modifier 95 asserts synchronous audio-VIDEO but the encounter is documented as audio-only.`,
        ),
      );
    }
  } else if (modality === "asynchronous") {
    if (!mods.includes("GQ")) {
      out.push(
        finding(
          "warning",
          "telehealth-async",
          `${L}: store-and-forward (asynchronous) telehealth normally requires modifier GQ.`,
        ),
      );
    }
  } else if (policy.requiredModifier && !mods.includes(policy.requiredModifier)) {
    out.push(
      finding(
        "error",
        "telehealth-modifier",
        `${L}: ${policy.payer} requires modifier ${policy.requiredModifier} on telehealth services; found ${mods.join(", ") || "none"}.`,
      ),
    );
  }

  // Legacy modifier still in use for some payers
  if (mods.includes("GT") && policy.requiredModifier === "95") {
    out.push(
      finding(
        "warning",
        "telehealth-legacy-gt",
        `${L}: modifier GT is legacy for ${policy.payer}; modifier 95 is the current requirement. Verify before submitting.`,
      ),
    );
  }

  return out;
}

// ── Tools ────────────────────────────────────────────────────────────────────

function store(ctx: { services: Record<string, unknown> }): MemoryStore {
  const s = ctx.services.store as MemoryStore | undefined;
  if (!s) throw new Error("store service unavailable");
  return s;
}

export const telehealthPolicySetTool = defineTool({
  name: "telehealth_policy_set",
  description:
    "Record or update a payer's telehealth billing policy (POS convention, required modifier, audio-only coverage). Payers diverge from Medicare here, so store what each contract actually requires; claim_scrub then enforces it.",
  schema: z.object({
    payer: z.string().describe("Payer name or key, e.g. 'medicare', 'bcbs-tx'"),
    pos_rule: z
      .enum(["medicare_02_10", "originating_office_11"])
      .describe("medicare_02_10 = POS 02/10; originating_office_11 = office POS 11 plus a modifier"),
    required_modifier: z.string().default("95").describe("Modifier for synchronous audio-video, e.g. 95 or GT ('' for none)"),
    audio_only_covered: z.boolean().default(true),
    audio_only_modifier: z.string().default("93"),
    notes: z.string().default(""),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `store telehealth policy for payer ${input.payer}` }),
  execute: async (input, ctx) => {
    const key = input.payer.toLowerCase().replace(/[^a-z0-9]/g, "");
    const policy: TelehealthPolicy = {
      payer: input.payer,
      posRule: input.pos_rule,
      requiredModifier: input.required_modifier,
      audioOnlyCovered: input.audio_only_covered,
      audioOnlyModifier: input.audio_only_modifier,
      notes: input.notes,
    };
    store(ctx)
      .db.prepare(
        "INSERT INTO payer_policies (payer_key, kind, policy_json, updated_at) VALUES (?, 'telehealth', ?, ?) ON CONFLICT(payer_key, kind) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(policy), Date.now());
    return { content: `Stored telehealth policy for ${input.payer}: POS rule ${input.pos_rule}, modifier ${input.required_modifier || "(none)"}, audio-only ${input.audio_only_covered ? `covered (mod ${input.audio_only_modifier})` : "not covered"}.` };
  },
});

export const telehealthCheckTool = defineTool({
  name: "telehealth_check",
  description:
    "Check a single telehealth service against the payer's stored policy: POS 02 vs 10 vs 11, modifier 95/93/GT/GQ, and audio-only coverage. Explains which rule applies and what to change.",
  schema: z.object({
    payer: z.string(),
    procedure_code: z.string(),
    place_of_service: z.string(),
    modifiers: z.array(z.string()).default([]),
    modality: z.enum(["audio_video", "audio_only", "asynchronous"]).default("audio_video"),
    patient_at_home: z.boolean().optional(),
  }),
  execute: async (input, ctx) => {
    const s = ctx.services.store as MemoryStore | undefined;
    const key = input.payer.toLowerCase().replace(/[^a-z0-9]/g, "");
    const stored = s
      ? (s.db.prepare("SELECT 1 FROM payer_policies WHERE kind = 'telehealth' AND payer_key = ?").get(key) as unknown)
      : undefined;
    const policy = loadTelehealthPolicy(s, input.payer);
    const findings = checkTelehealthLine(
      { cpt_hcpcs: input.procedure_code, modifiers: input.modifiers, place_of_service: input.place_of_service },
      1,
      policy,
      { telehealth: true, telehealth_modality: input.modality, patient_at_home: input.patient_at_home },
      Boolean(stored),
    );
    const body = findings.length
      ? findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`).join("\n")
      : "No telehealth findings — POS and modifiers are consistent with the policy.";
    return { content: `Policy in effect: ${policy.payer} (${policy.posRule}, modifier ${policy.requiredModifier || "none"})\n${policy.notes}\n\n${body}` };
  },
});
