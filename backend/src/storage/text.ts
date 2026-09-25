/** True when a string contains a C0 control character or DEL (tab and newline allowed only when requested). */
export function hasControlCharacters(value: string, allowWhitespace = false): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (allowWhitespace && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Removes C0 control characters and DEL. */
export function stripControlCharacters(value: string): string {
  return [...value].filter((char) => !hasControlCharacters(char)).join('');
}
