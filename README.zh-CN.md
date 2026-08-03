# Pi Cache Optimizer

[![npm version](https://img.shields.io/npm/v/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dm/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![license](https://img.shields.io/npm/l/pi-cache-optimizer.svg)](./LICENSE)

[English README](./README.md)

用于提升 Pi 中 provider 侧 KV Cache / Prompt Cache 命中率的扩展：把稳定 prompt 内容前置，给 OpenAI-compatible 请求补保守的 `prompt_cache_key`，提示代理渠道常见缓存路由兼容问题，并在底部显示只读缓存统计。

> 本包已从 `pi-deepseek-cache-optimizer` 改名。已有底部统计会自动迁移。正常运行时扩展不会触碰 Pi 的 `models.json`（默认 `~/.pi/agent/models.json`；自定义 agent 目录使用 `PI_CODING_AGENT_DIR`）；只有 `/cache-optimizer fix` 会在展示交互式预览、风险提示并得到明确确认后写入，且会先创建带时间戳的自动备份。

## 目录

- [功能](#功能)
- [安装](#安装)
- [命令](#命令)
- [持久 Opt-out](#持久-opt-out)
- [Footer 缓存统计模式](#footer-缓存统计模式)
- [OpenAI-compatible 代理配置](#openai-compatible-代理配置)
- [Adaptive thinking 模型](#adaptive-thinking-模型)
- [使用 `/cache-optimizer fix` 自动修复](#使用-cache-optimizer-fix-自动修复)
- [Footer 统计](#footer-统计)
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
- 默认显示按本地日期累计的 provider/model footer 缓存统计，也可切换为仅显示当前 session。
- 通过版本化全局协议（`Symbol.for("pi.routing.registry.v1")` 与 `Symbol.for("pi.cache.hints.v1")`）支持可选的 router extension 集成，而不导入任何 router 包。

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

本扩展已使用 Pi 0.83.0 验证，并继续面向 Pi 0.82+ 设计。它使用这些版本共有的 extension hooks、`getAgentDir()` 和 prompt options，不依赖 Pi 0.83 专有 API（例如 `ctx.scopedModels` 或 bundled TypeBox 1.3 aliases）。

## 命令

| 命令 | 作用 |
|---|---|
| `/cache-optimizer` | UI 支持时打开交互菜单；否则打印帮助和当前状态。 |
| `/cache-optimizer enable` | 在当前 Pi 进程中开启运行时优化，清零本地 footer 统计，并开始新的“开启状态”测量。 |
| `/cache-optimizer disable` | 在当前 Pi 进程中关闭优化，清零本地 footer 统计，并继续以 disabled 对比模式采集 footer 统计。运行 `/reload` 或重启 Pi 后回到启动时行为。 |
| `/cache-optimizer doctor` | 显示当前模型 / provider / API / base URL / compat 与低命中诊断。 |
| `/cache-optimizer compat` | 对当前模型显示可复制的 compat 建议（如适用）。 |
| `/cache-optimizer stats` | 显示当前模型今天的本地 provider/model 统计和近期趋势。 |
| `/cache-optimizer reset` | 重置当前 provider/model 的本地 footer 统计；不会修改上游 provider 缓存。 |
| `/cache-optimizer config footer-mode session\|total` | 持久设置 footer 统计模式；持久命令配置优先于环境变量。 |
| `/cache-optimizer fix` | 为当前模型自动修复安全的 compat 问题（adaptive thinking、DeepSeek reasoning、OpenAI proxy session affinity）。展示预览 + 风险提示，需要用户确认。**仅在用户明确批准后才修改 `models.json`。** |

`enable` / `disable` 是当前进程内开关。若要持久关闭某些能力，请使用下面的环境变量。

## 持久 Opt-out

| 环境变量 | 作用 |
|---|---|
| `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` | 只关闭 prompt 改写；footer 统计和 cache-key fallback 仍启用。 |
| `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` | 保留 Pi 原始 verbose skill XML。 |
| `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | 关闭 OpenAI-compatible `prompt_cache_key` fallback。推荐使用这个显式 opt-out。 |
| `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` | 通过旧的反向开关关闭同一个 fallback。取值 `0`、`false`、`no`、`off` 时关闭。 |

## Footer 缓存统计模式

Footer 默认使用 `total`，显示当前本地日期内、跨 Pi session 和进程重启延续的 provider/model 统计。可以通过命令或环境变量切换显示范围：

| 值 | 作用 |
|---|---|
| `total`（默认） | 显示今天跨 session 持久延续的 provider/model 累计统计；本地日期切换时重置。 |
| `session` | 仅显示当前 hashed Pi session 的统计。新 session 从 `0/0` 开始；同一 session 内 `/reload` 会恢复该 session 桶。 |

持久命令配置优先于环境变量：

```text
/cache-optimizer config footer-mode session
/cache-optimizer config footer-mode total
```

显式设置保存在 Pi agent 目录下的 `pi-cache-optimizer-config.json`。没有命令覆盖时，读取 `PI_CACHE_OPTIMIZER_FOOTER_MODE=session|total`；值不区分大小写，缺失或非法值均回退到 `total`。如需让已有安装重新由环境变量控制，请手动删除 `pi-cache-optimizer-config.json`，然后运行 `/reload`。

## OpenAI-compatible 代理配置

LiteLLM / OneAPI / NewAPI / 类 OpenRouter 渠道等第三方 `openai-completions` 代理，常会把同一个 session 分散到多个上游后端，导致 provider 侧 prompt cache 被拆散。

Pi 0.81+ 也内置了使用 OpenAI-shaped transport 的 `llama.cpp` provider。Pi 0.82+ core 在启用 cache retention 时会为它生成 session `prompt_cache_key`，因此本扩展会保留该 key，并在缺失时使用同样的保守 fallback。只有符合 Pi 内置 provider 明确 compat 指纹的模型会跳过通用 proxy 路由 / session-affinity 建议；仅复用 `llama.cpp` id 的自定义或覆盖 provider 仍按普通 OpenAI-compatible 渠道处理。`prompt_cache_retention` 继续遵循统一安全规则：仅官方 OpenAI 或 `models.json` 中有效配置为 `supportsLongCacheRetention: true` 时保留，否则发送前移除。有效值遵循 Pi 的优先级：先看 `modelOverrides[modelId].compat`，再看匹配的 `models[].compat`，最后看 provider 级 `compat`；高层显式 `false` 会覆盖低层的 `true`。

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
- 如果出现 `400 Unsupported parameter: prompt_cache_retention`，请为该渠道移除 / 避免 `supportsLongCacheRetention`；如支持，可保留 `sendSessionAffinityHeaders`。
- 使用 `/cache-optimizer compat` 或 `/cache-optimizer doctor` 查看当前模型的具体建议。
- 对 DeepSeek 模型，Pi Mono 指南期望在支持时同时设置 `compat.requiresReasoningContentOnAssistantMessages: true` 和 `compat.thinkingFormat: "deepseek"`，再配合缓存 / session-affinity 相关 compat。
- 本扩展的 `doctor` 和 `compat` 命令只给建议，不会修改 `models.json`。

## Anthropic 缓存 TTL 兼容

Anthropic 按 `tools → system → messages` 顺序处理 cache breakpoint，并拒绝位于 5 分钟 breakpoint 之后的 `ttl: "1h"` breakpoint。省略 `ttl` 的 ephemeral `cache_control` 使用默认 5 分钟保留时间。

对于所有 `anthropic-messages` 渠道，本扩展都会检查最终序列化 payload，并立即降级可见的非法短 TTL → 长 TTL 顺序。合法的纯 `1h` 和 `1h → 5m` payload 保持不变，包括真正支持 1 小时保留的第三方 endpoint。

部分代理会在 Pi request hook 之后重写或插入隐藏的 5 分钟 breakpoint。如果 provider 返回 Anthropic 明确的 TTL 顺序错误，本扩展会记录当前进程内的 provider/model fallback，使下一次后续请求使用默认 5 分钟 TTL。Pi 0.82.1 将此错误视为不可自动重试的 HTTP 400，因此扩展不会声称 Pi 会自动重跑失败 turn；如果其它层发起重试，该重试也会使用 fallback。`/cache-optimizer doctor` 会显示该 fallback，`/cache-optimizer fix` 可通过现有确认/备份流程，以 model level 持久写入 `supportsLongCacheRetention: false`。其它 400 和 prompt-too-long 错误不会触发该 fallback。运行时观测会持续到当前进程退出，并会在同一进程内的扩展 reload 后保留。

## Adaptive thinking 模型

Claude 从 opus-4.6 / sonnet-4.6（含 Opus 5、Sonnet 5）/ fable-5 开始需要在 compat 中设置 `forceAdaptiveThinking: true`。Kimi Coding K3（`k3`）和 `kimi-for-coding` 也使用 adaptive thinking，并需要 `allowEmptySignature: true`，以正确重放空 signature 的 thinking block。缺少这些 compat 时，Pi 可能发送旧版 thinking payload 或错误重放 thinking。Pi 0.83.0 的原生 Opus 5 catalog 已覆盖在同一 adaptive-thinking 检测中；如果自定义 `anthropic-messages` 渠道没有继承该 compat，仍需手动设置。

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
- DeepSeek Pi Mono reasoning compat（`thinkingFormat: "deepseek"`、`requiresReasoningContentOnAssistantMessages: true`）
- OpenAI-compatible proxy session affinity（`openai-completions` 使用 `sendSessionAffinityHeaders: true`）。Pi 0.80.7+ 使用 `sessionAffinityFormat` 控制 `openai-responses` header 形式并自动检测默认值；本扩展不再写入已移除的 `sendSessionIdHeader`。

**范围：** 仅当前 active model。其他渠道需切换模型后再次运行 `fix`。

**安全机制：**

1. 显示完整变更预览（文件路径、编辑位置、要写入的 JSON、风险说明）
2. 警告：① 修改影响使用该渠道的所有 session，② 自动备份到 `models.json.backup-cache-optimizer-<timestamp>`，③ 需重启 Pi 或 reload
3. 使用保留注释的精确编辑器 —— 现有注释、缩进和已有 key 顺序都会保留
4. 需要用户明确确认（交互式提示或 `ui.select`）
5. 原子写入（temp + rename）；写入后自我验证
6. 如果 JSONC 扫描器无法置信定位目标，回退到手动修改指引

已有的 `modelOverrides[modelId]` 具有 Pi 的最高优先级，因此 `fix` 会直接修复该 entry。对于没有自定义 `models[]` entry 的内置模型或 API-login 模型，`fix` 会创建仅含 compat 的 `modelOverrides` entry，而不会凭空添加自定义模型定义。自检会验证三层合并后的有效 compat，因此被更高层 override 遮蔽的低层修改会被拒绝。

**非交互模式：** 拒绝写入，显示手动编辑指引。

**运行：** 当 active model 检测到 compat 问题时执行 `/cache-optimizer fix`。compat 已完整时，命令显示"无需修复"。

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

## Footer 统计

统计是只读本地计数，保存在 Pi agent 目录（默认 `~/.pi/agent/pi-cache-optimizer-stats.json`；自定义 agent 目录使用 `PI_CODING_AGENT_DIR`）。扩展同时维护当天的 provider/model totals 和 hashed session buckets。Footer 默认显示每日 totals；选择 `session` 模式后显示当前 session 桶。统计文件只包含日期和数字计数，不包含 API key、prompt、payload、headers、响应或模型输出。Footer 模式配置单独保存在 `pi-cache-optimizer-config.json`。

Pi 0.79+ 已内置 footer `CH` 标记，用于显示最近一次 prompt cache hit rate。本扩展在此基础上补充持久化的 provider/model 计数，以及代理 compat 诊断。

示例 footer：

```text
OpenAI cache 3/10 · 0.002M/0.005M tok (40%) ⚠️ compat
```

格式：`<label> <命中请求数>/<总请求数> · <cached input tokens>/<total input tokens> tok (<token 命中率>)`。部分 adapter 还可能追加 `· write <tokens> tok`，运行时诊断可能追加 `⚠️ compat` 或 `⚠️ integrity`。

支持的 footer label 包括：DS、Claude、OpenAI、Gemini、Kimi、Qwen、GLM、MiniMax、Mimo、Hunyuan、Mistral、Grok、Llama、Nemotron、Cohere、Yi、Doubao、ERNIE、Baichuan、StepFun、Spark、InternLM、Gemma、Phi、Jamba、Solar、Sonar、Nova、Reka、Falcon、DBRX、MPT、StableLM、Aquila、EXAONE、HyperCLOVA、Luminous、Hermes、Granite、Arctic、Pangu、SenseNova、Zhinao、MiniCPM、XVERSE、Orion、OpenChat、Vicuna、Wizard、Zephyr、Dolphin、OpenOrca、Starling、BLOOM、RWKV、Aya。

Adapter 选择只看模型 id/name（以及 message_end 时 assistant message 的 model/name）。仅使用 OpenAI-shaped API 不会被当作 OpenAI-family，除非模型 id/name 匹配受支持的家族。

## Router / Virtual-channel 扩展作者指南

如果你的 Pi 扩展提供虚拟 routing provider（例如 `router/auto`、`router/smart`，或会转发到真实上游的 profile/channel），本扩展可以为真实上游 provider/model 显示缓存统计，而不是把统计记到虚拟外壳上。集成是可选、版本化的，并且**不需要导入本包**。

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
| Linux / macOS / WSL | `rm -f ~/.pi/agent/pi-cache-optimizer-stats.json ~/.pi/agent/pi-cache-optimizer-config.json ~/.pi/agent/deepseek-cache-optimizer-stats.json` |
| Windows PowerShell | `Remove-Item -Force "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-stats.json", "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-config.json", "$env:USERPROFILE\.pi\agent\deepseek-cache-optimizer-stats.json" -ErrorAction SilentlyContinue` |
| Windows 命令提示符 | `del /f /q "%USERPROFILE%\.pi\agent\pi-cache-optimizer-stats.json" "%USERPROFILE%\.pi\agent\pi-cache-optimizer-config.json" "%USERPROFILE%\.pi\agent\deepseek-cache-optimizer-stats.json" 2>nul` |

清理时不要删除 `models.json`；它保存你的 Pi 模型 / provider 配置，不属于本包。

## 验证效果

1. 选择一个 provider 会暴露 cache usage 的模型。
2. 在同一个 Pi session 中连续发送几轮相似请求。
3. 观察 footer，或运行 `/cache-optimizer stats`。
4. 对第三方代理，再运行 `/cache-optimizer doctor`，并在代理侧确认 sticky routing / session affinity。

## License

MIT
