// ── The dry run ──────────────────────────────────────────────────────────────
//
// The last moment the claim is still yours. After the send it is a claim at a
// payer, and the only corrections are a void or a replacement.
//
// WHAT THIS RENDERS AND WHY IT IS NOT JUST THE RAW 837. A wall of X12 is
// technically complete and practically unreadable, and a person asked to check
// an unreadable thing checks that it exists. So the segments are annotated with
// what each one MEANS and, for the handful that cause most rejections, what the
// payer does with it. The point is that somebody can actually catch a wrong NPI
// here, which is the entire value of the step.
//
// It also diffs the built claim against what the system BELIEVES it is billing.
// Those can differ — a claim edited after the 837 was built, a rounding
// difference in the total, a member id corrected in one place and not the other
// — and every one of those differences is a rejection nobody would predict from
// reading either side alone.

export interface SegmentNote {
  segment: string;
  /** What this segment is, in a biller's words rather than the specification's. */
  meaning: string;
  /** Set when getting this wrong is a common, specific rejection. */
  risk: string;
}

/** The segments worth explaining. Everything else is listed without commentary. */
const ANNOTATIONS: Record<string, { meaning: string; risk: string }> = {
  ISA: { meaning: "Interchange envelope — who is sending and who is receiving.", risk: "" },
  GS: { meaning: "Functional group header.", risk: "" },
  BHT: { meaning: "Transaction purpose and your claim control number.", risk: "" },
  NM1: {
    meaning: "A name and an identifier. The qualifier says whose: 85 billing provider, 87 pay-to, IL subscriber, QC patient, 82 rendering.",
    risk: "A wrong billing NPI (NM1*85) is the single commonest hard rejection there is. Check the digits, not the name.",
  },
  HL: { meaning: "Hierarchy — how the billing provider, subscriber and patient nest.", risk: "" },
  SBR: {
    meaning: "Subscriber relationship and payer sequence.",
    risk: "A primary claim filed as secondary, or the reverse, denies for coordination of benefits rather than anything clinical.",
  },
  DMG: {
    meaning: "Demographics: date of birth and gender.",
    risk: "A DOB that differs from the payer's record is AAA rejection 71 — the payer will not identify the patient at all.",
  },
  CLM: {
    meaning: "The claim: control number, total charge, place of service, and the frequency code.",
    risk: "The frequency code is the last element of the composite. 1 is an original, 7 a replacement, 8 a void. Sending a correction as 1 files a DUPLICATE.",
  },
  HI: { meaning: "Diagnosis codes, in pointer order. Line pointers refer to positions here.", risk: "" },
  LX: { meaning: "Service line number.", risk: "" },
  SV1: {
    meaning: "The service: procedure code and modifiers, charge, units, and which diagnoses it points at.",
    risk: "Charges here must sum to the CLM total. A payer that finds they do not rejects the whole claim, not the line.",
  },
  DTP: { meaning: "A date — service date, admission, onset, depending on the qualifier.", risk: "" },
  REF: { meaning: "A reference identifier — prior authorisation, referral, or the payer's own claim number.", risk: "" },
  SE: { meaning: "Transaction trailer with the segment count.", risk: "" },
  GE: { meaning: "Functional group trailer.", risk: "" },
  IEA: { meaning: "Interchange trailer.", risk: "" },
};

export function annotateSegments(x12: string): SegmentNote[] {
  return x12
    .split("~")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((segment) => {
      const tag = segment.split("*")[0];
      const a = ANNOTATIONS[tag];
      return { segment, meaning: a?.meaning ?? "", risk: a?.risk ?? "" };
    });
}

export interface ClaimBelief {
  claimRef: string;
  billingNpi: string;
  subscriberId: string;
  totalCharge: number;
  serviceDates: string[];
  procedureCodes: string[];
}

export interface DryRunDifference {
  field: string;
  onTheWire: string;
  inTheSystem: string;
  note: string;
}

/**
 * Compare what will be sent against what the system believes it is sending.
 *
 * Reads the values back OUT of the built 837 rather than trusting the object it
 * was built from. That is the whole point: the object is what somebody intended,
 * and the string is what the payer will receive. When they disagree, the string
 * wins and nobody finds out until the rejection.
 */
export function diffAgainstBelief(x12: string, belief: ClaimBelief): DryRunDifference[] {
  const out: DryRunDifference[] = [];
  const segments = x12.split("~").map((s) => s.trim());

  const billing = segments.find((s) => s.startsWith("NM1*85*"));
  const wireNpi = billing?.split("*").at(-1) ?? "";
  if (wireNpi && belief.billingNpi && wireNpi !== belief.billingNpi) {
    out.push({
      field: "billing NPI",
      onTheWire: wireNpi,
      inTheSystem: belief.billingNpi,
      note: "The payer pays whoever the wire names. A mismatch here is a hard rejection or, worse, a payment to the wrong entity.",
    });
  }

  if (belief.subscriberId && !x12.includes(belief.subscriberId)) {
    out.push({
      field: "member id",
      onTheWire: "(not present)",
      inTheSystem: belief.subscriberId,
      note: "The member id the system holds does not appear anywhere in the claim. AAA rejection 72.",
    });
  }

  const clm = segments.find((s) => s.startsWith("CLM*"));
  const wireTotal = clm ? Number(clm.split("*")[2]) : NaN;
  if (!Number.isNaN(wireTotal) && Math.abs(wireTotal - belief.totalCharge) > 0.005) {
    out.push({
      field: "total charge",
      onTheWire: wireTotal.toFixed(2),
      inTheSystem: belief.totalCharge.toFixed(2),
      note: "The billed total and the recorded total differ. Every KPI computed after this claim is computed against the wrong number.",
    });
  }

  for (const code of belief.procedureCodes) {
    if (!x12.includes(code)) {
      out.push({
        field: `procedure ${code}`,
        onTheWire: "(not present)",
        inTheSystem: code,
        note: "A service the system believes is on this claim is not on the wire. It will not be paid, and nobody will know to chase it.",
      });
    }
  }

  return out;
}

export function renderDryRun(x12: string, belief: ClaimBelief, differences: DryRunDifference[]): string {
  const lines = [
    `Dry run — ${belief.claimRef}`,
    "",
    "This is what the payer will receive. Read it. After the send it is a claim at a payer and the only",
    "corrections are a void or a replacement, both of which are new filings.",
    "",
  ];

  if (differences.length > 0) {
    lines.push("DIFFERENCES between the wire and what this system believes it is billing:", "");
    for (const d of differences) {
      lines.push(`  ${d.field}: wire "${d.onTheWire}" vs system "${d.inTheSystem}"`);
      lines.push(`      ${d.note}`);
    }
    lines.push("");
  } else {
    lines.push("The wire matches what the system believes it is billing.", "");
  }

  lines.push("SEGMENTS", "");
  for (const note of annotateSegments(x12)) {
    lines.push(`  ${note.segment}`);
    if (note.meaning) lines.push(`      ${note.meaning}`);
    // The risk line is indented differently and marked, so an eye skimming the
    // wall stops on the four or five that actually cause rejections.
    if (note.risk) lines.push(`      !!  ${note.risk}`);
  }

  lines.push(
    "",
    "CHECK BY HAND, against something other than this screen: the billing NPI digits, the member id, the dates of",
    "service, and that the line charges sum to the claim total.",
  );
  return lines.join("\n");
}
