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

const file = process.argv[2];
if (!file) { console.error("usage: analyze-tourstory-task.ts <requests.jsonl>"); process.exit(1); }
const rows: Row[] = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const outDir = dirname(file);
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
const arms = [...new Set(rows.map((r) => r.label))].sort();
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const money = (v: number) => `$${v.toFixed(6)}`;
const pct = (a: number, b: number) => b > 0 ? `${(100 * a / b).toFixed(1)}%` : "n/a";

console.log("arm      req  inputTok  cachedTok  writeTok  cache/input  inputCost  outputCost  totalCost  costSource  wallSec  changed");
for (const arm of arms) {
  const rs = rows.filter((r) => r.label === arm && r.status === 200);
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
  try { changed = readFileSync(join(outDir, `${arm}.status.txt`), "utf8").trim().split("\n").filter(Boolean).length.toString(); } catch {}
  console.log([
    arm.padEnd(8), String(rs.length).padStart(3), String(input).padStart(9), String(cached).padStart(10), String(write).padStart(8),
    pct(cached, input).padStart(11), money(inputCost).padStart(10), money(outputCost).padStart(11), money(totalCost).padStart(10),
    (useFallback ? "catalog" : "runtime").padStart(10), (sum(rs.map((r) => r.totalMs)) / 1000).toFixed(1).padStart(7), changed.padStart(7),
  ].join("  "));
}

console.log("\nVerdict rule: among arms that actually complete the requested task with acceptable code/checks, the lowest totalCost wins. Runtime cost is preferred; catalog fallback is used only when runtime cost is zero and BENCH_PRICE_* is supplied. Cache percentage is diagnostic only.");
