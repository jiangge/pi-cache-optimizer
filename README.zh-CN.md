# Pi Cache Optimizer

[![CI](https://github.com/jiangge/pi-cache-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/jiangge/pi-cache-optimizer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dm/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![license](https://img.shields.io/npm/l/pi-cache-optimizer.svg)](./LICENSE)

[English README](./README.md)

用于提升 Pi 中 provider 侧 KV Cache / Prompt Cache 命中率的扩展：把稳定 prompt 内容前置，给 OpenAI-compatible 请求补保守的 `prompt_cache_key`，提示代理渠道常见缓存路由兼容问题，并在底部显示只读缓存统计。

> 本包已从 `pi-deepseek-cache-optimizer` 改名。已有底部统计会自动迁移。正常 hook 运行时扩展不会触碰 Pi 的 `models.json`（默认 `~/.pi/agent/models.json`；自定义 agent 目录使用 `PI_CODING_AGENT_DIR`）；只有 `/cache-optimizer fix` 和 `/cache-optimizer rollback` 可在展示交互式预览、风险提示并得到明确确认后写入，且都会先创建带时间戳的自动备份。

## 目录

- [功能](#功能)
- [安装](#安装)
- [命令](#命令)
- [持久 Opt-out](#持久-opt-out)
- [按模型关闭 `prompt_cache_key`](#按模型关闭-prompt_cache_key)
- [Opt-in 确定性工具排序](#opt-in-确定性工具排序)
- [Footer 缓存统计模式](#footer-缓存统计模式)
- [OpenAI-compatible 代理配置](#openai-compatible-代理配置)
- [Adaptive thinking 模型](#adaptive-thinking-模型)
- [使用 `/cache-optimizer fix` 自动修复](#使用-cache-optimizer-fix-自动修复)
- [DeepSeek 协议安全与回滚](#deepseek-协议安全与回滚)
- [Footer 统计](#footer-统计)
- [原生虚拟模型（Pi 0.99+）](#原生虚拟模型pi-099)
- [Router / Virtual-channel 扩展作者指南](#router--virtual-channel-扩展作者指南)
- [卸载](#卸载)
- [验证效果](#验证效果)
- [License](#license)

## 功能

- 将能唯一定位的稳定 system prompt 内容移动到动态上下文之前。如果同一候选出现多次（例如动态上下文引用了它），则保持原样，避免删除错误的那一处。
- 压缩 Pi skill 列表，并移除 session-overview 中的易变字段。
- 在 Pi / provider compat 支持时请求长缓存保留。
- 对 `openai-completions` / `openai-responses` 请求，在没有有效 key 时使用 Pi session id 补 `prompt_cache_key`；Pi 0.82+ core 对内置 `llama.cpp` 也使用这一语义。
- 对缺少缓存 / session-affinity compat 的第三方 OpenAI-compatible 代理给出一次性提醒。
- 检测 Claude（opus-4.6+ 含 Opus 5、sonnet-4.6+ 含 Sonnet 5、fable-5+）以及 Kimi Coding K3 / `kimi-for-coding` 自定义渠道的 adaptive-thinking compat。
- 使用每个 extension instance 独占的原子 shard 保存缓存统计，避免父会话、子 Pi agent 和并行 Pi 进程互相覆盖。
- Footer 默认显示当前 conversation session 的 provider/model 统计；`total` 可聚合同一精确 provider/model 的所有有效本地 shard。
- 通过版本化全局协议（`Symbol.for("pi.routing.registry.v1")` 与 `Symbol.for("pi.cache.hints.v1")`）支持可选的 router extension 集成，而不导入任何 router 包。
- 提供默认关闭的确定性排序，用于已验证的 Pi 内置工具 payload。
- 支持 Pi 0.99+ 原生虚拟模型（`pi.registerVirtualModel()`）：请求 hook、footer 统计和诊断都作用于每次请求实际路由到的物理模型。

缓存是 provider 侧的 best-effort 行为。第三方代理和 router extension 仍可能隐藏缓存 usage、拒绝不支持的参数，或把请求路由到多个上游。

## 安装

```bash
pi install npm:pi-cache-optimizer
```

如果之前安装过旧包：

```bash
pi remove npm:pi-deepseek-cache-optimizer && pi install npm:pi-cache-optimizer
```

安装、更新或移除后，在 Pi 中运行 `/reload`，让 extension hooks 刷新。

Pi 0.79.7 及之后，`pi update` 默认只更新 Pi 本体。若要更新已安装的 Pi package（包括本扩展），请运行 `pi update --extensions`（只更新 packages）或 `pi update --all`（Pi 与 packages 一起更新）。

本扩展要求 Pi 0.82+，并已使用 Pi 0.99.2 验证。TypeScript 校验直接使用官方 Pi package 类型，同时只使用这些版本共有的 extension hooks、`getAgentDir()` 和 prompt options；不依赖 Pi 0.83+ 专有 API（例如 `ctx.scopedModels` 或 bundled TypeBox 1.3 aliases）。原生虚拟模型支持与 codemode 嵌套工具调用合并只在会产生它们的 Pi 0.99+ 上生效，较早版本保持原有行为。

## 命令

| 命令 | 作用 |
|---|---|
| `/cache-optimizer` | UI 支持时打开交互菜单；否则打印帮助和当前状态。 |
| `/cache-optimizer enable` | 在当前 Pi 进程中开启运行时优化，清零本地 footer 统计，并开始新的“开启状态”测量。 |
| `/cache-optimizer disable` | 在当前 Pi 进程中关闭优化，清零本地 footer 统计，并继续以 disabled 对比模式采集 footer 统计。运行 `/reload` 或重启 Pi 后回到启动时行为。 |
| `/cache-optimizer doctor` | 显示当前模型 / provider / API / base URL / compat 与低命中诊断。 |
| `/cache-optimizer compat` | 对当前模型显示可复制的 compat 建议（如适用）。 |
| `/cache-optimizer stats` | 显示当前 conversation session 今天使用过的各 cache-adapter-matched 模型详细统计。 |
| `/cache-optimizer stats all` | 显示所有有效本地 session/shard 今天的逐模型详细总计，包括请求数与 token 数。 |
| `/cache-optimizer stats contributors` | 显示当前精确 provider/model 的当前/其他贡献 session，不暴露 session id。 |
| `/cache-optimizer reset` | 重置当前 provider/model 的本地 footer 统计；不会修改上游 provider 缓存。 |
| `/cache-optimizer config footer-mode total\|session\|process` | 持久设置 footer 统计模式；持久命令配置优先于环境变量。 |
| `/cache-optimizer fix` | 为当前模型自动修复安全的 compat 问题。展示预览 + 风险提示，需要用户确认；原生 compat 修复写 `models.json`，已观测到的 `prompt_cache_key` 问题写扩展配置。 |
| `/cache-optimizer fix prompt-cache-key` | 明确把当前 OpenAI-compatible provider/model 配置为从最终请求体移除 `prompt_cache_key` 与 `promptCacheKey`。需要确认。 |
| `/cache-optimizer rollback` | 查看最近一次匹配的已确认修复；经 UI 确认后安全恢复扩展配置或 `models.json` 修复。 |

`/cache-optimizer` 使用 Pi 原生 Tab 补全：输入 `/cache-optimizer <Tab>` 查看支持的子命令，输入 `/cache-optimizer stats <Tab>` 补全 `all` 或 `contributors`，输入 `/cache-optimizer fix <Tab>` 补全 `prompt-cache-key`，输入 `/cache-optimizer c<Tab>` 补全 `config`，输入 `/cache-optimizer config <Tab>` 补全 `footer-mode`，输入 `/cache-optimizer config footer-mode <Tab>` 补全 `total`、`session` 或 `process`。建议会按当前前缀过滤；无效前缀返回空结果，由 Pi 正常回退处理。

交互式 `/cache-optimizer` 菜单包含 `Footer mode`，可以选择 `total`、`session` 或 `process`。`enable` / `disable` 是当前进程内开关。若要持久关闭某些能力，请使用下面的环境变量。

## 持久 Opt-out

| 环境变量 | 作用 |
|---|---|
| `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` | 只关闭 prompt 改写；footer 统计和 cache-key fallback 仍启用。 |
| `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` | 显式允许原生 virtual prompt 改写，但仅当 routing registry 暴露的候选链不包含 Responses/Codex 时生效。路由未知或信息不完整时仍保持原 prompt。 |
| `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` | 保留 Pi 原始 verbose skill XML。 |
| `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | 关闭 OpenAI-compatible `prompt_cache_key` fallback。推荐使用这个显式 opt-out。 |
| `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` | 通过旧的反向开关关闭同一个 fallback。取值 `0`、`false`、`no`、`off` 时关闭。 |

持久化 feature 配置由 Pi agent 目录中的原生命令管理，并且优先于对应环境变量：

```text
/cache-optimizer config prompt-rewrite on|off
/cache-optimizer config virtual-rewrite on|off
/cache-optimizer config skill-compression on|off
/cache-optimizer config openai-cache-key on|off
/cache-optimizer config tool-order on|off
/cache-optimizer config footer-mode total|session|process
/cache-optimizer config reset
```

`config reset` 会移除持久化 feature 覆盖，同时保留现有 footer mode 和按模型配置的 prompt-cache-key 设置。这些命令不会修改 shell 启动文件或 `PI_CACHE_RETENTION`；`enable` 和 `disable` 仍然是当前进程的运行时开关。

## Opt-in 确定性工具排序

`PI_CACHE_OPTIMIZER_TOOL_ORDER=1` 会对 Pi 内置 OpenAI Completions、Anthropic、Google 与 Bedrock payload 中已验证的工具定义进行确定性排序。Truthy 取值为（不区分大小写）`1`、`true`、`yes` 或 `on`。该能力默认关闭、仅在当前进程生效，并会被 `/cache-optimizer disable` 抑制。

工具按精确名称排序，并用原始 index 作为稳定的同名 tie-breaker。排序只对发生变化的已验证对象/数组路径做浅 clone。工具对象和无关请求字段保持原引用，包括 Google/Vertex 的 `AbortSignal`；工具 schema、tool choice、routing 字段和调用方输入都保持不变。

出于安全考虑，只要工具存在顶层 `cache_control` marker，或 Anthropic payload 包含 `defer_loading` 分组，payload 就保持不变。未知 / 自定义 API、畸形工具、缺少名称或不支持的 shape 同样保持不变。纯 helper 可识别 OpenAI Responses fixture，但 request hook 保留既有 Responses/Codex bypass，不会重排这些请求。

回滚很简单：删除变量或设为非 truthy 值，然后运行 `/reload`。如需使用本地 fixture 验证转换、且不连接 provider，可运行：

```bash
bun .trellis/tasks/09-03-context-epoch-tool-ordering/verify.ts
```

该 verifier 只报告数字形式的工具排序变化，并确认带 cache marker 的 payload 不会变化。由于它不会连接 provider，provider cache usage 会明确报告为 unavailable，也不会虚构 cache hit。

## Footer 缓存统计模式

当前版本把统计保存在 Pi agent 目录的 `pi-cache-optimizer-stats.d/shards/` 下。每个已加载的 extension instance 独占一个 UUID 命名 shard，并通过临时文件 + 原子 rename 写入，因此父/子/并行 Pi 进程不会互相覆盖。旧 v6 单文件统计在升级时直接删除，本地 footer 计数从零开始；不会影响上游 provider 的实际缓存。

Footer 默认使用 `session`，避免另一个并行 Pi 终端使用相同 provider/model 时污染当前窗口。可以通过命令或环境变量切换显示范围：

| 值 | 作用 |
|---|---|
| `session`（默认） | 聚合今天携带当前 hashed Pi conversation session id 且精确 provider/model 相同的 shard。Extension reload 会产生新 instance shard，但仍属于同一 session 范围。 |
| `total` | 聚合今天同一精确 provider/model 的全部有效本地 shard，包括加载本扩展并共享同一 agent 目录的子 Pi agent。 |
| `process` | 仅显示当前 extension instance 采集的统计。Pi 重启或 extension reload 后从 `0/0` 开始。 |

持久命令配置优先于环境变量：

```text
/cache-optimizer config footer-mode total
/cache-optimizer config footer-mode session
/cache-optimizer config footer-mode process
```

显式设置保存在 Pi agent 目录下的 `pi-cache-optimizer-config.json`。没有命令覆盖时，读取 `PI_CACHE_OPTIMIZER_FOOTER_MODE=total|session|process`；值不区分大小写，缺失或非法值均回退到 `session`。如需让已有安装重新由环境变量控制，请手动删除 `pi-cache-optimizer-config.json`，然后运行 `/reload`。

## 按模型关闭 `prompt_cache_key`

某些 OpenAI-compatible endpoint 会因 `prompt_cache_key` 返回 HTTP 400，但同一个字段对其他 provider 可能有效。Pi 0.99.2 没有原生的 `supportsPromptCacheKey` compat 字段，**不要**把这个未知字段加入 `models.json`。`supportsLongCacheRetention` 也不是等价开关，不应借用来实现此目的。

当扩展观察到精确 provider/model 对 `prompt_cache_key` 的明确字段级拒绝后，普通 `/cache-optimizer fix` 会提供经过确认的模型级修复。参数值校验失败，以及“设置 temperature 时不允许”这类条件限制都不构成证据。若不同模型的响应并发交错，而 Pi 又没有提供 request ID，扩展会忽略无法安全关联的 response-header 证据；只有最终 assistant message 提供精确 provider/model 身份时才恢复归因。如果你已经确定 endpoint 不支持该字段，可以主动执行：

```text
/cache-optimizer fix prompt-cache-key
```

预览会说明设置保存在扩展自有的 `pi-cache-optimizer-config.json` 中。确认后，`before_provider_request` 的最终阶段会移除 `prompt_cache_key` 和 `promptCacheKey`，包括 Pi core 之前已经放入的 key。这个精确模型可能因此失去 provider prompt-cache 命中，其他模型仍保持原有 fallback 行为。配置通过原子、不可覆盖并发新建文件的方式写入，并生成不含敏感内容的备份/receipt；需要 `/reload` 或重启 Pi。`/cache-optimizer rollback` 可恢复之前的扩展配置且不会重置 `footerMode`；它会绑定预览时 receipt 的文件身份和 hash，在 receipt 被替换时拒绝操作，并在 receipt 状态写入失败时补偿恢复配置。

## OpenAI-compatible 代理配置

LiteLLM / OneAPI / NewAPI / 类 OpenRouter 渠道等第三方 `openai-completions` 代理，常会把同一个 session 分散到多个上游后端，导致 provider 侧 prompt cache 被拆散。

Pi 0.84.1 还修复了内置 Fireworks 渠道对拒绝 `prompt_cache_retention` 的模型兼容性；本扩展不按 provider 名称增加特殊分支，而是结合 `models.json` 与 runtime model，按精确 provider/model 解析有效 compat。Pi 0.81+ 也内置了使用 OpenAI-shaped transport 的 `llama.cpp` provider。Pi 0.82+ core 在启用 cache retention 时会为它生成 session `prompt_cache_key`，因此本扩展会保留该 key，并在缺失时使用同样的保守 fallback。只有符合 Pi 内置 provider 明确 compat 指纹的模型会跳过通用 proxy 路由 / session-affinity 建议；仅复用 `llama.cpp` id 的自定义或覆盖 provider 仍按普通 OpenAI-compatible 渠道处理。`prompt_cache_retention` 继续遵循统一安全规则：仅官方 OpenAI 或 `models.json` 中有效配置为 `supportsLongCacheRetention: true` 时保留，否则发送前移除。Pi 0.99.2 没有原生的 `supportsPromptCacheKey` compat 字段，因此按模型关闭 key 的策略保存在本扩展的 `pi-cache-optimizer-config.json` 中，而不是 `models.json`。扩展配置独立于 Pi 的 compat 优先级，只影响其中列出的精确 provider/model。

对真正的代理，建议先启用 session affinity：

```json
{
  "providers": {
    "your-provider-id": {
      "api": "openai-completions",
      "baseUrl": "https://example.com/v1",
      "apiKey": "env:YOUR_API_KEY",
      "compat": {
        "sendSessionAffinityHeaders": true
      },
      "models": [
        { "id": "gpt-5.5", "name": "GPT-5.5" }
      ]
    }
  }
}
```

说明：

- `sendSessionAffinityHeaders: true` 是安全默认项，前提是你的代理支持 sticky routing。
- `supportsLongCacheRetention: true` 是可选项。只有 endpoint 明确支持 OpenAI long prompt cache retention 时才添加。
- 不要把 `supportsPromptCacheKey` 加入 `models.json`：Pi 0.99.2 没有定义这个 compat 字段。请使用 `/cache-optimizer fix prompt-cache-key` 在扩展自有配置中保存精确 provider/model 的 omit 规则；它会移除两种 key 写法，包括 Pi 提供的 key。
- 如果出现 `400 Unsupported parameter: prompt_cache_retention`，请为该渠道移除 / 避免 `supportsLongCacheRetention`；如支持，可保留 `sendSessionAffinityHeaders`。扩展会从响应头或最终 assistant error message 中识别这条明确错误，并在当前进程的后续请求中移除该参数。
- 使用 `/cache-optimizer compat` 或 `/cache-optimizer doctor` 查看当前模型的具体建议。
- DeepSeek 模型名只用于选择 `DS cache` adapter，不能证明 reasoning wire protocol。缺少或使用非 DeepSeek format 时仍保留通用缓存 / 路由建议；只有 effective `compat.thinkingFormat: "deepseek"` 被明确配置时，才显示 DeepSeek replay 建议，且不会把 `thinkingFormat` 列为缺失修复项。
- 不要因为模型 id 含有 `deepseek` 就添加 `thinkingFormat: "deepseek"`；catalog 中也存在 `openai`、`qwen`、`openrouter`、`together` 或没有显式 format 的情况。
- 本扩展的 `doctor` 和 `compat` 命令只给建议，不会修改 `models.json`。

## Anthropic 缓存 TTL 兼容

Anthropic 按 `tools → system → messages` 顺序处理 cache breakpoint，并拒绝位于 5 分钟 breakpoint 之后的 `ttl: "1h"` breakpoint。省略 `ttl` 的 ephemeral `cache_control` 使用默认 5 分钟保留时间。

对于所有 `anthropic-messages` 渠道，本扩展都会检查最终序列化 payload，并立即降级可见的非法短 TTL → 长 TTL 顺序。合法的纯 `1h` 和 `1h → 5m` payload 保持不变，包括真正支持 1 小时保留的第三方 endpoint。

部分代理会在 Pi request hook 之后重写或插入隐藏的 5 分钟 breakpoint。如果 provider 返回 Anthropic 明确的 TTL 顺序错误，本扩展会记录当前进程内的 provider/model fallback，使下一次后续请求使用默认 5 分钟 TTL。Pi 0.82.1 将此错误视为不可自动重试的 HTTP 400，因此扩展不会声称 Pi 会自动重跑失败 turn；如果其它层发起重试，该重试也会使用 fallback。`/cache-optimizer doctor` 会显示该 fallback，`/cache-optimizer fix` 可通过现有确认/备份流程，以 model level 持久写入 `supportsLongCacheRetention: false`。其它 400 和 prompt-too-long 错误不会触发该 fallback。运行时观测会持续到当前进程退出，并会在同一进程内的扩展 reload 后保留。

## Adaptive thinking 模型

Claude 从 opus-4.6 / sonnet-4.6（含 Opus 5、Sonnet 5）/ fable-5 开始需要在 compat 中设置 `forceAdaptiveThinking: true`。Kimi Coding K3（`k3`）和 `kimi-for-coding` 也使用 adaptive thinking，并需要 `allowEmptySignature: true`，以正确重放空 signature 的 thinking block。缺少这些 compat 时，Pi 可能发送旧版 thinking payload 或错误重放 thinking。Pi 0.83+ 的原生 Opus 5 catalog 已覆盖在同一 adaptive-thinking 检测中；如果自定义 `anthropic-messages` 渠道没有继承该 compat，仍需手动设置。

Pi 内置 catalog 已为官方模型设置此 flag。`models.json` 中覆盖这些模型的自定义渠道必须包含该 flag：

```json
{
  "providers": {
    "your-claude-channel": {
      "api": "anthropic-messages",
      "baseUrl": "https://...",
      "apiKey": "env:YOUR_KEY",
      "compat": {
        "forceAdaptiveThinking": true
      },
      "models": [
        { "id": "claude-sonnet-5", "name": "Claude Sonnet 5" }
      ]
    }
  }
}
```

或使用模型级 override：

```json
{
  "providers": {
    "your-claude-channel": {
      "modelOverrides": {
        "claude-sonnet-5": {
          "compat": {
            "forceAdaptiveThinking": true
          }
        }
      }
    }
  }
}
```

Kimi Coding K3 自定义渠道如果包含混合模型，建议使用模型级 compat：

```json
{
  "providers": {
    "your-kimi-coding-channel": {
      "modelOverrides": {
        "k3": {
          "compat": {
            "forceAdaptiveThinking": true,
            "allowEmptySignature": true
          }
        }
      }
    }
  }
}
```

Pi 0.80.9+ 已在内置 Kimi Coding、Moonshot AI / 中国区、OpenRouter 和 Vercel AI Gateway catalog 中加入 Kimi K3。Moonshot/OpenRouter 变体使用 OpenAI-compatible transport，继续走普通 Kimi footer / proxy 路径；上面的 adaptive compat 只适用于 `anthropic-messages` Kimi Coding 渠道。

`/cache-optimizer doctor` 和 `/cache-optimizer compat` 会检测缺失的 flag 并显示可复制的 JSON。

## 使用 `/cache-optimizer fix` 自动修复

**v2.6.0+** 新增 `fix` 子命令，可自动修复安全的 compat 问题：

- Adaptive thinking（`forceAdaptiveThinking: true`；Kimi Coding K3 / `kimi-for-coding` 还包括 `allowEmptySignature: true`）
- DeepSeek Pi Mono replay compat（仅当已明确配置 `thinkingFormat: "deepseek"` 时使用 `requiresReasoningContentOnAssistantMessages: true`；`/fix` 不会自行推断该 format）
- OpenAI-compatible proxy session affinity（`openai-completions` 使用 `sendSessionAffinityHeaders: true`）。Pi 0.80.7+ 使用 `sessionAffinityFormat` 控制 `openai-responses` header 形式并自动检测默认值；本扩展不再写入已移除的 `sendSessionIdHeader`。

**范围：** 从当前 active model 发起修复。仅缺少 affinity 时，如 provider 已有配置项且无更高优先级配置遮挡，可一次写入 provider 级 compat，覆盖其适用模型（包括不在 `models[]` 中的模型）；模型级显式 `false` 仍为 opt-out。其他或有歧义的修复仍按模型处理。

**安全机制：**

1. 显示完整变更预览（文件路径、编辑位置、要写入的 JSON、风险说明）
2. 警告：① 修改影响使用该渠道的所有 session，② 自动备份到 `models.json.backup-cache-optimizer-<timestamp>`，③ 需重启 Pi 或 reload
3. 使用保留注释的精确编辑器 —— 现有注释、缩进和已有 key 顺序都会保留
4. 需要用户明确确认（交互式提示或 `ui.select`）
5. 写入与失败恢复都使用原子替换（temp + rename）；写入后自我验证
6. 完全保留 `models.json` 原有访问权限，不主动收紧或放宽（例如 `0600` 保持 `0600`，`0644` 保持 `0644`）
7. 备份名唯一且不会覆盖已有备份；如果 JSONC 扫描器无法置信定位目标，则回退到手动修改指引

已有的 `modelOverrides[modelId]` 具有 Pi 的最高优先级，因此 `fix` 会直接修复该 entry。对于没有自定义 `models[]` entry 的内置模型或 API-login 模型，若现有 provider 可安全使用 provider 级 affinity 修复，则优先写入 provider compat；否则 `fix` 会创建仅含 compat 的 `modelOverrides` entry，而不会凭空添加自定义模型定义。运行时观察到的 provider 失败也始终写入这一最高优先级 model override，避免 extension-provided runtime compat 遮挡修复。自检会验证完整的 provider → custom model → runtime model → modelOverride 结果；无效的低层写入会被拒绝。

**非交互模式：** 拒绝写入，显示手动编辑指引。

**运行：** 当 active model 检测到 compat 问题时执行 `/cache-optimizer fix`。仅缺少 affinity 的提醒按 provider 在当前扩展实例内去重，并指向这一确认式命令；模型专属提醒仍单独显示。compat 已完整时，命令显示"无需修复"。

## `/cache-optimizer rollback`

Rollback 可通过补全、直接命令和交互菜单使用，并始终需要 UI 确认。命令会选择匹配当前 provider/model（provider 级 receipt 可从同 provider 任一模型操作）的最新未回滚 receipt，验证备份与文件 hash，创建新的保留访问权限的 rollback backup，并使用临时文件 + 原子替换。Fix 与 rollback 在多个 extension instance 间串行执行；rollback 还会把预览时的 receipt transaction id/hash 绑定到提交阶段，若另一事务替换 receipt 就安全拒绝。没有交互式 UI 时只提供手动恢复指引，不会写入文件。

如果 `models.json` 自 fix 后没有变化，rollback 可以恢复完整的 pre-fix JSONC；如果文件发生变化，则绝不会盲目替换整个文件，只会在 receipt-owned scalar key 仍等于记录的 post-fix 值时撤销该 key，并保留之后的用户修改。如果 receipt-owned key 已变化、目标被删除/移动，或 fix 新建了目标项，命令会安全拒绝并指向记录的 backup 供手动检查。成功后 receipt 会标记为已回滚，并需要 `/reload` 或重启。

### 没有 `models.json` provider entry 的渠道

有些 Pi 渠道可用时，Pi agent `models.json`（默认 `~/.pi/agent/models.json`；若设置了 `PI_CODING_AGENT_DIR`，则为 `$PI_CODING_AGENT_DIR/models.json`）里可能还没有对应 provider block。保留现有认证方式，不要复制 credential、token 或 API key。只在 `models.json` 里添加缓存 / 路由兼容覆盖。

Provider 级最小 override：

```json
{
  "providers": {
    "your-provider-id": {
      "compat": {
        "sendSessionAffinityHeaders": true
      }
    }
  }
}
```

Pi Cache Optimizer 按 Pi 的优先级解析有效 compat（`provider.compat` → 匹配的 `models[].compat` → runtime model compat → `modelOverrides[modelId].compat`）。这也覆盖了某些 extension provider 替换模型列表后，runtime model 意外丢失低层 compat 的情况。对于非官方 `openai-completions` 渠道，如果有效 `sendSessionAffinityHeaders` 为 `true`、但 Pi runtime model 丢失了该值，本扩展会在请求阶段恢复 Pi-compatible affinity headers，且不会覆盖已有 header；显式 `false` 仍作为有效 opt-out 尊重。

如果只想影响单个模型，用 `modelOverrides`：

```json
{
  "providers": {
    "your-provider-id": {
      "modelOverrides": {
        "gpt-5.5": {
          "compat": {
            "sendSessionAffinityHeaders": true
          }
        }
      }
    }
  }
}
```

## DeepSeek 协议安全与回滚

模型家族名称与 reasoning wire protocol 是两件事。使用 OpenAI-compatible endpoint 的 DeepSeek 名称模型，可能使用标准顶层 `reasoning_effort`、DeepSeek 风格 `thinking`，或其它 provider-specific format。单独的 `supportsReasoningEffort: true` 不能证明协议。为此，`/cache-optimizer fix` 永远不会凭模型名推断或添加 `thinkingFormat: "deepseek"`；只有 endpoint 文档或 provider 的明确证据支持时，才应配置显式 format。

面向新手的安全流程是分阶段的：

1. 先运行 `/cache-optimizer fix`，只处理协议无关的缓存 / 路由修复，例如 session affinity；命令会展示具体位置并要求确认。
2. 发起一次普通请求。如果 OpenAI-compatible 的 DeepSeek-like 模型明确拒绝 `thinking` 并要求使用 `reasoning_effort`，扩展只在当前进程保留 model-scoped 分类，不会持久化或显示完整错误，不会发送隐藏探测请求，也不会在 response hook 中自动修改配置。
3. 再次运行 `/cache-optimizer fix`，查看基于证据的 model-level 协议修复；该修复写入最高优先级的 `modelOverrides[modelId].compat`，并结合 runtime compat 自检，避免 extension-provided model 静默遮挡。不会仅凭共享 provider 或模型名字扩大修改范围，显式 `openai`、`qwen`、`openrouter`、`together` format 会被尊重。
4. 如果最近一次已确认修复导致问题，运行 `/cache-optimizer rollback`；回滚始终需要 UI 确认。

每次成功的交互式 fix 都会以原子方式写入版本化 receipt：`pi-cache-optimizer-fix-receipt.json`。它只包含 transaction id、provider/model identity、placement、发生变化的 scalar compat key 及 before/after 值、文件 hash、备份文件名和时间戳/status。不会保存 API key、credential、prompt、payload、header、response body 或原始错误。

Rollback 会创建新的、保留访问权限的备份并使用原子替换。如果 `models.json` 自 fix 后未变化，且 receipt 备份匹配 pre-fix hash，则可恢复完整 pre-fix 文件。如果文件发生变化，只会在 receipt-owned scalar key 仍等于记录的 post-fix 值时撤销该 key，并保留其它用户修改；否则安全拒绝并指向记录的备份供手动检查。验证后 receipt 会标记为已回滚，需要 `/reload` 或重启 Pi。

## Footer 统计

统计是只读本地计数，保存在 Pi agent 目录的 UUID shard（`pi-cache-optimizer-stats.d/shards/`；自定义 agent 目录使用 `PI_CODING_AGENT_DIR`）。Shard 只包含日期、opaque session hash、精确 provider/model 计数、reset epoch 和进程生命周期元数据，不包含 API key、prompt、payload、headers、响应或模型输出。Footer 默认显示当前 conversation session；`total` 聚合同一精确 provider/model 的所有有效本地 shard，`process` 只显示当前 extension instance。旧 v6 共享统计文件升级时直接删除，不迁移旧计数。

Pi 0.79+ 已内置 footer `CH` 标记，用于显示最近一次 prompt cache hit rate。本扩展在此基础上补充持久化的 provider/model 计数，以及代理 compat 诊断。

示例 footer：

```text
· OpenAI cache 3/10·0.002M/0.005M 40.0% ⚠️ compat
```

开头的 `· ` 由本扩展负责，用于把本扩展状态与同一 footer 中其他扩展发布的状态隔开。普通、disabled、router 恢复以及带 warning 的状态都会保留此前缀。紧凑 footer 格式为 `<label> <命中请求数>/<总请求数>·<cached input tokens>/<total input tokens> <token 命中率>`；token 命中率保留一位小数，并去掉多余的 `tok` 后缀。`/cache-optimizer stats` 显示当前 session 的各模型详细统计；`/cache-optimizer stats all` 显示所有本地模型，并包含 `4/5·0.66M/0.84M 78.7%` 这样的紧凑摘要。部分 adapter 还可能追加 `·write <tokens>`，运行时诊断可能追加 `⚠️ compat` 或 `⚠️ integrity`。

支持的 footer label 包括：DS、Claude、OpenAI、Gemini、Kimi、Qwen、GLM、MiniMax、Mimo、Hunyuan、Mistral、Grok、Llama、Nemotron、Cohere、Yi、Doubao、ERNIE、Baichuan、StepFun、Spark、InternLM、Gemma、Phi、Jamba、Solar、Sonar、Nova、Reka、Falcon、DBRX、MPT、StableLM、Aquila、EXAONE、HyperCLOVA、Luminous、Hermes、Granite、Arctic、Pangu、SenseNova、Zhinao、MiniCPM、XVERSE、Orion、OpenChat、Vicuna、Wizard、Zephyr、Dolphin、OpenOrca、Starling、BLOOM、RWKV、Aya。

Adapter 选择只看模型 id/name（以及 message_end 时 assistant message 的 model/name）。仅使用 OpenAI-shaped API 不会被当作 OpenAI-family，除非模型 id/name 匹配受支持的家族。

## 原生虚拟模型（Pi 0.99+）

Pi 0.99 允许扩展通过 `pi.registerVirtualModel()` 注册虚拟模型。选中虚拟模型时，`ctx.model` 保持为虚拟模型（`api: "pi-virtual"`），而 Pi 会把每次请求路由到某个物理模型。本扩展会自动跟随该物理模型，router 作者无需接入下文的协议。

- 请求 hook 从 provider payload 中读取实际派发的模型 id，并在已配置凭证的物理模型中匹配。`prompt_cache_key` fallback、`prompt_cache_retention` 安全规则、Anthropic TTL 修复以及按模型关闭 `prompt_cache_key` 的规则都按该物理模型生效。如果多个已配置凭证的 provider 共用同一个 id 且处理方式不同，扩展不会猜测，而是跳过依赖模型身份的请求修改。
- Footer 统计以及 `/cache-optimizer doctor`、`compat`、`stats`、`reset`、`fix` 使用当前会话分支上最近一次应答的物理模型，与 Pi 自身显示的路由模型和 context 上限一致。doctor 与 compat 会同时标出虚拟选择和该物理模型。
- 在 Pi 路由第一个请求之前，footer 保持为空，诊断会提示先发送一个 prompt。
- 虚拟选择默认不做 prompt 改写：Pi 在构建 system prompt 之后才决定物理模型，重排后的 prompt 不应被送到有安全过滤的 Codex 路由。只有设置 `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` 且 routing registry 暴露完整候选链、所有候选都是已知的非 Responses / 非 Codex transport 时，才允许改写；路由未知或信息不完整时仍保持原 prompt。
- Session-affinity header 桥接同样跳过，因为 Pi 在 payload 生成之前就构造请求 header。Pi 仍会发送物理模型自身配置的 affinity header。

## Router / Virtual-channel 扩展作者指南

如果你的 Pi 扩展提供虚拟 routing provider（例如 [`pi-router`](https://github.com/jiangge/pi-router) 的 `router/auto`、`router/smart`，或会转发到真实上游的 profile/channel），本扩展可以为真实上游 provider/model 显示缓存统计，而不是把统计记到虚拟外壳上。集成是可选、版本化的，并且**不需要导入本包**。

对于 [`pi-router`](https://github.com/jiangge/pi-router)，请使用实现 `pi.routing.registry.v1` 的较新版本。直接选择 `router/*` 模型时仍使用普通 prompt optimizer；当 Pi 0.99+ 原生 virtual model 通过支持该 registry 的 router 路由时，可选的 `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` 会先检查 router candidate chain 再决定是否改写。候选包含 OpenAI Responses/Codex API、元数据不完整或路由信息不可用时，会 fail closed。

### 最小集成：最终 assistant message metadata

要无缝获得最终缓存统计归因，请在完成的 assistant message 上透传真实上游身份：

```ts
{
  role: "assistant",
  provider: "anthropic",              // 真实上游 provider
  responseModel: "claude-opus-4-8",   // 或 model: "..."
  api: "anthropic-messages",          // 已知时填写上游 Pi API id
  usage: {
    input: 1200,       // Pi-normalized 未缓存 input tokens，如可用
    cacheRead: 8000,   // 从 provider prompt cache 读取的 tokens
    cacheWrite: 500,   // 本次新写入 provider prompt cache 的 tokens
  },
}
```

`message_end` 会把这些 assistant-message 字段视为权威来源。只要存在 `provider` + `model`/`responseModel` + cache usage，即使 active model 仍是 `router/auto`，统计也会更新真实上游桶。如果上游 usage 没有 cache 字段，请保持缺失或为 0；本扩展不会伪造 cache hit。

### 可选：用于预响应 UX 的实时路由注册表

最终 message metadata 足以支持响应后的统计。若要支持响应前流程——首次响应前的 footer 显示、`/cache-optimizer doctor`、`/cache-optimizer compat`、`/cache-optimizer reset` 和 OpenAI-compatible `prompt_cache_key` fallback——请在 `Symbol.for("pi.routing.registry.v1")` 下注册 live route adapter。

协议形状：

```ts
type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute(
    virtualModelId: string,
    hint?: { sessionIdHash?: string; requestId?: string },
  ): PiRouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): PiRouteSnapshot[];
  subscribe?(listener: (event: PiRouteSnapshot) => void): () => void;
};
```

注册模式：

```ts
const ROUTING = Symbol.for("pi.routing.registry.v1");
const registry = (globalThis as Record<symbol, unknown>)[ROUTING] as
  | { version: 1; registerRouter(adapter: PiRouterAdapterV1): () => void }
  | undefined;

registry?.registerRouter({
  virtualProvider: "router",
  resolveActiveRoute(virtualModelId, hint) {
    return {
      virtualProvider: "router",
      virtualModelId,
      provider: "deepseek",
      modelId: "deepseek-v4",
      api: "openai-completions",
      sessionIdHash: hint?.sessionIdHash,
      timestamp: Date.now(),
    };
  },
});
```

不要覆盖已有 registry。如果你的扩展比本优化器更早加载，请在 `session_start` 时重试注册，或仅在 registry 不存在时创建同样的 V1 registry 形状。

### 可选：按查询过滤的缓存提示

会转发到内部 Pi 请求路径的 router，可以从 `Symbol.for("pi.cache.hints.v1")` 读取按查询过滤的提示：

```ts
const CACHE_HINTS = Symbol.for("pi.cache.hints.v1");
const hints = (globalThis as Record<symbol, any>)[CACHE_HINTS]?.getHints?.({
  sessionIdHash,
  virtualProvider: "router",
  virtualModelId: "auto",
  upstreamProvider: "deepseek",
  upstreamModelId: "deepseek-v4",
  api: "openai-completions",
});
```

当查询匹配当前 session/route 时，`hints` 可能包含 `systemPrompt`、`promptCacheKey` 和 `cacheRetention: "long"`。这些提示是参考信息且可能敏感：不要记录日志，不要暴露 prompt 文本，也不要覆盖已有 request-level `prompt_cache_key` / `promptCacheKey`。

### 安全与正确性规则

- 不要导入 `pi-cache-optimizer`；只使用 `Symbol.for(...)` 发现协议。
- 不要在 route snapshot 或日志中暴露 API key、prompt、payload、headers、response body 或模型输出。
- 最终归因使用 assistant-message metadata；live registry 只是参考信息，到响应完成时可能已经过期。
- 保持 usage 真实。缺失 cache usage 时应该显示 0 或低报，而不是合成命中。

## 卸载

```bash
pi remove npm:pi-cache-optimizer
```

然后运行 `/reload` 或重启 Pi。可选：删除本地状态文件（如果使用 `PI_CODING_AGENT_DIR`，请删除该目录中的同名文件）：

| 平台 | 删除本地状态文件 |
|---|---|
| Linux / macOS / WSL | `rm -rf ~/.pi/agent/pi-cache-optimizer-stats.d ~/.pi/agent/pi-cache-optimizer-stats.json ~/.pi/agent/deepseek-cache-optimizer-stats.json ~/.pi/agent/pi-cache-optimizer-config.json` |
| Windows PowerShell | `Remove-Item -Recurse -Force "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-stats.d", "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-stats.json", "$env:USERPROFILE\.pi\agent\deepseek-cache-optimizer-stats.json", "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-config.json" -ErrorAction SilentlyContinue` |
| Windows 命令提示符 | `rmdir /s /q "%USERPROFILE%\.pi\agent\pi-cache-optimizer-stats.d" & del /f /q "%USERPROFILE%\.pi\agent\pi-cache-optimizer-stats.json" "%USERPROFILE%\.pi\agent\deepseek-cache-optimizer-stats.json" "%USERPROFILE%\.pi\agent\pi-cache-optimizer-config.json" 2>nul` |

清理时不要删除 `models.json`；它保存你的 Pi 模型 / provider 配置，不属于本包。

## 验证效果

1. 选择一个 provider 会暴露 cache usage 的模型。
2. 在同一个 Pi session 中连续发送几轮相似请求。
3. 观察 footer，或运行 `/cache-optimizer stats`。
4. 对第三方代理，再运行 `/cache-optimizer doctor`，并在代理侧确认 sticky routing / session affinity。

## License

MIT
