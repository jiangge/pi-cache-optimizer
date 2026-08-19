import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { __internals_for_tests as internals } from "#extension";

/**
 * Process-wide live totals (parent + subagent aggregation).
 *
 * pi-minions runs each subagent as a separate in-process AgentSession that
 * loads its own copy of this extension. Every instance's `message_end` folds
 * its usage into a shared process-global sink (globalThis), and the parent
 * instance's footer "total" mode reads that sink, so the displayed counters
 * include subagent cache traffic. These tests exercise the sink semantics:
 * aggregation without double counting, seeding from persisted totals, day
 * rollover, and reset behavior.
 */

function currentDay(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

describe("process-wide live totals (parent + subagent aggregation)", () => {
  const model = { provider: "DIGUA-AI-RESPONS", id: "deepseek-v4-flash" };
  const key = `${model.provider}/${model.id}`;

  beforeEach(() => {
    internals.resetLiveTotalsSink();
  });
  afterEach(() => {
    internals.resetLiveTotalsSink();
  });

  test("folds usage from every instance into one shared sink without double counting", () => {
    // Persisted baseline seeded at parent session_start.
    internals.seedLiveTotalsSink({
      [key]: {
        day: currentDay(),
        totalRequests: 500,
        hitRequests: 500,
        cachedInputTokens: 110_000_000,
        cacheWriteInputTokens: 0,
        totalInputTokens: 110_800_000,
      },
    });

    // Parent session live events: 10 requests, 8 hits.
    for (let i = 0; i < 10; i++) {
      internals.addUsageToLiveTotals(model, {
        cacheRead: i < 8 ? 190_000 : 0,
        cacheWrite: 0,
        totalInput: 220_000,
      });
    }
    // Subagent A: 6 requests, all hits.
    for (let i = 0; i < 6; i++) {
      internals.addUsageToLiveTotals(model, {
        cacheRead: 233_333,
        cacheWrite: 0,
        totalInput: 233_333,
      });
    }
    // Subagent B: 4 requests, 2 hits.
    for (let i = 0; i < 4; i++) {
      internals.addUsageToLiveTotals(model, {
        cacheRead: i < 2 ? 250_000 : 0,
        cacheWrite: 0,
        totalInput: 225_000,
      });
    }

    const s = internals.liveTotalsSink()[key];
    assert.equal(s.totalRequests, 520);
    assert.equal(s.hitRequests, 516);
    assert.equal(s.cachedInputTokens, 113_419_998);
    assert.equal(s.totalInputTokens, 115_299_998);
  });

  test("seed resets the sink to exactly the persisted baseline", () => {
    internals.addUsageToLiveTotals(model, { cacheRead: 0, cacheWrite: 0, totalInput: 100 });
    const baseline = {
      day: currentDay(),
      totalRequests: 3,
      hitRequests: 2,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 0,
      totalInputTokens: 60,
    };
    internals.seedLiveTotalsSink({ [key]: baseline });
    assert.deepEqual(internals.liveTotalsSink(), { [key]: baseline });
  });

  test("rolls stale-day entries over to the current day bucket", () => {
    internals.seedLiveTotalsSink({
      [key]: {
        day: "2000-01-01",
        totalRequests: 5,
        hitRequests: 5,
        cachedInputTokens: 500,
        cacheWriteInputTokens: 0,
        totalInputTokens: 500,
      },
    });
    internals.rollOverLiveTotalsSink();
    const s = internals.liveTotalsSink()[key];
    assert.equal(s.totalRequests, 0);
    assert.notEqual(s.day, "2000-01-01");
    // New-day events accumulate on the fresh bucket.
    internals.addUsageToLiveTotals(model, { cacheRead: 0, cacheWrite: 0, totalInput: 100 });
    assert.equal(internals.liveTotalsSink()[key].totalRequests, 1);
  });

  test("reset removes a single model key or clears the whole sink", () => {
    internals.addUsageToLiveTotals(model, { cacheRead: 10, cacheWrite: 0, totalInput: 20 });
    internals.addUsageToLiveTotals({ provider: "p2", id: "m2" }, { cacheRead: 0, cacheWrite: 0, totalInput: 5 });

    internals.resetLiveTotalsSink(key);
    assert.equal(internals.liveTotalsSink()[key], undefined);
    assert.ok(internals.liveTotalsSink()["p2/m2"]);

    internals.resetLiveTotalsSink();
    assert.deepEqual(internals.liveTotalsSink(), {});
  });

  test("identifies the top-level session instance by PI_SESSION_ID", () => {
    const previous = process.env.PI_SESSION_ID;
    try {
      process.env.PI_SESSION_ID = "parent-session-123";
      assert.equal(
        internals.isParentSessionInstance({
          sessionManager: { getSessionId: () => "parent-session-123" },
        }),
        true,
      );
      assert.equal(
        internals.isParentSessionInstance({
          sessionManager: { getSessionId: () => "minion-session-456" },
        }),
        false,
      );
      assert.equal(
        internals.isParentSessionInstance({
          sessionManager: { getSessionId: () => undefined },
        }),
        false,
      );
      assert.equal(internals.isParentSessionInstance({}), false);
    } finally {
      if (previous === undefined) {
        delete process.env.PI_SESSION_ID;
      } else {
        process.env.PI_SESSION_ID = previous;
      }
    }
  });
});
