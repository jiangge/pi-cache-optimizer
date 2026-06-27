# 检查 Pi 升级兼容性

## Goal

检查 Pi 升级到当前版本后，本项目（pi-cache-optimizer）是否需要代码、文档、类型或依赖调整；如发现必要调整，完成最小兼容性修复并验证。

## What I already know

* 用户说明 Pi 已升级，希望检查本项目是否需要调整。
* 当前全局 `pi --version` 为 `0.79.7`。
* 初始项目本地 `node_modules/@earendil-works/pi-coding-agent` 为 `0.79.6`，与全局 Pi 小版本不一致；已用 no-save 本地安装同步到 `0.79.7` 供验证，未产生 tracked dependency/lockfile 变更。
* `package.json` 中 `peerDependencies.@earendil-works/pi-coding-agent` 为 `"*"`，项目作为 Pi package 暴露 `./index.ts` 扩展。
* 当前扩展主要依赖 Pi Extension API：`before_agent_start`、`before_provider_request`、`after_provider_response`、`message_end`、`session_start`、`model_select`、`registerCommand`、`ctx.ui.setStatus`、`ctx.sessionManager.getSessionId()`、`ctx.model` 等。
* Pi `0.79.7` changelog 的相关变化包括：
  * `pi update` 默认只更新 Pi 本体，`pi update --all` 才同时更新 packages。
  * 新增 `CONFIG_DIR_NAME` public API，文档建议扩展不要硬编码 `.pi` 作为项目配置目录。
  * 导出 edit diff helpers。
  * 自动 theme mode / Warp image 等主要与本扩展无关。
* Pi `0.79.0` 起新增内建 footer `CH` 显示最近 prompt cache hit rate，本扩展仍提供持久化、provider/model/session 维度统计与优化能力，可能需确认 README 表述不过时。

## Assumptions (temporary)

* 本次只针对当前升级后的 Pi 版本做兼容性检查，不做大功能改造。
* 若只需同步本地开发依赖/锁文件或文档说明，也属于本任务范围。
* 若发现运行时 API 破坏性变化，优先做最小兼容修复。

## Open Questions

* 无。当前新增 footer stats restart-continuity 是 runtime/persistence behavior change，已 bump package version 到 `2.6.11`。

## Requirements (evolving)

* 检查当前 Pi changelog/docs 与项目使用的 Extension API 是否有冲突。
* 运行项目现有质量检查（至少 TypeScript 类型检查）。
* 检查 README/中文 README 中关于 Pi 安装/更新/缓存 footer 的表述是否因升级而过时。
* 若存在必要调整，做最小修改并记录原因。
* 仅 README 兼容说明更新不出版本；如果已有版本 bump，应回退。
* README/中文 README 需要告知 pi-router 等第三方虚拟渠道扩展如何透传 metadata / 使用全局协议，以无缝获得本扩展 cache 统计支持。

## Acceptance Criteria (evolving)

* [x] 明确给出“需要调整/不需要调整”的结论。
* [x] 如有修改，说明修改文件和理由。
* [x] TypeScript 检查通过。
* [x] 若本地 Pi SDK 版本与全局 Pi 不一致，处理或明确说明无需处理的原因。
* [x] README-only 阶段曾回退 package version；当前 runtime/persistence 修复已 bump 到 `2.6.11`。
* [x] README/中文 README 包含第三方 router/virtual-channel 扩展作者集成说明。

## Definition of Done (team quality bar)

* Tests added/updated when appropriate.
* Lint / typecheck / CI green where available.
* Docs/notes updated if behavior changes.
* Rollout/rollback considered if risky.

## Out of Scope (explicit)

* 不重新设计缓存优化策略。
* 不引入新的 provider/router 协议。
* 不处理与本次 Pi 升级无关的历史问题。

## Technical Notes

* Inspected: `package.json`, `index.ts`, `tsconfig.json`, `types/pi-coding-agent.d.ts`.
* Inspected Pi docs: README, `docs/extensions.md`, `docs/packages.md`, `docs/compaction.md`, `docs/sdk.md`, `CHANGELOG.md` (current local Pi docs/version 0.79.7).
* Current task path: `.trellis/tasks/06-19-pi`.
* Result: No runtime code, ambient type, or tracked dependency change required for Pi 0.79.7.
* Package manifest: `version` rolled back from `2.6.6` to `2.6.5` because this task only changes docs and should not trigger a release.
* Modified docs: `README.md`, `README.zh-CN.md` to document Pi 0.79.7 package-update semantics, Pi 0.79+ built-in `CH` footer relationship, and router/virtual-channel extension integration requirements.
* Router docs cover: authoritative assistant message metadata (`provider`, `model`/`responseModel`, `api`, usage), optional `Symbol.for("pi.routing.registry.v1")` live route registry, optional `Symbol.for("pi.cache.hints.v1")` query-scoped cache hints, no package imports, and prompt/secret safety.
* Enhanced `/cache-optimizer fix` to handle API-logged-in models (e.g. opencode go) that have no `models.json` entry: analyzes why the entry is missing, offers interactive creation of minimal compat-only provider/model entries with backup+atomic write+self-check, and shows complete manual-edit JSON guidance in non-interactive terminals.

### Simplified prompt_cache_retention logic (2026-06-22)

* **Problem discovered**: User reported 400 errors with `opencode-go/glm-5.2` due to `prompt_cache_retention` parameter. Investigation revealed this affects 400+ third-party `openai-completions` models in Pi's `models.generated.js` - Pi defaults `supportsLongCacheRetention` to `true`, but most third-party APIs don't support the parameter.
* **Root cause**: Pi's default `supportsLongCacheRetention: true` is wrong for almost all third-party OpenAI-compatible APIs. The old whitelist approach (scan models.json on startup, build allowlist) was complex and had startup overhead.
* **Simplified solution implemented**:
  1. Removed whitelist scanning (`explicitLongRetentionModels` Set + `refreshLongRetentionAllowlist` function).
  2. Added `hasExplicitLongRetentionOptIn(model)` - checks models.json synchronously for explicit opt-in (handles provider-level and model-level compat, model-level takes precedence).
  3. Simplified `before_provider_request` logic to 4 gates:
     - Gate 1: Official OpenAI → keep `prompt_cache_retention`
     - Gate 2: Explicit user opt-in (models.json has `supportsLongCacheRetention: true`) → keep
     - Gate 3: 400 history → strip (belt-and-suspenders)
     - Gate 4: All other cases → strip (safe default)
  4. Enhanced `describeMissingOpenAICompatibleProxyCompat` to detect missing `supportsLongCacheRetention` (not just `sendSessionAffinityHeaders`).
  5. Enhanced `buildSafeOpenAIProxyCompatSuggestion` to suggest `supportsLongCacheRetention: false` as safe default.
* **Edge cases validated**: Provider-level vs model-level compat (model wins), user's `h-e/glm-5.2` has provider `true` + model `false` → correctly uses `false`.
* **Benefits**: ~80% less code, no startup delay, first-run safe (no 400 before whitelist builds), doctor/compat/fix now detect the actual problem.
* Validation passed: `bunx tsc --noEmit --pretty false`, `git diff --check`, `npm pack --dry-run`, `python3 ./.trellis/scripts/task.py validate .trellis/tasks/06-19-pi`.

### Deep review fixes (2026-06-22)

* **Critical bug fixed — Gate ordering**: The original 4-gate logic checked explicit opt-in (Gate 2) BEFORE 400 history (Gate 3). This meant if a user explicitly opted in but the API returned 400, the 400 history was never reached — `prompt_cache_retention` was kept forever, causing infinite 400 loops. Fixed by reordering: Gate 2 is now 400 history (strip), Gate 3 is explicit opt-in (keep). This ensures empirical evidence (400) overrides user config.
* **Spec violation fixed — `⚠️ compat` marker**: The original change added `supportsLongCacheRetention` to `describeMissingOpenAICompatibleProxyCompat`, which would trigger `⚠️ compat` for all third-party proxies without `supportsLongCacheRetention: false`. This violated the spec which states `supportsLongCacheRetention` is optional/risky advisory only and must NOT keep `⚠️ compat` active. Reverted both `describeMissingOpenAICompatibleProxyCompat` and `buildSafeOpenAIProxyCompatSuggestion` — the existing `describeOptionalOpenAICompatibleProxyCompat` already handles advisory text correctly.
* **Code quality fixes**: Removed stale comment block describing the deleted Set; fixed docstring that claimed to return `undefined` (function only returns `boolean`); cleaned up trailing whitespace.
* **Verify script improved**: Switched from real `models.json` (which had parsing issues with simplified JSONC parser) to deterministic mock data. Added 6 gate-ordering tests that verify 400 history takes precedence over explicit opt-in.
* **Final architecture (4-layer defense)**:
  1. Layer 1: Proactive stripping in `before_provider_request` Gate 4 → prevents 400 for models without opt-in.
  2. Layer 2: 400 detection (`after_provider_response`) + Gate 2 → catches 400 for models WITH opt-in that's wrong, strips on next request.
  3. Layer 3: `/cache-optimizer fix` 400-specific path → offers `supportsLongCacheRetention: false` for 400 models.
  4. Layer 4: `doctor`/`compat` advisory via `describeOptionalOpenAICompatibleProxyCompat` → informs user about `supportsLongCacheRetention` without triggering `⚠️ compat`.

### Footer stats restart-continuity fix (2026-06-24)

* **Confirmed user-reported issue**: Current v5 stats design scoped footer counters by Pi `sessionId` hash. A terminal/process restart creates a new session hash, so the same provider/model restored an empty current-session bucket and footer restarted at 0/0 even though older buckets remained on disk.
* **Root cause**: `restoreCacheStats()` called `filterRestorableStatsForSession()` and loaded only `sessions[currentSessionHash]`; `publishStatus()`, `/cache-optimizer stats`, and doctor low-hit diagnosis read only the current session bucket.
* **Fix implemented**:
  1. Added persisted v6 `totalsByModel: Record<provider/model, CacheStats>` as the authoritative footer/display bucket that survives process/terminal restart.
  2. Kept `sessions[sessionHash][provider/model]` for migration, reload compatibility, and router metadata; `message_end` now updates both current-session bucket and `totalsByModel`.
  3. v4/v5/v3 migration derives `totalsByModel` from existing session/model buckets; v6 with empty `totalsByModel` is authoritative so reset tombstones are not resurrected from old session buckets.
  4. `/cache-optimizer reset` clears the active provider/model visible total and matching in-memory session entries; enable/disable reset local footer totals for before/after comparison.
  5. Router footer fallback can restore from `totalsByModel` when a new session has no current-session bucket.
* **Docs/spec updated**: `README.md`, `README.zh-CN.md`, and `.trellis/spec/frontend/cache-adapter-footer-stats.md` now describe restart-persistent provider/model footer stats and v6 schema.
* **Version**: `package.json` bumped to `2.6.11` because this is a runtime persistence/schema behavior change.
* **New verification**: `.trellis/tasks/06-19-pi/verify-restart-stats-continuity.ts` asserts v5 derivation, v6 tombstone behavior, total merge/delete behavior, and router total restore.
* Validation passed: `bunx tsc --noEmit --pretty false`, `bun .trellis/tasks/06-19-pi/verify-simplified-logic.ts`, `bun .trellis/tasks/06-19-pi/verify-fix-selfcheck.ts`, `bun .trellis/tasks/06-19-pi/verify-restart-stats-continuity.ts`, `git diff --check`, `npm pack --dry-run`.

### Retry stats inflation fix (2026-06-27)

* **Problem discovered**: User reported that when Pi auto-retries a failed request (network error), the footer cache stats appear to restart or the hit rate drops. Investigation confirmed that Pi's auto-retry mechanism emits `message_end` for BOTH the failed attempt AND the successful retry.
* **Root cause**: Pi's provider layer constructs error messages with a non-empty `usage` object (`{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ... }`). The extension's `getPiNormalizedUsage` treats `cacheRead: 0` as a valid cache signal (not `undefined`), so it returns `{ cacheRead: 0, cacheWrite: 0, totalInput: 0 }` instead of `undefined`. The `message_end` handler proceeds through `addUsageToCacheStats`, which increments `totalRequests` by 1 for each error message without adding any real cache data. Multiple retries inflate the denominator, making the cache hit rate appear lower than actual.
* **Pi internal flow**: `_handlePostAgentRun` detects a retryable error → `_prepareRetry` removes the error message from agent state → `agent.continue()` re-runs. The extension's `message_end` handler fires once for the error (at step 3 of `_handleAgentEvent` → `_emitExtensionEvent`) and once for the success (same flow on the retry). Both messages carry `provider` + `model` from the request model.
* **Fix implemented**: Added a `stopReason` guard at the top of the `message_end` handler, right after adapter matching. Messages with `stopReason === "error"` or `stopReason === "aborted"` are returned immediately before any stats processing (no `normalizeUsage`, no `recordRecentSample`, no `addUsageToCacheStats`, no `publishStatus`). This keeps `totalRequests` accurate by only counting successful responses.
* **Impact**: One retry with a previously-0-hit model would show `1/1` (100%) instead of `1/2` (50%); with multiple retries the gap widens proportionally. Recent trend samples and routed model tracking are also not polluted by error messages.
* **Validation**: `bunx tsc --noEmit --pretty false`, `git diff --check`, `npm pack --dry-run`, all 3 existing verify scripts (41 tests) still pass.

### Direct-provider stats consolidation (response model name drift) (2026-06-27)

* **Problem discovered**: User reported `(gmicloud) zai-org/GLM-5.2-FP8` footer cache showed very low / 0%. Investigation of `~/.pi/agent/pi-cache-optimizer-stats.json` found the real cache hit rate was fine — 4 fragmented buckets under `gmicloud/` (`GLM5.2-FP8` 25/37=68%, `glm-5.2` 7/13=54%, `GLM-5.2` 2/2=100%, `zai-org/GLM-5.2-FP8` 0/3=0%) merged to ~34/55 ≈ 62% — but the active-model footer read only `gmicloud/zai-org/GLM-5.2-FP8` (0/3, 0%).
* **Root cause**: A read/write model-key asymmetry. `message_end` writes stats under the assistant message's echoed `model`/`responseModel` id (`modelFromAssistantMessage`, preferred over `ctx.model` for virtual-routing correctness). GMICloud normalizes/renames the model id in responses (request `zai-org/GLM-5.2-FP8` → response `GLM5.2-FP8` / `glm-5.2` / `GLM-5.2`), fragmenting stats across 4 buckets. The footer (`publishStatus`/`stats`/`doctor`) reads `totalsByModel[modelKey(ctx.model)]` = the active-model bucket only, so it showed 0/3 (0%) while the real backend hit rate was ~62%.
* **Fix implemented**: Added `consolidateDirectProviderStatsModel(statsModel, ctxModel, ctx)`. For **direct (non-virtual-routing)** providers, when the response-derived model differs from the active model only in name — same provider, same cache adapter object (identity, not family id, since GPT and GLM both report family id `"openai"`) — stats are consolidated back to `ctx.model.id`/`ctx.model.name`. Never merges across providers or adapters, so genuinely different models stay separate. Virtual routing providers are excluded — their message-local identity remains authoritative (router correctness).
* **Impact**: Footer for `gmicloud/zai-org/GLM-5.2-FP8` will now show the merged real hit rate (~62%, accumulating as new turns come in) instead of a stale 0/3 fragment. Existing fragmented buckets (`gmicloud/GLM5.2-FP8` etc.) remain on disk but stop growing; a `/cache-optimizer reset` on the active model clears its visible total.
* **models.json**: NOT changed — the compat config was already correct (model-level `sendSessionAffinityHeaders: true`, `supportsLongCacheRetention: false`, `thinkingFormat: "zai"`; merged compat satisfies the proxy check, no `⚠️ compat`).
* **Version**: `package.json` bumped to `2.6.13` because this is a runtime footer-display behavior change.
* **Validation**: `bunx tsc --noEmit --pretty false`, new `verify-direct-provider-stats-consolidation.ts` (18 tests), all 3 existing verify scripts (41 tests) still pass, `git diff --check`, `npm pack --dry-run`.

### 403 session-affinity header detection (2026-06-27)

* **Problem discovered**: User reported mofas/glm-5.2 returning `403 Your request was blocked`. Root cause: `sendSessionAffinityHeaders: true` causes Pi's `openai-completions` adapter to send three custom HTTP headers (`session_id`, `x-client-request-id`, `x-session-affinity`), which mofas's CDN/WAF blocks with 403. The extension previously only monitored HTTP 400 (`prompt_cache_retention` unsupported) and gave NO diagnostic for 403 — doctor/compat even said "✅ Compat fully configured" and the generic proxy diagnostic recommended enabling the very flag that caused the block.
* **Fix implemented**: Mirrors the existing 400 monitoring pattern.
  1. New `sendSessionAffinityHeaders403Models` + `warnedSendSessionAffinityHeaders403Models` module Sets (next to `promptCacheRetention400Models`).
  2. New `isSessionAffinity403Applicable(model)` guard: returns true only for `openai-completions`/`openai-responses` APIs with merged compat `sendSessionAffinityHeaders === true`.
  3. Restructured `after_provider_response` to handle both 400 and 403 in separate `if` blocks (the existing `if (event.status !== 400) return;` early-exit was replaced with explicit `if (event.status === 400) { ... return; }` and `if (event.status === 403) { ... return; }` blocks). Existing 400 behavior is byte-for-byte preserved.
  4. `buildDoctorDiagnosis` now accepts `sessionAffinity403?: boolean` and shows either a strong 403-observed hint (recommends `/cache-optimizer fix`) or an advisory note (when the flag is enabled but no 403 yet) about CDN/WAF blocking of custom headers.
  5. All `buildDoctorDiagnosis` call sites pass `sessionAffinity403: sendSessionAffinityHeaders403Models.has(modelKey(model))`.
  6. `/cache-optimizer fix` adds a 403-specific suggestion path offering `sendSessionAffinityHeaders: false`, mirroring the 400 `supportsLongCacheRetention: false` path. Non-interactive manual guidance likewise mentions the 403 case.
  7. `/cache-optimizer compat` adds an advisory line when `sendSessionAffinityHeaders` is enabled.
  8. `isSessionAffinity403Applicable` exported via `__internals_for_tests`.
* **models.json fix**: mofas/glm-5.2 and mofas/deepseek-v4-pro both given model-level `sendSessionAffinityHeaders: false` + `supportsLongCacheRetention: false` (provider-level retained; model-level overrides take precedence). `/reload` or restart applies.
* **Version**: `package.json` bumped to `2.6.14` because this is a new runtime diagnostic + fix-path behavior.
* **Validation**: `bunx tsc --noEmit --pretty false`, new `verify-403-detection.ts` (10 tests), all 4 existing verify scripts (59 tests) still pass, `git diff --check`, `npm pack --dry-run`.
