#!/usr/bin/env bun
/**
 * Verification: 403 session-affinity header detection.
 *
 * The extension monitors HTTP 403 responses in `after_provider_response` when
 * `sendSessionAffinityHeaders` is enabled (merged compat). Some third-party
 * proxies / CDNs / WAFs block Pi's custom session-affinity HTTP headers
 * (session_id, x-client-request-id, x-session-affinity) and return 403.
 *
 * These tests exercise the pure `isSessionAffinity403Applicable` helper:
 *   - openai-completions + sendSessionAffinityHeaders: true → applicable
 *   - openai-completions + sendSessionAffinityHeaders: false → not applicable
 *   - openai-completions + sendSessionAffinityHeaders: missing → not applicable
 *   - openai-responses + sendSessionAffinityHeaders: true → applicable
 *   - kiro-api (custom transport) → not applicable (regardless of flag)
 *   - anthropic-messages → not applicable (regardless of flag)
 *   - official OpenAI base URL → not applicable (session-affinity headers are
 *     a third-party proxy concern; official OpenAI accepts them silently)
 *
 * Note: unlike isPromptCacheRetention400Applicable, the 403 guard does NOT
 * exclude official OpenAI base URLs by itself — it only checks the API type
 * and the merged compat flag. The exclusion of official OpenAI is handled
 * by the fact that official OpenAI base URLs don't set sendSessionAffinityHeaders
 * in their default compat, so getCompat returns false. The test below
 * verifies that a model WITH explicit true still counts, which is fine —
 * official OpenAI would never set this flag in practice.
 */

import { __internals_for_tests as I } from "../../../index.ts";

const {
  isSessionAffinity403Applicable,
  describeMissingOpenAICompatibleProxyCompat,
  buildFixSuggestion,
  getCompat,
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

type PiModelLike = Parameters<typeof isSessionAffinity403Applicable>[0];

function mkModel(
  provider: string,
  id: string,
  api: string,
  compat: Record<string, unknown> = {},
  baseUrl: string = "",
): PiModelLike {
  return {
    id,
    name: id,
    provider,
    api,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    compat,
  } as PiModelLike;
}

// ── Case 1: openai-completions + sendSessionAffinityHeaders: true → applicable ──
{
  const model = mkModel("mofas", "glm-5.2", "openai-completions", {
    sendSessionAffinityHeaders: true,
  }, "https://www.mofas.one/v1");
  check(
    "openai-completions + sendSessionAffinityHeaders: true → applicable",
    isSessionAffinity403Applicable(model) === true,
  );
}

// ── Case 2: openai-completions + sendSessionAffinityHeaders: false → NOT applicable ──
{
  const model = mkModel("mofas", "glm-5.2", "openai-completions", {
    sendSessionAffinityHeaders: false,
  }, "https://www.mofas.one/v1");
  check(
    "openai-completions + sendSessionAffinityHeaders: false → NOT applicable",
    isSessionAffinity403Applicable(model) === false,
  );
}

// ── Case 3: openai-completions + sendSessionAffinityHeaders: missing → NOT applicable ──
{
  const model = mkModel("mofas", "glm-5.2", "openai-completions", {}, "https://www.mofas.one/v1");
  check(
    "openai-completions + sendSessionAffinityHeaders: missing → NOT applicable",
    isSessionAffinity403Applicable(model) === false,
  );
}

// ── Case 4: openai-responses + sendSessionAffinityHeaders: true → applicable ──
{
  const model = mkModel("myproxy", "gpt-5.5", "openai-responses", {
    sendSessionIdHeader: false, // openai-responses uses sendSessionIdHeader, not sendSessionAffinityHeaders
    sendSessionAffinityHeaders: true,
  }, "https://proxy.example.com/v1");
  check(
    "openai-responses + sendSessionAffinityHeaders: true → applicable",
    isSessionAffinity403Applicable(model) === true,
  );
}

// ── Case 5: kiro-api (custom transport) → NOT applicable (regardless of flag) ──
{
  const model = mkModel("kiro", "claude-opus-4-8", "kiro-api", {
    sendSessionAffinityHeaders: true,
  }, "");
  check(
    "kiro-api + sendSessionAffinityHeaders: true → NOT applicable (custom transport)",
    isSessionAffinity403Applicable(model) === false,
  );
}

// ── Case 6: anthropic-messages → NOT applicable ──
{
  const model = mkModel("anthropic", "claude-opus-4-8", "anthropic-messages", {
    sendSessionAffinityHeaders: true,
  }, "");
  check(
    "anthropic-messages + sendSessionAffinityHeaders: true → NOT applicable",
    isSessionAffinity403Applicable(model) === false,
  );
}

// ── Case 7: merged compat — model-level false overrides provider-level true ──
// This mirrors the mofas/glm-5.2 fix: provider says true, model says false.
// getCompat should merge to false, so isSessionAffinity403Applicable returns false.
{
  // We can't easily test merged compat without Pi's model registry, but we can
  // verify the helper uses getCompat (which does merging). Test with a model
  // that has only false set and confirm it's not applicable.
  const model = mkModel("mofas", "glm-5.2", "openai-completions", {
    thinkingFormat: "zai",
    supportsLongCacheRetention: false,
    sendSessionAffinityHeaders: false,
  }, "https://www.mofas.one/v1");
  const compat = getCompat(model);
  check(
    "merged compat for mofas/glm-5.2 (model-level false) → sendSessionAffinityHeaders is false",
    compat.sendSessionAffinityHeaders === false,
    `got: ${compat.sendSessionAffinityHeaders}`,
  );
  check(
    "mofas/glm-5.2 after fix → NOT applicable (403 guard correctly disabled)",
    isSessionAffinity403Applicable(model) === false,
  );
  check(
    "explicit sendSessionAffinityHeaders:false is NOT missing proxy compat",
    !describeMissingOpenAICompatibleProxyCompat(model).includes("sendSessionAffinityHeaders"),
    `missing=${JSON.stringify(describeMissingOpenAICompatibleProxyCompat(model))}`,
  );
  check(
    "explicit sendSessionAffinityHeaders:false does NOT make /fix suggest true",
    buildFixSuggestion(model) === undefined,
    `suggestion=${JSON.stringify(buildFixSuggestion(model))}`,
  );
}

// ── Case 8: openai-completions + missing sendSessionAffinityHeaders still reports missing ──
{
  const model = mkModel("generic", "grok-4.3-fast", "openai-completions", {}, "https://proxy.example.com/v1");
  check(
    "missing sendSessionAffinityHeaders still reports proxy compat missing",
    describeMissingOpenAICompatibleProxyCompat(model).includes("sendSessionAffinityHeaders"),
    `missing=${JSON.stringify(describeMissingOpenAICompatibleProxyCompat(model))}`,
  );
  const suggestion = buildFixSuggestion(model);
  check(
    "missing sendSessionAffinityHeaders still makes /fix suggest true",
    !!suggestion && suggestion.compatKeys.sendSessionAffinityHeaders === true,
    `suggestion=${JSON.stringify(suggestion)}`,
  );
}

// ── Case 9: official OpenAI base URL + sendSessionAffinityHeaders: true ──
// Unlike isPromptCacheRetention400Applicable, the 403 guard does NOT exclude
// official OpenAI by base URL. It only checks the compat flag. In practice
// official OpenAI never sets this flag, so this is fine. Verify the behavior
// is driven by the flag, not by the base URL.
{
  const model = mkModel("openai", "gpt-5.5", "openai-completions", {
    sendSessionAffinityHeaders: true,
  }, "https://api.openai.com/v1");
  check(
    "official OpenAI base URL + sendSessionAffinityHeaders: true → still applicable (guard is flag-driven)",
    isSessionAffinity403Applicable(model) === true,
  );
}

// ── Case 10: antling / together / nvidia custom transports → NOT applicable ──
{
  const model = mkModel("nvidia", "llama-3.1-405b", "openai-completions", {
    sendSessionAffinityHeaders: true,
  }, "https://integrate.api.nvidia.com/v1");
  // nvidia uses openai-completions, so this IS applicable — the guard only
  // checks the API type, not the provider. This is correct: even NVIDIA's
  // proxy could block custom headers. Verify this behavior.
  check(
    "nvidia openai-completions + sendSessionAffinityHeaders: true → applicable (API-driven guard)",
    isSessionAffinity403Applicable(model) === true,
  );
}

// ── Summary ──
console.log("");
console.log("=== Summary ===");
console.log(`Passed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
console.log("");
if (failed > 0) {
  console.log("❌ FAIL  Some tests failed!");
  process.exit(1);
} else {
  console.log("✅ All tests passed!");
}