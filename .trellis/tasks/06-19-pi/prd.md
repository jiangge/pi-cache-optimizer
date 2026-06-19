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

* 无。版本号不需要更新：本次只有 README 兼容说明调整，没有 runtime/package API 行为变更。

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
* [x] package version 回退到无需发版的版本。
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
* Validation passed: `bunx tsc --noEmit --pretty false`, `git diff --check`, `npm pack --dry-run`, `python3 ./.trellis/scripts/task.py validate .trellis/tasks/06-19-pi`.
