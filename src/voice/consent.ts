// ── Who may be called, and what may be recorded ──────────────────────────────
// This is the only module in the project where getting it wrong is a crime
// rather than a denial. Recording a payer representative in an all-party consent
// state without telling them is a felony in several of them, and it is the sort
// of thing a billing office does by default because the phone system has always
// recorded everything.
//
// Two separate questions, deliberately kept apart because they have different
// answers and different sources of law:
//
//   May this call be recorded? — state wiretap law, and for an interstate call
//   the safe answer is the stricter of the two states.
//
//   May this number be called at all by an AI voice? — the TCPA. The FCC ruled
//   in February 2024 that AI-generated voices are "artificial" under it, which
//   puts an AI calling a patient squarely inside the prior-express-consent
//   regime. Calling a payer's business line is a different matter.

export type ConsentRule = "one_party" | "all_party" | "contested";

/**
 * State recording-consent rules.
 *
 * Federal law (18 U.S.C. § 2511) is one-party, and states may be stricter. The
 * twelve all-party states below are the settled ones. Michigan and Nevada are
 * marked contested because their statutes read one way and their courts have
 * read them the other — which for an automated dialer means treat them as
 * all-party, since "we relied on the more convenient reading" is not a defence.
 *
 * Verify against counsel before enabling recording anywhere. This table is a
 * default, not advice, and statutes change.
 */
export const RECORDING_CONSENT: Record<string, ConsentRule> = {
  CA: "all_party",
  CT: "all_party",
  DE: "all_party",
  FL: "all_party",
  IL: "all_party",
  MD: "all_party",
  MA: "all_party",
  MT: "all_party",
  NH: "all_party",
  OR: "all_party",
  PA: "all_party",
  WA: "all_party",
  MI: "contested",
  NV: "contested",
};

export const ALL_PARTY_STATES = Object.keys(RECORDING_CONSENT).filter((s) => RECORDING_CONSENT[s] === "all_party");
export const CONTESTED_STATES = Object.keys(RECORDING_CONSENT).filter((s) => RECORDING_CONSENT[s] === "contested");

export function consentRule(state: string): ConsentRule {
  return RECORDING_CONSENT[state.trim().toUpperCase()] ?? "one_party";
}

export interface RecordingVerdict {
  /** Whether recording may proceed at all. */
  allowed: boolean;
  /** True when every party must be told and must agree, not merely notified. */
  requiresAllPartyConsent: boolean;
  /** The state whose rule governs — the stricter of the two. */
  governingState: string;
  reason: string;
  /** Words to say at the top of the call. Empty when recording is off. */
  disclosure: string;
}

const DISCLOSURE =
  "This call is being recorded for accuracy. Do you consent to being recorded? If not, I will turn the recording off and continue.";

/**
 * May this call be recorded?
 *
 * Interstate calls take the stricter rule. There is a genuine legal argument
 * about which state's law governs a call that crosses a line, and it has been
 * decided both ways — so the only posture that is safe in every forum is to
 * obey whichever end is stricter.
 */
export function recordingVerdict(
  callerState: string,
  calleeState: string,
  wantRecording: boolean,
): RecordingVerdict {
  if (!wantRecording) {
    return {
      allowed: false,
      requiresAllPartyConsent: false,
      governingState: "",
      reason: "Recording was not requested.",
      disclosure: "",
    };
  }

  const from = callerState.trim().toUpperCase();
  const to = calleeState.trim().toUpperCase();
  const rules = [
    { state: from, rule: consentRule(from) },
    { state: to, rule: consentRule(to) },
  ];
  const strict = rules.find((r) => r.rule === "all_party") ?? rules.find((r) => r.rule === "contested") ?? rules[0];

  if (!from || !to) {
    return {
      allowed: false,
      requiresAllPartyConsent: true,
      governingState: "",
      reason:
        "Both ends of the call have to be known before it can be recorded. Without them the applicable rule cannot be worked out, and guessing on a wiretap statute is not a risk worth taking for a claim status call.",
      disclosure: "",
    };
  }

  if (strict.rule === "all_party" || strict.rule === "contested") {
    return {
      allowed: true,
      requiresAllPartyConsent: true,
      governingState: strict.state,
      reason:
        strict.rule === "all_party"
          ? `${strict.state} requires every party to consent. Recording without the representative's agreement is a criminal offence there, not a compliance lapse. The call must open with the disclosure and stop recording if they decline.`
          : `${strict.state}'s statute and its courts have read the consent requirement differently, so it is treated as all-party here. Relying on the more convenient reading is not a defence.`,
      disclosure: DISCLOSURE,
    };
  }

  return {
    allowed: true,
    requiresAllPartyConsent: false,
    governingState: strict.state,
    reason: `Neither ${from} nor ${to} requires all-party consent, so one party — you — is enough under federal law. Announcing it anyway costs nothing and removes the argument.`,
    disclosure: DISCLOSURE,
  };
}

// ── Who may be called ────────────────────────────────────────────────────────

export type CallTarget = "payer" | "clearinghouse" | "provider_office" | "patient" | "unknown";

export interface CallVerdict {
  allowed: boolean;
  reason: string;
  /** What the agent must say before anything else, whoever answers. */
  identification: string;
}

/**
 * The AI has to say it is one.
 *
 * Not because a specific statute always demands it — several now do, and more
 * are coming — but because a representative answering a payer line is entitled
 * to know whether the thing asking them for a claim adjustment is a person. An
 * agent that lets someone assume otherwise is running on a misunderstanding it
 * created.
 */
export const AI_IDENTIFICATION =
  "Hello — before we start, I should tell you this call is placed by an automated assistant on behalf of the practice, not a person. A member of staff is monitoring and can take over at any point.";

export function callVerdict(target: CallTarget): CallVerdict {
  if (target === "patient") {
    return {
      allowed: false,
      reason:
        "This module does not call patients. An AI-generated voice is an 'artificial voice' under the TCPA — the FCC said so in its February 2024 declaratory ruling — so calling a patient requires prior express consent and carries per-call statutory damages if that consent is not there and provable. A patient call also cannot avoid discussing their account, and this deployment is not approved for real patient data. Use patient_letter_draft, which is written for exactly this and is reviewed before it goes out.",
      identification: "",
    };
  }
  if (target === "unknown") {
    return {
      allowed: false,
      reason:
        "The kind of line being called has to be known before dialling it. The rules for a payer's business line and a patient's mobile are not the same and the difference is statutory damages.",
      identification: "",
    };
  }
  return {
    allowed: true,
    reason: `Calling a ${target.replace("_", " ")} business line. TCPA restrictions on artificial voices are aimed at calls to consumers; a business line reached about an existing claim is a different footing. Identify the caller as automated anyway.`,
    identification: AI_IDENTIFICATION,
  };
}

export function renderConsent(recording: RecordingVerdict, call: CallVerdict): string {
  const lines: string[] = [];
  lines.push(call.allowed ? `Call permitted. ${call.reason}` : `Call refused. ${call.reason}`);
  if (!call.allowed) return lines.join("\n");

  lines.push("", `Opening line: "${call.identification}"`);

  if (!recording.allowed) {
    lines.push("", `Recording: off. ${recording.reason}`);
  } else if (recording.requiresAllPartyConsent) {
    lines.push(
      "",
      `Recording: allowed ONLY with the representative's agreement — ${recording.governingState} governs. ${recording.reason}`,
      `Ask first: "${recording.disclosure}"`,
      "If they decline, recording stops and the call continues. A transcript taken without consent is worse than no transcript.",
    );
  } else {
    lines.push("", `Recording: allowed under ${recording.governingState} rules. ${recording.reason}`);
  }

  return lines.join("\n");
}
