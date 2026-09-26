import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface StorageKey { version: string; key: Buffer }

/**
 * A key-version label: 1-32 of [A-Za-z0-9_-], starting with a letter or
 * digit, and never an Object.prototype name. Labels are also used as keys
 * when accounting envelopes (A02: "__proto__" once hid a referenced key).
 */
const RESERVED_KEY_VERSIONS = new Set(['constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof']);
export function isValidKeyVersion(version: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(version) && !RESERVED_KEY_VERSIONS.has(version.toLowerCase());
}

export function storageKey(version: string, encoded: string): StorageKey {
  if (!isValidKeyVersion(version) || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('Invalid Permit storage encryption configuration');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Invalid Permit storage encryption configuration');
  return { version, key };
}

/**
 * KEY ROTATION. New envelopes are always sealed with the ACTIVE key
 * (PERMIT_STORAGE_MASTER_KEY / PERMIT_STORAGE_KEY_VERSION). Previous keys
 * (PERMIT_STORAGE_PREVIOUS_KEYS, "version:base64key" comma-separated) are
 * read-only: an envelope is opened with the key its recorded version names,
 * and an unknown version fails closed. Key material never leaves the
 * environment; errors never include it.
 */
export interface StorageKeyring { active: StorageKey; keys: ReadonlyMap<string, Buffer> }

const INVALID = 'Invalid Permit storage encryption configuration';

export function storageKeyring(activeVersion: string, activeEncoded: string, previous = ''): StorageKeyring {
  const active = storageKey(activeVersion, activeEncoded);
  const keys = new Map<string, Buffer>([[active.version, active.key]]);
  for (const entry of previous.split(',').map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    if (separator < 1) throw new Error(INVALID);
    const old = storageKey(entry.slice(0, separator), entry.slice(separator + 1));
    if (keys.has(old.version) || [...keys.values()].some((key) => key.equals(old.key))) throw new Error(INVALID);
    keys.set(old.version, old.key);
  }
  return { active, keys };
}

function keyFor(keys: StorageKeyring | StorageKey, version: string): Buffer | undefined {
  return 'keys' in keys ? keys.keys.get(version) : keys.version === version ? keys.key : undefined;
}

export function sealStorageSecret(value: unknown, context: string, keys: StorageKeyring | StorageKey): string {
  const key = 'active' in keys ? keys.active : keys;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(Buffer.from(`${key.version}:${context}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ version:key.version, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:data.toString('base64') });
}

/** The key version an envelope was sealed with, without decrypting it. */
export function envelopeKeyVersion(envelope: string): string | null {
  try {
    const version = (JSON.parse(envelope) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

export function unsealStorageSecret<T>(envelope: string, context: string, keys: StorageKeyring | StorageKey): T {
  try {
    const value = JSON.parse(envelope) as { version: string; iv: string; tag: string; data: string };
    const key = typeof value.version === 'string' ? keyFor(keys, value.version) : undefined;
    if (!key) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`${value.version}:${context}`));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')) as T;
  } catch {
    throw new Error('Permit storage credential decryption failed');
  }
}

export function sha256Bytes(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}
