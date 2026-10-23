import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Emits sw.js with the full list of build outputs, so the PWA (iOS home
// screen) has every asset – including the MBTiles importer – offline after
// the first start.
function serviceWorker() {
  return {
    name: 'lpu5-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png',
        ...Object.keys(bundle).filter((f) => f !== 'index.html').map((f) => `./${f}`)];
      const version = createHash('sha1').update(files.join()).digest('hex').slice(0, 10);
      const src = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
        .replace('__PRECACHE__', JSON.stringify(files))
        .replace('__VERSION__', JSON.stringify(version));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

// base './' so the same build works inside Capacitor (Android/iOS) and when
// served by the LPU5 server under /eud/.
export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
  server: { host: true, port: 5173 },
});
