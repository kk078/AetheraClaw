import { describe, expect, it } from "vitest";
import { boxForRule, buildCms1500View, pointerCell, pointerLetter } from "../src/views/cms1500.js";
import { summarize } from "../src/views/verdict.js";
import { buildAppealLetterView } from "../src/views/appeal.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";
import type { ScrubFinding } from "../src/tools/healthcare/finding.js";

const claim = (over: Partial<ClaimInput> = {}): ClaimInput =>
  ({
    claim_id: "CLM-1",
    payer_name: "Medicare",
    payer_id: "MC",
    billing_provider_npi: "1497714976",
    billing_provider_name: "Example Clinic",
    subscriber_id: "SUB-1",
    patient_last: "Test",
    patient_first: "Synthetic",
    patient_dob: "19800115",
    patient_sex: "U",
    diagnoses: ["E11.65", "I10"],
    service_lines: [
      { cpt_hcpcs: "99214", modifiers: ["25"], charge: 225, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      { cpt_hcpcs: "93000", charge: 60, units: 2, dx_pointers: [2], service_date: "20260115", place_of_service: "11" },
    ],
    ...over,
  }) as ClaimInput;

const f = (severity: ScrubFinding["severity"], rule: string, message: string): ScrubFinding => ({ severity, rule, message });

describe("box numbers", () => {
  // A grid with invented box numbers is worse than a table: a table makes no
  // claim, and "box 24K" teaches a field that does not exist and gets quoted
  // back to a payer.
  it("maps each rule family to the box the 02/12 form actually prints", () => {
    expect(boxForRule("date-format")).toBe("24A");
    expect(boxForRule("date-future")).toBe("24A");
    expect(boxForRule("pos-unknown")).toBe("24B");
    expect(boxForRule("telehealth-pos-home")).toBe("24B");
    expect(boxForRule("modifier-25")).toBe("24D");
    expect(boxForRule("ncci-ptp")).toBe("24D");
    expect(boxForRule("duplicate-line")).toBe("24D");
    expect(boxForRule("dx-pointer-dangling")).toBe("24E");
    expect(boxForRule("mue-absolute")).toBe("24G");
    expect(boxForRule("npi-rendering")).toBe("24J");
    expect(boxForRule("npi-billing")).toBe("33a");
    expect(boxForRule("dx-format")).toBe("21");
  });

  it("returns null rather than the nearest plausible box", () => {
    // A credentialing lapse or a missing NCCI table is a fact about the practice
    // or the installation. Putting it in a box would say the claim is wrong
    // where it is not.
    expect(boxForRule("ncci-data")).toBeNull();
    expect(boxForRule("revalidation-overdue")).toBeNull();
    expect(boxForRule("caqh-expired")).toBeNull();
    expect(boxForRule("something-nobody-wrote-yet")).toBeNull();
  });

  it("numbers diagnosis pointers as the letters box 21 prints", () => {
    // The 837 uses 1-based numbers; the paper form uses A–L, and 24E points at
    // letters. Showing "1, 2" would put the wire format on a paper form.
    expect(pointerLetter(1)).toBe("A");
    expect(pointerLetter(12)).toBe("L");
    const v = buildCms1500View(claim(), []);
    expect(v.diagnoses.map((d) => d.pointer)).toEqual(["A", "B"]);
    expect(v.lines[0].cells.find((c) => c.box === "24E")!.value).toBe("A");
    expect(v.lines[1].cells.find((c) => c.box === "24E")!.value).toBe("B");
  });
});

describe("out-of-range pointers", () => {
  it("does NOT print a valid-looking letter for a pointer past the diagnosis list", () => {
    // Caught in the browser: a claim listing three diagnoses and pointing at 5
    // rendered "E" — an ordinary-looking letter for a row that does not exist,
    // which is the dangling pointer made invisible by the form meant to show it.
    expect(pointerCell([5], 3)).toBe("5?");
    expect(pointerCell([1, 5], 3)).toBe("A 5?");
    expect(pointerCell([1, 2], 3)).toBe("A B");
  });

  it("renders it that way on the form", () => {
    const v = buildCms1500View(
      claim({ service_lines: [{ cpt_hcpcs: "93000", charge: 60, units: 1, dx_pointers: [5], service_date: "20260115", place_of_service: "11" }] } as Partial<ClaimInput>),
      [],
    );
    expect(v.lines[0].cells.find((c) => c.box === "24E")!.value).toBe("5?");
  });
});

describe("attribution", () => {
  it("highlights the box and the line a finding names", () => {
    const v = buildCms1500View(claim(), [f("error", "dx-pointer-dangling", "Line 2 (93000) points at diagnosis 5, which does not exist")]);
    const line2 = v.lines[1];
    expect(line2.severity).toBe("error");
    const cell = line2.cells.find((c) => c.box === "24E")!;
    expect(cell.severity).toBe("error");
    expect(cell.findings).toHaveLength(1);
    // And leaves the other line alone.
    expect(v.lines[0].severity).toBe("clean");
  });

  it("sends a line-level finding with no line number off the form", () => {
    // Attaching it to line 1 would highlight the wrong row, which on a form
    // reads as an assertion about that specific service.
    const v = buildCms1500View(claim(), [f("warning", "modifier-59", "Modifier 59 used without a distinct-service justification")]);
    expect(v.unattributed).toHaveLength(1);
    expect(v.lines.every((l) => l.severity === "clean")).toBe(true);
  });

  it("puts a diagnosis finding on the letter whose code it names", () => {
    const v = buildCms1500View(claim(), [f("error", "dx-format", "I10 is not a valid ICD-10-CM code as written")]);
    expect(v.diagnoses[1].severity).toBe("error");
    expect(v.diagnoses[0].severity).toBe("clean");
  });

  it("does not colour an arbitrary diagnosis when none is named", () => {
    const v = buildCms1500View(claim(), [f("error", "dx-format", "A diagnosis code is malformed")]);
    expect(v.diagnoses.every((d) => d.severity === "clean")).toBe(true);
    expect(v.unattributed).toHaveLength(1);
  });

  it("attributes a billing NPI finding to box 33a", () => {
    const v = buildCms1500View(claim(), [f("error", "npi-billing", "billing_provider_npi fails NPI validation")]);
    expect(v.header.find((c) => c.box === "33a")!.severity).toBe("error");
  });

  it("lists an off-form finding rather than dropping it", () => {
    const v = buildCms1500View(claim(), [f("info", "ncci-data", "NCCI/MUE data not installed")]);
    expect(v.unattributed).toEqual([{ severity: "info", rule: "ncci-data", message: "NCCI/MUE data not installed" }]);
  });

  it("does not print boxes the system holds no data for", () => {
    // A blank box on a form reads as "we checked and it is empty".
    const boxes = buildCms1500View(claim(), []).header.map((c) => c.box);
    expect(boxes).not.toContain("9");
    expect(boxes).not.toContain("23");
    expect(boxes).not.toContain("32");
  });
});

describe("the form itself", () => {
  it("totals charges by units, as box 28 does", () => {
    // 225 x1 + 60 x2.
    expect(buildCms1500View(claim(), []).totalCharge).toBe(345);
  });

  it("marks a diagnosis no line points at", () => {
    const v = buildCms1500View(claim({ diagnoses: ["E11.65", "I10", "J45.909"] }), []);
    expect(v.diagnoses.map((d) => d.unused)).toEqual([false, false, true]);
  });

  it("formats dates as the form prints them", () => {
    const v = buildCms1500View(claim(), []);
    expect(v.lines[0].cells.find((c) => c.box === "24A")!.value).toBe("01/15/2026");
    expect(v.header.find((c) => c.box === "3")!.value).toMatch(/01\/15\/1980/);
  });
});

describe("the card", () => {
  it("counts BOXES flagged, not findings — two findings in one box is one box to look at", () => {
    const v = {
      kind: "cms1500" as const,
      data: buildCms1500View(claim(), [
        f("error", "dx-pointer-dangling", "Line 2 (93000) points at diagnosis 5"),
        f("warning", "dx-pointer-range", "Line 2 (93000) pointer out of range"),
      ]),
    };
    const card = summarize(v)!;
    expect(card.verdict).toBe("hold");
    expect(card.facts.find((x) => x.label === "Boxes flagged")!.value).toBe("24E");
  });

  it("says the form is clean without claiming the practice is", () => {
    const v = { kind: "cms1500" as const, data: buildCms1500View(claim(), [f("info", "ncci-data", "NCCI/MUE data not installed")]) };
    const card = summarize(v)!;
    expect(card.verdict).toBe("clear");
    expect(card.because).toMatch(/belong to no box/);
  });
});

// ── Appeal letter ────────────────────────────────────────────────────────────
// The canvas is a review surface. The Markdown file appeal_draft writes is the
// editable artifact, and these tests hold the one thing the panel adds: the
// citation state where it cannot be missed.
describe("appeal letter", () => {
  const letter = (over: Partial<Parameters<typeof buildAppealLetterView>[0]> = {}) =>
    buildAppealLetterView({
      claimId: "CLM-9",
      payer: "Medicare",
      serviceDate: "20260115",
      carc: "50",
      carcDescription: "Not deemed a medical necessity by the payer",
      filePath: "appeals/clm-9.md",
      patientReference: "Patient A / synthetic",
      serviceDescription: "MRI lumbar spine without contrast",
      clinicalSummary: "Six weeks of conservative therapy failed.",
      citations: ["LCD L34220"],
      citationsVerified: true,
      ...over,
    });

  it("is clear only when policy is cited AND confirmed", () => {
    const v = letter();
    expect(v.citationWarning).toBeNull();
    expect(summarize({ kind: "appeal_letter", data: v })!.verdict).toBe("clear");
  });

  it("HOLDs on unverified citations — sending is the irreversible step", () => {
    const v = letter({ citationsVerified: false });
    expect(v.citationWarning?.severity).toBe("error");
    const card = summarize({ kind: "appeal_letter", data: v })!;
    expect(card.verdict).toBe("hold");
    expect(card.because).toMatch(/false statement to the government/);
  });

  it("flags an appeal that cites no policy at all, without calling it a falsehood", () => {
    const v = letter({ citations: [], citationsVerified: true });
    expect(v.citationWarning?.severity).toBe("warning");
    expect(summarize({ kind: "appeal_letter", data: v })!.verdict).toBe("review");
  });

  it("names the file, because that is the thing a person edits", () => {
    const card = summarize({ kind: "appeal_letter", data: letter() })!;
    expect(card.facts.find((f) => f.label === "Editable file")!.value).toBe("appeals/clm-9.md");
  });

  it("drops blank citations rather than counting them as cited", () => {
    expect(letter({ citations: ["  ", ""] }).citations).toEqual([]);
    expect(letter({ citations: ["  ", ""] }).citationWarning?.severity).toBe("warning");
  });
});
