import { randomBytes } from 'node:crypto';

/**
 * SYNTHETIC mid-rotation storage configuration: key version 2 is active,
 * version 1 is kept read-only. Imported FIRST, before config/env.ts is
 * evaluated. Keys are random per test process; nothing here is real.
 */
export const PREVIOUS_KEY_V1 = randomBytes(32).toString('base64');
export const RETIRED_KEY_V0 = randomBytes(32).toString('base64');

process.env.DROPBOX_CLIENT_ID = 'synthetic-client-id';
process.env.DROPBOX_CLIENT_SECRET = 'synthetic-client-secret-not-real';
process.env.DROPBOX_OAUTH_ORIGIN = 'http://localhost:3001';
process.env.PERMIT_STORAGE_MASTER_KEY = randomBytes(32).toString('base64');
process.env.PERMIT_STORAGE_KEY_VERSION = '2';
process.env.PERMIT_STORAGE_PREVIOUS_KEYS = `1:${PREVIOUS_KEY_V1}`;
