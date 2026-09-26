# Permit storage, CMS and branding

Phase 4 of the shared E-Set platform. Permit owns its storage and its CMS;
nothing here is shared with ESDMS: no connection record, token, file
registry, root folder, CMS table, permission or user. Platform contract:
`docs/PLATFORM_DATABASE_ARCHITECTURE.md` in the ESDMS repository.
Verified with fakes and disposable databases only. No real Dropbox
account was used, and nothing has been deployed.

## 1. Dropbox architecture

- **Permit's own Dropbox app connection.** It can point at the same
  company Dropbox account ESDMS uses, but everything about it is separate:
  - the connection record and tokens (`permit.storage_connections`);
  - the OAuth configuration;
  - the file registry;
  - the root folder;
  - who may manage it (the Permit CEO).
- **Independent of ESDMS.** Disconnecting Permit Dropbox does not affect
  ESDMS, and the reverse is also true.
- **Dropbox holds files; PostgreSQL holds records.** Dropbox stores the
  issued PDFs and CMS images. PostgreSQL (`permit` schema) remains
  authoritative for:
  - permits, numbering, workflow and audit;
  - users and authorization;
  - CMS configuration;
  - the file registry and connection metadata.
- **Provider changes apply to future writes only.** New files go to the
  active connection. An existing file is always read from the connection
  it was written to (`file_registry.connection_id`).
- **Downloads stay authorized by the backend.** There are no public or
  shared Dropbox links.

### Folder structure (inside the app folder)

```
Digital Permit System/
├── Permits/<YYYY>/<permit-number>/{Issued,Closed,Evidence,Attachments}/
├── JSA/<YYYY>/
├── Reports/
├── Exports/
├── Branding/          PDF and website logos
└── CMS Assets/        favicon / app icon sources
```

Paths are built only by `storage/paths.ts`:
- deterministic, and derived from the permit number and the job or asset
  id, never from user text alone;
- each segment is sanitized to `[A-Za-z0-9 _-]`, with a hash suffix when
  anything was changed;
- no `/` or `.` survives in a segment, so nothing can climb out of the
  root;
- the root prefix is re-checked before every upload.

Uploads never overwrite (`mode: add`). Each upload is checked against
Dropbox's own content hash.

## 2. OAuth and token security

Only the CEO can connect, test, activate, deactivate or disconnect.

- **Flow:** authorization code with PKCE (S256), offline access (refresh
  token), and a minimal scope set.
- **The `state` value:** 32 random bytes. The database stores only its
  SHA-256. It is bound to the starting user and session, expires after
  10 minutes, and is consumed on use (single-use).
- **The PKCE verifier:** stored sealed.
- **Tokens:** sealed with AES-256-GCM. The associated data binds each
  envelope to its key version and connection (or OAuth state), so an
  envelope cannot be moved to another row. Key: `PERMIT_STORAGE_MASTER_KEY`
  (32 bytes, base64), version: `PERMIT_STORAGE_KEY_VERSION`.
- **Where tokens never appear:** API responses, the frontend, logs,
  audit rows, URLs or Git.
- **The client secret:** only ever sent from the backend to Dropbox, in
  the body of a POST.
- **Refresh:** happens server-side before expiry, and the new tokens are
  re-sealed under a new token revision (a compare-and-swap on the
  connection's revision).
- **Provider responses:** the HTTP client pins the Dropbox origins,
  refuses redirects, and caps response size and time. Provider response
  bodies are never logged.
- **Key rotation (Phase 6):** see "Rotating the storage key" below.

### Rotating the storage key

- **One active key.** `PERMIT_STORAGE_MASTER_KEY` with
  `PERMIT_STORAGE_KEY_VERSION` seals every new envelope.
- **Previous keys are read-only.** `PERMIT_STORAGE_PREVIOUS_KEYS` holds
  them as `version:base64key[,…]`. Versions and keys must all be distinct,
  and the configuration is refused otherwise, without echoing any key.
- **The envelope chooses its key.** Each envelope names the version it was
  sealed with, and is opened only with that key. The version is also part
  of the AES-GCM associated data, so relabelling an envelope fails. Tags
  must be the full 16 bytes.
- **Fail closed.** An unknown version cannot be opened: the connection is
  unavailable, never guessed.
- **Re-sealing.** Tokens still under a previous key are re-sealed under the
  active key the next time they are used, through the same
  compare-and-swap as a refresh. `npm run storage:rekey -- --execute` does
  it for every connection at once. Short-lived OAuth states are never
  rewritten; they expire within 10 minutes.
- **Removing a key.** `npm run storage:rekey` (a dry run, versions and
  counts only) lists `removableVersions`: previous versions that no
  credential and no unexpired OAuth state references. Remove a version
  from `PERMIT_STORAGE_PREVIOUS_KEYS` only when it is listed there. If a
  referenced key has been removed, it appears in `missingVersions` in the
  command output and in the CEO storage status, and the command exits 2.
  Restore that key from the secret manager; do not reconnect blindly.

**Procedure**
1. Generate a new 32-byte key in the secret manager.
2. Set it as the active key under a new version, and move the old key to
   `PERMIT_STORAGE_PREVIOUS_KEYS`.
3. Deploy.
4. Run `npm run storage:rekey -- --execute`.
5. Run `npm run storage:rekey` until the old version is removable, then
   remove it and deploy.

Key material lives only in the environment and secret manager: never in
the database, Git or logs.

**Setup (variable names only):** `DROPBOX_CLIENT_ID`,
`DROPBOX_CLIENT_SECRET`, `DROPBOX_OAUTH_ORIGIN` (the bare HTTPS origin
serving `/api/v1`; the redirect URI is
`<origin>/api/v1/cms/dropbox/callback`), `PERMIT_STORAGE_MASTER_KEY`,
`PERMIT_STORAGE_KEY_VERSION`, and during a rotation
`PERMIT_STORAGE_PREVIOUS_KEYS`.
- Use a **Dropbox App Folder** app with the scopes `account_info.read`,
  `files.metadata.read`, `files.content.write` and `files.content.read`.
- Use a company-owned Dropbox account. Never a personal one.

## 3. File registry (`permit.file_registry`)

Each file's registry row records:
- its id, provider and connection;
- its logical key and the deterministic remote path;
- the remote id once uploaded;
- its category (issued PDF, closed PDF, JSA, evidence, attachment,
  report, export, branding, CMS asset);
- the related permit, JSA or document job;
- the file name and MIME type;
- its size and SHA-256;
- who created it, and when.

Once a row is `ready`, its identity can never change (enforced by a
trigger).

**Write order:** the registry row is reserved **before** any network call.
A retried or ambiguous upload therefore reuses the same path on the same
connection and cannot orphan a file. Every read is checked against the
registry's size and SHA-256 before a byte is used.

**Disconnect protection:**
- A connection cannot be disconnected while it is the active one, or while
  a `pending` or `ready` registry row references it. The refusal is audited
  (`DISCONNECT_REFUSED`).
- `cleanup_pending` rows (verified to have no remote object and no
  reference, §6) do not count.
- A connection's dependent-file count is shown in the CMS.

### Connection lifecycle and concurrency (A01 remediation)

States: `connected`, `error` (the last health check failed), `disconnecting`
and `disconnected`. Every transition is a compare-and-swap on `revision` and
`status`, committed in its own short transaction. Remote I/O never runs
inside a transaction.

**Health check**
- It records `connected`/`error` only if the connection still has the
  revision and a live status (`connected`/`error`) it started from.
- A check overtaken by any lifecycle change is refused and writes nothing.
  It never selects, revives or touches credentials.

**Disconnect**
1. **Claim.** Lock the selection and the connection, match the caller's
   revision, refuse if selected or referenced, then set `disconnecting`
   with a new revision. From here, no activation, selection, upload
   reservation, health result or token refresh can use the connection.
2. **Revoke** the token at Dropbox, with no lock held. A 401 means the
   token is already unusable and counts as revoked.
3. **Finalize.** The claimed revision and `disconnecting` must still hold,
   the dependencies are re-checked, and only then are the credentials
   cleared and the connection marked `disconnected`.

**Recovery**
- A `disconnecting` connection is never usable and keeps its credentials
  until finalization.
- `last_error_code` (shown in the CMS storage status) says why it stopped:
  - `revoke_unconfirmed`: the revocation failed or its response was lost;
  - `finalize_pending`: revoked, but the local finalization did not commit
    or found a dependency, so it failed closed.
- In both cases the CEO retries the disconnect, which re-claims under the
  current revision; a token already revoked answers 401 and is accepted.
  Alternatively the CEO reconnects the same account, which stores new
  credentials under a new revision and cancels the disconnect. A stale
  disconnect or health result can then no longer apply.

**Enforced by the database**
Migration 0043 enforces these rules in PostgreSQL, so they hold for every
backend process:
- A connection leaves `disconnecting`/`disconnected` only through a
  revision-bumping reconnect.
- Credentials are frozen while `disconnecting`.
- It can start disconnecting, and have its credentials cleared, only when
  unselected and unreferenced.
- A registry reservation or selection is accepted only for a `connected`
  connection with credentials, read `FOR SHARE`, which conflicts with the
  disconnect claim's lock.

The interleavings are tested in `backend/src/storage/lifecycle.test.ts`.

## 4. Issued documents and `storage.buckets`

Issuance is unchanged: the immutable snapshot and its PDF job are written
in the issuance transaction, and the existing background job renders and
stores the PDF.

- **Where PDFs go:** the job now stores through `PermitDocumentStorage`
  (Permit Dropbox plus the registry).
- **Old objects:** they remain readable through the legacy Supabase
  Storage (S3) adapter until they are copied.
- **`storage.buckets`:** the preflight query is **removed**. Readiness is
  checked through the storage provider itself (the selected account and
  the root folder). Permit database roles have no access to Supabase's
  `storage` schema, and no runtime SQL references it.

### Branding snapshot and renderer V4

Issued PDFs are content-addressed: a job pins its renderer and file hash
the first time it renders, and every later render must reproduce them.

- **Snapshot:** issuance now freezes the CMS branding into the immutable
  snapshot. That is the organization name and the ordered PDF logos, by
  immutable file id and SHA-256.
- **Renderer V4 (`PDFKIT_V4`, migration 0042):** V3's layout plus a
  logo band.
  - New jobs use V4. V1–V3 are unchanged byte for byte.
  - A snapshot without branding prints the V3 bytes under V4.
- **Loading logos:** logos are read by file id and SHA-256. If one is
  unavailable, the attempt fails and retries **before** any identity is
  pinned.
- **Transparency:** logos are flattened onto white when uploaded, because
  pdfkit's embedding of transparent PNGs is not byte-stable. V4 refuses any
  logo that still has an alpha channel.
- **Historical immutability:** changing the CMS never alters an issued
  permit. This is tested permanently in `domain/cms/cms.test.ts`.

**Logo layout:** at most **4** logos, which is the number of equal slots
across the A4 content width (about 128 pt each).
- Each logo is scaled to fit its slot, with its aspect ratio kept. Logos
  are never cropped, stretched or overlapped.
- The group is centred, and the order is left to right.
- Only preset geometry is used: the CMS supplies no coordinates, CSS or
  HTML.
- A long organization name is held to one line with an ellipsis.

## 5. Old Supabase Storage migration (offline)

Command: `npm run storage:migrate-legacy`. It is a dry run by default; add
`-- --execute` to copy. It runs only when an operator runs it, needs the
legacy S3 variables and Permit Dropbox, and must never be run against
production without an approved window.

For each generated document still at its legacy key:
1. Read the object.
2. Refuse it unless its SHA-256 equals the job's pinned `file_hash`.
3. Upload it through the normal Permit storage path, registered under the
   **same** logical key. Downloads then transparently prefer the Dropbox
   copy.
4. Read it back and compare the hash again.

Properties:
- **Non-destructive:** the source is never deleted and the job row is not
  rewritten.
- **Resumable and idempotent:** a completed copy is skipped, and an
  interrupted one resumes on its reservation.
- **Keyset-paginated.**
- **Report contents:** counts and job ids only.
- **Verification (Phase 6):** `npm run storage:migrate-legacy -- --verify`
  re-reads every migrated copy through the registry. It is read-only and
  reports any job whose Dropbox copy no longer matches its pinned hash; such
  a copy is never served, because downloads fail closed. A copy altered
  after migration is skipped by later copy runs, so this check is what
  reports it. Restore it from Dropbox version history or re-upload the
  legacy object.
- Rehearsed end to end in
  `src/scripts/migrateLegacyStorage.integration.test.ts`, using the real
  registry and `DropboxProvider` over an in-memory Dropbox. It covers:
  - a missing source, a network failure and a lost response;
  - resume, including two overlapping runs;
  - idempotency and registry reconciliation;
  - an untouched source and a tampered destination.

## 6. CMS

Sections:
- **Organization and content:** the organization name (printed as the
  issuer on new permits) and a public, plain-text sign-in notice.
- **PDF branding:** upload logos, choose up to four, and set their order.
- **Website and app icon:** the header/sign-in logo, and the favicon/PWA
  icon.
- **Integrations** (CEO only): Permit Dropbox.
- **Audit.**

Every write is revision-checked (a stale editor gets a 409) and audited.

**Authorization:**
- Allowed: the **CEO**, or a person the CEO explicitly granted
  `permit.cms.manage` (an individual grant, recorded in
  `user_capability_grants`).
- Not allowed by role: Site Manager, CRO, HSE, team lead, ordinary
  employee.
- A Team + Position can never carry this capability (the database refuses
  it).
- Only the CEO may grant it.
- Dropbox integration stays CEO-only, even for a delegate.

**Audit:**
- `cms_audit_events` covers setting and content changes, logo uploads,
  the PDF branding set, and web logo and PWA icon changes.
- `storage_audit_events` covers connect, test, activate, deactivate and
  disconnect, including refusals.
- Both are append-only. They record which field changed or which asset
  was used, never values, image bytes, paths, tokens or keys.

## 7. Website, favicon and PWA branding

Public endpoints need no session and return public-safe data only:

| Endpoint | Returns |
| --- | --- |
| `/api/v1/branding/public` | organization name, sign-in notice, and content digests used as versions |
| `/api/v1/branding/web-logo` | the published website logo |
| `/api/v1/branding/icon/{32,180,192,512}` | icon derivatives from the validated 512 px source |
| `/api/v1/branding/manifest.webmanifest` | the app manifest |

- Bytes are served only after their SHA-256 matches, with `nosniff`,
  ETags and versioned URLs.
- The frontend keeps the bundled `/branding/*` files and the static
  manifest as the fallback. It switches the header/sign-in logo, favicon,
  touch icon and manifest only after a successful, well-formed response.
- A CMS, database or Dropbox failure never blocks sign-in: the app looks
  exactly as it did before.
- The service worker never caches `/api/`.

**Platform limitation:** browsers and operating systems cache installed PWA
icons. A new icon reliably affects **new installs**. An already-installed
app may keep its old icon until the platform refreshes it or the app is
reinstalled.

## 8. Image security (all CMS uploads)

- **Nothing about the upload is trusted:** not the file name, the
  extension or the declared type.
- **Accepted input:** raw PNG or JPEG bodies up to 2 MB (the server
  refuses anything else, including SVG).
- **Decoding:** the bytes are decoded with `sharp`, with a pixel limit
  (4096 × 4096). The decoded format must match the declared type.
- **Dimensions:** 32–4096 px. The PWA icon must be square and at least
  512 px.
- **Output:** the image is re-encoded to a bounded canonical PNG, and only
  that PNG is stored.
- **Tooling:** no shell is involved anywhere.

## 9. Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Dropbox not connected | CMS uploads return 503; public branding falls back; new PDF jobs stay pending and retry |
| Upload interrupted | Registry reservation stays `pending` on a pinned path; the retry completes it |
| Bytes altered remotely | Integrity mismatch; never served, never rendered |
| Logo unreadable at render time | Job attempt fails before pinning; retried with back-off |
| Connection has files | Disconnect refused and audited |
| Disconnect interrupted (revoke unknown, or finalization failed) | Connection stays `disconnecting` with credentials and `last_error_code`; never usable; retry the disconnect or reconnect |
| Health check overtaken by a lifecycle change | Refused (409); nothing written |

## 10. Open items

- **Legacy copy not yet run against real storage:** it is rehearsed with
  fakes. The production run needs the approved cut-over window.
- **Closed-permit PDF:** the `CLOSED_PDF` storage category is reserved, but
  no closed-permit document is generated. Closure is recorded in the
  lifecycle log, and the issued PDF stays immutable.
- **Deployment requirement:** Permit's frontend and API must be same-site
  (same registrable domain or same origin via rewrite). The Phase 3
  cookie-session requirement also covers the OAuth callback.
