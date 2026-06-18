#!/usr/bin/env bash
set -e

echo "=== E2E Test for /cache-optimizer fix ==="
echo

# Create a test models.json with missing forceAdaptiveThinking
TEST_DIR="/tmp/pi-cache-optimizer-fix-test-$$"
mkdir -p "$TEST_DIR"

cat > "$TEST_DIR/models.json" << 'EOF'
{
  "providers": {
    "test-anthropic": {
      "api": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "models": [
        {
          "id": "claude-opus-4-8",
          "name": "Claude Opus 4.8",
          // Missing forceAdaptiveThinking flag
          "compat": {
            "cacheControlFormat": "anthropic"
          }
        }
      ]
    }
  }
}
EOF

echo "✅ Created test models.json at $TEST_DIR/models.json"
cat "$TEST_DIR/models.json"
echo

# ----------------------------------------------------------------
# Test 1: stripJsoncComments via proper module import (bun)
# ----------------------------------------------------------------
bun -e "
const { __internals_for_tests: T } = require('./index.ts');
const testJson = require('fs').readFileSync('${TEST_DIR}/models.json', 'utf8');

const stripped = T.stripJsoncComments(testJson);
const parsed = JSON.parse(stripped);
if (parsed.providers['test-anthropic'].models[0].id === 'claude-opus-4-8') {
  console.log('✅ Test 1: stripJsoncComments works on real JSONC');
} else {
  console.log('❌ Test 1: stripJsoncComments failed');
  process.exit(1);
}
" 2>&1

# ----------------------------------------------------------------
# Test 2: locateModelInJsonc
# ----------------------------------------------------------------
bun -e "
const { __internals_for_tests: T } = require('./index.ts');
const testJson = require('fs').readFileSync('${TEST_DIR}/models.json', 'utf8');
const location = T.locateModelInJsonc(testJson, 'test-anthropic', 'claude-opus-4-8');

if (location && location.modelObjectBrace > 0 && location.compatObjectBrace > 0) {
  console.log('✅ Test 2: locateModelInJsonc found the model entry');
  console.log('   modelObjectBrace:', location.modelObjectBrace);
  console.log('   compatObjectBrace:', location.compatObjectBrace);
} else {
  console.log('❌ Test 2: locateModelInJsonc failed to locate model');
  process.exit(1);
}
" 2>&1

# ----------------------------------------------------------------
# Test 3: composeFixInsertion + selfCheckFix
# ----------------------------------------------------------------
bun -e "
const { __internals_for_tests: T } = require('./index.ts');
const testJson = require('fs').readFileSync('${TEST_DIR}/models.json', 'utf8');
const location = T.locateModelInJsonc(testJson, 'test-anthropic', 'claude-opus-4-8');
if (!location) { console.log('❌ Test 3: locate failed'); process.exit(1); }

const compatKeys = { forceAdaptiveThinking: true };
const modified = T.composeFixInsertion(testJson, location, compatKeys);

const parsed = JSON.parse(T.stripJsoncComments(modified));
if (parsed.providers['test-anthropic'].models[0].compat.forceAdaptiveThinking !== true) {
  console.log('❌ Test 3: forceAdaptiveThinking not found');
  process.exit(1);
}
if (parsed.providers['test-anthropic'].models[0].compat.cacheControlFormat !== 'anthropic') {
  console.log('❌ Test 3: original cacheControlFormat not preserved');
  process.exit(1);
}

const check = T.selfCheckFix(testJson, modified, 'test-anthropic', 'claude-opus-4-8', compatKeys);
if (check !== null) {
  console.log('❌ Test 3: selfCheckFix failed:', check);
  process.exit(1);
}

console.log('✅ Test 3: composeFixInsertion + selfCheckFix passed');
" 2>&1

# ----------------------------------------------------------------
# Test 4: Verify all fix components present
# ----------------------------------------------------------------
bun -e "
const { __internals_for_tests: T } = require('./index.ts');

const componentChecks = [
  'buildFixSuggestion' in T,
  'locateModelInJsonc' in T,
  'composeFixInsertion' in T,
  'selfCheckFix' in T,
  'stripJsoncComments' in T,
  'formatCompatKeysForInsertion' in T,
  'backupTimestamp' in T,
  'buildAdaptiveThinkingCompatSuggestion' in T,
  'isAdaptiveGenerationModel' in T,
];

let allFound = true;
componentChecks.forEach((found, i) => {
  if (!found) { console.log('❌ Missing component #' + i); allFound = false; }
});

// Source-level checks
const src = require('fs').readFileSync('index.ts', 'utf8');
const srcChecks = [
  ['subcommand === \"fix\"', 'fix subcommand handler'],
  ['Auto-fix compat issues', 'menu option label'],
  ['isAdaptiveThinkingCompatApplicable(model)', 'adaptive check'],
  ['buildFixSuggestion(model)', 'suggestion builder'],
  ['locateModelInJsonc(', 'JSONC scanner'],
  ['selfCheckFix(', 'self-check'],
  ['copyFile(', 'backup'],
  ['backupTimestamp()', 'timestamp'],
];

for (const [pattern, desc] of srcChecks) {
  if (!src.includes(pattern)) {
    console.log('❌ Source missing: ' + desc);
    allFound = false;
  }
}

if (allFound) {
  console.log('✅ Test 4: All fix subcommand components present');
} else {
  process.exit(1);
}
" 2>&1

# ----------------------------------------------------------------
# Test 5: Pattern detection
# ----------------------------------------------------------------
bun -e "
const { __internals_for_tests: T } = require('./index.ts');

const make = (id) => ({ provider: 'test', id, name: id, api: 'anthropic-messages', compat: {} });

const tests = [
  { id: 'claude-opus-4-8', should: true },
  { id: 'claude-sonnet-4-6', should: true },
  { id: 'claude-fable-5', should: true },
  { id: 'claude-opus-3-5', should: false },
  { id: 'gpt-4o', should: false },
  { id: 'claude-opus-4-5', should: false },
];

let passed = 0;
tests.forEach(t => {
  const result = T.isAdaptiveGenerationModel(make(t.id));
  if (result === t.should) passed++;
  else console.log('❌ Pattern test failed for: ' + t.id);
});

const total = tests.length;
if (passed === total) {
  console.log('✅ Test 5: Pattern detection works (' + passed + '/' + total + ')');
} else {
  process.exit(1);
}
" 2>&1

# ----------------------------------------------------------------
# Test 6: Full round-trip
# ----------------------------------------------------------------
bun -e "
const { __internals_for_tests: T } = require('./index.ts');
const testJson = require('fs').readFileSync('${TEST_DIR}/models.json', 'utf8');

const model = { provider: 'test-anthropic', id: 'claude-opus-4-8', name: 'Claude', api: 'anthropic-messages', compat: {} };
const suggestion = T.buildFixSuggestion(model);
if (!suggestion) {
  console.log('❌ Test 6: buildFixSuggestion returned undefined');
  process.exit(1);
}

const location = T.locateModelInJsonc(testJson, suggestion.providerLabel, suggestion.modelId);
if (!location) { console.log('❌ Test 6: locate failed'); process.exit(1); }

const modified = T.composeFixInsertion(testJson, location, suggestion.compatKeys);
const check = T.selfCheckFix(testJson, modified, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys);
if (check !== null) { console.log('❌ Test 6: selfCheckFix:', check); process.exit(1); }

const tmp = '${TEST_DIR}/models_fixed.json';
require('fs').writeFileSync(tmp, modified, 'utf8');
const readBack = require('fs').readFileSync(tmp, 'utf8');
const postCheck = T.selfCheckFix(testJson, readBack, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys);
if (postCheck !== null) { console.log('❌ Test 6: post-check:', postCheck); process.exit(1); }

console.log('✅ Test 6: Full round-trip works');
" 2>&1

echo
echo "=== Summary ==="
echo "✅ All E2E tests passed!"
echo
echo "Note: Full interactive fix testing requires Pi runtime."
echo
echo "These tests verify:"
echo "  - JSONC comment stripping (stripJsoncComments)"
echo "  - Model location in JSON structure (locateModelInJsonc)"
echo "  - Surgical text insertion (composeFixInsertion)"
echo "  - Pre/post-write validation (selfCheckFix)"
echo "  - Pattern detection (isAdaptiveGenerationModel)"
echo "  - Fix suggestion builder (buildFixSuggestion)"
echo "  - Full round-trip fix flow"
echo
echo "Cleanup: rm -rf $TEST_DIR"
rm -rf "$TEST_DIR"
