import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidLayoutId } from "./layouts";

describe("isValidLayoutId", () => {
  it("accepts UUID-backed layout IDs", () => {
    expect(isValidLayoutId(`layout-${randomUUID()}`)).toBe(true);
  });

  it("rejects path traversal and path-like IDs", () => {
    expect(isValidLayoutId("../etc/passwd")).toBe(false);
    expect(isValidLayoutId("foo/bar")).toBe(false);
    expect(isValidLayoutId("foo.bar")).toBe(false);
  });

  it("rejects non-string and empty inputs", () => {
    expect(isValidLayoutId(null)).toBe(false);
    expect(isValidLayoutId(undefined)).toBe(false);
    expect(isValidLayoutId(42)).toBe(false);
    expect(isValidLayoutId("")).toBe(false);
  });

  it("enforces the 64-character limit", () => {
    expect(isValidLayoutId("x".repeat(64))).toBe(true);
    expect(isValidLayoutId("x".repeat(65))).toBe(false);
  });
});
