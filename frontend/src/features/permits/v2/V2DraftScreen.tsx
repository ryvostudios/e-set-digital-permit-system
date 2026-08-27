import { useNavigate } from 'react-router-dom';
import { getFormCatalogue, type FormCatalogue, type PermitTypeKey } from '../../../api/catalogue';
import { saveV2JsaDraft, saveV2PermitDraft, submitPermit } from '../../../api/endpoints';
import type { ApplicantIdentity } from '../../../auth/applicantIdentity';
import type { Jsa, Permit } from '../../../api/types';
import { ROUTES } from '../../../app/routes';
import { useApiResource } from '../../../lib/useApiResource';
import { ErrorState, LoadingState } from '../../../ui/Feedback';
import { PageHeader, StatusBadge } from '../../../ui/Layout';
import { useToast } from '../../../ui/Toast';
import { permitTypeLabel } from '../labels';
import { PermitDraftEditor } from './PermitDraftEditor';
import { emptyJsaValues, emptyPermitValues, type JsaValuesV2, type PermitValuesV2 } from './values';

/**
 * The applicant's screen for an authoritative (V2) DRAFT.
 *
 * There is no "create draft, then open the record, then pick a tab" -
 * `Apply for permit` lands here and the whole document is editable
 * immediately. DRAFT shows only as a status badge, because it is
 * something the system tracks, not a step the applicant performs.
 *
 * Stored content is used where it exists and a blank, structurally
 * complete document is used where it does not, so a permit created a
 * moment ago and one saved last week open the same way.
 */

interface Props {
  permit: Permit;
  jsa: Jsa;
  /**
   * The server-derived applicant identity for the signed-in person. A
   * privileged account carries a role instead of a team and position,
   * because it genuinely has neither - see auth/applicantIdentity.ts.
   */
  applicant: ApplicantIdentity;
}

export function V2DraftScreen({ permit, jsa, applicant }: Props) {
  const catalogue = useApiResource<FormCatalogue>((signal) => getFormCatalogue(signal), []);
  const navigate = useNavigate();
  const toast = useToast();

  if (catalogue.initialLoading) return <LoadingState label="Loading the permit form" />;
  if (catalogue.error) return <ErrorState error={catalogue.error} onRetry={catalogue.reload} />;
  if (!catalogue.data) return <ErrorState error={{ code: 'not_found' }} />;

  const permitType = permit.permit_type as PermitTypeKey;
  const definition = catalogue.data.permits[permitType];
  if (!definition) return <ErrorState error={{ code: 'not_found' }} />;

  // Stored content when there is some, a blank document when there is not.
  const initialPermit = (permit.form_payload as PermitValuesV2 | null) ?? emptyPermitValues(permitType, definition);
  const initialJsa = (jsa.form_payload as JsaValuesV2 | null) ?? emptyJsaValues(catalogue.data);

  return (
    <>
      <PageHeader
        eyebrow={permitTypeLabel(permit.permit_type)}
        title={`Permit ${permit.permitDisplayNumber}`}
        description={
          <span className="row">
            <StatusBadge status={permit.status} />
            <span>JSA {jsa.jsaDisplayNumber}</span>
            {/*
              Who this permit will be recorded as coming from. Shown here,
              in the page chrome, rather than on the document: the
              authoritative form has an Applicant line and a Company line
              and no role field, and it is not this screen's place to add
              one. A privileged applicant shows their role because they
              hold no team or position to show instead.
            */}
            <span data-testid="applicant-identity">
              {applicant.displayName} · {applicant.companyName}
              {applicant.role ? ` · ${applicant.role}` : ''}
              {applicant.kind === 'NORMAL' && applicant.teamName && applicant.positionName
                ? ` · ${applicant.teamName} · ${applicant.positionName}`
                : ''}
            </span>
          </span>
        }
      />

      <PermitDraftEditor
        permitType={permitType}
        catalogue={catalogue.data}
        initialPermit={initialPermit}
        initialJsa={initialJsa}
        initialVersion={permit.version}
        authoritative={{
          permitNumber: permit.permitDisplayNumber,
          applicantName: applicant.displayName,
          applicantCompany: applicant.companyName,
          jsaNumber: jsa.jsaDisplayNumber,
          completedBy: applicant.displayName,
        }}
        onSaveDraft={async ({ version, permit: permitValues, jsa: jsaValues }) => {
          // One document, one concurrency token: the JSA save uses the
          // version the permit save returned.
          const afterPermit = await saveV2PermitDraft(permit.id, version, permitValues);
          const afterJsa = await saveV2JsaDraft(permit.id, afterPermit.permit.version, jsaValues);
          return afterJsa.permit.version;
        }}
        onSubmit={async ({ version }) => {
          await submitPermit(permit.id, version);
        }}
        onSubmitted={() => {
          toast.show('Permit submitted for CRO review.');
          navigate(ROUTES.records);
        }}
      />
    </>
  );
}
