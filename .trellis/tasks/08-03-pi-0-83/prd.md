# 同步 Pi 0.83 开发基线并验证兼容性

## Goal

检查 Pi 从 0.82.0 升级到 0.83.0 后，`pi-cache-optimizer` 是否需要同步代码、类型、文档或依赖调整；保持已发布扩展对 Pi 0.82+ 的兼容，同时让本地开发锁文件和回归验证反映当前 Pi 版本。

## What I already know

- 用户反馈 Pi 已升级，希望确认本项目是否需要同步调整。
- 当前全局 `@earendil-works/pi-coding-agent` 为 `0.83.0`，项目 `package-lock.json` 与 `node_modules` 仍为 `0.82.0`。
- `package.json` 的 peer dependency 为 `"*"`，发布包不应把扩展绑定到某个 Pi 小版本；锁文件只负责本地开发基线。
- 本扩展使用的 Pi API 是 `getAgentDir()`、`ExtensionAPI`、`ExtensionContext`、`BuildSystemPromptOptions` 以及七个既有生命周期/provider hooks。
- Pi 0.83 changelog 的相关变更包括 Claude Opus 5（GitHub Copilot，adaptive thinking）、`ctx.scopedModels`，以及 TypeBox 1.3.7 移除 deprecated aliases。
- 已对比 Pi 0.82/0.83 的扩展类型和 system-prompt 类型：本扩展实际使用的 hooks、prompt options、agent-dir API 均保持兼容；本扩展不使用 TypeBox，也不需要 `scopedModels` 或 `outputPad`。
- `index.ts` 已通过 `ADAPTIVE_OPUS_PATTERN` 覆盖 Opus major version >= 5，但缺少针对 Opus 5 的直接回归测试。
- 现有 `npm run check` 基线已通过：typecheck、12 tests、diff check、pack dry-run 全部成功。

## Requirements

- 将本地开发 peer 包和 tracked `package-lock.json` 从 Pi 0.82.0 同步到 0.83.0。
- 保持 `peerDependencies.@earendil-works/pi-coding-agent` 为 `*`，不把发布包限制到 0.83。
- 增加直接覆盖 Claude Opus 5 adaptive-thinking 检测的回归测试：native `anthropic-messages` 缺失 compat 时报告 `forceAdaptiveThinking`，完整 compat 时不再报告；旧的非 adaptive Claude 模型保持 negative case。
- 不修改运行时缓存策略、hooks 语义、ambient type surface 或引入未使用的 Pi 0.83 API。
- 双语 README 补充当前已验证 Pi 0.83，并准确说明本扩展不依赖 0.83 专有 API；保留已有 Pi 0.79+ 安装/更新说明。
- 更新任务研究/规格记录，明确 0.83 的兼容性证据和不需要改代码的原因。

## Acceptance Criteria

- [x] `package-lock.json` 解析后直接依赖 `@earendil-works/pi-coding-agent` 为 `0.83.0`，且 lockfile integrity/resolved metadata 与 npm registry 一致。
- [x] `package.json` peer dependency 仍为 `*`，package version 不因仅同步开发基线而 bump。
- [x] 回归测试覆盖 Opus 5 missing/configured compat 和旧 Claude negative case，并直接调用真实导出的 internals。
- [x] Pi 0.83 本地依赖下 `npm run check` 全部通过。
- [x] `git diff --check`、`npm pack --dry-run` 和 Trellis task validation 通过。
- [x] README.md 与 README.zh-CN.md 的版本说明一致，无过时或互相矛盾的表述。

## Definition of Done

- 测试和类型检查通过。
- 依赖、文档、研究记录与实际行为一致。
- 变更保持最小，不影响用户现有 Pi 0.82+ 安装。
- 按 Trellis 流程完成 spec review、提交 commit，并记录收尾信息。

## Technical Approach

1. 使用 npm registry 的 Pi 0.83.0 包同步本地 `node_modules` 和 lockfile，不改变 peer dependency。
2. 在现有 `tests/review-findings.test.ts` 的 compat 相关 suite 中增加 Opus 5 检测测试，复用 `__internals_for_tests` 导出，避免复制实现逻辑。
3. README 双语在 adaptive-thinking 说明附近增加 Pi 0.83 验证范围和兼容边界；不宣传对 0.83 新增 API 的依赖。
4. 运行完整 package check，并用 diff/pack/task validation 做最终审计。

## Decision (ADR-lite)

**Context**: Pi 0.83 已安装在运行环境，但项目锁文件仍落后一个小版本；0.83 又加入了新的 adaptive-thinking 模型，需要确认现有检测是否覆盖。

**Decision**: 同步开发锁文件并补最小回归测试/文档；不扩大 peer 版本约束，也不为未使用的 Pi 0.83 API 增加适配层。

**Consequences**: 本地开发与当前 Pi 一致，Opus 5 行为有回归保护；发布包仍可被 Pi 0.82+ 加载。未来若使用 `scopedModels`、TypeBox 工具 schema 或 renderer API，再单独增加对应的类型和最低版本策略。

## Out of Scope

- 不重写缓存优化算法或 provider adapter。
- 不引入 `ctx.scopedModels`、TypeBox 1.3 API、`before_provider_headers` 等当前未使用能力。
- 不将 peer dependency 改为固定版本或提高最低 Pi 版本。
- 不修改用户 `models.json`、全局 Pi 安装或认证配置。

## Research References

- [`research/pi-0.83-compat.md`](research/pi-0.83-compat.md) — Pi 0.83 changelog、导出类型、TypeBox 变化和本项目影响分析。

## Technical Notes

- Project files inspected: `package.json`, `package-lock.json`, `index.ts`, `types/pi-coding-agent.d.ts`, `tests/review-findings.test.ts`, README 双语。
- Official local Pi docs inspected: `CHANGELOG.md`, `docs/extensions.md`, `docs/environment-variables.md`, `dist/core/extensions/types.d.ts`, `dist/core/system-prompt.d.ts`。
- Existing quality baseline: `npm run check` passed before this task's edits。
- Final verification: `npm ci --ignore-scripts`, `npm run check`, `git diff --check`, `npm pack --dry-run`, README parity audit, and `task.py validate` all passed; the suite now has 15 passing tests.
