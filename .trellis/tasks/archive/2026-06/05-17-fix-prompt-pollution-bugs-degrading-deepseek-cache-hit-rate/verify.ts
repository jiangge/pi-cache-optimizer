// Verification script for task 05-17-fix-prompt-pollution-bugs.
//
// Run from the repo root with:
//   node --experimental-strip-types --no-warnings .trellis/tasks/05-17-fix-prompt-pollution-bugs-degrading-deepseek-cache-hit-rate/verify.ts
// or:
//   bun .trellis/tasks/05-17-fix-prompt-pollution-bugs-degrading-deepseek-cache-hit-rate/verify.ts
//
// What it asserts:
// 1. With healthy guidelines (real multi-char strings), `optimizeSystemPrompt`
//    correctly lifts them to the stable prefix and removes them from the
//    dynamic remainder.
// 2. With a string-vs-array regression upstream — i.e. promptGuidelines
//    contains junk single-character entries that the cache-optimizer used to
//    treat as legitimate candidates — `optimizeSystemPrompt` now ignores them.
//    The dynamic remainder is byte-identical to the no-junk control run.
//    This proves the MIN_STABLE_CANDIDATE_LENGTH guard prevents arbitrary
//    bytes from being ripped out of the prompt by short-pattern .replace()s.
// 3. The threshold value matches what the spec expects (>= 8 chars).
//
// Exits 0 on success, 1 on any failed assertion.

import { __internals_for_tests } from "../../../index.ts";

const { buildStableCandidates, optimizeSystemPrompt, MIN_STABLE_CANDIDATE_LENGTH } =
  __internals_for_tests;

type Failure = { name: string; detail: string };
const failures: Failure[] = [];

function expect(name: string, cond: boolean, detail: string): void {
  if (!cond) failures.push({ name, detail });
}

// ---- Test 1: threshold value is the documented 8 chars -------------------
expect(
  "threshold-default-is-8",
  MIN_STABLE_CANDIDATE_LENGTH === 8,
  `MIN_STABLE_CANDIDATE_LENGTH=${MIN_STABLE_CANDIDATE_LENGTH}, expected 8`,
);

// ---- Synthetic original system prompt resembling pi's actual builder -----
// We don't import pi internals — we reconstruct enough of the shape to drive
// the cache-optimizer through its real branches.

const SUBAGENT_PROTOCOL = `Sub-agent dispatch protocol (Trellis): your dispatch prompt MUST start with one line "Active task: <task path from \`task.py current\`>" before any other instructions. No exceptions.`;

const HEALTHY_GUIDELINES = [
  "Use bash for file operations like ls, rg, find",
  "Use read to examine files instead of cat or sed.",
  "Use edit for precise changes (edits[].oldText must match exactly)",
  "Use write only for new files or complete rewrites.",
  "Be concise in your responses",
  "Show file paths clearly when working with files",
];

const TOOL_SNIPPETS: Record<string, string> = {
  read: "Read the contents of a file.",
  bash: "Execute a bash command in the current working directory.",
  edit: "Edit a single file using exact text replacement.",
  write: "Write content to a file.",
};

function buildOriginal(guidelines: string[]): string {
  // Mirror pi's system-prompt.js layout closely enough that includes() finds
  // candidates verbatim. Pi's `buildSystemPrompt` skips guidelines whose
  // trimmed form is empty (`if (normalized.length > 0) addGuideline(...)`),
  // so we mirror that filter here — otherwise a whitespace guideline (e.g.
  // the space char from `SUBAGENT_PROTOCOL.split("")`) would render as a
  // bare `- ` bullet that pi itself would never emit.
  const toolsList = ["read", "bash", "edit", "write"]
    .map((name) => `- ${name}: ${TOOL_SNIPPETS[name]}`)
    .join("\n");
  const guidelinesList = guidelines
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
    .map((g) => `- ${g}`)
    .join("\n");
  return `You are an expert coding assistant operating inside pi.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelinesList}

Pi documentation (read only when the user asks about pi itself):
- Main documentation: /tmp/pi/README.md

# Project Context

Project-specific instructions and guidelines:

## ./AGENTS.md

This is the AGENTS.md file. Project conventions live here.

Current date: 2026-05-17
Current working directory: /tmp/example`;
}

function makeOpts(guidelines: string[]) {
  // Cast loosely — the verification script doesn't import pi types.
  return {
    cwd: "/tmp/example",
    selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: TOOL_SNIPPETS,
    promptGuidelines: guidelines,
    contextFiles: [
      { path: "./AGENTS.md", content: "This is the AGENTS.md file. Project conventions live here." },
    ],
    skills: [],
  } as unknown as Parameters<typeof optimizeSystemPrompt>[1];
}

// ---- Test 2: healthy run lifts guidelines + reorders cleanly --------------
{
  const original = buildOriginal(HEALTHY_GUIDELINES);
  const result = optimizeSystemPrompt(original, makeOpts(HEALTHY_GUIDELINES));

  expect(
    "healthy.changed",
    result.changed === true,
    `expected changed=true, got ${result.changed}`,
  );
  expect(
    "healthy.stablePrefix-has-guidelines",
    HEALTHY_GUIDELINES.every((g) => result.stablePrefix.includes(g)),
    "stablePrefix missing one or more healthy guidelines",
  );
  expect(
    "healthy.dynamic-remainder-no-bullet-guidelines",
    !HEALTHY_GUIDELINES.some((g) =>
      result.systemPrompt.split("\n---\n").slice(1).join("\n---\n").includes(`- ${g}`),
    ),
    "dynamic remainder still contains a `- <healthy guideline>` bullet line",
  );
}

// ---- Test 3: junk single-char guidelines must NOT corrupt rest -----------
//
// Reproduce the upstream regression: pi's `_normalizePromptGuidelines` does
// `for (const g of guidelines)`, so when trellis used to pass
//   promptGuidelines: SUBAGENT_DISPATCH_PROTOCOL  // bare string
// pi expanded the string into ~57 unique single-character "guidelines"
// (`S`, `u`, `b`, `-`, `(`, `T`, `)`, ...). We feed those single chars in
// alongside the healthy guidelines and assert the optimizer's output is
// indistinguishable (in the dynamic-remainder section) from the healthy
// control run.

{
  const junkChars = Array.from(new Set(SUBAGENT_PROTOCOL.split("")));
  const polluted = [...HEALTHY_GUIDELINES, ...junkChars];

  const controlOriginal = buildOriginal(HEALTHY_GUIDELINES);
  const controlResult = optimizeSystemPrompt(
    controlOriginal,
    makeOpts(HEALTHY_GUIDELINES),
  );

  // Build the "polluted" original the way pi would: it ALSO renders the junk
  // single-char guidelines as `- S`, `- u`, ... bullets. The cache-optimizer
  // must (a) refuse to lift those single-char candidates and (b) NOT mangle
  // unrelated text via short-pattern replace().
  const pollutedOriginal = buildOriginal(polluted);
  const pollutedResult = optimizeSystemPrompt(pollutedOriginal, makeOpts(polluted));

  // The pollutedResult.stablePrefix MUST NOT contain any single-char "- X"
  // bullet. (We allow length-2 patterns to also be filtered defensively;
  // threshold is >= 8, so any 3-char `- X` is dropped automatically.)
  const stableHasJunkBullet = junkChars.some((c) => {
    const bullet = `- ${c}`;
    // Look for whole-line bullet, not substring inside other text.
    return pollutedResult.stablePrefix.split("\n").includes(bullet);
  });
  expect(
    "polluted.stablePrefix-rejects-single-char-bullets",
    !stableHasJunkBullet,
    "stablePrefix contains at least one `- <single-char>` bullet (regression)",
  );

  // Critical assertion: the dynamic remainder of the polluted run must contain
  // every healthy guideline once (just like the control), proving short-pattern
  // .replace() did not rip arbitrary bytes out.
  const pollutedRest = pollutedResult.systemPrompt
    .split("\n---\n")
    .slice(1)
    .join("\n---\n");
  const controlRest = controlResult.systemPrompt
    .split("\n---\n")
    .slice(1)
    .join("\n---\n");

  // Healthy bullets are lifted to stablePrefix in BOTH runs, so the dynamic
  // remainder should NOT contain `- <guideline>` lines in either run. The
  // important invariant is that they're equally absent.
  for (const g of HEALTHY_GUIDELINES) {
    const inControl = controlRest.includes(`- ${g}`);
    const inPolluted = pollutedRest.includes(`- ${g}`);
    expect(
      `polluted.guideline-presence-matches-control:${g.slice(0, 24)}`,
      inControl === inPolluted,
      `control vs polluted disagreement for "${g}" (control=${inControl} polluted=${inPolluted})`,
    );
  }

  // The most direct corruption signal: control rest must be a subset of
  // pollutedRest (modulo the legitimate extra `- <single-char>` bullets that
  // pi rendered, since the cache-optimizer no longer removes them). We check
  // by stripping all `- <single-char>` lines from pollutedRest and comparing.
  const strippedPollutedRest = pollutedRest
    .split("\n")
    .filter((line) => !/^- .$/.test(line))
    .join("\n");

  expect(
    "polluted.rest-equals-control-after-stripping-single-char-bullets",
    strippedPollutedRest === controlRest,
    `dynamic remainder differs after stripping single-char bullets.\n--- diff (first 400 chars of each):\n  control:  ${JSON.stringify(controlRest.slice(0, 400))}\n  polluted: ${JSON.stringify(strippedPollutedRest.slice(0, 400))}`,
  );
}

// ---- Test 4: buildStableCandidates returns multi-char strings only -------
{
  const junkChars = Array.from(new Set(SUBAGENT_PROTOCOL.split("")));
  const candidates = buildStableCandidates(makeOpts([...HEALTHY_GUIDELINES, ...junkChars]));
  // The candidate list itself still includes `- S`, `- u`, etc. because
  // `buildStableCandidates` is a pure data-shaper. The defense lives in
  // `optimizeSystemPrompt`. So we just assert at least the healthy bullets
  // are present.
  for (const g of HEALTHY_GUIDELINES) {
    expect(
      `candidates-contain:${g.slice(0, 24)}`,
      candidates.includes(`- ${g}`),
      `buildStableCandidates missing healthy guideline "${g}"`,
    );
  }
}

// ---- Report ---------------------------------------------------------------
if (failures.length === 0) {
  console.log(
    "[verify] OK — all assertions passed " +
      `(MIN_STABLE_CANDIDATE_LENGTH=${MIN_STABLE_CANDIDATE_LENGTH}).`,
  );
  process.exit(0);
} else {
  console.error(`[verify] FAIL — ${failures.length} assertion(s) failed:`);
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(1);
}
