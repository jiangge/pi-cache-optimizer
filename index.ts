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
import { LOG_PREFIX, type ModelIdentity, type PiModel, type UnknownRecord, asRecord, getErrorCode, isNonEmptyString, isProcessAlive, lower } from "./src/common.ts";
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
import { CONFIG_FILE_PATH, FOOTER_MODE_ENV, type FooterStatsMode, type MutableEnv, NO_OPENAI_CACHE_KEY_ENV, type PersistedCacheOptimizerConfig, type PersistedCacheOptimizerConfigV2, type PersistedCacheOptimizerConfigV3, type PersistedCacheOptimizerFeature, TOOL_ORDER_ENV, featureEnabled, footerStatsMode, isEnabledEnv, isToolOrderEnabled, normalizePersistedCacheOptimizerConfig, parseFooterStatsMode, parsePersistedCacheOptimizerConfig, persistedCacheOptimizerConfig, persistedFooterStatsMode, readPersistedCacheOptimizerConfig, resolveFooterStatsMode, runtimeOptimizerEnabled, setPersistedCacheOptimizerConfig, shouldInjectOpenAIPromptCacheKey, writePersistedCacheOptimizerConfig, writePersistedFeature, writePersistedFooterMode } from "./src/config.ts";
import { LONG_CACHE_RETENTION_VALUE, PI_CACHE_RETENTION_BASELINE_SYMBOL, PI_CACHE_RETENTION_ENV, STARTUP_CACHE_RETENTION_ENV, captureCacheRetentionEnv, getOrCaptureCacheRetentionBaseline, requestLongCacheRetention, restoreCacheRetentionEnv } from "./src/retention.ts";
import { isRuntimeOptimizerEnabled, setRuntimeOptimizerEnabled } from "./src/config.ts";
import { compareToolOrderEntries, getToolNameForPayload, isKnownToolOrderApi, isToolOrderingEligibleModel, isVerifiedToolForApi, normalizeToolsInPayload, sortToolsInPayload } from "./src/tool-ordering.ts";
import { NO_SKILL_COMPRESSION_ENV, SKILL_COMPRESSION_MIN_COUNT, compressSkillsInSystemPrompt, compressSkillsViaSection, formatSkillsForPrompt, formatSkillsForPromptCompressed, stripSessionOverviewChurn } from "./src/prompt-rewrite.ts";
import { addEffectiveSessionAffinityHeaders, addOpenAIPromptCacheKey, clampPromptCacheKey, collectAnthropicCacheControlsInWireOrder, downgradeAnthropicLongCacheControls, getEffectiveCompatValueSource, hasAnthropicCacheTtlOrderError, hasEffectivePromptCacheKey, isPromptCacheKeyOmittedForModel, normalizeAnthropicCacheControlTtlOrder, omitOpenAIPromptCacheKeys, shouldInjectOpenAIPromptCacheKeyForModel } from "./src/request-payload.ts";
import { PI_CACHE_HINTS_SYMBOL, PI_ROUTING_REGISTRY_SYMBOL, type PiCacheHintsInput, type PiCacheHintsOutput, type PiCacheHintsV1, VIRTUAL_REWRITE_ENV, applyConfiguredTransportToModel, canRewriteNativeVirtualPrompt, describeNativeVirtualRouteNote, ensureRoutingRegistry, findModelInRegistry, findNativeVirtualDispatches, firstNonEmptyString, getProtocolGlobal, getProviderPayloadModelId, getRoutingRegistry, hashSessionId, installCacheHintsService, isRouterModel, nativeVirtualDispatchFromMessage, nativeVirtualDispatchToModel, parseRouteSnapshot, resolveActiveRouteSnapshot, resolveNativeVirtualRequestModel, resolveNativeVirtualRouteModel, resolveRouteModel, routeSnapshotToPiModel, sessionHashFromContext } from "./src/routing.ts";
import { CONFIG_RECEIPT_PATH, type PromptCacheKeyConfigReceipt, type PromptCacheKeyConfigReceiptSnapshot, applyPromptCacheKeyConfigFix, configReceiptBackupPath, parsePromptCacheKeyConfigReceipt, rollbackPromptCacheKeyConfig, writePromptCacheKeyConfigReceipt } from "./src/prompt-cache-key-config.ts";
import { type CompatAdvicePlacement, appendCredentialSafeProviderGuidance, appendDeepSeekCompatAdviceLines, appendOpenAIProxyCompatAdviceLines, buildDeepSeekCompatSuggestion, buildDeepSeekCompatWarningText, buildModelCompatOverride, buildOpenAIProxyCompatWarningText, buildProviderCompatOverride, buildSafeOpenAIProxyCompatSuggestion, describeMissingAdaptiveThinkingCompat, describeMissingCacheCompatForModel, describeMissingDeepSeekCompat, describeMissingOpenAICompatibleProxyCompat, getAgentDirDisplayPath, getModelsJsonDisplayPath, isAdaptiveThinkingCompatApplicable, isDeepSeekWireCompatApplicable } from "./src/compat-advice.ts";
import { type CacheProviderAdapter, isVirtualRoutingModel, modelFromAssistantMessage, selectAdapterForAssistantMessage, selectAdapterForModel } from "./src/adapters.ts";

const STATUS_KEY = "pi-cache-stats";

const NO_PROMPT_REWRITE_ENV = "PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE";
const PI_CACHE_HINTS_OWNER_SYMBOL = Symbol.for("pi.cache.optimizer.hints-owner.v1");
const ANTHROPIC_TTL_FALLBACK_SYMBOL = Symbol.for("pi.cache.optimizer.anthropic-ttl-fallback.v1");
const REASONING_PROTOCOL_FALLBACK_SYMBOL = Symbol.for("pi.cache.optimizer.reasoning-protocol-fallback.v1");

type AnthropicTtlFallbackStateV1 = {
  version: 1;
  modelKeys: Set<string>;
  warnedModelKeys: Set<string>;
};

type ReasoningProtocolFallbackStateV1 = {
  version: 1;
  modelKeys: Set<string>;
  warnedModelKeys: Set<string>;
};

function getReasoningProtocolFallbackState(): ReasoningProtocolFallbackStateV1 {
  const globals = globalThis as Record<symbol, unknown>;
  const existing = globals[REASONING_PROTOCOL_FALLBACK_SYMBOL] as Partial<ReasoningProtocolFallbackStateV1> | undefined;
  if (
    existing?.version === 1 &&
    existing.modelKeys instanceof Set &&
    existing.warnedModelKeys instanceof Set
  ) {
    return existing as ReasoningProtocolFallbackStateV1;
  }
  const state: ReasoningProtocolFallbackStateV1 = {
    version: 1,
    modelKeys: new Set<string>(),
    warnedModelKeys: new Set<string>(),
  };
  globals[REASONING_PROTOCOL_FALLBACK_SYMBOL] = state;
  return state;
}

function getAnthropicTtlFallbackState(): AnthropicTtlFallbackStateV1 {
  const globals = globalThis as Record<symbol, unknown>;
  const existing = globals[ANTHROPIC_TTL_FALLBACK_SYMBOL] as Partial<AnthropicTtlFallbackStateV1> | undefined;
  if (
    existing?.version === 1 &&
    existing.modelKeys instanceof Set &&
    existing.warnedModelKeys instanceof Set
  ) {
    return existing as AnthropicTtlFallbackStateV1;
  }
  const state: AnthropicTtlFallbackStateV1 = {
    version: 1,
    modelKeys: new Set<string>(),
    warnedModelKeys: new Set<string>(),
  };
  globals[ANTHROPIC_TTL_FALLBACK_SYMBOL] = state;
  return state;
}

type PersistedCacheStatsV2 = {
  version: 2;
  statsByProvider: Partial<Record<CacheProviderId, CacheStats>>;
};

type PiCacheHintSnapshot = PiCacheHintsInput & PiCacheHintsOutput & {
  timestamp: number;
};

type CacheStatsState = {
  statsByModel: Record<string, CacheStats>;
  totalsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>;
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

type PersistedCacheStatsV6 = {
  version: 6;
  sessions: Record<string, Record<string, CacheStats>>;
  totalsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>;
};

type CacheUsageSample = {
  timestamp: number;
  hit: boolean;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
  missingUsageFields: boolean;
};

/** Maximum number of recent samples kept per model key (in-memory only, not persisted). */
const MAX_RECENT_SAMPLES = 50;

function getSessionPromptCacheKey(ctx: ExtensionContext): string | undefined {
  return clampPromptCacheKey(ctx.sessionManager.getSessionId());
}

function isCacheHintsServiceV1(value: unknown): value is PiCacheHintsV1 {
  const record = asRecord(value);
  return !!record && record.version === 1 && typeof record.getHints === "function";
}

function getCacheHintsService(): PiCacheHintsV1 | undefined {
  const candidate = getProtocolGlobal()[PI_CACHE_HINTS_SYMBOL];
  return isCacheHintsServiceV1(candidate) ? candidate : undefined;
}

function markOptimizerOwnedCacheHintsService(service: PiCacheHintsV1): PiCacheHintsV1 {
  (service as PiCacheHintsV1 & Record<symbol, unknown>)[PI_CACHE_HINTS_OWNER_SYMBOL] = true;
  return service;
}

function isOptimizerOwnedCacheHintsService(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<symbol, unknown>)[PI_CACHE_HINTS_OWNER_SYMBOL] === true;
}

/**
 * Build a session-scoped stats key from a session hash + provider/id.
 * Pure function (no closure dependency) for use by tests and internals.
 */
function makeSessionModelKey(sessionHash: string, provider: string, id: string): string {
  return `${sessionHash}:${provider}/${id}`;
}

/**
 * Extract the user-facing model key from a session-scoped key.
 * "abc123:otokapi/gpt-5.5" → "otokapi/gpt-5.5"
 */
function modelKeyFromSessionKey(sessionModelKey: string): string {
  const idx = sessionModelKey.indexOf(":");
  return idx >= 0 ? sessionModelKey.slice(idx + 1) : sessionModelKey;
}

type CommandCompletionItem = {
  value: string;
  label: string;
  description?: string;
};

const CACHE_OPTIMIZER_COMMANDS = [
  "enable",
  "disable",
  "doctor",
  "stats",
  "config",
  "compat",
  "reset",
  "fix",
  "rollback",
] as const;
const CACHE_OPTIMIZER_CONFIG_ARGUMENTS = ["footer-mode", "prompt-rewrite", "virtual-rewrite", "skill-compression", "openai-cache-key", "tool-order", "reset"] as const;
const CACHE_OPTIMIZER_FEATURE_COMMANDS = ["prompt-rewrite", "virtual-rewrite", "skill-compression", "openai-cache-key", "tool-order"] as const;
const CACHE_OPTIMIZER_FEATURE_VALUES = ["on", "off"] as const;
const CACHE_OPTIMIZER_FOOTER_MODES = ["total", "session", "process"] as const;
const FEATURE_COMMAND_MAP: Record<string, PersistedCacheOptimizerFeature> = {
  "prompt-rewrite": "promptRewrite",
  "virtual-rewrite": "virtualRewrite",
  "skill-compression": "skillCompression",
  "openai-cache-key": "openAICacheKey",
  "tool-order": "toolOrder",
};
const CACHE_OPTIMIZER_STATS_ARGUMENTS = ["all", "contributors"] as const;
const CACHE_OPTIMIZER_FIX_ARGUMENTS = ["prompt-cache-key"] as const;

function filterCommandCompletionItems(
  values: readonly string[],
  prefix: string,
  argumentPath = "",
): CommandCompletionItem[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const matches = values
    .filter((value) => value.startsWith(normalizedPrefix))
    .map((value) => ({
      // Pi replaces the complete argumentPrefix when applying a command
      // completion, so nested suggestions must include their full path.
      value: argumentPath ? `${argumentPath} ${value}` : value,
      label: value,
    }));
  return matches.length > 0 ? matches : null;
}

function getCacheOptimizerArgumentCompletions(argumentPrefix: string): CommandCompletionItem[] | null {
  if (typeof argumentPrefix !== "string") return null;
  const trimmed = argumentPrefix.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];

  if (parts.length === 0) {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_COMMANDS, "");
  }

  if (parts.length === 1) {
    const subcommandPrefix = parts[0].toLowerCase();
    // `config` is the primary `c` completion; `compat` remains available
    // through its more specific `co` prefix. Surrounding whitespace is
    // ignored so ` c ` behaves the same as `c`.
    if (subcommandPrefix === "c") {
      return [{ value: "config", label: "config" }];
    }
    if (subcommandPrefix === "config") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_CONFIG_ARGUMENTS, "", "config");
    }
    if (subcommandPrefix === "stats") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_STATS_ARGUMENTS, "", "stats");
    }
    return filterCommandCompletionItems(CACHE_OPTIMIZER_COMMANDS, parts[0]);
  }

  if (parts[0].toLowerCase() === "stats") {
    return parts.length === 2
      ? filterCommandCompletionItems(CACHE_OPTIMIZER_STATS_ARGUMENTS, parts[1], "stats")
      : null;
  }

  if (parts[0].toLowerCase() === "fix") {
    return parts.length === 2
      ? filterCommandCompletionItems(CACHE_OPTIMIZER_FIX_ARGUMENTS, parts[1], "fix")
      : null;
  }

  if (parts[0].toLowerCase() !== "config") return null;

  if (parts.length === 2) {
    const nestedPrefix = parts[1].toLowerCase();
    if (nestedPrefix === "footer-mode") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_FOOTER_MODES, "", "config footer-mode");
    }
    return filterCommandCompletionItems(CACHE_OPTIMIZER_CONFIG_ARGUMENTS, parts[1], "config");
  }

  if (parts.length === 3 && parts[1].toLowerCase() === "footer-mode") {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_FOOTER_MODES, parts[2], "config footer-mode");
  }
  if (parts.length === 3 && CACHE_OPTIMIZER_FEATURE_COMMANDS.includes(parts[1] as typeof CACHE_OPTIMIZER_FEATURE_COMMANDS[number])) {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_FEATURE_VALUES, parts[2], `config ${parts[1]}`);
  }

  return null;
}

function readPersistedFooterMode(configPath: string = CONFIG_FILE_PATH): FooterStatsMode | undefined {
  return readPersistedCacheOptimizerConfig(configPath).footerMode;
}

function isActionablePromptCacheKeyConfigReceipt(receipt: PromptCacheKeyConfigReceipt | undefined): receipt is PromptCacheKeyConfigReceipt {
  return receipt !== undefined && receipt.status === undefined;
}

async function readPromptCacheKeyConfigReceiptSnapshot(
  receiptPath: string = CONFIG_RECEIPT_PATH,
): Promise<PromptCacheKeyConfigReceiptSnapshot | undefined> {
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    const text = await readFile(receiptPath, "utf8");
    const afterRead = await lstat(receiptPath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || !sameFileIdentity(info, afterRead)) return undefined;
    const receipt = parsePromptCacheKeyConfigReceipt(JSON.parse(text));
    if (!receipt) return undefined;
    return { receipt, receiptPath, hash: hashText(text), identity: afterRead };
  } catch {
    return undefined;
  }
}

async function readPromptCacheKeyConfigReceipt(receiptPath: string = CONFIG_RECEIPT_PATH): Promise<PromptCacheKeyConfigReceipt | undefined> {
  return (await readPromptCacheKeyConfigReceiptSnapshot(receiptPath))?.receipt;
}

function getOptimizerRuntimeModeLines(): string[] {
  const state = runtimeOptimizerEnabled ? "enabled" : "disabled";
  const lines: string[] = [];
  lines.push(`Runtime state: ${state}`);
  lines.push(`• Prompt rewrite: ${runtimeOptimizerEnabled && featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true) ? "on" : "off"}`);
  lines.push(`• Native virtual rewrite: ${featureEnabled("virtualRewrite", VIRTUAL_REWRITE_ENV, false) ? "opt-in" : "off"}`);
  lines.push(`• Skill compression: ${featureEnabled("skillCompression", NO_SKILL_COMPRESSION_ENV, true) ? "on" : "off"}`);
  lines.push(`• Deterministic tool ordering: ${isToolOrderEnabled() ? "on (verified built-in payloads, opt-in)" : "off"}`);
  lines.push(`• OpenAI prompt_cache_key fallback: ${shouldInjectOpenAIPromptCacheKey() ? "on" : "off"}`);
  lines.push(`• Footer cache stats: on${runtimeOptimizerEnabled ? "" : " (comparison mode)"}`);
  lines.push(`• Compat warnings: ${runtimeOptimizerEnabled ? "on" : "off"}`);
  lines.push(`• ${PI_CACHE_RETENTION_ENV}: ${process.env[PI_CACHE_RETENTION_ENV] ?? "(unset)"}`);
  lines.push(`• Persistent feature overrides: ${Object.keys(persistedCacheOptimizerConfig.features ?? {}).length > 0 ? "configured" : "none"}`);
  if (!runtimeOptimizerEnabled) {
    lines.push("This is a current-process switch. Run /reload or restart Pi to return to startup behavior.");
  } else if (!featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true) || !shouldInjectOpenAIPromptCacheKey()) {
    lines.push("Some features are still disabled by environment variables.");
  }
  return lines;
}

function formatPersistentFeatureConfig(): string {
  const features = persistedCacheOptimizerConfig.features ?? {};
  const lines = ["Persistent feature configuration:"];
  const entries: Array<[string, PersistedCacheOptimizerFeature, string, boolean]> = [
    ["Prompt rewrite", "promptRewrite", NO_PROMPT_REWRITE_ENV, true],
    ["Native virtual rewrite", "virtualRewrite", VIRTUAL_REWRITE_ENV, false],
    ["Skill compression", "skillCompression", NO_SKILL_COMPRESSION_ENV, true],
    ["OpenAI cache key", "openAICacheKey", NO_OPENAI_CACHE_KEY_ENV, true],
    ["Tool ordering", "toolOrder", TOOL_ORDER_ENV, false],
  ];
  for (const [label, feature, envName, defaultValue] of entries) {
    const source = features[feature] !== undefined ? "config" : process.env[envName] !== undefined ? "env" : "default";
    lines.push(`• ${label}: ${featureEnabled(feature, envName, defaultValue) ? "on" : "off"} (${source})`);
  }
  return lines.join("\n");
}

function formatOptimizerRuntimeMode(): string {
  return getOptimizerRuntimeModeLines().join("\n");
}

function buildAdaptiveThinkingCompatSuggestion(missing: string[]): Record<string, unknown> {
  const suggestion: Record<string, unknown> = {};
  if (missing.includes("forceAdaptiveThinking")) {
    suggestion.forceAdaptiveThinking = true;
  }
  if (missing.includes("allowEmptySignature")) {
    suggestion.allowEmptySignature = true;
  }
  return suggestion;
}

function appendAdaptiveThinkingCompatAdviceLines(lines: string[], missing: string[], placement: CompatAdvicePlacement = {}): void {
  const suggestion = buildAdaptiveThinkingCompatSuggestion(missing);
  if (Object.keys(suggestion).length > 0) {
    lines.push("Suggested fix:");
    lines.push(JSON.stringify(suggestion, null, 2));
  }
  lines.push("- forceAdaptiveThinking: true tells Pi to use adaptive thinking format");
  lines.push("  (thinking: {type: 'adaptive'}) instead of legacy budget tokens format.");
  lines.push("  Without this flag, Pi sends legacy thinking which adaptive-only upstreams reject.");
  if (missing.includes("allowEmptySignature")) {
    lines.push("- allowEmptySignature: true preserves Kimi Coding K3 thinking blocks whose replay signature is empty.");
  }
  appendCredentialSafeProviderGuidance(lines, placement, suggestion);
}

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

const REQUEST_SNAPSHOT_COMPAT_KEYS: Array<keyof CacheCompat> = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsStrictMode",
  "maxTokensField",
  "sendSessionAffinityHeaders",
  "sessionAffinityFormat",
  "supportsLongCacheRetention",
  "thinkingFormat",
  "requiresReasoningContentOnAssistantMessages",
  "cacheControlFormat",
  "forceAdaptiveThinking",
  "allowEmptySignature",
];

function snapshotCompatForDiagnostics(model: PiModel): CacheCompat {
  const source = getCompat(model);
  const snapshot: CacheCompat = {};
  const mutableSnapshot = snapshot as Record<string, unknown>;
  for (const key of REQUEST_SNAPSHOT_COMPAT_KEYS) {
    const value = source[key];
    if (value !== undefined) mutableSnapshot[key] = value;
  }
  return snapshot;
}

function snapshotBaseUrlForDiagnostics(value: unknown): string {
  if (!isNonEmptyString(value)) return "";
  try {
    const url = new URL(value);
    // Request correlation only needs endpoint identity. Strip userinfo and
    // query/fragment material so a provider URL cannot carry credentials into
    // the process-local snapshot.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Invalid endpoint strings are not useful for applicability checks. Keep
    // only a conservative path-free origin-like prefix without userinfo.
    return value.replace(new RegExp("//[^/?#\\s@]+@"), "//").split(/[?#]/, 1)[0];
  }
}

function snapshotProviderRequestModel(model: PiModel | undefined): PiModel | undefined {
  if (!model) return undefined;

  // The provider response hooks do not receive the model that initiated the
  // request (Pi's runner only forwards status/headers). Keep a process-local,
  // credential-blind metadata snapshot so a model switch or route change
  // between request and response cannot retarget a protocol observation. Do
  // not retain the caller's complete model object or any request data.
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: snapshotBaseUrlForDiagnostics(model.baseUrl),
    compat: snapshotCompatForDiagnostics(model),
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 0,
    maxTokens: model.maxTokens ?? 0,
  } as PiModel;
}

// Some provider requests never produce a finalized assistant message: Pi's
// prompt-cache warming (0.86+) replays a request with maxTokens: 1 outside the
// agent loop, so message_end never consumes its lifecycle record. Cap the
// process-local list and drop the oldest completed record first.
const MAX_PROVIDER_REQUEST_STATES = 32;

function pruneProviderRequestStates<T extends { responseReceived: boolean }>(
  states: T[],
  max = MAX_PROVIDER_REQUEST_STATES,
): void {
  while (states.length > max) {
    const completed = states.findIndex((state) => state.responseReceived);
    states.splice(completed >= 0 ? completed : 0, 1);
  }
}

function keyForModelExt(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * For direct (non-virtual-routing) providers, the upstream API may normalize or
 * rename the model id echoed in its response (e.g. a request to
 * `zai-org/GLM-5.2-FP8` returns a message whose `model` field is
 * `GLM5.2-FP8`). Writing stats under the echoed name fragments the bucket
 * away from the active-model key the footer reads (`totalsByModel[ctx.model]`),
 * so the footer shows 0% even when the backend is hitting cache.
 *
 * When the response-derived statsModel differs from the active context model
 * only in name (same provider + same cache adapter), consolidate stats back to
 * the active model identity. Virtual routing providers are excluded — their
 * message-local metadata is authoritative for router correctness (spec:
 * `message_end` MUST prefer assistant message metadata).
 *
 * Never merges across providers or across adapters, so genuinely different
 * models are never combined.
 */
function consolidateDirectProviderStatsModel(
  statsModel: PiModel | undefined,
  ctxModel: PiModel | undefined,
  ctx?: Pick<ExtensionContext, "sessionManager">,
): PiModel | undefined {
  if (!statsModel || !ctxModel) return statsModel;
  // Virtual routing providers keep message-local stats identity.
  if (isVirtualRoutingModel(ctxModel, ctx)) return statsModel;
  // Only consolidate within the same provider.
  if (statsModel.provider !== ctxModel.provider) return statsModel;
  // Only consolidate when both resolve to the same cache adapter object, so
  // genuinely different models sharing a provider (or sharing the same adapter
  // family id, e.g. GPT and GLM both report family id "openai") are never
  // merged. `selectAdapterForModel` returns the precise adapter object, so
  // object identity is the correct criterion.
  const statsAdapter = selectAdapterForModel(statsModel);
  const ctxAdapter = selectAdapterForModel(ctxModel);
  if (!statsAdapter || !ctxAdapter || statsAdapter !== ctxAdapter) return statsModel;
  // No drift — nothing to consolidate.
  if (statsModel.id === ctxModel.id) return statsModel;
  // Consolidate: pin stats to the active-model identity the footer reads.
  return {
    ...statsModel,
    id: ctxModel.id,
    name: ctxModel.name || ctxModel.id,
  };
}

function describeMissingOpenAIFamilyProxyCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];

  if (!isOpenAIFamilyModel(model)) return missing;
  if (!isOpenAICompatibleProxyApi(model.api)) return missing;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return missing;

  if (compat.sendSessionAffinityHeaders !== true) {
    missing.push("sendSessionAffinityHeaders");
  }

  return missing;
}

function describeOptionalOpenAICompatibleProxyCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const optional: string[] = [];

  if (!isOpenAICompatibleProxyApi(model.api)) return optional;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return optional;
  if (isPiBuiltInLlamaCppModel(model)) return optional;

  if (compat.supportsLongCacheRetention !== true) {
    optional.push("supportsLongCacheRetention");
  }

  return optional;
}

function getPromptCacheRetentionUnsupportedHint(): string {
  return "If this channel returns `400 Unsupported parameter: prompt_cache_retention`, remove/avoid `supportsLongCacheRetention`; this extension does not write that field directly, but Pi may send it when long retention is requested and compat says the proxy supports it.";
}

function hasPromptCacheRetentionUnsupportedText(value: unknown): boolean {
  const normalized = lower(value);
  if (!normalized.includes("prompt_cache_retention")) return false;

  return [
    "unsupported parameter",
    "unsupported_parameter",
    "unknown parameter",
    "not supported",
    "unsupported field",
    "extra inputs",
    "not permitted",
    "unrecognized",
  ].some((needle) => normalized.includes(needle));
}

function hasPromptCacheRetentionUnsupportedSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return hasPromptCacheRetentionUnsupportedText(
    Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  );
}

function hasPromptCacheRetentionUnsupportedErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  return record?.stopReason === "error" &&
    hasPromptCacheRetentionUnsupportedText(record.errorMessage);
}

function hasPromptCacheKeyUnsupportedText(value: unknown): boolean {
  const normalized = lower(value)
    .replace(/["'`]/g, "")
    .replace(/[\s_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const key = String.raw`(?:prompt ?cache ?key|promptcachekey)`;
  const field = String.raw`(?:parameter|field|input|argument)`;
  const unsupported = String.raw`(?:unsupported|unknown|unrecognized|unexpected|not supported|not allowed|not permitted|must be omitted|should be omitted)`;
  if (!new RegExp(key).test(normalized)) return false;

  // Keep this deliberately grammar-bound. A rejected value or a conditional
  // restriction (for example, "not allowed when temperature is set") is not
  // proof that the endpoint lacks support for the field itself.
  const terminal = String.raw`(?=$|[}\]>,.;])`;
  return (
    new RegExp(String.raw`(?:unsupported|unknown|unrecognized|unexpected)\s+${field}\s*[:=]?\s*${key}${terminal}`).test(normalized) ||
    new RegExp(String.raw`(?:extra\s+inputs?|${field}\s+not\s+(?:allowed|permitted|supported))\s*[:=]\s*${key}${terminal}`).test(normalized) ||
    new RegExp(String.raw`${key}(?:\s+${field})?\s*[:=]?\s*(?:is\s+)?${unsupported}${terminal}`).test(normalized)
  );
}

function hasPromptCacheKeyUnsupportedSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(([key, value]) => hasPromptCacheKeyUnsupportedText(`${key}: ${value}`));
}

function hasPromptCacheKeyUnsupportedErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  return record?.stopReason === "error" &&
    getOptionalAssistantHttpStatus(record) === 400 &&
    hasPromptCacheKeyUnsupportedText(record.errorMessage);
}

function isPromptCacheKeyUnsupportedApplicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api);
}

function hasReasoningProtocolRejectionText(value: unknown): boolean {
  const normalized = lower(value).replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  // Match only a rejection that is attached to the `thinking` parameter. Do
  // not merely look for both parameter names: `reasoning_effort is not
  // supported; use thinking` is the opposite direction and must not activate
  // this fallback.
  const thinkingParameterRejectionPatterns = [
    /(?:^|[^a-z0-9_])["'`]?thinking["'`]?(?:\s+(?:parameter|field|argument))?\s*(?:is\s+)?(?:not supported|unsupported|unknown|unrecognized|not allowed|not permitted|rejected|invalid|not valid|not accepted|disallowed|not a valid(?:\s+(?:parameter|field|argument))?)(?![a-z0-9_])/,
    /(?:^|[^a-z0-9_])(?:unsupported|unknown|unrecognized|invalid|disallowed|rejected|not\s+(?:a\s+)?valid|not\s+accepted|not\s+allowed|not\s+permitted)(?:[_ ](?:parameter|field|argument))?\s*[:=]?\s*["'`]?thinking["'`]?(?![a-z0-9_])/,
    /(?:^|[^a-z0-9_])(?:extra\s+inputs?|additional\s+(?:inputs?|parameters?))\s+(?:are\s+)?(?:not permitted|not allowed|unsupported)\s*[:=]?\s*["'`]?thinking["'`]?(?![a-z0-9_])/,
  ];
  let rejectionEnd = -1;
  for (const pattern of thinkingParameterRejectionPatterns) {
    const match = pattern.exec(normalized);
    if (match && match.index + match[0].length > rejectionEnd) {
      rejectionEnd = match.index + match[0].length;
    }
  }
  if (rejectionEnd < 0) return false;

  // The provider must direct the caller to reasoning_effort after the
  // rejection. Limiting this to the short suffix after the matched rejection
  // keeps generic documentation or an unrelated earlier sentence from being
  // treated as runtime protocol evidence.
  const recommendation = normalized.slice(rejectionEnd, rejectionEnd + 260);
  if (!/\breasoning[_\.]effort\b/.test(recommendation)) return false;

  const recommendationClauses = recommendation.split(/[.;!?\n]/);
  return recommendationClauses.some((clause) => {
    if (!/\breasoning[_\.]effort\b/.test(clause)) return false;
    // A target mentioned inside a negated/disabled clause is not positive
    // protocol guidance, even if words such as `must` or `supported` occur.
    if (
      /\b(?:do\s+not|don't|never|avoid)\s+(?:use|set|send|pass|provide)?\s*["'`]?reasoning[_\.]effort\b/.test(clause) ||
      /\breasoning[_\.]effort\b[^.;]{0,80}\b(?:must|should|may|do)\s+(?:not|never)\b/.test(clause) ||
      /\breasoning[_\.]effort\b[^.;]{0,80}\b(?:unsupported|disabled|unavailable|not\s+(?:supported|accepted|allowed|available|enabled|required|recommended|expected))\b/.test(clause)
    ) return false;

    return [
      /(?:use|try|set|send|pass|provide)\s+(?:the\s+)?(?:top[- ]level\s+)?["'`]?reasoning[_\.]effort["'`]?(?![a-z0-9_])/,
      /(?:reasoning[_\.]effort)\b[^.;]{0,120}(?:instead|required|must\s+be|should\s+be|is\s+(?:supported|accepted|preferred|recommended|expected))\b/,
      /(?:parameter|field|option)\s+(?:is|should be)\s+["'`]?reasoning[_\.]effort["'`]?(?![a-z0-9_])/,
      /instead[^.;]{0,120}(?:use|try|set|send|pass|provide)\s+(?:the\s+)?["'`]?reasoning[_\.]effort["'`]?(?![a-z0-9_])/,
      /(?:replace|change|switch)\s+(?:the\s+)?["'`]?thinking["'`]?\s+(?:with|to)\s+["'`]?reasoning[_\.]effort["'`]?(?![a-z0-9_])/,
    ].some((pattern) => pattern.test(clause));
  });
}

function hasReasoningProtocolRejectionSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  // Each response header is one diagnostic unit. Joining all values can pair a
  // rejection from one header with unrelated documentation in another.
  return Object.entries(headers).some(([key, headerValue]) =>
    hasReasoningProtocolRejectionText(`${key}: ${headerValue}`)
  );
}

function getOptionalAssistantHttpStatus(record: UnknownRecord): number | undefined {
  const readStatus = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return parsed >= 100 && parsed <= 599 ? parsed : undefined;
    }
    return undefined;
  };

  for (const key of ["status", "statusCode", "httpStatus", "httpStatusCode"]) {
    const status = readStatus(record[key]);
    if (status !== undefined) return status;
  }

  // Foreign/provider adapters sometimes put the HTTP status under a
  // diagnostic `details`, `error`, or `cause` object rather than exposing it
  // on the finalized assistant message itself. Traverse only these known
  // diagnostic wrappers, with a small depth bound; never inspect arbitrary
  // payload/message fields for a number that happens to look like a status.
  const scanDiagnosticStatus = (value: unknown, depth: number): number | undefined => {
    if (depth > 2) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const status = scanDiagnosticStatus(item, depth + 1);
        if (status !== undefined) return status;
      }
      return undefined;
    }
    const source = asRecord(value);
    if (!source) return undefined;
    for (const key of ["status", "statusCode", "httpStatus", "httpStatusCode", "code"]) {
      const status = readStatus(source[key]);
      if (status !== undefined) return status;
    }
    for (const key of ["details", "error", "cause", "diagnostics"]) {
      const status = scanDiagnosticStatus(source[key], depth + 1);
      if (status !== undefined) return status;
    }
    return undefined;
  };
  for (const key of ["diagnostics", "diagnostic", "details", "error", "cause"]) {
    const status = scanDiagnosticStatus(record[key], 0);
    if (status !== undefined) return status;
  }

  // Pi's built-in OpenAI-compatible adapters normally prefix a provider error
  // body with the HTTP status (for example `400: {...}` or
  // `OpenAI API error (400): ...`). Only parse status-shaped prefixes; never
  // search arbitrary body text where a model id or payload number could be
  // mistaken for a response status.
  if (typeof record.errorMessage === "string") {
    const errorText = record.errorMessage;
    const matches = [
      /^\s*([1-5]\d{2})\b/,
      /^\s*(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:(]?\s*([1-5]\d{2})\b/i,
      /^\s*[^():\n]{1,100}\(\s*([1-5]\d{2})\b/,
      /^\s*(?:error|api\s+error|provider\s+error|request\s+failed|http\s+error)\s*[:(]\s*([1-5]\d{2})\b/i,
    ];
    for (const pattern of matches) {
      const match = pattern.exec(errorText);
      if (match) return Number(match[1]);
    }
  }
  return undefined;
}

function hasReasoningProtocolRejectionErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  if (!record || record.stopReason !== "error") return false;
  // Finalized assistant messages do not expose a separate status field in the
  // normal Pi path, so recover it only from structured diagnostics or the
  // adapter's status-shaped error prefix. A text-only 400-looking parameter
  // message is not enough evidence for a protocol repair.
  return getOptionalAssistantHttpStatus(record) === 400 &&
    hasReasoningProtocolRejectionText(record.errorMessage);
}

function isReasoningProtocolRejectionSignalApplicable(model: PiModel | undefined): boolean {
  // A provider error can teach us which protocol it expects, so this gate is
  // intentionally broader than the explicit DeepSeek-format diagnostic gate.
  // The model family identifies the affected cache/compat bucket; the error
  // text, not the model name, supplies the wire-protocol evidence.
  return !!model && isOpenAICompatibleProxyApi(model.api) && isDeepSeekLikeModel(model);
}

function isReasoningProtocolRejectionForModel(message: unknown, model: PiModel | undefined): boolean {
  if (!model || !isReasoningProtocolRejectionSignalApplicable(model)) return false;
  if (!hasReasoningProtocolRejectionErrorMessage(message)) return false;
  const record = getAssistantRecord(message);
  if (!record) return false;
  const messageProvider = firstNonEmptyString(record.provider);
  const messageModel = firstNonEmptyString(record.responseModel, record.model);
  // An explicit identity in the finalized assistant error is authoritative.
  // Do not broaden a model-scoped observation to another DeepSeek-named model.
  return (!messageProvider || messageProvider === model.provider) &&
    (!messageModel || messageModel === model.id);
}

async function notifyReasoningProtocolObservation(
  model: PiModel,
  ctx: Pick<ExtensionContext, "ui">,
  rejectedModelKeys: Set<string>,
  warnedModelKeys: Set<string>,
): Promise<void> {
  const key = modelKey(model);
  rejectedModelKeys.add(key);
  if (warnedModelKeys.has(key)) return;
  warnedModelKeys.add(key);

  const receipt = await readModelsJsonFixReceipt();
  const matchingReceipt = isActionableModelsJsonFixReceipt(receipt) &&
    receipt.provider === model.provider &&
    receipt.modelId === model.id;
  const recovery = matchingReceipt
    ? "A matching confirmed fix receipt exists; run /cache-optimizer rollback to undo it safely."
    : "Run /cache-optimizer fix to review a model-scoped repair.";
  ctx.ui.notify(
    `⚠️ ${LOG_PREFIX}: ${key} rejected the configured reasoning format. ${recovery} ` +
    "No configuration was changed automatically.",
    "warning",
  );
}

function fixSuggestionIdentity(model: PiModel): { providerLabel: string; modelId: string } {
  const key = modelKey(model);
  const slashIdx = key.indexOf("/");
  return {
    providerLabel: slashIdx > 0 ? key.slice(0, slashIdx) : key,
    modelId: model.id,
  };
}

function mergeFixSuggestions(...suggestions: Array<FixSuggestion | undefined>): FixSuggestion | undefined {
  const present = suggestions.filter((suggestion): suggestion is FixSuggestion => suggestion !== undefined);
  if (present.length === 0) return undefined;
  const first = present[0];
  return {
    providerLabel: first.providerLabel,
    modelId: first.modelId,
    compatKeys: Object.assign({}, ...present.map((suggestion) => suggestion.compatKeys)),
    forceModelLevel: present.some((suggestion) => suggestion.forceModelLevel === true),
  };
}

function buildReasoningProtocolFixSuggestion(
  model: PiModel,
  protocolRejectionObserved = false,
): FixSuggestion | undefined {
  if (!protocolRejectionObserved) return undefined;
  if (!isDeepSeekLikeModel(model) || !isOpenAICompatibleProxyApi(model.api)) return undefined;

  const compat = getCompat(model);
  // Explicit provider-specific formats are user/provider evidence in their own
  // right. Do not replace qwen/openrouter/together/etc. merely because a
  // generic error happened to mention both reasoning parameter names. The
  // evidence-driven repair is limited to the old DeepSeek `thinking` format,
  // an explicit standard OpenAI format, or an absent format that needs to be
  // made unambiguous after the provider's rejection.
  if (
    compat.thinkingFormat !== undefined &&
    compat.thinkingFormat !== "deepseek" &&
    compat.thinkingFormat !== "openai"
  ) {
    return undefined;
  }

  const identity = fixSuggestionIdentity(model);
  const compatKeys: Record<string, unknown> = {};
  if (compat.thinkingFormat !== "openai") {
    compatKeys.thinkingFormat = "openai";
  }
  if (compat.supportsReasoningEffort !== true) {
    compatKeys.supportsReasoningEffort = true;
  }

  // Replay behavior is changed only when the current effective configuration
  // actually enabled it. Never invent a false value merely because the model
  // family is named DeepSeek or because a provider supports reasoning effort.
  if (compat.requiresReasoningContentOnAssistantMessages === true) {
    compatKeys.requiresReasoningContentOnAssistantMessages = false;
  }
  if (Object.keys(compatKeys).length === 0) return undefined;

  return {
    ...identity,
    // Protocol observations are always model-scoped. A provider may expose
    // DeepSeek-named models with different wire formats, so sibling models
    // must never inherit this evidence-driven change.
    compatKeys,
    forceModelLevel: true,
  };
}

function appendOptionalOpenAIProxyCompatAdviceLines(lines: string[], optional: string[]): void {
  if (!optional.includes("supportsLongCacheRetention")) return;
  lines.push("");
  lines.push("Optional (not required, not auto-fixed):");
  lines.push("- supportsLongCacheRetention: enable only after your endpoint/proxy explicitly supports OpenAI long prompt cache retention.");
  lines.push(`- ${getPromptCacheRetentionUnsupportedHint()}`);
}

/**
 * Compatibility diagnostics for a DeepSeek-like model are generic unless the
 * user has explicitly selected Pi's DeepSeek reasoning wire format. In
 * particular, never manufacture `thinkingFormat: "deepseek"`: doing so can
 * turn a valid reasoning_effort request into a provider-rejected `thinking`
 * request (Issue #10).
 */
function isDeepSeekCompatCheckApplicable(model: PiModel): boolean {
  return isDeepSeekWireCompatApplicable(model);
}

function hasExplicitDeepSeekReasoningProtocol(model: PiModel): boolean {
  return isDeepSeekWireCompatApplicable(model);
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

function formatTokenCount(value: number): string {
  const millions = Math.max(0, Math.round(value)) / 1_000_000;
  if (millions === 0) return "0M";
  if (millions < 0.001) return `${millions.toFixed(4)}M`;
  if (millions < 0.01) return `${millions.toFixed(3)}M`;
  if (millions >= 10) return `${millions.toFixed(1)}M`;
  return `${millions.toFixed(2)}M`;
}

function formatCacheStats(adapter: CacheProviderAdapter, stats: CacheStats): string {
  const percent = stats.totalInputTokens > 0
    ? (stats.cachedInputTokens / stats.totalInputTokens) * 100
    : 0;
  const writeText = adapter.showCacheWrite && stats.cacheWriteInputTokens > 0
    ? `·write ${formatTokenCount(stats.cacheWriteInputTokens)}`
    : "";

  return `${adapter.label} ${stats.hitRequests}/${stats.totalRequests}·${formatTokenCount(stats.cachedInputTokens)}/${formatTokenCount(stats.totalInputTokens)} ${percent.toFixed(1)}%${writeText}`;
}

function prefixFooterStatus(statusText: string | undefined): string | undefined {
  if (!statusText || statusText.startsWith("· ")) return statusText;
  return `· ${statusText}`;
}

/**
 * Compute a hit-ratio percentage string for a value between 0 and 1.
 * Returns e.g. "75%", "0%", "100%", or "N/A" for zero total.
 */
function formatHitRatio(hits: number, total: number): string {
  if (total <= 0) return "N/A";
  return `${Math.round((hits / total) * 100)}%`;
}

/**
 * Format a token-to-M abbreviation for stats output.
 * Example: 1500000 → "1.50M"
 */
function formatTokenM(value: number): string {
  const millions = Math.max(0, Math.round(value)) / 1_000_000;
  if (millions === 0) return "0";
  if (millions < 0.01) return millions.toFixed(4);
  if (millions >= 10) return millions.toFixed(1);
  return millions.toFixed(2);
}

/**
 * Check if an assistant message's usage fields appear to be missing or empty.
 * Returns true when Pi-normalized fields (input, cacheRead, cacheWrite) are all
 * absent/zero AND raw usage fields (prompt_tokens, etc.) are also absent/zero
 * for the given adapter.
 */
function hasMissingUsageFields(message: unknown, adapter: CacheProviderAdapter): boolean {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return true;

  // Check Pi-normalized fields
  const input = getNonNegativeNumber(usage, "input");
  const cacheRead = getNonNegativeNumber(usage, "cacheRead");
  const cacheWrite = getNonNegativeNumber(usage, "cacheWrite");

  // If Pi-normalized fields exist with non-zero values, usage is present
  if (cacheRead !== undefined || cacheWrite !== undefined || (input !== undefined && input > 0)) {
    return false;
  }

  // Check raw usage for the adapter's provider family
  const rawUsage = adapter.normalizeUsage(message);
  if (!rawUsage || (rawUsage.cacheRead === 0 && rawUsage.cacheWrite === 0 && rawUsage.totalInput === 0)) {
    return true;
  }

  return false;
}

/**
 * Build a summary string for the recent trend (last N samples).
 * Example: "Recent 10: 7/10 hits · 65% tok cached · no missing usage"
 */
function formatRecentTrendSummary(samples: CacheUsageSample[], maxCount: number): string {
  const recent = samples.slice(-maxCount);
  if (recent.length === 0) return `Recent ${maxCount}: no samples yet`;

  const hits = recent.filter((s) => s.hit).length;
  const totalCached = recent.reduce((sum, s) => sum + s.cachedInputTokens, 0);
  const totalInput = recent.reduce((sum, s) => sum + s.totalInputTokens, 0);
  const missingCount = recent.filter((s) => s.missingUsageFields).length;

  const hitRatio = formatHitRatio(hits, recent.length);
  const tokenRatio = totalInput > 0 ? formatHitRatio(totalCached, totalInput) : "N/A";

  let result = `Recent ${recent.length}/${maxCount}: ${hits}/${recent.length} hits · ${tokenRatio} tok cached`;
  if (missingCount > 0) {
    result += ` · ${missingCount} missing usage`;
  }
  return result;
}

/**
 * Build the output for `/cache-optimizer stats`.
 */
function formatCompactStats(stats: CacheStats): string {
  const percent = stats.totalInputTokens > 0
    ? (stats.cachedInputTokens / stats.totalInputTokens) * 100
    : 0;
  return `${stats.hitRequests}/${stats.totalRequests}·${formatTokenCount(stats.cachedInputTokens)}/${formatTokenCount(stats.totalInputTokens)} ${percent.toFixed(1)}%`;
}

function modelFromStatsKey(key: string, ref?: PersistedRoutedModelRef): PiModel | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash >= key.length - 1) return undefined;
  return routedModelRefToPiModel(ref ?? { provider: key.slice(0, slash), id: key.slice(slash + 1) });
}

function sortStatsEntries(entries: Array<[string, CacheStats]>, activeModelKey?: string): Array<[string, CacheStats]> {
  return entries.sort(([left], [right]) => {
    if (left === activeModelKey) return -1;
    if (right === activeModelKey) return 1;
    return left.localeCompare(right);
  });
}

function buildSessionStatsOutput(
  sessionModels: Record<string, CacheStats>,
  activeModel?: PiModel,
  modelRefsByKey: Record<string, PersistedRoutedModelRef> = {},
): string {
  const activeKey = activeModel ? modelKey(activeModel) : undefined;
  const models = { ...sessionModels };
  if (activeModel && selectAdapterForModel(activeModel) && !models[activeKey!]) {
    models[activeKey!] = emptyCacheStats();
  }
  const entries = sortStatsEntries(Object.entries(models), activeKey);
  if (entries.length === 0) return "ℹ️ No cache statistics recorded for the current session today.";
  const lines = ["Scope: current session", `Day:   ${currentLocalDay()}`, `Models: ${entries.length}`];
  for (const [key, stats] of entries) {
    const model = modelFromStatsKey(key, modelRefsByKey[key]);
    const adapter = model ? selectAdapterForModel(model) : undefined;
    lines.push("", `── ${key} ──`, `Adapter: ${adapter?.label ?? "Unknown cache adapter"}`);
    lines.push(`Requests:      ${stats.hitRequests} hit / ${stats.totalRequests} total`);
    lines.push(`Cached tokens: ${formatTokenCount(stats.cachedInputTokens)} / ${formatTokenCount(stats.totalInputTokens)} input · ${stats.totalInputTokens > 0 ? `${((stats.cachedInputTokens / stats.totalInputTokens) * 100).toFixed(1)}%` : "0.0%"}`);
    lines.push(`Summary:       ${formatCompactStats(stats)}`);
    if (stats.cacheWriteInputTokens > 0) lines.push(`Cache write:   ${formatTokenCount(stats.cacheWriteInputTokens)}`);
  }
  return lines.join("\n");
}

function buildAllStatsOutput(aggregate: ShardAggregate): string {
  const entries = sortStatsEntries(Object.entries(aggregate.totalsByModel));
  if (entries.length === 0) return "ℹ️ No local cache statistics recorded today.";
  const sessionCount = Object.keys(aggregate.instancesBySession).length;
  const instanceCount = Object.values(aggregate.instancesBySession).reduce((sum, value) => sum + value, 0);
  const lines = ["Scope: all local sessions", `Day:   ${currentLocalDay()}`, `Sessions: ${sessionCount}`, `Instances: ${instanceCount}`];
  for (const [key, stats] of entries) {
    const model = modelFromStatsKey(key, aggregate.modelRefsByKey[key]);
    const adapter = model ? selectAdapterForModel(model) : undefined;
    lines.push("", `── ${key} ──`, `Adapter: ${adapter?.label ?? "Unknown cache adapter"}`);
    lines.push(`Sessions: ${aggregate.sessionsByModel[key] ?? 0} · Instances: ${aggregate.instancesByModel[key] ?? 0}`);
    lines.push(`Requests:      ${stats.hitRequests} hit / ${stats.totalRequests} total`);
    lines.push(`Cached tokens: ${formatTokenCount(stats.cachedInputTokens)} / ${formatTokenCount(stats.totalInputTokens)} input · ${stats.totalInputTokens > 0 ? `${((stats.cachedInputTokens / stats.totalInputTokens) * 100).toFixed(1)}%` : "0.0%"}`);
    lines.push(`Summary:       ${formatCompactStats(stats)}`);
    if (stats.cacheWriteInputTokens > 0) lines.push(`Cache write:   ${formatTokenCount(stats.cacheWriteInputTokens)}`);
  }
  return lines.join("\n");
}

function buildContributorsStatsOutput(aggregate: ShardAggregate, activeModel: PiModel | undefined, currentSessionHash?: string): string {
  if (!activeModel) return "ℹ️ No active model selected.";
  const key = modelKey(activeModel);
  const rows = Object.entries(aggregate.bySession)
    .filter(([, models]) => models[key])
    .sort(([left], [right]) => left === currentSessionHash ? -1 : right === currentSessionHash ? 1 : left.localeCompare(right));
  if (rows.length === 0) return `ℹ️ No contributors recorded for ${key} today.`;
  const lines = [`Model: ${key}`, "Scope: contributing local sessions today"];
  let otherIndex = 0;
  for (const [sessionHash, models] of rows) {
    const label = sessionHash === currentSessionHash ? "Current session" : `Other session ${++otherIndex}`;
    lines.push("", label, `  Instances: ${aggregate.instancesBySessionModel[sessionHash]?.[key] ?? 0}`, `  ${formatCompactStats(models[key])}`);
  }
  return lines.join("\n");
}

function buildStatsOutput(model: PiModel | undefined, adapter: CacheProviderAdapter | undefined, stats: CacheStats | undefined, recentSamples: CacheUsageSample[]): string {
  const lines: string[] = [];

  if (!model || !adapter) {
    lines.push("ℹ️ No cache-adapter-matched model active. Select a model with a recognized provider family.");
    return lines.join("\n");
  }

  const key = modelKey(model);
  const currentStats = stats ?? emptyCacheStats();

  lines.push(`Model key: ${key}`);
  lines.push(`Adapter:   ${adapter.label}`);
  lines.push("");
  lines.push("── Today ──");
  lines.push(`Requests:      ${currentStats.hitRequests} hit / ${currentStats.totalRequests} total · ${formatHitRatio(currentStats.hitRequests, currentStats.totalRequests)}`);
  lines.push(`Cached tokens: ${formatTokenM(currentStats.cachedInputTokens)}M / ${formatTokenM(currentStats.totalInputTokens)}M input · ${currentStats.totalInputTokens > 0 ? `${Math.round((currentStats.cachedInputTokens / currentStats.totalInputTokens) * 100)}%` : "N/A"}`);
  if (currentStats.cacheWriteInputTokens > 0) {
    lines.push(`Cache write:   ${formatTokenM(currentStats.cacheWriteInputTokens)}M tok`);
  }

  lines.push("");
  lines.push("── Recent trend ──");
  lines.push(formatRecentTrendSummary(recentSamples, 10));
  lines.push(formatRecentTrendSummary(recentSamples, 30));

  // Check if any sample has missingUsageFields flagged
  const missingAny = recentSamples.some((s) => s.missingUsageFields);
  if (missingAny) {
    lines.push("");
    lines.push("⚠️ Some recent responses had missing or empty cache usage fields. Footer may under-report hits.");
    lines.push("   The proxy may not return prompt_cache_hit_tokens or usage.input/cacheRead in responses.");
  }

  return lines.join("\n");
}

function deriveTotalsByModelFromSessionStats(statsByModel: Record<string, CacheStats>): Record<string, CacheStats> {
  const totals: Record<string, CacheStats> = {};
  for (const [fullKey, stats] of Object.entries(statsByModel)) {
    totals[modelKeyFromSessionKey(fullKey)] = mergeCacheStatsForTotal(
      totals[modelKeyFromSessionKey(fullKey)],
      stats,
    );
  }
  return totals;
}

function parsePersistedTotalsByModel(value: unknown): Record<string, CacheStats> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const totals: Record<string, CacheStats> = {};
  for (const [modelKeyStr, rawStats] of Object.entries(record)) {
    const stats = parseCacheStats(rawStats);
    if (stats) totals[modelKeyStr] = stats;
  }
  return totals;
}

function routedModelRefToPiModel(ref: PersistedRoutedModelRef): PiModel {
  return {
    id: ref.id,
    name: ref.name ?? ref.id,
    provider: ref.provider,
    api: "",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as PiModel;
}

function selectFooterStatsForModel(
  mode: FooterStatsMode,
  sessionHash: string | undefined,
  statsByModel: Record<string, CacheStats>,
  totalsByModel: Record<string, CacheStats>,
  model: { provider: string; id: string },
  processByModel: Record<string, CacheStats> = {},
): CacheStats | undefined {
  if (mode === "total") return totalsByModel[modelKey(model)];
  if (mode === "process") return processByModel[modelKey(model)];
  if (!sessionHash) return undefined;
  return statsByModel[makeSessionModelKey(sessionHash, model.provider, model.id)];
}

function buildExactRouterStatusEntry(
  sessionHash: string | undefined,
  statsByModel: Record<string, CacheStats>,
  lastRoutedModel: PersistedRoutedModelRef | undefined,
  totalsByModel: Record<string, CacheStats> = {},
  mode: FooterStatsMode = "total",
  processByModel: Record<string, CacheStats> = {},
): { model: PiModel; adapter: CacheProviderAdapter; stats: CacheStats } | undefined {
  if (!sessionHash || !lastRoutedModel) return undefined;

  const model = routedModelRefToPiModel(lastRoutedModel);
  const adapter = selectAdapterForModel(model);
  if (!adapter) return undefined;

  return {
    model,
    adapter,
    stats: selectFooterStatsForModel(mode, sessionHash, statsByModel, totalsByModel, model, processByModel) ?? emptyCacheStats(),
  };
}

function findBestRouterModelStats(
  mode: FooterStatsMode,
  sessionHash: string | undefined,
  statsByModel: Record<string, CacheStats>,
  totalsByModel: Record<string, CacheStats>,
  processByModel: Record<string, CacheStats> = {},
): { model: PiModel; adapter: CacheProviderAdapter; stats: CacheStats } | undefined {
  const entries = mode === "total"
    ? Object.entries(totalsByModel)
    : mode === "process"
      ? Object.entries(processByModel)
    : sessionHash
      ? Object.entries(statsByModel)
        .filter(([key]) => key.startsWith(`${sessionHash}:`))
        .map(([key, stats]) => [key.slice(sessionHash.length + 1), stats] as const)
      : [];
  let best: { model: PiModel; adapter: CacheProviderAdapter; stats: CacheStats; total: number } | undefined;

  for (const [modelKeyPart, stats] of entries) {
    const slashIdx = modelKeyPart.indexOf("/");
    if (slashIdx < 1 || slashIdx >= modelKeyPart.length - 1) continue;
    const model = routedModelRefToPiModel({
      provider: modelKeyPart.slice(0, slashIdx),
      id: modelKeyPart.slice(slashIdx + 1),
    });
    const adapter = selectAdapterForModel(model);
    if (!adapter) continue;
    if (!best || stats.totalRequests > best.total) {
      best = { model, adapter, stats, total: stats.totalRequests };
    }
  }

  return best ? { model: best.model, adapter: best.adapter, stats: best.stats } : undefined;
}

function parsePersistedCacheStats(value: unknown): CacheStatsState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  // version 4/5/6: session-scoped stats + legacy family fallback.
  // v5 additionally persists the last actual routed model per session so
  // router/auto can restore the exact upstream footer after /reload.
  // v6 adds provider/model totals used for footer continuity across Pi
  // process/terminal restarts, while retaining session buckets for migration
  // and best-effort preservation of older data.
  if (record.version === 4 || record.version === 5 || record.version === 6) {
    const legacyFamily: Partial<Record<CacheProviderId, CacheStats>> = {};
    const rawFamily = asRecord(record.legacyFamily);
    if (rawFamily) {
      for (const id of CACHE_PROVIDER_IDS) {
        const stats = parseCacheStats(rawFamily[id]);
        if (stats) legacyFamily[id] = stats;
      }
    }

    // Collect all session entries into statsByModel with session-hash-prefixed keys
    // (e.g. "abc123:otokapi/gpt-5.5") so that writePersistedCacheStats can later
    // reconstruct individual sessions from the flat key format and other sessions'
    // data is not silently lost on round-trip.
    const statsByModel: Record<string, CacheStats> = {};
    const rawSessions = asRecord(record.sessions);
    if (rawSessions) {
      for (const [sessionHash, modelMap] of Object.entries(rawSessions)) {
        const parsedMap = asRecord(modelMap);
        if (parsedMap) {
          for (const [modelKey, val] of Object.entries(parsedMap)) {
            const parsed = parseCacheStats(val);
            if (parsed) statsByModel[`${sessionHash}:${modelKey}`] = parsed;
          }
        }
      }
    }

    const lastRoutedModelBySession: Record<string, PersistedRoutedModelRef> = {};
    const rawLastRoutedModels = asRecord(record.lastRoutedModelBySession);
    if (rawLastRoutedModels) {
      for (const [sessionHash, rawModel] of Object.entries(rawLastRoutedModels)) {
        const parsed = parsePersistedRoutedModelRef(rawModel);
        if (parsed) lastRoutedModelBySession[sessionHash] = parsed;
      }
    }

    const parsedTotals = parsePersistedTotalsByModel(record.totalsByModel);
    const totalsByModel = parsedTotals ?? deriveTotalsByModelFromSessionStats(statsByModel);

    return { statsByModel, totalsByModel, legacyFamily, lastRoutedModelBySession };
  }

  // version 3: migrate to v4/v5 semantics by wrapping statsByModel into sessions
  if (record.version === 3) {
    const statsByModel: Record<string, CacheStats> = {};
    const rawModelMap = asRecord(record.statsByModel);
    if (rawModelMap) {
      for (const [key, val] of Object.entries(rawModelMap)) {
        const parsed = parseCacheStats(val);
        if (parsed) statsByModel[key] = parsed;
      }
    }

    const legacyFamily: Partial<Record<CacheProviderId, CacheStats>> = {};
    const rawFamily = asRecord(record.legacyFamily);
    if (rawFamily) {
      for (const id of CACHE_PROVIDER_IDS) {
        const stats = parseCacheStats(rawFamily[id]);
        if (stats) legacyFamily[id] = stats;
      }
    }

    return { statsByModel, totalsByModel: deriveTotalsByModelFromSessionStats(statsByModel), legacyFamily };
  }

  // version 2: migrate statsByProvider into legacyFamily
  if (record.version === 2) {
    const statsByProvider = asRecord(record.statsByProvider);
    const legacyFamily: Partial<Record<CacheProviderId, CacheStats>> = {};
    if (statsByProvider) {
      for (const id of CACHE_PROVIDER_IDS) {
        const stats = parseCacheStats(statsByProvider[id]);
        if (stats) legacyFamily[id] = stats;
      }
    }
    return { statsByModel: {}, totalsByModel: {}, legacyFamily };
  }

  // version 1: single DeepSeek stats -> migrate to legacyFamily.deepseek
  if (record.version === 1) {
    const migrated = parseCacheStats(record.stats);
    return migrated ? { statsByModel: {}, totalsByModel: {}, legacyFamily: { deepseek: migrated } } : undefined;
  }

  return undefined;
}

async function readPersistedCacheStats(): Promise<CacheStatsState | undefined> {
  try {
    const raw = await readFile(STATE_FILE_PATH, "utf8");
    return parsePersistedCacheStats(JSON.parse(raw));
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.warn(`${LOG_PREFIX}: failed to read persisted cache stats`, error);
      return undefined;
    }
  }

  // New path missing: try one-shot migration from the old (pre-rename) path.
  try {
    const raw = await readFile(LEGACY_STATE_FILE_PATH, "utf8");
    const parsed = parsePersistedCacheStats(JSON.parse(raw));
    if (parsed) {
      try {
        await writePersistedCacheStats(parsed);
        // Best-effort delete; if the unlink fails the new path is still authoritative.
        try {
          await unlink(LEGACY_STATE_FILE_PATH);
        } catch (unlinkError) {
          if (getErrorCode(unlinkError) !== "ENOENT") {
            console.warn(`${LOG_PREFIX}: failed to remove legacy stats file`, unlinkError);
          }
        }
      } catch (writeError) {
        console.warn(`${LOG_PREFIX}: failed to migrate legacy cache stats`, writeError);
      }
      return parsed;
    }
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.warn(`${LOG_PREFIX}: failed to read legacy cache stats`, error);
    }
  }

  return undefined;
}

function filterRestorableStatsForSession(
  persisted: CacheStatsState | undefined,
  currentSessionHash?: string,
): Record<string, CacheStats> {
  if (!persisted || !currentSessionHash) return {};

  const prefix = `${currentSessionHash}:`;
  const filteredModelStats: Record<string, CacheStats> = {};
  for (const [fullKey, stats] of Object.entries(persisted.statsByModel)) {
    if (fullKey.startsWith(prefix)) {
      filteredModelStats[fullKey] = stats;
    } else if (!fullKey.includes(":")) {
      // Legacy v3-style key without session hash — migrate to current session.
      filteredModelStats[`${currentSessionHash}:${fullKey}`] = stats;
    } else if (fullKey.startsWith("_nosession:")) {
      // Transitional _nosession bucket — migrate to current session.
      filteredModelStats[`${currentSessionHash}:${fullKey.slice("_nosession:".length)}`] = stats;
    }
  }

  return filteredModelStats;
}

/**
 * The closure-internal writer. Since the closure has access to currentSessionHash,
 * it passes the hash and statsByModel here. This function wraps them in the v4
 * sessions format, combining with any previously-persisted sessions for safety.
 *
 * When called from the closure, `state.statsByModel` contains only the current
 * session's entries (keyed by `${sessionHash}:${provider}/${id}`). We extract
 * the model-key-only entries and store them under the session hash.
 */
/**
 * Merge in-memory stats state into an existing sessions map for persistence.
 *
 * When `currentSessionHash` is provided (explicit hash mode):
 *   - Current-session entries are extracted from `state.statsByModel` (keys
 *     prefixed with `currentSessionHash:`) and written under the session hash.
 *   - The transitional legacy `_nosession` bucket is DELETED — its entries
 *     were already consumed and migrated into memory by `restoreCacheStats`.
 *     Keeping `_nosession` on disk would allow resurrection of reset stats
 *     on the next reload (the reset-undo bug).
 *   - Other real session hashes are preserved intact.
 *
 * When `currentSessionHash` is undefined (no-hash mode):
 *   - Keys with a hash prefix (`hash:provider/model`) are grouped under their
 *     respective session hashes.
 *   - Keys without a hash prefix (legacy v3) are grouped under `_nosession` so
 *     `restoreCacheStats` can migrate them on the next load before the session
 *     id is known.
 *
 * Historical v1-v6 pure helper (no runtime I/O). Permanent migration tests
 * exercise it directly; v7 startup never reads or writes the obsolete file.
 */
function mergeCacheSessions(
  existingSessions: Record<string, Record<string, CacheStats>>,
  state: CacheStatsState,
  currentSessionHash?: string,
): Record<string, Record<string, CacheStats>> {
  // Deep-copy to avoid mutating the caller's object.
  const sessions: Record<string, Record<string, CacheStats>> = {};
  for (const [hash, models] of Object.entries(existingSessions)) {
    sessions[hash] = { ...models };
  }

  if (currentSessionHash !== undefined) {
    // Explicit hash mode: extract this session's data from state.statsByModel.
    // When the session has no entries (e.g. after reset of sole bucket), this
    // still sets an empty map, ensuring the deleted bucket does not return.
    const prefix = `${currentSessionHash}:`;
    const currentModelStats: Record<string, CacheStats> = {};
    for (const [fullKey, stats] of Object.entries(state.statsByModel)) {
      if (fullKey.startsWith(prefix)) {
        currentModelStats[fullKey.slice(prefix.length)] = stats;
      }
    }
    sessions[currentSessionHash] = currentModelStats;

    // _nosession is a transitional legacy migration bucket — once we write
    // under an authoritative session hash, those entries have already been
    // consumed and migrated into memory by restoreCacheStats. Delete to
    // prevent resurrection of reset stats on the next reload.
    delete sessions["_nosession"];
  } else {
    // No-hash mode: group entries by their existing hash prefix to avoid
    // collapsing multiple sessions into one bucket. Keys without a hash
    // prefix (legacy v3) go under "_nosession" so restoreCacheStats can
    // migrate them to the current session on next load.
    const nosessionMap: Record<string, CacheStats> = {};
    for (const [fullKey, stats] of Object.entries(state.statsByModel)) {
      const idx = fullKey.indexOf(":");
      if (idx >= 0) {
        const hash = fullKey.slice(0, idx);
        const modelKey = fullKey.slice(idx + 1);
        if (!sessions[hash]) sessions[hash] = {};
        sessions[hash][modelKey] = stats;
      } else {
        // Key without hash prefix (legacy v3) — group under _nosession.
        nosessionMap[fullKey] = stats;
      }
    }
    if (Object.keys(nosessionMap).length > 0) {
      sessions["_nosession"] = nosessionMap;
    }
  }

  return sessions;
}

function createSerializedAsyncRunner(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
}

function mergeCacheTotals(
  existingTotalsByModel: Record<string, CacheStats>,
  stateTotalsByModel: Record<string, CacheStats>,
  options: { deleteModelKeys?: string[]; replaceTotals?: boolean } = {},
): Record<string, CacheStats> {
  const totals = options.replaceTotals
    ? { ...stateTotalsByModel }
    : { ...existingTotalsByModel, ...stateTotalsByModel };
  for (const key of options.deleteModelKeys ?? []) {
    delete totals[key];
  }
  return totals;
}

function mergeLastRoutedModels(
  existingLastRoutedModelBySession: Record<string, PersistedRoutedModelRef>,
  state: CacheStatsState,
  currentSessionHash?: string,
): Record<string, PersistedRoutedModelRef> {
  const merged: Record<string, PersistedRoutedModelRef> = { ...existingLastRoutedModelBySession };
  const incoming = state.lastRoutedModelBySession ?? {};

  if (currentSessionHash !== undefined) {
    const current = incoming[currentSessionHash];
    if (current) {
      merged[currentSessionHash] = current;
    } else {
      // Explicit deletion: when incoming state has no entry for current session,
      // remove any existing stale entry to reflect intentional reset.
      delete merged[currentSessionHash];
    }
    return merged;
  }

  for (const [sessionHash, ref] of Object.entries(incoming)) {
    merged[sessionHash] = ref;
  }
  return merged;
}

async function writePersistedCacheStats(
  state: CacheStatsState,
  currentSessionHash?: string,
  options: { deleteModelKeys?: string[]; replaceTotals?: boolean } = {},
): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });

  // Read existing file to preserve other sessions' data.
  let existingSessions: Record<string, Record<string, CacheStats>> = {};
  let existingTotalsByModel: Record<string, CacheStats> = {};
  let existingLastRoutedModelBySession: Record<string, PersistedRoutedModelRef> = {};
  try {
    const raw = await readFile(STATE_FILE_PATH, "utf8");
    const parsed = parsePersistedCacheStats(JSON.parse(raw));
    if (parsed) {
      // Reconstruct sessions from statsByModel keys.
      // Each key has form `${hash}:${provider}/${id}`; group by hash.
      for (const [fullKey, stats] of Object.entries(parsed.statsByModel)) {
        const idx = fullKey.indexOf(":");
        if (idx >= 0) {
          const hash = fullKey.slice(0, idx);
          const modelKey = fullKey.slice(idx + 1);
          if (!existingSessions[hash]) existingSessions[hash] = {};
          existingSessions[hash][modelKey] = stats;
        }
      }
      existingTotalsByModel = { ...(parsed.totalsByModel ?? {}) };
      existingLastRoutedModelBySession = { ...(parsed.lastRoutedModelBySession ?? {}) };
    }
  } catch {
    // Ignore read errors (file may not exist yet).
  }

  const sessions = mergeCacheSessions(existingSessions, state, currentSessionHash);
  const totalsByModel = mergeCacheTotals(existingTotalsByModel, state.totalsByModel, options);
  const lastRoutedModelBySession = mergeLastRoutedModels(
    existingLastRoutedModelBySession,
    state,
    currentSessionHash,
  );

  const payload: PersistedCacheStatsV6 = {
    version: 6,
    sessions,
    totalsByModel,
    legacyFamily: state.legacyFamily,
    ...(Object.keys(lastRoutedModelBySession).length > 0 ? { lastRoutedModelBySession } : {}),
  };
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, STATE_FILE_PATH);
}

function isCompatCheckApplicable(model: PiModel): boolean {
  return isOpenAICompatibleProxyApi(model.api) && isKnownThirdPartyOpenAIEndpoint(model) && !isPiBuiltInLlamaCppModel(model);
}

function isPromptCacheRetention400Applicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api) &&
    isKnownThirdPartyOpenAIEndpoint(model) &&
    !isPiBuiltInLlamaCppModel(model) &&
    getCompat(model).supportsLongCacheRetention === true;
}

function isExplicitPromptCacheRetentionUnsupportedApplicable(model: PiModel): boolean {
  // A finalized assistant error with an explicit unsupported-parameter signal
  // proves that prompt_cache_retention reached this provider/model. Do not
  // require compat inherited from the active fallback model: router shells may
  // have no upstream compat metadata when no live routing registry is present.
  return isOpenAICompatibleApi(model.api) &&
    !isOfficialOpenAIBaseUrl(model) &&
    !isPiBuiltInLlamaCppModel(model);
}

/**
 * Whether the 403 sendSessionAffinityHeaders diagnostic applies to a model.
 *
 * Pi's openai-completions adapter sends custom HTTP headers (session_id,
 * x-client-request-id, x-session-affinity) when `sendSessionAffinityHeaders`
 * is enabled. Some third-party proxies / CDNs / WAFs block these headers and
 * return HTTP 403 "Your request was blocked". Pi 0.80.7+ no longer uses this
 * flag for openai-responses; Responses header shape is controlled by
 * `sessionAffinityFormat`. This guard therefore applies only to
 * openai-completions, where doctor/fix can safely advise disabling the flag.
 */
function isSessionAffinity403Applicable(model: PiModel): boolean {
  if (!isOpenAICompatibleProxyApi(model.api)) return false;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return false;
  if (isPiBuiltInLlamaCppModel(model)) return false;
  return getCompat(model).sendSessionAffinityHeaders === true;
}

/**
 * Whether an OpenAI SDK header/User-Agent 403 diagnostic applies.
 *
 * Some third-party OpenAI-compatible proxies/CDNs/WAFs allow a plain curl
 * request but block the OpenAI JS SDK's default request fingerprint, especially
 * its `User-Agent: OpenAI/JS ...` and `X-Stainless-*` headers. This is distinct
 * from session-affinity header blocking: it applies when session-affinity
 * headers are NOT enabled but the model still uses a non-official
 * OpenAI-compatible proxy transport.
 */
function isOpenAISdkHeader403Applicable(model: PiModel): boolean {
  if (!isOpenAICompatibleProxyApi(model.api)) return false;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return false;
  if (isPiBuiltInLlamaCppModel(model)) return false;
  return getCompat(model).sendSessionAffinityHeaders !== true;
}

/**
 * Detect router / channel profiles from a PiModel and return diagnostic notes.
 *
 * This function is advisory only — it does NOT participate in adapter selection,
 * prompt_cache_key injection, or footer stats. It inspects provider, api, baseUrl,
 * and compat to identify common proxy/router patterns where cache performance may
 * be degraded due to multi-backend routing.
 *
 * Known profiles (checked in order):
 *   1. OpenRouter — baseUrl or provider id matching openrouter.ai / openrouter
 *   2. Vercel AI Gateway — baseUrl matching ai-gateway.vercel.sh, or provider
 *      matching vercel / vercel-ai-gateway
 *   3. LiteLLM / OneAPI / NewAPI / VoAPI — baseUrl or provider matching litellm,
 *      oneapi, one-api, newapi, new-api, voapi, vo-api (self-hosted aggregation)
 *   4. Generic third-party OpenAI-compatible proxy — any openai-completions model
 *      with a non-official base URL that does not match a higher-profile above.
 *
 * Official OpenAI (api.openai.com) and custom transports (kiro-api, anthropic-messages,
 * bedrock-converse-stream) do NOT produce notes.
 */
function describeRouterChannelDiagnostics(model: PiModel): string[] {
  const notes: string[] = [];
  const api = lower(model.api);
  const baseUrl = lower(model.baseUrl || "");
  const provider = lower(model.provider);

  // Router/channel diagnostics only apply to OpenAI-compatible proxy APIs.
  // Native APIs like mistral-conversations, azure-openai-responses,
  // anthropic-messages, or bedrock-converse-stream are intentionally excluded.
  if (api === "azure-openai-responses" || isMistralConversationsApi(api) || !isOpenAICompatibleApi(api)) {
    return notes;
  }

  // Unknown/default endpoints and official OpenAI are not diagnosable as
  // third-party router channels. Request-header bridging also fails closed.
  if (!isKnownThirdPartyOpenAIEndpoint(model)) {
    return notes;
  }

  // Pi 0.81+ built-in llama.cpp uses an OpenAI-shaped transport, but its
  // untouched explicit compat fingerprint does not expose proxy-routing or
  // session-affinity configuration. Same-id overrides are not exempt.
  if (isPiBuiltInLlamaCppModel(model)) {
    return notes;
  }

  // ── 1. OpenRouter ────────────────────────────────────────────────
  if (
    baseUrl.includes("openrouter.ai") ||
    baseUrl.includes("openrouter") ||
    provider.includes("openrouter")
  ) {
    const compat = getCompat(model);
    const routing = asRecord((compat as Record<string, unknown>)["openRouterRouting"]);
    const hasOnly = !!routing?.only;
    const hasOrder = !!routing?.order;

    notes.push(
      "🔀 Router/channel: OpenRouter detected. OpenRouter is a multi-provider router; " +
      "low cache hit rates are common when each turn lands on a different upstream provider.",
    );

    if (!hasOnly && !hasOrder) {
      notes.push(
        "   Suggestion: Add an openRouterRouting config to fix the upstream provider. " +
        "Example for models.json -> providers[\"<providerId>\"] -> compat:",
      );
      notes.push(
        `   { "sendSessionAffinityHeaders": true, "supportsLongCacheRetention": true, ` +
        `"openRouterRouting": { "only": ["<provider-slug>"] } }`,
      );
      notes.push(
        '   Replace <provider-slug> with the actual OpenRouter provider slug (e.g. "openai", "anthropic").',
      );
      notes.push(
        "   Alternatively, use openRouterRouting.order: [\"<provider-slug>\", \"...\"] for fallback order. " +
        "Only set supportsLongCacheRetention if your upstream supports long cache retention.",
      );
    }

    return notes;
  }

  // ── 2. Vercel AI Gateway ─────────────────────────────────────────
  if (
    baseUrl.includes("ai-gateway.vercel.sh") ||
    provider.includes("vercel") ||
    provider.includes("vercel-ai-gateway")
  ) {
    const compat = getCompat(model);
    const routing = asRecord((compat as Record<string, unknown>)["vercelGatewayRouting"]);
    const hasOnly = !!routing?.only;
    const hasOrder = !!routing?.order;

    notes.push(
      "🔀 Router/channel: Vercel AI Gateway detected. The gateway may route to different " +
      "provider endpoints per request, reducing cache locality.",
    );

    if (!hasOnly && !hasOrder) {
      notes.push(
        "   Suggestion: Add a vercelGatewayRouting config to fix the upstream. " +
        "Example for models.json -> providers[\"<providerId>\"] -> compat:",
      );
      notes.push(
        `   { "sendSessionAffinityHeaders": true, "supportsLongCacheRetention": true, ` +
        `"vercelGatewayRouting": { "only": ["<provider-id>"] } }`,
      );
      notes.push(
        "   Replace <provider-id> with the actual Vercel provider ID (e.g. \"openai\").",
      );
      notes.push(
        "   Only set supportsLongCacheRetention if your upstream supports it.",
      );
    }

    return notes;
  }

  // ── 3. LiteLLM / OneAPI / NewAPI / VoAPI (self-hosted aggregation) ──
  const aggregationPatterns = ["litellm", "oneapi", "one-api", "newapi", "new-api", "voapi", "vo-api"];
  if (
    aggregationPatterns.some((p) => baseUrl.includes(p)) ||
    aggregationPatterns.some((p) => provider.includes(p))
  ) {
    notes.push(
      "🔀 Router/channel: Self-hosted aggregation proxy detected (LiteLLM / OneAPI / NewAPI / VoAPI). " +
      "These proxies route to multiple upstream accounts or instances, which can split the cache.",
    );
    notes.push(
      "   Suggestions:",
    );
    notes.push(
      "   • Ensure the proxy can fix to a single upstream per session (session_id affinity).",
    );
    notes.push(
      "   • Forward prompt_cache_key and session-affinity headers to the upstream.",
    );
    notes.push(
      "   • Return cache usage fields (prompt_cache_hit_tokens, etc.) in the response.",
    );
    notes.push(
      `   Safe compat default: { "sendSessionAffinityHeaders": true }`,
    );
    notes.push(
      `   Add supportsLongCacheRetention only if the proxy explicitly supports prompt_cache_retention.`,
    );

    return notes;
  }

  // ── 4. Generic third-party OpenAI-compatible proxy ─────────────────
  if (api === "openai-completions" && baseUrl) {
    const missing = describeMissingCacheCompatForModel(model);
    notes.push(
      "🔀 Router/channel: Third-party OpenAI-compatible proxy. If cache hit rates are low:",
    );
    notes.push(
      "   • Verify the proxy routes to the same upstream account/instance per session.",
    );
    notes.push(
      "   • Ensure the proxy forwards prompt_cache_key and sends session-affinity headers.",
    );
    notes.push(
      "   • Check that the proxy returns cache usage fields (prompt_cache_hit_tokens etc.).",
    );
    if (missing.length > 0) {
      notes.push(
        `   • The compat flags above (${missing.join(", ")}) are recommended for cache stability.`,
      );
    }

    return notes;
  }

  return notes;
}

function getCompatCheckNotApplicableLines(model: PiModel): string[] {
  const api = lower(model.api);

  if (isNativeVirtualModel(model)) {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Native virtual model: Pi routes each request to a physical model and none has answered on this session branch yet. Send a prompt, then rerun to diagnose the physical model that answered.",
    ];
  }

  if (isMistralConversationsApi(api)) {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Native Mistral `mistral-conversations` uses provider-native transport; OpenAI-compatible proxy compat flags do not apply.",
    ];
  }

  if (api === "azure-openai-responses") {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Native Azure OpenAI Responses uses the Responses transport; OpenAI-compatible proxy compat flags do not apply.",
    ];
  }

  if (api === "openai-codex-responses" || (api === "openai-responses" && isOfficialOpenAIBaseUrl(model))) {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Native Responses transports already use Pi core request handling; OpenAI-compatible proxy compat flags do not apply.",
    ];
  }

  if (isOpenAICompatibleApi(api) && !isNonEmptyString(model.baseUrl)) {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Upstream endpoint metadata is unavailable; session-affinity header injection is disabled.",
    ];
  }

  return ["ℹ️ Compat check not applicable for this model."];
}

function buildDoctorDiagnosis(model: PiModel, options: { promptCacheRetention400?: boolean; promptCacheKey400?: boolean; anthropicTtlOrderError?: boolean; sessionAffinity403?: boolean; openAISdkHeader403?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Provider: ${model.provider}`);
  lines.push(`Model:    ${model.id}`);
  if (model.name && model.name !== model.id) lines.push(`Name:     ${model.name}`);
  lines.push(`API:      ${model.api}`);
  lines.push(`Base URL: ${model.baseUrl || "(default)"}`);

  const compat = getCompat(model);
  lines.push(`Compat:   ${JSON.stringify(compat)}`);

  const adaptiveThinkingApplicable = isAdaptiveThinkingCompatApplicable(model);
  const deepSeekCompatApplicable = isDeepSeekCompatCheckApplicable(model);
  const missing = describeMissingCacheCompatForModel(model);
  const optionalOpenAIProxyCompat = !adaptiveThinkingApplicable
    ? describeOptionalOpenAICompatibleProxyCompat(model)
    : [];
  const fixSug = buildFixSuggestion(model);
  const safeFixableMissing = fixSug ? Object.keys(fixSug.compatKeys) : [];
  const advisoryMissing = missing.filter(m => !safeFixableMissing.includes(m));

  if (safeFixableMissing.length > 0) {
    lines.push(`⚠️  Missing compat flags: ${safeFixableMissing.join(", ")}`);
  }
  if (advisoryMissing.length > 0) {
    lines.push(`ℹ️  Optional: ${advisoryMissing.join(", ")} (enable only if needed)`);
  }

  if (missing.length > 0) {
    const key = modelKey(model);
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    const modelsJsonPath = getModelsJsonDisplayPath();
    lines.push(`Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (same level as baseUrl/api/apiKey/models).`);
    if (adaptiveThinkingApplicable) {
      appendAdaptiveThinkingCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
    } else if (deepSeekCompatApplicable) {
      appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    }
  } else if (adaptiveThinkingApplicable || deepSeekCompatApplicable || isCompatCheckApplicable(model)) {
    lines.push("✅ Compat fully configured.");
    appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
  } else {
    lines.push(...getCompatCheckNotApplicableLines(model));
  }

  if (options.promptCacheKey400 && isPromptCacheKeyUnsupportedApplicable(model)) {
    lines.push("");
    lines.push("⚠️  This model previously rejected prompt_cache_key with an explicit HTTP 400 signal.");
    lines.push("   /cache-optimizer fix will offer a precise model-scoped opt-out.");
    lines.push("   The opt-out removes both prompt_cache_key and promptCacheKey from the final request body.");
  }

  if (isPromptCacheRetention400Applicable(model)) {
    lines.push("");
    if (options.promptCacheRetention400) {
      lines.push("⚠️  A 400 response was observed while supportsLongCacheRetention is enabled.");
      lines.push(`   ${getPromptCacheRetentionUnsupportedHint()}`);
    } else {
      lines.push(`ℹ️ Long retention is enabled. ${getPromptCacheRetentionUnsupportedHint()}`);
    }
  }

  if (options.anthropicTtlOrderError) {
    lines.push("");
    lines.push("⚠️  An Anthropic cache-control TTL ordering error was observed for this model.");
    lines.push("   Runtime requests now fall back from 1h to the default 5-minute cache TTL.");
    lines.push(`   Run /cache-optimizer fix to set model-level supportsLongCacheRetention: false in ${getModelsJsonDisplayPath()}.`);
  }

  // ── Session affinity 403 diagnostics ──
  // Advises the user when sendSessionAffinityHeaders is enabled, since some
  // third-party proxies / CDNs / WAFs block Pi's custom session-affinity HTTP
  // headers (session_id, x-client-request-id, x-session-affinity) and return
  // 403. If a 403 was already observed for this model, show a stronger hint.
  if (isSessionAffinity403Applicable(model)) {
    lines.push("");
    if (options.sessionAffinity403) {
      lines.push("⚠️  A 403 response was observed while sendSessionAffinityHeaders is enabled.");
      lines.push("   The proxy/CDN likely blocks Pi's custom session-affinity headers (session_id,");
      lines.push("   x-client-request-id, x-session-affinity). Run /cache-optimizer fix to");
      lines.push(`   set sendSessionAffinityHeaders: false in ${getModelsJsonDisplayPath()}.`);
    } else {
      lines.push("ℹ️ Session affinity headers are enabled. Some CDNs/WAFs block custom headers");
      lines.push("   (session_id, x-client-request-id, x-session-affinity) and return 403. If you");
      lines.push("   see 403 errors, run /cache-optimizer fix to set sendSessionAffinityHeaders: false.");
    }
  } else if (isOpenAISdkHeader403Applicable(model)) {
    lines.push("");
    if (options.openAISdkHeader403) {
      lines.push("⚠️  A 403 response was observed while sendSessionAffinityHeaders is not enabled.");
      lines.push("   The proxy/CDN may be blocking the OpenAI JS SDK request fingerprint");
      lines.push("   (for example User-Agent: OpenAI/JS ... or X-Stainless-* headers). This");
      lines.push("   is provider/WAF-specific; /cache-optimizer fix will not auto-write headers.");
      lines.push(`   Manual workaround: add a provider-level headers.User-Agent override in ${getModelsJsonDisplayPath()}`);
      lines.push("   only after testing the value with the affected provider.");
    } else {
      lines.push("ℹ️ If 403 persists after disabling sendSessionAffinityHeaders, some CDNs/WAFs");
      lines.push("   may block the OpenAI JS SDK User-Agent / X-Stainless-* headers. Test the");
      lines.push("   provider manually before adding a provider-level headers.User-Agent override.");
    }
  }

  // ── Router/channel diagnostics ──
  const routerNotes = describeRouterChannelDiagnostics(model);
  if (routerNotes.length > 0) {
    lines.push("");
    for (const note of routerNotes) {
      lines.push(note);
    }
  }

  return lines.join("\n");
}

/**
 * Build a "Cache diagnosis" section for low-hit causes, appended to doctor output.
 * This is a separate function because it depends on per-session state (recent samples,
 * per-model stats) that is not available at the module level.
 */
function buildLowHitDiagnosis(
  model: PiModel,
  adapter: CacheProviderAdapter | undefined,
  stats: CacheStats | undefined,
  samples: CacheUsageSample[],
): string[] {
  const lines: string[] = [];

  // 1. Missing compat flags (adapter-aware: DeepSeek has extra reasoning compat)
  const fixSugLHD = buildFixSuggestion(model);
  const safeFixableMissingLHD = fixSugLHD ? Object.keys(fixSugLHD.compatKeys) : [];

  // 2. Router/channel risk (reuse existing check)
  const routerNotes = describeRouterChannelDiagnostics(model);

  // 3. Recent samples missing usage fields
  const missingUsageSamples = samples.filter((s) => s.missingUsageFields).length;

  // 4. Recent trend analysis
  const recent10 = samples.slice(-10);
  const recent10Hits = recent10.filter((s) => s.hit).length;
  const recent10Total = recent10.length;
  const recent10Cached = recent10.reduce((sum, s) => sum + s.cachedInputTokens, 0);
  const recent10Input = recent10.reduce((sum, s) => sum + s.totalInputTokens, 0);

  // 5. Today's overall trend from persisted stats
  const todayStats = stats ?? emptyCacheStats();

  const hasMissingCompat = safeFixableMissingLHD.length > 0;
  const hasRouterRisk = routerNotes.length > 0;
  const hasUsageMissing = missingUsageSamples > 0;

  // Today's cached-token ratio is used both inside and outside the recent-sample
  // branch. Keep it block-external so doctor/stats never throw for low-hit
  // models that have persisted counters but no recent in-memory samples.
  const todayHitRatio = todayStats.totalInputTokens > 0
    ? Math.round((todayStats.cachedInputTokens / todayStats.totalInputTokens) * 100)
    : 0;

  // Determine if there are actual issues worth flagging
  const hasActualIssues = hasMissingCompat || hasUsageMissing ||
    // Low hit trend (today total > 3 and hit ratio < 30%)
    (todayStats.totalRequests > 3 && todayStats.totalInputTokens > 0 &&
     (todayStats.cachedInputTokens / todayStats.totalInputTokens) < 0.3) ||
    // Low hit rate in recent samples (recent10Total >= 3 and all misses)
    (recent10Total >= 3 && recent10Hits === 0);

  // Skip section if no issues
  if (!hasActualIssues && !(hasRouterRisk && (hasMissingCompat || hasUsageMissing))) {
    return lines;
  }

  lines.push("");
  lines.push("── Cache diagnosis ──");

  // Priority 1: missing compat flags
  if (hasMissingCompat) {
    lines.push(`⚠️  Missing compat flags: ${safeFixableMissingLHD.join(", ")}`);
    lines.push("   These flags enable prompt caching and session-affinity routing.");
    lines.push("   Run /cache-optimizer compat for edit instructions.");
  }

  // Priority 2: router/channel risk (only flag when there are other issues)
  // Router notes are already shown in the main doctor output, so we only
  // mention them in the diagnosis section when they compound a problem.
  if (hasRouterRisk && (hasMissingCompat || hasUsageMissing || hasActualIssues)) {
    lines.push("🔀 Router/channel proxy detected — see routing notes above.");
  }

  // Priority 3: usage fields missing
  if (hasUsageMissing) {
    lines.push(`⚠️  ${missingUsageSamples}/${samples.length} recent responses had missing/empty usage fields.`);
    lines.push("   Footer may under-report cache hit rate.");
    lines.push("   Verify the proxy returns prompt-level usage (prompt_tokens, input_tokens_details).");
  }

  // Priority 4: recent trend low
  if (recent10Total > 0) {
    const hitRatio = recent10Input > 0 ? Math.round((recent10Cached / recent10Input) * 100) : 0;
    if (recent10Hits === 0 && todayStats.totalRequests > 3 && todayHitRatio < 30) {
      lines.push(`📉 Cache hit rate is low: ${todayHitRatio}% today (${recent10Total} recent samples).`);
      lines.push("   Likely causes: proxy routing to different backends per request,");
      lines.push("   or prompt prefix changes across turns.");
      lines.push("   Verify session affinity (sendSessionAffinityHeaders) and long cache retention.");
    } else if (todayHitRatio < 30 && todayStats.totalRequests > 3) {
      lines.push(`📉 Cache hit rate is low: ${todayHitRatio}% today (${todayStats.totalRequests} total requests).`);
      lines.push("   Check compat flags and proxy upstream routing.");
    }

    // Show brief trend summary if there are enough samples
    if (recent10Total >= 3) {
      const trend = formatRecentTrendSummary(samples, 10);
      lines.push(`📊 ${trend}`);
    }
  }

  // For fully configured but low hit models, emphasize sticky routing
  if (!hasMissingCompat && !hasRouterRisk && todayStats.totalRequests > 3 && todayHitRatio < 30) {
    lines.push("💡 Compat is configured but cache hit rate remains low.");
    lines.push("   Possible causes:");
    lines.push("   • Proxy still routes to multiple backends — check session affinity on the proxy side.");
    lines.push("   • Prompt prefix varies per turn — check dynamic context in system prompt.");
    lines.push("   • Provider does not return cache usage fields — footer can't measure hits.");
  }

  return lines;
}

function buildCompatDiagnosis(model: PiModel): string | undefined {
  const missing = describeMissingCacheCompatForModel(model);
  const fixSugC = buildFixSuggestion(model);
  const safeFixableMissingC = fixSugC ? Object.keys(fixSugC.compatKeys) : [];
  const advisoryMissingC = missing.filter(m => !safeFixableMissingC.includes(m));
  const adaptiveThinkingApplicable = isAdaptiveThinkingCompatApplicable(model);
  const deepSeekCompatApplicable = isDeepSeekCompatCheckApplicable(model);
  const optionalOpenAIProxyCompat = !adaptiveThinkingApplicable
    ? describeOptionalOpenAICompatibleProxyCompat(model)
    : [];
  const routerNotes = describeRouterChannelDiagnostics(model);

  if (missing.length === 0 && routerNotes.length === 0 && optionalOpenAIProxyCompat.length === 0) return undefined;

  const key = modelKey(model);
  const lines: string[] = [];

  if (missing.length > 0) {
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    const modelsJsonPath = getModelsJsonDisplayPath();
    lines.push(`Active model: ${key}`);
    if (safeFixableMissingC.length > 0) {
      lines.push(`Safe-fixable: ${safeFixableMissingC.join(", ")}`);
    }
    if (advisoryMissingC.length > 0) {
      lines.push(`Optional: ${advisoryMissingC.join(", ")} (enable only if needed)`);
    }
    lines.push("");
    lines.push(`Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat`);
    lines.push(`(at the same level as baseUrl/api/apiKey/models).`);
    if (adaptiveThinkingApplicable) {
      appendAdaptiveThinkingCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
    } else if (deepSeekCompatApplicable) {
      appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    }
  }

  // When compat is fully configured but router/optional notes exist, prefix the status.
  if ((routerNotes.length > 0 || optionalOpenAIProxyCompat.length > 0) && missing.length === 0) {
    if (adaptiveThinkingApplicable || deepSeekCompatApplicable || isCompatCheckApplicable(model)) {
      lines.push("✅ Compat fully configured.");
      if (isPromptCacheRetention400Applicable(model)) {
        lines.push(getPromptCacheRetentionUnsupportedHint());
      }
      // Advisory for 403 session-affinity header blocking (only when enabled),
      // or OpenAI SDK header/User-Agent blocking after session affinity is disabled.
      if (isSessionAffinity403Applicable(model)) {
        lines.push(
          "ℹ️ Session affinity headers are enabled. If you see 403 \"blocked\" errors,",
          "   the proxy/CDN may be blocking Pi's custom headers. Set sendSessionAffinityHeaders: false.",
        );
      } else if (isOpenAISdkHeader403Applicable(model)) {
        lines.push(
          "ℹ️ If 403 persists with sendSessionAffinityHeaders disabled, the proxy/CDN may",
          "   be blocking the OpenAI JS SDK User-Agent / X-Stainless-* headers. Test a",
          "   provider-level headers.User-Agent override manually; /fix does not auto-write it.",
        );
      }
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      lines.push(...getCompatCheckNotApplicableLines(model));
    }
    lines.push("");
  }

  if (routerNotes.length > 0) {
    if (missing.length > 0) lines.push("");
    for (const note of routerNotes) {
      lines.push(note);
    }
  }

  return lines.join("\n");
}

// ============================================================
// JSONC comment-preserving surgical edit helpers for /cache-optimizer fix
// ============================================================

/**
 * Build the fix suggestion for the current active model.
 * Returns undefined if there is nothing to fix.
 */
function buildFixSuggestion(model: PiModel): FixSuggestion | undefined {
  const missing = describeMissingCacheCompatForModel(model);
  if (missing.length === 0) return undefined;

  let compatKeys: Record<string, unknown> = {};

  if (isAdaptiveThinkingCompatApplicable(model)) {
    compatKeys = buildAdaptiveThinkingCompatSuggestion(missing);
  } else if (isDeepSeekCompatCheckApplicable(model)) {
    compatKeys = buildDeepSeekCompatSuggestion(missing);
  } else {
    compatKeys = buildSafeOpenAIProxyCompatSuggestion(missing);
  }

  if (Object.keys(compatKeys).length === 0) return undefined;

  const key = modelKey(model);
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;

  return {
    providerLabel,
    modelId: model.id,
    compatKeys,
  };
}

// Internal helpers exported only so the task verification script
// (.trellis/tasks/.../verify.ts) can exercise them. They are not part of the
// extension's public API; pi only invokes the default export below.
export const __internals_for_tests = {
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
  type ProviderRequestState = {
    model: PiModel;
    responseReceived: boolean;
    correlationAmbiguous: boolean;
    // A native virtual request whose dispatched id matched several providers.
    identityAmbiguous?: boolean;
  };
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
    if (isNativeVirtualModel(_ctx.model) && !canRewriteNativeVirtualPrompt(_ctx.model, _ctx)) {
      return {};
    }

    if (!runtimeOptimizerEnabled) return {};

    // Global opt-out: PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1 bypasses all
    // prompt mutations below (session-overview churn strip and skill
    // compression). Footer stats and the OpenAI prompt_cache_key fallback
    // remain active.
    if (!featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true)) return {};

    // Skill compression first, as a section edit when Pi supports it (see
    // compressSkillsViaSection); the string path below is the fallback.
    compressSkillsViaSection(event);

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
  async function handleCacheOptimizerCommand(
    args: string,
    cmdCtx: ExtensionCommandContext,
  ): Promise<void> {
    syncSessionHash(cmdCtx);
    const selectedModel = cmdCtx.model;
    const model = resolveRouteModel(selectedModel, cmdCtx) ?? selectedModel;
    const commandParts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const subcommand = commandParts[0] || "help";

      if (subcommand === "enable") {
        setRuntimeOptimizerEnabled(true);
        await resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx);
        await publishStatus(cmdCtx, model);
        cmdCtx.ui.notify(`✅ Pi Cache Optimizer enabled for this Pi process. Local footer stats were reset for before/after comparison.\n${formatOptimizerRuntimeMode()}`, "info");
      } else if (subcommand === "disable") {
        setRuntimeOptimizerEnabled(false);
        providerRequestStates.length = 0;
        await resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx);
        await publishStatus(cmdCtx, model);
        cmdCtx.ui.notify(`⏸️ Pi Cache Optimizer disabled for this Pi process. Local footer stats were reset and will keep collecting while disabled for comparison.\n${formatOptimizerRuntimeMode()}`, "warning");
      } else if (subcommand === "doctor") {
        await refreshShardAggregate();
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const diagnosis = buildDoctorDiagnosis(model, { promptCacheRetention400: promptCacheRetention400Models.has(modelKey(model)), promptCacheKey400: promptCacheKeyRejectedModels.has(modelKey(model)), anthropicTtlOrderError: anthropicTtlOrderErrorModels.has(modelKey(model)), sessionAffinity403: sendSessionAffinityHeaders403Models.has(modelKey(model)), openAISdkHeader403: openAISdkHeader403Models.has(modelKey(model)) });
        const adapter = selectAdapterForModel(model);
        const sk = model ? sessionModelKey(model) : undefined;
        const statsState = model ? cacheStatsTotalsByModel[modelKey(model)] : undefined;
        const samples = sk ? getRecentSamples(sk) : [];
        const lowHitLines = buildLowHitDiagnosis(model, adapter, statsState, samples);
        const routeNote = describeNativeVirtualRouteNote(selectedModel, model);
        const fullDiagnosis = [routeNote, diagnosis, ...lowHitLines].filter((line) => line !== undefined).join("\n");
        cmdCtx.ui.notify(fullDiagnosis, "info");
      } else if (subcommand === "stats") {
        const aggregate = await refreshShardAggregate();
        const statsMode = commandParts[1];
        if (statsMode === "all") {
          cmdCtx.ui.notify(buildAllStatsOutput(aggregate), "info");
        } else if (statsMode === "contributors") {
          cmdCtx.ui.notify(buildContributorsStatsOutput(aggregate, model, currentSessionHashSet ? currentSessionHash : undefined), "info");
        } else if (statsMode) {
          cmdCtx.ui.notify("Usage: /cache-optimizer stats [all|contributors]", "info");
        } else {
          const sessionModels = currentSessionHashSet ? aggregate.bySession[currentSessionHash] ?? {} : {};
          cmdCtx.ui.notify(buildSessionStatsOutput(sessionModels, model, aggregate.modelRefsByKey), "info");
        }
      } else if (subcommand === "config") {
        const configKey = commandParts[1];
        const requestedMode = commandParts[2];
        const feature = configKey ? FEATURE_COMMAND_MAP[configKey] : undefined;
        if (feature && (requestedMode === "on" || requestedMode === "off")) {
          try {
            await writePersistedFeature(feature, requestedMode === "on");
            lastStatusText = undefined;
            await publishStatus(cmdCtx, model);
            cmdCtx.ui.notify(`✅ ${configKey} set to ${requestedMode}. Persistent config overrides its environment variable.`, "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not update ${configKey}: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        if (configKey === "reset") {
          try {
            await writePersistedCacheOptimizerConfig({ version: 2, footerMode: persistedFooterStatsMode, promptCacheKey: persistedCacheOptimizerConfig.promptCacheKey });
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify("✅ Feature configuration reset. Environment variables now apply again.", "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not reset feature configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        if (!configKey) {
          cmdCtx.ui.notify(formatPersistentFeatureConfig() + `\n• Footer mode: ${resolveFooterStatsMode(persistedFooterStatsMode).mode}` + "\n\n" +
            "Usage: /cache-optimizer config <feature> on|off | footer-mode total|session|process | reset", "info");
          return;
        }
        if (configKey !== "footer-mode" || !requestedMode || !["session", "total", "process"].includes(requestedMode)) {
          const resolved = resolveFooterStatsMode(persistedFooterStatsMode);
          cmdCtx.ui.notify(
            `Usage: /cache-optimizer config footer-mode total|session|process\n` +
            `       /cache-optimizer config prompt-rewrite|virtual-rewrite|skill-compression|openai-cache-key|tool-order on|off\n` +
            `       /cache-optimizer config reset\n` +
            `Current footer mode: ${resolved.mode} (${resolved.source})`,
            "info",
          );
          return;
        }

        const nextMode = requestedMode as FooterStatsMode;
        try {
          await writePersistedFooterMode(nextMode);
          setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
          lastStatusText = undefined;
          await publishStatus(cmdCtx, model);
          const resolved = resolveFooterStatsMode(persistedFooterStatsMode);
          cmdCtx.ui.notify(
            `✅ Footer mode set to ${resolved.mode}. Persistent config overrides ${FOOTER_MODE_ENV}.`,
            "info",
          );
        } catch (error) {
          cmdCtx.ui.notify(
            `❌ Could not update footer mode config: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      } else if (subcommand === "compat") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const compatResult = buildCompatDiagnosis(model);
        const compatRouteNote = describeNativeVirtualRouteNote(selectedModel, model);
        const withRouteNote = (text: string): string => compatRouteNote ? `${compatRouteNote}\n${text}` : text;
        if (compatResult) {
          cmdCtx.ui.notify(withRouteNote(compatResult), "warning");
        } else {
          cmdCtx.ui.notify(
            withRouteNote(isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)
              ? "✅ Compat fully configured."
              : getCompatCheckNotApplicableLines(model).join("\n")),
            "info",
          );
        }
      } else if (subcommand === "rollback") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const configReceiptSnapshot = await readPromptCacheKeyConfigReceiptSnapshot();
        const configReceipt = configReceiptSnapshot?.receipt;
        const modelsReceipt = await readModelsJsonFixReceipt();
        const useConfigReceipt = isActionablePromptCacheKeyConfigReceipt(configReceipt) &&
          configReceipt.provider === model.provider &&
          configReceipt.modelId === model.id &&
          (!isActionableModelsJsonFixReceipt(modelsReceipt) || modelsReceipt.provider !== model.provider ||
            (modelsReceipt.placement !== "provider" && modelsReceipt.modelId !== model.id) || configReceipt.appliedAt >= modelsReceipt.appliedAt);
        if (useConfigReceipt) {
          if (!cmdCtx.hasUI) {
            cmdCtx.ui.notify("❌ Rollback requires interactive confirmation. No changes were made.\nRun /cache-optimizer rollback in Pi's interactive UI to restore the prompt-cache-key setting.", "warning");
            return;
          }
          const confirmed = await cmdCtx.ui.confirm(
            "Cache Optimizer — Rollback prompt_cache_key opt-out",
            `Model: ${modelKey(model)}\nAction: restore the extension config before the confirmed opt-out.\nFooter mode and unrelated configuration will be preserved.\nAfterward, run /reload or restart Pi.\n\nProceed with rollback?`,
          );
          if (!confirmed) {
            cmdCtx.ui.notify("No changes were made. Rollback canceled by user.", "info");
            return;
          }
          try {
            if (!configReceiptSnapshot) throw new Error("prompt-cache-key receipt changed since the rollback preview");
            await rollbackPromptCacheKeyConfig(configReceiptSnapshot);
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify(`✅ Restored prompt_cache_key behavior for ${modelKey(model)}. Run /reload or restart Pi for the change to take effect.`, "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Prompt cache key rollback refused: ${error instanceof Error ? error.message : String(error)}. No changes were made.`, "error");
          }
          return;
        }
        if (!cmdCtx.hasUI) {
          const receipt = await readModelsJsonFixReceipt();
          const backupHint = receipt && isActionableModelsJsonFixReceipt(receipt)
            ? ` The recorded backup is ${receipt.backupFile} next to ${getModelsJsonDisplayPath()}.`
            : " Check the recorded models.json backup manually if a fix receipt exists.";
          cmdCtx.ui.notify(
            "❌ Rollback requires interactive confirmation. No changes were made.\n" +
            `Run /cache-optimizer rollback in Pi's interactive UI.${backupHint} Then run /reload.`,
            "warning",
          );
          return;
        }

        const receiptSnapshot = await readModelsJsonFixReceiptSnapshot();
        const receipt = receiptSnapshot?.receipt;
        if (!receiptSnapshot || !isActionableModelsJsonFixReceipt(receipt)) {
          cmdCtx.ui.notify("ℹ️ No unapplied /cache-optimizer fix receipt was found.", "info");
          return;
        }
        if (receipt.provider !== model.provider || (receipt.placement !== "provider" && receipt.modelId !== model.id)) {
          cmdCtx.ui.notify(
            `ℹ️ The latest fix receipt is for ${receipt.provider}/${receipt.modelId}, not the active model ${model.provider}/${model.id}. ` +
            "Switch to the matching model before running rollback. No changes were made.",
            "warning",
          );
          return;
        }

        const rollback = await prepareModelsJsonRollback(receiptSnapshot);
        if ("error" in rollback) {
          cmdCtx.ui.notify(`ℹ️ ${rollback.error}`, "info");
          return;
        }

        const rollbackScope = rollback.mode === "exact"
          ? "restore the exact pre-fix models.json because the file is unchanged since the fix"
          : "restore only the receipt-owned compat scalar keys and preserve subsequent user changes";
        const rollbackPreview = [
          `Rollback transaction ${rollback.receipt.transactionId}:`,
          `Model: ${rollback.receipt.provider}/${rollback.receipt.modelId}`,
          `Action: ${rollbackScope}.`,
          `A new rollback backup will be written to: ${rollback.rollbackBackupPath}`,
          "Comments, credentials, unrelated fields, and the existing access mode will be preserved.",
          "Afterward, run /reload or restart Pi for the configuration change to take effect.",
          "",
          "Proceed with rollback?",
        ].join("\n");
        const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Rollback", rollbackPreview);
        if (!confirmed) {
          cmdCtx.ui.notify("No changes were made. Rollback canceled by user.", "info");
          return;
        }

        try {
          const result = await applyModelsJsonFixTransaction(
            rollback.modifiedText,
            rollback.rollbackBackupPath,
            (writtenText) => validateModelsJsonRollback(
              writtenText,
              rollback.receipt,
              rollback.expectedResultHash,
            ),
            {
              expectedCurrentHash: rollback.currentHash,
              expectedCurrentMode: rollback.fileMode,
              receiptGuard: rollback.receiptSnapshot,
              purpose: "rollback",
              onCommitted: async () => {
                await markModelsJsonFixReceiptRolledBack(rollback.receiptSnapshot);
              },
            },
          );
          if ("postCheckError" in result) {
            cmdCtx.ui.notify(
              `❌ Rollback self-check failed: ${result.postCheckError}\n` +
              `The rollback backup at ${rollback.rollbackBackupPath} was restored. No changes applied.`,
              "error",
            );
            return;
          }
          invalidateModelsConfigCache();
          cmdCtx.ui.notify(
            `✅ Rollback completed for ${rollback.receipt.provider}/${rollback.receipt.modelId}.\n` +
            `Rollback backup saved to: ${rollback.rollbackBackupPath}\n` +
            "The receipt was marked as rolled back. Run /reload or restart Pi for the change to take effect.",
            "info",
          );
        } catch (rollbackError) {
          cmdCtx.ui.notify(
            `❌ Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\n` +
            "No automatic overwrite was performed; use the recorded backup for manual guidance.",
            "error",
          );
        }
      } else if (subcommand === "reset") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const adapter = selectAdapterForModel(model);
        if (!adapter) {
          cmdCtx.ui.notify("ℹ️ Active model does not match a cache adapter. No stats to reset.", "info");
          return;
        }

        const displayKey = modelKey(model);

        // Reset local footer stats for the effective active model. If the
        // selected model is a virtual router and the protocol exposes a live
        // route, this clears the real upstream bucket, not the router shell.
        await resetStatsForModel(model);

        // Persist immediately.
        await flushPersistCacheStats(cmdCtx);

        // Update footer to show 0/0.
        await publishStatus(cmdCtx, model);

        cmdCtx.ui.notify(
          `✅ Reset local footer cache stats for "${displayKey}". ` +
          "Upstream provider prompt cache was not modified. " +
          "New requests will start a fresh local stats bucket for this provider/model.",
          "info",
        );
      } else if (subcommand === "fix") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }

        const promptCacheKeyRequested = commandParts[1] === "prompt-cache-key";
        const promptCacheKeyFixRequested = promptCacheKeyRequested || promptCacheKeyFixApplies(model);
        if (promptCacheKeyRequested && !isPromptCacheKeyUnsupportedApplicable(model)) {
          cmdCtx.ui.notify("ℹ️ Prompt cache key opt-out applies only to a known OpenAI-compatible provider/model endpoint. No changes were made.", "info");
          return;
        }
        const suggestion = promptCacheKeyFixRequested ? undefined : buildCommandFixSuggestion(model);

        if (promptCacheKeyFixRequested) {
          if (isPromptCacheKeyOmittedForModel(model)) {
            cmdCtx.ui.notify(`✅ prompt_cache_key is already omitted for "${modelKey(model)}".`, "info");
            return;
          }
          if (!cmdCtx.hasUI) {
            cmdCtx.ui.notify(
              "❌ Non-interactive terminal detected. Prompt cache key opt-out requires UI confirmation. No changes were made.\n" +
              `Run /cache-optimizer fix prompt-cache-key in Pi's interactive UI for ${modelKey(model)}.`,
              "warning",
            );
            return;
          }
          const preview = [
            "📝 Preview of extension configuration change:",
            ...buildPromptCacheKeyConfigPreview(model),
            "",
            "⚠️ Risk notice:",
            "  1. This affects all sessions using this exact provider/model.",
            "  2. Provider prompt-cache reuse may decrease because both key spellings are removed.",
            "  3. This does not modify Pi's models.json, credentials, prompts, headers, or other models.",
            "  4. The extension config will be backed up and Pi must be reloaded/restarted.",
            "",
            "Apply this persistent opt-out?",
          ].join("\n");
          const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Omit prompt_cache_key", preview);
          if (!confirmed) {
            cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
            return;
          }
          try {
            const result = await applyPromptCacheKeyConfigFix(model);
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify(
              `✅ Prompt cache key opt-out saved for ${modelKey(model)}.\n` +
              `Config backup saved to: ${result.backupPath}\n` +
              "Run /reload or restart Pi for the change to take effect. Use /cache-optimizer rollback to restore it.",
              "info",
            );
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not save prompt cache key opt-out: ${error instanceof Error ? error.message : String(error)}. No changes were made.`, "error");
          }
          return;
        }

        if (!suggestion) {
          const key = modelKey(model);
          cmdCtx.ui.notify(`✅ Nothing to fix for "${key}". Compat already configured.`, "info");
          return;
        }

        if (!cmdCtx.hasUI) {
          // No UI — refuse to write, show manual guidance instead.
          const compatResult = buildCompatDiagnosis(model);
          const snippet = formatMissingEntryManualSnippet(
            suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
          );
          const manualLines = [
            `❌ Non-interactive terminal detected. Auto-fix requires UI confirmation.`,
            "",
            `Edit ${getModelsJsonDisplayPath()} and run /reload.`,
          ];
          if (promptCacheRetention400Models.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned HTTP 400 for prompt_cache_retention.",
              "Create or edit the entry below to override supportsLongCacheRetention to false.",
            );
          }
          if (anthropicTtlOrderErrorModels.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned an Anthropic cache-control TTL ordering error.",
              "Create or edit the entry below to override supportsLongCacheRetention to false.",
            );
          }
          if (sendSessionAffinityHeaders403Models.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned HTTP 403 while sendSessionAffinityHeaders was enabled.",
              "Create or edit the entry below to override sendSessionAffinityHeaders to false.",
            );
          }
          manualLines.push(
            "",
            "Add these compat keys at Pi's highest-precedence model override path:",
            `providers["${suggestion.providerLabel}"] -> modelOverrides -> "${suggestion.modelId}" -> compat:`,
            formatCompatKeysForInsertion(suggestion.compatKeys),
          );
          if (snippet.length > 0) {
            manualLines.push(
              "",
              "If the provider/model is missing (common for API-logged-in channels such as",
              `opencode go), add a minimal entry under "providers" (keep existing auth as-is):`,
              "",
              snippet,
            );
          }
          if (compatResult) {
            manualLines.push("", compatResult);
          }
          cmdCtx.ui.notify(manualLines.join("\n"), "warning");
          return;
        }

        // Read the models.json file
        let originalText: string;
        try {
          originalText = await readFile(MODELS_JSON_PATH, "utf8");
        } catch {
          cmdCtx.ui.notify(`❌ Could not read ${MODELS_JSON_PATH}. File may not exist.`, "error");
          return;
        }

        // Locate the model entry. API-logged-in providers (e.g. opencode go)
        // may not appear in models.json at all.
        const location = locateModelInJsonc(originalText, suggestion.providerLabel, suggestion.modelId);
        if (!location) {
          const diagnosis = analyzeModelsJsonForMissingEntry(originalText, suggestion.providerLabel, suggestion.modelId);
          const parsedOriginal = (() => { try { return parseJsonc(originalText); } catch { return undefined; } })();
          const provider = asRecord(asRecord(parsedOriginal)?.providers)?.[suggestion.providerLabel];
          const explicit = resolveExplicitCompatValue(parsedOriginal, suggestion.providerLabel, suggestion.modelId, "sendSessionAffinityHeaders");
          const targetOverrideLocation = locateModelOverrideInJsonc(
            originalText, suggestion.providerLabel, suggestion.modelId,
          );
          const hasTargetOverride = (targetOverrideLocation?.modelOverrideObjectBrace ?? -1) >= 0;
          const providerPlan = diagnosis && diagnosis.scenario !== "provider_missing" &&
            isValidModelsConfigForEffectiveCompat(parsedOriginal) && asRecord(provider) &&
            Object.keys(suggestion.compatKeys).length === 1 && suggestion.compatKeys.sendSessionAffinityHeaders === true &&
            !suggestion.forceModelLevel && !hasTargetOverride && explicit === undefined &&
            getEffectiveCompatValueSource(model, parsedOriginal, "sendSessionAffinityHeaders") === undefined
              ? composeProviderAffinityInsertion(originalText, suggestion.providerLabel)
              : undefined;
          if (providerPlan) {
            const checkProvider = (writtenText: string): string | null => {
              try {
                const changed = parseJsonc(writtenText);
                if (!isValidModelsConfigForEffectiveCompat(changed)) return "provider config is invalid";
                if (resolveEffectiveCompatFromConfig(model, changed).sendSessionAffinityHeaders !== true) return "affinity flag is not effective";
                const reverted = JSON.parse(JSON.stringify(changed)) as Record<string, unknown>;
                const target = asRecord(asRecord(reverted.providers)?.[suggestion.providerLabel]);
                const compat = asRecord(target?.compat);
                if (!target || !compat || compat.sendSessionAffinityHeaders !== true) return "provider affinity key is missing";
                delete compat.sendSessionAffinityHeaders;
                const originalCompat = asRecord(asRecord(provider)?.compat);
                if (!originalCompat) delete target.compat;
                return JSON.stringify(reverted) === JSON.stringify(parsedOriginal) ? null : "unrelated configuration was altered";
              } catch { return "invalid provider JSONC"; }
            };
            const checkError = checkProvider(providerPlan.modifiedText);
            if (checkError) {
              cmdCtx.ui.notify(`❌ Provider-level self-check failed: ${checkError}. No changes were made.`, "error");
              return;
            }
            const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${backupTimestamp()}`;
            const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Fix provider affinity", [
              `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
              `Location: ${providerPlan.placementLabel}`,
              `Compat JSON to write: ${JSON.stringify(suggestion.compatKeys)}`,
              `⚠️ This affects all models using this provider across all sessions; model-level overrides remain authoritative.`,
              `A timestamped backup will be written to: ${backupPath}`,
              "Run /reload or restart Pi for the change to take effect.",
              "Apply these changes?",
            ].join("\n"));
            if (!confirmed) {
              cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
              return;
            }
            const receipt = createModelsJsonFixReceipt(
              originalText, providerPlan.modifiedText, suggestion.providerLabel, suggestion.modelId,
              "provider", suggestion.compatKeys, true, backupPath,
            );
            if (!receipt) {
              cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
              return;
            }
            try {
              const result = await applyModelsJsonFixTransaction(providerPlan.modifiedText, backupPath, checkProvider, {
                expectedCurrentHash: hashText(originalText), purpose: "fix",
                onCommitted: async () => writeModelsJsonFixReceipt(receipt),
              });
              if ("postCheckError" in result) {
                cmdCtx.ui.notify(`❌ Post-write self-check failed: ${result.postCheckError}. Backup restored.`, "error");
                return;
              }
              invalidateModelsConfigCache();
              cmdCtx.ui.notify(`✅ Fix applied to ${getModelsJsonDisplayPath()}.\nBackup saved to: ${backupPath}\nRun /reload or restart Pi.`, "info");
            } catch (error) {
              cmdCtx.ui.notify(`❌ Write failed: ${error instanceof Error ? error.message : String(error)}. Backup may be at: ${backupPath}`, "error");
            }
            return;
          }
          if (diagnosis && cmdCtx.hasUI) {
            const overrideLocation = locateModelOverrideInJsonc(
              originalText, suggestion.providerLabel, suggestion.modelId,
            );
            const repairsExistingOverride = (overrideLocation?.modelOverrideObjectBrace ?? -1) >= 0;
            // Prefer a modelOverrides edit when models[] has no target entry.
            const plan = composeModelOverrideInsertion(
              originalText, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
            );
            if (!plan) {
              cmdCtx.ui.notify(
                `❌ Could not safely locate a modelOverrides insertion point.\n` +
                `Falling back to manual guidance. No changes were made.`,
                "error",
              );
            } else {
            const checkError = selfCheckMissingEntryInsertion(
              originalText, plan.modifiedText,
              suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
              model,
            );
            if (checkError !== null) {
              // Fall through to manual guidance.
              cmdCtx.ui.notify(
                `❌ Self-check would fail for auto-created entry: ${checkError}\n` +
                `Falling back to manual guidance. No changes were made.`,
                "error",
              );
              // Continue to manual guidance below.
            } else {
              const keysPreview = JSON.stringify(suggestion.compatKeys, null, 2);
              const ts = backupTimestamp();
              const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${ts}`;
              const previewLines = [
                `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
                ``,
                `Location: ${plan.placementLabel}`,
                `Compat JSON to write:`,
                keysPreview,
                ``,
                `⚠️  Risk notice:`,
                repairsExistingOverride
                  ? `  1. This updates the existing modelOverrides entry for "${suggestion.modelId}". Existing auth is not affected.`
                  : `  1. This creates a modelOverrides entry in models.json. Existing auth (e.g. login API tokens) is not affected.`,
                `  2. A timestamped backup will be written to: ${backupPath}`,
                `  3. You must run /reload or restart Pi for the change to take effect.`,
                `  4. If the file contains comments or unusual formatting, please verify the result after write.`,
              ];
              if (promptCacheRetention400Models.has(modelKey(model))) {
                previewLines.push(
                  "",
                  "💡  This fix overrides supportsLongCacheRetention to false because",
                  "a 400 prompt_cache_retention error was observed for this model.",
                  "After applying and reloading, Pi will no longer send the",
                  "prompt_cache_retention parameter to this provider.",
                );
              }
              previewLines.push("", `Apply these changes?`);
              const confirmed = await cmdCtx.ui.confirm(
                repairsExistingOverride ? "Cache Optimizer — Fix (model override)" : "Cache Optimizer — Fix (new override)",
                previewLines.join("\n"),
              );
              if (confirmed) {
                try {
                  const receipt = createModelsJsonFixReceipt(
                    originalText,
                    plan.modifiedText,
                    suggestion.providerLabel,
                    suggestion.modelId,
                    "modelOverride",
                    suggestion.compatKeys,
                    repairsExistingOverride,
                    backupPath,
                  );
                  if (!receipt) {
                    cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
                    return;
                  }
                  const result = await applyModelsJsonFixTransaction(
                    plan.modifiedText,
                    backupPath,
                    (writtenText) => selfCheckMissingEntryInsertion(
                      originalText,
                      writtenText,
                      suggestion.providerLabel,
                      suggestion.modelId,
                      suggestion.compatKeys,
                      model,
                    ),
                    {
                      expectedCurrentHash: hashText(originalText),
                      purpose: "fix",
                      onCommitted: async () => writeModelsJsonFixReceipt(receipt),
                    },
                  );
                  if ("postCheckError" in result) {
                    cmdCtx.ui.notify(
                      `❌ Post-write self-check failed: ${result.postCheckError}\n` +
                      `The backup at ${backupPath} has been restored. No changes applied.`,
                      "error",
                    );
                    return;
                  }
                  invalidateModelsConfigCache();
                  cmdCtx.ui.notify(
                    `✅ Fix applied to ${getModelsJsonDisplayPath()}.\n` +
                    `Backup saved to: ${backupPath}\n` +
                    `Run /reload or restart Pi for the change to take effect.`,
                    "info",
                  );
                } catch (e) {
                  cmdCtx.ui.notify(
                    `❌ Write failed: ${e instanceof Error ? e.message : String(e)}\n` +
                    `Backup may be at: ${backupPath}`,
                    "error",
                  );
                }
                return;
              }
              cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
              return;
            }
            }
          }

          // Non-interactive or no diagnosis: show manual guidance.
          const snippet = diagnosis
            ? formatMissingEntryManualSnippet(suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys)
            : formatCompatKeysForInsertion(suggestion.compatKeys);
          const adviceLines: string[] = [];
          if (!diagnosis) {
            adviceLines.push(
              `❌ Could not locate model "${suggestion.modelId}" or provider "${suggestion.providerLabel}" in ${getModelsJsonDisplayPath()}.`,
              "",
              "Providers that were added via Pi /login API (e.g. opencode go) do not have",
              "entries in models.json. You can create a minimal modelOverrides entry by hand:",
            );
          } else if (diagnosis.scenario === "provider_missing") {
            adviceLines.push(
              `ℹ️ Provider "${suggestion.providerLabel}" does not exist in ${getModelsJsonDisplayPath()}.`,
              `This is common for API-logged-in providers (e.g. /login ...).`,
              "",
              "Add the following minimal block under the \"providers\" key (keep your",
              "existing authentication as-is):",
            );
          } else {
            adviceLines.push(
              `ℹ️ Model "${suggestion.modelId}" was not found in ${getModelsJsonDisplayPath()}`,
              `under providers["${suggestion.providerLabel}"].`,
              "",
              "Add the following modelOverrides entry (keep existing auth):",
            );
          }
          adviceLines.push("", snippet, "", "Then save and run /reload.");
          cmdCtx.ui.notify(adviceLines.join("\n"), "warning");
          return;
        }

        const duplicateTargetDefinitions = location.allModelIds.filter(
          (configuredModelId) => configuredModelId === suggestion.modelId,
        ).length;
        if (duplicateTargetDefinitions > 1) {
          cmdCtx.ui.notify(
            `❌ ${getModelsJsonDisplayPath()} contains ${duplicateTargetDefinitions} custom model definitions ` +
            `with the exact id "${suggestion.modelId}" under providers["${suggestion.providerLabel}"].\n` +
            `Pi uses the last definition, but /cache-optimizer fix refuses an ambiguous duplicate-id edit. ` +
            `Remove or consolidate the duplicates, then run the command again.`,
            "error",
          );
          return;
        }

        // Compose the modified text — observed runtime failures are always
        // model-scoped; ordinary compat fixes use the safety-based placement.
        const decision = chooseFixPlacement(
          originalText,
          location,
          suggestion.compatKeys,
          suggestion.providerLabel,
          suggestion.forceModelLevel,
        );
        const createsModelOverride = decision.placement === "modelOverride" && location.modelOverrideObjectBrace < 0;
        const modelOverridePlan = createsModelOverride
          ? composeModelOverrideInsertion(
              originalText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
            )
          : undefined;
        if (createsModelOverride && !modelOverridePlan) {
          cmdCtx.ui.notify(
            "❌ Could not safely create the highest-precedence model override. No changes were made.",
            "error",
          );
          return;
        }
        const modifiedText = modelOverridePlan?.modifiedText
          ?? composeFixInsertion(originalText, location, suggestion.compatKeys, decision.placement);

        // Self-check against the same provider → model → runtime →
        // modelOverride precedence used by request hooks.
        const checkError = createsModelOverride
          ? selfCheckMissingEntryInsertion(
              originalText,
              modifiedText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
              model,
            )
          : selfCheckFix(
              originalText,
              modifiedText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
              decision.placement,
              model,
            );
        if (checkError !== null) {
          cmdCtx.ui.notify(
            `❌ Self-check failed before write: ${checkError}\n` +
            `No changes were made. Manual edit required.`,
            "error",
          );
          return;
        }

        // Build preview snippet as copyable JSON (the surgical editor will
        // insert or repair these exact compat key/value pairs).
        const keysPreview = JSON.stringify(suggestion.compatKeys, null, 2);
        const targetHasCompat = decision.placement === "provider"
          ? location.providerCompatBrace >= 0
          : decision.placement === "modelOverride"
            ? location.modelOverrideCompatBrace >= 0
            : location.compatObjectBrace >= 0;
        const placementDesc = targetHasCompat ? `existing "compat" object` : `new "compat" object`;
        const locationDesc = decision.placement === "provider"
          ? `providers["${suggestion.providerLabel}"] -> compat (provider level, ${placementDesc})`
          : decision.placement === "modelOverride"
            ? `providers["${suggestion.providerLabel}"] -> modelOverrides -> "${suggestion.modelId}" -> compat (${placementDesc})`
            : `providers["${suggestion.providerLabel}"] -> models -> "${suggestion.modelId}" -> compat (model level, ${placementDesc})`;

        const ts = backupTimestamp();
        const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${ts}`;

        const scopeRiskLine = decision.placement === "provider"
          ? `  1. This change applies to ALL ${location.allModelIds.length || 1} model(s) in the "${suggestion.providerLabel}" provider, across all sessions.`
          : `  1. This change affects ALL sessions using the "${suggestion.providerLabel}" provider/channel (scoped to model "${suggestion.modelId}").`;

        const previewLines = [
          `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
          ``,
          `Location: ${locationDesc}`,
          `Placement: ${decision.placement} level — ${decision.reason}`,
          `Compat JSON to write:`,
          keysPreview,
          ``,
          `⚠️  Risk notice:`,
          scopeRiskLine,
          `  2. A timestamped backup will be written to: ${backupPath}`,
          `  3. You must restart Pi / run /reload for the change to take effect.`,
          `  4. If the file contains comments or unusual formatting, please verify the result after write.`,
        ];
        if (promptCacheRetention400Models.has(modelKey(model))) {
          previewLines.push(
            "",
            "💡  This fix overrides supportsLongCacheRetention to false because",
            "a 400 prompt_cache_retention error was observed for this model.",
            "After applying and reloading, Pi will no longer send the",
            "prompt_cache_retention parameter to this provider.",
          );
        }
        previewLines.push("", `Apply these changes?`);

        const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Fix", previewLines.join("\n"));
        if (!confirmed) {
          cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
          return;
        }

        // Write: backup → temp + rename → self-check again
        try {
          const receipt = createModelsJsonFixReceipt(
            originalText,
            modifiedText,
            suggestion.providerLabel,
            suggestion.modelId,
            decision.placement,
            suggestion.compatKeys,
            !createsModelOverride,
            backupPath,
          );
          if (!receipt) {
            cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
            return;
          }
          const result = await applyModelsJsonFixTransaction(
            modifiedText,
            backupPath,
            (writtenText) => createsModelOverride
              ? selfCheckMissingEntryInsertion(
                  originalText,
                  writtenText,
                  suggestion.providerLabel,
                  suggestion.modelId,
                  suggestion.compatKeys,
                  model,
                )
              : selfCheckFix(
                  originalText,
                  writtenText,
                  suggestion.providerLabel,
                  suggestion.modelId,
                  suggestion.compatKeys,
                  decision.placement,
                  model,
                ),
            {
              expectedCurrentHash: hashText(originalText),
              purpose: "fix",
              onCommitted: async () => writeModelsJsonFixReceipt(receipt),
            },
          );
          if ("postCheckError" in result) {
            cmdCtx.ui.notify(
              `❌ Post-write self-check failed: ${result.postCheckError}\n` +
              `The backup at ${backupPath} has been restored. No changes applied.`,
              "error",
            );
            return;
          }

          invalidateModelsConfigCache();
          cmdCtx.ui.notify(
            `✅ Fix applied to ${getModelsJsonDisplayPath()}.\n` +
            `Backup saved to: ${backupPath}\n` +
            `Run /reload or restart Pi for the change to take effect.`,
            "info",
          );
        } catch (writeError) {
          cmdCtx.ui.notify(
            `❌ Write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}\n` +
            `Backup may be at: ${backupPath}`,
            "error",
          );
        }
      } else {
        // Try interactive selection menu when UI supports it
        if (cmdCtx.hasUI) {
          const menuOptions = [
            "Enable — Turn on runtime optimizations",
            "Disable — Turn off runtime optimizations",
            "Doctor — Show cache configuration",
            "Stats — Show current-session model statistics",
            "Compat — Show compat suggestion",
            "Fix — Auto-fix compat issues (writes models.json or extension config)",
            "Disable prompt_cache_key — Omit it for the active model",
            "Rollback — Undo the latest confirmed fix",
            "Footer mode — Choose total, session, or process stats",
            "Reset — Reset local provider/model stats",
            "Cancel",
          ];
          const choice = await cmdCtx.ui.select("Cache Optimizer", menuOptions);
          if (choice === menuOptions[0]) {
            await handleCacheOptimizerCommand("enable", cmdCtx);
          } else if (choice === menuOptions[1]) {
            await handleCacheOptimizerCommand("disable", cmdCtx);
          } else if (choice === menuOptions[2]) {
            await handleCacheOptimizerCommand("doctor", cmdCtx);
          } else if (choice === menuOptions[3]) {
            await handleCacheOptimizerCommand("stats", cmdCtx);
          } else if (choice === menuOptions[4]) {
            await handleCacheOptimizerCommand("compat", cmdCtx);
          } else if (choice === menuOptions[5]) {
            await handleCacheOptimizerCommand("fix", cmdCtx);
          } else if (choice === menuOptions[6]) {
            await handleCacheOptimizerCommand("fix prompt-cache-key", cmdCtx);
          } else if (choice === menuOptions[7]) {
            await handleCacheOptimizerCommand("rollback", cmdCtx);
          } else if (choice === menuOptions[8]) {
            const modeOptions = ["session — Current Pi conversation session (default)", "total — All local sessions today", "process — Current extension instance only", "Cancel"];
            const modeChoice = await cmdCtx.ui.select("Footer cache stats mode", modeOptions);
            const nextMode = modeChoice === modeOptions[0]
              ? "session"
              : modeChoice === modeOptions[1]
                ? "total"
                : modeChoice === modeOptions[2]
                  ? "process"
                  : undefined;
            if (nextMode) await handleCacheOptimizerCommand(`config footer-mode ${nextMode}`, cmdCtx);
          } else if (choice === menuOptions[9]) {
            await handleCacheOptimizerCommand("reset", cmdCtx);
          }
          // choice === "cancel" or undefined → no action
          return;
        }

        // Fallback: text help when no interactive UI
        const diagnosis: string[] = [];
        diagnosis.push("📋 /cache-optimizer commands:");
        diagnosis.push("  enable  — Enable prompt/cache optimizations for this Pi process");
        diagnosis.push("  disable — Disable prompt/cache optimizations for this Pi process");
        diagnosis.push("  doctor  — Show current model/provider/api/baseUrl/compat and low-hit diagnosis");
        diagnosis.push("  stats   — Show detailed statistics for every model in the current session");
        diagnosis.push("  stats all — Show detailed totals for every model across all local sessions");
        diagnosis.push("  stats contributors — Show per-session contributors for the active model");
        diagnosis.push("  compat  — Show compat suggestion with edit location");
        diagnosis.push("  config prompt-rewrite|virtual-rewrite|skill-compression|openai-cache-key|tool-order on|off — Persist feature settings");
        diagnosis.push("  config footer-mode total|session|process — Persist the footer stats mode");
        diagnosis.push("  config reset — Remove persistent feature overrides");
        diagnosis.push("  fix     — Auto-fix compat issues (writes models.json or extension config, requires UI)");
        diagnosis.push("  fix prompt-cache-key — Explicitly omit prompt_cache_key for the active model");
        diagnosis.push("  rollback — Undo the latest confirmed fix (requires UI confirmation)");
        diagnosis.push("  reset   — Reset local provider/model stats for current model (does not affect upstream)");
        diagnosis.push("");
        diagnosis.push(formatOptimizerRuntimeMode());
        const resolvedFooterMode = resolveFooterStatsMode(persistedFooterStatsMode);
        diagnosis.push(`Footer stats mode: ${resolvedFooterMode.mode} (${resolvedFooterMode.source})`);
        diagnosis.push("");
        if (model) {
          const displayKey = modelKey(model);
          const missing = describeMissingCacheCompatForModel(model);
          if (missing.length > 0) {
            diagnosis.push(`⚠️  Active model "${displayKey}" missing compat: ${missing.join(", ")}`);
            diagnosis.push('Run "/cache-optimizer compat" for edit instructions.');
          } else if (isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)) {
            diagnosis.push(`✅ Active model "${displayKey}": compat fully configured.`);
          } else {
            diagnosis.push(`ℹ️ Active model "${displayKey}": compat check not applicable.`);
            const detailLines = getCompatCheckNotApplicableLines(model).slice(1);
            for (const line of detailLines) diagnosis.push(line);
          }
        } else {
          diagnosis.push("No active model selected.");
        }
        cmdCtx.ui.notify(diagnosis.join("\n"), "info");
      }
  }

  pi.registerCommand("cache-optimizer", {
    description: "Configure and diagnose Pi cache behavior",
    getArgumentCompletions: getCacheOptimizerArgumentCompletions,
    handler: handleCacheOptimizerCommand,
  });
}
