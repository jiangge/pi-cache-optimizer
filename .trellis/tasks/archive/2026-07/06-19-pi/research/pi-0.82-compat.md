# Pi 0.82.0 compatibility notes for pi-cache-optimizer

## Sources inspected

* Global Pi: `pi --version` -> `0.82.0`.
* Project local validation SDK: `node_modules/@earendil-works/pi-coding-agent` -> `0.82.0` after no-save sync by the main session.
* Pi 0.82.0 package docs/changelog from local `node_modules`:
  * `CHANGELOG.md`
  * `docs/extensions.md`
  * `docs/models.md`
  * `docs/providers.md`
  * `docs/environment-variables.md`
  * `docs/llama-cpp.md`
  * `docs/custom-provider.md`
  * `dist/core/extensions/types.d.ts`
  * `dist/core/model-registry.d.ts`
  * `dist/extensions/llama/provider.{js,d.ts}`

## Findings relevant to this extension

### Extension API remains compatible

The hooks and command/UI APIs used by this package remain present in Pi 0.82.0:

* `session_start`
* `model_select`
* `before_agent_start`
* `before_provider_request`
* `after_provider_response`
* `message_end`
* `registerCommand`
* `ctx.ui.setStatus` / `ctx.ui.notify` / `ctx.ui.confirm`
* `ctx.sessionManager.getSessionId()`
* synchronous extension-facing `ctx.modelRegistry.find/getAvailable/getAll`

Pi 0.82.0 exports additional event/provider types and adds full provider extension registration, but this package does not register providers and does not need a ModelRuntime migration.

### Pi 0.81.0 / 0.82.0 changes with impact

* **Custom agent directory support**: Pi documents `PI_CODING_AGENT_DIR` as the config-directory override and 0.82.0 fixes core logs to respect custom agent directories. This extension still hardcoded `~/.pi/agent` for stats and `models.json`, so users running Pi with a custom agent dir would get stats/fix I/O in the wrong directory.
* **Local llama.cpp provider**: Pi 0.81.0 adds built-in `llama.cpp` router/provider support. It registers provider `llama.cpp` with `api: "openai-completions"`, local base URL, zero cache costs, and compat fields that disable store/usage-in-streaming/strict mode but do not enable prompt-cache or session-affinity semantics. Treating this local provider as a generic third-party OpenAI proxy would cause inappropriate `prompt_cache_key` fallback, missing `sendSessionAffinityHeaders` warnings, `/cache-optimizer fix`, and 403 proxy diagnostics.
* **Qwen Token Plan providers**: Pi 0.81.0 / 0.82.0 adds Qwen Token Plan providers using `openai-completions`. These are remote OpenAI-compatible channels and should remain in the generic proxy/cache path. No special code needed beyond preserving existing Qwen detection.
* **Kimi K3 / deferred tools**: Already handled by the 0.80.10 task update. No additional Kimi changes needed for 0.82.0.
* **Constrained tool sampling / bash metadata / expanded usage accounting**: New Pi features do not conflict with this extension. Bash `PI_*` metadata applies to built-in/factory bash tools, not this extension's hooks.

## Changes made

1. `index.ts`
   * Added `resolvePiAgentDir()` so stats and `models.json` paths respect `PI_CODING_AGENT_DIR`, with `PI_CONFIG_DIR` root fallback, before defaulting to `~/.pi/agent`.
   * Updated display-path helpers so doctor/fix guidance shows the configured agent directory when env overrides are active.
   * Added `isPiLocalLlamaCppModel()` and `shouldInjectOpenAIPromptCacheKeyForModel()`.
   * Excluded provider `llama.cpp` from OpenAI proxy compat warnings/fix suggestions, `prompt_cache_key` and long-retention fallback/hints, router/channel proxy diagnostics, and 400/403 prompt-cache/session-affinity / OpenAI-SDK-header diagnostics.
   * Preserved generic proxy behavior for remote OpenAI-compatible providers such as Qwen Token Plan.
2. `README.md` / `README.zh-CN.md`
   * Documented custom agent-dir behavior and local llama.cpp exclusion.
3. `.trellis/spec/frontend/cache-adapter-footer-stats.md` / `hook-guidelines.md`
   * Updated contracts for custom agent dirs, local llama.cpp, and 403 exclusions.
4. `.trellis/tasks/06-19-pi/verify-pi-0820-compat.ts`
   * Added focused verification for agent-dir resolution/display and local llama.cpp behavior.
5. `package.json`
   * Bumped to `2.6.19` because the runtime stats/fix path and hook diagnostics changed.

## Recommendation / conclusion

Pi 0.82.0 does not require an extension API migration for pi-cache-optimizer, but it does require a minimal compatibility adjustment for custom agent directories and the new local `llama.cpp` provider. After the changes above, the project is compatible with Pi 0.82.0 while preserving existing behavior for third-party remote OpenAI-compatible providers.
