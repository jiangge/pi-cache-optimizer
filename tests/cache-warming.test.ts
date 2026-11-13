import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildCacheWarmingDiagnosis, cacheWarmingDefaultMode, cacheWarmingRefreshDelayMs, decideZeroPriceWarming, isOpenRouterRouterModel, isZeroPriced, readCacheWarmingMode, readCacheWarmingSetting, suggestedPromptCacheLifetimes } from "../src/cache-warming.ts";

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

  test("OpenRouter router models are not free just because Pi shows 0 (Pi 1.2.0 normalises -1 to 0)", () => {
    const router = model({ provider: "openrouter", id: "openrouter/auto", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", cost: zero, promptCache: { short: 300 } });
    assert.equal(isOpenRouterRouterModel(router), true);
    assert.equal(isZeroPriced(router), false);
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, router), undefined);
    const diagnosis = buildCacheWarmingDiagnosis(router, { mode: "streaming", tier: "short", zeroPriceWarming: true });
    assert.deepEqual(diagnosis.issues, ["pricing_unknown"]);
    assert.ok(diagnosis.lines.some((line) => line.includes("OpenRouter router")));
    // A routed id reached through another provider entry is still a router.
    assert.equal(isZeroPriced(model({ provider: "proxy", id: "openrouter/free", cost: zero })), false);
    // Ordinary free OpenRouter models stay zero-priced.
    assert.equal(isZeroPriced(model({ provider: "openrouter", id: "meta-llama/llama-4:free", cost: zero })), true);
  });

  test("a positive price in any cost tier means the model is not zero-priced", () => {
    const tiered = { ...zero, tiers: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 0 }, { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, inputTokensAbove: 200_000 }] };
    const m = model({ cost: tiered, promptCache: { short: 300, long: 3600 } });
    assert.equal(isZeroPriced(m), false);
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, m), undefined);
    const diagnosis = buildCacheWarmingDiagnosis(m, { mode: "streaming", tier: "long", zeroPriceWarming: true });
    assert.deepEqual(diagnosis.issues, ["pricing_missing"]);
    assert.ok(diagnosis.lines.some((line) => line.includes("price tiers")));
    const allZeroTiers = model({ cost: { ...zero, tiers: [{ ...zero, inputTokensAbove: 200_000 }] } });
    assert.equal(isZeroPriced(allZeroTiers), true);
  });

  test("Pi 1.5.1 made idle the default cacheWarming mode", () => {
    assert.equal(cacheWarmingDefaultMode(undefined), "streaming");
    assert.equal(cacheWarmingDefaultMode("garbage"), "streaming");
    assert.equal(cacheWarmingDefaultMode("1.5.0"), "streaming");
    assert.equal(cacheWarmingDefaultMode("0.99.3"), "streaming");
    assert.equal(cacheWarmingDefaultMode("1.5.1"), "idle");
    assert.equal(cacheWarmingDefaultMode("1.5.2"), "idle");
    assert.equal(cacheWarmingDefaultMode("1.6.0-beta.1"), "idle");
    assert.equal(cacheWarmingDefaultMode("2.0.0"), "idle");
    assert.equal(readCacheWarmingMode(() => ({}), "1.5.2"), "idle");
  });

  test("resolves the mode from global settings the way Pi does", () => {
    const merged = (value: unknown) => () => (value === undefined ? {} : { cacheWarming: value });
    assert.equal(readCacheWarmingSetting({ getSettings: undefined }), "unsupported");
    // No global setting: Pi's default for the host version, not explicit.
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged(undefined), readGlobalSettings: () => ({}), piVersion: "1.5.2" }), { mode: "idle", explicit: false });
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged(undefined), readGlobalSettings: () => ({}), piVersion: "1.5.0" }), { mode: "streaming", explicit: false });
    // Global setting wins and is explicit.
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged("idle"), readGlobalSettings: () => ({ cacheWarming: "idle" }), piVersion: "1.5.2" }), { mode: "idle", explicit: true });
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged("streaming"), readGlobalSettings: () => ({ cacheWarming: "streaming" }), piVersion: "1.5.2" }), { mode: "streaming", explicit: true });
    // An invalid global value falls back to the default, as Pi does.
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged(undefined), readGlobalSettings: () => ({ cacheWarming: "bogus" }), piVersion: "1.5.2" }), { mode: "idle", explicit: false });
    // A project-only value is ignored by Pi and reported.
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged("off"), readGlobalSettings: () => ({}), piVersion: "1.5.2" }), { mode: "idle", explicit: false, ignoredProjectMode: "off" });
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged("off"), readGlobalSettings: () => ({ cacheWarming: "streaming" }), piVersion: "1.5.2" }), { mode: "streaming", explicit: true, ignoredProjectMode: "off" });
    // Unreadable global settings: fall back to the merged view.
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged("idle"), readGlobalSettings: () => undefined, piVersion: "1.5.2" }), { mode: "idle", explicit: true });
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged(undefined), readGlobalSettings: () => { throw new Error("boom"); }, piVersion: "1.5.2" }), { mode: "idle", explicit: false });
    // The host's own default wins over the version comparison.
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged(undefined), readGlobalSettings: () => ({}), hostDefaultMode: () => "streaming", piVersion: "1.5.2" }), { mode: "streaming", explicit: false });
    assert.deepEqual(readCacheWarmingSetting({ getSettings: merged(undefined), readGlobalSettings: () => ({}), hostDefaultMode: () => { throw new Error("x"); }, piVersion: "1.5.2" }), { mode: "idle", explicit: false });
  });

  test("zero-price override reaches idle phases only when the user chose idle", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const m = model({ cost: zero });
    const stop = { action: "stop", warmCost: 0, missCost: 0 };
    // Pi 1.5.x hook events carry no phase: continuationProbability is 1 while streaming, below 1 between runs.
    assert.equal(decideZeroPriceWarming({ ...stop, continuationProbability: 1 }, m), "warm");
    assert.equal(decideZeroPriceWarming({ ...stop, continuationProbability: 0.15 }, m), undefined);
    assert.equal(decideZeroPriceWarming({ ...stop, continuationProbability: 0.15 }, m, { idleExplicit: true }), "warm");
    assert.equal(decideZeroPriceWarming(stop, m), "warm");
    assert.equal(decideZeroPriceWarming({ ...stop, phase: "streaming" }, m), "warm");
    assert.equal(decideZeroPriceWarming({ ...stop, phase: "idle" }, m), undefined);
    assert.equal(decideZeroPriceWarming({ ...stop, phase: "idle" }, m, { idleExplicit: false }), undefined);
    assert.equal(decideZeroPriceWarming({ ...stop, phase: "idle" }, m, { idleExplicit: true }), "warm");
    assert.equal(decideZeroPriceWarming({ ...stop, phase: "streaming" }, m, { idleExplicit: false }), "warm");
  });

  test("doctor labels Pi's default and project-only settings", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const m = model({ promptCache: { short: 300 }, cost: zero });
    const implicit = buildCacheWarmingDiagnosis(m, { mode: "idle", explicit: false, tier: "short", zeroPriceWarming: true });
    assert.ok(implicit.lines.some((line) => line.startsWith("- Mode: idle (Pi default)")));
    assert.ok(implicit.lines.some((line) => line.includes("covers agent runs only")));
    const chosen = buildCacheWarmingDiagnosis(m, { mode: "idle", explicit: true, tier: "short", zeroPriceWarming: true });
    assert.ok(chosen.lines.some((line) => line === "- Mode: idle — global setting, change with /settings → Cache warming or ~/.pi/agent/settings.json"));
    assert.equal(chosen.lines.some((line) => line.includes("covers agent runs only")), false);
    const ignored = buildCacheWarmingDiagnosis(m, { mode: "streaming", explicit: true, ignoredProjectMode: "off", tier: "short" });
    assert.ok(ignored.lines.some((line) => line.includes("set cacheWarming to \"off\"")));
  });
});
