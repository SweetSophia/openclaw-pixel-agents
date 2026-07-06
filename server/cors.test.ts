import { describe, expect, it } from "vitest";
import { createCorsConfig, isOriginAllowed, parseCorsOrigins } from "./cors";

describe("CORS origin configuration", () => {
  it("parses comma-separated CORS_ORIGIN values", () => {
    expect(parseCorsOrigins(" https://app.example.com,https://admin.example.com , ")).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });

  it("allows all origins only in non-production when no allow-list is configured", () => {
    const config = createCorsConfig({ NODE_ENV: "development" });

    expect(config.allowAllOrigins).toBe(true);
    expect(config.socketOrigin).toBe("*");
    expect(isOriginAllowed("https://attacker.example", config)).toBe(true);
  });

  it("uses the configured allow-list in production", () => {
    const config = createCorsConfig({
      NODE_ENV: "production",
      CORS_ORIGIN: "https://app.example.com, https://admin.example.com",
    });

    expect(config.allowAllOrigins).toBe(false);
    expect(config.socketOrigin).toEqual(["https://app.example.com", "https://admin.example.com"]);
    expect(isOriginAllowed("https://app.example.com", config)).toBe(true);
    expect(isOriginAllowed("https://attacker.example", config)).toBe(false);
  });

  it("fails fast in production when CORS_ORIGIN is missing", () => {
    expect(() => createCorsConfig({ NODE_ENV: "production" })).toThrow(
      "CORS_ORIGIN is required when NODE_ENV=production",
    );
  });
});
