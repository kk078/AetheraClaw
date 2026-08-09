import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import type { MemoryStore } from "../memory/store.js";
import { appendAudit, chainHead } from "../audit/store.js";
import {
  attest,
  fingerprint,
  generateKeypair,
  renderAttestation,
  verifyAttestation,
  type Attestation,
  type ClaimStatement,
  type Keypair,
} from "./attestation.js";
import {
  applyMessage,
  openNegotiation,
  reconcile,
  renderNegotiation,
  summarize,
  type A2AMessage,
  type MessageType,
  type Negotiation,
  type Party,
} from "./negotiate.js";

type Ctx = { services: Record<string, unknown> };
const store = (ctx: Ctx) => ctx.services.store as MemoryStore;

interface KeyRow {
  signer_id: string;
  key_id: string;
  public_key_pem: string;
  private_key_pem: string;
  created_at: number;
}

function loadKeys(ctx: Ctx, signerId: string): Keypair | null {
  const row = store(ctx).db.prepare("SELECT * FROM a2a_keys WHERE signer_id = ?").get(signerId) as KeyRow | undefined;
  if (!row || !row.private_key_pem) return null;
  return { keyId: row.key_id, publicKeyPem: row.public_key_pem, privateKeyPem: row.private_key_pem };
}

/** Every key on file, as the roster verification checks identity against. */
function roster(ctx: Ctx): Record<string, string> {
  const rows = store(ctx).db.prepare("SELECT signer_id, public_key_pem FROM a2a_keys").all() as Array<{
    signer_id: string;
    public_key_pem: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.signer_id, r.public_key_pem]));
}

export const a2aKeySetupTool = defineTool({
  name: "a2a_key_setup",
  description:
    "Create this practice's signing key, or record a counterparty's public key. The public key is what gets exchanged out of band — a signature checked against a key that arrived inside the same message proves the message is self-consistent and nothing more.",
  schema: z.object({
    signer_id: z.string().describe("Who this key belongs to — this practice, or a counterparty."),
    public_key_pem: z.string().default("").describe("Supply to record a counterparty. Leave blank to generate our own."),
  }),
  execute: async (input, ctx) => {
    const now = Date.now();
    const existing = store(ctx).db.prepare("SELECT * FROM a2a_keys WHERE signer_id = ?").get(input.signer_id) as
      | KeyRow
      | undefined;

    if (input.public_key_pem) {
      let keyId: string;
      try {
        keyId = fingerprint(input.public_key_pem);
      } catch {
        return { content: "That is not a readable public key PEM.", isError: true };
      }
      if (existing && existing.key_id !== keyId) {
        return {
          content: `"${input.signer_id}" already has key ${existing.key_id.slice(0, 12)}… on file and this is ${keyId.slice(0, 12)}…. Replacing a counterparty key on the strength of a message is how a key substitution succeeds; confirm the new key through the same channel the first one came through, then delete the old row deliberately.`,
          isError: true,
        };
      }
      store(ctx)
        .db.prepare(
          "INSERT OR REPLACE INTO a2a_keys (signer_id, key_id, public_key_pem, private_key_pem, created_at) VALUES (?, ?, ?, '', ?)",
        )
        .run(input.signer_id, keyId, input.public_key_pem, existing?.created_at ?? now);
      return { content: `Recorded public key ${keyId.slice(0, 16)}… for "${input.signer_id}". Nothing signed by them verifies as theirs until this is right.` };
    }

    if (existing?.private_key_pem) {
      return {
        content: `"${input.signer_id}" already has a signing key: ${existing.key_id}.\n\n${existing.public_key_pem}`,
      };
    }

    const keys = generateKeypair();
    store(ctx)
      .db.prepare(
        "INSERT OR REPLACE INTO a2a_keys (signer_id, key_id, public_key_pem, private_key_pem, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.signer_id, keys.keyId, keys.publicKeyPem, keys.privateKeyPem, now);
    appendAudit(store(ctx), {
      kind: "a2a_key",
      actor: "a2a_key_setup",
      summary: `Generated signing key ${keys.keyId} for ${input.signer_id}`,
      payload: { signerId: input.signer_id, keyId: keys.keyId },
    });

    return {
      content: [
        `Generated an Ed25519 signing key for "${input.signer_id}": ${keys.keyId}.`,
        "",
        "Send this public key to counterparties out of band. The private half is stored in this database unencrypted, so it is exactly as protected as the database file — a stolen key forges statements attributed to this practice, which is not a small thing even though it moves no money.",
        "",
        keys.publicKeyPem.trim(),
      ].join("\n"),
    };
  },
});

export const a2aAttestTool = defineTool({
  name: "a2a_attest",
  description:
    "Sign a statement about a claim, anchored to the audit log. The signature commits to the audit-chain head, so the assertion cannot later be claimed to predate facts already written. It proves authorship and timing — it does not make the statement true, and a signed false statement is worse than an unsigned one because it is now attributable.",
  schema: z.object({
    signer_id: z.string(),
    claim_id: z.string(),
    payer: z.string(),
    patient_ref: z.string().describe("De-identified reference only."),
    billed_cents: z.number().int().min(0),
    codes: z.array(z.string()).default([]),
    diagnoses: z.array(z.string()).default([]),
    service_date: z.string().default(""),
    assertion: z.string().describe("What is being asserted. Read it before signing — this goes out under the practice's name."),
  }),
  execute: async (input, ctx) => {
    const keys = loadKeys(ctx, input.signer_id);
    if (!keys) {
      return {
        content: `No signing key for "${input.signer_id}". Run a2a_key_setup first — a public key on file for a counterparty cannot sign.`,
        isError: true,
      };
    }

    const statement: ClaimStatement = {
      claimId: input.claim_id,
      payer: input.payer,
      patientRef: input.patient_ref,
      billedCents: input.billed_cents,
      codes: input.codes,
      diagnoses: input.diagnoses,
      serviceDate: input.service_date,
      assertion: input.assertion,
    };

    const head = chainHead(store(ctx));
    const id = newId("att");
    const attestation = attest(statement, keys, {
      id,
      signerId: input.signer_id,
      signedAt: Date.now(),
      auditSeq: head?.seq ?? 0,
      auditHash: head?.hash ?? "",
    });

    store(ctx)
      .db.prepare(
        "INSERT INTO a2a_attestations (id, signer_id, key_id, claim_id, audit_seq, attestation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.signer_id, keys.keyId, input.claim_id, attestation.auditSeq, JSON.stringify(attestation), attestation.signedAt);

    appendAudit(store(ctx), {
      kind: "a2a_attest",
      actor: input.signer_id,
      summary: `Signed an attestation on claim ${input.claim_id} for ${input.payer}`,
      payload: { id, claimId: input.claim_id },
    });

    const result = verifyAttestation(attestation, roster(ctx), head ? { seq: head.seq, hash: head.hash } : undefined);
    return {
      content: [`Attestation ${id}.`, "", renderAttestation(attestation, result), "", JSON.stringify(attestation, null, 2)].join("\n"),
    };
  },
});

export const a2aVerifyTool = defineTool({
  name: "a2a_verify",
  description:
    "Verify an attestation — a stored one by id, or one received from a counterparty as JSON. Reports three separate things that get conflated: whether the signature is cryptographically valid, whether the key is one already held out of band, and whether the audit anchor matches this log. A valid signature from an unrecognised key is not a verified attestation.",
  schema: z.object({
    attestation_id: z.string().default(""),
    attestation: z.record(z.unknown()).default({}).describe("A received attestation, when it is not one of ours."),
  }),
  execute: async (input, ctx) => {
    let attestation: Attestation;
    let isLocal = false;
    if (input.attestation_id) {
      const row = store(ctx).db.prepare("SELECT attestation_json FROM a2a_attestations WHERE id = ?").get(input.attestation_id) as
        | { attestation_json: string }
        | undefined;
      if (!row) return { content: `No attestation ${input.attestation_id}.`, isError: true };
      attestation = JSON.parse(row.attestation_json) as Attestation;
      isLocal = true;
    } else if (Object.keys(input.attestation).length > 0) {
      attestation = input.attestation as unknown as Attestation;
    } else {
      return { content: "Pass an attestation_id or an attestation.", isError: true };
    }

    // Only anchor-check an attestation of OURS against our own chain. A received
    // counterparty attestation's auditSeq indexes THEIR chain, so comparing it to
    // our seq-N hash is meaningless — and it reported a valid, correctly-signed
    // attestation as tampered ("the records disagree"), which could make an
    // operator reject genuine appeal evidence.
    const entry =
      isLocal && attestation.auditSeq > 0
        ? (store(ctx).db.prepare("SELECT seq, hash FROM audit_chain WHERE seq = ?").get(attestation.auditSeq) as
            | { seq: number; hash: string }
            | undefined)
        : undefined;

    const result = verifyAttestation(attestation, roster(ctx), entry);
    return { content: renderAttestation(attestation, result), isError: !result.signatureValid };
  },
});

function loadNegotiation(ctx: Ctx, id: string): Negotiation | null {
  const row = store(ctx).db.prepare("SELECT negotiation_json FROM a2a_negotiations WHERE id = ?").get(id) as
    | { negotiation_json: string }
    | undefined;
  return row ? (JSON.parse(row.negotiation_json) as Negotiation) : null;
}

function saveNegotiation(ctx: Ctx, negotiation: Negotiation): void {
  store(ctx)
    .db.prepare("UPDATE a2a_negotiations SET state = ?, negotiation_json = ?, updated_at = ? WHERE id = ?")
    .run(negotiation.state, JSON.stringify(negotiation), Date.now(), negotiation.id);
}

export const a2aOpenTool = defineTool({
  name: "a2a_open",
  description:
    "Open an agent-to-agent negotiation on a claim. What comes out the far end is an agreement between two agents, which is not a payment determination — money moves when the payer's adjudication system produces an 835, and that system does not read this protocol.",
  schema: z.object({
    claim_id: z.string(),
    payer: z.string(),
    billed_cents: z.number().int().min(0),
  }),
  execute: async (input, ctx) => {
    const id = newId("neg");
    const negotiation = openNegotiation({ id, claimId: input.claim_id, payer: input.payer, billedCents: input.billed_cents });
    const now = Date.now();
    store(ctx)
      .db.prepare(
        "INSERT INTO a2a_negotiations (id, claim_id, payer, billed_cents, state, negotiation_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.claim_id, input.payer, input.billed_cents, negotiation.state, JSON.stringify(negotiation), now, now);
    return { content: renderNegotiation(negotiation) };
  },
});

export const a2aSendTool = defineTool({
  name: "a2a_send",
  description:
    "Send one message in a negotiation: request_evidence, provide_evidence, propose_adjustment, accept, dispute, withdraw. A party cannot accept its own offer — one side writing down a number and calling it agreed is a note to itself, and is easy to produce by accident when both sides are agents in the same process.",
  schema: z.object({
    negotiation_id: z.string(),
    from: z.enum(["provider", "payer"]),
    type: z.enum(["request_evidence", "provide_evidence", "propose_adjustment", "accept", "dispute", "withdraw"]),
    amount_cents: z.number().int().min(0).optional(),
    evidence: z.array(z.string()).default([]),
    reason: z.string().default(""),
    attestation_id: z.string().default("").describe("Sign the message by attaching an attestation. An unsigned position is repudiable."),
  }),
  execute: async (input, ctx) => {
    const negotiation = loadNegotiation(ctx, input.negotiation_id);
    if (!negotiation) return { content: `No negotiation ${input.negotiation_id}.`, isError: true };

    const message: A2AMessage = {
      id: newId("msg"),
      from: input.from as Party,
      type: input.type as MessageType,
      createdAt: Date.now(),
      ...(input.amount_cents !== undefined ? { amountCents: input.amount_cents } : {}),
      ...(input.evidence.length > 0 ? { evidence: input.evidence } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.attestation_id ? { attestationId: input.attestation_id } : {}),
    };

    const result = applyMessage(negotiation, message);
    if (!result.ok) return { content: `Refused: ${result.rejection}`, isError: true };

    saveNegotiation(ctx, result.negotiation);
    if (result.negotiation.state === "agreed") {
      appendAudit(store(ctx), {
        kind: "a2a_agreement",
        actor: input.from,
        summary: `Negotiation ${negotiation.id} agreed at ${result.negotiation.agreedCents} cents on claim ${negotiation.claimId}`,
        payload: { id: negotiation.id, agreedCents: result.negotiation.agreedCents },
      });
    }
    return { content: renderNegotiation(result.negotiation) };
  },
});

export const a2aShowTool = defineTool({
  name: "a2a_show",
  description: "Show a negotiation and its outcome, or list open ones.",
  schema: z.object({ negotiation_id: z.string().default("") }),
  execute: async (input, ctx) => {
    if (input.negotiation_id) {
      const negotiation = loadNegotiation(ctx, input.negotiation_id);
      if (!negotiation) return { content: `No negotiation ${input.negotiation_id}.`, isError: true };
      return { content: renderNegotiation(negotiation) };
    }
    const rows = store(ctx)
      .db.prepare("SELECT id, claim_id, payer, billed_cents, state FROM a2a_negotiations ORDER BY updated_at DESC")
      .all() as Array<{ id: string; claim_id: string; payer: string; billed_cents: number; state: string }>;
    if (rows.length === 0) return { content: "No negotiations." };
    return {
      content: rows
        .map((r) => `${r.id} — claim ${r.claim_id}, ${r.payer}, billed $${(r.billed_cents / 100).toFixed(2)} [${r.state}]`)
        .join("\n"),
    };
  },
});

export const a2aReconcileTool = defineTool({
  name: "a2a_reconcile",
  description:
    "Compare an agreement against what actually paid. This is the step that makes the protocol worth running: an agreement the payer then underpays is the strongest appeal evidence a practice can hold — its own counterparty on the record at a number — and it is only evidence if somebody checks.",
  schema: z.object({
    negotiation_id: z.string(),
    paid_cents: z.number().int().min(0),
  }),
  execute: async (input, ctx) => {
    const negotiation = loadNegotiation(ctx, input.negotiation_id);
    if (!negotiation) return { content: `No negotiation ${input.negotiation_id}.`, isError: true };
    const result = reconcile(negotiation, input.paid_cents);
    const outcome = summarize(negotiation);
    return {
      content: [result.finding, "", ...outcome.notes.map((n) => `  ${n}`)].join("\n"),
      isError: !result.matched && negotiation.state === "agreed",
    };
  },
});
