import { appendAudit } from "../audit/store.js";
import type { MemoryStore } from "../memory/store.js";
import { newId } from "../shared/ids.js";
import { prepareAccessEntry, type AccessEvent } from "./access-log.js";

// DB-facing half of the access log. The refusal rules and the review maths live
// in access-log.ts as pure functions; this only reads and writes rows.

export type RecordResult = { ok: true; chainSeq: number } | { ok: false; reason: string };

/**
 * Record one PHI access event.
 *
 * Two writes in one transaction: the queryable row and the hash-chain entry that
 * makes it tamper-evident. If they were written separately, a log row could
 * outlive its chain entry — and a row with no chain entry is exactly what a
 * fabricated log row looks like.
 */
/** SQLite contention that a retry can clear rather than a real failure. */
function isBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  const message = err instanceof Error ? err.message : String(err);
  return /^SQLITE_BUSY/.test(code) || /database is locked|database is busy/i.test(message);
}

export function recordAccess(store: MemoryStore, event: AccessEvent): RecordResult {
  const prepared = prepareAccessEntry(event);
  if (!prepared.ok) return prepared;

  const writeOnce = store.db.transaction(() => {
    const entry = appendAudit(store, {
      kind: prepared.entry.kind,
      actor: prepared.entry.actor,
      summary: prepared.entry.summary,
      payload: event,
    });
    store.db
      .prepare(
        `INSERT INTO phi_access_log
           (id, action, resource_type, resource_ref, actor, tenant_slug, source_address, record_count, chain_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("acc"),
        event.action,
        event.resourceType,
        event.resourceRef,
        event.actor,
        event.tenantSlug,
        event.sourceAddress,
        event.recordCount,
        entry.seq,
        event.at,
      );
    return entry.seq;
  });

  // appendAudit reads the chain head then inserts head+1. Under WAL two
  // processes writing at once (a gateway session and a CLI command on the same
  // tenant DB) can hit a write-write snapshot conflict that busy_timeout does
  // NOT wait out — it is returned immediately. Dropping a §164.312(b) access
  // record to a timing collision is not acceptable, so retry: each attempt is a
  // fresh transaction that re-reads the head, and the seq PRIMARY KEY guarantees
  // no two writers can fork the chain even if both proceed.
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; ; attempt++) {
    try {
      const chainSeq = writeOnce();
      return { ok: true, chainSeq };
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS - 1 || !isBusy(err)) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      // Brief backoff before re-reading the head; the conflicting writer has
      // almost always committed within a millisecond.
      const until = Date.now() + Math.min(2 ** attempt, 25);
      while (Date.now() < until) {
        /* spin — the operation is synchronous and the wait is sub-25ms */
      }
    }
  }
}

export function loadAccessEvents(store: MemoryStore, sinceMs: number): AccessEvent[] {
  const rows = store.db
    .prepare("SELECT * FROM phi_access_log WHERE created_at >= ? ORDER BY created_at ASC")
    .all(sinceMs) as Array<{
    action: string;
    resource_type: string;
    resource_ref: string;
    actor: string;
    tenant_slug: string;
    source_address: string;
    record_count: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    action: r.action as AccessEvent["action"],
    resourceType: r.resource_type as AccessEvent["resourceType"],
    resourceRef: r.resource_ref,
    actor: r.actor,
    tenantSlug: r.tenant_slug,
    sourceAddress: r.source_address,
    recordCount: r.record_count,
    at: r.created_at,
  }));
}

/**
 * Find access rows whose chain entry is missing or mismatched.
 *
 * The chain proves nobody edited an entry in place. This proves nobody *added* a
 * log row without one — the way a fabricated access record would appear, and the
 * one thing verifying the chain alone does not check.
 */
export function findUnchainedAccess(store: MemoryStore): Array<{ id: string; reason: string }> {
  const rows = store.db
    .prepare(
      `SELECT a.id, a.action, a.resource_type, a.resource_ref, a.actor, a.tenant_slug,
              a.source_address, a.record_count, a.created_at, a.chain_seq,
              c.seq AS found, c.actor AS chain_actor, c.summary AS chain_summary
         FROM phi_access_log a
         LEFT JOIN audit_chain c ON c.seq = a.chain_seq AND c.kind = 'phi_access'`,
    )
    .all() as Array<{
    id: string;
    action: string;
    resource_type: string;
    resource_ref: string;
    actor: string;
    tenant_slug: string;
    source_address: string;
    record_count: number;
    created_at: number;
    chain_seq: number | null;
    found: number | null;
    chain_actor: string | null;
    chain_summary: string | null;
  }>;

  // One chain entry backs exactly one access. A fabricated row can copy a
  // legitimate row's chain_seq to satisfy the existence check, so a seq claimed
  // by more than one row is itself the tell.
  const seqCounts = new Map<number, number>();
  for (const r of rows) if (r.chain_seq !== null) seqCounts.set(r.chain_seq, (seqCounts.get(r.chain_seq) ?? 0) + 1);

  const out: Array<{ id: string; reason: string }> = [];
  for (const r of rows) {
    if (r.chain_seq === null) {
      out.push({ id: r.id, reason: "row carries no chain sequence — it was inserted outside recordAccess()" });
      continue;
    }
    if (r.found === null) {
      out.push({ id: r.id, reason: `row claims chain entry ${r.chain_seq}, which is not a phi_access entry in the chain` });
      continue;
    }
    if ((seqCounts.get(r.chain_seq) ?? 0) > 1) {
      out.push({
        id: r.id,
        reason: `row shares chain entry ${r.chain_seq} with another row — a chain entry backs exactly one access, so one of these was fabricated`,
      });
      continue;
    }
    // Recompute the deterministic summary this row SHOULD produce and compare it,
    // with the actor, against what the chain froze at write time. An in-place
    // edit of the row (action, resource_ref, actor, tenant, record_count, source)
    // leaves chain_seq intact and so cleared every check above; the summary the
    // chain stored is what catches it. The chain's stored summary and actor are
    // used — not the payload hash, which depends on the event's exact JSON key
    // order a row cannot reconstruct, and not created_at, which the chain stamps
    // with its own write time rather than the event time.
    const prepared = prepareAccessEntry({
      action: r.action as AccessEvent["action"],
      resourceType: r.resource_type as AccessEvent["resourceType"],
      resourceRef: r.resource_ref,
      actor: r.actor,
      tenantSlug: r.tenant_slug,
      sourceAddress: r.source_address,
      recordCount: r.record_count,
      at: r.created_at,
    });
    if (!prepared.ok) {
      out.push({ id: r.id, reason: `row no longer forms a valid access entry — it was edited after logging` });
      continue;
    }
    if (prepared.entry.summary !== r.chain_summary || prepared.entry.actor !== r.chain_actor) {
      out.push({ id: r.id, reason: `row does not match chain entry ${r.chain_seq} — a field was changed in place after logging` });
    }
  }
  return out;
}
