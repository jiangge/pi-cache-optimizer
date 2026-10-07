import { type FileIdentity, atomicCreateTextFileNoReplace, atomicReplaceTextFilePreservingMode, atomicRestoreFileFromBackup, backupTimestamp, hashText, sameFileIdentity, uniqueTempPath, validateAtomicTarget, withModelsJsonTransactionLock, writeFileExclusiveDurable } from "./atomic-fs.ts";
import { LOG_PREFIX, type PiModel, asRecord, getErrorCode } from "./common.ts";
import { CONFIG_FILE_PATH, type PersistedCacheOptimizerConfigV3, normalizePersistedCacheOptimizerConfig, parsePersistedCacheOptimizerConfig } from "./config.ts";
import { isReceiptTimestamp, isSafeReceiptText, isSha256 } from "./fix-types.ts";
import { modelKey } from "./model-identity.ts";
import { STATE_DIR } from "./paths.ts";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const CONFIG_RECEIPT_FILE_NAME = "pi-cache-optimizer-config-receipt.json";

export const CONFIG_RECEIPT_PATH = join(STATE_DIR, CONFIG_RECEIPT_FILE_NAME);

export type PromptCacheKeyConfigReceipt = {
  version: 2;
  kind: "pi-cache-optimizer-config-receipt";
  transactionId: string;
  provider: string;
  modelId: string;
  beforeHash: string;
  afterHash: string;
  backupFile: string;
  targetExistedBefore: boolean;
  targetHadModelKey: boolean;
  addedModelKey: string;
  createdAt: number;
  appliedAt: number;
  status?: "rolled_back";
  rolledBackAt?: number;
};

export type PromptCacheKeyConfigReceiptSnapshot = {
  receipt: PromptCacheKeyConfigReceipt;
  receiptPath: string;
  hash: string;
  identity: FileIdentity;
};

export function configReceiptBackupPath(receipt: PromptCacheKeyConfigReceipt, receiptPath: string = CONFIG_RECEIPT_PATH): string {
  return join(dirname(receiptPath), receipt.backupFile);
}

export function parsePromptCacheKeyConfigReceipt(value: unknown): PromptCacheKeyConfigReceipt | undefined {
  const record = asRecord(value);
  if (!record || (record.version !== 1 && record.version !== 2) || record.kind !== "pi-cache-optimizer-config-receipt") return undefined;
  const allowed = new Set(record.version === 1
    ? ["version", "kind", "transactionId", "provider", "modelId", "beforeHash", "afterHash", "backupFile", "targetExistedBefore", "createdAt", "appliedAt", "status", "rolledBackAt"]
    : ["version", "kind", "transactionId", "provider", "modelId", "beforeHash", "afterHash", "backupFile", "targetExistedBefore", "targetHadModelKey", "addedModelKey", "createdAt", "appliedAt", "status", "rolledBackAt"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  if (![record.transactionId, record.provider, record.modelId].every(isSafeReceiptText)) return undefined;
  if (!isSha256(record.beforeHash) || !isSha256(record.afterHash) || record.beforeHash === record.afterHash) return undefined;
  if (!isSafeReceiptText(record.backupFile) || basename(record.backupFile) !== record.backupFile || !record.backupFile.startsWith("pi-cache-optimizer-config.backup-")) return undefined;
  if (
    typeof record.targetExistedBefore !== "boolean" ||
    !isReceiptTimestamp(record.createdAt) ||
    !isReceiptTimestamp(record.appliedAt) ||
    record.appliedAt < record.createdAt
  ) return undefined;
  const addedModelKey = `${record.provider}/${record.modelId}`;
  const targetHadModelKey = record.version === 1 ? false : record.targetHadModelKey;
  if (typeof targetHadModelKey !== "boolean") return undefined;
  if (record.version === 2 && (!isSafeReceiptText(record.addedModelKey) || record.addedModelKey !== addedModelKey)) return undefined;
  if (record.status !== undefined && record.status !== "rolled_back") return undefined;
  if (record.status === "rolled_back" && (!isReceiptTimestamp(record.rolledBackAt) || record.rolledBackAt < record.appliedAt)) return undefined;
  if (record.status === undefined && record.rolledBackAt !== undefined) return undefined;
  return {
    version: 2,
    kind: "pi-cache-optimizer-config-receipt",
    transactionId: String(record.transactionId),
    provider: String(record.provider),
    modelId: String(record.modelId),
    beforeHash: String(record.beforeHash).toLowerCase(),
    afterHash: String(record.afterHash).toLowerCase(),
    backupFile: String(record.backupFile),
    targetExistedBefore: record.targetExistedBefore,
    targetHadModelKey,
    addedModelKey,
    createdAt: Number(record.createdAt),
    appliedAt: Number(record.appliedAt),
    ...(record.status === "rolled_back" ? { status: "rolled_back", rolledBackAt: Number(record.rolledBackAt) } : {}),
  };
}

export async function assertPromptCacheKeyConfigReceiptSnapshotUnchanged(
  snapshot: PromptCacheKeyConfigReceiptSnapshot,
): Promise<void> {
  const info = await lstat(snapshot.receiptPath);
  if (info.isSymbolicLink() || !info.isFile() || !sameFileIdentity(snapshot.identity, info)) {
    throw new Error("prompt-cache-key receipt changed since the rollback preview");
  }
  const text = await readFile(snapshot.receiptPath, "utf8");
  const afterRead = await lstat(snapshot.receiptPath);
  if (
    afterRead.isSymbolicLink() ||
    !afterRead.isFile() ||
    !sameFileIdentity(info, afterRead) ||
    hashText(text) !== snapshot.hash
  ) {
    throw new Error("prompt-cache-key receipt changed since the rollback preview");
  }
}

export async function writePromptCacheKeyConfigReceipt(
  receipt: PromptCacheKeyConfigReceipt,
  receiptPath: string = CONFIG_RECEIPT_PATH,
  expectedSnapshot?: PromptCacheKeyConfigReceiptSnapshot,
  /** Test-only race injector; production callers leave this undefined. */
  beforeRename?: () => Promise<void>,
): Promise<void> {
  if (!parsePromptCacheKeyConfigReceipt(receipt)) throw new Error("invalid prompt cache key config receipt");
  if (expectedSnapshot?.receiptPath !== undefined && expectedSnapshot.receiptPath !== receiptPath) {
    throw new Error("prompt-cache-key receipt path changed since the rollback preview");
  }
  if (expectedSnapshot) await assertPromptCacheKeyConfigReceiptSnapshotUnchanged(expectedSnapshot);
  await mkdir(dirname(receiptPath), { recursive: true });
  let existingReceiptInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("invalid prompt-cache-key receipt path");
    existingReceiptInfo = info;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  const tempPath = uniqueTempPath(receiptPath, "config-receipt");
  try {
    await writeFileExclusiveDurable(tempPath, JSON.stringify(receipt, null, 2) + "\n", 0o600);
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) throw new Error("invalid temporary prompt-cache-key receipt");
    await chmod(tempPath, 0o600);
    const assertDestinationUnchanged = async (): Promise<void> => {
      try {
        const currentInfo = await lstat(receiptPath);
        if (!existingReceiptInfo || !sameFileIdentity(existingReceiptInfo, currentInfo)) {
          throw new Error("prompt-cache-key receipt changed during atomic write");
        }
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT" || existingReceiptInfo) throw error;
      }
      if (expectedSnapshot) await assertPromptCacheKeyConfigReceiptSnapshotUnchanged(expectedSnapshot);
    };
    await assertDestinationUnchanged();
    if (beforeRename) await beforeRename();
    await assertDestinationUnchanged();
    if (existingReceiptInfo) {
      await rename(tempPath, receiptPath);
    } else {
      await link(tempPath, receiptPath);
      await unlink(tempPath).catch((cleanupError) => {
        console.warn(`${LOG_PREFIX}: committed prompt-cache-key receipt but failed to remove its temporary hard link`, cleanupError);
      });
    }
  } catch (error) {
    await unlink(tempPath).catch((cleanupError) => { if (getErrorCode(cleanupError) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to remove temporary config receipt`, cleanupError); });
    throw error;
  }
}

export async function applyPromptCacheKeyConfigFixUnderLock(
  model: PiModel,
  configPath: string = CONFIG_FILE_PATH,
  receiptPath: string = CONFIG_RECEIPT_PATH,
): Promise<{ receipt: PromptCacheKeyConfigReceipt; backupPath: string }> {
  await mkdir(dirname(configPath), { recursive: true });
  let originalText = "";
  let targetExistedBefore = false;
  let mode = 0o600;
  try {
    const info = await lstat(configPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("optimizer config is not a regular file; no changes were made");
    originalText = await readFile(configPath, "utf8");
    targetExistedBefore = true;
    mode = info.mode & 0o7777;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  const parsedCurrent = targetExistedBefore ? parsePersistedCacheOptimizerConfig(JSON.parse(originalText)) : undefined;
  if (targetExistedBefore && !parsedCurrent) throw new Error("optimizer config is invalid; no changes were made");
  const current = normalizePersistedCacheOptimizerConfig(parsedCurrent);
  const key = modelKey(model);
  const existingOmit = current.promptCacheKey?.omit ?? [];
  const targetHadModelKey = existingOmit.includes(key);
  if (targetHadModelKey) throw new Error("prompt-cache-key is already configured; no changes were made");
  const omit = [...new Set([...existingOmit, key])].sort();
  // Serialize through the normalizer so a v3 config (with feature overrides) stays v3; writing
  // `version: 2` next to `features` would make the whole file unreadable.
  const next = normalizePersistedCacheOptimizerConfig({ ...current, promptCacheKey: { omit } });
  const modifiedText = JSON.stringify(next, null, 2) + "\n";
  const beforeHash = hashText(originalText);
  const afterHash = hashText(modifiedText);
  const originalInfo = targetExistedBefore ? await lstat(configPath) : undefined;
  const backupFile = `pi-cache-optimizer-config.backup-${backupTimestamp()}`;
  const backupPath = join(dirname(configPath), backupFile);
  if (targetExistedBefore) {
    await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
    await chmod(backupPath, mode);
  }
  const tempPath = uniqueTempPath(configPath, "config-fix");
  let committedInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    await writeFileExclusiveDurable(tempPath, modifiedText, mode);
    await chmod(tempPath, mode);
    if (originalInfo) {
      await validateAtomicTarget(configPath, { identity: originalInfo, hash: beforeHash, mode });
    } else {
      try {
        await lstat(configPath);
        throw new Error("optimizer config appeared during the fix; no changes were made");
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") throw error;
      }
    }
    if (originalInfo) {
      await rename(tempPath, configPath);
      committedInfo = await lstat(configPath);
    } else {
      // Do not overwrite a config created after the absence check. Record the
      // committed inode before cleaning up its temporary hard-link name so a
      // cleanup failure can still compensate the config transaction.
      await link(tempPath, configPath);
      committedInfo = await lstat(configPath);
      await unlink(tempPath).catch((cleanupError) => {
        console.warn(`${LOG_PREFIX}: committed optimizer config but failed to remove its temporary hard link`, cleanupError);
      });
    }
    const receipt: PromptCacheKeyConfigReceipt = {
      version: 2,
      kind: "pi-cache-optimizer-config-receipt",
      transactionId: randomUUID(),
      provider: model.provider,
      modelId: model.id,
      beforeHash,
      afterHash,
      backupFile,
      targetExistedBefore,
      targetHadModelKey,
      addedModelKey: key,
      createdAt: Date.now(),
      appliedAt: Date.now(),
    };
    await writePromptCacheKeyConfigReceipt(receipt, receiptPath);
    return { receipt, backupPath };
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    try {
      if (targetExistedBefore && committedInfo) {
        await atomicRestoreFileFromBackup(backupPath, configPath, mode, { identity: committedInfo, hash: afterHash, mode });
      } else if (!targetExistedBefore && committedInfo) {
        await validateAtomicTarget(configPath, { identity: committedInfo, hash: afterHash, mode });
        await unlink(configPath);
      }
    } catch (compensationError) {
      const writeMessage = error instanceof Error ? error.message : String(error);
      const compensationMessage = compensationError instanceof Error ? compensationError.message : String(compensationError);
      throw new Error(`prompt-cache-key fix receipt update failed (${writeMessage}) and config compensation failed (${compensationMessage})`);
    }
    throw error;
  }
}

export async function applyPromptCacheKeyConfigFix(
  model: PiModel,
  configPath: string = CONFIG_FILE_PATH,
  receiptPath: string = CONFIG_RECEIPT_PATH,
): Promise<{ receipt: PromptCacheKeyConfigReceipt; backupPath: string }> {
  return withModelsJsonTransactionLock(() => applyPromptCacheKeyConfigFixUnderLock(model, configPath, receiptPath));
}

export type PromptCacheKeyRollbackOptions = {
  /** Test-only race injector; production callers leave this undefined. */
  beforeReceiptRename?: () => Promise<void>;
};

export async function rollbackPromptCacheKeyConfigUnderLock(
  snapshot: PromptCacheKeyConfigReceiptSnapshot,
  configPath: string = CONFIG_FILE_PATH,
  receiptPath: string = CONFIG_RECEIPT_PATH,
  options: PromptCacheKeyRollbackOptions = {},
): Promise<void> {
  if (snapshot.receiptPath !== receiptPath) throw new Error("prompt-cache-key receipt path changed since the rollback preview");
  await assertPromptCacheKeyConfigReceiptSnapshotUnchanged(snapshot);
  const receipt = snapshot.receipt;
  const currentInfo = await lstat(configPath);
  if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) throw new Error("optimizer config is not a regular file; refusing to overwrite user changes");
  const currentText = await readFile(configPath, "utf8");
  const currentHash = hashText(currentText);
  const currentMode = currentInfo.mode & 0o7777;
  if (currentHash !== receipt.afterHash) throw new Error("optimizer config changed after the fix; refusing to overwrite user changes");
  const current = parsePersistedCacheOptimizerConfig(JSON.parse(currentText));
  if (!current) throw new Error("optimizer config is invalid; refusing to overwrite user changes");
  const key = `${receipt.provider}/${receipt.modelId}`;
  if (receipt.addedModelKey !== key) throw new Error("prompt-cache-key receipt identity does not match; refusing to change user config");
  if (receipt.targetHadModelKey) throw new Error("prompt-cache-key was already configured before this fix; refusing to remove user configuration");
  const omit = current.version !== 1 ? current.promptCacheKey?.omit ?? [] : [];
  if (!omit.includes(receipt.addedModelKey)) throw new Error("prompt-cache-key opt-out is no longer present; refusing to change user config");

  let rollbackResultText: string | undefined;
  let rollbackResultMode: number | undefined;
  let rollbackResultInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  const backupPath = configReceiptBackupPath(receipt, receiptPath);
  if (receipt.targetExistedBefore) {
    const backupInfo = await lstat(backupPath);
    if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) throw new Error("config backup is not a regular file");
    const backupText = await readFile(backupPath, "utf8");
    if (hashText(backupText) !== receipt.beforeHash) throw new Error("config backup hash does not match the fix receipt");
    rollbackResultText = backupText;
    rollbackResultMode = backupInfo.mode & 0o7777;
    await atomicRestoreFileFromBackup(
      backupPath,
      configPath,
      rollbackResultMode,
      { backupHash: receipt.beforeHash, identity: currentInfo, hash: currentHash, mode: currentMode },
    );
    rollbackResultInfo = await lstat(configPath);
  } else if (current.footerMode || omit.length > 1 || (current.version === 3 && current.features)) {
    const remaining = omit.filter((item) => item !== receipt.addedModelKey);
    const restored = normalizePersistedCacheOptimizerConfig({
      ...current,
      promptCacheKey: remaining.length > 0 ? { omit: remaining } : undefined,
    } as PersistedCacheOptimizerConfigV3);
    rollbackResultText = JSON.stringify(restored, null, 2) + "\n";
    rollbackResultMode = currentMode;
    await atomicReplaceTextFilePreservingMode(
      configPath,
      rollbackResultText,
      rollbackResultMode,
      "config-rollback",
      { identity: currentInfo, hash: currentHash, mode: currentMode },
    );
    rollbackResultInfo = await lstat(configPath);
  } else {
    await validateAtomicTarget(configPath, { identity: currentInfo, hash: currentHash, mode: currentMode });
    await unlink(configPath);
  }

  try {
    await writePromptCacheKeyConfigReceipt(
      { ...receipt, status: "rolled_back", rolledBackAt: Date.now() },
      receiptPath,
      snapshot,
      options.beforeReceiptRename,
    );
  } catch (receiptError) {
    // Receipt marking is part of the transaction. If it fails after the config
    // mutation, restore the exact post-fix config rather than leaving an
    // actionable receipt paired with an already-rolled-back file.
    try {
      if (rollbackResultText === undefined) {
        await atomicCreateTextFileNoReplace(configPath, currentText, currentMode, "config-rollback-compensation");
      } else {
        if (!rollbackResultInfo || rollbackResultMode === undefined) throw new Error("missing rollback result guard");
        await atomicReplaceTextFilePreservingMode(
          configPath,
          currentText,
          currentMode,
          "config-rollback-compensation",
          {
            identity: rollbackResultInfo,
            hash: hashText(rollbackResultText),
            mode: rollbackResultMode,
          },
        );
      }
    } catch (compensationError) {
      const receiptMessage = receiptError instanceof Error ? receiptError.message : String(receiptError);
      const compensationMessage = compensationError instanceof Error ? compensationError.message : String(compensationError);
      throw new Error(`prompt-cache-key rollback receipt update failed (${receiptMessage}) and config compensation failed (${compensationMessage})`);
    }
    throw receiptError;
  }
}

export async function rollbackPromptCacheKeyConfig(
  snapshot: PromptCacheKeyConfigReceiptSnapshot,
  configPath: string = CONFIG_FILE_PATH,
  receiptPath: string = CONFIG_RECEIPT_PATH,
  options: PromptCacheKeyRollbackOptions = {},
): Promise<void> {
  return withModelsJsonTransactionLock(() => rollbackPromptCacheKeyConfigUnderLock(snapshot, configPath, receiptPath, options));
}

export function isActionablePromptCacheKeyConfigReceipt(receipt: PromptCacheKeyConfigReceipt | undefined): receipt is PromptCacheKeyConfigReceipt {
  return receipt !== undefined && receipt.status === undefined;
}

export async function readPromptCacheKeyConfigReceiptSnapshot(
  receiptPath: string = CONFIG_RECEIPT_PATH,
): Promise<PromptCacheKeyConfigReceiptSnapshot | undefined> {
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    const text = await readFile(receiptPath, "utf8");
    const afterRead = await lstat(receiptPath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || !sameFileIdentity(info, afterRead)) return undefined;
    const receipt = parsePromptCacheKeyConfigReceipt(JSON.parse(text));
    if (!receipt) return undefined;
    return { receipt, receiptPath, hash: hashText(text), identity: afterRead };
  } catch {
    return undefined;
  }
}

export async function readPromptCacheKeyConfigReceipt(receiptPath: string = CONFIG_RECEIPT_PATH): Promise<PromptCacheKeyConfigReceipt | undefined> {
  return (await readPromptCacheKeyConfigReceiptSnapshot(receiptPath))?.receipt;
}
