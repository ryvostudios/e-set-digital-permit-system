import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { sealStorageSecret, storageKey, unsealStorageSecret } from './crypto.js';

test('Permit credentials use connection-bound authenticated encryption and a versioned key', () => {
  const key=storageKey('1',randomBytes(32).toString('base64'));
  const envelope=sealStorageSecret({accessToken:'synthetic-access',refreshToken:'synthetic-refresh'},'connection:one',key);
  assert.ok(!envelope.includes('synthetic-access'));
  assert.deepEqual(unsealStorageSecret(envelope,'connection:one',key),{accessToken:'synthetic-access',refreshToken:'synthetic-refresh'});
  assert.throws(()=>unsealStorageSecret(envelope,'connection:two',key));
  assert.throws(()=>unsealStorageSecret(envelope,'connection:one',storageKey('2',randomBytes(32).toString('base64'))));
  const modified=JSON.parse(envelope); modified.data=Buffer.from('tampered').toString('base64');
  assert.throws(()=>unsealStorageSecret(JSON.stringify(modified),'connection:one',key));
});
