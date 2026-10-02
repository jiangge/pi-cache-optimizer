import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { __internals_for_tests as internals } from "#extension";

// Pins which footer adapter each model name resolves to. The table was captured from the implementation that
// had one hand-written adapter per family (before they were collapsed into OPENAI_SHAPED_FAMILIES), so a change
// here means the family matching changed, not just the refactor.
const EXPECTED_LABELS: Array<[string, string | null]> = [
  ["kimi", "Kimi cache"],
  ["qwen", "Qwen cache"],
  ["glm", "GLM cache"],
  ["minimax", "MiniMax cache"],
  ["mimo", "Mimo cache"],
  ["hunyuan", "Hunyuan cache"],
  ["mistral", "Mistral cache"],
  ["grok", "Grok cache"],
  ["llama", "Llama cache"],
  ["nemotron", "Nemotron cache"],
  ["cohere", "Cohere cache"],
  ["command-r", "Cohere cache"],
  ["aya-expanse", "Aya cache"],
  ["yi-34b", "Yi cache"],
  ["yi-lightning", "Yi cache"],
  ["01-ai", "Yi cache"],
  ["zero-one", "Yi cache"],
  ["doubao", "Doubao cache"],
  ["seed-1.6", "Doubao cache"],
  ["seed", "Doubao cache"],
  ["豆包", "Doubao cache"],
  ["volcengine", "Doubao cache"],
  ["bytedance", "Doubao cache"],
  ["ernie", "ERNIE cache"],
  ["wenxin", "ERNIE cache"],
  ["文心", "ERNIE cache"],
  ["baichuan", "Baichuan cache"],
  ["step-1", "StepFun cache"],
  ["stepfun", "StepFun cache"],
  ["spark", "Spark cache"],
  ["internlm", "InternLM cache"],
  ["gemma", "Gemma cache"],
  ["phi-4", "Phi cache"],
  ["phi", "Phi cache"],
  ["jamba", "Jamba cache"],
  ["solar", "Solar cache"],
  ["sonar", "Sonar cache"],
  ["perplexity", "Sonar cache"],
  ["nova", "Nova cache"],
  ["reka", "Reka cache"],
  ["falcon", "Falcon cache"],
  ["dbrx", "DBRX cache"],
  ["mpt-7b", "MPT cache"],
  ["stablelm", "StableLM cache"],
  ["aquila", "Aquila cache"],
  ["exaone", "EXAONE cache"],
  ["hyperclova", "HyperCLOVA cache"],
  ["luminous", "Luminous cache"],
  ["hermes", "Hermes cache"],
  ["granite", "Granite cache"],
  ["arctic", "Arctic cache"],
  ["pangu", "Pangu cache"],
  ["sensenova", "SenseNova cache"],
  ["zhinao", "Zhinao cache"],
  ["minicpm", "MiniCPM cache"],
  ["xverse", "XVERSE cache"],
  ["orion", "Orion cache"],
  ["openchat", "OpenChat cache"],
  ["vicuna", "Vicuna cache"],
  ["wizard", null],
  ["zephyr", "Zephyr cache"],
  ["dolphin", "Dolphin cache"],
  ["openorca", "OpenOrca cache"],
  ["starling", "Starling cache"],
  ["bloom", "BLOOM cache"],
  ["rwkv", "RWKV cache"],
  ["aya", "Aya cache"],
  ["gpt-5", "OpenAI cache"],
  ["claude-opus-4-7", "Claude cache"],
  ["gemini-2.5", "Gemini cache"],
  ["deepseek-v4", "DS cache"],
  ["o3", "OpenAI cache"],
  ["DEEPSEEK", "DS cache"],
  ["KiMi-K2", "Kimi cache"],
  ["Qwen3-Coder", "Qwen cache"],
  ["my-seed-model", "Doubao cache"],
  ["yi", "Yi cache"],
  ["phi-", "Phi cache"],
  ["random-model", null],
  ["x", null],
];

const model = (id: string, api = "openai-completions") => ({
  provider: "custom-proxy", id, name: id, api, baseUrl: "https://proxy.example/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
}) as any;

describe("model family adapter selection", () => {
  test("resolves each model name to the same footer adapter as before the table refactor", () => {
    for (const [name, label] of EXPECTED_LABELS) {
      assert.equal(internals.selectAdapterForModel(model(name))?.label ?? null, label, `model ${JSON.stringify(name)}`);
    }
  });

  test("assistant messages match through their own model/name fields, only when they are assistant messages", () => {
    const base = model("unrelated-model");
    assert.equal(internals.selectAdapterForAssistantMessage({ role: "assistant", model: "kimi-k2" }, base)?.label, "Kimi cache");
    assert.equal(internals.selectAdapterForAssistantMessage({ role: "assistant", name: "Seed-1.6" }, base)?.label, "Doubao cache");
    assert.equal(internals.selectAdapterForAssistantMessage({ model: "kimi-k2" }, base), undefined, "not an assistant message");
    assert.equal(internals.selectAdapterForAssistantMessage({ role: "assistant", model: "unknown-thing" }, base), undefined);
  });

  test("specific adapters win over the generic family table", () => {
    assert.equal(internals.selectAdapterForModel(model("deepseek-v4"))?.label, "DS cache");
    assert.equal(internals.selectAdapterForModel(model("claude-opus-4-7"))?.label, "Claude cache");
    assert.equal(internals.selectAdapterForModel(model("gemini-2.5"))?.label, "Gemini cache");
  });

  test("every family adapter reads OpenAI-shaped usage and shares the proxy compat warning", () => {
    const usageOf = (usage: Record<string, number>, rawUsage?: Record<string, unknown>) =>
      ({ role: "assistant", model: "x", usage: { output: 5, cacheRead: 0, cacheWrite: 0, ...usage }, ...(rawUsage ? { rawUsage } : {}) });
    for (const name of ["qwen3-coder", "rwkv-world", "aya-expanse-8b", "yi-lightning"]) {
      const adapter = internals.selectAdapterForModel(model(name))!;
      assert.equal(adapter.id, "openai", name);
      assert.deepEqual(adapter.normalizeUsage(usageOf({ input: 100 })), { cacheRead: 0, cacheWrite: 0, totalInput: 100 }, name);
      assert.deepEqual(
        adapter.normalizeUsage(usageOf({ input: 100, cacheRead: 40, cacheWrite: 10 }, { prompt_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } })),
        { cacheRead: 40, cacheWrite: 10, totalInput: 150 },
        name,
      );
      // A third-party OpenAI-compatible endpoint without cache/affinity compat flags gets the proxy warning.
      assert.match(adapter.warningText!(model(name)) ?? "", /session|affinity|compat/i, name);
    }
  });
});
