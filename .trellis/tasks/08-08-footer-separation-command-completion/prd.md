# Improve footer separation, command completion, and audit hardening

## Goal

Make Pi Cache Optimizer's footer status visually distinct when other extensions also publish footer statuses, make `/cache-optimizer` easier to use with native Pi Tab completion, and resolve the confirmed findings from a subsequent full-project review without changing established command semantics.

## What I already know

* The extension publishes its status through `ctx.ui.setStatus("pi-cache-stats", statusText)` in `index.ts`.
* `formatCacheStats()` currently starts with the adapter label, so Pi can render another extension's status immediately before it without a visual separator (for example, `Cloudflare MCP: off OpenAI cache ...`).
* Pi's registered-command API supports `getArgumentCompletions(argumentPrefix)`, which is the native completion hook used by the interactive editor.
* `/cache-optimizer` currently parses subcommands including `enable`, `disable`, `doctor`, `stats`, `config footer-mode total|session|process`, `compat`, `reset`, and `fix`.
* The project requires runtime behavior, README, spec, and permanent regression tests to stay aligned.

## Requirements

* Prefix the extension-owned footer status with `· ` so that the combined footer reads like `Cloudflare MCP: off · OpenAI cache 0/0 · 0M/0M tok`.
* Keep the existing internal separators and warning markers intact; the prefix must be applied consistently for normal, disabled, router-restored, integrity-warning, and compat-warning footer variants.
* Add native `/cache-optimizer` argument Tab completion using `getArgumentCompletions`.
* Complete all supported top-level subcommands: `enable`, `disable`, `doctor`, `stats`, `config`, `compat`, `reset`, and `fix`.
* Complete the nested `config footer-mode` path and its supported values: `total`, `session`, and `process`.
* Filter suggestions by the currently typed argument prefix, tolerate leading/trailing whitespace, and return `null` when there are no matches so Pi can fall back normally.
* Do not change command execution semantics or introduce a custom editor/autocomplete provider when the native command completion hook is sufficient.
* Update English/Chinese README examples and the footer contract spec to document the leading separator and command completion behavior.
* Preserve the pre-existing `models.json` access mode exactly across `/fix` backup, commit, self-check failure, and rollback; do not independently tighten or loosen it.
* Use unique non-overwriting backup names and atomic temp+rename for both commit and rollback.
* Detect explicit unsupported `prompt_cache_retention` errors from response headers or finalized assistant error messages so subsequent current-process requests strip the rejected field.
* Type-check against the installed official Pi and Node declarations instead of a full ambient module redeclaration.
* Run every permanent `tests/*.test.ts` file and migrate critical persistence, routing, hook, TTL, lifecycle, and model-identity contracts out of archived-only verifiers.
* Require Pi 0.82+ in package peer metadata, matching the documented support range.
* Reuse the direct command handler for interactive menu actions so security-sensitive `/fix` and other command behavior have one implementation path.

## Acceptance Criteria

* [x] Every non-empty status published by this extension begins with `· `, including disabled-mode and warning-suffixed statuses.
* [x] A footer containing another extension's status renders with an unambiguous separator before this extension's model/cache label.
* [x] `/cache-optimizer <Tab>` offers the supported subcommands.
* [x] `/cache-optimizer c<Tab>` narrows to `config` and `/cache-optimizer config <Tab>` offers `footer-mode`.
* [x] `/cache-optimizer config footer-mode <Tab>` offers `total`, `session`, and `process`, filtered by prefix.
* [x] Invalid/unknown completion prefixes return `null` without throwing.
* [x] Regression tests cover the footer prefix and completion filtering/nesting.
* [x] `npm run typecheck`, `npm test`, `npm run check:diff`, and `npm run check:pack` pass.
* [x] README.md, README.zh-CN.md, and `.trellis/spec/frontend/cache-adapter-footer-stats.md` match the implemented behavior.
* [x] Direct and menu `/fix` paths preserve modes such as `0600` and `0644`; forced post-write failure atomically restores both original bytes and mode.
* [x] Two backup names generated in the same millisecond are distinct and existing backups are never overwritten.
* [x] A body-only assistant error `400 Unsupported parameter: prompt_cache_retention` makes the next request omit that field.
* [x] Standard `npm run typecheck` uses the installed Pi 0.84.2 declarations and passes without `types/pi-coding-agent.d.ts` or Node module redeclarations.
* [x] Permanent tests cover migrations, `_nosession` removal, serialized writes, shutdown flush, routing/cache-hints, TTL ordering, cache key preservation, and direct-provider identity consolidation.
* [x] `peerDependencies` requires Pi 0.82+ and interactive menu actions reuse the direct command handler.

## Definition of Done

* Runtime code and official Pi API type usage are updated.
* Permanent tests cover the externally visible footer/completion contracts and the confirmed audit hardening contracts.
* User-facing documentation and the relevant Trellis spec are synchronized.
* All required quality checks pass and the final diff contains no whitespace errors.

## Technical Approach

* Add a small pure completion helper in `index.ts` that returns Pi-compatible `{ value, label, description? }` items for the supported command grammar.
* Register that helper as `getArgumentCompletions` on the existing `cache-optimizer` command.
* Add the leading `· ` at the final footer status assembly boundary rather than changing adapter labels or `/cache-optimizer stats` output.
* Consume Pi's installed native command-completion and context types directly; remove the full local ambient Pi/Node redeclarations that can mask API incompatibilities.
* Export the pure helpers through `__internals_for_tests` only as needed for deterministic tests.

## Decision (ADR-lite)

**Context**: Pi combines status values from multiple extensions in one footer line. The extension's current status has no ownership boundary, and its command has several nested arguments that are easy to mistype.

**Decision**: Use the conventional middle-dot prefix (`· `) at the beginning of this extension's status and Pi's built-in `getArgumentCompletions` API for command completion. Provide completion for the full supported command grammar without changing command parsing.

**Consequences**: The footer gains one visible leading separator while preserving existing status wording. Completion remains native to Pi and requires no extra UI dependency. Future subcommands need to be added to the same completion grammar when command support changes.

## Out of Scope

* Replacing Pi's footer renderer or taking ownership of the whole footer.
* Adding completion for unrelated built-in commands or file paths.
* Changing cache statistics formatting, counters, warning semantics, or command behavior.
* Adding fuzzy matching beyond the prefix filtering expected by Pi's completion API.

## Technical Notes

* Primary runtime file: `index.ts`.
* Official Pi types: installed `@earendil-works/pi-coding-agent` declarations.
* Command/footer/fix tests live in `tests/review-findings.test.ts`; broader runtime contracts live in `tests/runtime-contracts.test.ts`.
* Relevant spec: `.trellis/spec/frontend/cache-adapter-footer-stats.md`.
