import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ExtensionAPI, type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { LOG_PREFIX, type PiModel, asRecord, getErrorCode, isNonEmptyString } from "./src/common.ts";
import { FIX_RECEIPT_FILE_NAME, FIX_RECEIPT_PATH, MODELS_JSON_PATH, STATE_DIR } from "./src/paths.ts";
import { type FixSuggestion } from "./src/fix-types.ts";
import { deepEqualIgnoringKeys, findExistingCompatKeysInJsonc, locateModelOverrideInJsonc, locateProviderCompatInJsonc, parseJsonc, stripJsoncComments, stripJsoncTrailingCommas } from "./src/jsonc.ts";
import { atomicCreateTextFileNoReplace, atomicReplaceTextFilePreservingMode, atomicRestoreFileFromBackup, backupTimestamp, hashText } from "./src/atomic-fs.ts";
import { getAssistantMessageModelTokenValues, getModelIdNameTokenValues, isAdaptiveGenerationModel, isKimiCodingAdaptiveModel } from "./src/model-detect.ts";
import { findLastExactModelDefinition, mergeCacheCompat, resolveEffectiveCompatFromConfig } from "./src/compat-config.ts";
import { analyzeModelsJsonForMissingEntry, applyModelsJsonFixTransaction, chooseFixPlacement, composeFixInsertion, composeMissingEntryInsertion, composeModelOverrideInsertion, composeModelsJsonReceiptRollback, composeProviderAffinityInsertion, createModelsJsonFixReceipt, createRollbackBackupPath, decideFixPlacement, formatCompatKeysForInsertion, hasExplicitLongRetentionOptInFromConfig, hasReceiptReasoningProtocolChange, isActionableModelsJsonFixReceipt, locateModelInJsonc, markModelsJsonFixReceiptRolledBack, parseModelsJsonFixReceipt, prepareModelsJsonRollback, readModelsJsonFixReceipt, readModelsJsonFixReceiptSnapshot, receiptBackupPath, resolveExplicitCompatValue, selfCheckFix, selfCheckMissingEntryInsertion, validateModelsJsonRollback, writeModelsJsonFixReceipt } from "./src/models-json-fix.ts";
import { ARCHIVE_ABANDONED_ACTIVE_MS, SHARD_ARCHIVE_PATH, isArchivableShard, type StatsSnapshot, aggregateEpochKeys, aggregateStatsWithArchiveSync, aggregateStatsWithArchiveV7, readStatsArchiveForRefresh, compactStatsShardsV7, encodeStatsArchiveV2, listStatsArchiveGenerations, maybeRunStatsMaintenance, parseStatsArchiveV2, readStatsArchive, readStatsArchiveDetailed, readStatsArchiveView, readStatsSnapshot, setStatsArchiveTestHooks, StatsArchiveView, statsArchiveGenerationPath } from "./src/stats-archive.ts";
import { type CacheProviderId, type CacheStats, LEGACY_STATE_FILE_PATH, acquireStatsMaintenanceLock, isMaintenanceMarkerDue, renameWithRetry, setStatsFsTestHooks, holdsStatsMaintenanceLock, releaseStatsMaintenanceLock, touchStatsMaintenanceLock, type PersistedRoutedModelRef, type PersistedStatsShardV7, SHARD_FILES_DIR, SHARD_GLOBAL_EPOCH_PATH, SHARD_RETENTION_MS, SHARD_STATE_DIR, STATE_FILE_PATH, type ShardAggregate, type UsageSnapshot, addUsageToCacheStats, advanceGlobalStatsEpoch, advanceModelStatsEpoch, aggregateStatsShardsV7, cleanupStatsShardsV7, cloneCacheStats, mapWithConcurrency, currentLocalDay, emptyAllCacheStats, emptyCacheStats, initialEpoch, loadStatsShardAggregateV7, modelEpochPath, parseCacheStats, parsePersistedRoutedModelRef, parsePersistedStatsShardV7, readGlobalStatsEpoch, readModelStatsEpoch, readValidStatsShardsV7, removeLegacyStatsFiles, writeStatsShardV7, type ShardEpochs, readEpochFileResult, readEpochFileWithRetry, createShardAggregatorSync, SHARD_FILE_NAME_PATTERN } from "./src/stats-store.ts";
import { STATS_FULL_SCAN_INTERVAL_MS, StatsRefreshScheduler, type StatsWatchHandle, createFsShardWatch, TieredShardIndex, getStatsRefreshTestHooks, setStatsRefreshTestHooks } from "./src/stats-refresh.ts";
import { countingStatsReadFs, setStatsReadFsForTests, statsReadFs } from "./src/stats-fs.ts";
import { PI_VIRTUAL_MODEL_API, getCompat, isAnthropicMessagesApi, isKimiCodingEmptySignatureModel, isKnownThirdPartyOpenAIEndpoint, isMistralConversationsApi, isNativeVirtualModel, isOfficialOpenAIBaseUrl, isOpenAICompatibleApi, isOpenAICompatibleProxyApi, isOpenAIFamilyAssistantMessage, isOpenAIFamilyModel, isOpenAIFamilyToken, isPiBuiltInLlamaCppModel, isResponsesPromptRewriteBypassApi, isRoutedFallbackModel, isValidModelsConfigForEffectiveCompat, modelKey, readEffectiveCompatConfig } from "./src/model-identity.ts";
import { STATS_INCREMENTAL_ENV, STATS_TIMING_ENV, STATS_VERIFY_ENV, isStatsIncrementalEnabled, isStatsVerifyEnabled, statsTimingLogPath } from "./src/config.ts";
import { CONFIG_FILE_PATH, VIRTUAL_REWRITE_ENV, FOOTER_MODE_ENV, TOOL_ORDER_ENV, featureEnabled, footerStatsMode, isEnabledEnv, isToolOrderEnabled, parseFooterStatsMode, parsePersistedCacheOptimizerConfig, readPersistedCacheOptimizerConfig, resolveFooterStatsMode, runtimeOptimizerEnabled, setPersistedCacheOptimizerConfig, shouldInjectOpenAIPromptCacheKey, writePersistedCacheOptimizerConfig, writePersistedFeature, writePersistedFooterMode } from "./src/config.ts";
import { decideZeroPriceWarming, readCacheWarmingMode } from "./src/cache-warming.ts";
import { LONG_CACHE_RETENTION_VALUE, PI_CACHE_RETENTION_BASELINE_SYMBOL, PI_CACHE_RETENTION_ENV, STARTUP_CACHE_RETENTION_ENV, captureCacheRetentionEnv, getOrCaptureCacheRetentionBaseline, decidePromptCacheRetention, recordPromptCacheRetentionDecision, requestLongCacheRetention, restoreCacheRetentionEnv, userRequestedLongCacheRetention } from "./src/retention.ts";
import { isRuntimeOptimizerEnabled, isZeroPriceWarmingEnabled, setRuntimeOptimizerEnabled } from "./src/config.ts";
import { compareToolOrderEntries, getToolNameForPayload, isKnownToolOrderApi, isToolOrderingEligibleModel, isVerifiedToolForApi, normalizeToolsInPayload, sortToolsInPayload } from "./src/tool-ordering.ts";
import { SKILL_COMPRESSION_MIN_COUNT, SKILL_PATH_RULE_WORDINGS, compressSkillsInSystemPrompt, compressSkillsViaSection, formatSkillsForPrompt, formatSkillsForPromptCompressed, stripSessionOverviewChurn, explainSkillCompressionSkip, recordSkillCompressionOutcome, getLastSkillCompressionOutcome, describeSkillCompressionOutcome } from "./src/prompt-rewrite.ts";
import { addEffectiveSessionAffinityHeaders, addOpenAIPromptCacheKey, clampPromptCacheKey, collectAnthropicCacheControlsInWireOrder, downgradeAnthropicLongCacheControls, getEffectiveCompatValueSource, hasAnthropicCacheTtlOrderError, hasEffectivePromptCacheKey, isPromptCacheKeyOmittedForModel, normalizeAnthropicCacheControlTtlOrder, omitOpenAIPromptCacheKeys, shouldInjectOpenAIPromptCacheKeyForModel, withAnthropicCacheTtlRepair, withoutPromptCacheRetention, derivePromptCacheKey } from "./src/request-payload.ts";
import { PI_CACHE_HINTS_SYMBOL, PI_ROUTING_REGISTRY_SYMBOL, type PiCacheHintsInput, type PiCacheHintsOutput, applyConfiguredTransportToModel, canRewriteNativeVirtualPrompt, describeNativeVirtualRouteNote, ensureRoutingRegistry, findModelInRegistry, findNativeVirtualDispatches, getProtocolGlobal, getProviderPayloadModelId, getRoutingRegistry, hashSessionId, installCacheHintsService, nativeVirtualDispatchFromMessage, nativeVirtualDispatchToModel, parseRouteSnapshot, resolveActiveRouteSnapshot, resolveNativeVirtualRequestModel, resolveNativeVirtualRouteModel, resolveRouteModel, routeSnapshotToPiModel, sessionHashFromContext } from "./src/routing.ts";
import { CONFIG_RECEIPT_PATH, applyPromptCacheKeyConfigFix, configReceiptBackupPath, parsePromptCacheKeyConfigReceipt, rollbackPromptCacheKeyConfig, writePromptCacheKeyConfigReceipt } from "./src/prompt-cache-key-config.ts";
import { buildDeepSeekCompatSuggestion, buildDeepSeekCompatWarningText, buildModelCompatOverride, buildOpenAIProxyCompatWarningText, buildProviderCompatOverride, buildSafeOpenAIProxyCompatSuggestion, describeMissingAdaptiveThinkingCompat, describeMissingCacheCompatForModel, describeMissingDeepSeekCompat, describeMissingOpenAICompatibleProxyCompat, getAgentDirDisplayPath, getModelsJsonDisplayPath, isAdaptiveThinkingCompatApplicable, isDeepSeekWireCompatApplicable } from "./src/compat-advice.ts";
import { type CacheProviderAdapter, isVirtualRoutingModel, modelFromAssistantMessage, selectAdapterForAssistantMessage, selectAdapterForModel } from "./src/adapters.ts";
import { describeMissingOpenAIFamilyProxyCompat } from "./src/compat-advice.ts";
import { type CacheUsageSample, buildAllStatsOutput, buildContributorsStatsOutput, buildSessionStatsOutput, buildStatsOutput, deriveTotalsByModelFromSessionStats, filterRestorableStatsForSession, formatCacheStats, formatCompactStats, formatHitRatio, formatRecentTrendSummary, formatTokenM, hasMissingUsageFields, makeSessionModelKey, mergeCacheSessions, mergeCacheTotals, mergeLastRoutedModels, modelKeyFromSessionKey, parsePersistedCacheStats, parsePersistedTotalsByModel, prefixFooterStatus, readPersistedCacheStats, routedModelRefToPiModel, selectFooterStatsForModel, writePersistedCacheStats } from "./src/stats-report.ts";
import { appendAdaptiveThinkingCompatAdviceLines, buildAdaptiveThinkingCompatSuggestion, buildCompatDiagnosis, buildDoctorDiagnosis, buildFixSuggestion, buildLowHitDiagnosis, describeOptionalOpenAICompatibleProxyCompat, describeRouterChannelDiagnostics, getCompatCheckNotApplicableLines, getPromptCacheRetentionUnsupportedHint, isCompatCheckApplicable, isDeepSeekCompatCheckApplicable, isOpenAISdkHeader403Applicable, isPromptCacheKeyUnsupportedApplicable, isPromptCacheRetention400Applicable, isSessionAffinity403Applicable } from "./src/diagnostics.ts";
import { REASONING_PROTOCOL_FALLBACK_SYMBOL, buildReasoningProtocolFixSuggestion, getAnthropicTtlFallbackState, getReasoningProtocolFallbackState, hasExplicitDeepSeekReasoningProtocol, hasPromptCacheKeyUnsupportedErrorMessage, hasPromptCacheKeyUnsupportedText, hasPromptCacheRetentionUnsupportedErrorMessage, hasReasoningProtocolRejectionErrorMessage, hasReasoningProtocolRejectionText, isExplicitPromptCacheRetentionUnsupportedApplicable, isReasoningProtocolRejectionForModel, isReasoningProtocolRejectionSignalApplicable, mergeFixSuggestions, notifyReasoningProtocolObservation } from "./src/provider-errors.ts";
import { hasPromptCacheKeyUnsupportedSignal, hasPromptCacheRetentionUnsupportedSignal, hasReasoningProtocolRejectionSignal } from "./src/provider-errors.ts";
import { MAX_RECENT_SAMPLES, buildExactRouterStatusEntry, consolidateDirectProviderStatsModel, createSerializedAsyncRunner, findBestRouterModelStats, keyForModelExt } from "./src/stats-report.ts";
import { type PiCacheHintSnapshot, getCacheHintsService, getSessionPromptCacheKey, isOptimizerOwnedCacheHintsService, markOptimizerOwnedCacheHintsService } from "./src/routing.ts";
import { isActionablePromptCacheKeyConfigReceipt, readPromptCacheKeyConfigReceipt, readPromptCacheKeyConfigReceiptSnapshot } from "./src/prompt-cache-key-config.ts";
import { formatOptimizerRuntimeMode, getOptimizerRuntimeModeLines, readPersistedFooterMode } from "./src/config.ts";
import { getCacheOptimizerArgumentCompletions } from "./src/command-completion.ts";
import { MAX_PROVIDER_REQUEST_STATES, pruneProviderRequestStates, snapshotProviderRequestModel } from "./src/request-state.ts";
import { NO_PROMPT_REWRITE_ENV } from "./src/config.ts";
import { createCacheOptimizerCommandHandler } from "./src/command.ts";
import { type ProviderRequestState } from "./src/request-state.ts";

const STATUS_KEY = "pi-cache-stats";

function buildAdaptiveThinkingCompatWarningText(key: string, missing: string[]): string {
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;
  const modelsJsonPath = getModelsJsonDisplayPath();
  const lines: string[] = [
    `💡 pi-cache-optimizer: ${key} is an adaptive-generation model but merged compat lacks ${missing.join(" and ")}.`,
    `Without the required compat, Pi may send legacy thinking or replay thinking blocks incorrectly.`,
    `Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (at the same level as baseUrl/api/apiKey/models).`,
    "",
  ];
  appendAdaptiveThinkingCompatAdviceLines(lines, missing, { providerLabel, modelId });
  return lines.join("\n");
}

function notifyCacheCompatIfNeeded(
  model: PiModel | undefined,
  ctx: ExtensionContext,
  warnedModels: Set<string>,
): void {
  if (!model) return;

  // A protocol rejection is retained separately from ordinary compat warnings;
  // it is surfaced once by the response hook and can be used by a later fix.
  // Do not turn it into an automatic write here.

  // Native anthropic-messages adaptive thinking compat check.
  // Adapter warningText only fires for OpenAI-compatible APIs, so native
  // Anthropic and Kimi Coding adaptive models need a separate check.
  if (isAdaptiveThinkingCompatApplicable(model)) {
    const missing = describeMissingAdaptiveThinkingCompat(model);
    if (missing.length > 0) {
      const key = `adaptive-thinking:${modelKey(model)}`;
      if (!warnedModels.has(key)) {
        warnedModels.add(key);
        ctx.ui.notify(buildAdaptiveThinkingCompatWarningText(modelKey(model), missing), "warning");
      }
    }
    // Still check adapter warnings for other compat issues.
  }

  const adapter = selectAdapterForModel(model);
  const text = adapter?.warningText?.(model);
  if (!adapter || !text) return;

  const affinityOnly = adapter.warningText !== undefined &&
    describeMissingOpenAICompatibleProxyCompat(model).length === 1 &&
    describeMissingCacheCompatForModel(model).length === 1;
  const key = affinityOnly
    ? `proxy-affinity:${model.provider}`
    : `${adapter.id}:${modelKey(model)}`;
  if (warnedModels.has(key)) return;
  warnedModels.add(key);

  ctx.ui.notify(text, "warning");
}

// Internal helpers exported only so the task verification script
// (.trellis/tasks/.../verify.ts) can exercise them. They are not part of the
// extension's public API; pi only invokes the default export below.
// Most recent background stats restore started by any extension instance in
// this module. Tests await it after session_start; runtime code uses the
// per-instance promise instead.
let latestStatsRestoreForTests: Promise<void> = Promise.resolve();
/** Per extension instance in this module: resolves once no footer refresh (or its publish) is in flight. */
const statsRefreshSettledForTests = new Set<() => Promise<void>>();

export const __internals_for_tests = {
  waitForStatsRestore: (): Promise<void> => latestStatsRestoreForTests,
  /**
   * Footer refreshes after tool_execution_end, agent_settled and message_end
   * no longer hold up Pi's handlers (2.10). Tests await this before
   * asserting on what such a refresh publishes.
   */
  statsRefreshSettled: async (): Promise<void> => {
    for (const settled of statsRefreshSettledForTests) await settled();
  },
  setStatsRefreshTestHooks,
  setStatsReadFsForTests,
  countingStatsReadFs,
  TieredShardIndex,
  StatsRefreshScheduler,
  createFsShardWatch,
  aggregateStatsWithArchiveSync,
  aggregateEpochKeys,
  createShardAggregatorSync,
  readStatsArchiveForRefresh,
  readEpochFileResult,
  isStatsIncrementalEnabled,
  statsTimingLogPath,
  STATS_INCREMENTAL_ENV,
  STATS_TIMING_ENV,
  STATS_VERIFY_ENV,
  isStatsVerifyEnabled,
  getLastSkillCompressionOutcome,
  decidePromptCacheRetention,
  userRequestedLongCacheRetention,
  derivePromptCacheKey,
  withAnthropicCacheTtlRepair,
  withoutPromptCacheRetention,
  describeSkillCompressionOutcome,
  stripSessionOverviewChurn,
  formatSkillsForPrompt,
  formatSkillsForPromptCompressed,
  compressSkillsInSystemPrompt,
  SKILL_COMPRESSION_MIN_COUNT,
  SKILL_PATH_RULE_WORDINGS,
  compressSkillsViaSection,
  explainSkillCompressionSkip,
  NO_PROMPT_REWRITE_ENV,
  isEnabledEnv,
  featureEnabled,
  writePersistedFeature,
  // OpenAI-family cache-key helpers
  addOpenAIPromptCacheKey,
  clampPromptCacheKey,
  hasEffectivePromptCacheKey,
  omitOpenAIPromptCacheKeys,
  isPromptCacheKeyOmittedForModel,
  isNonEmptyString,
  shouldInjectOpenAIPromptCacheKey,
  shouldInjectOpenAIPromptCacheKeyForModel,
  isOpenAICompatibleApi,
  isAnthropicMessagesApi,
  isOpenAICompatibleProxyApi,
  collectAnthropicCacheControlsInWireOrder,
  downgradeAnthropicLongCacheControls,
  hasAnthropicCacheTtlOrderError,
  normalizeAnthropicCacheControlTtlOrder,
  isPiBuiltInLlamaCppModel,
  isResponsesPromptRewriteBypassApi,
  canRewriteNativeVirtualPrompt,
  VIRTUAL_REWRITE_ENV,
  isMistralConversationsApi,
  isOpenAIFamilyModel,
  isOpenAIFamilyAssistantMessage,
  isOpenAIFamilyToken,
  describeMissingOpenAIFamilyProxyCompat,
  describeMissingOpenAICompatibleProxyCompat,
  describeOptionalOpenAICompatibleProxyCompat,
  describeMissingDeepSeekCompat,
  isDeepSeekWireCompatApplicable,
  isDeepSeekCompatCheckApplicable,
  hasExplicitDeepSeekReasoningProtocol,
  describeMissingCacheCompatForModel,
  buildDeepSeekCompatSuggestion,
  buildDeepSeekCompatWarningText,
  buildSafeOpenAIProxyCompatSuggestion,
  getPromptCacheRetentionUnsupportedHint,
  isOfficialOpenAIBaseUrl,
  isKnownThirdPartyOpenAIEndpoint,
  isCompatCheckApplicable,
  isPromptCacheRetention400Applicable,
  isSessionAffinity403Applicable,
  isOpenAISdkHeader403Applicable,
  hasPromptCacheRetentionUnsupportedSignal,
  hasPromptCacheRetentionUnsupportedErrorMessage,
  hasPromptCacheKeyUnsupportedText,
  hasPromptCacheKeyUnsupportedSignal,
  hasPromptCacheKeyUnsupportedErrorMessage,
  isPromptCacheKeyUnsupportedApplicable,
  hasReasoningProtocolRejectionText,
  hasReasoningProtocolRejectionSignal,
  hasReasoningProtocolRejectionErrorMessage,
  isReasoningProtocolRejectionSignalApplicable,
  isReasoningProtocolRejectionForModel,
  buildReasoningProtocolFixSuggestion,
  // Non-GPT OpenAI-compatible model detection
  // Additional OpenAI-compatible model detection
  // More OpenAI-compatible model detection (batch 2)
  // New OpenAI-compatible model detection (batch 3, 12 families)
  // More OpenAI-compatible model detection (batch 4, 18 families)
  selectAdapterForModel,
  selectAdapterForAssistantMessage,
  buildOpenAIProxyCompatWarningText,
  getModelIdNameTokenValues,
  getAssistantMessageModelTokenValues,
  mergeCacheCompat,
  resolveEffectiveCompatFromConfig,
  getEffectiveCompatValueSource,
  findLastExactModelDefinition,
  isValidModelsConfigForEffectiveCompat,
  addEffectiveSessionAffinityHeaders,
  getCompat,
  isKnownToolOrderApi,
  getToolNameForPayload,
  compareToolOrderEntries,
  isVerifiedToolForApi,
  normalizeToolsInPayload,
  sortToolsInPayload,
  modelKey,
  modelFromAssistantMessage,
  consolidateDirectProviderStatsModel,
  // Platform-friendly path helpers
  getAgentDirDisplayPath,
  getModelsJsonDisplayPath,
  buildProviderCompatOverride,
  buildModelCompatOverride,
  captureCacheRetentionEnv,
  requestLongCacheRetention,
  restoreCacheRetentionEnv,
  setRuntimeOptimizerEnabled,
  isRuntimeOptimizerEnabled,
  getOptimizerRuntimeModeLines,
  formatOptimizerRuntimeMode,
  PI_CACHE_RETENTION_ENV,
  LONG_CACHE_RETENTION_VALUE,
  TOOL_ORDER_ENV,
  isToolOrderEnabled,
  // Integrity diagnostics
  // Diagnostic command helpers
  buildDoctorDiagnosis,
  buildCompatDiagnosis,
  describeRouterChannelDiagnostics,
  // Cache stats helpers (module-level, usable from verify script)
  addUsageToCacheStats,
  formatCacheStats,
  prefixFooterStatus,
  getCacheOptimizerArgumentCompletions,
  emptyCacheStats,
  emptyAllCacheStats,
  parseCacheStats,
  parsePersistedCacheStats,
  deriveTotalsByModelFromSessionStats,
  parsePersistedTotalsByModel,
  // Recent sample / stats output / diagnosis helpers
  MAX_RECENT_SAMPLES,
  buildStatsOutput,
  buildSessionStatsOutput,
  buildAllStatsOutput,
  buildContributorsStatsOutput,
  formatCompactStats,
  buildLowHitDiagnosis,
  formatRecentTrendSummary,
  formatHitRatio,
  formatTokenM,
  hasMissingUsageFields,
  keyForModelExt,
  // Session-scoped helpers
  hashSessionId,
  makeSessionModelKey,
  modelKeyFromSessionKey,
  filterRestorableStatsForSession,
  parsePersistedRoutedModelRef,
  routedModelRefToPiModel,
  buildExactRouterStatusEntry,
  findBestRouterModelStats,
  selectFooterStatsForModel,
  parseFooterStatsMode,
  parsePersistedCacheOptimizerConfig,
  readPersistedCacheOptimizerConfig,
  writePersistedCacheOptimizerConfig,
  readPersistedFooterMode,
  writePersistedFooterMode,
  setPersistedCacheOptimizerConfig,
  resolveFooterStatsMode,
  footerStatsMode,
  CONFIG_FILE_PATH,
  CONFIG_RECEIPT_PATH,
  parsePromptCacheKeyConfigReceipt,
  isActionablePromptCacheKeyConfigReceipt,
  readPromptCacheKeyConfigReceipt,
  readPromptCacheKeyConfigReceiptSnapshot,
  writePromptCacheKeyConfigReceipt,
  applyPromptCacheKeyConfigFix,
  rollbackPromptCacheKeyConfig,
  configReceiptBackupPath,
  FOOTER_MODE_ENV,
  // Routing-provider protocol helpers
  PI_ROUTING_REGISTRY_SYMBOL,
  PI_CACHE_HINTS_SYMBOL,
  REASONING_PROTOCOL_FALLBACK_SYMBOL,
  ensureRoutingRegistry,
  getRoutingRegistry,
  parseRouteSnapshot,
  resolveActiveRouteSnapshot,
  routeSnapshotToPiModel,
  isRoutedFallbackModel,
  applyConfiguredTransportToModel,
  resolveRouteModel,
  isVirtualRoutingModel,
  PI_VIRTUAL_MODEL_API,
  isNativeVirtualModel,
  findNativeVirtualDispatches,
  resolveNativeVirtualRouteModel,
  resolveNativeVirtualRequestModel,
  getProviderPayloadModelId,
  getCompatCheckNotApplicableLines,
  describeNativeVirtualRouteNote,
  pruneProviderRequestStates,
  MAX_PROVIDER_REQUEST_STATES,
  installCacheHintsService,
  getCacheHintsService,
  markOptimizerOwnedCacheHintsService,
  isOptimizerOwnedCacheHintsService,
  getOrCaptureCacheRetentionBaseline,
  PI_CACHE_RETENTION_BASELINE_SYMBOL,
  // Persistence helpers (for reload/reset tests)
  mergeCacheSessions,
  mergeCacheTotals,
  mergeLastRoutedModels,
  createSerializedAsyncRunner,
  writePersistedCacheStats,
  readPersistedCacheStats,
  parsePersistedStatsShardV7,
  writeStatsShardV7,
  readValidStatsShardsV7,
  aggregateStatsShardsV7,
  loadStatsShardAggregateV7,
  cleanupStatsShardsV7,
  compactStatsShardsV7,
  maybeRunStatsMaintenance,
  readStatsArchive,
  readStatsArchiveView,
  readStatsArchiveDetailed,
  readStatsSnapshot,
  setStatsArchiveTestHooks,
  setStatsFsTestHooks,
  renameWithRetry,
  isArchivableShard,
  isMaintenanceMarkerDue,
  aggregateStatsWithArchiveV7,
  encodeStatsArchiveV2,
  parseStatsArchiveV2,
  listStatsArchiveGenerations,
  statsArchiveGenerationPath,
  StatsArchiveView,
  touchStatsMaintenanceLock,
  acquireStatsMaintenanceLock,
  holdsStatsMaintenanceLock,
  releaseStatsMaintenanceLock,
  SHARD_ARCHIVE_PATH,
  SHARD_RETENTION_MS,
  mapWithConcurrency,
  removeLegacyStatsFiles,
  readGlobalStatsEpoch,
  readModelStatsEpoch,
  advanceGlobalStatsEpoch,
  advanceModelStatsEpoch,
  modelEpochPath,
  STATE_FILE_PATH,
  LEGACY_STATE_FILE_PATH,
  SHARD_STATE_DIR,
  FIX_RECEIPT_FILE_NAME,
  FIX_RECEIPT_PATH,
  SHARD_FILES_DIR,
  SHARD_GLOBAL_EPOCH_PATH,
  STATE_DIR,
  // JSONC surgical edit helpers
  MODELS_JSON_PATH,
  stripJsoncComments,
  stripJsoncTrailingCommas,
  parseJsonc,
  resolveExplicitCompatValue,
  hasExplicitLongRetentionOptInFromConfig,
  locateModelInJsonc,
  locateModelOverrideInJsonc,
  locateProviderCompatInJsonc,
  composeFixInsertion,
  selfCheckFix,
  analyzeModelsJsonForMissingEntry,
  composeMissingEntryInsertion,
  composeModelOverrideInsertion,
  composeProviderAffinityInsertion,
  selfCheckMissingEntryInsertion,
  decideFixPlacement,
  chooseFixPlacement,
  findExistingCompatKeysInJsonc,
  deepEqualIgnoringKeys,
  formatCompatKeysForInsertion,
  backupTimestamp,
  atomicReplaceTextFilePreservingMode,
  atomicCreateTextFileNoReplace,
  atomicRestoreFileFromBackup,
  applyModelsJsonFixTransaction,
  hashText,
  parseModelsJsonFixReceipt,
  isActionableModelsJsonFixReceipt,
  hasReceiptReasoningProtocolChange,
  createRollbackBackupPath,
  createModelsJsonFixReceipt,
  writeModelsJsonFixReceipt,
  readModelsJsonFixReceipt,
  readModelsJsonFixReceiptSnapshot,
  markModelsJsonFixReceiptRolledBack,
  receiptBackupPath,
  composeModelsJsonReceiptRollback,
  validateModelsJsonRollback,
  prepareModelsJsonRollback,
  // Fix suggestion builder
  buildFixSuggestion,
  // Adaptive thinking compat helpers
  isAdaptiveGenerationModel,
  isKimiCodingAdaptiveModel,
  isKimiCodingEmptySignatureModel,
  isAdaptiveThinkingCompatApplicable,
  describeMissingAdaptiveThinkingCompat,
  buildAdaptiveThinkingCompatSuggestion,
  buildAdaptiveThinkingCompatWarningText,
  appendAdaptiveThinkingCompatAdviceLines,
};

export default function (pi: ExtensionAPI) {
  const warnedModels = new Set<string>();
  const promptCacheRetention400Models = new Set<string>();
  const warnedPromptCacheRetention400Models = new Set<string>();
  const anthropicTtlFallbackState = getAnthropicTtlFallbackState();
  const anthropicTtlOrderErrorModels = anthropicTtlFallbackState.modelKeys;
  const warnedAnthropicTtlOrderErrorModels = anthropicTtlFallbackState.warnedModelKeys;
  const sendSessionAffinityHeaders403Models = new Set<string>();
  const warnedSendSessionAffinityHeaders403Models = new Set<string>();
  const openAISdkHeader403Models = new Set<string>();
  const warnedOpenAISdkHeader403Models = new Set<string>();
  const reasoningProtocolFallbackState = getReasoningProtocolFallbackState();
  const reasoningProtocolRejectedModels = reasoningProtocolFallbackState.modelKeys;
  const warnedReasoningProtocolRejectedModels = reasoningProtocolFallbackState.warnedModelKeys;
  const promptCacheKeyRejectedModels = new Set<string>();
  const warnedPromptCacheKeyRejectedModels = new Set<string>();
  let cacheStatsByModel: Record<string, CacheStats> = {};
  let cacheStatsProcessByModel: Record<string, CacheStats> = {};
  let cacheStatsTotalsByModel: Record<string, CacheStats> = {};
  let cacheStatsLegacyFamily: Partial<Record<CacheProviderId, CacheStats>> = emptyAllCacheStats();
  let lastStatusText: string | undefined;
  let persistenceWarningShown = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let shardRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let shardWatcher: StatsWatchHandle | undefined;
  // Historical stats are restored in the background so a large shard
  // directory never holds up Pi's session_start (issue #28). Handlers that
  // read or persist aggregated stats await this first.
  let statsRestorePromise: Promise<void> = Promise.resolve();
  let statsRestoreGeneration = 0;
  async function waitForStatsRestore(): Promise<void> {
    // A session_start may chain a newer restore while we wait; keep waiting
    // until the chain is stable so callers never act on a half-restored view.
    let current: Promise<void>;
    do {
      current = statsRestorePromise;
      await current;
    } while (current !== statsRestorePromise);
  }
  const enqueuePersist = createSerializedAsyncRunner();
  let instanceId = randomUUID();
  const instanceStartedAt = Date.now();
  let instanceShardPath = join(SHARD_FILES_DIR, `${instanceId}.json`);
  let shardDay = currentLocalDay();
  let rolloverPromise: Promise<void> | undefined;
  // Failed day-close writes remain visible in memory until persisted or reload.
  const retiredShards = new Map<string, PersistedStatsShardV7>();
  const modelApiByKey = new Map<string, string>();
  const modelNameByKey = new Map<string, string>();
  const modelEpochByKey = new Map<string, string>();
  let currentGlobalEpoch = initialEpoch("global");
  let currentSessionId = "";
  let currentSessionHash = "";
  let currentSessionHashSet = false;
  let lastActualRoutedModel: PersistedRoutedModelRef | undefined;
  let latestCacheHint: PiCacheHintSnapshot | undefined;
  // Pi's response hooks do not expose a request id. Track one FIFO lifecycle
  // record per request and mark records when their response hook arrives. A
  // finalized assistant message consumes the oldest completed record, falling
  // back to the oldest request only when a transport emitted no response hook.
  // This preserves response A when request B/C starts before message_end(A).
  const providerRequestStates: ProviderRequestState[] = [];
  let shardCreatedAt = Date.now();
  const PERSIST_DEBOUNCE_MS = 2000;
  const SHARD_REFRESH_DEBOUNCE_MS = 250;

  function buildObservedRuntimeFixSuggestion(model: PiModel): FixSuggestion | undefined {
    const key = modelKey(model);
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;

    if (
      anthropicTtlOrderErrorModels.has(key) ||
      (isPromptCacheRetention400Applicable(model) && promptCacheRetention400Models.has(key))
    ) {
      return {
        providerLabel,
        modelId: model.id,
        compatKeys: { supportsLongCacheRetention: false },
        forceModelLevel: true,
      };
    }
    if (isSessionAffinity403Applicable(model) && sendSessionAffinityHeaders403Models.has(key)) {
      return {
        providerLabel,
        modelId: model.id,
        compatKeys: { sendSessionAffinityHeaders: false },
        forceModelLevel: true,
      };
    }
    return undefined;
  }

  function buildCommandFixSuggestion(model: PiModel): FixSuggestion | undefined {
    const regular = buildFixSuggestion(model);
    const observedReasoning = buildReasoningProtocolFixSuggestion(
      model,
      reasoningProtocolRejectedModels.has(modelKey(model)),
    );
    const observed = mergeFixSuggestions(
      buildObservedRuntimeFixSuggestion(model),
      observedReasoning,
    );
    if (!regular) return observed;
    if (!observed) return regular;
    return {
      providerLabel: regular.providerLabel,
      modelId: regular.modelId,
      compatKeys: { ...regular.compatKeys, ...observed.compatKeys },
      forceModelLevel: regular.forceModelLevel || observed.forceModelLevel,
    };
  }

  function promptCacheKeyFixApplies(model: PiModel): boolean {
    return isPromptCacheKeyUnsupportedApplicable(model) && promptCacheKeyRejectedModels.has(modelKey(model));
  }

  function buildPromptCacheKeyConfigPreview(model: PiModel): string[] {
    const key = modelKey(model);
    return [
      `Target: ${key}`,
      `Action: persist prompt_cache_key mode = omit in ${CONFIG_FILE_PATH}.`,
      "The final request body will omit both prompt_cache_key and promptCacheKey.",
      "This can reduce provider-side prompt-cache reuse for this model; it does not change prompts, credentials, headers, or other models.",
      "The setting applies after Pi core has built the payload, including when Pi already supplied a key.",
    ];
  }
  /** In-memory recent usage samples per model key (not persisted, cleared on reload). */
  const recentSamplesByModelKey = new Map<string, CacheUsageSample[]>();

  function syncSessionHash(ctx: Pick<ExtensionContext, "sessionManager">): void {
    const sid = ctx.sessionManager.getSessionId();
    if (sid && (sid !== currentSessionId || !currentSessionHashSet)) {
      currentSessionId = sid;
      currentSessionHash = hashSessionId(sid);
      currentSessionHashSet = true;
      lastActualRoutedModel = undefined;
    }
  }

  const uninstallCacheHintsService = installCacheHintsService(markOptimizerOwnedCacheHintsService({
    version: 1,
    getHints(input: PiCacheHintsInput): PiCacheHintsOutput | undefined {
      if (!runtimeOptimizerEnabled || !featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true)) return undefined;
      const hint = latestCacheHint;
      if (!hint) return undefined;
      if (input.sessionIdHash && hint.sessionIdHash && input.sessionIdHash !== hint.sessionIdHash) return undefined;
      if (input.virtualProvider && hint.virtualProvider && input.virtualProvider !== hint.virtualProvider) return undefined;
      if (input.virtualModelId && hint.virtualModelId && input.virtualModelId !== hint.virtualModelId) return undefined;
      if (input.upstreamProvider && hint.upstreamProvider && input.upstreamProvider !== hint.upstreamProvider) return undefined;
      if (input.upstreamModelId && hint.upstreamModelId && input.upstreamModelId !== hint.upstreamModelId) return undefined;
      if (input.api && hint.api && input.api !== hint.api) return undefined;

      return {
        systemPrompt: hint.systemPrompt,
        promptCacheKey: hint.promptCacheKey,
        cacheRetention: hint.cacheRetention,
      };
    },
  }), { discardPrevious: isOptimizerOwnedCacheHintsService });

  /**
   * Build a session-scoped stats key from the current session hash + model key.
   * Returns `${sessionHash}:${provider}/${id}`.
   */
  function sessionModelKey(model: { provider: string; id: string }): string {
    const hash = currentSessionHash || "_nosession";
    return `${hash}:${model.provider}/${model.id}`;
  }

  /**
   * Extract the user-facing model key from a session-scoped key.
   * "abc123:otokapi/gpt-5.5" → "otokapi/gpt-5.5"
   */
  function modelKeyFromSessionScoped(sKey: string): string {
    const idx = sKey.indexOf(":");
    return idx >= 0 ? sKey.slice(idx + 1) : sKey;
  }

  function recordRecentSample(modelKeyStr: string, usage: UsageSnapshot, missingUsageFields: boolean): void {
    let samples = recentSamplesByModelKey.get(modelKeyStr);
    if (!samples) {
      samples = [];
      recentSamplesByModelKey.set(modelKeyStr, samples);
    }
    samples.push({
      timestamp: Date.now(),
      hit: usage.cacheRead > 0,
      cachedInputTokens: usage.cacheRead,
      cacheWriteInputTokens: usage.cacheWrite,
      totalInputTokens: usage.totalInput,
      missingUsageFields,
    });
    if (samples.length > MAX_RECENT_SAMPLES) {
      samples.splice(0, samples.length - MAX_RECENT_SAMPLES);
    }
  }

  function getRecentSamples(modelKeyStr: string): CacheUsageSample[] {
    return recentSamplesByModelKey.get(modelKeyStr) ?? [];
  }

  function clearRecentSamples(): void {
    recentSamplesByModelKey.clear();
  }

  /**
   * Shards this instance persisted under its current id that compaction
   * could have absorbed: the latest one, plus each one that was followed by
   * a gap of at least ARCHIVE_ABANDONED_ACTIVE_MS (compaction only takes an
   * active shard nobody wrote for that long). Used when this live process's
   * own shard was absorbed anyway (see adoptAbsorbedOwnShard).
   */
  let persistedOwnShards: PersistedStatsShardV7[] = [];
  /**
   * Which lifetime of the in-memory counters a built shard snapshots: bumped
   * whenever session_start clears them (see adoptAbsorbedOwnShard).
   */
  let countersSession = 0;
  const countersSessionOfShard = new WeakMap<PersistedStatsShardV7, number>();
  function recordPersistedOwnShard(shard: PersistedStatsShardV7): void {
    if (shard.instanceId !== instanceId) return;
    const last = persistedOwnShards.at(-1);
    if (last && shard.lifecycle.updatedAt - last.lifecycle.updatedAt < ARCHIVE_ABANDONED_ACTIVE_MS) persistedOwnShards.pop();
    persistedOwnShards.push(shard);
  }

  /**
   * Compaction absorbed this live instance's active shard: its process looked
   * dead (a PID namespace the compactor cannot see: containers, WSL, a shared
   * NFS agent dir) and it had been idle for a day. The archive now counts the
   * version it read, which this instance must neither count again (as its
   * in-memory shard) nor keep writing to (a write to an absorbed id is
   * ignored and then deleted, losing the usage since). Continue under a new
   * id holding only what the archive does not have: the in-memory counters
   * minus the absorbed version, which is the newest persisted one dated at
   * least ARCHIVE_ABANDONED_ACTIVE_MS before the absorption.
   */
  function adoptAbsorbedOwnShard(absorbedAt: number): void {
    const candidates = persistedOwnShards.filter((shard) => shard.lifecycle.updatedAt <= absorbedAt - ARCHIVE_ABANDONED_ACTIVE_MS);
    // Not identifiable (clock skew between the processes): assume the
    // archive holds everything, so nothing is ever counted twice.
    const absorbed = candidates.at(-1) ?? buildCurrentStatsShard();
    // Session guard: subtract only a version built from the counters held
    // now. session_start clears them (switching to another session, or the
    // same one on reload) but keeps the id, so a version persisted before it
    // counts usage these counters no longer hold: subtracting it would hide
    // this session's usage. Its sessionHash alone cannot tell: a reload keeps
    // it, and it changes without a reset when the session id first becomes
    // known after usage (then the counters still hold that usage).
    const sameSession = countersSessionOfShard.get(absorbed) === countersSession;
    const remaining: Record<string, CacheStats> = {};
    for (const [key, stats] of Object.entries(cacheStatsProcessByModel)) {
      const entry = sameSession && absorbed.globalEpoch === currentGlobalEpoch ? absorbed.models[key] : undefined;
      const sameEpoch = entry && entry.modelEpoch === (modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`));
      const delta = cloneCacheStats(stats);
      if (sameEpoch) {
        delta.totalRequests = Math.max(0, stats.totalRequests - entry.stats.totalRequests);
        delta.hitRequests = Math.max(0, stats.hitRequests - entry.stats.hitRequests);
        delta.cachedInputTokens = Math.max(0, stats.cachedInputTokens - entry.stats.cachedInputTokens);
        delta.cacheWriteInputTokens = Math.max(0, stats.cacheWriteInputTokens - entry.stats.cacheWriteInputTokens);
        delta.totalInputTokens = Math.max(0, stats.totalInputTokens - entry.stats.totalInputTokens);
        delta.hitRequests = Math.min(delta.hitRequests, delta.totalRequests);
      }
      if (delta.totalRequests > 0 || delta.totalInputTokens > 0 || delta.cachedInputTokens > 0 || delta.cacheWriteInputTokens > 0) {
        remaining[key] = delta;
      }
    }
    cacheStatsProcessByModel = remaining;
    instanceId = randomUUID();
    instanceShardPath = join(SHARD_FILES_DIR, `${instanceId}.json`);
    shardCreatedAt = Date.now();
    persistedOwnShards = [];
    lastStatusText = undefined;
    // The new id keeps the old shard's day; the next status update rolls it
    // over as usual. Persist in the background (the aggregate below already
    // counts the in-memory shard). Once shutdown began (the refresh gate is
    // closed), never write an active shard: the flush closes this one.
    void persistCacheStats(undefined, refreshScheduler.isClosed ? "closed" : "active");
  }

  let lastStatsSnapshot: StatsSnapshot | undefined;

  // ── Epoch reads: one sequence, so a slow read never rolls back a newer one ──
  // Every footer epoch read (refresh, message_end, restore) takes a number
  // when it starts; local resets take one when they wrote. currentGlobalEpoch
  // and each modelEpochByKey entry remember the number of the read that set
  // them, and only a read that started later may change them. Without this a
  // refresh that read E1 before another process reset to E2 could, after
  // message_end already adopted E2 and recorded usage under it, switch back
  // to E1 and clear that usage.
  let epochReadSeq = 0;
  let globalEpochSeq = 0;
  /** Model epoch reads at or below this never set a model epoch (global change, session start, local reset). */
  let modelEpochFloorSeq = 0;
  const modelEpochSeq = new Map<string, number>();
  function nextEpochSeq(): number {
    return ++epochReadSeq;
  }
  /** Whether a global epoch read numbered `seq` may set currentGlobalEpoch (and records it when it may). */
  function acceptGlobalEpochRead(seq: number): boolean {
    if (seq <= globalEpochSeq) return false;
    globalEpochSeq = seq;
    return true;
  }
  function acceptModelEpochRead(seq: number, key: string): boolean {
    if (seq <= modelEpochFloorSeq || seq <= (modelEpochSeq.get(key) ?? 0)) return false;
    modelEpochSeq.set(key, seq);
    return true;
  }
  /**
   * acceptModelEpochRead for the read message_end labels new usage with. A
   * read the floor rejects (a newer read changed the global epoch, or a
   * session started, while it was in flight) is still the newest knowledge
   * of this key's epoch when nothing newer set the key: a global reset never
   * changes model epoch files, and voiding cleared what was known, not what
   * this read saw. Without it the usage is recorded with no model epoch,
   * that is the initial one, which every reader filters out when the model
   * was ever reset, and the next message_end then drops it.
   */
  function acceptModelEpochReadForUsage(seq: number, key: string): boolean {
    if (acceptModelEpochRead(seq, key)) return true;
    if (modelEpochByKey.has(key) || (modelEpochSeq.get(key) ?? 0) > seq) return false;
    modelEpochSeq.set(key, seq);
    return true;
  }
  /** Model epochs known so far are void (they were cleared): older reads must not set them again. */
  function voidModelEpochs(seq: number): void {
    modelEpochSeq.clear();
    modelEpochFloorSeq = Math.max(modelEpochFloorSeq, seq);
  }

  type EpochSnapshot = { seq: number; global: string; models: Map<string, string> };

  /** Read the global epoch and `keys` in parallel, once, for one refresh. Throws on a persistent I/O error. */
  async function readEpochSnapshot(keys: Iterable<string>): Promise<EpochSnapshot> {
    const seq = nextEpochSeq();
    const keyList = Array.from(keys);
    const results = await Promise.all([
      readEpochFileWithRetry(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global")),
      ...keyList.map((key) => readEpochFileWithRetry(modelEpochPath(key), initialEpoch(`model:${key}`))),
    ]);
    const epochs = results.map((result) => {
      if (!result.ok) throw result.error;
      return result.epoch;
    });
    return { seq, global: epochs[0]!, models: new Map(keyList.map((key, index) => [key, epochs[index + 1]!])) };
  }

  // ── Footer refresh: tiered index + single flight ──
  const fullScanIntervalMs = getStatsRefreshTestHooks().fullScanIntervalMs ?? STATS_FULL_SCAN_INTERVAL_MS;
  const shardIndex = new TieredShardIndex(SHARD_FILES_DIR, {
    freeze: getStatsRefreshTestHooks().freezeShards,
    fullScanIntervalMs,
  });
  /**
   * When the archive was last read in full (its newest generation lstat-ed
   * and its identity checked). Between such reads an unchanged clean
   * generation is confirmed by the listing alone; but a generation number is
   * only unique while the archive directory lives: if the stats directory is
   * deleted and another process compacts from scratch, a new generation 1
   * replaces the old one under the same name. So the identity is re-checked
   * on every full refresh and at least every full scan interval, which
   * bounds that case like a cold shard instead of until the next generation.
   */
  let archiveVerifiedAt = -Infinity;
  const refreshScheduler = new StatsRefreshScheduler<ShardAggregate>((full) => runStatsRefresh(full));
  /** Background refresh chains (and their publish) in flight; shutdown drains them. */
  const backgroundStatsTasks = new Set<Promise<void>>();
  let backgroundRefreshWarned = false;
  /** The context of the latest session_start, for refreshes no handler asked for (watcher, scans). */
  let latestStatsCtx: ExtensionContext | undefined;

  function trackBackgroundStatsTask(task: Promise<unknown>): void {
    const tracked = task.then(() => undefined, warnBackgroundRefreshOnce);
    backgroundStatsTasks.add(tracked);
    void tracked.then(() => backgroundStatsTasks.delete(tracked));
  }

  function warnBackgroundRefreshOnce(error: unknown): void {
    if (backgroundRefreshWarned) return;
    backgroundRefreshWarned = true;
    console.warn(`${LOG_PREFIX}: background footer stats refresh failed (further failures are not reported)`, error);
  }

  /**
   * The one entry point for refreshes Pi does not wait for (tool_execution_end,
   * agent_settled, message_end, the watcher, scans). Never rejects: every
   * failure, including a stale ctx after reload, is caught and warned once.
   * Publishes outside the refresh's critical section (a day rollover inside
   * publishStatus requests refreshes of its own), and not at all once the
   * gate closed or a newer session_start superseded this one.
   */
  function refreshAndPublishInBackground(ctx: ExtensionContext | undefined, pickModel?: () => PiModel | undefined): void {
    if (refreshScheduler.isClosed) return;
    const generation = statsRestoreGeneration;
    trackBackgroundStatsTask((async () => {
      await waitForStatsRestore();
      const aggregate = await refreshScheduler.background(false);
      if (aggregate === undefined || refreshScheduler.isClosed || generation !== statsRestoreGeneration || !ctx) return;
      ensureShardWatcher();
      await publishStatus(ctx, pickModel ? pickModel() : ctx.model);
    })());
  }

  /**
   * A refresh whose reads start after this call (see StatsRefreshScheduler).
   * `full` (default) stats every shard file: commands, doctor, flush and
   * restore. Lifecycle refreshes use the tiered index.
   */
  function refreshShardAggregate({ full = true }: { full?: boolean } = {}): Promise<ShardAggregate> {
    return refreshScheduler.request(full);
  }

  function startFullScanIfDue(): void {
    // The shutdown flush's own refreshes run with the gate closed: no new background scan then.
    if (refreshScheduler.isClosed) return;
    const scan = shardIndex.maybeStartFullScan(() => `${instanceId}.json`);
    if (!scan) return;
    trackBackgroundStatsTask(scan.then(async (changed) => {
      await checkShardWatcherDirectory();
      const mismatched = isStatsVerifyEnabled() && !refreshScheduler.isClosed
        ? await shardIndex.verifyCachedContents(`${instanceId}.json`)
        : [];
      noteStatsVerifyResult(mismatched);
      if (changed || mismatched.length > 0) refreshAndPublishInBackground(latestStatsCtx);
    }));
  }

  // PI_CACHE_OPTIMIZER_STATS_VERIFY: warn (once) when two verifications found
  // shard content that changed behind an unchanged file identity. A check
  // only judges files whose identity was the cached one before and after its
  // read, so a racing writer on a filesystem with real identities is never a
  // verdict; requiring two keeps a single oddity from warning. (Consecutive
  // is not required: the re-read after a verdict makes the next check clean.)
  let statsVerifyMismatches = 0;
  let statsVerifyWarned = false;
  function noteStatsVerifyResult(mismatched: readonly string[]): void {
    if (mismatched.length > 0) statsVerifyMismatches++;
    const timingPath = statsTimingLogPath();
    if (timingPath && mismatched.length > 0) writeStatsTiming(timingPath, { at: new Date().toISOString(), pid: process.pid, verifyMismatched: mismatched.length });
    if (statsVerifyMismatches < 2 || statsVerifyWarned) return;
    statsVerifyWarned = true;
    console.warn(
      `${LOG_PREFIX}: footer stats: ${mismatched.length} shard file(s) changed while their identity (inode, size, timestamps) did not; ` +
      `this filesystem hides changes from the incremental refresh. Set ${STATS_INCREMENTAL_ENV}=0 and please report it.`,
    );
  }

  async function runStatsRefresh(full: boolean): Promise<ShardAggregate> {
    const startedAt = performance.now();
    const ownName = `${instanceId}.json`;
    const incremental = isStatsIncrementalEnabled();
    let shardPhaseMs = 0;
    // Order matters (readStatsSnapshot): compaction publishes the archive
    // before deleting the shards it absorbed, so the shard phase (listing,
    // every lstat and readFile) completes before the archive is listed.
    // Reading them concurrently could pair an old archive with a post-delete
    // listing and drop those counters. A persistent transient archive read
    // error reuses the previous consistent snapshot (its shard contents, not
    // names) instead of pairing an old archive with a new listing.
    const verifyArchive = full || startedAt - archiveVerifiedAt >= fullScanIntervalMs;
    const snapshot = incremental
      ? await readStatsSnapshot(lastStatsSnapshot, SHARD_FILES_DIR, SHARD_ARCHIVE_PATH, {
        reuseArchive: !verifyArchive,
        readShards: async () => {
          const shards = await shardIndex.refresh({ own: ownName, full });
          await getStatsRefreshTestHooks().afterShardPhase?.();
          shardPhaseMs = performance.now() - startedAt;
          return shards;
        },
      })
      : await readStatsSnapshot(lastStatsSnapshot);
    lastStatsSnapshot = snapshot;
    if (verifyArchive || !incremental) archiveVerifiedAt = startedAt;
    const snapshotMs = performance.now() - startedAt;
    if (incremental) refreshScheduler.outsideRun(startFullScanIfDue);
    await getStatsRefreshTestHooks().beforeEpochRead?.();
    // Every epoch the aggregation can look up, read once and in parallel,
    // shared by both views and the adoption below.
    const day = currentLocalDay();
    const sessionsAtRead = new Set(currentSessionHashSet ? [currentSessionHash] : []);
    const keys = aggregateEpochKeys(snapshot.rawShards, snapshot.archive, [], day, undefined);
    for (const key of aggregateEpochKeys(snapshot.rawShards, snapshot.archive, [], null, sessionsAtRead)) keys.add(key);
    for (const shard of retiredShards.values()) for (const key of Object.keys(shard.models)) keys.add(key);
    for (const key of Object.keys(cacheStatsProcessByModel)) keys.add(key);
    const epochs = await readEpochSnapshot(keys);
    await getStatsRefreshTestHooks().beforeCommit?.();
    // ── Synchronous commit: no await from here on. ──
    // Usage message_end records meanwhile is in the in-memory counters this
    // step snapshots, so a refresh never overwrites it with older totals.
    const aggregate = commitStatsRefresh(snapshot, epochs, day);
    getStatsRefreshTestHooks().afterCommit?.(aggregate);
    const timingPath = statsTimingLogPath();
    if (timingPath) {
      const totalMs = performance.now() - startedAt;
      writeStatsTiming(timingPath, {
        at: new Date().toISOString(), pid: process.pid, incremental, full,
        totalMs: round(totalMs), shardPhaseMs: round(shardPhaseMs), archivePhaseMs: round(snapshotMs - shardPhaseMs),
        epochAndCommitMs: round(totalMs - snapshotMs), epochKeys: keys.size,
        shards: snapshot.rawShards.length, index: incremental ? shardIndex.lastRefresh : undefined,
      });
    }
    return aggregate;
  }

  const round = (value: number) => Math.round(value * 100) / 100;
  let timingLinesWritten = 0;
  let timingWrites: Promise<void> = Promise.resolve();
  /** Opt-in (PI_CACHE_OPTIMIZER_STATS_TIMING) JSON lines, serialized, capped, failures ignored. */
  function writeStatsTiming(path: string, record: Record<string, unknown>): void {
    if (timingLinesWritten >= 20_000) return;
    timingLinesWritten++;
    const line = JSON.stringify(record) + "\n";
    timingWrites = timingWrites.then(() => appendFile(path, line, "utf8")).catch(() => undefined);
  }

  /** The model epoch a refresh's aggregation filters `key` with. */
  function aggregationModelEpoch(key: string, epochs: EpochSnapshot): string {
    // A read (or local reset) newer than this snapshot set our value: it wins.
    if ((modelEpochSeq.get(key) ?? 0) > epochs.seq && modelEpochByKey.has(key)) return modelEpochByKey.get(key)!;
    // Keys first seen after the snapshot (usage recorded meanwhile) use the
    // epoch this process recorded them under.
    return epochs.models.get(key) ?? modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`);
  }

  function commitStatsRefresh(snapshot: StatsSnapshot, epochs: EpochSnapshot, day: string): ShardAggregate {
    // A reset from another process can advance epochs while this instance is
    // idle. Adopt those epochs during every refresh, not only when a later
    // message_end arrives, so this instance cannot keep an old in-memory
    // process bucket visible in `process` mode or rewrite stale counters during
    // shutdown. Model-scoped resets clear only the affected local bucket. A
    // read older than the one that set the current value is ignored.
    let globalChanged = false;
    if (acceptGlobalEpochRead(epochs.seq) && currentGlobalEpoch !== epochs.global) {
      globalChanged = true;
      currentGlobalEpoch = epochs.global;
      cacheStatsProcessByModel = {};
      modelEpochByKey.clear();
      voidModelEpochs(epochs.seq);
      modelApiByKey.clear();
      modelNameByKey.clear();
      lastActualRoutedModel = undefined;
    }
    if (!globalChanged) {
      for (const key of Object.keys(cacheStatsProcessByModel)) {
        const latestModelEpoch = epochs.models.get(key);
        // A key first recorded after this snapshot was read: message_end read its epoch.
        if (latestModelEpoch === undefined || !acceptModelEpochRead(epochs.seq, key)) continue;
        if ((modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`)) === latestModelEpoch) continue;
        delete cacheStatsProcessByModel[key];
        modelEpochByKey.set(key, latestModelEpoch);
        modelApiByKey.delete(key);
        modelNameByKey.delete(key);
      }
    }

    const { rawShards, archive } = snapshot;
    const ownAbsorbedAt = archive.archive.absorbed[instanceId];
    if (ownAbsorbedAt !== undefined) adoptAbsorbedOwnShard(ownAbsorbedAt);
    // Shards folded into the archive are counted there. Ignore their raw file
    // (a crash may leave it behind) and this process's in-memory retired copy.
    for (const id of archive.absorbedIds) retiredShards.delete(id);
    // A retired copy gives way to its file once the file is at least as new
    // (its closing write landed). An older file (the id's last active write,
    // when the closing write failed or is still queued) is ignored instead:
    // it may hold fewer counters than the retired copy.
    const persistedShards = rawShards.filter((shard) => {
      if (archive.absorbedIds.has(shard.instanceId)) return false;
      const retired = retiredShards.get(shard.instanceId);
      if (!retired) return true;
      if (shard.lifecycle.updatedAt < retired.lifecycle.updatedAt) return false;
      retiredShards.delete(shard.instanceId);
      return true;
    });
    // This process's own file is not even read by the tiered index (its
    // in-memory copy, the trailing shard, replaces it); the kill-switch path
    // reads it and drops it here. If a day rollover changed the id while the
    // snapshot was read, the previous id's content is its retired copy.
    const shards = persistedShards.filter((shard) => shard.instanceId !== instanceId);
    shards.push(...retiredShards.values());
    const trailing = currentSessionHashSet ? [buildCurrentStatsShard()] : [];
    const epochSource: ShardEpochs = { globalEpoch: currentGlobalEpoch, modelEpoch: (key) => aggregationModelEpoch(key, epochs) };
    // Keep lifetime session footer data separate from daily totals/commands.
    // Both equal aggregating [...shards, ...archive.shards, ...trailing]
    // (issue #28 review H): the current day only sees archive entries of that
    // day (normally none: the archive holds past days), and the all-days view
    // merges the archive's pre-reduced per-(session, model) entries instead
    // of re-aggregating every archived bucket. The all-days view is only read
    // for the current session (cacheStatsByModel lookups and the last routed
    // model), so it is built for that session alone.
    const aggregate = aggregateStatsWithArchiveSync(shards, archive, trailing, day, undefined, epochSource);
    const sessionAggregate = aggregateStatsWithArchiveSync(
      shards, archive, trailing, null, new Set(currentSessionHashSet ? [currentSessionHash] : []), epochSource,
    );

    cacheStatsByModel = {};
    for (const [sessionHash, models] of Object.entries(sessionAggregate.bySession)) {
      for (const [key, stats] of Object.entries(models)) {
        cacheStatsByModel[`${sessionHash}:${key}`] = stats;
      }
    }
    cacheStatsTotalsByModel = aggregate.totalsByModel;
    if (currentSessionHashSet) {
      lastActualRoutedModel = sessionAggregate.lastRoutedModelBySession[currentSessionHash];
    }
    lastStatusText = undefined;
    return aggregate;
  }

  // ── TUI shard watcher: an accelerator only (marks names dirty) ──
  let shardWatcherWanted = false;
  let shardWatcherDirectory: string | undefined;
  let shardWatcherRetryAt = 0;

  function closeShardWatcher(): void {
    const watcher = shardWatcher;
    shardWatcher = undefined;
    shardWatcherDirectory = undefined;
    try {
      watcher?.close();
    } catch {}
  }

  /**
   * Create the watcher when wanted (TUI, gate open) and missing. Called after
   * the background restore (which creates the directory) and after
   * successful background refreshes, so a watcher that failed (the directory
   * did not exist yet, or an error closed it) is recreated once the
   * directory can be listed again, at most every STATS_FULL_SCAN_INTERVAL_MS.
   */
  function ensureShardWatcher(): void {
    if (!shardWatcherWanted || shardWatcher || refreshScheduler.isClosed) return;
    const now = performance.now();
    if (now < shardWatcherRetryAt) return;
    shardWatcherRetryAt = now + STATS_FULL_SCAN_INTERVAL_MS;
    try {
      const factory = getStatsRefreshTestHooks().watch ?? createFsShardWatch;
      shardWatcher = factory(SHARD_FILES_DIR, onShardWatchName, onShardWatchError);
      shardWatcherRetryAt = 0;
      void statsReadFs().stat(SHARD_FILES_DIR).then((info) => {
        if (shardWatcher) shardWatcherDirectory = `${String(info.ino)}:${info.birthtimeMs}`;
      }, () => undefined);
    } catch {
      // ENOENT, ENOSPC (inotify watches exhausted), EPERM: lifecycle
      // refreshes, the hot set and full scans keep the footer correct.
      shardWatcher = undefined;
    }
  }

  function onShardWatchName(name: string | null): void {
    if (refreshScheduler.isClosed || !shardWatcher) return;
    const file = name === null ? undefined : basename(name);
    if (file === undefined) {
      // Overflow, or a platform that gives no name: re-check everything.
      shardIndex.requestFullScan();
    } else if (file.endsWith(".tmp")) {
      return; // the rename that publishes it reports the target name
    } else if (file === `${instanceId}.json`) {
      return; // this process's own writes: its in-memory copy is authoritative
    } else if (SHARD_FILE_NAME_PATTERN.test(file)) {
      shardIndex.markDirty(file);
    } else {
      shardIndex.requestFullScan();
    }
    scheduleShardRefresh(latestStatsCtx);
  }

  /**
   * A watcher 'error' (Windows: the watched directory was deleted) would
   * otherwise be thrown by the EventEmitter and crash Pi. Close the handle
   * (holding it would keep a deleted directory pending on Windows), fall
   * back to full scans, and recreate it only once the directory lists again.
   */
  function onShardWatchError(): void {
    closeShardWatcher();
    shardWatcherRetryAt = performance.now() + STATS_FULL_SCAN_INTERVAL_MS;
    shardIndex.requestFullScan();
  }

  /** After a full scan: a watcher whose directory was replaced (Linux keeps it on the old inode, silently) is recreated. */
  async function checkShardWatcherDirectory(): Promise<void> {
    if (!shardWatcher || shardWatcherDirectory === undefined) return;
    const watched = shardWatcherDirectory;
    let current: string | undefined;
    try {
      const info = await statsReadFs().stat(SHARD_FILES_DIR);
      current = `${String(info.ino)}:${info.birthtimeMs}`;
    } catch {
      current = undefined;
    }
    if (current !== watched && shardWatcherDirectory === watched) {
      closeShardWatcher();
      shardWatcherRetryAt = 0;
      if (current !== undefined) ensureShardWatcher();
    }
  }

  /** session_shutdown, first step: refuse new background work and stop its sources. */
  function closeStatsRefreshGate(): void {
    refreshScheduler.close();
    shardWatcherWanted = false;
    if (shardRefreshTimer !== null) clearTimeout(shardRefreshTimer);
    shardRefreshTimer = null;
    closeShardWatcher();
  }

  /** Wait for every refresh, publish and scan in flight. */
  async function drainStatsRefresh(): Promise<void> {
    for (;;) {
      await Promise.all(Array.from(backgroundStatsTasks));
      await refreshScheduler.drain();
      await shardIndex.settled();
      if (backgroundStatsTasks.size === 0 && refreshScheduler.idle && !shardIndex.fullScanInFlight) return;
    }
  }
  statsRefreshSettledForTests.add(drainStatsRefresh);

  function buildCurrentStatsShard(state: "active" | "closed" = "active"): PersistedStatsShardV7 {
    const now = Date.now();
    const models: PersistedStatsShardV7["models"] = {};
    for (const [key, stats] of Object.entries(cacheStatsProcessByModel)) {
      const slash = key.indexOf("/");
      if (slash <= 0 || slash >= key.length - 1) continue;
      models[key] = {
        modelEpoch: modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`),
        provider: key.slice(0, slash),
        modelId: key.slice(slash + 1),
        ...(modelNameByKey.get(key) ? { modelName: modelNameByKey.get(key) } : {}),
        ...(modelApiByKey.get(key) ? { api: modelApiByKey.get(key) } : {}),
        stats: cloneCacheStats(stats),
      };
    }
    const shard: PersistedStatsShardV7 = {
      version: 7,
      kind: "pi-cache-optimizer-shard",
      instanceId,
      sessionHash: currentSessionHash || "_nosession",
      process: { pid: process.pid, ppid: process.ppid, instanceStartedAt },
      lifecycle: {
        state,
        createdAt: shardCreatedAt,
        updatedAt: now,
        ...(state === "closed" ? { closedAt: now } : {}),
      },
      day: shardDay,
      globalEpoch: currentGlobalEpoch,
      models,
      ...(lastActualRoutedModel ? { lastRoutedModel: { ...lastActualRoutedModel } } : {}),
    };
    countersSessionOfShard.set(shard, countersSession);
    return shard;
  }

  function scheduleShardRefresh(ctx?: ExtensionContext): void {
    if (refreshScheduler.isClosed) return;
    if (shardRefreshTimer !== null) clearTimeout(shardRefreshTimer);
    shardRefreshTimer = setTimeout(() => {
      shardRefreshTimer = null;
      refreshAndPublishInBackground(ctx);
    }, SHARD_REFRESH_DEBOUNCE_MS);
    shardRefreshTimer.unref?.();
  }

  /** Look up visible cumulative stats for a model, falling back to legacy family. */
  function getStatsForModel(model: PiModel | undefined, adapter: CacheProviderAdapter): CacheStats {
    if (model) {
      const key = modelKey(model);
      const existing = cacheStatsTotalsByModel[key];
      if (existing) return existing;
    }

    // Fallback: legacy family bucket — used when model key is unknown.
    const family = cacheStatsLegacyFamily[adapter.id];
    if (family) return family;

    const created = emptyCacheStats();
    cacheStatsLegacyFamily[adapter.id] = created;
    return created;
  }

  /** Get or create a session-scoped stats entry for the given key. */
  function getOrCreateStatsByModelKey(key: string): CacheStats {
    const existing = cacheStatsByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsByModel[key] = created;
    return created;
  }

  /** Get or create the current-process provider/model stats entry. */
  function getOrCreateProcessStatsForModel(model: PiModel): CacheStats {
    const key = modelKey(model);
    const existing = cacheStatsProcessByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsProcessByModel[key] = created;
    return created;
  }

  /** Get or create the cumulative provider/model stats entry shown in the footer. */
  function getOrCreateTotalStatsForModel(model: PiModel): CacheStats {
    const key = modelKey(model);
    const existing = cacheStatsTotalsByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsTotalsByModel[key] = created;
    return created;
  }

  async function resetStatsForModel(model: PiModel): Promise<void> {
    const displayKey = modelKey(model);
    const nextEpoch = await advanceModelStatsEpoch(displayKey);
    modelEpochByKey.set(displayKey, nextEpoch);
    modelEpochSeq.set(displayKey, nextEpochSeq());
    delete cacheStatsProcessByModel[displayKey];
    delete cacheStatsTotalsByModel[displayKey];
    for (const key of Object.keys(cacheStatsByModel)) {
      if (modelKeyFromSessionScoped(key) === displayKey) delete cacheStatsByModel[key];
    }
    for (const key of Array.from(recentSamplesByModelKey.keys())) {
      if (modelKeyFromSessionScoped(key) === displayKey) recentSamplesByModelKey.delete(key);
    }
    lastStatusText = undefined;
  }

  async function resetCurrentSessionStats(): Promise<void> {
    currentGlobalEpoch = await advanceGlobalStatsEpoch();
    globalEpochSeq = nextEpochSeq();
    voidModelEpochs(globalEpochSeq);
    cacheStatsByModel = {};
    cacheStatsTotalsByModel = {};
    cacheStatsProcessByModel = {};
    modelEpochByKey.clear();
    modelApiByKey.clear();
    modelNameByKey.clear();
    clearRecentSamples();
    lastActualRoutedModel = undefined;
    lastStatusText = undefined;
  }

  function persistCacheStats(ctx?: ExtensionContext, lifecycleState: "active" | "closed" = "active"): Promise<void> {
    const shard = buildCurrentStatsShard(lifecycleState);
    const path = instanceShardPath;
    return enqueuePersist(async () => {
      try {
        await writeStatsShardV7(path, shard);
        if (path === instanceShardPath) recordPersistedOwnShard(shard);
      } catch (error) {
        console.warn(`${LOG_PREFIX}: failed to persist cache stats shard`, error);
        if (!persistenceWarningShown) {
          persistenceWarningShown = true;
          ctx?.ui.notify(
            `${LOG_PREFIX}: failed to persist footer stats; using in-memory stats for this process.`,
            "warning",
          );
        }
      }
    });
  }

  function schedulePersistCacheStats(ctx?: ExtensionContext): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      // A persist scheduled while a background restore runs (e.g. a routed
      // model change without usage) must not race the restore's own write.
      trackBackgroundStatsTask(waitForStatsRestore()
        .then(() => persistCacheStats(ctx))
        .then(() => refreshScheduler.background(false))
        .catch(() => undefined));
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  async function flushPersistCacheStats(ctx?: ExtensionContext, lifecycleState: "active" | "closed" = "active"): Promise<void> {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await rollOverStatsIfNeeded(ctx);
    // Adopt resets performed by another Pi process before capturing the shard
    // snapshot. Otherwise shutdown/command flush could rewrite stale local
    // counters under an old epoch even though aggregation already hid them.
    // A refresh that fails (a persistent read error) must not cost the
    // persist: write the counters under the epochs known so far.
    try {
      await refreshShardAggregate();
    } catch (error) {
      console.warn(`${LOG_PREFIX}: footer stats refresh before persisting failed`, error);
    }
    await persistCacheStats(ctx, lifecycleState);
    try {
      await refreshShardAggregate();
    } catch (error) {
      console.warn(`${LOG_PREFIX}: footer stats refresh after persisting failed`, error);
    }
    // That refresh may have continued an absorbed own shard under a new id
    // and queued its write: let it land before the flush (and a shutdown)
    // returns, or interactive mode's process.exit could cut it off.
    await enqueuePersist(() => Promise.resolve());
  }

  async function rollOverStatsIfNeeded(ctx?: ExtensionContext): Promise<void> {
    if (rolloverPromise) return rolloverPromise;
    const day = currentLocalDay();
    if (shardDay === day) return;
    rolloverPromise = (async () => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      // Adopt other processes' epoch resets before the snapshot below.
      await refreshShardAggregate();
      // A session_start on this instance may have retired the shard (and
      // moved to today's day) while that refresh ran: nothing left to roll.
      if (shardDay === day) return;
      // Preserve yesterday under its original UUID/day before clearing daily
      // counters. Each day owns a new shard so total never includes yesterday.
      const closing = retireCurrentShard(day, ctx);
      cacheStatsProcessByModel = {};
      cacheStatsLegacyFamily = emptyAllCacheStats();
      lastStatusText = undefined;
      await closing;
      await persistCacheStats(ctx);
      await refreshShardAggregate();
    })();
    try { await rolloverPromise; }
    finally { rolloverPromise = undefined; }
  }

  /**
   * Retired shards whose closing write failed: counted from memory only, so
   * they would be lost when the process exits. The shutdown flush writes
   * each one once more (see retryUnpersistedRetiredShards).
   */
  const unpersistedRetiredShards = new Map<string, { shard: PersistedStatsShardV7; path: string; landed: boolean }>();

  /**
   * One more closing write for each retired shard whose write failed, at
   * shutdown. Skipped once its retired copy is gone: compaction absorbed the
   * id (the archive counts it), or a file at least as new already landed.
   * Also skipped when an earlier write of the id had landed but its file is
   * gone now: compaction folded it into the archive and deleted it (a later
   * pass then forgets the id, so a refresh that missed the archive in
   * between still holds the retired copy). Writing it back would count it
   * twice. A second failure only warns: there is nothing left to retry with.
   */
  async function retryUnpersistedRetiredShards(): Promise<void> {
    for (const [id, { shard, path, landed }] of Array.from(unpersistedRetiredShards)) {
      unpersistedRetiredShards.delete(id);
      if (retiredShards.get(id) !== shard) continue;
      await enqueuePersist(async () => {
        try {
          if (landed && await lstat(path).then(() => false, (error) => getErrorCode(error) === "ENOENT")) return;
          await writeStatsShardV7(path, shard);
        } catch (error) {
          console.warn(`${LOG_PREFIX}: failed again to persist a retired stats shard at shutdown; its usage is lost`, error);
        }
      });
    }
  }

  /**
   * Retire the current shard: snapshot it closed, keep that snapshot as its
   * retired copy, continue under a new id on `day`, and queue the snapshot's
   * write (a failure warns and the retired copy keeps counting it; the
   * shutdown flush writes it once more). The written and the retired copy
   * are one object, so once its write lands the file (same updatedAt)
   * replaces the retired copy. Synchronous up to
   * the queued write, so usage recorded after this goes to the new id.
   */
  function retireCurrentShard(day: string, ctx?: ExtensionContext): Promise<void> {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const closed = buildCurrentStatsShard("closed");
    const closedPath = instanceShardPath;
    const landed = persistedOwnShards.length > 0;
    retiredShards.set(instanceId, closed);
    instanceId = randomUUID();
    instanceShardPath = join(SHARD_FILES_DIR, `${instanceId}.json`);
    persistedOwnShards = [];
    shardCreatedAt = Date.now();
    shardDay = day;
    return enqueuePersist(async () => {
      try {
        await writeStatsShardV7(closedPath, closed);
      } catch (error) {
        unpersistedRetiredShards.set(closed.instanceId, { shard: closed, path: closedPath, landed });
        console.warn(`${LOG_PREFIX}: failed to persist a retired stats shard`, error);
        if (!persistenceWarningShown) {
          persistenceWarningShown = true;
          ctx?.ui.notify(
            `${LOG_PREFIX}: failed to persist footer stats; using in-memory stats for this process.`,
            "warning",
          );
        }
      }
    });
  }

  /**
   * session_start calls this instance has handled. Pi 1.3 builds a new
   * extension instance for every session (new/resume/fork/reload), but a
   * host that keeps one instance across sessions sends it a second
   * session_start, which clears the in-memory counters.
   */
  let sessionStartsHandled = 0;

  /**
   * Before a second session_start on the same instance clears the counters,
   * retire the shard holding them and continue under a new id, as the day
   * rollover does. Without this, the next persist rewrites the old id with
   * the cleared counters and the earlier session's usage for the day is lost
   * (the shutdown flush closed it, but the id was reused). See
   * retireCurrentShard.
   */
  function retireShardForSessionStart(): void {
    // The retired shard keeps its own day; the new id starts on today's, so
    // the restore does not roll over again into an empty extra shard.
    void retireCurrentShard(currentLocalDay());
  }

  /**
   * Synchronous part of a session restore: reset in-memory state immediately
   * at session_start, so usage recorded before the background disk restore
   * finishes is never wiped by a reset that runs later.
   */
  function resetStatsForSessionStart(reason: string, ctx: ExtensionContext): void {
    syncSessionHash(ctx);
    lastStatusText = undefined;
    cacheStatsProcessByModel = {};
    countersSession++;
    cacheStatsLegacyFamily = emptyAllCacheStats();
    modelEpochByKey.clear();
    voidModelEpochs(nextEpochSeq());
    modelApiByKey.clear();
    modelNameByKey.clear();
    if (reason === "reload") {
      clearRecentSamples();
    }
  }

  async function restoreCacheStats(ctx: ExtensionContext): Promise<void> {
    // Session identity was synced by resetStatsForSessionStart. Usage may
    // already have been recorded (message_end does not wait to record), and
    // message_end syncs the epoch before recording. If the disk epoch differs
    // now, a reset happened after that usage: adopt it and drop the stale
    // process bucket instead of re-labelling old counters with the new epoch.
    // A read error keeps the epoch known so far (it is not "no reset").
    const seq = nextEpochSeq();
    const latest = await readEpochFileWithRetry(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global"));
    if (latest.ok && acceptGlobalEpochRead(seq) && latest.epoch !== currentGlobalEpoch) {
      currentGlobalEpoch = latest.epoch;
      cacheStatsProcessByModel = {};
      modelEpochByKey.clear();
      voidModelEpochs(seq);
      modelApiByKey.clear();
      modelNameByKey.clear();
    }
    await removeLegacyStatsFiles();
    await mkdir(SHARD_FILES_DIR, { recursive: true });
    await rollOverStatsIfNeeded(ctx);
    // Run due retention maintenance before the single startup scan, so the
    // aggregate never retains counters from files maintenance just removed and
    // no second directory pass is needed. Cleanup also warms the parsed-shard
    // cache, so the scan below only re-stats files.
    try {
      await maybeRunStatsMaintenance();
    } catch (error) {
      console.warn(`${LOG_PREFIX}: stats shard maintenance failed`, error);
    }
    // One scan adopts other processes' epochs and restores this session's
    // routed-model metadata before this instance publishes its own shard.
    // In-memory process counters were cleared above, so no pre-persist
    // re-scan is needed; this instance's own shard is always replaced by its
    // in-memory copy during aggregation, so no post-persist scan either.
    await refreshShardAggregate();
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistCacheStats(ctx);
  }

  async function publishStatus(ctx: ExtensionContext, model: PiModel | undefined = ctx.model): Promise<void> {
    syncSessionHash(ctx);
    await rollOverStatsIfNeeded(ctx);

    const routedModel = resolveRouteModel(model, ctx);
    const displayModel = routedModel ?? model;
    const adapter = selectAdapterForModel(displayModel);
    const activeIsVirtualRoute = !!routedModel || isVirtualRoutingModel(model, ctx);
    let statusText: string | undefined;
    const mode = footerStatsMode();
    const sessionHash = currentSessionHashSet ? currentSessionHash : undefined;

    if (!adapter && !routedModel && activeIsVirtualRoute) {
      // On model_select (existing footer), keep the existing cache footer
      // visible instead of clearing it. On session_start (no footer yet
      // after reload/fresh start), restore the exact last actual routed model
      // for this session when available; fall back to older best-effort
      // heuristics only when no exact metadata exists.
      if (lastStatusText !== undefined) return;
      const realEntry = buildExactRouterStatusEntry(
        sessionHash,
        cacheStatsByModel,
        lastActualRoutedModel,
        cacheStatsTotalsByModel,
        mode,
        cacheStatsProcessByModel,
      ) ?? findBestRouterModelStats(
        mode,
        sessionHash,
        cacheStatsByModel,
        cacheStatsTotalsByModel,
        cacheStatsProcessByModel,
      );
      if (realEntry) {
        const statsText = formatCacheStats(realEntry.adapter, realEntry.stats);
        statusText = runtimeOptimizerEnabled
          ? statsText
          : `Cache Optimizer disabled · ${statsText}`;
      }
    }

    if (adapter) {
      // Footer mode defaults to current-session provider/model totals. Users may
      // select all-current-day or current-process counters through persistent
      // command config or the environment variable.
      const stats = displayModel
        ? selectFooterStatsForModel(mode, sessionHash, cacheStatsByModel, cacheStatsTotalsByModel, displayModel, cacheStatsProcessByModel)
        : undefined;
      const statsText = formatCacheStats(adapter, stats ?? emptyCacheStats());
      statusText = runtimeOptimizerEnabled ? statsText : `Cache Optimizer disabled · ${statsText}`;
    }

    // ⚠️ compat footer marker: if the active model has adapter-specific
    // missing compat (DeepSeek reasoning/cache compat, or a non-official
    // openai-completions model missing cache/session-affinity flags), append
    // the marker to indicate that compat configuration is incomplete.
    // Re-evaluated on every status update so the marker persists through stats
    // changes and day rollovers. Redundant setStatus calls are blocked by the
    // `lastStatusText` early return above.
    if (runtimeOptimizerEnabled && statusText !== undefined && displayModel) {
      // Only show ⚠️ compat when there are safe-fixable missing compat keys.
      // Optional/advisory-only flags (e.g. supportsLongCacheRetention on generic
      // OpenAI-compatible proxies) do NOT trigger the marker — the doctor/compat
      // commands still mention them as optional guidance.
      if (buildFixSuggestion(displayModel) !== undefined) {
        statusText = statusText + " ⚠️ compat";
      }
    }

    statusText = prefixFooterStatus(statusText);
    if (statusText === lastStatusText) return;

    lastStatusText = statusText;
    ctx.ui.setStatus(STATUS_KEY, statusText);
  }

  ensureRoutingRegistry();

  /**
   * Check whether a model has an EXPLICIT supportsLongCacheRetention: true
   * opt-in in models.json. Precedence mirrors Pi's effective model config:
   * modelOverrides[model.id].compat, then models[].compat, then provider.compat.
   *
   * Returns true ONLY when the user explicitly opted in. Returns false for:
   *   - Explicit false (opt-out)
   *   - In models.json but field absent (Pi defaults to true — unsafe)
   *   - Not in models.json at all (API-logged-in providers)
   *   - File missing/unreadable
   *
   * The caller strips prompt_cache_retention when this returns false.
   */
  function hasExplicitLongRetentionOptIn(model: PiModel): boolean {
    // Pi's built-in catalog only ever sets supportsLongCacheRetention: false, so
    // an explicit true on the runtime model (provider extension or merged
    // models.json) is as deliberate as one read from models.json directly.
    // A value resolved from models.json (modelOverrides > model > provider)
    // still wins, so an explicit false there is never overridden.
    const configured = resolveExplicitCompatValue(
      readEffectiveCompatConfig(),
      model.provider,
      model.id,
      "supportsLongCacheRetention",
    );
    if (configured !== undefined) return configured.value === true;
    return asRecord(model.compat)?.supportsLongCacheRetention === true;
  }

  /**
   * Request treatment that before_provider_request derives from a model's
   * identity. A native virtual request whose dispatched id matches several
   * credentialed providers is resolved only when this key agrees for all of
   * them, so no provider-specific decision is applied on a guess.
   */
  function requestPolicyKey(model: PiModel): string {
    const key = modelKey(model);
    return JSON.stringify([
      model.api ?? "",
      isOfficialOpenAIBaseUrl(model),
      hasExplicitLongRetentionOptIn(model),
      promptCacheRetention400Models.has(key),
      anthropicTtlOrderErrorModels.has(key),
      isPromptCacheKeyOmittedForModel(model),
    ]);
  }

  pi.on("session_start", async (event, ctx) => {
    if (runtimeOptimizerEnabled) requestLongCacheRetention();
    // Do not block Pi's startup on historical stats (issue #28). The
    // restore runs in the background (chained after any earlier restore so
    // two never interleave) and the footer is published when it finishes.
    // A newer session_start supersedes an older restore, which then must not
    // publish a stale footer. Handlers that read or persist stats await
    // waitForStatsRestore() first.
    const generation = ++statsRestoreGeneration;
    // The same extension instance lives on across session switches
    // (shutdown, then start): reopen what the shutdown closed.
    refreshScheduler.open();
    latestStatsCtx = ctx;
    const tui = ctx.mode === "tui";
    if (sessionStartsHandled++ > 0) retireShardForSessionStart();
    resetStatsForSessionStart(event.reason, ctx);
    const previousRestore = statsRestorePromise;
    statsRestorePromise = previousRestore
      // A restore superseded before it started is skipped entirely: the newer
      // one redoes all of its work, and its ctx may already be stale.
      .then(() => (generation === statsRestoreGeneration ? restoreCacheStats(ctx) : undefined))
      .then(async () => {
        if (generation === statsRestoreGeneration) await publishStatus(ctx);
      })
      .catch((error) => {
        console.warn(`${LOG_PREFIX}: failed to restore cache stats`, error);
      })
      .then(() => {
        // TUI only, and only after the restore created the directory (2.9.3
        // watched it on the startup path and stayed without a watcher for
        // the whole process when it did not exist yet).
        if (tui && generation === statsRestoreGeneration && !refreshScheduler.isClosed) {
          shardWatcherWanted = true;
          shardWatcherRetryAt = 0;
          ensureShardWatcher();
        }
      });
    latestStatsRestoreForTests = statsRestorePromise;
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Pi 0.99+ codemode scripts run nested tool calls in parallel; the calling
    // tool's own end event follows them, so one refresh covers the batch.
    if (isNonEmptyString((event as { parentToolCallId?: unknown } | undefined)?.parentToolCallId)) return;
    // Pi awaits this handler before the next turn: refresh in the background.
    refreshAndPublishInBackground(ctx);
  });

  // Pi 0.86+ native prompt-cache warming: keep it running for models whose
  // prices are unknown (all-zero cost), where Pi would otherwise stop with
  // "cache economics unavailable". Older hosts never emit this event.
  pi.on("cache_warming_decision", (event, ctx) => {
    if (!isZeroPriceWarmingEnabled()) return undefined;
    const action = decideZeroPriceWarming(event, ctx.model);
    return action ? { action } : undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // No provider request can still be in flight once the agent has settled.
    // Drop leftover lifecycle records (a request whose message never ended, or
    // a record consumed out of order) so they cannot be correlated with the
    // next run's messages.
    providerRequestStates.length = 0;
    refreshAndPublishInBackground(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      // Close the gate first (no new background refresh, watcher event or
      // scan-triggered publish), then let what is in flight finish, then
      // flush. The flush's own refreshes are awaited and still run.
      closeStatsRefreshGate();
      await waitForStatsRestore();
      await drainStatsRefresh();
      try {
        await flushPersistCacheStats(ctx, "closed");
      } finally {
        // Also when the flush failed (e.g. its rollover's refresh threw).
        await retryUnpersistedRetiredShards();
      }
    } finally {
      closeStatsRefreshGate();
      latestCacheHint = undefined;
      providerRequestStates.length = 0;
      delete getProtocolGlobal().__piCacheOptimizerCacheKey__;
      uninstallCacheHintsService();
      restoreCacheRetentionEnv(STARTUP_CACHE_RETENTION_ENV);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (runtimeOptimizerEnabled) notifyCacheCompatIfNeeded(resolveRouteModel(event.model, ctx) ?? event.model, ctx, warnedModels);
    await waitForStatsRestore();
    await refreshShardAggregate({ full: false });
    await publishStatus(ctx, event.model);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    latestCacheHint = undefined;
    // Clear the legacy global before any bypass/disable early return. A valid
    // rewrite path republishes the current session key below; otherwise callers
    // must not observe a stale key from the previously selected model/route.
    delete getProtocolGlobal().__piCacheOptimizerCacheKey__;
    const routeSnapshot = resolveActiveRouteSnapshot(_ctx.model, _ctx);
    const routedModel = routeSnapshot
      ? findModelInRegistry(_ctx.modelRegistry, routeSnapshot.provider, routeSnapshot.modelId) ?? routeSnapshotToPiModel(routeSnapshot, _ctx.model)
      : undefined;

    // The edits below are in-place: Pi's section order is never changed. Pi >= 0.86
    // already assembles sections from stable to variable (preamble, tools, rules,
    // docs, project context, skills, cwd), so lifting content to the front would
    // only produce empty section shells and move the identity text away from the
    // start; measured prefix stability was identical with and without it.
    const model = routedModel ?? _ctx.model;
    // Pi 0.99+ native virtual selections pick the physical model per request,
    // after this system prompt is built, so the API cannot be decided here.
    // Keep Pi's prompt byte-for-byte unless the route is explicitly known safe.
    const visibleSkills = (event.systemPromptOptions?.skills ?? []).filter((skill) => !skill.disableModelInvocation).length;
    const skipSkills = (reason: string) => recordSkillCompressionOutcome({ applied: false, reason, visibleSkills, at: Date.now() });
    if (isNativeVirtualModel(_ctx.model) && !canRewriteNativeVirtualPrompt(_ctx.model, _ctx)) {
      skipSkills("native virtual model: the prompt is kept unchanged unless virtual-rewrite is enabled for a known-safe route");
      return {};
    }

    if (!runtimeOptimizerEnabled) {
      skipSkills("the optimizer is disabled for this process (/cache-optimizer disable)");
      return {};
    }

    // Global opt-out: PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1 bypasses all
    // prompt mutations below (session-overview churn strip and skill
    // compression). Footer stats and the OpenAI prompt_cache_key fallback
    // remain active.
    if (!featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true)) {
      skipSkills("prompt rewrite is turned off");
      return {};
    }

    // OpenAI Codex/Responses is unusually sensitive to skill-index shape: real
    // TourStory task benchmarks showed the compressed Markdown index could
    // lengthen the Pi tool trajectory enough to increase total task cost even
    // though each request became shorter. Keep Pi's native skill block for the
    // Codex transport; other providers retain the compression optimization.
    const codexSkillCompressionBypass = model?.api === "openai-codex-responses";

    // Skill compression first, as a section edit when Pi supports it (see
    // compressSkillsViaSection); the string path below is the fallback.
    const skillsViaSection = codexSkillCompressionBypass ? false : compressSkillsViaSection(event);

    // Strip per-turn churn from <session-overview>.
    // Removing RECENT COMMITS, Working directory status, and
    // Journal line count makes more of the session-overview stable
    // across turns, which DeepSeek's prefix cache can then retain.
    // This edit has no section to target, so a changed prompt is returned
    // as a forced prompt.
    const strippedPrompt = stripSessionOverviewChurn(event.systemPrompt);

    // Fallback skill compression: substitute the verbose block in the string
    // (Pi < 0.86, or a forced prompt from an earlier handler). Deterministic from the same `event.systemPromptOptions.skills`,
    // so cache stability is unchanged. No-op if opted out, below
    // SKILL_COMPRESSION_MIN_COUNT, or if pi emitted a format we don't recognize.
    const compressedPrompt = codexSkillCompressionBypass
      ? strippedPrompt
      : compressSkillsInSystemPrompt(
          strippedPrompt,
          event.systemPromptOptions,
        );
    // With a section edit and nothing to strip, Pi renders the compressed prompt
    // itself and no forced prompt is returned.
    recordSkillCompressionOutcome(
      codexSkillCompressionBypass
        ? { applied: false, reason: "OpenAI Codex uses Pi's native skill index to preserve task trajectory", visibleSkills, at: Date.now() }
        : skillsViaSection
        ? { applied: "section", visibleSkills, at: Date.now() }
        : compressedPrompt !== strippedPrompt
          ? { applied: "string", visibleSkills, at: Date.now() }
          : { applied: false, reason: explainSkillCompressionSkip(strippedPrompt, event.systemPromptOptions), visibleSkills, at: Date.now() },
    );
    const changed = compressedPrompt !== event.systemPrompt && compressedPrompt.trim().length > 0;
    const finalPrompt = changed ? compressedPrompt : event.systemPrompt;

    // Responses family (codex-responses, responses, azure-responses): Pi owns the
    // prompt_cache_key there and no cache hint is published for router consumers.
    if (model && isResponsesPromptRewriteBypassApi(model.api)) {
      return changed ? { systemPrompt: finalPrompt } : {};
    }

    const promptCacheKey = getSessionPromptCacheKey(_ctx);
    const cacheRetention = process.env[PI_CACHE_RETENTION_ENV] === LONG_CACHE_RETENTION_VALUE ? LONG_CACHE_RETENTION_VALUE : undefined;
    latestCacheHint = {
      sessionIdHash: currentSessionHashSet ? currentSessionHash : sessionHashFromContext(_ctx),
      virtualProvider: routeSnapshot?.virtualProvider ?? _ctx.model?.provider,
      virtualModelId: routeSnapshot?.virtualModelId ?? _ctx.model?.id,
      upstreamProvider: routeSnapshot?.provider ?? model?.provider,
      upstreamModelId: routeSnapshot?.modelId ?? model?.id,
      api: model?.api,
      systemPrompt: finalPrompt,
      promptCacheKey,
      cacheRetention,
      timestamp: Date.now(),
    };
    const globals = getProtocolGlobal();
    if (promptCacheKey) {
      globals.__piCacheOptimizerCacheKey__ = promptCacheKey;
    } else {
      delete globals.__piCacheOptimizerCacheKey__;
    }
    return changed ? { systemPrompt: finalPrompt } : {};
  });

  pi.on("before_provider_headers", (event, ctx) => {
    // Pi transforms headers before the payload exists and passes no model, so a
    // native virtual request's physical model is unknown here. Fail closed; Pi
    // core still sends the physical model's own configured affinity headers.
    if (isNativeVirtualModel(ctx.model)) return;
    const requestModel = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
    addEffectiveSessionAffinityHeaders(
      event.headers,
      requestModel,
      ctx.sessionManager.getSessionId(),
    );
  });

  pi.on("before_provider_request", (event, ctx) => {
    // A native virtual selection keeps ctx.model virtual; resolve the physical
    // model from the dispatched payload. Unresolved requests keep the virtual
    // model, which fails every identity-dependent mutation closed.
    const nativeVirtualRequest = resolveNativeVirtualRequestModel(ctx.model, event.payload, ctx, requestPolicyKey);
    const requestModel = isNativeVirtualModel(ctx.model)
      ? (nativeVirtualRequest?.model ?? ctx.model)
      : (resolveRouteModel(ctx.model, ctx) ?? ctx.model);
    // Request-local identity is also needed by the always-on Anthropic TTL
    // validity repair, so retain the credential-blind snapshot even while the
    // optional runtime optimizer features are disabled.
    const snapshot = snapshotProviderRequestModel(requestModel);
    if (snapshot) {
      providerRequestStates.push({
        model: snapshot,
        selectionModelKey: ctx.model ? modelKey(ctx.model) : modelKey(snapshot),
        virtualSelection: isVirtualRoutingModel(ctx.model, ctx),
        responseReceived: false,
        correlationAmbiguous: false,
        identityAmbiguous: isNativeVirtualModel(ctx.model) && (!nativeVirtualRequest || nativeVirtualRequest.identityAmbiguous),
      });
      pruneProviderRequestStates(providerRequestStates);
    }
    let requestPayload: unknown = event.payload;
    let toolOrderChanged = false;

    if (isToolOrderEnabled() && isToolOrderingEligibleModel(requestModel)) {
      const normalized = normalizeToolsInPayload(requestPayload, requestModel.api);
      requestPayload = normalized.payload;
      toolOrderChanged = normalized.changed;
    }

    // Every mutation below works on a copy and is returned explicitly: Pi's
    // event.payload is never modified in place, so the hook does not depend on
    // the host honouring in-place edits.
    let payloadChanged = toolOrderChanged;

    // Anthropic rejects mixed cache breakpoints when a 1h block appears after
    // a 5m/default block in wire order (tools → system → messages). Repair any
    // conflict visible in Pi's final payload immediately. Some proxies inject
    // hidden short breakpoints after this hook; only models that have actually
    // returned the explicit TTL-order error receive the process-local 5m fallback.
    if (requestModel && isAnthropicMessagesApi(requestModel.api)) {
      const repaired = withAnthropicCacheTtlRepair(requestPayload, anthropicTtlOrderErrorModels.has(modelKey(requestModel)));
      if (repaired !== undefined) {
        requestPayload = repaired;
        payloadChanged = true;
      }
    }

    // prompt_cache_retention gate. This extension sets PI_CACHE_RETENTION=long,
    // which makes Pi emit prompt_cache_retention: "24h" for every endpoint whose
    // detected compat does not explicitly disable it, including third-party
    // proxies that reject unknown fields with HTTP 400. The gate undoes only that
    // side effect; see decidePromptCacheRetention for the order and reasons.
    if (runtimeOptimizerEnabled && typeof asRecord(requestPayload)?.prompt_cache_retention === "string") {
      const decision = decidePromptCacheRetention({
        providerRejected: !!requestModel && promptCacheRetention400Models.has(modelKey(requestModel)),
        officialOpenAI: !!requestModel && isOfficialOpenAIBaseUrl(requestModel),
        explicitOptIn: !!requestModel && hasExplicitLongRetentionOptIn(requestModel),
        userRequestedLong: userRequestedLongCacheRetention(),
      });
      recordPromptCacheRetentionDecision(requestModel ? modelKey(requestModel) : undefined, decision);
      if (!decision.keep) {
        const stripped = withoutPromptCacheRetention(requestPayload);
        if (stripped !== undefined) {
          requestPayload = stripped;
          payloadChanged = true;
        }
      }
    }

    if (isPromptCacheKeyOmittedForModel(requestModel)) {
      const omitted = omitOpenAIPromptCacheKeys(requestPayload);
      return omitted ?? (payloadChanged ? requestPayload : undefined);
    }

    if (!shouldInjectOpenAIPromptCacheKey() || !shouldInjectOpenAIPromptCacheKeyForModel(requestModel)) {
      return payloadChanged ? requestPayload : undefined;
    }

    const withCacheKey = addOpenAIPromptCacheKey(requestPayload, getSessionPromptCacheKey(ctx));
    return withCacheKey ?? (payloadChanged ? requestPayload : undefined);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const pendingStates = providerRequestStates.filter((state) => !state.responseReceived);
    let responseState: ProviderRequestState | undefined;
    if (pendingStates.length === 1) {
      responseState = pendingStates[0];
    } else if (pendingStates.length > 1) {
      const pendingModelKeys = new Set(pendingStates.map((state) => modelKey(state.model)));
      if (pendingModelKeys.size === 1) {
        // Identity is still exact when concurrent requests use the same model.
        responseState = pendingStates[0];
      } else {
        // Pi supplies no request id here, so out-of-order concurrent responses
        // cannot be assigned safely. Preserve the lifecycle records for a
        // message-local identity, but never turn ambiguous headers into a
        // model-scoped persistent-fix suggestion.
        for (const state of pendingStates) state.correlationAmbiguous = true;
      }
    }
    if (responseState) responseState.responseReceived = true;
    // A native virtual request whose physical provider could not be pinned
    // records no model-scoped header evidence; finalized assistant messages
    // still carry exact provider/model identity.
    const model = responseState
      ? (responseState.identityAmbiguous ? undefined : responseState.model)
      : (pendingStates.length === 0 && !isNativeVirtualModel(ctx.model) ? (resolveRouteModel(ctx.model, ctx) ?? ctx.model) : undefined);
    if (!runtimeOptimizerEnabled || !model) return;

    // Keep only the category, never the provider's complete error text. This
    // is evidence for a later, model-scoped `/fix`; it never edits config from
    // a response hook.
    if (
      isReasoningProtocolRejectionSignalApplicable(model) &&
      event.status === 400 &&
      hasReasoningProtocolRejectionSignal(event.headers)
    ) {
      await notifyReasoningProtocolObservation(
        model,
        ctx,
        reasoningProtocolRejectedModels,
        warnedReasoningProtocolRejectedModels,
      );
    }

    // ── 400: prompt_cache_key unsupported ──
    if (event.status === 400 && isPromptCacheKeyUnsupportedApplicable(model) && hasPromptCacheKeyUnsupportedSignal(event.headers)) {
      const key = modelKey(model);
      promptCacheKeyRejectedModels.add(key);
      if (!warnedPromptCacheKeyRejectedModels.has(key)) {
        warnedPromptCacheKeyRejectedModels.add(key);
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: ${key} rejected prompt_cache_key. Run /cache-optimizer fix to review a precise model-scoped repair. No configuration was changed automatically.`,
          "warning",
        );
      }
    }

    // ── 400: prompt_cache_retention unsupported ──
    if (
      event.status === 400 &&
      isPromptCacheRetention400Applicable(model) &&
      hasPromptCacheRetentionUnsupportedSignal(event.headers)
    ) {
      const key = modelKey(model);
      promptCacheRetention400Models.add(key);
      if (!warnedPromptCacheRetention400Models.has(key)) {
        warnedPromptCacheRetention400Models.add(key);
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: ${key} returned HTTP 400 while supportsLongCacheRetention is enabled. ` +
          getPromptCacheRetentionUnsupportedHint() +
          ` Run /cache-optimizer doctor for the exact edit location.`,
          "warning",
        );
      }
    }

    // ── 403: proxy/CDN/WAF blocking ──
    if (event.status === 403) {
      const key403 = modelKey(model);

      // Case 1: Pi's custom session-affinity headers are enabled. Offer the
      // existing safe compat fix (`sendSessionAffinityHeaders: false`).
      if (isSessionAffinity403Applicable(model)) {
        sendSessionAffinityHeaders403Models.add(key403);
        if (warnedSendSessionAffinityHeaders403Models.has(key403)) return;
        warnedSendSessionAffinityHeaders403Models.add(key403);
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: ${key403} returned HTTP 403 while sendSessionAffinityHeaders is enabled. ` +
          `The proxy/CDN may be blocking Pi's custom session-affinity headers (session_id, x-client-request-id, x-session-affinity). ` +
          `Run /cache-optimizer doctor for details and /cache-optimizer fix to set sendSessionAffinityHeaders: false.`,
          "warning",
        );
        return;
      }

      // Case 2: session-affinity headers are already absent/disabled, but the
      // provider still returns 403. Some CDNs/WAFs block the OpenAI JS SDK
      // default request fingerprint (User-Agent: OpenAI/JS ... or
      // X-Stainless-* headers). This is provider-specific; do NOT auto-fix by
      // writing a User-Agent because the right value depends on the endpoint.
      if (isOpenAISdkHeader403Applicable(model)) {
        openAISdkHeader403Models.add(key403);
        if (warnedOpenAISdkHeader403Models.has(key403)) return;
        warnedOpenAISdkHeader403Models.add(key403);
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: ${key403} returned HTTP 403 even though sendSessionAffinityHeaders is not enabled. ` +
          `The proxy/CDN may be blocking the OpenAI JS SDK User-Agent / X-Stainless-* headers. ` +
          `Run /cache-optimizer doctor for manual diagnostic guidance; /cache-optimizer fix will not auto-write User-Agent headers.`,
          "warning",
        );
        return;
      }
    }
  });

  pi.on("message_end", async (event, ctx) => {
    syncSessionHash(ctx);
    const msgRecord = asRecord(event.message);
    const requestCorrelationForMessage = msgRecord?.role === "assistant"
      ? (() => {
        const explicitModel = modelFromAssistantMessage(event.message, undefined, true);
        const explicitIndex = explicitModel
          ? providerRequestStates.findIndex((state) => modelKey(state.model) === modelKey(explicitModel))
          : -1;
        const completedIndex = providerRequestStates.findIndex((state) => state.responseReceived);
        const index = explicitIndex >= 0 ? explicitIndex : (completedIndex >= 0 ? completedIndex : 0);
        const state = providerRequestStates.splice(index, 1)[0];
        if (!state) return { model: undefined, ambiguous: false, virtualSelection: undefined, selectionModelKey: undefined };
        // A current selection cannot correlate an unknown echoed alias. Even
        // before response headers arrive, different outstanding models make
        // that fallback ambiguous; keep the message's own identity instead.
        const ambiguous = explicitIndex < 0 && (
          state.correlationAmbiguous || state.identityAmbiguous === true ||
          providerRequestStates.some((other) => modelKey(other.model) !== modelKey(state.model))
        );
        return {
          model: ambiguous ? undefined : state.model,
          ambiguous,
          virtualSelection: state.virtualSelection,
          selectionModelKey: state.selectionModelKey,
        };
      })()
      : { model: undefined, ambiguous: false, virtualSelection: undefined, selectionModelKey: undefined };
    const requestModelForMessage = requestCorrelationForMessage.model;
    const contextualFallbackForMessage = requestCorrelationForMessage.ambiguous
      ? undefined
      : (resolveRouteModel(ctx.model, ctx) ?? ctx.model);

    // Some providers expose an HTTP 400 error body only through the finalized
    // assistant error message; after_provider_response may contain the status
    // and no diagnostic response headers. Record only the model-scoped
    // reasoning-protocol category from that authoritative message identity.
    if (runtimeOptimizerEnabled && hasReasoningProtocolRejectionErrorMessage(event.message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const messageModel = modelFromAssistantMessage(event.message, fallbackModel) ?? fallbackModel;
      const errorModel = messageModel
        ? findModelInRegistry(ctx.modelRegistry, messageModel.provider, messageModel.id) ?? messageModel
        : undefined;
      if (errorModel && isReasoningProtocolRejectionForModel(event.message, errorModel)) {
        await notifyReasoningProtocolObservation(
          errorModel,
          ctx,
          reasoningProtocolRejectedModels,
          warnedReasoningProtocolRejectedModels,
        );
      }
    }
    if (runtimeOptimizerEnabled && hasPromptCacheKeyUnsupportedErrorMessage(event.message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const messageModel = modelFromAssistantMessage(event.message, fallbackModel) ?? fallbackModel;
      const errorModel = messageModel
        ? findModelInRegistry(ctx.modelRegistry, messageModel.provider, messageModel.id) ?? messageModel
        : undefined;
      if (errorModel && isPromptCacheKeyUnsupportedApplicable(errorModel)) {
        const key = modelKey(errorModel);
        promptCacheKeyRejectedModels.add(key);
        if (!warnedPromptCacheKeyRejectedModels.has(key)) {
          warnedPromptCacheKeyRejectedModels.add(key);
          ctx.ui.notify(
            `⚠️ ${LOG_PREFIX}: ${key} rejected prompt_cache_key. Run /cache-optimizer fix to review a precise model-scoped repair. No configuration was changed automatically.`,
            "warning",
          );
        }
      }
    }
    if (runtimeOptimizerEnabled && hasPromptCacheRetentionUnsupportedErrorMessage(event.message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const messageModel = modelFromAssistantMessage(event.message, fallbackModel) ?? fallbackModel;
      const errorModel = messageModel
        ? findModelInRegistry(ctx.modelRegistry, messageModel.provider, messageModel.id) ?? messageModel
        : undefined;
      if (errorModel && isExplicitPromptCacheRetentionUnsupportedApplicable(errorModel)) {
        const key = modelKey(errorModel);
        promptCacheRetention400Models.add(key);
        if (!warnedPromptCacheRetention400Models.has(key)) {
          warnedPromptCacheRetention400Models.add(key);
          ctx.ui.notify(
            `⚠️ ${LOG_PREFIX}: ${key} rejected prompt_cache_retention. ` +
            getPromptCacheRetentionUnsupportedHint() +
            ` Run /cache-optimizer doctor for the exact edit location.`,
            "warning",
          );
        }
      }
    }

    // Record only Anthropic's explicit mixed-TTL ordering error. This is a
    // non-retryable 400 in Pi 0.82.1, so the fallback applies to the next
    // subsequent request (and to a retry only if another layer initiates one).
    if (hasAnthropicCacheTtlOrderError(event.message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const errorModel = modelFromAssistantMessage(event.message, fallbackModel) ?? fallbackModel;
      if (errorModel && isAnthropicMessagesApi(errorModel.api)) {
        const key = modelKey(errorModel);
        anthropicTtlOrderErrorModels.add(key);
        if (!warnedAnthropicTtlOrderErrorModels.has(key)) {
          warnedAnthropicTtlOrderErrorModels.add(key);
          ctx.ui.notify(
            `⚠️ ${LOG_PREFIX}: ${key} returned an Anthropic cache-control TTL ordering error. ` +
            `The next request will fall back to the default 5-minute cache TTL. ` +
            `Run /cache-optimizer fix to set model-level supportsLongCacheRetention: false persistently.`,
            "warning",
          );
        }
      }
    }

    // A native virtual selection keeps ctx.model virtual, while the finalized
    // message names the physical catalog model Pi dispatched. Resolve that
    // model from the registry so adapter tokens, the stats key, and the footer
    // compat marker use the same physical identity as the pre-request UX.
    const nativeVirtualDispatch = isNativeVirtualModel(ctx.model)
      ? nativeVirtualDispatchFromMessage(event.message)
      : undefined;
    const nativeVirtualMessageModel = nativeVirtualDispatch
      ? nativeVirtualDispatchToModel(nativeVirtualDispatch, ctx)
      : undefined;

    const currentSelectionIsVirtual = isVirtualRoutingModel(ctx.model, ctx);
    const requestSelectionIsVirtual = requestCorrelationForMessage.virtualSelection ?? currentSelectionIsVirtual;
    const directSelection = !requestSelectionIsVirtual;
    const statsFallback = requestModelForMessage ?? ctx.model;
    let statsModel = modelFromAssistantMessage(event.message, statsFallback, directSelection) ?? statsFallback;
    if (nativeVirtualMessageModel) {
      statsModel = nativeVirtualMessageModel;
    } else if (directSelection && statsModel) {
      // Catalog identity wins over an echoed response alias. Older/custom
      // transports can still echo an unknown id; consolidate those only with
      // the request-local snapshot, never a newly selected same-family model.
      const catalogModel = findModelInRegistry(ctx.modelRegistry, statsModel.provider, statsModel.id);
      statsModel = catalogModel && !isVirtualRoutingModel(catalogModel, ctx)
        ? catalogModel
        : consolidateDirectProviderStatsModel(statsModel, requestModelForMessage, ctx);
    }
    const adapter = selectAdapterForModel(statsModel) ?? selectAdapterForAssistantMessage(event.message, statsModel);
    if (!adapter) return;

    // Skip stats for error/aborted messages (network retries, user aborts).
    // Pi's auto-retry emits message_end for the failed attempt before
    // removing it and retrying. The error message carries zero-usage fields
    // ({ input: 0, cacheRead: 0, cacheWrite: 0 }) that normalizeUsage
    // returns as a valid (non-undefined) snapshot, which would inflate
    // totalRequests and skew cache hit-rate accuracy. The final successful
    // response is emitted as a separate message_end with real usage data.
    if (msgRecord?.stopReason === "error" || msgRecord?.stopReason === "aborted") {
      return;
    }

    const usage = adapter.normalizeUsage(event.message);

    let routedModelChanged = false;
    if (requestSelectionIsVirtual && statsModel && !isVirtualRoutingModel(statsModel, ctx)) {
      const nextRoutedModel: PersistedRoutedModelRef = {
        provider: statsModel.provider,
        id: statsModel.id,
        name: statsModel.name || statsModel.id,
      };
      if (
        !lastActualRoutedModel ||
        lastActualRoutedModel.provider !== nextRoutedModel.provider ||
        lastActualRoutedModel.id !== nextRoutedModel.id ||
        (lastActualRoutedModel.name || lastActualRoutedModel.id) !== (nextRoutedModel.name || nextRoutedModel.id)
      ) {
        lastActualRoutedModel = nextRoutedModel;
        routedModelChanged = true;
      }
    }

    // Record recent sample (even when usage is missing, for trend diagnosis)
    if (statsModel) {
      const sk = sessionModelKey(statsModel);
      const missingFields = usage === undefined || (usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.totalInput === 0)
        ? true
        : hasMissingUsageFields(event.message, adapter);
      recordRecentSample(sk, usage ?? { cacheRead: 0, cacheWrite: 0, totalInput: 0 }, missingFields);
    }

    if (!usage) {
      if (routedModelChanged) schedulePersistCacheStats(ctx);
      return;
    }

    await rollOverStatsIfNeeded(ctx);

    // Update session, process-local, and cumulative buckets for the actual
    // routed model. The process bucket is intentionally never persisted.
    if (statsModel) {
      const key = modelKey(statsModel);
      // Fresh reads, numbered like every footer epoch read: a refresh that
      // read older epochs can no longer switch back and clear this usage. A
      // read error keeps the epochs known so far.
      const seq = nextEpochSeq();
      const [latestGlobal, latestModel] = await Promise.all([
        readEpochFileWithRetry(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global")),
        readEpochFileWithRetry(modelEpochPath(key), initialEpoch(`model:${key}`)),
      ]);
      if (latestGlobal.ok && acceptGlobalEpochRead(seq) && currentGlobalEpoch !== latestGlobal.epoch) {
        currentGlobalEpoch = latestGlobal.epoch;
        cacheStatsProcessByModel = {};
        modelEpochByKey.clear();
        voidModelEpochs(seq - 1);
      }
      if (latestModel.ok && acceptModelEpochReadForUsage(seq, key) && modelEpochByKey.get(key) !== latestModel.epoch) {
        delete cacheStatsProcessByModel[key];
        modelEpochByKey.set(key, latestModel.epoch);
      }
      modelApiByKey.set(key, statsModel.api ?? "");
      modelNameByKey.set(key, statsModel.name || statsModel.id);
      const sk = sessionModelKey(statsModel);
      addUsageToCacheStats(getOrCreateStatsByModelKey(sk), usage);
      addUsageToCacheStats(getOrCreateProcessStatsForModel(statsModel), usage);
      addUsageToCacheStats(getOrCreateTotalStatsForModel(statsModel), usage);
    } else {
      addUsageToCacheStats(getStatsForModel(undefined, adapter), usage);
    }

    schedulePersistCacheStats(ctx);
    // The counters above are already updated in memory; the refresh and the
    // footer update run in the background (Pi awaits message_end).
    refreshAndPublishInBackground(ctx, () => {
      // A late response from an older selection must not replace the active
      // footer. Only a routed response that still belongs to the currently
      // selected virtual/router model may publish its physical model directly.
      const responseBelongsToCurrentSelection =
        requestCorrelationForMessage.selectionModelKey !== undefined &&
        ctx.model !== undefined &&
        requestCorrelationForMessage.selectionModelKey === modelKey(ctx.model);
      return requestSelectionIsVirtual && responseBelongsToCurrentSelection ? statsModel : ctx.model;
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Register /cache-optimizer command
  // Subcommands:
  //   enable  — enable runtime prompt/cache optimizations for this process
  //   disable — disable runtime prompt/cache optimizations for this process
  //   doctor  — show current model/provider/api/baseUrl/compat status
  //             with low-hit diagnosis
  //   stats   — show detailed current-session models; `stats all` shows all local shards
  //   compat  — show compat suggestion with file path
  //   config footer-mode total|session|process — persist footer mode override
  //   fix     — auto-fix compat issues (writes models.json or extension config, requires UI)
  //   rollback — undo the latest confirmed fix for the active model
  //   reset   — reset current provider/model footer stats bucket (local only)
  //   (no args) — interactive menu (with UI) or help summary
  // ────────────────────────────────────────────────────────────────
  const handleCacheOptimizerCommand = createCacheOptimizerCommandHandler({
    syncSessionHash,
    resetCurrentSessionStats,
    resetStatsForModel,
    flushPersistCacheStats,
    publishStatus,
    refreshShardAggregate,
    sessionModelKey,
    getRecentSamples,
    promptCacheKeyFixApplies,
    buildCommandFixSuggestion,
    buildPromptCacheKeyConfigPreview,
    providerRequestStates,
    promptCacheRetention400Models,
    promptCacheKeyRejectedModels,
    anthropicTtlOrderErrorModels,
    sendSessionAffinityHeaders403Models,
    openAISdkHeader403Models,
    getCacheStatsTotalsByModel: () => cacheStatsTotalsByModel,
    getCurrentSessionHashSet: () => currentSessionHashSet,
    getCurrentSessionHash: () => currentSessionHash,
    getLastStatusText: () => lastStatusText,
    clearLastStatusText: () => { lastStatusText = undefined; },
    getCacheWarmingMode: () => readCacheWarmingMode(typeof pi.getSettings === "function" ? () => pi.getSettings() : undefined),
  });

  pi.registerCommand("cache-optimizer", {
    description: "Configure and diagnose Pi cache behavior",
    getArgumentCompletions: getCacheOptimizerArgumentCompletions,
    handler: async (args: string, cmdCtx: Parameters<typeof handleCacheOptimizerCommand>[1]) => {
      // Commands read and reset aggregated stats; let a background restore
      // finish first so they never act on a half-restored view.
      await waitForStatsRestore();
      return handleCacheOptimizerCommand(args, cmdCtx);
    },
  });
}
