import type { PhiMode } from "./phi-detect.js";

// ── Acknowledging each file, one at a time ───────────────────────────────────
//
// In production mode, uploading a document is a decision about a specific
// patient's record, and it is made per file rather than once per session.
//
// The reason it is PER FILE rather than a setting somebody agrees to on Monday:
// a blanket acknowledgment is indistinguishable from no acknowledgment within a
// day of being granted. The value of the prompt is that it appears at the
// moment somebody is about to hand over a chart, naming that chart. A checkbox
// in preferences produces the paperwork without the pause.
//
// It is NOT a substitute for the posture gate. The posture decides whether PHI
// may be stored at all and refuses identifier-bearing documents outright while
// it is `blocked`. This runs after that and asks a person to take
// responsibility for a file the deployment IS allowed to keep.

export interface UploadGateInput {
  mode: PhiMode;
  /** Whether the client presented an acknowledgment for THIS file. */
  acknowledged: boolean;
  /** The filename, for the message. Never logged — filenames carry names. */
  filename: string;
}

export interface UploadGateDecision {
  allow: boolean;
  /**
   * 428 Precondition Required — the status for "your request is fine, it is
   * missing a precondition you can satisfy and retry". A 403 would say the
   * upload was forbidden, which is wrong: it is permitted, once somebody says
   * so. A 400 would say the request was malformed, which would send a
   * developer looking for a bug in their own client.
   */
  status: 200 | 428;
  why: string;
}

export function uploadGate(input: UploadGateInput): UploadGateDecision {
  if (input.mode !== "production" || input.acknowledged) {
    return { allow: true, status: 200, why: "" };
  }
  return {
    allow: false,
    status: 428,
    why:
      `This deployment is in production PHI mode, where each uploaded file is acknowledged individually. ` +
      `Confirm that you intend to store the contents of "${input.filename}" in this system, and that doing ` +
      `so is covered by an agreement with the patient's provider. Re-send the upload with acknowledgement to proceed.`,
  };
}
