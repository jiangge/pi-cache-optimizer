/** Analyze a TourStory task benchmark. Total Pi-normalized dollar cost is the primary verdict. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Row = {
  label: string;
  status: number;
  promptChars: number;
  totalMs: number;
  usage: { input: number; cacheRead: number; cacheWrite: number; totalInput: number; output: number; cost?: Cost };
};

const files = process.argv.slice(2);
if (!files.length) { console.error("usage: analyze-tourstory-task.ts <requests.jsonl> [...]"); process.exit(1); }
const excludedBlocks = new Set(
  (process.env.BENCH_EXCLUDE_BLOCKS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value)),
);
if ([...excludedBlocks].some((value) => !Number.isInteger(value) || value < 0)) {
  throw new Error("BENCH_EXCLUDE_BLOCKS must be a comma-separated list of non-negative integers");
}
const allRows: Row[] = files.flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
const outDirs = files.map(dirname);
const fallbackPrice: Price | undefined = ["INPUT", "OUTPUT", "CACHE_READ", "CACHE_WRITE"].every((key) => process.env[`BENCH_PRICE_${key}`] !== undefined)
  ? {
      input: Number(process.env.BENCH_PRICE_INPUT),
      output: Number(process.env.BENCH_PRICE_OUTPUT),
      cacheRead: Number(process.env.BENCH_PRICE_CACHE_READ),
      cacheWrite: Number(process.env.BENCH_PRICE_CACHE_WRITE),
    }
  : undefined;
if (fallbackPrice && Object.values(fallbackPrice).some((value) => !Number.isFinite(value) || value < 0)) {
  throw new Error("BENCH_PRICE_* values must be non-negative prices per 1M tokens");
}
const armOf = (label: string) => /^([^.]+)\.s\d+$/.exec(label)?.[1] ?? label;
const blockOf = (label: string) => Number(/^([^.]+)\.s(\d+)$/.exec(label)?.[2] ?? 0);
const rows = allRows.filter((row) => !excludedBlocks.has(blockOf(row.label)));
const arms = [...new Set(rows.map((r) => armOf(r.label)))].sort();
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const money = (v: number) => `$${v.toFixed(6)}`;
const pct = (a: number, b: number) => b > 0 ? `${(100 * a / b).toFixed(1)}%` : "n/a";

console.log("arm      req  inputTok  cachedTok  writeTok  cache/input  inputCost  outputCost  totalCost  costSource  wallSec  changed");
for (const arm of arms) {
  const rs = rows.filter((r) => armOf(r.label) === arm && r.status === 200);
  const input = sum(rs.map((r) => r.usage.totalInput));
  const cached = sum(rs.map((r) => r.usage.cacheRead));
  const write = sum(rs.map((r) => r.usage.cacheWrite));
  const costs = rs.map((r) => r.usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  const runtimeInputCost = sum(costs.map((c) => c.input + c.cacheRead + c.cacheWrite));
  const runtimeOutputCost = sum(costs.map((c) => c.output));
  const runtimeTotalCost = sum(costs.map((c) => c.total));
  const useFallback = runtimeTotalCost === 0 && fallbackPrice !== undefined;
  const uncachedInput = sum(rs.map((r) => r.usage.input));
  const output = sum(rs.map((r) => r.usage.output));
  const inputCost = useFallback
    ? (uncachedInput * fallbackPrice.input + cached * fallbackPrice.cacheRead + write * fallbackPrice.cacheWrite) / 1_000_000
    : runtimeInputCost;
  const outputCost = useFallback ? output * fallbackPrice.output / 1_000_000 : runtimeOutputCost;
  const totalCost = useFallback ? inputCost + outputCost : runtimeTotalCost;
  let changed = "?";
  const changedCounts: number[] = [];
  for (const outDir of outDirs) {
    for (const candidate of [`${arm}.status.txt`, ...rows.filter((r) => armOf(r.label) === arm).map((r) => `${r.label}.status.txt`)]) {
      try {
        const count = readFileSync(join(outDir, candidate), "utf8").trim().split("\n").filter(Boolean).length;
        if (!changedCounts.includes(count)) changedCounts.push(count);
      } catch {}
    }
  }
  if (changedCounts.length) changed = changedCounts.join(",");
  console.log([
    arm.padEnd(8), String(rs.length).padStart(3), String(input).padStart(9), String(cached).padStart(10), String(write).padStart(8),
    pct(cached, input).padStart(11), money(inputCost).padStart(10), money(outputCost).padStart(11), money(totalCost).padStart(10),
    (useFallback ? "catalog" : "runtime").padStart(10), (sum(rs.map((r) => r.totalMs)) / 1000).toFixed(1).padStart(7), changed.padStart(7),
  ].join("  "));
}

const labels = [...new Set(rows.map((r) => r.label))];
const blocks = [...new Set(labels.map(blockOf))].sort((a, b) => a - b);
if (blocks.length > 1) {
  console.log("\nper-block task cost:");
  console.log("block  arm       req   totalInput   cached   output   totalCost   source");
  for (const block of blocks) {
    for (const arm of arms) {
      const rs = rows.filter((r) => armOf(r.label) === arm && blockOf(r.label) === block && r.status === 200);
      if (!rs.length) continue;
      const input = sum(rs.map((r) => r.usage.input));
      const cached = sum(rs.map((r) => r.usage.cacheRead));
      const write = sum(rs.map((r) => r.usage.cacheWrite));
      const output = sum(rs.map((r) => r.usage.output));
      const runtime = sum(rs.map((r) => r.usage.cost?.total ?? 0));
      const fallback = runtime === 0 && fallbackPrice !== undefined;
      const total = fallback
        ? (input * fallbackPrice.input + cached * fallbackPrice.cacheRead + write * fallbackPrice.cacheWrite + output * fallbackPrice.output) / 1_000_000
        : runtime;
      console.log(`${String(block).padStart(5)}  ${arm.padEnd(8)}  ${String(rs.length).padStart(3)}  ${String(input + cached + write).padStart(11)}  ${String(cached).padStart(7)}  ${String(output).padStart(6)}  ${money(total).padStart(10)}   ${fallback ? "catalog" : "runtime"}`);
    }
  }
}

console.log("\nVerdict rule: among arms that actually complete the requested task with acceptable code/checks, the lowest totalCost wins. Runtime cost is preferred; catalog fallback is used only when runtime cost is zero and BENCH_PRICE_* is supplied. Cache percentage is diagnostic only.");
if (excludedBlocks.size) console.log(`Excluded whole paired block(s) for failed task quality: ${[...excludedBlocks].sort((a, b) => a - b).join(", ")}`);
