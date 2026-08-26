import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import { CRO_RECIPIENT_CAPABILITIES, HSE_RECIPIENT_CAPABILITIES, resolveCroRecipients, resolveHseRecipients } from './recipients.js';

/** A minimal user_team_positions/capabilities join stand-in, keyed by capability name -> holder user ids - mirrors the real join's DISTINCT-across-multiple-assignments behavior. */
function fakeCapabilityQuery(holders: Record<string, string[]>): QueryFn {
  return (async (_text: string, params: unknown[] = []) => {
    const [capabilityNames] = params as [string[]];
    const userIds = new Set<string>();
    for (const capability of capabilityNames) {
      for (const userId of holders[capability] ?? []) userIds.add(userId);
    }
    return { rows: [...userIds].map((user_id) => ({ user_id })) };
  }) as QueryFn;
}

test('resolveCroRecipients returns every user holding at least one CRO-side capability, deduplicated', async () => {
  const queryFn = fakeCapabilityQuery({
    'permit.cro_review': ['cro-1', 'cro-2'],
    'permit.forward_hse': ['cro-1'],
    'permit.hold': ['cro-3'],
  });
  const recipients = await resolveCroRecipients(queryFn);
  assert.deepEqual([...new Set(recipients)].sort(), ['cro-1', 'cro-2', 'cro-3']);
});

test('resolveHseRecipients returns every user holding at least one HSE-side capability', async () => {
  const queryFn = fakeCapabilityQuery({
    'permit.hse_review': ['hse-1'],
    'permit.fallback_approve': ['cro-1'],
  });
  const recipients = await resolveHseRecipients(queryFn);
  assert.deepEqual([...new Set(recipients)].sort(), ['cro-1', 'hse-1']);
});

test('CRO and HSE recipient capability lists are disjoint from each other and non-empty', () => {
  assert.ok(CRO_RECIPIENT_CAPABILITIES.length > 0);
  assert.ok(HSE_RECIPIENT_CAPABILITIES.length > 0);
  const overlap = CRO_RECIPIENT_CAPABILITIES.filter((c) => (HSE_RECIPIENT_CAPABILITIES as readonly string[]).includes(c));
  assert.deepEqual(overlap, []);
});
