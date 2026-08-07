import { CARC } from "../denial-codes.js";

// ── Payer playbook ───────────────────────────────────────────────────────────
// What the twin knows about a specific payer: what that payer has actually done
// to this practice's claims, plus the notes calibration has written about where
// the twin was wrong before.
//
// The learned notes are the part that makes the twin get better at being YOUR
// payers rather than payers in general, and they are kept separate from the
// statistics so it is always visible which is evidence and which is correction.

export interface PayerStats {
  payer: string;
  claims: number;
  denied: number;
  carcs: Array<{ carc: string; count: number; amount: number }>;
}

export interface PlaybookNote {
  note: string;
  kind: "miss" | "over_call" | "wrong_reason" | "manual";
  createdAt: number;
}

export function payerKey(payer: string): string {
  return payer.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface PlaybookInput {
  payer: string;
  stats: PayerStats | null;
  notes: PlaybookNote[];
  /** Total adjudicated lines across all payers, for context on how thin the history is. */
  totalObservations: number;
}

/** The twin's briefing. Written to be read by a model, so it states its own limits. */
export function buildPlaybook(input: PlaybookInput): string {
  const lines: string[] = [`# Payer playbook: ${input.payer}`, ""];

  if (!input.stats || input.stats.claims === 0) {
    lines.push(
      "No adjudicated history with this payer yet.",
      "",
      "Adjudicate from general payer behaviour and published policy, and say so — a prediction with no history behind it is a guess about payers in general, not about this one.",
    );
  } else {
    const rate = input.stats.claims > 0 ? input.stats.denied / input.stats.claims : 0;
    lines.push(
      `Observed: ${input.stats.claims} claim(s), ${input.stats.denied} denied (${(rate * 100).toFixed(1)}%).`,
    );
    if (input.stats.claims < 20) {
      lines.push(
        `That is a thin history — ${input.stats.claims} claim(s) is not enough to establish what this payer does. Weight published policy over these numbers.`,
      );
    }
    if (input.stats.carcs.length > 0) {
      lines.push("", "Reasons this payer has actually used, by dollars:");
      for (const c of input.stats.carcs.slice(0, 12)) {
        lines.push(`- CARC ${c.carc} (${CARC[c.carc]?.desc ?? "not in the bundled dataset"}): ${c.count}× · $${c.amount.toFixed(2)}`);
      }
    }
  }

  if (input.notes.length > 0) {
    lines.push(
      "",
      "## Where this twin has been wrong before",
      "",
      "These come from scoring past predictions against real remittances. They describe this twin's errors, not the payer's rules:",
      "",
    );
    for (const note of input.notes.slice(0, 20)) {
      lines.push(`- [${note.kind.replace(/_/g, " ")}] ${note.note}`);
    }
    lines.push(
      "",
      "Correct for these. A pattern listed as an over-call should not be flagged again without a stronger reason than last time.",
    );
  }

  lines.push(
    "",
    `Context: ${input.totalObservations} adjudicated line(s) across all payers in local history.`,
  );
  return lines.join("\n");
}
