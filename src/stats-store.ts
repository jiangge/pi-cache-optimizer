import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LOG_PREFIX, asRecord, getErrorCode, getNonNegativeNumber, isNonEmptyString, isProcessAlive } from "./common.ts";
import { STATE_DIR } from "./paths.ts";

export type CacheProviderId = "deepseek" | "openai" | "claude" | "gemini";

export const STATE_FILE_PATH = join(STATE_DIR, "pi-cache-optimizer-stats.json");

export const LEGACY_STATE_FILE_PATH = join(STATE_DIR, "deepseek-cache-optimizer-stats.json");

export const SHARD_STATE_DIR = join(STATE_DIR, "pi-cache-optimizer-stats.d");

export const SHARD_FILES_DIR = join(SHARD_STATE_DIR, "shards");

export const SHARD_EPOCH_DIR = join(SHARD_STATE_DIR, "epochs");

export const SHARD_MODEL_EPOCH_DIR = join(SHARD_EPOCH_DIR, "models");

export const SHARD_MAINTENANCE_DIR = join(SHARD_STATE_DIR, "maintenance");

export const SHARD_GLOBAL_EPOCH_PATH = join(SHARD_EPOCH_DIR, "global.json");

export const SHARD_CLEANUP_LOCK_PATH = join(SHARD_MAINTENANCE_DIR, "cleanup.lock");

export const SHARD_CLEANUP_MARKER_PATH = join(SHARD_MAINTENANCE_DIR, "last-cleanup");

// Retain closed and inactive shards for roughly two months so session-scoped
// statistics can survive long-running conversations without meaningful disk use.
export const SHARD_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

export const SHARD_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;

export const SHARD_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const SHARD_CLEANUP_LOCK_STALE_MS = 60 * 60 * 1000;

export const CACHE_PROVIDER_IDS: CacheProviderId[] = ["deepseek", "openai", "claude", "gemini"];

export type CacheStats = {
  day: string;
  totalRequests: number;
  hitRequests: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
};

/** Per-model-key scoped state. Used in memory and for v3 persistence. */
export type PersistedRoutedModelRef = {
  provider: string;
  id: string;
  name?: string;
};

export type UsageSnapshot = {
  cacheRead: number;
  cacheWrite: number;
  totalInput: number;
};

/**
 * Per-request sample stored for trend analysis and usage-field-missing detection.
 * Contains only numeric counters and booleans — never message content, prompts,
 * payloads, headers, API keys, or model outputs.
 */
export type PersistedStatsShardV7 = {
  version: 7;
  kind: "pi-cache-optimizer-shard";
  instanceId: string;
  sessionHash: string;
  process: {
    pid: number;
    ppid: number;
    instanceStartedAt: number;
  };
  lifecycle: {
    state: "active" | "closed";
    createdAt: number;
    updatedAt: number;
    closedAt?: number;
  };
  day: string;
  globalEpoch: string;
  models: Record<string, {
    modelEpoch: string;
    provider: string;
    modelId: string;
    modelName?: string;
    api?: string;
    stats: CacheStats;
  }>;
  lastRoutedModel?: PersistedRoutedModelRef;
};

export type ShardAggregate = {
  bySession: Record<string, Record<string, CacheStats>>;
  totalsByModel: Record<string, CacheStats>;
  instancesBySession: Record<string, number>;
  instancesBySessionModel: Record<string, Record<string, number>>;
  sessionsByModel: Record<string, number>;
  instancesByModel: Record<string, number>;
  modelRefsByKey: Record<string, PersistedRoutedModelRef>;
  lastRoutedModelBySession: Record<string, PersistedRoutedModelRef>;
};

export function currentLocalDay(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function emptyCacheStats(day = currentLocalDay()): CacheStats {
  return {
    day,
    totalRequests: 0,
    hitRequests: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalInputTokens: 0,
  };
}

export function emptyAllCacheStats(day = currentLocalDay()): Partial<Record<CacheProviderId, CacheStats>> {
  return Object.fromEntries(CACHE_PROVIDER_IDS.map((id) => [id, emptyCacheStats(day)])) as Partial<Record<CacheProviderId, CacheStats>>;
}

export function addUsageToCacheStats(stats: CacheStats, usage: UsageSnapshot): void {
  stats.totalRequests += 1;
  if (usage.cacheRead > 0) stats.hitRequests += 1;
  stats.cachedInputTokens += usage.cacheRead;
  stats.cacheWriteInputTokens += usage.cacheWrite;
  stats.totalInputTokens += usage.totalInput;
}

export function parseCacheStats(value: unknown): CacheStats | undefined {
  const stats = asRecord(value);
  if (!stats || typeof stats.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stats.day)) {
    return undefined;
  }

  const totalRequests = getNonNegativeNumber(stats, "totalRequests");
  const hitRequests = getNonNegativeNumber(stats, "hitRequests");
  const cachedInputTokens = getNonNegativeNumber(stats, "cachedInputTokens");
  const cacheWriteInputTokens = getNonNegativeNumber(stats, "cacheWriteInputTokens") ?? 0;
  const totalInputTokens = getNonNegativeNumber(stats, "totalInputTokens");

  if (
    totalRequests === undefined ||
    hitRequests === undefined ||
    cachedInputTokens === undefined ||
    totalInputTokens === undefined ||
    hitRequests > totalRequests ||
    cachedInputTokens > totalInputTokens ||
    cacheWriteInputTokens > totalInputTokens
  ) {
    return undefined;
  }

  return {
    day: stats.day,
    totalRequests,
    hitRequests,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalInputTokens,
  };
}

export function cloneCacheStats(stats: CacheStats): CacheStats {
  return { ...stats };
}

export function addCacheStatsTotals(target: CacheStats, source: CacheStats): void {
  target.totalRequests += source.totalRequests;
  target.hitRequests += source.hitRequests;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheWriteInputTokens += source.cacheWriteInputTokens;
  target.totalInputTokens += source.totalInputTokens;
}

export function mergeCacheStatsForTotal(existing: CacheStats | undefined, incoming: CacheStats): CacheStats {
  if (!existing) return cloneCacheStats(incoming);
  if (incoming.day > existing.day) return cloneCacheStats(incoming);
  if (incoming.day < existing.day) return existing;
  addCacheStatsTotals(existing, incoming);
  return existing;
}

/** Merge counters while retaining historical days for an explicitly session-scoped view. */
export function mergeStatsAcrossDays(existing: CacheStats | undefined, incoming: CacheStats, day: string | null): CacheStats {
  if (day !== null) return mergeCacheStatsForTotal(existing, incoming);
  if (!existing) return cloneCacheStats(incoming);
  addCacheStatsTotals(existing, incoming);
  existing.day = incoming.day > existing.day ? incoming.day : existing.day;
  return existing;
}

export function parsePersistedRoutedModelRef(value: unknown): PersistedRoutedModelRef | undefined {
  const record = asRecord(value);
  const provider = record?.provider;
  const id = record?.id;
  const name = record?.name;
  if (!isNonEmptyString(provider) || !isNonEmptyString(id)) return undefined;

  return {
    provider: provider.trim(),
    id: id.trim(),
    name: isNonEmptyString(name) ? name.trim() : id.trim(),
  };
}

export function modelEpochPath(modelKeyValue: string): string {
  return join(SHARD_MODEL_EPOCH_DIR, `${createHash("sha256").update(modelKeyValue).digest("hex")}.json`);
}

export function initialEpoch(scope: string): string {
  return `initial:${scope}`;
}

export function parseEpochRecord(value: unknown): string | undefined {
  const record = asRecord(value);
  return record?.version === 1 && isNonEmptyString(record.epoch) ? record.epoch.trim() : undefined;
}

export async function readEpochFile(path: string, fallback: string): Promise<string> {
  try {
    return parseEpochRecord(JSON.parse(await readFile(path, "utf8"))) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function readGlobalStatsEpoch(): Promise<string> {
  return readEpochFile(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global"));
}

export async function readModelStatsEpoch(modelKeyValue: string): Promise<string> {
  return readEpochFile(modelEpochPath(modelKeyValue), initialEpoch(`model:${modelKeyValue}`));
}

export async function writeStatsEpoch(path: string, epoch: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify({ version: 1, epoch, createdAt: Date.now() }, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

export async function advanceGlobalStatsEpoch(): Promise<string> {
  const epoch = `${Date.now()}-${randomUUID()}`;
  await writeStatsEpoch(SHARD_GLOBAL_EPOCH_PATH, epoch);
  return epoch;
}

export async function advanceModelStatsEpoch(modelKeyValue: string): Promise<string> {
  const epoch = `${Date.now()}-${randomUUID()}`;
  await writeStatsEpoch(modelEpochPath(modelKeyValue), epoch);
  return epoch;
}

export function parsePersistedStatsShardV7(value: unknown): PersistedStatsShardV7 | undefined {
  const record = asRecord(value);
  const processRecord = asRecord(record?.process);
  const lifecycle = asRecord(record?.lifecycle);
  const rawModels = asRecord(record?.models);
  if (
    record?.version !== 7 ||
    record.kind !== "pi-cache-optimizer-shard" ||
    !isNonEmptyString(record.instanceId) ||
    !isNonEmptyString(record.sessionHash) ||
    !processRecord ||
    !Number.isInteger(processRecord.pid) ||
    !Number.isInteger(processRecord.ppid) ||
    typeof processRecord.instanceStartedAt !== "number" ||
    !lifecycle ||
    (lifecycle.state !== "active" && lifecycle.state !== "closed") ||
    typeof lifecycle.createdAt !== "number" ||
    typeof lifecycle.updatedAt !== "number" ||
    !isNonEmptyString(record.day) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(record.day) ||
    !isNonEmptyString(record.globalEpoch) ||
    !rawModels
  ) return undefined;

  const models: PersistedStatsShardV7["models"] = {};
  for (const [key, rawEntry] of Object.entries(rawModels)) {
    const entry = asRecord(rawEntry);
    const stats = parseCacheStats(entry?.stats);
    if (
      !entry || !stats || !isNonEmptyString(entry.modelEpoch) ||
      !isNonEmptyString(entry.provider) || !isNonEmptyString(entry.modelId) ||
      key !== `${entry.provider.trim()}/${entry.modelId.trim()}`
    ) continue;
    models[key] = {
      modelEpoch: entry.modelEpoch.trim(),
      provider: entry.provider.trim(),
      modelId: entry.modelId.trim(),
      ...(isNonEmptyString(entry.modelName) ? { modelName: entry.modelName.trim() } : {}),
      ...(isNonEmptyString(entry.api) ? { api: entry.api.trim() } : {}),
      stats,
    };
  }

  const lastRoutedModel = parsePersistedRoutedModelRef(record.lastRoutedModel);
  return {
    version: 7,
    kind: "pi-cache-optimizer-shard",
    instanceId: record.instanceId.trim(),
    sessionHash: record.sessionHash.trim(),
    process: {
      pid: Number(processRecord.pid),
      ppid: Number(processRecord.ppid),
      instanceStartedAt: processRecord.instanceStartedAt,
    },
    lifecycle: {
      state: lifecycle.state,
      createdAt: lifecycle.createdAt,
      updatedAt: lifecycle.updatedAt,
      ...(typeof lifecycle.closedAt === "number" ? { closedAt: lifecycle.closedAt } : {}),
    },
    day: record.day,
    globalEpoch: record.globalEpoch.trim(),
    models,
    ...(lastRoutedModel ? { lastRoutedModel } : {}),
  };
}

export async function writeStatsShardV7(path: string, shard: PersistedStatsShardV7): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(shard, null, 2) + "\n", "utf8");
    await rename(tempPath, path);
  } catch (error) {
    // Do not leave an orphaned temp file behind until the next cleanup pass.
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

type CachedShardRead = {
  ino: number | bigint;
  size: number;
  mtimeMs: number;
  shard: PersistedStatsShardV7 | undefined;
};

/**
 * Parsed-shard cache keyed by path and validated by inode, size, and mtime.
 * Writers always publish through temp-file + rename, so an updated shard gets
 * a new inode; unchanged shards are not re-read or re-parsed on every refresh.
 */
const shardReadCache = new Map<string, CachedShardRead>();

export function clearStatsShardReadCache(): void {
  shardReadCache.clear();
}

function cloneShard(shard: PersistedStatsShardV7): PersistedStatsShardV7 {
  return structuredClone(shard);
}

export async function readValidStatsShardsV7(directory: string = SHARD_FILES_DIR): Promise<PersistedStatsShardV7[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  const shards: PersistedStatsShardV7[] = [];
  const seenPaths = new Set<string>();
  for (const name of names) {
    if (!/^[0-9a-f-]+\.json$/i.test(name)) continue;
    const path = join(directory, name);
    seenPaths.add(path);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        shardReadCache.delete(path);
        continue;
      }
      const cached = shardReadCache.get(path);
      let parsed: PersistedStatsShardV7 | undefined;
      if (cached && cached.ino === info.ino && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        parsed = cached.shard;
      } else {
        const filenameInstanceId = name.slice(0, -".json".length);
        const candidate = parsePersistedStatsShardV7(JSON.parse(await readFile(path, "utf8")));
        parsed = candidate && candidate.instanceId === filenameInstanceId ? candidate : undefined;
        shardReadCache.set(path, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, shard: parsed });
      }
      // Callers may mutate the aggregate they build; hand out copies so the
      // cache stays authoritative.
      if (parsed) shards.push(cloneShard(parsed));
    } catch {
      // Ignore malformed or transiently unavailable shards. Atomic writers will
      // publish a complete replacement on the next successful update.
      shardReadCache.delete(path);
    }
  }
  for (const path of Array.from(shardReadCache.keys())) {
    if (!seenPaths.has(path) && path.startsWith(directory)) shardReadCache.delete(path);
  }
  return shards;
}

export async function aggregateStatsShardsV7(
  shards: PersistedStatsShardV7[],
  day: string | null = currentLocalDay(),
): Promise<ShardAggregate> {
  const globalEpoch = await readGlobalStatsEpoch();
  const modelEpochs = new Map<string, string>();
  const result: ShardAggregate = {
    bySession: {},
    totalsByModel: {},
    instancesBySession: {},
    instancesBySessionModel: {},
    sessionsByModel: {},
    instancesByModel: {},
    modelRefsByKey: {},
    lastRoutedModelBySession: {},
  };
  const routedUpdatedAt = new Map<string, number>();
  const modelRefUpdatedAt = new Map<string, number>();
  const modelSessions = new Map<string, Set<string>>();

  for (const shard of shards) {
    if ((day !== null && shard.day !== day) || shard.globalEpoch !== globalEpoch) continue;
    let contributed = false;
    if (shard.lastRoutedModel && (routedUpdatedAt.get(shard.sessionHash) ?? -1) < shard.lifecycle.updatedAt) {
      routedUpdatedAt.set(shard.sessionHash, shard.lifecycle.updatedAt);
      result.lastRoutedModelBySession[shard.sessionHash] = shard.lastRoutedModel;
    }
    for (const [key, entry] of Object.entries(shard.models)) {
      let epoch = modelEpochs.get(key);
      if (!epoch) {
        epoch = await readModelStatsEpoch(key);
        modelEpochs.set(key, epoch);
      }
      if (entry.modelEpoch !== epoch || (day !== null && entry.stats.day !== day)) continue;
      contributed = true;
      const sessionModels = result.bySession[shard.sessionHash] ??= {};
      sessionModels[key] = mergeStatsAcrossDays(sessionModels[key], entry.stats, day);
      result.totalsByModel[key] = mergeStatsAcrossDays(result.totalsByModel[key], entry.stats, day);
      result.instancesByModel[key] = (result.instancesByModel[key] ?? 0) + 1;
      if ((modelRefUpdatedAt.get(key) ?? -1) < shard.lifecycle.updatedAt) {
        modelRefUpdatedAt.set(key, shard.lifecycle.updatedAt);
        result.modelRefsByKey[key] = {
          provider: entry.provider,
          id: entry.modelId,
          name: entry.modelName ?? entry.modelId,
        };
      }
      const sessionInstances = result.instancesBySessionModel[shard.sessionHash] ??= {};
      sessionInstances[key] = (sessionInstances[key] ?? 0) + 1;
      const sessions = modelSessions.get(key) ?? new Set<string>();
      sessions.add(shard.sessionHash);
      modelSessions.set(key, sessions);
    }
    if (contributed) {
      result.instancesBySession[shard.sessionHash] = (result.instancesBySession[shard.sessionHash] ?? 0) + 1;
    }
  }
  for (const [key, sessions] of modelSessions) result.sessionsByModel[key] = sessions.size;
  return result;
}

export async function loadStatsShardAggregateV7(directory: string = SHARD_FILES_DIR): Promise<ShardAggregate> {
  return aggregateStatsShardsV7(await readValidStatsShardsV7(directory));
}

export async function removeLegacyStatsFiles(): Promise<void> {
  for (const path of [STATE_FILE_PATH, LEGACY_STATE_FILE_PATH]) {
    try {
      await unlink(path);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to remove obsolete stats file ${path}`, error);
    }
  }
}

export async function cleanupStatsShardsV7(now = Date.now(), directory: string = SHARD_FILES_DIR): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    return getErrorCode(error) === "ENOENT" ? 0 : Promise.reject(error);
  }
  const today = currentLocalDay();
  let removed = 0;
  for (const name of names) {
    const isShard = /^[0-9a-f-]+\.json$/i.test(name);
    const isTemp = name.endsWith(".tmp");
    if (!isShard && !isTemp) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (isTemp) {
        if (now - info.mtimeMs < SHARD_TEMP_RETENTION_MS) continue;
      } else {
        const text = await readFile(path, "utf8");
        let parsed: PersistedStatsShardV7 | undefined;
        try {
          parsed = parsePersistedStatsShardV7(JSON.parse(text));
        } catch {
          // A corrupt JSON shard has no usable lifecycle metadata. Apply the
          // same mtime retention as schema-invalid shards instead of keeping
          // it forever; read failures still leave the file untouched.
        }
        if (parsed?.day === today) continue;
        const updatedAt = parsed?.lifecycle.updatedAt ?? info.mtimeMs;
        if (now - updatedAt < SHARD_RETENTION_MS) continue;
        if (parsed?.lifecycle.state === "active" && isProcessAlive(parsed.process.pid)) continue;
      }
      await unlink(path);
      removed += 1;
    } catch {
      // Best-effort maintenance must never block the extension.
    }
  }
  return removed;
}

export async function maybeCleanupStatsShardsV7(now = Date.now()): Promise<void> {
  await mkdir(SHARD_MAINTENANCE_DIR, { recursive: true });
  try {
    const marker = await stat(SHARD_CLEANUP_MARKER_PATH);
    if (now - marker.mtimeMs < SHARD_CLEANUP_INTERVAL_MS) return;
  } catch {}

  try {
    await mkdir(SHARD_CLEANUP_LOCK_PATH);
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") return;
    try {
      const lock = await stat(SHARD_CLEANUP_LOCK_PATH);
      if (now - lock.mtimeMs <= SHARD_CLEANUP_LOCK_STALE_MS) return;
      await rm(SHARD_CLEANUP_LOCK_PATH, { recursive: true, force: true });
      await mkdir(SHARD_CLEANUP_LOCK_PATH);
    } catch {
      return;
    }
  }

  try {
    await cleanupStatsShardsV7(now);
    const tempPath = `${SHARD_CLEANUP_MARKER_PATH}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${now}\n`, "utf8");
    await rename(tempPath, SHARD_CLEANUP_MARKER_PATH);
  } finally {
    await rm(SHARD_CLEANUP_LOCK_PATH, { recursive: true, force: true });
  }
}
