import { AGING_LABELS, type PracticeReport } from "./aggregate.js";

// Rendering is deliberately CSV and Markdown rather than a spreadsheet binary:
// both open in Excel, both diff in git, and neither needs a dependency that has
// to be trusted with the practice's financial data.

export function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  return [header.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function arAgingCsv(report: PracticeReport): string {
  return toCsv(
    ["claimId", "payer", "serviceDate", "ageDays", "bucket", "charge", "status"],
    report.ar.rows.map((r) => [r.claimId, r.payer, r.serviceDate, r.ageDays, r.bucket, r.charge, r.status]),
  );
}

export function denialsCsv(report: PracticeReport): string {
  return toCsv(
    ["carc", "description", "category", "occurrences", "amount"],
    report.denials.byCarc.map((r) => [r.carc, r.description, r.category, r.count, r.amount]),
  );
}

export function productionCsv(report: PracticeReport): string {
  return toCsv(
    ["period", "claims", "lines", "charges"],
    report.production.rows.map((r) => [r.period, r.claims, r.lines, r.charges]),
  );
}

/**
 * The summary a practice manager reads, in the order the questions get asked:
 * what did we bill, what is still out and how old, and why are claims denying.
 */
export function summaryMarkdown(report: PracticeReport, title = "Practice report"): string {
  const { ar, denials, production } = report;
  const stamp = new Date(report.generatedAt).toISOString().slice(0, 10);
  const lines: string[] = [`# ${title}`, "", `Generated ${stamp} from locally stored claims and remittances.`, ""];

  lines.push(
    "## Production",
    "",
    `${production.totalClaims} claim(s), ${money(production.totalCharges)} charged.`,
    "",
  );
  if (production.rows.length > 0) {
    lines.push("| Period | Claims | Lines | Charges |", "| --- | ---: | ---: | ---: |");
    for (const r of production.rows) lines.push(`| ${r.period} | ${r.claims} | ${r.lines} | ${money(r.charges)} |`);
    lines.push("");
  }
  if (production.byProcedure.length > 0) {
    lines.push("Top procedures by charges:", "");
    lines.push("| Code | Units | Charges |", "| --- | ---: | ---: |");
    for (const p of production.byProcedure.slice(0, 10)) lines.push(`| ${p.code} | ${p.count} | ${money(p.charges)} |`);
    lines.push("");
  }

  lines.push(
    "## Accounts receivable",
    "",
    ar.rows.length === 0
      ? "Nothing outstanding: every recorded claim has a remittance against it."
      : `${ar.rows.length} claim(s) outstanding, ${money(ar.total)}, weighted average age ${ar.averageAgeDays} days.`,
    "",
  );
  if (ar.rows.length > 0) {
    lines.push("| Age | Claims | Amount | Share |", "| --- | ---: | ---: | ---: |");
    for (const label of AGING_LABELS) {
      const b = ar.byBucket[label];
      lines.push(`| ${label} | ${b.count} | ${money(b.amount)} | ${ar.total > 0 ? pct(b.amount / ar.total) : "—"} |`);
    }
    lines.push("");
    const stale = ar.byBucket["91-120"].amount + ar.byBucket["120+"].amount;
    if (stale > 0) {
      lines.push(
        `${money(stale)} is over 90 days old. Past a payer's filing window an unbilled claim is unrecoverable, so check these against timely_filing_sweep before working anything newer.`,
        "",
      );
    }
    lines.push("By payer:", "", "| Payer | Claims | Amount | Oldest |", "| --- | ---: | ---: | ---: |");
    for (const p of ar.byPayer.slice(0, 10)) {
      lines.push(`| ${p.payer} | ${p.count} | ${money(p.amount)} | ${p.oldestDays}d |`);
    }
    lines.push("");
  }

  lines.push("## Denials", "");
  if (denials.lines === 0) {
    lines.push("No remittances parsed yet — parse 835 files with era_parse_835 for this section to mean anything.", "");
  } else {
    lines.push(
      `${denials.deniedLines} of ${denials.lines} adjudicated line(s) denied (${pct(denials.denialRate)}). ` +
        `${money(denials.charged)} charged, ${money(denials.paid)} paid.`,
      "",
      "Ranked by dollars rather than by count — a frequent small edit is rarely the expensive problem:",
      "",
      "| CARC | Reason | Category | Times | Amount |",
      "| --- | --- | --- | ---: | ---: |",
    );
    for (const r of denials.byCarc.slice(0, 15)) {
      lines.push(`| ${r.carc} | ${r.description} | ${r.category} | ${r.count} | ${money(r.amount)} |`);
    }
    lines.push("");
    if (denials.byPayer.length > 0) {
      lines.push("| Payer | Lines | Denied | Rate | Denied charges |", "| --- | ---: | ---: | ---: | ---: |");
      for (const p of denials.byPayer.slice(0, 10)) {
        lines.push(`| ${p.payer} | ${p.lines} | ${p.denied} | ${pct(p.rate)} | ${money(p.amount)} |`);
      }
      lines.push("");
    }
  }

  lines.push(
    "---",
    "",
    "Computed from what this instance has stored: claims recorded at build time and remittances that have been parsed. Claims submitted outside AetheraClaw, or remittances never parsed, are not in these numbers.",
  );
  return lines.join("\n");
}
