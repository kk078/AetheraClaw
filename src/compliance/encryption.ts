import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// ── Encrypting document content at rest ──────────────────────────────────────
//
// WHAT THIS DOES AND DOES NOT PROTECT, because an encryption feature that is
// misunderstood is worse than none: somebody stops encrypting the disk because
// "the app encrypts it".
//
//   Protects   the extracted TEXT of uploaded documents — the column that holds
//              a whole EOB, a whole operative note, a whole remittance — from
//              anyone who obtains a copy of the SQLite file or an R2 snapshot
//              without also obtaining ORION_ENCRYPTION_KEY.
//
//   Does NOT   protect anything else in the database. Claim numbers, amounts,
//              payer names, worklist items, session transcripts and the audit
//              chain are all in the clear. The file itself is a plain SQLite
//              database. If the volume underneath is not encrypted, everything
//              except document text is readable by anything that can read the
//              disk.
//
//   Does NOT   protect a running process. The key is in memory and the gateway
//              decrypts on every read, by design — it has to, or the product
//              cannot show a document to the person who uploaded it.
//
// So this is defence against a STOLEN COPY, not against a compromised host. It
// is worth having because a snapshot in object storage is exactly the kind of
// copy that travels, and it is the reason the R2 bucket and the database file
// are different risks.
//
// AES-256-GCM, because the alternative — a cipher without authentication —
// lets an attacker who can write to the database flip bits in a stored EOB and
// have the result decrypt to something plausible. GCM's tag makes tampering a
// decryption failure instead of a silent alteration, and a silently altered
// clinical document is the worst outcome available here.

/** Marks a value this module produced. Anything without it is plaintext. */
const PREFIX = "orion.enc.v1:";

/**
 * Fixed salt for passphrase derivation.
 *
 * A per-value random salt would be better cryptography and would make the key
 * underivable without storing the salt somewhere — which for a value that must
 * be reproducible across restarts means storing it next to the ciphertext, in
 * the same database, which is where an attacker with the file already is. The
 * honest framing: a passphrase is a convenience, and the documented
 * recommendation is a 32-byte random key in hex, which skips derivation
 * entirely.
 */
const DERIVE_SALT = "orion.document.encryption.v1";

export interface KeyResolution {
  key: Buffer | null;
  /** How the key was obtained, or why there is none. Shown at startup. */
  note: string;
}

/**
 * Turn the configured secret into a 32-byte key.
 *
 * Two accepted forms, and the difference is stated rather than hidden:
 *   64 hex characters  used directly. The recommended form —
 *                      `openssl rand -hex 32`.
 *   anything else      treated as a passphrase and stretched with scrypt.
 *                      Works, and is only as strong as the passphrase.
 *
 * An empty or absent value means encryption is OFF. That is not an error: it
 * is the default, and every existing install is in it.
 */
export function resolveEncryptionKey(raw: string | undefined): KeyResolution {
  const value = (raw ?? "").trim();
  if (value === "") return { key: null, note: "Document encryption is off (ORION_ENCRYPTION_KEY is not set)." };

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return { key: Buffer.from(value, "hex"), note: "Document encryption is on, using a 32-byte key." };
  }

  // Deliberately not refused. Refusing a passphrase would push somebody towards
  // turning encryption off entirely, which is strictly worse than a stretched
  // passphrase.
  const key = scryptSync(value, DERIVE_SALT, 32);
  return {
    key,
    note:
      "Document encryption is on, using a key stretched from a passphrase. A 32-byte random key is " +
      "stronger — generate one with `openssl rand -hex 32` and set it as ORION_ENCRYPTION_KEY.",
  };
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt one field.
 *
 * A fresh random IV every time. Reusing an IV under the same key in GCM is
 * catastrophic — it leaks the XOR of two plaintexts and breaks the
 * authentication — and it is the single easiest way to get this wrong, which is
 * why the IV is generated here and never passed in.
 */
export function encryptField(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export interface DecryptResult {
  /** The plaintext, or "" when it could not be recovered. NEVER the ciphertext. */
  text: string;
  ok: boolean;
  /** Empty when ok. Otherwise a sentence an operator can act on. */
  why: string;
}

/**
 * Decrypt one field, or explain why not.
 *
 * NEVER THROWS, and never returns ciphertext dressed as text. Both matter:
 *
 *   A throw here would take out a whole document listing because one row was
 *   written under a key that has since changed — one bad row hiding every good
 *   one.
 *
 *   Returning the ciphertext would put base64 into the model's context, into
 *   the UI, and into a coder's reading of an EOB, where it would look like a
 *   corrupted document rather than a key problem. The empty string plus a
 *   reason is the answer that sends somebody to the right place.
 *
 * A value with no marker is plaintext and is returned unchanged. That is what
 * makes turning encryption on a non-event: rows written before it stay
 * readable, and new rows are encrypted.
 */
export function decryptField(stored: string, key: Buffer | null): DecryptResult {
  if (!isEncrypted(stored)) return { text: stored, ok: true, why: "" };

  if (!key) {
    return {
      text: "",
      ok: false,
      why:
        "This document was stored encrypted and ORION_ENCRYPTION_KEY is not set, so its text cannot be " +
        "read. Set the key this deployment was using and restart.",
    };
  }

  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    return { text: "", ok: false, why: "This document's stored text is malformed and cannot be decrypted." };
  }

  try {
    const [ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
    return { text: out.toString("utf8"), ok: true, why: "" };
  } catch {
    // GCM says only "it did not authenticate". That is one message for two
    // causes — wrong key, or altered bytes — and saying which would be a guess,
    // so it names both.
    return {
      text: "",
      ok: false,
      why:
        "This document's text could not be decrypted. Either ORION_ENCRYPTION_KEY is not the key it was " +
        "stored under, or the stored bytes have been altered.",
    };
  }
}

/**
 * Do two keys match?
 *
 * Constant time, because a deployment that reports "wrong key" faster for a
 * closer guess has handed an attacker a way to search the space.
 */
export function sameKey(a: Buffer | null, b: Buffer | null): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
