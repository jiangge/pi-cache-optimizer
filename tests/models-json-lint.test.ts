import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

import {
  MODELS_JSON_COMPAT_KEYS,
  MODELS_JSON_MODEL_DEFINITION_KEYS,
  MODELS_JSON_MODEL_OVERRIDE_KEYS,
  MODELS_JSON_PROVIDER_KEYS,
  MODELS_JSON_ROOT_KEYS,
  buildModelsJsonLintDoctorLines,
  damerauLevenshtein,
  formatModelsJsonKeyTypo,
  lintModelsJsonKeys,
  lintModelsJsonText,
  normalizeModelsJsonKey,
  readModelsJsonKeyTypos,
  selectModelsJsonKeyTyposForTarget,
  suggestKnownKey,
} from "../src/models-json-lint.ts";

const ISSUE_30_HINT =
  '⚠️ providers["opencode-go"].model0verrides is not a known Pi key and looks like a typo of "modelOverrides"; Pi ignores unknown keys, so it most likely has no effect.';

describe("models.json near-miss key lint (issue #30)", () => {
  test("known key sets match the installed Pi schema exactly", async () => {
    const { ProviderCompatSchema } = await import("@earendil-works/pi-ai/providers/compat-schema");
    assert.deepEqual(
      [...MODELS_JSON_COMPAT_KEYS].sort(),
      Object.keys((ProviderCompatSchema as { properties: Record<string, unknown> }).properties).sort(),
    );
    // Not an exported subpath; load the installed file directly.
    const modelConfigUrl = pathToFileURL(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "model-config.js")).href;
    const { ModelsConfigSchema } = await import(modelConfigUrl) as {
      ModelsConfigSchema: { properties: Record<string, any> };
    };
    const root = ModelsConfigSchema.properties;
    assert.deepEqual([...MODELS_JSON_ROOT_KEYS].sort(), Object.keys(root).sort());
    const provider = root.providers.patternProperties
      ? Object.values(root.providers.patternProperties)[0] as any
      : root.providers.additionalProperties;
    assert.deepEqual([...MODELS_JSON_PROVIDER_KEYS].sort(), Object.keys(provider.properties).sort());
    assert.deepEqual([...MODELS_JSON_MODEL_DEFINITION_KEYS].sort(), Object.keys(provider.properties.models.items.properties).sort());
    const override = provider.properties.modelOverrides.patternProperties
      ? Object.values(provider.properties.modelOverrides.patternProperties)[0] as any
      : provider.properties.modelOverrides.additionalProperties;
    assert.deepEqual([...MODELS_JSON_MODEL_OVERRIDE_KEYS].sort(), Object.keys(override.properties).sort());
  });

  test("normalization and distance helpers", () => {
    assert.equal(normalizeModelsJsonKey("model0verrides"), "modeloverrides");
    assert.equal(normalizeModelsJsonKey("Model_Over-rides"), "modeloverrides");
    assert.equal(normalizeModelsJsonKey("ur1"), "url");
    assert.equal(damerauLevenshtein("compat", "compta"), 1);
    assert.equal(damerauLevenshtein("abc", "abc"), 0);
    assert.equal(damerauLevenshtein("kitten", "sitting"), 3);
    assert.equal(damerauLevenshtein("a", "abcdef", 2), 3);
  });

  test("suggestKnownKey only reports near-misses", () => {
    assert.equal(suggestKnownKey("model0verrides", MODELS_JSON_PROVIDER_KEYS), "modelOverrides");
    assert.equal(suggestKnownKey("modeloverrides", MODELS_JSON_PROVIDER_KEYS), "modelOverrides");
    assert.equal(suggestKnownKey("model_overrides", MODELS_JSON_PROVIDER_KEYS), "modelOverrides");
    assert.equal(suggestKnownKey("modelOveride", MODELS_JSON_PROVIDER_KEYS), "modelOverrides");
    assert.equal(suggestKnownKey("sendSessionAfinityHeaders", MODELS_JSON_COMPAT_KEYS), "sendSessionAffinityHeaders");
    assert.equal(suggestKnownKey("baseURL", MODELS_JSON_PROVIDER_KEYS), "baseUrl");
    assert.equal(suggestKnownKey("modelOverrides", MODELS_JSON_PROVIDER_KEYS), undefined);
    assert.equal(suggestKnownKey("myNote", MODELS_JSON_PROVIDER_KEYS), undefined);
    assert.equal(suggestKnownKey("x", MODELS_JSON_PROVIDER_KEYS), undefined);
    // Short keys need a normalized match; distance alone is not enough.
    assert.equal(suggestKnownKey("apx", MODELS_JSON_PROVIDER_KEYS), undefined);
    assert.equal(suggestKnownKey("futureCompatFlagFromPi2", MODELS_JSON_COMPAT_KEYS), undefined);
    // Three edits away is too far to call a typo (guards MAX_TYPO_DISTANCE).
    assert.equal(suggestKnownKey("contextWindowXYZ", MODELS_JSON_MODEL_DEFINITION_KEYS), undefined);
    assert.equal(suggestKnownKey("modelOverridesXYZ", MODELS_JSON_PROVIDER_KEYS), undefined);
  });

  test("detects every reported spelling at each level with a precise path", () => {
    const typos = lintModelsJsonKeys({
      $schema: "https://example.invalid/models.schema.json",
      providers: {
        "opencode-go": {
          baseUrl: "https://proxy.example/v1",
          model0verrides: { "glm-5": { compat: { sendSessionAffinityHeaders: true } } },
          myNote: "personal annotation",
          x: 1,
          compat: { sendSessionAfinityHeaders: true, supportsStore: true },
        },
        a: { modeloverrides: {} },
        b: { model_overrides: {} },
        c: { modelOveride: {} },
        d: {
          models: [
            { id: "m1", contextWindows: 1000, compat: { supportsLongCacheRetenton: true, chatTemplateKwargs: { anything: 1 } } },
          ],
          modelOverrides: {
            "m2": { promptcache: { short: 300 }, compat: { forceAdaptiveThinkng: true } },
            "m3": { compat: { sendSessionAffinityHeaders: true } },
          },
        },
      },
    });
    const byPath = Object.fromEntries(typos.map((typo) => [typo.path, typo.suggestion]));
    assert.deepEqual(byPath, {
      'providers["opencode-go"].model0verrides': "modelOverrides",
      'providers["opencode-go"].compat.sendSessionAfinityHeaders': "sendSessionAffinityHeaders",
      'providers["a"].modeloverrides': "modelOverrides",
      'providers["b"].model_overrides': "modelOverrides",
      'providers["c"].modelOveride': "modelOverrides",
      'providers["d"].models[0].contextWindows': "contextWindow",
      'providers["d"].models[0].compat.supportsLongCacheRetenton': "supportsLongCacheRetention",
      'providers["d"].modelOverrides["m2"].promptcache': "promptCache",
      'providers["d"].modelOverrides["m2"].compat.forceAdaptiveThinkng': "forceAdaptiveThinking",
    });
    const compatTypo = typos.find((typo) => typo.key === "sendSessionAfinityHeaders");
    assert.equal(compatTypo?.level, "providerCompat");
    assert.equal(compatTypo?.providerId, "opencode-go");
    const modelTypo = typos.find((typo) => typo.key === "contextWindows");
    assert.equal(modelTypo?.level, "model");
    assert.equal(modelTypo?.modelId, "m1");
    assert.equal(formatModelsJsonKeyTypo(typos[0]), ISSUE_30_HINT);
  });

  test("root typos, $schema and correct keys", () => {
    assert.deepEqual(lintModelsJsonKeys({ $schema: "x", providers: {} }), []);
    const root = lintModelsJsonKeys({ provider: { p: {} } });
    assert.equal(root.length, 1);
    assert.equal(root[0].path, "provider");
    assert.equal(root[0].suggestion, "providers");
    const correct = lintModelsJsonKeys({
      providers: {
        p: {
          name: "P", baseUrl: "u", apiKey: "k", api: "openai-completions", headers: {}, authHeader: true,
          compat: Object.fromEntries(MODELS_JSON_COMPAT_KEYS.map((key) => [key, true])),
          models: [Object.fromEntries(MODELS_JSON_MODEL_DEFINITION_KEYS.map((key) => [key, key === "id" ? "m" : 1]))],
          modelOverrides: { m: Object.fromEntries(MODELS_JSON_MODEL_OVERRIDE_KEYS.map((key) => [key, 1])) },
        },
      },
    });
    assert.deepEqual(correct, []);
  });

  test("tolerates non-object shapes without throwing", () => {
    assert.deepEqual(lintModelsJsonKeys(undefined), []);
    assert.deepEqual(lintModelsJsonKeys([]), []);
    assert.deepEqual(lintModelsJsonKeys({ providers: [] }), []);
    assert.deepEqual(lintModelsJsonKeys({ providers: { p: null, q: { models: "no", modelOverrides: [1], compat: 3 } } }), []);
    assert.deepEqual(lintModelsJsonKeys({ providers: { p: { models: [null, 1, { compat: [] }] } } }), []);
  });

  test("parses JSONC comments and trailing commas", () => {
    const typos = lintModelsJsonText(`\uFEFF{
      // user comment mentioning modelOverrides
      "providers": {
        "opencode-go": {
          /* block */ "model0verrides": { "glm-5": { "compat": { "sendSessionAffinityHeaders": true, }, }, },
        },
      },
    }`);
    assert.equal(typos.length, 1);
    assert.equal(typos[0].path, 'providers["opencode-go"].model0verrides');
    assert.deepEqual(lintModelsJsonText("{ not json"), []);
  });

  test("selects typos relevant to one provider/model", () => {
    const typos = lintModelsJsonKeys({
      provider: {},
      providers: {
        p: {
          model0verrides: {},
          compat: { supportsStroe: true },
          models: [{ id: "a", promptcache: {} }],
          modelOverrides: { b: { compat: { sendSessionAfinityHeaders: true } } },
        },
        q: { modelOveride: {} },
      },
    });
    const paths = (providerId: string | undefined, modelId?: string) =>
      selectModelsJsonKeyTyposForTarget(typos, providerId, modelId).map((typo) => typo.path).sort();
    assert.deepEqual(paths("p", "a"), ['provider', 'providers["p"].compat.supportsStroe', 'providers["p"].model0verrides', 'providers["p"].models[0].promptcache'].sort());
    assert.deepEqual(paths("p", "b"), ['provider', 'providers["p"].compat.supportsStroe', 'providers["p"].model0verrides', 'providers["p"].modelOverrides["b"].compat.sendSessionAfinityHeaders'].sort());
    assert.deepEqual(paths("q"), ['provider', 'providers["q"].modelOveride']);
    assert.deepEqual(paths("other", "a"), ["provider"]);
  });
});

describe("models.json lint file reads", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-cache-models-lint-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing, directory and malformed files never throw", async () => {
    assert.deepEqual(readModelsJsonKeyTypos(join(dir, "missing.json")), []);
    await mkdir(join(dir, "models-dir.json"));
    assert.deepEqual(readModelsJsonKeyTypos(join(dir, "models-dir.json")), []);
    await writeFile(join(dir, "broken.json"), "{ \"providers\": ");
    assert.deepEqual(readModelsJsonKeyTypos(join(dir, "broken.json")), []);
    assert.deepEqual(buildModelsJsonLintDoctorLines(join(dir, "missing.json")), []);
  });

  test("result is cached by file signature and refreshed when the file changes", async () => {
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify({ providers: { p: { model0verrides: {} } } }));
    const first = readModelsJsonKeyTypos(path);
    assert.equal(first.length, 1);
    assert.equal(readModelsJsonKeyTypos(path), first, "unchanged file reuses the cached result");
    await writeFile(path, JSON.stringify({ providers: { p: { modelOverrides: {}, padding: "xxxxxxxx" } } }));
    assert.deepEqual(readModelsJsonKeyTypos(path), []);
  });

  test("doctor lines list every typo, and nothing when clean", async () => {
    const path = join(dir, "doctor.json");
    await writeFile(path, JSON.stringify({ providers: { "opencode-go": { model0verrides: {}, compat: { sendSessionAfinityHeaders: true } } } }));
    const lines = buildModelsJsonLintDoctorLines(path);
    assert.match(lines[1], /2 suspected typos/);
    assert.ok(lines.some((line) => line.includes(ISSUE_30_HINT)));
    assert.ok(lines.some((line) => line.includes('compat.sendSessionAfinityHeaders is not a known Pi key and looks like a typo of "sendSessionAffinityHeaders"')));
    await writeFile(path, JSON.stringify({ providers: { "opencode-go": { modelOverrides: {} } } }));
    assert.deepEqual(buildModelsJsonLintDoctorLines(path), []);
  });
});

describe("issue #30 hints in warnings, doctor and fix", () => {
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let extension: typeof import("../index.ts");
  let cacheWarming: typeof import("../src/cache-warming.ts");

  before(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-cache-issue-30-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const jiti = createJiti(join(process.cwd(), "tests", "models-json-lint.test.ts"), {
      interopDefault: false,
      moduleCache: false,
    });
    extension = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
    cacheWarming = await jiti.import<typeof import("../src/cache-warming.ts")>(join(process.cwd(), "src", "cache-warming.ts"));
  });

  after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const model = (id: string, provider = "opencode-go", compat: Record<string, unknown> = {}) => ({
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    compat,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
    contextWindow: 128000,
    maxTokens: 8192,
  });

  function setup(options: { cacheWarming?: string } = {}) {
    const hooks = new Map<string, (event: any, ctx: any) => unknown>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    extension.default({
      ...(options.cacheWarming === undefined ? {} : { getSettings: () => ({ cacheWarming: options.cacheWarming }) }),
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        hooks.set(name, handler);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
    } as any);
    const notifications: string[] = [];
    const previews: string[] = [];
    const context = (current: ReturnType<typeof model>, approve = false, hasUI = true) => ({
      model: current,
      hasUI,
      sessionManager: { getSessionId: () => "issue-30-session" },
      modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
      ui: {
        notify: (text: string) => notifications.push(text),
        setStatus() {},
        confirm: async (_title: string, text: string) => {
          previews.push(text);
          return approve;
        },
      },
    });
    return { hooks, commands, context, notifications, previews };
  }

  const typoConfig = JSON.stringify({
    providers: {
      "opencode-go": {
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        model0verrides: { "glm-5": { compat: { sendSessionAffinityHeaders: true } } },
      },
    },
  });

  test("missing-compat warning explains the misspelled modelOverrides key", async () => {
    await writeFile(join(agentDir, "models.json"), typoConfig);
    const { hooks, context, notifications } = setup();
    const current = model("glm-5");
    await hooks.get("model_select")?.({ model: current }, context(current));
    const warning = notifications.find((text) => text.includes("merged compat lacks"));
    assert.ok(warning, "missing-compat warning still fires");
    assert.ok(warning.includes("Single-model override"));
    assert.ok(warning.includes(ISSUE_30_HINT));
  });

  test("warning without typos is unchanged and a clean models.json adds no hint", async () => {
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "opencode-go": { myNote: "x" } } }));
    const { hooks, context, notifications } = setup();
    const current = model("glm-5");
    await hooks.get("model_select")?.({ model: current }, context(current));
    const warning = notifications.find((text) => text.includes("merged compat lacks"));
    assert.ok(warning);
    assert.ok(!warning.includes("looks like a typo"));
  });

  test("unreadable or malformed models.json does not break the warning path", async () => {
    const path = join(agentDir, "models.json");
    await writeFile(path, "{ \"providers\": { \"opencode-go\": { \"model0verrides\": ");
    let harness = setup();
    let current = model("glm-5");
    await harness.hooks.get("model_select")?.({ model: current }, harness.context(current));
    assert.ok(harness.notifications.some((text) => text.includes("merged compat lacks")));
    assert.ok(!harness.notifications.some((text) => text.includes("looks like a typo")));

    await rm(path, { force: true });
    await mkdir(path);
    harness = setup();
    current = model("glm-5b");
    await harness.hooks.get("model_select")?.({ model: current }, harness.context(current));
    assert.ok(harness.notifications.some((text) => text.includes("merged compat lacks")));
    await rm(path, { recursive: true, force: true });
  });

  test("compat command and doctor show the hint; doctor lists it once in its own section", async () => {
    await writeFile(join(agentDir, "models.json"), typoConfig);
    const { commands, context, notifications } = setup();
    const current = model("glm-5");
    await commands.get("cache-optimizer")!.handler("compat", context(current));
    assert.ok(notifications.at(-1)?.includes(ISSUE_30_HINT));

    await commands.get("cache-optimizer")!.handler("doctor", context(current));
    const doctor = notifications.at(-1)!;
    assert.ok(doctor.includes("models.json key check: 1 suspected typo"));
    assert.equal(doctor.split(ISSUE_30_HINT).length - 1, 1);
  });

  test("doctor with Pi cache warming (Pi 0.86+) still lists each typo exactly once", async () => {
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { "opencode-go": { model0verrides: {}, modelOverrides: { "glm-5": { promptcache: { short: 300 } } } } },
    }));
    const { commands, context, notifications } = setup({ cacheWarming: "streaming" });
    await commands.get("cache-optimizer")!.handler("doctor", context(model("glm-5")));
    const doctor = notifications.at(-1)!;
    assert.ok(doctor.includes("Prompt cache warming"), "warming section is present");
    assert.ok(/declares no promptCache\.(short|long)/.test(doctor), "warming reports the missing lifetime");
    assert.ok(doctor.includes("models.json key check: 2 suspected typos"));
    assert.equal(doctor.split(ISSUE_30_HINT).length - 1, 1);
    assert.equal(doctor.split('promptcache is not a known Pi key and looks like a typo of "promptCache"').length - 1, 1);
  });

  test("doctor stays quiet about keys when models.json is clean", async () => {
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "opencode-go": { modelOverrides: {} } } }));
    const { commands, context, notifications } = setup();
    await commands.get("cache-optimizer")!.handler("doctor", context(model("glm-5")));
    assert.ok(!notifications.at(-1)?.includes("models.json key check"));
  });

  test("fix preview and manual guidance mention the typo and never rename it", async () => {
    const path = join(agentDir, "models.json");
    await writeFile(path, typoConfig);
    const { commands, context, previews, notifications } = setup();
    const current = model("glm-5");

    await commands.get("cache-optimizer")!.handler("fix", context(current, false));
    assert.ok(previews.at(-1)?.includes(ISSUE_30_HINT));
    assert.ok(previews.at(-1)?.includes("does not rename or remove misspelled keys"));
    assert.equal(await readFile(path, "utf8"), typoConfig);

    await commands.get("cache-optimizer")!.handler("fix", context(current, false, false));
    assert.ok(notifications.at(-1)?.includes("Non-interactive terminal detected"));
    assert.equal(notifications.at(-1)!.split(ISSUE_30_HINT).length - 1, 1, "non-UI guidance names the typo once");
    assert.ok(notifications.at(-1)?.includes("does not rename or remove misspelled keys"));

    await commands.get("cache-optimizer")!.handler("fix", context(current, true));
    const written = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(written.providers["opencode-go"].model0verrides, { "glm-5": { compat: { sendSessionAffinityHeaders: true } } });
    await rm(join(agentDir, "pi-cache-optimizer-fix-receipt.json"), { force: true });
  });

  test("model-override and models[] fix previews mention the typo and never rename it", async () => {
    const path = join(agentDir, "models.json");
    const hint = 'compat.sendSessionAfinityHeaders is not a known Pi key and looks like a typo of "sendSessionAffinityHeaders"';

    // Existing modelOverrides entry: the model-override repair path.
    const overrideConfig = JSON.stringify({
      providers: {
        "opencode-go": {
          api: "openai-completions",
          baseUrl: "https://proxy.example/v1",
          modelOverrides: { "glm-5": { name: "GLM 5", compat: { sendSessionAfinityHeaders: true } } },
        },
      },
    });
    await writeFile(path, overrideConfig);
    let harness = setup();
    await harness.commands.get("cache-optimizer")!.handler("fix", harness.context(model("glm-5"), false));
    assert.ok(harness.previews.at(-1)?.includes(hint), "model-override preview names the typo");
    assert.ok(harness.previews.at(-1)?.includes("does not rename or remove misspelled keys"));
    assert.equal(await readFile(path, "utf8"), overrideConfig);

    // Custom models[] definition: the in-place model compat path.
    const definitionConfig = JSON.stringify({
      providers: {
        "opencode-go": {
          api: "openai-completions",
          baseUrl: "https://proxy.example/v1",
          models: [{ id: "glm-5", compat: { sendSessionAfinityHeaders: true } }],
        },
      },
    });
    await writeFile(path, definitionConfig);
    harness = setup();
    await harness.commands.get("cache-optimizer")!.handler("fix", harness.context(model("glm-5"), false));
    assert.ok(harness.previews.at(-1)?.includes(hint), "models[] preview names the typo");
    assert.equal(await readFile(path, "utf8"), definitionConfig);
  });

  test("Claude-like cacheControlFormat warning mentions a misspelled compat key", async () => {
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { "claude-proxy": { compat: { cacheControlFormt: "anthropic" } } },
    }));
    const { hooks, context, notifications } = setup();
    const current = model("claude-sonnet-4-5", "claude-proxy");
    await hooks.get("model_select")?.({ model: current }, context(current));
    const warning = notifications.find((text) => text.includes('lacks cacheControlFormat: "anthropic"'));
    assert.ok(warning, "Claude warning still fires");
    assert.ok(warning.includes('providers["claude-proxy"].compat.cacheControlFormt is not a known Pi key and looks like a typo of "cacheControlFormat"'));
  });

  test("fix prompt-cache preview mentions a misspelled promptCache key", async () => {
    const path = join(agentDir, "models.json");
    const config = JSON.stringify({
      providers: { "opencode-go": { modelOverrides: { "glm-5": { promptcache: { short: 300 } } } } },
    });
    await writeFile(path, config);
    const previousRetention = process.env.PI_CACHE_RETENTION;
    try {
      for (const retention of ["long", "short"]) {
        // long: no documented long lifetime for openai-completions, so the fix
        // refuses; short: it previews a write. Both must name the typo.
        process.env.PI_CACHE_RETENTION = retention;
        const { commands, context, previews, notifications } = setup();
        await commands.get("cache-optimizer")!.handler("fix prompt-cache", context(model("glm-5"), false));
        const shown = retention === "long" ? notifications.at(-1) ?? "" : previews.at(-1) ?? "";
        assert.ok(shown.includes('promptcache is not a known Pi key and looks like a typo of "promptCache"'), `${retention}: ${shown}`);
        assert.equal(await readFile(path, "utf8"), config);
      }
    } finally {
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
    }
  });

  test("cache-warming promptCache advice mentions a misspelled promptCache key", async () => {
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { "opencode-go": { modelOverrides: { "glm-5": { promptcache: { short: 300 } } } } },
    }));
    const diagnosis = cacheWarming.buildCacheWarmingDiagnosis(model("glm-5") as any, {
      mode: "streaming" as any,
      tier: "short",
      zeroPriceWarming: false,
    });
    assert.ok(diagnosis.lines.some((line) => line.includes('modelOverrides["glm-5"].promptcache is not a known Pi key and looks like a typo of "promptCache"')));
    const quiet = cacheWarming.buildCacheWarmingDiagnosis(model("glm-5") as any, {
      mode: "streaming" as any,
      tier: "short",
      zeroPriceWarming: false,
      typoHints: false,
    });
    assert.ok(!quiet.lines.some((line) => line.includes("looks like a typo")));
  });
});
