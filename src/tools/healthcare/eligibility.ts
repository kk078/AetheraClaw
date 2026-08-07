import { z } from "zod";
import { defineTool } from "../registry.js";

export interface EligibilityRequest {
  payer_id: string;
  subscriber_id: string;
  patient_last: string;
  patient_first: string;
  patient_dob: string;
  service_type?: string;
}

export interface EligibilityResponse {
  active: boolean;
  planName: string;
  copay?: number;
  coinsurancePct?: number;
  deductible?: { total: number; remaining: number };
  notes: string[];
}

// Pluggable seam for real clearinghouses (Availity, Claim.MD, Office Ally, …).
export interface ClearinghouseConnector {
  readonly name: string;
  checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse>;
}

// v1 ships a mock connector with clearly-labeled canned responses so the whole
// eligibility workflow is testable end-to-end without a payer connection.
export class MockConnector implements ClearinghouseConnector {
  readonly name = "mock";
  async checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse> {
    const seed = [...req.subscriber_id].reduce((a, c) => a + c.charCodeAt(0), 0);
    const active = seed % 7 !== 0;
    return {
      active,
      planName: `MOCK PLAN ${req.payer_id}`,
      copay: active ? [0, 20, 30, 40][seed % 4] : undefined,
      coinsurancePct: active ? [0, 10, 20][seed % 3] : undefined,
      deductible: active ? { total: 1500, remaining: (seed * 37) % 1500 } : undefined,
      notes: [
        "MOCK RESPONSE — no real payer connection is configured.",
        active ? "Coverage active (simulated)." : "Coverage inactive/terminated (simulated).",
      ],
    };
  }
}

export function getConnector(name: string): ClearinghouseConnector {
  // Future: switch on config (availity, claimmd, …).
  void name;
  return new MockConnector();
}

export const eligibilityCheckTool = defineTool({
  name: "eligibility_check",
  description:
    "Run a 270/271-style eligibility check through the configured clearinghouse connector (v1: mock connector with simulated responses — clearly labeled). Use synthetic/test member data only.",
  schema: z.object({
    payer_id: z.string(),
    subscriber_id: z.string(),
    patient_last: z.string(),
    patient_first: z.string(),
    patient_dob: z.string().describe("YYYYMMDD"),
    service_type: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    const cfg = ctx.services.config as { healthcare?: { clearinghouse?: string } } | undefined;
    const connector = getConnector(cfg?.healthcare?.clearinghouse ?? "mock");
    const res = await connector.checkEligibility(input);
    const lines = [
      `Connector: ${connector.name}`,
      `Active: ${res.active ? "YES" : "NO"}`,
      `Plan: ${res.planName}`,
      ...(res.copay !== undefined ? [`Copay: $${res.copay}`] : []),
      ...(res.coinsurancePct !== undefined ? [`Coinsurance: ${res.coinsurancePct}%`] : []),
      ...(res.deductible ? [`Deductible: $${res.deductible.remaining} remaining of $${res.deductible.total}`] : []),
      ...res.notes,
    ];
    return { content: lines.join("\n") };
  },
});
