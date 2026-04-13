import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (
            id.includes('/antd/es/steps') ||
            id.includes('/antd/es/progress') ||
            id.includes('/antd/es/result') ||
            id.includes('/antd/es/radio') ||
            id.includes('/antd/es/descriptions') ||
            id.includes('/antd/es/slider') ||
            id.includes('/antd/es/alert') ||
            id.includes('/rc-steps/') ||
            id.includes('/rc-progress/') ||
            id.includes('/rc-slider/')
          ) {
            return 'ui-settings-vendor';
          }
          if (id.includes('/antd/') || id.includes('/rc-') || id.includes('@ant-design/icons')) {
            return 'ui-vendor';
          }
          if (
            id.includes('react-markdown') ||
            id.includes('remark-gfm') ||
            id.includes('micromark') ||
            id.includes('mdast') ||
            id.includes('remark-')
          ) {
            return 'markdown-vendor';
          }
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react-vendor';
          if (id.includes('@tauri-apps')) return 'tauri-vendor';
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
