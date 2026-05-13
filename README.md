# Pi DeepSeek Cache Optimizer

开箱即用的 DeepSeek KV Cache / Prompt Cache 优化扩展。

> 重要：DeepSeek 缓存是服务端的、自动的、best-effort 行为。本扩展只能提高命中概率（稳定前缀、长保留、session affinity 提醒、诊断），不能保证每次命中。使用第三方代理时，代理也可能隐藏、丢失或降低缓存命中效果。

## 做了什么

| 功能 | 方式 | 是否需要手动操作 |
|------|------|:---:|
| 🔄 重组 system prompt | `before_agent_start` 钩子 — 稳定前缀在前、动态上下文在后 | ❌ 自动 |
| ⏳ 长缓存保留 | 扩展加载时自动设置 `PI_CACHE_RETENTION=long` | ❌ 自动 |
| 🔗 Session 亲和提醒 | 根据 model id / name 检测 DeepSeek-like 模型的 compat 配置 | ⚠️ 见下 |
| 🧪 缓存诊断 | `/deepseek-cache-debug` 一次性查看下一次 provider payload 的安全摘要 | 手动触发 |

## 安装

```bash
pi install npm:pi-deepseek-cache-optimizer
```

安装后 `PI_CACHE_RETENTION=long` **自动生效**，system prompt **自动重组**。

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

如果你的 provider id 不是 `deepseek`（例如公司代理、OpenRouter 风格代理），也可以把同样字段放在该 provider 或具体 DeepSeek 模型的 `compat` 里。扩展识别 DeepSeek-like 模型的唯一依据是 model id 或 model name 是否包含 `deepseek`；不会根据 provider id、baseUrl 或 `thinkingFormat` 判断。当前推荐的验证路径只覆盖官方直连 `deepseek/deepseek-v4-pro`。

扩展会对每个 provider/model **每个会话最多提醒一次**：

- 缺少 `supportsLongCacheRetention: true`：Pi 可能不会发送 `prompt_cache_retention: "24h"`。
- 缺少 `sendSessionAffinityHeaders: true`（OpenAI Completions 兼容 API）或 `sendSessionIdHeader: true`（OpenAI Responses 兼容 API）：Pi 可能不会发送 session affinity headers（如 `session_id`、`x-client-request-id`、`x-session-affinity`），代理/负载均衡场景下缓存命中可能更差。

> 提醒：`sendSessionAffinityHeaders` 是否真的被上游接受取决于 provider/代理。只有在 endpoint 支持这些 header 时才建议启用。

## `/deepseek-cache-debug` 诊断

在 Pi 中输入：

```text
/deepseek-cache-debug
```

它会切换一个**一次性** debug 模式：只检查下一次 provider request，然后自动关闭。选择一次性是为了避免长期输出诊断信息、降低误泄露风险和刷屏。

下一次发起模型请求时，扩展会通过 `before_provider_request` 输出一个安全摘要。摘要会**同时**显示在：

1. **编辑器上方 widget** — Pi TUI 内直接可见；response usage 到达后会尽量更新同一个 widget，下一次 agent 开始时清除旧结果
2. **`/tmp/pi-deepseek-cache-debug.txt`** — 写入临时文件方便拷贝/查看；response usage 到达后会覆盖更新同一个文件

摘要包括：

- provider/model、payload model
- `prompt_cache_key` 是否存在（只显示长度和短 hash，不显示原值）
- `prompt_cache_retention` 是否存在
- DeepSeek `thinking` / OpenAI-style `reasoning_effort` 字段是否存在
- request stability：system prompt 长度 + 短 SHA、message count、message role sequence + 短 SHA
- cache/session-affinity 相关 compat flags 是否设置（包括 `sendSessionAffinityHeaders` / `sendSessionIdHeader`）
- assistant 完成后的 response usage（如果 Pi/provider 暴露）：input、output、cacheRead、cacheWrite、totalTokens、近似 miss（`input - cacheRead`）、hit rate、responseModel

不会输出：

- API key
- header 值
- 完整 prompt 或 message 内容
- `prompt_cache_key` 原文

## 原理

DeepSeek KV Cache 基于**前缀精确匹配**。Pi 的 system prompt 包含跨会话稳定的内容（工具定义、技能、规范），也包含每次变化的动态内容（git status、当前任务）。

```text
优化前: [动态 git status | 任务上下文 | 稳定工具+规范]
         ↓ 每次前缀不同 → 缓存全失效

优化后: [稳定工具+规范 | 动态 git status | 任务上下文]
         ↓ 稳定前缀不变 → 更容易命中缓存
```

Pi 本身还会根据模型 compat 和 `PI_CACHE_RETENTION` 决定是否发送缓存相关字段，例如 `prompt_cache_key`、`prompt_cache_retention`、session affinity headers 或 Anthropic-style `cache_control`。本扩展不伪造缓存命中，只帮助配置和诊断。

## 验证效果

### 在 Pi 中查看

- 使用 `/stats` 查看 `cacheRead` tokens 是否增长。
- 使用 `/deepseek-cache-debug` 确认下一次请求是否带有 `prompt_cache_key`、`prompt_cache_retention`、DeepSeek thinking 字段和相关 compat flags；请求完成后同一诊断会追加 response usage（如果可用）。

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

3. 运行一次最小请求，先打开一次性诊断：

   ```bash
   pi --model deepseek/deepseek-v4-pro --thinking high
   ```

   在 Pi 中输入：

   ```text
   /deepseek-cache-debug
   请用一句话回答：cache baseline ping
   ```

4. 对同一或高度相似请求连续运行至少三次，再用 `/stats` 和 `/deepseek-cache-debug` response usage 对比 `cacheRead` / hit rate 是否增长。DeepSeek API usage 中也可能出现 `prompt_cache_hit_tokens`。

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
