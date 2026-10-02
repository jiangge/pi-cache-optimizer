import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/** Use Pi core's resolver so rebranded config names and env semantics stay aligned. */
export const STATE_DIR = getAgentDir();

export const FIX_RECEIPT_FILE_NAME = "pi-cache-optimizer-fix-receipt.json";

export const FIX_RECEIPT_PATH = join(STATE_DIR, FIX_RECEIPT_FILE_NAME);

export const MODELS_TRANSACTION_LOCK_PATH = join(STATE_DIR, "pi-cache-optimizer-models-transaction.lock");

export const MODELS_TRANSACTION_LOCK_STALE_MS = 60_000;

export const MODELS_TRANSACTION_LOCK_WAIT_MS = 5_000;

/** The real models.json path used for I/O. */
export const MODELS_JSON_PATH = join(STATE_DIR, "models.json");
