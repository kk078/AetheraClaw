import { SPOKEN_ABBREVIATIONS, applySpokenAbbreviations } from "./speakable.js";

// ── Saying what the system is doing while it does it ─────────────────────────
// The gateway already streams a `tool_call` event to the browser, where it
// renders as a line of text. In a voice session there is nothing to look at, so
// a ten-second claim scrub is ten seconds of silence — and silence from a thing
// that was talking a moment ago reads as a crash. People hang up, re-ask, or
// start the whole request again.
//
// One short clause fixes it. The rules it has to obey are narrow:
//
//  - PRESENT PARTICIPLE, because it describes something still happening.
//    "Checked the claim" spoken before the check finished is a lie about state.
//  - NO ARGUMENTS. This goes to a speaker in a room with other people in it, and
//    a tool input can carry a member ID, a patient name, a date of birth. There
//    is no redaction step here because there is nothing to redact: the input is
//    never consulted at all. That is a stronger guarantee than a filter.
//  - SHORT. It is spoken over the top of work, and it competes with the answer.

/**
 * What each family of tools is doing, phrased as a clause.
 *
 * Keyed by the tool-name prefix, and deliberately at the level of the FAMILY
 * rather than the individual tool. `claim_scrub`, `claim_autoheal` and
 * `claim_status_inquiry` all announce as work on the claim, and that is the
 * right altitude: the listener is being told the system is alive and roughly
 * where it is, not being read the call stack.
 *
 * Every verb here is one that stays true across its whole family. That is why
 * they are as flat as they are — `claim_` covers building, scrubbing and
 * status, so it says "checking the claim" rather than "scrubbing", which would
 * be plainly wrong two thirds of the time.
 */
export const NARRATION_VERBS: Record<string, string> = {
  claim_: "checking the claim",
  claims_: "checking the claims",
  era_: "reading the remittance",
  eob_: "reading the EOB",
  denial_: "looking at the denial",
  denials_: "looking at the denials",
  appeal_: "working the appeal",
  eligibility_: "checking eligibility",
  coverage_: "checking coverage",
  icd10_: "looking up the diagnosis code",
  icd10pcs_: "looking up the procedure code",
  hcpcs_: "looking up the HCPCS code",
  npi_: "checking the NPI",
  kpi_: "pulling the numbers",
  worklist_: "working the worklist",
  audit_: "checking the audit trail",
  research_: "reading the payer's policy",
  swarm_: "coordinating the agents",
  portal_: "working the payer portal",
  call_: "checking the call record",
  email_: "working the mailbox",
  payment_: "checking the payment",
  contract_: "checking the contract",
  credentialing_: "checking credentialing",
  policy_: "checking the rules",
  em_: "levelling the visit",
  cob_: "checking coordination of benefits",
  twin_: "running the payer twin",
  credit_: "checking the credit balance",
  timely_: "checking the filing clock",
  review_: "reviewing that",
  code_: "checking the coding",
  coding_: "checking the coding",
  reference_: "checking the reference tables",
  presubmit_: "running the pre-submission checks",
  analytics_: "running the numbers",
  web_: "searching the web",
  tool_: "looking through the tools",
};

/**
 * Tools that are the system talking about itself.
 *
 * `tool_search` is how the model finds a tool; narrating it says "looking
 * through the tools" out loud before every real answer, which tells the listener
 * nothing about their claim and trains them to ignore the narration entirely —
 * at which point the narration that matters is ignored too. The access-log and
 * tenant lookups are the same: plumbing that runs constantly and means nothing
 * to the person in the room.
 */
export const PLUMBING_TOOLS: ReadonlySet<string> = new Set([
  "tool_search",
  "tool_describe",
  "tool_invoke",
  "phi_access_record",
  "tenant_current",
]);

/**
 * Speak one word of a tool name.
 *
 * Tool names are full of initialisms that a synthesiser will happily try to
 * pronounce: "ncci" comes out as "nikki", "era" as the English word, "npi" as
 * "en-pie". SPOKEN_ABBREVIATIONS already holds the domain's answer to exactly
 * this, including the ones that are said as words ("hick picks" for HCPCS) and
 * the X12 numbers said in pair-groups (835 is "eight thirty five"), so this
 * defers to that table rather than starting a second one that would disagree
 * with it.
 */
function speakToken(token: string): string {
  const direct = SPOKEN_ABBREVIATIONS[token.toUpperCase()];
  if (direct) return direct;

  // "icd10" and "cms1500" are an initialism welded to a number, which the
  // word-boundary matcher in applySpokenAbbreviations cannot see inside.
  const welded = /^([a-z]+)(\d+)$/i.exec(token);
  if (welded) {
    const head = SPOKEN_ABBREVIATIONS[welded[1].toUpperCase()];
    if (head) return `${head} ${welded[2]}`;
  }

  return applySpokenAbbreviations(token);
}

function isAbbreviation(token: string): boolean {
  if (SPOKEN_ABBREVIATIONS[token.toUpperCase()]) return true;
  const welded = /^([a-z]+)(\d+)$/i.exec(token);
  return welded ? Boolean(SPOKEN_ABBREVIATIONS[welded[1].toUpperCase()]) : false;
}

function tokensOf(toolName: string): string[] {
  return toolName.split(/[_\-\s]+/).filter(Boolean);
}

function matchPrefix(toolName: string): string | null {
  // Longest prefix first: `icd10pcs_` must win over `icd10_`, and `credentialing_`
  // over `credit_`-style near neighbours. Leftmost-longest is not what a plain
  // scan gives, so the ordering is done here rather than trusted to key order.
  let best: string | null = null;
  for (const prefix of Object.keys(NARRATION_VERBS)) {
    if (!toolName.startsWith(prefix)) continue;
    if (!best || prefix.length > best.length) best = prefix;
  }
  return best;
}

/**
 * A clause to say while a tool runs.
 *
 * `input` is accepted and never read. It is in the signature because every call
 * site has it to hand and would otherwise be tempted to interpolate it — the
 * parameter exists so that the answer to "can I put the claim number in?" is a
 * function that visibly does not.
 *
 * For a known family the clause is the family's verb, plus any domain
 * initialism in the rest of the name — "eight thirty seven P" in
 * `claim_build_837p` is worth hearing; "build" is not, the verb already said it.
 * For an unknown name it degrades to "running <name spoken>", which is vaguer
 * but never wrong. Guessing a verb from an unfamiliar name is how a read-only
 * lookup gets announced as "submitting", and a listener who has been told
 * something was submitted behaves very differently from one who has not.
 */
export function narrateTool(toolName: string, input?: unknown): string {
  void input; // never read — see above.

  const name = (toolName ?? "").trim();
  if (!name) return "working on it";

  const prefix = matchPrefix(name);
  if (!prefix) {
    return `running ${tokensOf(name).map(speakToken).join(" ")}`;
  }

  const verb = applySpokenAbbreviations(NARRATION_VERBS[prefix]);
  const detail = tokensOf(name.slice(prefix.length))
    .filter(isAbbreviation)
    .map(speakToken);

  // A comma, because the detail is an apposition rather than an object: read
  // without the pause, "checking the claim eight thirty seven P" sounds like one
  // long noun and the number is lost inside it.
  return detail.length > 0 ? `${verb}, ${detail.join(" ")}` : verb;
}

export interface NarrateOptions {
  /**
   * Narrate plumbing tools too. Off by default; useful when someone is
   * debugging the tool-search machinery by ear and genuinely wants to hear it.
   */
  plumbing?: boolean;
}

/** Whether this tool call is worth saying out loud at all. */
export function shouldNarrate(toolName: string, opts: NarrateOptions = {}): boolean {
  const name = (toolName ?? "").trim();
  if (!name) return false;
  if (opts.plumbing) return true;
  return !PLUMBING_TOOLS.has(name);
}
