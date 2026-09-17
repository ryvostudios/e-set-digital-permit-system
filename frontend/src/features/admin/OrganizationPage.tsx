import { useState, type FormEvent, type ReactNode } from 'react';
import {
  createCompany,
  createTeam,
  createTeamPosition,
  deactivateOrganizationRecord,
  getOrganizationStructure,
} from '../../api/endpoints';
import { asApiError, fieldErrors, type ApiError } from '../../api/errors';
import type {
  OrganizationAdminCompany,
  OrganizationAdminPosition,
  OrganizationAdminTeam,
  OrganizationLevel,
} from '../../api/types';
import { useCurrentUser } from '../../auth/useAuth';
import { useApiResource } from '../../lib/useApiResource';
import { Button } from '../../ui/Button';
import { ConfirmDialog, Modal } from '../../ui/Dialog';
import { FormError, Input } from '../../ui/Field';
import { Alert, EmptyState, ErrorState, SkeletonRows } from '../../ui/Feedback';
import { Badge, Card, PageHeader } from '../../ui/Layout';
import { useToast } from '../../ui/Toast';

/**
 * Organization Management - Company -> Team -> Team + Position.
 *
 * WHAT THIS SCREEN MAY AND MAY NOT DO. It creates structure and retires
 * it. There is no delete, no rename, no reactivation and no capability
 * editor, because the backend exposes no endpoint for any of them -
 * inventing a control for an operation the server cannot perform would
 * be a lie told in UI.
 *
 * AUTHORITY IS NEVER INFERRED HERE. Access is decided by
 * `canManageOrganization`, which reads the privileged roles `/auth/me`
 * returned - the same CEO / E-SET SITE_MANAGER tier the backend's own
 * gate resolves from the append-only grant log. A Position NAMED 'CEO',
 * 'Site Manager', 'CRO' or 'HSE' is an ordinary job title and reaches
 * nothing. Hiding controls is a courtesy; the server refuses
 * independently and a 401/403 is always obeyed.
 *
 * CAPABILITIES ARE NOT A CLIENT CONCERN. Creating an association sends a
 * position NAME and nothing else. The server attaches exactly the
 * applicant baseline (`permit.create` + `permit.submit`) through its own
 * bounded path; this screen has no capability picker, cannot send one,
 * and cannot set `siteManagerAssignable` - which it only ever displays.
 *
 * RETIRED RECORDS STAY IN HISTORY, NOT IN THIS CURRENT-STATE TREE. The
 * backend omits them from the normal management endpoint while retaining
 * their database rows, stable ids and append-only audit events.
 */

/** Backend refusal reasons, in the words a person can act on. */
const REFUSAL_MESSAGES: Record<string, string> = {
  active_employees:
    'Active employees are still assigned here. Reassign or disable them first, then retire this record.',
  capability_coverage:
    'This change would leave required permit review coverage unstaffed. Another team or position must cover it first.',
  already_inactive: 'This record has already been retired.',
  duplicate_name: 'That name is already in use here.',
  duplicate_association: 'That position is already associated with this team.',
  company_inactive: 'This company is retired and cannot take new teams.',
  team_inactive: 'This team is retired and cannot take new positions.',
  code_generation_exhausted:
    'A unique company code could not be generated for that name. Try a slightly different name.',
};

/**
 * Turns any failure into something safe to show.
 *
 * A recognised backend `reason` becomes a written sentence. Anything else
 * falls back to the API layer's own sanitized message - which never
 * carries SQL, a constraint name, a stack trace or a database code.
 */
function refusalMessage(error: ApiError): string {
  if (error.reason && REFUSAL_MESSAGES[error.reason]) return REFUSAL_MESSAGES[error.reason]!;
  return error.message;
}

function StatusBadge({ deactivatedAt }: { deactivatedAt: string | null }) {
  // Text, not colour alone - the badge reads the same to someone who
  // cannot distinguish the tones.
  return deactivatedAt === null ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>;
}

function Chevron() {
  return (
    <svg
      className="org-toggle__chevron"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface PendingDeactivation {
  level: OrganizationLevel;
  id: string;
  name: string;
}

/** What the confirmation says, per level. Every one states that history is kept. */
const DEACTIVATION_COPY: Record<OrganizationLevel, { title: string; subject: string }> = {
  company: { title: 'Retire this company?', subject: 'company' },
  team: { title: 'Retire this team?', subject: 'team' },
  team_position: { title: 'Retire this position?', subject: 'position' },
};

export function OrganizationPage() {
  const { capabilities } = useCurrentUser();
  const toast = useToast();
  const authorized = capabilities.canManageOrganization;

  const resource = useApiResource<{ companies: OrganizationAdminCompany[] }>(
    (signal) => getOrganizationStructure(signal),
    [],
    { enabled: authorized },
  );

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [name, setName] = useState('');

  const [companyOpen, setCompanyOpen] = useState(false);
  const [teamFor, setTeamFor] = useState<OrganizationAdminCompany | null>(null);
  const [positionFor, setPositionFor] = useState<{
    company: OrganizationAdminCompany;
    team: OrganizationAdminTeam;
  } | null>(null);
  const [pending, setPending] = useState<PendingDeactivation | null>(null);

  if (!authorized) {
    return (
      <>
        <PageHeader eyebrow="Administration" title="Organization Management" />
        <Alert tone="warning" title="Not available to you">
          Organization management is reserved to the CEO and System Site Managers.
        </Alert>
      </>
    );
  }

  const companies = (resource.data?.companies ?? [])
    .filter((company) => company.deactivatedAt === null)
    .map((company) => ({
      ...company,
      teams: company.teams
        .filter((team) => team.deactivatedAt === null)
        .map((team) => ({
          ...team,
          positions: team.positions.filter((position) => position.deactivatedAt === null),
        })),
    }));

  function closeDialogs(): void {
    setCompanyOpen(false);
    setTeamFor(null);
    setPositionFor(null);
    setName('');
    setError(null);
    setIssues({});
  }

  function failed(caught: unknown): void {
    const apiError = asApiError(caught);
    setError({ message: refusalMessage(apiError), requestId: apiError.requestId });
    setIssues(fieldErrors(apiError));
  }

  /**
   * One submit path for all three creations.
   *
   * `busy` is checked FIRST and set before any await, so a double tap or
   * a repeated Enter cannot start a second request - the dialog's button
   * is also disabled, but the guard is what actually prevents it.
   */
  async function submit(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      await action();
      closeDialogs();
      resource.reload();
    } catch (caught) {
      failed(caught);
    } finally {
      setBusy(false);
    }
  }

  function handleCreateCompany(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit(async () => {
      // Only a name leaves the browser. The server generates the code.
      const { company } = await createCompany(name.trim());
      setExpanded((state) => ({ ...state, [company.id]: true }));
      toast.show(`Company "${company.name}" created as ${company.code}.`);
    });
  }

  function handleCreateTeam(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const company = teamFor;
    if (!company) return;
    void submit(async () => {
      const { team } = await createTeam(company.id, name.trim());
      setExpanded((state) => ({ ...state, [company.id]: true, [team.id]: true }));
      toast.show(`Team "${team.name}" added to ${company.name}.`);
    });
  }

  function handleCreatePosition(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const target = positionFor;
    if (!target) return;
    void submit(async () => {
      const { association } = await createTeamPosition(target.company.id, target.team.id, name.trim());
      setExpanded((state) => ({ ...state, [target.company.id]: true, [target.team.id]: true }));
      toast.show(`Position "${association.positionName}" added to ${target.team.name}.`);
    });
  }

  async function handleDeactivate(): Promise<void> {
    const target = pending;
    // The id is captured from the record the person opened the dialog on,
    // and the dialog is the only way to reach this - so a stale selection
    // cannot redirect the action at a different record.
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deactivateOrganizationRecord(target.level, target.id);
      toast.show(`${target.name} retired.`);
      setPending(null);
      resource.reload();
    } catch (caught) {
      failed(caught);
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string): void {
    setExpanded((state) => ({ ...state, [id]: !state[id] }));
  }

  function renderPosition(
    company: OrganizationAdminCompany,
    team: OrganizationAdminTeam,
    position: OrganizationAdminPosition,
  ): ReactNode {
    const inactive = position.deactivatedAt !== null;
    return (
      <li
        key={position.teamPositionId}
        className={inactive ? 'org-position org-position--inactive' : 'org-position'}
      >
        <span className="org-position__name">
          <span>{position.positionName}</span>
          <StatusBadge deactivatedAt={position.deactivatedAt} />
          {position.siteManagerAssignable && !inactive ? (
            <span className="muted text-sm">Assignable</span>
          ) : null}
        </span>
        {!inactive ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setPending({
                level: 'team_position',
                id: position.teamPositionId,
                name: `${position.positionName} (${team.name}, ${company.name})`,
              })
            }
          >
            Retire
          </Button>
        ) : null}
      </li>
    );
  }

  function renderTeam(company: OrganizationAdminCompany, team: OrganizationAdminTeam): ReactNode {
    const inactive = team.deactivatedAt !== null;
    const companyInactive = company.deactivatedAt !== null;
    const open = expanded[team.id] ?? true;

    return (
      <div key={team.id} className={inactive ? 'org-team org-team--inactive' : 'org-team'}>
        <div className="org-team__head">
          <button
            type="button"
            className="org-toggle"
            aria-expanded={open}
            onClick={() => toggle(team.id)}
          >
            <Chevron />
            <span className="org-title">
              <span className="org-title__name">{team.name}</span>
              <span className="org-title__meta">
                <StatusBadge deactivatedAt={team.deactivatedAt} />
                <span>
                  {team.positions.length} {team.positions.length === 1 ? 'position' : 'positions'}
                </span>
              </span>
            </span>
          </button>
          {!inactive && !companyInactive ? (
            <div className="org-head__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  closeDialogs();
                  setPositionFor({ company, team });
                }}
              >
                Add position
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPending({ level: 'team', id: team.id, name: `Team ${team.name}` })}
              >
                Retire
              </Button>
            </div>
          ) : null}
        </div>

        {open ? (
          <div className="org-branch">
            {team.positions.length === 0 ? (
              <p className="org-empty">No positions yet.</p>
            ) : (
              <ul className="org-positions">
                {team.positions.map((position) => renderPosition(company, team, position))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderCompany(company: OrganizationAdminCompany): ReactNode {
    const inactive = company.deactivatedAt !== null;
    const open = expanded[company.id] ?? true;

    return (
      <section
        key={company.id}
        className={inactive ? 'org-company org-company--inactive' : 'org-company'}
      >
        <div className="org-head">
          <div className="org-head__main">
            <button
              type="button"
              className="org-toggle"
              aria-expanded={open}
              onClick={() => toggle(company.id)}
            >
              <Chevron />
              <span className="org-title">
                <span className="org-title__name">{company.name}</span>
                <span className="org-title__meta">
                  <span className="org-code">{company.code}</span>
                  <StatusBadge deactivatedAt={company.deactivatedAt} />
                  <span>
                    {company.teams.length} {company.teams.length === 1 ? 'team' : 'teams'}
                  </span>
                </span>
              </span>
            </button>
          </div>
          {!inactive ? (
            <div className="org-head__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  closeDialogs();
                  setTeamFor(company);
                }}
              >
                Add team
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPending({ level: 'company', id: company.id, name: company.name })}
              >
                Retire
              </Button>
            </div>
          ) : null}
        </div>

        {open ? (
          <div className="org-body">
            {company.teams.length === 0 ? (
              <p className="org-empty">
                No teams yet. A company can exist without teams until you add one.
              </p>
            ) : (
              <div className="org-branch">{company.teams.map((team) => renderTeam(company, team))}</div>
            )}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Organization Management"
        description="Companies, their teams, and the positions employees can be assigned to. Retiring a record keeps its history."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              closeDialogs();
              setCompanyOpen(true);
            }}
          >
            Add company
          </Button>
        }
      />

      <div className="stack">
        {resource.initialLoading ? (
          <Card>
            <SkeletonRows rows={5} />
          </Card>
        ) : resource.error ? (
          // A 401 has already ended the session globally; anything else
          // is shown without rendering stale organization data.
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : companies.length === 0 ? (
          <Card>
            <EmptyState title="No companies yet">
              Add the first company to start building the organization.
            </EmptyState>
          </Card>
        ) : (
          <div data-testid="organization-tree">{companies.map((company) => renderCompany(company))}</div>
        )}
      </div>

      <Modal
        open={companyOpen}
        onClose={closeDialogs}
        title="Add company"
        description="The company code is generated automatically and cannot be changed afterwards."
        busy={busy}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialogs} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="create-company-form" loading={busy}>
              Create company
            </Button>
          </>
        }
      >
        <form id="create-company-form" className="stack" onSubmit={handleCreateCompany}>
          <Input
            label="Company name"
            required
            value={name}
            error={issues.name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        </form>
      </Modal>

      <Modal
        open={teamFor !== null}
        onClose={closeDialogs}
        title="Add team"
        description={teamFor ? `A new team inside ${teamFor.name}.` : undefined}
        busy={busy}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialogs} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="create-team-form" loading={busy}>
              Create team
            </Button>
          </>
        }
      >
        <form id="create-team-form" className="stack" onSubmit={handleCreateTeam}>
          <Input
            label="Team name"
            required
            value={name}
            error={issues.name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        </form>
      </Modal>

      <Modal
        open={positionFor !== null}
        onClose={closeDialogs}
        title="Add position"
        description={
          positionFor
            ? `A position on ${positionFor.team.name}. Existing position names are reused across teams.`
            : undefined
        }
        busy={busy}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialogs} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="create-position-form" loading={busy}>
              Add position
            </Button>
          </>
        }
      >
        <form id="create-position-form" className="stack" onSubmit={handleCreatePosition}>
          <Input
            label="Position name"
            required
            value={name}
            error={issues.positionName}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          <p className="muted text-sm">
            A position is a job title. Permit approval authority is assigned separately and is not
            affected by the name you choose.
          </p>
          {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        </form>
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? DEACTIVATION_COPY[pending.level].title : ''}
        description={
          pending ? (
            <>
              <strong>{pending.name}</strong> will be retired and leave the current organization tree.
              Its history stays recorded, and employees, permits and audit records are not deleted.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Retire"
        confirmVariant="danger"
        busy={busy}
        onConfirm={() => void handleDeactivate()}
        onCancel={() => {
          setPending(null);
          setError(null);
        }}
      >
        <p className="muted text-sm">
          The server checks first, and will refuse if anything still depends on this
          {' '}
          {pending ? DEACTIVATION_COPY[pending.level].subject : 'record'}.
        </p>
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
      </ConfirmDialog>
    </>
  );
}
