import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import extension, { __internals_for_tests as internals } from "#extension";

type PiModel = NonNullable<ExtensionContext["model"]>;
type Handler = (event: any, context: any) => unknown;

const originalToolOrderEnv = process.env[internals.TOOL_ORDER_ENV];
const originalRuntime = internals.isRuntimeOptimizerEnabled();
const originalRetention = process.env[internals.PI_CACHE_RETENTION_ENV];

afterEach(() => {
  if (originalToolOrderEnv === undefined) delete process.env[internals.TOOL_ORDER_ENV];
  else process.env[internals.TOOL_ORDER_ENV] = originalToolOrderEnv;
  internals.setRuntimeOptimizerEnabled(originalRuntime);
  if (originalRetention === undefined) delete process.env[internals.PI_CACHE_RETENTION_ENV];
  else process.env[internals.PI_CACHE_RETENTION_ENV] = originalRetention;
});

function model(overrides: Partial<PiModel> = {}): PiModel {
  return {
    provider: "proxy",
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    compat: {},
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...overrides,
  };
}

function functionCompletionTool(name: string, extra: Record<string, unknown> = {}) {
  return {
    type: "function",
    function: {
      name,
      description: `${name} description`,
      parameters: { type: "object", properties: {} },
    },
    ...extra,
  };
}

function functionResponseTool(name: string) {
  return {
    type: "function",
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
  };
}

describe("deterministic tool ordering", () => {
  test("sorts verified OpenAI completions tools immutably and preserves fields", () => {
    const payload = {
      model: "gpt-5.5",
      tools: [
        functionCompletionTool("zeta", { vendorField: { keep: true } }),
        functionCompletionTool("alpha"),
      ],
      tool_choice: { type: "function", function: { name: "zeta" } },
      metadata: { preserve: "yes" },
    };
    const original = structuredClone(payload);
    const sorted = internals.sortToolsInPayload(payload, "openai-completions") as typeof payload;

    assert.deepEqual(payload, original);
    assert.deepEqual(sorted.tools.map((tool) => tool.function.name), ["alpha", "zeta"]);
    assert.strictEqual(sorted.tools[0], payload.tools[1]);
    assert.strictEqual(sorted.tools[1], payload.tools[0]);
    assert.strictEqual(sorted.tool_choice, payload.tool_choice);
    assert.strictEqual(sorted.metadata, payload.metadata);
    assert.deepEqual((sorted.tools[1] as any).vendorField, { keep: true });
    assert.notEqual(sorted, payload);
  });

  test("supports verified Responses, Anthropic, Google, and Bedrock shapes", () => {
    const responses = {
      tools: [functionResponseTool("z"), functionResponseTool("a")],
      tool_choice: "auto",
    };
    const anthropic = {
      tools: [
        { name: "z", description: "z", input_schema: { type: "object" } },
        { name: "a", description: "a", input_schema: { type: "object" } },
      ],
    };
    const abortSignal = new AbortController().signal;
    const googleMetadata = { preserveIdentity: true };
    const google = {
      model: "gemini-3",
      contents: [],
      config: {
        tools: [{ functionDeclarations: [
          { name: "z", parametersJsonSchema: { type: "object" } },
          { name: "a", parametersJsonSchema: { type: "object" } },
        ] }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        abortSignal,
        metadata: googleMetadata,
      },
    };
    const cachedAnthropic = {
      tools: [
        { name: "z", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { name: "a", input_schema: { type: "object" } },
      ],
    };
    const bedrock = {
      toolConfig: {
        tools: [
          { toolSpec: { name: "z", description: "z", inputSchema: { json: { type: "object" } } } },
          { toolSpec: { name: "a", description: "a", inputSchema: { json: { type: "object" } } } },
        ],
        toolChoice: { auto: {} },
      },
    };

    const sortedResponses = internals.sortToolsInPayload(responses, "openai-responses") as typeof responses;
    assert.deepEqual(sortedResponses.tools.map((tool) => tool.name), ["a", "z"]);
    assert.strictEqual(sortedResponses.tools[0], responses.tools[1]);
    const sortedAnthropic = internals.sortToolsInPayload(anthropic, "anthropic-messages") as typeof anthropic;
    assert.deepEqual(sortedAnthropic.tools.map((tool) => tool.name), ["a", "z"]);
    assert.strictEqual(sortedAnthropic.tools[0], anthropic.tools[1]);
    assert.strictEqual(internals.sortToolsInPayload(cachedAnthropic, "anthropic-messages"), cachedAnthropic);
    const originalGoogleTools = google.config.tools[0].functionDeclarations;
    const sortedGoogle = internals.sortToolsInPayload(google, "google-generative-ai") as typeof google;
    assert.deepEqual(sortedGoogle.config.tools[0].functionDeclarations.map((tool) => tool.name), ["a", "z"]);
    assert.deepEqual(originalGoogleTools.map((tool) => tool.name), ["z", "a"]);
    assert.strictEqual(sortedGoogle.config.tools[0].functionDeclarations[0], originalGoogleTools[1]);
    assert.strictEqual(sortedGoogle.config.tools[0].functionDeclarations[1], originalGoogleTools[0]);
    assert.strictEqual(sortedGoogle.config.abortSignal, abortSignal);
    assert.strictEqual(sortedGoogle.config.metadata, googleMetadata);
    const sortedVertex = internals.sortToolsInPayload(google, "google-vertex") as typeof google;
    assert.deepEqual(sortedVertex.config.tools[0].functionDeclarations.map((tool) => tool.name), ["a", "z"]);
    assert.strictEqual(sortedVertex.config.abortSignal, abortSignal);
    const sortedBedrock = internals.sortToolsInPayload(bedrock, "bedrock-converse-stream") as typeof bedrock;
    assert.deepEqual(sortedBedrock.toolConfig.tools.map((tool) => tool.toolSpec.name), ["a", "z"]);
    assert.strictEqual(sortedBedrock.toolConfig.tools[0], bedrock.toolConfig.tools[1]);
    assert.strictEqual(sortedBedrock.toolConfig.toolChoice, bedrock.toolConfig.toolChoice);
  });

  test("keeps equal-name order stable and treats unsupported or malformed payloads as no-ops", () => {
    const tied = {
      tools: [functionCompletionTool("same", { marker: 1 }), functionCompletionTool("same", { marker: 2 })],
    };
    assert.strictEqual(internals.sortToolsInPayload(tied, "openai-completions"), tied);
    assert.deepEqual((internals.sortToolsInPayload(tied, "openai-completions") as typeof tied).tools.map((tool) => (tool as any).marker), [1, 2]);

    const malformed = { tools: [functionCompletionTool("valid"), { type: "function", function: { parameters: {} } }] };
    assert.strictEqual(internals.sortToolsInPayload(malformed, "openai-completions"), malformed);
    const malformedGoogle = {
      config: {
        tools: [
          { functionDeclarations: [{ name: "z", parametersJsonSchema: { type: "object" } }] },
          { functionDeclarations: [{ parametersJsonSchema: { type: "object" } }] },
        ],
      },
    };
    assert.strictEqual(internals.sortToolsInPayload(malformedGoogle, "google-vertex"), malformedGoogle);
    const customPayload = { tools: [functionCompletionTool("z")] };
    assert.strictEqual(internals.sortToolsInPayload(customPayload, "custom-api"), customPayload);
    const unknown = { unrelated: true };
    assert.strictEqual(internals.sortToolsInPayload(unknown, "openai-completions"), unknown);
  });

  test("never moves cache breakpoints or Anthropic deferred-tool groups", () => {
    const openAIWithAnthropicMarker = {
      tools: [
        functionCompletionTool("z"),
        functionCompletionTool("a", { cache_control: { type: "ephemeral", ttl: "1h" } }),
      ],
    };
    assert.strictEqual(
      internals.sortToolsInPayload(openAIWithAnthropicMarker, "openai-completions"),
      openAIWithAnthropicMarker,
    );
    assert.equal(openAIWithAnthropicMarker.tools.findIndex((tool) => "cache_control" in tool), 1);

    const deferredAnthropic = {
      tools: [
        { name: "z", input_schema: { type: "object" } },
        { name: "a", input_schema: { type: "object" }, defer_loading: true },
      ],
    };
    assert.strictEqual(
      internals.sortToolsInPayload(deferredAnthropic, "anthropic-messages"),
      deferredAnthropic,
    );
  });

  test("keeps Anthropic cache-control placement authoritative while repairing TTL order", () => {
    process.env[internals.TOOL_ORDER_ENV] = "true";
    internals.setRuntimeOptimizerEnabled(true);
    const handlers = new Map<string, Handler>();
    extension({
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      registerCommand() {},
    } as any);
    const request = handlers.get("before_provider_request");
    assert.ok(request);
    const payload = {
      tools: [
        { name: "z", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { name: "a", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
    };
    const context = {
      model: model({ api: "anthropic-messages", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }),
      sessionManager: { getSessionId: () => "anthropic-tool-order-session" },
      modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    };
    request({ payload }, context);
    assert.deepEqual(payload.tools.map((tool) => tool.name), ["z", "a"]);
    assert.equal(payload.tools[1].cache_control.ttl, undefined);
  });

  test("hook ordering is gated and composes tool ordering with existing request mutations", () => {
    process.env[internals.TOOL_ORDER_ENV] = "true";
    internals.setRuntimeOptimizerEnabled(true);
    const handlers = new Map<string, Handler>();
    extension({
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      registerCommand() {},
    } as any);
    const request = handlers.get("before_provider_request");
    assert.ok(request);

    const payload = {
      model: "gpt-5.5",
      tools: [functionCompletionTool("z"), functionCompletionTool("a")],
      messages: [],
    };
    const context = {
      model: model({ compat: { supportsLongCacheRetention: true } }),
      sessionManager: { getSessionId: () => "tool-order-session" },
      modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    };
    const result = request({ payload }, context) as typeof payload & { prompt_cache_retention?: unknown };
    assert.deepEqual(result.tools.map((tool) => tool.function.name), ["a", "z"]);
    assert.deepEqual(payload.tools.map((tool) => tool.function.name), ["z", "a"]);
    assert.equal(result.prompt_cache_retention, undefined);

    const responseResult = request({ payload }, {
      ...context,
      model: model({ api: "openai-responses", id: "gpt-5.5-responses" }),
    }) as typeof payload & { prompt_cache_key?: string } | undefined;
    assert.equal(responseResult, undefined);
    assert.deepEqual(payload.tools.map((tool) => tool.function.name), ["z", "a"]);

    const googleSignal = new AbortController().signal;
    const googleTools = [
      { name: "z", parametersJsonSchema: { type: "object" } },
      { name: "a", parametersJsonSchema: { type: "object" } },
    ];
    const googlePayload = {
      model: "gemini-3",
      contents: [],
      config: {
        tools: [{ functionDeclarations: googleTools }],
        abortSignal: googleSignal,
      },
    };
    const googleResult = request({ payload: googlePayload }, {
      ...context,
      model: model({ api: "google-generative-ai", id: "gemini-3", name: "Gemini 3" }),
    }) as typeof googlePayload;
    assert.deepEqual(googleResult.config.tools[0].functionDeclarations.map((tool) => tool.name), ["a", "z"]);
    assert.deepEqual(googlePayload.config.tools[0].functionDeclarations.map((tool) => tool.name), ["z", "a"]);
    assert.strictEqual(googleResult.config.tools[0].functionDeclarations[0], googleTools[1]);
    assert.strictEqual(googleResult.config.abortSignal, googleSignal);

    internals.setRuntimeOptimizerEnabled(false);
    const disabledRuntimeResult = request({ payload }, context);
    assert.equal(disabledRuntimeResult, undefined);
    assert.deepEqual(payload.tools.map((tool) => tool.function.name), ["z", "a"]);
    internals.setRuntimeOptimizerEnabled(true);

    process.env[internals.TOOL_ORDER_ENV] = "0";
    const disabledResult = request({ payload }, context) as typeof payload & { prompt_cache_key?: string };
    assert.deepEqual(disabledResult.tools.map((tool) => tool.function.name), ["z", "a"]);
    assert.equal(disabledResult.prompt_cache_key, "tool-order-session");
  });
});
