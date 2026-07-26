# 修复 Anthropic 混合 TTL 顺序错误

## Goal

修复使用 `pipi-cc` 渠道的 `claude-opus-5` 时，Anthropic-compatible endpoint 因最终请求中 `cache_control` TTL 顺序非法而返回 `invalid_request_error`：`ttl='1h'` breakpoint 不得位于 `ttl='5m'` breakpoint 之后。

## What We Know

- 运行基线为 Pi 0.82.0。
- Pi 0.82 的 `anthropic-messages` serializer 在 cache retention 为 `long` 且 merged compat `supportsLongCacheRetention !== false` 时生成 `{ type: "ephemeral", ttl: "1h" }`。
- Pi 会在最后 immediate tool、system block、最后 user-message content block上放 cache breakpoint。
- Anthropic 按 `tools → system → messages` 顺序处理 breakpoints。
- Anthropic 中省略 `ttl` 的 ephemeral cache control 等价于默认 `5m`。
- 合法顺序允许 `1h → 5m`，但不允许任何 `5m → 1h`。
- 扩展当前全局请求 `PI_CACHE_RETENTION=long`，可能暴露第三方 Anthropic proxy / 历史 payload 的混合 TTL 不兼容。
- `before_provider_request` 能看到 provider serializer 完成后的最终 payload，并可安全返回替换 payload。

## Requirements

- 在 `before_provider_request` 中，仅对有效的 `anthropic-messages` payload 检查 cache TTL 顺序。
- 按 Anthropic 实际处理顺序检查：`tools`，然后 `system`，然后每条 `messages[].content`。
- 将 `cache_control.ttl === "5m"` 和省略 ttl 的 ephemeral cache control都视为短 TTL。
- 仅当发现短 TTL 之后又出现 `1h` 时修复。
- 修复时将本次 payload 中所有 `1h` breakpoint 降级为默认 `5m`（删除 `ttl`），确保顺序合法且不延长任何已有缓存。
- 合法 payload 必须保持对象和值不变：纯 1h、纯 5m、`1h → 5m`、无 cache control、非 Anthropic API。
- 不按 provider id、base URL、模型 id/name 或 adapter family 硬编码。
- 不记录、持久化或显示 payload/prompt 内容。
- 保持 OpenAI `prompt_cache_key` 和 `prompt_cache_retention` 逻辑不变。

## Acceptance Criteria

- [x] `tools: 5m → system: 1h` 被统一降级为 5m。
- [x] `system: 5m → messages: 1h` 被统一降级为 5m，并覆盖用户报告的 `messages.N.content.N` 场景。
- [x] 省略 ttl 的 cache control 被视为 5m。
- [x] 合法 `tools/system: 1h → messages: 5m` 不被修改。
- [x] 纯 1h、纯 5m、无 cache control payload 不被修改。
- [x] 非 `anthropic-messages` model 不触发该修复。
- [x] routed model 使用有效 upstream API 判断。
- [x] 现有 OpenAI payload、Kimi stats、routing、Pi 0.82 和 lifecycle 回归保持通过。
- [x] TypeScript、`git diff --check`、`npm pack --dry-run` 和 Trellis validate 通过。

## Verification Result

- Anthropic TTL targeted regression: 17/17 passed, including the reported `messages.N.content.N` shape and runtime-disabled protocol safety.
- Lifecycle regression: 19/19 passed.
- Kimi Issue #4 regression: 21/21 passed.
- Pi 0.82 current review regression: 20/20 passed.
- Simplified OpenAI retention regression: 15/15 passed.
- Routing-provider protocol regression passed.
- TypeScript, `git diff --check`, Trellis validate, and `npm pack --dry-run` passed for `2.6.23`.

## Technical Approach

新增纯 helper：

1. 从 Anthropic payload 的已知 breakpoint 位置收集 `cache_control` 引用，严格保持 wire processing 顺序。
2. 判断是否出现 short breakpoint 后再出现 long breakpoint。
3. 若非法，浅层保留 payload 结构并删除每个 `ttl: "1h"`；由于 hook payload 本身允许 mutation，helper 可原位修复并返回是否 changed，避免复制 prompt/message 内容。
4. 在 `before_provider_request` 的 Anthropic API gate 中调用；之后继续执行现有 OpenAI gate，非 OpenAI API自然早退。

## Decision (ADR-lite)

**Context**: 可选择按 `pipi-cc` 名称禁用 long retention、永远把第三方 Anthropic 降为 5m，或只修复最终 payload 中可证明非法的混合顺序。

**Decision**: 选择最终 payload 结构检测。仅在可证明存在 `5m → 1h` 时统一降级该请求的 long breakpoints。

**Consequences**:

- 避免 provider/model 名称硬编码。
- 官方 Anthropic 和支持 1h 的代理继续获得 long retention。
- 已经合法的 mixed TTL 不受影响。
- 如果代理在 `before_provider_request` 之后自行注入冲突 breakpoint，扩展无法观察；该情况需代理修复或在 models.json 设置 `supportsLongCacheRetention: false`。

## Out of Scope

- 修改 Pi 0.82 或 `pi-ai` 依赖源码。
- 自动写 `models.json`。
- 根据 `pipi-cc` provider 名称永久禁用 long retention。
- 修复代理在请求离开 Pi 后追加的 cache control。
- npm 发布，除非用户后续明确要求。
