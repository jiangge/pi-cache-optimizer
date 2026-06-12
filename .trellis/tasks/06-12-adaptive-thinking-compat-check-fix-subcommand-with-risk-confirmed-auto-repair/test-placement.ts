#!/usr/bin/env bun
/**
 * E2E test for auto placement detection (provider vs model level).
 * Imports real functions from index.ts via bun.
 *
 * Covers:
 * 1. Single-model provider → provider level
 * 2. Homogeneous adaptive provider (all opus-4-8) → provider level
 * 3. Mixed provider (adaptive + non-adaptive) → model level
 * 4. Channel-capability keys only (session affinity) on mixed provider → provider level
 * 5. DeepSeek keys on mixed-vendor channel (deepseek + hunyuan + kimi) → model level
 * 6. Actual insertion at provider level preserves comments + passes selfCheckFix
 * 7. Actual insertion at model level (mixed channel) passes selfCheckFix
 */

import {
  __internals_for_tests,
} from "../../../index.ts";

const {
  locateModelInJsonc,
  composeFixInsertion,
  selfCheckFix,
  decideFixPlacement,
  stripJsoncComments,
} = __internals_for_tests as any;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Test 1: single-model provider → provider level ──
console.log("\nTest 1: single-model provider");
{
  const d = decideFixPlacement({ forceAdaptiveThinking: true }, "lan", ["claude-fable-5"]);
  check("placement is provider", d.placement === "provider", d.reason);
}

// ── Test 2: homogeneous adaptive provider → provider level ──
console.log("\nTest 2: all models adaptive-generation");
{
  const d = decideFixPlacement(
    { forceAdaptiveThinking: true },
    "n1-claude",
    ["claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-4-6"],
  );
  check("placement is provider", d.placement === "provider", d.reason);
}

// ── Test 3: mixed adaptive + legacy → model level ──
console.log("\nTest 3: mixed adaptive + legacy claude");
{
  const d = decideFixPlacement(
    { forceAdaptiveThinking: true },
    "run-claude",
    ["claude-opus-4-8", "claude-opus-4-5"],
  );
  check("placement is model", d.placement === "model", d.reason);
  check("reason names the unsafe key", d.reason.includes("forceAdaptiveThinking"));
}

// ── Test 4: channel-capability keys on mixed provider → provider level ──
console.log("\nTest 4: routing keys are provider-safe even on mixed channels");
{
  const d = decideFixPlacement(
    { sendSessionAffinityHeaders: true, supportsLongCacheRetention: true },
    "tencent",
    ["deepseek-v3", "hunyuan-large", "kimi-k2.5"],
  );
  check("placement is provider", d.placement === "provider", d.reason);
}

// ── Test 5: DeepSeek behavior keys on mixed-vendor channel → model level ──
console.log("\nTest 5: deepseek keys on mixed-vendor channel");
{
  const d = decideFixPlacement(
    { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, sendSessionAffinityHeaders: true },
    "tencent",
    ["deepseek-v3", "hunyuan-large", "kimi-k2.5"],
  );
  check("placement is model", d.placement === "model", d.reason);
}

// ── Test 6: provider-level insertion on real JSONC with comments ──
console.log("\nTest 6: provider-level insertion (single-model, comments preserved)");
{
  const jsonc = `{
  // my channels
  "providers": {
    "lan": {
      "api": "anthropic-messages",
      "baseUrl": "http://10.0.0.2:8080", // LAN proxy
      "models": [
        {
          "id": "claude-fable-5",
          "name": "Claude Fable 5 (LAN)"
        }
      ]
    }
  }
}`;
  const loc = locateModelInJsonc(jsonc, "lan", "claude-fable-5");
  check("location found", !!loc);
  if (loc) {
    check("allModelIds collected", loc.allModelIds.length === 1 && loc.allModelIds[0] === "claude-fable-5", JSON.stringify(loc.allModelIds));
    check("no provider compat detected", loc.providerCompatBrace === -1);
    const d = decideFixPlacement({ forceAdaptiveThinking: true }, "lan", loc.allModelIds);
    check("auto placement = provider", d.placement === "provider");
    const out = composeFixInsertion(jsonc, loc, { forceAdaptiveThinking: true }, d.placement);
    check("comment '// my channels' preserved", out.includes("// my channels"));
    check("comment '// LAN proxy' preserved", out.includes("// LAN proxy"));
    const err = selfCheckFix(jsonc, out, "lan", "claude-fable-5", { forceAdaptiveThinking: true });
    check("selfCheckFix passes", err === null, err ?? "");
    const parsed = JSON.parse(stripJsoncComments(out));
    check("flag landed at PROVIDER level", parsed.providers.lan.compat?.forceAdaptiveThinking === true);
    check("model entry untouched", parsed.providers.lan.models[0].compat === undefined);
  }
}

// ── Test 7: provider-level insertion into EXISTING provider compat ──
console.log("\nTest 7: insertion into existing provider-level compat");
{
  const jsonc = `{
  "providers": {
    "deepseek": {
      "api": "openai-completions",
      "compat": {
        "thinkingFormat": "deepseek" /* keep */
      },
      "models": [
        { "id": "deepseek-v4-pro" },
        { "id": "deepseek-v4-flash" }
      ]
    }
  }
}`;
  const loc = locateModelInJsonc(jsonc, "deepseek", "deepseek-v4-pro");
  check("location found", !!loc);
  if (loc) {
    check("provider compat detected", loc.providerCompatBrace >= 0);
    check("both sibling ids collected", loc.allModelIds.length === 2, JSON.stringify(loc.allModelIds));
    const keys = { requiresReasoningContentOnAssistantMessages: true, sendSessionAffinityHeaders: true };
    const d = decideFixPlacement(keys, "deepseek", loc.allModelIds);
    check("auto placement = provider (all DeepSeek-like)", d.placement === "provider", d.reason);
    const out = composeFixInsertion(jsonc, loc, keys, d.placement);
    check("block comment preserved", out.includes("/* keep */"));
    const err = selfCheckFix(jsonc, out, "deepseek", "deepseek-v4-pro", keys);
    check("selfCheckFix passes", err === null, err ?? "");
    const parsed = JSON.parse(stripJsoncComments(out));
    check("existing provider key kept", parsed.providers.deepseek.compat.thinkingFormat === "deepseek");
    check("new keys at provider level", parsed.providers.deepseek.compat.requiresReasoningContentOnAssistantMessages === true);
  }
}

// ── Test 8: model-level fallback on mixed channel, end to end ──
console.log("\nTest 8: mixed channel falls back to model level");
{
  const jsonc = `{
  "providers": {
    "run-claude": {
      "api": "anthropic-messages",
      "models": [
        { "id": "claude-opus-4-8" },
        { "id": "claude-opus-4-5" } // legacy, no adaptive
      ]
    }
  }
}`;
  const loc = locateModelInJsonc(jsonc, "run-claude", "claude-opus-4-8");
  check("location found", !!loc);
  if (loc) {
    const keys = { forceAdaptiveThinking: true };
    const d = decideFixPlacement(keys, "run-claude", loc.allModelIds);
    check("auto placement = model", d.placement === "model", d.reason);
    const out = composeFixInsertion(jsonc, loc, keys, d.placement);
    const err = selfCheckFix(jsonc, out, "run-claude", "claude-opus-4-8", keys);
    check("selfCheckFix passes", err === null, err ?? "");
    const parsed = JSON.parse(stripJsoncComments(out));
    check("flag landed at MODEL level only", parsed.providers["run-claude"].models[0].compat?.forceAdaptiveThinking === true);
    check("provider level untouched", parsed.providers["run-claude"].compat === undefined);
    check("sibling model untouched", parsed.providers["run-claude"].models[1].compat === undefined);
  }
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
