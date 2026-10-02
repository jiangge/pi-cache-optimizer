import { readFile } from "node:fs/promises";

type UsageRow = {
  phase: "baseline" | "optimized";
  request: number;
  provider: string;
  model: string;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  totalInput: number;
};

type Aggregate = {
  phase: UsageRow["phase"];
  requests: number;
  hitRequests: number;
  cacheRead: number;
  cacheWrite: number;
  totalInput: number;
  hitRequestRate: number;
  cacheReadRatio: number;
  cacheWriteRatio: number;
  medianCacheReadRatio: number;
  p90CacheReadRatio: number;
};

function fail(message: string): never {
  console.error(`provider-usage-analysis: ${message}`);
  process.exit(1);
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${name} must be a finite non-negative number`);
  }
  return value;
}

function parseRow(value: unknown, line: number): UsageRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`line ${line} must be an object`);
  const record = value as Record<string, unknown>;
  if (record.phase !== "baseline" && record.phase !== "optimized") fail(`line ${line}: phase must be baseline or optimized`);
  if (typeof record.provider !== "string" || !record.provider.trim()) fail(`line ${line}: provider is required`);
  if (typeof record.model !== "string" || !record.model.trim()) fail(`line ${line}: model is required`);
  return {
    phase: record.phase,
    request: numberField(record.request, `line ${line}.request`),
    provider: record.provider,
    model: record.model,
    cacheRead: numberField(record.cacheRead, `line ${line}.cacheRead`),
    cacheWrite: numberField(record.cacheWrite, `line ${line}.cacheWrite`),
    input: numberField(record.input, `line ${line}.input`),
    totalInput: numberField(record.totalInput, `line ${line}.totalInput`),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function ratio(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function aggregate(rows: UsageRow[], phase: UsageRow["phase"]): Aggregate {
  const selected = rows.filter((row) => row.phase === phase);
  const cacheRead = selected.reduce((sum, row) => sum + row.cacheRead, 0);
  const cacheWrite = selected.reduce((sum, row) => sum + row.cacheWrite, 0);
  const totalInput = selected.reduce((sum, row) => sum + row.totalInput, 0);
  const readRatios = selected.map((row) => ratio(row.cacheRead, row.totalInput));
  return {
    phase,
    requests: selected.length,
    hitRequests: selected.filter((row) => row.cacheRead > 0).length,
    cacheRead,
    cacheWrite,
    totalInput,
    hitRequestRate: ratio(selected.filter((row) => row.cacheRead > 0).length, selected.length),
    cacheReadRatio: ratio(cacheRead, totalInput),
    cacheWriteRatio: ratio(cacheWrite, totalInput),
    medianCacheReadRatio: percentile(readRatios, 0.5),
    p90CacheReadRatio: percentile(readRatios, 0.9),
  };
}

function delta(baseline: number, optimized: number): number {
  return optimized - baseline;
}

const input = process.argv[2];
if (!input) fail("usage: npm run benchmark:provider -- <sanitized-usage.jsonl>");

const text = await readFile(input, "utf8");
const rows = text.split(/\r?\n/).map((line, index) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(">") || trimmed.startsWith("npm ") || trimmed.startsWith("pi-cache-")) return undefined;
  try {
    return parseRow(JSON.parse(trimmed), index + 1);
  } catch (error) {
    if (error instanceof SyntaxError) fail(`line ${index + 1} is not valid JSON`);
    throw error;
  }
}).filter((row): row is UsageRow => row !== undefined);

if (rows.length === 0) fail("input contains no usage rows");
const identities = new Set(rows.map((row) => `${row.provider}/${row.model}`));
if (identities.size !== 1) fail(`input must contain exactly one provider/model, found ${identities.size}`);
const phases = new Set(rows.map((row) => row.phase));
if (!phases.has("baseline") || !phases.has("optimized")) fail("input must contain both baseline and optimized rows");

const baseline = aggregate(rows, "baseline");
const optimized = aggregate(rows, "optimized");
const key = [...identities][0];

console.log(JSON.stringify({
  benchmark: "provider-usage-analysis",
  version: 1,
  identity: key,
  requests: { baseline: baseline.requests, optimized: optimized.requests },
  baseline,
  optimized,
  delta: {
    hitRequestRate: delta(baseline.hitRequestRate, optimized.hitRequestRate),
    cacheReadRatio: delta(baseline.cacheReadRatio, optimized.cacheReadRatio),
    cacheWriteRatio: delta(baseline.cacheWriteRatio, optimized.cacheWriteRatio),
    medianCacheReadRatio: delta(baseline.medianCacheReadRatio, optimized.medianCacheReadRatio),
    p90CacheReadRatio: delta(baseline.p90CacheReadRatio, optimized.p90CacheReadRatio),
  },
  interpretation: "Observational usage comparison only; it does not prove causality and does not claim provider cache behavior when usage fields are absent.",
}, null, 2));
