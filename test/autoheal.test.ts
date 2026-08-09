import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autohealClaim, renderAutoheal } from "../src/tools/healthcare/autoheal.js";
import { denialCandidates, isRecoverable, isReversal, renderIngest } from "../src/tools/healthcare/prediction/intake.js";
import { parse835 } from "../src/tools/healthcare/x12/835.js";
import { MemoryStore } from "../src/memory/store.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";
import type { Era } from "../src/tools/healthcare/x12/835.js";

const claim = (over: Partial<ClaimInput> = {}): ClaimInput => ({
  claim_id: "C1",
  payer_name: "Medicare",
  payer_id: "MCR",
  billing_provider_npi: "1234567893",
  billing_provider_name: "Test Clinic",
  subscriber_id: "TEST123",
  patient_last: "Test",
  patient_first: "Pat",
  patient_dob: "19700101",
  patient_sex: "U",
  diagnoses: ["E11.9"],
  service_lines: [
    {
      cpt_hcpcs: "99214",
      charge: 200,
      units: 1,
      dx_pointers: [1],
      service_date: "20260115",
      place_of_service: "11",
    },
  ],
  ...over,
});

const line = (over: Partial<ClaimInput["service_lines"][number]> = {}) => ({
  cpt_hcpcs: "99214",
  charge: 200,
  units: 1,
  dx_pointers: [1],
  service_date: "20260115",
  place_of_service: "11",
  ...over,
});

describe("auto-heal — what it will fix", () => {
  it("reformats an unambiguous date without changing it", () => {
    const r = autohealClaim(claim({ service_lines: [line({ service_date: "2026-01-15" })] }));
    expect(r.applied.map((a) => a.rule)).toEqual(["date-format"]);
    expect(r.claim.service_lines[0].service_date).toBe("20260115");
    expect(r.applied[0].from).toBe("2026-01-15");
  });

  it("handles the US written form, which the 837 has no ambiguous counterpart for", () => {
    const r = autohealClaim(claim({ service_lines: [line({ service_date: "01/15/2026" })] }));
    expect(r.claim.service_lines[0].service_date).toBe("20260115");
  });

  it("leaves a two-digit year alone, because it is genuinely ambiguous", () => {
    const r = autohealClaim(claim({ service_lines: [line({ service_date: "01/15/26" })] }));
    expect(r.applied).toHaveLength(0);
    expect(r.claim.service_lines[0].service_date).toBe("01/15/26");
  });

  it("pads a single-digit place of service", () => {
    const r = autohealClaim(claim({ service_lines: [line({ place_of_service: "2" })] }));
    expect(r.applied.map((a) => a.rule)).toContain("pos-width");
    expect(r.claim.service_lines[0].place_of_service).toBe("02");
  });

  it("does not mutate the claim it was given", () => {
    const original = claim({ service_lines: [line({ service_date: "2026-01-15" })] });
    autohealClaim(original);
    expect(original.service_lines[0].service_date).toBe("2026-01-15");
  });

  it("says nothing to fix without implying the claim will pay", () => {
    const out = renderAutoheal(autohealClaim(claim()));
    expect(out).toMatch(/Nothing to repair/);
    expect(out).toMatch(/not a statement that the claim will pay/);
  });
});

describe("auto-heal — what it refuses to fix", () => {
  it("REFUSES to rewrite POS to agree with a telehealth modifier", () => {
    // The proposed rule. POS is a factual assertion about where the service
    // happened; the modifier may be the error, and nothing on the claim says
    // which. Auto-correcting invents a fact on a Medicare claim.
    const r = autohealClaim(claim({ service_lines: [line({ modifiers: ["95"], place_of_service: "11" })] }));
    expect(r.applied).toHaveLength(0);
    expect(r.claim.service_lines[0].place_of_service).toBe("11");
    const finding = r.needsReview.find((n) => n.rule === "telehealth-mismatch");
    expect(finding).toBeDefined();
    expect(finding?.question).toMatch(/false statement on a Medicare claim/);
    // And names why 02 vs 10 is not derivable from the claim at all.
    expect(finding?.question).toMatch(/10 if the patient was at home/);
  });

  it("flags the mirror case — telehealth POS with no modifier", () => {
    const r = autohealClaim(claim({ service_lines: [line({ place_of_service: "10" })] }));
    expect(r.needsReview.some((n) => n.rule === "telehealth-mismatch")).toBe(true);
    expect(r.applied).toHaveLength(0);
  });

  it("accepts a consistent telehealth line without comment", () => {
    const r = autohealClaim(claim({ service_lines: [line({ modifiers: ["95"], place_of_service: "10" })] }));
    expect(r.needsReview).toHaveLength(0);
  });

  it("refuses to drop a dangling diagnosis pointer", () => {
    // Dropping it changes what the claim says justified the service.
    const r = autohealClaim(claim({ diagnoses: ["E11.9"], service_lines: [line({ dx_pointers: [1, 3] })] }));
    const finding = r.needsReview.find((n) => n.rule === "dx-pointer-dangling");
    expect(finding).toBeDefined();
    expect(r.claim.service_lines[0].dx_pointers).toEqual([1, 3]);
    expect(finding?.question).toMatch(/not a formatting repair/);
  });

  it("flags an unassigned place of service instead of guessing one", () => {
    const r = autohealClaim(claim({ service_lines: [line({ place_of_service: "38" })] }));
    const finding = r.needsReview.find((n) => n.rule === "pos-unknown");
    expect(finding?.detail).toMatch(/unassigned/);
    expect(finding?.question).toMatch(/pos_lookup/);
  });

  it("explains the refusal rather than listing it silently", () => {
    const out = renderAutoheal(autohealClaim(claim({ service_lines: [line({ modifiers: ["95"] })] })));
    expect(out).toMatch(/NOT repaired/);
    expect(out).toMatch(/inventing a fact/);
    expect(out).toMatch(/remove typing, not to decide what happened/);
  });

  it("applies the safe repairs on a line that also needs review", () => {
    // A refusal on one rule must not block an unrelated formatting fix.
    const r = autohealClaim(
      claim({ service_lines: [line({ modifiers: ["95"], service_date: "2026-01-15" })] }),
    );
    expect(r.claim.service_lines[0].service_date).toBe("20260115");
    expect(r.needsReview.some((n) => n.rule === "telehealth-mismatch")).toBe(true);
  });
});

describe("denial intake from a remittance", () => {
  const era = (claims: Era["claims"]): Era => ({ payer: "Medicare", payee: "Clinic", checkOrEftAmount: 0, claims });
  const eraClaim = (over: Partial<Era["claims"][number]> = {}): Era["claims"][number] => ({
    claimId: "C1",
    statusCode: "4",
    charged: 200,
    paid: 0,
    patientResponsibility: 0,
    payerControlNumber: "P1",
    lines: [],
    ...over,
  });

  it("queues a genuine denial", () => {
    const found = denialCandidates(
      era([eraClaim({ lines: [{ procedure: "99214", charged: 200, paid: 0, units: 1, rarcs: [], adjustments: [{ group: "CO", carc: "197", amount: 200 }] }] })]),
    );
    expect(found).toHaveLength(1);
    expect(found[0].carc).toBe("197");
    expect(found[0].amountCents).toBe(20000);
  });

  it("skips contractual write-offs and patient responsibility", () => {
    // Working these recovers nothing; queueing them makes the list look busy.
    expect(isRecoverable("45")).toBe(false); // contractual
    expect(isRecoverable("1")).toBe(false); // deductible — patient responsibility
    expect(isRecoverable("253")).toBe(false); // sequestration — regulatory
    expect(isRecoverable("197")).toBe(true);
  });

  it("queues an unknown CARC rather than dropping it", () => {
    // A code the bundled dataset lacks is exactly the one nobody notices missing.
    expect(isRecoverable("ZZZ9")).toBe(true);
  });

  it("sums lines denied for the same reason into one item", () => {
    const found = denialCandidates(
      era([
        eraClaim({
          lines: [
            { procedure: "99214", charged: 200, paid: 0, units: 1, rarcs: [], adjustments: [{ group: "CO", carc: "197", amount: 200 }] },
            { procedure: "93000", charged: 50, paid: 0, units: 1, rarcs: [], adjustments: [{ group: "CO", carc: "197", amount: 50 }] },
          ],
        }),
      ]),
    );
    // Three items at a third of the value each would rank as three small jobs.
    expect(found).toHaveLength(1);
    expect(found[0].amountCents).toBe(25000);
    expect(found[0].procedure).toContain("93000");
  });

  it("ignores a reversal", () => {
    expect(isReversal({ ...eraClaim({ statusCode: "22" }) })).toBe(true);
    const found = denialCandidates(
      era([eraClaim({ statusCode: "22", lines: [{ procedure: "99214", charged: 200, paid: 0, units: 1, rarcs: [], adjustments: [{ group: "CO", carc: "197", amount: 200 }] }] })]),
    );
    expect(found).toEqual([]);
  });

  it("gives the same claim+CARC a stable key across parses", () => {
    const build = () =>
      denialCandidates(
        era([eraClaim({ claimId: " c1 ", lines: [{ procedure: "99214", charged: 200, paid: 0, units: 1, rarcs: [], adjustments: [{ group: "CO", carc: "197", amount: 200 }] }] })]),
      )[0].key;
    expect(build()).toBe(build());
    expect(build()).toBe("C1|197");
  });

  it("reports skipped write-offs rather than staying silent about them", () => {
    const out = renderIngest({ opened: 0, alreadyOpen: 0, skippedNonRecoverable: 4, totalCents: 0 }, "Medicare");
    expect(out).toMatch(/nothing to recover/);
  });
});

describe("835 ingest writes worklist rows once", () => {
  let dir: string;
  let store: MemoryStore;

  // A minimal 835 with one denied line.
  const ERA = [
    "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260115*1200*^*00501*000000001*0*P*:~",
    "GS*HP*SENDER*RECEIVER*20260115*1200*1*X*005010X221A1~",
    "ST*835*0001~",
    "BPR*I*0*C*ACH***********20260115~",
    "N1*PR*MEDICARE~",
    "N1*PE*TEST CLINIC~",
    "CLP*CLAIM-77*4*200*0*0*MC*PCN1~",
    "SVC*HC:99214*200*0**1~",
    "CAS*CO*197*200~",
    "SE*8*0001~",
    "GE*1*1~",
    "IEA*1*000000001~",
  ].join("");

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ingest-"));
    store = new MemoryStore(path.join(dir, "db.sqlite"));
  });
  afterAll(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens an item on the first parse and none on the second", async () => {
    const { eraParse835Tool } = await import("../src/tools/healthcare/x12/835.js");
    const ctx = {
      workspaceRoot: dir,
      sessionId: "s",
      approvalPolicy: "never" as const,
      requestApproval: async () => true,
      services: { store },
    };

    const first = await eraParse835Tool.execute({ era_text: ERA }, ctx);
    expect(first.content).toMatch(/1 denial\(s\) opened/);

    // A clearinghouse download and an email attachment are the same file.
    const second = await eraParse835Tool.execute({ era_text: ERA }, ctx);
    expect(second.content).toMatch(/already open/);

    const rows = store.db.prepare("SELECT * FROM worklist_items WHERE kind = 'denial'").all() as Array<{
      title: string;
      detail_json: string;
    }>;
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail_json) as { carc: string; amount_cents: number; key: string };
    expect(detail.carc).toBe("197");
    expect(detail.amount_cents).toBe(20000);
    expect(detail.key).toBe("CLAIM-77|197");
  });

  it("reopens after the item is closed, because the payer denied it again", () => {
    store.db.prepare("UPDATE worklist_items SET status = 'done' WHERE kind = 'denial'").run();
    const stillSuppressing = store.db
      .prepare(
        "SELECT id FROM worklist_items WHERE kind='denial' AND status IN ('open','in_progress') AND json_extract(detail_json,'$.key') = ?",
      )
      .get("CLAIM-77|197");
    expect(stillSuppressing).toBeUndefined();
  });

  it("also parses without a store, unchanged", async () => {
    const { eraParse835Tool } = await import("../src/tools/healthcare/x12/835.js");
    const result = await eraParse835Tool.execute(
      { era_text: ERA },
      {
        workspaceRoot: dir,
        sessionId: "s",
        approvalPolicy: "never" as const,
        requestApproval: async () => true,
        services: {},
      },
    );
    expect(result.content).toMatch(/CLAIM-77/);
    expect(result.content).not.toMatch(/opened in the worklist/);
  });
});
