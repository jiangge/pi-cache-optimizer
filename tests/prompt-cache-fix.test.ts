import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { choosePromptCacheLifetimes, insertJsonProperty, planPromptCacheFix } from "../src/prompt-cache-fix.ts";
import { parseJsonc } from "../src/jsonc.ts";
import { composeModelsJsonReceiptRollback, createPromptCacheFixReceipt, parseModelsJsonFixReceipt, validateModelsJsonRollback } from "../src/models-json-fix.ts";
import type { PiModel } from "../src/common.ts";

function claude(overrides: Record<string, unknown> = {}): PiModel {
  return {
    provider: "proxy", id: "claude-sonnet-5", name: "claude-sonnet-5", api: "anthropic-messages",
    baseUrl: "https://example.invalid", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192,
    ...overrides,
  } as unknown as PiModel;
}

const CUSTOM = `{
  // proxy channel
  "providers": {
    "proxy": {
      "baseUrl": "https://example.invalid",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "claude-sonnet-5", // main model
          "reasoning": true
        },
        { "id": "other" }
      ]
    }
  }
}
`;

describe("insertJsonProperty", () => {
  test("appends after the last member, keeping its trailing comment on its line", () => {
    const text = '{\n  "a": 1 // note\n}';
    const out = insertJsonProperty(text, 0, text.length - 1, "b", { short: 300 });
    assert.equal(out, '{\n  "a": 1, // note\n  "b": {\n    "short": 300\n  }\n}');
    assert.deepEqual(parseJsonc(out), { a: 1, b: { short: 300 } });
  });

  test("handles empty objects and JSONC trailing commas", () => {
    assert.deepEqual(parseJsonc(insertJsonProperty("{}", 0, 1, "k", 1)), { k: 1 });
    const trailing = '{\n  "a": 1,\n}';
    assert.deepEqual(parseJsonc(insertJsonProperty(trailing, 0, trailing.length - 1, "k", 2)), { a: 1, k: 2 });
  });
});

describe("insertJsonProperty edge cases", () => {
  test("never lands inside a multi-line block comment", () => {
    const text = '{"id":"m" /* a\n b */\n}';
    const out = insertJsonProperty(text, 0, text.length - 1, "promptCache", { short: 300 });
    assert.deepEqual(parseJsonc(out), { id: "m", promptCache: { short: 300 } });
  });

  test("keeps CRLF line endings", () => {
    const text = '{\r\n  "id": "m" // c\r\n}\r\n';
    const out = insertJsonProperty(text, 0, text.indexOf("}"), "promptCache", { short: 300 });
    assert.deepEqual(parseJsonc(out), { id: "m", promptCache: { short: 300 } });
    assert.equal(out.replace(/\r\n/g, "").includes("\n"), false);
  });
});

describe("choosePromptCacheLifetimes", () => {
  test("writes only the tiers the model does not declare", () => {
    assert.deepEqual(choosePromptCacheLifetimes(claude({ promptCache: { short: 120 } }), "long"), { promptCache: { long: 3600 } });
  });

  test("uses Anthropic's documented 5m/1h lifetimes", () => {
    assert.deepEqual(choosePromptCacheLifetimes(claude(), "long"), { promptCache: { short: 300, long: 3600 } });
  });

  test("refuses to guess a long lifetime for other APIs", () => {
    const openai = claude({ api: "openai-completions", id: "gpt-x" });
    assert.ok("error" in choosePromptCacheLifetimes(openai, "long"));
    assert.deepEqual(choosePromptCacheLifetimes(openai, "short"), { promptCache: { short: 300 } });
  });
});

describe("planPromptCacheFix", () => {
  test("adds promptCache to a custom model entry and preserves comments", () => {
    const plan = planPromptCacheFix(CUSTOM, "proxy", "claude-sonnet-5", { short: 300, long: 3600 });
    assert.ok(!("error" in plan));
    assert.equal(plan.placement, "model");
    assert.equal(plan.targetExistedBefore, true);
    assert.ok(plan.modifiedText.includes("// proxy channel") && plan.modifiedText.includes("// main model"));
    const parsed = parseJsonc(plan.modifiedText) as { providers: { proxy: { models: Array<Record<string, unknown>> } } };
    assert.deepEqual(parsed.providers.proxy.models[0].promptCache, { short: 300, long: 3600 });
    assert.equal(parsed.providers.proxy.models[1].promptCache, undefined);
  });

  test("creates a modelOverrides entry for models not defined in models[]", () => {
    const text = '{\n  "providers": {\n    "anthropic": {\n      "apiKey": "x"\n    }\n  }\n}\n';
    const plan = planPromptCacheFix(text, "anthropic", "claude-haiku-5-5", { short: 300, long: 3600 });
    assert.ok(!("error" in plan));
    assert.equal(plan.placement, "modelOverride");
    assert.equal(plan.targetExistedBefore, false);
    assert.deepEqual(parseJsonc(plan.modifiedText), {
      providers: { anthropic: { apiKey: "x", modelOverrides: { "claude-haiku-5-5": { promptCache: { short: 300, long: 3600 } } } } },
    });
  });

  test("adds to an existing modelOverrides entry", () => {
    const text = '{"providers":{"p":{"modelOverrides":{"m":{"compat":{"x":true}},"n":{}}}}}';
    const plan = planPromptCacheFix(text, "p", "m", { short: 300 });
    assert.ok(!("error" in plan));
    assert.equal(plan.targetExistedBefore, true);
    assert.deepEqual(parseJsonc(plan.modifiedText), {
      providers: { p: { modelOverrides: { m: { compat: { x: true }, promptCache: { short: 300 } }, n: {} } } },
    });
  });

  test("never merges into or overwrites an existing promptCache", () => {
    const text = '{"providers":{"p":{"models":[{"id":"m","promptCache":{"short":60}}]}}}';
    assert.match((planPromptCacheFix(text, "p", "m", { short: 300 }) as { error: string }).error, /already has a promptCache/);
  });

  test("refuses when the provider has no models.json entry", () => {
    assert.ok("error" in planPromptCacheFix('{"providers":{}}', "p", "m", { short: 300 }));
  });
});

describe("prompt-cache receipts and surgical rollback", () => {
  const plan = planPromptCacheFix(CUSTOM, "proxy", "claude-sonnet-5", { short: 300, long: 3600 });
  assert.ok(!("error" in plan));
  const receipt = createPromptCacheFixReceipt(
    CUSTOM, plan.modifiedText, "proxy", "claude-sonnet-5", plan.placement, plan.promptCache, plan.targetExistedBefore,
    "/tmp/models.json.backup-cache-optimizer-test", 1,
  );

  test("records a version 2 receipt that round-trips", () => {
    assert.ok(receipt);
    assert.equal(receipt.version, 2);
    assert.deepEqual(receipt.promptCacheAdded, { short: 300, long: 3600 });
    assert.deepEqual(parseModelsJsonFixReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
  });

  test("rejects malformed version 2 receipts", () => {
    assert.ok(receipt);
    assert.equal(parseModelsJsonFixReceipt({ ...receipt, promptCacheAdded: undefined }), undefined);
    assert.equal(parseModelsJsonFixReceipt({ ...receipt, promptCacheAdded: { short: -1 } }), undefined);
    assert.equal(parseModelsJsonFixReceipt({ ...receipt, placement: "provider" }), undefined);
    assert.equal(parseModelsJsonFixReceipt({ ...receipt, version: 1 }), undefined);
  });

  test("removes only promptCache after unrelated user edits", () => {
    assert.ok(receipt);
    const edited = plan.modifiedText.replace('"reasoning": true', '"reasoning": false');
    const result = composeModelsJsonReceiptRollback(edited, receipt);
    assert.ok(!("error" in result));
    assert.equal(validateModelsJsonRollback(result.modifiedText, receipt), null);
    assert.deepEqual(parseJsonc(result.modifiedText), parseJsonc(CUSTOM.replace('"reasoning": true', '"reasoning": false')));
  });

  test("refuses when the user changed the added promptCache", () => {
    assert.ok(receipt);
    const edited = plan.modifiedText.replace('"long": 3600', '"long": 1800');
    assert.ok("error" in composeModelsJsonReceiptRollback(edited, receipt));
  });
});

describe("/cache-optimizer fix prompt-cache end to end", () => {
  test("writes with backup and receipt, then rollback restores the original file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cache-prompt-cache-fix-"));
    const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, retention: process.env.PI_CACHE_RETENTION };
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env.PI_CACHE_RETENTION;
    try {
      await writeFile(join(dir, "models.json"), CUSTOM);
      const jiti = createJiti(join(process.cwd(), "tests", "prompt-cache-fix.test.ts"), { interopDefault: false, moduleCache: false });
      const loaded = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
      loaded.default({
        on() {},
        registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, command); },
      } as unknown as ExtensionAPI);
      const notices: string[] = [];
      const previews: string[] = [];
      const ctx = {
        model: claude(), mode: "interactive", hasUI: true,
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify: (text: string) => notices.push(text),
          setStatus: () => {},
          confirm: async (_title: string, message: string) => { previews.push(message); return true; },
        },
      } as unknown as ExtensionCommandContext;
      const run = (args: string) => commands.get("cache-optimizer")!.handler(args, ctx);

      await run("fix prompt-cache");
      assert.match(previews[0], /promptCache/);
      const written = await readFile(join(dir, "models.json"), "utf8");
      const parsed = parseJsonc(written) as { providers: { proxy: { models: Array<Record<string, unknown>> } } };
      assert.ok(parsed.providers.proxy.models[0].promptCache, notices.join("\n"));
      const files = await readdir(dir);
      assert.ok(files.some((name) => name.startsWith("models.json.backup-cache-optimizer-")));
      const receipt = JSON.parse(await readFile(join(dir, "pi-cache-optimizer-fix-receipt.json"), "utf8"));
      assert.equal(receipt.version, 2);

      await run("rollback");
      assert.equal(await readFile(join(dir, "models.json"), "utf8"), CUSTOM, notices.join("\n"));
    } finally {
      if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
      if (saved.retention === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = saved.retention;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
