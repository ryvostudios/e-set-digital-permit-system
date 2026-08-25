-- Section 6: Team + Position -> Capabilities authorization foundation.
--
-- Operational permissions are never assigned directly to a user as a role
-- (no WORKER/CRO/HSE/etc. column or table), and never derived from a
-- Position alone. Capabilities are derived from the explicit combination
-- of a Team and a Position (`team_positions`); a user is assigned to one
-- or more of those combinations, never to a bare Position. The backend
-- resolves and checks capabilities at request time; this schema only
-- stores the data that resolution reads.
--
-- Privileged management access (CEO, Site Manager) is a separate
-- authority tier and is intentionally NOT modeled here - Team + Position
-- must never be able to grant it (see ARCHITECTURE.md / SECURITY.md /
-- DECISIONS.md). No permit/JSA business tables are created here either.
--
-- RLS: every table below is created in `public` and picked up by the
-- database's existing automatic RLS-enable mechanism (see migration
-- 0001, which locks down `public.rls_auto_enable()`); this migration
-- does not disable RLS on any table and defines no policies, so with RLS
-- enabled and zero policies these tables are default-deny for any
-- non-owner role. As defense in depth on top of that, and consistent
-- with 0001's REVOKE on `rls_auto_enable()`, table privileges are also
-- explicitly revoked from PUBLIC/anon/authenticated below - only the
-- backend's own database role (table owner) reads/writes this data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT teams_name_unique UNIQUE (name),
  CONSTRAINT teams_name_not_blank CHECK (btrim(name) <> '')
);
REVOKE ALL ON TABLE teams FROM PUBLIC, anon, authenticated;

CREATE TABLE positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT positions_name_unique UNIQUE (name),
  CONSTRAINT positions_name_not_blank CHECK (btrim(name) <> '')
);
REVOKE ALL ON TABLE positions FROM PUBLIC, anon, authenticated;

-- The explicit Team + Position combination that capabilities attach to.
-- A given Position can be combined with more than one Team (and vice
-- versa), but the same (team, position) pair may only exist once.
CREATE TABLE team_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  position_id UUID NOT NULL REFERENCES positions (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_positions_unique UNIQUE (team_id, position_id)
);
REVOKE ALL ON TABLE team_positions FROM PUBLIC, anon, authenticated;

-- The full set of grantable operational capabilities (e.g. eventual
-- permit.* names). No rows are seeded by this migration - populating and
-- assigning capabilities is a later, scoped decision.
CREATE TABLE capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT capabilities_name_unique UNIQUE (name),
  CONSTRAINT capabilities_name_not_blank CHECK (btrim(name) <> '')
);
REVOKE ALL ON TABLE capabilities FROM PUBLIC, anon, authenticated;

-- Which capabilities a Team + Position combination grants.
CREATE TABLE team_position_capabilities (
  team_position_id UUID NOT NULL REFERENCES team_positions (id) ON DELETE CASCADE,
  capability_id UUID NOT NULL REFERENCES capabilities (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_position_id, capability_id)
);
REVOKE ALL ON TABLE team_position_capabilities FROM PUBLIC, anon, authenticated;

-- A user's organizational assignment to a Team + Position combination.
-- `user_id` references the Supabase Auth user UUID directly
-- (auth.users.id) - there is no separate application users/profile
-- table; Supabase Auth is the sole identity source.
--
-- A user may hold more than one Team + Position assignment at once (e.g.
-- different positions on different teams). Effective capabilities are
-- the union of all of a user's assignments' team_position capabilities.
CREATE TABLE user_team_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  team_position_id UUID NOT NULL REFERENCES team_positions (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_team_positions_unique UNIQUE (user_id, team_position_id)
);
REVOKE ALL ON TABLE user_team_positions FROM PUBLIC, anon, authenticated;

CREATE INDEX user_team_positions_user_id_idx ON user_team_positions (user_id);
