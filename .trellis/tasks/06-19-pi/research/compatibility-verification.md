# Pi 0.79.7 Compatibility Verification

## Verification date

2026-06-19

## Versions

| Component | Version |
|---|---|
| Global `pi --version` | 0.79.7 |
| Local `@earendil-works/pi-coding-agent` (`node_modules`) | 0.79.7 after local no-save sync |
| Package peerDependency spec | `"*"` |
| Package version | 2.6.6 |

## Quality checks

| Check | Result |
|-------|--------|
| `bunx tsc --noEmit --pretty false` | PASS (exit 0) |
| `git diff --check` | PASS (no whitespace errors) |
| `npm pack --dry-run` | PASS (5 files, 287.8 kB unpacked) |
| `python3 ./.trellis/scripts/task.py validate .trellis/tasks/06-19-pi` | PASS |

Note: `./node_modules/.bin/tsc` was not available after the no-save local SDK sync, so the project-standard `bunx tsc --noEmit --pretty false` check from the spec was used.

## API surface compatibility

All Extension API surfaces used by this project remain documented and compatible in Pi 0.79.7:

| Hook/API | Status |
|----------|--------|
| `session_start` | ✓ Compatible |
| `model_select` | ✓ Compatible |
| `before_agent_start` | ✓ Compatible (`systemPrompt`, `systemPromptOptions` unchanged) |
| `before_provider_request` | ✓ Compatible |
| `after_provider_response` | ✓ Compatible |
| `message_end` | ✓ Compatible |
| `registerCommand` | ✓ Compatible |
| `ctx.ui.setStatus` | ✓ Compatible |
| `ctx.sessionManager.getSessionId()` | ✓ Compatible |
| `ctx.model` | ✓ Compatible |
| `ctx.modelRegistry` | ✓ Compatible |

## Changes in Pi 0.79.7 evaluated

| Change | Impact on this extension |
|--------|--------------------------|
| `pi update` now updates only Pi; packages require `pi update --extensions` or `pi update --all` | Runtime: no impact. Documentation: README and README.zh-CN now mention the new package-update commands. |
| `CONFIG_DIR_NAME` exported for project config paths | No mandatory code change. This extension intentionally stores user-global state under `~/.pi/agent/` and uses user-facing `models.json` display paths, not project-local config discovery paths. |
| Edit diff helpers exported | Not relevant. Extension does not use diff helpers. |
| Automatic theme mode / Warp image | Not relevant. No dependency on theme or terminal-image APIs. |

## Built-in `CH` footer (Pi 0.79.0+)

Pi 0.79.0 added a latest prompt cache hit rate (`CH`) in the built-in footer. The extension remains useful because it provides persisted provider/model/session-scoped counters, prompt optimization, `prompt_cache_key` fallback, and compat diagnostics.

README and README.zh-CN were updated to explicitly position the extension footer stats as complementary to Pi's built-in `CH` marker.

## SDK version mismatch handling

Initial state: global Pi was 0.79.7 while local `node_modules/@earendil-works/pi-coding-agent` was 0.79.6.

Action taken:

```bash
npm install --package-lock=false --no-save @earendil-works/pi-coding-agent@0.79.7
```

This synced the local installed SDK used for inspection/validation to 0.79.7 without adding a tracked dependency or lockfile. No `package.json` change is needed because this package correctly declares the Pi host package as a peer dependency with `"*"`, per Pi package guidance, and imports it only for types.

## Conclusion

Minimal documentation updates were appropriate. No runtime code, ambient type, package manifest, or tracked dependency changes are required for Pi 0.79.7 compatibility.
