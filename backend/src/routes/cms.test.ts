import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { clearPublicBrandingCache } from '../domain/cms/publicBranding.js';
import { setSessionResolverForTests } from '../middleware/auth.js';

/**
 * Permit CMS over HTTP. The database is a stub answering by SQL text; the
 * real routes, guards, origin check and validation run.
 *
 * AUTHORITY: the CEO, or a person with an explicit individual
 * `permit.cms.manage` grant. Nobody else - not a Site Manager, not a CRO or
 * HSE reviewer, not a team lead, not an ordinary employee - by role.
 */

const TOKEN = 'cms-route-test-session-token--------------A';
const ORIGIN = 'http://localhost:5173';
const EMPLOYEE_ID = '10000000-0000-4000-8000-000000000003';

let actor = '';
let roles: string[] = [];
let teamCapabilities: string[] = [];
let individualCapabilities: string[] = [];
let counter = 0;

const originalQuery = Pool.prototype.query;
const originalConnect = Pool.prototype.connect;

before(() => {
  setSessionResolverForTests(async (token: string) =>
    token === TOKEN ? { sessionId: '00000000-0000-4000-8000-00000000cafe', userId: actor, email: null } : null);
  Pool.prototype.query = (async (text: unknown, params: unknown[] = []) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM app_user_access') && sql.startsWith('SELECT state')) {
      return { rows: [{ state: 'ACTIVE', must_change_password: false }] };
    }
    if (sql.includes('FROM privileged_access_events')) {
      return { rows: (String(params[0]) === actor ? roles : []).map((role) => ({ role, action: 'GRANTED' })) };
    }
    if (sql.startsWith('SELECT DISTINCT c.name')) return { rows: teamCapabilities.map((name) => ({ name })) };
    if (sql.includes('FROM user_capability_grants')) return { rows: individualCapabilities.map((name) => ({ name })) };
    if (sql.includes('FROM permit.cms_settings') && sql.includes('LEFT JOIN')) {
      return { rows: [{ organization_name: 'E-Set Engineering Services', sign_in_notice: '', web_file: null, web_sha: null,
        web_state: null, icon_file: null, icon_sha: null, icon_state: null }] };
    }
    if (sql.includes('FROM permit.cms_settings')) {
      return { rows: [{ organization_name: 'E-Set Engineering Services', sign_in_notice: '', web_logo_asset_id: null,
        pwa_icon_asset_id: null, revision: 3 }] };
    }
    if (sql.includes('FROM permit.cms_logo_assets')) return { rows: [] };
    if (sql.includes('FROM permit.storage_selection') || sql.includes('FROM permit.storage_connections') ||
        sql.includes('FROM permit.file_registry')) return { rows: [] };
    return { rows: [] };
  }) as unknown as typeof Pool.prototype.query;
  Pool.prototype.connect = (async () => ({
    query: (text: unknown, params?: unknown[]) => (Pool.prototype.query as unknown as (t: unknown, p?: unknown[]) => unknown)(text, params),
    release: () => {},
  }) as unknown as PoolClient) as typeof Pool.prototype.connect;
});

after(() => {
  setSessionResolverForTests(null);
  Pool.prototype.query = originalQuery;
  Pool.prototype.connect = originalConnect;
});

beforeEach(() => {
  counter += 1;
  actor = `40000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  roles = [];
  teamCapabilities = [];
  individualCapabilities = [];
  clearPublicBrandingCache();
});

async function withServer(work: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/v1`;
  try {
    await work(url);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const session = { cookie: `permit_session=${TOKEN}`, origin: ORIGIN };

test('CMS state: only the CEO or an explicit individual CMS grant; every other role is refused', async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/cms/state`)).status, 401);
    const cases: [string, () => void, number][] = [
      ['ordinary employee', () => { teamCapabilities = ['permit.create', 'permit.submit']; }, 403],
      ['Site Manager', () => { roles = ['SITE_MANAGER']; }, 403],
      ['CRO', () => { teamCapabilities = ['permit.cro_review', 'permit.forward_hse', 'permit.fallback_approve']; }, 403],
      ['HSE', () => { teamCapabilities = ['permit.hse_review']; }, 403],
      ['view-all holder', () => { individualCapabilities = ['permit.view_all']; }, 403],
      ['CEO', () => { roles = ['CEO']; }, 200],
      ['explicit CMS delegate', () => { individualCapabilities = ['permit.cms.manage']; }, 200],
      ['Site Manager with an explicit CMS grant', () => { roles = ['SITE_MANAGER']; individualCapabilities = ['permit.cms.manage']; }, 200],
    ];
    for (const [label, arrange, expected] of cases) {
      roles = []; teamCapabilities = []; individualCapabilities = [];
      arrange();
      assert.equal((await fetch(`${url}/cms/state`, { headers: session })).status, expected, label);
    }
  });
});

test('Dropbox integration stays CEO-only, even for a CMS delegate', async () => {
  individualCapabilities = ['permit.cms.manage'];
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/cms/dropbox/status`, { headers: session })).status, 403);
    assert.equal((await fetch(`${url}/cms/dropbox/connect`, { method: 'POST', headers: session })).status, 403);
  });
});

test('only the CEO can delegate CMS authority', async () => {
  roles = ['SITE_MANAGER'];
  await withServer(async (url) => {
    const response = await fetch(`${url}/admin/employees/${EMPLOYEE_ID}/permissions`, {
      method: 'POST', headers: { ...session, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'permit.cms.manage' }),
    });
    assert.equal(response.status, 403);
  });
});

test('cookie-authenticated CMS writes from another origin, or proving no origin, are refused', async () => {
  roles = ['CEO'];
  await withServer(async (url) => {
    const body = JSON.stringify({ revision: 3, organizationName: 'X', signInNotice: '' });
    const foreign = await fetch(`${url}/cms/identity`, {
      method: 'PATCH', headers: { cookie: session.cookie, origin: 'https://attacker.example', 'content-type': 'application/json' }, body,
    });
    assert.equal(foreign.status, 403);
    const originless = await fetch(`${url}/cms/identity`, {
      method: 'PATCH', headers: { cookie: session.cookie, 'content-type': 'application/json' }, body,
    });
    assert.equal(originless.status, 403);
  });
});

test('uploads accept only PNG/JPEG bodies within 2 MB, with a validated purpose and label', async () => {
  roles = ['CEO'];
  await withServer(async (url) => {
    const post = (query: string, type: string, bytes: Buffer) => fetch(`${url}/cms/assets?${query}`, {
      method: 'POST', headers: { ...session, 'content-type': type }, body: bytes,
    });
    assert.equal((await post('purpose=PDF_LOGO&label=Logo', 'image/svg+xml', Buffer.from('<svg/>'))).status, 400);
    assert.equal((await post('purpose=SCRIPT&label=Logo', 'image/png', Buffer.from('x'))).status, 400);
    assert.equal((await post('purpose=PDF_LOGO&label=%3Cscript%3E', 'image/png', Buffer.from('x'))).status, 400);
    const request = `requestId=${randomUUID()}`;
    assert.equal((await post(`purpose=PDF_LOGO&label=Logo&${request}`, 'image/png', Buffer.alloc(2 * 1024 * 1024 + 10))).status, 413);
    // The retry identity (A03) is required and must be a UUID.
    assert.equal((await post('purpose=PDF_LOGO&label=Logo', 'image/png', Buffer.from('x'))).status, 400);
    assert.equal((await post('purpose=PDF_LOGO&label=Logo&requestId=not-a-uuid', 'image/png', Buffer.from('x'))).status, 400);
    // A well-formed request whose bytes are not an image is refused by decoding.
    assert.equal((await post(`purpose=PDF_LOGO&label=Logo&${request}`, 'image/png', Buffer.from('not really a png'))).status, 400);
  });
});

test('PDF logo sets larger than the maximum are refused before any database write', async () => {
  roles = ['CEO'];
  await withServer(async (url) => {
    const logos = Array.from({ length: 5 }, (_, index) => ({
      assetId: `50000000-0000-4000-8000-00000000000${index}`, documentTypes: ['ISSUED_PERMIT'],
    }));
    const response = await fetch(`${url}/cms/pdf-logos`, {
      method: 'PUT', headers: { ...session, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 3, logos }),
    });
    assert.equal(response.status, 400);
  });
});

test('public branding needs no session, returns public-safe fields only, and falls back to bundled artwork', async () => {
  await withServer(async (url) => {
    const info = await fetch(`${url}/branding/public`);
    assert.equal(info.status, 200);
    assert.equal(info.headers.get('set-cookie'), null);
    assert.deepEqual(await info.json(), {
      organizationName: 'E-Set Engineering Services', signInNotice: null, webLogoVersion: null, iconVersion: null,
    });
    assert.equal((await fetch(`${url}/branding/web-logo`)).status, 404, 'no custom logo: keep the bundled one');
    assert.equal((await fetch(`${url}/branding/icon/192`)).status, 404, 'no custom icon: keep the bundled one');
    assert.equal((await fetch(`${url}/branding/icon/64`)).status, 404, 'only the published sizes exist');
    const manifest = await fetch(`${url}/branding/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') ?? '', /^application\/manifest\+json/);
    const body = (await manifest.json()) as { icons: { src: string }[]; start_url: string };
    assert.equal(body.start_url, '/');
    assert.ok(body.icons.every((icon) => icon.src.startsWith('/branding/')));
  });
});
