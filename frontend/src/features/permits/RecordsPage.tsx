import { useState, type FormEvent } from 'react';
import { searchPermits, type PermitSearchParams } from '../../api/endpoints';
import { PERMIT_STATUSES, PERMIT_TYPES, type PermitListResponse } from '../../api/types';
import { useCurrentUser } from '../../auth/useAuth';
import { useApiResource } from '../../lib/useApiResource';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { ErrorState, SkeletonRows } from '../../ui/Feedback';
import { FilterPanel, PageHeader, Pagination, permitStatusLabel } from '../../ui/Layout';
import { PERMIT_TYPE_LABELS, SEARCH_COMPANY_OPTIONS } from './labels';
import { PermitList } from './PermitList';

/**
 * Permit records.
 *
 * SEARCH NEVER WIDENS ACCESS. `GET /permits/search` is scoped by exactly
 * the same access model as every other permit read: a person searches
 * only within permits they already own or already hold a
 * capability-granted view into. Filtering, paging, and counting all
 * happen server-side inside that scope, so a result set here can never
 * reveal a permit that could not be opened directly.
 *
 * WHAT THE LIST CONTAINS IS THE SERVER'S ANSWER, re-asked on every load.
 * If "View all permits" is revoked while this screen is open, the next
 * load simply returns the narrower set - there is no cached wider list to
 * fall back on.
 */

const PAGE_SIZE = 20;
const RECORD_STATUSES = PERMIT_STATUSES.filter((status) => status !== 'DRAFT');

interface Filters {
  permitNumber: string;
  status: string;
  permitType: string;
  company: string;
  createdFrom: string;
  createdTo: string;
}

const EMPTY_FILTERS: Filters = {
  permitNumber: '',
  status: '',
  permitType: '',
  company: '',
  createdFrom: '',
  createdTo: '',
};

function toSearchParams(filters: Filters, page: number): PermitSearchParams {
  const permitNumber = Number(filters.permitNumber.trim());
  return {
    page,
    pageSize: PAGE_SIZE,
    ...(Number.isFinite(permitNumber) && permitNumber > 0 ? { permitNumber } : {}),
    ...(filters.status ? { status: filters.status as PermitSearchParams['status'] } : {}),
    ...(filters.permitType ? { permitType: filters.permitType as PermitSearchParams['permitType'] } : {}),
    ...(filters.company ? { company: filters.company as PermitSearchParams['company'] } : {}),
    ...(filters.createdFrom ? { createdFrom: new Date(filters.createdFrom).toISOString() } : {}),
    ...(filters.createdTo ? { createdTo: new Date(filters.createdTo).toISOString() } : {}),
  };
}

export function RecordsPage() {
  const { capabilities } = useCurrentUser();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const resource = useApiResource<PermitListResponse>(
    (signal) => searchPermits(toSearchParams(applied, page), signal),
    [applied, page],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPage(1);
    setApplied(draft);
  }

  function handleReset(): void {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  }

  // Defense in depth for stale/corrupt intermediaries. The backend is
  // authoritative and excludes drafts before COUNT/pagination; this
  // guard ensures this screen still never presents one as a record.
  const recordPermits = (resource.data?.permits ?? []).filter((permit) => permit.status !== 'DRAFT');

  return (
    <>
      <PageHeader
        eyebrow="Work"
        title={capabilities.canViewAllPermits ? 'Permit records' : 'My permits'}
        description={
          capabilities.canViewAllPermits
            ? 'Every permit you are authorized to see.'
            : 'The permits you have raised, and any you are authorized to review.'
        }
      />

      <div className="stack">
        <FilterPanel title="Filter">
          <form onSubmit={handleSubmit} className="stack">
            <div className="grid-2">
              <Input
                label="Permit number"
                inputMode="numeric"
                value={draft.permitNumber}
                onChange={(event) => setDraft({ ...draft, permitNumber: event.target.value })}
              />
              <Select
                label="Status"
                value={draft.status}
                onChange={(event) => setDraft({ ...draft, status: event.target.value })}
              >
                <option value="">Any status</option>
                {RECORD_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {permitStatusLabel(status)}
                  </option>
                ))}
              </Select>
              <Select
                label="Permit type"
                value={draft.permitType}
                onChange={(event) => setDraft({ ...draft, permitType: event.target.value })}
              >
                <option value="">Any type</option>
                {PERMIT_TYPES.map((permitType) => (
                  <option key={permitType} value={permitType}>
                    {PERMIT_TYPE_LABELS[permitType]}
                  </option>
                ))}
              </Select>
              <Select
                label="Company"
                value={draft.company}
                onChange={(event) => setDraft({ ...draft, company: event.target.value })}
              >
                <option value="">Any company</option>
                {SEARCH_COMPANY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Input
                label="Raised from"
                type="date"
                value={draft.createdFrom}
                onChange={(event) => setDraft({ ...draft, createdFrom: event.target.value })}
              />
              <Input
                label="Raised to"
                type="date"
                value={draft.createdTo}
                onChange={(event) => setDraft({ ...draft, createdTo: event.target.value })}
              />
            </div>
            <div className="row">
              <Button type="submit" variant="primary" loading={resource.loading}>
                Apply filters
              </Button>
              <Button type="button" variant="ghost" onClick={handleReset}>
                Reset
              </Button>
            </div>
          </form>
        </FilterPanel>

        <div className="card">
          {resource.initialLoading ? (
            <SkeletonRows rows={5} />
          ) : resource.error ? (
            <ErrorState error={resource.error} onRetry={resource.reload} />
          ) : (
            <>
              <PermitList
                permits={recordPermits}
                emptyMessage="No permits match these filters."
              />
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
