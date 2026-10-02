import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUT_DIR,
  estimateLcpTokens,
  extractUsage,
  renderPrompt,
  sha1,
  sleep,
  type Usage,
} from "./lib.ts";

export type ProxyOptions = {
  /** Real upstream base URL, e.g. https://host/v1. Requests arrive as /<label>/v1/... and are forwarded below it. */
  upstreamBase: string;
  port?: number;
  /** Minimum quiet time between the end of one upstream request and the start of the next. */
  minGapMs?: number;
  /** Hard stop: further requests are rejected with 503 once this many have been forwarded. */
  maxRequests?: number;
  outDir?: string;
};

export type RecordedRequest = {
  seq: number;
  label: string;
  at: string;
  status: number;
  stream: boolean;
  /** Replay-style request (max tokens = 1) such as Pi's cache warmer; excluded from hit statistics. */
  warmer: boolean;
  promptCacheKey?: string;
  affinityHeaders: Record<string, string>;
  bodyBytes: number;
  promptChars: number;
  promptHash: string;
  ttftMs?: number;
  totalMs: number;
  usage: Usage;
  /** Longest prefix shared with any earlier request of the same label, scaled to tokens. */
  lcpTokens?: number;
  bodyFile: string;
  error?: string;
};

const AFFINITY_HEADERS = ["x-session-affinity", "x-client-request-id", "session_id", "x-session-id"];
const DROPPED_REQUEST_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding", "transfer-encoding"]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Prefixes the first system/developer message with a per-label nonce so groups cannot warm each other's cache. */
function injectNonce(body: any, nonce: string): boolean {
  const first = Array.isArray(body?.messages) ? body.messages[0] : undefined;
  if (!first || (first.role !== "system" && first.role !== "developer")) return false;
  const prefix = `[bench-run:${nonce}]\n`;
  if (typeof first.content === "string") {
    first.content = prefix + first.content;
    return true;
  }
  const textPart = Array.isArray(first.content) ? first.content.find((part: any) => part?.type === "text") : undefined;
  if (textPart) {
    textPart.text = prefix + textPart.text;
    return true;
  }
  return false;
}

function isWarmer(body: any): boolean {
  return body?.max_tokens === 1 || body?.max_completion_tokens === 1;
}

export function startProxy(options: ProxyOptions): Promise<{ server: Server; port: number; close: () => Promise<void>; logFile: string }> {
  const outDir = options.outDir || OUT_DIR;
  const bodiesDir = join(outDir, "bodies");
  mkdirSync(bodiesDir, { recursive: true });
  const logFile = join(outDir, "requests.jsonl");
  const minGapMs = options.minGapMs ?? 2000;
  const maxRequests = options.maxRequests ?? 400;
  const upstreamBase = options.upstreamBase.replace(/\/+$/, "");
  const upstreamPath = new URL(upstreamBase).pathname.replace(/\/+$/, "");
  const salt = String(Date.now());

  let seq = 0;
  let forwarded = 0;
  // Strict serialization: one upstream request in flight, ever. Pi's own retries and warmers queue behind it.
  let tail: Promise<void> = Promise.resolve();
  const priorByLabel = new Map<string, string[]>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const match = /^\/([^/]+)(\/.*)$/.exec(req.url || "");
    if (!match) {
      res.writeHead(404).end("expected /<label>/<path>");
      return;
    }
    const label = decodeURIComponent(match[1]);
    const rest = match[2].startsWith(`${upstreamPath}/`) ? match[2].slice(upstreamPath.length) : match[2];
    if (forwarded >= maxRequests) {
      res.writeHead(503).end("benchmark request budget exhausted");
      return;
    }
    forwarded++;
    const mySeq = ++seq;

    const result = tail.then(async () => {
      const started = Date.now();
      let body: any;
      let outbound: Buffer | string = raw;
      let promptText = "";
      const isChat = req.method === "POST" && rest.startsWith("/chat/completions");
      if (isChat) {
        try {
          body = JSON.parse(raw.toString("utf8"));
          promptText = renderPrompt(body);
          const clone = JSON.parse(JSON.stringify(body));
          injectNonce(clone, sha1(`${salt}:${label}`));
          outbound = JSON.stringify(clone);
        } catch {
          body = undefined;
        }
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      headers["accept-encoding"] = "identity";

      let status = 502;
      let ttftMs: number | undefined;
      let text = "";
      let error: string | undefined;
      try {
        const upstream = await fetch(upstreamBase + rest, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : outbound,
        });
        status = upstream.status;
        const responseHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, name) => {
          if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)) responseHeaders[name] = value;
        });
        res.writeHead(status, responseHeaders);
        if (upstream.body) {
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ttftMs === undefined) ttftMs = Date.now() - started;
            text += decoder.decode(value, { stream: true });
            res.write(value);
          }
        }
        res.end();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.writeHead(502);
        res.end(`proxy upstream error: ${error}`);
      }

      if (isChat && body) {
        const usage = extractUsage(text);
        const earlier = priorByLabel.get(label) ?? [];
        const bodyFile = join("bodies", `${String(mySeq).padStart(5, "0")}-${label.replace(/[^\w.-]/g, "_")}.json`);
        writeFileSync(join(outDir, bodyFile), JSON.stringify(body));
        const entry: RecordedRequest = {
          seq: mySeq,
          label,
          at: new Date(started).toISOString(),
          status,
          stream: body.stream === true,
          warmer: isWarmer(body),
          promptCacheKey: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined,
          affinityHeaders: Object.fromEntries(AFFINITY_HEADERS.filter((n) => headers[n]).map((n) => [n, headers[n]])),
          bodyBytes: raw.length,
          promptChars: promptText.length,
          promptHash: sha1(promptText),
          ttftMs,
          totalMs: Date.now() - started,
          usage,
          lcpTokens: estimateLcpTokens(promptText, earlier, usage.promptTokens),
          bodyFile,
          error,
        };
        appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
        // Failed attempts may never have written a cache entry, so they must not count as prefix donors.
        if (status === 200) {
          earlier.push(promptText);
          priorByLabel.set(label, earlier);
        }
      }
      await sleep(minGapMs);
    });
    tail = result.catch(() => undefined);
    await result;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port ?? 0;
      resolve({
        server,
        port,
        logFile,
        close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const upstreamBase = process.env.BENCH_UPSTREAM_BASE;
  if (!upstreamBase) {
    console.error("set BENCH_UPSTREAM_BASE to the real provider base URL");
    process.exit(1);
  }
  const { port, logFile } = await startProxy({ upstreamBase, port: Number(process.env.BENCH_PORT || 8787) });
  console.log(`recording proxy on http://127.0.0.1:${port}/<label>/... -> ${upstreamBase}\nlog: ${logFile}`);
}
