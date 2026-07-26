# Pi 0.82 Anthropic cache TTL findings

## Pi implementation

Source: local Pi 0.82 dependency `@earendil-works/pi-ai/dist/api/anthropic-messages.js`.

- `resolveCacheRetention()` defaults to short and reads `PI_CACHE_RETENTION=long` for backward compatibility.
- `getCacheControl()` emits `cache_control: { type: "ephemeral", ttl: "1h" }` when retention is long and `supportsLongCacheRetention` is true.
- Anthropic compat defaults `supportsLongCacheRetention` to true when absent.
- The same generated cache control is applied to:
  - the last immediate tool when tool cache control is supported;
  - system prompt block(s);
  - the last block of the last user message.
- `before_provider_request` runs after this serialization and can replace the final payload.

## Ordering contract

The endpoint error states that blocks are processed in this order:

1. `tools`
2. `system`
3. `messages`

A `ttl='1h'` cache breakpoint must not appear after a `ttl='5m'` breakpoint. Anthropic ephemeral cache controls without a `ttl` use the default 5-minute retention and therefore count as short TTL.

## Root cause

The extension requests process-wide long retention. A third-party channel or retained payload block can contain short/default breakpoints while Pi appends a later 1-hour breakpoint. This produces an invalid short-to-long transition even though every individual cache-control object is valid.

## Recommended correction

At the final `before_provider_request` boundary, inspect only known Anthropic breakpoint locations in wire order. If a short breakpoint occurs before a later long breakpoint, delete all `ttl: "1h"` fields in that request. This conservatively normalizes the request to default 5-minute cache control without changing prompt text, model routing, provider config, or legal long-to-short payloads.
