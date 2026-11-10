// 合成テスト画像を test-image-secret/synthetic/ に生成する。
// 描画位置がそのまま正解矩形になるので、精度を自動採点できる。

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BASE, ROOT, ensureServer, launchBrowser, stopServer } from './test-images-lib.mjs';

const OUT_DIR = path.join(ROOT, 'test-image-secret', 'synthetic');

const server = await ensureServer();
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(`${BASE}/gen.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GEN_READY === true, null, { timeout: 30_000 });
  const items = await page.evaluate(() => window.__generate());

  mkdirSync(OUT_DIR, { recursive: true });
  for (const item of items) {
    const base64 = String(item.png).split(',')[1] ?? '';
    writeFileSync(path.join(ROOT, item.file), Buffer.from(base64, 'base64'));
    console.log(`生成: ${item.file} (${item.gt.length} 個の正解)`);
  }
  const dataset = { images: items.map(({ png: _png, ...rest }) => rest) };
  writeFileSync(path.join(OUT_DIR, 'dataset.json'), JSON.stringify(dataset, null, 2) + '\n');
  console.log(`\n${items.length} 枚を生成しました: ${OUT_DIR}`);
} finally {
  await browser.close();
  stopServer(server);
}
