import fs from "node:fs";
import path from "node:path";
import { dataDir, loadDataJson } from "../tools/healthcare/datasets.js";
import { normalizeCode } from "../tools/healthcare/icd10-local.js";
import { parseSpokenCode } from "./spoken-codes.js";

// ── Is that a real code, or one that merely sounds like one? ─────────────────
// A recognizer does not fail loudly. It returns a confident five-digit string,
// and the string it returns is very often the WRONG NEIGHBOUR of the one that
// was said: 99214 comes back as 99215, J1885 as J1985, E11.65 as E11.66. Every
// one of those is a plausible code. Some of them are real codes for something
// else entirely — 99215 is a level-5 visit and billing it for a level-4 one is
// an upcoding finding, and J1985 is not ketorolac.
//
// Nothing downstream can catch that. A scrubber handed 99215 scrubs 99215
// cleanly, because there is nothing wrong with 99215. The substitution is only
// visible HERE, at the moment the heard string is first compared against the
// codes that actually exist.
//
// So: check what was heard against the installed code sets, and when the
// evidence does not pick exactly one answer, REFUSE and hand back the
// candidates. An interface that asks "did you mean 99213 or 99214?" costs the
// user two seconds. An interface that picks costs them an audit.
//
// Everything except loadInstalledUniverse is pure and takes its code universe
// as a parameter, so the matching rules can be tested against a handful of
// synthetic codes rather than against whatever happens to be installed on the
// machine running the tests.

export type CodeKind = "cpt" | "hcpcs" | "icd10";

/**
 * The codes that actually exist, as far as this installation knows.
 *
 * Three flat sets rather than one, because which table a heard string is
 * compared against is the whole safety property: a HCPCS candidate must never
 * be able to come back as a CPT code, and separate sets make that structural
 * instead of a check somebody can forget.
 *
 * Membership only — no descriptions. This module answers "does this code
 * exist", not "what is it", and keeping descriptions out means the CPT
 * descriptors AetheraClaw is not licensed to redistribute never enter it.
 */
export interface CodeUniverse {
  cpt: Set<string>;
  hcpcs: Set<string>;
  icd10: Set<string>;
}

export type SnapResult =
  | { status: "exact"; code: string; kind: CodeKind }
  | { status: "snapped"; code: string; kind: CodeKind; from: string; distance: number; why: string }
  | { status: "ambiguous"; candidates: Array<{ code: string; kind: CodeKind; distance: number }>; why: string }
  | { status: "unknown"; from: string; why: string };

export interface SnapOptions {
  /**
   * How far a heard string may be from a real code and still be read as it.
   *
   * One by default, and that is a judgement about this domain rather than a
   * tunable. At distance 1 a five-digit code has a few dozen neighbours in the
   * whole CPT range and usually zero or one of them is installed. At distance 2
   * it has thousands, and "the nearest installed code" stops carrying any
   * information about what was said — it just names whichever code happens to
   * be closest in a space where everything is close.
   */
  maxDistance?: number;
  /**
   * Restrict the search to one code set, when the caller already knows which
   * one is being dictated (a diagnosis field, a procedure field). This also
   * resolves the [A-Z]\d{4} collision described on shapeKinds.
   */
  kind?: CodeKind;
}

const DEFAULT_MAX_DISTANCE = 1;

const KIND_LABEL: Record<CodeKind, string> = { cpt: "CPT", hcpcs: "HCPCS", icd10: "ICD-10" };

// Shapes, matched against the UPPERCASED candidate. These are the same shapes
// parseSpokenCode is willing to emit, deliberately: a string that module would
// never produce is a string this one should never be asked about.
const CPT_SHAPE = /^\d{5}$/;
const HCPCS_SHAPE = /^[A-Z]\d{4}$/;
// The third character is [0-9A-Z], not a digit: C7A, D3A, M1A and Z3A are real
// ICD-10-CM categories (neuroendocrine tumours, chronic gout, weeks of
// gestation), and a stricter `\d{2}` here would quietly drop several hundred
// real codes out of the universe and report every one of them as not a code.
// The dot is optional because CMS's own order file omits it.
const ICD10_SHAPE = /^[A-Z]\d[0-9A-Z](?:\.?[0-9A-Z]{1,4})?$/;
/** 0054T, 0001F — real CPT codes, but no table here carries them. See snapCode. */
const CPT_CATEGORY_SHAPE = /^\d{4}[A-Z]$/;

/**
 * Which tables a candidate is even allowed to be compared against.
 *
 * This is rule 5 — never snap across kinds — expressed as data rather than as a
 * check: the CPT set is simply not reachable from a candidate that starts with
 * a letter, so "J1885" cannot come back as a CPT code no matter what else goes
 * wrong below.
 *
 * The one genuine overlap is [A-Z]\d{4}. "E1165" is both a real HCPCS code (a
 * wheelchair) and the undotted spelling of a real ICD-10 code (E11.65, type 2
 * diabetes with hyperglycemia). There is no way to tell those apart from the
 * string, so both tables are searched and the tie rule below turns the collision
 * into a question instead of a coin flip. Pass opts.kind when the field being
 * dictated already settles it.
 */
function shapeKinds(probe: string): CodeKind[] {
  if (CPT_SHAPE.test(probe)) return ["cpt"];
  const kinds: CodeKind[] = [];
  if (HCPCS_SHAPE.test(probe)) kinds.push("hcpcs");
  if (ICD10_SHAPE.test(probe)) kinds.push("icd10");
  return kinds;
}

/**
 * The two spellings of an ICD-10 code, most canonical first.
 *
 * CMS's own order file omits the decimal point and every coder types it, so
 * both "E1165" and "E11.65" have to find E11.65. The dot is punctuation, not
 * information — it is stripped on both sides before any distance is measured,
 * so a missing dot never registers as an edit and never eats the one edit of
 * budget a genuine mishearing needs.
 */
function icd10Forms(probe: string): string[] {
  const bare = probe.replace(/\./g, "");
  const dotted = normalizeCode(probe);
  return dotted === bare ? [bare] : [dotted, bare];
}

function comparable(code: string, kind: CodeKind): string {
  return kind === "icd10" ? code.replace(/\./g, "") : code;
}

/**
 * Beyond this length the distance is bounded rather than computed.
 *
 * No code is close to it — the longest thing here is a seven-character ICD-10
 * code — so this never fires on real input. It exists because snapCode is
 * reachable from a live microphone and editDistance is O(n·m): without a cap, a
 * recognizer that returns a paragraph instead of a code makes the gateway spend
 * seconds in a nested loop per installed code.
 */
const MAX_COMPARE_LENGTH = 64;

/**
 * Damerau-Levenshtein distance: insertions, deletions, substitutions and
 * TRANSPOSITIONS of adjacent characters, each costing one.
 *
 * The transposition is the reason this is not plain Levenshtein. Swapped digits
 * are the signature error of both speech recognition and the human repeating a
 * code back — "99213" heard as "99231" is one swap and should be treated as the
 * near miss it is, where Levenshtein scores it 2 and (at the default budget)
 * silently declares the two codes unrelated. Getting that wrong does not cause a
 * bad snap; it causes a MISSED one, which shows up as the assistant refusing a
 * code the user plainly said.
 *
 * This is the restricted (optimal string alignment) variant, which forbids
 * editing between two transposed characters. That distinction can only appear at
 * distance 3 or more, and nothing here is ever asked about distances that large.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // max(len) is a true upper bound on the real distance, so the cap can only
  // ever make two strings look FARTHER apart than they are. It can suppress a
  // snap; it can never cause one.
  if (a.length > MAX_COMPARE_LENGTH || b.length > MAX_COMPARE_LENGTH) return Math.max(a.length, b.length);

  // Three rows are enough: the transposition case reaches back two rows and two
  // columns, and nothing reaches further.
  const width = b.length + 1;
  let twoBack = new Array<number>(width).fill(0);
  let oneBack = new Array<number>(width);
  let current = new Array<number>(width);
  for (let j = 0; j <= b.length; j++) oneBack[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        oneBack[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        oneBack[j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, twoBack[j - 2] + 1); // transposition
      }
      current[j] = best;
    }
    const spent = twoBack;
    twoBack = oneBack;
    oneBack = current;
    current = spent;
  }
  return oneBack[b.length];
}

interface Candidate {
  code: string;
  kind: CodeKind;
  distance: number;
}

function neighbours(probe: string, kind: CodeKind, members: Set<string>, maxDistance: number): Candidate[] {
  if (maxDistance <= 0) return [];
  const from = comparable(probe, kind);
  const out: Candidate[] = [];
  for (const member of members) {
    const target = comparable(member, kind);
    // A length gap larger than the budget cannot be closed by any edit, and
    // skipping on it removes the distance computation for nearly every code in
    // a 74,000-entry table.
    if (Math.abs(target.length - from.length) > maxDistance) continue;
    const distance = editDistance(from, target);
    // distance 0 is an exact hit, already handled and never reported as a snap.
    if (distance > 0 && distance <= maxDistance) out.push({ code: member, kind, distance });
  }
  return out;
}

function orList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function labelList(kinds: CodeKind[]): string {
  return orList([...new Set(kinds)].map((k) => KIND_LABEL[k]));
}

/**
 * Validate a written code against the codes that exist, and report honestly
 * when it cannot be resolved to exactly one.
 *
 * The four outcomes are deliberately not collapsible into a code-or-null: the
 * caller has to be able to tell "this is the code" from "this is my best guess"
 * from "ask the user", and a nullable string erases the difference between the
 * last two by making the near-miss look like a clean answer.
 */
export function snapCode(candidate: string, universe: CodeUniverse, opts: SnapOptions = {}): SnapResult {
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const from = String(candidate ?? "").trim();
  const probe = from.toUpperCase().replace(/\s+/g, "");

  if (!probe) {
    return { status: "unknown", from, why: "Nothing was heard to check — no code was looked up." };
  }

  let kinds = shapeKinds(probe);
  if (opts.kind) {
    // A caller that says which field is being dictated is also saying the other
    // tables are off limits. Filtering here rather than trusting the shape means
    // "J1885" dictated into a procedure field is refused outright instead of
    // being quietly matched somewhere else.
    kinds = kinds.filter((k) => k === opts.kind);
    if (kinds.length === 0) {
      return {
        status: "unknown",
        from,
        why: `"${from}" is not shaped like a ${KIND_LABEL[opts.kind]} code, so it was not compared against the ${KIND_LABEL[opts.kind]} set or any other. Nothing was corrected.`,
      };
    }
  }

  if (kinds.length === 0) {
    // Rule 4, and the reason it exists: a string of no known code shape is NOT
    // fuzzy-matched against everything. "9921" is one edit from ninety-odd real
    // CPT codes, and the nearest of them is not evidence of anything.
    if (CPT_CATEGORY_SHAPE.test(probe)) {
      return {
        status: "unknown",
        from,
        why: `"${from}" is shaped like a CPT Category II/III code (four digits and a letter). No table of those is installed here, so it was neither confirmed nor corrected — check it by hand.`,
      };
    }
    return {
      status: "unknown",
      from,
      why: `"${from}" is not shaped like a CPT (five digits), HCPCS (letter and four digits) or ICD-10 code, so it was not matched against any code set. Nothing was corrected.`,
    };
  }

  // ── Exact first, and exact wins ────────────────────────────────────────────
  // A code that exists is never "corrected". Without this, a real code with a
  // real neighbour would be scored against that neighbour and could be reported
  // as ambiguous with it — turning a correct dictation into a question, which
  // trains the user to stop reading the questions.
  const exact: Candidate[] = [];
  for (const kind of kinds) {
    if (kind === "icd10") {
      const hit = icd10Forms(probe).find((f) => universe.icd10.has(f));
      if (hit !== undefined) exact.push({ code: hit, kind, distance: 0 });
    } else if (universe[kind].has(probe)) {
      exact.push({ code: probe, kind, distance: 0 });
    }
  }
  if (exact.length === 1) return { status: "exact", code: exact[0].code, kind: exact[0].kind };
  if (exact.length > 1) {
    // Both readings of the string are real codes — the E1165 / E11.65 collision.
    // Nothing about the audio distinguishes them, so this is a tie like any
    // other and gets the same answer: ask.
    return {
      status: "ambiguous",
      candidates: sortCandidates(exact),
      why: `"${from}" is a real code in more than one code set (${exact.map((c) => `${c.code} in ${KIND_LABEL[c.kind]}`).join(", ")}). Nothing in what was said picks one, so none was chosen.`,
    };
  }

  // ── Nothing exact: how close is the nearest real code? ─────────────────────
  const found = kinds.flatMap((kind) => neighbours(probe, kind, universe[kind], maxDistance));
  if (found.length === 0) {
    return {
      status: "unknown",
      from,
      why: `"${from}" is not an installed ${labelList(kinds)} code, and no installed ${labelList(kinds)} code is within ${maxDistance} edit${maxDistance === 1 ? "" : "s"} of it. It was NOT corrected to anything — say it again, or check that the code set is installed.`,
    };
  }

  const best = Math.min(...found.map((c) => c.distance));
  const tied = sortCandidates(found.filter((c) => c.distance === best));

  // ── Rule 3, the load-bearing one ───────────────────────────────────────────
  // Two real codes equally close to what was heard is exactly the situation
  // where picking is most tempting and most dangerous: 99213 and 99214 are both
  // one edit from "9921X", they differ by a level of service, and no ordering,
  // frequency table or tie-break contains any information about which one was
  // spoken. The only honest output is both of them and a question.
  if (tied.length > 1) {
    return {
      status: "ambiguous",
      candidates: tied,
      why: `"${from}" is not an installed code, and ${tied.length} installed codes are equally close to it at ${best} edit${best === 1 ? "" : "s"}: ${tied.map((c) => c.code).join(", ")}. No code was chosen — this needs to be confirmed out loud.`,
    };
  }

  const hit = tied[0];
  return {
    status: "snapped",
    code: hit.code,
    kind: hit.kind,
    from,
    distance: hit.distance,
    why: `"${from}" is not an installed ${KIND_LABEL[hit.kind]} code. ${hit.code} is the only installed ${KIND_LABEL[hit.kind]} code within ${maxDistance} edit${maxDistance === 1 ? "" : "s"} of it (${hit.distance} away), so it was read as ${hit.code}.`,
  };
}

/** Deterministic order, so a tie renders the same way every time it is asked about. */
function sortCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) => a.distance - b.distance || a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code),
  );
}

/**
 * The whole path from an utterance to a verified code.
 *
 * parseSpokenCode is the timid half — it turns "nine nine two one three" into
 * "99213" or into nothing at all — and this is the half that then asks whether
 * 99213 is a code that exists. Neither is sufficient alone: parsing without
 * validation accepts any well-shaped mishearing, and validation without parsing
 * never sees a spoken code in the first place.
 */
export function snapSpokenCode(text: string, universe: CodeUniverse, opts: SnapOptions = {}): SnapResult {
  const said = String(text ?? "").trim();
  const parsed = parseSpokenCode(said);
  if (parsed === null) {
    return {
      status: "unknown",
      from: said,
      why: `"${said}" did not sound like a code at all — no run of digits or code letters could be read out of it, so nothing was looked up. Nothing was guessed.`,
    };
  }
  return snapCode(parsed, universe, opts);
}

/**
 * One line for a person: what happened, in the voice the interface should use.
 *
 * The ambiguous case is phrased as a QUESTION on purpose. It is the only status
 * where the interface must go back to the user, and a statement ("2 candidates
 * found") gets read out and then ignored, while a question gets answered. The
 * codes are named in it, because "please repeat that" throws away the work of
 * having narrowed it to two.
 */
export function describeSnap(result: SnapResult): string {
  switch (result.status) {
    case "exact":
      return `${result.code} — a valid ${KIND_LABEL[result.kind]} code.`;
    case "snapped":
      return `Heard "${result.from}", which is not a ${KIND_LABEL[result.kind]} code — using ${result.code}, the only ${KIND_LABEL[result.kind]} code ${result.distance} character${result.distance === 1 ? "" : "s"} away. Say it again if that is wrong.`;
    case "ambiguous": {
      const codes = result.candidates.map((c) => c.code);
      const distance = result.candidates[0]?.distance ?? 0;
      const label = labelList(result.candidates.map((c) => c.kind));
      const lead =
        distance === 0
          ? `That is a real code in more than one code set (${label})`
          : `${codes.length} ${label} codes are ${distance} character${distance === 1 ? "" : "s"} from what I heard`;
      // Past half a dozen there is nothing useful to read back, and a list that
      // long is not a question anybody can answer out loud.
      if (codes.length > 6) {
        return `${lead} — I cannot tell which of ${codes.length} codes you meant; could you read it digit by digit?`;
      }
      return `${lead} — did you mean ${orList(codes)}?`;
    }
    case "unknown":
      // The why already names what was heard and says nothing was corrected,
      // which is the whole line. Wrapping it would only repeat the original.
      return result.why;
  }
}

// ── The one impure export ────────────────────────────────────────────────────

interface StampedUniverse {
  stamp: string;
  value: CodeUniverse;
}

let universeCache: StampedUniverse | null = null;

function fileStamp(name: string): string {
  try {
    const s = fs.statSync(path.join(dataDir(), name));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
}

/**
 * Build a universe from the datasets installed under ~/.aetheraclaw/data.
 *
 * Two files, three sets:
 *
 *  - icd10.json is `{ fy, billable: { "E11.65": "…" }, headers: { "A01.0": "…" } }`
 *    with the decimal point already in place. BOTH maps go in. A category
 *    header is a real code, and leaving them out would make a dictated "A01.0"
 *    look like a near miss for its own children A01.00–A01.09 — a silent
 *    upgrade in specificity, which is precisely the class of substitution this
 *    module exists to prevent. Whether a code is billable is a separate
 *    question, and icd10_validate is where it is asked.
 *
 *  - hcpcs.json is a flat `{ "CODE": "short description" }` from the CMS RVU
 *    file, and it is NOT only HCPCS Level II: of its ~17,000 keys, roughly
 *    9,800 are five-digit CPT Level I numbers, 6,100 are Level II letter codes
 *    and 1,200 are four-digit Category II/III codes. So it is split by shape,
 *    the CPT numbers seeding the CPT set. Only the KEYS are read — the
 *    descriptions in that file are AMA-licensed text and never enter here.
 *    Category II/III codes are dropped, because there is no kind for them;
 *    snapCode says so rather than pretending they are unrecognisable.
 *
 * A missing or malformed file yields an empty set, never a throw: this runs
 * behind a live microphone, and a voice interface that crashes on a dataset
 * that was never installed is worse than one that says "not an installed code".
 *
 * Memoised on the two files' mtime and size, not just on first call. That is
 * not a micro-optimisation, it is a bug that has already happened once here (see
 * the same treatment in datasets.ts): cached-forever meant a session that
 * started before the data was installed kept answering "unknown code" for the
 * rest of its life, telling the user to install a file they had just installed.
 */
export function loadInstalledUniverse(): CodeUniverse {
  const stamp = `${fileStamp("icd10.json")}|${fileStamp("hcpcs.json")}`;
  if (universeCache && universeCache.stamp === stamp) return universeCache.value;

  const cpt = new Set<string>();
  const hcpcs = new Set<string>();
  const icd10 = new Set<string>();

  const icd = loadDataJson<{ billable?: Record<string, string>; headers?: Record<string, string> }>("icd10.json");
  for (const group of [icd?.billable, icd?.headers]) {
    if (!group || typeof group !== "object") continue;
    for (const code of Object.keys(group)) {
      const c = code.trim().toUpperCase();
      if (ICD10_SHAPE.test(c)) icd10.add(c);
    }
  }

  const level2 = loadDataJson<Record<string, string>>("hcpcs.json");
  if (level2 && typeof level2 === "object") {
    for (const code of Object.keys(level2)) {
      const c = code.trim().toUpperCase();
      if (CPT_SHAPE.test(c)) cpt.add(c);
      else if (HCPCS_SHAPE.test(c)) hcpcs.add(c);
    }
  }

  const value: CodeUniverse = { cpt, hcpcs, icd10 };
  universeCache = { stamp, value };
  return value;
}
