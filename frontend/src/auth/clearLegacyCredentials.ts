/** One-way cleanup of the retired browser credential store. Never reads token values. */
export function clearLegacyCredentials(): void {
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[kind];
      for (const key of Object.keys(storage)) {
        if (/^sb-.+-auth-token$/.test(key) || key === 'eset.auth.remember') storage.removeItem(key);
      }
    } catch { /* Browser storage may be unavailable. Cookie auth does not depend on it. */ }
  }
}
