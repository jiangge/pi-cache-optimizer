/**
 * Benchmark-only reconstruction of the pre-2.8.17 stable-prefix lift.
 *
 * IMPORTANT: v2.8.16 intentionally bypassed this logic for Responses/Codex.
 * Loading this extension on openai-codex is therefore a counterfactual research
 * arm, not a reproduction of v2.8.16 production behavior.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN = 8;

function stableContextPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop();
  return name === "agents.md" || name === "claude.md" || name === "gemini.md" || name === "cursor.md" ||
    normalized.startsWith(".trellis/spec/") || normalized.includes("/.trellis/spec/");
}

function count(haystack: string, needle: string): number {
  let result = 0;
  let from = 0;
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    result++;
    if (result > 1) break;
    from = at + 1;
  }
  return result;
}

export default function legacyReorderBenchmark(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const opts = event.systemPromptOptions;
    const candidates: string[] = [];
    if (opts.customPrompt) candidates.push(opts.customPrompt);
    if (opts.appendSystemPrompt) candidates.push(opts.appendSystemPrompt);
    for (const guideline of opts.promptGuidelines ?? []) candidates.push(`- ${guideline.trim()}`);
    for (const file of opts.contextFiles ?? []) {
      if (!stableContextPath(file.path)) continue;
      candidates.push(`## ${file.path}\n\n${file.content}`, file.content);
    }

    const seen = new Set<string>();
    const parts = candidates.map((v) => v.trim()).filter((v) => v.length >= MIN && !seen.has(v) && seen.add(v));
    const unique = parts.filter((part) => count(event.systemPrompt, part) === 1);
    if (!unique.length) return {};

    let rest = event.systemPrompt;
    const lifted: string[] = [];
    for (const part of unique) {
      const at = rest.indexOf(part);
      if (at < 0) continue;
      lifted.push(part);
      rest = rest.slice(0, at) + rest.slice(at + part.length);
    }
    if (!lifted.length) return {};
    const result = `${lifted.join("\n\n")}\n\n---\n\n${rest.trim()}`;
    return result.trim() ? { systemPrompt: result } : {};
  });
}
