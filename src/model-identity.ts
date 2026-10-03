import { type ModelIdentity, type PiModel, type UnknownRecord, asRecord, isNonEmptyString, lower } from "./common.ts";
import { type CacheCompat, NESTED_COMPAT_KEYS, resolveEffectiveCompatFromConfig } from "./compat-config.ts";
import { parseJsonc } from "./jsonc.ts";
import { getAssistantMessageModelTokenValues, getModelIdNameTokenValues, hasAnyTokenContaining, isKimiCodingAdaptiveModel, modelOrAssistantMessageHas } from "./model-detect.ts";
import { MODELS_JSON_PATH } from "./paths.ts";
import { readFileSync, statSync } from "node:fs";

export const ROUTED_FALLBACK_MODEL_SYMBOL = Symbol("pi-cache-optimizer.routed-fallback-model");

// Model API that Pi 0.99+ assigns to native virtual models (VIRTUAL_MODEL_API).
export const PI_VIRTUAL_MODEL_API = "pi-virtual";

export const OPENAI_REASONING_MODEL_PATTERN = /(^|[/\s:_-])o[1345]($|[-_.:/\s])/;

export const XAI_MODEL_PATTERN = /(^|[/\s:_-])xai($|[-_.:/\s])/;

export const MIMO_MODEL_PATTERN = /(^|[/\s:_-])mi-?mo($|[-_.:/\s])/i;

export const PPLX_MODEL_PATTERN = /(^|[/\s:_-])pplx($|[-_.:/\s])/i;

export const NOVA_MODEL_PATTERN = /(^|[/\s:_-])nova($|[-_.:/\s])/i;

export const MPT_MODEL_PATTERN = /(^|[/\s:_-])mpt($|[-_.:/\s])/i;

export const ALEPH_MODEL_PATTERN = /(^|[/\s:_-])aleph($|[-_.:/\s])/i;

// Safe-boundary patterns for models with short or ambiguous tokens
export const ARCTIC_MODEL_PATTERN = /(^|[\/\s:_-])arctic($|[\-_.:\/\s])/i;

export const AYA_MODEL_PATTERN = /(^|[\/\s:_-])aya($|[\-_.:\/\s])/i;

export const ORION_MODEL_PATTERN = /(^|[\/\s:_-])orion($|[\-_.:\/\s])/i;

export function isRoutedFallbackModel(model: PiModel | undefined): boolean {
  return !!model && (model as PiModel & Record<symbol, unknown>)[ROUTED_FALLBACK_MODEL_SYMBOL] === true;
}

export function isNativeVirtualModel(model: { api?: unknown } | undefined): boolean {
  return model?.api === PI_VIRTUAL_MODEL_API;
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

export function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isRecordOfStrings(value: unknown): boolean {
  const record = asRecord(value);
  return !!record && Object.values(record).every((entry) => typeof entry === "string");
}

export function isThinkingLevelMap(value: unknown): boolean {
  const map = asRecord(value);
  if (!map) return false;
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].every((key) =>
    map[key] === undefined || map[key] === null || typeof map[key] === "string"
  );
}

export function isValidModelCostTier(value: unknown): boolean {
  const tier = asRecord(value);
  return !!tier
    && isFiniteNumber(tier.inputTokensAbove)
    && isFiniteNumber(tier.input)
    && isFiniteNumber(tier.output)
    && isFiniteNumber(tier.cacheRead)
    && isFiniteNumber(tier.cacheWrite);
}

export function isValidModelCost(value: unknown, partial: boolean): boolean {
  const cost = asRecord(value);
  if (!cost) return false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if ((!partial || cost[key] !== undefined) && !isFiniteNumber(cost[key])) return false;
  }
  return cost.tiers === undefined || (Array.isArray(cost.tiers) && cost.tiers.every(isValidModelCostTier));
}

export function isValidModelDefinition(value: unknown): boolean {
  const model = asRecord(value);
  if (!model || !isNonEmptyString(model.id)) return false;
  if (!isOptionalString(model.name) || !isOptionalString(model.api) || !isOptionalString(model.baseUrl)) return false;
  if (!isOptionalBoolean(model.reasoning) || !isValidCompatRecord(model.compat)) return false;
  if (model.thinkingLevelMap !== undefined && !isThinkingLevelMap(model.thinkingLevelMap)) return false;
  if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.every((entry) => entry === "text" || entry === "image"))) return false;
  if (model.cost !== undefined && !isValidModelCost(model.cost, false)) return false;
  if (model.contextWindow !== undefined && !isFiniteNumber(model.contextWindow)) return false;
  if (model.maxTokens !== undefined && !isFiniteNumber(model.maxTokens)) return false;
  if (model.samplingParams !== undefined && !asRecord(model.samplingParams)) return false;
  if (model.headers !== undefined && !isRecordOfStrings(model.headers)) return false;
  return true;
}

export function isValidModelOverride(value: unknown): boolean {
  const override = asRecord(value);
  if (!override || !isValidCompatRecord(override.compat)) return false;
  if (!isOptionalString(override.name) || !isOptionalBoolean(override.reasoning)) return false;
  if (override.thinkingLevelMap !== undefined && !isThinkingLevelMap(override.thinkingLevelMap)) return false;
  if (override.input !== undefined && (!Array.isArray(override.input) || !override.input.every((entry) => entry === "text" || entry === "image"))) return false;
  if (override.cost !== undefined && !isValidModelCost(override.cost, true)) return false;
  if (override.contextWindow !== undefined && !isFiniteNumber(override.contextWindow)) return false;
  if (override.maxTokens !== undefined && !isFiniteNumber(override.maxTokens)) return false;
  if (override.samplingParams !== undefined && !asRecord(override.samplingParams)) return false;
  if (override.headers !== undefined && !isRecordOfStrings(override.headers)) return false;
  return true;
}

export function isValidOpenAICompletionsCompat(compat: UnknownRecord): boolean {
  const booleanKeys = [
    "supportsStore", "supportsDeveloperRole", "supportsReasoningEffort",
    "supportsUsageInStreaming", "requiresToolResultName", "requiresAssistantAfterToolResult",
    "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages",
    "supportsOpenAIGrammarTools", "supportsStrictMode", "sendSessionAffinityHeaders",
    "supportsLongCacheRetention",
  ];
  if (booleanKeys.some((key) => !isOptionalBoolean(compat[key]))) return false;
  if (compat.maxTokensField !== undefined && compat.maxTokensField !== "max_completion_tokens" && compat.maxTokensField !== "max_tokens") return false;
  if (compat.thinkingFormat !== undefined && ![
    "openai", "openrouter", "together", "baseten", "deepseek", "zai", "qwen",
    "chat-template", "qwen-chat-template", "string-thinking", "ant-ling",
  ].includes(String(compat.thinkingFormat))) return false;
  if (compat.cacheControlFormat !== undefined && compat.cacheControlFormat !== "anthropic") return false;
  if (compat.deferredToolsMode !== undefined && compat.deferredToolsMode !== "kimi") return false;
  if (compat.sessionAffinityFormat !== undefined && !["openai", "openai-nosession", "openrouter"].includes(String(compat.sessionAffinityFormat))) return false;
  for (const key of NESTED_COMPAT_KEYS) {
    if (compat[key] !== undefined && !asRecord(compat[key])) return false;
  }
  return true;
}

export function isValidOpenAIResponsesCompat(compat: UnknownRecord): boolean {
  const booleanKeys = [
    "supportsDeveloperRole", "supportsLongCacheRetention", "supportsStrictMode",
    "supportsOpenAIGrammarTools", "supportsAdditionalTools", "supportsToolSearch",
  ];
  if (booleanKeys.some((key) => !isOptionalBoolean(compat[key]))) return false;
  return compat.sessionAffinityFormat === undefined
    || ["openai", "openai-nosession", "openrouter"].includes(String(compat.sessionAffinityFormat));
}

export function isValidAnthropicMessagesCompat(compat: UnknownRecord): boolean {
  return [
    "supportsEagerToolInputStreaming", "supportsLongCacheRetention",
    "sendSessionAffinityHeaders", "supportsCacheControlOnTools", "supportsTemperature",
    "forceAdaptiveThinking", "allowEmptySignature", "supportsStrictTools", "supportsToolReferences",
  ].every((key) => isOptionalBoolean(compat[key]));
}

export function isValidCompatRecord(value: unknown): boolean {
  if (value === undefined) return true;
  const compat = asRecord(value);
  return !!compat
    && !Object.prototype.hasOwnProperty.call(compat, "supportsPromptCacheKey")
    && (
    isValidOpenAICompletionsCompat(compat)
    || isValidOpenAIResponsesCompat(compat)
    || isValidAnthropicMessagesCompat(compat)
  );
}

// Credential-blind fail-closed subset of Pi's models.json validation. This
// intentionally covers only fields consumed by compat diagnostics, transport
// recovery, and exact route fallback; it is not a replacement for Pi's full
// schema and must stay conservative when the file is malformed.
export function isValidModelsConfigForEffectiveCompat(value: unknown): boolean {
  const root = asRecord(value);
  const providers = asRecord(root?.providers);
  if (!root || !providers) return false;

  for (const providerValue of Object.values(providers)) {
    const provider = asRecord(providerValue);
    if (!provider) return false;
    if (!isOptionalString(provider.name) || !isOptionalString(provider.baseUrl) || !isOptionalString(provider.apiKey) || !isOptionalString(provider.api)) return false;
    if (!isOptionalBoolean(provider.authHeader) || !isValidCompatRecord(provider.compat)) return false;
    if (provider.oauth !== undefined && provider.oauth !== "radius") return false;
    if (provider.headers !== undefined && !isRecordOfStrings(provider.headers)) return false;
    if (provider.models !== undefined && (!Array.isArray(provider.models) || !provider.models.every(isValidModelDefinition))) return false;
    const overrides = provider.modelOverrides === undefined ? undefined : asRecord(provider.modelOverrides);
    if (provider.modelOverrides !== undefined && (!overrides || !Object.values(overrides).every(isValidModelOverride))) return false;
  }
  return true;
}

export type ModelsConfigCache = {
  signature: string;
  value: unknown | undefined;
};

let modelsConfigCache: ModelsConfigCache | undefined;

export function getModelsConfigSignature(): string {
  try {
    const info = statSync(MODELS_JSON_PATH);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return "missing";
  }
}

export function readEffectiveCompatConfig(): unknown | undefined {
  const signature = getModelsConfigSignature();
  if (modelsConfigCache?.signature === signature) return modelsConfigCache.value;

  let value: unknown | undefined;
  if (signature !== "missing") {
    try {
      const parsed = parseJsonc(readFileSync(MODELS_JSON_PATH, "utf8"));
      value = isValidModelsConfigForEffectiveCompat(parsed) ? parsed : undefined;
    } catch {
      value = undefined;
    }
  }

  modelsConfigCache = { signature, value };
  return value;
}

export function getCompat(model: PiModel | undefined): CacheCompat {
  if (!model) return {} as CacheCompat;
  return resolveEffectiveCompatFromConfig(model, readEffectiveCompatConfig());
}

export function isAssistantMessage(message: unknown): boolean {
  return asRecord(message)?.role === "assistant";
}

export function getAssistantRecord(message: unknown): UnknownRecord | undefined {
  const record = asRecord(message);
  return record?.role === "assistant" ? record : undefined;
}

export function isDeepSeekLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["deepseek"]);
}

export function isDeepSeekLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["deepseek"]);
}

export function isOpenAICompatibleApi(api: unknown): boolean {
  const value = lower(api);
  return value === "openai-completions" || value === "openai-responses";
}

export function isAnthropicMessagesApi(api: unknown): boolean {
  return lower(api) === "anthropic-messages";
}

export function isOpenAICompatibleProxyApi(api: unknown): boolean {
  return lower(api) === "openai-completions";
}

export function isPiBuiltInLlamaCppModel(model: PiModel | undefined): boolean {
  if (lower(model?.provider) !== "llama.cpp" || !isOpenAICompatibleProxyApi(model?.api)) return false;

  // Pi's built-in llama.cpp provider supplies this exact explicit compat
  // fingerprint. Provider ids are extension-overridable and models.json can add
  // cache/routing overrides, so provider id alone must never imply exemption.
  // supportsUsageInStreaming is deliberately not part of the fingerprint: Pi
  // 0.82.x sets it false and Pi 0.83+ sets it true after fixing streamed usage,
  // and it carries no routing or cache configuration.
  const compat = getCompat(model);
  return compat.supportsStore === false
    && compat.supportsDeveloperRole === false
    && compat.supportsReasoningEffort === false
    && compat.supportsStrictMode === false
    && compat.maxTokensField === "max_tokens"
    && compat.sendSessionAffinityHeaders === undefined
    && compat.sessionAffinityFormat === undefined
    && compat.supportsLongCacheRetention === undefined;
}

export function isResponsesPromptRewriteBypassApi(api: unknown): boolean {
  const value = lower(api);
  return value === "openai-codex-responses" || value === "openai-responses" || value === "azure-openai-responses";
}

export function isMistralConversationsApi(api: unknown): boolean {
  return lower(api) === "mistral-conversations";
}

export function isOpenAIFamilyToken(token: string): boolean {
  return token.includes("gpt-") || token.includes("chatgpt") || OPENAI_REASONING_MODEL_PATTERN.test(token);
}

export function isOpenAIFamilyModel(model: PiModel | undefined): boolean {
  return getModelIdNameTokenValues(model).some(isOpenAIFamilyToken);
}

export function isOpenAIFamilyAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return [...getModelIdNameTokenValues(model), ...getAssistantMessageModelTokenValues(message)].some(isOpenAIFamilyToken);
}

export function isClaudeLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["anthropic", "claude"]);
}

export function isClaudeLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["anthropic", "claude"]);
}

export function isGeminiLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["gemini", "vertex"]);
}

export function isGeminiLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["gemini", "vertex"]);
}

export function isKimiCodingEmptySignatureModel(model: PiModel | undefined): boolean {
  if (!isKimiCodingAdaptiveModel(model)) return false;
  return getModelIdNameTokenValues(model).some((token) =>
    token === "k3"
    || token === "kimi-k3"
    || token.startsWith("kimi-k3-")
    || token === "kimi k3"
    || token === "kimi-for-coding"
    || token === "kimi for coding"
  );
}

// ── Additional OpenAI-compatible model detection ──────────────────

export const YI_MODEL_PATTERN = /(^|[\/\s:_-])yi($|[\-_.:\/\s])/;

// ── More OpenAI-compatible model detection (batch 2) ───────────────

export const DOUBAO_SEED_PATTERN = /(^|[\/\s:_-])seed($|[\-_.:\/\s])/i;

export const PHI_MODEL_PATTERN = /(^|[\/\s:_-])phi($|[\-_.:\/\s])/i;

// ── New OpenAI-compatible model detection (batch 3, 12 families) ──────

// ── More OpenAI-compatible model detection (batch 4, 18 families) ──

// ── Model key ──────────────────────────────────────────────────────

export function modelKey(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

export function isOfficialOpenAIBaseUrl(model: PiModel): boolean {
  const value = lower(model.baseUrl).trim();
  if (!value) {
    return lower(model.provider) === "openai";
  }

  try {
    return new URL(value).hostname === "api.openai.com";
  } catch {
    return value === "api.openai.com" || value.startsWith("api.openai.com/");
  }
}

export function isKnownThirdPartyOpenAIEndpoint(model: PiModel): boolean {
  return isNonEmptyString(model.baseUrl) && !isOfficialOpenAIBaseUrl(model);
}

export function invalidateModelsConfigCache(): void {
  modelsConfigCache = undefined;
}
