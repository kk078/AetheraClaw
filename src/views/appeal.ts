import type { LineSeverity } from "./types.js";

// ── Appeal letter canvas ─────────────────────────────────────────────────────
// A REVIEW surface, not an editor.
//
// The plan called for an appeal canvas the user could edit. Reading what
// appeal_draft already does made that the wrong build: the tool writes a
// Markdown file into the workspace, which is persistent, portable, diffable and
// openable in whatever the practice already uses. A contenteditable panel in a
// browser tab would be a SECOND copy of the letter whose changes vanish on
// refresh — an editor that quietly loses work is worse than no editor.
//
// So the canvas shows the letter for review and printing, and names the file
// that is the real artifact. The one thing it adds beyond the prose is putting
// the citation-verification state where it cannot be missed.

export interface AppealSection {
  heading: string;
  body: string;
}

export interface AppealLetterView {
  claimId: string;
  payer: string;
  serviceDate: string;
  carc: string;
  carcDescription: string;
  /** Workspace-relative path of the Markdown file, which is the editable artifact. */
  filePath: string;
  recipient: string;
  patientReference: string;
  sections: AppealSection[];
  citations: string[];
  /**
   * Whether the author confirmed each citation against the coverage tools.
   *
   * Rendered as a banner rather than a footnote. A fabricated NCD or LCD in a
   * Medicare appeal is a false statement to the government, and an unverified
   * citation reads exactly like a verified one on a printed page.
   *
   * Belt and braces: `checkCitations` already REFUSES to draft at all when an
   * identifier-shaped citation ("LCD L34220") is unverified, so this banner
   * fires for the case that gate lets through — free-text citations like "payer
   * policy bulletin, March 2026", which carry no identifier to look up and are
   * therefore the ones a reader is most likely to take on trust.
   */
  citationsVerified: boolean;
  citationWarning: { severity: LineSeverity; text: string } | null;
}

export function buildAppealLetterView(input: {
  claimId: string;
  payer: string;
  serviceDate: string;
  carc: string;
  carcDescription: string;
  filePath: string;
  patientReference: string;
  serviceDescription: string;
  clinicalSummary: string;
  citations: string[];
  citationsVerified: boolean;
}): AppealLetterView {
  const citations = input.citations.filter((c) => c.trim().length > 0);

  const citationWarning: AppealLetterView["citationWarning"] =
    citations.length === 0
      ? {
          severity: "warning",
          text: "No coverage policy is cited. An appeal that argues medical necessity without naming the policy it is necessary under is the weakest form of this letter — look the applicable NCD or LCD up with the coverage tools and cite it.",
        }
      : input.citationsVerified
        ? null
        : {
            severity: "error",
            text: "These citations are NOT marked verified. Look each identifier up with coverage_search_national or coverage_search_local and confirm it exists and says what this letter claims before sending. A fabricated citation in a Medicare appeal is a false statement to the government.",
          };

  return {
    claimId: input.claimId,
    payer: input.payer,
    serviceDate: input.serviceDate,
    carc: input.carc,
    carcDescription: input.carcDescription,
    filePath: input.filePath,
    recipient: `${input.payer} — Appeals Department`,
    patientReference: input.patientReference,
    sections: [
      { heading: "Service appealed", body: input.serviceDescription },
      { heading: "Clinical justification", body: input.clinicalSummary },
      {
        heading: "Request",
        body: "The documentation establishes that the service was reasonable and medically necessary under the cited policy. We request the denial be overturned and the claim processed for payment. Supporting records are available on request.",
      },
    ],
    citations,
    citationsVerified: input.citationsVerified,
    citationWarning,
  };
}
