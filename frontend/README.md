# E-SET Digital Permit System — Frontend

The browser application for the E-SET Permit to Work system: raising
permits and their Job Safety Analysis, CRO and HSE review, permit
records, notifications, and employee/Site Manager administration.

React 19 + TypeScript, built with Vite. No UI framework — the design
system in `src/ui` and `src/styles` is the whole of it.

---

## The one rule that shapes everything here

**The backend is authoritative. The frontend is a view onto it.**

This application decides nothing about who a person is or what they may
do. It asks `GET /api/v1/auth/me` and renders the answer. Hiding a
button, a link, or a whole screen is a courtesy that removes clutter —
never a security control. Every route stays reachable, every request is
re-authorized server-side, and a refusal is shown honestly rather than
disguised as an empty list.

Three consequences worth stating outright:

- **Identity is never inferred.** Not from an email address, not from an
  email domain, not from Supabase `user_metadata`, and not from a
  Position name. ZPL's `Site Manager` *position* is an ordinary employee;
  the privileged `SITE_MANAGER` *role* is something else entirely, and
  only `privilegedRoles` from `/auth/me` distinguishes them. The same
  holds for ZPL's `HSE` position, which carries no permit approval
  authority.
- **Applicant identity is server-derived.** There is no editable control
  anywhere for an applicant's name, company, or designation, and no
  request body carries one.
- **Which actions exist is the server's answer.** A permit's
  `availableActions` comes from the backend, which owns the state
  machine, the capability model, and the clock. Nothing here computes a
  workflow transition or times a review window.

---

## Getting started

```bash
npm install
cp .env.example .env      # then fill in the values below
npm run dev               # http://localhost:5173
```

The backend must be running separately (see `../backend`), and its
`CORS_ALLOWED_ORIGINS` must include this dev origin.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with fast refresh |
| `npm run build` | Typecheck (`tsc -b`) then production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Full test suite (Vitest + Testing Library, jsdom) |
| `npm run test:watch` | Tests in watch mode |
| `npm run typecheck` | TypeScript only |
| `npm run lint` | oxlint |

## Environment variables

Only **public, browser-safe** values may be configured. Everything a Vite
build reads through `VITE_*` is compiled into the JavaScript bundle and
is readable by anyone who opens the application.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | yes | Backend origin, **without** `/api/v1` — the API client appends that. Leave empty when the frontend is served from the same origin as the API. |
| `VITE_SUPABASE_URL` | yes | Supabase project URL. Used for authentication only. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | Supabase publishable (anon) key. Public by design. |

**Never** set `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`,
`MIGRATION_DATABASE_URL`, `PRIVILEGED_DATABASE_URL`,
`S3_SECRET_ACCESS_KEY`, a database password, or any operator credential —
in a `VITE_*` variable or anywhere else in this package. These are
server-only. `src/test/security.test.ts` fails the test run if any of
them is ever referenced from frontend source, and also asserts that the
application reads no `VITE_*` variable beyond the three above.

`.env` is gitignored and must never be committed. `.env.example` carries
the names with empty values.

### Supabase browser configuration

The browser Supabase client (`src/auth/supabaseClient.ts`) holds the
publishable key and is used for **authentication only**. It never queries
an application table: every table in this system is default-deny with no
policy for the `anon`/`authenticated` roles, so all application data is
read through the backend API, which verifies the token and re-resolves
authorization server-side on every request.

---

## Architecture

```
src/
  api/          client.ts (the ONLY fetch), endpoints.ts, errors.ts, types.ts
  app/          router and the authentication gate
  auth/         Supabase client, /auth/me bootstrap, capability helpers
  ui/           design system: Button, Field, Dialog, Feedback, Layout, Toast
  layout/       application shell, sidebar/drawer, navigation model
  lib/          data fetching, cache invalidation, formatting
  features/
    auth/         login, forced password change
    home/         operational home screen
    permits/      apply, document + JSA rendering, editors, actions, records
    review/       CRO and HSE queues
    notifications/
    admin/        employees, Site Managers, organization lookup
  pwa/          service-worker registration
  styles/       tokens.css (all colour), base.css
  test/         setup, fixtures, render harness, security invariants
```

**One network boundary.** `src/api/client.ts` is the only module in the
application that calls `fetch`. It attaches the access token per request
(never holding one), maps every failure onto a single error model, and
tears the session down centrally on a 401. `endpoints.ts` names every
backend route the frontend can reach, one typed function each, with
request bodies built field by field so mass assignment is impossible from
this side.

**One place for colour.** Every colour in the application is a CSS
variable declared in `src/styles/tokens.css`. No component hard-codes a
hex value, so rebranding is a change to that one file.

**No client cache of protected data.** Screens fetch what they need on
mount and re-fetch after any mutation. A sign-out bumps a generation
counter so a response in flight for the previous account is dropped
rather than rendered, and a permission change invalidates every mounted
screen — a revoked permission produces a narrower list on the next load,
never a stale wider one.

---

## PWA

The app ships a web manifest and a deliberately conservative service
worker (`public/sw.js`), registered only in a production build.

**It caches the static application shell and nothing else.** Explicitly
never cached:

- any `/api/` response — permit content, JSA content, employee records,
  notifications, and audit history are authorization-scoped data, and a
  cached copy would outlive the permission that produced it and remain on
  the device after the next person signs in;
- the permit PDF;
- any request carrying an `Authorization` header;
- any non-GET request, so no mutation can be replayed from a cache.

Protected permit data is therefore not offline-readable. Making it so
would need a deliberate secure offline design, which does not exist.

Signing out asks the worker to drop its caches.

---

## Accessibility

Semantic HTML throughout; a labelled control for every input, with hints
and errors wired through `aria-describedby`; one visible focus treatment
that is never removed; a skip link; real focus management and a focus
trap in dialogs, with focus returned on close; the mobile drawer removed
from the tab order when closed; status conveyed by text as well as
colour; and touch targets sized for gloved hands.

## Responsive behaviour

Verified at 360, 390, 430, tablet, laptop, and large desktop. Lists ship
**two real renderings** — a table on wide screens and labelled record
cards on narrow ones — so a phone never receives a table scrolled off the
edge. Wide content scrolls inside its own container; the page body never
scrolls sideways.

---

## Production operator prerequisites

The backend fails closed when a server-side prerequisite is not
configured. The frontend handles each state with a professional message
and never names a credential, variable, database, or host.

| Prerequisite | What the frontend shows |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` absent | Employee account operations report "Account management is not available in this environment." |
| `PRIVILEGED_DATABASE_URL` / `privileged_runtime` absent | Site Manager administration shows a fail-closed notice, and the create control is disabled. Employee administration and the permit workflow are unaffected. |
| CEO not yet bootstrapped | No account holds CEO authority, so CEO-only screens refuse in the ordinary way. |
| Private PDF storage not configured | The permit document action reports "Document storage is not configured for this environment." The permit record itself is unaffected. |
| Production Auth/MFA settings pending | Sign-in behaves as Supabase Auth is configured; the frontend adds no policy of its own. |

None of these is worked around client-side.

## Testing

```bash
npm test
```

Vitest with Testing Library over jsdom. The suite covers the login flow
and Remember Me, the `/auth/me` bootstrap and logout cleanup, the
identity model (including both ZPL name collisions), capability-driven
navigation, the permit lifecycle screens, CRO and HSE review, records
visibility, the full employee lifecycle, Site Manager administration, the
notification list, and every backend error state — plus a set of security
invariants enforced by scanning the source tree.
