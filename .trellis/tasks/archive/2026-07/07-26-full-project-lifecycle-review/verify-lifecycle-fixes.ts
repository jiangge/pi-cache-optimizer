#!/usr/bin/env bun
/** Regression coverage for extension teardown, retention baseline, and persistence ordering. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-lifecycle-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;
process.env.PI_CACHE_RETENTION = "custom-before-extension";

const loadedExtension = await import("#extension");
const extensionModule = "__internals_for_tests" in loadedExtension ? loadedExtension : loadedExtension.default;
const { default: extension, __internals_for_tests: I } = extensionModule;

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

check("extension requests long retention on load", process.env.PI_CACHE_RETENTION === "long");

const fakeEnv: Record<string, string | undefined> = { PI_CACHE_RETENTION: "custom-baseline" };
const fakeGlobals = {} as Record<symbol, unknown>;
const firstBaseline = I.getOrCaptureCacheRetentionBaseline(fakeEnv, fakeGlobals);
fakeEnv.PI_CACHE_RETENTION = "long";
const reloadBaseline = I.getOrCaptureCacheRetentionBaseline(fakeEnv, fakeGlobals);
check(
  "retention baseline survives module-style recapture",
  firstBaseline.wasSet === true && firstBaseline.value === "custom-baseline" &&
    reloadBaseline.wasSet === true && reloadBaseline.value === "custom-baseline",
  JSON.stringify({ firstBaseline, reloadBaseline }),
);

const order: string[] = [];
let releaseFirst!: () => void;
const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
const runSerialized = I.createSerializedAsyncRunner();
const firstRun = runSerialized(async () => {
  order.push("first:start");
  await firstGate;
  order.push("first:end");
});
const secondRun = runSerialized(async () => {
  order.push("second:start");
  order.push("second:end");
});
await Bun.sleep(10);
check("serialized runner does not start a newer write early", order.join(",") === "first:start", order.join(","));
releaseFirst();
await Promise.all([firstRun, secondRun]);
check(
  "serialized runner preserves write invocation order",
  order.join(",") === "first:start,first:end,second:start,second:end",
  order.join(","),
);

// A rejection must not poison the queue.
const recoveryOrder: string[] = [];
const rejected = runSerialized(async () => {
  recoveryOrder.push("reject");
  throw new Error("expected test rejection");
}).catch(() => undefined);
const recovered = runSerialized(async () => {
  recoveryOrder.push("recover");
});
await Promise.all([rejected, recovered]);
check("serialized runner continues after a failed write", recoveryOrder.join(",") === "reject,recover");

type Handler = (event: any, ctx: any) => unknown;
type Command = { handler: (args: string, ctx: any) => unknown };
const handlers = new Map<string, Handler>();
const commands = new Map<string, Command>();
const mockPi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand(name: string, command: Command) {
    commands.set(name, command);
  },
};
extension(mockPi as any);

check("extension registers session_shutdown", typeof handlers.get("session_shutdown") === "function");
check("extension registers message_end", typeof handlers.get("message_end") === "function");
check("extension registers command", commands.has("cache-optimizer"));

const model = {
  provider: "kimi-coding",
  id: "k3",
  name: "Kimi K3",
  api: "anthropic-messages",
  baseUrl: "https://api.kimi.com/coding",
  compat: { forceAdaptiveThinking: true, allowEmptySignature: true },
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_144,
  maxTokens: 32_768,
};
const sessionId = "lifecycle-shutdown-session";
const ctx = {
  model,
  modelRegistry: {
    find: () => undefined,
    getAvailable: () => [],
    getAll: () => [],
  },
  sessionManager: { getSessionId: () => sessionId },
  ui: {
    notify: () => undefined,
    setStatus: () => undefined,
    confirm: async () => false,
    select: async () => undefined,
  },
  hasUI: true,
};

await handlers.get("before_agent_start")?.({
  systemPrompt: "Stable project instructions.\n\nDynamic turn context.",
  systemPromptOptions: {},
}, ctx);
const hintsSymbol = Symbol.for("pi.cache.hints.v1");
const globals = globalThis as typeof globalThis & Record<symbol, any> & {
  __piCacheOptimizerCacheKey__?: unknown;
};
check("cache hints service is installed before shutdown", typeof globals[hintsSymbol]?.getHints === "function");
check("legacy cache key is populated before shutdown", globals.__piCacheOptimizerCacheKey__ === sessionId);

await handlers.get("message_end")?.({
  message: {
    role: "assistant",
    provider: "kimi-coding",
    api: "anthropic-messages",
    model: "k3",
    stopReason: "stop",
    usage: { input: 11, cacheRead: 89, cacheWrite: 0 },
  },
}, ctx);

// Do not wait for the 2-second debounce. Shutdown must cancel it and flush now.
await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);

const persisted = JSON.parse(
  await readFile(join(tempAgentDir, "pi-cache-optimizer-stats.json"), "utf8"),
);
const sessionHash = I.hashSessionId(sessionId);
check(
  "shutdown flushes pending totals immediately",
  persisted.totalsByModel?.["kimi-coding/k3"]?.totalRequests === 1 &&
    persisted.totalsByModel?.["kimi-coding/k3"]?.hitRequests === 1 &&
    persisted.totalsByModel?.["kimi-coding/k3"]?.cachedInputTokens === 89,
  JSON.stringify(persisted.totalsByModel),
);
check(
  "shutdown flushes pending session bucket immediately",
  persisted.sessions?.[sessionHash]?.["kimi-coding/k3"]?.totalRequests === 1,
  JSON.stringify(persisted.sessions),
);
check("shutdown removes owned cache hints service", globals[hintsSymbol] === undefined);
check("shutdown clears legacy cache key", globals.__piCacheOptimizerCacheKey__ === undefined);
check(
  "shutdown restores the process-original retention value",
  process.env.PI_CACHE_RETENTION === "custom-before-extension",
  process.env.PI_CACHE_RETENTION,
);

await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
check("enabled session replacement requests long retention again", process.env.PI_CACHE_RETENTION === "long");
await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
check("repeated shutdown restores the original retention value", process.env.PI_CACHE_RETENTION === "custom-before-extension");

// Uninstall must never delete a newer service installed by another owner.
const oldService = { version: 1, getHints: () => ({ promptCacheKey: "old" }) };
const uninstallOld = I.installCacheHintsService(oldService);
const replacementService = { version: 1, getHints: () => ({ promptCacheKey: "replacement" }) };
globals[hintsSymbol] = replacementService;
uninstallOld();
check("cache-hints uninstall preserves a newer owner", globals[hintsSymbol] === replacementService);
delete globals[hintsSymbol];

const externalService = { version: 1, getHints: () => ({ promptCacheKey: "external" }) };
globals[hintsSymbol] = externalService;
const ownedService = I.markOptimizerOwnedCacheHintsService({
  version: 1,
  getHints: () => ({ promptCacheKey: "owned" }),
});
const uninstallOwned = I.installCacheHintsService(ownedService, {
  discardPrevious: I.isOptimizerOwnedCacheHintsService,
});
uninstallOwned();
check("optimizer shutdown restores a previous external hints service", globals[hintsSymbol] === externalService);
delete globals[hintsSymbol];

await rm(tempAgentDir, { recursive: true, force: true });

console.log(`\nPassed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) process.exit(1);
