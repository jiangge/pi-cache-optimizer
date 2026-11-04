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
- [Footer 刷新（2.10）](#footer-刷新210)
- [Footer 缓存统计模式](#footer-缓存统计模式)
- [OpenAI-compatible 代理配置](#openai-compatible-代理配置)
- [Prompt cache 保温（Pi 0.86+）](#prompt-cache-保温pi-086)
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

- 将 Pi 的 skill 列表压缩为按目录分组的 Markdown 列表，保留每个 skill 的名称和完整描述（只去掉 XML 外壳和重复路径），并移除 session-overview 中的易变字段。这两项都是原位修改，不会在 Pi 的提示段之间搬移内容，对 OpenAI Responses/Codex 模型同样生效。（早期版本还会把“稳定”内容提到提示最前面；Pi 0.86 起已按从稳定到易变的顺序拼段，实测前缀稳定性没有差别，因此移除了这一步。）
- 在 Pi / provider compat 支持时请求长缓存保留。
- 仅对 `openai-completions` 代理请求，在没有有效 key 时按会话保守补 `prompt_cache_key`；本扩展自己补的值（该 key、session-affinity 头补齐、cache hints）使用 Pi session id 的单向哈希（`pi-<32 位 hex>`）；Pi 核心自己设置的 key 和头保持不变，已有 key 也绝不覆盖；Pi 1.0+ 已负责 Responses/Codex transport 的 key。
- 对缺少缓存 / session-affinity compat 的第三方 OpenAI-compatible 代理给出一次性提醒。
- 检测 Claude（opus-4.6+ 含 Opus 5、sonnet-4.6+ 含 Sonnet 5、fable-5+、haiku-5+ 含 Haiku 5.5）以及 Kimi Coding K3 / `kimi-for-coding` 自定义渠道的 adaptive-thinking compat。
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

本扩展要求 Pi 0.82+，并已使用 Pi 1.5.0 验证。TypeScript 校验直接使用官方 Pi package 类型，同时只使用这些版本共有的 extension hooks、`getAgentDir()` 和 prompt options；不依赖 Pi 0.83+ 专有 API（例如 `ctx.scopedModels` 或 bundled TypeBox 1.3 aliases）。原生虚拟模型支持与 codemode 嵌套工具调用合并只在会产生它们的 Pi 0.99+ 上生效，较早版本保持原有行为。本地开发基线需要 Node.js 22.19.0 或更高版本，与 Pi 1.0.3 的 engine 要求一致。

## 命令

| 命令 | 作用 |
|---|---|
| `/cache-optimizer` | UI 支持时打开交互菜单；否则打印帮助和当前状态。 |
| `/cache-optimizer enable` | 在当前 Pi 进程中开启运行时优化，清零本地 footer 统计，并开始新的“开启状态”测量。 |
| `/cache-optimizer disable` | 在当前 Pi 进程中关闭优化，清零本地 footer 统计，并继续以 disabled 对比模式采集 footer 统计。运行 `/reload` 或重启 Pi 后回到启动时行为。 |
| `/cache-optimizer doctor` | 显示当前模型 / provider / API / base URL / compat、上一次提示中 skill 列表是否被压缩（未压缩时给出原因，例如无法识别 Pi 的格式）、Pi 缓存保温是否生效以及低命中诊断。 |
| `/cache-optimizer compat` | 对当前模型显示可复制的 compat 建议（如适用）。 |
| `/cache-optimizer stats` | 显示当前 conversation session 今天使用过的各 cache-adapter-matched 模型详细统计。 |
| `/cache-optimizer stats all` | 显示所有有效本地 session/shard 今天的逐模型详细总计，包括请求数与 token 数。 |
| `/cache-optimizer stats contributors` | 显示当前精确 provider/model 的当前/其他贡献 session，不暴露 session id。 |
| `/cache-optimizer reset` | 重置当前 provider/model 的本地 footer 统计；不会修改上游 provider 缓存。 |
| `/cache-optimizer config footer-mode total\|session\|process` | 持久设置 footer 统计模式；持久命令配置优先于环境变量。 |
| `/cache-optimizer fix` | 为当前模型自动修复安全的 compat 问题。展示预览 + 风险提示，需要用户确认；原生 compat 修复写 `models.json`，已观测到的 `prompt_cache_key` 问题写扩展配置。 |
| `/cache-optimizer fix prompt-cache` | 为当前模型写入 `promptCache` 缓存时长，让 Pi 原生保温生效。带预览、备份、receipt 和回滚。需要确认。 |
| `/cache-optimizer fix prompt-cache-key` | 明确把当前 OpenAI-compatible provider/model 配置为从最终请求体移除 `prompt_cache_key` 与 `promptCacheKey`。需要确认。 |
| `/cache-optimizer fix kimi-base-url` | 为使用 OpenAI Chat Completions 的模型（Pi 1.3.0+ `kimi-coding`）在官方 Kimi Code base URL（`api.kimi.com` / `api.kimi.ai`，路径 `/coding`）后补 `/v1`。带预览、备份、receipt 和回滚。需要确认。 |
| `/cache-optimizer rollback` | 查看最近一次匹配的已确认修复；经 UI 确认后安全恢复扩展配置或 `models.json` 修复。 |

`/cache-optimizer` 使用 Pi 原生 Tab 补全：输入 `/cache-optimizer <Tab>` 查看支持的子命令，输入 `/cache-optimizer stats <Tab>` 补全 `all` 或 `contributors`，输入 `/cache-optimizer fix <Tab>` 补全 `prompt-cache`、`prompt-cache-key` 或 `kimi-base-url`，输入 `/cache-optimizer c<Tab>` 补全 `config`，输入 `/cache-optimizer config <Tab>` 补全 `footer-mode`，输入 `/cache-optimizer config footer-mode <Tab>` 补全 `total`、`session` 或 `process`。建议会按当前前缀过滤；无效前缀返回空结果，由 Pi 正常回退处理。

交互式 `/cache-optimizer` 菜单包含 `Footer mode`，可以选择 `total`、`session` 或 `process`。`enable` / `disable` 是当前进程内开关。若要持久关闭某些能力，请使用下面的环境变量。

Doctor 显示的 endpoint URL 会移除用户名/密码、查询参数和 fragment。无效 URL 显示为不可用；实际 transport URL 不会被修改。

## 持久 Opt-out

| 环境变量 | 作用 |
|---|---|
| `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` | 只关闭 prompt 改写；footer 统计和 cache-key fallback 仍启用。 |
| `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` | 显式允许原生 virtual prompt 改写，但仅当 routing registry 暴露的候选链不包含 Responses/Codex 时生效。路由未知或信息不完整时仍保持原 prompt。 |
| `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` | 保留 Pi 原始 verbose skill XML。 |
| `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | 关闭 OpenAI-compatible `prompt_cache_key` fallback。推荐使用这个显式 opt-out。 |
| `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` | 通过旧的反向开关关闭同一个 fallback。取值 `0`、`false`、`no`、`off` 时关闭。 |
| `PI_CACHE_OPTIMIZER_STATS_INCREMENTAL=0` | 增量 footer 刷新的 kill switch（见 [Footer 刷新（2.10）](#footer-刷新210)）：每次刷新重新 stat 全部 shard 文件，与 2.9.3 相同。取值 `0`、`false`、`no`、`off` 时关闭。 |
| `PI_CACHE_OPTIMIZER_STATS_TIMING=1` | 开启 footer 刷新计时日志（JSON lines，写到 agent 目录下的 `pi-cache-optimizer-stats-timing.jsonl`；取值为绝对路径时写到该路径）。默认关闭。 |
| `PI_CACHE_OPTIMIZER_STATS_VERIFY=1` | 开启校验：每次后台全扫之后，检查有没有 shard 文件内容变了、文件身份（inode、大小、时间戳）却没变。没有 inode、时间戳精度又粗的文件系统（FAT、部分 SMB 服务器）会出现这种情况。发现的文件会被重新读取；出现两次后提示一次改用 kill switch。默认关闭。 |

持久化 feature 配置由 Pi agent 目录中的原生命令管理，并且优先于对应环境变量，包括上面的两个 OpenAI cache-key 开关。运行时 `disable` 仍会抑制优化，不受持久配置影响：

```text
/cache-optimizer config prompt-rewrite on|off
/cache-optimizer config virtual-rewrite on|off
/cache-optimizer config skill-compression on|off
/cache-optimizer config openai-cache-key on|off
/cache-optimizer config tool-order on|off
/cache-optimizer config stats-incremental on|off
/cache-optimizer config footer-mode total|session|process
/cache-optimizer config reset
```

对于 `openai-codex-responses`，即使开启 skill compression，也会保留 Pi 原生 skill index。真实 `openai-codex/gpt-6-luna` 任务级 benchmark 表明，较短的 Markdown skill index 虽然减少了单次 prompt，但可能增加模型的工具调用轨迹和最终任务总成本；因此 Codex 保留 Pi 原生 XML skill 列表，同时继续使用本扩展的其他缓存与运行时优化。

`config reset` 在共享事务锁内读取最新磁盘配置，只移除持久化 feature 覆盖，保留最新 footer mode、按模型配置的 prompt-cache-key 设置和文件权限。JSON/schema 无效、symlink、非普通文件或并发手动修改时会拒绝覆盖。这些命令不会修改 shell 启动文件或 `PI_CACHE_RETENTION`；`enable` 和 `disable` 仍然是当前进程的运行时开关。

## Opt-in 确定性工具排序

`PI_CACHE_OPTIMIZER_TOOL_ORDER=1` 会对 Pi 内置 OpenAI Completions、Anthropic、Google 与 Bedrock payload 中已验证的工具定义进行确定性排序。Truthy 取值为（不区分大小写）`1`、`true`、`yes` 或 `on`。该能力默认关闭、仅在当前进程生效，并会被 `/cache-optimizer disable` 抑制。

工具按精确名称排序，并用原始 index 作为稳定的同名 tie-breaker。排序只对发生变化的已验证对象/数组路径做浅 clone。工具对象和无关请求字段保持原引用，包括 Google/Vertex 的 `AbortSignal`；工具 schema、tool choice、routing 字段和调用方输入都保持不变。

出于安全考虑，只要工具存在顶层 `cache_control` marker，或 Anthropic payload 包含 `defer_loading` 分组，payload 就保持不变。未知 / 自定义 API、畸形工具、缺少名称或不支持的 shape 同样保持不变。纯 helper 可识别 OpenAI Responses fixture，但 request hook 保留既有 Responses/Codex bypass，不会重排这些请求。

回滚很简单：删除变量或设为非 truthy 值，然后运行 `/reload`。如需使用本地 fixture 验证转换、且不连接 provider，可运行：

```bash
bun .trellis/tasks/09-03-context-epoch-tool-ordering/verify.ts
```

该 verifier 只报告数字形式的工具排序变化，并确认带 cache marker 的 payload 不会变化。由于它不会连接 provider，provider cache usage 会明确报告为 unavailable，也不会虚构 cache hit。

## Footer 刷新（2.10）

2.10 之前，每次 footer 刷新都要 stat 每一个原始 shard 文件（忙碌的一天约 400 个），而且 Pi 在每次工具调用、每条 assistant 消息和每次 settle 之后都要等它完成。在 Windows 上，杀毒软件扫描让每次 stat 都很贵，一次刷新约 28 ms，直接压在 agent 循环的关键路径上。自 2.10 起：

- **Pi 不再等待。** `tool_execution_end`、`agent_settled`、`message_end` 之后的刷新改在后台进行（用量仍先同步记入内存）。同一时刻最多只有一个刷新在跑；期间到来的请求共享一个在它之后开始的后续刷新，所以拿到的结果不会早于请求时刻。命令（`stats`、`doctor`、`reset` 等）、`session_shutdown` 和切换模型仍然等待一次新鲜的刷新；shutdown 会先等后台刷新结束再做最后一次写入，所以 print 模式不会在刷新中途退出。
- **文件操作更少。** 每次刷新列一次 shard 目录（新增和删除的 shard 立刻可见），只 stat 新文件和"热"集合：active shard、最近 15 分钟内更新过的 shard，以及 TUI watcher 报告有变化的文件。文件只有变了才重新读取。本进程自己的 shard 从不读回（内存里的副本更新）。在基准夹具上（约 400 个原始 shard，每次文件操作 0.2 ms），一次刷新从约 410 次文件操作、29 ms 降到约 18 次（2 次列目录、10 个 active shard 的 stat、6 次 epoch 读取）、3 ms 以内。
- **陈旧上限。** 已关闭的 shard 只会被它所属的进程改写：该进程用同一个 shard 开始另一个 session 时（Pi 在 `/new`、`/resume`、fork 之间沿用同一个 extension：shutdown 把 shard 关闭，下一个 session 又把它写回 active）。如果很快发生，15 分钟窗口能覆盖；关闭超过 15 分钟的 shard 只在有刷新发生时由后台全扫复查，最多每 30 秒一次（同时最多 2 个文件操作）。所以这类文件的变化（包括这种较晚的重新激活）最迟约 30 秒加一次全扫的时间后反映到 footer。active 和最近更新的 shard（所有活着的进程的）、新增和删除的 shard、reset epoch 以及本进程自己的用量都不会陈旧。命令和 shutdown 的 flush 始终 stat 全部文件。
- **数字不变。** 每次刷新都用与以前相同的聚合，对缓存的 shard 做完整的重新聚合，所以总数与对同一批文件做全量扫描完全相同。reset epoch 每次刷新并行读取一次，慢的读取不能再把较新的 epoch 改回去。epoch 文件在 Windows 上的读取错误（另一个进程 reset 时的 `EPERM`/`EBUSY`）不再被当作"从未 reset"；2.10 之前它可能清掉本进程尚未落盘的用量。磁盘格式、文件名和写入协议都不变，2.8.x/2.9.x 进程可以共用同一目录。
- **Archive。** 新的 archive generation 仍然只解析一次；为 footer 做的归约现在只覆盖当前 session（不再为每个 bucket 拼接键字符串），2 MB 的 archive 主线程耗时约减少四分之一（JSON 解析本身仍在）。未变化的 generation 只凭目录列表确认，但每次命令和 flush、以及至少每 30 秒仍会核对一次它的文件身份（archive 目录被删除重建时，generation 编号会被重复使用）。2.9.0 的 `archive.json`、仍在原地写入的 generation 和不可读的最新 generation，照旧每次刷新都核对。
- **Watcher。** TUI 的 shard watcher 现在有 `error` 监听（Windows 上删除被监视的目录曾让 Pi 崩溃），在后台 restore 之后才创建（以前启动时目录还不存在，整个进程都没有 watcher），只把变化的文件标记给下一次刷新，忽略本进程自己的写入，并在 shutdown 和 reload 时关闭。

Kill switch：`/cache-optimizer config stats-incremental off` 或 `PI_CACHE_OPTIMIZER_STATS_INCREMENTAL=0` 让每次刷新重新 stat 全部 shard 文件（后台刷新和其他修复保留）；和其他功能设置一样，持久化配置优先于环境变量。注意：2.10 之前的版本不认识这个配置键，设置后会忽略整个配置文件（回到默认值），如果同一 agent 目录下还会运行旧版本，请优先使用环境变量。`PI_CACHE_OPTIMIZER_STATS_TIMING=1` 记录每次刷新的分阶段耗时、热集合大小和文件数；`PI_CACHE_OPTIMIZER_STATS_VERIFY=1` 检查刷新所依赖的文件身份在你的文件系统上是否可靠。

## Footer 缓存统计模式

当前版本把统计保存在 Pi agent 目录的 `pi-cache-optimizer-stats.d/shards/` 下。每个已加载的 extension instance 独占一个当天的活跃 UUID shard，并通过临时文件 + 原子 rename 写入；本地日期切换时关闭旧 shard、创建新的 UUID，保留 session 历史，因此父/子/并行 Pi 进程不会互相覆盖。旧 v6 单文件统计在升级时直接删除，本地 footer 计数从零开始；不会影响上游 provider 的实际缓存。

从 2.9.0 起，维护任务会把已关闭的往日 shard，以及进程已退出超过 24 小时的活跃 shard，合并进 `pi-cache-optimizer-stats.d/archive/` 下的一份归档快照，再删除原文件。维护最多每 6 小时一次，在共享维护锁下后台运行。某一天只有在所有时区都已结束后（该日 UTC 零点之后 36 小时）才会被归档，所以运行在其他时区的 Pi 进程看到的当天计数不会因此变化；午夜之后、日切换之前记下的用量所在的 shard 保持原样不归档。这样 shard 目录里基本只剩最近两天的 shard，启动和刷新的开销不再随 60 天保留期增长。归档计数保留 reset epoch，`reset` 立即生效，并按同样的 60 天窗口过期。归档会记录已吸收的 shard，所以合并中途崩溃也不会重复计数。旧版本不会读取归档：如果降级或与旧版本同时运行，旧版的 `session` footer 只显示尚未归档的历史；当天的 `total` 和 `process` 计数不受影响。

2.9.0 之后的版本把每份快照保存为不可变的紧凑代号文件 `archive/archive.<generation>.json`，大小约为 2.9.0 单个 `archive.json` 的五分之一。压缩读到第 N 代后，只有在期间没有别人发布过的情况下才能发布第 N+1 代（用独占的硬链接实现，在 Windows 和 POSIX 上都是原子的），而且只有自己发布的代号仍是最新时才删除原始 shard；压缩运行期间还会刷新维护锁的时间戳。因此，一个停顿超过锁过期时间的进程（比如笔记本休眠）醒来后，再也不会覆盖更新的归档、造成计数丢失。读取端使用最新的代号，上一代保留到下一次发布。2.9.0 的 `archive.json` 仍然会被读取，下一次压缩会迁移它，并用一个同名目录取而代之。仍在运行的 2.9.0 进程随后会把归档视为不可读：它不再压缩或删除任何文件，它的 `session` footer 只显示尚未归档的历史，与上面所说一致。如果迁移之后 2.9.0 又写出了 `archive.json`（只有在这个目录被删除时才可能），为了杜绝重复计数，这个文件永远不会被计入，而是改名为 `archive.legacy-<time>.json` 留存，那个进程归档进去的 shard 将不会出现在 footer 里。2.9.1 之后的版本中，迁移会先把 `archive.json` 移到一旁（`archive.migrating-<id>.json`），用目录占住原位置，并在链接第一代之前核对移走的文件就是自己读到的那一份。因此，如果期间有 2.9.0 进程重新写了这个文件，下一次压缩会迁移它，而不是把它隔离；如果迁移在这一步被中断，之后会从这个占位文件继续完成。

2.9.1 之后的版本中，归档读不出来时会自行恢复，而不是永久停止压缩：读取端会跳过损坏或被截断的代号，改用上一代。每一代只覆盖它记录为已吸收的原始 shard，所以回退不会重复计数，缺少的只是那一代已经归档并删除的部分。下一次压缩会在它之上发布新的一代，并把它保留为 `archive.<generation>.corrupt-<time>.json`，同时给出警告。读不出的 2.9.0 `archive.json` 会被改名为 `archive.legacy-<time>.json`，归档从原始 shard 重新开始。更新版本格式写出的归档永远不会被跳过或覆盖。在不支持硬链接的文件系统（FAT/exFAT、部分网络盘）上，新的一代以独占方式直接创建并落盘，写完整之后才会被计入。压缩出错时，约 10 分钟后重试，而不是等 6 小时。瞬时读错误（比如 Windows 上杀毒软件占用文件）会短暂重试；如果一直失败，这次刷新沿用上一次一致的快照。

即使等待响应时切换到同一 provider 的另一个模型，响应统计仍归属于实际请求的 catalog/request-local 模型。旧 transport 的响应别名只根据请求快照处理，不使用新选择的模型；footer 继续显示当前选择的 direct 模型。损坏 JSON/schema 的旧 shard 按文件修改时间在两个月后清理；较新的损坏文件、有效的当天 shard、仍存活的旧 instance 和 symlink 目标均受保护。

Footer 默认使用 `session`，避免另一个并行 Pi 终端使用相同 provider/model 时污染当前窗口。可以通过命令或环境变量切换显示范围：

| 值 | 作用 |
|---|---|
| `session`（默认） | 聚合所有携带当前 hashed Pi conversation session id 且精确 provider/model 相同的保留 shard，跨越本地日期仍会累计。Extension reload 会产生新 instance shard，但仍属于同一长期 session 范围。 |
| `total` | 聚合当前本地日期同一精确 provider/model 的全部有效本地 shard，包括加载本扩展并共享同一 agent 目录的子 Pi agent。 |
| `process` | 仅显示当前 extension instance 当天采集的统计。本地日期切换、Pi 重启或 extension reload 后从 `0/0` 开始。 |

持久命令配置优先于环境变量：

```text
/cache-optimizer config footer-mode total
/cache-optimizer config footer-mode session
/cache-optimizer config footer-mode process
```

显式设置保存在 Pi agent 目录下的 `pi-cache-optimizer-config.json`。没有命令覆盖时，读取 `PI_CACHE_OPTIMIZER_FOOTER_MODE=total|session|process`；值不区分大小写，缺失或非法值均回退到 `session`。如需让已有安装重新由环境变量控制，请手动删除 `pi-cache-optimizer-config.json`，然后运行 `/reload`。

## 按模型关闭 `prompt_cache_key`

某些 OpenAI-compatible Completions endpoint 会因 `prompt_cache_key` 返回 HTTP 400，但同一个字段对其他 provider 可能有效。Pi 1.0+ 已负责 Responses/Codex transport 的 key；本扩展的 fallback 和 opt-out 只作用于 `openai-completions`。Pi 1.0.3 没有原生的 `supportsPromptCacheKey` compat 字段，**不要**把这个未知字段加入 `models.json`。`supportsLongCacheRetention` 也不是等价开关，不应借用来实现此目的。

当扩展观察到精确 provider/model 对 `prompt_cache_key` 的明确字段级拒绝后（包括 `未知请求字段：prompt_cache_key` 这类已识别的中文错误），普通 `/cache-optimizer fix` 会提供经过确认的模型级修复。参数值校验失败，以及“设置 temperature 时不允许”这类条件限制都不构成证据。若不同模型的响应并发交错，而 Pi 又没有提供 request ID，扩展会忽略无法安全关联的 response-header 证据；只有最终 assistant message 提供精确 provider/model 身份时才恢复归因。如果你已经确定 endpoint 不支持该字段，可以主动执行：

```text
/cache-optimizer fix prompt-cache-key
```

预览会说明设置保存在扩展自有的 `pi-cache-optimizer-config.json` 中。确认后，`before_provider_request` 的最终阶段会移除 `prompt_cache_key` 和 `promptCacheKey`，包括 Pi core 之前已经放入的 key。这个精确模型可能因此失去 provider prompt-cache 命中，其他模型仍保持原有 fallback 行为。配置通过原子、不可覆盖并发新建文件的方式写入，并生成不含敏感内容的备份/receipt；需要 `/reload` 或重启 Pi。`/cache-optimizer rollback` 可恢复之前的扩展配置且不会重置 `footerMode`；它会绑定预览时 receipt 的文件身份和 hash，在 receipt 被替换时拒绝操作，并在 receipt 状态写入失败时补偿恢复配置。

## OpenAI-compatible 代理配置

LiteLLM / OneAPI / NewAPI / 类 OpenRouter 渠道等第三方 `openai-completions` 代理，常会把同一个 session 分散到多个上游后端，导致 provider 侧 prompt cache 被拆散。

Pi 0.84.1 还修复了内置 Fireworks 渠道对拒绝 `prompt_cache_retention` 的模型兼容性；本扩展不按 provider 名称增加特殊分支，而是结合 `models.json` 与 runtime model，按精确 provider/model 解析有效 compat。Pi 0.81+ 也内置了使用 OpenAI-shaped transport 的 `llama.cpp` provider。本扩展只对第三方 `openai-completions` 保留 session-id key fallback；Pi 1.0+ 已负责 Responses/Codex transport 的 key。只有符合 Pi 内置 provider 明确 compat 指纹的模型会跳过通用 proxy 路由 / session-affinity 建议；仅复用 `llama.cpp` id 的自定义或覆盖 provider 仍按普通 OpenAI-compatible 渠道处理。`prompt_cache_retention` 遵循统一安全规则：扩展只撤销自己设置 `PI_CACHE_RETENTION=long` 带来的副作用。依次判断：本进程内该模型已明确拒绝过该参数 → 移除；官方 OpenAI → 保留；显式 `supportsLongCacheRetention: true`（来自 `models.json`，或 provider 扩展注册的 runtime model；`models.json` 中显式 `false` 仍优先）→ 保留；用户在 Pi 启动前自行设置了 `PI_CACHE_RETENTION=long` → 保留；其余情况发送前移除。Azure OpenAI 不在白名单中，因为其长缓存支持取决于具体部署的模型。`/cache-optimizer doctor` 会显示最近一次判断及原因。Pi 1.0.3 没有原生的 `supportsPromptCacheKey` compat 字段，因此仅对 `openai-completions` 按模型关闭 key 的策略保存在本扩展的 `pi-cache-optimizer-config.json` 中，而不是 `models.json`。扩展配置独立于 Pi 的 compat 优先级，只影响其中列出的精确 provider/model。

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
- 不要把 `supportsPromptCacheKey` 加入 `models.json`：Pi 1.0.3 没有定义这个 compat 字段。请使用 `/cache-optimizer fix prompt-cache-key` 在扩展自有配置中保存精确 provider/model 的 omit 规则；它会移除两种 key 写法，包括 Pi 提供的 key。
- 如果出现 `400 Unsupported parameter: prompt_cache_retention`，请为该渠道移除 / 避免 `supportsLongCacheRetention`；如支持，可保留 `sendSessionAffinityHeaders`。扩展会从响应头或最终 assistant error message 中识别这条明确错误，并在当前进程的后续请求中移除该参数。
- 使用 `/cache-optimizer compat` 或 `/cache-optimizer doctor` 查看当前模型的具体建议。
- 如果修改 `models.json` 后 compat 警告仍反复出现，请检查拼写：Pi 会忽略未知 key，`model0verrides`、`sendSessionAfinityHeaders` 这类拼错的 key 很可能不会生效。警告、`doctor` 和 `fix` 会指出疑似拼错的已知 Pi key（仅提示，不会自动改名）。
- DeepSeek 模型名只用于选择 `DS cache` adapter，不能证明 reasoning wire protocol。缺少或使用非 DeepSeek format 时仍保留通用缓存 / 路由建议；只有 effective `compat.thinkingFormat: "deepseek"` 被明确配置时，才显示 DeepSeek replay 建议，且不会把 `thinkingFormat` 列为缺失修复项。
- 不要因为模型 id 含有 `deepseek` 就添加 `thinkingFormat: "deepseek"`；catalog 中也存在 `openai`、`qwen`、`openrouter`、`together` 或没有显式 format 的情况。
- 本扩展的 `doctor` 和 `compat` 命令只给建议，不会修改 `models.json`。

## Prompt cache 保温（Pi 0.86+）

Pi 自带缓存保温：在缓存条目过期前，用一个 token 的输出上限原样重放上一次请求（全局设置 `cacheWarming`：`off`、`streaming`（默认）或 `idle`；在 `/settings` → Cache warming 中修改，或在 `~/.pi/agent/settings.json` 中设置 `"cacheWarming"`）。本扩展不自行运行保活定时器：第二个保温器会重复计费，而且无法精确重放 Pi 的请求。

Pi 只会为满足以下条件的模型保温：为当前保留档位声明了缓存时长、有输入/缓存价格、请求可重放（Anthropic 基于 budget 的 thinking 不可重放）。`models.json` 里的自定义代理模型常常缺前两项，保温根本不会启动。对价格全为 0 的模型，Pi 会以 “cache economics unavailable” 停止保温；本扩展仅在这种情况下通过 `cache_warming_decision` 返回 `warm`，因为一次刷新只是一次缓存读取加一个输出 token。有真实价格的模型仍按 Pi 自己的判断，Pi 的模式、缓存时长、可重放性和时间上限也照常生效。每次刷新都是一次真实请求，若渠道价格写 0 但实际计费，会产生费用。刷新间隔里 Pi 的 `/session` 仍会显示 “cache economics unavailable”；若其他扩展也处理 `cache_warming_decision`，以 Pi 最后执行的那个为准。有两种 0 不算免费：OpenRouter 路由模型（ID 以 `openrouter/` 开头，如 `openrouter/auto`），其 -1 占位价格在 Pi 1.2.0+ 显示为 0，但实际按路由到的模型计费；以及 Pi 1.2.0 `cost.tiers` 中有正价格的模型。可用 `/cache-optimizer config zero-price-warming off` 或 `PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING=1` 关闭。`/cache-optimizer doctor` 现在会显示保温模式、档位和缺失项，并给出片段，例如 `anthropic-messages` 模型的 `"promptCache": {"short":300,"long":3600}`。自定义模型写在该模型条目中，内置模型写在 provider 的 `modelOverrides` 下；也可以运行 `/cache-optimizer fix prompt-cache` 一键写入：先预览、需确认、保留带时间戳的备份和注释，并记录 receipt，`/cache-optimizer rollback` 只会删除这次加入的 `promptCache` 对象（若文件之后没有改动则整文件恢复）。`anthropic-messages` 模型写入 `{"short":300,"long":3600}`（Anthropic 文档的 5 分钟/1 小时，与 Pi 内置 Claude 模型一致），其他 API 写入 `{"short":300}`；若当前使用长档位而该 API 没有文档化的长时长，则拒绝写入而不是猜测。已有 `promptCache` 时不会合并或覆盖，models.json 中不存在的 provider 条目也不会被创建。

streaming 保温在真实请求后 60 分钟停止，idle 保温在 30 分钟后停止。本扩展使用 1 小时保留时，刷新会在第 54 分钟才触发，所以 `idle` 没有额外作用；1 小时的缓存本身已覆盖一小时内的中断。除非你使用 5 分钟缓存且经常在半小时内回来，否则保持默认的 `streaming` 即可。

## Anthropic 缓存 TTL 兼容

Anthropic 按 `tools → system → messages` 顺序处理 cache breakpoint，并拒绝位于 5 分钟 breakpoint 之后的 `ttl: "1h"` breakpoint。省略 `ttl` 的 ephemeral `cache_control` 使用默认 5 分钟保留时间。

对于所有 `anthropic-messages` 渠道，本扩展都会检查最终序列化 payload，并立即降级可见的非法短 TTL → 长 TTL 顺序。合法的纯 `1h` 和 `1h → 5m` payload 保持不变，包括真正支持 1 小时保留的第三方 endpoint。

部分代理会在 Pi request hook 之后重写或插入隐藏的 5 分钟 breakpoint。如果 provider 返回 Anthropic 明确的 TTL 顺序错误，本扩展会记录当前进程内的 provider/model fallback，使下一次后续请求使用默认 5 分钟 TTL。Pi 0.82.1 将此错误视为不可自动重试的 HTTP 400，因此扩展不会声称 Pi 会自动重跑失败 turn；如果其它层发起重试，该重试也会使用 fallback。`/cache-optimizer doctor` 会显示该 fallback，`/cache-optimizer fix` 可通过现有确认/备份流程，以 model level 持久写入 `supportsLongCacheRetention: false`。其它 400 和 prompt-too-long 错误不会触发该 fallback。运行时观测会持续到当前进程退出，并会在同一进程内的扩展 reload 后保留。

## Adaptive thinking 模型

Claude 从 opus-4.6 / sonnet-4.6（含 Opus 5、Sonnet 5）/ fable-5 / haiku-5（Haiku 5.5，Pi 1.1.0+）开始需要在 compat 中设置 `forceAdaptiveThinking: true`。Kimi Coding K3（`k3`）和 `kimi-for-coding` 也使用 adaptive thinking，并需要 `allowEmptySignature: true`，以正确重放空 signature 的 thinking block。缺少这些 compat 时，Pi 可能发送旧版 thinking payload 或错误重放 thinking。Pi 0.83+ 的原生 Opus 5 catalog 已覆盖在同一 adaptive-thinking 检测中；如果自定义 `anthropic-messages` 渠道没有继承该 compat，仍需手动设置。

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

**Pi 1.3.0+：** 内置 `kimi-coding` 改用 OpenAI Chat Completions（`openai-completions`），地址为 `https://api.kimi.com/coding/v1`（海外：`https://api.kimi.ai/coding/v1`），compat 由 Pi 自带（`thinkingFormat: "openai"`、`reasoning_content` 回传）。因此上面的 K3 adaptive compat 只适用于旧版 Pi，或仍声明 `anthropic-messages` 的自定义渠道。官方 Kimi Code 地址是源站而不是代理，doctor/compat/fix 不再对它提示缺 `sendSessionAffinityHeaders`；经第三方中转访问 Kimi 时仍照常检查。Anthropic 时代留下的 `baseUrl` 覆盖（`https://api.kimi.com/coding`，缺 `/v1`）会让所有 Chat Completions 请求失败：doctor 会报告，`/cache-optimizer fix kimi-base-url`（或直接 `fix`）会补上 `/v1`，带预览、备份、receipt 和回滚。只处理官方域名、路径恰为 `/coding`、且模型实际使用 `openai-completions` 的情况；代理、其他路径和 Anthropic 协议条目只提示，不会修改。provider 级 `baseUrl` 若同时被其他 API 的自定义或内置模型继承（例如 Pi < 1.3.0 的 `anthropic-messages` 内置模型），则拒绝修改；请改在该模型条目上设置 `baseUrl`。

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
2. 发起一次普通请求。如果 OpenAI-compatible 的 DeepSeek-like 模型明确拒绝 `thinking` 并要求使用 `reasoning_effort`（包括已识别的中文拒绝和建议文本），扩展只在当前进程保留 model-scoped 分类，不会持久化或显示完整错误，不会发送隐藏探测请求，也不会在 response hook 中自动修改配置。
3. 再次运行 `/cache-optimizer fix`，查看基于证据的 model-level 协议修复；该修复写入最高优先级的 `modelOverrides[modelId].compat`，并结合 runtime compat 自检，避免 extension-provided model 静默遮挡。不会仅凭共享 provider 或模型名字扩大修改范围，显式 `openai`、`qwen`、`openrouter`、`together` format 会被尊重。
4. 如果最近一次已确认修复导致问题，运行 `/cache-optimizer rollback`；回滚始终需要 UI 确认。

每次成功的交互式 fix 都会以原子方式写入版本化 receipt：`pi-cache-optimizer-fix-receipt.json`。它只包含 transaction id、provider/model identity、placement、发生变化的 scalar compat key 及 before/after 值、文件 hash、备份文件名和时间戳/status。不会保存 API key、credential、prompt、payload、header、response body 或原始错误。

Rollback 会创建新的、保留访问权限的备份并使用原子替换。如果 `models.json` 自 fix 后未变化，且 receipt 备份匹配 pre-fix hash，则可恢复完整 pre-fix 文件。如果文件发生变化，只会在 receipt-owned scalar key 仍等于记录的 post-fix 值时撤销该 key，并保留其它用户修改；否则安全拒绝并指向记录的备份供手动检查。验证后 receipt 会标记为已回滚，需要 `/reload` 或重启 Pi。

## Footer 统计

统计是只读本地计数，保存在 Pi agent 目录的 UUID shard（`pi-cache-optimizer-stats.d/shards/`；自定义 agent 目录使用 `PI_CODING_AGENT_DIR`）。Shard 只包含日期、opaque session hash、精确 provider/model 计数、reset epoch 和进程生命周期元数据，不包含 API key、prompt、payload、headers、响应或模型输出。Footer 默认显示当前 conversation session，并跨本地日期累计该 session；`total` 只聚合当前本地日期的同一精确 provider/model shard，`process` 只显示当前 extension instance。旧 v6 共享统计文件升级时直接删除，不迁移旧计数。

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
- 虚拟选择默认不做 prompt 改写：Pi 在构建 system prompt 之后才决定物理模型，改写后的 prompt 不应被送到后端未知的路由。只有设置 `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` 且 routing registry 暴露完整候选链、所有候选都是已知的非 Responses / 非 Codex transport 时，才允许改写；路由未知或信息不完整时仍保持原 prompt。
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

最终 message metadata 足以支持响应后的统计。若要支持响应前流程——首次响应前的 footer 显示、`/cache-optimizer doctor`、`/cache-optimizer compat`、`/cache-optimizer reset` 和 `openai-completions` 的 `prompt_cache_key` fallback——请在 `Symbol.for("pi.routing.registry.v1")` 下注册 live route adapter。

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

## 可选：查看缓存统计

安装后不需要再做任何验证步骤，正常使用即可。如果希望查看 provider 实际报告的缓存情况，可以观察 footer，或运行 `/cache-optimizer stats`；排查第三方代理配置时可使用 `/cache-optimizer doctor`。

仓库中的 `benchmarks/` 仅用于维护者做基准测试、A/B 实验和研究验证。它们不会进入发布包，也不是普通用户正常使用本扩展所需要的步骤。

## License

MIT
