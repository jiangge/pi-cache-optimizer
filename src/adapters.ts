import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PiModel, isNonEmptyString } from "./common.ts";
import { buildDeepSeekCompatWarningText, buildOpenAIProxyCompatWarningText, describeMissingCacheCompatForModel, describeMissingOpenAICompatibleProxyCompat, isDeepSeekWireCompatApplicable } from "./compat-advice.ts";
import { getAssistantMessageModelTokenValues, getModelIdNameTokenValues, hasAnyTokenContaining } from "./model-detect.ts";
import { ALEPH_MODEL_PATTERN, ARCTIC_MODEL_PATTERN, AYA_MODEL_PATTERN, DOUBAO_SEED_PATTERN, MIMO_MODEL_PATTERN, MPT_MODEL_PATTERN, NOVA_MODEL_PATTERN, ORION_MODEL_PATTERN, PHI_MODEL_PATTERN, PPLX_MODEL_PATTERN, XAI_MODEL_PATTERN, YI_MODEL_PATTERN, getAssistantRecord, getCompat, isAssistantMessage, isClaudeLikeAssistantMessage, isClaudeLikeModel, isDeepSeekLikeAssistantMessage, isDeepSeekLikeModel, isGeminiLikeAssistantMessage, isGeminiLikeModel, isNativeVirtualModel, isOpenAICompatibleApi, isOpenAIFamilyAssistantMessage, isOpenAIFamilyModel, isPiBuiltInLlamaCppModel, modelKey } from "./model-identity.ts";
import { firstNonEmptyString, getRoutingRegistry, isRouterModel, resolveActiveRouteSnapshot } from "./routing.ts";
import { type CacheProviderId, type UsageSnapshot } from "./stats-store.ts";
import { getAnthropicRawUsage, getDeepSeekRawUsage, getGeminiRawUsage, getOpenAIRawUsage, normalizeWithFallback } from "./usage.ts";

export type CacheProviderAdapter = {
  id: CacheProviderId;
  label: string;
  showCacheWrite?: boolean;
  matchesModel(model: PiModel | undefined): boolean;
  matchesAssistantMessage(message: unknown, model: PiModel | undefined): boolean;
  normalizeUsage(message: unknown): UsageSnapshot | undefined;
  warningText?(model: PiModel): string | undefined;
};

export function isVirtualRoutingModel(model: PiModel | undefined, ctx?: Pick<ExtensionContext, "sessionManager">): boolean {
  if (!model) return false;
  return isNativeVirtualModel(model) || isRouterModel(model) || !!getRoutingRegistry()?.getRouter(model.provider) || !!resolveActiveRouteSnapshot(model, ctx);
}

export function modelFromAssistantMessage(message: unknown, fallback: PiModel | undefined, preferCatalogId = false): PiModel | undefined {
  const record = getAssistantRecord(message);
  if (!record) return fallback;

  // Pi's model field is the dispatched catalog id. Legacy routing adapters
  // can still use responseModel as their only physical identity, so callers
  // that need catalog attribution opt in rather than changing that protocol.
  const id = preferCatalogId
    ? firstNonEmptyString(record.model, record.responseModel, fallback?.id)
    : firstNonEmptyString(record.responseModel, record.model, fallback?.id);
  const provider = firstNonEmptyString(record.provider, fallback?.provider);
  const api = firstNonEmptyString(record.api, fallback?.api) ?? "";
  if (!id || !provider) return fallback;

  const fallbackName = isNonEmptyString(fallback?.name) ? fallback.name : undefined;
  const preservesFallbackIdentity =
    !isVirtualRoutingModel(fallback) &&
    provider === fallback?.provider &&
    id === fallback?.id &&
    fallbackName !== undefined;

  return {
    ...(fallback ?? {}),
    id,
    // Direct providers such as kimi-coding may echo only a short model id
    // (`k3`) while the active model name (`Kimi K3`) carries the adapter token.
    // Preserve that display name only when response and fallback identities are
    // exactly the same; routed/different identities keep message-local naming.
    name: preservesFallbackIdentity ? fallbackName : id,
    provider,
    api,
    baseUrl: fallback?.baseUrl ?? "",
    reasoning: fallback?.reasoning ?? false,
    input: fallback?.input ?? ["text"],
    cost: fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: fallback?.contextWindow ?? 0,
    maxTokens: fallback?.maxTokens ?? 0,
  } as PiModel;
}

/**
 * Model families that share one adapter shape: usage is read from OpenAI-shaped
 * fields and the OpenAI-compatible proxy compat warning applies. A family
 * matches when any of the model's (or the assistant message's) lowercase id /
 * name tokens contains one of `needles`, or satisfies `pattern`. Order matters:
 * the first matching adapter wins, so it follows the specific adapters above.
 * Supporting a new family is one row here.
 */
export type OpenAIShapedFamily = { label: string; needles: string[]; pattern?: RegExp };

export const OPENAI_SHAPED_FAMILIES: OpenAIShapedFamily[] = [
  { label: "Kimi cache", needles: ["kimi"] },
  { label: "Qwen cache", needles: ["qwen"] },
  { label: "GLM cache", needles: ["glm"] },
  { label: "MiniMax cache", needles: ["minimax"] },
  { label: "Mimo cache", needles: ["xiaomimimo"], pattern: MIMO_MODEL_PATTERN },
  { label: "Hunyuan cache", needles: ["hunyuan"] },
  { label: "Mistral cache", needles: ["mistral", "mixtral", "codestral"] },
  { label: "Grok cache", needles: ["grok"], pattern: XAI_MODEL_PATTERN },
  { label: "Llama cache", needles: ["llama"] },
  { label: "Nemotron cache", needles: ["nemotron"] },
  { label: "Cohere cache", needles: ["cohere", "command-r"] },
  { label: "Yi cache", needles: ["yi-", "01-ai", "zero-one"], pattern: YI_MODEL_PATTERN },
  { label: "Doubao cache", needles: ["doubao", "豆包", "volcengine", "bytedance", "byte-dance"], pattern: DOUBAO_SEED_PATTERN },
  { label: "ERNIE cache", needles: ["ernie", "wenxin", "文心", "yiyan", "一言", "baidu"] },
  { label: "Baichuan cache", needles: ["baichuan", "百川"] },
  { label: "StepFun cache", needles: ["stepfun", "step-"] },
  { label: "Spark cache", needles: ["spark", "xinghuo", "星火", "iflytek", "讯飞"] },
  { label: "InternLM cache", needles: ["internlm", "intern-lm", "书生"] },
  { label: "Gemma cache", needles: ["gemma"] },
  { label: "Phi cache", needles: ["phi-"], pattern: PHI_MODEL_PATTERN },
  { label: "Jamba cache", needles: ["jamba", "ai21"] },
  { label: "Solar cache", needles: ["solar", "upstage"] },
  { label: "Sonar cache", needles: ["sonar", "perplexity"], pattern: PPLX_MODEL_PATTERN },  // Perplexity / Sonar
  { label: "Nova cache", needles: ["amazon-nova"], pattern: NOVA_MODEL_PATTERN },  // Amazon Nova
  { label: "Reka cache", needles: ["reka"] },  // Reka
  { label: "Falcon cache", needles: ["falcon", "tiiuae"] },  // Falcon / TII
  { label: "DBRX cache", needles: ["dbrx", "databricks"] },  // Databricks DBRX
  { label: "MPT cache", needles: ["mosaicml", "mpt-"], pattern: MPT_MODEL_PATTERN },  // MosaicML MPT
  { label: "StableLM cache", needles: ["stablelm", "stable-lm", "stability-ai"] },  // StableLM / Stability AI
  { label: "Aquila cache", needles: ["aquila", "baai"] },  // BAAI / Aquila
  { label: "EXAONE cache", needles: ["exaone"] },  // LG EXAONE
  { label: "HyperCLOVA cache", needles: ["hyperclova", "clova-x"] },  // Naver HyperCLOVA X (conservative: hyperclova, clova-x only)
  { label: "Luminous cache", needles: ["luminous", "aleph-alpha"], pattern: ALEPH_MODEL_PATTERN },  // Aleph Alpha Luminous
  { label: "Hermes cache", needles: ["nous", "hermes", "openhermes"] },  // Nous / Hermes / OpenHermes
  { label: "Granite cache", needles: ["granite", "ibm-granite"] },  // IBM Granite
  { label: "Arctic cache", needles: ["snowflake-arctic"], pattern: ARCTIC_MODEL_PATTERN },  // Snowflake Arctic
  { label: "Pangu cache", needles: ["pangu", "pan-gu", "盘古", "huawei-pangu"] },  // Huawei Pangu / 盘古
  { label: "SenseNova cache", needles: ["sensenova", "sense-nova", "sensechat", "商汤"] },  // SenseTime SenseNova / 商汤
  { label: "Zhinao cache", needles: ["360gpt", "360-gpt", "zhinao", "智脑"] },  // 360 Zhinao / 智脑
  { label: "MiniCPM cache", needles: ["minicpm", "mini-cpm", "openbmb"] },  // OpenBMB MiniCPM
  { label: "XVERSE cache", needles: ["xverse"] },  // XVERSE
  { label: "Orion cache", needles: ["orionstar", "orion-star"], pattern: ORION_MODEL_PATTERN },  // OrionStar Orion
  { label: "OpenChat cache", needles: ["openchat"] },  // OpenChat
  { label: "Vicuna cache", needles: ["vicuna"] },  // Vicuna
  { label: "Wizard cache", needles: ["wizardlm", "wizard-lm", "wizardcoder", "wizard-coder"] },  // WizardLM / WizardCoder
  { label: "Zephyr cache", needles: ["zephyr"] },  // Zephyr
  { label: "Dolphin cache", needles: ["dolphin"] },  // Dolphin
  { label: "OpenOrca cache", needles: ["openorca", "open-orca"] },  // OpenOrca
  { label: "Starling cache", needles: ["starling"] },  // Starling
  { label: "BLOOM cache", needles: ["bloom", "bigscience"] },  // BLOOM / BigScience
  { label: "RWKV cache", needles: ["rwkv"] },  // RWKV
  { label: "Aya cache", needles: ["aya-expanse"], pattern: AYA_MODEL_PATTERN },  // Cohere Aya
];

export function familyMatchesTokens(family: OpenAIShapedFamily, tokens: string[]): boolean {
  return hasAnyTokenContaining(tokens, family.needles) || (family.pattern !== undefined && tokens.some((token) => family.pattern!.test(token)));
}

export function createOpenAIShapedAdapter(family: OpenAIShapedFamily): CacheProviderAdapter {
  return {
    id: "openai" as CacheProviderId,
    label: family.label,
    matchesModel: (model) => familyMatchesTokens(family, getModelIdNameTokenValues(model)),
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return familyMatchesTokens(family, [...getModelIdNameTokenValues(model), ...getAssistantMessageModelTokenValues(message)]);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  };
}

export const OPENAI_SHAPED_FAMILY_ADAPTERS: CacheProviderAdapter[] = OPENAI_SHAPED_FAMILIES.map(createOpenAIShapedAdapter);

export const CACHE_PROVIDER_ADAPTERS: CacheProviderAdapter[] = [
  {
    id: "deepseek",
    label: "DS cache",
    matchesModel: isDeepSeekLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isDeepSeekLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getDeepSeekRawUsage, { allowInputOnlyPiUsage: true });
    },
    warningText(model) {
      const missing = describeMissingCacheCompatForModel(model);
      if (missing.length === 0) return undefined;

      const key = modelKey(model);
      return isDeepSeekWireCompatApplicable(model)
        ? buildDeepSeekCompatWarningText(key, missing)
        : buildOpenAIProxyCompatWarningText(key, missing);
    },
  },
  {
    id: "claude",
    label: "Claude cache",
    showCacheWrite: true,
    matchesModel: isClaudeLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isClaudeLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getAnthropicRawUsage);
    },
    warningText(model) {
      if (!isClaudeLikeModel(model) || !isOpenAICompatibleApi(model.api) || isPiBuiltInLlamaCppModel(model)) return undefined;
      if (getCompat(model).cacheControlFormat === "anthropic") return undefined;

      return (
        `💡 Cache optimizer: ${modelKey(model)} looks Claude/Anthropic-like but OpenAI-compatible compat lacks cacheControlFormat: "anthropic". ` +
        "Pi may not place Anthropic cache_control breakpoints unless this endpoint supports and enables that compat flag."
      );
    },
  },
  {
    id: "openai",
    label: "OpenAI cache",
    matchesModel: isOpenAIFamilyModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isOpenAIFamilyAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "gemini",
    label: "Gemini cache",
    matchesModel: isGeminiLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isGeminiLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getGeminiRawUsage);
    },
  },
  // ── Non-GPT OpenAI-compatible adapters ──────────────────────
  // ── More OpenAI-compatible adapters ──────────────────────────
  // ── More OpenAI-compatible adapters (batch 2) ───────────────────
  // ── New OpenAI-compatible adapters (batch 3, 12 families) ────────
  // ── More OpenAI-compatible adapters (batch 4, 18 families) ────────
  ...OPENAI_SHAPED_FAMILY_ADAPTERS,
];

export function selectAdapterForModel(model: PiModel | undefined): CacheProviderAdapter | undefined {
  // A native virtual selection has no cache identity of its own; stats always
  // belong to the physical model it routed to.
  if (isNativeVirtualModel(model)) return undefined;
  return CACHE_PROVIDER_ADAPTERS.find((adapter) => adapter.matchesModel(model));
}

export function selectAdapterForAssistantMessage(message: unknown, model: PiModel | undefined): CacheProviderAdapter | undefined {
  // Assistant message metadata is request-local and authoritative for virtual
  // routing providers. Use it first for every model; direct providers normally
  // echo the same provider/model and therefore remain unchanged.
  const responseModel = modelFromAssistantMessage(message, model);
  return CACHE_PROVIDER_ADAPTERS.find((adapter) => adapter.matchesAssistantMessage(message, responseModel));
}
