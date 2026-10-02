import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { LOG_PREFIX, type ModelIdentity, type PiModel, type UnknownRecord, asRecord, getErrorCode, isNonEmptyString, isProcessAlive, lower, type MutableEnv } from "./src/common.ts";
import { FIX_RECEIPT_FILE_NAME, FIX_RECEIPT_PATH, MODELS_JSON_PATH, MODELS_TRANSACTION_LOCK_PATH, MODELS_TRANSACTION_LOCK_STALE_MS, MODELS_TRANSACTION_LOCK_WAIT_MS, STATE_DIR } from "./src/paths.ts";
import { type FixReceiptCompatChange, type FixReceiptPlacement, type FixSuggestion, type ModelsJsonFixReceiptV1, RECEIPT_COMPAT_KEYS, type ReceiptScalar, type ReceiptScalarState, isReceiptTimestamp, isSafeReceiptText, isSha256 } from "./src/fix-types.ts";
import { type JsonPropertyEdit, type ModelNodeLocation, deepEqualIgnoringKeys, deriveInnerIndent, findExistingCompatKeysInJsonc, findJsonObjectKey, findMatchingBracket, isJsonWhitespace, lineIndentOf, locateJsonPropertyValueSpan, locateModelOverrideInJsonc, locateProviderCompatInJsonc, parseJsonc, readJsonStringLiteral, skipJsonValue, skipJsonWhitespace, stripJsoncComments, stripJsoncTrailingCommas } from "./src/jsonc.ts";
import { type FileIdentity, atomicCreateTextFileNoReplace, atomicReplaceTextFilePreservingMode, atomicRestoreFileFromBackup, backupTimestamp, hashText, readRegularTextFile, sameFileIdentity, uniqueTempPath, validateAtomicTarget, withModelsJsonTransactionLock } from "./src/atomic-fs.ts";
import { getAssistantMessageModelTokenValues, getModelIdNameTokenValues, hasAnyTokenContaining, isAdaptiveGenerationModel, isKimiCodingAdaptiveModel, modelOrAssistantMessageHas } from "./src/model-detect.ts";
import { type CacheCompat, NESTED_COMPAT_KEYS, findLastExactModelDefinition, getEffectiveCompatSources, mergeCacheCompat, resolveEffectiveCompatFromConfig } from "./src/compat-config.ts";
import { analyzeModelsJsonForMissingEntry, applyModelsJsonFixTransaction, chooseFixPlacement, composeFixInsertion, composeMissingEntryInsertion, composeModelOverrideInsertion, composeModelsJsonReceiptRollback, composeProviderAffinityInsertion, createModelsJsonFixReceipt, createRollbackBackupPath, decideFixPlacement, formatCompatKeysForInsertion, formatMissingEntryManualSnippet, hasExplicitLongRetentionOptInFromConfig, hasReceiptReasoningProtocolChange, isActionableModelsJsonFixReceipt, locateModelInJsonc, markModelsJsonFixReceiptRolledBack, parseModelsJsonFixReceipt, prepareModelsJsonRollback, readModelsJsonFixReceipt, readModelsJsonFixReceiptSnapshot, receiptBackupPath, resolveExplicitCompatValue, selfCheckFix, selfCheckMissingEntryInsertion, validateModelsJsonRollback, writeModelsJsonFixReceipt } from "./src/models-json-fix.ts";
import { getNonNegativeNumber, getNumber } from "./src/common.ts";
import { CACHE_PROVIDER_IDS, type CacheProviderId, type CacheStats, LEGACY_STATE_FILE_PATH, type PersistedRoutedModelRef, type PersistedStatsShardV7, SHARD_FILES_DIR, SHARD_GLOBAL_EPOCH_PATH, SHARD_STATE_DIR, STATE_FILE_PATH, type ShardAggregate, type UsageSnapshot, addUsageToCacheStats, advanceGlobalStatsEpoch, advanceModelStatsEpoch, aggregateStatsShardsV7, cleanupStatsShardsV7, cloneCacheStats, currentLocalDay, emptyAllCacheStats, emptyCacheStats, initialEpoch, loadStatsShardAggregateV7, maybeCleanupStatsShardsV7, mergeCacheStatsForTotal, modelEpochPath, parseCacheStats, parsePersistedRoutedModelRef, parsePersistedStatsShardV7, readGlobalStatsEpoch, readModelStatsEpoch, readValidStatsShardsV7, removeLegacyStatsFiles, writeStatsShardV7 } from "./src/stats-store.ts";
import { ALEPH_MODEL_PATTERN, ARCTIC_MODEL_PATTERN, AYA_MODEL_PATTERN, DOUBAO_SEED_PATTERN, MIMO_MODEL_PATTERN, MPT_MODEL_PATTERN, NOVA_MODEL_PATTERN, ORION_MODEL_PATTERN, PHI_MODEL_PATTERN, PI_VIRTUAL_MODEL_API, PPLX_MODEL_PATTERN, ROUTED_FALLBACK_MODEL_SYMBOL, XAI_MODEL_PATTERN, YI_MODEL_PATTERN, getAssistantRecord, getCompat, isAnthropicMessagesApi, isAssistantMessage, isClaudeLikeAssistantMessage, isClaudeLikeModel, isDeepSeekLikeAssistantMessage, isDeepSeekLikeModel, isGeminiLikeAssistantMessage, isGeminiLikeModel, isKimiCodingEmptySignatureModel, isKnownThirdPartyOpenAIEndpoint, isMistralConversationsApi, isNativeVirtualModel, isOfficialOpenAIBaseUrl, isOpenAICompatibleApi, isOpenAICompatibleProxyApi, isOpenAIFamilyAssistantMessage, isOpenAIFamilyModel, isOpenAIFamilyToken, isPiBuiltInLlamaCppModel, isResponsesPromptRewriteBypassApi, isRoutedFallbackModel, isValidModelsConfigForEffectiveCompat, modelKey, readEffectiveCompatConfig } from "./src/model-identity.ts";
import { invalidateModelsConfigCache } from "./src/model-identity.ts";
import { getAnthropicRawUsage, getDeepSeekRawUsage, getGeminiRawUsage, getOpenAIRawUsage, normalizeWithFallback, usageRecordFromAssistant } from "./src/usage.ts";
import { CONFIG_FILE_PATH, NO_SKILL_COMPRESSION_ENV, VIRTUAL_REWRITE_ENV, FOOTER_MODE_ENV, type FooterStatsMode, NO_OPENAI_CACHE_KEY_ENV, type PersistedCacheOptimizerConfig, type PersistedCacheOptimizerConfigV2, type PersistedCacheOptimizerConfigV3, type PersistedCacheOptimizerFeature, TOOL_ORDER_ENV, featureEnabled, footerStatsMode, isEnabledEnv, isToolOrderEnabled, normalizePersistedCacheOptimizerConfig, parseFooterStatsMode, parsePersistedCacheOptimizerConfig, persistedCacheOptimizerConfig, persistedFooterStatsMode, readPersistedCacheOptimizerConfig, resolveFooterStatsMode, runtimeOptimizerEnabled, setPersistedCacheOptimizerConfig, shouldInjectOpenAIPromptCacheKey, writePersistedCacheOptimizerConfig, writePersistedFeature, writePersistedFooterMode } from "./src/config.ts";
import { LONG_CACHE_RETENTION_VALUE, PI_CACHE_RETENTION_BASELINE_SYMBOL, PI_CACHE_RETENTION_ENV, STARTUP_CACHE_RETENTION_ENV, captureCacheRetentionEnv, getOrCaptureCacheRetentionBaseline, requestLongCacheRetention, restoreCacheRetentionEnv } from "./src/retention.ts";
import { isRuntimeOptimizerEnabled, setRuntimeOptimizerEnabled } from "./src/config.ts";
import { compareToolOrderEntries, getToolNameForPayload, isKnownToolOrderApi, isToolOrderingEligibleModel, isVerifiedToolForApi, normalizeToolsInPayload, sortToolsInPayload } from "./src/tool-ordering.ts";
import { SKILL_COMPRESSION_MIN_COUNT, compressSkillsInSystemPrompt, compressSkillsViaSection, formatSkillsForPrompt, formatSkillsForPromptCompressed, stripSessionOverviewChurn, explainSkillCompressionSkip, recordSkillCompressionOutcome, getLastSkillCompressionOutcome, describeSkillCompressionOutcome } from "./src/prompt-rewrite.ts";
import { addEffectiveSessionAffinityHeaders, addOpenAIPromptCacheKey, clampPromptCacheKey, collectAnthropicCacheControlsInWireOrder, downgradeAnthropicLongCacheControls, getEffectiveCompatValueSource, hasAnthropicCacheTtlOrderError, hasEffectivePromptCacheKey, isPromptCacheKeyOmittedForModel, normalizeAnthropicCacheControlTtlOrder, omitOpenAIPromptCacheKeys, shouldInjectOpenAIPromptCacheKeyForModel } from "./src/request-payload.ts";
import { PI_CACHE_HINTS_SYMBOL, PI_ROUTING_REGISTRY_SYMBOL, type PiCacheHintsInput, type PiCacheHintsOutput, type PiCacheHintsV1, applyConfiguredTransportToModel, canRewriteNativeVirtualPrompt, describeNativeVirtualRouteNote, ensureRoutingRegistry, findModelInRegistry, findNativeVirtualDispatches, firstNonEmptyString, getProtocolGlobal, getProviderPayloadModelId, getRoutingRegistry, hashSessionId, installCacheHintsService, isRouterModel, nativeVirtualDispatchFromMessage, nativeVirtualDispatchToModel, parseRouteSnapshot, resolveActiveRouteSnapshot, resolveNativeVirtualRequestModel, resolveNativeVirtualRouteModel, resolveRouteModel, routeSnapshotToPiModel, sessionHashFromContext } from "./src/routing.ts";
import { CONFIG_RECEIPT_PATH, type PromptCacheKeyConfigReceipt, type PromptCacheKeyConfigReceiptSnapshot, applyPromptCacheKeyConfigFix, configReceiptBackupPath, parsePromptCacheKeyConfigReceipt, rollbackPromptCacheKeyConfig, writePromptCacheKeyConfigReceipt } from "./src/prompt-cache-key-config.ts";
import { type CompatAdvicePlacement, appendCredentialSafeProviderGuidance, appendDeepSeekCompatAdviceLines, appendOpenAIProxyCompatAdviceLines, buildDeepSeekCompatSuggestion, buildDeepSeekCompatWarningText, buildModelCompatOverride, buildOpenAIProxyCompatWarningText, buildProviderCompatOverride, buildSafeOpenAIProxyCompatSuggestion, describeMissingAdaptiveThinkingCompat, describeMissingCacheCompatForModel, describeMissingDeepSeekCompat, describeMissingOpenAICompatibleProxyCompat, getAgentDirDisplayPath, getModelsJsonDisplayPath, isAdaptiveThinkingCompatApplicable, isDeepSeekWireCompatApplicable } from "./src/compat-advice.ts";
import { type CacheProviderAdapter, isVirtualRoutingModel, modelFromAssistantMessage, selectAdapterForAssistantMessage, selectAdapterForModel } from "./src/adapters.ts";
import { describeMissingOpenAIFamilyProxyCompat } from "./src/compat-advice.ts";
import { type CacheUsageSample, buildAllStatsOutput, buildContributorsStatsOutput, buildSessionStatsOutput, buildStatsOutput, deriveTotalsByModelFromSessionStats, filterRestorableStatsForSession, formatCacheStats, formatCompactStats, formatHitRatio, formatRecentTrendSummary, formatTokenM, hasMissingUsageFields, makeSessionModelKey, mergeCacheSessions, mergeCacheTotals, mergeLastRoutedModels, modelKeyFromSessionKey, parsePersistedCacheStats, parsePersistedTotalsByModel, prefixFooterStatus, readPersistedCacheStats, routedModelRefToPiModel, selectFooterStatsForModel, writePersistedCacheStats } from "./src/stats-report.ts";
import { appendAdaptiveThinkingCompatAdviceLines, buildAdaptiveThinkingCompatSuggestion, buildCompatDiagnosis, buildDoctorDiagnosis, buildFixSuggestion, buildLowHitDiagnosis, describeOptionalOpenAICompatibleProxyCompat, describeRouterChannelDiagnostics, getCompatCheckNotApplicableLines, getOptionalAssistantHttpStatus, getPromptCacheRetentionUnsupportedHint, isCompatCheckApplicable, isDeepSeekCompatCheckApplicable, isOpenAISdkHeader403Applicable, isPromptCacheKeyUnsupportedApplicable, isPromptCacheRetention400Applicable, isSessionAffinity403Applicable } from "./src/diagnostics.ts";
import { REASONING_PROTOCOL_FALLBACK_SYMBOL, buildReasoningProtocolFixSuggestion, getAnthropicTtlFallbackState, getReasoningProtocolFallbackState, hasExplicitDeepSeekReasoningProtocol, hasPromptCacheKeyUnsupportedErrorMessage, hasPromptCacheKeyUnsupportedText, hasPromptCacheRetentionUnsupportedErrorMessage, hasPromptCacheRetentionUnsupportedText, hasReasoningProtocolRejectionErrorMessage, hasReasoningProtocolRejectionText, isExplicitPromptCacheRetentionUnsupportedApplicable, isReasoningProtocolRejectionForModel, isReasoningProtocolRejectionSignalApplicable, mergeFixSuggestions, notifyReasoningProtocolObservation } from "./src/provider-errors.ts";
import { hasPromptCacheKeyUnsupportedSignal, hasPromptCacheRetentionUnsupportedSignal, hasReasoningProtocolRejectionSignal } from "./src/provider-errors.ts";
import { MAX_RECENT_SAMPLES, buildExactRouterStatusEntry, consolidateDirectProviderStatsModel, createSerializedAsyncRunner, findBestRouterModelStats, keyForModelExt } from "./src/stats-report.ts";
import { type PiCacheHintSnapshot, getCacheHintsService, getSessionPromptCacheKey, isOptimizerOwnedCacheHintsService, markOptimizerOwnedCacheHintsService } from "./src/routing.ts";
import { isActionablePromptCacheKeyConfigReceipt, readPromptCacheKeyConfigReceipt, readPromptCacheKeyConfigReceiptSnapshot } from "./src/prompt-cache-key-config.ts";
import { formatOptimizerRuntimeMode, formatPersistentFeatureConfig, getOptimizerRuntimeModeLines, readPersistedFooterMode } from "./src/config.ts";
import { FEATURE_COMMAND_MAP, getCacheOptimizerArgumentCompletions } from "./src/command-completion.ts";
import { MAX_PROVIDER_REQUEST_STATES, pruneProviderRequestStates, snapshotProviderRequestModel } from "./src/request-state.ts";
import { NO_PROMPT_REWRITE_ENV } from "./src/config.ts";
import { createCacheOptimizerCommandHandler } from "./src/command.ts";
import { type ProviderRequestState } from "./src/request-state.ts";

const STATUS_KEY = "pi-cache-stats";

type PersistedCacheStatsV2 = {
  version: 2;
  statsByProvider: Partial<Record<CacheProviderId, CacheStats>>;
};

type PersistedCacheStatsV3 = {
  version: 3;
  statsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
};

/**
 * V4 format: session-scoped stats buckets.
 * Each Pi process/session gets its own stats isolated by a hashed session id.
 *
 * sessions: sessionHash → modelKey (provider/id) → CacheStats
 * legacyFamily: unchanged from v3 (migration/fallback when ctx.model is unknown)
 */
type PersistedCacheStatsV4 = {
  version: 4;
  sessions: Record<string, Record<string, CacheStats>>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
};

type PersistedCacheStatsV5 = {
  version: 5;
  sessions: Record<string, Record<string, CacheStats>>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>;
};

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
export const __internals_for_tests = {
  getLastSkillCompressionOutcome,
  describeSkillCompressionOutcome,
  stripSessionOverviewChurn,
  formatSkillsForPrompt,
  formatSkillsForPromptCompressed,
  compressSkillsInSystemPrompt,
  SKILL_COMPRESSION_MIN_COUNT,
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
  let shardWatcher: ReturnType<typeof watch> | undefined;
  const enqueuePersist = createSerializedAsyncRunner();
  const instanceId = randomUUID();
  const instanceStartedAt = Date.now();
  const instanceShardPath = join(SHARD_FILES_DIR, `${instanceId}.json`);
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
      if (!runtimeOptimizerEnabled || isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV])) return undefined;
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

  async function refreshShardAggregate(): Promise<ShardAggregate> {
    const persistedShards = await readValidStatsShardsV7();
    const shards = persistedShards.filter((shard) => shard.instanceId !== instanceId);
    if (currentSessionHashSet) shards.push(buildCurrentStatsShard());
    const aggregate = await aggregateStatsShardsV7(shards);

    // A reset from another process can advance epochs while this instance is
    // idle. Adopt those epochs during every aggregate refresh, not only when a
    // later message_end arrives, so this instance cannot keep an old in-memory
    // process bucket visible in `process` mode or rewrite stale counters during
    // shutdown. Model-scoped resets clear only the affected local bucket.
    const latestGlobalEpoch = await readGlobalStatsEpoch();
    if (currentGlobalEpoch !== latestGlobalEpoch) {
      currentGlobalEpoch = latestGlobalEpoch;
      cacheStatsProcessByModel = {};
      modelEpochByKey.clear();
      modelApiByKey.clear();
      modelNameByKey.clear();
      lastActualRoutedModel = undefined;
    } else {
      for (const key of Object.keys(cacheStatsProcessByModel)) {
        const latestModelEpoch = await readModelStatsEpoch(key);
        if ((modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`)) === latestModelEpoch) continue;
        delete cacheStatsProcessByModel[key];
        modelEpochByKey.set(key, latestModelEpoch);
        modelApiByKey.delete(key);
        modelNameByKey.delete(key);
      }
    }

    cacheStatsByModel = {};
    for (const [sessionHash, models] of Object.entries(aggregate.bySession)) {
      for (const [key, stats] of Object.entries(models)) {
        cacheStatsByModel[`${sessionHash}:${key}`] = stats;
      }
    }
    cacheStatsTotalsByModel = aggregate.totalsByModel;
    if (currentSessionHashSet) {
      lastActualRoutedModel = aggregate.lastRoutedModelBySession[currentSessionHash];
    }
    lastStatusText = undefined;
    return aggregate;
  }

  async function ensureCurrentEpochs(): Promise<void> {
    currentGlobalEpoch = await readGlobalStatsEpoch();
    for (const key of Object.keys(cacheStatsProcessByModel)) {
      modelEpochByKey.set(key, await readModelStatsEpoch(key));
    }
  }

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
    return {
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
      day: currentLocalDay(),
      globalEpoch: currentGlobalEpoch,
      models,
      ...(lastActualRoutedModel ? { lastRoutedModel: { ...lastActualRoutedModel } } : {}),
    };
  }

  function scheduleShardRefresh(ctx?: ExtensionContext, model?: PiModel): void {
    if (shardRefreshTimer !== null) clearTimeout(shardRefreshTimer);
    shardRefreshTimer = setTimeout(() => {
      shardRefreshTimer = null;
      void refreshShardAggregate()
        .then(() => publishStatus(ctx as ExtensionContext, model ?? ctx?.model))
        .catch(() => undefined);
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
    return enqueuePersist(async () => {
      try {
        await writeStatsShardV7(instanceShardPath, shard);
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
      void persistCacheStats(ctx).then(() => refreshShardAggregate()).catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  async function flushPersistCacheStats(ctx?: ExtensionContext, lifecycleState: "active" | "closed" = "active"): Promise<void> {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    // Adopt resets performed by another Pi process before capturing the shard
    // snapshot. Otherwise shutdown/command flush could rewrite stale local
    // counters under an old epoch even though aggregation already hid them.
    await refreshShardAggregate();
    await persistCacheStats(ctx, lifecycleState);
    await refreshShardAggregate();
  }

  async function rollOverStatsIfNeeded(ctx?: ExtensionContext): Promise<void> {
    const day = currentLocalDay();
    let changed = false;
    for (const key of Object.keys(cacheStatsProcessByModel)) {
      if (cacheStatsProcessByModel[key]?.day !== day) {
        cacheStatsProcessByModel[key] = emptyCacheStats(day);
        changed = true;
      }
    }
    for (const id of CACHE_PROVIDER_IDS) {
      const stats = cacheStatsLegacyFamily[id];
      if (stats && stats.day !== day) {
        cacheStatsLegacyFamily[id] = emptyCacheStats(day);
        changed = true;
      }
    }
    if (changed) {
      shardCreatedAt = Date.now();
      lastStatusText = undefined;
      await ensureCurrentEpochs();
      await flushPersistCacheStats(ctx);
    }
  }

  async function restoreCacheStats(reason: string, ctx: ExtensionContext): Promise<void> {
    syncSessionHash(ctx);
    lastStatusText = undefined;
    cacheStatsProcessByModel = {};
    cacheStatsLegacyFamily = emptyAllCacheStats();
    modelEpochByKey.clear();
    modelApiByKey.clear();
    modelNameByKey.clear();
    currentGlobalEpoch = await readGlobalStatsEpoch();
    if (reason === "reload") {
      clearRecentSamples();
    }
    await removeLegacyStatsFiles();
    await mkdir(SHARD_FILES_DIR, { recursive: true });
    await refreshShardAggregate();
    await flushPersistCacheStats(ctx);
    await maybeCleanupStatsShardsV7();
    // Maintenance may remove expired shard files after the initial refresh.
    // Re-scan before publishing so startup/footer command state cannot retain
    // counters from files that no longer exist.
    await refreshShardAggregate();
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
    return hasExplicitLongRetentionOptInFromConfig(
      readEffectiveCompatConfig(),
      model.provider,
      model.id,
    );
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
    await restoreCacheStats(event.reason, ctx);
    if (ctx.mode === "tui" && !shardWatcher) {
      try {
        shardWatcher = watch(SHARD_FILES_DIR, () => scheduleShardRefresh(ctx));
        shardWatcher.unref?.();
      } catch {
        // Lifecycle and explicit command refreshes remain authoritative.
      }
    }
    await publishStatus(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Pi 0.99+ codemode scripts run nested tool calls in parallel; the calling
    // tool's own end event follows them, so one refresh covers the batch.
    if (isNonEmptyString((event as { parentToolCallId?: unknown } | undefined)?.parentToolCallId)) return;
    await refreshShardAggregate();
    await publishStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refreshShardAggregate();
    await publishStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await flushPersistCacheStats(ctx, "closed");
    } finally {
      if (shardRefreshTimer !== null) clearTimeout(shardRefreshTimer);
      shardRefreshTimer = null;
      shardWatcher?.close();
      shardWatcher = undefined;
      latestCacheHint = undefined;
      providerRequestStates.length = 0;
      delete getProtocolGlobal().__piCacheOptimizerCacheKey__;
      uninstallCacheHintsService();
      restoreCacheRetentionEnv(STARTUP_CACHE_RETENTION_ENV);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (runtimeOptimizerEnabled) notifyCacheCompatIfNeeded(resolveRouteModel(event.model, ctx) ?? event.model, ctx, warnedModels);
    await refreshShardAggregate();
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

    // Skill compression first, as a section edit when Pi supports it (see
    // compressSkillsViaSection); the string path below is the fallback.
    const skillsViaSection = compressSkillsViaSection(event);

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
    const compressedPrompt = compressSkillsInSystemPrompt(
      strippedPrompt,
      event.systemPromptOptions,
    );
    // With a section edit and nothing to strip, Pi renders the compressed prompt
    // itself and no forced prompt is returned.
    recordSkillCompressionOutcome(
      skillsViaSection
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

    // Anthropic rejects mixed cache breakpoints when a 1h block appears after
    // a 5m/default block in wire order (tools → system → messages). Repair any
    // conflict visible in Pi's final payload immediately. Some proxies inject
    // hidden short breakpoints after this hook; only models that have actually
    // returned the explicit TTL-order error receive the process-local 5m fallback.
    if (requestModel && isAnthropicMessagesApi(requestModel.api)) {
      const visibleConflictFixed = normalizeAnthropicCacheControlTtlOrder(requestPayload);
      if (!visibleConflictFixed && anthropicTtlOrderErrorModels.has(modelKey(requestModel))) {
        downgradeAnthropicLongCacheControls(requestPayload);
      }
    }

    // ── Safety: strip prompt_cache_retention from payload for models that
    // are not authorised to send it. Pi defaults supportsLongCacheRetention
    // to true for all openai-completions models, but most third-party APIs
    // reject the parameter with 400 “Extra inputs are not permitted”.
    //
    // Gate order (first match wins):
    //   1. Official OpenAI          → keep (trusted to support it)
    //   2. 400 history              → strip (empirical evidence overrides user config)
    //   3. Explicit opt-in in models.json → keep (user explicitly wants it)
    //   4. Everything else          → strip (safe default for third-party APIs)
    //
    // Gate 2 before Gate 3 is critical: if a user explicitly opted in but
    // the API returned 400, we must strip — otherwise the 400 repeats forever.
    if (runtimeOptimizerEnabled) {
      const payloadRecord = asRecord(requestPayload);
      if (payloadRecord && typeof payloadRecord.prompt_cache_retention === "string") {
        if (requestModel) {
          if (isOfficialOpenAIBaseUrl(requestModel)) {
            // Gate 1: Official OpenAI → keep
          } else if (promptCacheRetention400Models.has(modelKey(requestModel))) {
            // Gate 2: 400 history → strip (overrides user opt-in)
            delete payloadRecord.prompt_cache_retention;
          } else if (hasExplicitLongRetentionOptIn(requestModel)) {
            // Gate 3: Explicit user opt-in → keep
          } else {
            // Gate 4: Safe default → strip
            delete payloadRecord.prompt_cache_retention;
          }
        }
      }
    }

    if (isPromptCacheKeyOmittedForModel(requestModel)) {
      const omitted = omitOpenAIPromptCacheKeys(requestPayload);
      return omitted ?? (toolOrderChanged ? requestPayload : undefined);
    }

    if (!shouldInjectOpenAIPromptCacheKey() || !shouldInjectOpenAIPromptCacheKeyForModel(requestModel)) {
      return toolOrderChanged ? requestPayload : undefined;
    }

    const withCacheKey = addOpenAIPromptCacheKey(requestPayload, getSessionPromptCacheKey(ctx));
    return withCacheKey ?? (toolOrderChanged ? requestPayload : undefined);
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
        const explicitModel = modelFromAssistantMessage(event.message, undefined);
        const explicitIndex = explicitModel
          ? providerRequestStates.findIndex((state) => modelKey(state.model) === modelKey(explicitModel))
          : -1;
        const completedIndex = providerRequestStates.findIndex((state) => state.responseReceived);
        const contextModel = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
        const contextIndex = contextModel && !providerRequestStates.some((state) => state.correlationAmbiguous)
          ? providerRequestStates.findIndex((state) => modelKey(state.model) === modelKey(contextModel))
          : -1;
        const index = explicitIndex >= 0
          ? explicitIndex
          : (completedIndex >= 0 ? completedIndex : (contextIndex >= 0 ? contextIndex : 0));
        const state = providerRequestStates.splice(index, 1)[0];
        if (!state) return { model: undefined, ambiguous: false };
        const ambiguous = (state.correlationAmbiguous || state.identityAmbiguous === true) && explicitIndex < 0;
        return {
          model: ambiguous ? undefined : state.model,
          ambiguous,
        };
      })()
      : { model: undefined, ambiguous: false };
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
      if (isReasoningProtocolRejectionForModel(event.message, errorModel)) {
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

    const adapter = selectAdapterForAssistantMessage(event.message, nativeVirtualMessageModel ?? ctx.model);
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

    // Completed message metadata is request-local and authoritative for virtual
    // routing providers. Use it whenever it supplies provider/model identity;
    // fall back to the active context model for direct providers.
    let statsModel = modelFromAssistantMessage(event.message, ctx.model) ?? ctx.model;
    // For direct (non-virtual-routing) providers, the upstream API may echo a
    // normalized/renamed model id in its response (e.g. request
    // `zai-org/GLM-5.2-FP8` but the message carries `GLM5.2-FP8`). Writing
    // stats under the echoed name fragments the bucket away from the
    // active-model key the footer reads, showing 0% even when the backend is
    // hitting cache. When the response model drifts from the active model only
    // in name (same provider, same cache adapter), consolidate stats back to
    // the active model id. Virtual routing providers keep message-local
    // identity (router correctness).
    statsModel = consolidateDirectProviderStatsModel(statsModel, ctx.model, ctx);
    if (nativeVirtualMessageModel) statsModel = nativeVirtualMessageModel;
    let routedModelChanged = false;
    if (isVirtualRoutingModel(ctx.model, ctx) && statsModel && !isVirtualRoutingModel(statsModel, ctx)) {
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
      const latestGlobalEpoch = await readGlobalStatsEpoch();
      const latestModelEpoch = await readModelStatsEpoch(key);
      if (currentGlobalEpoch !== latestGlobalEpoch) {
        currentGlobalEpoch = latestGlobalEpoch;
        cacheStatsProcessByModel = {};
        modelEpochByKey.clear();
      }
      if (modelEpochByKey.get(key) !== latestModelEpoch) {
        delete cacheStatsProcessByModel[key];
        modelEpochByKey.set(key, latestModelEpoch);
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
    await refreshShardAggregate();
    await publishStatus(ctx, statsModel);
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
  });

  pi.registerCommand("cache-optimizer", {
    description: "Configure and diagnose Pi cache behavior",
    getArgumentCompletions: getCacheOptimizerArgumentCompletions,
    handler: handleCacheOptimizerCommand,
  });
}
