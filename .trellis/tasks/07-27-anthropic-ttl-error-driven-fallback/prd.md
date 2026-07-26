# 将 Anthropic TTL 降级收窄为错误驱动

## Goal

撤回未发布 2.6.24 中“所有非官方 Anthropic endpoint 一律降级 1h→5m”的保守策略，避免误伤真实支持 1h 的第三方 endpoint；改为配置优先、可见冲突修复和真实错误后的 provider/model 定向运行时降级。

## Requirements

- `supportsLongCacheRetention: false` 继续由 Pi serializer 直接生成默认 5m，无需扩展特殊判断。
- 对所有 `anthropic-messages` 最终 payload，若 hook 可见 `5m/default → 1h` 非法顺序，立即统一降级该请求为 5m。
- 合法纯 1h 或 `1h → 5m` payload保持不变，不因 endpoint 是否官方而一刀切。
- 在 `message_end` 的 error message 中仅匹配明确 Anthropic TTL order error：同时包含 `cache_control`、`ttl='1h'`、`ttl='5m'` 和 `must not come after`。
- 错误 identity 使用 assistant message 的 request-local provider/model/api，缺失时才回退有效上下文模型；routing 场景保持 upstream identity。
- 记录 model-scoped runtime fallback set；后续该 provider/model 的 Anthropic payload 将所有 1h 降为 5m。
- Pi auto-retry 在失败 `message_end` 后应自动获得 fallback，无需用户手工重试。
- 每个模型只通知一次，文案说明运行时已降级并建议 `/cache-optimizer fix` 设置 `supportsLongCacheRetention: false`。
- `/cache-optimizer doctor` 显示已观察到 TTL order error 和运行时 fallback。
- `/cache-optimizer fix` 对已记录模型建议/写入 `supportsLongCacheRetention: false`，仍要求现有 UI 确认与备份流程。
- 不持久化错误响应正文、payload、headers 或 runtime fallback；进程/reload 后依赖正确 models.json 配置。
- 不按 provider id、base URL、模型名或 adapter family 决定 fallback。

## Acceptance Criteria

- [x] 第三方合法纯 1h payload 保持 1h。
- [x] 可见 mixed-order payload 首次请求即降为 5m。
- [x] 明确 TTL order error 被识别并记录正确 model key。
- [x] 同模型下一请求/自动 retry 降为 5m。
- [x] 其它 Anthropic 400、prompt-too-long、普通错误不触发 fallback。
- [x] 不同 provider 下相同 model id 不共享 fallback。
- [x] routed upstream identity正确。
- [x] doctor/fix 提示和持久配置建议正确。
- [x] 当前 `supportsLongCacheRetention: false` 的 pipi-cc 真实配置继续可用。
- [x] 既有 Anthropic/OpenAI/Kimi/routing/lifecycle/Pi 0.82 回归和 package checks 通过。

## Verification Result

- Error-driven Anthropic fallback: 15/15 passed, including auto-retry ordering, provider isolation, routing identity, prompt-too-long exclusion, doctor/fix, and merged adaptive+TTL suggestions.
- Visible mixed-order regression: 17/17 passed.
- Lifecycle: 19/19; Kimi Issue #4: 21/21; Pi 0.82 review: 20/20; OpenAI retention: 15/15; routing passed.
- TypeScript, `git diff --check`, Trellis validate, and `npm pack --dry-run` passed for the still-unpublished 2.6.24.
- The archived blanket-downgrade test has one intentionally superseded assertion and is documented in research/live-evidence.md; restoring it would reintroduce the over-broad behavior this task removes.

## Technical Approach

- 增加纯 helper `hasAnthropicCacheTtlOrderError(message)`，只检查 error assistant record 的字符串信号。
- extension closure 增加 `anthropicTtlOrderErrorModels` 与 warned set。
- `message_end` 在 error early-return 前识别和记录 fallback。
- `before_provider_request` 始终先执行可见 mixed-order normalization；若 model key 已记录，再强制降级 long controls。
- doctor/fix 复用现有 prompt-retention 400 与 403 的 model-scoped诊断结构。

## Out of Scope

- 自动持久化 runtime error history。
- provider 名称黑名单。
- 修改用户 models.json 而不经 `/cache-optimizer fix` 确认。
- Mainline prompt 过大问题（已在 `/home/jiang/jiang/source/mainline` 创建 intent `int_5a162dfc`）。
- 本任务自动 publish；发布需用户明确要求。
