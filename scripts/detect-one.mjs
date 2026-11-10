// 1枚だけ検出を実行して結果を表示する（画像は表示しない）。
//   node scripts/detect-one.mjs test-image-secret/20261110/IMG_1369.jpeg
//   node scripts/detect-one.mjs test-image-secret/20261110/IMG_1369.jpeg --ollama
//   --model=lfm3-vl:2b --endpoint=http://localhost:11434 --refine

import { chromium } from 'playwright-core';
import { BASE, ensureServer, launchBrowser, stopServer } from './test-images-lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('画像パスを指定してください');
  process.exit(1);
}
const useOllama = args.includes('--ollama');
const refineFaces = args.includes('--refine');
const model = args.find((a) => a.startsWith('--model='))?.slice('--model='.length) ?? 'lfm3-vl:2b';
const endpoint =
  args.find((a) => a.startsWith('--endpoint='))?.slice('--endpoint='.length) ?? 'http://localhost:11434';
const server = await ensureServer();
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console]', msg.text());
  });
  await page.goto(`${BASE}/README.md`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const result = await page.evaluate(
    async ({ path, useOllama, model, endpoint, refineFaces }) => {
      const { detect } = await import('/src/detect.ts');
      const started = performance.now();
      try {
        const blob = await (await fetch(`/${path}`, { cache: 'no-store' })).blob();
        const raster = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        const messages = [];
        const detections = await detect(raster, {
          provider: useOllama ? 'ollama' : 'local',
          ocr: !useOllama,
          refineFaces,
          ollamaEndpoint: endpoint,
          ollamaModel: model,
          onProgress: (m) => messages.push(m),
        });
        const out = {
          width: raster.width,
          height: raster.height,
          ms: Math.round(performance.now() - started),
          detections: detections.map((d) => ({ category: d.category, label: d.label, box: d.box })),
          messages: messages.slice(-6),
        };
        raster.close();
        return out;
      } catch (err) {
        return {
          ms: Math.round(performance.now() - started),
          detections: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    { path: file, useOllama, model, endpoint, refineFaces },
  );
  console.log(file, useOllama ? `(Ollama: ${model})` : '(ブラウザ内)');
  if (result.error) {
    console.log(`  ERROR (${result.ms}ms): ${result.error}`);
  } else {
    console.log(`  ${result.width}x${result.height}  ${result.ms}ms  ${result.detections.length} 件`);
    for (const d of result.detections) {
      console.log(
        `  - ${d.category} / ${d.label}  [${[d.box.x, d.box.y, d.box.w, d.box.h].map((n) => n.toFixed(3)).join(', ')}]`,
      );
    }
  }
  for (const m of result.messages ?? []) console.log(`  ! ${m}`);
} finally {
  await browser.close();
  stopServer(server);
}
