import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { listEmployees } from '../../api/endpoints';
import type { EmployeeListResponse } from '../../api/types';
import { ROUTES } from '../../app/routes';
import { useCurrentUser } from '../../auth/useAuth';
import { useApiResource } from '../../lib/useApiResource';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { Alert, ErrorState, SkeletonRows } from '../../ui/Feedback';
import { Badge, FilterPanel, PageHeader, Pagination } from '../../ui/Layout';
import { useOrganization } from './useOrganization';

/**
 * The employee directory, for CEO and System Site Managers.
 *
 * PRIVILEGED ACCOUNTS ARE NOT LISTED HERE. The backend excludes every
 * account holding an active privileged grant, so a CEO or Site Manager
 * never appears as an ordinary employee and this screen cannot be used
 * to discover the privileged tier. Site Manager administration is a
 * separate, CEO-only screen.
 *
 * NO EMAIL ADDRESS IS SHOWN, because the API does not return one: the
 * login address is intentionally omitted from the directory response.
 * Changing it is a deliberate, separate action on the
 * employee's own page.
 */

const PAGE_SIZE = 25;

function StateBadge({ state }: { state: 'ACTIVE' | 'DISABLED' | 'DELETED' }) {
  if (state === 'ACTIVE') return <Badge tone="success">Active</Badge>;
  if (state === 'DISABLED') return <Badge tone="warning">Disabled</Badge>;
  return <Badge tone="danger">Deleted</Badge>;
}

export function EmployeeListPage() {
  const { capabilities } = useCurrentUser();
  const organization = useOrganization();
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [companyCode, setCompanyCode] = useState('');
  const [page, setPage] = useState(1);

  const resource = useApiResource<EmployeeListResponse>(
    (signal) =>
      listEmployees(
        {
          page,
          pageSize: PAGE_SIZE,
          ...(search ? { search } : {}),
          ...(state ? { state } : {}),
          ...(companyCode ? { companyCode } : {}),
        },
        signal,
      ),
    [page, search, state, companyCode],
  );

  // Defensive: a response missing this key must render an empty list,
  // never crash the screen.
  const employees = (resource.data?.employees ?? []).filter((employee) => employee.state !== 'DELETED');

  function handleSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPage(1);
    setSearch(searchDraft.trim());
  }

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Employees"
        description="Normal employee accounts across the organization."
        actions={
          <Link className="btn btn--primary" to={ROUTES.employeeNew}>
            Add employee
          </Link>
        }
      />

      <div className="stack">
        {!capabilities.canManageEmployees ? (
          <Alert tone="warning" title="Not available to you">
            Employee administration is reserved to the CEO and System Site Managers.
          </Alert>
        ) : null}

        <FilterPanel title="Find an employee">
          <form onSubmit={handleSearch} className="stack">
            <div className="grid-2">
              <Input
                label="Name"
                value={searchDraft}
                placeholder="Search by name"
                onChange={(event) => setSearchDraft(event.target.value)}
              />
              <Select
                label="Company"
                value={companyCode}
                onChange={(event) => {
                  setCompanyCode(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">Any company</option>
                {organization.companies.map((company) => (
                  <option key={company.code} value={company.code}>
                    {company.name}
                  </option>
                ))}
              </Select>
              <Select
                label="Account status"
                value={state}
                onChange={(event) => {
                  setState(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">Any status</option>
                <option value="ACTIVE">Active</option>
                <option value="DISABLED">Disabled</option>
              </Select>
            </div>
            <div className="row">
              <Button type="submit" variant="primary" loading={resource.loading}>
                Search
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSearchDraft('');
                  setSearch('');
                  setState('');
                  setCompanyCode('');
                  setPage(1);
                }}
              >
                Reset
              </Button>
            </div>
          </form>
        </FilterPanel>

        <div className="card">
          {resource.initialLoading ? (
            <SkeletonRows rows={6} />
          ) : resource.error ? (
            <ErrorState error={resource.error} onRetry={resource.reload} />
          ) : employees.length === 0 ? (
            <div className="state">
              <p className="state__body">No employees match this search.</p>
            </div>
          ) : (
            <>
              <div className="table-wrap desktop-only">
                <table className="table">
                  <caption className="sr-only">Employees</caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Company</th>
                      <th scope="col">Team</th>
                      <th scope="col">Position</th>
                      <th scope="col">Account</th>
                      <th scope="col">View all permits</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((employee) => (
                      <tr key={employee.userId}>
                        <th scope="row">{employee.displayName}</th>
                        <td>{employee.company.name}</td>
                        <td>{employee.teamName}</td>
                        <td>{employee.positionName}</td>
                        <td>
                          <StateBadge state={employee.state} />
                        </td>
                        <td>{employee.viewAllPermits ? <Badge tone="success">Granted</Badge> : <Badge>Not granted</Badge>}</td>
                        <td>
                          <Link className="btn btn--primary btn--sm" to={ROUTES.employee(employee.userId)}>
                            Manage<span className="sr-only"> {employee.displayName}</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="record-list mobile-only">
                {employees.map((employee) => (
                  <li key={employee.userId} className="record-list__item">
                    <div className="record-list__head">
                      <Link to={ROUTES.employee(employee.userId)} style={{ fontWeight: 600 }}>
                        {employee.displayName}
                      </Link>
                      <StateBadge state={employee.state} />
                    </div>
                    <dl className="record-list__meta">
                      <dt className="record-list__key">Company</dt>
                      <dd>{employee.company.name}</dd>
                      <dt className="record-list__key">Team</dt>
                      <dd>{employee.teamName}</dd>
                      <dt className="record-list__key">Position</dt>
                      <dd>{employee.positionName}</dd>
                      <dt className="record-list__key">View all permits</dt>
                      <dd>{employee.viewAllPermits ? 'Granted' : 'Not granted'}</dd>
                    </dl>
                  </li>
                ))}
              </ul>

              {resource.data ? (
                <Pagination
                  page={resource.data.pagination.page}
                  pageSize={resource.data.pagination.pageSize}
                  totalCount={resource.data.pagination.totalCount}
                  totalPages={resource.data.pagination.totalPages}
                  busy={resource.loading}
                  onPageChange={setPage}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}
