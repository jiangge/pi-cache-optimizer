# Pi model thinking config research

## Sources

* `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`
* `/home/jiang/.pi/agent/settings.json`
* `/home/jiang/.pi/agent/models.json`

## Findings

* Pi custom provider/model configuration lives in `~/.pi/agent/models.json`.
* Pi default model selection and default thinking level live in `~/.pi/agent/settings.json`.
* `thinkingLevelMap` maps Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) to provider values; `null` hides unsupported levels.
* The AIAPI GPT models in `models.json` (`gpt-5.5`, `gpt-5.4`) already expose `"xhigh": "xhigh"` and currently map `"high": "high"`.
* The observed current behavior (`high` mode) is controlled by `settings.json` containing `"defaultThinkingLevel": "high"`.

## Implementation implication

Change only `/home/jiang/.pi/agent/settings.json` from `"defaultThinkingLevel": "high"` to `"defaultThinkingLevel": "xhigh"` unless additional OpenAI/ChatGPT local overrides are found.
