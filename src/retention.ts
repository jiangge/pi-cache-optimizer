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
