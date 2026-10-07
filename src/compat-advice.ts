import { type PiModel, isNonEmptyString, lower } from "./common.ts";
import { isAdaptiveGenerationModel, isKimiCodingAdaptiveModel } from "./model-detect.ts";
import { getCompat, isDeepSeekLikeModel, isKimiCodingEmptySignatureModel, isKnownThirdPartyOpenAIEndpoint, isOpenAICompatibleProxyApi, isOpenAIFamilyModel, isPiBuiltInLlamaCppModel, isRoutedFallbackModel } from "./model-identity.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

/** Join display-only path fragments without resolving them for I/O. */
export function joinDisplayPath(base: string, child: string, platform: string = process.platform): string {
  const sep = platform.startsWith("win") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${child}`;
}

/**
 * Return a platform-friendly display path for Pi's agent directory.
 *
 * Derives the display path from Pi core's `getAgentDir()` result. Home-relative
 * paths use `%USERPROFILE%` on Windows and `~` on Unix-like systems; custom
 * absolute or relative agent directories remain visible as configured.
 */
export function getAgentDirDisplayPath(
  platform: string = process.platform,
  agentDir: string = getAgentDir(),
  homeDir: string = homedir(),
): string {
  const sep = platform.startsWith("win") ? "\\" : "/";
  const normalizedAgentDir = agentDir.replace(/[\\/]+/g, sep);
  const normalizedHomeDir = homeDir.replace(/[\\/]+/g, sep).replace(/[\\/]+$/, "");
  const homePrefix = `${normalizedHomeDir}${sep}`;

  if (normalizedAgentDir === normalizedHomeDir || normalizedAgentDir.startsWith(homePrefix)) {
    const relative = normalizedAgentDir.slice(normalizedHomeDir.length).replace(/^[\\/]+/, "");
    const homeLabel = platform.startsWith("win") ? "%USERPROFILE%" : "~";
    return relative ? `${homeLabel}${sep}${relative}` : homeLabel;
  }

  return normalizedAgentDir;
}

/**
 * Return a platform-friendly display path for Pi's `models.json`.
 *
 * This is a DISPLAY helper only. Actual I/O uses `MODELS_JSON_PATH`, resolved
 * from the same custom agent/config directory rules as `STATE_DIR`.
 */
export function getModelsJsonDisplayPath(
  platform: string = process.platform,
  agentDir: string = getAgentDir(),
  homeDir: string = homedir(),
): string {
  return joinDisplayPath(getAgentDirDisplayPath(platform, agentDir, homeDir), "models.json", platform);
}

export function isAdaptiveThinkingCompatApplicable(model: PiModel): boolean {
  // A routed registry miss may preserve the upstream API/model identity while
  // lacking a verified endpoint. Do not diagnose or suggest compat fixes for
  // that incomplete transport metadata; ordinary direct Anthropic models still
  // use their normal native adaptive-thinking check.
  if (isRoutedFallbackModel(model) && !isNonEmptyString(model.baseUrl)) {
    return false;
  }

  return lower(model.api) === "anthropic-messages"
    && (isAdaptiveGenerationModel(model) || isKimiCodingAdaptiveModel(model));
}

export function describeMissingAdaptiveThinkingCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];
  if (compat.forceAdaptiveThinking !== true) {
    missing.push("forceAdaptiveThinking");
  }
  if (isKimiCodingEmptySignatureModel(model) && compat.allowEmptySignature !== true) {
    missing.push("allowEmptySignature");
  }
  return missing;
}

/**
 * Like describeMissingOpenAIFamilyProxyCompat but without the isOpenAIFamilyModel
 * gate. Warns for ANY model using openai-completions through a non-official base
 * URL — covers GPT, Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan, and any other
 * OpenAI-compatible proxy.
 */
export function describeMissingOpenAICompatibleProxyCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];

  if (!isOpenAICompatibleProxyApi(model.api)) return missing;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return missing;
  if (isPiBuiltInLlamaCppModel(model)) return missing;

  if (compat.sendSessionAffinityHeaders === undefined) {
    missing.push("sendSessionAffinityHeaders");
  }

  // Explicit `sendSessionAffinityHeaders: false` is a valid safe opt-out for
  // proxies/CDNs/WAFs that block Pi's custom affinity headers with HTTP 403.
  // Treat only a missing/undefined value as missing compat; do not mark an
  // intentional false override as ⚠️ compat or let /cache-optimizer fix turn it
  // back to true.
  //
  // NOTE: supportsLongCacheRetention is intentionally NOT checked here.
  // Per spec, it is optional/risky advisory text only and must NOT trigger
  // the ⚠️ compat marker. The before_provider_request hook proactively
  // strips prompt_cache_retention for models without explicit opt-in,
  // so 400 errors are prevented regardless of this compat flag.
  // Doctor/compat may mention it as optional guidance separately.

  return missing;
}

export function buildSafeOpenAIProxyCompatSuggestion(missing: string[]): Record<string, boolean> {
  const suggestion: Record<string, boolean> = {};
  if (missing.includes("sendSessionAffinityHeaders")) {
    suggestion.sendSessionAffinityHeaders = true;
  }
  // supportsLongCacheRetention is NOT suggested here — per spec it is
  // optional/risky and must not appear in the copyable safe snippet.
  // The proactive stripping in before_provider_request handles 400 prevention.
  return suggestion;
}

export type CompatAdvicePlacement = {
  providerLabel?: string;
  modelId?: string;
};

export function buildProviderCompatOverride(providerLabel: string, compat: Record<string, unknown>): Record<string, unknown> {
  return {
    providers: {
      [providerLabel]: {
        compat,
      },
    },
  };
}

export function buildModelCompatOverride(providerLabel: string, modelId: string, compat: Record<string, unknown>): Record<string, unknown> {
  return {
    providers: {
      [providerLabel]: {
        modelOverrides: {
          [modelId]: {
            compat,
          },
        },
      },
    },
  };
}

export function appendCredentialSafeProviderGuidance(lines: string[], placement: CompatAdvicePlacement, compatSuggestion: Record<string, unknown>): void {
  const providerLabel = placement.providerLabel;
  if (!providerLabel) return;

  lines.push("");
  lines.push("If this channel has no models.json provider entry yet:");
  lines.push("- Keep existing authentication as-is; do not copy credentials, tokens, or API keys.");
  lines.push(`- Add only cache/routing compat overrides in ${getModelsJsonDisplayPath()}.`);

  if (Object.keys(compatSuggestion).length === 0) {
    lines.push("- No safe copyable override is available for the missing flags shown above.");
    return;
  }

  lines.push("Provider-level minimal override:");
  lines.push(JSON.stringify(buildProviderCompatOverride(providerLabel, compatSuggestion), null, 2));

  if (placement.modelId) {
    lines.push("Single-model override (use this if only this model should change):");
    lines.push(JSON.stringify(buildModelCompatOverride(providerLabel, placement.modelId, compatSuggestion), null, 2));
  }
}

export function appendOpenAIProxyCompatAdviceLines(lines: string[], missing: string[], options: { includeJsonIntro?: boolean } & CompatAdvicePlacement = {}): void {
  const suggestion = buildSafeOpenAIProxyCompatSuggestion(missing);
  const hasSafeSuggestion = Object.keys(suggestion).length > 0;

  if (hasSafeSuggestion) {
    if (options.includeJsonIntro !== false) {
      lines.push("Safe default suggestion:");
    }
    lines.push(JSON.stringify(suggestion, null, 2));
  }

  if (missing.includes("sendSessionAffinityHeaders")) {
    lines.push("- sendSessionAffinityHeaders: recommended for third-party proxies when supported; it helps keep one Pi session on the same upstream/backend.");
  }
  appendCredentialSafeProviderGuidance(lines, options, suggestion);
}

/**
 * Build the warning text displayed to users when an OpenAI-family third-party
 * proxy is missing one or more cache/session-affinity compat flags.
 *
 * The returned string contains a parseable JSON object (via JSON.stringify)
 * listing only the missing flags with recommended value `true`. Inline
 * explanations for each flag follow the JSON snippet as separate prose lines,
 * so the JSON remains valid and copyable.
 *
 * Expected use: the openai adapter's warningText calls this function; tests
 * exercise it via __internals_for_tests.
 */
export function buildOpenAIProxyCompatWarningText(key: string, missing: string[]): string {
  // Extract provider id from the model key (e.g. "otokapi/gpt-5.5" -> "otokapi").
  // If no slash is found, fall back to the key itself.
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;

  const modelsJsonPath = getModelsJsonDisplayPath();
  const lines: string[] = [
    `💡 pi-cache-optimizer: ${key} is a third-party OpenAI-compatible proxy but merged compat lacks ${missing.join(" and ")}.`,
    `Run /cache-optimizer fix to preview a confirmed repair (or edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat manually).`,
    ``,
  ];

  appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId });

  return lines.join("\n");
}

/**
 * DeepSeek's model family and its reasoning wire protocol are separate facts.
 * The family name selects the cache adapter, but only an explicit effective
 * `thinkingFormat: "deepseek"` opts a third-party OpenAI Completions model into
 * the reasoning/replay compat checks below. Model names, provider ids, URLs,
 * and supportsReasoningEffort are not protocol evidence.
 */
export function isDeepSeekWireCompatApplicable(model: PiModel): boolean {
  // `thinkingFormat` is the only wire-protocol signal. The model family is
  // still name/id based for adapter selection, while provider, URL, and
  // supportsReasoningEffort remain deliberately irrelevant here.
  return isDeepSeekLikeModel(model)
    && isOpenAICompatibleProxyApi(model.api)
    && getCompat(model).thinkingFormat === "deepseek";
}

export function describeMissingDeepSeekCompat(model: PiModel): string[] {
  if (!isDeepSeekWireCompatApplicable(model)) return [];

  const compat = getCompat(model);
  const missing: string[] = [];
  if (compat.requiresReasoningContentOnAssistantMessages !== true) {
    missing.push("requiresReasoningContentOnAssistantMessages");
  }
  return missing;
}

export function describeMissingCacheCompatForModel(model: PiModel): string[] {
  if (isAdaptiveThinkingCompatApplicable(model)) {
    return describeMissingAdaptiveThinkingCompat(model);
  }

  const missing = describeMissingOpenAICompatibleProxyCompat(model);
  if (isDeepSeekWireCompatApplicable(model)) {
    missing.push(...describeMissingDeepSeekCompat(model));
  }
  return missing;
}

export function buildDeepSeekCompatSuggestion(missing: string[]): Record<string, unknown> {
  const suggestion: Record<string, unknown> = {
    ...buildSafeOpenAIProxyCompatSuggestion(missing),
  };
  if (missing.includes("requiresReasoningContentOnAssistantMessages")) {
    suggestion.requiresReasoningContentOnAssistantMessages = true;
  }
  return suggestion;
}

export function appendDeepSeekCompatAdviceLines(lines: string[], missing: string[], placement: CompatAdvicePlacement = {}): void {
  const suggestion = buildDeepSeekCompatSuggestion(missing);
  if (Object.keys(suggestion).length > 0) {
    lines.push("Recommended DeepSeek reasoning/replay compat snippet:");
    lines.push(JSON.stringify(suggestion, null, 2));
  }

  if (missing.includes("requiresReasoningContentOnAssistantMessages")) {
    lines.push('- requiresReasoningContentOnAssistantMessages: true keeps replayed assistant turns compatible with an explicitly selected DeepSeek reasoning wire format.');
  }
  if (missing.includes("sendSessionAffinityHeaders")) {
    lines.push("- sendSessionAffinityHeaders: recommended for third-party OpenAI-compatible proxies when supported; it helps keep one Pi session on the same upstream/backend.");
  }

  appendCredentialSafeProviderGuidance(lines, placement, suggestion);
}

export function buildDeepSeekCompatWarningText(key: string, missing: string[]): string {
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;
  const modelsJsonPath = getModelsJsonDisplayPath();
  const lines: string[] = [
    `💡 pi-cache-optimizer: ${key} is DeepSeek-like but merged compat lacks ${missing.join(" and ")}.`,
    `Proxies may reduce or hide cache hits. Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (at the same level as baseUrl/api/apiKey/models).`,
    "",
  ];

  appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId });

  return lines.join("\n");
}

export function describeMissingOpenAIFamilyProxyCompat(model: PiModel): string[] {
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
