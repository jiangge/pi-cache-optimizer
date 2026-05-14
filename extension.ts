import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * DeepSeek KV Cache Optimizer
 *
 * What it does:
 * 1. Reorders Pi's system prompt so stable content is sent before dynamic context.
 * 2. Sets PI_CACHE_RETENTION=long at extension load time.
 * 3. Warns once per DeepSeek-like provider/model when cache-related compat flags are missing.
 * 4. Shows lightweight persisted DeepSeek cache hit/token stats in Pi's footer.
 *
 * DeepSeek prompt/KV cache is provider-side, automatic, and best-effort. This extension
 * improves the odds of cache hits; it cannot guarantee hits, especially through proxies.
 */

// ============================================================
// Automatically request long prompt-cache retention when Pi supports it.
// ============================================================
if (!process.env.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION !== "long") {
  process.env.PI_CACHE_RETENTION = "long";
}

type PiModel = NonNullable<ExtensionContext["model"]>;
type UnknownRecord = Record<string, unknown>;

const STATUS_KEY = "deepseek-cache-stats";
const STATE_DIR = join(homedir(), ".pi", "agent");
const STATE_FILE_PATH = join(STATE_DIR, "deepseek-cache-optimizer-stats.json");

type CacheCompat = {
  sendSessionAffinityHeaders?: boolean;
  sendSessionIdHeader?: boolean;
  supportsLongCacheRetention?: boolean;
  thinkingFormat?: string;
  cacheControlFormat?: string;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkillsForPrompt(skills: NonNullable<BuildSystemPromptOptions["skills"]>): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildStableCandidates(opts: BuildSystemPromptOptions): string[] {
  const candidates: string[] = [];

  if (opts.customPrompt) candidates.push(opts.customPrompt);
  if (opts.appendSystemPrompt) candidates.push(opts.appendSystemPrompt);

  const tools = opts.selectedTools ?? ["read", "bash", "edit", "write"];
  const toolLines = tools
    .filter((name) => opts.toolSnippets?.[name])
    .map((name) => `- ${name}: ${opts.toolSnippets?.[name]}`);
  if (toolLines.length > 0) {
    candidates.push(`Available tools:\n${toolLines.join("\n")}`);
  }

  for (const guideline of opts.promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) candidates.push(`- ${normalized}`);
  }

  for (const file of opts.contextFiles ?? []) {
    if (file.content.length <= 2000) continue;
    candidates.push(`## ${file.path}\n\n${file.content}`);
    candidates.push(file.content);
  }

  if (opts.skills && opts.skills.length > 0) {
    candidates.push(formatSkillsForPrompt(opts.skills));
  }

  return candidates;
}

function optimizeSystemPrompt(
  original: string,
  opts: BuildSystemPromptOptions,
): string {
  const stableParts: string[] = [];
  const seen = new Set<string>();
  let rest = original;

  // Stable layer: content likely to be identical across sessions/turns.
  for (const candidate of buildStableCandidates(opts)) {
    const part = candidate.trim();
    if (!part || seen.has(part) || !rest.includes(part)) continue;

    stableParts.push(part);
    seen.add(part);
    rest = rest.replace(part, "");
  }

  // Dynamic layer: git status, active task context, recent session context, etc.
  const dynamicRemainder = rest.trim();

  if (stableParts.length === 0) return original;

  return (
    stableParts.join("\n\n") +
    (dynamicRemainder.length > 0 ? "\n\n---\n\n" + dynamicRemainder : "")
  );
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function getCompat(model: PiModel | undefined): CacheCompat {
  return (model?.compat ?? {}) as CacheCompat;
}

function isDeepSeekLikeModel(model: PiModel | undefined): boolean {
  if (!model) return false;

  return lower(model.id).includes("deepseek") || lower(model.name).includes("deepseek");
}

function shouldWarnForCacheCompat(model: PiModel | undefined): boolean {
  if (!model || !isDeepSeekLikeModel(model)) return false;
  return model.api === "openai-completions" || model.api === "openai-responses";
}

function describeMissingCacheCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];

  if (compat.supportsLongCacheRetention !== true) {
    missing.push("supportsLongCacheRetention");
  }
  if (model.api === "openai-responses") {
    if (compat.sendSessionIdHeader !== true) {
      missing.push("sendSessionIdHeader");
    }
  } else if (compat.sendSessionAffinityHeaders !== true) {
    missing.push("sendSessionAffinityHeaders");
  }

  return missing;
}

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function notifyCacheCompatIfNeeded(
  model: PiModel | undefined,
  ctx: ExtensionContext,
  warnedModels: Set<string>,
): void {
  if (!model || !shouldWarnForCacheCompat(model)) return;

  const key = modelKey(model);
  if (warnedModels.has(key)) return;
  warnedModels.add(key);

  const missing = describeMissingCacheCompat(model);
  if (missing.length === 0) return;

  ctx.ui.notify(
    "💡 DeepSeek cache optimizer: " +
      `${key} is DeepSeek-like but merged compat lacks ${missing.join(" and ")}. ` +
      "Proxies may reduce or hide cache hits; add these compat flags in ~/.pi/agent/models.json when the endpoint supports them.",
    "warning",
  );
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type CacheStats = {
  day: string;
  totalRequests: number;
  hitRequests: number;
  cachedInputTokens: number;
  totalInputTokens: number;
};

type PersistedCacheStats = {
  version: 1;
  stats: CacheStats;
};

type UsageSnapshot = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
};

function currentLocalDay(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyCacheStats(day = currentLocalDay()): CacheStats {
  return {
    day,
    totalRequests: 0,
    hitRequests: 0,
    cachedInputTokens: 0,
    totalInputTokens: 0,
  };
}

function getAssistantUsage(message: unknown): UsageSnapshot | undefined {
  const record = asRecord(message);
  if (record?.role !== "assistant") return undefined;

  const usage = asRecord(record.usage);
  if (!usage) return undefined;

  return {
    input: getNumber(usage.input) ?? 0,
    cacheRead: getNumber(usage.cacheRead) ?? 0,
    cacheWrite: getNumber(usage.cacheWrite) ?? 0,
  };
}

function isDeepSeekLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const record = asRecord(message);
  if (record?.role !== "assistant") return false;

  return lower(record.model).includes("deepseek") || isDeepSeekLikeModel(model);
}

function addUsageToCacheStats(stats: CacheStats, usage: UsageSnapshot): void {
  stats.totalRequests += 1;
  if (usage.cacheRead > 0) stats.hitRequests += 1;
  stats.cachedInputTokens += usage.cacheRead;

  // Pi's normalized usage splits prompt input into uncached input, cacheRead, and cacheWrite.
  // Include cacheWrite when present so the denominator stays the full prompt-input token count.
  stats.totalInputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
}

function formatTokenCount(value: number): string {
  const millions = Math.max(0, Math.round(value)) / 1_000_000;
  if (millions === 0) return "0M";
  if (millions < 0.001) return `${millions.toFixed(4)}M`;
  if (millions < 0.01) return `${millions.toFixed(3)}M`;
  if (millions >= 10) return `${millions.toFixed(1)}M`;
  return `${millions.toFixed(2)}M`;
}

function formatCacheStats(stats: CacheStats): string {
  const percent = stats.totalInputTokens > 0
    ? ` (${Math.round((stats.cachedInputTokens / stats.totalInputTokens) * 100)}%)`
    : "";

  return `DS cache ${stats.hitRequests}/${stats.totalRequests} · ${formatTokenCount(stats.cachedInputTokens)}/${formatTokenCount(stats.totalInputTokens)} tok${percent}`;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function getNonNegativeNumber(record: UnknownRecord, key: string): number | undefined {
  const value = getNumber(record[key]);
  return value !== undefined && value >= 0 ? value : undefined;
}

function parsePersistedCacheStats(value: unknown): CacheStats | undefined {
  const record = asRecord(value);
  if (!record || record.version !== 1) return undefined;

  const stats = asRecord(record.stats);
  if (!stats || typeof stats.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stats.day)) {
    return undefined;
  }

  const totalRequests = getNonNegativeNumber(stats, "totalRequests");
  const hitRequests = getNonNegativeNumber(stats, "hitRequests");
  const cachedInputTokens = getNonNegativeNumber(stats, "cachedInputTokens");
  const totalInputTokens = getNonNegativeNumber(stats, "totalInputTokens");

  if (
    totalRequests === undefined ||
    hitRequests === undefined ||
    cachedInputTokens === undefined ||
    totalInputTokens === undefined ||
    hitRequests > totalRequests ||
    cachedInputTokens > totalInputTokens
  ) {
    return undefined;
  }

  return {
    day: stats.day,
    totalRequests,
    hitRequests,
    cachedInputTokens,
    totalInputTokens,
  };
}

async function readPersistedCacheStats(): Promise<CacheStats | undefined> {
  try {
    const raw = await readFile(STATE_FILE_PATH, "utf8");
    return parsePersistedCacheStats(JSON.parse(raw));
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.warn("DeepSeek cache optimizer: failed to read persisted cache stats", error);
    }
    return undefined;
  }
}

async function writePersistedCacheStats(stats: CacheStats): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const payload: PersistedCacheStats = { version: 1, stats };
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, STATE_FILE_PATH);
}

export default function (pi: ExtensionAPI) {
  const warnedModels = new Set<string>();
  let cacheStats = emptyCacheStats();
  let lastStatusText: string | undefined;
  let persistenceWarningShown = false;

  async function persistCacheStats(ctx?: ExtensionContext): Promise<void> {
    try {
      await writePersistedCacheStats(cacheStats);
    } catch (error) {
      console.warn("DeepSeek cache optimizer: failed to persist cache stats", error);
      if (!persistenceWarningShown) {
        persistenceWarningShown = true;
        ctx?.ui.notify(
          "DeepSeek cache optimizer: failed to persist footer stats; using in-memory stats for this process.",
          "warning",
        );
      }
    }
  }

  async function restoreCacheStats(reason: string, ctx: ExtensionContext): Promise<void> {
    if (reason === "reload") {
      cacheStats = emptyCacheStats();
      lastStatusText = undefined;
      await persistCacheStats(ctx);
      return;
    }

    cacheStats = (await readPersistedCacheStats()) ?? emptyCacheStats();
    lastStatusText = undefined;
    await rollOverStatsIfNeeded(ctx);
  }

  async function rollOverStatsIfNeeded(ctx?: ExtensionContext): Promise<void> {
    const day = currentLocalDay();
    if (cacheStats.day !== day) {
      cacheStats = emptyCacheStats(day);
      lastStatusText = undefined;
      await persistCacheStats(ctx);
    }
  }

  async function publishStatus(ctx: ExtensionContext, model: PiModel | undefined = ctx.model): Promise<void> {
    await rollOverStatsIfNeeded(ctx);

    const statusText = isDeepSeekLikeModel(model) ? formatCacheStats(cacheStats) : undefined;
    if (statusText === lastStatusText) return;

    lastStatusText = statusText;
    ctx.ui.setStatus(STATUS_KEY, statusText);
  }

  pi.on("session_start", async (event, ctx) => {
    await restoreCacheStats(event.reason, ctx);
    notifyCacheCompatIfNeeded(ctx.model, ctx, warnedModels);
    await publishStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    notifyCacheCompatIfNeeded(event.model, ctx, warnedModels);
    await publishStatus(ctx, event.model);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const optimized = optimizeSystemPrompt(event.systemPrompt, event.systemPromptOptions);

    if (optimized !== event.systemPrompt && optimized.trim().length > 0) {
      return { systemPrompt: optimized };
    }

    return {};
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isDeepSeekLikeAssistantMessage(event.message, ctx.model)) return;

    const usage = getAssistantUsage(event.message);
    if (!usage) return;

    await rollOverStatsIfNeeded(ctx);
    addUsageToCacheStats(cacheStats, usage);
    await persistCacheStats(ctx);
    await publishStatus(ctx);
  });
}
