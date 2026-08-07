// Minimal X12 EDI layer: segment tokenizer/serializer with ISA/GS/ST envelopes.
// Element separator '*', segment terminator '~', component separator ':'.

export interface Segment {
  id: string;
  elements: string[]; // elements[0] is the first element AFTER the segment ID
}

export function parseX12(text: string): Segment[] {
  const clean = text.replace(/\r?\n/g, "").trim();
  if (!clean.startsWith("ISA")) throw new Error("not an X12 interchange (missing ISA)");
  // ISA is fixed-length; element separator is char 3, segment terminator char 105.
  const elemSep = clean[3];
  const segTerm = clean[105] ?? "~";
  return clean
    .split(segTerm)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const parts = s.split(elemSep);
      return { id: parts[0], elements: parts.slice(1) };
    });
}

export function serializeX12(segments: Segment[]): string {
  return segments.map((s) => [s.id, ...s.elements].join("*") + "~").join("\n");
}

export function seg(id: string, ...elements: string[]): Segment {
  return { id, elements };
}

/** Split an X12 composite element on its component separator. */
export function composite(element: string | undefined): string[] {
  return (element ?? "").split(":");
}

/**
 * Base procedure code from an X12 procedure composite. SVC/SVD store the
 * qualifier and modifiers alongside the code ("HC:99214:25"), and 835 parsing
 * keeps the code-plus-modifier tail ("99214:25") — both reduce to "99214".
 */
export function baseProcedureCode(procedure: string): string {
  return (procedureParts(procedure).code ?? "").trim().toUpperCase();
}

/** The modifiers trailing a procedure composite, with the qualifier and code removed. */
export function procedureModifiers(procedure: string): string[] {
  return procedureParts(procedure).modifiers;
}

function procedureParts(procedure: string): { code: string; modifiers: string[] } {
  const parts = composite(procedure).filter((p) => p.length > 0);
  const withoutQualifier = parts[0] === "HC" || parts[0] === "AD" || parts[0] === "ER" ? parts.slice(1) : parts;
  return {
    code: withoutQualifier[0] ?? "",
    modifiers: withoutQualifier.slice(1).map((m) => m.trim().toUpperCase()),
  };
}

export function envelope(opts: {
  senderId: string;
  receiverId: string;
  controlNumber: string;
  functionalCode: string; // HC=claim, HB=eligibility response, HP=payment
  transactionSetId: string; // 837, 835, 270, 271
  date: string; // YYMMDD
  time: string; // HHMM
  body: Segment[];
}): Segment[] {
  const { senderId, receiverId, controlNumber, functionalCode, transactionSetId, date, time, body } = opts;
  const isa = seg(
    "ISA",
    "00",
    "          ",
    "00",
    "          ",
    "ZZ",
    senderId.padEnd(15),
    "ZZ",
    receiverId.padEnd(15),
    date,
    time,
    "^",
    "00501",
    controlNumber.padStart(9, "0"),
    "0",
    "T",
    ":",
  );
  const gs = seg("GS", functionalCode, senderId, receiverId, `20${date}`, time, controlNumber, "X", "005010X222A1");
  const st = seg("ST", transactionSetId, controlNumber.padStart(4, "0"));
  const se = seg("SE", String(body.length + 2), controlNumber.padStart(4, "0"));
  const ge = seg("GE", "1", controlNumber);
  const iea = seg("IEA", "1", controlNumber.padStart(9, "0"));
  return [isa, gs, st, ...body, se, ge, iea];
}
