# Completion Report — Fix prompt-pollution bugs degrading DeepSeek cache hit rate

## Result

The high-confidence prompt-pollution fixes are in place.

## Verified Fixes

- `.pi/extensions/trellis/index.ts` contains the local patch with a `LOCAL PATCH` comment and uses `promptGuidelines: [SUBAGENT_DISPATCH_PROTOCOL]` instead of a raw string.
- `index.ts` defines `MIN_STABLE_CANDIDATE_LENGTH = 8` and rejects short stable-prefix candidates before using `String.replace` extraction.
- `.trellis/spec/frontend/cache-adapter-footer-stats.md` documents the prompt reordering invariants and the Trellis string-vs-array regression.

## Validation

Command run:

```bash
bun .trellis/tasks/05-17-fix-prompt-pollution-bugs-degrading-deepseek-cache-hit-rate/verify.ts
```

Result:

```text
[verify] OK — all assertions passed (MIN_STABLE_CANDIDATE_LENGTH=8).
```

Additional project validation was run in follow-up tasks:

- `bunx tsc --noEmit --pretty false` ✅
- `git diff --check` ✅
- `npm pack --dry-run` ✅

## Remaining Notes

The PRD notes some live Pi observation items that require interactive in-Pi confirmation (for example visual DS cache hit-rate checks). The code/spec-level hardening and regression verification are complete, so this task is archived with those user-observation items recorded as historical context rather than active blockers.
