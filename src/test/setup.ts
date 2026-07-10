import '@testing-library/jest-dom/vitest';

// Silence pino logs during vitest runs so structured output does not flood CI.
// Server tests still verify logger behaviour via spies on the singleton logger.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';