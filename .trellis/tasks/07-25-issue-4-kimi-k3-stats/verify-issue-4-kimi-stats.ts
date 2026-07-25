#!/usr/bin/env bun
/** Regression coverage for GitHub issue #4 (kimi-coding/k3 stats stuck at 0/0). */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-issue-4-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const moduleUrl = new URL(`../../../index.ts?issue4=${Date.now()}`, import.meta.url).href;
const { default: extension, __internals_for_tests: I } = await import(moduleUrl);

const {
  modelFromAssistantMessage,
  selectAdapterForAssistantMessage,
  isKimiLikeAssistantMessage,
  hashSessionId,
} = I;

type Handler = (event: any, ctx: any) => unknown;
type Command = { handler: (args: string, ctx: any) => unknown };

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`❌ FAIL  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

const activeModel = {
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
} as any;

const assistantMessage = {
  role: "assistant",
  provider: "kimi-coding",
  api: "anthropic-messages",
  model: "k3",
  content: [{ type: "text", text: "done" }],
  stopReason: "stop",
  usage: {
    input: 499,
    output: 100,
    cacheRead: 159_488,
    cacheWrite: 0,
    totalTokens: 160_087,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: Date.now(),
};

const oldResponseShape = { ...activeModel, id: "k3", name: "k3" };
check(
  "issue reproduces when response-derived model loses display name",
  !isKimiLikeAssistantMessage(assistantMessage, oldResponseShape),
);

const directResponseModel = modelFromAssistantMessage(assistantMessage, activeModel);
check(
  "same direct provider/id preserves fallback display name",
  directResponseModel?.name === "Kimi K3",
  JSON.stringify(directResponseModel),
);
check(
  "assistant-message adapter selects Kimi cache",
  selectAdapterForAssistantMessage(assistantMessage, activeModel)?.label === "Kimi cache",
  selectAdapterForAssistantMessage(assistantMessage, activeModel)?.label,
);

const driftedIdModel = modelFromAssistantMessage(
  { ...assistantMessage, model: "upstream-k3" },
  activeModel,
);
check(
  "different response id does not inherit fallback display name",
  driftedIdModel?.name === "upstream-k3",
  JSON.stringify(driftedIdModel),
);
check(
  "different response id cannot select Kimi from stale fallback name",
  selectAdapterForAssistantMessage({ ...assistantMessage, model: "upstream-k3" }, activeModel) === undefined,
);

const routedProviderModel = modelFromAssistantMessage(
  { ...assistantMessage, provider: "moonshotai" },
  activeModel,
);
check(
  "different response provider does not inherit fallback display name",
  routedProviderModel?.name === "k3" && routedProviderModel?.provider === "moonshotai",
  JSON.stringify(routedProviderModel),
);
check(
  "routed provider identity cannot select Kimi from stale fallback name",
  selectAdapterForAssistantMessage({ ...assistantMessage, provider: "moonshotai" }, activeModel) === undefined,
);

const routerShell = {
  ...activeModel,
  provider: "router",
  id: "auto",
  name: "Kimi Smart Route",
  api: "router-api",
  baseUrl: "",
};
const routerShellResponse = modelFromAssistantMessage(
  { ...assistantMessage, provider: "router", model: "auto", api: "router-api" },
  routerShell,
);
check(
  "virtual router shell does not preserve a family-bearing fallback display name",
  routerShellResponse?.name === "auto",
  JSON.stringify(routerShellResponse),
);
check(
  "virtual router shell cannot select Kimi from its route display name",
  selectAdapterForAssistantMessage(
    { ...assistantMessage, provider: "router", model: "auto", api: "router-api" },
    routerShell,
  ) === undefined,
);

const unrelatedModel = {
  ...activeModel,
  provider: "unrelated",
  name: "K3",
  baseUrl: "https://example.com/anthropic",
};
const unrelatedMessage = { ...assistantMessage, provider: "unrelated" };
check(
  "bare unrelated k3 remains unmatched",
  selectAdapterForAssistantMessage(unrelatedMessage, unrelatedModel) === undefined,
);

const handlers = new Map<string, Handler>();
const commands = new Map<string, Command>();
const statusUpdates: Array<string | undefined> = [];
const notifications: string[] = [];
const mockPi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand(name: string, command: Command) {
    commands.set(name, command);
  },
};
extension(mockPi as any);

const sessionId = "issue-4-kimi-session";
const ctx = {
  model: activeModel,
  modelRegistry: {
    find: () => undefined,
    getAvailable: () => [],
    getAll: () => [],
  },
  sessionManager: { getSessionId: () => sessionId },
  ui: {
    notify(message: string) {
      notifications.push(message);
    },
    setStatus(_key: string, value: string | undefined) {
      statusUpdates.push(value);
    },
    confirm: async () => false,
    select: async () => undefined,
  },
  hasUI: true,
};

const messageEnd = handlers.get("message_end");
check("extension registers message_end", typeof messageEnd === "function");
await messageEnd?.({ message: assistantMessage }, ctx);

const statsCommand = commands.get("cache-optimizer");
check("extension registers cache-optimizer command", typeof statsCommand?.handler === "function");
await statsCommand?.handler("stats", ctx);
const statsOutput = notifications.at(-1) ?? "";
check("stats command targets kimi-coding/k3", statsOutput.includes("Model key: kimi-coding/k3"), statsOutput);
check("stats command reports Kimi adapter", statsOutput.includes("Adapter:   Kimi cache"), statsOutput);
check("message_end records one cache hit", statsOutput.includes("Requests:      1 hit / 1 total"), statsOutput);
check("message_end records reported cached tokens", statsOutput.includes("Cached tokens: 0.16M / 0.16M input"), statsOutput);
check("message_end records a recent hit sample", statsOutput.includes("Recent 1/10: 1/1 hits"), statsOutput);
check(
  "footer publishes non-zero Kimi stats",
  statusUpdates.some((value) => value?.startsWith("Kimi cache 1/1")),
  JSON.stringify(statusUpdates),
);

const sessionHash = hashSessionId(sessionId);
await Bun.sleep(2_200);
const persisted = JSON.parse(
  await readFile(join(tempAgentDir, "pi-cache-optimizer-stats.json"), "utf8"),
);
check(
  "persisted totalsByModel records kimi-coding/k3",
  persisted.totalsByModel?.["kimi-coding/k3"]?.totalRequests === 1 &&
    persisted.totalsByModel?.["kimi-coding/k3"]?.hitRequests === 1 &&
    persisted.totalsByModel?.["kimi-coding/k3"]?.cachedInputTokens === 159_488 &&
    persisted.totalsByModel?.["kimi-coding/k3"]?.totalInputTokens === 159_987,
  JSON.stringify(persisted.totalsByModel),
);
check(
  "persisted current-session bucket records kimi-coding/k3",
  persisted.sessions?.[sessionHash]?.["kimi-coding/k3"]?.totalRequests === 1 &&
    persisted.sessions?.[sessionHash]?.["kimi-coding/k3"]?.hitRequests === 1 &&
    persisted.sessions?.[sessionHash]?.["kimi-coding/k3"]?.cachedInputTokens === 159_488 &&
    persisted.sessions?.[sessionHash]?.["kimi-coding/k3"]?.totalInputTokens === 159_987,
  JSON.stringify(persisted.sessions?.[sessionHash]),
);

await statsCommand?.handler("reset", ctx);
check("session hash is deterministic for the test fixture", sessionHash.length === 16);

await rm(tempAgentDir, { recursive: true, force: true });

console.log(`\nPassed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) process.exit(1);
