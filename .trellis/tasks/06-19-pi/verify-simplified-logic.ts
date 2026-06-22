#!/usr/bin/env bun
/**
 * Verification script for the simplified prompt_cache_retention logic.
 *
 * Tests hasExplicitLongRetentionOptIn logic with MOCK models.json data
 * (not the real file) for deterministic, reproducible results.
 *
 * Also documents the 4-gate before_provider_request logic and verifies
 * the gate ordering is correct (400 history BEFORE explicit opt-in).
 */

// ─── Mock models.json data ───────────────────────────────────────────

const MOCK_MODELS_JSON: Record<string, unknown> = {
  providers: {
    // Provider with supportsLongCacheRetention: true, no model override
    "hello": {
      compat: {
        thinkingFormat: "deepseek",
        sendSessionAffinityHeaders: true,
        supportsLongCacheRetention: true,
      },
      models: [
        { id: "deepseek-v4-flash" },
        { id: "deepseek-v4-pro" },
      ],
    },
    // Provider with supportsLongCacheRetention: true, model overrides to false
    "h-e": {
      compat: {
        supportsLongCacheRetention: true,
      },
      models: [
        {
          id: "glm-5.2",
          compat: {
            supportsLongCacheRetention: false,
          },
        },
      ],
    },
    // Provider with NO supportsLongCacheRetention (field absent)
    "atm-temp": {
      compat: {
        sendSessionAffinityHeaders: true,
      },
      models: [
        { id: "glm-5.2" },
      ],
    },
    // Provider with supportsLongCacheRetention: false (explicit opt-out)
    "hyb-ds": {
      compat: {
        supportsLongCacheRetention: false,
      },
      models: [
        { id: "deepseek-v4" },
      ],
    },
    // Provider with model-level true, no provider-level
    "custom-prov": {
      models: [
        {
          id: "model-a",
          compat: {
            supportsLongCacheRetention: true,
          },
        },
        {
          id: "model-b",
          compat: {
            supportsLongCacheRetention: false,
          },
        },
        { id: "model-c" }, // no compat
      ],
    },
  },
};

// ─── Replicated logic from index.ts ──────────────────────────────────

type PiModel = {
  provider: string;
  id: string;
  api: string;
  baseUrl?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExplicitLongRetentionOptIn(
  model: PiModel,
  mockData: Record<string, unknown>,
): boolean {
  const providers = asRecord(asRecord(mockData)?.providers);
  if (!providers) return false;

  const prov = asRecord(providers[model.provider]);
  if (!prov) return false;

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

  const provCompat = asRecord(prov.compat);
  if (provCompat?.supportsLongCacheRetention !== undefined) {
    return provCompat.supportsLongCacheRetention === true;
  }

  return false;
}

// ─── Test cases for hasExplicitLongRetentionOptIn ────────────────────

const testCases: Array<{
  name: string;
  model: PiModel;
  expected: boolean;
  reason: string;
}> = [
  {
    name: "hello/deepseek-v4-flash (provider true, no model override)",
    model: { provider: "hello", id: "deepseek-v4-flash", api: "openai-completions" },
    expected: true,
    reason: "Provider-level true, no model-level → user opted in, keep",
  },
  {
    name: "hello/deepseek-v4-pro (provider true, no model override)",
    model: { provider: "hello", id: "deepseek-v4-pro", api: "openai-completions" },
    expected: true,
    reason: "Provider-level true → user opted in, keep",
  },
  {
    name: "h-e/glm-5.2 (provider true, model false — conflict)",
    model: { provider: "h-e", id: "glm-5.2", api: "openai-completions" },
    expected: false,
    reason: "Model-level false overrides provider-level true → strip",
  },
  {
    name: "atm-temp/glm-5.2 (provider has compat but no supportsLongCacheRetention)",
    model: { provider: "atm-temp", id: "glm-5.2", api: "openai-completions" },
    expected: false,
    reason: "In models.json but supportsLongCacheRetention absent → strip",
  },
  {
    name: "hyb-ds/deepseek-v4 (provider false — explicit opt-out)",
    model: { provider: "hyb-ds", id: "deepseek-v4", api: "openai-completions" },
    expected: false,
    reason: "Provider-level false → user opted out, strip",
  },
  {
    name: "custom-prov/model-a (model-level true, no provider-level)",
    model: { provider: "custom-prov", id: "model-a", api: "openai-completions" },
    expected: true,
    reason: "Model-level true, no provider compat → user opted in, keep",
  },
  {
    name: "custom-prov/model-b (model-level false, no provider-level)",
    model: { provider: "custom-prov", id: "model-b", api: "openai-completions" },
    expected: false,
    reason: "Model-level false → user opted out, strip",
  },
  {
    name: "custom-prov/model-c (no compat at all)",
    model: { provider: "custom-prov", id: "model-c", api: "openai-completions" },
    expected: false,
    reason: "In models.json but no compat at all → strip",
  },
  {
    name: "nonexistent-provider/model (not in models.json)",
    model: { provider: "nonexistent", id: "model-1", api: "openai-completions" },
    expected: false,
    reason: "Not in models.json → safe default, strip",
  },
];

// ─── Gate ordering verification ──────────────────────────────────────

/**
 * Replicates the 4-gate before_provider_request logic.
 * Returns true if prompt_cache_retention should be KEPT, false if stripped.
 */
function shouldKeepPromptCacheRetention(
  isOfficialOpenAI: boolean,
  has400History: boolean,
  hasExplicitOptIn: boolean,
): boolean {
  // Gate 1: Official OpenAI → keep
  if (isOfficialOpenAI) return true;
  // Gate 2: 400 history → strip (overrides user opt-in!)
  if (has400History) return false;
  // Gate 3: Explicit user opt-in → keep
  if (hasExplicitOptIn) return true;
  // Gate 4: Safe default → strip
  return false;
}

const gateTestCases: Array<{
  name: string;
  isOfficialOpenAI: boolean;
  has400History: boolean;
  hasExplicitOptIn: boolean;
  expectedKeep: boolean;
  reason: string;
}> = [
  {
    name: "Official OpenAI (always keep)",
    isOfficialOpenAI: true,
    has400History: false,
    hasExplicitOptIn: false,
    expectedKeep: true,
    reason: "Gate 1: Official OpenAI → keep regardless of other flags",
  },
  {
    name: "Official OpenAI with 400 history (still keep — trusted)",
    isOfficialOpenAI: true,
    has400History: true,
    hasExplicitOptIn: false,
    expectedKeep: true,
    reason: "Gate 1: Official OpenAI → keep (400 detection shouldn't fire for official OpenAI anyway)",
  },
  {
    name: "Third-party with explicit opt-in, no 400 (keep)",
    isOfficialOpenAI: false,
    has400History: false,
    hasExplicitOptIn: true,
    expectedKeep: true,
    reason: "Gate 3: User explicitly opted in → keep",
  },
  {
    name: "Third-party with explicit opt-in AND 400 history (strip!)",
    isOfficialOpenAI: false,
    has400History: true,
    hasExplicitOptIn: true,
    expectedKeep: false,
    reason: "Gate 2 BEFORE Gate 3: 400 overrides user opt-in — prevents infinite 400 loop",
  },
  {
    name: "Third-party without opt-in, no 400 (strip — safe default)",
    isOfficialOpenAI: false,
    has400History: false,
    hasExplicitOptIn: false,
    expectedKeep: false,
    reason: "Gate 4: No opt-in → strip (prevents 400 for 400+ third-party models)",
  },
  {
    name: "Third-party without opt-in, with 400 history (strip)",
    isOfficialOpenAI: false,
    has400History: true,
    hasExplicitOptIn: false,
    expectedKeep: false,
    reason: "Gate 2: 400 history → strip",
  },
];

// ─── Run tests ───────────────────────────────────────────────────────

console.log("=== hasExplicitLongRetentionOptIn Tests ===\n");

let passed = 0;
let failed = 0;

for (const test of testCases) {
  const result = hasExplicitLongRetentionOptIn(test.model, MOCK_MODELS_JSON);
  const status = result === test.expected ? "✅ PASS" : "❌ FAIL";

  console.log(`${status} ${test.name}`);
  console.log(`  Expected: ${test.expected}, Got: ${result}`);
  if (result !== test.expected) {
    console.log(`  Reason: ${test.reason}`);
    failed++;
  } else {
    passed++;
  }
}

console.log(`\n=== Gate Ordering Tests ===\n`);

for (const test of gateTestCases) {
  const result = shouldKeepPromptCacheRetention(
    test.isOfficialOpenAI,
    test.has400History,
    test.hasExplicitOptIn,
  );
  const status = result === test.expectedKeep ? "✅ PASS" : "❌ FAIL";

  console.log(`${status} ${test.name}`);
  console.log(`  Expected keep: ${test.expectedKeep}, Got: ${result}`);
  if (result !== test.expectedKeep) {
    console.log(`  Reason: ${test.reason}`);
    failed++;
  } else {
    passed++;
  }
}

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}/${testCases.length + gateTestCases.length}`);
console.log(`Failed: ${failed}/${testCases.length + gateTestCases.length}`);

if (failed > 0) {
  console.log("\n❌ Some tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
}
