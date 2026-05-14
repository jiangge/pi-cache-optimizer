# Pi DeepSeek Cache Optimizer

[中文说明](./README.zh-CN.md)

A plug-and-play Pi extension that improves DeepSeek KV Cache / Prompt Cache hit rates.

> Important: DeepSeek caching is server-side, automatic, and best-effort. This extension can improve the odds of cache hits by stabilizing prompt prefixes, requesting long retention, warning about session-affinity config, and showing lightweight footer stats. It cannot guarantee cache hits. Third-party proxies may hide, drop, or reduce cache effectiveness.

## What it does

| Feature | How | Manual action required |
|---|---|:---:|
| 🔄 Reorders the system prompt | `before_agent_start` hook: stable prefix first, dynamic context later | ❌ Automatic |
| ⏳ Requests long cache retention | Sets `PI_CACHE_RETENTION=long` when the extension loads | ❌ Automatic |
| 🔗 Session-affinity reminders | Checks DeepSeek-like model id/name and merged compat flags | ⚠️ See below |
| 📊 Footer cache stats | Shows DeepSeek cache hit requests and cache-read token ratio in Pi footer/status | ❌ Automatic |

## Install

```bash
pi install npm:pi-deepseek-cache-optimizer
```

After installation, `PI_CACHE_RETENTION=long` is applied automatically, the system prompt is reordered automatically, and the footer shows cache stats after DeepSeek-like model responses.

## Footer cache stats

The Pi footer displays stats like:

```text
DS cache 3/5 · 0.77M/0.80M tok (96%)
```

Meaning:

- `3/5`: 3 of 5 DeepSeek-like assistant responses had `cacheRead > 0`.
- `0.77M/0.80M tok`: cumulative cache-read input tokens / cumulative prompt input tokens, shown in millions.
- Percentage: `cacheRead / total prompt input`.

Stats rules:

- Counts only assistant responses whose model id or model name contains `deepseek`.
- Counts only responses where Pi/provider exposes usage.
- `cacheRead` comes from Pi-normalized `usage.cacheRead`.
- Total prompt input is `usage.input + usage.cacheRead + usage.cacheWrite`. In common DeepSeek usage, `usage.input` is uncached/missed input and `usage.cacheRead` is cached input; if the provider exposes `cacheWrite`, it is included so the denominator is not too small.
- Stats update only the footer/status. The extension does not create extra TUI widgets or diagnostic files.
- Stats are persisted in a small local JSON state file at `~/.pi/agent/deepseek-cache-optimizer-stats.json`. The file stores only counters and the local day; it does not store API keys, prompts, messages, or model output.

Reset behavior:

- Pi restarts do **not** clear stats; the persisted counters are restored.
- `/reload` / extension reload resets the persisted counters because Pi exposes `session_start` with reason `reload`.
- Crossing the local natural-day boundary resets counters on the next status update or DeepSeek-like response.

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

The extension warns at most once per provider/model per session when:

- `supportsLongCacheRetention: true` is missing, so Pi may not send `prompt_cache_retention: "24h"`.
- `sendSessionAffinityHeaders: true` is missing for OpenAI Completions-compatible APIs, or `sendSessionIdHeader: true` is missing for OpenAI Responses-compatible APIs, so Pi may not send session-affinity headers such as `session_id`, `x-client-request-id`, or `x-session-affinity`.

> Reminder: only enable session-affinity headers when your endpoint or proxy supports them.

## How it works

DeepSeek KV Cache is based on exact prefix matching. Pi's system prompt contains stable content that is likely shared across sessions (tools, skills, guidelines) and dynamic content that changes frequently (git status, task context).

```text
Before: [dynamic git status | task context | stable tools + rules]
        ↓ changing prefix → lower cache reuse

After:  [stable tools + rules | dynamic git status | task context]
        ↓ stable prefix → higher chance of cache reuse
```

Pi itself decides whether to send cache-related fields such as `prompt_cache_key`, `prompt_cache_retention`, session-affinity headers, or Anthropic-style `cache_control` based on model compat and `PI_CACHE_RETENTION`. This extension does not fake cache hits; it helps configuration, improves stable-prefix probability, and summarizes exposed usage in the footer.

## Verify effect

### In Pi

- Watch the footer `DS cache ...` status for the current local day.
- Use Pi's built-in `/stats` to confirm `cacheRead` tokens grow.
- DeepSeek API usage may also expose `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; Pi normalizes these where possible to `usage.cacheRead` / `usage.input`.

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

## Release

Before publishing, inspect the npm package contents:

```bash
npm pack --dry-run
npm publish --access public
```
