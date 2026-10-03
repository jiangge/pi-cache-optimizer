import { type PiModel, type UnknownRecord, asRecord, isNonEmptyString } from "./common.ts";
import { isResponsesPromptRewriteBypassApi } from "./model-identity.ts";

export type ToolOrderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream";

export function isKnownToolOrderApi(api: unknown): api is ToolOrderApi {
  return api === "openai-completions" || api === "openai-responses" ||
    api === "anthropic-messages" || api === "google-generative-ai" ||
    api === "google-vertex" || api === "bedrock-converse-stream";
}

export function isToolOrderingEligibleModel(model: PiModel | undefined): boolean {
  // Responses/Codex prompt bypasses remain untouched. The pure helper still
  // supports the verified Responses shape for fixture use, but the request
  // hook must preserve Pi's server-managed/safety-sensitive bypass.
  return !!model && isKnownToolOrderApi(model.api) && !isResponsesPromptRewriteBypassApi(model.api);
}

export function getToolNameForPayload(tool: unknown): string | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;
  if (isNonEmptyString(record.name)) return record.name;
  const fn = asRecord(record.function);
  if (isNonEmptyString(fn?.name)) return fn.name;
  const custom = asRecord(record.custom);
  if (isNonEmptyString(custom?.name)) return custom.name;
  const spec = asRecord(record.toolSpec);
  if (isNonEmptyString(spec?.name)) return spec.name;
  return undefined;
}

export function compareToolOrderEntries(
  left: { name: string; index: number },
  right: { name: string; index: number },
): number {
  // Do not use localeCompare here: its result can vary with the host locale.
  // Exact UTF-16 code-unit ordering plus the original index is reproducible.
  return left.name < right.name ? -1 : left.name > right.name ? 1 : left.index - right.index;
}

export function isJsonObject(value: unknown): value is UnknownRecord {
  return asRecord(value) !== undefined;
}

export function isVerifiedToolForApi(tool: unknown, api: ToolOrderApi): tool is UnknownRecord {
  const record = asRecord(tool);
  if (!record) return false;

  if (api === "openai-completions") {
    if (record.type === "function") {
      const fn = asRecord(record.function);
      return isNonEmptyString(fn?.name) && isJsonObject(fn.parameters);
    }
    if (record.type === "custom") {
      const custom = asRecord(record.custom);
      return isNonEmptyString(custom?.name) && isJsonObject(custom.format);
    }
    return false;
  }

  if (api === "openai-responses") {
    if (record.type === "function") {
      return isNonEmptyString(record.name) && isJsonObject(record.parameters);
    }
    if (record.type === "custom") {
      return isNonEmptyString(record.name) && isJsonObject(record.format);
    }
    return false;
  }

  if (api === "anthropic-messages") {
    return isNonEmptyString(record.name) && isJsonObject(record.input_schema);
  }

  if (api === "google-generative-ai" || api === "google-vertex") {
    return isNonEmptyString(record.name) &&
      (isJsonObject(record.parametersJsonSchema) || isJsonObject(record.parameters));
  }

  const spec = asRecord(record.toolSpec);
  const inputSchema = asRecord(spec?.inputSchema);
  return isNonEmptyString(spec?.name) && isJsonObject(inputSchema?.json);
}

export type ToolArrayInspection = {
  sortedIndices: number[];
  changed: boolean;
};

export function hasTopLevelCacheControl(tools: unknown): boolean {
  return Array.isArray(tools) && tools.some((tool) => {
    const record = asRecord(tool);
    return !!record && Object.prototype.hasOwnProperty.call(record, "cache_control");
  });
}

export function inspectToolArray(tools: unknown, api: ToolOrderApi): ToolArrayInspection | undefined {
  if (!Array.isArray(tools)) return undefined;
  // Native Anthropic and OpenAI-compatible transports can attach a cache
  // breakpoint to a specific tool (normally the final one). Never move it,
  // regardless of API id. Anthropic defer_loading also encodes immediate vs
  // deferred tool groups in array order, so mixed/grouped payloads are no-ops.
  if (hasTopLevelCacheControl(tools)) return undefined;
  if (api === "anthropic-messages" && tools.some((tool) => {
    const record = asRecord(tool);
    return !!record && Object.prototype.hasOwnProperty.call(record, "defer_loading");
  })) return undefined;
  const entries = tools.map((tool, index) => {
    if (!isVerifiedToolForApi(tool, api)) return undefined;
    return { name: getToolNameForPayload(tool) ?? "", index };
  });
  if (entries.some((entry) => entry === undefined)) return undefined;

  const verified = entries as Array<{ name: string; index: number }>;
  const sorted = [...verified].sort(compareToolOrderEntries);
  return {
    sortedIndices: sorted.map((entry) => entry.index),
    changed: sorted.some((entry, index) => entry.index !== index),
  };
}

export type ToolArrayPath = {
  kind: "root" | "bedrock" | "google";
  groupIndex?: number;
  sortedIndices: number[];
};

/**
 * Pure deterministic tool-order normalizer for the exact payload shapes
 * emitted by Pi's built-in transports. It returns the original object for a
 * no-op/unsupported/malformed payload and shallow-clones only the verified
 * path to a tool array when sorting is needed. Tool objects and unrelated
 * request fields (including SDK objects and AbortSignal) retain their identity.
 */
export function normalizeToolsInPayload(
  payload: unknown,
  api: unknown,
): { payload: unknown; changed: boolean } {
  if (!isKnownToolOrderApi(api)) return { payload, changed: false };
  const root = asRecord(payload);
  if (!root) return { payload, changed: false };

  if (api === "google-generative-ai" || api === "google-vertex") {
    const config = asRecord(root.config);
    const groups = config?.tools;
    if (!Array.isArray(groups) || groups.length === 0) return { payload, changed: false };

    const paths: ToolArrayPath[] = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = asRecord(groups[groupIndex]);
      if (!group || !Array.isArray(group.functionDeclarations)) return { payload, changed: false };
      const inspected = inspectToolArray(group.functionDeclarations, api);
      if (!inspected) return { payload, changed: false };
      if (inspected.changed) paths.push({ kind: "google", groupIndex, sortedIndices: inspected.sortedIndices });
    }
    if (paths.length === 0) return { payload, changed: false };

    const sortedGroups = [...groups];
    for (const path of paths) {
      const groupIndex = path.groupIndex!;
      const group = asRecord(groups[groupIndex])!;
      const tools = group.functionDeclarations as unknown[];
      sortedGroups[groupIndex] = {
        ...group,
        functionDeclarations: path.sortedIndices.map((index) => tools[index]),
      };
    }
    return {
      payload: { ...root, config: { ...config, tools: sortedGroups } },
      changed: true,
    };
  }

  if (api === "bedrock-converse-stream") {
    const toolConfig = asRecord(root.toolConfig);
    const tools = toolConfig?.tools;
    const inspected = inspectToolArray(tools, api);
    if (!inspected || !inspected.changed || !Array.isArray(tools)) return { payload, changed: false };
    return {
      payload: {
        ...root,
        toolConfig: {
          ...toolConfig,
          tools: inspected.sortedIndices.map((index) => tools[index]),
        },
      },
      changed: true,
    };
  }

  const tools = root.tools;
  const inspected = inspectToolArray(tools, api);
  if (!inspected || !inspected.changed || !Array.isArray(tools)) return { payload, changed: false };
  return {
    payload: { ...root, tools: inspected.sortedIndices.map((index) => tools[index]) },
    changed: true,
  };
}

/** Public test-facing alias: a pure payload transformation. */
export function sortToolsInPayload(payload: unknown, api: unknown): unknown {
  return normalizeToolsInPayload(payload, api).payload;
}
