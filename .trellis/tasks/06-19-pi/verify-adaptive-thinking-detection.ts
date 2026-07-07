#!/usr/bin/env bun
/**
 * Verification: adaptive-generation Claude detection.
 *
 * Pi 0.80.3 added Claude Sonnet 5 with adaptive thinking enabled. This
 * extension must recognize Sonnet 5 in the same compat/doctor/fix path as
 * earlier adaptive-generation Claude models while keeping older Claude models
 * out of that path.
 */

import { __internals_for_tests as I } from "../../../index.ts";

const {
  isAdaptiveGenerationModel,
  isAdaptiveThinkingCompatApplicable,
  describeMissingAdaptiveThinkingCompat,
  buildAdaptiveThinkingCompatSuggestion,
  buildFixSuggestion,
} = I;

let failed = 0;
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`❌ FAIL  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

type PiModelLike = Parameters<typeof isAdaptiveGenerationModel>[0];

function mkClaude(id: string, compat: Record<string, unknown> = {}, api = "anthropic-messages"): PiModelLike {
  return {
    id,
    name: id,
    provider: "anthropic-proxy",
    api,
    baseUrl: "https://anthropic-proxy.example.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    compat,
  } as PiModelLike;
}

// New Pi 0.80.3 model: Sonnet 5 requires adaptive thinking.
{
  const model = mkClaude("claude-sonnet-5");
  check("claude-sonnet-5 is adaptive-generation", isAdaptiveGenerationModel(model) === true);
  check("claude-sonnet-5 anthropic-messages compat check applies", isAdaptiveThinkingCompatApplicable(model) === true);
  const missing = describeMissingAdaptiveThinkingCompat(model as NonNullable<PiModelLike>);
  check(
    "claude-sonnet-5 missing compat reports forceAdaptiveThinking",
    missing.length === 1 && missing[0] === "forceAdaptiveThinking",
    `missing=${JSON.stringify(missing)}`,
  );
  check(
    "claude-sonnet-5 fix suggestion writes forceAdaptiveThinking:true",
    JSON.stringify(buildFixSuggestion(model as NonNullable<PiModelLike>)?.compatKeys) === JSON.stringify({ forceAdaptiveThinking: true }),
    `suggestion=${JSON.stringify(buildFixSuggestion(model as NonNullable<PiModelLike>))}`,
  );
}

// Suffix/date variants should be accepted, matching existing adaptive pattern style.
{
  const model = mkClaude("claude-sonnet-5-20260630[1M]");
  check("claude-sonnet-5 date/suffix variant is adaptive-generation", isAdaptiveGenerationModel(model) === true);
}

// Existing adaptive families still match.
{
  check("claude-sonnet-4-6 remains adaptive-generation", isAdaptiveGenerationModel(mkClaude("claude-sonnet-4-6")) === true);
  check("claude-opus-4-8 remains adaptive-generation", isAdaptiveGenerationModel(mkClaude("claude-opus-4-8")) === true);
  check("claude-fable-5 remains adaptive-generation", isAdaptiveGenerationModel(mkClaude("claude-fable-5")) === true);
}

// Already configured models should not be reported/fixed.
{
  const model = mkClaude("claude-sonnet-5", { forceAdaptiveThinking: true });
  check(
    "configured claude-sonnet-5 has no missing adaptive compat",
    describeMissingAdaptiveThinkingCompat(model as NonNullable<PiModelLike>).length === 0,
  );
  check(
    "configured claude-sonnet-5 has no /fix suggestion",
    buildFixSuggestion(model as NonNullable<PiModelLike>) === undefined,
    `suggestion=${JSON.stringify(buildFixSuggestion(model as NonNullable<PiModelLike>))}`,
  );
}

// Older/non-adaptive Claude models must stay out of this compat path.
{
  check("claude-sonnet-4-5 is not adaptive-generation", isAdaptiveGenerationModel(mkClaude("claude-sonnet-4-5")) === false);
  check("claude-opus-4-5 is not adaptive-generation", isAdaptiveGenerationModel(mkClaude("claude-opus-4-5")) === false);
  check("claude-haiku-4-5 is not adaptive-generation", isAdaptiveGenerationModel(mkClaude("claude-haiku-4-5")) === false);
}

// API gate: the model token alone is insufficient on non-anthropic transports.
{
  const model = mkClaude("claude-sonnet-5", {}, "openai-completions");
  check(
    "claude-sonnet-5 on openai-completions is not adaptive-thinking compat-applicable",
    isAdaptiveThinkingCompatApplicable(model as NonNullable<PiModelLike>) === false,
  );
}

// Pure suggestion helper remains narrow.
{
  check(
    "adaptive suggestion includes only forceAdaptiveThinking",
    JSON.stringify(buildAdaptiveThinkingCompatSuggestion(["forceAdaptiveThinking"])) === JSON.stringify({ forceAdaptiveThinking: true }),
  );
}

console.log("");
console.log("=== Summary ===");
console.log(`Passed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
console.log("");

if (failed > 0) {
  process.exit(1);
}
