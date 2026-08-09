import { describe, expect, it } from "vitest";
import {
  MEDICARE_TELEHEALTH_POLICY,
  checkTelehealthLine,
  type TelehealthPolicy,
} from "../src/tools/healthcare/compliance/telehealth.js";
import {
  checkGlobalPeriod,
  daysBetween,
  isEmCode,
  parseYmd,
} from "../src/tools/healthcare/compliance/global-period.js";
import { checkIncidentTo, inferSetting } from "../src/tools/healthcare/compliance/incident-to.js";
import { scrubClaim } from "../src/tools/healthcare/claim-scrub.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";

const rules = (findings: Array<{ rule: string }>) => findings.map((f) => f.rule);
const line = (over: Partial<{ cpt_hcpcs: string; modifiers: string[]; place_of_service: string; service_date: string }> = {}) => ({
  cpt_hcpcs: "99213",
  modifiers: [] as string[],
  place_of_service: "10",
  service_date: "20250601",
  ...over,
});

describe("telehealth rules (Medicare defaults)", () => {
  const P = MEDICARE_TELEHEALTH_POLICY;

  it("passes a compliant POS 10 + modifier 95 audio-video visit", () => {
    const f = checkTelehealthLine(line({ modifiers: ["95"] }), 1, P, { telehealth: true, telehealth_modality: "audio_video" }, true);
    expect(f).toHaveLength(0);
  });

  it("flags telehealth POS without the required modifier", () => {
    const f = checkTelehealthLine(line(), 1, P, { telehealth: true }, true);
    expect(rules(f)).toContain("telehealth-modifier");
    expect(f[0].severity).toBe("error");
  });

  it("flags a telehealth-declared service billed with an office POS", () => {
    const f = checkTelehealthLine(line({ place_of_service: "11", modifiers: ["95"] }), 1, P, { telehealth: true }, true);
    expect(rules(f)).toContain("telehealth-pos");
  });

  it("prefers POS 10 when the patient was at home", () => {
    const f = checkTelehealthLine(line({ place_of_service: "02", modifiers: ["95"] }), 1, P, { telehealth: true, patient_at_home: true }, true);
    expect(rules(f)).toContain("telehealth-pos-home");
  });

  it("requires modifier 93 for audio-only and rejects a contradictory 95", () => {
    const f = checkTelehealthLine(line({ modifiers: ["95"] }), 1, P, { telehealth: true, telehealth_modality: "audio_only" }, true);
    expect(rules(f)).toContain("telehealth-modifier-audio");
    expect(rules(f)).toContain("telehealth-modifier-mismatch");
  });

  it("accepts audio-only with modifier 93", () => {
    const f = checkTelehealthLine(line({ modifiers: ["93"] }), 1, P, { telehealth: true, telehealth_modality: "audio_only" }, true);
    expect(f).toHaveLength(0);
  });

  it("ignores non-telehealth services entirely", () => {
    const f = checkTelehealthLine(line({ place_of_service: "11" }), 1, P, undefined, true);
    expect(f).toHaveLength(0);
  });

  it("announces when no stored policy exists for the payer", () => {
    const f = checkTelehealthLine(line({ modifiers: ["95"] }), 1, P, { telehealth: true }, false);
    expect(rules(f)).toContain("telehealth-policy-assumed");
  });

  it("enforces a payer that wants office POS 11 plus GT", () => {
    const commercial: TelehealthPolicy = {
      payer: "acme",
      posRule: "originating_office_11",
      requiredModifier: "GT",
      audioOnlyModifier: "",
      audioOnlyCovered: false,
      notes: "",
    };
    const f = checkTelehealthLine(line({ place_of_service: "10", modifiers: ["95"] }), 1, commercial, { telehealth: true }, true);
    expect(rules(f)).toContain("telehealth-pos-payer");
    expect(rules(f)).toContain("telehealth-modifier");
  });

  it("rejects audio-only for a payer that does not cover it", () => {
    const commercial: TelehealthPolicy = {
      payer: "acme",
      posRule: "medicare_02_10",
      requiredModifier: "95",
      audioOnlyModifier: "",
      audioOnlyCovered: false,
      notes: "",
    };
    const f = checkTelehealthLine(line({ modifiers: ["93"] }), 1, commercial, { telehealth: true, telehealth_modality: "audio_only" }, true);
    expect(rules(f)).toContain("telehealth-audio-only");
  });
});

describe("date helpers", () => {
  it("parses and rejects invalid dates", () => {
    expect(parseYmd("20250601")).toBeInstanceOf(Date);
    expect(parseYmd("20250230")).toBeNull();
    expect(parseYmd("2025-06-01")).toBeNull();
  });
  it("counts days across a month boundary", () => {
    expect(daysBetween("20250601", "20250612")).toBe(11);
    expect(daysBetween("20250601", "20250531")).toBe(-1);
  });
  it("recognizes E/M codes", () => {
    expect(isEmCode("99213")).toBe(true);
    expect(isEmCode("99202")).toBe(true);
    expect(isEmCode("27447")).toBe(false);
  });
});

describe("global surgical period rules", () => {
  const knee = { code: "27447", date: "20250601", global_days: 90 };
  const minor = { code: "11042", date: "20250601", global_days: 10 };

  it("requires modifier 24 for an E/M inside a 90-day global", () => {
    const f = checkGlobalPeriod(line({ service_date: "20250613" }), 1, [knee]);
    expect(rules(f)).toContain("global-postop-em");
    expect(f[0].message).toMatch(/post-op day 12/);
  });

  it("accepts an E/M inside the global when modifier 24 is present", () => {
    const f = checkGlobalPeriod(line({ service_date: "20250613", modifiers: ["24"] }), 1, [knee]);
    expect(rules(f)).not.toContain("global-postop-em");
  });

  it("leaves an E/M after the global period alone", () => {
    const f = checkGlobalPeriod(line({ service_date: "20250910" }), 1, [knee]);
    expect(f).toHaveLength(0);
  });

  it("requires 58/78/79 for a procedure inside the global", () => {
    const f = checkGlobalPeriod(line({ cpt_hcpcs: "27446", service_date: "20250620" }), 1, [knee]);
    expect(rules(f)).toContain("global-postop-procedure");
  });

  it("accepts a staged procedure with modifier 58", () => {
    const f = checkGlobalPeriod(line({ cpt_hcpcs: "27446", service_date: "20250620", modifiers: ["58"] }), 1, [knee]);
    expect(f).toHaveLength(0);
  });

  it("suggests modifier 57 for an E/M the day before major surgery", () => {
    const f = checkGlobalPeriod(line({ service_date: "20250531" }), 1, [knee]);
    expect(rules(f)).toContain("global-decision-for-surgery");
  });

  it("requires modifier 25 for an E/M on the day of a minor procedure", () => {
    const f = checkGlobalPeriod(line({ service_date: "20250601" }), 1, [minor]);
    expect(rules(f)).toContain("global-same-day-em");
  });

  it("flags modifier 24 when no global period is open", () => {
    const f = checkGlobalPeriod(line({ service_date: "20251201", modifiers: ["24"] }), 1, [knee]);
    expect(rules(f)).toContain("global-modifier-24-unneeded");
  });

  it("reports when the global length is unknown", () => {
    const f = checkGlobalPeriod(line({ service_date: "20250613" }), 1, [{ code: "99999", date: "20250601" }]);
    expect(rules(f)).toContain("global-data-missing");
  });
});

describe("incident-to and split/shared rules", () => {
  it("infers setting from place of service", () => {
    expect(inferSetting("11")).toBe("office");
    expect(inferSetting("22")).toBe("facility");
    expect(inferSetting("99")).toBeUndefined();
  });

  it("blocks incident-to for a new patient", () => {
    const f = checkIncidentTo(line({ cpt_hcpcs: "99213", place_of_service: "11" }), 1, {
      rendering_provider_type: "npp",
      billed_under_physician_npi: true,
      is_new_patient: true,
      physician_on_site: true,
    });
    expect(rules(f)).toContain("incident-to-new-patient");
  });

  it("blocks incident-to for a new problem and for absent supervision", () => {
    const f = checkIncidentTo(line({ place_of_service: "11" }), 1, {
      rendering_provider_type: "npp",
      billed_under_physician_npi: true,
      is_new_patient: false,
      is_new_problem: true,
      physician_on_site: false,
    });
    expect(rules(f)).toContain("incident-to-new-problem");
    expect(rules(f)).toContain("incident-to-supervision");
  });

  it("confirms a compliant incident-to visit", () => {
    const f = checkIncidentTo(line({ place_of_service: "11" }), 1, {
      rendering_provider_type: "npp",
      billed_under_physician_npi: true,
      is_new_patient: false,
      is_new_problem: false,
      physician_on_site: true,
    });
    expect(rules(f)).toEqual(["incident-to-ok"]);
    expect(f[0].severity).toBe("info");
  });

  it("requires modifier FS on a facility split/shared visit", () => {
    const f = checkIncidentTo(line({ place_of_service: "22" }), 1, {
      rendering_provider_type: "npp",
      billed_under_physician_npi: true,
      physician_performed_substantive_portion: true,
    });
    expect(rules(f)).toContain("split-shared-modifier");
  });

  it("rejects physician billing when the NPP did the substantive portion", () => {
    const f = checkIncidentTo(line({ place_of_service: "22", modifiers: ["FS"] }), 1, {
      rendering_provider_type: "npp",
      billed_under_physician_npi: true,
      physician_performed_substantive_portion: false,
    });
    expect(rules(f)).toContain("split-shared-substantive");
    expect(f[0].severity).toBe("error");
  });

  it("rejects modifier FS in the office setting", () => {
    const f = checkIncidentTo(line({ place_of_service: "11", modifiers: ["FS"] }), 1, {
      rendering_provider_type: "npp",
      billed_under_physician_npi: true,
      is_new_patient: false,
      is_new_problem: false,
      physician_on_site: true,
    });
    expect(rules(f)).toContain("split-shared-setting");
  });

  it("notes NPP services billed under their own NPI", () => {
    const f = checkIncidentTo(line({ place_of_service: "11" }), 1, {
      rendering_provider_type: "npp",
      billed_under_physician_npi: false,
    });
    expect(rules(f)).toEqual(["npp-own-npi"]);
  });

  it("stays silent for an ordinary physician service", () => {
    const f = checkIncidentTo(line({ place_of_service: "11" }), 1, { rendering_provider_type: "physician" });
    expect(f).toHaveLength(0);
  });
});

describe("compliance rules wired into claim_scrub", () => {
  const base: ClaimInput = {
    claim_id: "CMPL001",
    payer_name: "MEDICARE",
    payer_id: "12345",
    billing_provider_npi: "1234567893",
    billing_provider_name: "TEST CLINIC",
    subscriber_id: "TESTMEM001",
    patient_last: "DOE",
    patient_first: "JANE",
    patient_dob: "19700101",
    patient_sex: "F",
    diagnoses: ["E11.65"],
    service_lines: [
      {
        cpt_hcpcs: "99213",
        modifiers: [],
        charge: 120,
        units: 1,
        dx_pointers: [1],
        service_date: "20250613",
        place_of_service: "11",
      },
    ],
  };

  it("stays clean when no compliance context is supplied", () => {
    const found = rules(scrubClaim(base));
    expect(found).not.toContain("global-postop-em");
    expect(found).not.toContain("incident-to-new-patient");
  });

  it("surfaces a global-period violation through the scrubber", () => {
    const claim: ClaimInput = {
      ...base,
      compliance: { prior_procedures: [{ code: "27447", date: "20250601", global_days: 90 }] },
    };
    expect(rules(scrubClaim(claim))).toContain("global-postop-em");
  });

  it("surfaces an incident-to violation through the scrubber", () => {
    const claim: ClaimInput = {
      ...base,
      compliance: { rendering_provider_type: "npp", billed_under_physician_npi: true, is_new_patient: true },
    };
    expect(rules(scrubClaim(claim))).toContain("incident-to-new-patient");
  });

  it("surfaces a telehealth violation through the scrubber", () => {
    const claim: ClaimInput = {
      ...base,
      service_lines: [{ ...base.service_lines[0], place_of_service: "10" }],
      compliance: { telehealth: true },
    };
    const found = rules(scrubClaim(claim));
    expect(found).toContain("telehealth-modifier");
  });
});
