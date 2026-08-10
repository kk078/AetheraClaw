import type { PhiSignal } from "../channels/email/classify.js";
import type { Exposure } from "../gateway/auth.js";
import { readEnv } from "./legacy.js";

// ── What this deployment is allowed to hold ──────────────────────────────────
// ORION is going onto a public hostname for trials and presentations BEFORE the
// Business Associate Agreement with the hosting provider is signed. Those two
// facts together decide something the software has to enforce rather than
// document: until that agreement exists, protected health information must not
// reach this deployment at all.
//
// A note in a slide deck does not enforce it. What actually happens at a trial
// is that a prospect, wanting to see whether the thing works on THEIR data,
// drags a real EOB onto the console — because that is the honest question they
// came to answer. If the application accepts it, a covered entity has just
// disclosed PHI to a business associate that has not agreed to protect it, and
// the incident belongs to them as much as to us.
//
// So the posture is a gate on the ingress path, and the answer to "is this
// allowed" defaults to NO:
//
//   BLOCKED is the default for any gateway that is not on loopback. Publishing
//   the application is exactly the condition under which the paperwork matters,
//   so exposure alone is enough to close the door. Nobody has to remember a
//   flag; forgetting one fails safe.
//
//   PERMITTED requires somebody to say so out loud, with ORION_PHI=permitted.
//   That is the switch to throw the day the BAA is countersigned, and it is
//   deliberately a single obvious thing rather than a combination.
//
//   LOOPBACK is unchanged — a laptop reading its own files is not a disclosure
//   to anyone, and the README's existing posture continues to govern it.
//
// This is a REFUSAL, not a redaction. Stripping the identifiers and keeping the
// document would be worse on both counts: the practice loses the document it
// needed read, and the bytes still arrived here, which is the thing the
// agreement is about.

export type PhiPosture = "blocked" | "permitted";

export interface PostureVerdict {
  posture: PhiPosture;
  /** Where the decision came from, for the banner and the ops surface. */
  source: "explicit" | "exposed-default" | "loopback-default";
  /** One sentence, safe to show a prospect in a demo. */
  why: string;
}

export interface PostureInput {
  exposure: Exposure;
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide the deployment's posture.
 *
 * Pure, and separated from the route that uses it, so the rule can be tested
 * without a socket — and so there is exactly one place that answers this
 * question rather than a check per ingress path that can drift apart.
 */
export function resolvePosture(input: PostureInput): PostureVerdict {
  const setting = (readEnv("PHI", input.env ?? process.env) ?? "").trim().toLowerCase();

  if (setting === "permitted") {
    return {
      posture: "permitted",
      source: "explicit",
      why: "This deployment is configured to accept protected health information (ORION_PHI=permitted).",
    };
  }

  // Anything else explicit — including a typo, including "true", including
  // "yes" — reads as blocked. A permissive setting for PHI must be spelled
  // exactly; guessing at the operator's intent is the wrong instinct here.
  if (setting !== "") {
    return {
      posture: "blocked",
      source: "explicit",
      why: "This deployment does not accept protected health information. Use synthetic or de-identified records.",
    };
  }

  if (input.exposure === "exposed") {
    return {
      posture: "blocked",
      source: "exposed-default",
      why:
        "This is a hosted trial deployment and does not accept protected health information. " +
        "Upload synthetic or de-identified records; a real patient record will be refused, not redacted.",
    };
  }

  return {
    posture: "permitted",
    source: "loopback-default",
    why: "Running locally; the posture in the README governs what this install may hold.",
  };
}

export interface IngressDecision {
  accept: boolean;
  /** Signal kinds that caused a refusal. Kinds only — never values. */
  kinds: string[];
  /** What to tell the person who just uploaded something. */
  reason: string;
}

/**
 * Screen one document's PHI signals against the posture.
 *
 * `signals` come from detectPhi, which reports a KIND and a COUNT and
 * deliberately never the matched text. That property is load-bearing here: the
 * refusal this produces gets logged, shown in a browser and possibly
 * screenshotted into a deck, so it must be able to say "a Social Security
 * number pattern" without ever repeating the number.
 */
export function screenIngress(signals: PhiSignal[], posture: PhiPosture): IngressDecision {
  if (posture === "permitted" || signals.length === 0) {
    return { accept: true, kinds: [], reason: "" };
  }
  const kinds = [...new Set(signals.map((s) => s.kind))].sort();
  return {
    accept: false,
    kinds,
    reason:
      `This document was refused before it was stored: it contains ${describeKinds(kinds)}, ` +
      "and this deployment is not yet covered by a Business Associate Agreement, so it cannot hold " +
      "protected health information. Nothing from the file was written — not the text, not an extract, " +
      "not a hash of it. To try the reader, use a synthetic or de-identified copy; every capability here " +
      "works the same on one.",
  };
}

const KIND_NAMES: Record<string, string> = {
  ssn: "a Social Security number",
  mbi: "a Medicare Beneficiary Identifier",
  hicn: "a legacy Medicare (HICN) number",
  dob: "a date of birth",
};

function describeKinds(kinds: string[]): string {
  const named = kinds.map((k) => KIND_NAMES[k] ?? k);
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}
