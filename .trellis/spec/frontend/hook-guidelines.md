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

- Delete/ignore obsolete v1-v6 single-file stats and load daily v7 totals plus all-retained-day session footer aggregates.
- Create an empty instance-owned shard; on reload, older shards with the same session hash preserve the session scope without copying counters into the new shard.
- In TUI mode, install an unreferenced `fs.watch` listener for shard changes. Do not install a permanent polling interval.
- Run best-effort expired-shard maintenance under the cross-process cleanup lease.
- Notify compat only when runtime optimizer is enabled and publish footer status after restore.

### `session_shutdown`

- Cancel any pending debounced stats timer, archive/rotate the daily shard if the local date changed, and await a final serialized `closed` shard write before Pi tears down the runtime.
- Close the shard watcher and pending refresh timer, but retain the current-day shard so the day's parent/child totals remain available.
- Uninstall the extension-owned `Symbol.for("pi.cache.hints.v1")` service without deleting a newer replacement owner.
- Clear extension-owned legacy cache-key globals and transient hint state.
- Restore the process-original `PI_CACHE_RETENTION` value. The baseline is process-scoped and must survive extension module reloads.

### `tool_execution_end` / `agent_settled`

- Re-scan shard aggregates and publish footer status. These lifecycle refreshes make watcher delivery an optimization rather than a correctness requirement.
- Skip `tool_execution_end` events that carry a non-empty `parentToolCallId` (Pi 0.99+ codemode nested calls run in parallel). The calling tool's own end event follows them and refreshes once for the batch; hosts without the field keep per-call refreshes.
- Explicit stats/doctor/config/reset commands also force an aggregate refresh before reading or publishing relevant state.

### `model_select`

- Resolve live routing-provider upstream model when available.
- Notify compat only when runtime optimizer is enabled.
- Publish footer for the selected/effective model.

### `before_agent_start`

- Apply prompt rewrite pipeline only when runtime optimizer and env gates allow it.
- Official OpenAI Responses/Codex prompt bypass must remain intact.
- Skip prompt mutation for a Pi 0.99+ native virtual selection (`ctx.model.api === "pi-virtual"`) by default. An explicit `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` opt-in may allow rewriting only when the routing registry exposes a complete candidate chain and every candidate is a known non-Responses, non-Codex transport; missing, malformed, unavailable, or unsafe candidates fail closed. Pi chooses the physical model per request after the system prompt is built, so the candidate safety gate is required.
- Publish query-scoped cache hints through `Symbol.for("pi.cache.hints.v1")` when applicable.
- Never persist prompt contents to disk.

### `before_provider_headers`

- Resolve effective compat from exact provider/model configuration with precedence `provider.compat → matching models[].compat → runtime model.compat → modelOverrides[modelId].compat`. Reject schema-invalid config as a whole, and match Pi's one-level merge behavior for nested routing/chat-template compat objects.
- For runtime-enabled, non-official `openai-completions` channels, if effective `sendSessionAffinityHeaders` is `true` from a models.json layer but an extension provider's runtime model lost that behavior, add Pi-compatible session-affinity headers from the current Pi session id. Routed fallback models must never inherit compat or transport metadata from a different virtual provider/model identity; recover exact upstream `api`/`baseUrl` only from validated models.json configuration so official OpenAI remains excluded, and fail closed when no non-empty effective base URL is known. Unknown endpoints are diagnostically not applicable, never “fully configured”.
- Match Pi's format rules (`x-session-id` for OpenRouter format; otherwise `x-client-request-id` + `x-session-affinity`, and `session_id` for OpenAI format), never overwrite existing headers case-insensitively, and respect explicit `false`.
- Never persist, display, or log the raw session id or request headers.
- For a native virtual selection, add no headers. Pi transforms headers before the payload exists and passes no model, so the physical model is unknown; Pi core still sends the physical model's own configured affinity headers.

### `before_provider_request`

- If `PI_CACHE_OPTIMIZER_TOOL_ORDER` is explicitly truthy, pass only verified built-in OpenAI Completions, Anthropic, Google, and Bedrock shapes through the pure immutable tool normalizer. Google/Vertex uses Pi's real `payload.config.tools[].functionDeclarations` shape. Sort by exact name with original index as a tie-breaker and shallow-clone only the changed path so SDK objects and `AbortSignal` retain identity.
- The pure helper recognizes the OpenAI Responses shape for fixture verification, but the request hook preserves the existing OpenAI Responses/Codex prompt bypass and does not reorder those requests.
- Unknown/custom transports, unsupported wrappers, malformed tools, blank/missing names, any supported tool array with a top-level `cache_control`, and Anthropic arrays containing `defer_loading` are no-ops.
- Compose the returned sorted payload with the existing TTL-order repair, retention safety, prompt-cache-key fallback, routing, and adapter behavior. Never add Anthropic trailing breakpoints.
- For every effective `anthropic-messages` model, validate final cache breakpoints in `tools → system → messages` order and downgrade a visible invalid 5-minute-to-1-hour transition. Preserve legal third-party 1-hour retention unless this exact provider/model previously returned Anthropic's explicit TTL-ordering error in the current process.
- Only inject OpenAI-compatible `prompt_cache_key` fallback for `openai-completions` / `openai-responses` APIs.
- Preserve existing non-empty `prompt_cache_key` / `promptCacheKey` values for unconfigured models.
- For an exact extension-configured omit model, remove both `prompt_cache_key` and `promptCacheKey` after Pi/core and other request mutations, including pre-existing keys.
- Use Pi session id fallback for unconfigured models; do not derive keys from prompt content.
- For virtual routing providers, resolve the upstream model via the routing registry when available.
- For a Pi 0.99+ native virtual selection, `ctx.model` stays virtual. Resolve the physical model from the payload's dispatched model id (`model`, or `modelId` for Bedrock) among credentialed physical models; then sticky branch candidates; then a unique full-catalog match. A shared id resolves only when every candidate has the same request policy, and its lifecycle record is marked identity-ambiguous. Otherwise keep the virtual model so identity-dependent mutations fail closed.
- Retain one credential-blind request-identity lifecycle record even when runtime optimization is disabled, because the always-on Anthropic invalid-TTL repair still requires request-local provider/model attribution.

### `after_provider_response`

- Record only an explicit HTTP 400 field-capability rejection for `prompt_cache_key` / `promptCacheKey` as a process-local exact provider/model category. Value-validation, conditional-usage, and ordinary `bad request` text must not activate it. Do not persist or display the raw error.
- Pi's provider response event has no request id. Correlate request metadata through lifecycle records without overwriting an earlier completed response merely because a later request starts. When multiple outstanding requests use different exact models, a response header is ambiguous and MUST NOT create model-scoped evidence. Mark the lifecycle ambiguous; recover attribution only from exact provider/model metadata on the finalized assistant message. Concurrent requests for the same exact model remain safely attributable.
- Identity-ambiguous native virtual records never create header evidence. Pi's prompt-cache warming replays requests without a `message_end`, so the lifecycle list is capped and drops the oldest completed record first.

- Record model-scoped 400 hints only for applicable prompt-cache-retention failures; the untouched Pi built-in `llama.cpp` compat fingerprint is excluded, while same-id overrides with explicit cache compat remain eligible.
- Record model-scoped 403 hints only for applicable third-party OpenAI-compatible proxy failures (session-affinity headers or OpenAI SDK header/User-Agent diagnostics). The untouched built-in `llama.cpp` fingerprint and custom transports are excluded; provider id alone is not an exemption.
- Detect reasoning-protocol evidence only for a DeepSeek-like `openai-completions` model receiving HTTP 400 evidence that explicitly rejects `thinking` and positively directs the caller to `reasoning_effort`. Evaluate each response header as an independent diagnostic unit, reject negated/disabled `reasoning_effort` guidance, retain only a process-local model key/category, and never persist or display the complete error. Notify that a later `/cache-optimizer fix` review or matching `/cache-optimizer rollback` may be available. Do not write or rollback from this hook.
- Do not send hidden probe requests and do not infer protocol from model name, provider, URL, or `supportsReasoningEffort`.
- Do not log payloads, headers, prompts, or credentials.

### `message_end`

- Before the normal error/aborted stats early return, detect only Anthropic's explicit mixed-TTL ordering error and record a process-local provider/model fallback for the next subsequent request. This is a non-retryable 400 in Pi 0.82.1; do not promise built-in automatic retry. Do not classify generic 400 or prompt-too-long errors.
- Inspect finalized assistant errors for an explicit HTTP 400 unsupported `prompt_cache_key` / `promptCacheKey` signal and record only the exact request-local provider/model category for a later confirmed fix. Status parsing is limited to known HTTP-status fields or status-shaped error prefixes; arbitrary numbers are not treated as HTTP status. If concurrent request correlation is ambiguous and the message has no exact provider/model identity, discard the evidence rather than falling back to the current active model.
- Also inspect finalized assistant errors for the same narrow reasoning-protocol rejection (`thinking` rejected in favor of `reasoning_effort`) and use request-local provider/model identity. Keep only the model-scoped category in process memory; never persist or display the raw error and never auto-edit configuration.
- Assistant message metadata is authoritative for final stats identity. Direct selections prefer the dispatched catalog `message.model` and exact registry metadata over `responseModel`; unknown legacy echoes may consolidate only with a safely correlated request snapshot. Never use current `ctx.model` or shared provider/adapter as alias evidence. Different outstanding models make an unknown echo ambiguous even before response headers arrive; retain its message identity rather than guessing.
- Late direct responses update their own model buckets but publish the currently selected direct model's footer; routed selections keep following physical responses.
- For a native virtual selection, resolve the message's dispatched catalog model (`message.model`) through the registry and use it for adapter tokens, the stats key, and the footer compat marker, so they match the pre-request UX that follows the latest physical response on the session branch.
- Use message-local provider/model/api/usage when available; do not use global route state for final stats.
- Update current-instance stats and recent samples only with numeric counters, then atomically persist the instance-owned shard.
- Before recording a model, re-read global/model reset epochs; an epoch change clears only the affected current-instance counters before the new usage is added.

---

## Naming Conventions

- Keep helper names verb-oriented and explicit: `resolveRouteModel`, `publishStatus`, `restoreCacheStats`, `describeMissing...`.
- Pure helpers that are used by verification scripts should be exported through `__internals_for_tests` rather than made public package API.

---

## Common Mistakes

- Doing final stats attribution from live/global router state or a changed direct selection instead of catalog/message metadata and safely correlated lifecycle records.
- Injecting OpenAI cache keys or affinity headers into custom transports such as `kiro-api`, or implementing the per-model prompt-cache-key opt-out through an unsupported Pi compat field instead of the extension-owned configuration.
- Treating `ctx.model.compat` as the only effective compat source for extension providers; `registerProvider()` model replacement can omit provider/custom-model compat even though exact `models.json` configuration remains authoritative.
- Normalizing Anthropic TTLs by provider/model name instead of validating the effective API and final wire-order payload.
- Treating a provider id alone (including `llama.cpp`) as proof of transport capabilities; prefer Pi's explicit model/compat fingerprint and honor overrides.
- Treating `ctx.model` as the request model under a Pi 0.99+ native virtual selection; its `api` is `pi-virtual` and it carries no transport or compat metadata.
- Writing prompt or payload data to task reports, stats files, logs, or notifications.
- Adding hook behavior that cannot be disabled by the established runtime/env gates.
- Leaving debounced writes, global protocol services, legacy hint globals, or extension-mutated environment values alive after `session_shutdown`.
- Allowing same-instance stats writes to overlap; atomic rename prevents partial files but does not preserve write order.
- Treating `fs.watch` as authoritative or adding an unconditional periodic poll; lifecycle/command refreshes provide eventual correctness without idle I/O.
