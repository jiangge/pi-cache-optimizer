import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// A host that keeps one extension instance across sessions sends it a second
// session_start (Pi 1.3 builds a new instance instead). The earlier session's
// usage for the day must survive: the shard holding it is retired and the
// instance continues under a new id, as on day rollover (pre-2.10.1 the reused
// id was rewritten with the cleared counters).

const KEY = "proxy/gpt-5.5";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
void KEY; void DAY;

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-switch-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** A separately loaded module instance: its own caches, like another Pi process. */
async function loadModule(label: string): Promise<any> {
  const jiti = createJiti(join(process.cwd(), "tests", `session-switch-${label}.ts`), { interopDefault: false, moduleCache: false });
  return jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
}

type Harness = {
  loaded: any;
  I: any;
  handlers: Map<string, (event: any, context: any) => any>;
  statuses: Array<string | undefined>;
  ctx: any;
  sessionHash: string;
};

function makeContext(sessionId: string, statuses: Array<string | undefined>, mode = "json", extra: Record<string, unknown> = {}): any {
  return {
    model: {
      provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
      baseUrl: "https://api.openai.com/v1", compat: {}, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
    },
    mode, hasUI: mode === "tui",
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    ui: { notify() {}, setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
    ...extra,
  };
}

async function harness(label: string, options: { mode?: string; hooks?: any; ctx?: (statuses: Array<string | undefined>) => any } = {}): Promise<Harness> {
  const loaded = await loadModule(label);
  const I = loaded.__internals_for_tests;
  if (options.hooks) I.setStatsRefreshTestHooks(options.hooks);
  const handlers = new Map<string, (event: any, context: any) => any>();
  loaded.default({ on(name: string, handler: any) { handlers.set(name, handler); }, registerCommand() {} });
  const statuses: Array<string | undefined> = [];
  const sessionId = `incremental-${label}`;
  const ctx = options.ctx ? options.ctx(statuses) : makeContext(sessionId, statuses, options.mode);
  return { loaded, I, handlers, statuses, ctx, sessionHash: I.hashSessionId(sessionId) };
}

/** A message with `requests` worth of usage: every request a cache hit (footer "n/n"). */
function usageMessage(input = 100, cacheRead = 50) {
  return { message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input, cacheRead, cacheWrite: 0 } } };
}


function ctxFor(h: Harness, sessionId: string): any {
  return makeContext(sessionId, h.statuses);
}

async function usage(h: Harness, ctx: any, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await h.handlers.get("message_end")!(usageMessage(), ctx);
  await h.I.statsRefreshSettled();
}

/** Every shard on disk, past days folded into the archive included (the extension's read). */
async function diskShards(I: any): Promise<any[]> {
  const raw = await I.readValidStatsShardsV7();
  const archive = await I.readStatsArchive();
  return [...raw.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId)), ...archive.shards];
}

function requests(shard: any): number {
  return Object.values(shard.models).reduce((sum: number, entry: any) => sum + entry.stats.totalRequests, 0);
}

describe("a second session_start on the same extension instance", () => {
  test("after a shutdown: the previous session's shard is kept and today's total counts both sessions", async () => {
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const h = await harness("after-shutdown");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        assert.equal((await h.I.readValidStatsShardsV7()).length, 1, "the first session_start does not rotate");
        await usage(h, h.ctx, 2);
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        const first = await h.I.readValidStatsShardsV7();
        assert.equal(first.length, 1);
        const firstId = first[0].instanceId;

        const next = ctxFor(h, "session-two");
        await h.handlers.get("session_start")!({ reason: "new" }, next);
        await h.I.waitForStatsRestore();
        await usage(h, next, 1);
        assert.match(h.statuses.at(-1) ?? "", /3\/3/, "today's total keeps the first session's 2 requests");
        await h.handlers.get("session_shutdown")!({}, next);

        const shards = await h.I.readValidStatsShardsV7();
        assert.equal(shards.length, 2);
        const old = shards.find((shard: any) => shard.instanceId === firstId);
        assert.ok(old, "the first session's shard still exists under its id");
        assert.equal(requests(old), 2, "not rewritten with the cleared counters");
        assert.equal(old.lifecycle.state, "closed");
        assert.equal(old.sessionHash, h.sessionHash);
        const fresh = shards.find((shard: any) => shard.instanceId !== firstId);
        assert.equal(requests(fresh), 1);
        assert.equal(fresh.sessionHash, h.I.hashSessionId("session-two"));
        for (const shard of shards) assert.equal(shard.lifecycle.state, "closed");
      });
    });
  });

  test("the cache-hints service is published again by the next session_start after a shutdown", async () => {
    await withAgentDir(async () => {
      const h = await harness("hints-reinstall");
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      const service = h.I.getCacheHintsService();
      assert.ok(service && h.I.isOptimizerOwnedCacheHintsService(service));
      await h.handlers.get("session_shutdown")!({}, h.ctx);
      assert.notEqual(h.I.getCacheHintsService(), service, "shutdown takes it out");
      const next = ctxFor(h, "hints-two");
      await h.handlers.get("session_start")!({ reason: "new" }, next);
      await h.I.waitForStatsRestore();
      assert.equal(h.I.getCacheHintsService(), service);
      await h.handlers.get("session_shutdown")!({}, next);
      assert.notEqual(h.I.getCacheHintsService(), service);
    });
  });

  test("a session_start while the previous shutdown is still running keeps what it set up", async () => {
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const h = await harness("start-during-shutdown");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        const service = h.I.getCacheHintsService();
        (globalThis as any).__piCacheOptimizerCacheKey__ = "previous-session-key";
        const shutdown = h.handlers.get("session_shutdown")!({}, h.ctx);
        const next = ctxFor(h, "overlap-two");
        await h.handlers.get("session_start")!({ reason: "new" }, next);
        assert.equal((globalThis as any).__piCacheOptimizerCacheKey__, undefined, "the new session does not start with the previous session's key");
        await shutdown;
        await h.I.waitForStatsRestore();
        assert.equal(h.I.getCacheHintsService(), service, "the late shutdown cleanup does not take the new session's service out");
        const before = h.statuses.length;
        await usage(h, next, 1);
        assert.ok(h.statuses.length > before, "the new session's background refreshes still publish");
        await h.handlers.get("session_shutdown")!({}, next);
        assert.notEqual(h.I.getCacheHintsService(), service);
      });
    });
  });

  test("without a shutdown in between: the earlier usage is written as a closed shard, nothing is lost", async () => {
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const h = await harness("no-shutdown");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 2);
        const next = ctxFor(h, "session-two");
        await h.handlers.get("session_start")!({ reason: "new" }, next);
        await h.I.waitForStatsRestore();
        await usage(h, next, 1);
        assert.match(h.statuses.at(-1) ?? "", /3\/3/);
        await h.handlers.get("session_shutdown")!({}, next);
        const shards = await h.I.readValidStatsShardsV7();
        assert.deepEqual(shards.map(requests).sort(), [1, 2]);
        for (const shard of shards) assert.equal(shard.lifecycle.state, "closed");
      });
    });
  });

  test("a reload of the same session on the same instance keeps its usage in today's total", async () => {
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const h = await harness("reload");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 2);
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 1);
        assert.match(h.statuses.at(-1) ?? "", /3\/3/);
        await h.handlers.get("session_shutdown")!({}, h.ctx);
      });
    });
  });

  test("a retired shard whose write fails is still counted from memory", async () => {
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const h = await harness("write-fails");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 2);
        let failed = 0;
        const warn = console.warn;
        console.warn = () => {};
        h.I.setStatsFsTestHooks({
          beforeRename: async (from: string, to: string) => {
            if (failed > 0 || !to.endsWith(".json")) return;
            const { readFile } = await import("node:fs/promises");
            const shard = JSON.parse(await readFile(from, "utf8"));
            if (shard.lifecycle.state === "closed" && requests(shard) === 2) {
              failed++;
              throw Object.assign(new Error("EIO: disk full"), { code: "EIO" });
            }
          },
        });
        try {
          const next = ctxFor(h, "session-two");
          await h.handlers.get("session_start")!({ reason: "new" }, next);
          await h.I.waitForStatsRestore();
          await usage(h, next, 1);
          assert.equal(failed, 1);
          assert.match(h.statuses.at(-1) ?? "", /3\/3/, "the retired copy in memory still counts");
          await h.handlers.get("session_shutdown")!({}, next);
        } finally {
          h.I.setStatsFsTestHooks(undefined);
          console.warn = warn;
        }
        const shards = await h.I.readValidStatsShardsV7();
        assert.deepEqual(shards.map(requests).sort(), [1, 2], "the shutdown flush wrote the retired shard once more");
        for (const shard of shards) assert.equal(shard.lifecycle.state, "closed");
      });
    });
  });

  test("a retired shard whose write fails again at shutdown only warns: the shutdown completes", async () => {
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const h = await harness("write-fails-twice");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 2);
        let failed = 0;
        const warnings: string[] = [];
        const warn = console.warn;
        console.warn = (message: unknown) => { warnings.push(String(message)); };
        h.I.setStatsFsTestHooks({
          beforeRename: async (from: string, to: string) => {
            if (!to.endsWith(".json")) return;
            const { readFile } = await import("node:fs/promises");
            const shard = JSON.parse(await readFile(from, "utf8"));
            if (shard.lifecycle.state === "closed" && requests(shard) === 2) {
              failed++;
              throw Object.assign(new Error("EIO: disk full"), { code: "EIO" });
            }
          },
        });
        const next = ctxFor(h, "session-two");
        try {
          await h.handlers.get("session_start")!({ reason: "new" }, next);
          await h.I.waitForStatsRestore();
          await usage(h, next, 1);
          await h.handlers.get("session_shutdown")!({}, next);
        } finally {
          h.I.setStatsFsTestHooks(undefined);
          console.warn = warn;
        }
        assert.equal(failed, 2, "written once at retirement and retried exactly once at shutdown");
        assert.ok(warnings.some((message) => /failed again/.test(message)));
        const shards = await h.I.readValidStatsShardsV7();
        const fresh = shards.find((shard: any) => shard.sessionHash === h.I.hashSessionId("session-two"));
        assert.equal(fresh?.lifecycle.state, "closed", "the current shard's flush still landed");
        // A later shutdown (same instance, next session) does not retry again.
        await h.handlers.get("session_start")!({ reason: "new" }, ctxFor(h, "session-three"));
        await h.I.waitForStatsRestore();
        await h.handlers.get("session_shutdown")!({}, ctxFor(h, "session-three"));
        assert.equal(failed, 2);
      });
    });
  });
});

describe("a second session_start on the same instance: kill switch and day rollover", () => {
  for (const name of ["after a shutdown", "without a shutdown"]) {
    test(`with ${"PI_CACHE_OPTIMIZER_STATS_INCREMENTAL"}=0 (${name}) both sessions are kept and counted once`, async () => {
      await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total", PI_CACHE_OPTIMIZER_STATS_INCREMENTAL: "0" }, async () => {
        await withAgentDir(async () => {
          const h = await harness(`kill-switch-${name.replace(/ /g, "-")}`);
          assert.equal(h.I.isStatsIncrementalEnabled(), false);
          await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
          await h.I.waitForStatsRestore();
          await usage(h, h.ctx, 2);
          if (name === "after a shutdown") await h.handlers.get("session_shutdown")!({}, h.ctx);
          const next = ctxFor(h, "session-two");
          await h.handlers.get("session_start")!({ reason: "new" }, next);
          await h.I.waitForStatsRestore();
          await usage(h, next, 1);
          assert.match(h.statuses.at(-1) ?? "", /3\/3/);
          await usage(h, next, 1);
          assert.match(h.statuses.at(-1) ?? "", /4\/4/, "the retired copy is not counted again once its file is read");
          await h.handlers.get("session_shutdown")!({}, next);
          const shards = await diskShards(h.I);
          assert.deepEqual(shards.map(requests).sort(), [2, 2]);
        });
      });
    });
  }

  test("a session_start while a day rollover is in flight: no extra shard, nothing counted twice or lost", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        let armed = false;
        let hit!: () => void;
        const hitPromise = new Promise<void>((resolve) => { hit = resolve; });
        let release!: () => void;
        const releasePromise = new Promise<void>((resolve) => { release = resolve; });
        const h = await harness("rollover-race", {
          hooks: { beforeCommit: async () => { if (!armed) return; armed = false; hit(); await releasePromise; } },
        });
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 2);
        t.mock.timers.setTime(new Date(2026, 8, 21, 12).getTime());
        armed = true;
        // Session one's last message: its rollover waits in the first refresh.
        const late = h.handlers.get("message_end")!(usageMessage(), h.ctx);
        await hitPromise;
        const next = ctxFor(h, "session-two");
        await h.handlers.get("session_start")!({ reason: "new" }, next);
        release();
        await late;
        await h.I.waitForStatsRestore();
        await h.I.statsRefreshSettled();
        await usage(h, next, 1);
        assert.match(h.statuses.at(-1) ?? "", /2\/2/, "today: the late message and session two's request");
        await h.handlers.get("session_shutdown")!({}, next);
        const shards = await diskShards(h.I);
        const byDay = (day: string) => shards.filter((shard: any) => shard.day === day).map(requests).sort();
        assert.deepEqual(byDay("2026-09-20"), [2], "yesterday's shard keeps session one's 2 requests");
        assert.deepEqual(byDay("2026-09-21"), [2], "one shard for today, holding both of today's requests");
        for (const shard of shards) assert.equal(shard.lifecycle.state, "closed");
      });
    });
  });

  test("a day rollover reached from concurrent message_ends keeps every request on disk exactly once, under the right day", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const h = await harness("rollover-closing-write");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 2);
        t.mock.timers.setTime(new Date(2026, 8, 21, 12).getTime());
        await Promise.all([
          h.handlers.get("message_end")!(usageMessage(), h.ctx),
          h.handlers.get("message_end")!(usageMessage(), h.ctx),
        ]);
        await h.I.statsRefreshSettled();
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        const shards = await diskShards(h.I);
        const total = shards.reduce((sum: number, shard: any) => sum + requests(shard), 0);
        assert.equal(total, 4, "every request is on disk exactly once");
        assert.deepEqual(shards.filter((shard: any) => shard.day === "2026-09-20").map(requests), [2]);
      });
    });
  });

  test("a retired shard compaction folded in and removed meanwhile is not written back at shutdown (no double count)", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const h = await harness("retired-absorbed-pruned");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 2);
        // Session one's closed file lands; its retirement's closing write fails.
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        let failed = 0;
        const warn = console.warn;
        console.warn = () => {};
        h.I.setStatsFsTestHooks({
          beforeRename: async (from: string, to: string) => {
            if (failed > 0 || !to.endsWith(".json")) return;
            const { readFile } = await import("node:fs/promises");
            const shard = JSON.parse(await readFile(from, "utf8"));
            if (shard.lifecycle.state === "closed" && requests(shard) === 2) {
              failed++;
              throw Object.assign(new Error("EIO: disk full"), { code: "EIO" });
            }
          },
        });
        const next = ctxFor(h, "session-two");
        try {
          t.mock.timers.setTime(new Date(2026, 8, 20, 13).getTime());
          await h.handlers.get("session_start")!({ reason: "new" }, next);
          await h.I.waitForStatsRestore();
          await usage(h, next, 1);
          assert.equal(failed, 1);
          // Two days later, while this instance is idle, other processes'
          // maintenance folds session one's closed file into the archive and
          // deletes it, and a later pass forgets the id (its file is gone).
          t.mock.timers.setTime(new Date(2026, 8, 22, 12).getTime());
          const now = Date.now();
          assert.equal((await h.I.compactStatsShardsV7(now)).absorbed, 1);
          await h.I.compactStatsShardsV7(now + 1);
          assert.equal((await h.I.readStatsArchive()).absorbedIds.size, 0, "the id is forgotten once its file is gone");
          await h.handlers.get("session_shutdown")!({}, next);
        } finally {
          h.I.setStatsFsTestHooks(undefined);
          console.warn = warn;
        }
        const shards = await diskShards(h.I);
        assert.equal(shards.reduce((sum: number, shard: any) => sum + requests(shard), 0), 3, "session one's 2 requests are on disk once (in the archive)");
      });
    });
  });

  test("the retired shard's retry still runs when the shutdown flush itself fails", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        let refreshFails = false;
        const h = await harness("retired-retry-flush-fails", {
          hooks: { beforeCommit: async () => { if (refreshFails) throw new Error("persistent read error"); } },
        });
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await usage(h, h.ctx, 2);
        let failed = 0;
        const warn = console.warn;
        console.warn = () => {};
        h.I.setStatsFsTestHooks({
          beforeRename: async (from: string, to: string) => {
            if (failed > 0 || !to.endsWith(".json")) return;
            const { readFile } = await import("node:fs/promises");
            const shard = JSON.parse(await readFile(from, "utf8"));
            if (shard.lifecycle.state === "closed" && requests(shard) === 2) {
              failed++;
              throw Object.assign(new Error("EIO: disk full"), { code: "EIO" });
            }
          },
        });
        const next = ctxFor(h, "session-two");
        try {
          t.mock.timers.setTime(new Date(2026, 8, 20, 13).getTime());
          await h.handlers.get("session_start")!({ reason: "new" }, next);
          await h.I.waitForStatsRestore();
          await usage(h, next, 1);
          assert.equal(failed, 1);
          // The next day: the shutdown flush's rollover refresh throws.
          t.mock.timers.setTime(new Date(2026, 8, 21, 12).getTime());
          refreshFails = true;
          await assert.rejects(Promise.resolve(h.handlers.get("session_shutdown")!({}, next)), /persistent read error/);
        } finally {
          refreshFails = false;
          h.I.setStatsFsTestHooks(undefined);
          console.warn = warn;
        }
        const shards = await h.I.readValidStatsShardsV7();
        const retired = shards.filter((shard: any) => requests(shard) === 2);
        assert.equal(retired.length, 1);
        assert.equal(retired[0].lifecycle.state, "closed", "the retired shard's closing write landed");
      });
    });
  });
});
