import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

let agentDir: string;
let previousAgentDir: string | undefined;
let extension: typeof import("../index.ts");

before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-cache-issue-17-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const jiti = createJiti(join(process.cwd(), "tests", "issue-17-provider-affinity.test.ts"), {
    interopDefault: false,
    moduleCache: false,
  });
  extension = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
});

const model = (id: string, provider = "proxy", compat: Record<string, unknown> = {}) => ({
  provider,
  id,
  name: id,
  api: "openai-completions",
  baseUrl: "https://proxy.example/v1",
  compat,
  reasoning: false,
  input: ["text"] as Array<"text" | "image">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
});

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
  const notifications: string[] = [];
  const previews: string[] = [];
  const context = (current: ReturnType<typeof model>, approve = false) => ({
    model: current,
    hasUI: true,
    sessionManager: { getSessionId: () => "issue-17-session" },
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

test("affinity-only warning appears once per provider; explicit false is silent", async () => {
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { proxy: {}, other: {} } }));
  const { hooks, context, notifications } = setup();
  for (const current of [
    model("mimo-a"),
    model("qwen-b"),
    model("mimo-c", "other"),
    model("mimo-false", "proxy", { sendSessionAffinityHeaders: false }),
  ]) {
    await hooks.get("model_select")?.({ model: current }, context(current));
  }
  const warnings = notifications.filter((text) => text.includes("merged compat lacks"));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((text) => text.includes("/cache-optimizer fix")));
  assert.ok(warnings.some((text) => text.includes("proxy/mimo-a")));
  assert.ok(warnings.some((text) => text.includes("other/mimo-c")));
});

test("model-specific diagnostics remain separate within one provider", async () => {
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { proxy: {} } }));
  const { hooks, context, notifications } = setup();
  for (const id of ["deepseek-a", "deepseek-b"]) {
    const current = model(id, "proxy", { thinkingFormat: "deepseek" });
    await hooks.get("model_select")?.({ model: current }, context(current));
  }
  const warnings = notifications.filter((text) => text.includes("requiresReasoningContentOnAssistantMessages"));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((text) => text.includes("proxy/deepseek-a")));
  assert.ok(warnings.some((text) => text.includes("proxy/deepseek-b")));
});

test("provider-level affinity compat suppresses warnings for every sibling model", async () => {
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      proxy: {
        compat: { sendSessionAffinityHeaders: true },
        models: [{ id: "mimo-a" }, { id: "qwen-b" }],
      },
    },
  }));
  const { hooks, context, notifications } = setup();
  for (const id of ["mimo-a", "qwen-b", "unlisted-model"]) {
    const current = model(id);
    await hooks.get("model_select")?.({ model: current }, context(current));
  }
  assert.equal(notifications.filter((text) => text.includes("merged compat lacks")).length, 0);
});

test("provider-level generic compat does not invent DeepSeek wire protocol warnings", async () => {
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      proxy: {
        compat: {
          sendSessionAffinityHeaders: true,
          requiresReasoningContentOnAssistantMessages: true,
          supportsReasoningEffort: true,
        },
      },
    },
  }));
  const { hooks, context, notifications } = setup();
  const current = model("DeepSeek-V4-Flash", "proxy", { supportsReasoningEffort: true });
  await hooks.get("model_select")?.({ model: current }, context(current));
  assert.equal(notifications.length, 0);
});

test("one confirmed provider repair covers missing models, preserves explicit false, and rolls back", async () => {
  const path = join(agentDir, "models.json");
  const original = `{"providers":{"proxy":{"api":"openai-completions","baseUrl":"https://proxy.example/v1","modelOverrides":{"opted-out":{"compat":{"sendSessionAffinityHeaders":false}}}}}}`;
  await writeFile(path, original);
  await chmod(path, 0o640);
  const { commands, context, previews, notifications } = setup();
  const first = model("mimo-a");

  await commands.get("cache-optimizer")!.handler("fix", context(first, false));
  assert.equal(await readFile(path, "utf8"), original);

  await commands.get("cache-optimizer")!.handler("fix", context(first, true));
  assert.ok(previews.some((text) => text.includes("provider level") && text.includes("all models")));
  const fixed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(fixed.providers.proxy.compat.sendSessionAffinityHeaders, true);
  assert.equal(fixed.providers.proxy.modelOverrides["opted-out"].compat.sendSessionAffinityHeaders, false);
  assert.equal(fixed.providers.proxy.modelOverrides["mimo-a"], undefined);
  assert.equal(
    extension.__internals_for_tests.resolveEffectiveCompatFromConfig(model("qwen-b") as any, fixed).sendSessionAffinityHeaders,
    true,
  );
  const receipt = JSON.parse(await readFile(join(agentDir, "pi-cache-optimizer-fix-receipt.json"), "utf8"));
  assert.equal(receipt.placement, "provider");
  assert.equal((await stat(path)).mode & 0o7777, 0o640);
  assert.equal(await readFile(join(agentDir, receipt.backupFile), "utf8"), original);
  assert.equal((await stat(join(agentDir, receipt.backupFile))).mode & 0o7777, 0o640);

  await commands.get("cache-optimizer")!.handler("rollback", context(model("qwen-b"), true));
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal((await stat(path)).mode & 0o7777, 0o640);
  assert.ok(notifications.some((text) => text.includes("Rollback completed")));
});

test("provider receipt surgically rolls back after unrelated JSONC edits", async () => {
  const path = join(agentDir, "models.json");
  const original = `{"providers":{"proxy":{"api":"openai-completions","baseUrl":"https://proxy.example/v1"}}}`;
  await writeFile(path, original);
  const { commands, context } = setup();

  await commands.get("cache-optimizer")!.handler("fix", context(model("mimo-surgical"), true));
  const fixed = await readFile(path, "utf8");
  assert.ok(fixed.includes('"sendSessionAffinityHeaders": true'));
  await writeFile(path, fixed.replace('"baseUrl":"https://proxy.example/v1"', '"baseUrl":"https://proxy.example/v1","later":"keep"'));

  await commands.get("cache-optimizer")!.handler("rollback", context(model("qwen-surgical"), true));
  const result = JSON.parse(await readFile(path, "utf8"));
  assert.equal(result.providers.proxy.compat.sendSessionAffinityHeaders, undefined);
  assert.equal(result.providers.proxy.later, "keep");
});

test("existing model override and runtime shadow remain model-scoped", async () => {
  const path = join(agentDir, "models.json");
  const existingOverride = JSON.stringify({
    providers: {
      proxy: {
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        modelOverrides: { "mimo-override": { compat: {} } },
      },
    },
  });
  await writeFile(path, existingOverride);
  let harness = setup();
  await harness.commands.get("cache-optimizer")!.handler("fix", harness.context(model("mimo-override"), true));
  assert.ok(harness.previews.at(-1)?.includes("modelOverrides"));
  let changed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(changed.providers.proxy.compat, undefined);
  assert.equal(changed.providers.proxy.modelOverrides["mimo-override"].compat.sendSessionAffinityHeaders, true);

  const runtimeShadow = JSON.stringify({
    providers: { proxy: { api: "openai-completions", baseUrl: "https://proxy.example/v1" } },
  });
  await writeFile(path, runtimeShadow);
  await rm(join(agentDir, "pi-cache-optimizer-fix-receipt.json"), { force: true });
  harness = setup();
  await harness.commands.get("cache-optimizer")!.handler(
    "fix",
    harness.context(model("mimo-shadow", "proxy", { sendSessionAffinityHeaders: undefined }), true),
  );
  assert.ok(harness.previews.at(-1)?.includes("modelOverrides"));
  changed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(changed.providers.proxy.compat, undefined);
  assert.equal(changed.providers.proxy.modelOverrides["mimo-shadow"].compat.sendSessionAffinityHeaders, true);
});

test("observed affinity-header 403 stays model-scoped", async () => {
  const path = join(agentDir, "models.json");
  await writeFile(path, JSON.stringify({
    providers: {
      proxy: {
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: { sendSessionAffinityHeaders: true },
        models: [{ id: "blocked" }, { id: "sibling" }],
      },
    },
  }));
  const harness = setup();
  const blocked = model("blocked", "proxy", { sendSessionAffinityHeaders: true });
  const blockedContext = harness.context(blocked, true);
  await harness.hooks.get("before_provider_request")?.({ payload: {} }, blockedContext);
  await harness.hooks.get("after_provider_response")?.({ status: 403, headers: {} }, blockedContext);
  await harness.commands.get("cache-optimizer")!.handler("fix", blockedContext);

  assert.ok(harness.previews.at(-1)?.includes("modelOverrides"));
  const changed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(changed.providers.proxy.compat.sendSessionAffinityHeaders, true);
  assert.equal(changed.providers.proxy.modelOverrides.blocked.compat.sendSessionAffinityHeaders, false);
  assert.equal(changed.providers.proxy.modelOverrides.sibling, undefined);
});

test("ambiguous or malformed provider compat fails closed", () => {
  const internals = extension.__internals_for_tests;
  assert.equal(
    internals.composeProviderAffinityInsertion(
      `{"providers":{"proxy":{"compat":{},"compat":{}}}}`,
      "proxy",
    ),
    undefined,
  );
  assert.equal(
    internals.composeProviderAffinityInsertion(
      `{"providers":{"proxy":{"compat":false}}}`,
      "proxy",
    ),
    undefined,
  );
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});
