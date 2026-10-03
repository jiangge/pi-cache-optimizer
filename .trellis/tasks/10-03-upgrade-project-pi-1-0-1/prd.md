# Upgrade the project Pi baseline to 1.0.1 and apply required adjustments

## Goal

Raise this repository's reproducible local Pi development baseline from `1.0.0` to npm `latest` `1.0.1` (both `@earendil-works/pi-coding-agent` and the dev-only `@earendil-works/pi-server`), regenerate the lockfile, and apply the adjustments the upgrade requires. Keep the published peer range at `>=0.82.0` and do not change the published package version.

## Requirements

- Bump `devDependencies` to `"@earendil-works/pi-coding-agent": "^1.0.1"` and `"@earendil-works/pi-server": "1.0.1"`; leave `peerDependencies`/`packages.pi` untouched.
- Regenerate `package-lock.json` so only the Pi dependency tree moves; verify `npm ci` succeeds from a clean tree.
- Confirm the full quality gate passes: `npm run typecheck`, `npm test`, `npm run check:diff`, `npm run check:modules`, `npm run check:pack`.
- Assess Pi 1.0.1 as an upgrade target against this extension's real surfaces and fix only proven drift:
  - `dist/index.d.ts` published type surface (the extension imports only types plus `getAgentDir()`).
  - The four contract tests that bind to installed-Pi internals: `dist/core/model-config.js`, `dist/extensions/llama/provider.js`, `dist/core/skills.js`, `dist/core/system-prompt.js`, `dist/core/model-runtime.js`.
  - `prompt_cache_key` / `prompt_cache_retention` ownership for the OpenAI Responses/Codex transports, and the absence of a native `supportsPromptCacheKey` compat field.
  - Provider hook event shapes used by `index.ts` (`before_provider_request`, `before_provider_headers`, `after_provider_response`, `message_end`, `tool_execution_end`).
- Sync user-facing and internal version references (`README.md`, `README.zh-CN.md`, `index.ts` comments, `.trellis/spec/frontend/...`) to 1.0.1 where they currently pin a Pi version for the validated baseline.
- No sub-agents (user instruction): do the work in the main session.

## Acceptance Criteria

- [x] `node -e "require('@earendil-works/pi-coding-agent/package.json').version"` reports `1.0.1`; `@earendil-works/pi-server` resolves to `1.0.1`.
- [x] Clean `npm ci`, `npm run typecheck`, `npm test`, `npm run check:diff`, `npm run check:modules`, and `npm run check:pack` all pass.
- [x] Any drift found is covered by a permanent regression test (red before the fix, green after), not only by this task's evidence.
- [x] Peer range remains `>=0.82.0`; the extension keeps degrading to previous behavior on older hosts.
- [x] READMEs and specs no longer claim a stale validated baseline, and no new stale version reference remains.

## Compatibility Assessment (initial)

Evidence gathered before implementation:

- **Published type surface is add-only.** `dist/index.d.ts` (the package root the extension imports) changed only by adding `ToolRendererResolver` and `ToolRenderers` to the type re-export. No removed or altered type used by this extension.
- **`ExtensionAPI` is add-only.** 1.0.1 adds `registerToolRenderer(resolver)` and `Extension` adds `toolRenderers?`. Nothing this extension registers is affected; no action required unless we adopt tool rendering (out of scope).
- **No `version`-bearing constant drift in the four contract-bound internals.** `core/model-config.js`, `extensions/llama/provider.js`, `core/skills.js`, `core/system-prompt.js`, and `core/model-runtime.js` are byte-identical between 1.0.0 and 1.0.1, so the existing contract tests should stay green; this must still be confirmed by running them against the upgraded install.
- **Changelog items touching areas this extension depends on:**
  - Anthropic tools added/redefined mid-conversation are now defined inline so the prompt cache is preserved. This is a Pi-side prompt-cache improvement, not an extension surface; verify it does not change the system-prompt text the skills anchor matches.
  - `brace-expansion` pinned to 5.0.12 and `npm-shrinkwrap.json` removed from the published package. The lockfile change is expected and benign; confirm `npm ci` and `npm run check:pack` (which runs `npm pack --dry-run` on *this* package) still pass.
  - MCP project overrides and `oauth.clientRegistration: "cimd"` are Pi config features; the extension does not import MCP surfaces.
  - `pi update` now recommends the managed installer; no extension-visible API change.
- **Node engine stays `>=22.19.0`**, so the README's Node baseline statement does not change, but `pi-server` 1.0.1 moves to `@earendil-works/pi-protocol@^1.0.1` and this must resolve cleanly.

## Open questions for the user

1. Should this task also bump the repository's own `version` to initiate a 2.8.19 release, or is the baseline bump meant to land unreleased? (Existing upgrade tasks sometimes bundled a release.)
2. If drift is found in behavior that only manifests on a real Pi 1.0.1 host, is an isolated RPC smoke test with a fake local endpoint expected (as the 0.99.2 task did)?

## Verification

- **Baseline evidence before changes:** installed `pi-coding-agent@1.0.0`, `pi-server@1.0.0`.
- **After bump:** installed `pi-coding-agent@1.0.1`, `pi-server@1.0.1`, transitive `pi-protocol@1.0.1`, `brace-expansion@5.0.12`.
- **Lockfile scope:** diffing the before/after lockfile shows only the Pi dependency tree moved. 1.0.1 removed the published `npm-shrinkwrap.json`, so `@earendil-works/*` and their transitive deps flattened from the nested `pi-coding-agent/node_modules/**` locations to hoisted `node_modules/**`; no non-Pi package outside that graph changed versions except `@types/node` (22.20.1→22.20.5, within `^22.0.0`).
- **Clean install:** `rm -rf node_modules && npm ci` exits 0.
- **Quality gate after the bump and doc sync:** `npm run typecheck` 0, `npm test` 172 passed / 0 failed, `npm run check:diff` 0, `npm run check:modules` 0 (26 modules, no cycles), `npm run check:pack` 0 (31 files packed, every relative import resolves).
- **Contract tests against installed 1.0.1 internals all green:** `installed Pi built-in llama.cpp models match the untouched fingerprint exemption`, `skill compression anchors on the installed Pi skills formatter`, `skill compression on Pi's real system prompt`, `schema validation agrees with installed Pi for reviewed edge cases`, `installed Pi registerProvider drops lower provider compat for extension-owned models`, plus the model-runtime and system-prompt contract blocks.
- **Real-host load smoke:** loading `index.ts` through installed Pi 1.0.1's own `loadExtensions()` reports 1 extension, 0 errors, and all 10 expected handlers (`session_start`, `session_shutdown`, `tool_execution_end`, `agent_settled`, `model_select`, `before_agent_start`, `before_provider_headers`, `before_provider_request`, `after_provider_response`, `message_end`) plus the `cache-optimizer` command.
- **Package contents:** `npm pack --dry-run` packs 31 files and bundles zero `@earendil-works/*`/`pi-server` runtime deps.
- **No source change required:** 1.0.1's published root `dist/index.d.ts` and `ExtensionAPI` are add-only, and the four contract-bound internals are byte-identical to 1.0.0, so no drift test was added — the existing contract tests already pin those surfaces and stayed green.

## Out of Scope

- Raising the published minimum supported host Pi version.
- Adopting new 1.0.1 extension APIs (`registerToolRenderer`, image generation, MCP project overrides).
- Any change to published package version or npm release unless the user opts in.
