import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { atomicWriteFileSync } from "./persistence";

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

    atomicWriteFileSync(target, "replacement");

    expect(readFileSync(target, "utf8")).toBe("replacement");
    expect(readdirSync(directory)).toEqual(["agent-prefs.json"]);
  });

  it("preserves the previous file and cleans up the temporary file when rename fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "pixel-agents-atomic-failure-"));
    directories.push(directory);
    const target = join(directory, "default.json");
    writeFileSync(target, "previous");
    const renameFile = () => {
      throw Object.assign(new Error("fault-injected rename failure"), { code: "EIO" });
    };

    expect(() => atomicWriteFileSync(target, "replacement", { renameFile }))
      .toThrow("fault-injected rename failure");

    expect(readFileSync(target, "utf8")).toBe("previous");
    expect(readdirSync(directory)).toEqual(["default.json"]);
  });
});
