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
| Stats shard path | `~/.pi/agent/pi-cache-optimizer-stats.d/shards/<instance-uuid>.json` by default | Resolved with Pi core's exported `getAgentDir()`. Each loaded extension instance atomically owns one shard; old shared `pi-cache-optimizer-stats.json` / `deepseek-cache-optimizer-stats.json` files are ignored and deleted. |
| Footer config path | `~/.pi/agent/pi-cache-optimizer-config.json` by default | Stores only versioned `footerMode` command configuration. Uses the same Pi agent-dir resolution and is separate from numeric stats persistence. |
| Models JSON path | `~/.pi/agent/models.json` by default | Reference path for compat warnings/fix; display helper shows `%USERPROFILE%\.pi\agent\models.json` on Windows unless a custom agent dir env override is active. |

---

## Adapter selection (id/name only)

Adapter selection MUST consider only the active model `id` and `name`, plus the
assistant message's `model` and `name` fields on `message_end`. It MUST NOT use
`provider` id, `api` type, base URL, `compat.thinkingFormat`, or any other
metadata for selection. Generic OpenAI-compatible proxies are NOT treated as
OpenAI-family just because they use an OpenAI-shaped API.

When `message_end` echoes the same direct, non-virtual provider and exact model
id as the active model, `modelFromAssistantMessage()` preserves the active model's
non-empty display name for id/name adapter selection. This covers short wire ids
whose display name carries the family token (for example `kimi-coding/k3` named
`Kimi K3`). If response provider or model id differs, the response id remains
the derived name so routed/upstream identity stays authoritative and a stale
fallback display name cannot affect classification. Bare `k3` is not a Kimi
adapter token.

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

If no adapter matches, the footer status MUST be cleared (set to `undefined`). Every non-empty status published by this extension MUST begin with the ownership separator `· `. This prefix is applied at the final footer-status assembly boundary, so it also covers disabled-mode, router-restored, integrity-warning, and compat-warning variants without changing `/cache-optimizer stats` output or the internal separators.

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

#### `llama.cpp` (Pi 0.81+ built-in provider)

* The built-in model shape uses provider `llama.cpp`, API `openai-completions`,
  and a characteristic explicit compat fingerprint (`supportsStore`,
  `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`,
  and `supportsStrictMode` all `false`; `maxTokensField: "max_tokens"`). The
  configured router URL may be local or remote.
* Pi 0.82+ core treats this transport like other OpenAI completions channels and
  may generate a session `prompt_cache_key`. The extension MUST preserve an
  existing key and MAY add its same session-id fallback when the key is absent.
* `prompt_cache_retention` follows the normal safety gate: official OpenAI keeps
  it; a third-party/built-in llama channel keeps it only when the effective
  explicit `supportsLongCacheRetention` value in `models.json` is `true`.
  Resolution MUST follow Pi precedence: `modelOverrides[modelId].compat`, then
  matching `models[].compat`, then provider `compat`. A higher-precedence
  explicit `false` overrides a lower-precedence `true`; absent/malformed/unreadable
  configuration fails closed and the field is stripped before sending.
* Generic proxy routing/session-affinity advice is skipped only for the untouched
  built-in compat fingerprint. A custom/overridden provider using the same
  `llama.cpp` id or explicit cache/routing overrides MUST remain eligible for
  ordinary proxy diagnostics and fixes.
* Footer behavior remains truthful: if the server returns cache usage fields the
  Llama adapter may display them; otherwise it shows zero/under-reported data
  rather than synthetic hits.

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
  the model `id`/`name` no longer needs to match GPT-family tokens — remote models
  using an OpenAI-shaped API (including Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan,
  Qwen Token Plan, Pi's built-in `llama.cpp`, and any future OpenAI-compatible
  provider) receive the session-id fallback. Custom transports such as
  `kiro-api` remain excluded by the API gate.
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

### Anthropic cache-control TTL order safety

For an effective model using `api: "anthropic-messages"`, the
`before_provider_request` hook MUST validate the final serialized Anthropic cache
breakpoints in wire processing order: `tools`, then `system`, then
`messages[].content`.

* An ephemeral `cache_control` with `ttl: "1h"` is long retention.
* `ttl: "5m"` and an ephemeral cache control with no `ttl` are short retention.
* Anthropic permits long-only, short-only, and long-to-short ordering, but rejects
  any long breakpoint after a short breakpoint.
* For every `anthropic-messages` endpoint, when a visible short-to-long transition
  is observed, every `ttl: "1h"` in the known breakpoint locations MUST be
  downgraded by deleting `ttl`, producing default 5-minute controls. Legal
  long-only and long-to-short payloads remain unchanged.
* Some proxies can inject or rewrite hidden short breakpoints after
  `before_provider_request`. The extension MUST NOT infer this from provider id or
  endpoint. Only an assistant error message containing Anthropic's explicit
  `cache_control`, `ttl='1h'`, `ttl='5m'`, and `must not come after` signals may
  activate a process-local provider/model fallback. Any persisted fix derived
  from that observation is model-scoped, even when ordinary channel-capability
  fixes may use provider-level placement.
* The exact Anthropic TTL-order error is a non-retryable HTTP 400 in Pi 0.82.1.
  Once observed, the next subsequent request for that provider/model (and any
  retry initiated by another layer) MUST downgrade request-local 1h controls to
  default 5m. The extension MUST NOT claim that Pi's built-in automatic retry
  reruns this failed turn. Other 400s and prompt-too-long errors MUST NOT
  activate the fallback.
* Doctor MUST report the observed fallback; `/cache-optimizer fix` MAY persist
  a model-scoped `supportsLongCacheRetention: false` through the existing
  confirmation/backup flow. Runtime error history is not written to disk and
  survives extension reloads only within the current process.
* This must not change prompt text, tool schemas, model routing, or unrelated nested
  objects that merely contain a `cache_control`-named key.
* Detection MUST use the effective API and request-local provider/model identity,
  never provider name patterns, base URL, adapter family, or cache adapter selection.
* The repair remains active even when runtime prompt optimization is disabled,
  because it prevents a provider-invalid request rather than optimizing prompts.
* Legal payloads and non-Anthropic APIs MUST remain byte/structure-equivalent.

#### Third-party OpenAI-compatible proxy compat warning

For models using `api: "openai-completions"` through a non-official
base URL (not `api.openai.com`), warn/mark missing compat only when effective compat
has no `sendSessionAffinityHeaders` value (`undefined`). Effective compat uses exact
provider/model ids and precedence `models.json provider.compat → matching
models[].compat → runtime model.compat → modelOverrides[modelId].compat`. The runtime
model layer is included because extension providers using `registerProvider()` may
replace their model list after lower configuration was composed; Pi 0.84.2 can
therefore expose a model object without provider/custom-model compat even though the
user configured it. Malformed/missing/unreadable or Pi-schema-invalid config falls
back to runtime model compat without blocking hooks. Pi's untouched built-in
`llama.cpp` compat fingerprint is excluded because no proxy-routing configuration
is exposed there by default; an overridden same-id provider or explicit compat
configuration is not blanket-exempt. An explicit
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
keeping `sendSessionAffinityHeaders` if supported. The runtime records this exact
failure from either response headers or the finalized assistant error message;
subsequent requests for that provider/model strip the parameter for the current
process. Finalized assistant errors use their request-local provider/model/API
identity even when the active model is a router shell and no live routing registry
is available; inherited router compat MUST NOT suppress an explicit unsupported
signal. Other 400 errors MUST NOT activate this fallback: a generic `bad request`
that only says the parameter value or combination is invalid is not proof that the
parameter itself is unsupported. This extension does not write
`prompt_cache_retention` directly; it requests `PI_CACHE_RETENTION=long`, and Pi
may send the parameter when compat says long retention is supported.

This warning is advisory only and MUST NOT mutate the user's `models.json`.

When effective `sendSessionAffinityHeaders` is `true` for a runtime-enabled,
non-official `openai-completions` request but the runtime model itself does not carry
`true`, the `before_provider_headers` hook MUST bridge the verified Pi composition
gap so diagnostic success matches wire behavior. It uses the current Pi session id,
does not persist/log/display it, and never overwrites an existing header
case-insensitively. `sessionAffinityFormat: "openrouter"` adds only `x-session-id`;
default/OpenAI behavior adds `x-client-request-id` and `x-session-affinity`, plus
`session_id` for OpenAI format. Explicit effective `false`, official OpenAI,
Responses/custom transports, runtime disable, and missing session ids MUST remain
no-ops. If the final effective value comes from the runtime model layer, Pi owns
that decision and this bridge no-ops; a higher-priority models.json
`modelOverrides[modelId]` value may intentionally override a conflicting runtime
value and re-enable the bridge. For routed registry misses, upstream transport metadata
(`api`/`baseUrl`) is restored only from the same validated exact-provider/model config;
virtual-router metadata is never inherited across identities, so official OpenAI remains
excluded. If no non-empty effective base URL can be established, the bridge fails closed,
adds no affinity headers, and diagnostics report the compat check as not applicable rather
than claiming the channel is fully configured.

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

Runtime I/O MUST use Pi core's exported `getAgentDir()` rather than duplicating
environment/config-name logic. This preserves official `PI_CODING_AGENT_DIR`,
tilde, relative path, whitespace, `file://`, and rebranded distribution behavior;
`PI_CONFIG_DIR` alone MUST NOT redirect extension state.

The helper `getModelsJsonDisplayPath(platform?, agentDir?, homeDir?)` formats the
resolved agent directory for diagnostics:

| Condition | Returns |
|----------|---------|
| Resolved agent dir `/path/to/agent` outside home | `/path/to/agent/models.json` (platform separator adjusted for display) |
| Resolved Unix home path `/home/u/.pi/agent` | `~/.pi/agent/models.json` |
| Resolved Windows home path `C:\\Users\\u\\.pi\\agent` | `%USERPROFILE%\\.pi\\agent\\models.json` |
| Rebranded/default/custom path under home | Home shorthand plus Pi core's actual relative path |

This is used in all user-facing compat warning texts, `/cache-optimizer doctor`,
`/cache-optimizer compat`, and README documentation. The display string is never
used for I/O; `STATE_DIR` and `MODELS_JSON_PATH` derive from `getAgentDir()`.
It exists because many third-party OpenAI-compatible proxies fan out to multiple
upstream instances; a body `prompt_cache_key` alone may not keep requests on the
same cache-bearing backend unless the proxy also honors session-affinity headers.

---

## Persisted stats schema (v7: instance-owned shards)

Footer stats use a process-safe shard store under the resolved Pi agent directory:

```text
pi-cache-optimizer-stats.d/
├── shards/<instance-uuid>.json
├── epochs/global.json
├── epochs/models/<sha256(provider/modelId)>.json
└── maintenance/{last-cleanup,cleanup.lock/}
```

Each loaded extension factory instance creates a random UUID and is the only writer
of that UUID-named shard. A writer MUST NOT edit another instance's shard. Every
shard/epoch update uses a unique temp file followed by atomic rename. This removes
the shared-v6 lost-update race between parent, child, parallel, and independently
running Pi processes.

```ts
type CacheStats = {
  day: string;
  totalRequests: number;
  hitRequests: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
};

type PersistedStatsShardV7 = {
  version: 7;
  kind: "pi-cache-optimizer-shard";
  instanceId: string;
  sessionHash: string;
  process: { pid: number; ppid: number; instanceStartedAt: number };
  lifecycle: {
    state: "active" | "closed";
    createdAt: number;
    updatedAt: number;
    closedAt?: number;
  };
  day: string;
  globalEpoch: string;
  models: Record<string, {
    modelEpoch: string;
    provider: string;
    modelId: string;
    api?: string;
    stats: CacheStats;
  }>;
  lastRoutedModel?: PersistedRoutedModelRef;
};
```

### Privacy and identity

* Raw Pi session ids MUST NOT be persisted or displayed. Persist only the existing
  SHA-256 16-hex session hash.
* Model aggregation keys are exactly `${provider}/${modelId}`. Different providers
  or different model ids MUST NOT merge even when they use the same adapter label.
* PID/PPID are diagnostics and conservative cleanup hints only. They MUST NOT decide
  parent-child attribution or stats ownership.
* Persisted files MUST NOT contain prompts, messages, response bodies, payloads,
  headers, credentials, API keys, or model output.
* A child agent contributes only when it loads this extension and shares the same
  Pi agent directory. Remote/isolated/no-extension children remain unobservable.

### Footer scopes

Precedence is persistent command configuration, then
`PI_CACHE_OPTIMIZER_FOOTER_MODE`, then default `session`.

| Mode | Source |
|---|---|
| `session` (default) | Current-day shards with the current session hash and exact model key. `/reload` creates a new instance shard but remains in the same session scope. |
| `total` | All valid current-day local shards for the exact model key, including observable child Pi agents and other Pi sessions. |
| `process` | Current extension instance's in-memory/shard counters only; restart or `/reload` begins at zero. |

The footer shows only the active/effective model. A selected matching model with no
data shows `0/0`; unsupported models clear the footer. Router restore uses the most
recent valid `lastRoutedModel` among current-session shards and applies the same
selected scope without cross-fallback.

### Command views

* `/cache-optimizer stats` lists detailed current-session statistics for every
  cache-adapter-matched model used today. The active model appears first and may
  appear as an empty `0/0` bucket when unseen. Other sessions are excluded.
* `/cache-optimizer stats all` lists detailed current-day totals for every exact
  provider/model across all valid local shards. Each block includes contributing
  session/instance counts, requests, cached/total input tokens, and a compact line
  such as `4/5·0.66M/0.84M 78.7%`.
* `/cache-optimizer stats contributors` shows current/other contributing sessions
  for the active exact model. Output MUST NOT expose raw session ids or hashes.
* Native completion includes `stats all` and `stats contributors`. Unknown prefixes
  return `null`.
* Recent samples remain current-instance memory only and MUST NOT be represented as
  an all-session trend.

### Reset epochs

Enable/disable advances a global epoch. `/cache-optimizer reset` advances an epoch
for the active exact model. Aggregation accepts a shard/model entry only when both
epochs equal the current epoch files. This makes old shards immediately invisible
without modifying other writers and prevents reset resurrection. An active writer
MUST re-read global/model epochs before its next usage update and clear only the
affected current-instance counters before recording new usage.

Reset remains a local-statistics operation across local sessions for the exact model;
it does not alter upstream provider cache contents.

### Upgrade behavior

`pi-cache-optimizer-stats.json` and `deepseek-cache-optimizer-stats.json` are obsolete.
Runtime startup MUST NOT parse or migrate them. It best-effort deletes both files and
starts v7 local counters from zero. Deletion failure warns but does not block hooks.
Legacy v1-v6 parser helpers may remain test-only historical references, but they MUST
NOT be connected to runtime restore/persistence.

### Design decision: shard aggregation without parent-child protocol

#### 1. Scope / Trigger

This contract applies whenever multiple Pi processes or in-process extension instances record cache usage under one agent directory, including subagents, parallel Pi terminals, reloads, and routers.

#### 2. Signatures

```ts
readValidStatsShardsV7(directory?: string): Promise<PersistedStatsShardV7[]>;
aggregateStatsShardsV7(shards: PersistedStatsShardV7[], day?: string): Promise<ShardAggregate>;
writeStatsShardV7(path: string, shard: PersistedStatsShardV7): Promise<void>;
```

#### 3. Contracts

* Each instance writes only its UUID shard through unique-temp + atomic rename.
* `session`, `total`, and `process` use explicit session/model/day/epoch scopes.
* Parent-child relationships are never inferred from PID, PPID, environment variables, or adapter labels.
* Old v6 files are deleted/ignored, not imported; reset epochs are exact-model or global local-stat views.

#### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| Missing shard directory | Treat as empty and create it for the current instance. |
| Malformed/unknown shard | Ignore during aggregation; retain until cleanup retention. |
| Symlink in shard directory | Do not follow or delete the target. |
| Missed `fs.watch` event | Keep persisted data; refresh on lifecycle or explicit command. |
| Old active shard with live PID | Retain conservatively during cleanup. |
| Epoch mismatch | Ignore stale data; the writer adopts current epochs before its next usage. |

#### 5. Good / Base / Bad Cases

* **Good**: two instances write separate shards for `proxy/gpt-5.5`; `total` adds both and `session` isolates them.
* **Good**: `proxy/gpt-5.5` and `other/gpt-5.5` remain separate despite sharing an adapter family.
* **Base**: a child that does not load this extension contributes nothing; the footer remains truthful.
* **Bad**: one process rewrites another instance's shard or a process-global pool combines unrelated sessions.

#### 6. Tests Required

Assert shard isolation, exact model aggregation, session/total/process scopes, epoch invalidation, old-file deletion, malformed/symlink safety, current-day retention, cleanup lease behavior, lifecycle refresh, and detailed stats output.

#### 7. Wrong vs Correct

```ts
// Wrong: no task/session ownership boundary.
globalThis.__piCacheOptimizerLiveTotals__ = totals;

// Correct: one writer owns one shard; readers aggregate by explicit rules.
await writeStatsShardV7(instanceShardPath, currentInstanceShard);
```

### Lifecycle and refresh

* `message_end` uses finalized assistant provider/model/api/usage identity, updates
  the current instance, and debounces its shard write. Error/aborted messages do not
  increment requests.
* `session_shutdown` cancels pending debounce, writes a final `closed` shard, closes
  the watcher, uninstalls owned protocols, and restores the retention environment.
  It MUST NOT delete the current-day shard.
* In TUI mode, `fs.watch` provides low-latency shard notifications. The watcher is
  unreferenced and closed on shutdown.
* `tool_execution_end`, `agent_settled`, session/model lifecycle events, and explicit
  stats/doctor/config/reset commands force aggregate refreshes. Watch delivery is an
  optimization, not a correctness dependency.
* There is no permanent polling interval. A missed watch event may delay an idle
  footer update, but lifecycle or explicit-command refresh restores authoritative
  shard totals.
* Local-day rollover clears the current instance's stale counters. Aggregation ignores
  every shard whose top-level or stats day is not the current local day.

### Cleanup

Maintenance runs best-effort under an atomic `mkdir` cleanup lease and at most once
per six hours. A lease older than one hour is recoverable.

* Keep every current-day shard, including `closed` shards and shards whose PID exited.
* Delete eligible non-current-day shards after 48 hours. If an old shard is marked
  active and its PID is still alive, conservatively retain it.
* Delete extension-owned temp files after 24 hours.
* Ignore malformed shards during aggregation; delete them only after retention.
* Operate only on direct children with recognized extension filenames, require regular
  files from `lstat`, and never follow symlinks.
* Global epoch is one replaceable file. Model epoch files are one per hashed exact
  model key, so repeated reset does not create unbounded files.

### Validation matrix

| Scenario | Expected behavior |
|---|---|
| Two Pi processes update the same model concurrently | They write different UUID shards; total aggregation includes both without overwrite. |
| Two independent Pi terminals use the same provider/model | Default session footer remains isolated; `total` and `stats all` include both. |
| Child uses same exact provider/model | Its shard contributes to `total`/`stats all`; it does not enter the parent's session scope when session hashes differ. |
| Child uses another provider or model | It stays in a separate model block and never changes the active model's hit rate. |
| `/reload` in one session | New instance/process counters start at zero; session scope aggregates old/new shards exactly once. |
| Model/global reset while another writer is active | Old epoch data disappears; the writer switches epoch before its next recorded request. |
| Old v6 file exists | It is not imported and is best-effort deleted; v7 begins at zero. |
| Watch event is missed | Stored counters remain correct; lifecycle/command refresh updates the footer later. |
| Child exits after writing | Its current-day closed shard remains visible until retention cleanup on a later day. |
| Corrupt or symlink shard | It is ignored safely; symlink targets are never followed/deleted. |
| Router message carries upstream metadata | Final stats use message-local upstream identity, not live global route state. |
| Transport returns no cache usage | Keep truthful zero/under-reporting; never synthesize hits. |

### Permanent tests required

* Parse/drop malformed v7 shards without throwing; never expose raw session ids.
* Independent extension instances create distinct files and aggregate exact keys.
* Session/total/process scopes, reload continuity, router restore, and provider/model
  isolation are covered.
* Default mode is session; config/env precedence remains stable.
* `stats`, `stats all`, contributors, compact request/token formatting, and completion
  are covered.
* Global/model epoch resets cannot resurrect old shard data.
* Shutdown writes closed state; current-day closed shards survive cleanup.
* Old shard/temp retention, active-PID conservatism, lease recovery, malformed files,
  and symlink safety are covered.
* `fs.watch` is TUI-only and no permanent fallback poll is installed.
* Existing adapter, routing, request-hook, compat-fix, TTL, prompt-integrity, typecheck,
  pack, and diff checks remain green.

---

## System prompt reordering invariants

`index.ts` exposes `optimizeSystemPrompt(original, opts)` which is invoked
from the `before_agent_start` hook to lift stable content above dynamic
content. Candidate extraction MUST use a verified source offset. Before any
candidate is removed, occurrence counts for all normalized/deduplicated candidates
MUST be computed against the same immutable initial remainder. A candidate is
eligible only when that initial count is exactly one; if a second occurrence
exists (including an overlapping occurrence), the candidate is ambiguous and
MUST be skipped. This also covers nested candidates such as a full context-file
block plus its bare content: removing the full block must not make the dynamic
copy of its bare content appear newly unique.

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
  rejection rationale stays close to the source-offset extraction.
* Ambiguous candidates MUST leave the entire prompt byte-for-byte unchanged for
  that candidate. Do not select the first or last occurrence heuristically.

### Wrong vs Correct: candidate occurrence timing

#### Wrong

```ts
// `rest` shrinks after each accepted candidate, so a nested candidate can
// become falsely unique and delete its dynamic copy.
if (rest.indexOf(part, rest.indexOf(part) + 1) < 0) {
  rest = rest.replace(part, "");
}
```

#### Correct

```ts
// Classify every candidate against one immutable snapshot before any removal.
const initialRemainder = original;
const counts = countOverlappingOccurrences(candidates, initialRemainder);
for (const part of candidates) {
  if (counts.get(part) !== 1) continue;
  rest = removeAtVerifiedOffset(rest, part);
}
```

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

* Writing `models.json` outside `/cache-optimizer fix`'s explicit preview + confirmation flow. The fix flow may create a timestamped backup and atomically replace `models.json`. For providers/models that already have entries, it only inserts/repairs safe `compat` keys or a missing `compat` object at the effective provider/model/modelOverrides layer. For API-logged-in providers (e.g. opencode go) that have no custom model entry, it MAY offer to create a minimal compat-only `modelOverrides` entry with UI confirmation, backup, and atomic write; it MUST NOT create custom model definitions, API keys, credentials, base URLs, or router slugs under any scenario.
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
· OpenAI cache 0/0·0M/0M 0.0% ⚠️ compat
```

DeepSeek-like models using Pi Mono guidance may also surface `⚠️ compat` when
`requiresReasoningContentOnAssistantMessages` or `thinkingFormat: "deepseek"`
are missing, even when the provider is otherwise not a generic proxy.
Native `anthropic-messages` adaptive-generation models may also surface
`⚠️ compat`: Claude opus-4.6+ including Opus 5, sonnet-4.6+ including Sonnet 5,
and fable-5+ require `forceAdaptiveThinking: true`; Kimi Coding K3 / `kimi-for-coding`
require `forceAdaptiveThinking: true` and `allowEmptySignature: true` for
empty-signature thinking replay.

Rules:

* The marker is one-shot per model key (provider/id). It shows once and persists
  while that model remains active and compat is still missing.
* When the model is switched or its compat is fixed, the marker clears.
* The marker coexists with `⚠️ integrity` — both can appear:
  `· OpenAI cache 0/0·0M/0M 0.0% ⚠️ integrity ⚠️ compat`
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

The extension registers a Pi command `/cache-optimizer` with runtime, diagnostic,
configuration, repair, and reset subcommands. It MUST register Pi's native
`getArgumentCompletions(argumentPrefix)` callback rather than a custom editor or
autocomplete provider. TypeScript validation consumes the installed official Pi
0.84.2 declarations directly; a complete local ambient redeclaration is forbidden
because it can hide upstream API drift. Pi 0.84's expanded event/context surface
is compatible with the subset used here. The callback completes the supported top-level
subcommands (`enable`, `disable`, `doctor`, `stats`, `config`, `compat`, `reset`,
and `fix`), the nested `config footer-mode` path, and the values `total`,
`session`, and `process`. Suggestions are case-insensitive prefix matches after
leading/trailing whitespace is tolerated; an unknown or non-matching prefix
returns `null` so Pi can fall back normally. Command execution parsing remains
unchanged.

### `/cache-optimizer enable` / `/cache-optimizer disable`

These are current-process runtime switches, not persistent config writes.

* `enable` turns runtime optimization back on, requests `PI_CACHE_RETENTION=long`,
  resets local footer stats/recent samples for before/after comparison,
  republishes the footer, and shows a status summary for prompt rewrite,
  OpenAI-compatible `prompt_cache_key` fallback, footer stats, compat warnings, and
  `PI_CACHE_RETENTION`.
* `disable` turns runtime optimization off, restores the process-original
  `PI_CACHE_RETENTION` value (or unsets it if it was originally unset), suppresses prompt mutations,
  OpenAI-compatible `prompt_cache_key` fallback, and compat warnings, resets
  local footer stats/recent samples, keeps collecting footer stats in disabled
  comparison mode, republishes the footer as `· Cache Optimizer disabled · <stats>`
  for adapter-matched models, and shows the same status summary. The retention
  baseline is stored as a validated process-global versioned snapshot so an
  extension module reload cannot mistake its own `long` mutation for the original value.
* Neither command writes environment files, Pi settings, or `models.json`. They do
  persist the local stats reset so the comparison footer starts from 0/0.
  Run `/reload` or restart Pi to return optimizer runtime behavior to startup defaults.

### `/cache-optimizer config footer-mode total|session|process`

Persistently selects the footer display scope in
`<Pi agent dir>/pi-cache-optimizer-config.json`.

* `session` writes `{ "version": 1, "footerMode": "session" }`.
* `total` writes `{ "version": 1, "footerMode": "total" }`.
* `process` writes `{ "version": 1, "footerMode": "process" }`.
* Precedence is persistent config > environment > default `session`.
* Writes use temp file + atomic rename.
* To restore environment/default resolution, manually delete
  `pi-cache-optimizer-config.json` and run `/reload`; the command does not expose
  a configuration-delete option.
* Malformed/unreadable config never blocks hooks or deletes the file; the extension
  logs a warning and falls back to environment/default behavior.
* Changing the mode republishes the current footer immediately and does not reset
  or mutate any stats buckets.
* The config file contains only versioned mode metadata; no session ids, counters,
  prompts, credentials, payloads, headers, or model output.

### `/cache-optimizer doctor`

Shows current active model status: provider, model id/name, API type, base URL,
merged compat flags, and whether any cache/session-affinity compat flags are missing.
If compat flags are missing, includes a copyable safe JSON suggestion and the edit
location (`<Pi agent dir>/models.json -> providers.<id> -> compat`; default
`~/.pi/agent/models.json`). The JSON only
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
  `anthropic-messages` Claude opus-4.6+ (including Opus 5)/sonnet-4.6+
  (including Sonnet 5)/fable-5+ and Kimi Coding K3 / `kimi-for-coding`; the Kimi Coding models also
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
  full file; it locates existing provider/model/modelOverrides/compat nodes while
  respecting string literals, escapes, line comments, block comments, and trailing
  commas.
* Writes by unique non-overwriting backup → temp file → atomic rename. Post-write
  self-check reparses JSONC, validates effective merged compat, and verifies the
  original parsed structure is preserved except for repaired compat keys.
* The original `models.json` access mode MUST be preserved exactly for the backup,
  committed replacement, and rollback. The extension MUST NOT independently
  tighten or loosen permissions: `0600` remains `0600`, `0644` remains `0644`, and
  other existing modes remain unchanged.
* On post-write failure, rollback MUST also use temp file + atomic rename; direct
  in-place copy over `models.json` is forbidden.
* Effective compat validation MUST use Pi precedence:
  `modelOverrides[modelId].compat` > matching `models[].compat` > provider
  `compat`. A write to a lower layer that remains shadowed by a conflicting
  higher layer MUST fail self-check.
* If the target already has a `modelOverrides[modelId]` entry, the fix MUST repair
  that highest-precedence entry directly. For a built-in/API-login model without
  a custom `models[]` entry, the fix MAY create a provider and/or compat-only
  `modelOverrides[modelId]` entry after preview and confirmation. It MUST NOT
  invent a custom `models[]` definition, API key, credential, base URL, or router
  slug.
* Direct command execution and the interactive menu MUST call the same command
  handler for Enable, Disable, Doctor, Stats, Compat, Fix, Footer mode, and Reset.
  Security-sensitive transaction logic MUST NOT be duplicated in a menu-only path.

#### Wrong vs correct: preserving `models.json` during fix

```ts
// Wrong: the temp file gets the process default mode (often 0644), and the
// rollback writes directly over the live file.
await copyFile(modelsPath, backupPath);
await writeFile(tempPath, modifiedText, "utf8");
await rename(tempPath, modelsPath);
await copyFile(backupPath, modelsPath);
```

```ts
// Correct: capture the existing mode, refuse to overwrite a backup, and use
// mode-preserving atomic replacement for both commit and rollback.
const mode = (await stat(modelsPath)).mode & 0o7777;
await copyFile(modelsPath, backupPath, COPYFILE_EXCL);
await chmod(backupPath, mode);
await atomicReplaceTextFilePreservingMode(modelsPath, modifiedText, mode, "fix");
if (postCheckFailed) {
  await atomicRestoreFileFromBackup(backupPath, modelsPath, mode);
}
```

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
Footer mode is also available as a `Footer mode` item in this menu, with `total`,
`session`, and `process` choices. The explicit
`config footer-mode total|session|process` command remains available for direct use.
Selecting a menu subcommand executes the corresponding logic. Cancel closes the menu.

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
  only for the current extension instance's active-model diagnostics. `stats all`
  MUST use persisted shard counters and MUST NOT claim an all-session recent trend.

### Router/channel diagnostics

The `describeRouterChannelDiagnostics(model)` function inspects `ctx.model`
metadata (provider, api, baseUrl, compat) to detect common router/channel proxy
patterns and returns advisory notes. It is called by both `buildDoctorDiagnosis`
and `buildCompatDiagnosis`.

This function is **advisory only**. It does NOT participate in:
- Adapter selection (still id/name-only)
- `prompt_cache_key` injection
- Footer stats
- Unprompted configuration changes; the explicit `config footer-mode` command is separate from router diagnostics

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
- Any content from Pi's agent-dir `models.json` beyond what the Pi runtime exposes
  via `ctx.model`

### Validation matrix (additional rows)

| Scenario | Expected behavior |
|---|---|
| `/cache-optimizer doctor` with generic proxy missing session affinity | Output includes `Missing compat flags: sendSessionAffinityHeaders`, a copyable safe JSON suggestion with `sendSessionAffinityHeaders: true`, the configured agent-dir `models.json -> providers["<id>"]` path (default `~/.pi/agent/models.json`), optional/risky guidance for `supportsLongCacheRetention`, and credential-safe guidance that keeps existing authentication as-is while placing only compat overrides in `models.json` |
| `/cache-optimizer doctor` with DeepSeek-like Pi Mono model missing reasoning compat | Output includes missing `requiresReasoningContentOnAssistantMessages` and `thinkingFormat`, plus copyable JSON with `requiresReasoningContentOnAssistantMessages: true` and `thinkingFormat: "deepseek"`. For `openai-responses`, it does not suggest removed `sendSessionIdHeader`; Pi 0.80.7+ owns header shape through `sessionAffinityFormat`. |
| Kimi Coding K3 custom `anthropic-messages` model missing adaptive compat | Footer/doctor/compat show missing `forceAdaptiveThinking` and `allowEmptySignature`; `/cache-optimizer fix` suggests both at model scope when sibling models are mixed. Moonshot/OpenRouter K3 variants on `openai-completions` remain in the Kimi/proxy path and do not receive Kimi Coding adaptive compat. |
| `/cache-optimizer compat` with DeepSeek-like Pi Mono model missing reasoning compat | Shows the same DeepSeek-specific JSON suggestion and edit location; custom transports still show not-applicable. |
| `/cache-optimizer doctor` without an active model | Notification: "No active model selected" |
| `/cache-optimizer doctor` with applicable fully-configured model | Shows `✅ Compat fully configured.` (without "(or not applicable)") |
| `/cache-optimizer doctor` with non-applicable model (official OpenAI, non-openai-completions, custom transport) | Shows `ℹ️ Compat check not applicable for this model.` |
| `/cache-optimizer compat` with a fully configured applicable model | Shows `✅ Compat fully configured.` |
| `/cache-optimizer compat` with a non-applicable model | Shows `ℹ️ Compat check not applicable for this model.` |
| `/cache-optimizer enable` | Runtime optimizer becomes enabled, `PI_CACHE_RETENTION=long` is requested, local footer stats/recent samples reset, footer republishes, and notification lists active feature states |
| `/cache-optimizer disable` | Runtime optimizer becomes disabled for this Pi process, the process-original `PI_CACHE_RETENTION` is restored/unset even after extension reload, local footer stats/recent samples reset, adapter-matched footer shows `· Cache Optimizer disabled · <stats>`, and notification lists disabled feature states |
| Runtime disabled before hooks fire | `before_agent_start` returns `{}`, `before_provider_request` does not add `prompt_cache_key`, `message_end` continues updating comparison stats, and session/model compat warnings are suppressed |
| `/cache-optimizer` (no args) with UI supports select | Shows interactive selection menu (Enable / Disable / Doctor / Stats / Compat / Fix / Reset / Cancel); choosing Fix executes the same confirmed backup/write/self-check contract as direct `/cache-optimizer fix` |
| `/cache-optimizer` (no args) without UI | Text help lists `enable`, `disable`, `doctor`, `stats`, `compat`, `reset` subcommands plus runtime state |
| Footer status for generic proxy after `/cache-optimizer fix` added `sendSessionAffinityHeaders` but `supportsLongCacheRetention` remains absent | No `⚠️ compat`; doctor/compat may still show optional long-retention guidance, but the model is considered safely configured |
| Every non-empty extension footer status | Begins with `· `, including disabled-mode, router-restored, integrity-warning, and compat-warning variants; other extension statuses remain visibly separated |
| `/cache-optimizer` argument completion | Native `getArgumentCompletions` offers top-level commands, `config`, `config footer-mode`, and `total`/`session`/`process`, filters by prefix, tolerates surrounding whitespace, and returns `null` for unknown prefixes |
| Footer status when compat is fixed or model changes | `⚠️ compat` marker clears |
| `/cache-optimizer fix` with API-logged-in model not in models.json (interactive UI) | Analyzes models.json, shows a preview of a compat-only `modelOverrides[modelId]` entry, confirms, writes atomically with backup, validates the effective three-layer result, and succeeds |
| `/cache-optimizer fix` with API-logged-in model not in models.json (non-interactive) | Shows manual guidance with complete JSON snippet, keeps existing auth as-is, includes fallback for both missing-provider and missing-model scenarios |
| Direct `/cache-optimizer fix` and no-args menu Fix | Both paths call the same command handler. Permanent command-level tests run both against a temporary `PI_CODING_AGENT_DIR`, require confirmation, compare the unique backup byte-for-byte, preserve the original access mode, parse the written JSONC, validate effective modelOverrides compat, and assert comments/credentials/unrelated fields remain unchanged |
| `/cache-optimizer fix` creates new provider entry in models.json | Does NOT create API keys, credentials, baseUrl, router slugs, or a custom `models[]` definition; only inserts a minimal compat-only `modelOverrides` structure |
| `/cache-optimizer fix` sees an existing target `modelOverrides` entry | Repairs its compat directly and preserves comments, unrelated keys, sibling overrides, custom models, and provider-level configuration |
| `/cache-optimizer fix` writes provider/model compat while a conflicting target override remains | Pre-write self-check rejects the ineffective lower-layer edit and no file is written |
| `/cache-optimizer doctor` with OpenRouter model | Output includes `🔀 Router/channel: OpenRouter detected` with routing fix suggestion and JSON example for `openRouterRouting` |
| `/cache-optimizer doctor` with Vercel AI Gateway model | Output includes `🔀 Router/channel: Vercel AI Gateway detected` with `vercelGatewayRouting` suggestion |
| `/cache-optimizer doctor` with LiteLLM/OneAPI/NewAPI/VoAPI model | Output includes `🔀 Router/channel: Self-hosted aggregation proxy detected` with sticky routing and prompt_cache_key guidance |
| `/cache-optimizer doctor` with generic third-party OpenAI-compatible proxy | Output includes `🔀 Router/channel: Third-party OpenAI-compatible proxy` with general guidance |
| `/cache-optimizer doctor` with official OpenAI, untouched built-in `llama.cpp`, or kiro-api model | Output does NOT include router/channel notes; a custom/overridden same-id `llama.cpp` proxy remains diagnosable |
| `/cache-optimizer compat` with missing-compat OpenRouter model | Shows missing flags + safe JSON + OpenRouter channel notes + credential-safe `models.json` guidance with provider-level and `modelOverrides` examples |
| `/cache-optimizer compat` with fully-configured OpenRouter model | Shows `✅ Compat fully configured.` followed by OpenRouter channel notes; if `supportsLongCacheRetention` is enabled, also includes the `prompt_cache_retention` 400 recovery hint |
| Router/channel diagnostics do not affect adapter selection | An OpenRouter Llama model still selects the Llama adapter, not an "OpenRouter" adapter |
| Diagnostic text must not expose API keys, prompts, payloads, or model output | All router/channel output uses only provider, api, baseUrl, compat metadata |
| Third-party OpenAI-compatible proxy (`openai-completions` or `openai-responses`) returns HTTP 400 while `supportsLongCacheRetention` is enabled | Extension records a one-time model-scoped warning from an explicit response-header or assistant-error-message `prompt_cache_retention` unsupported signal; subsequent current-process requests strip the parameter and `/cache-optimizer doctor` surfaces the recovery hint. Routed assistant errors use message-local provider/model/API identity even without a live registry; value-validation-only `bad request` errors do not activate the fallback. |
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
