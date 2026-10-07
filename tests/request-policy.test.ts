import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createJiti } from "jiti";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import extension, { __internals_for_tests as internals } from "#extension";
import { derivePromptCacheKey, withAnthropicCacheTtlRepair, withoutPromptCacheRetention } from "../src/request-payload.ts";
import { decidePromptCacheRetention, userRequestedLongCacheRetention } from "../src/retention.ts";
import { clearStatsShardReadCache, readValidStatsShardsV7, writeStatsShardV7 } from "../src/stats-store.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;
type Handler = (event: any, context: any) => unknown;

const originalRuntime = internals.isRuntimeOptimizerEnabled();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  internals.setRuntimeOptimizerEnabled(originalRuntime);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function model(overrides: Partial<PiModel> = {}): PiModel {
  return {
    provider: "policy-proxy",
    id: "policy-model",
    name: "Policy model",
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

function requestHook(): Handler {
  const handlers = new Map<string, Handler>();
  extension({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerCommand() {} } as any);
  const hook = handlers.get("before_provider_request");
  assert.ok(hook);
  return hook;
}

function context(requestModel: PiModel) {
  return {
    model: requestModel,
    sessionManager: { getSessionId: () => "policy-session" },
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    ui: { notify() {}, setStatus() {} },
  };
}

describe("prompt_cache_retention gate", () => {
  test("decision order: rejection > official > explicit opt-in > user env > unverified", () => {
    const base = { providerRejected: false, officialOpenAI: false, explicitOptIn: false, userRequestedLong: false };
    assert.deepEqual(decidePromptCacheRetention(base), { keep: false, reason: "unverified-endpoint" });
    assert.deepEqual(decidePromptCacheRetention({ ...base, userRequestedLong: true }), { keep: true, reason: "user-requested-long" });
    assert.deepEqual(decidePromptCacheRetention({ ...base, explicitOptIn: true }), { keep: true, reason: "explicit-opt-in" });
    assert.deepEqual(decidePromptCacheRetention({ ...base, officialOpenAI: true }), { keep: true, reason: "official-openai" });
    assert.deepEqual(
      decidePromptCacheRetention({ providerRejected: true, officialOpenAI: true, explicitOptIn: true, userRequestedLong: true }),
      { keep: false, reason: "provider-rejected" },
    );
  });

  test("only a pre-existing PI_CACHE_RETENTION=long counts as the user's own request", () => {
    assert.equal(userRequestedLongCacheRetention({ wasSet: true, value: "long" }), true);
    assert.equal(userRequestedLongCacheRetention({ wasSet: true, value: "short" }), false);
    assert.equal(userRequestedLongCacheRetention({ wasSet: false }), false);
  });

  test("strips the optimizer-injected field on unverified endpoints without mutating Pi's payload", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-policy-"));
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      internals.setRuntimeOptimizerEnabled(true);
      const payload = { messages: [], prompt_cache_retention: "24h" };
      const result = requestHook()({ payload }, context(model())) as Record<string, unknown>;
      assert.equal("prompt_cache_retention" in result, false);
      assert.equal(payload.prompt_cache_retention, "24h");
    } finally {
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("keeps the field when the runtime model compat explicitly opts in", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-policy-"));
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      internals.setRuntimeOptimizerEnabled(true);
      const payload = { messages: [], prompt_cache_retention: "24h" };
      const optedIn = model({ compat: { supportsLongCacheRetention: true } as any });
      const result = (requestHook()({ payload }, context(optedIn)) ?? payload) as Record<string, unknown>;
      assert.equal(result.prompt_cache_retention, "24h");
    } finally {
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("an explicit models.json false beats a runtime true", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-policy-"));
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(join(tempAgentDir, "models.json"), JSON.stringify({
        providers: { "policy-proxy": { modelOverrides: { "policy-model": { compat: { supportsLongCacheRetention: false } } } } },
      }));
      // MODELS_JSON_PATH is resolved at module load, so load a fresh copy.
      const jiti = createJiti(join(process.cwd(), "tests", "request-policy.test.ts"), { interopDefault: false, moduleCache: false });
      const fresh = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, Handler>();
      fresh.default({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerCommand() {} } as any);
      const hook = handlers.get("before_provider_request");
      assert.ok(hook);
      const payload = { messages: [], prompt_cache_retention: "24h" };
      const optedIn = model({ compat: { supportsLongCacheRetention: true } as any });
      const result = hook({ payload }, context(optedIn)) as Record<string, unknown>;
      assert.equal("prompt_cache_retention" in result, false);
    } finally {
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("withoutPromptCacheRetention returns a copy or undefined", () => {
    const payload = { a: 1, prompt_cache_retention: "24h" };
    assert.deepEqual(withoutPromptCacheRetention(payload), { a: 1 });
    assert.equal(payload.prompt_cache_retention, "24h");
    assert.equal(withoutPromptCacheRetention({ a: 1 }), undefined);
  });
});

describe("session identifiers sent upstream", () => {
  test("derivePromptCacheKey is stable, opaque, and within OpenAI's 64-character limit", () => {
    const key = derivePromptCacheKey("  019a-session-id  ");
    assert.equal(key, derivePromptCacheKey("019a-session-id"));
    assert.match(key ?? "", /^pi-[0-9a-f]{32}$/);
    assert.ok((key ?? "").length <= 64);
    assert.equal(key?.includes("019a-session-id"), false);
    assert.notEqual(key, derivePromptCacheKey("another-session"));
    assert.equal(derivePromptCacheKey("   "), undefined);
    assert.equal(derivePromptCacheKey(undefined), undefined);
  });

  test("the injected prompt_cache_key never carries the raw session id", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-policy-"));
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      internals.setRuntimeOptimizerEnabled(true);
      const result = requestHook()({ payload: { messages: [] } }, context(model())) as Record<string, unknown>;
      assert.equal(result.prompt_cache_key, derivePromptCacheKey("policy-session"));
      assert.notEqual(result.prompt_cache_key, "policy-session");
    } finally {
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("Anthropic TTL repair", () => {
  test("repairs a copy and leaves the original payload untouched", () => {
    const payload = {
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "u", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
    };
    const repaired = withAnthropicCacheTtlRepair(payload, false) as typeof payload;
    assert.ok(repaired);
    assert.equal((repaired.messages[0].content[0].cache_control as Record<string, unknown>).ttl, undefined);
    assert.equal(payload.messages[0].content[0].cache_control.ttl, "1h");
  });

  test("returns undefined when the payload is already valid", () => {
    const valid = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }] };
    assert.equal(withAnthropicCacheTtlRepair(valid, false), undefined);
    assert.ok(withAnthropicCacheTtlRepair(valid, true), "known-rejecting models downgrade every 1h breakpoint");
  });
});

describe("stats shard reads", () => {
  test("re-reads a shard after it is replaced and forgets deleted shards", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cache-shards-"));
    try {
      clearStatsShardReadCache();
      const instanceId = "0f0e0d0c-0b0a-4908-8706-050403020100";
      const now = Date.now();
      const shard = (requests: number) => ({
        version: 7,
        kind: "pi-cache-optimizer-shard",
        instanceId,
        sessionHash: "_nosession",
        process: { pid: process.pid, ppid: process.ppid, instanceStartedAt: now },
        lifecycle: { state: "active", createdAt: now, updatedAt: now },
        day: "2026-10-07",
        globalEpoch: "global-test",
        models: {
          "policy-proxy/policy-model": {
            modelEpoch: "model-test",
            provider: "policy-proxy",
            modelId: "policy-model",
            stats: { day: "2026-10-07", totalRequests: requests, hitRequests: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 0 },
          },
        },
      }) as any;
      const path = join(dir, `${instanceId}.json`);
      await writeStatsShardV7(path, shard(1));
      const first = await readValidStatsShardsV7(dir);
      assert.equal(first.length, 1);
      assert.equal(Object.values(first[0].models)[0]?.stats.totalRequests, 1);
      await writeStatsShardV7(path, shard(2));
      const second = await readValidStatsShardsV7(dir);
      assert.equal(Object.values(second[0].models)[0]?.stats.totalRequests, 2);
      await rm(path);
      assert.deepEqual(await readValidStatsShardsV7(dir), []);
      assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
    } finally {
      clearStatsShardReadCache();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
