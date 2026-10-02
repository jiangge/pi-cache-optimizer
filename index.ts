import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type MutableEnv = Record<string, string | undefined>;

type CacheRetentionEnvSnapshot = {
  wasSet: boolean;
  value?: string;
};

const PI_CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";
const LONG_CACHE_RETENTION_VALUE = "long";
const PI_CACHE_RETENTION_BASELINE_SYMBOL = Symbol.for("pi.cache.optimizer.retention-baseline.v1");
const ROUTED_FALLBACK_MODEL_SYMBOL = Symbol("pi-cache-optimizer.routed-fallback-model");

type CacheRetentionBaselineV1 = {
  version: 1;
  snapshot: CacheRetentionEnvSnapshot;
};

function captureCacheRetentionEnv(env: MutableEnv = process.env): CacheRetentionEnvSnapshot {
  return {
    wasSet: Object.prototype.hasOwnProperty.call(env, PI_CACHE_RETENTION_ENV),
    value: env[PI_CACHE_RETENTION_ENV],
  };
}

function requestLongCacheRetention(env: MutableEnv = process.env): void {
  if (!env[PI_CACHE_RETENTION_ENV] || env[PI_CACHE_RETENTION_ENV] !== LONG_CACHE_RETENTION_VALUE) {
    env[PI_CACHE_RETENTION_ENV] = LONG_CACHE_RETENTION_VALUE;
  }
}

function restoreCacheRetentionEnv(snapshot: CacheRetentionEnvSnapshot, env: MutableEnv = process.env): void {
  if (snapshot.wasSet) {
    env[PI_CACHE_RETENTION_ENV] = snapshot.value;
  } else {
    delete env[PI_CACHE_RETENTION_ENV];
  }
}

function isCacheRetentionBaselineV1(value: unknown): value is CacheRetentionBaselineV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { version?: unknown; snapshot?: unknown };
  if (record.version !== 1 || typeof record.snapshot !== "object" || record.snapshot === null) return false;
  const snapshot = record.snapshot as { wasSet?: unknown; value?: unknown };
  return typeof snapshot.wasSet === "boolean" &&
    (snapshot.value === undefined || typeof snapshot.value === "string");
}

function getOrCaptureCacheRetentionBaseline(
  env: MutableEnv = process.env,
  globals: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
): CacheRetentionEnvSnapshot {
  const existing = globals[PI_CACHE_RETENTION_BASELINE_SYMBOL];
  if (isCacheRetentionBaselineV1(existing)) return { ...existing.snapshot };

  const snapshot = captureCacheRetentionEnv(env);
  globals[PI_CACHE_RETENTION_BASELINE_SYMBOL] = { version: 1, snapshot: { ...snapshot } };
  return snapshot;
}

const STARTUP_CACHE_RETENTION_ENV = getOrCaptureCacheRetentionBaseline();

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

type PiModel = NonNullable<ExtensionContext["model"]>;
type ModelIdentity = Pick<PiModel, "provider" | "id">;
type UnknownRecord = Record<string, unknown>;
type CacheProviderId = "deepseek" | "openai" | "claude" | "gemini";

const LOG_PREFIX = "pi-cache-optimizer";
const STATUS_KEY = "pi-cache-stats";

/** Use Pi core's resolver so rebranded config names and env semantics stay aligned. */
const STATE_DIR = getAgentDir();
const STATE_FILE_PATH = join(STATE_DIR, "pi-cache-optimizer-stats.json");
const LEGACY_STATE_FILE_PATH = join(STATE_DIR, "deepseek-cache-optimizer-stats.json");
const SHARD_STATE_DIR = join(STATE_DIR, "pi-cache-optimizer-stats.d");
const SHARD_FILES_DIR = join(SHARD_STATE_DIR, "shards");
const SHARD_EPOCH_DIR = join(SHARD_STATE_DIR, "epochs");
const SHARD_MODEL_EPOCH_DIR = join(SHARD_EPOCH_DIR, "models");
const SHARD_MAINTENANCE_DIR = join(SHARD_STATE_DIR, "maintenance");
const SHARD_GLOBAL_EPOCH_PATH = join(SHARD_EPOCH_DIR, "global.json");
const SHARD_CLEANUP_LOCK_PATH = join(SHARD_MAINTENANCE_DIR, "cleanup.lock");
const SHARD_CLEANUP_MARKER_PATH = join(SHARD_MAINTENANCE_DIR, "last-cleanup");
const CONFIG_FILE_PATH = join(STATE_DIR, "pi-cache-optimizer-config.json");
const CONFIG_RECEIPT_FILE_NAME = "pi-cache-optimizer-config-receipt.json";
const CONFIG_RECEIPT_PATH = join(STATE_DIR, CONFIG_RECEIPT_FILE_NAME);
const FIX_RECEIPT_FILE_NAME = "pi-cache-optimizer-fix-receipt.json";
const FIX_RECEIPT_PATH = join(STATE_DIR, FIX_RECEIPT_FILE_NAME);
const MODELS_TRANSACTION_LOCK_PATH = join(STATE_DIR, "pi-cache-optimizer-models-transaction.lock");
const MODELS_TRANSACTION_LOCK_STALE_MS = 60_000;
const MODELS_TRANSACTION_LOCK_WAIT_MS = 5_000;
const SHARD_RETENTION_MS = 48 * 60 * 60 * 1000;
const SHARD_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const SHARD_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SHARD_CLEANUP_LOCK_STALE_MS = 60 * 60 * 1000;
const CACHE_PROVIDER_IDS: CacheProviderId[] = ["deepseek", "openai", "claude", "gemini"];
const OPENAI_CACHE_KEY_ENV = "PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY";
const NO_OPENAI_CACHE_KEY_ENV = "PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY";
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const NO_SKILL_COMPRESSION_ENV = "PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION";
const NO_PROMPT_REWRITE_ENV = "PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE";
const VIRTUAL_REWRITE_ENV = "PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE";
const TOOL_ORDER_ENV = "PI_CACHE_OPTIMIZER_TOOL_ORDER";
const FOOTER_MODE_ENV = "PI_CACHE_OPTIMIZER_FOOTER_MODE";
type FooterStatsMode = "session" | "total" | "process";
type FixReceiptPlacement = "provider" | "model" | "modelOverride";
type ReceiptScalar = string | number | boolean | null;
type ReceiptScalarState =
  | { present: false }
  | { present: true; value: ReceiptScalar };
type FixReceiptCompatChange = {
  before: ReceiptScalarState;
  after: ReceiptScalarState;
};
type ModelsJsonFixReceiptV1 = {
  version: 1;
  kind: "pi-cache-optimizer-fix-receipt";
  transactionId: string;
  provider: string;
  modelId: string;
  placement: FixReceiptPlacement;
  targetExistedBefore: boolean;
  changedKeys: Record<string, FixReceiptCompatChange>;
  beforeHash: string;
  afterHash: string;
  backupFile: string;
  createdAt: number;
  appliedAt: number;
  status?: "rolled_back";
  rolledBackAt?: number;
};

// Receipts are trusted input to a later rollback command, so their key set is
// deliberately narrower than the full models.json compat vocabulary. This
// prevents a corrupted or hand-edited receipt from turning rollback into a
// way to rewrite credentials, headers, routing, or arbitrary provider fields.
const RECEIPT_COMPAT_KEYS = new Set([
  "sendSessionAffinityHeaders",
  "supportsLongCacheRetention",
  "requiresReasoningContentOnAssistantMessages",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "thinkingFormat",
  "supportsReasoningEffort",
]);
type FooterStatsModeSource = "config" | "env" | "default";
type PersistedCacheOptimizerConfigV1 = {
  version: 1;
  footerMode?: FooterStatsMode;
};
type PersistedCacheOptimizerFeature = "promptRewrite" | "virtualRewrite" | "skillCompression" | "openAICacheKey" | "toolOrder";
type PersistedCacheOptimizerConfigV2 = {
  version: 2;
  footerMode?: FooterStatsMode;
  promptCacheKey?: {
    omit?: string[];
  };
};
type PersistedCacheOptimizerConfigV3 = {
  version: 2 | 3;
  footerMode?: FooterStatsMode;
  promptCacheKey?: { omit?: string[] };
  features?: Partial<Record<PersistedCacheOptimizerFeature, boolean>>;
};
type PersistedCacheOptimizerConfig = PersistedCacheOptimizerConfigV1 | PersistedCacheOptimizerConfigV2 | PersistedCacheOptimizerConfigV3;
type PromptCacheKeyConfigReceipt = {
  version: 2;
  kind: "pi-cache-optimizer-config-receipt";
  transactionId: string;
  provider: string;
  modelId: string;
  beforeHash: string;
  afterHash: string;
  backupFile: string;
  targetExistedBefore: boolean;
  targetHadModelKey: boolean;
  addedModelKey: string;
  createdAt: number;
  appliedAt: number;
  status?: "rolled_back";
  rolledBackAt?: number;
};
type PromptCacheKeyConfigReceiptSnapshot = {
  receipt: PromptCacheKeyConfigReceipt;
  receiptPath: string;
  hash: string;
  identity: FileIdentity;
};
const PI_ROUTING_REGISTRY_SYMBOL = Symbol.for("pi.routing.registry.v1");
const PI_CACHE_HINTS_SYMBOL = Symbol.for("pi.cache.hints.v1");
// Model API that Pi 0.99+ assigns to native virtual models (VIRTUAL_MODEL_API).
const PI_VIRTUAL_MODEL_API = "pi-virtual";
const PI_CACHE_HINTS_OWNER_SYMBOL = Symbol.for("pi.cache.optimizer.hints-owner.v1");
const ANTHROPIC_TTL_FALLBACK_SYMBOL = Symbol.for("pi.cache.optimizer.anthropic-ttl-fallback.v1");
const REASONING_PROTOCOL_FALLBACK_SYMBOL = Symbol.for("pi.cache.optimizer.reasoning-protocol-fallback.v1");

type AnthropicTtlFallbackStateV1 = {
  version: 1;
  modelKeys: Set<string>;
  warnedModelKeys: Set<string>;
};

type ReasoningProtocolFallbackStateV1 = {
  version: 1;
  modelKeys: Set<string>;
  warnedModelKeys: Set<string>;
};

function getReasoningProtocolFallbackState(): ReasoningProtocolFallbackStateV1 {
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

function getAnthropicTtlFallbackState(): AnthropicTtlFallbackStateV1 {
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

let runtimeOptimizerEnabled = true;

// WORM-flag: if optimizeSystemPrompt ever detects that candidate extraction
// has accidentally truncated a structural marker (any XML tag or
// HTML comment boundary marker present in the original prompt), we flip
// this. publishStatus reads it once, appends a footer warning, then
// resets it. The flag surface is kept separate from the regular
// cache-stats counter so that a one-turn glitch doesn't poison the
// persisted metrics.
let promptTruncationDetected = false;

// Timestamp (ms) of the most recent integrity truncation event.
// Used by /cache-optimizer doctor to surface recovery guidance.
// Reset to 0 on reload.
let lastPromptIntegrityWarningAt = 0;

/** Getter for lastPromptIntegrityWarningAt (exported for tests via __internals_for_tests). */
function getLastPromptIntegrityWarningAt(): number {
  return lastPromptIntegrityWarningAt;
}

// Minimum count of skills before compression is worth applying.
// Below this, pi's verbose XML block is small enough that the overhead of
// an additional one-line index isn't worth the loss of per-skill
// description hints. The 31-skill snapshot in this repo was 13.3 KB; one
// or two skills is well under 1 KB and not worth touching.
const SKILL_COMPRESSION_MIN_COUNT = 4;

// Minimum trimmed length for a candidate to qualify as a stable-prefix "part".
//
// `optimizeSystemPrompt` removes each uniquely occurring accepted candidate
// from the dynamic remainder. Short or character-class candidates (think: `S`,
// `- u`, `- (`, `- }`) are too likely to match unrelated prompt text, so they
// are never eligible for lifting.
//
// The threshold also caps the upstream string-vs-array regression we saw with
// trellis 0.5.16 / 0.6.0-beta.17 (subagent tool registration passing
// `promptGuidelines: "<long string>"` instead of `["<long string>"]`, which
// pi then iterates char-by-char). Even if a similar bug recurs upstream, this
// extension will not lift its single-character byproducts into the stable
// prefix candidate list.
//
// 8 chars is comfortably above all single-bullet (`- X` = 3 chars) and
// short-token noise while leaving every legitimate guideline / tool snippet /
// context-file payload above the bar. If a real future guideline is shorter
// than 8 chars, the cost is that it is not lifted into the stable prefix; the
// dynamic-remainder path still includes it untouched.
const MIN_STABLE_CANDIDATE_LENGTH = 8;

const ASSISTANT_MESSAGE_MODEL_TOKEN_KEYS = ["model", "name"];
const OPENAI_REASONING_MODEL_PATTERN = /(^|[/\s:_-])o[1345]($|[-_.:/\s])/;
const XAI_MODEL_PATTERN = /(^|[/\s:_-])xai($|[-_.:/\s])/;
const MIMO_MODEL_PATTERN = /(^|[/\s:_-])mi-?mo($|[-_.:/\s])/i;
const PPLX_MODEL_PATTERN = /(^|[/\s:_-])pplx($|[-_.:/\s])/i;
const NOVA_MODEL_PATTERN = /(^|[/\s:_-])nova($|[-_.:/\s])/i;
const MPT_MODEL_PATTERN = /(^|[/\s:_-])mpt($|[-_.:/\s])/i;
const ALEPH_MODEL_PATTERN = /(^|[/\s:_-])aleph($|[-_.:/\s])/i;

// Safe-boundary patterns for models with short or ambiguous tokens
const ARCTIC_MODEL_PATTERN = /(^|[\/\s:_-])arctic($|[\-_.:\/\s])/i;
const AYA_MODEL_PATTERN = /(^|[\/\s:_-])aya($|[\-_.:\/\s])/i;
const ORION_MODEL_PATTERN = /(^|[\/\s:_-])orion($|[\-_.:\/\s])/i;

type CacheCompat = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  sendSessionAffinityHeaders?: boolean;
  sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
  supportsLongCacheRetention?: boolean;
  thinkingFormat?: string;
  requiresReasoningContentOnAssistantMessages?: boolean;
  cacheControlFormat?: string;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  openRouterRouting?: UnknownRecord;
  vercelGatewayRouting?: UnknownRecord;
  chatTemplateKwargs?: UnknownRecord;
  chatTemplateArgs?: UnknownRecord;
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

/** Per-model-key scoped state. Used in memory and for v3 persistence. */
type PersistedRoutedModelRef = {
  provider: string;
  id: string;
  name?: string;
};

type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

type PiRouteResolveHint = {
  sessionIdHash?: string;
  requestId?: string;
};

type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute(
    virtualModelId: string,
    hint?: PiRouteResolveHint,
  ): PiRouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): PiRouteSnapshot[];
  subscribe?(listener: (event: PiRouteSnapshot) => void): () => void;
};

type PiRoutingRegistryV1 = {
  version: 1;
  registerRouter(adapter: PiRouterAdapterV1): () => void;
  getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined;
};

type PiCacheHintsInput = {
  sessionIdHash?: string;
  virtualProvider?: string;
  virtualModelId?: string;
  upstreamProvider?: string;
  upstreamModelId?: string;
  api?: string;
};

type PiCacheHintsOutput = {
  systemPrompt?: string;
  promptCacheKey?: string;
  cacheRetention?: "long";
};

type PiCacheHintSnapshot = PiCacheHintsInput & PiCacheHintsOutput & {
  timestamp: number;
};

type PiCacheHintsV1 = {
  version: 1;
  getHints(input: PiCacheHintsInput): PiCacheHintsOutput | undefined;
};

type ProtocolGlobal = typeof globalThis & Record<symbol, unknown> & {
  __piCacheOptimizerRouter?: unknown;
  __piCacheOptimizerCacheKey__?: unknown;
};

type ModelRegistryLike = {
  find?(provider: string, modelId: string): PiModel | undefined;
  getAvailable?(): PiModel[];
  getAll?(): PiModel[];
};

type ContextWithOptionalModelRegistry = Pick<ExtensionContext, "sessionManager"> & {
  modelRegistry?: ModelRegistryLike;
};

type CacheStatsState = {
  statsByModel: Record<string, CacheStats>;
  totalsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>;
};

type PersistedCacheStatsV3 = {
  version: 3;
  statsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
};

/**
 * V4 format: session-scoped stats buckets.
 * Each Pi process/session gets its own stats isolated by a hashed session id.
 *
 * sessions: sessionHash → modelKey (provider/id) → CacheStats
 * legacyFamily: unchanged from v3 (migration/fallback when ctx.model is unknown)
 */
type PersistedCacheStatsV4 = {
  version: 4;
  sessions: Record<string, Record<string, CacheStats>>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
};

type PersistedCacheStatsV5 = {
  version: 5;
  sessions: Record<string, Record<string, CacheStats>>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>;
};

type PersistedCacheStatsV6 = {
  version: 6;
  sessions: Record<string, Record<string, CacheStats>>;
  totalsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>;
};

type UsageSnapshot = {
  cacheRead: number;
  cacheWrite: number;
  totalInput: number;
};

type OptimizedSystemPrompt = {
  systemPrompt: string;
  stablePrefix: string;
  changed: boolean;
};

type ToolOrderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream";


/**
 * Per-request sample stored for trend analysis and usage-field-missing detection.
 * Contains only numeric counters and booleans — never message content, prompts,
 * payloads, headers, API keys, or model outputs.
 */
type PersistedStatsShardV7 = {
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

type ShardAggregate = {
  bySession: Record<string, Record<string, CacheStats>>;
  totalsByModel: Record<string, CacheStats>;
  instancesBySession: Record<string, number>;
  instancesBySessionModel: Record<string, Record<string, number>>;
  sessionsByModel: Record<string, number>;
  instancesByModel: Record<string, number>;
  modelRefsByKey: Record<string, PersistedRoutedModelRef>;
  lastRoutedModelBySession: Record<string, PersistedRoutedModelRef>;
};

type CacheUsageSample = {
  timestamp: number;
  hit: boolean;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
  missingUsageFields: boolean;
};

/** Maximum number of recent samples kept per model key (in-memory only, not persisted). */
const MAX_RECENT_SAMPLES = 50;

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

function isStableContextFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop();

  return (
    name === "agents.md" ||
    name === "claude.md" ||
    name === "gemini.md" ||
    name === "cursor.md" ||
    normalized.startsWith(".trellis/spec/") ||
    normalized.includes("/.trellis/spec/")
  );
}

function isKnownToolOrderApi(api: unknown): api is ToolOrderApi {
  return api === "openai-completions" || api === "openai-responses" ||
    api === "anthropic-messages" || api === "google-generative-ai" ||
    api === "google-vertex" || api === "bedrock-converse-stream";
}

function isToolOrderingEligibleModel(model: PiModel | undefined): boolean {
  // Responses/Codex prompt bypasses remain untouched. The pure helper still
  // supports the verified Responses shape for fixture use, but the request
  // hook must preserve Pi's server-managed/safety-sensitive bypass.
  return !!model && isKnownToolOrderApi(model.api) && !isResponsesPromptRewriteBypassApi(model.api);
}

function getToolNameForPayload(tool: unknown): string | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;
  if (isNonEmptyString(record.name)) return record.name;
  const fn = asRecord(record.function);
  if (isNonEmptyString(fn?.name)) return fn.name;
  const custom = asRecord(record.custom);
  if (isNonEmptyString(custom?.name)) return custom.name;
  const spec = asRecord(record.toolSpec);
  if (isNonEmptyString(spec?.name)) return spec.name;
  return undefined;
}

function compareToolOrderEntries(
  left: { name: string; index: number },
  right: { name: string; index: number },
): number {
  // Do not use localeCompare here: its result can vary with the host locale.
  // Exact UTF-16 code-unit ordering plus the original index is reproducible.
  return left.name < right.name ? -1 : left.name > right.name ? 1 : left.index - right.index;
}

function isJsonObject(value: unknown): value is UnknownRecord {
  return asRecord(value) !== undefined;
}

function isVerifiedToolForApi(tool: unknown, api: ToolOrderApi): tool is UnknownRecord {
  const record = asRecord(tool);
  if (!record) return false;

  if (api === "openai-completions") {
    if (record.type === "function") {
      const fn = asRecord(record.function);
      return isNonEmptyString(fn?.name) && isJsonObject(fn.parameters);
    }
    if (record.type === "custom") {
      const custom = asRecord(record.custom);
      return isNonEmptyString(custom?.name) && isJsonObject(custom.format);
    }
    return false;
  }

  if (api === "openai-responses") {
    if (record.type === "function") {
      return isNonEmptyString(record.name) && isJsonObject(record.parameters);
    }
    if (record.type === "custom") {
      return isNonEmptyString(record.name) && isJsonObject(record.format);
    }
    return false;
  }

  if (api === "anthropic-messages") {
    return isNonEmptyString(record.name) && isJsonObject(record.input_schema);
  }

  if (api === "google-generative-ai" || api === "google-vertex") {
    return isNonEmptyString(record.name) &&
      (isJsonObject(record.parametersJsonSchema) || isJsonObject(record.parameters));
  }

  const spec = asRecord(record.toolSpec);
  const inputSchema = asRecord(spec?.inputSchema);
  return isNonEmptyString(spec?.name) && isJsonObject(inputSchema?.json);
}

type ToolArrayInspection = {
  sortedIndices: number[];
  changed: boolean;
};

function hasTopLevelCacheControl(tools: unknown): boolean {
  return Array.isArray(tools) && tools.some((tool) => {
    const record = asRecord(tool);
    return !!record && Object.prototype.hasOwnProperty.call(record, "cache_control");
  });
}

function inspectToolArray(tools: unknown, api: ToolOrderApi): ToolArrayInspection | undefined {
  if (!Array.isArray(tools)) return undefined;
  // Native Anthropic and OpenAI-compatible transports can attach a cache
  // breakpoint to a specific tool (normally the final one). Never move it,
  // regardless of API id. Anthropic defer_loading also encodes immediate vs
  // deferred tool groups in array order, so mixed/grouped payloads are no-ops.
  if (hasTopLevelCacheControl(tools)) return undefined;
  if (api === "anthropic-messages" && tools.some((tool) => {
    const record = asRecord(tool);
    return !!record && Object.prototype.hasOwnProperty.call(record, "defer_loading");
  })) return undefined;
  const entries = tools.map((tool, index) => {
    if (!isVerifiedToolForApi(tool, api)) return undefined;
    return { name: getToolNameForPayload(tool) ?? "", index };
  });
  if (entries.some((entry) => entry === undefined)) return undefined;

  const verified = entries as Array<{ name: string; index: number }>;
  const sorted = [...verified].sort(compareToolOrderEntries);
  return {
    sortedIndices: sorted.map((entry) => entry.index),
    changed: sorted.some((entry, index) => entry.index !== index),
  };
}

type ToolArrayPath = {
  kind: "root" | "bedrock" | "google";
  groupIndex?: number;
  sortedIndices: number[];
};

/**
 * Pure deterministic tool-order normalizer for the exact payload shapes
 * emitted by Pi's built-in transports. It returns the original object for a
 * no-op/unsupported/malformed payload and shallow-clones only the verified
 * path to a tool array when sorting is needed. Tool objects and unrelated
 * request fields (including SDK objects and AbortSignal) retain their identity.
 */
function normalizeToolsInPayload(
  payload: unknown,
  api: unknown,
): { payload: unknown; changed: boolean } {
  if (!isKnownToolOrderApi(api)) return { payload, changed: false };
  const root = asRecord(payload);
  if (!root) return { payload, changed: false };

  if (api === "google-generative-ai" || api === "google-vertex") {
    const config = asRecord(root.config);
    const groups = config?.tools;
    if (!Array.isArray(groups) || groups.length === 0) return { payload, changed: false };

    const paths: ToolArrayPath[] = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = asRecord(groups[groupIndex]);
      if (!group || !Array.isArray(group.functionDeclarations)) return { payload, changed: false };
      const inspected = inspectToolArray(group.functionDeclarations, api);
      if (!inspected) return { payload, changed: false };
      if (inspected.changed) paths.push({ kind: "google", groupIndex, sortedIndices: inspected.sortedIndices });
    }
    if (paths.length === 0) return { payload, changed: false };

    const sortedGroups = [...groups];
    for (const path of paths) {
      const groupIndex = path.groupIndex!;
      const group = asRecord(groups[groupIndex])!;
      const tools = group.functionDeclarations as unknown[];
      sortedGroups[groupIndex] = {
        ...group,
        functionDeclarations: path.sortedIndices.map((index) => tools[index]),
      };
    }
    return {
      payload: { ...root, config: { ...config, tools: sortedGroups } },
      changed: true,
    };
  }

  if (api === "bedrock-converse-stream") {
    const toolConfig = asRecord(root.toolConfig);
    const tools = toolConfig?.tools;
    const inspected = inspectToolArray(tools, api);
    if (!inspected || !inspected.changed || !Array.isArray(tools)) return { payload, changed: false };
    return {
      payload: {
        ...root,
        toolConfig: {
          ...toolConfig,
          tools: inspected.sortedIndices.map((index) => tools[index]),
        },
      },
      changed: true,
    };
  }

  const tools = root.tools;
  const inspected = inspectToolArray(tools, api);
  if (!inspected || !inspected.changed || !Array.isArray(tools)) return { payload, changed: false };
  return {
    payload: { ...root, tools: inspected.sortedIndices.map((index) => tools[index]) },
    changed: true,
  };
}

/** Public test-facing alias: a pure payload transformation. */
function sortToolsInPayload(payload: unknown, api: unknown): unknown {
  return normalizeToolsInPayload(payload, api).payload;
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

/**
 * Compressed alternative to `formatSkillsForPrompt`.
 *
 * Pi emits a four-line XML block per skill (`<name>`, `<description>`,
 * `<location>`) plus a three-sentence preamble. With 31 skills active in
 * this repo that block measured 13.3 KB — 61.5 % of the total system
 * prompt. The full description text matters when the model has to decide
 * which skill to load, but the model can read SKILL.md on demand: the
 * names alone plus a known location pattern is enough to identify
 * candidates.
 *
 * This compressed form preserves:
 *   1. The instruction to read SKILL.md when a task matches a skill name.
 *   2. The relative-path resolution rule (parent of SKILL.md is the
 *      skill directory).
 *   3. Discoverability of every skill: name + location prefix per skill.
 *
 * It drops:
 *   - Per-skill description text (model loads it via `read` when a name
 *     matches a task).
 *   - The `<available_skills>` XML envelope and per-skill XML overhead
 *     (~110 bytes per skill of pure structure, plus the location path).
 *
 * Output shape is a single text block grouped by skill-root directory so
 * the model can compute each skill's full path by name. Names are sorted
 * alphabetically within each group for determinism (cache stability).
 */
function formatSkillsForPromptCompressed(
  skills: NonNullable<BuildSystemPromptOptions["skills"]>,
): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const groups = new Map<string, string[]>();
  for (const skill of visibleSkills) {
    // skill.filePath = .../<skill-name>/SKILL.md, so dirname is the
    // skill directory and dirname-of-dirname is the skills root.
    const skillDir = dirname(skill.filePath);
    const root = dirname(skillDir);
    const list = groups.get(root) ?? [];
    list.push(skill.name);
    groups.set(root, list);
  }

  // Sort group entries by root for determinism: same skill set under the
  // same roots must always produce the same string, otherwise the
  // provider prompt-prefix cache loses on prompt builder runs that
  // happened to iterate the underlying Map in different orders.
  const sortedGroups = [...groups.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const lines: string[] = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks. When a skill name matches the task you are doing, read the SKILL.md at the listed location to load the full instructions. When a SKILL.md references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
  ];

  for (const [root, names] of sortedGroups) {
    names.sort();
    lines.push("");
    lines.push(`Skills under ${root}/<name>/SKILL.md:`);
    // Wrap the name list at ~80 columns for readability without
    // affecting determinism. Each line is `  name1, name2, name3,`.
    let buf = "  ";
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const piece = (buf === "  " ? "" : ", ") + name;
      if (buf.length > 2 && buf.length + piece.length > 80) {
        lines.push(`${buf},`);
        buf = `  ${name}`;
      } else {
        buf += piece;
      }
    }
    if (buf.length > 2) lines.push(buf);
  }

  return lines.join("\n");
}

/**
 * Replace pi's verbose `<available_skills>` block in `prompt` with the
 * compressed one-index form. Idempotent: if the verbose form is not
 * present (compression already applied, or skill count below threshold),
 * the prompt is returned unchanged.
 *
 * Opt-out: set `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1`.
 *
 * Pre-conditions for compression to fire:
 *   - opts.skills present and visible-skill count >= SKILL_COMPRESSION_MIN_COUNT
 *   - Verbose block (built from the same `opts.skills`) is found in
 *     `prompt` (substring match, no regex). This anchors the substitution
 *     to pi's own emitter; if pi changes the format, we no-op rather
 *     than mangle.
 */
function compressSkillsInSystemPrompt(
  prompt: string,
  opts: BuildSystemPromptOptions,
): string {
  if (!featureEnabled("skillCompression", NO_SKILL_COMPRESSION_ENV, true)) return prompt;
  if (!opts.skills || opts.skills.length === 0) return prompt;

  const visible = opts.skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length < SKILL_COMPRESSION_MIN_COUNT) return prompt;

  const verbose = formatSkillsForPrompt(opts.skills);
  if (!verbose || !prompt.includes(verbose)) return prompt;

  const compressed = formatSkillsForPromptCompressed(opts.skills);
  if (!compressed || compressed.length >= verbose.length) return prompt;

  return prompt.replace(verbose, compressed);
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
    // Provider caches work best when stable instructions are part of the earliest prefix.
    // Only lift known-stable project/spec instruction files. Dynamic task/session context
    // can be large too, so size alone must never make a context file cache-prefix material.
    if (!isStableContextFilePath(file.path)) continue;
    candidates.push(`## ${file.path}\n\n${file.content}`);
    candidates.push(file.content);
  }

  if (opts.skills && opts.skills.length > 0) {
    // Push BOTH forms so `optimizeSystemPrompt` finds whichever is
    // actually present in the prompt. The `rest.includes(part)`
    // short-circuit skips the form that isn't there. The two strings
    // are mutually distinguishable (the verbose form contains the
    // literal `<available_skills>` envelope; the compressed form
    // contains `Skills under ` and no XML tags) so they cannot
    // accidentally match each other.
    candidates.push(formatSkillsForPrompt(opts.skills));
    candidates.push(formatSkillsForPromptCompressed(opts.skills));
  }

  return candidates;
}

/**
 * Strip per-turn churn from trellis `<session-overview>` block.
 *
 * Trellis injects a session-overview that includes `RECENT COMMITS`
 * (shifts on every git commit), `Working directory: Clean/N uncommitted`
 * (shifts on every edit/commit), and `Line count: N / 2000` (shifts on
 * every journal append). These fields are at the tail of the
 * session-overview and poison the prompt-prefix cache for everything
 * that follows.
 *
 * This function surgically removes those three churn fields from the
 * `<session-overview>...</session-overview>` block. The remaining
 * fields (DEVELOPER, GIT STATUS branch-only, CURRENT TASK, ACTIVE
 * TASKS, MY TASKS, JOURNAL FILE active-file-only, PACKAGES, PATHS)
 * are stable within a session and become cache-friendlier.
 *
 * No-op when the `<session-overview>` tag is not present (e.g.
 * trellis hook chose not to inject it, or a different extension
 * owns the prompt).
 */
function stripSessionOverviewChurn(prompt: string): string {
  const startTag = "<session-overview>";
  const endTag = "</session-overview>";

  const startIdx = prompt.indexOf(startTag);
  if (startIdx === -1) return prompt;

  const endIdx = prompt.indexOf(endTag, startIdx + startTag.length);
  if (endIdx === -1) return prompt;

  const before = prompt.slice(0, startIdx + startTag.length);
  const inner = prompt.slice(startIdx + startTag.length, endIdx);
  const after = prompt.slice(endIdx);

  let cleaned = inner
    // Drop the RECENT COMMITS section (from the heading through the
    // next heading or end of inner). The model sees commit history
    // via `git log`; carrying it in every system prompt is redundant.
    .replace(/\n## RECENT COMMITS\n[\s\S]*?(?=\n## |$)/, "")
    // Drop "Working directory: ..." (Git status tail churn).
    .replace(/\nWorking directory:[^\n]*/g, "")
    // Drop "Line count: N / NNNN" (Journal tail churn).
    .replace(/\nLine count:[^\n]*/g, "");

  return before + cleaned + after;
}

/**
 * Extract structural markers from a prompt for the integrity guard.
 *
 * The guard runs in `optimizeSystemPrompt` to catch cases where the
 * candidate extraction accidentally eats text inside
 * an extension-injected structural block (e.g., trellis
 * `<workflow-state>`, a hypothetical `<task-tracker>`, or AGENTS.md
 * `<!-- TRELLIS:START -->` markers). When the original prompt contains
 * a marker that the result is missing, we fall back to the original
 * prompt rather than ship a corrupted one.
 *
 * Three marker categories are recognized (covers ~99% of real-world
 * extension injection patterns in the pi ecosystem):
 *
 *   1. XML-style opening tags  `<tagname>` (lowercase, alpha-num + `_`/`-`)
 *   2. XML-style closing tags  `</tagname>`
 *   3. HTML comment START/END  `<!-- NAME:START -->` / `<!-- NAME:END -->`
 *
 * Tags with attributes (e.g., `<task id="42">`) are not currently emitted
 * by any pi extension we know of and are skipped to keep the regex tight.
 * Markdown headers, horizontal rules, and timestamp patterns are not
 * usable as guards because they have no closing form to verify.
 *
 * The check is deliberately set-based (presence/absence) rather than
 * count-based: a single occurrence per request is the universal
 * convention, and a count drop with the same set of unique tags would
 * be a different class of bug not catchable here.
 */
function extractStructuralMarkers(prompt: string): {
  openingTags: Set<string>;
  closingTags: Set<string>;
  commentMarkers: Set<string>;
} {
  const openingTags = new Set<string>();
  const closingTags = new Set<string>();
  const commentMarkers = new Set<string>();

  // Opening tags: <tagname> with no attributes and no leading slash.
  // Tagname must start with a letter and contain only alpha-num, `-`, `_`.
  for (const match of prompt.matchAll(/<([a-z][a-z0-9_-]*)>/gi)) {
    openingTags.add(match[1].toLowerCase());
  }
  // Closing tags: </tagname>
  for (const match of prompt.matchAll(/<\/([a-z][a-z0-9_-]*)>/gi)) {
    closingTags.add(match[1].toLowerCase());
  }
  // HTML comments with NAME:START or NAME:END inside.
  // Trellis emits `<!-- TRELLIS:START -->` / `<!-- TRELLIS:END -->` in
  // the AGENTS.md managed block; other extensions follow this convention.
  for (const match of prompt.matchAll(/<!--\s*([A-Z][A-Z0-9_-]*):(START|END)\s*-->/g)) {
    commentMarkers.add(`${match[1]}:${match[2]}`);
  }

  return { openingTags, closingTags, commentMarkers };
}

function optimizeSystemPrompt(
  original: string,
  opts: BuildSystemPromptOptions,
): OptimizedSystemPrompt {
  const stableParts: string[] = [];
  const seen = new Set<string>();
  let rest = original;

  // Classify candidate ambiguity against one immutable snapshot. Candidates
  // can be nested (a full context-file block also contains its bare content),
  // so recomputing occurrence counts after each removal is unsafe: deleting
  // the full block can make the dynamic copy of its bare content appear unique.
  const candidates: string[] = [];
  for (const candidate of buildStableCandidates(opts)) {
    const part = candidate.trim();
    if (!part || part.length < MIN_STABLE_CANDIDATE_LENGTH || seen.has(part)) continue;
    seen.add(part);
    candidates.push(part);
  }

  const initialRemainder = rest;
  const occurrenceCount = new Map<string, number>();
  for (const part of candidates) {
    let count = 0;
    let searchFrom = 0;
    while (searchFrom < initialRemainder.length) {
      const occurrence = initialRemainder.indexOf(part, searchFrom);
      if (occurrence < 0) break;
      count++;
      if (count > 1) break;
      searchFrom = occurrence + 1;
    }
    occurrenceCount.set(part, count);
  }

  // Stable layer: content likely to be identical across sessions/turns.
  // Short / single-char candidates are dropped: see MIN_STABLE_CANDIDATE_LENGTH.
  for (const part of candidates) {
    if (occurrenceCount.get(part) !== 1) continue;

    const firstOccurrence = rest.indexOf(part);
    if (firstOccurrence < 0) continue;

    stableParts.push(part);
    rest = rest.slice(0, firstOccurrence) + rest.slice(firstOccurrence + part.length);
  }

  const stablePrefix = stableParts.join("\n\n");

  // Dynamic layer: git status, active task context, recent session context, etc.
  const dynamicRemainder = rest.trim();

  if (stableParts.length === 0) {
    return { systemPrompt: original, stablePrefix: "", changed: false };
  }

  const systemPrompt =
    stablePrefix +
    (dynamicRemainder.length > 0 ? "\n\n---\n\n" + dynamicRemainder : "");

  // Sanity check: scan ALL structural markers (XML tags + HTML comment
  // boundary markers) in the original and verify each one survives the
  // reorder. If any marker drops, candidate extraction ate something it
  // shouldn't have — fall back to the original
  // prompt and flag the footer warning. This is provider-agnostic and
  // extension-agnostic: trellis `<workflow-state>`, a hypothetical
  // `<task-tracker>`, AGENTS.md `<!-- TRELLIS:START -->`, etc., are all
  // protected without code changes when new extensions ship.
  //
  // Our skills compression runs BEFORE optimizeSystemPrompt and replaces
  // pi's verbose `<available_skills>` block with a compressed text
  // section that has no XML tag. So `original` here (post-compression)
  // does not contain `<available_skills>` and the result doesn't either
  // — no false positive.
  const originalMarkers = extractStructuralMarkers(original);
  const resultMarkers = extractStructuralMarkers(systemPrompt);

  const missing =
    [...originalMarkers.openingTags].some((tag) => !resultMarkers.openingTags.has(tag)) ||
    [...originalMarkers.closingTags].some((tag) => !resultMarkers.closingTags.has(tag)) ||
    [...originalMarkers.commentMarkers].some((m) => !resultMarkers.commentMarkers.has(m));

  if (missing) {
    promptTruncationDetected = true;
    return { systemPrompt: original, stablePrefix: "", changed: false };
  }

  return {
    systemPrompt,
    stablePrefix,
    changed: true,
  };
}

function clampPromptCacheKey(key: string | undefined): string | undefined {
  const normalized = key?.trim();
  if (!normalized) return undefined;

  const chars = Array.from(normalized);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return normalized;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function getSessionPromptCacheKey(ctx: ExtensionContext): string | undefined {
  return clampPromptCacheKey(ctx.sessionManager.getSessionId());
}

/**
 * Hash a session id for use as a non-reversible opaque scope key.
 * Returns a 16-character hex string (64 bits of SHA-256 digest prefix)
 * suitable for scoping stats buckets without exposing the raw session id.
 */
function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function getProtocolGlobal(): ProtocolGlobal {
  return globalThis as ProtocolGlobal;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return undefined;
}

function sessionHashFromContext(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  return sessionId ? hashSessionId(sessionId) : undefined;
}

function isPiRouterAdapterV1(value: unknown): value is PiRouterAdapterV1 {
  const record = asRecord(value);
  return !!record && isNonEmptyString(record.virtualProvider) && typeof record.resolveActiveRoute === "function";
}

function isRoutingRegistryV1(value: unknown): value is PiRoutingRegistryV1 {
  const record = asRecord(value);
  return !!record && record.version === 1 && typeof record.registerRouter === "function" && typeof record.getRouter === "function";
}

function createRoutingRegistry(): PiRoutingRegistryV1 {
  const routers = new Map<string, PiRouterAdapterV1>();
  return {
    version: 1,
    registerRouter(adapter: PiRouterAdapterV1): () => void {
      if (!isPiRouterAdapterV1(adapter)) return () => undefined;
      const key = adapter.virtualProvider.trim();
      routers.set(key, adapter);
      return () => {
        if (routers.get(key) === adapter) routers.delete(key);
      };
    },
    getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined {
      return routers.get(virtualProvider);
    },
  };
}

function getRoutingRegistry(): PiRoutingRegistryV1 | undefined {
  const candidate = getProtocolGlobal()[PI_ROUTING_REGISTRY_SYMBOL];
  return isRoutingRegistryV1(candidate) ? candidate : undefined;
}

function ensureRoutingRegistry(): PiRoutingRegistryV1 {
  const existing = getRoutingRegistry();
  if (existing) return existing;

  const created = createRoutingRegistry();
  getProtocolGlobal()[PI_ROUTING_REGISTRY_SYMBOL] = created;
  return created;
}

function parseRouteStatus(value: unknown): PiRouteSnapshot["status"] | undefined {
  return value === "planned" || value === "trying" || value === "selected" || value === "success" || value === "failed"
    ? value
    : undefined;
}

function parseRouteSnapshot(
  value: unknown,
  fallbackVirtualProvider?: string,
  fallbackVirtualModelId?: string,
): PiRouteSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const virtualProvider = firstNonEmptyString(record.virtualProvider, fallbackVirtualProvider);
  const virtualModelId = firstNonEmptyString(record.virtualModelId, record.virtualModel, fallbackVirtualModelId);
  const provider = firstNonEmptyString(record.provider, record.upstreamProvider, record.targetProvider);
  const modelId = firstNonEmptyString(record.modelId, record.upstreamModelId, record.targetModelId, record.responseModel);
  if (!virtualProvider || !virtualModelId || !provider || !modelId) return undefined;

  const timestamp = getNumber(record.timestamp) ?? Date.now();
  return {
    virtualProvider,
    virtualModelId,
    provider,
    modelId,
    api: firstNonEmptyString(record.api),
    canonicalModelId: firstNonEmptyString(record.canonicalModelId),
    routeLabel: firstNonEmptyString(record.routeLabel, record.label),
    status: parseRouteStatus(record.status),
    sessionIdHash: firstNonEmptyString(record.sessionIdHash),
    requestId: firstNonEmptyString(record.requestId),
    timestamp,
  };
}

function resolveActiveRouteSnapshot(
  model: PiModel | undefined,
  ctx?: Pick<ExtensionContext, "sessionManager">,
): PiRouteSnapshot | undefined {
  if (!model || isNativeVirtualModel(model)) return undefined;
  const hint: PiRouteResolveHint | undefined = ctx ? { sessionIdHash: sessionHashFromContext(ctx) } : undefined;

  const adapter = getRoutingRegistry()?.getRouter(model.provider);
  if (adapter) {
    try {
      const snapshot = parseRouteSnapshot(
        adapter.resolveActiveRoute(model.id, hint),
        model.provider,
        model.id,
      );
      if (snapshot) return snapshot;
    } catch (error) {
      console.warn(`${LOG_PREFIX}: routing registry adapter failed`, error);
    }
  }

  // Temporary migration shim for the prototype global used by early router PRs.
  // New integrations should use Symbol.for("pi.routing.registry.v1") instead.
  const legacy = getProtocolGlobal().__piCacheOptimizerRouter;
  if (!legacy || !lower(model.provider).includes("router")) return undefined;
  try {
    if (typeof legacy === "function") {
      return parseRouteSnapshot(legacy(model.provider, model.id, hint), model.provider, model.id);
    }
    const legacyRecord = asRecord(legacy);
    const resolver = legacyRecord?.resolveActiveRoute;
    if (typeof resolver === "function") {
      return parseRouteSnapshot(resolver.call(legacy, model.id, hint), model.provider, model.id);
    }
    return parseRouteSnapshot(legacy, model.provider, model.id);
  } catch (error) {
    console.warn(`${LOG_PREFIX}: legacy routing global failed`, error);
    return undefined;
  }
}

function resolveNativeVirtualCandidateModels(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel[] | undefined {
  if (!isNativeVirtualModel(model)) return undefined;
  const adapter = model ? getRoutingRegistry()?.getRouter(model.provider) : undefined;
  if (!adapter?.resolveCandidateRoutes) return undefined;

  try {
    const rawSnapshots = adapter.resolveCandidateRoutes(model.id);
    if (!Array.isArray(rawSnapshots) || rawSnapshots.length === 0) return undefined;
    const candidates: PiModel[] = [];
    for (const rawSnapshot of rawSnapshots) {
      const snapshot = parseRouteSnapshot(rawSnapshot, model.provider, model.id);
      if (!snapshot) return undefined;
      const candidate = findModelInRegistry(ctx?.modelRegistry, snapshot.provider, snapshot.modelId)
        ?? routeSnapshotToPiModel(snapshot, model);
      if (!isNonEmptyString(candidate.api)) return undefined;
      candidates.push(candidate);
    }
    return candidates;
  } catch {
    return undefined;
  }
}

function canRewriteNativeVirtualPrompt(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): boolean {
  if (!isNativeVirtualModel(model) || !featureEnabled("virtualRewrite", VIRTUAL_REWRITE_ENV, false)) return false;
  const candidates = resolveNativeVirtualCandidateModels(model, ctx);
  return !!candidates?.length && candidates.every((candidate) =>
    candidate.api === "openai-completions" || candidate.api === "anthropic-messages",
  ) && candidates.every((candidate) => !isResponsesPromptRewriteBypassApi(candidate.api));
}

function routeSnapshotToPiModel(snapshot: PiRouteSnapshot, fallback?: PiModel): PiModel {
  const sameIdentity = fallback?.provider === snapshot.provider && fallback?.id === snapshot.modelId;
  return {
    ...(sameIdentity ? fallback ?? {} : {}),
    id: snapshot.modelId,
    name: snapshot.canonicalModelId ?? snapshot.modelId,
    provider: snapshot.provider,
    api: snapshot.api ?? (sameIdentity ? fallback?.api : undefined) ?? "",
    baseUrl: sameIdentity ? fallback?.baseUrl ?? "" : "",
    reasoning: sameIdentity ? fallback?.reasoning ?? false : false,
    input: sameIdentity ? fallback?.input ?? ["text"] : ["text"],
    cost: sameIdentity
      ? fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: sameIdentity ? fallback?.contextWindow ?? 0 : 0,
    maxTokens: sameIdentity ? fallback?.maxTokens ?? 0 : 0,
    compat: sameIdentity ? fallback?.compat : undefined,
    [ROUTED_FALLBACK_MODEL_SYMBOL]: true,
  } as PiModel;
}

function findModelInRegistry(registry: ModelRegistryLike | undefined, provider: string, id: string): PiModel | undefined {
  try {
    const found = registry?.find?.(provider, id);
    if (found) return found;

    const available = registry?.getAvailable?.() ?? [];
    const availableMatch = available.find((candidate) => candidate.provider === provider && candidate.id === id);
    if (availableMatch) return availableMatch;

    const all = registry?.getAll?.() ?? [];
    return all.find((candidate) => candidate.provider === provider && candidate.id === id);
  } catch {
    // Registry extensions are optional input; a malformed/throwing registry
    // must not turn a provider error hook into a Pi session failure.
    return undefined;
  }
}

function isRoutedFallbackModel(model: PiModel | undefined): boolean {
  return !!model && (model as PiModel & Record<symbol, unknown>)[ROUTED_FALLBACK_MODEL_SYMBOL] === true;
}

function applyConfiguredTransportToModel(model: PiModel, config: unknown): PiModel {
  const providers = asRecord(asRecord(config)?.providers);
  const provider = asRecord(providers?.[model.provider]);
  const customModel = findLastExactModelDefinition(
    Array.isArray(provider?.models) ? provider.models : undefined,
    model.id,
  );
  const configuredApi = customModel?.api ?? provider?.api;
  const configuredBaseUrl = customModel?.baseUrl ?? provider?.baseUrl;
  const api = isNonEmptyString(model.api)
    ? model.api
    : (isNonEmptyString(configuredApi) ? configuredApi : model.api);
  const baseUrl = isNonEmptyString(model.baseUrl)
    ? model.baseUrl
    : (isNonEmptyString(configuredBaseUrl) ? configuredBaseUrl : model.baseUrl);
  return api === model.api && baseUrl === model.baseUrl ? model : { ...model, api, baseUrl };
}

function resolveRouteModel(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel | undefined {
  const nativeVirtualRoute = resolveNativeVirtualRouteModel(model, ctx);
  if (nativeVirtualRoute) return nativeVirtualRoute;

  const snapshot = resolveActiveRouteSnapshot(model, ctx);
  if (!snapshot) return undefined;

  const resolved = findModelInRegistry(ctx?.modelRegistry, snapshot.provider, snapshot.modelId)
    ?? routeSnapshotToPiModel(snapshot, model);
  return applyConfiguredTransportToModel(resolved, readEffectiveCompatConfig());
}

function isVirtualRoutingModel(model: PiModel | undefined, ctx?: Pick<ExtensionContext, "sessionManager">): boolean {
  if (!model) return false;
  return isNativeVirtualModel(model) || isRouterModel(model) || !!getRoutingRegistry()?.getRouter(model.provider) || !!resolveActiveRouteSnapshot(model, ctx);
}

// Pi 0.99+ native virtual models (`pi.registerVirtualModel()`). `ctx.model`
// stays the virtual selection while Pi dispatches every request to a physical
// model; only assistant messages and the provider payload name that model.
// Older Pi hosts never produce this API, so every native-virtual path is inert.
type NativeVirtualDispatch = { provider: string; id: string; api: string };

function isNativeVirtualModel(model: { api?: unknown } | undefined): boolean {
  return model?.api === PI_VIRTUAL_MODEL_API;
}

function readSessionBranch(ctx: Pick<ExtensionContext, "sessionManager"> | undefined): unknown[] {
  try {
    const manager = ctx?.sessionManager as { getBranch?: () => unknown } | undefined;
    if (typeof manager?.getBranch !== "function") return [];
    const branch = manager.getBranch();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

/**
 * Physical models that answered on the current session branch, newest first:
 * the latest successful response (Pi's `request.previous`) and the latest
 * response of any outcome (a failed attempt that a retry may reuse). The
 * catalog id in `message.model` is preferred over the echoed `responseModel`
 * because it is the id Pi dispatched and the registry knows.
 */
function findNativeVirtualDispatches(ctx: Pick<ExtensionContext, "sessionManager"> | undefined): {
  latestSuccessful?: NativeVirtualDispatch;
  latestAny?: NativeVirtualDispatch;
} {
  const branch = readSessionBranch(ctx);
  let latestSuccessful: NativeVirtualDispatch | undefined;
  let latestAny: NativeVirtualDispatch | undefined;
  for (let index = branch.length - 1; index >= 0 && !latestSuccessful; index--) {
    const entry = asRecord(branch[index]);
    if (entry?.type !== "message") continue;
    const message = getAssistantRecord(entry.message);
    if (!message || isNativeVirtualModel(message)) continue;
    const dispatch = nativeVirtualDispatchFromMessage(message);
    if (!dispatch) continue;
    latestAny ??= dispatch;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") latestSuccessful = dispatch;
  }
  return { latestSuccessful, latestAny };
}

function nativeVirtualDispatchFromMessage(message: unknown): NativeVirtualDispatch | undefined {
  const record = getAssistantRecord(message);
  if (!record || isNativeVirtualModel(record)) return undefined;
  const provider = firstNonEmptyString(record.provider);
  const id = firstNonEmptyString(record.model, record.responseModel);
  return provider && id ? { provider, id, api: firstNonEmptyString(record.api) ?? "" } : undefined;
}

function nativeVirtualDispatchToModel(
  dispatch: NativeVirtualDispatch,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel {
  // A virtual model hides a same-id physical model in the catalog, so a
  // registry hit that is itself virtual is not physical metadata.
  const registered = findModelInRegistry(ctx?.modelRegistry, dispatch.provider, dispatch.id);
  const model = registered && !isNativeVirtualModel(registered)
    ? registered
    : ({
      provider: dispatch.provider,
      id: dispatch.id,
      name: dispatch.id,
      api: dispatch.api,
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 0,
      [ROUTED_FALLBACK_MODEL_SYMBOL]: true,
    } as PiModel);
  return applyConfiguredTransportToModel(model, readEffectiveCompatConfig());
}

/**
 * Physical model behind a native virtual selection for pre-request UX (footer,
 * doctor, compat, stats, reset, fix): the model that answered last on this
 * session branch, matching Pi's own routed-model display and context limits.
 */
function resolveNativeVirtualRouteModel(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel | undefined {
  if (!isNativeVirtualModel(model)) return undefined;
  const { latestSuccessful, latestAny } = findNativeVirtualDispatches(ctx);
  const dispatch = latestSuccessful ?? latestAny;
  return dispatch ? nativeVirtualDispatchToModel(dispatch, ctx) : undefined;
}

function getProviderPayloadModelId(payload: unknown): string | undefined {
  const record = asRecord(payload);
  // Pi's built-in transports put the dispatched catalog id in `model`
  // (OpenAI, Anthropic, Google, Mistral) or `modelId` (Bedrock Converse).
  return firstNonEmptyString(record?.model, record?.modelId);
}

function physicalModelsWithId(candidates: readonly PiModel[] | undefined, id: string): PiModel[] {
  return (candidates ?? []).filter((candidate) => candidate.id === id
    && !isNativeVirtualModel(candidate)
    && !isRouterModel(candidate)
    && !getRoutingRegistry()?.getRouter(candidate.provider));
}

/**
 * Physical model of one native-virtual request. `before_provider_request`
 * carries only the payload and `ctx.model` stays virtual, so the payload's
 * dispatched model id is matched against credentialed physical models (a
 * router may only route to those). A unique provider match wins. An id shared
 * by several credentialed providers is used only when every candidate gets the
 * same request treatment (`requestPolicyKey`); the identity then stays
 * ambiguous so response evidence is never pinned to a guessed provider.
 * Differing policies return undefined so identity-dependent request mutations
 * fail closed. Without a credentialed match, the sticky branch candidates and
 * then the full catalog are consulted.
 */
function resolveNativeVirtualRequestModel(
  model: PiModel | undefined,
  payload: unknown,
  ctx?: ContextWithOptionalModelRegistry,
  requestPolicyKey?: (candidate: PiModel) => string,
): { model: PiModel; identityAmbiguous: boolean } | undefined {
  if (!isNativeVirtualModel(model)) return undefined;
  const payloadModelId = getProviderPayloadModelId(payload);
  if (!payloadModelId) return undefined;
  const config = readEffectiveCompatConfig();
  // null: no candidate; undefined: ambiguous with differing request policies.
  const pick = (matches: PiModel[]): { model: PiModel; identityAmbiguous: boolean } | undefined | null => {
    if (matches.length === 0) return null;
    const configured = matches.map((candidate) => applyConfiguredTransportToModel(candidate, config));
    if (new Set(configured.map((candidate) => candidate.provider)).size === 1) {
      return { model: configured[0], identityAmbiguous: false };
    }
    const policies = requestPolicyKey ? new Set(configured.map(requestPolicyKey)) : undefined;
    return policies?.size === 1 ? { model: configured[0], identityAmbiguous: true } : undefined;
  };
  try {
    const credentialed = pick(physicalModelsWithId(ctx?.modelRegistry?.getAvailable?.(), payloadModelId));
    if (credentialed !== null) return credentialed;

    const { latestSuccessful, latestAny } = findNativeVirtualDispatches(ctx);
    for (const dispatch of [latestSuccessful, latestAny]) {
      if (dispatch?.id === payloadModelId) {
        return { model: nativeVirtualDispatchToModel(dispatch, ctx), identityAmbiguous: false };
      }
    }

    return pick(physicalModelsWithId(ctx?.modelRegistry?.getAll?.(), payloadModelId)) ?? undefined;
  } catch {
    // Registry access is optional input; never fail the provider request hook.
    return undefined;
  }
}

function describeNativeVirtualRouteNote(selected: PiModel | undefined, effective: PiModel | undefined): string | undefined {
  if (!selected || !isNativeVirtualModel(selected)) return undefined;
  // Without a routed response, the not-applicable text explains the state.
  if (!effective || isNativeVirtualModel(effective)) return undefined;
  return `🔀 Native virtual model ${modelKey(selected)} → latest routed physical model ${modelKey(effective)}. The diagnostics below apply to that physical model; Pi may route later requests elsewhere.`;
}

function isCacheHintsServiceV1(value: unknown): value is PiCacheHintsV1 {
  const record = asRecord(value);
  return !!record && record.version === 1 && typeof record.getHints === "function";
}

function getCacheHintsService(): PiCacheHintsV1 | undefined {
  const candidate = getProtocolGlobal()[PI_CACHE_HINTS_SYMBOL];
  return isCacheHintsServiceV1(candidate) ? candidate : undefined;
}

function markOptimizerOwnedCacheHintsService(service: PiCacheHintsV1): PiCacheHintsV1 {
  (service as PiCacheHintsV1 & Record<symbol, unknown>)[PI_CACHE_HINTS_OWNER_SYMBOL] = true;
  return service;
}

function isOptimizerOwnedCacheHintsService(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<symbol, unknown>)[PI_CACHE_HINTS_OWNER_SYMBOL] === true;
}

function installCacheHintsService(
  service: PiCacheHintsV1,
  options: { discardPrevious?: (value: unknown) => boolean } = {},
): () => void {
  const globals = getProtocolGlobal();
  const previous = globals[PI_CACHE_HINTS_SYMBOL];
  globals[PI_CACHE_HINTS_SYMBOL] = service;
  return () => {
    if (globals[PI_CACHE_HINTS_SYMBOL] !== service) return;
    if (previous !== undefined && !options.discardPrevious?.(previous)) {
      globals[PI_CACHE_HINTS_SYMBOL] = previous;
    } else {
      delete globals[PI_CACHE_HINTS_SYMBOL];
    }
  };
}

/**
 * Build a session-scoped stats key from a session hash + provider/id.
 * Pure function (no closure dependency) for use by tests and internals.
 */
function makeSessionModelKey(sessionHash: string, provider: string, id: string): string {
  return `${sessionHash}:${provider}/${id}`;
}

/**
 * Extract the user-facing model key from a session-scoped key.
 * "abc123:otokapi/gpt-5.5" → "otokapi/gpt-5.5"
 */
function modelKeyFromSessionKey(sessionModelKey: string): string {
  const idx = sessionModelKey.indexOf(":");
  return idx >= 0 ? sessionModelKey.slice(idx + 1) : sessionModelKey;
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

/**
 * Get effective compat for a model by merging provider-level and model-level compat.
 * Model-level compat takes precedence over provider-level compat for overlapping keys.
 * This matches Pi's model-registry.js mergeCompat behavior.
 */
const NESTED_COMPAT_KEYS = [
  "openRouterRouting",
  "vercelGatewayRouting",
  "chatTemplateKwargs",
  "chatTemplateArgs",
] as const;

function findLastExactModelDefinition(
  models: unknown[] | undefined,
  modelId: string,
): UnknownRecord | undefined {
  if (!models) return undefined;
  // Pi's provider composer processes definitions in array order. If a malformed
  // or hand-edited config repeats an id, the last definition replaces earlier
  // definitions, so effective resolution must use the same deterministic rule.
  for (let index = models.length - 1; index >= 0; index--) {
    const candidate = asRecord(models[index]);
    if (candidate?.id === modelId) return candidate;
  }
  return undefined;
}

function mergeCacheCompat(...sources: Array<UnknownRecord | undefined>): CacheCompat {
  const merged: CacheCompat = {};
  for (const source of sources) {
    if (!source) continue;
    const previousNested = Object.fromEntries(
      NESTED_COMPAT_KEYS.map((key) => [key, asRecord(merged[key])]),
    ) as Partial<Record<(typeof NESTED_COMPAT_KEYS)[number], UnknownRecord | undefined>>;
    Object.assign(merged, source);
    for (const key of NESTED_COMPAT_KEYS) {
      const baseValue = previousNested[key];
      const overrideValue = asRecord(source[key]);
      if (baseValue || overrideValue) {
        merged[key] = { ...baseValue, ...overrideValue };
      }
    }
  }
  return merged;
}

function getEffectiveCompatSources(model: PiModel, config: unknown): Array<{ source: "provider" | "model" | "runtime" | "modelOverride"; compat: UnknownRecord }> {
  const root = asRecord(config);
  const providers = asRecord(root?.providers);
  const provider = asRecord(providers?.[model.provider]);
  const providerCompat = asRecord(provider?.compat);
  const customModel = findLastExactModelDefinition(
    Array.isArray(provider?.models) ? provider.models : undefined,
    model.id,
  );
  const customModelCompat = asRecord(asRecord(customModel)?.compat);
  const runtimeCompat = asRecord(model.compat);
  const modelOverride = asRecord(asRecord(provider?.modelOverrides)?.[model.id]);
  const modelOverrideCompat = asRecord(modelOverride?.compat);

  return [
    ...(providerCompat ? [{ source: "provider" as const, compat: providerCompat }] : []),
    ...(customModelCompat ? [{ source: "model" as const, compat: customModelCompat }] : []),
    ...(runtimeCompat ? [{ source: "runtime" as const, compat: runtimeCompat }] : []),
    ...(modelOverrideCompat ? [{ source: "modelOverride" as const, compat: modelOverrideCompat }] : []),
  ];
}

function resolveEffectiveCompatFromConfig(model: PiModel, config: unknown): CacheCompat {
  // Pi's effective precedence is provider → models[] → runtime model →
  // modelOverrides. The runtime layer is intentionally included between the
  // config model and modelOverride: extension providers can replace the model
  // object after lower config layers were applied, while the override remains
  // Pi's highest-precedence user layer.
  return mergeCacheCompat(...getEffectiveCompatSources(model, config).map(({ compat }) => compat));
}

function getEffectiveCompatValueSource(
  model: PiModel,
  config: unknown,
  key: keyof CacheCompat,
): "provider" | "model" | "runtime" | "modelOverride" | undefined {
  let source: "provider" | "model" | "runtime" | "modelOverride" | undefined;
  for (const candidate of getEffectiveCompatSources(model, config)) {
    if (Object.prototype.hasOwnProperty.call(candidate.compat, key)) source = candidate.source;
  }
  return source;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecordOfStrings(value: unknown): boolean {
  const record = asRecord(value);
  return !!record && Object.values(record).every((entry) => typeof entry === "string");
}

function isThinkingLevelMap(value: unknown): boolean {
  const map = asRecord(value);
  if (!map) return false;
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].every((key) =>
    map[key] === undefined || map[key] === null || typeof map[key] === "string"
  );
}

function isValidModelCostTier(value: unknown): boolean {
  const tier = asRecord(value);
  return !!tier
    && isFiniteNumber(tier.inputTokensAbove)
    && isFiniteNumber(tier.input)
    && isFiniteNumber(tier.output)
    && isFiniteNumber(tier.cacheRead)
    && isFiniteNumber(tier.cacheWrite);
}

function isValidModelCost(value: unknown, partial: boolean): boolean {
  const cost = asRecord(value);
  if (!cost) return false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if ((!partial || cost[key] !== undefined) && !isFiniteNumber(cost[key])) return false;
  }
  return cost.tiers === undefined || (Array.isArray(cost.tiers) && cost.tiers.every(isValidModelCostTier));
}

function isValidModelDefinition(value: unknown): boolean {
  const model = asRecord(value);
  if (!model || !isNonEmptyString(model.id)) return false;
  if (!isOptionalString(model.name) || !isOptionalString(model.api) || !isOptionalString(model.baseUrl)) return false;
  if (!isOptionalBoolean(model.reasoning) || !isValidCompatRecord(model.compat)) return false;
  if (model.thinkingLevelMap !== undefined && !isThinkingLevelMap(model.thinkingLevelMap)) return false;
  if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.every((entry) => entry === "text" || entry === "image"))) return false;
  if (model.cost !== undefined && !isValidModelCost(model.cost, false)) return false;
  if (model.contextWindow !== undefined && !isFiniteNumber(model.contextWindow)) return false;
  if (model.maxTokens !== undefined && !isFiniteNumber(model.maxTokens)) return false;
  if (model.samplingParams !== undefined && !asRecord(model.samplingParams)) return false;
  if (model.headers !== undefined && !isRecordOfStrings(model.headers)) return false;
  return true;
}

function isValidModelOverride(value: unknown): boolean {
  const override = asRecord(value);
  if (!override || !isValidCompatRecord(override.compat)) return false;
  if (!isOptionalString(override.name) || !isOptionalBoolean(override.reasoning)) return false;
  if (override.thinkingLevelMap !== undefined && !isThinkingLevelMap(override.thinkingLevelMap)) return false;
  if (override.input !== undefined && (!Array.isArray(override.input) || !override.input.every((entry) => entry === "text" || entry === "image"))) return false;
  if (override.cost !== undefined && !isValidModelCost(override.cost, true)) return false;
  if (override.contextWindow !== undefined && !isFiniteNumber(override.contextWindow)) return false;
  if (override.maxTokens !== undefined && !isFiniteNumber(override.maxTokens)) return false;
  if (override.samplingParams !== undefined && !asRecord(override.samplingParams)) return false;
  if (override.headers !== undefined && !isRecordOfStrings(override.headers)) return false;
  return true;
}

function isValidOpenAICompletionsCompat(compat: UnknownRecord): boolean {
  const booleanKeys = [
    "supportsStore", "supportsDeveloperRole", "supportsReasoningEffort",
    "supportsUsageInStreaming", "requiresToolResultName", "requiresAssistantAfterToolResult",
    "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages",
    "supportsOpenAIGrammarTools", "supportsStrictMode", "sendSessionAffinityHeaders",
    "supportsLongCacheRetention",
  ];
  if (booleanKeys.some((key) => !isOptionalBoolean(compat[key]))) return false;
  if (compat.maxTokensField !== undefined && compat.maxTokensField !== "max_completion_tokens" && compat.maxTokensField !== "max_tokens") return false;
  if (compat.thinkingFormat !== undefined && ![
    "openai", "openrouter", "together", "baseten", "deepseek", "zai", "qwen",
    "chat-template", "qwen-chat-template", "string-thinking", "ant-ling",
  ].includes(String(compat.thinkingFormat))) return false;
  if (compat.cacheControlFormat !== undefined && compat.cacheControlFormat !== "anthropic") return false;
  if (compat.deferredToolsMode !== undefined && compat.deferredToolsMode !== "kimi") return false;
  if (compat.sessionAffinityFormat !== undefined && !["openai", "openai-nosession", "openrouter"].includes(String(compat.sessionAffinityFormat))) return false;
  for (const key of NESTED_COMPAT_KEYS) {
    if (compat[key] !== undefined && !asRecord(compat[key])) return false;
  }
  return true;
}

function isValidOpenAIResponsesCompat(compat: UnknownRecord): boolean {
  const booleanKeys = [
    "supportsDeveloperRole", "supportsLongCacheRetention", "supportsStrictMode",
    "supportsOpenAIGrammarTools", "supportsAdditionalTools", "supportsToolSearch",
  ];
  if (booleanKeys.some((key) => !isOptionalBoolean(compat[key]))) return false;
  return compat.sessionAffinityFormat === undefined
    || ["openai", "openai-nosession", "openrouter"].includes(String(compat.sessionAffinityFormat));
}

function isValidAnthropicMessagesCompat(compat: UnknownRecord): boolean {
  return [
    "supportsEagerToolInputStreaming", "supportsLongCacheRetention",
    "sendSessionAffinityHeaders", "supportsCacheControlOnTools", "supportsTemperature",
    "forceAdaptiveThinking", "allowEmptySignature", "supportsStrictTools", "supportsToolReferences",
  ].every((key) => isOptionalBoolean(compat[key]));
}

function isValidCompatRecord(value: unknown): boolean {
  if (value === undefined) return true;
  const compat = asRecord(value);
  return !!compat
    && !Object.prototype.hasOwnProperty.call(compat, "supportsPromptCacheKey")
    && (
    isValidOpenAICompletionsCompat(compat)
    || isValidOpenAIResponsesCompat(compat)
    || isValidAnthropicMessagesCompat(compat)
  );
}

// Credential-blind fail-closed subset of Pi's models.json validation. This
// intentionally covers only fields consumed by compat diagnostics, transport
// recovery, and exact route fallback; it is not a replacement for Pi's full
// schema and must stay conservative when the file is malformed.
function isValidModelsConfigForEffectiveCompat(value: unknown): boolean {
  const root = asRecord(value);
  const providers = asRecord(root?.providers);
  if (!root || !providers) return false;

  for (const providerValue of Object.values(providers)) {
    const provider = asRecord(providerValue);
    if (!provider) return false;
    if (!isOptionalString(provider.name) || !isOptionalString(provider.baseUrl) || !isOptionalString(provider.apiKey) || !isOptionalString(provider.api)) return false;
    if (!isOptionalBoolean(provider.authHeader) || !isValidCompatRecord(provider.compat)) return false;
    if (provider.oauth !== undefined && provider.oauth !== "radius") return false;
    if (provider.headers !== undefined && !isRecordOfStrings(provider.headers)) return false;
    if (provider.models !== undefined && (!Array.isArray(provider.models) || !provider.models.every(isValidModelDefinition))) return false;
    const overrides = provider.modelOverrides === undefined ? undefined : asRecord(provider.modelOverrides);
    if (provider.modelOverrides !== undefined && (!overrides || !Object.values(overrides).every(isValidModelOverride))) return false;
  }
  return true;
}

type ModelsConfigCache = {
  signature: string;
  value: unknown | undefined;
};

let modelsConfigCache: ModelsConfigCache | undefined;

function invalidateModelsConfigCache(): void {
  modelsConfigCache = undefined;
}

function getModelsConfigSignature(): string {
  try {
    const info = statSync(MODELS_JSON_PATH);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return "missing";
  }
}

function readEffectiveCompatConfig(): unknown | undefined {
  const signature = getModelsConfigSignature();
  if (modelsConfigCache?.signature === signature) return modelsConfigCache.value;

  let value: unknown | undefined;
  if (signature !== "missing") {
    try {
      const parsed = parseJsonc(readFileSync(MODELS_JSON_PATH, "utf8"));
      value = isValidModelsConfigForEffectiveCompat(parsed) ? parsed : undefined;
    } catch {
      value = undefined;
    }
  }

  modelsConfigCache = { signature, value };
  return value;
}

function getCompat(model: PiModel | undefined): CacheCompat {
  if (!model) return {} as CacheCompat;
  return resolveEffectiveCompatFromConfig(model, readEffectiveCompatConfig());
}

function hasProviderHeader(headers: Record<string, unknown>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalized);
}

function setProviderHeaderIfMissing(
  headers: Record<string, string | null | undefined>,
  name: string,
  value: string,
): boolean {
  if (hasProviderHeader(headers, name)) return false;
  headers[name] = value;
  return true;
}

function addEffectiveSessionAffinityHeaders(
  headers: Record<string, string | null | undefined>,
  model: PiModel | undefined,
  sessionId: string | undefined,
  effectiveCompat?: CacheCompat,
  optimizerEnabled: boolean = runtimeOptimizerEnabled,
  effectiveSource?: "provider" | "model" | "runtime" | "modelOverride",
): boolean {
  if (!optimizerEnabled || !model || !isNonEmptyString(sessionId)) return false;
  if (!isOpenAICompatibleProxyApi(model.api) || !isNonEmptyString(model.baseUrl) || isOfficialOpenAIBaseUrl(model)) return false;
  const config = effectiveCompat === undefined || effectiveSource === undefined
    ? readEffectiveCompatConfig()
    : undefined;
  const compat = effectiveCompat ?? resolveEffectiveCompatFromConfig(model, config);
  const source = effectiveSource
    ?? getEffectiveCompatValueSource(model, config, "sendSessionAffinityHeaders")
    ?? (Object.prototype.hasOwnProperty.call(asRecord(model.compat) ?? {}, "sendSessionAffinityHeaders") ? "runtime" : undefined);
  if (compat.sendSessionAffinityHeaders !== true) return false;

  // Pi already handles an effective runtime-model true. The bridge is only for
  // effective values that live in models.json layers and were lost when an
  // extension provider rebuilt/replaced the runtime model object.
  if (source === "runtime") return false;

  const format = compat.sessionAffinityFormat ?? (
    lower(model.provider).includes("openrouter") || lower(model.baseUrl).includes("openrouter.ai")
      ? "openrouter"
      : "openai"
  );
  const value = sessionId.trim();
  let changed = false;
  if (format === "openrouter") {
    return setProviderHeaderIfMissing(headers, "x-session-id", value);
  }
  if (format === "openai") {
    changed = setProviderHeaderIfMissing(headers, "session_id", value) || changed;
  }
  changed = setProviderHeaderIfMissing(headers, "x-client-request-id", value) || changed;
  changed = setProviderHeaderIfMissing(headers, "x-session-affinity", value) || changed;
  return changed;
}

/** Join display-only path fragments without resolving them for I/O. */
function joinDisplayPath(base: string, child: string, platform: string = process.platform): string {
  const sep = platform.startsWith("win") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${child}`;
}

/**
 * Return a platform-friendly display path for Pi's agent directory.
 *
 * Derives the display path from Pi core's `getAgentDir()` result. Home-relative
 * paths use `%USERPROFILE%` on Windows and `~` on Unix-like systems; custom
 * absolute or relative agent directories remain visible as configured.
 */
function getAgentDirDisplayPath(
  platform: string = process.platform,
  agentDir: string = getAgentDir(),
  homeDir: string = homedir(),
): string {
  const sep = platform.startsWith("win") ? "\\" : "/";
  const normalizedAgentDir = agentDir.replace(/[\\/]+/g, sep);
  const normalizedHomeDir = homeDir.replace(/[\\/]+/g, sep).replace(/[\\/]+$/, "");
  const homePrefix = `${normalizedHomeDir}${sep}`;

  if (normalizedAgentDir === normalizedHomeDir || normalizedAgentDir.startsWith(homePrefix)) {
    const relative = normalizedAgentDir.slice(normalizedHomeDir.length).replace(/^[\\/]+/, "");
    const homeLabel = platform.startsWith("win") ? "%USERPROFILE%" : "~";
    return relative ? `${homeLabel}${sep}${relative}` : homeLabel;
  }

  return normalizedAgentDir;
}

/**
 * Return a platform-friendly display path for Pi's `models.json`.
 *
 * This is a DISPLAY helper only. Actual I/O uses `MODELS_JSON_PATH`, resolved
 * from the same custom agent/config directory rules as `STATE_DIR`.
 */
function getModelsJsonDisplayPath(
  platform: string = process.platform,
  agentDir: string = getAgentDir(),
  homeDir: string = homedir(),
): string {
  return joinDisplayPath(getAgentDirDisplayPath(platform, agentDir, homeDir), "models.json", platform);
}

function isEnabledEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function featureEnabled(
  feature: PersistedCacheOptimizerFeature,
  envName: string,
  defaultValue: boolean,
  env: MutableEnv = process.env,
  config: PersistedCacheOptimizerConfigV3 = persistedCacheOptimizerConfig,
): boolean {
  const configured = config.features?.[feature];
  if (configured !== undefined) return configured;
  if (feature === "virtualRewrite") return isEnabledEnv(env[envName]);
  if (feature === "promptRewrite" || feature === "skillCompression" || feature === "openAICacheKey") {
    return !isEnabledEnv(env[envName]);
  }
  return isEnabledEnv(env[envName]) || defaultValue;
}

function isToolOrderEnabled(env: MutableEnv = process.env): boolean {
  return runtimeOptimizerEnabled && featureEnabled("toolOrder", TOOL_ORDER_ENV, false);
}

function parseFooterStatsMode(value: unknown): FooterStatsMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "session" || normalized === "total" || normalized === "process" ? normalized : undefined;
}

type CommandCompletionItem = {
  value: string;
  label: string;
  description?: string;
};

const CACHE_OPTIMIZER_COMMANDS = [
  "enable",
  "disable",
  "doctor",
  "stats",
  "config",
  "compat",
  "reset",
  "fix",
  "rollback",
] as const;
const CACHE_OPTIMIZER_CONFIG_ARGUMENTS = ["footer-mode", "prompt-rewrite", "virtual-rewrite", "skill-compression", "openai-cache-key", "tool-order", "reset"] as const;
const CACHE_OPTIMIZER_FEATURE_COMMANDS = ["prompt-rewrite", "virtual-rewrite", "skill-compression", "openai-cache-key", "tool-order"] as const;
const CACHE_OPTIMIZER_FEATURE_VALUES = ["on", "off"] as const;
const CACHE_OPTIMIZER_FOOTER_MODES = ["total", "session", "process"] as const;
const FEATURE_COMMAND_MAP: Record<string, PersistedCacheOptimizerFeature> = {
  "prompt-rewrite": "promptRewrite",
  "virtual-rewrite": "virtualRewrite",
  "skill-compression": "skillCompression",
  "openai-cache-key": "openAICacheKey",
  "tool-order": "toolOrder",
};
const CACHE_OPTIMIZER_STATS_ARGUMENTS = ["all", "contributors"] as const;
const CACHE_OPTIMIZER_FIX_ARGUMENTS = ["prompt-cache-key"] as const;

function filterCommandCompletionItems(
  values: readonly string[],
  prefix: string,
  argumentPath = "",
): CommandCompletionItem[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const matches = values
    .filter((value) => value.startsWith(normalizedPrefix))
    .map((value) => ({
      // Pi replaces the complete argumentPrefix when applying a command
      // completion, so nested suggestions must include their full path.
      value: argumentPath ? `${argumentPath} ${value}` : value,
      label: value,
    }));
  return matches.length > 0 ? matches : null;
}

function getCacheOptimizerArgumentCompletions(argumentPrefix: string): CommandCompletionItem[] | null {
  if (typeof argumentPrefix !== "string") return null;
  const trimmed = argumentPrefix.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];

  if (parts.length === 0) {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_COMMANDS, "");
  }

  if (parts.length === 1) {
    const subcommandPrefix = parts[0].toLowerCase();
    // `config` is the primary `c` completion; `compat` remains available
    // through its more specific `co` prefix. Surrounding whitespace is
    // ignored so ` c ` behaves the same as `c`.
    if (subcommandPrefix === "c") {
      return [{ value: "config", label: "config" }];
    }
    if (subcommandPrefix === "config") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_CONFIG_ARGUMENTS, "", "config");
    }
    if (subcommandPrefix === "stats") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_STATS_ARGUMENTS, "", "stats");
    }
    return filterCommandCompletionItems(CACHE_OPTIMIZER_COMMANDS, parts[0]);
  }

  if (parts[0].toLowerCase() === "stats") {
    return parts.length === 2
      ? filterCommandCompletionItems(CACHE_OPTIMIZER_STATS_ARGUMENTS, parts[1], "stats")
      : null;
  }

  if (parts[0].toLowerCase() === "fix") {
    return parts.length === 2
      ? filterCommandCompletionItems(CACHE_OPTIMIZER_FIX_ARGUMENTS, parts[1], "fix")
      : null;
  }

  if (parts[0].toLowerCase() !== "config") return null;

  if (parts.length === 2) {
    const nestedPrefix = parts[1].toLowerCase();
    if (nestedPrefix === "footer-mode") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_FOOTER_MODES, "", "config footer-mode");
    }
    return filterCommandCompletionItems(CACHE_OPTIMIZER_CONFIG_ARGUMENTS, parts[1], "config");
  }

  if (parts.length === 3 && parts[1].toLowerCase() === "footer-mode") {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_FOOTER_MODES, parts[2], "config footer-mode");
  }
  if (parts.length === 3 && CACHE_OPTIMIZER_FEATURE_COMMANDS.includes(parts[1] as typeof CACHE_OPTIMIZER_FEATURE_COMMANDS[number])) {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_FEATURE_VALUES, parts[2], `config ${parts[1]}`);
  }

  return null;
}

function parsePersistedCacheOptimizerConfig(value: unknown): PersistedCacheOptimizerConfig | undefined {
  const record = asRecord(value);
  if (!record || (record.version !== 1 && record.version !== 2 && record.version !== 3)) return undefined;
  const allowedTopLevel = new Set(record.version === 1 ? ["version", "footerMode"] : record.version === 2 ? ["version", "footerMode", "promptCacheKey"] : ["version", "footerMode", "promptCacheKey", "features"]);
  if (Object.keys(record).some((key) => !allowedTopLevel.has(key))) return undefined;
  const footerMode = parseFooterStatsMode(record.footerMode);
  if (record.footerMode !== undefined && !footerMode) return undefined;
  if (record.version === 1) return { version: 1, ...(footerMode ? { footerMode } : {}) };

  const rawFeatures = record.version === 3 ? record.features : undefined;
  if (rawFeatures !== undefined && !asRecord(rawFeatures)) return undefined;
  const featuresRecord = asRecord(rawFeatures);
  const featureNames = new Set<PersistedCacheOptimizerFeature>(["promptRewrite", "virtualRewrite", "skillCompression", "openAICacheKey", "toolOrder"]);
  if (featuresRecord && Object.keys(featuresRecord).some((key) => !featureNames.has(key as PersistedCacheOptimizerFeature) || typeof featuresRecord[key] !== "boolean")) return undefined;

  const rawPromptCacheKey = record.promptCacheKey;
  if (rawPromptCacheKey !== undefined && !asRecord(rawPromptCacheKey)) return undefined;
  const promptCacheKey = asRecord(rawPromptCacheKey);
  if (promptCacheKey && Object.keys(promptCacheKey).some((key) => key !== "omit")) return undefined;
  const omit = promptCacheKey?.omit;
  if (omit !== undefined && (!Array.isArray(omit) || omit.some((value): value is string => !isNonEmptyString(value)))) return undefined;
  const stringOmit = omit as string[] | undefined;
  const uniqueOmit = stringOmit ? [...new Set(stringOmit.map((value) => value.trim()))].sort() : undefined;
  return {
    version: record.version === 3 ? 3 : 2,
    ...(footerMode ? { footerMode } : {}),
    ...(uniqueOmit && uniqueOmit.length > 0 ? { promptCacheKey: { omit: uniqueOmit } } : {}),
    ...(featuresRecord ? { features: Object.fromEntries(Object.entries(featuresRecord)) as Partial<Record<PersistedCacheOptimizerFeature, boolean>> } : {}),
  } as PersistedCacheOptimizerConfigV3;
}

function normalizePersistedCacheOptimizerConfig(value: PersistedCacheOptimizerConfig | undefined): PersistedCacheOptimizerConfigV3 {
  if (!value) return { version: 2 };
  const features = value.version === 3 ? value.features : undefined;
  return {
    version: features ? 3 : 2,
    ...(value.footerMode ? { footerMode: value.footerMode } : {}),
    ...(value.version !== 1 && value.promptCacheKey ? { promptCacheKey: value.promptCacheKey } : {}),
    ...(features ? { features } : {}),
  };
}

function readPersistedCacheOptimizerConfig(configPath: string = CONFIG_FILE_PATH): PersistedCacheOptimizerConfigV3 {
  try {
    return normalizePersistedCacheOptimizerConfig(parsePersistedCacheOptimizerConfig(JSON.parse(readFileSync(configPath, "utf8"))));
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to read optimizer config; using defaults`, error);
    return { version: 2 };
  }
}

function readPersistedFooterMode(configPath: string = CONFIG_FILE_PATH): FooterStatsMode | undefined {
  return readPersistedCacheOptimizerConfig(configPath).footerMode;
}

async function writePersistedCacheOptimizerConfigUnlocked(
  config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3,
  configPath: string,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const payloadText = JSON.stringify(normalizePersistedCacheOptimizerConfig(config), null, 2) + "\n";
  let targetInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  let targetMode = 0o600;
  let targetHash: string | undefined;
  try {
    targetInfo = await lstat(configPath);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error("optimizer config is not a regular file; no changes were made");
    const targetText = await readFile(configPath, "utf8");
    targetMode = targetInfo.mode & 0o7777;
    targetHash = hashText(targetText);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  if (targetInfo) {
    await atomicReplaceTextFilePreservingMode(configPath, payloadText, targetMode, "config", {
      identity: targetInfo,
      hash: targetHash,
      mode: targetMode,
    });
    return;
  }

  await atomicCreateTextFileNoReplace(configPath, payloadText, targetMode, "config");
}

async function writePersistedCacheOptimizerConfig(
  config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3,
  configPath: string = CONFIG_FILE_PATH,
): Promise<void> {
  await withModelsJsonTransactionLock(() => writePersistedCacheOptimizerConfigUnlocked(config, configPath));
}

async function writePersistedFooterModeUnlocked(
  mode: FooterStatsMode,
  configPath: string,
): Promise<void> {
  let version: 1 | 2 | 3 = 1;
  let raw: PersistedCacheOptimizerConfig | undefined;
  let targetExists = false;
  try {
    raw = parsePersistedCacheOptimizerConfig(JSON.parse(readFileSync(configPath, "utf8")));
    targetExists = true;
    if (!raw) throw new Error("invalid footer config schema");
    version = raw.version === 3 ? 3 : raw.version === 2 ? 2 : 1;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw new Error("invalid footer config schema");
  }
  const current = normalizePersistedCacheOptimizerConfig(raw);
  if (version === 1 && !current.promptCacheKey) {
    await mkdir(dirname(configPath), { recursive: true });
    const targetInfo = targetExists ? await lstat(configPath) : undefined;
    if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) throw new Error("optimizer config is not a regular file; no changes were made");
    const targetText = targetInfo ? await readFile(configPath, "utf8") : undefined;
    const targetMode = targetInfo ? targetInfo.mode & 0o7777 : 0o600;
    const footerText = JSON.stringify({ version: 1, footerMode: mode }, null, 2) + "\n";
    if (targetInfo && targetText !== undefined) {
      await atomicReplaceTextFilePreservingMode(configPath, footerText, targetMode, "config-footer", {
        identity: targetInfo,
        hash: hashText(targetText),
        mode: targetMode,
      });
    } else {
      await atomicCreateTextFileNoReplace(configPath, footerText, targetMode, "config-footer");
    }
    return;
  }
  await writePersistedCacheOptimizerConfigUnlocked({ ...current, version: 3, footerMode: mode } as PersistedCacheOptimizerConfigV3, configPath);
}

async function writePersistedFooterMode(
  mode: FooterStatsMode,
  configPath: string = CONFIG_FILE_PATH,
): Promise<void> {
  await withModelsJsonTransactionLock(() => writePersistedFooterModeUnlocked(mode, configPath));
}

async function writePersistedFeature(feature: PersistedCacheOptimizerFeature, enabled: boolean): Promise<void> {
  const current = readPersistedCacheOptimizerConfig();
  const next: PersistedCacheOptimizerConfigV3 = {
    ...current,
    version: 3,
    features: { ...(current.features ?? {}), [feature]: enabled },
  };
  await writePersistedCacheOptimizerConfig(next);
  setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
}

function configReceiptBackupPath(receipt: PromptCacheKeyConfigReceipt, receiptPath: string = CONFIG_RECEIPT_PATH): string {
  return join(dirname(receiptPath), receipt.backupFile);
}

function parsePromptCacheKeyConfigReceipt(value: unknown): PromptCacheKeyConfigReceipt | undefined {
  const record = asRecord(value);
  if (!record || (record.version !== 1 && record.version !== 2) || record.kind !== "pi-cache-optimizer-config-receipt") return undefined;
  const allowed = new Set(record.version === 1
    ? ["version", "kind", "transactionId", "provider", "modelId", "beforeHash", "afterHash", "backupFile", "targetExistedBefore", "createdAt", "appliedAt", "status", "rolledBackAt"]
    : ["version", "kind", "transactionId", "provider", "modelId", "beforeHash", "afterHash", "backupFile", "targetExistedBefore", "targetHadModelKey", "addedModelKey", "createdAt", "appliedAt", "status", "rolledBackAt"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  if (![record.transactionId, record.provider, record.modelId].every(isSafeReceiptText)) return undefined;
  if (!isSha256(record.beforeHash) || !isSha256(record.afterHash) || record.beforeHash === record.afterHash) return undefined;
  if (!isSafeReceiptText(record.backupFile) || basename(record.backupFile) !== record.backupFile || !record.backupFile.startsWith("pi-cache-optimizer-config.backup-")) return undefined;
  if (
    typeof record.targetExistedBefore !== "boolean" ||
    !isReceiptTimestamp(record.createdAt) ||
    !isReceiptTimestamp(record.appliedAt) ||
    record.appliedAt < record.createdAt
  ) return undefined;
  const addedModelKey = `${record.provider}/${record.modelId}`;
  const targetHadModelKey = record.version === 1 ? false : record.targetHadModelKey;
  if (typeof targetHadModelKey !== "boolean") return undefined;
  if (record.version === 2 && (!isSafeReceiptText(record.addedModelKey) || record.addedModelKey !== addedModelKey)) return undefined;
  if (record.status !== undefined && record.status !== "rolled_back") return undefined;
  if (record.status === "rolled_back" && (!isReceiptTimestamp(record.rolledBackAt) || record.rolledBackAt < record.appliedAt)) return undefined;
  if (record.status === undefined && record.rolledBackAt !== undefined) return undefined;
  return {
    version: 2,
    kind: "pi-cache-optimizer-config-receipt",
    transactionId: String(record.transactionId),
    provider: String(record.provider),
    modelId: String(record.modelId),
    beforeHash: String(record.beforeHash).toLowerCase(),
    afterHash: String(record.afterHash).toLowerCase(),
    backupFile: String(record.backupFile),
    targetExistedBefore: record.targetExistedBefore,
    targetHadModelKey,
    addedModelKey,
    createdAt: Number(record.createdAt),
    appliedAt: Number(record.appliedAt),
    ...(record.status === "rolled_back" ? { status: "rolled_back", rolledBackAt: Number(record.rolledBackAt) } : {}),
  };
}

function isActionablePromptCacheKeyConfigReceipt(receipt: PromptCacheKeyConfigReceipt | undefined): receipt is PromptCacheKeyConfigReceipt {
  return receipt !== undefined && receipt.status === undefined;
}

async function assertPromptCacheKeyConfigReceiptSnapshotUnchanged(
  snapshot: PromptCacheKeyConfigReceiptSnapshot,
): Promise<void> {
  const info = await lstat(snapshot.receiptPath);
  if (info.isSymbolicLink() || !info.isFile() || !sameFileIdentity(snapshot.identity, info)) {
    throw new Error("prompt-cache-key receipt changed since the rollback preview");
  }
  const text = await readFile(snapshot.receiptPath, "utf8");
  const afterRead = await lstat(snapshot.receiptPath);
  if (
    afterRead.isSymbolicLink() ||
    !afterRead.isFile() ||
    !sameFileIdentity(info, afterRead) ||
    hashText(text) !== snapshot.hash
  ) {
    throw new Error("prompt-cache-key receipt changed since the rollback preview");
  }
}

async function readPromptCacheKeyConfigReceiptSnapshot(
  receiptPath: string = CONFIG_RECEIPT_PATH,
): Promise<PromptCacheKeyConfigReceiptSnapshot | undefined> {
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    const text = await readFile(receiptPath, "utf8");
    const afterRead = await lstat(receiptPath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || !sameFileIdentity(info, afterRead)) return undefined;
    const receipt = parsePromptCacheKeyConfigReceipt(JSON.parse(text));
    if (!receipt) return undefined;
    return { receipt, receiptPath, hash: hashText(text), identity: afterRead };
  } catch {
    return undefined;
  }
}

async function readPromptCacheKeyConfigReceipt(receiptPath: string = CONFIG_RECEIPT_PATH): Promise<PromptCacheKeyConfigReceipt | undefined> {
  return (await readPromptCacheKeyConfigReceiptSnapshot(receiptPath))?.receipt;
}

async function writePromptCacheKeyConfigReceipt(
  receipt: PromptCacheKeyConfigReceipt,
  receiptPath: string = CONFIG_RECEIPT_PATH,
  expectedSnapshot?: PromptCacheKeyConfigReceiptSnapshot,
  /** Test-only race injector; production callers leave this undefined. */
  beforeRename?: () => Promise<void>,
): Promise<void> {
  if (!parsePromptCacheKeyConfigReceipt(receipt)) throw new Error("invalid prompt cache key config receipt");
  if (expectedSnapshot?.receiptPath !== undefined && expectedSnapshot.receiptPath !== receiptPath) {
    throw new Error("prompt-cache-key receipt path changed since the rollback preview");
  }
  if (expectedSnapshot) await assertPromptCacheKeyConfigReceiptSnapshotUnchanged(expectedSnapshot);
  await mkdir(dirname(receiptPath), { recursive: true });
  let existingReceiptInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("invalid prompt-cache-key receipt path");
    existingReceiptInfo = info;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  const tempPath = uniqueTempPath(receiptPath, "config-receipt");
  try {
    await writeFile(tempPath, JSON.stringify(receipt, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) throw new Error("invalid temporary prompt-cache-key receipt");
    await chmod(tempPath, 0o600);
    const assertDestinationUnchanged = async (): Promise<void> => {
      try {
        const currentInfo = await lstat(receiptPath);
        if (!existingReceiptInfo || !sameFileIdentity(existingReceiptInfo, currentInfo)) {
          throw new Error("prompt-cache-key receipt changed during atomic write");
        }
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT" || existingReceiptInfo) throw error;
      }
      if (expectedSnapshot) await assertPromptCacheKeyConfigReceiptSnapshotUnchanged(expectedSnapshot);
    };
    await assertDestinationUnchanged();
    if (beforeRename) await beforeRename();
    await assertDestinationUnchanged();
    if (existingReceiptInfo) {
      await rename(tempPath, receiptPath);
    } else {
      await link(tempPath, receiptPath);
      await unlink(tempPath).catch((cleanupError) => {
        console.warn(`${LOG_PREFIX}: committed prompt-cache-key receipt but failed to remove its temporary hard link`, cleanupError);
      });
    }
  } catch (error) {
    await unlink(tempPath).catch((cleanupError) => { if (getErrorCode(cleanupError) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to remove temporary config receipt`, cleanupError); });
    throw error;
  }
}

async function applyPromptCacheKeyConfigFixUnderLock(
  model: PiModel,
  configPath: string = CONFIG_FILE_PATH,
  receiptPath: string = CONFIG_RECEIPT_PATH,
): Promise<{ receipt: PromptCacheKeyConfigReceipt; backupPath: string }> {
  await mkdir(dirname(configPath), { recursive: true });
  let originalText = "";
  let targetExistedBefore = false;
  let mode = 0o600;
  try {
    const info = await lstat(configPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("optimizer config is not a regular file; no changes were made");
    originalText = await readFile(configPath, "utf8");
    targetExistedBefore = true;
    mode = info.mode & 0o7777;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  const parsedCurrent = targetExistedBefore ? parsePersistedCacheOptimizerConfig(JSON.parse(originalText)) : undefined;
  if (targetExistedBefore && !parsedCurrent) throw new Error("optimizer config is invalid; no changes were made");
  const current = normalizePersistedCacheOptimizerConfig(parsedCurrent);
  const key = modelKey(model);
  const existingOmit = current.promptCacheKey?.omit ?? [];
  const targetHadModelKey = existingOmit.includes(key);
  if (targetHadModelKey) throw new Error("prompt-cache-key is already configured; no changes were made");
  const omit = [...new Set([...existingOmit, key])].sort();
  const next: PersistedCacheOptimizerConfigV2 = { ...current, version: 2, promptCacheKey: { omit } };
  const modifiedText = JSON.stringify(next, null, 2) + "\n";
  const beforeHash = hashText(originalText);
  const afterHash = hashText(modifiedText);
  const originalInfo = targetExistedBefore ? await lstat(configPath) : undefined;
  const backupFile = `pi-cache-optimizer-config.backup-${backupTimestamp()}`;
  const backupPath = join(dirname(configPath), backupFile);
  if (targetExistedBefore) {
    await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
    await chmod(backupPath, mode);
  }
  const tempPath = uniqueTempPath(configPath, "config-fix");
  let committedInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    await writeFile(tempPath, modifiedText, { encoding: "utf8", mode, flag: "wx" });
    await chmod(tempPath, mode);
    if (originalInfo) {
      await validateAtomicTarget(configPath, { identity: originalInfo, hash: beforeHash, mode });
    } else {
      try {
        await lstat(configPath);
        throw new Error("optimizer config appeared during the fix; no changes were made");
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") throw error;
      }
    }
    if (originalInfo) {
      await rename(tempPath, configPath);
      committedInfo = await lstat(configPath);
    } else {
      // Do not overwrite a config created after the absence check. Record the
      // committed inode before cleaning up its temporary hard-link name so a
      // cleanup failure can still compensate the config transaction.
      await link(tempPath, configPath);
      committedInfo = await lstat(configPath);
      await unlink(tempPath).catch((cleanupError) => {
        console.warn(`${LOG_PREFIX}: committed optimizer config but failed to remove its temporary hard link`, cleanupError);
      });
    }
    const receipt: PromptCacheKeyConfigReceipt = {
      version: 2,
      kind: "pi-cache-optimizer-config-receipt",
      transactionId: randomUUID(),
      provider: model.provider,
      modelId: model.id,
      beforeHash,
      afterHash,
      backupFile,
      targetExistedBefore,
      targetHadModelKey,
      addedModelKey: key,
      createdAt: Date.now(),
      appliedAt: Date.now(),
    };
    await writePromptCacheKeyConfigReceipt(receipt, receiptPath);
    return { receipt, backupPath };
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    try {
      if (targetExistedBefore && committedInfo) {
        await atomicRestoreFileFromBackup(backupPath, configPath, mode, { identity: committedInfo, hash: afterHash, mode });
      } else if (!targetExistedBefore && committedInfo) {
        await validateAtomicTarget(configPath, { identity: committedInfo, hash: afterHash, mode });
        await unlink(configPath);
      }
    } catch (compensationError) {
      const writeMessage = error instanceof Error ? error.message : String(error);
      const compensationMessage = compensationError instanceof Error ? compensationError.message : String(compensationError);
      throw new Error(`prompt-cache-key fix receipt update failed (${writeMessage}) and config compensation failed (${compensationMessage})`);
    }
    throw error;
  }
}

async function applyPromptCacheKeyConfigFix(
  model: PiModel,
  configPath: string = CONFIG_FILE_PATH,
  receiptPath: string = CONFIG_RECEIPT_PATH,
): Promise<{ receipt: PromptCacheKeyConfigReceipt; backupPath: string }> {
  return withModelsJsonTransactionLock(() => applyPromptCacheKeyConfigFixUnderLock(model, configPath, receiptPath));
}

type PromptCacheKeyRollbackOptions = {
  /** Test-only race injector; production callers leave this undefined. */
  beforeReceiptRename?: () => Promise<void>;
};

async function rollbackPromptCacheKeyConfigUnderLock(
  snapshot: PromptCacheKeyConfigReceiptSnapshot,
  configPath: string = CONFIG_FILE_PATH,
  receiptPath: string = CONFIG_RECEIPT_PATH,
  options: PromptCacheKeyRollbackOptions = {},
): Promise<void> {
  if (snapshot.receiptPath !== receiptPath) throw new Error("prompt-cache-key receipt path changed since the rollback preview");
  await assertPromptCacheKeyConfigReceiptSnapshotUnchanged(snapshot);
  const receipt = snapshot.receipt;
  const currentInfo = await lstat(configPath);
  if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) throw new Error("optimizer config is not a regular file; refusing to overwrite user changes");
  const currentText = await readFile(configPath, "utf8");
  const currentHash = hashText(currentText);
  const currentMode = currentInfo.mode & 0o7777;
  if (currentHash !== receipt.afterHash) throw new Error("optimizer config changed after the fix; refusing to overwrite user changes");
  const current = parsePersistedCacheOptimizerConfig(JSON.parse(currentText));
  if (!current) throw new Error("optimizer config is invalid; refusing to overwrite user changes");
  const key = `${receipt.provider}/${receipt.modelId}`;
  if (receipt.addedModelKey !== key) throw new Error("prompt-cache-key receipt identity does not match; refusing to change user config");
  if (receipt.targetHadModelKey) throw new Error("prompt-cache-key was already configured before this fix; refusing to remove user configuration");
  const omit = current.version === 2 ? current.promptCacheKey?.omit ?? [] : [];
  if (!omit.includes(receipt.addedModelKey)) throw new Error("prompt-cache-key opt-out is no longer present; refusing to change user config");

  let rollbackResultText: string | undefined;
  let rollbackResultMode: number | undefined;
  let rollbackResultInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  const backupPath = configReceiptBackupPath(receipt, receiptPath);
  if (receipt.targetExistedBefore) {
    const backupInfo = await lstat(backupPath);
    if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) throw new Error("config backup is not a regular file");
    const backupText = await readFile(backupPath, "utf8");
    if (hashText(backupText) !== receipt.beforeHash) throw new Error("config backup hash does not match the fix receipt");
    rollbackResultText = backupText;
    rollbackResultMode = backupInfo.mode & 0o7777;
    await atomicRestoreFileFromBackup(
      backupPath,
      configPath,
      rollbackResultMode,
      { backupHash: receipt.beforeHash, identity: currentInfo, hash: currentHash, mode: currentMode },
    );
    rollbackResultInfo = await lstat(configPath);
  } else if (current.footerMode || omit.length > 1) {
    const restored: PersistedCacheOptimizerConfigV2 = {
      version: 2,
      ...(current.footerMode ? { footerMode: current.footerMode } : {}),
      ...(omit.length > 1 ? { promptCacheKey: { omit: omit.filter((item) => item !== receipt.addedModelKey) } } : {}),
    };
    rollbackResultText = JSON.stringify(restored, null, 2) + "\n";
    rollbackResultMode = currentMode;
    await atomicReplaceTextFilePreservingMode(
      configPath,
      rollbackResultText,
      rollbackResultMode,
      "config-rollback",
      { identity: currentInfo, hash: currentHash, mode: currentMode },
    );
    rollbackResultInfo = await lstat(configPath);
  } else {
    await validateAtomicTarget(configPath, { identity: currentInfo, hash: currentHash, mode: currentMode });
    await unlink(configPath);
  }

  try {
    await writePromptCacheKeyConfigReceipt(
      { ...receipt, status: "rolled_back", rolledBackAt: Date.now() },
      receiptPath,
      snapshot,
      options.beforeReceiptRename,
    );
  } catch (receiptError) {
    // Receipt marking is part of the transaction. If it fails after the config
    // mutation, restore the exact post-fix config rather than leaving an
    // actionable receipt paired with an already-rolled-back file.
    try {
      if (rollbackResultText === undefined) {
        await atomicCreateTextFileNoReplace(configPath, currentText, currentMode, "config-rollback-compensation");
      } else {
        if (!rollbackResultInfo || rollbackResultMode === undefined) throw new Error("missing rollback result guard");
        await atomicReplaceTextFilePreservingMode(
          configPath,
          currentText,
          currentMode,
          "config-rollback-compensation",
          {
            identity: rollbackResultInfo,
            hash: hashText(rollbackResultText),
            mode: rollbackResultMode,
          },
        );
      }
    } catch (compensationError) {
      const receiptMessage = receiptError instanceof Error ? receiptError.message : String(receiptError);
      const compensationMessage = compensationError instanceof Error ? compensationError.message : String(compensationError);
      throw new Error(`prompt-cache-key rollback receipt update failed (${receiptMessage}) and config compensation failed (${compensationMessage})`);
    }
    throw receiptError;
  }
}

async function rollbackPromptCacheKeyConfig(
  snapshot: PromptCacheKeyConfigReceiptSnapshot,
  configPath: string = CONFIG_FILE_PATH,
  receiptPath: string = CONFIG_RECEIPT_PATH,
  options: PromptCacheKeyRollbackOptions = {},
): Promise<void> {
  return withModelsJsonTransactionLock(() => rollbackPromptCacheKeyConfigUnderLock(snapshot, configPath, receiptPath, options));
}

function resolveFooterStatsMode(
  configuredMode: FooterStatsMode | undefined,
  env: MutableEnv = process.env,
): { mode: FooterStatsMode; source: FooterStatsModeSource } {
  if (configuredMode) return { mode: configuredMode, source: "config" };
  const envMode = parseFooterStatsMode(env[FOOTER_MODE_ENV]);
  return envMode ? { mode: envMode, source: "env" } : { mode: "session", source: "default" };
}

function footerStatsMode(
  env: MutableEnv = process.env,
  configuredMode: FooterStatsMode | undefined = persistedFooterStatsMode,
): FooterStatsMode {
  return resolveFooterStatsMode(configuredMode, env).mode;
}

let persistedCacheOptimizerConfig = readPersistedCacheOptimizerConfig();
let persistedFooterStatsMode = persistedCacheOptimizerConfig.footerMode;

function isDisabledEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function shouldInjectOpenAIPromptCacheKey(): boolean {
  if (!runtimeOptimizerEnabled) return false;
  if (!featureEnabled("openAICacheKey", NO_OPENAI_CACHE_KEY_ENV, true)) return false;
  if (isDisabledEnv(process.env[OPENAI_CACHE_KEY_ENV])) return false;
  return true;
}

function setRuntimeOptimizerEnabled(enabled: boolean, env: MutableEnv = process.env): void {
  runtimeOptimizerEnabled = enabled;
  if (enabled) {
    requestLongCacheRetention(env);
  } else {
    restoreCacheRetentionEnv(STARTUP_CACHE_RETENTION_ENV, env);
  }
}

function isRuntimeOptimizerEnabled(): boolean {
  return runtimeOptimizerEnabled;
}

function getOptimizerRuntimeModeLines(): string[] {
  const state = runtimeOptimizerEnabled ? "enabled" : "disabled";
  const lines: string[] = [];
  lines.push(`Runtime state: ${state}`);
  lines.push(`• Prompt rewrite: ${runtimeOptimizerEnabled && featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true) ? "on" : "off"}`);
  lines.push(`• Native virtual rewrite: ${featureEnabled("virtualRewrite", VIRTUAL_REWRITE_ENV, false) ? "opt-in" : "off"}`);
  lines.push(`• Skill compression: ${featureEnabled("skillCompression", NO_SKILL_COMPRESSION_ENV, true) ? "on" : "off"}`);
  lines.push(`• Deterministic tool ordering: ${isToolOrderEnabled() ? "on (verified built-in payloads, opt-in)" : "off"}`);
  lines.push(`• OpenAI prompt_cache_key fallback: ${shouldInjectOpenAIPromptCacheKey() ? "on" : "off"}`);
  lines.push(`• Footer cache stats: on${runtimeOptimizerEnabled ? "" : " (comparison mode)"}`);
  lines.push(`• Compat warnings: ${runtimeOptimizerEnabled ? "on" : "off"}`);
  lines.push(`• ${PI_CACHE_RETENTION_ENV}: ${process.env[PI_CACHE_RETENTION_ENV] ?? "(unset)"}`);
  lines.push(`• Persistent feature overrides: ${Object.keys(persistedCacheOptimizerConfig.features ?? {}).length > 0 ? "configured" : "none"}`);
  if (!runtimeOptimizerEnabled) {
    lines.push("This is a current-process switch. Run /reload or restart Pi to return to startup behavior.");
  } else if (!featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true) || !shouldInjectOpenAIPromptCacheKey()) {
    lines.push("Some features are still disabled by environment variables.");
  }
  return lines;
}

function formatPersistentFeatureConfig(): string {
  const features = persistedCacheOptimizerConfig.features ?? {};
  const lines = ["Persistent feature configuration:"];
  const entries: Array<[string, PersistedCacheOptimizerFeature, string, boolean]> = [
    ["Prompt rewrite", "promptRewrite", NO_PROMPT_REWRITE_ENV, true],
    ["Native virtual rewrite", "virtualRewrite", VIRTUAL_REWRITE_ENV, false],
    ["Skill compression", "skillCompression", NO_SKILL_COMPRESSION_ENV, true],
    ["OpenAI cache key", "openAICacheKey", NO_OPENAI_CACHE_KEY_ENV, true],
    ["Tool ordering", "toolOrder", TOOL_ORDER_ENV, false],
  ];
  for (const [label, feature, envName, defaultValue] of entries) {
    const source = features[feature] !== undefined ? "config" : process.env[envName] !== undefined ? "env" : "default";
    lines.push(`• ${label}: ${featureEnabled(feature, envName, defaultValue) ? "on" : "off"} (${source})`);
  }
  return lines.join("\n");
}

function formatOptimizerRuntimeMode(): string {
  return getOptimizerRuntimeModeLines().join("\n");
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

function isAnthropicMessagesApi(api: unknown): boolean {
  return lower(api) === "anthropic-messages";
}

function isOpenAICompatibleProxyApi(api: unknown): boolean {
  return lower(api) === "openai-completions";
}

function isPiBuiltInLlamaCppModel(model: PiModel | undefined): boolean {
  if (lower(model?.provider) !== "llama.cpp" || !isOpenAICompatibleProxyApi(model?.api)) return false;

  // Pi's built-in llama.cpp provider supplies this exact explicit compat
  // fingerprint. Provider ids are extension-overridable and models.json can add
  // cache/routing overrides, so provider id alone must never imply exemption.
  // supportsUsageInStreaming is deliberately not part of the fingerprint: Pi
  // 0.82.x sets it false and Pi 0.83+ sets it true after fixing streamed usage,
  // and it carries no routing or cache configuration.
  const compat = getCompat(model);
  return compat.supportsStore === false
    && compat.supportsDeveloperRole === false
    && compat.supportsReasoningEffort === false
    && compat.supportsStrictMode === false
    && compat.maxTokensField === "max_tokens"
    && compat.sendSessionAffinityHeaders === undefined
    && compat.sessionAffinityFormat === undefined
    && compat.supportsLongCacheRetention === undefined;
}

function shouldInjectOpenAIPromptCacheKeyForModel(model: PiModel | undefined): boolean {
  // Pi 0.99.2 has no native supportsPromptCacheKey compat field. Per-model
  // opt-out is owned by this extension's promptCacheKey.omit configuration;
  // this helper only exposes the transport API gate for fixture consumers.
  return isOpenAICompatibleApi(model?.api);
}

function isPromptCacheKeyOmittedForModel(model: PiModel | undefined, config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3 = persistedCacheOptimizerConfig): boolean {
  if (!model || !isOpenAICompatibleApi(model.api)) return false;
  return "promptCacheKey" in config && config.promptCacheKey?.omit?.includes(modelKey(model)) === true;
}

function setPersistedCacheOptimizerConfig(config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3): void {
  persistedCacheOptimizerConfig = normalizePersistedCacheOptimizerConfig(config);
  persistedFooterStatsMode = persistedCacheOptimizerConfig.footerMode;
}

function omitOpenAIPromptCacheKeys(payload: unknown): unknown | undefined {
  const record = asRecord(payload);
  if (!record || (!Object.prototype.hasOwnProperty.call(record, "prompt_cache_key") && !Object.prototype.hasOwnProperty.call(record, "promptCacheKey"))) return undefined;
  const copy = { ...record };
  delete copy.prompt_cache_key;
  delete copy.promptCacheKey;
  return copy;
}

function collectAnthropicCacheControlsInWireOrder(payload: unknown): UnknownRecord[] {
  const record = asRecord(payload);
  if (!record) return [];

  const controls: UnknownRecord[] = [];
  const collectFromBlock = (value: unknown): void => {
    const cacheControl = asRecord(asRecord(value)?.cache_control);
    if (cacheControl?.type === "ephemeral") controls.push(cacheControl);
  };

  // Anthropic processes cache breakpoints in tools → system → messages order.
  if (Array.isArray(record.tools)) {
    for (const tool of record.tools) collectFromBlock(tool);
  }
  if (Array.isArray(record.system)) {
    for (const block of record.system) collectFromBlock(block);
  }
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      const content = asRecord(message)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) collectFromBlock(block);
    }
  }

  return controls;
}

/**
 * Anthropic requires every 1h cache breakpoint to precede every 5m breakpoint.
 * An ephemeral cache_control without ttl uses Anthropic's default 5m retention.
 * If the final serialized payload contains a short → long transition, downgrade
 * all 1h breakpoints to the default 5m so the request remains valid.
 */
function downgradeAnthropicLongCacheControls(payload: unknown): boolean {
  let changed = false;
  for (const control of collectAnthropicCacheControlsInWireOrder(payload)) {
    if (control.ttl === "1h") {
      delete control.ttl;
      changed = true;
    }
  }
  return changed;
}

function hasAnthropicCacheTtlOrderError(message: unknown): boolean {
  const record = getAssistantRecord(message);
  if (record?.stopReason !== "error" || typeof record.errorMessage !== "string") return false;

  const error = lower(record.errorMessage);
  return error.includes("cache_control") &&
    error.includes("ttl='1h'") &&
    error.includes("ttl='5m'") &&
    error.includes("must not come after");
}

function normalizeAnthropicCacheControlTtlOrder(payload: unknown): boolean {
  const controls = collectAnthropicCacheControlsInWireOrder(payload);
  let seenShort = false;
  let hasInvalidLongAfterShort = false;

  for (const control of controls) {
    const ttl = control.ttl;
    if (ttl === undefined || ttl === "5m") {
      seenShort = true;
    } else if (ttl === "1h" && seenShort) {
      hasInvalidLongAfterShort = true;
      break;
    }
  }
  if (!hasInvalidLongAfterShort) return false;

  return downgradeAnthropicLongCacheControls(payload);
}

function isResponsesPromptRewriteBypassApi(api: unknown): boolean {
  const value = lower(api);
  return value === "openai-codex-responses" || value === "openai-responses" || value === "azure-openai-responses";
}

function isMistralConversationsApi(api: unknown): boolean {
  return lower(api) === "mistral-conversations";
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

// ── Adaptive generation model detection ────────────────────────────

/**
 * Check whether the model id uses Anthropic's adaptive generation (thinking)
 * that requires `forceAdaptiveThinking: true` in compat.
 *
 * Adaptive-generation models (from pi-ai built-in catalog) include:
 *   claude-opus-4-6, claude-opus-4-7, claude-opus-4-8 (also dotted 4.6/4.7/4.8)
 *   claude-sonnet-4-6, claude-sonnet-5
 *   claude-fable-5
 *
 * We match broadly: opus >= 4-6, sonnet >= 4-6, fable >= 5.
 * Ids may carry date-stamp or size suffixes like "[1M]".
 */
const ADAPTIVE_OPUS_PATTERN = /(^|[\/\s:_-])(opus-4[.-][6-9]|opus-4-[1-9][0-9]|opus-([5-9]|[1-9][0-9]))($|[-_.:\/\s\[])/i;
const ADAPTIVE_SONNET_PATTERN = /(^|[\/\s:_-])(sonnet-4[.-][6-9]|sonnet-4-[1-9][0-9]|sonnet-([5-9]|[1-9][0-9]))($|[-_.:\/\s\[])/i;
const ADAPTIVE_FABLE_PATTERN = /(^|[\/\s:_-])fable-([5-9]|[1-9][0-9])($|[-_.:\/\s\[])/i;

function isAdaptiveGenerationModel(model: PiModel | undefined): boolean {
  if (!model) return false;
  const tokens = getModelIdNameTokenValues(model);
  return tokens.some((t) => ADAPTIVE_OPUS_PATTERN.test(t) || ADAPTIVE_SONNET_PATTERN.test(t) || ADAPTIVE_FABLE_PATTERN.test(t));
}

function isKimiCodingAdaptiveModel(model: PiModel | undefined): boolean {
  if (!model) return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl);
  const isKimiCodingChannel = provider.includes("kimi-coding") || baseUrl.includes("api.kimi.com/coding");
  if (!isKimiCodingChannel) return false;

  const tokens = getModelIdNameTokenValues(model);
  return tokens.some((token) =>
    token === "k3"
    || token.includes("kimi-k3")
    || token.includes("kimi k3")
    || token.includes("kimi-for-coding")
    || token.includes("kimi for coding")
  );
}

function isKimiCodingEmptySignatureModel(model: PiModel | undefined): boolean {
  if (!isKimiCodingAdaptiveModel(model)) return false;
  return getModelIdNameTokenValues(model).some((token) =>
    token === "k3"
    || token === "kimi-k3"
    || token.startsWith("kimi-k3-")
    || token === "kimi k3"
    || token === "kimi-for-coding"
    || token === "kimi for coding"
  );
}

function isAdaptiveThinkingCompatApplicable(model: PiModel): boolean {
  // A routed registry miss may preserve the upstream API/model identity while
  // lacking a verified endpoint. Do not diagnose or suggest compat fixes for
  // that incomplete transport metadata; ordinary direct Anthropic models still
  // use their normal native adaptive-thinking check.
  if (isRoutedFallbackModel(model) && !isNonEmptyString(model.baseUrl)) {
    return false;
  }

  return lower(model.api) === "anthropic-messages"
    && (isAdaptiveGenerationModel(model) || isKimiCodingAdaptiveModel(model));
}

function describeMissingAdaptiveThinkingCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];
  if (compat.forceAdaptiveThinking !== true) {
    missing.push("forceAdaptiveThinking");
  }
  if (isKimiCodingEmptySignatureModel(model) && compat.allowEmptySignature !== true) {
    missing.push("allowEmptySignature");
  }
  return missing;
}

function buildAdaptiveThinkingCompatSuggestion(missing: string[]): Record<string, unknown> {
  const suggestion: Record<string, unknown> = {};
  if (missing.includes("forceAdaptiveThinking")) {
    suggestion.forceAdaptiveThinking = true;
  }
  if (missing.includes("allowEmptySignature")) {
    suggestion.allowEmptySignature = true;
  }
  return suggestion;
}

function appendAdaptiveThinkingCompatAdviceLines(lines: string[], missing: string[], placement: CompatAdvicePlacement = {}): void {
  const suggestion = buildAdaptiveThinkingCompatSuggestion(missing);
  if (Object.keys(suggestion).length > 0) {
    lines.push("Suggested fix:");
    lines.push(JSON.stringify(suggestion, null, 2));
  }
  lines.push("- forceAdaptiveThinking: true tells Pi to use adaptive thinking format");
  lines.push("  (thinking: {type: 'adaptive'}) instead of legacy budget tokens format.");
  lines.push("  Without this flag, Pi sends legacy thinking which adaptive-only upstreams reject.");
  if (missing.includes("allowEmptySignature")) {
    lines.push("- allowEmptySignature: true preserves Kimi Coding K3 thinking blocks whose replay signature is empty.");
  }
  appendCredentialSafeProviderGuidance(lines, placement, suggestion);
}

function buildAdaptiveThinkingCompatWarningText(key: string, missing: string[]): string {
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;
  const modelsJsonPath = getModelsJsonDisplayPath();
  const lines: string[] = [
    `💡 pi-cache-optimizer: ${key} is an adaptive-generation model but merged compat lacks ${missing.join(" and ")}.`,
    `Without the required compat, Pi may send legacy thinking or replay thinking blocks incorrectly.`,
    `Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (at the same level as baseUrl/api/apiKey/models).`,
    "",
  ];
  appendAdaptiveThinkingCompatAdviceLines(lines, missing, { providerLabel, modelId });
  return lines.join("\n");
}

// ── Non-GPT OpenAI-compatible model detection ──────────────────────

function isKimiLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["kimi"]);
}
function isKimiLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["kimi"]);
}

function isQwenLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["qwen"]);
}
function isQwenLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["qwen"]);
}

function isGLMLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["glm"]);
}
function isGLMLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["glm"]);
}

function isMiniMaxLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["minimax"]);
}
function isMiniMaxLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["minimax"]);
}

function isMimoLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["xiaomimimo"]) || tokens.some((t) => MIMO_MODEL_PATTERN.test(t));
}
function isMimoLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["xiaomimimo"]) || allTokens.some((t) => MIMO_MODEL_PATTERN.test(t));
}

function isHunyuanLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["hunyuan"]);
}
function isHunyuanLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["hunyuan"]);
}

// ── Additional OpenAI-compatible model detection ──────────────────

function isMistralLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["mistral", "mixtral", "codestral"]);
}
function isMistralLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["mistral", "mixtral", "codestral"]);
}

function isGrokLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["grok"]) || tokens.some((t) => XAI_MODEL_PATTERN.test(t));
}
function isGrokLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["grok"]) || allTokens.some((t) => XAI_MODEL_PATTERN.test(t));
}

function isLlamaLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["llama"]);
}
function isLlamaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["llama"]);
}

function isNemotronLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["nemotron"]);
}
function isNemotronLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["nemotron"]);
}

function isCohereLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["cohere", "command-r"]);
}
function isCohereLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["cohere", "command-r"]);
}

const YI_MODEL_PATTERN = /(^|[\/\s:_-])yi($|[\-_.:\/\s])/;

function isYiLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["yi-", "01-ai", "zero-one"]) || tokens.some((t) => YI_MODEL_PATTERN.test(t));
}
function isYiLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["yi-", "01-ai", "zero-one"]) || allTokens.some((t) => YI_MODEL_PATTERN.test(t));
}

// ── More OpenAI-compatible model detection (batch 2) ───────────────

const DOUBAO_SEED_PATTERN = /(^|[\/\s:_-])seed($|[\-_.:\/\s])/i;

function isDoubaoLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["doubao", "豆包", "volcengine", "bytedance", "byte-dance"]) ||
    tokens.some((t) => DOUBAO_SEED_PATTERN.test(t));
}
function isDoubaoLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["doubao", "豆包", "volcengine", "bytedance", "byte-dance"]) ||
    allTokens.some((t) => DOUBAO_SEED_PATTERN.test(t));
}

function isErnieLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["ernie", "wenxin", "文心", "yiyan", "一言", "baidu"]);
}
function isErnieLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["ernie", "wenxin", "文心", "yiyan", "一言", "baidu"]);
}

function isBaichuanLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["baichuan", "百川"]);
}
function isBaichuanLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["baichuan", "百川"]);
}

function isStepFunLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["stepfun", "step-"]);
}
function isStepFunLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["stepfun", "step-"]);
}

function isSparkLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["spark", "xinghuo", "星火", "iflytek", "讯飞"]);
}
function isSparkLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["spark", "xinghuo", "星火", "iflytek", "讯飞"]);
}

function isInternLMLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["internlm", "intern-lm", "书生"]);
}
function isInternLMLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["internlm", "intern-lm", "书生"]);
}

function isGemmaLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["gemma"]);
}
function isGemmaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["gemma"]);
}

const PHI_MODEL_PATTERN = /(^|[\/\s:_-])phi($|[\-_.:\/\s])/i;

function isPhiLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["phi-"]) || tokens.some((t) => PHI_MODEL_PATTERN.test(t));
}
function isPhiLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["phi-"]) || allTokens.some((t) => PHI_MODEL_PATTERN.test(t));
}

function isJambaLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["jamba", "ai21"]);
}
function isJambaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["jamba", "ai21"]);
}

function isSolarLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["solar", "upstage"]);
}
function isSolarLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["solar", "upstage"]);
}

// ── New OpenAI-compatible model detection (batch 3, 12 families) ──────

// Perplexity / Sonar
function isPerplexityLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["sonar", "perplexity"]) || tokens.some((t) => PPLX_MODEL_PATTERN.test(t));
}
function isPerplexityLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["sonar", "perplexity"]) || allTokens.some((t) => PPLX_MODEL_PATTERN.test(t));
}

// Amazon Nova
function isNovaLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["amazon-nova"]) || tokens.some((t) => NOVA_MODEL_PATTERN.test(t));
}
function isNovaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["amazon-nova"]) || allTokens.some((t) => NOVA_MODEL_PATTERN.test(t));
}

// Reka
function isRekaLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["reka"]);
}
function isRekaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["reka"]);
}

// Falcon / TII
function isFalconLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["falcon", "tiiuae"]);
}
function isFalconLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["falcon", "tiiuae"]);
}

// Databricks DBRX
function isDbrxLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["dbrx", "databricks"]);
}
function isDbrxLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["dbrx", "databricks"]);
}

// MosaicML MPT
function isMptLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["mosaicml", "mpt-"]) || tokens.some((t) => MPT_MODEL_PATTERN.test(t));
}
function isMptLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["mosaicml", "mpt-"]) || allTokens.some((t) => MPT_MODEL_PATTERN.test(t));
}

// StableLM / Stability AI
function isStableLMLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["stablelm", "stable-lm", "stability-ai"]);
}
function isStableLMLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["stablelm", "stable-lm", "stability-ai"]);
}

// BAAI / Aquila
function isAquilaLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["aquila", "baai"]);
}
function isAquilaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["aquila", "baai"]);
}

// LG EXAONE
function isExaoneLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["exaone"]);
}
function isExaoneLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["exaone"]);
}

// Naver HyperCLOVA X (conservative: hyperclova, clova-x only)
function isHyperCLOVALikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["hyperclova", "clova-x"]);
}
function isHyperCLOVALikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["hyperclova", "clova-x"]);
}

// Aleph Alpha Luminous
function isLuminousLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["luminous", "aleph-alpha"]) || tokens.some((t) => ALEPH_MODEL_PATTERN.test(t));
}
function isLuminousLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["luminous", "aleph-alpha"]) || allTokens.some((t) => ALEPH_MODEL_PATTERN.test(t));
}

// Nous / Hermes / OpenHermes
function isHermesLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["nous", "hermes", "openhermes"]);
}
function isHermesLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["nous", "hermes", "openhermes"]);
}

// ── More OpenAI-compatible model detection (batch 4, 18 families) ──

// IBM Granite
function isGraniteLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["granite", "ibm-granite"]);
}
function isGraniteLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["granite", "ibm-granite"]);
}

// Snowflake Arctic
function isArcticLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["snowflake-arctic"]) || tokens.some((t) => ARCTIC_MODEL_PATTERN.test(t));
}
function isArcticLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["snowflake-arctic"]) || allTokens.some((t) => ARCTIC_MODEL_PATTERN.test(t));
}

// Huawei Pangu / 盘古
function isPanguLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["pangu", "pan-gu", "盘古", "huawei-pangu"]);
}
function isPanguLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["pangu", "pan-gu", "盘古", "huawei-pangu"]);
}

// SenseTime SenseNova / 商汤
function isSenseNovaLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["sensenova", "sense-nova", "sensechat", "商汤"]);
}
function isSenseNovaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["sensenova", "sense-nova", "sensechat", "商汤"]);
}

// 360 Zhinao / 智脑
function isZhinaoLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["360gpt", "360-gpt", "zhinao", "智脑"]);
}
function isZhinaoLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["360gpt", "360-gpt", "zhinao", "智脑"]);
}

// OpenBMB MiniCPM
function isMiniCPMLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["minicpm", "mini-cpm", "openbmb"]);
}
function isMiniCPMLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["minicpm", "mini-cpm", "openbmb"]);
}

// XVERSE
function isXVerseLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["xverse"]);
}
function isXVerseLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["xverse"]);
}

// OrionStar Orion
function isOrionLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["orionstar", "orion-star"]) || tokens.some((t) => ORION_MODEL_PATTERN.test(t));
}
function isOrionLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["orionstar", "orion-star"]) || allTokens.some((t) => ORION_MODEL_PATTERN.test(t));
}

// OpenChat
function isOpenChatLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["openchat"]);
}
function isOpenChatLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["openchat"]);
}

// Vicuna
function isVicunaLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["vicuna"]);
}
function isVicunaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["vicuna"]);
}

// WizardLM / WizardCoder
function isWizardLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["wizardlm", "wizard-lm", "wizardcoder", "wizard-coder"]);
}
function isWizardLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["wizardlm", "wizard-lm", "wizardcoder", "wizard-coder"]);
}

// Zephyr
function isZephyrLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["zephyr"]);
}
function isZephyrLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["zephyr"]);
}

// Dolphin
function isDolphinLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["dolphin"]);
}
function isDolphinLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["dolphin"]);
}

// OpenOrca
function isOpenOrcaLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["openorca", "open-orca"]);
}
function isOpenOrcaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["openorca", "open-orca"]);
}

// Starling
function isStarlingLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["starling"]);
}
function isStarlingLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["starling"]);
}

// BLOOM / BigScience
function isBloomLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["bloom", "bigscience"]);
}
function isBloomLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["bloom", "bigscience"]);
}

// RWKV
function isRwkvLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["rwkv"]);
}
function isRwkvLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["rwkv"]);
}

// Cohere Aya
function isAyaLikeModel(model: PiModel | undefined): boolean {
  const tokens = getModelIdNameTokenValues(model);
  return hasAnyTokenContaining(tokens, ["aya-expanse"]) || tokens.some((t) => AYA_MODEL_PATTERN.test(t));
}
function isAyaLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  const allTokens = [
    ...getModelIdNameTokenValues(model),
    ...getAssistantMessageModelTokenValues(message),
  ];
  return hasAnyTokenContaining(allTokens, ["aya-expanse"]) || allTokens.some((t) => AYA_MODEL_PATTERN.test(t));
}

// ── Model key ──────────────────────────────────────────────────────

function modelKey(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

function isRouterModel(model: PiModel | undefined): boolean {
  return lower(model?.provider) === "router";
}

function modelFromAssistantMessage(message: unknown, fallback: PiModel | undefined): PiModel | undefined {
  const record = getAssistantRecord(message);
  if (!record) return fallback;

  const id = firstNonEmptyString(record.responseModel, record.model, fallback?.id);
  const provider = firstNonEmptyString(record.provider, fallback?.provider);
  const api = firstNonEmptyString(record.api, fallback?.api) ?? "";
  if (!id || !provider) return fallback;

  const fallbackName = isNonEmptyString(fallback?.name) ? fallback.name : undefined;
  const preservesFallbackIdentity =
    !isVirtualRoutingModel(fallback) &&
    provider === fallback?.provider &&
    id === fallback?.id &&
    fallbackName !== undefined;

  return {
    ...(fallback ?? {}),
    id,
    // Direct providers such as kimi-coding may echo only a short model id
    // (`k3`) while the active model name (`Kimi K3`) carries the adapter token.
    // Preserve that display name only when response and fallback identities are
    // exactly the same; routed/different identities keep message-local naming.
    name: preservesFallbackIdentity ? fallbackName : id,
    provider,
    api,
    baseUrl: fallback?.baseUrl ?? "",
    reasoning: fallback?.reasoning ?? false,
    input: fallback?.input ?? ["text"],
    cost: fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: fallback?.contextWindow ?? 0,
    maxTokens: fallback?.maxTokens ?? 0,
  } as PiModel;
}

const REQUEST_SNAPSHOT_COMPAT_KEYS: Array<keyof CacheCompat> = [
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

function snapshotCompatForDiagnostics(model: PiModel): CacheCompat {
  const source = getCompat(model);
  const snapshot: CacheCompat = {};
  const mutableSnapshot = snapshot as Record<string, unknown>;
  for (const key of REQUEST_SNAPSHOT_COMPAT_KEYS) {
    const value = source[key];
    if (value !== undefined) mutableSnapshot[key] = value;
  }
  return snapshot;
}

function snapshotBaseUrlForDiagnostics(value: unknown): string {
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

function snapshotProviderRequestModel(model: PiModel | undefined): PiModel | undefined {
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
const MAX_PROVIDER_REQUEST_STATES = 32;

function pruneProviderRequestStates<T extends { responseReceived: boolean }>(
  states: T[],
  max = MAX_PROVIDER_REQUEST_STATES,
): void {
  while (states.length > max) {
    const completed = states.findIndex((state) => state.responseReceived);
    states.splice(completed >= 0 ? completed : 0, 1);
  }
}

function keyForModelExt(model: { provider: string; id: string }): string {
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
function consolidateDirectProviderStatsModel(
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

// Pi normalizes provider-specific raw usage (prompt_cache_hit_tokens, cached_tokens,
// cache_read_input_tokens, etc.) into a common shape:
//   input     = uncached prompt portion (total prompt minus cacheRead minus cacheWrite)
//   cacheRead = tokens read from a previously-cached prefix
//   cacheWrite= tokens newly written into cache in this request
//
// We reconstruct the total prompt-token count as input + cacheRead + cacheWrite.
// Pi guarantees that input, cacheRead, and cacheWrite are always present on
// assistant messages processed through its provider pipeline (at least as zero).
//
// Only DeepSeek sets allowInputOnly=true so that a cache miss (cacheRead=0) still
// contributes total input tokens to the denominator.
function getPiNormalizedUsage(message: unknown, allowInputOnly = false): UsageSnapshot | undefined {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return undefined;

  const input = getNonNegativeNumber(usage, "input");
  const cacheRead = getNonNegativeNumber(usage, "cacheRead");
  const cacheWrite = getNonNegativeNumber(usage, "cacheWrite");
  const hasCacheSignal = cacheRead !== undefined || cacheWrite !== undefined;

  if (!hasCacheSignal && (input === undefined || !allowInputOnly)) return undefined;

  // Under healthy Pi normalization input is the uncached portion, so
  // totalInput = input + cacheRead + cacheWrite gives the full prompt token count.
  // Guard against degenerate reads where a broken proxy omits prompt_tokens and
  // Pi's input falls to zero: totalInput must never be less than cacheRead + cacheWrite.
  const computed = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const floor = (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalInput: computed >= floor ? computed : floor,
  };
}

// Raw fallback for DeepSeek responses that still carry their native usage fields.
// In practice Pi normalizes usage before message_end fires, so this path is only
// reached when Pi-normalized fields are absent (e.g. custom/foreign providers).
function getDeepSeekRawUsage(message: unknown): UsageSnapshot | undefined {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return undefined;

  const cacheRead = getFirstNonNegativeNumber(usage.prompt_cache_hit_tokens);
  if (cacheRead === undefined) return undefined;

  const cacheMiss = getFirstNonNegativeNumber(usage.prompt_cache_miss_tokens);
  const promptTokens = getFirstNonNegativeNumber(usage.prompt_tokens);
  // DeepSeek guarantees prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens.
  const totalInput = promptTokens ?? cacheRead + (cacheMiss ?? 0);

  return { cacheRead, cacheWrite: 0, totalInput };
}

// Raw fallback for OpenAI-family responses that still carry their native usage fields.
// In practice Pi normalizes usage before message_end fires, so this path is only
// reached when Pi-normalized fields are absent (e.g. custom/foreign providers).
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

// Raw fallback for Anthropic/Claude responses that still carry their native usage fields.
// In practice Pi normalizes usage before message_end fires, so this path is only
// reached when Pi-normalized fields are absent (e.g. custom/foreign providers).
function getAnthropicRawUsage(message: unknown): UsageSnapshot | undefined {
  const usage = usageRecordFromAssistant(message);
  if (!usage) return undefined;

  const cacheRead = getFirstNonNegativeNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens);
  const cacheWrite = getFirstNonNegativeNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  if (cacheRead === undefined && cacheWrite === undefined) return undefined;

  // Anthropic input_tokens = tokens after the last cache breakpoint (neither read nor written).
  const input = getFirstNonNegativeNumber(usage.input_tokens, usage.inputTokens) ?? 0;
  return {
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalInput: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
}

// Raw fallback for Gemini/Vertex responses that still carry their native usage fields.
// In practice Pi normalizes usage before message_end fires, so this path is only
// reached when Pi-normalized fields are absent (e.g. custom/foreign providers).
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

// Try Pi-normalized usage first (always present for messages that went through Pi's
// provider pipeline). Fall back to provider-specific raw-field readers when Pi-normalized
// fields are absent (e.g. messages from custom/foreign providers whose raw usage shape
// matches the official API).
function normalizeWithFallback(
  message: unknown,
  rawNormalizer: (message: unknown) => UsageSnapshot | undefined,
  options: { allowInputOnlyPiUsage?: boolean } = {},
): UsageSnapshot | undefined {
  return getPiNormalizedUsage(message, options.allowInputOnlyPiUsage) ?? rawNormalizer(message);
}

function addOpenAIPromptCacheKey(payload: unknown, cacheKey: string | undefined): unknown | undefined {
  const record = asRecord(payload);
  const normalizedCacheKey = clampPromptCacheKey(cacheKey);
  if (!record || !normalizedCacheKey) return undefined;

  if (hasEffectivePromptCacheKey(record)) {
    return undefined;
  }

  return { ...record, prompt_cache_key: normalizedCacheKey };
}

function hasEffectivePromptCacheKey(record: UnknownRecord): boolean {
  return isNonEmptyString(record.prompt_cache_key) || isNonEmptyString(record.promptCacheKey);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOfficialOpenAIBaseUrl(model: PiModel): boolean {
  const value = lower(model.baseUrl).trim();
  if (!value) {
    return lower(model.provider) === "openai";
  }

  try {
    return new URL(value).hostname === "api.openai.com";
  } catch {
    return value === "api.openai.com" || value.startsWith("api.openai.com/");
  }
}

function isKnownThirdPartyOpenAIEndpoint(model: PiModel): boolean {
  return isNonEmptyString(model.baseUrl) && !isOfficialOpenAIBaseUrl(model);
}

function describeMissingOpenAIFamilyProxyCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];

  if (!isOpenAIFamilyModel(model)) return missing;
  if (!isOpenAICompatibleProxyApi(model.api)) return missing;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return missing;

  if (compat.sendSessionAffinityHeaders !== true) {
    missing.push("sendSessionAffinityHeaders");
  }

  return missing;
}

/**
 * Like describeMissingOpenAIFamilyProxyCompat but without the isOpenAIFamilyModel
 * gate. Warns for ANY model using openai-completions through a non-official base
 * URL — covers GPT, Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan, and any other
 * OpenAI-compatible proxy.
 */
function describeMissingOpenAICompatibleProxyCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];

  if (!isOpenAICompatibleProxyApi(model.api)) return missing;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return missing;
  if (isPiBuiltInLlamaCppModel(model)) return missing;

  if (compat.sendSessionAffinityHeaders === undefined) {
    missing.push("sendSessionAffinityHeaders");
  }

  // Explicit `sendSessionAffinityHeaders: false` is a valid safe opt-out for
  // proxies/CDNs/WAFs that block Pi's custom affinity headers with HTTP 403.
  // Treat only a missing/undefined value as missing compat; do not mark an
  // intentional false override as ⚠️ compat or let /cache-optimizer fix turn it
  // back to true.
  //
  // NOTE: supportsLongCacheRetention is intentionally NOT checked here.
  // Per spec, it is optional/risky advisory text only and must NOT trigger
  // the ⚠️ compat marker. The before_provider_request hook proactively
  // strips prompt_cache_retention for models without explicit opt-in,
  // so 400 errors are prevented regardless of this compat flag.
  // Doctor/compat may mention it as optional guidance separately.

  return missing;
}

function describeOptionalOpenAICompatibleProxyCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const optional: string[] = [];

  if (!isOpenAICompatibleProxyApi(model.api)) return optional;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return optional;
  if (isPiBuiltInLlamaCppModel(model)) return optional;

  if (compat.supportsLongCacheRetention !== true) {
    optional.push("supportsLongCacheRetention");
  }

  return optional;
}

function buildSafeOpenAIProxyCompatSuggestion(missing: string[]): Record<string, boolean> {
  const suggestion: Record<string, boolean> = {};
  if (missing.includes("sendSessionAffinityHeaders")) {
    suggestion.sendSessionAffinityHeaders = true;
  }
  // supportsLongCacheRetention is NOT suggested here — per spec it is
  // optional/risky and must not appear in the copyable safe snippet.
  // The proactive stripping in before_provider_request handles 400 prevention.
  return suggestion;
}

function getPromptCacheRetentionUnsupportedHint(): string {
  return "If this channel returns `400 Unsupported parameter: prompt_cache_retention`, remove/avoid `supportsLongCacheRetention`; this extension does not write that field directly, but Pi may send it when long retention is requested and compat says the proxy supports it.";
}

function hasPromptCacheRetentionUnsupportedText(value: unknown): boolean {
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

function hasPromptCacheRetentionUnsupportedSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return hasPromptCacheRetentionUnsupportedText(
    Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  );
}

function hasPromptCacheRetentionUnsupportedErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  return record?.stopReason === "error" &&
    hasPromptCacheRetentionUnsupportedText(record.errorMessage);
}

function hasPromptCacheKeyUnsupportedText(value: unknown): boolean {
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

function hasPromptCacheKeyUnsupportedSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(([key, value]) => hasPromptCacheKeyUnsupportedText(`${key}: ${value}`));
}

function hasPromptCacheKeyUnsupportedErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  return record?.stopReason === "error" &&
    getOptionalAssistantHttpStatus(record) === 400 &&
    hasPromptCacheKeyUnsupportedText(record.errorMessage);
}

function isPromptCacheKeyUnsupportedApplicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api);
}

function hasReasoningProtocolRejectionText(value: unknown): boolean {
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

function hasReasoningProtocolRejectionSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  // Each response header is one diagnostic unit. Joining all values can pair a
  // rejection from one header with unrelated documentation in another.
  return Object.entries(headers).some(([key, headerValue]) =>
    hasReasoningProtocolRejectionText(`${key}: ${headerValue}`)
  );
}

function getOptionalAssistantHttpStatus(record: UnknownRecord): number | undefined {
  const readStatus = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return parsed >= 100 && parsed <= 599 ? parsed : undefined;
    }
    return undefined;
  };

  for (const key of ["status", "statusCode", "httpStatus", "httpStatusCode"]) {
    const status = readStatus(record[key]);
    if (status !== undefined) return status;
  }

  // Foreign/provider adapters sometimes put the HTTP status under a
  // diagnostic `details`, `error`, or `cause` object rather than exposing it
  // on the finalized assistant message itself. Traverse only these known
  // diagnostic wrappers, with a small depth bound; never inspect arbitrary
  // payload/message fields for a number that happens to look like a status.
  const scanDiagnosticStatus = (value: unknown, depth: number): number | undefined => {
    if (depth > 2) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const status = scanDiagnosticStatus(item, depth + 1);
        if (status !== undefined) return status;
      }
      return undefined;
    }
    const source = asRecord(value);
    if (!source) return undefined;
    for (const key of ["status", "statusCode", "httpStatus", "httpStatusCode", "code"]) {
      const status = readStatus(source[key]);
      if (status !== undefined) return status;
    }
    for (const key of ["details", "error", "cause", "diagnostics"]) {
      const status = scanDiagnosticStatus(source[key], depth + 1);
      if (status !== undefined) return status;
    }
    return undefined;
  };
  for (const key of ["diagnostics", "diagnostic", "details", "error", "cause"]) {
    const status = scanDiagnosticStatus(record[key], 0);
    if (status !== undefined) return status;
  }

  // Pi's built-in OpenAI-compatible adapters normally prefix a provider error
  // body with the HTTP status (for example `400: {...}` or
  // `OpenAI API error (400): ...`). Only parse status-shaped prefixes; never
  // search arbitrary body text where a model id or payload number could be
  // mistaken for a response status.
  if (typeof record.errorMessage === "string") {
    const errorText = record.errorMessage;
    const matches = [
      /^\s*([1-5]\d{2})\b/,
      /^\s*(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:(]?\s*([1-5]\d{2})\b/i,
      /^\s*[^():\n]{1,100}\(\s*([1-5]\d{2})\b/,
      /^\s*(?:error|api\s+error|provider\s+error|request\s+failed|http\s+error)\s*[:(]\s*([1-5]\d{2})\b/i,
    ];
    for (const pattern of matches) {
      const match = pattern.exec(errorText);
      if (match) return Number(match[1]);
    }
  }
  return undefined;
}

function hasReasoningProtocolRejectionErrorMessage(message: unknown): boolean {
  const record = getAssistantRecord(message);
  if (!record || record.stopReason !== "error") return false;
  // Finalized assistant messages do not expose a separate status field in the
  // normal Pi path, so recover it only from structured diagnostics or the
  // adapter's status-shaped error prefix. A text-only 400-looking parameter
  // message is not enough evidence for a protocol repair.
  return getOptionalAssistantHttpStatus(record) === 400 &&
    hasReasoningProtocolRejectionText(record.errorMessage);
}

function isReasoningProtocolRejectionSignalApplicable(model: PiModel | undefined): boolean {
  // A provider error can teach us which protocol it expects, so this gate is
  // intentionally broader than the explicit DeepSeek-format diagnostic gate.
  // The model family identifies the affected cache/compat bucket; the error
  // text, not the model name, supplies the wire-protocol evidence.
  return !!model && isOpenAICompatibleProxyApi(model.api) && isDeepSeekLikeModel(model);
}

function isReasoningProtocolRejectionForModel(message: unknown, model: PiModel | undefined): boolean {
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

async function notifyReasoningProtocolObservation(
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

function fixSuggestionIdentity(model: PiModel): { providerLabel: string; modelId: string } {
  const key = modelKey(model);
  const slashIdx = key.indexOf("/");
  return {
    providerLabel: slashIdx > 0 ? key.slice(0, slashIdx) : key,
    modelId: model.id,
  };
}

function mergeFixSuggestions(...suggestions: Array<FixSuggestion | undefined>): FixSuggestion | undefined {
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

function buildReasoningProtocolFixSuggestion(
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

type CompatAdvicePlacement = {
  providerLabel?: string;
  modelId?: string;
};

function buildProviderCompatOverride(providerLabel: string, compat: Record<string, unknown>): Record<string, unknown> {
  return {
    providers: {
      [providerLabel]: {
        compat,
      },
    },
  };
}

function buildModelCompatOverride(providerLabel: string, modelId: string, compat: Record<string, unknown>): Record<string, unknown> {
  return {
    providers: {
      [providerLabel]: {
        modelOverrides: {
          [modelId]: {
            compat,
          },
        },
      },
    },
  };
}

function appendCredentialSafeProviderGuidance(lines: string[], placement: CompatAdvicePlacement, compatSuggestion: Record<string, unknown>): void {
  const providerLabel = placement.providerLabel;
  if (!providerLabel) return;

  lines.push("");
  lines.push("If this channel has no models.json provider entry yet:");
  lines.push("- Keep existing authentication as-is; do not copy credentials, tokens, or API keys.");
  lines.push(`- Add only cache/routing compat overrides in ${getModelsJsonDisplayPath()}.`);

  if (Object.keys(compatSuggestion).length === 0) {
    lines.push("- No safe copyable override is available for the missing flags shown above.");
    return;
  }

  lines.push("Provider-level minimal override:");
  lines.push(JSON.stringify(buildProviderCompatOverride(providerLabel, compatSuggestion), null, 2));

  if (placement.modelId) {
    lines.push("Single-model override (use this if only this model should change):");
    lines.push(JSON.stringify(buildModelCompatOverride(providerLabel, placement.modelId, compatSuggestion), null, 2));
  }
}

function appendOpenAIProxyCompatAdviceLines(lines: string[], missing: string[], options: { includeJsonIntro?: boolean } & CompatAdvicePlacement = {}): void {
  const suggestion = buildSafeOpenAIProxyCompatSuggestion(missing);
  const hasSafeSuggestion = Object.keys(suggestion).length > 0;

  if (hasSafeSuggestion) {
    if (options.includeJsonIntro !== false) {
      lines.push("Safe default suggestion:");
    }
    lines.push(JSON.stringify(suggestion, null, 2));
  }

  if (missing.includes("sendSessionAffinityHeaders")) {
    lines.push("- sendSessionAffinityHeaders: recommended for third-party proxies when supported; it helps keep one Pi session on the same upstream/backend.");
  }
  appendCredentialSafeProviderGuidance(lines, options, suggestion);
}

function appendOptionalOpenAIProxyCompatAdviceLines(lines: string[], optional: string[]): void {
  if (!optional.includes("supportsLongCacheRetention")) return;
  lines.push("");
  lines.push("Optional (not required, not auto-fixed):");
  lines.push("- supportsLongCacheRetention: enable only after your endpoint/proxy explicitly supports OpenAI long prompt cache retention.");
  lines.push(`- ${getPromptCacheRetentionUnsupportedHint()}`);
}

/**
 * Build the warning text displayed to users when an OpenAI-family third-party
 * proxy is missing one or more cache/session-affinity compat flags.
 *
 * The returned string contains a parseable JSON object (via JSON.stringify)
 * listing only the missing flags with recommended value `true`. Inline
 * explanations for each flag follow the JSON snippet as separate prose lines,
 * so the JSON remains valid and copyable.
 *
 * Expected use: the openai adapter's warningText calls this function; tests
 * exercise it via __internals_for_tests.
 */
function buildOpenAIProxyCompatWarningText(key: string, missing: string[]): string {
  // Extract provider id from the model key (e.g. "otokapi/gpt-5.5" -> "otokapi").
  // If no slash is found, fall back to the key itself.
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;

  const modelsJsonPath = getModelsJsonDisplayPath();
  const lines: string[] = [
    `💡 pi-cache-optimizer: ${key} is a third-party OpenAI-compatible proxy but merged compat lacks ${missing.join(" and ")}.`,
    `Run /cache-optimizer fix to preview a confirmed repair (or edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat manually).`,
    ``,
  ];

  appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId });

  return lines.join("\n");
}

/**
 * DeepSeek's model family and its reasoning wire protocol are separate facts.
 * The family name selects the cache adapter, but only an explicit effective
 * `thinkingFormat: "deepseek"` opts a third-party OpenAI Completions model into
 * the reasoning/replay compat checks below. Model names, provider ids, URLs,
 * and supportsReasoningEffort are not protocol evidence.
 */
function isDeepSeekWireCompatApplicable(model: PiModel): boolean {
  // `thinkingFormat` is the only wire-protocol signal. The model family is
  // still name/id based for adapter selection, while provider, URL, and
  // supportsReasoningEffort remain deliberately irrelevant here.
  return isDeepSeekLikeModel(model)
    && isOpenAICompatibleProxyApi(model.api)
    && getCompat(model).thinkingFormat === "deepseek";
}

function describeMissingDeepSeekCompat(model: PiModel): string[] {
  if (!isDeepSeekWireCompatApplicable(model)) return [];

  const compat = getCompat(model);
  const missing: string[] = [];
  if (compat.requiresReasoningContentOnAssistantMessages !== true) {
    missing.push("requiresReasoningContentOnAssistantMessages");
  }
  return missing;
}

/**
 * Compatibility diagnostics for a DeepSeek-like model are generic unless the
 * user has explicitly selected Pi's DeepSeek reasoning wire format. In
 * particular, never manufacture `thinkingFormat: "deepseek"`: doing so can
 * turn a valid reasoning_effort request into a provider-rejected `thinking`
 * request (Issue #10).
 */
function isDeepSeekCompatCheckApplicable(model: PiModel): boolean {
  return isDeepSeekWireCompatApplicable(model);
}

function hasExplicitDeepSeekReasoningProtocol(model: PiModel): boolean {
  return isDeepSeekWireCompatApplicable(model);
}

function describeMissingCacheCompatForModel(model: PiModel): string[] {
  if (isAdaptiveThinkingCompatApplicable(model)) {
    return describeMissingAdaptiveThinkingCompat(model);
  }

  const missing = describeMissingOpenAICompatibleProxyCompat(model);
  if (isDeepSeekWireCompatApplicable(model)) {
    missing.push(...describeMissingDeepSeekCompat(model));
  }
  return missing;
}

function buildDeepSeekCompatSuggestion(missing: string[]): Record<string, unknown> {
  const suggestion: Record<string, unknown> = {
    ...buildSafeOpenAIProxyCompatSuggestion(missing),
  };
  if (missing.includes("requiresReasoningContentOnAssistantMessages")) {
    suggestion.requiresReasoningContentOnAssistantMessages = true;
  }
  return suggestion;
}

function appendDeepSeekCompatAdviceLines(lines: string[], missing: string[], placement: CompatAdvicePlacement = {}): void {
  const suggestion = buildDeepSeekCompatSuggestion(missing);
  if (Object.keys(suggestion).length > 0) {
    lines.push("Recommended DeepSeek reasoning/replay compat snippet:");
    lines.push(JSON.stringify(suggestion, null, 2));
  }

  if (missing.includes("requiresReasoningContentOnAssistantMessages")) {
    lines.push('- requiresReasoningContentOnAssistantMessages: true keeps replayed assistant turns compatible with an explicitly selected DeepSeek reasoning wire format.');
  }
  if (missing.includes("sendSessionAffinityHeaders")) {
    lines.push("- sendSessionAffinityHeaders: recommended for third-party OpenAI-compatible proxies when supported; it helps keep one Pi session on the same upstream/backend.");
  }

  appendCredentialSafeProviderGuidance(lines, placement, suggestion);
}

function buildDeepSeekCompatWarningText(key: string, missing: string[]): string {
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;
  const modelsJsonPath = getModelsJsonDisplayPath();
  const lines: string[] = [
    `💡 pi-cache-optimizer: ${key} is DeepSeek-like but merged compat lacks ${missing.join(" and ")}.`,
    `Proxies may reduce or hide cache hits. Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (at the same level as baseUrl/api/apiKey/models).`,
    "",
  ];

  appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId });

  return lines.join("\n");
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
      const missing = describeMissingCacheCompatForModel(model);
      if (missing.length === 0) return undefined;

      const key = modelKey(model);
      return isDeepSeekWireCompatApplicable(model)
        ? buildDeepSeekCompatWarningText(key, missing)
        : buildOpenAIProxyCompatWarningText(key, missing);
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
      if (!isClaudeLikeModel(model) || !isOpenAICompatibleApi(model.api) || isPiBuiltInLlamaCppModel(model)) return undefined;
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
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
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
  // ── Non-GPT OpenAI-compatible adapters ──────────────────────
  {
    id: "openai" as CacheProviderId,
    label: "Kimi cache",
    matchesModel: isKimiLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isKimiLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Qwen cache",
    matchesModel: isQwenLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isQwenLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "GLM cache",
    matchesModel: isGLMLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isGLMLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "MiniMax cache",
    matchesModel: isMiniMaxLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isMiniMaxLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Mimo cache",
    matchesModel: isMimoLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isMimoLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Hunyuan cache",
    matchesModel: isHunyuanLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isHunyuanLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  // ── More OpenAI-compatible adapters ──────────────────────────
  {
    id: "openai" as CacheProviderId,
    label: "Mistral cache",
    matchesModel: isMistralLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isMistralLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Grok cache",
    matchesModel: isGrokLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isGrokLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Llama cache",
    matchesModel: isLlamaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isLlamaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Nemotron cache",
    matchesModel: isNemotronLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isNemotronLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Cohere cache",
    matchesModel: isCohereLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isCohereLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Yi cache",
    matchesModel: isYiLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isYiLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  // ── More OpenAI-compatible adapters (batch 2) ───────────────────
  {
    id: "openai" as CacheProviderId,
    label: "Doubao cache",
    matchesModel: isDoubaoLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isDoubaoLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "ERNIE cache",
    matchesModel: isErnieLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isErnieLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Baichuan cache",
    matchesModel: isBaichuanLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isBaichuanLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "StepFun cache",
    matchesModel: isStepFunLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isStepFunLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Spark cache",
    matchesModel: isSparkLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isSparkLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "InternLM cache",
    matchesModel: isInternLMLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isInternLMLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Gemma cache",
    matchesModel: isGemmaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isGemmaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Phi cache",
    matchesModel: isPhiLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isPhiLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Jamba cache",
    matchesModel: isJambaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isJambaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Solar cache",
    matchesModel: isSolarLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isSolarLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  // ── New OpenAI-compatible adapters (batch 3, 12 families) ────────
  {
    id: "openai" as CacheProviderId,
    label: "Sonar cache",
    matchesModel: isPerplexityLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isPerplexityLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Nova cache",
    matchesModel: isNovaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isNovaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Reka cache",
    matchesModel: isRekaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isRekaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Falcon cache",
    matchesModel: isFalconLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isFalconLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "DBRX cache",
    matchesModel: isDbrxLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isDbrxLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "MPT cache",
    matchesModel: isMptLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isMptLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "StableLM cache",
    matchesModel: isStableLMLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isStableLMLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Aquila cache",
    matchesModel: isAquilaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isAquilaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "EXAONE cache",
    matchesModel: isExaoneLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isExaoneLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "HyperCLOVA cache",
    matchesModel: isHyperCLOVALikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isHyperCLOVALikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Luminous cache",
    matchesModel: isLuminousLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isLuminousLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Hermes cache",
    matchesModel: isHermesLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isHermesLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  // ── More OpenAI-compatible adapters (batch 4, 18 families) ────────
  {
    id: "openai" as CacheProviderId,
    label: "Granite cache",
    matchesModel: isGraniteLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isGraniteLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Arctic cache",
    matchesModel: isArcticLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isArcticLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Pangu cache",
    matchesModel: isPanguLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isPanguLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "SenseNova cache",
    matchesModel: isSenseNovaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isSenseNovaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Zhinao cache",
    matchesModel: isZhinaoLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isZhinaoLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "MiniCPM cache",
    matchesModel: isMiniCPMLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isMiniCPMLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "XVERSE cache",
    matchesModel: isXVerseLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isXVerseLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Orion cache",
    matchesModel: isOrionLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isOrionLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "OpenChat cache",
    matchesModel: isOpenChatLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isOpenChatLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Vicuna cache",
    matchesModel: isVicunaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isVicunaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Wizard cache",
    matchesModel: isWizardLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isWizardLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Zephyr cache",
    matchesModel: isZephyrLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isZephyrLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Dolphin cache",
    matchesModel: isDolphinLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isDolphinLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "OpenOrca cache",
    matchesModel: isOpenOrcaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isOpenOrcaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Starling cache",
    matchesModel: isStarlingLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isStarlingLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "BLOOM cache",
    matchesModel: isBloomLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isBloomLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "RWKV cache",
    matchesModel: isRwkvLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isRwkvLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
  {
    id: "openai" as CacheProviderId,
    label: "Aya cache",
    matchesModel: isAyaLikeModel,
    matchesAssistantMessage(message, model) {
      if (!isAssistantMessage(message)) return false;
      return isAyaLikeAssistantMessage(message, model);
    },
    normalizeUsage(message) {
      return normalizeWithFallback(message, getOpenAIRawUsage);
    },
    warningText(model) {
      const missing = describeMissingOpenAICompatibleProxyCompat(model);
      if (missing.length === 0) return undefined;
      return buildOpenAIProxyCompatWarningText(modelKey(model), missing);
    },
  },
];

function selectAdapterForModel(model: PiModel | undefined): CacheProviderAdapter | undefined {
  // A native virtual selection has no cache identity of its own; stats always
  // belong to the physical model it routed to.
  if (isNativeVirtualModel(model)) return undefined;
  return CACHE_PROVIDER_ADAPTERS.find((adapter) => adapter.matchesModel(model));
}

function selectAdapterForAssistantMessage(message: unknown, model: PiModel | undefined): CacheProviderAdapter | undefined {
  // Assistant message metadata is request-local and authoritative for virtual
  // routing providers. Use it first for every model; direct providers normally
  // echo the same provider/model and therefore remain unchanged.
  const responseModel = modelFromAssistantMessage(message, model);
  return CACHE_PROVIDER_ADAPTERS.find((adapter) => adapter.matchesAssistantMessage(message, responseModel));
}

function notifyCacheCompatIfNeeded(
  model: PiModel | undefined,
  ctx: ExtensionContext,
  warnedModels: Set<string>,
): void {
  if (!model) return;

  // A protocol rejection is retained separately from ordinary compat warnings;
  // it is surfaced once by the response hook and can be used by a later fix.
  // Do not turn it into an automatic write here.

  // Native anthropic-messages adaptive thinking compat check.
  // Adapter warningText only fires for OpenAI-compatible APIs, so native
  // Anthropic and Kimi Coding adaptive models need a separate check.
  if (isAdaptiveThinkingCompatApplicable(model)) {
    const missing = describeMissingAdaptiveThinkingCompat(model);
    if (missing.length > 0) {
      const key = `adaptive-thinking:${modelKey(model)}`;
      if (!warnedModels.has(key)) {
        warnedModels.add(key);
        ctx.ui.notify(buildAdaptiveThinkingCompatWarningText(modelKey(model), missing), "warning");
      }
    }
    // Still check adapter warnings for other compat issues.
  }

  const adapter = selectAdapterForModel(model);
  const text = adapter?.warningText?.(model);
  if (!adapter || !text) return;

  const affinityOnly = adapter.warningText !== undefined &&
    describeMissingOpenAICompatibleProxyCompat(model).length === 1 &&
    describeMissingCacheCompatForModel(model).length === 1;
  const key = affinityOnly
    ? `proxy-affinity:${model.provider}`
    : `${adapter.id}:${modelKey(model)}`;
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
    ? (stats.cachedInputTokens / stats.totalInputTokens) * 100
    : 0;
  const writeText = adapter.showCacheWrite && stats.cacheWriteInputTokens > 0
    ? `·write ${formatTokenCount(stats.cacheWriteInputTokens)}`
    : "";

  return `${adapter.label} ${stats.hitRequests}/${stats.totalRequests}·${formatTokenCount(stats.cachedInputTokens)}/${formatTokenCount(stats.totalInputTokens)} ${percent.toFixed(1)}%${writeText}`;
}

function prefixFooterStatus(statusText: string | undefined): string | undefined {
  if (!statusText || statusText.startsWith("· ")) return statusText;
  return `· ${statusText}`;
}

/**
 * Compute a hit-ratio percentage string for a value between 0 and 1.
 * Returns e.g. "75%", "0%", "100%", or "N/A" for zero total.
 */
function formatHitRatio(hits: number, total: number): string {
  if (total <= 0) return "N/A";
  return `${Math.round((hits / total) * 100)}%`;
}

/**
 * Format a token-to-M abbreviation for stats output.
 * Example: 1500000 → "1.50M"
 */
function formatTokenM(value: number): string {
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
function hasMissingUsageFields(message: unknown, adapter: CacheProviderAdapter): boolean {
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
function formatRecentTrendSummary(samples: CacheUsageSample[], maxCount: number): string {
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
function formatCompactStats(stats: CacheStats): string {
  const percent = stats.totalInputTokens > 0
    ? (stats.cachedInputTokens / stats.totalInputTokens) * 100
    : 0;
  return `${stats.hitRequests}/${stats.totalRequests}·${formatTokenCount(stats.cachedInputTokens)}/${formatTokenCount(stats.totalInputTokens)} ${percent.toFixed(1)}%`;
}

function modelFromStatsKey(key: string, ref?: PersistedRoutedModelRef): PiModel | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash >= key.length - 1) return undefined;
  return routedModelRefToPiModel(ref ?? { provider: key.slice(0, slash), id: key.slice(slash + 1) });
}

function sortStatsEntries(entries: Array<[string, CacheStats]>, activeModelKey?: string): Array<[string, CacheStats]> {
  return entries.sort(([left], [right]) => {
    if (left === activeModelKey) return -1;
    if (right === activeModelKey) return 1;
    return left.localeCompare(right);
  });
}

function buildSessionStatsOutput(
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

function buildAllStatsOutput(aggregate: ShardAggregate): string {
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

function buildContributorsStatsOutput(aggregate: ShardAggregate, activeModel: PiModel | undefined, currentSessionHash?: string): string {
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

function buildStatsOutput(model: PiModel | undefined, adapter: CacheProviderAdapter | undefined, stats: CacheStats | undefined, recentSamples: CacheUsageSample[]): string {
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

function cloneCacheStats(stats: CacheStats): CacheStats {
  return { ...stats };
}

function addCacheStatsTotals(target: CacheStats, source: CacheStats): void {
  target.totalRequests += source.totalRequests;
  target.hitRequests += source.hitRequests;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheWriteInputTokens += source.cacheWriteInputTokens;
  target.totalInputTokens += source.totalInputTokens;
}

function mergeCacheStatsForTotal(existing: CacheStats | undefined, incoming: CacheStats): CacheStats {
  if (!existing) return cloneCacheStats(incoming);
  if (incoming.day > existing.day) return cloneCacheStats(incoming);
  if (incoming.day < existing.day) return existing;
  addCacheStatsTotals(existing, incoming);
  return existing;
}

function deriveTotalsByModelFromSessionStats(statsByModel: Record<string, CacheStats>): Record<string, CacheStats> {
  const totals: Record<string, CacheStats> = {};
  for (const [fullKey, stats] of Object.entries(statsByModel)) {
    totals[modelKeyFromSessionKey(fullKey)] = mergeCacheStatsForTotal(
      totals[modelKeyFromSessionKey(fullKey)],
      stats,
    );
  }
  return totals;
}

function parsePersistedTotalsByModel(value: unknown): Record<string, CacheStats> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const totals: Record<string, CacheStats> = {};
  for (const [modelKeyStr, rawStats] of Object.entries(record)) {
    const stats = parseCacheStats(rawStats);
    if (stats) totals[modelKeyStr] = stats;
  }
  return totals;
}

function parsePersistedRoutedModelRef(value: unknown): PersistedRoutedModelRef | undefined {
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

function routedModelRefToPiModel(ref: PersistedRoutedModelRef): PiModel {
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

function selectFooterStatsForModel(
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

function buildExactRouterStatusEntry(
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

function findBestRouterModelStats(
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

function parsePersistedCacheStats(value: unknown): CacheStatsState | undefined {
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

async function readPersistedCacheStats(): Promise<CacheStatsState | undefined> {
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

function filterRestorableStatsForSession(
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
function mergeCacheSessions(
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

function createSerializedAsyncRunner(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
}

function mergeCacheTotals(
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

function mergeLastRoutedModels(
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

async function writePersistedCacheStats(
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

function modelEpochPath(modelKeyValue: string): string {
  return join(SHARD_MODEL_EPOCH_DIR, `${createHash("sha256").update(modelKeyValue).digest("hex")}.json`);
}

function initialEpoch(scope: string): string {
  return `initial:${scope}`;
}

function parseEpochRecord(value: unknown): string | undefined {
  const record = asRecord(value);
  return record?.version === 1 && isNonEmptyString(record.epoch) ? record.epoch.trim() : undefined;
}

async function readEpochFile(path: string, fallback: string): Promise<string> {
  try {
    return parseEpochRecord(JSON.parse(await readFile(path, "utf8"))) ?? fallback;
  } catch {
    return fallback;
  }
}

async function readGlobalStatsEpoch(): Promise<string> {
  return readEpochFile(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global"));
}

async function readModelStatsEpoch(modelKeyValue: string): Promise<string> {
  return readEpochFile(modelEpochPath(modelKeyValue), initialEpoch(`model:${modelKeyValue}`));
}

async function writeStatsEpoch(path: string, epoch: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify({ version: 1, epoch, createdAt: Date.now() }, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

async function advanceGlobalStatsEpoch(): Promise<string> {
  const epoch = `${Date.now()}-${randomUUID()}`;
  await writeStatsEpoch(SHARD_GLOBAL_EPOCH_PATH, epoch);
  return epoch;
}

async function advanceModelStatsEpoch(modelKeyValue: string): Promise<string> {
  const epoch = `${Date.now()}-${randomUUID()}`;
  await writeStatsEpoch(modelEpochPath(modelKeyValue), epoch);
  return epoch;
}

function parsePersistedStatsShardV7(value: unknown): PersistedStatsShardV7 | undefined {
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

async function writeStatsShardV7(path: string, shard: PersistedStatsShardV7): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(shard, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

async function readValidStatsShardsV7(directory: string = SHARD_FILES_DIR): Promise<PersistedStatsShardV7[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  const shards: PersistedStatsShardV7[] = [];
  for (const name of names) {
    if (!/^[0-9a-f-]+\.json$/i.test(name)) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const parsed = parsePersistedStatsShardV7(JSON.parse(await readFile(path, "utf8")));
      const filenameInstanceId = name.slice(0, -".json".length);
      if (parsed && parsed.instanceId === filenameInstanceId) shards.push(parsed);
    } catch {
      // Ignore malformed or transiently unavailable shards. Atomic writers will
      // publish a complete replacement on the next successful update.
    }
  }
  return shards;
}

async function aggregateStatsShardsV7(
  shards: PersistedStatsShardV7[],
  day: string = currentLocalDay(),
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
    if (shard.day !== day || shard.globalEpoch !== globalEpoch) continue;
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
      if (entry.modelEpoch !== epoch || entry.stats.day !== day) continue;
      contributed = true;
      const sessionModels = result.bySession[shard.sessionHash] ??= {};
      sessionModels[key] = mergeCacheStatsForTotal(sessionModels[key], entry.stats);
      result.totalsByModel[key] = mergeCacheStatsForTotal(result.totalsByModel[key], entry.stats);
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

async function loadStatsShardAggregateV7(directory: string = SHARD_FILES_DIR): Promise<ShardAggregate> {
  return aggregateStatsShardsV7(await readValidStatsShardsV7(directory));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === "EPERM";
  }
}

async function removeLegacyStatsFiles(): Promise<void> {
  for (const path of [STATE_FILE_PATH, LEGACY_STATE_FILE_PATH]) {
    try {
      await unlink(path);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to remove obsolete stats file ${path}`, error);
    }
  }
}

async function cleanupStatsShardsV7(now = Date.now(), directory: string = SHARD_FILES_DIR): Promise<number> {
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
        const parsed = parsePersistedStatsShardV7(JSON.parse(await readFile(path, "utf8")));
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

async function maybeCleanupStatsShardsV7(now = Date.now()): Promise<void> {
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

function isCompatCheckApplicable(model: PiModel): boolean {
  return isOpenAICompatibleProxyApi(model.api) && isKnownThirdPartyOpenAIEndpoint(model) && !isPiBuiltInLlamaCppModel(model);
}

function isPromptCacheRetention400Applicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api) &&
    isKnownThirdPartyOpenAIEndpoint(model) &&
    !isPiBuiltInLlamaCppModel(model) &&
    getCompat(model).supportsLongCacheRetention === true;
}

function isExplicitPromptCacheRetentionUnsupportedApplicable(model: PiModel): boolean {
  // A finalized assistant error with an explicit unsupported-parameter signal
  // proves that prompt_cache_retention reached this provider/model. Do not
  // require compat inherited from the active fallback model: router shells may
  // have no upstream compat metadata when no live routing registry is present.
  return isOpenAICompatibleApi(model.api) &&
    !isOfficialOpenAIBaseUrl(model) &&
    !isPiBuiltInLlamaCppModel(model);
}

/**
 * Whether the 403 sendSessionAffinityHeaders diagnostic applies to a model.
 *
 * Pi's openai-completions adapter sends custom HTTP headers (session_id,
 * x-client-request-id, x-session-affinity) when `sendSessionAffinityHeaders`
 * is enabled. Some third-party proxies / CDNs / WAFs block these headers and
 * return HTTP 403 "Your request was blocked". Pi 0.80.7+ no longer uses this
 * flag for openai-responses; Responses header shape is controlled by
 * `sessionAffinityFormat`. This guard therefore applies only to
 * openai-completions, where doctor/fix can safely advise disabling the flag.
 */
function isSessionAffinity403Applicable(model: PiModel): boolean {
  if (!isOpenAICompatibleProxyApi(model.api)) return false;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return false;
  if (isPiBuiltInLlamaCppModel(model)) return false;
  return getCompat(model).sendSessionAffinityHeaders === true;
}

/**
 * Whether an OpenAI SDK header/User-Agent 403 diagnostic applies.
 *
 * Some third-party OpenAI-compatible proxies/CDNs/WAFs allow a plain curl
 * request but block the OpenAI JS SDK's default request fingerprint, especially
 * its `User-Agent: OpenAI/JS ...` and `X-Stainless-*` headers. This is distinct
 * from session-affinity header blocking: it applies when session-affinity
 * headers are NOT enabled but the model still uses a non-official
 * OpenAI-compatible proxy transport.
 */
function isOpenAISdkHeader403Applicable(model: PiModel): boolean {
  if (!isOpenAICompatibleProxyApi(model.api)) return false;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return false;
  if (isPiBuiltInLlamaCppModel(model)) return false;
  return getCompat(model).sendSessionAffinityHeaders !== true;
}

/**
 * Detect router / channel profiles from a PiModel and return diagnostic notes.
 *
 * This function is advisory only — it does NOT participate in adapter selection,
 * prompt_cache_key injection, or footer stats. It inspects provider, api, baseUrl,
 * and compat to identify common proxy/router patterns where cache performance may
 * be degraded due to multi-backend routing.
 *
 * Known profiles (checked in order):
 *   1. OpenRouter — baseUrl or provider id matching openrouter.ai / openrouter
 *   2. Vercel AI Gateway — baseUrl matching ai-gateway.vercel.sh, or provider
 *      matching vercel / vercel-ai-gateway
 *   3. LiteLLM / OneAPI / NewAPI / VoAPI — baseUrl or provider matching litellm,
 *      oneapi, one-api, newapi, new-api, voapi, vo-api (self-hosted aggregation)
 *   4. Generic third-party OpenAI-compatible proxy — any openai-completions model
 *      with a non-official base URL that does not match a higher-profile above.
 *
 * Official OpenAI (api.openai.com) and custom transports (kiro-api, anthropic-messages,
 * bedrock-converse-stream) do NOT produce notes.
 */
function describeRouterChannelDiagnostics(model: PiModel): string[] {
  const notes: string[] = [];
  const api = lower(model.api);
  const baseUrl = lower(model.baseUrl || "");
  const provider = lower(model.provider);

  // Router/channel diagnostics only apply to OpenAI-compatible proxy APIs.
  // Native APIs like mistral-conversations, azure-openai-responses,
  // anthropic-messages, or bedrock-converse-stream are intentionally excluded.
  if (api === "azure-openai-responses" || isMistralConversationsApi(api) || !isOpenAICompatibleApi(api)) {
    return notes;
  }

  // Unknown/default endpoints and official OpenAI are not diagnosable as
  // third-party router channels. Request-header bridging also fails closed.
  if (!isKnownThirdPartyOpenAIEndpoint(model)) {
    return notes;
  }

  // Pi 0.81+ built-in llama.cpp uses an OpenAI-shaped transport, but its
  // untouched explicit compat fingerprint does not expose proxy-routing or
  // session-affinity configuration. Same-id overrides are not exempt.
  if (isPiBuiltInLlamaCppModel(model)) {
    return notes;
  }

  // ── 1. OpenRouter ────────────────────────────────────────────────
  if (
    baseUrl.includes("openrouter.ai") ||
    baseUrl.includes("openrouter") ||
    provider.includes("openrouter")
  ) {
    const compat = getCompat(model);
    const routing = asRecord((compat as Record<string, unknown>)["openRouterRouting"]);
    const hasOnly = !!routing?.only;
    const hasOrder = !!routing?.order;

    notes.push(
      "🔀 Router/channel: OpenRouter detected. OpenRouter is a multi-provider router; " +
      "low cache hit rates are common when each turn lands on a different upstream provider.",
    );

    if (!hasOnly && !hasOrder) {
      notes.push(
        "   Suggestion: Add an openRouterRouting config to fix the upstream provider. " +
        "Example for models.json -> providers[\"<providerId>\"] -> compat:",
      );
      notes.push(
        `   { "sendSessionAffinityHeaders": true, "supportsLongCacheRetention": true, ` +
        `"openRouterRouting": { "only": ["<provider-slug>"] } }`,
      );
      notes.push(
        '   Replace <provider-slug> with the actual OpenRouter provider slug (e.g. "openai", "anthropic").',
      );
      notes.push(
        "   Alternatively, use openRouterRouting.order: [\"<provider-slug>\", \"...\"] for fallback order. " +
        "Only set supportsLongCacheRetention if your upstream supports long cache retention.",
      );
    }

    return notes;
  }

  // ── 2. Vercel AI Gateway ─────────────────────────────────────────
  if (
    baseUrl.includes("ai-gateway.vercel.sh") ||
    provider.includes("vercel") ||
    provider.includes("vercel-ai-gateway")
  ) {
    const compat = getCompat(model);
    const routing = asRecord((compat as Record<string, unknown>)["vercelGatewayRouting"]);
    const hasOnly = !!routing?.only;
    const hasOrder = !!routing?.order;

    notes.push(
      "🔀 Router/channel: Vercel AI Gateway detected. The gateway may route to different " +
      "provider endpoints per request, reducing cache locality.",
    );

    if (!hasOnly && !hasOrder) {
      notes.push(
        "   Suggestion: Add a vercelGatewayRouting config to fix the upstream. " +
        "Example for models.json -> providers[\"<providerId>\"] -> compat:",
      );
      notes.push(
        `   { "sendSessionAffinityHeaders": true, "supportsLongCacheRetention": true, ` +
        `"vercelGatewayRouting": { "only": ["<provider-id>"] } }`,
      );
      notes.push(
        "   Replace <provider-id> with the actual Vercel provider ID (e.g. \"openai\").",
      );
      notes.push(
        "   Only set supportsLongCacheRetention if your upstream supports it.",
      );
    }

    return notes;
  }

  // ── 3. LiteLLM / OneAPI / NewAPI / VoAPI (self-hosted aggregation) ──
  const aggregationPatterns = ["litellm", "oneapi", "one-api", "newapi", "new-api", "voapi", "vo-api"];
  if (
    aggregationPatterns.some((p) => baseUrl.includes(p)) ||
    aggregationPatterns.some((p) => provider.includes(p))
  ) {
    notes.push(
      "🔀 Router/channel: Self-hosted aggregation proxy detected (LiteLLM / OneAPI / NewAPI / VoAPI). " +
      "These proxies route to multiple upstream accounts or instances, which can split the cache.",
    );
    notes.push(
      "   Suggestions:",
    );
    notes.push(
      "   • Ensure the proxy can fix to a single upstream per session (session_id affinity).",
    );
    notes.push(
      "   • Forward prompt_cache_key and session-affinity headers to the upstream.",
    );
    notes.push(
      "   • Return cache usage fields (prompt_cache_hit_tokens, etc.) in the response.",
    );
    notes.push(
      `   Safe compat default: { "sendSessionAffinityHeaders": true }`,
    );
    notes.push(
      `   Add supportsLongCacheRetention only if the proxy explicitly supports prompt_cache_retention.`,
    );

    return notes;
  }

  // ── 4. Generic third-party OpenAI-compatible proxy ─────────────────
  if (api === "openai-completions" && baseUrl) {
    const missing = describeMissingCacheCompatForModel(model);
    notes.push(
      "🔀 Router/channel: Third-party OpenAI-compatible proxy. If cache hit rates are low:",
    );
    notes.push(
      "   • Verify the proxy routes to the same upstream account/instance per session.",
    );
    notes.push(
      "   • Ensure the proxy forwards prompt_cache_key and sends session-affinity headers.",
    );
    notes.push(
      "   • Check that the proxy returns cache usage fields (prompt_cache_hit_tokens etc.).",
    );
    if (missing.length > 0) {
      notes.push(
        `   • The compat flags above (${missing.join(", ")}) are recommended for cache stability.`,
      );
    }

    return notes;
  }

  return notes;
}

function getCompatCheckNotApplicableLines(model: PiModel): string[] {
  const api = lower(model.api);

  if (isNativeVirtualModel(model)) {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Native virtual model: Pi routes each request to a physical model and none has answered on this session branch yet. Send a prompt, then rerun to diagnose the physical model that answered.",
    ];
  }

  if (isMistralConversationsApi(api)) {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Native Mistral `mistral-conversations` uses provider-native transport; OpenAI-compatible proxy compat flags do not apply.",
    ];
  }

  if (api === "azure-openai-responses") {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Native Azure OpenAI Responses uses the Responses transport; OpenAI-compatible proxy compat flags do not apply.",
    ];
  }

  if (api === "openai-codex-responses" || (api === "openai-responses" && isOfficialOpenAIBaseUrl(model))) {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Native Responses transports already use Pi core request handling; OpenAI-compatible proxy compat flags do not apply.",
    ];
  }

  if (isOpenAICompatibleApi(api) && !isNonEmptyString(model.baseUrl)) {
    return [
      "ℹ️ Compat check not applicable for this model.",
      "   Upstream endpoint metadata is unavailable; session-affinity header injection is disabled.",
    ];
  }

  return ["ℹ️ Compat check not applicable for this model."];
}

function buildDoctorDiagnosis(model: PiModel, options: { promptCacheRetention400?: boolean; promptCacheKey400?: boolean; anthropicTtlOrderError?: boolean; sessionAffinity403?: boolean; openAISdkHeader403?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Provider: ${model.provider}`);
  lines.push(`Model:    ${model.id}`);
  if (model.name && model.name !== model.id) lines.push(`Name:     ${model.name}`);
  lines.push(`API:      ${model.api}`);
  lines.push(`Base URL: ${model.baseUrl || "(default)"}`);

  const compat = getCompat(model);
  lines.push(`Compat:   ${JSON.stringify(compat)}`);

  const adaptiveThinkingApplicable = isAdaptiveThinkingCompatApplicable(model);
  const deepSeekCompatApplicable = isDeepSeekCompatCheckApplicable(model);
  const missing = describeMissingCacheCompatForModel(model);
  const optionalOpenAIProxyCompat = !adaptiveThinkingApplicable
    ? describeOptionalOpenAICompatibleProxyCompat(model)
    : [];
  const fixSug = buildFixSuggestion(model);
  const safeFixableMissing = fixSug ? Object.keys(fixSug.compatKeys) : [];
  const advisoryMissing = missing.filter(m => !safeFixableMissing.includes(m));

  if (safeFixableMissing.length > 0) {
    lines.push(`⚠️  Missing compat flags: ${safeFixableMissing.join(", ")}`);
  }
  if (advisoryMissing.length > 0) {
    lines.push(`ℹ️  Optional: ${advisoryMissing.join(", ")} (enable only if needed)`);
  }

  if (missing.length > 0) {
    const key = modelKey(model);
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    const modelsJsonPath = getModelsJsonDisplayPath();
    lines.push(`Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (same level as baseUrl/api/apiKey/models).`);
    if (adaptiveThinkingApplicable) {
      appendAdaptiveThinkingCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
    } else if (deepSeekCompatApplicable) {
      appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    }
  } else if (adaptiveThinkingApplicable || deepSeekCompatApplicable || isCompatCheckApplicable(model)) {
    lines.push("✅ Compat fully configured.");
    appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
  } else {
    lines.push(...getCompatCheckNotApplicableLines(model));
  }

  if (options.promptCacheKey400 && isPromptCacheKeyUnsupportedApplicable(model)) {
    lines.push("");
    lines.push("⚠️  This model previously rejected prompt_cache_key with an explicit HTTP 400 signal.");
    lines.push("   /cache-optimizer fix will offer a precise model-scoped opt-out.");
    lines.push("   The opt-out removes both prompt_cache_key and promptCacheKey from the final request body.");
  }

  if (isPromptCacheRetention400Applicable(model)) {
    lines.push("");
    if (options.promptCacheRetention400) {
      lines.push("⚠️  A 400 response was observed while supportsLongCacheRetention is enabled.");
      lines.push(`   ${getPromptCacheRetentionUnsupportedHint()}`);
    } else {
      lines.push(`ℹ️ Long retention is enabled. ${getPromptCacheRetentionUnsupportedHint()}`);
    }
  }

  if (options.anthropicTtlOrderError) {
    lines.push("");
    lines.push("⚠️  An Anthropic cache-control TTL ordering error was observed for this model.");
    lines.push("   Runtime requests now fall back from 1h to the default 5-minute cache TTL.");
    lines.push(`   Run /cache-optimizer fix to set model-level supportsLongCacheRetention: false in ${getModelsJsonDisplayPath()}.`);
  }

  // ── Session affinity 403 diagnostics ──
  // Advises the user when sendSessionAffinityHeaders is enabled, since some
  // third-party proxies / CDNs / WAFs block Pi's custom session-affinity HTTP
  // headers (session_id, x-client-request-id, x-session-affinity) and return
  // 403. If a 403 was already observed for this model, show a stronger hint.
  if (isSessionAffinity403Applicable(model)) {
    lines.push("");
    if (options.sessionAffinity403) {
      lines.push("⚠️  A 403 response was observed while sendSessionAffinityHeaders is enabled.");
      lines.push("   The proxy/CDN likely blocks Pi's custom session-affinity headers (session_id,");
      lines.push("   x-client-request-id, x-session-affinity). Run /cache-optimizer fix to");
      lines.push(`   set sendSessionAffinityHeaders: false in ${getModelsJsonDisplayPath()}.`);
    } else {
      lines.push("ℹ️ Session affinity headers are enabled. Some CDNs/WAFs block custom headers");
      lines.push("   (session_id, x-client-request-id, x-session-affinity) and return 403. If you");
      lines.push("   see 403 errors, run /cache-optimizer fix to set sendSessionAffinityHeaders: false.");
    }
  } else if (isOpenAISdkHeader403Applicable(model)) {
    lines.push("");
    if (options.openAISdkHeader403) {
      lines.push("⚠️  A 403 response was observed while sendSessionAffinityHeaders is not enabled.");
      lines.push("   The proxy/CDN may be blocking the OpenAI JS SDK request fingerprint");
      lines.push("   (for example User-Agent: OpenAI/JS ... or X-Stainless-* headers). This");
      lines.push("   is provider/WAF-specific; /cache-optimizer fix will not auto-write headers.");
      lines.push(`   Manual workaround: add a provider-level headers.User-Agent override in ${getModelsJsonDisplayPath()}`);
      lines.push("   only after testing the value with the affected provider.");
    } else {
      lines.push("ℹ️ If 403 persists after disabling sendSessionAffinityHeaders, some CDNs/WAFs");
      lines.push("   may block the OpenAI JS SDK User-Agent / X-Stainless-* headers. Test the");
      lines.push("   provider manually before adding a provider-level headers.User-Agent override.");
    }
  }

  // ── Router/channel diagnostics ──
  const routerNotes = describeRouterChannelDiagnostics(model);
  if (routerNotes.length > 0) {
    lines.push("");
    for (const note of routerNotes) {
      lines.push(note);
    }
  }

  // ── Integrity diagnostics ──
  if (lastPromptIntegrityWarningAt > 0) {
    const ago = Date.now() - lastPromptIntegrityWarningAt;
    const mins = Math.floor(ago / 60000);
    if (mins < 5) {
      lines.push("");
      lines.push("⚠️  Recent prompt integrity issue detected:");
      lines.push(`   Last detected ${mins > 0 ? `${mins} min` : `${Math.floor(ago / 1000)}s`} ago. The prompt reorder was`);
      lines.push(`   skipped on that turn to preserve structural markers.`);
      lines.push(`   Common causes: extension system prompt format change, substring collision.`);
      lines.push(`   Steps:`);
      lines.push(`     1. Run /reload to reset (may clear transient issues).`);
      lines.push(`     2. Set PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1 & /reload to disable reorder.`);
      lines.push(`     3. If persistent, file an issue with this doctor output.`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a "Cache diagnosis" section for low-hit causes, appended to doctor output.
 * This is a separate function because it depends on per-session state (recent samples,
 * per-model stats) that is not available at the module level.
 */
function buildLowHitDiagnosis(
  model: PiModel,
  adapter: CacheProviderAdapter | undefined,
  stats: CacheStats | undefined,
  samples: CacheUsageSample[],
): string[] {
  const lines: string[] = [];

  // 1. Missing compat flags (adapter-aware: DeepSeek has extra reasoning compat)
  const fixSugLHD = buildFixSuggestion(model);
  const safeFixableMissingLHD = fixSugLHD ? Object.keys(fixSugLHD.compatKeys) : [];

  // 2. Router/channel risk (reuse existing check)
  const routerNotes = describeRouterChannelDiagnostics(model);

  // 3. Recent samples missing usage fields
  const missingUsageSamples = samples.filter((s) => s.missingUsageFields).length;

  // 4. Recent trend analysis
  const recent10 = samples.slice(-10);
  const recent10Hits = recent10.filter((s) => s.hit).length;
  const recent10Total = recent10.length;
  const recent10Cached = recent10.reduce((sum, s) => sum + s.cachedInputTokens, 0);
  const recent10Input = recent10.reduce((sum, s) => sum + s.totalInputTokens, 0);

  // 5. Today's overall trend from persisted stats
  const todayStats = stats ?? emptyCacheStats();

  const hasMissingCompat = safeFixableMissingLHD.length > 0;
  const hasRouterRisk = routerNotes.length > 0;
  const hasUsageMissing = missingUsageSamples > 0;

  // Today's cached-token ratio is used both inside and outside the recent-sample
  // branch. Keep it block-external so doctor/stats never throw for low-hit
  // models that have persisted counters but no recent in-memory samples.
  const todayHitRatio = todayStats.totalInputTokens > 0
    ? Math.round((todayStats.cachedInputTokens / todayStats.totalInputTokens) * 100)
    : 0;

  // Determine if there are actual issues worth flagging
  const hasActualIssues = hasMissingCompat || hasUsageMissing ||
    // Low hit trend (today total > 3 and hit ratio < 30%)
    (todayStats.totalRequests > 3 && todayStats.totalInputTokens > 0 &&
     (todayStats.cachedInputTokens / todayStats.totalInputTokens) < 0.3) ||
    // Low hit rate in recent samples (recent10Total >= 3 and all misses)
    (recent10Total >= 3 && recent10Hits === 0);

  // Skip section if no issues
  if (!hasActualIssues && !(hasRouterRisk && (hasMissingCompat || hasUsageMissing))) {
    return lines;
  }

  lines.push("");
  lines.push("── Cache diagnosis ──");

  // Priority 1: missing compat flags
  if (hasMissingCompat) {
    lines.push(`⚠️  Missing compat flags: ${safeFixableMissingLHD.join(", ")}`);
    lines.push("   These flags enable prompt caching and session-affinity routing.");
    lines.push("   Run /cache-optimizer compat for edit instructions.");
  }

  // Priority 2: router/channel risk (only flag when there are other issues)
  // Router notes are already shown in the main doctor output, so we only
  // mention them in the diagnosis section when they compound a problem.
  if (hasRouterRisk && (hasMissingCompat || hasUsageMissing || hasActualIssues)) {
    lines.push("🔀 Router/channel proxy detected — see routing notes above.");
  }

  // Priority 3: usage fields missing
  if (hasUsageMissing) {
    lines.push(`⚠️  ${missingUsageSamples}/${samples.length} recent responses had missing/empty usage fields.`);
    lines.push("   Footer may under-report cache hit rate.");
    lines.push("   Verify the proxy returns prompt-level usage (prompt_tokens, input_tokens_details).");
  }

  // Priority 4: recent trend low
  if (recent10Total > 0) {
    const hitRatio = recent10Input > 0 ? Math.round((recent10Cached / recent10Input) * 100) : 0;
    if (recent10Hits === 0 && todayStats.totalRequests > 3 && todayHitRatio < 30) {
      lines.push(`📉 Cache hit rate is low: ${todayHitRatio}% today (${recent10Total} recent samples).`);
      lines.push("   Likely causes: proxy routing to different backends per request,");
      lines.push("   or prompt prefix changes across turns.");
      lines.push("   Verify session affinity (sendSessionAffinityHeaders) and long cache retention.");
    } else if (todayHitRatio < 30 && todayStats.totalRequests > 3) {
      lines.push(`📉 Cache hit rate is low: ${todayHitRatio}% today (${todayStats.totalRequests} total requests).`);
      lines.push("   Check compat flags and proxy upstream routing.");
    }

    // Show brief trend summary if there are enough samples
    if (recent10Total >= 3) {
      const trend = formatRecentTrendSummary(samples, 10);
      lines.push(`📊 ${trend}`);
    }
  }

  // For fully configured but low hit models, emphasize sticky routing
  if (!hasMissingCompat && !hasRouterRisk && todayStats.totalRequests > 3 && todayHitRatio < 30) {
    lines.push("💡 Compat is configured but cache hit rate remains low.");
    lines.push("   Possible causes:");
    lines.push("   • Proxy still routes to multiple backends — check session affinity on the proxy side.");
    lines.push("   • Prompt prefix varies per turn — check dynamic context in system prompt.");
    lines.push("   • Provider does not return cache usage fields — footer can't measure hits.");
  }

  return lines;
}

function buildCompatDiagnosis(model: PiModel): string | undefined {
  const missing = describeMissingCacheCompatForModel(model);
  const fixSugC = buildFixSuggestion(model);
  const safeFixableMissingC = fixSugC ? Object.keys(fixSugC.compatKeys) : [];
  const advisoryMissingC = missing.filter(m => !safeFixableMissingC.includes(m));
  const adaptiveThinkingApplicable = isAdaptiveThinkingCompatApplicable(model);
  const deepSeekCompatApplicable = isDeepSeekCompatCheckApplicable(model);
  const optionalOpenAIProxyCompat = !adaptiveThinkingApplicable
    ? describeOptionalOpenAICompatibleProxyCompat(model)
    : [];
  const routerNotes = describeRouterChannelDiagnostics(model);

  if (missing.length === 0 && routerNotes.length === 0 && optionalOpenAIProxyCompat.length === 0) return undefined;

  const key = modelKey(model);
  const lines: string[] = [];

  if (missing.length > 0) {
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    const modelsJsonPath = getModelsJsonDisplayPath();
    lines.push(`Active model: ${key}`);
    if (safeFixableMissingC.length > 0) {
      lines.push(`Safe-fixable: ${safeFixableMissingC.join(", ")}`);
    }
    if (advisoryMissingC.length > 0) {
      lines.push(`Optional: ${advisoryMissingC.join(", ")} (enable only if needed)`);
    }
    lines.push("");
    lines.push(`Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat`);
    lines.push(`(at the same level as baseUrl/api/apiKey/models).`);
    if (adaptiveThinkingApplicable) {
      appendAdaptiveThinkingCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
    } else if (deepSeekCompatApplicable) {
      appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    }
  }

  // When compat is fully configured but router/optional notes exist, prefix the status.
  if ((routerNotes.length > 0 || optionalOpenAIProxyCompat.length > 0) && missing.length === 0) {
    if (adaptiveThinkingApplicable || deepSeekCompatApplicable || isCompatCheckApplicable(model)) {
      lines.push("✅ Compat fully configured.");
      if (isPromptCacheRetention400Applicable(model)) {
        lines.push(getPromptCacheRetentionUnsupportedHint());
      }
      // Advisory for 403 session-affinity header blocking (only when enabled),
      // or OpenAI SDK header/User-Agent blocking after session affinity is disabled.
      if (isSessionAffinity403Applicable(model)) {
        lines.push(
          "ℹ️ Session affinity headers are enabled. If you see 403 \"blocked\" errors,",
          "   the proxy/CDN may be blocking Pi's custom headers. Set sendSessionAffinityHeaders: false.",
        );
      } else if (isOpenAISdkHeader403Applicable(model)) {
        lines.push(
          "ℹ️ If 403 persists with sendSessionAffinityHeaders disabled, the proxy/CDN may",
          "   be blocking the OpenAI JS SDK User-Agent / X-Stainless-* headers. Test a",
          "   provider-level headers.User-Agent override manually; /fix does not auto-write it.",
        );
      }
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      lines.push(...getCompatCheckNotApplicableLines(model));
    }
    lines.push("");
  }

  if (routerNotes.length > 0) {
    if (missing.length > 0) lines.push("");
    for (const note of routerNotes) {
      lines.push(note);
    }
  }

  return lines.join("\n");
}

// ============================================================
// JSONC comment-preserving surgical edit helpers for /cache-optimizer fix
// ============================================================

/** The real models.json path used for I/O. */
const MODELS_JSON_PATH = join(STATE_DIR, "models.json");

// ── String-aware JSONC scanning primitives ─────────────────────────
//
// These operate on comment-stripped text produced by stripJsoncComments()
// (which preserves byte offsets), so every offset they return is also valid
// in the original text. All scanning skips string literals, so braces or
// brackets inside string values (e.g. apiKeyCommand shell snippets) cannot
// corrupt depth tracking.

function isJsonWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function skipJsonWhitespace(text: string, pos: number): number {
  while (pos < text.length && isJsonWhitespace(text[pos])) pos++;
  return pos;
}

/**
 * Read a JSON string literal starting at `pos` (which must be `"`).
 * Returns the decoded value and the offset just past the closing quote,
 * or undefined when the literal is unterminated/malformed.
 */
function readJsonStringLiteral(text: string, pos: number): { value: string; end: number } | undefined {
  if (text[pos] !== '"') return undefined;
  let i = pos + 1;
  let value = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) return undefined;
      if (next === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        if (next === "n") value += "\n";
        else if (next === "t") value += "\t";
        else if (next === "r") value += "\r";
        else if (next === "b") value += "\b";
        else if (next === "f") value += "\f";
        else value += next; // ", \\, / and lenient passthrough
        i += 2;
      }
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i++;
  }
  return undefined;
}

/**
 * Find the offset of the `}` / `]` matching the opener at `openPos`,
 * skipping string literals. Returns undefined on imbalance.
 */
function findMatchingBracket(text: string, openPos: number): number | undefined {
  const open = text[openPos];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0;
  let i = openPos;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const str = readJsonStringLiteral(text, i);
      if (!str) return undefined;
      i = str.end;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return undefined;
}

/** Skip one JSON value starting at/after `pos`; returns the offset just past it. */
function skipJsonValue(text: string, pos: number): number | undefined {
  pos = skipJsonWhitespace(text, pos);
  const ch = text[pos];
  if (ch === '"') {
    const str = readJsonStringLiteral(text, pos);
    return str?.end;
  }
  if (ch === "{" || ch === "[") {
    const end = findMatchingBracket(text, pos);
    return end === undefined ? undefined : end + 1;
  }
  let i = pos;
  while (i < text.length && !",}]".includes(text[i]) && !isJsonWhitespace(text[i])) i++;
  return i > pos ? i : undefined;
}

/**
 * Find a top-level key in the object whose `{` is at `openBracePos`.
 * Only direct children are considered (nested values are skipped whole).
 * When duplicate keys exist, return the last one so scanning follows
 * JSON.parse/Pi's effective last-definition-wins behavior. `count` lets
 * callers refuse an ambiguous surgical edit rather than silently selecting a
 * user-added duplicate. Return undefined when the key is absent or the object
 * is malformed.
 */
function findJsonObjectKey(
  text: string,
  openBracePos: number,
  targetKey: string,
): { keyStart: number; valueStart: number; count: number } | undefined {
  if (text[openBracePos] !== "{") return undefined;
  let i = openBracePos + 1;
  let found: { keyStart: number; valueStart: number; count: number } | undefined;
  let count = 0;
  while (i < text.length) {
    i = skipJsonWhitespace(text, i);
    if (i >= text.length) return undefined;
    if (text[i] === "}") return found;
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] !== '"') return undefined; // unexpected token — refuse to guess
    const keyStart = i;
    const key = readJsonStringLiteral(text, i);
    if (!key) return undefined;
    i = skipJsonWhitespace(text, key.end);
    if (text[i] !== ":") return undefined;
    i = skipJsonWhitespace(text, i + 1);
    if (key.value === targetKey) {
      count++;
      found = { keyStart, valueStart: i, count };
    }
    const after = skipJsonValue(text, i);
    if (after === undefined) return undefined;
    i = after;
  }
  return undefined;
}

/** Leading whitespace of the line containing offset `pos` (up to `pos`). */
function lineIndentOf(text: string, pos: number): string {
  let lineStart = text.lastIndexOf("\n", pos - 1);
  lineStart = lineStart < 0 ? 0 : lineStart + 1;
  const m = text.slice(lineStart, pos).match(/^[ \t]*/);
  return m ? m[0] : "";
}

/**
 * Indentation used by the first line inside the object spanning
 * `openBrace`..`closeBrace` in the ORIGINAL text. Falls back to the
 * opener's line indent plus two spaces for single-line objects.
 */
function deriveInnerIndent(text: string, openBrace: number, closeBrace: number): string {
  const nl = text.indexOf("\n", openBrace + 1);
  if (nl >= 0 && nl < closeBrace) {
    let i = nl + 1;
    let ws = "";
    while (i < text.length && (text[i] === " " || text[i] === "\t")) {
      ws += text[i];
      i++;
    }
    if (ws.length > 0) return ws;
  }
  return lineIndentOf(text, openBrace) + "  ";
}

interface FixSuggestion {
  providerLabel: string;
  modelId: string;
  compatKeys: Record<string, unknown>;
  /** Runtime-observed failures must never broaden a model-specific fix. */
  forceModelLevel?: boolean;
}

/**
 * Build the fix suggestion for the current active model.
 * Returns undefined if there is nothing to fix.
 */
function buildFixSuggestion(model: PiModel): FixSuggestion | undefined {
  const missing = describeMissingCacheCompatForModel(model);
  if (missing.length === 0) return undefined;

  let compatKeys: Record<string, unknown> = {};

  if (isAdaptiveThinkingCompatApplicable(model)) {
    compatKeys = buildAdaptiveThinkingCompatSuggestion(missing);
  } else if (isDeepSeekCompatCheckApplicable(model)) {
    compatKeys = buildDeepSeekCompatSuggestion(missing);
  } else {
    compatKeys = buildSafeOpenAIProxyCompatSuggestion(missing);
  }

  if (Object.keys(compatKeys).length === 0) return undefined;

  const key = modelKey(model);
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;

  return {
    providerLabel,
    modelId: model.id,
    compatKeys,
  };
}

/**
 * Strip JSONC comments from text, replacing them with spaces.
 * Handles string literals, escaped quotes, // line comments, /* block comments *\/.
 * Returns the cleaned text with same line/column positions.
 */
function stripJsoncComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      // String literal — copy byte-for-byte until the closing quote.
      // Escaped quotes/slashes must not be mistaken for comment delimiters.
      out.push(ch);
      i++;
      while (i < text.length) {
        const sc = text[i];
        out.push(sc);
        i++;
        if (sc === '\\' && i < text.length) {
          out.push(text[i]);
          i++;
        } else if (sc === '"') {
          break;
        }
      }
      continue;
    }

    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      // Line comment — replace BOTH slashes and every comment byte with
      // spaces, but leave the newline to be copied by the normal path.
      out.push(' ', ' ');
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }

    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      // Block comment — replace every byte with a space except newlines.
      // This deliberately preserves text.length and all structural offsets.
      out.push(' ', ' ');
      i += 2;
      while (i < text.length) {
        if (text[i] === '*' && i + 1 < text.length && text[i + 1] === '/') {
          out.push(' ', ' ');
          i += 2;
          break;
        }
        out.push(text[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    out.push(ch);
    i++;
  }
  return out.join('');
}

/**
 * Remove JSONC trailing commas from already comment-stripped text.
 * The returned text stays length-preserving (commas become spaces), which
 * gives JSON.parse a tolerant JSONC surface without affecting diagnostics.
 */
function stripJsoncTrailingCommas(text: string): string {
  const chars = text.split("");
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '"') {
      const str = readJsonStringLiteral(text, i);
      if (!str) break;
      i = str.end;
      continue;
    }

    if (chars[i] === ',') {
      let j = i + 1;
      while (j < chars.length && isJsonWhitespace(chars[j])) j++;
      if (chars[j] === '}' || chars[j] === ']') chars[i] = ' ';
    }
    i++;
  }
  return chars.join('');
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(text)));
}

type ExplicitCompatSource = "modelOverride" | "model" | "provider";

interface ExplicitCompatValue {
  source: ExplicitCompatSource;
  value: unknown;
}

/**
 * Resolve one explicitly configured compat value using Pi's models.json
 * precedence. Built-in model overrides win over custom model definitions,
 * which in turn win over provider defaults.
 */
function resolveExplicitCompatValue(
  config: unknown,
  providerLabel: string,
  modelId: string,
  compatKey: string,
): ExplicitCompatValue | undefined {
  const providers = asRecord(asRecord(config)?.providers);
  const provider = asRecord(providers?.[providerLabel]);
  if (!provider) return undefined;

  const override = asRecord(asRecord(provider.modelOverrides)?.[modelId]);
  const overrideCompat = asRecord(override?.compat);
  if (overrideCompat && Object.prototype.hasOwnProperty.call(overrideCompat, compatKey)) {
    return { source: "modelOverride", value: overrideCompat[compatKey] };
  }

  const model = findLastExactModelDefinition(
    Array.isArray(provider.models) ? provider.models : undefined,
    modelId,
  );
  const modelCompat = asRecord(model?.compat);
  if (modelCompat && Object.prototype.hasOwnProperty.call(modelCompat, compatKey)) {
    return { source: "model", value: modelCompat[compatKey] };
  }

  const providerCompat = asRecord(provider.compat);
  if (providerCompat && Object.prototype.hasOwnProperty.call(providerCompat, compatKey)) {
    return { source: "provider", value: providerCompat[compatKey] };
  }

  return undefined;
}

function hasExplicitLongRetentionOptInFromConfig(
  config: unknown,
  providerLabel: string,
  modelId: string,
): boolean {
  return resolveExplicitCompatValue(
    config,
    providerLabel,
    modelId,
    "supportsLongCacheRetention",
  )?.value === true;
}

/**
 * JSONC scanner: locate the provider block and model entry in models.json text.
 * Returns the byte offsets for surgical insertion, or undefined if ambiguous.
 */
interface ModelNodeLocation {
  /** Number of exact provider keys found in the root providers object. */
  providerKeyCount: number;
  /** Offset of the model object's opening `{` */
  modelObjectBrace: number;
  /** Offset of the model object's closing `}` */
  modelObjectEnd: number;
  /** Offset of the "compat" key start (the `"`), or -1 if compat doesn't exist */
  compatKeyStart: number;
  /** Offset of the compat object's opening `{`, or -1 if compat doesn't exist */
  compatObjectBrace: number;
  /** Offset of the compat object's closing `}`, or -1 */
  compatObjectEnd: number;
  /** Indentation string to use for inserted lines (derived from surrounding context) */
  indent: string;
  /** Offset of the provider object's opening `{` */
  providerObjectBrace: number;
  /** Offset of the provider object's closing `}` */
  providerObjectEnd: number;
  /** Offset of the provider-level compat object's opening `{`, or -1 if absent */
  providerCompatBrace: number;
  /** Offset of the provider-level compat object's closing `}`, or -1 if absent */
  providerCompatEnd: number;
  /** Offset of the target modelOverrides entry's opening `{`, or -1 if absent */
  modelOverrideObjectBrace: number;
  /** Offset of the target modelOverrides entry's closing `}`, or -1 if absent */
  modelOverrideObjectEnd: number;
  /** Offset of the target override compat object's opening `{`, or -1 if absent */
  modelOverrideCompatBrace: number;
  /** Offset of the target override compat object's closing `}`, or -1 if absent */
  modelOverrideCompatEnd: number;
  /** Number of exact modelOverrides keys for this model id. */
  modelOverrideKeyCount: number;
  /** Number of exact compat keys in the selected model object. */
  modelCompatKeyCount: number;
  /** Number of exact provider compat keys. */
  providerCompatKeyCount: number;
  /** All model ids found in this provider's models array (for placement safety analysis) */
  allModelIds: string[];
}

interface ModelOverrideNodeLocation {
  providerKeyCount: number;
  modelOverridesKeyCount: number;
  modelOverrideKeyCount: number;
  modelOverrideCompatKeyCount: number;
  providerObjectBrace: number;
  providerObjectEnd: number;
  modelOverridesObjectBrace: number;
  modelOverridesObjectEnd: number;
  modelOverrideObjectBrace: number;
  modelOverrideObjectEnd: number;
  modelOverrideCompatBrace: number;
  modelOverrideCompatEnd: number;
}

interface ProviderCompatNodeLocation {
  providerObjectBrace: number;
  providerObjectEnd: number;
  providerCompatBrace: number;
  providerCompatEnd: number;
}

/** Locate a unique provider and its direct compat object without requiring models[]. */
function locateProviderCompatInJsonc(
  text: string,
  providerLabel: string,
): ProviderCompatNodeLocation | undefined {
  const clean = stripJsoncComments(text);
  const rootBrace = skipJsonWhitespace(clean, 0);
  if (clean[rootBrace] !== "{") return undefined;
  const providersKey = findJsonObjectKey(clean, rootBrace, "providers");
  if (!providersKey || providersKey.count !== 1) return undefined;
  const providersBrace = skipJsonWhitespace(clean, providersKey.valueStart);
  if (clean[providersBrace] !== "{") return undefined;
  const providersEnd = findMatchingBracket(clean, providersBrace);
  if (providersEnd === undefined) return undefined;
  const providerKey = findJsonObjectKey(clean, providersBrace, providerLabel);
  if (!providerKey || providerKey.count !== 1 || providerKey.keyStart > providersEnd) return undefined;
  const providerObjectBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerObjectBrace] !== "{") return undefined;
  const providerObjectEnd = findMatchingBracket(clean, providerObjectBrace);
  if (providerObjectEnd === undefined || providerObjectEnd > providersEnd) return undefined;

  for (const key of ["models", "modelOverrides"]) {
    const child = findJsonObjectKey(clean, providerObjectBrace, key);
    if (child?.count && child.count > 1) return undefined;
  }
  const compatKey = findJsonObjectKey(clean, providerObjectBrace, "compat");
  if (compatKey?.count && compatKey.count > 1) return undefined;
  if (!compatKey) {
    return { providerObjectBrace, providerObjectEnd, providerCompatBrace: -1, providerCompatEnd: -1 };
  }
  const providerCompatBrace = skipJsonWhitespace(clean, compatKey.valueStart);
  if (clean[providerCompatBrace] !== "{") return undefined;
  const providerCompatEnd = findMatchingBracket(clean, providerCompatBrace);
  if (providerCompatEnd === undefined || providerCompatEnd > providerObjectEnd) return undefined;
  return { providerObjectBrace, providerObjectEnd, providerCompatBrace, providerCompatEnd };
}

/** Locate a provider and optional modelOverrides entry without requiring models[]. */
function locateModelOverrideInJsonc(
  text: string,
  providerLabel: string,
  modelId: string,
): ModelOverrideNodeLocation | undefined {
  const clean = stripJsoncComments(text);
  const rootBrace = skipJsonWhitespace(clean, 0);
  if (clean[rootBrace] !== "{") return undefined;
  const providersKey = findJsonObjectKey(clean, rootBrace, "providers");
  if (!providersKey || providersKey.count !== 1) return undefined;
  const providersBrace = skipJsonWhitespace(clean, providersKey.valueStart);
  if (clean[providersBrace] !== "{") return undefined;
  const providersEnd = findMatchingBracket(clean, providersBrace);
  if (providersEnd === undefined) return undefined;
  const providerKey = findJsonObjectKey(clean, providersBrace, providerLabel);
  if (!providerKey || providerKey.count !== 1 || providerKey.keyStart > providersEnd) return undefined;
  const providerObjectBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerObjectBrace] !== "{") return undefined;
  const providerObjectEnd = findMatchingBracket(clean, providerObjectBrace);
  if (providerObjectEnd === undefined || providerObjectEnd > providersEnd) return undefined;
  const providerCompatKey = findJsonObjectKey(clean, providerObjectBrace, "compat");
  if (providerCompatKey?.count && providerCompatKey.count > 1) return undefined;
  const modelsKey = findJsonObjectKey(clean, providerObjectBrace, "models");
  if (modelsKey?.count && modelsKey.count > 1) return undefined;

  let modelOverridesObjectBrace = -1;
  let modelOverridesObjectEnd = -1;
  let modelOverrideObjectBrace = -1;
  let modelOverrideObjectEnd = -1;
  let modelOverrideCompatBrace = -1;
  let modelOverrideCompatEnd = -1;
  let modelOverrideKeyCount = 0;
  let modelOverrideCompatKeyCount = 0;
  const overridesKey = findJsonObjectKey(clean, providerObjectBrace, "modelOverrides");
  if (overridesKey?.count && overridesKey.count > 1) return undefined;
  if (overridesKey && overridesKey.keyStart < providerObjectEnd) {
    const brace = skipJsonWhitespace(clean, overridesKey.valueStart);
    if (clean[brace] !== "{") return undefined;
    const end = findMatchingBracket(clean, brace);
    if (end === undefined || end > providerObjectEnd) return undefined;
    modelOverridesObjectBrace = brace;
    modelOverridesObjectEnd = end;

    const overrideKey = findJsonObjectKey(clean, brace, modelId);
    modelOverrideKeyCount = overrideKey?.count ?? 0;
    if (overrideKey?.count && overrideKey.count > 1) return undefined;
    if (overrideKey && overrideKey.keyStart < end) {
      const entryBrace = skipJsonWhitespace(clean, overrideKey.valueStart);
      if (clean[entryBrace] !== "{") return undefined;
      const entryEnd = findMatchingBracket(clean, entryBrace);
      if (entryEnd === undefined || entryEnd > end) return undefined;
      modelOverrideObjectBrace = entryBrace;
      modelOverrideObjectEnd = entryEnd;

      const compatKey = findJsonObjectKey(clean, entryBrace, "compat");
      modelOverrideCompatKeyCount = compatKey?.count ?? 0;
      if (compatKey?.count && compatKey.count > 1) return undefined;
      if (compatKey && compatKey.keyStart < entryEnd) {
        const compatBrace = skipJsonWhitespace(clean, compatKey.valueStart);
        if (clean[compatBrace] !== "{") return undefined;
        const compatEnd = findMatchingBracket(clean, compatBrace);
        if (compatEnd === undefined || compatEnd > entryEnd) return undefined;
        modelOverrideCompatBrace = compatBrace;
        modelOverrideCompatEnd = compatEnd;
      }
    }
  }

  return {
    providerKeyCount: providerKey.count,
    modelOverridesKeyCount: overridesKey?.count ?? 0,
    modelOverrideKeyCount,
    modelOverrideCompatKeyCount,
    providerObjectBrace,
    providerObjectEnd,
    modelOverridesObjectBrace,
    modelOverridesObjectEnd,
    modelOverrideObjectBrace,
    modelOverrideObjectEnd,
    modelOverrideCompatBrace,
    modelOverrideCompatEnd,
  };
}

/**
 * Locate the provider + model entry in raw JSONC text.
 * Returns the positions needed for surgical insertion, or undefined on failure.
 *
 * This is a scan-only pass — no AST build, no regex reliance.
 */
function locateModelInJsonc(
  text: string,
  providerLabel: string,
  modelId: string,
): ModelNodeLocation | undefined {
  // Clean text of comments first for reliable structural scanning
  const clean = stripJsoncComments(text);

  // Strategy: find `"providers"` as a direct root key, then find the
  // provider key under it, then the provider's direct `"models"` key.
  // All object/value traversal uses the string-aware primitives above so
  // braces, brackets, comment markers, or escaped quotes inside strings do
  // not corrupt offsets.
  const rootBrace = skipJsonWhitespace(clean, 0);
  if (clean[rootBrace] !== "{") return undefined;

  const providersKey = findJsonObjectKey(clean, rootBrace, "providers");
  if (!providersKey || providersKey.count !== 1) return undefined;
  const providersBrace = skipJsonWhitespace(clean, providersKey.valueStart);
  if (clean[providersBrace] !== "{") return undefined;
  const providersEnd = findMatchingBracket(clean, providersBrace);
  if (providersEnd === undefined) return undefined;

  const providerKey = findJsonObjectKey(clean, providersBrace, providerLabel);
  if (!providerKey || providerKey.count !== 1 || providerKey.keyStart > providersEnd) return undefined;
  const providerBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerBrace] !== "{") return undefined;
  const providerEndBrace = findMatchingBracket(clean, providerBrace);
  if (providerEndBrace === undefined || providerEndBrace > providersEnd) return undefined;

  // Provider-level compat is a direct provider child only. Nested model
  // compat objects are intentionally skipped whole by findJsonObjectKey.
  let providerCompatBrace = -1;
  let providerCompatEnd = -1;
  const providerCompatKey = findJsonObjectKey(clean, providerBrace, "compat");
  const providerCompatKeyCount = providerCompatKey?.count ?? 0;
  if (providerCompatKey?.count && providerCompatKey.count > 1) return undefined;
  if (providerCompatKey && providerCompatKey.keyStart < providerEndBrace) {
    const brace = skipJsonWhitespace(clean, providerCompatKey.valueStart);
    if (clean[brace] !== "{") return undefined;
    const end = findMatchingBracket(clean, brace);
    if (end === undefined || end > providerEndBrace) return undefined;
    providerCompatBrace = brace;
    providerCompatEnd = end;
  }

  const modelOverridesKey = findJsonObjectKey(clean, providerBrace, "modelOverrides");
  if (modelOverridesKey?.count && modelOverridesKey.count > 1) return undefined;
  if (modelOverridesKey) {
    const modelOverridesBrace = skipJsonWhitespace(clean, modelOverridesKey.valueStart);
    if (clean[modelOverridesBrace] !== "{") return undefined;
    const modelOverridesEnd = findMatchingBracket(clean, modelOverridesBrace);
    if (modelOverridesEnd === undefined || modelOverridesEnd > providerEndBrace) return undefined;
    const overrideKey = findJsonObjectKey(clean, modelOverridesBrace, modelId);
    if (overrideKey?.count && overrideKey.count > 1) return undefined;
    if (overrideKey) {
      const overrideBrace = skipJsonWhitespace(clean, overrideKey.valueStart);
      if (clean[overrideBrace] !== "{") return undefined;
      const overrideEnd = findMatchingBracket(clean, overrideBrace);
      if (overrideEnd === undefined || overrideEnd > modelOverridesEnd) return undefined;
      const overrideCompatKey = findJsonObjectKey(clean, overrideBrace, "compat");
      if (overrideCompatKey?.count && overrideCompatKey.count > 1) return undefined;
    }
  }

  const overrideLocation = locateModelOverrideInJsonc(text, providerLabel, modelId);
  const modelOverrideObjectBrace = overrideLocation?.modelOverrideObjectBrace ?? -1;
  const modelOverrideObjectEnd = overrideLocation?.modelOverrideObjectEnd ?? -1;
  const modelOverrideCompatBrace = overrideLocation?.modelOverrideCompatBrace ?? -1;
  const modelOverrideCompatEnd = overrideLocation?.modelOverrideCompatEnd ?? -1;

  const modelsKey = findJsonObjectKey(clean, providerBrace, "models");
  if (!modelsKey || modelsKey.count !== 1 || modelsKey.keyStart > providerEndBrace) return undefined;

  let modelsScan = skipJsonWhitespace(clean, modelsKey.valueStart);
  if (clean[modelsScan] !== "[") return undefined;
  const modelsEnd = findMatchingBracket(clean, modelsScan);
  if (modelsEnd === undefined || modelsEnd > providerEndBrace) return undefined;
  modelsScan++; // Skip `[`

  // Scan ALL array elements: collect every model id, and record the target's position
  const allModelIds: string[] = [];
  let modelBrace = -1;
  let modelEndBrace = -1;
  let compatKeyStartClean = -1;
  let compatBrace = -1;
  let compatEndBrace = -1;
  let modelCompatKeyCount = 0;

  while (modelsScan < modelsEnd) {
    modelsScan = skipJsonWhitespace(clean, modelsScan);
    if (clean[modelsScan] === ',') {
      modelsScan++;
      continue;
    }
    if (modelsScan >= modelsEnd || clean[modelsScan] === ']') break;
    if (clean[modelsScan] !== '{') return undefined;

    const elementBrace = modelsScan;
    const elementEnd = findMatchingBracket(clean, elementBrace);
    if (elementEnd === undefined || elementEnd > modelsEnd) return undefined;

    const idKey = findJsonObjectKey(clean, elementBrace, "id");
    if (idKey?.count && idKey.count > 1) return undefined;
    let elementId: string | undefined;
    if (idKey && idKey.keyStart < elementEnd) {
      const idValueStart = skipJsonWhitespace(clean, idKey.valueStart);
      const idLiteral = readJsonStringLiteral(clean, idValueStart);
      if (idLiteral && idLiteral.end <= elementEnd) {
        elementId = idLiteral.value;
      }
    }

    if (elementId !== undefined) {
      allModelIds.push(elementId);
    }

    if (elementId === modelId) {
      // Match Pi's provider composer: later duplicate definitions replace
      // earlier ones. The effective/fix target is therefore the last exact id.
      modelBrace = elementBrace;
      modelEndBrace = elementEnd;
      compatKeyStartClean = -1;
      compatBrace = -1;
      compatEndBrace = -1;

      const compatKey = findJsonObjectKey(clean, modelBrace, "compat");
      modelCompatKeyCount = compatKey?.count ?? 0;
      if (compatKey?.count && compatKey.count > 1) return undefined;
      if (compatKey && compatKey.keyStart < modelEndBrace) {
        compatKeyStartClean = compatKey.keyStart;
        const brace = skipJsonWhitespace(clean, compatKey.valueStart);
        if (clean[brace] !== "{") return undefined;
        const end = findMatchingBracket(clean, brace);
        if (end === undefined || end > modelEndBrace) return undefined;
        compatBrace = brace;
        compatEndBrace = end;
      }
    }

    modelsScan = elementEnd + 1;
  }

  if (modelBrace < 0 || modelEndBrace < 0) return undefined;

  // Derive indentation from the model object's opening `{` line in original text
  // Look backwards to find the line start
  let lineStart = text.lastIndexOf('\n', modelBrace);
  if (lineStart < 0) lineStart = 0;
  const lineBefore = text.slice(lineStart, modelBrace);
  const indentMatch = lineBefore.match(/^(\s*)/);
  const baseIndent = indentMatch ? indentMatch[1] : '  ';
  const indent = baseIndent + '  '; // +2 for one level deeper

  return {
    modelObjectBrace: modelBrace,
    modelObjectEnd: modelEndBrace,
    compatKeyStart: compatKeyStartClean >= 0 ? compatKeyStartClean : -1,
    compatObjectBrace: compatBrace,
    compatObjectEnd: compatEndBrace,
    indent,
    providerObjectBrace: providerBrace,
    providerObjectEnd: providerEndBrace,
    providerCompatBrace,
    providerCompatEnd,
    modelOverrideObjectBrace,
    modelOverrideObjectEnd,
    modelOverrideCompatBrace,
    modelOverrideCompatEnd,
    providerKeyCount: providerKey.count,
    modelOverrideKeyCount: overrideLocation?.modelOverrideKeyCount ?? 0,
    modelCompatKeyCount,
    providerCompatKeyCount,
    allModelIds,
  };
}

/**
 * Scan produced by `analyzeModelsJsonForMissingEntry` when
 * `locateModelInJsonc` cannot find the target provider/model.
 */
type MissingEntryDiagnosis =
  | { scenario: "provider_missing"; providersBrace: number; providersEnd: number }
  | { scenario: "model_missing"; modelsEnd: number; providerBrace: number; providerEndBrace: number }
  | { scenario: "provider_without_models"; providerBrace: number; providerEndBrace: number };

/**
 * Light second-pass scan that determines *why* `locateModelInJsonc` failed.
 * Returns structured diagnostic so the fix handler can compose targeted
 * guidance and an optional surgical insertion for API-logged-in models
 * (e.g. opencode go) that never appear in `models.json`.
 */
function analyzeModelsJsonForMissingEntry(
  text: string,
  providerLabel: string,
  modelId: string,
): MissingEntryDiagnosis | undefined {
  const clean = stripJsoncComments(text);
  const rootBrace = skipJsonWhitespace(clean, 0);
  if (clean[rootBrace] !== "{") return undefined;

  const providersKey = findJsonObjectKey(clean, rootBrace, "providers");
  if (!providersKey || providersKey.count !== 1) {
    // Root has no unique "providers" key — we don't auto-create or guess
    // among duplicate definitions.
    return undefined;
  }
  const providersBrace = skipJsonWhitespace(clean, providersKey.valueStart);
  if (clean[providersBrace] !== "{") return undefined;
  const providersEnd = findMatchingBracket(clean, providersBrace);
  if (providersEnd === undefined) return undefined;

  const providerKey = findJsonObjectKey(clean, providersBrace, providerLabel);
  if (!providerKey) {
    return { scenario: "provider_missing", providersBrace, providersEnd };
  }
  if (providerKey.count !== 1 || providerKey.keyStart > providersEnd) return undefined;

  // Provider exists. Check for a models array so we know where to append.
  const providerBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerBrace] !== "{") return undefined;
  const providerEndBrace = findMatchingBracket(clean, providerBrace);
  if (providerEndBrace === undefined || providerEndBrace > providersEnd) return undefined;

  const modelsKey = findJsonObjectKey(clean, providerBrace, "models");
  if (modelsKey?.count && modelsKey.count > 1) return undefined;
  if (modelsKey && modelsKey.keyStart < providerEndBrace) {
    const mScan = skipJsonWhitespace(clean, modelsKey.valueStart);
    if (clean[mScan] !== "[") return undefined;
    const modelsEnd = findMatchingBracket(clean, mScan);
    if (modelsEnd === undefined || modelsEnd > providerEndBrace) return undefined;

    // Confirm that the target really is absent before offering an insertion.
    // This second pass also refuses malformed/ambiguous existing entries, so
    // a scanner failure can never turn into a duplicate model definition.
    let modelScan = mScan + 1;
    let targetFound = false;
    while (modelScan < modelsEnd) {
      modelScan = skipJsonWhitespace(clean, modelScan);
      if (clean[modelScan] === ",") {
        modelScan++;
        continue;
      }
      if (modelScan >= modelsEnd || clean[modelScan] === "]") break;
      if (clean[modelScan] !== "{") return undefined;
      const elementEnd = findMatchingBracket(clean, modelScan);
      if (elementEnd === undefined || elementEnd > modelsEnd) return undefined;
      const idKey = findJsonObjectKey(clean, modelScan, "id");
      if (!idKey || idKey.count !== 1) return undefined;
      const idStart = skipJsonWhitespace(clean, idKey.valueStart);
      const idLiteral = readJsonStringLiteral(clean, idStart);
      if (!idLiteral || idLiteral.end > elementEnd) return undefined;
      if (idLiteral.value === modelId) {
        targetFound = true;
        const compatKey = findJsonObjectKey(clean, modelScan, "compat");
        if (compatKey?.count && compatKey.count > 1) return undefined;
      }
      modelScan = elementEnd + 1;
    }
    if (targetFound) return undefined;
    return { scenario: "model_missing", modelsEnd, providerBrace, providerEndBrace };
  }

  // Provider exists, but there's no discoverable models array — treat as
  // a provider that needs one.
  return { scenario: "provider_without_models", providerBrace, providerEndBrace };
}

/**
 * Build a copyable manual-edit snippet for the missing entry. Used when the
 * terminal is non-interactive or the user chooses to edit by hand.
 * Returns a complete provider→model→compat JSON block that the user can
 * paste into `models.json` under `providers`.
 */
function formatMissingEntryManualSnippet(
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
): string {
  const lines: string[] = [];
  const sorted = Object.entries(compatKeys).sort(([a], [b]) => a.localeCompare(b));
  const compatItems = sorted.map(([k, v]) => `          ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  lines.push(`${JSON.stringify(providerLabel)}: {`);
  lines.push(`    "modelOverrides": {`);
  lines.push(`      ${JSON.stringify(modelId)}: {`);
  lines.push(`        "compat": {`);
  lines.push(compatItems.join(",\n"));
  lines.push(`        }`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`  }`);
  return lines.join("\n");
}

/**
 * Insert or repair a modelOverrides entry without creating a custom models[]
 * definition. This is the safest representation for built-in/API-login models
 * and has the same highest precedence Pi applies at runtime.
 */
function composeModelOverrideInsertion(
  originalText: string,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
): { modifiedText: string; placementLabel: string } | undefined {
  const location = locateModelOverrideInJsonc(originalText, providerLabel, modelId);

  if (location?.modelOverrideObjectBrace !== undefined && location.modelOverrideObjectBrace >= 0) {
    const modelLocation: ModelNodeLocation = {
      providerKeyCount: location.providerKeyCount,
      modelObjectBrace: -1,
      modelObjectEnd: -1,
      compatKeyStart: -1,
      compatObjectBrace: -1,
      compatObjectEnd: -1,
      indent: "",
      providerObjectBrace: location.providerObjectBrace,
      providerObjectEnd: location.providerObjectEnd,
      providerCompatBrace: -1,
      providerCompatEnd: -1,
      modelOverrideObjectBrace: location.modelOverrideObjectBrace,
      modelOverrideObjectEnd: location.modelOverrideObjectEnd,
      modelOverrideCompatBrace: location.modelOverrideCompatBrace,
      modelOverrideCompatEnd: location.modelOverrideCompatEnd,
      modelOverrideKeyCount: location.modelOverrideKeyCount,
      modelCompatKeyCount: 0,
      providerCompatKeyCount: 0,
      allModelIds: [],
    };
    return {
      modifiedText: composeFixInsertion(originalText, modelLocation, compatKeys, "modelOverride"),
      placementLabel: `providers["${providerLabel}"] -> modelOverrides["${modelId}"] -> compat`,
    };
  }

  const sortedEntries = Object.entries(compatKeys).sort(([a], [b]) => a.localeCompare(b));
  const formatOverrideEntry = (keyIndent: string, unit: string): string => {
    const propertyIndent = keyIndent + unit;
    const compatIndent = propertyIndent + unit;
    const compatLines = sortedEntries
      .map(([key, value]) => `${compatIndent}${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(",\n");
    return `${keyIndent}${JSON.stringify(modelId)}: {\n` +
      `${propertyIndent}"compat": {\n${compatLines}\n${propertyIndent}}\n${keyIndent}}`;
  };
  const previousTokenNeedsComma = (clean: string, closeBrace: number): boolean => {
    let pos = closeBrace - 1;
    while (pos >= 0 && isJsonWhitespace(clean[pos])) pos--;
    return clean[pos] !== "{" && clean[pos] !== ",";
  };

  if (location) {
    const clean = stripJsoncComments(originalText);
    if (location.modelOverridesObjectBrace >= 0) {
      const containerIndent = lineIndentOf(originalText, location.modelOverridesObjectBrace);
      const keyIndent = deriveInnerIndent(
        originalText,
        location.modelOverridesObjectBrace,
        location.modelOverridesObjectEnd,
      );
      const unit = keyIndent.length > containerIndent.length
        ? keyIndent.slice(containerIndent.length)
        : "  ";
      const comma = previousTokenNeedsComma(clean, location.modelOverridesObjectEnd) ? "," : "";
      const insertion = `${comma}\n${formatOverrideEntry(keyIndent, unit)}\n${containerIndent}`;
      return {
        modifiedText: originalText.slice(0, location.modelOverridesObjectEnd) + insertion + originalText.slice(location.modelOverridesObjectEnd),
        placementLabel: `providers["${providerLabel}"] -> modelOverrides -> (new entry "${modelId}")`,
      };
    }

    const providerIndent = lineIndentOf(originalText, location.providerObjectBrace);
    const propertyIndent = deriveInnerIndent(originalText, location.providerObjectBrace, location.providerObjectEnd);
    const unit = propertyIndent.length > providerIndent.length
      ? propertyIndent.slice(providerIndent.length)
      : "  ";
    const entryIndent = propertyIndent + unit;
    const block = `\n${propertyIndent}"modelOverrides": {\n` +
      `${formatOverrideEntry(entryIndent, unit)}\n${propertyIndent}},`;
    return {
      modifiedText: originalText.slice(0, location.providerObjectBrace + 1) + block + originalText.slice(location.providerObjectBrace + 1),
      placementLabel: `providers["${providerLabel}"] -> (new modelOverrides entry "${modelId}")`,
    };
  }

  const diagnosis = analyzeModelsJsonForMissingEntry(originalText, providerLabel, modelId);
  if (!diagnosis || diagnosis.scenario !== "provider_missing") return undefined;
  const clean = stripJsoncComments(originalText);
  const providersIndent = lineIndentOf(originalText, diagnosis.providersEnd);
  const providerIndent = deriveInnerIndent(originalText, diagnosis.providersBrace, diagnosis.providersEnd);
  const unit = providerIndent.length > providersIndent.length
    ? providerIndent.slice(providersIndent.length)
    : "  ";
  const overridesIndent = providerIndent + unit;
  const entryIndent = overridesIndent + unit;
  const comma = previousTokenNeedsComma(clean, diagnosis.providersEnd) ? "," : "";
  const block = `${comma}\n${providerIndent}${JSON.stringify(providerLabel)}: {\n` +
    `${overridesIndent}"modelOverrides": {\n${formatOverrideEntry(entryIndent, unit)}\n` +
    `${overridesIndent}}\n${providerIndent}}\n${providersIndent}`;
  return {
    modifiedText: originalText.slice(0, diagnosis.providersEnd) + block + originalText.slice(diagnosis.providersEnd),
    placementLabel: `providers -> (new modelOverrides-only entry "${providerLabel}/${modelId}")`,
  };
}

/**
 * Surgically insert the missing provider/model entry into the original
 * JSONC text. Returns the modified text and placement descriptor.
 *
 * Handles three scenarios:
 * - `model_missing`: append a new model object to the provider's `models` array.
 * - `provider_missing`: append a new provider block to the root `providers` object.
 * - `provider_without_models`: inject a `"models": [...]` key into the existing provider.
 */
function composeMissingEntryInsertion(
  originalText: string,
  diagnosis: MissingEntryDiagnosis,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
): { modifiedText: string; placementLabel: string } {
  // Comments preserve length when stripped (`stripJsoncComments` replaces
  // comment bytes 1-for-1 with spaces), so offsets derived from the
  // comment-stripped text map cleanly back to the original. However,
  // `lastIndexOf("{", pos)` / `lastIndexOf("[", pos)` must NOT be run
  // against the raw original: a comment like `// add [more] here with a {
  // brace` would surface `[` / `{` bytes that have no structural meaning,
  // contaminating the `hasExisting`/`hasExistingElements` decision below
  // and producing a stray leading comma. Run the structural searches
  // against the comment-stripped version; keep the indentation lookups
  // (which only care about newlines + leading whitespace) on the
  // original since comments never contain forward-scan-relevant bytes.
  const cleanText = stripJsoncComments(originalText);

  // Resolve a sensible indentation step from an arbitrary byte offset in
  // the original file.
  const indentUnitAt = (offset: number): string => {
    const ls = originalText.lastIndexOf("\n", offset);
    const line = originalText.slice(ls < 0 ? 0 : ls + 1, offset);
    const m = line.match(/^(\s+)/);
    return m ? m[1] : "  ";
  };

  // Figure out the base indent from the insertion point's own line.
  // Then derive inner indents (+1 and +2 levels).
  const sorted = Object.entries(compatKeys).sort(([a], [b]) => a.localeCompare(b));
  const formatCompactCompat = (indent: string): string => {
    // Single-line compact when there's only one key, multi-line otherwise.
    if (sorted.length === 1) {
      const [k, v] = sorted[0];
      return `{ ${JSON.stringify(k)}: ${JSON.stringify(v)} }`;
    }
    return (
      "{\n" +
      sorted.map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") +
      "\n" +
      indent.slice(0, -2) +
      "}"
    );
  };

  if (diagnosis.scenario === "model_missing") {
    // Append to the provider's models array, right before `]`.
    const unit = indentUnitAt(diagnosis.modelsEnd);
    const inner0 = unit + unit; // indent of model object's own keys
    const inner1 = inner0 + unit; // indent of compat keys inside the model
    const inner2 = inner1 + unit; // indent of compat values

    // Determine whether the array is empty (need to skip the leading comma).
    // Search for the models `[` on the comment-stripped text so a `[` inside
    // a comment cannot be mistaken for the array opener.
    const arrayInterior = cleanText.slice(
      cleanText.lastIndexOf("[", diagnosis.modelsEnd) + 1,
      diagnosis.modelsEnd,
    ).trim();
    const hasExistingElements = arrayInterior.length > 0;

    const compatBlock = formatCompactCompat(inner2);
    const modelBlock = [
      hasExistingElements ? "," : "",
      inner0 + "{",
      inner1 + `"id": ${JSON.stringify(modelId)},`,
      inner1 + `"compat": ` + compatBlock,
      inner0 + "}",
      unit,
    ].filter(Boolean).join("\n");

    const insertionPoint = diagnosis.modelsEnd;
    const prefix = originalText.slice(0, insertionPoint);
    const suffix = originalText.slice(insertionPoint); // starts with `]`
    return {
      modifiedText: prefix + modelBlock + suffix,
      placementLabel: `providers["${providerLabel}"] -> models -> (new entry for "${modelId}")`,
    };
  }

  if (diagnosis.scenario === "provider_missing") {
    // Append a new provider entry to the root `providers` object, right
    // before its closing `}`.
    const unit = indentUnitAt(diagnosis.providersEnd);
    const inner0 = unit + unit;
    const inner1 = inner0 + unit;
    const inner2 = inner1 + unit;
    const inner3 = inner2 + unit;

    const compatBlock = formatCompactCompat(inner3);
    // Search for the providers `{` on the comment-stripped text so a `{`
    // inside a comment cannot be mistaken for the providers object opener.
    const providersInterior = cleanText.slice(
      cleanText.lastIndexOf("{", diagnosis.providersEnd) + 1,
      diagnosis.providersEnd,
    ).trim();
    const hasExisting = providersInterior.length > 0;

    const providerBlock = [
      hasExisting ? "," : "",
      inner0 + `"${providerLabel}": {`,
      inner1 + `"models": [`,
      inner2 + "{",
      inner3 + `"id": ${JSON.stringify(modelId)},`,
      inner3 + `"compat": ` + compatBlock,
      inner2 + "}",
      inner1 + "]",
      inner0 + "}",
      unit,
    ].filter(Boolean).join("\n");

    const insertionPoint = diagnosis.providersEnd;
    const prefix = originalText.slice(0, insertionPoint);
    const suffix = originalText.slice(insertionPoint);
    return {
      modifiedText: prefix + providerBlock + suffix,
      placementLabel: `providers -> (new entry "${providerLabel}")`,
    };
  }

  // `provider_without_models`: inject a models array key into the
  // existing provider block, right after the provider's opening `{`.
  const unit = indentUnitAt(diagnosis.providerBrace);
  const inner0 = unit + unit;
  const inner1 = inner0 + unit;
  const inner2 = inner1 + unit;

  const compatBlock = formatCompactCompat(inner2);
  const afterBrace = diagnosis.providerBrace + 1;
  const modelsBlock = [
    "",
    inner0 + `"models": [`,
    inner1 + "{",
    inner2 + `"id": ${JSON.stringify(modelId)},`,
    inner2 + `"compat": ` + compatBlock,
    inner1 + "}",
    inner0 + "],",
    unit,
  ].join("\n");

  return {
    modifiedText: originalText.slice(0, afterBrace) + modelsBlock + originalText.slice(afterBrace),
    placementLabel: `providers["${providerLabel}"] -> (new "models" array with "${modelId}")`,
  };
}

/**
 * Lightweight self-check for a newly inserted model or modelOverrides entry.
 * Parses the modified text as JSONC and confirms:
 *   1. The target exists under models[] or modelOverrides.
 *   2. Every compat key has the expected effective provider/model/runtime/
 *      modelOverride value.
 * Returns null on success, an error string on failure.
 */
function selfCheckMissingEntryInsertion(
  originalText: string,
  modifiedText: string,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
  runtimeModel?: PiModel,
): string | null {
  try {
    const origParsed = parseJsonc(originalText);
    const modParsed = parseJsonc(modifiedText);
    const providers = asRecord(asRecord(modParsed)?.providers);
    if (!providers) return "Modified file: providers object missing or invalid";
    const provider = asRecord(providers[providerLabel]);
    if (!provider) return `Modified file: provider "${providerLabel}" not found`;
    const models = provider.models;
    const targetModel = Array.isArray(models)
      ? models.find((m: unknown) => asRecord(m)?.id === modelId)
      : undefined;
    const targetOverride = asRecord(asRecord(provider.modelOverrides)?.[modelId]);
    if (!targetModel && !targetOverride) {
      return `Modified file: model or modelOverrides entry "${modelId}" not found in provider after insertion`;
    }

    const effectiveCompat = runtimeModel
      ? resolveEffectiveCompatFromConfig(runtimeModel, modParsed)
      : undefined;
    for (const [k, v] of Object.entries(compatKeys)) {
      if (effectiveCompat) {
        if (!Object.prototype.hasOwnProperty.call(effectiveCompat, k)) {
          return `Modified file: effective compat.${k} not found`;
        }
        if ((effectiveCompat as Record<string, unknown>)[k] !== v) {
          return `Modified file: effective compat.${k} wrong value: expected ${JSON.stringify(v)}, got ${JSON.stringify((effectiveCompat as Record<string, unknown>)[k])}`;
        }
        continue;
      }
      const effective = resolveExplicitCompatValue(modParsed, providerLabel, modelId, k);
      if (!effective) return `Modified file: effective compat.${k} not found`;
      if (effective.value !== v) {
        return `Modified file: effective compat.${k} wrong value: expected ${JSON.stringify(v)}, got ${JSON.stringify(effective.value)} from ${effective.source}`;
      }
    }

    // Normalize only the intended override edit back to its original shape,
    // then require the complete parsed structure to match. This catches data
    // loss while allowing legitimate shorter repairs such as false -> true.
    const normalized = JSON.parse(JSON.stringify(modParsed)) as Record<string, unknown>;
    const origProviders = asRecord(asRecord(origParsed)?.providers);
    const origProvider = asRecord(origProviders?.[providerLabel]);
    const normalizedProviders = asRecord(normalized.providers);
    if (!normalizedProviders) return "Modified file: normalized providers object missing";

    if (!origProvider) {
      delete normalizedProviders[providerLabel];
    } else if (targetOverride) {
      const normalizedProvider = asRecord(normalizedProviders[providerLabel]);
      const normalizedOverrides = asRecord(normalizedProvider?.modelOverrides);
      const origOverrides = asRecord(origProvider.modelOverrides);
      const origOverride = asRecord(origOverrides?.[modelId]);

      if (!normalizedProvider || !normalizedOverrides) {
        return `Modified file: modelOverrides["${modelId}"] missing during structure validation`;
      }
      if (!origOverride) {
        delete normalizedOverrides[modelId];
        if (!origOverrides) delete normalizedProvider.modelOverrides;
      } else {
        const normalizedOverride = asRecord(normalizedOverrides[modelId]);
        if (!normalizedOverride) return `Modified file: modelOverrides["${modelId}"] invalid`;
        const origCompat = asRecord(origOverride.compat);
        const normalizedCompat = asRecord(normalizedOverride.compat);
        if (!origCompat) {
          delete normalizedOverride.compat;
        } else {
          if (!normalizedCompat) return `Modified file: modelOverrides["${modelId}"].compat invalid`;
          for (const key of Object.keys(compatKeys)) {
            if (Object.prototype.hasOwnProperty.call(origCompat, key)) {
              normalizedCompat[key] = origCompat[key];
            } else {
              delete normalizedCompat[key];
            }
          }
        }
      }
    } else {
      // Backward-compatible validation for the legacy models[] insertion
      // helper retained in __internals_for_tests.
      const normalizedProvider = asRecord(normalizedProviders[providerLabel]);
      const normalizedModels = normalizedProvider?.models;
      const origModels = origProvider.models;
      if (!normalizedProvider || !Array.isArray(normalizedModels)) {
        return `Modified file: provider "${providerLabel}".models missing during structure validation`;
      }
      normalizedProvider.models = normalizedModels.filter(
        (entry: unknown) => asRecord(entry)?.id !== modelId,
      );
      if (!Array.isArray(origModels)) delete normalizedProvider.models;
    }

    if (!deepEqualIgnoringKeys(normalized, origParsed, [])) {
      return "Modified file: original structure was altered (data loss detected)";
    }

    const modClean = stripJsoncComments(modifiedText);
    const rootStart = skipJsonWhitespace(modClean, 0);
    const rootEnd = findMatchingBracket(modClean, rootStart);
    if (rootEnd === undefined) return "Modified file: root bracket mismatch";
    if (skipJsonWhitespace(modClean, rootEnd + 1) !== modClean.length)
      return "Modified file: trailing content after root object";

    return null;
  } catch (e) {
    return `Self-check error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Deep-equal comparison of two values, used for post-write self-check.
 * Compares all keys recursively, allowing `extraKeys` to be present in `a` but not in `b`.
 */
function deepEqualIgnoringKeys(a: unknown, b: unknown, extraKeys: string[]): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualIgnoringKeys(a[i], b[i], extraKeys)) return false;
    }
    return true;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const aKeys = Object.keys(a as Record<string, unknown>).filter(k => !extraKeys.includes(k));
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!(k in (b as Record<string, unknown>))) return false;
      if (!deepEqualIgnoringKeys(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        extraKeys,
      )) return false;
    }
    return true;
  }
  return false;
}

/**
 * Compose the fix: produce the modified text with compat keys inserted.
 *
 * Strategy:
 * - If compat object exists: replace its interior (between `{` and `}`)
 *   with new keys + existing content, preserving surrounding bytes.
 * - If compat doesn't exist: insert `"compat": { keys }` after model `{`.
 *
 * Uses the raw original text; only the inserted/compat region changes.
 */
/**
 * Compat keys that describe CHANNEL capabilities (routing, endpoint features).
 * These are always safe at the provider level because they do not change
 * per-model request semantics.
 */
const PROVIDER_LEVEL_SAFE_COMPAT_KEYS = new Set<string>([
  "sendSessionAffinityHeaders",
  "supportsLongCacheRetention",
]);

function syntheticModelForId(providerLabel: string, id: string): PiModel {
  return { provider: providerLabel, id, name: id } as PiModel;
}

/**
 * Decide whether the fix should write provider-level or model-level compat.
 *
 * Strategy (auto-detect, prefer provider level when safe):
 * - Channel-capability keys (session affinity / long retention) are normally
 *   provider-safe; runtime-observed model failures explicitly override this
 *   default through chooseFixPlacement(..., forceModelLevel=true).
 * - Model-behavior keys (forceAdaptiveThinking, allowEmptySignature,
 *   thinkingFormat, ...) are provider-safe ONLY when every sibling model in
 *   the provider also matches the same detection (all adaptive-generation /
 *   Kimi Coding adaptive / DeepSeek-like).
 * - Single-model providers: provider level is equivalent — prefer it.
 * - Any unsafe key → fall back to model level (single write, smallest blast radius).
 */
function decideFixPlacement(
  compatKeys: Record<string, unknown>,
  providerLabel: string,
  allModelIds: string[],
): { placement: "provider" | "model"; reason: string } {
  const siblings = allModelIds.filter(Boolean);

  if (siblings.length <= 1) {
    return {
      placement: "provider",
      reason: "this provider has only one model — provider-level compat is equivalent and easier to maintain",
    };
  }

  const unsafeKeys: string[] = [];
  for (const key of Object.keys(compatKeys)) {
    if (PROVIDER_LEVEL_SAFE_COMPAT_KEYS.has(key)) continue;

    if (key === "forceAdaptiveThinking") {
      const allAdaptive = siblings.every((id) => {
        const sibling = syntheticModelForId(providerLabel, id);
        return isAdaptiveGenerationModel(sibling) || isKimiCodingAdaptiveModel(sibling);
      });
      if (!allAdaptive) unsafeKeys.push(key);
      continue;
    }
    if (key === "allowEmptySignature") {
      const allKimiCodingAdaptive = siblings.every((id) => isKimiCodingAdaptiveModel(syntheticModelForId(providerLabel, id)));
      if (!allKimiCodingAdaptive) unsafeKeys.push(key);
      continue;
    }
    if (key === "thinkingFormat" || key === "requiresReasoningContentOnAssistantMessages") {
      // Reasoning wire/replay behavior is model-specific. Sibling ids do not
      // prove that they use the same protocol, so never broaden this repair to
      // provider scope based on a shared DeepSeek name alone.
      unsafeKeys.push(key);
      continue;
    }
    // Unknown model-behavior key — be conservative, keep it model-scoped.
    unsafeKeys.push(key);
  }

  if (unsafeKeys.length === 0) {
    return {
      placement: "provider",
      reason: `all ${siblings.length} models in this provider are compatible with these flags`,
    };
  }
  return {
    placement: "model",
    reason: `${unsafeKeys.join(", ")} could break sibling models in this provider (${siblings.length} models total) — scoping to this model only`,
  };
}

function findExistingCompatKeysInJsonc(
  original: string,
  compatBrace: number,
  compatEnd: number,
  keys: string[],
): string[] {
  if (compatBrace < 0 || compatEnd <= compatBrace) return [];
  const clean = stripJsoncComments(original);
  return keys.filter((key) => {
    const found = findJsonObjectKey(clean, compatBrace, key);
    return !!found && found.keyStart < compatEnd;
  });
}

function chooseFixPlacement(
  original: string,
  location: ModelNodeLocation,
  compatKeys: Record<string, unknown>,
  providerLabel: string,
  forceModelLevel = false,
): { placement: "provider" | "model" | "modelOverride"; reason: string } {
  if (location.modelOverrideObjectBrace >= 0) {
    return {
      placement: "modelOverride",
      reason: "an existing modelOverrides entry has Pi's highest precedence — repairing it directly",
    };
  }

  if (forceModelLevel) {
    return {
      placement: "modelOverride",
      reason: "runtime-observed provider/model failure — using Pi's highest-precedence model override",
    };
  }

  const decision = decideFixPlacement(compatKeys, providerLabel, location.allModelIds);
  const existingModelKeys = findExistingCompatKeysInJsonc(
    original,
    location.compatObjectBrace,
    location.compatObjectEnd,
    Object.keys(compatKeys),
  );

  // Provider-level writes cannot override a model-level compat key because Pi's
  // merge order is provider.compat then model.compat. If the active model already
  // has one of the keys we need to repair (e.g. thinkingFormat: "legacy"), write
  // at model level even when the key would otherwise be provider-safe.
  if (decision.placement === "provider" && existingModelKeys.length > 0) {
    return {
      placement: "model",
      reason: `model-level compat already contains ${existingModelKeys.join(", ")} — repairing the active model override directly`,
    };
  }

  return decision;
}

type CompatInsertionLocation = Pick<ModelNodeLocation,
  | "modelObjectBrace"
  | "compatObjectBrace"
  | "compatObjectEnd"
  | "providerObjectBrace"
  | "providerCompatBrace"
  | "providerCompatEnd"
  | "modelOverrideObjectBrace"
  | "modelOverrideCompatBrace"
  | "modelOverrideCompatEnd"
>;

function composeProviderAffinityInsertion(
  original: string,
  providerLabel: string,
): { modifiedText: string; placementLabel: string } | undefined {
  const location = locateProviderCompatInJsonc(original, providerLabel);
  if (!location) return undefined;
  const node: CompatInsertionLocation = {
    modelObjectBrace: -1,
    compatObjectBrace: -1,
    compatObjectEnd: -1,
    providerObjectBrace: location.providerObjectBrace,
    providerCompatBrace: location.providerCompatBrace,
    providerCompatEnd: location.providerCompatEnd,
    modelOverrideObjectBrace: -1,
    modelOverrideCompatBrace: -1,
    modelOverrideCompatEnd: -1,
  };
  return {
    modifiedText: composeFixInsertion(original, node, { sendSessionAffinityHeaders: true }, "provider"),
    placementLabel: `providers["${providerLabel}"] -> compat (provider level)`,
  };
}

function composeFixInsertion(
  original: string,
  location: CompatInsertionLocation,
  compatKeys: Record<string, unknown>,
  placement: "provider" | "model" | "modelOverride" = "model",
): string {
  // Resolve the target compat object and its container based on placement.
  const targetCompatBrace = placement === "provider"
    ? location.providerCompatBrace
    : placement === "modelOverride"
      ? location.modelOverrideCompatBrace
      : location.compatObjectBrace;
  const targetCompatEnd = placement === "provider"
    ? location.providerCompatEnd
    : placement === "modelOverride"
      ? location.modelOverrideCompatEnd
      : location.compatObjectEnd;
  const containerBrace = placement === "provider"
    ? location.providerObjectBrace
    : placement === "modelOverride"
      ? location.modelOverrideObjectBrace
      : location.modelObjectBrace;

  // Helper: format key/value pairs as lines with the given indent,
  // alphabetically sorted for stable previews and deterministic edits.
  const sortedEntries = Object.entries(compatKeys).sort(([a], [b]) => a.localeCompare(b));
  const formatEntries = (indent: string, entries: Array<[string, unknown]>): string =>
    entries
      .map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n');

  // Helper: line-start indentation of the line containing `offset` in `original`.
  const lineIndentAt = (offset: number): string => {
    let ls = original.lastIndexOf('\n', offset);
    if (ls < 0) ls = -1;
    const line = original.slice(ls + 1, offset);
    const m = line.match(/^(\s*)/);
    return m ? m[1] : '';
  };

  if (targetCompatBrace >= 0 && targetCompatEnd > targetCompatBrace) {
    // ── Existing compat object: insert absent keys and surgically replace
    // direct existing keys whose value is wrong (e.g. thinkingFormat: "legacy").
    // Unrelated interior bytes/comments/key order are preserved.
    const interiorStart = targetCompatBrace + 1;
    const interior = original.slice(interiorStart, targetCompatEnd);
    const hasContent = interior.trim().length > 0;
    const clean = stripJsoncComments(original);

    // Indent for inserted key lines: copy the first existing key line's indent,
    // else derive one level deeper than the compat brace's own line.
    const braceLineIndent = lineIndentAt(targetCompatBrace);
    const innerMatch = interior.match(/\r?\n([ \t]+)\S/);
    const innerIndent = innerMatch ? innerMatch[1] : braceLineIndent + '  ';

    const edits: Array<{ start: number; end: number; text: string }> = [];
    const missingEntries: Array<[string, unknown]> = [];

    for (const [key, value] of sortedEntries) {
      const existing = findJsonObjectKey(clean, targetCompatBrace, key);
      if (existing && existing.keyStart < targetCompatEnd) {
        const valueStart = skipJsonWhitespace(clean, existing.valueStart);
        const valueEnd = skipJsonValue(clean, valueStart);
        if (valueEnd !== undefined && valueEnd <= targetCompatEnd) {
          const nextValue = JSON.stringify(value);
          if (original.slice(valueStart, valueEnd) !== nextValue) {
            edits.push({ start: valueStart, end: valueEnd, text: nextValue });
          }
          continue;
        }
      }
      missingEntries.push([key, value]);
    }

    if (missingEntries.length > 0) {
      const keysFormatted = formatEntries(innerIndent, missingEntries);
      if (hasContent) {
        edits.push({ start: interiorStart, end: interiorStart, text: `\n${keysFormatted},` });
      } else {
        edits.push({ start: interiorStart, end: targetCompatEnd, text: `\n${keysFormatted}\n${braceLineIndent}` });
      }
    }

    // Apply later edits first so earlier offsets remain valid.
    return edits
      .sort((a, b) => b.start - a.start)
      .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), original);
  }

  // ── No compat object yet: create one right after the container `{`. ──
  // Everything after the brace (including the next line's indentation) is
  // preserved byte-for-byte; we only prepend a complete `"compat": {...},` block.
  const afterBrace = containerBrace + 1;
  const suffix = original.slice(afterBrace);

  // Key indent: copy the first sibling key line's indent from the suffix,
  // else one level deeper than the container brace's line.
  const containerLineIndent = lineIndentAt(containerBrace);
  const siblingMatch = suffix.match(/^\r?\n([ \t]+)\S/);
  const keyIndent = siblingMatch ? siblingMatch[1] : containerLineIndent + '  ';

  // One more level for keys inside compat: reuse the file's own indent unit.
  const unit = keyIndent.startsWith(containerLineIndent) && keyIndent.length > containerLineIndent.length
    ? keyIndent.slice(containerLineIndent.length)
    : '  ';
  const innerIndent = keyIndent + unit;

  const compatBlock = `\n${keyIndent}"compat": {\n${formatEntries(innerIndent, sortedEntries)}\n${keyIndent}},`;
  return original.slice(0, afterBrace) + compatBlock + suffix;
}

/**
 * Self-check after compose: parse original and modified as JSONC,
 * assert target compat flags exist in the right path, and remaining structure
 * is deep-equal (ignoring the inserted keys).
 * Returns null on success, error message on failure.
 */
function selfCheckFix(
  original: string,
  modified: string,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
  placement: "provider" | "model" | "modelOverride" = "model",
  runtimeModel?: PiModel,
): string | null {
  try {
    // Step 1: Parse both versions as JSONC (comments + trailing commas allowed).
    const origParsed = parseJsonc(original);
    const modParsed = parseJsonc(modified);

    // Step 2: Validate modified file has correct structure
    const providers = asRecord(asRecord(modParsed)?.providers);
    if (!providers) {
      return "Modified file: providers object missing or invalid";
    }
    const provider = asRecord(providers[providerLabel]);
    if (!provider) {
      return `Modified file: provider "${providerLabel}" not found`;
    }

    // Step 3: Validate models array structure
    const models = provider.models;
    if (!Array.isArray(models)) {
      return `Modified file: provider "${providerLabel}".models is not an array`;
    }
    if (models.length === 0) {
      return `Modified file: provider "${providerLabel}".models is empty`;
    }

    // Step 4: Find and validate target model
    const targetModel = models.find((m: Record<string, unknown>) => m.id === modelId);
    if (!targetModel || typeof targetModel !== 'object') {
      return `Modified file: model "${modelId}" not found in provider`;
    }

    // Locate the corresponding original provider/model objects. The structure
    // preservation check below may allow repaired compat values to differ, but
    // only on these exact target/provider compat objects — never on siblings.
    const origProviders = asRecord(asRecord(origParsed)?.providers);
    const origProvider = asRecord(origProviders?.[providerLabel]);
    const origModels = Array.isArray(origProvider?.models) ? origProvider.models : undefined;
    const origTargetModel = origModels?.find((m: unknown) => asRecord(m)?.id === modelId);
    const origTargetModelRecord = asRecord(origTargetModel);
    if (!origProvider || !origTargetModelRecord) {
      return `Original file: provider/model "${providerLabel}/${modelId}" not found`;
    }

    // Step 5: Compute the EFFECTIVE merged compat using Pi's precedence:
    // provider, custom model, runtime model, then modelOverrides. The fix may
    // have written any persistent level, so validation must check what Pi will
    // actually use.
    const provCompatRaw = (provider as Record<string, unknown>).compat;
    const provCompat = (provCompatRaw && typeof provCompatRaw === 'object' && !Array.isArray(provCompatRaw))
      ? provCompatRaw as Record<string, unknown>
      : {};
    const modelCompatRaw = (targetModel as Record<string, unknown>).compat;
    if (modelCompatRaw !== undefined && (typeof modelCompatRaw !== 'object' || modelCompatRaw === null || Array.isArray(modelCompatRaw))) {
      return `Modified file: model "${modelId}" compat is not an object`;
    }
    const mdlCompat = (modelCompatRaw ?? {}) as Record<string, unknown>;
    const override = asRecord(asRecord(provider.modelOverrides)?.[modelId]);
    const overrideCompatRaw = override?.compat;
    if (overrideCompatRaw !== undefined && !asRecord(overrideCompatRaw)) {
      return `Modified file: modelOverrides["${modelId}"].compat is not an object`;
    }
    const overrideCompat = asRecord(overrideCompatRaw) ?? {};
    const mergedCompat: Record<string, unknown> = runtimeModel
      ? resolveEffectiveCompatFromConfig(runtimeModel, modParsed) as Record<string, unknown>
      : { ...provCompat, ...mdlCompat, ...overrideCompat };

    // Step 6: Validate all inserted keys are effective in the merged compat
    for (const [k, v] of Object.entries(compatKeys)) {
      if (!(k in mergedCompat)) {
        return `Modified file: compat.${k} not found at provider or model level (insertion failed)`;
      }
      if (mergedCompat[k] !== v) {
        return `Modified file: effective compat.${k} has wrong value: expected ${JSON.stringify(v)}, got ${JSON.stringify(mergedCompat[k])}`;
      }
    }

    // Step 7: Validate that the parsed document is unchanged except for the
    // explicitly requested scalar keys in the compat object we edited. A
    // one-way subset check is not sufficient here: it would accept accidental
    // additions such as credentials or unrelated provider fields.
    const editedCompatContainer = (value: Record<string, unknown>): boolean =>
      (placement === "provider" && value === origProvider) ||
      (placement === "model" && value === origTargetModelRecord) ||
      (placement === "modelOverride" && value === asRecord(asRecord(origProvider.modelOverrides)?.[modelId]));

    function sameCompatObject(
      originalCompatValue: unknown,
      modifiedCompatValue: unknown,
    ): boolean {
      const originalCompat = originalCompatValue === undefined
        ? {}
        : asRecord(originalCompatValue);
      const modifiedCompat = asRecord(modifiedCompatValue);
      if (!originalCompat || !modifiedCompat) return false;

      const allowedKeys = new Set([...Object.keys(originalCompat), ...Object.keys(compatKeys)]);
      const modifiedKeys = Object.keys(modifiedCompat);
      if (modifiedKeys.length !== allowedKeys.size || modifiedKeys.some((key) => !allowedKeys.has(key))) {
        return false;
      }

      for (const key of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(compatKeys, key)) {
          if (!Object.prototype.hasOwnProperty.call(modifiedCompat, key) || modifiedCompat[key] !== compatKeys[key]) {
            return false;
          }
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(originalCompat, key) ||
            !sameDocumentValue(originalCompat[key], modifiedCompat[key])) {
          return false;
        }
      }
      return true;
    }

    function sameDocumentValue(originalValue: unknown, modifiedValue: unknown): boolean {
      if (originalValue === modifiedValue) return true;
      if (typeof originalValue !== typeof modifiedValue || originalValue === null || modifiedValue === null) return false;
      if (Array.isArray(originalValue) || Array.isArray(modifiedValue)) {
        if (!Array.isArray(originalValue) || !Array.isArray(modifiedValue) || originalValue.length !== modifiedValue.length) return false;
        return originalValue.every((value, index) => sameDocumentValue(value, modifiedValue[index]));
      }
      if (typeof originalValue !== "object") return false;

      const originalObject = originalValue as Record<string, unknown>;
      const modifiedObject = modifiedValue as Record<string, unknown>;
      const originalKeys = Object.keys(originalObject);
      const modifiedKeys = Object.keys(modifiedObject);
      if (originalKeys.length !== modifiedKeys.length || modifiedKeys.some((key) => !Object.prototype.hasOwnProperty.call(originalObject, key))) {
        return false;
      }
      return originalKeys.every((key) => sameDocumentValue(originalObject[key], modifiedObject[key]));
    }

    function sameDocumentExceptEditedCompat(originalValue: unknown, modifiedValue: unknown): boolean {
      if (originalValue === modifiedValue) return true;
      if (typeof originalValue !== typeof modifiedValue || originalValue === null || modifiedValue === null) return false;
      if (Array.isArray(originalValue) || Array.isArray(modifiedValue)) {
        if (!Array.isArray(originalValue) || !Array.isArray(modifiedValue) || originalValue.length !== modifiedValue.length) return false;
        return originalValue.every((value, index) => sameDocumentExceptEditedCompat(value, modifiedValue[index]));
      }
      if (typeof originalValue !== "object") return false;

      const originalObject = originalValue as Record<string, unknown>;
      const modifiedObject = modifiedValue as Record<string, unknown>;
      if (editedCompatContainer(originalObject)) {
        const originalKeys = Object.keys(originalObject).filter((key) => key !== "compat");
        const modifiedKeys = Object.keys(modifiedObject).filter((key) => key !== "compat");
        if (originalKeys.length !== modifiedKeys.length || modifiedKeys.some((key) => !Object.prototype.hasOwnProperty.call(originalObject, key))) {
          return false;
        }
        for (const key of originalKeys) {
          if (!sameDocumentExceptEditedCompat(originalObject[key], modifiedObject[key])) return false;
        }
        return sameCompatObject(originalObject.compat, modifiedObject.compat);
      }

      const originalKeys = Object.keys(originalObject);
      const modifiedKeys = Object.keys(modifiedObject);
      if (originalKeys.length !== modifiedKeys.length || modifiedKeys.some((key) => !Object.prototype.hasOwnProperty.call(originalObject, key))) {
        return false;
      }
      return originalKeys.every((key) => sameDocumentExceptEditedCompat(originalObject[key], modifiedObject[key]));
    }

    if (!sameDocumentExceptEditedCompat(origParsed, modParsed)) {
      return "Modified file: original structure was altered (data loss detected)";
    }

    // Note: we intentionally do NOT enforce `modified.length >= original.length`.
    // The surgical editor may replace an existing compat value with a shorter one
    // (e.g. `false` -> `true`), which legitimately shrinks the file by a byte.
    // Real data loss / truncation is already caught by Step 7's isSubset
    // (every original key still present) and Step 8's root-bracket integrity
    // check below — a surviving length heuristic would false-positive on every
    // such value repair. (Tracked: the mofas glm-5.2 self-check failure path.)

    // Step 8: Validate root bracket integrity with the same string/comment-aware
    // scanner used for edits. Do not count raw braces: comments or strings may
    // legitimately contain unmatched `{` / `}` bytes.
    const modifiedClean = stripJsoncComments(modified);
    const rootStart = skipJsonWhitespace(modifiedClean, 0);
    const rootEnd = findMatchingBracket(modifiedClean, rootStart);
    if (rootEnd === undefined) {
      return "Modified file: root bracket mismatch";
    }
    if (skipJsonWhitespace(modifiedClean, rootEnd + 1) !== modifiedClean.length) {
      return "Modified file: trailing non-whitespace content after root object";
    }

    return null;
  } catch (e) {
    return `Self-check error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Serialize a compat suggestion to the JSON text that will be inserted.
 * Returns the exact key-value pairs as a formatted JSON string without outer braces.
 */
function formatCompatKeysForInsertion(compatKeys: Record<string, unknown>): string {
  return Object.entries(compatKeys)
    .map(([k, v]) => {
      return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
    })
    .join(',\n');
}

/**
 * Generate a unique UTC timestamp component for backup filenames.
 * Milliseconds, process id, and an in-process sequence prevent collisions.
 */
let backupSequence = 0;

function backupTimestamp(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  const ms = String(now.getUTCMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}T${h}${min}${s}${ms}Z-${process.pid}-${backupSequence++}`;
}

function uniqueTempPath(targetPath: string, purpose: string): string {
  return `${targetPath}.${process.pid}.${Date.now()}.${backupSequence++}.${purpose}.tmp`;
}

type FileIdentity = { dev: number | bigint; ino: number | bigint };

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  // Some platforms do not expose a meaningful inode. On those platforms the
  // hash checks around the transaction remain authoritative.
  const leftDev = Number(left.dev);
  const rightDev = Number(right.dev);
  const leftIno = Number(left.ino);
  const rightIno = Number(right.ino);
  return leftIno === 0 || rightIno === 0 || (leftDev === rightDev && leftIno === rightIno);
}

type AtomicTargetGuard = {
  identity?: FileIdentity;
  hash?: string;
  mode?: number;
};

async function validateAtomicTarget(
  targetPath: string,
  guard?: AtomicTargetGuard,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const info = await lstat(targetPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("target is not a regular file; refusing atomic replacement");
  }
  if (guard?.identity && !sameFileIdentity(guard.identity, info)) {
    throw new Error("target changed during atomic replacement");
  }
  if (guard?.mode !== undefined && (info.mode & 0o7777) !== guard.mode) {
    throw new Error("target access mode changed during atomic replacement");
  }
  if (guard?.hash !== undefined) {
    const text = await readFile(targetPath, "utf8");
    if (hashText(text) !== guard.hash) {
      throw new Error("target content changed during atomic replacement");
    }
  }
  return info;
}

async function atomicReplaceTextFilePreservingMode(
  targetPath: string,
  content: string,
  mode: number,
  purpose: string,
  guard?: AtomicTargetGuard,
  /** Test-only race injector; production callers leave this undefined. */
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const initialTargetInfo = await validateAtomicTarget(targetPath, guard);
  const tempPath = uniqueTempPath(targetPath, purpose);
  try {
    // `wx` makes the unique temporary path non-overwriting even if a hostile
    // or stale file appears between name generation and the write.
    await writeFile(tempPath, content, { encoding: "utf8", mode, flag: "wx" });
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) {
      throw new Error("temporary replacement is not a regular file");
    }
    await chmod(tempPath, mode);
    await validateAtomicTarget(targetPath, {
      ...guard,
      identity: initialTargetInfo,
      mode,
    });
    if (beforeRename) await beforeRename();
    await validateAtomicTarget(targetPath, {
      ...guard,
      identity: initialTargetInfo,
      mode,
    });
    await rename(tempPath, targetPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (getErrorCode(cleanupError) !== "ENOENT") {
        console.warn(`${LOG_PREFIX}: failed to remove temporary models.json file`, cleanupError);
      }
    }
    throw error;
  }
}

async function atomicCreateTextFileNoReplace(
  targetPath: string,
  content: string,
  mode: number,
  purpose: string,
  /** Test-only race injector; production callers leave this undefined. */
  beforeLink?: () => Promise<void>,
): Promise<void> {
  const tempPath = uniqueTempPath(targetPath, purpose);
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode, flag: "wx" });
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) {
      throw new Error("temporary creation is not a regular file");
    }
    await chmod(tempPath, mode);
    // A hard link gives us an atomic no-replace create. Unlike rename(), it
    // cannot overwrite a file that appeared after the absence check.
    if (beforeLink) await beforeLink();
    await link(tempPath, targetPath);
    await unlink(tempPath).catch((cleanupError) => {
      console.warn(`${LOG_PREFIX}: committed config file but failed to remove its temporary hard link`, cleanupError);
    });
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (getErrorCode(cleanupError) !== "ENOENT") {
        console.warn(`${LOG_PREFIX}: failed to remove temporary config file`, cleanupError);
      }
    }
    throw error;
  }
}

async function atomicRestoreFileFromBackup(
  backupPath: string,
  targetPath: string,
  mode: number,
  guard?: AtomicTargetGuard & { backupHash?: string },
  /** Test-only race injector; production callers leave this undefined. */
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const backupInfo = await lstat(backupPath);
  if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
    throw new Error("backup is not a regular file; refusing atomic restore");
  }
  if (guard?.backupHash !== undefined) {
    const backupText = await readFile(backupPath, "utf8");
    if (hashText(backupText) !== guard.backupHash) {
      throw new Error("backup content changed during atomic restore");
    }
  }
  const targetInfo = await validateAtomicTarget(targetPath, guard);
  const tempPath = uniqueTempPath(targetPath, "restore");
  try {
    await copyFile(backupPath, tempPath, fsConstants.COPYFILE_EXCL);
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) {
      throw new Error("temporary restore is not a regular file");
    }
    await chmod(tempPath, mode);
    const tempText = await readFile(tempPath, "utf8");
    if (guard?.backupHash !== undefined && hashText(tempText) !== guard.backupHash) {
      throw new Error("backup content changed during atomic restore");
    }
    await validateAtomicTarget(targetPath, {
      ...guard,
      identity: targetInfo,
    });
    if (beforeRename) await beforeRename();
    await validateAtomicTarget(targetPath, {
      ...guard,
      identity: targetInfo,
    });
    await rename(tempPath, targetPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (getErrorCode(cleanupError) !== "ENOENT") {
        console.warn(`${LOG_PREFIX}: failed to remove temporary restore file`, cleanupError);
      }
    }
    throw error;
  }
}

type ModelsJsonFixTransactionResult =
  | { ok: true }
  | { ok: false; postCheckError: string };

type ModelsJsonFixReceiptSnapshot = {
  receipt: ModelsJsonFixReceiptV1;
  receiptPath: string;
  hash: string;
  identity: FileIdentity;
};

type ModelsJsonFixTransactionOptions = {
  onCommitted?: (writtenText: string) => Promise<void>;
  expectedCurrentHash?: string;
  /** Access mode captured by a preview, used to reject mode races. */
  expectedCurrentMode?: number;
  /** Hash of the transaction backup, used to revalidate a guarded restore. */
  expectedBackupHash?: string;
  /** Receipt identity captured before a rollback preview. */
  receiptGuard?: ModelsJsonFixReceiptSnapshot;
  purpose?: string;
};

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function withModelsJsonTransactionLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(STATE_DIR, { recursive: true });
  const deadline = Date.now() + MODELS_TRANSACTION_LOCK_WAIT_MS;
  const ownerToken = randomUUID();
  const ownerText = JSON.stringify({ pid: process.pid, token: ownerToken });
  let ownedLockIdentity: FileIdentity | undefined;
  while (true) {
    try {
      // A single O_EXCL file is the lease: unlike mkdir-then-owner-file, there
      // is no ownerless crash window between creating the lock and identifying
      // its owner.
      await writeFile(MODELS_TRANSACTION_LOCK_PATH, ownerText, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const lockInfo = await lstat(MODELS_TRANSACTION_LOCK_PATH);
      if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
        throw new Error("models.json transaction lock path is unsafe");
      }
      ownedLockIdentity = lockInfo;
      break;
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") throw error;
      const lockInfo = await lstat(MODELS_TRANSACTION_LOCK_PATH).catch(() => undefined);
      if (!lockInfo) continue;
      if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
        throw new Error("models.json transaction lock path is unsafe");
      }
      let staleOwnerPid: number | undefined;
      try {
        const owner = asRecord(JSON.parse(await readFile(MODELS_TRANSACTION_LOCK_PATH, "utf8")));
        if (typeof owner?.pid === "number") staleOwnerPid = owner.pid;
      } catch {}
      const stale = Date.now() - lockInfo.mtimeMs > MODELS_TRANSACTION_LOCK_STALE_MS;
      if (stale && (staleOwnerPid === undefined || !isProcessAlive(staleOwnerPid))) {
        // Recheck identity immediately before unlinking so a recovered owner
        // cannot delete a replacement lease created at the same path.
        const currentLock = await lstat(MODELS_TRANSACTION_LOCK_PATH).catch(() => undefined);
        if (currentLock && sameFileIdentity(lockInfo, currentLock)) {
          await unlink(MODELS_TRANSACTION_LOCK_PATH).catch((unlinkError) => {
            if (getErrorCode(unlinkError) !== "ENOENT") throw unlinkError;
          });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("another cache-optimizer models.json transaction is still running");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await operation();
  } finally {
    // Only the matching inode and owner token may remove the lease. A
    // recovered/replaced lock belongs to another transaction.
    try {
      const currentLock = await lstat(MODELS_TRANSACTION_LOCK_PATH);
      if (
        ownedLockIdentity &&
        !currentLock.isSymbolicLink() &&
        currentLock.isFile() &&
        sameFileIdentity(ownedLockIdentity, currentLock) &&
        await readFile(MODELS_TRANSACTION_LOCK_PATH, "utf8") === ownerText
      ) {
        await unlink(MODELS_TRANSACTION_LOCK_PATH);
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(`${LOG_PREFIX}: failed to remove models.json transaction lock`, error);
      }
    }
  }
}

async function assertModelsJsonFixReceiptSnapshotUnchanged(
  snapshot: ModelsJsonFixReceiptSnapshot,
): Promise<void> {
  const info = await lstat(snapshot.receiptPath);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    !sameFileIdentity(snapshot.identity, info)
  ) {
    throw new Error("fix receipt changed since the rollback preview");
  }
  const text = await readFile(snapshot.receiptPath, "utf8");
  const afterRead = await lstat(snapshot.receiptPath);
  if (
    afterRead.isSymbolicLink() ||
    !afterRead.isFile() ||
    !sameFileIdentity(info, afterRead) ||
    hashText(text) !== snapshot.hash
  ) {
    throw new Error("fix receipt changed since the rollback preview");
  }
}

async function applyModelsJsonFixTransactionUnderLock(
  modifiedText: string,
  backupPath: string,
  validateWrittenText: (writtenText: string) => string | null,
  options: ModelsJsonFixTransactionOptions = {},
): Promise<ModelsJsonFixTransactionResult> {
  if (options.receiptGuard) {
    await assertModelsJsonFixReceiptSnapshotUnchanged(options.receiptGuard);
  }
  const targetInfo = await lstat(MODELS_JSON_PATH);
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
    throw new Error("models.json is not a regular file; no changes were made");
  }
  const originalMode = targetInfo.mode & 0o7777;
  const transactionName = options.purpose === "rollback" ? "rollback" : "fix";
  if (options.expectedCurrentMode !== undefined && options.expectedCurrentMode !== originalMode) {
    throw new Error(`models.json access mode changed since the ${transactionName} preview; no changes were made`);
  }
  const initialTargetText = await readFile(MODELS_JSON_PATH, "utf8");
  const transactionInitialHash = hashText(initialTargetText);
  const expectedCurrentHash = options.expectedCurrentHash ?? transactionInitialHash;
  const expectedBackupHash = options.expectedBackupHash ?? expectedCurrentHash;
  const assertCurrentTargetUnchanged = async (): Promise<void> => {
    const currentInfo = await lstat(MODELS_JSON_PATH);
    if (
      currentInfo.isSymbolicLink() ||
      !currentInfo.isFile() ||
      !sameFileIdentity(targetInfo, currentInfo) ||
      (currentInfo.mode & 0o7777) !== originalMode
    ) {
      throw new Error(`models.json changed during ${transactionName}; no changes were made`);
    }
    const currentText = await readFile(MODELS_JSON_PATH, "utf8");
    if (hashText(currentText) !== expectedCurrentHash) {
      throw new Error(`models.json changed since the ${transactionName} preview; no changes were made`);
    }
  };
  const assertBackupUnchanged = async (): Promise<void> => {
    const backupInfo = await lstat(backupPath);
    if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
      throw new Error(`models.json ${transactionName} backup is not a regular file; no changes were made`);
    }
    if (expectedBackupHash !== undefined) {
      const backupText = await readFile(backupPath, "utf8");
      if (hashText(backupText) !== expectedBackupHash) {
        throw new Error(`models.json ${transactionName} backup changed during preparation; no changes were made`);
      }
    }
  };

  await assertCurrentTargetUnchanged();
  await copyFile(MODELS_JSON_PATH, backupPath, fsConstants.COPYFILE_EXCL);
  const createdBackupInfo = await lstat(backupPath);
  if (createdBackupInfo.isSymbolicLink() || !createdBackupInfo.isFile()) {
    throw new Error(`models.json ${transactionName} backup is not a regular file; no changes were made`);
  }
  await chmod(backupPath, originalMode);
  const chmodBackupInfo = await lstat(backupPath);
  if (
    chmodBackupInfo.isSymbolicLink() ||
    !chmodBackupInfo.isFile() ||
    !sameFileIdentity(createdBackupInfo, chmodBackupInfo)
  ) {
    throw new Error(`models.json ${transactionName} backup changed during preparation; no changes were made`);
  }
  await assertBackupUnchanged();

  const expectedModifiedHash = hashText(modifiedText);
  let targetReplaced = false;
  const restoreTargetIfUnchanged = async (): Promise<void> => {
    const currentInfo = await lstat(MODELS_JSON_PATH);
    if (
      currentInfo.isSymbolicLink() ||
      !currentInfo.isFile() ||
      (currentInfo.mode & 0o7777) !== originalMode
    ) {
      throw new Error(`models.json changed after ${transactionName} replacement; refusing to overwrite user changes`);
    }
    const currentText = await readFile(MODELS_JSON_PATH, "utf8");
    if (hashText(currentText) !== expectedModifiedHash) {
      throw new Error(`models.json changed after ${transactionName} replacement; refusing to overwrite user changes`);
    }
    await assertBackupUnchanged();
    await atomicRestoreFileFromBackup(backupPath, MODELS_JSON_PATH, originalMode, {
      identity: currentInfo,
      hash: expectedModifiedHash,
      mode: originalMode,
      backupHash: expectedBackupHash,
    });
    const restoredInfo = await lstat(MODELS_JSON_PATH);
    if (restoredInfo.isSymbolicLink() || !restoredInfo.isFile()) {
      throw new Error(`models.json restore produced a non-regular file`);
    }
    const restoredText = await readFile(MODELS_JSON_PATH, "utf8");
    if (expectedBackupHash !== undefined && hashText(restoredText) !== expectedBackupHash) {
      throw new Error(`models.json restore did not match the transaction backup`);
    }
  };

  try {
    await assertCurrentTargetUnchanged();
    await atomicReplaceTextFilePreservingMode(
      MODELS_JSON_PATH,
      modifiedText,
      originalMode,
      options.purpose ?? "fix",
      {
        identity: targetInfo,
        hash: expectedCurrentHash,
        mode: originalMode,
      },
    );
    targetReplaced = true;

    const writtenInfo = await lstat(MODELS_JSON_PATH);
    if (writtenInfo.isSymbolicLink() || !writtenInfo.isFile()) {
      throw new Error(`models.json became a non-regular file during ${transactionName} replacement`);
    }
    const writtenText = await readFile(MODELS_JSON_PATH, "utf8");
    const postCheckError = validateWrittenText(writtenText);
    const writtenMode = writtenInfo.mode & 0o7777;
    const writeHashError = hashText(writtenText) === expectedModifiedHash
      ? null
      : `models.json changed during ${transactionName} replacement`;
    const modeError = writtenMode === originalMode
      ? null
      : `models.json access mode changed from ${originalMode.toString(8)} to ${writtenMode.toString(8)}`;
    const effectiveError = postCheckError ?? writeHashError ?? modeError;
    if (effectiveError !== null) {
      await restoreTargetIfUnchanged();
      targetReplaced = false;
      return { ok: false, postCheckError: effectiveError };
    }

    // Re-check immediately before committing receipt metadata. If a caller
    // changed the replacement after validation, do not mark the transaction
    // successful and do not restore over that caller's change.
    await validateAtomicTarget(MODELS_JSON_PATH, {
      identity: writtenInfo,
      hash: expectedModifiedHash,
      mode: originalMode,
    });

    // A receipt is part of a successful fix transaction. If its atomic write
    // fails, the catch path restores the models file from the transaction
    // backup instead of leaving an un-recoverable configuration change.
    if (options.receiptGuard) {
      await assertModelsJsonFixReceiptSnapshotUnchanged(options.receiptGuard);
    }
    await options.onCommitted?.(writtenText);
    return { ok: true };
  } catch (error) {
    if (targetReplaced) {
      try {
        await restoreTargetIfUnchanged();
        targetReplaced = false;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "models.json fix failed and the atomic backup restore also failed",
        );
      }
    }
    throw error;
  }
}

async function applyModelsJsonFixTransaction(
  modifiedText: string,
  backupPath: string,
  validateWrittenText: (writtenText: string) => string | null,
  options: ModelsJsonFixTransactionOptions = {},
): Promise<ModelsJsonFixTransactionResult> {
  return withModelsJsonTransactionLock(() =>
    applyModelsJsonFixTransactionUnderLock(modifiedText, backupPath, validateWrittenText, options)
  );
}

function isReceiptScalar(value: unknown): value is ReceiptScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function isReceiptScalarState(value: unknown): value is ReceiptScalarState {
  const record = asRecord(value);
  if (!record || record.present === undefined) return false;
  if (record.present === false) return Object.keys(record).every((key) => key === "present");
  return record.present === true && isReceiptScalar(record.value) && Object.keys(record).every((key) => key === "present" || key === "value");
}

function sameReceiptScalarState(left: ReceiptScalarState, right: ReceiptScalarState): boolean {
  if (left.present !== right.present) return false;
  return !left.present || left.value === (right as { present: true; value: ReceiptScalar }).value;
}

function isFixReceiptPlacement(value: unknown): value is FixReceiptPlacement {
  return value === "provider" || value === "model" || value === "modelOverride";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function hasReceiptReasoningProtocolChange(receipt: ModelsJsonFixReceiptV1): boolean {
  return [
    "thinkingFormat",
    "supportsReasoningEffort",
    "requiresReasoningContentOnAssistantMessages",
  ].some((key) => Object.prototype.hasOwnProperty.call(receipt.changedKeys, key));
}

function isActionableModelsJsonFixReceipt(receipt: ModelsJsonFixReceiptV1 | undefined): receipt is ModelsJsonFixReceiptV1 {
  return receipt !== undefined && receipt.status === undefined;
}

function createRollbackBackupPath(modelsPath: string = MODELS_JSON_PATH): string {
  return `${modelsPath}.backup-cache-optimizer-rollback-${backupTimestamp()}`;
}

function isSafeReceiptText(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function isReceiptTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseModelsJsonFixReceipt(value: unknown): ModelsJsonFixReceiptV1 | undefined {
  const record = asRecord(value);
  if (!record || record.version !== 1 || record.kind !== "pi-cache-optimizer-fix-receipt") return undefined;
  const allowedKeys = new Set([
    "version", "kind", "transactionId", "provider", "modelId", "placement",
    "targetExistedBefore", "changedKeys", "beforeHash", "afterHash", "backupFile",
    "createdAt", "appliedAt", "status", "rolledBackAt",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return undefined;
  if (!isSafeReceiptText(record.transactionId) || !isSafeReceiptText(record.provider) || !isSafeReceiptText(record.modelId)) return undefined;
  if (!isFixReceiptPlacement(record.placement) || typeof record.targetExistedBefore !== "boolean") return undefined;
  if (!isSha256(record.beforeHash) || !isSha256(record.afterHash) || record.beforeHash === record.afterHash) return undefined;
  if (!isSafeReceiptText(record.backupFile) || basename(record.backupFile) !== record.backupFile || record.backupFile.includes("..")) return undefined;
  if (!/^models\.json\.backup-cache-optimizer-/.test(record.backupFile)) return undefined;
  const beforeHash = typeof record.beforeHash === "string" ? record.beforeHash.toLowerCase() : "";
  const afterHash = typeof record.afterHash === "string" ? record.afterHash.toLowerCase() : "";
  if (beforeHash === afterHash) return undefined;
  if (!isReceiptTimestamp(record.createdAt) || !isReceiptTimestamp(record.appliedAt) || record.appliedAt < record.createdAt) return undefined;
  const changedKeys = asRecord(record.changedKeys);
  if (!changedKeys || Object.keys(changedKeys).length === 0) return undefined;

  const parsedChanges: Record<string, FixReceiptCompatChange> = {};
  for (const [key, rawChange] of Object.entries(changedKeys)) {
    if (!RECEIPT_COMPAT_KEYS.has(key)) return undefined;
    const change = asRecord(rawChange);
    if (!change || !isReceiptScalarState(change.before) || !isReceiptScalarState(change.after)) return undefined;
    if (sameReceiptScalarState(change.before, change.after)) return undefined;
    parsedChanges[key] = {
      before: change.before,
      after: change.after,
    };
  }

  if (record.status !== undefined && record.status !== "rolled_back") return undefined;
  if (record.status === "rolled_back" && (!isReceiptTimestamp(record.rolledBackAt) || record.rolledBackAt < record.appliedAt)) return undefined;
  if (record.status === undefined && record.rolledBackAt !== undefined) return undefined;

  return {
    version: 1,
    kind: "pi-cache-optimizer-fix-receipt",
    transactionId: record.transactionId.trim(),
    provider: record.provider.trim(),
    modelId: record.modelId.trim(),
    placement: record.placement,
    targetExistedBefore: record.targetExistedBefore,
    changedKeys: parsedChanges,
    beforeHash,
    afterHash,
    backupFile: record.backupFile,
    createdAt: Number(record.createdAt),
    appliedAt: Number(record.appliedAt),
    ...(record.status === "rolled_back" ? { status: "rolled_back", rolledBackAt: Number(record.rolledBackAt) } : {}),
  };
}

function receiptBackupPath(receipt: ModelsJsonFixReceiptV1, receiptPath: string = FIX_RECEIPT_PATH): string {
  return join(dirname(receiptPath), receipt.backupFile);
}

async function writeModelsJsonFixReceipt(
  receipt: ModelsJsonFixReceiptV1,
  receiptPath: string = FIX_RECEIPT_PATH,
  expectedSnapshot?: ModelsJsonFixReceiptSnapshot,
  /** Test-only race injector; production callers leave this undefined. */
  beforeRename?: () => Promise<void>,
): Promise<void> {
  if (!parseModelsJsonFixReceipt(receipt)) throw new Error("invalid fix receipt");
  if (expectedSnapshot) {
    if (expectedSnapshot.receiptPath !== receiptPath) throw new Error("fix receipt path changed since the rollback preview");
    await assertModelsJsonFixReceiptSnapshotUnchanged(expectedSnapshot);
  }
  await mkdir(dirname(receiptPath), { recursive: true });
  let existingReceiptInfo: { dev: number; ino: number } | undefined;
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("invalid fix receipt path");
    existingReceiptInfo = info;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  const mode = 0o600;

  const tempPath = uniqueTempPath(receiptPath, "receipt");
  try {
    await writeFile(tempPath, JSON.stringify(receipt, null, 2) + "\n", { encoding: "utf8", mode, flag: "wx" });
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) throw new Error("invalid temporary fix receipt");
    await chmod(tempPath, mode);
    if (expectedSnapshot) {
      await assertModelsJsonFixReceiptSnapshotUnchanged(expectedSnapshot);
    }
    const assertReceiptDestinationUnchanged = async (): Promise<void> => {
      try {
        const currentReceiptInfo = await lstat(receiptPath);
        if (!existingReceiptInfo || !sameFileIdentity(existingReceiptInfo, currentReceiptInfo)) {
          throw new Error("fix receipt changed during atomic write");
        }
      } catch (error) {
        if (getErrorCode(error) === "ENOENT" && !existingReceiptInfo) {
          // The destination was absent both before and immediately before the
          // rename. The atomic rename will create it safely.
        } else {
          throw error;
        }
      }
      if (expectedSnapshot) await assertModelsJsonFixReceiptSnapshotUnchanged(expectedSnapshot);
    };
    await assertReceiptDestinationUnchanged();
    if (beforeRename) await beforeRename();
    await assertReceiptDestinationUnchanged();
    if (existingReceiptInfo) {
      await rename(tempPath, receiptPath);
    } else {
      await link(tempPath, receiptPath);
      await unlink(tempPath).catch((cleanupError) => {
        console.warn(`${LOG_PREFIX}: committed fix receipt but failed to remove its temporary hard link`, cleanupError);
      });
    }
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (getErrorCode(cleanupError) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to remove temporary fix receipt`, cleanupError);
    }
    throw error;
  }
}

async function readModelsJsonFixReceiptSnapshot(
  receiptPath: string = FIX_RECEIPT_PATH,
): Promise<ModelsJsonFixReceiptSnapshot | undefined> {
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    const text = await readFile(receiptPath, "utf8");
    const afterRead = await lstat(receiptPath);
    if (
      afterRead.isSymbolicLink() ||
      !afterRead.isFile() ||
      !sameFileIdentity(info, afterRead)
    ) return undefined;
    const receipt = parseModelsJsonFixReceipt(JSON.parse(text));
    if (!receipt) return undefined;
    return {
      receipt,
      receiptPath,
      hash: hashText(text),
      identity: afterRead,
    };
  } catch {
    return undefined;
  }
}

async function readModelsJsonFixReceipt(
  receiptPath: string = FIX_RECEIPT_PATH,
): Promise<ModelsJsonFixReceiptV1 | undefined> {
  return (await readModelsJsonFixReceiptSnapshot(receiptPath))?.receipt;
}

async function markModelsJsonFixReceiptRolledBack(
  snapshot: ModelsJsonFixReceiptSnapshot,
): Promise<void> {
  const receipt = snapshot.receipt;
  await writeModelsJsonFixReceipt({
    ...receipt,
    status: "rolled_back",
    rolledBackAt: Date.now(),
  }, snapshot.receiptPath, snapshot);
}

type ReceiptCompatTarget = {
  targetExists: boolean;
  compatBrace: number;
  compatEnd: number;
};

function locateReceiptCompatTarget(
  text: string,
  provider: string,
  modelId: string,
  placement: FixReceiptPlacement,
): ReceiptCompatTarget | undefined {
  if (placement === "modelOverride") {
    const location = locateModelOverrideInJsonc(text, provider, modelId);
    if (
      !location ||
      location.providerKeyCount !== 1 ||
      location.modelOverridesKeyCount > 1 ||
      location.modelOverrideKeyCount > 1 ||
      location.modelOverrideCompatKeyCount > 1
    ) return undefined;
    return {
      targetExists: location.modelOverrideObjectBrace >= 0,
      compatBrace: location.modelOverrideCompatBrace,
      compatEnd: location.modelOverrideCompatEnd,
    };
  }

  if (placement === "provider") {
    const location = locateProviderCompatInJsonc(text, provider);
    if (!location) return undefined;
    return {
      targetExists: true,
      compatBrace: location.providerCompatBrace,
      compatEnd: location.providerCompatEnd,
    };
  }
  const location = locateModelInJsonc(text, provider, modelId);
  if (!location || location.providerKeyCount !== 1) return undefined;
  // A changed-file model-scoped rollback cannot tell which duplicate model
  // object was the receipt's target. Refuse that ambiguity instead of touching
  // a later user-added definition. Provider-level receipts returned above do
  // not depend on model-array identity.
  if (location.allModelIds.filter((id) => id === modelId).length !== 1) return undefined;
  if (location.modelCompatKeyCount > 1) return undefined;
  return {
    targetExists: location.modelObjectBrace >= 0,
    compatBrace: location.compatObjectBrace,
    compatEnd: location.compatObjectEnd,
  };
}

function readReceiptCompatScalarState(
  text: string,
  target: ReceiptCompatTarget | undefined,
  key: string,
): ReceiptScalarState | undefined {
  if (!target || target.compatBrace < 0 || target.compatEnd <= target.compatBrace) {
    return { present: false };
  }
  const clean = stripJsoncComments(text);
  const property = findJsonObjectKey(clean, target.compatBrace, key);
  if (!property || property.keyStart >= target.compatEnd) return { present: false };
  if (property.count !== 1) return undefined;
  const valueStart = skipJsonWhitespace(clean, property.valueStart);
  const valueEnd = skipJsonValue(clean, valueStart);
  if (valueEnd === undefined || valueEnd > target.compatEnd) return undefined;
  try {
    const value = parseJsonc(text.slice(valueStart, valueEnd));
    return isReceiptScalar(value) ? { present: true, value } : undefined;
  } catch {
    return undefined;
  }
}

function createModelsJsonFixReceipt(
  originalText: string,
  modifiedText: string,
  provider: string,
  modelId: string,
  placement: FixReceiptPlacement,
  compatKeys: Record<string, unknown>,
  targetExistedBefore: boolean,
  backupPath: string,
  now: number = Date.now(),
): ModelsJsonFixReceiptV1 | undefined {
  const backupFile = basename(backupPath);
  if (!/^models\.json\.backup-cache-optimizer-/.test(backupFile)) return undefined;
  const beforeTarget = locateReceiptCompatTarget(originalText, provider, modelId, placement);
  const afterTarget = locateReceiptCompatTarget(modifiedText, provider, modelId, placement);
  if (targetExistedBefore && !beforeTarget?.targetExists) return undefined;
  if (!afterTarget?.targetExists) return undefined;

  const changedKeys: Record<string, FixReceiptCompatChange> = {};
  for (const [key, afterValue] of Object.entries(compatKeys)) {
    if (!isReceiptScalar(afterValue)) return undefined;
    const before = readReceiptCompatScalarState(originalText, beforeTarget, key);
    const after = readReceiptCompatScalarState(modifiedText, afterTarget, key);
    if (!before || !after || !sameReceiptScalarState(after, { present: true, value: afterValue })) return undefined;
    if (!sameReceiptScalarState(before, after)) changedKeys[key] = { before, after };
  }
  if (Object.keys(changedKeys).length === 0) return undefined;

  const receipt: ModelsJsonFixReceiptV1 = {
    version: 1,
    kind: "pi-cache-optimizer-fix-receipt",
    transactionId: randomUUID(),
    provider,
    modelId,
    placement,
    targetExistedBefore,
    changedKeys,
    beforeHash: hashText(originalText),
    afterHash: hashText(modifiedText),
    backupFile,
    createdAt: now,
    appliedAt: now,
  };
  return parseModelsJsonFixReceipt(receipt);
}

function maskJsonSyntaxPreservingComments(text: string, start: number, end: number): string {
  // Replace only JSON syntax/value bytes. Comments are copied verbatim so a
  // user explanation attached to a receipt-owned key survives a surgical
  // rollback. Newlines are also retained to keep line structure unchanged.
  const output = text.slice(start, end).split("");
  let i = start;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let escaped = false;
  while (i < end) {
    const ch = text[i];
    const next = text[i + 1];
    const offset = i - start;
    if (inLineComment) {
      if (ch === "\n" || ch === "\r") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        i += 2;
        inBlockComment = false;
      } else {
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\n" || ch === "\r") {
        i++;
        continue;
      }
      output[offset] = " ";
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      output[offset] = " ";
    } else if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    } else if (ch !== "\n" && ch !== "\r") {
      output[offset] = " ";
    }
    i++;
  }
  return output.join("");
}

type JsonPropertyEdit = { start: number; end: number; text: string };

function locateJsonPropertyValueSpan(
  text: string,
  objectBrace: number,
  objectEnd: number,
  key: string,
): { keyStart: number; valueStart: number; valueEnd: number; removal: JsonPropertyEdit } | undefined {
  const clean = stripJsoncComments(text);
  const property = findJsonObjectKey(clean, objectBrace, key);
  if (!property || property.keyStart >= objectEnd || property.count !== 1) return undefined;
  const valueStart = skipJsonWhitespace(clean, property.valueStart);
  const valueEnd = skipJsonValue(clean, valueStart);
  if (valueEnd === undefined || valueEnd > objectEnd) return undefined;

  const next = skipJsonWhitespace(clean, valueEnd);
  if (clean[next] === ",") {
    return {
      keyStart: property.keyStart,
      valueStart,
      valueEnd,
      removal: {
        start: property.keyStart,
        end: next + 1,
        text: maskJsonSyntaxPreservingComments(text, property.keyStart, next + 1),
      },
    };
  }

  let previous = property.keyStart - 1;
  while (previous >= objectBrace && isJsonWhitespace(clean[previous])) previous--;
  const removalStart = clean[previous] === "," ? previous : property.keyStart;
  return {
    keyStart: property.keyStart,
    valueStart,
    valueEnd,
    removal: {
      start: removalStart,
      end: valueEnd,
      text: maskJsonSyntaxPreservingComments(text, removalStart, valueEnd),
    },
  };
}

function composeModelsJsonReceiptRollback(
  currentText: string,
  receipt: ModelsJsonFixReceiptV1,
): { modifiedText: string; changed: boolean } | { error: string } {
  if (!receipt.targetExistedBefore) {
    return { error: "the fix created a new target entry and the file changed; refusing to remove user changes automatically" };
  }

  const target = locateReceiptCompatTarget(currentText, receipt.provider, receipt.modelId, receipt.placement);
  if (!target?.targetExists) {
    return { error: "the original target entry is missing or no longer safely locatable" };
  }
  if (target.compatBrace < 0 || target.compatEnd <= target.compatBrace) {
    return { error: "the target compat object is missing or no longer safely locatable" };
  }

  const edits: JsonPropertyEdit[] = [];
  for (const [key, change] of Object.entries(receipt.changedKeys)) {
    const current = readReceiptCompatScalarState(currentText, target, key);
    if (!current || !sameReceiptScalarState(current, change.after)) {
      return { error: `receipt-owned compat.${key} was changed after the fix; refusing to overwrite it` };
    }
    const property = locateJsonPropertyValueSpan(currentText, target.compatBrace, target.compatEnd, key);
    if (!property) return { error: `receipt-owned compat.${key} is no longer safely locatable` };
    if (change.before.present) {
      edits.push({
        start: property.valueStart,
        end: property.valueEnd,
        text: JSON.stringify(change.before.value),
      });
    } else {
      edits.push(property.removal);
    }
  }

  const modifiedText = edits
    .sort((left, right) => right.start - left.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), currentText);
  return { modifiedText, changed: modifiedText !== currentText };
}

function validateModelsJsonRollback(
  writtenText: string,
  receipt: ModelsJsonFixReceiptV1,
  expectedHash?: string,
): string | null {
  if (expectedHash !== undefined && hashText(writtenText) !== expectedHash) {
    return "rollback result hash did not match the expected pre-fix file";
  }
  try {
    parseJsonc(writtenText);
  } catch {
    return "rollback result is not valid JSONC";
  }
  // An exact hash check proves the complete pre-fix document, including a
  // newly created target entry (which intentionally did not exist before).
  if (expectedHash !== undefined) return null;

  const target = locateReceiptCompatTarget(writtenText, receipt.provider, receipt.modelId, receipt.placement);
  if (!target?.targetExists) return "rollback result lost the original target entry";
  for (const [key, change] of Object.entries(receipt.changedKeys)) {
    const state = readReceiptCompatScalarState(writtenText, target, key);
    if (!state || !sameReceiptScalarState(state, change.before)) return `rollback result did not restore compat.${key}`;
  }
  return null;
}

type ModelsJsonRollbackPlan = {
  receiptSnapshot: ModelsJsonFixReceiptSnapshot;
  receipt: ModelsJsonFixReceiptV1;
  currentHash: string;
  modifiedText: string;
  expectedResultHash?: string;
  mode: "exact" | "surgical";
  fileMode: number;
  originalBackupPath: string;
  rollbackBackupPath: string;
};

async function readRegularTextFile(path: string): Promise<{ text: string; mode: number }> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("file is not a regular file");
  }
  const text = await readFile(path, "utf8");
  const afterRead = await lstat(path);
  if (
    afterRead.isSymbolicLink() ||
    !afterRead.isFile() ||
    !sameFileIdentity(info, afterRead)
  ) {
    throw new Error("file changed while it was being read");
  }
  return {
    text,
    mode: afterRead.mode & 0o7777,
  };
}

async function prepareModelsJsonRollback(
  receiptSnapshot: ModelsJsonFixReceiptSnapshot | undefined,
  modelsPath: string = MODELS_JSON_PATH,
): Promise<ModelsJsonRollbackPlan | { error: string }> {
  const receipt = receiptSnapshot?.receipt;
  if (!receiptSnapshot || !isActionableModelsJsonFixReceipt(receipt)) {
    return { error: "No unapplied /cache-optimizer fix receipt was found." };
  }

  let current: { text: string; mode: number };
  try {
    current = await readRegularTextFile(modelsPath);
  } catch {
    return { error: "models.json is missing or is not a regular file; no changes were made." };
  }
  const currentHash = hashText(current.text);
  const originalBackupPath = join(dirname(modelsPath), receipt.backupFile);
  const rollbackBackupPath = createRollbackBackupPath(modelsPath);

  if (currentHash === receipt.afterHash) {
    let backup: { text: string; mode: number };
    try {
      backup = await readRegularTextFile(originalBackupPath);
    } catch {
      return { error: "The receipt backup is missing or is not a regular file; refusing to overwrite models.json." };
    }
    if (hashText(backup.text) !== receipt.beforeHash) {
      return { error: "The receipt backup hash does not match the recorded pre-fix file; refusing to overwrite models.json." };
    }
    try {
      parseJsonc(backup.text);
    } catch {
      return { error: "The receipt backup is not valid JSONC; refusing to overwrite models.json." };
    }
    return {
      receiptSnapshot,
      receipt,
      currentHash,
      modifiedText: backup.text,
      expectedResultHash: receipt.beforeHash,
      mode: "exact",
      fileMode: current.mode,
      originalBackupPath,
      rollbackBackupPath,
    };
  }

  if (!receipt.targetExistedBefore) {
    return {
      error: "models.json changed after the fix, and the fix created the target entry. Refusing to remove or overwrite unrelated user changes; use the recorded backup for manual guidance.",
    };
  }

  // A changed file is eligible only for a scalar, receipt-owned surgical
  // rollback. Validate the current document before showing a confirmation;
  // malformed JSONC must never be replaced by an edit derived from offsets.
  try {
    parseJsonc(current.text);
  } catch {
    return { error: "models.json changed after the fix and is not valid JSONC; refusing to overwrite user changes. Use the recorded backup for manual guidance." };
  }

  const surgical = composeModelsJsonReceiptRollback(current.text, receipt);
  if ("error" in surgical) {
    return {
      error: `models.json changed after the fix. ${surgical.error}. Use the recorded backup for manual guidance.`,
    };
  }
  if (!surgical.changed) {
    return { error: "No receipt-owned change remains to roll back." };
  }

  return {
    receiptSnapshot,
    receipt,
    currentHash,
    modifiedText: surgical.modifiedText,
    mode: "surgical",
    fileMode: current.mode,
    originalBackupPath,
    rollbackBackupPath,
  };
}

// Internal helpers exported only so the task verification script
// (.trellis/tasks/.../verify.ts) can exercise them. They are not part of the
// extension's public API; pi only invokes the default export below.
export const __internals_for_tests = {
  buildStableCandidates,
  optimizeSystemPrompt,
  stripSessionOverviewChurn,
  extractStructuralMarkers,
  formatSkillsForPrompt,
  formatSkillsForPromptCompressed,
  compressSkillsInSystemPrompt,
  MIN_STABLE_CANDIDATE_LENGTH,
  SKILL_COMPRESSION_MIN_COUNT,
  NO_PROMPT_REWRITE_ENV,
  isEnabledEnv,
  featureEnabled,
  writePersistedFeature,
  // OpenAI-family cache-key helpers
  addOpenAIPromptCacheKey,
  clampPromptCacheKey,
  hasEffectivePromptCacheKey,
  omitOpenAIPromptCacheKeys,
  isPromptCacheKeyOmittedForModel,
  isNonEmptyString,
  shouldInjectOpenAIPromptCacheKey,
  shouldInjectOpenAIPromptCacheKeyForModel,
  isOpenAICompatibleApi,
  isAnthropicMessagesApi,
  isOpenAICompatibleProxyApi,
  collectAnthropicCacheControlsInWireOrder,
  downgradeAnthropicLongCacheControls,
  hasAnthropicCacheTtlOrderError,
  normalizeAnthropicCacheControlTtlOrder,
  isPiBuiltInLlamaCppModel,
  isResponsesPromptRewriteBypassApi,
  canRewriteNativeVirtualPrompt,
  VIRTUAL_REWRITE_ENV,
  isMistralConversationsApi,
  isOpenAIFamilyModel,
  isOpenAIFamilyAssistantMessage,
  isOpenAIFamilyToken,
  describeMissingOpenAIFamilyProxyCompat,
  describeMissingOpenAICompatibleProxyCompat,
  describeOptionalOpenAICompatibleProxyCompat,
  describeMissingDeepSeekCompat,
  isDeepSeekWireCompatApplicable,
  isDeepSeekCompatCheckApplicable,
  hasExplicitDeepSeekReasoningProtocol,
  describeMissingCacheCompatForModel,
  buildDeepSeekCompatSuggestion,
  buildDeepSeekCompatWarningText,
  buildSafeOpenAIProxyCompatSuggestion,
  getPromptCacheRetentionUnsupportedHint,
  isOfficialOpenAIBaseUrl,
  isKnownThirdPartyOpenAIEndpoint,
  isCompatCheckApplicable,
  isPromptCacheRetention400Applicable,
  isSessionAffinity403Applicable,
  isOpenAISdkHeader403Applicable,
  hasPromptCacheRetentionUnsupportedSignal,
  hasPromptCacheRetentionUnsupportedErrorMessage,
  hasPromptCacheKeyUnsupportedSignal,
  hasPromptCacheKeyUnsupportedErrorMessage,
  isPromptCacheKeyUnsupportedApplicable,
  hasReasoningProtocolRejectionText,
  hasReasoningProtocolRejectionSignal,
  hasReasoningProtocolRejectionErrorMessage,
  isReasoningProtocolRejectionSignalApplicable,
  isReasoningProtocolRejectionForModel,
  buildReasoningProtocolFixSuggestion,
  // Non-GPT OpenAI-compatible model detection
  isKimiLikeModel,
  isKimiLikeAssistantMessage,
  isQwenLikeModel,
  isQwenLikeAssistantMessage,
  isGLMLikeModel,
  isGLMLikeAssistantMessage,
  isMiniMaxLikeModel,
  isMiniMaxLikeAssistantMessage,
  isMimoLikeModel,
  isMimoLikeAssistantMessage,
  isHunyuanLikeModel,
  isHunyuanLikeAssistantMessage,
  // Additional OpenAI-compatible model detection
  isMistralLikeModel,
  isMistralLikeAssistantMessage,
  isGrokLikeModel,
  isGrokLikeAssistantMessage,
  isLlamaLikeModel,
  isLlamaLikeAssistantMessage,
  isNemotronLikeModel,
  isNemotronLikeAssistantMessage,
  isCohereLikeModel,
  isCohereLikeAssistantMessage,
  isYiLikeModel,
  isYiLikeAssistantMessage,
  // More OpenAI-compatible model detection (batch 2)
  isDoubaoLikeModel,
  isDoubaoLikeAssistantMessage,
  isErnieLikeModel,
  isErnieLikeAssistantMessage,
  isBaichuanLikeModel,
  isBaichuanLikeAssistantMessage,
  isStepFunLikeModel,
  isStepFunLikeAssistantMessage,
  isSparkLikeModel,
  isSparkLikeAssistantMessage,
  isInternLMLikeModel,
  isInternLMLikeAssistantMessage,
  isGemmaLikeModel,
  isGemmaLikeAssistantMessage,
  isPhiLikeModel,
  isPhiLikeAssistantMessage,
  isJambaLikeModel,
  isJambaLikeAssistantMessage,
  isSolarLikeModel,
  isSolarLikeAssistantMessage,
  // New OpenAI-compatible model detection (batch 3, 12 families)
  isPerplexityLikeModel,
  isPerplexityLikeAssistantMessage,
  isNovaLikeModel,
  isNovaLikeAssistantMessage,
  isRekaLikeModel,
  isRekaLikeAssistantMessage,
  isFalconLikeModel,
  isFalconLikeAssistantMessage,
  isDbrxLikeModel,
  isDbrxLikeAssistantMessage,
  isMptLikeModel,
  isMptLikeAssistantMessage,
  isStableLMLikeModel,
  isStableLMLikeAssistantMessage,
  isAquilaLikeModel,
  isAquilaLikeAssistantMessage,
  isExaoneLikeModel,
  isExaoneLikeAssistantMessage,
  isHyperCLOVALikeModel,
  isHyperCLOVALikeAssistantMessage,
  isLuminousLikeModel,
  isLuminousLikeAssistantMessage,
  isHermesLikeModel,
  isHermesLikeAssistantMessage,
  // More OpenAI-compatible model detection (batch 4, 18 families)
  isGraniteLikeModel,
  isGraniteLikeAssistantMessage,
  isArcticLikeModel,
  isArcticLikeAssistantMessage,
  isPanguLikeModel,
  isPanguLikeAssistantMessage,
  isSenseNovaLikeModel,
  isSenseNovaLikeAssistantMessage,
  isZhinaoLikeModel,
  isZhinaoLikeAssistantMessage,
  isMiniCPMLikeModel,
  isMiniCPMLikeAssistantMessage,
  isXVerseLikeModel,
  isXVerseLikeAssistantMessage,
  isOrionLikeModel,
  isOrionLikeAssistantMessage,
  isOpenChatLikeModel,
  isOpenChatLikeAssistantMessage,
  isVicunaLikeModel,
  isVicunaLikeAssistantMessage,
  isWizardLikeModel,
  isWizardLikeAssistantMessage,
  isZephyrLikeModel,
  isZephyrLikeAssistantMessage,
  isDolphinLikeModel,
  isDolphinLikeAssistantMessage,
  isOpenOrcaLikeModel,
  isOpenOrcaLikeAssistantMessage,
  isStarlingLikeModel,
  isStarlingLikeAssistantMessage,
  isBloomLikeModel,
  isBloomLikeAssistantMessage,
  isRwkvLikeModel,
  isRwkvLikeAssistantMessage,
  isAyaLikeModel,
  isAyaLikeAssistantMessage,
  selectAdapterForModel,
  selectAdapterForAssistantMessage,
  buildOpenAIProxyCompatWarningText,
  getModelIdNameTokenValues,
  getAssistantMessageModelTokenValues,
  mergeCacheCompat,
  resolveEffectiveCompatFromConfig,
  getEffectiveCompatValueSource,
  findLastExactModelDefinition,
  isValidModelsConfigForEffectiveCompat,
  addEffectiveSessionAffinityHeaders,
  getCompat,
  isKnownToolOrderApi,
  getToolNameForPayload,
  compareToolOrderEntries,
  isVerifiedToolForApi,
  normalizeToolsInPayload,
  sortToolsInPayload,
  modelKey,
  modelFromAssistantMessage,
  consolidateDirectProviderStatsModel,
  // Platform-friendly path helpers
  getAgentDirDisplayPath,
  getModelsJsonDisplayPath,
  buildProviderCompatOverride,
  buildModelCompatOverride,
  captureCacheRetentionEnv,
  requestLongCacheRetention,
  restoreCacheRetentionEnv,
  setRuntimeOptimizerEnabled,
  isRuntimeOptimizerEnabled,
  getOptimizerRuntimeModeLines,
  formatOptimizerRuntimeMode,
  PI_CACHE_RETENTION_ENV,
  LONG_CACHE_RETENTION_VALUE,
  TOOL_ORDER_ENV,
  isToolOrderEnabled,
  // Integrity diagnostics
  getLastPromptIntegrityWarningAt,
  // Diagnostic command helpers
  buildDoctorDiagnosis,
  buildCompatDiagnosis,
  describeRouterChannelDiagnostics,
  // Cache stats helpers (module-level, usable from verify script)
  addUsageToCacheStats,
  formatCacheStats,
  prefixFooterStatus,
  getCacheOptimizerArgumentCompletions,
  emptyCacheStats,
  emptyAllCacheStats,
  parseCacheStats,
  parsePersistedCacheStats,
  deriveTotalsByModelFromSessionStats,
  parsePersistedTotalsByModel,
  // Recent sample / stats output / diagnosis helpers
  MAX_RECENT_SAMPLES,
  buildStatsOutput,
  buildSessionStatsOutput,
  buildAllStatsOutput,
  buildContributorsStatsOutput,
  formatCompactStats,
  buildLowHitDiagnosis,
  formatRecentTrendSummary,
  formatHitRatio,
  formatTokenM,
  hasMissingUsageFields,
  keyForModelExt,
  // Session-scoped helpers
  hashSessionId,
  makeSessionModelKey,
  modelKeyFromSessionKey,
  filterRestorableStatsForSession,
  parsePersistedRoutedModelRef,
  routedModelRefToPiModel,
  buildExactRouterStatusEntry,
  findBestRouterModelStats,
  selectFooterStatsForModel,
  parseFooterStatsMode,
  parsePersistedCacheOptimizerConfig,
  readPersistedCacheOptimizerConfig,
  writePersistedCacheOptimizerConfig,
  readPersistedFooterMode,
  writePersistedFooterMode,
  setPersistedCacheOptimizerConfig,
  resolveFooterStatsMode,
  footerStatsMode,
  CONFIG_FILE_PATH,
  CONFIG_RECEIPT_PATH,
  parsePromptCacheKeyConfigReceipt,
  isActionablePromptCacheKeyConfigReceipt,
  readPromptCacheKeyConfigReceipt,
  readPromptCacheKeyConfigReceiptSnapshot,
  writePromptCacheKeyConfigReceipt,
  applyPromptCacheKeyConfigFix,
  rollbackPromptCacheKeyConfig,
  configReceiptBackupPath,
  FOOTER_MODE_ENV,
  // Routing-provider protocol helpers
  PI_ROUTING_REGISTRY_SYMBOL,
  PI_CACHE_HINTS_SYMBOL,
  REASONING_PROTOCOL_FALLBACK_SYMBOL,
  ensureRoutingRegistry,
  getRoutingRegistry,
  parseRouteSnapshot,
  resolveActiveRouteSnapshot,
  routeSnapshotToPiModel,
  isRoutedFallbackModel,
  applyConfiguredTransportToModel,
  resolveRouteModel,
  isVirtualRoutingModel,
  PI_VIRTUAL_MODEL_API,
  isNativeVirtualModel,
  findNativeVirtualDispatches,
  resolveNativeVirtualRouteModel,
  resolveNativeVirtualRequestModel,
  getProviderPayloadModelId,
  getCompatCheckNotApplicableLines,
  describeNativeVirtualRouteNote,
  pruneProviderRequestStates,
  MAX_PROVIDER_REQUEST_STATES,
  installCacheHintsService,
  getCacheHintsService,
  markOptimizerOwnedCacheHintsService,
  isOptimizerOwnedCacheHintsService,
  getOrCaptureCacheRetentionBaseline,
  PI_CACHE_RETENTION_BASELINE_SYMBOL,
  // Persistence helpers (for reload/reset tests)
  mergeCacheSessions,
  mergeCacheTotals,
  mergeLastRoutedModels,
  createSerializedAsyncRunner,
  writePersistedCacheStats,
  readPersistedCacheStats,
  parsePersistedStatsShardV7,
  writeStatsShardV7,
  readValidStatsShardsV7,
  aggregateStatsShardsV7,
  loadStatsShardAggregateV7,
  cleanupStatsShardsV7,
  removeLegacyStatsFiles,
  readGlobalStatsEpoch,
  readModelStatsEpoch,
  advanceGlobalStatsEpoch,
  advanceModelStatsEpoch,
  modelEpochPath,
  STATE_FILE_PATH,
  LEGACY_STATE_FILE_PATH,
  SHARD_STATE_DIR,
  FIX_RECEIPT_FILE_NAME,
  FIX_RECEIPT_PATH,
  SHARD_FILES_DIR,
  SHARD_GLOBAL_EPOCH_PATH,
  STATE_DIR,
  // JSONC surgical edit helpers
  MODELS_JSON_PATH,
  stripJsoncComments,
  stripJsoncTrailingCommas,
  parseJsonc,
  resolveExplicitCompatValue,
  hasExplicitLongRetentionOptInFromConfig,
  locateModelInJsonc,
  locateModelOverrideInJsonc,
  locateProviderCompatInJsonc,
  composeFixInsertion,
  selfCheckFix,
  analyzeModelsJsonForMissingEntry,
  composeMissingEntryInsertion,
  composeModelOverrideInsertion,
  composeProviderAffinityInsertion,
  selfCheckMissingEntryInsertion,
  decideFixPlacement,
  chooseFixPlacement,
  findExistingCompatKeysInJsonc,
  deepEqualIgnoringKeys,
  formatCompatKeysForInsertion,
  backupTimestamp,
  atomicReplaceTextFilePreservingMode,
  atomicCreateTextFileNoReplace,
  atomicRestoreFileFromBackup,
  applyModelsJsonFixTransaction,
  hashText,
  parseModelsJsonFixReceipt,
  isActionableModelsJsonFixReceipt,
  hasReceiptReasoningProtocolChange,
  createRollbackBackupPath,
  createModelsJsonFixReceipt,
  writeModelsJsonFixReceipt,
  readModelsJsonFixReceipt,
  readModelsJsonFixReceiptSnapshot,
  markModelsJsonFixReceiptRolledBack,
  receiptBackupPath,
  composeModelsJsonReceiptRollback,
  validateModelsJsonRollback,
  prepareModelsJsonRollback,
  // Fix suggestion builder
  buildFixSuggestion,
  // Adaptive thinking compat helpers
  isAdaptiveGenerationModel,
  isKimiCodingAdaptiveModel,
  isKimiCodingEmptySignatureModel,
  isAdaptiveThinkingCompatApplicable,
  describeMissingAdaptiveThinkingCompat,
  buildAdaptiveThinkingCompatSuggestion,
  buildAdaptiveThinkingCompatWarningText,
  appendAdaptiveThinkingCompatAdviceLines,
};

export default function (pi: ExtensionAPI) {
  const warnedModels = new Set<string>();
  const promptCacheRetention400Models = new Set<string>();
  const warnedPromptCacheRetention400Models = new Set<string>();
  const anthropicTtlFallbackState = getAnthropicTtlFallbackState();
  const anthropicTtlOrderErrorModels = anthropicTtlFallbackState.modelKeys;
  const warnedAnthropicTtlOrderErrorModels = anthropicTtlFallbackState.warnedModelKeys;
  const sendSessionAffinityHeaders403Models = new Set<string>();
  const warnedSendSessionAffinityHeaders403Models = new Set<string>();
  const openAISdkHeader403Models = new Set<string>();
  const warnedOpenAISdkHeader403Models = new Set<string>();
  const reasoningProtocolFallbackState = getReasoningProtocolFallbackState();
  const reasoningProtocolRejectedModels = reasoningProtocolFallbackState.modelKeys;
  const warnedReasoningProtocolRejectedModels = reasoningProtocolFallbackState.warnedModelKeys;
  const promptCacheKeyRejectedModels = new Set<string>();
  const warnedPromptCacheKeyRejectedModels = new Set<string>();
  let cacheStatsByModel: Record<string, CacheStats> = {};
  let cacheStatsProcessByModel: Record<string, CacheStats> = {};
  let cacheStatsTotalsByModel: Record<string, CacheStats> = {};
  let cacheStatsLegacyFamily: Partial<Record<CacheProviderId, CacheStats>> = emptyAllCacheStats();
  let lastStatusText: string | undefined;
  let persistenceWarningShown = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let shardRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let shardWatcher: ReturnType<typeof watch> | undefined;
  const enqueuePersist = createSerializedAsyncRunner();
  const instanceId = randomUUID();
  const instanceStartedAt = Date.now();
  const instanceShardPath = join(SHARD_FILES_DIR, `${instanceId}.json`);
  const modelApiByKey = new Map<string, string>();
  const modelNameByKey = new Map<string, string>();
  const modelEpochByKey = new Map<string, string>();
  let currentGlobalEpoch = initialEpoch("global");
  let integrityNotificationShown = false;
  let currentSessionId = "";
  let currentSessionHash = "";
  let currentSessionHashSet = false;
  let lastActualRoutedModel: PersistedRoutedModelRef | undefined;
  let latestCacheHint: PiCacheHintSnapshot | undefined;
  // Pi's response hooks do not expose a request id. Track one FIFO lifecycle
  // record per request and mark records when their response hook arrives. A
  // finalized assistant message consumes the oldest completed record, falling
  // back to the oldest request only when a transport emitted no response hook.
  // This preserves response A when request B/C starts before message_end(A).
  type ProviderRequestState = {
    model: PiModel;
    responseReceived: boolean;
    correlationAmbiguous: boolean;
    // A native virtual request whose dispatched id matched several providers.
    identityAmbiguous?: boolean;
  };
  const providerRequestStates: ProviderRequestState[] = [];
  let shardCreatedAt = Date.now();
  const PERSIST_DEBOUNCE_MS = 2000;
  const SHARD_REFRESH_DEBOUNCE_MS = 250;

  function buildObservedRuntimeFixSuggestion(model: PiModel): FixSuggestion | undefined {
    const key = modelKey(model);
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;

    if (
      anthropicTtlOrderErrorModels.has(key) ||
      (isPromptCacheRetention400Applicable(model) && promptCacheRetention400Models.has(key))
    ) {
      return {
        providerLabel,
        modelId: model.id,
        compatKeys: { supportsLongCacheRetention: false },
        forceModelLevel: true,
      };
    }
    if (isSessionAffinity403Applicable(model) && sendSessionAffinityHeaders403Models.has(key)) {
      return {
        providerLabel,
        modelId: model.id,
        compatKeys: { sendSessionAffinityHeaders: false },
        forceModelLevel: true,
      };
    }
    return undefined;
  }

  function buildCommandFixSuggestion(model: PiModel): FixSuggestion | undefined {
    const regular = buildFixSuggestion(model);
    const observedReasoning = buildReasoningProtocolFixSuggestion(
      model,
      reasoningProtocolRejectedModels.has(modelKey(model)),
    );
    const observed = mergeFixSuggestions(
      buildObservedRuntimeFixSuggestion(model),
      observedReasoning,
    );
    if (!regular) return observed;
    if (!observed) return regular;
    return {
      providerLabel: regular.providerLabel,
      modelId: regular.modelId,
      compatKeys: { ...regular.compatKeys, ...observed.compatKeys },
      forceModelLevel: regular.forceModelLevel || observed.forceModelLevel,
    };
  }

  function promptCacheKeyFixApplies(model: PiModel): boolean {
    return isPromptCacheKeyUnsupportedApplicable(model) && promptCacheKeyRejectedModels.has(modelKey(model));
  }

  function buildPromptCacheKeyConfigPreview(model: PiModel): string[] {
    const key = modelKey(model);
    return [
      `Target: ${key}`,
      `Action: persist prompt_cache_key mode = omit in ${CONFIG_FILE_PATH}.`,
      "The final request body will omit both prompt_cache_key and promptCacheKey.",
      "This can reduce provider-side prompt-cache reuse for this model; it does not change prompts, credentials, headers, or other models.",
      "The setting applies after Pi core has built the payload, including when Pi already supplied a key.",
    ];
  }
  /** In-memory recent usage samples per model key (not persisted, cleared on reload). */
  const recentSamplesByModelKey = new Map<string, CacheUsageSample[]>();

  function syncSessionHash(ctx: Pick<ExtensionContext, "sessionManager">): void {
    const sid = ctx.sessionManager.getSessionId();
    if (sid && (sid !== currentSessionId || !currentSessionHashSet)) {
      currentSessionId = sid;
      currentSessionHash = hashSessionId(sid);
      currentSessionHashSet = true;
      lastActualRoutedModel = undefined;
    }
  }

  const uninstallCacheHintsService = installCacheHintsService(markOptimizerOwnedCacheHintsService({
    version: 1,
    getHints(input: PiCacheHintsInput): PiCacheHintsOutput | undefined {
      if (!runtimeOptimizerEnabled || isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV])) return undefined;
      const hint = latestCacheHint;
      if (!hint) return undefined;
      if (input.sessionIdHash && hint.sessionIdHash && input.sessionIdHash !== hint.sessionIdHash) return undefined;
      if (input.virtualProvider && hint.virtualProvider && input.virtualProvider !== hint.virtualProvider) return undefined;
      if (input.virtualModelId && hint.virtualModelId && input.virtualModelId !== hint.virtualModelId) return undefined;
      if (input.upstreamProvider && hint.upstreamProvider && input.upstreamProvider !== hint.upstreamProvider) return undefined;
      if (input.upstreamModelId && hint.upstreamModelId && input.upstreamModelId !== hint.upstreamModelId) return undefined;
      if (input.api && hint.api && input.api !== hint.api) return undefined;

      return {
        systemPrompt: hint.systemPrompt,
        promptCacheKey: hint.promptCacheKey,
        cacheRetention: hint.cacheRetention,
      };
    },
  }), { discardPrevious: isOptimizerOwnedCacheHintsService });

  /**
   * Build a session-scoped stats key from the current session hash + model key.
   * Returns `${sessionHash}:${provider}/${id}`.
   */
  function sessionModelKey(model: { provider: string; id: string }): string {
    const hash = currentSessionHash || "_nosession";
    return `${hash}:${model.provider}/${model.id}`;
  }

  /**
   * Extract the user-facing model key from a session-scoped key.
   * "abc123:otokapi/gpt-5.5" → "otokapi/gpt-5.5"
   */
  function modelKeyFromSessionScoped(sKey: string): string {
    const idx = sKey.indexOf(":");
    return idx >= 0 ? sKey.slice(idx + 1) : sKey;
  }

  function recordRecentSample(modelKeyStr: string, usage: UsageSnapshot, missingUsageFields: boolean): void {
    let samples = recentSamplesByModelKey.get(modelKeyStr);
    if (!samples) {
      samples = [];
      recentSamplesByModelKey.set(modelKeyStr, samples);
    }
    samples.push({
      timestamp: Date.now(),
      hit: usage.cacheRead > 0,
      cachedInputTokens: usage.cacheRead,
      cacheWriteInputTokens: usage.cacheWrite,
      totalInputTokens: usage.totalInput,
      missingUsageFields,
    });
    if (samples.length > MAX_RECENT_SAMPLES) {
      samples.splice(0, samples.length - MAX_RECENT_SAMPLES);
    }
  }

  function getRecentSamples(modelKeyStr: string): CacheUsageSample[] {
    return recentSamplesByModelKey.get(modelKeyStr) ?? [];
  }

  function clearRecentSamples(): void {
    recentSamplesByModelKey.clear();
  }

  async function refreshShardAggregate(): Promise<ShardAggregate> {
    const persistedShards = await readValidStatsShardsV7();
    const shards = persistedShards.filter((shard) => shard.instanceId !== instanceId);
    if (currentSessionHashSet) shards.push(buildCurrentStatsShard());
    const aggregate = await aggregateStatsShardsV7(shards);

    // A reset from another process can advance epochs while this instance is
    // idle. Adopt those epochs during every aggregate refresh, not only when a
    // later message_end arrives, so this instance cannot keep an old in-memory
    // process bucket visible in `process` mode or rewrite stale counters during
    // shutdown. Model-scoped resets clear only the affected local bucket.
    const latestGlobalEpoch = await readGlobalStatsEpoch();
    if (currentGlobalEpoch !== latestGlobalEpoch) {
      currentGlobalEpoch = latestGlobalEpoch;
      cacheStatsProcessByModel = {};
      modelEpochByKey.clear();
      modelApiByKey.clear();
      modelNameByKey.clear();
      lastActualRoutedModel = undefined;
    } else {
      for (const key of Object.keys(cacheStatsProcessByModel)) {
        const latestModelEpoch = await readModelStatsEpoch(key);
        if ((modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`)) === latestModelEpoch) continue;
        delete cacheStatsProcessByModel[key];
        modelEpochByKey.set(key, latestModelEpoch);
        modelApiByKey.delete(key);
        modelNameByKey.delete(key);
      }
    }

    cacheStatsByModel = {};
    for (const [sessionHash, models] of Object.entries(aggregate.bySession)) {
      for (const [key, stats] of Object.entries(models)) {
        cacheStatsByModel[`${sessionHash}:${key}`] = stats;
      }
    }
    cacheStatsTotalsByModel = aggregate.totalsByModel;
    if (currentSessionHashSet) {
      lastActualRoutedModel = aggregate.lastRoutedModelBySession[currentSessionHash];
    }
    lastStatusText = undefined;
    return aggregate;
  }

  async function ensureCurrentEpochs(): Promise<void> {
    currentGlobalEpoch = await readGlobalStatsEpoch();
    for (const key of Object.keys(cacheStatsProcessByModel)) {
      modelEpochByKey.set(key, await readModelStatsEpoch(key));
    }
  }

  function buildCurrentStatsShard(state: "active" | "closed" = "active"): PersistedStatsShardV7 {
    const now = Date.now();
    const models: PersistedStatsShardV7["models"] = {};
    for (const [key, stats] of Object.entries(cacheStatsProcessByModel)) {
      const slash = key.indexOf("/");
      if (slash <= 0 || slash >= key.length - 1) continue;
      models[key] = {
        modelEpoch: modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`),
        provider: key.slice(0, slash),
        modelId: key.slice(slash + 1),
        ...(modelNameByKey.get(key) ? { modelName: modelNameByKey.get(key) } : {}),
        ...(modelApiByKey.get(key) ? { api: modelApiByKey.get(key) } : {}),
        stats: cloneCacheStats(stats),
      };
    }
    return {
      version: 7,
      kind: "pi-cache-optimizer-shard",
      instanceId,
      sessionHash: currentSessionHash || "_nosession",
      process: { pid: process.pid, ppid: process.ppid, instanceStartedAt },
      lifecycle: {
        state,
        createdAt: shardCreatedAt,
        updatedAt: now,
        ...(state === "closed" ? { closedAt: now } : {}),
      },
      day: currentLocalDay(),
      globalEpoch: currentGlobalEpoch,
      models,
      ...(lastActualRoutedModel ? { lastRoutedModel: { ...lastActualRoutedModel } } : {}),
    };
  }

  function scheduleShardRefresh(ctx?: ExtensionContext, model?: PiModel): void {
    if (shardRefreshTimer !== null) clearTimeout(shardRefreshTimer);
    shardRefreshTimer = setTimeout(() => {
      shardRefreshTimer = null;
      void refreshShardAggregate()
        .then(() => publishStatus(ctx as ExtensionContext, model ?? ctx?.model))
        .catch(() => undefined);
    }, SHARD_REFRESH_DEBOUNCE_MS);
    shardRefreshTimer.unref?.();
  }

  /** Look up visible cumulative stats for a model, falling back to legacy family. */
  function getStatsForModel(model: PiModel | undefined, adapter: CacheProviderAdapter): CacheStats {
    if (model) {
      const key = modelKey(model);
      const existing = cacheStatsTotalsByModel[key];
      if (existing) return existing;
    }

    // Fallback: legacy family bucket — used when model key is unknown.
    const family = cacheStatsLegacyFamily[adapter.id];
    if (family) return family;

    const created = emptyCacheStats();
    cacheStatsLegacyFamily[adapter.id] = created;
    return created;
  }

  /** Get or create a session-scoped stats entry for the given key. */
  function getOrCreateStatsByModelKey(key: string): CacheStats {
    const existing = cacheStatsByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsByModel[key] = created;
    return created;
  }

  /** Get or create the current-process provider/model stats entry. */
  function getOrCreateProcessStatsForModel(model: PiModel): CacheStats {
    const key = modelKey(model);
    const existing = cacheStatsProcessByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsProcessByModel[key] = created;
    return created;
  }

  /** Get or create the cumulative provider/model stats entry shown in the footer. */
  function getOrCreateTotalStatsForModel(model: PiModel): CacheStats {
    const key = modelKey(model);
    const existing = cacheStatsTotalsByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsTotalsByModel[key] = created;
    return created;
  }

  async function resetStatsForModel(model: PiModel): Promise<void> {
    const displayKey = modelKey(model);
    const nextEpoch = await advanceModelStatsEpoch(displayKey);
    modelEpochByKey.set(displayKey, nextEpoch);
    delete cacheStatsProcessByModel[displayKey];
    delete cacheStatsTotalsByModel[displayKey];
    for (const key of Object.keys(cacheStatsByModel)) {
      if (modelKeyFromSessionScoped(key) === displayKey) delete cacheStatsByModel[key];
    }
    for (const key of Array.from(recentSamplesByModelKey.keys())) {
      if (modelKeyFromSessionScoped(key) === displayKey) recentSamplesByModelKey.delete(key);
    }
    lastStatusText = undefined;
  }

  async function resetCurrentSessionStats(): Promise<void> {
    currentGlobalEpoch = await advanceGlobalStatsEpoch();
    cacheStatsByModel = {};
    cacheStatsTotalsByModel = {};
    cacheStatsProcessByModel = {};
    modelEpochByKey.clear();
    modelApiByKey.clear();
    modelNameByKey.clear();
    clearRecentSamples();
    lastActualRoutedModel = undefined;
    lastStatusText = undefined;
  }

  function persistCacheStats(ctx?: ExtensionContext, lifecycleState: "active" | "closed" = "active"): Promise<void> {
    const shard = buildCurrentStatsShard(lifecycleState);
    return enqueuePersist(async () => {
      try {
        await writeStatsShardV7(instanceShardPath, shard);
      } catch (error) {
        console.warn(`${LOG_PREFIX}: failed to persist cache stats shard`, error);
        if (!persistenceWarningShown) {
          persistenceWarningShown = true;
          ctx?.ui.notify(
            `${LOG_PREFIX}: failed to persist footer stats; using in-memory stats for this process.`,
            "warning",
          );
        }
      }
    });
  }

  function schedulePersistCacheStats(ctx?: ExtensionContext): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistCacheStats(ctx).then(() => refreshShardAggregate()).catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  async function flushPersistCacheStats(ctx?: ExtensionContext, lifecycleState: "active" | "closed" = "active"): Promise<void> {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    // Adopt resets performed by another Pi process before capturing the shard
    // snapshot. Otherwise shutdown/command flush could rewrite stale local
    // counters under an old epoch even though aggregation already hid them.
    await refreshShardAggregate();
    await persistCacheStats(ctx, lifecycleState);
    await refreshShardAggregate();
  }

  async function rollOverStatsIfNeeded(ctx?: ExtensionContext): Promise<void> {
    const day = currentLocalDay();
    let changed = false;
    for (const key of Object.keys(cacheStatsProcessByModel)) {
      if (cacheStatsProcessByModel[key]?.day !== day) {
        cacheStatsProcessByModel[key] = emptyCacheStats(day);
        changed = true;
      }
    }
    for (const id of CACHE_PROVIDER_IDS) {
      const stats = cacheStatsLegacyFamily[id];
      if (stats && stats.day !== day) {
        cacheStatsLegacyFamily[id] = emptyCacheStats(day);
        changed = true;
      }
    }
    if (changed) {
      shardCreatedAt = Date.now();
      lastStatusText = undefined;
      await ensureCurrentEpochs();
      await flushPersistCacheStats(ctx);
    }
  }

  async function restoreCacheStats(reason: string, ctx: ExtensionContext): Promise<void> {
    syncSessionHash(ctx);
    lastStatusText = undefined;
    cacheStatsProcessByModel = {};
    cacheStatsLegacyFamily = emptyAllCacheStats();
    modelEpochByKey.clear();
    modelApiByKey.clear();
    modelNameByKey.clear();
    currentGlobalEpoch = await readGlobalStatsEpoch();
    if (reason === "reload") {
      lastPromptIntegrityWarningAt = 0;
      integrityNotificationShown = false;
      clearRecentSamples();
    }
    await removeLegacyStatsFiles();
    await mkdir(SHARD_FILES_DIR, { recursive: true });
    await refreshShardAggregate();
    await flushPersistCacheStats(ctx);
    await maybeCleanupStatsShardsV7();
    // Maintenance may remove expired shard files after the initial refresh.
    // Re-scan before publishing so startup/footer command state cannot retain
    // counters from files that no longer exist.
    await refreshShardAggregate();
  }

  async function publishStatus(ctx: ExtensionContext, model: PiModel | undefined = ctx.model): Promise<void> {
    syncSessionHash(ctx);
    await rollOverStatsIfNeeded(ctx);

    const routedModel = resolveRouteModel(model, ctx);
    const displayModel = routedModel ?? model;
    const adapter = selectAdapterForModel(displayModel);
    const activeIsVirtualRoute = !!routedModel || isVirtualRoutingModel(model, ctx);
    let statusText: string | undefined;
    const mode = footerStatsMode();
    const sessionHash = currentSessionHashSet ? currentSessionHash : undefined;

    if (!adapter && !routedModel && activeIsVirtualRoute) {
      // On model_select (existing footer), keep the existing cache footer
      // visible instead of clearing it. On session_start (no footer yet
      // after reload/fresh start), restore the exact last actual routed model
      // for this session when available; fall back to older best-effort
      // heuristics only when no exact metadata exists.
      if (lastStatusText !== undefined) return;
      const realEntry = buildExactRouterStatusEntry(
        sessionHash,
        cacheStatsByModel,
        lastActualRoutedModel,
        cacheStatsTotalsByModel,
        mode,
        cacheStatsProcessByModel,
      ) ?? findBestRouterModelStats(
        mode,
        sessionHash,
        cacheStatsByModel,
        cacheStatsTotalsByModel,
        cacheStatsProcessByModel,
      );
      if (realEntry) {
        const statsText = formatCacheStats(realEntry.adapter, realEntry.stats);
        statusText = runtimeOptimizerEnabled
          ? statsText
          : `Cache Optimizer disabled · ${statsText}`;
      }
    }

    if (adapter) {
      // Footer mode defaults to current-session provider/model totals. Users may
      // select all-current-day or current-process counters through persistent
      // command config or the environment variable.
      const stats = displayModel
        ? selectFooterStatsForModel(mode, sessionHash, cacheStatsByModel, cacheStatsTotalsByModel, displayModel, cacheStatsProcessByModel)
        : undefined;
      const statsText = formatCacheStats(adapter, stats ?? emptyCacheStats());
      statusText = runtimeOptimizerEnabled ? statsText : `Cache Optimizer disabled · ${statsText}`;
    }

    // If optimizeSystemPrompt detected structural truncation on this or
    // a recent turn, flag it once in the footer so the user knows to
    // /reload before continuing. The flag resets after emission so a
    // single-turn glitch does not permanently taint the footer.
    if (promptTruncationDetected && statusText !== undefined) {
      statusText = statusText + " ⚠️ integrity";
      promptTruncationDetected = false;
      lastPromptIntegrityWarningAt = Date.now();

      // One-time notification with recovery steps (per session).
      if (!integrityNotificationShown) {
        integrityNotificationShown = true;
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: A prompt structural marker was lost during reorder on this turn. ` +
          `The original prompt was used instead to preserve integrity.\n\n` +
          `Recovery steps:\n` +
          `1. Run /reload to reset (may clear transient issues).\n` +
          `2. Set PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1 and /reload to disable reorder.\n` +
          `3. If persistent, run /cache-optimizer doctor and file an issue (no API keys/prompts).`,
          "warning",
        );
      }
    }

    // ⚠️ compat footer marker: if the active model has adapter-specific
    // missing compat (DeepSeek reasoning/cache compat, or a non-official
    // openai-completions model missing cache/session-affinity flags), append
    // the marker to indicate that compat configuration is incomplete.
    // Re-evaluated on every status update so the marker persists through stats
    // changes and day rollovers. Redundant setStatus calls are blocked by the
    // `lastStatusText` early return above.
    if (runtimeOptimizerEnabled && statusText !== undefined && displayModel) {
      // Only show ⚠️ compat when there are safe-fixable missing compat keys.
      // Optional/advisory-only flags (e.g. supportsLongCacheRetention on generic
      // OpenAI-compatible proxies) do NOT trigger the marker — the doctor/compat
      // commands still mention them as optional guidance.
      if (buildFixSuggestion(displayModel) !== undefined) {
        statusText = statusText + " ⚠️ compat";
      }
    }

    statusText = prefixFooterStatus(statusText);
    if (statusText === lastStatusText) return;

    lastStatusText = statusText;
    ctx.ui.setStatus(STATUS_KEY, statusText);
  }

  ensureRoutingRegistry();

  /**
   * Check whether a model has an EXPLICIT supportsLongCacheRetention: true
   * opt-in in models.json. Precedence mirrors Pi's effective model config:
   * modelOverrides[model.id].compat, then models[].compat, then provider.compat.
   *
   * Returns true ONLY when the user explicitly opted in. Returns false for:
   *   - Explicit false (opt-out)
   *   - In models.json but field absent (Pi defaults to true — unsafe)
   *   - Not in models.json at all (API-logged-in providers)
   *   - File missing/unreadable
   *
   * The caller strips prompt_cache_retention when this returns false.
   */
  function hasExplicitLongRetentionOptIn(model: PiModel): boolean {
    return hasExplicitLongRetentionOptInFromConfig(
      readEffectiveCompatConfig(),
      model.provider,
      model.id,
    );
  }

  /**
   * Request treatment that before_provider_request derives from a model's
   * identity. A native virtual request whose dispatched id matches several
   * credentialed providers is resolved only when this key agrees for all of
   * them, so no provider-specific decision is applied on a guess.
   */
  function requestPolicyKey(model: PiModel): string {
    const key = modelKey(model);
    return JSON.stringify([
      model.api ?? "",
      isOfficialOpenAIBaseUrl(model),
      hasExplicitLongRetentionOptIn(model),
      promptCacheRetention400Models.has(key),
      anthropicTtlOrderErrorModels.has(key),
      isPromptCacheKeyOmittedForModel(model),
    ]);
  }

  pi.on("session_start", async (event, ctx) => {
    if (runtimeOptimizerEnabled) requestLongCacheRetention();
    await restoreCacheStats(event.reason, ctx);
    if (ctx.mode === "tui" && !shardWatcher) {
      try {
        shardWatcher = watch(SHARD_FILES_DIR, () => scheduleShardRefresh(ctx));
        shardWatcher.unref?.();
      } catch {
        // Lifecycle and explicit command refreshes remain authoritative.
      }
    }
    await publishStatus(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Pi 0.99+ codemode scripts run nested tool calls in parallel; the calling
    // tool's own end event follows them, so one refresh covers the batch.
    if (isNonEmptyString((event as { parentToolCallId?: unknown } | undefined)?.parentToolCallId)) return;
    await refreshShardAggregate();
    await publishStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refreshShardAggregate();
    await publishStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await flushPersistCacheStats(ctx, "closed");
    } finally {
      if (shardRefreshTimer !== null) clearTimeout(shardRefreshTimer);
      shardRefreshTimer = null;
      shardWatcher?.close();
      shardWatcher = undefined;
      latestCacheHint = undefined;
      providerRequestStates.length = 0;
      delete getProtocolGlobal().__piCacheOptimizerCacheKey__;
      uninstallCacheHintsService();
      restoreCacheRetentionEnv(STARTUP_CACHE_RETENTION_ENV);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (runtimeOptimizerEnabled) notifyCacheCompatIfNeeded(resolveRouteModel(event.model, ctx) ?? event.model, ctx, warnedModels);
    await refreshShardAggregate();
    await publishStatus(ctx, event.model);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    latestCacheHint = undefined;
    // Clear the legacy global before any bypass/disable early return. A valid
    // rewrite path republishes the current session key below; otherwise callers
    // must not observe a stale key from the previously selected model/route.
    delete getProtocolGlobal().__piCacheOptimizerCacheKey__;
    const routeSnapshot = resolveActiveRouteSnapshot(_ctx.model, _ctx);
    const routedModel = routeSnapshot
      ? findModelInRegistry(_ctx.modelRegistry, routeSnapshot.provider, routeSnapshot.modelId) ?? routeSnapshotToPiModel(routeSnapshot, _ctx.model)
      : undefined;

    // ────────────────────────────────────────────────────────────────
    // OpenAI Responses-family bypass (codex-responses + responses + azure responses)
    //
    // OpenAI's Responses API endpoints — both the Codex backend
    // (openai-codex-responses, chatgpt.com) and the public
    // Responses API (openai-responses, api.openai.com / Copilot) —
    // have two properties that make client-side prompt reordering
    // unnecessary and potentially harmful:
    //
    //  1. Server-managed caching: both APIs send `prompt_cache_key`
    //     (= Pi session id) in every request body, so the server
    //     already maintains a stable cache without prefix ordering.
    //     Client-side reordering adds no cache benefit.
    //
    //  2. Stricter content-safety filtering: the Codex backend in
    //     particular has a product-level safety filter that flags
    //     reordered prompts (tool snippets / guidelines lifted above
    //     the assistant role) as potential prompt-injection, returning
    //     `content_filter` and blocking tool calls (notably
    //     `subagent`). The public Responses API shares the same
    //     filter framework and could behave similarly.
    //
    // We therefore skip ALL prompt modifications (churn strip, skill
    // compression, reorder) for these APIs. Third-party providers
    // that use openai-completions are unaffected.
    // ────────────────────────────────────────────────────────────────
    const model = routedModel ?? _ctx.model;
    if (model && isResponsesPromptRewriteBypassApi(model.api)) {
      return {};
    }
    // Pi 0.99+ native virtual selections pick the physical model per request,
    // after this system prompt is built, so the bypass above cannot be decided
    // here. A route may reach the safety-filtered Codex backend; keep Pi's
    // prompt byte-for-byte instead of reordering it.
    if (isNativeVirtualModel(_ctx.model) && !canRewriteNativeVirtualPrompt(_ctx.model, _ctx)) {
      return {};
    }

    if (!runtimeOptimizerEnabled) return {};

    // Global opt-out: PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1 bypasses all
    // prompt mutations below (session-overview churn strip, skill compression,
    // and stable-prefix reordering). Footer stats and the OpenAI
    // prompt_cache_key fallback remain active.
    if (!featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true)) return {};

    // Step 1: strip per-turn churn from <session-overview>.
    // Removing RECENT COMMITS, Working directory status, and
    // Journal line count makes more of the session-overview stable
    // across turns, which DeepSeek's prefix cache can then retain.
    const strippedPrompt = stripSessionOverviewChurn(event.systemPrompt);

    // Step 2: compress skills XML → one-line index.
    // The compressed form is identical-string-equivalent to the
    // verbose one as far as cache-stability is concerned because both
    // are deterministic from the same `event.systemPromptOptions.skills`.
    // No-op if opted out, below SKILL_COMPRESSION_MIN_COUNT, or if pi
    // emitted a format we don't recognize.
    const compressedPrompt = compressSkillsInSystemPrompt(
      strippedPrompt,
      event.systemPromptOptions,
    );

    // Step 3: lift stable content above dynamic content for cache
    // stability. Operates on the (stripped + compressed) prompt so the
    // cache key derived from `stablePrefix` reflects what actually
    // ships to the provider.
    const optimized = optimizeSystemPrompt(compressedPrompt, event.systemPromptOptions);

    const promptCacheKey = getSessionPromptCacheKey(_ctx);
    const cacheRetention = process.env[PI_CACHE_RETENTION_ENV] === LONG_CACHE_RETENTION_VALUE ? LONG_CACHE_RETENTION_VALUE : undefined;
    const publishHint = (systemPrompt: string): void => {
      latestCacheHint = {
        sessionIdHash: currentSessionHashSet ? currentSessionHash : sessionHashFromContext(_ctx),
        virtualProvider: routeSnapshot?.virtualProvider ?? _ctx.model?.provider,
        virtualModelId: routeSnapshot?.virtualModelId ?? _ctx.model?.id,
        upstreamProvider: routeSnapshot?.provider ?? model?.provider,
        upstreamModelId: routeSnapshot?.modelId ?? model?.id,
        api: model?.api,
        systemPrompt,
        promptCacheKey,
        cacheRetention,
        timestamp: Date.now(),
      };
      const globals = getProtocolGlobal();
      if (promptCacheKey) {
        globals.__piCacheOptimizerCacheKey__ = promptCacheKey;
      } else {
        delete globals.__piCacheOptimizerCacheKey__;
      }
    };

    if (optimized.changed && optimized.systemPrompt.trim().length > 0) {
      publishHint(optimized.systemPrompt);
      return { systemPrompt: optimized.systemPrompt };
    }

    // Reorder didn't apply but compression might have. Return the
    // compressed (or stripped) prompt directly so we still benefit from
    // the volume cut even when reorder is a no-op (e.g., short sessions
    // where no stable candidate is long enough).
    if (compressedPrompt !== strippedPrompt && compressedPrompt.trim().length > 0) {
      publishHint(compressedPrompt);
      return { systemPrompt: compressedPrompt };
    }
    if (strippedPrompt !== event.systemPrompt && strippedPrompt.trim().length > 0) {
      publishHint(strippedPrompt);
      return { systemPrompt: strippedPrompt };
    }

    publishHint(event.systemPrompt);
    return {};
  });

  pi.on("before_provider_headers", (event, ctx) => {
    // Pi transforms headers before the payload exists and passes no model, so a
    // native virtual request's physical model is unknown here. Fail closed; Pi
    // core still sends the physical model's own configured affinity headers.
    if (isNativeVirtualModel(ctx.model)) return;
    const requestModel = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
    addEffectiveSessionAffinityHeaders(
      event.headers,
      requestModel,
      ctx.sessionManager.getSessionId(),
    );
  });

  pi.on("before_provider_request", (event, ctx) => {
    // A native virtual selection keeps ctx.model virtual; resolve the physical
    // model from the dispatched payload. Unresolved requests keep the virtual
    // model, which fails every identity-dependent mutation closed.
    const nativeVirtualRequest = resolveNativeVirtualRequestModel(ctx.model, event.payload, ctx, requestPolicyKey);
    const requestModel = isNativeVirtualModel(ctx.model)
      ? (nativeVirtualRequest?.model ?? ctx.model)
      : (resolveRouteModel(ctx.model, ctx) ?? ctx.model);
    // Request-local identity is also needed by the always-on Anthropic TTL
    // validity repair, so retain the credential-blind snapshot even while the
    // optional runtime optimizer features are disabled.
    const snapshot = snapshotProviderRequestModel(requestModel);
    if (snapshot) {
      providerRequestStates.push({
        model: snapshot,
        responseReceived: false,
        correlationAmbiguous: false,
        identityAmbiguous: isNativeVirtualModel(ctx.model) && (!nativeVirtualRequest || nativeVirtualRequest.identityAmbiguous),
      });
      pruneProviderRequestStates(providerRequestStates);
    }
    let requestPayload: unknown = event.payload;
    let toolOrderChanged = false;

    if (isToolOrderEnabled() && isToolOrderingEligibleModel(requestModel)) {
      const normalized = normalizeToolsInPayload(requestPayload, requestModel.api);
      requestPayload = normalized.payload;
      toolOrderChanged = normalized.changed;
    }

    // Anthropic rejects mixed cache breakpoints when a 1h block appears after
    // a 5m/default block in wire order (tools → system → messages). Repair any
    // conflict visible in Pi's final payload immediately. Some proxies inject
    // hidden short breakpoints after this hook; only models that have actually
    // returned the explicit TTL-order error receive the process-local 5m fallback.
    if (requestModel && isAnthropicMessagesApi(requestModel.api)) {
      const visibleConflictFixed = normalizeAnthropicCacheControlTtlOrder(requestPayload);
      if (!visibleConflictFixed && anthropicTtlOrderErrorModels.has(modelKey(requestModel))) {
        downgradeAnthropicLongCacheControls(requestPayload);
      }
    }

    // ── Safety: strip prompt_cache_retention from payload for models that
    // are not authorised to send it. Pi defaults supportsLongCacheRetention
    // to true for all openai-completions models, but most third-party APIs
    // reject the parameter with 400 “Extra inputs are not permitted”.
    //
    // Gate order (first match wins):
    //   1. Official OpenAI          → keep (trusted to support it)
    //   2. 400 history              → strip (empirical evidence overrides user config)
    //   3. Explicit opt-in in models.json → keep (user explicitly wants it)
    //   4. Everything else          → strip (safe default for third-party APIs)
    //
    // Gate 2 before Gate 3 is critical: if a user explicitly opted in but
    // the API returned 400, we must strip — otherwise the 400 repeats forever.
    if (runtimeOptimizerEnabled) {
      const payloadRecord = asRecord(requestPayload);
      if (payloadRecord && typeof payloadRecord.prompt_cache_retention === "string") {
        if (requestModel) {
          if (isOfficialOpenAIBaseUrl(requestModel)) {
            // Gate 1: Official OpenAI → keep
          } else if (promptCacheRetention400Models.has(modelKey(requestModel))) {
            // Gate 2: 400 history → strip (overrides user opt-in)
            delete payloadRecord.prompt_cache_retention;
          } else if (hasExplicitLongRetentionOptIn(requestModel)) {
            // Gate 3: Explicit user opt-in → keep
          } else {
            // Gate 4: Safe default → strip
            delete payloadRecord.prompt_cache_retention;
          }
        }
      }
    }

    if (isPromptCacheKeyOmittedForModel(requestModel)) {
      const omitted = omitOpenAIPromptCacheKeys(requestPayload);
      return omitted ?? (toolOrderChanged ? requestPayload : undefined);
    }

    if (!shouldInjectOpenAIPromptCacheKey() || !shouldInjectOpenAIPromptCacheKeyForModel(requestModel)) {
      return toolOrderChanged ? requestPayload : undefined;
    }

    const withCacheKey = addOpenAIPromptCacheKey(requestPayload, getSessionPromptCacheKey(ctx));
    return withCacheKey ?? (toolOrderChanged ? requestPayload : undefined);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const pendingStates = providerRequestStates.filter((state) => !state.responseReceived);
    let responseState: ProviderRequestState | undefined;
    if (pendingStates.length === 1) {
      responseState = pendingStates[0];
    } else if (pendingStates.length > 1) {
      const pendingModelKeys = new Set(pendingStates.map((state) => modelKey(state.model)));
      if (pendingModelKeys.size === 1) {
        // Identity is still exact when concurrent requests use the same model.
        responseState = pendingStates[0];
      } else {
        // Pi supplies no request id here, so out-of-order concurrent responses
        // cannot be assigned safely. Preserve the lifecycle records for a
        // message-local identity, but never turn ambiguous headers into a
        // model-scoped persistent-fix suggestion.
        for (const state of pendingStates) state.correlationAmbiguous = true;
      }
    }
    if (responseState) responseState.responseReceived = true;
    // A native virtual request whose physical provider could not be pinned
    // records no model-scoped header evidence; finalized assistant messages
    // still carry exact provider/model identity.
    const model = responseState
      ? (responseState.identityAmbiguous ? undefined : responseState.model)
      : (pendingStates.length === 0 && !isNativeVirtualModel(ctx.model) ? (resolveRouteModel(ctx.model, ctx) ?? ctx.model) : undefined);
    if (!runtimeOptimizerEnabled || !model) return;

    // Keep only the category, never the provider's complete error text. This
    // is evidence for a later, model-scoped `/fix`; it never edits config from
    // a response hook.
    if (
      isReasoningProtocolRejectionSignalApplicable(model) &&
      event.status === 400 &&
      hasReasoningProtocolRejectionSignal(event.headers)
    ) {
      await notifyReasoningProtocolObservation(
        model,
        ctx,
        reasoningProtocolRejectedModels,
        warnedReasoningProtocolRejectedModels,
      );
    }

    // ── 400: prompt_cache_key unsupported ──
    if (event.status === 400 && isPromptCacheKeyUnsupportedApplicable(model) && hasPromptCacheKeyUnsupportedSignal(event.headers)) {
      const key = modelKey(model);
      promptCacheKeyRejectedModels.add(key);
      if (!warnedPromptCacheKeyRejectedModels.has(key)) {
        warnedPromptCacheKeyRejectedModels.add(key);
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: ${key} rejected prompt_cache_key. Run /cache-optimizer fix to review a precise model-scoped repair. No configuration was changed automatically.`,
          "warning",
        );
      }
    }

    // ── 400: prompt_cache_retention unsupported ──
    if (
      event.status === 400 &&
      isPromptCacheRetention400Applicable(model) &&
      hasPromptCacheRetentionUnsupportedSignal(event.headers)
    ) {
      const key = modelKey(model);
      promptCacheRetention400Models.add(key);
      if (!warnedPromptCacheRetention400Models.has(key)) {
        warnedPromptCacheRetention400Models.add(key);
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: ${key} returned HTTP 400 while supportsLongCacheRetention is enabled. ` +
          getPromptCacheRetentionUnsupportedHint() +
          ` Run /cache-optimizer doctor for the exact edit location.`,
          "warning",
        );
      }
    }

    // ── 403: proxy/CDN/WAF blocking ──
    if (event.status === 403) {
      const key403 = modelKey(model);

      // Case 1: Pi's custom session-affinity headers are enabled. Offer the
      // existing safe compat fix (`sendSessionAffinityHeaders: false`).
      if (isSessionAffinity403Applicable(model)) {
        sendSessionAffinityHeaders403Models.add(key403);
        if (warnedSendSessionAffinityHeaders403Models.has(key403)) return;
        warnedSendSessionAffinityHeaders403Models.add(key403);
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: ${key403} returned HTTP 403 while sendSessionAffinityHeaders is enabled. ` +
          `The proxy/CDN may be blocking Pi's custom session-affinity headers (session_id, x-client-request-id, x-session-affinity). ` +
          `Run /cache-optimizer doctor for details and /cache-optimizer fix to set sendSessionAffinityHeaders: false.`,
          "warning",
        );
        return;
      }

      // Case 2: session-affinity headers are already absent/disabled, but the
      // provider still returns 403. Some CDNs/WAFs block the OpenAI JS SDK
      // default request fingerprint (User-Agent: OpenAI/JS ... or
      // X-Stainless-* headers). This is provider-specific; do NOT auto-fix by
      // writing a User-Agent because the right value depends on the endpoint.
      if (isOpenAISdkHeader403Applicable(model)) {
        openAISdkHeader403Models.add(key403);
        if (warnedOpenAISdkHeader403Models.has(key403)) return;
        warnedOpenAISdkHeader403Models.add(key403);
        ctx.ui.notify(
          `⚠️ ${LOG_PREFIX}: ${key403} returned HTTP 403 even though sendSessionAffinityHeaders is not enabled. ` +
          `The proxy/CDN may be blocking the OpenAI JS SDK User-Agent / X-Stainless-* headers. ` +
          `Run /cache-optimizer doctor for manual diagnostic guidance; /cache-optimizer fix will not auto-write User-Agent headers.`,
          "warning",
        );
        return;
      }
    }
  });

  pi.on("message_end", async (event, ctx) => {
    syncSessionHash(ctx);
    const msgRecord = asRecord(event.message);
    const requestCorrelationForMessage = msgRecord?.role === "assistant"
      ? (() => {
        const explicitModel = modelFromAssistantMessage(event.message, undefined);
        const explicitIndex = explicitModel
          ? providerRequestStates.findIndex((state) => modelKey(state.model) === modelKey(explicitModel))
          : -1;
        const completedIndex = providerRequestStates.findIndex((state) => state.responseReceived);
        const contextModel = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
        const contextIndex = contextModel && !providerRequestStates.some((state) => state.correlationAmbiguous)
          ? providerRequestStates.findIndex((state) => modelKey(state.model) === modelKey(contextModel))
          : -1;
        const index = explicitIndex >= 0
          ? explicitIndex
          : (completedIndex >= 0 ? completedIndex : (contextIndex >= 0 ? contextIndex : 0));
        const state = providerRequestStates.splice(index, 1)[0];
        if (!state) return { model: undefined, ambiguous: false };
        const ambiguous = (state.correlationAmbiguous || state.identityAmbiguous === true) && explicitIndex < 0;
        return {
          model: ambiguous ? undefined : state.model,
          ambiguous,
        };
      })()
      : { model: undefined, ambiguous: false };
    const requestModelForMessage = requestCorrelationForMessage.model;
    const contextualFallbackForMessage = requestCorrelationForMessage.ambiguous
      ? undefined
      : (resolveRouteModel(ctx.model, ctx) ?? ctx.model);

    // Some providers expose an HTTP 400 error body only through the finalized
    // assistant error message; after_provider_response may contain the status
    // and no diagnostic response headers. Record only the model-scoped
    // reasoning-protocol category from that authoritative message identity.
    if (runtimeOptimizerEnabled && hasReasoningProtocolRejectionErrorMessage(event.message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const messageModel = modelFromAssistantMessage(event.message, fallbackModel) ?? fallbackModel;
      const errorModel = messageModel
        ? findModelInRegistry(ctx.modelRegistry, messageModel.provider, messageModel.id) ?? messageModel
        : undefined;
      if (isReasoningProtocolRejectionForModel(event.message, errorModel)) {
        await notifyReasoningProtocolObservation(
          errorModel,
          ctx,
          reasoningProtocolRejectedModels,
          warnedReasoningProtocolRejectedModels,
        );
      }
    }
    if (runtimeOptimizerEnabled && hasPromptCacheKeyUnsupportedErrorMessage(event.message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const messageModel = modelFromAssistantMessage(event.message, fallbackModel) ?? fallbackModel;
      const errorModel = messageModel
        ? findModelInRegistry(ctx.modelRegistry, messageModel.provider, messageModel.id) ?? messageModel
        : undefined;
      if (errorModel && isPromptCacheKeyUnsupportedApplicable(errorModel)) {
        const key = modelKey(errorModel);
        promptCacheKeyRejectedModels.add(key);
        if (!warnedPromptCacheKeyRejectedModels.has(key)) {
          warnedPromptCacheKeyRejectedModels.add(key);
          ctx.ui.notify(
            `⚠️ ${LOG_PREFIX}: ${key} rejected prompt_cache_key. Run /cache-optimizer fix to review a precise model-scoped repair. No configuration was changed automatically.`,
            "warning",
          );
        }
      }
    }
    if (runtimeOptimizerEnabled && hasPromptCacheRetentionUnsupportedErrorMessage(event.message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const messageModel = modelFromAssistantMessage(event.message, fallbackModel) ?? fallbackModel;
      const errorModel = messageModel
        ? findModelInRegistry(ctx.modelRegistry, messageModel.provider, messageModel.id) ?? messageModel
        : undefined;
      if (errorModel && isExplicitPromptCacheRetentionUnsupportedApplicable(errorModel)) {
        const key = modelKey(errorModel);
        promptCacheRetention400Models.add(key);
        if (!warnedPromptCacheRetention400Models.has(key)) {
          warnedPromptCacheRetention400Models.add(key);
          ctx.ui.notify(
            `⚠️ ${LOG_PREFIX}: ${key} rejected prompt_cache_retention. ` +
            getPromptCacheRetentionUnsupportedHint() +
            ` Run /cache-optimizer doctor for the exact edit location.`,
            "warning",
          );
        }
      }
    }

    // Record only Anthropic's explicit mixed-TTL ordering error. This is a
    // non-retryable 400 in Pi 0.82.1, so the fallback applies to the next
    // subsequent request (and to a retry only if another layer initiates one).
    if (hasAnthropicCacheTtlOrderError(event.message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const errorModel = modelFromAssistantMessage(event.message, fallbackModel) ?? fallbackModel;
      if (errorModel && isAnthropicMessagesApi(errorModel.api)) {
        const key = modelKey(errorModel);
        anthropicTtlOrderErrorModels.add(key);
        if (!warnedAnthropicTtlOrderErrorModels.has(key)) {
          warnedAnthropicTtlOrderErrorModels.add(key);
          ctx.ui.notify(
            `⚠️ ${LOG_PREFIX}: ${key} returned an Anthropic cache-control TTL ordering error. ` +
            `The next request will fall back to the default 5-minute cache TTL. ` +
            `Run /cache-optimizer fix to set model-level supportsLongCacheRetention: false persistently.`,
            "warning",
          );
        }
      }
    }

    // A native virtual selection keeps ctx.model virtual, while the finalized
    // message names the physical catalog model Pi dispatched. Resolve that
    // model from the registry so adapter tokens, the stats key, and the footer
    // compat marker use the same physical identity as the pre-request UX.
    const nativeVirtualDispatch = isNativeVirtualModel(ctx.model)
      ? nativeVirtualDispatchFromMessage(event.message)
      : undefined;
    const nativeVirtualMessageModel = nativeVirtualDispatch
      ? nativeVirtualDispatchToModel(nativeVirtualDispatch, ctx)
      : undefined;

    const adapter = selectAdapterForAssistantMessage(event.message, nativeVirtualMessageModel ?? ctx.model);
    if (!adapter) return;

    // Skip stats for error/aborted messages (network retries, user aborts).
    // Pi's auto-retry emits message_end for the failed attempt before
    // removing it and retrying. The error message carries zero-usage fields
    // ({ input: 0, cacheRead: 0, cacheWrite: 0 }) that normalizeUsage
    // returns as a valid (non-undefined) snapshot, which would inflate
    // totalRequests and skew cache hit-rate accuracy. The final successful
    // response is emitted as a separate message_end with real usage data.
    if (msgRecord?.stopReason === "error" || msgRecord?.stopReason === "aborted") {
      return;
    }

    const usage = adapter.normalizeUsage(event.message);

    // Completed message metadata is request-local and authoritative for virtual
    // routing providers. Use it whenever it supplies provider/model identity;
    // fall back to the active context model for direct providers.
    let statsModel = modelFromAssistantMessage(event.message, ctx.model) ?? ctx.model;
    // For direct (non-virtual-routing) providers, the upstream API may echo a
    // normalized/renamed model id in its response (e.g. request
    // `zai-org/GLM-5.2-FP8` but the message carries `GLM5.2-FP8`). Writing
    // stats under the echoed name fragments the bucket away from the
    // active-model key the footer reads, showing 0% even when the backend is
    // hitting cache. When the response model drifts from the active model only
    // in name (same provider, same cache adapter), consolidate stats back to
    // the active model id. Virtual routing providers keep message-local
    // identity (router correctness).
    statsModel = consolidateDirectProviderStatsModel(statsModel, ctx.model, ctx);
    if (nativeVirtualMessageModel) statsModel = nativeVirtualMessageModel;
    let routedModelChanged = false;
    if (isVirtualRoutingModel(ctx.model, ctx) && statsModel && !isVirtualRoutingModel(statsModel, ctx)) {
      const nextRoutedModel: PersistedRoutedModelRef = {
        provider: statsModel.provider,
        id: statsModel.id,
        name: statsModel.name || statsModel.id,
      };
      if (
        !lastActualRoutedModel ||
        lastActualRoutedModel.provider !== nextRoutedModel.provider ||
        lastActualRoutedModel.id !== nextRoutedModel.id ||
        (lastActualRoutedModel.name || lastActualRoutedModel.id) !== (nextRoutedModel.name || nextRoutedModel.id)
      ) {
        lastActualRoutedModel = nextRoutedModel;
        routedModelChanged = true;
      }
    }

    // Record recent sample (even when usage is missing, for trend diagnosis)
    if (statsModel) {
      const sk = sessionModelKey(statsModel);
      const missingFields = usage === undefined || (usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.totalInput === 0)
        ? true
        : hasMissingUsageFields(event.message, adapter);
      recordRecentSample(sk, usage ?? { cacheRead: 0, cacheWrite: 0, totalInput: 0 }, missingFields);
    }

    if (!usage) {
      if (routedModelChanged) schedulePersistCacheStats(ctx);
      return;
    }

    await rollOverStatsIfNeeded(ctx);

    // Update session, process-local, and cumulative buckets for the actual
    // routed model. The process bucket is intentionally never persisted.
    if (statsModel) {
      const key = modelKey(statsModel);
      const latestGlobalEpoch = await readGlobalStatsEpoch();
      const latestModelEpoch = await readModelStatsEpoch(key);
      if (currentGlobalEpoch !== latestGlobalEpoch) {
        currentGlobalEpoch = latestGlobalEpoch;
        cacheStatsProcessByModel = {};
        modelEpochByKey.clear();
      }
      if (modelEpochByKey.get(key) !== latestModelEpoch) {
        delete cacheStatsProcessByModel[key];
        modelEpochByKey.set(key, latestModelEpoch);
      }
      modelApiByKey.set(key, statsModel.api ?? "");
      modelNameByKey.set(key, statsModel.name || statsModel.id);
      const sk = sessionModelKey(statsModel);
      addUsageToCacheStats(getOrCreateStatsByModelKey(sk), usage);
      addUsageToCacheStats(getOrCreateProcessStatsForModel(statsModel), usage);
      addUsageToCacheStats(getOrCreateTotalStatsForModel(statsModel), usage);
    } else {
      addUsageToCacheStats(getStatsForModel(undefined, adapter), usage);
    }

    schedulePersistCacheStats(ctx);
    await refreshShardAggregate();
    await publishStatus(ctx, statsModel);
  });

  // ────────────────────────────────────────────────────────────────
  // Register /cache-optimizer command
  // Subcommands:
  //   enable  — enable runtime prompt/cache optimizations for this process
  //   disable — disable runtime prompt/cache optimizations for this process
  //   doctor  — show current model/provider/api/baseUrl/compat status
  //             with low-hit diagnosis
  //   stats   — show detailed current-session models; `stats all` shows all local shards
  //   compat  — show compat suggestion with file path
  //   config footer-mode total|session|process — persist footer mode override
  //   fix     — auto-fix compat issues (writes models.json or extension config, requires UI)
  //   rollback — undo the latest confirmed fix for the active model
  //   reset   — reset current provider/model footer stats bucket (local only)
  //   (no args) — interactive menu (with UI) or help summary
  // ────────────────────────────────────────────────────────────────
  async function handleCacheOptimizerCommand(
    args: string,
    cmdCtx: ExtensionCommandContext,
  ): Promise<void> {
    syncSessionHash(cmdCtx);
    const selectedModel = cmdCtx.model;
    const model = resolveRouteModel(selectedModel, cmdCtx) ?? selectedModel;
    const commandParts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const subcommand = commandParts[0] || "help";

      if (subcommand === "enable") {
        setRuntimeOptimizerEnabled(true);
        await resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx);
        await publishStatus(cmdCtx, model);
        cmdCtx.ui.notify(`✅ Pi Cache Optimizer enabled for this Pi process. Local footer stats were reset for before/after comparison.\n${formatOptimizerRuntimeMode()}`, "info");
      } else if (subcommand === "disable") {
        setRuntimeOptimizerEnabled(false);
        providerRequestStates.length = 0;
        await resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx);
        await publishStatus(cmdCtx, model);
        cmdCtx.ui.notify(`⏸️ Pi Cache Optimizer disabled for this Pi process. Local footer stats were reset and will keep collecting while disabled for comparison.\n${formatOptimizerRuntimeMode()}`, "warning");
      } else if (subcommand === "doctor") {
        await refreshShardAggregate();
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const diagnosis = buildDoctorDiagnosis(model, { promptCacheRetention400: promptCacheRetention400Models.has(modelKey(model)), promptCacheKey400: promptCacheKeyRejectedModels.has(modelKey(model)), anthropicTtlOrderError: anthropicTtlOrderErrorModels.has(modelKey(model)), sessionAffinity403: sendSessionAffinityHeaders403Models.has(modelKey(model)), openAISdkHeader403: openAISdkHeader403Models.has(modelKey(model)) });
        const adapter = selectAdapterForModel(model);
        const sk = model ? sessionModelKey(model) : undefined;
        const statsState = model ? cacheStatsTotalsByModel[modelKey(model)] : undefined;
        const samples = sk ? getRecentSamples(sk) : [];
        const lowHitLines = buildLowHitDiagnosis(model, adapter, statsState, samples);
        const routeNote = describeNativeVirtualRouteNote(selectedModel, model);
        const fullDiagnosis = [routeNote, diagnosis, ...lowHitLines].filter((line) => line !== undefined).join("\n");
        cmdCtx.ui.notify(fullDiagnosis, "info");
      } else if (subcommand === "stats") {
        const aggregate = await refreshShardAggregate();
        const statsMode = commandParts[1];
        if (statsMode === "all") {
          cmdCtx.ui.notify(buildAllStatsOutput(aggregate), "info");
        } else if (statsMode === "contributors") {
          cmdCtx.ui.notify(buildContributorsStatsOutput(aggregate, model, currentSessionHashSet ? currentSessionHash : undefined), "info");
        } else if (statsMode) {
          cmdCtx.ui.notify("Usage: /cache-optimizer stats [all|contributors]", "info");
        } else {
          const sessionModels = currentSessionHashSet ? aggregate.bySession[currentSessionHash] ?? {} : {};
          cmdCtx.ui.notify(buildSessionStatsOutput(sessionModels, model, aggregate.modelRefsByKey), "info");
        }
      } else if (subcommand === "config") {
        const configKey = commandParts[1];
        const requestedMode = commandParts[2];
        const feature = configKey ? FEATURE_COMMAND_MAP[configKey] : undefined;
        if (feature && (requestedMode === "on" || requestedMode === "off")) {
          try {
            await writePersistedFeature(feature, requestedMode === "on");
            lastStatusText = undefined;
            await publishStatus(cmdCtx, model);
            cmdCtx.ui.notify(`✅ ${configKey} set to ${requestedMode}. Persistent config overrides its environment variable.`, "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not update ${configKey}: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        if (configKey === "reset") {
          try {
            await writePersistedCacheOptimizerConfig({ version: 2, footerMode: persistedFooterStatsMode, promptCacheKey: persistedCacheOptimizerConfig.promptCacheKey });
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify("✅ Feature configuration reset. Environment variables now apply again.", "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not reset feature configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        if (!configKey) {
          cmdCtx.ui.notify(formatPersistentFeatureConfig() + `\n• Footer mode: ${resolveFooterStatsMode(persistedFooterStatsMode).mode}` + "\n\n" +
            "Usage: /cache-optimizer config <feature> on|off | footer-mode total|session|process | reset", "info");
          return;
        }
        if (configKey !== "footer-mode" || !requestedMode || !["session", "total", "process"].includes(requestedMode)) {
          const resolved = resolveFooterStatsMode(persistedFooterStatsMode);
          cmdCtx.ui.notify(
            `Usage: /cache-optimizer config footer-mode total|session|process\n` +
            `       /cache-optimizer config prompt-rewrite|virtual-rewrite|skill-compression|openai-cache-key|tool-order on|off\n` +
            `       /cache-optimizer config reset\n` +
            `Current footer mode: ${resolved.mode} (${resolved.source})`,
            "info",
          );
          return;
        }

        const nextMode = requestedMode as FooterStatsMode;
        try {
          await writePersistedFooterMode(nextMode);
          setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
          lastStatusText = undefined;
          await publishStatus(cmdCtx, model);
          const resolved = resolveFooterStatsMode(persistedFooterStatsMode);
          cmdCtx.ui.notify(
            `✅ Footer mode set to ${resolved.mode}. Persistent config overrides ${FOOTER_MODE_ENV}.`,
            "info",
          );
        } catch (error) {
          cmdCtx.ui.notify(
            `❌ Could not update footer mode config: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      } else if (subcommand === "compat") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const compatResult = buildCompatDiagnosis(model);
        const compatRouteNote = describeNativeVirtualRouteNote(selectedModel, model);
        const withRouteNote = (text: string): string => compatRouteNote ? `${compatRouteNote}\n${text}` : text;
        if (compatResult) {
          cmdCtx.ui.notify(withRouteNote(compatResult), "warning");
        } else {
          cmdCtx.ui.notify(
            withRouteNote(isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)
              ? "✅ Compat fully configured."
              : getCompatCheckNotApplicableLines(model).join("\n")),
            "info",
          );
        }
      } else if (subcommand === "rollback") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const configReceiptSnapshot = await readPromptCacheKeyConfigReceiptSnapshot();
        const configReceipt = configReceiptSnapshot?.receipt;
        const modelsReceipt = await readModelsJsonFixReceipt();
        const useConfigReceipt = isActionablePromptCacheKeyConfigReceipt(configReceipt) &&
          configReceipt.provider === model.provider &&
          configReceipt.modelId === model.id &&
          (!isActionableModelsJsonFixReceipt(modelsReceipt) || modelsReceipt.provider !== model.provider ||
            (modelsReceipt.placement !== "provider" && modelsReceipt.modelId !== model.id) || configReceipt.appliedAt >= modelsReceipt.appliedAt);
        if (useConfigReceipt) {
          if (!cmdCtx.hasUI) {
            cmdCtx.ui.notify("❌ Rollback requires interactive confirmation. No changes were made.\nRun /cache-optimizer rollback in Pi's interactive UI to restore the prompt-cache-key setting.", "warning");
            return;
          }
          const confirmed = await cmdCtx.ui.confirm(
            "Cache Optimizer — Rollback prompt_cache_key opt-out",
            `Model: ${modelKey(model)}\nAction: restore the extension config before the confirmed opt-out.\nFooter mode and unrelated configuration will be preserved.\nAfterward, run /reload or restart Pi.\n\nProceed with rollback?`,
          );
          if (!confirmed) {
            cmdCtx.ui.notify("No changes were made. Rollback canceled by user.", "info");
            return;
          }
          try {
            if (!configReceiptSnapshot) throw new Error("prompt-cache-key receipt changed since the rollback preview");
            await rollbackPromptCacheKeyConfig(configReceiptSnapshot);
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify(`✅ Restored prompt_cache_key behavior for ${modelKey(model)}. Run /reload or restart Pi for the change to take effect.`, "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Prompt cache key rollback refused: ${error instanceof Error ? error.message : String(error)}. No changes were made.`, "error");
          }
          return;
        }
        if (!cmdCtx.hasUI) {
          const receipt = await readModelsJsonFixReceipt();
          const backupHint = receipt && isActionableModelsJsonFixReceipt(receipt)
            ? ` The recorded backup is ${receipt.backupFile} next to ${getModelsJsonDisplayPath()}.`
            : " Check the recorded models.json backup manually if a fix receipt exists.";
          cmdCtx.ui.notify(
            "❌ Rollback requires interactive confirmation. No changes were made.\n" +
            `Run /cache-optimizer rollback in Pi's interactive UI.${backupHint} Then run /reload.`,
            "warning",
          );
          return;
        }

        const receiptSnapshot = await readModelsJsonFixReceiptSnapshot();
        const receipt = receiptSnapshot?.receipt;
        if (!receiptSnapshot || !isActionableModelsJsonFixReceipt(receipt)) {
          cmdCtx.ui.notify("ℹ️ No unapplied /cache-optimizer fix receipt was found.", "info");
          return;
        }
        if (receipt.provider !== model.provider || (receipt.placement !== "provider" && receipt.modelId !== model.id)) {
          cmdCtx.ui.notify(
            `ℹ️ The latest fix receipt is for ${receipt.provider}/${receipt.modelId}, not the active model ${model.provider}/${model.id}. ` +
            "Switch to the matching model before running rollback. No changes were made.",
            "warning",
          );
          return;
        }

        const rollback = await prepareModelsJsonRollback(receiptSnapshot);
        if ("error" in rollback) {
          cmdCtx.ui.notify(`ℹ️ ${rollback.error}`, "info");
          return;
        }

        const rollbackScope = rollback.mode === "exact"
          ? "restore the exact pre-fix models.json because the file is unchanged since the fix"
          : "restore only the receipt-owned compat scalar keys and preserve subsequent user changes";
        const rollbackPreview = [
          `Rollback transaction ${rollback.receipt.transactionId}:`,
          `Model: ${rollback.receipt.provider}/${rollback.receipt.modelId}`,
          `Action: ${rollbackScope}.`,
          `A new rollback backup will be written to: ${rollback.rollbackBackupPath}`,
          "Comments, credentials, unrelated fields, and the existing access mode will be preserved.",
          "Afterward, run /reload or restart Pi for the configuration change to take effect.",
          "",
          "Proceed with rollback?",
        ].join("\n");
        const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Rollback", rollbackPreview);
        if (!confirmed) {
          cmdCtx.ui.notify("No changes were made. Rollback canceled by user.", "info");
          return;
        }

        try {
          const result = await applyModelsJsonFixTransaction(
            rollback.modifiedText,
            rollback.rollbackBackupPath,
            (writtenText) => validateModelsJsonRollback(
              writtenText,
              rollback.receipt,
              rollback.expectedResultHash,
            ),
            {
              expectedCurrentHash: rollback.currentHash,
              expectedCurrentMode: rollback.fileMode,
              receiptGuard: rollback.receiptSnapshot,
              purpose: "rollback",
              onCommitted: async () => {
                await markModelsJsonFixReceiptRolledBack(rollback.receiptSnapshot);
              },
            },
          );
          if ("postCheckError" in result) {
            cmdCtx.ui.notify(
              `❌ Rollback self-check failed: ${result.postCheckError}\n` +
              `The rollback backup at ${rollback.rollbackBackupPath} was restored. No changes applied.`,
              "error",
            );
            return;
          }
          invalidateModelsConfigCache();
          cmdCtx.ui.notify(
            `✅ Rollback completed for ${rollback.receipt.provider}/${rollback.receipt.modelId}.\n` +
            `Rollback backup saved to: ${rollback.rollbackBackupPath}\n` +
            "The receipt was marked as rolled back. Run /reload or restart Pi for the change to take effect.",
            "info",
          );
        } catch (rollbackError) {
          cmdCtx.ui.notify(
            `❌ Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\n` +
            "No automatic overwrite was performed; use the recorded backup for manual guidance.",
            "error",
          );
        }
      } else if (subcommand === "reset") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const adapter = selectAdapterForModel(model);
        if (!adapter) {
          cmdCtx.ui.notify("ℹ️ Active model does not match a cache adapter. No stats to reset.", "info");
          return;
        }

        const displayKey = modelKey(model);

        // Reset local footer stats for the effective active model. If the
        // selected model is a virtual router and the protocol exposes a live
        // route, this clears the real upstream bucket, not the router shell.
        await resetStatsForModel(model);

        // Persist immediately.
        await flushPersistCacheStats(cmdCtx);

        // Update footer to show 0/0.
        await publishStatus(cmdCtx, model);

        cmdCtx.ui.notify(
          `✅ Reset local footer cache stats for "${displayKey}". ` +
          "Upstream provider prompt cache was not modified. " +
          "New requests will start a fresh local stats bucket for this provider/model.",
          "info",
        );
      } else if (subcommand === "fix") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }

        const promptCacheKeyRequested = commandParts[1] === "prompt-cache-key";
        const promptCacheKeyFixRequested = promptCacheKeyRequested || promptCacheKeyFixApplies(model);
        if (promptCacheKeyRequested && !isPromptCacheKeyUnsupportedApplicable(model)) {
          cmdCtx.ui.notify("ℹ️ Prompt cache key opt-out applies only to a known OpenAI-compatible provider/model endpoint. No changes were made.", "info");
          return;
        }
        const suggestion = promptCacheKeyFixRequested ? undefined : buildCommandFixSuggestion(model);

        if (promptCacheKeyFixRequested) {
          if (isPromptCacheKeyOmittedForModel(model)) {
            cmdCtx.ui.notify(`✅ prompt_cache_key is already omitted for "${modelKey(model)}".`, "info");
            return;
          }
          if (!cmdCtx.hasUI) {
            cmdCtx.ui.notify(
              "❌ Non-interactive terminal detected. Prompt cache key opt-out requires UI confirmation. No changes were made.\n" +
              `Run /cache-optimizer fix prompt-cache-key in Pi's interactive UI for ${modelKey(model)}.`,
              "warning",
            );
            return;
          }
          const preview = [
            "📝 Preview of extension configuration change:",
            ...buildPromptCacheKeyConfigPreview(model),
            "",
            "⚠️ Risk notice:",
            "  1. This affects all sessions using this exact provider/model.",
            "  2. Provider prompt-cache reuse may decrease because both key spellings are removed.",
            "  3. This does not modify Pi's models.json, credentials, prompts, headers, or other models.",
            "  4. The extension config will be backed up and Pi must be reloaded/restarted.",
            "",
            "Apply this persistent opt-out?",
          ].join("\n");
          const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Omit prompt_cache_key", preview);
          if (!confirmed) {
            cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
            return;
          }
          try {
            const result = await applyPromptCacheKeyConfigFix(model);
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify(
              `✅ Prompt cache key opt-out saved for ${modelKey(model)}.\n` +
              `Config backup saved to: ${result.backupPath}\n` +
              "Run /reload or restart Pi for the change to take effect. Use /cache-optimizer rollback to restore it.",
              "info",
            );
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not save prompt cache key opt-out: ${error instanceof Error ? error.message : String(error)}. No changes were made.`, "error");
          }
          return;
        }

        if (!suggestion) {
          const key = modelKey(model);
          cmdCtx.ui.notify(`✅ Nothing to fix for "${key}". Compat already configured.`, "info");
          return;
        }

        if (!cmdCtx.hasUI) {
          // No UI — refuse to write, show manual guidance instead.
          const compatResult = buildCompatDiagnosis(model);
          const snippet = formatMissingEntryManualSnippet(
            suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
          );
          const manualLines = [
            `❌ Non-interactive terminal detected. Auto-fix requires UI confirmation.`,
            "",
            `Edit ${getModelsJsonDisplayPath()} and run /reload.`,
          ];
          if (promptCacheRetention400Models.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned HTTP 400 for prompt_cache_retention.",
              "Create or edit the entry below to override supportsLongCacheRetention to false.",
            );
          }
          if (anthropicTtlOrderErrorModels.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned an Anthropic cache-control TTL ordering error.",
              "Create or edit the entry below to override supportsLongCacheRetention to false.",
            );
          }
          if (sendSessionAffinityHeaders403Models.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned HTTP 403 while sendSessionAffinityHeaders was enabled.",
              "Create or edit the entry below to override sendSessionAffinityHeaders to false.",
            );
          }
          manualLines.push(
            "",
            "Add these compat keys at Pi's highest-precedence model override path:",
            `providers["${suggestion.providerLabel}"] -> modelOverrides -> "${suggestion.modelId}" -> compat:`,
            formatCompatKeysForInsertion(suggestion.compatKeys),
          );
          if (snippet.length > 0) {
            manualLines.push(
              "",
              "If the provider/model is missing (common for API-logged-in channels such as",
              `opencode go), add a minimal entry under "providers" (keep existing auth as-is):`,
              "",
              snippet,
            );
          }
          if (compatResult) {
            manualLines.push("", compatResult);
          }
          cmdCtx.ui.notify(manualLines.join("\n"), "warning");
          return;
        }

        // Read the models.json file
        let originalText: string;
        try {
          originalText = await readFile(MODELS_JSON_PATH, "utf8");
        } catch {
          cmdCtx.ui.notify(`❌ Could not read ${MODELS_JSON_PATH}. File may not exist.`, "error");
          return;
        }

        // Locate the model entry. API-logged-in providers (e.g. opencode go)
        // may not appear in models.json at all.
        const location = locateModelInJsonc(originalText, suggestion.providerLabel, suggestion.modelId);
        if (!location) {
          const diagnosis = analyzeModelsJsonForMissingEntry(originalText, suggestion.providerLabel, suggestion.modelId);
          const parsedOriginal = (() => { try { return parseJsonc(originalText); } catch { return undefined; } })();
          const provider = asRecord(asRecord(parsedOriginal)?.providers)?.[suggestion.providerLabel];
          const explicit = resolveExplicitCompatValue(parsedOriginal, suggestion.providerLabel, suggestion.modelId, "sendSessionAffinityHeaders");
          const targetOverrideLocation = locateModelOverrideInJsonc(
            originalText, suggestion.providerLabel, suggestion.modelId,
          );
          const hasTargetOverride = (targetOverrideLocation?.modelOverrideObjectBrace ?? -1) >= 0;
          const providerPlan = diagnosis && diagnosis.scenario !== "provider_missing" &&
            isValidModelsConfigForEffectiveCompat(parsedOriginal) && asRecord(provider) &&
            Object.keys(suggestion.compatKeys).length === 1 && suggestion.compatKeys.sendSessionAffinityHeaders === true &&
            !suggestion.forceModelLevel && !hasTargetOverride && explicit === undefined &&
            getEffectiveCompatValueSource(model, parsedOriginal, "sendSessionAffinityHeaders") === undefined
              ? composeProviderAffinityInsertion(originalText, suggestion.providerLabel)
              : undefined;
          if (providerPlan) {
            const checkProvider = (writtenText: string): string | null => {
              try {
                const changed = parseJsonc(writtenText);
                if (!isValidModelsConfigForEffectiveCompat(changed)) return "provider config is invalid";
                if (resolveEffectiveCompatFromConfig(model, changed).sendSessionAffinityHeaders !== true) return "affinity flag is not effective";
                const reverted = JSON.parse(JSON.stringify(changed)) as Record<string, unknown>;
                const target = asRecord(asRecord(reverted.providers)?.[suggestion.providerLabel]);
                const compat = asRecord(target?.compat);
                if (!target || !compat || compat.sendSessionAffinityHeaders !== true) return "provider affinity key is missing";
                delete compat.sendSessionAffinityHeaders;
                const originalCompat = asRecord(asRecord(provider)?.compat);
                if (!originalCompat) delete target.compat;
                return JSON.stringify(reverted) === JSON.stringify(parsedOriginal) ? null : "unrelated configuration was altered";
              } catch { return "invalid provider JSONC"; }
            };
            const checkError = checkProvider(providerPlan.modifiedText);
            if (checkError) {
              cmdCtx.ui.notify(`❌ Provider-level self-check failed: ${checkError}. No changes were made.`, "error");
              return;
            }
            const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${backupTimestamp()}`;
            const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Fix provider affinity", [
              `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
              `Location: ${providerPlan.placementLabel}`,
              `Compat JSON to write: ${JSON.stringify(suggestion.compatKeys)}`,
              `⚠️ This affects all models using this provider across all sessions; model-level overrides remain authoritative.`,
              `A timestamped backup will be written to: ${backupPath}`,
              "Run /reload or restart Pi for the change to take effect.",
              "Apply these changes?",
            ].join("\n"));
            if (!confirmed) {
              cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
              return;
            }
            const receipt = createModelsJsonFixReceipt(
              originalText, providerPlan.modifiedText, suggestion.providerLabel, suggestion.modelId,
              "provider", suggestion.compatKeys, true, backupPath,
            );
            if (!receipt) {
              cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
              return;
            }
            try {
              const result = await applyModelsJsonFixTransaction(providerPlan.modifiedText, backupPath, checkProvider, {
                expectedCurrentHash: hashText(originalText), purpose: "fix",
                onCommitted: async () => writeModelsJsonFixReceipt(receipt),
              });
              if ("postCheckError" in result) {
                cmdCtx.ui.notify(`❌ Post-write self-check failed: ${result.postCheckError}. Backup restored.`, "error");
                return;
              }
              invalidateModelsConfigCache();
              cmdCtx.ui.notify(`✅ Fix applied to ${getModelsJsonDisplayPath()}.\nBackup saved to: ${backupPath}\nRun /reload or restart Pi.`, "info");
            } catch (error) {
              cmdCtx.ui.notify(`❌ Write failed: ${error instanceof Error ? error.message : String(error)}. Backup may be at: ${backupPath}`, "error");
            }
            return;
          }
          if (diagnosis && cmdCtx.hasUI) {
            const overrideLocation = locateModelOverrideInJsonc(
              originalText, suggestion.providerLabel, suggestion.modelId,
            );
            const repairsExistingOverride = (overrideLocation?.modelOverrideObjectBrace ?? -1) >= 0;
            // Prefer a modelOverrides edit when models[] has no target entry.
            const plan = composeModelOverrideInsertion(
              originalText, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
            );
            if (!plan) {
              cmdCtx.ui.notify(
                `❌ Could not safely locate a modelOverrides insertion point.\n` +
                `Falling back to manual guidance. No changes were made.`,
                "error",
              );
            } else {
            const checkError = selfCheckMissingEntryInsertion(
              originalText, plan.modifiedText,
              suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
              model,
            );
            if (checkError !== null) {
              // Fall through to manual guidance.
              cmdCtx.ui.notify(
                `❌ Self-check would fail for auto-created entry: ${checkError}\n` +
                `Falling back to manual guidance. No changes were made.`,
                "error",
              );
              // Continue to manual guidance below.
            } else {
              const keysPreview = JSON.stringify(suggestion.compatKeys, null, 2);
              const ts = backupTimestamp();
              const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${ts}`;
              const previewLines = [
                `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
                ``,
                `Location: ${plan.placementLabel}`,
                `Compat JSON to write:`,
                keysPreview,
                ``,
                `⚠️  Risk notice:`,
                repairsExistingOverride
                  ? `  1. This updates the existing modelOverrides entry for "${suggestion.modelId}". Existing auth is not affected.`
                  : `  1. This creates a modelOverrides entry in models.json. Existing auth (e.g. login API tokens) is not affected.`,
                `  2. A timestamped backup will be written to: ${backupPath}`,
                `  3. You must run /reload or restart Pi for the change to take effect.`,
                `  4. If the file contains comments or unusual formatting, please verify the result after write.`,
              ];
              if (promptCacheRetention400Models.has(modelKey(model))) {
                previewLines.push(
                  "",
                  "💡  This fix overrides supportsLongCacheRetention to false because",
                  "a 400 prompt_cache_retention error was observed for this model.",
                  "After applying and reloading, Pi will no longer send the",
                  "prompt_cache_retention parameter to this provider.",
                );
              }
              previewLines.push("", `Apply these changes?`);
              const confirmed = await cmdCtx.ui.confirm(
                repairsExistingOverride ? "Cache Optimizer — Fix (model override)" : "Cache Optimizer — Fix (new override)",
                previewLines.join("\n"),
              );
              if (confirmed) {
                try {
                  const receipt = createModelsJsonFixReceipt(
                    originalText,
                    plan.modifiedText,
                    suggestion.providerLabel,
                    suggestion.modelId,
                    "modelOverride",
                    suggestion.compatKeys,
                    repairsExistingOverride,
                    backupPath,
                  );
                  if (!receipt) {
                    cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
                    return;
                  }
                  const result = await applyModelsJsonFixTransaction(
                    plan.modifiedText,
                    backupPath,
                    (writtenText) => selfCheckMissingEntryInsertion(
                      originalText,
                      writtenText,
                      suggestion.providerLabel,
                      suggestion.modelId,
                      suggestion.compatKeys,
                      model,
                    ),
                    {
                      expectedCurrentHash: hashText(originalText),
                      purpose: "fix",
                      onCommitted: async () => writeModelsJsonFixReceipt(receipt),
                    },
                  );
                  if ("postCheckError" in result) {
                    cmdCtx.ui.notify(
                      `❌ Post-write self-check failed: ${result.postCheckError}\n` +
                      `The backup at ${backupPath} has been restored. No changes applied.`,
                      "error",
                    );
                    return;
                  }
                  invalidateModelsConfigCache();
                  cmdCtx.ui.notify(
                    `✅ Fix applied to ${getModelsJsonDisplayPath()}.\n` +
                    `Backup saved to: ${backupPath}\n` +
                    `Run /reload or restart Pi for the change to take effect.`,
                    "info",
                  );
                } catch (e) {
                  cmdCtx.ui.notify(
                    `❌ Write failed: ${e instanceof Error ? e.message : String(e)}\n` +
                    `Backup may be at: ${backupPath}`,
                    "error",
                  );
                }
                return;
              }
              cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
              return;
            }
            }
          }

          // Non-interactive or no diagnosis: show manual guidance.
          const snippet = diagnosis
            ? formatMissingEntryManualSnippet(suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys)
            : formatCompatKeysForInsertion(suggestion.compatKeys);
          const adviceLines: string[] = [];
          if (!diagnosis) {
            adviceLines.push(
              `❌ Could not locate model "${suggestion.modelId}" or provider "${suggestion.providerLabel}" in ${getModelsJsonDisplayPath()}.`,
              "",
              "Providers that were added via Pi /login API (e.g. opencode go) do not have",
              "entries in models.json. You can create a minimal modelOverrides entry by hand:",
            );
          } else if (diagnosis.scenario === "provider_missing") {
            adviceLines.push(
              `ℹ️ Provider "${suggestion.providerLabel}" does not exist in ${getModelsJsonDisplayPath()}.`,
              `This is common for API-logged-in providers (e.g. /login ...).`,
              "",
              "Add the following minimal block under the \"providers\" key (keep your",
              "existing authentication as-is):",
            );
          } else {
            adviceLines.push(
              `ℹ️ Model "${suggestion.modelId}" was not found in ${getModelsJsonDisplayPath()}`,
              `under providers["${suggestion.providerLabel}"].`,
              "",
              "Add the following modelOverrides entry (keep existing auth):",
            );
          }
          adviceLines.push("", snippet, "", "Then save and run /reload.");
          cmdCtx.ui.notify(adviceLines.join("\n"), "warning");
          return;
        }

        const duplicateTargetDefinitions = location.allModelIds.filter(
          (configuredModelId) => configuredModelId === suggestion.modelId,
        ).length;
        if (duplicateTargetDefinitions > 1) {
          cmdCtx.ui.notify(
            `❌ ${getModelsJsonDisplayPath()} contains ${duplicateTargetDefinitions} custom model definitions ` +
            `with the exact id "${suggestion.modelId}" under providers["${suggestion.providerLabel}"].\n` +
            `Pi uses the last definition, but /cache-optimizer fix refuses an ambiguous duplicate-id edit. ` +
            `Remove or consolidate the duplicates, then run the command again.`,
            "error",
          );
          return;
        }

        // Compose the modified text — observed runtime failures are always
        // model-scoped; ordinary compat fixes use the safety-based placement.
        const decision = chooseFixPlacement(
          originalText,
          location,
          suggestion.compatKeys,
          suggestion.providerLabel,
          suggestion.forceModelLevel,
        );
        const createsModelOverride = decision.placement === "modelOverride" && location.modelOverrideObjectBrace < 0;
        const modelOverridePlan = createsModelOverride
          ? composeModelOverrideInsertion(
              originalText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
            )
          : undefined;
        if (createsModelOverride && !modelOverridePlan) {
          cmdCtx.ui.notify(
            "❌ Could not safely create the highest-precedence model override. No changes were made.",
            "error",
          );
          return;
        }
        const modifiedText = modelOverridePlan?.modifiedText
          ?? composeFixInsertion(originalText, location, suggestion.compatKeys, decision.placement);

        // Self-check against the same provider → model → runtime →
        // modelOverride precedence used by request hooks.
        const checkError = createsModelOverride
          ? selfCheckMissingEntryInsertion(
              originalText,
              modifiedText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
              model,
            )
          : selfCheckFix(
              originalText,
              modifiedText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
              decision.placement,
              model,
            );
        if (checkError !== null) {
          cmdCtx.ui.notify(
            `❌ Self-check failed before write: ${checkError}\n` +
            `No changes were made. Manual edit required.`,
            "error",
          );
          return;
        }

        // Build preview snippet as copyable JSON (the surgical editor will
        // insert or repair these exact compat key/value pairs).
        const keysPreview = JSON.stringify(suggestion.compatKeys, null, 2);
        const targetHasCompat = decision.placement === "provider"
          ? location.providerCompatBrace >= 0
          : decision.placement === "modelOverride"
            ? location.modelOverrideCompatBrace >= 0
            : location.compatObjectBrace >= 0;
        const placementDesc = targetHasCompat ? `existing "compat" object` : `new "compat" object`;
        const locationDesc = decision.placement === "provider"
          ? `providers["${suggestion.providerLabel}"] -> compat (provider level, ${placementDesc})`
          : decision.placement === "modelOverride"
            ? `providers["${suggestion.providerLabel}"] -> modelOverrides -> "${suggestion.modelId}" -> compat (${placementDesc})`
            : `providers["${suggestion.providerLabel}"] -> models -> "${suggestion.modelId}" -> compat (model level, ${placementDesc})`;

        const ts = backupTimestamp();
        const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${ts}`;

        const scopeRiskLine = decision.placement === "provider"
          ? `  1. This change applies to ALL ${location.allModelIds.length || 1} model(s) in the "${suggestion.providerLabel}" provider, across all sessions.`
          : `  1. This change affects ALL sessions using the "${suggestion.providerLabel}" provider/channel (scoped to model "${suggestion.modelId}").`;

        const previewLines = [
          `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
          ``,
          `Location: ${locationDesc}`,
          `Placement: ${decision.placement} level — ${decision.reason}`,
          `Compat JSON to write:`,
          keysPreview,
          ``,
          `⚠️  Risk notice:`,
          scopeRiskLine,
          `  2. A timestamped backup will be written to: ${backupPath}`,
          `  3. You must restart Pi / run /reload for the change to take effect.`,
          `  4. If the file contains comments or unusual formatting, please verify the result after write.`,
        ];
        if (promptCacheRetention400Models.has(modelKey(model))) {
          previewLines.push(
            "",
            "💡  This fix overrides supportsLongCacheRetention to false because",
            "a 400 prompt_cache_retention error was observed for this model.",
            "After applying and reloading, Pi will no longer send the",
            "prompt_cache_retention parameter to this provider.",
          );
        }
        previewLines.push("", `Apply these changes?`);

        const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Fix", previewLines.join("\n"));
        if (!confirmed) {
          cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
          return;
        }

        // Write: backup → temp + rename → self-check again
        try {
          const receipt = createModelsJsonFixReceipt(
            originalText,
            modifiedText,
            suggestion.providerLabel,
            suggestion.modelId,
            decision.placement,
            suggestion.compatKeys,
            !createsModelOverride,
            backupPath,
          );
          if (!receipt) {
            cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
            return;
          }
          const result = await applyModelsJsonFixTransaction(
            modifiedText,
            backupPath,
            (writtenText) => createsModelOverride
              ? selfCheckMissingEntryInsertion(
                  originalText,
                  writtenText,
                  suggestion.providerLabel,
                  suggestion.modelId,
                  suggestion.compatKeys,
                  model,
                )
              : selfCheckFix(
                  originalText,
                  writtenText,
                  suggestion.providerLabel,
                  suggestion.modelId,
                  suggestion.compatKeys,
                  decision.placement,
                  model,
                ),
            {
              expectedCurrentHash: hashText(originalText),
              purpose: "fix",
              onCommitted: async () => writeModelsJsonFixReceipt(receipt),
            },
          );
          if ("postCheckError" in result) {
            cmdCtx.ui.notify(
              `❌ Post-write self-check failed: ${result.postCheckError}\n` +
              `The backup at ${backupPath} has been restored. No changes applied.`,
              "error",
            );
            return;
          }

          invalidateModelsConfigCache();
          cmdCtx.ui.notify(
            `✅ Fix applied to ${getModelsJsonDisplayPath()}.\n` +
            `Backup saved to: ${backupPath}\n` +
            `Run /reload or restart Pi for the change to take effect.`,
            "info",
          );
        } catch (writeError) {
          cmdCtx.ui.notify(
            `❌ Write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}\n` +
            `Backup may be at: ${backupPath}`,
            "error",
          );
        }
      } else {
        // Try interactive selection menu when UI supports it
        if (cmdCtx.hasUI) {
          const menuOptions = [
            "Enable — Turn on runtime optimizations",
            "Disable — Turn off runtime optimizations",
            "Doctor — Show cache configuration",
            "Stats — Show current-session model statistics",
            "Compat — Show compat suggestion",
            "Fix — Auto-fix compat issues (writes models.json or extension config)",
            "Disable prompt_cache_key — Omit it for the active model",
            "Rollback — Undo the latest confirmed fix",
            "Footer mode — Choose total, session, or process stats",
            "Reset — Reset local provider/model stats",
            "Cancel",
          ];
          const choice = await cmdCtx.ui.select("Cache Optimizer", menuOptions);
          if (choice === menuOptions[0]) {
            await handleCacheOptimizerCommand("enable", cmdCtx);
          } else if (choice === menuOptions[1]) {
            await handleCacheOptimizerCommand("disable", cmdCtx);
          } else if (choice === menuOptions[2]) {
            await handleCacheOptimizerCommand("doctor", cmdCtx);
          } else if (choice === menuOptions[3]) {
            await handleCacheOptimizerCommand("stats", cmdCtx);
          } else if (choice === menuOptions[4]) {
            await handleCacheOptimizerCommand("compat", cmdCtx);
          } else if (choice === menuOptions[5]) {
            await handleCacheOptimizerCommand("fix", cmdCtx);
          } else if (choice === menuOptions[6]) {
            await handleCacheOptimizerCommand("fix prompt-cache-key", cmdCtx);
          } else if (choice === menuOptions[7]) {
            await handleCacheOptimizerCommand("rollback", cmdCtx);
          } else if (choice === menuOptions[8]) {
            const modeOptions = ["session — Current Pi conversation session (default)", "total — All local sessions today", "process — Current extension instance only", "Cancel"];
            const modeChoice = await cmdCtx.ui.select("Footer cache stats mode", modeOptions);
            const nextMode = modeChoice === modeOptions[0]
              ? "session"
              : modeChoice === modeOptions[1]
                ? "total"
                : modeChoice === modeOptions[2]
                  ? "process"
                  : undefined;
            if (nextMode) await handleCacheOptimizerCommand(`config footer-mode ${nextMode}`, cmdCtx);
          } else if (choice === menuOptions[9]) {
            await handleCacheOptimizerCommand("reset", cmdCtx);
          }
          // choice === "cancel" or undefined → no action
          return;
        }

        // Fallback: text help when no interactive UI
        const diagnosis: string[] = [];
        diagnosis.push("📋 /cache-optimizer commands:");
        diagnosis.push("  enable  — Enable prompt/cache optimizations for this Pi process");
        diagnosis.push("  disable — Disable prompt/cache optimizations for this Pi process");
        diagnosis.push("  doctor  — Show current model/provider/api/baseUrl/compat and low-hit diagnosis");
        diagnosis.push("  stats   — Show detailed statistics for every model in the current session");
        diagnosis.push("  stats all — Show detailed totals for every model across all local sessions");
        diagnosis.push("  stats contributors — Show per-session contributors for the active model");
        diagnosis.push("  compat  — Show compat suggestion with edit location");
        diagnosis.push("  config prompt-rewrite|virtual-rewrite|skill-compression|openai-cache-key|tool-order on|off — Persist feature settings");
        diagnosis.push("  config footer-mode total|session|process — Persist the footer stats mode");
        diagnosis.push("  config reset — Remove persistent feature overrides");
        diagnosis.push("  fix     — Auto-fix compat issues (writes models.json or extension config, requires UI)");
        diagnosis.push("  fix prompt-cache-key — Explicitly omit prompt_cache_key for the active model");
        diagnosis.push("  rollback — Undo the latest confirmed fix (requires UI confirmation)");
        diagnosis.push("  reset   — Reset local provider/model stats for current model (does not affect upstream)");
        diagnosis.push("");
        diagnosis.push(formatOptimizerRuntimeMode());
        const resolvedFooterMode = resolveFooterStatsMode(persistedFooterStatsMode);
        diagnosis.push(`Footer stats mode: ${resolvedFooterMode.mode} (${resolvedFooterMode.source})`);
        diagnosis.push("");
        if (model) {
          const displayKey = modelKey(model);
          const missing = describeMissingCacheCompatForModel(model);
          if (missing.length > 0) {
            diagnosis.push(`⚠️  Active model "${displayKey}" missing compat: ${missing.join(", ")}`);
            diagnosis.push('Run "/cache-optimizer compat" for edit instructions.');
          } else if (isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)) {
            diagnosis.push(`✅ Active model "${displayKey}": compat fully configured.`);
          } else {
            diagnosis.push(`ℹ️ Active model "${displayKey}": compat check not applicable.`);
            const detailLines = getCompatCheckNotApplicableLines(model).slice(1);
            for (const line of detailLines) diagnosis.push(line);
          }
        } else {
          diagnosis.push("No active model selected.");
        }
        cmdCtx.ui.notify(diagnosis.join("\n"), "info");
      }
  }

  pi.registerCommand("cache-optimizer", {
    description: "Configure and diagnose Pi cache behavior",
    getArgumentCompletions: getCacheOptimizerArgumentCompletions,
    handler: handleCacheOptimizerCommand,
  });
}
