# Completion Report — Investigate Kiro Claude 0% cache hit rate

## Result

The Kiro Claude 0% cache-hit behavior is documented as a provider transport limitation, not a pi-cache-optimizer bug.

## Findings

Research in `research/kiro-cache-passthrough.md` showed that `pi-provider-kiro` uses the custom `kiro-api` transport and does not surface upstream cache usage fields that this extension can read.

## Spec Update

`.trellis/spec/frontend/cache-adapter-footer-stats.md` now includes a dedicated provider transport caveat for `kiro-api` documenting:

- wire identity (`provider: "kiro"`, `api: "kiro-api"`)
- package/transport details
- source-of-truth pointer that cache fields are not assigned from upstream responses
- explicit footer behavior: Kiro Claude stays at truthful 0%
- warning behavior: do not add noisy Kiro-specific compat warnings
- forbidden pattern: do not fake cache counters

## Validation

No runtime code change was required for this task. The current project validation passed in follow-up work:

- `bunx tsc --noEmit --pretty false` ✅
- `git diff --check` ✅
- `npm pack --dry-run` ✅

## Notes

This task is complete as a research/spec task. Any future upstream `pi-provider-kiro` change that surfaces cache usage fields should be handled as a new task with fresh transport verification.
