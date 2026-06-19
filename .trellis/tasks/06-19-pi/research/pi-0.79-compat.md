# Pi 0.79 compatibility notes for pi-cache-optimizer

## Sources inspected

* Local global Pi: `pi --version` -> `0.79.7`.
* Project local SDK package: `node_modules/@earendil-works/pi-coding-agent` -> `0.79.6`.
* Pi docs from the global 0.79.7 install:
  * `README.md`
  * `CHANGELOG.md`
  * `docs/extensions.md`
  * `docs/packages.md`
  * `docs/compaction.md`
  * `docs/sdk.md`

## Findings relevant to this extension

### Extension API

The hooks used by this project remain documented in 0.79.7:

* `session_start`
* `model_select`
* `before_agent_start`
* `before_provider_request`
* `after_provider_response`
* `message_end`
* `tool_call` / `tool_result` documentation is updated, but this package does not depend on changed behavior there.

`before_agent_start` still exposes `systemPrompt` and `systemPromptOptions`, including structured prompt inputs. This package's prompt rewrite path still maps to the current docs.

`ctx.ui.setStatus`, `ctx.ui.notify`, `ctx.sessionManager.getSessionId()`, and `ctx.model` remain valid extension-context surfaces.

### Pi package behavior

0.79.7 changes `pi update` semantics:

* `pi update` now updates Pi only.
* `pi update --all` updates Pi and packages.
* `pi update --extensions` updates packages only.

This may require README wording checks if the project documents package update commands. The current package manifest (`pi.extensions: ["./index.ts"]`) remains compatible.

### Project config path helper

0.79.7 exports `CONFIG_DIR_NAME` so extensions can avoid hardcoding `.pi` for project config paths. This package uses user/global state paths under `~/.pi/agent` for stats and docs/user-facing paths, not project-local config discovery paths, so no mandatory migration is indicated.

### Built-in cache hit footer

0.79.0 added Pi's built-in latest prompt cache hit footer marker (`CH`). This package still offers separate value:

* provider/model/session-scoped persisted counters;
* prompt rewrite optimization;
* OpenAI-compatible `prompt_cache_key` fallback;
* compat diagnostics and doctor commands.

README should avoid implying Pi has no cache-hit visibility at all; it can say this package adds provider-aware persisted stats and optimization on top of Pi's latest-hit footer.

### Compaction/session behavior

0.79 docs show compaction/session APIs remain compatible. No direct package adjustment identified.

## Candidate adjustments

1. Sync the project's local `@earendil-works/pi-coding-agent` dev dependency from 0.79.6 to 0.79.7 if type/package dry-run validation depends on the local installed SDK.
2. Run TypeScript check against the current installed types/shims.
3. Search README/README.zh-CN for update/cache-footer wording and adjust only if outdated.

## Recommendation

No obvious runtime API breakage from Pi 0.79.7. Likely minimal work: update local SDK install/lock if necessary and refresh docs wording if current wording is stale; otherwise report no code changes needed after validation.
