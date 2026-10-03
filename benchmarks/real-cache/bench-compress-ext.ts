// Bench-only extension: applies this repo's skill compression regardless of API. The shipped extension deliberately
// bypasses prompt rewriting for Responses/Codex backends, so this is the only way to exercise the compressed list there.
import { __internals_for_tests as internals } from "../../index.ts";

export default function (pi: any) {
  pi.on("before_agent_start", async (event: any) => {
    const out = internals.compressSkillsInSystemPrompt(event.systemPrompt, event.systemPromptOptions);
    return out !== event.systemPrompt ? { systemPrompt: out } : {};
  });
}
