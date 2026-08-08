# Improve footer separation and command completion

## Goal

Make Pi Cache Optimizer's footer status visually distinct when other extensions also publish footer statuses, and make `/cache-optimizer` easier to use by providing native Pi Tab completion for its subcommands and arguments.

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

## Acceptance Criteria

* [ ] Every non-empty status published by this extension begins with `· `, including disabled-mode and warning-suffixed statuses.
* [ ] A footer containing another extension's status renders with an unambiguous separator before this extension's model/cache label.
* [ ] `/cache-optimizer <Tab>` offers the supported subcommands.
* [ ] `/cache-optimizer c<Tab>` narrows to `config` and `/cache-optimizer config <Tab>` offers `footer-mode`.
* [ ] `/cache-optimizer config footer-mode <Tab>` offers `total`, `session`, and `process`, filtered by prefix.
* [ ] Invalid/unknown completion prefixes return `null` without throwing.
* [ ] Regression tests cover the footer prefix and completion filtering/nesting.
* [ ] `npm run typecheck`, `npm test`, `npm run check:diff`, and `npm run check:pack` pass.
* [ ] README.md, README.zh-CN.md, and `.trellis/spec/frontend/cache-adapter-footer-stats.md` match the implemented behavior.

## Definition of Done

* Runtime code and ambient Pi API types are updated.
* Permanent tests cover the externally visible footer and completion contracts.
* User-facing documentation and the relevant Trellis spec are synchronized.
* All required quality checks pass and the final diff contains no whitespace errors.

## Technical Approach

* Add a small pure completion helper in `index.ts` that returns Pi-compatible `{ value, label, description? }` items for the supported command grammar.
* Register that helper as `getArgumentCompletions` on the existing `cache-optimizer` command.
* Add the leading `· ` at the final footer status assembly boundary rather than changing adapter labels or `/cache-optimizer stats` output.
* Extend `types/pi-coding-agent.d.ts` with the optional command completion callback and compatible completion-item shape so the project type-checks against its local ambient API shim.
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
* Ambient Pi API shim: `types/pi-coding-agent.d.ts`.
* Existing command tests and footer behavior tests live in `tests/review-findings.test.ts`.
* Relevant spec: `.trellis/spec/frontend/cache-adapter-footer-stats.md`.
