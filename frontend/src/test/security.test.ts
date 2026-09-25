/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Frontend security invariants, enforced over the actual source tree.
 *
 * These are the checks that are cheap to state and expensive to
 * rediscover after a regression: no secret may be read from the
 * environment, no component may inject HTML, no password may be
 * persisted, and no screen may build a storage URL of its own.
 *
 * Scanning the source (rather than asserting on rendered output) is
 * deliberate: a violation introduced in ANY file fails here, including a
 * file nobody wrote a screen test for.
 */

const SRC = join(process.cwd(), 'src');
const PUBLIC = join(process.cwd(), 'public');

function walk(directory: string, extensions: string[]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walk(full, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      results.push(full);
    }
  }
  return results;
}

const SOURCE_FILES = walk(SRC, ['.ts', '.tsx']);
const APP_FILES = SOURCE_FILES.filter(
  (file) => !file.includes(`${sep}test${sep}`) && !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'),
);

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function offenders(files: string[], predicate: (content: string, file: string) => boolean): string[] {
  return files.filter((file) => predicate(read(file), file)).map((file) => relative(process.cwd(), file));
}

describe('no server secret can reach the browser bundle', () => {
  const FORBIDDEN_NAMES = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SERVICE_ROLE',
    'DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'PRIVILEGED_DATABASE_URL',
    'S3_SECRET_ACCESS_KEY',
    'S3_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ];

  // Scanned over APP_FILES - the code that actually reaches the bundle.
  // Test files legitimately NAME these strings in order to assert they
  // are never shown to a person; this file names all of them.
  it.each(FORBIDDEN_NAMES)('never references %s', (name) => {
    expect(offenders(APP_FILES, (content) => content.includes(name))).toEqual([]);
  });

  it('reads only the documented public API origin', () => {
    const referenced = new Set<string>();
    for (const file of SOURCE_FILES) {
      for (const match of read(file).matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) {
        if (match[1]) referenced.add(match[1]);
      }
    }
    // PROD and MODE are Vite's own build-mode flags, not configuration
    // and not credentials: they carry a literal like "production" or
    // "e2e". MODE gates the e2e-only form-preview route out of the
    // shipped bundle. Everything else must still be a documented public
    // VITE_ variable.
    referenced.delete('PROD');
    referenced.delete('MODE');
    expect([...referenced].sort()).toEqual(['VITE_API_BASE_URL']);
  });
});

describe('no HTML injection surface exists', () => {
  it('never uses dangerouslySetInnerHTML', () => {
    expect(offenders(APP_FILES, (content) => content.includes('dangerouslySetInnerHTML'))).toEqual([]);
  });

  it('never assigns innerHTML or outerHTML', () => {
    expect(offenders(SOURCE_FILES, (content) => /\.(inner|outer)HTML\s*=/.test(content))).toEqual([]);
  });

  it('never uses eval or the Function constructor', () => {
    expect(offenders(SOURCE_FILES, (content) => /\beval\(|new Function\(/.test(content))).toEqual([]);
  });

  it('never calls document.write', () => {
    expect(offenders(APP_FILES, (content) => content.includes('document.write('))).toEqual([]);
  });
});

describe('credentials are never persisted or logged', () => {
  it('writes nothing password-shaped to browser storage', () => {
    expect(
      offenders(APP_FILES, (content) =>
        /(localStorage|sessionStorage)\.setItem\([^)]*(password|Password|token|Token|secret)/.test(content),
      ),
    ).toEqual([]);
  });

  it('logs no password, token, or credential value', () => {
    expect(
      offenders(APP_FILES, (content) =>
        /console\.(log|info|warn|error|debug)\([^)]*(password|Password|accessToken|access_token|temporaryPassword|bearer)/i.test(
          content,
        ),
      ),
    ).toEqual([]);
  });

  it('leaves browser storage entirely to the auth module', () => {
    // EXACTLY ONE module touches browser storage, so there is exactly one
    // place to audit for what this application persists on a device.
    const users = offenders(APP_FILES, (content) =>
      /localStorage|sessionStorage|indexedDB|document\.cookie/.test(content),
    );
    expect(users).toEqual([join('src', 'auth', 'clearLegacyCredentials.ts')]);
  });

  it('has no console logging at all in application code', () => {
    expect(offenders(APP_FILES, (content) => /\bconsole\.(log|info|debug)\(/.test(content))).toEqual([]);
  });
});

describe('the network boundary is centralized', () => {
  it('calls fetch from the API client alone', () => {
    const users = offenders(APP_FILES, (content) => /(^|[^.\w])fetch\(/m.test(content));
    expect(users).toEqual(['src\\api\\client.ts'.replaceAll('\\', sep)]);
  });

  it('never hard-codes a storage, S3, or Supabase Storage URL', () => {
    expect(
      offenders(SOURCE_FILES, (content) =>
        /(amazonaws\.com|\.s3\.|\/storage\/v1\/object|supabase\.co\/storage)/.test(content),
      ),
    ).toEqual([]);
  });

  it('never constructs a signed or public document link', () => {
    expect(
      offenders(APP_FILES, (content) => /createSignedUrl|getPublicUrl|signedUrl|publicUrl/.test(content)),
    ).toEqual([]);
  });

  it('never queries an application table through the browser Supabase client', () => {
    // The browser client authenticates only. `.from(...)`/`.rpc(...)`
    // would be direct data access, bypassing the backend's authorization.
    expect(offenders(APP_FILES, (content) => /supabase\.(from|rpc|storage)\(/.test(content))).toEqual([]);
  });
});

describe('identity is never inferred', () => {
  it('never reads Supabase user_metadata or app_metadata for application identity', () => {
    // Property ACCESS, not the words - the auth module's doc comment
    // names them precisely to record that they are ignored.
    expect(
      offenders(APP_FILES, (content) => /[.[]\s*['"]?(user_metadata|app_metadata)['"]?\s*\]?/.test(content)),
    ).toEqual([]);
  });

  it('never derives a role or a company from an email address', () => {
    expect(
      offenders(APP_FILES, (content) => /email\.(split|endsWith|includes|match)\(|@eset|@zpl|@sgre/i.test(content)),
    ).toEqual([]);
  });

  it('never treats a Position NAME as authority', () => {
    // `positionName` may be DISPLAYED, but never compared against a role
    // string - that is the ZPL "Site Manager" collision.
    expect(
      offenders(APP_FILES, (content) =>
        /positionName\s*===|positionName\s*!==|positionName\.includes\(|positionName\s*==\s*/.test(content),
      ),
    ).toEqual([]);
  });

  it('never decodes the JWT to read claims', () => {
    expect(offenders(APP_FILES, (content) => /jwtDecode|atob\(|decodeJwt|jose/.test(content))).toEqual([]);
  });
});

describe('the service worker caches only the application shell', () => {
  const worker = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');

  it('excludes the API from caching entirely', () => {
    expect(worker).toContain("url.pathname.startsWith('/api/')");
  });

  it('refuses to cache an authenticated request', () => {
    expect(worker).toContain("request.headers.has('authorization')");
  });

  it('caches GET requests only, so no mutation can be replayed', () => {
    expect(worker).toContain("request.method !== 'GET'");
  });

  it('names no permit, employee, or notification path as cacheable', () => {
    expect(worker).not.toMatch(/SHELL_URLS[^;]*\/(permits|admin|notifications)/);
  });
});

describe('no committed environment file carries a real value', () => {
  it('ships only an example file with empty values', () => {
    const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    for (const line of example.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [name, ...rest] = trimmed.split('=');
      const value = rest.join('=');
      expect(name?.startsWith('VITE_')).toBe(true);
      // Only the local dev API base URL is pre-filled; nothing else.
      if (name !== 'VITE_API_BASE_URL') expect(value).toBe('');
    }
  });
});
