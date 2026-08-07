import { createHash } from "node:crypto";

// ── Hash-chained audit log ───────────────────────────────────────────────────
// Every entry carries the hash of the one before it, so changing a past entry
// invalidates every entry after it.
//
// Be exact about what that buys, because the usual claim is wrong. This is
// TAMPER-EVIDENT, not tamper-proof. The chain lives in the same SQLite file the
// application writes to, and anyone who can edit that file can edit an entry and
// recompute the rest of the chain to match. What the chain alone catches is
// corruption and casual editing — a row changed with a SQL client, a byte
// flipped on disk, a deleted row.
//
// An ANCHOR is what makes the guarantee real. An anchor records the head hash at
// a moment in time somewhere the application cannot reach back into: printed,
// emailed to yourself, committed to a repository, filed with the compliance
// binder. Verification checks the recomputed chain against every stored anchor,
// so a rewrite of history before an anchor point is caught even if the rewrite
// was internally consistent. Without anchors, the log proves nothing against
// anyone with database access — which is precisely the person an audit log
// exists to constrain.

export const GENESIS_HASH = "0".repeat(64);

export interface ChainEntry {
  seq: number;
  /** 'tool_call' | 'approval' | 'review' | 'rule_change' | 'sentinel' | … */
  kind: string;
  actor: string;
  summary: string;
  /** Hash of the full payload, so the log can prove what happened without storing PHI-shaped detail. */
  payloadHash: string;
  prevHash: string;
  hash: string;
  createdAt: number;
}

export interface Anchor {
  seq: number;
  hash: string;
  /** Where the anchor was published — the whole point is that it is outside this database. */
  publishedTo: string;
  createdAt: number;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/**
 * Hash over an unambiguous serialization.
 *
 * JSON.stringify of a fixed-order array, rather than joining fields with a
 * separator: a summary containing the separator would otherwise let two
 * different entries hash identically, and an audit log where an attacker
 * chooses text is exactly where that gets exploited.
 */
export function entryHash(fields: Omit<ChainEntry, "hash">): string {
  const canonical = JSON.stringify([
    fields.seq,
    fields.createdAt,
    fields.kind,
    fields.actor,
    fields.summary,
    fields.payloadHash,
    fields.prevHash,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Build the next entry in a chain. Pure — the caller persists it. */
export function nextEntry(
  head: ChainEntry | undefined,
  input: { kind: string; actor: string; summary: string; payloadHash: string; createdAt: number },
): ChainEntry {
  const fields = {
    seq: (head?.seq ?? 0) + 1,
    kind: input.kind,
    actor: input.actor,
    summary: input.summary,
    payloadHash: input.payloadHash,
    prevHash: head?.hash ?? GENESIS_HASH,
    createdAt: input.createdAt,
  };
  return { ...fields, hash: entryHash(fields) };
}

export type ProblemKind = "hash_mismatch" | "link_broken" | "sequence_gap" | "anchor_mismatch" | "anchor_missing";

export interface ChainProblem {
  kind: ProblemKind;
  seq: number;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  problems: ChainProblem[];
  headHash: string;
  /** Anchors that matched. */
  anchorsVerified: number;
  /**
   * Entries after the newest anchor. Nothing outside an anchor is proven against
   * someone with write access, so the number is reported rather than implied.
   */
  unanchoredEntries: number;
}

/**
 * Verify a chain, and its anchors.
 *
 * Entries must arrive in sequence order. Four distinct failures are separated
 * because they mean different things: a recomputed hash that differs says a
 * field was edited; a broken link says an entry was replaced; a gap says one was
 * deleted; an anchor mismatch says history was rewritten consistently, which the
 * chain by itself cannot see.
 */
export function verifyChain(entries: ChainEntry[], anchors: Anchor[] = []): VerifyResult {
  const problems: ChainProblem[] = [];
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;

  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      problems.push({
        kind: "sequence_gap",
        seq: entry.seq,
        detail: `Expected entry ${expectedSeq} but found ${entry.seq}. ${entry.seq > expectedSeq ? `${entry.seq - expectedSeq} entr(ies) were removed.` : "Entries are out of order."}`,
      });
      expectedSeq = entry.seq;
    }
    if (entry.prevHash !== prevHash) {
      problems.push({
        kind: "link_broken",
        seq: entry.seq,
        detail: `Entry ${entry.seq} records a previous hash of ${entry.prevHash.slice(0, 12)}… but the entry before it hashes to ${prevHash.slice(0, 12)}…. Something between them was replaced.`,
      });
    }
    const recomputed = entryHash(entry);
    if (recomputed !== entry.hash) {
      problems.push({
        kind: "hash_mismatch",
        seq: entry.seq,
        detail: `Entry ${entry.seq} does not hash to its stored value — a field in it was changed after it was written.`,
      });
    }
    // Chain forward on the STORED hash: using the recomputed one would silently
    // repair a tampered entry for every check after it, reporting one problem
    // where there is a rewritten log.
    prevHash = entry.hash;
    expectedSeq = entry.seq + 1;
  }

  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  let anchorsVerified = 0;
  for (const anchor of anchors) {
    const entry = bySeq.get(anchor.seq);
    if (!entry) {
      problems.push({
        kind: "anchor_missing",
        seq: anchor.seq,
        detail: `An anchor published to "${anchor.publishedTo}" records entry ${anchor.seq}, which is no longer in the log. The log has been truncated below a point that was already witnessed.`,
      });
      continue;
    }
    if (entry.hash !== anchor.hash) {
      problems.push({
        kind: "anchor_mismatch",
        seq: anchor.seq,
        detail: `Entry ${anchor.seq} hashes to ${entry.hash.slice(0, 12)}… but the anchor published to "${anchor.publishedTo}" recorded ${anchor.hash.slice(0, 12)}…. History was rewritten after that anchor was taken — the chain itself is self-consistent, which is why the anchor is what catches this.`,
      });
      continue;
    }
    anchorsVerified++;
  }

  const newestAnchor = anchors.reduce((max, a) => Math.max(max, a.seq), 0);
  return {
    ok: problems.length === 0,
    entries: entries.length,
    problems,
    headHash: entries.length > 0 ? entries[entries.length - 1].hash : GENESIS_HASH,
    anchorsVerified,
    unanchoredEntries: entries.filter((e) => e.seq > newestAnchor).length,
  };
}

export function renderVerify(result: VerifyResult, anchorCount: number): string {
  const lines: string[] = [];
  if (result.entries === 0) return "The audit log is empty. Nothing to verify.";

  lines.push(
    result.ok
      ? `Chain intact: ${result.entries} entries verified, head ${result.headHash.slice(0, 16)}….`
      : `CHAIN FAILED VERIFICATION: ${result.problems.length} problem(s) across ${result.entries} entries.`,
  );

  if (!result.ok) {
    lines.push("");
    for (const p of result.problems.slice(0, 40)) lines.push(`  [${p.kind}] ${p.detail}`);
    if (result.problems.length > 40) lines.push(`  … and ${result.problems.length - 40} more.`);
  }

  lines.push("");
  if (anchorCount === 0) {
    lines.push(
      "No anchors recorded. Be clear about what that means: the chain proves nobody edited an entry and left the rest alone, but anyone who can write to this database can rewrite the whole log consistently and it will still verify. Publish the head hash somewhere outside this machine — the compliance binder, a signed email to yourself, a commit — with audit_anchor. That is what makes the log evidence rather than a habit.",
    );
  } else if (result.anchorsVerified < anchorCount) {
    lines.push(
      `${result.anchorsVerified} of ${anchorCount} anchor(s) verified. A failed anchor is the strongest result this tool produces: the log no longer matches what was witnessed outside this database, so it was changed after the fact. Do not treat the current log as the record of what happened.`,
    );
  } else {
    lines.push(
      `${result.anchorsVerified} of ${anchorCount} anchor(s) verified. History up to the newest anchor is witnessed outside this database.`,
      result.unanchoredEntries > 0
        ? `${result.unanchoredEntries} entr(ies) since that anchor are covered by the chain alone. Anchor again to close the window.`
        : "Every entry is at or before an anchor.",
    );
  }

  return lines.join("\n");
}
