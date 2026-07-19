# Cache Adapter Footer Stats Contract

> Single-file Pi extension `extension.ts`. Pi loads this via Jiti at extension activation.

This document captures the executable contract for the footer cache stats
behavior. AI assistants and contributors should treat the rows
below as binding when changing `extension.ts`.

---

## Identity

| Field | Value | Notes |
|---|---|---|
| npm package name | `pi-cache-optimizer` | Renamed from `pi-deepseek-cache-optimizer` in 2.0.0. |
| Status key | `pi-cache-stats` | Passed to `ctx.ui.setStatus(STATUS_KEY, ...)`. Renamed from `deepseek-cache-stats`. |
| Stats file path | `~/.pi/agent/pi-cache-optimizer-stats.json` | Renamed from `~/.pi/agent/deepseek-cache-optimizer-stats.json`. |
| Models JSON path | `~/.pi/agent/models.json` | Reference path for compat warnings; shown as `%USERPROFILE%\.pi\agent\models.json` on Windows via `getModelsJsonDisplayPath()`. |

---

## Adapter selection (id/name only)

Adapter selection MUST consider only the active model `id` and `name`, plus the
assistant message's `model` and `name` fields on `message_end`. It MUST NOT use
`provider` id, `api` type, base URL, `compat.thinkingFormat`, or any other
metadata for selection. Generic OpenAI-compatible proxies are NOT treated as
OpenAI-family just because they use an OpenAI-shaped API.

| Adapter | Detection token (case-insensitive substring on id/name) | Footer label |
|---|---|---|
| DeepSeek | `deepseek` | `DS cache` |
| OpenAI-family (GPT) | `gpt-`, `chatgpt`, or pattern `o[1345]` with safe boundaries | `OpenAI cache` |
| Kimi / Moonshot | `kimi` | `Kimi cache` |
| Qwen / Alibaba | `qwen` | `Qwen cache` |
| GLM / Zhipu | `glm` | `GLM cache` |
| MiniMax | `minimax` | `MiniMax cache` |
| Xiaomi MiMo / Mimo | pattern `mi-?mo` with safe boundaries | `Mimo cache` |
| Hunyuan / Tencent | `hunyuan` | `Hunyuan cache` |
| Mistral | `mistral`, `mixtral`, `codestral` | `Mistral cache` |
| xAI / Grok | `grok`, pattern `xai` with safe boundaries | `Grok cache` |
| Meta / Llama | `llama` | `Llama cache` |
| NVIDIA Nemotron | `nemotron` | `Nemotron cache` |
| Cohere / Command | `cohere`, `command-r` | `Cohere cache` |
| Yi / 零一万物 | `yi-`, `01-ai`, `zero-one`, or pattern `yi` with safe boundaries | `Yi cache` |
| Doubao / ByteDance / Seed | `doubao`, `豆包`, `volcengine`, `bytedance`, `byte-dance`, or pattern `seed` with safe boundaries | `Doubao cache` |
| Baidu ERNIE / Wenxin | `ernie`, `wenxin`, `文心`, `yiyan`, `一言`, `baidu` | `ERNIE cache` |
| Baichuan / 百川 | `baichuan`, `百川` | `Baichuan cache` |
| StepFun / 阶跃星辰 | `stepfun`, `step-` prefix | `StepFun cache` |
| iFlytek Spark / 讯飞星火 | `spark`, `xinghuo`, `星火`, `iflytek`, `讯飞` | `Spark cache` |
| InternLM / 书生 | `internlm`, `intern-lm`, `书生` | `InternLM cache` |
| Google Gemma | `gemma` | `Gemma cache` |
| Microsoft Phi | `phi-` prefix, or pattern `phi` with safe boundaries | `Phi cache` |
| AI21 Jamba | `jamba`, `ai21` | `Jamba cache` |
| Upstage Solar | `solar`, `upstage` | `Solar cache` |
| Perplexity / Sonar | `sonar`, `perplexity`, or pattern `pplx` with safe boundaries | `Sonar cache` |
| Amazon Nova | `amazon-nova`, or pattern `nova` with safe boundaries | `Nova cache` |
| Reka | `reka` | `Reka cache` |
| Falcon / TII | `falcon`, `tiiuae` (not bare `tii`) | `Falcon cache` |
| Databricks DBRX | `dbrx`, `databricks` | `DBRX cache` |
| MosaicML MPT | `mosaicml`, `mpt-` prefix, or pattern `mpt` with safe boundaries | `MPT cache` |
| StableLM / Stability AI | `stablelm`, `stable-lm`, `stability-ai` | `StableLM cache` |
| BAAI / Aquila | `aquila`, `baai` | `Aquila cache` |
| LG EXAONE | `exaone` | `EXAONE cache` |
| Naver HyperCLOVA X | `hyperclova`, `clova-x` (conservative, not bare `clova`/`naver`) | `HyperCLOVA cache` |
| Aleph Alpha Luminous | `luminous`, `aleph-alpha`, or pattern `aleph` with safe boundaries | `Luminous cache` |
| Nous / Hermes / OpenHermes | `nous`, `hermes`, `openhermes` | `Hermes cache` |
| Anthropic / Claude | `anthropic`, `claude` | `Claude cache` |
| Gemini / Vertex | `gemini`, `vertex` | `Gemini cache` |
| IBM Granite | `granite`, `ibm-granite` | `Granite cache` |
| Snowflake Arctic | `snowflake-arctic`, safe-boundary pattern `arctic` | `Arctic cache` |
| Huawei Pangu / 盘古 | `pangu`, `pan-gu`, `盘古`, `huawei-pangu` | `Pangu cache` |
| SenseTime SenseNova / 商汤 | `sensenova`, `sense-nova`, `sensechat`, `商汤` | `SenseNova cache` |
| 360 Zhinao / 智脑 | `360gpt`, `360-gpt`, `zhinao`, `智脑` (no bare `360`) | `Zhinao cache` |
| OpenBMB MiniCPM | `minicpm`, `mini-cpm`, `openbmb` | `MiniCPM cache` |
| XVERSE | `xverse` | `XVERSE cache` |
| OrionStar Orion | `orionstar`, `orion-star`, or safe-boundary pattern `orion` | `Orion cache` |
| OpenChat | `openchat` | `OpenChat cache` |
| Vicuna | `vicuna` | `Vicuna cache` |
| WizardLM / WizardCoder | `wizardlm`, `wizard-lm`, `wizardcoder`, `wizard-coder` | `Wizard cache` |
| Zephyr | `zephyr` | `Zephyr cache` |
| Dolphin | `dolphin` | `Dolphin cache` |
| OpenOrca | `openorca`, `open-orca` | `OpenOrca cache` |
| Starling | `starling` | `Starling cache` |
| BLOOM / BigScience | `bloom`, `bigscience` | `BLOOM cache` |
| RWKV | `rwkv` | `RWKV cache` |
| Cohere Aya | `aya-expanse`, or safe-boundary pattern `aya` (avoid `maya`/`payara`) | `Aya cache` |

If no adapter matches, the footer status MUST be cleared (set to `undefined`).

### Provider transport caveats (do not paper over)

Some pi providers ship as extensions that register a custom `api` id and
own their own request/response transport. Pi's compat-driven cache marker
injection (`cacheControlFormat: "anthropic"`, `cachePoint` insertion in
bedrock-converse-stream, etc.) lives **inside** the openai-completions,
anthropic-messages, and bedrock-converse-stream adapters. Custom-API
extensions are not visited by that compat layer.

When the adapter selection picks an underlying provider whose transport
does not surface cache fields, the footer MUST stay at 0% rather than
being massaged. Do NOT special-case-bump these counters.

#### `kiro-api` (provider `kiro`, package `pi-provider-kiro`)

* Wire identity: assistant messages carry `"provider":"kiro"`,
  `"api":"kiro-api"`. The transport is
  `POST https://q.<region>.amazonaws.com/generateAssistantResponse`
  with header
  `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`
  (the AWS CodeWhisperer / Amazon Q Developer streaming protocol).
* Source-of-truth pointer: `pi-provider-kiro@0.6.1`'s
  `dist/{stream.js,usage.js}` contain zero matches for `cache_control`,
  `cachePoint`, `cache_read_input`, `cacheReadInputTokens`, or
  `cacheCreationInputTokens`. All `cacheRead`/`cacheWrite` references
  are zero-initializers, never assignments from upstream response data.
  The request body's `userInputMessage.content` is a flat string with
  no slot for cache markers.
* Configuration note: a user's `models.json` `"kiro": { ... }` block
  cannot fix this. The package registers `kiro-api` and the custom
  `stream` function; pi's compat flags do not reach that code path.
* Footer behavior: Claude requests on `kiro-api` MUST keep showing 0%
  cache hit rate. This is **truthful and unchangeable from this
  extension's side**. Do NOT add a special-case bump or fake `cacheRead`
  values to make the number look better.
* Warning behavior: the Claude adapter's `warningText` MUST stay silent
  for `kiro-api` (it currently fires only when
  `isOpenAICompatibleApi(model.api)` is true, which `kiro-api` is not).
  The compat warning's purpose is to nudge the user toward flipping a
  flag; on `kiro-api` there is no flag the user can flip, so an
  informational warning would be startup noise. If a future contributor
  proposes adding a Kiro-specific warning, the answer is: don't — the
  decision is recorded here.
* Investigation references:
  `.trellis/tasks/05-17-investigate-kiro-claude-0-cache-hit-rate/`
  (`prd.md` + `research/kiro-cache-passthrough.md`).

### OpenAI-family prompt cache-key fallback

The extension MAY add a top-level `prompt_cache_key` in the
`before_provider_request` hook, but only as a conservative fallback around Pi
core's own cache transport.

* Scope gate: the active model's `api` MUST be an OpenAI-compatible Pi adapter
  (`openai-completions` or `openai-responses`). Unlike the initial implementation,
  the model `id`/`name` no longer needs to match GPT-family tokens — all models
  using an OpenAI-shaped API (including Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan, and
  any future OpenAI-compatible provider) receive the session-id fallback. Custom
  transports such as `kiro-api` remain excluded by the API gate.
* Cache-key source: use `ctx.sessionManager.getSessionId()`, clamped to
  OpenAI's 64-codepoint `prompt_cache_key` limit. Do NOT derive the key from a
  prompt/stable-prefix hash; Pi core uses session id for official OpenAI paths,
  and the extension fallback must match that stability model.
* Existing key preservation: a non-empty string in either `prompt_cache_key`
  or `promptCacheKey` is authoritative and MUST NOT be overwritten. Values that
  are `undefined`, `null`, `""`, or whitespace-only are treated as missing and
  may be replaced by the session-id fallback.
* Opt-out: default behavior is enabled. Users can disable fallback injection
  with `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` (truthy: `1`, `true`, `yes`,
  `on`) or legacy-style `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` (disabled:
  `0`, `false`, `no`, `off`).
* All `before_agent_start` prompt mutations (session-overview churn strip,
  skill compression, stable-prefix reorder) can be disabled persistently with:
  `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` (truthy: `1`, `true`, `yes`, `on`).
  Footer stats and the OpenAI `prompt_cache_key` fallback remain active.
* Runtime `/cache-optimizer disable` is broader but process-local: it disables prompt
  mutations, OpenAI-compatible `prompt_cache_key` fallback, compat warnings, footer
  stat updates, and restores the startup `PI_CACHE_RETENTION` value for the current
  Pi process. `/cache-optimizer enable` re-enables those runtime features and requests
  `PI_CACHE_RETENTION=long` again. `/reload` or process restart returns to startup behavior.
* Official OpenAI Responses / Codex prompt bypass remains unchanged: the
  `before_agent_start` hook still avoids prompt rewriting for
  `openai-codex-responses` and `openai-responses`.

#### Third-party OpenAI-compatible proxy compat warning

For models using `api: "openai-completions"` through a non-official
base URL (not `api.openai.com`), warn/mark missing compat only when merged compat
has no `sendSessionAffinityHeaders` value (`undefined`). An explicit
`sendSessionAffinityHeaders: false` is a valid safe opt-out for proxies/CDNs/WAFs
that block Pi's custom affinity headers with HTTP 403, and MUST NOT keep
`⚠️ compat` active or make `/cache-optimizer fix` write `true` again. The
copyable JSON suggestion MUST be conservative: recommend
`sendSessionAffinityHeaders: true` by default when missing, but do NOT recommend
`supportsLongCacheRetention: true` as an automatic
safe default. Long retention is optional advisory text only; it must not keep
`⚠️ compat` active or make `/cache-optimizer fix` report unresolved work after
session affinity has been fixed. It may be mentioned as optional guidance only
when the endpoint/proxy explicitly supports OpenAI `prompt_cache_retention`.

If a third-party proxy returns `400 Unsupported parameter: prompt_cache_retention`,
the user should remove/avoid `supportsLongCacheRetention` for that channel while
keeping `sendSessionAffinityHeaders` if supported. This extension does not write
`prompt_cache_retention` directly; it requests `PI_CACHE_RETENTION=long`, and Pi
may send the parameter when compat says long retention is supported.

This warning is advisory only and MUST NOT mutate the user's `models.json`.

#### DeepSeek Pi Mono compat warning

For DeepSeek-like models using an OpenAI-compatible Pi API
(`openai-completions` or `openai-responses`), warn once per model when merged
compat lacks DeepSeek-specific reasoning/cache fields. The missing-list logic is
adapter-aware and MUST include:

* `supportsLongCacheRetention: true` when absent.
* `sendSessionAffinityHeaders: true` for `openai-completions` when absent.
* For `openai-responses`, Pi 0.80.7+ uses `sessionAffinityFormat` (`openai`, `openai-nosession`, or `openrouter`) and auto-detects the default. The extension MUST NOT diagnose or write the removed `sendSessionIdHeader` field.
* `requiresReasoningContentOnAssistantMessages: true` when absent.
* `thinkingFormat: "deepseek"` when absent or different.

The copyable DeepSeek JSON suggestion MAY include all missing fields above. This
is different from the generic third-party OpenAI-compatible proxy advice:
DeepSeek's Pi Mono guidance explicitly requires the `reasoning_content` replay
compat and DeepSeek thinking format. The warning remains advisory only and MUST
NOT mutate `models.json`.

### Platform-friendly models.json path

The helper `getModelsJsonDisplayPath(platform?)` returns a user-facing path
string for `models.json`, adapted to the user's platform:

| Platform | Returns |
|----------|---------|
| Windows (`win32`, `win64`, etc.) | `%USERPROFILE%\\.pi\\agent\\models.json` |
| Linux, macOS, others | `~/.pi/agent/models.json` |

This is used in all user-facing compat warning texts, `/cache-optimizer doctor`,
`/cache-optimizer compat`, and README documentation so users on any platform
see a copyable path they recognize. The string is never used for I/O — actual
path resolution is handled by Pi via Node `os.homedir()`.
It exists because many third-party OpenAI-compatible proxies fan out to multiple
upstream instances; a body `prompt_cache_key` alone may not keep requests on the
same cache-bearing backend unless the proxy also honors session-affinity headers.

---

## Persisted stats schema (v6: restart-persistent model totals + session buckets)

Footer stats are displayed from provider/model totals that persist across Pi
process/terminal restarts. Session-scoped buckets are still persisted for
migration, reset/reload compatibility, and exact router restore metadata.
Adapter selection remains id/name-only; the active model's `provider` participates
only after adapter selection, as part of the stats bucket key.

```ts
type CacheProviderId = "deepseek" | "openai" | "claude" | "gemini";

type CacheStats = {
  day: string; // local YYYY-MM-DD
  totalRequests: number;
  hitRequests: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
};

type PersistedRoutedModelRef = {
  provider: string;
  id: string;
  name?: string;
};

type PersistedCacheStatsV6 = {
  version: 6;
  sessions: Record<string, Record<string, CacheStats>>; // sessionHash → modelKey → stats
  totalsByModel: Record<string, CacheStats>; // modelKey → restart-persistent footer totals
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
  lastRoutedModelBySession?: Record<string, PersistedRoutedModelRef>; // sessionHash → last real upstream model used while active model was router/auto
};
```

* `CacheStats` counters MUST be non-negative integers; `hitRequests <=
  totalRequests`; `cachedInputTokens <= totalInputTokens`;
  `cacheWriteInputTokens <= totalInputTokens`.
* `sessions` groups stats by an opaque session hash (SHA-256 hex prefix, 16 chars),
  computed from `ctx.sessionManager.getSessionId()`. Raw session ids are never
  persisted, logged, or displayed.
* Within each session, the inner map key is `${provider}/${id}` (same format as
  v3 `statsByModel`), separating e.g. `otokapi/gpt-5.5` from `cafecode/gpt-5.5`.
* `totalsByModel` is the authoritative footer/display bucket. It is keyed by the
  same `${provider}/${id}` model key but intentionally not by session hash so the
  same provider/model continues showing today's counters after a terminal/process
  restart.
* `legacyFamily` exists only as a migration/fallback bucket for pre-v4/v5 data
  and rare `message_end` updates where no active model is available. New normal
  updates MUST write both to the current session's bucket and to `totalsByModel`.
* `lastRoutedModelBySession` persists the exact last real upstream model seen
  while the active model was a router channel (for example `router/auto`). This
  lets `/reload` restore the footer for the exact last routed model instead of a
  best-effort "largest stats bucket" guess.
* In-memory session storage uses keys of the form
  `${sessionHash}:${provider}/${id}` for O(1) current-session lookup. The display
  helper `modelKeyFromSessionKey` strips the hash prefix for user-facing output.
  In-memory `totalsByModel[provider/id]` is used for footer, doctor, and stats
  command counters.
* The persisted file MUST contain only counters and local dates. Never persist
  API keys, prompts, request payloads, response bodies, HTTP headers, model
  outputs, or provider config snapshots.
* Writes MUST remain atomic: write a temp file then `rename` into
  `~/.pi/agent/pi-cache-optimizer-stats.json`; never update the JSON in place.
* Concurrent writes are best-effort only. Before writing, the extension re-reads
  the persisted file and preserves other session buckets it can see, but there
  is **no inter-process lock**. If two Pi processes write at the same time,
  last-writer-wins can still lose a concurrent update. Do not document or test
  stronger durability than best-effort sequential preservation.

### Session buckets and restart continuity

* Each Pi process (session) has a unique `sessionId` from `ctx.sessionManager.getSessionId()`.
* The session id is hashed with SHA-256 (first 16 hex chars) to produce a non-reversible
  scope key. The hash is used to key persisted entries in the `sessions` map.
* Different Pi sessions using the same provider/model keep separate session buckets,
  but share the same `totalsByModel[provider/id]` display counter.
* The same Pi session using the same provider/model shares one session bucket across
  turns and survives `/reload` (same session id, same hash).
* A new Pi process/terminal has a new session hash, but the footer MUST restore the
  same provider/model's `totalsByModel` counter instead of starting at 0/0.
* `/cache-optimizer reset` clears the visible provider/model total and in-memory
  matching session buckets for the active model, so stale old session buckets do
  not resurrect footer counters after restart.

### Stats migration (v6)

| Input state | Behavior |
|---|---|
| `version: 6` | Parse valid `sessions`, authoritative `totalsByModel`, `legacyFamily`, and `lastRoutedModelBySession`. If `totalsByModel` is missing/malformed, derive totals from session buckets as a safety fallback. |
| `version: 5` | Parse valid `sessions`, `legacyFamily`, and `lastRoutedModelBySession`; derive `totalsByModel` by aggregating same-day stats across session buckets by `${provider}/${id}`. The next persist writes v6. |
| `version: 4` | Parse valid `sessions` and `legacyFamily`; derive `totalsByModel`; start with no exact router metadata. The next persist writes v6. |
| `version: 3` | Migrate `statsByModel` entries and derive `totalsByModel`. Legacy model keys without session context are treated as current-session data when restored. |
| `version: 2` with `statsByProvider` | Migrate valid family buckets to `legacyFamily`; start with empty session stats and empty totals. |
| `version: 1` single DeepSeek stats | Migrate valid stats to `legacyFamily.deepseek`; start with empty session stats and empty totals. |
| Unknown version / invalid top-level shape | Treat as unreadable stats and fall back to empty in-memory state. |

### Migration on first run after rename

| Condition | Behavior |
|---|---|
| New path readable (v6) | Parse `sessions[sessionHash]` for current session data; load authoritative `totalsByModel`, `legacyFamily`, and exact `lastRoutedModelBySession[sessionHash]` when present. |
| New path readable (v5) | Parse `sessions[sessionHash]` for current session data; derive `totalsByModel`; load `legacyFamily` and exact `lastRoutedModelBySession[sessionHash]` when present; write v6 on next persist. |
| New path readable (v4) | Parse `sessions[sessionHash]` for current session data; derive `totalsByModel`; load `legacyFamily`; start with no exact router metadata; write v6 on next persist. |
| New path readable (v3) | Migrate `statsByModel` to current session hash; derive `totalsByModel`; write v6 on next persist. |
| New path missing AND old path readable | Parse old path (v1/v2/v3/v4), write the v6 shape to the new path atomically, best-effort `unlink` old path. |
| New path missing AND old path also missing | Initialize empty session stats and `legacyFamily` in memory. |
| New path readable but corrupt JSON | Log a one-line warning, fall back to empty counters; do NOT delete. |
| Old path corrupt | Log a one-line warning, do NOT delete the old file, do NOT write from corrupt data. |

### Transitional `_nosession` bucket

The `_nosession` session key is a transitional legacy migration mechanism that exists
purely for backward compatibility when upgrading from v3 (no session isolation) to v4
(session-scoped stats). It is NOT a real session hash.

**Creation**: `writePersistedCacheStats` creates or preserves `_nosession` entries when
called *without* a `currentSessionHash` (i.e., the first time the extension runs before
the Pi session id is known, or during migration from a legacy file). Keys that lack a
hash prefix (`hash:provider/id`) are grouped under `_nosession` so that
`restoreCacheStats` can migrate them to the current session on the next load.

**Consumption / removal**: Once `writePersistedCacheStats` is called *with* an
authoritative `currentSessionHash` (after the session id is set), the `_nosession`
bucket is deleted from the serialized sessions map. The entries have already been
consumed and migrated into memory by `restoreCacheStats` on load; keeping `_nosession`
on disk would allow resurrection of reset stats on the next reload (the "reset-undo" bug).
A reset that deletes the only current-session model entry MUST still persist in
explicit current-session mode, writing an empty `sessions[currentSessionHash]` map
and removing `_nosession`.

### Display and update semantics

* `modelKey(model)` is exactly `${model.provider}/${model.id}` for user-facing display
  and for the restart-persistent `totalsByModel` key. The session lookup key is
  `${sessionHash}:${provider}/${id}`.
* `session_start` (not reload): read the persisted v6 file, load
  `sessions[currentSessionHash]` entries into the in-memory session table, load
  `totalsByModel` for footer display, and restore
  `lastRoutedModelBySession[currentSessionHash]` when present. Legacy v3 keys
  without session context are migrated by prefixing with the current session hash
  and are also included in derived totals.
* `session_start` (reload): preserve current-session buckets by re-reading the
  persisted v6 file for the current `sessionHash` (same Pi session id), filtering
  to `sessions[currentSessionHash]`, loading `totalsByModel`, and restoring the
  exact last routed model for that session when present. Clear only transient
  state (recent samples, integrity notification) and republish footer.
* `model_select` and `session_start` publish status for the selected/current model.
  If the model matches an adapter but has no total entry yet, display an empty
  same-day footer (`0/0`, `0M/0M`).
* `message_end` updates both `statsByModel[sessionHash:provider/id]` and
  `totalsByModel[provider/id]` for the active model. It falls back to
  `legacyFamily[adapter.id]` only when no model identity is available.
  Assistant message metadata (`provider`, `model`/`responseModel`, `api`) is
  authoritative for final stats identity — this keeps virtual routing providers
  correct (the active model may be a router shell while the message carries the
  real upstream model). For **direct (non-virtual-routing) providers**, however,
  some OpenAI-compatible APIs normalize or rename the model id echoed in the
  response (e.g. a request to `zai-org/GLM-5.2-FP8` returns a message whose
  `model` field is `GLM5.2-FP8` or `glm-5.2`). Writing stats under the echoed
  name fragments the bucket away from the active-model key the footer reads
  (`totalsByModel[ctx.model]`), so the footer shows 0% even when the backend is
  hitting cache. To prevent this, `message_end` consolidates stats back to the
  active model identity when the response-derived model drifts from the active
  model **only in name**: same provider, same cache adapter object, but a
  different id. The consolidation (`consolidateDirectProviderStatsModel`) runs
  after `modelFromAssistantMessage` and never merges across providers or across
  adapters, so genuinely different models are never combined. Virtual routing
  providers are excluded — their message-local identity always wins.
* Footer text remains provider-family labelled. The counters shown are the
  local provider/model totals for the current day, not only the current process
  session bucket.
* Local day rollover resets stale entries in session-stats, `totalsByModel`, and
  `legacyFamily`.
* Debounced persistence is allowed for ordinary `message_end` writes; reload, reset,
  and day rollover MUST flush/persist immediately.

---

## Validation matrix

| Scenario | Expected behavior |
|---|---|
| `prompt_cache_key` fallback disabled (`PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` or `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0`) | No extension-added `prompt_cache_key`; Pi core behavior remains authoritative. |
| All `before_agent_start` prompt mutations disabled (`PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1`) | No churn strip, skill compression, or stable-prefix reorder; footer stats and `prompt_cache_key` injection unchanged. |
| `openai-completions`/`openai-responses` payload (any model) has no effective key | Extension adds `prompt_cache_key` from `ctx.sessionManager.getSessionId()` if a non-empty session id is available. |
| Payload has non-empty `prompt_cache_key` or `promptCacheKey` | Extension does not replace it. |
| Payload has `prompt_cache_key: undefined`, `null`, `""`, or whitespace | Treat as missing; extension may add the session-id fallback. |
| Model id/name looks GPT-like or Kimi/Qwen/GLM/MiniMax/Mimo/Hunyuan-like but API is a custom transport (e.g. `kiro-api`) | Do not add OpenAI `prompt_cache_key`; do not assume compat layers reach custom transports. |
| Third-party `openai-completions` proxy (GPT, Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan, etc.) missing cache/session-affinity compat | Warn once per model with a copyable `compat` suggestion; do not edit `models.json`. |
| DeepSeek-like `openai-completions` model missing Pi Mono reasoning compat | Warn once; `/cache-optimizer doctor` and `/cache-optimizer compat` include copyable JSON with `requiresReasoningContentOnAssistantMessages: true` and `thinkingFormat: "deepseek"` plus any missing cache/session-affinity flags; do not edit `models.json`. |
| DeepSeek-like `openai-responses` model on Pi 0.80.7+ | Diagnose DeepSeek reasoning/retention compat only; do not suggest the removed `sendSessionIdHeader`. Pi owns response session-affinity header selection through `sessionAffinityFormat` and its auto-detected default. |
| Old stats path exists, new stats path missing | Read old v1/v2/v3 data, write the new path atomically in v6 shape, best-effort `unlink` old. v2 `statsByProvider` data moves to `legacyFamily`; v3 unscoped model keys are assigned to the current session and totals are derived. |
| New v2 stats file exists | Load v2 `statsByProvider` into `legacyFamily`; start with empty session stats/totals; next write persists v6. |
| New v3 stats file has entries for `otokapi/gpt-5.5` and `cafecode/gpt-5.5` | Migrate both unscoped keys into the current session hash and derive separate provider/model totals, even though both use the OpenAI-family footer label. |
| Selected matching model has no provider/model total yet | Display empty same-day stats (`0/0`, `0M/0M`) instead of legacy family aggregate counters. |
| `/reload` session_start reason | Re-read persisted v6 data for the same current session hash plus restart-persistent totals, clear only transient state (recent samples, integrity notifications), and re-publish footer with current provider/model totals. |
| Active model is `router/auto`, persisted exact last routed model exists, and another bucket has more total requests | `/reload` restores the footer for the exact persisted last routed model, not the largest stats bucket. |
| Active model is `router/auto`, exact last routed model exists but its provider/model total was reset/removed | `/reload` still restores that exact model's footer label with empty same-day stats (`0/0`, `0M/0M`). |
| Active model is a virtual routing provider registered under `Symbol.for("pi.routing.registry.v1")` | Footer, doctor, compat, prompt-cache-key fallback, and reset resolve the live upstream provider/model when the registry returns a valid route snapshot. |
| A virtual routing provider relays assistant message `provider` + `model`/`responseModel` + `api` metadata | `message_end` stats use the message-local upstream identity, even if the active model is a router shell or the live registry has changed. |
| Direct (non-virtual-routing) provider echoes a different/renamed model id in its response (e.g. request `zai-org/GLM-5.2-FP8` but message carries `GLM5.2-FP8`), same provider + same adapter | `message_end` consolidates stats to the active-model id (`ctx.model.id`); the footer shows the merged real hit rate instead of a fragmented 0% bucket. |
| Direct provider echoes a model id that maps to a DIFFERENT adapter (e.g. `gpt-5.5` while active is a GLM model), or a different provider | No consolidation — stats stay under the response identity so genuinely different models are never merged. |
| A router extension queries `Symbol.for("pi.cache.hints.v1")` while optimizer is enabled | Returns query-scoped optimized system prompt / prompt cache key / long-retention hint only when the query matches the latest session/route hint; existing request-level keys still remain authoritative. |
| Non-GPT OpenAI-compatible model (Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan, Mistral, Grok, Llama, Nemotron, Cohere, Yi) with `openai-completions` API | Selected adapter shows the corresponding footer label; compat warning fires for non-official base URLs missing cache/session-affinity flags. |
| Model id/name contains both GPT-family and non-GPT tokens (e.g. `kimi-gpt-4`) | GPT adapter takes precedence (earlier in `CACHE_PROVIDER_ADAPTERS`). Footer shows `OpenAI cache`, stats are still keyed by provider/model. |
| Different Pi sessions with same provider/model | Session bucket keys differ by hash, but footer totals are shared by provider/model and survive terminal/process restart. |
| Same Pi session, same provider/model | Same session hash → same session bucket; `totalsByModel` counters accumulate for footer display. |
| `/cache-optimizer reset` on active model | Delete the visible provider/model total and matching in-memory session entries; clear recent samples for that model; persist immediately; publish footer showing 0/0. |
| `/cache-optimizer reset` with no active model | Warning: "No active model selected". |
| `/cache-optimizer reset` on non-adapter-matched model | Friendly message: "Active model does not match a cache adapter. No stats to reset." |
| `/cache-optimizer reset` only targets one model | Other provider/model totals remain unaffected. Old session buckets may remain for migration/audit compatibility, but the authoritative total for the reset model is removed. |
| `/reload` or process restart after `/cache-optimizer reset` | The provider/model total remains reset; transient state stays cleared; no `_nosession`, legacy v3 bucket, or old session bucket resurrects the deleted footer stats. |
| New v4 stats file contains `_nosession` | Restore migrates `_nosession:<provider>/<model>` entries into the current session hash. The first explicit current-session write removes `_nosession` from disk. |
| Concurrent Pi processes write stats | Each write preserves other session buckets visible at its pre-write read, but there is no inter-process locking guarantee; concurrent last-writer-wins races are possible and accepted. |
| Local day changes | Reset every stale session-scoped stats entry, `totalsByModel` entry, and `legacyFamily` entry to empty current-day stats before publishing/updating, and persist immediately. |
| New stats path corrupt | Log warning, fall back to empty in-memory counters; do not delete. Next valid write may replace it atomically. |

---

### Good / Base / Bad cases for v6 restart-persistent model totals

* **Good**: Same Pi session + same provider/model uses one internal session key
  (`${sessionHash}:${provider}/${id}`) and one visible total key
  (`${provider}/${id}`). It accumulates counters across turns, survives `/reload`,
  and continues after terminal/process restart.
* **Good**: `/cache-optimizer reset` clears the visible total for the active
  provider/model and matching in-memory session entries; a subsequent `/reload`
  or process restart still shows 0/0 for that provider/model.
* **Base**: A v3/v4/v5 file without `totalsByModel` derives totals once from valid
  session/model buckets and writes v6 on the next persist. A v6 file with an empty
  `totalsByModel` is authoritative and MUST NOT re-derive reset stats from old
  session buckets.
* **Good**: When the active model is a router channel, the exact last real
  upstream model is persisted under `lastRoutedModelBySession[currentSessionHash]`
  for same-session reload, while footer counters come from the upstream
  `totalsByModel[provider/id]` when available.
* **Base**: v2/v1 family-level stats migrate only into `legacyFamily`; a matched
  but unseen provider/model total still displays `0/0` instead of inheriting old
  family totals.
* **Bad**: Persisting raw Pi session ids, displaying session hashes to the user,
  aggregating normal updates into provider-family buckets, re-deriving v6 reset
  stats from old session buckets when `totalsByModel` is empty, preserving
  `_nosession` after a current-session write, or claiming inter-process locking
  semantics that the atomic rename writer does not provide.

### Wrong vs correct: v6 stats persistence

#### Wrong

```ts
// Raw session id is persisted and reset writes without the authoritative hash,
// so `_nosession` can survive and resurrect deleted stats after /reload.
const rawSessionId = ctx.sessionManager.getSessionId();
payload.sessions[rawSessionId] = { [modelKey(model)]: stats };
delete state.statsByModel[`${sessionHash}:${modelKey(model)}`];
await writePersistedCacheStats(state);
```

#### Correct

```ts
// Persist only opaque session hashes, and keep the visible footer counter in
// totalsByModel. Reset removes the authoritative provider/model total so old
// session buckets cannot resurrect the footer after restart.
const sessionHash = hashSessionId(ctx.sessionManager.getSessionId());
delete state.statsByModel[`${sessionHash}:${modelKey(model)}`];
delete state.totalsByModel[modelKey(model)];
await writePersistedCacheStats(state, sessionHash);
```

---

## Tests required for footer stats changes

When modifying cache stats, migration, rollover, or footer behavior, add/update a
task-level verification script that asserts:

* v6 parse/round-trip preserves valid `sessions[sessionHash][provider/model]`,
  authoritative `totalsByModel`, `legacyFamily`, and `lastRoutedModelBySession`,
  and drops malformed entries without throwing.
* v5/v4 parse/migration preserves valid `sessions[sessionHash][provider/model]`
  entries plus `legacyFamily`, derives `totalsByModel`, starts with no exact
  router metadata for v4, and writes v6 on the next persist.
* v3 parse/migration assigns valid unscoped `statsByModel` entries to the
  current session hash on restore while preserving `legacyFamily`; malformed
  entries are dropped without throwing.
* v2 `statsByProvider` migrates to `legacyFamily` with empty session stats; v1
  migrates only to `legacyFamily.deepseek`.
* `message_end` with an active model updates both the session-scoped model key
  and `totalsByModel[provider/id]`; selecting a different provider with the same
  model id does not show or mutate the first provider's counters.
* A matched-but-unseen model displays empty current-day stats rather than migrated
  family aggregate data.
* Different session hashes for the same provider/model produce different internal
  session keys while sharing the same visible `totalsByModel` counter.
* Same session hash + same provider/model produces the same internal key.
* `/reload` preserves session-scoped stats and restart-persistent totals by
  re-reading persistence and only clears transient state (recent samples,
  integrity notification).
* When the active model is a router channel, exact persisted
  `lastRoutedModelBySession[currentSessionHash]` metadata restores the footer
  for the exact last routed provider/model, not merely the largest stats bucket.
* `/cache-optimizer reset` clears the active model's visible `totalsByModel`
  entry plus matching in-memory session entries and recent samples, persists
  immediately, and shows 0/0.
* `_nosession` / old-session reset-resurrection regression: after legacy/no-session
  data is migrated, resetting the active model and then `/reload` or process
  restart MUST NOT resurrect the deleted footer stats; persisted v6 output must
  not retain `_nosession`, and an empty/missing `totalsByModel[provider/id]` is
  authoritative over old session buckets.
* Sequential write preservation: a write for the current session preserves other
  existing session buckets visible in the persisted file, while tests must not
  assume inter-process locking or serializable concurrent writes.
* Direct-provider response model name drift: when a direct (non-virtual-routing)
  provider echoes a different/renamed model id in its response but the response
  model shares the active model's provider and cache adapter object, stats are
  consolidated onto the active-model id; a drifted id mapping to a different
  adapter or a different provider is NOT consolidated; virtual routing
  providers are never consolidated (message-local identity wins).
* `/cache-optimizer reset` on a model not matching an adapter shows a friendly
  no-op message.
* Local-day rollover resets session-scoped stats, `totalsByModel`, and `legacyFamily` entries.
* DeepSeek-like OpenAI-compatible models missing Pi Mono compat report
  `requiresReasoningContentOnAssistantMessages` and `thinkingFormat` alongside
  cache/session-affinity flags; doctor/compat output includes copyable JSON and
  does not expose secrets, prompts, payloads, headers, or model output.
* Existing validation still passes: unsupported models clear the footer, corrupt
  stats fall back safely, and atomic write / `npm pack --dry-run` / `git diff
  --check` remain green.
* New adapters for Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan, Mistral, Grok/xAI, Llama, Nemotron, Cohere, Yi: each detection function
  returns correct results for id/name matches and non-matches, assistant message
  matching is role-gated, and compat warnings use the broadened
  `describeMissingOpenAICompatibleProxyCompat`.
* 403 session-affinity header detection: `isSessionAffinity403Applicable` returns true only for `openai-completions` with merged compat `sendSessionAffinityHeaders === true`; returns false for Pi 0.80.7+ `openai-responses` (which uses `sessionAffinityFormat` instead), custom transports (`kiro-api`, `anthropic-messages`), and merged `false`/missing values. Explicit `sendSessionAffinityHeaders: false` is accepted as a safe opt-out and must not keep `⚠️ compat` active or make `/cache-optimizer fix` suggest `true`; the `after_provider_response` 403 path records a one-time model-scoped warning and surfaces it in doctor/fix. `isOpenAISdkHeader403Applicable` returns true for third-party `openai-completions` proxies after session affinity is disabled/absent, records a read-only OpenAI SDK User-Agent / `X-Stainless-*` WAF diagnostic, and must not add an auto-fix path; existing 400 `prompt_cache_retention` behavior and all prior verify scripts remain green.

---

## System prompt reordering invariants

`extension.ts` exposes `optimizeSystemPrompt(original, opts)` which is invoked
from the `before_agent_start` hook to lift stable content above dynamic
content. The reorder uses `rest.replace(part, "")` per accepted candidate
from `buildStableCandidates(opts)`. Because `String.prototype.replace`
matches the FIRST occurrence of `part` anywhere in `rest`, short or
character-class candidates can rip arbitrary unrelated text out of the
dynamic remainder — corrupting the prompt and destabilizing provider
prefix caches across requests.

### Hard contracts

* The candidate filter MUST drop any trimmed candidate shorter than
  `MIN_STABLE_CANDIDATE_LENGTH` (currently `8`). That threshold is
  intentionally larger than every short bullet form pi may emit (`- X` is
  3 chars, `- ab` is 4, etc.) so single-character or two-character noise
  cannot become a `replace()` target.
* The threshold is a CACHE-CORRECTNESS contract, not a UX preference.
  Lowering it must be paired with a different mangle-resistant strategy
  (e.g. structural lift instead of `replace`-based extraction). Do not
  weaken the threshold without that.
* The reorder MUST remain idempotent: identical `(original, opts)` MUST
  produce byte-identical `(systemPrompt, stablePrefix)`. No timestamps,
  random salts, or iteration order that depends on `Map`/`Set` insertion
  order driven by external data.
* `buildStableCandidates` MAY return strings that the optimizer then
  rejects (it is a pure shaper). The defensive filter MUST live inside
  `optimizeSystemPrompt`, not inside `buildStableCandidates`, so that the
  rejection rationale stays close to the `replace()` call site.

### Common mistake: upstream string-vs-array regression in tool registrations

**Symptom**: Pi's emitted system prompt contains long runs of single-character
bullets such as:

```
- S
- u
- b
- -
- a
- g
- e
- n
- t
```

**Cause**: A pi extension registers a tool with `promptGuidelines` set to a
*string* instead of `string[]`. Pi's `_normalizePromptGuidelines`
(`@earendil-works/pi-coding-agent/dist/core/agent-session.js`) does
`for (const g of guidelines) { ... }`, which iterates a string
character-by-character. Each unique character becomes its own guideline.

**Observed at**: `@mindfoldhq/trellis` 0.5.16 (latest stable as of 2026-05-17)
and 0.6.0-beta.17 — file `src/templates/pi/extensions/trellis/index.ts`,
`subagent` tool registration. Tracked locally in
`.pi/extensions/trellis/index.ts` with a `LOCAL PATCH` comment until
upstream ships the fix.

**Fix at the source** (in the offending tool registration):

```ts
// Wrong
pi.registerTool?.({
  name: "subagent",
  promptGuidelines: SUBAGENT_DISPATCH_PROTOCOL, // string — iterated char by char
});

// Correct
pi.registerTool?.({
  name: "subagent",
  promptGuidelines: [SUBAGENT_DISPATCH_PROTOCOL], // string[]
});
```

**Defense in this extension**: even when pi feeds us such a polluted
`promptGuidelines` array, `optimizeSystemPrompt` MUST NOT lift the
resulting `- X` bullets into the stable prefix or use them as `replace()`
targets. The `MIN_STABLE_CANDIDATE_LENGTH = 8` filter handles this; the
verification harness in any task that touches this code path SHOULD
include a test that mirrors the regression (build candidates that include
single-character entries, assert the dynamic remainder is byte-equivalent
to a control run with the noise pre-filtered).

---

## Routing-provider protocol

Virtual routing extensions are supported through optional versioned global symbols, not package imports.

### 1. Scope / Trigger

* Trigger: active Pi model is a virtual provider (for example a router/profile model) that forwards to a real upstream provider/model.
* Applies to footer stats, `/cache-optimizer doctor`, `/cache-optimizer compat`, `/cache-optimizer reset`, OpenAI-compatible `prompt_cache_key` fallback, and router prompt/cache hint passthrough.

### 2. Signatures

```ts
const PI_ROUTING_REGISTRY = Symbol.for("pi.routing.registry.v1");
const PI_CACHE_HINTS = Symbol.for("pi.cache.hints.v1");

type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute(
    virtualModelId: string,
    hint?: { sessionIdHash?: string; requestId?: string },
  ): PiRouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): PiRouteSnapshot[];
  subscribe?(listener: (event: PiRouteSnapshot) => void): () => void;
};

type PiRoutingRegistryV1 = {
  version: 1;
  registerRouter(adapter: PiRouterAdapterV1): () => void;
  getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined;
};

type PiCacheHintsV1 = {
  version: 1;
  getHints(input: {
    sessionIdHash?: string;
    virtualProvider?: string;
    virtualModelId?: string;
    upstreamProvider?: string;
    upstreamModelId?: string;
    api?: string;
  }): {
    systemPrompt?: string;
    promptCacheKey?: string;
    cacheRetention?: "long";
  } | undefined;
};
```

### 3. Contracts

* `message_end` MUST prefer assistant message metadata (`provider`, `model` / `responseModel`, `api`) for final stats identity. This request-local metadata is authoritative and prevents global-route races.
* Live registry data MAY be used for pre-message UX: footer display, doctor, compat, reset, and prompt-cache-key fallback. It MUST NOT override final message metadata.
* `pi-cache-optimizer` MUST NOT import router packages or read router-specific config files. Routers MUST NOT import this package; both sides use optional symbol discovery.
* When resolving a route snapshot, first look up the full Pi model in `ctx.modelRegistry.find(provider, modelId)` / available model lists so `api`, `baseUrl`, and merged `compat` are preserved. Use snapshot fields only as fallback.
* The cache hints service MUST be query-scoped and disabled when runtime optimizer or prompt rewrite is disabled. It MUST NOT overwrite an existing request-level `prompt_cache_key` / `promptCacheKey`.
* Temporary legacy globals such as `__piCacheOptimizerRouter` are migration shims only; new integrations should use the versioned symbols.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| No routing registry / no router for provider | Fall back to current direct-model behavior. |
| Router adapter throws or returns malformed snapshot | Log warning, ignore the snapshot, do not crash. |
| Snapshot lacks provider or model id | Treat as absent. |
| Registry resolves a model missing from `modelRegistry` | Build a minimal fallback model from snapshot fields; stats remain id/name-token based. |
| Active route changes before `message_end` | Final stats still follow assistant message metadata. |
| Cache hints query does not match latest session/route | Return `undefined`. |

### 5. Good/Base/Bad Cases

* Good: `router/deepseek-v4-pro` resolves to `deepseek/deepseek-v4-pro`; doctor/compat/reset operate on the DeepSeek model and footer uses the DeepSeek stats bucket.
* Good: A completed message from a router carries `provider: "anthropic"`, `responseModel: "claude-opus-4-8"`; stats update `anthropic/claude-opus-4-8` even if the live registry now points elsewhere.
* Base: A simple router that relays message metadata but does not register a live route still gets correct final stats after the response.
* Bad: Selecting adapter/stats identity from route display names such as "Smart Route" or from provider id alone.
* Bad: Publishing the full system prompt in unscoped legacy globals or duplicating the system prompt in forwarded context.

### 6. Tests Required

* Verify registry install/register/unregister and route snapshot parsing.
* Verify live route resolution uses `ctx.modelRegistry` to preserve upstream `api`, `baseUrl`, and `compat`.
* Verify `selectAdapterForAssistantMessage` uses assistant metadata for routed messages.
* Verify exact router footer restore still returns the last persisted upstream model, not the largest bucket.
* Verify cache hints are query-scoped and existing request keys are preserved.
* Verify legacy global shim support, if retained.

### 7. Wrong vs Correct

#### Wrong

```ts
// Global singleton route races with concurrent sessions and may be stale by message_end.
const route = globalThis.__piCacheOptimizerRouter.current;
const statsKey = `${route.provider}/${route.modelId}`;
```

#### Correct

```ts
// Use live route only for pre-response UX; final stats come from message metadata.
const live = getRoutingRegistry()?.getRouter(ctx.model.provider)?.resolveActiveRoute(ctx.model.id);
const responseModel = modelFromAssistantMessage(event.message, ctx.model);
const statsKey = `${responseModel.provider}/${responseModel.id}`;
```

---

## Forbidden patterns

* Writing `models.json` outside `/cache-optimizer fix`'s explicit preview + confirmation flow. The fix flow may create a timestamped backup and atomically replace `models.json`. For providers/models that already have entries in `models.json`, it only inserts/repairs safe `compat` keys or a missing `compat` object. For API-logged-in providers (e.g. opencode go) that have no `models.json` entry, it MAY offer to create a minimal entry (provider + model + compat only) with UI confirmation, backup, and atomic write; it MUST NOT create API keys, credentials, or router slugs under any scenario.
* Reading or logging the value of `DEEPSEEK_API_KEY` (or any other API key env var).
* Storing prompts, request payloads, response bodies, or HTTP headers in any
  on-disk file produced by this extension.
* Injecting OpenAI `prompt_cache_key` into non-OpenAI-compatible custom APIs.
* Deriving OpenAI `prompt_cache_key` from prompt content or stable-prefix hashes; use the Pi session id fallback instead.
* Overwriting a non-empty user/Pi-provided `prompt_cache_key` or `promptCacheKey`.
* Adapter selection by `provider` id, API type, base URL, or compat flags. The only exception is that routing-provider identity resolution may decide which model object to inspect; adapter selection itself still uses the resolved model id/name and assistant message id/name tokens.
* Importing router packages, reading router-specific config files, or depending on package-specific global singleton state instead of the versioned routing/cache-hints symbols.
* Reverting footer stats to provider-family-only or unscoped provider/model
  buckets for normal updates; use v4 `sessions[sessionHash][provider/model]`
  persistence and in-memory `${sessionHash}:${provider}/${id}` keys for
  active-model turns, and keep `legacyFamily` only for migration/fallback.
* Generating in-place writes to the stats file.
* Re-emitting per-session notifications or duplicate warnings.
* Special-casing `kiro-api` (or any other custom-API extension whose
  transport does not surface cache fields) by faking `cacheRead`,
  `cacheReadInputTokens`, or hit counts to make the footer look better.
  The 0% is the truthful number; documenting the constraint is the
  correct response, not papering over it.

---

## System prompt budget

### What counts as cacheable-and-stable vs cacheable-and-volatile

Pi's system prompt combines several layers. From most-to-least
cacheable:

| Layer | Stability | Cache impact |
| ----- | --------- | ------------ |
| Pi base preamble (tools + guidelines + doc paths) | Stable across sessions unless tools change | Always in stable prefix; 100 % cacheable |
| `AGENTS.md` / project context files | Stable per repo; changes only on commit | Lifted to stable prefix by `optimizeSystemPrompt`; 100 % cacheable |
| Skills XML `<available_skills>` block | Deterministic from `opts.skills` (stable unless you install/remove a skill) | Lifted to stable prefix; now **compressed by default** (see below) |
| Trellis `<session-overview>` | Mostly stable; tail (commits, journal line count) churns per turn | Currently in dynamic remainder (tail churn). Do not lift in this extension — that's trellis's own ordering decision. |
| Trellis `<workflow-state>` per-turn breadcrumb | Changes per task activation, per turn | Always in dynamic remainder. Small (~1 KB). |
| Date + cwd footer | Date changes once/day; cwd stable | In dynamic remainder; ~100 bytes, not worth lifting. |

### Skills compression contract

`formatSkillsForPromptCompressed` replaces pi's per-skill four-line XML
block (`<name>`, `<description>`, `<location>`) with a **single text
block** grouped by skill-root directory:

```
The following skills provide specialized instructions for specific tasks.
When a skill name matches the task you are doing, read the SKILL.md at
the listed location to load the full instructions. When a SKILL.md
references a relative path, resolve it against the skill directory
(parent of SKILL.md / dirname of the path) and use that absolute path in
tool commands.

Skills under /home/jiang/.agents/skills/<name>/SKILL.md:
  adapt, animate, arrange, audit, ...

Skills under /home/jiang/jiang/source/.../pi-cache-optimizer/.pi/skills/<name>/SKILL.md:
  trellis-before-dev, trellis-brainstorm, ...
```

Key properties:

* **Deterministic**: same `skills` array → byte-identical output,
  independent of input order. Groups sort by root path; names within
  each group sort alphabetically.
* **Idempotent**: running `compressSkillsInSystemPrompt` twice is a
  no-op (the verbose form is already gone after the first pass).
* **Opt-out**: `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` disables.
* **Threshold**: compression fires only when the visible skill count
  is ≥ `SKILL_COMPRESSION_MIN_COUNT` (currently 4). Below that, the
  verbose XML block is ≤ ~1 KB and the loss of description hints is
  not worth the micro-savings.
* **Anchored substitution**: compression only fires when the verbose
  output of `formatSkillsForPrompt(opts.skills)` is found verbatim in
  the prompt (substring match, not regex). If pi changes its emitter
  format, the substitution no-ops rather than mangling.
* **Cache-preserving**: the compressed skills block remains
  deterministic from `opts.skills` and is lifted to the stable prefix
  by `optimizeSystemPrompt`. No new cache-churn is introduced.
* **Size cut**: measured at ~93 % reduction of the skills section
  (13.3 KB → ~0.9 KB on the 31-skill snapshot) and ~55 % of total
  system prompt (22 KB → ~9 KB).

### What MUST NOT be lifted into the stable prefix

* `<workflow-state>` per-turn breadcrumb — dynamic, small, safe in
  the tail.
* `<session-overview>` tail fields (recent commits, journal line
  count) — change per-turn when the user commits or writes journal.
  **These are now proactively stripped by `stripSessionOverviewChurn`**
  before reorder, so the remaining session-overview (branch, active
  tasks, paths) becomes stable and cacheable.
* Date / cwd footer — 100 bytes, not worth lifting.
* Any extension-appended block that contains a timestamp, random
  salt, insertion-order-dependent iteration, or env-var-derived
  string. The `before_agent_start` reorder MUST remain idempotent
  (identical inputs → byte-identical output).

### Session-overview churn strip

`stripSessionOverviewChurn(prompt)` surgically removes three fields
from inside `<session-overview>`:
* `## RECENT COMMITS` block (from heading through next `##` heading
  or end of block).
* `Working directory: ...` line.
* `Line count: N / NNNN` line.

The remaining fields (DEVELOPER, Branch, CURRENT TASK, ACTIVE
TASKS, MY TASKS, JOURNAL FILE active-file-only, PACKAGES, PATHS)
are stable within a session and survive the strip intact.

Called in `before_agent_start` BEFORE skills compression and reorder.
No opt-out; the stripped fields carry zero task-execution information
that the model cannot obtain from `git log` / `git status` / `wc -l`
in the rare case it actually needs them.

### Truncation guard (structural marker integrity)

`optimizeSystemPrompt` uses `String.replace(part, "")` to extract
stable candidates from the dynamic remainder. If an upstream extension
(e.g. trellis, or any future extension) injects text that shares a
substring with a candidate, `replace()` removes the **first** occurrence
— the one in the stable block. This is usually safe because the copy
inside the dynamic injection stays.

When it is **not** safe: if a candidate substring appears ONLY inside
an injected block (not in any stable block), the first (and only)
occurrence IS inside the injection — `replace()` eats dynamic content.

Guard:
* Before reorder, scan `original` for **all** structural markers. Three
  marker categories are recognized:
  - XML opening tags `<tagname>` (lowercase, alphanumeric + `-`/`_`)
  - XML closing tags `</tagname>`
  - HTML comment START/END pairs `<!-- NAME:START --> ... <!-- NAME:END -->`
* After reorder, scan the result for the same markers.
* If any marker present in `original` is missing from the result →
  **fall back to the original prompt** (no reorder), flip
  `promptTruncationDetected` flag. The model receives a complete
  prompt; cache stability is sacrificed for integrity.
* `publishStatus` reads the flag once, appends ` ⚠️ integrity` to
  the footer status line, and resets the flag — the warning is
  visible for exactly one status update.
* The guard is **extension-agnostic**: trellis `<workflow-state>`,
  hypothetical `<task-tracker>`, AGENTS.md `<!-- TRELLIS:START -->`,
  or any future extension's structural markers are all protected
  without code changes when new extensions ship.
* Tags with attributes (`<task id="42">`) are deliberately not picked
  up: the pi extension ecosystem currently does not emit them, and
  including them would require a more permissive regex that risks
  false positives on prose like `<3` or `<= x`.
* Markdown headers, horizontal rules, and timestamp patterns are not
  used as guards: they have no closing form and cannot reliably
  signal "missing in result".

When the user sees ` ⚠️ integrity` in the footer:
1. The prompt sent to the model is the **original** (extension-injected)
   prompt — no reorder was applied on that turn.
2. The cause is almost always an upstream format change (e.g. trellis
   update, or a new extension introducing a substring collision).
3. `/reload` may help if the collision depends on per-turn state;
   otherwise, degrades gracefully (cache miss, no prompt corruption).

### Integrity diagnostics

When `⚠️ integrity` first triggers in a session, a one-time notification
with recovery steps is shown. The `lastPromptIntegrityWarningAt` timestamp
is updated on every integrity event and preserved for the session. The
`/cache-optimizer doctor` command shows integrity diagnosis (with recovery
steps) if an event was detected within the last 5 minutes, helping users
diagnose without prompt content or API key exposure. On `/reload` the
timestamp is reset to 0 and the one-time notification is re-armed.

---

## Compat footer marker (`⚠️ compat`)

When the active model is a non-official OpenAI-compatible proxy (`openai-completions`
API through a non-`api.openai.com` base URL) and its merged `compat` lacks
`sendSessionAffinityHeaders`, the footer status line appends `⚠️ compat`:

```text
OpenAI cache 0/0 · 0M/0M tok ⚠️ compat
```

DeepSeek-like models using Pi Mono guidance may also surface `⚠️ compat` when
`requiresReasoningContentOnAssistantMessages` or `thinkingFormat: "deepseek"`
are missing, even when the provider is otherwise not a generic proxy.
Native `anthropic-messages` adaptive-generation models may also surface
`⚠️ compat`: Claude opus-4.6+, sonnet-4.6+ including Sonnet 5, and fable-5+
require `forceAdaptiveThinking: true`; Kimi Coding K3 / `kimi-for-coding`
require `forceAdaptiveThinking: true` and `allowEmptySignature: true` for
empty-signature thinking replay.

Rules:

* The marker is one-shot per model key (provider/id). It shows once and persists
  while that model remains active and compat is still missing.
* When the model is switched or its compat is fixed, the marker clears.
* The marker coexists with `⚠️ integrity` — both can appear:
  `OpenAI cache 0/0 · 0M/0M tok ⚠️ integrity ⚠️ compat`
* The marker uses adapter-aware `describeMissingCacheCompatForModel` internally.
  For generic OpenAI-compatible proxies this delegates to
  `describeMissingOpenAICompatibleProxyCompat`; for DeepSeek-like models it
  delegates to `describeMissingDeepSeekCompat` and includes Pi Mono reasoning
  compat fields; for native `anthropic-messages` adaptive-generation models it
  delegates to `describeMissingAdaptiveThinkingCompat` and includes
  `forceAdaptiveThinking`, plus `allowEmptySignature` for Kimi Coding K3.
* Official OpenAI base URLs (`api.openai.com`) never trigger the marker.
* Custom transports (`kiro-api`, `bedrock-converse-stream`, etc.) never trigger the marker.
  `anthropic-messages` is the narrow exception above, only for adaptive-generation
  thinking-format compatibility.

---

## Diagnostic command (`/cache-optimizer`)

The extension registers a Pi command `/cache-optimizer` with seven subcommands.

### `/cache-optimizer enable` / `/cache-optimizer disable`

These are current-process runtime switches, not persistent config writes.

* `enable` turns runtime optimization back on, requests `PI_CACHE_RETENTION=long`,
  resets local footer stats/recent samples for before/after comparison,
  republishes the footer, and shows a status summary for prompt rewrite,
  OpenAI-compatible `prompt_cache_key` fallback, footer stats, compat warnings, and
  `PI_CACHE_RETENTION`.
* `disable` turns runtime optimization off, restores the startup `PI_CACHE_RETENTION`
  value (or unsets it if it was originally unset), suppresses prompt mutations,
  OpenAI-compatible `prompt_cache_key` fallback, and compat warnings, resets
  local footer stats/recent samples, keeps collecting footer stats in disabled
  comparison mode, republishes the footer as `Cache Optimizer disabled · <stats>`
  for adapter-matched models, and shows the same status summary.
* Neither command writes environment files, Pi settings, or `models.json`. They do
  persist the local stats reset so the comparison footer starts from 0/0.
  Run `/reload` or restart Pi to return optimizer runtime behavior to startup defaults.

### `/cache-optimizer doctor`

Shows current active model status: provider, model id/name, API type, base URL,
merged compat flags, and whether any cache/session-affinity compat flags are missing.
If compat flags are missing, includes a copyable safe JSON suggestion and the edit
location (`~/.pi/agent/models.json -> providers.<id> -> compat`). The JSON only
includes `sendSessionAffinityHeaders: true` when missing. `supportsLongCacheRetention`
is explained as optional/risky guidance rather than treated as missing or inserted
into the copyable safe snippet.
For channels with no explicit `models.json` provider block yet, the output MUST
explain that users should keep existing authentication as-is, must not copy
credentials/tokens/API keys, and should add only cache/routing compatibility in a
minimal `models.json` provider override. When a safe compat suggestion exists,
doctor MUST show both provider-level `compat` and single-model `modelOverrides`
examples using only the safe compat keys.

When the compat check applies (third-party `openai-completions` proxy) and no flags
are missing, shows `✅ Compat fully configured.`
(`ℹ️ Compat check not applicable for this model.` for non-applicable scenarios such
as official OpenAI, non-`openai-completions` APIs, or custom transports like
`kiro-api`).

Additionally, if the active model is routed through a known router/channel proxy such
as OpenRouter, Vercel AI Gateway, LiteLLM/OneAPI/NewAPI/VoAPI, or a generic
third-party OpenAI-compatible proxy, the doctor output appends a
`🔀 Router/channel:` section with diagnostics and routing recommendations. See
[Router/channel diagnostics](#routerchannel-diagnostics) below for details.

Output also includes a **"Cache diagnosis"** section with prioritized low-hit cause analysis:
1. **Missing compat flags** — flags that enable prompt caching and session-affinity routing are absent.
2. **Router/channel risk** — multi-backend routing may split the cache across different upstream instances.
3. **Missing usage fields** — recent responses lack prompt-level usage fields; footer may under-report hits.
4. **Recent low trend** — if today's cache hit rate is below 30%, suggests proxy route instability or prompt prefix churn.

For fully configured models that still have low cache hit rates, the diagnosis emphasizes sticky routing
and upstream cache usage verification rather than compat flags.

The output MUST NOT include API keys, secrets, prompts, payloads, headers, or model output.
If a previous `after_provider_response` saw HTTP 400 for this model while
`supportsLongCacheRetention` was enabled, doctor includes a stronger hint to remove/avoid
that flag if the provider error text is `Unsupported parameter: prompt_cache_retention`.
Likewise, if a previous `after_provider_response` saw HTTP 403 for this model while
`sendSessionAffinityHeaders` was enabled (`sendSessionAffinityHeaders403Models`), doctor includes
a stronger hint to set `sendSessionAffinityHeaders: false` because the proxy/CDN likely blocks
Pi's custom session-affinity headers (session_id, x-client-request-id, x-session-affinity). When
the flag is enabled but no 403 has been observed yet, doctor shows an advisory note about
potential CDN/WAF blocking. If a previous HTTP 403 was observed after session-affinity headers
were already absent/disabled (`openAISdkHeader403Models`), doctor gives read-only manual
guidance that the proxy/CDN may be blocking the OpenAI JS SDK request fingerprint (for example
`User-Agent: OpenAI/JS ...` or `X-Stainless-*` headers). `/cache-optimizer fix` MUST NOT
automatically write `headers.User-Agent` because the correct value is provider/WAF-specific.

### `/cache-optimizer stats`

Shows the active model's stats bucket (`provider/modelId`), today's request counters
(hit/total), cached input tokens vs total input tokens, hit rate percentage, and
recent trend summaries (last 10 and last 30 samples):

```text
Model key: otokapi/gpt-5.5
Adapter:   OpenAI cache

── Today ──
Requests:      3 hit / 10 total · 30%
Cached tokens: 0.0015M / 0.005M input · 30%

── Recent trend ──
Recent 10/10: 3/10 hits · 30% tok cached
Recent 10/10: 3/10 hits · 30% tok cached
```

If the active model has no adapter match, a friendly message is shown. If no
samples have been recorded yet in this session, trend shows "no samples yet".

### `/cache-optimizer compat`

Shows the compat suggestion for the active model, including the file path,
provider selector, exact edit location, and the copyable JSON snippet.
When compat flags are missing, includes the suggestion and appends any applicable
router/channel diagnostic notes. Like doctor, this command MUST include guidance
for channels with no explicit `models.json` provider block yet: keep existing
authentication as-is, do not copy credentials/tokens/API keys, and place only the
minimal provider-level `compat` override or single-model `modelOverrides` override
in `models.json`.

When no compat flags are missing but router/channel diagnostics apply, shows the
same applicability-respecting status line (`✅ Compat fully configured.` or
`ℹ️ Compat check not applicable for this model.`) followed by router/channel notes.

When neither compat flags are missing nor router/channel diagnostics apply, shows
only the status line as before.

### `/cache-optimizer fix`

Auto-repairs safe compat issues detected for the **current active model only**.
It covers the same safe defaults shown by doctor/compat:

* Adaptive thinking: `forceAdaptiveThinking: true` for native
  `anthropic-messages` Claude opus-4.6+/sonnet-4.6+ (including Sonnet 5)/
  fable-5+ and Kimi Coding K3 / `kimi-for-coding`; the Kimi Coding models also
  get `allowEmptySignature: true`.
* DeepSeek Pi Mono compat: `thinkingFormat: "deepseek"`,
  `requiresReasoningContentOnAssistantMessages: true`, plus cache/session-affinity
  flags that are part of the DeepSeek safe suggestion.
* Generic OpenAI-compatible proxy affinity: `sendSessionAffinityHeaders: true`
  when missing. It does **not** auto-enable optional generic
  `supportsLongCacheRetention`.

Safety contract:

* Requires interactive UI confirmation. Non-interactive mode refuses to write and
  shows manual edit guidance.
* Shows a preview with the file path, provider/model edit location, JSON to write,
  placement reason, and risk notices before writing.
* Risk notices MUST include: the change affects all sessions using that provider/
  channel (or all models in the provider when provider-level placement is chosen),
  a timestamped backup path `models.json.backup-cache-optimizer-<ts>`, and the need
  to `/reload` or restart Pi.
* Uses a comment-preserving JSONC surgical editor. It does not stringify/rewrite the
  full file; it locates existing provider/model/compat nodes while respecting string
  literals, escapes, line comments, block comments, and trailing commas.
* Writes by backup → temp file → atomic rename. Post-write self-check reparses JSONC,
  validates effective merged compat, and verifies the original parsed structure is
  preserved except for repaired compat keys. On post-write self-check failure, the
  backup is restored.
* The fix may insert/repair `compat` keys or a missing `compat` object under an
  existing provider/model. It MUST NOT create provider entries, model entries, API
  keys, credentials, or router slugs.

### `/cache-optimizer reset`

Resets the visible local footer stats for the active provider/model. This removes
the authoritative `totalsByModel[provider/id]` counter and matching in-memory
session entries for that model; other provider/model totals are unaffected.

* Clears today's request counters (hit/total), cached token counts, and recent trend
  samples for the active provider/model's local footer stats.
* Persists immediately to disk (so the reset survives `/reload` and process restart).
* Publishes updated footer showing `0/0` for that model.
* If no active model is selected, shows a warning.
* If the active model does not match a cache adapter, shows a friendly no-op message.
* Emphasizes that this is a *local* stats reset only — upstream provider prompt
  cache is not modified.

### No arguments

When the Pi UI supports it (`ctx.ui.select` available), shows an interactive
selection menu with options: Enable, Disable, Doctor, Stats, Compat, Fix, Reset,
Cancel. Selecting a subcommand executes the corresponding logic. Cancel closes the menu.

In non-interactive terminals (no `ui.select`), falls back to a short text help
listing available subcommands, runtime enabled/disabled state, and a one-line summary
of the active model's compat status (using the same applicability-respecting text as
doctor/compat).

### Recent samples (in-memory, no persistence)

The extension tracks per-model-key `CacheUsageSample` entries in memory for trend analysis.

```ts
type CacheUsageSample = {
  timestamp: number;
  hit: boolean;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
  missingUsageFields: boolean;
};
```

**Contracts:**

* Maximum `MAX_RECENT_SAMPLES` (50) per model key — older entries are dropped.
* Samples are **never persisted** to disk — cleared on `/reload` or process restart.
* Each sample contains only numeric counters and booleans — never message content,
  prompts, payloads, headers, API keys, or model outputs.
* The `missingUsageFields` flag is set when the assistant message's usage fields
  appear to be empty or absent (Pi-normalized `input`/`cacheRead`/`cacheWrite` all
  absent/zero and adapter `normalizeUsage` returns `undefined` or all-zeros).
* Trend summaries (10/30) are computed by `formatRecentTrendSummary()` and used
  in both `/cache-optimizer stats` and `/cache-optimizer doctor` diagnosis.

### Router/channel diagnostics

The `describeRouterChannelDiagnostics(model)` function inspects `ctx.model`
metadata (provider, api, baseUrl, compat) to detect common router/channel proxy
patterns and returns advisory notes. It is called by both `buildDoctorDiagnosis`
and `buildCompatDiagnosis`.

This function is **advisory only**. It does NOT participate in:
- Adapter selection (still id/name-only)
- `prompt_cache_key` injection
- Footer stats
- Any automated configuration changes

#### Detected profiles

| Profile | Detection | Guidance |
|---------|-----------|----------|
| **OpenRouter** | `baseUrl` or `provider` contains `openrouter.ai` / `openrouter` | Use `openRouterRouting.only` or `.order` to fix the upstream provider; also set `sendSessionAffinityHeaders` and `supportsLongCacheRetention` if the upstream supports them |
| **Vercel AI Gateway** | `baseUrl` contains `ai-gateway.vercel.sh` or `provider` contains `vercel`/`vercel-ai-gateway` | Use `vercelGatewayRouting.only` or `.order` to fix the upstream; also set `sendSessionAffinityHeaders` and `supportsLongCacheRetention` if supported |
| **LiteLLM / OneAPI / NewAPI / VoAPI** | `baseUrl` or `provider` contains `litellm`, `oneapi`/`one-api`, `newapi`/`new-api`, `voapi`/`vo-api` | Ensure sticky routing per session (session_id affinity), forward `prompt_cache_key` and session-affinity headers, return cache usage fields |
| **Generic third-party OpenAI-compatible proxy** | `api: "openai-completions"` with non-official `baseUrl` not matching above profiles | General guidance: verify single-upstream routing, forward `prompt_cache_key` + session-affinity headers, return cache usage fields |

#### Limitations

- Only applies when `api` is `openai-completions` or `openai-responses`.
- Official `api.openai.com` bypasses all profiles.
- Custom transports (`kiro-api`, `anthropic-messages`, `bedrock-converse-stream`)
  are excluded.
- Detection uses only `provider`, `api`, `baseUrl`, and `compat` — no API keys,
  prompts, payloads, headers, or model outputs are read or exposed.

### Security

The command reads only `ctx.model` metadata (provider, id, name, api, baseUrl,
compat). It does NOT read or expose:
- API keys or environment secrets
- Request/response payloads
- Prompts or model outputs
- HTTP headers
- Any content from `~/.pi/agent/models.json` beyond what the Pi runtime exposes
  via `ctx.model`

### Validation matrix (additional rows)

| Scenario | Expected behavior |
|---|---|
| `/cache-optimizer doctor` with generic proxy missing session affinity | Output includes `Missing compat flags: sendSessionAffinityHeaders`, a copyable safe JSON suggestion with `sendSessionAffinityHeaders: true`, the `~/.pi/agent/models.json -> providers["<id>"]` path, optional/risky guidance for `supportsLongCacheRetention`, and credential-safe guidance that keeps existing authentication as-is while placing only compat overrides in `models.json` |
| `/cache-optimizer doctor` with DeepSeek-like Pi Mono model missing reasoning compat | Output includes missing `requiresReasoningContentOnAssistantMessages` and `thinkingFormat`, plus copyable JSON with `requiresReasoningContentOnAssistantMessages: true` and `thinkingFormat: "deepseek"`. For `openai-responses`, it does not suggest removed `sendSessionIdHeader`; Pi 0.80.7+ owns header shape through `sessionAffinityFormat`. |
| Kimi Coding K3 custom `anthropic-messages` model missing adaptive compat | Footer/doctor/compat show missing `forceAdaptiveThinking` and `allowEmptySignature`; `/cache-optimizer fix` suggests both at model scope when sibling models are mixed. Moonshot/OpenRouter K3 variants on `openai-completions` remain in the Kimi/proxy path and do not receive Kimi Coding adaptive compat. |
| `/cache-optimizer compat` with DeepSeek-like Pi Mono model missing reasoning compat | Shows the same DeepSeek-specific JSON suggestion and edit location; custom transports still show not-applicable. |
| `/cache-optimizer doctor` without an active model | Notification: "No active model selected" |
| `/cache-optimizer doctor` with applicable fully-configured model | Shows `✅ Compat fully configured.` (without "(or not applicable)") |
| `/cache-optimizer doctor` with non-applicable model (official OpenAI, non-openai-completions, custom transport) | Shows `ℹ️ Compat check not applicable for this model.` |
| `/cache-optimizer compat` with a fully configured applicable model | Shows `✅ Compat fully configured.` |
| `/cache-optimizer compat` with a non-applicable model | Shows `ℹ️ Compat check not applicable for this model.` |
| `/cache-optimizer enable` | Runtime optimizer becomes enabled, `PI_CACHE_RETENTION=long` is requested, local footer stats/recent samples reset, footer republishes, and notification lists active feature states |
| `/cache-optimizer disable` | Runtime optimizer becomes disabled for this Pi process, startup `PI_CACHE_RETENTION` is restored/unset, local footer stats/recent samples reset, adapter-matched footer shows `Cache Optimizer disabled · <stats>`, and notification lists disabled feature states |
| Runtime disabled before hooks fire | `before_agent_start` returns `{}`, `before_provider_request` does not add `prompt_cache_key`, `message_end` continues updating comparison stats, and session/model compat warnings are suppressed |
| `/cache-optimizer` (no args) with UI supports select | Shows interactive selection menu (Enable / Disable / Doctor / Stats / Compat / Reset / Cancel) |
| `/cache-optimizer` (no args) without UI | Text help lists `enable`, `disable`, `doctor`, `stats`, `compat`, `reset` subcommands plus runtime state |
| Footer status for generic proxy after `/cache-optimizer fix` added `sendSessionAffinityHeaders` but `supportsLongCacheRetention` remains absent | No `⚠️ compat`; doctor/compat may still show optional long-retention guidance, but the model is considered safely configured |
| Footer status when compat is fixed or model changes | `⚠️ compat` marker clears |
| `/cache-optimizer fix` with API-logged-in model not in models.json (interactive UI) | Analyzes models.json, shows preview of new provider/model/compat entry, confirms, writes atomically with backup, self-checks, succeeds |
| `/cache-optimizer fix` with API-logged-in model not in models.json (non-interactive) | Shows manual guidance with complete JSON snippet, keeps existing auth as-is, includes fallback for both missing-provider and missing-model scenarios |
| `/cache-optimizer fix` creates new provider entry in models.json | Does NOT create API keys, credentials, baseUrl, or router slugs; only inserts minimal compat-only provider/model structure |
| `/cache-optimizer fix` adds model to existing provider's models array | Appends model entry with id + compat to the existing models array, preserves all sibling models and provider-level configuration |
| `/cache-optimizer doctor` with OpenRouter model | Output includes `🔀 Router/channel: OpenRouter detected` with routing fix suggestion and JSON example for `openRouterRouting` |
| `/cache-optimizer doctor` with Vercel AI Gateway model | Output includes `🔀 Router/channel: Vercel AI Gateway detected` with `vercelGatewayRouting` suggestion |
| `/cache-optimizer doctor` with LiteLLM/OneAPI/NewAPI/VoAPI model | Output includes `🔀 Router/channel: Self-hosted aggregation proxy detected` with sticky routing and prompt_cache_key guidance |
| `/cache-optimizer doctor` with generic third-party OpenAI-compatible proxy | Output includes `🔀 Router/channel: Third-party OpenAI-compatible proxy` with general guidance |
| `/cache-optimizer doctor` with official OpenAI or kiro-api model | Output does NOT include router/channel notes (not applicable) |
| `/cache-optimizer compat` with missing-compat OpenRouter model | Shows missing flags + safe JSON + OpenRouter channel notes + credential-safe `models.json` guidance with provider-level and `modelOverrides` examples |
| `/cache-optimizer compat` with fully-configured OpenRouter model | Shows `✅ Compat fully configured.` followed by OpenRouter channel notes; if `supportsLongCacheRetention` is enabled, also includes the `prompt_cache_retention` 400 recovery hint |
| Router/channel diagnostics do not affect adapter selection | An OpenRouter Llama model still selects the Llama adapter, not an "OpenRouter" adapter |
| Diagnostic text must not expose API keys, prompts, payloads, or model output | All router/channel output uses only provider, api, baseUrl, compat metadata |
| Third-party OpenAI-compatible proxy (`openai-completions` or `openai-responses`) returns HTTP 400 while `supportsLongCacheRetention` is enabled | Extension records a one-time model-scoped warning and `/cache-optimizer doctor` surfaces the `prompt_cache_retention` recovery hint |
| Third-party `openai-completions` proxy returns HTTP 403 while `sendSessionAffinityHeaders` is enabled | Extension records a one-time model-scoped warning (`sendSessionAffinityHeaders403Models`) and `/cache-optimizer doctor` surfaces the session-affinity 403 hint with `/cache-optimizer fix` offering `sendSessionAffinityHeaders: false`. Pi 0.80.7+ `openai-responses` is excluded because it uses `sessionAffinityFormat`. |
| `/cache-optimizer doctor` with session-affinity enabled but no 403 observed | Shows advisory text that some CDNs/WAFs block custom headers (session_id, x-client-request-id, x-session-affinity) and return 403 |
| `/cache-optimizer fix` with 403-observed OpenAI-compatible model | Offers `sendSessionAffinityHeaders: false` as the compat-key suggestion (mirror of the 400 `supportsLongCacheRetention: false` path) |
| `/cache-optimizer compat` with fully-configured model where `sendSessionAffinityHeaders` is enabled | Shows `✅ Compat fully configured.` plus an advisory line about potential CDN/WAF 403 blocking of custom session-affinity headers |
| Generic proxy model with explicit `sendSessionAffinityHeaders: false` after a 403/CDN block | No `⚠️ compat`; `/cache-optimizer fix` must NOT suggest changing it back to `true` |
| Generic proxy returns HTTP 403 after `sendSessionAffinityHeaders` is already false/absent | Extension records a one-time `openAISdkHeader403Models` diagnostic and doctor/compat provide read-only guidance about OpenAI JS SDK `User-Agent` / `X-Stainless-*` WAF blocking; `/cache-optimizer fix` does NOT auto-write `headers.User-Agent` |
| `/cache-optimizer stats` with model matching an adapter | Output includes model key, request counts, token counts, hit rate, recent trend |
| `/cache-optimizer stats` with unseen model bucket | Shows 0/0, not legacy family aggregates |
| `/cache-optimizer stats` with unsupported model (no adapter) | Shows friendly message "No cache-adapter-matched model active" |
| `/cache-optimizer stats` without active model | Shows friendly message |
| `/cache-optimizer stats` with recent missing usage fields | Output includes warning about missing usage fields |
| Doctor diagnosis with fully-configured but low-hit model | Shows low-hit causes emphasizing sticky routing, not compat |
| Doctor diagnosis with missing compat + recent samples | Includes missing compat flags, usage missing, and low trend sections |
| `/cache-optimizer reset` with active adapter-matched model | Clears the active provider/model total and matching in-memory session entries, resets recent samples, persists immediately, shows 0/0, and notifies that upstream provider prompt cache was not modified |
| `/cache-optimizer reset` without active model | Shows warning: "No active model selected" |
| `/cache-optimizer reset` with non-adapter-matched model | Shows friendly no-op message |
| `/cache-optimizer reset` only affects one model | Other provider/model totals are preserved |
| Same Pi session after `/cache-optimizer reset` | New requests accumulate stats in a fresh provider/model total and current-session bucket |
| Different/new Pi session after same model's reset | The reset provider/model total remains 0 until new requests arrive; old session buckets do not resurrect the footer |
