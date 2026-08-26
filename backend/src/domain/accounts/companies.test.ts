import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import { resolveProvisioningCompany } from './companies.js';

test('company resolution uses only the validated code and authoritative row', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryFn = (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: [{ id: 'company-1', code: 'E_SET', name: 'E-SET' }] };
  }) as QueryFn;

  assert.deepEqual(await resolveProvisioningCompany('E_SET', queryFn), {
    id: 'company-1', code: 'E_SET', name: 'E-SET',
  });
  assert.deepEqual(calls[0]?.params, ['E_SET']);
  assert.match(calls[0]?.sql ?? '', /WHERE code = \$1/);
  assert.doesNotMatch(calls[0]?.sql ?? '', /email|metadata|team/i);
});

test('missing authoritative company data fails closed', async () => {
  const queryFn = (async () => ({ rows: [] })) as unknown as QueryFn;
  assert.equal(await resolveProvisioningCompany('SGRE', queryFn), null);
});
