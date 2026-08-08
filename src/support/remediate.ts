import { createHash } from "node:crypto";

// ── Data remediation, previewed ──────────────────────────────────────────────
// Support engineers do need to fix a stuck claim state or a mistyped NPI, and
// the alternative to a tool is a raw SQL client against production with no
// preview, no diff and no audit entry. So this exists — but it is the most
// dangerous surface in the project, and the design is mostly refusals.
//
// Three properties, in order of importance:
//
//   PREVIEW ALWAYS ROLLS BACK. Not "rolls back on error" — always. The preview
//   path has no branch that commits, so no argument to it and no bug in it can
//   leave a write behind. The diff is produced from inside the rolled-back
//   savepoint.
//
//   APPLY REQUIRES A PREVIEW. The token is a hash of the exact normalized
//   statement, so applying something nobody previewed is not possible by
//   forgetting — it requires having previewed that statement, character for
//   character. Editing the WHERE clause after previewing invalidates the token.
//
//   UNBOUNDED STATEMENTS ARE REFUSED OUTRIGHT. `UPDATE claims SET status='x'`
//   with no WHERE is the single most common way production data is destroyed,
//   and it is trivially detectable. There is no override flag; a caller who
//   genuinely means every row can write `WHERE 1=1` and own that.
//
// Model output is untrusted input, and this executes SQL. Every check below
// assumes the statement was written by something that does not understand the
// consequences.

export type StatementKind = "update" | "delete" | "insert";

export interface StatementCheck {
  ok: boolean;
  kind?: StatementKind;
  table?: string;
  reason?: string;
}

/** Statements that are never remediation, whatever they claim to be. */
const FORBIDDEN = [
  { pattern: /^\s*(drop|alter|create|truncate|vacuum|reindex)\b/i, why: "schema and maintenance statements are not data remediation" },
  { pattern: /^\s*(attach|detach)\b/i, why: "attaching a database would put data outside the tenant boundary in reach" },
  { pattern: /^\s*pragma\b/i, why: "a PRAGMA can disable foreign keys or change durability for the whole connection" },
  { pattern: /^\s*(begin|commit|rollback|savepoint|release)\b/i, why: "transaction control is owned by the preview harness; a statement that ends the savepoint would escape the rollback" },
  { pattern: /^\s*select\b/i, why: "a SELECT changes nothing — read it with the reporting tools instead" },
];

/**
 * Normalize for hashing.
 *
 * Whitespace-insensitive so re-indenting does not invalidate a token, but
 * case- and content-sensitive everywhere else: changing `WHERE id = 'A'` to
 * `WHERE id = 'B'` must produce a different token, because it is a different
 * statement against different rows.
 */
export function normalizeStatement(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").replace(/;\s*$/, "");
}

export function previewToken(sql: string): string {
  return createHash("sha256").update(normalizeStatement(sql)).digest("hex").slice(0, 16);
}

/**
 * Decide whether a statement may be run at all.
 *
 * Deliberately conservative and deliberately not a SQL parser. A real parser
 * would accept more, and every construct it accepted would be one more thing
 * whose consequences this file would have to reason about. The narrow shape —
 * one UPDATE, DELETE or INSERT, single statement, WHERE required on the first
 * two — covers the remediation an ops team actually performs.
 */
export function checkStatement(sql: string): StatementCheck {
  const normalized = normalizeStatement(sql);
  if (!normalized) return { ok: false, reason: "Empty statement." };

  for (const f of FORBIDDEN) {
    if (f.pattern.test(normalized)) return { ok: false, reason: `Refused: ${f.why}.` };
  }

  // Multiple statements: the second one is the one nobody reviewed.
  const withoutStrings = normalized.replace(/'(?:[^']|'')*'/g, "''");
  if (withoutStrings.includes(";")) {
    return {
      ok: false,
      reason: "Refused: more than one statement. Only the first would be previewed, and the second is the one nobody reviewed. Submit them separately.",
    };
  }

  const update = /^update\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(normalized);
  const del = /^delete\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(normalized);
  const insert = /^insert\s+(?:or\s+\w+\s+)?into\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(normalized);

  if (update || del) {
    const kind: StatementKind = update ? "update" : "delete";
    const table = (update ?? del)![1];
    if (!/\bwhere\b/i.test(withoutStrings)) {
      return {
        ok: false,
        reason: `Refused: ${kind.toUpperCase()} with no WHERE clause touches every row in ${table}. This is the single most common way production data is destroyed. There is no override — if you genuinely mean every row, write WHERE 1=1 and own it.`,
      };
    }
    return { ok: true, kind, table };
  }

  if (insert) return { ok: true, kind: "insert", table: insert[1] };

  return {
    ok: false,
    reason: "Refused: only a single UPDATE, DELETE or INSERT is accepted. Anything else is either a read, a schema change, or something whose consequences this preview cannot show you.",
  };
}

export interface RowDiff {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed: string[];
}

export interface PreviewResult {
  ok: boolean;
  reason?: string;
  kind?: StatementKind;
  table?: string;
  rowsAffected: number;
  diffs: RowDiff[];
  /** Rows beyond the sample cap, counted but not shown. */
  notShown: number;
  /** Set when the table was too large to snapshot; the count is still exact. */
  diffSkippedRows?: number;
  token: string;
}

/** Show at most this many rows; the count is always exact. */
export const DIFF_SAMPLE = 20;

/**
 * Above this many rows in the target table, the row-level diff is skipped.
 *
 * Producing a diff means snapshotting the table before and after, so the whole
 * table is materialized twice in memory. Measured at ~130 ms and a few tens of
 * MB for 20,000 rows, which is fine — and linear, which is not: a practice with
 * half a million claims would spike hundreds of megabytes, and this tool is
 * meant to be reached for DURING an incident, which is the worst possible moment
 * to add memory pressure to a struggling process.
 *
 * The affected-row COUNT is exact either way, and the count is the number that
 * catches the WHERE clause which was meant to match one row.
 */
export const MAX_SNAPSHOT_ROWS = 50_000;

export function diffRows(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
  keyColumn: string,
): RowDiff[] {
  const byKeyAfter = new Map(after.map((r) => [String(r[keyColumn]), r]));
  const byKeyBefore = new Map(before.map((r) => [String(r[keyColumn]), r]));
  const keys = new Set([...byKeyBefore.keys(), ...byKeyAfter.keys()]);

  const out: RowDiff[] = [];
  for (const k of keys) {
    const b = byKeyBefore.get(k) ?? null;
    const a = byKeyAfter.get(k) ?? null;
    const changed: string[] = [];
    if (b && a) {
      for (const col of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (JSON.stringify(b[col]) !== JSON.stringify(a[col])) changed.push(col);
      }
      if (changed.length === 0) continue; // untouched by the statement
    }
    out.push({ before: b, after: a, changed });
  }
  return out;
}

function truncate(value: unknown): string {
  const s = value === null || value === undefined ? "NULL" : String(value);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

export function renderPreview(result: PreviewResult, sql: string): string {
  if (!result.ok) return `Not previewed. ${result.reason}`;

  const lines = [
    `DRY RUN — ${result.kind?.toUpperCase()} on ${result.table}, ${result.rowsAffected} row(s) affected.`,
    "Nothing was written: the statement ran inside a savepoint that was rolled back unconditionally.",
    "",
  ];

  if (result.diffSkippedRows !== undefined) {
    lines.push(
      `The row-level diff was skipped: ${result.table} holds ${result.diffSkippedRows.toLocaleString("en-US")} rows, above the ${MAX_SNAPSHOT_ROWS.toLocaleString("en-US")}-row snapshot bound.`,
      "Producing a diff materializes the table twice, and this tool is reached for during an incident — the worst moment to add memory pressure to a struggling process.",
      "The affected-row count above IS exact, and it is the number that catches a WHERE clause meant to match one row. To see the rows themselves, narrow the statement to a smaller table or run it against a restored copy.",
      "",
      `To apply exactly this, pass token: ${result.token}`,
    );
    return lines.join("\n");
  }

  if (result.rowsAffected === 0) {
    lines.push(
      "The statement matched nothing. Usually the WHERE clause is wrong, or the rows are in another tenant's database — which is unreachable from this connection by design, not missing.",
    );
    return lines.join("\n");
  }

  for (const d of result.diffs) {
    if (!d.before) {
      lines.push(`  + INSERT ${Object.entries(d.after ?? {}).map(([k, v]) => `${k}=${truncate(v)}`).join(" ")}`);
      continue;
    }
    if (!d.after) {
      lines.push(`  - DELETE ${Object.entries(d.before).map(([k, v]) => `${k}=${truncate(v)}`).join(" ")}`);
      continue;
    }
    lines.push(`  ~ ${d.changed.length} column(s):`);
    for (const col of d.changed) {
      lines.push(`      ${col}: ${truncate(d.before[col])}  →  ${truncate(d.after?.[col])}`);
    }
  }

  if (result.notShown > 0) {
    lines.push(`  … and ${result.notShown} more row(s) affected but not shown. The COUNT above is exact.`);
  }

  lines.push(
    "",
    `To apply exactly this, pass token: ${result.token}`,
    "The token is a hash of this statement. Editing it — including the WHERE clause — invalidates the token, so applying something nobody previewed is not something you can do by forgetting.",
  );

  if (result.rowsAffected > DIFF_SAMPLE) {
    lines.push(
      "",
      `${result.rowsAffected} rows is a bulk change. Read the count before the diff: a WHERE clause that was meant to match one row and matched ${result.rowsAffected} is the failure this preview exists to catch.`,
    );
  }
  return lines.join("\n");
}

export type ApplyCheck = { ok: true } | { ok: false; reason: string };

export function checkApply(sql: string, token: string): ApplyCheck {
  const check = checkStatement(sql);
  if (!check.ok) return { ok: false, reason: check.reason ?? "Refused." };
  const expected = previewToken(sql);
  if (token !== expected) {
    return {
      ok: false,
      reason: `Token does not match this statement. Expected the token from a preview of exactly this SQL; got "${token}". Run support_remediate_preview first — and if you previewed something slightly different, the difference is the point.`,
    };
  }
  return { ok: true };
}
