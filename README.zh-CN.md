# Pi Cache Optimizer

[![npm version](https://img.shields.io/npm/v/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dm/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![license](https://img.shields.io/npm/l/pi-cache-optimizer.svg)](./LICENSE)

[English README](./README.md)

> **已从 `pi-deepseek-cache-optimizer` 重命名。** 如果你之前安装的是旧名称，请迁移：
>
> ```bash
> pi remove npm:pi-deepseek-cache-optimizer && pi install npm:pi-cache-optimizer
> ```
>
> 持久化的底部计数器以及已有的 `~/.pi/agent/models.json` 都会被保留。

开箱即用的 Pi 扩展，用稳定 prompt 前缀提升 provider-side KV Cache / Prompt Cache 命中概率，并以保守的 provider-specific adapter 显示底部缓存统计。包名里虽带 DeepSeek，但从 1.x 开始实际上已同时支持 DeepSeek、OpenAI、Claude、Gemini 的统计 adapter；新名称反映这个事实。

> 重要：prompt/KV 缓存是 provider 侧、best-effort 行为。本扩展只能通过稳定前缀、在 Pi 支持时请求长保留、提醒明显 compat 缺口、以及展示 provider 暴露的轻量统计来提高命中概率，不能保证每次命中。第三方代理可能隐藏、丢失、重路由或重新解释缓存行为。

## 做了什么

| 功能 | 方式 | 是否需要手动操作 |
|------|------|:---:|
| 🔄 重组 system prompt | `before_agent_start` 钩子 — 稳定前缀在前、动态上下文在后 | ❌ 自动 |
| 🗜️ 压缩 Skills XML | 将 pi 的每 skill 四行 XML 替换为按 skills-root 分组的紧凑单行索引（大小缩减约 93%） | ❌ 自动 |
| 🧹 剥离 session-overview 动态尾字段 | 从 `<session-overview>` 中移除 `RECENT COMMITS`、`Working directory`、`Line count`——这些字段每轮都在变，破坏前缀缓存 | ❌ 自动 |
| 🛡️ 完整性 guard | 检测 prompt 重排是否意外截断了 trellis 结构标记；如发生则回退到原始 prompt 并在 footer 显示 `⚠️ integrity` | ❌ 自动 |
| ⏳ 长缓存保留 | 扩展加载时设置 `PI_CACHE_RETENTION=long`；Pi/provider compat 决定实际发送内容 | ❌ 自动 |
| 🔗 保守 compat 提醒 | DeepSeek session-affinity 提醒，以及 Claude 兼容 endpoint 的明显 cache-control 提醒 | ⚠️ 见下 |
| 📊 Provider-specific 底部统计 | 在 Pi footer/status 中显示受支持 provider family 的只读缓存统计 | ❌ 自动 |

## 支持的统计 adapter

本版本保留原有 DeepSeek 行为，并增加针对 Pi 或 provider 能安全暴露 usage 的只读统计 adapter。Adapter 选择刻意只使用 model id/name（以及 `message_end` 中 assistant message 的 `model`/`name`）；不会用 provider id、API type、base URL、`thinkingFormat` 或 compat flags 来选择统计 adapter。

| Adapter | 检测方式 | 底部标签 | usage 字段 |
|---|---|---|---|
| DeepSeek | model id/name 包含 `deepseek` | `DS cache` | Pi `usage.cacheRead`/`usage.input`，或可见 raw 字段 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`prompt_tokens` |
| OpenAI-family | model id/name 包含保守 OpenAI-family token，例如 `gpt-`、`chatgpt`、`o1`、`o3`、`o4` 或 `o5` | `OpenAI cache` | Pi 归一化 usage，或可见 raw 字段 `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` 及 prompt/input total |
| Kimi / Moonshot | model id/name 包含 `kimi` | `Kimi cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| Qwen / Alibaba | model id/name 包含 `qwen` | `Qwen cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| GLM / Zhipu | model id/name 包含 `glm` | `GLM cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| MiniMax | model id/name 包含 `minimax` | `MiniMax cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| Hunyuan / Tencent | model id/name 包含 `hunyuan` | `Hunyuan cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| Mistral | model id/name 包含 `mistral`、`mixtral` 或 `codestral` | `Mistral cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| xAI / Grok | model id/name 包含 `grok`，或安全边界内 `xai` 模式 | `Grok cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| Meta / Llama | model id/name 包含 `llama` | `Llama cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| NVIDIA Nemotron | model id/name 包含 `nemotron` | `Nemotron cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| Cohere / Command | model id/name 包含 `cohere` 或 `command-r` | `Cohere cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| Yi / 零一万物 | model id/name 包含 `yi-`、`01-ai`、`zero-one`，或安全边界内 `yi` 模式 | `Yi cache` | Pi 归一化 usage，或可见 OpenAI 形状字段 |
| Anthropic / Claude | model id/name 包含 `anthropic` 或 `claude` | `Claude cache` | Pi 归一化 usage，或可见 raw 字段 `cache_read_input_tokens`、`cache_creation_input_tokens`、`input_tokens` |
| Gemini / Vertex | model id/name 包含 `gemini` 或 `vertex` | `Gemini cache` | Pi 归一化 usage，或可见 Gemini/Vertex cached-content token metadata |

Generic OpenAI-compatible 代理**不会**仅因为使用 OpenAI 形状 API 或 provider id 就被当作 OpenAI-family。如果当前 model id/name 语义不明确，扩展会隐藏底部统计，而不是猜测。

## 平台支持

本扩展是纯 Node.js 实现 —— 不调用 shell、没有原生绑定、不写死平台相关路径 —— 因此与 Pi 自身保持一致，支持以下系统：

| 操作系统 | 说明 |
|---|---|
| Linux | 原生支持。 |
| macOS | 原生支持。 |
| Windows | 通过 Pi 在 Windows 下要求的 bash shell 运行（Git Bash、Cygwin、MSYS2 或 WSL）。详见 Pi 的 [Windows setup](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/windows.md)。 |
| Termux / Android | 在 Pi 的 Termux 环境中可用。 |

状态文件 `~/.pi/agent/` 通过 Node 的 `os.homedir()` 解析，所以在 Windows 上会自动展开为 `C:\Users\<你>\.pi\agent\...`。本文档中所有 shell 命令均使用 bash 语法，与 Pi 在每个受支持平台下运行的 shell 一致；只要在 Pi 内（或为 Pi 而执行）运行，就**不需要**改写为 PowerShell 或 `cmd.exe` 形式。

## 快速开始

1. （可选但推荐）先读一遍官方 Pi + DeepSeek 接入指南：[`pi_mono.zh-CN.md`](https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/pi_mono.zh-CN.md)。它讲了 Pi 安装与基础配置。
2. 安装本扩展：

   ```bash
   pi install npm:pi-cache-optimizer
   ```

3. 如果使用 DeepSeek 模型，请在运行 `pi` 的同一个 shell 中导出 DeepSeek API key：

   ```bash
   export DEEPSEEK_API_KEY='...'
   ```

   本扩展**不会**读取、存储或打印 key 的值。

## 安装

```bash
pi install npm:pi-cache-optimizer
```

安装后 `PI_CACHE_RETENTION=long` **自动生效**，system prompt **自动重组**、skills 自动压缩、session-overview 动态尾字段自动剥离；受支持 model family 的响应完成且暴露 usage 后，底部状态栏会显示缓存统计。

## 退出（Opt-out）

| 环境变量 | 作用 |
|---------|------|
| `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` | 跳过所有 `before_agent_start` prompt 修改（session-overview 字段剥离、skills 压缩、稳定前缀重排）；底部统计和 `prompt_cache_key` 兜底仍然生效 |
| `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` | 保留 pi 的 verbose `<available_skills>` XML（退出一行索引模式） |
| `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` | 禁用 OpenAI-family `prompt_cache_key` 兜底（默认启用） |
| `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | 禁用 OpenAI-family `prompt_cache_key` 兜底 |

## 卸载

请移除当初安装时使用的同一个 package source。npm 包对应命令：

```bash
pi remove npm:pi-cache-optimizer
```

如果你是从本地路径安装的，请移除同一个路径/source，例如：

```bash
pi remove /absolute/path/to/pi-deepseek-cache-optimizer
# 或者，如果安装时使用的就是这个相对路径：
pi remove ./relative/path/to/pi-deepseek-cache-optimizer
```

如果当初使用 `pi install -l ...` 安装到项目级 settings，请使用对应的项目级卸载命令，例如 `pi remove -l npm:pi-cache-optimizer`。

移除 package 后，在 Pi 中执行 `/reload` 或重启 Pi，让扩展卸载。底部统计计数器会单独持久化；如果也想删除这个本地状态文件，可以执行：

```bash
rm ~/.pi/agent/pi-cache-optimizer-stats.json
# 旧名称（首次运行新版本时会被迁移、可能已被删除；仍在的话可安全删除）：
rm -f ~/.pi/agent/deepseek-cache-optimizer-stats.json
```



## 添加 OpenAI-compatible 代理渠道

当在 `~/.pi/agent/models.json` 中添加第三方 OpenAI-compatible 代理 provider（例如 `otokapi`、`cafecode`、OpenRouter 等）时，缓存优化的 `compat` 标志对模型正常使用不是必需的，但它们能显著提高缓存持久性。

### 最小 provider 配置模板

```jsonc
{
  "providers": {
    "your-provider-id": {
      "api": "openai-completions",  // 或 "openai-responses"
      "baseUrl": "https://your-proxy.example.com/v1",
      "apiKey": "your-api-key",
      "models": {
        "gpt-5.5": {
          "id": "gpt-5.5",
          "name": "GPT 5.5",
          "contextWindowTokens": 128000,
          "maxOutputTokens": 8192,
          "thinking": {
            // 使用你的代理实际支持的 thinking 级别。
            // Pi 通过 thinkingLevelMap 将 --thinking <level> 映射为 token。
            // 下面模板保持各级别独立 —— 不要全部映射为 "xhigh"。
            // 你的代理可能不支持所有级别；移除不支持的或逐个测试。
            "thinkingLevelMap": {
              "off": null,
              "minimal": "minimal",
              "low": "low",
              "medium": "medium",
              "high": "high",
              "xhigh": "xhigh"
            }
          },
          "compat": {
            "supportsLongCacheRetention": true,
            "sendSessionAffinityHeaders": true
          }
        }
      }
    }
  }
}
```

关键点：

- `thinkingLevelMap` 保持不同的 level 独立。如果你的代理不支持某个级别（例如 `minimal`），请移除该条目或设为 `null`。**不要**将所有级别都映射为 `"xhigh"` —— 那会破坏用户对推理努力度的控制。
- `compat` 标志帮助 Pi 请求更长的缓存保留时间，并通过发送 session-affinity headers 实现代理侧缓存本地性。仅在代理支持时才启用。
- 扩展通过模型 `id`/`name` 字符串来检测模型家族，而不是通过 provider id、base URL 或 API 类型。请使用易识别的模型 id（例如 `gpt-5.5`、`kimi-k2.5`），以便正确匹配统计 adapter。

## 底部缓存统计

Pi footer 只显示**当前活跃模型 family** 的统计，例如：

```text
DS cache 3/5 · 0.77M/0.80M tok (96%)
OpenAI cache 2/4 · 0.25M/0.70M tok (36%)
Claude cache 1/3 · 0.10M/0.45M tok (22%) · write 0.20M tok
Gemini cache 1/2 · 0.18M/0.50M tok (36%)
```

含义：

- `3/5`：该 provider family 的 5 次受支持 assistant 响应中，有 3 次出现 cache-read tokens。
- `0.77M/0.80M tok`：累计 cache-read input tokens / 累计 prompt input tokens，单位固定显示为百万（M）。
- 百分比：`cacheRead / total prompt input`。
- `write ... tok` 只会在 Claude cache-write tokens 非零时出现，因为 Anthropic cache write 有独立成本/统计语义。

统计规则：

- 计数器按 provider family 分开保存。DeepSeek、OpenAI、Claude、Gemini 不会合并成一个全局 hit rate。
- 底部只显示当前活跃模型 family 的标签和计数器；不支持或语义不明确的模型会隐藏/清空状态。
- 只统计 Pi/provider 暴露 usage 的 assistant 响应；没有 usage 时不更新计数器。
- Adapter 匹配只使用当前 model id/name 加 assistant message 的 `model`/`name`；选择 adapter 时会忽略宽泛 provider/API/compat metadata。
- 优先使用 Pi 归一化后的 `usage.input`、`usage.cacheRead`、`usage.cacheWrite`。只有当 assistant message 上可见已知 provider raw 字段时，才做保守 fallback 解析。
- Pi 归一化 usage 的 prompt input 总量使用 `input + cacheRead + cacheWrite`。provider raw normalizer 会优先使用各 provider 文档里的 total/input 字段。
- 统计只更新底部状态栏，不创建额外 TUI 组件，也不写诊断文件；因此不会因调试组件频繁重绘导致屏幕闪烁。
- 统计会持久化到本地小 JSON 文件：`~/.pi/agent/pi-cache-optimizer-stats.json`。早期 1.x 版本使用 `~/.pi/agent/deepseek-cache-optimizer-stats.json`；首次运行新版时会从旧路径读一次、复制到新路径、然后 best-effort 删除旧文件。该文件只保存计数器和本地日期，不保存 API key、prompt、消息内容、headers 或模型输出。
- DeepSeek-only 旧版本的 v1 状态文件会自动迁移到 DeepSeek adapter 计数器。

重置规则：

- Pi 重启**不会**清零统计；扩展会恢复已持久化的计数器。
- `/reload` / extension reload 会清零并覆盖持久化计数器，因为 Pi 会暴露 `session_start` 的 `reason: "reload"`。
- 长时间运行跨过本地自然日时，会在下一次状态更新或受支持 provider 响应统计前自动按本地日期清零。

## 建议的 compat 配置

对直连 DeepSeek 或 DeepSeek-like OpenAI-compatible 代理，建议在对应 provider 或 model 的 `compat` 中配置。

`compat` 块应该放在 `~/.pi/agent/models.json` 中 provider 对象内部，与 `baseUrl`、`api`、`apiKey`、`models` 同级：

```jsonc
{
  "providers": {
    "deepseek": {
      "api": "openai-completions",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "models": { /* ... */ },
      // 👇 compat 在此位置，而不是在 models 内部
      "compat": {
        "thinkingFormat": "deepseek",
        "supportsLongCacheRetention": true,
        "sendSessionAffinityHeaders": true
      }
    }
  }
}
```

如果你的 provider id 不是 `deepseek`（例如公司代理、OpenRouter 风格代理），也可以把同样字段放在该 provider 或具体 DeepSeek 模型的 `compat` 里。扩展识别 DeepSeek-like 模型的依据仍然是 model id / model name 是否包含 `deepseek`；不会根据 provider id、baseUrl 或 `thinkingFormat` 判断。当前推荐的 DeepSeek 验证路径只覆盖官方直连 `deepseek/deepseek-v4-pro`。

扩展会对每个 provider/model **每个会话最多提醒一次**。对于 DeepSeek-like OpenAI-compatible 模型，会在缺少以下配置时提醒：

- `supportsLongCacheRetention: true`：Pi 可能不会发送 `prompt_cache_retention: "24h"`。
- `sendSessionAffinityHeaders: true`（OpenAI Completions 兼容 API）或 `sendSessionIdHeader: true`（OpenAI Responses 兼容 API）：Pi 可能不会发送 session affinity headers（如 `session_id`、`x-client-request-id`、`x-session-affinity`），代理/负载均衡场景下缓存命中可能更差。

对于通过 OpenAI-compatible endpoint 暴露的 Claude/Anthropic 模型，如果模型明显 Claude-like 但缺少 `cacheControlFormat: "anthropic"`，扩展可能提醒。只有在 endpoint 支持 Anthropic-style cache-control markers 时才应启用该 compat flag。

> 提醒：只有在 endpoint 或代理明确支持时，才建议启用 session-affinity headers 或 cache-control compat。

## 诊断命令

扩展注册了 Pi 命令 `/cache-optimizer` 用于交互式诊断。

```
/cache-optimizer              — 显示帮助 + 当前模型 compat 状态
/cache-optimizer doctor        — 显示 provider、model、API、base URL、compat 状态
/cache-optimizer compat        — 显示 compat 建议和编辑说明
```

### `/cache-optimizer doctor`

显示当前模型的 provider、model id、名称、API 类型、base URL、当前 `compat` 标志以及缺少的缓存/session-affinity 标志。如果缺少标志，还会显示可复制的 JSON 片段和精确编辑位置：

```text
Provider: otokapi
Model:    gpt-5.5
API:      openai-completions
Base URL: https://otokapi.example.com/v1
Compat:   {}
⚠️  Missing compat flags: supportsLongCacheRetention, sendSessionAffinityHeaders
Edit ~/.pi/agent/models.json -> providers["otokapi"] -> compat (same level as baseUrl/api/apiKey/models):
{
  "supportsLongCacheRetention": true,
  "sendSessionAffinityHeaders": true
}
```

### `/cache-optimizer compat`

仅显示 compat 建议，包括文件路径和 provider 路径。

### 安全说明

命令只读取 Pi 通过 `ctx.model` 暴露的元数据：provider、id、name、api、baseUrl、compat。它**不会**读取或暴露：
- API key 或环境密钥
- 请求/响应 payload
- Prompt 或模型输出
- HTTP headers
- `~/.pi/agent/models.json` 的原始内容

## 原理

Provider 缓存通常依赖精确或近似精确的前缀匹配。Pi 的 system prompt 包含跨会话稳定的内容（工具定义、技能、规范），也包含每次变化的动态内容（git status、当前任务）。

```text
优化前: [动态 git status | 任务上下文 | 稳定工具+规范]
         ↓ 每次前缀不同 → 缓存复用降低

优化后: [稳定工具+规范 | 动态 git status | 任务上下文]
         ↓ 稳定前缀不变 → 更容易命中缓存
```

Pi 本身还会根据模型 compat 和 `PI_CACHE_RETENTION` 决定是否发送缓存相关字段，例如 `prompt_cache_retention`、session affinity headers 或 Anthropic-style `cache_control`。本扩展现在默认只做一个保守的 request-body 兜底：对所有使用 OpenAI-compatible Pi API（`openai-completions` / `openai-responses`）的模型，当顶层 `prompt_cache_key` 缺失或为空时，用 Pi session id 补上，并且不会覆盖已有的非空 key。这覆盖 GPT 命名模型、Kimi/Moonshot、Qwen/Alibaba、GLM/Zhipu、MiniMax、Hunyuan 等任何使用 OpenAI 形状 API 的 provider——只有 `kiro-api` 等 custom transport 不被注入。本扩展不伪造缓存命中，只帮助配置、提高稳定前缀概率，并把已暴露的 usage 汇总到底部状态栏。

## 提高 cache 命中率

代码里的命中率优化会保持保守和 provider-neutral：把最大的稳定 prompt 前缀放在最前面，让 Pi/provider compat 发送其支持的缓存控制字段，避免把不受支持的 request 字段泄漏给代理。

扩展会自动做这些事：

- 把稳定 prompt 内容移动到动态 task/git/session 上下文之前。除了 tools、skills、custom prompt、append prompt 和 guideline bullets，也会把已知稳定的项目/规范文件（例如 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`CURSOR.md`、`.trellis/spec/...`）保留在更靠前的 cacheable prefix 中。任意大型 context file 不会只因为体积大就被提前，因为它们可能是 task/session-specific 内容。
- 设置 `PI_CACHE_RETENTION=long`，让 Pi 在当前模型/provider compat 支持时请求更长缓存保留。
- 按 provider family 分开 footer 计数，方便你验证当前活跃模型 family 是否真的报告 cache reads。

各 provider 注意点：

- DeepSeek：现有行为仍是参考路径。稳定前缀排序，加上 long-retention / session-affinity compat，最有利于自动 KV prefix 复用。
- OpenAI-family：prompt caching 只会在真实上游支持且 prompt 足够长时自动生效。请尽量把静态 instructions、tools、examples、specs 放在变化的 user/task context 前面。retention 传输默认由 Pi 负责。对 OpenAI-compatible Pi API，本扩展会用 Pi session id 补齐缺失或空白的顶层 `prompt_cache_key`（与 Pi core 官方 OpenAI 行为对齐），并且不会覆盖已有非空的 `prompt_cache_key` / `promptCacheKey`。该兜底现在适用于所有使用 `openai-completions` / `openai-responses` 的模型（不限于 GPT 命名），因此 Kimi、Qwen、GLM、MiniMax、Hunyuan 等 OpenAI-compatible 模型也同样受益。可用 `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` 或 `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` 禁用该兜底。不支持该字段的 OpenAI-compatible 代理可能拒绝请求；custom API 不会被注入。
- Claude：prompt caching 依赖 Anthropic `cache_control` breakpoints。本扩展不会自行注入 breakpoint；对兼容 endpoint，只在 endpoint 明确支持时配置 Pi compat，例如 `cacheControlFormat: "anthropic"`。
- Gemini/Vertex：implicit caching 受益于重复的大型稳定前缀。本扩展不会创建 explicit `cachedContents` resources，也不会保存 cache resource names。
- Proxies/aggregators：尽量固定上游 routing/provider order。如果同一个 model id/name 可能路由到不同上游，cache hit rate 会不稳定。

## Provider-specific 限制

本包现在有 provider-family stats adapter，但仍避免盲目泛化：

- DeepSeek cache 是自动的 prefix/KV cache。命中是 best-effort，代理可能隐藏 DeepSeek usage 字段。DeepSeek 的 Anthropic API 兼容层**明确忽略 `cache_control` markers**（对所有 content 类型均忽略）——像 Claude Code 那样用显式缓存断点对 DeepSeek 无效。
- **Kiro / kiro-api**：`pi-provider-kiro` 扩展使用 AWS CodeWhisperer / Q Developer 流式协议（不是 Anthropic Messages / OpenAI Chat Completions / Bedrock Converse）。该协议没有 `cache_control` marker 的注入位置，也不返回 `cache_read_input_tokens`。对 Kiro Claude 模型，底部会显示 **0%**——这是 `pi-provider-kiro` 的限制，不是本扩展的 bug。不要强行用特殊逻辑 bump 这些数字。
- OpenAI-family prompt caching 只有在真实上游支持且 prompt 足够长时才会自动生效。adapter 基于模型名称且刻意保守；不会用 provider/API/base URL metadata 推断官方 OpenAI 支持。
- Claude prompt caching 依赖显式 Anthropic cache-control breakpoints。本版本只报告 Pi/provider 暴露的统计；不会插入 breakpoint，也不会修改请求体。
- Gemini/Vertex 可能暴露 implicit cached-content token count。本版本不会创建、保存、更新或删除 explicit Gemini cached-content resources。
- Proxies/aggregators 可能把同一个 model name 路由到不同上游 provider。由于检测是 id/name-only，请使用无歧义 model name、固定上游 routing，并验证 exposed usage 后再判断缓存行为。

## 本版本不包含

- 广泛/provider-agnostic 修改请求体，或做 cache-control 注入。唯一默认 request-body 兜底是 OpenAI-family 在 OpenAI-compatible API 上使用 Pi session id 的 `prompt_cache_key`，且已有有效 key 时会跳过。
- 注入 Anthropic `cache_control` markers。
- 向 custom / 非 OpenAI-compatible API 发送 OpenAI `prompt_cache_key`；该兜底只要求 API 是 `openai-completions` / `openai-responses`（`kiro-api` 等 custom transport 不被注入，但模型命名不再要求属于 GPT-family）。
- 在 Pi 自己的 compat 处理之外覆盖 OpenAI `prompt_cache_retention`。
- 创建 Gemini explicit `cachedContents` resources 或持久化 cache resource names。
- 对不暴露可靠 cache usage 的 provider 声称统计支持。

## 验证效果

### 在 Pi 中查看

- 查看当前活跃 family 的底部标签，例如 `DS cache ...`、`OpenAI cache ...`、`Claude cache ...` 或 `Gemini cache ...`。
- 使用 Pi 内置 `/stats` 查看 Pi 归一化后的 `cacheRead` tokens 是否增长。
- 对 DeepSeek，Pi 会把 `usage.input` 归一化为未缓存/miss prompt tokens，把 `usage.cacheRead` 归一化为 `prompt_cache_hit_tokens`，所以 footer 分母使用 `input + cacheRead + cacheWrite` 还原（provider 正常报告 usage 时应对应 DeepSeek `prompt_tokens`）。
- footer 的 hit count 是请求级：每个 assistant response 计入一次总请求，`cacheRead > 0` 计为命中。DeepSeek 后台可能使用不同时间窗口或账号级/provider 侧聚合；对比前请先对齐 reset/window。
- 对 provider raw API，可对比文档中的 usage 字段，例如 DeepSeek `prompt_cache_hit_tokens`、OpenAI `cached_tokens`、Anthropic `cache_read_input_tokens` 或 Gemini/Vertex cached-content token count。

### 官方 DeepSeek baseline（推荐）

请使用官方直连 `deepseek/deepseek-v4-pro` 做 DeepSeek 基线；暂不建议把代理路径混进同一次验证。请不要把 API key 粘贴到聊天记录或 issue 中。

1. 配置官方 key（任选一种方式）：

   ```bash
   export DEEPSEEK_API_KEY='...'
   ```

   或使用 Pi 的登录/配置方式保存 key。

2. 确认模型可见：

   ```bash
   pi --list-models deepseek-v4-pro
   ```

   应能看到 `deepseek/deepseek-v4-pro`。

3. 运行最小请求：

   ```bash
   pi --model deepseek/deepseek-v4-pro --thinking high
   ```

   在 Pi 中连续输入几次相同或高度相似的短 prompt，例如：

   ```text
   请用一句话回答：cache baseline ping
   ```

4. 对同一或高度相似请求连续运行至少三次，再用底部 `DS cache ...` 和 `/stats` 对比 `cacheRead` / hit rate 是否增长。

DeepSeek 的缓存前缀以服务端 prefix/cache unit 为粒度。第一次重复但在后缀处发生分歧的请求，可能是在构建公共前缀缓存；第三次以及之后与该公共前缀匹配的请求通常更有参考意义。官方文档提到缓存清理可能是数小时到数天的 best-effort 行为，但这不是“命中保证”；短时间内 miss 也不一定代表 TTL 已经失效，可能只是前缀粒度、路由、请求差异或缓存尚未建立。

> 注意：baseline 会消耗少量 token；请使用短 prompt，不要粘贴大文件。当前推荐测试命令只使用官方 `deepseek/deepseek-v4-pro`。

## 许可证

本项目基于 [MIT License](./LICENSE) 开源发布。
