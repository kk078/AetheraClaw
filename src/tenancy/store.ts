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
export function recordAccess(store: MemoryStore, event: AccessEvent): RecordResult {
  const prepared = prepareAccessEntry(event);
  if (!prepared.ok) return prepared;

  let chainSeq = 0;
  store.db.transaction(() => {
    const entry = appendAudit(store, {
      kind: prepared.entry.kind,
      actor: prepared.entry.actor,
      summary: prepared.entry.summary,
      payload: event,
    });
    chainSeq = entry.seq;
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
        chainSeq,
        event.at,
      );
  })();

  return { ok: true, chainSeq };
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
      `SELECT a.id, a.chain_seq, c.seq AS found
         FROM phi_access_log a
         LEFT JOIN audit_chain c ON c.seq = a.chain_seq AND c.kind = 'phi_access'`,
    )
    .all() as Array<{ id: string; chain_seq: number | null; found: number | null }>;
  return rows
    .filter((r) => r.chain_seq === null || r.found === null)
    .map((r) => ({
      id: r.id,
      reason:
        r.chain_seq === null
          ? "row carries no chain sequence — it was inserted outside recordAccess()"
          : `row claims chain entry ${r.chain_seq}, which is not a phi_access entry in the chain`,
    }));
}
