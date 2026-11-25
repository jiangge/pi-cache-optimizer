import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// 2.10 incremental footer refresh: the single-flight scheduler, the tiered
// shard index, the non-awaited lifecycle refreshes and the fixes the design
// review required (day-rollover deadlock, unhandled rejections, epoch
// interleaving, the epoch EPERM fallback, the 2.9.0 / pending / corrupt
// archive cases, the watcher 'error' crash, the shutdown gate). Call counts
// go through the injected read facade, never through timing.

const KEY = "proxy/gpt-5.5";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-incremental-"));
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
  const jiti = createJiti(join(process.cwd(), "tests", `stats-incremental-${label}.ts`), { interopDefault: false, moduleCache: false });
  return jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
}
async function load(label: string): Promise<any> {
  return (await loadModule(label)).__internals_for_tests;
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

async function writeShard(I: any, options: {
  id?: string; session: string; state?: "active" | "closed"; updatedAt: number; day?: string; requests: number; globalEpoch?: string; modelEpoch?: string; key?: string;
}): Promise<string> {
  const id = options.id ?? randomUUID();
  const key = options.key ?? KEY;
  const [provider, modelId] = key.split("/") as [string, string];
  const day = options.day ?? localDay(options.updatedAt);
  const state = options.state ?? "closed";
  await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${id}.json`), {
    version: 7, kind: "pi-cache-optimizer-shard", instanceId: id, sessionHash: options.session,
    process: { pid: 999_999, ppid: 0, instanceStartedAt: 1 },
    lifecycle: { state, createdAt: options.updatedAt, updatedAt: options.updatedAt, ...(state === "closed" ? { closedAt: options.updatedAt } : {}) },
    day, globalEpoch: options.globalEpoch ?? await I.readGlobalStatsEpoch(),
    models: options.requests === 0 ? {} : {
      [key]: {
        modelEpoch: options.modelEpoch ?? await I.readModelStatsEpoch(key), provider, modelId,
        stats: { day, totalRequests: options.requests, hitRequests: options.requests, cachedInputTokens: 50 * options.requests, cacheWriteInputTokens: 0, totalInputTokens: 100 * options.requests },
      },
    },
  });
  return id;
}

/** A v1 archive document (2.9.0's archive.json format, also the input of encodeStatsArchiveV2). */
async function archiveDoc(I: any, session: string, requests: number, absorbed: Record<string, number>, at: number) {
  const day = localDay(at);
  return {
    version: 1, kind: "pi-cache-optimizer-archive", updatedAt: at, absorbed,
    buckets: [{
      globalEpoch: await I.readGlobalStatsEpoch(), sessionHash: session, modelKey: KEY, modelEpoch: await I.readModelStatsEpoch(KEY),
      day, provider: "proxy", modelId: "gpt-5.5", updatedAt: at,
      stats: { day, totalRequests: requests, hitRequests: requests, cachedInputTokens: 50 * requests, cacheWriteInputTokens: 0, totalInputTokens: 100 * requests },
    }],
    routed: [],
  };
}

async function writeGeneration(I: any, generation: number, doc: any): Promise<void> {
  await mkdir(join(I.SHARD_ARCHIVE_PATH, ".."), { recursive: true });
  await writeFile(I.statsArchiveGenerationPath(I.SHARD_ARCHIVE_PATH, generation), JSON.stringify(I.encodeStatsArchiveV2(doc, generation)) + "\n");
}

/** Keep startup maintenance from compacting a hand-made fixture. */
async function suppressMaintenance(I: any): Promise<void> {
  const directory = join(I.SHARD_STATE_DIR, "maintenance");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "last-cleanup"), `${Date.now()}\n`);
  await writeFile(join(directory, "last-compaction"), `${Date.now()}\n`);
}

async function captureWarnings<T>(run: () => Promise<T>): Promise<{ value: T; warnings: unknown[][] }> {
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = warn;
  }
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(`${label}: did not finish within ${ms} ms`); })]);
}

const requestsOf = (status: string | undefined): number | undefined => {
  const match = /cache (\d+)\/(\d+)/.exec(status ?? "");
  return match ? Number(match[2]) : undefined;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("refresh scheduler", () => {
  test("single flight with one trailing run; a caller never gets a result read before its call", async () => {
    const I = await load("scheduler");
    let clock = 0;
    let runs = 0;
    const scheduler = new I.StatsRefreshScheduler(async (full: boolean) => {
      runs++;
      const readAt = ++clock;
      await sleep(5);
      return { readAt, full };
    });
    const calls: Array<{ calledAt: number; result: Promise<any> }> = [];
    for (let i = 0; i < 50; i++) calls.push({ calledAt: ++clock, result: scheduler.request(i === 30) });
    const results = await Promise.all(calls.map((call) => call.result));
    assert.equal(runs, 2, "50 concurrent requests: the running one and one trailing run");
    results.forEach((result, index) => assert.ok(result.readAt > calls[index]!.calledAt, `caller ${index} got a result read before its call`));
    assert.equal(results[0].full, false);
    assert.equal(results[49].full, true, "the trailing run is full when any joiner asked for it");

    // A request made while a run is in flight joins the trailing run, never the running one (flush semantics).
    const first = scheduler.request();
    const calledAt = ++clock;
    const second = scheduler.request();
    assert.ok((await second).readAt > calledAt);
    assert.notEqual(await first, await second);
  });

  test("a run that requests a refresh rejects instead of waiting for itself; the gate refuses background work; drain", async () => {
    const I = await load("scheduler-reentrant");
    let scheduler: any;
    scheduler = new I.StatsRefreshScheduler(async () => {
      await sleep(1);
      return scheduler.request();
    });
    await assert.rejects(within(scheduler.request(), 2_000, "re-entrant request"), /requested another refresh/);
    // Work a run starts outside its async context (scans) may request again.
    let ran = 0;
    const outer = new I.StatsRefreshScheduler(async () => {
      ran++;
      if (ran === 1) outer.outsideRun(() => { void outer.request(); });
      return ran;
    });
    await outer.request();
    await outer.drain();
    assert.equal(ran, 2);

    const gated = new I.StatsRefreshScheduler(async () => { await sleep(20); return 1; });
    const running = gated.request();
    gated.close();
    assert.equal(await gated.background(), undefined, "closed: no background refresh");
    assert.equal(await gated.request(), 1, "awaited (foreground) requests still run while closed");
    await running;
    await gated.drain();
    assert.equal(gated.idle, true);
    gated.open();
    assert.equal(await gated.background(), 1);
  });
});

describe("tiered shard index", () => {
  test("steady state stats only the hot set and never reads; new and dirty names are stat-ed; equal to the reference", async () => {
    await withAgentDir(async () => {
      const I = await load("index-counts");
      const now = Date.now();
      const cold: string[] = [];
      for (let i = 0; i < 20; i++) cold.push(await writeShard(I, { session: `s${i % 3}`, updatedAt: now - 2 * HOUR - i, requests: 1 }));
      const recentClosed = await writeShard(I, { session: "s0", updatedAt: now - 5 * MINUTE, requests: 2 });
      const active = await writeShard(I, { session: "s1", state: "active", updatedAt: now - 3 * HOUR, requests: 3 });
      const own = await writeShard(I, { session: "s2", state: "active", updatedAt: now, requests: 4 });
      const counting = I.countingStatsReadFs();
      I.setStatsReadFsForTests(counting.fs);
      try {
        const index = new I.TieredShardIndex(I.SHARD_FILES_DIR, { freeze: true });
        const first = await index.refresh({ own: `${own}.json` });
        assert.equal(counting.counts.readdir, 1);
        assert.equal(counting.counts.lstat, 22, "first refresh: every name but the own one");
        assert.equal(counting.counts.readFile, 22);
        assert.ok(!counting.counts.paths.some((path: string) => path.includes(own)), "the own shard is never stat-ed or read");
        const reference = (await I.readValidStatsShardsV7()).filter((shard: any) => shard.instanceId !== own);
        assert.equal(JSON.stringify(first), JSON.stringify(reference));

        counting.reset();
        const steady = await index.refresh({ own: `${own}.json` });
        assert.deepEqual({ readdir: counting.counts.readdir, lstat: counting.counts.lstat, readFile: counting.counts.readFile, stat: counting.counts.stat },
          { readdir: 1, lstat: 2, readFile: 0, stat: 0 }, "steady state: one listing plus the hot set (active + updated within 15 min)");
        assert.deepEqual(counting.counts.paths.filter((path: string) => path.startsWith("lstat")).map((path: string) => path.split("/").at(-1)).sort(),
          [`${recentClosed}.json`, `${active}.json`].sort());
        assert.equal(JSON.stringify(steady), JSON.stringify(reference));

        // A new shard and a watcher-dirty cold shard: stat-ed (and read) at once.
        const fresh = await writeShard(I, { session: "s0", updatedAt: now - 4 * HOUR, requests: 5 });
        await writeShard(I, { id: cold[3], session: "s0", updatedAt: now - 2 * HOUR, requests: 9 });
        index.markDirty(`${cold[3]}.json`);
        counting.reset();
        const changed = await index.refresh({ own: `${own}.json` });
        assert.equal(counting.counts.lstat, 4, "hot set + the new name + the dirty one");
        assert.equal(counting.counts.readFile, 2, "only the files whose identity changed");
        assert.equal(JSON.stringify(changed), JSON.stringify((await I.readValidStatsShardsV7()).filter((shard: any) => shard.instanceId !== own)));
        assert.ok(changed.some((shard: any) => shard.instanceId === fresh));
        // Deletions are seen through the listing alone.
        await unlink(join(I.SHARD_FILES_DIR, `${cold[0]}.json`));
        counting.reset();
        const afterDelete = await index.refresh({ own: `${own}.json` });
        assert.equal(counting.counts.lstat, 2);
        assert.ok(!afterDelete.some((shard: any) => shard.instanceId === cold[0]));
        assert.ok(Object.isFrozen(afterDelete) && Object.isFrozen(afterDelete[0]) && Object.isFrozen(afterDelete[0].models), "cached shards are shared read-only (deep-frozen here)");
      } finally {
        I.setStatsReadFsForTests(undefined);
      }
    });
  });

  test("cold shards: stale until the next full scan (bounded by its interval), at most 2 calls in flight; a dirty mark is immediate", async () => {
    await withAgentDir(async () => {
      const I = await load("index-cold");
      const now = Date.now();
      const names: string[] = [];
      for (let i = 0; i < 12; i++) names.push(await writeShard(I, { session: "s", updatedAt: now - 3 * HOUR, requests: 1 }));
      const target = names[5]!;
      let mono = 0;
      let inFlight = 0;
      let peak = 0;
      const base = I.countingStatsReadFs().fs;
      I.setStatsReadFsForTests({
        ...base,
        lstat: async (path: string) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          try { await sleep(2); return await base.lstat(path); } finally { inFlight--; }
        },
      });
      try {
        const index = new I.TieredShardIndex(I.SHARD_FILES_DIR, { monotonicNow: () => mono, fullScanIntervalMs: 30_000 });
        await index.refresh();
        await index.maybeStartFullScan(() => undefined); // due at once; sets the baseline
        const total = (shards: any[]) => shards.reduce((sum, shard) => sum + (shard.models[KEY]?.stats.totalRequests ?? 0), 0);
        assert.equal(total(await index.refresh()), 12);
        // A protocol-violating rewrite of a closed, old shard (no live process does this).
        await writeShard(I, { id: target, session: "s", updatedAt: now - 3 * HOUR, requests: 4 });
        assert.equal(total(await index.refresh()), 12, "cold: not stat-ed by a lifecycle refresh");
        mono = 29_999;
        assert.equal(index.maybeStartFullScan(() => undefined), undefined, "not due before the interval");
        mono = 30_000;
        peak = 0;
        assert.equal(await index.maybeStartFullScan(() => undefined), true, "the scan reports a change");
        assert.ok(peak <= 2, `full scan concurrency ${peak}`);
        assert.equal(total(await index.refresh()), 15);
        await writeShard(I, { id: target, session: "s", updatedAt: now - 3 * HOUR, requests: 7 });
        index.markDirty(`${target}.json`);
        assert.equal(total(await index.refresh()), 18, "a watcher-dirty shard is current at the next refresh");
      } finally {
        I.setStatsReadFsForTests(undefined);
      }
    });
  });

  test("a name that is not a regular file is not reported as a change by every full scan", async () => {
    await withAgentDir(async () => {
      const I = await load("index-dir-name");
      const now = Date.now();
      await writeShard(I, { session: "s", updatedAt: now - 3 * HOUR, requests: 1 });
      await mkdir(join(I.SHARD_FILES_DIR, `${randomUUID()}.json`));
      let mono = 0;
      const index = new I.TieredShardIndex(I.SHARD_FILES_DIR, { monotonicNow: () => mono, fullScanIntervalMs: 1 });
      assert.equal((await index.refresh()).length, 1);
      mono = 10;
      assert.equal(await index.maybeStartFullScan(() => undefined), false, "nothing changed since the refresh");
      mono = 20;
      assert.equal(await index.maybeStartFullScan(() => undefined), false, "still nothing (a scan reporting a change triggers another refresh)");
    });
  });

  test("STATS_VERIFY: content changed behind an unchanged identity (FAT/SMB) is found, re-read, and warned about once found twice", async () => {
    await withAgentDir(async () => {
      const h = await harness("verify", { hooks: { fullScanIntervalMs: 0 } });
      const now = Date.now();
      const id = await writeShard(h.I, { session: "other", updatedAt: now - 3 * HOUR, requests: 3 });
      // A filesystem without inodes and with coarse timestamps: the identity never changes.
      h.I.setStatsFsTestHooks({ shardStat: (_path: string, info: any) => { info.ino = 0; info.mtimeMs = 2000; info.ctimeMs = 2000; info.birthtimeMs = 2000; return info; } });
      const total = () => { const match = /cache (\d+)\/(\d+)/.exec(h.statuses.at(-1) ?? ""); return match ? Number(match[2]) : -1; };
      try {
        await withEnv({ [h.I.STATS_VERIFY_ENV]: "1" }, async () => {
          const { warnings } = await captureWarnings(async () => {
            await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
            await h.I.waitForStatsRestore();
            await h.I.statsRefreshSettled();
            assert.equal(total(), 0, "another session's shard: not in this session's footer");
            const index = new h.I.TieredShardIndex(h.I.SHARD_FILES_DIR);
            const requestsIn = (shards: any[]) => shards.find((shard) => shard.instanceId === id)?.models[KEY]?.stats.totalRequests;
            assert.equal(requestsIn(await index.refresh()), 3);
            await writeShard(h.I, { id, session: "other", updatedAt: now - 3 * HOUR, requests: 4 }); // same size
            index.markDirty(`${id}.json`);
            assert.equal(requestsIn(await index.refresh()), 3, "the identity hides the change from stat-ing");
            assert.deepEqual(await index.verifyCachedContents(), [`${id}.json`]);
            assert.equal(requestsIn(await index.refresh()), 4, "re-read after the verdict");
            assert.deepEqual(await index.verifyCachedContents(), [], "consistent again");

            // The extension: two background verifications in a row find a hidden change.
            for (const requests of [5, 6]) {
              await writeShard(h.I, { id, session: "other", updatedAt: now - 3 * HOUR, requests });
              await h.handlers.get("tool_execution_end")!({ toolCallId: `v${requests}` }, h.ctx);
              await h.I.statsRefreshSettled();
            }
            await h.handlers.get("session_shutdown")!({}, h.ctx);
          });
          const verifyWarnings = warnings.filter((args) => String(args[0]).includes("hides changes from the incremental refresh"));
          assert.equal(verifyWarnings.length, 1, JSON.stringify(warnings.map((args) => String(args[0]))));
        });
      } finally {
        h.I.setStatsFsTestHooks(undefined);
      }
    });
  });

  test("equivalence fuzz: the index (plus the synchronous aggregation) equals readValidStatsShardsV7 + aggregateStatsWithArchiveV7", async () => {
    for (const seed of (process.env.STATS_INDEX_FUZZ_SEEDS ?? "1,7,42,2026").split(",").map(Number)) {
      await withAgentDir(async () => {
        const I = await load(`index-fuzz-${seed}`);
        let state = seed >>> 0;
        const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
        const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
        const keys = ["proxy/gpt-5.5", "anthropic/claude-x", "deepseek/v4"];
        const sessions = ["s1", "s2", "s3", "s4"];
        let wall = Date.now();
        await mkdir(I.SHARD_FILES_DIR, { recursive: true });
        const index = new I.TieredShardIndex(I.SHARD_FILES_DIR, { wallNow: () => wall, freeze: true, monotonicNow: () => 0, fullScanIntervalMs: 1 });
        const live = new Map<string, { updatedAt: number; state: string }>();
        let needScan = false;
        const write = async (id: string, options: { state: string; updatedAt: number; session?: string }) => {
          const key = pick(keys);
          const [provider, modelId] = key.split("/") as [string, string];
          const day = random() < 0.8 ? localDay(wall) : localDay(wall - DAY);
          const models: Record<string, unknown> = {};
          for (const k of keys) {
            if (k !== key && random() < 0.6) continue;
            const requests = 1 + Math.floor(random() * 5);
            const [p, m] = k.split("/") as [string, string];
            models[k] = {
              modelEpoch: random() < 0.85 ? await I.readModelStatsEpoch(k) : "stale-model-epoch", provider: p, modelId: m, ...(random() < 0.5 ? { modelName: `${m} n` } : {}),
              stats: { day: random() < 0.9 ? day : localDay(wall - 2 * DAY), totalRequests: requests, hitRequests: Math.floor(requests / 2), cachedInputTokens: requests, cacheWriteInputTokens: 0, totalInputTokens: 10 * requests },
            };
          }
          void provider; void modelId;
          await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${id}.json`), {
            version: 7, kind: "pi-cache-optimizer-shard", instanceId: id, sessionHash: options.session ?? pick(sessions),
            process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
            lifecycle: { state: options.state, createdAt: options.updatedAt, updatedAt: options.updatedAt, ...(options.state === "closed" ? { closedAt: options.updatedAt } : {}) },
            day, globalEpoch: random() < 0.9 ? await I.readGlobalStatsEpoch() : "stale-global-epoch", models,
            ...(random() < 0.5 ? { lastRoutedModel: { provider: "proxy", id: pick(["a", "b", "c"]), name: "n" } } : {}),
          });
          live.set(id, { updatedAt: options.updatedAt, state: options.state });
        };
        const hotNames = () => Array.from(live).filter(([, s]) => s.state === "active" || wall - s.updatedAt < 15 * MINUTE).map(([id]) => id);
        const coldNames = () => Array.from(live).filter(([, s]) => s.state !== "active" && wall - s.updatedAt >= 15 * MINUTE).map(([id]) => id);
        const archive = await I.readStatsArchiveView();
        let previousOwn: string | undefined;
        for (let step = 0; step < 160; step++) {
          const roll = random();
          let noop = false;
          if (roll < 0.25 || live.size < 3) {
            await write(randomUUID(), { state: random() < 0.4 ? "active" : "closed", updatedAt: wall - Math.floor(random() * 2 * HOUR) });
          } else if (roll < 0.45 && hotNames().length > 0) {
            await write(pick(hotNames()), { state: random() < 0.7 ? "active" : "closed", updatedAt: wall });
          } else if (roll < 0.52 && coldNames().length > 0) {
            const id = pick(coldNames());
            await write(id, { state: "closed", updatedAt: live.get(id)!.updatedAt });
            if (random() < 0.5) index.markDirty(`${id}.json`);
            else needScan = true;
          } else if (roll < 0.6 && live.size > 0) {
            const id = pick(Array.from(live.keys()));
            await unlink(join(I.SHARD_FILES_DIR, `${id}.json`)).catch(() => undefined);
            live.delete(id);
          } else if (roll < 0.64) {
            await writeFile(join(I.SHARD_FILES_DIR, `${randomUUID()}.json`), random() < 0.5 ? "{truncated" : JSON.stringify({ version: 7, kind: "nope" }));
          } else if (roll < 0.66) {
            await mkdir(join(I.SHARD_FILES_DIR, `${randomUUID()}.json`));
          } else if (roll < 0.68) {
            // Valid schema under another file name: parsed but never a shard.
            const id = randomUUID();
            await write(id, { state: "closed", updatedAt: wall });
            await writeFile(join(I.SHARD_FILES_DIR, `${randomUUID()}.json`), await readFile(join(I.SHARD_FILES_DIR, `${id}.json`), "utf8"));
          } else if (roll < 0.76) {
            wall += Math.floor(random() * 40 * MINUTE);
          } else if (roll < 0.79) {
            await I.advanceGlobalStatsEpoch();
          } else if (roll < 0.82) {
            await I.advanceModelStatsEpoch(pick(keys));
          } else {
            noop = true;
          }
          if (needScan) {
            index.requestFullScan();
            await index.maybeStartFullScan(() => undefined);
            needScan = false;
          }
          const own = random() < 0.3 && live.size > 0 ? `${pick(Array.from(live.keys()))}.json` : undefined;
          const counting = I.countingStatsReadFs();
          I.setStatsReadFsForTests(counting.fs);
          let incremental: any[];
          try {
            incremental = await index.refresh({ own });
          } finally {
            I.setStatsReadFsForTests(undefined);
          }
          const reference = (await I.readValidStatsShardsV7()).filter((shard: any) => `${shard.instanceId}.json` !== own);
          assert.equal(JSON.stringify(incremental), JSON.stringify(reference), `seed ${seed} step ${step}: shard list`);
          // (A name that stops being the own one was never read: it is read once.)
          if (noop && own === previousOwn) assert.equal(counting.counts.readFile, 0, `seed ${seed} step ${step}: nothing changed, nothing read`);
          previousOwn = own;
          const trailing = random() < 0.5 ? [reference.at(-1)].filter(Boolean) : [];
          for (const day of [localDay(wall), null]) {
            for (const only of [undefined, new Set([pick(sessions)]), new Set<string>()]) {
              const expected = await I.aggregateStatsWithArchiveV7(reference, archive, trailing, day, only);
              const keysToRead = I.aggregateEpochKeys(incremental, archive, trailing, day, only);
              const globalEpoch = await I.readGlobalStatsEpoch();
              const modelEpochs = new Map<string, string>();
              for (const key of keysToRead) modelEpochs.set(key, await I.readModelStatsEpoch(key));
              const actual = I.aggregateStatsWithArchiveSync(incremental, archive, trailing, day, only, {
                globalEpoch, modelEpoch: (key: string) => { const epoch = modelEpochs.get(key); assert.ok(epoch !== undefined, `epoch of ${key} prefetched`); return epoch; },
              });
              assert.equal(JSON.stringify(actual), JSON.stringify(expected), `seed ${seed} step ${step}: aggregate day=${day}`);
            }
          }
        }
      });
    }
  });
});

describe("archive CPU path", () => {
  test("lazy per-session reduction equals the synthetic-shard reference (random archives, epochs, ties)", async () => {
    await withAgentDir(async () => {
      const I = await load("archive-cpu");
      await I.advanceModelStatsEpoch("anthropic/claude-x");
      const globalEpoch = await I.readGlobalStatsEpoch();
      for (let seed = 1; seed <= 40; seed++) {
        let state = seed;
        const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
        const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
        const keys = ["proxy/gpt-5.5", "anthropic/claude-x", "deepseek/v4"];
        const sessions = ["s1", "s2", "s3", "s4", "s5"];
        const modelEpochs = new Map<string, string>();
        for (const key of keys) modelEpochs.set(key, await I.readModelStatsEpoch(key));
        const buckets = Array.from({ length: Math.floor(random() * 60) }, () => {
          const key = pick(keys);
          const [provider, modelId] = key.split("/") as [string, string];
          const day = `2026-0${1 + Math.floor(random() * 9)}-1${Math.floor(random() * 9)}`;
          const requests = 1 + Math.floor(random() * 9);
          return {
            globalEpoch: random() < 0.8 ? globalEpoch : "old-global", sessionHash: pick(sessions), modelKey: key,
            modelEpoch: random() < 0.8 ? modelEpochs.get(key)! : "old-model", day, provider, modelId,
            ...(random() < 0.5 ? { modelName: `${modelId}-${Math.floor(random() * 3)}` } : {}),
            updatedAt: pick([-5, -1, 0, 1000, 1000, 2000, Math.floor(random() * 5000)]),
            stats: { day, totalRequests: requests, hitRequests: Math.floor(requests / 2), cachedInputTokens: requests, cacheWriteInputTokens: 1, totalInputTokens: 10 * requests },
          };
        });
        const routed = Array.from({ length: Math.floor(random() * 20) }, () => ({
          globalEpoch: random() < 0.8 ? globalEpoch : "old-global", sessionHash: pick(sessions), day: "2026-01-11",
          updatedAt: pick([-3, -1, 0, 500, 500, Math.floor(random() * 900)]), model: { provider: "proxy", id: pick(["a", "b"]), name: "n" },
        }));
        const view = new I.StatsArchiveView({ version: 1, kind: "pi-cache-optimizer-archive", updatedAt: 1, absorbed: {}, buckets, routed }, true, false, 1);
        const shard = (session: string, requests: number, updatedAt: number) => ({
          version: 7, kind: "pi-cache-optimizer-shard", instanceId: randomUUID(), sessionHash: session, process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
          lifecycle: { state: "closed", createdAt: 1, updatedAt, closedAt: updatedAt }, day: "2026-09-01", globalEpoch,
          models: { [KEY]: { modelEpoch: modelEpochs.get(KEY)!, provider: "proxy", modelId: "gpt-5.5", stats: { day: "2026-09-01", totalRequests: requests, hitRequests: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: requests } } },
          ...(random() < 0.5 ? { lastRoutedModel: { provider: "proxy", id: "c", name: "c" } } : {}),
        });
        const leading = Array.from({ length: Math.floor(random() * 4) }, () => shard(pick(sessions), 2, Math.floor(random() * 3000)));
        const trailing = Array.from({ length: Math.floor(random() * 2) }, () => shard(pick(sessions), 3, 1000));
        for (const only of [undefined, new Set([pick(sessions)]), new Set([pick(sessions), pick(sessions), pick(sessions)]), new Set<string>(), new Set(["missing"])]) {
          const include = (s: any) => !only || only.has(s.sessionHash);
          const reference = await I.aggregateStatsShardsV7(structuredClone([...leading, ...view.shards, ...trailing].filter(include)), null);
          const actual = await I.aggregateStatsWithArchiveV7(leading, view, trailing, null, only);
          assert.equal(JSON.stringify(actual), JSON.stringify(reference), `seed ${seed} sessions ${only ? [...only] : "all"}`);
          // Twice: the cached contribution must give the same result.
          assert.equal(JSON.stringify(await I.aggregateStatsWithArchiveV7(leading, view, trailing, null, only)), JSON.stringify(reference));
        }
      }
    });
  });
});

describe("non-awaited lifecycle refreshes", () => {
  test("a day rollover reached from a background refresh's publish does not deadlock (and shutdown still drains)", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 20, 12).getTime() });
    await withAgentDir(async () => {
      const h = await harness("rollover");
      const { warnings } = await captureWarnings(async () => {
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await h.handlers.get("message_end")!(usageMessage(), h.ctx);
        await h.I.statsRefreshSettled();
        assert.match(h.statuses.at(-1) ?? "", /1\/1/);
        t.mock.timers.setTime(new Date(2026, 8, 21, 12).getTime());
        const before = h.statuses.length;
        await within(h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx), 1_000, "tool_execution_end");
        await within(h.I.statsRefreshSettled(), 5_000, "the background refresh and its rollover publish");
        // The rollover ran inside the background publish: yesterday's shard is closed now.
        const shards = await h.I.readValidStatsShardsV7();
        assert.equal(shards.length, 2, "yesterday (closed) and today's new shard");
        const yesterday = shards.find((shard: any) => shard.day === "2026-09-20");
        assert.equal(yesterday?.lifecycle.state, "closed");
        assert.equal(yesterday?.models[KEY]?.stats.totalRequests, 1);
        assert.ok(h.statuses.length >= before);
        await within(h.handlers.get("session_shutdown")!({}, h.ctx), 5_000, "session_shutdown");
      });
      assert.deepEqual(warnings, [], "no background refresh failed (a re-entrant request would)");
    });
  });

  test("an epoch read before another process's reset never rolls back the epoch message_end adopted, nor clears its usage", async () => {
    await withAgentDir(async () => {
      let armed = false;
      const hit = deferred();
      const release = deferred();
      const h = await harness("epoch-interleave", {
        hooks: { beforeCommit: async () => { if (!armed) return; armed = false; hit.resolve(); await release.promise; } },
      });
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      await h.handlers.get("message_end")!(usageMessage(), h.ctx);
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /1\/1/);
      const before = await h.I.readGlobalStatsEpoch();

      armed = true;
      await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
      await hit.promise; // that refresh read the old epochs and waits before committing
      const other = await load("epoch-interleave-other");
      await other.advanceGlobalStatsEpoch();
      const after = await h.I.readGlobalStatsEpoch();
      assert.notEqual(after, before);
      await h.handlers.get("message_end")!(usageMessage(), h.ctx); // fresh read: adopts the reset, records under it
      release.resolve();
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /1\/1/, "only the post-reset request, and it is still there");
      await h.handlers.get("session_shutdown")!({}, h.ctx);
      const [own] = await h.I.readValidStatsShardsV7();
      assert.equal(own.globalEpoch, after, "persisted under the newer epoch");
      assert.equal(own.models[KEY]?.stats.totalRequests, 1, "the post-reset usage survived the stale refresh");
    });
  });

  test("message_end's model epoch read, overtaken by a refresh adopting another process's global reset, still labels its usage", async () => {
    await withAgentDir(async () => {
      const h = await harness("epoch-overtaken");
      // The model was reset once (its epoch is not the initial one).
      await h.I.advanceModelStatsEpoch(KEY);
      const modelEpoch = await h.I.readModelStatsEpoch(KEY);
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      const modelPath = h.I.modelEpochPath(KEY);
      const base = h.I.countingStatsReadFs().fs;
      const blocked = deferred();
      const release = deferred();
      let armed = true;
      h.I.setStatsReadFsForTests({
        ...base,
        readFile: async (path: string) => {
          if (armed && path === modelPath) { armed = false; blocked.resolve(); await release.promise; }
          return base.readFile(path);
        },
      });
      try {
        // message_end numbers its epoch reads, then waits on the model epoch file.
        const ended = h.handlers.get("message_end")!(usageMessage(), h.ctx);
        await within(blocked.promise, 2_000, "message_end's model epoch read");
        // Another process resets everything; a refresh started after that read adopts it.
        const other = await load("epoch-overtaken-other");
        await other.advanceGlobalStatsEpoch();
        const globalAfter = await h.I.readGlobalStatsEpoch();
        await h.handlers.get("model_select")!({ model: h.ctx.model }, h.ctx);
        release.resolve();
        await within(Promise.resolve(ended), 2_000, "message_end");
        await h.I.statsRefreshSettled();
        assert.match(h.statuses.at(-1) ?? "", /1\/1/, "the request recorded after the reset is visible");
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        const [own] = await h.I.readValidStatsShardsV7();
        assert.equal(own.globalEpoch, globalAfter);
        assert.equal(own.models[KEY]?.modelEpoch, modelEpoch, "persisted under the model's real epoch, not the initial one (invisible to every reader)");
        assert.equal(own.models[KEY]?.stats.totalRequests, 1);
      } finally {
        h.I.setStatsReadFsForTests(undefined);
      }
    });
  });

  test("print mode: message_end's awaited epoch read retry (EPERM) keeps the process alive until it and the shutdown finish", async () => {
    await withAgentDir(async (dir) => {
      const script = `
        const loaded = await import(${JSON.stringify(join(process.cwd(), "index.ts"))});
        const extension = typeof loaded.default === "function" ? loaded.default : loaded.default.default;
        const I = loaded.__internals_for_tests ?? loaded.default.__internals_for_tests;
        const { writeFileSync, readdirSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const handlers = new Map();
        extension({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
        const context = {
          model: {
            provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
            baseUrl: "https://api.openai.com/v1", compat: {}, reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
          },
          mode: "json", hasUI: false,
          sessionManager: { getSessionId: () => "incremental-print-epoch-retry" },
          modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
          ui: { notify() {}, setStatus() {} },
        };
        await handlers.get("session_start")({ reason: "startup" }, context);
        await I.waitForStatsRestore();
        await I.statsRefreshSettled();
        const base = I.countingStatsReadFs().fs;
        let faults = 0;
        I.setStatsReadFsForTests({ ...base, readFile: async (path) => {
          if (path === I.SHARD_GLOBAL_EPOCH_PATH && faults < 2) { faults++; throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }
          return base.readFile(path);
        } });
        await handlers.get("message_end")({ message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } }, context);
        await handlers.get("session_shutdown")({ reason: "quit" }, context);
        const [name] = readdirSync(I.SHARD_FILES_DIR).filter((file) => file.endsWith(".json"));
        const shard = JSON.parse(readFileSync(join(I.SHARD_FILES_DIR, name), "utf8"));
        writeFileSync(${JSON.stringify(join(dir, "flushed"))}, JSON.stringify({ faults, state: shard.lifecycle.state, requests: shard.models["${KEY}"]?.stats.totalRequests }));
      `;
      const child = spawn(process.execPath, ["--import", "jiti/register", "--input-type=module", "-e", script], {
        cwd: process.cwd(), stdio: "ignore", env: { ...process.env, PI_CODING_AGENT_DIR: dir },
      });
      const exit = await new Promise<number | null | "killed">((resolve) => {
        const kill = setTimeout(() => { child.kill("SIGKILL"); resolve("killed"); }, 30_000);
        child.on("exit", (code) => { clearTimeout(kill); resolve(code); });
      });
      const flushed = await readFile(join(dir, "flushed"), "utf8").then((text) => JSON.parse(text), () => undefined);
      assert.deepEqual(flushed, { faults: 2, state: "closed", requests: 1 }, "message_end finished its retried read and session_shutdown flushed");
      assert.equal(exit, 0, "no unsettled top-level await (exit 13)");
    });
  });

  test("a transient epoch read error is not 'no reset': nothing adopts the initial epoch or drops usage", async () => {
    await withAgentDir(async () => {
      const h = await harness("epoch-eperm");
      await h.I.advanceGlobalStatsEpoch();
      const epoch = await h.I.readGlobalStatsEpoch();
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      await h.handlers.get("message_end")!(usageMessage(), h.ctx);
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /1\/1/);

      const base = h.I.countingStatsReadFs().fs;
      let faults = 0;
      h.I.setStatsReadFsForTests({
        ...base,
        readFile: async (path: string) => {
          if (path === h.I.SHARD_GLOBAL_EPOCH_PATH) { faults++; throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" }); }
          return base.readFile(path);
        },
      });
      const { warnings } = await captureWarnings(async () => {
        await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
        await h.I.statsRefreshSettled();
        await h.handlers.get("message_end")!(usageMessage(), h.ctx);
        await h.I.statsRefreshSettled();
      });
      h.I.setStatsReadFsForTests(undefined);
      assert.ok(faults >= 3, "the reads were retried and still failed");
      assert.equal(warnings.length, 1, "the failed background refresh is reported once");
      await h.handlers.get("tool_execution_end")!({ toolCallId: "t2" }, h.ctx);
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /2\/2/);
      await h.handlers.get("session_shutdown")!({}, h.ctx);
      const [own] = await h.I.readValidStatsShardsV7();
      assert.equal(own.globalEpoch, epoch);
      assert.equal(own.models[KEY]?.stats.totalRequests, 2);

      // The reader itself: only ENOENT (and an invalid record) is the fallback.
      h.I.setStatsReadFsForTests({ ...base, readFile: async () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); } });
      try {
        const result = await h.I.readEpochFileResult(h.I.SHARD_GLOBAL_EPOCH_PATH, "fallback");
        assert.equal(result.ok, false);
        await assert.rejects(h.I.readGlobalStatsEpoch(), /EBUSY/);
      } finally {
        h.I.setStatsReadFsForTests(undefined);
      }
      assert.deepEqual(await h.I.readEpochFileResult(join(h.I.SHARD_STATE_DIR, "missing.json"), "fallback"), { ok: true, epoch: "fallback" });
    });
  });

  test("no unhandled rejection: a stale ctx (after reload) in every background publish is caught and warned once", async () => {
    await withAgentDir(async () => {
      let stale = false;
      const h = await harness("unhandled", {
        ctx: (statuses) => {
          const base = makeContext("incremental-unhandled", statuses);
          return {
            ...base,
            get sessionManager() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return base.sessionManager; },
            get model() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return base.model; },
          };
        },
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        const { warnings } = await captureWarnings(async () => {
          await h.handlers.get("message_end")!(usageMessage(), h.ctx);
          stale = true;
          await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
          await h.handlers.get("agent_settled")!({}, h.ctx);
          await h.I.statsRefreshSettled();
          await sleep(20);
        });
        assert.deepEqual(unhandled, []);
        assert.equal(warnings.length, 1, "warned once");
        assert.match(String(warnings[0]?.[0]), /background footer stats refresh failed/);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      stale = false;
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });
  });

  test("usage recorded while a refresh is in flight is in that refresh's commit (the footer never goes back)", async () => {
    await withAgentDir(async () => {
      let armed = false;
      const hit = deferred();
      const release = deferred();
      const committed: Array<number | undefined> = [];
      const h = await harness("commit-interleave", {
        hooks: {
          beforeCommit: async () => { if (!armed) return; armed = false; hit.resolve(); await release.promise; },
          afterCommit: (aggregate: any) => { committed.push(aggregate.totalsByModel[KEY]?.totalRequests); },
        },
      });
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      await h.handlers.get("message_end")!(usageMessage(), h.ctx);
      await h.I.statsRefreshSettled();
      committed.length = 0;
      armed = true;
      await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
      await hit.promise;
      await h.handlers.get("message_end")!(usageMessage(), h.ctx);
      release.resolve();
      await h.I.statsRefreshSettled();
      assert.deepEqual(committed, [2, 2], "the paused refresh commits the request recorded while it waited");
      const counts = h.statuses.map(requestsOf).filter((value): value is number => value !== undefined);
      assert.deepEqual(counts, [...counts].sort((a, b) => a - b), `footer request counts never decrease: ${counts}`);
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });
  });

  test("lifecycle handlers return before the refresh; session_shutdown drains it, and model_select still awaits one", async () => {
    await withAgentDir(async () => {
      let armed = false;
      const release = deferred();
      const h = await harness("non-blocking", { hooks: { beforeEpochRead: async () => { if (armed) await release.promise; } } });
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      armed = true;
      await within(h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx), 2_000, "tool_execution_end");
      await within(h.handlers.get("agent_settled")!({}, h.ctx), 2_000, "agent_settled");
      await within(h.handlers.get("message_end")!(usageMessage(), h.ctx), 2_000, "message_end");
      const shutdown = h.handlers.get("session_shutdown")!({}, h.ctx);
      let done = false;
      void shutdown.then(() => { done = true; });
      await sleep(50);
      assert.equal(done, false, "session_shutdown waits for the refresh in flight");
      armed = false;
      release.resolve();
      await within(shutdown, 5_000, "session_shutdown");
      const [own] = await h.I.readValidStatsShardsV7();
      assert.equal(own.lifecycle.state, "closed");
      assert.equal(own.models[KEY]?.stats.totalRequests, 1);
    });
  });
});

describe("shutdown drain", () => {
  test("session_shutdown waits for a background full scan in flight before it flushes", async () => {
    await withAgentDir(async () => {
      const h = await harness("drain-scan", { hooks: { fullScanIntervalMs: 0 } });
      const now = Date.now();
      const cold = await writeShard(h.I, { session: "other", updatedAt: now - 3 * HOUR, requests: 1 });
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      await h.I.statsRefreshSettled();
      const base = h.I.countingStatsReadFs().fs;
      const release = deferred();
      const started = deferred();
      let armed = true;
      h.I.setStatsReadFsForTests({
        ...base,
        lstat: async (path: string) => {
          if (armed && path.endsWith(`${cold}.json`)) { armed = false; started.resolve(); await release.promise; }
          return base.lstat(path);
        },
      });
      try {
        await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
        await within(started.promise, 2_000, "the background full scan reaching the cold shard");
        let done = false;
        const shutdown = h.handlers.get("session_shutdown")!({}, h.ctx).then(() => { done = true; });
        await sleep(100);
        assert.equal(done, false, "the shutdown drains the scan in flight");
        release.resolve();
        await within(shutdown, 5_000, "session_shutdown");
      } finally {
        h.I.setStatsReadFsForTests(undefined);
      }
    });
  });
});

describe("shutdown gate and the TUI watcher", () => {
  function fakeWatch() {
    const state = { created: 0, closed: 0, onName: undefined as undefined | ((name: string | null) => void), onError: undefined as undefined | ((error: unknown) => void) };
    const factory = (_directory: string, onName: (name: string | null) => void, onError: (error: unknown) => void) => {
      state.created++;
      state.onName = onName;
      state.onError = onError;
      return { close() { state.closed++; } };
    };
    return { state, factory };
  }

  test("after shutdown no watcher event or timer refreshes, publishes or writes an active shard; session_start reopens", async () => {
    await withEnv({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, async () => {
      await withAgentDir(async () => {
        const watch = fakeWatch();
        const h = await harness("gate", { mode: "tui", hooks: { watch: watch.factory } });
        assert.equal(watch.state.created, 0, "not created on session_start's synchronous path");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        assert.equal(watch.state.created, 1, "created after the background restore (TUI)");
        await h.handlers.get("message_end")!(usageMessage(), h.ctx);
        await h.I.statsRefreshSettled();
        assert.match(h.statuses.at(-1) ?? "", /1\/1/);

        // Another process's write, reported by the watcher: the footer follows within the debounce.
        const other = await writeShard(h.I, { session: "other", state: "active", updatedAt: Date.now(), requests: 2 });
        watch.state.onName!(`${other}.json`);
        await sleep(400);
        await h.I.statsRefreshSettled();
        assert.match(h.statuses.at(-1) ?? "", /3\/3/);

        await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
        const statusesAtShutdown = h.statuses.length;
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        assert.equal(h.statuses.length, statusesAtShutdown, "nothing published once shutdown began");
        assert.equal(watch.state.closed, 1, "the watcher is closed at shutdown");
        await writeShard(h.I, { id: other, session: "other", state: "active", updatedAt: Date.now(), requests: 5 });
        watch.state.onName!(`${other}.json`);
        watch.state.onName!(null);
        await h.handlers.get("tool_execution_end")!({ toolCallId: "t2" }, h.ctx);
        await sleep(400);
        await h.I.statsRefreshSettled();
        assert.equal(h.statuses.length, statusesAtShutdown, "no refresh or publish after shutdown");
        const own = (await h.I.readValidStatsShardsV7()).filter((shard: any) => shard.instanceId !== other);
        assert.equal(own.length, 1);
        assert.equal(own[0].lifecycle.state, "closed", "no active shard written after shutdown");

        // The same instance starts the next session (switch/new/fork reuse it).
        await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
        await h.I.waitForStatsRestore();
        assert.equal(watch.state.created, 2, "reopened: watcher recreated");
        await h.handlers.get("tool_execution_end")!({ toolCallId: "t3" }, h.ctx);
        await h.I.statsRefreshSettled();
        assert.ok(h.statuses.length > statusesAtShutdown, "background refreshes publish again");
        await h.handlers.get("session_shutdown")!({}, h.ctx);
      });
    });
  });

  test("an own shard absorbed during the shutdown flush is continued as a closed shard, never an active one", async () => {
    await withAgentDir(async () => {
      const h = await harness("adopt-closed");
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      await h.handlers.get("message_end")!(usageMessage(), h.ctx);
      await h.I.statsRefreshSettled();
      let absorbed = false;
      h.I.setStatsFsTestHooks({
        beforeRename: async (from: string, to: string) => {
          if (!to.startsWith(h.I.SHARD_FILES_DIR) || !to.endsWith(".json")) return;
          if (absorbed) { await sleep(150); return; } // a slow write of the continued shard
          const shard = JSON.parse(await readFile(from, "utf8"));
          if (shard.lifecycle.state !== "closed") return;
          // Another process compacts the flush's closed shard right as it lands.
          absorbed = true;
          const at = shard.lifecycle.updatedAt + DAY + HOUR;
          const doc = await archiveDoc(h.I, shard.sessionHash, 1, { [shard.instanceId]: at }, shard.lifecycle.updatedAt);
          await writeGeneration(h.I, 1, doc);
        },
      });
      try {
        await h.handlers.get("session_shutdown")!({}, h.ctx);
      } finally {
        h.I.setStatsFsTestHooks(undefined);
      }
      assert.equal(absorbed, true);
      const shards = await h.I.readValidStatsShardsV7();
      assert.equal(shards.length, 2, "the absorbed shard and its continuation, written before the shutdown returned");
      for (const shard of shards) assert.equal(shard.lifecycle.state, "closed", `shard ${shard.instanceId} is not left active after shutdown`);
    });
  });

  test("a watcher 'error' does not crash: the handle is closed, its later events are ignored (fake watcher)", async () => {
    await withAgentDir(async () => {
      const watch = fakeWatch();
      const h = await harness("watch-error", { mode: "tui", hooks: { watch: watch.factory } });
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      assert.equal(watch.state.created, 1);
      assert.doesNotThrow(() => watch.state.onError!(Object.assign(new Error("EPERM: watched directory deleted"), { code: "EPERM" })));
      assert.equal(watch.state.closed, 1, "closed on error (a held handle keeps a deleted directory pending on Windows)");
      const before = h.statuses.length;
      watch.state.onName!("whatever.json");
      await sleep(350);
      assert.equal(h.statuses.length, before, "a closed watcher's late events are ignored");
      await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
      await h.I.statsRefreshSettled();
      assert.equal(watch.state.created, 1, "not recreated at once (only once the directory lists again, rate-limited)");
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });
  });

  test("the real fs.watch wrapper has an 'error' listener, and deleting the watched directory does not crash (Linux)", async () => {
    await withAgentDir(async (dir) => {
      const I = await load("watch-real");
      const watched = join(dir, "watched");
      await mkdir(watched);
      const errors: unknown[] = [];
      const names: Array<string | null> = [];
      const watcher = I.createFsShardWatch(watched, (name: string | null) => names.push(name), (error: unknown) => errors.push(error)) as any;
      try {
        assert.doesNotThrow(() => watcher.emit("error", Object.assign(new Error("EPERM"), { code: "EPERM" })));
        assert.equal(errors.length, 1);
      } finally {
        watcher.close();
      }

      // The extension with the real watcher: remove the whole shard directory under it.
      const h = await harness("watch-real-ext", { mode: "tui" });
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      await rm(h.I.SHARD_FILES_DIR, { recursive: true, force: true });
      await sleep(300);
      await h.handlers.get("message_end")!(usageMessage(), h.ctx);
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /1\/1/);
      await h.handlers.get("session_shutdown")!({}, h.ctx);
      const [own] = await h.I.readValidStatsShardsV7();
      assert.equal(own.models[KEY]?.stats.totalRequests, 1);
    });
  });
});

describe("archive pairing in the incremental path", () => {
  test("2.9.0 rewrites archive.json in place and deletes the shard it absorbed: no undercount at generation 0", async () => {
    await withAgentDir(async () => {
      const h = await harness("legacy-inplace");
      await suppressMaintenance(h.I);
      const now = Date.now();
      const raw = await writeShard(h.I, { session: h.sessionHash, updatedAt: now - 3 * DAY, requests: 1 });
      await mkdir(join(h.I.SHARD_ARCHIVE_PATH, ".."), { recursive: true });
      await writeFile(h.I.SHARD_ARCHIVE_PATH, JSON.stringify(await archiveDoc(h.I, h.sessionHash, 4, {}, now - 5 * DAY)) + "\n");
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      assert.match(h.statuses.at(-1) ?? "", /5\/5/);
      for (let round = 0; round < 2; round++) {
        await h.handlers.get("tool_execution_end")!({ toolCallId: `w${round}` }, h.ctx);
        await h.I.statsRefreshSettled();
      }
      // 2.9.0 compacts: archive.json rewritten in place (same inode), then the raw shard deleted.
      await writeFile(h.I.SHARD_ARCHIVE_PATH, JSON.stringify(await archiveDoc(h.I, h.sessionHash, 5, { [raw]: now }, now - 3 * DAY)) + "\n");
      await unlink(join(h.I.SHARD_FILES_DIR, `${raw}.json`));
      await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /5\/5/, "archive.json is re-checked on every refresh while no generation exists");
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });
  });

  test("a pending (in-place, incomplete) newest generation is switched to once complete: no undercount", async () => {
    await withAgentDir(async () => {
      const h = await harness("pending");
      await suppressMaintenance(h.I);
      const now = Date.now();
      const raw = await writeShard(h.I, { session: h.sessionHash, updatedAt: now - 3 * DAY, requests: 1 });
      await writeGeneration(h.I, 1, await archiveDoc(h.I, h.sessionHash, 4, {}, now - 5 * DAY));
      const pendingPath = h.I.statsArchiveGenerationPath(h.I.SHARD_ARCHIVE_PATH, 2);
      await writeFile(pendingPath, '{"version":2,"kind":"pi-cache-optimizer-archive","generation":2,'); // still being written
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      assert.match(h.statuses.at(-1) ?? "", /5\/5/);
      for (let round = 0; round < 2; round++) {
        await h.handlers.get("tool_execution_end")!({ toolCallId: `w${round}` }, h.ctx);
        await h.I.statsRefreshSettled();
        assert.match(h.statuses.at(-1) ?? "", /5\/5/);
      }
      // The writer completes generation 2 in place (absorbing the raw shard), then deletes it.
      await writeFile(pendingPath, JSON.stringify(h.I.encodeStatsArchiveV2(await archiveDoc(h.I, h.sessionHash, 5, { [raw]: now }, now - 3 * DAY), 2)) + "\n");
      await unlink(join(h.I.SHARD_FILES_DIR, `${raw}.json`));
      await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /5\/5/, "the completed generation replaces the one below it");
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });
  });

  test("a corrupt newest generation: the view below it is used, and a newer publish above it is picked up", async () => {
    await withAgentDir(async () => {
      const h = await harness("corrupt");
      await suppressMaintenance(h.I);
      const now = Date.now();
      const raw = await writeShard(h.I, { session: h.sessionHash, updatedAt: now - 3 * DAY, requests: 1 });
      await writeGeneration(h.I, 1, await archiveDoc(h.I, h.sessionHash, 4, {}, now - 5 * DAY));
      const corruptPath = h.I.statsArchiveGenerationPath(h.I.SHARD_ARCHIVE_PATH, 2);
      await writeFile(corruptPath, "{damaged");
      await utimes(corruptPath, new Date(now - 2 * HOUR), new Date(now - 2 * HOUR));
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      assert.match(h.statuses.at(-1) ?? "", /5\/5/);
      const counting = h.I.countingStatsReadFs();
      h.I.setStatsReadFsForTests(counting.fs);
      await h.handlers.get("tool_execution_end")!({ toolCallId: "w" }, h.ctx);
      await h.I.statsRefreshSettled();
      h.I.setStatsReadFsForTests(undefined);
      assert.ok(counting.counts.paths.includes(`lstat ${corruptPath}`), "the corrupt newest generation is stat-ed on every refresh");
      await writeGeneration(h.I, 3, await archiveDoc(h.I, h.sessionHash, 5, { [raw]: now }, now - 3 * DAY));
      await unlink(join(h.I.SHARD_FILES_DIR, `${raw}.json`));
      await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /5\/5/);
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });
  });

  test("a generation number re-used after the archive directory was recreated is re-checked (full refresh, and every scan interval)", async () => {
    for (const via of ["interval", "full"] as const) {
      await withAgentDir(async () => {
        const h = await harness(`regen-${via}`, { hooks: via === "interval" ? { fullScanIntervalMs: 0 } : {} });
        await suppressMaintenance(h.I);
        const now = Date.now();
        await writeGeneration(h.I, 1, await archiveDoc(h.I, h.sessionHash, 4, {}, now - 5 * DAY));
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        assert.match(h.statuses.at(-1) ?? "", /4\/4/);
        await h.handlers.get("tool_execution_end")!({ toolCallId: "w" }, h.ctx);
        await h.I.statsRefreshSettled();
        assert.match(h.statuses.at(-1) ?? "", /4\/4/);
        // The user deletes the archive; another process compacts from scratch: a different generation 1.
        await rm(join(h.I.SHARD_ARCHIVE_PATH, ".."), { recursive: true, force: true });
        await writeGeneration(h.I, 1, await archiveDoc(h.I, h.sessionHash, 7, {}, now - 4 * DAY));
        if (via === "interval") {
          await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
          await h.I.statsRefreshSettled();
        } else {
          await h.handlers.get("session_shutdown")!({}, h.ctx); // the flush refreshes in full
          await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
          await h.I.waitForStatsRestore();
        }
        assert.match(h.statuses.at(-1) ?? "", /7\/7/, "the new generation 1 replaces the deleted one, not the cached view");
        await h.handlers.get("session_shutdown")!({}, h.ctx);
      });
    }
  });

  test("every shard-phase read completes before the archive is listed (a compaction landing in between never undercounts)", async () => {
    await withAgentDir(async () => {
      const h = await harness("order");
      const now = Date.now();
      await writeShard(h.I, { session: "older", updatedAt: now - 6 * DAY, requests: 1 });
      await h.I.compactStatsShardsV7(now); // generation 1
      await suppressMaintenance(h.I);
      await writeShard(h.I, { session: h.sessionHash, updatedAt: now - 3 * DAY, requests: 2 });
      await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await h.I.waitForStatsRestore();
      assert.match(h.statuses.at(-1) ?? "", /2\/2/);

      // Call order through the read facade: the archive listing comes after every shard read.
      const counting = h.I.countingStatsReadFs();
      h.I.setStatsReadFsForTests(counting.fs);
      await h.handlers.get("model_select")!({ model: h.ctx.model }, h.ctx);
      h.I.setStatsReadFsForTests(undefined);
      const archiveDir = join(h.I.SHARD_ARCHIVE_PATH, "..");
      const firstArchive = counting.counts.paths.findIndex((path: string) => path.includes(archiveDir));
      const lastShard = counting.counts.paths.findLastIndex((path: string) => path.includes(h.I.SHARD_FILES_DIR));
      assert.ok(firstArchive > lastShard, counting.counts.paths.join("\n"));

      // Another process compacts right after this refresh lists the archive:
      // it publishes generation 2 (absorbing the raw shard) and deletes it.
      const other = await load("order-other");
      let compacted = false;
      h.I.setStatsArchiveTestHooks({
        afterList: async () => {
          if (compacted) return;
          compacted = true;
          const result = await other.compactStatsShardsV7(Date.now());
          assert.equal(result.generation, 2);
        },
      });
      try {
        await h.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, h.ctx);
        await h.I.statsRefreshSettled();
      } finally {
        h.I.setStatsArchiveTestHooks(undefined);
      }
      assert.equal(compacted, true);
      assert.match(h.statuses.at(-1) ?? "", /2\/2/, "raw shard read before the listing pairs with the archive listed after it");
      await h.handlers.get("tool_execution_end")!({ toolCallId: "t2" }, h.ctx);
      await h.I.statsRefreshSettled();
      assert.match(h.statuses.at(-1) ?? "", /2\/2/, "and with the new generation afterwards");
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });
  });

  test("steady-state refresh: readdir x2, lstat = hot set, readFile = epochs only; the kill switch stats every shard", async () => {
    for (const incremental of [true, false]) {
      await withEnv({ PI_CACHE_OPTIMIZER_STATS_INCREMENTAL: incremental ? undefined : "0" }, async () => {
        await withAgentDir(async () => {
          const h = await harness(`counts-${incremental}`);
          const now = Date.now();
          for (let i = 0; i < 10; i++) await writeShard(h.I, { session: "old", updatedAt: now - 5 * DAY, requests: 1 });
          await h.I.compactStatsShardsV7(now); // generation 1 holds them
          await suppressMaintenance(h.I);
          for (let i = 0; i < 20; i++) await writeShard(h.I, { session: `s${i % 4}`, updatedAt: now - 2 * HOUR, requests: 1 });
          for (let i = 0; i < 2; i++) await writeShard(h.I, { session: "live", state: "active", updatedAt: now - HOUR, requests: 1 });
          await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
          await h.I.waitForStatsRestore();
          await h.handlers.get("model_select")!({ model: h.ctx.model }, h.ctx);
          const counting = h.I.countingStatsReadFs();
          let shardStats = 0;
          h.I.setStatsFsTestHooks({ shardStat: (_path: string, info: any) => { shardStats++; return info; } });
          h.I.setStatsReadFsForTests(counting.fs);
          try {
            await h.handlers.get("model_select")!({ model: h.ctx.model }, h.ctx);
          } finally {
            h.I.setStatsReadFsForTests(undefined);
            h.I.setStatsFsTestHooks(undefined);
          }
          if (incremental) {
            assert.deepEqual({ readdir: counting.counts.readdir, lstat: counting.counts.lstat, stat: counting.counts.stat, readFile: counting.counts.readFile },
              { readdir: 2, lstat: 2, stat: 0, readFile: 2 }, counting.counts.paths.join("\n"));
            assert.equal(shardStats, 2);
          } else {
            assert.equal(shardStats, 23, "kill switch: every shard file (including the own one) is stat-ed, as in 2.9.3");
          }
          assert.equal(h.I.isStatsIncrementalEnabled(), incremental);
          await h.handlers.get("session_shutdown")!({}, h.ctx);
        });
      });
    }
  });
});

describe("kill switch and timing log", () => {
  test("kill switch: config subcommand and env; timing log is opt-in", async () => {
    const I = await load("switch");
    assert.equal(I.isStatsIncrementalEnabled({}, {}), true);
    for (const off of ["0", "false", "no", "off"]) assert.equal(I.isStatsIncrementalEnabled({ [I.STATS_INCREMENTAL_ENV]: off }, {}), false, off);
    assert.equal(I.isStatsIncrementalEnabled({ [I.STATS_INCREMENTAL_ENV]: "1" }, {}), true);
    // Persisted setting (/cache-optimizer config stats-incremental on|off) wins over the env, like every feature.
    assert.equal(I.isStatsIncrementalEnabled({}, { version: 3, features: { statsIncremental: false } }), false);
    assert.equal(I.isStatsIncrementalEnabled({ [I.STATS_INCREMENTAL_ENV]: "0" }, { version: 3, features: { statsIncremental: true } }), true);
    assert.deepEqual(I.parsePersistedCacheOptimizerConfig({ version: 3, features: { statsIncremental: false } })?.features, { statsIncremental: false });
    assert.equal(I.getCacheOptimizerArgumentCompletions("config ").some((item: { label: string }) => item.label === "stats-incremental"), true);
    assert.equal(I.statsTimingLogPath({}), undefined);
    assert.equal(I.statsTimingLogPath({ [I.STATS_TIMING_ENV]: "0" }), undefined);
    assert.match(I.statsTimingLogPath({ [I.STATS_TIMING_ENV]: "1" }), /pi-cache-optimizer-stats-timing\.jsonl$/);
    assert.equal(I.statsTimingLogPath({ [I.STATS_TIMING_ENV]: "/tmp/x.jsonl" }), "/tmp/x.jsonl");

    await withAgentDir(async (dir) => {
      const path = join(dir, "timing.jsonl");
      await withEnv({ [I.STATS_TIMING_ENV]: path }, async () => {
        const h = await harness("timing");
        await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
        await h.I.waitForStatsRestore();
        await h.handlers.get("model_select")!({ model: h.ctx.model }, h.ctx);
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        // The log is appended in the background (never awaited by a handler).
        let text = "";
        for (let attempt = 0; attempt < 200 && text.trim().split("\n").length < 2; attempt++) {
          text = await readFile(path, "utf8").catch(() => "");
          if (text.trim().split("\n").length < 2) await sleep(10);
        }
        const lines = text.trim().split("\n").map((line) => JSON.parse(line));
        assert.ok(lines.length >= 2);
        const tiered = lines.find((line: any) => line.full === false);
        assert.equal(tiered.incremental, true);
        assert.equal(typeof tiered.totalMs, "number");
        assert.equal(typeof tiered.index.statted, "number");
      });
    });
  });

  test("session_shutdown releases statsRefreshSettledForTests and latestStatsCtx for GC", async () => {
    await withAgentDir(async (dir) => {
      const out = join(dir, "gc.json");
      const script = `
        const m = await import(${JSON.stringify(join(process.cwd(), "index.ts"))});
        const ext = typeof m.default === "function" ? m.default : m.default.default;
        const I = m.__internals_for_tests ?? m.default.__internals_for_tests;
        const { writeFileSync } = await import("node:fs");
        const refs = [];
        for (let i = 0; i < 3; i++) {
          let h = new Map();
          let pi = { on(n, f) { h.set(n, f); }, registerCommand() {} };
          ext(pi);
          let ctx = { mode: "json", hasUI: false, sessionManager: { getSessionId: () => "s-" + i }, ui: { notify() {}, setStatus() {} } };
          refs.push([new WeakRef(ctx), new WeakRef(pi)]);
          for (const reason of i === 2 ? ["startup", "new"] : ["startup"]) {
            await h.get("session_start")({ reason }, ctx);
            await I.waitForStatsRestore();
            await h.get("session_shutdown")({ reason: "quit" }, ctx);
          }
          h = pi = ctx = null;
        }
        for (let r = 0; r < 6; r++) { global.gc(); await new Promise((r) => setTimeout(r, 20)); }
        writeFileSync(${JSON.stringify(out)}, JSON.stringify(refs.map(([c, p]) => [c.deref() !== undefined, p.deref() !== undefined])));
      `;
      const child = spawn(process.execPath, ["--expose-gc", "--import", "jiti/register", "--input-type=module", "-e", script], {
        cwd: process.cwd(), stdio: "ignore", env: { ...process.env, PI_CODING_AGENT_DIR: dir },
      });
      const code = await new Promise<number | null | "killed">((resolve) => {
        const kill = setTimeout(() => { child.kill("SIGKILL"); resolve("killed"); }, 30_000);
        child.on("exit", (c) => { clearTimeout(kill); resolve(c); });
      });
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(await readFile(out, "utf8")), [[false, false], [false, false], [false, false]]);
    });
  });
});
