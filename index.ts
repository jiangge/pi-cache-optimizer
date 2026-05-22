import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
// ============================================================
if (!process.env.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION !== "long") {
  process.env.PI_CACHE_RETENTION = "long";
}

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

// WORM-flag: if optimizeSystemPrompt ever detects that its blind-replace
// logic has accidentally truncated a structural marker (any XML tag or
// HTML comment boundary marker present in the original prompt), we flip
// this. publishStatus reads it once, appends a footer warning, then
// resets it. The flag surface is kept separate from the regular
// cache-stats counter so that a one-turn glitch doesn't poison the
// persisted metrics.
let promptTruncationDetected = false;

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

type OptimizedSystemPrompt = {
  systemPrompt: string;
  stablePrefix: string;
  changed: boolean;
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
  if (isEnabledEnv(process.env[NO_OPENAI_CACHE_KEY_ENV])) return false;
  if (isDisabledEnv(process.env[OPENAI_CACHE_KEY_ENV])) return false;
  return true;
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
  if (!value) return false;

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
  if (model.api !== "openai-completions") return missing;
  if (isOfficialOpenAIBaseUrl(model)) return missing;

  if (compat.supportsLongCacheRetention !== true) {
    missing.push("supportsLongCacheRetention");
  }
  if (compat.sendSessionAffinityHeaders !== true) {
    missing.push("sendSessionAffinityHeaders");
  }

  return missing;
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
        `💡 pi-cache-optimizer: ${key} is DeepSeek-like but merged compat lacks ${missing.join(" and ")}. ` +
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
    warningText(model) {
      const missing = describeMissingOpenAIFamilyProxyCompat(model);
      if (missing.length === 0) return undefined;

      return (
        `💡 pi-cache-optimizer: ${modelKey(model)} looks like a third-party GPT/OpenAI-compatible proxy but merged compat lacks ${missing.join(" and ")}. ` +
        `For better cache locality, add compat: { "supportsLongCacheRetention": true, "sendSessionAffinityHeaders": true } in ~/.pi/agent/models.json when the endpoint supports these fields.`
      );
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

async function writePersistedCacheStats(statsByProvider: Partial<Record<CacheProviderId, CacheStats>>): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const payload: PersistedCacheStatsV2 = { version: 2, statsByProvider };
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, STATE_FILE_PATH);
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
  isOfficialOpenAIBaseUrl,
  getModelIdNameTokenValues,
  getAssistantMessageModelTokenValues,
  getCompat,
  modelKey,
};

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
    let statusText: string | undefined = adapter ? formatCacheStats(adapter, getStatsForAdapter(adapter)) : undefined;

    // If optimizeSystemPrompt detected structural truncation on this or
    // a recent turn, flag it once in the footer so the user knows to
    // /reload before continuing. The flag resets after emission so a
    // single-turn glitch does not permanently taint the footer.
    if (promptTruncationDetected && statusText !== undefined) {
      statusText = statusText + " ⚠️ integrity";
      promptTruncationDetected = false;
    }

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
    if (!isOpenAIFamilyModel(ctx.model)) return undefined;
    if (!isOpenAICompatibleApi(ctx.model?.api)) return undefined;

    return addOpenAIPromptCacheKey(event.payload, getSessionPromptCacheKey(ctx));
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
