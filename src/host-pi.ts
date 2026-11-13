import * as piCodingAgent from "@earendil-works/pi-coding-agent";

/** Host Pi version; undefined when the host does not export it. */
export const HOST_PI_VERSION: string | undefined = (() => {
  const version = (piCodingAgent as Record<string, unknown>).VERSION;
  return typeof version === "string" ? version : undefined;
})();

/** Pi's own `cacheWarming` default from the host, independent of version strings. */
export function readHostCacheWarmingDefault(): unknown {
  const settingsManager: unknown = (piCodingAgent as Record<string, unknown>).SettingsManager;
  const inMemory = typeof settingsManager === "function" ? (settingsManager as { inMemory?: unknown }).inMemory : undefined;
  if (typeof inMemory !== "function") return undefined;
  const instance: unknown = inMemory.call(settingsManager, {});
  if (typeof instance !== "object" || instance === null) return undefined;
  const getMode = (instance as { getCacheWarmingMode?: unknown }).getCacheWarmingMode;
  return typeof getMode === "function" ? getMode.call(instance) : undefined;
}
