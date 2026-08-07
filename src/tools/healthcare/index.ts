import type { Config } from "../../config/config.js";
import type { MemoryStore } from "../../memory/store.js";
import type { ToolRegistry } from "../registry.js";
import { icd10SearchTool, icd10ValidateTool } from "./icd10.js";
import { npiLookupTool, npiSearchTool, npiValidateTool } from "./npi.js";
import { coverageSearchLocalTool, coverageSearchNationalTool, macLookupTool, sadExclusionTool } from "./coverage.js";
import { denialExplainTool } from "./denial-codes.js";
import { claimBuild837Tool } from "./x12/837.js";
import { eraParse835Tool } from "./x12/835.js";
import { ackParse277caTool } from "./x12/277ca.js";
import { claimBuildSecondaryTool, cobBalanceCheckTool } from "./x12/837-cob.js";
import { cobDeterminePrimaryTool } from "./cob.js";
import { claimScrubTool } from "./claim-scrub.js";
import { hcpcsLookupTool } from "./datasets.js";
import { eligibilityCheckTool } from "./eligibility.js";
import { worklistAddTool, worklistListTool, worklistUpdateTool } from "./worklist.js";
import { emCalculateTool } from "./em-calculator.js";
import { abnGenerateTool, appealDraftTool } from "./appeals.js";
import { analyticsQueryTool } from "./analytics.js";
import { claimGauntletTool, payerTwinTool, twinCalibrateTool } from "./twin.js";
import { telehealthCheckTool, telehealthPolicySetTool } from "./compliance/telehealth.js";
import { globalPeriodCheckTool, globalPeriodRecordTool } from "./compliance/global-period.js";
import { incidentToCheckTool } from "./compliance/incident-to.js";
import {
  auditListTool,
  auditResponseDraftTool,
  auditTrackTool,
  auditUpdateTool,
  deadlineCalculatorTool,
} from "./audit/audit-tracker.js";
import { emBenchmarkTool } from "./audit/em-benchmark.js";
import {
  credentialingCheckTool,
  credentialingListTool,
  credentialingTrackTool,
  eraExportTool,
  gfeDeadlineTool,
  gfeGenerateTool,
  gfeVarianceTool,
  superbillBuildTool,
} from "./operations/tools.js";
import {
  denialRiskTool,
  filingProofRecordTool,
  filingSweepTool,
  timelyFilingExceptionTool,
  timelyFilingSetTool,
  timelyFilingTool,
  worklistPrioritizeTool,
} from "./prediction/tools.js";
import {
  feeScheduleDriftTool,
  paymentVarianceTool,
  reimbursementEstimateTool,
} from "./intelligence/tools.js";
import {
  codeSetRegisterTool,
  codeUpdateCalendarTool,
  codeUpdateDiffTool,
  policyWatchTool,
} from "./updates/tools.js";
import {
  creditBalanceAddTool,
  creditBalanceDetectTool,
  creditBalanceListTool,
  creditBalanceResolveTool,
} from "./audit/credit-balance.js";

export function registerHealthcareTools(
  registry: ToolRegistry,
  _services: { config: Config; store: MemoryStore },
): void {
  registry.registerAll([
    // Coding & validation
    icd10SearchTool,
    icd10ValidateTool,
    hcpcsLookupTool,
    npiValidateTool,
    npiLookupTool,
    npiSearchTool,
    // Coverage & medical necessity
    coverageSearchNationalTool,
    coverageSearchLocalTool,
    macLookupTool,
    sadExclusionTool,
    // Claims lifecycle
    claimScrubTool,
    claimBuild837Tool,
    eraParse835Tool,
    ackParse277caTool,
    denialExplainTool,
    reimbursementEstimateTool,
    // Claim intelligence
    paymentVarianceTool,
    feeScheduleDriftTool,
    // Secondary claims & coordination of benefits
    cobDeterminePrimaryTool,
    cobBalanceCheckTool,
    claimBuildSecondaryTool,
    // Eligibility & worklists
    eligibilityCheckTool,
    worklistAddTool,
    worklistListTool,
    worklistUpdateTool,
    worklistPrioritizeTool,
    // Denial prediction & filing deadlines
    denialRiskTool,
    timelyFilingTool,
    timelyFilingSetTool,
    timelyFilingExceptionTool,
    filingProofRecordTool,
    filingSweepTool,
    // Practice operations
    credentialingTrackTool,
    credentialingListTool,
    credentialingCheckTool,
    superbillBuildTool,
    eraExportTool,
    gfeDeadlineTool,
    gfeGenerateTool,
    gfeVarianceTool,
    // Compliance rule pack
    telehealthCheckTool,
    telehealthPolicySetTool,
    globalPeriodCheckTool,
    globalPeriodRecordTool,
    incidentToCheckTool,
    // Assistants
    emCalculateTool,
    appealDraftTool,
    abnGenerateTool,
    // Audit & integrity
    auditTrackTool,
    auditListTool,
    auditUpdateTool,
    auditResponseDraftTool,
    deadlineCalculatorTool,
    emBenchmarkTool,
    creditBalanceDetectTool,
    creditBalanceAddTool,
    creditBalanceListTool,
    creditBalanceResolveTool,
    // Code & policy currency
    codeUpdateCalendarTool,
    codeSetRegisterTool,
    codeUpdateDiffTool,
    policyWatchTool,
    // Analytics
    analyticsQueryTool,
    // Flagship: adversarial payer twin
    payerTwinTool,
    claimGauntletTool,
    twinCalibrateTool,
  ]);
}
