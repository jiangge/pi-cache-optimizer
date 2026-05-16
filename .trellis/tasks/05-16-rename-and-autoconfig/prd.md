# Rename to pi-cache-optimizer and auto-config DeepSeek

## Goal

Rename the npm package from `pi-deepseek-cache-optimizer` to `pi-cache-optimizer` to reflect that it is already a multi-provider cache optimizer, and reduce first-time-user friction by auto-seeding a recommended DeepSeek entry into `~/.pi/agent/models.json` so the user only needs to set `DEEPSEEK_API_KEY` to get value out of the extension.

The renaming is a breaking change at the install-command level but must remain fully backward-compatible at the data level: existing v2 stats files, existing user `models.json`, and existing user behavior must keep working.

## Background

* Current package name `pi-deepseek-cache-optimizer` is misleading because the extension already supports DeepSeek/OpenAI/Claude/Gemini stats adapters via id/name detection.
* DeepSeek's official Pi onboarding doc (`https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/pi_mono.zh-CN.md`) only describes how to register DeepSeek into `models.json`; it does NOT include `supportsLongCacheRetention` or `sendSessionAffinityHeaders`. Users who follow that doc and then install our extension still leave cache value on the table because Pi does not send `prompt_cache_retention: "24h"` or session-affinity headers without those compat flags.
* Users who install our extension WITHOUT first following the official Pi+DeepSeek setup get a silent no-op extension because no DeepSeek model is configured at all.

## Scope (approved)

1. Rename package to `pi-cache-optimizer`, version `2.0.0`.
2. Migrate persisted stats file path with one-shot read-fallback from old path.
3. Auto-seed DeepSeek into `~/.pi/agent/models.json` when no DeepSeek-like model exists, with full recommended compat (long cache retention + session affinity).
4. Prompt user (once per session) when `DEEPSEEK_API_KEY` is not set AND we just seeded or already-seeded DeepSeek entries are present.
5. Update both READMEs and the `.trellis/spec/frontend/cache-adapter-footer-stats.md` scenario file.
6. Add an opt-out env var to disable auto-config behavior.

## Non-Goals (explicit)

* Auto-seeding any provider other than DeepSeek (OpenAI/Anthropic/Google have their own onboarding flows; out of scope).
* Modifying user-existing provider entries; we never overwrite or rewrite an entry that already exists.
* Storing or printing API keys.
* Implementing a `session_start` "no supported provider configured" hint based on enumerating Pi's configured models — Pi SDK enumeration is uncertain and not required once auto-seeding is in place.
* Renaming the git repo directory on disk (kept as `pi-deepseek-cache-optimizer/` to preserve git history; only the npm package name and on-disk stats file change).

## Requirements

### Package rename

* `package.json` → `name: "pi-cache-optimizer"`, `version: "2.0.0"`.
* Status key string in `extension.ts` → `pi-cache-stats` (was `deepseek-cache-stats`).
* Stats file path → `~/.pi/agent/pi-cache-optimizer-stats.json` (was `~/.pi/agent/deepseek-cache-optimizer-stats.json`).
* Stats file format unchanged (still `version: 2`, `statsByProvider`).
* Stats migration: on load, if new path missing AND old path exists, read old path, write new path, then best-effort delete old. Read failure or corrupt JSON falls back to empty in-memory counters per existing spec.
* Both READMEs reference the new install command `pi install npm:pi-cache-optimizer`. Old name mentioned only once in a "renamed from" note.

### Auto-config DeepSeek in models.json

Trigger: extension activation (must be idempotent and side-effect-once per state).

Algorithm:
1. Resolve `models.json` path: `${HOME}/.pi/agent/models.json` on Linux/macOS, `%USERPROFILE%\.pi\agent\models.json` on Windows.
2. If `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1`, skip everything.
3. Load file. If missing or unreadable, treat as `{ "providers": {} }`. If present but JSON-invalid, abort auto-config (do not overwrite a malformed user file).
4. Decide if seeding is needed:
   * Skip if any model under any provider has an `id` or `name` containing the substring `deepseek` (case-insensitive). User already has DeepSeek configured in some form.
   * Skip if a provider key named `deepseek` exists, even if its models list is empty (respect user intent).
5. If seeding needed:
   * Write a backup at `${MODELS_JSON}.bak.<unix-millis>` containing the exact bytes we just read (or empty marker if file did not exist).
   * Merge in a `deepseek` provider entry with the recommended compat (see "Seed contents" below). Never modify existing keys.
   * Atomic write: write to `${MODELS_JSON}.tmp.<pid>`, then rename over the target. If rename fails, leave the temp in place and log a one-line warning.
6. Track that we seeded by inspecting state on next run; do not store extra marker fields inside `models.json` itself (avoids polluting user config).

Seed contents (DeepSeek provider block to insert):

```json
{
  "baseUrl": "https://api.deepseek.com",
  "api": "openai-completions",
  "apiKey": "$DEEPSEEK_API_KEY",
  "models": [
    {
      "id": "deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "input": ["text"],
      "reasoning": true,
      "cost": { "input": 1.74, "output": 3.48, "cacheRead": 0.145, "cacheWrite": 0 },
      "compat": {
        "requiresReasoningContentOnAssistantMessages": true,
        "thinkingFormat": "deepseek",
        "supportsLongCacheRetention": true,
        "sendSessionAffinityHeaders": true,
        "reasoningEffortMap": {
          "minimal": "high", "low": "high", "medium": "high", "high": "high", "xhigh": "max"
        }
      }
    },
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "input": ["text"],
      "reasoning": true,
      "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0.028, "cacheWrite": 0 },
      "compat": {
        "requiresReasoningContentOnAssistantMessages": true,
        "thinkingFormat": "deepseek",
        "supportsLongCacheRetention": true,
        "sendSessionAffinityHeaders": true,
        "reasoningEffortMap": {
          "minimal": "high", "low": "high", "medium": "high", "high": "high", "xhigh": "max"
        }
      }
    }
  ]
}
```

Note: This goes BEYOND the official DeepSeek doc by including `supportsLongCacheRetention: true` and `sendSessionAffinityHeaders: true`. This is intentional — those flags are exactly the cache-related compat the official doc omits, and they are the reason this extension's compat warnings exist.

### API key hint

* Once per session (`session_start`), if `process.env.DEEPSEEK_API_KEY` is empty/unset AND `models.json` contains a DeepSeek-like model (whether seeded by us or by the user), log a one-line hint pointing to where to set it. No actual key value is read or printed. No hint when the variable is set.
* The hint must not duplicate Pi's own missing-key error when the user actually tries to call the model.

### Opt-out

* `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1` → skip the entire models.json auto-seed step. The hint about `DEEPSEEK_API_KEY` is independent (governed by whether DeepSeek is in the file at all).

### Documentation

* README.md and README.zh-CN.md:
  * Update install command to `pi install npm:pi-cache-optimizer`.
  * Add a top "Renamed from `pi-deepseek-cache-optimizer`" note with a one-line migration tip (`pi remove npm:pi-deepseek-cache-optimizer && pi install npm:pi-cache-optimizer`).
  * Add a "Quickstart" / Prerequisites section that links to the official `pi_mono.zh-CN.md` AND notes that this extension will auto-seed `models.json` on first run.
  * Document `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1`.
  * Update stats file path everywhere it appears.
* `.trellis/spec/frontend/cache-adapter-footer-stats.md`:
  * Update Status key, stats file path, and add a new contract: "Auto-config writes only when no DeepSeek-like model exists; never overwrites existing entries; never persists API keys."

## Acceptance Criteria

* [ ] `package.json` shows `name: "pi-cache-optimizer"`, `version: "2.0.0"`.
* [ ] Stats file path is `pi-cache-optimizer-stats.json`. Old `deepseek-cache-optimizer-stats.json` is read once and migrated, then deleted on success.
* [ ] On first activation with no DeepSeek configured, `models.json` is created (or modified) to contain the DeepSeek seed block, and a `.bak.<ts>` backup is written.
* [ ] On activation when DeepSeek already configured, `models.json` is untouched and no backup is written.
* [ ] `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1` skips the auto-seed entirely.
* [ ] When `DEEPSEEK_API_KEY` is unset and DeepSeek-like models exist, exactly one hint per session is emitted; no key value is read or printed.
* [ ] Existing v2 `statsByProvider` data survives the rename without loss.
* [ ] No API keys, prompts, message bodies, or headers are read, stored, or logged anywhere.
* [ ] README, README.zh-CN, and the cache-adapter-footer-stats spec all reflect the new name, path, and auto-config contract.
* [ ] `npm pack --dry-run` succeeds and shows the new package name. `git diff --check` is clean.
* [ ] Loading the built extension under Pi/Jiti has no runtime or type errors.

## Definition of Done

* All ACs above pass.
* Spec scenario updated (Phase 3.3 of workflow).
* Implementation committed with a focused commit message describing rename + auto-config in one logical change.
* `npm deprecate pi-deepseek-cache-optimizer "Renamed to pi-cache-optimizer..."` is queued for execution by the main agent once the user provides a one-time npm token; not part of this code task.

## Risks / Open Concerns

* Writing into `~/.pi/agent/models.json` is invasive. Mitigations: opt-out env var, `.bak.<ts>` backup before any write, atomic rename, hard skip when DeepSeek already present, hard abort on JSON parse failure.
* If a user previously hand-configured DeepSeek with WEAKER compat (no `supportsLongCacheRetention`), our auto-seed will NOT upgrade it (we leave existing entries alone). This is intentional. Compat warnings already cover this case.
* Old stats file delete after migration is best-effort; if delete fails, both files exist briefly but new path wins.
* `npm deprecate` step is medium-risk and out of scope for this code task; main agent will execute when user provides token.

## Technical Notes

* Files likely impacted: `package.json`, `extension.ts`, `README.md`, `README.zh-CN.md`, `.trellis/spec/frontend/cache-adapter-footer-stats.md`.
* The auto-config block can live as a separate function `ensureDeepseekConfigured(ctx)` called from extension activation, with no behavior outside that path. Keep it small and synchronous if possible (Node fs sync ops are acceptable here because activation is one-shot).
* JSON write must use `fs.writeFileSync` to a temp path then `fs.renameSync` for atomic replace.
* All log output must go through `ctx.ui` / Pi's logger if available, falling back to `console.warn` only when no Pi logger is present.

## Out of Scope

* Auto-seeding non-DeepSeek providers.
* Renaming the git repo directory.
* Building a UI flow to prompt for the API key value (we only point users to where to export it).
* Enumerating Pi's configured model list at `session_start` for a generic "no supported provider" hint.
