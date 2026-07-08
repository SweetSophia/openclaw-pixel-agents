/** Validate layout ID to prevent path traversal attacks. */
export function isValidLayoutId(id: unknown): boolean {
  return typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 64;
}
