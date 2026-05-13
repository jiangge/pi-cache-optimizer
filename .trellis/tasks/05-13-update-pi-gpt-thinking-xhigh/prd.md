# Update Pi GPT Thinking Mode to xhigh

## Goal

Update the user's Pi agent configuration so GPT-family models use `xhigh` thinking mode instead of currently showing/running as `high`. Apply the same adjustment to official ChatGPT/OpenAI usage if it is controlled by the same Pi default setting or if a corresponding local override exists.

## Requirements

* Change Pi's default thinking level from `high` to `xhigh`.
* Verify AIAPI GPT model entries (`gpt-5.5`, `gpt-5.4`) support `xhigh` in their `thinkingLevelMap`.
* Check whether official ChatGPT/OpenAI configuration has a separate local override that also needs changing.
* Do not alter API keys, provider URLs, model IDs, or unrelated model/provider settings.

## Acceptance Criteria

* [ ] `/home/jiang/.pi/agent/settings.json` has `"defaultThinkingLevel": "xhigh"`.
* [ ] AIAPI GPT model mappings retain/support `"xhigh": "xhigh"`.
* [ ] Any official OpenAI/ChatGPT local override found with default/high mode is updated if applicable; otherwise document that no separate override exists in local Pi config.
* [ ] JSON config remains valid.

## Definition of Done

* JSON files validate with Python `json.load`.
* Relevant config changes are summarized to the user.

## Technical Approach

The Pi documentation says the active default thinking mode is configured through `~/.pi/agent/settings.json` as `defaultThinkingLevel`, while per-model `thinkingLevelMap` in `~/.pi/agent/models.json` describes supported Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). The local AIAPI GPT models already support `xhigh`, so the primary change is to set the global default thinking level to `xhigh`. Inspect `models.json` for any OpenAI/ChatGPT provider override before editing further.

## Out of Scope

* Adding new models or providers.
* Changing API keys, costs, token limits, or endpoint compatibility settings.
* Modifying non-Pi application configs.

## Technical Notes

* Pi model config docs: `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`.
* Current local config files inspected:
  * `/home/jiang/.pi/agent/settings.json`
  * `/home/jiang/.pi/agent/models.json`
