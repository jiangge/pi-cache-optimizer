import { isNonEmptyString } from "./common.ts";

export type FixReceiptPlacement = "provider" | "model" | "modelOverride";

export type ReceiptScalar = string | number | boolean | null;

export type ReceiptScalarState =
  | { present: false }
  | { present: true; value: ReceiptScalar };

export type FixReceiptCompatChange = {
  before: ReceiptScalarState;
  after: ReceiptScalarState;
};

/** Pi model-level prompt-cache lifetimes in seconds (`promptCache`). */
export type PromptCacheLifetimes = { short?: number; long?: number };

export function isValidPromptCacheLifetimes(value: unknown): value is PromptCacheLifetimes {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => key !== "short" && key !== "long")) return false;
  return keys.every((key) => {
    const seconds = record[key];
    return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0;
  });
}

export function samePromptCacheLifetimes(left: unknown, right: unknown): boolean {
  if (!isValidPromptCacheLifetimes(left) || !isValidPromptCacheLifetimes(right)) return false;
  return left.short === right.short && left.long === right.long;
}

/**
 * Version 1 receipts record scalar compat changes only. Version 2 receipts
 * also record a `promptCache` object the fix added (it never overwrites one),
 * so rollback can remove exactly that property. Older extension versions
 * reject version 2 receipts instead of misreading them.
 */
export type ModelsJsonFixReceiptV1 = {
  version: 1 | 2;
  kind: "pi-cache-optimizer-fix-receipt";
  transactionId: string;
  provider: string;
  modelId: string;
  placement: FixReceiptPlacement;
  targetExistedBefore: boolean;
  changedKeys: Record<string, FixReceiptCompatChange>;
  /** Version 2 only: the promptCache object added at the target (absent before). */
  promptCacheAdded?: PromptCacheLifetimes;
  beforeHash: string;
  afterHash: string;
  backupFile: string;
  createdAt: number;
  appliedAt: number;
  status?: "rolled_back";
  rolledBackAt?: number;
};

// Receipts are trusted input to a later rollback command, so their key set is
// deliberately narrower than the full models.json compat vocabulary. This
// prevents a corrupted or hand-edited receipt from turning rollback into a
// way to rewrite credentials, headers, routing, or arbitrary provider fields.
export const RECEIPT_COMPAT_KEYS = new Set([
  "sendSessionAffinityHeaders",
  "supportsLongCacheRetention",
  "requiresReasoningContentOnAssistantMessages",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "thinkingFormat",
  "supportsReasoningEffort",
]);

export interface FixSuggestion {
  providerLabel: string;
  modelId: string;
  compatKeys: Record<string, unknown>;
  /** Runtime-observed failures must never broaden a model-specific fix. */
  forceModelLevel?: boolean;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export function isSafeReceiptText(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isReceiptTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
