import { defineConfig } from 'vite';
import * as pkg from './package.json';

export default defineConfig({
  base: './',
  plugins: [
    {
      // package.json の version を HTML に埋め込む（フッターの表記に使う）
      name: 'inject-app-version',
      transformIndexHtml(html: string) {
        return html.replaceAll('__APP_VERSION__', `v${pkg.version}`);
      },
    },
  ],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
  },
});
