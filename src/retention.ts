import { type MutableEnv } from "./common.ts";

export type CacheRetentionEnvSnapshot = {
  wasSet: boolean;
  value?: string;
};

export const PI_CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";

export const LONG_CACHE_RETENTION_VALUE = "long";

export const PI_CACHE_RETENTION_BASELINE_SYMBOL = Symbol.for("pi.cache.optimizer.retention-baseline.v1");

export type CacheRetentionBaselineV1 = {
  version: 1;
  snapshot: CacheRetentionEnvSnapshot;
};

export function captureCacheRetentionEnv(env: MutableEnv = process.env): CacheRetentionEnvSnapshot {
  return {
    wasSet: Object.prototype.hasOwnProperty.call(env, PI_CACHE_RETENTION_ENV),
    value: env[PI_CACHE_RETENTION_ENV],
  };
}

export function requestLongCacheRetention(env: MutableEnv = process.env): void {
  if (!env[PI_CACHE_RETENTION_ENV] || env[PI_CACHE_RETENTION_ENV] !== LONG_CACHE_RETENTION_VALUE) {
    env[PI_CACHE_RETENTION_ENV] = LONG_CACHE_RETENTION_VALUE;
  }
}

export function restoreCacheRetentionEnv(snapshot: CacheRetentionEnvSnapshot, env: MutableEnv = process.env): void {
  if (snapshot.wasSet) {
    env[PI_CACHE_RETENTION_ENV] = snapshot.value;
  } else {
    delete env[PI_CACHE_RETENTION_ENV];
  }
}

/**
 * Why `prompt_cache_retention` was kept on, or removed from, a provider payload.
 *
 * - `provider-rejected`: this model already answered with an explicit
 *   unsupported-parameter error in this process; never resend it.
 * - `official-openai`: api.openai.com documents the parameter.
 * - `explicit-opt-in`: models.json or the runtime model compat explicitly sets
 *   `supportsLongCacheRetention: true` (Pi's built-in catalog only ever sets
 *   `false`, so `true` is always a deliberate choice).
 * - `user-requested-long`: the user started Pi with `PI_CACHE_RETENTION=long`
 *   themselves, so the field is vanilla Pi behaviour, not an optimizer side effect.
 * - `unverified-endpoint`: the field exists only because this extension forced
 *   `PI_CACHE_RETENTION=long`; third-party endpoints (including Azure, whose
 *   support is per deployed model) are not known to accept it.
 */
export type PromptCacheRetentionGateReason =
  | "provider-rejected"
  | "official-openai"
  | "explicit-opt-in"
  | "user-requested-long"
  | "unverified-endpoint";

export type PromptCacheRetentionGateInput = {
  providerRejected: boolean;
  officialOpenAI: boolean;
  explicitOptIn: boolean;
  userRequestedLong: boolean;
};

export type PromptCacheRetentionGateDecision = {
  keep: boolean;
  reason: PromptCacheRetentionGateReason;
};

/**
 * Pure decision for the `prompt_cache_retention` gate. The optimizer only undoes
 * its own side effect: it never strips a field the user or the provider config
 * asked for, except after the provider has explicitly rejected it.
 */
export function decidePromptCacheRetention(input: PromptCacheRetentionGateInput): PromptCacheRetentionGateDecision {
  if (input.providerRejected) return { keep: false, reason: "provider-rejected" };
  if (input.officialOpenAI) return { keep: true, reason: "official-openai" };
  if (input.explicitOptIn) return { keep: true, reason: "explicit-opt-in" };
  if (input.userRequestedLong) return { keep: true, reason: "user-requested-long" };
  return { keep: false, reason: "unverified-endpoint" };
}

/** True when PI_CACHE_RETENTION=long was already set before this extension loaded. */
export function userRequestedLongCacheRetention(snapshot: CacheRetentionEnvSnapshot = STARTUP_CACHE_RETENTION_ENV): boolean {
  return snapshot.wasSet && snapshot.value === LONG_CACHE_RETENTION_VALUE;
}

export type PromptCacheRetentionDecisionRecord = PromptCacheRetentionGateDecision & {
  modelKey?: string;
  at: number;
};

let lastPromptCacheRetentionDecision: PromptCacheRetentionDecisionRecord | undefined;

/** Remember the latest gate decision so `/cache-optimizer doctor` can explain it. */
export function recordPromptCacheRetentionDecision(modelKey: string | undefined, decision: PromptCacheRetentionGateDecision): void {
  lastPromptCacheRetentionDecision = { ...decision, modelKey, at: Date.now() };
}

export function getLastPromptCacheRetentionDecision(): PromptCacheRetentionDecisionRecord | undefined {
  return lastPromptCacheRetentionDecision ? { ...lastPromptCacheRetentionDecision } : undefined;
}

const PROMPT_CACHE_RETENTION_REASON_TEXT: Record<PromptCacheRetentionGateReason, string> = {
  "provider-rejected": "removed: this model rejected the parameter earlier in this process",
  "official-openai": "kept: official OpenAI endpoint",
  "explicit-opt-in": "kept: supportsLongCacheRetention: true is set explicitly",
  "user-requested-long": "kept: PI_CACHE_RETENTION=long was set before Pi started",
  "unverified-endpoint": "removed: added only by the optimizer and the endpoint is not known to accept it (set supportsLongCacheRetention: true to opt in)",
};

export function describePromptCacheRetentionDecision(record: PromptCacheRetentionDecisionRecord | undefined): string | undefined {
  if (!record) return undefined;
  return `prompt_cache_retention ${PROMPT_CACHE_RETENTION_REASON_TEXT[record.reason]}${record.modelKey ? ` (${record.modelKey})` : ""}`;
}

export function isCacheRetentionBaselineV1(value: unknown): value is CacheRetentionBaselineV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { version?: unknown; snapshot?: unknown };
  if (record.version !== 1 || typeof record.snapshot !== "object" || record.snapshot === null) return false;
  const snapshot = record.snapshot as { wasSet?: unknown; value?: unknown };
  return typeof snapshot.wasSet === "boolean" &&
    (snapshot.value === undefined || typeof snapshot.value === "string");
}

export function getOrCaptureCacheRetentionBaseline(
  env: MutableEnv = process.env,
  globals: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
): CacheRetentionEnvSnapshot {
  const existing = globals[PI_CACHE_RETENTION_BASELINE_SYMBOL];
  if (isCacheRetentionBaselineV1(existing)) return { ...existing.snapshot };

  const snapshot = captureCacheRetentionEnv(env);
  globals[PI_CACHE_RETENTION_BASELINE_SYMBOL] = { version: 1, snapshot: { ...snapshot } };
  return snapshot;
}

export const STARTUP_CACHE_RETENTION_ENV = getOrCaptureCacheRetentionBaseline();

/**
 * Pi Cache Optimizer (formerly pi-deepseek-cache-optimizer)
 *
 * What it does:
 * 1. Reorders Pi's system prompt so stable content is sent before dynamic context.
 * 2. Sets PI_CACHE_RETENTION=long at extension load time.
 * 3. Warns once for provider/model cache compat gaps where the signal is conservative.
 * 4. Shows lightweight persisted provider-specific cache stats in Pi's footer.
 * 5. Offers disabled-by-default deterministic built-in tool ordering when
 *    explicitly opted in.
 *
 * Provider prompt/KV caches are provider-side and best-effort. This extension improves
 * the odds of cache hits; it cannot guarantee hits, especially through proxies.
 */

// ============================================================
// Automatically request long prompt-cache retention when Pi supports it.
// /cache-optimizer disable restores the startup value for this Pi process.
// ============================================================
requestLongCacheRetention();
