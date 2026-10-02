import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(join(root, "benchmarks", "prompt-prefix-stability.ts"), {
  interopDefault: false,
  moduleCache: false,
});
const { __internals_for_tests: internals } = await jiti.import<typeof import("../index.ts")>(join(root, "index.ts"));

type Scenario = {
  name: string;
  prompt: string;
  options: Parameters<typeof internals.optimizeSystemPrompt>[1];
};

type Turn = {
  scenario: string;
  turn: number;
  original: string;
  rewritten: string;
  changed: boolean;
  stablePrefixLength: number;
};

type ToolTurn = {
  turn: number;
  original: string;
  normalized: string;
  changed: boolean;
};

const guideline = "Always run repository checks before finishing.";
const contextBody = "Project instructions remain stable across turns and should be preserved.";
const skills = Array.from({ length: 12 }, (_, index) => ({
  name: `skill-${String(index + 1).padStart(2, "0")}`,
  description: `Deterministic offline benchmark skill ${index + 1}.`,
  filePath: `/tmp/skills/skill-${index + 1}/SKILL.md`,
}));

function makePrompt(turn: number, scenario: Scenario): string {
  return [
    "<session-overview>",
    "Branch: benchmark",
    `Recent turn: ${turn}`,
    `Working directory: /tmp/project-${turn % 2}`,
    "</session-overview>",
    "",
    "<workflow-state>",
    `Task turn ${turn}: inspect the provider cache behavior.`,
    "</workflow-state>",
    "",
    "## Stable repository policy",
    guideline,
    "",
    "## AGENTS.md",
    contextBody,
    "",
    scenario.name === "dynamic-guideline-quote" ? `Quoted policy: ${guideline}` : "No quoted policy in dynamic context.",
    "",
    `Dynamic request details: request-${turn} provider-state-${turn % 3}`,
    internals.formatSkillsForPrompt(scenario.options.skills ?? []),
  ].join("\n");
}

const scenarios: Scenario[] = [
  {
    name: "stable-context-and-guideline",
    prompt: "",
    options: { cwd: root, promptGuidelines: [guideline], contextFiles: [{ path: "AGENTS.md", content: contextBody }], skills },
  },
  {
    name: "dynamic-guideline-quote",
    prompt: "",
    options: { cwd: root, promptGuidelines: [guideline], contextFiles: [{ path: "AGENTS.md", content: contextBody }], skills },
  },
];

function compress(prompt: string, options: Scenario["options"]): string {
  return internals.compressSkillsInSystemPrompt(prompt, options);
}

function rewrite(prompt: string, options: Scenario["options"]): string {
  const stripped = internals.stripSessionOverviewChurn(prompt);
  const compressed = compress(stripped, options);
  return internals.optimizeSystemPrompt(compressed, options).systemPrompt;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index++;
  return index;
}

function commonPrefixRatio(left: string, right: string): number {
  return left.length === 0 && right.length === 0 ? 1 : commonPrefixLength(left, right) / Math.max(left.length, right.length);
}

function summarize(turns: Turn[]) {
  const pairs = turns.slice(1).map((turn, index) => ({ previous: turns[index], current: turn }));
  const originalRatios = pairs.map(({ previous, current }) => commonPrefixRatio(previous.original, current.original));
  const rewrittenRatios = pairs.map(({ previous, current }) => commonPrefixRatio(previous.rewritten, current.rewritten));
  const average = (values: number[]) => values.length === 0 ? 1 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const totalOriginal = turns.reduce((sum, turn) => sum + turn.original.length, 0);
  const totalRewritten = turns.reduce((sum, turn) => sum + turn.rewritten.length, 0);
  return {
    turns: turns.length,
    changedTurns: turns.filter((turn) => turn.changed).length,
    averageCommonPrefixRatioOriginal: Number(average(originalRatios).toFixed(6)),
    averageCommonPrefixRatioRewritten: Number(average(rewrittenRatios).toFixed(6)),
    prefixRatioDelta: Number((average(rewrittenRatios) - average(originalRatios)).toFixed(6)),
    totalCharsOriginal: totalOriginal,
    totalCharsRewritten: totalRewritten,
    sizeDeltaChars: totalRewritten - totalOriginal,
    averageStablePrefixChars: Number((turns.reduce((sum, turn) => sum + turn.stablePrefixLength, 0) / turns.length).toFixed(2)),
  };
}

function makeToolPayload(turn: number) {
  const names = turn % 2 === 0 ? ["zeta", "alpha", "gamma", "beta"] : ["beta", "gamma", "alpha", "zeta"];
  return {
    model: "proxy-model",
    messages: [{ role: "user", content: `request-${turn}` }],
    tools: names.map((name) => ({ type: "function", function: { name, description: `tool-${name}`, parameters: { type: "object" } } })),
  };
}

function summarizeTools(turns: ToolTurn[]) {
  const pairs = turns.slice(1).map((turn, index) => ({ previous: turns[index], current: turn }));
  const originalRatios = pairs.map(({ previous, current }) => commonPrefixRatio(previous.original, current.original));
  const normalizedRatios = pairs.map(({ previous, current }) => commonPrefixRatio(previous.normalized, current.normalized));
  const average = (values: number[]) => values.length === 0 ? 1 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    turns: turns.length,
    changedTurns: turns.filter((turn) => turn.changed).length,
    averageCommonPrefixRatioOriginal: Number(average(originalRatios).toFixed(6)),
    averageCommonPrefixRatioNormalized: Number(average(normalizedRatios).toFixed(6)),
    prefixRatioDelta: Number((average(normalizedRatios) - average(originalRatios)).toFixed(6)),
  };
}

const results = scenarios.map((scenario) => {
  const turns: Turn[] = [];
  for (let turn = 0; turn < 20; turn++) {
    const original = makePrompt(turn, scenario);
    const rewritten = rewrite(original, scenario.options);
    const optimized = internals.optimizeSystemPrompt(
      compress(internals.stripSessionOverviewChurn(original), scenario.options),
      scenario.options,
    );
    turns.push({
      scenario: scenario.name,
      turn,
      original,
      rewritten,
      changed: rewritten !== original,
      stablePrefixLength: optimized.stablePrefix.length,
    });
  }
  return { scenario: scenario.name, summary: summarize(turns) };
});

const toolTurns: ToolTurn[] = [];
for (let turn = 0; turn < 20; turn++) {
  const payload = makeToolPayload(turn);
  const normalized = internals.normalizeToolsInPayload(payload, "openai-completions").payload;
  toolTurns.push({
    turn,
    original: JSON.stringify(payload.tools),
    normalized: JSON.stringify((normalized as typeof payload).tools),
    changed: normalized !== payload,
  });
}

console.log(JSON.stringify({
  benchmark: "prompt-prefix-stability",
  version: 1,
  methodology: "20 deterministic offline turns per scenario; ratios compare adjacent serialized prompt/payload common prefixes; no provider calls or cache-hit claims",
  results,
  toolOrdering: summarizeTools(toolTurns),
}, null, 2));
