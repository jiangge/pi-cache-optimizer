import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { __internals_for_tests as internals } from "#extension";

type PiModel = NonNullable<ExtensionContext["model"]>;

type Handler = (event: any, context: any) => unknown;
type Command = { handler: (args: string, context: any) => unknown };

function model(overrides: Partial<PiModel> = {}): PiModel {
  return {
    provider: "proxy",
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    compat: {},
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...overrides,
  };
}

function stats(totalRequests: number, day = "2026-08-17") {
  return {
    day,
    totalRequests,
    hitRequests: Math.min(1, totalRequests),
    cachedInputTokens: totalRequests > 0 ? 100 : 0,
    cacheWriteInputTokens: 0,
    totalInputTokens: totalRequests > 0 ? 200 : 0,
  };
}

const originalRoutingRegistry = (globalThis as any)[internals.PI_ROUTING_REGISTRY_SYMBOL];
const originalCacheHints = (globalThis as any)[internals.PI_CACHE_HINTS_SYMBOL];

afterEach(() => {
  if (originalRoutingRegistry === undefined) {
    delete (globalThis as any)[internals.PI_ROUTING_REGISTRY_SYMBOL];
  } else {
    (globalThis as any)[internals.PI_ROUTING_REGISTRY_SYMBOL] = originalRoutingRegistry;
  }
  if (originalCacheHints === undefined) {
    delete (globalThis as any)[internals.PI_CACHE_HINTS_SYMBOL];
  } else {
    (globalThis as any)[internals.PI_CACHE_HINTS_SYMBOL] = originalCacheHints;
  }
});

describe("OpenAI-compatible request contracts", () => {
  test("adds a session cache key only when no effective key exists", () => {
    assert.deepEqual(
      internals.addOpenAIPromptCacheKey({ messages: [] }, "session-key"),
      { messages: [], prompt_cache_key: "session-key" },
    );
    assert.equal(
      internals.addOpenAIPromptCacheKey({ prompt_cache_key: "existing" }, "session-key"),
      undefined,
    );
    assert.equal(
      internals.addOpenAIPromptCacheKey({ promptCacheKey: "existing" }, "session-key"),
      undefined,
    );
    assert.deepEqual(
      internals.addOpenAIPromptCacheKey({ prompt_cache_key: "   " }, "session-key"),
      { prompt_cache_key: "session-key" },
    );
    assert.equal(internals.addOpenAIPromptCacheKey(null, "session-key"), undefined);
  });

  test("recognizes prompt_cache_retention errors from headers and assistant messages", () => {
    assert.equal(
      internals.hasPromptCacheRetentionUnsupportedSignal({
        "x-error-message": "Unsupported parameter: prompt_cache_retention",
      }),
      true,
    );
    assert.equal(
      internals.hasPromptCacheRetentionUnsupportedErrorMessage({
        role: "assistant",
        stopReason: "error",
        errorMessage: "400 Unsupported parameter: prompt_cache_retention",
      }),
      true,
    );
    assert.equal(
      internals.hasPromptCacheRetentionUnsupportedErrorMessage({
        role: "assistant",
        stopReason: "error",
        errorMessage: "400 Unsupported parameter: temperature",
      }),
      false,
    );
    assert.equal(
      internals.hasPromptCacheRetentionUnsupportedErrorMessage({
        role: "assistant",
        stopReason: "error",
        errorMessage: "400 Bad request: prompt_cache_retention must be one of 24h or in-memory",
      }),
      false,
    );
  });
});

describe("Anthropic cache-control TTL safety", () => {
  test("downgrades every long breakpoint when a short-to-long transition is visible", () => {
    const payload = {
      tools: [{ cache_control: { type: "ephemeral" } }],
      system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{
        content: [{ cache_control: { type: "ephemeral", ttl: "1h" } }],
      }],
    };

    assert.equal(internals.normalizeAnthropicCacheControlTtlOrder(payload), true);
    assert.equal(payload.system[0].cache_control.ttl, undefined);
    assert.equal(payload.messages[0].content[0].cache_control.ttl, undefined);
  });

  test("preserves legal long-to-short ordering", () => {
    const payload = {
      tools: [{ cache_control: { type: "ephemeral", ttl: "1h" } }],
      system: [{ cache_control: { type: "ephemeral", ttl: "5m" } }],
    };
    const before = structuredClone(payload);

    assert.equal(internals.normalizeAnthropicCacheControlTtlOrder(payload), false);
    assert.deepEqual(payload, before);
  });
});

describe("persisted cache stats migrations", () => {
  test("treats an empty v6 totalsByModel as authoritative", () => {
    const parsed = internals.parsePersistedCacheStats({
      version: 6,
      sessions: { sessionA: { "proxy/gpt-5.5": stats(4) } },
      totalsByModel: {},
      legacyFamily: {},
    });

    assert.ok(parsed);
    assert.deepEqual(parsed.totalsByModel, {});
    assert.equal(parsed.statsByModel["sessionA:proxy/gpt-5.5"].totalRequests, 4);
  });

  test("derives totals for v5 while preserving exact routed metadata", () => {
    const parsed = internals.parsePersistedCacheStats({
      version: 5,
      sessions: {
        sessionA: { "proxy/gpt-5.5": stats(2) },
        sessionB: { "proxy/gpt-5.5": stats(3) },
      },
      legacyFamily: {},
      lastRoutedModelBySession: {
        sessionA: { provider: "proxy", id: "gpt-5.5", name: "GPT-5.5" },
      },
    });

    assert.ok(parsed);
    assert.equal(parsed.totalsByModel["proxy/gpt-5.5"].totalRequests, 5);
    assert.equal(parsed.lastRoutedModelBySession?.sessionA.id, "gpt-5.5");
  });

  test("migrates legacy v3/v2/v1 shapes and drops malformed counters", () => {
    const v3 = internals.parsePersistedCacheStats({
      version: 3,
      statsByModel: {
        "proxy/gpt-5.5": stats(2),
        malformed: { day: "2026-08-17", totalRequests: -1 },
      },
      legacyFamily: {},
    });
    assert.ok(v3);
    assert.equal(v3.statsByModel["proxy/gpt-5.5"].totalRequests, 2);
    assert.equal(v3.statsByModel.malformed, undefined);

    const v2 = internals.parsePersistedCacheStats({
      version: 2,
      statsByProvider: { openai: stats(3) },
    });
    assert.equal(v2?.legacyFamily.openai?.totalRequests, 3);
    assert.deepEqual(v2?.totalsByModel, {});

    const v1 = internals.parsePersistedCacheStats({ version: 1, stats: stats(1) });
    assert.equal(v1?.legacyFamily.deepseek?.totalRequests, 1);
    assert.equal(internals.parsePersistedCacheStats({ version: 99 }), undefined);
  });

  test("an authoritative session write removes _nosession and preserves siblings", () => {
    const merged = internals.mergeCacheSessions(
      {
        _nosession: { "proxy/gpt-5.5": stats(9) },
        otherSession: { "anthropic/claude-opus-5": stats(2) },
      },
      {
        statsByModel: {
          "currentSession:proxy/gpt-5.5": stats(1),
        },
        totalsByModel: { "proxy/gpt-5.5": stats(1) },
        legacyFamily: {},
      },
      "currentSession",
    );

    assert.equal(merged._nosession, undefined);
    assert.equal(merged.currentSession["proxy/gpt-5.5"].totalRequests, 1);
    assert.equal(merged.otherSession["anthropic/claude-opus-5"].totalRequests, 2);
  });
});

describe("serialized persistence and global protocols", () => {
  test("serialized runner preserves invocation order after a slow first operation", async () => {
    const run = internals.createSerializedAsyncRunner();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = run(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    const second = run(async () => {
      order.push("second");
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(order, ["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  });

  test("cache-hints uninstall restores an older service and preserves a newer one", () => {
    const older = { version: 1 as const, getHints: () => ({ promptCacheKey: "older" }) };
    const current = { version: 1 as const, getHints: () => ({ promptCacheKey: "current" }) };
    (globalThis as any)[internals.PI_CACHE_HINTS_SYMBOL] = older;

    const uninstall = internals.installCacheHintsService(current);
    assert.equal(internals.getCacheHintsService(), current);
    uninstall();
    assert.equal(internals.getCacheHintsService(), older);

    const replacement = { version: 1 as const, getHints: () => ({ promptCacheKey: "replacement" }) };
    const uninstallCurrent = internals.installCacheHintsService(current);
    (globalThis as any)[internals.PI_CACHE_HINTS_SYMBOL] = replacement;
    uninstallCurrent();
    assert.equal(internals.getCacheHintsService(), replacement);
  });

  test("routing registry parses and resolves valid snapshots without package imports", () => {
    delete (globalThis as any)[internals.PI_ROUTING_REGISTRY_SYMBOL];
    const registry = internals.ensureRoutingRegistry();
    const unregister = registry.registerRouter({
      virtualProvider: "router",
      resolveActiveRoute: (virtualModelId: string) => ({
        virtualProvider: "router",
        virtualModelId,
        provider: "proxy",
        modelId: "gpt-5.5",
        api: "openai-completions",
        timestamp: Date.now(),
      }),
    });

    const resolved = internals.resolveActiveRouteSnapshot(
      model({ provider: "router", id: "auto", name: "Auto", api: "router-api" }),
      { sessionManager: { getSessionId: () => "routing-session" } } as any,
    );
    assert.equal(resolved?.provider, "proxy");
    assert.equal(resolved?.modelId, "gpt-5.5");
    unregister();
    assert.equal(registry.getRouter("router"), undefined);
  });
});

describe("assistant response identity", () => {
  test("consolidates direct model-id drift only for the same provider and adapter", () => {
    const active = model({ provider: "glm-proxy", id: "zai-org/GLM-5.2-FP8", name: "GLM 5.2" });
    const drifted = model({ provider: "glm-proxy", id: "GLM5.2-FP8", name: "GLM5.2-FP8" });
    const consolidated = internals.consolidateDirectProviderStatsModel(drifted, active);
    assert.equal(consolidated?.id, active.id);

    const otherProvider = internals.consolidateDirectProviderStatsModel(
      model({ provider: "other", id: "GLM5.2-FP8", name: "GLM5.2-FP8" }),
      active,
    );
    assert.equal(otherProvider?.provider, "other");

    const differentAdapter = internals.consolidateDirectProviderStatsModel(
      model({ provider: "glm-proxy", id: "gpt-5.5", name: "GPT-5.5" }),
      active,
    );
    assert.equal(differentAdapter?.id, "gpt-5.5");
  });
});

describe("lifecycle persistence", () => {
  test("session_shutdown flushes a pending message_end update immediately", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-shutdown-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "runtime-contracts.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, Handler>();
      const commands = new Map<string, Command>();
      freshModule.default({
        on(name: string, handler: Handler) { handlers.set(name, handler); },
        registerCommand(name: string, command: Command) { commands.set(name, command); },
      } as any);

      const activeModel = model();
      const context = {
        model: activeModel,
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        sessionManager: { getSessionId: () => "shutdown-session" },
        ui: { notify() {}, setStatus() {}, confirm: async () => false, select: async () => undefined },
        hasUI: true,
      };
      await handlers.get("session_start")?.({ reason: "startup" }, context);
      await handlers.get("message_end")?.({
        message: {
          role: "assistant",
          provider: "proxy",
          model: "gpt-5.5",
          api: "openai-completions",
          stopReason: "stop",
          usage: { input: 100, cacheRead: 50, cacheWrite: 0 },
        },
      }, context);
      await handlers.get("session_shutdown")?.({ reason: "quit" }, context);

      const persisted = JSON.parse(
        await readFile(join(tempAgentDir, "pi-cache-optimizer-stats.json"), "utf8"),
      );
      assert.equal(persisted.totalsByModel["proxy/gpt-5.5"].totalRequests, 1);
      assert.equal(persisted.totalsByModel["proxy/gpt-5.5"].hitRequests, 1);
      assert.ok(commands.has("cache-optimizer"));
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});
