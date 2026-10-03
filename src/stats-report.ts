import { type CacheProviderAdapter, isVirtualRoutingModel, selectAdapterForModel } from "./adapters.ts";
import { LOG_PREFIX, type PiModel, asRecord, getErrorCode, getNonNegativeNumber } from "./common.ts";
import { type FooterStatsMode } from "./config.ts";
import { modelKey } from "./model-identity.ts";
import { STATE_DIR } from "./paths.ts";
import { CACHE_PROVIDER_IDS, type CacheProviderId, type CacheStats, LEGACY_STATE_FILE_PATH, type PersistedRoutedModelRef, STATE_FILE_PATH, type ShardAggregate, currentLocalDay, emptyCacheStats, mergeCacheStatsForTotal, parseCacheStats, parsePersistedRoutedModelRef } from "./stats-store.ts";
import { usageRecordFromAssistant } from "./usage.ts";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CacheStatsState = {
  statsByModel: Record<string, CacheStats>;
  totalsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>;
};

export type PersistedCacheStatsV6 = {
  version: 6;
  sessions: Record<string, Record<string, CacheStats>>;
  totalsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>;
};

export type CacheUsageSample = {
  timestamp: number;
  hit: boolean;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
  missingUsageFields: boolean;
};

/**
 * Build a session-scoped stats key from a session hash + provider/id.
 * Pure function (no closure dependency) for use by tests and internals.
 */
export function makeSessionModelKey(sessionHash: string, provider: string, id: string): string {
  return `${sessionHash}:${provider}/${id}`;
}

/**
 * Extract the user-facing model key from a session-scoped key.
 * "abc123:otokapi/gpt-5.5" → "otokapi/gpt-5.5"
 */
export function modelKeyFromSessionKey(sessionModelKey: string): string {
  const idx = sessionModelKey.indexOf(":");
  return idx >= 0 ? sessionModelKey.slice(idx + 1) : sessionModelKey;
}

export function formatTokenCount(value: number): string {
  const millions = Math.max(0, Math.round(value)) / 1_000_000;
  if (millions === 0) return "0M";
  if (millions < 0.001) return `${millions.toFixed(4)}M`;
  if (millions < 0.01) return `${millions.toFixed(3)}M`;
  if (millions >= 10) return `${millions.toFixed(1)}M`;
  return `${millions.toFixed(2)}M`;
}

export function formatCacheStats(adapter: CacheProviderAdapter, stats: CacheStats): string {
  const percent = stats.totalInputTokens > 0
    ? (stats.cachedInputTokens / stats.totalInputTokens) * 100
    : 0;
  const writeText = adapter.showCacheWrite && stats.cacheWriteInputTokens > 0
    ? `·write ${formatTokenCount(stats.cacheWriteInputTokens)}`
    : "";

  return `${adapter.label} ${stats.hitRequests}/${stats.totalRequests}·${formatTokenCount(stats.cachedInputTokens)}/${formatTokenCount(stats.totalInputTokens)} ${percent.toFixed(1)}%${writeText}`;
}

export function prefixFooterStatus(statusText: string | undefined): string | undefined {
  if (!statusText || statusText.startsWith("· ")) return statusText;
  return `· ${statusText}`;
}

/**
 * Compute a hit-ratio percentage string for a value between 0 and 1.
 * Returns e.g. "75%", "0%", "100%", or "N/A" for zero total.
 */
export function formatHitRatio(hits: number, total: number): string {
  if (total <= 0) return "N/A";
  return `${Math.round((hits / total) * 100)}%`;
}

/**
 * Format a token-to-M abbreviation for stats output.
 * Example: 1500000 → "1.50M"
 */
export function formatTokenM(value: number): string {
  const millions = Math.max(0, Math.round(value)) / 1_000_000;
  if (millions === 0) return "0";
  if (millions < 0.01) return millions.toFixed(4);
  if (millions >= 10) return millions.toFixed(1);
  return millions.toFixed(2);
}

/**
 * Check if an assistant message's usage fields appear to be missing or empty.
 * Returns true when Pi-normalized fields (input, cacheRead, cacheWrite) are all
 * absent/zero AND raw usage fields (prompt_tokens, etc.) are also absent/zero
 * for the given adapter.
 */
export function hasMissingUsageFields(message: unknown, adapter: CacheProviderAdapter): boolean {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return true;

  // Check Pi-normalized fields
  const input = getNonNegativeNumber(usage, "input");
  const cacheRead = getNonNegativeNumber(usage, "cacheRead");
  const cacheWrite = getNonNegativeNumber(usage, "cacheWrite");

  // If Pi-normalized fields exist with non-zero values, usage is present
  if (cacheRead !== undefined || cacheWrite !== undefined || (input !== undefined && input > 0)) {
    return false;
  }

  // Check raw usage for the adapter's provider family
  const rawUsage = adapter.normalizeUsage(message);
  if (!rawUsage || (rawUsage.cacheRead === 0 && rawUsage.cacheWrite === 0 && rawUsage.totalInput === 0)) {
    return true;
  }

  return false;
}

/**
 * Build a summary string for the recent trend (last N samples).
 * Example: "Recent 10: 7/10 hits · 65% tok cached · no missing usage"
 */
export function formatRecentTrendSummary(samples: CacheUsageSample[], maxCount: number): string {
  const recent = samples.slice(-maxCount);
  if (recent.length === 0) return `Recent ${maxCount}: no samples yet`;

  const hits = recent.filter((s) => s.hit).length;
  const totalCached = recent.reduce((sum, s) => sum + s.cachedInputTokens, 0);
  const totalInput = recent.reduce((sum, s) => sum + s.totalInputTokens, 0);
  const missingCount = recent.filter((s) => s.missingUsageFields).length;

  const hitRatio = formatHitRatio(hits, recent.length);
  const tokenRatio = totalInput > 0 ? formatHitRatio(totalCached, totalInput) : "N/A";

  let result = `Recent ${recent.length}/${maxCount}: ${hits}/${recent.length} hits · ${tokenRatio} tok cached`;
  if (missingCount > 0) {
    result += ` · ${missingCount} missing usage`;
  }
  return result;
}

/**
 * Build the output for `/cache-optimizer stats`.
 */
export function formatCompactStats(stats: CacheStats): string {
  const percent = stats.totalInputTokens > 0
    ? (stats.cachedInputTokens / stats.totalInputTokens) * 100
    : 0;
  return `${stats.hitRequests}/${stats.totalRequests}·${formatTokenCount(stats.cachedInputTokens)}/${formatTokenCount(stats.totalInputTokens)} ${percent.toFixed(1)}%`;
}

export function modelFromStatsKey(key: string, ref?: PersistedRoutedModelRef): PiModel | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash >= key.length - 1) return undefined;
  return routedModelRefToPiModel(ref ?? { provider: key.slice(0, slash), id: key.slice(slash + 1) });
}

export function sortStatsEntries(entries: Array<[string, CacheStats]>, activeModelKey?: string): Array<[string, CacheStats]> {
  return entries.sort(([left], [right]) => {
    if (left === activeModelKey) return -1;
    if (right === activeModelKey) return 1;
    return left.localeCompare(right);
  });
}

export function buildSessionStatsOutput(
  sessionModels: Record<string, CacheStats>,
  activeModel?: PiModel,
  modelRefsByKey: Record<string, PersistedRoutedModelRef> = {},
): string {
  const activeKey = activeModel ? modelKey(activeModel) : undefined;
  const models = { ...sessionModels };
  if (activeModel && selectAdapterForModel(activeModel) && !models[activeKey!]) {
    models[activeKey!] = emptyCacheStats();
  }
  const entries = sortStatsEntries(Object.entries(models), activeKey);
  if (entries.length === 0) return "ℹ️ No cache statistics recorded for the current session today.";
  const lines = ["Scope: current session", `Day:   ${currentLocalDay()}`, `Models: ${entries.length}`];
  for (const [key, stats] of entries) {
    const model = modelFromStatsKey(key, modelRefsByKey[key]);
    const adapter = model ? selectAdapterForModel(model) : undefined;
    lines.push("", `── ${key} ──`, `Adapter: ${adapter?.label ?? "Unknown cache adapter"}`);
    lines.push(`Requests:      ${stats.hitRequests} hit / ${stats.totalRequests} total`);
    lines.push(`Cached tokens: ${formatTokenCount(stats.cachedInputTokens)} / ${formatTokenCount(stats.totalInputTokens)} input · ${stats.totalInputTokens > 0 ? `${((stats.cachedInputTokens / stats.totalInputTokens) * 100).toFixed(1)}%` : "0.0%"}`);
    lines.push(`Summary:       ${formatCompactStats(stats)}`);
    if (stats.cacheWriteInputTokens > 0) lines.push(`Cache write:   ${formatTokenCount(stats.cacheWriteInputTokens)}`);
  }
  return lines.join("\n");
}

export function buildAllStatsOutput(aggregate: ShardAggregate): string {
  const entries = sortStatsEntries(Object.entries(aggregate.totalsByModel));
  if (entries.length === 0) return "ℹ️ No local cache statistics recorded today.";
  const sessionCount = Object.keys(aggregate.instancesBySession).length;
  const instanceCount = Object.values(aggregate.instancesBySession).reduce((sum, value) => sum + value, 0);
  const lines = ["Scope: all local sessions", `Day:   ${currentLocalDay()}`, `Sessions: ${sessionCount}`, `Instances: ${instanceCount}`];
  for (const [key, stats] of entries) {
    const model = modelFromStatsKey(key, aggregate.modelRefsByKey[key]);
    const adapter = model ? selectAdapterForModel(model) : undefined;
    lines.push("", `── ${key} ──`, `Adapter: ${adapter?.label ?? "Unknown cache adapter"}`);
    lines.push(`Sessions: ${aggregate.sessionsByModel[key] ?? 0} · Instances: ${aggregate.instancesByModel[key] ?? 0}`);
    lines.push(`Requests:      ${stats.hitRequests} hit / ${stats.totalRequests} total`);
    lines.push(`Cached tokens: ${formatTokenCount(stats.cachedInputTokens)} / ${formatTokenCount(stats.totalInputTokens)} input · ${stats.totalInputTokens > 0 ? `${((stats.cachedInputTokens / stats.totalInputTokens) * 100).toFixed(1)}%` : "0.0%"}`);
    lines.push(`Summary:       ${formatCompactStats(stats)}`);
    if (stats.cacheWriteInputTokens > 0) lines.push(`Cache write:   ${formatTokenCount(stats.cacheWriteInputTokens)}`);
  }
  return lines.join("\n");
}

export function buildContributorsStatsOutput(aggregate: ShardAggregate, activeModel: PiModel | undefined, currentSessionHash?: string): string {
  if (!activeModel) return "ℹ️ No active model selected.";
  const key = modelKey(activeModel);
  const rows = Object.entries(aggregate.bySession)
    .filter(([, models]) => models[key])
    .sort(([left], [right]) => left === currentSessionHash ? -1 : right === currentSessionHash ? 1 : left.localeCompare(right));
  if (rows.length === 0) return `ℹ️ No contributors recorded for ${key} today.`;
  const lines = [`Model: ${key}`, "Scope: contributing local sessions today"];
  let otherIndex = 0;
  for (const [sessionHash, models] of rows) {
    const label = sessionHash === currentSessionHash ? "Current session" : `Other session ${++otherIndex}`;
    lines.push("", label, `  Instances: ${aggregate.instancesBySessionModel[sessionHash]?.[key] ?? 0}`, `  ${formatCompactStats(models[key])}`);
  }
  return lines.join("\n");
}

export function buildStatsOutput(model: PiModel | undefined, adapter: CacheProviderAdapter | undefined, stats: CacheStats | undefined, recentSamples: CacheUsageSample[]): string {
  const lines: string[] = [];

  if (!model || !adapter) {
    lines.push("ℹ️ No cache-adapter-matched model active. Select a model with a recognized provider family.");
    return lines.join("\n");
  }

  const key = modelKey(model);
  const currentStats = stats ?? emptyCacheStats();

  lines.push(`Model key: ${key}`);
  lines.push(`Adapter:   ${adapter.label}`);
  lines.push("");
  lines.push("── Today ──");
  lines.push(`Requests:      ${currentStats.hitRequests} hit / ${currentStats.totalRequests} total · ${formatHitRatio(currentStats.hitRequests, currentStats.totalRequests)}`);
  lines.push(`Cached tokens: ${formatTokenM(currentStats.cachedInputTokens)}M / ${formatTokenM(currentStats.totalInputTokens)}M input · ${currentStats.totalInputTokens > 0 ? `${Math.round((currentStats.cachedInputTokens / currentStats.totalInputTokens) * 100)}%` : "N/A"}`);
  if (currentStats.cacheWriteInputTokens > 0) {
    lines.push(`Cache write:   ${formatTokenM(currentStats.cacheWriteInputTokens)}M tok`);
  }

  lines.push("");
  lines.push("── Recent trend ──");
  lines.push(formatRecentTrendSummary(recentSamples, 10));
  lines.push(formatRecentTrendSummary(recentSamples, 30));

  // Check if any sample has missingUsageFields flagged
  const missingAny = recentSamples.some((s) => s.missingUsageFields);
  if (missingAny) {
    lines.push("");
    lines.push("⚠️ Some recent responses had missing or empty cache usage fields. Footer may under-report hits.");
    lines.push("   The proxy may not return prompt_cache_hit_tokens or usage.input/cacheRead in responses.");
  }

  return lines.join("\n");
}

export function deriveTotalsByModelFromSessionStats(statsByModel: Record<string, CacheStats>): Record<string, CacheStats> {
  const totals: Record<string, CacheStats> = {};
  for (const [fullKey, stats] of Object.entries(statsByModel)) {
    totals[modelKeyFromSessionKey(fullKey)] = mergeCacheStatsForTotal(
      totals[modelKeyFromSessionKey(fullKey)],
      stats,
    );
  }
  return totals;
}

export function parsePersistedTotalsByModel(value: unknown): Record<string, CacheStats> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const totals: Record<string, CacheStats> = {};
  for (const [modelKeyStr, rawStats] of Object.entries(record)) {
    const stats = parseCacheStats(rawStats);
    if (stats) totals[modelKeyStr] = stats;
  }
  return totals;
}

export function routedModelRefToPiModel(ref: PersistedRoutedModelRef): PiModel {
  return {
    id: ref.id,
    name: ref.name ?? ref.id,
    provider: ref.provider,
    api: "",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as PiModel;
}

export function selectFooterStatsForModel(
  mode: FooterStatsMode,
  sessionHash: string | undefined,
  statsByModel: Record<string, CacheStats>,
  totalsByModel: Record<string, CacheStats>,
  model: { provider: string; id: string },
  processByModel: Record<string, CacheStats> = {},
): CacheStats | undefined {
  if (mode === "total") return totalsByModel[modelKey(model)];
  if (mode === "process") return processByModel[modelKey(model)];
  if (!sessionHash) return undefined;
  return statsByModel[makeSessionModelKey(sessionHash, model.provider, model.id)];
}

export function parsePersistedCacheStats(value: unknown): CacheStatsState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  // version 4/5/6: session-scoped stats + legacy family fallback.
  // v5 additionally persists the last actual routed model per session so
  // router/auto can restore the exact upstream footer after /reload.
  // v6 adds provider/model totals used for footer continuity across Pi
  // process/terminal restarts, while retaining session buckets for migration
  // and best-effort preservation of older data.
  if (record.version === 4 || record.version === 5 || record.version === 6) {
    const legacyFamily: Partial<Record<CacheProviderId, CacheStats>> = {};
    const rawFamily = asRecord(record.legacyFamily);
    if (rawFamily) {
      for (const id of CACHE_PROVIDER_IDS) {
        const stats = parseCacheStats(rawFamily[id]);
        if (stats) legacyFamily[id] = stats;
      }
    }

    // Collect all session entries into statsByModel with session-hash-prefixed keys
    // (e.g. "abc123:otokapi/gpt-5.5") so that writePersistedCacheStats can later
    // reconstruct individual sessions from the flat key format and other sessions'
    // data is not silently lost on round-trip.
    const statsByModel: Record<string, CacheStats> = {};
    const rawSessions = asRecord(record.sessions);
    if (rawSessions) {
      for (const [sessionHash, modelMap] of Object.entries(rawSessions)) {
        const parsedMap = asRecord(modelMap);
        if (parsedMap) {
          for (const [modelKey, val] of Object.entries(parsedMap)) {
            const parsed = parseCacheStats(val);
            if (parsed) statsByModel[`${sessionHash}:${modelKey}`] = parsed;
          }
        }
      }
    }

    const lastRoutedModelBySession: Record<string, PersistedRoutedModelRef> = {};
    const rawLastRoutedModels = asRecord(record.lastRoutedModelBySession);
    if (rawLastRoutedModels) {
      for (const [sessionHash, rawModel] of Object.entries(rawLastRoutedModels)) {
        const parsed = parsePersistedRoutedModelRef(rawModel);
        if (parsed) lastRoutedModelBySession[sessionHash] = parsed;
      }
    }

    const parsedTotals = parsePersistedTotalsByModel(record.totalsByModel);
    const totalsByModel = parsedTotals ?? deriveTotalsByModelFromSessionStats(statsByModel);

    return { statsByModel, totalsByModel, legacyFamily, lastRoutedModelBySession };
  }

  // version 3: migrate to v4/v5 semantics by wrapping statsByModel into sessions
  if (record.version === 3) {
    const statsByModel: Record<string, CacheStats> = {};
    const rawModelMap = asRecord(record.statsByModel);
    if (rawModelMap) {
      for (const [key, val] of Object.entries(rawModelMap)) {
        const parsed = parseCacheStats(val);
        if (parsed) statsByModel[key] = parsed;
      }
    }

    const legacyFamily: Partial<Record<CacheProviderId, CacheStats>> = {};
    const rawFamily = asRecord(record.legacyFamily);
    if (rawFamily) {
      for (const id of CACHE_PROVIDER_IDS) {
        const stats = parseCacheStats(rawFamily[id]);
        if (stats) legacyFamily[id] = stats;
      }
    }

    return { statsByModel, totalsByModel: deriveTotalsByModelFromSessionStats(statsByModel), legacyFamily };
  }

  // version 2: migrate statsByProvider into legacyFamily
  if (record.version === 2) {
    const statsByProvider = asRecord(record.statsByProvider);
    const legacyFamily: Partial<Record<CacheProviderId, CacheStats>> = {};
    if (statsByProvider) {
      for (const id of CACHE_PROVIDER_IDS) {
        const stats = parseCacheStats(statsByProvider[id]);
        if (stats) legacyFamily[id] = stats;
      }
    }
    return { statsByModel: {}, totalsByModel: {}, legacyFamily };
  }

  // version 1: single DeepSeek stats -> migrate to legacyFamily.deepseek
  if (record.version === 1) {
    const migrated = parseCacheStats(record.stats);
    return migrated ? { statsByModel: {}, totalsByModel: {}, legacyFamily: { deepseek: migrated } } : undefined;
  }

  return undefined;
}

export async function readPersistedCacheStats(): Promise<CacheStatsState | undefined> {
  try {
    const raw = await readFile(STATE_FILE_PATH, "utf8");
    return parsePersistedCacheStats(JSON.parse(raw));
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.warn(`${LOG_PREFIX}: failed to read persisted cache stats`, error);
      return undefined;
    }
  }

  // New path missing: try one-shot migration from the old (pre-rename) path.
  try {
    const raw = await readFile(LEGACY_STATE_FILE_PATH, "utf8");
    const parsed = parsePersistedCacheStats(JSON.parse(raw));
    if (parsed) {
      try {
        await writePersistedCacheStats(parsed);
        // Best-effort delete; if the unlink fails the new path is still authoritative.
        try {
          await unlink(LEGACY_STATE_FILE_PATH);
        } catch (unlinkError) {
          if (getErrorCode(unlinkError) !== "ENOENT") {
            console.warn(`${LOG_PREFIX}: failed to remove legacy stats file`, unlinkError);
          }
        }
      } catch (writeError) {
        console.warn(`${LOG_PREFIX}: failed to migrate legacy cache stats`, writeError);
      }
      return parsed;
    }
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.warn(`${LOG_PREFIX}: failed to read legacy cache stats`, error);
    }
  }

  return undefined;
}

export function filterRestorableStatsForSession(
  persisted: CacheStatsState | undefined,
  currentSessionHash?: string,
): Record<string, CacheStats> {
  if (!persisted || !currentSessionHash) return {};

  const prefix = `${currentSessionHash}:`;
  const filteredModelStats: Record<string, CacheStats> = {};
  for (const [fullKey, stats] of Object.entries(persisted.statsByModel)) {
    if (fullKey.startsWith(prefix)) {
      filteredModelStats[fullKey] = stats;
    } else if (!fullKey.includes(":")) {
      // Legacy v3-style key without session hash — migrate to current session.
      filteredModelStats[`${currentSessionHash}:${fullKey}`] = stats;
    } else if (fullKey.startsWith("_nosession:")) {
      // Transitional _nosession bucket — migrate to current session.
      filteredModelStats[`${currentSessionHash}:${fullKey.slice("_nosession:".length)}`] = stats;
    }
  }

  return filteredModelStats;
}

/**
 * The closure-internal writer. Since the closure has access to currentSessionHash,
 * it passes the hash and statsByModel here. This function wraps them in the v4
 * sessions format, combining with any previously-persisted sessions for safety.
 *
 * When called from the closure, `state.statsByModel` contains only the current
 * session's entries (keyed by `${sessionHash}:${provider}/${id}`). We extract
 * the model-key-only entries and store them under the session hash.
 */
/**
 * Merge in-memory stats state into an existing sessions map for persistence.
 *
 * When `currentSessionHash` is provided (explicit hash mode):
 *   - Current-session entries are extracted from `state.statsByModel` (keys
 *     prefixed with `currentSessionHash:`) and written under the session hash.
 *   - The transitional legacy `_nosession` bucket is DELETED — its entries
 *     were already consumed and migrated into memory by `restoreCacheStats`.
 *     Keeping `_nosession` on disk would allow resurrection of reset stats
 *     on the next reload (the reset-undo bug).
 *   - Other real session hashes are preserved intact.
 *
 * When `currentSessionHash` is undefined (no-hash mode):
 *   - Keys with a hash prefix (`hash:provider/model`) are grouped under their
 *     respective session hashes.
 *   - Keys without a hash prefix (legacy v3) are grouped under `_nosession` so
 *     `restoreCacheStats` can migrate them on the next load before the session
 *     id is known.
 *
 * Historical v1-v6 pure helper (no runtime I/O). Permanent migration tests
 * exercise it directly; v7 startup never reads or writes the obsolete file.
 */
export function mergeCacheSessions(
  existingSessions: Record<string, Record<string, CacheStats>>,
  state: CacheStatsState,
  currentSessionHash?: string,
): Record<string, Record<string, CacheStats>> {
  // Deep-copy to avoid mutating the caller's object.
  const sessions: Record<string, Record<string, CacheStats>> = {};
  for (const [hash, models] of Object.entries(existingSessions)) {
    sessions[hash] = { ...models };
  }

  if (currentSessionHash !== undefined) {
    // Explicit hash mode: extract this session's data from state.statsByModel.
    // When the session has no entries (e.g. after reset of sole bucket), this
    // still sets an empty map, ensuring the deleted bucket does not return.
    const prefix = `${currentSessionHash}:`;
    const currentModelStats: Record<string, CacheStats> = {};
    for (const [fullKey, stats] of Object.entries(state.statsByModel)) {
      if (fullKey.startsWith(prefix)) {
        currentModelStats[fullKey.slice(prefix.length)] = stats;
      }
    }
    sessions[currentSessionHash] = currentModelStats;

    // _nosession is a transitional legacy migration bucket — once we write
    // under an authoritative session hash, those entries have already been
    // consumed and migrated into memory by restoreCacheStats. Delete to
    // prevent resurrection of reset stats on the next reload.
    delete sessions["_nosession"];
  } else {
    // No-hash mode: group entries by their existing hash prefix to avoid
    // collapsing multiple sessions into one bucket. Keys without a hash
    // prefix (legacy v3) go under "_nosession" so restoreCacheStats can
    // migrate them to the current session on next load.
    const nosessionMap: Record<string, CacheStats> = {};
    for (const [fullKey, stats] of Object.entries(state.statsByModel)) {
      const idx = fullKey.indexOf(":");
      if (idx >= 0) {
        const hash = fullKey.slice(0, idx);
        const modelKey = fullKey.slice(idx + 1);
        if (!sessions[hash]) sessions[hash] = {};
        sessions[hash][modelKey] = stats;
      } else {
        // Key without hash prefix (legacy v3) — group under _nosession.
        nosessionMap[fullKey] = stats;
      }
    }
    if (Object.keys(nosessionMap).length > 0) {
      sessions["_nosession"] = nosessionMap;
    }
  }

  return sessions;
}

export function mergeCacheTotals(
  existingTotalsByModel: Record<string, CacheStats>,
  stateTotalsByModel: Record<string, CacheStats>,
  options: { deleteModelKeys?: string[]; replaceTotals?: boolean } = {},
): Record<string, CacheStats> {
  const totals = options.replaceTotals
    ? { ...stateTotalsByModel }
    : { ...existingTotalsByModel, ...stateTotalsByModel };
  for (const key of options.deleteModelKeys ?? []) {
    delete totals[key];
  }
  return totals;
}

export function mergeLastRoutedModels(
  existingLastRoutedModelBySession: Record<string, PersistedRoutedModelRef>,
  state: CacheStatsState,
  currentSessionHash?: string,
): Record<string, PersistedRoutedModelRef> {
  const merged: Record<string, PersistedRoutedModelRef> = { ...existingLastRoutedModelBySession };
  const incoming = state.lastRoutedModelBySession ?? {};

  if (currentSessionHash !== undefined) {
    const current = incoming[currentSessionHash];
    if (current) {
      merged[currentSessionHash] = current;
    } else {
      // Explicit deletion: when incoming state has no entry for current session,
      // remove any existing stale entry to reflect intentional reset.
      delete merged[currentSessionHash];
    }
    return merged;
  }

  for (const [sessionHash, ref] of Object.entries(incoming)) {
    merged[sessionHash] = ref;
  }
  return merged;
}

export async function writePersistedCacheStats(
  state: CacheStatsState,
  currentSessionHash?: string,
  options: { deleteModelKeys?: string[]; replaceTotals?: boolean } = {},
): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });

  // Read existing file to preserve other sessions' data.
  let existingSessions: Record<string, Record<string, CacheStats>> = {};
  let existingTotalsByModel: Record<string, CacheStats> = {};
  let existingLastRoutedModelBySession: Record<string, PersistedRoutedModelRef> = {};
  try {
    const raw = await readFile(STATE_FILE_PATH, "utf8");
    const parsed = parsePersistedCacheStats(JSON.parse(raw));
    if (parsed) {
      // Reconstruct sessions from statsByModel keys.
      // Each key has form `${hash}:${provider}/${id}`; group by hash.
      for (const [fullKey, stats] of Object.entries(parsed.statsByModel)) {
        const idx = fullKey.indexOf(":");
        if (idx >= 0) {
          const hash = fullKey.slice(0, idx);
          const modelKey = fullKey.slice(idx + 1);
          if (!existingSessions[hash]) existingSessions[hash] = {};
          existingSessions[hash][modelKey] = stats;
        }
      }
      existingTotalsByModel = { ...(parsed.totalsByModel ?? {}) };
      existingLastRoutedModelBySession = { ...(parsed.lastRoutedModelBySession ?? {}) };
    }
  } catch {
    // Ignore read errors (file may not exist yet).
  }

  const sessions = mergeCacheSessions(existingSessions, state, currentSessionHash);
  const totalsByModel = mergeCacheTotals(existingTotalsByModel, state.totalsByModel, options);
  const lastRoutedModelBySession = mergeLastRoutedModels(
    existingLastRoutedModelBySession,
    state,
    currentSessionHash,
  );

  const payload: PersistedCacheStatsV6 = {
    version: 6,
    sessions,
    totalsByModel,
    legacyFamily: state.legacyFamily,
    ...(Object.keys(lastRoutedModelBySession).length > 0 ? { lastRoutedModelBySession } : {}),
  };
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, STATE_FILE_PATH);
}

/** Maximum number of recent samples kept per model key (in-memory only, not persisted). */
export const MAX_RECENT_SAMPLES = 50;

export function keyForModelExt(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * For direct (non-virtual-routing) providers, the upstream API may normalize or
 * rename the model id echoed in its response (e.g. a request to
 * `zai-org/GLM-5.2-FP8` returns a message whose `model` field is
 * `GLM5.2-FP8`). Writing stats under the echoed name fragments the bucket
 * away from the active-model key the footer reads (`totalsByModel[ctx.model]`),
 * so the footer shows 0% even when the backend is hitting cache.
 *
 * When the response-derived statsModel differs from the active context model
 * only in name (same provider + same cache adapter), consolidate stats back to
 * the active model identity. Virtual routing providers are excluded — their
 * message-local metadata is authoritative for router correctness (spec:
 * `message_end` MUST prefer assistant message metadata).
 *
 * Never merges across providers or across adapters, so genuinely different
 * models are never combined.
 */
export function consolidateDirectProviderStatsModel(
  statsModel: PiModel | undefined,
  ctxModel: PiModel | undefined,
  ctx?: Pick<ExtensionContext, "sessionManager">,
): PiModel | undefined {
  if (!statsModel || !ctxModel) return statsModel;
  // Virtual routing providers keep message-local stats identity.
  if (isVirtualRoutingModel(ctxModel, ctx)) return statsModel;
  // Only consolidate within the same provider.
  if (statsModel.provider !== ctxModel.provider) return statsModel;
  // Only consolidate when both resolve to the same cache adapter object, so
  // genuinely different models sharing a provider (or sharing the same adapter
  // family id, e.g. GPT and GLM both report family id "openai") are never
  // merged. `selectAdapterForModel` returns the precise adapter object, so
  // object identity is the correct criterion.
  const statsAdapter = selectAdapterForModel(statsModel);
  const ctxAdapter = selectAdapterForModel(ctxModel);
  if (!statsAdapter || !ctxAdapter || statsAdapter !== ctxAdapter) return statsModel;
  // No drift — nothing to consolidate.
  if (statsModel.id === ctxModel.id) return statsModel;
  // Consolidate: pin stats to the active-model identity the footer reads.
  return {
    ...statsModel,
    id: ctxModel.id,
    name: ctxModel.name || ctxModel.id,
  };
}

export function buildExactRouterStatusEntry(
  sessionHash: string | undefined,
  statsByModel: Record<string, CacheStats>,
  lastRoutedModel: PersistedRoutedModelRef | undefined,
  totalsByModel: Record<string, CacheStats> = {},
  mode: FooterStatsMode = "total",
  processByModel: Record<string, CacheStats> = {},
): { model: PiModel; adapter: CacheProviderAdapter; stats: CacheStats } | undefined {
  if (!sessionHash || !lastRoutedModel) return undefined;

  const model = routedModelRefToPiModel(lastRoutedModel);
  const adapter = selectAdapterForModel(model);
  if (!adapter) return undefined;

  return {
    model,
    adapter,
    stats: selectFooterStatsForModel(mode, sessionHash, statsByModel, totalsByModel, model, processByModel) ?? emptyCacheStats(),
  };
}

export function findBestRouterModelStats(
  mode: FooterStatsMode,
  sessionHash: string | undefined,
  statsByModel: Record<string, CacheStats>,
  totalsByModel: Record<string, CacheStats>,
  processByModel: Record<string, CacheStats> = {},
): { model: PiModel; adapter: CacheProviderAdapter; stats: CacheStats } | undefined {
  const entries = mode === "total"
    ? Object.entries(totalsByModel)
    : mode === "process"
      ? Object.entries(processByModel)
    : sessionHash
      ? Object.entries(statsByModel)
        .filter(([key]) => key.startsWith(`${sessionHash}:`))
        .map(([key, stats]) => [key.slice(sessionHash.length + 1), stats] as const)
      : [];
  let best: { model: PiModel; adapter: CacheProviderAdapter; stats: CacheStats; total: number } | undefined;

  for (const [modelKeyPart, stats] of entries) {
    const slashIdx = modelKeyPart.indexOf("/");
    if (slashIdx < 1 || slashIdx >= modelKeyPart.length - 1) continue;
    const model = routedModelRefToPiModel({
      provider: modelKeyPart.slice(0, slashIdx),
      id: modelKeyPart.slice(slashIdx + 1),
    });
    const adapter = selectAdapterForModel(model);
    if (!adapter) continue;
    if (!best || stats.totalRequests > best.total) {
      best = { model, adapter, stats, total: stats.totalRequests };
    }
  }

  return best ? { model: best.model, adapter: best.adapter, stats: best.stats } : undefined;
}

export function createSerializedAsyncRunner(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
}
