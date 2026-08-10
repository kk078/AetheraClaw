import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decryptField,
  encryptField,
  isEncrypted,
  resolveEncryptionKey,
  sameKey,
} from "../src/compliance/encryption.js";
import { MemoryStore } from "../src/memory/store.js";
import { loadDocument, saveDocument } from "../src/ingest/store.js";
import type { Extraction } from "../src/ingest/extract.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("resolveEncryptionKey", () => {
  it("is OFF when unset — the default every existing install is in", () => {
    expect(resolveEncryptionKey(undefined).key).toBeNull();
    expect(resolveEncryptionKey("").key).toBeNull();
    expect(resolveEncryptionKey("   ").key).toBeNull();
  });

  it("uses 64 hex characters directly", () => {
    const r = resolveEncryptionKey(KEY_A);
    expect(r.key).toHaveLength(32);
    expect(r.note).toMatch(/32-byte key/);
  });

  it("stretches anything else rather than refusing it", () => {
    // Refusing a passphrase would push somebody towards turning encryption off,
    // which is strictly worse than a stretched passphrase.
    const r = resolveEncryptionKey("correct horse battery staple");
    expect(r.key).toHaveLength(32);
    expect(r.note).toMatch(/passphrase/);
    expect(r.note).toMatch(/openssl rand -hex 32/);
  });

  it("derives the same key from the same passphrase", () => {
    const a = resolveEncryptionKey("same phrase").key;
    const b = resolveEncryptionKey("same phrase").key;
    expect(sameKey(a, b)).toBe(true);
    expect(sameKey(a, resolveEncryptionKey("other phrase").key)).toBe(false);
  });
});

describe("encryptField / decryptField", () => {
  const key = resolveEncryptionKey(KEY_A).key!;

  it("round-trips", () => {
    const text = "Claim CLM-4471 allowed 220.00 — operative note follows.\nLine two.";
    const out = decryptField(encryptField(text, key), key);
    expect(out.ok).toBe(true);
    expect(out.text).toBe(text);
  });

  it("never produces the same ciphertext twice for the same input", () => {
    // A fresh IV every time. Reusing one under the same key in GCM leaks the
    // XOR of two plaintexts and breaks authentication — and two identical EOBs
    // producing identical ciphertext would also tell an attacker they match
    // without decrypting either.
    expect(encryptField("same", key)).not.toBe(encryptField("same", key));
  });

  it("leaves plaintext alone, which is what makes turning it on a non-event", () => {
    const legacy = "written before encryption existed";
    expect(isEncrypted(legacy)).toBe(false);
    expect(decryptField(legacy, key)).toEqual({ text: legacy, ok: true, why: "" });
    // And still readable with no key at all.
    expect(decryptField(legacy, null).text).toBe(legacy);
  });

  it("REFUSES a wrong key rather than returning anything", () => {
    const wrong = decryptField(encryptField("secret", key), resolveEncryptionKey(KEY_B).key);
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toBe("");
    expect(wrong.why).toMatch(/not the key it was stored under|altered/);
  });

  it("DETECTS TAMPERING instead of decrypting to something plausible", () => {
    // The reason for GCM rather than a cipher without authentication. An
    // attacker who can write to the database must not be able to alter a
    // stored clinical document into a different one that still reads.
    const ct = encryptField("allowed 220.00", key);
    const parts = ct.split(":");
    const body = Buffer.from(parts[3], "base64");
    body[0] ^= 0xff;
    parts[3] = body.toString("base64");
    const out = decryptField(parts.join(":"), key);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("");
  });

  it("says so plainly when the key is missing entirely", () => {
    const out = decryptField(encryptField("secret", key), null);
    expect(out.ok).toBe(false);
    expect(out.why).toMatch(/ORION_ENCRYPTION_KEY is not set/);
  });

  it("NEVER returns ciphertext dressed as text", () => {
    // Ciphertext in the model's context and in a coder's reading of an EOB
    // looks like a corrupted document rather than a key problem, and sends
    // everyone to the wrong place.
    for (const k of [null, resolveEncryptionKey(KEY_B).key]) {
      const out = decryptField(encryptField("secret", key), k);
      expect(out.text).not.toMatch(/orion\.enc/);
      expect(out.text).toBe("");
    }
  });

  it("does not throw on malformed stored text", () => {
    expect(() => decryptField("orion.enc.v1:nonsense", key)).not.toThrow();
    expect(decryptField("orion.enc.v1:nonsense", key).ok).toBe(false);
  });
});

// ── End to end through the document store ────────────────────────────────────
// The point of the feature is that a stolen copy of the file is unreadable, so
// the assertion that matters reads the RAW COLUMN, not the API.

describe("document storage with encryption on", () => {
  let home: string;
  let previous: string | undefined;

  const extraction = (text: string): Extraction => ({
    filename: "eob.txt",
    kind: "text",
    sizeBytes: text.length,
    sha256: `sha-${text.length}-${text.slice(0, 8)}`,
    text,
    sections: [{ label: "Page 1", text }],
    readable: true,
    confidence: 1,
    phi: [],
    notes: [],
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "orion-enc-"));
    previous = process.env.ORION_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.ORION_ENCRYPTION_KEY;
    else process.env.ORION_ENCRYPTION_KEY = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const open = () => {
    const store = new MemoryStore(path.join(home, "orion.db"));
    const s = store.createSession("t");
    return { store, sessionId: s.id };
  };

  it("writes ciphertext to BOTH text and sections_json", () => {
    process.env.ORION_ENCRYPTION_KEY = KEY_A;
    const { store, sessionId } = open();
    const secret = "Operative note: patient tolerated the procedure well.";
    const doc = saveDocument(store, sessionId, extraction(secret), Date.now());

    const raw = store.db.prepare("SELECT text, sections_json FROM documents WHERE id = ?").get(doc.id) as {
      text: string;
      sections_json: string;
    };
    expect(raw.text).not.toContain("Operative note");
    expect(raw.text.startsWith("orion.enc.v1:")).toBe(true);
    // The half-measure this test exists to prevent: sections carry the same
    // content, so leaving them in the clear would make the whole feature
    // theatre.
    expect(raw.sections_json).not.toContain("Operative note");
    expect(raw.sections_json.startsWith("orion.enc.v1:")).toBe(true);
    store.close();
  });

  it("reads back identically through the API", () => {
    process.env.ORION_ENCRYPTION_KEY = KEY_A;
    const { store, sessionId } = open();
    const secret = "Allowed 220.00, paid 176.00, CO-45 adjustment 44.00.";
    const doc = saveDocument(store, sessionId, extraction(secret), Date.now());
    const back = loadDocument(store, doc.id, { log: false })!;
    expect(back.text).toBe(secret);
    expect(back.sections[0].text).toBe(secret);
    expect(back.readable).toBe(true);
    store.close();
  });

  it("stores plaintext when no key is configured", () => {
    delete process.env.ORION_ENCRYPTION_KEY;
    const { store, sessionId } = open();
    const doc = saveDocument(store, sessionId, extraction("plain content"), Date.now());
    const raw = store.db.prepare("SELECT text FROM documents WHERE id = ?").get(doc.id) as { text: string };
    expect(raw.text).toBe("plain content");
    store.close();
  });

  it("reports an unreadable document instead of an empty one when the key changes", () => {
    process.env.ORION_ENCRYPTION_KEY = KEY_A;
    const { store, sessionId } = open();
    const doc = saveDocument(store, sessionId, extraction("sensitive"), Date.now());
    store.close();

    // The same file, opened by a deployment carrying a different key — the
    // shape of a restore against the wrong secret.
    process.env.ORION_ENCRYPTION_KEY = KEY_B;
    const reopened = new MemoryStore(path.join(home, "orion.db"));
    const back = loadDocument(reopened, doc.id, { log: false })!;
    expect(back.text).toBe("");
    expect(back.readable).toBe(false);
    // A blank document with no explanation would read as a failed upload. The
    // reason has to travel with it.
    expect(back.refusal).toMatch(/could not be decrypted/);
    expect(back.notes[0]).toMatch(/could not be decrypted/);
    reopened.close();
  });

  it("keeps rows written before encryption readable after it is turned on", () => {
    delete process.env.ORION_ENCRYPTION_KEY;
    const { store, sessionId } = open();
    const old = saveDocument(store, sessionId, extraction("written in the clear"), Date.now());
    store.close();

    process.env.ORION_ENCRYPTION_KEY = KEY_A;
    const reopened = new MemoryStore(path.join(home, "orion.db"));
    expect(loadDocument(reopened, old.id, { log: false })!.text).toBe("written in the clear");
    // And a new row in the same database is encrypted.
    const fresh = saveDocument(reopened, sessionId, extraction("written after"), Date.now());
    const raw = reopened.db.prepare("SELECT text FROM documents WHERE id = ?").get(fresh.id) as { text: string };
    expect(raw.text.startsWith("orion.enc.v1:")).toBe(true);
    reopened.close();
  });
});
