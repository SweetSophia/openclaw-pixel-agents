import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLayoutMutationBody, parseOfficeLayoutDoc, parsePersistedPrefs, parseRecipe, parseSpriteBody, parseToggleBody } from "./validation";

const defaultLayout = JSON.parse(readFileSync(join(process.cwd(), "data/layouts/default.json"), "utf-8"));
const persistedPrefs = JSON.parse(readFileSync(join(process.cwd(), "data/agent-prefs.json"), "utf-8"));

describe("runtime validators", () => {
  it("accepts the committed persisted prefs fixture", () => {
    for (const value of Object.values(persistedPrefs)) {
      expect(parsePersistedPrefs(value)).toEqual({ pixelEnabled: true });
    }
  });

  it("rejects malformed persisted prefs", () => {
    expect(parsePersistedPrefs(null)).toBeNull();
    expect(parsePersistedPrefs([])).toBeNull();
    expect(parsePersistedPrefs({ pixelEnabled: "true" })).toBeNull();
    expect(parsePersistedPrefs({ characterSpriteId: "../evil" })).toBeNull();
    expect(parsePersistedPrefs({ tags: ["coding", "logic", "research", "frontend"] })).toBeNull();
    expect(parsePersistedPrefs({ recipe: { bodyIndex: 6, hairIndex: 0, outfitIndex: 0 } })).toBeNull();
    expect(parsePersistedPrefs({ pixelEnabled: true, extra: true })).toBeNull();
  });

  it("accepts the committed default layout fixture", () => {
    expect(parseOfficeLayoutDoc(defaultLayout)).toMatchObject({ id: "default", width: 24, height: 16 });
  });

  it("rejects malformed layout documents", () => {
    expect(parseOfficeLayoutDoc({ ...defaultLayout, id: "../default" })).toBeNull();
    expect(parseOfficeLayoutDoc({ ...defaultLayout, width: 129 })).toBeNull();
    expect(parseOfficeLayoutDoc({ ...defaultLayout, width: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseOfficeLayoutDoc({ ...defaultLayout, furniture: [{ ...defaultLayout.furniture[0], rotation: 45 }] })).toBeNull();
    expect(parseOfficeLayoutDoc({ ...defaultLayout, furniture: [{ ...defaultLayout.furniture[0], x: -1 }] })).toBeNull();
    expect(parseOfficeLayoutDoc({ ...defaultLayout, seats: { main: { x: "1", y: 1 } } })).toBeNull();
    expect(parseOfficeLayoutDoc({ ...defaultLayout, unexpected: true })).toBeNull();
  });

  it("parses valid layout mutation bodies", () => {
    expect(parseLayoutMutationBody({ name: "Team Room", width: 24, height: 16, furniture: [], seats: {}, baseUpdatedAt: 1 }, { width: 24, height: 16 })).toEqual({
      ok: true,
      body: { name: "Team Room", width: 24, height: 16, furniture: [], seats: {} },
      baseUpdatedAt: 1,
    });
  });

  it("rejects invalid layout mutation bodies", () => {
    expect(parseLayoutMutationBody({ width: "wide" }, { width: 24, height: 16 }).ok).toBe(false);
    expect(parseLayoutMutationBody({ baseUpdatedAt: "old" }, { width: 24, height: 16 }).ok).toBe(false);
    expect(parseLayoutMutationBody({ baseUpdatedAt: -1 }, { width: 24, height: 16 }).ok).toBe(false);
    expect(parseLayoutMutationBody({ furniture: [{}] }, { width: 24, height: 16 }).ok).toBe(false);
    expect(parseLayoutMutationBody({ furniture: "nope" }, { width: 24, height: 16 }).ok).toBe(false);
    expect(parseLayoutMutationBody({ unknown: true }, { width: 24, height: 16 }).ok).toBe(false);
  });

  it("validates agent mutation bodies", () => {
    expect(parseToggleBody({ enabled: false })).toBe(false);
    expect(parseToggleBody({ enabled: 0 })).toBeNull();
    expect(parseSpriteBody({ spriteId: "char_1" })).toBe("char_1");
    expect(parseSpriteBody({ spriteId: "../char_1" })).toBeNull();
    expect(parseRecipe({ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 })).toEqual({ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 });
    expect(parseRecipe({ bodyIndex: 0, hairIndex: 9, outfitIndex: 0 })).toBeNull();
  });
});
