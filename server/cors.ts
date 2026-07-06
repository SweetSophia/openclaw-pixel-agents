export interface CorsConfig {
  allowedOrigins: string[];
  allowAllOrigins: boolean;
  socketOrigin: string[] | "*";
}

export function parseCorsOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function createCorsConfig(env: NodeJS.ProcessEnv = process.env): CorsConfig {
  const allowedOrigins = parseCorsOrigins(env.CORS_ORIGIN);
  const isProduction = env.NODE_ENV === "production";

  if (isProduction && allowedOrigins.length === 0) {
    throw new Error("CORS_ORIGIN is required when NODE_ENV=production");
  }

  const allowAllOrigins = !isProduction && allowedOrigins.length === 0;

  return {
    allowedOrigins,
    allowAllOrigins,
    socketOrigin: allowAllOrigins ? "*" : allowedOrigins,
  };
}

export function isOriginAllowed(origin: string | string[] | undefined, config: CorsConfig): boolean {
  if (config.allowAllOrigins) return true;
  if (typeof origin !== "string") return false;
  return config.allowedOrigins.includes(origin);
}
