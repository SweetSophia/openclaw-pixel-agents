import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { randomBytes } from 'node:crypto';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    // Development assets remain revalidatable; every production build gets a new URL.
    __ASSET_BUILD_ID__: JSON.stringify(command === 'build' ? randomBytes(16).toString('hex') : ''),
  },
  build: {
    outDir: 'dist/client',
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
}));
