#!/usr/bin/env bun
/**
 * Verification script for the `/cache-optimizer fix` self-check regression.
 *
 * Regression: when `composeFixInsertion` replaces an existing compat value
 * with a shorter one (e.g. `sendSessionAffinityHeaders: false` -> `true`,
 * 5 bytes -> 4 bytes), the resulting file is legitimately 1 byte shorter
 * than the original. The old `selfCheckFix` Step 8 heuristic
 * (`modified.length < original.length` -> "possible truncation") false-positived
 * on every such value repair and aborted the fix with:
 *   "❌ Self-check failed before write: ... content is shorter than original".
 *
 * The length heuristic was removed; real data loss is already detected by
 * Step 7 (`isSubset` structural comparison) and the root-bracket integrity
 * check. This script imports the real exported internals and asserts:
 *   1. value-replacement that SHORTENS the file passes selfCheckFix and lands,
 *   2. an actual truncation / data loss is still rejected.
 */

import { __internals_for_tests as I } from "../../../index.ts";

const {
  composeFixInsertion,
  selfCheckFix,
  locateModelInJsonc,
} = I;

let failed = 0;
let passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`❌ FAIL  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

/**
 * Mirrors the real `models.json` mofas/glm-5.2 structure: a provider with
 * provider-level `sendSessionAffinityHeaders: true`, and a model-level
 * override `sendSessionAffinityHeaders: false` that needs to be repaired
 * back to `true` (model placement, because the model owns the key).
 */
const jsonc = `{
  "providers": {
    "mofas": {
      "name": "Mofas",
      "baseUrl": "https://www.mofas.one/v1",
      "api": "openai-completions",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsLongCacheRetention": true,
        "requiresReasoningContentOnAssistantMessages": true
      },
      "models": [
        {
          "id": "glm-5.2",
          "name": "GLM 5.2 (Mofas, 1M)",
          // a trailing line comment that stripJsoncComments must survive
          "reasoning": true,
          "compat": {
            "thinkingFormat": "zai",
            "supportsLongCacheRetention": false,
            "sendSessionAffinityHeaders": false
          }
        },
        {
          "id": "deepseek-v4-pro",
          "compat": {
            "thinkingFormat": "deepseek",
            "sendSessionAffinityHeaders": true
          }
        }
      ]
    }
  }
}`;

const providerLabel = "mofas";
const modelId = "glm-5.2";

// ─── Test 1: value-replacement that legitimately SHORTENS the file ───
const loc = locateModelInJsonc(jsonc, providerLabel, modelId);
check("locateModelInJsonc finds mofas/glm-5.2 model compat", !!loc && loc.compatObjectBrace >= 0);
check("locateModelInJsonc sees 2 sibling models", !!loc && loc.allModelIds.length === 2);

const compatKeys = { sendSessionAffinityHeaders: true };
// chooseFixPlacement would force MODEL placement because the model already
// owns the key; we exercise that path directly here.
const modified = composeFixInsertion(jsonc, loc!, compatKeys, "model");
check("composeFixInsertion produced a SHORTER file (false -> true)", modified.length < jsonc.length,
  `orig=${jsonc.length} mod=${modified.length}`);

const err = selfCheckFix(jsonc, modified, providerLabel, modelId, compatKeys);
check("selfCheckFix ACCEPTS a legitimately shorter value-replacement", err === null,
  err === null ? "" : `err=${err}`);
check("edit actually landed: model compat sendSessionAffinityHeaders === true",
  /"sendSessionAffinityHeaders": true/.test(modified));
check('sibling model thinkingFormat: deepseek preserved',
  /"thinkingFormat": "deepseek"/.test(modified));
check("provider-level compat untouched (still `sendSessionAffinityHeaders: true` at provider)",
  /"compat": \{\s*\n\s*"sendSessionAffinityHeaders": true,\s*\n\s*"supportsLongCacheRetention": true/.test(modified));

// ─── Test 2: actual data loss is still rejected ───
// Simulate a corrupted "modified" text where the model compat value and the
// next key were chopped (real truncation): isSubset / bracket integrity must
// catch it, even though the file is shorter.
const truncated = composeFixInsertion(jsonc, loc!, compatKeys, "model")
  // chop closing braces + siblings off the end -> broken root bracket.
  .replace(/\}\s*\}\s*\}\s*$/, "");
const err2 = selfCheckFix(jsonc, truncated, providerLabel, modelId, compatKeys);
check("selfCheckFix still REJECTS a real truncation (root bracket / structure)", err2 !== null,
  err2 === null ? "" : `err=${err2}`);

// ─── Test 3: deleting a sibling model (data loss) is rejected ───
const dataLoss = modified.replace(/,\s*\{\s*"id": "deepseek-v4-pro"[\s\S]*?\}\s*\n\s*\]/, "\n      ]");
const err3 = selfCheckFix(jsonc, dataLoss, providerLabel, modelId, compatKeys);
check("selfCheckFix still REJECTS deletion of a sibling model (isSubset)", err3 !== null,
  err3 === null ? "" : `err=${err3}`);

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) {
  console.log("\n❌ Some tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
}