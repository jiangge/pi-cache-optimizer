/** Benchmark-only counterfactual: restore Pi's native XML skill index after the optimizer runs. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, skillFileReadTool } from "../../src/prompt-rewrite.ts";

export default function forceNativeSkillIndex(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    if (!options.skills?.length) return {};
    const native = formatSkillsForPrompt(options.skills, skillFileReadTool(options) ?? "read").trim();
    if (!native) return {};
    if (options.sections && typeof options.sections === "object" && options.forceSystemPrompt === undefined) {
      options.sections.skills = native;
      return {};
    }
    const compressedMarker = "## Skills in ";
    if (!event.systemPrompt.includes(compressedMarker)) return {};
    // On older/forced-prompt layouts we cannot reliably locate the whole compressed
    // block without re-rendering sections, so fail closed instead of guessing.
    return {};
  });
}
