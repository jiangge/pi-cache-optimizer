# Pi 0.80 web scan for pi-cache-optimizer

Date: 2026-07-07

## Sources

- Pi release notes: https://pi.dev/news/releases
- Local synced Pi package changelog after `npm install --package-lock=false --no-save @earendil-works/pi-coding-agent@0.80.3`: `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`
- OpenAI prompt caching docs: https://developers.openai.com/api/docs/guides/prompt-caching
- Anthropic prompt caching docs: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- LiteLLM prompt caching docs: https://docs.litellm.ai/docs/completion/prompt_caching

## Findings

### Pi version / SDK sync

- Global `pi --version` is now `0.80.3`.
- Project-local `node_modules/@earendil-works/pi-coding-agent` was `0.80.2` before this scan.
- Synced the local validation SDK to `0.80.3` with:

```bash
npm install --package-lock=false --no-save @earendil-works/pi-coding-agent@0.80.3
```

This produced no tracked dependency or lockfile change.

### Pi 0.80.3 impact

Relevant Pi 0.80.3 release note:

- Claude Sonnet 5 is available through inherited Anthropic-compatible and Bedrock provider catalogs with adaptive thinking enabled.
- The changelog also says inherited Claude Sonnet 5 metadata was fixed to use adaptive thinking payloads for Anthropic-compatible and Bedrock requests.

Impact on this project:

- Existing adaptive-generation detection covered opus 4.6+, sonnet 4.6+, and fable 5+.
- It did not recognize `claude-sonnet-5`, so custom `anthropic-messages` channels or aliases for Sonnet 5 would not get `forceAdaptiveThinking: true` compat diagnostics or `/cache-optimizer fix` suggestions.
- Implemented minimal runtime/diagnostic fix: recognize Sonnet major versions >=5 (and Opus major versions >=5 for forward compatibility) while preserving existing 4.x thresholds and the `anthropic-messages` API gate.

### Pi 0.79.8–0.80.3 related notes considered

- 0.79.8 added Mistral prompt caching. The project already has a Mistral adapter label and explicitly excludes native `mistral-conversations` from OpenAI-proxy compat advice; no immediate code change identified.
- 0.79.9 added `chat_template_kwargs` thinking compatibility for OpenAI-compatible providers. Current DeepSeek/ZAI thinking compat diagnostics remain applicable; no generic auto-fix was added because provider-specific templates are risky.
- 0.79.10 added compaction event context. This package does not hook compaction events; no code change identified.
- 0.80.0 moved old `pi-ai` root APIs off the root entrypoint. This package imports only `@earendil-works/pi-coding-agent` types, so runtime extension loading remains unaffected.
- 0.80.3 added `session_info_changed`, RPC tree access, `outputPad`, `externalEditor`, and reasoning token usage. No mandatory change identified for this package.

### Prompt caching docs sanity check

- OpenAI docs still say prompt caching is automatic for prompts >=1024 tokens, exact prefix structure matters, and `prompt_cache_key` influences backend routing. Current session-id `prompt_cache_key` fallback remains aligned.
- OpenAI docs list `prompt_cache_retention` as an explicit retention control with `24h` support for current official OpenAI models. Current extension behavior remains conservative: third-party proxies get long retention only with explicit compat opt-in, and observed 400s override opt-in on future requests.
- Anthropic docs still report `cache_read_input_tokens`, `cache_creation_input_tokens`, and `input_tokens` semantics. Current Anthropic usage normalization remains aligned.
- LiteLLM docs confirm common provider minimum token thresholds and usage fields. This supports existing doctor guidance; no new auto-fix was warranted.
