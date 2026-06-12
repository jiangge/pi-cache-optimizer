// Verification script for task 06-12-adaptive-thinking-compat-check.
//
// Run from the repo root with:
//   bun .trellis/tasks/06-12-adaptive-thinking-compat-check-fix-subcommand-with-risk-confirmed-auto-repair/verify.ts
//
// Exits 0 on success, 1 on any failed assertion.

import { __internals_for_tests } from "../../../index.ts";

const {
  isAdaptiveGenerationModel,
  isAdaptiveThinkingCompatApplicable,
  describeMissingAdaptiveThinkingCompat,
  buildAdaptiveThinkingCompatSuggestion,
  buildAdaptiveThinkingCompatWarningText,
  stripJsoncComments,
  locateModelInJsonc,
  composeFixInsertion,
  selfCheckFix,
  buildFixSuggestion,
  describeMissingCacheCompatForModel,
} = __internals_for_tests;

type Failure = { name: string; detail: string };
const failures: Failure[] = [];

function expect(name: string, cond: boolean, detail: string): void {
  if (!cond) failures.push({ name, detail });
}

function expectEq(name: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    failures.push({ name, detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` });
  }
}

function expectDeepEq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures.push({ name, detail: `expected ${e}, got ${a}` });
  }
}

// ====================================================================
// Test 1: Adaptive generation model detection
// ====================================================================

function makeModel(overrides: Record<string, unknown>): any {
  return {
    provider: "test",
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    baseUrl: "",
    compat: {},
    ...overrides,
  };
}

// Adaptive generation models — should match
const adaptiveCases = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-opus-4-9", name: "Claude Opus 4.9" },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6 dot" },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7 dot" },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8 dot" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-7", name: "Claude Sonnet 4.7" },
  { id: "claude-sonnet-4-8", name: "Claude Sonnet 4.8" },
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-fable-6", name: "Claude Fable 6" },
  { id: "claude-opus-4-6-20250514", name: "Claude Opus 4.6 dated" },
  { id: "claude-opus-4-8[1M]", name: "Claude Opus 4.8 w/ size suffix" },
  { id: "claude-sonnet-4-6-20250514", name: "Claude Sonnet 4.6 dated" },
  { id: "claude-fable-5-20250514", name: "Claude Fable 5 dated" },
  { id: "opus-4-6", name: "Opus 4.6 bare" },
  { id: "sonnet-4-6", name: "Sonnet 4.6 bare" },
  { id: "fable-5", name: "Fable 5 bare" },
  { id: "claude-opus-4-10", name: "Claude Opus 4.10 (two-digit)" },
  { id: "claude-sonnet-4-10", name: "Claude Sonnet 4.10" },
];

for (const { id, name } of adaptiveCases) {
  const model = makeModel({ id, name });
  const result = isAdaptiveGenerationModel(model);
  expect(`adaptive-detect-${id}`, result === true, `${id} should be adaptive, got false`);
}

// Non-adaptive models — should NOT match
const nonAdaptiveCases = [
  { id: "claude-opus-4-5", name: "Claude Opus 4.5 (not adaptive)" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { id: "claude-fable-4", name: "Claude Fable 4" },
  { id: "claude-opus-3-5", name: "Claude Opus 3.5" },
  { id: "claude-haiku-4-6", name: "Claude Haiku 4.6" },
  { id: "gpt-4o", name: "GPT-4o (not Claude)" },
  { id: "deepseek-chat", name: "DeepSeek" },
];

for (const { id, name } of nonAdaptiveCases) {
  const model = makeModel({ id, name });
  const result = isAdaptiveGenerationModel(model);
  expect(`non-adaptive-${id}`, result === false, `${id} should not be adaptive, got true`);
}

// ====================================================================
// Test 2: Adaptive thinking compat detection
// ====================================================================

// Model with missing forceAdaptiveThinking
const modelMissingCompat = makeModel({ id: "claude-opus-4-8", compat: {} });
const missing = describeMissingAdaptiveThinkingCompat(modelMissingCompat);
expectEq("missing-flag", missing.join(","), "forceAdaptiveThinking");

// Model with forceAdaptiveThinking present
const modelWithCompat = makeModel({ id: "claude-opus-4-8", compat: { forceAdaptiveThinking: true } });
const notMissing = describeMissingAdaptiveThinkingCompat(modelWithCompat);
expectEq("not-missing-flag", notMissing.length, 0);

// isAdaptiveThinkingCompatApplicable requires anthropic-messages
const modelWrongApi = makeModel({ id: "claude-opus-4-8", api: "openai-completions" });
expectEq("wrong-api", isAdaptiveThinkingCompatApplicable(modelWrongApi), false);

const modelCorrectApi = makeModel({ id: "claude-opus-4-8", api: "anthropic-messages" });
expectEq("correct-api", isAdaptiveThinkingCompatApplicable(modelCorrectApi), true);

// ====================================================================
// Test 3: buildAdaptiveThinkingCompatSuggestion
// ====================================================================

const suggestion = buildAdaptiveThinkingCompatSuggestion(["forceAdaptiveThinking"]);
expectDeepEq("suggestion", suggestion, { forceAdaptiveThinking: true });

const emptySuggestion = buildAdaptiveThinkingCompatSuggestion([]);
expectDeepEq("empty-suggestion", emptySuggestion, {});

// ====================================================================
// Test 4: JSONC stripJsoncComments
// ====================================================================

// Basic — no comments
expectEq("strip-plain", stripJsoncComments('{"a": 1}'), '{"a": 1}');

// Line comment — content-preserving: comment chars replaced with spaces
const strippedLine = stripJsoncComments('{"a": 1 // comment\n}');
expect("strip-line-comment", !strippedLine.includes('//'), "line comment should be removed");
expect("strip-line-comment-newline", strippedLine.includes('\n'), "newline preserved");

// Block comment
const strippedBlock2 = stripJsoncComments('{"a": 1 /* cmt */ }');
expect("strip-block-comment", !strippedBlock2.includes('/*'), "block comment removed");
expect("strip-block-comment-close", !strippedBlock2.includes('*/'), "block comment close removed");

// String with slashes inside (should not be treated as comments)
expectEq("strip-string-slashes", stripJsoncComments('{"url": "http://example.com"}'), '{"url": "http://example.com"}');

// String with escaped quotes
expectEq("strip-escaped-quotes", stripJsoncComments('{"msg": "he said \\"hello\\""}'), '{"msg": "he said \\"hello\\""}');

// Block comment across lines
const multiLineBlock = '{"a": 1 /* line1\nline2 */ }';
const strippedMulti = stripJsoncComments(multiLineBlock);
expect("strip-multiline-block", strippedMulti.includes('\n'), "multiline block should preserve newline");
expect("strip-multiline-removed", !strippedMulti.includes('/*'), "block comment start removed");
expect("strip-multiline-removed-end", !strippedMulti.includes('*/'), "block comment end removed");

// Line comment inside a string (should NOT strip)
expectEq("strip-line-inside-string", stripJsoncComments('{"x": "foo // bar"}'), '{"x": "foo // bar"}');

// Block comment inside a string (should NOT strip)
expectEq("strip-block-inside-string", stripJsoncComments('{"x": "foo /* bar */"}'), '{"x": "foo /* bar */"}');

// Trailing comma mixed with comments
const strippedTrailing = stripJsoncComments('{"a": 1, // comment\n"b": 2}');
expect("strip-trailing", !strippedTrailing.includes('//'), "line comment removed");
expect("strip-trailing-valid", (() => { try { JSON.parse(strippedTrailing); return true; } catch { return false; } })(), "result should be valid JSON");

// Empty object with comment
expectEq("strip-empty-object-comment", stripJsoncComments('{\n// comment\n}'), '{\n          \n}');

// String containing // (not a comment)
expectEq("strip-string-doubleslash", stripJsoncComments('{"re": "a//b"}'), '{"re": "a//b"}');

// ====================================================================
// Test 5: locateModelInJsonc
// ====================================================================

const sampleJsonc = `{
  "providers": {
    "test-provider": {
      "api": "anthropic-messages",
      "apiKey": "$KEY",
      // this is a provider
      "models": [
        {
          "id": "claude-opus-4-8",
          "name": "Claude 4.8 Opus",
          // model-level compat
          "compat": {
            "existingKey": true
          }
        },
        {
          "id": "other-model",
          "name": "Other Model"
        }
      ]
    }
  }
}`;

const loc = locateModelInJsonc(sampleJsonc, "test-provider", "claude-opus-4-8");
expect("locate-found", loc !== undefined, "should locate model");
if (loc) {
  expect("locate-model-brace", loc.modelObjectBrace > 0, "modelObjectBrace should be set");
  expect("locate-model-end", loc.modelObjectEnd > loc.modelObjectBrace, "modelObjectEnd after brace");
  expect("locate-compat-key", loc.compatKeyStart >= 0, "should find compat key");
  expect("locate-compat-brace", loc.compatObjectBrace >= 0, "should find compat brace");
  expect("locate-compat-end", loc.compatObjectEnd > loc.compatObjectBrace, "compat end after brace");

  // Verify the extracted text is correct
  const modelContent = sampleJsonc.slice(loc.modelObjectBrace, loc.modelObjectEnd + 1);
  expect("locate-model-content", modelContent.includes('"id": "claude-opus-4-8"'), "should contain model id");
  expect("locate-model-content-compat", modelContent.includes('"compat"'), "should contain compat");
}

// Model without compat
const locNoCompat = locateModelInJsonc(sampleJsonc, "test-provider", "other-model");
expect("locate-no-compat", locNoCompat !== undefined, "should find model without compat");
if (locNoCompat) {
  expect("locate-no-compat-key", locNoCompat.compatKeyStart, -1);
  expect("locate-no-compat-brace", locNoCompat.compatObjectBrace, -1);
}

// Non-existent model
const locMissing = locateModelInJsonc(sampleJsonc, "test-provider", "nonexistent");
expect("locate-missing", locMissing === undefined, "should not find nonexistent model");

// Non-existent provider
const locMissingProv = locateModelInJsonc(sampleJsonc, "bad-provider", "claude-opus-4-8");
expect("locate-missing-provider", locMissingProv === undefined, "should not find nonexistent provider");

// Empty compat object
const sampleEmptyCompat = `{
  "providers": {
    "p": {
      "models": [
        {
          "id": "test",
          "compat": {}
        }
      ]
    }
  }
}`;
const locEmptyCompat = locateModelInJsonc(sampleEmptyCompat, "p", "test");
expect("locate-empty-compat", locEmptyCompat !== undefined, "should locate model with empty compat");
if (locEmptyCompat) {
  expect("locate-empty-compat-brace", locEmptyCompat.compatObjectBrace >= 0, "should find empty compat brace");
}

// JSON with comments between properties
const sampleWithComments = `{
  "providers": {
    /* provider block */
    "p": {
      "api": "anthropic-messages",
      /* models array */
      "models": [
        {
          "id": "claude-opus-4-8",
          "name": "Test",
          "compat": {
            "a": 1
          }
        }
      ]
    }
  }
}`;
const locComments = locateModelInJsonc(sampleWithComments, "p", "claude-opus-4-8");
expect("locate-with-comments", locComments !== undefined, "should locate in json with comments");

// ====================================================================
// Test 6: composeFixInsertion (no existing compat)
// ====================================================================

const targetNoCompat = `{
  "providers": {
    "p": {
      "models": [
        {
          "id": "test-model",
          "name": "Test"
        }
      ]
    }
  }
}`;

const locTarget = locateModelInJsonc(targetNoCompat, "p", "test-model");
expect("compose-no-compat-find", locTarget !== undefined, "should find target for compose");

if (locTarget) {
  const result = composeFixInsertion(targetNoCompat, locTarget, { forceAdaptiveThinking: true });
  const check = selfCheckFix(targetNoCompat, result, "p", "test-model", { forceAdaptiveThinking: true });
  expect("compose-no-compat-check", check === null, `self-check should pass: ${check || ""}`);

  // Verify the compat was added
  const parsed = JSON.parse(stripJsoncComments(result));
  expect("compose-no-compat-parsed", parsed.providers.p.models[0].compat !== undefined, "compat should exist");
  expectEq("compose-no-compat-value", parsed.providers.p.models[0].compat.forceAdaptiveThinking, true);
}

// ====================================================================
// Test 7: composeFixInsertion (with existing compat)
// ====================================================================

const targetWithCompat = `{
  "providers": {
    "p": {
      "models": [
        {
          "id": "test-model",
          "name": "Test",
          "compat": {
            "existingKey": "old_value"
          }
        }
      ]
    }
  }
}`;

const locWithCompat = locateModelInJsonc(targetWithCompat, "p", "test-model");
expect("compose-with-compat-find", locWithCompat !== undefined, "should find target for compose with compat");

if (locWithCompat) {
  const result = composeFixInsertion(targetWithCompat, locWithCompat, { forceAdaptiveThinking: true });
  const check = selfCheckFix(targetWithCompat, result, "p", "test-model", { forceAdaptiveThinking: true });
  expect("compose-with-compat-check", check === null, `self-check should pass: ${check || ""}`);

  const parsed = JSON.parse(stripJsoncComments(result));
  expect("compose-with-compat-existing", parsed.providers.p.models[0].compat.existingKey !== undefined, "existing key preserved");
  expectEq("compose-with-compat-existing-val", parsed.providers.p.models[0].compat.existingKey, "old_value");
  expectEq("compose-with-compat-new-val", parsed.providers.p.models[0].compat.forceAdaptiveThinking, true);
}

// ====================================================================
// Test 8: Compose with multiple keys
// ====================================================================

const targetMultiKey = `{
  "providers": {
    "p": {
      "models": [
        {
          "id": "test-model",
          "compat": {}
        }
      ]
    }
  }
}`;

const locMulti = locateModelInJsonc(targetMultiKey, "p", "test-model");
expect("compose-multi-find", locMulti !== undefined, "should find target for multi-key");

if (locMulti) {
  const result = composeFixInsertion(targetMultiKey, locMulti, {
    forceAdaptiveThinking: true,
    sendSessionAffinityHeaders: true,
  });
  const check = selfCheckFix(targetMultiKey, result, "p", "test-model", {
    forceAdaptiveThinking: true,
    sendSessionAffinityHeaders: true,
  });
  expect("compose-multi-check", check === null, `self-check should pass: ${check || ""}`);

  const parsed = JSON.parse(stripJsoncComments(result));
  expectEq("compose-multi-key1", parsed.providers.p.models[0].compat.forceAdaptiveThinking, true);
  expectEq("compose-multi-key2", parsed.providers.p.models[0].compat.sendSessionAffinityHeaders, true);
}

// ====================================================================
// Test 9: buildFixSuggestion
// ====================================================================

// Adaptive model missing flag
const fixModel = makeModel({ id: "claude-opus-4-8", api: "anthropic-messages", compat: {} });
const fixSug = buildFixSuggestion(fixModel);
expect("fix-suggestion-found", fixSug !== undefined, "should produce suggestion for missing flag");
if (fixSug) {
  expectEq("fix-suggestion-provider", fixSug.providerLabel, "test");
  expectEq("fix-suggestion-modelId", fixSug.modelId, "claude-opus-4-8");
  expectDeepEq("fix-suggestion-keys", fixSug.compatKeys, { forceAdaptiveThinking: true });
}

// Already configured model
const fixModelOk = makeModel({ id: "claude-opus-4-8", api: "anthropic-messages", compat: { forceAdaptiveThinking: true } });
const fixSugNone = buildFixSuggestion(fixModelOk);
expect("fix-suggestion-none", fixSugNone === undefined, "no suggestion for already configured");

// Proxy model with missing flags — should produce suggestion
const fixModelProxy = makeModel({ id: "gpt-4o", api: "openai-completions", baseUrl: "https://proxy.example.com", compat: {} });
const fixSugProxy = buildFixSuggestion(fixModelProxy);
expect("fix-suggestion-proxy", fixSugProxy !== undefined, "should produce suggestion for proxy missing flags");
if (fixSugProxy) {
  expectEq("fix-suggestion-proxy-key-count", Object.keys(fixSugProxy.compatKeys).length, 1);
  expectEq("fix-suggestion-proxy-flag", fixSugProxy.compatKeys.sendSessionAffinityHeaders, true);
}

// Already configured model — no suggestion
const fixModelOk2 = makeModel({ id: "gpt-4o", api: "openai-completions", baseUrl: "https://proxy.example.com", compat: { sendSessionAffinityHeaders: true, supportsLongCacheRetention: true } });
const fixSugOk = buildFixSuggestion(fixModelOk2);
expect("fix-suggestion-ok", fixSugOk === undefined, "no suggestion for already configured model");

// ====================================================================
// Test 10: deepEqualIgnoringKeys
// ====================================================================

// Import deepEqualIgnoringKeys
const { deepEqualIgnoringKeys } = __internals_for_tests;

expect("deepEq-true", deepEqualIgnoringKeys({ a: 1 }, { a: 1 }, []), true);
expect("deepEq-ignored", deepEqualIgnoringKeys({ a: 1, b: 2 }, { a: 1 }, ["b"]), true);
expectEq("deepEq-false", deepEqualIgnoringKeys({ a: 1 }, { a: 2 }, []), false);
expectEq("deepEq-extra-unignored", deepEqualIgnoringKeys({ a: 1, b: 2 }, { a: 1 }, []), false);

// ====================================================================
// Test 11: buildAdaptiveThinkingCompatWarningText
// ====================================================================

const warningText = buildAdaptiveThinkingCompatWarningText("test/claude-opus-4-8", ["forceAdaptiveThinking"]);
expect("warning-text-key", warningText.includes("test/claude-opus-4-8"), "warning should contain model key");
expect("warning-text-flag", warningText.includes("forceAdaptiveThinking"), "warning should mention flag");
expect("warning-text-json", warningText.includes('"forceAdaptiveThinking"'), "warning should contain copyable JSON");

// ====================================================================
// Test 12: describeMissingCacheCompatForModel routing
// ====================================================================

// DeepSeek routing still works
const dsModel = makeModel({ id: "deepseek-chat", api: "openai-completions", compat: {} });
const dsMissing = describeMissingCacheCompatForModel(dsModel);
expect("routing-deepseek", dsMissing.length > 0, "DeepSeek model should return missing flags");

// Adaptive thinking routing
const atModel = makeModel({ id: "claude-opus-4-8", api: "anthropic-messages", compat: {} });
const atMissing = describeMissingCacheCompatForModel(atModel);
expect("routing-adaptive", atMissing.includes("forceAdaptiveThinking"), "adaptive model should report forceAdaptiveThinking");

// OpenAI proxy routing (non-GPT)
const proxyModel = makeModel({ id: "kimi-model", api: "openai-completions", baseUrl: "https://kimi.example.com", compat: {} });
const proxyMissing = describeMissingCacheCompatForModel(proxyModel);
expect("routing-proxy", proxyMissing.length > 0, "proxy model should return missing flags");

// ====================================================================
// Summary
// ====================================================================

if (failures.length === 0) {
  console.log("✅ All verification tests passed.");
  process.exit(0);
} else {
  console.error(`❌ ${failures.length} test(s) failed:\n`);
  for (const f of failures) {
    console.error(`  FAIL: ${f.name}`);
    console.error(`    ${f.detail}`);
  }
  process.exit(1);
}
