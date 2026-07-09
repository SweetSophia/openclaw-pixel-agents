import { ALL_TAGS, type AgentTag, type CharacterRecipe, type PlacedFurniture } from "../shared/types";
import { isValidLayoutId } from "./layouts";

export interface PersistedPrefs {
  pixelEnabled?: boolean;
  characterSpriteId?: string;
  tags?: AgentTag[];
  recipe?: CharacterRecipe;
}

export interface OfficeLayoutDoc {
  id: string;
  name: string;
  width: number;
  height: number;
  furniture: PlacedFurniture[];
  seats: Record<string, { x: number; y: number }>;
  updatedAt: number;
}

export type LayoutMutationResult =
  | { ok: true; body: Partial<OfficeLayoutDoc>; baseUpdatedAt?: number }
  | { ok: false; error: string };

const SAFE_ID_RE = /^[a-zA-Z0-9_.-]+$/;
const VALID_TAGS = new Set<string>(ALL_TAGS);
const VALID_ROTATIONS = new Set([0, 90, 180, 270]);
const PREF_KEYS = new Set(["pixelEnabled", "characterSpriteId", "tags", "recipe"]);
const LAYOUT_KEYS = new Set(["id", "name", "width", "height", "furniture", "seats", "updatedAt"]);
const LAYOUT_MUTATION_KEYS = new Set([...LAYOUT_KEYS, "baseUpdatedAt"]);
const TAGS_BODY_KEYS = new Set(["tags"]);
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SEATS = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isSafeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && SAFE_ID_RE.test(value);
}

function isAgentTag(value: unknown): value is AgentTag {
  return typeof value === "string" && VALID_TAGS.has(value);
}

export function parseRecipe(value: unknown): CharacterRecipe | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(["bodyIndex", "hairIndex", "outfitIndex"]))) return null;
  const { bodyIndex, hairIndex, outfitIndex } = value;
  if (!isIntInRange(bodyIndex, 0, 5)) return null;
  if (!isIntInRange(hairIndex, 0, 8)) return null;
  if (!isIntInRange(outfitIndex, 0, 5)) return null;
  return { bodyIndex, hairIndex, outfitIndex };
}

export function parseAgentTags(value: unknown): AgentTag[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const tags: AgentTag[] = [];
  const seen = new Set<AgentTag>();
  for (const tag of value) {
    if (!isAgentTag(tag) || seen.has(tag)) return null;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function parseTagsBody(value: unknown): AgentTag[] | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, TAGS_BODY_KEYS)) return null;
  return parseAgentTags(value.tags);
}

export function parsePersistedPrefs(value: unknown): PersistedPrefs | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, PREF_KEYS)) return null;

  const prefs: PersistedPrefs = {};
  if ("pixelEnabled" in value) {
    if (typeof value.pixelEnabled !== "boolean") return null;
    prefs.pixelEnabled = value.pixelEnabled;
  }
  if ("characterSpriteId" in value) {
    if (!isSafeString(value.characterSpriteId, 64)) return null;
    prefs.characterSpriteId = value.characterSpriteId;
  }
  if ("tags" in value) {
    const tags = parseAgentTags(value.tags);
    if (!tags) return null;
    prefs.tags = tags;
  }
  if ("recipe" in value) {
    const recipe = parseRecipe(value.recipe);
    if (!recipe) return null;
    prefs.recipe = recipe;
  }

  return prefs;
}

function parseFurniture(value: unknown, width: number, height: number): PlacedFurniture | null {
  if (!isPlainObject(value)) return null;
  const allowed = new Set(["id", "type", "x", "y", "rotation", "state"]);
  if (!hasOnlyKeys(value, allowed)) return null;
  const { id, type, x, y, rotation, state } = value;
  if (!isSafeString(id, 64)) return null;
  if (!isSafeString(type, 64)) return null;
  if (!isIntInRange(x, 0, width - 1)) return null;
  if (!isIntInRange(y, 0, height - 1)) return null;
  if (typeof rotation !== "number" || !VALID_ROTATIONS.has(rotation)) return null;
  if (state !== undefined && (typeof state !== "string" || state.length > 32)) return null;

  return state === undefined
    ? { id, type, x, y, rotation }
    : { id, type, x, y, rotation, state };
}

function parseFurnitureArray(value: unknown, width: number, height: number): PlacedFurniture[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const furniture: PlacedFurniture[] = [];
  for (const item of value) {
    const parsed = parseFurniture(item, width, height);
    if (!parsed) return null;
    furniture.push(parsed);
  }
  return furniture;
}

function parseSeats(value: unknown, width: number, height: number): Record<string, { x: number; y: number }> | null {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_SEATS) return null;

  const seats: Record<string, { x: number; y: number }> = Object.create(null);
  for (const [agentId, seat] of entries) {
    if (RESERVED_OBJECT_KEYS.has(agentId)) return null;
    if (!isSafeString(agentId, 64) || !isPlainObject(seat) || !hasOnlyKeys(seat, new Set(["x", "y"]))) return null;
    const { x, y } = seat;
    if (!isIntInRange(x, 0, width - 1) || !isIntInRange(y, 0, height - 1)) return null;
    seats[agentId] = { x, y };
  }
  return seats;
}

export function parseOfficeLayoutDoc(value: unknown): OfficeLayoutDoc | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, LAYOUT_KEYS)) return null;
  const { id, name, width, height, furniture, seats, updatedAt } = value;
  if (typeof id !== "string" || !isValidLayoutId(id)) return null;
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 128) return null;
  if (!isIntInRange(width, 1, 128) || !isIntInRange(height, 1, 128)) return null;
  const parsedFurniture = parseFurnitureArray(furniture, width, height);
  if (!parsedFurniture) return null;
  const parsedSeats = parseSeats(seats, width, height);
  if (!parsedSeats) return null;
  if (!isIntInRange(updatedAt, 0, Number.MAX_SAFE_INTEGER)) return null;

  return { id, name, width, height, furniture: parsedFurniture, seats: parsedSeats, updatedAt };
}

export function parseLayoutMutationBody(
  value: unknown,
  bounds: { width: number; height: number },
): LayoutMutationResult {
  if (!isPlainObject(value) || !hasOnlyKeys(value, LAYOUT_MUTATION_KEYS)) {
    return { ok: false, error: "Invalid layout body" };
  }

  const body: Partial<OfficeLayoutDoc> = {};
  let width = bounds.width;
  let height = bounds.height;

  let baseUpdatedAt: number | undefined;
  if ("baseUpdatedAt" in value) {
    if (!isIntInRange(value.baseUpdatedAt, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: "baseUpdatedAt must be a non-negative integer" };
    baseUpdatedAt = value.baseUpdatedAt;
  }
  if ("id" in value && !isValidLayoutId(value.id)) return { ok: false, error: "id must be a valid layout ID" };
  if ("updatedAt" in value && !isIntInRange(value.updatedAt, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: "updatedAt must be a non-negative integer" };
  if ("name" in value) {
    if (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.length > 128) return { ok: false, error: "name must be a non-empty string up to 128 characters" };
    body.name = value.name;
  }
  if ("width" in value) {
    if (!isIntInRange(value.width, 1, 128)) return { ok: false, error: "width must be an integer from 1 to 128" };
    width = value.width;
    body.width = value.width;
  }
  if ("height" in value) {
    if (!isIntInRange(value.height, 1, 128)) return { ok: false, error: "height must be an integer from 1 to 128" };
    height = value.height;
    body.height = value.height;
  }
  if ("furniture" in value) {
    const furniture = parseFurnitureArray(value.furniture, width, height);
    if (!furniture) return { ok: false, error: "furniture must be a valid furniture array" };
    body.furniture = furniture;
  }
  if ("seats" in value) {
    const seats = parseSeats(value.seats, width, height);
    if (!seats) return { ok: false, error: "seats must be a valid seat map" };
    body.seats = seats;
  }

  return { ok: true, body, baseUpdatedAt };
}

export function parseToggleBody(value: unknown): boolean | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(["enabled"]))) return null;
  return typeof value.enabled === "boolean" ? value.enabled : null;
}

export function parseSpriteBody(value: unknown): string | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(["spriteId"]))) return null;
  return isSafeString(value.spriteId, 64) ? value.spriteId : null;
}
