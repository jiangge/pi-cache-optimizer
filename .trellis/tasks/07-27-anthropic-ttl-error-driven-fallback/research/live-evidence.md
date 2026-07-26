# Live evidence and correction rationale

## 2.6.23 live failure

Pi 0.82.1 with a fork of the exact failing opencad session and `pipi-cc/claude-opus-5` showed only three visible `1h` controls in Pi's `before_provider_request`, while the endpoint reported a hidden earlier 5m breakpoint. A temporary force-short hook made the identical request succeed.

## Why blanket downgrade is too broad

That evidence proves pipi-cc's transformation is incompatible with Pi's 1h controls, but does not prove every third-party Anthropic endpoint is incompatible. A global non-official endpoint downgrade would reduce valid 1h caching to 5m and increase cache writes/cost for compatible proxies.

## Correct scope

- Configured `supportsLongCacheRetention: false`: Pi emits default 5m.
- Hook-visible invalid mixed order: repair immediately.
- Hook-visible legal 1h: preserve.
- Explicit Anthropic TTL order error in assistant `errorMessage`: record process-local provider/model fallback so Pi's next auto-retry/request uses 5m; doctor/fix recommends persistent false config.

The Mainline 2.7M-token prompt issue is unrelated and tracked in Mainline intent `int_5a162dfc`.

## Superseded regression

The archived `07-26-live-anthropic-ttl-repro/verify-live-fix.ts` intentionally encoded the temporary blanket rule “every pipi-cc long-only payload becomes 5m”. It now fails that single assertion by design and is superseded by this task's error-driven regression. Its pure helpers and official-visible-order assertions remain valid, but the blanket hook expectation must not be restored.
