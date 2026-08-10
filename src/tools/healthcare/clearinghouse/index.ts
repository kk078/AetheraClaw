import type { Config } from "../../../config/config.js";
import { readEnv } from "../../../config/legacy.js";
import { MockConnector } from "./mock.js";
import { StediConnector } from "./stedi.js";
import type { ClearinghouseConnector, ClearinghouseEnv } from "./types.js";

export * from "./types.js";
export { MockConnector } from "./mock.js";
export { StediConnector, parseStediEligibility } from "./stedi.js";

// ── Choosing a connector ─────────────────────────────────────────────────────
//
// Mock is the default and every path back to it is short. The rules here are
// the ones that decide whether a practice's claims go anywhere, so they are
// deliberately boring and loud.

export interface ConnectorChoice {
  connector: ClearinghouseConnector;
  /** Said at startup. Never silent — which network a deployment talks to is not a detail. */
  note: string;
}

export function getConnector(config: Config): ConnectorChoice {
  const name = (config.healthcare.clearinghouse ?? "mock").toLowerCase();
  const environment: ClearinghouseEnv =
    config.healthcare.clearinghouseEnv === "production" ? "production" : "sandbox";

  if (name === "mock") {
    return {
      connector: new MockConnector(),
      note: "Clearinghouse: mock — nothing leaves this machine. Every result is marked simulated.",
    };
  }

  if (name === "stedi") {
    // From the environment, never from config.json5. A config file is
    // committed, shared, and pasted into issues.
    // The bare name, matching how provider keys are read (ANTHROPIC_API_KEY and
    // friends) rather than the ORION_-prefixed settings. This is a vendor's
    // variable name, not one of ours to rename.
    const apiKey = (process.env.STEDI_API_KEY ?? readEnv("STEDI_API_KEY") ?? "").trim();
    if (apiKey === "") {
      // Falling back to mock rather than throwing: a missing key is a
      // configuration gap, and taking the whole gateway down for it would be a
      // worse outcome than running with no payer connection. But it is stated
      // in the strongest terms available, because a deployment that believes it
      // is talking to a clearinghouse and is not will file nothing and notice
      // in a month.
      return {
        connector: new MockConnector(),
        note:
          'Clearinghouse: MOCK — "stedi" was configured but STEDI_API_KEY is not set, so nothing can ' +
          "reach a payer. Set that variable, or set clearinghouse to \"mock\" so the configuration says " +
          "what is actually happening.",
      };
    }
    return {
      connector: new StediConnector({ apiKey, environment }),
      note:
        environment === "production"
          ? "Clearinghouse: STEDI, PRODUCTION. Eligibility checks and claims go to REAL PAYERS."
          : "Clearinghouse: Stedi sandbox. Eligibility is live against the test network; claim status, " +
            "submission and ERA are not available on the sandbox plan and will refuse.",
    };
  }

  return {
    connector: new MockConnector(),
    note: `Clearinghouse: mock — "${name}" is not a connector this build knows. Nothing leaves this machine.`,
  };
}
