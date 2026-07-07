// Verification script for Claude Sonnet 5 adaptive-generation compat detection.
//
// Pi 0.80.3 (pi-ai 0.80.3) added `claude-sonnet-5` with
// `compat: { forceAdaptiveThinking: true }` and `api: "anthropic-messages"` to
// the Anthropic and Amazon Bedrock provider catalogs. The extension's
// `ADAPTIVE_SONNET_PATTERN` previously matched only `sonnet-4.6` .. `sonnet-4.9`
// (and `sonnet-4-10+`), so `claude-sonnet-5` was NOT detected as an
// adaptive-generation model — meaning footer `⚠️ compat`, doctor/compat
// diagnostics, and `/cache-optimizer fix` all missed Sonnet 5.
//
// This script asserts the extended pattern detects Sonnet 5 (and Bedrock
// variants + future minors/majors) while preserving the existing
// sonnet-4.6+ match and the intentional sonnet-4.5 / opus-4.5 exclusion.
//
// Run from the repo root with:
//   bun .trellis/tasks/06-19-pi/verify-sonnet5-adaptive.ts
//
// Exits 0 on success, 1 on any failed assertion.

import { __internals_for_tests } from "../../../index.ts";

const {
  isAdaptiveGenerationModel,
  isAdaptiveThinkingCompatApplicable,
  describeMissingAdaptiveThinkingCompat,
  buildAdaptiveThinkingCompatSuggestion,
  buildAdaptiveThinkingCompatWarningText,
  describeMissingCacheCompatForModel,
  buildFixSuggestion,
  buildDoctorDiagnosis,
  buildCompatDiagnosis,
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

function makeModel(overrides: Record<string, unknown>): any {
  return {
    provider: "anthropic",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    compat: {},
    ...overrides,
  };
}

// ====================================================================
// Test 1: Sonnet 5 detection — the new models added in pi-ai 0.80.3
// ====================================================================

const sonnet5Cases = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  // Amazon Bedrock inherited variants (all share the same adaptive metadata)
  { id: "anthropic.claude-sonnet-5", name: "Anthropic Claude Sonnet 5 (Bedrock)" },
  { id: "au.anthropic.claude-sonnet-5", name: "AU Anthropic Claude Sonnet 5" },
  { id: "eu.anthropic.claude-sonnet-5", name: "EU Anthropic Claude Sonnet 5" },
  { id: "global.anthropic.claude-sonnet-5", name: "Global Anthropic Claude Sonnet 5" },
  { id: "jp.anthropic.claude-sonnet-5", name: "JP Anthropic Claude Sonnet 5" },
  { id: "us.anthropic.claude-sonnet-5", name: "US Anthropic Claude Sonnet 5" },
  // Future-proofing: minor versions and the next major
  { id: "claude-sonnet-5-1", name: "Claude Sonnet 5.1" },
  { id: "claude-sonnet-5.1", name: "Claude Sonnet 5.1 dotted" },
  { id: "claude-sonnet-6", name: "Claude Sonnet 6" },
  { id: "sonnet-5", name: "Sonnet 5 bare" },
  { id: "claude-sonnet-5-20250514", name: "Claude Sonnet 5 dated" },
];

for (const { id, name } of sonnet5Cases) {
  const model = makeModel({ id, name });
  expect(`sonnet5-detect-${id}`, isAdaptiveGenerationModel(model) === true, `${id} should be adaptive, got false`);
}

// ====================================================================
// Test 2: Preserved adaptive detection (existing behavior must not regress)
// ====================================================================

const existingAdaptiveCases = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-opus-4-9", name: "Claude Opus 4.9" },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6 dot" },
  { id: "claude-opus-4-8[1M]", name: "Claude Opus 4.8 w/ size suffix" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-7", name: "Claude Sonnet 4.7" },
  { id: "claude-sonnet-4-8", name: "Claude Sonnet 4.8" },
  { id: "claude-sonnet-4-6-20250514", name: "Claude Sonnet 4.6 dated" },
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-fable-5-20250514", name: "Claude Fable 5 dated" },
  { id: "claude-opus-4-10", name: "Claude Opus 4.10 (two-digit)" },
  { id: "claude-sonnet-4-10", name: "Claude Sonnet 4.10" },
  { id: "claude-opus-5", name: "Claude Opus 5 (future major)" },
];

for (const { id, name } of existingAdaptiveCases) {
  const model = makeModel({ id, name });
  expect(`preserved-adaptive-${id}`, isAdaptiveGenerationModel(model) === true, `${id} should be adaptive, got false`);
}

// ====================================================================
// Test 3: Non-adaptive models must NOT match
// ====================================================================

const nonAdaptiveCases = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (NOT adaptive)" },
  { id: "claude-sonnet-4-0", name: "Claude Sonnet 4.0" },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 dated" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5 (NOT adaptive)" },
  { id: "claude-opus-3-5", name: "Claude Opus 3.5" },
  { id: "claude-fable-4", name: "Claude Fable 4" },
  { id: "claude-haiku-4-6", name: "Claude Haiku 4.6 (haiku never adaptive)" },
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "deepseek-chat", name: "DeepSeek Chat" },
  { id: "kimi-k2", name: "Kimi K2" },
];

for (const { id, name } of nonAdaptiveCases) {
  const model = makeModel({ id, name });
  expect(`non-adaptive-${id}`, isAdaptiveGenerationModel(model) === false, `${id} should NOT be adaptive, got true`);
}

// ====================================================================
// Test 4: isAdaptiveThinkingCompatApplicable — api gate (anthropic-messages only)
// ====================================================================

expectEq("sonnet5-anthropic-messages", isAdaptiveThinkingCompatApplicable(makeModel({ id: "claude-sonnet-5", api: "anthropic-messages" })), true);
expectEq("sonnet5-openai-completions", isAdaptiveThinkingCompatApplicable(makeModel({ id: "claude-sonnet-5", api: "openai-completions" })), false);
expectEq("sonnet5-openai-responses", isAdaptiveThinkingCompatApplicable(makeModel({ id: "claude-sonnet-5", api: "openai-responses" })), false);
expectEq("sonnet5-kiro-api", isAdaptiveThinkingCompatApplicable(makeModel({ id: "claude-sonnet-5", api: "kiro-api" })), false);
expectEq("sonnet5-bedrock-converse", isAdaptiveThinkingCompatApplicable(makeModel({ id: "claude-sonnet-5", api: "bedrock-converse-stream" })), false);
// Bedrock variant id with anthropic-messages api still applies
expectEq(
  "bedrock-sonnet5-anthropic-messages",
  isAdaptiveThinkingCompatApplicable(makeModel({ id: "anthropic.claude-sonnet-5", api: "anthropic-messages" })),
  true,
);

// ====================================================================
// Test 5: describeMissingAdaptiveThinkingCompat for Sonnet 5
// ====================================================================

const s5NoCompat = makeModel({ id: "claude-sonnet-5", compat: {} });
expectDeepEq("sonnet5-missing-no-compat", describeMissingAdaptiveThinkingCompat(s5NoCompat), ["forceAdaptiveThinking"]);

const s5WithFlag = makeModel({ id: "claude-sonnet-5", compat: { forceAdaptiveThinking: true } });
expectDeepEq("sonnet5-missing-with-flag", describeMissingAdaptiveThinkingCompat(s5WithFlag), []);

const s5WithFalse = makeModel({ id: "claude-sonnet-5", compat: { forceAdaptiveThinking: false } });
expectDeepEq("sonnet5-missing-with-false", describeMissingAdaptiveThinkingCompat(s5WithFalse), ["forceAdaptiveThinking"]);

// ====================================================================
// Test 6: buildAdaptiveThinkingCompatSuggestion
// ====================================================================

expectDeepEq("sonnet5-suggestion", buildAdaptiveThinkingCompatSuggestion(["forceAdaptiveThinking"]), { forceAdaptiveThinking: true });
expectDeepEq("sonnet5-suggestion-empty", buildAdaptiveThinkingCompatSuggestion([]), {});

// ====================================================================
// Test 7: buildAdaptiveThinkingCompatWarningText
// ====================================================================

const warning = buildAdaptiveThinkingCompatWarningText("anthropic/claude-sonnet-5", ["forceAdaptiveThinking"]);
expect("warning-key", warning.includes("anthropic/claude-sonnet-5"), "warning should contain model key");
expect("warning-flag", warning.includes("forceAdaptiveThinking"), "warning should mention flag");
expect("warning-json", warning.includes('"forceAdaptiveThinking": true'), "warning should contain copyable JSON");

// ====================================================================
// Test 8: describeMissingCacheCompatForModel routes Sonnet 5 to adaptive branch
// (NOT the generic OpenAI-compatible proxy branch)
// ====================================================================

const s5Anthropic = makeModel({ id: "claude-sonnet-5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", compat: {} });
const s5Routed = describeMissingCacheCompatForModel(s5Anthropic);
expectDeepEq("routing-sonnet5-adaptive-not-proxy", s5Routed, ["forceAdaptiveThinking"]);

// A custom Anthropic-compatible channel (own baseUrl) still routes to adaptive,
// because the gate is api type, not base URL.
const s5CustomChannel = makeModel({
  id: "claude-sonnet-5",
  provider: "my-claude-channel",
  api: "anthropic-messages",
  baseUrl: "https://claude-proxy.example.com",
  compat: {},
});
expectDeepEq("routing-sonnet5-custom-channel-adaptive", describeMissingCacheCompatForModel(s5CustomChannel), ["forceAdaptiveThinking"]);

// Boundary: a Sonnet 5 id routed through an OpenAI-compatible proxy API is
// treated as a proxy (session affinity), NOT adaptive — the api gate decides.
const s5ViaOpenAIProxy = makeModel({
  id: "claude-sonnet-5",
  provider: "openrouter",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  compat: {},
});
const s5ProxyRouted = describeMissingCacheCompatForModel(s5ViaOpenAIProxy);
expect("routing-sonnet5-openai-proxy-is-proxy", s5ProxyRouted.includes("sendSessionAffinityHeaders"), "openai-completions sonnet-5 should route to proxy branch");
expect("routing-sonnet5-openai-proxy-not-adaptive", !s5ProxyRouted.includes("forceAdaptiveThinking"), "openai-completions sonnet-5 must NOT route to adaptive branch");

// ====================================================================
// Test 9: buildFixSuggestion for Sonnet 5
// ====================================================================

const s5FixModel = makeModel({ id: "claude-sonnet-5", api: "anthropic-messages", compat: {} });
const s5FixSug = buildFixSuggestion(s5FixModel);
expect("sonnet5-fix-found", s5FixSug !== undefined, "should produce fix suggestion for sonnet-5 missing flag");
if (s5FixSug) {
  expectEq("sonnet5-fix-provider", s5FixSug.providerLabel, "anthropic");
  expectEq("sonnet5-fix-modelId", s5FixSug.modelId, "claude-sonnet-5");
  expectDeepEq("sonnet5-fix-keys", s5FixSug.compatKeys, { forceAdaptiveThinking: true });
}

// Already configured → no suggestion
const s5Configured = makeModel({ id: "claude-sonnet-5", api: "anthropic-messages", compat: { forceAdaptiveThinking: true } });
expect("sonnet5-fix-none-when-configured", buildFixSuggestion(s5Configured) === undefined, "configured sonnet-5 should not need fix");

// Bedrock variant fix suggestion
const bedrockFixModel = makeModel({ id: "anthropic.claude-sonnet-5", provider: "amazon-bedrock", api: "anthropic-messages", compat: {} });
const bedrockFixSug = buildFixSuggestion(bedrockFixModel);
expect("bedrock-sonnet5-fix-found", bedrockFixSug !== undefined, "bedrock sonnet-5 should produce fix suggestion");
if (bedrockFixSug) {
  expectDeepEq("bedrock-sonnet5-fix-keys", bedrockFixSug.compatKeys, { forceAdaptiveThinking: true });
}

// ====================================================================
// Test 10: buildDoctorDiagnosis for Sonnet 5
// ====================================================================

const s5DoctorMissing = buildDoctorDiagnosis(s5FixModel);
expect("doctor-missing-flag-line", s5DoctorMissing.includes("Missing compat flags: forceAdaptiveThinking"), "doctor should list missing forceAdaptiveThinking");
expect("doctor-suggestion-json", s5DoctorMissing.includes('"forceAdaptiveThinking": true'), "doctor should include copyable JSON suggestion");
expect("doctor-edit-path", s5DoctorMissing.includes("providers["), "doctor should show edit path");
expect("doctor-not-proxy", !s5DoctorMissing.includes("sendSessionAffinityHeaders"), "adaptive doctor must not show proxy session-affinity guidance");

const s5DoctorOk = buildDoctorDiagnosis(s5Configured);
expect("doctor-fully-configured", s5DoctorOk.includes("✅ Compat fully configured."), "configured sonnet-5 doctor should show fully configured");

// ====================================================================
// Test 11: buildCompatDiagnosis for Sonnet 5
// ====================================================================

const s5CompatMissing = buildCompatDiagnosis(s5FixModel);
expect("compat-missing-present", s5CompatMissing !== undefined && s5CompatMissing.length > 0, "compat diagnosis should be present for missing flag");
if (s5CompatMissing) {
  expect("compat-missing-flag", s5CompatMissing.includes("forceAdaptiveThinking"), "compat diagnosis should mention missing flag");
  expect("compat-suggestion-json", s5CompatMissing.includes('"forceAdaptiveThinking": true'), "compat diagnosis should include copyable JSON");
}

// buildCompatDiagnosis returns `undefined` when there is nothing to report
// (fully configured + no router/optional notes). For a clean official Anthropic
// channel that is the "fully configured" signal — distinct from buildDoctorDiagnosis
// which always emits a status line.
const s5CompatOk = buildCompatDiagnosis(s5Configured);
expect("compat-fully-configured-undefined", s5CompatOk === undefined, "configured sonnet-5 on clean anthropic channel should report nothing (undefined)");

// When a fully-configured Sonnet 5 is routed through a router/channel proxy that
// triggers advisory notes, the compat command prefixes the "fully configured"
// status line above those notes (mirrors the proxy-model behavior).
const s5ConfiguredRouter = makeModel({
  id: "claude-sonnet-5",
  provider: "openrouter",
  api: "anthropic-messages",
  baseUrl: "https://openrouter.ai/api/v1",
  compat: { forceAdaptiveThinking: true },
});
// anthropic-messages api on a non-official base URL does not trigger the
// OpenAI proxy compat path, so there are no optional/router notes here either.
expect("compat-fully-configured-router-clean", buildCompatDiagnosis(s5ConfiguredRouter) === undefined, "configured sonnet-5 on anthropic-messages router channel has no compat notes");

// ====================================================================
// Test 12: Idempotence — same input always matches (no order/timing effects)
// ====================================================================

for (let i = 0; i < 5; i++) {
  expect(`idempotent-sonnet5-${i}`, isAdaptiveGenerationModel(makeModel({ id: "claude-sonnet-5" })) === true, "sonnet-5 must match every time");
  expect(`idempotent-sonnet45-${i}`, isAdaptiveGenerationModel(makeModel({ id: "claude-sonnet-4-5" })) === false, "sonnet-4.5 must not match every time");
}

// ====================================================================
// Summary
// ====================================================================

if (failures.length === 0) {
  console.log("✅ All Sonnet 5 adaptive-thinking verification tests passed.");
  process.exit(0);
} else {
  console.error(`❌ ${failures.length} test(s) failed:\n`);
  for (const f of failures) {
    console.error(`  FAIL: ${f.name}`);
    console.error(`    ${f.detail}`);
  }
  process.exit(1);
}
