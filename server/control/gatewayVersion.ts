function stableParts(version: string): number[] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function supportsStableGatewayVersion(version: string, minimum: string): boolean {
  const parts = stableParts(version), floor = stableParts(minimum);
  if (!parts || !floor) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== floor[i]) return parts[i] > floor[i];
  return true;
}
