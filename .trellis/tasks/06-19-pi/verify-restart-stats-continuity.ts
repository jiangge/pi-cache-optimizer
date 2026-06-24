#!/usr/bin/env bun
/**
 * Verification for footer stats continuity across Pi process/terminal restarts.
 *
 * Regression: v5 persisted stats were stored only under sessions[sessionHash].
 * On a new Pi process, ctx.sessionManager.getSessionId() changes, so the footer
 * restored only the new empty session bucket and showed 0/0 for the same
 * provider/model.
 *
 * The fix adds authoritative provider/model totals (`totalsByModel`) while
 * keeping session buckets for compatibility. Older v4/v5 files derive totals
 * once from existing session buckets; v6 files trust `totalsByModel` so reset
 * tombstones do not resurrect stale old session buckets.
 */

import { __internals_for_tests as I } from "../../../index.ts";

const {
  parsePersistedCacheStats,
  deriveTotalsByModelFromSessionStats,
  makeSessionModelKey,
  emptyCacheStats,
  buildExactRouterStatusEntry,
  mergeCacheTotals,
} = I;

type CacheStats = ReturnType<typeof emptyCacheStats>;

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

function stats(partial: Partial<CacheStats> = {}): CacheStats {
  return {
    day: "2026-06-24",
    totalRequests: 0,
    hitRequests: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalInputTokens: 0,
    ...partial,
  };
}

const oldSession = "oldsessionhash01";
const newSession = "newsessionhash02";
const modelKey = "otokapi/gpt-5.5";

const legacyV5 = {
  version: 5,
  sessions: {
    [oldSession]: {
      [modelKey]: stats({
        totalRequests: 3,
        hitRequests: 2,
        cachedInputTokens: 1200,
        cacheWriteInputTokens: 400,
        totalInputTokens: 3000,
      }),
    },
    otherhash: {
      [modelKey]: stats({
        totalRequests: 2,
        hitRequests: 1,
        cachedInputTokens: 800,
        cacheWriteInputTokens: 100,
        totalInputTokens: 2000,
      }),
      "mofas/glm-5.2": stats({ totalRequests: 1, totalInputTokens: 1000 }),
    },
  },
  legacyFamily: {},
};

const parsedV5 = parsePersistedCacheStats(legacyV5)!;
check("v5 parse succeeds", !!parsedV5);
check(
  "v5 derives provider/model totals across prior session hashes",
  parsedV5.totalsByModel[modelKey]?.totalRequests === 5 &&
    parsedV5.totalsByModel[modelKey]?.hitRequests === 3 &&
    parsedV5.totalsByModel[modelKey]?.cachedInputTokens === 2000 &&
    parsedV5.totalsByModel[modelKey]?.totalInputTokens === 5000,
  JSON.stringify(parsedV5.totalsByModel[modelKey]),
);
check(
  "new process session bucket may be empty while totals still restore footer value",
  parsedV5.statsByModel[makeSessionModelKey(newSession, "otokapi", "gpt-5.5")] === undefined &&
    parsedV5.totalsByModel[modelKey]?.totalRequests === 5,
);

const directTotals = deriveTotalsByModelFromSessionStats({
  [makeSessionModelKey("a", "otokapi", "gpt-5.5")]: stats({ totalRequests: 1, hitRequests: 1, cachedInputTokens: 10, totalInputTokens: 100 }),
  [makeSessionModelKey("b", "otokapi", "gpt-5.5")]: stats({ totalRequests: 4, hitRequests: 2, cachedInputTokens: 40, totalInputTokens: 400 }),
});
check(
  "deriveTotalsByModelFromSessionStats sums same-day same model",
  directTotals[modelKey]?.totalRequests === 5 && directTotals[modelKey]?.hitRequests === 3,
  JSON.stringify(directTotals[modelKey]),
);

const mergedAfterReset = mergeCacheTotals(
  {
    [modelKey]: stats({ totalRequests: 5, hitRequests: 3, cachedInputTokens: 2000, totalInputTokens: 5000 }),
    "mofas/glm-5.2": stats({ totalRequests: 1, totalInputTokens: 1000 }),
  },
  {},
  { deleteModelKeys: [modelKey] },
);
check(
  "mergeCacheTotals deleteModelKeys removes reset model while preserving others",
  mergedAfterReset[modelKey] === undefined && mergedAfterReset["mofas/glm-5.2"]?.totalRequests === 1,
  JSON.stringify(mergedAfterReset),
);

const replacedTotals = mergeCacheTotals(
  { [modelKey]: stats({ totalRequests: 5, totalInputTokens: 5000 }) },
  {},
  { replaceTotals: true },
);
check(
  "mergeCacheTotals replaceTotals=true writes an authoritative empty totals tombstone",
  Object.keys(replacedTotals).length === 0,
  JSON.stringify(replacedTotals),
);

const v6ResetTombstone = {
  version: 6,
  sessions: legacyV5.sessions,
  totalsByModel: {},
  legacyFamily: {},
};
const parsedTombstone = parsePersistedCacheStats(v6ResetTombstone)!;
check(
  "v6 empty totals are authoritative and do not resurrect old session stats after reset",
  Object.keys(parsedTombstone.totalsByModel).length === 0,
  JSON.stringify(parsedTombstone.totalsByModel),
);

const v6TotalsWin = {
  version: 6,
  sessions: legacyV5.sessions,
  totalsByModel: {
    [modelKey]: stats({ totalRequests: 9, hitRequests: 8, cachedInputTokens: 900, totalInputTokens: 1000 }),
  },
  legacyFamily: {},
};
const parsedV6 = parsePersistedCacheStats(v6TotalsWin)!;
check(
  "v6 uses persisted totals instead of re-deriving from sessions",
  parsedV6.totalsByModel[modelKey]?.totalRequests === 9 && parsedV6.totalsByModel[modelKey]?.hitRequests === 8,
  JSON.stringify(parsedV6.totalsByModel[modelKey]),
);

const routerEntry = buildExactRouterStatusEntry(
  newSession,
  {},
  { provider: "anthropic", id: "claude-opus-4-8", name: "claude-opus-4-8" },
  {
    "anthropic/claude-opus-4-8": stats({ totalRequests: 7, hitRequests: 6, cachedInputTokens: 700, totalInputTokens: 1000 }),
  },
);
check(
  "router exact status can restore from cumulative totals when new session has no bucket",
  routerEntry?.stats.totalRequests === 7 && routerEntry.adapter.label === "Claude cache",
  JSON.stringify(routerEntry?.stats),
);

console.log("\n=== Summary ===");
console.log(`Passed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);

if (failed > 0) process.exit(1);
console.log("\n✅ All tests passed!");
