import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface StorageKey { version: string; key: Buffer }

export function storageKey(version: string, encoded: string): StorageKey {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(version) || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('Invalid Permit storage encryption configuration');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Invalid Permit storage encryption configuration');
  return { version, key };
}

export function sealStorageSecret(value: unknown, context: string, key: StorageKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(Buffer.from(`${key.version}:${context}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ version:key.version, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:data.toString('base64') });
}

export function unsealStorageSecret<T>(envelope: string, context: string, key: StorageKey): T {
  try {
    const value = JSON.parse(envelope) as { version: string; iv: string; tag: string; data: string };
    if (value.version !== key.version) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(value.iv, 'base64'));
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
