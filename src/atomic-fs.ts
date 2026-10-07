import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { LOG_PREFIX, asRecord, getErrorCode, isProcessAlive } from "./common.ts";
import { MODELS_TRANSACTION_LOCK_PATH, MODELS_TRANSACTION_LOCK_STALE_MS, MODELS_TRANSACTION_LOCK_WAIT_MS, STATE_DIR } from "./paths.ts";

/**
 * Generate a unique UTC timestamp component for backup filenames.
 * Milliseconds, process id, and an in-process sequence prevent collisions.
 */
export let backupSequence = 0;

export function backupTimestamp(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  const ms = String(now.getUTCMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}T${h}${min}${s}${ms}Z-${process.pid}-${backupSequence++}`;
}

export function uniqueTempPath(targetPath: string, purpose: string): string {
  return `${targetPath}.${process.pid}.${Date.now()}.${backupSequence++}.${purpose}.tmp`;
}

/**
 * Create `path` exclusively (`wx`) and flush it to stable storage before the
 * caller renames or links it into place, so a crash right after the commit
 * cannot leave an empty or truncated models.json / config file.
 */
export async function writeFileExclusiveDurable(path: string, content: string, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flush an already-written file (for example a copyFile result) to stable storage. */
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type FileIdentity = { dev: number | bigint; ino: number | bigint };

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  // Some platforms do not expose a meaningful inode. On those platforms the
  // hash checks around the transaction remain authoritative.
  const leftDev = Number(left.dev);
  const rightDev = Number(right.dev);
  const leftIno = Number(left.ino);
  const rightIno = Number(right.ino);
  return leftIno === 0 || rightIno === 0 || (leftDev === rightDev && leftIno === rightIno);
}

export type AtomicTargetGuard = {
  identity?: FileIdentity;
  hash?: string;
  mode?: number;
};

export async function validateAtomicTarget(
  targetPath: string,
  guard?: AtomicTargetGuard,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const info = await lstat(targetPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("target is not a regular file; refusing atomic replacement");
  }
  if (guard?.identity && !sameFileIdentity(guard.identity, info)) {
    throw new Error("target changed during atomic replacement");
  }
  if (guard?.mode !== undefined && (info.mode & 0o7777) !== guard.mode) {
    throw new Error("target access mode changed during atomic replacement");
  }
  if (guard?.hash !== undefined) {
    const text = await readFile(targetPath, "utf8");
    if (hashText(text) !== guard.hash) {
      throw new Error("target content changed during atomic replacement");
    }
  }
  return info;
}

export async function atomicReplaceTextFilePreservingMode(
  targetPath: string,
  content: string,
  mode: number,
  purpose: string,
  guard?: AtomicTargetGuard,
  /** Test-only race injector; production callers leave this undefined. */
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const initialTargetInfo = await validateAtomicTarget(targetPath, guard);
  const tempPath = uniqueTempPath(targetPath, purpose);
  try {
    // `wx` makes the unique temporary path non-overwriting even if a hostile
    // or stale file appears between name generation and the write.
    await writeFileExclusiveDurable(tempPath, content, mode);
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) {
      throw new Error("temporary replacement is not a regular file");
    }
    await chmod(tempPath, mode);
    await validateAtomicTarget(targetPath, {
      ...guard,
      identity: initialTargetInfo,
      mode,
    });
    if (beforeRename) await beforeRename();
    await validateAtomicTarget(targetPath, {
      ...guard,
      identity: initialTargetInfo,
      mode,
    });
    await rename(tempPath, targetPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (getErrorCode(cleanupError) !== "ENOENT") {
        console.warn(`${LOG_PREFIX}: failed to remove temporary models.json file`, cleanupError);
      }
    }
    throw error;
  }
}

export async function atomicCreateTextFileNoReplace(
  targetPath: string,
  content: string,
  mode: number,
  purpose: string,
  /** Test-only race injector; production callers leave this undefined. */
  beforeLink?: () => Promise<void>,
): Promise<void> {
  const tempPath = uniqueTempPath(targetPath, purpose);
  try {
    await writeFileExclusiveDurable(tempPath, content, mode);
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) {
      throw new Error("temporary creation is not a regular file");
    }
    await chmod(tempPath, mode);
    // A hard link gives us an atomic no-replace create. Unlike rename(), it
    // cannot overwrite a file that appeared after the absence check.
    if (beforeLink) await beforeLink();
    await link(tempPath, targetPath);
    await unlink(tempPath).catch((cleanupError) => {
      console.warn(`${LOG_PREFIX}: committed config file but failed to remove its temporary hard link`, cleanupError);
    });
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (getErrorCode(cleanupError) !== "ENOENT") {
        console.warn(`${LOG_PREFIX}: failed to remove temporary config file`, cleanupError);
      }
    }
    throw error;
  }
}

export async function atomicRestoreFileFromBackup(
  backupPath: string,
  targetPath: string,
  mode: number,
  guard?: AtomicTargetGuard & { backupHash?: string },
  /** Test-only race injector; production callers leave this undefined. */
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const backupInfo = await lstat(backupPath);
  if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
    throw new Error("backup is not a regular file; refusing atomic restore");
  }
  if (guard?.backupHash !== undefined) {
    const backupText = await readFile(backupPath, "utf8");
    if (hashText(backupText) !== guard.backupHash) {
      throw new Error("backup content changed during atomic restore");
    }
  }
  const targetInfo = await validateAtomicTarget(targetPath, guard);
  const tempPath = uniqueTempPath(targetPath, "restore");
  try {
    await copyFile(backupPath, tempPath, fsConstants.COPYFILE_EXCL);
    await syncFile(tempPath);
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) {
      throw new Error("temporary restore is not a regular file");
    }
    await chmod(tempPath, mode);
    const tempText = await readFile(tempPath, "utf8");
    if (guard?.backupHash !== undefined && hashText(tempText) !== guard.backupHash) {
      throw new Error("backup content changed during atomic restore");
    }
    await validateAtomicTarget(targetPath, {
      ...guard,
      identity: targetInfo,
    });
    if (beforeRename) await beforeRename();
    await validateAtomicTarget(targetPath, {
      ...guard,
      identity: targetInfo,
    });
    await rename(tempPath, targetPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (getErrorCode(cleanupError) !== "ENOENT") {
        console.warn(`${LOG_PREFIX}: failed to remove temporary restore file`, cleanupError);
      }
    }
    throw error;
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function withModelsJsonTransactionLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(STATE_DIR, { recursive: true });
  const deadline = Date.now() + MODELS_TRANSACTION_LOCK_WAIT_MS;
  const ownerToken = randomUUID();
  const ownerText = JSON.stringify({ pid: process.pid, token: ownerToken });
  let ownedLockIdentity: FileIdentity | undefined;
  while (true) {
    try {
      // A single O_EXCL file is the lease: unlike mkdir-then-owner-file, there
      // is no ownerless crash window between creating the lock and identifying
      // its owner.
      await writeFile(MODELS_TRANSACTION_LOCK_PATH, ownerText, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const lockInfo = await lstat(MODELS_TRANSACTION_LOCK_PATH);
      if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
        throw new Error("models.json transaction lock path is unsafe");
      }
      ownedLockIdentity = lockInfo;
      break;
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") throw error;
      const lockInfo = await lstat(MODELS_TRANSACTION_LOCK_PATH).catch(() => undefined);
      if (!lockInfo) continue;
      if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
        throw new Error("models.json transaction lock path is unsafe");
      }
      let staleOwnerPid: number | undefined;
      try {
        const owner = asRecord(JSON.parse(await readFile(MODELS_TRANSACTION_LOCK_PATH, "utf8")));
        if (typeof owner?.pid === "number") staleOwnerPid = owner.pid;
      } catch {}
      const stale = Date.now() - lockInfo.mtimeMs > MODELS_TRANSACTION_LOCK_STALE_MS;
      if (stale && (staleOwnerPid === undefined || !isProcessAlive(staleOwnerPid))) {
        // Recheck identity immediately before unlinking so a recovered owner
        // cannot delete a replacement lease created at the same path.
        const currentLock = await lstat(MODELS_TRANSACTION_LOCK_PATH).catch(() => undefined);
        if (currentLock && sameFileIdentity(lockInfo, currentLock)) {
          await unlink(MODELS_TRANSACTION_LOCK_PATH).catch((unlinkError) => {
            if (getErrorCode(unlinkError) !== "ENOENT") throw unlinkError;
          });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("another cache-optimizer models.json transaction is still running");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await operation();
  } finally {
    // Only the matching inode and owner token may remove the lease. A
    // recovered/replaced lock belongs to another transaction.
    try {
      const currentLock = await lstat(MODELS_TRANSACTION_LOCK_PATH);
      if (
        ownedLockIdentity &&
        !currentLock.isSymbolicLink() &&
        currentLock.isFile() &&
        sameFileIdentity(ownedLockIdentity, currentLock) &&
        await readFile(MODELS_TRANSACTION_LOCK_PATH, "utf8") === ownerText
      ) {
        await unlink(MODELS_TRANSACTION_LOCK_PATH);
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(`${LOG_PREFIX}: failed to remove models.json transaction lock`, error);
      }
    }
  }
}

export async function readRegularTextFile(path: string): Promise<{ text: string; mode: number }> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("file is not a regular file");
  }
  const text = await readFile(path, "utf8");
  const afterRead = await lstat(path);
  if (
    afterRead.isSymbolicLink() ||
    !afterRead.isFile() ||
    !sameFileIdentity(info, afterRead)
  ) {
    throw new Error("file changed while it was being read");
  }
  return {
    text,
    mode: afterRead.mode & 0o7777,
  };
}
