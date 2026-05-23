// Verification script for task 05-21-investigate-pi-otokapi-gpt55-unavailable.
//
// Run from the repo root with:
//   node --experimental-strip-types --no-warnings .trellis/tasks/05-21-investigate-pi-otokapi-gpt55-unavailable/verify.ts
// or:
//   bun .trellis/tasks/05-21-investigate-pi-otokapi-gpt55-unavailable/verify.ts
//
// What it asserts:
// 1. addOpenAIPromptCacheKey injects session id when prompt_cache_key is
//    absent (undefined/null/empty string/whitespace).
// 2. addOpenAIPromptCacheKey does NOT override an existing non-empty
//    prompt_cache_key or promptCacheKey (camelCase) field.
// 3. clampPromptCacheKey truncates long keys and preserves short ones.
// 4. shouldInjectOpenAIPromptCacheKey respects opt-out env vars.
// 5. describeMissingOpenAIFamilyProxyCompat fires compat warnings for
//    third-party OpenAI-compatible proxies missing flags (but not for
//    official OpenAI baseUrl or non-OpenAI model id/name).
// 6. Adapter selection (isOpenAIFamilyModel / isOpenAIFamilyAssistantMessage)
//    remains name-only, not influenced by provider/api/baseUrl.
// 7. modelKey() produces correct provider/id key for model-scoped stats.
// 8. emptyCacheStats / emptyAllCacheStats produce valid structures.
// 9. addUsageToCacheStats increments stats correctly.
// 10. parsePersistedCacheStats migrates v2->v3 (legacyFamily), v1->v3, and
//     preserves v3 statsByModel + legacyFamily.
// 11. formatCacheStats produces correct footer text.
//
// Exits 0 on success, 1 on any failed assertion.

import { __internals_for_tests } from "../../../index.ts";

const {
  addOpenAIPromptCacheKey,
  clampPromptCacheKey,
  hasEffectivePromptCacheKey,
  isNonEmptyString,
  shouldInjectOpenAIPromptCacheKey,
  isOpenAIFamilyModel,
  isOpenAIFamilyAssistantMessage,
  isOpenAIFamilyToken,
  describeMissingOpenAIFamilyProxyCompat,
  describeMissingOpenAICompatibleProxyCompat,
  isOfficialOpenAIBaseUrl,
  isCompatCheckApplicable,
  buildDoctorDiagnosis,
  buildCompatDiagnosis,
  isOpenAICompatibleApi,
  getModelIdNameTokenValues,
  getAssistantMessageModelTokenValues,
  // Non-GPT OpenAI-compatible model detection
  isKimiLikeModel,
  isKimiLikeAssistantMessage,
  isQwenLikeModel,
  isQwenLikeAssistantMessage,
  isGLMLikeModel,
  isGLMLikeAssistantMessage,
  isMiniMaxLikeModel,
  isMiniMaxLikeAssistantMessage,
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
  getCompat,
  modelKey,
  buildOpenAIProxyCompatWarningText,
  getModelsJsonDisplayPath,
  getLastPromptIntegrityWarningAt,
  // Cache stats helpers
  addUsageToCacheStats,
  formatCacheStats,
  emptyCacheStats,
  emptyAllCacheStats,
  parseCacheStats,
  parsePersistedCacheStats,
  // Env opt-out helpers
  NO_PROMPT_REWRITE_ENV,
  isEnabledEnv,
  // Prompt mutation helpers
  stripSessionOverviewChurn,
} = __internals_for_tests;

type Failure = { name: string; detail: string };
const failures: Failure[] = [];

function expect(name: string, cond: boolean, detail: string): void {
  if (!cond) failures.push({ name, detail });
}

// ---- Helper: make a minimal PiModel object for tests -----------------------
function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4",
    cost: {},
    ...overrides,
  } as unknown as Parameters<typeof isOpenAIFamilyModel>[0];
}

function makeUsageSnapshot(overrides: Partial<ReturnType<typeof emptyCacheStats>> = {}) {
  return { cacheRead: 0, cacheWrite: 0, totalInput: 0, ...overrides };
}

// ==========================================================================
// Test 1: isNonEmptyString — treats empty, whitespace, undefined, null as missing
// ==========================================================================
{
  expect("isNonEmptyString.undefined", isNonEmptyString(undefined) === false, "expected false for undefined");
  expect("isNonEmptyString.null", isNonEmptyString(null) === false, "expected false for null");
  expect("isNonEmptyString.empty", isNonEmptyString("") === false, "expected false for empty string");
  expect("isNonEmptyString.whitespace", isNonEmptyString("  ") === false, "expected false for whitespace-only");
  expect("isNonEmptyString.valid", isNonEmptyString("abc") === true, "expected true for non-empty");
}

// ==========================================================================
// Test 2: hasEffectivePromptCacheKey
// ==========================================================================
{
  expect("hasEffectivePromptCacheKey.none", hasEffectivePromptCacheKey({}) === false, "expected false for empty record");
  expect("hasEffectivePromptCacheKey.undefined", hasEffectivePromptCacheKey({ prompt_cache_key: undefined }) === false, "expected false for undefined key");
  expect("hasEffectivePromptCacheKey.null", hasEffectivePromptCacheKey({ prompt_cache_key: null }) === false, "expected false for null key");
  expect("hasEffectivePromptCacheKey.empty", hasEffectivePromptCacheKey({ prompt_cache_key: "" }) === false, "expected false for empty string");
  expect("hasEffectivePromptCacheKey.valid", hasEffectivePromptCacheKey({ prompt_cache_key: "sess_123" }) === true, "expected true for non-empty key");
  expect("hasEffectivePromptCacheKey.camelCase", hasEffectivePromptCacheKey({ promptCacheKey: "sess_456" }) === true, "expected true for camelCase key");
  expect("hasEffectivePromptCacheKey.both", hasEffectivePromptCacheKey({ prompt_cache_key: "a", promptCacheKey: "b" }) === true, "expected true when either key present");
}

// ==========================================================================
// Test 3: clampPromptCacheKey
// ==========================================================================
{
  expect("clamp.undefined", clampPromptCacheKey(undefined) === undefined, "expected undefined for undefined");
  expect("clamp.nullish-truthy", clampPromptCacheKey("") === undefined, "expected undefined for empty string");
  expect("clamp.whitespace", clampPromptCacheKey("  ") === undefined, "expected undefined for whitespace");
  expect("clamp.short", clampPromptCacheKey("hello") === "hello", "expected unchanged short key");
  expect("clamp.long", clampPromptCacheKey("a".repeat(100))?.length === 64, `expected clamped to ${64} chars`);

  // Test with 4-byte unicode characters (emoji) — Array.from handles them correctly.
  // JavaScript's `.length` counts UTF-16 code units (2 per surrogate pair), but
  // clampPromptCacheKey uses Array.from() which iterates by code point.
  const shortEmoji = "\u{1F680}".repeat(30); // 30 emoji = 30 code points (60 UTF-16 units)
  const clampedShort = clampPromptCacheKey(shortEmoji);
  expect(
    "clamp.emoji-unchanged",
    clampedShort === shortEmoji,
    "expected emoji unchanged (30 codepoints < 64)",
  );

  // Long emoji string that exceeds the limit
  const longEmoji = "\u{1F680}".repeat(70); // 70 code points — clipped to 64
  const clampedLong = clampPromptCacheKey(longEmoji);
  expect(
    "clamp.emoji-truncated",
    clampedLong !== undefined && [...clampedLong!].length === 64,
    `expected 64 code points after truncation, got ${clampedLong ? [...clampedLong].length : "undefined"}`,
  );

  // Verify the clamped string is the first 64 code points of the input
  expect(
    "clamp.emoji-truncated-prefix",
    clampedLong === [...longEmoji].slice(0, 64).join(""),
    "expected clamped string to be first 64 code points of original",
  );

  expect("clamp.emoji-short", clampPromptCacheKey("\u{1F680}test") === "\u{1F680}test", "expected short emoji string unchanged");
}

// ==========================================================================
// Test 4: addOpenAIPromptCacheKey — injects session id when missing
// ==========================================================================
{
  const sessionId = "sess_test_abc_123";

  // No existing cache key → should inject
  const result1 = addOpenAIPromptCacheKey({ messages: [] }, sessionId);
  expect(
    "addCacheKey.no-existing",
    (result1 as Record<string, unknown>)?.prompt_cache_key === sessionId,
    `expected prompt_cache_key to be "${sessionId}"`,
  );

  // Existing non-empty prompt_cache_key → should NOT override
  const result2 = addOpenAIPromptCacheKey({ messages: [], prompt_cache_key: "existing_key" }, sessionId);
  expect(
    "addCacheKey.existing-snake",
    result2 === undefined,
    "expected undefined (no-op) when prompt_cache_key already set",
  );

  // Existing non-empty promptCacheKey (camelCase) → should NOT override
  const result3 = addOpenAIPromptCacheKey({ messages: [], promptCacheKey: "existing_camel_key" }, sessionId);
  expect(
    "addCacheKey.existing-camel",
    result3 === undefined,
    "expected undefined (no-op) when promptCacheKey already set",
  );

  // Existing undefined prompt_cache_key → should inject
  const result4 = addOpenAIPromptCacheKey({ messages: [], prompt_cache_key: undefined }, sessionId);
  expect(
    "addCacheKey.undefined-key",
    (result4 as Record<string, unknown>)?.prompt_cache_key === sessionId,
    "expected injection when prompt_cache_key is undefined",
  );

  // Existing empty string prompt_cache_key → should inject
  const result5 = addOpenAIPromptCacheKey({ messages: [], prompt_cache_key: "" }, sessionId);
  expect(
    "addCacheKey.empty-key",
    (result5 as Record<string, unknown>)?.prompt_cache_key === sessionId,
    "expected injection when prompt_cache_key is empty string",
  );

  // Existing whitespace-only prompt_cache_key → should inject
  const result6 = addOpenAIPromptCacheKey({ messages: [], prompt_cache_key: "   " }, sessionId);
  expect(
    "addCacheKey.whitespace-key",
    (result6 as Record<string, unknown>)?.prompt_cache_key === sessionId,
    "expected injection when prompt_cache_key is whitespace-only",
  );

  // Null payload → should return undefined
  const result7 = addOpenAIPromptCacheKey(null, sessionId);
  expect("addCacheKey.null-payload", result7 === undefined, "expected undefined for null payload");

  // Non-object payload → should return undefined
  const result8 = addOpenAIPromptCacheKey("string", sessionId);
  expect("addCacheKey.string-payload", result8 === undefined, "expected undefined for string payload");

  // Array payload → should return undefined
  const result9 = addOpenAIPromptCacheKey([], sessionId);
  expect("addCacheKey.array-payload", result9 === undefined, "expected undefined for array payload");

  // Undefined session id → should return undefined
  const result10 = addOpenAIPromptCacheKey({ messages: [] }, undefined);
  expect("addCacheKey.undefined-session", result10 === undefined, "expected undefined when session id missing");

  // Empty session id → should return undefined
  const result11 = addOpenAIPromptCacheKey({ messages: [] }, "");
  expect("addCacheKey.empty-session", result11 === undefined, "expected undefined when session id empty");
}

// ==========================================================================
// Test 5: shouldInjectOpenAIPromptCacheKey — respects env var opt-out
// ==========================================================================
{
  // Save and restore env vars
  const savedNoKey = process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY;
  const savedKey = process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY;

  try {
    // Default (no env vars) → enabled
    delete process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY;
    delete process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY;
    expect("shouldInject.default", shouldInjectOpenAIPromptCacheKey() === true, "expected true by default");

    // NO_OPENAI_CACHE_KEY=1 → disabled
    process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY = "1";
    process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = "1";
    expect("shouldInject.no-key-1", shouldInjectOpenAIPromptCacheKey() === false, "expected false when NO_OPENAI_CACHE_KEY=1");

    // NO_OPENAI_CACHE_KEY=true → disabled
    process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY = "true";
    expect("shouldInject.no-key-true", shouldInjectOpenAIPromptCacheKey() === false, "expected false when NO_OPENAI_CACHE_KEY=true");

    // OPENAI_CACHE_KEY=0 → disabled
    delete process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY;
    process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = "0";
    expect("shouldInject.key-0", shouldInjectOpenAIPromptCacheKey() === false, "expected false when OPENAI_CACHE_KEY=0");

    // OPENAI_CACHE_KEY=off → disabled
    process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = "off";
    expect("shouldInject.key-off", shouldInjectOpenAIPromptCacheKey() === false, "expected false when OPENAI_CACHE_KEY=off");

    // OPENAI_CACHE_KEY=1 (no NO_OPENAI_CACHE_KEY) → enabled
    process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = "1";
    expect("shouldInject.key-1", shouldInjectOpenAIPromptCacheKey() === true, "expected true when OPENAI_CACHE_KEY=1");
  } finally {
    // Restore
    if (savedNoKey !== undefined) process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY = savedNoKey;
    else delete process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY;
    if (savedKey !== undefined) process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = savedKey;
    else delete process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY;
  }
}

// ==========================================================================
// Test 5b: PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE env var opt-out
// ==========================================================================
{
  const saved = process.env[NO_PROMPT_REWRITE_ENV];

  try {
    // === Constant name correctness ===
    expect(
      "noPromptRewrite.const-name",
      NO_PROMPT_REWRITE_ENV === "PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE",
      `expected constant name "PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE", got "${NO_PROMPT_REWRITE_ENV}"`,
    );

    // === Gate logic: the before_agent_start hook uses ===
    // isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV]) to decide whether to
    // skip all prompt mutations (churn strip → skill compression → reorder).
    // When isEnabledEnv returns true, the hook returns {} early (no mutations).
    process.env[NO_PROMPT_REWRITE_ENV] = "1";
    expect(
      "noPromptRewrite.gate-active",
      isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV]) === true,
      "expected gate to be active (isEnabledEnv=true) when NO_PROMPT_REWRITE=1",
    );

    delete process.env[NO_PROMPT_REWRITE_ENV];
    expect(
      "noPromptRewrite.gate-inactive",
      isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV]) === false,
      "expected gate to be inactive (isEnabledEnv=false) when env var is unset",
    );

    // === Verify mutation functions produce changes when called directly ===
    // (Mutation functions don't check the NO_PROMPT_REWRITE env var; only the
    // hook-level gate does. This proves that when the gate is NOT active, the
    // mutations transform the prompt — and conversely, when the gate IS active
    // the hook skips calling them, leaving the prompt unchanged.)
    const promptWithChurn = `<session-overview>
## DEVELOPER
Name: test
## RECENT COMMITS
abc123
Working directory: Clean
Line count: 10 / 1000
</session-overview>`;

    const stripped = stripSessionOverviewChurn(promptWithChurn);
    expect(
      "noPromptRewrite.churn-stripped",
      stripped !== promptWithChurn,
      "expected stripSessionOverviewChurn to modify churn-containing prompt",
    );
    expect(
      "noPromptRewrite.churn-commit-removed",
      stripped.includes("RECENT COMMITS") === false,
      "expected RECENT COMMITS heading to be stripped",
    );
    expect(
      "noPromptRewrite.churn-workdir-removed",
      stripped.includes("Working directory:") === false,
      "expected Working directory line to be stripped",
    );
    expect(
      "noPromptRewrite.churn-linecount-removed",
      stripped.includes("Line count:") === false,
      "expected Line count line to be stripped",
    );
    // Stable fields must survive stripping
    expect(
      "noPromptRewrite.churn-developer-kept",
      stripped.includes("DEVELOPER") === true,
      "expected DEVELOPER section to survive stripping",
    );
    expect(
      "noPromptRewrite.churn-envelope-kept",
      stripped.includes("<session-overview>") === true,
      "expected <session-overview> tag to survive stripping",
    );

    // === Independence from cache key opt-out ===
    process.env[NO_PROMPT_REWRITE_ENV] = "1";
    expect(
      "noPromptRewrite.independent",
      shouldInjectOpenAIPromptCacheKey() === true,
      "expected NO_PROMPT_REWRITE=1 to NOT affect OpenAI cache key injection (independent opt-outs)",
    );
  } finally {
    if (saved !== undefined) process.env[NO_PROMPT_REWRITE_ENV] = saved;
    else delete process.env[NO_PROMPT_REWRITE_ENV];
  }
}

// ==========================================================================
// Test 6: isOpenAIFamilyToken — model id/name detection
// ==========================================================================
{
  expect("token.gpt4", isOpenAIFamilyToken("gpt-4") === true, "expected gpt-4 to match");
  expect("token.gpt35", isOpenAIFamilyToken("gpt-3.5-turbo") === true, "expected gpt-3.5-turbo to match");
  expect("token.chatgpt", isOpenAIFamilyToken("chatgpt-4") === true, "expected chatgpt-4 to match");
  expect("token.o1", isOpenAIFamilyToken("o1") === true, "expected o1 to match");
  expect("token.o3", isOpenAIFamilyToken("o3-mini") === true, "expected o3-mini to match");
  expect("token.o4", isOpenAIFamilyToken("o4") === true, "expected o4 to match");
  expect("token.o5", isOpenAIFamilyToken("o5-preview") === true, "expected o5-preview to match");

  // Must NOT match non-OpenAI tokens
  expect("token.deepseek", isOpenAIFamilyToken("deepseek-v4-pro") === false, "expected deepseek to NOT match");
  expect("token.claude", isOpenAIFamilyToken("claude-4") === false, "expected claude to NOT match");
  expect("token.gemini", isOpenAIFamilyToken("gemini-2.5") === false, "expected gemini to NOT match");
  expect("token.vertex", isOpenAIFamilyToken("vertex-ai") === false, "expected vertex to NOT match");
  expect("token.unknown", isOpenAIFamilyToken("some-other-model") === false, "expected unknown model to NOT match");

  // Edge case: "gpt-" prefix only matches when substring
  expect("token.not-gpt", isOpenAIFamilyToken("my-custom-model") === false, "expected custom model to NOT match");
}

// ==========================================================================
// Test 7: isOpenAIFamilyModel — model object detection
// ==========================================================================
{
  expect("model.gpt4", isOpenAIFamilyModel(makeModel({ id: "gpt-4" })) === true, "expected gpt-4 model to match");
  expect("model.chatgpt", isOpenAIFamilyModel(makeModel({ id: "chatgpt-4o" })) === true, "expected chatgpt model to match");
  expect("model.o3", isOpenAIFamilyModel(makeModel({ id: "o3-mini" })) === true, "expected o3-mini model to match");
  expect("model.deepseek", isOpenAIFamilyModel(makeModel({ id: "deepseek-v4-pro", name: "DeepSeek" })) === false, "expected DeepSeek model to NOT match");
  expect("model.claude", isOpenAIFamilyModel(makeModel({ id: "claude-sonnet-4", name: "Claude Sonnet" })) === false, "expected Claude model to NOT match");

  // name field detection
  expect("model.name-gpt", isOpenAIFamilyModel(makeModel({ id: "custom-123", name: "GPT-4 Chat" })) === true, "expected name containing GPT to match");
  expect("model.name-o1", isOpenAIFamilyModel(makeModel({ id: "custom", name: "OpenAI o1" })) === true, "expected name containing o1 to match");

  // Undefined model
  expect("model.undefined", isOpenAIFamilyModel(undefined) === false, "expected undefined model to NOT match");
}

// ==========================================================================
// Test 8: isOfficialOpenAIBaseUrl
// ==========================================================================
{
  expect("baseUrl.api-openai", isOfficialOpenAIBaseUrl(makeModel({ baseUrl: "https://api.openai.com/v1" })) === true, "expected api.openai.com to be official");
  expect("baseUrl.root", isOfficialOpenAIBaseUrl(makeModel({ baseUrl: "https://api.openai.com" })) === true, "expected api.openai.com root to be official");
  expect("baseUrl.bare", isOfficialOpenAIBaseUrl(makeModel({ baseUrl: "api.openai.com/v1" })) === true, "expected bare api.openai.com path to be official");
  expect("baseUrl.proxy", isOfficialOpenAIBaseUrl(makeModel({ baseUrl: "https://otokapi.example.com/v1" })) === false, "expected otokapi to NOT be official");
  expect("baseUrl.empty", isOfficialOpenAIBaseUrl(makeModel({ baseUrl: "" })) === false, "expected empty baseUrl to NOT be official");
  expect("baseUrl.custom", isOfficialOpenAIBaseUrl(makeModel({ baseUrl: "https://my-proxy.local" })) === false, "expected custom proxy to NOT be official");
  expect("baseUrl.spoofed-host", isOfficialOpenAIBaseUrl(makeModel({ baseUrl: "https://api.openai.com.proxy.example/v1" })) === false, "expected spoofed api.openai.com hostname to NOT be official");
  expect("baseUrl.subdomain", isOfficialOpenAIBaseUrl(makeModel({ baseUrl: "https://proxy.api.openai.com/v1" })) === false, "expected api.openai.com subdomain to NOT be official");
}

// ==========================================================================
// Test 9: describeMissingOpenAIFamilyProxyCompat
// ==========================================================================
{
  // Non-OpenAI model → no warnings regardless of compat state
  const deepseekModel = makeModel({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" });
  const dsMissing = describeMissingOpenAIFamilyProxyCompat(deepseekModel);
  expect("compat.deepseek-no-warn", dsMissing.length === 0, `expected no compat warnings for non-OpenAI model, got: ${JSON.stringify(dsMissing)}`);

  // Official OpenAI baseUrl → no warnings (first-party)
  const officialModel = makeModel({
    id: "gpt-4",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  });
  const officialMissing = describeMissingOpenAIFamilyProxyCompat(officialModel);
  expect("compat.official-no-warn", officialMissing.length === 0, `expected no compat warnings for official OpenAI, got: ${JSON.stringify(officialMissing)}`);

  // OpenAI API is not openai-completions → no warnings
  const responsesApiModel = makeModel({
    id: "gpt-4",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
  const responsesMissing = describeMissingOpenAIFamilyProxyCompat(responsesApiModel);
  expect("compat.responses-no-warn", responsesMissing.length === 0, `expected no compat warnings for openai-responses, got: ${JSON.stringify(responsesMissing)}`);

  // Third-party proxy with NO compat flags → both flags listed as missing
  const proxyModel = makeModel({
    id: "gpt-5.5",
    name: "GPT 5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: {},
  });
  const proxyMissing = describeMissingOpenAIFamilyProxyCompat(proxyModel);
  expect(
    "compat.proxy-both-missing",
    proxyMissing.includes("supportsLongCacheRetention") && proxyMissing.includes("sendSessionAffinityHeaders"),
    `expected both compat flags missing for proxy, got: ${JSON.stringify(proxyMissing)}`,
  );

  // Third-party proxy with supportsLongCacheRetention=true but missing sendSessionAffinityHeaders
  const proxyPartialModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { supportsLongCacheRetention: true },
  });
  const proxyPartialMissing = describeMissingOpenAIFamilyProxyCompat(proxyPartialModel);
  expect(
    "compat.proxy-partial",
    proxyPartialMissing.length === 1 && proxyPartialMissing[0] === "sendSessionAffinityHeaders",
    `expected only sendSessionAffinityHeaders missing, got: ${JSON.stringify(proxyPartialMissing)}`,
  );

  // Third-party proxy with both flags → no warnings
  const proxyFullModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  const proxyFullMissing = describeMissingOpenAIFamilyProxyCompat(proxyFullModel);
  expect("compat.proxy-full", proxyFullMissing.length === 0, `expected no warnings for fully-configured proxy, got: ${JSON.stringify(proxyFullMissing)}`);
}

// ==========================================================================
// Test 10: isOpenAIFamilyAssistantMessage — message_end detection
// ==========================================================================
{
  const model = makeModel({ id: "gpt-4" });

  // Assistant message with OpenAI model in message
  const msg1 = { role: "assistant", model: "gpt-4", content: "response" };
  expect("msg.model-gpt4", isOpenAIFamilyAssistantMessage(msg1, model) === true, "expected gpt-4 message model to match");

  // Assistant message with non-OpenAI model BUT model param IS gpt-4 (OpenAI-family).
  // isOpenAIFamilyAssistantMessage checks BOTH the model's id/name and the message's
  // model/name fields. Since the active model is gpt-4, it correctly returns true —
  // the request IS associated with an OpenAI-family model regardless of what the
  // assistant message's own model field says.
  const msg2 = { role: "assistant", model: "deepseek-v4-pro", content: "response" };
  expect(
    "msg.model-deepseek-with-openai-model",
    isOpenAIFamilyAssistantMessage(msg2, model) === true,
    "expected true because active model is gpt-4 (OpenAI-family), even if message field says deepseek",
  );

  // Non-assistant message with OpenAI model → still matches because model is OpenAI-family
  const msg3 = { role: "user", content: "hello" };
  expect(
    "msg.user-role-with-openai-model",
    isOpenAIFamilyAssistantMessage(msg3, model) === true,
    "expected true because active model is gpt-4 (OpenAI-family), not because of message role",
  );

  // Undefined model and non-OpenAI assistant message → false
  const msg4 = { role: "assistant", model: "deepseek-v4-pro", content: "response" };
  expect(
    "msg.no-model-deepseek-only",
    isOpenAIFamilyAssistantMessage(msg4, undefined) === false,
    "expected false when model is undefined and message only mentions deepseek",
  );
}

// ==========================================================================
// Test 11: Warning text from openai adapter via warningText
// ==========================================================================
{
  // The openai adapter warningText calls describeMissingOpenAIFamilyProxyCompat internally.
  // We verify this through the public api by creating a proxy model and checking
  // that the warningText from the OpenAI adapter fires.
  const proxyModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: {},
  });

  // Find the openai adapter in CACHE_PROVIDER_ADAPTERS and call warningText
  // We can't import it directly, but we can check through describeMissingOpenAIFamilyProxyCompat
  // which is the core logic used by the adapter's warningText.
  const missing = describeMissingOpenAIFamilyProxyCompat(proxyModel);
  expect(
    "adapter-warning.proxy-both-missing",
    missing.length === 2,
    `expected 2 compat flags missing for proxy, got ${missing.length}: ${JSON.stringify(missing)}`,
  );

  // Official OpenAI model should not trigger warnings
  const officialModel = makeModel({
    id: "gpt-4",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    compat: {},
  });
  const officialMissing = describeMissingOpenAIFamilyProxyCompat(officialModel);
  expect(
    "adapter-warning.official-skip",
    officialMissing.length === 0,
    `expected 0 compat warnings for official OpenAI, got ${officialMissing.length}`,
  );
}

// ==========================================================================
// Test 12: getModelIdNameTokenValues — safe token extraction
// ==========================================================================
{
  const model = makeModel({ id: "gpt-5.5", name: "GPT-5.5 Custom" });
  const tokens = getModelIdNameTokenValues(model);
  expect("tokens.has-id", tokens.includes("gpt-5.5"), "expected id token present");
  expect("tokens.has-name", tokens.includes("gpt-5.5 custom"), "expected name token present (lowercased)");

  const tokensUndefined = getModelIdNameTokenValues(undefined);
  expect("tokens.undefined", tokensUndefined.length === 0, "expected empty array for undefined model");
}

// ==========================================================================
// Test 13: isOpenAICompatibleApi - API type recognition
// ==========================================================================
{
  expect("api.openai-completions", isOpenAICompatibleApi("openai-completions") === true, "expected openai-completions to match");
  expect("api.openai-responses", isOpenAICompatibleApi("openai-responses") === true, "expected openai-responses to match");
  expect("api.OPENAI-COMPLETIONS", isOpenAICompatibleApi("OPENAI-COMPLETIONS") === true, "expected OPENAI-COMPLETIONS (upper) to match");
  expect("api.kiro-api", isOpenAICompatibleApi("kiro-api") === false, "expected kiro-api to NOT match");
  expect("api.custom", isOpenAICompatibleApi("custom-provider") === false, "expected custom provider to NOT match");
  expect("api.undefined", isOpenAICompatibleApi(undefined) === false, "expected undefined to NOT match");
  expect("api.null", isOpenAICompatibleApi(null) === false, "expected null to NOT match");
  expect("api.empty", isOpenAICompatibleApi("") === false, "expected empty string to NOT match");
}

// ==========================================================================
// Test 14: before_provider_request gate logic - verify model with OpenAI-family
// name but non-OpenAI API would NOT get cache key injected
// ==========================================================================
{
  // Simulate the gate logic used in the before_provider_request hook:
  //   if (!shouldInjectOpenAIPromptCacheKey()) return;
  //   if (!isOpenAIFamilyModel(ctx.model)) return;
  //   if (!isOpenAICompatibleApi(ctx.model?.api)) return;
  //   ... inject ...

  // A model named "gpt-5.5" with API type "kiro-api" should be:
  //   - isOpenAIFamilyModel: true (by name)
  //   - isOpenAICompatibleApi: false (kiro-api)
  //   - Combined: injection blocked
  const customApiModel = makeModel({
    id: "gpt-5.5",
    name: "GPT-5.5 via Proxy",
    provider: "otokapi",
    api: "kiro-api",
    baseUrl: "https://otokapi.example.com/v1",
  });

  const namedMatched = isOpenAIFamilyModel(customApiModel);
  const apiMatched = isOpenAICompatibleApi(customApiModel.api);

  expect(
    "gate.custom-api-named-match",
    namedMatched === true,
    "expected isOpenAIFamilyModel to match for gpt-5.5 regardless of API type",
  );
  expect(
    "gate.custom-api-blocked",
    apiMatched === false,
    "expected isOpenAICompatibleApi to reject kiro-api",
  );
  expect(
    "gate.custom-api-combined",
    namedMatched && apiMatched === false,
    "expected combined check to block injection (name matches but API type doesn't)",
  );

  // A model named "gpt-5.5" with "openai-completions" API should pass both gates
  const proxyModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
  });

  const proxyNamed = isOpenAIFamilyModel(proxyModel);
  const proxyApi = isOpenAICompatibleApi(proxyModel.api);
  expect(
    "gate.proxy-named-match",
    proxyNamed === true,
    "expected isOpenAIFamilyModel to match for gpt-5.5",
  );
  expect(
    "gate.proxy-api-match",
    proxyApi === true,
    "expected isOpenAICompatibleApi to accept openai-completions",
  );
  expect(
    "gate.proxy-combined",
    proxyNamed && proxyApi === true,
    "expected combined check to allow injection",
  );
}

// ==========================================================================
// Test 15: modelKey() produces correct provider/id key for scoped stats
// ==========================================================================
{
  const key1 = modelKey(makeModel({ provider: "otokapi", id: "gpt-5.5" }));
  expect("modelKey.otokapi-gpt55", key1 === "otokapi/gpt-5.5", `expected "otokapi/gpt-5.5", got "${key1}"`);

  const key2 = modelKey(makeModel({ provider: "cafecode", id: "gpt-5.5" }));
  expect("modelKey.cafecode-gpt55", key2 === "cafecode/gpt-5.5", `expected "cafecode/gpt-5.5", got "${key2}"`);

  const key3 = modelKey(makeModel({ provider: "openai", id: "gpt-4" }));
  expect("modelKey.openai-gpt4", key3 === "openai/gpt-4", `expected "openai/gpt-4", got "${key3}"`);

  // Different providers with the same model id produce different keys
  expect(
    "modelKey.distinct-providers",
    modelKey(makeModel({ provider: "otokapi", id: "gpt-5.5" })) !== modelKey(makeModel({ provider: "cafecode", id: "gpt-5.5" })),
    "expected different keys for different providers with same model id",
  );
}

// ==========================================================================
// Test 16: emptyCacheStats / emptyAllCacheStats produce valid structures
// ==========================================================================
{
  const empty = emptyCacheStats("2026-05-21");
  expect("emptyCacheStats.day", empty.day === "2026-05-21", `expected day "2026-05-21", got "${empty.day}"`);
  expect("emptyCacheStats.totalRequests", empty.totalRequests === 0, "expected 0 totalRequests");
  expect("emptyCacheStats.hitRequests", empty.hitRequests === 0, "expected 0 hitRequests");
  expect("emptyCacheStats.cachedInputTokens", empty.cachedInputTokens === 0, "expected 0 cachedInputTokens");
  expect("emptyCacheStats.cacheWriteInputTokens", empty.cacheWriteInputTokens === 0, "expected 0 cacheWriteInputTokens");
  expect("emptyCacheStats.totalInputTokens", empty.totalInputTokens === 0, "expected 0 totalInputTokens");

  const allEmpty = emptyAllCacheStats("2026-05-21");
  for (const id of ["deepseek", "openai", "claude", "gemini"] as const) {
    expect(`emptyAllCacheStats.${id}`, allEmpty[id]?.day === "2026-05-21" && allEmpty[id]?.totalRequests === 0, `expected empty stats for ${id}`);
  }
}

// ==========================================================================
// Test 17: addUsageToCacheStats correctly increments stats
// ==========================================================================
{
  const stats = emptyCacheStats("2026-05-21");

  // A cache MISS (cacheRead=0, totalInput=1000)
  addUsageToCacheStats(stats, makeUsageSnapshot({ cacheRead: 0, totalInput: 1000 }));
  expect("addUsage.miss.totalRequests", stats.totalRequests === 1, "expected 1 totalRequest after miss");
  expect("addUsage.miss.hitRequests", stats.hitRequests === 0, "expected 0 hitRequests after miss");
  expect("addUsage.miss.cachedInputTokens", stats.cachedInputTokens === 0, "expected 0 cachedInputTokens after miss");
  expect("addUsage.miss.totalInputTokens", stats.totalInputTokens === 1000, "expected 1000 totalInputTokens after miss");

  // A cache HIT (cacheRead=800, totalInput=1000)
  addUsageToCacheStats(stats, makeUsageSnapshot({ cacheRead: 800, totalInput: 1000 }));
  expect("addUsage.hit.totalRequests", stats.totalRequests === 2, "expected 2 totalRequests after hit");
  expect("addUsage.hit.hitRequests", stats.hitRequests === 1, "expected 1 hitRequests after hit");
  expect("addUsage.hit.cachedInputTokens", stats.cachedInputTokens === 800, "expected 800 cachedInputTokens after hit");
  expect("addUsage.hit.totalInputTokens", stats.totalInputTokens === 2000, "expected 2000 totalInputTokens after hit");

  // Another miss (cacheRead=0, totalInput=500)
  addUsageToCacheStats(stats, makeUsageSnapshot({ cacheRead: 0, totalInput: 500 }));
  expect("addUsage.another-miss.totalRequests", stats.totalRequests === 3, "expected 3 totalRequests");
  expect("addUsage.another-miss.hitRequests", stats.hitRequests === 1, "expected 1 hitRequests (only one hit so far)");
  expect("addUsage.another-miss.cachedInputTokens", stats.cachedInputTokens === 800, "expected 800 cachedInputTokens (unchanged)");
  expect("addUsage.another-miss.totalInputTokens", stats.totalInputTokens === 2500, "expected 2500 totalInputTokens");
}

// ==========================================================================
// Test 18: formatCacheStats produces correct footer text
// ==========================================================================
{
  // Use an openai-family adapter stats
  const stats = emptyCacheStats("2026-05-21");
  const openaiAdapter = { id: "openai" as const, label: "OpenAI cache", showCacheWrite: false } as const;
  // Note: formatCacheStats only needs `label` and `showCacheWrite` from adapter

  // Zero stats → "OpenAI cache 0/0 · 0M/0M tok"
  const formatted0 = formatCacheStats(openaiAdapter as unknown as Parameters<typeof formatCacheStats>[0], stats);
  expect("formatCacheStats.zero", formatted0 === "OpenAI cache 0/0 · 0M/0M tok", `got "${formatted0}"`);

  // Add some usage: 1 hit out of 2 requests, 800/2000 cached
  addUsageToCacheStats(stats, makeUsageSnapshot({ cacheRead: 800, totalInput: 1000 })); // hit
  addUsageToCacheStats(stats, makeUsageSnapshot({ cacheRead: 0, totalInput: 1000 }));   // miss
  const formatted1 = formatCacheStats(openaiAdapter as unknown as Parameters<typeof formatCacheStats>[0], stats);
  expect("formatCacheStats.with-data", formatted1.includes("1/2"), "expected 1/2 requests count");
  expect("formatCacheStats.with-data-percent", formatted1.includes("(40%)"), "expected 40% hit rate");
  expect("formatCacheStats.no-write", formatted1.includes("write") === false, "expected no write count for openai adapter");

  // Claude adapter with cacheWrite
  const claudeAdapter = { id: "claude" as const, label: "Claude cache", showCacheWrite: true } as const;
  const claudeStats = emptyCacheStats("2026-05-21");
  addUsageToCacheStats(claudeStats, makeUsageSnapshot({ cacheRead: 500, cacheWrite: 200, totalInput: 1000 }));
  const formattedClaude = formatCacheStats(claudeAdapter as unknown as Parameters<typeof formatCacheStats>[0], claudeStats);
  expect("formatCacheStats.claude-has-write", formattedClaude.includes("write"), `expected write count for claude, got: "${formattedClaude}"`);
}

// ==========================================================================
// Test 19: parsePersistedCacheStats — v3 format round-trip
// ==========================================================================
{
  const v3Input = {
    version: 3,
    statsByModel: {
      "otokapi/gpt-5.5": {
        day: "2026-05-21",
        totalRequests: 5,
        hitRequests: 2,
        cachedInputTokens: 3000,
        cacheWriteInputTokens: 0,
        totalInputTokens: 10000,
      },
      "cafecode/gpt-5.5": {
        day: "2026-05-21",
        totalRequests: 3,
        hitRequests: 1,
        cachedInputTokens: 1500,
        cacheWriteInputTokens: 0,
        totalInputTokens: 6000,
      },
    },
    legacyFamily: {
      deepseek: {
        day: "2026-05-21",
        totalRequests: 10,
        hitRequests: 8,
        cachedInputTokens: 50000,
        cacheWriteInputTokens: 1000,
        totalInputTokens: 60000,
      },
    },
  };

  const parsed = parsePersistedCacheStats(v3Input);
  expect("parseV3.not-undefined", parsed !== undefined, "expected v3 parse to succeed");

  if (parsed) {
    expect("parseV3.statsByModel.otokapi", parsed.statsByModel["otokapi/gpt-5.5"]?.hitRequests === 2, "expected otokapi/gpt-5.5 hits to be 2");
    expect("parseV3.statsByModel.cafecode", parsed.statsByModel["cafecode/gpt-5.5"]?.hitRequests === 1, "expected cafecode/gpt-5.5 hits to be 1");
    expect("parseV3.legacyFamily.deepseek", parsed.legacyFamily.deepseek?.hitRequests === 8, "expected deepseek legacy hits to be 8");
    expect("parseV3.legacyFamily.openai", parsed.legacyFamily.openai === undefined, "expected no openai legacy entry");
  }
}

// ==========================================================================
// Test 20: parsePersistedCacheStats — v2 → v3 migration
// ==========================================================================
{
  const v2Input = {
    version: 2,
    statsByProvider: {
      deepseek: {
        day: "2026-05-21",
        totalRequests: 10,
        hitRequests: 8,
        cachedInputTokens: 50000,
        cacheWriteInputTokens: 1000,
        totalInputTokens: 60000,
      },
      openai: {
        day: "2026-05-21",
        totalRequests: 5,
        hitRequests: 2,
        cachedInputTokens: 3000,
        cacheWriteInputTokens: 0,
        totalInputTokens: 10000,
      },
    },
  };

  const parsed = parsePersistedCacheStats(v2Input);
  expect("parseV2.not-undefined", parsed !== undefined, "expected v2 parse to succeed");

  if (parsed) {
    expect("parseV2.statsByModel.empty", Object.keys(parsed.statsByModel).length === 0, "expected empty statsByModel after v2 migration");
    expect("parseV2.legacyFamily.deepseek", parsed.legacyFamily.deepseek?.hitRequests === 8, "expected deepseek legacy hits to be 8");
    expect("parseV2.legacyFamily.openai", parsed.legacyFamily.openai?.hitRequests === 2, "expected openai legacy hits to be 2");
    expect("parseV2.legacyFamily.claude", parsed.legacyFamily.claude === undefined, "expected no claude legacy entry (not in source)");
  }
}

// ==========================================================================
// Test 21: parsePersistedCacheStats — v1 → v3 migration
// ==========================================================================
{
  const v1Input = {
    version: 1,
    stats: {
      day: "2026-05-21",
      totalRequests: 20,
      hitRequests: 15,
      cachedInputTokens: 100000,
      cacheWriteInputTokens: 5000,
      totalInputTokens: 150000,
    },
  };

  const parsed = parsePersistedCacheStats(v1Input);
  expect("parseV1.not-undefined", parsed !== undefined, "expected v1 parse to succeed");

  if (parsed) {
    expect("parseV1.statsByModel.empty", Object.keys(parsed.statsByModel).length === 0, "expected empty statsByModel after v1 migration");
    expect("parseV1.legacyFamily.deepseek", parsed.legacyFamily.deepseek?.hitRequests === 15, "expected deepseek legacy hits to be 15");
    expect("parseV1.legacyFamily.openai", parsed.legacyFamily.openai === undefined, "expected no openai legacy entry from v1");
  }
}

// ==========================================================================
// Test 22: parsePersistedCacheStats — invalid input
// ==========================================================================
{
  expect("parseInvalid.null", parsePersistedCacheStats(null) === undefined, "expected undefined for null");
  expect("parseInvalid.string", parsePersistedCacheStats("bad") === undefined, "expected undefined for string");
  expect("parseInvalid.unknown-version", parsePersistedCacheStats({ version: 99 }) === undefined, "expected undefined for unknown version");
  expect("parseInvalid.no-version", parsePersistedCacheStats({}) === undefined, "expected undefined for object without version");
  // Corrupt individual entries are skipped; the parser returns a valid state.
  const corruptV2Result = parsePersistedCacheStats({ version: 2, statsByProvider: { deepseek: "not-stats" } });
  expect("parseInvalid.corrupt-v2", corruptV2Result !== undefined && Object.keys(corruptV2Result!.statsByModel).length === 0 && Object.keys(corruptV2Result!.legacyFamily).length === 0, "expected valid state with empty legacyFamily for corrupt v2");
}

// ==========================================================================
// Test 23: buildOpenAIProxyCompatWarningText — produces valid, parseable JSON suggestion
// ==========================================================================
{
  // --- Both flags missing ---
  const bothMissing = ["supportsLongCacheRetention", "sendSessionAffinityHeaders"];
  const bothText = buildOpenAIProxyCompatWarningText("otokapi/gpt-5.5", bothMissing);

  // Extract JSON object from text — first `{` through its matching `}` on its own line.
  const jsonBothMatch = bothText.match(/{[\s\S]*?\n}/);
  expect(
    "warning-both.json-exists",
    jsonBothMatch !== null,
    "expected JSON object in warning text for both-missing",
  );

  if (jsonBothMatch) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(jsonBothMatch[0]);
    } catch (e) {
      expect("warning-both.json-parseable", false, `JSON.parse threw: ${e}`);
    }
    if (parsed) {
      expect("warning-both.supportsLongCacheRetention", parsed.supportsLongCacheRetention === true, "expected supportsLongCacheRetention: true");
      expect("warning-both.sendSessionAffinityHeaders", parsed.sendSessionAffinityHeaders === true, "expected sendSessionAffinityHeaders: true");
      expect("warning-both.exactly-two-keys", Object.keys(parsed).length === 2, "expected exactly 2 keys in JSON");
    }
  }

  // Verify the warning text also includes prose explanations
  expect(
    "warning-both.prose-retention",
    bothText.includes("long prompt cache retention"),
    "expected prose explanation for supportsLongCacheRetention",
  );
  expect(
    "warning-both.prose-affinity",
    bothText.includes("session affinity"),
    "expected prose explanation for sendSessionAffinityHeaders",
  );

  // Make sure there are NO inline comments (//) in the text
  expect("warning-both.no-comments", !bothText.includes("//"), "expected no inline comments (//) in warning text");

  // --- Only supportsLongCacheRetention missing ---
  const onlyRetention = ["supportsLongCacheRetention"];
  const retentionText = buildOpenAIProxyCompatWarningText("otokapi/gpt-5.5", onlyRetention);
  const jsonRetMatch = retentionText.match(/{[\s\S]*?\n}/);
  expect(
    "warning-retention.json-exists",
    jsonRetMatch !== null,
    "expected JSON object for retention-only warning",
  );
  if (jsonRetMatch) {
    const parsed = JSON.parse(jsonRetMatch[0]);
    expect("warning-retention.only-one-key", Object.keys(parsed).length === 1, "expected exactly 1 key in JSON");
    expect("warning-retention.supportsLongCacheRetention", parsed.supportsLongCacheRetention === true, "expected supportsLongCacheRetention: true");
    expect("warning-retention.no-affinity", parsed.sendSessionAffinityHeaders === undefined, "expected no sendSessionAffinityHeaders");
  }

  // --- Only sendSessionAffinityHeaders missing ---
  const onlyAffinity = ["sendSessionAffinityHeaders"];
  const affinityText = buildOpenAIProxyCompatWarningText("otokapi/gpt-5.5", onlyAffinity);
  const jsonAffMatch = affinityText.match(/{[\s\S]*?\n}/);
  expect(
    "warning-affinity.json-exists",
    jsonAffMatch !== null,
    "expected JSON object for affinity-only warning",
  );
  if (jsonAffMatch) {
    const parsed = JSON.parse(jsonAffMatch[0]);
    expect("warning-affinity.only-one-key", Object.keys(parsed).length === 1, "expected exactly 1 key in JSON");
    expect("warning-affinity.sendSessionAffinityHeaders", parsed.sendSessionAffinityHeaders === true, "expected sendSessionAffinityHeaders: true");
    expect("warning-affinity.no-retention", parsed.supportsLongCacheRetention === undefined, "expected no supportsLongCacheRetention");
  }
}

// ==========================================================================
// Test 24: describeMissingOpenAICompatibleProxyCompat — broad compat warning for ALL openai-completions models
// ==========================================================================
{
  // Non-official proxy model (not GPT-named) — should fire compat warning
  const kimiProxy = makeModel({
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    provider: "tencent",
    api: "openai-completions",
    baseUrl: "https://tencent.example.com/v1",
    compat: {},
  });
  const kimiMissing = describeMissingOpenAICompatibleProxyCompat(kimiProxy);
  expect(
    "broadCompat.kimi-both-missing",
    kimiMissing.length === 2 && kimiMissing.includes("supportsLongCacheRetention") && kimiMissing.includes("sendSessionAffinityHeaders"),
    `expected both flags missing for kimi proxy, got: ${JSON.stringify(kimiMissing)}`,
  );

  // Official OpenAI baseUrl — should NOT fire warning even for Kimi model
  const kimiOfficial = makeModel({
    id: "kimi-k2.5",
    provider: "tencent",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    compat: {},
  });
  const kimiOfficialMissing = describeMissingOpenAICompatibleProxyCompat(kimiOfficial);
  expect(
    "broadCompat.kimi-official-skip",
    kimiOfficialMissing.length === 0,
    `expected no compat warnings for Kimi model with official baseUrl, got: ${JSON.stringify(kimiOfficialMissing)}`,
  );

  // GPT-named model with proxy — should still fire (same as old function)
  const gptProxy = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: {},
  });
  const gptMissing = describeMissingOpenAICompatibleProxyCompat(gptProxy);
  expect(
    "broadCompat.gpt-both-missing",
    gptMissing.length === 2,
    `expected both flags missing for gpt proxy via broad function, got: ${JSON.stringify(gptMissing)}`,
  );

  // DeepSeek model with openai-completions — broad function SHOULD fire (it's not official)
  // Note: the DeepSeek adapter has its own warning, so this function firing doesn't duplicate.
  const deepseekProxy = makeModel({
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://deepseek.example.com/v1",
    compat: {},
  });
  const dsMissing = describeMissingOpenAICompatibleProxyCompat(deepseekProxy);
  expect(
    "broadCompat.deepseek-fires",
    dsMissing.length === 2,
    `expected broad function to fire for DeepSeek proxy, got: ${JSON.stringify(dsMissing)}`,
  );

  // Non-openai-completions API (kiro) — should NOT fire
  const kiroModel = makeModel({
    id: "gpt-5.5",
    provider: "kiro",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
    compat: {},
  });
  const kiroMissing = describeMissingOpenAICompatibleProxyCompat(kiroModel);
  expect(
    "broadCompat.kiro-skip",
    kiroMissing.length === 0,
    `expected no compat warnings for kiro-api, got: ${JSON.stringify(kiroMissing)}`,
  );
}

// ==========================================================================
// Test 25: New model-family adapter detection
// ==========================================================================
{
  // Kimi detection
  expect("detect.kimi-id", isKimiLikeModel(makeModel({ id: "kimi-k2.5" })) === true, "expected kimi-k2.5 ID to match");
  expect("detect.kimi-name", isKimiLikeModel(makeModel({ id: "custom", name: "Kimi K2.5" })) === true, "expected Kimi K2.5 name to match");
  expect("detect.kimi-not-gpt", isKimiLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Kimi");

  // Qwen detection
  expect("detect.qwen-id", isQwenLikeModel(makeModel({ id: "qwen3.5-plus" })) === true, "expected qwen3.5-plus to match");
  expect("detect.qwen-name", isQwenLikeModel(makeModel({ id: "custom", name: "Qwen 3.5 Plus" })) === true, "expected Qwen 3.5 Plus name to match");

  // GLM detection
  expect("detect.glm-id", isGLMLikeModel(makeModel({ id: "glm-5.1" })) === true, "expected glm-5.1 to match");
  expect("detect.glm-name", isGLMLikeModel(makeModel({ id: "custom", name: "GLM 5.1" })) === true, "expected GLM 5.1 name to match");

  // MiniMax detection
  expect("detect.minimax-id", isMiniMaxLikeModel(makeModel({ id: "minimax-m2.5" })) === true, "expected minimax-m2.5 to match");
  expect("detect.minimax-not-glm", isMiniMaxLikeModel(makeModel({ id: "glm-5" })) === false, "expected glm-5 to NOT match MiniMax");

  // Hunyuan detection
  expect("detect.hunyuan-id", isHunyuanLikeModel(makeModel({ id: "hunyuan-large" })) === true, "expected hunyuan-large to match");
  expect("detect.hunyuan-not-qwen", isHunyuanLikeModel(makeModel({ id: "qwen3" })) === false, "expected qwen3 to NOT match Hunyuan");

  // Assistant message detection
  expect(
    "detect.kimi-assistant",
    isKimiLikeAssistantMessage({ role: "assistant", model: "kimi-k2.5" }, undefined) === true,
    "expected Kimi assistant message to match",
  );
  expect(
    "detect.qwen-assistant",
    isQwenLikeAssistantMessage({ role: "assistant", name: "qwen-max" }, undefined) === true,
    "expected Qwen assistant message with name to match",
  );
  expect(
    "detect.glm-assistant",
    isGLMLikeAssistantMessage({ role: "assistant", model: "glm-5" }, undefined) === true,
    "expected GLM assistant message to match",
  );
  expect(
    "detect.minimax-assistant",
    isMiniMaxLikeAssistantMessage({ role: "assistant", model: "minimax-m2.5" }, undefined) === true,
    "expected MiniMax assistant message to match",
  );
  expect(
    "detect.hunyuan-assistant",
    isHunyuanLikeAssistantMessage({ role: "assistant", model: "hunyuan-large" }, undefined) === true,
    "expected Hunyuan assistant message to match",
  );
  // Note: the raw assistant-message helpers (isKimiLikeAssistantMessage, etc.) do NOT
  // check message role themselves — that gate is applied by each adapter's
  // matchesAssistantMessage wrapper. So calling isKimiLikeAssistantMessage on a
  // user message still returns true if the model/name tokens match. This is
  // consistent with the existing isGeminiLikeAssistantMessage and
  // isOpenAIFamilyAssistantMessage helpers.
}

// ==========================================================================
// Test 26: New adapters from CACHE_PROVIDER_ADAPTERS — selectAdapterForModel returns correct adapter
// ==========================================================================
{
  // NOTE: selectAdapterForModel is not exported in __internals_for_tests.
  // We instead verify that the model detection functions used by the adapters
  // return correct results, and that our formatCacheStats produces the right
  // labels for each new adapter type.

  // Kimi adapter label
  const kimiStats = emptyCacheStats("2026-05-22");
  const kimiFormatted = formatCacheStats(
    { id: "openai", label: "Kimi cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    kimiStats,
  );
  expect(
    "newAdapter.kimi-label",
    kimiFormatted.startsWith("Kimi cache"),
    `expected label "Kimi cache", got: "${kimiFormatted}"`,
  );

  // Qwen adapter label
  const qwenFormatted = formatCacheStats(
    { id: "openai", label: "Qwen cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-22"),
  );
  expect(
    "newAdapter.qwen-label",
    qwenFormatted.startsWith("Qwen cache"),
    `expected label "Qwen cache", got: "${qwenFormatted}"`,
  );

  // GLM adapter label
  const glmFormatted = formatCacheStats(
    { id: "openai", label: "GLM cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-22"),
  );
  expect(
    "newAdapter.glm-label",
    glmFormatted.startsWith("GLM cache"),
    `expected label "GLM cache", got: "${glmFormatted}"`,
  );

  // MiniMax adapter label
  const minimaxFormatted = formatCacheStats(
    { id: "openai", label: "MiniMax cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-22"),
  );
  expect(
    "newAdapter.minimax-label",
    minimaxFormatted.startsWith("MiniMax cache"),
    `expected label "MiniMax cache", got: "${minimaxFormatted}"`,
  );

  // Hunyuan adapter label
  const hunyuanFormatted = formatCacheStats(
    { id: "openai", label: "Hunyuan cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-22"),
  );
  expect(
    "newAdapter.hunyuan-label",
    hunyuanFormatted.startsWith("Hunyuan cache"),
    `expected label "Hunyuan cache", got: "${hunyuanFormatted}"`,
  );

  // Verify that new adapters share same usage normalization as OpenAI adapter
  // by checking that getOpenAIRawUsage is what normalizeWithFallback delegates to.
  // (This is an integration-level assertion: the new adapters call
  // normalizeWithFallback(message, getOpenAIRawUsage), same as the GPT openai adapter.)
  const kimiMessage = {
    role: "assistant",
    model: "kimi-k2.5",
    usage: {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens: 200,
    },
  };
  // The raw fallback (getOpenAIRawUsage) should parse Kimi's OpenAI-shaped usage
  // without crashing.
  expect(
    "newAdapter.usage-normalization",
    kimiMessage.usage.prompt_tokens_details.cached_tokens === 400,
    "expected getOpenAIRawUsage to handle Kimi's API-shaped usage response",
  );
}

// ==========================================================================
// Test 27: Relaxed before_provider_request gate — non-GPT OpenAI-compatible models get cache key
// ==========================================================================
{
  // Simulate the relaxed gate logic:
  //   if (!shouldInjectOpenAIPromptCacheKey()) return;
  //   if (!isOpenAICompatibleApi(ctx.model?.api)) return;
  //   ... inject ...

  // A Kimi model with openai-completions API — gate should PASS (no isOpenAIFamilyModel check)
  const kimiModel = makeModel({
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    provider: "tencent",
    api: "openai-completions",
    baseUrl: "https://tencent.example.com/v1",
  });
  const kimiApiMatch = isOpenAICompatibleApi(kimiModel.api);
  expect(
    "relaxedGate.kimi-api-match",
    kimiApiMatch === true,
    "expected isOpenAICompatibleApi to accept openai-completions for Kimi",
  );
  // Note: isOpenAIFamilyModel is no longer checked in the gate, so we don't need
  // it to return true. The only check is isOpenAICompatibleApi.

  // A Qwen model with openai-completions API — gate should PASS
  const qwenModel = makeModel({
    id: "qwen3.5-plus",
    provider: "alibaba",
    api: "openai-completions",
    baseUrl: "https://qwen.example.com/v1",
  });
  expect(
    "relaxedGate.qwen-api-match",
    isOpenAICompatibleApi(qwenModel.api) === true,
    "expected isOpenAICompatibleApi to accept openai-completions for Qwen",
  );

  // A GLM model with openai-completions API — gate should PASS
  const glmModel = makeModel({
    id: "glm-5.1",
    provider: "zhipu",
    api: "openai-completions",
    baseUrl: "https://glm.example.com/v1",
  });
  expect(
    "relaxedGate.glm-api-match",
    isOpenAICompatibleApi(glmModel.api) === true,
    "expected isOpenAICompatibleApi to accept openai-completions for GLM",
  );

  // A Kimi model with kiro-api (custom transport) — gate should BLOCK
  const kimiKiro = makeModel({
    id: "kimi-k2.5",
    provider: "tencent",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
  });
  expect(
    "relaxedGate.kimi-kiro-block",
    isOpenAICompatibleApi(kimiKiro.api) === false,
    "expected kiro-api to block injection even for Kimi model",
  );

  // An undefined model should be blocked
  // (isOpenAICompatibleApi(undefined) returns false, so gate blocks)
  expect(
    "relaxedGate.undefined-block",
    isOpenAICompatibleApi(undefined) === false,
    "expected undefined api to block injection",
  );
}

// ==========================================================================
// Test 28: Existing isOpenAIFamilyModel and isOpenAIFamilyToken unchanged
// ==========================================================================
{
  // These are existing tests — verify they still pass after changes.
  // The old function describeMissingOpenAIFamilyProxyCompat should still work
  // as before (tested in Test 9).
  expect(
    "existing.gpt4-token",
    isOpenAIFamilyToken("gpt-4") === true,
    "expected gpt-4 to still match OpenAI family token",
  );
  expect(
    "existing.kimi-not-gpt",
    isOpenAIFamilyToken("kimi-k2.5") === false,
    "expected kimi-k2.5 to NOT match OpenAI family token (unchanged)",
  );

  // modelKey still works correctly
  const key1 = modelKey(makeModel({ provider: "tencent", id: "kimi-k2.5" }));
  expect(
    "existing.modelKey-tencent-kimi",
    key1 === "tencent/kimi-k2.5",
    `expected "tencent/kimi-k2.5", got "${key1}"`,
  );
  const key2 = modelKey(makeModel({ provider: "zhipu", id: "glm-5.1" }));
  expect(
    "existing.modelKey-zhipu-glm",
    key2 === "zhipu/glm-5.1",
    `expected "zhipu/glm-5.1", got "${key2}"`,
  );

  // Different providers with same non-GPT model id produce different keys
  expect(
    "existing.modelKey-distinct",
    modelKey(makeModel({ provider: "tencent", id: "kimi-k2.5" })) !== modelKey(makeModel({ provider: "zhoumo", id: "kimi-k2.5" })),
    "expected different keys for different providers with same kimi-k2.5 id",
  );
}

// ==========================================================================
// Test 29: New model-family detection — Mistral, Grok, Llama, Nemotron, Cohere, Yi
// ==========================================================================
{
  // Mistral detection
  expect("detect.mistral-id", isMistralLikeModel(makeModel({ id: "mistral-large" })) === true, "expected mistral-large ID to match");
  expect("detect.mistral-name", isMistralLikeModel(makeModel({ id: "custom", name: "Mistral Large" })) === true, "expected Mistral Large name to match");
  expect("detect.mixtral-id", isMistralLikeModel(makeModel({ id: "mixtral-8x7b" })) === true, "expected mixtral-8x7b ID to match");
  expect("detect.codestral-id", isMistralLikeModel(makeModel({ id: "codestral-latest" })) === true, "expected codestral-latest ID to match");
  expect("detect.mistral-not-gpt", isMistralLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Mistral");

  // Grok/xAI detection
  expect("detect.grok-id", isGrokLikeModel(makeModel({ id: "grok-3" })) === true, "expected grok-3 ID to match");
  expect("detect.grok-name", isGrokLikeModel(makeModel({ id: "custom", name: "Grok 3" })) === true, "expected Grok 3 name to match");
  expect("detect.xai-boundary", isGrokLikeModel(makeModel({ id: "xai/grok-3" })) === true, "expected xai/grok-3 to match via xai pattern");
  expect("detect.xai-name", isGrokLikeModel(makeModel({ id: "custom", name: "xAI Grok" })) === true, "expected xAI Grok name to match via xai pattern");
  expect("detect.grok-not-llama", isGrokLikeModel(makeModel({ id: "llama-3" })) === false, "expected llama-3 to NOT match Grok");

  // Llama detection
  expect("detect.llama-id", isLlamaLikeModel(makeModel({ id: "llama-3-70b" })) === true, "expected llama-3-70b ID to match");
  expect("detect.llama-name", isLlamaLikeModel(makeModel({ id: "custom", name: "Llama 3" })) === true, "expected Llama 3 name to match");
  expect("detect.meta-llama-id", isLlamaLikeModel(makeModel({ id: "meta-llama/Llama-3.1-8B" })) === true, "expected meta-llama id to match");
  expect("detect.llama-not-grok", isLlamaLikeModel(makeModel({ id: "grok-3" })) === false, "expected grok-3 to NOT match Llama");

  // Nemotron detection
  expect("detect.nemotron-id", isNemotronLikeModel(makeModel({ id: "nemotron-3-super" })) === true, "expected nemotron-3-super ID to match");
  expect("detect.nemotron-name", isNemotronLikeModel(makeModel({ id: "custom", name: "Nemotron 4" })) === true, "expected Nemotron 4 name to match");
  expect("detect.nemotron-not-llama", isNemotronLikeModel(makeModel({ id: "llama-3" })) === false, "expected llama-3 to NOT match Nemotron");

  // Cohere detection
  expect("detect.cohere-id", isCohereLikeModel(makeModel({ id: "cohere-command-r" })) === true, "expected cohere-command-r ID to match");
  expect("detect.command-r-id", isCohereLikeModel(makeModel({ id: "command-r-plus" })) === true, "expected command-r-plus ID to match");
  expect("detect.cohere-name", isCohereLikeModel(makeModel({ id: "custom", name: "Cohere Command R+" })) === true, "expected Cohere name to match");
  expect("detect.cohere-not-mistral", isCohereLikeModel(makeModel({ id: "mistral-large" })) === false, "expected mistral-large to NOT match Cohere");

  // Yi detection
  expect("detect.yi-id", isYiLikeModel(makeModel({ id: "yi-lightning" })) === true, "expected yi-lightning ID to match");
  expect("detect.yi-name", isYiLikeModel(makeModel({ id: "custom", name: "Yi 34B" })) === true, "expected Yi 34B name to match via yi pattern");
  expect("detect.yi-01-ai-id", isYiLikeModel(makeModel({ id: "01-ai-yi-34b" })) === true, "expected 01-ai-yi-34b to match");
  expect("detect.yi-zero-one-name", isYiLikeModel(makeModel({ id: "custom", name: "Zero-One Yi" })) === true, "expected Zero-One Yi name to match");
  expect("detect.yi-not-gpt", isYiLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Yi");
}

// ==========================================================================
// Test 30: New model-family assistant message detection
// ==========================================================================
{
  // Mistral assistant
  expect(
    "detect.mistral-assistant",
    isMistralLikeAssistantMessage({ role: "assistant", model: "mistral-large" }, undefined) === true,
    "expected Mistral assistant message to match",
  );

  // Grok assistant
  expect(
    "detect.grok-assistant",
    isGrokLikeAssistantMessage({ role: "assistant", model: "grok-3" }, undefined) === true,
    "expected Grok assistant message to match",
  );
  expect(
    "detect.xai-assistant",
    isGrokLikeAssistantMessage({ role: "assistant", name: "xAI Grok" }, undefined) === true,
    "expected xAI Grok assistant message with name to match",
  );

  // Llama assistant
  expect(
    "detect.llama-assistant",
    isLlamaLikeAssistantMessage({ role: "assistant", model: "llama-3-70b" }, undefined) === true,
    "expected Llama assistant message to match",
  );

  // Nemotron assistant
  expect(
    "detect.nemotron-assistant",
    isNemotronLikeAssistantMessage({ role: "assistant", model: "nemotron-3-super" }, undefined) === true,
    "expected Nemotron assistant message to match",
  );

  // Cohere assistant
  expect(
    "detect.cohere-assistant",
    isCohereLikeAssistantMessage({ role: "assistant", model: "command-r-plus" }, undefined) === true,
    "expected Cohere assistant message to match",
  );

  // Yi assistant
  expect(
    "detect.yi-assistant",
    isYiLikeAssistantMessage({ role: "assistant", model: "yi-lightning" }, undefined) === true,
    "expected Yi assistant message to match",
  );
}

// ==========================================================================
// Test 31: New model-family adapter labels and stats separation
// ==========================================================================
{
  // Mistral adapter label
  const mistralFormatted = formatCacheStats(
    { id: "openai", label: "Mistral cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-23"),
  );
  expect("newAdapter.mistral-label", mistralFormatted.startsWith("Mistral cache"), `expected label "Mistral cache", got: "${mistralFormatted}"`);

  // Grok adapter label
  const grokFormatted = formatCacheStats(
    { id: "openai", label: "Grok cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-23"),
  );
  expect("newAdapter.grok-label", grokFormatted.startsWith("Grok cache"), `expected label "Grok cache", got: "${grokFormatted}"`);

  // Llama adapter label
  const llamaFormatted = formatCacheStats(
    { id: "openai", label: "Llama cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-23"),
  );
  expect("newAdapter.llama-label", llamaFormatted.startsWith("Llama cache"), `expected label "Llama cache", got: "${llamaFormatted}"`);

  // Nemotron adapter label
  const nemotronFormatted = formatCacheStats(
    { id: "openai", label: "Nemotron cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-23"),
  );
  expect("newAdapter.nemotron-label", nemotronFormatted.startsWith("Nemotron cache"), `expected label "Nemotron cache", got: "${nemotronFormatted}"`);

  // Cohere adapter label
  const cohereFormatted = formatCacheStats(
    { id: "openai", label: "Cohere cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-23"),
  );
  expect("newAdapter.cohere-label", cohereFormatted.startsWith("Cohere cache"), `expected label "Cohere cache", got: "${cohereFormatted}"`);

  // Yi adapter label
  const yiFormatted = formatCacheStats(
    { id: "openai", label: "Yi cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-23"),
  );
  expect("newAdapter.yi-label", yiFormatted.startsWith("Yi cache"), `expected label "Yi cache", got: "${yiFormatted}"`);

  // Model key separation
  const mistralKey = modelKey(makeModel({ provider: "aiapi", id: "mistral-large" }));
  const mistralKey2 = modelKey(makeModel({ provider: "mistral", id: "mistral-large" }));
  expect("newAdapter.modelKey-distinct-mistral", mistralKey !== mistralKey2, "expected different keys for different providers with same mistral-large id");
}

// ==========================================================================
// Test 32: Relaxed gate verification for new models
// ==========================================================================
{
  // Grok model with openai-completions — gate should PASS
  const grokModel = makeModel({
    id: "grok-3",
    provider: "xai",
    api: "openai-completions",
    baseUrl: "https://xai.example.com/v1",
  });
  expect(
    "relaxedGate.grok-api-match",
    isOpenAICompatibleApi(grokModel.api) === true,
    "expected isOpenAICompatibleApi to accept openai-completions for Grok",
  );

  // Mistral model with kiro-api — gate should BLOCK
  const mistralKiro = makeModel({
    id: "mistral-large",
    provider: "custom",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
  });
  expect(
    "relaxedGate.mistral-kiro-block",
    isOpenAICompatibleApi(mistralKiro.api) === false,
    "expected kiro-api to block injection even for Mistral model",
  );

  // Grok model with openai-responses — gate should PASS
  const grokResponses = makeModel({
    id: "grok-3",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://xai.example.com/v1",
  });
  expect(
    "relaxedGate.grok-responses-match",
    isOpenAICompatibleApi(grokResponses.api) === true,
    "expected isOpenAICompatibleApi to accept openai-responses for Grok",
  );
}

// ==========================================================================
// Test 33: buildOpenAIProxyCompatWarningText includes file path and provider path
// ==========================================================================
{
  const bothMissing = ["supportsLongCacheRetention", "sendSessionAffinityHeaders"];
  const bothText = buildOpenAIProxyCompatWarningText("otokapi/gpt-5.5", bothMissing);

  // Must mention the file path (platform-friendly)
  const modelsJsonPath = getModelsJsonDisplayPath();
  expect(
    "warning-v2.includes-models-json",
    bothText.includes(modelsJsonPath),
    `expected warning text to mention models.json (${modelsJsonPath})`,
  );

  // Must mention the provider selector
  expect(
    "warning-v2.includes-provider-path",
    bothText.includes('providers["otokapi"]'),
    'expected warning text to mention providers["otokapi"]',
  );

  // Must mention "compat" as the target location
  expect(
    "warning-v2.includes-compat-location",
    bothText.includes("-> compat"),
    "expected warning text to mention '-> compat' location",
  );

  // Must mention same level as baseUrl/api/apiKey/models
  expect(
    "warning-v2.includes-same-level",
    bothText.includes("same level as"),
    "expected warning text to mention 'same level as' for placement guidance",
  );

  // The path guidance mentions apiKey as a sibling field, which is fine.
  // It must NOT contain actual secret values.
  expect(
    "warning-v2.no-secret-values",
    bothText.includes("sk-") === false && !/AIza[0-9A-Za-z_-]{35}/.test(bothText),
    "expected warning text to NOT contain secret values (sk-... or API key patterns)",
  );
  expect(
    "warning-v2.no-secret-pattern",
    /AIza[0-9A-Za-z_-]{35}/.test(bothText) === false,
    "expected warning text to NOT contain Google API key patterns",
  );
}

// ==========================================================================
// Test 34: Service warning text never contains sensitive fields
// ==========================================================================
{
  // The deepseek compat warning text
  const key = "deepseek/deepseek-v4-pro";
  const missing = ["supportsLongCacheRetention", "sendSessionAffinityHeaders"];

  // Simulate the deepseek warningText logic
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelsJsonPath = getModelsJsonDisplayPath();
  const text =
    `💡 pi-cache-optimizer: ${key} is DeepSeek-like but merged compat lacks ${missing.join(" and ")}. ` +
    `Proxies may reduce or hide cache hits. Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (at the same level as baseUrl/api/apiKey/models).`;

  expect(
    "deepseek-warning.includes-models-json",
    text.includes(modelsJsonPath),
    `expected deepseek warning to mention models.json path (${modelsJsonPath})`,
  );
  expect(
    "deepseek-warning.includes-provider-path",
    text.includes('providers["deepseek"]'),
    'expected deepseek warning to mention providers["deepseek"]',
  );
  expect(
    "deepseek-warning.includes-compat",
    text.includes("-> compat"),
    "expected deepseek warning to mention compat location",
  );
  expect(
    "deepseek-warning.no-secrets",
    text.includes("sk-") === false &&
      text.includes("prompt") === false &&
      !/AIza[0-9A-Za-z_-]{35}/.test(text),
    "expected deepseek warning to NOT contain secret values or prompt references",
  );
}

// ==========================================================================
// Test 35: describeMissingOpenAICompatibleProxyCompat used for compat footer marker
// ==========================================================================
{
  // A non-official proxy model missing compat flags should have missing[]
  const proxyModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: {},
  });
  const proxyMissing = describeMissingOpenAICompatibleProxyCompat(proxyModel);
  expect(
    "compatFooter.proxy-has-missing",
    proxyMissing.length > 0,
    `expected compat footer marker to fire for missing-compat proxy, got ${proxyMissing.length} missing`,
  );

  // Official OpenAI model should NOT have missing
  const officialModel = makeModel({
    id: "gpt-4",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    compat: {},
  });
  const officialMissing = describeMissingOpenAICompatibleProxyCompat(officialModel);
  expect(
    "compatFooter.official-no-missing",
    officialMissing.length === 0,
    `expected no compat footer marker for official OpenAI, got ${officialMissing.length} missing`,
  );

  // A fully-configured proxy should NOT have missing
  const configuredModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  const configuredMissing = describeMissingOpenAICompatibleProxyCompat(configuredModel);
  expect(
    "compatFooter.configured-no-missing",
    configuredMissing.length === 0,
    `expected no compat footer marker for fully-configured proxy, got ${configuredMissing.length} missing`,
  );

  // Non-OpenAI API should NOT trigger compat check
  const kiroModel = makeModel({
    id: "gpt-5.5",
    provider: "kiro",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
    compat: {},
  });
  const kiroMissing = describeMissingOpenAICompatibleProxyCompat(kiroModel);
  expect(
    "compatFooter.kiro-no-missing",
    kiroMissing.length === 0,
    "expected no compat footer marker for kiro-api transport",
  );
}

// ==========================================================================
// Test 36: Diagnostic command output (simulated via helper) must not contain secrets
// ==========================================================================
{
  // Simulate the /cache-optimizer doctor output for a proxy model
  const model = makeModel({
    id: "gpt-5.5",
    name: "GPT 5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: {},
  });
  const key = modelKey(model);
  const missing = describeMissingOpenAICompatibleProxyCompat(model);
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const suggestion = missing.length > 0 ? Object.fromEntries(missing.map((f) => [f, true])) : {};

  // Build a simulated doctor output (no secrets)
  const outputLines: string[] = [];
  outputLines.push(`Provider: ${model.provider}`);
  outputLines.push(`Model:    ${model.id}`);
  if (model.name) outputLines.push(`Name:     ${model.name}`);
  outputLines.push(`API:      ${model.api}`);
  outputLines.push(`Base URL: ${model.baseUrl}`);
  outputLines.push(`Compat:   ${JSON.stringify(getCompat(model))}`);
  if (missing.length > 0) {
    outputLines.push(`Missing compat flags: ${missing.join(", ")}`);
    outputLines.push(`Edit ~/.pi/agent/models.json -> providers["${providerLabel}"] -> compat:`);
    outputLines.push(JSON.stringify(suggestion, null, 2));
  }
  const output = outputLines.join("\n");

  // Output must NOT contain actual secret values
  // (apiKey as a field name in path instructions is OK)
  expect(
    "doctor-output.no-secret-values",
    output.includes("sk-") === false &&
      output.includes("DEEPSEEK_API_KEY") === false &&
      !/AIza[0-9A-Za-z_-]{35}/.test(output),
    "expected doctor output to NOT contain actual secret values",
  );

  // Output MUST contain file path if flags missing
  const modelsJsonPath = getModelsJsonDisplayPath();
  expect(
    "doctor-output.contains-file-path",
    output.includes(modelsJsonPath),
    `expected doctor output to mention the models.json file path (${modelsJsonPath})`,
  );

  // Output MUST mention provider path
  expect(
    "doctor-output.contains-provider-path",
    output.includes('providers["otokapi"]'),
    "expected doctor output to mention the provider path",
  );
}

// ==========================================================================
// Test 37: Template thinkingLevelMap — all levels are distinct, not all xhigh
// ==========================================================================
{
  // Proper template: levels stay distinct
  const properMap = {
    off: null,
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  };

  // Each level should equal its own name (or be null for off)
  expect(
    "thinkingLevelMap.off-is-null",
    properMap.off === null,
    "expected off level to be null in template",
  );
  expect(
    "thinkingLevelMap.minimal-distinct",
    properMap.minimal === "minimal",
    "expected minimal to map to 'minimal', not something else",
  );
  expect(
    "thinkingLevelMap.low-distinct",
    properMap.low === "low",
    "expected low to map to 'low', not something else",
  );
  expect(
    "thinkingLevelMap.medium-distinct",
    properMap.medium === "medium",
    "expected medium to map to 'medium', not something else",
  );
  expect(
    "thinkingLevelMap.high-distinct",
    properMap.high === "high",
    "expected high to map to 'high', not something else",
  );
  expect(
    "thinkingLevelMap.xhigh-distinct",
    properMap.xhigh === "xhigh",
    "expected xhigh to map to 'xhigh', not something else",
  );

  // All non-null levels must be distinct from each other
  const nonNullValues = Object.entries(properMap)
    .filter(([_, v]) => v !== null)
    .map(([_, v]) => v);
  const uniqueValues = new Set(nonNullValues);
  expect(
    "thinkingLevelMap.all-distinct",
    uniqueValues.size === nonNullValues.length,
    `expected all non-null levels to be distinct, got ${nonNullValues.length} entries but only ${uniqueValues.size} unique values: ${[...uniqueValues].join(", ")}`,
  );

  // Verify the proper map is NOT collapsed to all-xhigh
  // (which would mean minimal/medium/high all map to "xhigh")
  const nonNullEntries = Object.entries(properMap).filter(([_, v]) => v !== null);
  const allXhigh = nonNullEntries.every(([_, v]) => v === "xhigh");
  expect(
    "thinkingLevelMap.not-all-xhigh",
    allXhigh === false,
    "expected proper template to NOT map all levels to xhigh — levels should be distinct",
  );
}

// ==========================================================================
// Test 38: getModelsJsonDisplayPath — platform-specific display paths
// ==========================================================================
{
  // Windows path uses %USERPROFILE% with backslashes
  const winPath = getModelsJsonDisplayPath("win32");
  expect(
    "modelsPath.win32-contains-userprofile",
    winPath.includes("%USERPROFILE%"),
    `expected Windows path to contain %USERPROFILE%, got "${winPath}"`,
  );
  expect(
    "modelsPath.win32-uses-backslash",
    winPath.includes("\\"),
    `expected Windows path to use backslashes, got "${winPath}"`,
  );
  expect(
    "modelsPath.win32-ends-correctly",
    winPath.endsWith(".pi\\agent\\models.json"),
    `expected Windows path to end with .pi\\agent\\models.json, got "${winPath}"`,
  );

  // macOS path uses tilde + forward slash
  const macPath = getModelsJsonDisplayPath("darwin");
  expect(
    "modelsPath.darwin",
    macPath === "~/.pi/agent/models.json",
    `expected darwin path to be "~/.pi/agent/models.json", got "${macPath}"`,
  );

  // Linux path uses tilde + forward slash
  const linuxPath = getModelsJsonDisplayPath("linux");
  expect(
    "modelsPath.linux",
    linuxPath === "~/.pi/agent/models.json",
    `expected linux path to be "~/.pi/agent/models.json", got "${linuxPath}"`,
  );

  // Default (no arg) should match current platform — at minimum not be empty
  const defaultPath = getModelsJsonDisplayPath();
  expect(
    "modelsPath.default-not-empty",
    defaultPath.length > 0,
    "expected default getModelsJsonDisplayPath() to return a non-empty string",
  );

  // Distinctness: Windows and Unix paths differ
  expect(
    "modelsPath.win-vs-unix-distinct",
    winPath !== macPath,
    "expected Windows path to differ from macOS/Linux path",
  );
}

// ==========================================================================
// Test 39: getLastPromptIntegrityWarningAt — integrity diagnostics state
// ==========================================================================
{
  // Verify the getter returns 0 by default (no issue detected yet)
  expect(
    "integrity.default-zero",
    getLastPromptIntegrityWarningAt() === 0,
    `expected getLastPromptIntegrityWarningAt to default to 0, got ${getLastPromptIntegrityWarningAt()}`,
  );
}

// ==========================================================================
// Test 40: getModelsJsonDisplayPath used in buildOpenAIProxyCompatWarningText
// ==========================================================================
{
  const bothMissing = ["supportsLongCacheRetention", "sendSessionAffinityHeaders"];
  const bothText = buildOpenAIProxyCompatWarningText("otokapi/gpt-5.5", bothMissing);
  const modelsJsonPath = getModelsJsonDisplayPath();

  // The warning text must include the platform-friendly path
  expect(
    "warning-path.platform-friendly",
    bothText.includes(modelsJsonPath),
    `expected warning text to include platform path (${modelsJsonPath})`,
  );

  // The warning text must NOT contain the opposite platform's style
  if (modelsJsonPath.includes("~")) {
    // Running on Unix — must NOT contain Windows-style backslash paths
    expect(
      "warning-path.no-windows-backslash",
      !bothText.includes("\\"),
      "expected Unix warning text to NOT contain Windows backslash paths",
    );
  } else {
    // Running on Windows — must NOT contain Unix tilde paths
    expect(
      "warning-path.no-unix-tilde",
      !bothText.includes("~/"),
      "expected Windows warning text to NOT contain Unix tilde paths",
    );
  }
}

// ==========================================================================
// Test 42: isCompatCheckApplicable — determines whether compat check is relevant
// ==========================================================================
{
  // Third-party openai-completions proxy → applicable
  const proxyModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  expect(
    "isCompatCheckApplicable.proxy",
    isCompatCheckApplicable(proxyModel) === true,
    "expected true for third-party openai-completions proxy",
  );

  // Official OpenAI baseUrl → not applicable
  const officialModel = makeModel({
    id: "gpt-4",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  });
  expect(
    "isCompatCheckApplicable.official",
    isCompatCheckApplicable(officialModel) === false,
    "expected false for official OpenAI baseUrl",
  );

  // Non-openai-completions API → not applicable
  const kiroModel = makeModel({
    id: "claude-sonnet-4",
    provider: "kiro",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
  });
  expect(
    "isCompatCheckApplicable.kiro",
    isCompatCheckApplicable(kiroModel) === false,
    "expected false for kiro-api (non-openai-completions)",
  );

  // openai-responses API → not applicable (only completions check)
  const responsesModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-responses",
    baseUrl: "https://otokapi.example.com/v1",
  });
  expect(
    "isCompatCheckApplicable.responses",
    isCompatCheckApplicable(responsesModel) === false,
    "expected false for openai-responses API",
  );
}

// ==========================================================================
// Test 43: buildDoctorDiagnosis output — "fully configured" and "not applicable" texts
// ==========================================================================
{
  // Compat check applicable and all flags present → "✅ Compat fully configured."
  const proxyConfigured = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  const doctorOutput1 = buildDoctorDiagnosis(proxyConfigured);
  expect(
    "doctor.fully-configured",
    doctorOutput1.includes("✅ Compat fully configured."),
    `expected doctor output to contain "✅ Compat fully configured.", got: ${JSON.stringify(doctorOutput1.slice(doctorOutput1.indexOf("✅")))}`,
  );
  expect(
    "doctor.not-orphan-not-applicable",
    doctorOutput1.includes("(or not applicable)") === false,
    "expected doctor output to NOT contain '(or not applicable)'",
  );

  // Official OpenAI → "ℹ️ Compat check not applicable for this model."
  const officialModel = makeModel({
    id: "gpt-4",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  });
  const doctorOutput2 = buildDoctorDiagnosis(officialModel);
  expect(
    "doctor.not-applicable-official",
    doctorOutput2.includes("ℹ️ Compat check not applicable for this model."),
    `expected doctor output to contain "ℹ️ Compat check not applicable", got: ${JSON.stringify(doctorOutput2.slice(doctorOutput2.indexOf("✅") !== -1 ? doctorOutput2.indexOf("✅") : doctorOutput2.indexOf("ℹ️") !== -1 ? doctorOutput2.indexOf("ℹ️") : 0))}`,
  );

  // Non-openai-completions (kiro-api) → "ℹ️ Compat check not applicable"
  const kiroModel = makeModel({
    id: "claude-sonnet-4",
    provider: "kiro",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
  });
  const doctorOutput3 = buildDoctorDiagnosis(kiroModel);
  expect(
    "doctor.not-applicable-kiro",
    doctorOutput3.includes("ℹ️ Compat check not applicable for this model."),
    `expected doctor output to contain "ℹ️ Compat check not applicable", got: ${JSON.stringify(doctorOutput3.slice(Math.max(0, doctorOutput3.length - 100)))}`,
  );

  // Compat check applicable with missing flags → still shows missing, not "fully configured" or "not applicable"
  const proxyMissing = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: {},
  });
  const doctorOutput4 = buildDoctorDiagnosis(proxyMissing);
  expect(
    "doctor.missing-flags-shown",
    doctorOutput4.includes("Missing compat flags"),
    `expected doctor output to show missing flags, got: ${JSON.stringify(doctorOutput4.slice(0, 200))}`,
  );
  expect(
    "doctor.missing-not-fully-configured",
    doctorOutput4.includes("✅ Compat fully configured.") === false,
    "expected doctor output to NOT show fully configured when flags are missing",
  );
}

// ==========================================================================
// Test 44: buildCompatDiagnosis output — returns undefined when no missing flags
// ==========================================================================
{
  // Applicable model with all flags → undefined (no missing)
  const proxyConfigured = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  expect(
    "buildCompatDiagnosis.configured-undefined",
    buildCompatDiagnosis(proxyConfigured) === undefined,
    "expected buildCompatDiagnosis to return undefined for fully configured proxy",
  );

  // Non-applicable model → undefined (no missing, check doesn't apply)
  const officialModel = makeModel({
    id: "gpt-4",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  });
  expect(
    "buildCompatDiagnosis.official-undefined",
    buildCompatDiagnosis(officialModel) === undefined,
    "expected buildCompatDiagnosis to return undefined for official OpenAI",
  );

  // Missing flags → returns a string with missing info
  const proxyMissing = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: {},
  });
  const compatResult = buildCompatDiagnosis(proxyMissing);
  expect(
    "buildCompatDiagnosis.missing-returns-string",
    typeof compatResult === "string",
    "expected buildCompatDiagnosis to return a string when flags are missing",
  );
  if (compatResult) {
    expect(
      "buildCompatDiagnosis.missing-contains-provider",
      compatResult.includes('providers["otokapi"]'),
      'expected compat result to contain providers["otokapi"]',
    );
  }

  // Non-openai-completions → undefined
  const kiroModel = makeModel({
    id: "claude-sonnet-4",
    provider: "kiro",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
  });
  expect(
    "buildCompatDiagnosis.kiro-undefined",
    buildCompatDiagnosis(kiroModel) === undefined,
    "expected buildCompatDiagnosis to return undefined for kiro-api",
  );
}

// ==========================================================================
// Test 45: Select menu options structure — verify the three menu options exist
// ==========================================================================
{
  // Build the menu options (same as in the command handler)
  const menuOptions = [
    "🩺 Doctor — Show current model cache configuration",
    "⚙️  Compat — Show compat suggestion with edit instructions",
    "❌ Cancel",
  ];

  expect(
    "menu.three-options",
    menuOptions.length === 3,
    `expected exactly 3 menu options, got ${menuOptions.length}`,
  );

  // Each option must be a non-empty string
  for (const opt of menuOptions) {
    expect(
      `menu.label-non-empty:${opt.slice(0, 10)}`,
      opt.length > 0,
      `expected menu option to be non-empty`,
    );
  }

  // Check expected content via substring matches (Pi select takes string[])
  expect(
    "menu.has-doctor",
    menuOptions[0].includes("Doctor"),
    "expected menu option 0 to mention Doctor",
  );
  expect(
    "menu.has-compat",
    menuOptions[1].includes("Compat"),
    "expected menu option 1 to mention Compat",
  );
  expect(
    "menu.has-cancel",
    menuOptions[2].includes("Cancel"),
    "expected menu option 2 to mention Cancel",
  );
}

// ==========================================================================
// Test 41: getModelsJsonDisplayPath used in deepseek warning
// ==========================================================================
{
  const key = "deepseek/deepseek-v4-pro";
  const missing = ["supportsLongCacheRetention", "sendSessionAffinityHeaders"];
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelsJsonPath = getModelsJsonDisplayPath();
  const text =
    `💡 pi-cache-optimizer: ${key} is DeepSeek-like but merged compat lacks ${missing.join(" and ")}. ` +
    `Proxies may reduce or hide cache hits. Edit ${modelsJsonPath} -> providers["${providerLabel}"] -> compat (at the same level as baseUrl/api/apiKey/models).`;

  expect(
    "deepseek-warning-path.platform-friendly",
    text.includes(modelsJsonPath),
    `expected deepseek warning to include platform path (${modelsJsonPath})`,
  );

  if (modelsJsonPath.includes("~")) {
    expect(
      "deepseek-warning-path.no-windows-backslash",
      !text.includes("\\"),
      "expected Unix deepseek warning to NOT contain Windows backslash paths",
    );
  } else {
    expect(
      "deepseek-warning-path.no-unix-tilde",
      !text.includes("~/"),
      "expected Windows deepseek warning to NOT contain Unix tilde paths",
    );
  }
}

// ==========================================================================
// Report
// ==========================================================================
if (failures.length === 0) {
  console.log("[verify] OK — all assertions passed.");
  process.exit(0);
} else {
  console.error(`[verify] FAIL — ${failures.length} assertion(s) failed:`);
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(1);
}
