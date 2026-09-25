import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  DropboxError, DropboxHttp, DropboxProvider, dropboxAuthorizationUrl,
  dropboxContentHash, dropboxExchangeTokens,
} from './dropbox.js';

test('OAuth URL binds state and S256 PKCE, and requests offline file scopes', () => {
  const url = new URL(dropboxAuthorizationUrl({
    clientId: 'local-client', redirectUri: 'https://permit.example.test/api/v1/cms/dropbox/callback',
    state: 'synthetic-state', verifier: 'synthetic-verifier',
  }));
  assert.equal(url.origin, 'https://www.dropbox.com');
  assert.equal(url.searchParams.get('state'), 'synthetic-state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'),
    createHash('sha256').update('synthetic-verifier').digest('base64url'));
  assert.equal(url.searchParams.get('token_access_type'), 'offline');
  assert.ok(url.searchParams.get('scope')?.includes('files.content.read'));
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('token exchange and refresh stay in backend POST bodies and preserve the offline refresh token', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = new DropboxHttp(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(calls.length === 1
      ? { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 14400 }
      : { access_token: 'synthetic-new-access', expires_in: 14400 });
  });
  const input = { clientId: 'local-client', clientSecret: 'synthetic-secret',
    redirectUri: 'https://permit.example.test/callback' };
  const first = await dropboxExchangeTokens({ ...input, code: 'synthetic-code', verifier: 'synthetic-verifier' }, http);
  const second = await dropboxExchangeTokens({ ...input, refreshToken: first.refreshToken }, http);
  assert.equal(second.refreshToken, first.refreshToken);
  assert.equal(second.accessToken, 'synthetic-new-access');
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(new URL(url).search, '');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
  }
  assert.equal(new URLSearchParams(calls[0]!.init.body as URLSearchParams).get('code_verifier'), 'synthetic-verifier');
  assert.equal(new URLSearchParams(calls[1]!.init.body as URLSearchParams).get('grant_type'), 'refresh_token');
});

test('Dropbox HTTP client rejects redirect hosts and bounds provider responses without leaking bodies', async () => {
  const http = new DropboxHttp(async () => new Response('private-provider-detail', { status: 401 }));
  await assert.rejects(http.request('https://evil.example.test/2/files/upload', { method: 'POST' }), DropboxError);
  await assert.rejects(http.request('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST' }),
    (error: unknown) => error instanceof DropboxError && !error.message.includes('private-provider-detail'));
  const oversized = new DropboxHttp(async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(oversized.request('https://api.dropboxapi.com/2/test', { method: 'POST' }), DropboxError);
});

test('Dropbox content hash uses SHA-256 of 4 MiB block hashes', () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 0x61);
  const blocks = [bytes.subarray(0, 4 * 1024 * 1024), bytes.subarray(4 * 1024 * 1024)]
    .map(block => createHash('sha256').update(block).digest());
  assert.equal(dropboxContentHash(bytes), createHash('sha256').update(Buffer.concat(blocks)).digest('hex'));
});

test('upload is no-overwrite, recovers a duplicate by hash, and refuses different existing bytes', async () => {
  const path = 'Digital Permit System/Reports/example.pdf';
  const data = Buffer.from('%PDF-1.7\nsynthetic');
  const remote = { id: 'id:synthetic_file', size: data.length, content_hash: dropboxContentHash(data) };
  const calls: string[] = [];
  let duplicate = false;
  let mismatch = false;
  const http = new DropboxHttp(async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    calls.push(endpoint);
    if (endpoint.endsWith('/create_folder_v2')) return Response.json({ metadata: { '.tag': 'folder' } });
    if (endpoint.endsWith('/get_metadata')) return Response.json(endpoint && mismatch ? { ...remote, content_hash: '0'.repeat(64) } : remote);
    if (endpoint.endsWith('/upload')) return duplicate
      ? Response.json({ error_summary: 'path/conflict' }, { status: 409 })
      : Response.json(remote);
    throw new Error(`unexpected ${endpoint}: ${String(init?.body)}`);
  });
  const provider = new DropboxProvider('synthetic-token', http);
  assert.equal(await provider.upload(path, data), remote.id);
  duplicate = true;
  assert.equal(await provider.upload(path, data), remote.id);
  mismatch = true;
  await assert.rejects(provider.upload(path, data), DropboxError);
  assert.ok(calls.some(call => call.endsWith('/get_metadata')));
  await assert.rejects(provider.upload('../escape.pdf', data), DropboxError);
});
