/** Analyze the real OpenAI Codex prefix benchmark by session, excluding each session's first successful cache-writing request. */
import { readFileSync } from "node:fs";

type RecordedRequest = {
  label: string;
  status: number;
  promptText: string;
  promptChars: number;
  responseHeaderMs?: number;
  totalMs: number;
  usage: { input: number; cacheRead: number; cacheWrite: number; totalInput: number; output: number };
};

const file = process.argv[2];
if (!file) { console.error("usage: analyze-codex-prefix.ts <requests.jsonl>"); process.exit(1); }
const rows: RecordedRequest[] = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

type Obs = { prompt: number; cached: number; write: number; uncached: number; lcp: number; ttft: number; totalMs: number };
type Session = { label: string; arm: string; block: number; obs: Obs[] };
const byLabel = new Map<string, RecordedRequest[]>();
for (const row of rows) {
  if (row.status !== 200 || row.usage.totalInput === undefined) continue;
  byLabel.set(row.label, [...(byLabel.get(row.label) ?? []), row]);
}

const sessions: Session[] = [];
for (const [label, list] of byLabel) {
  const match = /^([^.]+)\.s(\d+)$/.exec(label);
  if (!match) continue;
  const obs = list.slice(1).map((row) => {
    const prompt = row.usage.totalInput;
    const cached = row.usage.cacheRead;
    const write = row.usage.cacheWrite;
    const earlier = list.slice(0, list.indexOf(row)).map((prior) => prior.promptText);
    let bestChars = 0;
    for (const prior of earlier) {
      const limit = Math.min(prior.length, row.promptText.length);
      let i = 0;
      while (i < limit && prior.charCodeAt(i) === row.promptText.charCodeAt(i)) i++;
      bestChars = Math.max(bestChars, i);
    }
    const lcp = row.promptText.length > 0 ? Math.round((bestChars / row.promptText.length) * prompt) : 0;
    return {
      prompt,
      cached,
      write,
      uncached: Math.max(0, prompt - cached - write),
      lcp,
      ttft: row.responseHeaderMs ?? NaN,
      totalMs: row.totalMs,
    };
  });
  if (obs.length) sessions.push({ label, arm: match[1], block: Number(match[2]), obs });
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const finite = (xs: number[]) => xs.filter(Number.isFinite);
const percentile = (xs: number[], p: number) => {
  const sorted = finite(xs).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
};
const pct = (x: number) => Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
const num = (x: number) => Number.isFinite(x) ? Math.round(x).toString() : "n/a";

type SessionMetric = {
  arm: string; block: number; meanPrompt: number; meanCached: number; meanUncached: number; totalUncached: number;
  hitRate: number; coverage: number; lcpCeiling: number; realization: number; ttft: number;
};
const metrics: SessionMetric[] = sessions.map((session) => {
  const hits = session.obs.filter((o) => o.cached > 0);
  const prompt = sum(session.obs.map((o) => o.prompt));
  const cached = sum(session.obs.map((o) => o.cached));
  const lcp = sum(session.obs.map((o) => o.lcp));
  return {
    arm: session.arm,
    block: session.block,
    meanPrompt: mean(session.obs.map((o) => o.prompt)),
    meanCached: mean(session.obs.map((o) => o.cached)),
    meanUncached: mean(session.obs.map((o) => o.uncached)),
    totalUncached: sum(session.obs.map((o) => o.uncached)),
    hitRate: hits.length / session.obs.length,
    coverage: prompt > 0 ? cached / prompt : NaN,
    lcpCeiling: prompt > 0 ? lcp / prompt : NaN,
    realization: hits.length ? mean(hits.map((o) => o.lcp > 0 ? o.cached / o.lcp : NaN).filter(Number.isFinite)) : NaN,
    ttft: mean(finite(session.obs.map((o) => o.ttft))),
  };
});

function bootstrapMeanCI(values: number[], iterations = 10000): [number, number] {
  if (values.length < 2) return [NaN, NaN];
  let state = 0x51f15e;
  const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) total += values[Math.floor(rand() * values.length)];
    means.push(total / values.length);
  }
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

console.log("arm      sess  warmReq  hitRate  cache/token  LCPceil  cached/LCP|hit  promptTok/req  uncached/req  latency p50/p90 ms");
for (const arm of [...new Set(metrics.map((m) => m.arm))].sort()) {
  const sm = metrics.filter((m) => m.arm === arm);
  const reqs = sessions.filter((s) => s.arm === arm).flatMap((s) => s.obs);
  const latencies = reqs.map((o) => o.totalMs);
  console.log([
    arm.padEnd(8), String(sm.length).padStart(4), String(reqs.length).padStart(8),
    pct(mean(sm.map((m) => m.hitRate))).padStart(8), pct(mean(sm.map((m) => m.coverage))).padStart(11),
    pct(mean(sm.map((m) => m.lcpCeiling))).padStart(8), pct(mean(sm.map((m) => m.realization))).padStart(15),
    num(mean(sm.map((m) => m.meanPrompt))).padStart(13), num(mean(sm.map((m) => m.meanUncached))).padStart(12),
    `${num(percentile(latencies, .5))}/${num(percentile(latencies, .9))}`.padStart(18),
  ].join("  "));
}

const baselineArm = metrics.some((m) => m.arm === "V216") ? "V216" : "CORE";
const baseline = new Map(metrics.filter((m) => m.arm === baselineArm).map((m) => [m.block, m]));
console.log(`\npaired delta vs ${baselineArm} by randomized block (negative uncached is better):`);
console.log("arm       paired  uncached/req delta [bootstrap 95% CI]   prompt/req delta   cache-ratio delta   latency delta ms");
for (const arm of [...new Set(metrics.map((m) => m.arm))].filter((a) => a !== baselineArm).sort()) {
  const pairs = metrics.filter((m) => m.arm === arm).map((m) => [m, baseline.get(m.block)] as const).filter((p): p is readonly [SessionMetric, SessionMetric] => !!p[1]);
  const uncached = pairs.map(([a, b]) => a.meanUncached - b.meanUncached);
  const ci = bootstrapMeanCI(uncached);
  console.log([
    arm.padEnd(9), String(pairs.length).padStart(6),
    `${num(mean(uncached))} [${num(ci[0])}, ${num(ci[1])}]`.padStart(38),
    num(mean(pairs.map(([a, b]) => a.meanPrompt - b.meanPrompt))).padStart(16),
    `${(mean(pairs.map(([a, b]) => a.coverage - b.coverage)) * 100).toFixed(1)}pp`.padStart(19),
    num(mean(pairs.map(([a, b]) => {
      const aSession = sessions.find((s) => s.arm === a.arm && s.block === a.block)!;
      const bSession = sessions.find((s) => s.arm === b.arm && s.block === b.block)!;
      return mean(aSession.obs.map((o) => o.totalMs)) - mean(bSession.obs.map((o) => o.totalMs));
    }))).padStart(16),
  ].join("  "));
}

console.log("\nInterpretation: cache/token is descriptive, not the verdict. Prefer lower uncached tokens with similar semantics; use LCP ceiling vs cached/LCP to separate prompt instability from provider cache realization. LEGACY is counterfactual for Codex, not v2.8.16 production behavior.");
