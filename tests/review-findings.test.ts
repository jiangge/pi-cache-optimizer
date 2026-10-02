import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { __internals_for_tests as internals } from "#extension";

describe("stable prompt reordering", () => {
  const guideline = "- Always run repository checks before finishing.";

  test("preserves an ambiguous candidate inside dynamic marked content", () => {
    const original = [
      "<workflow-state>",
      `Quoted policy: ${guideline}`,
      "</workflow-state>",
      "",
      "## Guidelines",
      guideline,
    ].join("\n");

    const result = internals.optimizeSystemPrompt(original, {
      cwd: process.cwd(),
      promptGuidelines: [guideline.slice(2)],
    });

    assert.equal(result.systemPrompt, original);
    assert.equal(result.stablePrefix, "");
    assert.equal(result.changed, false);
  });

  test("lifts a unique candidate deterministically", () => {
    const original = [
      "Dynamic turn context",
      "",
      "## Guidelines",
      guideline,
      "",
      "Tail context",
    ].join("\n");
    const options = { cwd: process.cwd(), promptGuidelines: [guideline.slice(2)] };

    const first = internals.optimizeSystemPrompt(original, options);
    const second = internals.optimizeSystemPrompt(original, options);

    assert.equal(first.changed, true);
    assert.equal(first.stablePrefix, guideline);
    assert.equal(first.systemPrompt, second.systemPrompt);
    assert.ok(first.systemPrompt.startsWith(`${guideline}\n\n---\n\n`));
    assert.equal(first.systemPrompt.split(guideline).length - 1, 1);
    assert.match(first.systemPrompt, /Dynamic turn context/);
    assert.match(first.systemPrompt, /Tail context/);
  });

  test("preserves dynamic content nested inside a full context-file candidate", () => {
    const content = "Always preserve this context body exactly.";
    const fullContext = `## AGENTS.md\n\n${content}`;
    const dynamicBlock = `<workflow-state>\n${content}\n</workflow-state>`;
    const original = `${dynamicBlock}\n\n${fullContext}`;

    const result = internals.optimizeSystemPrompt(original, {
      cwd: process.cwd(),
      contextFiles: [{ path: "AGENTS.md", content }],
    });

    assert.equal(result.changed, true);
    assert.equal(result.stablePrefix, fullContext);
    assert.equal(result.stablePrefix.split(content).length - 1, 1);
    assert.ok(result.systemPrompt.includes(dynamicBlock));
    assert.equal(result.systemPrompt.split(content).length - 1, 2);
  });
});

describe("footer status separation and command completion", () => {
  test("prefixes every extension-owned footer status exactly once", () => {
    assert.equal(
      internals.prefixFooterStatus("OpenAI cache 0/0·0M/0M 0.0%"),
      "· OpenAI cache 0/0·0M/0M 0.0%",
    );
    assert.equal(
      internals.prefixFooterStatus("Cache Optimizer disabled · OpenAI cache 0/0·0M/0M 0.0% ⚠️ compat"),
      "· Cache Optimizer disabled · OpenAI cache 0/0·0M/0M 0.0% ⚠️ compat",
    );
    assert.equal(internals.prefixFooterStatus("· OpenAI cache 0/0·0M/0M 0.0%"), "· OpenAI cache 0/0·0M/0M 0.0%");
    assert.equal(internals.prefixFooterStatus(undefined), undefined);
  });

  test("formats compact footer stats with one-decimal token hit rate", () => {
    assert.equal(
      internals.formatCacheStats(
        { label: "OpenAI cache", showCacheWrite: false } as any,
        {
          day: "2026-08-08",
          totalRequests: 234,
          hitRequests: 224,
          cachedInputTokens: 52_200_000,
          cacheWriteInputTokens: 0,
          totalInputTokens: 56_100_000,
        },
      ),
      "OpenAI cache 224/234·52.2M/56.1M 93.0%",
    );
  });

  test("publishes the ownership prefix through setStatus", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-footer-status-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand() {},
      } as any);

      const statuses: Array<{ key: string; value: string | undefined }> = [];
      const model = {
        provider: "proxy",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        compat: {},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const context = {
        model,
        sessionManager: { getSessionId: () => "footer-status-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify() {},
          setStatus(key: string, value: string | undefined) {
            statuses.push({ key, value });
          },
        },
      };

      const sessionStart = handlers.get("session_start");
      assert.ok(sessionStart);
      await sessionStart({ reason: "startup" }, context);

      assert.equal(statuses.at(-1)?.key, "pi-cache-stats");
      assert.match(statuses.at(-1)?.value ?? "", /^· OpenAI cache /);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("completes top-level and nested cache-optimizer arguments by prefix", () => {
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions(""),
      ["enable", "disable", "doctor", "stats", "config", "compat", "reset", "fix", "rollback"].map((value) => ({ value, label: value })),
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions(" c "),
      [{ value: "config", label: "config" }],
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("config "),
      ["footer-mode", "prompt-rewrite", "virtual-rewrite", "skill-compression", "openai-cache-key", "tool-order", "reset"].map((value) => ({ value: `config ${value}`, label: value })),
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("stats "),
      ["all", "contributors"].map((value) => ({ value: `stats ${value}`, label: value })),
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("stats a"),
      [{ value: "stats all", label: "all" }],
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("config footer-mode "),
      ["total", "session", "process"].map((value) => ({ value: `config footer-mode ${value}`, label: value })),
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("config footer-mode s"),
      [{ value: "config footer-mode session", label: "session" }],
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("fix p"),
      [{ value: "fix prompt-cache-key", label: "prompt-cache-key" }],
    );
    assert.equal(internals.getCacheOptimizerArgumentCompletions("unknown "), null);
    assert.equal(internals.getCacheOptimizerArgumentCompletions("config unknown "), null);
    assert.equal(internals.getCacheOptimizerArgumentCompletions("config footer-mode session extra"), null);
    assert.equal(internals.getCacheOptimizerArgumentCompletions(undefined as unknown as string), null);
  });
});

describe("footer stats modes", () => {
  const sessionHash = "0123456789abcdef";
  const model = {
    provider: "proxy",
    id: "gpt-5.5",
    name: "GPT-5.5",
  };
  const sessionStats = {
    day: "2026-08-03",
    totalRequests: 2,
    hitRequests: 1,
    cachedInputTokens: 400,
    cacheWriteInputTokens: 100,
    totalInputTokens: 1000,
  };
  const totalStats = {
    day: "2026-08-03",
    totalRequests: 9,
    hitRequests: 7,
    cachedInputTokens: 4000,
    cacheWriteInputTokens: 500,
    totalInputTokens: 8000,
  };
  const statsByModel = {
    [internals.makeSessionModelKey(sessionHash, model.provider, model.id)]: sessionStats,
  };
  const totalsByModel = { [`${model.provider}/${model.id}`]: totalStats };

  test("defaults to session and accepts session, total, or process environment values", () => {
    assert.deepEqual(internals.resolveFooterStatsMode(undefined, {}), {
      mode: "session",
      source: "default",
    });
    assert.deepEqual(
      internals.resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: " SeSsIoN " }),
      { mode: "session", source: "env" },
    );
    assert.deepEqual(
      internals.resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: "TOTAL" }),
      { mode: "total", source: "env" },
    );
    assert.deepEqual(
      internals.resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: "process" }),
      { mode: "process", source: "env" },
    );
    assert.deepEqual(
      internals.resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: "daily" }),
      { mode: "session", source: "default" },
    );
    assert.equal(
      internals.parsePersistedCacheOptimizerConfig({ version: 1, footerMode: "daily" }),
      undefined,
    );
  });

  test("persistent configuration overrides the environment mode", () => {
    assert.deepEqual(
      internals.resolveFooterStatsMode("total", { PI_CACHE_OPTIMIZER_FOOTER_MODE: "session" }),
      { mode: "total", source: "config" },
    );
    assert.deepEqual(
      internals.resolveFooterStatsMode("session", { PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }),
      { mode: "session", source: "config" },
    );
  });

  test("selects direct model stats from the requested scope", () => {
    const processStats = { ...sessionStats, totalRequests: 3, hitRequests: 2 };
    const processByModel = { [`${model.provider}/${model.id}`]: processStats };
    assert.equal(
      internals.selectFooterStatsForModel("session", sessionHash, statsByModel, totalsByModel, model, processByModel),
      sessionStats,
    );
    assert.equal(
      internals.selectFooterStatsForModel("total", sessionHash, statsByModel, totalsByModel, model, processByModel),
      totalStats,
    );
    assert.equal(
      internals.selectFooterStatsForModel("process", sessionHash, statsByModel, totalsByModel, model, processByModel),
      processStats,
    );
    assert.equal(
      internals.selectFooterStatsForModel("session", "fresh-session", statsByModel, totalsByModel, model, processByModel),
      undefined,
    );
    assert.equal(
      internals.selectFooterStatsForModel("process", "fresh-session", statsByModel, totalsByModel, model),
      undefined,
    );
  });

  test("uses the requested scope for exact router restore", () => {
    const routed = { provider: model.provider, id: model.id, name: model.name };
    const sessionEntry = internals.buildExactRouterStatusEntry(
      sessionHash,
      statsByModel,
      routed,
      totalsByModel,
      "session",
    );
    const processEntry = internals.buildExactRouterStatusEntry(
      sessionHash,
      statsByModel,
      routed,
      totalsByModel,
      "process",
      { [`${model.provider}/${model.id}`]: sessionStats },
    );
    const totalEntry = internals.buildExactRouterStatusEntry(
      sessionHash,
      statsByModel,
      routed,
      totalsByModel,
      "total",
    );

    const freshSessionEntry = internals.buildExactRouterStatusEntry(
      "fresh-session",
      statsByModel,
      routed,
      totalsByModel,
      "session",
    );

    assert.equal(sessionEntry?.stats, sessionStats);
    assert.equal(processEntry?.stats, sessionStats);
    assert.equal(totalEntry?.stats, totalStats);
    assert.equal(freshSessionEntry?.stats.totalRequests, 0);
  });

  test("restores only the matching session bucket", () => {
    const persisted = {
      statsByModel: {
        ...statsByModel,
        [internals.makeSessionModelKey("other-session", model.provider, model.id)]: totalStats,
      },
      totalsByModel,
      legacyFamily: {},
    };

    assert.deepEqual(internals.filterRestorableStatsForSession(persisted, sessionHash), statsByModel);
    assert.deepEqual(internals.filterRestorableStatsForSession(persisted, "fresh-session"), {});
  });

  test("keeps router fallback inside the requested scope", () => {
    const otherTotal = {
      ...totalStats,
      totalRequests: 99,
      hitRequests: 90,
    };
    const otherSession = {
      ...sessionStats,
      totalRequests: 1,
      hitRequests: 1,
    };
    const routedSessionStats = {
      ...statsByModel,
      [internals.makeSessionModelKey(sessionHash, "anthropic", "claude-opus-5")]: otherSession,
    };
    const routedTotals = {
      ...totalsByModel,
      "anthropic/claude-opus-5": otherTotal,
    };

    const sessionEntry = internals.findBestRouterModelStats(
      "session",
      sessionHash,
      routedSessionStats,
      routedTotals,
    );
    const totalEntry = internals.findBestRouterModelStats(
      "total",
      sessionHash,
      routedSessionStats,
      routedTotals,
    );

    assert.equal(sessionEntry?.model.id, model.id);
    assert.equal(sessionEntry?.stats, sessionStats);
    assert.equal(totalEntry?.model.id, "claude-opus-5");
    assert.equal(totalEntry?.stats, otherTotal);
  });

  test("persists the command override atomically", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-footer-mode-test-"));
    const configPath = join(tempDir, "pi-cache-optimizer-config.json");

    try {
      await internals.writePersistedFooterMode("session", configPath);
      assert.equal(internals.readPersistedFooterMode(configPath), "session");
      assert.deepEqual(
        internals.parsePersistedCacheOptimizerConfig(JSON.parse(await readFile(configPath, "utf8"))),
        { version: 1, footerMode: "session" },
      );
      assert.deepEqual(await readdir(tempDir), ["pi-cache-optimizer-config.json"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("config command overrides the environment mode", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-footer-command-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousFooterMode = process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE = "session";
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const commands = new Map<string, {
        handler: (args: string, context: any) => unknown;
        getArgumentCompletions?: (argumentPrefix: string) => unknown;
      }>();
      freshModule.default({
        on() {},
        registerCommand(name: string, command: {
          handler: (args: string, context: any) => unknown;
          getArgumentCompletions?: (argumentPrefix: string) => unknown;
        }) {
          commands.set(name, command);
        },
      } as any);

      const command = commands.get("cache-optimizer");
      assert.ok(command);
      assert.equal(typeof command.getArgumentCompletions, "function");
      assert.deepEqual(command.getArgumentCompletions?.("config footer-mode s"), [
        { value: "config footer-mode session", label: "session" },
      ]);
      const notifications: Array<{ message: string; level: string }> = [];
      const commandContext = {
        model: undefined,
        hasUI: false,
        sessionManager: { getSessionId: () => "footer-command-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
          setStatus() {},
        },
      };
      const configPath = join(tempAgentDir, "pi-cache-optimizer-config.json");

      await command.handler("config footer-mode total", commandContext);
      assert.equal(freshModule.__internals_for_tests.readPersistedFooterMode(configPath), "total");
      assert.equal(freshModule.__internals_for_tests.footerStatsMode(), "total");
      assert.match(notifications.at(-1)?.message ?? "", /set to total/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousFooterMode === undefined) delete process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;
      else process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE = previousFooterMode;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("interactive menu exposes and applies footer mode", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-footer-menu-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousFooterMode = process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      delete process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const commands = new Map<string, { handler: (args: string, context: any) => unknown }>();
      freshModule.default({
        on() {},
        registerCommand(name: string, command: { handler: (args: string, context: any) => unknown }) {
          commands.set(name, command);
        },
      } as any);

      const command = commands.get("cache-optimizer");
      assert.ok(command);
      const selectCalls: string[] = [];
      const notifications: string[] = [];
      const commandContext = {
        model: undefined,
        hasUI: true,
        sessionManager: { getSessionId: () => "footer-menu-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify: (message: string) => notifications.push(message),
          setStatus() {},
          select: async (title: string, options: string[]) => {
            selectCalls.push(title);
            if (title === "Cache Optimizer") return options.find((option) => option.startsWith("Footer mode"));
            return options.find((option) => option.startsWith("process"));
          },
        },
      };
      const configPath = join(tempAgentDir, "pi-cache-optimizer-config.json");

      await command.handler("", commandContext);

      assert.deepEqual(selectCalls, ["Cache Optimizer", "Footer cache stats mode"]);
      assert.equal(freshModule.__internals_for_tests.readPersistedFooterMode(configPath), "process");
      assert.equal(freshModule.__internals_for_tests.footerStatsMode(), "process");
      assert.match(notifications.at(-1) ?? "", /set to process/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousFooterMode === undefined) delete process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;
      else process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE = previousFooterMode;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("Pi 0.83 adaptive-thinking compatibility", () => {
  function claudeModel(
    id: string,
    compat: Record<string, unknown> = {},
  ): NonNullable<ExtensionContext["model"]> {
    return {
      provider: "anthropic",
      id,
      name: `Claude ${id}`,
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      compat,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    };
  }

  test("reports missing adaptive compat for native Claude Opus 5", () => {
    const model = claudeModel("claude-opus-5");

    assert.equal(internals.isAdaptiveThinkingCompatApplicable(model), true);
    assert.deepEqual(
      internals.describeMissingCacheCompatForModel(model),
      ["forceAdaptiveThinking"],
    );
    assert.match(
      internals.buildAdaptiveThinkingCompatWarningText(
        "anthropic/claude-opus-5",
        ["forceAdaptiveThinking"],
      ),
      /forceAdaptiveThinking/,
    );
  });

  test("does not report adaptive compat when Claude Opus 5 is configured", () => {
    const model = claudeModel("claude-opus-5", { forceAdaptiveThinking: true });

    assert.equal(internals.isAdaptiveThinkingCompatApplicable(model), true);
    assert.deepEqual(internals.describeMissingAdaptiveThinkingCompat(model), []);
    assert.deepEqual(internals.describeMissingCacheCompatForModel(model), []);
  });

  test("keeps older non-adaptive Claude models as a negative case", () => {
    const model = claudeModel("claude-opus-4-5");

    assert.equal(internals.isAdaptiveThinkingCompatApplicable(model), false);
    assert.deepEqual(internals.describeMissingCacheCompatForModel(model), []);
  });
});

describe("explicit compat precedence", () => {
  const provider = "proxy";
  const modelId = "builtin-model";
  const compatKey = "supportsLongCacheRetention";

  function config(values: { provider?: boolean; model?: boolean; modelOverride?: boolean }) {
    return {
      providers: {
        [provider]: {
          compat: values.provider === undefined ? {} : { [compatKey]: values.provider },
          models: [{
            id: modelId,
            compat: values.model === undefined ? {} : { [compatKey]: values.model },
          }],
          modelOverrides: {
            [modelId]: {
              compat: values.modelOverride === undefined
                ? {}
                : { [compatKey]: values.modelOverride },
            },
          },
        },
      },
    };
  }

  test("modelOverrides true wins over false model and provider values", () => {
    const input = config({ provider: false, model: false, modelOverride: true });

    assert.deepEqual(
      internals.resolveExplicitCompatValue(input, provider, modelId, compatKey),
      { source: "modelOverride", value: true },
    );
    assert.equal(
      internals.hasExplicitLongRetentionOptInFromConfig(input, provider, modelId),
      true,
    );
  });

  test("modelOverrides false wins over true model and provider values", () => {
    const input = config({ provider: true, model: true, modelOverride: false });

    assert.deepEqual(
      internals.resolveExplicitCompatValue(input, provider, modelId, compatKey),
      { source: "modelOverride", value: false },
    );
    assert.equal(
      internals.hasExplicitLongRetentionOptInFromConfig(input, provider, modelId),
      false,
    );
  });

  test("custom model wins over provider and provider remains the fallback", () => {
    assert.deepEqual(
      internals.resolveExplicitCompatValue(
        config({ provider: true, model: false }),
        provider,
        modelId,
        compatKey,
      ),
      { source: "model", value: false },
    );
    assert.deepEqual(
      internals.resolveExplicitCompatValue(
        config({ provider: true }),
        provider,
        modelId,
        compatKey,
      ),
      { source: "provider", value: true },
    );
  });

  test("effective compat merges provider, custom model, runtime model, and modelOverrides", () => {
    const runtimeModel = {
      provider,
      id: modelId,
      compat: { sendSessionAffinityHeaders: true, supportsLongCacheRetention: true },
    } as any;
    const input = {
      providers: {
        [provider]: {
          compat: { sendSessionAffinityHeaders: true, supportsLongCacheRetention: false },
          models: [{
            id: modelId,
            compat: { sendSessionAffinityHeaders: false, supportsDeveloperRole: false },
          }],
          modelOverrides: {
            [modelId]: { compat: { supportsLongCacheRetention: false } },
          },
        },
      },
    };

    assert.deepEqual(
      internals.resolveEffectiveCompatFromConfig(runtimeModel, input),
      {
        sendSessionAffinityHeaders: true,
        supportsLongCacheRetention: false,
        supportsDeveloperRole: false,
      },
    );
    assert.deepEqual(
      internals.resolveEffectiveCompatFromConfig(
        { ...runtimeModel, compat: {} },
        {
          providers: {
            [provider]: {
              compat: { openRouterRouting: { allow_fallbacks: false, only: ["openai"] } },
              models: [{ id: modelId, compat: { openRouterRouting: { order: ["openai", "anthropic"] } } }],
            },
          },
        },
      ).openRouterRouting,
      { allow_fallbacks: false, only: ["openai"], order: ["openai", "anthropic"] },
    );
    const overrideInput = {
      providers: {
        [provider]: {
          compat: { sendSessionAffinityHeaders: true },
          models: [{ id: modelId, compat: { sendSessionAffinityHeaders: false } }],
          modelOverrides: { [modelId]: { compat: { sendSessionAffinityHeaders: true } } },
        },
      },
    };
    assert.equal(
      internals.resolveEffectiveCompatFromConfig(
        { ...runtimeModel, compat: { sendSessionAffinityHeaders: false } },
        overrideInput,
      ).sendSessionAffinityHeaders,
      true,
    );
    assert.equal(
      internals.getEffectiveCompatValueSource(
        { ...runtimeModel, compat: { sendSessionAffinityHeaders: false } },
        overrideInput,
        "sendSessionAffinityHeaders",
      ),
      "modelOverride",
    );
  });

  test("duplicate custom model ids follow Pi's last-definition-wins behavior", () => {
    const runtimeModel = {
      provider,
      id: modelId,
      compat: {},
    } as any;
    const input = {
      providers: {
        [provider]: {
          models: [
            {
              id: modelId,
              api: "openai-responses",
              baseUrl: "https://first.example/v1",
              compat: { sendSessionAffinityHeaders: false },
            },
            {
              id: modelId,
              api: "openai-completions",
              baseUrl: "https://last.example/v1",
              compat: { sendSessionAffinityHeaders: true },
            },
          ],
        },
      },
    };

    assert.equal(
      internals.resolveEffectiveCompatFromConfig(runtimeModel, input).sendSessionAffinityHeaders,
      true,
    );
    assert.deepEqual(
      internals.resolveExplicitCompatValue(input, provider, modelId, "sendSessionAffinityHeaders"),
      { source: "model", value: true },
    );
    assert.deepEqual(
      internals.applyConfiguredTransportToModel(
        { ...runtimeModel, api: "", baseUrl: "" },
        input,
      ),
      { ...runtimeModel, api: "openai-completions", baseUrl: "https://last.example/v1" },
    );
  });

  test("malformed models.json falls back to runtime model compat", () => {
    const runtimeModel = {
      provider,
      id: modelId,
      compat: { sendSessionAffinityHeaders: true },
    } as any;
    assert.equal(
      internals.resolveEffectiveCompatFromConfig(runtimeModel, undefined).sendSessionAffinityHeaders,
      true,
    );
    assert.equal(
      internals.resolveEffectiveCompatFromConfig(runtimeModel, { providers: "invalid" }).sendSessionAffinityHeaders,
      true,
    );
  });

  test("schema-invalid models.json is rejected before compat resolution", () => {
    assert.equal(
      internals.isValidModelsConfigForEffectiveCompat({
        providers: {
          [provider]: {
            baseUrl: 123,
            compat: { sendSessionAffinityHeaders: true },
          },
        },
      }),
      false,
    );
    assert.equal(
      internals.isValidModelsConfigForEffectiveCompat({
        providers: {
          [provider]: {
            compat: { sendSessionAffinityHeaders: true },
            models: [{ id: modelId, thinkingLevelMap: { high: 4 } }],
          },
        },
      }),
      false,
    );
    assert.equal(
      internals.isValidModelsConfigForEffectiveCompat({
        providers: {
          [provider]: {
            baseUrl: "https://proxy.example/v1",
            compat: { sendSessionAffinityHeaders: true },
            modelOverrides: { [modelId]: { cost: { input: 1, extra: 2 } } },
          },
        },
      }),
      true,
    );
  });

  test("before_provider_request reads modelOverrides from the active agent directory", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-review-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand() {},
      } as any);
      const hook = handlers.get("before_provider_request");
      assert.ok(hook);
      const context = {
        model: {
          provider,
          id: modelId,
          name: "Built-in model through proxy",
          api: "openai-completions",
          baseUrl: "https://proxy.example/v1",
          compat: {},
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
        },
        sessionManager: { getSessionId: () => "review-test-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify() {}, setStatus() {} },
      };

      await writeFile(
        join(tempAgentDir, "models.json"),
        JSON.stringify(config({ provider: true, model: true, modelOverride: false })),
      );
      const deniedPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      hook({ payload: deniedPayload }, context);
      assert.equal("prompt_cache_retention" in deniedPayload, false);

      await writeFile(
        join(tempAgentDir, "models.json"),
        JSON.stringify(config({ provider: false, model: false, modelOverride: true })),
      );
      const allowedPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      hook({ payload: allowedPayload }, context);
      assert.equal(allowedPayload.prompt_cache_retention, "24h");

      await writeFile(
        join(tempAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            [provider]: {
              compat: { supportsLongCacheRetention: true },
              models: [{ id: modelId, thinkingLevelMap: { high: 4 } }],
            },
          },
        }),
      );
      const invalidConfigPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      hook({ payload: invalidConfigPayload }, context);
      assert.equal("prompt_cache_retention" in invalidConfigPayload, false);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("provider response recovery", () => {
  test("body-only prompt_cache_retention errors disable the field on the next request", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-retention-recovery-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(
        join(tempAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            proxy: {
              models: [{
                id: "gpt-5.5",
                compat: {
                  supportsLongCacheRetention: true,
                  sendSessionAffinityHeaders: true,
                },
              }],
            },
          },
        }),
        "utf8",
      );

      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand() {},
      } as any);

      const model = {
        provider: "proxy",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: {
          supportsLongCacheRetention: true,
          sendSessionAffinityHeaders: true,
        },
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const notifications: string[] = [];
      const context = {
        model,
        sessionManager: { getSessionId: () => "retention-recovery-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify(message: string) { notifications.push(message); },
          setStatus() {},
        },
      };
      const requestHook = handlers.get("before_provider_request");
      const messageEndHook = handlers.get("message_end");
      assert.ok(requestHook);
      assert.ok(messageEndHook);

      const firstPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      requestHook({ payload: firstPayload }, context);
      assert.equal(firstPayload.prompt_cache_retention, "24h");

      await messageEndHook({
        message: {
          role: "assistant",
          provider: "proxy",
          model: "gpt-5.5",
          api: "openai-completions",
          stopReason: "error",
          errorMessage: "400 Bad request: prompt_cache_retention must be one of 24h or in-memory",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }, context);

      const valueErrorPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      requestHook({ payload: valueErrorPayload }, context);
      assert.equal(valueErrorPayload.prompt_cache_retention, "24h");

      await messageEndHook({
        message: {
          role: "assistant",
          provider: "proxy",
          model: "gpt-5.5",
          api: "openai-completions",
          stopReason: "error",
          errorMessage: "400 Unsupported parameter: prompt_cache_retention",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }, context);

      const unsupportedPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      requestHook({ payload: unsupportedPayload }, context);
      assert.equal("prompt_cache_retention" in unsupportedPayload, false);
      assert.ok(notifications.some((message) => message.includes("prompt_cache_retention")));
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("routed body-only errors use assistant provider/model identity without a live registry", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-routed-retention-recovery-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(
        join(tempAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            proxy: {
              models: [{
                id: "gpt-5.5",
                compat: { supportsLongCacheRetention: true },
              }],
            },
          },
        }),
        "utf8",
      );

      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand() {},
      } as any);

      const routerModel = {
        provider: "router",
        id: "auto",
        name: "Auto",
        api: "router-api",
        baseUrl: "",
        compat: {},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const upstreamModel = {
        ...routerModel,
        provider: "proxy",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: { supportsLongCacheRetention: true },
      };
      const baseContext = {
        sessionManager: { getSessionId: () => "routed-retention-recovery-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify() {}, setStatus() {} },
      };
      const requestHook = handlers.get("before_provider_request");
      const messageEndHook = handlers.get("message_end");
      assert.ok(requestHook);
      assert.ok(messageEndHook);

      await messageEndHook({
        message: {
          role: "assistant",
          provider: "proxy",
          model: "gpt-5.5",
          api: "openai-completions",
          stopReason: "error",
          errorMessage: "400 Unsupported parameter: prompt_cache_retention",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }, { ...baseContext, model: routerModel });

      const nextPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      requestHook({ payload: nextPayload }, { ...baseContext, model: upstreamModel });
      assert.equal("prompt_cache_retention" in nextPayload, false);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("modelOverrides JSONC fixes", () => {
  const provider = "proxy";
  const modelId = "builtin-model";
  const compatKeys = { supportsLongCacheRetention: true };

  test("surgically repairs an existing override and preserves comments", () => {
    const original = `{
  "providers": {
    "proxy": {
      "compat": { "supportsLongCacheRetention": false },
      "models": [{
        "id": "builtin-model",
        "compat": { "supportsLongCacheRetention": false }
      }],
      "modelOverrides": {
        "builtin-model": {
          // Keep this explanation.
          "compat": {
            "supportsLongCacheRetention": false,
            "unrelated": "preserved"
          }
        }
      }
    }
  }
}`;
    const location = internals.locateModelInJsonc(original, provider, modelId);

    assert.ok(location);
    assert.deepEqual(internals.chooseFixPlacement(original, location, compatKeys, provider), {
      placement: "modelOverride",
      reason: "an existing modelOverrides entry has Pi's highest precedence — repairing it directly",
    });

    const modified = internals.composeFixInsertion(original, location, compatKeys, "modelOverride");
    assert.equal(
      internals.selfCheckFix(original, modified, provider, modelId, compatKeys, "modelOverride"),
      null,
    );
    assert.match(modified, /\/\/ Keep this explanation\./);
    assert.match(modified, /"unrelated": "preserved"/);
    assert.deepEqual(
      internals.resolveExplicitCompatValue(
        internals.parseJsonc(modified),
        provider,
        modelId,
        "supportsLongCacheRetention",
      ),
      { source: "modelOverride", value: true },
    );
  });

  test("self-check rejects a lower-layer edit shadowed by modelOverrides", () => {
    const original = `{
  "providers": {
    "proxy": {
      "compat": { "supportsLongCacheRetention": false },
      "models": [{ "id": "builtin-model" }],
      "modelOverrides": {
        "builtin-model": {
          "compat": { "supportsLongCacheRetention": false }
        }
      }
    }
  }
}`;
    const location = internals.locateModelInJsonc(original, provider, modelId);
    assert.ok(location);

    const wronglyModified = internals.composeFixInsertion(original, location, compatKeys, "provider");
    assert.match(
      internals.selfCheckFix(original, wronglyModified, provider, modelId, compatKeys, "provider") ?? "",
      /effective compat\.supportsLongCacheRetention has wrong value/,
    );
  });

  test("self-check includes runtime compat and requires a higher-precedence override", () => {
    const original = `{
  "providers": {
    "proxy": {
      "models": [{
        "id": "builtin-model",
        "compat": { "thinkingFormat": "deepseek" }
      }]
    }
  }
}`;
    const runtimeModel = {
      provider,
      id: modelId,
      name: "DeepSeek Builtin",
      api: "openai-completions",
      baseUrl: "https://proxy.example/v1",
      compat: { thinkingFormat: "deepseek" },
    } as any;
    const location = internals.locateModelInJsonc(original, provider, modelId);
    assert.ok(location);
    const lowerLayer = internals.composeFixInsertion(
      original,
      location,
      { thinkingFormat: "openai" },
      "model",
    );
    assert.match(
      internals.selfCheckFix(
        original,
        lowerLayer,
        provider,
        modelId,
        { thinkingFormat: "openai" },
        "model",
        runtimeModel,
      ) ?? "",
      /effective compat\.thinkingFormat has wrong value/,
    );

    const override = internals.composeModelOverrideInsertion(
      original,
      provider,
      modelId,
      { thinkingFormat: "openai" },
    );
    assert.ok(override);
    assert.equal(
      internals.selfCheckMissingEntryInsertion(
        original,
        override.modifiedText,
        provider,
        modelId,
        { thinkingFormat: "openai" },
        runtimeModel,
      ),
      null,
    );
    assert.equal(
      internals.resolveEffectiveCompatFromConfig(
        runtimeModel,
        internals.parseJsonc(override.modifiedText),
      ).thinkingFormat,
      "openai",
    );
  });

  test("refuses ambiguous duplicate JSONC path keys before editing", () => {
    const model = `"models": [{ "id": "builtin-model", "compat": { "supportsLongCacheRetention": false } }]`;
    const providerEntry = `"proxy": { ${model} }`;
    const cases = [
      `{
  "providers": { ${providerEntry} },
  "providers": { ${providerEntry} }
}`,
      `{
  "providers": { ${providerEntry}, ${providerEntry} }
}`,
      `{
  "providers": { "proxy": { ${model}, ${model} } }
}`,
      `{
  "providers": { "proxy": {
    ${model},
    "modelOverrides": { "builtin-model": { "compat": { "supportsLongCacheRetention": false } } },
    "modelOverrides": { "builtin-model": { "compat": { "supportsLongCacheRetention": false } } }
  } }
}`,
      `{
  "providers": { "proxy": {
    ${model},
    "modelOverrides": {
      "builtin-model": { "compat": { "supportsLongCacheRetention": false } },
      "builtin-model": { "compat": { "supportsLongCacheRetention": false } }
    }
  } }
}`,
      `{
  "providers": { "proxy": {
    "compat": { "providerOnly": false },
    "compat": { "providerOnly": true },
    ${model}
  } }
}`,
      `{
  "providers": { "proxy": {
    ${model},
    "modelOverrides": {
      "builtin-model": {
        "compat": { "supportsLongCacheRetention": false },
        "compat": { "supportsLongCacheRetention": true }
      }
    }
  } }
}`,
      `{
  "providers": { "proxy": {
    "models": [{ "id": "builtin-model", "compat": { "supportsLongCacheRetention": false }, "compat": { "supportsLongCacheRetention": false } }]
  } }
}`,
      `{
  "providers": { "proxy": {
    "models": [{ "id": "builtin-model", "id": "builtin-model", "compat": { "supportsLongCacheRetention": false } }]
  } }
}`,
    ];

    for (const text of cases) {
      assert.equal(internals.locateModelInJsonc(text, provider, modelId), undefined);
      assert.equal(internals.analyzeModelsJsonForMissingEntry(text, provider, modelId), undefined);
    }
  });

  test("self-check rejects unrelated additions instead of accepting a one-way subset", () => {
    const original = `{
  "providers": {
    "proxy": {
      "models": [{ "id": "builtin-model" }]
    }
  }
}`;
    const location = internals.locateModelInJsonc(original, provider, modelId);
    assert.ok(location);
    const modified = internals.composeFixInsertion(
      original,
      location,
      { sendSessionAffinityHeaders: true },
      "model",
    );
    const withUnrelatedSecret = modified.replace(
      '"models":',
      '"apiKey": "env:SHOULD_NOT_BE_ADDED",\n      "models":',
    );
    assert.match(
      internals.selfCheckFix(
        original,
        withUnrelatedSecret,
        provider,
        modelId,
        { sendSessionAffinityHeaders: true },
        "model",
      ) ?? "",
      /original structure was altered/,
    );
  });

  test("creates only a modelOverrides entry for a built-in model", () => {
    const original = `{
  "providers": {
    "proxy": {
      // Authentication and endpoint configuration stay untouched.
      "baseUrl": "https://proxy.example/v1",
      "apiKey": "env:PROXY_API_KEY"
    }
  }
}`;
    const result = internals.composeModelOverrideInsertion(
      original,
      provider,
      modelId,
      compatKeys,
    );

    assert.ok(result);
    assert.equal(
      internals.selfCheckMissingEntryInsertion(
        original,
        result.modifiedText,
        provider,
        modelId,
        compatKeys,
      ),
      null,
    );
    assert.match(result.modifiedText, /\/\/ Authentication and endpoint configuration stay untouched\./);
    assert.doesNotMatch(result.modifiedText, /"models"\s*:/);
    assert.match(result.modifiedText, /"modelOverrides"\s*:/);
    assert.match(result.modifiedText, /"apiKey": "env:PROXY_API_KEY"/);
  });

  test("creates a comment-safe modelOverrides-only provider entry", () => {
    const original = `{
  "providers": {
    // Other provider entries may be added here.
  }
}`;
    const result = internals.composeModelOverrideInsertion(
      original,
      provider,
      modelId,
      compatKeys,
    );

    assert.ok(result);
    assert.equal(
      internals.selfCheckMissingEntryInsertion(
        original,
        result.modifiedText,
        provider,
        modelId,
        compatKeys,
      ),
      null,
    );
    assert.match(result.modifiedText, /\/\/ Other provider entries may be added here\./);
    assert.doesNotMatch(result.modifiedText, /"models"\s*:/);
    assert.deepEqual(
      internals.resolveExplicitCompatValue(
        internals.parseJsonc(result.modifiedText),
        provider,
        modelId,
        "supportsLongCacheRetention",
      ),
      { source: "modelOverride", value: true },
    );
  });
});

describe("DeepSeek protocol-first compatibility", () => {
  const model = (compat: Record<string, unknown> = {}, overrides: Partial<Record<string, unknown>> = {}) => ({
    provider: "amd-radeon",
    id: "DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
    compat,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...overrides,
  }) as any;

  test("does not infer DeepSeek wire protocol from the family name or reasoning effort support", () => {
    const current = model({ supportsReasoningEffort: true });
    assert.equal(internals.isDeepSeekWireCompatApplicable(current), false);
    assert.deepEqual(internals.describeMissingDeepSeekCompat(current), []);
    assert.deepEqual(internals.buildDeepSeekCompatSuggestion(["sendSessionAffinityHeaders"]), {
      sendSessionAffinityHeaders: true,
    });
    assert.doesNotMatch(
      internals.buildOpenAIProxyCompatWarningText("amd-radeon/DeepSeek-V4-Flash", ["sendSessionAffinityHeaders"]),
      /thinkingFormat|requiresReasoningContent/,
    );
  });

  test("keeps generic proxy diagnostics for absent and explicit non-DeepSeek formats", () => {
    for (const thinkingFormat of [undefined, "openai", "qwen", "openrouter", "together"]) {
      const current = model({ supportsReasoningEffort: true, ...(thinkingFormat ? { thinkingFormat } : {}) });
      assert.equal(internals.isDeepSeekWireCompatApplicable(current), false);
      assert.deepEqual(internals.describeMissingDeepSeekCompat(current), []);
      assert.deepEqual(internals.describeMissingCacheCompatForModel(current), ["sendSessionAffinityHeaders"]);
      const suggestion = internals.buildFixSuggestion(current);
      assert.deepEqual(suggestion?.compatKeys, { sendSessionAffinityHeaders: true });
      assert.doesNotMatch(JSON.stringify(suggestion), /thinkingFormat|requiresReasoningContent/);
    }
  });

  test("uses explicit DeepSeek format only for replay diagnostics and never lists the format itself", () => {
    const current = model({ thinkingFormat: "deepseek", supportsReasoningEffort: true });
    assert.equal(internals.isDeepSeekWireCompatApplicable(current), true);
    assert.deepEqual(internals.describeMissingDeepSeekCompat(current), ["requiresReasoningContentOnAssistantMessages"]);
    assert.deepEqual(internals.describeMissingCacheCompatForModel(current), [
      "sendSessionAffinityHeaders",
      "requiresReasoningContentOnAssistantMessages",
    ]);
    const suggestion = internals.buildFixSuggestion(current);
    assert.deepEqual(suggestion?.compatKeys, {
      sendSessionAffinityHeaders: true,
      requiresReasoningContentOnAssistantMessages: true,
    });
    assert.doesNotMatch(JSON.stringify(suggestion), /thinkingFormat/);
  });

  test("requires explicit error evidence before proposing a model-scoped protocol repair", () => {
    const current = model({ thinkingFormat: "deepseek", supportsReasoningEffort: true });
    assert.equal(internals.buildReasoningProtocolFixSuggestion(current), undefined);
    assert.deepEqual(internals.buildReasoningProtocolFixSuggestion(
      model({
        thinkingFormat: "deepseek",
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
      }),
      true,
    )?.compatKeys, {
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: false,
    });
    assert.equal(internals.hasReasoningProtocolRejectionText(
      '400 Unsupported parameter: thinking. Use reasoning_effort instead.',
    ), true);
    assert.equal(internals.hasReasoningProtocolRejectionText(
      '400 Unsupported parameter: reasoning_effort. Use thinking instead.',
    ), false);
    for (const message of [
      '400 Invalid parameter: thinking. Use reasoning_effort instead.',
      'thinking is not accepted; reasoning_effort is required.',
      'thinking is disallowed; please use reasoning_effort.',
      'thinking is not a valid field; set reasoning_effort.',
      'thinking is rejected; replace thinking with reasoning_effort.',
    ]) {
      assert.equal(internals.hasReasoningProtocolRejectionText(message), true, message);
    }
    for (const message of [
      '400 Invalid parameter: reasoning_effort. Use thinking instead.',
      'reasoning_effort is not accepted; use thinking instead.',
      'thinking is unsupported; reasoning_effort should not be used either.',
      'thinking is unsupported; reasoning_effort is supported but disabled for this account.',
      'thinking is unsupported; reasoning_effort must not be sent.',
      'thinking is unsupported; do not use reasoning_effort.',
      'thinking is unsupported; reasoning_effort is not required.',
      'thinking is unsupported! do not use reasoning_effort.',
      'The docs mention thinking and reasoning_effort, but no parameter was rejected.',
    ]) {
      assert.equal(internals.hasReasoningProtocolRejectionText(message), false, message);
    }
    assert.equal(internals.hasReasoningProtocolRejectionSignal({
      "x-provider-error": "thinking is unsupported",
      "x-provider-doc": "use reasoning_effort for a different endpoint",
    }), false);
    assert.equal(internals.hasReasoningProtocolRejectionSignal({
      "x-provider-error": "thinking is unsupported; use reasoning_effort instead",
    }), true);

    const protocolFix = internals.buildReasoningProtocolFixSuggestion(current);
    assert.equal(protocolFix, undefined);
    for (const thinkingFormat of ["qwen", "openrouter", "together"]) {
      assert.equal(
        internals.buildReasoningProtocolFixSuggestion(model({ thinkingFormat }), true),
        undefined,
        thinkingFormat,
      );
    }
    assert.equal(internals.buildReasoningProtocolFixSuggestion(model({ thinkingFormat: "openai" }), true)?.compatKeys.thinkingFormat, undefined);
    assert.equal(internals.isReasoningProtocolRejectionSignalApplicable(current), true);
  });

  test("matches only the exact model identity for finalized assistant evidence", () => {
    const current = model();
    const matching = {
      role: "assistant",
      provider: current.provider,
      model: current.id,
      status: 400,
      stopReason: "error",
      errorMessage: 'Unsupported parameter: thinking; use reasoning_effort instead.',
    };
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage(matching), true);
    assert.equal(internals.isReasoningProtocolRejectionForModel(matching, current), true);
    assert.equal(
      internals.hasReasoningProtocolRejectionErrorMessage({ ...matching, status: 422 }),
      false,
    );
    assert.equal(
      internals.hasReasoningProtocolRejectionErrorMessage({ ...matching, status: undefined }),
      false,
    );
    assert.equal(internals.isReasoningProtocolRejectionForModel({ ...matching, model: "DeepSeek-V4-Other" }, current), false);
    assert.equal(internals.isReasoningProtocolRejectionForModel({ ...matching, provider: "other" }, current), false);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({ ...matching, stopReason: "stop" }), false);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      errorMessage: "400: Unsupported parameter: thinking. Use reasoning_effort instead.",
    }), true);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      diagnostics: [{ details: { statusCode: 400 } }],
    }), true);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      details: { error: { httpStatus: 400 } },
    }), true);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      diagnostics: [{ details: { statusCode: 422 } }],
    }), false);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      errorMessage: "DeepSeek model: 422 Unsupported parameter: thinking. Use reasoning_effort instead.",
    }), false);
    assert.equal(internals.hasReasoningProtocolRejectionText(
      "Unsupported parameter: thinking. reasoning_effort is unsupported.",
    ), false);
  });

  test("correlates response-header evidence with the request model, not a later selection", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-reasoning-correlation-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    const modelsPath = join(tempAgentDir, "models.json");
    const config = {
      providers: {
        "proxy-a": {
          baseUrl: "https://proxy-a.example/v1",
          models: [{ id: "deepseek-a", name: "DeepSeek A" }],
        },
        "proxy-b": {
          baseUrl: "https://proxy-b.example/v1",
          models: [{ id: "deepseek-b", name: "DeepSeek B" }],
        },
      },
    };

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, JSON.stringify(config), "utf8");
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand(name: string, command: { handler: (args: string, context: any) => Promise<void> }) {
          commands.set(name, command);
        },
      } as any);

      const makeModel = (provider: string, id: string, name: string) => ({
        provider,
        id,
        name,
        api: "openai-completions",
        baseUrl: `https://${provider}.example/v1`,
        compat: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      });
      const modelA = makeModel("proxy-a", "deepseek-a", "DeepSeek A");
      const modelB = makeModel("proxy-b", "deepseek-b", "DeepSeek B");
      const notifications: string[] = [];
      const baseContext = {
        sessionManager: { getSessionId: () => "reasoning-correlation-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify: (message: string) => notifications.push(message),
          setStatus() {},
          confirm: async () => false,
        },
      };
      const requestHook = handlers.get("before_provider_request");
      const responseHook = handlers.get("after_provider_response");
      const messageEndHook = handlers.get("message_end");
      const command = commands.get("cache-optimizer");
      assert.ok(requestHook);
      assert.ok(responseHook);
      assert.ok(messageEndHook);
      assert.ok(command);

      requestHook(
        { payload: {} },
        { ...baseContext, model: modelA },
      );
      await responseHook(
        {
          status: 400,
          headers: { "x-provider-error": "Unsupported parameter: thinking. Use reasoning_effort instead." },
        },
        { ...baseContext, model: modelB },
      );

      assert.ok(notifications.some((message) => message.includes("proxy-a/deepseek-a")));
      assert.equal(notifications.some((message) => message.includes("Unsupported parameter")), false);
      // Complete request A so its response record cannot be mistaken for a
      // later request that fails before after_provider_response.
      await messageEndHook(
        { message: { role: "assistant", stopReason: "error", errorMessage: "400: Unsupported parameter: thinking. Use reasoning_effort instead." } },
        { ...baseContext, model: modelB },
      );

      await command.handler("fix", {
        ...baseContext,
        model: modelA,
        hasUI: false,
        ui: { ...baseContext.ui, notify: (message: string) => notifications.push(message) },
      });
      const modelAFixGuidance = notifications.at(-1) ?? "";
      assert.match(modelAFixGuidance, /thinkingFormat/);

      await command.handler("fix", {
        ...baseContext,
        model: modelB,
        hasUI: false,
        ui: { ...baseContext.ui, notify: (message: string) => notifications.push(message) },
      });
      const modelBFixGuidance = notifications.at(-1) ?? "";
      assert.doesNotMatch(modelBFixGuidance, /thinkingFormat/);

      // A finalized assistant error may arrive without provider/model fields.
      // Keep its request-local identity even when the active model has changed.
      const modelC = makeModel("proxy-c", "deepseek-c", "DeepSeek C");
      const notificationCountBeforeMessage = notifications.length;
      requestHook(
        { payload: {} },
        { ...baseContext, model: modelC },
      );
      await messageEndHook(
        {
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "400: Unsupported parameter: thinking. Use reasoning_effort instead.",
          },
        },
        { ...baseContext, model: modelB },
      );
      const newNotifications = notifications.slice(notificationCountBeforeMessage);
      assert.ok(newNotifications.some((message) => message.includes("proxy-c/deepseek-c")));
      assert.equal(newNotifications.some((message) => message.includes("proxy-b/deepseek-b")), false);

      // A completed response must keep its own identity even if a later request
      // starts before its finalized assistant message is emitted.
      const modelD = makeModel("proxy-d", "deepseek-d", "DeepSeek D");
      const modelE = makeModel("proxy-e", "deepseek-e", "DeepSeek E");
      requestHook({ payload: {} }, { ...baseContext, model: modelD });
      await responseHook(
        { status: 400, headers: { "x-provider-error": "Unsupported parameter: thinking. Use reasoning_effort instead." } },
        { ...baseContext, model: modelD },
      );
      requestHook({ payload: {} }, { ...baseContext, model: modelE });
      const beforeInterleavedMessage = notifications.length;
      await messageEndHook(
        { message: { role: "assistant", stopReason: "error", errorMessage: "400: Unsupported parameter: thinking. Use reasoning_effort instead." } },
        { ...baseContext, model: modelE },
      );
      const interleavedNotifications = notifications.slice(beforeInterleavedMessage);
      assert.equal(interleavedNotifications.some((message) => message.includes("proxy-e/deepseek-e")), false);

      const keyModel = makeModel("proxy-key", "gpt-key", "GPT Key");
      requestHook({ payload: {} }, { ...baseContext, model: keyModel });
      await messageEndHook(
        {
          message: {
            role: "assistant",
            stopReason: "error",
            status: 400,
            errorMessage: "Unsupported parameter: prompt_cache_key",
          },
        },
        { ...baseContext, model: keyModel },
      );
      await command.handler("fix", {
        ...baseContext,
        model: keyModel,
        hasUI: false,
        ui: { ...baseContext.ui, notify: (message: string) => notifications.push(message) },
      });
      assert.match(notifications.at(-1) ?? "", /prompt(?:[_ ]?cache){1,2}[_ ]?key/i);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("concurrent cross-model responses do not turn ambiguous headers into model-scoped evidence", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-key-response-ambiguity-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
        registerCommand() {},
      } as any);
      const makeModel = (provider: string, id: string) => ({
        provider,
        id,
        name: id,
        api: "openai-completions",
        baseUrl: `https://${provider}.example/v1`,
        compat: {},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      });
      const modelA = makeModel("proxy-a", "gpt-a");
      const modelB = makeModel("proxy-b", "gpt-b");
      const notifications: string[] = [];
      const context = (model: any) => ({
        model,
        sessionManager: { getSessionId: () => "ambiguity-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify: (message: string) => notifications.push(message), setStatus() {} },
      });
      const requestHook = handlers.get("before_provider_request");
      const responseHook = handlers.get("after_provider_response");
      const messageEndHook = handlers.get("message_end");
      assert.ok(requestHook && responseHook && messageEndHook);

      requestHook({ payload: {} }, context(modelA));
      requestHook({ payload: {} }, context(modelB));
      await responseHook(
        { status: 400, headers: { "x-error": "Unsupported parameter: prompt_cache_key" } },
        context(modelB),
      );
      assert.equal(notifications.some((message) => message.includes("rejected prompt_cache_key")), false);

      await messageEndHook({
        message: {
          role: "assistant",
          provider: modelB.provider,
          model: modelB.id,
          api: modelB.api,
          stopReason: "error",
          status: 400,
          errorMessage: "Unsupported parameter: prompt_cache_key",
        },
      }, context(modelA));
      assert.equal(notifications.some((message) => message.includes("proxy-a/gpt-a rejected prompt_cache_key")), false);
      assert.equal(notifications.some((message) => message.includes("proxy-b/gpt-b rejected prompt_cache_key")), true);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("runtime disable retains request-local identity for always-on Anthropic TTL repair", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-ttl-disabled-correlation-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
        registerCommand() {},
      } as any);
      const makeModel = (provider: string, id: string) => ({
        provider,
        id,
        name: id,
        api: "anthropic-messages",
        baseUrl: `https://${provider}.example`,
        compat: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      });
      const requestModel = makeModel("anthropic-proxy-a", "claude-a");
      const activeModel = makeModel("anthropic-proxy-b", "claude-b");
      const notifications: string[] = [];
      const context = (model: any) => ({
        model,
        sessionManager: { getSessionId: () => "ttl-disabled-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify: (message: string) => notifications.push(message), setStatus() {} },
      });
      freshModule.__internals_for_tests.setRuntimeOptimizerEnabled(false);
      handlers.get("before_provider_request")?.({ payload: {} }, context(requestModel));
      await handlers.get("message_end")?.({
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "cache_control ttl='1h' must not come after ttl='5m'",
        },
      }, context(activeModel));
      assert.equal(notifications.some((message) => message.includes("anthropic-proxy-a/claude-a")), true);
      assert.equal(notifications.some((message) => message.includes("anthropic-proxy-b/claude-b")), false);
      freshModule.__internals_for_tests.setRuntimeOptimizerEnabled(true);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("ordinary fix does not configure prompt_cache_key without evidence", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-key-no-evidence-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
      freshModule.default({ on() {}, registerCommand(name: string, command: any) { commands.set(name, command); } } as any);
      const notifications: string[] = [];
      let confirmations = 0;
      await commands.get("cache-optimizer")?.handler("fix", {
        model,
        hasUI: true,
        sessionManager: { getSessionId: () => "no-evidence-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async () => { confirmations++; return true; },
          notify: (message: string) => notifications.push(message),
          setStatus() {},
        },
      });
      assert.equal(confirmations, 0);
      assert.equal(notifications.some((message) => /prompt.?cache.?key/i.test(message)), false);
      assert.equal((await readdir(tempAgentDir)).some((name) => name.includes("config")), false);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("evidence-driven command fix overrides extension runtime compat at modelOverrides", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-runtime-compat-fix-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    const modelsPath = join(tempAgentDir, "models.json");
    const original = `{
  "providers": {
    "runtime-shadow-proxy": {
      "baseUrl": "https://proxy.example/v1",
      "models": [{
        "id": "deepseek-runtime-shadow",
        "compat": { "thinkingFormat": "deepseek" }
      }]
    }
  }
}`;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, original, { encoding: "utf8", mode: 0o600 });
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand(name: string, command: { handler: (args: string, context: any) => Promise<void> }) {
          commands.set(name, command);
        },
      } as any);
      const modelWithRuntimeCompat = {
        provider: "runtime-shadow-proxy",
        id: "deepseek-runtime-shadow",
        name: "DeepSeek Runtime Shadow",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: { thinkingFormat: "deepseek" },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      } as any;
      const notifications: string[] = [];
      const context = {
        model: modelWithRuntimeCompat,
        hasUI: true,
        sessionManager: { getSessionId: () => "runtime-shadow-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async () => true,
          notify: (message: string) => notifications.push(message),
          setStatus() {},
        },
      };
      handlers.get("before_provider_request")?.({ payload: {} }, context);
      await handlers.get("after_provider_response")?.({
        status: 400,
        headers: { "x-provider-error": "thinking is unsupported; use reasoning_effort instead" },
      }, context);
      await commands.get("cache-optimizer")?.handler("fix", context);

      const parsed = freshModule.__internals_for_tests.parseJsonc(await readFile(modelsPath, "utf8")) as any;
      assert.equal(
        parsed.providers[modelWithRuntimeCompat.provider].modelOverrides[modelWithRuntimeCompat.id].compat.thinkingFormat,
        "openai",
      );
      assert.equal(
        freshModule.__internals_for_tests.resolveEffectiveCompatFromConfig(modelWithRuntimeCompat, parsed).thinkingFormat,
        "openai",
      );
      assert.ok(notifications.some((message) => message.includes("Fix applied")));
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("/cache-optimizer fix command", () => {
  test("direct and menu paths repair the effective modelOverride", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-fix-command-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    const modelsPath = join(tempAgentDir, "models.json");
    const original = `{
  "providers": {
    "proxy": {
      // Credential and endpoint configuration must survive the fix.
      "apiKey": "env:PROXY_API_KEY",
      "baseUrl": "https://proxy.example/v1",
      "api": "openai-completions",
      "compat": {
        "providerOnly": "preserved"
      },
      "models": [
        {
          "id": "deepseek-v4",
          "name": "DeepSeek V4",
          "compat": {
            "modelOnly": "preserved"
          }
        }
      ],
      "modelOverrides": {
        "deepseek-v4": {
          "compat": {
            "supportsLongCacheRetention": false,
            "overrideOnly": "preserved"
          },
          "metadata": "keep-me"
        }
      },
      "unrelatedProviderField": 42
    }
  }
}`;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, original, "utf8");
      await chmod(modelsPath, 0o600);

      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const commands = new Map<string, { handler: (args: string, context: any) => unknown }>();
      freshModule.default({
        on() {},
        registerCommand(name: string, command: { handler: (args: string, context: any) => unknown }) {
          commands.set(name, command);
        },
      } as any);

      const command = commands.get("cache-optimizer");
      assert.ok(command);
      const confirmations: Array<{ title: string; message: string }> = [];
      const notifications: Array<{ message: string; level: string }> = [];
      const menuPrompts: Array<{ title: string; options: string[] }> = [];
      let menuChoice: string | undefined;
      const model = {
        provider: "proxy",
        id: "deepseek-v4",
        name: "DeepSeek V4",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const commandContext = {
        model,
        hasUI: true,
        sessionManager: { getSessionId: () => "fix-command-test-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async (title: string, message: string) => {
            confirmations.push({ title, message });
            return true;
          },
          notify: (message: string, level: string) => notifications.push({ message, level }),
          setStatus() {},
          select: async (title: string, options: string[]) => {
            menuPrompts.push({ title, options });
            return menuChoice;
          },
        },
      };

      const assertApplied = async (expectedMode: number): Promise<string> => {
        assert.equal(confirmations.length, 1);
        assert.match(confirmations[0].title, /Fix/);
        assert.match(confirmations[0].message, /modelOverrides/);
        assert.ok(notifications.some(({ message }) => message.includes("Fix applied")));

        const backupNames = (await readdir(tempAgentDir)).filter((name) =>
          name.startsWith("models.json.backup-cache-optimizer-")
        );
        assert.equal(backupNames.length, 1);
        assert.equal(await readFile(join(tempAgentDir, backupNames[0]), "utf8"), original);
        assert.equal((await stat(join(tempAgentDir, backupNames[0]))).mode & 0o7777, expectedMode);
        assert.equal((await stat(modelsPath)).mode & 0o7777, expectedMode);

        const written = await readFile(modelsPath, "utf8");
        const parsed = freshModule.__internals_for_tests.parseJsonc(written) as any;
        assert.ok(parsed);
        assert.deepEqual(
          freshModule.__internals_for_tests.resolveExplicitCompatValue(
            parsed,
            "proxy",
            "deepseek-v4",
            "supportsLongCacheRetention",
          ),
          { source: "modelOverride", value: false },
        );
        assert.deepEqual(
          freshModule.__internals_for_tests.resolveExplicitCompatValue(
            parsed,
            "proxy",
            "deepseek-v4",
            "sendSessionAffinityHeaders",
          ),
          { source: "modelOverride", value: true },
        );
        assert.equal(
          freshModule.__internals_for_tests.resolveExplicitCompatValue(
            parsed,
            "proxy",
            "deepseek-v4",
            "thinkingFormat",
          ),
          undefined,
        );
        assert.match(written, /\/\/ Credential and endpoint configuration must survive the fix\./);
        assert.equal(parsed.providers.proxy.apiKey, "env:PROXY_API_KEY");
        assert.equal(parsed.providers.proxy.unrelatedProviderField, 42);
        assert.equal(parsed.providers.proxy.compat.providerOnly, "preserved");
        assert.equal(parsed.providers.proxy.models[0].compat.modelOnly, "preserved");
        assert.equal(parsed.providers.proxy.modelOverrides["deepseek-v4"].compat.overrideOnly, "preserved");
        assert.equal(parsed.providers.proxy.modelOverrides["deepseek-v4"].metadata, "keep-me");
        return backupNames[0];
      };

      await command.handler("fix", commandContext);
      assert.equal(menuPrompts.length, 0);
      const directBackup = await assertApplied(0o600);

      await rm(join(tempAgentDir, directBackup));
      await writeFile(modelsPath, original, "utf8");
      await chmod(modelsPath, 0o644);
      confirmations.length = 0;
      notifications.length = 0;
      menuChoice = "Fix — Auto-fix compat issues (writes models.json or extension config)";

      await command.handler("", commandContext);
      assert.equal(menuPrompts.length, 1);
      assert.ok(menuPrompts[0].options.includes(menuChoice));
      assert.ok(menuPrompts[0].options.includes("Rollback — Undo the latest confirmed fix"));
      const menuBackup = await assertApplied(0o644);
      assert.equal((await stat(join(tempAgentDir, menuBackup))).mode & 0o7777, 0o644);
      assert.equal((await stat(modelsPath)).mode & 0o7777, 0o644);

      confirmations.length = 0;
      menuChoice = "Rollback — Undo the latest confirmed fix";
      await command.handler("", commandContext);
      assert.equal(confirmations.filter(({ title }) => /Rollback/.test(title)).length, 1);
      assert.equal(await readFile(modelsPath, "utf8"), original);

      const helpMessages: string[] = [];
      await command.handler("", {
        ...commandContext,
        hasUI: false,
        ui: { ...commandContext.ui, notify: (message: string) => helpMessages.push(message) },
      });
      assert.match(helpMessages.at(-1) ?? "", /rollback.*requires UI confirmation/i);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("receipt captures only scalar fix metadata and exact hash relationships", async () => {
    const original = `{
  "providers": {
    "proxy": {
      "apiKey": "env:SECRET",
      "models": [{ "id": "deepseek-v4", "compat": { "sendSessionAffinityHeaders": false } }]
    }
  }
}`;
    const modified = original.replace('"sendSessionAffinityHeaders": false', '"sendSessionAffinityHeaders": true');
    const receipt = internals.createModelsJsonFixReceipt(
      original,
      modified,
      "proxy",
      "deepseek-v4",
      "model",
      { sendSessionAffinityHeaders: true },
      true,
      "/tmp/models.json.backup-cache-optimizer-receipt-test",
      1_700_000_000_000,
    );
    assert.ok(receipt);
    assert.equal(receipt.beforeHash, internals.hashText(original));
    assert.equal(receipt.afterHash, internals.hashText(modified));
    assert.deepEqual(receipt.changedKeys, {
      sendSessionAffinityHeaders: {
        before: { present: true, value: false },
        after: { present: true, value: true },
      },
    });
    assert.equal("apiKey" in receipt, false);
    assert.equal(JSON.stringify(receipt).includes("SECRET"), false);
    assert.equal(JSON.stringify(receipt).includes("prompt"), false);
    assert.equal(JSON.stringify(receipt).includes("payload"), false);
    assert.equal(
      internals.parseModelsJsonFixReceipt({
        ...receipt,
        changedKeys: {
          apiKey: {
            before: { present: false },
            after: { present: true, value: "env:SECRET" },
          },
        },
      }),
      undefined,
    );
  });

  test("transaction rollback restores original content and access mode", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-fix-rollback-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const modelsPath = join(tempAgentDir, "models.json");
    const original = `{"providers": {}}\n`;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, original, "utf8");
      await chmod(modelsPath, 0o604);

      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const backupPath = `${modelsPath}.backup-cache-optimizer-${freshModule.__internals_for_tests.backupTimestamp()}`;
      const result = await freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
        `{"providers": {"proxy": {}}}\n`,
        backupPath,
        () => "forced post-write validation failure",
      );

      assert.deepEqual(result, {
        ok: false,
        postCheckError: "forced post-write validation failure",
      });
      assert.equal(await readFile(modelsPath, "utf8"), original);
      assert.equal((await stat(modelsPath)).mode & 0o7777, 0o604);
      assert.equal(await readFile(backupPath, "utf8"), original);
      assert.equal((await stat(backupPath)).mode & 0o7777, 0o604);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("rollback restores receipt-owned keys surgically and preserves later changes", () => {
    const original = `{
  "providers": {
    "proxy": {
      "models": [{ "id": "deepseek-v4", "compat": { "sendSessionAffinityHeaders": false } }]
    }
  }
}`;
    const fixed = original.replace('"sendSessionAffinityHeaders": false', '"sendSessionAffinityHeaders": true');
    const receipt = internals.createModelsJsonFixReceipt(
      original,
      fixed,
      "proxy",
      "deepseek-v4",
      "model",
      { sendSessionAffinityHeaders: true },
      true,
      "/tmp/models.json.backup-cache-optimizer-surgical-test",
      1_700_000_000_000,
    );
    assert.ok(receipt);
    const later = fixed.replace('"sendSessionAffinityHeaders": true', '"sendSessionAffinityHeaders": true,\n      "later": "keep"');
    const rollback = internals.composeModelsJsonReceiptRollback(later, receipt);
    assert.equal("error" in rollback, false);
    if (!("error" in rollback)) {
      assert.match(rollback.modifiedText, /"sendSessionAffinityHeaders": false/);
      assert.match(rollback.modifiedText, /"later": "keep"/);
      assert.equal(internals.validateModelsJsonRollback(rollback.modifiedText, receipt), null);
    }

    const changedOwnedKey = later.replace('"sendSessionAffinityHeaders": true', '"sendSessionAffinityHeaders": false');
    assert.match(
      "error" in internals.composeModelsJsonReceiptRollback(changedOwnedKey, receipt)
        ? (internals.composeModelsJsonReceiptRollback(changedOwnedKey, receipt) as { error: string }).error
        : "",
      /changed after the fix/,
    );

    const removedTarget = later.replace('"deepseek-v4"', '"renamed-after-fix"');
    assert.match(
      "error" in internals.composeModelsJsonReceiptRollback(removedTarget, receipt)
        ? (internals.composeModelsJsonReceiptRollback(removedTarget, receipt) as { error: string }).error
        : "",
      /(?:could not locate receipt target|target entry is missing)/i,
    );

    const createdTargetOriginal = `{
  "providers": {
    "proxy": { "models": [{ "id": "deepseek-v4" }] }
  }
}`;
    const createdTargetFixed = `{
  "providers": {
    "proxy": {
      "models": [{ "id": "deepseek-v4" }],
      "modelOverrides": {
        "deepseek-v4": { "compat": { "sendSessionAffinityHeaders": true } }
      }
    }
  }
}`;
    const createdTargetReceipt = internals.createModelsJsonFixReceipt(
      createdTargetOriginal,
      createdTargetFixed,
      "proxy",
      "deepseek-v4",
      "modelOverride",
      { sendSessionAffinityHeaders: true },
      false,
      "/tmp/models.json.backup-cache-optimizer-created-target-test",
      1_700_000_000_000,
    );
    assert.ok(createdTargetReceipt);
    const createdTargetChanged = createdTargetFixed.replace('"models":', '"later": "keep",\n      "models":');
    assert.match(
      "error" in internals.composeModelsJsonReceiptRollback(createdTargetChanged, createdTargetReceipt)
        ? (internals.composeModelsJsonReceiptRollback(createdTargetChanged, createdTargetReceipt) as { error: string }).error
        : "",
      /created (?:a )?new target entry/,
    );
  });

  test("refuses to overwrite an existing backup or modify models.json", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-fix-exclusive-backup-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const modelsPath = join(tempAgentDir, "models.json");
    const backupPath = join(tempAgentDir, "models.json.backup-cache-optimizer-existing");
    const original = `{"providers": {}}\n`;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, original, "utf8");
      await chmod(modelsPath, 0o600);
      await writeFile(backupPath, "do-not-overwrite", "utf8");

      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );

      await assert.rejects(
        freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
          `{"providers": {"proxy": {}}}\n`,
          backupPath,
          () => null,
        ),
      );
      assert.equal(await readFile(modelsPath, "utf8"), original);
      assert.equal((await stat(modelsPath)).mode & 0o7777, 0o600);
      assert.equal(await readFile(backupPath, "utf8"), "do-not-overwrite");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("refuses symlinked transaction paths and expected-hash races", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-fix-symlink-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const modelsPath = join(tempAgentDir, "models.json");
    const targetPath = join(tempAgentDir, "models-target.json");
    const backupPath = join(tempAgentDir, "models.json.backup-cache-optimizer-symlink");
    const original = `{"providers": {}}\n`;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(targetPath, original, "utf8");
      await symlink(targetPath, modelsPath);
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );

      assert.equal((await lstat(modelsPath)).isSymbolicLink(), true);
      await assert.rejects(
        freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
          `{"providers": {"proxy": {}}}\n`,
          backupPath,
          () => null,
          { expectedCurrentHash: freshModule.__internals_for_tests.hashText(original) },
        ),
        /not a regular file/,
      );
      assert.equal(await readFile(targetPath, "utf8"), original);

      await rm(modelsPath, { force: true });
      await writeFile(modelsPath, original, "utf8");
      const backupTarget = join(tempAgentDir, "backup-target.json");
      await writeFile(backupTarget, original, "utf8");
      await symlink(backupTarget, backupPath);
      await assert.rejects(
        freshModule.__internals_for_tests.atomicRestoreFileFromBackup(backupPath, modelsPath, 0o600),
        /backup is not a regular file/,
      );
      assert.equal(await readFile(modelsPath, "utf8"), original);

      await rm(backupPath, { force: true });
      await assert.rejects(
        freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
          `{"providers": {"proxy": {}}}\n`,
          backupPath,
          () => null,
          { expectedCurrentHash: freshModule.__internals_for_tests.hashText("different") },
        ),
        /changed since the fix preview/,
      );
      assert.equal(await readFile(modelsPath, "utf8"), original);

      await chmod(modelsPath, 0o640);
      await assert.rejects(
        freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
          `{"providers": {"proxy": {}}}\n`,
          join(tempAgentDir, "models.json.backup-cache-optimizer-mode-race"),
          () => null,
          {
            expectedCurrentHash: freshModule.__internals_for_tests.hashText(original),
            expectedCurrentMode: 0o600,
          },
        ),
        /access mode changed since the fix preview/,
      );
      assert.equal(await readFile(modelsPath, "utf8"), original);
      assert.equal((await stat(modelsPath)).mode & 0o7777, 0o640);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("rejects real target swaps at the final atomic rename boundary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-final-rename-race-test-"));
    const targetPath = join(tempDir, "models.json");
    const backupPath = join(tempDir, "models.json.backup-cache-optimizer-race");
    const original = '{"providers":{"a":{}}}\n';
    const replacement = '{"providers":{"b":{}}}\n';
    const external = '{"providers":{"external":{}}}\n';
    try {
      await writeFile(targetPath, original, { encoding: "utf8", mode: 0o600 });
      await writeFile(backupPath, original, { encoding: "utf8", mode: 0o600 });
      await assert.rejects(
        internals.atomicReplaceTextFilePreservingMode(
          targetPath,
          replacement,
          0o600,
          "fix-race-test",
          { hash: internals.hashText(original), mode: 0o600 },
          async () => {
            await writeFile(targetPath, external, { encoding: "utf8", mode: 0o600 });
          },
        ),
        /target content changed during atomic replacement/,
      );
      assert.equal(await readFile(targetPath, "utf8"), external);

      await writeFile(targetPath, replacement, { encoding: "utf8", mode: 0o600 });
      await assert.rejects(
        internals.atomicRestoreFileFromBackup(
          backupPath,
          targetPath,
          0o600,
          { hash: internals.hashText(replacement), mode: 0o600, backupHash: internals.hashText(original) },
          async () => {
            await writeFile(targetPath, external, { encoding: "utf8", mode: 0o600 });
          },
        ),
        /target content changed during atomic replacement/,
      );
      assert.equal(await readFile(targetPath, "utf8"), external);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("models.json transactions serialize across concurrent Pi instances", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-transaction-lock-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const modelsPath = join(tempAgentDir, "models.json");
    const original = `{"providers":{}}\n`;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, original, { encoding: "utf8", mode: 0o600 });
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      let releaseFirst!: () => void;
      const firstCommitted = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
      const hash = freshModule.__internals_for_tests.hashText(original);
      const first = freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
        `{"providers":{"first":{}}}\n`,
        join(tempAgentDir, "models.json.backup-cache-optimizer-lock-first"),
        () => null,
        {
          expectedCurrentHash: hash,
          onCommitted: async () => {
            firstEntered();
            await firstCommitted;
          },
        },
      );
      await firstStarted;
      const second = freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
        `{"providers":{"second":{}}}\n`,
        join(tempAgentDir, "models.json.backup-cache-optimizer-lock-second"),
        () => null,
        { expectedCurrentHash: hash },
      );
      releaseFirst();
      assert.deepEqual((await Promise.allSettled([first, second])).map((result) => result.status), ["fulfilled", "rejected"]);
      assert.equal(await readFile(modelsPath, "utf8"), `{"providers":{"first":{}}}\n`);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("receipt atomic write rejects a replacement at the final rename boundary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-receipt-final-race-test-"));
    const receiptPath = join(tempDir, "receipt.json");
    const originalText = '{"providers":{"proxy":{"models":[{"id":"deepseek-race","compat":{}}]}}}';
    const modifiedText = '{"providers":{"proxy":{"models":[{"id":"deepseek-race","compat":{"sendSessionAffinityHeaders":true}}]}}}';
    const originalReceipt = internals.createModelsJsonFixReceipt(
      originalText,
      modifiedText,
      "proxy",
      "deepseek-race",
      "model",
      { sendSessionAffinityHeaders: true },
      true,
      "models.json.backup-cache-optimizer-original",
      10,
    );
    const replacementReceipt = internals.createModelsJsonFixReceipt(
      originalText,
      modifiedText,
      "proxy",
      "deepseek-race",
      "model",
      { sendSessionAffinityHeaders: true },
      true,
      "models.json.backup-cache-optimizer-replacement",
      20,
    );
    assert.ok(originalReceipt && replacementReceipt);
    try {
      await internals.writeModelsJsonFixReceipt(originalReceipt, receiptPath);
      const snapshot = await internals.readModelsJsonFixReceiptSnapshot(receiptPath);
      assert.ok(snapshot);
      await assert.rejects(
        internals.writeModelsJsonFixReceipt(
          { ...originalReceipt, status: "rolled_back", rolledBackAt: 30 },
          receiptPath,
          snapshot,
          async () => {
            await writeFile(receiptPath, JSON.stringify(replacementReceipt, null, 2) + "\n", "utf8");
          },
        ),
        /fix receipt changed/,
      );
      assert.equal((await internals.readModelsJsonFixReceipt(receiptPath))?.transactionId, replacementReceipt.transactionId);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("receipt replacement after preview aborts rollback without changing models.json", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-receipt-cas-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const modelsPath = join(tempAgentDir, "models.json");
    const receiptPath = join(tempAgentDir, "pi-cache-optimizer-fix-receipt.json");
    const original = `{"providers":{"proxy":{"models":[{"id":"deepseek-v4","compat":{"sendSessionAffinityHeaders":false}}]}}}\n`;
    const fixed = original.replace("false", "true");

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, fixed, { encoding: "utf8", mode: 0o600 });
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const receiptA = freshModule.__internals_for_tests.createModelsJsonFixReceipt(
        original,
        fixed,
        "proxy",
        "deepseek-v4",
        "model",
        { sendSessionAffinityHeaders: true },
        true,
        join(tempAgentDir, "models.json.backup-cache-optimizer-a"),
        1,
      );
      assert.ok(receiptA);
      await writeFile(join(tempAgentDir, receiptA.backupFile), original, "utf8");
      await freshModule.__internals_for_tests.writeModelsJsonFixReceipt(receiptA, receiptPath);
      const snapshot = await freshModule.__internals_for_tests.readModelsJsonFixReceiptSnapshot(receiptPath);
      assert.ok(snapshot);
      const plan = await freshModule.__internals_for_tests.prepareModelsJsonRollback(snapshot, modelsPath);
      assert.equal("error" in plan, false);
      if ("error" in plan) return;

      const receiptB = { ...receiptA, transactionId: "replacement", modelId: "other-model" };
      await freshModule.__internals_for_tests.writeModelsJsonFixReceipt(receiptB, receiptPath);
      await assert.rejects(
        freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
          plan.modifiedText,
          plan.rollbackBackupPath,
          (writtenText: string) => freshModule.__internals_for_tests.validateModelsJsonRollback(
            writtenText,
            plan.receipt,
            plan.expectedResultHash,
          ),
          {
            expectedCurrentHash: plan.currentHash,
            expectedCurrentMode: plan.fileMode,
            receiptGuard: snapshot,
            purpose: "rollback",
          },
        ),
        /fix receipt changed since the rollback preview/,
      );
      assert.equal(await readFile(modelsPath, "utf8"), fixed);
      assert.equal((await readdir(tempAgentDir)).some((name) => name.startsWith("models.json.backup-cache-optimizer-rollback-")), false);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("direct rollback command restores an unchanged fix and marks the receipt", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-fix-command-rollback-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    const modelsPath = join(tempAgentDir, "models.json");
    const original = `{
  "providers": {
    "proxy": {
      // Keep credentials and comments through both transactions.
      "apiKey": "env:SECRET",
      "baseUrl": "https://proxy.example/v1",
      "models": [{ "id": "deepseek-v4", "name": "DeepSeek V4" }]
    }
  }
}`;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, original, "utf8");
      await chmod(modelsPath, 0o640);

      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
      freshModule.default({
        on() {},
        registerCommand(name: string, command: { handler: (args: string, context: any) => Promise<void> }) {
          commands.set(name, command);
        },
      } as any);
      const command = commands.get("cache-optimizer");
      assert.ok(command);

      const model = {
        provider: "proxy",
        id: "deepseek-v4",
        name: "DeepSeek V4",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const confirmations: string[] = [];
      const notifications: string[] = [];
      const context = {
        model,
        hasUI: true,
        sessionManager: { getSessionId: () => "rollback-command-test-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async (title: string) => {
            confirmations.push(title);
            return true;
          },
          notify: (message: string) => notifications.push(message),
          setStatus() {},
          select: async () => undefined,
        },
      };

      await command.handler("fix", context);
      const fixed = await readFile(modelsPath, "utf8");
      assert.notEqual(fixed, original);
      assert.equal((await stat(modelsPath)).mode & 0o7777, 0o640);
      const receiptPath = join(tempAgentDir, freshModule.__internals_for_tests.FIX_RECEIPT_FILE_NAME);
      const receiptBeforeRollback = freshModule.__internals_for_tests.parseModelsJsonFixReceipt(
        JSON.parse(await readFile(receiptPath, "utf8")),
      );
      assert.ok(receiptBeforeRollback);
      assert.equal(receiptBeforeRollback.status, undefined);
      assert.equal(receiptBeforeRollback.afterHash, freshModule.__internals_for_tests.hashText(fixed));
      assert.equal((await stat(receiptPath)).mode & 0o7777, 0o600);

      await command.handler("rollback", { ...context, hasUI: false });
      assert.equal(await readFile(modelsPath, "utf8"), fixed);
      assert.ok(notifications.some((message) => message.includes(receiptBeforeRollback.backupFile)));
      assert.equal(confirmations.filter((title) => /Rollback/.test(title)).length, 0);

      await command.handler("rollback", context);
      assert.equal(confirmations.filter((title) => /Rollback/.test(title)).length, 1);
      assert.equal(await readFile(modelsPath, "utf8"), original);
      assert.equal((await stat(modelsPath)).mode & 0o7777, 0o640);
      assert.ok(notifications.some((message) => message.includes("Rollback completed")));
      assert.ok(notifications.some((message) => /run \/reload/i.test(message)));
      const receiptAfterRollback = freshModule.__internals_for_tests.parseModelsJsonFixReceipt(
        JSON.parse(await readFile(receiptPath, "utf8")),
      );
      assert.equal(receiptAfterRollback?.status, "rolled_back");
      assert.equal(receiptAfterRollback?.rolledBackAt !== undefined, true);
      const rollbackBackups = (await readdir(tempAgentDir)).filter((name) =>
        name.startsWith("models.json.backup-cache-optimizer-rollback-"),
      );
      assert.equal(rollbackBackups.length, 1);
      assert.equal(await readFile(join(tempAgentDir, rollbackBackups[0]), "utf8"), fixed);
      assert.equal((await stat(join(tempAgentDir, rollbackBackups[0]))).mode & 0o7777, 0o640);

      const notificationCount = notifications.length;
      await command.handler("rollback", context);
      assert.equal(notifications.length, notificationCount + 1);
      assert.match(notifications.at(-1) ?? "", /No unapplied \/cache-optimizer fix receipt was found/);
      assert.equal(confirmations.filter((title) => /Rollback/.test(title)).length, 1);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("restores models.json atomically when receipt commit fails", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-fix-receipt-failure-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const modelsPath = join(tempAgentDir, "models.json");
    const backupPath = join(tempAgentDir, "models.json.backup-cache-optimizer-receipt-failure");
    const original = '{\n  "providers": { "proxy": { "models": [{ "id": "model" }] } }\n}\n';

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(modelsPath, original, "utf8");
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const modified = original.replace('"models"', '"compat": { "sendSessionAffinityHeaders": true }, "models"');
      await assert.rejects(
        freshModule.__internals_for_tests.applyModelsJsonFixTransaction(
          modified,
          backupPath,
          () => null,
          {
            expectedCurrentHash: freshModule.__internals_for_tests.hashText(original),
            onCommitted: async () => {
              throw new Error("simulated receipt write failure");
            },
          },
        ),
        /simulated receipt write failure/,
      );
      assert.equal(await readFile(modelsPath, "utf8"), original);
      assert.equal(await readFile(backupPath, "utf8"), original);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("backup names remain unique within the same millisecond", () => {
    const now = new Date("2026-08-17T12:34:56.789Z");
    const first = internals.backupTimestamp(now);
    const second = internals.backupTimestamp(now);
    assert.notEqual(first, second);
  });
});

describe("prompt_cache_key model opt-out", () => {
  const model = {
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
  } as any;

  test("parses v1 and v2 config without accepting malformed or private data", () => {
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "Unsupported parameter: prompt_cache_key" }), true);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "Unknown field promptCacheKey" }), true);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "prompt_cache_key is not supported" }), true);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "Invalid parameter value for prompt_cache_key" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "Unsupported parameter value for prompt_cache_key" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "The prompt_cache_key value is not supported" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "prompt_cache_key must be omitted when temperature is set" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "prompt_cache_key is not allowed when temperature is set" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "promptCacheKey is not permitted with stream=true" }), false);
    assert.deepEqual(internals.parsePersistedCacheOptimizerConfig({ version: 1, footerMode: "total" }), { version: 1, footerMode: "total" });
    assert.deepEqual(
      internals.parsePersistedCacheOptimizerConfig({ version: 2, footerMode: "session", promptCacheKey: { omit: ["z/model", "a/model", "a/model"] } }),
      { version: 2, footerMode: "session", promptCacheKey: { omit: ["a/model", "z/model"] } },
    );
    assert.equal(internals.parsePersistedCacheOptimizerConfig({ version: 2, promptCacheKey: { omit: ["proxy/model", 4] } }), undefined);
    assert.equal(internals.parsePersistedCacheOptimizerConfig({ version: 2, promptCacheKey: { omit: ["proxy/model"], prompt: "secret" } }), undefined);
  });

  test("omits both key spellings only for the exact configured model", () => {
    internals.setRuntimeOptimizerEnabled(true);
    const config = { version: 2 as const, footerMode: "total" as const, promptCacheKey: { omit: ["proxy/gpt-5.5"] } };
    assert.equal(internals.isPromptCacheKeyOmittedForModel(model, config), true);
    assert.equal(internals.isPromptCacheKeyOmittedForModel({ ...model, id: "gpt-5.6" }, config), false);
    assert.equal(internals.isPromptCacheKeyOmittedForModel({ ...model, provider: "other" }, config), false);
    assert.deepEqual(
      internals.omitOpenAIPromptCacheKeys({ prompt_cache_key: "pi", promptCacheKey: "caller", keep: 1 }),
      { keep: 1 },
    );
    assert.equal(internals.omitOpenAIPromptCacheKeys({ keep: 1 }), undefined);
  });

  test("migrates v1 footer config, applies exact omit, and rolls it back", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-config-test-"));
    const configPath = join(tempDir, "pi-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "pi-cache-optimizer-config-receipt.json");
    const original = JSON.stringify({ version: 1, footerMode: "total" }, null, 2) + "\n";
    try {
      await writeFile(configPath, original, { encoding: "utf8", mode: 0o640 });
      const applied = await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      const parsed = internals.readPersistedCacheOptimizerConfig(configPath);
      assert.deepEqual(parsed, { version: 2, footerMode: "total", promptCacheKey: { omit: ["proxy/gpt-5.5"] } });
      assert.equal((await stat(configPath)).mode & 0o7777, 0o640);
      assert.equal(await readFile(applied.backupPath, "utf8"), original);
      assert.equal((await stat(applied.backupPath)).mode & 0o7777, 0o640);
      const receiptSnapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(receiptSnapshot);
      const receipt = receiptSnapshot.receipt;
      assert.equal(receipt.addedModelKey, "proxy/gpt-5.5");
      assert.equal(receipt.targetHadModelKey, false);
      assert.equal(JSON.stringify(receipt).includes("prompt_cache_key"), false);
      await internals.rollbackPromptCacheKeyConfig(receiptSnapshot, configPath, receiptPath);
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.deepEqual(internals.readPersistedCacheOptimizerConfig(configPath), { version: 2, footerMode: "total" });
      assert.equal((await internals.readPromptCacheKeyConfigReceipt(receiptPath))?.status, "rolled_back");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fix receipt failure restores both existing and absent config targets", async () => {
    for (const targetExists of [true, false]) {
      const tempDir = await mkdtemp(join(tmpdir(), `pi-cache-key-config-fix-receipt-failure-${targetExists}-`));
      const configPath = join(tempDir, "pi-cache-optimizer-config.json");
      const receiptPath = join(tempDir, "pi-cache-optimizer-config-receipt.json");
      const original = JSON.stringify({ version: 1, footerMode: "total" }, null, 2) + "\n";
      try {
        if (targetExists) await writeFile(configPath, original, { encoding: "utf8", mode: 0o640 });
        await mkdir(receiptPath);
        await assert.rejects(
          internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath),
          /invalid prompt-cache-key receipt path/,
        );
        if (targetExists) {
          assert.equal(await readFile(configPath, "utf8"), original);
          assert.equal((await stat(configPath)).mode & 0o7777, 0o640);
        } else {
          await assert.rejects(readFile(configPath, "utf8"), (error: any) => error?.code === "ENOENT");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  test("receipt replacement after preview aborts config rollback and restores the post-fix config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-config-receipt-race-test-"));
    const configPath = join(tempDir, "pi-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "pi-cache-optimizer-config-receipt.json");
    const original = JSON.stringify({ version: 1, footerMode: "total" }, null, 2) + "\n";
    try {
      await writeFile(configPath, original, { encoding: "utf8", mode: 0o640 });
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      const fixed = await readFile(configPath, "utf8");
      const snapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(snapshot);
      const replacement = { ...snapshot.receipt, transactionId: "replacement-transaction" };

      await assert.rejects(
        internals.rollbackPromptCacheKeyConfig(snapshot, configPath, receiptPath, {
          beforeReceiptRename: async () => {
            await writeFile(receiptPath, JSON.stringify(replacement, null, 2) + "\n", "utf8");
          },
        }),
        /prompt-cache-key receipt changed/,
      );
      assert.equal(await readFile(configPath, "utf8"), fixed);
      assert.equal((await internals.readPromptCacheKeyConfigReceipt(receiptPath))?.transactionId, "replacement-transaction");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("atomic config creation never overwrites a file that appears at the final boundary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-config-create-race-test-"));
    const configPath = join(tempDir, "pi-cache-optimizer-config.json");
    try {
      await assert.rejects(
        internals.atomicCreateTextFileNoReplace(
          configPath,
          "extension-content\n",
          0o600,
          "config-test",
          async () => writeFile(configPath, "user-content\n", "utf8"),
        ),
        (error: any) => error?.code === "EEXIST",
      );
      assert.equal(await readFile(configPath, "utf8"), "user-content\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("receipt update failure recreates a newly-created post-fix config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-new-config-receipt-failure-test-"));
    const configPath = join(tempDir, "pi-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "pi-cache-optimizer-config-receipt.json");
    try {
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      const fixed = await readFile(configPath, "utf8");
      const snapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(snapshot);
      const replacement = { ...snapshot.receipt, transactionId: "replacement-new-config" };

      await assert.rejects(
        internals.rollbackPromptCacheKeyConfig(snapshot, configPath, receiptPath, {
          beforeReceiptRename: async () => {
            await writeFile(receiptPath, JSON.stringify(replacement, null, 2) + "\n", "utf8");
          },
        }),
        /prompt-cache-key receipt changed/,
      );
      assert.equal(await readFile(configPath, "utf8"), fixed);
      assert.equal((await internals.readPromptCacheKeyConfigReceipt(receiptPath))?.transactionId, "replacement-new-config");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("direct repeated fixes reject without changing config or receipt", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-repeat-config-test-"));
    const configPath = join(tempDir, "pi-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "pi-cache-optimizer-config-receipt.json");
    try {
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      const configBefore = await readFile(configPath, "utf8");
      const receiptBefore = await readFile(receiptPath, "utf8");
      await assert.rejects(
        internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath),
        /already configured; no changes were made/,
      );
      assert.equal(await readFile(configPath, "utf8"), configBefore);
      assert.equal(await readFile(receiptPath, "utf8"), receiptBefore);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("multiple model fixes preserve earlier opt-outs and rollback only the latest change", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-multi-config-test-"));
    const configPath = join(tempDir, "pi-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "pi-cache-optimizer-config-receipt.json");
    const otherModel = { ...model, id: "gpt-5.6", name: "GPT-5.6" };
    try {
      await writeFile(configPath, JSON.stringify({ version: 2, footerMode: "process", promptCacheKey: { omit: ["proxy/existing"] } }, null, 2) + "\n", { mode: 0o640 });
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      await internals.applyPromptCacheKeyConfigFix(otherModel, configPath, receiptPath);
      assert.deepEqual(internals.readPersistedCacheOptimizerConfig(configPath).promptCacheKey?.omit, ["proxy/existing", "proxy/gpt-5.5", "proxy/gpt-5.6"]);
      const receiptSnapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(receiptSnapshot);
      await internals.rollbackPromptCacheKeyConfig(receiptSnapshot, configPath, receiptPath);
      assert.deepEqual(internals.readPersistedCacheOptimizerConfig(configPath), {
        version: 2,
        footerMode: "process",
        promptCacheKey: { omit: ["proxy/existing", "proxy/gpt-5.5"] },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("active fix requires confirmation and removes a Pi-provided key after reload", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-key-command-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(join(tempAgentDir, "pi-cache-optimizer-config.json"), JSON.stringify({ version: 1, footerMode: "process" }) + "\n");
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      const commands = new Map<string, { handler: (args: string, context: any) => unknown }>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
        registerCommand(name: string, command: { handler: (args: string, context: any) => unknown }) { commands.set(name, command); },
      } as any);
      const notifications: string[] = [];
      let confirm = false;
      const confirmationMessages: string[] = [];
      const context = {
        model,
        hasUI: true,
        sessionManager: { getSessionId: () => "fixture-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async (_title: string, message: string) => { confirmationMessages.push(message); return confirm; },
          notify: (message: string) => notifications.push(message),
          setStatus() {},
        },
      };
      await commands.get("cache-optimizer")?.handler("fix prompt-cache-key", context);
      assert.match(confirmationMessages.at(-1) ?? "", /prompt_cache_key.*promptCacheKey/s);
      assert.deepEqual(freshModule.__internals_for_tests.readPersistedCacheOptimizerConfig(), { version: 2, footerMode: "process" });
      confirm = true;
      await commands.get("cache-optimizer")?.handler("fix prompt-cache-key", context);
      assert.deepEqual(freshModule.__internals_for_tests.readPersistedCacheOptimizerConfig(), { version: 2, footerMode: "process", promptCacheKey: { omit: ["proxy/gpt-5.5"] } });
      const payload = { prompt_cache_key: "pi-generated", promptCacheKey: "caller", keep: true };
      const result = handlers.get("before_provider_request")?.({ payload }, context) as any;
      assert.deepEqual(result, { keep: true });
      await commands.get("cache-optimizer")?.handler("fix prompt-cache-key", context);
      assert.match(notifications.at(-1) ?? "", /already omitted/);
      await commands.get("cache-optimizer")?.handler("rollback", context);
      assert.deepEqual(freshModule.__internals_for_tests.readPersistedCacheOptimizerConfig(), { version: 2, footerMode: "process" });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});
