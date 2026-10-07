import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { derivePromptCacheKey } from "../src/request-payload.ts";

function model(id = "gpt-a", provider = "proxy", baseUrl = "https://example.invalid/v1") {
  return {
    provider, id, name: id, api: "openai-completions", baseUrl,
    compat: { sendSessionAffinityHeaders: false }, reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 8192,
  };
}

function virtualModel(id = "auto", provider = "router") {
  return { ...model(id, provider, ""), api: "pi-virtual" };
}

type Hook = (event: unknown, ctx: ExtensionContext) => unknown;

async function withExtension(run: (h: Awaited<ReturnType<typeof loadHarness>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-deep-review-"));
  const envNames = ["PI_CODING_AGENT_DIR", "PI_CACHE_RETENTION", "PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY", "PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY", "PI_CACHE_OPTIMIZER_FOOTER_MODE"];
  const saved = new Map(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  process.env.PI_CODING_AGENT_DIR = dir;
  let harness: Awaited<ReturnType<typeof loadHarness>> | undefined;
  try {
    harness = await loadHarness(dir);
    await run(harness);
  } finally {
    try { await harness?.close(); }
    finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function loadHarness(dir: string, sessionId = "fixture-review-session") {
  const jiti = createJiti(join(process.cwd(), "tests", "deep-review-regressions.test.ts"), { interopDefault: false, moduleCache: false });
  const loaded = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
  const hooks = new Map<string, Hook>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  loaded.default({
    on(name: string, handler: Hook) { hooks.set(name, handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, command); },
  } as unknown as ExtensionAPI);
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const catalog = new Map<string, ReturnType<typeof model>>();
  const ctx = {
    model: model(), mode: "json", hasUI: false,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    modelRegistry: {
      find: (provider: string, id: string) => catalog.get(`${provider}/${id}`),
      getAvailable: () => [...catalog.values()], getAll: () => [...catalog.values()],
    },
    ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  const hook = async (name: string, event: unknown = {}) => {
    const handler = hooks.get(name);
    assert.ok(handler, `Missing hook ${name}`);
    return handler(event, ctx as unknown as ExtensionContext);
  };
  const command = async (args: string) => {
    const registered = commands.get("cache-optimizer");
    assert.ok(registered);
    await registered.handler(args, ctx as unknown as ExtensionCommandContext);
  };
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await hook("session_shutdown"); } };
  await hook("session_start", { reason: "startup" });
  const persistedModels = async () => {
    await close();
    const shards = await loaded.__internals_for_tests.readValidStatsShardsV7();
    assert.equal(shards.length, 1);
    return shards[0].models;
  };
  return { dir, configPath: join(dir, "pi-cache-optimizer-config.json"), jiti, loaded, I: loaded.__internals_for_tests, ctx, catalog, notices, statuses, hook, command, close, persistedModels };
}

function assistant(provider: string, id: string, input = 100, responseModel?: string) {
  return { role: "assistant", provider, model: id, ...(responseModel ? { responseModel } : {}), api: "openai-completions", stopReason: "stop", usage: { input, output: 1, cacheRead: 0, cacheWrite: 0 } };
}

test("session footer retains yesterday across reload while daily commands stay daily", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
  await withExtension(async (h) => {
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    await h.close();
    t.mock.timers.setTime(new Date(2026, 8, 21, 12).getTime());
    const next = await loadHarness(h.dir);
    try {
      assert.match(next.statuses.at(-1) ?? "", /0\/1·/);
      await next.hook("message_end", { message: assistant("proxy", "gpt-a") });
      assert.match(next.statuses.at(-1) ?? "", /0\/2·/);
      await next.command("config footer-mode total");
      await next.command("stats all");
      assert.match(next.statuses.at(-1) ?? "", /0\/1·/);
      await next.command("config footer-mode session");
      assert.match(next.statuses.at(-1) ?? "", /0\/2·/);
      await next.close();
      const aggregate = await next.I.loadStatsShardAggregateV7();
      assert.equal(aggregate.totalsByModel["proxy/gpt-a"]?.totalRequests, 1);
    } finally { await next.close(); }
  });
});

for (const startingMode of ["session", "total", "process"]) test(`midnight rotates daily shards from ${startingMode} without losing session counters`, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
  await withExtension(async (h) => {
    await h.command(`config footer-mode ${startingMode}`);
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    t.mock.timers.setTime(new Date(2026, 8, 21, 12).getTime());
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    assert.match(h.statuses.at(-1) ?? "", startingMode === "session" ? /0\/2·/ : /0\/1·/);
    await h.command("config footer-mode total");
    assert.match(h.statuses.at(-1) ?? "", /0\/1·/);
    await h.command("config footer-mode process");
    assert.match(h.statuses.at(-1) ?? "", /0\/1·/);
    await h.command("config footer-mode session");
    assert.match(h.statuses.at(-1) ?? "", /0\/2·/);
    await h.close();
    const shards = await h.I.readValidStatsShardsV7();
    assert.equal(shards.length, 2);
    assert.deepEqual(shards.map((s) => s.models["proxy/gpt-a"].stats.totalRequests), [1, 1]);
    const next = await loadHarness(h.dir);
    try {
      assert.match(next.statuses.at(-1) ?? "", /0\/2·/);
      await next.command("reset");
      assert.match(next.statuses.at(-1) ?? "", /0\/0·/);
      await next.hook("message_end", { message: assistant("proxy", "gpt-a") });
      assert.match(next.statuses.at(-1) ?? "", /0\/1·/);
    } finally { await next.close(); }
  });
});

test("idle midnight shutdown preserves yesterday and does not attribute it to today or another session", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
  await withExtension(async (h) => {
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    t.mock.timers.setTime(new Date(2026, 8, 21, 12).getTime());
    await h.close();
    assert.equal((await h.I.loadStatsShardAggregateV7()).totalsByModel["proxy/gpt-a"], undefined);
    const other = await loadHarness(h.dir, "different-review-session");
    try { assert.match(other.statuses.at(-1) ?? "", /0\/0·/); }
    finally { await other.close(); }
    const next = await loadHarness(h.dir);
    try { assert.match(next.statuses.at(-1) ?? "", /0\/1·/); }
    finally { await next.close(); }
  });
});

test("failed midnight archive keeps session counters in memory and does not fail the hook", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
  await withExtension(async (h) => {
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    const shards = await h.I.readValidStatsShardsV7();
    const path = join(h.dir, "pi-cache-optimizer-stats.d", "shards", `${shards[0].instanceId}.json`);
    await rm(path);
    await mkdir(path); // A directory refuses atomic replacement on all platforms.
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      t.mock.timers.setTime(new Date(2026, 8, 21, 12).getTime());
      await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
      assert.match(h.statuses.at(-1) ?? "", /0\/2·/);
      await h.command("config footer-mode total");
      assert.match(h.statuses.at(-1) ?? "", /0\/1·/);
      assert.ok(h.notices.some((text) => /failed to persist/.test(text)));
    } finally { console.warn = warn; }
  });
});

test("config reset preserves the latest disk footer/key policies, file mode, and counters", async () => {
  await withExtension(async (h) => {
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    await writeFile(h.configPath, JSON.stringify({ version: 3, footerMode: "total", promptCacheKey: { omit: ["proxy/gpt-a"] }, features: { toolOrder: true } }));
    await chmod(h.configPath, 0o640);
    await h.command("config reset");
    assert.deepEqual(JSON.parse(await readFile(h.configPath, "utf8")), { version: 2, footerMode: "total", promptCacheKey: { omit: ["proxy/gpt-a"] } });
    if (process.platform !== "win32") assert.equal((await lstat(h.configPath)).mode & 0o777, 0o640);
    assert.equal(h.I.isPromptCacheKeyOmittedForModel(h.ctx.model), true);
    assert.equal(h.I.footerStatsMode(), "total");
    assert.equal((await h.persistedModels())["proxy/gpt-a"].stats.totalRequests, 1);
  });
});

for (const [label, text] of [["invalid JSON", "{incomplete"], ["invalid schema", '{"version":3,"footerMode":"invalid","features":{"toolOrder":true}}']]) {
  test(`config reset refuses ${label} without overwriting it`, async () => {
    await withExtension(async (h) => {
      await writeFile(h.configPath, text);
      await h.command("config reset");
      assert.equal(await readFile(h.configPath, "utf8"), text);
      assert.match(h.notices.at(-1) ?? "", /Could not reset/);
    });
  });
}

test("config reset refuses directory targets", async () => {
  await withExtension(async (h) => {
    await mkdir(h.configPath);
    await h.command("config reset");
    assert.equal((await lstat(h.configPath)).isDirectory(), true);
    assert.match(h.notices.at(-1) ?? "", /Could not reset/);
  });
});

test("config reset refuses symlinks without changing their targets", { skip: process.platform === "win32" }, async () => {
  await withExtension(async (h) => {
    const target = join(h.dir, "target.json");
    const text = '{"version":3,"features":{"toolOrder":true}}';
    await writeFile(target, text);
    await symlink(target, h.configPath);
    await h.command("config reset");
    assert.equal((await lstat(h.configPath)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), text);
    assert.match(h.notices.at(-1) ?? "", /Could not reset/);
  });
});

test("config reset works without an existing config and is idempotent", async () => {
  await withExtension(async (h) => {
    await h.command("config reset");
    const first = await readFile(h.configPath, "utf8");
    assert.deepEqual(JSON.parse(first), { version: 2 });
    await h.command("config reset");
    assert.equal(await readFile(h.configPath, "utf8"), first);
  });
});

test("config reset reads after acquiring the shared transaction lease", async () => {
  await withExtension(async (h) => {
    const atomic = await h.jiti.import<typeof import("../src/atomic-fs.ts")>(join(process.cwd(), "src", "atomic-fs.ts"));
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const writer = atomic.withModelsJsonTransactionLock(async () => {
      entered();
      await pending;
      await writeFile(h.configPath, JSON.stringify({ version: 3, footerMode: "process", promptCacheKey: { omit: ["proxy/gpt-a"] }, features: { skillCompression: false } }));
    });
    await ready;
    const resetting = h.command("config reset");
    release();
    await Promise.all([writer, resetting]);
    assert.deepEqual(JSON.parse(await readFile(h.configPath, "utf8")), { version: 2, footerMode: "process", promptCacheKey: { omit: ["proxy/gpt-a"] } });
    await Promise.all([h.I.writePersistedFeature("toolOrder", true), h.I.writePersistedFooterMode("total")]);
    assert.deepEqual(JSON.parse(await readFile(h.configPath, "utf8")), { version: 3, footerMode: "total", promptCacheKey: { omit: ["proxy/gpt-a"] }, features: { toolOrder: true } });
  });
});

test("feature updates refuse manual content/replacement/mode/existence races after the original read", async () => {
  await withExtension(async (h) => {
    const config = await h.jiti.import<typeof import("../src/config.ts")>(join(process.cwd(), "src", "config.ts"));
    const atomic = await h.jiti.import<typeof import("../src/atomic-fs.ts")>(join(process.cwd(), "src", "atomic-fs.ts"));
    const original = '{"version":3,"features":{"toolOrder":true}}';
    const changed = '{"version":3,"footerMode":"total","features":{"toolOrder":false}}';
    for (const kind of ["content", "replacement", "mode", "deleted", "created"]) {
      if (kind === "mode" && process.platform === "win32") continue;
      await rm(h.configPath, { force: true });
      let guard: import("../src/atomic-fs.ts").AtomicTargetGuard | null = null;
      if (kind !== "created") {
        await writeFile(h.configPath, original, { mode: 0o600 });
        const info = await lstat(h.configPath);
        guard = { identity: info, mode: info.mode & 0o7777, hash: atomic.hashText(original) };
      }
      if (kind === "content" || kind === "created") await writeFile(h.configPath, changed);
      else if (kind === "replacement") await atomic.atomicReplaceTextFilePreservingMode(h.configPath, original, 0o600, "fixture-replace");
      else if (kind === "mode") await chmod(h.configPath, 0o640);
      else await rm(h.configPath);
      await assert.rejects(config.writePersistedCacheOptimizerConfigUnlocked({ version: 2 }, h.configPath, guard));
      if (kind === "deleted") await assert.rejects(lstat(h.configPath), { code: "ENOENT" });
      else assert.equal(await readFile(h.configPath, "utf8"), kind === "content" || kind === "created" ? changed : original);
    }
  });
});

for (const value of [
  "https://fixture-user:FAKE_PASSWORD@example.invalid/v1?api_key=FAKE_TOKEN#FAKE_FRAGMENT",
  "https://fixture-user%40mail:FAKE_PASSWORD@example.invalid/v1?access_token=FAKE_TOKEN#FAKE_FRAGMENT",
  "https://[invalid:FAKE_PASSWORD@host/v1?api_key=FAKE_TOKEN#FAKE_FRAGMENT",
  "FAKE_PASSWORD:FAKE_TOKEN#FAKE_FRAGMENT",
]) {
  test(`doctor redacts endpoint authentication (${value.startsWith("https://[invalid") ? "malformed" : value.startsWith("https:") ? "URL" : "opaque"})`, async () => {
    await withExtension(async (h) => {
      h.ctx.model = model("gpt-a", "proxy", value);
      await h.command("doctor");
      const diagnosis = h.notices.at(-1) ?? "";
      assert.ok(diagnosis.includes("Base URL:"));
      for (const secret of ["fixture-user", "FAKE_PASSWORD", "FAKE_TOKEN", "FAKE_FRAGMENT"]) assert.equal(diagnosis.includes(secret), false);
      assert.equal(h.ctx.model.baseUrl, value);
      if (value.startsWith("https://fixture")) assert.match(diagnosis, /Base URL: https:\/\/example\.invalid\/v1/);
    });
  });
}

test("doctor preserves safe endpoints and distinguishes missing from invalid URLs", async () => {
  await withExtension(async (h) => {
    assert.match(h.I.buildDoctorDiagnosis(model()), /Base URL: https:\/\/example\.invalid\/v1/);
    assert.match(h.I.buildDoctorDiagnosis(model("gpt-a", "proxy", "")), /Base URL: \(default\)/);
    assert.match(h.I.buildDoctorDiagnosis(model("gpt-a", "proxy", "not a URL")), /Base URL: \(unavailable\)/);
  });
});

test("a same-provider same-family model switch cannot retarget response stats or the selected footer", async () => {
  await withExtension(async (h) => {
    const requested = h.ctx.model;
    await h.hook("before_provider_request", { payload: { model: requested.id } });
    h.ctx.model = model("gpt-b");
    await h.hook("model_select", { model: h.ctx.model });
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    assert.match(h.statuses.at(-1) ?? "", /0\/0/);
    const stored = await h.persistedModels();
    assert.deepEqual(Object.keys(stored), ["proxy/gpt-a"]);
    assert.equal(stored["proxy/gpt-a"].stats.totalRequests, 1);
    const reloaded = await loadHarness(h.dir);
    try {
      reloaded.ctx.model = model("gpt-b");
      await reloaded.hook("model_select", { model: reloaded.ctx.model });
      await reloaded.command("stats");
      assert.match(reloaded.notices.at(-1) ?? "", /proxy\/gpt-a/);
      assert.match(reloaded.statuses.at(-1) ?? "", /0\/0/);
    } finally { await reloaded.close(); }
  });
});

test("a late direct response cannot become the routed model after switching to a virtual selection", async () => {
  await withExtension(async (h) => {
    const requested = h.ctx.model;
    await h.hook("before_provider_request", { payload: { model: requested.id } });
    h.ctx.model = virtualModel();
    await h.hook("model_select", { model: h.ctx.model });
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    await h.close();
    const shards = await h.I.readValidStatsShardsV7();
    assert.equal(shards.length, 1);
    assert.equal(shards[0].models["proxy/gpt-a"]?.stats.totalRequests, 1);
    assert.equal(shards[0].lastRoutedModel, undefined);
  });
});

test("a late routed response cannot replace a direct model selected afterwards", async () => {
  await withExtension(async (h) => {
    const routed = model("gpt-a", "proxy");
    h.catalog.set("proxy/gpt-a", routed);
    h.ctx.model = virtualModel();
    await h.hook("before_provider_request", { payload: { model: "gpt-a" } });
    h.ctx.model = model("gpt-b", "proxy");
    await h.hook("model_select", { model: h.ctx.model });
    const before = h.statuses.at(-1);
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    assert.equal(h.statuses.at(-1), before);
    await h.close();
    const shards = await h.I.readValidStatsShardsV7();
    assert.equal(shards.length, 1);
    assert.equal(shards[0].models["proxy/gpt-a"]?.stats.totalRequests, 1);
    assert.deepEqual(shards[0].lastRoutedModel, { provider: "proxy", id: "gpt-a", name: "gpt-a" });
  });
});

test("catalog identity stays authoritative without a request hook or after a provider switch", async () => {
  await withExtension(async (h) => {
    h.ctx.model = model("gpt-b");
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    h.ctx.model = model("gpt-b", "other");
    await h.hook("message_end", { message: assistant("proxy", "gpt-a") });
    const stored = await h.persistedModels();
    assert.deepEqual(Object.keys(stored), ["proxy/gpt-a"]);
    assert.equal(stored["proxy/gpt-a"].stats.totalRequests, 2);
  });
});

test("catalog id beats a response alias and correlates concurrent same-family requests", async () => {
  await withExtension(async (h) => {
    h.catalog.set("proxy/gpt-a", model("gpt-a"));
    h.catalog.set("proxy/gpt-b", model("gpt-b"));
    await h.hook("before_provider_request", { payload: { model: "gpt-a" } });
    h.ctx.model = model("gpt-b");
    await h.hook("before_provider_request", { payload: { model: "gpt-b" } });
    await h.hook("message_end", { message: assistant("proxy", "gpt-a", 100, "gpt-b") });
    await h.hook("message_end", { message: assistant("proxy", "gpt-b", 200) });
    const stored = await h.persistedModels();
    assert.equal(stored["proxy/gpt-a"]?.stats.totalInputTokens, 100);
    assert.equal(stored["proxy/gpt-b"]?.stats.totalInputTokens, 200);
  });
});

test("legacy response aliases consolidate only against the request-local model, not a new selection", async () => {
  await withExtension(async (h) => {
    h.ctx.model = model("zai-org/GLM-5.2-FP8");
    await h.hook("before_provider_request", { payload: { model: h.ctx.model.id } });
    h.ctx.model = model("glm-new");
    await h.hook("message_end", { message: assistant("proxy", "GLM5.2-FP8") });
    const stored = await h.persistedModels();
    assert.deepEqual(Object.keys(stored), ["proxy/zai-org/GLM-5.2-FP8"]);
  });
});

test("unknown response aliases across concurrent requests never use the selected model as attribution evidence", async () => {
  await withExtension(async (h) => {
    h.ctx.model = model("glm-a");
    await h.hook("before_provider_request", { payload: { model: "glm-a" } });
    h.ctx.model = model("glm-b");
    await h.hook("before_provider_request", { payload: { model: "glm-b" } });
    await h.hook("message_end", { message: assistant("proxy", "glm-echoed-alias") });
    await h.hook("message_end", { message: assistant("proxy", "glm-b", 200) });
    const stored = await h.persistedModels();
    assert.equal(stored["proxy/glm-a"], undefined);
    assert.equal(stored["proxy/glm-echoed-alias"]?.stats.totalInputTokens, 100);
    assert.equal(stored["proxy/glm-b"]?.stats.totalInputTokens, 200);
  });
});

test("persistent cache-key on overrides both environment opt-outs in settings, diagnostics and requests", async () => {
  await withExtension(async (h) => {
    process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = "0";
    process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY = "1";
    await h.command("config openai-cache-key on");
    await h.command("config");
    assert.match(h.notices.at(-1) ?? "", /OpenAI cache key: on \(config\)/);
    assert.equal(h.I.shouldInjectOpenAIPromptCacheKey(), true);
    assert.match(h.I.getOptimizerRuntimeModeLines().join("\n"), /fallback: on/);
    const payload = await h.hook("before_provider_request", { payload: { model: "gpt-a" } });
    assert.equal((payload as Record<string, unknown>)?.prompt_cache_key, derivePromptCacheKey("fixture-review-session"));
    await h.command("disable");
    assert.equal(h.I.shouldInjectOpenAIPromptCacheKey(), false);
    assert.equal(await h.hook("before_provider_request", { payload: { model: "gpt-a" } }), undefined);
    await h.command("enable");
    await h.command("config openai-cache-key off");
    process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = "1";
    delete process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY;
    assert.equal(h.I.shouldInjectOpenAIPromptCacheKey(), false);
    assert.equal(await h.hook("before_provider_request", { payload: { model: "gpt-a" } }), undefined);
  });
});

test("legacy cache-key env-only opt-out agrees with config and runtime diagnostics", async () => {
  await withExtension(async (h) => {
    for (const value of ["0", "false", "no", "off", " OFF "]) {
      process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = value;
      await h.command("config");
      assert.match(h.notices.at(-1) ?? "", /OpenAI cache key: off \(env\)/);
      assert.equal(h.I.featureEnabled("openAICacheKey", "PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY", true), false);
      assert.equal(h.I.shouldInjectOpenAIPromptCacheKey(), false);
    }
    delete process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY;
    assert.equal(h.I.shouldInjectOpenAIPromptCacheKey(), true);
    process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY = "yes";
    assert.equal(h.I.shouldInjectOpenAIPromptCacheKey(), false);
    process.env.PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY = "1";
    assert.equal(h.I.shouldInjectOpenAIPromptCacheKey(), false);
  });
});

test("cleanup expires corrupt JSON/schema shards but protects young, current-day and live shards", async () => {
  await withExtension(async (h) => {
    const dir = join(h.dir, "cleanup-fixtures");
    await mkdir(dir);
    const now = Date.now();
    const old = new Date(now - 61 * 86400_000);
    const young = new Date(now - 3600_000);
    const put = async (text: string, date = old, name = `${randomUUID()}.json`) => {
      const path = join(dir, name);
      await writeFile(path, text);
      await utimes(path, date, date);
      return name;
    };
    const shard = {
      version: 7, kind: "pi-cache-optimizer-shard", instanceId: randomUUID(), sessionHash: "fixture-hash",
      process: { pid: process.pid, ppid: process.ppid, instanceStartedAt: 1 },
      lifecycle: { state: "closed", createdAt: 1, updatedAt: old.getTime(), closedAt: old.getTime() },
      day: "2000-01-01", globalEpoch: "fixture-epoch", models: {},
    };
    const corruptOld = await put("{incomplete");
    const invalidOld = await put(JSON.stringify({ ...shard, models: null }));
    const closedOld = await put(JSON.stringify(shard));
    const corruptYoung = await put("{incomplete", young);
    const current = await put(JSON.stringify({ ...shard, day: h.I.emptyCacheStats().day }));
    const live = await put(JSON.stringify({ ...shard, lifecycle: { ...shard.lifecycle, state: "active" } }));
    const unrelated = await put("{incomplete", old, "unrelated.json");
    const removed = await h.I.cleanupStatsShardsV7(now, dir);
    assert.equal(removed, 3);
    const names = await readdir(dir);
    for (const name of [corruptOld, invalidOld, closedOld]) assert.equal(names.includes(name), false);
    for (const name of [corruptYoung, current, live, unrelated]) assert.equal(names.includes(name), true);
  });
});

test("cleanup never follows or deletes corrupt shard symlinks", { skip: process.platform === "win32" }, async () => {
  await withExtension(async (h) => {
    const dir = join(h.dir, "cleanup-links");
    await mkdir(dir);
    const target = join(h.dir, "outside-target.json");
    await writeFile(target, "{incomplete");
    const link = join(dir, `${randomUUID()}.json`);
    await symlink(target, link);
    assert.equal(await h.I.cleanupStatsShardsV7(Date.now() + 10 * 86400_000, dir), 0);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), "{incomplete");
  });
});
