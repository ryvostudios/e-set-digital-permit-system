# Project Context

## What This Is

E-Set Digital Permit System is a new, production Progressive Web
Application for managing work permits: creation, CRO review, HSE review,
issuance, hold/resume, cancellation, renewal, and closure, with full
audit history.

It will be developed in VS Code, version-controlled with Git/GitHub, and
built step by step, one verified section at a time.

## Relationship to Other Systems

- **E-Set Digital Management System** — a separate, unrelated application.
  This project shares no code, database, or deployment with it.
- **V5.19 legacy permit system** — a business/workflow reference only.
  Its rules around numbering, CRO/HSE review, and closure inform this
  system's workflow requirements, but its technical architecture must
  not be copied into this system. Notably, V5.19's `SYSTEM_ADMIN` role is
  **not** assumed to exist here (see [[DECISIONS.md]]).

## Current State (as of this document)

- Repository initialized; no application code exists yet.
- No frontend, backend, or database framework has been installed or
  configured.
- No database schema, tables, or migrations exist.
- Only planning documentation exists: this file, `ARCHITECTURE.md`,
  `WORKFLOW.md`, `SECURITY.md`, `DATABASE.md`, `DECISIONS.md`, `README.md`.
- Empty `backend/`, `frontend/`, `database/`, `docs/` directories exist as
  placeholders only.

## Core Scope

- Permit creation and submission by permitted team users.
- Sequential review: CRO first, then HSE (with a strict 5-minute review
  window and CRO fallback approval authority).
- Permit issuance with authoritative actor/timestamp recording.
- Midnight-based validity (not rolling 24-hour), evaluated using
  authoritative backend/database time in the configured site timezone.
- Hold / Resume of permits by CRO.
- Cancellation by CRO (preserving history, no deletion).
- Closure by CRO only (no creator-initiated closure).
- Renewal after midnight expiry, issuing a new Permit Number while
  preserving the same JSA Number and linking to permit history.
- Read-only PDF generation for issued and closed permits, reflecting the
  official form layout.
- Durable, non-blocking WhatsApp lifecycle notifications (future
  integration; permit actions must never depend on notification delivery).
- Capability-based authorization derived from Team + Position, plus a
  separate privileged management tier (CEO, Site Manager).

## Explicitly Out of Scope (for now)

- Microservices, message brokers, Redis, Kubernetes, or other scaling
  infrastructure not justified by an actual current requirement.
- Digital signature functionality.
- Any assumption about the final WhatsApp integration method.
- Any application code, dependency installation, or database schema —
  these begin only after this documentation baseline is accepted and
  implementation proceeds section by section.

## How to Use This Documentation Set

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — target stack, trust boundaries, module principles.
- [`WORKFLOW.md`](./WORKFLOW.md) — permit lifecycle states and transitions, with open questions flagged.
- [`SECURITY.md`](./SECURITY.md) — security/integrity requirements and per-section development gates.
- [`DATABASE.md`](./DATABASE.md) — database design principles only (no schema yet).
- [`DECISIONS.md`](./DECISIONS.md) — accepted decisions and the authoritative open-decisions log.

These files are the authoritative source of truth for requirements until
superseded by actual code, migrations, and configuration once
implementation begins.
