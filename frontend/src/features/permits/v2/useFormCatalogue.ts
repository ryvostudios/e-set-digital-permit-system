import { getFormCatalogue, type FormCatalogue } from '../../../api/catalogue';
import { useApiResource, type ApiResource } from '../../../lib/useApiResource';

/**
 * THE authoritative form catalogue, for any screen that draws a V2
 * document.
 *
 * One hook rather than a `getFormCatalogue` call written out per screen:
 * the printed wording, the sections and their order all live on the
 * server, and every V2 renderer must be looking at the same projection
 * of it. A second fetch written slightly differently somewhere else is
 * how two screens start disagreeing about what the form says.
 *
 * `enabled` exists because a V1 record must not pay for a catalogue it
 * will never draw from - the legacy documents render entirely from their
 * own stored payload.
 */
export function useFormCatalogue(options: { enabled?: boolean } = {}): ApiResource<FormCatalogue> {
  return useApiResource<FormCatalogue>((signal) => getFormCatalogue(signal), [], options);
}
