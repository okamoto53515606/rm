// 顔検出プローブをヘッドレスで実行する。
//   node scripts/face-probe.mjs test-image-secret/20261110/IMG_1369.jpeg

import { chromium } from 'playwright-core';
import { BASE, ensureServer, launchBrowser, stopServer } from './test-images-lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('画像パスを指定してください');
  process.exit(1);
}
const server = await ensureServer();
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const tileArg = process.argv.find((a) => a.startsWith('--tile='))?.slice('--tile='.length) ?? '1024';
  await page.goto(
    `${BASE}/probe.html?file=${encodeURIComponent(file)}&tile=${tileArg}`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(() => window.__PROBE?.done === true, null, {
    timeout: 600_000,
    polling: 500,
  });
  const data = await page.evaluate(() => window.__PROBE);
  if (data.error) throw new Error(data.error);
  console.log(data.file);
  for (const r of data.out) {
    const sizes = r.boxes.map((b) => `${(b.w * 100).toFixed(1)}%`).join(', ');
    console.log(
      `  scale=${r.scale} threshold=${r.threshold} → ${r.count} 顔 / ${r.ms}ms  ${sizes ? `(幅: ${sizes})` : ''}`,
    );
  }
  for (const t of data.tiles ?? []) {
    const sizes = t.boxes.map((b) => `${(b.w * 100).toFixed(1)}%`).join(', ');
    console.log(
      `  tiles=${t.cols}x${t.rows} → ${t.count} 顔 / ${t.ms}ms  ${sizes ? `(幅: ${sizes})` : ''}`,
    );
  }} finally {
  await browser.close();
  stopServer(server);
}
