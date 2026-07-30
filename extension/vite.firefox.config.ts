import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const extensionRoot = __dirname;

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    {
      name: 'kikiweb-firefox-manifest',
      closeBundle() {
        const outputDirectory = resolve(extensionRoot, 'dist-firefox');
        copyFileSync(
          resolve(extensionRoot, 'firefox/manifest.json'),
          resolve(outputDirectory, 'manifest.json'),
        );
        copyFileSync(
          resolve(extensionRoot, 'firefox/background.js'),
          resolve(outputDirectory, 'background.js'),
        );
      },
    },
  ],
  define: {
    'import.meta.env.VITE_BROWSER_LABEL': JSON.stringify('Firefox Sidebar'),
  },
  build: {
    outDir: 'dist-firefox',
    emptyOutDir: true,
  },
});
