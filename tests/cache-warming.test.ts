import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildCacheWarmingDiagnosis, cacheWarmingRefreshDelayMs, decideZeroPriceWarming, readCacheWarmingMode, suggestedPromptCacheLifetimes } from "../src/cache-warming.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;

function model(overrides: Record<string, unknown> = {}): PiModel {
  return {
    provider: "proxy",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "anthropic-messages",
    baseUrl: "https://proxy.example.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    compat: { forceAdaptiveThinking: true },
    ...overrides,
  } as unknown as PiModel;
}

describe("cache warming diagnostics", () => {
  test("reads the mode from Pi settings and defaults to streaming", () => {
    assert.equal(readCacheWarmingMode(undefined), "unsupported");
    assert.equal(readCacheWarmingMode(() => { throw new Error("boom"); }), "unsupported");
    assert.equal(readCacheWarmingMode(() => ({})), "streaming");
    assert.equal(readCacheWarmingMode(() => ({ cacheWarming: "idle" })), "idle");
    assert.equal(readCacheWarmingMode(() => ({ cacheWarming: "off" })), "off");
    assert.equal(readCacheWarmingMode(() => ({ cacheWarming: "bogus" })), "streaming");
  });

  test("matches Pi's refresh schedule", () => {
    assert.equal(cacheWarmingRefreshDelayMs(300_000), 270_000);
    assert.equal(cacheWarmingRefreshDelayMs(3_600_000), 3_240_000);
    assert.equal(cacheWarmingRefreshDelayMs(10_000), undefined);
  });

  test("flags a model without promptCache and suggests Anthropic lifetimes", () => {
    const result = buildCacheWarmingDiagnosis(model(), { mode: "streaming", tier: "long" });
    assert.equal(result.eligible, false);
    assert.deepEqual(result.issues, ["prompt_cache_missing"]);
    assert.ok(result.lines.some((line) => line.includes('"promptCache": {"short":300,"long":3600}')));
  });

  test("suggests only the short lifetime outside anthropic-messages", () => {
    assert.deepEqual(suggestedPromptCacheLifetimes(model({ api: "openai-completions" })), { short: 300 });
  });

  test("reports eligibility when lifetime, pricing and replayability are present", () => {
    const result = buildCacheWarmingDiagnosis(model({ promptCache: { short: 300, long: 3600 } }), { mode: "streaming", tier: "long" });
    assert.equal(result.eligible, true);
    assert.deepEqual(result.issues, []);
    assert.ok(result.lines.some((line) => line.includes("promptCache.long: 1h")));
  });

  test("flags missing pricing and non-replayable budget thinking", () => {
    const result = buildCacheWarmingDiagnosis(
      model({ promptCache: { short: 300 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {} }),
      { mode: "streaming", tier: "short" },
    );
    assert.deepEqual(result.issues, ["pricing_missing", "not_replayable"]);
    assert.equal(result.eligible, false);
  });

  test("explains that idle mode cannot refresh a one-hour entry", () => {
    const result = buildCacheWarmingDiagnosis(model({ promptCache: { short: 300, long: 3600 } }), { mode: "idle", tier: "long" });
    assert.ok(result.lines.some((line) => line.includes("idle warming stops after 30m") && line.includes("54m")));
    const short = buildCacheWarmingDiagnosis(model({ promptCache: { short: 300, long: 3600 } }), { mode: "idle", tier: "short" });
    assert.ok(!short.lines.some((line) => line.includes("idle warming stops after 30m")));
  });

  test("off mode and unsupported hosts are not eligible", () => {
    assert.equal(buildCacheWarmingDiagnosis(model({ promptCache: { long: 3600 } }), { mode: "off", tier: "long" }).eligible, false);
    assert.deepEqual(buildCacheWarmingDiagnosis(model(), { mode: "unsupported", tier: "long" }).issues, ["unsupported"]);
  });
});

describe("zero-price warming override", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  test("turns Pi's unpriced stop into warm for zero-price models", () => {
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, model({ cost: zero })), "warm");
  });

  test("does not override when only the output price is set", () => {
    const outputOnly = { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 };
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, model({ cost: outputOnly })), undefined);
    const m = model({ promptCache: { short: 300, long: 3600 }, cost: outputOnly });
    assert.deepEqual(buildCacheWarmingDiagnosis(m, { mode: "streaming", tier: "long", zeroPriceWarming: true }).issues, ["pricing_missing"]);
  });

  test("respects Pi when the model has prices or Pi already warms", () => {
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, model()), undefined);
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0.01, missCost: 0.02 }, model({ cost: zero })), undefined);
    assert.equal(decideZeroPriceWarming({ action: "warm", warmCost: 0, missCost: 0 }, model({ cost: zero })), undefined);
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, undefined), undefined);
  });

  test("doctor treats zero pricing as covered when the override is on", () => {
    const m = model({ promptCache: { short: 300, long: 3600 }, cost: zero });
    const on = buildCacheWarmingDiagnosis(m, { mode: "streaming", tier: "long", zeroPriceWarming: true });
    assert.equal(on.eligible, true);
    assert.ok(on.lines.some((line) => line.includes("overrides")));
    const off = buildCacheWarmingDiagnosis(m, { mode: "streaming", tier: "long", zeroPriceWarming: false });
    assert.deepEqual(off.issues, ["pricing_missing"]);
  });
});
