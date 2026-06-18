# Completion Report — Reduce Pi system prompt token volume

## Result

The approved extension-side reductions shipped and are documented.

## Implemented Cuts

- Skills XML compression via `formatSkillsForPromptCompressed` / `compressSkillsInSystemPrompt`.
- Session-overview churn stripping via `stripSessionOverviewChurn`.
- Stable-prefix reorder hardening with structural marker integrity checks.
- Persistent opt-out for skill compression via `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1`.
- Prompt rewrite opt-out via `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1`.

## Documentation

The durable contract is recorded in `.trellis/spec/frontend/cache-adapter-footer-stats.md`, including:

- System prompt budget
- Skills compression contract
- Session-overview churn strip
- Truncation guard / structural marker integrity
- Integrity diagnostics

## Validation

Recent project validation completed successfully:

- `bunx tsc --noEmit --pretty false` ✅
- `git diff --check` ✅
- `npm pack --dry-run` ✅

## Notes

The original PRD included optional live before/after billing and token measurements. The implementation and spec contracts are complete; live billing observations remain user-environment dependent and are preserved in the PRD/research as historical context.
