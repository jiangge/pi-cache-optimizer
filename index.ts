import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type MutableEnv = Record<string, string | undefined>;

type CacheRetentionEnvSnapshot = {
  wasSet: boolean;
  value?: string;
};

const PI_CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";
const LONG_CACHE_RETENTION_VALUE = "long";

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

const STARTUP_CACHE_RETENTION_ENV = captureCacheRetentionEnv();

/**
 * Pi Cache Optimizer (formerly pi-deepseek-cache-optimizer)
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
// /cache-optimizer disable restores the startup value for this Pi process.
// ============================================================
requestLongCacheRetention();

type PiModel = NonNullable<ExtensionContext["model"]>;
type UnknownRecord = Record<string, unknown>;
type CacheProviderId = "deepseek" | "openai" | "claude" | "gemini";

const LOG_PREFIX = "pi-cache-optimizer";
const STATUS_KEY = "pi-cache-stats";
const STATE_DIR = join(homedir(), ".pi", "agent");
const STATE_FILE_PATH = join(STATE_DIR, "pi-cache-optimizer-stats.json");
const LEGACY_STATE_FILE_PATH = join(STATE_DIR, "deepseek-cache-optimizer-stats.json");
const CACHE_PROVIDER_IDS: CacheProviderId[] = ["deepseek", "openai", "claude", "gemini"];
const OPENAI_CACHE_KEY_ENV = "PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY";
const NO_OPENAI_CACHE_KEY_ENV = "PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY";
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const NO_SKILL_COMPRESSION_ENV = "PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION";
const NO_PROMPT_REWRITE_ENV = "PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE";
const PI_ROUTING_REGISTRY_SYMBOL = Symbol.for("pi.routing.registry.v1");
const PI_CACHE_HINTS_SYMBOL = Symbol.for("pi.cache.hints.v1");

let runtimeOptimizerEnabled = true;

// WORM-flag: if optimizeSystemPrompt ever detects that its blind-replace
// logic has accidentally truncated a structural marker (any XML tag or
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
// `optimizeSystemPrompt` removes each accepted candidate from the dynamic
// remainder via `rest.replace(part, "")`. Short or character-class candidates
// (think: `S`, `- u`, `- (`, `- }`) match the FIRST occurrence of those bytes
// anywhere in `rest`, ripping unrelated text out of the prompt and yielding a
// non-deterministic dynamic remainder per request. Both behaviors poison the
// provider's prompt-prefix cache.
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
  sendSessionAffinityHeaders?: boolean;
  sendSessionIdHeader?: boolean;
  supportsLongCacheRetention?: boolean;
  thinkingFormat?: string;
  requiresReasoningContentOnAssistantMessages?: boolean;
  cacheControlFormat?: string;
  forceAdaptiveThinking?: boolean;
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

/**
 * Per-request sample stored for trend analysis and usage-field-missing detection.
 * Contains only numeric counters and booleans — never message content, prompts,
 * payloads, headers, API keys, or model outputs.
 */
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
  if (isEnabledEnv(process.env[NO_SKILL_COMPRESSION_ENV])) return prompt;
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
 * blind `rest.replace(part, "")` reorder accidentally eats text inside
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

  // Stable layer: content likely to be identical across sessions/turns.
  // Short / single-char candidates are dropped: see MIN_STABLE_CANDIDATE_LENGTH.
  for (const candidate of buildStableCandidates(opts)) {
    const part = candidate.trim();
    if (!part || part.length < MIN_STABLE_CANDIDATE_LENGTH) continue;
    if (seen.has(part) || !rest.includes(part)) continue;

    stableParts.push(part);
    seen.add(part);
    rest = rest.replace(part, "");
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
  // reorder. If any marker drops, the blind `rest.replace(part, "")`
  // logic ate something it shouldn't have — fall back to the original
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
  if (!model) return undefined;
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

function routeSnapshotToPiModel(snapshot: PiRouteSnapshot, fallback?: PiModel): PiModel {
  return {
    ...(fallback ?? {}),
    id: snapshot.modelId,
    name: snapshot.canonicalModelId ?? snapshot.modelId,
    provider: snapshot.provider,
    api: snapshot.api ?? fallback?.api ?? "",
    baseUrl: fallback?.baseUrl ?? "",
    reasoning: fallback?.reasoning ?? false,
    input: fallback?.input ?? ["text"],
    cost: fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: fallback?.contextWindow ?? 0,
    maxTokens: fallback?.maxTokens ?? 0,
    compat: fallback?.compat,
  } as PiModel;
}

function findModelInRegistry(registry: ModelRegistryLike | undefined, provider: string, id: string): PiModel | undefined {
  const found = registry?.find?.(provider, id);
  if (found) return found;

  const available = registry?.getAvailable?.() ?? [];
  const availableMatch = available.find((candidate) => candidate.provider === provider && candidate.id === id);
  if (availableMatch) return availableMatch;

  const all = registry?.getAll?.() ?? [];
  return all.find((candidate) => candidate.provider === provider && candidate.id === id);
}

function resolveRouteModel(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel | undefined {
  const snapshot = resolveActiveRouteSnapshot(model, ctx);
  if (!snapshot) return undefined;

  return findModelInRegistry(ctx?.modelRegistry, snapshot.provider, snapshot.modelId)
    ?? routeSnapshotToPiModel(snapshot, model);
}

function isVirtualRoutingModel(model: PiModel | undefined, ctx?: Pick<ExtensionContext, "sessionManager">): boolean {
  if (!model) return false;
  return isRouterModel(model) || !!getRoutingRegistry()?.getRouter(model.provider) || !!resolveActiveRouteSnapshot(model, ctx);
}

function isCacheHintsServiceV1(value: unknown): value is PiCacheHintsV1 {
  const record = asRecord(value);
  return !!record && record.version === 1 && typeof record.getHints === "function";
}

function getCacheHintsService(): PiCacheHintsV1 | undefined {
  const candidate = getProtocolGlobal()[PI_CACHE_HINTS_SYMBOL];
  return isCacheHintsServiceV1(candidate) ? candidate : undefined;
}

function installCacheHintsService(service: PiCacheHintsV1): () => void {
  const globals = getProtocolGlobal();
  const previous = globals[PI_CACHE_HINTS_SYMBOL];
  globals[PI_CACHE_HINTS_SYMBOL] = service;
  return () => {
    if (globals[PI_CACHE_HINTS_SYMBOL] !== service) return;
    if (previous === undefined) {
      delete globals[PI_CACHE_HINTS_SYMBOL];
    } else {
      globals[PI_CACHE_HINTS_SYMBOL] = previous;
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
function getCompat(model: PiModel | undefined): CacheCompat {
  if (!model) return {} as CacheCompat;

  // Pi merges provider.compat with model.compat (model wins on conflicts)
  // We approximate this by reading from ctx.model which should already have merged compat
  // However, for safety, we check both levels if available
  const modelCompat = (model.compat ?? {}) as CacheCompat;

  // Note: ctx.model from Pi should already contain merged compat,
  // but we document the two-level structure for clarity
  return modelCompat;
}

/**
 * Return a platform-friendly display path for `~/.pi/agent/models.json`.
 *
 * On Windows (platform starts with "win") the path is shown as
 * `%USERPROFILE%\.pi\agent\models.json` to match Windows conventions.
 * On all other platforms (Linux, macOS, etc.) it is shown as
 * `~/.pi/agent/models.json` (the Unix-style tilde shorthand).
 *
 * This is a DISPLAY helper only. Actual path resolution is done by Pi
 * (via Node `os.homedir()` + path.join), and this string is never used
 * for I/O — only for warning/doctor/README text so that users on any
 * platform see a copyable path they recognize.
 */
function getModelsJsonDisplayPath(platform: string = process.platform): string {
  if (platform.startsWith("win")) {
    return `%USERPROFILE%\\.pi\\agent\\models.json`;
  }
  return "~/.pi/agent/models.json";
}

function isEnabledEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isDisabledEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function shouldInjectOpenAIPromptCacheKey(): boolean {
  if (!runtimeOptimizerEnabled) return false;
  if (isEnabledEnv(process.env[NO_OPENAI_CACHE_KEY_ENV])) return false;
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
  lines.push(`• Prompt rewrite: ${runtimeOptimizerEnabled && !isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV]) ? "on" : "off"}`);
  lines.push(`• OpenAI prompt_cache_key fallback: ${shouldInjectOpenAIPromptCacheKey() ? "on" : "off"}`);
  lines.push(`• Footer cache stats: on${runtimeOptimizerEnabled ? "" : " (comparison mode)"}`);
  lines.push(`• Compat warnings: ${runtimeOptimizerEnabled ? "on" : "off"}`);
  lines.push(`• ${PI_CACHE_RETENTION_ENV}: ${process.env[PI_CACHE_RETENTION_ENV] ?? "(unset)"}`);
  if (!runtimeOptimizerEnabled) {
    lines.push("This is a current-process switch. Run /reload or restart Pi to return to startup behavior.");
  } else if (isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV]) || !shouldInjectOpenAIPromptCacheKey()) {
    lines.push("Some features are still disabled by environment variables.");
  }
  return lines;
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

function isOpenAICompatibleProxyApi(api: unknown): boolean {
  return lower(api) === "openai-completions";
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
 *   claude-sonnet-4-6
 *   claude-fable-5
 *
 * We match broadly: opus >= 4-6, sonnet >= 4-6, fable >= 5.
 * Ids may carry date-stamp or size suffixes like "[1M]".
 */
const ADAPTIVE_OPUS_PATTERN = /(^|[\/\s:_-])(opus-4[.-][6-9]|opus-4-[1-9][0-9])($|[-_.:\/\s\[])/i;
const ADAPTIVE_SONNET_PATTERN = /(^|[\/\s:_-])(sonnet-4[.-][6-9]|sonnet-4-[1-9][0-9])($|[-_.:\/\s\[])/i;
const ADAPTIVE_FABLE_PATTERN = /(^|[\/\s:_-])fable-([5-9]|[1-9][0-9])($|[-_.:\/\s\[])/i;

function isAdaptiveGenerationModel(model: PiModel | undefined): boolean {
  if (!model) return false;
  const tokens = getModelIdNameTokenValues(model);
  return tokens.some((t) => ADAPTIVE_OPUS_PATTERN.test(t) || ADAPTIVE_SONNET_PATTERN.test(t) || ADAPTIVE_FABLE_PATTERN.test(t));
}

function isAdaptiveThinkingCompatApplicable(model: PiModel): boolean {
  return lower(model.api) === "anthropic-messages" && isAdaptiveGenerationModel(model);
}

function describeMissingAdaptiveThinkingCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];
  if (compat.forceAdaptiveThinking !== true) {
    missing.push("forceAdaptiveThinking");
  }
  return missing;
}

function buildAdaptiveThinkingCompatSuggestion(missing: string[]): Record<string, unknown> {
  const suggestion: Record<string, unknown> = {};
  if (missing.includes("forceAdaptiveThinking")) {
    suggestion.forceAdaptiveThinking = true;
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
  appendCredentialSafeProviderGuidance(lines, placement, suggestion);
}

function buildAdaptiveThinkingCompatWarningText(key: string, missing: string[]): string {
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;
  const modelsJsonPath = getModelsJsonDisplayPath();
  const lines: string[] = [
    `💡 pi-cache-optimizer: ${key} is an adaptive-generation Claude model but merged compat lacks ${missing.join(" and ")}.`,
    `Without this flag, Pi sends legacy thinking format that may be rejected by the upstream.`,
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

function modelKey(model: PiModel): string {
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

  return {
    ...(fallback ?? {}),
    id,
    name: id,
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

function keyForModelExt(model: { provider: string; id: string }): string {
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

function describeMissingOpenAIFamilyProxyCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];

  if (!isOpenAIFamilyModel(model)) return missing;
  if (!isOpenAICompatibleProxyApi(model.api)) return missing;
  if (isOfficialOpenAIBaseUrl(model)) return missing;

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
  if (isOfficialOpenAIBaseUrl(model)) return missing;

  if (compat.sendSessionAffinityHeaders !== true) {
    missing.push("sendSessionAffinityHeaders");
  }

  // Check supportsLongCacheRetention: if it's true (Pi default) or undefined,
  // third-party APIs likely don't support it → should be explicitly set to false
  if (compat.supportsLongCacheRetention !== false) {
    missing.push("supportsLongCacheRetention");
  }

  return missing;
}

function describeOptionalOpenAICompatibleProxyCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const optional: string[] = [];

  if (!isOpenAICompatibleProxyApi(model.api)) return optional;
  if (isOfficialOpenAIBaseUrl(model)) return optional;

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
  if (missing.includes("supportsLongCacheRetention")) {
    suggestion.supportsLongCacheRetention = false;  // Safe default for third-party APIs
  }
  return suggestion;
}

function getPromptCacheRetentionUnsupportedHint(): string {
  return "If this channel returns `400 Unsupported parameter: prompt_cache_retention`, remove/avoid `supportsLongCacheRetention`; this extension does not write that field directly, but Pi may send it when long retention is requested and compat says the proxy supports it.";
}

function hasPromptCacheRetentionUnsupportedSignal(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;

  const normalized = Object.entries(headers)
    .map(([key, value]) => `${lower(key)}: ${lower(value)}`)
    .join("\n");
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
    "bad request",
  ].some((needle) => normalized.includes(needle));
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
    `💡 pi-cache-optimizer: ${key} is a third-party GPT/OpenAI-compatible proxy but merged compat lacks ${missing.join(" and ")}.`,
    `Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (at the same level as baseUrl/api/apiKey/models).`,
    ``,
  ];

  appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId });

  return lines.join("\n");
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
  if (compat.requiresReasoningContentOnAssistantMessages !== true) {
    missing.push("requiresReasoningContentOnAssistantMessages");
  }
  if (compat.thinkingFormat !== "deepseek") {
    missing.push("thinkingFormat");
  }

  return missing;
}

function isDeepSeekCompatCheckApplicable(model: PiModel): boolean {
  return isDeepSeekLikeModel(model) && isOpenAICompatibleApi(model.api);
}

function describeMissingCacheCompatForModel(model: PiModel): string[] {
  if (isAdaptiveThinkingCompatApplicable(model)) {
    return describeMissingAdaptiveThinkingCompat(model);
  }
  if (isDeepSeekCompatCheckApplicable(model)) {
    return describeMissingDeepSeekCompat(model);
  }
  return describeMissingOpenAICompatibleProxyCompat(model);
}

function buildDeepSeekCompatSuggestion(missing: string[]): Record<string, unknown> {
  const suggestion: Record<string, unknown> = {};

  if (missing.includes("supportsLongCacheRetention")) {
    suggestion.supportsLongCacheRetention = true;
  }
  if (missing.includes("sendSessionIdHeader")) {
    suggestion.sendSessionIdHeader = true;
  }
  if (missing.includes("sendSessionAffinityHeaders")) {
    suggestion.sendSessionAffinityHeaders = true;
  }
  if (missing.includes("requiresReasoningContentOnAssistantMessages")) {
    suggestion.requiresReasoningContentOnAssistantMessages = true;
  }
  if (missing.includes("thinkingFormat")) {
    suggestion.thinkingFormat = "deepseek";
  }

  return suggestion;
}

function appendDeepSeekCompatAdviceLines(lines: string[], missing: string[], placement: CompatAdvicePlacement = {}): void {
  const suggestion = buildDeepSeekCompatSuggestion(missing);
  if (Object.keys(suggestion).length > 0) {
    lines.push("Recommended DeepSeek compat snippet:");
    lines.push(JSON.stringify(suggestion, null, 2));
  }

  if (missing.includes("requiresReasoningContentOnAssistantMessages")) {
    lines.push('- requiresReasoningContentOnAssistantMessages: true keeps replayed assistant turns compatible with DeepSeek reasoning_content requirements.');
  }
  if (missing.includes("thinkingFormat")) {
    lines.push('- thinkingFormat: "deepseek" tells Pi to use DeepSeek reasoning/thinking parameter format.');
  }
  if (missing.includes("sendSessionAffinityHeaders")) {
    lines.push("- sendSessionAffinityHeaders: recommended for OpenAI-compatible DeepSeek proxies when supported; it helps keep one Pi session on the same upstream/backend.");
  }
  if (missing.includes("sendSessionIdHeader")) {
    lines.push("- sendSessionIdHeader: recommended for OpenAI Responses-compatible DeepSeek proxies when supported.");
  }
  if (missing.includes("supportsLongCacheRetention")) {
    lines.push("- supportsLongCacheRetention: enable for DeepSeek-compatible endpoints that support long cache retention.");
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
      if (!isDeepSeekLikeModel(model) || !isOpenAICompatibleApi(model.api)) return undefined;

      const missing = describeMissingDeepSeekCompat(model);
      if (missing.length === 0) return undefined;

      const key = modelKey(model);
      return buildDeepSeekCompatWarningText(key, missing);
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

  // Native anthropic-messages adaptive thinking compat check.
  // The Claude adapter's warningText only fires for OpenAI-compatible APIs,
  // so native anthropic-messages models need a separate check.
  if (lower(model.api) === "anthropic-messages" && isAdaptiveGenerationModel(model)) {
    const compat = getCompat(model);
    if (compat.forceAdaptiveThinking !== true) {
      const key = `adaptive-thinking:${modelKey(model)}`;
      if (!warnedModels.has(key)) {
        warnedModels.add(key);
        const missing = describeMissingAdaptiveThinkingCompat(model);
        ctx.ui.notify(buildAdaptiveThinkingCompatWarningText(modelKey(model), missing), "warning");
      }
    }
    // Still check adapter warnings for other compat issues.
  }

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

function buildExactRouterStatusEntry(
  sessionHash: string | undefined,
  statsByModel: Record<string, CacheStats>,
  lastRoutedModel: PersistedRoutedModelRef | undefined,
): { model: PiModel; adapter: CacheProviderAdapter; stats: CacheStats } | undefined {
  if (!sessionHash || !lastRoutedModel) return undefined;

  const model = routedModelRefToPiModel(lastRoutedModel);
  const adapter = selectAdapterForModel(model);
  if (!adapter) return undefined;

  const key = makeSessionModelKey(sessionHash, lastRoutedModel.provider, lastRoutedModel.id);
  return { model, adapter, stats: statsByModel[key] ?? emptyCacheStats() };
}

function parsePersistedCacheStats(value: unknown): CacheStatsState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  // version 4/5: session-scoped stats + legacy family fallback.
  // v5 additionally persists the last actual routed model per session so
  // router/auto can restore the exact upstream footer after /reload.
  if (record.version === 4 || record.version === 5) {
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

    return { statsByModel, legacyFamily, lastRoutedModelBySession };
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

    return { statsByModel, legacyFamily };
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
    return { statsByModel: {}, legacyFamily };
  }

  // version 1: single DeepSeek stats -> migrate to legacyFamily.deepseek
  if (record.version === 1) {
    const migrated = parseCacheStats(record.stats);
    return migrated ? { statsByModel: {}, legacyFamily: { deepseek: migrated } } : undefined;
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
 * Pure function (no I/O) — suitable for unit tests without touching the real
 * state file at `~/.pi/agent/pi-cache-optimizer-stats.json`.
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

async function writePersistedCacheStats(state: CacheStatsState, currentSessionHash?: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });

  // Read existing file to preserve other sessions' data.
  let existingSessions: Record<string, Record<string, CacheStats>> = {};
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
      existingLastRoutedModelBySession = { ...(parsed.lastRoutedModelBySession ?? {}) };
    }
  } catch {
    // Ignore read errors (file may not exist yet).
  }

  const sessions = mergeCacheSessions(existingSessions, state, currentSessionHash);
  const lastRoutedModelBySession = mergeLastRoutedModels(
    existingLastRoutedModelBySession,
    state,
    currentSessionHash,
  );

  const payload: PersistedCacheStatsV5 = {
    version: 5,
    sessions,
    legacyFamily: state.legacyFamily,
    ...(Object.keys(lastRoutedModelBySession).length > 0 ? { lastRoutedModelBySession } : {}),
  };
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, STATE_FILE_PATH);
}



function isCompatCheckApplicable(model: PiModel): boolean {
  return isOpenAICompatibleProxyApi(model.api) && !isOfficialOpenAIBaseUrl(model);
}

function isPromptCacheRetention400Applicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api) &&
    !isOfficialOpenAIBaseUrl(model) &&
    getCompat(model).supportsLongCacheRetention === true;
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

  // Official OpenAI bypass — no notes needed.
  if (isOfficialOpenAIBaseUrl(model)) {
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

  return ["ℹ️ Compat check not applicable for this model."];
}

function buildDoctorDiagnosis(model: PiModel, options: { promptCacheRetention400?: boolean } = {}): string {
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
  const optionalOpenAIProxyCompat = (!adaptiveThinkingApplicable && !deepSeekCompatApplicable)
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

  if (isPromptCacheRetention400Applicable(model)) {
    lines.push("");
    if (options.promptCacheRetention400) {
      lines.push("⚠️  A 400 response was observed while supportsLongCacheRetention is enabled.");
      lines.push(`   ${getPromptCacheRetentionUnsupportedHint()}`);
    } else {
      lines.push(`ℹ️ Long retention is enabled. ${getPromptCacheRetentionUnsupportedHint()}`);
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
  const optionalOpenAIProxyCompat = (!adaptiveThinkingApplicable && !deepSeekCompatApplicable)
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
 * Returns the key's opening-quote offset and its value's start offset,
 * or undefined when the key is absent or the object is malformed.
 */
function findJsonObjectKey(
  text: string,
  openBracePos: number,
  targetKey: string,
): { keyStart: number; valueStart: number } | undefined {
  if (text[openBracePos] !== "{") return undefined;
  let i = openBracePos + 1;
  while (i < text.length) {
    i = skipJsonWhitespace(text, i);
    if (i >= text.length || text[i] === "}") return undefined;
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
    if (key.value === targetKey) return { keyStart, valueStart: i };
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

/**
 * JSONC scanner: locate the provider block and model entry in models.json text.
 * Returns the byte offsets for surgical insertion, or undefined if ambiguous.
 */
interface ModelNodeLocation {
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
  /** All model ids found in this provider's models array (for placement safety analysis) */
  allModelIds: string[];
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
  if (!providersKey) return undefined;
  const providersBrace = skipJsonWhitespace(clean, providersKey.valueStart);
  if (clean[providersBrace] !== "{") return undefined;
  const providersEnd = findMatchingBracket(clean, providersBrace);
  if (providersEnd === undefined) return undefined;

  const providerKey = findJsonObjectKey(clean, providersBrace, providerLabel);
  if (!providerKey || providerKey.keyStart > providersEnd) return undefined;
  const providerBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerBrace] !== "{") return undefined;
  const providerEndBrace = findMatchingBracket(clean, providerBrace);
  if (providerEndBrace === undefined || providerEndBrace > providersEnd) return undefined;

  // Provider-level compat is a direct provider child only. Nested model
  // compat objects are intentionally skipped whole by findJsonObjectKey.
  let providerCompatBrace = -1;
  let providerCompatEnd = -1;
  const providerCompatKey = findJsonObjectKey(clean, providerBrace, "compat");
  if (providerCompatKey && providerCompatKey.keyStart < providerEndBrace) {
    const brace = skipJsonWhitespace(clean, providerCompatKey.valueStart);
    if (clean[brace] === "{") {
      const end = findMatchingBracket(clean, brace);
      if (end !== undefined && end <= providerEndBrace) {
        providerCompatBrace = brace;
        providerCompatEnd = end;
      }
    }
  }

  const modelsKey = findJsonObjectKey(clean, providerBrace, "models");
  if (!modelsKey || modelsKey.keyStart > providerEndBrace) return undefined;

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

    if (elementId === modelId && modelBrace < 0) {
      modelBrace = elementBrace;
      modelEndBrace = elementEnd;

      const compatKey = findJsonObjectKey(clean, modelBrace, "compat");
      if (compatKey && compatKey.keyStart < modelEndBrace) {
        compatKeyStartClean = compatKey.keyStart;
        const brace = skipJsonWhitespace(clean, compatKey.valueStart);
        if (clean[brace] === "{") {
          const end = findMatchingBracket(clean, brace);
          if (end !== undefined && end <= modelEndBrace) {
            compatBrace = brace;
            compatEndBrace = end;
          }
        }
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
    allModelIds,
  };
}

/**
 * Scan produced by `analyzeModelsJsonForMissingEntry` when
 * `locateModelInJsonc` cannot find the target provider/model.
 */
type MissingEntryDiagnosis =
  | { scenario: "provider_missing"; providersEnd: number }
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
  if (!providersKey) {
    // Root has no "providers" key at all — we don't auto-create one.
    return undefined;
  }
  const providersBrace = skipJsonWhitespace(clean, providersKey.valueStart);
  if (clean[providersBrace] !== "{") return undefined;
  const providersEnd = findMatchingBracket(clean, providersBrace);
  if (providersEnd === undefined) return undefined;

  const providerKey = findJsonObjectKey(clean, providersBrace, providerLabel);
  if (!providerKey || providerKey.keyStart > providersEnd) {
    return { scenario: "provider_missing", providersEnd };
  }

  // Provider exists. Check for a models array so we know where to append.
  const providerBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerBrace] !== "{") return undefined;
  const providerEndBrace = findMatchingBracket(clean, providerBrace);
  if (providerEndBrace === undefined || providerEndBrace > providersEnd) return undefined;

  const modelsKey = findJsonObjectKey(clean, providerBrace, "models");
  if (modelsKey && modelsKey.keyStart < providerEndBrace) {
    let mScan = skipJsonWhitespace(clean, modelsKey.valueStart);
    if (clean[mScan] === "[") {
      const modelsEnd = findMatchingBracket(clean, mScan);
      if (modelsEnd !== undefined && modelsEnd <= providerEndBrace) {
        return { scenario: "model_missing", modelsEnd, providerBrace, providerEndBrace };
      }
    }
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
  const compatItems = sorted.map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  lines.push(`"${providerLabel}": {`);
  lines.push(`    "models": [`);
  lines.push(`      {`);
  lines.push(`        "id": ${JSON.stringify(modelId)},`);
  lines.push(`        "compat": {`);
  lines.push(compatItems.join(",\n"));
  lines.push(`        }`);
  lines.push(`      }`);
  lines.push(`    ]`);
  lines.push(`  }`);
  return lines.join("\n");
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

    // Determine whether the array is empty (need to skip the leading newline).
    const arrayInterior = originalText.slice(
      originalText.lastIndexOf("[", diagnosis.modelsEnd) + 1,
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
    const providersInterior = originalText.slice(
      originalText.lastIndexOf("{", diagnosis.providersEnd) + 1,
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
 * Lightweight self-check for a newly inserted entry.
 * Parses the modified text as JSONC and confirms:
 *   1. The target model exists under the provider.
 *   2. Every compat key has the expected value (merged provider+model).
 * Returns null on success, an error string on failure.
 */
function selfCheckMissingEntryInsertion(
  originalText: string,
  modifiedText: string,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
): string | null {
  try {
    const modParsed = parseJsonc(modifiedText);
    const providers = asRecord(asRecord(modParsed)?.providers);
    if (!providers) return "Modified file: providers object missing or invalid";
    const provider = asRecord(providers[providerLabel]);
    if (!provider) return `Modified file: provider "${providerLabel}" not found`;
    const models = provider.models;
    if (!Array.isArray(models)) return `Modified file: provider "${providerLabel}".models is not an array`;
    const targetModel = models.find((m: unknown) => asRecord(m)?.id === modelId);
    if (!targetModel || typeof targetModel !== "object")
      return `Modified file: model "${modelId}" not found in provider after insertion`;

    // Validate effective merged compat
    const provCompatRaw = (provider as Record<string, unknown>).compat;
    const provCompat = (provCompatRaw && typeof provCompatRaw === "object" && !Array.isArray(provCompatRaw))
      ? provCompatRaw as Record<string, unknown>
      : {};
    const mdlCompatRaw = (targetModel as Record<string, unknown>).compat;
    const mdlCompat = (mdlCompatRaw && typeof mdlCompatRaw === "object" && !Array.isArray(mdlCompatRaw))
      ? mdlCompatRaw as Record<string, unknown>
      : {};
    const merged = { ...provCompat, ...mdlCompat };
    for (const [k, v] of Object.entries(compatKeys)) {
      if (!(k in merged)) return `Modified file: effective compat.${k} not found`;
      if (merged[k] !== v) return `Modified file: effective compat.${k} wrong value`;
    }

    if (modifiedText.length < originalText.length)
      return "Modified file: content is shorter than original (possible truncation)";

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
  "sendSessionIdHeader",
  "supportsLongCacheRetention",
]);

function syntheticModelForId(providerLabel: string, id: string): PiModel {
  return { provider: providerLabel, id, name: id } as PiModel;
}

/**
 * Decide whether the fix should write provider-level or model-level compat.
 *
 * Strategy (auto-detect, prefer provider level when safe):
 * - Channel-capability keys (session affinity / long retention) are always
 *   provider-safe.
 * - Model-behavior keys (forceAdaptiveThinking, thinkingFormat, ...) are
 *   provider-safe ONLY when every sibling model in the provider also matches
 *   the same detection (all adaptive-generation / all DeepSeek-like).
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
      const allAdaptive = siblings.every((id) => isAdaptiveGenerationModel(syntheticModelForId(providerLabel, id)));
      if (!allAdaptive) unsafeKeys.push(key);
      continue;
    }
    if (key === "thinkingFormat" || key === "requiresReasoningContentOnAssistantMessages") {
      const allDeepSeek = siblings.every((id) => isDeepSeekLikeModel(syntheticModelForId(providerLabel, id)));
      if (!allDeepSeek) unsafeKeys.push(key);
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
): { placement: "provider" | "model"; reason: string } {
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

function composeFixInsertion(
  original: string,
  location: ModelNodeLocation,
  compatKeys: Record<string, unknown>,
  placement: "provider" | "model" = "model",
): string {
  // Resolve the target compat object and its container based on placement.
  const targetCompatBrace = placement === "provider" ? location.providerCompatBrace : location.compatObjectBrace;
  const targetCompatEnd = placement === "provider" ? location.providerCompatEnd : location.compatObjectEnd;
  const containerBrace = placement === "provider" ? location.providerObjectBrace : location.modelObjectBrace;

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

    // Step 5: Compute the EFFECTIVE merged compat (provider-level + model-level),
    // mirroring Pi's mergeCompat behavior (model wins on conflicts). The fix may
    // have written either level, so validation must check the merged result.
    const provCompatRaw = (provider as Record<string, unknown>).compat;
    const provCompat = (provCompatRaw && typeof provCompatRaw === 'object' && !Array.isArray(provCompatRaw))
      ? provCompatRaw as Record<string, unknown>
      : {};
    const modelCompatRaw = (targetModel as Record<string, unknown>).compat;
    if (modelCompatRaw !== undefined && (typeof modelCompatRaw !== 'object' || modelCompatRaw === null || Array.isArray(modelCompatRaw))) {
      return `Modified file: model "${modelId}" compat is not an object`;
    }
    const mdlCompat = (modelCompatRaw ?? {}) as Record<string, unknown>;
    const mergedCompat: Record<string, unknown> = { ...provCompat, ...mdlCompat };

    // Step 6: Validate all inserted keys are effective in the merged compat
    for (const [k, v] of Object.entries(compatKeys)) {
      if (!(k in mergedCompat)) {
        return `Modified file: compat.${k} not found at provider or model level (insertion failed)`;
      }
      if (mergedCompat[k] !== v) {
        return `Modified file: effective compat.${k} has wrong value: expected ${JSON.stringify(v)}, got ${JSON.stringify(mergedCompat[k])}`;
      }
    }

    // Step 7: Validate original structure is preserved (no accidental deletions/changes)

    function isSubset(origVal: unknown, modVal: unknown, path = ''): boolean {
      if (origVal === modVal) return true;
      if (typeof origVal !== typeof modVal) return false;
      if (typeof origVal !== 'object' || origVal === null || modVal === null) return false;
      if (Array.isArray(origVal) !== Array.isArray(modVal)) return false;
      if (Array.isArray(origVal) && Array.isArray(modVal)) {
        if (origVal.length !== modVal.length) return false;
        return origVal.every((_, i) => isSubset(origVal[i], modVal[i], `${path}[${i}]`));
      }
      // Both objects: check that every key in orig is in mod with same value
      const origObj = origVal as Record<string, unknown>;
      const modObj = modVal as Record<string, unknown>;
      for (const key of Object.keys(origObj)) {
        if (!(key in modObj)) return false;
        if (key === 'compat') {
          // For compat, allow extra keys in modified (the inserted ones).
          // Use recursive isSubset so nested objects (e.g. { deep: true })
          // are compared by content, not reference.
          if (typeof origObj[key] !== 'object' || typeof modObj[key] !== 'object') {
            if (origObj[key] !== modObj[key]) return false;
          } else {
            const origCompat = origObj[key] as Record<string, unknown>;
            const modCompat = modObj[key] as Record<string, unknown>;
            const mayRepairThisCompat = origObj === origProvider || origObj === origTargetModelRecord;
            for (const ck of Object.keys(origCompat)) {
              if (!(ck in modCompat)) return false;
              // The fix may repair an existing wrong compat value (for example
              // thinkingFormat: "legacy" -> "deepseek"), but only on the
              // target provider/model compat objects. Sibling compat blocks must
              // remain structure-equivalent.
              if (mayRepairThisCompat && Object.prototype.hasOwnProperty.call(compatKeys, ck)) continue;
              if (!isSubset(origCompat[ck], modCompat[ck], `${path}.${ck}`)) return false;
            }
          }
        } else if (!isSubset(origObj[key], modObj[key], `${path}.${key}`)) {
          return false;
        }
      }
      return true;
    }

    if (!isSubset(origParsed, modParsed)) {
      return "Modified file: original structure was altered (data loss detected)";
    }

    // Step 8: Basic format sanity checks
    if (modified.length < original.length) {
      return "Modified file: content is shorter than original (possible truncation)";
    }

    // Step 9: Validate root bracket integrity with the same string/comment-aware
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
 * Generate the timestamp string for backup filename.
 * Format: YYYYMMDDTHHMMSSZ (UTC)
 */
function backupTimestamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${h}${min}${s}Z`;
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
  // OpenAI-family cache-key helpers
  addOpenAIPromptCacheKey,
  clampPromptCacheKey,
  hasEffectivePromptCacheKey,
  isNonEmptyString,
  shouldInjectOpenAIPromptCacheKey,
  isOpenAICompatibleApi,
  isOpenAICompatibleProxyApi,
  isResponsesPromptRewriteBypassApi,
  isMistralConversationsApi,
  isOpenAIFamilyModel,
  isOpenAIFamilyAssistantMessage,
  isOpenAIFamilyToken,
  describeMissingOpenAIFamilyProxyCompat,
  describeMissingOpenAICompatibleProxyCompat,
  describeOptionalOpenAICompatibleProxyCompat,
  describeMissingDeepSeekCompat,
  isDeepSeekCompatCheckApplicable,
  describeMissingCacheCompatForModel,
  buildDeepSeekCompatSuggestion,
  buildDeepSeekCompatWarningText,
  buildSafeOpenAIProxyCompatSuggestion,
  getPromptCacheRetentionUnsupportedHint,
  isOfficialOpenAIBaseUrl,
  isCompatCheckApplicable,
  isPromptCacheRetention400Applicable,
  hasPromptCacheRetentionUnsupportedSignal,
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
  getCompat,
  modelKey,
  // Platform-friendly path helpers
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
  // Integrity diagnostics
  getLastPromptIntegrityWarningAt,
  // Diagnostic command helpers
  buildDoctorDiagnosis,
  buildCompatDiagnosis,
  describeRouterChannelDiagnostics,
  // Cache stats helpers (module-level, usable from verify script)
  addUsageToCacheStats,
  formatCacheStats,
  emptyCacheStats,
  emptyAllCacheStats,
  parseCacheStats,
  parsePersistedCacheStats,
  // Recent sample / stats output / diagnosis helpers
  MAX_RECENT_SAMPLES,
  buildStatsOutput,
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
  // Routing-provider protocol helpers
  PI_ROUTING_REGISTRY_SYMBOL,
  PI_CACHE_HINTS_SYMBOL,
  ensureRoutingRegistry,
  getRoutingRegistry,
  parseRouteSnapshot,
  resolveActiveRouteSnapshot,
  routeSnapshotToPiModel,
  resolveRouteModel,
  isVirtualRoutingModel,
  installCacheHintsService,
  getCacheHintsService,
  // Persistence helpers (for reload/reset tests)
  mergeCacheSessions,
  mergeLastRoutedModels,
  writePersistedCacheStats,
  readPersistedCacheStats,
  STATE_FILE_PATH,
  LEGACY_STATE_FILE_PATH,
  STATE_DIR,
  // JSONC surgical edit helpers
  MODELS_JSON_PATH,
  stripJsoncComments,
  stripJsoncTrailingCommas,
  parseJsonc,
  locateModelInJsonc,
  composeFixInsertion,
  selfCheckFix,
  decideFixPlacement,
  chooseFixPlacement,
  findExistingCompatKeysInJsonc,
  deepEqualIgnoringKeys,
  formatCompatKeysForInsertion,
  backupTimestamp,
  // Fix suggestion builder
  buildFixSuggestion,
  // Adaptive thinking compat helpers
  isAdaptiveGenerationModel,
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
  let cacheStatsByModel: Record<string, CacheStats> = {};
  let cacheStatsLegacyFamily: Partial<Record<CacheProviderId, CacheStats>> = emptyAllCacheStats();
  let lastStatusText: string | undefined;
  let persistenceWarningShown = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let integrityNotificationShown = false;
  let currentSessionId = "";
  let currentSessionHash = "";
  let currentSessionHashSet = false;
  let lastActualRoutedModel: PersistedRoutedModelRef | undefined;
  let latestCacheHint: PiCacheHintSnapshot | undefined;
  const PERSIST_DEBOUNCE_MS = 2000;
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

  const uninstallCacheHintsService = installCacheHintsService({
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
  });
  void uninstallCacheHintsService;

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

  function getCacheStatsState(): CacheStatsState {
    return {
      statsByModel: cacheStatsByModel,
      legacyFamily: cacheStatsLegacyFamily,
      ...(currentSessionHashSet && lastActualRoutedModel
        ? { lastRoutedModelBySession: { [currentSessionHash]: lastActualRoutedModel } }
        : {}),
    };
  }

  /** Look up active stats for a model, falling back to legacy family. */
  function getStatsForModel(model: PiModel | undefined, adapter: CacheProviderAdapter): CacheStats {
    if (model) {
      const key = sessionModelKey(model);
      const existing = cacheStatsByModel[key];
      if (existing) return existing;
    }

    // Fallback: legacy family bucket — used when model key is unknown
    // or this model hasn't been seen yet in this session.
    const family = cacheStatsLegacyFamily[adapter.id];
    if (family) return family;

    const created = emptyCacheStats();
    cacheStatsLegacyFamily[adapter.id] = created;
    return created;
  }

  /** Get or create a stats entry for the given model key. */
  function getOrCreateStatsByModelKey(key: string): CacheStats {
    const existing = cacheStatsByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsByModel[key] = created;
    return created;
  }

  function resetStatsForModel(model: PiModel): void {
    const sk = sessionModelKey(model);
    delete cacheStatsByModel[sk];
    recentSamplesByModelKey.delete(sk);
    lastStatusText = undefined;
  }

  function resetCurrentSessionStats(): void {
    const prefix = `${currentSessionHash || "_nosession"}:`;
    for (const key of Object.keys(cacheStatsByModel)) {
      if (key.startsWith(prefix)) delete cacheStatsByModel[key];
    }
    for (const key of Array.from(recentSamplesByModelKey.keys())) {
      if (key.startsWith(prefix)) recentSamplesByModelKey.delete(key);
    }
    lastActualRoutedModel = undefined;
    lastStatusText = undefined;
  }

  async function persistCacheStats(ctx?: ExtensionContext): Promise<void> {
    try {
      await writePersistedCacheStats(getCacheStatsState(), currentSessionHashSet ? currentSessionHash : undefined);
    } catch (error) {
      console.warn(`${LOG_PREFIX}: failed to persist cache stats`, error);
      if (!persistenceWarningShown) {
        persistenceWarningShown = true;
        ctx?.ui.notify(
          `${LOG_PREFIX}: failed to persist footer stats; using in-memory stats for this process.`,
          "warning",
        );
      }
    }
  }

  /** Schedule a debounced persist. Coalesces rapid message_end writes
   *  into a single disk write after PERSIST_DEBOUNCE_MS of silence.
   *  In-memory stats remain instantly up-to-date for the footer; only
   *  the on-disk persistence is delayed. */
  function schedulePersistCacheStats(ctx?: ExtensionContext): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistCacheStats(ctx).catch((err) => {
        console.warn(`${LOG_PREFIX}: debounced persist failed`, err);
      });
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Flush any pending debounced persist immediately (cancels timer + writes).
   *  Used on reload and day-rollover where immediate durability matters. */
  async function flushPersistCacheStats(ctx?: ExtensionContext): Promise<void> {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistCacheStats(ctx);
  }

  async function rollOverStatsIfNeeded(ctx?: ExtensionContext): Promise<void> {
    const day = currentLocalDay();
    let changed = false;

    // Roll over per-model entries.
    for (const key of Object.keys(cacheStatsByModel)) {
      const stats = cacheStatsByModel[key];
      if (stats && stats.day !== day) {
        cacheStatsByModel[key] = emptyCacheStats(day);
        changed = true;
      }
    }

    // Roll over legacy family entries.
    for (const id of CACHE_PROVIDER_IDS) {
      const stats = cacheStatsLegacyFamily[id];
      if (stats && stats.day !== day) {
        cacheStatsLegacyFamily[id] = emptyCacheStats(day);
        changed = true;
      }
    }

    if (changed) {
      lastStatusText = undefined;
      await persistCacheStats(ctx);
    }
  }

  async function restoreCacheStats(reason: string, ctx: ExtensionContext): Promise<void> {
    syncSessionHash(ctx);

    if (reason === "reload") {
      // /reload: preserve session-scoped stats (same session hash).
      // Pi extension reload creates a fresh closure, so cacheStatsByModel
      // starts empty. Read persisted data and filter for current session.
      lastStatusText = undefined;
      lastPromptIntegrityWarningAt = 0;
      integrityNotificationShown = false;
      clearRecentSamples();

      const persisted = await readPersistedCacheStats();
      cacheStatsByModel = filterRestorableStatsForSession(
        persisted,
        currentSessionHashSet ? currentSessionHash : undefined,
      );
      cacheStatsLegacyFamily = persisted?.legacyFamily ?? emptyAllCacheStats();
      lastActualRoutedModel = currentSessionHashSet
        ? persisted?.lastRoutedModelBySession?.[currentSessionHash]
        : undefined;

      await rollOverStatsIfNeeded(ctx);
      return;
    }

    // First load / process start: read persisted stats and filter for
    // this session's entries. If the session hash is unavailable, start
    // fresh instead of loading all persisted session buckets.
    const persisted = await readPersistedCacheStats();
    cacheStatsByModel = filterRestorableStatsForSession(
      persisted,
      currentSessionHashSet ? currentSessionHash : undefined,
    );
    cacheStatsLegacyFamily = persisted?.legacyFamily ?? emptyAllCacheStats();
    lastActualRoutedModel = currentSessionHashSet
      ? persisted?.lastRoutedModelBySession?.[currentSessionHash]
      : undefined;
    lastStatusText = undefined;
    await rollOverStatsIfNeeded(ctx);
  }

  /**
   * Fallback for older persisted files that do not yet carry exact
   * last-routed-model metadata. When the current model is a router channel
   * (e.g. router/auto), restorable stats are stored under the real upstream
   * model's provider/id key, not under router/auto. Find the best valid entry
   * (highest totalRequests among adapter-detectable model keys) so we can show
   * meaningful footer content on session_start after reload.
   */
  function findBestRouterModelStats(): { adapter: CacheProviderAdapter; stats: CacheStats } | undefined {
    if (!currentSessionHash) return undefined;
    const prefix = `${currentSessionHash}:`;
    let best: { adapter: CacheProviderAdapter; stats: CacheStats; total: number } | undefined;

    for (const [key, stats] of Object.entries(cacheStatsByModel)) {
      if (!key.startsWith(prefix)) continue;

      // Extract provider/id from key like "abc123:run-claude/claude-opus-4-8"
      const modelKeyPart = key.slice(prefix.length);
      const slashIdx = modelKeyPart.indexOf("/");
      if (slashIdx < 0 || slashIdx >= modelKeyPart.length - 1) continue;
      const modelId = modelKeyPart.slice(slashIdx + 1);
      const providerName = modelKeyPart.slice(0, slashIdx);

      // Construct a minimal model for adapter detection.
      // Every is*LikeModel function only accesses model.id and model.name
      // via getModelIdNameTokenValues, so { id, name } is sufficient.
      const mockModel = {
        id: modelId,
        name: modelId,
        provider: providerName,
        api: "",
        baseUrl: "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        maxTokens: 0,
      } as PiModel;

      const adapter = selectAdapterForModel(mockModel);
      if (!adapter) continue;

      if (!best || stats.totalRequests > best.total) {
        best = { adapter, stats, total: stats.totalRequests };
      }
    }

    return best ? { adapter: best.adapter, stats: best.stats } : undefined;
  }

  async function publishStatus(ctx: ExtensionContext, model: PiModel | undefined = ctx.model): Promise<void> {
    syncSessionHash(ctx);
    await rollOverStatsIfNeeded(ctx);

    const routedModel = resolveRouteModel(model, ctx);
    const displayModel = routedModel ?? model;
    const adapter = selectAdapterForModel(displayModel);
    const activeIsVirtualRoute = !!routedModel || isVirtualRoutingModel(model, ctx);
    let statusText: string | undefined;

    if (!adapter && !routedModel && activeIsVirtualRoute) {
      // On model_select (existing footer), keep the existing cache footer
      // visible instead of clearing it. On session_start (no footer yet
      // after reload/fresh start), restore the exact last actual routed model
      // for this session when available; fall back to older best-effort
      // heuristics only when no exact metadata exists.
      if (lastStatusText !== undefined) return;
      const realEntry = buildExactRouterStatusEntry(
        currentSessionHashSet ? currentSessionHash : undefined,
        cacheStatsByModel,
        lastActualRoutedModel,
      ) ?? findBestRouterModelStats();
      if (realEntry) {
        const statsText = formatCacheStats(realEntry.adapter, realEntry.stats);
        statusText = runtimeOptimizerEnabled
          ? statsText
          : `Cache Optimizer disabled · ${statsText}`;
      }
    }

    if (adapter) {
      // Display session-scoped stats. A model that has never been used
      // in this session shows 0/0. The message_end hook populates
      // cacheStatsByModel[sessionModelKey(displayModel)] on first use.
      const sk = displayModel ? sessionModelKey(displayModel) : undefined;
      const stats = sk ? cacheStatsByModel[sk] : undefined;
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

    if (statusText === lastStatusText) return;

    lastStatusText = statusText;
    ctx.ui.setStatus(STATUS_KEY, statusText);
  }

  ensureRoutingRegistry();

  // Set of provider/model keys that have explicit supportsLongCacheRetention: true
  // in models.json. Only these models receive prompt_cache_retention in requests.
  // API-logged-in providers (e.g. opencode go) without explicit compat are
  // proactively stripped to prevent 400 errors.
  /**
   * Check whether a model has an EXPLICIT supportsLongCacheRetention config
   * in models.json (either at provider-level or model-level).
   * Returns:
   *   - true if explicitly set to true
   *   - false if explicitly set to false OR not in models.json
   *   - undefined if in models.json but the field is not explicitly set
   *
   * This distinguishes between:
   *   - User explicit opt-in (true) → trust the user, send prompt_cache_retention
   *   - User explicit opt-out (false) → strip
   *   - No explicit config (undefined/false) → strip (safe default)
   */
  function hasExplicitLongRetentionOptIn(model: PiModel): boolean {
    try {
      const text = readFileSync(MODELS_JSON_PATH, "utf8");
      const parsed = parseJsonc(text);
      const providers = asRecord(asRecord(parsed)?.providers);
      if (!providers) return false;

      const prov = asRecord(providers[model.provider]);
      if (!prov) return false;  // Not in models.json

      // Check model-level first (higher priority in Pi's merge logic)
      const models = prov.models;
      if (Array.isArray(models)) {
        const modelEntry = models.find(m => asRecord(m)?.id === model.id);
        if (modelEntry) {
          const modelCompat = asRecord(asRecord(modelEntry)?.compat);
          if (modelCompat?.supportsLongCacheRetention !== undefined) {
            return modelCompat.supportsLongCacheRetention === true;
          }
        }
      }

      // Check provider-level
      const provCompat = asRecord(prov.compat);
      if (provCompat?.supportsLongCacheRetention !== undefined) {
        return provCompat.supportsLongCacheRetention === true;
      }

      return false;  // In models.json but no explicit supportsLongCacheRetention
    } catch {
      return false;  // File missing/unreadable → safe default
    }
  }

  pi.on("session_start", async (event, ctx) => {
    await restoreCacheStats(event.reason, ctx);
    await publishStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    if (runtimeOptimizerEnabled) notifyCacheCompatIfNeeded(resolveRouteModel(event.model, ctx) ?? event.model, ctx, warnedModels);
    await publishStatus(ctx, event.model);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    latestCacheHint = undefined;
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

    if (!runtimeOptimizerEnabled) return {};

    // Global opt-out: PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1 bypasses all
    // prompt mutations below (session-overview churn strip, skill compression,
    // and stable-prefix reordering). Footer stats and the OpenAI
    // prompt_cache_key fallback remain active.
    if (isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV])) {
      return {};
    }

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
      globals.__piCacheOptimizerCacheKey__ = promptCacheKey;
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

  pi.on("before_provider_request", (event, ctx) => {
    // ── Safety: strip prompt_cache_retention from payload for models that
    // do NOT have an explicit supportsLongCacheRetention: true opt-in in
    // models.json. This prevents 400 errors from third-party OpenAI-compatible
    // APIs that don't support the parameter.
    //
    // Only official OpenAI or models with explicit user opt-in are allowed
    // to send prompt_cache_retention.
    if (runtimeOptimizerEnabled) {
      const payload = event.payload as UnknownRecord;
      if (payload && typeof payload.prompt_cache_retention === 'string') {
        const rModel = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
        if (rModel) {
          // Gate 1: Official OpenAI → always keep
          if (isOfficialOpenAIBaseUrl(rModel)) {
            // keep
          }
          // Gate 2: Explicit user opt-in (models.json has supportsLongCacheRetention: true) → keep
          else if (hasExplicitLongRetentionOptIn(rModel)) {
            // keep (user explicitly wants it)
          }
          // Gate 3: 400 history → strip (even if user opted in, API doesn't support it)
          else if (promptCacheRetention400Models.has(modelKey(rModel))) {
            delete payload.prompt_cache_retention;
          }
          // Gate 4: All other cases → strip (safe default for third-party APIs)
          else {
            delete payload.prompt_cache_retention;
          }
        }
      }
    }

    if (!shouldInjectOpenAIPromptCacheKey()) return undefined;
    const requestModel = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
    if (!isOpenAICompatibleApi(requestModel?.api)) return undefined;

    return addOpenAIPromptCacheKey(event.payload, getSessionPromptCacheKey(ctx));
  });

  pi.on("after_provider_response", (event, ctx) => {
    const model = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
    if (!runtimeOptimizerEnabled || !model) return;
    if (event.status !== 400) return;
    if (!isPromptCacheRetention400Applicable(model)) return;
    if (!hasPromptCacheRetentionUnsupportedSignal(event.headers)) return;

    const key = modelKey(model);
    promptCacheRetention400Models.add(key);
    if (warnedPromptCacheRetention400Models.has(key)) return;
    warnedPromptCacheRetention400Models.add(key);
    ctx.ui.notify(
      `⚠️ ${LOG_PREFIX}: ${key} returned HTTP 400 while supportsLongCacheRetention is enabled. ` +
      getPromptCacheRetentionUnsupportedHint() +
      ` Run /cache-optimizer doctor for the exact edit location.`,
      "warning",
    );
  });

  pi.on("message_end", async (event, ctx) => {
    syncSessionHash(ctx);
    const adapter = selectAdapterForAssistantMessage(event.message, ctx.model);
    if (!adapter) return;

    const usage = adapter.normalizeUsage(event.message);

    // Completed message metadata is request-local and authoritative for virtual
    // routing providers. Use it whenever it supplies provider/model identity;
    // fall back to the active context model for direct providers.
    const statsModel = modelFromAssistantMessage(event.message, ctx.model) ?? ctx.model;
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

    // Update stats scoped to current session + actual routed model.
    // Falls back to legacy family when no model is available.
    if (statsModel) {
      const sk = sessionModelKey(statsModel);
      addUsageToCacheStats(getOrCreateStatsByModelKey(sk), usage);
    } else {
      addUsageToCacheStats(getStatsForModel(undefined, adapter), usage);
    }

    schedulePersistCacheStats(ctx);
    await publishStatus(ctx, statsModel);
  });

  // ────────────────────────────────────────────────────────────────
  // Register /cache-optimizer command
  // Subcommands:
  //   enable  — enable runtime prompt/cache optimizations for this process
  //   disable — disable runtime prompt/cache optimizations for this process
  //   doctor  — show current model/provider/api/baseUrl/compat status
  //             with low-hit diagnosis
  //   stats   — show active model stats bucket, recent trend, usage
  //   compat  — show compat suggestion with file path
  //   fix     — auto-fix compat issues (writes models.json, requires UI)
  //   reset   — reset current session model stats bucket (local only)
  //   (no args) — interactive menu (with UI) or help summary
  // ────────────────────────────────────────────────────────────────
  pi.registerCommand("cache-optimizer", {
    description: "Diagnose Pi cache configuration",
    handler: async (args: string, cmdCtx) => {
      syncSessionHash(cmdCtx);
      const selectedModel = cmdCtx.model;
      const model = resolveRouteModel(selectedModel, cmdCtx as unknown as ExtensionContext) ?? selectedModel;
      const subcommand = args.trim().toLowerCase().split(/\s+/)[0] || "help";

      if (subcommand === "enable") {
        setRuntimeOptimizerEnabled(true);
        resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx as unknown as ExtensionContext);
        await publishStatus(cmdCtx as unknown as ExtensionContext, model);
        cmdCtx.ui.notify(`✅ Pi Cache Optimizer enabled for this Pi process. Current-session stats were reset for before/after comparison.\n${formatOptimizerRuntimeMode()}`, "info");
      } else if (subcommand === "disable") {
        setRuntimeOptimizerEnabled(false);
        resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx as unknown as ExtensionContext);
        await publishStatus(cmdCtx as unknown as ExtensionContext, model);
        cmdCtx.ui.notify(`⏸️ Pi Cache Optimizer disabled for this Pi process. Current-session stats were reset and will keep collecting while disabled for comparison.\n${formatOptimizerRuntimeMode()}`, "warning");
      } else if (subcommand === "doctor") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const diagnosis = buildDoctorDiagnosis(model, { promptCacheRetention400: promptCacheRetention400Models.has(modelKey(model)) });
        const adapter = selectAdapterForModel(model);
        const sk = model ? sessionModelKey(model) : undefined;
        const statsState = sk ? cacheStatsByModel[sk] : undefined;
        const samples = sk ? getRecentSamples(sk) : [];
        const lowHitLines = buildLowHitDiagnosis(model, adapter, statsState, samples);
        const fullDiagnosis = lowHitLines.length > 0
          ? diagnosis + "\n" + lowHitLines.join("\n")
          : diagnosis;
        cmdCtx.ui.notify(fullDiagnosis, "info");
      } else if (subcommand === "stats") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const adapter = selectAdapterForModel(model);
        const sk = model ? sessionModelKey(model) : undefined;
        const statsState = sk ? cacheStatsByModel[sk] : undefined;
        const samples = sk ? getRecentSamples(sk) : [];
        const output = buildStatsOutput(model, adapter, statsState, samples);
        cmdCtx.ui.notify(output, "info");
      } else if (subcommand === "compat") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const compatResult = buildCompatDiagnosis(model);
        if (compatResult) {
          cmdCtx.ui.notify(compatResult, "warning");
        } else {
          cmdCtx.ui.notify(
            isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)
              ? "✅ Compat fully configured."
              : getCompatCheckNotApplicableLines(model).join("\n"),
            "info",
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

        // Reset session-scoped stats for the effective active model. If the
        // selected model is a virtual router and the protocol exposes a live
        // route, this clears the real upstream bucket, not the router shell.
        resetStatsForModel(model);

        // Persist immediately.
        await flushPersistCacheStats(cmdCtx as unknown as ExtensionContext);

        // Update footer to show 0/0.
        await publishStatus(cmdCtx as unknown as ExtensionContext, model);

        cmdCtx.ui.notify(
          `✅ Reset local session cache stats for "${displayKey}". ` +
          "Upstream provider prompt cache was not modified. " +
          "New requests will start a fresh stats bucket for this Pi session.",
          "info",
        );
      } else if (subcommand === "fix") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }

        let suggestion = buildFixSuggestion(model);

        // If no regular missing compat flags but the model has a recorded
        // prompt_cache_retention 400 (Pi sent `prompt_cache_retention` and
        // the provider rejected it), offer to override
        // `supportsLongCacheRetention` to false in models.json.
        if (!suggestion && isPromptCacheRetention400Applicable(model) && promptCacheRetention400Models.has(modelKey(model))) {
          const key = modelKey(model);
          const slashIdx = key.indexOf("/");
          const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
          suggestion = {
            providerLabel,
            modelId: model.id,
            compatKeys: { supportsLongCacheRetention: false },
          };
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
          manualLines.push(
            "",
            "If the provider/model already exists in models.json, add these compat keys under",
            `providers["${suggestion.providerLabel}"] -> models -> entry with id "${suggestion.modelId}" -> compat:`,
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
          if (diagnosis && cmdCtx.hasUI) {
            // Offer to create the missing entry.
            const plan = composeMissingEntryInsertion(
              originalText, diagnosis,
              suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
            );
            const checkError = selfCheckMissingEntryInsertion(
              originalText, plan.modifiedText,
              suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
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
                `  1. This creates a new entry in models.json. Existing auth (e.g. login API tokens) is not affected.`,
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
              const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Fix (new entry)", previewLines.join("\n"));
              if (confirmed) {
                try {
                  await copyFile(MODELS_JSON_PATH, backupPath);
                  const tempPath = `${MODELS_JSON_PATH}.${process.pid}.${Date.now()}.fix.tmp`;
                  await writeFile(tempPath, plan.modifiedText, "utf8");
                  await rename(tempPath, MODELS_JSON_PATH);

                  const writtenText = await readFile(MODELS_JSON_PATH, "utf8");
                  const postErr = selfCheckMissingEntryInsertion(
                    originalText, writtenText,
                    suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
                  );
                  if (postErr !== null) {
                    await copyFile(backupPath, MODELS_JSON_PATH);
                    cmdCtx.ui.notify(
                      `❌ Post-write self-check failed: ${postErr}\n` +
                      `The backup at ${backupPath} has been restored. No changes applied.`,
                      "error",
                    );
                    return;
                  }
                  cmdCtx.ui.notify(
                    `✅ Fix applied to ${getModelsJsonDisplayPath()}.\n` +
                    `Backup saved to: ${backupPath}\n` +
                    `Run /reload or restart Pi for the change to take effect.`,
                    "info",
                  );
                } catch (e) {
                  cmdCtx.ui.notify(
                    `❌ Write failed: ${e instanceof Error ? e.message : String(e)}`,
                    "error",
                  );
                }
                return;
              }
              cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
              return;
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
              "entries in models.json. You can create a minimal compat-only entry by hand:",
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
              "Add the following entry to the models array (keep existing auth):",
            );
          }
          adviceLines.push("", snippet, "", "Then save and run /reload.");
          cmdCtx.ui.notify(adviceLines.join("\n"), "warning");
          return;
        }

        // Compose the modified text — auto-detect the best placement level:
        // provider level (channel-wide) when safe for all sibling models, else model level.
        const decision = chooseFixPlacement(originalText, location, suggestion.compatKeys, suggestion.providerLabel);
        const modifiedText = composeFixInsertion(originalText, location, suggestion.compatKeys, decision.placement);

        // Self-check
        const checkError = selfCheckFix(originalText, modifiedText, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys);
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
        const targetHasCompat = decision.placement === "provider" ? location.providerCompatBrace >= 0 : location.compatObjectBrace >= 0;
        const placementDesc = targetHasCompat ? `existing "compat" object` : `new "compat" object`;
        const locationDesc = decision.placement === "provider"
          ? `providers["${suggestion.providerLabel}"] -> compat (provider level, ${placementDesc})`
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
          // Backup
          await copyFile(MODELS_JSON_PATH, backupPath);

          // Atomic write
          const tempPath = `${MODELS_JSON_PATH}.${process.pid}.${Date.now()}.fix.tmp`;
          await writeFile(tempPath, modifiedText, "utf8");
          await rename(tempPath, MODELS_JSON_PATH);

          // Post-write self-check (read back)
          const writtenText = await readFile(MODELS_JSON_PATH, "utf8");
          const postCheckError = selfCheckFix(originalText, writtenText, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys);
          if (postCheckError !== null) {
            // Restore from backup
            await copyFile(backupPath, MODELS_JSON_PATH);
            cmdCtx.ui.notify(
              `❌ Post-write self-check failed: ${postCheckError}\n` +
              `The backup at ${backupPath} has been restored. No changes applied.`,
              "error",
            );
            return;
          }

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
            "Stats — Show cache stats and trend",
            "Compat — Show compat suggestion",
            "Fix — Auto-fix compat issues (writes models.json)",
            "Reset — Reset local session stats",
            "Cancel",
          ];
          const choice = await cmdCtx.ui.select("Cache Optimizer", menuOptions);
          if (choice === menuOptions[0]) {
            setRuntimeOptimizerEnabled(true);
            resetCurrentSessionStats();
            await flushPersistCacheStats(cmdCtx as unknown as ExtensionContext);
            await publishStatus(cmdCtx as unknown as ExtensionContext, model);
            cmdCtx.ui.notify(`✅ Pi Cache Optimizer enabled for this Pi process. Current-session stats were reset for before/after comparison.\n${formatOptimizerRuntimeMode()}`, "info");
          } else if (choice === menuOptions[1]) {
            setRuntimeOptimizerEnabled(false);
            resetCurrentSessionStats();
            await flushPersistCacheStats(cmdCtx as unknown as ExtensionContext);
            await publishStatus(cmdCtx as unknown as ExtensionContext, model);
            cmdCtx.ui.notify(`⏸️ Pi Cache Optimizer disabled for this Pi process. Current-session stats were reset and will keep collecting while disabled for comparison.\n${formatOptimizerRuntimeMode()}`, "warning");
          } else if (choice === menuOptions[2]) {
            if (!model) {
              cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
            } else {
              const diagnosis = buildDoctorDiagnosis(model, { promptCacheRetention400: promptCacheRetention400Models.has(modelKey(model)) });
              const adapter = selectAdapterForModel(model);
              const sk = model ? sessionModelKey(model) : undefined;
              const statsState = sk ? cacheStatsByModel[sk] : undefined;
              const samples = sk ? getRecentSamples(sk) : [];
              const lowHitLines = buildLowHitDiagnosis(model, adapter, statsState, samples);
              const fullDiagnosis = lowHitLines.length > 0
                ? diagnosis + "\n" + lowHitLines.join("\n")
                : diagnosis;
              cmdCtx.ui.notify(fullDiagnosis, "info");
            }
          } else if (choice === menuOptions[3]) {
            if (!model) {
              cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
            } else {
              const adapter = selectAdapterForModel(model);
              const sk = model ? sessionModelKey(model) : undefined;
              const statsState = sk ? cacheStatsByModel[sk] : undefined;
              const samples = sk ? getRecentSamples(sk) : [];
              const output = buildStatsOutput(model, adapter, statsState, samples);
              cmdCtx.ui.notify(output, "info");
            }
          } else if (choice === menuOptions[4]) {
            if (!model) {
              cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
            } else {
              const compatResult = buildCompatDiagnosis(model);
              if (compatResult) {
                cmdCtx.ui.notify(compatResult, "warning");
              } else {
                cmdCtx.ui.notify(
                  isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)
                    ? "✅ Compat fully configured."
                    : getCompatCheckNotApplicableLines(model).join("\n"),
                  "info",
                );
              }
            }
          } else if (choice === menuOptions[5]) {
            // Fix — auto-fix compat issues
            if (!model) {
              cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
              return;
            }
            const suggestion = buildFixSuggestion(model);
            if (!suggestion) {
              const key = modelKey(model);
              cmdCtx.ui.notify(`✅ Nothing to fix for "${key}". Compat already configured.`, "info");
              return;
            }

            // Read models.json
            let originalText: string;
            try {
              originalText = await readFile(MODELS_JSON_PATH, "utf8");
            } catch {
              cmdCtx.ui.notify(`❌ Could not read ${MODELS_JSON_PATH}. File may not exist.`, "error");
              return;
            }

            const location = locateModelInJsonc(originalText, suggestion.providerLabel, suggestion.modelId);
            if (!location) {
              cmdCtx.ui.notify(
                `❌ Could not locate model "${suggestion.modelId}" in ${getModelsJsonDisplayPath()}.\n` +
                `Manual edit required: open the file and add:\n` +
                `${formatCompatKeysForInsertion(suggestion.compatKeys)}\n` +
                `Then run /reload.`,
                "warning",
              );
              return;
            }

            const menuDecision = chooseFixPlacement(originalText, location, suggestion.compatKeys, suggestion.providerLabel);
            const modifiedText = composeFixInsertion(originalText, location, suggestion.compatKeys, menuDecision.placement);
            const checkError = selfCheckFix(originalText, modifiedText, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys);
            if (checkError !== null) {
              cmdCtx.ui.notify(`❌ Self-check failed: ${checkError}\nNo changes made.`, "error");
              return;
            }

            const keysPreview = JSON.stringify(suggestion.compatKeys, null, 2);
            const ts = backupTimestamp();
            const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${ts}`;

            const menuLocationDesc = menuDecision.placement === "provider"
              ? `providers["${suggestion.providerLabel}"] -> compat (provider level)`
              : `providers["${suggestion.providerLabel}"] -> models -> "${suggestion.modelId}" -> compat (model level)`;
            const menuScopeRiskLine = menuDecision.placement === "provider"
              ? `  1. This change applies to ALL ${location.allModelIds.length || 1} model(s) in the "${suggestion.providerLabel}" provider, across all sessions.`
              : `  1. This change affects ALL sessions using the "${suggestion.providerLabel}" provider/channel (scoped to model "${suggestion.modelId}").`;

            const previewLines = [
              `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
              `Location: ${menuLocationDesc}`,
              `Placement: ${menuDecision.placement} level — ${menuDecision.reason}`,
              `Compat JSON to write:`,
              keysPreview,
              ``,
              `⚠️  Risk notice:`,
              menuScopeRiskLine,
              `  2. A timestamped backup will be written to: ${backupPath}`,
              `  3. You must restart Pi / run /reload for the change to take effect.`,
              `  4. If the file contains comments, verify the result after write.`,
              ``,
              `Apply these changes?`,
            ];

            const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Fix", previewLines.join("\n"));
            if (!confirmed) {
              cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
              return;
            }

            try {
              await copyFile(MODELS_JSON_PATH, backupPath);
              const tempPath = `${MODELS_JSON_PATH}.${process.pid}.${Date.now()}.fix.tmp`;
              await writeFile(tempPath, modifiedText, "utf8");
              await rename(tempPath, MODELS_JSON_PATH);

              const writtenText = await readFile(MODELS_JSON_PATH, "utf8");
              const postCheck = selfCheckFix(originalText, writtenText, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys);
              if (postCheck !== null) {
                await copyFile(backupPath, MODELS_JSON_PATH);
                cmdCtx.ui.notify(`❌ Post-write check failed: ${postCheck}\nBackup restored.`, "error");
                return;
              }

              cmdCtx.ui.notify(
                `✅ Fix applied to ${getModelsJsonDisplayPath()}.` +
                `\nBackup: ${backupPath}` +
                `\nRun /reload or restart Pi for the change to take effect.`,
                "info",
              );
            } catch (writeError) {
              cmdCtx.ui.notify(
                `❌ Write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
                "error",
              );
            }
          } else if (choice === menuOptions[6]) {
            if (!model) {
              cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
            } else {
              const adapter = selectAdapterForModel(model);
              if (!adapter) {
                cmdCtx.ui.notify("ℹ️ Active model does not match a cache adapter. No stats to reset.", "info");
              } else {
                const displayKey = modelKey(model);
                resetStatsForModel(model);
                await flushPersistCacheStats(cmdCtx as unknown as ExtensionContext);
                await publishStatus(cmdCtx as unknown as ExtensionContext, model);
                cmdCtx.ui.notify(
                  `✅ Reset local session cache stats for "${displayKey}". ` +
                  "Upstream provider prompt cache was not modified.",
                  "info",
                );
              }
            }
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
        diagnosis.push("  stats   — Show active model stats bucket and recent trend");
        diagnosis.push("  compat  — Show compat suggestion with edit location");
        diagnosis.push("  fix     — Auto-fix compat issues (writes models.json, requires UI)");
        diagnosis.push("  reset   — Reset local session stats for current model (does not affect upstream)");
        diagnosis.push("");
        diagnosis.push(formatOptimizerRuntimeMode());
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
    },
  });
}
