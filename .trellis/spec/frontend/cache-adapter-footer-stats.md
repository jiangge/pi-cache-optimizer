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
| Anthropic / Claude | `anthropic`, `claude` | `Claude cache` |
| Gemini / Vertex | `gemini`, `vertex` | `Gemini cache` |

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
  using an OpenAI-shaped API (including Kimi, Qwen, GLM, MiniMax, Hunyuan, and
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
  skill compression, stable-prefix reorder) can be disabled with:
  `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` (truthy: `1`, `true`, `yes`, `on`).
  Footer stats and the OpenAI `prompt_cache_key` fallback remain active.
* Official OpenAI Responses / Codex prompt bypass remains unchanged: the
  `before_agent_start` hook still avoids prompt rewriting for
  `openai-codex-responses` and `openai-responses`.

#### Third-party OpenAI-compatible proxy compat warning

For models using `api: "openai-completions"` through a non-official
base URL (not `api.openai.com`), warn once per model when merged compat lacks
one or both of:

```json
{
  "supportsLongCacheRetention": true,
  "sendSessionAffinityHeaders": true
}
```

This warning is advisory only and MUST NOT mutate the user's `models.json`.

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

## Persisted stats schema

Stats are persisted per provider/model, not only per provider family. Adapter
selection remains id/name-only; the active model's `provider` participates only
after adapter selection, as part of the stats bucket key.

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

type PersistedCacheStatsV3 = {
  version: 3;
  statsByModel: Record<string, CacheStats>; // key = `${model.provider}/${model.id}`
  legacyFamily: Partial<Record<CacheProviderId, CacheStats>>;
};
```

* `CacheStats` counters MUST be non-negative integers; `hitRequests <=
  totalRequests`; `cachedInputTokens <= totalInputTokens`;
  `cacheWriteInputTokens <= totalInputTokens`.
* `statsByModel` is authoritative for all turns where `ctx.model` is known.
  This separates e.g. `otokapi/gpt-5.5` from `cafecode/gpt-5.5` while keeping
  the footer label (`OpenAI cache`) provider-family based.
* `legacyFamily` exists only as a migration/fallback bucket for pre-v3 data and
  rare `message_end` updates where no active model is available. New normal
  updates MUST write `statsByModel[modelKey(ctx.model)]`.
* The persisted file MUST contain only counters and local dates. Never persist
  API keys, prompts, request payloads, response bodies, HTTP headers, model
  outputs, or provider config snapshots.
* Writes MUST remain atomic: write a temp file then `rename` into
  `~/.pi/agent/pi-cache-optimizer-stats.json`; never update the JSON in place.

### Stats migration

| Input state | Behavior |
|---|---|
| `version: 3` | Parse valid `statsByModel` entries and valid `legacyFamily` entries; silently drop malformed entries. |
| `version: 2` with `statsByProvider` | Migrate valid family buckets to `legacyFamily`; initialize `statsByModel` as `{}`. |
| `version: 1` single DeepSeek stats | Migrate valid stats to `legacyFamily.deepseek`; initialize `statsByModel` as `{}`. |
| Unknown version / invalid top-level shape | Treat as unreadable stats and fall back to empty in-memory state. |

### Migration on first run after rename

| Condition | Behavior |
|---|---|
| New path readable | Use it. Do not read or touch the old path. If it is v1/v2, migrate in memory to v3 and persist on the next normal write. |
| New path missing AND old path readable | Parse old path (v1/v2/v3), write the v3 shape to the new path atomically, best-effort `unlink` old path. |
| New path missing AND old path also missing | Initialize `statsByModel: {}` and empty family buckets in memory. |
| New path readable but corrupt JSON | Log a one-line warning, fall back to empty counters; do NOT delete it. The next valid write may replace it through the regular atomic write path. |
| Old path corrupt | Log a one-line warning, do NOT delete the old file, do NOT write the new file from corrupt data. |

### Display and update semantics

* `modelKey(model)` is exactly ``${model.provider}/${model.id}``. Do not use
  `name`, `baseUrl`, `api`, or compat flags in the key.
* `session_start` restores persisted stats unless `event.reason === "reload"`.
  On reload, clear `statsByModel`, reset family buckets to empty stats, clear the
  last footer text, and flush the empty v3 state immediately.
* `model_select` and `session_start` publish status for the selected/current
  model. If the model matches an adapter but has no `statsByModel` entry yet,
  display an empty same-day footer (`0/0`, `0M/0M`) instead of showing migrated
  family aggregate data from `legacyFamily`.
* `message_end` chooses the provider-family adapter from assistant message
  `model`/`name` plus active model id/name, normalizes usage, then updates
  `statsByModel[modelKey(ctx.model)]` when `ctx.model` exists. Only when
  `ctx.model` is unavailable may it update `legacyFamily[adapter.id]`.
* Footer text remains provider-family labelled (one of: `DS cache`, `OpenAI cache`,
  `Kimi cache`, `Qwen cache`, `GLM cache`, `MiniMax cache`, `Hunyuan cache`,
  `Claude cache`, `Gemini cache`) but the counters shown are for the active
  provider/model key.
* Local day rollover is checked before publish/update. Any entry in
  `statsByModel` or `legacyFamily` whose `day` differs from the current local
  day is replaced with empty same-day stats and persisted immediately.
* Debounced persistence is allowed for ordinary `message_end` writes, but reload
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
| Model id/name looks GPT-like or Kimi/Qwen/GLM/MiniMax/Hunyuan-like but API is a custom transport (e.g. `kiro-api`) | Do not add OpenAI `prompt_cache_key`; do not assume compat layers reach custom transports. |
| Third-party `openai-completions` proxy (GPT, Kimi, Qwen, GLM, MiniMax, Hunyuan, etc.) missing cache/session-affinity compat | Warn once per model with a copyable `compat` suggestion; do not edit `models.json`. |
| Old stats path exists, new stats path missing | Read old v1/v2/v3 data, write the new path atomically in v3 shape, best-effort `unlink` old. v2 `statsByProvider` data moves to `legacyFamily`. |
| New v2 stats file exists | Load v2 `statsByProvider` into `legacyFamily`; start with empty `statsByModel`; next write persists v3. |
| New v3 stats file has entries for `otokapi/gpt-5.5` and `cafecode/gpt-5.5` | Selecting either model displays only that key's counters, even though both use the OpenAI-family footer label. |
| Selected matching model has no `statsByModel` entry yet | Display empty same-day stats (`0/0`, `0M/0M`) instead of legacy family aggregate counters. |
| `/reload` session_start reason | Clear model-scoped and legacy counters, persist empty v3 state immediately, then publish empty current-model footer. |
| Non-GPT OpenAI-compatible model (Kimi, Qwen, GLM, MiniMax, Hunyuan, Mistral, Grok, Llama, Nemotron, Cohere, Yi) with `openai-completions` API | Selected adapter shows the corresponding footer label; compat warning fires for non-official base URLs missing cache/session-affinity flags. |
| Model id/name contains both GPT-family and non-GPT tokens (e.g. `kimi-gpt-4`) | GPT adapter takes precedence (earlier in `CACHE_PROVIDER_ADAPTERS`). Footer shows `OpenAI cache`, stats still scoped by provider/model key. |
| Local day changes | Reset every stale `statsByModel` and `legacyFamily` entry to empty current-day stats before publishing/updating, and persist immediately. |
| New stats path corrupt | Log warning, fall back to empty in-memory counters; do not delete. Next valid write may replace it atomically. |

---

## Tests required for footer stats changes

When modifying cache stats, migration, rollover, or footer behavior, add/update a
task-level verification script that asserts:

* `modelKey()` returns distinct `provider/id` keys for same-id models under
  different providers (for example `otokapi/gpt-5.5` vs `cafecode/gpt-5.5`).
* v3 parse/round-trip preserves valid `statsByModel` and `legacyFamily` entries
  and drops malformed entries without throwing.
* v2 `statsByProvider` migrates to `legacyFamily` with empty `statsByModel`; v1
  migrates only to `legacyFamily.deepseek`.
* `message_end` with an active model updates only that model key; selecting a
  different provider with the same model id does not show or mutate the first
  provider's counters.
* A matched-but-unseen model displays empty current-day stats rather than
  migrated family aggregate data.
* `/reload` clears persisted and in-memory v3 state, and local-day rollover
  resets both `statsByModel` and `legacyFamily` entries.
* Existing validation still passes: unsupported models clear the footer, corrupt
  stats fall back safely, and atomic write / `npm pack --dry-run` / `git diff
  --check` remain green.
* New adapters for Kimi, Qwen, GLM, MiniMax, Hunyuan, Mistral, Grok/xAI, Llama, Nemotron, Cohere, Yi: each detection function
  returns correct results for id/name matches and non-matches, assistant message
  matching is role-gated, and compat warnings use the broadened
  `describeMissingOpenAICompatibleProxyCompat`.

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

## Forbidden patterns

* Creating, backing up, overwriting, or deleting provider/model entries in `models.json`. This extension may mention `models.json` only in advisory compat text.
* Reading or logging the value of `DEEPSEEK_API_KEY` (or any other API key env var).
* Storing prompts, request payloads, response bodies, or HTTP headers in any
  on-disk file produced by this extension.
* Injecting OpenAI `prompt_cache_key` into non-OpenAI-compatible custom APIs.
* Deriving OpenAI `prompt_cache_key` from prompt content or stable-prefix hashes; use the Pi session id fallback instead.
* Overwriting a non-empty user/Pi-provided `prompt_cache_key` or `promptCacheKey`.
* Adapter selection by `provider` id, API type, base URL, or compat flags.
* Reverting footer stats to provider-family-only buckets for normal updates; use
  v3 `statsByModel` provider/id buckets for active-model turns and keep
  `legacyFamily` only for migration/fallback.
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
API through a non-`api.openai.com` base URL) and its merged `compat` lacks one
or both of `supportsLongCacheRetention` or `sendSessionAffinityHeaders`, the
footer status line appends `⚠️ compat`:

```text
OpenAI cache 0/0 · 0M/0M tok ⚠️ compat
```

Rules:

* The marker is one-shot per model key (provider/id). It shows once and persists
  while that model remains active and compat is still missing.
* When the model is switched or its compat is fixed, the marker clears.
* The marker coexists with `⚠️ integrity` — both can appear:
  `OpenAI cache 0/0 · 0M/0M tok ⚠️ integrity ⚠️ compat`
* The marker uses `describeMissingOpenAICompatibleProxyCompat` internally, which
  does NOT require the model to be GPT-family — it fires for ANY model using
  `openai-completions` through a non-official base URL.
* Official OpenAI base URLs (`api.openai.com`) never trigger the marker.
* Custom transports (`kiro-api`, `anthropic-messages`, etc.) never trigger the marker.

---

## Diagnostic command (`/cache-optimizer`)

The extension registers a Pi command `/cache-optimizer` with two subcommands:

### `/cache-optimizer doctor`

Shows current active model status: provider, model id/name, API type, base URL,
merged compat flags, and whether any cache/session-affinity compat flags are missing.
If compat flags are missing, includes a copyable JSON suggestion and the edit location
(`~/.pi/agent/models.json -> providers.<id> -> compat`).

When the compat check applies (third-party `openai-completions` proxy) and no flags
are missing, shows `✅ Compat fully configured.`
(`ℹ️ Compat check not applicable for this model.` for non-applicable scenarios such
as official OpenAI, non-`openai-completions` APIs, or custom transports like
`kiro-api`).

The output MUST NOT include API keys, secrets, prompts, payloads, headers, or model
output.

### `/cache-optimizer compat`

Shows only the compat suggestion for the active model, including the file path,
provider selector, exact edit location, and the copyable JSON snippet.
On success (no missing flags), shows the same applicability-respecting text as
the doctor command: `✅ Compat fully configured.` or `ℹ️ Compat check not applicable
for this model.`

### No arguments

When the Pi UI supports it (`ctx.ui.select` available), shows an interactive
selection menu with options: Doctor, Compat, Cancel. Selecting Doctor or Compat
executes the corresponding subcommand logic. Cancel closes the menu.

In non-interactive terminals (no `ui.select`), falls back to a short text help
listing available subcommands and a one-line summary of the active model's compat
status (using the same applicability-respecting text as doctor/compat).

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
| `/cache-optimizer doctor` with model that has missing compat flags | Output includes `Missing compat flags: supportsLongCacheRetention, sendSessionAffinityHeaders` and a copyable JSON suggestion with `~/.pi/agent/models.json -> providers["<id>"]` path |
| `/cache-optimizer doctor` without an active model | Notification: "No active model selected" |
| `/cache-optimizer doctor` with applicable fully-configured model | Shows `✅ Compat fully configured.` (without "(or not applicable)") |
| `/cache-optimizer doctor` with non-applicable model (official OpenAI, non-openai-completions, custom transport) | Shows `ℹ️ Compat check not applicable for this model.` |
| `/cache-optimizer compat` with a fully configured applicable model | Shows `✅ Compat fully configured.` |
| `/cache-optimizer compat` with a non-applicable model | Shows `ℹ️ Compat check not applicable for this model.` |
| `/cache-optimizer` (no args) with UI supports select | Shows interactive selection menu (Doctor / Compat / Cancel) |
| `/cache-optimizer` (no args) without UI | Shows text help and current model compat status summary |
| Footer status for missing-compat model | Shows `⚠️ compat` appended to the cache stats line |
| Footer status when compat is fixed or model changes | `⚠️ compat` marker clears
