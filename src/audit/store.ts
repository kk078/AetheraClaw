import type { MemoryStore } from "../memory/store.js";
import { hashPayload, nextEntry, type Anchor, type ChainEntry } from "./chain.js";

// DB-facing half of the audit chain. The hashing and verification live in
// chain.ts as pure functions; this only reads and writes rows.

interface Row {
  seq: number;
  kind: string;
  actor: string;
  summary: string;
  payload_hash: string;
  prev_hash: string;
  hash: string;
  created_at: number;
}

function toEntry(row: Row): ChainEntry {
  return {
    seq: row.seq,
    kind: row.kind,
    actor: row.actor,
    summary: row.summary,
    payloadHash: row.payload_hash,
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: row.created_at,
  };
}

export function loadChain(store: MemoryStore): ChainEntry[] {
  return (store.db.prepare("SELECT * FROM audit_chain ORDER BY seq ASC").all() as Row[]).map(toEntry);
}

export function loadAnchors(store: MemoryStore): Anchor[] {
  return (
    store.db.prepare("SELECT * FROM audit_anchors ORDER BY seq ASC").all() as Array<{
      seq: number;
      hash: string;
      published_to: string;
      created_at: number;
    }>
  ).map((r) => ({ seq: r.seq, hash: r.hash, publishedTo: r.published_to, createdAt: r.created_at }));
}

export function chainHead(store: MemoryStore): ChainEntry | undefined {
  const row = store.db.prepare("SELECT * FROM audit_chain ORDER BY seq DESC LIMIT 1").get() as Row | undefined;
  return row ? toEntry(row) : undefined;
}

/**
 * Append one entry.
 *
 * The payload is hashed rather than stored. The log has to prove what happened
 * without becoming a second copy of the data — and in a deployment that is not
 * approved for PHI, an audit log that quietly accumulated claim contents would
 * be the largest store of it in the system.
 */
export function appendAudit(
  store: MemoryStore,
  input: { kind: string; actor: string; summary: string; payload?: unknown },
): ChainEntry {
  const entry = nextEntry(chainHead(store), {
    kind: input.kind,
    actor: input.actor,
    summary: input.summary.slice(0, 500),
    payloadHash: hashPayload(input.payload),
    createdAt: Date.now(),
  });
  store.db
    .prepare(
      `INSERT INTO audit_chain (seq, kind, actor, summary, payload_hash, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(entry.seq, entry.kind, entry.actor, entry.summary, entry.payloadHash, entry.prevHash, entry.hash, entry.createdAt);
  return entry;
}
