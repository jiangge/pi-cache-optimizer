# Optimize third-party GPT cache behavior in Pi

## Goal

优化 Pi 中第三方 OpenAI-family / GPT 代理模型（例如 `otokapi` 渠道 `gpt-5.5`）的缓存命中率：让扩展使用 Pi session id 作为 OpenAI `prompt_cache_key` 的兜底来源，并提示第三方 GPT provider 配置 session-affinity compat，避免代理多后端路由导致缓存命中低。

## What I already know

* 用户报告：OpenAI Codex 官方渠道缓存命中率约 98%，第三方 GPT 模型缓存仅 20%-50%。
* 当前仓库是 `pi-cache-optimizer` 扩展，会影响 Pi 请求 hook、prompt 重排和 OpenAI-family cache key 注入，但默认不会改写模型配置里的 otokapi。
* Pi 自定义模型配置位于 `~/.pi/agent/models.json`。
* Pi 文档中 OpenAI-compatible provider 通常使用 `api: "openai-completions"`；如果是 OpenAI Responses API 才用 `openai-responses`。
* Pi `ExtensionContext` 暴露 `ctx.sessionManager.getSessionId()`。
* Pi core 的 `openai-responses` 已使用 session id 作为 `prompt_cache_key`；`openai-completions` 在 cache retention/compat 条件满足时也会使用 session id。
* 第三方 OpenAI-compatible 代理缓存低的高概率原因是代理没有稳定路由到同一上游/实例，缺少 `compat.sendSessionAffinityHeaders: true` 或 `compat.supportsLongCacheRetention: true`。

## Assumptions (temporary)

* `otokapi` 是本机 `models.json` 中的自定义 provider 或代理渠道。
* `gpt-5.5` 是该 provider 下的自定义 model id/name。
* 问题可能表现为模型不可见、选不中、请求 4xx、流式解析失败、reasoning/thinking 参数不兼容、developer role 不兼容，或扩展添加了不兼容字段。
* 当前任务聚焦缓存命中率优化，不修改用户真实 `~/.pi/agent/models.json`。

## Open Questions

* 具体报错信息是什么（如果本地日志和命令无法复现，则需要用户补充）。
* 第三方代理是否真实支持/转发 OpenAI `prompt_cache_key` 与 session affinity headers 需要用户在实际渠道验证。

## Requirements (evolving)

* OpenAI-family cache-key hook 改用 Pi session id 兜底，而不是 `stablePrefix` hash。
* 不覆盖 Pi core 或用户 payload 中已有的有效 `prompt_cache_key`。
* 将 `prompt_cache_key: undefined` / 空字符串视为缺失，允许扩展补 session id。
* 对第三方 GPT / OpenAI-family `openai-completions` 模型，当缺少 `supportsLongCacheRetention` 或 `sendSessionAffinityHeaders` 时给出一次性 warning 和可复制 compat 建议。
* 对可能没有显式 `models.json` provider block 的渠道，doctor/compat 需提示：保持现有认证方式，不复制 credential/token/API key；只在 `models.json` 增加最小 provider-level `compat` 或单模型 `modelOverrides` 覆盖。
* 保持官方 OpenAI Responses / Codex bypass，不对其 prompt 做重排。
* 不将 API key、prompt、headers、payload、模型输出写入日志或持久化。
* 不创建、备份、写入、重命名或修改 `~/.pi/agent/models.json`；本项目只做缓存优化、compat 提醒和 footer 统计。

## Acceptance Criteria (evolving)

* [x] 第三方 GPT / OpenAI-family 模型在缺少有效 `prompt_cache_key` 时会补入 `ctx.sessionManager.getSessionId()`。
* [x] 已有有效 `prompt_cache_key` 不被覆盖。
* [x] `prompt_cache_key: undefined` / 空字符串会被视为缺失。
* [x] 第三方 GPT `openai-completions` 缺少 cache/session-affinity compat 时给出一次性 warning。
* [x] Adapter 选择仍只基于模型 id/name，不因 provider/api/baseUrl 改变。
* [x] 质量检查通过；如代码修改，补充任务级验证脚本。
* [x] 不再在用户未配置 DeepSeek-like 模型时自动写入 DeepSeek provider；扩展不会修改 `models.json`。
* [x] doctor/compat 对缺少 `models.json` provider block 的渠道补充 credential-safe 提示，并给出 provider-level 与 `modelOverrides` 最小配置示例。

## Definition of Done

* Tests added/updated if code changes.
* Lint/typecheck/CI green if code changes.
* Docs/notes updated if behavior changes.
* Rollout/rollback considered if risky.

## Out of Scope

* 不打印或保存任何 API key 明文、prompt、headers、payload、模型输出。
* 不创建、备份、写入、重命名或修改用户真实 `~/.pi/agent/models.json`。
* 不自动新增 DeepSeek 或任何其他 provider/model；模型配置由用户自行管理。
* 不强行给 Claude/Gemini 使用 OpenAI `prompt_cache_key`，它们缓存机制不同。
* 不假造 cache usage；第三方代理不返回 cache fields 时 footer 保持真实统计。

## Technical Notes

* Read Pi docs: `docs/models.md`, `docs/custom-provider.md`.
* Relevant extension file: `index.ts` OpenAI Responses bypass and optional `prompt_cache_key` hook.
* Pi type refs inspected:
  * `dist/core/extensions/types.d.ts` — `ExtensionContext.sessionManager`.
  * `dist/core/session-manager.d.ts` — `ReadonlySessionManager.getSessionId()`.
* Pi provider refs inspected:
  * `pi-ai/dist/providers/openai-responses.js` — always sends session-id `prompt_cache_key` unless cache retention is `none`.
  * `pi-ai/dist/providers/openai-completions.js` — sends session-id `prompt_cache_key` when official OpenAI or long-retention compat applies; sends session affinity headers when `compat.sendSessionAffinityHeaders` is true.
* Curated context files in `implement.jsonl` and `check.jsonl` before starting implementation.
* Implementation notes:
  * Extension fallback now uses `ctx.sessionManager.getSessionId()` for OpenAI `prompt_cache_key` and clamps to 64 codepoints.
  * Fallback is gated to OpenAI-family id/name plus OpenAI-compatible Pi API (`openai-completions` / `openai-responses`) to avoid custom transports.
  * Non-empty `prompt_cache_key` / `promptCacheKey` is preserved; `undefined`, `null`, empty and whitespace-only values are treated as missing.
  * Third-party GPT `openai-completions` proxy warnings now recommend `supportsLongCacheRetention` and `sendSessionAffinityHeaders`.
  * DeepSeek auto-seeding / `models.json` mutation was removed to keep the package scoped to cache optimization, compat advice, and footer stats only.
  * Added footer stats adapters for Mistral, Grok/xAI, Llama, Nemotron, Cohere, and Yi model families. Each uses id/name-only detection with OpenAI-compatible usage normalization (`getOpenAIRawUsage` fallback). Detection tokens: `mistral/mixtral/codestral`, `grok` + `xai` pattern, `llama`, `nemotron`, `cohere/command-r`, `yi-` + `01-ai/zero-one` + `yi` pattern. Compat warnings (when applicable) reuse the existing broad `describeMissingOpenAICompatibleProxyCompat` function.
  * The relaxed `before_provider_request` gate (only `isOpenAICompatibleApi` check, no `isOpenAIFamilyModel` requirement) already covers all new model families for session-id prompt_cache_key injection.
  * Missing-compat warning/doctor/compat output now explains channels without explicit `models.json` provider blocks: keep existing authentication as-is, do not copy credentials/tokens/API keys, and put cache/routing compat in minimal `models.json` provider-level `compat` or single-model `modelOverrides` examples. Generic OpenAI proxy examples keep `supportsLongCacheRetention` out of safe JSON by default.
* Validation:
  * `node --experimental-strip-types --no-warnings .trellis/tasks/05-21-investigate-pi-otokapi-gpt55-unavailable/verify.ts`
  * `node --experimental-strip-types --no-warnings .trellis/tasks/05-17-fix-prompt-pollution-bugs-degrading-deepseek-cache-hit-rate/verify.ts`
  * `node --experimental-strip-types --no-warnings -e "import('./index.ts').then(()=>console.log('[load] ok'))"`
  * `git diff --check`
  * `npm pack --dry-run`
