import { createHash } from "node:crypto";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * DeepSeek KV Cache Optimizer
 *
 * What it does:
 * 1. Reorders Pi's system prompt so stable content is sent before dynamic context.
 * 2. Sets PI_CACHE_RETENTION=long at extension load time.
 * 3. Warns once per DeepSeek-like provider/model when cache-related compat flags are missing.
 * 4. Adds /deepseek-cache-debug for one-shot sanitized provider-payload diagnostics.
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

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (!Array.isArray(value)) return 0;

  let total = 0;
  for (const part of value) {
    const record = asRecord(part);
    if (record?.type === "text" && typeof record.text === "string") {
      total += record.text.length;
    }
  }
  return total;
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

function getRoughSystemPromptLength(payload: UnknownRecord, messages: UnknownRecord[]): number {
  if (typeof payload.instructions === "string") return payload.instructions.length;

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      return textLength(message.content);
    }
  }

  return 0;
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

function buildPayloadDebugSummary(payload: unknown, model: PiModel | undefined): string[] {
  const record = asRecord(payload);
  const messages = record ? getMessages(record) : [];
  const compat = getCompat(model);
  const providerModel = model ? modelKey(model) : "unknown";
  const payloadModel = record && typeof record.model === "string" ? record.model : "unknown";

  const promptCacheKey = record?.prompt_cache_key;

  return [
    "DeepSeek cache debug (sanitized, one-shot)",
    `provider/model: ${providerModel}`,
    `payload model: ${payloadModel}`,
    `prompt_cache_key: ${record && hasSendableField(record, "prompt_cache_key") ? summarizeSecretLikeField(promptCacheKey) : "absent"}`,
    `prompt_cache_retention: ${yesNo(!!record && hasSendableField(record, "prompt_cache_retention"))}`,
    `thinking field: ${yesNo(!!record && hasSendableField(record, "thinking"))}`,
    `reasoning_effort field: ${yesNo(!!record && hasSendableField(record, "reasoning_effort"))}`,
    `message count: ${messages.length}`,
    `first message role: ${getFirstMessageRole(messages)}`,
    `rough system prompt length: ${record ? getRoughSystemPromptLength(record, messages) : 0} chars`,
    `compat.thinkingFormat: ${compat.thinkingFormat ?? "unset"}`,
    `compat.supportsLongCacheRetention: ${boolOrUnset(compat.supportsLongCacheRetention)}`,
    `compat.sendSessionAffinityHeaders: ${boolOrUnset(compat.sendSessionAffinityHeaders)}`,
    `compat.sendSessionIdHeader: ${boolOrUnset(compat.sendSessionIdHeader)}`,
    `compat.cacheControlFormat: ${compat.cacheControlFormat ?? "unset"}`,
    `session-affinity request headers: ${hasSessionAffinityConfigured(model, compat) ? "configured by compat (values are not visible in this hook)" : "not configured"}`,
    "No API keys, header values, or prompt/message content were logged.",
  ];
}

export default function (pi: ExtensionAPI) {
  const warnedModels = new Set<string>();
  let debugNextProviderRequest = false;

  pi.registerCommand("deepseek-cache-debug", {
    description: "Toggle one-shot sanitized DeepSeek cache diagnostics for the next provider request",
    handler: async (_args, ctx) => {
      debugNextProviderRequest = !debugNextProviderRequest;

      ctx.ui.notify(
        debugNextProviderRequest
          ? "DeepSeek cache debug enabled for the next provider request only. It will auto-disable after printing a sanitized summary."
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

  pi.on("before_provider_request", (event, ctx) => {
    if (!debugNextProviderRequest) return;
    debugNextProviderRequest = false;

    const lines = buildPayloadDebugSummary(event.payload, ctx.model);
    const summary = lines.join("\n");

    console.log(`\n${summary}\n`);
    ctx.ui.notify(
      "DeepSeek cache debug captured the next provider payload. Sanitized summary was printed; debug is now off.",
      "info",
    );
  });
}
