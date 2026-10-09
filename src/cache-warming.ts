import { type PiModel, asRecord } from "./common.ts";

/**
 * Diagnostics for Pi's native prompt-cache warming (Pi 0.86+, `cacheWarming`
 * setting). Pi re-sends the last request with a one-token output cap at 90% of
 * the cache lifetime, but only when:
 *   - the global `cacheWarming` setting is not "off";
 *   - the model declares `promptCache.<tier>` for the retention tier in use;
 *   - the model's prices let Pi estimate the savings (cost.cacheRead/cacheWrite/input);
 *   - the request is replayable (Anthropic budget-based thinking is not).
 * Streaming warming stops 60 minutes after the real request and idle warming
 * after 30 minutes, so idle mode never refreshes a 1-hour cache entry (its
 * refresh would fire at 54 minutes).
 *
 * This module only reads state and explains it; it never changes settings or
 * models.json. The extension does not run its own keepalive timer, because a
 * second warmer would double-bill refreshes and could not replay Pi's exact
 * request context.
 */

export type CacheWarmingMode = "off" | "streaming" | "idle";

export const CACHE_WARMING_DEFAULT_MODE: CacheWarmingMode = "streaming";
export const CACHE_WARMING_STREAMING_MAX_MS = 60 * 60_000;
export const CACHE_WARMING_IDLE_MAX_MS = 30 * 60_000;

/** Same schedule Pi uses: 90% of the TTL, keeping at least ten seconds of margin. */
export function cacheWarmingRefreshDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

export type CacheWarmingSettingsReader = () => unknown;

/**
 * Read the `cacheWarming` mode from `pi.getSettings()` (Pi 0.86+). Returns
 * undefined when the host has no settings API or no warming support.
 */
export function readCacheWarmingMode(getSettings: CacheWarmingSettingsReader | undefined): CacheWarmingMode | "unsupported" {
  if (typeof getSettings !== "function") return "unsupported";
  let settings: unknown;
  try {
    settings = getSettings();
  } catch {
    return "unsupported";
  }
  const value = asRecord(settings)?.cacheWarming;
  if (value === "off" || value === "streaming" || value === "idle") return value;
  return CACHE_WARMING_DEFAULT_MODE;
}

export function suggestedPromptCacheLifetimes(model: PiModel): { short: number; long?: number } {
  // Anthropic documents a 5-minute default and an optional 1-hour TTL. For
  // other APIs only the conservative short lifetime is suggested; extended
  // retention differs per provider and deployment.
  if (model.api === "anthropic-messages") return { short: 300, long: 3600 };
  return { short: 300 };
}

function readPromptCacheTier(model: PiModel, tier: "short" | "long"): number | undefined {
  const promptCache = asRecord((model as unknown as Record<string, unknown>).promptCache);
  const value = promptCache?.[tier];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function hasPricing(model: PiModel): boolean {
  const cost = asRecord((model as unknown as Record<string, unknown>).cost);
  if (!cost) return false;
  return ["input", "cacheRead", "cacheWrite"].some((key) => typeof cost[key] === "number" && (cost[key] as number) > 0);
}

function isReplayableForWarming(model: PiModel): boolean {
  if (!model.reasoning || model.api !== "anthropic-messages") return true;
  return asRecord(asRecord(model as unknown)?.compat)?.forceAdaptiveThinking === true;
}

export type CacheWarmingDiagnosisInput = {
  mode: CacheWarmingMode | "unsupported";
  /** Retention tier Pi uses for this request ("long" when PI_CACHE_RETENTION=long). */
  tier: "short" | "long";
};

export type CacheWarmingDiagnosis = {
  eligible: boolean;
  issues: string[];
  lines: string[];
};

function formatSeconds(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function buildCacheWarmingDiagnosis(model: PiModel, input: CacheWarmingDiagnosisInput): CacheWarmingDiagnosis {
  const lines: string[] = ["", "🔥 Prompt cache warming (Pi cacheWarming):"];
  const issues: string[] = [];

  if (input.mode === "unsupported") {
    lines.push("- This Pi host does not expose cache warming settings (requires Pi 0.86+). Nothing to check.");
    return { eligible: false, issues: ["unsupported"], lines };
  }

  lines.push(`- Mode: ${input.mode}${input.mode === CACHE_WARMING_DEFAULT_MODE ? " (default)" : ""} — global setting, change with /settings → Cache warming or ~/.pi/agent/settings.json`);
  lines.push(`- Retention tier in use: ${input.tier}`);

  if (input.mode === "off") {
    issues.push("mode_off");
    lines.push("- Warming is off: long tool runs can outlive the cache entry and the next request rewrites it.");
  }

  const ttl = readPromptCacheTier(model, input.tier);
  if (ttl === undefined) {
    issues.push("prompt_cache_missing");
    const suggested = suggestedPromptCacheLifetimes(model);
    const snippet: Record<string, number> = { short: suggested.short };
    if (suggested.long !== undefined) snippet.long = suggested.long;
    lines.push(`- ⚠️ The model declares no promptCache.${input.tier} lifetime, so Pi never warms its cache.`);
    lines.push(`  Add to this model's entry in models.json (custom models) or under the provider's modelOverrides.${JSON.stringify(model.id)} (built-in models):`);
    lines.push(`  "promptCache": ${JSON.stringify(snippet)}`);
    if (input.tier === "long" && suggested.long === undefined) {
      lines.push("  Only add a long lifetime your provider documents; use the conservative end of any range.");
    }
  } else {
    lines.push(`- promptCache.${input.tier}: ${formatSeconds(ttl)}`);
  }

  if (!hasPricing(model)) {
    issues.push("pricing_missing");
    lines.push("- ⚠️ The model has no input/cache prices, so Pi cannot estimate savings and skips warming. Add a cost block to the model entry.");
  }

  if (!isReplayableForWarming(model)) {
    issues.push("not_replayable");
    lines.push("- ⚠️ Anthropic budget-based thinking cannot be replayed with a one-token cap, so Pi skips warming. Set compat.forceAdaptiveThinking only if the model supports adaptive thinking.");
  }

  if (ttl !== undefined && input.mode === "idle") {
    const delay = cacheWarmingRefreshDelayMs(ttl * 1000);
    if (delay !== undefined && delay > CACHE_WARMING_IDLE_MAX_MS) {
      lines.push(`- Note: idle warming stops after 30m, but a ${formatSeconds(ttl)} entry would refresh at ${Math.round(delay / 60_000)}m, so idle mode adds nothing for this tier. The ${formatSeconds(ttl)} lifetime already covers shorter breaks.`);
    }
  }

  const eligible = input.mode !== "off" && issues.length === 0;
  if (eligible) {
    lines.push(`- ✓ Eligible: Pi keeps this cache warm ${input.mode === "idle" ? "during runs and briefly between runs" : "during agent runs"} when the expected savings are at least $0.05.`);
  }
  return { eligible, issues, lines };
}
