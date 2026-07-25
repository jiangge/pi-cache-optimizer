#!/usr/bin/env bun
/** Direct regression coverage for findings from the Pi 0.82 code review. */

import extension, { __internals_for_tests as I } from "../../../index.ts";

const {
  getAgentDirDisplayPath,
  getModelsJsonDisplayPath,
  isPiBuiltInLlamaCppModel,
  shouldInjectOpenAIPromptCacheKeyForModel,
  describeMissingOpenAICompatibleProxyCompat,
  ensureRoutingRegistry,
  STATE_DIR,
} = I;

type Handler = (event: any, ctx: any) => unknown;
type Model = NonNullable<Parameters<typeof isPiBuiltInLlamaCppModel>[0]>;

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

function model(overrides: Partial<Model>): Model {
  return {
    provider: "test",
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    baseUrl: "https://proxy.example.com/v1",
    compat: {},
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  } as Model;
}

const handlers = new Map<string, Handler>();
const mockPi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand() {},
};
extension(mockPi as any);
const beforeAgentStart = handlers.get("before_agent_start");
const beforeProviderRequest = handlers.get("before_provider_request");
check("extension registers before_agent_start", typeof beforeAgentStart === "function");
check("extension registers before_provider_request", typeof beforeProviderRequest === "function");

function context(activeModel: Model, sessionId = "review-session") {
  return {
    model: activeModel,
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      getAll: () => [],
    },
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify() {},
      setStatus() {},
      confirm: async () => false,
      select: async () => undefined,
    },
  };
}

const responseModel = model({
  provider: "openai",
  id: "gpt-response-model",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
});
(globalThis as any).__piCacheOptimizerCacheKey__ = "stale-route-key";
await beforeAgentStart?.(
  { systemPrompt: "unchanged", systemPromptOptions: {} },
  context(responseModel),
);
check(
  "before_agent_start bypass clears stale legacy cache key",
  (globalThis as any).__piCacheOptimizerCacheKey__ === undefined,
);

const builtInLlama = model({
  provider: "llama.cpp",
  id: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
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

check("built-in llama.cpp compat fingerprint is recognized", isPiBuiltInLlamaCppModel(builtInLlama));

const builtInPayload: Record<string, unknown> = {
  model: builtInLlama.id,
  messages: [],
  prompt_cache_key: "pi-core-session-key",
  prompt_cache_retention: "24h",
};
const llamaResult = beforeProviderRequest?.({ payload: builtInPayload }, context(builtInLlama));
check("llama.cpp hook mutates in place without replacing payload", llamaResult === undefined);
check(
  "llama.cpp hook preserves Pi core prompt_cache_key",
  builtInPayload.prompt_cache_key === "pi-core-session-key",
  JSON.stringify(builtInPayload),
);
check(
  "llama.cpp hook strips unapproved prompt_cache_retention through the generic safe gate",
  !("prompt_cache_retention" in builtInPayload),
  JSON.stringify(builtInPayload),
);

const builtInWithoutKey: Record<string, unknown> = { model: builtInLlama.id, messages: [] };
const builtInFallback = beforeProviderRequest?.(
  { payload: builtInWithoutKey },
  context(builtInLlama, "llama-session"),
);
check(
  "llama.cpp remains eligible for the conservative session cache-key fallback",
  (builtInFallback as any)?.prompt_cache_key === "llama-session",
  JSON.stringify(builtInFallback),
);

const remoteSameName = model({
  provider: "llama.cpp",
  id: "remote-routed-model",
  baseUrl: "https://router.example.com/v1",
  compat: {},
});
check(
  "same-name remote/custom provider is not mistaken for Pi built-in llama.cpp",
  !isPiBuiltInLlamaCppModel(remoteSameName),
);
check(
  "same-name remote/custom provider keeps OpenAI cache-key fallback",
  shouldInjectOpenAIPromptCacheKeyForModel(remoteSameName),
);
check(
  "same-name remote/custom provider still receives proxy compat diagnosis",
  describeMissingOpenAICompatibleProxyCompat(remoteSameName).includes("sendSessionAffinityHeaders"),
);
const remotePayload: Record<string, unknown> = { model: remoteSameName.id, messages: [] };
const remoteResult = beforeProviderRequest?.({ payload: remotePayload }, context(remoteSameName, "remote-session"));
check(
  "same-name remote/custom provider receives session prompt_cache_key",
  (remoteResult as any)?.prompt_cache_key === "remote-session",
  JSON.stringify(remoteResult),
);

const routerShell = model({
  provider: "router",
  id: "auto",
  api: "router-api",
  baseUrl: "",
});
const unregisterRouter = ensureRoutingRegistry().registerRouter({
  virtualProvider: "router",
  resolveActiveRoute: () => ({
    virtualProvider: "router",
    virtualModelId: "auto",
    provider: builtInLlama.provider,
    modelId: builtInLlama.id,
    api: builtInLlama.api,
    timestamp: Date.now(),
  }),
});
const routedPayload: Record<string, unknown> = {
  model: builtInLlama.id,
  messages: [],
  prompt_cache_key: "routed-core-key",
  prompt_cache_retention: "24h",
};
const routedCtx = context(routerShell, "routed-session");
routedCtx.modelRegistry.find = (provider: string, id: string) =>
  provider === builtInLlama.provider && id === builtInLlama.id ? builtInLlama : undefined;
beforeProviderRequest?.({ payload: routedPayload }, routedCtx);
check(
  "virtual route resolves the real llama upstream and preserves its core cache key",
  routedPayload.prompt_cache_key === "routed-core-key",
  JSON.stringify(routedPayload),
);
check(
  "virtual route applies retention safety to the real llama upstream",
  !("prompt_cache_retention" in routedPayload),
  JSON.stringify(routedPayload),
);
unregisterRouter();

check(
  "Unix default display path is derived from the actual agent dir",
  getModelsJsonDisplayPath("linux", "/home/alice/.pi/agent", "/home/alice") === "~/.pi/agent/models.json",
);
check(
  "Windows default display path is derived from the actual agent dir",
  getModelsJsonDisplayPath("win32", "C:\\Users\\Alice\\.pi\\agent", "C:\\Users\\Alice") ===
    "%USERPROFILE%\\.pi\\agent\\models.json",
  getModelsJsonDisplayPath("win32", "C:\\Users\\Alice\\.pi\\agent", "C:\\Users\\Alice"),
);
check(
  "custom agent dir outside home stays absolute in diagnostics",
  getAgentDirDisplayPath("linux", "/srv/pi-agent", "/home/alice") === "/srv/pi-agent",
);

// This process has no PI_CONFIG_DIR, so the exported value should match Pi core.
check("STATE_DIR is non-empty and resolved by Pi core", typeof STATE_DIR === "string" && STATE_DIR.length > 0, STATE_DIR);

// Verify official env semantics in fresh module processes: PI_CONFIG_DIR is ignored,
// while PI_CODING_AGENT_DIR is the full agent-directory override.
const moduleUrl = new URL("../../../index.ts", import.meta.url).href;
function childStateDir(env: Record<string, string | undefined>): string {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) childEnv[key] = value;
  }
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", `import { __internals_for_tests as I } from ${JSON.stringify(moduleUrl)}; console.log(I.STATE_DIR);`],
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

const fakeHome = "/tmp/pi-cache-review-home";
check(
  "non-official PI_CONFIG_DIR does not redirect extension I/O away from Pi core",
  childStateDir({ HOME: fakeHome, PI_CODING_AGENT_DIR: undefined, PI_CONFIG_DIR: "/tmp/wrong-root" }) ===
    `${fakeHome}/.pi/agent`,
);
check(
  "PI_CODING_AGENT_DIR remains the authoritative full-directory override",
  childStateDir({ HOME: fakeHome, PI_CODING_AGENT_DIR: "~/custom-agent", PI_CONFIG_DIR: "/tmp/wrong-root" }) ===
    `${fakeHome}/custom-agent`,
);

console.log(`\nPassed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) process.exit(1);
