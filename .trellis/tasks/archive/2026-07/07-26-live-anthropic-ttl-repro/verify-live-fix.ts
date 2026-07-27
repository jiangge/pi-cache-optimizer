#!/usr/bin/env bun
/** Regression coverage derived from the Pi 0.82.1 + pipi-cc live reproduction. */

const loadedExtension = await import("#extension");
const extensionModule = "__internals_for_tests" in loadedExtension ? loadedExtension : loadedExtension.default;
const { default: extension, __internals_for_tests: I } = extensionModule;

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function cc(ttl?: "5m" | "1h") { return { type: "ephemeral", ...(ttl ? { ttl } : {}) }; }
function payload(ttls: Array<"5m" | "1h" | undefined>) {
  return {
    tools: [{ name: "read", cache_control: cc(ttls[0]) }],
    system: [{ type: "text", text: "system", cache_control: cc(ttls[1]) }],
    messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc(ttls[2]) }] }],
  };
}
function ttls(value: unknown): unknown[] {
  return I.collectAnthropicCacheControlsInWireOrder(value).map((control: any) => control.ttl ?? "5m-default");
}

check("official Anthropic hostname recognized", I.isOfficialAnthropicBaseUrl({ provider: "anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" } as any));
check("built-in Anthropic without baseUrl recognized", I.isOfficialAnthropicBaseUrl({ provider: "anthropic", baseUrl: "", api: "anthropic-messages" } as any));
check("pipi-cc proxy is not official Anthropic", !I.isOfficialAnthropicBaseUrl({ provider: "pipi-cc", baseUrl: "https://api.picpi.top", api: "anthropic-messages" } as any));

const proxyLongOnly = payload(["1h", "1h", "1h"]);
check("proxy long-only controls are downgraded", I.downgradeAnthropicLongCacheControls(proxyLongOnly));
check("proxy controls become default 5m", ttls(proxyLongOnly).every((ttl) => ttl === "5m-default"), JSON.stringify(ttls(proxyLongOnly)));

const alreadyShort = payload([undefined, "5m", undefined]);
check("already-short payload reports no change", !I.downgradeAnthropicLongCacheControls(alreadyShort));

const officialMixed = payload(["1h", undefined, "1h"]);
check("official visible mixed order is normalized", I.normalizeAnthropicCacheControlTtlOrder(officialMixed));
check("official invalid mixed order becomes short", ttls(officialMixed).every((ttl) => ttl === "5m-default"));

const officialLegal = payload(["1h", "1h", undefined]);
check("official legal long-to-short order remains unchanged", !I.normalizeAnthropicCacheControlTtlOrder(officialLegal));
check("official legal 1h values are preserved", JSON.stringify(ttls(officialLegal)) === JSON.stringify(["1h", "1h", "5m-default"]));

type Handler = (event: any, ctx: any) => unknown;
const handlers = new Map<string, Handler>();
extension({ on: (event: string, handler: Handler) => handlers.set(event, handler), registerCommand() {} } as any);
const hook = handlers.get("before_provider_request");
function model(provider: string, baseUrl: string) {
  return { provider, id: "claude-opus-5", name: "Claude Opus 5", api: "anthropic-messages", baseUrl, reasoning: true, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 1_000_000, maxTokens: 32_768 };
}
function ctx(activeModel: any) {
  return { model: activeModel, modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] }, sessionManager: { getSessionId: () => "live-ttl" }, ui: { notify() {}, setStatus() {}, confirm: async () => false, select: async () => undefined } };
}

const pipiPayload = payload(["1h", "1h", "1h"]);
hook?.({ payload: pipiPayload }, ctx(model("pipi-cc", "https://api.picpi.top")));
check("hook downgrades pipi-cc long-only visible payload", ttls(pipiPayload).every((ttl) => ttl === "5m-default"));

const anthropicPayload = payload(["1h", "1h", "1h"]);
hook?.({ payload: anthropicPayload }, ctx(model("anthropic", "https://api.anthropic.com")));
check("hook preserves official Anthropic long-only payload", ttls(anthropicPayload).every((ttl) => ttl === "1h"));

console.log(`\nPassed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) process.exit(1);
