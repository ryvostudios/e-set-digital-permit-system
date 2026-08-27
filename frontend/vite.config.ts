import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite build/dev configuration. The test runner is configured separately
// in vitest.config.ts so this file stays a plain Vite config.
export default defineConfig({
  plugins: [react()],
});
