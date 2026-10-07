import { type CacheProviderAdapter } from "./adapters.ts";
import { type PiModel, type UnknownRecord, asRecord, isNonEmptyString, lower } from "./common.ts";
import { type CompatAdvicePlacement, appendCredentialSafeProviderGuidance, appendDeepSeekCompatAdviceLines, appendOpenAIProxyCompatAdviceLines, buildDeepSeekCompatSuggestion, buildSafeOpenAIProxyCompatSuggestion, describeMissingCacheCompatForModel, getModelsJsonDisplayPath, isAdaptiveThinkingCompatApplicable, isDeepSeekWireCompatApplicable } from "./compat-advice.ts";
import { type FixSuggestion } from "./fix-types.ts";
import { getCompat, isKnownThirdPartyOpenAIEndpoint, isMistralConversationsApi, isNativeVirtualModel, isOfficialOpenAIBaseUrl, isOpenAICompatibleApi, isOpenAICompatibleProxyApi, isPiBuiltInLlamaCppModel, modelKey } from "./model-identity.ts";
import { type CacheUsageSample, formatRecentTrendSummary } from "./stats-report.ts";
import { type CacheStats, emptyCacheStats } from "./stats-store.ts";
import { snapshotBaseUrlForDiagnostics } from "./request-state.ts";

export function buildAdaptiveThinkingCompatSuggestion(missing: string[]): Record<string, unknown> {
  const suggestion: Record<string, unknown> = {};
  if (missing.includes("forceAdaptiveThinking")) {
    suggestion.forceAdaptiveThinking = true;
  }
  if (missing.includes("allowEmptySignature")) {
    suggestion.allowEmptySignature = true;
  }
  return suggestion;
}

export function appendAdaptiveThinkingCompatAdviceLines(lines: string[], missing: string[], placement: CompatAdvicePlacement = {}): void {
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

export function describeOptionalOpenAICompatibleProxyCompat(model: PiModel): string[] {
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

export function getPromptCacheRetentionUnsupportedHint(): string {
  return "If this channel returns `400 Unsupported parameter: prompt_cache_retention`, remove/avoid `supportsLongCacheRetention`; this extension does not write that field directly, but Pi may send it when long retention is requested and compat says the proxy supports it.";
}

export function isPromptCacheKeyUnsupportedApplicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api);
}

export function getOptionalAssistantHttpStatus(record: UnknownRecord): number | undefined {
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

export function appendOptionalOpenAIProxyCompatAdviceLines(lines: string[], optional: string[]): void {
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
export function isDeepSeekCompatCheckApplicable(model: PiModel): boolean {
  return isDeepSeekWireCompatApplicable(model);
}

export function isCompatCheckApplicable(model: PiModel): boolean {
  return isOpenAICompatibleProxyApi(model.api) && isKnownThirdPartyOpenAIEndpoint(model) && !isPiBuiltInLlamaCppModel(model);
}

export function isPromptCacheRetention400Applicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api) &&
    isKnownThirdPartyOpenAIEndpoint(model) &&
    !isPiBuiltInLlamaCppModel(model) &&
    getCompat(model).supportsLongCacheRetention === true;
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
export function isSessionAffinity403Applicable(model: PiModel): boolean {
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
export function isOpenAISdkHeader403Applicable(model: PiModel): boolean {
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
export function describeRouterChannelDiagnostics(model: PiModel): string[] {
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

export function getCompatCheckNotApplicableLines(model: PiModel): string[] {
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

export function buildDoctorDiagnosis(model: PiModel, options: { promptCacheRetention400?: boolean; promptCacheKey400?: boolean; anthropicTtlOrderError?: boolean; sessionAffinity403?: boolean; openAISdkHeader403?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Provider: ${model.provider}`);
  lines.push(`Model:    ${model.id}`);
  if (model.name && model.name !== model.id) lines.push(`Name:     ${model.name}`);
  lines.push(`API:      ${model.api}`);
  const endpoint = snapshotBaseUrlForDiagnostics(model.baseUrl);
  lines.push(`Base URL: ${endpoint || (isNonEmptyString(model.baseUrl) ? "(unavailable)" : "(default)")}`);

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
export function buildLowHitDiagnosis(
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

export function buildCompatDiagnosis(model: PiModel): string | undefined {
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
export function buildFixSuggestion(model: PiModel): FixSuggestion | undefined {
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
