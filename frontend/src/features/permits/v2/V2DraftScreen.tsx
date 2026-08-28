import { useNavigate } from 'react-router-dom';
import { getFormCatalogue, type FormCatalogue, type PermitTypeKey } from '../../../api/catalogue';
import { resubmitPermit, saveV2JsaDraft, saveV2PermitDraft, submitPermit } from '../../../api/endpoints';
import type { ApplicantIdentity } from '../../../auth/applicantIdentity';
import type { AvailableAction, Jsa, LifecycleEvent, Permit } from '../../../api/types';
import { ROUTES } from '../../../app/routes';
import { useApiResource } from '../../../lib/useApiResource';
import { Alert, ErrorState, LoadingState } from '../../../ui/Feedback';
import { PageHeader, StatusBadge } from '../../../ui/Layout';
import { useToast } from '../../../ui/Toast';
import { permitTypeLabel } from '../labels';
import { PermitHistory } from '../PermitHistory';
import { PermitDraftEditor } from './PermitDraftEditor';
import { hydrateJsaValuesV2, hydratePermitValuesV2 } from './values';

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
 *
 * IT SERVES BOTH EDITABLE STATUSES, because the backend has exactly two
 * (`EDITABLE_STATUSES` in its permits service): DRAFT, and the
 * PENDING_CORRECTION a CRO sent back. They are the same document and the
 * same controls; what differs is the onward action, which is `submit`
 * for one and `resubmit` for the other - a different endpoint and a
 * different event in the permit's history.
 *
 * WHICH ACTIONS EXIST IS THE SERVER'S ANSWER. Nothing here infers
 * authority from a status or a role: the buttons follow the record's
 * `availableActions`, exactly as the rest of the application does.
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
  /** The record's own action hints. The ONLY source of what may be done here. */
  availableActions: AvailableAction[];
  /**
   * The permit's history. Shown when it was sent back, because the
   * reason a CRO gave is the whole point of a correction and this screen
   * replaces the record view that would otherwise carry it.
   */
  history: LifecycleEvent[];
  /** Re-reads the record after an action that leaves it editable. */
  onCompleted: () => void;
}

export function V2DraftScreen({ permit, jsa, applicant, availableActions, history, onCompleted }: Props) {
  const catalogue = useApiResource<FormCatalogue>((signal) => getFormCatalogue(signal), []);
  const navigate = useNavigate();
  const toast = useToast();

  if (catalogue.initialLoading) return <LoadingState label="Loading the permit form" />;
  if (catalogue.error) return <ErrorState error={catalogue.error} onRetry={catalogue.reload} />;
  if (!catalogue.data) return <ErrorState error={{ code: 'not_found' }} />;

  const permitType = permit.permit_type as PermitTypeKey;
  const definition = catalogue.data.permits[permitType];
  if (!definition) return <ErrorState error={{ code: 'not_found' }} />;

  /*
    Stored content where there is some, a blank document where there is
    not - and, crucially, at every level rather than only the top one.
    A partly completed draft is a legitimate thing to save now, so a
    stored payload routinely carries only the parts someone filled in;
    hydration merges it onto the blank form so the documents below can
    rely on the structure the catalogue describes. It supplies containers
    only - no answer is ever invented. See values.ts.
  */
  const initialPermit = hydratePermitValuesV2(permitType, definition, permit.form_payload);
  const initialJsa = hydrateJsaValuesV2(catalogue.data, jsa.form_payload);

  /*
    THE ONWARD ACTION, taken from the server's hints rather than from the
    status. A permit the CRO sent back is RESUBMITTED - its own endpoint,
    its own lifecycle event - and calling the initial-submission endpoint
    for it would be the wrong transition entirely. Both carry the permit's
    version, so a record that moved while it was open is refused.
  */
  const correcting = permit.status === 'PENDING_CORRECTION';
  const onward = correcting
    ? { available: availableActions.includes('resubmit'), label: 'Resubmit', toast: 'Permit resubmitted for CRO review.' }
    : { available: availableActions.includes('submit'), label: 'Submit', toast: 'Permit submitted for CRO review.' };

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

      {correcting ? (
        <div className="stack" style={{ marginBottom: 'var(--space-4)' }} data-testid="correction-context">
          <Alert tone="warning" title="Returned for correction">
            A Control Room Operator has returned this permit. Correct it below and resubmit it.
          </Alert>
          {/*
            The reason the CRO gave. This screen replaces the tabbed
            record view, so without the history here the applicant would
            be asked to correct a permit without being told what for.
          */}
          <div className="card">
            <PermitHistory events={history} />
          </div>
        </div>
      ) : null}

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
        onSaveDraft={async ({ version, permit: permitValues, jsa: jsaValues, onVersion }) => {
          /*
            One document, one concurrency token: the JSA save uses the
            version the permit save returned.

            Each version is reported the moment the server issues it, so a
            failure on the second write cannot leave the editor holding a
            version the database has already moved past. Without that, a
            permit saved but a JSA rejected left every later attempt
            conflicting until the page was reloaded.
          */
          const afterPermit = await saveV2PermitDraft(permit.id, version, permitValues);
          onVersion(afterPermit.permit.version);
          const afterJsa = await saveV2JsaDraft(permit.id, afterPermit.permit.version, jsaValues);
          onVersion(afterJsa.permit.version);
          return afterJsa.permit.version;
        }}
        canSubmit={onward.available}
        submitLabel={onward.label}
        onSubmit={async ({ version }) => {
          if (correcting) await resubmitPermit(permit.id, version);
          else await submitPermit(permit.id, version);
        }}
        onSubmitted={() => {
          toast.show(onward.toast);
          // The record is no longer editable, so the editor must not stay
          // on screen behind it. Same destination as a first submission.
          onCompleted();
          navigate(ROUTES.records);
        }}
      />
    </>
  );
}
