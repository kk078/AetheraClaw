import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/memory/sqlite.js";
import { catalogueFor, classifyTable, readCatalogue, resetCatalogueCache, scanForIdentifiers } from "../src/tools/healthcare/reference-db.js";
import { lookupRole, renderRoles, resolveRoute, roleStatuses, searchRole } from "../src/tools/healthcare/reference-routes.js";
import { explainWithReference } from "../src/tools/healthcare/denial-codes.js";
import { splitStates } from "../src/tools/healthcare/coverage.js";

// Built to the shape of the real 1.24 GB database this was designed against —
// table and column names copied from its schema, contents synthetic.

let dir: string;
let dbFile: string;
let cfg: { referenceDbPath: string; referenceDbLicensedRoles?: string[] };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aetheraclaw-routes-"));
  dbFile = path.join(dir, "reference.db");
  const db = openDatabase(dbFile);
  db.exec(`
    CREATE TABLE ref_carc (code TEXT, description TEXT, updatedAt TEXT);
    CREATE TABLE ref_rarc (code TEXT, description TEXT, updatedAt TEXT);
    CREATE TABLE ref_hcpcs (code TEXT, short_desc TEXT, long_desc TEXT);
    CREATE TABLE ref_cpt (code TEXT, short_desc TEXT, long_desc TEXT);
    CREATE TABLE ref_ndc (ndc TEXT, proprietary_name TEXT, nonproprietary_name TEXT);
    CREATE TABLE ref_mac (code TEXT, name TEXT, jurisdiction TEXT, states TEXT, type TEXT);
    CREATE TABLE ref_hcc_mapping (ICD_CODE TEXT, LONG_TITLE TEXT, HCC_V24 TEXT, HCC_V28 TEXT, RISK_WEIGHT_V24 TEXT, RISK_WEIGHT_V28 TEXT, CONDITION_CATEGORY TEXT);
    CREATE TABLE ref_eob_crosswalk (id INTEGER, payer TEXT, eob_code TEXT, eob_desc TEXT, carc TEXT, carc_desc TEXT, rarc TEXT, rarc_desc TEXT);
    CREATE TABLE era_835_raw (id INTEGER, filename TEXT, file_content TEXT, import_date TEXT, parsed INTEGER, claims_count INTEGER);
    CREATE TABLE rcm_knowledge (id TEXT, domain_id TEXT, kind TEXT, title TEXT, content TEXT, embedded INTEGER);
    CREATE TABLE ref_npi (npi TEXT, last_name TEXT, first_name TEXT, mail_address TEXT, loc_phone TEXT);
  `);
  db.prepare("INSERT INTO ref_carc VALUES (?,?,?)").run("253", "Sequestration - reduction in federal payment", "2026-01-01");
  db.prepare("INSERT INTO ref_carc VALUES (?,?,?)").run("B7", "This provider was not certified for this procedure on this date", "2026-01-01");
  db.prepare("INSERT INTO ref_rarc VALUES (?,?,?)").run("N793", "Alert: CMS is changing from the Medicare Beneficiary Identifier", "2026-01-01");
  db.prepare("INSERT INTO ref_hcpcs VALUES (?,?,?)").run("J1885", null, "Injection, ketorolac tromethamine, per 15 mg");
  db.prepare("INSERT INTO ref_hcpcs VALUES (?,?,?)").run("E0114", null, "Crutches underarm, other than wood, adjustable or fixed, pair, with pads, tips and handgrips");
  db.prepare("INSERT INTO ref_cpt VALUES (?,?,?)").run("99214", null, "Office or other outpatient visit, established patient, moderate level");
  db.prepare("INSERT INTO ref_ndc VALUES (?,?,?)").run("00093721410", "Ketorolac Tromethamine", null);
  db.prepare("INSERT INTO ref_mac VALUES (?,?,?,?,?)").run("04112", "Novitas Solutions", "Jurisdiction H", "AR, CO, LA, MS, NM, OK, TX", "Part A/B");
  db.prepare("INSERT INTO ref_mac VALUES (?,?,?,?,?)").run("18003", "CGS Administrators", "Jurisdiction C", "TX, IN, MN", "DME");
  db.prepare("INSERT INTO ref_hcc_mapping VALUES (?,?,?,?,?,?,?)").run("E1165", "Type 2 diabetes with hyperglycemia", "19", "37", "0.105", "0.166", "Diabetes");
  db.prepare("INSERT INTO ref_eob_crosswalk VALUES (?,?,?,?,?,?,?,?)").run(1, "Aetna", "A123", "Service not covered under plan", "96", "Non-covered charge(s)", "N130", "Consult plan benefit documents");
  db.prepare("INSERT INTO era_835_raw VALUES (?,?,?,?,?,?)").run(1, "era1.835", "ISA*00*...NM1*QC*1*RIVERA*JOSE...", "2026-01-15", 1, 4);
  db.prepare("INSERT INTO rcm_knowledge VALUES (?,?,?,?,?,?)").run("k1", "denials", "guidance", "Appeals", "A long passage of reference text about appeals.", 1);
  db.prepare("INSERT INTO ref_npi VALUES (?,?,?,?,?)").run("1497714976", "Chen", "Amy", "1 Main St", "5125550100");
  db.close();
  cfg = { referenceDbPath: dbFile };
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetCatalogueCache());

describe("the document-column gap", () => {
  // Found by reading a real schema: era_835_raw has not one identifier-shaped
  // column name, so the first version let it straight through — and every
  // file_content value is an 835 carrying patient names in its NM1 segments.
  it("quarantines a raw-document column in a transactional table", () => {
    const hits = scanForIdentifiers(["id", "filename", "file_content", "import_date", "parsed", "claims_count"]);
    expect(hits.map((h) => h.column)).toContain("file_content");
    expect(hits.find((h) => h.column === "file_content")!.means).toMatch(/cannot see in/);
  });

  it("leaves a reference table's content column alone", () => {
    // rcm_knowledge.content is 1,800 characters of reference text. Holding it
    // back would be noise, not caution.
    expect(scanForIdentifiers(["id", "domain_id", "kind", "title", "content", "embedded"])).toEqual([]);
  });

  it("holds era_835_raw back in a real catalogue, and keeps rcm_knowledge readable", () => {
    const cat = readCatalogue(dbFile);
    expect(cat.tables.find((t) => t.name === "era_835_raw")!.access).toBe("quarantined");
    expect(cat.tables.find((t) => t.name === "rcm_knowledge")!.access).toBe("readable");
  });

  it("still quarantines a public provider registry, which is the allowance's job", () => {
    // ref_npi is NPPES — public, not PHI — but it carries names, addresses and
    // phones. Quarantining by default and letting the user allow it by name is
    // the correct direction for a scan that cannot know the difference.
    expect(classifyTable({ name: "ref_npi", columns: ["npi", "last_name", "first_name", "mail_address"], rowCount: 60_611 }).access).toBe("quarantined");
    expect(classifyTable({ name: "ref_npi", columns: ["npi", "last_name"], rowCount: 1 }, ["ref_npi"]).access).toBe("readable");
  });
});

describe("role resolution", () => {
  it("maps known tables to roles", () => {
    const cat = readCatalogue(dbFile);
    expect(resolveRoute(cat, "carc")!.table).toBe("ref_carc");
    expect(resolveRoute(cat, "hcpcs")!.columns).toEqual(["long_desc", "short_desc"]);
    expect(resolveRoute(cat, "ndc")!.table).toBe("ref_ndc");
  });

  it("resolves nothing for a role with no table", () => {
    expect(resolveRoute(readCatalogue(dbFile), "loinc")).toBeUndefined();
  });

  it("reports a quarantined table as held back, not as absent", () => {
    // Telling somebody the data is not there when it is sends them looking for
    // a file they already have.
    const statuses = roleStatuses(readCatalogue(dbFile));
    const loinc = statuses.find((s) => s.role === "loinc")!;
    expect(loinc.table).toBeNull();
    expect(loinc.blockedBecause).toBeUndefined();
    expect(renderRoles(statuses)).toMatch(/No table for:.*loinc/);
  });
});

describe("licensed content", () => {
  it("refuses CPT unless the practice named it", () => {
    expect(lookupRole(cfg, "cpt", "99214")).toBeNull();
    expect(searchRole(cfg, "cpt", "outpatient")).toEqual([]);
  });

  it("reads CPT once the role is declared licensed", () => {
    const hit = lookupRole(cfg, "cpt", "99214", { licensedRoles: ["cpt"] });
    expect(hit?.description).toMatch(/established patient/);
    expect(hit?.table).toBe("ref_cpt");
  });

  it("says in the status report why it is blocked, and how", () => {
    const s = roleStatuses(readCatalogue(dbFile)).find((x) => x.role === "cpt")!;
    // The table is NAMED even while blocked. "Not available" and "present but
    // you have not said you may read it" are different situations, and the
    // second one has an action attached.
    expect(s.table).toBe("ref_cpt");
    expect(s.blockedBecause).toMatch(/referenceDbLicensedRoles/);
    expect(roleStatuses(readCatalogue(dbFile), ["cpt"]).find((x) => x.role === "cpt")!.blockedBecause).toBeUndefined();
  });

  it("does not treat an unlicensed role as licensed by omission", () => {
    // HCPCS is not AMA-licensed and must never need declaring.
    expect(lookupRole(cfg, "hcpcs", "J1885")?.description).toMatch(/ketorolac/i);
  });
});

describe("denial explanation", () => {
  const resolve = (role: "carc" | "rarc", code: string) => {
    const hit = lookupRole(cfg, role, code);
    return hit ? { description: hit.description, table: hit.table } : null;
  };

  it("keeps the compiled entry, which carries a category and an action", () => {
    // A bare code list is longer, not richer. Swapping a fuller answer for a
    // wider one is not an improvement. 253 is in BOTH tables, so this is the
    // case where precedence actually decides something.
    const out = explainWithReference("253", [], resolve);
    expect(out).toMatch(/Recommended action:/);
    expect(out).not.toMatch(/attached reference database/);
  });

  it("fills the silence for a code outside the compiled subset", () => {
    // B7 is one of the ~376 published CARCs the compiled table of 24 omits.
    const out = explainWithReference("B7", [], resolve);
    expect(out).toMatch(/not certified for this procedure/);
    expect(out).toMatch(/ref_carc/);
    // And is honest that the extra fields are not there.
    expect(out).toMatch(/No category or recommended action/);
  });

  it("does the same for RARCs, where the compiled table is 14 of about 1,000", () => {
    expect(explainWithReference("1", ["N793"], resolve)).toMatch(/Medicare Beneficiary Identifier/);
  });

  it("still says it cannot explain a code nothing carries", () => {
    expect(explainWithReference("ZZZ", [], resolve)).toMatch(/no attached reference database answers it/);
  });
});

describe("MAC state lookup", () => {
  it("matches whole state codes, never substrings", () => {
    // "IN" must not match INDIANA, MINNESOTA or VIRGINIA. Routing a claim to
    // the wrong jurisdiction is not a cosmetic error.
    expect(splitStates("AR, CO, LA, MS, NM, OK, TX")).toEqual(["AR", "CO", "LA", "MS", "NM", "OK", "TX"]);
    expect(splitStates("INDIANA MINNESOTA")).toEqual([]);
    expect(splitStates("TX/IN;MN")).toEqual(["TX", "IN", "MN"]);
  });
});

describe("HCC mapping", () => {
  it("finds a mapped diagnosis by either spelling", () => {
    expect(lookupRole(cfg, "hcc", "E1165")?.description).toMatch(/hyperglycemia/);
  });

  it("carries every model version present, since the weight differs by model", () => {
    const row = lookupRole(cfg, "hcc", "E1165")!.row;
    expect(row.HCC_V24).toBe("19");
    expect(row.HCC_V28).toBe("37");
    expect(row.RISK_WEIGHT_V24).not.toBe(row.RISK_WEIGHT_V28);
  });
});

describe("EOB crosswalk", () => {
  it("returns the CARC and RARC a payer's own code maps to", () => {
    const hit = lookupRole(cfg, "eob", "A123")!;
    expect(hit.row.carc).toBe("96");
    expect(hit.row.rarc).toBe("N130");
    expect(hit.row.payer).toBe("Aetna");
  });
});

describe("search", () => {
  it("searches descriptions and names its table", () => {
    const rows = searchRole(cfg, "hcpcs", "crutches");
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe("E0114");
    expect(rows[0].table).toBe("ref_hcpcs");
  });

  it("returns nothing rather than throwing when no database is configured", () => {
    expect(lookupRole({}, "carc", "253")).toBeNull();
    expect(searchRole({}, "hcpcs", "crutch")).toEqual([]);
  });
});

// ── Descriptor precedence ────────────────────────────────────────────────────
// Found by running hcpcs_lookup against a real install, not by reading it.
describe("which description wins", () => {
  const hcpcsLookup = async (code: string, licensedRoles: string[] = []) => {
    const { buildRegistry } = await import("../src/tools/build-registry.js");
    const config = { healthcare: { referenceDbPath: dbFile, referenceDbLicensedRoles: licensedRoles }, approvalPolicy: "never" } as never;
    const registry = buildRegistry(config, null as never);
    resetCatalogueCache();
    return (await registry.execute("hcpcs_lookup", { code }, { services: { config, store: null, registry } } as never)).content;
  };

  it("leads with the fullest descriptor, not the first source found", async () => {
    // hcpcs.json comes from the RVU file's description column, which is a
    // truncated abbreviation — "Ketorolac tromethamine inj" against the real
    // descriptor "Injection, ketorolac tromethamine, per 15 mg". A coder
    // checking a unit definition needs the "per 15 mg".
    const out = await hcpcsLookup("J1885");
    expect(out).toMatch(/^J1885: Injection, ketorolac tromethamine, per 15 mg/);
    expect(out).toMatch(/ref_hcpcs/);
  });

  it("names a disagreeing source rather than silently resolving it", async () => {
    const out = await hcpcsLookup("J1885");
    // Only when the suite runs on a machine with the CMS data installed; when
    // it is absent there is simply one source and nothing to compare.
    if (out.includes("Also described as")) expect(out).toMatch(/abbreviated/);
  });

  it("reads CPT only when the role is declared licensed", async () => {
    expect(await hcpcsLookup("99214", ["cpt"])).toMatch(/copyright the AMA/);
    expect(await hcpcsLookup("99214")).not.toMatch(/ref_cpt/);
  });

  it("reports a miss as a miss, not as a nonexistent code", async () => {
    const out = await hcpcsLookup("E0999");
    expect(out).toMatch(/not proof the code does not exist/);
  });
});

// ── The managed install ──────────────────────────────────────────────────────
describe("taking the file into the installation", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.AETHERACLAW_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "aetheraclaw-managed-"));
    process.env.AETHERACLAW_HOME = home;
    resetCatalogueCache();
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.AETHERACLAW_HOME;
    else process.env.AETHERACLAW_HOME = prevHome;
  });

  it("copies, compacts, and records what it installed", async () => {
    const { installReference, managedDbPath, readManifest } = await import("../src/tools/healthcare/reference-store.js");
    const m = installReference(dbFile, { note: "test fixture" });
    expect(fs.existsSync(managedDbPath())).toBe(true);
    expect(m.tables.find((t) => t.name === "ref_carc")!.rows).toBe(2);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readManifest()!.sourcePath).toBe(path.resolve(dbFile));
    // The original is not touched — an install that consumes its input is a
    // move wearing a copy's name.
    expect(fs.existsSync(dbFile)).toBe(true);
  });

  it("is found by the tools with no referenceDbPath set", async () => {
    const { installReference } = await import("../src/tools/healthcare/reference-store.js");
    installReference(dbFile);
    resetCatalogueCache();
    expect(lookupRole({}, "carc", "B7")?.description).toMatch(/not certified/);
  });

  it("still lets an explicit path win", async () => {
    // Somebody who names a path has said where the data is. Quietly preferring
    // a managed copy would answer from a file they did not choose.
    const { installReference, managedDbPath } = await import("../src/tools/healthcare/reference-store.js");
    installReference(dbFile);
    resetCatalogueCache();
    const other = path.join(home, "other.db");
    const db = openDatabase(other);
    db.exec("CREATE TABLE ref_carc (code TEXT, description TEXT)");
    db.prepare("INSERT INTO ref_carc VALUES (?,?)").run("B7", "a different answer entirely");
    db.close();
    expect(lookupRole({ referenceDbPath: other }, "carc", "B7")?.description).toBe("a different answer entirely");
    expect(managedDbPath()).toContain(home);
  });

  it("verifies the installed file against its manifest", async () => {
    const { installReference, managedDbPath, verifyInstalled } = await import("../src/tools/healthcare/reference-store.js");
    installReference(dbFile);
    expect(verifyInstalled().ok).toBe(true);
    fs.appendFileSync(managedDbPath(), "x");
    const after = verifyInstalled();
    expect(after.ok).toBe(false);
    expect(after.message).toMatch(/Size changed/);
  });

  it("refuses to install a file that is not a usable database", async () => {
    const { installReference, managedDbPath } = await import("../src/tools/healthcare/reference-store.js");
    const junk = path.join(home, "junk.db");
    fs.writeFileSync(junk, "not a database at all");
    expect(() => installReference(junk)).toThrow();
    // And left nothing behind at the destination.
    expect(fs.existsSync(managedDbPath())).toBe(false);
  });

  it("reports an unrecorded edition as unknown, never as stale", async () => {
    // Unknown and out-of-date are different, and calling an unrecorded edition
    // stale would send somebody chasing an update they may already have.
    const { installReference, assessReference } = await import("../src/tools/healthcare/reference-store.js");
    const m = installReference(dbFile);
    const icd = assessReference(m, "20260808").find((s) => s.setId === "icd10cm")!;
    expect(icd.installed).toBeNull();
    expect(icd.stale).toBe(false);
    expect(icd.message).toMatch(/Edition not recorded/);
  });

  it("calls a recorded old edition stale", async () => {
    const { installReference, assessReference } = await import("../src/tools/healthcare/reference-store.js");
    const m = installReference(dbFile, { editions: { icd10cm: "20211001" } });
    const icd = assessReference(m, "20260808").find((s) => s.setId === "icd10cm")!;
    expect(icd.installed).toBe("20211001");
    expect(icd.stale).toBe(true);
  });

  it("says plainly that there is no upstream to pull from", async () => {
    const { installReference, describeManifest } = await import("../src/tools/healthcare/reference-store.js");
    const text = describeManifest(installReference(dbFile), "20260808");
    expect(text).toMatch(/no upstream to pull from/);
    expect(text).toMatch(/fetch-cms-data/);
  });
});

// ── The path that goes missing ───────────────────────────────────────────────
// The exact situation after `reference install`: the copy is in place, the
// original gets deleted, and the old path is still sitting in config.
describe("a configured path that no longer exists", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.AETHERACLAW_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "aetheraclaw-gone-"));
    process.env.AETHERACLAW_HOME = home;
    resetCatalogueCache();
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.AETHERACLAW_HOME;
    else process.env.AETHERACLAW_HOME = prevHome;
  });

  it("does NOT silently answer from the managed copy instead", async () => {
    // An explicit path is somebody saying where the data is. Substituting a
    // different file would return a different edition with nothing to say so.
    const { installReference } = await import("../src/tools/healthcare/reference-store.js");
    installReference(dbFile);
    resetCatalogueCache();
    expect(lookupRole({ referenceDbPath: path.join(home, "deleted.db") }, "carc", "B7")).toBeNull();
  });

  it("names the managed copy and the one-line fix", async () => {
    const { installReference, managedDbPath } = await import("../src/tools/healthcare/reference-store.js");
    installReference(dbFile);
    resetCatalogueCache();
    const out = catalogueFor({ referenceDbPath: path.join(home, "deleted.db") }) as { error: string };
    expect(out.error).toMatch(/not found/);
    expect(out.error).toContain(managedDbPath());
    expect(out.error).toMatch(/Remove healthcare\.referenceDbPath/);
  });

  it("says nothing about a managed copy when there is none", () => {
    const out = catalogueFor({ referenceDbPath: path.join(home, "deleted.db") }) as { error: string };
    expect(out.error).toMatch(/not found/);
    expect(out.error).not.toMatch(/managed copy/);
  });
});
