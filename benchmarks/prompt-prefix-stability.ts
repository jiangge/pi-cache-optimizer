import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Offline check for deterministic tool ordering. The system-prompt rewrite is measured on real Pi 1.0 prompts by
// benchmarks/real-cache/local-check.ts (a synthetic prompt cannot tell whether Pi's own section order is already stable).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(join(root, "benchmarks", "prompt-prefix-stability.ts"), {
  interopDefault: false,
  moduleCache: false,
});
const { __internals_for_tests: internals } = await jiti.import<typeof import("../index.ts")>(join(root, "index.ts"));

type ToolTurn = {
  turn: number;
  original: string;
  normalized: string;
  changed: boolean;
};

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index++;
  return index;
}

function commonPrefixRatio(left: string, right: string): number {
  return left.length === 0 && right.length === 0 ? 1 : commonPrefixLength(left, right) / Math.max(left.length, right.length);
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
  benchmark: "tool-ordering-prefix-stability",
  version: 2,
  methodology: "20 deterministic offline turns; ratios compare adjacent serialized tool arrays' common prefixes; no provider calls or cache-hit claims",
  toolOrdering: summarizeTools(toolTurns),
}, null, 2));
