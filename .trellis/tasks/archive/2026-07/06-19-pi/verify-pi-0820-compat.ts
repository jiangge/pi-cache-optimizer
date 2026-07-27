#!/usr/bin/env bun
/**
 * Verify Pi 0.82.0 compatibility behavior.
 *
 * Covers two upgrade-facing adjustments:
 *   1. Pi agent-dir overrides: stats/models.json paths follow
 *      PI_CODING_AGENT_DIR (or PI_CONFIG_DIR root fallback) instead of always
 *      assuming ~/.pi/agent.
 *   2. Pi 0.81+ local llama.cpp provider: it uses an OpenAI-shaped transport
 *      but is a local single-backend server, not a third-party cache-routing
 *      proxy. Do not inject prompt_cache_key or surface proxy compat/fix/403
 *      diagnostics for provider "llama.cpp".
 */

import { __internals_for_tests as I } from "#extension";

const {
  AGENT_DIR_ENV,
  CONFIG_DIR_ENV,
  resolvePiAgentDir,
  getAgentDirDisplayPath,
  getModelsJsonDisplayPath,
  isPiLocalLlamaCppModel,
  shouldInjectOpenAIPromptCacheKeyForModel,
  describeMissingOpenAICompatibleProxyCompat,
  describeOptionalOpenAICompatibleProxyCompat,
  buildFixSuggestion,
  isCompatCheckApplicable,
  isPromptCacheRetention400Applicable,
  isSessionAffinity403Applicable,
  isOpenAISdkHeader403Applicable,
  describeRouterChannelDiagnostics,
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

type Model = NonNullable<Parameters<typeof isPiLocalLlamaCppModel>[0]>;

function model(overrides: Partial<Model>): Model {
  return {
    provider: "test",
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
    compat: {},
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  } as Model;
}

// ── Pi agent-dir path resolution ──────────────────────────────────
{
  const env: Record<string, string | undefined> = {};
  check(
    "default agent dir resolves under ~/.pi/agent",
    resolvePiAgentDir(env, "/home/alice") === "/home/alice/.pi/agent",
    `got=${resolvePiAgentDir(env, "/home/alice")}`,
  );
  check(
    "default Unix models.json display path uses tilde shorthand",
    getModelsJsonDisplayPath("linux", env) === "~/.pi/agent/models.json",
    `got=${getModelsJsonDisplayPath("linux", env)}`,
  );
  check(
    "default Windows models.json display path uses USERPROFILE shorthand",
    getModelsJsonDisplayPath("win32", env) === "%USERPROFILE%\\.pi\\agent\\models.json",
    `got=${getModelsJsonDisplayPath("win32", env)}`,
  );
}

{
  const env: Record<string, string | undefined> = { [AGENT_DIR_ENV]: "~/custom-agent" };
  check(
    "PI_CODING_AGENT_DIR resolves as the full agent dir",
    resolvePiAgentDir(env, "/home/alice") === "/home/alice/custom-agent",
    `got=${resolvePiAgentDir(env, "/home/alice")}`,
  );
  check(
    "PI_CODING_AGENT_DIR display path points models.json inside that dir",
    getModelsJsonDisplayPath("linux", env) === "~/custom-agent/models.json",
    `got=${getModelsJsonDisplayPath("linux", env)}`,
  );
}

{
  const env: Record<string, string | undefined> = { [CONFIG_DIR_ENV]: "~/custom-pi" };
  check(
    "PI_CONFIG_DIR fallback resolves as a config root with /agent",
    resolvePiAgentDir(env, "/home/alice") === "/home/alice/custom-pi/agent",
    `got=${resolvePiAgentDir(env, "/home/alice")}`,
  );
  check(
    "PI_CONFIG_DIR display path points models.json under root/agent",
    getModelsJsonDisplayPath("linux", env) === "~/custom-pi/agent/models.json",
    `got=${getModelsJsonDisplayPath("linux", env)}`,
  );
  check(
    "agent-dir display helper mirrors PI_CONFIG_DIR root",
    getAgentDirDisplayPath("linux", env) === "~/custom-pi/agent",
    `got=${getAgentDirDisplayPath("linux", env)}`,
  );
}

// ── Pi 0.81+/0.82 local llama.cpp provider ────────────────────────
const localLlama = model({
  provider: "llama.cpp",
  id: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
  name: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8080/v1",
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
  },
});

check("llama.cpp provider is recognized as Pi local llama.cpp", isPiLocalLlamaCppModel(localLlama));
check(
  "local llama.cpp does not receive OpenAI prompt_cache_key fallback",
  !shouldInjectOpenAIPromptCacheKeyForModel(localLlama),
);
check(
  "local llama.cpp is not treated as missing OpenAI proxy compat",
  describeMissingOpenAICompatibleProxyCompat(localLlama).length === 0,
  `missing=${JSON.stringify(describeMissingOpenAICompatibleProxyCompat(localLlama))}`,
);
check(
  "local llama.cpp has no optional long-retention proxy advisory",
  describeOptionalOpenAICompatibleProxyCompat(localLlama).length === 0,
  `optional=${JSON.stringify(describeOptionalOpenAICompatibleProxyCompat(localLlama))}`,
);
check(
  "local llama.cpp is not a compat-check-applicable proxy",
  !isCompatCheckApplicable(localLlama),
);
check(
  "local llama.cpp has no /fix suggestion",
  buildFixSuggestion(localLlama) === undefined,
  `suggestion=${JSON.stringify(buildFixSuggestion(localLlama))}`,
);
check(
  "local llama.cpp has no router/channel proxy diagnostics",
  describeRouterChannelDiagnostics(localLlama).length === 0,
  `notes=${JSON.stringify(describeRouterChannelDiagnostics(localLlama))}`,
);

const localLlamaWithLongRetention = model({
  ...localLlama,
  compat: { ...localLlama.compat, supportsLongCacheRetention: true },
});
check(
  "local llama.cpp is excluded from prompt_cache_retention 400/fix diagnostics even if compat is true",
  !isPromptCacheRetention400Applicable(localLlamaWithLongRetention),
);
check(
  "local llama.cpp with long-retention compat still has no /fix suggestion",
  buildFixSuggestion(localLlamaWithLongRetention) === undefined,
  `suggestion=${JSON.stringify(buildFixSuggestion(localLlamaWithLongRetention))}`,
);

const localLlamaWithAffinity = model({
  ...localLlama,
  compat: { ...localLlama.compat, sendSessionAffinityHeaders: true },
});
check(
  "local llama.cpp is excluded from session-affinity 403 diagnostic even if compat is true",
  !isSessionAffinity403Applicable(localLlamaWithAffinity),
);
check(
  "local llama.cpp is excluded from OpenAI SDK header 403 diagnostic",
  !isOpenAISdkHeader403Applicable(localLlama),
);

const localDeepSeekNamedLlama = model({
  ...localLlama,
  id: "DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf",
  name: "DeepSeek R1 Distill Llama 8B",
});
check(
  "local llama.cpp deepseek-named GGUF still has no /fix suggestion",
  buildFixSuggestion(localDeepSeekNamedLlama) === undefined,
  `suggestion=${JSON.stringify(buildFixSuggestion(localDeepSeekNamedLlama))}`,
);

// Remote OpenAI-compatible providers added in 0.82 (e.g. Qwen Token Plan)
// remain ordinary third-party proxy/cache-routing channels.
const qwenTokenPlan = model({
  provider: "qwen-token-plan",
  id: "qwen3-coder-plus",
  name: "Qwen3 Coder Plus",
  api: "openai-completions",
  baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
});
check("Qwen Token Plan is not local llama.cpp", !isPiLocalLlamaCppModel(qwenTokenPlan));
check(
  "Qwen Token Plan still receives OpenAI prompt_cache_key fallback",
  shouldInjectOpenAIPromptCacheKeyForModel(qwenTokenPlan),
);
check(
  "Qwen Token Plan still reports missing session-affinity compat when absent",
  describeMissingOpenAICompatibleProxyCompat(qwenTokenPlan).includes("sendSessionAffinityHeaders"),
  `missing=${JSON.stringify(describeMissingOpenAICompatibleProxyCompat(qwenTokenPlan))}`,
);

console.log(`\nPassed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) process.exit(1);
