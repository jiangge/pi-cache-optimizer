import { readFileSync, statSync } from "node:fs";
import { type UnknownRecord, asRecord } from "./common.ts";
import { parseJsonc } from "./jsonc.ts";
import { MODELS_JSON_PATH } from "./paths.ts";

/**
 * Near-miss key lint for models.json (issue #30).
 *
 * Pi's ModelsConfigSchema does not set `additionalProperties: false`, so a
 * misspelled key such as `model0verrides` or `sendSessionAfinityHeaders` is
 * accepted and silently ignored. The compat warnings then keep firing with no
 * hint why. This module reports only keys that look like a typo of a known
 * key; unknown keys that resemble nothing are left alone so newer Pi fields
 * and personal annotations never produce noise. It never edits the file.
 *
 * Known key sets are copied from Pi 1.5.0 (1.4.0 added compat imageInput and sendImageOptInHeader; 1.5.0 changed no keys):
 * - @earendil-works/pi-coding-agent dist/core/model-config.js
 *   (ModelsConfigSchema, ProviderConfigSchema, ModelDefinitionSchema, ModelOverrideSchema)
 * - @earendil-works/pi-ai dist/providers/compat-schema.js
 *   (ProviderCompatSchema = merged properties of every per-API compat schema)
 */
export const MODELS_JSON_SCHEMA_SOURCE_VERSION = "1.5.0";

export const MODELS_JSON_ROOT_KEYS: readonly string[] = ["$schema", "providers"];

export const MODELS_JSON_PROVIDER_KEYS: readonly string[] = [
  "name", "baseUrl", "apiKey", "api", "oauth", "headers", "compat", "authHeader", "models", "modelOverrides",
];

export const MODELS_JSON_MODEL_DEFINITION_KEYS: readonly string[] = [
  "id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost", "promptCache",
  "contextWindow", "maxTokens", "samplingParams", "samplingParamsByThinkingLevel", "headers", "compat",
];

export const MODELS_JSON_MODEL_OVERRIDE_KEYS: readonly string[] = [
  "name", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost", "promptCache",
  "contextWindow", "maxTokens", "samplingParams", "samplingParamsByThinkingLevel", "headers", "compat",
];

/** Object.keys(ProviderCompatSchema.properties) in Pi 1.5.0, sorted. */
export const MODELS_JSON_COMPAT_KEYS: readonly string[] = [
  "allowEmptySignature", "allowedFallbackModels", "cacheControlFormat", "chatTemplateArgs", "chatTemplateKwargs",
  "forceAdaptiveThinking", "imageInput", "maxTokensField", "openRouterRouting", "requiresAssistantAfterToolResult",
  "requiresReasoningContentOnAssistantMessages", "requiresThinkingAsText", "requiresToolResultName",
  "sendImageOptInHeader", "sendSessionAffinityHeaders", "sessionAffinityFormat", "supportsAdditionalTools", "supportsCacheControlOnTools",
  "supportsDeveloperRole", "supportsEagerToolInputStreaming", "supportsExplicitPromptCacheMode", "supportsFinishReason",
  "supportsLongCacheRetention", "supportsMaxOutputTokens", "supportsMidConvoEffort", "supportsMidConvoSystemMessages",
  "supportsMidConvoToolAdditions", "supportsMidConvoToolChanges", "supportsOpenAIGrammarTools", "supportsReasoningEffort",
  "supportsStore", "supportsStrictMode", "supportsStrictTools", "supportsTemperature", "supportsThinkingTokenBudget",
  "supportsToolSearch", "supportsUsageInStreaming", "thinkingFormat", "thinkingTokenBudgetField", "vercelGatewayRouting",
  "vllmPriority", "zaiToolStream",
];

export type ModelsJsonKeyLevel =
  | "root"
  | "provider"
  | "providerCompat"
  | "model"
  | "modelCompat"
  | "modelOverride"
  | "modelOverrideCompat";

export interface ModelsJsonKeyTypo {
  /** Display path, e.g. `providers["opencode-go"].model0verrides`. */
  path: string;
  /** The key as written in models.json. */
  key: string;
  /** The known key it most likely meant. */
  suggestion: string;
  level: ModelsJsonKeyLevel;
  providerId?: string;
  /** models[].id or the modelOverrides entry name, for model-scoped levels. */
  modelId?: string;
}

/** Lowercase, read 0 as o and 1 as l, drop `-` and `_`. */
export function normalizeModelsJsonKey(key: string): string {
  return key.toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/[-_]/g, "");
}

/** Optimal-string-alignment (restricted Damerau-Levenshtein) distance, capped: returns > max early. */
export function damerauLevenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2][j - 2] + 1);
      }
      d[i][j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const MAX_TYPO_DISTANCE = 2;
const MIN_DISTANCE_KEY_LENGTH = 6;

/**
 * Return the known key `key` most likely meant, or undefined when it is an
 * exact known key or does not resemble one closely enough.
 */
export function suggestKnownKey(key: string, known: readonly string[]): string | undefined {
  if (known.includes(key)) return undefined;
  const normalized = normalizeModelsJsonKey(key);
  for (const candidate of known) {
    if (normalizeModelsJsonKey(candidate) === normalized) return candidate;
  }
  if (key.length < MIN_DISTANCE_KEY_LENGTH) return undefined;
  let best: string | undefined;
  let bestDistance = MAX_TYPO_DISTANCE + 1;
  const lowered = key.toLowerCase();
  for (const candidate of known) {
    const distance = Math.min(
      damerauLevenshtein(lowered, candidate.toLowerCase(), MAX_TYPO_DISTANCE),
      damerauLevenshtein(normalized, normalizeModelsJsonKey(candidate), MAX_TYPO_DISTANCE),
    );
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function propertyPath(base: string, key: string): string {
  const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  return base ? `${base}${segment}` : (segment.startsWith(".") ? key : segment);
}

function lintObject(
  record: UnknownRecord,
  known: readonly string[],
  basePath: string,
  level: ModelsJsonKeyLevel,
  out: ModelsJsonKeyTypo[],
  scope: { providerId?: string; modelId?: string },
): void {
  for (const key of Object.keys(record)) {
    const suggestion = suggestKnownKey(key, known);
    if (suggestion === undefined) continue;
    out.push({ path: propertyPath(basePath, key), key, suggestion, level, ...scope });
  }
}

/**
 * Lint an already-parsed models.json value. Pure and non-throwing; anything
 * that is not shaped like an object at a given level is skipped.
 */
export function lintModelsJsonKeys(config: unknown): ModelsJsonKeyTypo[] {
  const out: ModelsJsonKeyTypo[] = [];
  try {
    const root = asRecord(config);
    if (!root) return out;
    lintObject(root, MODELS_JSON_ROOT_KEYS, "", "root", out, {});
    const providers = asRecord(root.providers);
    if (!providers) return out;
    for (const [providerId, providerValue] of Object.entries(providers)) {
      const provider = asRecord(providerValue);
      if (!provider) continue;
      const providerPath = `providers[${JSON.stringify(providerId)}]`;
      lintObject(provider, MODELS_JSON_PROVIDER_KEYS, providerPath, "provider", out, { providerId });
      const providerCompat = asRecord(provider.compat);
      if (providerCompat) {
        lintObject(providerCompat, MODELS_JSON_COMPAT_KEYS, `${providerPath}.compat`, "providerCompat", out, { providerId });
      }
      if (Array.isArray(provider.models)) {
        provider.models.forEach((modelValue, index) => {
          const model = asRecord(modelValue);
          if (!model) return;
          const modelId = typeof model.id === "string" ? model.id : undefined;
          const modelPath = `${providerPath}.models[${index}]`;
          lintObject(model, MODELS_JSON_MODEL_DEFINITION_KEYS, modelPath, "model", out, { providerId, modelId });
          const compat = asRecord(model.compat);
          if (compat) lintObject(compat, MODELS_JSON_COMPAT_KEYS, `${modelPath}.compat`, "modelCompat", out, { providerId, modelId });
        });
      }
      const overrides = asRecord(provider.modelOverrides);
      if (overrides) {
        for (const [modelId, overrideValue] of Object.entries(overrides)) {
          const override = asRecord(overrideValue);
          if (!override) continue;
          const overridePath = `${providerPath}.modelOverrides[${JSON.stringify(modelId)}]`;
          lintObject(override, MODELS_JSON_MODEL_OVERRIDE_KEYS, overridePath, "modelOverride", out, { providerId, modelId });
          const compat = asRecord(override.compat);
          if (compat) lintObject(compat, MODELS_JSON_COMPAT_KEYS, `${overridePath}.compat`, "modelOverrideCompat", out, { providerId, modelId });
        }
      }
    }
  } catch {
    // Linting is advisory; a hostile or exotic value must never break callers.
  }
  return out;
}

/** Parse JSONC text and lint it. Returns [] when the text does not parse. */
export function lintModelsJsonText(text: string): ModelsJsonKeyTypo[] {
  try {
    return lintModelsJsonKeys(parseJsonc(text.replace(/^\uFEFF/, "")));
  } catch {
    return [];
  }
}

const fileCache = new Map<string, { signature: string; typos: ModelsJsonKeyTypo[] }>();

function fileSignature(path: string): string | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile()) return undefined;
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * Near-miss keys in models.json on disk. Cached by file identity, size and
 * mtime/ctime, so repeated calls from per-request warning paths cost one
 * stat. Never throws: a missing, unreadable or malformed file yields [].
 */
export function readModelsJsonKeyTypos(path: string = MODELS_JSON_PATH): ModelsJsonKeyTypo[] {
  try {
    const signature = fileSignature(path);
    if (signature === undefined) {
      fileCache.delete(path);
      return [];
    }
    const cached = fileCache.get(path);
    if (cached?.signature === signature) return cached.typos;
    let typos: ModelsJsonKeyTypo[] = [];
    try {
      typos = lintModelsJsonText(readFileSync(path, "utf8"));
    } catch {
      typos = [];
    }
    fileCache.set(path, { signature, typos });
    return typos;
  } catch {
    return [];
  }
}

export function clearModelsJsonLintCacheForTests(): void {
  fileCache.clear();
}

/**
 * Typos that can explain a setting not taking effect for one provider (and
 * optionally one model): root typos, every provider-level typo, and model
 * typos for the matching models[] entry or modelOverrides entry.
 */
export function selectModelsJsonKeyTyposForTarget(
  typos: readonly ModelsJsonKeyTypo[],
  providerId: string | undefined,
  modelId?: string,
): ModelsJsonKeyTypo[] {
  return typos.filter((typo) => {
    if (typo.level === "root") return true;
    if (providerId === undefined || typo.providerId !== providerId) return false;
    if (typo.level === "provider" || typo.level === "providerCompat") return true;
    return modelId !== undefined && typo.modelId === modelId;
  });
}

export function formatModelsJsonKeyTypo(typo: ModelsJsonKeyTypo): string {
  return `⚠️ ${typo.path} is not a known Pi key and looks like a typo of ${JSON.stringify(typo.suggestion)}; Pi ignores unknown keys, so it most likely has no effect.`;
}

/** Formatted hint lines for one provider/model, read from models.json on disk. Never throws. */
export function buildModelsJsonTypoHintLines(providerId: string | undefined, modelId?: string, path: string = MODELS_JSON_PATH): string[] {
  try {
    return selectModelsJsonKeyTyposForTarget(readModelsJsonKeyTypos(path), providerId, modelId).map(formatModelsJsonKeyTypo);
  } catch {
    return [];
  }
}

/** `/cache-optimizer doctor` section listing every suspected typo; empty when there are none. */
export function buildModelsJsonLintDoctorLines(path: string = MODELS_JSON_PATH): string[] {
  const typos = readModelsJsonKeyTypos(path);
  if (typos.length === 0) return [];
  return [
    "",
    `🔤 models.json key check: ${typos.length} suspected typo${typos.length === 1 ? "" : "s"} (hint only; nothing was renamed):`,
    ...typos.map((typo) => `   ${formatModelsJsonKeyTypo(typo)}`),
  ];
}
