import { type PiModel, asRecord } from "./common.ts";
import { buildModelsJsonTypoHintLines } from "./models-json-lint.ts";

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

/** Pi's default before 1.5.1. */
export const CACHE_WARMING_DEFAULT_MODE: CacheWarmingMode = "streaming";
/** Pi 1.5.1 changed the `cacheWarming` default from "streaming" to "idle". */
export const CACHE_WARMING_IDLE_DEFAULT_SINCE = "1.5.1";
export const CACHE_WARMING_STREAMING_MAX_MS = 60 * 60_000;
export const CACHE_WARMING_IDLE_MAX_MS = 30 * 60_000;

/** Same schedule Pi uses: 90% of the TTL, keeping at least ten seconds of margin. */
export function cacheWarmingRefreshDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

function parseVersionCore(version: string | undefined): [number, number, number] | undefined {
  const match = typeof version === "string" ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim()) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * The mode Pi uses when global settings name none: "idle" from Pi 1.5.1,
 * "streaming" before. An unknown host version keeps the older default.
 */
export function cacheWarmingDefaultMode(piVersion: string | undefined): CacheWarmingMode {
  const host = parseVersionCore(piVersion);
  const since = parseVersionCore(CACHE_WARMING_IDLE_DEFAULT_SINCE)!;
  if (!host) return CACHE_WARMING_DEFAULT_MODE;
  for (let i = 0; i < 3; i++) {
    if (host[i] !== since[i]) return host[i] > since[i] ? "idle" : "streaming";
  }
  return "idle";
}

export type CacheWarmingSettingsReader = () => unknown;

function parseMode(value: unknown): CacheWarmingMode | undefined {
  return value === "off" || value === "streaming" || value === "idle" ? value : undefined;
}

export type CacheWarmingSetting = {
  /** The mode Pi actually uses. */
  mode: CacheWarmingMode;
  /** True when the user's global settings name a valid mode; false when Pi falls back to its default. */
  explicit: boolean;
  /**
   * A valid `cacheWarming` that only project settings carry. Pi reads warming
   * from global settings only (warming costs money), so it is ignored.
   */
  ignoredProjectMode?: CacheWarmingMode;
};

export type CacheWarmingSettingsSources = {
  /** `pi.getSettings()`: global and project settings merged (Pi 0.86+). */
  getSettings?: CacheWarmingSettingsReader;
  /**
   * Global settings only, the source Pi reads warming from. Returns undefined
   * when they cannot be read; then the merged settings are used instead.
   */
  readGlobalSettings?: CacheWarmingSettingsReader;
  /** Host Pi version, which decides the default. */
  piVersion?: string;
};

/**
 * Resolve the `cacheWarming` mode the way Pi does: the global setting when it
 * is valid, else the host version's default. Returns "unsupported" when the
 * host has no settings API (no warming support).
 */
export function readCacheWarmingSetting(sources: CacheWarmingSettingsSources): CacheWarmingSetting | "unsupported" {
  if (typeof sources.getSettings !== "function") return "unsupported";
  let merged: unknown;
  try {
    merged = sources.getSettings();
  } catch {
    return "unsupported";
  }
  const fallback = cacheWarmingDefaultMode(sources.piVersion);
  const mergedMode = parseMode(asRecord(merged)?.cacheWarming);

  let global: unknown;
  try {
    global = sources.readGlobalSettings?.();
  } catch {
    global = undefined;
  }
  if (global === undefined) {
    return mergedMode ? { mode: mergedMode, explicit: true } : { mode: fallback, explicit: false };
  }
  const globalMode = parseMode(asRecord(global)?.cacheWarming);
  const setting: CacheWarmingSetting = globalMode ? { mode: globalMode, explicit: true } : { mode: fallback, explicit: false };
  if (mergedMode !== undefined && mergedMode !== globalMode) setting.ignoredProjectMode = mergedMode;
  return setting;
}

/** Compatibility wrapper: the mode alone, from merged settings and the pre-1.5.1 default. */
export function readCacheWarmingMode(getSettings: CacheWarmingSettingsReader | undefined, piVersion?: string): CacheWarmingMode | "unsupported" {
  const setting = readCacheWarmingSetting({ getSettings, piVersion });
  return setting === "unsupported" ? setting : setting.mode;
}

export function suggestedPromptCacheLifetimes(model: PiModel): { short: number; long?: number } {
  // Anthropic documents a 5-minute default and an optional 1-hour TTL. For
  // other APIs only the conservative short lifetime is suggested; extended
  // retention differs per provider and deployment.
  if (model.api === "anthropic-messages") return { short: 300, long: 3600 };
  // Elsewhere only the short tier has a value the extension can stand behind.
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

const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function hasPositivePrice(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  return PRICE_KEYS.some((key) => typeof record[key] === "number" && (record[key] as number) > 0);
}

/**
 * OpenRouter router models (`openrouter/auto`, `openrouter/free`-style ids)
 * forward to whichever model the router picks. OpenRouter lists them with a -1
 * placeholder price, which Pi 1.2.0+ normalises to 0, so a zero cost block
 * means "unknown", not "free". Matched on the id prefix so the same router
 * reached through another provider entry is covered too.
 */
export function isOpenRouterRouterModel(model: PiModel): boolean {
  return typeof model.id === "string" && model.id.toLowerCase().startsWith("openrouter/");
}

function costTiers(cost: Record<string, unknown>): unknown[] {
  return Array.isArray(cost.tiers) ? cost.tiers : [];
}

/** Prompt-length tiers carry prices but the base cost block does not. */
function hasOnlyTierPrices(model: PiModel): boolean {
  const cost = asRecord((model as unknown as Record<string, unknown>).cost);
  if (!cost || hasPositivePrice(cost)) return false;
  return costTiers(cost).some((tier) => hasPositivePrice(asRecord(tier)));
}

/**
 * Every price Pi uses for warming economics is zero or missing, including the
 * prompt-length cost tiers Pi 1.2.0 added, and the zero is not a placeholder
 * for an unknown router price.
 */
export function isZeroPriced(model: PiModel): boolean {
  if (isOpenRouterRouterModel(model)) return false;
  const cost = asRecord((model as unknown as Record<string, unknown>).cost);
  if (!cost) return true;
  if (hasPositivePrice(cost)) return false;
  return !costTiers(cost).some((tier) => hasPositivePrice(asRecord(tier)));
}

function isReplayableForWarming(model: PiModel): boolean {
  if (!model.reasoning || model.api !== "anthropic-messages") return true;
  return asRecord(asRecord(model as unknown)?.compat)?.forceAdaptiveThinking === true;
}

export type CacheWarmingDiagnosisInput = {
  mode: CacheWarmingMode | "unsupported";
  /**
   * Whether global settings name the mode. Undefined keeps the old reading:
   * the mode equal to CACHE_WARMING_DEFAULT_MODE is shown as the default.
   */
  explicit?: boolean;
  /** A project-only `cacheWarming` that Pi ignores. */
  ignoredProjectMode?: CacheWarmingMode;
  /** Retention tier Pi uses for this request ("long" when PI_CACHE_RETENTION=long). */
  tier: "short" | "long";
  /** Whether the extension keeps warming running for zero-price models. */
  zeroPriceWarming?: boolean;
  /**
   * Append near-miss models.json key hints (issue #30). Default true;
   * `/cache-optimizer doctor` passes false because it lists every typo in its
   * own section.
   */
  typoHints?: boolean;
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

  const isDefault = input.explicit === undefined ? input.mode === CACHE_WARMING_DEFAULT_MODE : !input.explicit;
  lines.push(`- Mode: ${input.mode}${isDefault ? " (Pi default)" : ""} — global setting, change with /settings → Cache warming or ~/.pi/agent/settings.json`);
  if (input.ignoredProjectMode !== undefined) {
    lines.push(`- Note: project settings set cacheWarming to "${input.ignoredProjectMode}", but Pi reads warming from global settings only, so it has no effect.`);
  }
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
    if (input.tier === "short" || suggested.long !== undefined) {
      lines.push("  Or run /cache-optimizer fix prompt-cache to add it with a preview, backup and rollback.");
    }
    if (input.tier === "long" && suggested.long === undefined) {
      lines.push("  Only add a long lifetime your provider documents; use the conservative end of any range.");
    }
    // A misspelled promptCache/modelOverrides key is accepted and ignored by Pi (issue #30).
    if (input.typoHints !== false) {
      for (const hint of buildModelsJsonTypoHintLines(model.provider, model.id)) lines.push(`  ${hint}`);
    }
  } else {
    lines.push(`- promptCache.${input.tier}: ${formatSeconds(ttl)}`);
  }

  if (!hasPricing(model)) {
    if (input.zeroPriceWarming && isZeroPriced(model)) {
      lines.push("- The model has no input/cache prices. Pi would skip warming; this extension overrides that (config zero-price-warming on).");
      if (input.mode === "idle" && input.explicit === false) {
        lines.push("  The override covers agent runs only: idle is Pi's default here, and refreshes between runs are billed by the proxy. Set cacheWarming to \"idle\" in global settings to extend it between runs.");
      }
    } else if (isOpenRouterRouterModel(model)) {
      issues.push("pricing_unknown");
      lines.push("- ⚠️ OpenRouter router models list a placeholder price that Pi shows as 0, but the routed model is billed at its own price. Pi cannot estimate savings and skips warming; zero-price warming does not apply.");
    } else if (hasOnlyTierPrices(model)) {
      issues.push("pricing_missing");
      lines.push("- ⚠️ The model has prompt-length price tiers but no base input/cache prices, so Pi cannot estimate savings and skips warming. Add base prices to the cost block.");
    } else {
      issues.push("pricing_missing");
      lines.push("- ⚠️ The model has no input/cache prices, so Pi cannot estimate savings and skips warming. Add a cost block, or turn on /cache-optimizer config zero-price-warming.");
    }
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

export type CacheWarmingDecisionLike = {
  action?: unknown;
  /** "streaming" during an agent run, "idle" between runs (Pi 1.5.1+ default mode). */
  phase?: unknown;
  warmCost?: unknown;
  missCost?: unknown;
};

/**
 * `cache_warming_decision` policy: Pi stops warming when it cannot price the
 * refresh ("cache economics unavailable"), which is every model whose cost
 * block is all zero, the common case for custom proxy channels. A refresh is a
 * cache read of the prompt plus one output token, far cheaper than rewriting
 * the cache, so keep warming for those models. Pi's own decision stands
 * whenever the model has real prices, and Pi's mode, lifetime, replayability
 * and 60m/30m safety limits still apply.
 *
 * Between runs (phase "idle") the override applies only when the user chose
 * `cacheWarming: "idle"` in global settings. Pi 1.5.1 made idle the default,
 * and zero prices on proxy channels usually mean "not configured", not free:
 * refreshing an idle session every few minutes for half an hour bills real
 * money with no estimate of whether the user comes back. With the default
 * mode the override keeps its pre-1.5.1 reach, agent runs only.
 */
export function decideZeroPriceWarming(event: CacheWarmingDecisionLike, model: PiModel | undefined, options: { idleExplicit?: boolean } = {}): "warm" | undefined {
  if (!model || event.action !== "stop") return undefined;
  if (event.phase === "idle" && options.idleExplicit !== true) return undefined;
  if (event.warmCost !== 0 || event.missCost !== 0) return undefined;
  if (!isZeroPriced(model)) return undefined;
  return "warm";
}
