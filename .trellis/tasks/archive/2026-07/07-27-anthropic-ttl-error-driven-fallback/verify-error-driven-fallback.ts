#!/usr/bin/env bun
/** Regression coverage for error-driven Anthropic long-TTL fallback. */

const moduleUrl = new URL(`../../../../../index.ts?ttl-fallback=${Date.now()}`, import.meta.url).href;
const { default: extension, __internals_for_tests: I } = await import(moduleUrl);

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function cc(ttl?: "5m" | "1h") { return { type: "ephemeral", ...(ttl ? { ttl } : {}) }; }
function payload(ttls: Array<"5m" | "1h" | undefined> = ["1h", "1h", "1h"]) {
  return {
    tools: [{ name: "read", cache_control: cc(ttls[0]) }],
    system: [{ type: "text", text: "system", cache_control: cc(ttls[1]) }],
    messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc(ttls[2]) }] }],
  };
}
function ttls(value: unknown): unknown[] {
  return I.collectAnthropicCacheControlsInWireOrder(value).map((control: any) => control.ttl ?? "5m-default");
}

const exactError = {
  role: "assistant",
  provider: "proxy-a",
  model: "claude-opus-5",
  api: "anthropic-messages",
  stopReason: "error",
  errorMessage: `400 {"error":{"message":"messages.24.content.3.cache_control.ttl: a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block."}}`,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
check("exact Anthropic TTL order error is recognized", I.hasAnthropicCacheTtlOrderError(exactError));
check("prompt-too-long is not misclassified", !I.hasAnthropicCacheTtlOrderError({ ...exactError, errorMessage: "prompt is too long: 2727470 tokens > 1000000 maximum" }));
check("generic Anthropic 400 is not misclassified", !I.hasAnthropicCacheTtlOrderError({ ...exactError, errorMessage: "400 invalid_request_error" }));
check("successful message is not misclassified", !I.hasAnthropicCacheTtlOrderError({ ...exactError, stopReason: "stop" }));

const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const commands = new Map<string, any>();
extension({
  on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); },
  registerCommand(name: string, command: any) { commands.set(name, command); },
} as any);
const beforeRequest = handlers.get("before_provider_request");
const messageEnd = handlers.get("message_end");
const command = commands.get("cache-optimizer");
const notifications: string[] = [];
function model(provider = "proxy-a", id = "claude-opus-5") {
  return {
    provider, id, name: "Claude Opus 5", api: "anthropic-messages", baseUrl: "https://proxy.example",
    compat: { supportsLongCacheRetention: true, forceAdaptiveThinking: true }, reasoning: true,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 32_768,
  };
}
function ctx(activeModel: any) {
  return {
    model: activeModel,
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    sessionManager: { getSessionId: () => "ttl-error-driven" },
    ui: {
      notify(text: string) { notifications.push(text); },
      setStatus() {}, confirm: async () => false, select: async () => undefined,
    },
    hasUI: false,
  };
}

const firstPayload = payload();
beforeRequest?.({ payload: firstPayload }, ctx(model()));
check("legal third-party long-only payload is preserved before evidence", ttls(firstPayload).every((ttl) => ttl === "1h"), JSON.stringify(ttls(firstPayload)));

await messageEnd?.({ message: exactError }, ctx(model()));
check("TTL error emits one actionable warning", notifications.some((text) => text.includes("next request") && text.includes("supportsLongCacheRetention: false")), JSON.stringify(notifications));

const retryPayload = payload();
beforeRequest?.({ payload: retryPayload }, ctx(model()));
check("same provider/model retry falls back to default 5m", ttls(retryPayload).every((ttl) => ttl === "5m-default"), JSON.stringify(ttls(retryPayload)));

await messageEnd?.({ message: exactError }, ctx(model()));
check("repeated error warning is deduplicated", notifications.filter((text) => text.includes("TTL ordering error")).length === 1, JSON.stringify(notifications));

// A Pi reload creates a new extension instance, but the process-local observation
// remains available to the replacement instance.
const reloadedHandlers = new Map<string, (event: any, ctx: any) => unknown>();
extension({
  on(event: string, handler: (event: any, ctx: any) => unknown) { reloadedHandlers.set(event, handler); },
  registerCommand() {},
} as any);
const reloadedPayload = payload();
reloadedHandlers.get("before_provider_request")?.({ payload: reloadedPayload }, ctx(model()));
check("observed fallback survives extension reload", ttls(reloadedPayload).every((ttl) => ttl === "5m-default"), JSON.stringify(ttls(reloadedPayload)));

const otherProviderPayload = payload();
beforeRequest?.({ payload: otherProviderPayload }, ctx(model("proxy-b")));
check("same model id on another provider keeps 1h", ttls(otherProviderPayload).every((ttl) => ttl === "1h"), JSON.stringify(ttls(otherProviderPayload)));

const visibleConflict = payload(["1h", undefined, "1h"]);
beforeRequest?.({ payload: visibleConflict }, ctx(model("proxy-c")));
check("visible mixed order is fixed without prior error", ttls(visibleConflict).every((ttl) => ttl === "5m-default"), JSON.stringify(ttls(visibleConflict)));

await messageEnd?.({ message: { ...exactError, provider: "proxy-d", errorMessage: "prompt is too long: 2727470 tokens > 1000000 maximum" } }, ctx(model("proxy-d")));
const promptTooLongPayload = payload();
beforeRequest?.({ payload: promptTooLongPayload }, ctx(model("proxy-d")));
check("prompt-too-long does not activate TTL fallback", ttls(promptTooLongPayload).every((ttl) => ttl === "1h"), JSON.stringify(ttls(promptTooLongPayload)));

await command?.handler("doctor", ctx(model()));
const doctor = notifications.at(-1) ?? "";
check("doctor reports observed Anthropic TTL fallback", doctor.includes("TTL ordering error") && doctor.includes("/cache-optimizer fix"), doctor);

await command?.handler("fix", ctx(model()));
const fix = notifications.at(-1) ?? "";
check("non-interactive fix advises supportsLongCacheRetention false", fix.includes("supportsLongCacheRetention") && fix.includes("false"), fix);

const combinedModel = { ...model("proxy-combined"), compat: { supportsLongCacheRetention: true } };
await messageEnd?.({ message: { ...exactError, provider: "proxy-combined" } }, ctx(combinedModel));
await command?.handler("fix", ctx(combinedModel));
const combinedFix = notifications.at(-1) ?? "";
check(
  "fix merges adaptive compat and observed TTL fallback",
  combinedFix.includes("forceAdaptiveThinking") && combinedFix.includes("supportsLongCacheRetention") && combinedFix.includes("false"),
  combinedFix,
);

const placement = I.chooseFixPlacement(
  "{}",
  {
    modelObjectBrace: 0, modelObjectEnd: 1, compatKeyStart: -1, compatObjectBrace: -1,
    compatObjectEnd: -1, indent: "  ", providerObjectBrace: 0, providerObjectEnd: 1,
    providerCompatBrace: -1, providerCompatEnd: -1, allModelIds: ["claude-opus-5", "claude-sonnet-5"],
  },
  { supportsLongCacheRetention: false },
  "proxy-combined",
  true,
);
check("observed TTL fix placement is model-scoped", placement.placement === "model", JSON.stringify(placement));

// Routed shell: assistant metadata remains authoritative for the real upstream key.
const registry = I.ensureRoutingRegistry();
const unregister = registry.registerRouter({
  virtualProvider: "router",
  resolveActiveRoute() {
    return { virtualProvider: "router", virtualModelId: "auto", provider: "upstream-a", modelId: "claude-opus-5", api: "anthropic-messages", timestamp: Date.now() };
  },
});
const routerModel = { ...model("router", "auto"), name: "Auto", api: "router-api" };
await messageEnd?.({ message: { ...exactError, provider: "upstream-a" } }, ctx(routerModel));
const routedRetry = payload();
beforeRequest?.({ payload: routedRetry }, ctx(routerModel));
check("routed upstream error activates upstream fallback", ttls(routedRetry).every((ttl) => ttl === "5m-default"), JSON.stringify(ttls(routedRetry)));
unregister();

console.log(`\nPassed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) process.exit(1);
