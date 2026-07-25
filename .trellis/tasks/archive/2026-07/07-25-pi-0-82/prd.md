# 审查 Pi 0.82 兼容方案与代码

## Goal

对提交 `3777927`（Pi 0.82 agent-dir 与 llama.cpp 兼容调整）进行独立的解决方案和代码审查。审查不仅验证现有测试，还要对照 Pi 0.82 官方实现核验假设，识别 correctness、回归、平台兼容、可维护性、测试有效性和文档一致性问题；发现明确缺陷时直接做最小修复并验证。

## What I already know

- 待审查工作提交为 `3777927 fix: support pi 0.82 agent dirs and llama.cpp`。
- 主要方案包括：
  - stats / models.json 路径尊重 `PI_CODING_AGENT_DIR`，并增加 `PI_CONFIG_DIR` root fallback。
  - provider `llama.cpp` 从 proxy cache-key、long retention、compat/fix、router diagnostics、400/403 diagnostics 中排除。
- Pi 0.82 官方 `dist/config.js#getAgentDir()` 只读取动态环境键 `PI_CODING_AGENT_DIR`，否则使用 `homedir() + CONFIG_DIR_NAME + agent`；未读取 `PI_CONFIG_DIR`。
- Pi 包根导出官方 `getAgentDir()` 和 `CONFIG_DIR_NAME`。
- 当前项目通过 ambient declaration 为 Pi API 提供最小类型面，并以 peer dependency `*` 发布。

## Assumptions

- 本次是高强度审查；明确问题直接修复，无需逐项征求确认。
- 审查重点是最近 Pi 0.82 变更，但允许修复由该方案暴露的紧邻缺陷。
- 不做无关重构，不改变公开命令 UX，除非修复必需。

## Review Questions

1. 路径解析是否与 Pi 0.82 官方 `getAgentDir()` 完全一致，尤其是 `PI_CONFIG_DIR`、rebranded distributions、tilde、相对路径和 Windows？
2. `llama.cpp` 全面排除 `prompt_cache_key` / long retention 是否有官方实现或协议依据，还是过度假设？
3. route snapshot / virtual provider 情况下，llama.cpp 判定是否基于真实 upstream model，是否存在 stale/global hint 泄漏？
4. hook gate 顺序、runtime disable、已有 payload 字段保留、400/403 状态是否有回归？
5. 新验证脚本是否测试真实实现，还是复制 gate 逻辑导致同错通过？
6. README、spec、research 和 package version 是否准确一致？

## Requirements

- 对照 Pi 0.82 官方 changelog、docs 和 `dist` 实现审查。
- 审查 `index.ts` 中所有本次新增/修改路径，并检查调用链。
- 审查新增和受影响 verify scripts 的 assertion quality。
- 按严重级别记录 findings，包含文件/位置、影响、证据和建议。
- 明确缺陷做最小修复；修复后更新测试、README/spec/research（按需）。
- 保持 remote OpenAI-compatible proxy 的既有行为。

## Acceptance Criteria

- [x] 每个方案假设都有官方 Pi 实现或可验证行为作为依据。
- [x] 路径解析与 Pi 核心一致，不会因非官方环境变量写入不同目录。
- [x] llama.cpp 行为边界清楚且不会误伤同名自定义 provider/remote proxy。
- [x] 测试直接覆盖关键实现 helper/hook outcome，并包含 negative/regression cases。
- [x] `bunx tsc --noEmit --pretty false` 通过。
- [x] 所有相关 verify scripts 通过。
- [x] `git diff --check`、`npm pack --dry-run`、Trellis validate 通过。
- [x] 输出 solution review + code review findings 和最终结论。

## Review Result

- 发现并修复 3 个 High、2 个 Medium、1 个 Low finding。
- Runtime I/O 改为官方 `getAgentDir()`。
- llama.cpp 从 provider-id blanket exclusion 改为内置 compat 指纹识别；保留 Pi core/session cache key，retention 使用统一 explicit-opt-in gate。
- 新增 direct hook outcome、same-id override、官方 env parity、stale global negative tests。
- 正式 findings：[`research/review-findings.md`](research/review-findings.md)。

## Out of Scope

- 重写单文件架构。
- 新增无关 provider adapter。
- 发布 npm package。
- 修改 Pi 核心或用户全局配置。

## Technical Notes

- 待审提交：`3777927`。
- 官方 Pi 0.82：`/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/`。
- 关键官方实现：`dist/config.js`, `dist/extensions/llama/provider.js`, `docs/extensions.md`, `docs/environment-variables.md`, `docs/models.md`。
- 关键项目文件：`index.ts`, `types/pi-coding-agent.d.ts`, README 双语、footer stats spec、hook guidelines。
