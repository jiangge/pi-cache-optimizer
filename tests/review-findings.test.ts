import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

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
    const options = { promptGuidelines: [guideline.slice(2)] };

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
      contextFiles: [{ path: "AGENTS.md", content }],
    });

    assert.equal(result.changed, true);
    assert.equal(result.stablePrefix, fullContext);
    assert.equal(result.stablePrefix.split(content).length - 1, 1);
    assert.ok(result.systemPrompt.includes(dynamicBlock));
    assert.equal(result.systemPrompt.split(content).length - 1, 2);
  });
});

describe("Pi 0.83 adaptive-thinking compatibility", () => {
  function claudeModel(id: string, compat: Record<string, unknown> = {}) {
    return {
      provider: "anthropic",
      id,
      name: `Claude ${id}`,
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      compat,
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

      const assertApplied = async (): Promise<string> => {
        assert.equal(confirmations.length, 1);
        assert.match(confirmations[0].title, /Fix/);
        assert.match(confirmations[0].message, /modelOverrides/);
        assert.ok(notifications.some(({ message }) => message.includes("Fix applied")));

        const backupNames = (await readdir(tempAgentDir)).filter((name) =>
          name.startsWith("models.json.backup-cache-optimizer-")
        );
        assert.equal(backupNames.length, 1);
        assert.equal(await readFile(join(tempAgentDir, backupNames[0]), "utf8"), original);

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
          { source: "modelOverride", value: true },
        );
        assert.deepEqual(
          freshModule.__internals_for_tests.resolveExplicitCompatValue(
            parsed,
            "proxy",
            "deepseek-v4",
            "thinkingFormat",
          ),
          { source: "modelOverride", value: "deepseek" },
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
      const directBackup = await assertApplied();

      await rm(join(tempAgentDir, directBackup));
      await writeFile(modelsPath, original, "utf8");
      confirmations.length = 0;
      notifications.length = 0;
      menuChoice = "Fix — Auto-fix compat issues (writes models.json)";

      await command.handler("", commandContext);
      assert.equal(menuPrompts.length, 1);
      assert.ok(menuPrompts[0].options.includes(menuChoice));
      await assertApplied();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});
