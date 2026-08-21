# Hook Guidelines

> Pi extension hooks used by this package.

---

## Overview

This repository does not use React hooks. “Hooks” here are Pi extension lifecycle hooks registered in `index.ts`.

Primary hooks/events:

- `session_start`
- `session_shutdown`
- `tool_execution_end`
- `agent_settled`
- `model_select`
- `before_agent_start`
- `before_provider_request`
- `after_provider_response`
- `message_end`

---

## Pi Hook Patterns

### `session_start`

- Delete/ignore obsolete v1-v6 single-file stats and load the v7 shard aggregate for the current local day.
- Create an empty instance-owned shard; on reload, older shards with the same session hash preserve the session scope without copying counters into the new shard.
- In TUI mode, install an unreferenced `fs.watch` listener for shard changes. Do not install a permanent polling interval.
- Run best-effort expired-shard maintenance under the cross-process cleanup lease.
- Notify compat only when runtime optimizer is enabled and publish footer status after restore.

### `session_shutdown`

- Cancel any pending debounced stats timer and await a final serialized `closed` shard write before Pi tears down the runtime.
- Close the shard watcher and pending refresh timer, but retain the current-day shard so the day's parent/child totals remain available.
- Uninstall the extension-owned `Symbol.for("pi.cache.hints.v1")` service without deleting a newer replacement owner.
- Clear extension-owned legacy cache-key globals and transient hint state.
- Restore the process-original `PI_CACHE_RETENTION` value. The baseline is process-scoped and must survive extension module reloads.

### `tool_execution_end` / `agent_settled`

- Re-scan shard aggregates and publish footer status. These lifecycle refreshes make watcher delivery an optimization rather than a correctness requirement.
- Explicit stats/doctor/config/reset commands also force an aggregate refresh before reading or publishing relevant state.

### `model_select`

- Resolve live routing-provider upstream model when available.
- Notify compat only when runtime optimizer is enabled.
- Publish footer for the selected/effective model.

### `before_agent_start`

- Apply prompt rewrite pipeline only when runtime optimizer and env gates allow it.
- Official OpenAI Responses/Codex prompt bypass must remain intact.
- Publish query-scoped cache hints through `Symbol.for("pi.cache.hints.v1")` when applicable.
- Never persist prompt contents to disk.

### `before_provider_request`

- For every effective `anthropic-messages` model, validate final cache breakpoints in `tools → system → messages` order and downgrade a visible invalid 5-minute-to-1-hour transition. Preserve legal third-party 1-hour retention unless this exact provider/model previously returned Anthropic's explicit TTL-ordering error in the current process.
- Only inject OpenAI-compatible `prompt_cache_key` fallback for `openai-completions` / `openai-responses` APIs.
- Preserve existing non-empty `prompt_cache_key` / `promptCacheKey` values.
- Use Pi session id fallback; do not derive keys from prompt content.
- For virtual routing providers, resolve the upstream model via the routing registry when available.

### `after_provider_response`

- Record model-scoped 400 hints only for applicable prompt-cache-retention failures; the untouched Pi built-in `llama.cpp` compat fingerprint is excluded, while same-id overrides with explicit cache compat remain eligible.
- Record model-scoped 403 hints only for applicable third-party OpenAI-compatible proxy failures (session-affinity headers or OpenAI SDK header/User-Agent diagnostics). The untouched built-in `llama.cpp` fingerprint and custom transports are excluded; provider id alone is not an exemption.
- Do not log payloads, headers, prompts, or credentials.

### `message_end`

- Before the normal error/aborted stats early return, detect only Anthropic's explicit mixed-TTL ordering error and record a process-local provider/model fallback for the next subsequent request. This is a non-retryable 400 in Pi 0.82.1; do not promise built-in automatic retry. Do not classify generic 400 or prompt-too-long errors.
- Assistant message metadata is authoritative for final stats identity.
- Use message-local provider/model/api/usage when available; do not use global route state for final stats.
- Update current-instance stats and recent samples only with numeric counters, then atomically persist the instance-owned shard.
- Before recording a model, re-read global/model reset epochs; an epoch change clears only the affected current-instance counters before the new usage is added.

---

## Naming Conventions

- Keep helper names verb-oriented and explicit: `resolveRouteModel`, `publishStatus`, `restoreCacheStats`, `describeMissing...`.
- Pure helpers that are used by verification scripts should be exported through `__internals_for_tests` rather than made public package API.

---

## Common Mistakes

- Doing final stats attribution from live/global router state instead of assistant message metadata.
- Injecting OpenAI cache keys into custom transports such as `kiro-api`.
- Normalizing Anthropic TTLs by provider/model name instead of validating the effective API and final wire-order payload.
- Treating a provider id alone (including `llama.cpp`) as proof of transport capabilities; prefer Pi's explicit model/compat fingerprint and honor overrides.
- Writing prompt or payload data to task reports, stats files, logs, or notifications.
- Adding hook behavior that cannot be disabled by the established runtime/env gates.
- Leaving debounced writes, global protocol services, legacy hint globals, or extension-mutated environment values alive after `session_shutdown`.
- Allowing same-instance stats writes to overlap; atomic rename prevents partial files but does not preserve write order.
- Treating `fs.watch` as authoritative or adding an unconditional periodic poll; lifecycle/command refreshes provide eventual correctness without idle I/O.
