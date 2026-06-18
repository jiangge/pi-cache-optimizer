# PR Reply Drafts — Ready to Post

## 📝 PR #2 (jiangge/pi-cache-optimizer#2)

```
Thanks for this PR and the companion auto-router PR — the problem is real (pi-cache-optimizer can't see through virtual-provider routing extensions), and I appreciate the zero-coupling intent behind the `globalThis` convention.

However, after verifying the implementation against pi 0.79.1 source, I've decided not to take the bridge-protocol approach. Three technical findings, then the architectural reasoning:

**1. The prompt passthrough is unnecessary — and the consumer side double-injects.**
pi-ai's `Context` already carries `systemPrompt` (pi-ai `types.d.ts:245`). Whatever this extension returns from `before_agent_start` is written to `agent.state.systemPrompt` (agent-session.js:811) and arrives inside the `context` that auto-router's `streamSimple` receives. So `__piCacheOptimizerPrompt__` duplicates data that's already in-band — and on the auto-router side (PR #3), `sanitizeContext` unconditionally *prepends* it as a system message without removing the existing one, producing a **double system prompt**, which breaks the very prefix-cache stability this extension exists to protect. It also leaves the full system prompt readable by any extension via `globalThis`, with no cleanup on model switch.

**2. The cache-key passthrough doesn't take effect.**
PR #3 sets `innerOpts.prompt_cache_key`, but pi-ai derives `prompt_cache_key` from **`options.sessionId`** (openai-completions.js:394-396), and session-affinity headers likewise come from `options.sessionId` (sdk.js:195). pi core already injects `sessionId` into stream options (sdk.js:216). A router that simply preserves `options` when forwarding gets correct cache keys for free — no bridge needed.

**3. `resolveEffectiveModel` keeps the virtual model's `name`.**
Adapter selection here is id+name token based. A route named e.g. "DeepSeek Smart Route" that currently routes to Claude would select the wrong adapter. The `name` must be replaced along with `provider`/`id`. Also, `isAutoRouterModel` hard-codes `provider === "auto-router"`, which contradicts the PR's stated goal of a generic opt-in protocol.

**Architectural decision:** rather than patching these, I'm taking a different integration model that makes the bridge unnecessary: a transparent two-tier router extension (**pi-router**) that registers mirror entries with **real model ids/names/compat** (`router/claude-opus-4-8`) and forwards via pi-ai `streamSimple` with `options` preserved — channels first by default, with an opt-in cross-model fallback chain for exhaustion/overflow cases. With real identity end-to-end, adapter selection, footer stats, compat warnings, prompt optimization, and cache keys all work with **zero changes and zero protocol** in this repo.

For auto-router itself, the same principle would help: a "transparent mode" where a route whose targets share one model id exposes that real id directly (instead of a virtual route name), plus preserving `options.sessionId` when forwarding, would make it compatible with this extension out of the box.

Closing this PR for the reasons above — but genuinely, thank you for the thorough work here; the investigation surfaced real bugs and directly shaped the pi-router design. Happy to collaborate on pi-router if you're interested.
```

---

## 📝 PR #3 (danialranjha/pi-auto-router#3)

```
Author of pi-cache-optimizer here (this PR's companion, jiangge/pi-cache-optimizer#2, targets my repo — I've replied there with the full analysis). Two findings in this PR are **independent of whether the integration lands**, so flagging them separately:

**1. Double system prompt in `sanitizeContext`.**
pi-ai's `Context` already carries `systemPrompt` (types.d.ts:245) — pi core writes the (possibly extension-optimized) prompt into `agent.state.systemPrompt` before calling `streamSimple`, so the forwarded context already contains it. Prepending `{role:"system"}` on top of the existing `context.systemPrompt` sends the prompt twice, which hurts prefix caching and wastes tokens. The `__piCacheOptimizerPrompt__` passthrough can be dropped entirely.

**2. `prompt_cache_key` via stream options has no effect.**
pi-ai's OpenAI provider derives `prompt_cache_key` from **`options.sessionId`** (openai-completions.js:394-396), not from an `options.prompt_cache_key` field — and session-affinity headers also come from `options.sessionId` (pi sdk.js:195). Since pi core already injects `sessionId` into the options your `tryTarget` receives, simply preserving it in `{ ...options, apiKey: token }` (which the code already does) gives correct cache keys for free. The `__piCacheOptimizerCacheKey__` global can be dropped too.

Separately: the unrelated fixes here (preferSort null-latency, contextWindow registry fallback, configurable logDir) look genuinely useful — they might land faster split into their own PR, especially since this one also deletes `package-lock.json` (-409 lines), which is likely unintended.

FYI, I'm building the integration on a different model — a transparent two-tier router (pi-router) that mirrors real model ids so no cross-extension protocol is needed (analysis in jiangge/pi-cache-optimizer#2). A potential "transparent mode" in auto-router (route exposes the real model id when all targets share one model) would achieve the same compatibility natively.
```

---

## ✅ Ready to post

两份回复都已更新专名为 `pi-router`，技术依据和文件:行号引用完整。语气保持"感谢 + 技术事实 + 建设性出路"。

**你随时可以：**
1. 直接复制粘贴到对应 PR
2. 发完后告诉我一声，我把任务从 `planning` 转 `in_progress` 并进入实施（或你说继续等仓库建好）
