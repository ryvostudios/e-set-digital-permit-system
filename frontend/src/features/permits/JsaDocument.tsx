import type { Jsa } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import {
  BooleanTickList,
  ChecklistTable,
  DescriptionTable,
  DocumentField,
  DocumentSection,
  FieldGrid,
  TickList,
} from './DocumentParts';
import './paper.css';

/**
 * The Job Safety Analysis, rendered as the second half of the same
 * controlled document - the same masthead treatment, section numbering
 * and grid, so Permit and JSA read as one record rather than two
 * unrelated screens.
 *
 * WORDING IS NEVER INVENTED. Every checklist question, hazard, and PPE
 * option comes from the stored payload as the person entered it; this
 * component supplies structure and headings only. The JSA's completed-by
 * identity is likewise not shown here as a signature - it lives in the
 * permit's own signature block, produced by the authenticated submission.
 */
export function JsaDocument({ jsa }: { jsa: Jsa }) {
  const form = jsa.form_payload;

  return (
    <article className="doc">
      <header className="doc__masthead">
        <div>
          <p className="doc__issuer">E-SET · Permit to Work</p>
          <p className="doc__title">Job Safety Analysis</p>
        </div>
        <dl className="doc__refs">
          <dt>JSA No.</dt>
          <dd>{jsa.jsaDisplayNumber}</dd>
          <dt>Form</dt>
          <dd>{jsa.form_version ?? '—'}</dd>
        </dl>
      </header>

      {!form ? (
        <DocumentSection number="1" title="Job information">
          <p className="muted">
            This Job Safety Analysis has not been completed yet. A permit cannot be submitted until it is.
          </p>
        </DocumentSection>
      ) : (
        <>
          <DocumentSection number="1" title="Job information">
            <FieldGrid>
              <DocumentField label="Site / WTG" value={form.page1.siteOrWtg} strong />
              <DocumentField label="Job or work" value={form.page1.jobOrWork} full />
            </FieldGrid>
            <BooleanTickList
              label="Permits required for this job"
              entries={[
                { label: 'WTG work', value: form.page1.requiredPermits.wtgWork },
                { label: 'Cold work', value: form.page1.requiredPermits.coldWork },
                { label: 'Hot work', value: form.page1.requiredPermits.hotWork },
                { label: 'Confined space entry', value: form.page1.requiredPermits.confinedSpaceEntry },
              ]}
            />
          </DocumentSection>

          <DocumentSection number="2" title="HSE checklist">
            {form.page1.hseChecklistGroups.map((group, index) => (
              <div key={`${group.title}-${index}`}>
                <p className="doc__field-label" style={{ marginBottom: 'var(--space-2)' }}>
                  {group.title}
                </p>
                <ChecklistTable caption={group.title} items={group.items} />
              </div>
            ))}
          </DocumentSection>

          <DocumentSection number="3" title="Task analysis">
            <table className="doc__grid">
              <caption className="sr-only">Task analysis</caption>
              <thead>
                <tr>
                  <th scope="col">Sequence of tasks</th>
                  <th scope="col">Possible hazardous events</th>
                  <th scope="col">Energy or triggering sources</th>
                  <th scope="col">Protective actions or measures</th>
                </tr>
              </thead>
              <tbody>
                {form.page2.taskAnalysis.map((row, index) => (
                  <tr key={index}>
                    <td data-label="Sequence of tasks">{row.sequenceOfTasks}</td>
                    <td data-label="Possible hazardous events">{row.possibleHazardousEvents}</td>
                    <td data-label="Energy or triggering sources">{row.energyOrTriggeringSources}</td>
                    <td data-label="Protective actions or measures">{row.protectiveActionsOrMeasures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DocumentSection>

          <DocumentSection number="4" title="Protective equipment, tools and materials">
            <TickList label="Personal protective equipment" options={form.page2.ppe} />
            <DescriptionTable caption="Tools and materials" rows={form.page2.toolsAndMaterials} />
          </DocumentSection>

          <DocumentSection number="5" title="Crew" note="Crew on the job as written on the form — not signers">
            {form.page2.participants.length === 0 ? (
              <p className="muted text-sm">No crew members recorded.</p>
            ) : (
              <table className="doc__grid">
                <caption className="sr-only">Crew</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Company</th>
                  </tr>
                </thead>
                <tbody>
                  {form.page2.participants.map((participant, index) => (
                    <tr key={`${participant.name}-${index}`}>
                      <td data-label="Name">{participant.name}</td>
                      <td data-label="Company">{participant.company ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {form.page2.participantAcknowledgements.length > 0 ? (
              <table className="doc__grid">
                <caption className="sr-only">Crew acknowledgements</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Acknowledged</th>
                    <th scope="col">Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {form.page2.participantAcknowledgements.map((entry, index) => (
                    <tr key={`${entry.name}-${index}`}>
                      <td data-label="Name">{entry.name}</td>
                      <td data-label="Acknowledged">
                        <span className={`doc__response doc__response--${entry.acknowledged ? 'YES' : 'NO'}`}>
                          {entry.acknowledged ? 'YES' : 'NO'}
                        </span>
                      </td>
                      <td data-label="Remarks">{entry.remarks ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </DocumentSection>

          <DocumentSection number="6" title="Emergency response, comments and close-out">
            <FieldGrid>
              <DocumentField label="Emergency response" value={form.page2.emergencyResponse ?? ''} full />
              <DocumentField label="Comments" value={form.page2.comments ?? ''} full />
              <DocumentField
                label="Close-out completed"
                value={form.page2.closeOut?.completedAt ? formatDateTime(form.page2.closeOut.completedAt) : ''}
              />
              <DocumentField label="Close-out remarks" value={form.page2.closeOut?.remarks ?? ''} full />
            </FieldGrid>
          </DocumentSection>
        </>
      )}
    </article>
  );
}
