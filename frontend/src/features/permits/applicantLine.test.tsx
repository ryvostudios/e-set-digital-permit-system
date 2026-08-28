import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describePermitApplicant } from '../../auth/capabilities';
import { normalEmployee, permitSummary } from '../../test/factories';
import { renderAs } from '../../test/harness';
import { PermitList } from './PermitList';

/**
 * THE APPLICANT LINE IS A PERSON, NOT A PERSON AND THEIR EMPLOYER.
 *
 * It used to read "Mr. gulraiz of Company E-SET" everywhere a permit
 * appeared - every register row, every card, every read-only document -
 * putting the employer inside the middle of every name. The company is
 * its own field with its own place on the forms that print one;
 * appending it to the name was a duplicate rendering, not a second
 * record.
 *
 * `describePermitApplicant` is the ONE formatter behind every list and
 * document surface, so these check it directly and through the shared
 * component every screen renders, rather than screen by screen.
 *
 * Nothing about the company DATA changes: it is still on the permit, in
 * the API, in the stored payloads, in the issued snapshot and on the PDF.
 */

describe('the applicant line', () => {
  it('reads "Mr. NAME" and never appends the company', () => {
    expect(
      describePermitApplicant({
        applicant_identity_kind: 'NORMAL',
        applicant_display_name: 'gulraiz',
        applicant_company_name: 'E-SET',
      }),
    ).toBe('Mr. gulraiz');
  });

  it('is identical whether or not the permit carries a company', () => {
    const withCompany = describePermitApplicant({
      applicant_identity_kind: 'NORMAL',
      applicant_display_name: 'gulraiz',
      applicant_company_name: 'E-SET',
    });
    const withoutCompany = describePermitApplicant({
      applicant_identity_kind: 'NORMAL',
      applicant_display_name: 'gulraiz',
      applicant_company_name: null,
    });
    expect(withCompany).toBe(withoutCompany);
    expect(withCompany).toBe('Mr. gulraiz');
  });

  it('keeps the honorific', () => {
    expect(
      describePermitApplicant({ applicant_identity_kind: 'NORMAL', applicant_display_name: 'gulraiz' }),
    ).toMatch(/^Mr\. /);
  });

  it('still gives a privileged applicant the personal name ALONE - no honorific, no company', () => {
    expect(
      describePermitApplicant({
        applicant_identity_kind: 'PRIVILEGED',
        applicant_display_name: 'Farhan Aziz',
        applicant_company_name: 'E-SET',
      }),
    ).toBe('Farhan Aziz');
  });

  it('says nothing at all when the server has recorded no applicant yet', () => {
    expect(describePermitApplicant({ applicant_display_name: null })).toBeNull();
  });

  it('never invents a name from a company', () => {
    expect(
      describePermitApplicant({ applicant_display_name: null, applicant_company_name: 'E-SET' }),
    ).toBeNull();
  });
});

describe('the shared permit list every screen renders', () => {
  /**
   * `PermitList` is the one component behind the dashboard's Recent
   * Permit Activity, the records register, My Drafts and the CRO/HSE
   * review queue - so proving it here proves all of them at once.
   */
  function renderList() {
    return renderAs(
      <PermitList
        permits={[
          permitSummary({
            id: 'p-1',
            status: 'ISSUED',
            applicant_identity_kind: 'NORMAL',
            applicant_display_name: 'gulraiz',
            applicant_company_code: 'E_SET',
            applicant_company_name: 'E-SET',
          }),
        ]}
        emptyMessage="No permits."
      />,
      normalEmployee(),
    );
  }

  it('shows the applicant as "Mr. NAME"', () => {
    renderList();
    // The table row and the small-screen card both render it.
    expect(screen.getAllByText('Mr. gulraiz').length).toBeGreaterThan(0);
  });

  it('does not append the company to the applicant', () => {
    renderList();
    expect(screen.queryByText(/of Company/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Mr\. gulraiz of/i)).not.toBeInTheDocument();
  });

  it('leaves the permit’s company data intact for anywhere that wants it', () => {
    // Still on the record - simply not part of the name.
    const permit = permitSummary({
      applicant_display_name: 'gulraiz',
      applicant_company_name: 'E-SET',
      applicant_company_code: 'E_SET',
    });
    expect(permit.applicant_company_name).toBe('E-SET');
    expect(permit.applicant_company_code).toBe('E_SET');
    expect(describePermitApplicant(permit)).toBe('Mr. gulraiz');
  });
});
