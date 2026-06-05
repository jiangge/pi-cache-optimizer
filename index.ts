import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
type CacheStatsState = {
  statsByModel: Record<string, CacheStats>;
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
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

function getCompat(model: PiModel | undefined): CacheCompat {
  return (model?.compat ?? {}) as CacheCompat;
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

function isNonEmptyString(value: unknown): boolean {
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
  if (lower(model.api) !== "openai-completions") return missing;
  if (isOfficialOpenAIBaseUrl(model)) return missing;

  if (compat.supportsLongCacheRetention !== true) {
    missing.push("supportsLongCacheRetention");
  }
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

  if (lower(model.api) !== "openai-completions") return missing;
  if (isOfficialOpenAIBaseUrl(model)) return missing;

  if (compat.supportsLongCacheRetention !== true) {
    missing.push("supportsLongCacheRetention");
  }
  if (compat.sendSessionAffinityHeaders !== true) {
    missing.push("sendSessionAffinityHeaders");
  }

  return missing;
}

function buildSafeOpenAIProxyCompatSuggestion(missing: string[]): Record<string, boolean> {
  const suggestion: Record<string, boolean> = {};
  if (missing.includes("sendSessionAffinityHeaders")) {
    suggestion.sendSessionAffinityHeaders = true;
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
  } else if (missing.includes("supportsLongCacheRetention")) {
    lines.push("No safe automatic JSON change is recommended for `supportsLongCacheRetention`.");
  }

  if (missing.includes("sendSessionAffinityHeaders")) {
    lines.push("- sendSessionAffinityHeaders: recommended for third-party proxies when supported; it helps keep one Pi session on the same upstream/backend.");
  }
  if (missing.includes("supportsLongCacheRetention")) {
    lines.push("- supportsLongCacheRetention: optional. Enable only after your endpoint/proxy explicitly supports OpenAI long prompt cache retention.");
    lines.push(`- ${getPromptCacheRetentionUnsupportedHint()}`);
  }

  appendCredentialSafeProviderGuidance(lines, options, suggestion);
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

function parsePersistedCacheStats(value: unknown): CacheStatsState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  // version 4: session-scoped stats + legacy family fallback
  if (record.version === 4) {
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

    return { statsByModel, legacyFamily };
  }

  // version 3: migrate to v4 semantics by wrapping statsByModel into sessions
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

async function writePersistedCacheStats(state: CacheStatsState, currentSessionHash?: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });

  // Read existing file to preserve other sessions' data.
  let existingSessions: Record<string, Record<string, CacheStats>> = {};
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
    }
  } catch {
    // Ignore read errors (file may not exist yet).
  }

  const sessions = mergeCacheSessions(existingSessions, state, currentSessionHash);

  const payload: PersistedCacheStatsV4 = {
    version: 4,
    sessions,
    legacyFamily: state.legacyFamily,
  };
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, STATE_FILE_PATH);
}



function isCompatCheckApplicable(model: PiModel): boolean {
  return lower(model.api) === "openai-completions" && !isOfficialOpenAIBaseUrl(model);
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

  // Only OpenAI-compatible APIs are applicable for router/channel diagnostics.
  // Custom transports like kiro-api, anthropic-messages, bedrock-converse-stream
  // or non-OpenAI APIs are excluded.
  if (api !== "openai-completions" && api !== "openai-responses") {
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
    const hasOnly = !!(compat as Record<string, unknown>)["openRouterRouting"]?.only;
    const hasOrder = !!(compat as Record<string, unknown>)["openRouterRouting"]?.order;

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
    const hasOnly = !!(compat as Record<string, unknown>)["vercelGatewayRouting"]?.only;
    const hasOrder = !!(compat as Record<string, unknown>)["vercelGatewayRouting"]?.order;

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

function buildDoctorDiagnosis(model: PiModel, options: { promptCacheRetention400?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Provider: ${model.provider}`);
  lines.push(`Model:    ${model.id}`);
  if (model.name && model.name !== model.id) lines.push(`Name:     ${model.name}`);
  lines.push(`API:      ${model.api}`);
  lines.push(`Base URL: ${model.baseUrl || "(default)"}`);

  const compat = getCompat(model);
  lines.push(`Compat:   ${JSON.stringify(compat)}`);

  const deepSeekCompatApplicable = isDeepSeekCompatCheckApplicable(model);
  const missing = describeMissingCacheCompatForModel(model);
  if (missing.length > 0) {
    lines.push(`⚠️  Missing compat flags: ${missing.join(", ")}`);
    const key = modelKey(model);
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    const modelsJsonPath = getModelsJsonDisplayPath();
    lines.push(`Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (same level as baseUrl/api/apiKey/models).`);
    if (deepSeekCompatApplicable) {
      appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
    } else {
      appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
    }
  } else if (deepSeekCompatApplicable || isCompatCheckApplicable(model)) {
    lines.push("✅ Compat fully configured.");
  } else {
    lines.push("ℹ️ Compat check not applicable for this model.");
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
  const missingCompat = describeMissingCacheCompatForModel(model);

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

  const hasMissingCompat = missingCompat.length > 0;
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
    lines.push(`⚠️  Missing compat flags: ${missingCompat.join(", ")}`);
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
  const deepSeekCompatApplicable = isDeepSeekCompatCheckApplicable(model);
  const routerNotes = describeRouterChannelDiagnostics(model);

  if (missing.length === 0 && routerNotes.length === 0) return undefined;

  const key = modelKey(model);
  const lines: string[] = [];

  if (missing.length > 0) {
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    const modelsJsonPath = getModelsJsonDisplayPath();
    lines.push(`Active model: ${key}`);
    lines.push(`Missing: ${missing.join(", ")}`);
    lines.push("");
    lines.push(`Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat`);
    lines.push(`(at the same level as baseUrl/api/apiKey/models).`);
    if (deepSeekCompatApplicable) {
      appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
    } else {
      appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
    }
  }

  // When compat is fully configured but router notes exist, prefix the status.
  if (routerNotes.length > 0 && missing.length === 0) {
    if (deepSeekCompatApplicable || isCompatCheckApplicable(model)) {
      lines.push("✅ Compat fully configured.");
      if (isPromptCacheRetention400Applicable(model)) {
        lines.push(getPromptCacheRetentionUnsupportedHint());
      }
    } else {
      lines.push("ℹ️ Compat check not applicable for this model.");
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
  isOpenAIFamilyModel,
  isOpenAIFamilyAssistantMessage,
  isOpenAIFamilyToken,
  describeMissingOpenAIFamilyProxyCompat,
  describeMissingOpenAICompatibleProxyCompat,
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
  isCompatCheckApplicable,
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
  // Persistence helpers (for reload/reset tests)
  mergeCacheSessions,
  writePersistedCacheStats,
  readPersistedCacheStats,
  STATE_FILE_PATH,
  LEGACY_STATE_FILE_PATH,
  STATE_DIR,
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
  const PERSIST_DEBOUNCE_MS = 2000;
  /** In-memory recent usage samples per model key (not persisted, cleared on reload). */
  const recentSamplesByModelKey = new Map<string, CacheUsageSample[]>();

  function syncSessionHash(ctx: Pick<ExtensionContext, "sessionManager">): void {
    const sid = ctx.sessionManager.getSessionId();
    if (sid && (sid !== currentSessionId || !currentSessionHashSet)) {
      currentSessionId = sid;
      currentSessionHash = hashSessionId(sid);
      currentSessionHashSet = true;
    }
  }

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
    return { statsByModel: cacheStatsByModel, legacyFamily: cacheStatsLegacyFamily };
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

  function resetCurrentSessionStats(): void {
    const prefix = `${currentSessionHash || "_nosession"}:`;
    for (const key of Object.keys(cacheStatsByModel)) {
      if (key.startsWith(prefix)) delete cacheStatsByModel[key];
    }
    for (const key of Array.from(recentSamplesByModelKey.keys())) {
      if (key.startsWith(prefix)) recentSamplesByModelKey.delete(key);
    }
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
    lastStatusText = undefined;
    await rollOverStatsIfNeeded(ctx);
  }

  async function publishStatus(ctx: ExtensionContext, model: PiModel | undefined = ctx.model): Promise<void> {
    syncSessionHash(ctx);
    await rollOverStatsIfNeeded(ctx);

    const adapter = selectAdapterForModel(model);
    let statusText: string | undefined;
    if (adapter) {
      // Display session-scoped stats. A model that has never been used
      // in this session shows 0/0. The message_end hook populates
      // cacheStatsByModel[sessionModelKey(model)] on first use.
      const sk = model ? sessionModelKey(model) : undefined;
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
    if (runtimeOptimizerEnabled && statusText !== undefined && model) {
      const compatMissing = describeMissingCacheCompatForModel(model);
      if (compatMissing.length > 0) {
        statusText = statusText + " ⚠️ compat";
      }
    }

    if (statusText === lastStatusText) return;

    lastStatusText = statusText;
    ctx.ui.setStatus(STATUS_KEY, statusText);
  }

  pi.on("session_start", async (event, ctx) => {
    await restoreCacheStats(event.reason, ctx);
    if (runtimeOptimizerEnabled) notifyCacheCompatIfNeeded(ctx.model, ctx, warnedModels);
    await publishStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    if (runtimeOptimizerEnabled) notifyCacheCompatIfNeeded(event.model, ctx, warnedModels);
    await publishStatus(ctx, event.model);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    // ────────────────────────────────────────────────────────────────
    // OpenAI Responses API bypass (codex-responses + responses)
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
    const model = _ctx.model;
    if (model) {
      const api = lower(model.api);
      if (api === "openai-codex-responses" || api === "openai-responses") {
        return {};
      }
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

    if (optimized.changed && optimized.systemPrompt.trim().length > 0) {
      return { systemPrompt: optimized.systemPrompt };
    }

    // Reorder didn't apply but compression might have. Return the
    // compressed (or stripped) prompt directly so we still benefit from
    // the volume cut even when reorder is a no-op (e.g., short sessions
    // where no stable candidate is long enough).
    if (compressedPrompt !== strippedPrompt && compressedPrompt.trim().length > 0) {
      return { systemPrompt: compressedPrompt };
    }
    if (strippedPrompt !== event.systemPrompt && strippedPrompt.trim().length > 0) {
      return { systemPrompt: strippedPrompt };
    }

    return {};
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!shouldInjectOpenAIPromptCacheKey()) return undefined;
    if (!isOpenAICompatibleApi(ctx.model?.api)) return undefined;

    return addOpenAIPromptCacheKey(event.payload, getSessionPromptCacheKey(ctx));
  });

  pi.on("after_provider_response", (event, ctx) => {
    const model = ctx.model;
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

    // Record recent sample (even when usage is missing, for trend diagnosis)
    if (ctx.model) {
      const sk = sessionModelKey(ctx.model);
      const missingFields = usage === undefined || (usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.totalInput === 0)
        ? true
        : hasMissingUsageFields(event.message, adapter);
      recordRecentSample(sk, usage ?? { cacheRead: 0, cacheWrite: 0, totalInput: 0 }, missingFields);
    }

    if (!usage) return;

    await rollOverStatsIfNeeded(ctx);

    // Update stats scoped to current session + active model.
    // Falls back to legacy family when ctx.model is undefined.
    if (ctx.model) {
      const sk = sessionModelKey(ctx.model);
      addUsageToCacheStats(getOrCreateStatsByModelKey(sk), usage);
    } else {
      addUsageToCacheStats(getStatsForModel(undefined, adapter), usage);
    }

    schedulePersistCacheStats(ctx);
    await publishStatus(ctx);
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
  //   reset   — reset current session model stats bucket (local only)
  //   (no args) — interactive menu (with UI) or help summary
  // ────────────────────────────────────────────────────────────────
  pi.registerCommand("cache-optimizer", {
    description: "Diagnose Pi cache configuration",
    handler: async (args: string, cmdCtx) => {
      syncSessionHash(cmdCtx);
      const model = cmdCtx.model;
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
            isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)
              ? "✅ Compat fully configured."
              : "ℹ️ Compat check not applicable for this model.",
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

        const sk = sessionModelKey(model);
        const displayKey = modelKey(model);

        // Reset session-scoped stats for the active model.
        delete cacheStatsByModel[sk];

        // Clear recent samples for this session+model key.
        recentSamplesByModelKey.delete(sk);

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
      } else {
        // Try interactive selection menu when UI supports it
        if (cmdCtx.hasUI) {
          const menuOptions = [
            "Enable — Turn on runtime optimizations",
            "Disable — Turn off runtime optimizations",
            "Doctor — Show cache configuration",
            "Stats — Show cache stats and trend",
            "Compat — Show compat suggestion",
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
                  isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)
                    ? "✅ Compat fully configured."
                    : "ℹ️ Compat check not applicable for this model.",
                  "info",
                );
              }
            }
          } else if (choice === menuOptions[5]) {
            if (!model) {
              cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
            } else {
              const adapter = selectAdapterForModel(model);
              if (!adapter) {
                cmdCtx.ui.notify("ℹ️ Active model does not match a cache adapter. No stats to reset.", "info");
              } else {
                const sk = sessionModelKey(model);
                const displayKey = modelKey(model);
                delete cacheStatsByModel[sk];
                recentSamplesByModelKey.delete(sk);
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
          } else if (isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)) {
            diagnosis.push(`✅ Active model "${displayKey}": compat fully configured.`);
          } else {
            diagnosis.push(`ℹ️ Active model "${displayKey}": compat check not applicable.`);
          }
        } else {
          diagnosis.push("No active model selected.");
        }
        cmdCtx.ui.notify(diagnosis.join("\n"), "info");
      }
    },
  });
}
