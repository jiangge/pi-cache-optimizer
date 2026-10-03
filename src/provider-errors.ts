import { LOG_PREFIX, type PiModel, lower } from "./common.ts";
import { isDeepSeekWireCompatApplicable } from "./compat-advice.ts";
import { getOptionalAssistantHttpStatus } from "./diagnostics.ts";
import { type FixSuggestion } from "./fix-types.ts";
import { getAssistantRecord, getCompat, isDeepSeekLikeModel, isOfficialOpenAIBaseUrl, isOpenAICompatibleApi, isOpenAICompatibleProxyApi, isPiBuiltInLlamaCppModel, modelKey } from "./model-identity.ts";
import { isActionableModelsJsonFixReceipt, readModelsJsonFixReceipt } from "./models-json-fix.ts";
import { firstNonEmptyString } from "./routing.ts";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const ANTHROPIC_TTL_FALLBACK_SYMBOL = Symbol.for("pi.cache.optimizer.anthropic-ttl-fallback.v1");

export const REASONING_PROTOCOL_FALLBACK_SYMBOL = Symbol.for("pi.cache.optimizer.reasoning-protocol-fallback.v1");

export type AnthropicTtlFallbackStateV1 = {
  version: 1;
  modelKeys: Set<string>;
  warnedModelKeys: Set<string>;
};

export type ReasoningProtocolFallbackStateV1 = {
  version: 1;
  modelKeys: Set<string>;
  warnedModelKeys: Set<string>;
};

export function getReasoningProtocolFallbackState(): ReasoningProtocolFallbackStateV1 {
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

export function getAnthropicTtlFallbackState(): AnthropicTtlFallbackStateV1 {
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

export function hasPromptCacheRetentionUnsupportedText(value: unknown): boolean {
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

export function hasPromptCacheRetentionUnsupportedErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  return record?.stopReason === "error" &&
    hasPromptCacheRetentionUnsupportedText(record.errorMessage);
}

export function hasPromptCacheKeyUnsupportedText(value: unknown): boolean {
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

export function hasPromptCacheKeyUnsupportedErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  return record?.stopReason === "error" &&
    getOptionalAssistantHttpStatus(record) === 400 &&
    hasPromptCacheKeyUnsupportedText(record.errorMessage);
}

export function hasReasoningProtocolRejectionText(value: unknown): boolean {
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

export function hasReasoningProtocolRejectionErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  if (!record || record.stopReason !== "error") return false;
  // Finalized assistant messages do not expose a separate status field in the
  // normal Pi path, so recover it only from structured diagnostics or the
  // adapter's status-shaped error prefix. A text-only 400-looking parameter
  // message is not enough evidence for a protocol repair.
  return getOptionalAssistantHttpStatus(record) === 400 &&
    hasReasoningProtocolRejectionText(record.errorMessage);
}

export function isReasoningProtocolRejectionSignalApplicable(model: PiModel | undefined): boolean {
  // A provider error can teach us which protocol it expects, so this gate is
  // intentionally broader than the explicit DeepSeek-format diagnostic gate.
  // The model family identifies the affected cache/compat bucket; the error
  // text, not the model name, supplies the wire-protocol evidence.
  return !!model && isOpenAICompatibleProxyApi(model.api) && isDeepSeekLikeModel(model);
}

export function isReasoningProtocolRejectionForModel(message: unknown, model: PiModel | undefined): boolean {
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

export async function notifyReasoningProtocolObservation(
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

export function fixSuggestionIdentity(model: PiModel): { providerLabel: string; modelId: string } {
  const key = modelKey(model);
  const slashIdx = key.indexOf("/");
  return {
    providerLabel: slashIdx > 0 ? key.slice(0, slashIdx) : key,
    modelId: model.id,
  };
}

export function mergeFixSuggestions(...suggestions: Array<FixSuggestion | undefined>): FixSuggestion | undefined {
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

export function buildReasoningProtocolFixSuggestion(
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

export function hasExplicitDeepSeekReasoningProtocol(model: PiModel): boolean {
  return isDeepSeekWireCompatApplicable(model);
}

export function isExplicitPromptCacheRetentionUnsupportedApplicable(model: PiModel): boolean {
  // A finalized assistant error with an explicit unsupported-parameter signal
  // proves that prompt_cache_retention reached this provider/model. Do not
  // require compat inherited from the active fallback model: router shells may
  // have no upstream compat metadata when no live routing registry is present.
  return isOpenAICompatibleApi(model.api) &&
    !isOfficialOpenAIBaseUrl(model) &&
    !isPiBuiltInLlamaCppModel(model);
}

export function hasPromptCacheRetentionUnsupportedSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return hasPromptCacheRetentionUnsupportedText(
    Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  );
}

export function hasPromptCacheKeyUnsupportedSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(([key, value]) => hasPromptCacheKeyUnsupportedText(`${key}: ${value}`));
}

export function hasReasoningProtocolRejectionSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  // Each response header is one diagnostic unit. Joining all values can pair a
  // rejection from one header with unrelated documentation in another.
  return Object.entries(headers).some(([key, headerValue]) =>
    hasReasoningProtocolRejectionText(`${key}: ${headerValue}`)
  );
}
