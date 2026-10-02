import { join } from "node:path";
import { type PiModel, type UnknownRecord, asRecord, isNonEmptyString, lower } from "./common.ts";
import { type CacheCompat, getEffectiveCompatSources, resolveEffectiveCompatFromConfig } from "./compat-config.ts";
import { type PersistedCacheOptimizerConfig, type PersistedCacheOptimizerConfigV3, persistedCacheOptimizerConfig, runtimeOptimizerEnabled } from "./config.ts";
import { getAssistantRecord, isOfficialOpenAIBaseUrl, isOpenAICompatibleProxyApi, modelKey, readEffectiveCompatConfig } from "./model-identity.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampPromptCacheKey(key: string | undefined): string | undefined {
  const normalized = key?.trim();
  if (!normalized) return undefined;

  const chars = Array.from(normalized);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return normalized;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

export function getEffectiveCompatValueSource(
  model: PiModel,
  config: unknown,
  key: keyof CacheCompat,
): "provider" | "model" | "runtime" | "modelOverride" | undefined {
  let source: "provider" | "model" | "runtime" | "modelOverride" | undefined;
  for (const candidate of getEffectiveCompatSources(model, config)) {
    if (Object.prototype.hasOwnProperty.call(candidate.compat, key)) source = candidate.source;
  }
  return source;
}

export function hasProviderHeader(headers: Record<string, unknown>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalized);
}

export function setProviderHeaderIfMissing(
  headers: Record<string, string | null | undefined>,
  name: string,
  value: string,
): boolean {
  if (hasProviderHeader(headers, name)) return false;
  headers[name] = value;
  return true;
}

export function addEffectiveSessionAffinityHeaders(
  headers: Record<string, string | null | undefined>,
  model: PiModel | undefined,
  sessionId: string | undefined,
  effectiveCompat?: CacheCompat,
  optimizerEnabled: boolean = runtimeOptimizerEnabled,
  effectiveSource?: "provider" | "model" | "runtime" | "modelOverride",
): boolean {
  if (!optimizerEnabled || !model || !isNonEmptyString(sessionId)) return false;
  if (!isOpenAICompatibleProxyApi(model.api) || !isNonEmptyString(model.baseUrl) || isOfficialOpenAIBaseUrl(model)) return false;
  const config = effectiveCompat === undefined || effectiveSource === undefined
    ? readEffectiveCompatConfig()
    : undefined;
  const compat = effectiveCompat ?? resolveEffectiveCompatFromConfig(model, config);
  const source = effectiveSource
    ?? getEffectiveCompatValueSource(model, config, "sendSessionAffinityHeaders")
    ?? (Object.prototype.hasOwnProperty.call(asRecord(model.compat) ?? {}, "sendSessionAffinityHeaders") ? "runtime" : undefined);
  if (compat.sendSessionAffinityHeaders !== true) return false;

  // Pi already handles an effective runtime-model true. The bridge is only for
  // effective values that live in models.json layers and were lost when an
  // extension provider rebuilt/replaced the runtime model object.
  if (source === "runtime") return false;

  const format = compat.sessionAffinityFormat ?? (
    lower(model.provider).includes("openrouter") || lower(model.baseUrl).includes("openrouter.ai")
      ? "openrouter"
      : "openai"
  );
  const value = sessionId.trim();
  let changed = false;
  if (format === "openrouter") {
    return setProviderHeaderIfMissing(headers, "x-session-id", value);
  }
  if (format === "openai") {
    changed = setProviderHeaderIfMissing(headers, "session_id", value) || changed;
  }
  changed = setProviderHeaderIfMissing(headers, "x-client-request-id", value) || changed;
  changed = setProviderHeaderIfMissing(headers, "x-session-affinity", value) || changed;
  return changed;
}

export function shouldInjectOpenAIPromptCacheKeyForModel(model: PiModel | undefined): boolean {
  // Pi 1.0+ owns prompt_cache_key for Responses/Codex transports. Keep this
  // extension's fallback limited to openai-completions proxies, where Pi's
  // provider extensions may not supply the session key.
  return isOpenAICompatibleProxyApi(model?.api);
}

export function isPromptCacheKeyOmittedForModel(model: PiModel | undefined, config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3 = persistedCacheOptimizerConfig): boolean {
  if (!model || !isOpenAICompatibleProxyApi(model.api)) return false;
  return "promptCacheKey" in config && config.promptCacheKey?.omit?.includes(modelKey(model)) === true;
}

export function omitOpenAIPromptCacheKeys(payload: unknown): unknown | undefined {
  const record = asRecord(payload);
  if (!record || (!Object.prototype.hasOwnProperty.call(record, "prompt_cache_key") && !Object.prototype.hasOwnProperty.call(record, "promptCacheKey"))) return undefined;
  const copy = { ...record };
  delete copy.prompt_cache_key;
  delete copy.promptCacheKey;
  return copy;
}

export function collectAnthropicCacheControlsInWireOrder(payload: unknown): UnknownRecord[] {
  const record = asRecord(payload);
  if (!record) return [];

  const controls: UnknownRecord[] = [];
  const collectFromBlock = (value: unknown): void => {
    const cacheControl = asRecord(asRecord(value)?.cache_control);
    if (cacheControl?.type === "ephemeral") controls.push(cacheControl);
  };

  // Anthropic processes cache breakpoints in tools → system → messages order.
  if (Array.isArray(record.tools)) {
    for (const tool of record.tools) collectFromBlock(tool);
  }
  if (Array.isArray(record.system)) {
    for (const block of record.system) collectFromBlock(block);
  }
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      const content = asRecord(message)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) collectFromBlock(block);
    }
  }

  return controls;
}

/**
 * Anthropic requires every 1h cache breakpoint to precede every 5m breakpoint.
 * An ephemeral cache_control without ttl uses Anthropic's default 5m retention.
 * If the final serialized payload contains a short → long transition, downgrade
 * all 1h breakpoints to the default 5m so the request remains valid.
 */
export function downgradeAnthropicLongCacheControls(payload: unknown): boolean {
  let changed = false;
  for (const control of collectAnthropicCacheControlsInWireOrder(payload)) {
    if (control.ttl === "1h") {
      delete control.ttl;
      changed = true;
    }
  }
  return changed;
}

export function hasAnthropicCacheTtlOrderError(message: unknown): boolean {
  const record = getAssistantRecord(message);
  if (record?.stopReason !== "error" || typeof record.errorMessage !== "string") return false;

  const error = lower(record.errorMessage);
  return error.includes("cache_control") &&
    error.includes("ttl='1h'") &&
    error.includes("ttl='5m'") &&
    error.includes("must not come after");
}

export function normalizeAnthropicCacheControlTtlOrder(payload: unknown): boolean {
  const controls = collectAnthropicCacheControlsInWireOrder(payload);
  let seenShort = false;
  let hasInvalidLongAfterShort = false;

  for (const control of controls) {
    const ttl = control.ttl;
    if (ttl === undefined || ttl === "5m") {
      seenShort = true;
    } else if (ttl === "1h" && seenShort) {
      hasInvalidLongAfterShort = true;
      break;
    }
  }
  if (!hasInvalidLongAfterShort) return false;

  return downgradeAnthropicLongCacheControls(payload);
}

export function addOpenAIPromptCacheKey(payload: unknown, cacheKey: string | undefined): unknown | undefined {
  const record = asRecord(payload);
  const normalizedCacheKey = clampPromptCacheKey(cacheKey);
  if (!record || !normalizedCacheKey) return undefined;

  if (hasEffectivePromptCacheKey(record)) {
    return undefined;
  }

  return { ...record, prompt_cache_key: normalizedCacheKey };
}

export function hasEffectivePromptCacheKey(record: UnknownRecord): boolean {
  return isNonEmptyString(record.prompt_cache_key) || isNonEmptyString(record.promptCacheKey);
}
