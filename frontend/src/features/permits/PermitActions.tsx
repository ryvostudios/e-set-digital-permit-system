import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  cancelPermit,
  closePermit,
  fallbackApprove,
  forwardToHse,
  holdPermit,
  hseApprove,
  hseSendBack,
  renewPermit,
  resubmitPermit,
  resumePermit,
  sendBackToApplicant,
  submitPermit,
} from '../../api/endpoints';
import { asApiError } from '../../api/errors';
import type { AvailableAction, Permit } from '../../api/types';
import { ROUTES } from '../../app/routes';
import { Button, type ButtonVariant } from '../../ui/Button';
import { Modal } from '../../ui/Dialog';
import { FormError, Textarea } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { ACTION_LABELS } from './labels';

/**
 * The workflow actions available on a permit.
 *
 * WHICH ACTIONS APPEAR IS THE SERVER'S ANSWER. `availableActions` comes
 * from `computeAvailableActions`, which the backend derives from the
 * permit's current status, the caller's ownership, its own resolved
 * capabilities, and its own clock. This component renders that list and
 * never computes it - so no timer here can conjure a fallback approval,
 * and no local state can offer an action the backend would refuse.
 *
 * EVERY MUTATION SENDS THE PERMIT'S CURRENT `version`. If the record
 * moved since it was opened, the backend answers 409 and the person is
 * told to reload rather than having a stale write applied.
 *
 * NO FINAL STATE IS ASSUMED. After any action the parent re-fetches the
 * authoritative permit; nothing is optimistically transitioned here.
 */

interface ActionConfig {
  variant: ButtonVariant;
  /** A reason/remarks field: 'required' is enforced by the backend too. */
  note?: { label: string; required: boolean; hint?: string };
  confirm?: { title: string; body: string; confirmLabel: string };
}

const ACTION_CONFIG: Record<AvailableAction, ActionConfig> = {
  update: { variant: 'secondary' },
  submit: {
    variant: 'primary',
    confirm: {
      title: 'Submit for CRO review',
      body: 'Your identity will be recorded as the applicant and the permit will move to the CRO queue. You will not be able to edit it while it is under review.',
      confirmLabel: 'Submit',
    },
  },
  resubmit: {
    variant: 'primary',
    confirm: {
      title: 'Resubmit for CRO review',
      body: 'The permit returns to the CRO queue with your corrections.',
      confirmLabel: 'Resubmit',
    },
  },
  forward_hse: {
    variant: 'primary',
    confirm: {
      title: 'Forward to HSE',
      body: 'You are authorizing this permit as CRO. Your identity is recorded as the CRO signature and the HSE review window starts now.',
      confirmLabel: 'Forward to HSE',
    },
  },
  send_back: {
    variant: 'secondary',
    note: { label: 'Reason for return', required: false, hint: 'Shown to the applicant.' },
  },
  hse_approve: {
    variant: 'primary',
    confirm: {
      title: 'Approve and issue',
      body: 'You are approving this permit as HSE. It will be issued immediately and your identity is recorded as the HSE signature.',
      confirmLabel: 'Approve and issue',
    },
  },
  hse_send_back: {
    variant: 'secondary',
    note: { label: 'Reason for return to CRO', required: false },
  },
  fallback_approve: {
    variant: 'primary',
    confirm: {
      title: 'Approve as CRO fallback',
      body: 'The HSE review window has expired. You are approving as CRO FALLBACK, not as HSE, and the permit will be issued.',
      confirmLabel: 'Approve as fallback',
    },
  },
  hold: {
    variant: 'secondary',
    note: { label: 'Reason for hold', required: true, hint: 'A hold reason is mandatory.' },
  },
  resume: {
    variant: 'secondary',
    confirm: {
      title: 'Resume permit',
      body: 'The permit returns to issued. Resuming does not extend its validity — the original expiry still applies.',
      confirmLabel: 'Resume',
    },
  },
  cancel: {
    variant: 'danger',
    note: { label: 'Reason for cancellation', required: false, hint: 'Cancellation is permanent.' },
  },
  close: {
    variant: 'primary',
    note: { label: 'Closure remarks', required: false },
  },
  renew: {
    variant: 'secondary',
    confirm: {
      title: 'Renew permit',
      body: 'A new permit is created from this one, carrying the same Job Safety Analysis and a new permit number. This permit is not changed.',
      confirmLabel: 'Renew',
    },
  },
};

async function performAction(action: AvailableAction, permit: Permit, note: string): Promise<{ nextId?: string }> {
  const id = permit.id;
  const version = permit.version;
  const trimmed = note.trim();

  switch (action) {
    case 'submit':
      await submitPermit(id, version);
      return {};
    case 'resubmit':
      await resubmitPermit(id, version);
      return {};
    case 'forward_hse':
      await forwardToHse(id, version);
      return {};
    case 'send_back':
      await sendBackToApplicant(id, version, trimmed || undefined);
      return {};
    case 'hse_approve':
      await hseApprove(id, version);
      return {};
    case 'hse_send_back':
      await hseSendBack(id, version, trimmed || undefined);
      return {};
    case 'fallback_approve':
      await fallbackApprove(id, version);
      return {};
    case 'hold':
      await holdPermit(id, version, trimmed);
      return {};
    case 'resume':
      await resumePermit(id, version);
      return {};
    case 'cancel':
      await cancelPermit(id, version, trimmed || undefined);
      return {};
    case 'close':
      await closePermit(id, version, trimmed || undefined);
      return {};
    case 'renew': {
      const { permit: created } = await renewPermit(id);
      return { nextId: created.id };
    }
    case 'update':
      return {};
  }
}

export function PermitActions({
  permit,
  availableActions,
  onEdit,
  onCompleted,
  disabled = false,
}: {
  permit: Permit;
  availableActions: AvailableAction[];
  onEdit: () => void;
  onCompleted: () => void;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [pending, setPending] = useState<AvailableAction | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [noteError, setNoteError] = useState<string | undefined>(undefined);

  function begin(action: AvailableAction): void {
    if (action === 'update') {
      onEdit();
      return;
    }
    setPending(action);
    setNote('');
    setError(null);
    setNoteError(undefined);
  }

  function close(): void {
    if (busy) return;
    setPending(null);
    setNote('');
    setError(null);
    setNoteError(undefined);
  }

  async function confirm(): Promise<void> {
    if (!pending || busy) return;
    const config = ACTION_CONFIG[pending];

    if (config.note?.required && note.trim() === '') {
      setNoteError('This is required.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { nextId } = await performAction(pending, permit, note);
      toast.show(`${ACTION_LABELS[pending]} — done.`);
      setPending(null);
      setNote('');
      if (nextId) navigate(ROUTES.permit(nextId));
      // The authoritative record is re-read; nothing is assumed here.
      else onCompleted();
    } catch (caught) {
      const apiError = asApiError(caught);
      setError({ message: apiError.message, requestId: apiError.requestId });
      if (apiError.code === 'conflict' || apiError.code === 'forbidden' || apiError.code === 'not_found') {
        // The permit (or the caller's authority over it) has moved on.
        // Re-read so the screen stops offering what is no longer true.
        onCompleted();
      }
    } finally {
      setBusy(false);
    }
  }

  if (availableActions.length === 0) {
    return (
      <div className="action-bar">
        <span className="action-bar__status">No actions are available to you on this permit right now.</span>
      </div>
    );
  }

  const config = pending ? ACTION_CONFIG[pending] : null;

  return (
    <>
      <div className="action-bar">
        <span className="action-bar__status">
          Permit {permit.permitDisplayNumber} · version {permit.version}
        </span>
        {availableActions.map((action) => (
          <Button
            key={action}
            variant={ACTION_CONFIG[action].variant}
            disabled={disabled}
            onClick={() => begin(action)}
          >
            {ACTION_LABELS[action]}
          </Button>
        ))}
      </div>

      {pending && config ? (
        <Modal
          open
          onClose={close}
          busy={busy}
          title={config.confirm?.title ?? ACTION_LABELS[pending]}
          description={config.confirm?.body}
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button variant={config.variant} loading={busy} onClick={() => void confirm()}>
                {config.confirm?.confirmLabel ?? ACTION_LABELS[pending]}
              </Button>
            </>
          }
        >
          {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
          {config.note ? (
            <Textarea
              label={config.note.label}
              required={config.note.required}
              hint={config.note.hint}
              error={noteError}
              rows={3}
              maxLength={2000}
              value={note}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
            />
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}
