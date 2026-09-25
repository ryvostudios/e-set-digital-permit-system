import { randomBytes } from 'node:crypto';

/**
 * SYNTHETIC Permit Dropbox configuration for tests that exercise the
 * configured OAuth path. Imported FIRST by such a test file so the values
 * exist before config/env.ts is evaluated. None of these is a real
 * credential: the client id/secret are placeholders, the callback origin is
 * loopback, and the storage key is freshly random per test process.
 */
process.env.DROPBOX_CLIENT_ID = 'synthetic-client-id';
process.env.DROPBOX_CLIENT_SECRET = 'synthetic-client-secret-not-real';
process.env.DROPBOX_OAUTH_ORIGIN = 'http://localhost:3001';
process.env.PERMIT_STORAGE_MASTER_KEY = randomBytes(32).toString('base64');
process.env.PERMIT_STORAGE_KEY_VERSION = '1';
