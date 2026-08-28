import type { ReactNode } from 'react';
import type { FormCatalogue, PermitTypeKey } from '../../../api/catalogue';
import type { Jsa, Permit, PermitSignature } from '../../../api/types';
import type { ApiResource } from '../../../lib/useApiResource';
import { ErrorState, LoadingState } from '../../../ui/Feedback';
import { DocumentSection, SignatureBlock } from '../DocumentParts';
import { JsaDocumentV2 } from './JsaDocumentV2';
import { PermitDocumentV2 } from './PermitDocumentV2';
import { hydrateJsaValuesV2, hydratePermitValuesV2 } from './values';

/**
 * A V2 record, READ-ONLY.
 *
 * Everything a V2 permit is that is not "a draft its owner may edit"
 * lands here: a draft someone else is looking at, one under CRO or HSE
 * review, an issued permit, a closed one. Until now all of those fell
 * through to the V1 renderers, which read a V1 payload's arrays
 * (`form.generalWork.length`) off a V2 payload that has no such key and
 * took the whole record screen blank.
 *
 * SAME DOCUMENT, SAME COMPONENTS, DIFFERENT MODE. This draws the exact
 * components the applicant filled in - `PermitDocumentV2` and
 * `JsaDocumentV2` in `read` mode - so what a reviewer sees is
 * structurally the same paperwork the applicant completed rather than a
 * second design that happens to look similar. It is also why no wording
 * appears in this file: every question comes from the catalogue.
 *
 * THE STORED PAYLOAD IS HYDRATED FIRST. A partly completed permit is a
 * legitimate thing to store, and an older record may predate a catalogue
 * addition, so a stored payload routinely lacks keys the renderers walk.
 * Hydration supplies the missing CONTAINERS and never an answer - see
 * values.ts.
 */

/** Loading and failure handling for the catalogue a V2 document is drawn from. */
function WithCatalogue({
  catalogue,
  children,
}: {
  catalogue: ApiResource<FormCatalogue>;
  children: (data: FormCatalogue) => ReactNode;
}) {
  if (catalogue.initialLoading) return <LoadingState label="Loading the permit form" />;
  if (catalogue.error) return <ErrorState error={catalogue.error} onRetry={catalogue.reload} />;
  if (!catalogue.data) return <ErrorState error={{ code: 'not_found' }} />;
  return <>{children(catalogue.data)}</>;
}

export function V2PermitRecord({
  permit,
  jsa,
  signatures,
  catalogue,
}: {
  permit: Permit;
  jsa: Jsa;
  signatures: PermitSignature[];
  catalogue: ApiResource<FormCatalogue>;
}) {
  return (
    <WithCatalogue catalogue={catalogue}>
      {(data) => {
        const permitType = permit.permit_type as PermitTypeKey | null;
        const definition = permitType ? data.permits[permitType] : undefined;
        if (!permitType || !definition) return <ErrorState error={{ code: 'not_found' }} />;

        return (
          <>
            {!permit.form_payload ? (
              <p className="muted">This permit has not been filled in yet.</p>
            ) : null}
            <PermitDocumentV2
              permitType={permitType}
              definition={definition}
              values={hydratePermitValuesV2(permitType, definition, permit.form_payload)}
              mode="read"
              authoritative={{
                // Server-frozen record columns, read and never re-derived.
                permitNumber: permit.permitDisplayNumber,
                applicantName: permit.applicant_display_name ?? '',
                applicantCompany: permit.applicant_company_name ?? '',
                jsaNumber: jsa.jsaDisplayNumber,
              }}
            />
            {/*
              The document's own authorization bands print the roles the
              form carries. WHO ACTUALLY SIGNED, and when, is record data
              rather than form content, so it is shown here from
              `permit_signatures` - the same block the V1 record shows.
            */}
            <DocumentSection
              number="A"
              title="Authorizations"
              note="Digital signatures, frozen at the time of each action"
            >
              <SignatureBlock signatures={signatures} />
            </DocumentSection>
          </>
        );
      }}
    </WithCatalogue>
  );
}

export function V2JsaRecord({
  permit,
  jsa,
  catalogue,
}: {
  permit: Permit;
  jsa: Jsa;
  catalogue: ApiResource<FormCatalogue>;
}) {
  return (
    <WithCatalogue catalogue={catalogue}>
      {(data) => (
        <>
          {!jsa.form_payload ? (
            <p className="muted">
              This Job Safety Analysis has not been completed yet. A permit cannot be submitted until it is.
            </p>
          ) : null}
          <JsaDocumentV2
            definition={data.jsa}
            values={hydrateJsaValuesV2(data, jsa.form_payload)}
            mode="read"
            authoritative={{
              jsaNumber: jsa.jsaDisplayNumber,
              // The applicant the SERVER froze onto the permit at
              // submission - never a live profile lookup.
              completedBy: permit.applicant_display_name ?? '',
            }}
          />
        </>
      )}
    </WithCatalogue>
  );
}
