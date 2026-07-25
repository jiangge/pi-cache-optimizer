#!/usr/bin/env bun
/**
 * Verification: direct-provider stats consolidation (response model name drift).
 *
 * Regression: GMICloud `zai-org/GLM-5.2-FP8` footer showed 0/3 (0%) even though
 * the backend was hitting cache (~62% merged). Root cause was a read/write
 * model-key asymmetry — `message_end` wrote stats under the assistant message's
 * echoed `model` field (which GMICloud normalizes to `GLM5.2-FP8` / `glm-5.2` /
 * `GLM-5.2`), while the footer read only the active-model bucket
 * `gmicloud/zai-org/GLM-5.2-FP8`. The fix consolidates stats back to the active
 * model id for direct (non-virtual-routing) providers when the response model
 * drifts only in name (same provider + same cache adapter).
 *
 * These tests exercise the pure `consolidateDirectProviderStatsModel` helper:
 *   - direct provider, same adapter, drifted id → consolidate to active id
 *   - direct provider, same id (no drift) → unchanged
 *   - direct provider, different adapter → NOT consolidated (avoid merging models)
 *   - direct provider, different provider (same adapter) → NOT consolidated
 *   - virtual routing provider → NOT consolidated (message-local identity wins)
 *   - missing ctxModel / statsModel → unchanged
 */

import { __internals_for_tests as I } from "../../../index.ts";

const { consolidateDirectProviderStatsModel, selectAdapterForModel } = I;

let failed = 0;
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`❌ FAIL  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

type PiModelLike = Parameters<typeof consolidateDirectProviderStatsModel>[0];

function mkModel(provider: string, id: string, name: string = id): PiModelLike {
  return {
    id,
    name,
    provider,
    api: "openai-completions",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as PiModelLike;
}

// Sanity: the GLM family adapter resolves for GLM-shaped ids.
const glmAdapter = selectAdapterForModel(mkModel("gmicloud", "zai-org/GLM-5.2-FP8"));
check("GLM adapter resolves for zai-org/GLM-5.2-FP8", !!glmAdapter, `adapter=${JSON.stringify(glmAdapter && (glmAdapter as { id?: string }).id)}`);
const glmAdapter2 = selectAdapterForModel(mkModel("gmicloud", "GLM5.2-FP8"));
check("GLM adapter resolves for drifted GLM5.2-FP8", !!glmAdapter2);

// ── Case 1: direct provider, same adapter, drifted id → consolidate ──
{
  const ctxModel = mkModel("gmicloud", "zai-org/GLM-5.2-FP8", "GLM 5.2 FP8 (GMICloud, 1M)");
  const statsModel = mkModel("gmicloud", "GLM5.2-FP8");
  const out = consolidateDirectProviderStatsModel(statsModel, ctxModel);
  check(
    "direct+same adapter+drifted id → consolidated to active id",
    !!out && out.id === "zai-org/GLM-5.2-FP8",
    `out.id=${out && out.id}`,
  );
  check(
    "consolidated name pinned to active model name",
    !!out && out.name === "GLM 5.2 FP8 (GMICloud, 1M)",
    `out.name=${out && out.name}`,
  );
  check(
    "consolidated provider preserved",
    !!out && out.provider === "gmicloud",
    `out.provider=${out && out.provider}`,
  );
}

// ── Case 1b: another drift variant (glm-5.2) also consolidates ──
{
  const ctxModel = mkModel("gmicloud", "zai-org/GLM-5.2-FP8", "GLM 5.2 FP8");
  const statsModel = mkModel("gmicloud", "glm-5.2");
  const out = consolidateDirectProviderStatsModel(statsModel, ctxModel);
  check(
    "drift variant glm-5.2 → consolidated to active id",
    !!out && out.id === "zai-org/GLM-5.2-FP8",
    `out.id=${out && out.id}`,
  );
}

// ── Case 2: same id (no drift) → unchanged (same reference) ──
{
  const ctxModel = mkModel("gmicloud", "zai-org/GLM-5.2-FP8");
  const statsModel = mkModel("gmicloud", "zai-org/GLM-5.2-FP8");
  const out = consolidateDirectProviderStatsModel(statsModel, ctxModel);
  check("no drift → id unchanged", !!out && out.id === "zai-org/GLM-5.2-FP8");
  check("no drift → returns same reference (no needless copy)", out === statsModel);
}

// ── Case 3: different adapter → NOT consolidated (avoid merging models) ──
{
  const ctxModel = mkModel("gmicloud", "zai-org/GLM-5.2-FP8"); // GLM adapter
  const statsModel = mkModel("gmicloud", "gpt-5.5"); // OpenAI-family adapter
  const statsAdapter = selectAdapterForModel(statsModel);
  const ctxAdapter = selectAdapterForModel(ctxModel);
  const out = consolidateDirectProviderStatsModel(statsModel, ctxModel);
  check(
    "different adapter → NOT consolidated (id preserved)",
    !!out && out.id === "gpt-5.5",
    `out.id=${out && out.id}`,
  );
  check(
    "different adapter objects (GPT vs GLM are distinct adapters)",
    !!statsAdapter && !!ctxAdapter && statsAdapter !== ctxAdapter,
  );
}

// ── Case 4: different provider, same adapter → NOT consolidated ──
{
  const ctxModel = mkModel("gmicloud", "zai-org/GLM-5.2-FP8");
  const statsModel = mkModel("h-e", "glm-5.2");
  const out = consolidateDirectProviderStatsModel(statsModel, ctxModel);
  check(
    "different provider → NOT consolidated (id preserved)",
    !!out && out.id === "glm-5.2",
    `out.id=${out && out.id}`,
  );
  check(
    "different provider → provider preserved",
    !!out && out.provider === "h-e",
    `out.provider=${out && out.provider}`,
  );
}

// ── Case 5: virtual routing provider → NOT consolidated (message-local wins) ──
{
  // active model is a router shell; real upstream is gmicloud GLM
  const ctxModel = mkModel("router", "auto");
  const statsModel = mkModel("gmicloud", "zai-org/GLM-5.2-FP8");
  const out = consolidateDirectProviderStatsModel(statsModel, ctxModel);
  check(
    "virtual routing ctx → upstream stats NOT consolidated to router id",
    !!out && out.id === "zai-org/GLM-5.2-FP8",
    `out.id=${out && out.id}`,
  );
  check(
    "virtual routing ctx → upstream provider preserved",
    !!out && out.provider === "gmicloud",
    `out.provider=${out && out.provider}`,
  );
}

// ── Case 5b: virtual routing, same provider+adapter (safety-belt isolation) ──
{
  // provider "router" matches the GLM adapter via the "glm" token in the id.
  const ctxModel = mkModel("router", "glm-5.2");
  const statsModel = mkModel("router", "GLM5.2-FP8");
  const out = consolidateDirectProviderStatsModel(statsModel, ctxModel);
  // Would consolidate by provider+adapter, BUT virtual routing excludes it.
  check(
    "virtual routing same-provider+adapter → still NOT consolidated",
    !!out && out.id === "GLM5.2-FP8",
    `out.id=${out && out.id}`,
  );
}

// ── Case 6: missing ctxModel / statsModel → unchanged ──
{
  const statsModel = mkModel("gmicloud", "GLM5.2-FP8");
  check("missing ctxModel → returns statsModel unchanged", consolidateDirectProviderStatsModel(statsModel, undefined) === statsModel);
  check("missing statsModel → returns undefined", consolidateDirectProviderStatsModel(undefined, mkModel("gmicloud", "zai-org/GLM-5.2-FP8")) === undefined);
  check("both missing → undefined", consolidateDirectProviderStatsModel(undefined, undefined) === undefined);
}

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);