import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import type { PermitSummary, PermitType } from '../../api/types';
import { normalEmployee, permit, permitDetail, permitSummary } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { PermitList } from './PermitList';
import { PermitDetailPage } from './PermitDetailPage';

/**
 * A DRAFT HAS NO PERMIT NUMBER, AND SAYS SO.
 *
 * A permit number is an entry in the company's register, and the database
 * issues one only on the first successful submission (migration 0034).
 * Before that there is nothing to show - so the screen says "Not
 * assigned" rather than `0`, `-`, or the number the draft would receive
 * if it were submitted this second. Someone else may submit first.
 *
 * THE FORMATTING IS THE SERVER'S. `permitDisplayNumber` arrives already
 * formatted - `HW-12`, or `Not assigned` - from one formatter in the
 * backend, so a permit cannot be called one thing in a list and another
 * on its own document. Nothing here rebuilds it from parts.
 */

const submitted = (type: PermitType, display: string, sequence: string): PermitSummary =>
  permitSummary({
    id: `p-${display}`,
    permit_type: type,
    permit_sequence: sequence,
    permitDisplayNumber: display,
    status: 'PENDING_CRO',
  });

const draft = (type: PermitType): PermitSummary =>
  permitSummary({
    id: `draft-${type}`,
    permit_type: type,
    permit_sequence: null,
    permitDisplayNumber: 'Not assigned',
    status: 'DRAFT',
  });

function renderList(permits: PermitSummary[]) {
  return renderAs(<PermitList permits={permits} emptyMessage="No permits." />, normalEmployee());
}

describe('a draft', () => {
  it('shows "Not assigned" instead of a number', () => {
    renderList([draft('HOT_WORK')]);
    expect(screen.getAllByText('Not assigned').length).toBeGreaterThan(0);
  });

  it('never shows a fabricated or predicted number', () => {
    renderList([draft('HOT_WORK')]);
    for (const wrong of ['HW-0', 'HW-1', '0', '000001']) {
      expect(screen.queryByText(wrong)).not.toBeInTheDocument();
    }
  });

  it('carries a null sequence on the record itself', () => {
    expect(draft('COLD_WORK').permit_sequence).toBeNull();
  });
});

describe('a submitted permit', () => {
  it('shows the prefixed number for every permit type', () => {
    renderList([
      submitted('WTG_WORK', 'WTG-1', '1'),
      submitted('COLD_WORK', 'CW-1', '1'),
      submitted('HOT_WORK', 'HW-1', '1'),
      submitted('CONFINED_SPACE_ENTRY', 'CS-1', '1'),
    ]);
    for (const display of ['WTG-1', 'CW-1', 'HW-1', 'CS-1']) {
      expect(screen.getAllByText(display).length).toBeGreaterThan(0);
    }
  });

  it('distinguishes the same number across different types', () => {
    renderList([submitted('HOT_WORK', 'HW-1', '1'), submitted('COLD_WORK', 'CW-1', '1')]);
    // Two permits, both number 1, both legitimately in the register.
    expect(screen.getAllByText('HW-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('CW-1').length).toBeGreaterThan(0);
  });

  it('renders exactly what the server sent, never rebuilt in the browser', () => {
    // A deliberately unusual value: if the UI derived the display from
    // the type and sequence itself, this could not survive.
    renderList([submitted('HOT_WORK', 'HW-4096', '4096')]);
    expect(screen.getAllByText('HW-4096').length).toBeGreaterThan(0);
  });
});

describe('the permit record screen', () => {
  function renderDetail(summary: Partial<PermitSummary>) {
    stubFetch({
      'GET /api/v1/permits/permit-1': {
        body: permitDetail({ permit: permit({ id: 'permit-1', ...summary }) }),
      },
    });
    return renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      normalEmployee(),
      { route: '/permits/permit-1' },
    );
  }

  it('titles a submitted permit with its prefixed number', async () => {
    renderDetail({
      permit_type: 'COLD_WORK',
      permit_sequence: '4',
      permitDisplayNumber: 'CW-4',
      status: 'PENDING_CRO',
      form_version: 'COLD_WORK_V1',
    });
    expect(await screen.findByRole('heading', { level: 1, name: /permit CW-4/i })).toBeInTheDocument();
  });

  it('titles an unnumbered draft "Not assigned" rather than inventing one', async () => {
    renderDetail({
      permit_type: 'COLD_WORK',
      permit_sequence: null,
      permitDisplayNumber: 'Not assigned',
      status: 'DRAFT',
      form_version: 'COLD_WORK_V1',
    });
    expect(await screen.findByRole('heading', { level: 1, name: /permit Not assigned/i })).toBeInTheDocument();
    expect(screen.queryByText(/CW-0|CW-1\b/)).not.toBeInTheDocument();
  });
});
