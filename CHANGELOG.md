# Changelog

On Pi 1.5+, after `pi update --extensions` (or `--all`), the next fresh interactive launch shows entries newer than the
last version Pi recorded for this package under "Extension Updates". Pi records the version silently the first time
it sees this file, so notes start with the update after that.
Older history is in the [git log](https://github.com/jiangge/pi-cache-optimizer/commits/master).

## [2.10.8] - 2026-11-22

### Fixed

- Native virtual models: when several credentialed providers share the routed model id and only some set `compat.promptCacheKeyMode: "disabled"`, the extension no longer adds a `prompt_cache_key` depending on catalog order; such requests are left unchanged. Providers whose mode is `"enabled"`, `"auto"` or unset are still treated alike. Thanks @qsgy-edge (#32).

## [2.10.7] - 2026-11-21

### Fixed

- Pi 1.6.0's built-in llama.cpp models are recognised again, so they no longer get proxy and session-affinity advice meant for third-party OpenAI-compatible gateways. Pi 1.6.0 stopped setting `compat.supportsDeveloperRole: false` on them. A same-id `llama.cpp` provider that sets cache or routing overrides (`promptCacheKeyMode`, `cacheControlFormat`, `openRouterRouting`, `vercelGatewayRouting`) is no longer treated as the built-in one.

### Changed

- Validated against Pi 1.6.0. Its `models.json` compat keys are unchanged.

## [2.10.6] - 2026-11-13

### Changed

- Supports Pi 1.5.1 and 1.5.2, whose default `cacheWarming` is now `idle`. `/cache-optimizer doctor` reports Pi's actual default, reads the mode from global settings as Pi does, and notes when only project settings set `cacheWarming` (Pi ignores it there).
- Zero-price warming (the `warm` answer for models whose prices are all zero) now covers refreshes between agent runs only when you set `"cacheWarming": "idle"` in global settings yourself. With Pi's new idle default it covers agent runs only, as before, so upgrading Pi does not start paid idle refreshes on channels that bill despite zero prices.
- A model whose `compat.promptCacheKeyMode` is `"disabled"` (Pi 1.5.1+) no longer gets a `prompt_cache_key` from this extension, and the 400-error hint recommends that setting. `/cache-optimizer fix prompt-cache-key` makes no change for such a model.
- Pi's global `settings.json` is read the way Pi reads it (strict JSON, BOM stripped; an unreadable or invalid file means Pi's defaults), so a comment in the file no longer counts as an explicit `cacheWarming` choice.
- `models.json` key hints know the Pi 1.5.1 compat keys `promptCacheKeyMode`, `requiresNonNullAssistantContent`, `requiresToolsWithToolHistory` and `supportsMessageThreads`.
- Validated against Pi 1.5.2.

## [2.10.5] - 2026-11-04

### Fixed

- Skill-list compression works on Pi 1.5. Pi 1.5 reworded the path rule in its skills preamble, so the verbose `<available_skills>` list was no longer recognised and compression silently stopped (`/cache-optimizer doctor` only reported an unrecognised format). Both the Pi 1.5 wording and the earlier wording are recognised, and the compressed preamble keeps the wording Pi rendered.
- A subagent whose inherited prompt was rendered by a different Pi version (one copy of the skill list in each wording) no longer ends up with a forced system prompt: every copy is compressed as a section edit.

### Changed

- `models.json` key hints know the Pi 1.4 compat keys `imageInput` and `sendImageOptInHeader`, and the hint text no longer names a Pi version.
- Validated against Pi 1.5.0.

## [2.10.4] - 2026-10-20

### Added

- Misspelled `models.json` keys (for example `model0verrides`), which Pi silently ignores, are flagged in compat warnings, `/cache-optimizer doctor` and `fix`, with the key they probably meant. Hint only; nothing is renamed ([#30](https://github.com/jiangge/pi-cache-optimizer/issues/30)).

## [2.10.3] - 2026-10-20

### Fixed

- The verbose skill list is also compressed inside an inherited `customPrompt`, so subagents of an idle parent are no longer forced onto a full system prompt ([#31](https://github.com/jiangge/pi-cache-optimizer/pull/31), thanks @xulongwu4).

## [2.10.2] - 2026-10-18

### Fixed

- A session's usage is no longer lost on exit when its final stats write failed; the write is retried once at shutdown.

## [2.10.1] - 2026-10-18

### Fixed

- Footer stats no longer lose the previous session's usage for the day when a host keeps one extension instance across sessions (a second `session_start`).

## [2.10.0] - 2026-10-18

### Changed

- Incremental footer refresh: a tiered shard index and a non-blocking, coalesced refresh, so footer refreshes after tool calls and messages no longer block Pi ([#28](https://github.com/jiangge/pi-cache-optimizer/issues/28)). Turn it off with `/cache-optimizer config stats-incremental off` or `PI_CACHE_OPTIMIZER_STATS_INCREMENTAL=0`.
