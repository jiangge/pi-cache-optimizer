# Implement session-scoped footer stats from PR 5

## Goal

Merge PR #5 so the contributor's work is recorded as accepted, then build on it in the current `master` baseline. Preserve both session-scoped and daily cumulative footer modes, restore cumulative `total` as the default, add a persistent configuration subcommand that overrides the environment variable, and correct router/virtual-channel restoration so every footer path uses the same selected scope. Preserve Pi 0.82+ compatibility, existing stats persistence/runtime hook behavior, and the cumulative totals used by `/cache-optimizer stats`.

## What I already know

* PR #5 changes the footer from restart-persistent `totalsByModel` counters to current-session counters by default.
* PR #5 adds `PI_CACHE_OPTIMIZER_FOOTER_MODE=session|total` with `session` as its proposed default, but the maintainer's original product intent is daily cumulative display, so the final default must remain `total`.
* The current repository already has session-scoped buckets in `cacheStatsByModel`, cumulative `cacheStatsTotalsByModel`, hashed session restoration, and exact last-routed-model metadata.
* PR #5's direct-model path selects the requested bucket, but router/virtual-channel restore still passes cumulative totals first and its legacy fallback scans cumulative totals. This can make routed footers disagree with direct-model footers under the default session mode.
* The user explicitly requested direct implementation without sub-agents and authorized formally merging PR #5 first so the contributor sees the PR as accepted.
* The final precedence is persistent command configuration > `PI_CACHE_OPTIMIZER_FOOTER_MODE` > default `total`.

## Requirements

* Merge PR #5 through GitHub before adding maintainer follow-up changes, preserving contributor attribution and visible `Merged` status.
* Support `session` and `total` footer modes on the current master baseline.
* Default footer mode is `total`. The environment variable accepts exact case-insensitive `session` or `total`; invalid or missing values fall back to `total`.
* Add `/cache-optimizer config footer-mode session|total|env`. `session` and `total` persist an explicit override in a separate agent-dir config file; `env` removes that override. The persisted command setting takes precedence over the environment variable.
* In session mode, direct models show only the current hashed session's provider/model bucket and show `0/0` for an unseen model. In total mode, they show `totalsByModel`.
* Router/virtual-channel footer restoration must use the same mode: exact routed restoration and legacy best-effort fallback select session buckets in session mode and cumulative buckets in total mode.
* Preserve cumulative totals for `/cache-optimizer stats`, reset, migration, and persistence behavior.
* Add permanent regression coverage for mode parsing, config precedence/persistence, and routed/direct footer bucket selection, including invalid values and session-vs-total differences.
* Update English and Chinese README footer documentation, command documentation, and the binding footer-stats spec.
* Do not modify cache transport behavior, prompt rewriting, ambient types, peer dependency range, package version, or Pi-specific APIs unrelated to this feature.

## Acceptance Criteria

* [x] GitHub PR #5 is visibly merged with contributor attribution, and its commits are incorporated with existing master changes preserved.
* [x] Footer mode parsing, persistent config precedence, and all footer display paths obey the documented `session` / `total` contract with default `total`.
* [x] Router exact restore and legacy fallback cannot read cumulative totals while session mode is active.
* [x] Direct and routed regression tests pass and cover default total mode, environment session/total/invalid values, persistent config precedence and clearing, same-session reload data, and router fallback.
* [x] README.md, README.zh-CN.md, and `.trellis/spec/frontend/cache-adapter-footer-stats.md` describe the default and opt-in modes consistently.
* [x] TypeScript, tests, diff, package dry-run, and Trellis validation pass.
* [x] No npm package was published and no unrelated GitHub PR or issue was changed; the resulting local commits remain reviewable.

## Definition of Done

* Runtime implementation and tests are complete.
* User-visible documentation and the frontend footer-stats spec are synchronized.
* `npm run check` passes.
* Task validation passes and changes are committed before task archival.

## Out of Scope

* Changing cache counters, provider transport hooks, prompt optimization, session hashing, or stats persistence schema.
* Adding Pi 0.83-only APIs or changing the `@earendil-works/pi-coding-agent` peer dependency.
* Publishing the npm package, changing unrelated GitHub issues/PRs, or closing PR #5 without merging it.

## Technical Notes

* Primary runtime file: `index.ts`.
* Permanent regression tests: `tests/review-findings.test.ts`.
* User docs: `README.md`, `README.zh-CN.md`.
* Binding behavior contract: `.trellis/spec/frontend/cache-adapter-footer-stats.md`.
* PR head reviewed: `50a0263` (`feat(footer): add PI_CACHE_OPTIMIZER_FOOTER_MODE toggle (session|total)`).
