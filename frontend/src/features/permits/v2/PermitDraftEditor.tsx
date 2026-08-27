import { useCallback, useMemo, useRef, useState } from 'react';
import type { FormCatalogue, PermitTypeKey } from '../../../api/catalogue';
import { asApiError, type UnansweredAnswer } from '../../../api/errors';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Feedback';
import { useUnsavedChangesGuard } from '../../../lib/useUnsavedChangesGuard';
import { JsaDocumentV2 } from './JsaDocumentV2';
import { PermitDocumentV2 } from './PermitDocumentV2';
import { pathId } from './primitives';
import type { JsaValuesV2, PermitValuesV2 } from './values';
import './paperV2.css';

/**
 * THE APPLICANT'S WORKFLOW: one continuous document.
 *
 * Permit, then JSA page 1, then JSA page 2, then the actions - in one
 * scroll, in the order the paperwork is filled. There are deliberately no
 * Permit/JSA tabs while drafting: they are one document to the person
 * holding the pen, and DRAFT is a status the system keeps, not a step the
 * applicant performs.
 *
 * COMPLETENESS IS THE SERVER'S ANSWER, NOT OURS. This component never
 * decides what "complete" means. It submits, and if the server refuses
 * with an itemised list of unanswered questions it highlights exactly
 * those and takes the applicant to the first one. Keeping the rule in one
 * place is what stops the editor from drifting into accepting something
 * the server would reject, or nagging about something it would not.
 */

export interface DraftEditorProps {
  permitType: PermitTypeKey;
  catalogue: FormCatalogue;
  initialPermit: PermitValuesV2;
  initialJsa: JsaValuesV2;
  /** The permit's optimistic-concurrency token. */
  initialVersion: number;
  authoritative?: {
    permitNumber?: string;
    applicantName?: string;
    applicantCompany?: string;
    jsaNumber?: string;
    completedBy?: string;
  };
  /** Saves both documents. Resolves with the permit's NEW version. */
  onSaveDraft: (input: { version: number; permit: PermitValuesV2; jsa: JsaValuesV2 }) => Promise<number>;
  onSubmit: (input: { version: number }) => Promise<void>;
  onSubmitted?: () => void;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string; requestId: string | null; stale: boolean };

export function PermitDraftEditor({
  permitType,
  catalogue,
  initialPermit,
  initialJsa,
  initialVersion,
  authoritative,
  onSaveDraft,
  onSubmit,
  onSubmitted,
}: DraftEditorProps) {
  const [permitValues, setPermitValues] = useState<PermitValuesV2>(initialPermit);
  const [jsaValues, setJsaValues] = useState<JsaValuesV2>(initialJsa);
  const [version, setVersion] = useState(initialVersion);
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [unanswered, setUnanswered] = useState<UnansweredAnswer[]>([]);
  const [submitError, setSubmitError] = useState<{ message: string; requestId: string | null } | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSave((current) => (current.kind === 'saved' ? { kind: 'idle' } : current));
  }, []);

  const updatePermit = useCallback((next: PermitValuesV2) => {
    setPermitValues(next);
    markDirty();
  }, [markDirty]);

  const updateJsa = useCallback((next: JsaValuesV2) => {
    setJsaValues(next);
    markDirty();
  }, [markDirty]);

  /**
   * Leaving with unsaved work loses it - there is no autosave, because a
   * half-answered safety document written back on a timer is worse than
   * one the person chose to save. Covers both closing the tab and
   * navigating inside the application.
   */
  useUnsavedChangesGuard(dirty);

  /** The unanswered paths, as element ids, for highlighting. */
  const invalid = useMemo(
    () => new Set(unanswered.map((entry) => pathId(entry.path))),
    [unanswered],
  );

  /** Scrolls to a control and focuses it, clear of the sticky header. */
  const goToFirstUnanswered = useCallback((entries: UnansweredAnswer[]) => {
    const first = entries[0];
    if (!first) return;
    const id = pathId(first.path);
    const row = document.getElementById(id);
    if (!row) return;
    // `scroll-margin-top` on the target keeps it below the sticky header
    // rather than under it - see paperV2.css.
    row.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const target = row.querySelector<HTMLElement>('[data-focus-target]');
    target?.focus({ preventScroll: true });
  }, []);

  async function handleSaveDraft(): Promise<void> {
    setSave({ kind: 'saving' });
    setSubmitError(null);
    try {
      const nextVersion = await onSaveDraft({ version, permit: permitValues, jsa: jsaValues });
      setVersion(nextVersion);
      setDirty(false);
      setSave({ kind: 'saved', at: Date.now() });
    } catch (caught) {
      const error = asApiError(caught);
      setSave({
        kind: 'error',
        message: error.message,
        requestId: error.requestId,
        stale: error.reason === 'stale_version',
      });
    }
  }

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    setUnanswered([]);
    try {
      await onSubmit({ version });
      setDirty(false);
      onSubmitted?.();
    } catch (caught) {
      const error = asApiError(caught);
      if (error.unanswered) {
        // The server's list, in its order. Nothing entered is cleared.
        const all = [...error.unanswered.permit, ...error.unanswered.jsa];
        setUnanswered(all);
        setSubmitError({ message: error.message, requestId: error.requestId });
        // Let the highlight render before moving to it.
        window.setTimeout(() => {
          summaryRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          goToFirstUnanswered(all);
        }, 0);
      } else {
        setSubmitError({ message: error.message, requestId: error.requestId });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const definition = catalogue.permits[permitType];

  return (
    <div className="stack" data-testid="permit-draft-editor">
      {unanswered.length > 0 ? (
        <div ref={summaryRef} data-testid="unanswered-summary" style={{ scrollMarginTop: 'var(--doc-sticky-offset)' }}>
          <Alert tone="warning" title={`${unanswered.length} question${unanswered.length === 1 ? '' : 's'} still need an answer`}>
            <p>{submitError?.message}</p>
            <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-5)' }}>
              {unanswered.slice(0, 5).map((entry) => (
                <li key={entry.path.join('.')} style={{ listStyle: 'disc' }}>
                  <strong>{entry.sectionTitle}</strong> — {entry.itemLabel}
                </li>
              ))}
            </ul>
            {unanswered.length > 5 ? (
              <p className="muted text-sm">…and {unanswered.length - 5} more.</p>
            ) : null}
            <Button variant="secondary" onClick={() => goToFirstUnanswered(unanswered)}>
              Go to the first one
            </Button>
          </Alert>
        </div>
      ) : null}

      {submitError && unanswered.length === 0 ? (
        <Alert tone="danger" title="This permit could not be submitted">
          {submitError.message}
        </Alert>
      ) : null}

      {save.kind === 'error' ? (
        <Alert tone="danger" title={save.stale ? 'This permit changed elsewhere' : 'Could not save'}>
          {save.stale
            ? 'Someone or something else updated this permit while it was open. Reload to get the latest version - your unsaved changes are still on screen.'
            : save.message}
        </Alert>
      ) : null}

      {/* The document itself: permit, then JSA page 1, then page 2. */}
      <PermitDocumentV2
        permitType={permitType}
        definition={definition}
        values={permitValues}
        mode="edit"
        onChange={updatePermit}
        invalid={invalid}
        authoritative={authoritative}
      />

      <JsaDocumentV2
        definition={catalogue.jsa}
        values={jsaValues}
        mode="edit"
        onChange={updateJsa}
        invalid={invalid}
        authoritative={authoritative}
      />

      <div className="doc__actions" data-testid="editor-actions">
        <span className="doc__save-state" data-testid="save-state" data-dirty={dirty ? 'true' : 'false'}>
          {save.kind === 'saving'
            ? 'Saving…'
            : save.kind === 'saved' && !dirty
              ? 'Draft saved'
              : dirty
                ? 'Unsaved changes'
                : 'No changes'}
        </span>
        <Button variant="secondary" loading={save.kind === 'saving'} onClick={() => void handleSaveDraft()}>
          Save Draft
        </Button>
        <Button variant="primary" loading={submitting} onClick={() => void handleSubmit()}>
          Submit
        </Button>
      </div>
    </div>
  );
}
