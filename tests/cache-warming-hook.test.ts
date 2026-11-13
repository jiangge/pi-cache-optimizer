import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * Drives the extension's cache_warming_decision hook with the installed Pi
 * CacheWarmer, so the test sees the event shape Pi really sends (no phase).
 */
const ROOT = process.cwd();

async function idleDecision(globalSettings: string): Promise<{ event: Record<string, unknown>; result: unknown }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-warming-hook-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeFile(join(dir, "settings.json"), globalSettings);
    const jiti = createJiti(join(ROOT, "tests", "cache-warming-hook.ts"), { interopDefault: false, moduleCache: false });
    const ext = await jiti.import<typeof import("../index.ts")>(join(ROOT, "index.ts"));
    const { CacheWarmer } = await jiti.import<typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js")>(
      join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "cache-warmer.js"),
    );
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    ext.default({ on(name: string, handler: any) { handlers.set(name, handler); }, registerCommand() {}, getSettings: () => JSON.parse(globalSettings) } as any);
    const hook = handlers.get("cache_warming_decision");
    assert.ok(hook);
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const model = { id: "m", provider: "p", api: "openai-completions", baseUrl: "https://proxy.example/v1", cost: zero, promptCache: { short: 11, long: 11 } };
    const seen: Array<{ event: Record<string, unknown>; result: unknown }> = [];
    const sessionManager = {
      getBranch: () => [{ type: "message", message: { role: "assistant", usage: { input: 1000, cacheRead: 0, cacheWrite: 0 } } }],
      appendUsage: () => ({}),
    };
    const models = { streamSimple: () => ({ result: async () => ({ stopReason: "stop", usage: {}, provider: "p", model: "m" }) }) };
    const warmer = new CacheWarmer(models as any, sessionManager as any, () => "idle", async (event: any) => {
      const result = await hook(event, { model });
      seen.push({ event, result });
      return (result as { action?: string } | undefined)?.action ?? event.action;
    });
    warmer.start({ model, context: {}, options: {} } as any, () => true);
    warmer.onAgentSettled();
    for (let i = 0; i < 60 && seen.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    warmer.cancel();
    assert.ok(seen.length > 0, "Pi sent no cache_warming_decision");
    return seen[0]!;
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("cache_warming_decision with the installed Pi CacheWarmer", () => {
  test("Pi's idle default does not extend zero-price warming between runs", async () => {
    const { event, result } = await idleDecision("{}");
    assert.equal(event.action, "stop");
    assert.equal("phase" in event, false);
    assert.equal(result, undefined);
  });

  test("an explicit global idle setting extends it", async () => {
    const { result } = await idleDecision(JSON.stringify({ cacheWarming: "idle" }));
    assert.deepEqual(result, { action: "warm" });
  });

  test("global settings parse like Pi: BOM stripped, comments mean no settings", async () => {
    const { __internals_for_tests: internals } = await import("../index.ts");
    assert.deepEqual(internals.parseGlobalPiSettingsText("\uFEFF{\"cacheWarming\":\"idle\"}"), { cacheWarming: "idle" });
    assert.deepEqual(internals.parseGlobalPiSettingsText("// c\n{\"cacheWarming\":\"idle\"}"), {});
    assert.deepEqual(internals.parseGlobalPiSettingsText(""), {});
    assert.deepEqual(internals.parseGlobalPiSettingsText("[]"), {});
    assert.equal(internals.readHostCacheWarmingDefault(), "idle");
  });
});
