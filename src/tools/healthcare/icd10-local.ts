// ── Local ICD-10-CM ──────────────────────────────────────────────────────────
// The most-used lookup in the product was the only core code set that could not
// answer without a network round-trip: every icd10_search and icd10_validate
// call went to the NLM Clinical Tables API.
//
// It did not have to. ICD-10-CM is CMS/WHO and is NOT AMA-licensed — that is
// precisely the difference that makes CPT impossible and this straightforward.
// CMS publishes the complete code set as a free ZIP, and its order file states
// billable status outright rather than leaving it to be inferred.

export interface Icd10Table {
  /** Fiscal year of the edition, e.g. 2026. Reported with every answer. */
  fy: number;
  /** Codes valid at full specificity — the ones that may go on a claim. */
  billable: Record<string, string>;
  /** Category headers. Real codes, but not billable. */
  headers: Record<string, string>;
}

/**
 * Insert the decimal point CMS's order file omits: E1165 → E11.65.
 *
 * The dot always falls after the third character, and a code of three
 * characters or fewer has none.
 */
export function dotCode(undotted: string): string {
  const c = undotted.trim().toUpperCase();
  return c.length > 3 ? `${c.slice(0, 3)}.${c.slice(3)}` : c;
}

/** Accept either spelling from a user or a model: E1165 and E11.65 are one code. */
export function normalizeCode(input: string): string {
  return dotCode(input.replace(/\./g, ""));
}

export interface Icd10Entry {
  code: string;
  description: string;
  billable: boolean;
  /** The code without its decimal point, precomputed — see entriesOf. */
  bare: string;
}

// Memoised per table object. Rebuilding 98,000 entry objects on every lookup
// cost 70–125 ms a call — the same waste that made NCCI scanning 110 ms per
// scrub before it was indexed. The WeakMap is keyed on the parsed table, so
// reinstalling the data (which produces a new object) invalidates it for free,
// and nothing is retained once that table is dropped.
const entryCache = new WeakMap<Icd10Table, Icd10Entry[]>();

function entriesOf(table: Icd10Table): Icd10Entry[] {
  const cached = entryCache.get(table);
  if (cached) return cached;
  // `bare` is stored rather than recomputed: prefix matching strips the decimal
  // point from every code on every call, and 98,000 regex replaces per lookup
  // was most of what remained after the entry objects stopped being rebuilt.
  const entries = [
    ...Object.entries(table.billable).map(([code, description]) => ({ code, description, billable: true, bare: code.replace(".", "") })),
    ...Object.entries(table.headers).map(([code, description]) => ({ code, description, billable: false, bare: code.replace(".", "") })),
  ];
  // Sorted once, so every caller that wants code order gets it without sorting
  // a 98,000-element array of its own.
  entries.sort((a, b) => a.code.localeCompare(b.code));
  entryCache.set(table, entries);
  return entries;
}

export function lookup(table: Icd10Table, code: string): Icd10Entry | null {
  const c = normalizeCode(code);
  if (table.billable[c] !== undefined) return { code: c, description: table.billable[c], billable: true, bare: c.replace(".", "") };
  if (table.headers[c] !== undefined) return { code: c, description: table.headers[c], billable: false, bare: c.replace(".", "") };
  return null;
}

/** Codes strictly beneath this one in the hierarchy. */
export function childrenOf(table: Icd10Table, code: string): Icd10Entry[] {
  const c = normalizeCode(code);
  const bare = c.replace(/\./g, "");
  return entriesOf(table)
    .filter((e) => e.bare.length > bare.length && e.bare.startsWith(bare));
}

const CODE_QUERY = /^[A-TV-Z][0-9][0-9A-Z]?\.?[0-9A-Z]*$/i;

/**
 * Search by code prefix or clinical term.
 *
 * A query that looks like a code is treated as one — searching descriptions for
 * "E11" would return every entry whose text happens to contain those letters and
 * bury the code the reader asked for.
 */
export function search(table: Icd10Table, query: string, max = 15): Icd10Entry[] {
  const q = query.trim();
  if (!q) return [];
  const all = entriesOf(table);

  if (CODE_QUERY.test(q)) {
    const bare = q.replace(/\./g, "").toUpperCase();
    return all
      .filter((e) => e.bare.startsWith(bare))
      .slice(0, max);
  }

  // RANKED BY HOW MANY TERMS MATCH, not filtered to all of them.
  //
  // Requiring every word was the first version and it was quietly bad: a search
  // for "diabetic foot ulcer" returned Z86.31 (personal history of diabetic foot
  // ulcer) and nothing else, because E11.621 is titled "…diabetes mellitus with
  // foot ulcer" and the word in it is "diabetes", not "diabetic". The one code a
  // coder actually wanted was excluded by a letter. This is literal substring
  // matching over CMS titles — there is no clinical synonym index behind it, and
  // pretending otherwise by demanding exact wording turns a near miss into a
  // wrong answer.
  //
  // Full matches still rank first, so the strict result is never buried. Then
  // BILLABLE ahead of headers: "acute appendicitis" otherwise led with K35, K35.8
  // and K35.89 — the shortest, most on-point titles in the file and every one of
  // them unusable on a claim. Length breaks the remaining ties, since the
  // shortest title containing the terms is the most specific match to the words
  // that were actually asked about.
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = all
    .map((entry) => {
      const d = entry.description.toLowerCase();
      return { entry, score: terms.reduce((n, t) => n + (d.includes(t) ? 1 : 0), 0) };
    })
    .filter((s) => s.score > 0);

  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.entry.billable) - Number(a.entry.billable) ||
        a.entry.description.length - b.entry.description.length ||
        a.entry.code.localeCompare(b.entry.code),
    )
    .slice(0, max)
    .map((s) => s.entry);
}

export function renderSearch(rows: Icd10Entry[], query: string, fy: number): string {
  if (rows.length === 0) return `No ICD-10-CM matches for "${query}" in the local FY${fy} code set.`;
  return [
    ...rows.map((r) => `${r.code.padEnd(9)} ${r.description}${r.billable ? "" : "   [category header — not billable]"}`),
    "",
    // Said plainly, because the model should not present these as a clinical
    // index: they are CMS's own titles matched literally, ranked by how many of
    // the search words appear. A code further down may match only some of them.
    `Local CMS ICD-10-CM FY${fy} — matched on the wording of CMS code titles, best match first.`,
  ].join("\n");
}

export function renderValidation(table: Icd10Table, code: string): string {
  const c = normalizeCode(code);
  const hit = lookup(table, c);
  if (!hit) {
    // Offer the parent rather than nothing: a code invented one character too
    // long is the commonest way to get here, and naming the family it belongs
    // to is the answer the reader actually wanted.
    const bare = c.replace(/\./g, "");
    const near = entriesOf(table)
      .filter((e) => bare.startsWith(e.bare))
      .sort((a, b) => b.code.length - a.code.length)
      .slice(0, 3);
    return [
      `${c} is NOT a valid ICD-10-CM code in the local CMS FY${table.fy} code set.`,
      ...(near.length > 0 ? ["", "Closest valid ancestors:", ...near.map((e) => `  ${e.code.padEnd(9)} ${e.description}`)] : []),
    ].join("\n");
  }

  const kids = childrenOf(table, c);
  const out = [`${hit.code}  ${hit.description}`];
  if (hit.billable) {
    out.push("BILLABLE: yes — valid at full specificity per the CMS order file.");
    // A billable code CAN still have children (E11.6 is not billable but E11.65
    // is, and E11.65 has none; other families differ). Saying so avoids a reader
    // concluding from silence that nothing more specific exists.
    if (kids.length > 0) out.push(`${kids.length} more specific code(s) also exist beneath it — check whether the documentation supports one.`);
  } else {
    out.push(
      "BILLABLE: no — this is a category header. Submitting it will be rejected as lacking specificity.",
      ...(kids.length > 0
        ? ["", `${kids.length} code(s) beneath it${kids.length > 8 ? " (first 8)" : ""}:`, ...kids.slice(0, 8).map((e) => `  ${e.code.padEnd(9)} ${e.description}${e.billable ? "" : "   [also a header]"}`)]
        : []),
    );
  }
  out.push("", `Local CMS ICD-10-CM FY${table.fy}.`);
  return out.join("\n");
}
