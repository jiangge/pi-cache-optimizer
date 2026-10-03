/** Benchmark-only counterfactual: force the current skill-index compression on Codex. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compressSkillsViaSection, compressSkillsInSystemPrompt } from "../../src/prompt-rewrite.ts";

export default function forceCodexSkillCompression(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    if (compressSkillsViaSection(event)) return {};
    const compressed = compressSkillsInSystemPrompt(event.systemPrompt, event.systemPromptOptions);
    return compressed === event.systemPrompt ? {} : { systemPrompt: compressed };
  });
}
