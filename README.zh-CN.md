# Pi Cache Optimizer

[![npm version](https://img.shields.io/npm/v/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dm/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![license](https://img.shields.io/npm/l/pi-cache-optimizer.svg)](./LICENSE)

[English README](./README.md)

用于提升 Pi 中 provider 侧 KV Cache / Prompt Cache 命中率的扩展：把稳定 prompt 内容前置，给 OpenAI-compatible 请求补保守的 `prompt_cache_key`，提示代理渠道常见缓存路由兼容问题，并在底部显示只读缓存统计。

**GitHub About：** Improve Pi prompt/KV cache hit rates with stable prompts, OpenAI-compatible cache keys, proxy compat warnings, and footer cache stats.

> 本包已从 `pi-deepseek-cache-optimizer` 改名。已有底部统计会自动迁移。本扩展绝不会创建、修改、备份或删除你的 `~/.pi/agent/models.json`。

## 功能

- 将稳定的 system prompt 内容移动到动态上下文之前。
- 压缩 Pi skill 列表，并移除 session-overview 中的易变字段。
- 在 Pi / provider compat 支持时请求长缓存保留。
- 对 `openai-completions` / `openai-responses` 请求，在没有有效 key 时使用 Pi session id 补 `prompt_cache_key`。
- 对缺少缓存 / session-affinity compat 的第三方 OpenAI-compatible 代理给出一次性提醒。
- 为支持的模型家族显示按 session 隔离的底部缓存统计。

缓存是 provider 侧的 best-effort 行为。第三方代理仍可能隐藏缓存 usage、拒绝不支持的参数，或把请求路由到多个上游。

## 安装

```bash
pi install npm:pi-cache-optimizer
```

如果之前安装过旧包：

```bash
pi remove npm:pi-deepseek-cache-optimizer && pi install npm:pi-cache-optimizer
```

安装、更新或移除后，在 Pi 中运行 `/reload`，让 extension hooks 刷新。

## 命令

| 命令 | 作用 |
|---|---|
| `/cache-optimizer` | UI 支持时打开交互菜单；否则打印帮助和当前状态。 |
| `/cache-optimizer enable` | 在当前 Pi 进程中开启运行时优化，清零当前 session 统计，并开始新的“开启状态”测量。 |
| `/cache-optimizer disable` | 在当前 Pi 进程中关闭优化，清零当前 session 统计，并继续以 disabled 对比模式采集 footer 统计。运行 `/reload` 或重启 Pi 后回到启动时行为。 |
| `/cache-optimizer doctor` | 显示当前模型 / provider / API / base URL / compat 与低命中诊断。 |
| `/cache-optimizer compat` | 对当前模型显示可复制的 compat 建议（如适用）。 |
| `/cache-optimizer stats` | 显示当前模型今天的 session-scoped 统计和近期趋势。 |
| `/cache-optimizer reset` | 只重置当前 session + 当前模型的本地统计；不会修改上游 provider 缓存。 |

`enable` / `disable` 是当前进程内开关。若要持久关闭某些能力，请使用下面的环境变量。

## 持久 Opt-out

| 环境变量 | 作用 |
|---|---|
| `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` | 只关闭 prompt 改写；footer 统计和 cache-key fallback 仍启用。 |
| `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` | 保留 Pi 原始 verbose skill XML。 |
| `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` | 关闭 OpenAI-compatible `prompt_cache_key` fallback。 |
| `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | 关闭 OpenAI-compatible `prompt_cache_key` fallback。 |

## OpenAI-compatible 代理配置

对 Otokapi / LiteLLM / OneAPI / NewAPI / 类 OpenRouter 渠道等第三方 `openai-completions` 代理，缓存命中率低通常是因为请求被分散到多个后端。安全默认配置是 session affinity：

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

只有在 endpoint / proxy 明确支持 OpenAI long prompt cache retention 时，才添加 `supportsLongCacheRetention: true`。本扩展不会直接写入 `prompt_cache_retention`；它会请求 `PI_CACHE_RETENTION=long`，当 compat 声明支持 long retention 时，Pi 可能发送 `prompt_cache_retention`。如果某代理返回 `400 Unsupported parameter: prompt_cache_retention`，请为该渠道移除 / 避免 `supportsLongCacheRetention`，如支持可保留 `sendSessionAffinityHeaders`，并用 `/cache-optimizer compat` / `/cache-optimizer doctor` 诊断。当启用 long retention compat 时观察到 400，本扩展会给一次性 warning，并在 doctor 中提示。本扩展只给建议，不会修改 `models.json`。

## Footer 统计

统计是只读本地计数，保存在 `~/.pi/agent/pi-cache-optimizer-stats.json`，按 Pi session + provider/model 隔离。文件只包含日期和数字计数，不包含 API key、prompt、payload、headers、响应或模型输出。

示例 footer：

```text
OpenAI cache 3/10 (30%) · 0.002M/0.005M tok ⚠️ compat
```

支持的 footer label 包括：DS、Claude、OpenAI、Gemini、Kimi、Qwen、GLM、MiniMax、Hunyuan、Mistral、Grok、Llama、Nemotron、Cohere、Yi、Doubao、ERNIE、Baichuan、StepFun、Spark、InternLM、Gemma、Phi、Jamba、Solar、Sonar、Nova、Reka、Falcon、DBRX、MPT、StableLM、Aquila、EXAONE、HyperCLOVA、Luminous、Hermes、Granite、Arctic、Pangu、SenseNova、Zhinao、MiniCPM、XVERSE、Orion、OpenChat、Vicuna、Wizard、Zephyr、Dolphin、OpenOrca、Starling、BLOOM、RWKV、Aya。

Adapter 选择只看模型 id/name（以及 message_end 时 assistant message 的 model/name）。仅使用 OpenAI-shaped API 不会被当作 OpenAI-family，除非模型 id/name 匹配受支持的家族。

## 卸载

```bash
pi remove npm:pi-cache-optimizer
```

然后运行 `/reload` 或重启 Pi。可选：删除本地统计文件：

```bash
rm -f ~/.pi/agent/pi-cache-optimizer-stats.json
rm -f ~/.pi/agent/deepseek-cache-optimizer-stats.json
```

## 验证效果

1. 选择一个 provider 会暴露 cache usage 的模型。
2. 在同一个 Pi session 中连续发送几轮相似请求。
3. 观察 footer，或运行 `/cache-optimizer stats`。
4. 对第三方代理，再运行 `/cache-optimizer doctor`，并在代理侧确认 sticky routing / session affinity。

## License

MIT
