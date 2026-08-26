import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDocumentJobsCli } from './processDocumentJobs.js';
import { runWhatsappOutboxCli } from './processWhatsappOutbox.js';

const hostile = 'https://secret.example/?token=SUPER_SECRET_TOKEN Authorization: Bearer abc123 DATABASE_URL=postgres://user:password@host/db sb_secret_FAKE_SECRET';

for (const [name, run] of [
  ['document', runDocumentJobsCli],
  ['WhatsApp', runWhatsappOutboxCli],
] as const) {
  test(`${name} worker top-level logging sanitizes hostile external/database exceptions`, async () => {
    const output: string[] = [];
    const ok = await run({
      process: async () => { throw new Error(hostile); },
      log: (message: string) => output.push(message),
      error: (message: string) => output.push(message),
    } as never);
    assert.equal(ok, false);
    const rendered = output.join('\n');
    assert.doesNotMatch(rendered, /SUPER_SECRET_TOKEN|Bearer abc123|postgres:\/\/|sb_secret_FAKE_SECRET/);
    assert.match(rendered, /unknown database error/);
  });
}
