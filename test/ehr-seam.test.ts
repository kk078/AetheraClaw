import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bundleResources,
  fhirDateToYmd,
  parseCoverage,
  parseEncounter,
  parsePatient,
  pickMrn,
  reconcileDemographics,
  renderMismatches,
} from "../src/ehr/connector.js";
import { SmartEhrConnector, getEhrConnector } from "../src/ehr/smart.js";

// The Patient bundle is a REAL response from the public HAPI R4 server, captured
// and scrubbed of per-call noise. It holds synthetic patients and no PHI — that
// is what the server is for. Recorded rather than mocked because a bundle
// written by hand agrees with whatever the person writing it believed, which is
// exactly the belief under test.

const BUNDLE = JSON.parse(readFileSync("test/fixtures/fhir/patient-bundle.json", "utf8"));

describe("parsing a real FHIR bundle", () => {
  it("finds the Patient resources", () => {
    const patients = bundleResources(BUNDLE, "Patient");
    expect(patients.length).toBeGreaterThan(0);
  });

  it("filters by resourceType rather than trusting the bundle", () => {
    // A searchset legitimately carries OperationOutcome and included resources
    // alongside the matches. Reading an OperationOutcome as a Patient gives a
    // patient with no name and no birth date, which looks like a data-quality
    // problem rather than a bug.
    const mixed = {
      entry: [
        { resource: { resourceType: "OperationOutcome", id: "warn" } },
        { resource: { resourceType: "Patient", id: "p1" } },
      ],
    };
    expect(bundleResources(mixed, "Patient").map((r) => r.id)).toEqual(["p1"]);
  });

  it("converts FHIR dates to the CCYYMMDD everything downstream speaks", () => {
    expect(fhirDateToYmd("1950-01-01")).toBe("19500101");
    expect(fhirDateToYmd("1950-01-01T12:00:00Z")).toBe("19500101");
    expect(fhirDateToYmd(undefined)).toBe("");
    expect(fhirDateToYmd("not a date")).toBe("");
  });

  it("reads name, identifier and birth date off the real resource", () => {
    const p = parsePatient(bundleResources(BUNDLE, "Patient")[0]);
    expect(p.id).not.toBe("");
    expect(p.birthDate).toMatch(/^\d{8}$/);
    expect(p.givenName).not.toBe("");
  });
});

describe("pickMrn", () => {
  it("prefers the identifier typed MR over whatever is listed first", () => {
    // A Patient carries several identifiers. Taking the first returns whatever
    // the server happened to list — often an internal id that means nothing to
    // the practice.
    const mrn = pickMrn([
      { system: "urn:internal", value: "999-internal" },
      { value: "MR-4471", type: { coding: [{ code: "MR" }] } },
    ]);
    expect(mrn).toBe("MR-4471");
  });

  it("falls back to a system that names itself an MRN", () => {
    expect(pickMrn([{ system: "http://hospital.example/mrn", value: "A-1" }])).toBe("A-1");
  });

  it("returns empty rather than guessing when there are none", () => {
    expect(pickMrn(undefined)).toBe("");
    expect(pickMrn([])).toBe("");
  });
});

describe("coverage parsing", () => {
  it("does NOT read a blank status as active", () => {
    // An EHR's coverage record is what the front desk typed. Treating a blank
    // as coverage is how a claim goes to a plan that ended in March.
    expect(parseCoverage({ id: "c1" }).status).toBe("");
  });

  it("keeps the payer, member id and order the server states", () => {
    const c = parseCoverage({
      id: "c1",
      status: "active",
      subscriberId: "UHC123456",
      order: "1",
      payor: [{ display: "UNITEDHEALTHCARE" }],
      class: [{ type: { coding: [{ code: "plan" }] }, name: "PPO GOLD" }],
    });
    expect(c).toMatchObject({ status: "active", payerName: "UNITEDHEALTHCARE", subscriberId: "UHC123456", planName: "PPO GOLD" });
  });
});

describe("encounter parsing", () => {
  it("takes the date from the period start, in CCYYMMDD", () => {
    const e = parseEncounter({ id: "e1", status: "finished", period: { start: "2026-01-15T09:00:00Z" } });
    expect(e.date).toBe("20260115");
  });

  it("carries the chart's diagnoses for COMPARISON, not for billing", () => {
    const e = parseEncounter({ id: "e1", diagnosis: [{ condition: { display: "Type 2 diabetes" } }] });
    expect(e.diagnoses).toEqual(["Type 2 diabetes"]);
  });
});

describe("reconciling the chart against a claim", () => {
  const patient = { id: "p1", mrn: "MR-1", familyName: "O'Brien", givenName: "Jane", birthDate: "19710101", gender: "female" };
  const coverage = { id: "c1", status: "active", payerName: "UHC", subscriberId: "UHC123456", order: "1", planName: "" };

  it("finds nothing to report when they agree", () => {
    const out = reconcileDemographics(
      { patient, coverages: [coverage] },
      { patientLast: "O'Brien", patientFirst: "Jane", patientDob: "19710101", subscriberId: "UHC123456" },
    );
    expect(out).toEqual([]);
    // And says so without implying anything about coverage, which is a
    // different question with a different answer.
    expect(renderMismatches(out)).toMatch(/not a statement about coverage/);
  });

  it("treats a date-of-birth difference as BLOCKING and names the AAA code", () => {
    const [m] = reconcileDemographics(
      { patient, coverages: [coverage] },
      { patientLast: "O'Brien", patientFirst: "Jane", patientDob: "19710102", subscriberId: "UHC123456" },
    );
    expect(m.blocking).toBe(true);
    expect(m.note).toContain("71");
  });

  it("ignores case and punctuation in a surname", () => {
    // "O'BRIEN" and "OBrien" are not a mismatch worth a person's time.
    const out = reconcileDemographics(
      { patient, coverages: [coverage] },
      { patientLast: "OBRIEN", patientFirst: "Jane", patientDob: "19710101", subscriberId: "UHC123456" },
    );
    expect(out).toEqual([]);
  });

  it("reports a genuinely different surname as worth checking, not blocking", () => {
    const [m] = reconcileDemographics(
      { patient, coverages: [coverage] },
      { patientLast: "Smith", patientFirst: "Jane", patientDob: "19710101", subscriberId: "UHC123456" },
    );
    expect(m.field).toBe("familyName");
    expect(m.blocking).toBe(false);
    // The useful instruction is about the payer's record, not about which of
    // the two local copies is "correct".
    expect(m.note).toMatch(/which one the PAYER holds/);
  });

  it("catches a member id the chart does not hold", () => {
    const [m] = reconcileDemographics(
      { patient, coverages: [coverage] },
      { patientLast: "O'Brien", patientFirst: "Jane", patientDob: "19710101", subscriberId: "WRONG-1" },
    );
    expect(m.field).toBe("subscriberId");
    expect(m.blocking).toBe(true);
    expect(m.note).toContain("72");
  });

  it("says neither side is automatically right", () => {
    // Without this, the obvious action is to "fix" the chart to match the
    // claim, which changes the clinical record to match a billing document.
    const out = renderMismatches(
      reconcileDemographics(
        { patient, coverages: [coverage] },
        { patientLast: "Smith", patientFirst: "Jane", patientDob: "19710101", subscriberId: "UHC123456" },
      ),
    );
    expect(out).toMatch(/Neither side is automatically right/);
  });

  it("says nothing about a field the chart does not have", () => {
    const blank = { ...patient, birthDate: "", familyName: "" };
    expect(reconcileDemographics({ patient: blank, coverages: [] }, {
      patientLast: "Smith", patientFirst: "Jane", patientDob: "19990101", subscriberId: "X",
    })).toEqual([]);
  });
});

describe("the connector itself", () => {
  it("refuses to guess when an identifier matches two patients", async () => {
    // Silently picking one attaches a claim to whichever the server sorted
    // first — a coin flip nobody knows was tossed.
    const c = new SmartEhrConnector({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ entry: [{ resource: { resourceType: "Patient", id: "a" } }, { resource: { resourceType: "Patient", id: "b" } }] }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(c.findPatient("MR-1")).rejects.toThrow(/Refusing to guess/);
  });

  it("THROWS on an HTTP failure rather than reporting an empty chart", async () => {
    // "No coverage on file" and "we could not ask" are opposite facts leading
    // to opposite actions — the same distinction the payer-side connector
    // exists to preserve.
    const c = new SmartEhrConnector({
      fetchImpl: (async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(c.coverages("p1")).rejects.toThrow(/says\s+nothing about what the chart contains/);
  });

  it("returns null for a genuine no-match, which is not an error", async () => {
    const c = new SmartEhrConnector({
      fetchImpl: (async () => new Response(JSON.stringify({ entry: [] }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await c.findPatient("nobody")).toBeNull();
  });

  it("never searches by name", async () => {
    let url = "";
    const c = new SmartEhrConnector({
      fetchImpl: (async (u: string) => {
        url = String(u);
        return new Response(JSON.stringify({ entry: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await c.findPatient("MR-1");
    expect(url).toContain("identifier=");
    expect(url).not.toMatch(/[?&](name|family|given)=/);
  });
});

describe("choosing a connector", () => {
  it("returns NOTHING rather than a mock when none is configured", () => {
    // There is no demo EHR in this build, deliberately: a fabricated chart is
    // worse than a fabricated anything else, because a chart is what everything
    // defers to.
    const choice = getEhrConnector({});
    expect(choice.connector).toBeNull();
    expect(choice.note).toMatch(/no chart data is being invented/);
  });

  it("announces plainly when it is pointed at a real record", () => {
    const choice = getEhrConnector({ ehr: { connector: "smart", environment: "production" } });
    expect(choice.note).toMatch(/REAL clinical record/);
  });

  it("says a sandbox connector is read-only", () => {
    expect(getEhrConnector({ ehr: { connector: "smart" } }).note).toMatch(/nothing is ever written to a chart/);
  });

  it("names an unknown connector rather than falling back quietly", () => {
    expect(getEhrConnector({ ehr: { connector: "epic-someday" } }).note).toContain("epic-someday");
  });
});
