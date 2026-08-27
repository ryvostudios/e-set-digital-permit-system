import { useState } from 'react';
import { downloadPermitPdf } from '../../api/endpoints';
import { asApiError } from '../../api/errors';
import type { Permit, PermitDocumentStatus } from '../../api/types';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Feedback';

/**
 * The permit document.
 *
 * THE BROWSER NEVER TOUCHES STORAGE. There is no bucket name, no object
 * key, no signed URL, and no assumption that the PDF is publicly
 * reachable anywhere. The bytes are requested from the backend, which
 * authorizes the permit first, verifies the file's hash, and only then
 * streams it.
 *
 * PRIVATE DOCUMENT STORAGE IS AN OPERATOR PREREQUISITE and is not
 * configured in every environment. When the backend reports that, this
 * says so plainly and stops - it never falls back to a guessed URL, and
 * it never shows what is missing or where.
 */
export function PermitPdfButton({
  permit,
  document: documentStatus,
}: {
  permit: Permit;
  document: PermitDocumentStatus | null;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'warning' | 'danger'; text: string; requestId: string | null } | null>(
    null,
  );

  // Only an issued permit (or an issued permit's later HELD/CANCELLED/
  // CLOSED state) ever has a document at all.
  if (!permit.issued_at) return null;

  async function handleDownload(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { blob, fileName } = await downloadPermitPdf(permit.id);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = fileName ?? `permit-${permit.permitDisplayNumber}.pdf`;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      // Released immediately - the object URL exists only long enough
      // for the browser to start the save.
      URL.revokeObjectURL(url);
    } catch (caught) {
      const error = asApiError(caught);
      setMessage({
        tone: error.code === 'storage_unavailable' || error.code === 'document_processing' ? 'warning' : 'danger',
        text:
          error.code === 'storage_unavailable'
            ? 'Document storage is not configured for this environment. The permit record itself is unaffected.'
            : error.message,
        requestId: error.requestId,
      });
    } finally {
      setBusy(false);
    }
  }

  const stillGenerating = documentStatus !== null && documentStatus.status !== 'GENERATED';

  return (
    <div className="stack stack--tight">
      <Button variant="secondary" loading={busy} onClick={() => void handleDownload()}>
        {busy ? 'Preparing document' : 'Download permit document (PDF)'}
      </Button>

      {stillGenerating ? (
        <p className="muted text-sm">The combined Permit and JSA document is still being prepared.</p>
      ) : null}

      {message ? (
        <Alert tone={message.tone} requestId={message.requestId}>
          {message.text}
        </Alert>
      ) : null}
    </div>
  );
}
