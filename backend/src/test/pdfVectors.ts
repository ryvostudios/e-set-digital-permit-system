import { inflatePdfStreams } from './pdfText.js';

/**
 * Reading the SHAPES a rendered PDF actually draws.
 *
 * A vector checkmark is not text. Nothing in `pdfText.ts` can see it, and
 * a test that only asserts "the extracted text contains no X" would pass
 * just as happily against a document that draws nothing at all - the
 * extractor cannot see an X either. So the drawing commands themselves
 * are read here: the real content stream, inflated, parsed into the
 * stroked paths the renderer emitted, with the graphics state that was in
 * force when each was stroked.
 *
 * PDF coordinates as reported here are PDFKit's own: the origin is the
 * top-left of the page and Y INCREASES DOWNWARD, because PDFKit installs
 * a flip transform at the start of every page. That means the numbers
 * below are the same numbers the renderer passed in, which is what makes
 * a positioning assertion readable.
 */

export interface StrokedPath {
  /** The stroke colour in force, as `#rrggbb`, or null if the default was used. */
  color: string | null;
  lineWidth: number | null;
  /** The polyline's points, in the order they were drawn. */
  points: Array<{ x: number; y: number }>;
}

/** Below this, a "page" is not a page and an absence proves nothing. */
const MINIMUM_OPERATORS = 50;

function inflateContentStreams(pdf: Buffer): string[] {
  // Sliced by each stream's declared `/Length` - see pdfText.ts for why
  // searching for the `endstream` keyword silently loses a page.
  // Content streams contain operators; a font or an image does not.
  return inflatePdfStreams(pdf).filter((content) => /(^|\s)(re|m|l|S|TJ)(\s|$)/.test(content));
}

function toHex(component: number): string {
  return Math.round(component * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * Every polyline stroked on each page, in document order.
 *
 * Rectangles (`re`) are deliberately excluded: this exists to inspect
 * marks, and every cell border in the document is a rectangle.
 */
export function extractStrokedPaths(pdf: Buffer): StrokedPath[][] {
  const streams = inflateContentStreams(pdf);
  const pages: StrokedPath[][] = [];
  let totalOperators = 0;

  for (const content of streams) {
    const paths: StrokedPath[] = [];
    // Graphics state, with a q/Q stack, because the renderer saves and
    // restores around the mark it draws.
    let color: string | null = null;
    let lineWidth: number | null = null;
    const stack: Array<{ color: string | null; lineWidth: number | null }> = [];
    let points: Array<{ x: number; y: number }> = [];
    let sawRect = false;
    let inText = false;
    const operands: number[] = [];

    for (const match of content.matchAll(/(-?\d*\.?\d+)|([A-Za-z'"*]+)/g)) {
      if (match[1] !== undefined) {
        operands.push(Number(match[1]));
        continue;
      }
      const operator = match[2]!;
      totalOperators += 1;
      /*
        Text is skipped wholesale. PDFKit writes strings as hex, and a
        run of hex digits can contain a letter that looks exactly like a
        path operator (`f`, `b`, `c`...). Nothing between BT and ET draws
        a path, so ignoring it removes the ambiguity entirely.
      */
      if (operator === 'BT') inText = true;
      if (operator === 'ET') inText = false;
      if (inText) {
        operands.length = 0;
        continue;
      }
      switch (operator) {
        case 'q':
          stack.push({ color, lineWidth });
          break;
        case 'Q': {
          const restored = stack.pop();
          color = restored?.color ?? null;
          lineWidth = restored?.lineWidth ?? null;
          break;
        }
        case 'w':
          lineWidth = operands.at(-1) ?? null;
          break;
        // Stroking colour. PDFKit writes `/DeviceRGB CS` followed by
        // `r g b SCN` rather than the shorthand `RG`; both are accepted.
        // The lowercase forms are the FILL colour and are not a mark.
        case 'RG':
        case 'SC':
        case 'SCN': {
          const [r, g, b] = operands.slice(-3);
          color = r === undefined || g === undefined || b === undefined ? null : `#${toHex(r)}${toHex(g)}${toHex(b)}`;
          break;
        }
        case 'm':
        case 'l': {
          const [x, y] = operands.slice(-2);
          if (x !== undefined && y !== undefined) points.push({ x, y });
          break;
        }
        case 're':
          sawRect = true;
          break;
        case 'S':
        case 's':
          // A rectangle's own stroke is not a mark.
          if (points.length >= 2 && !sawRect) paths.push({ color, lineWidth, points });
          points = [];
          sawRect = false;
          break;
        case 'f':
        case 'F':
        case 'f*':
        case 'B':
        case 'b':
        case 'n':
          points = [];
          sawRect = false;
          break;
        default:
          break;
      }
      operands.length = 0;
    }
    pages.push(paths);
  }

  if (totalOperators < MINIMUM_OPERATORS) {
    throw new Error(
      `extractStrokedPaths read only ${totalOperators} operators - assertions against this would be vacuous`,
    );
  }
  return pages;
}

/**
 * Does this polyline read as a checkmark?
 *
 * Three points, drawn left to right, whose middle point is the lowest:
 * a short stroke down-and-right into the vertex, then a longer stroke
 * up-and-right, rising above where it started. An X fails every part of
 * this - it is two separate two-point strokes that cross - and so does a
 * tick drawn backwards or a stray line.
 */
export function readsAsCheckmark(path: StrokedPath): boolean {
  if (path.points.length !== 3) return false;
  const [start, vertex, end] = path.points as [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  const strictlyRightward = start.x < vertex.x && vertex.x < end.x;
  const vertexIsLowest = vertex.y > start.y && vertex.y > end.y;
  const longArmRisesHigher = end.y < start.y;
  const longArmIsLonger = end.x - vertex.x > vertex.x - start.x;
  return strictlyRightward && vertexIsLowest && longArmRisesHigher && longArmIsLonger;
}

/** The horizontal centre of a mark, for asserting which column it landed in. */
export function centreOf(path: StrokedPath): { x: number; y: number } {
  const xs = path.points.map((point) => point.x);
  const ys = path.points.map((point) => point.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}
