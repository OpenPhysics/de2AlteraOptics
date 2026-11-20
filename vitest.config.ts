import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests never start the serial bridge.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
