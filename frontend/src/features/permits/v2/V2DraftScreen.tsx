import { useNavigate } from 'react-router-dom';
import { getFormCatalogue, type FormCatalogue, type PermitTypeKey } from '../../../api/catalogue';
import { saveV2JsaDraft, saveV2PermitDraft, submitPermit } from '../../../api/endpoints';
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
  applicantName: string;
  applicantCompany: string;
}

export function V2DraftScreen({ permit, jsa, applicantName, applicantCompany }: Props) {
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
          applicantName,
          applicantCompany,
          jsaNumber: jsa.jsaDisplayNumber,
          completedBy: applicantName,
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
