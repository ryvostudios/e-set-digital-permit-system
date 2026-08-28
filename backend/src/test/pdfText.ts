import { inflateSync } from 'node:zlib';

/**
 * Reading what a rendered PDF actually SAYS.
 *
 * Assertions about a document have to run against the real production
 * bytes, not against the model that produced them - otherwise a renderer
 * can drop, duplicate or mangle content and every test still passes.
 *
 * Three things make that harder than it looks, and all three have already
 * caused a silently-vacuous test in this codebase:
 *
 *   * PDFKit DEFLATES its content streams, so scanning the raw buffer for
 *     text finds nothing at all.
 *   * It writes text with the ARRAY operator and, because it embeds and
 *     subsets the font, as HEX strings - `[<452d534554> -12 <...>] TJ` -
 *     not as `(...) Tj` literals.
 *   * Compressed bytes are arbitrary binary and can contain the literal
 *     sequence `\nendstream` by chance. Slicing a stream by searching for
 *     that keyword then cuts it short, inflation fails, and the page is
 *     dropped without a word - which is how a whole page of a Cold Work
 *     document once went missing from these results, making "this text is
 *     absent" true for entirely the wrong reason.
 *
 * So every stream is sliced by its DECLARED length, inflated, both string
 * forms are decoded, and the helpers below REFUSE to return a
 * suspiciously empty result. A test that asserts "this text is absent"
 * must not be able to pass because nothing was read.
 */

/** Below this, a "document" is not a document and an absence proves nothing. */
const MINIMUM_RECOVERED_CHARACTERS = 200;

/**
 * Every deflated stream in the file, inflated.
 *
 * The stream dictionary states the byte count. It is authoritative, and
 * it is what is used; the `endstream` keyword is only a fallback for a
 * stream that declares no length.
 */
export function inflatePdfStreams(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const streams: string[] = [];
  for (const match of raw.matchAll(/(?<!end)stream\r?\n/g)) {
    const start = match.index! + match[0].length;
    // The `/Length n` entry belongs to the dictionary immediately before
    // this stream keyword.
    const dictionary = raw.slice(Math.max(0, match.index! - 400), match.index!);
    const declared = [...dictionary.matchAll(/\/Length (\d+)/g)].at(-1);
    const end = declared ? start + Number(declared[1]) : raw.indexOf('endstream', start);
    try {
      streams.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // Not a deflated stream (a font, an image): nothing to read.
    }
  }
  return streams;
}

function decodeTextOperators(content: string): string {
  return [...content.matchAll(/\[((?:[^[\]\\]|\\.)*)\]\s*TJ/g)]
    .map((operand) =>
      [...operand[1]!.matchAll(/<([0-9a-fA-F\s]*)>|\((?:\\.|[^\\()])*\)/g)]
        .map((chunk) =>
          chunk[1] === undefined
            ? chunk[0].slice(1, -1).replace(/\\([()\\])/g, '$1')
            : Buffer.from(chunk[1].replace(/\s+/g, ''), 'hex').toString('latin1'),
        )
        .join(''),
    )
    .join('\n');
}

/** Every page's text, in document order. Pages with no text at all are kept, so indexes line up. */
export function extractPdfPages(pdf: Buffer): string[] {
  const pages = inflatePdfStreams(pdf).map(decodeTextOperators);
  const recovered = pages.join('').length;
  if (recovered < MINIMUM_RECOVERED_CHARACTERS) {
    throw new Error(
      `extractPdfPages recovered only ${recovered} characters - assertions against this would be vacuous`,
    );
  }
  return pages;
}

/** The whole document's text. */
export function extractPdfText(pdf: Buffer): string {
  return extractPdfPages(pdf).join('\n');
}
