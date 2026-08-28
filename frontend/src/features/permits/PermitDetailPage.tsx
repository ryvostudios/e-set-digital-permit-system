import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPermit, updateJsaForm, updatePermitForm } from '../../api/endpoints';
import { asApiError, fieldErrors } from '../../api/errors';
import type { JsaFormPayload, PermitDetailResponse, PermitFormPayload } from '../../api/types';
import { useCurrentUser } from '../../auth/useAuth';
import { useApiResource } from '../../lib/useApiResource';
import { Button } from '../../ui/Button';
import { FormError } from '../../ui/Field';
import { Alert, ErrorState, LoadingState } from '../../ui/Feedback';
import { PageHeader, StatusBadge, TabPanel, Tabs } from '../../ui/Layout';
import { useToast } from '../../ui/Toast';
import { JsaDocument } from './JsaDocument';
import { PermitActions } from './PermitActions';
import { PermitDocument } from './PermitDocument';
import { PermitHistory } from './PermitHistory';
import { HseReviewWindow } from './HseReviewWindow';
import { PermitPdfButton } from './PermitPdfButton';
import { emptyJsaForm, emptyPermitForm, pruneEmptyStrings } from './forms/defaults';
import { JsaFormFields } from './forms/JsaFormFields';
import { PermitFormFields } from './forms/PermitFormFields';
import { permitTypeLabel } from './labels';
import { isV2Permit } from './formGeneration';
import { applicantIdentityOf } from '../../auth/applicantIdentity';
import { V2DraftScreen } from './v2/V2DraftScreen';
import { V2JsaRecord, V2PermitRecord } from './v2/V2RecordDocuments';
import { useFormCatalogue } from './v2/useFormCatalogue';
import './paper.css';

/**
 * One permit record: the Permit, its JSA, and its history.
 *
 * EDITING IS THE SERVER'S PERMISSION, NOT A LOCAL MODE. The Edit control
 * appears only when `availableActions` includes `update`, which the
 * backend decides from status, ownership, and capability. Even then,
 * every save carries the permit's `version`, so a record that moved
 * while it was open is refused rather than overwritten.
 *
 * The permit and its JSA share one optimistic-concurrency token (the
 * PERMIT's version), because they are one document. Saving the JSA
 * therefore refreshes the permit version too.
 */

type TabId = 'permit' | 'jsa' | 'history';

const TABS = [
  { id: 'permit', label: 'Permit' },
  { id: 'jsa', label: 'Job Safety Analysis' },
  { id: 'history', label: 'History' },
];

export function PermitDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const toast = useToast();
  // The applicant's own authoritative identity, for the permit's display
  // band. Server-resolved via /auth/me - never typed by anyone.
  const { capabilities } = useCurrentUser();
  const resource = useApiResource<PermitDetailResponse>((signal) => getPermit(id, signal), [id]);
  const [tab, setTab] = useState<TabId>('permit');

  const [editing, setEditing] = useState(false);
  const [permitDraft, setPermitDraft] = useState<PermitFormPayload | null>(null);
  const [jsaDraft, setJsaDraft] = useState<JsaFormPayload | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; requestId: string | null; issues: string[] } | null>(
    null,
  );

  const detail = resource.data;
  const permitType = detail?.permit.permit_type ?? null;

  /**
   * WHICH GENERATION THIS RECORD IS - the server's answer, from the
   * permit's stored `form_version`. A V2 record is drawn from the
   * authoritative catalogue and must never reach the V1 renderers, which
   * read a V1 payload's arrays off it and blank the screen.
   *
   * The catalogue is fetched ONCE here, for the whole record, and only
   * when it is actually needed: the Permit and JSA tabs unmount each
   * other, so a fetch inside either would repeat on every tab switch,
   * and a V1 record must not pay for a catalogue it never draws from.
   */
  const isV2 = detail ? isV2Permit(detail.permit) : false;
  const formCatalogue = useFormCatalogue({ enabled: isV2 });

  // Editing always starts from the authoritative record - never from a
  // draft left over from an earlier version of it.
  const beginEditing = useCallback(() => {
    if (!detail || !detail.permit.permit_type) return;
    // The V1 editor cannot represent a V2 payload - it would render V1
    // fields over V2 content and write V1 shapes back over it. A V2
    // draft its owner may edit is served by V2DraftScreen below instead.
    if (isV2Permit(detail.permit)) return;
    setPermitDraft(detail.permit.form_payload ?? emptyPermitForm(detail.permit.permit_type));
    setJsaDraft(detail.jsa.form_payload ?? emptyJsaForm());
    setSaveError(null);
    setEditing(true);
  }, [detail]);

  // If the record changes underneath (an action completes, a reviewer
  // moves it on), drop the editor rather than keeping a stale draft.
  useEffect(() => {
    if (!detail) return;
    if (editing && !detail.availableActions.includes('update')) {
      setEditing(false);
      setPermitDraft(null);
      setJsaDraft(null);
    }
  }, [detail, editing]);

  async function handleSave(): Promise<void> {
    if (!detail || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // The permit is saved first: its response carries the new version
      // the JSA save must then use, since the two share one token.
      let version = detail.permit.version;
      if (permitDraft) {
        const { permit } = await updatePermitForm(detail.permit.id, version, pruneEmptyStrings(permitDraft));
        version = permit.version;
      }
      if (jsaDraft) {
        await updateJsaForm(detail.permit.id, version, pruneEmptyStrings(jsaDraft));
      }
      toast.show('Saved.');
      setEditing(false);
      setPermitDraft(null);
      setJsaDraft(null);
      resource.reload();
    } catch (caught) {
      const error = asApiError(caught);
      const issues = Object.entries(fieldErrors(error)).map(([path, message]) => `${path}: ${message}`);
      setSaveError({ message: error.message, requestId: error.requestId, issues });
      // A conflict means the record moved; re-read so the person sees
      // what it actually says now.
      if (error.code === 'conflict') resource.reload();
    } finally {
      setSaving(false);
    }
  }

  if (resource.initialLoading) return <LoadingState label="Loading permit" />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (!detail) return <ErrorState error={{ code: 'not_found' }} />;

  const { permit, jsa, validity, availableActions, history, signatures, document, serverTime, closure } = detail;
  const canEdit = availableActions.includes('update');

  /**
   * An authoritative (V2) record the owner may edit opens as ONE
   * continuous document rather than the tabbed record view. The
   * generation is read from the permit's stored `form_version` - the
   * server's decision - so the client never chooses V1 or V2.
   *
   * WHETHER IT MAY BE EDITED IS ALSO THE SERVER'S ANSWER: `update` is
   * offered on exactly the two statuses its permits service calls
   * editable, DRAFT and the PENDING_CORRECTION a CRO sent back. This
   * follows that hint rather than restating the rule, so a V2 permit
   * returned for correction is corrected in the V2 editor - the only
   * editor that can represent its payload.
   *
   * Anything else, including every V1 record and every submitted permit,
   * keeps the existing record view below.
   */
  if (isV2 && canEdit) {
    return (
      <V2DraftScreen
        permit={permit}
        jsa={jsa}
        applicant={applicantIdentityOf(capabilities)}
        availableActions={availableActions}
        history={history}
        onCompleted={resource.reload}
      />
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={permitTypeLabel(permit.permit_type)}
        title={`Permit ${permit.permitDisplayNumber}`}
        description={
          <span className="row">
            <StatusBadge status={permit.status} />
            <span>JSA {jsa.jsaDisplayNumber}</span>
            {validity?.isValid ? <span className="badge badge--success">Valid</span> : null}
          </span>
        }
        actions={
          editing ? (
            <>
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setPermitDraft(null);
                  setJsaDraft(null);
                  setSaveError(null);
                }}
              >
                Discard changes
              </Button>
              <Button variant="primary" loading={saving} onClick={() => void handleSave()}>
                Save
              </Button>
            </>
          ) : canEdit ? (
            <Button variant="secondary" onClick={beginEditing}>
              Edit permit and JSA
            </Button>
          ) : null
        }
      />

      {/*
        THE HSE APPROVAL PRIORITY WINDOW, shown to whoever is looking -
        CRO and HSE see the same clock, because the question "whose turn
        is it?" has one answer.

        Rendered only while the permit is actually PENDING_HSE, so the
        moment it is issued (by either path) the countdown and every
        control tied to it disappear with it. When the window runs out the
        record is re-read, so the fallback action appears on the SERVER's
        terms rather than because a timer in the browser reached zero.
      */}
      {permit.status === 'PENDING_HSE' && permit.hse_review_deadline_at ? (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <HseReviewWindow
            deadlineAt={permit.hse_review_deadline_at}
            serverTime={serverTime}
            onExpired={resource.reload}
          />
        </div>
      ) : null}

      {permit.status === 'PENDING_CORRECTION' ? (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Alert tone="warning" title="Returned for correction">
            A Control Room Operator has returned this permit. The reason, if one was given, is in the History tab.
          </Alert>
        </div>
      ) : null}

      {saveError ? (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <FormError message={saveError.message} requestId={saveError.requestId} />
          {saveError.issues.length > 0 ? (
            <ul className="muted text-sm" style={{ marginTop: 'var(--space-2)', paddingLeft: 'var(--space-5)' }}>
              {saveError.issues.slice(0, 8).map((issue) => (
                <li key={issue} style={{ listStyle: 'disc' }}>
                  {issue}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Tabs tabs={TABS} activeId={tab} onChange={(next) => setTab(next as TabId)} label="Permit record sections" />

      <div style={{ marginTop: 'var(--space-4)' }}>
        <TabPanel id="permit" activeId={tab}>
          {isV2 ? (
            <>
              <V2PermitRecord permit={permit} jsa={jsa} signatures={signatures} catalogue={formCatalogue} />
              <div style={{ marginTop: 'var(--space-4)' }}>
                <PermitPdfButton permit={permit} document={document} />
              </div>
            </>
          ) : editing && permitDraft && permitType ? (
            <article className="doc">
              <header className="doc__masthead">
                <div>
                  <p className="doc__issuer">E-SET · Permit to Work — editing</p>
                  <p className="doc__title">{permitTypeLabel(permitType)}</p>
                </div>
                <dl className="doc__refs">
                  <dt>Permit No.</dt>
                  <dd>{permit.permitDisplayNumber}</dd>
                </dl>
              </header>
              <PermitFormFields
                permitType={permitType}
                form={permitDraft}
                disabled={saving}
                onChange={setPermitDraft}
              />
            </article>
          ) : (
            <>
              <PermitDocument permit={permit} validity={validity} signatures={signatures} closure={closure} />
              <div style={{ marginTop: 'var(--space-4)' }}>
                <PermitPdfButton permit={permit} document={document} />
              </div>
            </>
          )}
        </TabPanel>

        <TabPanel id="jsa" activeId={tab}>
          {isV2 ? (
            <V2JsaRecord permit={permit} jsa={jsa} catalogue={formCatalogue} />
          ) : editing && jsaDraft ? (
            <article className="doc">
              <header className="doc__masthead">
                <div>
                  <p className="doc__issuer">E-SET · Permit to Work — editing</p>
                  <p className="doc__title">Job Safety Analysis</p>
                </div>
                <dl className="doc__refs">
                  <dt>JSA No.</dt>
                  <dd>{jsa.jsaDisplayNumber}</dd>
                </dl>
              </header>
              <JsaFormFields form={jsaDraft} disabled={saving} onChange={setJsaDraft} />
            </article>
          ) : (
            <JsaDocument jsa={jsa} />
          )}
        </TabPanel>

        <TabPanel id="history" activeId={tab}>
          <div className="card">
            <PermitHistory events={history} />
          </div>
        </TabPanel>
      </div>

      {!editing ? (
        <PermitActions
          permit={permit}
          availableActions={availableActions}
          onEdit={beginEditing}
          onCompleted={resource.reload}
        />
      ) : null}
    </>
  );
}
