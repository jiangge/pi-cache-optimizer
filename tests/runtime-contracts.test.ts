import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { __internals_for_tests as internals } from "#extension";
import { derivePromptCacheKey } from "../src/request-payload.ts";

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
  test("bridges provider-level session-affinity compat dropped from extension models", () => {
    const extensionModel = model({
      provider: "Opencode-Go",
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      compat: {},
    });
    const effective = internals.resolveEffectiveCompatFromConfig(extensionModel, {
      providers: {
        "Opencode-Go": {
          compat: { sendSessionAffinityHeaders: true },
        },
      },
    });
    const headers: Record<string, string | null | undefined> = {};

    assert.equal(
      internals.addEffectiveSessionAffinityHeaders(headers, extensionModel, "session-123", effective, true, "provider"),
      true,
    );
    assert.deepEqual(headers, {
      session_id: derivePromptCacheKey("session-123"),
      "x-client-request-id": derivePromptCacheKey("session-123"),
      "x-session-affinity": derivePromptCacheKey("session-123"),
    });
    assert.deepEqual(internals.describeMissingOpenAICompatibleProxyCompat({ ...extensionModel, compat: effective }), []);
    assert.equal(internals.buildFixSuggestion({ ...extensionModel, compat: effective }), undefined);
  });

  test("preserves explicit false, existing headers, and OpenRouter header format", () => {
    const extensionModel = model({ provider: "router-proxy", id: "gpt-5.5", compat: {} });
    const existing: Record<string, string | null | undefined> = {
      "X-Client-Request-Id": "provider-value",
    };
    assert.equal(
      internals.addEffectiveSessionAffinityHeaders(
        existing,
        extensionModel,
        "session-123",
        { sendSessionAffinityHeaders: true },
        true,
        "provider",
      ),
      true,
    );
    assert.deepEqual(existing, {
      "X-Client-Request-Id": "provider-value",
      session_id: derivePromptCacheKey("session-123"),
      "x-session-affinity": derivePromptCacheKey("session-123"),
    });

    const openRouterHeaders: Record<string, string | null | undefined> = {};
    assert.equal(
      internals.addEffectiveSessionAffinityHeaders(
        openRouterHeaders,
        model({ provider: "openrouter-custom", baseUrl: "https://openrouter.ai/api/v1", compat: {} }),
        "session-456",
        { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
        true,
        "provider",
      ),
      true,
    );
    assert.deepEqual(openRouterHeaders, { "x-session-id": derivePromptCacheKey("session-456") });

    for (const [candidate, compat, enabled, sessionId] of [
      [extensionModel, { sendSessionAffinityHeaders: false }, true, "session-123"],
      [model({ baseUrl: "https://api.openai.com/v1", compat: {} }), { sendSessionAffinityHeaders: true }, true, "session-123"],
      [model({ api: "openai-responses", compat: {} }), { sendSessionAffinityHeaders: true }, true, "session-123"],
      [model({ api: "kiro-api", compat: {} }), { sendSessionAffinityHeaders: true }, true, "session-123"],
      [extensionModel, { sendSessionAffinityHeaders: true }, false, "session-123"],
      [extensionModel, { sendSessionAffinityHeaders: true }, true, ""],
      [model({ compat: { sendSessionAffinityHeaders: true } }), { sendSessionAffinityHeaders: true }, true, "session-123"],
      [model({ compat: { sendSessionAffinityHeaders: false } }), { sendSessionAffinityHeaders: true }, true, "session-123"],
    ] as const) {
      const headers: Record<string, string | null | undefined> = {};
      assert.equal(
        internals.addEffectiveSessionAffinityHeaders(
          headers,
          candidate,
          sessionId,
          compat,
          enabled,
          (candidate.compat as { sendSessionAffinityHeaders?: boolean } | undefined)?.sendSessionAffinityHeaders !== undefined
            ? "runtime"
            : "provider",
        ),
        false,
      );
      assert.deepEqual(headers, {});
    }
  });

  test("route fallback does not inherit compat across provider/model identity changes", () => {
    const snapshot = {
      virtualProvider: "router",
      virtualModelId: "smart",
      provider: "upstream-proxy",
      modelId: "gpt-5.5",
      api: "openai-completions",
      timestamp: Date.now(),
    };
    const routed = internals.routeSnapshotToPiModel(snapshot as any, model({
      provider: "router",
      id: "smart",
      compat: { sendSessionAffinityHeaders: false },
    }));
    assert.equal(routed.provider, "upstream-proxy");
    assert.equal(routed.id, "gpt-5.5");
    assert.equal(routed.compat, undefined);
  });

  test("schema validation agrees with installed Pi for reviewed edge cases", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-schema-parity-test-"));
    try {
      const piRuntimeModule = await createJiti(join(process.cwd(), "tests", "pi-schema-test.ts"), { interopDefault: false, moduleCache: false }).import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js")>(
        join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "model-config.js"),
      );
      for (const [name, config] of Object.entries({
        invalidThinkingLevel: {
          providers: {
            proxy: {
              compat: { sendSessionAffinityHeaders: true },
              models: [{ id: "gpt-5.5", thinkingLevelMap: { high: 4 } }],
            },
          },
        },
        validExtraOverrideCostKey: {
          providers: {
            proxy: {
              compat: { sendSessionAffinityHeaders: true },
              modelOverrides: { "gpt-5.5": { cost: { input: 1, extra: 2 } } },
            },
          },
        },
      })) {
        const modelsPath = join(tempAgentDir, `${name}.json`);
        await writeFile(modelsPath, JSON.stringify(config));
        const piConfig = await piRuntimeModule.ModelConfig.load(modelsPath);
        assert.equal(
          internals.isValidModelsConfigForEffectiveCompat(config),
          (piConfig as unknown as { error?: string }).error === undefined,
          name,
        );
      }
    } finally {
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("installed Pi built-in llama.cpp models match the untouched fingerprint exemption", async () => {
    // Hermetic agent dir: a developer's real models.json must not change the
    // effective compat seen by the fingerprint.
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-llama-fingerprint-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "llama-fingerprint-test.ts"), { interopDefault: false, moduleCache: false });
      const fresh = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const llamaModule = await jiti.import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/llama/provider.js")>(
        join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "extensions", "llama", "provider.js"),
      );
      const t = fresh.__internals_for_tests;
      const controller = llamaModule.createLlamaProvider();
      controller.setCatalog([{ id: "qwen-local", status: { value: "loaded" }, meta: { n_ctx: 32_768 } }], llamaModule.DEFAULT_LLAMA_SERVER_URL);
      const [builtIn] = controller.provider.getModels();
      assert.ok(builtIn);
      assert.equal(builtIn.provider, "llama.cpp");
      assert.equal(builtIn.api, "openai-completions");

      // The real provider shape from the installed Pi is exempt from generic
      // proxy routing/session-affinity advice, even on a non-official base URL.
      assert.equal(t.isPiBuiltInLlamaCppModel(builtIn), true);
      assert.deepEqual(t.describeMissingOpenAICompatibleProxyCompat(builtIn), []);

      // Pi 0.82.x reported supportsUsageInStreaming: false; Pi 0.83+ reports
      // true. Streaming usage is not routing configuration, so both host
      // shapes inside the supported peer range must stay recognized.
      for (const supportsUsageInStreaming of [false, true]) {
        assert.equal(
          t.isPiBuiltInLlamaCppModel({ ...builtIn, compat: { ...builtIn.compat, supportsUsageInStreaming } }),
          true,
          `supportsUsageInStreaming: ${supportsUsageInStreaming}`,
        );
      }

      // Same-id providers with routing/cache overrides or a different
      // transport fingerprint remain ordinary OpenAI-compatible channels.
      for (const [name, compat] of Object.entries({
        sessionAffinity: { sendSessionAffinityHeaders: true },
        sessionAffinityFormat: { sessionAffinityFormat: "openai" },
        longRetention: { supportsLongCacheRetention: true },
        developerRole: { supportsDeveloperRole: true },
      })) {
        assert.equal(t.isPiBuiltInLlamaCppModel({ ...builtIn, compat: { ...builtIn.compat, ...compat } } as PiModel), false, name);
      }
      assert.deepEqual(
        t.describeMissingOpenAICompatibleProxyCompat({ ...builtIn, compat: { ...builtIn.compat, supportsDeveloperRole: true } }),
        ["sendSessionAffinityHeaders"],
      );
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("skill compression anchors on the installed Pi skills formatter", async () => {
    // compressSkillsInSystemPrompt only substitutes an exact copy of Pi's
    // verbose skills block. Drift would silently disable compression.
    const piSkills = await createJiti(join(process.cwd(), "tests", "skills-format-test.ts"), { interopDefault: false, moduleCache: false }).import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js")>(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "skills.js"),
    );
    const sourceInfo = { path: "/skills/alpha/SKILL.md", source: "local", scope: "user", origin: "top-level" };
    const skills = [
      { name: "alpha", description: "Alpha <xml> & \"quotes\"", filePath: "/skills/alpha/SKILL.md", baseDir: "/skills/alpha", sourceInfo, disableModelInvocation: false },
      { name: "beta", description: "Beta", filePath: "/project/.pi/skills/beta/SKILL.md", baseDir: "/project/.pi/skills/beta", sourceInfo, disableModelInvocation: false },
      { name: "hidden", description: "Hidden", filePath: "/skills/hidden/SKILL.md", baseDir: "/skills/hidden", sourceInfo, disableModelInvocation: true },
    ] as any;
    assert.equal(internals.formatSkillsForPrompt(skills), piSkills.formatSkillsForPrompt(skills));
    assert.equal(internals.formatSkillsForPrompt(skills, "bash"), piSkills.formatSkillsForPrompt(skills, "bash"));
  });

  describe("skill compression on Pi's real system prompt", () => {
    const sourceInfo = { path: "", source: "local", scope: "user", origin: "top-level" };
    const skill = (name: string, description: string, filePath: string, disableModelInvocation = false) =>
      ({ name, description, filePath, baseDir: filePath, sourceInfo, disableModelInvocation }) as any;
    const skills = [
      skill("zeta", "Zeta does things.\n  Use when zeta.", "/home/u/.agents/skills/zeta/SKILL.md"),
      skill("alpha", "Alpha with <xml> & \"quotes\" and $& replacement tokens", "/home/u/.agents/skills/alpha/SKILL.md"),
      skill("beta", "Beta project skill", "/work/.pi/skills/beta/SKILL.md"),
      skill("odd", "Directory name differs from skill name", "/home/u/.agents/skills/other-dir/SKILL.md"),
      skill("win", "Windows style path", "C:\\Users\\u\\skills\\win\\SKILL.md"),
      skill("hidden", "Must never be listed", "/home/u/.agents/skills/hidden/SKILL.md", true),
    ];
    const loadPiPrompt = async () => {
      const mod = await createJiti(join(process.cwd(), "tests", "system-prompt-test.ts"), { interopDefault: false, moduleCache: false }).import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js")>(
        join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "system-prompt.js"),
      );
      return (selectedTools: string[]) => mod.buildSystemPrompt({ cwd: "/work", selectedTools, skills, contextFiles: [] } as any);
    };

    test("fires on the prompt Pi actually assembles, keeping every name and description", async () => {
      const build = await loadPiPrompt();
      const prompt = build(["read", "bash"]);
      assert.ok(prompt.includes("<available_skills>"), "Pi should emit the verbose block");
      const out = internals.compressSkillsInSystemPrompt(prompt, { skills } as any);
      assert.notEqual(out, prompt, "compression must fire against Pi's real output");
      assert.ok(out.length < prompt.length);
      assert.ok(!out.includes("<available_skills>"));
      assert.match(out, /<skills>\nThe following skills provide specialized instructions/);
      assert.match(out, /<\/skills>/);
      for (const s of skills.filter((entry: any) => !entry.disableModelInvocation)) {
        assert.ok(out.includes(s.name), `${s.name} listed`);
        assert.ok(out.includes(s.description.replace(/\s+/g, " ").trim()), `${s.name} description kept verbatim`);
      }
      assert.ok(!out.includes("Must never be listed"));
    });

    test("states each root once and gives explicit paths where the convention does not hold", async () => {
      const build = await loadPiPrompt();
      const out = internals.compressSkillsInSystemPrompt(build(["read"]), { skills } as any);
      assert.equal(out.split("## Skills in /home/u/.agents/skills/").length, 2);
      assert.ok(out.includes("Each skill file is at /home/u/.agents/skills/<name>/SKILL.md"));
      assert.ok(out.includes("## Skills in /work/.pi/skills/"));
      assert.ok(out.includes("- odd (file: /home/u/.agents/skills/other-dir/SKILL.md): Directory name differs"));
      assert.ok(out.includes("- win (file: C:\\Users\\u\\skills\\win\\SKILL.md): Windows style path"));
      // Conventional skills must not repeat their path.
      assert.ok(!out.includes("/home/u/.agents/skills/alpha/SKILL.md"));
      // Dollar patterns in descriptions must not be interpreted as replacement tokens.
      assert.ok(out.includes("$& replacement tokens"));
    });

    test("is deterministic, idempotent and independent of skill order", async () => {
      const build = await loadPiPrompt();
      const prompt = build(["read"]);
      const once = internals.compressSkillsInSystemPrompt(prompt, { skills } as any);
      assert.equal(internals.compressSkillsInSystemPrompt(once, { skills } as any), once);
      const reversed = [...skills].reverse();
      assert.equal(internals.formatSkillsForPromptCompressed(reversed), internals.formatSkillsForPromptCompressed(skills));
    });

    test("also matches the pre-0.86 layout where the block was appended with leading newlines", () => {
      const legacy = `base prompt${internals.formatSkillsForPrompt(skills)}\n\nCurrent working directory: /work`;
      const out = internals.compressSkillsInSystemPrompt(legacy, { skills } as any);
      assert.notEqual(out, legacy);
      assert.ok(out.startsWith("base prompt\n\nThe following skills"));
      assert.ok(out.endsWith("\n\nCurrent working directory: /work"));
    });

    test("no-ops below the minimum count, when Pi's text differs, and when opted out", async () => {
      const build = await loadPiPrompt();
      const prompt = build(["read"]);
      assert.equal(internals.compressSkillsInSystemPrompt(prompt, { skills: skills.slice(0, 2) } as any), prompt);
      // `bash`-only tool sets make Pi say "Use bash to load…"; compression must recognise that wording too.
      const bashOnly = build(["bash"]);
      const bashOut = internals.compressSkillsInSystemPrompt(bashOnly, { skills, selectedTools: ["bash"] } as any);
      assert.ok(!bashOut.includes("<available_skills>"), "bash-only prompt is compressed");
      assert.ok(bashOut.includes("Use bash to load a skill's file when the task matches its description."), "Pi's bash wording is kept");
      const previous = process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION;
      process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION = "1";
      try {
        assert.equal(internals.compressSkillsInSystemPrompt(prompt, { skills } as any), prompt);
      } finally {
        if (previous === undefined) delete process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION;
        else process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION = previous;
      }
    });
  });

  test("installed Pi registerProvider drops lower provider compat for extension-owned models", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-extension-provider-model-test-"));
    try {
      const modelsPath = join(tempAgentDir, "models.json");
      await writeFile(modelsPath, JSON.stringify({
        providers: {
          "Opencode-Go": {
            compat: { sendSessionAffinityHeaders: true },
          },
        },
      }));
      const piRuntimeModule = await createJiti(join(process.cwd(), "tests", "pi-runtime-test.ts"), { interopDefault: false, moduleCache: false }).import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js")>(
        join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "model-runtime.js"),
      );
      const runtime = await piRuntimeModule.ModelRuntime.create({
        modelsPath,
        authPath: join(tempAgentDir, "auth.json"),
        modelsStorePath: join(tempAgentDir, "models-store.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      runtime.registerProvider("Opencode-Go", {
        name: "Opencode Go",
        baseUrl: "https://proxy.example/v1",
        apiKey: "test-only-placeholder",
        api: "openai-completions",
        models: [{
          id: "mimo-v2.5",
          name: "MiMo V2.5",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        }],
      });
      const registered = runtime.getModel("Opencode-Go", "mimo-v2.5");
      assert.ok(registered);
      assert.equal((registered.compat as { sendSessionAffinityHeaders?: boolean } | undefined)?.sendSessionAffinityHeaders, undefined);
      assert.equal(
        internals.resolveEffectiveCompatFromConfig(registered as PiModel, JSON.parse(await readFile(modelsPath, "utf8"))).sendSessionAffinityHeaders,
        true,
      );
    } finally {
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("extension hook honors provider-level affinity and explicit modelOverride false", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-affinity-hook-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "affinity-hook-test.ts"), { interopDefault: false, moduleCache: false });
      const fresh = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, Handler>();
      fresh.default({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerCommand() {} } as any);
      const requestHeaders = handlers.get("before_provider_headers");
      assert.ok(requestHeaders);
      const runtimeModel = model({ provider: "Opencode-Go", id: "mimo-v2.5", name: "MiMo V2.5", compat: {} });
      const notifications: string[] = [];
      const statuses: Array<string | undefined> = [];
      const context = {
        model: runtimeModel,
        sessionManager: { getSessionId: () => "hook-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify(message: string) { notifications.push(message); },
          setStatus(_key: string, value: string | undefined) { statuses.push(value); },
        },
      };

      await writeFile(join(tempAgentDir, "models.json"), JSON.stringify({
        providers: { "Opencode-Go": { compat: { sendSessionAffinityHeaders: true } } },
      }));
      const enabledHeaders: Record<string, string | null> = {};
      requestHeaders({ headers: enabledHeaders }, context);
      assert.deepEqual(enabledHeaders, {
        session_id: derivePromptCacheKey("hook-session"),
        "x-client-request-id": derivePromptCacheKey("hook-session"),
        "x-session-affinity": derivePromptCacheKey("hook-session"),
      });
      assert.deepEqual(fresh.__internals_for_tests.describeMissingOpenAICompatibleProxyCompat(runtimeModel), []);
      assert.equal(fresh.__internals_for_tests.buildFixSuggestion(runtimeModel), undefined);
      assert.match(fresh.__internals_for_tests.buildDoctorDiagnosis(runtimeModel), /✅ Compat fully configured\./);
      assert.equal(fresh.__internals_for_tests.buildCompatDiagnosis(runtimeModel)?.includes("Missing compat"), false);
      await handlers.get("model_select")?.({ model: runtimeModel, previousModel: undefined, source: "set" }, context);
      assert.equal(notifications.some((message) => message.includes("merged compat lacks")), false);
      assert.equal(statuses.some((status) => status?.includes("⚠️ compat")), false);

      await writeFile(join(tempAgentDir, "models.json"), JSON.stringify({
        providers: {
          "Opencode-Go": {
            compat: { sendSessionAffinityHeaders: true },
            modelOverrides: {
              "mimo-v2.5": { compat: { sendSessionAffinityHeaders: false } },
            },
          },
        },
      }));
      const disabledHeaders: Record<string, string | null> = {};
      requestHeaders({ headers: disabledHeaders }, context);
      assert.deepEqual(disabledHeaders, {});
      assert.deepEqual(fresh.__internals_for_tests.describeMissingOpenAICompatibleProxyCompat(runtimeModel), []);
      assert.equal(fresh.__internals_for_tests.buildFixSuggestion(runtimeModel), undefined);

      const routeSnapshot = {
        virtualProvider: "router",
        virtualModelId: "smart",
        provider: "openai-alias",
        modelId: "gpt-5.5",
        api: "openai-completions",
        timestamp: Date.now(),
      };
      const routeContext = {
        ...context,
        model: model({ provider: "router", id: "smart", api: "router-api", baseUrl: "https://router.example", compat: {} }),
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
      };
      const unregisterRouter = fresh.__internals_for_tests.ensureRoutingRegistry().registerRouter({
        virtualProvider: "router",
        resolveActiveRoute: () => routeSnapshot,
      });
      try {
        await writeFile(join(tempAgentDir, "models.json"), JSON.stringify({
          providers: {
            "openai-alias": {
              compat: { sendSessionAffinityHeaders: true },
            },
          },
        }));
        const unknownEndpointHeaders: Record<string, string | null> = {};
        requestHeaders({ headers: unknownEndpointHeaders }, routeContext);
        assert.deepEqual(unknownEndpointHeaders, {});
        const unknownResolved = fresh.__internals_for_tests.resolveRouteModel(routeContext.model, routeContext as any);
        assert.ok(unknownResolved);
        assert.equal(fresh.__internals_for_tests.isCompatCheckApplicable(unknownResolved), false);
        assert.equal(fresh.__internals_for_tests.isDeepSeekCompatCheckApplicable({ ...unknownResolved, id: "deepseek-chat", name: "DeepSeek" }), false);
        assert.equal(
          fresh.__internals_for_tests.isAdaptiveThinkingCompatApplicable({
            ...unknownResolved,
            provider: "kimi-coding",
            id: "k3",
            name: "Kimi K3",
            api: "anthropic-messages",
          }),
          false,
        );
        assert.deepEqual(fresh.__internals_for_tests.describeMissingOpenAICompatibleProxyCompat(unknownResolved), []);
        const unknownKimi = {
          ...unknownResolved,
          provider: "kimi-coding",
          id: "k3",
          name: "Kimi K3",
          api: "anthropic-messages",
        };
        assert.deepEqual(
          fresh.__internals_for_tests.describeMissingCacheCompatForModel({ ...unknownResolved, id: "deepseek-chat", name: "DeepSeek" }),
          [],
        );
        assert.deepEqual(fresh.__internals_for_tests.describeMissingCacheCompatForModel(unknownKimi), []);
        assert.equal(fresh.__internals_for_tests.buildFixSuggestion(unknownKimi), undefined);
        assert.match(
          fresh.__internals_for_tests.buildDoctorDiagnosis(unknownKimi),
          /ℹ️ Compat check not applicable for this model\./,
        );

        // Exercise the lifecycle paths as well as the pure diagnostics: a
        // routed fallback with unknown endpoint metadata must not emit an
        // adaptive-thinking warning or add a compat footer marker.
        const originalRouteSnapshot = { ...routeSnapshot };
        Object.assign(routeSnapshot, {
          provider: "anthropic",
          modelId: "claude-opus-5",
          api: "anthropic-messages",
        });
        const notificationCountBeforeUnknownRoute = notifications.length;
        const statusCountBeforeUnknownRoute = statuses.length;
        try {
          await handlers.get("model_select")?.(
            { model: routeContext.model, previousModel: undefined, source: "set" },
            routeContext,
          );
          assert.equal(notifications.length, notificationCountBeforeUnknownRoute);
          const unknownRouteStatuses = statuses.slice(statusCountBeforeUnknownRoute);
          assert.ok(unknownRouteStatuses.length > 0, "model_select should publish the routed footer status");
          assert.match(unknownRouteStatuses.at(-1) ?? "", /Claude cache/);
          assert.equal(
            unknownRouteStatuses.some((status) => status?.includes("⚠️ compat")),
            false,
          );
        } finally {
          Object.assign(routeSnapshot, originalRouteSnapshot);
        }

        assert.equal(fresh.__internals_for_tests.buildFixSuggestion(unknownResolved), undefined);
        assert.match(
          fresh.__internals_for_tests.buildDoctorDiagnosis(unknownResolved),
          /Upstream endpoint metadata is unavailable; session-affinity header injection is disabled\./,
        );
        assert.equal(fresh.__internals_for_tests.describeRouterChannelDiagnostics(unknownResolved).length, 0);

        await writeFile(join(tempAgentDir, "models.json"), JSON.stringify({
          providers: {
            "openai-alias": {
              baseUrl: "https://api.openai.com/v1",
              compat: { sendSessionAffinityHeaders: true },
            },
          },
        }));
        const officialHeaders: Record<string, string | null> = {};
        requestHeaders({ headers: officialHeaders }, routeContext);
        assert.deepEqual(officialHeaders, {});

        await writeFile(join(tempAgentDir, "models.json"), JSON.stringify({
          providers: {
            "openai-alias": {
              baseUrl: "https://third-party.example/v1",
              compat: { sendSessionAffinityHeaders: true },
            },
          },
        }));
        const routedProxyHeaders: Record<string, string | null> = {};
        requestHeaders({ headers: routedProxyHeaders }, routeContext);
        assert.equal(routedProxyHeaders["x-session-affinity"], derivePromptCacheKey("hook-session"));
      } finally {
        unregisterRouter();
      }

      await writeFile(join(tempAgentDir, "models.json"), JSON.stringify({
        providers: {
          "Opencode-Go": {
            baseUrl: 123,
            compat: { sendSessionAffinityHeaders: true },
          },
        },
      }));
      const invalidConfigHeaders: Record<string, string | null> = {};
      requestHeaders({ headers: invalidConfigHeaders }, context);
      assert.deepEqual(invalidConfigHeaders, {});
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

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

  test("does not use the unsupported Pi supportsPromptCacheKey compat field", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-key-compat-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "cache-key-compat-test.ts"), { interopDefault: false, moduleCache: false });
      const fresh = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, Handler>();
      fresh.default({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerCommand() {} } as any);
      const request = handlers.get("before_provider_request");
      assert.ok(request);
      const runtimeModel = model({ provider: "cache-key-proxy", id: "cache-key-model", compat: {} });
      const context = {
        model: runtimeModel,
        sessionManager: { getSessionId: () => "cache-key-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify() {}, setStatus() {} },
      };

      await writeFile(join(tempAgentDir, "models.json"), JSON.stringify({
        providers: { "cache-key-proxy": { compat: { supportsPromptCacheKey: false } } },
      }));
      assert.equal(fresh.__internals_for_tests.shouldInjectOpenAIPromptCacheKeyForModel(runtimeModel), true);
      assert.equal(
        fresh.__internals_for_tests.shouldInjectOpenAIPromptCacheKeyForModel({ ...runtimeModel, api: "openai-responses" } as any),
        false,
      );
      assert.deepEqual(
        request({ payload: { messages: [] } }, context),
        { messages: [], prompt_cache_key: derivePromptCacheKey("cache-key-session") },
      );
      assert.equal(
        request({ payload: { input: [] } }, { ...context, model: { ...runtimeModel, api: "openai-responses" } }),
        undefined,
      );

      // The extension-owned config is the only per-model opt-out. It removes
      // both spellings after Pi/core request mutations have already run.
      fresh.__internals_for_tests.setPersistedCacheOptimizerConfig({
        version: 2,
        promptCacheKey: { omit: ["cache-key-proxy/cache-key-model"] },
      });
      assert.deepEqual(
        request({ payload: { messages: [], prompt_cache_key: "pi", promptCacheKey: "caller" } }, context),
        { messages: [] },
      );
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
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
