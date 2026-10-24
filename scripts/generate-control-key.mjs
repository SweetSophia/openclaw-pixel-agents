import { randomBytes } from 'node:crypto';

// Generate a new key without reading or changing any installation's credentials.
process.stdout.write(`${randomBytes(32).toString('hex')}\n`);
