# Pi Cache Optimizer

[中文说明](./README.zh-CN.md)

> **Renamed from `pi-deepseek-cache-optimizer`.** If you previously installed the old name, migrate with:
>
> ```bash
> pi remove npm:pi-deepseek-cache-optimizer && pi install npm:pi-cache-optimizer
> ```
>
> Your persisted footer counters and any existing `~/.pi/agent/models.json` are preserved automatically.

A plug-and-play Pi extension that improves provider-side KV Cache / Prompt Cache hit rates, with conservative provider-specific footer stats. Despite the original DeepSeek-only name, this package has supported DeepSeek, OpenAI, Claude, and Gemini stats adapters since 1.x — the new name reflects that scope.

> Important: prompt/KV caching is provider-side and best-effort. This extension can improve the odds of cache hits by stabilizing prompt prefixes, requesting long retention through Pi when supported, warning about obvious compat gaps, and showing lightweight footer stats for providers that expose reliable cache usage. It cannot guarantee cache hits. Third-party proxies may hide, drop, reroute, or reinterpret cache behavior.

## What it does

| Feature | How | Manual action required |
|---|---|:---:|
| 🔄 Reorders the system prompt | `before_agent_start` hook: stable prefix first, dynamic context later | ❌ Automatic |
| ⏳ Requests long cache retention | Sets `PI_CACHE_RETENTION=long` when the extension loads; Pi/provider compat decides what is sent | ❌ Automatic |
| 🔗 Conservative compat reminders | DeepSeek session-affinity reminders, plus obvious Claude cache-control guidance for compatible endpoints | ⚠️ See below |
| 📊 Provider-specific footer stats | Shows read-only cache stats for supported provider families in Pi footer/status | ❌ Automatic |

## Supported stats adapters

This release keeps the original DeepSeek behavior and adds read-only stats adapters for model families that Pi or the provider can expose safely. Adapter selection is intentionally limited to the model id/name (and assistant message `model`/`name` on `message_end`); provider id, API type, base URL, `thinkingFormat`, and compat flags never select a stats adapter.

| Adapter | Detection | Footer label | Usage fields |
|---|---|---|---|
| DeepSeek | Model id/name contains `deepseek` | `DS cache` | Pi `usage.cacheRead`/`usage.input`, or raw `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `prompt_tokens` when visible |
| OpenAI-family | Model id/name contains conservative OpenAI-family tokens such as `gpt-`, `chatgpt`, `o1`, `o3`, `o4`, or `o5` | `OpenAI cache` | Pi-normalized usage, or raw `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` with prompt/input totals |
| Anthropic / Claude | Model id/name contains `anthropic` or `claude` | `Claude cache` | Pi-normalized usage, or raw `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` |
| Gemini / Vertex | Model id/name contains `gemini` or `vertex` | `Gemini cache` | Pi-normalized usage, or raw Gemini/Vertex cached-content token metadata when visible |

Generic OpenAI-compatible proxies are **not** treated as OpenAI-family just because they use an OpenAI-shaped API or provider id. If the active model id/name is ambiguous, the extension hides the footer stats instead of guessing.

## Quickstart

1. (Optional but recommended) Read the official Pi + DeepSeek onboarding guide: [`pi_mono.zh-CN.md`](https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/pi_mono.zh-CN.md). It covers Pi installation and core configuration.
2. Install this extension:

   ```bash
   pi install npm:pi-cache-optimizer
   ```

3. On first activation, if no DeepSeek-like model is already configured, this extension auto-seeds a recommended `deepseek` provider block into `~/.pi/agent/models.json`. The seed goes BEYOND the official onboarding doc by adding `supportsLongCacheRetention: true` and `sendSessionAffinityHeaders: true` — those flags are exactly the cache-related compat the official doc omits, and they are the reason this extension's compat warnings exist. A timestamped backup `~/.pi/agent/models.json.bak.<unix-millis>` is written before any change. Existing user entries are never modified.
4. Export your DeepSeek API key in the same shell where you run `pi`:

   ```bash
   export DEEPSEEK_API_KEY='...'
   ```

   The seed references `$DEEPSEEK_API_KEY` symbolically; this extension never reads, stores, or prints the key value.
5. Opt out of auto-seeding by exporting `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1` before launching Pi. With opt-out, no write or backup happens, and no provider entry is added or modified.

## Install

```bash
pi install npm:pi-cache-optimizer
```

After installation, `PI_CACHE_RETENTION=long` is applied automatically, the system prompt is reordered automatically, `~/.pi/agent/models.json` is auto-seeded with a DeepSeek block when no DeepSeek-like model is configured, and the footer shows cache stats after supported model-family responses with exposed usage.

## Uninstall

Remove the same package source you installed. For the npm package:

```bash
pi remove npm:pi-cache-optimizer
```

If you installed from a local path, remove that same path/source instead, for example:

```bash
pi remove /absolute/path/to/pi-deepseek-cache-optimizer
# or, if that was the exact source you installed:
pi remove ./relative/path/to/pi-deepseek-cache-optimizer
```

If you installed into project settings with `pi install -l ...`, use the matching project-scope remove command, for example `pi remove -l npm:pi-cache-optimizer`.

After removing the package, run `/reload` in Pi or restart Pi so the extension is unloaded. The footer counters are persisted separately; if you also want to delete that local state, remove:

```bash
rm ~/.pi/agent/pi-cache-optimizer-stats.json
# Old name (kept once and migrated automatically; safe to delete if it still exists):
rm -f ~/.pi/agent/deepseek-cache-optimizer-stats.json
```

The DeepSeek block this extension seeded into `~/.pi/agent/models.json` is left in place on uninstall. Remove it manually if you no longer want it; the timestamped backup at `~/.pi/agent/models.json.bak.<unix-millis>` lets you compare against the previous content.

## Footer cache stats

The Pi footer displays stats for the **active model family** only, for example:

```text
DS cache 3/5 · 0.77M/0.80M tok (96%)
OpenAI cache 2/4 · 0.25M/0.70M tok (36%)
Claude cache 1/3 · 0.10M/0.45M tok (22%) · write 0.20M tok
Gemini cache 1/2 · 0.18M/0.50M tok (36%)
```

Meaning:

- `3/5`: 3 of 5 supported assistant responses for that provider family had cache-read tokens.
- `0.77M/0.80M tok`: cumulative cache-read input tokens / cumulative prompt input tokens, shown in millions.
- Percentage: `cacheRead / total prompt input`.
- `write ... tok` appears for Claude when cache-write tokens are nonzero, because Anthropic cache writes have distinct cost/accounting semantics.

Stats rules:

- Counters are separate per provider family. DeepSeek, OpenAI, Claude, and Gemini stats are not combined into one global hit rate.
- The footer shows only the active model family's label and counters; it clears/hides for unsupported or ambiguous models.
- Counts only assistant responses where Pi/provider exposes usage. Missing usage means no counter update.
- Adapter matching uses only active model id/name plus assistant message `model`/`name`; broad provider/API/compat metadata is ignored for selection.
- Pi-normalized `usage.input`, `usage.cacheRead`, and `usage.cacheWrite` are preferred. Known raw provider fields are used only defensively when visible on the assistant message.
- Total prompt input is `input + cacheRead + cacheWrite` for Pi-normalized usage. Provider raw normalizers use each provider's documented total/input fields when available.
- Stats update only the footer/status. The extension does not create extra TUI widgets or diagnostic files.
- Stats are persisted in a small local JSON state file at `~/.pi/agent/pi-cache-optimizer-stats.json`. Earlier 1.x releases used `~/.pi/agent/deepseek-cache-optimizer-stats.json`; on first run after upgrade the old file is read once, copied into the new path, and best-effort deleted. The file stores only counters and the local day; it does not store API keys, prompts, messages, headers, or model output.
- Existing v1 state files from DeepSeek-only releases are migrated into the DeepSeek adapter counters automatically.

Reset behavior:

- Pi restarts do **not** clear stats; the persisted counters are restored.
- `/reload` / extension reload resets the persisted counters because Pi exposes `session_start` with reason `reload`.
- Crossing the local natural-day boundary resets counters on the next status update or supported-provider response.

## Suggested compat config

For direct DeepSeek or DeepSeek-like OpenAI-compatible proxies, configure the provider or model `compat` like this:

```json
{
  "providers": {
    "deepseek": {
      "compat": {
        "thinkingFormat": "deepseek",
        "supportsLongCacheRetention": true,
        "sendSessionAffinityHeaders": true
      }
    }
  }
}
```

If your provider id is not `deepseek` (for example a company proxy or OpenRouter-style proxy), you can put the same fields on that provider or the specific DeepSeek model. The extension detects DeepSeek-like models only by checking whether the model id/name contains `deepseek`; it does not infer this from provider id, base URL, or `thinkingFormat`. The currently recommended verification path covers the official direct `deepseek/deepseek-v4-pro` model.

The extension warns at most once per provider/model per session when a DeepSeek-like OpenAI-compatible model is missing:

- `supportsLongCacheRetention: true`, so Pi may not send `prompt_cache_retention: "24h"`.
- `sendSessionAffinityHeaders: true` for OpenAI Completions-compatible APIs, or `sendSessionIdHeader: true` for OpenAI Responses-compatible APIs, so Pi may not send session-affinity headers such as `session_id`, `x-client-request-id`, or `x-session-affinity`.

For Claude/Anthropic models behind an OpenAI-compatible endpoint, the extension may warn when the model is clearly Claude-like but `cacheControlFormat: "anthropic"` is missing. Only enable that compat flag if your endpoint supports Anthropic-style cache-control markers.

> Reminder: only enable session-affinity headers or cache-control compat when your endpoint or proxy supports them.

## How it works

Provider caches are usually based on exact or near-exact prefix matching. Pi's system prompt contains stable content that is likely shared across sessions (tools, skills, guidelines) and dynamic content that changes frequently (git status, task context).

```text
Before: [dynamic git status | task context | stable tools + rules]
        ↓ changing prefix → lower cache reuse

After:  [stable tools + rules | dynamic git status | task context]
        ↓ stable prefix → higher chance of cache reuse
```

Pi itself decides whether to send cache-related fields such as `prompt_cache_retention`, session-affinity headers, or Anthropic-style `cache_control` based on model compat and `PI_CACHE_RETENTION`. By default this extension does not add request fields; the only opt-in request hint is OpenAI-family `prompt_cache_key` when `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=1` is set. The extension does not fake cache hits; it helps configuration, improves stable-prefix probability, and summarizes exposed usage in the footer.

## Improving cache hit rate

The cache-hit optimization is intentionally conservative and provider-neutral in code: keep the largest stable prompt prefix first, let Pi/provider compat send supported cache controls, and avoid leaking unsupported request fields to proxies.

What the extension does automatically:

- Moves stable prompt material before dynamic task/git/session context. Besides tools, skills, custom prompts, appended prompts, and guideline bullets, this also keeps known-stable project/spec instruction files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CURSOR.md`, and `.trellis/spec/...` in the early cacheable prefix. Arbitrary large context files are not lifted by size alone, because they may be task/session-specific.
- Sets `PI_CACHE_RETENTION=long` so Pi can request longer retention where the selected model/provider compat supports it.
- Keeps footer counters provider-family-specific so you can verify whether the active model family is actually reporting cache reads.

Provider notes:

- DeepSeek: current behavior remains the reference path. Stable prefix ordering plus long-retention/session-affinity compat gives the best chance of automatic KV prefix reuse.
- OpenAI-family: prompt caching is automatic only on supported upstreams and sufficiently long prompts. Keep static instructions, tools, examples, and specs before changing user/task context. Pi owns retention transport by default. If you explicitly opt in with `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=1`, the extension adds a top-level `prompt_cache_key` derived from a SHA-256 hash of the stable prompt prefix for OpenAI-family id/name matches only. The stable prompt text is not stored or printed, but unsupported OpenAI-compatible proxies may reject this field.
- Claude: prompt caching depends on Anthropic `cache_control` breakpoints. This extension does not inject breakpoints itself; for compatible endpoints, configure Pi compat such as `cacheControlFormat: "anthropic"` only when the endpoint supports it.
- Gemini/Vertex: implicit caching benefits from repeated large stable prefixes. This extension does not create explicit `cachedContents` resources or store cache resource names.
- Proxies/aggregators: fix upstream routing/provider order where possible. Cache hit rates are unreliable if the same model id/name can route to different upstreams.

## Provider-specific limitations

This package now has provider-family stats adapters, but it still avoids blind generalization:

- DeepSeek cache is automatic and prefix/KV-cache based. Hits are best-effort and proxies can hide DeepSeek usage fields.
- OpenAI-family prompt caching is automatic only where the actual upstream supports it and prompts are long enough. The adapter is model-name based and intentionally conservative; it does not use provider/API/base URL metadata to infer official OpenAI support.
- Claude prompt caching depends on explicit Anthropic cache-control breakpoints. This release only reports stats exposed by Pi/provider; it does not insert breakpoints or mutate request bodies.
- Gemini/Vertex may expose implicit cached-content token counts. This release does not create, store, update, or delete explicit Gemini cached-content resources.
- Proxies/aggregators can route the same model name to different upstream providers. Because detection is id/name-only, use unambiguous model names, upstream routing constraints, and exposed usage verification before trusting cache behavior.

## Out of scope for this release

- Broad/default request-body mutation or provider-agnostic cache-control injection.
- Injecting Anthropic `cache_control` markers.
- Sending OpenAI `prompt_cache_key` by default; it is only added when `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=1` is set, the active model id/name is OpenAI-family, and the payload does not already define one.
- Overriding OpenAI `prompt_cache_retention` outside Pi's own compat handling.
- Creating Gemini explicit `cachedContents` resources or persisting cache resource names.
- Claiming stats for providers that do not expose reliable cache usage.

## Verify effect

### In Pi

- Watch the footer label for the active family, such as `DS cache ...`, `OpenAI cache ...`, `Claude cache ...`, or `Gemini cache ...`.
- Use Pi's built-in `/stats` to confirm `cacheRead` tokens grow when Pi normalizes provider usage.
- For DeepSeek, Pi normalizes `usage.input` as uncached/miss prompt tokens and `usage.cacheRead` as `prompt_cache_hit_tokens`, so the footer denominator is reconstructed as `input + cacheRead + cacheWrite` (matching DeepSeek `prompt_tokens` when the provider reports normal usage).
- Footer hit count is request-level: one assistant response increments total requests, and it is a hit when `cacheRead > 0`. DeepSeek dashboards may use different time windows or account-wide/provider-side aggregation, so align the reset/window before comparing.
- For provider raw APIs, compare with documented usage fields such as DeepSeek `prompt_cache_hit_tokens`, OpenAI `cached_tokens`, Anthropic `cache_read_input_tokens`, or Gemini/Vertex cached-content token counts.

### Official DeepSeek baseline (recommended)

Use official direct `deepseek/deepseek-v4-pro` as the baseline. Avoid mixing proxy paths in the same verification run. Do not paste API keys into chats or issues.

1. Configure the official key with either:

   ```bash
   export DEEPSEEK_API_KEY='...'
   ```

   or Pi's login/config mechanism.

2. Confirm the model is visible:

   ```bash
   pi --list-models deepseek-v4-pro
   ```

3. Run a minimal request:

   ```bash
   pi --model deepseek/deepseek-v4-pro --thinking high
   ```

   In Pi, send the same or highly similar short prompt several times, for example:

   ```text
   Answer in one sentence: cache baseline ping
   ```

4. Repeat the same or highly similar request at least three times, then compare footer `DS cache ...` and `/stats` for increasing `cacheRead` / hit rate.

DeepSeek cache prefixes are server-side and may be grouped by prefix/cache unit. The first repeated request can still be building a shared prefix cache; the third and later matching requests are usually more meaningful. Official docs describe cache cleanup as a best-effort process that may take hours to days, but this is not a hit guarantee. A short-term miss can also be caused by prefix granularity, routing, request differences, or cache not being built yet.

> Note: the baseline consumes a small number of tokens. Use short prompts and do not paste large files.

## License

Released under the [MIT License](./LICENSE).
