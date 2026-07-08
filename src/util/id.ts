function randomIdSegment(): string {
  const cryptoApi = globalThis.crypto;

  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // This is a uniqueness fallback for non-secure browser contexts, not a secret.
  let segment = "";
  while (segment.length < 13) {
    segment += Math.random().toString(36).slice(2);
  }
  return segment.slice(0, 13);
}

export function newEntityId(prefix: string): string {
  return `${prefix}-${randomIdSegment()}`;
}
