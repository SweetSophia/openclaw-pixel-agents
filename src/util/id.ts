function randomIdSegment(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // This is a uniqueness fallback for non-secure browser contexts, not a secret.
  return Math.random().toString(36).slice(2, 15);
}

export function newEntityId(prefix: string): string {
  return `${prefix}-${randomIdSegment()}`;
}
