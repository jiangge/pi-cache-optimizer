# 真实复现并修复 Anthropic TTL 冲突

## Goal

在 Pi 0.82.1 下使用真实失败 session 与 `pipi-cc/claude-opus-5` 端到端复现，采样最终 provider payload 的 cache breakpoint 坐标（不采集正文/密钥），确认 2.6.23 未生效或覆盖不完整的原因，并完成真实请求验证。

## Known Facts

- Pi CLI 实际版本为 0.82.1。
- Pi 从本仓库路径加载扩展，不是 npm node_modules 副本。
- `pipi-cc/claude-opus-5` 有效 API 为 `anthropic-messages`，compat 显式启用 long retention、tool cache control 和 adaptive thinking。
- 真实错误发生在同一 session，位置依次为 `messages.24.content.2/.3/.4.cache_control.ttl`。
- 必须避免输出 payload 正文、headers、key 或认证配置。

## Requirements

- 使用真实失败 session 的 fork 发起受控请求，不修改原 session。
- 通过后置调试 hook 只记录 `tools/system/messages` breakpoint 路径、type、ttl。
- 确认当前扩展 hook 是否被加载、是否修改 payload、以及 provider 最终收到的错误。
- 修复必须基于真实证据，不依赖 provider/model 名称硬编码。
- 增加能覆盖真实 payload 结构的回归测试。
- 真实请求成功后才宣称修复完成。

## Acceptance Criteria

- [x] 捕获真实失败上下文的最终 breakpoint 坐标序列。
- [x] 找到 2.6.23 未阻止错误的具体原因。
- [x] 修复后相同真实 session fork 请求成功，不再返回 TTL order error。
- [x] 不记录或持久化敏感 payload 内容。
- [x] TypeScript、定向测试和既有回归通过。

## Verification Result

- Pi 0.82.1 live reproduction using a fork of the exact failing session:
  - 2.6.23 visible-mixed-only logic: endpoint returned the same TTL order 400 while Pi's visible payload contained only `1h` controls.
  - Temporary force-short A/B: identical real request returned `OK`.
  - Formal 2.6.24 implementation, explicit optimizer-before-tracer order: tracer observed default-5m controls at tools/system/messages and endpoint returned `OK`.
- New official-vs-proxy regression: 12/12 passed.
- Prior Anthropic TTL regression: 17/17 passed.
- Lifecycle: 19/19; Kimi Issue #4: 21/21; Pi 0.82 review: 20/20; OpenAI retention: 15/15; routing passed.
- TypeScript, `git diff --check`, Trellis validation and `npm pack --dry-run` passed for 2.6.24.

## Out of Scope

- 修改真实原 session。
- 输出请求正文、API key、headers 或 token。
- 使用子代理。
- 发布，除非用户后续明确要求。
