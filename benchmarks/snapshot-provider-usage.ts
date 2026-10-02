import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

type Phase = "baseline" | "optimized";

type Shard = {
  day?: string;
  models?: Record<string, { stats?: Record<string, unknown> }>;
};

function fail(message: string): never {
  console.error(`snapshot-provider-usage: ${message}`);
  process.exit(1);
}

const [phase, provider, model, day] = process.argv.slice(2);
if (phase !== "baseline" && phase !== "optimized") {
  fail("usage: npm run benchmark:snapshot -- <baseline|optimized> <provider> <model> [YYYY-MM-DD]");
}
if (!provider || !model) fail("provider and model are required");

const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".pi", "agent");
const shardDir = join(agentDir, "pi-cache-optimizer-stats.d", "shards");
let files: string[];
try {
  files = (await readdir(shardDir)).filter((file) => file.endsWith(".json"));
} catch {
  fail(`stats shard directory is unavailable: ${shardDir}`);
}

const key = `${provider}/${model}`;
const totals = { requests: 0, hitRequests: 0, cacheRead: 0, cacheWrite: 0, totalInput: 0 };
let matchedShards = 0;
for (const file of files) {
  try {
    const shard = JSON.parse(await readFile(join(shardDir, file), "utf8")) as Shard;
    if (day && shard.day !== day) continue;
    const stats = shard.models?.[key]?.stats;
    if (!stats) continue;
    matchedShards++;
    totals.requests += Number(stats.totalRequests || 0);
    totals.hitRequests += Number(stats.hitRequests || 0);
    totals.cacheRead += Number(stats.cachedInputTokens || 0);
    totals.cacheWrite += Number(stats.cacheWriteInputTokens || 0);
    totals.totalInput += Number(stats.totalInputTokens || 0);
  } catch {
    // Malformed or concurrently replaced shards are ignored like runtime aggregation.
  }
}

if (matchedShards === 0) fail(`no matching ${key} shards found${day ? ` for ${day}` : ""}`);
console.log(JSON.stringify({
  phase,
  request: Date.now(),
  provider,
  model,
  cacheRead: totals.cacheRead,
  cacheWrite: totals.cacheWrite,
  input: Math.max(0, totals.totalInput - totals.cacheRead - totals.cacheWrite),
  totalInput: totals.totalInput,
  snapshot: {
    matchedShards,
    requests: totals.requests,
    hitRequests: totals.hitRequests,
    agentDir: "redacted",
    day: day || "all-current-shards",
  },
}));
