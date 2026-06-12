# Adaptive thinking compat check + `fix` subcommand

## Goal

1. Doctor/compat 诊断覆盖 Anthropic adaptive thinking 代际模型：自定义 models.json 中 claude-opus-4-6+/sonnet-4-6+/fable-5 等模型若缺 `forceAdaptiveThinking: true`，pi 会发送旧版 `thinking: { type: "enabled", budget_tokens }` 请求体，被 adaptive-only 上游拒绝。
2. 新增 `/cache-optimizer fix` 子命令：自动修复本扩展诊断出的可修复配置问题，写入前必须向用户展示变更预览 + 风险提示并确认。

## What I already know (verified against pi 0.79.1 source)

* pi-ai `providers/anthropic.js`: `model.compat.forceAdaptiveThinking === true` → `params.thinking = { type: "adaptive", display }` + effort（经 `thinkingLevelMap`/`mapThinkingLevelToEffort`）；否则旧 budget 格式 `{ type: "enabled", budget_tokens }`。adaptive 模型自带 interleaved thinking，跳过 beta header。
* 内置 catalog (`models.generated.js`) 已为 claude-opus-4-6/4-7/4-8、claude-sonnet-4-6、claude-fable-5 设 `forceAdaptiveThinking: true`。
* **关键缺口**：`model-registry.js mergeCustomModels()` 用自定义条目**整体替换**内置条目（`merged[existingIndex] = customModel`），compat 不继承。自定义渠道写了同 id 模型但没写该 flag → 静默退回旧 thinking 格式。
* 用户实际 models.json 中 3 个条目命中此问题（lan/claude-fable-5, n1-claude/claude-opus-4-8, run-claude/claude-opus-4-8）。
* pi 的 models.json 经 `stripJsonComments` 解析 — **支持注释**。fix 若 JSON.parse→stringify 重写会丢注释，这是必须提示的风险。
* 现有 compat 诊断架构：`describeMissingCacheCompatForModel` / `buildDeepSeekCompatSuggestion` / `buildCompatDiagnosis`（index.ts ~1690-1760, 3630），doctor 在 `buildDoctorDiagnosis` + `buildLowHitDiagnosis`。
* 现有子命令 dispatch 在 index.ts:4328 `registerCommand("cache-optimizer")`，含 interactive menu（hasUI）与纯文本 fallback 两条路径。
* 扩展已有原子写文件模式（temp + rename，index.ts:3237 附近，用于 stats 持久化）。
* 项目无 node_modules，单文件 index.ts（4547 行），peer dep `@earendil-works/pi-coding-agent`。

## Requirements

* 新检查：anthropic-messages 通道上、模型 id 匹配 adaptive 代际（opus-4-6+ / sonnet-4-6+ / fable-5+，或内置 catalog 同 id 有 forceAdaptiveThinking）但有效 compat（provider.compat 与 model.compat 合并后）缺 `forceAdaptiveThinking: true` → doctor/compat 输出警告 + 建议 JSON。
* `fix` 子命令（已确认的范围决策见 ADR-lite）：
  * **范围：仅当前 active model**（其他渠道切换后再 fix）
  * **覆盖：全部安全建议** — adaptive thinking flag + DeepSeek compat（thinkingFormat / requiresReasoningContentOnAssistantMessages / supportsLongCacheRetention / sendSessionIdHeader / sendSessionAffinityHeaders）+ OpenAI proxy 的 sendSessionAffinityHeaders，与 doctor/compat 的 Safe default suggestion 完全对齐
  * 逐项展示：文件路径、修改位置（provider/model）、写入的 JSON、风险说明
  * 风险提示必含：① 修改影响所有使用该渠道的会话 ② 已自动备份到 models.json.backup-cache-optimizer-<ts> ③ 需重启 pi / 重载使配置生效
  * `ui.confirm`（或 select）确认后才写入；无 UI 时拒绝执行并提示手动修改
  * 写入用 temp + rename 原子模式；写前备份
* **注释保留（comment-preserving surgical edit）**：
  * 不做 JSON.parse→stringify 全量重写
  * 手写小型 JSONC 扫描器：逐字符扫描原始文本，正确处理字符串/转义/`//`/`/* */` 注释，跟踪 key 路径与括号深度，定位目标 model/provider 节点的精确字节区间
  * 最小插入：已有 compat 对象 → 在其 `{` 后插入缺失 key；无 compat → 插入整个 `"compat": {...},`（沿用相邻行缩进）
  * 文件其余字节不动 — 注释、缩进、key 顺序全保留（同 VS Code jsonc-parser modify/applyEdits 原理，手写精简版以维持零依赖）
  * 兜底 1：扫描器无法置信定位 → 拒绝写入，回退为手动修改指引
  * 兜底 2（写后自检）：用 strip-comments 方式重新 parse 修改后文本，断言目标 flag 生效 + 其余结构与原文件 deep-equal；失败则从备份还原并报错

## Decision (ADR-lite)

**Context**: fix 需要写 ~/.pi/agent/models.json；该文件支持注释且用户高度重视其安全（大量手工备份）。
**Decision**:
1. fix 范围 = 仅当前 active model（用户选 1）
2. fix 覆盖 = 全部安全建议，与 doctor/compat Safe default suggestion 对齐（用户选 1）
3. 注释保留 = 手写 JSONC 扫描器 + 最小文本插入（方案 A），否决引入 jsonc-parser 依赖（破坏零依赖单文件架构）与 parse→stringify 重写（丢注释）。
**Consequences**: 扫描器需充分单测（字符串内 `//`、转义引号、块注释跨行、尾逗号等边缘情况）；换来注释/格式 100% 保留 + 双兜底安全。

## Acceptance Criteria (evolving)

* [ ] doctor/compat 对缺 forceAdaptiveThinking 的 adaptive 代际模型给出明确警告与建议 JSON
* [ ] fix 在写入前展示完整 diff/预览 + 三项风险提示，用户拒绝则零写入
* [ ] fix 写入前创建带时间戳备份；写入为原子操作
* [ ] **注释/格式保留**：含注释的 models.json 修复后，除插入片段外逐字节一致；写后自检失败自动还原备份
* [ ] 无 UI 环境下 fix 不静默写入
* [ ] JSONC 扫描器边缘情况有单测（字符串内注释符、转义、块注释、尾逗号）
* [ ] bun test 全绿（如有测试基建）；bunx tsc --noEmit 通过

## Out of Scope (explicit)

* 不修改 pi 本体或 pi-ai
* 不自动修复需要凭据/渠道知识的问题（如 OpenRouter routing slug）

## Technical Notes

* pi 安装：/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/...
* 用户 models.json 既有大量手工备份文件，说明用户重视该文件安全 — fix 的备份行为符合其习惯
