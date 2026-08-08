import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/memory/sqlite.js";
import {
  CODE_SHAPE_THRESHOLD,
  catalogueFor,
  classifyTable,
  describeCatalogue,
  findTable,
  identifyCodeSet,
  readCatalogue,
  renderLookup,
  resetCatalogueCache,
  scanForIdentifiers,
  referenceDbStatusTool,
  referenceLookupTool,
  type ReferenceCatalogue,
} from "../src/tools/healthcare/reference-db.js";
import { renderDatasetStatus } from "../src/tools/healthcare/datasets.js";

// A reference database the user cannot vouch for is the whole premise: the gate
// has to hold before the first read, not after the first surprise.

let dir: string;
let dbFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aetheraclaw-refdb-"));
  dbFile = path.join(dir, "fixture.db");
  const db = openDatabase(dbFile);
  db.exec(`
    CREATE TABLE codes (code TEXT, description TEXT);
    CREATE TABLE patients (mrn TEXT, dob TEXT, last_name TEXT, note TEXT);
    CREATE TABLE payers (payer_id TEXT, name TEXT);
  `);
  const ins = db.prepare("INSERT INTO codes VALUES (?, ?)");
  ins.run("E11.65", "Type 2 diabetes mellitus with hyperglycemia");
  ins.run("E11.9", "Type 2 diabetes mellitus without complications");
  ins.run("I10", "Essential (primary) hypertension");
  ins.run("J45.909", "Unspecified asthma, uncomplicated");
  ins.run("M54.50", "Low back pain, unspecified");
  db.prepare("INSERT INTO patients VALUES (?, ?, ?, ?)").run("MR00918", "1985-03-12", "Rivera", "seen 3x");
  db.prepare("INSERT INTO payers VALUES (?, ?)").run("00123", "Example Health Plan");
  db.close();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("identifier scan", () => {
  it("names the column and what it looks like, not just that something matched", () => {
    const hits = scanForIdentifiers(["mrn", "dob", "last_name", "code"]);
    expect(hits.map((h) => h.column)).toEqual(["mrn", "dob", "last_name"]);
    expect(hits.find((h) => h.column === "dob")?.means).toBe("date of birth");
  });

  it("catches the identifier spellings a real schema uses", () => {
    for (const column of ["MRN", "patient_id", "SubscriberID", "member_num", "ssn", "date_of_birth", "PatientFirstName", "street_address", "home_phone", "email_addr", "guarantor", "encounter_id"]) {
      expect(scanForIdentifiers([column]), column).toHaveLength(1);
    }
  });

  it("leaves ordinary reference columns alone", () => {
    expect(scanForIdentifiers(["code", "description", "effective_date", "modifier", "rvu_work"])).toEqual([]);
  });
});

describe("table classification", () => {
  it("quarantines a table with identifier columns", () => {
    const t = classifyTable({ name: "patients", columns: ["mrn", "dob", "last_name"], rowCount: 4_000 });
    expect(t.access).toBe("quarantined");
    expect(t.identifiers).toHaveLength(3);
    // A quarantined table exposes no read path, not even a code column it happens to have.
    expect(t.codeColumn).toBeUndefined();
  });

  it("reads a clean code table and finds its code and description columns", () => {
    const t = classifyTable({ name: "codes", columns: ["code", "description"], rowCount: 70_000 });
    expect(t.access).toBe("readable");
    expect(t.codeColumn).toBe("code");
    expect(t.descriptionColumn).toBe("description");
  });

  it("honours a per-table allowance and records that it was one", () => {
    const t = classifyTable({ name: "patients", columns: ["mrn", "code"], rowCount: 1 }, ["PATIENTS"]);
    expect(t.access).toBe("readable");
    expect(t.allowedByUser).toBe(true);
    // The reason it tripped is kept, so the status report can still say so.
    expect(t.identifiers[0].column).toBe("mrn");
  });

  it("does not let an allowance for one table leak to another", () => {
    const t = classifyTable({ name: "encounters", columns: ["mrn"], rowCount: 1 }, ["patients"]);
    expect(t.access).toBe("quarantined");
  });
});

describe("code-set identification", () => {
  it("recognises ICD-10-CM by shape", () => {
    expect(identifyCodeSet(["E11.65", "I10", "J45.909", "M54.50", "Z00.00"]).kind).toBe("icd10cm");
  });

  it("recognises HCPCS Level II and CPT separately", () => {
    expect(identifyCodeSet(["J1885", "E0114", "A0428", "G0008"]).kind).toBe("hcpcs");
    expect(identifyCodeSet(["99213", "99214", "93000", "36415"]).kind).toBe("cpt");
  });

  it("reports unknown rather than guessing at a mixed table", () => {
    const guess = identifyCodeSet(["99213", "E11.65", "widget-7", "Example Health Plan"]);
    expect(guess.kind).toBe("unknown");
    expect(guess.confidence).toBeLessThan(CODE_SHAPE_THRESHOLD);
  });

  it("says unknown for an empty sample instead of claiming a perfect match of nothing", () => {
    expect(identifyCodeSet([]).kind).toBe("unknown");
    expect(identifyCodeSet(["", "  "]).kind).toBe("unknown");
  });
});

describe("catalogue over a real file", () => {
  it("introspects tables, quarantines the patient table, and samples only cleared ones", () => {
    const cat = readCatalogue(dbFile);
    expect(cat.tables.map((t) => t.name).sort()).toEqual(["codes", "patients", "payers"]);
    const codes = findTable(cat, "codes")!;
    expect(codes.access).toBe("readable");
    expect(codes.rowCount).toBe(5);
    expect(codes.codeSet?.kind).toBe("icd10cm");
    const patients = findTable(cat, "patients")!;
    expect(patients.access).toBe("quarantined");
    // Never sampled — sampling is what the gate prevents.
    expect(patients.codeSet).toBeUndefined();
  });

  it("opens read-only: a write fails at the driver, not by our declining to try", () => {
    const db = openDatabase(dbFile, { readonly: true });
    try {
      expect(() => db.exec("INSERT INTO codes VALUES ('X00','x')")).toThrow(/readonly|read-only/i);
    } finally {
      db.close();
    }
    // And the file is genuinely unchanged.
    expect(readCatalogue(dbFile).tables.find((t) => t.name === "codes")!.rowCount).toBe(5);
  });

  it("reports which tables are held back and why", () => {
    const text = describeCatalogue(readCatalogue(dbFile));
    expect(text).toMatch(/Held back/);
    expect(text).toMatch(/patients/);
    expect(text).toMatch(/medical record number/);
    expect(text).toMatch(/referenceDbAllowTables/);
    expect(text).toMatch(/read-only/);
  });

  it("raises the CPT licence question rather than quietly serving descriptors", () => {
    const cat: ReferenceCatalogue = {
      path: "/tmp/x.db",
      driver: "node:sqlite",
      sizeBytes: 1,
      tables: [
        {
          name: "cpt_codes",
          columns: ["code", "description"],
          rowCount: 10,
          access: "readable",
          identifiers: [],
          codeColumn: "code",
          descriptionColumn: "description",
          codeSet: { kind: "cpt", label: "CPT (Level I)", confidence: 1 },
        },
      ],
    };
    expect(describeCatalogue(cat)).toMatch(/AMA-licensed/);
  });
});

describe("tools", () => {
  const ctx = (healthcare: Record<string, unknown>) =>
    ({ services: { config: { healthcare } } }) as never;

  beforeAll(() => resetCatalogueCache());

  it("says nothing is attached rather than erroring when unconfigured", async () => {
    resetCatalogueCache();
    const out = await referenceDbStatusTool.execute({}, ctx({}));
    expect(out.content).toMatch(/No reference database is configured/);
  });

  it("names a configured-but-missing file instead of reporting no database", async () => {
    resetCatalogueCache();
    const out = await referenceDbStatusTool.execute({}, ctx({ referenceDbPath: path.join(dir, "nope.db") }));
    expect(out.content).toMatch(/not found/);
  });

  it("looks a code up and names the file and table it came from", async () => {
    resetCatalogueCache();
    const out = await referenceLookupTool.execute({ table: "codes", code: "E11.65" }, ctx({ referenceDbPath: dbFile }));
    expect(out.content).toMatch(/hyperglycemia/);
    expect(out.content).toMatch(/codes/);
    expect(out.content).toContain(dbFile);
  });

  it("refuses to query a quarantined table and says how to allow it", async () => {
    resetCatalogueCache();
    const out = await referenceLookupTool.execute({ table: "patients", text: "Rivera" }, ctx({ referenceDbPath: dbFile }));
    expect(out.content).toMatch(/held back/);
    expect(out.content).not.toMatch(/Rivera/);
    expect(out.content).toMatch(/referenceDbAllowTables/);
  });

  it("searches descriptions and supports prefix search on codes", async () => {
    resetCatalogueCache();
    const cfg = ctx({ referenceDbPath: dbFile });
    const text = await referenceLookupTool.execute({ table: "codes", text: "diabetes" }, cfg);
    expect(text.content).toMatch(/E11.65/);
    expect(text.content).toMatch(/E11.9/);
    const prefix = await referenceLookupTool.execute({ table: "codes", code: "E11", prefix: true }, cfg);
    expect(prefix.content).toMatch(/2 rows/);
  });

  it("names the tables that exist when asked for one that does not", async () => {
    resetCatalogueCache();
    const out = await referenceLookupTool.execute({ table: "widgets", code: "X" }, ctx({ referenceDbPath: dbFile }));
    expect(out.content).toMatch(/codes, patients, payers/);
  });

  it("picks up a file swapped underneath a running process", () => {
    resetCatalogueCache();
    const swap = path.join(dir, "swap.db");
    const a = openDatabase(swap);
    a.exec("CREATE TABLE one (code TEXT)");
    a.close();
    expect((catalogueFor({ referenceDbPath: swap }) as ReferenceCatalogue).tables.map((t) => t.name)).toEqual(["one"]);
    fs.rmSync(swap);
    const b = openDatabase(swap);
    b.exec("CREATE TABLE two (code TEXT)");
    b.close();
    expect((catalogueFor({ referenceDbPath: swap }) as ReferenceCatalogue).tables.map((t) => t.name)).toEqual(["two"]);
  });
});

describe("dataset inventory", () => {
  it("reports the reference database in the same list as the CMS files", () => {
    expect(renderDatasetStatus([], false)).toMatch(/not set.*reference DB/s);
    expect(renderDatasetStatus([], false, "/data/beacon.db")).toMatch(/attached.*beacon\.db/s);
  });
});

describe("rendering", () => {
  it("says no match rather than printing an empty list", () => {
    const table = classifyTable({ name: "codes", columns: ["code", "description"], rowCount: 1 });
    expect(renderLookup(table, [], "/tmp/x.db")).toMatch(/No match in codes/);
  });
});
