import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getFormCatalogue, type FormCatalogue, type PermitTypeKey } from '../../../api/catalogue';
import { useApiResource } from '../../../lib/useApiResource';
import { ErrorState, LoadingState } from '../../../ui/Feedback';
import { saveV2JsaDraft, saveV2PermitDraft, submitPermit } from '../../../api/endpoints';
import { JsaDocumentV2 } from './JsaDocumentV2';
import { PermitDocumentV2 } from './PermitDocumentV2';
import { PermitDraftEditor } from './PermitDraftEditor';
import type { DocumentMode } from './primitives';
import { emptyJsaValues, emptyPermitValues, type JsaValuesV2, type PermitValuesV2 } from './values';

/**
 * A rendering harness for the authoritative documents.
 *
 * WHY IT EXISTS. Real-browser visual QA needs a URL, and the documents
 * are not yet wired into the live create flow (that is the cutover, and
 * it is deliberately not part of this stage). This page gives Playwright
 * somewhere to render each permit and the two JSA pages against
 * controlled catalogue data.
 *
 * IT IS NOT PART OF THE SHIPPED APPLICATION. `AppRouter` only mounts this
 * route when `import.meta.env.MODE === 'e2e'`, so the production bundle
 * has no such route and no way to reach it. It reads no permit, writes
 * nothing, and holds its values in local state.
 */

const PERMIT_TYPES: PermitTypeKey[] = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'];

function isPermitType(value: string | null): value is PermitTypeKey {
  return value !== null && (PERMIT_TYPES as string[]).includes(value);
}

export function FormPreviewPage() {
  const [params] = useSearchParams();
  const permitType: PermitTypeKey = isPermitType(params.get('type')) ? (params.get('type') as PermitTypeKey) : 'WTG_WORK';
  const mode: DocumentMode = params.get('mode') === 'read' ? 'read' : 'edit';
  // The full applicant workflow, rather than the bare documents.
  const asEditor = params.get('editor') === '1';
  const permitId = params.get('permitId') ?? '00000000-0000-4000-8000-000000000001';

  const catalogue = useApiResource<FormCatalogue>((signal) => getFormCatalogue(signal), []);

  if (catalogue.initialLoading) return <LoadingState label="Loading form definition" />;
  if (catalogue.error) return <ErrorState error={catalogue.error} onRetry={catalogue.reload} />;
  if (!catalogue.data) return <ErrorState error={{ code: 'not_found' }} />;

  return (
    <PreviewBody
      catalogue={catalogue.data}
      permitType={permitType}
      mode={mode}
      asEditor={asEditor}
      permitId={permitId}
    />
  );
}

function PreviewBody({
  catalogue,
  permitType,
  mode,
  asEditor,
  permitId,
}: {
  catalogue: FormCatalogue;
  permitType: PermitTypeKey;
  mode: DocumentMode;
  asEditor: boolean;
  permitId: string;
}) {
  const definition = catalogue.permits[permitType];
  const [permitValues, setPermitValues] = useState<PermitValuesV2>(() =>
    emptyPermitValues(permitType, definition),
  );
  const [jsaValues, setJsaValues] = useState<JsaValuesV2>(() => emptyJsaValues(catalogue));

  // Fixed sample identity, so the authoritative band renders something to
  // inspect. These are display-only in every mode.
  const authoritative = useMemo(
    () => ({
      permitNumber: '729',
      applicantName: 'Ali Khan',
      applicantCompany: 'ZPL',
      jsaNumber: '3',
      completedBy: 'Ali Khan — Technician',
    }),
    [],
  );

  if (asEditor) {
    return (
      <div data-testid="form-preview">
        <PermitDraftEditor
          permitType={permitType}
          catalogue={catalogue}
          initialPermit={permitValues}
          initialJsa={jsaValues}
          initialVersion={1}
          authoritative={authoritative}
          onSaveDraft={async ({ version, permit, jsa }) => {
            // The permit and its JSA are one document, so both are saved
            // under the SAME optimistic-concurrency token; the second call
            // uses the version the first returned.
            const afterPermit = await saveV2PermitDraft(permitId, version, permit);
            const afterJsa = await saveV2JsaDraft(permitId, afterPermit.permit.version, jsa);
            return afterJsa.permit.version;
          }}
          onSubmit={async ({ version }) => {
            await submitPermit(permitId, version);
          }}
        />
      </div>
    );
  }

  return (
    <div className="stack" data-testid="form-preview">
      <PermitDocumentV2
        permitType={permitType}
        definition={definition}
        values={permitValues}
        mode={mode}
        onChange={setPermitValues}
        authoritative={authoritative}
      />
      <JsaDocumentV2
        definition={catalogue.jsa}
        values={jsaValues}
        mode={mode}
        onChange={setJsaValues}
        authoritative={authoritative}
      />
    </div>
  );
}
