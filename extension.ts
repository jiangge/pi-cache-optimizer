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
 * 3. Warns once for provider/model cache compat gaps where the signal is conservative.
 * 4. Shows lightweight persisted provider-specific cache stats in Pi's footer.
 *
 * Provider prompt/KV caches are provider-side and best-effort. This extension improves
 * the odds of cache hits; it cannot guarantee hits, especially through proxies.
 */

// ============================================================
// Automatically request long prompt-cache retention when Pi supports it.
// ============================================================
if (!process.env.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION !== "long") {
  process.env.PI_CACHE_RETENTION = "long";
}

type PiModel = NonNullable<ExtensionContext["model"]>;
type UnknownRecord = Record<string, unknown>;
type CacheProviderId = "deepseek" | "openai" | "claude" | "gemini";

const STATUS_KEY = "deepseek-cache-stats";
const STATE_DIR = join(homedir(), ".pi", "agent");
const STATE_FILE_PATH = join(STATE_DIR, "deepseek-cache-optimizer-stats.json");

const CACHE_PROVIDER_IDS: CacheProviderId[] = ["deepseek", "openai", "claude", "gemini"];

const ASSISTANT_MESSAGE_MODEL_TOKEN_KEYS = ["model", "name"];
const OPENAI_REASONING_MODEL_PATTERN = /(^|[/\s:_-])o[1345]($|[-_.:/\s])/;

type CacheCompat = {
  sendSessionAffinityHeaders?: boolean;
  sendSessionIdHeader?: boolean;
  supportsLongCacheRetention?: boolean;
  thinkingFormat?: string;
  cacheControlFormat?: string;
};

type CacheStats = {
  day: string;
  totalRequests: number;
  hitRequests: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
};

type PersistedCacheStatsV2 = {
  version: 2;
  statsByProvider: Partial<Record<CacheProviderId, CacheStats>>;
};

type UsageSnapshot = {
  cacheRead: number;
  cacheWrite: number;
  totalInput: number;
};

type CacheProviderAdapter = {
  id: CacheProviderId;
  label: string;
  showCacheWrite?: boolean;
  matchesModel(model: PiModel | undefined): boolean;
  matchesAssistantMessage(message: unknown, model: PiModel | undefined): boolean;
  normalizeUsage(message: unknown): UsageSnapshot | undefined;
  warningText?(model: PiModel): string | undefined;
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

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getNonNegativeNumber(record: UnknownRecord, key: string): number | undefined {
  const value = getNumber(record[key]);
  return value !== undefined && value >= 0 ? value : undefined;
}

function getCompat(model: PiModel | undefined): CacheCompat {
  return (model?.compat ?? {}) as CacheCompat;
}

function isAssistantMessage(message: unknown): boolean {
  return asRecord(message)?.role === "assistant";
}

function getAssistantRecord(message: unknown): UnknownRecord | undefined {
  const record = asRecord(message);
  return record?.role === "assistant" ? record : undefined;
}

function getModelIdNameTokenValues(model: PiModel | undefined): string[] {
  if (!model) return [];
  return [model.id, model.name].map(lower).filter(Boolean);
}

function getAssistantMessageModelTokenValues(message: unknown): string[] {
  const record = asRecord(message);
  if (!record) return [];

  return ASSISTANT_MESSAGE_MODEL_TOKEN_KEYS.map((key) => lower(record[key])).filter(Boolean);
}

function hasAnyTokenContaining(tokens: string[], needles: string[]): boolean {
  return tokens.some((token) => needles.some((needle) => token.includes(needle)));
}

function modelOrAssistantMessageHas(message: unknown, model: PiModel | undefined, needles: string[]): boolean {
  return hasAnyTokenContaining([...getModelIdNameTokenValues(model), ...getAssistantMessageModelTokenValues(message)], needles);
}

function isDeepSeekLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["deepseek"]);
}

function isDeepSeekLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["deepseek"]);
}

function isOpenAICompatibleApi(api: unknown): boolean {
  const value = lower(api);
  return value === "openai-completions" || value === "openai-responses";
}

function isOpenAIFamilyToken(token: string): boolean {
  return token.includes("gpt-") || token.includes("chatgpt") || OPENAI_REASONING_MODEL_PATTERN.test(token);
}

function isOpenAIFamilyModel(model: PiModel | undefined): boolean {
  return getModelIdNameTokenValues(model).some(isOpenAIFamilyToken);
}

function isOpenAIFamilyAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return [...getModelIdNameTokenValues(model), ...getAssistantMessageModelTokenValues(message)].some(isOpenAIFamilyToken);
}

function isClaudeLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["anthropic", "claude"]);
}

function isClaudeLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["anthropic", "claude"]);
}

function isGeminiLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["gemini", "vertex"]);
}

function isGeminiLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["gemini", "vertex"]);
}

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function usageRecordFromAssistant(message: unknown): UnknownRecord | undefined {
  return asRecord(getAssistantRecord(message)?.usage);
}

function getNestedRecord(record: UnknownRecord | undefined, key: string): UnknownRecord | undefined {
  return asRecord(record?.[key]);
}

function getFirstNonNegativeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = getNumber(value);
    if (number !== undefined && number >= 0) return number;
  }
  return undefined;
}

function readCachedTokensFromDetails(details: UnknownRecord | undefined): number | undefined {
  return getFirstNonNegativeNumber(details?.cached_tokens, details?.cachedTokens);
}

function readCacheWriteFromDetails(details: UnknownRecord | undefined): number | undefined {
  return getFirstNonNegativeNumber(details?.cache_write_tokens, details?.cacheWriteTokens);
}

function getPiNormalizedUsage(message: unknown, allowInputOnly = false): UsageSnapshot | undefined {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return undefined;

  const input = getNonNegativeNumber(usage, "input");
  const cacheRead = getNonNegativeNumber(usage, "cacheRead");
  const cacheWrite = getNonNegativeNumber(usage, "cacheWrite");
  const hasCacheSignal = cacheRead !== undefined || cacheWrite !== undefined;

  if (!hasCacheSignal && (input === undefined || !allowInputOnly)) return undefined;

  return {
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalInput: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
}

function getDeepSeekRawUsage(message: unknown): UsageSnapshot | undefined {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return undefined;

  const cacheRead = getFirstNonNegativeNumber(usage.prompt_cache_hit_tokens);
  if (cacheRead === undefined) return undefined;

  const cacheMiss = getFirstNonNegativeNumber(usage.prompt_cache_miss_tokens);
  const promptTokens = getFirstNonNegativeNumber(usage.prompt_tokens);
  const totalInput = promptTokens ?? cacheRead + (cacheMiss ?? 0);

  return { cacheRead, cacheWrite: 0, totalInput };
}

function getOpenAIRawUsage(message: unknown): UsageSnapshot | undefined {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return undefined;

  const promptDetails = getNestedRecord(usage, "prompt_tokens_details") ?? getNestedRecord(usage, "promptTokensDetails");
  const inputDetails = getNestedRecord(usage, "input_tokens_details") ?? getNestedRecord(usage, "inputTokensDetails");
  const cacheRead = readCachedTokensFromDetails(promptDetails) ?? readCachedTokensFromDetails(inputDetails);
  if (cacheRead === undefined) return undefined;

  const cacheWrite = readCacheWriteFromDetails(promptDetails) ?? readCacheWriteFromDetails(inputDetails) ?? 0;
  const totalInput = getFirstNonNegativeNumber(
    usage.prompt_tokens,
    usage.promptTokens,
    usage.input_tokens,
    usage.inputTokens,
  ) ?? cacheRead + cacheWrite;

  return { cacheRead, cacheWrite, totalInput };
}

function getAnthropicRawUsage(message: unknown): UsageSnapshot | undefined {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return undefined;

  const cacheRead = getFirstNonNegativeNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens);
  const cacheWrite = getFirstNonNegativeNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  if (cacheRead === undefined && cacheWrite === undefined) return undefined;

  const input = getFirstNonNegativeNumber(usage.input_tokens, usage.inputTokens) ?? 0;
  return {
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalInput: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
}

function getGeminiRawUsage(message: unknown): UsageSnapshot | undefined {
  const record = getAssistantRecord(message);
  if (!record) return undefined;

  const usage = asRecord(record.usage);
  const metadata =
    getNestedRecord(record, "usageMetadata") ??
    getNestedRecord(record, "usage_metadata") ??
    getNestedRecord(usage, "usageMetadata") ??
    getNestedRecord(usage, "usage_metadata") ??
    usage;
  if (!metadata) return undefined;

  const cacheRead = getFirstNonNegativeNumber(
    metadata.cachedContentTokenCount,
    metadata.cached_content_token_count,
  );
  if (cacheRead === undefined) return undefined;

  const totalInput = getFirstNonNegativeNumber(
    metadata.promptTokenCount,
    metadata.prompt_token_count,
    metadata.inputTokenCount,
    metadata.input_token_count,
    usage?.input_tokens,
    usage?.inputTokens,
    usage?.prompt_tokens,
    usage?.promptTokens,
  ) ?? cacheRead;

  return { cacheRead, cacheWrite: 0, totalInput };
}

function normalizeWithFallback(
  message: unknown,
  rawNormalizer: (message: unknown) => UsageSnapshot | undefined,
  options: { allowInputOnlyPiUsage?: boolean } = {},
): UsageSnapshot | undefined {
  return getPiNormalizedUsage(message, options.allowInputOnlyPiUsage) ?? rawNormalizer(message);
}

function describeMissingDeepSeekCompat(model: PiModel): string[] {
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

const CACHE_PROVIDER_ADAPTERS: CacheProviderAdapter[] = [
  {
    id: "deepseek",
    label: "DS cache",
    matchesModel: isDeepSeekLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isDeepSeekLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getDeepSeekRawUsage, { allowInputOnlyPiUsage: true });
    },
    warningText(model) {
      if (!isDeepSeekLikeModel(model) || !isOpenAICompatibleApi(model.api)) return undefined;

      const missing = describeMissingDeepSeekCompat(model);
      if (missing.length === 0) return undefined;

      const key = modelKey(model);
      return (
        `💡 DeepSeek cache optimizer: ${key} is DeepSeek-like but merged compat lacks ${missing.join(" and ")}. ` +
        "Proxies may reduce or hide cache hits; add these compat flags in ~/.pi/agent/models.json when the endpoint supports them."
      );
    },
  },
  {
    id: "claude",
    label: "Claude cache",
    showCacheWrite: true,
    matchesModel: isClaudeLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isClaudeLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getAnthropicRawUsage);
    },
    warningText(model) {
      if (!isClaudeLikeModel(model) || !isOpenAICompatibleApi(model.api)) return undefined;
      if (getCompat(model).cacheControlFormat === "anthropic") return undefined;

      return (
        `💡 Cache optimizer: ${modelKey(model)} looks Claude/Anthropic-like but OpenAI-compatible compat lacks cacheControlFormat: "anthropic". ` +
        "Pi may not place Anthropic cache_control breakpoints unless this endpoint supports and enables that compat flag."
      );
    },
  },
  {
    id: "openai",
    label: "OpenAI cache",
    matchesModel: isOpenAIFamilyModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isOpenAIFamilyAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
  },
  {
    id: "gemini",
    label: "Gemini cache",
    matchesModel: isGeminiLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isGeminiLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getGeminiRawUsage);
    },
  },
];

function selectAdapterForModel(model: PiModel | undefined): CacheProviderAdapter | undefined {
  return CACHE_PROVIDER_ADAPTERS.find((adapter) => adapter.matchesModel(model));
}

function selectAdapterForAssistantMessage(message: unknown, model: PiModel | undefined): CacheProviderAdapter | undefined {
  return CACHE_PROVIDER_ADAPTERS.find((adapter) => adapter.matchesAssistantMessage(message, model));
}

function notifyCacheCompatIfNeeded(
  model: PiModel | undefined,
  ctx: ExtensionContext,
  warnedModels: Set<string>,
): void {
  if (!model) return;

  const adapter = selectAdapterForModel(model);
  const text = adapter?.warningText?.(model);
  if (!adapter || !text) return;

  const key = `${adapter.id}:${modelKey(model)}`;
  if (warnedModels.has(key)) return;
  warnedModels.add(key);

  ctx.ui.notify(text, "warning");
}

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
    cacheWriteInputTokens: 0,
    totalInputTokens: 0,
  };
}

function emptyAllCacheStats(day = currentLocalDay()): Partial<Record<CacheProviderId, CacheStats>> {
  return Object.fromEntries(CACHE_PROVIDER_IDS.map((id) => [id, emptyCacheStats(day)])) as Partial<Record<CacheProviderId, CacheStats>>;
}

function addUsageToCacheStats(stats: CacheStats, usage: UsageSnapshot): void {
  stats.totalRequests += 1;
  if (usage.cacheRead > 0) stats.hitRequests += 1;
  stats.cachedInputTokens += usage.cacheRead;
  stats.cacheWriteInputTokens += usage.cacheWrite;
  stats.totalInputTokens += usage.totalInput;
}

function formatTokenCount(value: number): string {
  const millions = Math.max(0, Math.round(value)) / 1_000_000;
  if (millions === 0) return "0M";
  if (millions < 0.001) return `${millions.toFixed(4)}M`;
  if (millions < 0.01) return `${millions.toFixed(3)}M`;
  if (millions >= 10) return `${millions.toFixed(1)}M`;
  return `${millions.toFixed(2)}M`;
}

function formatCacheStats(adapter: CacheProviderAdapter, stats: CacheStats): string {
  const percent = stats.totalInputTokens > 0
    ? ` (${Math.round((stats.cachedInputTokens / stats.totalInputTokens) * 100)}%)`
    : "";
  const writeText = adapter.showCacheWrite && stats.cacheWriteInputTokens > 0
    ? ` · write ${formatTokenCount(stats.cacheWriteInputTokens)} tok`
    : "";

  return `${adapter.label} ${stats.hitRequests}/${stats.totalRequests} · ${formatTokenCount(stats.cachedInputTokens)}/${formatTokenCount(stats.totalInputTokens)} tok${percent}${writeText}`;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function parseCacheStats(value: unknown): CacheStats | undefined {
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

function parsePersistedCacheStats(value: unknown): Partial<Record<CacheProviderId, CacheStats>> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  if (record.version === 1) {
    const migrated = parseCacheStats(record.stats);
    return migrated ? { deepseek: migrated } : undefined;
  }

  if (record.version !== 2) return undefined;

  const statsByProvider = asRecord(record.statsByProvider);
  if (!statsByProvider) return undefined;

  const parsed: Partial<Record<CacheProviderId, CacheStats>> = {};
  for (const id of CACHE_PROVIDER_IDS) {
    const stats = parseCacheStats(statsByProvider[id]);
    if (stats) parsed[id] = stats;
  }

  return parsed;
}

async function readPersistedCacheStats(): Promise<Partial<Record<CacheProviderId, CacheStats>> | undefined> {
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

async function writePersistedCacheStats(statsByProvider: Partial<Record<CacheProviderId, CacheStats>>): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const payload: PersistedCacheStatsV2 = { version: 2, statsByProvider };
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, STATE_FILE_PATH);
}

export default function (pi: ExtensionAPI) {
  const warnedModels = new Set<string>();
  let cacheStatsByProvider: Partial<Record<CacheProviderId, CacheStats>> = emptyAllCacheStats();
  let lastStatusText: string | undefined;
  let persistenceWarningShown = false;

  function getStatsForAdapter(adapter: CacheProviderAdapter): CacheStats {
    const existing = cacheStatsByProvider[adapter.id];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsByProvider[adapter.id] = created;
    return created;
  }

  async function persistCacheStats(ctx?: ExtensionContext): Promise<void> {
    try {
      await writePersistedCacheStats(cacheStatsByProvider);
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

  async function rollOverStatsIfNeeded(ctx?: ExtensionContext): Promise<void> {
    const day = currentLocalDay();
    let changed = false;

    for (const id of CACHE_PROVIDER_IDS) {
      const stats = cacheStatsByProvider[id];
      if (stats && stats.day !== day) {
        cacheStatsByProvider[id] = emptyCacheStats(day);
        changed = true;
      }
    }

    if (changed) {
      lastStatusText = undefined;
      await persistCacheStats(ctx);
    }
  }

  async function restoreCacheStats(reason: string, ctx: ExtensionContext): Promise<void> {
    if (reason === "reload") {
      cacheStatsByProvider = emptyAllCacheStats();
      lastStatusText = undefined;
      await persistCacheStats(ctx);
      return;
    }

    cacheStatsByProvider = (await readPersistedCacheStats()) ?? emptyAllCacheStats();
    lastStatusText = undefined;
    await rollOverStatsIfNeeded(ctx);
  }

  async function publishStatus(ctx: ExtensionContext, model: PiModel | undefined = ctx.model): Promise<void> {
    await rollOverStatsIfNeeded(ctx);

    const adapter = selectAdapterForModel(model);
    const statusText = adapter ? formatCacheStats(adapter, getStatsForAdapter(adapter)) : undefined;
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
    const adapter = selectAdapterForAssistantMessage(event.message, ctx.model);
    if (!adapter) return;

    const usage = adapter.normalizeUsage(event.message);
    if (!usage) return;

    await rollOverStatsIfNeeded(ctx);
    addUsageToCacheStats(getStatsForAdapter(adapter), usage);
    await persistCacheStats(ctx);
    await publishStatus(ctx);
  });
}
