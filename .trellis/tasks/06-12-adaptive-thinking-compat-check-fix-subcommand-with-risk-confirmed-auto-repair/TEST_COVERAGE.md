# Test Coverage for `/cache-optimizer fix` Subcommand

## Automated Tests (All Passing ✅)

### 1. Pattern Detection Tests
**File**: `test-adaptive-thinking.js`
**Status**: ✅ 32/32 tests passed

**Coverage**:
- Opus 4.6+ variants (9 tests)
- Sonnet 4.6+ variants (5 tests)
- Fable 5+ variants (5 tests)
- Negative cases (13 tests)

**Edge cases tested**:
- Date-stamped model IDs (`opus-4-6-20250101`)
- Size annotations (`claude-opus-4-6 [1M]`)
- Provider prefixes (`anthropic/claude-opus-4-6`)
- Dotted versions (`claude-opus-4.6`)
- Missing separators (`myopus-4-6`, `opus4-6`)

### 2. Integration Tests
**File**: `test-fix-integration.js`
**Status**: ✅ All 6 test suites passed

**Test 1: Component Existence** (14/14 ✅)
- `isAdaptiveGenerationModel`
- `isAdaptiveThinkingCompatApplicable`
- `describeMissingAdaptiveThinkingCompat`
- `buildAdaptiveThinkingCompatSuggestion`
- `buildFixSuggestion`
- `stripJsoncComments`
- `locateModelInJsonc`
- `composeFixInsertion`
- `selfCheckFix`
- `formatCompatKeysForInsertion`
- `backupTimestamp`
- Subcommand handler (`subcommand === "fix"`)
- Menu handler (`choice === menuOptions[5]`)
- Menu label (`"Fix — Auto-fix compat issues"`)

**Test 2: Pattern Detection** (7/7 ✅)
- Valid adaptive models match
- Non-adaptive models don't match
- Edge cases handled correctly

**Test 3: JSONC Structure** ✅
- Test file with `//` and `/* */` comments
- Nested `compat` object
- Valid JSON structure after comment stripping

**Test 4: Safety Mechanisms** (7/7 ✅)
1. `cmdCtx.ui.confirm` — User confirmation gate
2. `copyFile(MODELS_JSON_PATH, backupPath)` — Pre-write backup
3. `const tempPath =` — Temp file creation
4. `rename(tempPath, MODELS_JSON_PATH)` — Atomic write
5. `selfCheckFix(originalText, writtenText)` — Post-write validation
6. `await copyFile(backupPath, MODELS_JSON_PATH)` — Backup restoration
7. `No changes were made` — Cancel handling

**Test 5: Risk Warnings** (4/4 ✅)
1. "This change affects ALL sessions"
2. "timestamped backup"
3. "restart Pi"
4. "verify the result"

**Test 6: Non-Interactive Handling** ✅
- `if (!cmdCtx.hasUI)` check
- "Non-interactive terminal detected" message
- "Manual steps:" guidance

### 3. Build Verification
**Command**: `bun build index.ts --target=node`
**Status**: ✅ Successful (162.48 KB)

## Manual Testing Required

The automated tests verify code structure and logic, but **full end-to-end testing requires Pi runtime**:

### Manual Test Checklist

#### Setup
- [ ] Pi extension loaded
- [ ] Model with missing `forceAdaptiveThinking` in `models.json`
- [ ] Model selected as active (`/model` or `pi --model`)

#### Test Scenario 1: Interactive Fix (Happy Path)
1. [ ] Run `/cache-optimizer fix`
2. [ ] Verify preview shows:
   - [ ] Correct provider/model location
   - [ ] Missing keys to insert
   - [ ] All 4 risk warnings
3. [ ] Confirm the change
4. [ ] Verify:
   - [ ] Backup file created (`models.json.backup-cache-optimizer-YYYYMMDD-HHMMSS`)
   - [ ] `forceAdaptiveThinking: true` added to compat
   - [ ] Comments preserved
   - [ ] Original formatting intact (except inserted keys)
5. [ ] Run `/reload`
6. [ ] Verify no compat warning on next turn

#### Test Scenario 2: User Cancels
1. [ ] Run `/cache-optimizer fix`
2. [ ] Decline confirmation
3. [ ] Verify:
   - [ ] "No changes were made" notification
   - [ ] No backup file created
   - [ ] `models.json` unchanged

#### Test Scenario 3: Already Fixed
1. [ ] Model already has `forceAdaptiveThinking: true`
2. [ ] Run `/cache-optimizer fix`
3. [ ] Verify: "Nothing to fix" message

#### Test Scenario 4: Non-Interactive Terminal
1. [ ] Run `pi --model <adaptive-model>` in non-interactive shell
2. [ ] Run `/cache-optimizer fix`
3. [ ] Verify:
   - [ ] "Non-interactive terminal detected" error
   - [ ] Manual edit instructions shown
   - [ ] No write attempted

#### Test Scenario 5: Model Not Found
1. [ ] Create `models.json` entry without the model in `models` array
2. [ ] Run `/cache-optimizer fix`
3. [ ] Verify:
   - [ ] "Could not locate model" error
   - [ ] Manual edit instructions
   - [ ] No write attempted

#### Test Scenario 6: Post-Write Check Failure (Artificial)
- This requires artificially corrupting the write (hard to test manually)
- Safety net: backup restoration should trigger

#### Test Scenario 7: Multiple Missing Keys
1. [ ] Model missing both `forceAdaptiveThinking` and `cacheControlFormat`
2. [ ] Run `/cache-optimizer fix`
3. [ ] Verify both keys are inserted

#### Test Scenario 8: DeepSeek Model
1. [ ] DeepSeek model missing `thinkingFormat` / `requiresReasoningContentOnAssistantMessages`
2. [ ] Run `/cache-optimizer fix`
3. [ ] Verify DeepSeek compat keys inserted

#### Test Scenario 9: OpenAI Proxy
1. [ ] OpenAI-compatible proxy missing `sendSessionAffinityHeaders`
2. [ ] Run `/cache-optimizer fix`
3. [ ] Verify session-affinity header flag inserted

### Integration with Other Subcommands

#### Doctor
- [ ] `/cache-optimizer doctor` shows missing `forceAdaptiveThinking`
- [ ] After fix, doctor shows "✅ Compat fully configured"

#### Compat
- [ ] `/cache-optimizer compat` shows suggestion before fix
- [ ] After fix, compat shows "✅ Compat fully configured"

#### Stats/Reset
- [ ] Fix doesn't interfere with stats tracking
- [ ] Reset still works after fix applied

## Test Results Summary

| Category | Status | Details |
|----------|--------|---------|
| Pattern Detection | ✅ 32/32 | All adaptive model patterns work |
| Component Presence | ✅ 14/14 | All functions implemented |
| Safety Mechanisms | ✅ 7/7 | Backup, atomic write, self-check |
| Risk Warnings | ✅ 4/4 | All warnings present |
| Non-Interactive | ✅ | Refuses to write, shows guidance |
| Build | ✅ | Compiles successfully |
| **Manual Testing** | ⏳ | Requires Pi runtime |

## Known Limitations

1. **No inter-process locking**: Concurrent Pi processes writing `models.json` may race
2. **Comment-preserving edit is best-effort**: Complex JSONC formatting may fail locateModelInJsonc
3. **No rollback on user error**: If user confirms bad change, backup exists but not auto-restored
4. **Single model per fix run**: Must switch models to fix multiple channels

## Next Steps for Full Validation

1. Install updated extension in Pi
2. Create test `models.json` with missing compat
3. Run manual test scenarios 1-9
4. Document any issues found
5. Verify backup/restore flow works

## Test Scripts

- `test-adaptive-thinking.js` — Pattern detection (run with `node`)
- `test-fix-integration.js` — Integration tests (run with `node`)
- `test-fix-e2e.sh` — E2E test framework (run with `bash`)
