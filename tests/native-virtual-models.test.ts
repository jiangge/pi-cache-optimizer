import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Pi 0.99+ native virtual models keep ctx.model virtual (api "pi-virtual")
// while Pi dispatches each request to a physical model. These tests pin how
// the extension resolves that physical model for request hooks, footer stats,
// and diagnostics.

const OPTIMIZER_ENV = [
  "PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY",
  "PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY",
  "PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE",
  "PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE",
  "PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION",
  "PI_CACHE_OPTIMIZER_TOOL_ORDER",
  "PI_CACHE_OPTIMIZER_FOOTER_MODE",
  "PI_CACHE_RETENTION",
];

let agentDir: string;
let previousAgentDir: string | undefined;
const previousOptimizerEnv = new Map<string, string | undefined>();
let extension: typeof import("../index.ts");
let jiti: ReturnType<typeof createJiti>;
let t: (typeof import("../index.ts"))["__internals_for_tests"];

before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-cache-native-virtual-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const name of OPTIMIZER_ENV) {
    previousOptimizerEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  // The extension config is read at module load; create the omit rule first.
  await writeFile(
    join(agentDir, "pi-cache-optimizer-config.json"),
    JSON.stringify({ version: 2, promptCacheKey: { omit: ["strict-proxy/omit-model"] } }),
  );
  jiti = createJiti(join(process.cwd(), "tests", "native-virtual-models.test.ts"), {
    interopDefault: false,
    moduleCache: false,
  });
  extension = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
  t = extension.__internals_for_tests;
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const [name, value] of previousOptimizerEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(agentDir, { recursive: true, force: true });
});

type TestModel = {
  provider: string;
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  compat?: Record<string, unknown>;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

function physical(provider: string, id: string, overrides: Partial<TestModel> = {}): TestModel {
  return {
    provider,
    id,
    name: id,
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

function virtualModel(provider = "jev", id = "auto", name = "Auto"): TestModel {
  return { ...physical(provider, id), name, api: "pi-virtual", baseUrl: "", compat: undefined };
}

function assistantEntry(provider: string, model: string, api: string, extra: Record<string, unknown> = {}) {
  return { type: "message", message: { role: "assistant", provider, model, api, stopReason: "stop", ...extra } };
}

function context(
  model: TestModel,
  options: { branch?: unknown[]; available?: TestModel[]; all?: TestModel[]; sessionId?: string } = {},
  ui: { statuses?: Array<string | undefined>; notifications?: string[] } = {},
) {
  const available = options.available ?? [];
  const all = options.all ?? available;
  return {
    model,
    hasUI: true,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "native-virtual-session",
      getBranch: () => options.branch ?? [],
    },
    modelRegistry: {
      find: (provider: string, id: string) => all.find((candidate) => candidate.provider === provider && candidate.id === id),
      getAvailable: () => available,
      getAll: () => all,
    },
    ui: {
      notify: (text: string) => ui.notifications?.push(text),
      setStatus: (_key: string, text: string | undefined) => ui.statuses?.push(text),
    },
  } as any;
}

function setup() {
  const hooks = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  extension.default({
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      hooks.set(name, handler);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any);
  return { hooks, commands };
}

describe("native virtual model contracts", () => {
  test("installed Pi marks native virtual models with the pi-virtual API", async () => {
    const piVirtual = await jiti.import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/virtual-models.js")>(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "virtual-models.js"),
    );
    assert.equal(t.PI_VIRTUAL_MODEL_API, piVirtual.VIRTUAL_MODEL_API);
    const created = piVirtual.createVirtualModel({ provider: "jev", id: "auto", name: "Auto" });
    assert.equal(piVirtual.isVirtualModel(created), true);
    assert.equal(t.isNativeVirtualModel(created), true);
    assert.equal(t.isNativeVirtualModel(physical("proxy", "kimi-k3")), false);

    const piRuntimeModule = await jiti.import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js")>(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "model-runtime.js"),
    );
    const runtimeDir = await mkdtemp(join(tmpdir(), "pi-cache-native-virtual-runtime-"));
    try {
      await writeFile(join(runtimeDir, "models.json"), JSON.stringify({ providers: {} }));
      const runtime = await piRuntimeModule.ModelRuntime.create({
        modelsPath: join(runtimeDir, "models.json"),
        authPath: join(runtimeDir, "auth.json"),
        modelsStorePath: join(runtimeDir, "models-store.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      runtime.registerVirtualModel({ provider: "jev", id: "auto", name: "Auto", route: () => { throw new Error("not routed in this test"); } });
      const registered = runtime.getModel("jev", "auto");
      assert.ok(registered);
      assert.equal(t.isNativeVirtualModel(registered), true);
      assert.equal(t.isVirtualRoutingModel(registered as any), true);
    } finally {
      // ModelRuntime may still be persisting its store file asynchronously.
      await rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("branch resolution follows the latest physical response like Pi", () => {
    const branch = [
      assistantEntry("old-proxy", "glm-5.2", "openai-completions"),
      assistantEntry("jev", "auto", "pi-virtual", { stopReason: "error" }),
      { type: "model_change", provider: "jev", modelId: "auto" },
      assistantEntry("proxy", "kimi-k3", "openai-completions", { responseModel: "kimi-k3-0930" }),
      assistantEntry("fallback-proxy", "deepseek-v4-pro", "openai-completions", { stopReason: "error" }),
    ];
    const dispatches = t.findNativeVirtualDispatches(context(virtualModel(), { branch }));
    // The catalog id in `message.model` wins over the echoed responseModel.
    assert.deepEqual(dispatches.latestSuccessful, { provider: "proxy", id: "kimi-k3", api: "openai-completions" });
    assert.deepEqual(dispatches.latestAny, { provider: "fallback-proxy", id: "deepseek-v4-pro", api: "openai-completions" });

    const kimi = physical("proxy", "kimi-k3", { name: "Kimi K3" });
    const routed = t.resolveNativeVirtualRouteModel(virtualModel() as any, context(virtualModel(), { branch, all: [kimi] }));
    assert.equal(routed?.name, "Kimi K3");
    assert.equal(routed?.baseUrl, "https://proxy.example/v1");
    assert.equal(t.resolveRouteModel(virtualModel() as any, context(virtualModel(), { branch, all: [kimi] }))?.id, "kimi-k3");

    // Physical selections and hosts without getBranch() keep legacy behavior.
    assert.equal(t.resolveNativeVirtualRouteModel(kimi as any, context(kimi, { branch })), undefined);
    assert.equal(t.resolveNativeVirtualRouteModel(virtualModel() as any, { sessionManager: { getSessionId: () => "s" } } as any), undefined);
  });

  test("request resolution matches the dispatched payload id and fails closed on conflicting providers", () => {
    const kimi = physical("proxy", "kimi-k3");
    const openai = physical("openai", "gpt-6.1-sol", { api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
    const codex = physical("openai-codex", "gpt-6.1-sol", { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" });
    const zen = physical("opencode", "deepseek-v4-pro", { baseUrl: "https://opencode.example/zen/v1" });
    const go = physical("opencode-go", "deepseek-v4-pro", { baseUrl: "https://opencode.example/zen/v1" });
    const policy = (candidate: any) => JSON.stringify([candidate.api, candidate.baseUrl]);
    const selected = virtualModel();
    const branch = [assistantEntry("proxy", "kimi-k3", "openai-completions")];
    const resolve = (payload: unknown, available: TestModel[], all = available) =>
      t.resolveNativeVirtualRequestModel(selected as any, payload, context(selected, { branch, available, all }), policy);

    assert.deepEqual(
      [resolve({ model: "kimi-k3" }, [kimi, openai])?.model.provider, resolve({ model: "kimi-k3" }, [kimi])?.identityAmbiguous],
      ["proxy", false],
    );
    // A router switch to another credentialed model is recognized from the payload.
    assert.equal(resolve({ model: "gpt-6.1-sol" }, [kimi, openai])?.model.provider, "openai");
    // A shared id with identical request treatment resolves but stays ambiguous.
    assert.deepEqual(
      [resolve({ model: "deepseek-v4-pro" }, [zen, go])?.model.id, resolve({ model: "deepseek-v4-pro" }, [zen, go])?.identityAmbiguous],
      ["deepseek-v4-pro", true],
    );
    // Providers with different request treatment are never guessed.
    assert.equal(resolve({ model: "gpt-6.1-sol" }, [openai, codex]), undefined);
    // Without a credentialed match, the sticky branch candidate is used.
    assert.deepEqual(
      [resolve({ model: "kimi-k3" }, [], [kimi])?.model.provider, resolve({ model: "kimi-k3" }, [], [kimi])?.identityAmbiguous],
      ["proxy", false],
    );
    assert.equal(resolve({ model: "unknown" }, [kimi]), undefined);
    assert.equal(resolve({ messages: [] }, [kimi]), undefined);
    assert.equal(t.getProviderPayloadModelId({ modelId: "anthropic.claude-sonnet-5-5" }), "anthropic.claude-sonnet-5-5");
    assert.equal(t.resolveNativeVirtualRequestModel(kimi as any, { model: "kimi-k3" }, context(kimi, { available: [kimi] }), policy), undefined);
  });
});

describe("native virtual model hooks", () => {
  test("native virtual prompt rewrite requires an explicit safe candidate chain", async () => {
    const { hooks } = setup();
    const selected = virtualModel("router", "auto");
    const registry = Symbol.for("pi.routing.registry.v1");
    const previous = (globalThis as any)[registry];
    const install = (api: string) => {
      (globalThis as any)[registry] = {
        version: 1,
        registerRouter() { return () => {}; },
        getRouter() {
          return {
            virtualProvider: "router",
            resolveActiveRoute() { return undefined; },
            resolveCandidateRoutes() {
              return [{ virtualProvider: "router", virtualModelId: "auto", provider: "proxy", modelId: "kimi-k3", api, timestamp: 1 }];
            },
          };
        },
      };
    };
    const event = {
      systemPrompt: [
        "stable project instructions",
        "<session-overview>",
        "## RECENT COMMITS",
        "abc123 changed something",
        "</session-overview>",
      ].join("\n"),
      systemPromptOptions: { cwd: "/tmp", contextFiles: [], skills: [] },
    };
    try {
      process.env.PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE = "1";
      const proxy = physical("proxy", "kimi-k3", { api: "openai-completions" });
      install("openai-completions");
      const allowed = await hooks.get("before_agent_start")!(event, context(selected, { all: [proxy] })) as any;
      assert.equal(typeof allowed?.systemPrompt, "string");

      install("openai-responses");
      const responses = physical("proxy", "kimi-k3", { api: "openai-responses" });
      const blockedResponses = await hooks.get("before_agent_start")!(event, context(selected, { all: [responses] }));
      assert.deepEqual(blockedResponses, {});

      install("openai-codex-responses");
      const codex = physical("proxy", "kimi-k3", { api: "openai-codex-responses" });
      const blockedCodex = await hooks.get("before_agent_start")!(event, context(selected, { all: [codex] }));
      assert.deepEqual(blockedCodex, {});
    } finally {
      delete process.env.PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE;
      if (previous === undefined) delete (globalThis as any)[registry];
      else (globalThis as any)[registry] = previous;
    }
  });

  test("native virtual prompt rewrite fails closed for unsafe or malformed candidate chains", async () => {
    const { hooks } = setup();
    const selected = virtualModel("router", "auto");
    const registry = Symbol.for("pi.routing.registry.v1");
    const previous = (globalThis as any)[registry];
    const event = { systemPrompt: "stable project instructions", systemPromptOptions: { cwd: "/tmp", contextFiles: [], skills: [] } };
    const proxy = physical("proxy", "kimi-k3", { api: "openai-completions" });
    const variants = [
      () => undefined,
      () => [{ provider: "proxy", modelId: "kimi-k3", timestamp: 1 }],
      () => [{ provider: "proxy", modelId: "kimi-k3", api: "openai-completions", timestamp: 1 }, { provider: "proxy", modelId: "fallback", api: "openai-codex-responses", timestamp: 2 }],
    ];
    try {
      process.env.PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE = "1";
      for (const resolveCandidateRoutes of variants) {
        (globalThis as any)[registry] = {
          version: 1,
          getRouter() {
            return { virtualProvider: "router", resolveCandidateRoutes };
          },
        };
        const result = await hooks.get("before_agent_start")!(event, context(selected, { all: [proxy] }));
        assert.deepEqual(result, {});
      }
      (globalThis as any)[registry] = {
        version: 1,
        getRouter() {
          return { virtualProvider: "router", resolveCandidateRoutes() { throw new Error("route unavailable"); } };
        },
      };
      assert.deepEqual(await hooks.get("before_agent_start")!(event, context(selected, { all: [proxy] })), {});
    } finally {
      delete process.env.PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE;
      if (previous === undefined) delete (globalThis as any)[registry];
      else (globalThis as any)[registry] = previous;
    }
  });

  test("native virtual prompt rewrite fails closed without candidate route metadata", async () => {
    const { hooks } = setup();
    const selected = virtualModel("unregistered", "auto");
    process.env.PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE = "1";
    try {
      const result = await hooks.get("before_agent_start")!({
        systemPrompt: "stable project instructions",
        systemPromptOptions: { cwd: "/tmp", contextFiles: [], skills: [] },
      }, context(selected));
      assert.deepEqual(result, {});
    } finally {
      delete process.env.PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE;
    }
  });

  test("native virtual requests fail closed instead of reusing stale branch routing", async () => {
    const { hooks } = setup();
    const selected = virtualModel();
    const previous = physical("openai", "shared-model", { api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
    const direct = physical("anthropic", "shared-model", { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" });
    const branch = [assistantEntry(previous.provider, previous.id, previous.api)];
    const result = await hooks.get("before_provider_request")!({
      payload: { model: direct.id, input: [], prompt_cache_retention: "24h" },
    }, context(selected, { branch, available: [previous, direct], all: [previous, direct] }));

    assert.equal((result as any)?.prompt_cache_retention, undefined);
    assert.equal((result as any)?.prompt_cache_key, undefined);
  });

  test("pi-router-style mirror models do not make a native physical match ambiguous", async () => {
    const { hooks } = setup();
    const selected = virtualModel();
    const physicalModel = physical("fakeproxy", "kimi-k3");
    const routerMirror = physical("router", "kimi-k3", { api: "pi-router", baseUrl: "https://router.internal" });
    const resolved = t.resolveNativeVirtualRequestModel(
      selected as any,
      { model: "kimi-k3" },
      context(selected, { available: [physicalModel, routerMirror], all: [physicalModel, routerMirror] }),
      (candidate: any) => JSON.stringify([candidate.api, candidate.baseUrl]),
    );
    assert.equal(resolved?.model.provider, "fakeproxy");
    assert.equal(resolved?.identityAmbiguous, false);

    const payload = { model: "kimi-k3", messages: [], prompt_cache_key: "pi-key" };
    const result = await hooks.get("before_provider_request")!({ payload }, context(selected, { available: [physicalModel, routerMirror], all: [physicalModel, routerMirror] }));
    assert.equal(result, undefined);
    assert.equal(payload.prompt_cache_key, "pi-key");
  });

  test("native virtual UX does not consult a pi-router registry adapter", async () => {
    const { commands } = setup();
    const notifications: string[] = [];
    const selected = virtualModel("router", "auto", "Auto");
    const physicalModel = physical("fakeproxy", "kimi-k3", { name: "Kimi K3" });
    const registry = Symbol.for("pi.routing.registry.v1");
    const previous = (globalThis as any)[registry];
    (globalThis as any)[registry] = {
      version: 1,
      registerRouter() { return () => {}; },
      getRouter() {
        return {
          virtualProvider: "router",
          resolveActiveRoute() { return { virtualProvider: "router", virtualModelId: "auto", provider: "fakeproxy", modelId: "kimi-k3", timestamp: Date.now() }; },
        };
      },
    };
    try {
      await commands.get("cache-optimizer")!.handler("doctor", context(selected, {
        branch: [],
        all: [physicalModel],
      }, { notifications }));
      assert.match(notifications.at(-1) ?? "", /none has answered on this session branch yet/);
      assert.doesNotMatch(notifications.at(-1) ?? "", /Provider: fakeproxy/);
    } finally {
      if (previous === undefined) delete (globalThis as any)[registry];
      else (globalThis as any)[registry] = previous;
    }
  });

  test("request hook applies the routed physical model's request policy", async () => {
    const { hooks } = setup();
    const selected = virtualModel();
    const proxy = physical("proxy", "kimi-k3");
    const openai = physical("openai", "gpt-6.1-sol", { api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
    const codex = physical("openai-codex", "gpt-6.1-sol", { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" });
    const claude = physical("anthropic", "claude-sonnet-5.5", { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" });
    const omitted = physical("strict-proxy", "omit-model");
    const send = async (payload: any, available: TestModel[]) => {
      const result = await hooks.get("before_provider_request")!({ payload }, context(selected, { available }));
      return result ?? payload;
    };

    const toProxy = await send({ model: "kimi-k3", messages: [], prompt_cache_retention: "24h" }, [proxy]);
    assert.equal(toProxy.prompt_cache_key, "native-virtual-session");
    assert.equal(toProxy.prompt_cache_retention, undefined);

    const toOpenAI = await send({ model: "gpt-6.1-sol", input: [], prompt_cache_retention: "24h", prompt_cache_key: "pi-key" }, [openai]);
    assert.equal(toOpenAI.prompt_cache_retention, "24h");
    assert.equal(toOpenAI.prompt_cache_key, "pi-key");

    const toClaude = await send({
      model: "claude-sonnet-5.5",
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "u", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
    }, [claude]);
    assert.equal(toClaude.messages[0].content[0].cache_control.ttl, undefined);

    const toOmitted = await send({ model: "omit-model", messages: [], prompt_cache_key: "pi-key" }, [omitted]);
    assert.equal("prompt_cache_key" in toOmitted, false);

    // A shared id across providers with different policies fails closed.
    const ambiguous = await send({ model: "gpt-6.1-sol", input: [], prompt_cache_retention: "24h" }, [openai, codex]);
    assert.equal(ambiguous.prompt_cache_retention, undefined);
    assert.equal(ambiguous.prompt_cache_key, undefined);
  });

  test("session-affinity header bridge fails closed for native virtual selections", async () => {
    const modelsPath = join(agentDir, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { proxy: { compat: { sendSessionAffinityHeaders: true } } } }));
    try {
      const { hooks } = setup();
      const proxy = physical("proxy", "kimi-k3");
      const direct: Record<string, string> = {};
      await hooks.get("before_provider_headers")!({ headers: direct }, context(proxy));
      assert.ok(direct["x-session-affinity"], "direct physical selection is bridged");

      const routed: Record<string, string> = {};
      const branch = [assistantEntry("proxy", "kimi-k3", "openai-completions")];
      await hooks.get("before_provider_headers")!({ headers: routed }, context(virtualModel(), { branch, all: [proxy] }));
      assert.deepEqual(routed, {});
    } finally {
      await rm(modelsPath, { force: true });
    }
  });

  test("footer and stats follow the physical model a virtual selection routed to", async () => {
    const { hooks, commands } = setup();
    const statuses: Array<string | undefined> = [];
    const notifications: string[] = [];
    const kimi = physical("proxy", "kimi-k3", { name: "Kimi K3" });
    const selected = virtualModel();
    const message = {
      role: "assistant",
      provider: "proxy",
      model: "kimi-k3",
      api: "openai-completions",
      stopReason: "stop",
      usage: { input: 200, output: 10, cacheRead: 800, cacheWrite: 0, totalTokens: 1010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const options = { sessionId: "footer-session", all: [kimi], available: [kimi] };
    const startCtx = context(selected, options, { statuses, notifications });
    const routedCtx = context(selected, { ...options, branch: [{ type: "message", message }] }, { statuses, notifications });

    await hooks.get("session_start")!({ reason: "startup" }, startCtx);
    await hooks.get("message_end")!({ message }, routedCtx);
    const routedStatus = statuses.at(-1);
    assert.match(routedStatus ?? "", /^· Kimi cache 1\/1·/);

    // Later lifecycle refreshes resolve the same physical model instead of
    // clearing the footer for the virtual selection.
    await hooks.get("agent_settled")!({}, routedCtx);
    assert.equal(statuses.at(-1), routedStatus);

    await commands.get("cache-optimizer")!.handler("stats", routedCtx);
    assert.ok(notifications.at(-1)?.includes("proxy/kimi-k3"));
    assert.ok(!notifications.at(-1)?.includes("jev/auto"));
    await hooks.get("session_shutdown")!({}, routedCtx);

    // After /reload, a fresh instance has no cached footer text; it must
    // resolve the routed physical model from the session branch alone.
    const reloaded = setup();
    const reloadStatuses: Array<string | undefined> = [];
    const reloadCtx = context(selected, { ...options, branch: [{ type: "message", message }] }, { statuses: reloadStatuses });
    await reloaded.hooks.get("session_start")!({ reason: "reload" }, reloadCtx);
    assert.match(reloadStatuses.at(-1) ?? "", /^· Kimi cache 1\/1·/);
    await reloaded.hooks.get("session_shutdown")!({}, reloadCtx);
  });

  test("an unrouted native virtual selection never keys stats by its virtual id", async () => {
    const { hooks, commands } = setup();
    const statuses: Array<string | undefined> = [];
    const notifications: string[] = [];
    // The display name contains an adapter token; the selection still has no
    // physical cache identity until Pi routes a request.
    const selected = virtualModel("jev", "deepseek-auto", "DeepSeek Auto");
    const ctx = context(selected, { sessionId: "unrouted-session" }, { statuses, notifications });

    await hooks.get("agent_settled")!({}, ctx);
    assert.deepEqual(statuses.filter((status) => status !== undefined), []);

    await commands.get("cache-optimizer")!.handler("compat", ctx);
    assert.match(notifications.at(-1) ?? "", /Native virtual model: Pi routes each request/);
  });

  test("doctor and compat name the virtual selection and its routed physical model", async () => {
    const { commands } = setup();
    const notifications: string[] = [];
    const kimi = physical("proxy", "kimi-k3", { name: "Kimi K3" });
    const branch = [assistantEntry("proxy", "kimi-k3", "openai-completions")];
    const ctx = context(virtualModel(), { branch, all: [kimi], sessionId: "doctor-session" }, { notifications });

    await commands.get("cache-optimizer")!.handler("doctor", ctx);
    assert.match(notifications.at(-1) ?? "", /Native virtual model jev\/auto → latest routed physical model proxy\/kimi-k3/);
    assert.match(notifications.at(-1) ?? "", /Provider: proxy/);

    await commands.get("cache-optimizer")!.handler("compat", ctx);
    assert.match(notifications.at(-1) ?? "", /^🔀 Native virtual model jev\/auto/);
  });

  test("native virtual selections keep Pi's system prompt unchanged", async () => {
    const { hooks } = setup();
    const systemPrompt = [
      "You are a coding assistant.",
      "<session-overview>",
      "Branch: main",
      "## RECENT COMMITS",
      "abc123 changed something",
      "## PATHS",
      "Tasks: .trellis/tasks/",
      "</session-overview>",
    ].join("\n");
    const event = { systemPrompt, systemPromptOptions: { cwd: "/tmp", contextFiles: [], skills: [] } };
    const proxy = physical("proxy", "kimi-k3");

    const direct = await hooks.get("before_agent_start")!(event, context(proxy)) as { systemPrompt?: string };
    assert.ok(direct.systemPrompt && !direct.systemPrompt.includes("RECENT COMMITS"), "physical selection is optimized");

    const routed = await hooks.get("before_agent_start")!(event, context(virtualModel(), { branch: [assistantEntry("proxy", "kimi-k3", "openai-completions")], all: [proxy] }));
    assert.deepEqual(routed, {});
  });


  test("every API gets in-place edits only and Pi's section order is never changed", async () => {
    const { hooks } = setup();
    const sourceInfo = { path: "", source: "local", scope: "user", origin: "top-level" };
    const skills = ["alpha", "beta", "gamma", "delta"].map((name) => ({
      name, description: `${name} skill description`, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, sourceInfo, disableModelInvocation: false,
    }));
    const agents = "Project rules that are long enough to be lifted as a stable prefix candidate by the reorder step.";
    const systemPrompt = [
      "You are a coding assistant.",
      "<project_context>",
      `<project_instructions path="/repo/AGENTS.md">\n${agents}\n</project_instructions>`,
      "</project_context>",
      "",
      `<skills>\n${t.formatSkillsForPrompt(skills as any).trim()}\n</skills>`,
      "",
      "<session-overview>",
      "Branch: main",
      "## RECENT COMMITS",
      "abc123 changed something",
      "## PATHS",
      "Tasks: .trellis/tasks/",
      "</session-overview>",
    ].join("\n");
    const event = { systemPrompt, systemPromptOptions: { cwd: "/repo", contextFiles: [{ path: "/repo/AGENTS.md", content: agents }], skills } };

    for (const codex of [
      physical("openai-codex", "gpt-6-luna", { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }),
      physical("openai", "gpt-6", { api: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
    ]) {
      const result = await hooks.get("before_agent_start")!(event, context(codex)) as { systemPrompt?: string };
      const out = result.systemPrompt ?? "";
      assert.ok(out.startsWith("You are a coding assistant.\n<project_context>"), `${codex.api}: section order kept`);
      assert.ok(out.includes(`<project_instructions path="/repo/AGENTS.md">\n${agents}`), `${codex.api}: AGENTS.md stays in its section`);
      assert.ok(!out.includes("<available_skills>") && out.includes("- alpha: alpha skill description"), `${codex.api}: skills compressed`);
      assert.ok(!out.includes("RECENT COMMITS"), `${codex.api}: churn stripped`);
    }

    // Chat Completions models get the identical in-place treatment: nothing is lifted out of its section.
    const completions = await hooks.get("before_agent_start")!(event, context(physical("proxy", "kimi-k3"))) as { systemPrompt?: string };
    const out = completions.systemPrompt ?? "";
    assert.ok(out.startsWith("You are a coding assistant.\n<project_context>"), "completions: section order kept");
    assert.ok(out.includes(`<project_instructions path="/repo/AGENTS.md">\n${agents}`), "completions: AGENTS.md stays in its section");
    assert.ok(!out.includes("<available_skills>") && out.includes("- alpha: alpha skill description"), "completions: skills compressed");
    assert.ok(!out.includes("RECENT COMMITS"), "completions: churn stripped");
    assert.ok(!/<skills>\n\s*\n<\/skills>/.test(out), "completions: no empty section shells");
  });

  describe("skill compression as a section edit", () => {
    const sourceInfo = { path: "", source: "local", scope: "user", origin: "top-level" };
    const skills = ["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => ({
      name, description: `${name} skill\n description`, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, sourceInfo, disableModelInvocation: false,
    }));
    const loadPi = async () => createJiti(join(process.cwd(), "tests", "pi-system-prompt-test.ts"), { interopDefault: false, moduleCache: false }).import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js")>(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "system-prompt.js"),
    );
    /** Mimics ExtensionRunner.emitBeforeAgentStart: options are mutable and `systemPrompt` re-renders from them. */
    const piEvent = (pi: Awaited<ReturnType<typeof loadPi>>, extra: Record<string, unknown> = {}) => {
      const options = pi.normalizeBuildSystemPromptOptions({ cwd: "/repo", skills, selectedTools: ["read", "bash"], ...extra } as any);
      return { options, event: { type: "before_agent_start", prompt: "hi", get systemPrompt() { return pi.buildSystemPrompt(options); }, systemPromptOptions: options } };
    };

    test("edits sections.skills, keeps Pi's order and wrapper, and returns no forced prompt", async () => {
      const pi = await loadPi();
      const { hooks } = setup();
      const { options, event } = piEvent(pi);
      const before = event.systemPrompt;
      const result = await hooks.get("before_agent_start")!(event, context(physical("proxy", "kimi-k3")));
      assert.deepEqual(result, {}, "no forced prompt: Pi renders the edited section itself");
      assert.equal(typeof options.sections.skills, "string");
      const after = event.systemPrompt;
      assert.ok(!after.includes("<available_skills>") && after.length < before.length);
      assert.match(after, /<skills>\nThe following skills provide[\s\S]*- alpha: alpha skill description[\s\S]*<\/skills>/);
      // Section order is Pi's: skills still sits between the docs and the cwd.
      assert.ok(after.indexOf("<docs>") < after.indexOf("<skills>") && after.indexOf("<skills>") < after.indexOf("<cwd>"));
      assert.equal(pi.buildSystemPromptSections(options as any).skills, `<skills>\n${options.sections.skills}\n</skills>`);
    });

    test("a handler that runs later still sees, and can edit, the sections", async () => {
      const pi = await loadPi();
      const { hooks } = setup();
      const { options, event } = piEvent(pi);
      await hooks.get("before_agent_start")!(event, context(physical("proxy", "kimi-k3")));
      options.sections.extra = "from a later extension";
      assert.match(event.systemPrompt, /<extra>\nfrom a later extension\n<\/extra>/);
      assert.ok(event.systemPrompt.includes("- alpha: alpha skill description"), "earlier compression survives later section edits");
    });

    test("falls back to the string substitution after a forced prompt or without sections support", async () => {
      const pi = await loadPi();
      const { hooks } = setup();

      const forced = piEvent(pi);
      forced.options.forceSystemPrompt = pi.buildSystemPrompt(forced.options); // an earlier handler already forced the prompt
      const forcedResult = await hooks.get("before_agent_start")!(forced.event, context(physical("proxy", "kimi-k3"))) as { systemPrompt?: string };
      assert.equal(forced.options.sections.skills, undefined, "sections are ignored once forced");
      assert.ok(forcedResult.systemPrompt && !forcedResult.systemPrompt.includes("<available_skills>"));
      assert.ok(forcedResult.systemPrompt.includes("- alpha: alpha skill description"));

      // Pre-0.86 shape: no `sections`, prompt supplied as a string.
      const legacyPrompt = `base${t.formatSkillsForPrompt(skills as any)}\n\nCurrent working directory: /repo`;
      const legacy = { systemPrompt: legacyPrompt, systemPromptOptions: { cwd: "/repo", contextFiles: [], skills } };
      const legacyResult = await hooks.get("before_agent_start")!(legacy, context(physical("proxy", "kimi-k3"))) as { systemPrompt?: string };
      assert.ok(legacyResult.systemPrompt?.includes("- alpha: alpha skill description"));
      assert.ok(!legacyResult.systemPrompt?.includes("<available_skills>"));
    });

    test("an opt-out leaves sections untouched", async () => {
      const pi = await loadPi();
      const { hooks } = setup();
      const previous = process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION;
      process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION = "1";
      try {
        const { options, event } = piEvent(pi);
        const before = event.systemPrompt;
        assert.deepEqual(await hooks.get("before_agent_start")!(event, context(physical("proxy", "kimi-k3"))), {});
        assert.equal(options.sections.skills, undefined);
        assert.equal(event.systemPrompt, before);
      } finally {
        if (previous === undefined) delete process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION;
        else process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION = previous;
      }
    });
  });

  test("nested codemode tool calls do not refresh the footer on their own", async () => {
    const { hooks } = setup();
    const statuses: Array<string | undefined> = [];
    const ctx = context(physical("proxy", "kimi-k3", { name: "Kimi K3" }), { sessionId: "nested-session" }, { statuses });

    await hooks.get("tool_execution_end")!({ toolCallId: "nested", toolName: "read", parentToolCallId: "codemode-1", isError: false }, ctx);
    assert.equal(statuses.length, 0);

    await hooks.get("tool_execution_end")!({ toolCallId: "codemode-1", toolName: "codemode", isError: false }, ctx);
    assert.equal(statuses.length, 1);
    assert.match(statuses[0] ?? "", /^· Kimi cache 0\/0/);
  });

  test("provider request lifecycle records stay bounded", () => {
    const states = [
      { id: "pending-1", responseReceived: false },
      { id: "warm-done", responseReceived: true },
      { id: "pending-2", responseReceived: false },
      { id: "done", responseReceived: true },
    ];
    t.pruneProviderRequestStates(states, 2);
    assert.deepEqual(states.map((state) => state.id), ["pending-1", "pending-2"]);

    const pending = [{ id: "a", responseReceived: false }, { id: "b", responseReceived: false }];
    t.pruneProviderRequestStates(pending, 1);
    assert.deepEqual(pending.map((state) => state.id), ["b"]);
  });
});
