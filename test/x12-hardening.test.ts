import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse835, parse835All, summarizeEra } from "../src/tools/healthcare/x12/835.js";
import { parseX12 } from "../src/tools/healthcare/x12/segments.js";
import { buildSecondary837 } from "../src/tools/healthcare/x12/837-cob.js";
import { parse277ca } from "../src/tools/healthcare/x12/277ca.js";
import { reconcileEra } from "../src/reports/reconcile.js";
import { MemoryStore } from "../src/memory/store.js";

const ISA = "ISA*00*          *00*          *ZZ*S              *ZZ*R              *260101*1200*^*00501*000000001*0*P*:";

describe("parse835 — batched files and terminators", () => {
  const batched = (term: string) =>
    [
      ISA,
      "GS*HP*S*R*20260101*1200*1*X*005010X221A1",
      "ST*835*0001",
      "BPR*I*100*C*ACH",
      "N1*PR*ALPHA",
      "CLP*CLAIM-A*1*100*100*0*12*PCN1",
      "SE*5*0001",
      "ST*835*0002",
      "BPR*I*100*C*ACH",
      "N1*PR*BETA",
      "CLP*CLAIM-B*1*100*100*0*12*PCN2",
      "SE*5*0002",
      "GE*2*1",
      "IEA*1*000000001",
    ].join(term);

  it("splits multiple transaction sets so each cheque reconciles on its own", () => {
    const eras = parse835All(batched("~"));
    expect(eras).toHaveLength(2);
    expect(eras.map((e) => e.checkOrEftAmount)).toEqual([100, 100]);
    expect(eras.every((e) => reconcileEra(e).balanced)).toBe(true);
  });

  it("does not report a phantom imbalance on a balanced batched file", () => {
    // The single-Era aggregate keeps the true total, not just the last BPR.
    const era = parse835(batched("~"));
    expect(era.checkOrEftAmount).toBe(200);
    expect(era.claims).toHaveLength(2);
  });

  it("parses a newline-terminated interchange that carries no ~", () => {
    const ids = parseX12(batched("\n")).map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual(["ISA", "GS", "ST", "BPR"]);
  });
});

describe("summarizeEra — signed CAS amounts", () => {
  it("renders a payment-increasing negative CAS as +$, not a garbled -$-", () => {
    const rev =
      `${ISA}~GS*HP*S*R*20260101*1200*1*X*005010X221A1~ST*835*0001~BPR*I*90.5*C*ACH~N1*PR*ACME~` +
      "CLP*C1*22*100*90.5*0*12*PCN~SVC*HC:99213*100*90.5*1~CAS*CO*45*-34.5~SE*7*0001~GE*1*1~IEA*1*000000001~";
    const line = summarizeEra(parse835(rev)).split("\n").find((l) => l.includes("CO-45"))!;
    expect(line).toContain("+$34.50");
    expect(line).not.toContain("-$-");
  });
});

describe("buildSecondary837 — duplicate base CPT on two lines", () => {
  it("pairs each claim line to its own remittance line, not the first match", () => {
    const era835 =
      `${ISA}~GS*HP*S*R*20260101*1200*1*X*005010X221A1~ST*835*0001~BPR*I*80*C*ACH~N1*PR*ACME~` +
      "CLP*C1*1*240*80*0*12*PCN~SVC*HC:20610:RT*120*80*1~CAS*CO*45*40~SVC*HC:20610:LT*120*0*1~CAS*CO*50*120~SE*9*0001~GE*1*1~IEA*1*000000001~";
    const primary = parse835(era835).claims[0];
    const claim = {
      claim_id: "C1",
      diagnoses: ["M25.561"],
      billing_provider: { npi: "1234567893", name: "P" },
      subscriber: {},
      patient: {},
      service_lines: [
        { cpt_hcpcs: "20610", modifiers: ["RT"], charge: 120, units: 1, place_of_service: "11", service_date: "20260101", dx_pointers: [1] },
        { cpt_hcpcs: "20610", modifiers: ["LT"], charge: 120, units: 1, place_of_service: "11", service_date: "20260101", dx_pointers: [1] },
      ],
    };
    const out = buildSecondary837(claim as never, primary, {
      primaryPayerId: "ACME",
      adjudicationDate: "20260110",
      secondary: { id: "BETA", name: "Beta" },
    });
    const segs = out.split(/[~\n]/).filter((l) => /^(SV1|SVD|CAS)/.test(l));
    // RT line: paid 80, CO-45. LT line: paid 0 (denied), CO-50.
    expect(segs).toContain("SVD*ACME*80.00*HC:20610:RT**1");
    expect(segs).toContain("CAS*CO*45*40.00");
    expect(segs).toContain("SVD*ACME*0.00*HC:20610:LT**1");
    expect(segs).toContain("CAS*CO*50*120.00");
  });
});

describe("277CA — unknown category and reparse", () => {
  let home: string;
  let store: MemoryStore;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-277-"));
    store = new MemoryStore(path.join(home, "db.sqlite"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("does not default an unknown status category to accepted", () => {
    const ack =
      `${ISA}~GS*HN*S*R*20260101*1200*1*X*005010X214~ST*277*0001~` +
      "BHT*0085*08*REF*20260101*1200*TH~HL*1**20*1~NM1*PR*2*ALPHA*****PI*12345~" +
      "HL*2*1*21*1~NM1*41*2*SUBMITTER*****46*SUB~HL*3*2*19*1~NM1*85*2*PROVIDER*****XX*1234567893~" +
      "HL*4*3*PT*0~NM1*QC*1*DOE*JOHN~TRN*2*CLM-X~STC*E2:21*20260101*WQ~SE*13*0001~GE*1*1~IEA*1*000000001~";
    const parsed = parse277ca(ack);
    expect(parsed.claims[0].accepted).toBe(false);
  });
});
