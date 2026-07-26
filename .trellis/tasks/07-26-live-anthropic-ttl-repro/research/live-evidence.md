# Live evidence

- Runtime Pi version: 0.82.1.
- Extension source from `pi list`: `/home/jiang/jiang/source/pi-cache-optimizer`.
- Effective model config: provider `pipi-cc`, model `claude-opus-5`, API `anthropic-messages`; compat includes `supportsLongCacheRetention: true`, `supportsCacheControlOnTools: true`, `forceAdaptiveThinking: true`.
- Real failing session: `~/.pi/agent/sessions/--home-jiang-jiang-source-opencad--/2026-07-23T04-35-25-903Z_019f8d41-c64f-7a9d-9faf-effe85998a06.jsonl`.
- Error events on 2026-07-26 at session lines 4883, 4885, 4889; final paths drifted from `messages.24.content.2` to `.3` to `.4`, consistent with a growing last user message/tool-result block sequence.
- Debugging emitted only cache breakpoint JSON paths/type/ttl, never content, schemas, headers, or credentials.

## Live A/B reproduction

Using a fork of the failing session with Pi 0.82.1 and `pipi-cc/claude-opus-5`:

1. Published 2.6.23 logic (visible-mixed-only normalization): Pi's hook-visible payload contained only three `1h` controls (`tools`, `system`, last user message), but the endpoint rejected hidden `messages.24.content.5` ordering with the same 400 error.
2. Temporary force-short hook on the identical session/model/request changed visible `1h` controls to default 5m; the real endpoint returned `OK`.
3. Formal 2.6.24 implementation loaded explicitly before the tracer produced visible default-5m controls at tools/system/messages and the real endpoint returned `OK`.

This proves the third-party proxy adds or rewrites cache breakpoints after Pi's `before_provider_request`; visible mixed-order detection cannot protect proxy endpoints. Non-official Anthropic requests must conservatively downgrade Pi's 1h controls, while official `api.anthropic.com` can preserve legal long retention.
