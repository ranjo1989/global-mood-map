import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // Required so the SSE stream at /api/stream proxies correctly.
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Don't ship original TS source to production — flip on locally when
    // debugging a build.
    sourcemap: false,
  },
});
