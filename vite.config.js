import { defineConfig } from 'vite';
import { resolve } from 'path';

// マルチページ: 「寿命の樹」(index.html) と「設備の森」(garden.html)。
// vite dev は両 .html を自動配信。vite build は両エントリを出力し three を共有チャンク化。
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        garden: resolve(import.meta.dirname, 'garden.html'),
      },
    },
  },
});
