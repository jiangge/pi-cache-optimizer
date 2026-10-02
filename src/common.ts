import { type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PiModel = NonNullable<ExtensionContext["model"]>;

export type ModelIdentity = Pick<PiModel, "provider" | "id">;

export type UnknownRecord = Record<string, unknown>;

export const LOG_PREFIX = "pi-cache-optimizer";

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

export function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === "EPERM";
  }
}
