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

export type ModelsJsonFixReceiptV1 = {
  version: 1;
  kind: "pi-cache-optimizer-fix-receipt";
  transactionId: string;
  provider: string;
  modelId: string;
  placement: FixReceiptPlacement;
  targetExistedBefore: boolean;
  changedKeys: Record<string, FixReceiptCompatChange>;
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
