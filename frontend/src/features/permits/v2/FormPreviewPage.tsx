import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getFormCatalogue, type FormCatalogue, type PermitTypeKey } from '../../../api/catalogue';
import { useApiResource } from '../../../lib/useApiResource';
import { ErrorState, LoadingState } from '../../../ui/Feedback';
import { JsaDocumentV2 } from './JsaDocumentV2';
import { PermitDocumentV2 } from './PermitDocumentV2';
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

  const catalogue = useApiResource<FormCatalogue>((signal) => getFormCatalogue(signal), []);

  if (catalogue.initialLoading) return <LoadingState label="Loading form definition" />;
  if (catalogue.error) return <ErrorState error={catalogue.error} onRetry={catalogue.reload} />;
  if (!catalogue.data) return <ErrorState error={{ code: 'not_found' }} />;

  return <PreviewBody catalogue={catalogue.data} permitType={permitType} mode={mode} />;
}

function PreviewBody({
  catalogue,
  permitType,
  mode,
}: {
  catalogue: FormCatalogue;
  permitType: PermitTypeKey;
  mode: DocumentMode;
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
