# Pi 0.82 解决方案与代码审查 Findings

## 审查对象

- 提交：`3777927 fix: support pi 0.82 agent dirs and llama.cpp`
- 官方基线：`@earendil-works/pi-coding-agent 0.82.0`
- 核心证据：
  - Pi `dist/config.js#getAgentDir()`
  - Pi `dist/extensions/llama/provider.js`
  - bundled pi-ai `dist/api/openai-completions.js`
  - Pi `docs/environment-variables.md`, `docs/extensions.md`, `docs/llama-cpp.md`
  - 项目 `index.ts` hooks 与新增 verify scripts

## Solution Review

原方案识别了两个真实变化：Pi 支持自定义 agent dir，且 0.81+ 新增内置 `llama.cpp` provider。但实现将“合理动机”扩展成了两个未经官方行为支持的策略：

1. 自行发明 `PI_CONFIG_DIR` config-root fallback，而不是复用 Pi 官方 resolver。
2. 将 provider id `llama.cpp` 当作能力声明，全面禁用 cache-key/retention/diagnostics。

修正后的方案是：

- 所有 runtime I/O 路径直接使用 Pi 根导出的 `getAgentDir()`。
- `prompt_cache_key` 继续遵循 OpenAI-compatible API 统一策略，并保留 Pi core 已生成的 key。
- `prompt_cache_retention` 继续遵循既有安全 gate：官方 OpenAI保留、400 history 移除、`models.json` 显式 opt-in 保留、其他移除。
- 仅对 Pi 内置 llama provider 的明确 compat 指纹跳过不适用的 generic proxy routing/session-affinity 建议；同名 override/custom provider 不豁免。

## Code Review Findings

### High — 非官方 `PI_CONFIG_DIR` 会让扩展与 Pi 写入不同目录

**位置（原提交）**：`index.ts` 的 `resolvePiAgentDir()`。

**问题**：Pi 0.82 官方 `getAgentDir()` 只读取动态 `ENV_AGENT_DIR`（标准发行版为 `PI_CODING_AGENT_DIR`），否则使用 `CONFIG_DIR_NAME`。`PI_CONFIG_DIR` 既未记录，也未用于 agent-dir 解析。原实现会在 wrapper/harness 设置该变量时把 stats 与 `/fix` 的 `models.json` 写到 Pi 不使用的目录。

**额外影响**：原实现硬编码 `.pi` / `PI_CODING_AGENT_DIR`、trim 环境值，无法保持 rebranded distribution、raw whitespace、`file://` 等官方语义。

**修复**：runtime `STATE_DIR` 直接使用 `getAgentDir()`；display helper 根据 resolver 的实际结果格式化。新增 child-process negative case，证明仅设置 `PI_CONFIG_DIR` 不改变扩展 I/O。

### High — provider-id-only llama.cpp 分类误伤 override/custom provider

**位置（原提交）**：`isPiLocalLlamaCppModel()` 及所有调用方。

**问题**：Pi 允许 `registerProvider("llama.cpp", ...)` 覆盖 provider，也允许 `models.json` 在其上合成 override；`LLAMA_BASE_URL` 还可指向远程 router。provider id 不是“本地、单后端、无缓存能力”的证明。

**影响**：同名远程 proxy 被错误排除 cache-key、compat/fix、router diagnostics、400/403 diagnostics。

**修复**：改为 `isPiBuiltInLlamaCppModel()`，要求 Pi 内置 provider 的完整显式 compat 指纹，并要求 cache/routing override 字段仍未设置。同名自定义 provider 和显式 override 继续走普通 OpenAI-compatible 路径。新增 negative regression cases。

### High — README/spec 声称最终 payload 没有 `prompt_cache_key`，实现却只是不注入 fallback

**位置（原提交）**：`before_provider_request`、README 双语、footer stats spec、`verify-pi-0820-compat.ts`。

**官方证据**：Pi 0.82 `openai-completions` 在 long retention 且 compat 默认允许时，会在 hook 之前生成 `prompt_cache_key` 和 `prompt_cache_retention: "24h"`。内置 llama provider 没有显式把 `supportsLongCacheRetention` 设为 false。

**问题**：原代码仅让 extension fallback 返回 false，并没有删除 Pi core 已生成的 key；测试只验证 helper policy，未执行 hook outcome。

**修复**：不再无依据禁用 llama cache key。保留 Pi core/existing key，缺失时仍可使用同 session-id fallback。retention 使用项目已有的 explicit-opt-in 安全 gate。README/spec 已与实际行为同步。

### Medium — 新测试复制 gate 逻辑，无法发现同源策略错误

**位置**：原 `verify-pi-0820-compat.ts`、`verify-simplified-logic.ts`。

**问题**：前者验证项目自身 helper，后者复制 hook gate；二者都没有捕获真实 registered hook，也没有与官方 resolver/payload 结果对照，因此错误策略可以“实现和测试一起通过”。

**修复**：新增 `verify-review-fixes.ts`：

- 真实注册 extension 并捕获 `before_agent_start` / `before_provider_request` handlers。
- 用预置 Pi-core cache fields 验证最终 mutated/replacement payload。
- 覆盖同名 custom provider negative case。
- 用 child process 隔离环境，验证官方 agent-dir semantics。
- 修正 `verify-simplified-logic.ts`，只保留其适合验证的 retention gate 顺序，不再复制 llama provider policy。

### Medium — bypass/disable 早退留下 legacy global cache key

**位置**：`before_agent_start`。

**问题**：hook 开头清除 `latestCacheHint`，但旧 global `__piCacheOptimizerCacheKey__` 只在 publish path 中更新/删除。Responses bypass、runtime disable、prompt-rewrite opt-out 等早退后，消费者可能看到上一模型/route 的 stale key。

**修复**：在所有早退之前统一删除 legacy global；有效 rewrite path 再发布当前 key。直接 hook test 覆盖 Responses bypass。

### Low — ambient type facade 继续存在漂移风险

**位置**：`types/pi-coding-agent.d.ts`。

**结论**：现有 facade 有意保持最小类型面，但与 Pi 官方事件结构不完全一致。此次只增加实际使用的 `getAgentDir()` 声明，未做无关大范围类型重写。后续可单独任务评估移除 ambient facade、直接消费官方 types。

## Test Infrastructure Note

归档后的 verify scripts 保留 `../../../index.ts` 相对路径，移入 `.trellis/tasks/archive/YYYY-MM/...` 后路径失效，不能直接运行。这是 Trellis 归档后的测试可执行性问题，不是 runtime package regression。本次将 legacy scripts 临时复制回 live task 深度执行并全部通过；新权威 Pi 0.82 test 位于当前 live task。

## Final Assessment

- 原提交方向部分正确，但存在 3 个 High correctness/compatibility finding，不应按原样发布。
- 修复后路径解析与 Pi core 一致，llama 行为不再基于名称过度推断，cache-key/retention contract 与实际 hook outcome 一致。
- remote OpenAI-compatible proxy 的既有行为保持不变。
