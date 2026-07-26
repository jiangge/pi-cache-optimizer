#!/usr/bin/env bun
/** Regression coverage for Anthropic mixed cache_control TTL ordering. */

const moduleUrl = new URL(`../../../index.ts?anthropic-ttl=${Date.now()}`, import.meta.url).href;
const { default: extension, __internals_for_tests: I } = await import(moduleUrl);

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

function cc(ttl?: "5m" | "1h"): Record<string, unknown> {
  return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

function ttlList(payload: unknown): unknown[] {
  return I.collectAnthropicCacheControlsInWireOrder(payload).map((control: Record<string, unknown>) => control.ttl ?? "5m-default");
}

const userReportedShape = {
  tools: [{ name: "read", cache_control: cc("1h") }],
  system: [{ type: "text", text: "stable", cache_control: cc() }],
  messages: Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: index === 24
      ? [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "text", text: "c" },
        { type: "text", text: "latest", cache_control: cc("1h") },
      ]
      : [{ type: "text", text: String(index) }],
  })),
};
check(
  "collector follows tools, system, messages wire order",
  JSON.stringify(ttlList(userReportedShape)) === JSON.stringify(["1h", "5m-default", "1h"]),
  JSON.stringify(ttlList(userReportedShape)),
);
check("user-reported messages.N.content.N conflict is detected", I.normalizeAnthropicCacheControlTtlOrder(userReportedShape));
check(
  "invalid payload is uniformly downgraded to default 5m",
  JSON.stringify(ttlList(userReportedShape)) === JSON.stringify(["5m-default", "5m-default", "5m-default"]),
  JSON.stringify(ttlList(userReportedShape)),
);

const toolsToSystemConflict = {
  tools: [{ name: "read", cache_control: cc("5m") }],
  system: [{ type: "text", text: "system", cache_control: cc("1h") }],
  messages: [],
};
check("tools 5m before system 1h is normalized", I.normalizeAnthropicCacheControlTtlOrder(toolsToSystemConflict));
check(
  "tools/system conflict removes explicit long TTL",
  JSON.stringify(ttlList(toolsToSystemConflict)) === JSON.stringify(["5m", "5m-default"]),
  JSON.stringify(ttlList(toolsToSystemConflict)),
);

const legalLongThenShort = {
  tools: [{ name: "read", cache_control: cc("1h") }],
  system: [{ type: "text", text: "system", cache_control: cc("1h") }],
  messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc() }] }],
};
check("legal 1h to 5m order is unchanged", !I.normalizeAnthropicCacheControlTtlOrder(legalLongThenShort));
check(
  "legal mixed TTL values are preserved",
  JSON.stringify(ttlList(legalLongThenShort)) === JSON.stringify(["1h", "1h", "5m-default"]),
  JSON.stringify(ttlList(legalLongThenShort)),
);

const longOnly = {
  tools: [{ name: "read", cache_control: cc("1h") }],
  system: [{ type: "text", text: "system", cache_control: cc("1h") }],
  messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc("1h") }] }],
};
check("long-only payload is unchanged", !I.normalizeAnthropicCacheControlTtlOrder(longOnly));
check("long-only TTL stays explicit", ttlList(longOnly).every((ttl) => ttl === "1h"));

const shortOnly = {
  system: [{ type: "text", text: "system", cache_control: cc() }],
  messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc("5m") }] }],
};
check("short-only payload is unchanged", !I.normalizeAnthropicCacheControlTtlOrder(shortOnly));

const nestedUserData = {
  tools: [{
    name: "schema-tool",
    input_schema: {
      type: "object",
      properties: {
        cache_control: { type: "object", ttl: "1h" },
      },
    },
  }],
  system: [],
  messages: [],
};
check("collector ignores cache_control-looking user schema data", ttlList(nestedUserData).length === 0);

// Hook-level API gating.
type Handler = (event: any, ctx: any) => unknown;
const handlers = new Map<string, Handler>();
const mockPi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand() {},
};
extension(mockPi as any);
const beforeProviderRequest = handlers.get("before_provider_request");
check("extension registers before_provider_request", typeof beforeProviderRequest === "function");

const anthropicModel = {
  provider: "pipi-cc",
  id: "claude-opus-5",
  name: "Claude Opus 5",
  api: "anthropic-messages",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};
function context(model: any) {
  return {
    model,
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    sessionManager: { getSessionId: () => "ttl-test-session" },
    ui: { notify: () => undefined, setStatus: () => undefined, confirm: async () => false, select: async () => undefined },
  };
}

const hookAnthropicPayload = {
  system: [{ type: "text", text: "stable", cache_control: cc() }],
  messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc("1h") }] }],
};
const anthropicResult = beforeProviderRequest?.({ payload: hookAnthropicPayload }, context(anthropicModel));
check("Anthropic hook normalizes invalid mixed TTL", ttlList(hookAnthropicPayload).every((ttl) => ttl === "5m-default"));
check("Anthropic mutation does not replace payload unnecessarily", anthropicResult === undefined);

I.setRuntimeOptimizerEnabled(false);
const disabledRuntimePayload = {
  system: [{ type: "text", text: "stable", cache_control: cc() }],
  messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc("1h") }] }],
};
beforeProviderRequest?.({ payload: disabledRuntimePayload }, context(anthropicModel));
check(
  "TTL protocol safety remains active when runtime optimization is disabled",
  ttlList(disabledRuntimePayload).every((ttl) => ttl === "5m-default"),
);
I.setRuntimeOptimizerEnabled(true);

const openAiPayload = {
  system: [{ type: "text", text: "stable", cache_control: cc() }],
  messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc("1h") }] }],
  prompt_cache_key: "already-set",
};
beforeProviderRequest?.(
  { payload: openAiPayload },
  context({ ...anthropicModel, provider: "other", id: "gpt-5", name: "GPT-5", api: "openai-completions" }),
);
check(
  "non-Anthropic API does not normalize Anthropic-shaped nested fields",
  JSON.stringify(ttlList(openAiPayload)) === JSON.stringify(["5m-default", "1h"]),
  JSON.stringify(ttlList(openAiPayload)),
);

// Routing registry must gate by effective upstream API, not virtual shell API.
const registry = I.ensureRoutingRegistry();
const unregister = registry.registerRouter({
  virtualProvider: "router",
  resolveActiveRoute() {
    return {
      virtualProvider: "router",
      virtualModelId: "auto",
      provider: "pipi-cc",
      modelId: "claude-opus-5",
      api: "anthropic-messages",
      timestamp: Date.now(),
    };
  },
});
const routedPayload = {
  system: [{ type: "text", text: "stable", cache_control: cc() }],
  messages: [{ role: "user", content: [{ type: "text", text: "latest", cache_control: cc("1h") }] }],
};
beforeProviderRequest?.(
  { payload: routedPayload },
  context({ ...anthropicModel, provider: "router", id: "auto", name: "Auto", api: "router-api" }),
);
check("routed Anthropic upstream normalizes invalid mixed TTL", ttlList(routedPayload).every((ttl) => ttl === "5m-default"));
unregister();

console.log(`\nPassed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);
if (failed > 0) process.exit(1);
