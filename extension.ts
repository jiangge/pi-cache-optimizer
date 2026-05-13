import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * DeepSeek KV Cache Optimizer
 *
 * What it does:
 * 1. Reorders Pi's system prompt so stable content is sent before dynamic context.
 * 2. Sets PI_CACHE_RETENTION=long at extension load time.
 * 3. Warns once per DeepSeek-like provider/model when cache-related compat flags are missing.
 * 4. Adds /deepseek-cache-debug for one-shot sanitized request/response cache diagnostics.
 *
 * DeepSeek prompt/KV cache is provider-side, automatic, and best-effort. This extension
 * improves the odds of cache hits; it cannot guarantee hits, especially through proxies.
 */

// ============================================================
// Automatically request long prompt-cache retention when Pi supports it.
// ============================================================
if (!process.env.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION !== "long") {
  process.env.PI_CACHE_RETENTION = "long";
}

type PiModel = NonNullable<ExtensionContext["model"]>;
type UnknownRecord = Record<string, unknown>;

const DEBUG_WIDGET_KEY = "deepseek-cache-debug";
const DEBUG_FILE = join(tmpdir(), "pi-deepseek-cache-debug.txt");

type CacheCompat = {
  sendSessionAffinityHeaders?: boolean;
  sendSessionIdHeader?: boolean;
  supportsLongCacheRetention?: boolean;
  thinkingFormat?: string;
  cacheControlFormat?: string;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkillsForPrompt(skills: NonNullable<BuildSystemPromptOptions["skills"]>): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildStableCandidates(opts: BuildSystemPromptOptions): string[] {
  const candidates: string[] = [];

  if (opts.customPrompt) candidates.push(opts.customPrompt);
  if (opts.appendSystemPrompt) candidates.push(opts.appendSystemPrompt);

  const tools = opts.selectedTools ?? ["read", "bash", "edit", "write"];
  const toolLines = tools
    .filter((name) => opts.toolSnippets?.[name])
    .map((name) => `- ${name}: ${opts.toolSnippets?.[name]}`);
  if (toolLines.length > 0) {
    candidates.push(`Available tools:\n${toolLines.join("\n")}`);
  }

  for (const guideline of opts.promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) candidates.push(`- ${normalized}`);
  }

  for (const file of opts.contextFiles ?? []) {
    if (file.content.length <= 2000) continue;
    candidates.push(`## ${file.path}\n\n${file.content}`);
    candidates.push(file.content);
  }

  if (opts.skills && opts.skills.length > 0) {
    candidates.push(formatSkillsForPrompt(opts.skills));
  }

  return candidates;
}

function optimizeSystemPrompt(
  original: string,
  opts: BuildSystemPromptOptions,
): string {
  const stableParts: string[] = [];
  const seen = new Set<string>();
  let rest = original;

  // Stable layer: content likely to be identical across sessions/turns.
  for (const candidate of buildStableCandidates(opts)) {
    const part = candidate.trim();
    if (!part || seen.has(part) || !rest.includes(part)) continue;

    stableParts.push(part);
    seen.add(part);
    rest = rest.replace(part, "");
  }

  // Dynamic layer: git status, active task context, recent session context, etc.
  const dynamicRemainder = rest.trim();

  if (stableParts.length === 0) return original;

  return (
    stableParts.join("\n\n") +
    (dynamicRemainder.length > 0 ? "\n\n---\n\n" + dynamicRemainder : "")
  );
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function getCompat(model: PiModel | undefined): CacheCompat {
  return (model?.compat ?? {}) as CacheCompat;
}

function isDeepSeekLikeModel(model: PiModel | undefined): boolean {
  if (!model) return false;

  return lower(model.id).includes("deepseek") || lower(model.name).includes("deepseek");
}

function shouldWarnForCacheCompat(model: PiModel | undefined): boolean {
  if (!model || !isDeepSeekLikeModel(model)) return false;
  return model.api === "openai-completions" || model.api === "openai-responses";
}

function describeMissingCacheCompat(model: PiModel): string[] {
  const compat = getCompat(model);
  const missing: string[] = [];

  if (compat.supportsLongCacheRetention !== true) {
    missing.push("supportsLongCacheRetention");
  }
  if (model.api === "openai-responses") {
    if (compat.sendSessionIdHeader !== true) {
      missing.push("sendSessionIdHeader");
    }
  } else if (compat.sendSessionAffinityHeaders !== true) {
    missing.push("sendSessionAffinityHeaders");
  }

  return missing;
}

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function notifyCacheCompatIfNeeded(
  model: PiModel | undefined,
  ctx: ExtensionContext,
  warnedModels: Set<string>,
): void {
  if (!model || !shouldWarnForCacheCompat(model)) return;

  const key = modelKey(model);
  if (warnedModels.has(key)) return;
  warnedModels.add(key);

  const missing = describeMissingCacheCompat(model);
  if (missing.length === 0) return;

  ctx.ui.notify(
    "💡 DeepSeek cache optimizer: " +
      `${key} is DeepSeek-like but merged compat lacks ${missing.join(" and ")}. ` +
      "Proxies may reduce or hide cache hits; add these compat flags in ~/.pi/agent/models.json when the endpoint supports them.",
    "warning",
  );
}

function hasSendableField(payload: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined && payload[key] !== null;
}

function hashForDiagnostics(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function summarizeSecretLikeField(value: unknown): string {
  if (typeof value === "string") {
    return `present (length=${value.length}, sha256=${hashForDiagnostics(value)})`;
  }
  if (value === undefined || value === null) return "absent";
  return `present (${Array.isArray(value) ? "array" : typeof value})`;
}

function textForDiagnostics(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";

  const chunks: string[] = [];
  for (const part of value) {
    const record = asRecord(part);
    if (record?.type === "text" && typeof record.text === "string") {
      chunks.push(record.text);
    }
  }
  return chunks.join("\n");
}

function recordsFromArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];

  const records: UnknownRecord[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record) records.push(record);
  }
  return records;
}

function getMessages(payload: UnknownRecord): UnknownRecord[] {
  const messages = recordsFromArray(payload.messages);
  if (messages.length > 0) return messages;

  // OpenAI Responses-style payloads often use input instead of messages.
  return recordsFromArray(payload.input);
}

function getFirstMessageRole(messages: UnknownRecord[]): string {
  const role = messages[0]?.role;
  return typeof role === "string" ? role : "unknown";
}

function safeRole(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : "unknown";
}

function getMessageRoles(messages: UnknownRecord[]): string[] {
  return messages.map((message) => safeRole(message.role));
}

function formatRoleSequence(roles: string[]): string {
  if (roles.length === 0) return "none";
  if (roles.length <= 24) return roles.join(" > ");
  return `${roles.slice(0, 24).join(" > ")} > ... (+${roles.length - 24} more)`;
}

function getSystemPromptDiagnosticText(payload: UnknownRecord, messages: UnknownRecord[]): string {
  if (typeof payload.instructions === "string") return payload.instructions;

  const systemParts: string[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = textForDiagnostics(message.content);
      if (text.length > 0) systemParts.push(text);
    }
  }

  return systemParts.join("\n\n");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function boolOrUnset(value: boolean | undefined): string {
  return value === undefined ? "unset" : String(value);
}

function hasSessionAffinityConfigured(model: PiModel | undefined, compat: CacheCompat): boolean {
  if (model?.api === "openai-responses") return compat.sendSessionIdHeader === true;
  return compat.sendSessionAffinityHeaders === true;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "unavailable" : String(value);
}

function formatPercent(numerator: number | undefined, denominator: number | undefined): string {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return "unavailable";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function buildPayloadDebugSummary(payload: unknown, model: PiModel | undefined): string[] {
  const record = asRecord(payload);
  const messages = record ? getMessages(record) : [];
  const roles = getMessageRoles(messages);
  const roleSequence = roles.join("|");
  const systemPrompt = record ? getSystemPromptDiagnosticText(record, messages) : "";
  const compat = getCompat(model);
  const providerModel = model ? modelKey(model) : "unknown";
  const payloadModel = record && typeof record.model === "string" ? record.model : "unknown";

  const promptCacheKey = record?.prompt_cache_key;

  return [
    "DeepSeek cache debug (sanitized, one-shot)",
    "Request summary",
    `provider/model: ${providerModel}`,
    `payload model: ${payloadModel}`,
    `prompt_cache_key: ${record && hasSendableField(record, "prompt_cache_key") ? summarizeSecretLikeField(promptCacheKey) : "absent"}`,
    `prompt_cache_retention: ${yesNo(!!record && hasSendableField(record, "prompt_cache_retention"))}`,
    `thinking field: ${yesNo(!!record && hasSendableField(record, "thinking"))}`,
    `reasoning_effort field: ${yesNo(!!record && hasSendableField(record, "reasoning_effort"))}`,
    "Request stability diagnostics",
    `system prompt: length=${systemPrompt.length} chars, sha256=${systemPrompt.length > 0 ? hashForDiagnostics(systemPrompt) : "empty"}`,
    `message count: ${messages.length}`,
    `message roles: ${formatRoleSequence(roles)}`,
    `message roles sha256: ${roleSequence.length > 0 ? hashForDiagnostics(roleSequence) : "empty"}`,
    `first message role: ${getFirstMessageRole(messages)}`,
    `compat.thinkingFormat: ${compat.thinkingFormat ?? "unset"}`,
    `compat.supportsLongCacheRetention: ${boolOrUnset(compat.supportsLongCacheRetention)}`,
    `compat.sendSessionAffinityHeaders: ${boolOrUnset(compat.sendSessionAffinityHeaders)}`,
    `compat.sendSessionIdHeader: ${boolOrUnset(compat.sendSessionIdHeader)}`,
    `compat.cacheControlFormat: ${compat.cacheControlFormat ?? "unset"}`,
    `session-affinity request headers: ${hasSessionAffinityConfigured(model, compat) ? "configured by compat (values are not visible in this hook)" : "not configured"}`,
    "No API keys, header values, or prompt/message content were logged.",
  ];
}

function buildResponseDebugSummary(message: unknown): string[] {
  const record = asRecord(message);
  const usage = asRecord(record?.usage);
  const input = getNumber(usage?.input);
  const output = getNumber(usage?.output);
  const cacheRead = getNumber(usage?.cacheRead);
  const cacheWrite = getNumber(usage?.cacheWrite);
  const totalTokens = getNumber(usage?.totalTokens);
  const approximateMiss = input !== undefined && cacheRead !== undefined && input >= cacheRead ? input - cacheRead : undefined;
  const provider = typeof record?.provider === "string" ? record.provider : "unknown";
  const model = typeof record?.model === "string" ? record.model : "unknown";
  const responseModel = typeof record?.responseModel === "string" ? record.responseModel : "unavailable";

  return [
    "Response usage (assistant message_end)",
    `provider/model: ${provider}/${model}`,
    `responseModel: ${responseModel}`,
    `input tokens: ${formatNumber(input)}`,
    `output tokens: ${formatNumber(output)}`,
    `cacheRead tokens: ${formatNumber(cacheRead)}`,
    `cacheWrite tokens: ${formatNumber(cacheWrite)}`,
    `totalTokens: ${formatNumber(totalTokens)}`,
    `approximate cache miss tokens (input - cacheRead): ${formatNumber(approximateMiss)}`,
    `cache hit rate (cacheRead / input): ${formatPercent(cacheRead, input)}`,
  ];
}

function publishDebugSummary(ctx: ExtensionContext, lines: string[]): void {
  writeFileSync(DEBUG_FILE, lines.join("\n") + "\n", "utf-8");
  ctx.ui.setWidget(DEBUG_WIDGET_KEY, lines);
}

export default function (pi: ExtensionAPI) {
  const warnedModels = new Set<string>();
  let debugNextProviderRequest = false;
  let activeDebugLines: string[] | undefined;
  let clearDebugWidgetOnNextAgentStart = false;

  pi.registerCommand("deepseek-cache-debug", {
    description: "Toggle one-shot sanitized DeepSeek cache diagnostics for the next provider request",
    handler: async (_args, ctx) => {
      debugNextProviderRequest = !debugNextProviderRequest;

      if (!debugNextProviderRequest) {
        activeDebugLines = undefined;
        clearDebugWidgetOnNextAgentStart = false;
        ctx.ui.setWidget(DEBUG_WIDGET_KEY, undefined);
      }

      ctx.ui.notify(
        debugNextProviderRequest
          ? "DeepSeek cache debug enabled for the next provider request only. It will auto-disable after printing a sanitized request summary, then append response usage when available."
          : "DeepSeek cache debug disabled.",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    notifyCacheCompatIfNeeded(ctx.model, ctx, warnedModels);
  });

  pi.on("model_select", async (event, ctx) => {
    notifyCacheCompatIfNeeded(event.model, ctx, warnedModels);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const optimized = optimizeSystemPrompt(event.systemPrompt, event.systemPromptOptions);

    if (optimized !== event.systemPrompt && optimized.trim().length > 0) {
      return { systemPrompt: optimized };
    }

    return {};
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!clearDebugWidgetOnNextAgentStart) return;
    clearDebugWidgetOnNextAgentStart = false;
    ctx.ui.setWidget(DEBUG_WIDGET_KEY, undefined);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!debugNextProviderRequest) return;
    debugNextProviderRequest = false;
    clearDebugWidgetOnNextAgentStart = false;

    const lines = buildPayloadDebugSummary(event.payload, ctx.model);
    activeDebugLines = lines;
    publishDebugSummary(ctx, lines);

    ctx.ui.notify(
      `DeepSeek cache debug: sanitized request summary written to ${DEBUG_FILE} and shown above the editor. Response usage will be appended after the assistant message if available. Debug is now off.`,
      "info",
    );
  });

  pi.on("message_end", (event, ctx) => {
    if (!activeDebugLines || event.message.role !== "assistant") return;

    const lines = [
      ...activeDebugLines,
      "",
      ...buildResponseDebugSummary(event.message),
    ];
    activeDebugLines = undefined;
    clearDebugWidgetOnNextAgentStart = true;
    publishDebugSummary(ctx, lines);

    ctx.ui.notify(
      `DeepSeek cache debug: response usage appended to ${DEBUG_FILE} and the existing widget.`,
      "info",
    );
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!activeDebugLines) return;

    const lines = [
      ...activeDebugLines,
      "",
      "Response usage (assistant message_end)",
      "unavailable: no assistant message_end was captured after the debugged provider request.",
    ];
    activeDebugLines = undefined;
    clearDebugWidgetOnNextAgentStart = true;
    publishDebugSummary(ctx, lines);
  });
}
