#!/usr/bin/env bun
/**
 * Verification script for the simplified prompt_cache_retention logic.
 * Tests the new hasExplicitLongRetentionOptIn function and validates
 * that the logic correctly handles all edge cases.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Mock types
type PiModel = {
  provider: string;
  id: string;
  api: string;
  baseUrl?: string;
};

// Simple JSONC parser (strip comments)
function parseJsonc(text: string): unknown {
  // Remove // comments
  text = text.replace(/\/\/.*$/gm, '');
  // Remove /* */ comments
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove trailing commas
  text = text.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Replicate the new logic
function hasExplicitLongRetentionOptIn(model: PiModel): boolean {
  try {
    const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");
    const text = readFileSync(MODELS_JSON_PATH, "utf8");
    const parsed = parseJsonc(text);
    const providers = asRecord(asRecord(parsed)?.providers);
    if (!providers) return false;

    const prov = asRecord(providers[model.provider]);
    if (!prov) return false;  // Not in models.json

    // Check model-level first (higher priority in Pi's merge logic)
    const models = prov.models;
    if (Array.isArray(models)) {
      const modelEntry = models.find(m => asRecord(m)?.id === model.id);
      if (modelEntry) {
        const modelCompat = asRecord(asRecord(modelEntry)?.compat);
        if (modelCompat?.supportsLongCacheRetention !== undefined) {
          return modelCompat.supportsLongCacheRetention === true;
        }
      }
    }

    // Check provider-level
    const provCompat = asRecord(prov.compat);
    if (provCompat?.supportsLongCacheRetention !== undefined) {
      return provCompat.supportsLongCacheRetention === true;
    }

    return false;  // In models.json but no explicit supportsLongCacheRetention
  } catch {
    return false;  // File missing/unreadable → safe default
  }
}

// Test cases
const testCases: Array<{
  name: string;
  model: PiModel;
  expected: boolean;
  reason: string;
}> = [
  {
    name: "opencode-go/glm-5.2 (user's problem case)",
    model: { provider: "opencode-go", id: "glm-5.2", api: "openai-completions" },
    expected: false,
    reason: "In models.json but only has sendSessionAffinityHeaders, no supportsLongCacheRetention → should strip"
  },
  {
    name: "h-e/glm-5.2 (edge case: provider true, model false)",
    model: { provider: "h-e", id: "glm-5.2", api: "openai-completions" },
    expected: false,
    reason: "Model-level false overrides provider-level true → should strip"
  },
  {
    name: "hello/deepseek-v4-flash (provider has true)",
    model: { provider: "hello", id: "deepseek-v4-flash", api: "openai-completions" },
    expected: true,
    reason: "Provider-level true, no model override → user opted in, should keep"
  },
  {
    name: "deepseek/deepseek-v4-pro (provider has true)",
    model: { provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions" },
    expected: true,
    reason: "Provider-level true → user opted in, should keep"
  },
  {
    name: "atm-temp/glm-5.2 (no supportsLongCacheRetention)",
    model: { provider: "atm-temp", id: "glm-5.2", api: "openai-completions" },
    expected: false,
    reason: "In models.json but no supportsLongCacheRetention field → should strip"
  },
  {
    name: "hyb-ds/some-model (provider has false)",
    model: { provider: "hyb-ds", id: "deepseek-v4", api: "openai-completions" },
    expected: false,
    reason: "Provider-level false → user opted out, should strip"
  },
  {
    name: "nonexistent-provider/model",
    model: { provider: "nonexistent", id: "model-1", api: "openai-completions" },
    expected: false,
    reason: "Not in models.json → safe default, should strip"
  }
];

console.log("=== Simplified Logic Verification ===\n");

let passed = 0;
let failed = 0;

for (const test of testCases) {
  const result = hasExplicitLongRetentionOptIn(test.model);
  const status = result === test.expected ? "✅ PASS" : "❌ FAIL";

  if (result === test.expected) {
    passed++;
  } else {
    failed++;
    console.log(`${status} ${test.name}`);
    console.log(`  Expected: ${test.expected}, Got: ${result}`);
    console.log(`  Reason: ${test.reason}\n`);
  }
}

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}/${testCases.length}`);
console.log(`Failed: ${failed}/${testCases.length}`);

if (failed > 0) {
  console.log("\n❌ Some tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
}
