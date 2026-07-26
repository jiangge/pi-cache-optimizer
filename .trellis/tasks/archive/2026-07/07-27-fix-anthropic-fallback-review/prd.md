# Fix Anthropic fallback review findings

## Goal
Correct the error-driven Anthropic TTL fallback so its documentation and runtime behavior match Pi 0.82.1, keep persisted fixes scoped to the affected model by default, preserve fallback state across extension reloads within the process, and make archived verification reproducible.

## What I already know
- Pi 0.82.1 does not automatically retry Anthropic TTL-order HTTP 400 errors; its retry classifier handles transient 429/5xx/network patterns.
- The extension records an in-memory provider/model fallback in `message_end`; because Pi classifies this TTL 400 as non-retryable, the fallback applies to the next subsequent request rather than promising a built-in automatic retry.
- `/cache-optimizer fix` currently treats `supportsLongCacheRetention` as provider-level safe, which can broaden a model-specific observed error to sibling models.
- Extension-local Sets are recreated by `/reload`, so the current fallback disappears on reload.
- The archived error-driven verification script imports `../../../index.ts`, which resolves incorrectly after archiving.

## Requirements
- [x] Update runtime/user-facing/spec text to state that a TTL 400 fallback applies to the next subsequent request (not promise Pi automatic retry); notify accurately.
- [x] Ensure an observed error-driven `supportsLongCacheRetention: false` suggestion is model-scoped, including when merged with ordinary compat suggestions, without changing unrelated explicit/general fix placement behavior.
- [x] Preserve observed Anthropic fallback state across extension reloads in the same process, with safe process-global ownership/versioning and no persistence of sensitive data; process exit naturally clears it.
- [x] Make archived verification scripts for this behavior use a repository-root-stable import and add coverage for the corrected semantics/placement/reload behavior where practical.
- [ ] Keep legal third-party 1h payloads unchanged and retain strict error matching.
- [ ] Do not use subagents.

## Acceptance Criteria
- [x] No README/spec/source text claims the 400 TTL error will trigger Pi automatic retry.
- [x] A TTL error for provider/model A produces a model-level fix for A and does not write provider-level compat that affects sibling B.
- [x] Recreating the extension instance in one process still sees the observed fallback for the same provider/model.
- [x] Archived verification runs directly from its archived path.
- [x] `bunx tsc --noEmit --pretty false`, relevant verification scripts, `git diff --check`, `npm pack --dry-run`, and Trellis validation pass.

## Definition of Done
- Tests updated/added for changed behavior.
- README English/Chinese and frontend spec aligned.
- No secrets, payloads, prompts, headers, or response bodies logged or persisted.
- Commit created after verification.

## Out of Scope
- Implementing a new active retry/continuation mechanism inside Pi for non-retryable 400 errors.
- Changing Mainline or other repositories.
- Publishing or pushing a package release.

## Technical Notes
- Main implementation: `index.ts`.
- Relevant docs: `README.md`, `README.zh-CN.md`, `.trellis/spec/frontend/cache-adapter-footer-stats.md`, `.trellis/spec/frontend/hook-guidelines.md`.
- Relevant verification: `.trellis/tasks/archive/2026-07/07-27-anthropic-ttl-error-driven-fallback/verify-error-driven-fallback.ts`.
