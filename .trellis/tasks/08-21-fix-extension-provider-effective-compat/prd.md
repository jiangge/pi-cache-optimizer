# Fix effective compat resolution for extension providers

## Goal

Resolve GitHub Issue #9 without special-casing Opencode-Go: when a Pi extension provider replaces its model list and Pi 0.84.x drops lower-layer `models.json` compat from the runtime model object, Pi Cache Optimizer must resolve the user's effective provider/model/modelOverride configuration consistently, avoid false compat warnings, and ensure an enabled OpenAI completions session-affinity setting actually reaches request headers.

## Confirmed root cause

* Pi's normal built-in/custom model path merges provider compat into the runtime model.
* Pi 0.84.2 `registerProvider()` + extension-owned `models` can replace the model object after the lower config layer, so provider/model compat may be absent from `ctx.model.compat`.
* Pi Cache Optimizer's current `getCompat()` trusts only `model.compat`, despite comments saying it checks both levels.
* Pi's OpenAI completions transport also reads the final model compat, so merely suppressing the warning could claim success while affinity headers remain absent.

## Requirements

* Resolve diagnostic/runtime effective compat with precedence, low to high: `models.json` provider compat, matching custom `models[].compat`, runtime `model.compat`, target `modelOverrides[modelId].compat`.
* Use exact provider and model ids; do not add case-insensitive or fuzzy matching.
* Treat explicit `sendSessionAffinityHeaders: false` as a valid opt-out: no missing warning, no footer marker, no fix suggestion, and no extension-added affinity headers.
* Route startup/model warnings, footer `⚠️ compat`, doctor, compat, fix, low-hit diagnosis, and no-argument command summary through the same effective compat result.
* Add a `before_provider_headers` compatibility bridge only for runtime-enabled, non-official `openai-completions` models whose effective `sendSessionAffinityHeaders` is `true` from a models.json provider/model/modelOverride layer rather than the runtime model layer.
* Match Pi's header semantics: default/openai format adds `x-client-request-id` and `x-session-affinity`, plus `session_id` only for `sessionAffinityFormat: "openai"`; `openrouter` format adds `x-session-id` only.
* Never overwrite an existing request header, regardless of header-name casing.
* Never inject for official OpenAI, `openai-responses`, custom transports, missing session ids, runtime disable, or explicit false.
* Do not persist, display, or log raw session ids or request headers.
* Malformed/missing/unreadable `models.json` must fall back to runtime model compat and never block a hook.
* Preserve the current request payload, routing, adapter selection, cache stats, and `/fix` transaction semantics.

## Tests

* Provider-level true suppresses warning/marker/fix and injects the expected request headers for an extension-style runtime model with missing compat.
* Matching custom-model false overrides provider true; runtime-model true can override lower false; modelOverride false/true remains highest precedence.
* Existing headers are preserved case-insensitively.
* OpenRouter format, official OpenAI, openai-responses, custom API, disabled runtime, missing session id, and malformed config are covered.
* An integration regression uses installed Pi 0.84.2 `ModelRuntime.registerProvider()` to prove provider compat is absent from the runtime model and that the extension bridge still honors it.
* `npm run typecheck`, `npm test`, `npm run check:diff`, `npm run check:pack`, and task context validation pass.

## Acceptance status

* [x] Effective exact provider/model compat precedence and explicit false behavior are implemented.
* [x] Diagnostics and request-header bridge share the effective compat resolver.
* [x] Pi 0.84.2 extension-provider regression and request-header behavior have permanent tests.
* [x] README/spec/privacy documentation is synchronized.
* [x] All required quality checks pass.
* [x] Review follow-ups reject schema-invalid config, preserve Pi nested compat merges, and prevent virtual-router compat inheritance across identities.
* [x] Validator edge cases are checked against installed Pi 0.84.2, routed registry misses recover validated upstream transport metadata without treating official OpenAI as a proxy, and unknown routed endpoints fail closed for both header injection and compat diagnostics, including DeepSeek-specific checks.

## Documentation

Update README.md, README.zh-CN.md, the footer/compat spec, hook guidelines, state-management privacy/config rules, and quality guidance where applicable.

## Out of scope

* Patching Pi's installed files or requiring changes to Opencode-Go.
* Bridging every compat field into Pi transports; this task bridges only the verified session-affinity behavior and uses effective compat for diagnostics.
* Fuzzy provider/model matching or credential/config discovery outside Pi's resolved agent directory.
