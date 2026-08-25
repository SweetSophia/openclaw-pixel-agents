import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { atomicWriteFileSync } from "./persistence";

const itPosix = process.platform === "win32" ? it.skip : it;

describe("atomicWriteFileSync", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("atomically replaces an existing persisted file without leaving a temporary file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pixel-agents-atomic-write-"));
    directories.push(directory);
    const target = join(directory, "agent-prefs.json");
    writeFileSync(target, "previous");

    atomicWriteFileSync(directory, "agent-prefs.json", "replacement");

    expect(readFileSync(target, "utf8")).toBe("replacement");
    expect(readdirSync(directory)).toEqual(["agent-prefs.json"]);
  });

  itPosix("flushes the temporary file and syncs the directory after rename", () => {
    const directory = mkdtempSync(join(tmpdir(), "pixel-agents-atomic-durability-"));
    directories.push(directory);
    const operations: string[] = [];
    const writeFile = vi.fn<typeof writeFileSync>((path, contents, options) => {
      operations.push("write");
      writeFileSync(path, contents, options);
    });
    const renameFile = vi.fn<typeof import("node:fs").renameSync>((from, to) => {
      operations.push("rename");
      renameSync(from, to);
    });
    const openDirectory = vi.fn(() => {
      operations.push("open-directory");
      return 42;
    });
    const syncFile = vi.fn(() => operations.push("sync-directory"));
    const closeFile = vi.fn(() => operations.push("close-directory"));

    atomicWriteFileSync(directory, "durable.json", "contents", {
      closeFile,
      openDirectory,
      renameFile,
      syncFile,
      writeFile,
    });

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp$/),
      "contents",
      { encoding: "utf8", flag: "wx", flush: true },
    );
    expect(openDirectory).toHaveBeenCalledWith(directory, "r");
    expect(syncFile).toHaveBeenCalledWith(42);
    expect(closeFile).toHaveBeenCalledWith(42);
    expect(operations).toEqual([
      "write",
      "rename",
      "open-directory",
      "sync-directory",
      "close-directory",
    ]);
  });

  it("preserves the previous file and cleans up the temporary file when rename fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "pixel-agents-atomic-failure-"));
    directories.push(directory);
    const target = join(directory, "default.json");
    writeFileSync(target, "previous");
    const renameFile = () => {
      throw Object.assign(new Error("fault-injected rename failure"), { code: "EIO" });
    };

    expect(() => atomicWriteFileSync(directory, "default.json", "replacement", { renameFile }))
      .toThrow("fault-injected rename failure");

    expect(readFileSync(target, "utf8")).toBe("previous");
    expect(readdirSync(directory)).toEqual(["default.json"]);
  });

  it("preserves both operation and cleanup failures in an AggregateError", () => {
    const directory = mkdtempSync(join(tmpdir(), "pixel-agents-atomic-aggregate-"));
    directories.push(directory);
    const renameError = new Error("fault-injected rename failure");
    const cleanupError = new Error("fault-injected cleanup failure");

    expect(() => atomicWriteFileSync(directory, "default.json", "replacement", {
      renameFile: () => { throw renameError; },
      unlinkFile: () => { throw cleanupError; },
    })).toThrow(expect.objectContaining({
      errors: [renameError, cleanupError],
    }));
  });

  itPosix("keeps the replaced target when directory sync fails after rename", () => {
    const directory = mkdtempSync(join(tmpdir(), "pixel-agents-atomic-sync-failure-"));
    directories.push(directory);
    const target = join(directory, "default.json");
    writeFileSync(target, "previous");
    const syncError = new Error("fault-injected sync failure");

    expect(() => atomicWriteFileSync(directory, "default.json", "replacement", {
      syncFile: () => { throw syncError; },
    })).toThrow(syncError);

    expect(readFileSync(target, "utf8")).toBe("replacement");
    expect(readdirSync(directory)).toEqual(["default.json"]);
  });

  itPosix("preserves simultaneous directory sync and close failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "pixel-agents-atomic-sync-close-"));
    directories.push(directory);
    const syncError = new Error("fault-injected sync failure");
    const closeError = new Error("fault-injected close failure");

    expect(() => atomicWriteFileSync(directory, "default.json", "replacement", {
      openDirectory: () => 42,
      syncFile: () => { throw syncError; },
      closeFile: () => { throw closeError; },
    })).toThrow(expect.objectContaining({
      errors: [syncError, closeError],
    }));
  });

  it.each([
    "../escape.json",
    "nested/escape.json",
    "/absolute/escape.json",
    "C:\\absolute\\escape.json",
    "\\\\server\\share\\escape.json",
    "nested\\escape.json",
    "CON.json",
    "nul.JSON",
    "layout.",
    "layout. ",
  ])("rejects a filename outside the allowed directory: %s", (fileName) => {
    const directory = mkdtempSync(join(tmpdir(), "pixel-agents-atomic-path-"));
    directories.push(directory);
    const writeFile = vi.fn<typeof writeFileSync>();
    const renameFile = vi.fn();

    expect(() => atomicWriteFileSync(
      directory,
      fileName,
      "contents",
      { writeFile, renameFile },
    ))
      .toThrow("Invalid persisted filename");
    expect(writeFile).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  });
});
