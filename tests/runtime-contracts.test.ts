import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

describe("v7 shard persistence and aggregation", () => {
  test("aggregates exact provider/model shards by session and totals", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-shards-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "runtime-contracts.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const I = freshModule.__internals_for_tests;
      const day = new Date();
      const dayText = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const globalEpoch = await I.readGlobalStatsEpoch();
      const openaiEpoch = await I.readModelStatsEpoch("proxy/gpt-5.5");
      const otherEpoch = await I.readModelStatsEpoch("other/gpt-5.5");
      const shardDir = I.SHARD_FILES_DIR;
      const makeShard = (instanceId: string, sessionHash: string, key: string, epoch: string, total: number, updatedAt = 2, modelName?: string) => {
        const [provider, ...idParts] = key.split("/");
        return {
          version: 7 as const,
          kind: "pi-cache-optimizer-shard" as const,
          instanceId,
          sessionHash,
          process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
          lifecycle: { state: "closed" as const, createdAt: 1, updatedAt, closedAt: updatedAt },
          day: dayText,
          globalEpoch,
          models: {
            [key]: {
              modelEpoch: epoch,
              provider,
              modelId: idParts.join("/"),
              ...(modelName ? { modelName } : {}),
              stats: {
                day: dayText,
                totalRequests: total,
                hitRequests: total,
                cachedInputTokens: total * 100,
                cacheWriteInputTokens: 0,
                totalInputTokens: total * 200,
              },
            },
          },
        };
      };
      await I.writeStatsShardV7(join(shardDir, "11111111-1111-4111-8111-111111111111.json"), makeShard("11111111-1111-4111-8111-111111111111", "session-a", "proxy/gpt-5.5", openaiEpoch, 2));
      await I.writeStatsShardV7(join(shardDir, "22222222-2222-4222-8222-222222222222.json"), makeShard("22222222-2222-4222-8222-222222222222", "session-b", "proxy/gpt-5.5", openaiEpoch, 3));
      await I.writeStatsShardV7(join(shardDir, "33333333-3333-4333-8333-333333333333.json"), makeShard("33333333-3333-4333-8333-333333333333", "session-b", "other/gpt-5.5", otherEpoch, 4));
      // A copied shard under another UUID filename is not another instance and
      // must not double-count the declared owner.
      await I.writeStatsShardV7(join(shardDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"), makeShard("11111111-1111-4111-8111-111111111111", "session-a", "proxy/gpt-5.5", openaiEpoch, 2));

      const aggregate = await I.loadStatsShardAggregateV7(shardDir);
      assert.equal(aggregate.bySession["session-a"]["proxy/gpt-5.5"].totalRequests, 2);
      assert.equal(aggregate.bySession["session-b"]["proxy/gpt-5.5"].totalRequests, 3);
      assert.equal(aggregate.totalsByModel["proxy/gpt-5.5"].totalRequests, 5);
      assert.equal(aggregate.totalsByModel["other/gpt-5.5"].totalRequests, 4);
      assert.equal(aggregate.sessionsByModel["proxy/gpt-5.5"], 2);
      assert.equal(aggregate.instancesByModel["proxy/gpt-5.5"], 2);
      assert.equal(aggregate.instancesBySessionModel["session-b"]["other/gpt-5.5"], 1);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("uses the newest shard metadata for an exact model key", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-model-ref-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "model-ref-test.ts"), { interopDefault: false, moduleCache: false });
      const fresh = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const I = fresh.__internals_for_tests;
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const key = "kimi-coding/k3";
      const globalEpoch = await I.readGlobalStatsEpoch();
      const modelEpoch = await I.readModelStatsEpoch(key);
      const makeShard = (instanceId: string, updatedAt: number, modelName?: string) => ({
        version: 7 as const,
        kind: "pi-cache-optimizer-shard" as const,
        instanceId,
        sessionHash: "same-session",
        process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
        lifecycle: { state: "closed" as const, createdAt: 1, updatedAt, closedAt: updatedAt },
        day,
        globalEpoch,
        models: {
          [key]: {
            modelEpoch,
            provider: "kimi-coding",
            modelId: "k3",
            ...(modelName ? { modelName } : {}),
            stats: { day, totalRequests: 1, hitRequests: 1, cachedInputTokens: 50, cacheWriteInputTokens: 0, totalInputTokens: 100 },
          },
        },
      });
      // Pass newest first: aggregate metadata must be timestamp-based, not
      // dependent on readdir/array iteration order.
      const aggregate = await I.aggregateStatsShardsV7([
        makeShard("88888888-8888-4888-8888-888888888888", 20, "Kimi K3"),
        makeShard("99999999-9999-4999-8999-999999999999", 10),
      ], day);
      assert.equal(aggregate.modelRefsByKey[key].name, "Kimi K3");
      assert.match(I.buildAllStatsOutput(aggregate), /Adapter: Kimi cache/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("independent extension instances create non-overwriting shards", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-multi-instance-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const createInstance = async (sessionId: string) => {
        const jiti = createJiti(join(process.cwd(), "tests", `${sessionId}.ts`), { interopDefault: false, moduleCache: false });
        const fresh = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
        const handlers = new Map<string, Handler>();
        fresh.default({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerCommand() {} } as any);
        const context = {
          model: model(), mode: "json",
          modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
          sessionManager: { getSessionId: () => sessionId },
          ui: { notify() {}, setStatus() {} }, hasUI: false,
        };
        await handlers.get("session_start")?.({ reason: "startup" }, context);
        await handlers.get("message_end")?.({ message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 50, cacheWrite: 0 } } }, context);
        await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
      };
      await Promise.all([createInstance("multi-a"), createInstance("multi-b")]);
      const shardDir = join(tempAgentDir, "pi-cache-optimizer-stats.d", "shards");
      const shardNames = (await readdir(shardDir)).filter((name) => name.endsWith(".json"));
      assert.equal(shardNames.length, 2);
      const shards = await Promise.all(shardNames.map(async (name) => JSON.parse(await readFile(join(shardDir, name), "utf8"))));
      assert.equal(new Set(shards.map((shard) => shard.instanceId)).size, 2);
      const freshJiti = createJiti(join(process.cwd(), "tests", "aggregate.ts"), { interopDefault: false, moduleCache: false });
      const fresh = await freshJiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const aggregate = await fresh.__internals_for_tests.loadStatsShardAggregateV7(shardDir);
      assert.equal(aggregate.totalsByModel["proxy/gpt-5.5"].totalRequests, 2);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("an external model reset is adopted before shutdown can rewrite stale counters", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-cross-process-reset-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "cross-process-reset-test.ts"), { interopDefault: false, moduleCache: false });
      const fresh = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, Handler>();
      fresh.default({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerCommand() {} } as any);
      const context = {
        model: model(), mode: "json",
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        sessionManager: { getSessionId: () => "cross-process-reset" },
        ui: { notify() {}, setStatus() {} }, hasUI: false,
      };
      await handlers.get("session_start")?.({ reason: "startup" }, context);
      await handlers.get("message_end")?.({ message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 50, cacheWrite: 0 } } }, context);
      await fresh.__internals_for_tests.advanceModelStatsEpoch("proxy/gpt-5.5");
      // Lifecycle refresh must clear the stale process-local bucket before the
      // final closed write, even when no new assistant message arrives.
      await handlers.get("agent_settled")?.({}, context);
      await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
      const shardDir = fresh.__internals_for_tests.SHARD_FILES_DIR;
      const shardName = (await readdir(shardDir)).find((name) => name.endsWith(".json"));
      assert.ok(shardName);
      const shard = JSON.parse(await readFile(join(shardDir, shardName), "utf8"));
      assert.equal(shard.models["proxy/gpt-5.5"], undefined);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("model reset epochs hide old shard counters", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-epoch-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "epoch-test.ts"), { interopDefault: false, moduleCache: false });
      const fresh = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const I = fresh.__internals_for_tests;
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const key = "proxy/gpt-5.5";
      const oldEpoch = await I.readModelStatsEpoch(key);
      await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, "77777777-7777-4777-8777-777777777777.json"), {
        version: 7, kind: "pi-cache-optimizer-shard", instanceId: "77777777-7777-4777-8777-777777777777",
        sessionHash: "epoch-session", process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
        lifecycle: { state: "closed", createdAt: 1, updatedAt: 2, closedAt: 2 }, day,
        globalEpoch: await I.readGlobalStatsEpoch(),
        models: { [key]: { modelEpoch: oldEpoch, provider: "proxy", modelId: "gpt-5.5", stats: { day, totalRequests: 2, hitRequests: 1, cachedInputTokens: 100, cacheWriteInputTokens: 0, totalInputTokens: 200 } } },
      });
      assert.equal((await I.loadStatsShardAggregateV7()).totalsByModel[key].totalRequests, 2);
      await I.advanceModelStatsEpoch(key);
      assert.equal((await I.loadStatsShardAggregateV7()).totalsByModel[key], undefined);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("cleanup removes old shards and retains current-day files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-shard-cleanup-test-"));
    try {
      const I = internals;
      const today = new Date();
      const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const oldShard = {
        version: 7 as const,
        kind: "pi-cache-optimizer-shard" as const,
        instanceId: "44444444-4444-4444-8444-444444444444",
        sessionHash: "old-session",
        process: { pid: 999_999, ppid: 1, instanceStartedAt: 1 },
        lifecycle: { state: "closed" as const, createdAt: 1, updatedAt: 1, closedAt: 1 },
        day: "2000-01-01",
        globalEpoch: "old-global",
        models: {},
      };
      const currentShard = { ...oldShard, instanceId: "55555555-5555-4555-8555-555555555555", sessionHash: "current", day: todayText, globalEpoch: "current" };
      await I.writeStatsShardV7(join(tempDir, "44444444-4444-4444-8444-444444444444.json"), oldShard);
      await I.writeStatsShardV7(join(tempDir, "55555555-5555-4555-8555-555555555555.json"), currentShard);
      await I.cleanupStatsShardsV7(Date.now(), tempDir);
      assert.deepEqual((await readdir(tempDir)).sort(), ["55555555-5555-4555-8555-555555555555.json"]);

      await writeFile(join(tempDir, "66666666-6666-4666-8666-666666666666.json"), "not-json\n");
      const parsed = await I.readValidStatsShardsV7(tempDir);
      assert.equal(parsed.length, 1);
      assert.ok((await readdir(tempDir)).includes("66666666-6666-4666-8666-666666666666.json"));

      if (process.platform !== "win32") {
        const outside = join(tempDir, "outside-target.json");
        const symlinkPath = join(tempDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json");
        await writeFile(outside, "outside\n");
        await symlink(outside, symlinkPath);
        await I.cleanupStatsShardsV7(Date.now() + 10 * 24 * 60 * 60 * 1000, tempDir);
        assert.equal(await readFile(outside, "utf8"), "outside\n");
        assert.ok((await readdir(tempDir)).includes("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"));
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("stats output separates current-session and all-session scopes", () => {
    const current = {
      "proxy/gpt-5.5": {
        day: "2026-08-20", totalRequests: 5, hitRequests: 4,
        cachedInputTokens: 660_000, cacheWriteInputTokens: 0, totalInputTokens: 839_000,
      },
      "anthropic/claude-opus-5": {
        day: "2026-08-20", totalRequests: 2, hitRequests: 1,
        cachedInputTokens: 100_000, cacheWriteInputTokens: 0, totalInputTokens: 200_000,
      },
    };
    const sessionOutput = internals.buildSessionStatsOutput(current, model());
    assert.match(sessionOutput, /Scope: current session/);
    assert.match(sessionOutput, /proxy\/gpt-5\.5/);
    assert.match(sessionOutput, /anthropic\/claude-opus-5/);
    assert.match(sessionOutput, /4\/5·0\.66M\/0\.84M 78\.7%/);

    const aggregate = {
      bySession: { current: current, other: { "proxy/gpt-5.5": stats(3, "2026-08-20") } },
      totalsByModel: current,
      instancesBySession: { current: 2, other: 1 },
      instancesBySessionModel: { current: { "proxy/gpt-5.5": 2, "anthropic/claude-opus-5": 1 }, other: { "proxy/gpt-5.5": 1 } },
      sessionsByModel: { "proxy/gpt-5.5": 2, "anthropic/claude-opus-5": 1 },
      instancesByModel: { "proxy/gpt-5.5": 2, "anthropic/claude-opus-5": 1 },
      lastRoutedModelBySession: {},
      modelRefsByKey: {
        "proxy/gpt-5.5": { provider: "proxy", id: "gpt-5.5", name: "GPT-5.5" },
        "anthropic/claude-opus-5": { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
      },
    };
    const allOutput = internals.buildAllStatsOutput(aggregate);
    assert.match(allOutput, /Scope: all local sessions/);
    assert.match(allOutput, /Sessions: 2 · Instances: 2/);
    assert.match(allOutput, /4\/5·0\.66M\/0\.84M 78\.7%/);
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

      const shardDir = join(tempAgentDir, "pi-cache-optimizer-stats.d", "shards");
      const shardNames = (await readdir(shardDir)).filter((name) => name.endsWith(".json"));
      assert.equal(shardNames.length, 1);
      const persisted = JSON.parse(await readFile(join(shardDir, shardNames[0]), "utf8"));
      assert.equal(persisted.version, 7);
      assert.equal(persisted.lifecycle.state, "closed");
      assert.equal(persisted.models["proxy/gpt-5.5"].stats.totalRequests, 1);
      assert.equal(persisted.models["proxy/gpt-5.5"].stats.hitRequests, 1);
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
