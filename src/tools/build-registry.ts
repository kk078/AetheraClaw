import path from "node:path";
import type { Config } from "../config/config.js";
import { MemoryStore } from "../memory/store.js";
import { ToolRegistry } from "../tools/registry.js";
import { META_TOOLS } from "../tools/meta.js";
import { createShellTool } from "../tools/shell.js";
import { listDirTool, readFileTool, writeFileTool } from "../tools/fs.js";
import { webFetchTool, webSearchFallbackTool } from "../tools/web-fetch.js";
import { registerHealthcareTools } from "../tools/healthcare/index.js";
import {
  emailDraftTool,
  emailIngestTool,
  emailListTool,
  emailPollTool,
  emailRouteTool,
  emailSendTool,
} from "../channels/email/tools.js";
import { reportGenerateTool } from "../reports/tools.js";
import {
  policyCompileTool,
  policyRuleAddTool,
  policyRuleListTool,
  policyRuleReviewTool,
  policyRuleTestTool,
  sentinelHistoryTool,
  sentinelRunTool,
} from "../compliance/tools.js";
import { auditAnchorTool, auditLogTool, auditRecordTool, auditVerifyTool } from "../audit/tools.js";
import {
  idrEvaluateTool,
  idrTrackTool,
  negotiationBriefTool,
  rateBenchmarkTool,
  rateIngestTool,
  ratePositionTool,
} from "../transparency/tools.js";
import {
  dtrAnswerTool,
  dtrPrefillTool,
  dtrQuestionnaireAddTool,
  paRequirementCheckTool,
  paResponseRecordTool,
  paRuleSetTool,
  paRulesLearnTool,
  paStatusTool,
  paSubmitTool,
} from "../fhir/tools.js";
import {
  a2aAttestTool,
  a2aKeySetupTool,
  a2aOpenTool,
  a2aReconcileTool,
  a2aSendTool,
  a2aShowTool,
  a2aVerifyTool,
} from "../a2a/tools.js";
import {
  cdiAnalyzeTool,
  cdiQueryDraftTool,
  cdiQueryFromFindingTool,
  cdiQueryListTool,
  cdiQueryRespondTool,
  cdiRuleAddTool,
  greenlightCheckTool,
} from "../cdi/tools.js";
import {
  trainingAnswerTool,
  trainingCaseAddTool,
  trainingDrillTool,
  trainingProgressTool,
} from "../training/tools.js";
import {
  hccRecaptureTool,
  qualityMeasuresTool,
  rafCalculateTool,
  suspectConditionsTool,
  suspectListTool,
  suspectReviewTool,
} from "../vbc/tools.js";
import {
  callEndTool,
  callHistoryTool,
  callListenTool,
  callNavigateTool,
  callPolicyTool,
  callPressTool,
  callSayTool,
  callStartTool,
  callTranscriptTool,
  ivrMapListTool,
  ivrMapSetTool,
} from "../voice/tools.js";
import {
  cashForecastTool,
  forecastChartTool,
  forecastHistoryTool,
  patientBalanceAddTool,
  patientLetterTool,
  patientOutreachTool,
  revenueModelFitTool,
  simulateScenarioTool,
} from "../simulation/tools.js";
import {
  swarmAdvanceTool,
  swarmBoardTool,
  swarmFailTool,
  swarmHistoryTool,
  swarmPipelineTool,
  swarmPlanTool,
  swarmTrackTool,
} from "../swarm/tools.js";
import {
  portalAuditTool,
  portalClickTool,
  portalCloseTool,
  portalFieldsTool,
  portalFillTool,
  portalListTool,
  portalLoginTool,
  portalNavigateTool,
  portalReadTool,
  portalScreenshotTool,
} from "../tools/browser/tools.js";
import { TENANCY_TOOLS } from "../tenancy/tools.js";
import { OPS_TOOLS } from "../ops/tools.js";
import { SUPPORT_TOOLS } from "../support/tools.js";
import { MAIL_OPS_TOOLS } from "../channels/email/ops-tools.js";
import { kpiDashboardTool } from "../reports/kpi-tools.js";
import { contractRateListTool, contractRateSetTool } from "../tools/healthcare/intelligence/contract-tools.js";

export function buildRegistry(config: Config, store: MemoryStore): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createShellTool(config.shell));
  registry.registerAll([readFileTool, writeFileTool, listDirTool, webFetchTool]);
  registry.registerAll(META_TOOLS);
  if (config.provider !== "anthropic") registry.register(webSearchFallbackTool);
  registerHealthcareTools(registry, { config, store });
  registry.registerAll([
    emailPollTool,
    emailListTool,
    emailRouteTool,
    emailDraftTool,
    emailSendTool,
    emailIngestTool,
    reportGenerateTool,
    portalListTool,
    portalLoginTool,
    portalNavigateTool,
    portalReadTool,
    portalFieldsTool,
    portalFillTool,
    portalClickTool,
    portalScreenshotTool,
    portalCloseTool,
    portalAuditTool,
    swarmTrackTool,
    swarmBoardTool,
    swarmPlanTool,
    swarmAdvanceTool,
    swarmFailTool,
    swarmHistoryTool,
    swarmPipelineTool,
    policyCompileTool,
    policyRuleAddTool,
    policyRuleListTool,
    policyRuleReviewTool,
    policyRuleTestTool,
    sentinelRunTool,
    sentinelHistoryTool,
    auditRecordTool,
    auditVerifyTool,
    auditAnchorTool,
    auditLogTool,
    revenueModelFitTool,
    cashForecastTool,
    simulateScenarioTool,
    forecastChartTool,
    forecastHistoryTool,
    patientBalanceAddTool,
    patientOutreachTool,
    patientLetterTool,
    callPolicyTool,
    callStartTool,
    callListenTool,
    callSayTool,
    callPressTool,
    callNavigateTool,
    callEndTool,
    callTranscriptTool,
    callHistoryTool,
    ivrMapSetTool,
    ivrMapListTool,
    rafCalculateTool,
    hccRecaptureTool,
    suspectConditionsTool,
    suspectListTool,
    suspectReviewTool,
    qualityMeasuresTool,
    rateIngestTool,
    rateBenchmarkTool,
    ratePositionTool,
    negotiationBriefTool,
    idrEvaluateTool,
    idrTrackTool,
    paRequirementCheckTool,
    paRuleSetTool,
    paRulesLearnTool,
    dtrQuestionnaireAddTool,
    dtrPrefillTool,
    dtrAnswerTool,
    paSubmitTool,
    paStatusTool,
    paResponseRecordTool,
    a2aKeySetupTool,
    a2aAttestTool,
    a2aVerifyTool,
    a2aOpenTool,
    a2aSendTool,
    a2aShowTool,
    a2aReconcileTool,
    cdiRuleAddTool,
    cdiAnalyzeTool,
    cdiQueryDraftTool,
    cdiQueryFromFindingTool,
    cdiQueryListTool,
    cdiQueryRespondTool,
    greenlightCheckTool,
    trainingCaseAddTool,
    trainingDrillTool,
    trainingAnswerTool,
    trainingProgressTool,
    ...TENANCY_TOOLS,
    ...OPS_TOOLS,
    ...SUPPORT_TOOLS,
    ...MAIL_OPS_TOOLS,
    kpiDashboardTool,
    contractRateSetTool,
    contractRateListTool,
  ]);
  return registry;
}
