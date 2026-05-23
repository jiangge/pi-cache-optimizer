# Mainstream Model Cache Strategy Assessment

> Research document for task `05-21-investigate-pi-otokapi-gpt55-unavailable`.
> Covers all model families visible in opencode built-in models + user `models.json` providers.
> Evaluates pi-cache-optimizer coverage, gaps, risks, and recommended implementation priorities.

---

## 1. Model Landscape (from opencode 1.15.0 + Pi models.json)

### OpenCode built-in models (`opencode/` provider)

| Model ID | Family | Notes |
|---|---|---|
| `gpt-5.*` / `gpt-5.*-codex` / `gpt-5.*-mini` / `gpt-5.*-nano` | **OpenAI GPT** | OpenAI official (OpenCode Zen) |
| `claude-*` (haiku/opus/sonnet) | **Anthropic Claude** | via OpenCode Zen |
| `gemini-3-*` / `gemini-3.1-*` | **Google Gemini** | via OpenCode Zen |
| `deepseek-v4-flash-free` | **DeepSeek** | Free tier via OpenCode |
| `glm-5` / `glm-5.1` | **Zhipu GLM** | via OpenCode Zen |
| `kimi-k2.5` / `kimi-k2.6` | **Moonshot Kimi** | via OpenCode Zen |
| `minimax-m2.5` / `minimax-m2.7` | **MiniMax** | via OpenCode Zen |
| `qwen3.5-plus` / `qwen3.6-plus` | **Alibaba Qwen** | via OpenCode Zen |
| `nemotron-3-super-free` | **NVIDIA Nemotron** | Free tier |
| `big-pickle` | **OpenCode internal** | Test/dummy model |

### Pi custom providers (from `~/.pi/agent/models.json`)

| Provider | API type | Models | Covers |
|---|---|---|---|
| `deepseek` | openai-completions | deepseek-v4-pro, deepseek-v4-flash | ✓ DeepSeek |
| `aiapi` | openai-completions | deepseek-v4-pro, gpt-5.5, gpt-5.4, aws/claude-opus-4-6 | ✓ GPT, Claude, DeepSeek |
| `cafecode` | openai-completions | gpt-5.5, gpt5.4 | ✓ GPT |
| `otokapi` | openai-completions | gpt-5.5, gpt-5.4 | ✓ GPT |
| `tencent` | openai-completions | deepseek-v3, hunyuan-large, kimi-k2.5, minimax-m2.5, glm-5 | ✗ Hunyuan, Kimi, Minimax, GLM |
| `zhoumo` | openai-completions | deepseek-v4-pro, glm-5.1, kimi-k2.6 | ✗ GLM, Kimi |
| `yepapi` | openai-completions | gpt-5.4, claude-opus-*, deepseek-v3.2, gemini-2.5-pro, kimi-k2.5 | ✓ All 4 families |
| `lan` | anthropic-messages | claude-opus-4-7, claude-opus-4-6 | ✓ Claude (native) |
| `twofish` | anthropic-messages | claude-opus-4-7, claude-opus-4-6 | ✓ Claude (native) |
| `cry` | anthropic-messages | claude-opus-4-7, claude-opus-4-6 | ✓ Claude (native) |
| `yyds` | anthropic-messages | claude-opus-4-7 | ✓ Claude (native) |
| `kiro` | kiro-api (custom) | (Amazon Q / CodeWhisperer) | ⚠️ Custom transport, 0% cache |
| `oops`, `ice`, `0bug`, `letme-temp`, `muyuan`, `lin`, `xiaojimao` | openai-completions | gpt-5.5/gpt-5.4/various | ✓ GPT (proxy) |

---

## 2. Cache Strategy by Model Family

### 2.1 OpenAI GPT (`openai-completions` / `openai-responses`)

**Official cache mechanism**: `prompt_cache_key` (top-level body field, max 64 code points) + `prompt_cache_retention` (`"24h"` for long retention).

**Pi implementation**: 
- `openai-completions.js`: sends `prompt_cache_key = sessionId` when `api.openai.com` base URL OR `supportsLongCacheRetention` compat; sends `prompt_cache_retention = "24h"` when long + compat; sends `x-session-affinity` header when `sendSessionAffinityHeaders` compat.
- `openai-responses.js`: always sends `prompt_cache_key = sessionId` (unless retention=none); sends `prompt_cache_retention` based on compat.

**Coverage**: ✅ **Fully covered**. pi-cache-optimizer adds session-id `prompt_cache_key` fallback in `before_provider_request` hook when missing. Compat warnings fire for proxies missing `supportsLongCacheRetention` / `sendSessionAffinityHeaders`.

**Gap**: None for the cache-key injection path. The model detection (`gpt-`, `chatgpt`, `o[1345]`) covers all GPT models seen in opencode and user config.

### 2.2 Anthropic Claude (`anthropic-messages`)

**Official cache mechanism**: `cache_control` breakpoints on system prompt + tools + last user message. Fields: `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`.

**Pi implementation**:
- `anthropic.js`: auto-detects `cacheControlFormat: "anthropic"` compat; injects `cachePoint` markers in system prompt, tools, and last conversation message; sends `x-session-affinity` header; reads `cache_read_input_tokens` and `cache_creation_input_tokens` from stream events.

**Coverage**: ✅ **Fully covered** for native Anthropic API. Compat warning when Claude model uses `openai-completions` without `cacheControlFormat: "anthropic"`.

**Gap**: No `cache_control` injection for Claude models routed through `openai-completions` proxies (even with compat flag, Pi's `openai-completions` adapter does emit `cache_control` via `applyAnthropicCacheControl` when `cacheControlFormat: "anthropic"` compat is set — verified in code line 431-432). The warning nudges the user to set this flag.

### 2.3 Google Gemini / Vertex

**Official cache mechanism**: Implicit `cachedContentTokenCount` in `usageMetadata`. Explicit `cachedContents` API for persisting caches with TTL.

**Pi implementation**:
- `google.js` / `google-vertex.js`: reads `cachedContentTokenCount` from `usageMetadata`; normalizes to `cacheRead`. No explicit cache content creation.

**Coverage**: ✅ **Stats only**. No cache-control injection. This is correct: Gemini caches are automatic/implicit for repeated prefixes; explicit cache content management is a separate API resource.

**Gap**: Covering `gemini-` and `vertex-` model names matches all Gemini models including `gemini-3-flash`, `gemini-3.1-pro` (opencode) and `google/gemini-2.5-pro` (yepapi).

### 2.4 DeepSeek

**Official cache mechanism**: KV prefix caching. Fields: `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `prompt_tokens`. Compat flags: `thinkingFormat: "deepseek"`, `supportsLongCacheRetention`, `sendSessionAffinityHeaders`.

**Pi implementation**:
- `openai-completions.js`: DeepSeek models (detected by `thinkingFormat: "deepseek"` compat) get long retention, session-affinity headers, and session-id `prompt_cache_key`.

**Coverage**: ✅ **Fully covered**. Extension adds session-id fallback, compat warnings, and stats adapter.

**Gap**: None.

### 2.5 Moonshot Kimi (`kimi-*`)

**Official mechanism**: OpenAI-compatible API. Kimi supports prefix caching via OpenAI-compatible `prompt_cache_key` and session affinity headers when the proxy supports them.

**Pi detection**: Model id/name contains `kimi` — **not currently matched by any adapter**.

**Coverage**: ❌ **No adapter**. Falls through to no footer stats. Benefits from session-id `prompt_cache_key` injection ONLY if `isOpenAIFamilyModel()` returns true — which it does NOT for `kimi-*`. 

**Cache strategy**: Same as OpenAI-family (session-id based `prompt_cache_key`). But since `isOpenAIFamilyModel` is gated to `gpt-`/`chatgpt`/`o[1345]`, Kimi models get neither the cache-key fallback nor stats. The `before_provider_request` hook's first gate `!isOpenAIFamilyModel(ctx.model)` blocks the prompt_cache_key injection for Kimi.

**Risk**: The user's config has `tencent/kimi-k2.5` and `zhoumo/kimi-k2.6` — these get zero cache optimization from the extension. The prompt reordering still helps (it's applied before the provider request hook), but no session-id cache key is injected.

**Recommendation**: ⭐ **High priority** — add a dedicated Kimi adapter (or extend the cache key gate to also cover Kimi-family models through `openai-completions` API).

### 2.6 Alibaba Qwen (`qwen-*`)

**Official mechanism**: OpenAI-compatible API. Qwen supports prompt caching via `X-DashScope-SSE` or OpenAI-compatible `prompt_cache_key` depending on the endpoint.

**Pi detection**: Model id/name contains `qwen` — not currently matched.

**Coverage**: ❌ **No adapter**. Same gap as Kimi.

**Recommendation**: ⭐ **Medium priority** — Qwen models appear in opencode (`qwen3.5-plus`, `qwen3.6-plus`). Similar to Kimi, they use OpenAI-compatible transport and would benefit from session-id cache key injection.

### 2.7 Zhipu GLM (`glm-*`)

**Official mechanism**: OpenAI-compatible API. Zhipu supports prompt caching through its own API (`X-Zhipu-Cache`), but also works with standard OpenAI `prompt_cache_key` when routed through OpenAI-compatible proxies.

**Pi detection**: Model id/name contains `glm` — not currently matched.

**Coverage**: ❌ **No adapter**. Note: the user has many GLM model entries across providers (`zhoumo/glm-5.1`, `paolu-glm51/glm-5.1`, `tencent-coding-plan/glm-5`, `windhubcc/glm-5.1`, `cpameowooasia/glm-5.1`).

**Recommendation**: ⭐ **Medium priority** — many user models are GLM; missing cache optimization.

### 2.8 MiniMax (`minimax-*`)

**Official mechanism**: OpenAI-compatible API. MiniMax supports prompt caching through OpenAI-compatible layer.

**Pi detection**: Model id/name contains `minimax` — not currently matched.

**Coverage**: ❌ **No adapter**. Present in opencode (`minimax-m2.5`, `minimax-m2.7`, `minimax-m2.5-free`) and tencent provider.

**Recommendation**: 🟡 **Lower priority** — fewer user models, but still a gap.

### 2.9 Mistral (`mistral-*`)

**Official mechanism**: Uses `x-affinity` header for KV-cache reuse (prefix caching). Not the standard OpenAI `prompt_cache_key` model.

**Pi implementation**: Pi has a dedicated `mistral.js` provider that sends `x-affinity` header with session ID when available (see line 167 of mistral.js). The `usage.cacheRead/cacheWrite` fields are always set to 0 (Mistral doesn't expose cache token counts in the API).

**Coverage**: ❌ **No adapter** in pi-cache-optimizer. However, Mistral's cache doesn't expose readable token counts anyway, so a stats adapter would always show 0%.

**Recommendation**: 🟡 **Low priority** — Mistral cache is opaque (no fields to read), and Pi core already handles `x-affinity` header injection. No extension-level improvement possible.

### 2.10 xAI Grok (`grok-*`)

**Official mechanism**: OpenAI-compatible API. Grok exposes standard OpenAI usage fields including `prompt_tokens_details.cached_tokens`.

**Pi detection**: Model id/name contains `grok` — not currently matched.

**Coverage**: ❌ **No adapter**. Not currently in user models, but is a notable provider.

**Recommendation**: 🟡 **Lower priority** — no user configs currently use Grok.

### 2.11 Meta Llama (`llama-*`)

**Official mechanism**: Available through multiple providers (Groq, Replicate, Together, etc.) with varying cache support. Through OpenAI-compatible wrappers, may expose standard fields.

**Coverage**: ❌ **No adapter**. Not in opencode or user configs as a primary model.

**Recommendation**: 🔴 **Lowest priority** — not present in current usage.

### 2.12 Hunyuan (Tencent, `hunyuan-*`)

**Official mechanism**: OpenAI-compatible API. Tencent Hunyuan models (`tencent-coding-plan/hunyuan-*`) use OpenAI-compatible API.

**Pi detection**: Model id/name contains `hunyuan` — not currently matched.

**Coverage**: ❌ **No adapter**. Appears in opencode models and user tencent provider.

**Recommendation**: 🟡 **Low priority** — present but few user models.

### 2.13 NVIDIA Nemotron (`nemotron-*`)

**Official mechanism**: OpenAI-compatible API via NVIDIA NIM.

**Coverage**: ❌ **No adapter**. Present in opencode (`nemotron-3-super-free`).

**Recommendation**: 🔴 **Lowest priority** — free tier, not in user configs.

---

## 3. Mapping Against Current Architecture

### 3.1 What is already satisfied ✅

| Feature | Status |
|---|---|
| OpenA I-family `prompt_cache_key` session-id fallback | ✅ Implemented |
| DeepSeek long-retention + session-affinity compat warnings | ✅ Implemented |
| Claude cache-control compat warnings | ✅ Implemented |
| Gemini/Vertex read-only stats | ✅ Implemented |
| Per-model-scoped stats (statsByModel) | ✅ Implemented |
| Model-key separation (`provider/id`) | ✅ Implemented (v3) |
| Prompt reordering for cache stability | ✅ Implemented |
| Session-overview churn stripping | ✅ Implemented |
| Skills compression | ✅ Implemented |
| Structural integrity guard | ✅ Implemented |
| Env var opt-outs (NO_PROMPT_REWRITE, NO_OPENAI_CACHE_KEY, NO_SKILL_COMPRESSION) | ✅ Implemented |

### 3.2 Gaps ❌

| Gap | Models affected | Impact | Priority |
|---|---|---|---|
| **No Kimi (Moonshot) adapter** | `kimi-k2.5`, `kimi-k2.6`, Moonshot models | No stats, no cache key injection | 🔴 High |
| **No Qwen adapter** | `qwen3.5-plus`, `qwen3.6-plus` | No stats, no cache key injection | 🟡 Medium |
| **No GLM (Zhipu) adapter** | `glm-5`, `glm-5.1`, many user configs | No stats, no cache key injection | 🟡 Medium |
| **No MiniMax adapter** | `minimax-m2.5`, `minimax-m2.7` | No stats, no cache key injection | 🟡 Low |
| **No Hunyuan adapter** | `hunyuan-*` models | No stats, no cache key injection | 🟡 Low |
| **No xAI/Grok adapter** | `grok-*` models | No stats, no cache key injection | 🔵 Future |
| **No Mistral adapter** | `mistral-*` models | No stats (cache is opaque anyway) | 🔵 Future |
| **No Llama adapter** | `llama-*` models | No stats | 🔵 Future |

### 3.3 Risks ⚠️

| Risk | Description | Mitigation |
|---|---|---|
| **Adapter proliferation** | Adding 5+ new adapters with similar OpenAI-compatible logic creates maintenance burden | Consider a generic "OpenAI-compatible" adapter that activates for ALL models using `openai-completions` api (not just GPT-name-match). Keep special cases only for unique transports (Claude native, Mistral, Bedrock). |
| **False positive adapter matches** | Model names like `kimi`, `qwen`, `glm` are distinctive enough to avoid false positives | Low risk — these tokens are not substrings of other model family names. |
| **Cache key injection on unsupported proxies** | Some proxies may reject unknown `prompt_cache_key` field | Current gate (`isOpenAICompatibleApi`) already ensures only `openai-completions` / `openai-responses` APIs are targeted. Adding more model names to the gate doesn't change the API check. |

---

## 4. Recommended Implementation Strategy

### 4.1 Phase 1 (Immediate, High Impact)

**Unlock `prompt_cache_key` injection for ALL `openai-completions` models**, not just GPT-named ones.

The current `before_provider_request` gate is:
```typescript
if (!isOpenAIFamilyModel(ctx.model)) return;    // blocks Kimi, Qwen, GLM, etc.
if (!isOpenAICompatibleApi(ctx.model?.api)) return; // only passes openai-completions/-responses
```

Change to:
```typescript
if (!isOpenAICompatibleApi(ctx.model?.api)) return; // single gate — all OpenAI-compatible APIs
```

**Rationale**: 
- The `prompt_cache_key` field is a standard OpenAI protocol field. Any provider implementing `openai-completions` either supports it and benefits, or ignores it harmlessly. Only custom transports like `kiro-api` are excluded (they don't use `openai-completions`).
- We already have the safety check `hasEffectivePromptCacheKey()` that preserves existing non-empty keys.
- The session id source and 64-codepoint clamp are already implemented.
- This single change unlocks cache key injection for Kimi, Qwen, GLM, MiniMax, Hunyuan, Grok — all without adding adapters.

**Files to change**: `index.ts` — the `before_provider_request` hook gate.

### 4.2 Phase 2 (Stats Adapters)

Add adapter entries for the most common non-GPT OpenAI-compatible model families:

| Adapter | Detection token | Footer label | Notes |
|---|---|---|---|
| **Moonshot Kimi** | `kimi` | `Kimi cache` | High priority, present in user configs |
| **Alibaba Qwen** | `qwen` | `Qwen cache` | Medium priority, in opencode |
| **Zhipu GLM** | `glm` | `GLM cache` | Medium priority, many user configs |
| **MiniMax** | `minimax` | `MiniMax cache` | Lower priority |
| **Hunyuan** | `hunyuan` | `Hunyuan cache` | Lower priority |

Each adapter:
- Uses `normalizeWithFallback(message, getOpenAIRawUsage)` — same as the OpenAI adapter (all these models use OpenAI-compatible usage fields).
- Has no `warningText` (compat warnings can remain under the existing openai-family adapter when the model name matches GPT tokens; for non-GPT models the user already knows they're using a third-party proxy).
- Needs a distinct `label` for the footer.

### 4.3 Phase 3 (Advanced)

- **Mistral**: Add stats adapter (always shows 0% — no cache fields exposed) + note that Pi core already handles `x-affinity` header.
- **xAI Grok**: Add adapter with OpenAI-compatible usage reader.
- **OpenRouter-style aggregates**: Consider a more generic `generic-openai` adapter for `openai-completions` models that don't match any known family. The footer would show "OpenAI cache" for all of them, but the `statsByModel` key still separates them by provider/id.

---

## 5. Verification

### 5.1 What currently passes

```bash
node --experimental-strip-types --no-warnings .trellis/tasks/05-21-investigate-pi-otokapi-gpt55-unavailable/verify.ts
node --experimental-strip-types --no-warnings .trellis/tasks/05-17-fix-prompt-pollution-bugs-degrading-deepseek-cache-hit-rate/verify.ts
node --experimental-strip-types --no-warnings -e "import('./index.ts').then(()=>console.log('[load] ok'))"
```

### 5.2 Needed additions

After implementing Phase 1 (relaxed gate) + Phase 2 (new adapters), add to the task verify script:

- Test that `before_provider_request` gate passes for a `kimi-k2.5` model with `api: "openai-completions"` (no longer blocked by `isOpenAIFamilyModel`).
- Test that the gate still blocks `kiro-api` / custom transports.
- Test that a `qwen` model gets correct adapter selection.
- Test per-model stats key for new families.
- Test env-vars opt-out still works for all models.

---

## 6. Evidence Summary

### Key sources consulted
- `index.ts` (pi-cache-optimizer) — current extension code
- `.trellis/spec/frontend/cache-adapter-footer-stats.md` — binding contracts
- `README.md` — public documentation
- `~/.pi/agent/models.json` — actual user model configuration (providers: deepseek, aiapi, cafecode, otokapi, tencent, zhoumo, yepapi, lan, twofish, cry, yyds, kiro, and more)
- `~/.config/opencode/opencode.json` — opencode user config
- `opencode models` — opencode 1.15.0 built-in model list
- Pi core provider implementations:
  - `openai-completions.js` — cache key + session affinity logic
  - `openai-responses.js` — mandatory session-id cache key
  - `anthropic.js` — cache_control breakpoints + session affinity
  - `google.js` / `google-vertex.js` — cached content token reading
  - `mistral.js` — `x-affinity` header for prefix caching
  - `amazon-bedrock.js` — cache point injection via SDK
  - `openai-prompt-cache.js` — shared 64-codepoint clamp utility

### Key external references (from provider docs)
- **OpenAI**: [Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching) — `prompt_cache_key`, 64-char limit, retention policies.
- **Anthropic**: [Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) — `cache_control` breakpoints, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- **Google Gemini**: [Context Caching](https://ai.google.dev/gemini-api/docs/caching) — `cachedContentTokenCount`, explicit `cachedContents` API.
- **DeepSeek**: [Prompt Caching](https://api-docs.deepseek.com/guides/kv_cache) — KV prefix caching, `prompt_cache_hit_tokens`.
- **Mistral AI**: [Cache](https://docs.mistral.ai/capabilities/caching/) — `x-affinity` header for KV-cache reuse (no token-level read fields exposed in usage response).
- **Moonshot/Kimi**: OpenAI-compatible — no public cache-specific docs, but the standard OpenAI `prompt_cache_key` is supported when using the compatible endpoint.
- **Alibaba Qwen** (DashScope): [Caching docs](https://help.aliyun.com/zh/model-studio/) — supports prompt caching through DashScope API; OpenAI-compatible wrapper inherits standard behavior.
- **Zhipu GLM**: OpenAI-compatible API — inherits standard OpenAI `prompt_cache_key` behavior.

---

## 7. Conclusion

### Do we need to change code? **Yes.**

### Summary of recommended changes:

| Change | Impact | Effort | Phase |
|---|---|---|---|
| **Relax `before_provider_request` gate** — remove the `isOpenAIFamilyModel` check; keep only `isOpenAICompatibleApi` check | Unlocks session-id `prompt_cache_key` for all OpenAI-compatible models (Kimi, Qwen, GLM, MiniMax, Hunyuan, etc.) | ~5 lines | Phase 1 (now) |
| **Add Kimi/Moonshot adapter** | Stats footer for `kimi-*` models | ~15 lines | Phase 2 |
| **Add Qwen adapter** | Stats footer for `qwen-*` models | ~15 lines | Phase 2 |
| **Add GLM (Zhipu) adapter** | Stats footer for `glm-*` models | ~15 lines | Phase 2 |
| **Add MiniMax adapter** | Stats footer for `minimax-*` models | ~15 lines | Phase 2 |
| **Add Hunyuan adapter** | Stats footer for `hunyuan-*` models | ~15 lines | Phase 2 |
| **Update task verify script** | Ensure correctness of new adapters and relaxed gate | ~40 lines | After changes |

### Not needed:
- No changes to prompt reordering, skill compression, or churn stripping logic.
- No changes to `models.json` mutation (not allowed).
- No changes to cache key generation (session-id source is correct).
- No changes to env var opt-out mechanics.
