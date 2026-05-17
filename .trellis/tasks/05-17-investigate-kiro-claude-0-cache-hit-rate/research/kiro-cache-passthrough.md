# Kiro provider — does it pass Anthropic prompt cache through?

> Empirical answer assembled by source-reading `pi-provider-kiro@0.6.1` (the
> npm package the user has installed) and pi session JSONL.
> Date: 2026-05-17.

## TL;DR

**No.** The Kiro provider does not support Anthropic-style prompt caching at
the wire level, and never surfaces cache fields in responses. There is no
pi-side compat flag that can turn this on. The 0% Claude hit rate the user
sees in the footer is **truthful and unchangeable** without changes inside
`pi-provider-kiro` itself (or a switch to a different provider).

## How traffic actually flows

The user's Claude requests do NOT go through the Anthropic Messages API or
the AWS Bedrock Converse API. They go through a third path:

```
pi  ──►  pi-provider-kiro@0.6.1 (extension)
                │
                ▼
   POST https://q.<region>.amazonaws.com/generateAssistantResponse
   Header: X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
   Body:   { conversationState: { currentMessage: { userInputMessage: { content, modelId, ... } }, history } ... }
```

Source: `~/.../pi-provider-kiro/dist/stream.js:144,300-355`. The endpoint is
the AWS CodeWhisperer / Amazon Q Developer streaming service, not Bedrock,
not Anthropic.

In pi terms:
- `model.api` is `kiro-api` (custom API id registered by the extension).
  Confirmed in `~/.pi/agent/sessions/.../*.jsonl` — every assistant
  `message` entry from a Kiro Claude run has `"api":"kiro-api"`,
  `"provider":"kiro"`.
- `model.provider` is `kiro`, registered by the extension at activation,
  not by `models.json`. The user's `models.json` `"kiro": { modelOverrides: ... }`
  block only renames model display labels and remaps thinking levels — it
  does not (and cannot) install `cacheControlFormat` because the underlying
  API isn't OpenAI-compatible nor Anthropic Messages.

## What the wire format looks like

The `userInputMessage` payload is a flat string `content` field plus
sibling fields `modelId`, `origin`, `images?`, `userInputMessageContext?`.
There is **no** structured content-blocks shape, **no** system-prompt slot
that carries Anthropic content blocks, **no** tools array shaped like
Anthropic's, and **no** field that pi could map a `cache_control: ephemeral`
marker into. The system prompt is collapsed into the first user message
upstream by the extension's history builder.

`grep -nE 'cache_control|cachePoint|cache_read_input|cacheReadInputTokens|cacheCreationInputTokens'`
across the entire `pi-provider-kiro/dist/` tree returns **zero hits**. All
`cacheRead`/`cacheWrite` references are zero-initializers
(`{ cacheRead: 0, cacheWrite: 0 }`) on the usage record at request start;
none are assignments from upstream response data.

Source-of-truth refs:
- `~/.../pi-provider-kiro/dist/stream.js:300-321` (request body shape)
- `~/.../pi-provider-kiro/dist/stream.js:128-138` (output usage initializer
  — never updated for cache fields)
- `~/.../pi-provider-kiro/dist/usage.js` (the only usage logic in the
  package; this fetches **account-level** monthly credit limits via
  `AmazonCodeWhispererService.GetUsageLimits` — has nothing to do with
  per-request prompt-cache token tracking)

## Why a `compat.cacheControlFormat: "anthropic"` flag would not help

Pi's cache-control marker injection lives inside two specific adapters:
the OpenAI-completions adapter and the Anthropic Messages adapter. Both
are bypassed when an extension registers a custom API id (`kiro-api`)
with its own `stream` function. Pi's `before_request` compat layer never
gets near the Kiro request body.

Even if pi did try to inject `cache_control` markers, the Kiro request
schema has no place to receive them. The Q backend would either ignore
extra fields or 400 the request.

## Could pi observe server-side caching that AWS Q does internally?

AWS Q very likely does its own prefix caching on the backend for cost
control — but the streaming protocol does not surface cache_read /
cache_creation token counts. The response stream events (`assistantResponseEvent`,
`messageMetadataEvent`, etc.) carry generated tokens but no cache
breakdown. So pi has nothing to read even if caching were happening.

## Cost framing — likely off

The provider's README (`~/.../pi-provider-kiro/README.md`) states:

> All listed models are free to use through Kiro.

So the "22.3M tokens at full input rate" cost framing in the original
PRD is probably wrong for Kiro specifically. The real lever Kiro caches
against is the **`MONTHLY_REQUEST_COUNT`** quota that the provider's
retry logic specifically watches for as a non-retryable error
(`stream.js` retry path mentions `MONTHLY_REQUEST_COUNT` and
`INSUFFICIENT_MODEL_CAPACITY`). Cache hits would matter for staying
under that monthly cap, but only if Kiro actually credits cache-hit
requests differently — a question only the Kiro/AWS side can answer,
and one we can't validate locally.

## Bottom line for this task

- R1 answered: NO, Kiro does not pass Anthropic cache_control markers
  and does not surface cache_read / cache_creation token counts.
- R2 (config change): not applicable. No models.json edit will help.
- R3 (document the constraint): this is the only actionable path
  inside `pi-cache-optimizer`.
- The current `warningText` for Claude in this extension fires only
  on `model.api === "openai-completions" | "openai-responses"`. For
  `kiro-api` it stays silent today, which is correct: there is no
  flag the user can flip.
