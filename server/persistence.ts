import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

const SAFE_PERSISTED_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

type AtomicWriteOptions = Readonly<{
  closeFile?: typeof closeSync;
  openDirectory?: typeof openSync;
  renameFile?: typeof renameSync;
  syncFile?: typeof fsyncSync;
  unlinkFile?: typeof unlinkSync;
  writeFile?: typeof writeFileSync;
}>;

function isSafePersistedFilename(fileName: string): boolean {
  return SAFE_PERSISTED_FILENAME_RE.test(fileName)
    && !fileName.endsWith(".")
    && !WINDOWS_RESERVED_BASENAME_RE.test(fileName);
}

/**
 * Durably replace a file without exposing a partially written target.
 *
 * The temporary file lives beside the target so rename remains atomic on
 * POSIX filesystems. `flush` syncs the completed temporary file before the
 * rename; syncing the parent directory then persists the directory entry.
 */
export function atomicWriteFileSync(
  directoryPath: string,
  fileName: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  if (!isSafePersistedFilename(fileName)) {
    throw new Error(`Invalid persisted filename: ${fileName}`);
  }
  const allowedDirectory = resolve(directoryPath);
  const filePath = resolve(allowedDirectory, fileName);
  if (dirname(filePath) !== allowedDirectory) {
    throw new Error(`Persisted file escapes its allowed directory: ${fileName}`);
  }

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const closeFile = options.closeFile ?? closeSync;
  const openDirectory = options.openDirectory ?? openSync;
  const renameFile = options.renameFile ?? renameSync;
  const syncFile = options.syncFile ?? fsyncSync;
  const unlinkFile = options.unlinkFile ?? unlinkSync;
  const writeFile = options.writeFile ?? writeFileSync;
  let renamed = false;

  try {
    writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    renameFile(temporaryPath, filePath);
    renamed = true;

    // Windows does not support opening directories as file descriptors.
    if (process.platform !== "win32") {
      const directoryFd = openDirectory(allowedDirectory, "r");
      let syncError: unknown;
      try {
        syncFile(directoryFd);
      } catch (error) {
        syncError = error;
      }
      try {
        closeFile(directoryFd);
      } catch (closeError) {
        if (syncError !== undefined) {
          throw new AggregateError(
            [syncError, closeError],
            `Directory sync and close both failed for ${allowedDirectory}`,
          );
        }
        throw closeError;
      }
      if (syncError !== undefined) throw syncError;
    }
  } catch (error) {
    if (!renamed) {
      try {
        unlinkFile(temporaryPath);
      } catch (cleanupError) {
        if (!isMissingFileError(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            `Atomic write and temporary-file cleanup failed for ${filePath}`,
          );
        }
      }
    }
    throw error;
  }
}
