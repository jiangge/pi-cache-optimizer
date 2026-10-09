import { type PersistedCacheOptimizerFeature } from "./config.ts";

export type CommandCompletionItem = {
  value: string;
  label: string;
  description?: string;
};

export const CACHE_OPTIMIZER_COMMANDS = [
  "enable",
  "disable",
  "doctor",
  "stats",
  "config",
  "compat",
  "reset",
  "fix",
  "rollback",
] as const;

export const CACHE_OPTIMIZER_CONFIG_ARGUMENTS = ["footer-mode", "prompt-rewrite", "virtual-rewrite", "skill-compression", "openai-cache-key", "tool-order", "zero-price-warming", "reset"] as const;

export const CACHE_OPTIMIZER_FEATURE_COMMANDS = ["prompt-rewrite", "virtual-rewrite", "skill-compression", "openai-cache-key", "tool-order", "zero-price-warming"] as const;

export const CACHE_OPTIMIZER_FEATURE_VALUES = ["on", "off"] as const;

export const CACHE_OPTIMIZER_FOOTER_MODES = ["total", "session", "process"] as const;

export const FEATURE_COMMAND_MAP: Record<string, PersistedCacheOptimizerFeature> = {
  "prompt-rewrite": "promptRewrite",
  "virtual-rewrite": "virtualRewrite",
  "skill-compression": "skillCompression",
  "openai-cache-key": "openAICacheKey",
  "tool-order": "toolOrder",
  "zero-price-warming": "zeroPriceWarming",
};

export const CACHE_OPTIMIZER_STATS_ARGUMENTS = ["all", "contributors"] as const;

export const CACHE_OPTIMIZER_FIX_ARGUMENTS = ["prompt-cache", "prompt-cache-key"] as const;

export function filterCommandCompletionItems(
  values: readonly string[],
  prefix: string,
  argumentPath = "",
): CommandCompletionItem[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const matches = values
    .filter((value) => value.startsWith(normalizedPrefix))
    .map((value) => ({
      // Pi replaces the complete argumentPrefix when applying a command
      // completion, so nested suggestions must include their full path.
      value: argumentPath ? `${argumentPath} ${value}` : value,
      label: value,
    }));
  return matches.length > 0 ? matches : null;
}

export function getCacheOptimizerArgumentCompletions(argumentPrefix: string): CommandCompletionItem[] | null {
  if (typeof argumentPrefix !== "string") return null;
  const trimmed = argumentPrefix.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];

  if (parts.length === 0) {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_COMMANDS, "");
  }

  if (parts.length === 1) {
    const subcommandPrefix = parts[0].toLowerCase();
    // `config` is the primary `c` completion; `compat` remains available
    // through its more specific `co` prefix. Surrounding whitespace is
    // ignored so ` c ` behaves the same as `c`.
    if (subcommandPrefix === "c") {
      return [{ value: "config", label: "config" }];
    }
    if (subcommandPrefix === "config") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_CONFIG_ARGUMENTS, "", "config");
    }
    if (subcommandPrefix === "stats") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_STATS_ARGUMENTS, "", "stats");
    }
    return filterCommandCompletionItems(CACHE_OPTIMIZER_COMMANDS, parts[0]);
  }

  if (parts[0].toLowerCase() === "stats") {
    return parts.length === 2
      ? filterCommandCompletionItems(CACHE_OPTIMIZER_STATS_ARGUMENTS, parts[1], "stats")
      : null;
  }

  if (parts[0].toLowerCase() === "fix") {
    return parts.length === 2
      ? filterCommandCompletionItems(CACHE_OPTIMIZER_FIX_ARGUMENTS, parts[1], "fix")
      : null;
  }

  if (parts[0].toLowerCase() !== "config") return null;

  if (parts.length === 2) {
    const nestedPrefix = parts[1].toLowerCase();
    if (nestedPrefix === "footer-mode") {
      return filterCommandCompletionItems(CACHE_OPTIMIZER_FOOTER_MODES, "", "config footer-mode");
    }
    return filterCommandCompletionItems(CACHE_OPTIMIZER_CONFIG_ARGUMENTS, parts[1], "config");
  }

  if (parts.length === 3 && parts[1].toLowerCase() === "footer-mode") {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_FOOTER_MODES, parts[2], "config footer-mode");
  }
  if (parts.length === 3 && CACHE_OPTIMIZER_FEATURE_COMMANDS.includes(parts[1] as typeof CACHE_OPTIMIZER_FEATURE_COMMANDS[number])) {
    return filterCommandCompletionItems(CACHE_OPTIMIZER_FEATURE_VALUES, parts[2], `config ${parts[1]}`);
  }

  return null;
}
