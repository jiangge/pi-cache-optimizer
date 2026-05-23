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
  isOfficialOpenAIBaseUrl,
  isOpenAICompatibleApi,
  getModelIdNameTokenValues,
  getAssistantMessageModelTokenValues,
  getCompat,
  modelKey,
  // Cache stats helpers
  addUsageToCacheStats,
  formatCacheStats,
  emptyCacheStats,
  emptyAllCacheStats,
  parseCacheStats,
  parsePersistedCacheStats,
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
