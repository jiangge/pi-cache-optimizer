#!/usr/bin/env bun
/**
 * Verify Pi 0.80.10 / Kimi K3 compatibility behavior.
 */

import { __internals_for_tests as I } from "../../../index.ts";

const {
  isKimiLikeModel,
  isKimiCodingAdaptiveModel,
  isKimiCodingEmptySignatureModel,
  isAdaptiveThinkingCompatApplicable,
  describeMissingAdaptiveThinkingCompat,
  describeMissingDeepSeekCompat,
  buildFixSuggestion,
  decideFixPlacement,
} = I;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`❌ FAIL  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

type Model = NonNullable<Parameters<typeof isKimiLikeModel>[0]>;

function model(overrides: Partial<Model>): Model {
  return {
    provider: "test",
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
    compat: {},
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    ...overrides,
  } as Model;
}

const moonshotK3 = model({
  provider: "moonshotai",
  id: "kimi-k3",
  name: "Kimi K3",
  api: "openai-completions",
  baseUrl: "https://api.moonshot.ai/v1",
  compat: {
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
    deferredToolsMode: "kimi",
  },
});
check("Moonshot K3 selects Kimi family", isKimiLikeModel(moonshotK3));
check("Moonshot K3 is not Kimi Coding adaptive", !isKimiCodingAdaptiveModel(moonshotK3));
check("Moonshot K3 does not enter anthropic adaptive path", !isAdaptiveThinkingCompatApplicable(moonshotK3));

const kimiCodingK3 = model({
  provider: "kimi-coding",
  id: "k3",
  name: "Kimi K3",
  api: "anthropic-messages",
  baseUrl: "https://api.kimi.com/coding",
});
check("Kimi Coding k3 is recognized despite short id", isKimiCodingAdaptiveModel(kimiCodingK3));
check("Kimi Coding k3 adaptive compat applies", isAdaptiveThinkingCompatApplicable(kimiCodingK3));
check("Kimi Coding k3 requires empty-signature replay", isKimiCodingEmptySignatureModel(kimiCodingK3));
const k3Missing = describeMissingAdaptiveThinkingCompat(kimiCodingK3);
check(
  "Kimi Coding k3 requires adaptive + empty signature",
  JSON.stringify(k3Missing) === JSON.stringify(["forceAdaptiveThinking", "allowEmptySignature"]),
  `missing=${JSON.stringify(k3Missing)}`,
);
check(
  "Kimi Coding k3 fix writes both flags",
  JSON.stringify(buildFixSuggestion(kimiCodingK3)?.compatKeys) === JSON.stringify({
    forceAdaptiveThinking: true,
    allowEmptySignature: true,
  }),
  `fix=${JSON.stringify(buildFixSuggestion(kimiCodingK3))}`,
);

const configuredK3 = model({
  ...kimiCodingK3,
  compat: { forceAdaptiveThinking: true, allowEmptySignature: true },
});
check("Configured Kimi Coding k3 has no missing compat", describeMissingAdaptiveThinkingCompat(configuredK3).length === 0);
check("Configured Kimi Coding k3 has no fix", buildFixSuggestion(configuredK3) === undefined);
check(
  "Mixed Kimi Coding provider keeps K3 adaptive fix model-scoped",
  decideFixPlacement(
    { forceAdaptiveThinking: true, allowEmptySignature: true },
    "kimi-coding",
    ["k3", "legacy-model"],
  ).placement === "model",
);
check(
  "All-adaptive Kimi Coding siblings may share provider compat",
  decideFixPlacement(
    { forceAdaptiveThinking: true, allowEmptySignature: true },
    "kimi-coding",
    ["k3", "kimi-for-coding"],
  ).placement === "provider",
);

const kimiForCoding = model({
  provider: "custom-kimi",
  id: "kimi-for-coding",
  name: "Kimi For Coding",
  api: "anthropic-messages",
  baseUrl: "https://api.kimi.com/coding",
});
check("kimi-for-coding channel is recognized", isKimiCodingAdaptiveModel(kimiForCoding));
check("kimi-for-coding supports empty-signature replay", isKimiCodingEmptySignatureModel(kimiForCoding));
check(
  "kimi-for-coding requires adaptive + empty-signature compat",
  JSON.stringify(describeMissingAdaptiveThinkingCompat(kimiForCoding)) === JSON.stringify(["forceAdaptiveThinking", "allowEmptySignature"]),
  `missing=${JSON.stringify(describeMissingAdaptiveThinkingCompat(kimiForCoding))}`,
);

const vercelK3 = model({
  provider: "vercel-ai-gateway",
  id: "moonshotai/kimi-k3",
  name: "Kimi K3",
  api: "anthropic-messages",
  baseUrl: "https://ai-gateway.vercel.sh",
});
check("Vercel Anthropic K3 is not mistaken for Kimi Coding", !isKimiCodingAdaptiveModel(vercelK3));
check("Vercel Anthropic K3 gets no Kimi Coding compat warning", !isAdaptiveThinkingCompatApplicable(vercelK3));

const customKimiCodingProxy = model({
  provider: "team-kimi-coding-proxy",
  id: "moonshotai/kimi-k3",
  name: "Kimi K3",
  api: "anthropic-messages",
  baseUrl: "https://gateway.example.com/anthropic",
});
check("Kimi Coding-named custom proxy is recognized", isKimiCodingAdaptiveModel(customKimiCodingProxy));
check("Kimi Coding-named custom proxy gets adaptive compat", isAdaptiveThinkingCompatApplicable(customKimiCodingProxy));

const unrelatedK3 = model({
  provider: "unrelated",
  id: "k3",
  name: "K3",
  api: "anthropic-messages",
  baseUrl: "https://example.com/anthropic",
});
check("Bare k3 outside Kimi Coding is not recognized", !isKimiCodingAdaptiveModel(unrelatedK3));
check("Bare k3 outside Kimi Coding has no adaptive compat path", !isAdaptiveThinkingCompatApplicable(unrelatedK3));

const deepSeekResponses = model({
  provider: "deepseek-proxy",
  id: "deepseek-v4",
  name: "DeepSeek V4",
  api: "openai-responses",
  compat: {
    supportsLongCacheRetention: true,
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
  },
});
const responseMissing = describeMissingDeepSeekCompat(deepSeekResponses);
check(
  "Pi 0.80.7+ responses compat does not suggest removed sendSessionIdHeader",
  !responseMissing.includes("sendSessionIdHeader") && responseMissing.length === 0,
  `missing=${JSON.stringify(responseMissing)}`,
);

console.log(`\nPassed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) process.exit(1);
