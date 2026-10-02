import { type PiModel, isNonEmptyString } from "./common.ts";
import { type CacheCompat } from "./compat-config.ts";
import { getCompat } from "./model-identity.ts";

export const REQUEST_SNAPSHOT_COMPAT_KEYS: Array<keyof CacheCompat> = [
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

export function snapshotCompatForDiagnostics(model: PiModel): CacheCompat {
  const source = getCompat(model);
  const snapshot: CacheCompat = {};
  const mutableSnapshot = snapshot as Record<string, unknown>;
  for (const key of REQUEST_SNAPSHOT_COMPAT_KEYS) {
    const value = source[key];
    if (value !== undefined) mutableSnapshot[key] = value;
  }
  return snapshot;
}

export function snapshotBaseUrlForDiagnostics(value: unknown): string {
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

export function snapshotProviderRequestModel(model: PiModel | undefined): PiModel | undefined {
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
export const MAX_PROVIDER_REQUEST_STATES = 32;

export function pruneProviderRequestStates<T extends { responseReceived: boolean }>(
  states: T[],
  max = MAX_PROVIDER_REQUEST_STATES,
): void {
  while (states.length > max) {
    const completed = states.findIndex((state) => state.responseReceived);
    states.splice(completed >= 0 ? completed : 0, 1);
  }
}
