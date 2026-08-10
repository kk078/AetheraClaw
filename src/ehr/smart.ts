import {
  bundleResources,
  parseCoverage,
  parseEncounter,
  parsePatient,
  type EhrConnector,
  type EhrCoverage,
  type EhrEncounter,
  type EhrEnv,
  type EhrPatient,
} from "./connector.js";

// ── One reference implementation, against a server that can be called ────────
//
// SMART on FHIR R4, read-only, aimed at the public HAPI test server by default.
// HAPI is chosen precisely because it is reachable without a procurement
// process: the mapping can be exercised for real rather than written from a
// specification and hoped over.
//
// AUTHENTICATION is a bearer token supplied by the caller, and this build does
// not implement the SMART launch dance — no authorization code flow, no
// refresh, no launch context. That is deliberate rather than unfinished: the
// launch flow is meaningless without a client id issued by a specific hospital,
// and writing it against the spec would produce code nobody can run. When a real
// EHR is in scope, the flow belongs here and the interface above does not have
// to change, which is the whole point of a seam.
//
// The public HAPI server holds SYNTHETIC data and no PHI. Pointing this at a
// real EHR is a decision with a BAA behind it, and the connector says which
// server it is talking to on every result so that decision is never invisible.

const DEFAULT_BASE = "https://hapi.fhir.org/baseR4";

export interface SmartOptions {
  baseUrl?: string;
  /** Bearer token. Empty is legal against an open test server and nowhere else. */
  accessToken?: string;
  environment?: EhrEnv;
  fetchImpl?: typeof fetch;
}

export class SmartEhrConnector implements EhrConnector {
  readonly name = "smart-fhir";
  readonly environment: EhrEnv;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SmartOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.token = opts.accessToken ?? "";
    this.environment = opts.environment ?? "sandbox";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get(pathAndQuery: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
      headers: {
        accept: "application/fhir+json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Throwing rather than returning empty. An empty result and a failed
      // request are opposite facts — "this patient has no coverage on file" and
      // "we could not ask" lead to opposite actions, which is the same
      // distinction EligibilityRejection exists to preserve on the payer side.
      throw new Error(
        `FHIR ${pathAndQuery} returned HTTP ${res.status} from ${this.baseUrl}. Nothing was read, so this says ` +
          `nothing about what the chart contains. ${body.slice(0, 200)}`,
      );
    }
    return res.json();
  }

  /**
   * Find a patient by MRN or by a system|value identifier.
   *
   * No name search — see the header of connector.ts. A demographic query
   * against a hospital's server returns other people's records, and no billing
   * question needs one.
   */
  async findPatient(identifier: string): Promise<EhrPatient | null> {
    const id = identifier.trim();
    if (id === "") return null;
    const bundle = await this.get(`/Patient?identifier=${encodeURIComponent(id)}&_count=2`);
    const matches = bundleResources(bundle, "Patient");
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      // Refusing rather than taking the first. Two patients sharing an
      // identifier is a data-quality problem at the source, and silently
      // picking one attaches a claim to whichever the server happened to sort
      // first — a coin flip nobody knows was tossed.
      throw new Error(
        `More than one patient matches identifier "${id}" on ${this.baseUrl}. Refusing to guess which — that choice ` +
          "would decide whose chart a claim is built from. Resolve the duplicate at the source.",
      );
    }
    return parsePatient(matches[0]);
  }

  async coverages(patientId: string): Promise<EhrCoverage[]> {
    const bundle = await this.get(`/Coverage?patient=${encodeURIComponent(patientId)}&_count=20`);
    return bundleResources(bundle, "Coverage").map(parseCoverage);
  }

  async encounters(patientId: string, sinceYmd: string): Promise<EhrEncounter[]> {
    const since = /^\d{8}$/.test(sinceYmd)
      ? `&date=ge${sinceYmd.slice(0, 4)}-${sinceYmd.slice(4, 6)}-${sinceYmd.slice(6, 8)}`
      : "";
    const bundle = await this.get(`/Encounter?patient=${encodeURIComponent(patientId)}${since}&_count=50`);
    return bundleResources(bundle, "Encounter").map(parseEncounter);
  }
}

export interface EhrChoice {
  connector: EhrConnector | null;
  /** Said at startup and on every tool result. Which chart a deployment reads is never a detail. */
  note: string;
}

/**
 * Pick a connector.
 *
 * Returns NULL rather than a mock when nothing is configured. There is no demo
 * EHR in this build, deliberately: a fabricated chart is worse here than
 * anywhere else in the product, because a chart is what everything else defers
 * to. A tool with no connector says it has none.
 */
export function getEhrConnector(config: {
  ehr?: { connector?: string; baseUrl?: string; environment?: string };
}): EhrChoice {
  const name = (config.ehr?.connector ?? "none").toLowerCase();
  if (name === "none" || name === "") {
    return {
      connector: null,
      note: "EHR: none configured. Chart lookups are unavailable, and no chart data is being invented in their place.",
    };
  }
  if (name === "smart" || name === "smart-fhir" || name === "hapi") {
    const environment: EhrEnv = config.ehr?.environment === "production" ? "production" : "sandbox";
    const baseUrl = config.ehr?.baseUrl ?? DEFAULT_BASE;
    const token = (process.env.EHR_ACCESS_TOKEN ?? "").trim();
    return {
      connector: new SmartEhrConnector({ baseUrl, accessToken: token, environment }),
      note:
        environment === "production"
          ? `EHR: SMART on FHIR against ${baseUrl}, PRODUCTION. This reads a REAL clinical record.`
          : `EHR: SMART on FHIR against ${baseUrl} (sandbox). Read-only; nothing is ever written to a chart.`,
    };
  }
  return {
    connector: null,
    note: `EHR: "${name}" is not a connector this build knows. Chart lookups are unavailable.`,
  };
}
