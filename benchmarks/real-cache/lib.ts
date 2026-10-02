import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const BENCH_DIR = new URL(".", import.meta.url).pathname;
export const OUT_DIR = process.env.BENCH_OUT || join(BENCH_DIR, "out");

export type ProviderConfig = {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  providerEntry: Record<string, unknown>;
  modelEntry: Record<string, unknown>;
};

/** Reads the real provider entry from the user's Pi models.json. The key never leaves this process except in the Authorization header. */
export function loadProviderConfig(provider: string, modelId: string): ProviderConfig {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const parsed = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as { providers?: Record<string, any> };
  const entry = parsed.providers?.[provider];
  if (!entry) throw new Error(`provider ${provider} not found in models.json`);
  const modelEntry = (entry.models || []).find((m: any) => m.id === modelId);
  if (!modelEntry) throw new Error(`model ${provider}/${modelId} not found in models.json`);
  if (typeof entry.apiKey !== "string" || entry.apiKey.startsWith("!") || /^[A-Z][A-Z0-9_]*$/.test(entry.apiKey)) {
    throw new Error("only literal apiKey values are supported by this harness");
  }
  return { provider, modelId, baseUrl: String(entry.baseUrl).replace(/\/+$/, ""), apiKey: entry.apiKey, providerEntry: entry, modelEntry };
}

export function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** Which response field the cached count came from; undefined when the provider reports none. */
  cachedField?: string;
  raw?: unknown;
};

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeUsage(raw: any): Usage {
  if (!raw || typeof raw !== "object") return {};
  const details = raw.prompt_tokens_details ?? raw.input_tokens_details ?? {};
  const candidates: Array<[string, unknown]> = [
    ["prompt_tokens_details.cached_tokens", details.cached_tokens],
    ["prompt_cache_hit_tokens", raw.prompt_cache_hit_tokens],
    ["cache_read_input_tokens", raw.cache_read_input_tokens],
    ["cached_tokens", raw.cached_tokens],
  ];
  const hit = candidates.find(([, v]) => num(v) !== undefined);
  return {
    promptTokens: num(raw.prompt_tokens) ?? num(raw.input_tokens),
    completionTokens: num(raw.completion_tokens) ?? num(raw.output_tokens),
    cachedTokens: hit ? (hit[1] as number) : undefined,
    cachedField: hit?.[0],
    raw,
  };
}

/** Last non-null `usage` object of an SSE stream, or of a plain JSON body. */
export function extractUsage(text: string): Usage {
  let last: unknown;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try { last = JSON.parse(trimmed).usage; } catch { /* fall through to SSE parsing */ }
  }
  if (!last) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const usage = JSON.parse(payload).usage;
        if (usage) last = usage;
      } catch { /* ignore partial chunks */ }
    }
  }
  return normalizeUsage(last);
}

/**
 * Renders the prompt-bearing part of a chat-completions body (tools first, then messages) so two requests
 * can be compared by longest common prefix. Request-level knobs (stream flags, cache key, ...) are excluded
 * because providers do not key the prompt cache on them.
 */
export function renderPrompt(body: any): string {
  const parts: string[] = [];
  if (Array.isArray(body?.tools) && body.tools.length) parts.push(JSON.stringify(body.tools));
  for (const message of Array.isArray(body?.messages) ? body.messages : []) parts.push(JSON.stringify(message));
  return parts.join("\n");
}

export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Best prefix overlap with any earlier prompt, converted to tokens proportionally to the current prompt's reported size. */
export function estimateLcpTokens(current: string, earlier: string[], promptTokens: number | undefined): number | undefined {
  if (!promptTokens || current.length === 0) return undefined;
  let best = 0;
  for (const prior of earlier) best = Math.max(best, commonPrefixLength(current, prior));
  return Math.round((best / current.length) * promptTokens);
}
