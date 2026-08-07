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
