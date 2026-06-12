#!/usr/bin/env node
/**
 * Quick verification test for adaptive thinking detection and fix logic.
 * This does NOT test the full Pi extension — just the core detection patterns.
 */

// Adaptive thinking model patterns (copied from index.ts)
const ADAPTIVE_OPUS_PATTERN = /(^|[\/\s:_-])(opus-4[.-][6-9]|opus-4-[1-9][0-9])($|[-_.:\/\s\[])/i;
const ADAPTIVE_SONNET_PATTERN = /(^|[\/\s:_-])(sonnet-4[.-][6-9]|sonnet-4-[1-9][0-9])($|[-_.:\/\s\[])/i;
const ADAPTIVE_FABLE_PATTERN = /(^|[\/\s:_-])fable-([5-9]|[1-9][0-9])($|[-_.:\/\s\[])/i;

function testPattern(pattern, name, shouldMatch, shouldNotMatch) {
  console.log(`\nTesting ${name}:`);
  let passed = 0;
  let failed = 0;
  
  shouldMatch.forEach(id => {
    if (pattern.test(id)) {
      console.log(`  ✅ "${id}" matched`);
      passed++;
    } else {
      console.log(`  ❌ "${id}" SHOULD match but didn't`);
      failed++;
    }
  });
  
  shouldNotMatch.forEach(id => {
    if (!pattern.test(id)) {
      console.log(`  ✅ "${id}" correctly NOT matched`);
      passed++;
    } else {
      console.log(`  ❌ "${id}" should NOT match but did`);
      failed++;
    }
  });
  
  return { passed, failed };
}

// Test cases
const opusShouldMatch = [
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-4.6',
  'opus-4-6-20250101',
  'claude-opus-4-9',
  'claude-opus-4-10',
  'anthropic/claude-opus-4-6',
  'claude-opus-4-6 [1M]',
];

const opusShouldNotMatch = [
  'claude-opus-3-5',
  'claude-opus-4-5',
  'claude-opus-4',
  'opus-3-7',
  'myopus-4-6',  // No separator before 'opus'
  'opus4-6',     // Missing separator between 'opus' and '4'
];

const sonnetShouldMatch = [
  'claude-sonnet-4-6',
  'claude-sonnet-4.6',
  'sonnet-4-7-20250101',
  'claude-sonnet-4-9',
  'anthropic/claude-sonnet-4-6',
];

const sonnetShouldNotMatch = [
  'claude-sonnet-3-5',
  'claude-sonnet-4-5',
  'sonnet-3-7',
];

const fableShouldMatch = [
  'claude-fable-5',
  'fable-5',
  'claude-fable-6',
  'claude-fable-10',
  'anthropic/claude-fable-5',
];

const fableShouldNotMatch = [
  'claude-fable-4',
  'claude-fable-3',
  'myfable-5',   // No separator before 'fable'
  'fable5',      // Missing separator between 'fable' and '5'
];

console.log('=== Adaptive Thinking Model Detection Tests ===');

const opusResult = testPattern(ADAPTIVE_OPUS_PATTERN, 'Opus Pattern', opusShouldMatch, opusShouldNotMatch);
const sonnetResult = testPattern(ADAPTIVE_SONNET_PATTERN, 'Sonnet Pattern', sonnetShouldMatch, sonnetShouldNotMatch);
const fableResult = testPattern(ADAPTIVE_FABLE_PATTERN, 'Fable Pattern', fableShouldMatch, fableShouldNotMatch);

const totalPassed = opusResult.passed + sonnetResult.passed + fableResult.passed;
const totalFailed = opusResult.failed + sonnetResult.failed + fableResult.failed;

console.log('\n=== Summary ===');
console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);

if (totalFailed === 0) {
  console.log('\n✅ All tests passed!');
  process.exit(0);
} else {
  console.log('\n❌ Some tests failed!');
  process.exit(1);
}
