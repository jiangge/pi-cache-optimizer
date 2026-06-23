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
 * check.
 *
 * This script also covers two follow-up defects discovered in the same code
 * path, both confirmed by reproduction before fixing:
 *
 * (B) `selfCheckFix`'s `isSubset` used a disjunction identity
 *     (`origObj === origProvider || origObj === origTargetModelRecord`) for
 *     the `mayRepairThisCompat` exemption. That matched BOTH the provider
 *     and the target model compat regardless of which level was actually
 *     edited, so a buggy editor accidentally breaking the un-edited level's
 *     same-name compat key was NOT detected (Step 6 only validates the
 *     EFFECTIVE merged compat, where model wins). Fixed by making the flag
 *     placement-aware: only `placement === X` allows that level's exemption.
 * Test 4 verifies provider-side corruption of a same-name key is now caught.
 *
 * (C) `composeMissingEntryInsertion` ran `lastIndexOf("["|"{", ...)` on the
 *     RAW original text, but the offsets came from the comment-stripped text.
 *     A JSONC comment containing `[` or `{` (e.g. `// stray { and [ here`)
 *     made `hasExisting` true on an EMPTY providers object, which produced a
 *     leading comma `{, "new": ...}` that `selfCheckMissingEntryInsertion`
 *     then rejected — silently breaking the API-logged-in entry path. Fixed
 *     by running structural searches on the comment-stripped text.
 * Test 6 verifies a comment-braced empty providers object now inserts cleanly.
 *
 * Asserts:
 *   1. value-replacement that SHORTENS the file passes selfCheckFix and lands,
 *   2. an actual truncation / data loss is still rejected,
 *   3. sibling-deletion data loss is rejected,
 *   4. un-edited-level same-name-key corruption is now caught (issue B),
 *   5. legitimate provider-level fix still passes (no false positive),
 *   6. comment-braced empty providers object auto-inserts cleanly (issue C).
 */

import { __internals_for_tests as I } from "../../../index.ts";

const {
  composeFixInsertion,
  selfCheckFix,
  locateModelInJsonc,
  analyzeModelsJsonForMissingEntry,
  composeMissingEntryInsertion,
  selfCheckMissingEntryInsertion,
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

const err = selfCheckFix(jsonc, modified, providerLabel, modelId, compatKeys, "model");
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
const err2 = selfCheckFix(jsonc, truncated, providerLabel, modelId, compatKeys, "model");
check("selfCheckFix still REJECTS a real truncation (root bracket / structure)", err2 !== null,
  err2 === null ? "" : `err=${err2}`);

// ─── Test 3: deleting a sibling model (data loss) is rejected ───
const dataLoss = modified.replace(/,\s*\{\s*"id": "deepseek-v4-pro"[\s\S]*?\}\s*\n\s*\]/, "\n      ]");
const err3 = selfCheckFix(jsonc, dataLoss, providerLabel, modelId, compatKeys, "model");
check("selfCheckFix still REJECTS deletion of a sibling model (isSubset)", err3 !== null,
  err3 === null ? "" : `err=${err3}`);

// ─── Test 4: provider.compat same-name key corruption is now CAUGHT ───
// Regression for the isSubset identity-scope gap (placement-aware repair):
// When placement="model" (the mofas/glm-5.2 case), a buggy editor that
// accidentally broke the PROVIDER's `sendSessionAffinityHeaders` (same key
// name as the repaired one) must be detected. The pre-fix OR identity
// (`origProvider || origTargetModelRecord`) wrongly skipped the provider
// check, letting the corruption through. Placement-aware gating (only
// `placement === "model" && origObj === origTargetModelRecord`) restores
// full validation at the un-edited level.
{
  const provCompatMarker = `      "compat": {\n        "sendSessionAffinityHeaders": true,\n        "supportsLongCacheRetention": true,\n        "requiresReasoningContentOnAssistantMessages": true\n      }`;
  if (!modified.includes(provCompatMarker)) {
    check("test 4 fixture: provider compat marker present in baseline", false, "marker shape differs; inspect modified text");
  } else {
    const corruptedProvMarker = provCompatMarker.replace(
      '"sendSessionAffinityHeaders": true,',
      '"sendSessionAffinityHeaders": "CORRUPTED",',
    );
    const corruptedP = modified.replace(provCompatMarker, corruptedProvMarker);
    // Sanity: model compat still says true (effective merged -> true), so
    // the old Step-6 effective-compat check alone cannot detect this.
    const mergedStillTrue = /"sendSessionAffinityHeaders": true[\s\S]*?\n        \}/.test(corruptedP.split('"models"')[1]);
    check("test 4 fixture: model compat still true (so Step 6 alone can't catch it)", mergedStillTrue);
    const err4 = selfCheckFix(jsonc, corruptedP, providerLabel, modelId, compatKeys, "model");
    check("selfCheckFix CAUGHT provider-side same-name corruption (bug #2 fixed)", err4 !== null,
      err4 === null ? "" : `err=${err4}`);
  }
}

// ─── Test 5: composable provider-level fix still passes & doesn't false-flag ───
// Place a sendSessionAffinityHeaders:true at PROVIDER level on a structure
// that has no model-level override; ensure the placement-aware self-check
// accepts the legitimate provider-level fix (no false positive).
{
  const providerOnlyJsonc = `{\n  "providers": {\n    "newprov": {\n      "models": [\n        {\n          "id": "foo",\n          "compat": {\n            "thinkingFormat": "zai"\n          }\n        }\n      ]\n    }\n  }\n}`;
  const locP = locateModelInJsonc(providerOnlyJsonc, "newprov", "foo");
  check("test 5 fixture: locateModelInJsonc finds newprov/foo", !!locP && locP.compatObjectBrace >= 0);
  const fixedP = composeFixInsertion(providerOnlyJsonc, locP!, { sendSessionAffinityHeaders: true }, "provider");
  const errP = selfCheckFix(providerOnlyJsonc, fixedP, "newprov", "foo", { sendSessionAffinityHeaders: true }, "provider");
  check("selfCheckFix accepts legitimate provider-level fix (no false positive)", errP === null,
    errP === null ? "" : `err=${errP}`);
}

// ─── Test 6: composeMissingEntryInsertion ignores `[` / `{` inside comments ───
// Regression for the comment-brace confusion bug in the missing-entry path.
// Before the fix, `composeMissingEntryInsertion` ran `lastIndexOf("["|"{", ...)`
// against the RAW original text. A JSONC comment like `// stray { and [ here`
// would surface its  `[` / `{` bytes, making `hasExisting` true on an EMPTY
// providers object and producing a stray leading comma (`{, "new": {...}}`)
// that `selfCheckMissingEntryInsertion` would reject — silently crippling the
// API-logged-in entry path (user got a confusing "manual edit required" error
// instead of a clean auto-insert). Fixed by running the structural search on
// the comment-stripped text.
{
  const commented = `{\n  "providers": {\n    // stray { brace and a [ bracket inside this comment\n  },\n  "models": {}\n}`;
  const diag = analyzeModelsJsonForMissingEntry(commented, "newprov", "preset-1");
  check("test 6 fixture: analyzeModelsJsonForMissingEntry detects provider_missing",
    !!diag && (diag as { scenario: string }).scenario === "provider_missing");
  if (diag && (diag as { scenario: string }).scenario === "provider_missing") {
    const plan = composeMissingEntryInsertion(commented, diag as never, "newprov", "preset-1", { sendSessionAffinityHeaders: true });
    // No stray leading comma between the `{` opener and the new provider key.
    check("composeMissingEntryInsertion: NO stray leading comma before new provider",
      !/\{\s*,\s*"newprov"/.test(plan.modifiedText));
    const err6 = selfCheckMissingEntryInsertion(commented, plan.modifiedText, "newprov", "preset-1", { sendSessionAffinityHeaders: true });
    check("selfCheckMissingEntryInsertion: comment-braced providers -> auto-insert now PASSES",
      err6 === null, err6 === null ? "" : `err=${err6}`);
    if (err6 === null) {
      // Sanity: the inserted entry actually parsed cleanly and the compat lands.
      const re = /"newprov": \{[\s\S]*?"sendSessionAffinityHeaders": true/.test(plan.modifiedText);
      check("selfCheckMissingEntryInsertion: inserted provider has effective sendSessionAffinityHeaders=true", re);
    }
  }
}

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) {
  console.log("\n❌ Some tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
}