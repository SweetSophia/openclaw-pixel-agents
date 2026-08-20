import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

type AtomicWriteOptions = Readonly<{
  renameFile?: typeof renameSync;
}>;

/**
 * Durably replace a file without exposing a partially written target.
 *
 * The temporary file lives beside the target so rename remains atomic on
 * POSIX filesystems. `flush` syncs the completed temporary file before the
 * rename; syncing the parent directory then persists the directory entry.
 */
export function atomicWriteFileSync(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const renameFile = options.renameFile ?? renameSync;
  let renamed = false;

  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    renameFile(temporaryPath, filePath);
    renamed = true;

    // Windows does not support opening directories as file descriptors.
    if (process.platform !== "win32") {
      const directoryFd = openSync(dirname(filePath), "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
  } catch (error) {
    if (!renamed) {
      try {
        unlinkSync(temporaryPath);
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
