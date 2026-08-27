import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPermit } from '../../api/endpoints';
import { asApiError } from '../../api/errors';
import { PERMIT_TYPES, type PermitType } from '../../api/types';
import { ROUTES } from '../../app/routes';
import { describeApplicantIdentity } from '../../auth/capabilities';
import { useCurrentUser } from '../../auth/useAuth';
import { Button } from '../../ui/Button';
import { FormError } from '../../ui/Field';
import { Alert } from '../../ui/Feedback';
import { Card, PageHeader } from '../../ui/Layout';
import { DocumentField, FieldGrid } from './DocumentParts';
import { PERMIT_TYPE_DESCRIPTIONS, PERMIT_TYPE_LABELS } from './labels';
import './paper.css';

/**
 * Starting a permit.
 *
 * Exactly two things are decided here: which of the four templates, and
 * nothing else. The permit number, the JSA number, the linked JSA, the
 * status, and the applicant identity are all produced by the server when
 * the draft is created or submitted - the request body carries only
 * `permitType`.
 *
 * THE APPLICANT LINE IS READ-ONLY AND IS A PREVIEW. It is shown so a
 * person can confirm the record will carry the right identity, but it is
 * never sent: the backend derives the applicant from the authenticated
 * session at submission, and no control on this page can influence it.
 */
export function ApplyPermitPage() {
  const { user, capabilities } = useCurrentUser();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<PermitType | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);

  async function handleCreate(): Promise<void> {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { permit } = await createPermit(selected);
      navigate(ROUTES.permit(permit.id));
    } catch (caught) {
      const apiError = asApiError(caught);
      setError({ message: apiError.message, requestId: apiError.requestId });
    } finally {
      setSubmitting(false);
    }
  }

  if (!capabilities.canApplyForPermits) {
    return (
      <>
        <PageHeader eyebrow="Work" title="Apply for permit" />
        <Alert tone="info" title="Permit application is not part of your role">
          Your Team and Position do not carry permit application authority. Control Room Operators review permits
          rather than raising them.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Work"
        title="Apply for permit"
        description="Choose the permit template for this job. A linked Job Safety Analysis is created with it."
      />

      <div className="stack">
        <Card title="Applicant">
          <FieldGrid>
            <DocumentField label="Recorded applicant" value={describeApplicantIdentity(user)} strong full />
          </FieldGrid>
          <p className="muted text-sm" style={{ marginTop: 'var(--space-3)' }}>
            The system records this identity when the permit is submitted. It cannot be changed here.
          </p>
        </Card>

        <Card title="Permit type">
          <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend className="sr-only">Choose a permit type</legend>
            <div className="grid-2">
              {PERMIT_TYPES.map((permitType) => (
                <label
                  key={permitType}
                  className="repeat-row"
                  style={{
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    borderColor: selected === permitType ? 'var(--brand-primary)' : 'var(--border)',
                    background: selected === permitType ? 'var(--selected-bg)' : 'var(--surface-header)',
                  }}
                >
                  <span className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                    <input
                      type="radio"
                      name="permitType"
                      value={permitType}
                      checked={selected === permitType}
                      disabled={submitting}
                      onChange={() => setSelected(permitType)}
                      style={{ marginTop: '0.3rem', width: '1.125rem', height: '1.125rem', accentColor: 'var(--brand-primary)' }}
                    />
                    <span>
                      <span style={{ display: 'block', fontWeight: 700 }}>{PERMIT_TYPE_LABELS[permitType]}</span>
                      <span className="muted text-sm">{PERMIT_TYPE_DESCRIPTIONS[permitType]}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {error ? (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <FormError message={error.message} requestId={error.requestId} />
            </div>
          ) : null}

          <div className="row" style={{ marginTop: 'var(--space-5)' }}>
            <Button variant="primary" loading={submitting} disabled={!selected} onClick={() => void handleCreate()}>
              {submitting ? 'Creating draft' : 'Create draft permit'}
            </Button>
            <span className="muted text-sm">You can edit the draft before submitting it.</span>
          </div>
        </Card>
      </div>
    </>
  );
}
