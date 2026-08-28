/**
 * THE SELECTION MARK.
 *
 * A selected checklist answer used to be printed as `×` - a small
 * multiplication sign. On a form whose whole purpose is "is this safe
 * to proceed", a cross beside an item reads as a FAILURE, and at 0.75rem
 * it was barely distinguishable from an empty box. The answer NO, ticked
 * in the NO column, looked identical to something being wrong.
 *
 * So the mark is a checkmark, and only ever a checkmark. It means "this
 * is the selected value" - not "yes", not "good". A NO answer gets a
 * checkmark in the NO column, exactly as a person ticks a paper form.
 *
 * WHY A VECTOR, NOT A GLYPH. `✓` is a font-dependent character: it can
 * arrive as a box, at the wrong weight, or as an emoji-coloured glyph
 * depending on the device and the installed fonts. This is drawn, so
 * every device draws the same shape.
 *
 * THE SHAPE CARRIES THE MEANING, not the colour. It stays a legible
 * checkmark in grayscale, in print, and to anyone who cannot distinguish
 * the mark's colour from black (WCAG 1.4.1). The colour is inherited
 * through `currentColor` from the tick box, which reads it from the
 * `--doc-mark` token - no component hard-codes it.
 *
 * Decorative: the selected/unselected state is already carried by the
 * surrounding labels and aria attributes, so the mark itself is hidden
 * from screen readers rather than announced twice.
 */
export function CheckMark() {
  return (
    <svg className="doc__check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.25 8.5 L6.5 11.75 L12.75 4.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
