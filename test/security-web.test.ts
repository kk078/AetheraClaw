import { describe, expect, it } from "vitest";
import { classify, renderClassification } from "../src/channels/email/classify.js";
import { checkStatement } from "../src/support/remediate.js";
import { prefill } from "../src/fhir/dtr.js";

describe("email quarantine — subject PHI is redacted, not leaked", () => {
  it("redacts an SSN in the subject of a quarantined message", () => {
    const msg = { id: "1", from: "payer@x.com", subject: "Records request re SSN 123-45-6789", text: "Submit records within 45 days.", receivedAt: 0 };
    const c = classify(msg);
    expect(c.phi.length).toBeGreaterThan(0);
    const rendered = renderClassification(msg, c);
    expect(rendered).not.toContain("123-45-6789");
    expect(rendered).toContain("[REDACTED-SSN]");
  });
  it("leaves an ordinary subject alone", () => {
    const msg = { id: "2", from: "payer@x.com", subject: "Remittance advice batch 4471", text: "See attached.", receivedAt: 0 };
    const c = classify(msg);
    expect(renderClassification(msg, c)).toContain("Remittance advice batch 4471");
  });
});

describe("remediate guard — WHERE cannot be smuggled in a comment", () => {
  it("refuses an unbounded DELETE with 'where' inside a comment", () => {
    expect(checkStatement("DELETE FROM inbound_mail /* where */").ok).toBe(false);
    expect(checkStatement("DELETE FROM claims -- where\n").ok).toBe(false);
    expect(checkStatement("UPDATE claims SET status='x' /* where */").ok).toBe(false);
  });
  it("still allows a real WHERE, including one followed by a comment", () => {
    expect(checkStatement("DELETE FROM inbound_mail WHERE id=1").ok).toBe(true);
    expect(checkStatement("DELETE FROM claims WHERE id=1 -- note").ok).toBe(true);
  });
});

describe("DTR boolean coercion — truthy strings are not turned into false", () => {
  const q = { id: "PA-1", title: "x", payer: "Acme", items: [{ linkId: "q1", text: "Is the patient on anticoagulation?", type: "boolean" as const, required: true, source: "meds.anticoag" }] };
  it("maps yes/Y/1/true to true", () => {
    for (const v of ["yes", "Y", "1", "true"]) {
      expect(prefill(q, { meds: { anticoag: v } }).answers[0].value).toBe(true);
    }
  });
  it("maps no/0/false to false", () => {
    for (const v of ["no", "0", "false"]) {
      expect(prefill(q, { meds: { anticoag: v } }).answers[0].value).toBe(false);
    }
  });
  it("leaves an unrecognized value unanswered rather than guessing false", () => {
    const a = prefill(q, { meds: { anticoag: "maybe" } }).answers[0];
    expect(a.value).toBeNull();
    expect(a.origin).toBe("unanswered");
  });
});
