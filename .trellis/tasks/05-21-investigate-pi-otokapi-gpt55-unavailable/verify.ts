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
// 12. hashSessionId produces deterministic 16-char hashes.
// 13. makeSessionModelKey / modelKeyFromSessionKey round-trip correctly.
// 14. Same provider/model under different session hashes produce different keys.
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
  describeMissingDeepSeekCompat,
  isDeepSeekCompatCheckApplicable,
  describeMissingCacheCompatForModel,
  buildDeepSeekCompatSuggestion,
  buildDeepSeekCompatWarningText,
  buildSafeOpenAIProxyCompatSuggestion,
  getPromptCacheRetentionUnsupportedHint,
  isOfficialOpenAIBaseUrl,
  isCompatCheckApplicable,
  buildDoctorDiagnosis,
  buildCompatDiagnosis,
  describeRouterChannelDiagnostics,
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
  isMimoLikeModel,
  isMimoLikeAssistantMessage,
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
  isDoubaoLikeModel,
  isDoubaoLikeAssistantMessage,
  isErnieLikeModel,
  isErnieLikeAssistantMessage,
  isBaichuanLikeModel,
  isBaichuanLikeAssistantMessage,
  isStepFunLikeModel,
  isStepFunLikeAssistantMessage,
  isSparkLikeModel,
  isSparkLikeAssistantMessage,
  isInternLMLikeModel,
  isInternLMLikeAssistantMessage,
  isGemmaLikeModel,
  isGemmaLikeAssistantMessage,
  isPhiLikeModel,
  isPhiLikeAssistantMessage,
  isJambaLikeModel,
  isJambaLikeAssistantMessage,
  isSolarLikeModel,
  isSolarLikeAssistantMessage,
  // New OpenAI-compatible model detection (batch 3, 12 families)
  isPerplexityLikeModel,
  isPerplexityLikeAssistantMessage,
  isNovaLikeModel,
  isNovaLikeAssistantMessage,
  isRekaLikeModel,
  isRekaLikeAssistantMessage,
  isFalconLikeModel,
  isFalconLikeAssistantMessage,
  isDbrxLikeModel,
  isDbrxLikeAssistantMessage,
  isMptLikeModel,
  isMptLikeAssistantMessage,
  isStableLMLikeModel,
  isStableLMLikeAssistantMessage,
  isAquilaLikeModel,
  isAquilaLikeAssistantMessage,
  isExaoneLikeModel,
  isExaoneLikeAssistantMessage,
  isHyperCLOVALikeModel,
  isHyperCLOVALikeAssistantMessage,
  isLuminousLikeModel,
  isLuminousLikeAssistantMessage,
  isHermesLikeModel,
  isHermesLikeAssistantMessage,
  // More OpenAI-compatible model detection (batch 4, 18 families)
  isGraniteLikeModel,
  isGraniteLikeAssistantMessage,
  isArcticLikeModel,
  isArcticLikeAssistantMessage,
  isPanguLikeModel,
  isPanguLikeAssistantMessage,
  isSenseNovaLikeModel,
  isSenseNovaLikeAssistantMessage,
  isZhinaoLikeModel,
  isZhinaoLikeAssistantMessage,
  isMiniCPMLikeModel,
  isMiniCPMLikeAssistantMessage,
  isXVerseLikeModel,
  isXVerseLikeAssistantMessage,
  isOrionLikeModel,
  isOrionLikeAssistantMessage,
  isOpenChatLikeModel,
  isOpenChatLikeAssistantMessage,
  isVicunaLikeModel,
  isVicunaLikeAssistantMessage,
  isWizardLikeModel,
  isWizardLikeAssistantMessage,
  isZephyrLikeModel,
  isZephyrLikeAssistantMessage,
  isDolphinLikeModel,
  isDolphinLikeAssistantMessage,
  isOpenOrcaLikeModel,
  isOpenOrcaLikeAssistantMessage,
  isStarlingLikeModel,
  isStarlingLikeAssistantMessage,
  isBloomLikeModel,
  isBloomLikeAssistantMessage,
  isRwkvLikeModel,
  isRwkvLikeAssistantMessage,
  isAyaLikeModel,
  isAyaLikeAssistantMessage,
  selectAdapterForModel,
  selectAdapterForAssistantMessage,
  getCompat,
  modelKey,
  buildOpenAIProxyCompatWarningText,
  getModelsJsonDisplayPath,
  captureCacheRetentionEnv,
  requestLongCacheRetention,
  restoreCacheRetentionEnv,
  setRuntimeOptimizerEnabled,
  isRuntimeOptimizerEnabled,
  getOptimizerRuntimeModeLines,
  formatOptimizerRuntimeMode,
  PI_CACHE_RETENTION_ENV,
  LONG_CACHE_RETENTION_VALUE,
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
  // New exports for Goal 1-3
  MAX_RECENT_SAMPLES,
  buildStatsOutput,
  buildLowHitDiagnosis,
  formatRecentTrendSummary,
  formatHitRatio,
  formatTokenM,
  hasMissingUsageFields,
  keyForModelExt,
  hashSessionId,
  makeSessionModelKey,
  modelKeyFromSessionKey,
  mergeCacheSessions,
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

    setRuntimeOptimizerEnabled(false);
    expect("shouldInject.runtime-disabled", shouldInjectOpenAIPromptCacheKey() === false, "expected false when runtime optimizer is disabled");
    setRuntimeOptimizerEnabled(true);
    expect("shouldInject.runtime-enabled", shouldInjectOpenAIPromptCacheKey() === true, "expected true after runtime optimizer is re-enabled");
  } finally {
    setRuntimeOptimizerEnabled(true);
    // Restore
    if (savedNoKey !== undefined) process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY = savedNoKey;
    else delete process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY;
    if (savedKey !== undefined) process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = savedKey;
    else delete process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY;
  }
}

// ===========================================================================
// Test 5a: runtime enable/disable helpers — current-process switch
// ===========================================================================
{
  const env: Record<string, string | undefined> = { PI_CACHE_RETENTION: "short" };
  const snapshot = captureCacheRetentionEnv(env);
  requestLongCacheRetention(env);
  expect("runtime.requestLongCacheRetention", env.PI_CACHE_RETENTION === LONG_CACHE_RETENTION_VALUE, "expected long cache retention request");
  restoreCacheRetentionEnv(snapshot, env);
  expect("runtime.restoreExistingRetention", env.PI_CACHE_RETENTION === "short", "expected original retention value restored");

  const emptyEnv: Record<string, string | undefined> = {};
  const emptySnapshot = captureCacheRetentionEnv(emptyEnv);
  requestLongCacheRetention(emptyEnv);
  expect("runtime.requestLongCacheRetention.empty", emptyEnv.PI_CACHE_RETENTION === "long", "expected empty env to receive long retention");
  restoreCacheRetentionEnv(emptySnapshot, emptyEnv);
  expect("runtime.restoreUnsetRetention", emptyEnv.PI_CACHE_RETENTION === undefined, "expected unset retention to be deleted");

  setRuntimeOptimizerEnabled(false, env);
  expect("runtime.disabled-state", isRuntimeOptimizerEnabled() === false, "expected runtime disabled");
  const disabledText = formatOptimizerRuntimeMode();
  expect("runtime.disabled-text", disabledText.includes("Runtime state: disabled"), `unexpected disabled mode text: ${disabledText}`);

  setRuntimeOptimizerEnabled(true, env);
  expect("runtime.enabled-state", isRuntimeOptimizerEnabled() === true, "expected runtime enabled");
  expect("runtime.enabled-retention", env.PI_CACHE_RETENTION === "long", "expected runtime enable to request long retention");
  const enabledLines = getOptimizerRuntimeModeLines();
  expect("runtime.enabled-lines", enabledLines.some((line) => line.includes("Runtime state: enabled")), `unexpected enabled mode lines: ${enabledLines.join(" | ")}`);
}

// ===========================================================================
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
// Test 9b: DeepSeek-specific compat flags from Pi Mono guidance
// ==========================================================================
{
  const deepseekProxy = makeModel({
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    compat: {},
  });
  const missing = describeMissingDeepSeekCompat(deepseekProxy);
  expect(
    "deepseekCompat.all-missing",
    missing.includes("supportsLongCacheRetention") &&
      missing.includes("sendSessionAffinityHeaders") &&
      missing.includes("requiresReasoningContentOnAssistantMessages") &&
      missing.includes("thinkingFormat"),
    `expected DeepSeek proxy to miss cache + reasoning compat flags, got: ${JSON.stringify(missing)}`,
  );
  expect(
    "deepseekCompat.applicable",
    isDeepSeekCompatCheckApplicable(deepseekProxy) === true,
    "expected DeepSeek openai-completions model to use DeepSeek compat check",
  );
  expect(
    "deepseekCompat.adapter-aware",
    describeMissingCacheCompatForModel(deepseekProxy).includes("requiresReasoningContentOnAssistantMessages"),
    "expected adapter-aware compat check to include DeepSeek reasoning_content flag",
  );

  const suggestion = buildDeepSeekCompatSuggestion(missing);
  expect(
    "deepseekCompat.suggestion-reasoning-content",
    suggestion.requiresReasoningContentOnAssistantMessages === true,
    `expected suggestion to include requiresReasoningContentOnAssistantMessages: true, got ${JSON.stringify(suggestion)}`,
  );
  expect(
    "deepseekCompat.suggestion-thinking-format",
    suggestion.thinkingFormat === "deepseek",
    `expected suggestion to include thinkingFormat: deepseek, got ${JSON.stringify(suggestion)}`,
  );

  const configured = makeModel({
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    compat: {
      supportsLongCacheRetention: true,
      sendSessionAffinityHeaders: true,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
  });
  expect(
    "deepseekCompat.configured-none",
    describeMissingDeepSeekCompat(configured).length === 0,
    `expected no missing DeepSeek flags when fully configured, got ${JSON.stringify(describeMissingDeepSeekCompat(configured))}`,
  );

  const responsesProxy = makeModel({
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "openai-responses",
    baseUrl: "https://deepseek-responses.example.com/v1",
    compat: {
      supportsLongCacheRetention: true,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
  });
  const responsesMissing = describeMissingDeepSeekCompat(responsesProxy);
  expect(
    "deepseekCompat.responses-session-id",
    responsesMissing.length === 1 && responsesMissing[0] === "sendSessionIdHeader",
    `expected openai-responses DeepSeek proxy to require sendSessionIdHeader only, got ${JSON.stringify(responsesMissing)}`,
  );

  const warningText = buildDeepSeekCompatWarningText(modelKey(deepseekProxy), missing);
  expect(
    "deepseekCompat.warning-reasoning-content",
    warningText.includes('"requiresReasoningContentOnAssistantMessages": true'),
    `expected warning to include reasoning_content compat JSON, got ${warningText}`,
  );
  expect(
    "deepseekCompat.warning-thinking-format",
    warningText.includes('"thinkingFormat": "deepseek"'),
    `expected warning to include thinkingFormat JSON, got ${warningText}`,
  );
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
// Test 23: buildOpenAIProxyCompatWarningText — safe default suggestion avoids risky long-retention flag
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
      expect("warning-both.no-risky-retention-json", parsed.supportsLongCacheRetention === undefined, "expected safe JSON to omit supportsLongCacheRetention");
      expect("warning-both.sendSessionAffinityHeaders", parsed.sendSessionAffinityHeaders === true, "expected sendSessionAffinityHeaders: true");
      expect("warning-both.exactly-one-key", Object.keys(parsed).length === 1, "expected exactly 1 key in safe JSON");
    }
  }

  expect(
    "warning-both.safe-helper",
    buildSafeOpenAIProxyCompatSuggestion(bothMissing).sendSessionAffinityHeaders === true && buildSafeOpenAIProxyCompatSuggestion(bothMissing).supportsLongCacheRetention === undefined,
    "expected safe helper to recommend only session affinity",
  );

  // Verify the warning text also includes prose explanations and 400 recovery guidance
  expect(
    "warning-both.prose-retention",
    bothText.includes("optional") && bothText.includes("prompt_cache_retention"),
    "expected optional long-retention explanation",
  );
  expect(
    "warning-both.prose-affinity",
    bothText.includes("session") && bothText.includes("backend"),
    "expected prose explanation for sendSessionAffinityHeaders",
  );

  expect(
    "warning-both.unsupported-hint",
    bothText.includes(getPromptCacheRetentionUnsupportedHint()),
    "expected unsupported prompt_cache_retention hint",
  );

  // Make sure there are NO inline comments (//) in the text
  expect("warning-both.no-comments", !bothText.includes("//"), "expected no inline comments (//) in warning text");

  // --- Only supportsLongCacheRetention missing ---
  const onlyRetention = ["supportsLongCacheRetention"];
  const retentionText = buildOpenAIProxyCompatWarningText("otokapi/gpt-5.5", onlyRetention);
  expect(
    "warning-retention.no-json",
    retentionText.match(/{[\s\S]*?\n}/) === null,
    "expected no JSON suggestion for retention-only warning",
  );
  expect(
    "warning-retention.no-safe-suggestion",
    Object.keys(buildSafeOpenAIProxyCompatSuggestion(onlyRetention)).length === 0,
    "expected no safe automatic suggestion for retention-only warning",
  );
  expect(
    "warning-retention.unsupported-hint",
    retentionText.includes("400 Unsupported parameter: prompt_cache_retention"),
    "expected retention warning to mention 400 recovery",
  );

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

  // Mimo / MiMo detection
  expect("detect.mimo-id", isMimoLikeModel(makeModel({ id: "mimo-vl-7b" })) === true, "expected mimo-vl-7b to match");
  expect("detect.mimo-name", isMimoLikeModel(makeModel({ id: "custom", name: "Xiaomi MiMo" })) === true, "expected Xiaomi MiMo name to match");
  expect("detect.mimo-mi-mo", isMimoLikeModel(makeModel({ id: "xiaomi-mi-mo-7b" })) === true, "expected xiaomi-mi-mo-7b to match");
  expect("detect.mimo-xiaomimimo", isMimoLikeModel(makeModel({ id: "xiaomimimo-vl" })) === true, "expected xiaomimimo-vl to match");
  expect("detect.mimo-not-mimosa", isMimoLikeModel(makeModel({ id: "mimosa-v1" })) === false, "expected mimosa-v1 to NOT match Mimo");
  expect("detect.mimo-not-gpt", isMimoLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Mimo");

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
    "detect.mimo-assistant",
    isMimoLikeAssistantMessage({ role: "assistant", model: "mimo-vl-7b" }, undefined) === true,
    "expected Mimo assistant message to match",
  );
  expect(
    "detect.mimo-mi-mo-assistant",
    isMimoLikeAssistantMessage({ role: "assistant", name: "xiaomi-mi-mo" }, undefined) === true,
    "expected xiaomi-mi-mo assistant message with name to match",
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
  // We verify both the model detection functions used by the adapters and the
  // internal adapter selector exposed only through __internals_for_tests.

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

  // Mimo adapter label
  const mimoFormatted = formatCacheStats(
    { id: "openai", label: "Mimo cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-22"),
  );
  expect(
    "newAdapter.mimo-label",
    mimoFormatted.startsWith("Mimo cache"),
    `expected label "Mimo cache", got: "${mimoFormatted}"`,
  );
  const mimoSelected = selectAdapterForModel(makeModel({ id: "mimo-vl-7b", name: "Xiaomi MiMo VL" }));
  expect("newAdapter.mimo-select-label", mimoSelected?.label === "Mimo cache", `expected Mimo adapter selection, got: ${mimoSelected?.label}`);
  const mimoAssistantSelected = selectAdapterForAssistantMessage(
    { role: "assistant", model: "mimo-vl-7b", usage: { input: 100, cacheRead: 40, cacheWrite: 10 } },
    undefined,
  );
  expect("newAdapter.mimo-assistant-select", mimoAssistantSelected?.label === "Mimo cache", `expected Mimo assistant adapter, got: ${mimoAssistantSelected?.label}`);
  expect("newAdapter.mimo-role-gate", selectAdapterForAssistantMessage({ role: "user", model: "mimo-vl-7b" }, undefined) === undefined, "expected user message to be blocked by adapter role gate");
  const mimoUsage = mimoAssistantSelected?.normalizeUsage({ role: "assistant", model: "mimo-vl-7b", usage: { input: 100, cacheRead: 40, cacheWrite: 10 } });
  expect("newAdapter.mimo-usage-normalization", mimoUsage?.cacheRead === 40 && mimoUsage?.cacheWrite === 10 && mimoUsage?.totalInput === 150, `expected OpenAI-shaped/Pi-normalized usage for Mimo, got: ${JSON.stringify(mimoUsage)}`);

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

  // A Mimo model with openai-completions API — gate should PASS
  const mimoModel = makeModel({
    id: "mimo-vl-7b",
    name: "Xiaomi MiMo VL",
    provider: "xiaomi",
    api: "openai-completions",
    baseUrl: "https://mimo.example.com/v1",
  });
  expect(
    "relaxedGate.mimo-api-match",
    isOpenAICompatibleApi(mimoModel.api) === true,
    "expected isOpenAICompatibleApi to accept openai-completions for Mimo",
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
  const model = makeModel({ provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions" });
  const key = modelKey(model);
  const missing = [
    "supportsLongCacheRetention",
    "sendSessionAffinityHeaders",
    "requiresReasoningContentOnAssistantMessages",
    "thinkingFormat",
  ];

  const modelsJsonPath = getModelsJsonDisplayPath();
  const text = buildDeepSeekCompatWarningText(key, missing);

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
    "deepseek-warning.includes-reasoning-content",
    text.includes('"requiresReasoningContentOnAssistantMessages": true'),
    "expected deepseek warning to include requiresReasoningContentOnAssistantMessages suggestion",
  );
  expect(
    "deepseek-warning.includes-thinking-format",
    text.includes('"thinkingFormat": "deepseek"'),
    "expected deepseek warning to include thinkingFormat suggestion",
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

  const deepseekMissing = makeModel({
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    compat: {},
  });
  const doctorOutput5 = buildDoctorDiagnosis(deepseekMissing);
  expect(
    "doctor.deepseek-reasoning-content",
    doctorOutput5.includes("requiresReasoningContentOnAssistantMessages"),
    `expected doctor output to include DeepSeek reasoning_content compat flag, got: ${JSON.stringify(doctorOutput5.slice(0, 300))}`,
  );
  expect(
    "doctor.deepseek-thinking-format",
    doctorOutput5.includes('"thinkingFormat": "deepseek"'),
    `expected doctor output to include DeepSeek thinkingFormat suggestion, got: ${JSON.stringify(doctorOutput5.slice(0, 500))}`,
  );
}

// ==========================================================================
// Test 44: buildCompatDiagnosis output
// ==========================================================================
// Note: describeRouterChannelDiagnostics fires for any openai-completions model
// with a non-official base URL (generic proxy profile), so even fully-configured
// proxies return router channel notes. Only official OpenAI and custom transports
// return undefined.
{
  // Applicable model with all flags → returns string with router notes + "✅ Compat fully configured."
  const proxyConfigured = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  const configResult = buildCompatDiagnosis(proxyConfigured);
  expect(
    "buildCompatDiagnosis.configured-returns-string",
    typeof configResult === "string",
    "expected buildCompatDiagnosis to return a string (router notes) for fully configured proxy",
  );
  if (configResult) {
    expect(
      "buildCompatDiagnosis.configured-contains-fully",
      configResult.includes("✅ Compat fully configured."),
      "expected compat result to contain '✅ Compat fully configured.'",
    );
    expect(
      "buildCompatDiagnosis.configured-contains-channel-notes",
      configResult.includes("🔀 Router/channel"),
      "expected compat result to contain router/channel notes",
    );
  };

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

  const deepseekProxy = makeModel({
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    compat: {},
  });
  const deepseekCompatResult = buildCompatDiagnosis(deepseekProxy);
  expect(
    "buildCompatDiagnosis.deepseek-returns-string",
    typeof deepseekCompatResult === "string",
    "expected buildCompatDiagnosis to return a string for DeepSeek when compat is missing",
  );
  if (deepseekCompatResult) {
    expect(
      "buildCompatDiagnosis.deepseek-reasoning-content",
      deepseekCompatResult.includes("requiresReasoningContentOnAssistantMessages"),
      `expected DeepSeek compat result to include reasoning_content flag, got: ${JSON.stringify(deepseekCompatResult.slice(0, 300))}`,
    );
    expect(
      "buildCompatDiagnosis.deepseek-thinking-format",
      deepseekCompatResult.includes('"thinkingFormat": "deepseek"'),
      `expected DeepSeek compat result to include thinkingFormat suggestion, got: ${JSON.stringify(deepseekCompatResult.slice(0, 500))}`,
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
// Test 45: Select menu options structure — verify concise icon-free menu options
// ==========================================================================
{
  // Build the menu options (same as in the command handler)
  const menuOptions = [
    "Enable — Turn on runtime optimizations",
    "Disable — Turn off runtime optimizations",
    "Doctor — Show cache configuration",
    "Stats — Show cache stats and trend",
    "Compat — Show compat suggestion",
    "Reset — Reset local session stats",
    "Cancel",
  ];

  expect(
    "menu.seven-options",
    menuOptions.length === 7,
    `expected exactly 7 menu options, got ${menuOptions.length}`,
  );

  // Each option must be a non-empty string and avoid leading icons.
  for (const opt of menuOptions) {
    expect(
      `menu.label-non-empty:${opt.slice(0, 10)}`,
      opt.length > 0,
      `expected menu option to be non-empty`,
    );
    expect(
      `menu.no-leading-icon:${opt.slice(0, 10)}`,
      /^[A-Za-z]/.test(opt),
      `expected menu option to start with a word, got ${JSON.stringify(opt)}`,
    );
  }

  // Check expected content via substring matches (Pi select takes string[])
  expect(
    "menu.has-enable",
    menuOptions[0].includes("Enable"),
    "expected menu option 0 to mention Enable",
  );
  expect(
    "menu.has-disable",
    menuOptions[1].includes("Disable"),
    "expected menu option 1 to mention Disable",
  );
  expect(
    "menu.has-doctor",
    menuOptions[2].includes("Doctor"),
    "expected menu option 2 to mention Doctor",
  );
  expect(
    "menu.has-stats",
    menuOptions[3].includes("Stats"),
    "expected menu option 3 to mention Stats",
  );
  expect(
    "menu.has-compat",
    menuOptions[4].includes("Compat"),
    "expected menu option 4 to mention Compat",
  );
  expect(
    "menu.has-reset",
    menuOptions[5].includes("Reset"),
    "expected menu option 5 to mention Reset",
  );
  expect(
    "menu.has-cancel",
    menuOptions[6].includes("Cancel"),
    "expected menu option 6 to mention Cancel",
  );
}

// ==========================================================================
// Test 41: getModelsJsonDisplayPath used in deepseek warning
// ==========================================================================
{
  const key = "deepseek/deepseek-v4-pro";
  const missing = [
    "supportsLongCacheRetention",
    "sendSessionAffinityHeaders",
    "requiresReasoningContentOnAssistantMessages",
    "thinkingFormat",
  ];
  const modelsJsonPath = getModelsJsonDisplayPath();
  const text = buildDeepSeekCompatWarningText(key, missing);

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
// Test 46: New model-family detection (batch 2) — Doubao, ERNIE, Baichuan, StepFun, Spark, InternLM, Gemma, Phi, Jamba, Solar
// ==========================================================================
{
  // Doubao / ByteDance / Seed detection
  expect("detect.doubao-id", isDoubaoLikeModel(makeModel({ id: "doubao-pro-32k" })) === true, "expected doubao-pro-32k ID to match");
  expect("detect.doubao-name", isDoubaoLikeModel(makeModel({ id: "custom", name: "Doubao Pro" })) === true, "expected Doubao Pro name to match");
  expect("detect.doubao-volcengine", isDoubaoLikeModel(makeModel({ id: "volcengine-seed-llm" })) === true, "expected volcengine-seed-llm ID to match");
  expect("detect.doubao-bytedance", isDoubaoLikeModel(makeModel({ id: "bytedance-seed-tts" })) === true, "expected bytedance-seed-tts ID to match");
  expect("detect.doubao-byte-dance", isDoubaoLikeModel(makeModel({ id: "byte-dance-seed-asr" })) === true, "expected byte-dance-seed-asr ID to match");
  expect("detect.doubao-seed-boundary", isDoubaoLikeModel(makeModel({ id: "seed/seed-llm-v1" })) === true, "expected seed/seed-llm-v1 to match via seed safe boundary");
  expect("detect.doubao-豆包", isDoubaoLikeModel(makeModel({ id: "豆包-pro" })) === true, "expected 豆包-pro ID to match");
  expect("detect.doubao-not-gpt", isDoubaoLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Doubao");
  expect("detect.doubao-not-seed-prose", isDoubaoLikeModel(makeModel({ id: "prosody-v2" })) === false, "expected prosody-v2 to NOT match Doubao (seed inside prose)");

  // ERNIE / Baidu detection
  expect("detect.ernie-id", isErnieLikeModel(makeModel({ id: "ernie-4.0" })) === true, "expected ernie-4.0 ID to match");
  expect("detect.ernie-name", isErnieLikeModel(makeModel({ id: "custom", name: "ERNIE 4.0" })) === true, "expected ERNIE 4.0 name to match");
  expect("detect.ernie-wenxin", isErnieLikeModel(makeModel({ id: "wenxin-yiyan" })) === true, "expected wenxin-yiyan ID to match");
  expect("detect.ernie-baidu", isErnieLikeModel(makeModel({ id: "baidu-ernie-bot" })) === true, "expected baidu-ernie-bot ID to match");
  expect("detect.ernie-文心", isErnieLikeModel(makeModel({ id: "文心一言" })) === true, "expected 文心一言 ID to match");
  expect("detect.ernie-一言", isErnieLikeModel(makeModel({ id: "一言-ernie" })) === true, "expected 一言-ernie ID to match");
  expect("detect.ernie-not-gpt", isErnieLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match ERNIE");
  expect("detect.ernie-not-kimi", isErnieLikeModel(makeModel({ id: "kimi-k2.5" })) === false, "expected kimi-k2.5 to NOT match ERNIE");

  // Baichuan detection
  expect("detect.baichuan-id", isBaichuanLikeModel(makeModel({ id: "baichuan-2-pro" })) === true, "expected baichuan-2-pro ID to match");
  expect("detect.baichuan-name", isBaichuanLikeModel(makeModel({ id: "custom", name: "Baichuan 2" })) === true, "expected Baichuan 2 name to match");
  expect("detect.baichuan-百川", isBaichuanLikeModel(makeModel({ id: "百川-pro" })) === true, "expected 百川-pro ID to match");
  expect("detect.baichuan-not-gpt", isBaichuanLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Baichuan");

  // StepFun detection
  expect("detect.stepfun-id", isStepFunLikeModel(makeModel({ id: "stepfun-pro-v1" })) === true, "expected stepfun-pro-v1 ID to match");
  expect("detect.stepfun-name", isStepFunLikeModel(makeModel({ id: "custom", name: "StepFun Pro" })) === true, "expected StepFun Pro name to match");
  expect("detect.stepfun-step-prefix", isStepFunLikeModel(makeModel({ id: "step-2-pro" })) === true, "expected step-2-pro ID to match via step- prefix");
  expect("detect.stepfun-not-steps-prose", isStepFunLikeModel(makeModel({ id: "footsteps-v1" })) === false, "expected footsteps-v1 to NOT match StepFun (step inside prose)");
  expect("detect.stepfun-not-gpt", isStepFunLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match StepFun");

  // Spark / iFlytek detection
  expect("detect.spark-id", isSparkLikeModel(makeModel({ id: "spark-4.0" })) === true, "expected spark-4.0 ID to match");
  expect("detect.spark-name", isSparkLikeModel(makeModel({ id: "custom", name: "Spark Desks" })) === true, "expected Spark Desks name to match");
  expect("detect.spark-xinghuo", isSparkLikeModel(makeModel({ id: "xinghuo-v3" })) === true, "expected xinghuo-v3 ID to match");
  expect("detect.spark-iflytek", isSparkLikeModel(makeModel({ id: "iflytek-spark" })) === true, "expected iflytek-spark ID to match");
  expect("detect.spark-讯飞", isSparkLikeModel(makeModel({ id: "讯飞星火" })) === true, "expected 讯飞星火 ID to match");
  expect("detect.spark-星火", isSparkLikeModel(makeModel({ id: "星火-v3" })) === true, "expected 星火-v3 ID to match");
  expect("detect.spark-not-gpt", isSparkLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Spark");
  expect("detect.spark-not-hunyuan", isSparkLikeModel(makeModel({ id: "hunyuan-large" })) === false, "expected hunyuan-large to NOT match Spark");

  // InternLM detection
  expect("detect.internlm-id", isInternLMLikeModel(makeModel({ id: "internlm2-pro" })) === true, "expected internlm2-pro ID to match");
  expect("detect.internlm-name", isInternLMLikeModel(makeModel({ id: "custom", name: "InternLM 2" })) === true, "expected InternLM 2 name to match");
  expect("detect.internlm-intern-lm", isInternLMLikeModel(makeModel({ id: "intern-lm-20b" })) === true, "expected intern-lm-20b ID to match");
  expect("detect.internlm-书生", isInternLMLikeModel(makeModel({ id: "书生-internlm" })) === true, "expected 书生-internlm ID to match");
  expect("detect.internlm-not-gpt", isInternLMLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match InternLM");

  // Gemma detection
  expect("detect.gemma-id", isGemmaLikeModel(makeModel({ id: "gemma-3-27b" })) === true, "expected gemma-3-27b ID to match");
  expect("detect.gemma-name", isGemmaLikeModel(makeModel({ id: "custom", name: "Gemma 3" })) === true, "expected Gemma 3 name to match");
  expect("detect.gemma-not-gpt", isGemmaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Gemma");
  expect("detect.gemma-not-gemini", isGemmaLikeModel(makeModel({ id: "gemini-2.5" })) === false, "expected gemini-2.5 to NOT match Gemma");

  // Phi detection
  expect("detect.phi-id", isPhiLikeModel(makeModel({ id: "phi-3-mini" })) === true, "expected phi-3-mini ID to match via phi- prefix");
  expect("detect.phi-name", isPhiLikeModel(makeModel({ id: "custom", name: "Phi-3" })) === true, "expected Phi-3 name to match via phi- prefix");
  expect("detect.phi-boundary", isPhiLikeModel(makeModel({ id: "microsoft/phi-4" })) === true, "expected microsoft/phi-4 to match via phi safe boundary");
  expect("detect.phi-not-sophia", isPhiLikeModel(makeModel({ id: "sophia-v1" })) === false, "expected sophia-v1 to NOT match Phi (phi inside prose)");
  expect("detect.phi-not-gpt", isPhiLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Phi");

  // Jamba / AI21 detection
  expect("detect.jamba-id", isJambaLikeModel(makeModel({ id: "jamba-1.5-large" })) === true, "expected jamba-1.5-large ID to match");
  expect("detect.jamba-name", isJambaLikeModel(makeModel({ id: "custom", name: "Jamba 1.5" })) === true, "expected Jamba 1.5 name to match");
  expect("detect.jamba-ai21", isJambaLikeModel(makeModel({ id: "ai21-jamba-1.5" })) === true, "expected ai21-jamba-1.5 ID to match");
  expect("detect.jamba-not-gpt", isJambaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Jamba");

  // Solar / Upstage detection
  expect("detect.solar-id", isSolarLikeModel(makeModel({ id: "solar-mini" })) === true, "expected solar-mini ID to match");
  expect("detect.solar-name", isSolarLikeModel(makeModel({ id: "custom", name: "Solar Mini" })) === true, "expected Solar Mini name to match");
  expect("detect.solar-upstage", isSolarLikeModel(makeModel({ id: "upstage-solar-pro" })) === true, "expected upstage-solar-pro ID to match");
  expect("detect.solar-not-gpt", isSolarLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Solar");
}

// ==========================================================================
// Test 47: New model-family assistant message detection (batch 2)
// ==========================================================================
{
  // Doubao assistant
  expect(
    "detect.doubao-assistant",
    isDoubaoLikeAssistantMessage({ role: "assistant", model: "doubao-pro-32k" }, undefined) === true,
    "expected Doubao assistant message to match",
  );
  expect(
    "detect.doubao-byte-dance-assistant",
    isDoubaoLikeAssistantMessage({ role: "assistant", name: "byte-dance-seed-v1" }, undefined) === true,
    "expected ByteDance Seed assistant message with name to match",
  );

  // ERNIE assistant
  expect(
    "detect.ernie-assistant",
    isErnieLikeAssistantMessage({ role: "assistant", model: "ernie-4.0" }, undefined) === true,
    "expected ERNIE assistant message to match",
  );
  expect(
    "detect.ernie-baidu-assistant",
    isErnieLikeAssistantMessage({ role: "assistant", model: "baidu-ernie-bot" }, undefined) === true,
    "expected Baidu ERNIE assistant message to match",
  );

  // Baichuan assistant
  expect(
    "detect.baichuan-assistant",
    isBaichuanLikeAssistantMessage({ role: "assistant", model: "baichuan-2-pro" }, undefined) === true,
    "expected Baichuan assistant message to match",
  );

  // StepFun assistant
  expect(
    "detect.stepfun-assistant",
    isStepFunLikeAssistantMessage({ role: "assistant", model: "stepfun-pro-v1" }, undefined) === true,
    "expected StepFun assistant message to match",
  );
  expect(
    "detect.stepfun-step-prefix-assistant",
    isStepFunLikeAssistantMessage({ role: "assistant", model: "step-2-pro" }, undefined) === true,
    "expected step-2-pro assistant message to match",
  );

  // Spark assistant
  expect(
    "detect.spark-assistant",
    isSparkLikeAssistantMessage({ role: "assistant", model: "spark-4.0" }, undefined) === true,
    "expected Spark assistant message to match",
  );

  // InternLM assistant
  expect(
    "detect.internlm-assistant",
    isInternLMLikeAssistantMessage({ role: "assistant", model: "internlm2-pro" }, undefined) === true,
    "expected InternLM assistant message to match",
  );

  // Gemma assistant
  expect(
    "detect.gemma-assistant",
    isGemmaLikeAssistantMessage({ role: "assistant", model: "gemma-3-27b" }, undefined) === true,
    "expected Gemma assistant message to match",
  );

  // Phi assistant
  expect(
    "detect.phi-assistant",
    isPhiLikeAssistantMessage({ role: "assistant", model: "phi-3-mini" }, undefined) === true,
    "expected Phi assistant message to match",
  );

  // Jamba assistant
  expect(
    "detect.jamba-assistant",
    isJambaLikeAssistantMessage({ role: "assistant", model: "jamba-1.5-large" }, undefined) === true,
    "expected Jamba assistant message to match",
  );

  // Solar assistant
  expect(
    "detect.solar-assistant",
    isSolarLikeAssistantMessage({ role: "assistant", model: "solar-mini" }, undefined) === true,
    "expected Solar assistant message to match",
  );
}

// ==========================================================================
// Test 48: New model-family adapter labels and stats separation (batch 2)
// ==========================================================================
{
  // Doubao adapter label
  const doubaoFormatted = formatCacheStats(
    { id: "openai", label: "Doubao cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.doubao-label", doubaoFormatted.startsWith("Doubao cache"), `expected label "Doubao cache", got: "${doubaoFormatted}"`);

  // ERNIE adapter label
  const ernieFormatted = formatCacheStats(
    { id: "openai", label: "ERNIE cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.ernie-label", ernieFormatted.startsWith("ERNIE cache"), `expected label "ERNIE cache", got: "${ernieFormatted}"`);

  // Baichuan adapter label
  const baichuanFormatted = formatCacheStats(
    { id: "openai", label: "Baichuan cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.baichuan-label", baichuanFormatted.startsWith("Baichuan cache"), `expected label "Baichuan cache", got: "${baichuanFormatted}"`);

  // StepFun adapter label
  const stepfunFormatted = formatCacheStats(
    { id: "openai", label: "StepFun cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.stepfun-label", stepfunFormatted.startsWith("StepFun cache"), `expected label "StepFun cache", got: "${stepfunFormatted}"`);

  // Spark adapter label
  const sparkFormatted = formatCacheStats(
    { id: "openai", label: "Spark cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.spark-label", sparkFormatted.startsWith("Spark cache"), `expected label "Spark cache", got: "${sparkFormatted}"`);

  // InternLM adapter label
  const internlmFormatted = formatCacheStats(
    { id: "openai", label: "InternLM cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.internlm-label", internlmFormatted.startsWith("InternLM cache"), `expected label "InternLM cache", got: "${internlmFormatted}"`);

  // Gemma adapter label
  const gemmaFormatted = formatCacheStats(
    { id: "openai", label: "Gemma cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.gemma-label", gemmaFormatted.startsWith("Gemma cache"), `expected label "Gemma cache", got: "${gemmaFormatted}"`);

  // Phi adapter label
  const phiFormatted = formatCacheStats(
    { id: "openai", label: "Phi cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.phi-label", phiFormatted.startsWith("Phi cache"), `expected label "Phi cache", got: "${phiFormatted}"`);

  // Jamba adapter label
  const jambaFormatted = formatCacheStats(
    { id: "openai", label: "Jamba cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.jamba-label", jambaFormatted.startsWith("Jamba cache"), `expected label "Jamba cache", got: "${jambaFormatted}"`);

  // Solar adapter label
  const solarFormatted = formatCacheStats(
    { id: "openai", label: "Solar cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.solar-label", solarFormatted.startsWith("Solar cache"), `expected label "Solar cache", got: "${solarFormatted}"`);

  // Model key separation: same id under different providers
  const doubaoKey1 = modelKey(makeModel({ provider: "byte-dance", id: "doubao-pro-32k" }));
  const doubaoKey2 = modelKey(makeModel({ provider: "volcengine", id: "doubao-pro-32k" }));
  expect(
    "newAdapter.modelKey-distinct-doubao",
    doubaoKey1 !== doubaoKey2,
    "expected different keys for different providers with same doubao-pro-32k id",
  );

  const ernieKey1 = modelKey(makeModel({ provider: "baidu", id: "ernie-4.0" }));
  const ernieKey2 = modelKey(makeModel({ provider: "custom", id: "ernie-4.0" }));
  expect(
    "newAdapter.modelKey-distinct-ernie",
    ernieKey1 !== ernieKey2,
    "expected different keys for different providers with same ernie-4.0 id",
  );
}

// ==========================================================================
// Test 49: New model families — compat warnings through describeMissingOpenAICompatibleProxyCompat (batch 2)
// ==========================================================================
{
  // Doubao proxy (non-official baseUrl) — should fire compat warning
  const doubaoProxy = makeModel({
    id: "doubao-pro-32k",
    provider: "volcengine",
    api: "openai-completions",
    baseUrl: "https://volcengine.example.com/v1",
    compat: {},
  });
  const doubaoMissing = describeMissingOpenAICompatibleProxyCompat(doubaoProxy);
  expect(
    "broadCompat.doubao-both-missing",
    doubaoMissing.length === 2,
    `expected both flags missing for Doubao proxy, got: ${JSON.stringify(doubaoMissing)}`,
  );

  // ERNIE proxy — should fire compat warning
  const ernieProxy = makeModel({
    id: "ernie-4.0",
    provider: "baidu",
    api: "openai-completions",
    baseUrl: "https://baidu.example.com/v1",
    compat: {},
  });
  const ernieMissing = describeMissingOpenAICompatibleProxyCompat(ernieProxy);
  expect(
    "broadCompat.ernie-both-missing",
    ernieMissing.length === 2,
    `expected both flags missing for ERNIE proxy, got: ${JSON.stringify(ernieMissing)}`,
  );

  // Phi model with official OpenAI baseUrl — should NOT fire warning
  const phiOfficial = makeModel({
    id: "phi-3-mini",
    provider: "microsoft",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    compat: {},
  });
  const phiOfficialMissing = describeMissingOpenAICompatibleProxyCompat(phiOfficial);
  expect(
    "broadCompat.phi-official-skip",
    phiOfficialMissing.length === 0,
    `expected no compat warnings for Phi with official baseUrl, got: ${JSON.stringify(phiOfficialMissing)}`,
  );

  // Solar with openai-responses — should NOT fire (responses, not completions)
  const solarResponses = makeModel({
    id: "solar-mini",
    provider: "upstage",
    api: "openai-responses",
    baseUrl: "https://upstage.example.com/v1",
    compat: {},
  });
  const solarResponsesMissing = describeMissingOpenAICompatibleProxyCompat(solarResponses);
  expect(
    "broadCompat.solar-responses-skip",
    solarResponsesMissing.length === 0,
    `expected no compat warnings for Solar with openai-responses, got: ${JSON.stringify(solarResponsesMissing)}`,
  );

  // StepFun with kiro-api — should NOT fire
  const stepfunKiro = makeModel({
    id: "stepfun-pro-v1",
    provider: "custom",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
    compat: {},
  });
  const stepfunKiroMissing = describeMissingOpenAICompatibleProxyCompat(stepfunKiro);
  expect(
    "broadCompat.stepfun-kiro-skip",
    stepfunKiroMissing.length === 0,
    `expected no compat warnings for StepFun with kiro-api, got: ${JSON.stringify(stepfunKiroMissing)}`,
  );

  // Baichuan proxy with both compat flags — fully configured
  const baichuanConfigured = makeModel({
    id: "baichuan-2-pro",
    provider: "baichuan",
    api: "openai-completions",
    baseUrl: "https://baichuan.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  const baichuanMissing = describeMissingOpenAICompatibleProxyCompat(baichuanConfigured);
  expect(
    "broadCompat.baichuan-configured",
    baichuanMissing.length === 0,
    `expected no compat warnings for fully-configured Baichuan proxy, got: ${JSON.stringify(baichuanMissing)}`,
  );
}

// ==========================================================================
// Test 50: New model families — relaxed gate verification (batch 2)
// ==========================================================================
{
  // Doubao with openai-completions — gate should PASS
  expect(
    "relaxedGate.doubao-api-match",
    isOpenAICompatibleApi("openai-completions") === true,
    "expected isOpenAICompatibleApi to accept openai-completions for Doubao",
  );

  // ERNIE with kiro-api — gate should BLOCK
  expect(
    "relaxedGate.ernie-kiro-block",
    isOpenAICompatibleApi("kiro-api") === false,
    "expected kiro-api to block injection even for ERNIE model",
  );

  // InternLM with openai-completions — gate should PASS
  expect(
    "relaxedGate.internlm-api-match",
    isOpenAICompatibleApi("openai-completions") === true,
    "expected isOpenAICompatibleApi to accept openai-completions for InternLM",
  );

  // Gemma with openai-responses — gate should PASS
  expect(
    "relaxedGate.gemma-responses-match",
    isOpenAICompatibleApi("openai-responses") === true,
    "expected isOpenAICompatibleApi to accept openai-responses for Gemma",
  );

  // Phi model with undefined api — gate should BLOCK
  expect(
    "relaxedGate.phi-undefined-block",
    isOpenAICompatibleApi(undefined) === false,
    "expected undefined api to block injection for Phi",
  );

  // Jamba with openai-completions — gate should PASS
  expect(
    "relaxedGate.jamba-api-match",
    isOpenAICompatibleApi("openai-completions") === true,
    "expected isOpenAICompatibleApi to accept openai-completions for Jamba",
  );

  // Solar with openai-completions — gate should PASS
  expect(
    "relaxedGate.solar-api-match",
    isOpenAICompatibleApi("openai-completions") === true,
    "expected isOpenAICompatibleApi to accept openai-completions for Solar",
  );
}

// ==========================================================================
// Test 51: New model-family detection (batch 3) — Perplexity/Sonar, Amazon Nova, Reka, Falcon, DBRX, MPT, StableLM, Aquila, EXAONE, HyperCLOVA, Luminous, Hermes
// ==========================================================================
{
  // Perplexity / Sonar detection
  expect("detect.perplexity-sonar-id", isPerplexityLikeModel(makeModel({ id: "sonar-pro" })) === true, "expected sonar-pro ID to match");
  expect("detect.perplexity-perplexity-id", isPerplexityLikeModel(makeModel({ id: "perplexity-online" })) === true, "expected perplexity-online ID to match");
  expect("detect.perplexity-pplx-boundary", isPerplexityLikeModel(makeModel({ id: "pplx-7b-online" })) === true, "expected pplx-7b-online to match via pplx safe boundary");
  expect("detect.perplexity-not-gpt", isPerplexityLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Perplexity");

  // Amazon Nova detection
  expect("detect.nova-amazon-nova-id", isNovaLikeModel(makeModel({ id: "amazon-nova-pro" })) === true, "expected amazon-nova-pro ID to match");
  expect("detect.nova-boundary", isNovaLikeModel(makeModel({ id: "nova-micro-v1" })) === true, "expected nova-micro-v1 to match via nova safe boundary");
  expect("detect.nova-name", isNovaLikeModel(makeModel({ id: "custom", name: "Amazon Nova Lite" })) === true, "expected Amazon Nova Lite name to match");
  expect("detect.nova-not-gpt", isNovaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Nova");

  // Reka detection
  expect("detect.reka-id", isRekaLikeModel(makeModel({ id: "reka-core" })) === true, "expected reka-core ID to match");
  expect("detect.reka-name", isRekaLikeModel(makeModel({ id: "custom", name: "Reka Flash" })) === true, "expected Reka Flash name to match");
  expect("detect.reka-not-gpt", isRekaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Reka");
  expect("detect.reka-not-recommend", isRekaLikeModel(makeModel({ id: "recommend-v2" })) === false, "expected recommend-v2 to NOT match Reka (reka inside prose)");

  // Falcon / TII detection
  expect("detect.falcon-id", isFalconLikeModel(makeModel({ id: "falcon-2-7b" })) === true, "expected falcon-2-7b ID to match");
  expect("detect.falcon-tiiuae", isFalconLikeModel(makeModel({ id: "tiiuae/falcon-180b" })) === true, "expected tiiuae/falcon-180b ID to match");
  expect("detect.falcon-name", isFalconLikeModel(makeModel({ id: "custom", name: "Falcon 180B" })) === true, "expected Falcon 180B name to match");
  expect("detect.falcon-not-gpt", isFalconLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Falcon");
  expect("detect.falcon-not-bare-tii", isFalconLikeModel(makeModel({ id: "tii-helper" })) === false, "expected tii-helper to NOT match Falcon (bare tii rejected)");

  // DBRX / Databricks detection
  expect("detect.dbrx-id", isDbrxLikeModel(makeModel({ id: "dbrx-instruct" })) === true, "expected dbrx-instruct ID to match");
  expect("detect.dbrx-databricks", isDbrxLikeModel(makeModel({ id: "databricks-dbrx" })) === true, "expected databricks-dbrx ID to match");
  expect("detect.dbrx-name", isDbrxLikeModel(makeModel({ id: "custom", name: "Databricks DBRX" })) === true, "expected Databricks DBRX name to match");
  expect("detect.dbrx-not-gpt", isDbrxLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match DBRX");

  // MPT / MosaicML detection
  expect("detect.mpt-mosaicml-id", isMptLikeModel(makeModel({ id: "mosaicml/mpt-7b" })) === true, "expected mosaicml/mpt-7b ID to match");
  expect("detect.mpt-prefix", isMptLikeModel(makeModel({ id: "mpt-30b-instruct" })) === true, "expected mpt-30b-instruct ID to match via mpt- prefix");
  expect("detect.mpt-boundary", isMptLikeModel(makeModel({ id: "custom/mpt" })) === true, "expected custom/mpt to match via mpt safe boundary");
  expect("detect.mpt-name", isMptLikeModel(makeModel({ id: "custom", name: "MosaicML MPT" })) === true, "expected MosaicML MPT name to match");
  expect("detect.mpt-not-gpt", isMptLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match MPT");
  expect("detect.mpt-not-emptypath", isMptLikeModel(makeModel({ id: "empty-path-v1" })) === false, "expected empty-path-v1 to NOT match MPT (mpt inside prose)");

  // StableLM / Stability AI detection
  expect("detect.stablelm-id", isStableLMLikeModel(makeModel({ id: "stablelm-2-12b" })) === true, "expected stablelm-2-12b ID to match");
  expect("detect.stablelm-stable-lm", isStableLMLikeModel(makeModel({ id: "stable-lm-3b" })) === true, "expected stable-lm-3b ID to match");
  expect("detect.stablelm-stability-ai", isStableLMLikeModel(makeModel({ id: "stabilityai/stablelm" })) === true, "expected stabilityai/stablelm ID to match");
  expect("detect.stablelm-name", isStableLMLikeModel(makeModel({ id: "custom", name: "Stability AI StableLM" })) === true, "expected Stability AI StableLM name to match");
  expect("detect.stablelm-not-gpt", isStableLMLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match StableLM");
  expect("detect.stablelm-not-bare-stable", isStableLMLikeModel(makeModel({ id: "stable-diffusion" })) === false, "expected stable-diffusion to NOT match StableLM (bare stable rejected)");

  // Aquila / BAAI detection
  expect("detect.aquila-id", isAquilaLikeModel(makeModel({ id: "aquila-7b" })) === true, "expected aquila-7b ID to match");
  expect("detect.aquila-baai", isAquilaLikeModel(makeModel({ id: "baai/aquila-34b" })) === true, "expected baai/aquila-34b ID to match");
  expect("detect.aquila-name", isAquilaLikeModel(makeModel({ id: "custom", name: "BAAI Aquila" })) === true, "expected BAAI Aquila name to match");
  expect("detect.aquila-not-gpt", isAquilaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Aquila");

  // EXAONE detection
  expect("detect.exaone-id", isExaoneLikeModel(makeModel({ id: "exaone-3.5" })) === true, "expected exaone-3.5 ID to match");
  expect("detect.exaone-name", isExaoneLikeModel(makeModel({ id: "custom", name: "EXAONE 3.5" })) === true, "expected EXAONE 3.5 name to match");
  expect("detect.exaone-not-gpt", isExaoneLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match EXAONE");

  // HyperCLOVA X / Naver detection (conservative)
  expect("detect.hyperclova-id", isHyperCLOVALikeModel(makeModel({ id: "hyperclova-x" })) === true, "expected hyperclova-x ID to match");
  expect("detect.hyperclova-clova-x", isHyperCLOVALikeModel(makeModel({ id: "clova-x-optimized" })) === true, "expected clova-x-optimized ID to match");
  expect("detect.hyperclova-name", isHyperCLOVALikeModel(makeModel({ id: "custom", name: "HyperCLOVA X" })) === true, "expected HyperCLOVA X name to match");
  expect("detect.hyperclova-not-gpt", isHyperCLOVALikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match HyperCLOVA");
  expect("detect.hyperclova-not-bare-clova", isHyperCLOVALikeModel(makeModel({ id: "clova-speech" })) === false, "expected clova-speech to NOT match HyperCLOVA (bare clova rejected; clova-x only)");
  expect("detect.hyperclova-not-bare-naver", isHyperCLOVALikeModel(makeModel({ id: "naver-search" })) === false, "expected naver-search to NOT match HyperCLOVA (bare naver rejected)");

  // Luminous / Aleph Alpha detection
  expect("detect.luminous-id", isLuminousLikeModel(makeModel({ id: "luminous-extended" })) === true, "expected luminous-extended ID to match");
  expect("detect.luminous-aleph-alpha", isLuminousLikeModel(makeModel({ id: "aleph-alpha/luminous" })) === true, "expected aleph-alpha/luminous ID to match");
  expect("detect.luminous-aleph-boundary", isLuminousLikeModel(makeModel({ id: "aleph/luminous" })) === true, "expected aleph/luminous to match via aleph safe boundary");
  expect("detect.luminous-name", isLuminousLikeModel(makeModel({ id: "custom", name: "Aleph Alpha Luminous" })) === true, "expected Aleph Alpha Luminous name to match");
  expect("detect.luminous-not-gpt", isLuminousLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Luminous");
  expect("detect.luminous-not-bare-aleph-prose", isLuminousLikeModel(makeModel({ id: "alephprose-v1" })) === false, "expected alephprose-v1 to NOT match Luminous (aleph inside prose without boundaries)");

  // Hermes / Nous detection
  expect("detect.hermes-nous-id", isHermesLikeModel(makeModel({ id: "nous-hermes-2-mixtral" })) === true, "expected nous-hermes-2-mixtral ID to match");
  expect("detect.hermes-openhermes", isHermesLikeModel(makeModel({ id: "openhermes-2.5" })) === true, "expected openhermes-2.5 ID to match");
  expect("detect.hermes-name", isHermesLikeModel(makeModel({ id: "custom", name: "Nous Hermes" })) === true, "expected Nous Hermes name to match");
  expect("detect.hermes-not-gpt", isHermesLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Hermes");
}

// ==========================================================================
// Test 52: New model-family assistant message detection (batch 3)
// ==========================================================================
{
  // Perplexity assistant
  expect("detect.perplexity-assistant", isPerplexityLikeAssistantMessage({ role: "assistant", model: "sonar-pro" }, undefined) === true, "expected sonar-pro assistant message to match");
  expect("detect.perplexity-pplx-assistant", isPerplexityLikeAssistantMessage({ role: "assistant", name: "pplx-7b" }, undefined) === true, "expected pplx-7b assistant message with name to match");

  // Nova assistant
  expect("detect.nova-assistant", isNovaLikeAssistantMessage({ role: "assistant", model: "amazon-nova-pro" }, undefined) === true, "expected amazon-nova-pro assistant message to match");
  expect("detect.nova-name-assistant", isNovaLikeAssistantMessage({ role: "assistant", name: "Nova Micro" }, undefined) === true, "expected Nova Micro assistant message with name to match via nova boundary");

  // Reka assistant
  expect("detect.reka-assistant", isRekaLikeAssistantMessage({ role: "assistant", model: "reka-core" }, undefined) === true, "expected reka-core assistant message to match");

  // Falcon assistant
  expect("detect.falcon-assistant", isFalconLikeAssistantMessage({ role: "assistant", model: "falcon-2-7b" }, undefined) === true, "expected falcon-2-7b assistant message to match");
  expect("detect.falcon-tiiuae-assistant", isFalconLikeAssistantMessage({ role: "assistant", model: "tiiuae/falcon-180b" }, undefined) === true, "expected tiiuae/falcon-180b assistant message to match");

  // DBRX assistant
  expect("detect.dbrx-assistant", isDbrxLikeAssistantMessage({ role: "assistant", model: "dbrx-instruct" }, undefined) === true, "expected dbrx-instruct assistant message to match");
  expect("detect.dbrx-databricks-assistant", isDbrxLikeAssistantMessage({ role: "assistant", model: "databricks-dbrx" }, undefined) === true, "expected databricks-dbrx assistant message to match");

  // MPT assistant
  expect("detect.mpt-assistant", isMptLikeAssistantMessage({ role: "assistant", model: "mpt-30b-instruct" }, undefined) === true, "expected mpt-30b-instruct assistant message to match");
  expect("detect.mpt-mosaicml-assistant", isMptLikeAssistantMessage({ role: "assistant", model: "mosaicml/mpt-7b" }, undefined) === true, "expected mosaicml/mpt-7b assistant message to match");

  // StableLM assistant
  expect("detect.stablelm-assistant", isStableLMLikeAssistantMessage({ role: "assistant", model: "stablelm-2-12b" }, undefined) === true, "expected stablelm-2-12b assistant message to match");
  expect("detect.stablelm-stability-ai-assistant", isStableLMLikeAssistantMessage({ role: "assistant", name: "Stability-AI StableLM" }, undefined) === true, "expected Stability-AI StableLM assistant message with name to match");

  // Aquila assistant
  expect("detect.aquila-assistant", isAquilaLikeAssistantMessage({ role: "assistant", model: "aquila-7b" }, undefined) === true, "expected aquila-7b assistant message to match");
  expect("detect.aquila-baai-assistant", isAquilaLikeAssistantMessage({ role: "assistant", model: "baai/aquila-34b" }, undefined) === true, "expected baai/aquila-34b assistant message to match");

  // EXAONE assistant
  expect("detect.exaone-assistant", isExaoneLikeAssistantMessage({ role: "assistant", model: "exaone-3.5" }, undefined) === true, "expected exaone-3.5 assistant message to match");

  // HyperCLOVA assistant
  expect("detect.hyperclova-assistant", isHyperCLOVALikeAssistantMessage({ role: "assistant", model: "hyperclova-x" }, undefined) === true, "expected hyperclova-x assistant message to match");
  expect("detect.hyperclova-clova-x-assistant", isHyperCLOVALikeAssistantMessage({ role: "assistant", name: "clova-x" }, undefined) === true, "expected clova-x assistant message with name to match");

  // Luminous assistant
  expect("detect.luminous-assistant", isLuminousLikeAssistantMessage({ role: "assistant", model: "luminous-extended" }, undefined) === true, "expected luminous-extended assistant message to match");
  expect("detect.luminous-aleph-assistant", isLuminousLikeAssistantMessage({ role: "assistant", name: "aleph-alpha" }, undefined) === true, "expected aleph-alpha assistant message with name to match");

  // Hermes assistant
  expect("detect.hermes-assistant", isHermesLikeAssistantMessage({ role: "assistant", model: "nous-hermes-2-mixtral" }, undefined) === true, "expected nous-hermes-2-mixtral assistant message to match");
  expect("detect.hermes-openhermes-assistant", isHermesLikeAssistantMessage({ role: "assistant", model: "openhermes-2.5" }, undefined) === true, "expected openhermes-2.5 assistant message to match");
}

// ==========================================================================
// Test 53: New model-family adapter labels (batch 3)
// ==========================================================================
{
  // Sonar / Perplexity label
  const sonarFormatted = formatCacheStats(
    { id: "openai", label: "Sonar cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.sonar-label", sonarFormatted.startsWith("Sonar cache"), `expected label "Sonar cache", got: "${sonarFormatted}"`);

  // Nova label
  const novaFormatted = formatCacheStats(
    { id: "openai", label: "Nova cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.nova-label", novaFormatted.startsWith("Nova cache"), `expected label "Nova cache", got: "${novaFormatted}"`);

  // Reka label
  const rekaFormatted = formatCacheStats(
    { id: "openai", label: "Reka cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.reka-label", rekaFormatted.startsWith("Reka cache"), `expected label "Reka cache", got: "${rekaFormatted}"`);

  // Falcon label
  const falconFormatted = formatCacheStats(
    { id: "openai", label: "Falcon cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.falcon-label", falconFormatted.startsWith("Falcon cache"), `expected label "Falcon cache", got: "${falconFormatted}"`);

  // DBRX label
  const dbrxFormatted = formatCacheStats(
    { id: "openai", label: "DBRX cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.dbrx-label", dbrxFormatted.startsWith("DBRX cache"), `expected label "DBRX cache", got: "${dbrxFormatted}"`);

  // MPT label
  const mptFormatted = formatCacheStats(
    { id: "openai", label: "MPT cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.mpt-label", mptFormatted.startsWith("MPT cache"), `expected label "MPT cache", got: "${mptFormatted}"`);

  // StableLM label
  const stablelmFormatted = formatCacheStats(
    { id: "openai", label: "StableLM cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.stablelm-label", stablelmFormatted.startsWith("StableLM cache"), `expected label "StableLM cache", got: "${stablelmFormatted}"`);

  // Aquila label
  const aquilaFormatted = formatCacheStats(
    { id: "openai", label: "Aquila cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.aquila-label", aquilaFormatted.startsWith("Aquila cache"), `expected label "Aquila cache", got: "${aquilaFormatted}"`);

  // EXAONE label
  const exaoneFormatted = formatCacheStats(
    { id: "openai", label: "EXAONE cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.exaone-label", exaoneFormatted.startsWith("EXAONE cache"), `expected label "EXAONE cache", got: "${exaoneFormatted}"`);

  // HyperCLOVA label
  const hyperclovaFormatted = formatCacheStats(
    { id: "openai", label: "HyperCLOVA cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.hyperclova-label", hyperclovaFormatted.startsWith("HyperCLOVA cache"), `expected label "HyperCLOVA cache", got: "${hyperclovaFormatted}"`);

  // Luminous label
  const luminousFormatted = formatCacheStats(
    { id: "openai", label: "Luminous cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.luminous-label", luminousFormatted.startsWith("Luminous cache"), `expected label "Luminous cache", got: "${luminousFormatted}"`);

  // Hermes label
  const hermesFormatted = formatCacheStats(
    { id: "openai", label: "Hermes cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.hermes-label", hermesFormatted.startsWith("Hermes cache"), `expected label "Hermes cache", got: "${hermesFormatted}"`);

  // Model key separation: same id under different providers
  const sonarKey1 = modelKey(makeModel({ provider: "perplexity", id: "sonar-pro" }));
  const sonarKey2 = modelKey(makeModel({ provider: "custom", id: "sonar-pro" }));
  expect("newAdapter.modelKey-distinct-sonar", sonarKey1 !== sonarKey2, "expected different keys for different providers with same sonar-pro id");

  const novaKey1 = modelKey(makeModel({ provider: "aws", id: "amazon-nova-pro" }));
  const novaKey2 = modelKey(makeModel({ provider: "custom", id: "amazon-nova-pro" }));
  expect("newAdapter.modelKey-distinct-nova", novaKey1 !== novaKey2, "expected different keys for different providers with same amazon-nova-pro id");

  const rekaKey1 = modelKey(makeModel({ provider: "reka", id: "reka-core" }));
  const rekaKey2 = modelKey(makeModel({ provider: "custom", id: "reka-core" }));
  expect("newAdapter.modelKey-distinct-reka", rekaKey1 !== rekaKey2, "expected different keys for different providers with same reka-core id");
}

// ==========================================================================
// Test 54: New model families (batch 3) — compat warnings through describeMissingOpenAICompatibleProxyCompat
// ==========================================================================
{
  // Perplexity proxy (non-official) — should fire compat warning
  const perplexityProxy = makeModel({
    id: "sonar-pro",
    provider: "perplexity",
    api: "openai-completions",
    baseUrl: "https://perplexity.example.com/v1",
    compat: {},
  });
  const perplexityMissing = describeMissingOpenAICompatibleProxyCompat(perplexityProxy);
  expect("broadCompat.perplexity-both-missing", perplexityMissing.length === 2, `expected both flags missing for Perplexity proxy, got: ${JSON.stringify(perplexityMissing)}`);

  // Nova proxy — should fire compat warning
  const novaProxy = makeModel({
    id: "amazon-nova-pro",
    provider: "aws",
    api: "openai-completions",
    baseUrl: "https://nova.example.com/v1",
    compat: {},
  });
  const novaMissing = describeMissingOpenAICompatibleProxyCompat(novaProxy);
  expect("broadCompat.nova-both-missing", novaMissing.length === 2, `expected both flags missing for Nova proxy, got: ${JSON.stringify(novaMissing)}`);

  // Reka with official OpenAI baseUrl — should NOT fire
  const rekaOfficial = makeModel({
    id: "reka-core",
    provider: "reka",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    compat: {},
  });
  const rekaOfficialMissing = describeMissingOpenAICompatibleProxyCompat(rekaOfficial);
  expect("broadCompat.reka-official-skip", rekaOfficialMissing.length === 0, `expected no compat warnings for Reka with official baseUrl, got: ${JSON.stringify(rekaOfficialMissing)}`);

  // Falcon with kiro-api — should NOT fire
  const falconKiro = makeModel({
    id: "falcon-2-7b",
    provider: "tii",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
    compat: {},
  });
  const falconKiroMissing = describeMissingOpenAICompatibleProxyCompat(falconKiro);
  expect("broadCompat.falcon-kiro-skip", falconKiroMissing.length === 0, `expected no compat warnings for Falcon with kiro-api, got: ${JSON.stringify(falconKiroMissing)}`);

  // DBRX with both compat flags — fully configured
  const dbrxConfigured = makeModel({
    id: "dbrx-instruct",
    provider: "databricks",
    api: "openai-completions",
    baseUrl: "https://dbrx.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  const dbrxMissing = describeMissingOpenAICompatibleProxyCompat(dbrxConfigured);
  expect("broadCompat.dbrx-configured", dbrxMissing.length === 0, `expected no compat warnings for fully-configured DBRX proxy, got: ${JSON.stringify(dbrxMissing)}`);

  // MPT proxy — should fire compat warning
  const mptProxy = makeModel({
    id: "mpt-30b-instruct",
    provider: "mosaicml",
    api: "openai-completions",
    baseUrl: "https://mpt.example.com/v1",
    compat: {},
  });
  const mptMissing = describeMissingOpenAICompatibleProxyCompat(mptProxy);
  expect("broadCompat.mpt-both-missing", mptMissing.length === 2, `expected both flags missing for MPT proxy, got: ${JSON.stringify(mptMissing)}`);

  // StableLM proxy — should fire compat warning
  const stablelmProxy = makeModel({
    id: "stablelm-2-12b",
    provider: "stability-ai",
    api: "openai-completions",
    baseUrl: "https://stablelm.example.com/v1",
    compat: {},
  });
  const stablelmMissing = describeMissingOpenAICompatibleProxyCompat(stablelmProxy);
  expect("broadCompat.stablelm-both-missing", stablelmMissing.length === 2, `expected both flags missing for StableLM proxy, got: ${JSON.stringify(stablelmMissing)}`);

  // Aquila with openai-responses — should NOT fire
  const aquilaResponses = makeModel({
    id: "aquila-7b",
    provider: "baai",
    api: "openai-responses",
    baseUrl: "https://aquila.example.com/v1",
    compat: {},
  });
  const aquilaResponsesMissing = describeMissingOpenAICompatibleProxyCompat(aquilaResponses);
  expect("broadCompat.aquila-responses-skip", aquilaResponsesMissing.length === 0, `expected no compat warnings for Aquila with openai-responses, got: ${JSON.stringify(aquilaResponsesMissing)}`);

  // EXAONE with kiro-api — should NOT fire
  const exaoneKiro = makeModel({
    id: "exaone-3.5",
    provider: "lg",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/v1",
    compat: {},
  });
  const exaoneKiroMissing = describeMissingOpenAICompatibleProxyCompat(exaoneKiro);
  expect("broadCompat.exaone-kiro-skip", exaoneKiroMissing.length === 0, `expected no compat warnings for EXAONE with kiro-api, got: ${JSON.stringify(exaoneKiroMissing)}`);

  // HyperCLOVA proxy — should fire compat warning
  const hyperclovaProxy = makeModel({
    id: "hyperclova-x",
    provider: "naver",
    api: "openai-completions",
    baseUrl: "https://hyperclova.example.com/v1",
    compat: {},
  });
  const hyperclovaMissing = describeMissingOpenAICompatibleProxyCompat(hyperclovaProxy);
  expect("broadCompat.hyperclova-both-missing", hyperclovaMissing.length === 2, `expected both flags missing for HyperCLOVA proxy, got: ${JSON.stringify(hyperclovaMissing)}`);

  // Luminous with both compat flags — fully configured
  const luminousConfigured = makeModel({
    id: "luminous-extended",
    provider: "aleph-alpha",
    api: "openai-completions",
    baseUrl: "https://luminous.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  const luminousMissing = describeMissingOpenAICompatibleProxyCompat(luminousConfigured);
  expect("broadCompat.luminous-configured", luminousMissing.length === 0, `expected no compat warnings for fully-configured Luminous proxy, got: ${JSON.stringify(luminousMissing)}`);

  // Hermes proxy — should fire compat warning
  const hermesProxy = makeModel({
    id: "nous-hermes-2-mixtral",
    provider: "nous",
    api: "openai-completions",
    baseUrl: "https://hermes.example.com/v1",
    compat: {},
  });
  const hermesMissing = describeMissingOpenAICompatibleProxyCompat(hermesProxy);
  expect("broadCompat.hermes-both-missing", hermesMissing.length === 2, `expected both flags missing for Hermes proxy, got: ${JSON.stringify(hermesMissing)}`);
}

// ==========================================================================
// Test 55: New model families (batch 3) — relaxed gate verification
// ==========================================================================
{
  // Perplexity with openai-completions — gate should PASS
  expect("relaxedGate.perplexity-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for Perplexity");

  // Nova with kiro-api — gate should BLOCK
  expect("relaxedGate.nova-kiro-block", isOpenAICompatibleApi("kiro-api") === false, "expected kiro-api to block injection for Nova");

  // Reka with openai-completions — gate should PASS
  expect("relaxedGate.reka-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for Reka");

  // Falcon with openai-responses — gate should PASS
  expect("relaxedGate.falcon-responses-match", isOpenAICompatibleApi("openai-responses") === true, "expected isOpenAICompatibleApi to accept openai-responses for Falcon");

  // DBRX with undefined api — gate should BLOCK
  expect("relaxedGate.dbrx-undefined-block", isOpenAICompatibleApi(undefined) === false, "expected undefined api to block injection for DBRX");

  // MPT with openai-completions — gate should PASS
  expect("relaxedGate.mpt-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for MPT");

  // StableLM with openai-completions — gate should PASS
  expect("relaxedGate.stablelm-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for StableLM");

  // Aquila with kiro-api — gate should BLOCK
  expect("relaxedGate.aquila-kiro-block", isOpenAICompatibleApi("kiro-api") === false, "expected kiro-api to block injection for Aquila");

  // EXAONE with openai-completions — gate should PASS
  expect("relaxedGate.exaone-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for EXAONE");

  // HyperCLOVA with openai-responses — gate should PASS
  expect("relaxedGate.hyperclova-responses-match", isOpenAICompatibleApi("openai-responses") === true, "expected isOpenAICompatibleApi to accept openai-responses for HyperCLOVA");

  // Luminous with openai-completions — gate should PASS
  expect("relaxedGate.luminous-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for Luminous");

  // Hermes with undefined api — gate should BLOCK
  expect("relaxedGate.hermes-undefined-block", isOpenAICompatibleApi(undefined) === false, "expected undefined api to block injection for Hermes");
}

// ==========================================================================
// Test 56: New model-family detection (batch 4) — Granite, Arctic, Pangu, SenseNova, Zhinao, MiniCPM, XVERSE, Orion, OpenChat, Vicuna, Wizard, Zephyr, Dolphin, OpenOrca, Starling, BLOOM, RWKV, Aya
// ==========================================================================
{
  // Granite detection
  expect("detect.granite-id", isGraniteLikeModel(makeModel({ id: "granite-13b-instruct" })) === true, "expected granite-13b-instruct ID to match");
  expect("detect.granite-ibm", isGraniteLikeModel(makeModel({ id: "ibm-granite-20b" })) === true, "expected ibm-granite-20b ID to match");
  expect("detect.granite-name", isGraniteLikeModel(makeModel({ id: "custom", name: "IBM Granite" })) === true, "expected IBM Granite name to match");
  expect("detect.granite-not-gpt", isGraniteLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Granite");

  // Arctic detection
  expect("detect.arctic-snowflake-id", isArcticLikeModel(makeModel({ id: "snowflake-arctic-embed" })) === true, "expected snowflake-arctic-embed ID to match");
  expect("detect.arctic-boundary", isArcticLikeModel(makeModel({ id: "arctic-2-70b" })) === true, "expected arctic-2-70b to match via arctic safe boundary");
  expect("detect.arctic-name", isArcticLikeModel(makeModel({ id: "custom", name: "Snowflake Arctic" })) === true, "expected Snowflake Arctic name to match via arctic boundary");
  expect("detect.arctic-not-gpt", isArcticLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Arctic");
  expect("detect.arctic-not-prose", isArcticLikeModel(makeModel({ id: "fartical-v1" })) === false, "expected fartical-v1 to NOT match Arctic (arctic inside prose)");

  // Pangu detection
  expect("detect.pangu-id", isPanguLikeModel(makeModel({ id: "pangu-33b" })) === true, "expected pangu-33b ID to match");
  expect("detect.pangu-pan-gu", isPanguLikeModel(makeModel({ id: "pan-gu-7b" })) === true, "expected pan-gu-7b ID to match");
  expect("detect.pangu-huawei", isPanguLikeModel(makeModel({ id: "huawei-pangu-100b" })) === true, "expected huawei-pangu-100b ID to match");
  expect("detect.pangu-name", isPanguLikeModel(makeModel({ id: "custom", name: "盘古 Pangu" })) === true, "expected 盘古 Pangu name to match");
  expect("detect.pangu-盘古", isPanguLikeModel(makeModel({ id: "盘古-pro" })) === true, "expected 盘古-pro ID to match");
  expect("detect.pangu-not-gpt", isPanguLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Pangu");

  // SenseNova detection
  expect("detect.sensenova-id", isSenseNovaLikeModel(makeModel({ id: "sensenova-v5" })) === true, "expected sensenova-v5 ID to match");
  expect("detect.sensenova-sense-nova", isSenseNovaLikeModel(makeModel({ id: "sense-nova-5" })) === true, "expected sense-nova-5 ID to match");
  expect("detect.sensenova-sensechat", isSenseNovaLikeModel(makeModel({ id: "sensechat-v2" })) === true, "expected sensechat-v2 ID to match");
  expect("detect.sensenova-name", isSenseNovaLikeModel(makeModel({ id: "custom", name: "商汤 SenseNova" })) === true, "expected 商汤 SenseNova name to match");
  expect("detect.sensenova-商汤", isSenseNovaLikeModel(makeModel({ id: "商汤-sensenova" })) === true, "expected 商汤-sensenova ID to match");
  expect("detect.sensenova-not-gpt", isSenseNovaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match SenseNova");

  // Zhinao detection
  expect("detect.zhinao-360gpt", isZhinaoLikeModel(makeModel({ id: "360gpt-pro" })) === true, "expected 360gpt-pro ID to match");
  expect("detect.zhinao-360-gpt", isZhinaoLikeModel(makeModel({ id: "360-gpt-v2" })) === true, "expected 360-gpt-v2 ID to match");
  expect("detect.zhinao-name", isZhinaoLikeModel(makeModel({ id: "custom", name: "360 Zhinao" })) === true, "expected 360 Zhinao name to match via zhinao");
  expect("detect.zhinao-智脑", isZhinaoLikeModel(makeModel({ id: "智脑-v3" })) === true, "expected 智脑-v3 ID to match");
  expect("detect.zhinao-not-gpt", isZhinaoLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Zhinao");
  expect("detect.zhinao-not-bare-360", isZhinaoLikeModel(makeModel({ id: "360-some-other-model" })) === false, "expected 360-some-other-model to NOT match Zhinao (bare 360 rejected without gpt/zhinao context)");

  // MiniCPM detection
  expect("detect.minicpm-id", isMiniCPMLikeModel(makeModel({ id: "minicpm-2b" })) === true, "expected minicpm-2b ID to match");
  expect("detect.minicpm-mini-cpm", isMiniCPMLikeModel(makeModel({ id: "mini-cpm-llama3" })) === true, "expected mini-cpm-llama3 ID to match");
  expect("detect.minicpm-openbmb", isMiniCPMLikeModel(makeModel({ id: "openbmb/minicpm-2.4b" })) === true, "expected openbmb/minicpm-2.4b ID to match");
  expect("detect.minicpm-not-gpt", isMiniCPMLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match MiniCPM");

  // XVERSE detection
  expect("detect.xverse-id", isXVerseLikeModel(makeModel({ id: "xverse-13b" })) === true, "expected xverse-13b ID to match");
  expect("detect.xverse-name", isXVerseLikeModel(makeModel({ id: "custom", name: "XVERSE 13B" })) === true, "expected XVERSE 13B name to match");
  expect("detect.xverse-not-gpt", isXVerseLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match XVERSE");

  // Orion detection
  expect("detect.orion-id", isOrionLikeModel(makeModel({ id: "Orion-14B" })) === true, "expected Orion-14B ID to match via orion safe boundary");
  expect("detect.orion-name", isOrionLikeModel(makeModel({ id: "custom", name: "OrionStar Yi" })) === true, "expected OrionStar Yi name to match via orion boundary");
  expect("detect.orion-orionstar", isOrionLikeModel(makeModel({ id: "orionstar-yi-34b" })) === true, "expected orionstar-yi-34b ID to match");
  expect("detect.orion-notch-aware", isOrionLikeModel(makeModel({ id: "notion-v1-custom" })) === false, "expected notion-v1-custom to NOT match Orion (orion inside prose)");
  expect("detect.orion-not-gpt", isOrionLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Orion");

  // OpenChat detection
  expect("detect.openchat-id", isOpenChatLikeModel(makeModel({ id: "openchat-3.5" })) === true, "expected openchat-3.5 ID to match");
  expect("detect.openchat-name", isOpenChatLikeModel(makeModel({ id: "custom", name: "OpenChat 3.5" })) === true, "expected OpenChat 3.5 name to match");
  expect("detect.openchat-not-gpt", isOpenChatLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match OpenChat");

  // Vicuna detection
  expect("detect.vicuna-id", isVicunaLikeModel(makeModel({ id: "vicuna-13b-v1.5" })) === true, "expected vicuna-13b-v1.5 ID to match");
  expect("detect.vicuna-name", isVicunaLikeModel(makeModel({ id: "custom", name: "Vicuna 13B" })) === true, "expected Vicuna 13B name to match");
  expect("detect.vicuna-not-gpt", isVicunaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Vicuna");

  // Wizard detection
  expect("detect.wizard-wizardlm", isWizardLikeModel(makeModel({ id: "wizardlm-30b" })) === true, "expected wizardlm-30b ID to match");
  expect("detect.wizard-wizard-coder", isWizardLikeModel(makeModel({ id: "wizard-coder-15b" })) === true, "expected wizard-coder-15b ID to match");
  expect("detect.wizard-name", isWizardLikeModel(makeModel({ id: "custom", name: "WizardLM 2" })) === true, "expected WizardLM 2 name to match");
  expect("detect.wizard-not-gpt", isWizardLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Wizard");

  // Zephyr detection
  expect("detect.zephyr-id", isZephyrLikeModel(makeModel({ id: "zephyr-7b-beta" })) === true, "expected zephyr-7b-beta ID to match");
  expect("detect.zephyr-name", isZephyrLikeModel(makeModel({ id: "custom", name: "Zephyr 7B" })) === true, "expected Zephyr 7B name to match");
  expect("detect.zephyr-not-gpt", isZephyrLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Zephyr");

  // Dolphin detection
  expect("detect.dolphin-id", isDolphinLikeModel(makeModel({ id: "dolphin-2.9-llama3" })) === true, "expected dolphin-2.9-llama3 ID to match");
  expect("detect.dolphin-name", isDolphinLikeModel(makeModel({ id: "custom", name: "Dolphin 2.9" })) === true, "expected Dolphin 2.9 name to match");
  expect("detect.dolphin-not-gpt", isDolphinLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Dolphin");

  // OpenOrca detection
  expect("detect.openorca-id", isOpenOrcaLikeModel(makeModel({ id: "openorca-platypus2" })) === true, "expected openorca-platypus2 ID to match");
  expect("detect.openorca-open-orca", isOpenOrcaLikeModel(makeModel({ id: "open-orca-mistral" })) === true, "expected open-orca-mistral ID to match");
  expect("detect.openorca-not-gpt", isOpenOrcaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match OpenOrca");

  // Starling detection
  expect("detect.starling-id", isStarlingLikeModel(makeModel({ id: "starling-lm-7b" })) === true, "expected starling-lm-7b ID to match");
  expect("detect.starling-name", isStarlingLikeModel(makeModel({ id: "custom", name: "Starling LM" })) === true, "expected Starling LM name to match");
  expect("detect.starling-not-gpt", isStarlingLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Starling");

  // BLOOM detection
  expect("detect.bloom-id", isBloomLikeModel(makeModel({ id: "bloom-176b" })) === true, "expected bloom-176b ID to match");
  expect("detect.bloom-bigscience", isBloomLikeModel(makeModel({ id: "bigscience/bloomz" })) === true, "expected bigscience/bloomz ID to match");
  expect("detect.bloom-name", isBloomLikeModel(makeModel({ id: "custom", name: "BLOOM 176B" })) === true, "expected BLOOM 176B name to match");
  expect("detect.bloom-not-gpt", isBloomLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match BLOOM");

  // RWKV detection
  expect("detect.rwkv-id", isRwkvLikeModel(makeModel({ id: "rwkv-x-169m" })) === true, "expected rwkv-x-169m ID to match");
  expect("detect.rwkv-name", isRwkvLikeModel(makeModel({ id: "custom", name: "RWKV 5" })) === true, "expected RWKV 5 name to match");
  expect("detect.rwkv-not-gpt", isRwkvLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match RWKV");

  // Aya detection
  expect("detect.aya-aya-expanse", isAyaLikeModel(makeModel({ id: "aya-expanse-32b" })) === true, "expected aya-expanse-32b ID to match");
  expect("detect.aya-boundary", isAyaLikeModel(makeModel({ id: "aya-23-8b" })) === true, "expected aya-23-8b to match via aya safe boundary");
  expect("detect.aya-name", isAyaLikeModel(makeModel({ id: "custom", name: "Cohere Aya" })) === true, "expected Cohere Aya name to match via aya boundary");
  expect("detect.aya-not-maya", isAyaLikeModel(makeModel({ id: "maya-v1" })) === false, "expected maya-v1 to NOT match Aya (aya inside prose)");
  expect("detect.aya-not-payara", isAyaLikeModel(makeModel({ id: "payara-v2" })) === false, "expected payara-v2 to NOT match Aya (aya inside prose)");
  expect("detect.aya-not-gpt", isAyaLikeModel(makeModel({ id: "gpt-4" })) === false, "expected gpt-4 to NOT match Aya");
}

// ==========================================================================
// Test 57: New model-family assistant message detection (batch 4)
// ==========================================================================
{
  // Granite assistant
  expect("detect.granite-assistant", isGraniteLikeAssistantMessage({ role: "assistant", model: "granite-13b-instruct" }, undefined) === true, "expected Granite assistant message to match");
  expect("detect.granite-ibm-assistant", isGraniteLikeAssistantMessage({ role: "assistant", model: "ibm-granite-20b" }, undefined) === true, "expected ibm-granite-20b assistant message to match");

  // Arctic assistant
  expect("detect.arctic-assistant", isArcticLikeAssistantMessage({ role: "assistant", model: "snowflake-arctic-embed" }, undefined) === true, "expected Arctic assistant message to match");
  expect("detect.arctic-boundary-assistant", isArcticLikeAssistantMessage({ role: "assistant", name: "arctic-2-70b" }, undefined) === true, "expected arctic-2-70b assistant message with name to match via arctic boundary");

  // Pangu assistant
  expect("detect.pangu-assistant", isPanguLikeAssistantMessage({ role: "assistant", model: "pangu-33b" }, undefined) === true, "expected Pangu assistant message to match");
  expect("detect.pangu-name-assistant", isPanguLikeAssistantMessage({ role: "assistant", name: "盘古" }, undefined) === true, "expected 盘古 assistant message with name to match");

  // SenseNova assistant
  expect("detect.sensenova-assistant", isSenseNovaLikeAssistantMessage({ role: "assistant", model: "sense-nova-5" }, undefined) === true, "expected SenseNova assistant message to match");
  expect("detect.sensenova-商汤-assistant", isSenseNovaLikeAssistantMessage({ role: "assistant", name: "商汤" }, undefined) === true, "expected 商汤 assistant message with name to match");

  // Zhinao assistant
  expect("detect.zhinao-assistant", isZhinaoLikeAssistantMessage({ role: "assistant", model: "360gpt-pro" }, undefined) === true, "expected Zhinao assistant message to match");
  expect("detect.zhinao-智脑-assistant", isZhinaoLikeAssistantMessage({ role: "assistant", name: "智脑" }, undefined) === true, "expected 智脑 assistant message with name to match");

  // MiniCPM assistant
  expect("detect.minicpm-assistant", isMiniCPMLikeAssistantMessage({ role: "assistant", model: "minicpm-2b" }, undefined) === true, "expected MiniCPM assistant message to match");
  expect("detect.minicpm-openbmb-assistant", isMiniCPMLikeAssistantMessage({ role: "assistant", model: "openbmb/minicpm" }, undefined) === true, "expected openbmb/minicpm assistant message to match");

  // XVERSE assistant
  expect("detect.xverse-assistant", isXVerseLikeAssistantMessage({ role: "assistant", model: "xverse-13b" }, undefined) === true, "expected XVERSE assistant message to match");

  // Orion assistant
  expect("detect.orion-assistant", isOrionLikeAssistantMessage({ role: "assistant", model: "Orion-14B" }, undefined) === true, "expected Orion assistant message to match via orion boundary");
  expect("detect.orionstar-assistant", isOrionLikeAssistantMessage({ role: "assistant", model: "orionstar-yi-34b" }, undefined) === true, "expected orionstar-yi-34b assistant message to match");

  // OpenChat assistant
  expect("detect.openchat-assistant", isOpenChatLikeAssistantMessage({ role: "assistant", model: "openchat-3.5" }, undefined) === true, "expected OpenChat assistant message to match");

  // Vicuna assistant
  expect("detect.vicuna-assistant", isVicunaLikeAssistantMessage({ role: "assistant", model: "vicuna-13b-v1.5" }, undefined) === true, "expected Vicuna assistant message to match");

  // Wizard assistant
  expect("detect.wizard-assistant", isWizardLikeAssistantMessage({ role: "assistant", model: "wizardlm-30b" }, undefined) === true, "expected Wizard assistant message to match");

  // Zephyr assistant
  expect("detect.zephyr-assistant", isZephyrLikeAssistantMessage({ role: "assistant", model: "zephyr-7b-beta" }, undefined) === true, "expected Zephyr assistant message to match");

  // Dolphin assistant
  expect("detect.dolphin-assistant", isDolphinLikeAssistantMessage({ role: "assistant", model: "dolphin-2.9-llama3" }, undefined) === true, "expected Dolphin assistant message to match");

  // OpenOrca assistant
  expect("detect.openorca-assistant", isOpenOrcaLikeAssistantMessage({ role: "assistant", model: "openorca-platypus2" }, undefined) === true, "expected OpenOrca assistant message to match");

  // Starling assistant
  expect("detect.starling-assistant", isStarlingLikeAssistantMessage({ role: "assistant", model: "starling-lm-7b" }, undefined) === true, "expected Starling assistant message to match");

  // BLOOM assistant
  expect("detect.bloom-assistant", isBloomLikeAssistantMessage({ role: "assistant", model: "bloom-176b" }, undefined) === true, "expected BLOOM assistant message to match");
  expect("detect.bloom-bigscience-assistant", isBloomLikeAssistantMessage({ role: "assistant", model: "bigscience/bloomz" }, undefined) === true, "expected bigscience/bloomz assistant message to match");

  // RWKV assistant
  expect("detect.rwkv-assistant", isRwkvLikeAssistantMessage({ role: "assistant", model: "rwkv-x-169m" }, undefined) === true, "expected RWKV assistant message to match");

  // Aya assistant
  expect("detect.aya-assistant", isAyaLikeAssistantMessage({ role: "assistant", model: "aya-expanse-32b" }, undefined) === true, "expected Aya assistant message to match");
  expect("detect.aya-boundary-assistant", isAyaLikeAssistantMessage({ role: "assistant", name: "aya-23-8b" }, undefined) === true, "expected aya-23-8b assistant message with name to match via aya boundary");
}

// ==========================================================================
// Test 58: New model-family adapter labels and stats separation (batch 4)
// ==========================================================================
{
  // Granite adapter label
  const graniteFormatted = formatCacheStats(
    { id: "openai", label: "Granite cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.granite-label", graniteFormatted.startsWith("Granite cache"), `expected label "Granite cache", got: "${graniteFormatted}"`);

  // Arctic adapter label
  const arcticFormatted = formatCacheStats(
    { id: "openai", label: "Arctic cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.arctic-label", arcticFormatted.startsWith("Arctic cache"), `expected label "Arctic cache", got: "${arcticFormatted}"`);

  // Pangu adapter label
  const panguFormatted = formatCacheStats(
    { id: "openai", label: "Pangu cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.pangu-label", panguFormatted.startsWith("Pangu cache"), `expected label "Pangu cache", got: "${panguFormatted}"`);

  // SenseNova adapter label
  const sensenovaFormatted = formatCacheStats(
    { id: "openai", label: "SenseNova cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.sensenova-label", sensenovaFormatted.startsWith("SenseNova cache"), `expected label "SenseNova cache", got: "${sensenovaFormatted}"`);

  // Zhinao adapter label
  const zhinaoFormatted = formatCacheStats(
    { id: "openai", label: "Zhinao cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.zhinao-label", zhinaoFormatted.startsWith("Zhinao cache"), `expected label "Zhinao cache", got: "${zhinaoFormatted}"`);

  // MiniCPM adapter label
  const minicpmFormatted = formatCacheStats(
    { id: "openai", label: "MiniCPM cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.minicpm-label", minicpmFormatted.startsWith("MiniCPM cache"), `expected label "MiniCPM cache", got: "${minicpmFormatted}"`);

  // XVERSE adapter label
  const xverseFormatted = formatCacheStats(
    { id: "openai", label: "XVERSE cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.xverse-label", xverseFormatted.startsWith("XVERSE cache"), `expected label "XVERSE cache", got: "${xverseFormatted}"`);

  // Orion adapter label
  const orionFormatted = formatCacheStats(
    { id: "openai", label: "Orion cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.orion-label", orionFormatted.startsWith("Orion cache"), `expected label "Orion cache", got: "${orionFormatted}"`);

  // OpenChat adapter label
  const openchatFormatted = formatCacheStats(
    { id: "openai", label: "OpenChat cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.openchat-label", openchatFormatted.startsWith("OpenChat cache"), `expected label "OpenChat cache", got: "${openchatFormatted}"`);

  // Vicuna adapter label
  const vicunaFormatted = formatCacheStats(
    { id: "openai", label: "Vicuna cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.vicuna-label", vicunaFormatted.startsWith("Vicuna cache"), `expected label "Vicuna cache", got: "${vicunaFormatted}"`);

  // Wizard adapter label
  const wizardFormatted = formatCacheStats(
    { id: "openai", label: "Wizard cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.wizard-label", wizardFormatted.startsWith("Wizard cache"), `expected label "Wizard cache", got: "${wizardFormatted}"`);

  // Zephyr adapter label
  const zephyrFormatted = formatCacheStats(
    { id: "openai", label: "Zephyr cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.zephyr-label", zephyrFormatted.startsWith("Zephyr cache"), `expected label "Zephyr cache", got: "${zephyrFormatted}"`);

  // Dolphin adapter label
  const dolphinFormatted = formatCacheStats(
    { id: "openai", label: "Dolphin cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.dolphin-label", dolphinFormatted.startsWith("Dolphin cache"), `expected label "Dolphin cache", got: "${dolphinFormatted}"`);

  // OpenOrca adapter label
  const openorcaFormatted = formatCacheStats(
    { id: "openai", label: "OpenOrca cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.openorca-label", openorcaFormatted.startsWith("OpenOrca cache"), `expected label "OpenOrca cache", got: "${openorcaFormatted}"`);

  // Starling adapter label
  const starlingFormatted = formatCacheStats(
    { id: "openai", label: "Starling cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.starling-label", starlingFormatted.startsWith("Starling cache"), `expected label "Starling cache", got: "${starlingFormatted}"`);

  // BLOOM adapter label
  const bloomFormatted = formatCacheStats(
    { id: "openai", label: "BLOOM cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.bloom-label", bloomFormatted.startsWith("BLOOM cache"), `expected label "BLOOM cache", got: "${bloomFormatted}"`);

  // RWKV adapter label
  const rwkvFormatted = formatCacheStats(
    { id: "openai", label: "RWKV cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.rwkv-label", rwkvFormatted.startsWith("RWKV cache"), `expected label "RWKV cache", got: "${rwkvFormatted}"`);

  // Aya adapter label
  const ayaFormatted = formatCacheStats(
    { id: "openai", label: "Aya cache", showCacheWrite: false } as Parameters<typeof formatCacheStats>[0],
    emptyCacheStats("2026-05-24"),
  );
  expect("newAdapter.aya-label", ayaFormatted.startsWith("Aya cache"), `expected label "Aya cache", got: "${ayaFormatted}"`);

  // Model key separation: same id under different providers
  const graniteKey1 = modelKey(makeModel({ provider: "ibm", id: "granite-13b" }));
  const graniteKey2 = modelKey(makeModel({ provider: "custom", id: "granite-13b" }));
  expect("newAdapter.modelKey-distinct-granite", graniteKey1 !== graniteKey2, "expected different keys for different providers with same granite-13b id");

  const panguKey1 = modelKey(makeModel({ provider: "huawei", id: "pangu-33b" }));
  const panguKey2 = modelKey(makeModel({ provider: "custom", id: "pangu-33b" }));
  expect("newAdapter.modelKey-distinct-pangu", panguKey1 !== panguKey2, "expected different keys for different providers with same pangu-33b id");
}

// ==========================================================================
// Test 59: New model families (batch 4) — compat warnings through describeMissingOpenAICompatibleProxyCompat
// ==========================================================================
{
  // Granite proxy (non-official) — should fire compat warning
  const graniteProxy = makeModel({ id: "granite-13b", provider: "ibm", api: "openai-completions", baseUrl: "https://ibm.example.com/v1", compat: {} });
  const graniteMissing = describeMissingOpenAICompatibleProxyCompat(graniteProxy);
  expect("broadCompat.granite-both-missing", graniteMissing.length === 2, `expected both flags missing for Granite proxy, got: ${JSON.stringify(graniteMissing)}`);

  // Arctic proxy — should fire compat warning
  const arcticProxy = makeModel({ id: "snowflake-arctic-embed", provider: "snowflake", api: "openai-completions", baseUrl: "https://arctic.example.com/v1", compat: {} });
  const arcticMissing = describeMissingOpenAICompatibleProxyCompat(arcticProxy);
  expect("broadCompat.arctic-both-missing", arcticMissing.length === 2, `expected both flags missing for Arctic proxy, got: ${JSON.stringify(arcticMissing)}`);

  // Pangu with official OpenAI baseUrl — should NOT fire
  const panguOfficial = makeModel({ id: "pangu-33b", provider: "huawei", api: "openai-completions", baseUrl: "https://api.openai.com/v1", compat: {} });
  const panguOfficialMissing = describeMissingOpenAICompatibleProxyCompat(panguOfficial);
  expect("broadCompat.pangu-official-skip", panguOfficialMissing.length === 0, `expected no compat warnings for Pangu with official baseUrl, got: ${JSON.stringify(panguOfficialMissing)}`);

  // SenseNova with kiro-api — should NOT fire
  const sensenovaKiro = makeModel({ id: "sensenova-v5", provider: "sensetime", api: "kiro-api", baseUrl: "https://kiro.example.com/v1", compat: {} });
  const sensenovaKiroMissing = describeMissingOpenAICompatibleProxyCompat(sensenovaKiro);
  expect("broadCompat.sensenova-kiro-skip", sensenovaKiroMissing.length === 0, `expected no compat warnings for SenseNova with kiro-api, got: ${JSON.stringify(sensenovaKiroMissing)}`);

  // Zhinao with both compat flags — fully configured
  const zhinaoConfigured = makeModel({ id: "360gpt-pro", provider: "360", api: "openai-completions", baseUrl: "https://zhinao.example.com/v1", compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true } });
  const zhinaoMissing = describeMissingOpenAICompatibleProxyCompat(zhinaoConfigured);
  expect("broadCompat.zhinao-configured", zhinaoMissing.length === 0, `expected no compat warnings for fully-configured Zhinao proxy, got: ${JSON.stringify(zhinaoMissing)}`);

  // MiniCPM proxy — should fire compat warning
  const minicpmProxy = makeModel({ id: "minicpm-2b", provider: "openbmb", api: "openai-completions", baseUrl: "https://minicpm.example.com/v1", compat: {} });
  const minicpmMissing = describeMissingOpenAICompatibleProxyCompat(minicpmProxy);
  expect("broadCompat.minicpm-both-missing", minicpmMissing.length === 2, `expected both flags missing for MiniCPM proxy, got: ${JSON.stringify(minicpmMissing)}`);

  // Mimo proxy — should fire compat warning
  const mimoProxy = makeModel({ id: "mimo-vl-7b", provider: "xiaomi", api: "openai-completions", baseUrl: "https://mimo.example.com/v1", compat: {} });
  const mimoMissing = describeMissingOpenAICompatibleProxyCompat(mimoProxy);
  expect("broadCompat.mimo-both-missing", mimoMissing.length === 2, `expected both flags missing for Mimo proxy, got: ${JSON.stringify(mimoMissing)}`);

  // Mimo with kiro-api — should NOT fire
  const mimoKiro = makeModel({ id: "mimo-vl-7b", provider: "xiaomi", api: "kiro-api", baseUrl: "https://kiro.example.com/v1", compat: {} });
  const mimoKiroMissing = describeMissingOpenAICompatibleProxyCompat(mimoKiro);
  expect("broadCompat.mimo-kiro-skip", mimoKiroMissing.length === 0, `expected no compat warnings for Mimo with kiro-api, got: ${JSON.stringify(mimoKiroMissing)}`);

  // XVERSE with openai-responses — should NOT fire
  const xverseResponses = makeModel({ id: "xverse-13b", provider: "xverse", api: "openai-responses", baseUrl: "https://xverse.example.com/v1", compat: {} });
  const xverseResponsesMissing = describeMissingOpenAICompatibleProxyCompat(xverseResponses);
  expect("broadCompat.xverse-responses-skip", xverseResponsesMissing.length === 0, `expected no compat warnings for XVERSE with openai-responses, got: ${JSON.stringify(xverseResponsesMissing)}`);

  // Orion proxy — should fire compat warning
  const orionProxy = makeModel({ id: "Orion-14B", provider: "orionstar", api: "openai-completions", baseUrl: "https://orion.example.com/v1", compat: {} });
  const orionMissing = describeMissingOpenAICompatibleProxyCompat(orionProxy);
  expect("broadCompat.orion-both-missing", orionMissing.length === 2, `expected both flags missing for Orion proxy, got: ${JSON.stringify(orionMissing)}`);

  // OpenChat with kiro-api — should NOT fire
  const openchatKiro = makeModel({ id: "openchat-3.5", provider: "custom", api: "kiro-api", baseUrl: "https://kiro.example.com/v1", compat: {} });
  const openchatKiroMissing = describeMissingOpenAICompatibleProxyCompat(openchatKiro);
  expect("broadCompat.openchat-kiro-skip", openchatKiroMissing.length === 0, `expected no compat warnings for OpenChat with kiro-api, got: ${JSON.stringify(openchatKiroMissing)}`);

  // Vicuna proxy — should fire compat warning
  const vicunaProxy = makeModel({ id: "vicuna-13b-v1.5", provider: "lmsys", api: "openai-completions", baseUrl: "https://vicuna.example.com/v1", compat: {} });
  const vicunaMissing = describeMissingOpenAICompatibleProxyCompat(vicunaProxy);
  expect("broadCompat.vicuna-both-missing", vicunaMissing.length === 2, `expected both flags missing for Vicuna proxy, got: ${JSON.stringify(vicunaMissing)}`);

  // Wizard with both compat flags — fully configured
  const wizardConfigured = makeModel({ id: "wizardlm-30b", provider: "microsoft", api: "openai-completions", baseUrl: "https://wizard.example.com/v1", compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true } });
  const wizardMissing = describeMissingOpenAICompatibleProxyCompat(wizardConfigured);
  expect("broadCompat.wizard-configured", wizardMissing.length === 0, `expected no compat warnings for fully-configured Wizard proxy, got: ${JSON.stringify(wizardMissing)}`);

  // Zephyr proxy — should fire compat warning
  const zephyrProxy = makeModel({ id: "zephyr-7b-beta", provider: "huggingface", api: "openai-completions", baseUrl: "https://zephyr.example.com/v1", compat: {} });
  const zephyrMissing = describeMissingOpenAICompatibleProxyCompat(zephyrProxy);
  expect("broadCompat.zephyr-both-missing", zephyrMissing.length === 2, `expected both flags missing for Zephyr proxy, got: ${JSON.stringify(zephyrMissing)}`);

  // Dolphin with official OpenAI baseUrl — should NOT fire
  const dolphinOfficial = makeModel({ id: "dolphin-2.9-llama3", provider: "cognitive", api: "openai-completions", baseUrl: "https://api.openai.com/v1", compat: {} });
  const dolphinOfficialMissing = describeMissingOpenAICompatibleProxyCompat(dolphinOfficial);
  expect("broadCompat.dolphin-official-skip", dolphinOfficialMissing.length === 0, `expected no compat warnings for Dolphin with official baseUrl, got: ${JSON.stringify(dolphinOfficialMissing)}`);

  // OpenOrca proxy — should fire compat warning
  const openorcaProxy = makeModel({ id: "openorca-platypus2", provider: "openorca", api: "openai-completions", baseUrl: "https://openorca.example.com/v1", compat: {} });
  const openorcaMissing = describeMissingOpenAICompatibleProxyCompat(openorcaProxy);
  expect("broadCompat.openorca-both-missing", openorcaMissing.length === 2, `expected both flags missing for OpenOrca proxy, got: ${JSON.stringify(openorcaMissing)}`);

  // Starling with kiro-api — should NOT fire
  const starlingKiro = makeModel({ id: "starling-lm-7b", provider: "berkeley", api: "kiro-api", baseUrl: "https://kiro.example.com/v1", compat: {} });
  const starlingKiroMissing = describeMissingOpenAICompatibleProxyCompat(starlingKiro);
  expect("broadCompat.starling-kiro-skip", starlingKiroMissing.length === 0, `expected no compat warnings for Starling with kiro-api, got: ${JSON.stringify(starlingKiroMissing)}`);

  // BLOOM with both compat flags — fully configured
  const bloomConfigured = makeModel({ id: "bloom-176b", provider: "bigscience", api: "openai-completions", baseUrl: "https://bloom.example.com/v1", compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true } });
  const bloomMissing = describeMissingOpenAICompatibleProxyCompat(bloomConfigured);
  expect("broadCompat.bloom-configured", bloomMissing.length === 0, `expected no compat warnings for fully-configured BLOOM proxy, got: ${JSON.stringify(bloomMissing)}`);

  // RWKV proxy — should fire compat warning
  const rwkvProxy = makeModel({ id: "rwkv-x-169m", provider: "blink", api: "openai-completions", baseUrl: "https://rwkv.example.com/v1", compat: {} });
  const rwkvMissing = describeMissingOpenAICompatibleProxyCompat(rwkvProxy);
  expect("broadCompat.rwkv-both-missing", rwkvMissing.length === 2, `expected both flags missing for RWKV proxy, got: ${JSON.stringify(rwkvMissing)}`);

  // Aya with official OpenAI baseUrl — should NOT fire
  const ayaOfficial = makeModel({ id: "aya-expanse-32b", provider: "cohere", api: "openai-completions", baseUrl: "https://api.openai.com/v1", compat: {} });
  const ayaOfficialMissing = describeMissingOpenAICompatibleProxyCompat(ayaOfficial);
  expect("broadCompat.aya-official-skip", ayaOfficialMissing.length === 0, `expected no compat warnings for Aya with official baseUrl, got: ${JSON.stringify(ayaOfficialMissing)}`);

  // Aya with both compat flags — fully configured
  const ayaConfigured = makeModel({ id: "aya-expanse-32b", provider: "cohere", api: "openai-completions", baseUrl: "https://aya.example.com/v1", compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true } });
  const ayaMissing = describeMissingOpenAICompatibleProxyCompat(ayaConfigured);
  expect("broadCompat.aya-configured", ayaMissing.length === 0, `expected no compat warnings for fully-configured Aya proxy, got: ${JSON.stringify(ayaMissing)}`);
}

// ==========================================================================
// Test 60: New model families (batch 4) — relaxed gate verification
// ==========================================================================
{
  // Granite with openai-completions — gate should PASS
  expect("relaxedGate.granite-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for Granite");

  // Arctic with kiro-api — gate should BLOCK
  expect("relaxedGate.arctic-kiro-block", isOpenAICompatibleApi("kiro-api") === false, "expected kiro-api to block injection for Arctic");

  // Pangu with openai-completions — gate should PASS
  expect("relaxedGate.pangu-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for Pangu");

  // SenseNova with openai-responses — gate should PASS
  expect("relaxedGate.sensenova-responses-match", isOpenAICompatibleApi("openai-responses") === true, "expected isOpenAICompatibleApi to accept openai-responses for SenseNova");

  // Zhinao with undefined api — gate should BLOCK
  expect("relaxedGate.zhinao-undefined-block", isOpenAICompatibleApi(undefined) === false, "expected undefined api to block injection for Zhinao");

  // MiniCPM with openai-completions — gate should PASS
  expect("relaxedGate.minicpm-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for MiniCPM");

  // XVERSE with openai-completions — gate should PASS
  expect("relaxedGate.xverse-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for XVERSE");

  // Orion with kiro-api — gate should BLOCK
  expect("relaxedGate.orion-kiro-block", isOpenAICompatibleApi("kiro-api") === false, "expected kiro-api to block injection for Orion");

  // OpenChat with openai-completions — gate should PASS
  expect("relaxedGate.openchat-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for OpenChat");

  // Vicuna with openai-responses — gate should PASS
  expect("relaxedGate.vicuna-responses-match", isOpenAICompatibleApi("openai-responses") === true, "expected isOpenAICompatibleApi to accept openai-responses for Vicuna");

  // Wizard with openai-completions — gate should PASS
  expect("relaxedGate.wizard-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for Wizard");

  // Zephyr with kiro-api — gate should BLOCK
  expect("relaxedGate.zephyr-kiro-block", isOpenAICompatibleApi("kiro-api") === false, "expected kiro-api to block injection for Zephyr");

  // Dolphin with openai-completions — gate should PASS
  expect("relaxedGate.dolphin-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for Dolphin");

  // OpenOrca with undefined api — gate should BLOCK
  expect("relaxedGate.openorca-undefined-block", isOpenAICompatibleApi(undefined) === false, "expected undefined api to block injection for OpenOrca");

  // Starling with openai-completions — gate should PASS
  expect("relaxedGate.starling-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for Starling");

  // BLOOM with openai-responses — gate should PASS
  expect("relaxedGate.bloom-responses-match", isOpenAICompatibleApi("openai-responses") === true, "expected isOpenAICompatibleApi to accept openai-responses for BLOOM");

  // RWKV with openai-completions — gate should PASS
  expect("relaxedGate.rwkv-api-match", isOpenAICompatibleApi("openai-completions") === true, "expected isOpenAICompatibleApi to accept openai-completions for RWKV");

  // Aya with kiro-api — gate should BLOCK
  expect("relaxedGate.aya-kiro-block", isOpenAICompatibleApi("kiro-api") === false, "expected kiro-api to block injection for Aya");
}

// ==========================================================================
// Test 61: describeRouterChannelDiagnostics — OpenRouter detection
// ==========================================================================
{
  // OpenRouter by baseUrl
  const openRouterModel = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
  });
  const orNotes = describeRouterChannelDiagnostics(openRouterModel);
  expect(
    "router.openrouter.baseUrl-nonempty",
    orNotes.length > 0,
    "expected OpenRouter notes for baseUrl containing openrouter.ai",
  );
  expect(
    "router.openrouter.baseUrl-label",
    orNotes.some((n) => n.includes("OpenRouter")),
    "expected OpenRouter notes to mention OpenRouter",
  );
  expect(
    "router.openrouter.baseUrl-fix-route",
    orNotes.some((n) => n.includes("openRouterRouting")),
    "expected OpenRouter notes to mention openRouterRouting",
  );
  expect(
    "router.openrouter.baseUrl-no-apikey",
    orNotes.every((n) => !n.includes("apiKey") && !n.includes("secret") && !n.includes("sk-") && !n.includes("x-api-key")),
    "expected OpenRouter notes to NOT contain API keys or secrets",
  );

  // OpenRouter by provider
  const openRouterModel2 = makeModel({
    id: "gpt-5.5",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
  });
  const orNotes2 = describeRouterChannelDiagnostics(openRouterModel2);
  expect(
    "router.openrouter.provider-nonempty",
    orNotes2.length > 0,
    "expected OpenRouter notes for provider containing openrouter",
  );
  expect(
    "router.openrouter.provider-label",
    orNotes2.some((n) => n.includes("OpenRouter")),
    "expected OpenRouter notes (by provider) to mention OpenRouter",
  );

  // OpenRouter with openRouterRouting.only already configured — should still show
  // OpenRouter profile but without the fix suggestion
  const openRouterConfigured = makeModel({
    id: "gpt-5.5",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    compat: {
      openRouterRouting: { only: ["openai"] },
      sendSessionAffinityHeaders: true,
      supportsLongCacheRetention: true,
    },
  });
  const orNotes3 = describeRouterChannelDiagnostics(openRouterConfigured);
  expect(
    "router.openrouter.configured-nonempty",
    orNotes3.length > 0,
    "expected OpenRouter notes even when configured (still a router)",
  );
  expect(
    "router.openrouter.configured-no-suggestion",
    orNotes3.every((n) => !n.includes("Suggestion")),
    "expected OpenRouter notes to skip 'Suggestion' when already configured",
  );
}

// ==========================================================================
// Test 62: describeRouterChannelDiagnostics — Vercel AI Gateway
// ==========================================================================
{
  // Vercel by baseUrl
  const vercelModel = makeModel({
    id: "gpt-4",
    provider: "my-provider",
    api: "openai-completions",
    baseUrl: "https://my-gateway.ai-gateway.vercel.sh/v1",
  });
  const vNotes = describeRouterChannelDiagnostics(vercelModel);
  expect(
    "router.vercel.baseUrl-nonempty",
    vNotes.length > 0,
    "expected Vercel notes for baseUrl containing ai-gateway.vercel.sh",
  );
  expect(
    "router.vercel.baseUrl-label",
    vNotes.some((n) => n.includes("Vercel AI Gateway")),
    "expected Vercel notes to mention Vercel AI Gateway",
  );
  expect(
    "router.vercel.baseUrl-vercelGatewayRouting",
    vNotes.some((n) => n.includes("vercelGatewayRouting")),
    "expected Vercel notes to mention vercelGatewayRouting",
  );

  // Vercel by provider
  const vercelModel2 = makeModel({
    id: "gpt-4",
    provider: "vercel-ai-gateway",
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
  });
  const vNotes2 = describeRouterChannelDiagnostics(vercelModel2);
  expect(
    "router.vercel.provider-nonempty",
    vNotes2.length > 0,
    "expected Vercel notes for provider containing vercel",
  );

  // Vercel with vercelGatewayRouting already configured
  const vercelConfigured = makeModel({
    id: "gpt-4",
    provider: "vercel",
    api: "openai-completions",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    compat: { vercelGatewayRouting: { only: ["openai"] }, sendSessionAffinityHeaders: true },
  });
  const vNotes3 = describeRouterChannelDiagnostics(vercelConfigured);
  expect(
    "router.vercel.configured-nonempty",
    vNotes3.length > 0,
    "expected Vercel notes even when configured",
  );
  expect(
    "router.vercel.configured-no-suggestion",
    vNotes3.every((n) => !n.includes("Suggestion")),
    "expected Vercel notes to skip 'Suggestion' when already configured",
  );
}

// ==========================================================================
// Test 63: describeRouterChannelDiagnostics — LiteLLM / OneAPI / NewAPI / VoAPI
// ==========================================================================
{
  // LiteLLM
  const litellmModel = makeModel({
    id: "gpt-4",
    provider: "my-proxy",
    api: "openai-completions",
    baseUrl: "https://litellm.example.com/v1",
  });
  const lNotes = describeRouterChannelDiagnostics(litellmModel);
  expect(
    "router.litellm-nonempty",
    lNotes.length > 0,
    "expected router notes for LiteLLM",
  );
  expect(
    "router.litellm-label",
    lNotes.some((n) => n.includes("LiteLLM")),
    "expected LiteLLM notes to mention LiteLLM",
  );
  expect(
    "router.litellm-sticky",
    lNotes.some((n) => n.includes("upstream per session") || n.includes("session_id_affinity")),
    "expected LiteLLM notes to mention session affinity",
  );

  // OneAPI
  const oneapiModel = makeModel({
    id: "claude-sonnet",
    provider: "my-agg",
    api: "openai-completions",
    baseUrl: "https://oneapi.example.com/v1",
  });
  const oNotes = describeRouterChannelDiagnostics(oneapiModel);
  expect(
    "router.oneapi-nonempty",
    oNotes.length > 0,
    "expected router notes for OneAPI",
  );
  expect(
    "router.oneapi-label",
    oNotes.some((n) => n.includes("OneAPI")),
    "expected OneAPI notes to mention OneAPI",
  );

  // NewAPI
  const newapiModel = makeModel({
    id: "gpt-4",
    provider: "my-agg",
    api: "openai-completions",
    baseUrl: "https://newapi.example.com/v1",
  });
  const nwNotes = describeRouterChannelDiagnostics(newapiModel);
  expect(
    "router.newapi-nonempty",
    nwNotes.length > 0,
    "expected router notes for NewAPI",
  );

  // VoAPI
  const voapiModel = makeModel({
    id: "gpt-4",
    provider: "my-agg",
    api: "openai-completions",
    baseUrl: "https://voapi.example.com/v1",
  });
  const voNotes = describeRouterChannelDiagnostics(voapiModel);
  expect(
    "router.voapi-nonempty",
    voNotes.length > 0,
    "expected router notes for VoAPI",
  );

  // Proxy by provider (litellm in provider field)
  const providerLitellm = makeModel({
    id: "gpt-4",
    provider: "litellm-proxy",
    api: "openai-completions",
    baseUrl: "https://my-proxy.example.com/v1",
  });
  const pNotes = describeRouterChannelDiagnostics(providerLitellm);
  expect(
    "router.provider-litellm-nonempty",
    pNotes.length > 0,
    "expected router notes for provider containing litellm",
  );
  expect(
    "router.provider-litellm-label",
    pNotes.some((n) => n.includes("LiteLLM")),
    "expected LiteLLM notes (by provider)",
  );
}

// ==========================================================================
// Test 64: describeRouterChannelDiagnostics — generic third-party proxy
// ==========================================================================
{
  // Generic third-party openai-completions proxy with non-official baseUrl
  const genericProxy = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: {},
  });
  const gNotes = describeRouterChannelDiagnostics(genericProxy);
  expect(
    "router.generic-nonempty",
    gNotes.length > 0,
    "expected generic proxy notes",
  );
  expect(
    "router.generic-label",
    gNotes.some((n) => n.includes("OpenAI-compatible proxy")),
    "expected generic proxy notes to mention OpenAI-compatible proxy",
  );
  expect(
    "router.generic-cache-advice",
    gNotes.some((n) => n.includes("prompt_cache_key") || n.includes("prompt_cache_key")),
    "expected generic proxy notes to mention prompt_cache_key",
  );

  // Fully configured generic proxy — notes should still fire (only compat advice differs)
  const genericConfigured = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
  });
  const gcNotes = describeRouterChannelDiagnostics(genericConfigured);
  expect(
    "router.generic-configured-nonempty",
    gcNotes.length > 0,
    "expected generic proxy notes even when compat is fully configured",
  );
  // When compat is fully configured, the note about compat flags is not shown
  expect(
    "router.generic-configured-no-compat-note",
    gcNotes.every((n) => !n.includes("compat flags above")),
    "expected no 'compat flags above' note when fully configured",
  );

  // Generic proxy with missing flags should include compat flag note
  const compatDone = describeRouterChannelDiagnostics(genericProxy);
  expect(
    "router.generic-missing-has-compat-note",
    compatDone.some((n) => n.includes("compat flags above") || n.includes("supportsLongCacheRetention")),
    "expected missing-compat generic proxy to mention compat flags",
  );

  // Security: no secrets in notes
  expect(
    "router.generic-secure",
    gNotes.every((n) => !n.includes("sk-") && !n.includes("apiKey") && !n.includes("secret") && !n.includes("x-api-key")),
    "expected generic proxy notes to NOT contain API keys or secrets",
  );
}

// ==========================================================================
// Test 65: describeRouterChannelDiagnostics — official OpenAI and custom transports
// ==========================================================================
{
  // Official OpenAI — no notes
  const officialModel = makeModel({
    id: "gpt-4o",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  });
  const oNotes = describeRouterChannelDiagnostics(officialModel);
  expect(
    "router.official-empty",
    oNotes.length === 0,
    "expected no router notes for official OpenAI",
  );

  // kiro-api — no notes (custom transport)
  const kiroModel = makeModel({
    id: "claude-sonnet-4",
    provider: "kiro",
    api: "kiro-api",
    baseUrl: "https://kiro.example.com/generate",
  });
  const kNotes = describeRouterChannelDiagnostics(kiroModel);
  expect(
    "router.kiro-empty",
    kNotes.length === 0,
    "expected no router notes for kiro-api (custom transport)",
  );

  // No baseUrl (empty/default) with openai-completions → no generic proxy notes
  // because describeRouterChannelDiagnostics requires a baseUrl for generic proxy
  const noBaseUrl = makeModel({
    id: "gpt-5.5",
    provider: "otokapi",
    api: "openai-completions",
    baseUrl: "",
  });
  const nbNotes = describeRouterChannelDiagnostics(noBaseUrl);
  expect(
    "router.no-baseurl-empty",
    nbNotes.length === 0,
    "expected no router notes when baseUrl is empty",
  );

  // anthropic-messages — no notes
  const anthropicMsg = makeModel({
    id: "claude-opus-4",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
  });
  expect(
    "router.anthropic-messages-empty",
    describeRouterChannelDiagnostics(anthropicMsg).length === 0,
    "expected no router notes for anthropic-messages",
  );
}

// ==========================================================================
// Test 66: Router diagnostics do not affect adapter selection
// ==========================================================================
{
  // An OpenRouter Llama model must select Llama adapter, not an OpenRouter adapter
  const llamaViaOpenRouter = makeModel({
    id: "llama-3-70b",
    name: "Meta Llama 3 70B",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
  });

  // The adapter selected via isLlamaLikeModel should still match
  expect(
    "router.adapter.lama-via-openrouter",
    isLlamaLikeModel(llamaViaOpenRouter) === true,
    "expected OpenRouter Llama model to still match Llama adapter",
  );

  // Vercel GPT-4 should still match OpenAI adapter
  const gptViaVercel = makeModel({
    id: "gpt-4o",
    provider: "vercel",
    api: "openai-completions",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
  });
  expect(
    "router.adapter.gpt-via-vercel",
    isOpenAIFamilyModel(gptViaVercel) === true,
    "expected Vercel GPT-4o to still match OpenAI adapter",
  );
}

// ==========================================================================
// Test 67: describeRouterChannelDiagnostics — security: no secrets exposed
// ==========================================================================
{
  const models = [
    makeModel({ id: "gpt-5.5", provider: "otokapi", api: "openai-completions", baseUrl: "https://openrouter.ai/v1" }),
    makeModel({ id: "gpt-5.5", provider: "otokapi", api: "openai-completions", baseUrl: "https://ai-gateway.vercel.sh/v1" }),
    makeModel({ id: "gpt-5.5", provider: "otokapi", api: "openai-completions", baseUrl: "https://litellm.example.com/v1" }),
    makeModel({ id: "gpt-5.5", provider: "otokapi", api: "openai-completions", baseUrl: "https://oneapi.example.com/v1" }),
    makeModel({ id: "gpt-5.5", provider: "otokapi", api: "openai-completions", baseUrl: "https://newapi.example.com/v1" }),
    makeModel({ id: "gpt-5.5", provider: "otokapi", api: "openai-completions", baseUrl: "https://voapi.example.com/v1" }),
    makeModel({ id: "gpt-5.5", provider: "otokapi", api: "openai-completions", baseUrl: "https://otokapi.example.com/v1" }),
  ];

  for (const m of models) {
    const notes = describeRouterChannelDiagnostics(m);
    for (const note of notes) {
      const key = `router.security.${m.baseUrl}`;
      expect(
        key,
        !note.includes("sk-") && !note.includes("apiKey") && !note.includes("secret") && !note.includes("x-api-key") && !note.includes("Authorization"),
        `expected router note to NOT contain secrets: ${note.slice(0, 80)}`,
      );
    }
  }
}

// ==========================================================================
// New Tests: Goal 1 — buildStatsOutput
// ==========================================================================

{
  // Active bucket with stats
  const model = makeModel({ id: "gpt-5.5", provider: "otokapi" });
  const adapter = { id: "openai", label: "OpenAI cache", matchesModel: () => true } as any;
  const stats = { day: "2026-05-24", totalRequests: 10, hitRequests: 3, cachedInputTokens: 1500, cacheWriteInputTokens: 200, totalInputTokens: 5000 };
  const samples: any[] = [];
  const output = buildStatsOutput(model, adapter, stats, samples);
  expect("stats.active-bucket-key", output.includes("otokapi/gpt-5.5"), "expected model key in stats output");
  expect("stats.active-bucket-requests", output.includes("3 hit / 10 total"), "expected hit/total in stats output");
  expect("stats.active-bucket-tokens", output.includes("30%"), "expected cached ratio in stats output");
  expect("stats.active-bucket-trend", output.includes("Recent"), "expected trend section in stats output");
}

{
  // Unseen bucket (no stats) — show 0/0
  const model = makeModel({ id: "gpt-5.5", provider: "otokapi" });
  const adapter = { id: "openai", label: "OpenAI cache", matchesModel: () => true } as any;
  const output = buildStatsOutput(model, adapter, undefined, []);
  expect("stats.unseen-bucket", output.includes("0 hit / 0 total"), "expected 0/0 for unseen bucket");
}

{
  // Unsupported model — no adapter
  const model = makeModel({ id: "some-unknown-model", provider: "unknown" });
  const output = buildStatsOutput(model, undefined, undefined, []);
  expect("stats.unsupported-model", output.includes("No cache-adapter-matched model"), "expected friendly msg for unsupported model");
}

{
  // No active model
  const output = buildStatsOutput(undefined, undefined, undefined, []);
  expect("stats.no-model", output.includes("No cache-adapter-matched model"), "expected friendly msg when no model");
}

// ==========================================================================
// New Tests: Goal 1 — formatHitRatio and formatTokenM
// ==========================================================================

{
  expect("hitRatio.zero-total", formatHitRatio(0, 0) === "N/A", "expected N/A for zero total");
  expect("hitRatio.no-hits", formatHitRatio(0, 10) === "0%", "expected 0% for no hits");
  expect("hitRatio.partial", formatHitRatio(3, 10) === "30%", "expected 30% for 3/10");
  expect("hitRatio.all", formatHitRatio(10, 10) === "100%", "expected 100% for 10/10");
  expect("formatTokenM.zero", formatTokenM(0) === "0", "expected 0 for zero");
  expect("formatTokenM.million", formatTokenM(1500000) === "1.50", "expected 1.50 for 1.5M");
  expect("formatTokenM.big", formatTokenM(34000000) === "34.0", "expected 34.0 for 34M");
}

// ==========================================================================
// New Tests: Goal 1 — formatRecentTrendSummary
// ==========================================================================

{
  const now = Date.now();
  // Empty samples
  expect("trend.empty", formatRecentTrendSummary([], 10) === "Recent 10: no samples yet", "expected no samples for empty");

  // Mixed samples
  const samples: any[] = [
    { timestamp: now, hit: true, cachedInputTokens: 100, cacheWriteInputTokens: 0, totalInputTokens: 200, missingUsageFields: false },
    { timestamp: now + 1, hit: false, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 200, missingUsageFields: false },
    { timestamp: now + 2, hit: true, cachedInputTokens: 50, cacheWriteInputTokens: 10, totalInputTokens: 150, missingUsageFields: false },
  ];
  const summary = formatRecentTrendSummary(samples, 10);
  expect("trend.mixed-hits", summary.includes("2/3 hits"), "expected 2/3 hits in summary");
  expect("trend.mixed-tokens", summary.includes("tok cached"), "expected token cached ratio in summary");
  expect("trend.mixed-no-missing", !summary.includes("missing usage"), "expected no missing usage indicator");

  // With missing usage fields
  const samplesWithMissing = [
    { timestamp: now, hit: false, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 0, missingUsageFields: true },
    { timestamp: now + 1, hit: false, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 0, missingUsageFields: true },
  ];
  const summary2 = formatRecentTrendSummary(samplesWithMissing, 10);
  expect("trend.missing-usage", summary2.includes("2 missing usage"), "expected missing usage count");
}

// ==========================================================================
// New Tests: Goal 3 — hasMissingUsageFields
// ==========================================================================

{
  // Missing usage fields — Pi-normalized fields absent
  const msgWithMissing = { role: "assistant", usage: { cost: {} } };
  const adapter = {
    id: "openai", label: "OpenAI cache",
    matchesModel: () => true,
    matchesAssistantMessage: () => true,
    normalizeUsage: () => undefined,
    warningText: () => undefined,
  } as any;
  expect("missing.missing-fields", hasMissingUsageFields(msgWithMissing, adapter) === true, "expected true for missing usage");

  // Valid usage fields
  const msgWithUsage = { role: "assistant", usage: { input: 100, cacheRead: 50, cacheWrite: 10 } };
  expect("missing.valid-fields", hasMissingUsageFields(msgWithUsage, adapter) === false, "expected false for valid usage");
}

// ==========================================================================
// New Tests: Goal 2 — buildLowHitDiagnosis
// ==========================================================================

{
  const model = makeModel({ id: "gpt-5.5", provider: "otokapi", api: "openai-completions", baseUrl: "https://otokapi.example.com/v1" });
  const adapter = { id: "openai", label: "OpenAI cache", matchesModel: () => true } as any;
  const stats = { day: "2026-05-24", totalRequests: 5, hitRequests: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 2000 };
  const now = Date.now();
  const samples: any[] = [
    { timestamp: now, hit: false, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 200, missingUsageFields: false },
    { timestamp: now + 1, hit: false, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 200, missingUsageFields: false },
    { timestamp: now + 2, hit: false, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 200, missingUsageFields: false },
    { timestamp: now + 3, hit: false, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 200, missingUsageFields: true },
  ];
  const diagnosis = buildLowHitDiagnosis(model, adapter, stats, samples);

  // Should contain diagnosis header
  expect("doctor.diagnosis-header", diagnosis.some(l => l.includes("Cache diagnosis")), "expected Cache diagnosis header");

  // Should flag missing compat (since baseUrl is non-official and no compat set)
  expect("doctor.diagnosis-missing-compat", diagnosis.some(l => l.includes("Missing compat")), "expected missing compat flag");

  // Should flag missing usage fields
  expect("doctor.diagnosis-usage-missing", diagnosis.some(l => l.includes("missing/empty usage fields")), "expected usage fields missing warning");

  // Should flag low hit rate
  expect("doctor.diagnosis-low-hit", diagnosis.some(l => l.includes("low")), "expected low hit rate diagnosis");
}

{
  // Fully configured model — no compat flags missing, no issues
  const model = makeModel({
    id: "gpt-5.5", provider: "otokapi", api: "openai-completions",
    baseUrl: "https://otokapi.example.com/v1",
    compat: { sendSessionAffinityHeaders: true, supportsLongCacheRetention: true },
  });
  const adapter = { id: "openai", label: "OpenAI cache", matchesModel: () => true } as any;
  const stats = { day: "2026-05-24", totalRequests: 0, hitRequests: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 0 };
  const diagnosis = buildLowHitDiagnosis(model, adapter, stats, []);
  expect("doctor.diagnosis-no-issues", diagnosis.length === 0, "expected empty diagnosis for fully configured model with no samples");
}

{
  // Unsupported model (no adapter) — diagnosis should still report compat issues
  const model = makeModel({ id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" });
  const diagnosis = buildLowHitDiagnosis(model, undefined, undefined, []);
  expect("doctor.diagnosis-anthropic-no-issues", diagnosis.length === 0, "expected empty diagnosis for non-openai-completions");
}

// ==========================================================================
// New Tests: MAX_RECENT_SAMPLES constant value
// ==========================================================================

{
  expect("MAX_RECENT_SAMPLES", MAX_RECENT_SAMPLES === 50, "expected MAX_RECENT_SAMPLES to be 50");
}

// ==========================================================================
// New Tests: keyForModelExt
// ==========================================================================

{
  const result = keyForModelExt({ provider: "otokapi", id: "gpt-5.5" });
  expect("keyForModelExt", result === "otokapi/gpt-5.5", "expected provider/id key");
}

// ==========================================================================
// Session-scoped tests (v4: Pi session + provider/model stats)
// ==========================================================================

// Test 27: hashSessionId produces deterministic 16-char hex strings
{
  const hash1 = hashSessionId("sess-test-session-123");
  const hash2 = hashSessionId("sess-test-session-123");
  expect(
    "hash.deterministic",
    hash1 === hash2,
    `expected deterministic hash, got "${hash1}" vs "${hash2}"`,
  );
  expect(
    "hash.length",
    hash1.length === 16,
    `expected 16-char hash, got ${hash1.length}: "${hash1}"`,
  );
  expect(
    "hash.hex",
    /^[0-9a-f]{16}$/.test(hash1),
    `expected 16-char hex, got "${hash1}"`,
  );

  // Different session ids produce different hashes
  const hash3 = hashSessionId("sess-different-456");
  expect(
    "hash.different",
    hash1 !== hash3,
    `expected different hashes for different session ids`,
  );
}

// Test 28: makeSessionModelKey builds correct session-scoped keys
{
  const hash = "a1b2c3d4e5f6g7h8";
  const key1 = makeSessionModelKey(hash, "otokapi", "gpt-5.5");
  expect(
    "sessionKey.otokapi-gpt55",
    key1 === "a1b2c3d4e5f6g7h8:otokapi/gpt-5.5",
    `expected "a1b2c3d4e5f6g7h8:otokapi/gpt-5.5", got "${key1}"`,
  );

  const key2 = makeSessionModelKey(hash, "openai", "gpt-4");
  expect(
    "sessionKey.openai-gpt4",
    key2 === "a1b2c3d4e5f6g7h8:openai/gpt-4",
    `expected "a1b2c3d4e5f6g7h8:openai/gpt-4", got "${key2}"`,
  );
}

// Test 29: modelKeyFromSessionKey extracts the user-facing model key
{
  const display = modelKeyFromSessionKey("a1b2c3d4e5f6g7h8:otokapi/gpt-5.5");
  expect(
    "modelKeyFromSession.otokapi",
    display === "otokapi/gpt-5.5",
    `expected "otokapi/gpt-5.5", got "${display}"`,
  );

  // Plain key without hash prefix should be preserved
  const plain = modelKeyFromSessionKey("otokapi/gpt-5.5");
  expect(
    "modelKeyFromSession.plain",
    plain === "otokapi/gpt-5.5",
    `expected "otokapi/gpt-5.5", got "${plain}"`,
  );
}

// Test 30: Same provider/model under different session hashes produce different keys
{
  const hashA = hashSessionId("session-A");
  const hashB = hashSessionId("session-B");

  const keyA = makeSessionModelKey(hashA, "otokapi", "gpt-5.5");
  const keyB = makeSessionModelKey(hashB, "otokapi", "gpt-5.5");

  expect(
    "sessionKey.isolated-same-model",
    keyA !== keyB,
    `expected different keys for same model in different sessions`,
  );

  // Same session + same model → same key
  const keyA2 = makeSessionModelKey(hashA, "otokapi", "gpt-5.5");
  expect(
    "sessionKey.same-session-same-model",
    keyA === keyA2,
    `expected same key for same session + model`,
  );

  // Same session + different models → different keys
  const keyA3 = makeSessionModelKey(hashA, "openai", "gpt-4");
  expect(
    "sessionKey.same-session-different-model",
    keyA !== keyA3,
    `expected different keys for different models in same session`,
  );
}

// Test 31: makeSessionModelKey round-trips through modelKeyFromSessionKey
{
  const hash = hashSessionId("roundtrip-test-session");
  const originalModelKey = "otokapi/gpt-5.5";
  const sessionKey = makeSessionModelKey(hash, "otokapi", "gpt-5.5");
  const display = modelKeyFromSessionKey(sessionKey);
  expect(
    "sessionKey.roundtrip",
    display === originalModelKey,
    `expected "${originalModelKey}", got "${display}" after round-trip`,
  );
}

// ==========================================================================
// Goal 1–5: Session-scoped persist/restore/reset harness tests
//
// These tests verify the core session-scoping logic WITHOUT file I/O.
// They simulate the extension's restoreCacheStats (first load / reload)
// and reset flows by constructing in-memory v4 CacheStatsState,
// filtering by session hash (as restoreCacheStats does), and verifying
// isolation properties.
// ==========================================================================

function buildEmptySessionModelStats(): Record<string, CacheStats> {
  return {};
}

function buildEmptyLegacyFamily(): Partial<Record<CacheProviderId, CacheStats>> {
  return emptyAllCacheStats();
}

function addModelToStats(
  stats: Record<string, CacheStats>,
  sessionHash: string,
  provider: string,
  id: string,
  day: string,
  totalRequests: number,
  hitRequests: number,
): void {
  const sk = `${sessionHash}:${provider}/${id}`;
  stats[sk] = {
    day,
    totalRequests,
    hitRequests,
    cachedInputTokens: hitRequests * 1000,
    cacheWriteInputTokens: 0,
    totalInputTokens: totalRequests * 1000,
  };
}

function filterStatsForSession(
  state: CacheStatsState,
  targetHash: string,
): Record<string, CacheStats> {
  const prefix = `${targetHash}:`;
  const filtered: Record<string, CacheStats> = {};
  for (const [fullKey, stats] of Object.entries(state.statsByModel)) {
    if (fullKey.startsWith(prefix)) {
      filtered[fullKey] = stats;
    } else if (!fullKey.includes(":")) {
      // Legacy v3 key without hash — migrate to target session
      filtered[`${targetHash}:${fullKey}`] = stats;
    }
  }
  return filtered;
}

function removeModelFromState(
  state: CacheStatsState,
  targetHash: string,
  provider: string,
  id: string,
): void {
  const prefix = `${targetHash}:${provider}/${id}`;
  for (const key of Object.keys(state.statsByModel)) {
    if (key === prefix) {
      delete state.statsByModel[key];
      return;
    }
  }
}

function sessionModelKeysForHash(state: CacheStatsState, targetHash: string): string[] {
  const prefix = `${targetHash}:`;
  return Object.keys(state.statsByModel).filter((k) => k.startsWith(prefix));
}

// Test: Reload restores persisted session stats (does not return 0/0)
{
  const hashA = hashSessionId("session-A");
  const hashB = hashSessionId("session-B");

  // Pretend extension instance A recorded stats for session A
  const persistedStateA: CacheStatsState = {
    statsByModel: {},
    legacyFamily: buildEmptyLegacyFamily(),
  };
  addModelToStats(persistedStateA.statsByModel, hashA, "otokapi", "gpt-5.5", "2026-05-24", 10, 3);
  addModelToStats(persistedStateA.statsByModel, hashB, "cafecode", "gpt-5.5", "2026-05-24", 5, 1);

  // Simulate reload: new extension instance (empty stats), restore from persisted
  const freshState: CacheStatsState = {
    statsByModel: {},
    legacyFamily: buildEmptyLegacyFamily(),
  };

  // Simulate restoreCacheStats(reason="reload"): filter for session A
  freshState.statsByModel = filterStatsForSession(persistedStateA, hashA);
  freshState.legacyFamily = persistedStateA.legacyFamily;

  // Verify session A stats are restored (not 0/0)
  const sessionAKeys = Object.keys(freshState.statsByModel);
  expect(
    "reload.restores-sessionA-keys",
    sessionAKeys.length === 1 && sessionAKeys[0].includes(hashA),
    `expected 1 session A key after reload, got ${sessionAKeys.length}: ${JSON.stringify(sessionAKeys)}`,
  );

  const restoredModelKey = modelKeyFromSessionKey(sessionAKeys[0]);
  expect(
    "reload.restores-otokapi-gpt55",
    restoredModelKey === "otokapi/gpt-5.5",
    `expected restored model key "otokapi/gpt-5.5", got "${restoredModelKey}"`,
  );

  const restoredStats = freshState.statsByModel[sessionAKeys[0]];
  expect(
    "reload.restores-hits",
    restoredStats?.hitRequests === 3,
    `expected 3 hit requests after reload, got ${restoredStats?.hitRequests}`,
  );
  expect(
    "reload.restores-total",
    restoredStats?.totalRequests === 10,
    `expected 10 total requests after reload, got ${restoredStats?.totalRequests}`,
  );

  // Session B data should NOT be in session A's restore
  const sessionBKeys = Object.keys(freshState.statsByModel).filter((k) => k.includes(hashB));
  expect(
    "reload.sessionB-isolated",
    sessionBKeys.length === 0,
    `expected 0 session B keys in session A's restore, got ${sessionBKeys.length}`,
  );
}

// Test: Reset removes bucket from persist and survives reload
{
  const hashA = hashSessionId("reset-test-session");

  // Build state with one model
  const state: CacheStatsState = {
    statsByModel: {},
    legacyFamily: buildEmptyLegacyFamily(),
  };
  addModelToStats(state.statsByModel, hashA, "otokapi", "gpt-5.5", "2026-05-24", 10, 3);

  // Simulate reset: delete the model's stats entry
  const sessionKeysBefore = sessionModelKeysForHash(state, hashA);
  expect(
    "reset.has-key-before",
    sessionKeysBefore.length === 1,
    `expected 1 session key before reset, got ${sessionKeysBefore.length}`,
  );

  removeModelFromState(state, hashA, "otokapi", "gpt-5.5");

  const sessionKeysAfter = sessionModelKeysForHash(state, hashA);
  expect(
    "reset.no-key-after",
    sessionKeysAfter.length === 0,
    `expected 0 session keys after reset, got ${sessionKeysAfter.length}`,
  );

  // Simulate reload after reset: filter from persisted (which now has no entry)
  const freshAfterReset = filterStatsForSession(state, hashA);
  expect(
    "reset.survives-reload",
    Object.keys(freshAfterReset).length === 0,
    `expected 0 keys after reload following reset, got ${Object.keys(freshAfterReset).length}`,
  );
}

// Test: Reset leaves other models in same session intact
{
  const hashA = hashSessionId("multi-model-session");

  const state: CacheStatsState = {
    statsByModel: {},
    legacyFamily: buildEmptyLegacyFamily(),
  };
  addModelToStats(state.statsByModel, hashA, "otokapi", "gpt-5.5", "2026-05-24", 10, 3);
  addModelToStats(state.statsByModel, hashA, "otokapi", "gpt-4", "2026-05-24", 5, 2);

  // Reset only gpt-5.5
  removeModelFromState(state, hashA, "otokapi", "gpt-5.5");

  const remaining = sessionModelKeysForHash(state, hashA);
  expect(
    "reset.other-model-preserved",
    remaining.length === 1 && remaining[0].includes("otokapi/gpt-4"),
    `expected gpt-4 preserved after reset, got ${JSON.stringify(remaining)}`,
  );

  // Verify gpt-4 stats intact
  const gpt4Stats = state.statsByModel[remaining[0]];
  expect(
    "reset.other-model-stats",
    gpt4Stats?.hitRequests === 2 && gpt4Stats?.totalRequests === 5,
    `expected gpt-4 stats unchanged after reset, got hits=${gpt4Stats?.hitRequests}, total=${gpt4Stats?.totalRequests}`,
  );
}

// Test: Reset leaves same model in different session intact
{
  const hashA = hashSessionId("session-A-isolated");
  const hashB = hashSessionId("session-B-isolated");

  const state: CacheStatsState = {
    statsByModel: {},
    legacyFamily: buildEmptyLegacyFamily(),
  };
  addModelToStats(state.statsByModel, hashA, "otokapi", "gpt-5.5", "2026-05-24", 10, 3);
  addModelToStats(state.statsByModel, hashB, "cafecode", "gpt-5.5", "2026-05-24", 20, 8);

  // Reset session A's gpt-5.5 only
  removeModelFromState(state, hashA, "otokapi", "gpt-5.5");

  // Session A: no keys
  expect(
    "reset.other-session.A-empty",
    sessionModelKeysForHash(state, hashA).length === 0,
    `expected session A empty after reset`,
  );

  // Session B: still has its gpt-5.5
  const sessionBKeys = sessionModelKeysForHash(state, hashB);
  expect(
    "reset.other-session.B-intact",
    sessionBKeys.length === 1 && sessionBKeys[0].includes("cafecode/gpt-5.5"),
    `expected session B gpt-5.5 intact, got ${JSON.stringify(sessionBKeys)}`,
  );

  const sessionBStats = state.statsByModel[sessionBKeys[0]];
  expect(
    "reset.other-session.B-stats",
    sessionBStats?.hitRequests === 8 && sessionBStats?.totalRequests === 20,
    `expected session B stats unchanged, got hits=${sessionBStats?.hitRequests}, total=${sessionBStats?.totalRequests}`,
  );
}

// Test: Legacy v3 keys (no hash prefix) are migrated to current session on first load
{
  const hashA = hashSessionId("migration-session");

  // Simulate reading persisted v3 stats that were migrated by parsePersistedCacheStats
  // In v3, statsByModel uses plain "provider/id" keys without hash prefix
  const v3MigratedState: CacheStatsState = {
    statsByModel: {
      "otokapi/gpt-5.5": {
        day: "2026-05-24",
        totalRequests: 10,
        hitRequests: 3,
        cachedInputTokens: 3000,
        cacheWriteInputTokens: 0,
        totalInputTokens: 10000,
      },
    },
    legacyFamily: buildEmptyLegacyFamily(),
  };

  // Simulate first-load filtering: migrate legacy keys to current session
  const filtered = filterStatsForSession(v3MigratedState, hashA);
  const filteredKeys = Object.keys(filtered);
  expect(
    "v3-migration.keys-count",
    filteredKeys.length === 1,
    `expected 1 key after v3 migration, got ${filteredKeys.length}: ${JSON.stringify(filteredKeys)}`,
  );

  const migratedKey = filteredKeys[0];
  expect(
    "v3-migration.has-session-hash",
    migratedKey.startsWith(hashA),
    `expected migrated key to start with session hash, got "${migratedKey}"`,
  );

  const displayKey = modelKeyFromSessionKey(migratedKey);
  expect(
    "v3-migration.display-key",
    displayKey === "otokapi/gpt-5.5",
    `expected display key "otokapi/gpt-5.5", got "${displayKey}"`,
  );

  const migratedStats = filtered[migratedKey];
  expect(
    "v3-migration.stats-preserved",
    migratedStats?.hitRequests === 3 && migratedStats?.totalRequests === 10,
    `expected migrated stats preserved, got hits=${migratedStats?.hitRequests}, total=${migratedStats?.totalRequests}`,
  );
}

// Test: Same session hash + same provider/model produces the same internal key
{
  const hashA = hashSessionId("same-key-test");
  const key1 = makeSessionModelKey(hashA, "otokapi", "gpt-5.5");
  const key2 = makeSessionModelKey(hashA, "otokapi", "gpt-5.5");
  expect(
    "same-key.deterministic",
    key1 === key2,
    `expected same key for same session+model, got "${key1}" vs "${key2}"`,
  );
}

// Test: Different providers with same model id under same session produce different keys
{
  const hashA = hashSessionId("provider-distinction");
  const key1 = makeSessionModelKey(hashA, "otokapi", "gpt-5.5");
  const key2 = makeSessionModelKey(hashA, "cafecode", "gpt-5.5");
  expect(
    "provider-distinct.different",
    key1 !== key2,
    `expected different keys for different providers under same session, got "${key1}" and "${key2}"`,
  );
}

// Test: hashed session id is never the raw session id
{
  const rawId = "sess_raw_test_session_id_12345";
  const hash = hashSessionId(rawId);
  expect(
    "hash.not-raw",
    hash !== rawId,
    `expected hash to differ from raw session id`,
  );
  expect(
    "hash.sha256-prefix-length",
    hash.length === 16,
    `expected 16-char hash, got ${hash.length}: "${hash}"`,
  );
}

// ==========================================================================
// Test: mergeCacheSessions with _nosession — reset-undo regression guard
// ==========================================================================
//
// Bug scenario (the reset-undo bug):
//   1. Old v3 or v4 stats exist with `_nosession:otokapi/gpt-5.5` on disk.
//   2. restoreCacheStats migrates `_nosession` stats into current session in memory.
//   3. User runs /cache-optimizer reset for that model (before any normal stats write).
//   4. writePersistedCacheStats(state, currentSessionHash) preserves existing
//      `_nosession` entries in the file, even though the current session's entry
//      was cleared from memory.
//   5. Next reload re-migrates `_nosession` back → stats resurrected!
//
// The fix: writePersistedCacheStats must DELETE `_nosession` from existingSessions
// when currentSessionHash is provided (authoritative session-aware write).
//
// This test exercises the pure helper mergeCacheSessions.
{
  const sessionHash = hashSessionId("test-reset-nosession-regression");
  const otherSessionHash = hashSessionId("other-session");

  // Helper for creating a CacheStats-like record.
  const stats = (reqs: number, hits: number) => ({
    day: "2026-05-24",
    totalRequests: reqs,
    hitRequests: hits,
    cachedInputTokens: hits * 1000,
    cacheWriteInputTokens: 0,
    totalInputTokens: reqs * 2000,
  });

  // Simulate existing file data with:
  //   - _nosession:otokapi/gpt-5.5 (legacy migrated bucket)
  //   - otherSessionHash:otherProvider/model (a different real session)
  const existingSessions = {
    _nosession: {
      "otokapi/gpt-5.5": stats(10, 3),  // legacy 10 req, 3 hits
    },
    [otherSessionHash]: {
      "otherProvider/model": stats(5, 5),  // different session, untouched
    },
  };

  // Scenario A: currentSessionHash + empty statsByModel (reset scenario)
  // This simulates what happens after restoreCacheStats migrates _nosession to
  // current session, then the user resets, and writePersistedCacheStats is called.
  {
    const emptyState = {
      statsByModel: {
        // The _nosession data was already migrated to current session in memory
        // on load, but then reset deleted it. No current-session entries remain.
      },
      legacyFamily: {},
    };

    const merged = mergeCacheSessions(existingSessions, emptyState, sessionHash);

    // _nosession MUST be removed (consumed on authoritative write)
    expect(
      "nosession-reset.removed",
      merged._nosession === undefined,
      `expected _nosession to be removed when currentSessionHash provided, got ${JSON.stringify(Object.keys(merged))}`,
    );

    // Current session must appear (even if empty, after reset)
    expect(
      "nosession-reset.current-session-exists",
      merged[sessionHash] !== undefined,
      "expected current session hash key to exist (even if empty)",
    );

    // Current session must have NO entries (empty after reset)
    expect(
      "nosession-reset.current-session-empty",
      Object.keys(merged[sessionHash]).length === 0,
      `expected current session to be empty after reset, got ${JSON.stringify(Object.keys(merged[sessionHash]))}`,
    );

    // Other real sessions must be preserved
    expect(
      "nosession-reset.other-session-preserved",
      merged[otherSessionHash] !== undefined &&
        merged[otherSessionHash]["otherProvider/model"]?.hitRequests === 5,
      "expected other session data to be preserved intact",
    );
  }

  // Scenario B: currentSessionHash + current session has real data (normal write)
  // _nosession should still be removed since we're writing with a session hash.
  {
    const stateWithData = {
      statsByModel: {
        [`${sessionHash}:otokapi/gpt-5.5`]: stats(15, 8),
      },
      legacyFamily: {},
    };

    const merged = mergeCacheSessions(existingSessions, stateWithData, sessionHash);

    expect(
      "nosession-normal.removed",
      merged._nosession === undefined,
      "expected _nosession removed even in normal write",
    );

    // Current session must have the real data
    expect(
      "nosession-normal.current-data-kept",
      merged[sessionHash]?.["otokapi/gpt-5.5"]?.hitRequests === 8,
      "expected current session stats to include the 8 hits",
    );

    // Other sessions preserved
    expect(
      "nosession-normal.other-preserved",
      merged[otherSessionHash]?.["otherProvider/model"]?.hitRequests === 5,
      "expected other session data to be preserved",
    );
  }

  // Scenario C: no-hash mode (currentSessionHash undefined) — _nosession entries
  // SHOULD be populated from unhashed keys in statsByModel. This tests that the
  // no-hash path still works correctly for the transitional case.
  {
    const legacyState = {
      statsByModel: {
        "otokapi/gpt-5.5": stats(10, 3),  // no hash prefix → legacy v3
      },
      legacyFamily: {},
    };

    const merged = mergeCacheSessions(existingSessions, legacyState);

    // _nosession should exist (populated from legacy v3 key)
    expect(
      "nosession-nohash.preserved",
      merged._nosession !== undefined,
      "expected _nosession to exist in no-hash mode",
    );
    expect(
      "nosession-nohash.legacy-data",
      merged._nosession?.["otokapi/gpt-5.5"]?.hitRequests === 3,
      "expected legacy stats in _nosession",
    );
  }

  // Scenario D: currentSessionHash provided, no _nosession in existing sessions
  // (common case with modern session-tagged file). Should not throw or create _nosession.
  {
    const cleanExisting = {
      [otherSessionHash]: {
        "otherProvider/model": stats(5, 5),
      },
    };

    const merged = mergeCacheSessions(cleanExisting, {
      statsByModel: { [`${sessionHash}:some/model`]: stats(1, 1) },
      legacyFamily: {},
    }, sessionHash);

    expect(
      "nosession-clean.removed",
      merged._nosession === undefined,
      "expected _nosession to stay undefined when not present in input",
    );
    expect(
      "nosession-clean.current-data",
      merged[sessionHash]?.["some/model"]?.hitRequests === 1,
      "expected current session data to be present",
    );
    expect(
      "nosession-clean.other-preserved",
      merged[otherSessionHash]?.["otherProvider/model"]?.hitRequests === 5,
      "expected other session data preserved",
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
