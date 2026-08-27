import { Link } from 'react-router-dom';
import type { PermitSummary } from '../../api/types';
import { ROUTES } from '../../app/routes';
import { describePermitApplicant } from '../../auth/capabilities';
import { formatDate } from '../../lib/format';
import { StatusBadge } from '../../ui/Layout';
import { permitTypeLabel } from './labels';

/**
 * One presentation of a permit list, in two layouts.
 *
 * The table is the desktop reading; on a narrow screen the SAME data is
 * rendered as stacked records with their own labels, rather than a table
 * squeezed sideways or scrolled off the edge. Both are always in the DOM
 * and CSS chooses - so the mobile layout is real content, not a
 * degradation.
 *
 * Only fields the API genuinely returns appear here. Nothing is
 * fabricated to fill a column.
 */

function workSummary(permit: PermitSummary): string {
  // `wind_farm`/`wtg_number`/`work_description` are server-derived
  // projections of the stored payload, present only for WTG work.
  const parts = [permit.wind_farm, permit.wtg_number].filter(Boolean);
  if (parts.length > 0) return parts.join(' · ');
  if (permit.work_description) return permit.work_description;
  if (permit.loto_number) return `LOTO ${permit.loto_number}`;
  return '—';
}

export function PermitList({ permits, emptyMessage }: { permits: PermitSummary[]; emptyMessage: string }) {
  if (permits.length === 0) {
    return (
      <div className="state">
        <p className="state__body">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <>
      <div className="table-wrap desktop-only">
        <table className="table">
          <caption className="sr-only">Permits</caption>
          <thead>
            <tr>
              <th scope="col">Permit No.</th>
              <th scope="col">Type</th>
              <th scope="col">Applicant</th>
              <th scope="col">Work</th>
              <th scope="col">Status</th>
              <th scope="col">Raised</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {permits.map((permit) => (
              <tr key={permit.id}>
                <th scope="row" className="table__num">
                  {permit.permitDisplayNumber}
                </th>
                <td>{permitTypeLabel(permit.permit_type)}</td>
                <td>{describePermitApplicant(permit) ?? '—'}</td>
                <td>{workSummary(permit)}</td>
                <td>
                  <StatusBadge status={permit.status} />
                </td>
                <td>{formatDate(permit.created_at)}</td>
                <td>
                  <Link to={ROUTES.permit(permit.id)}>
                    Open<span className="sr-only"> permit {permit.permitDisplayNumber}</span>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="record-list mobile-only">
        {permits.map((permit) => (
          <li key={permit.id} className="record-list__item">
            <div className="record-list__head">
              <Link to={ROUTES.permit(permit.id)} className="table__num">
                {permit.permitDisplayNumber}
              </Link>
              <StatusBadge status={permit.status} />
            </div>
            <dl className="record-list__meta">
              <dt className="record-list__key">Type</dt>
              <dd>{permitTypeLabel(permit.permit_type)}</dd>
              <dt className="record-list__key">Applicant</dt>
              <dd>{describePermitApplicant(permit) ?? '—'}</dd>
              <dt className="record-list__key">Work</dt>
              <dd>{workSummary(permit)}</dd>
              <dt className="record-list__key">Raised</dt>
              <dd>{formatDate(permit.created_at)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
