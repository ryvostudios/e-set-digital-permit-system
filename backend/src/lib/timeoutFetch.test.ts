import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTimeoutFetch } from './timeoutFetch.js';

test('timeout fetch genuinely aborts a stalled underlying request', async () => {
  let receivedSignal: AbortSignal | undefined;
  let underlyingAbortObserved = false;
  const stalledFetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      receivedSignal?.addEventListener('abort', () => {
        underlyingAbortObserved = true;
        reject(receivedSignal?.reason);
      }, { once: true });
    });
  }) as typeof fetch;

  const boundedFetch = createTimeoutFetch(stalledFetch, 20);
  await assert.rejects(boundedFetch('https://example.invalid/auth/v1/admin/users'));

  assert.equal(underlyingAbortObserved, true, 'the actual fetch signal was aborted');
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(receivedSignal?.reason instanceof DOMException, true);
  assert.equal((receivedSignal?.reason as DOMException).name, 'TimeoutError');
});

test('timeout fetch preserves and propagates an upstream abort signal', async () => {
  const upstream = new AbortController();
  let underlyingAbortObserved = false;
  const stalledFetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        underlyingAbortObserved = true;
        reject(init.signal?.reason);
      }, { once: true });
    })) as typeof fetch;

  const boundedFetch = createTimeoutFetch(stalledFetch, 1_000);
  const pending = boundedFetch('https://example.invalid/auth/v1/admin/users', { signal: upstream.signal });
  upstream.abort(new DOMException('caller cancelled', 'AbortError'));

  await assert.rejects(pending);
  assert.equal(underlyingAbortObserved, true);
});

test('timeout fetch clears its deadline after a fast successful request', async () => {
  const fastFetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const response = await createTimeoutFetch(fastFetch, 1_000)('https://example.invalid/auth/v1/admin/users');
  assert.equal(response.status, 204);
});
