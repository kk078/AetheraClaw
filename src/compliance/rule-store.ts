import type { MemoryStore } from "../memory/store.js";
import type { PolicyRule } from "./rule-dsl.js";

// DB-facing half of the rule set, kept separate from tools.ts so the scrub can
// load accepted rules without pulling in the sentinel — which audits claims by
// running the scrub, and would otherwise close an import cycle.

export interface RuleRow {
  id: string;
  kind: string;
  codes_json: string;
  diagnoses_json: string;
  modifiers_json: string;
  pos_json: string;
  max_units: number;
  period: string;
  severity: string;
  message: string;
  payer: string;
  status: string;
  source_document: string;
  source_citation: string;
  source_quote: string;
  source_effective: string;
  source_url: string;
}

export function toRule(row: RuleRow): PolicyRule {
  return {
    id: row.id,
    kind: row.kind as PolicyRule["kind"],
    codes: JSON.parse(row.codes_json) as string[],
    diagnoses: JSON.parse(row.diagnoses_json) as string[],
    modifiers: JSON.parse(row.modifiers_json) as string[],
    placesOfService: JSON.parse(row.pos_json) as string[],
    maxUnits: row.max_units,
    period: row.period as PolicyRule["period"],
    severity: row.severity as PolicyRule["severity"],
    message: row.message,
    payer: row.payer,
    status: row.status as PolicyRule["status"],
    source: {
      document: row.source_document,
      citation: row.source_citation,
      quote: row.source_quote,
      effective: row.source_effective,
      url: row.source_url,
    },
  };
}

/** Only accepted rules. A draft never reaches a claim. */
export function loadActiveRules(store: MemoryStore): PolicyRule[] {
  return (store.db.prepare("SELECT * FROM policy_rules WHERE status = 'active'").all() as RuleRow[]).map(toRule);
}
