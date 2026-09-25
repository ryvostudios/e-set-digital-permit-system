import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { envelopeKeyVersion, sealStorageSecret, storageKey, storageKeyring, unsealStorageSecret } from './crypto.js';

const TOKENS = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' };
const key64 = () => randomBytes(32).toString('base64');

test('Permit credentials use connection-bound authenticated encryption and a versioned key', () => {
  const key=storageKey('1',key64());
  const envelope=sealStorageSecret(TOKENS,'connection:one',key);
  assert.ok(!envelope.includes('synthetic-access'));
  assert.deepEqual(unsealStorageSecret(envelope,'connection:one',key),TOKENS);
  assert.throws(()=>unsealStorageSecret(envelope,'connection:two',key));
  assert.throws(()=>unsealStorageSecret(envelope,'connection:one',storageKey('2',key64())));
  const modified=JSON.parse(envelope); modified.data=Buffer.from('tampered').toString('base64');
  assert.throws(()=>unsealStorageSecret(JSON.stringify(modified),'connection:one',key));
});

test('rotation: new writes use the active key; previous keys decrypt; unknown versions fail closed', () => {
  const v1 = key64();
  const old = storageKeyring('1', v1);
  const oldEnvelope = sealStorageSecret(TOKENS, 'connection:one', old);
  const ring = storageKeyring('2', key64(), `1:${v1}`);

  // current and previous keys both decrypt
  const fresh = sealStorageSecret(TOKENS, 'connection:one', ring);
  assert.equal(envelopeKeyVersion(fresh), '2');
  assert.deepEqual(unsealStorageSecret(fresh, 'connection:one', ring), TOKENS);
  assert.deepEqual(unsealStorageSecret(oldEnvelope, 'connection:one', ring), TOKENS);

  // unknown version (v1 removed, or never configured) is denied
  const withoutV1 = storageKeyring('2', key64());
  assert.throws(() => unsealStorageSecret(oldEnvelope, 'connection:one', withoutV1), /decryption failed/);
  const relabelled = { ...JSON.parse(oldEnvelope), version: '9' };
  assert.throws(() => unsealStorageSecret(JSON.stringify(relabelled), 'connection:one', ring));
  // relabelling an envelope to another configured version fails the AAD check
  const asActive = { ...JSON.parse(oldEnvelope), version: '2' };
  assert.throws(() => unsealStorageSecret(JSON.stringify(asActive), 'connection:one', ring));

  // tampered ciphertext, IV, tag and truncated tag are denied
  for (const field of ['data', 'iv', 'tag'] as const) {
    const bad = JSON.parse(oldEnvelope);
    const bytes = Buffer.from(bad[field], 'base64'); bytes[0]! ^= 1; bad[field] = bytes.toString('base64');
    assert.throws(() => unsealStorageSecret(JSON.stringify(bad), 'connection:one', ring), /decryption failed/, field);
  }
  const truncated = JSON.parse(oldEnvelope);
  truncated.tag = Buffer.from(truncated.tag, 'base64').subarray(0, 4).toString('base64');
  assert.throws(() => unsealStorageSecret(JSON.stringify(truncated), 'connection:one', ring));
  assert.equal(envelopeKeyVersion('not json'), null);
});

test('keyring configuration is validated without echoing key material', () => {
  const active = key64();
  const other = key64();
  for (const previous of [`2:${other}`, `1:${active}`, `1:${other},1:${key64()}`, `${other}`, `1:short`, `bad version!:${other}`]) {
    let message = '';
    try { storageKeyring('2', active, previous); } catch (error) { message = (error as Error).message; }
    assert.equal(message, 'Invalid Permit storage encryption configuration', previous.slice(0, 12));
    assert.ok(!message.includes(active) && !message.includes(other));
  }
  assert.deepEqual([...storageKeyring('3', active, ` 1:${other} , 2:${key64()} `).keys.keys()], ['3', '1', '2']);
});
