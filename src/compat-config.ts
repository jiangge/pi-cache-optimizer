import { type PiModel, type UnknownRecord, asRecord, lower } from "./common.ts";

export type CacheCompat = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  sendSessionAffinityHeaders?: boolean;
  sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
  supportsLongCacheRetention?: boolean;
  thinkingFormat?: string;
  requiresReasoningContentOnAssistantMessages?: boolean;
  cacheControlFormat?: string;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  openRouterRouting?: UnknownRecord;
  vercelGatewayRouting?: UnknownRecord;
  chatTemplateKwargs?: UnknownRecord;
  chatTemplateArgs?: UnknownRecord;
};

/**
 * Get effective compat for a model by merging provider-level and model-level compat.
 * Model-level compat takes precedence over provider-level compat for overlapping keys.
 * This matches Pi's model-registry.js mergeCompat behavior.
 */
export const NESTED_COMPAT_KEYS = [
  "openRouterRouting",
  "vercelGatewayRouting",
  "chatTemplateKwargs",
  "chatTemplateArgs",
] as const;

export function findLastExactModelDefinition(
  models: unknown[] | undefined,
  modelId: string,
): UnknownRecord | undefined {
  if (!models) return undefined;
  // Pi's provider composer processes definitions in array order. If a malformed
  // or hand-edited config repeats an id, the last definition replaces earlier
  // definitions, so effective resolution must use the same deterministic rule.
  for (let index = models.length - 1; index >= 0; index--) {
    const candidate = asRecord(models[index]);
    if (candidate?.id === modelId) return candidate;
  }
  return undefined;
}

export function mergeCacheCompat(...sources: Array<UnknownRecord | undefined>): CacheCompat {
  const merged: CacheCompat = {};
  for (const source of sources) {
    if (!source) continue;
    const previousNested = Object.fromEntries(
      NESTED_COMPAT_KEYS.map((key) => [key, asRecord(merged[key])]),
    ) as Partial<Record<(typeof NESTED_COMPAT_KEYS)[number], UnknownRecord | undefined>>;
    Object.assign(merged, source);
    for (const key of NESTED_COMPAT_KEYS) {
      const baseValue = previousNested[key];
      const overrideValue = asRecord(source[key]);
      if (baseValue || overrideValue) {
        merged[key] = { ...baseValue, ...overrideValue };
      }
    }
  }
  return merged;
}

export function getEffectiveCompatSources(model: PiModel, config: unknown): Array<{ source: "provider" | "model" | "runtime" | "modelOverride"; compat: UnknownRecord }> {
  const root = asRecord(config);
  const providers = asRecord(root?.providers);
  const provider = asRecord(providers?.[model.provider]);
  const providerCompat = asRecord(provider?.compat);
  const customModel = findLastExactModelDefinition(
    Array.isArray(provider?.models) ? provider.models : undefined,
    model.id,
  );
  const customModelCompat = asRecord(asRecord(customModel)?.compat);
  const runtimeCompat = asRecord(model.compat);
  const modelOverride = asRecord(asRecord(provider?.modelOverrides)?.[model.id]);
  const modelOverrideCompat = asRecord(modelOverride?.compat);

  return [
    ...(providerCompat ? [{ source: "provider" as const, compat: providerCompat }] : []),
    ...(customModelCompat ? [{ source: "model" as const, compat: customModelCompat }] : []),
    ...(runtimeCompat ? [{ source: "runtime" as const, compat: runtimeCompat }] : []),
    ...(modelOverrideCompat ? [{ source: "modelOverride" as const, compat: modelOverrideCompat }] : []),
  ];
}

export function resolveEffectiveCompatFromConfig(model: PiModel, config: unknown): CacheCompat {
  // Pi's effective precedence is provider → models[] → runtime model →
  // modelOverrides. The runtime layer is intentionally included between the
  // config model and modelOverride: extension providers can replace the model
  // object after lower config layers were applied, while the override remains
  // Pi's highest-precedence user layer.
  return mergeCacheCompat(...getEffectiveCompatSources(model, config).map(({ compat }) => compat));
}
