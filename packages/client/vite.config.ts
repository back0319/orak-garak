import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare({ configPath: '../../wrangler.jsonc' })],
  resolve: {
    alias: {
      '@main-game/common': path.resolve(__dirname, '../common/src'),
    },
  },
});
