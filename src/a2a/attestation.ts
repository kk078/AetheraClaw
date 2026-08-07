import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { createHash } from "node:crypto";

// ── Signed claim attestations ────────────────────────────────────────────────
// An attestation is a signed statement: "this practice asserts these facts about
// this claim, at this time, and here is the audit-log position it was made from."
//
// Be exact about what a signature buys, because the marketing claim is always
// larger than the cryptography. A valid signature proves ONE thing: whoever holds
// the private key produced this exact byte sequence. It does not prove the
// statement is true, it does not prove the signer is who the attestation says
// they are, and it does not make the statement binding on anyone.
//
//   - Truth. Signing a claim that says the service was rendered does not make the
//     service rendered. A signed false statement is a signed false statement, and
//     it is worse than an unsigned one because it is now attributable.
//   - Identity. The public key inside an attestation is chosen by the signer. A
//     verifier that reads the embedded key and reports "valid" has verified that
//     the message is self-consistent, which is worth nothing. Identity comes from
//     knowing the key beforehand, out of band, which is why verify() takes a
//     roster and reports an unknown key as its own distinct outcome.
//
// What it does buy is non-repudiation of authorship over time, and that is real:
// in a dispute six months later, an attestation anchored to an audit-chain entry
// shows the assertion existed then, said that, and was made by the holder of a
// key the counterparty already had.

export interface Keypair {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Generate an Ed25519 keypair. The key id is a fingerprint of the public key. */
export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    keyId: fingerprint(publicKeyPem),
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Short, stable identifier for a public key — the thing exchanged out of band. */
export function fingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 32);
}

/**
 * What is being asserted.
 *
 * Deliberately narrow. Everything here is either a claim identifier, an amount,
 * or a de-identified reference — the same posture as the rest of the project,
 * and doubly so for a structure designed to be transmitted to a counterparty.
 */
export interface ClaimStatement {
  claimId: string;
  payer: string;
  /** De-identified reference only. Never a name, never an MBI. */
  patientRef: string;
  billedCents: number;
  /** CPT/HCPCS codes on the claim. */
  codes: string[];
  /** ICD-10 codes supporting them. */
  diagnoses: string[];
  /** YYYY-MM-DD. */
  serviceDate: string;
  /** Free text the signer is putting their name to. */
  assertion: string;
}

export interface Attestation {
  id: string;
  statement: ClaimStatement;
  signerId: string;
  keyId: string;
  publicKeyPem: string;
  signedAt: number;
  /** Audit-chain sequence and hash at the moment of signing. Zero when unanchored. */
  auditSeq: number;
  auditHash: string;
  /** Base64 Ed25519 signature over the canonical bytes. */
  signature: string;
}

/**
 * Canonical serialization.
 *
 * Sorted keys, recursively. A signature is over bytes, so two encodings of the
 * same object must produce the same bytes or verification fails for reasons that
 * have nothing to do with tampering — and, worse, a verifier that re-encodes
 * loosely can be made to check a different message than the one it displays.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** The exact bytes that get signed. Everything except the signature itself. */
export function signingPayload(attestation: Omit<Attestation, "signature">): string {
  return canonicalize({
    id: attestation.id,
    statement: attestation.statement,
    signerId: attestation.signerId,
    keyId: attestation.keyId,
    publicKeyPem: attestation.publicKeyPem,
    signedAt: attestation.signedAt,
    auditSeq: attestation.auditSeq,
    auditHash: attestation.auditHash,
  });
}

/**
 * Sign a statement.
 *
 * The audit-chain head is signed as part of the payload rather than recorded
 * beside it. That is the whole anchoring mechanism: the signature commits to a
 * position in the log, so an attestation cannot later be claimed to have been
 * made before facts that were already written.
 */
export function attest(
  statement: ClaimStatement,
  keys: Keypair,
  input: { id: string; signerId: string; signedAt: number; auditSeq?: number; auditHash?: string },
): Attestation {
  const unsigned: Omit<Attestation, "signature"> = {
    id: input.id,
    statement,
    signerId: input.signerId,
    keyId: keys.keyId,
    publicKeyPem: keys.publicKeyPem,
    signedAt: input.signedAt,
    auditSeq: input.auditSeq ?? 0,
    auditHash: input.auditHash ?? "",
  };
  const signature = sign(null, Buffer.from(signingPayload(unsigned), "utf8"), createPrivateKey(keys.privateKeyPem));
  return { ...unsigned, signature: signature.toString("base64") };
}

export type TrustLevel = "known_key" | "unknown_key" | "key_mismatch";

export interface VerifyAttestationResult {
  /** The cryptography: did the holder of the embedded key produce these bytes. */
  signatureValid: boolean;
  /** The identity: is the embedded key one we already had. */
  trust: TrustLevel;
  /** The anchor: does the signed audit position match our copy of the chain. */
  anchorChecked: boolean;
  anchorValid: boolean;
  problems: string[];
  notes: string[];
}

/**
 * Verify an attestation against a roster of keys held out of band.
 *
 * `knownKeys` maps signer id to the public key PEM the verifier already had.
 * Passing an empty roster is allowed and produces `unknown_key` — a real and
 * useful answer, and emphatically not the same as valid.
 */
export function verifyAttestation(
  attestation: Attestation,
  knownKeys: Record<string, string> = {},
  chainEntry?: { seq: number; hash: string },
): VerifyAttestationResult {
  const problems: string[] = [];
  const notes: string[] = [];

  let signatureValid = false;
  try {
    const { signature, ...unsigned } = attestation;
    signatureValid = verify(
      null,
      Buffer.from(signingPayload(unsigned), "utf8"),
      createPublicKey(attestation.publicKeyPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    problems.push(
      "The signature does not verify against the key inside the attestation. Either a field was altered after signing or the signature was not produced by that key. Nothing else below matters until this is resolved.",
    );
  }

  const expected = knownKeys[attestation.signerId];
  let trust: TrustLevel;
  if (!expected) {
    trust = "unknown_key";
    problems.push(
      `No key on file for signer "${attestation.signerId}". The key in the attestation was chosen by whoever sent it, so a valid signature against it proves the message is internally consistent and nothing more. Identity comes from a key exchanged out of band beforehand.`,
    );
  } else if (fingerprint(expected) !== attestation.keyId || fingerprint(attestation.publicKeyPem) !== attestation.keyId) {
    trust = "key_mismatch";
    problems.push(
      `The attestation is signed with key ${attestation.keyId.slice(0, 12)}… but the key on file for "${attestation.signerId}" is ${fingerprint(expected).slice(0, 12)}…. Treat this as an unrecognised sender, not a key rotation, until the new key arrives through the same channel the first one did.`,
    );
  } else {
    trust = "known_key";
  }

  let anchorChecked = false;
  let anchorValid = false;
  if (attestation.auditSeq > 0) {
    anchorChecked = chainEntry !== undefined;
    if (!chainEntry) {
      notes.push(
        `The attestation commits to audit entry ${attestation.auditSeq}, which was not supplied for checking. The anchor is unverified.`,
      );
    } else if (chainEntry.seq !== attestation.auditSeq || chainEntry.hash !== attestation.auditHash) {
      problems.push(
        `The attestation commits to audit entry ${attestation.auditSeq} hashing to ${attestation.auditHash.slice(0, 12)}…, but this log's entry ${chainEntry.seq} hashes to ${chainEntry.hash.slice(0, 12)}…. The two records disagree about what had happened when this was signed.`,
      );
    } else {
      anchorValid = true;
    }
  } else {
    notes.push(
      "Unanchored: the attestation does not commit to an audit-log position, so it proves what was said but not when, relative to anything else in the log.",
    );
  }

  notes.push(
    "A signature proves authorship, not correctness. Everything asserted here is still the signer's assertion — verifying it means checking the underlying claim, not the cryptography.",
  );

  return { signatureValid, trust, anchorChecked, anchorValid, problems, notes };
}

export function renderAttestation(attestation: Attestation, result: VerifyAttestationResult): string {
  const s = attestation.statement;
  const lines = [
    result.signatureValid && result.trust === "known_key"
      ? `Signature VALID, signer recognised: ${attestation.signerId} (key ${attestation.keyId.slice(0, 12)}…).`
      : result.signatureValid
        ? `Signature valid, signer NOT recognised: ${attestation.signerId} (key ${attestation.keyId.slice(0, 12)}…).`
        : "Signature INVALID.",
    "",
    `Claim ${s.claimId} — ${s.payer}, patient ${s.patientRef}, service ${s.serviceDate}.`,
    `Billed $${(s.billedCents / 100).toFixed(2)} for ${s.codes.join(", ") || "no codes"} against ${s.diagnoses.join(", ") || "no diagnoses"}.`,
    `Asserted: ${s.assertion}`,
    `Signed ${new Date(attestation.signedAt).toISOString().replace("T", " ").slice(0, 16)} UTC` +
      (attestation.auditSeq > 0
        ? `, anchored to audit entry ${attestation.auditSeq}${result.anchorChecked ? (result.anchorValid ? " (verified)" : " (MISMATCH)") : " (unchecked)"}.`
        : ", unanchored."),
  ];
  if (result.problems.length > 0) lines.push("", ...result.problems.map((p) => `⚠ ${p}`));
  lines.push("", ...result.notes.map((n) => `  ${n}`));
  return lines.join("\n");
}
