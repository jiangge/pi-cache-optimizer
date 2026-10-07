import { type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { basename, dirname } from "node:path";
import { NO_SKILL_COMPRESSION_ENV, featureEnabled } from "./config.ts";


// Minimum count of skills before compression is worth applying.
// Below this, pi's verbose XML block is small enough that the overhead of
// an additional one-line index isn't worth the loss of per-skill
// description hints. The 31-skill snapshot in this repo was 13.3 KB; one
// or two skills is well under 1 KB and not worth touching.
export const SKILL_COMPRESSION_MIN_COUNT = 4;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The tool Pi tells the model to load skill files with: `read` when selected, otherwise `bash`; undefined when neither. */
export type SkillFileReadTool = "read" | "bash";

export function skillFileReadTool(opts: Pick<BuildSystemPromptOptions, "selectedTools">): SkillFileReadTool | undefined {
  const tools = opts.selectedTools ?? ["read", "bash", "edit", "write"];
  return (["read", "bash"] as const).find((tool) => tools.includes(tool));
}

/** Byte-for-byte copy of Pi's formatter (contract-tested against the installed Pi for both tool wordings). */
export function formatSkillsForPrompt(skills: NonNullable<BuildSystemPromptOptions["skills"]>, fileReadTool: SkillFileReadTool = "read"): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    fileReadTool === "read"
      ? "Use the read tool to load a skill's file when the task matches its description."
      : "Use bash to load a skill's file when the task matches its description.",
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
 * Pi emits one four-line XML element per skill (`<skill>`, `<name>`,
 * `<description>`, `<location>`). In a 54-skill setup that block was
 * ~24.6 KB, of which the descriptions are 54 % and the rest is XML tags
 * plus a repeated absolute path per skill.
 *
 * This form keeps everything the model needs to choose and load a skill —
 * every skill's name and its full description — and removes the repetition:
 *   - Skills are grouped by skills root directory; the root and the
 *     `<name>/SKILL.md` convention are stated once per group instead of one
 *     `<location>` per skill. agentskills.io requires `location` so file-read
 *     activation can find SKILL.md; the rule gives the model the same path.
 *   - Skills that do not follow `<root>/<name>/SKILL.md` (different file or
 *     directory name, Windows-style paths) are listed with their explicit
 *     file path, so no path is ever guessed.
 *   - The XML envelope is replaced by Markdown headings and bullets.
 *
 * Descriptions are kept verbatim except that whitespace runs (including
 * newlines from folded YAML) collapse to one space so each skill is one
 * bullet. Groups and skills are sorted for determinism (cache stability).
 */
export function formatSkillsForPromptCompressed(
  skills: NonNullable<BuildSystemPromptOptions["skills"]>,
  fileReadTool: SkillFileReadTool = "read",
): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const byRoot = new Map<string, Array<{ name: string; description: string }>>();
  const explicit: Array<{ name: string; description: string; filePath: string }> = [];
  for (const skill of visibleSkills) {
    const description = skill.description.replace(/\s+/g, " ").trim();
    const skillDir = dirname(skill.filePath);
    const conventional =
      !skill.filePath.includes("\\") &&
      basename(skill.filePath) === "SKILL.md" &&
      basename(skillDir) === skill.name;
    if (!conventional) {
      explicit.push({ name: skill.name, description, filePath: skill.filePath });
      continue;
    }
    const root = dirname(skillDir);
    const list = byRoot.get(root) ?? [];
    list.push({ name: skill.name, description });
    byRoot.set(root, list);
  }

  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const header = formatSkillsForPrompt(skills, fileReadTool);
  const preamble = header.slice(0, header.indexOf("<available_skills>")).trim();

  const lines: string[] = [preamble];
  for (const [root, entries] of [...byRoot.entries()].sort(([a], [b]) => compare(a, b))) {
    lines.push("", `## Skills in ${root}/`, `Each skill file is at ${root}/<name>/SKILL.md`, "");
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      lines.push(`- ${entry.name}: ${entry.description}`);
    }
  }
  if (explicit.length > 0) {
    lines.push("", "## Skills with explicit file paths", "");
    for (const entry of explicit.sort((a, b) => compare(a.filePath, b.filePath))) {
      lines.push(`- ${entry.name} (file: ${entry.filePath}): ${entry.description}`);
    }
  }

  return lines.join("\n");
}

/**
 * Replace pi's verbose `<available_skills>` block in `prompt` with the
 * compressed grouped form. Idempotent: if the verbose form is not
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
 *
 * Both sides are compared trimmed: since Pi 0.86 the skills block is trimmed
 * and wrapped in a `<skills>` section, older Pi appended it with leading
 * newlines. Matching the untrimmed text silently disabled compression on
 * every Pi >= 0.86.
 */
export function compressSkillsInSystemPrompt(
  prompt: string,
  opts: BuildSystemPromptOptions,
): string {
  if (!featureEnabled("skillCompression", NO_SKILL_COMPRESSION_ENV, true)) return prompt;
  if (!opts.skills || opts.skills.length === 0) return prompt;

  const visible = opts.skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length < SKILL_COMPRESSION_MIN_COUNT) return prompt;

  const verbose = formatSkillsForPrompt(opts.skills, skillFileReadTool(opts) ?? "read").trim();
  if (!verbose || !prompt.includes(verbose)) return prompt;

  const compressed = formatSkillsForPromptCompressed(opts.skills, skillFileReadTool(opts) ?? "read").trim();
  if (!compressed || compressed.length >= verbose.length) return prompt;

  return prompt.replace(verbose, () => compressed);
}

/**
 * Preferred way to apply skill compression on Pi >= 0.86: set the structured
 * `skills` prompt section instead of returning a whole replacement prompt.
 *
 * Returning `systemPrompt` makes Pi treat it as a forced prompt that replaces the
 * entire leading system message, which silently discards section edits made by
 * handlers that run later and stops Pi from recording/sending only the changed
 * sections. A custom section named `skills` overrides Pi's own and keeps its
 * position and `<skills>` wrapper. Returns true only when Pi's re-rendered prompt
 * really contains the compressed list; otherwise the section is restored and the
 * caller falls back to the string substitution.
 */
export function compressSkillsViaSection(event: {
  readonly systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
}): boolean {
  if (!featureEnabled("skillCompression", NO_SKILL_COMPRESSION_ENV, true)) return false;
  const options = event.systemPromptOptions;
  const sections = options?.sections;
  // Pi < 0.86 has no sections; a forced prompt (set by an earlier handler) ignores them.
  if (!sections || typeof sections !== "object" || options.forceSystemPrompt !== undefined) return false;
  if (!options.skills || options.skills.filter((skill) => !skill.disableModelInvocation).length < SKILL_COMPRESSION_MIN_COUNT) return false;

  const verbose = formatSkillsForPrompt(options.skills, skillFileReadTool(options) ?? "read").trim();
  if (!verbose || !event.systemPrompt.includes(verbose)) return false;
  const compressed = formatSkillsForPromptCompressed(options.skills, skillFileReadTool(options) ?? "read").trim();
  if (!compressed || compressed.length >= verbose.length) return false;

  const previous = sections.skills;
  sections.skills = compressed;
  if (event.systemPrompt.includes(compressed) && !event.systemPrompt.includes(verbose)) return true;
  if (previous === undefined) delete sections.skills;
  else sections.skills = previous;
  return false;
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
export function stripSessionOverviewChurn(prompt: string): string {
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
 * What happened to the skill list on the most recent prompt build. Compression no-ops silently by design when
 * Pi's text is not recognised, which once hid a regression for two weeks (Pi 0.86 changed how the block is
 * assembled); `/cache-optimizer doctor` shows this so that state is visible.
 */
export type SkillCompressionOutcome = {
  applied: "section" | "string" | false;
  /** Why compression did not apply, when it did not. */
  reason?: string;
  visibleSkills: number;
  at: number;
};

let lastSkillCompressionOutcome: SkillCompressionOutcome | undefined;

export function recordSkillCompressionOutcome(outcome: SkillCompressionOutcome): void {
  lastSkillCompressionOutcome = outcome;
}

export function getLastSkillCompressionOutcome(): SkillCompressionOutcome | undefined {
  return lastSkillCompressionOutcome;
}

/** The reason the skill list in `prompt` is left unchanged; call only when neither compression path applied. */
export function explainSkillCompressionSkip(prompt: string, opts: BuildSystemPromptOptions): string {
  if (!featureEnabled("skillCompression", NO_SKILL_COMPRESSION_ENV, true)) return "skill compression is turned off";
  const visible = (opts.skills ?? []).filter((skill) => !skill.disableModelInvocation);
  if (visible.length < SKILL_COMPRESSION_MIN_COUNT) {
    return `only ${visible.length} visible skill(s); compression starts at ${SKILL_COMPRESSION_MIN_COUNT}`;
  }
  if (!prompt.includes("<available_skills>")) {
    return "the prompt has no skill list (no read tool selected, or another extension replaced it)";
  }
  if (!prompt.includes(formatSkillsForPrompt(opts.skills ?? [], skillFileReadTool(opts) ?? "read").trim())) {
    return "Pi's skill list format was not recognised; Pi may have changed it (please report this)";
  }
  return "the compressed list would not be shorter";
}

export function describeSkillCompressionOutcome(outcome: SkillCompressionOutcome | undefined = lastSkillCompressionOutcome): string {
  if (!outcome) return "Skill compression: no prompt built yet in this process";
  const skills = `${outcome.visibleSkills} visible skill(s)`;
  if (outcome.applied === "section") return `Skill compression: applied (structured skills section, ${skills})`;
  if (outcome.applied === "string") return `Skill compression: applied (prompt text substitution, ${skills})`;
  return `Skill compression: not applied — ${outcome.reason ?? "unknown reason"}`;
}
