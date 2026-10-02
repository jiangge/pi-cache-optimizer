import { atomicCreateTextFileNoReplace, atomicReplaceTextFilePreservingMode, hashText, withModelsJsonTransactionLock } from "./atomic-fs.ts";
import { LOG_PREFIX, type MutableEnv, asRecord, getErrorCode, isNonEmptyString } from "./common.ts";
import { STATE_DIR } from "./paths.ts";
import { PI_CACHE_RETENTION_ENV, STARTUP_CACHE_RETENTION_ENV, requestLongCacheRetention, restoreCacheRetentionEnv } from "./retention.ts";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";


export const CONFIG_FILE_PATH = join(STATE_DIR, "pi-cache-optimizer-config.json");

export const OPENAI_CACHE_KEY_ENV = "PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY";

export const NO_OPENAI_CACHE_KEY_ENV = "PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY";

export const TOOL_ORDER_ENV = "PI_CACHE_OPTIMIZER_TOOL_ORDER";

export const FOOTER_MODE_ENV = "PI_CACHE_OPTIMIZER_FOOTER_MODE";

export type FooterStatsMode = "session" | "total" | "process";

export type FooterStatsModeSource = "config" | "env" | "default";

export type PersistedCacheOptimizerConfigV1 = {
  version: 1;
  footerMode?: FooterStatsMode;
};

export type PersistedCacheOptimizerFeature = "promptRewrite" | "virtualRewrite" | "skillCompression" | "openAICacheKey" | "toolOrder";

export type PersistedCacheOptimizerConfigV2 = {
  version: 2;
  footerMode?: FooterStatsMode;
  promptCacheKey?: {
    omit?: string[];
  };
};

export type PersistedCacheOptimizerConfigV3 = {
  version: 2 | 3;
  footerMode?: FooterStatsMode;
  promptCacheKey?: { omit?: string[] };
  features?: Partial<Record<PersistedCacheOptimizerFeature, boolean>>;
};

export type PersistedCacheOptimizerConfig = PersistedCacheOptimizerConfigV1 | PersistedCacheOptimizerConfigV2 | PersistedCacheOptimizerConfigV3;

export let runtimeOptimizerEnabled = true;

export function isEnabledEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function featureEnabled(
  feature: PersistedCacheOptimizerFeature,
  envName: string,
  defaultValue: boolean,
  env: MutableEnv = process.env,
  config: PersistedCacheOptimizerConfigV3 = persistedCacheOptimizerConfig,
): boolean {
  const configured = config.features?.[feature];
  if (configured !== undefined) return configured;
  if (feature === "virtualRewrite") return isEnabledEnv(env[envName]);
  if (feature === "promptRewrite" || feature === "skillCompression" || feature === "openAICacheKey") {
    return !isEnabledEnv(env[envName]);
  }
  return isEnabledEnv(env[envName]) || defaultValue;
}

export function isToolOrderEnabled(env: MutableEnv = process.env): boolean {
  return runtimeOptimizerEnabled && featureEnabled("toolOrder", TOOL_ORDER_ENV, false);
}

export function parseFooterStatsMode(value: unknown): FooterStatsMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "session" || normalized === "total" || normalized === "process" ? normalized : undefined;
}

export function parsePersistedCacheOptimizerConfig(value: unknown): PersistedCacheOptimizerConfig | undefined {
  const record = asRecord(value);
  if (!record || (record.version !== 1 && record.version !== 2 && record.version !== 3)) return undefined;
  const allowedTopLevel = new Set(record.version === 1 ? ["version", "footerMode"] : record.version === 2 ? ["version", "footerMode", "promptCacheKey"] : ["version", "footerMode", "promptCacheKey", "features"]);
  if (Object.keys(record).some((key) => !allowedTopLevel.has(key))) return undefined;
  const footerMode = parseFooterStatsMode(record.footerMode);
  if (record.footerMode !== undefined && !footerMode) return undefined;
  if (record.version === 1) return { version: 1, ...(footerMode ? { footerMode } : {}) };

  const rawFeatures = record.version === 3 ? record.features : undefined;
  if (rawFeatures !== undefined && !asRecord(rawFeatures)) return undefined;
  const featuresRecord = asRecord(rawFeatures);
  const featureNames = new Set<PersistedCacheOptimizerFeature>(["promptRewrite", "virtualRewrite", "skillCompression", "openAICacheKey", "toolOrder"]);
  if (featuresRecord && Object.keys(featuresRecord).some((key) => !featureNames.has(key as PersistedCacheOptimizerFeature) || typeof featuresRecord[key] !== "boolean")) return undefined;

  const rawPromptCacheKey = record.promptCacheKey;
  if (rawPromptCacheKey !== undefined && !asRecord(rawPromptCacheKey)) return undefined;
  const promptCacheKey = asRecord(rawPromptCacheKey);
  if (promptCacheKey && Object.keys(promptCacheKey).some((key) => key !== "omit")) return undefined;
  const omit = promptCacheKey?.omit;
  if (omit !== undefined && (!Array.isArray(omit) || omit.some((value): value is string => !isNonEmptyString(value)))) return undefined;
  const stringOmit = omit as string[] | undefined;
  const uniqueOmit = stringOmit ? [...new Set(stringOmit.map((value) => value.trim()))].sort() : undefined;
  return {
    version: record.version === 3 ? 3 : 2,
    ...(footerMode ? { footerMode } : {}),
    ...(uniqueOmit && uniqueOmit.length > 0 ? { promptCacheKey: { omit: uniqueOmit } } : {}),
    ...(featuresRecord ? { features: Object.fromEntries(Object.entries(featuresRecord)) as Partial<Record<PersistedCacheOptimizerFeature, boolean>> } : {}),
  } as PersistedCacheOptimizerConfigV3;
}

export function normalizePersistedCacheOptimizerConfig(value: PersistedCacheOptimizerConfig | undefined): PersistedCacheOptimizerConfigV3 {
  if (!value) return { version: 2 };
  const features = value.version === 3 ? value.features : undefined;
  return {
    version: features ? 3 : 2,
    ...(value.footerMode ? { footerMode: value.footerMode } : {}),
    ...(value.version !== 1 && value.promptCacheKey ? { promptCacheKey: value.promptCacheKey } : {}),
    ...(features ? { features } : {}),
  };
}

export function readPersistedCacheOptimizerConfig(configPath: string = CONFIG_FILE_PATH): PersistedCacheOptimizerConfigV3 {
  try {
    return normalizePersistedCacheOptimizerConfig(parsePersistedCacheOptimizerConfig(JSON.parse(readFileSync(configPath, "utf8"))));
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to read optimizer config; using defaults`, error);
    return { version: 2 };
  }
}

export async function writePersistedCacheOptimizerConfigUnlocked(
  config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3,
  configPath: string,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const payloadText = JSON.stringify(normalizePersistedCacheOptimizerConfig(config), null, 2) + "\n";
  let targetInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  let targetMode = 0o600;
  let targetHash: string | undefined;
  try {
    targetInfo = await lstat(configPath);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error("optimizer config is not a regular file; no changes were made");
    const targetText = await readFile(configPath, "utf8");
    targetMode = targetInfo.mode & 0o7777;
    targetHash = hashText(targetText);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  if (targetInfo) {
    await atomicReplaceTextFilePreservingMode(configPath, payloadText, targetMode, "config", {
      identity: targetInfo,
      hash: targetHash,
      mode: targetMode,
    });
    return;
  }

  await atomicCreateTextFileNoReplace(configPath, payloadText, targetMode, "config");
}

export async function writePersistedCacheOptimizerConfig(
  config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3,
  configPath: string = CONFIG_FILE_PATH,
): Promise<void> {
  await withModelsJsonTransactionLock(() => writePersistedCacheOptimizerConfigUnlocked(config, configPath));
}

export async function writePersistedFooterModeUnlocked(
  mode: FooterStatsMode,
  configPath: string,
): Promise<void> {
  let version: 1 | 2 | 3 = 1;
  let raw: PersistedCacheOptimizerConfig | undefined;
  let targetExists = false;
  try {
    raw = parsePersistedCacheOptimizerConfig(JSON.parse(readFileSync(configPath, "utf8")));
    targetExists = true;
    if (!raw) throw new Error("invalid footer config schema");
    version = raw.version === 3 ? 3 : raw.version === 2 ? 2 : 1;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw new Error("invalid footer config schema");
  }
  const current = normalizePersistedCacheOptimizerConfig(raw);
  if (version === 1 && !current.promptCacheKey) {
    await mkdir(dirname(configPath), { recursive: true });
    const targetInfo = targetExists ? await lstat(configPath) : undefined;
    if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) throw new Error("optimizer config is not a regular file; no changes were made");
    const targetText = targetInfo ? await readFile(configPath, "utf8") : undefined;
    const targetMode = targetInfo ? targetInfo.mode & 0o7777 : 0o600;
    const footerText = JSON.stringify({ version: 1, footerMode: mode }, null, 2) + "\n";
    if (targetInfo && targetText !== undefined) {
      await atomicReplaceTextFilePreservingMode(configPath, footerText, targetMode, "config-footer", {
        identity: targetInfo,
        hash: hashText(targetText),
        mode: targetMode,
      });
    } else {
      await atomicCreateTextFileNoReplace(configPath, footerText, targetMode, "config-footer");
    }
    return;
  }
  await writePersistedCacheOptimizerConfigUnlocked({ ...current, version: 3, footerMode: mode } as PersistedCacheOptimizerConfigV3, configPath);
}

export async function writePersistedFooterMode(
  mode: FooterStatsMode,
  configPath: string = CONFIG_FILE_PATH,
): Promise<void> {
  await withModelsJsonTransactionLock(() => writePersistedFooterModeUnlocked(mode, configPath));
}

export async function writePersistedFeature(feature: PersistedCacheOptimizerFeature, enabled: boolean): Promise<void> {
  const current = readPersistedCacheOptimizerConfig();
  const next: PersistedCacheOptimizerConfigV3 = {
    ...current,
    version: 3,
    features: { ...(current.features ?? {}), [feature]: enabled },
  };
  await writePersistedCacheOptimizerConfig(next);
  setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
}

export function resolveFooterStatsMode(
  configuredMode: FooterStatsMode | undefined,
  env: MutableEnv = process.env,
): { mode: FooterStatsMode; source: FooterStatsModeSource } {
  if (configuredMode) return { mode: configuredMode, source: "config" };
  const envMode = parseFooterStatsMode(env[FOOTER_MODE_ENV]);
  return envMode ? { mode: envMode, source: "env" } : { mode: "session", source: "default" };
}

export function footerStatsMode(
  env: MutableEnv = process.env,
  configuredMode: FooterStatsMode | undefined = persistedFooterStatsMode,
): FooterStatsMode {
  return resolveFooterStatsMode(configuredMode, env).mode;
}

export let persistedCacheOptimizerConfig = readPersistedCacheOptimizerConfig();

export let persistedFooterStatsMode = persistedCacheOptimizerConfig.footerMode;

export function isDisabledEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

export function shouldInjectOpenAIPromptCacheKey(): boolean {
  if (!runtimeOptimizerEnabled) return false;
  if (!featureEnabled("openAICacheKey", NO_OPENAI_CACHE_KEY_ENV, true)) return false;
  if (isDisabledEnv(process.env[OPENAI_CACHE_KEY_ENV])) return false;
  return true;
}

export function setPersistedCacheOptimizerConfig(config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3): void {
  persistedCacheOptimizerConfig = normalizePersistedCacheOptimizerConfig(config);
  persistedFooterStatsMode = persistedCacheOptimizerConfig.footerMode;
}

export function setRuntimeOptimizerEnabled(enabled: boolean, env: MutableEnv = process.env): void {
  runtimeOptimizerEnabled = enabled;
  if (enabled) {
    requestLongCacheRetention(env);
  } else {
    restoreCacheRetentionEnv(STARTUP_CACHE_RETENTION_ENV, env);
  }
}

export function isRuntimeOptimizerEnabled(): boolean {
  return runtimeOptimizerEnabled;
}

export function readPersistedFooterMode(configPath: string = CONFIG_FILE_PATH): FooterStatsMode | undefined {
  return readPersistedCacheOptimizerConfig(configPath).footerMode;
}

export function getOptimizerRuntimeModeLines(): string[] {
  const state = runtimeOptimizerEnabled ? "enabled" : "disabled";
  const lines: string[] = [];
  lines.push(`Runtime state: ${state}`);
  const promptRewriteActive = runtimeOptimizerEnabled && featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true);
  lines.push(`• Prompt rewrite: ${promptRewriteActive ? "on" : "off"} (in-place: session-overview churn strip, skill list compression; never reorders the prompt)`);
  lines.push(`• Native virtual rewrite: ${featureEnabled("virtualRewrite", VIRTUAL_REWRITE_ENV, false) ? "opt-in" : "off"}`);
  const skillCompressionSetting = featureEnabled("skillCompression", NO_SKILL_COMPRESSION_ENV, true);
  // Compression runs inside prompt rewrite, so its own switch is not enough to make it active.
  lines.push(`• Skill compression: ${!skillCompressionSetting ? "off" : promptRewriteActive ? "on" : "on (inactive: prompt rewrite is off)"}`);
  lines.push(`• Deterministic tool ordering: ${isToolOrderEnabled() ? "on (verified built-in payloads, opt-in)" : "off"}`);
  lines.push(`• OpenAI prompt_cache_key fallback: ${shouldInjectOpenAIPromptCacheKey() ? "on" : "off"}`);
  lines.push(`• Footer cache stats: on${runtimeOptimizerEnabled ? "" : " (comparison mode)"}`);
  lines.push(`• Compat warnings: ${runtimeOptimizerEnabled ? "on" : "off"}`);
  lines.push(`• ${PI_CACHE_RETENTION_ENV}: ${process.env[PI_CACHE_RETENTION_ENV] ?? "(unset)"}`);
  lines.push(`• Persistent feature overrides: ${Object.keys(persistedCacheOptimizerConfig.features ?? {}).length > 0 ? "configured" : "none"}`);
  if (!runtimeOptimizerEnabled) {
    lines.push("This is a current-process switch. Run /reload or restart Pi to return to startup behavior.");
  } else if (!featureEnabled("promptRewrite", NO_PROMPT_REWRITE_ENV, true) || !shouldInjectOpenAIPromptCacheKey()) {
    lines.push("Some features are still disabled by environment variables.");
  }
  return lines;
}

export function formatPersistentFeatureConfig(): string {
  const features = persistedCacheOptimizerConfig.features ?? {};
  const lines = ["Persistent feature configuration:"];
  const entries: Array<[string, PersistedCacheOptimizerFeature, string, boolean]> = [
    ["Prompt rewrite", "promptRewrite", NO_PROMPT_REWRITE_ENV, true],
    ["Native virtual rewrite", "virtualRewrite", VIRTUAL_REWRITE_ENV, false],
    ["Skill compression", "skillCompression", NO_SKILL_COMPRESSION_ENV, true],
    ["OpenAI cache key", "openAICacheKey", NO_OPENAI_CACHE_KEY_ENV, true],
    ["Tool ordering", "toolOrder", TOOL_ORDER_ENV, false],
  ];
  for (const [label, feature, envName, defaultValue] of entries) {
    const source = features[feature] !== undefined ? "config" : process.env[envName] !== undefined ? "env" : "default";
    lines.push(`• ${label}: ${featureEnabled(feature, envName, defaultValue) ? "on" : "off"} (${source})`);
  }
  return lines.join("\n");
}

export function formatOptimizerRuntimeMode(): string {
  return getOptimizerRuntimeModeLines().join("\n");
}

export const NO_PROMPT_REWRITE_ENV = "PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE";

export const NO_SKILL_COMPRESSION_ENV = "PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION";

export const VIRTUAL_REWRITE_ENV = "PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE";
