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

如果你的 provider id 不是 `deepseek`（例如 `aiapi`、公司代理、OpenRouter 风格代理），也可以把同样字段放在该 provider 或具体 DeepSeek 模型的 `compat` 里。扩展识别 DeepSeek-like 模型的唯一依据是 model id 或 model name 是否包含 `deepseek`；不会根据 provider id、baseUrl 或 `thinkingFormat` 判断。

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

下一次发起模型请求时，扩展会通过 `before_provider_request` 打印一个安全摘要，包括：

- provider/model、payload model
- `prompt_cache_key` 是否存在（只显示长度和短 hash，不显示原值）
- `prompt_cache_retention` 是否存在
- DeepSeek `thinking` / OpenAI-style `reasoning_effort` 字段是否存在
- message count、first message role
- rough system prompt length
- cache/session-affinity 相关 compat flags 是否设置（包括 `sendSessionAffinityHeaders` / `sendSessionIdHeader`）

不会打印：

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
- 使用 `/deepseek-cache-debug` 确认下一次请求是否带有 `prompt_cache_key`、`prompt_cache_retention`、DeepSeek thinking 字段和相关 compat flags。

### 官方 DeepSeek baseline（推荐）

用官方 DeepSeek provider 做基线，可以判断代理是否影响缓存命中。请不要把 API key 粘贴到聊天记录或 issue 中。

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

4. 重复同一或高度相似请求，再用 `/stats` 对比 `cacheRead` 是否增长。DeepSeek API usage 中也可能出现 `prompt_cache_hit_tokens`。

> 注意：baseline 会消耗少量 token；请使用短 prompt，不要粘贴大文件。若通过代理（例如 provider id 为 `aiapi`）测试，请与官方 `deepseek/deepseek-v4-pro` 分开对比。

## 发布

```bash
cd .pi/packages/deepseek-cache-optimizer
npm publish --access public
```
