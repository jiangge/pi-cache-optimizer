# Pi DeepSeek Cache Optimizer

[English README](./README.md)

开箱即用的 Pi 扩展，用稳定 prompt 前缀提升 provider-side KV Cache / Prompt Cache 命中概率，并以保守的 provider-specific adapter 显示底部缓存统计。

> 重要：prompt/KV 缓存是 provider 侧、best-effort 行为。本扩展只能通过稳定前缀、在 Pi 支持时请求长保留、提醒明显 compat 缺口、以及展示 provider 暴露的轻量统计来提高命中概率，不能保证每次命中。第三方代理可能隐藏、丢失、重路由或重新解释缓存行为。

## 做了什么

| 功能 | 方式 | 是否需要手动操作 |
|------|------|:---:|
| 🔄 重组 system prompt | `before_agent_start` 钩子 — 稳定前缀在前、动态上下文在后 | ❌ 自动 |
| ⏳ 长缓存保留 | 扩展加载时设置 `PI_CACHE_RETENTION=long`；Pi/provider compat 决定实际发送内容 | ❌ 自动 |
| 🔗 保守 compat 提醒 | DeepSeek session-affinity 提醒，以及 Claude 兼容 endpoint 的明显 cache-control 提醒 | ⚠️ 见下 |
| 📊 Provider-specific 底部统计 | 在 Pi footer/status 中显示受支持 provider family 的只读缓存统计 | ❌ 自动 |

## 支持的统计 adapter

本版本保留原有 DeepSeek 行为，并增加针对 Pi 或 provider 能安全暴露 usage 的只读统计 adapter。Adapter 选择刻意只使用 model id/name（以及 `message_end` 中 assistant message 的 `model`/`name`）；不会用 provider id、API type、base URL、`thinkingFormat` 或 compat flags 来选择统计 adapter。

| Adapter | 检测方式 | 底部标签 | usage 字段 |
|---|---|---|---|
| DeepSeek | model id/name 包含 `deepseek` | `DS cache` | Pi `usage.cacheRead`/`usage.input`，或可见 raw 字段 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`prompt_tokens` |
| OpenAI-family | model id/name 包含保守 OpenAI-family token，例如 `gpt-`、`chatgpt`、`o1`、`o3`、`o4` 或 `o5` | `OpenAI cache` | Pi 归一化 usage，或可见 raw 字段 `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` 及 prompt/input total |
| Anthropic / Claude | model id/name 包含 `anthropic` 或 `claude` | `Claude cache` | Pi 归一化 usage，或可见 raw 字段 `cache_read_input_tokens`、`cache_creation_input_tokens`、`input_tokens` |
| Gemini / Vertex | model id/name 包含 `gemini` 或 `vertex` | `Gemini cache` | Pi 归一化 usage，或可见 Gemini/Vertex cached-content token metadata |

Generic OpenAI-compatible 代理**不会**仅因为使用 OpenAI 形状 API 或 provider id 就被当作 OpenAI-family。如果当前 model id/name 语义不明确，扩展会隐藏底部统计，而不是猜测。

## 安装

```bash
pi install npm:pi-deepseek-cache-optimizer
```

安装后 `PI_CACHE_RETENTION=long` **自动生效**，system prompt **自动重组**，受支持 model family 的响应完成且暴露 usage 后，底部状态栏会显示缓存统计。

## 卸载

请移除当初安装时使用的同一个 package source。npm 包对应命令：

```bash
pi remove npm:pi-deepseek-cache-optimizer
```

如果你是从本地路径安装的，请移除同一个路径/source，例如：

```bash
pi remove /absolute/path/to/pi-deepseek-cache-optimizer
# 或者，如果安装时使用的就是这个相对路径：
pi remove ./relative/path/to/pi-deepseek-cache-optimizer
```

如果当初使用 `pi install -l ...` 安装到项目级 settings，请使用对应的项目级卸载命令，例如 `pi remove -l npm:pi-deepseek-cache-optimizer`。

移除 package 后，在 Pi 中执行 `/reload` 或重启 Pi，让扩展卸载。底部统计计数器会单独持久化；如果也想删除这个本地状态文件，可以执行：

```bash
rm ~/.pi/agent/deepseek-cache-optimizer-stats.json
```

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
- 统计会持久化到本地小 JSON 文件：`~/.pi/agent/deepseek-cache-optimizer-stats.json`。该文件只保存计数器和本地日期，不保存 API key、prompt、消息内容、headers 或模型输出。
- DeepSeek-only 旧版本的 v1 状态文件会自动迁移到 DeepSeek adapter 计数器。

重置规则：

- Pi 重启**不会**清零统计；扩展会恢复已持久化的计数器。
- `/reload` / extension reload 会清零并覆盖持久化计数器，因为 Pi 会暴露 `session_start` 的 `reason: "reload"`。
- 长时间运行跨过本地自然日时，会在下一次状态更新或受支持 provider 响应统计前自动按本地日期清零。

## 建议的 compat 配置

对直连 DeepSeek 或 DeepSeek-like OpenAI-compatible 代理，建议在对应 provider 或 model 的 `compat` 中配置：

```json
{
  "providers": {
    "deepseek": {
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

## 原理

Provider 缓存通常依赖精确或近似精确的前缀匹配。Pi 的 system prompt 包含跨会话稳定的内容（工具定义、技能、规范），也包含每次变化的动态内容（git status、当前任务）。

```text
优化前: [动态 git status | 任务上下文 | 稳定工具+规范]
         ↓ 每次前缀不同 → 缓存复用降低

优化后: [稳定工具+规范 | 动态 git status | 任务上下文]
         ↓ 稳定前缀不变 → 更容易命中缓存
```

Pi 本身还会根据模型 compat 和 `PI_CACHE_RETENTION` 决定是否发送缓存相关字段，例如 `prompt_cache_key`、`prompt_cache_retention`、session affinity headers 或 Anthropic-style `cache_control`。本扩展不伪造缓存命中，只帮助配置、提高稳定前缀概率，并把已暴露的 usage 汇总到底部状态栏。

## 提高 cache 命中率

代码里的命中率优化会保持保守和 provider-neutral：把最大的稳定 prompt 前缀放在最前面，让 Pi/provider compat 发送其支持的缓存控制字段，避免把不受支持的 request 字段泄漏给代理。

扩展会自动做这些事：

- 把稳定 prompt 内容移动到动态 task/git/session 上下文之前。除了 tools、skills、custom prompt、append prompt 和 guideline bullets，现在也会把小型稳定项目/规范文件（例如 `AGENTS.md`、`.trellis/spec/...`）保留在更靠前的 cacheable prefix 中。
- 设置 `PI_CACHE_RETENTION=long`，让 Pi 在当前模型/provider compat 支持时请求更长缓存保留。
- 按 provider family 分开 footer 计数，方便你验证当前活跃模型 family 是否真的报告 cache reads。

各 provider 注意点：

- DeepSeek：现有行为仍是参考路径。稳定前缀排序，加上 long-retention / session-affinity compat，最有利于自动 KV prefix 复用。
- OpenAI-family：prompt caching 只会在真实上游支持且 prompt 足够长时自动生效。请尽量把静态 instructions、tools、examples、specs 放在变化的 user/task context 前面。支持的 `prompt_cache_key` / `prompt_cache_retention` 传输字段由 Pi 负责。
- Claude：prompt caching 依赖 Anthropic `cache_control` breakpoints。本扩展不会自行注入 breakpoint；对兼容 endpoint，只在 endpoint 明确支持时配置 Pi compat，例如 `cacheControlFormat: "anthropic"`。
- Gemini/Vertex：implicit caching 受益于重复的大型稳定前缀。本扩展不会创建 explicit `cachedContents` resources，也不会保存 cache resource names。
- Proxies/aggregators：尽量固定上游 routing/provider order。如果同一个 model id/name 可能路由到不同上游，cache hit rate 会不稳定。

## Provider-specific 限制

本包现在有 provider-family stats adapter，但仍避免盲目泛化：

- DeepSeek cache 是自动的 prefix/KV cache。命中是 best-effort，代理可能隐藏 DeepSeek usage 字段。
- OpenAI-family prompt caching 只有在真实上游支持且 prompt 足够长时才会自动生效。adapter 基于模型名称且刻意保守；不会用 provider/API/base URL metadata 推断官方 OpenAI 支持。
- Claude prompt caching 依赖显式 Anthropic cache-control breakpoints。本版本只报告 Pi/provider 暴露的统计；不会插入 breakpoint，也不会修改请求体。
- Gemini/Vertex 可能暴露 implicit cached-content token count。本版本不会创建、保存、更新或删除 explicit Gemini cached-content resources。
- Proxies/aggregators 可能把同一个 model name 路由到不同上游 provider。由于检测是 id/name-only，请使用无歧义 model name、固定上游 routing，并验证 exposed usage 后再判断缓存行为。

## 本版本不包含

- 修改请求体。
- 注入 Anthropic `cache_control` markers。
- 在 Pi 自己的 compat 处理之外发送或覆盖 OpenAI `prompt_cache_key` / `prompt_cache_retention`。
- 创建 Gemini explicit `cachedContents` resources 或持久化 cache resource names。
- 对不暴露可靠 cache usage 的 provider 声称统计支持。

## 验证效果

### 在 Pi 中查看

- 查看当前活跃 family 的底部标签，例如 `DS cache ...`、`OpenAI cache ...`、`Claude cache ...` 或 `Gemini cache ...`。
- 使用 Pi 内置 `/stats` 查看 Pi 归一化后的 `cacheRead` tokens 是否增长。
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
