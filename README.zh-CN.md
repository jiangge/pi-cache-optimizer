# Pi DeepSeek Cache Optimizer

[English README](./README.md)

开箱即用的 DeepSeek KV Cache / Prompt Cache 优化扩展。

> 重要：DeepSeek 缓存是服务端的、自动的、best-effort 行为。本扩展只能通过稳定前缀、长保留、session affinity 提醒、轻量统计来提高命中概率，不能保证每次命中。使用第三方代理时，代理也可能隐藏、丢失或降低缓存命中效果。

## 做了什么

| 功能 | 方式 | 是否需要手动操作 |
|------|------|:---:|
| 🔄 重组 system prompt | `before_agent_start` 钩子 — 稳定前缀在前、动态上下文在后 | ❌ 自动 |
| ⏳ 长缓存保留 | 扩展加载时自动设置 `PI_CACHE_RETENTION=long` | ❌ 自动 |
| 🔗 Session 亲和提醒 | 根据 model id / name 检测 DeepSeek-like 模型的 compat 配置 | ⚠️ 见下 |
| 📊 底部缓存统计 | 使用 Pi footer/status 显示 DeepSeek cache 命中请求数与命中 token 比例 | ❌ 自动 |

## 安装

```bash
pi install npm:pi-deepseek-cache-optimizer
```

安装后 `PI_CACHE_RETENTION=long` **自动生效**，system prompt **自动重组**，DeepSeek-like 模型响应完成后底部状态栏会显示缓存统计。

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

扩展会在 Pi 底部状态栏显示类似：

```text
DS cache 3/5 · 0.77M/0.80M tok (96%)
```

含义：

- `3/5`：5 次 DeepSeek-like assistant 响应中，有 3 次 `cacheRead > 0`。
- `0.77M/0.80M tok`：累计 cache-read input tokens / 累计 prompt input tokens，单位固定显示为百万（M）。
- 百分比：`cacheRead / total prompt input`。

统计规则：

- 只统计 model id 或 model name 中包含 `deepseek` 的 assistant 响应。
- 只统计 Pi/provider 暴露 usage 的 assistant 响应。
- `cacheRead` 来自 Pi 归一化后的 `usage.cacheRead`。
- prompt input 总量使用 `usage.input + usage.cacheRead + usage.cacheWrite`。在 DeepSeek 的常见用法里，`usage.input` 对应未命中/非缓存输入，`usage.cacheRead` 对应缓存命中输入；如果 provider 暴露 `cacheWrite`，也会计入总 prompt input，避免分母偏小。
- 统计只更新底部状态栏，不创建额外 TUI 组件，也不写诊断文件；因此不会因调试组件频繁重绘导致屏幕闪烁。
- 统计会持久化到本地小 JSON 文件：`~/.pi/agent/deepseek-cache-optimizer-stats.json`。该文件只保存计数器和本地日期，不保存 API key、prompt、消息内容或模型输出。

重置规则：

- Pi 重启**不会**清零统计；扩展会恢复已持久化的计数器。
- `/reload` / extension reload 会清零并覆盖持久化计数器，因为 Pi 会暴露 `session_start` 的 `reason: "reload"`。
- 长时间运行跨过本地自然日时，会在下一次状态更新或 DeepSeek-like 响应统计前自动按本地日期清零。

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

如果你的 provider id 不是 `deepseek`（例如公司代理、OpenRouter 风格代理），也可以把同样字段放在该 provider 或具体 DeepSeek 模型的 `compat` 里。扩展识别 DeepSeek-like 模型的依据是 model id / model name 是否包含 `deepseek`；不会根据 provider id、baseUrl 或 `thinkingFormat` 判断。当前推荐的验证路径只覆盖官方直连 `deepseek/deepseek-v4-pro`。

扩展会对每个 provider/model **每个会话最多提醒一次**：

- 缺少 `supportsLongCacheRetention: true`：Pi 可能不会发送 `prompt_cache_retention: "24h"`。
- 缺少 `sendSessionAffinityHeaders: true`（OpenAI Completions 兼容 API）或 `sendSessionIdHeader: true`（OpenAI Responses 兼容 API）：Pi 可能不会发送 session affinity headers（如 `session_id`、`x-client-request-id`、`x-session-affinity`），代理/负载均衡场景下缓存命中可能更差。

> 提醒：`sendSessionAffinityHeaders` 是否真的被上游接受取决于 provider/代理。只有在 endpoint 支持这些 header 时才建议启用。

## 原理

DeepSeek KV Cache 基于**前缀精确匹配**。Pi 的 system prompt 包含跨会话稳定的内容（工具定义、技能、规范），也包含每次变化的动态内容（git status、当前任务）。

```text
优化前: [动态 git status | 任务上下文 | 稳定工具+规范]
         ↓ 每次前缀不同 → 缓存全失效

优化后: [稳定工具+规范 | 动态 git status | 任务上下文]
         ↓ 稳定前缀不变 → 更容易命中缓存
```

Pi 本身还会根据模型 compat 和 `PI_CACHE_RETENTION` 决定是否发送缓存相关字段，例如 `prompt_cache_key`、`prompt_cache_retention`、session affinity headers 或 Anthropic-style `cache_control`。本扩展不伪造缓存命中，只帮助配置、提高稳定前缀概率，并把已暴露的 usage 汇总到底部状态栏。

## 能否扩展到其他模型或 provider？

有可能，但当前实现刻意聚焦 DeepSeek：

- 检测逻辑和 compat 提醒只针对 model id 或 model name 中包含 `deepseek` 的模型。
- 底部统计目前只统计 DeepSeek-like assistant 响应。非 DeepSeek 模型仍可能受益于稳定前缀的 prompt 重排，但今天不会计入 `DS cache ...` 计数器。
- 缓存 usage 字段具有 provider 差异。DeepSeek / OpenAI-compatible provider 可能暴露 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`，或被 Pi 归一化为 `usage.cacheRead` / `usage.input`；其他 provider 可能使用不同字段，或者完全不暴露缓存 usage。

比较可能扩展的方向：

- 带 prompt caching 且暴露 usage 字段的 OpenAI-compatible provider。需要把 provider/model 检测从 `deepseek` 子串扩展为明确能力检测，并为其 cache-hit / cache-miss 字段增加统计解析。
- 支持 `cache_control` 的 Anthropic 模型。Anthropic 缓存有显式 cache-control 放置和 TTL 语义，不能简单套用 DeepSeek 的自动前缀缓存假设，需要 cache-control-aware 的 prompt 构造。
- 官方 OpenAI / ChatGPT-compatible 模型的自动 prompt caching。这类模型未必暴露与 DeepSeek 相同的控制项或统计字段，是否支持取决于 Pi/provider 能否暴露 cached input tokens 和 cache retention 相关信息。

要安全支持更多 provider，扩展需要增加 provider-specific capability detection、缓存 usage 归一化、适用时的 cache-control 或 retention 处理，以及符合各 provider 缓存语义的稳定前缀策略。在此之前，请把本包视为 DeepSeek 优化器，以及一个对部分模型也可能有帮助的 prompt 重排工具。

## 验证效果

### 在 Pi 中查看

- 使用底部 `DS cache ...` 状态查看本地当天的 DeepSeek cache 命中请求数和 token 比例。
- 使用 Pi 内置 `/stats` 查看累计 `cacheRead` tokens 是否增长。
- DeepSeek API usage 中也可能出现 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；Pi 会尽量归一化为 `usage.cacheRead` / `usage.input`。

### 官方 DeepSeek baseline（推荐且当前唯一建议路径）

请使用官方直连 `deepseek/deepseek-v4-pro` 做基线；暂不建议把代理路径混进同一次验证。请不要把 API key 粘贴到聊天记录或 issue 中。

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

## 发布

发布前先检查 npm 包内容，确认只包含扩展源码、README、LICENSE 和 package manifest：

```bash
npm pack --dry-run
npm publish --access public
```
