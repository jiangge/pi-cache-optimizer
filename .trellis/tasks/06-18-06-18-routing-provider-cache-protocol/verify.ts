// Verification script for task 06-18-routing-provider-cache-protocol.
//
// Run from the repo root with:
//   bun .trellis/tasks/06-18-06-18-routing-provider-cache-protocol/verify.ts
//
// Exits 0 on success, 1 on any failed assertion.

import { __internals_for_tests } from "../../../index.ts";

const {
  PI_ROUTING_REGISTRY_SYMBOL,
  PI_CACHE_HINTS_SYMBOL,
  ensureRoutingRegistry,
  getRoutingRegistry,
  parseRouteSnapshot,
  resolveActiveRouteSnapshot,
  routeSnapshotToPiModel,
  resolveRouteModel,
  isVirtualRoutingModel,
  selectAdapterForAssistantMessage,
  buildExactRouterStatusEntry,
  installCacheHintsService,
  getCacheHintsService,
  addOpenAIPromptCacheKey,
  hashSessionId,
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

function makeCtx(sessionId = "routing-session") {
  const models = [
    {
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      compat: {
        supportsLongCacheRetention: true,
        sendSessionAffinityHeaders: true,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
    },
    {
      provider: "anthropic",
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      compat: { forceAdaptiveThinking: true },
    },
  ];

  return {
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: {
      find(provider: string, id: string) {
        return models.find((m) => m.provider === provider && m.id === id);
      },
      getAvailable() {
        return models;
      },
      getAll() {
        return models;
      },
    },
  } as any;
}

const globals = globalThis as any;
const previousRegistry = globals[PI_ROUTING_REGISTRY_SYMBOL];
const previousHints = globals[PI_CACHE_HINTS_SYMBOL];
const previousLegacyRouter = globals.__piCacheOptimizerRouter;
const previousLegacyCacheKey = globals.__piCacheOptimizerCacheKey__;

delete globals[PI_ROUTING_REGISTRY_SYMBOL];
delete globals[PI_CACHE_HINTS_SYMBOL];
delete globals.__piCacheOptimizerRouter;
delete globals.__piCacheOptimizerCacheKey__;

try {
  // ====================================================================
  // Test 1: registry installation and adapter lifecycle
  // ====================================================================
  const registry = ensureRoutingRegistry();
  expect("registry-installed", registry === getRoutingRegistry(), "ensureRoutingRegistry should publish the global symbol");
  expectEq("registry-version", registry.version, 1);

  const unregister = registry.registerRouter({
    virtualProvider: "router",
    resolveActiveRoute(virtualModelId: string, hint?: { sessionIdHash?: string }) {
      return {
        virtualProvider: "router",
        virtualModelId,
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        api: "openai-completions",
        canonicalModelId: "deepseek-v4-pro",
        routeLabel: "DeepSeek route",
        status: "selected" as const,
        sessionIdHash: hint?.sessionIdHash,
        timestamp: 123,
      };
    },
  });

  expect("registry-registered", getRoutingRegistry()?.getRouter("router") !== undefined, "router adapter should be retrievable");
  unregister();
  expect("registry-unregistered", getRoutingRegistry()?.getRouter("router") === undefined, "unregister should remove the adapter");

  // ====================================================================
  // Test 2: parseRouteSnapshot accepts aliases and rejects incomplete input
  // ====================================================================
  const parsed = parseRouteSnapshot(
    {
      virtualModel: "subscription-swe",
      upstreamProvider: "anthropic",
      upstreamModelId: "claude-opus-4-8",
      status: "success",
      label: "Subscription SWE",
    },
    "auto-router",
    "fallback-route",
  );
  expect("parse-route", parsed !== undefined, "aliased route snapshot should parse");
  if (parsed) {
    expectEq("parse-route-virtual-provider", parsed.virtualProvider, "auto-router");
    expectEq("parse-route-virtual-model", parsed.virtualModelId, "subscription-swe");
    expectEq("parse-route-provider", parsed.provider, "anthropic");
    expectEq("parse-route-model", parsed.modelId, "claude-opus-4-8");
    expectEq("parse-route-status", parsed.status, "success");
    expectEq("parse-route-label", parsed.routeLabel, "Subscription SWE");
  }
  expect("parse-route-incomplete", parseRouteSnapshot({ provider: "deepseek" }, "router", "x") === undefined,
    "incomplete snapshots must be ignored");

  // ====================================================================
  // Test 3: active route resolution + registry model lookup
  // ====================================================================
  registry.registerRouter({
    virtualProvider: "router",
    resolveActiveRoute(virtualModelId: string, hint?: { sessionIdHash?: string }) {
      return {
        virtualProvider: "router",
        virtualModelId,
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        api: "openai-completions",
        sessionIdHash: hint?.sessionIdHash,
        timestamp: Date.now(),
      };
    },
  });

  const routerModel = {
    provider: "router",
    id: "deepseek-v4-pro",
    name: "DeepSeek route",
    api: "router-api",
    baseUrl: "",
    compat: {},
  } as any;
  const ctx = makeCtx("route-session-1");
  const snapshot = resolveActiveRouteSnapshot(routerModel, ctx);
  expect("resolve-snapshot", snapshot !== undefined, "snapshot should resolve through registry");
  if (snapshot) {
    expectEq("resolve-snapshot-session-hash", snapshot.sessionIdHash, hashSessionId("route-session-1"));
  }

  const resolvedModel = resolveRouteModel(routerModel, ctx);
  expect("resolve-route-model", resolvedModel !== undefined, "route model should resolve through ctx.modelRegistry");
  if (resolvedModel) {
    expectEq("resolve-route-provider", resolvedModel.provider, "deepseek");
    expectEq("resolve-route-id", resolvedModel.id, "deepseek-v4-pro");
    expectEq("resolve-route-api", resolvedModel.api, "openai-completions");
    expectDeepEq("resolve-route-compat", resolvedModel.compat, {
      supportsLongCacheRetention: true,
      sendSessionAffinityHeaders: true,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
  }
  expect("virtual-routing-model", isVirtualRoutingModel(routerModel, ctx), "registered virtual provider should count as routing model");

  // ====================================================================
  // Test 4: assistant message metadata is authoritative for adapter identity
  // ====================================================================
  const routedMessage = {
    role: "assistant",
    provider: "anthropic",
    responseModel: "claude-opus-4-8",
    api: "anthropic-messages",
    usage: {
      input: 1000,
      cacheRead: 900,
      cacheWrite: 0,
    },
  };
  const adapter = selectAdapterForAssistantMessage(routedMessage, routerModel);
  expect("assistant-metadata-adapter", adapter !== undefined, "adapter should be selected from assistant metadata");
  expectEq("assistant-metadata-label", adapter?.label, "Claude cache");

  // ====================================================================
  // Test 5: exact router footer restore returns model + adapter + stats
  // ====================================================================
  const sessionHash = hashSessionId("footer-session");
  const entry = buildExactRouterStatusEntry(
    sessionHash,
    {
      [`${sessionHash}:anthropic/claude-opus-4-8`]: {
        day: "2026-06-18",
        totalRequests: 3,
        hitRequests: 2,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 0,
        totalInputTokens: 1000,
      },
    },
    { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  );
  expect("exact-entry", entry !== undefined, "exact router status entry should resolve");
  if (entry) {
    expectEq("exact-entry-model-provider", entry.model.provider, "anthropic");
    expectEq("exact-entry-label", entry.adapter.label, "Claude cache");
    expectEq("exact-entry-requests", entry.stats.totalRequests, 3);
  }

  // ====================================================================
  // Test 6: cache hints service is query-scoped and preserves request keys
  // ====================================================================
  const uninstallHints = installCacheHintsService({
    version: 1,
    getHints(input: any) {
      if (input.virtualProvider !== "router") return undefined;
      return { systemPrompt: "optimized", promptCacheKey: "cache-key", cacheRetention: "long" };
    },
  });
  expect("hints-service-installed", getCacheHintsService() !== undefined, "cache hints service should install");
  expectDeepEq(
    "hints-service-match",
    getCacheHintsService()?.getHints({ virtualProvider: "router" }),
    { systemPrompt: "optimized", promptCacheKey: "cache-key", cacheRetention: "long" },
  );
  expectEq("hints-service-miss", getCacheHintsService()?.getHints({ virtualProvider: "other" }), undefined);
  uninstallHints();

  const payloadWithExistingKey = { prompt_cache_key: "already-set", messages: [] };
  expectEq("preserve-existing-key", addOpenAIPromptCacheKey(payloadWithExistingKey, "new-key"), undefined);
  expectDeepEq("add-missing-key", addOpenAIPromptCacheKey({ messages: [] }, "new-key"), { messages: [], prompt_cache_key: "new-key" });

  // ====================================================================
  // Test 7: legacy global shim remains migration-compatible
  // ====================================================================
  delete globals[PI_ROUTING_REGISTRY_SYMBOL];
  globals.__piCacheOptimizerRouter = {
    resolveActiveRoute(modelId: string) {
      return {
        virtualProvider: "legacy-router",
        virtualModelId: modelId,
        provider: "anthropic",
        modelId: "claude-opus-4-8",
        api: "anthropic-messages",
      };
    },
  };
  const legacyRoute = resolveActiveRouteSnapshot({ provider: "legacy-router", id: "route", api: "router" } as any, makeCtx());
  expect("legacy-route", legacyRoute !== undefined, "legacy __piCacheOptimizerRouter shim should resolve");
  if (legacyRoute) {
    expectEq("legacy-route-provider", legacyRoute.provider, "anthropic");
    expectEq("legacy-route-model", legacyRoute.modelId, "claude-opus-4-8");
  }
} finally {
  if (previousRegistry === undefined) delete globals[PI_ROUTING_REGISTRY_SYMBOL];
  else globals[PI_ROUTING_REGISTRY_SYMBOL] = previousRegistry;

  if (previousHints === undefined) delete globals[PI_CACHE_HINTS_SYMBOL];
  else globals[PI_CACHE_HINTS_SYMBOL] = previousHints;

  if (previousLegacyRouter === undefined) delete globals.__piCacheOptimizerRouter;
  else globals.__piCacheOptimizerRouter = previousLegacyRouter;

  if (previousLegacyCacheKey === undefined) delete globals.__piCacheOptimizerCacheKey__;
  else globals.__piCacheOptimizerCacheKey__ = previousLegacyCacheKey;
}

if (failures.length === 0) {
  console.log("✅ Routing-provider protocol verification passed.");
  process.exit(0);
} else {
  console.error(`❌ ${failures.length} test(s) failed:\n`);
  for (const failure of failures) {
    console.error(`  FAIL: ${failure.name}`);
    console.error(`    ${failure.detail}`);
  }
  process.exit(1);
}
