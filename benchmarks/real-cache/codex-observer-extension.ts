/**
 * Benchmark-only observer for direct OpenAI Codex runs.
 * Records payload shape and Pi-normalized usage without intercepting auth or network traffic.
 * Also prepends a stable per-session namespace so different arms cannot warm one another's prefix.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Pending = {
  startedAt: number;
  responseAt?: number;
  promptText: string;
  promptCacheKey?: string;
};

type Cost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

function renderPrompt(payload: any): string {
  if (typeof payload?.instructions === "string" || Array.isArray(payload?.input)) {
    const parts: string[] = [];
    if (typeof payload.instructions === "string") parts.push(JSON.stringify({ instructions: payload.instructions }));
    if (Array.isArray(payload.tools) && payload.tools.length) parts.push(JSON.stringify({ tools: payload.tools }));
    if (Array.isArray(payload.input)) parts.push(JSON.stringify({ input: payload.input }));
    return parts.join("\n");
  }
  const parts: string[] = [];
  if (Array.isArray(payload?.tools) && payload.tools.length) parts.push(JSON.stringify(payload.tools));
  for (const message of Array.isArray(payload?.messages) ? payload.messages : []) parts.push(JSON.stringify(message));
  return parts.join("\n");
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export default function codexObserver(pi: ExtensionAPI) {
  const file = process.env.BENCH_OBSERVER_FILE;
  const label = process.env.BENCH_LABEL;
  const namespace = process.env.BENCH_NAMESPACE;
  const skipPromptNamespace = process.env.BENCH_NO_PROMPT_NAMESPACE === "1";
  if (!file || !label) return;
  mkdirSync(dirname(file), { recursive: true });
  const pending: Pending[] = [];

  // Loaded last. This keeps each session in a disjoint cache prefix while preserving
  // the treatment's final prompt byte-for-byte after this one stable line.
  pi.on("before_agent_start", (event) => {
    if (!namespace || skipPromptNamespace) return {};
    return { systemPrompt: `[bench-run:${namespace}]\n${event.systemPrompt}` };
  });

  pi.on("before_provider_request", (event) => {
    const payload = (event as any)?.payload;
    const warmer = payload?.max_tokens === 1 || payload?.max_completion_tokens === 1;
    if (warmer) return;
    pending.push({
      startedAt: Date.now(),
      promptText: renderPrompt(payload),
      promptCacheKey: typeof payload?.prompt_cache_key === "string" ? payload.prompt_cache_key : undefined,
    });
  });

  pi.on("after_provider_response", () => {
    const request = pending.find((item) => item.responseAt === undefined);
    if (request) request.responseAt = Date.now();
  });

  pi.on("message_end", (event) => {
    const message = (event as any)?.message;
    if (message?.role !== "assistant") return;
    const request = pending.shift();
    if (!request) return;
    const usage = message.usage ?? {};
    const input = nonNegative(usage.input) ?? 0;
    const cacheRead = nonNegative(usage.cacheRead) ?? 0;
    const cacheWrite = nonNegative(usage.cacheWrite) ?? 0;
    const totalInput = input + cacheRead + cacheWrite;
    const rawCost = usage.cost ?? {};
    const cost: Cost = {
      input: nonNegative(rawCost.input) ?? 0,
      output: nonNegative(rawCost.output) ?? 0,
      cacheRead: nonNegative(rawCost.cacheRead) ?? 0,
      cacheWrite: nonNegative(rawCost.cacheWrite) ?? 0,
      total: nonNegative(rawCost.total) ?? 0,
    };
    appendFileSync(file, `${JSON.stringify({
      label,
      at: new Date(request.startedAt).toISOString(),
      status: message.stopReason === "error" ? 500 : 200,
      promptCacheKey: request.promptCacheKey,
      promptText: request.promptText,
      promptChars: request.promptText.length,
      responseHeaderMs: request.responseAt === undefined ? undefined : request.responseAt - request.startedAt,
      totalMs: Date.now() - request.startedAt,
      usage: { input, cacheRead, cacheWrite, totalInput, output: nonNegative(usage.output) ?? 0, cost },
    })}\n`);
  });
}
