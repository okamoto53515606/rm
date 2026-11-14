// マスクが実際に描画されているかをピクセルで確認する（回帰チェック）。
//   node scripts/check-mask.mjs test-image-secret/IMG_0191.jpeg --browser=webkit
//   --base=http://127.0.0.1:4311
//
// 矩形を1つ描いて、描く前後のキャンバスを比べる。
// ctx.filter が効かない環境で「元画像で上書きされてマスクが消える」不具合の検出用。

import { chromium, firefox, webkit } from 'playwright-core';
import { launchBrowser } from './test-images-lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const engineName =
  args.find((a) => a.startsWith('--browser='))?.slice('--browser='.length) ?? 'chromium';
const base =
  args.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? 'http://127.0.0.1:4311';
const engine = { chromium, firefox, webkit }[engineName];
if (!file || !engine) {
  console.error('usage: node scripts/check-mask.mjs <image> --browser=chromium|firefox|webkit --base=URL');
  process.exit(1);
}

const browser =
  engineName === 'chromium' ? await launchBrowser(chromium) : await engine.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto(base, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', file);
  await page.waitForFunction(() => document.querySelector('.canvas-host canvas') !== null, null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(800);

  // フィルタ対応の実測値
  const filterOk = await page.evaluate(() => {
    const src = document.createElement('canvas');
    src.width = 16;
    src.height = 1;
    const s = src.getContext('2d');
    s.fillStyle = '#fff';
    s.fillRect(0, 0, 8, 1);
    s.fillStyle = '#000';
    s.fillRect(8, 0, 8, 1);
    const out = document.createElement('canvas');
    out.width = 16;
    out.height = 1;
    const o = out.getContext('2d', { willReadFrequently: true });
    o.filter = 'blur(3px)';
    o.drawImage(src, 0, 0);
    return o.getImageData(8, 0, 1, 1).data[0];
  });

  await page.evaluate(() => {
    const c = document.querySelector('.canvas-host canvas');
    window.__before = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  });

  // 矩形ツールでマスクを1つ描く（既定の「モザイク＋ぼかし」）
  await page.click('[data-tool="rect"]');
  const box = await page.locator('.canvas-host').boundingBox();
  const x0 = box.x + box.width * 0.35;
  const y0 = box.y + box.height * 0.35;
  const x1 = box.x + box.width * 0.65;
  const y1 = box.y + box.height * 0.65;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const stat = await page.evaluate(() => {
    const c = document.querySelector('.canvas-host canvas');
    const after = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const before = window.__before;
    let changed = 0;
    let maxDiff = 0;
    let sumDiff = 0;
    for (let i = 0; i < before.data.length; i += 4) {
      const d =
        Math.abs(before.data[i] - after.data[i]) +
        Math.abs(before.data[i + 1] - after.data[i + 1]) +
        Math.abs(before.data[i + 2] - after.data[i + 2]);
      if (d > 8) changed += 1;
      if (d > maxDiff) maxDiff = d;
      sumDiff += d;
    }
    return {
      pixels: before.data.length / 4,
      changed,
      changedPct: Math.round((changed / (before.data.length / 4)) * 1000) / 10,
      maxDiff,
      avgDiff: Math.round((sumDiff / (before.data.length / 4)) * 10) / 10,
      masks: document.querySelectorAll('.canvas-host canvas').length,
    };
  });

  console.log(`[${engineName}] ${file}`);
  console.log(`  ctx.filter blur probe: ${filterOk} (0 = フィルタ無効)`);
  console.log(`  変更されたピクセル: ${stat.changed} / ${stat.pixels} (${stat.changedPct}%)`);
  console.log(`  最大差分: ${stat.maxDiff} / 平均: ${stat.avgDiff}`);
  const ok = stat.changed > stat.pixels * 0.02;
  console.log(`  判定: ${ok ? 'マスクが描画されている' : 'マスクが描画されていない（要修正）'}`);
  for (const e of errors.slice(0, 4)) console.log(`  x ${e.slice(0, 160)}`);
  if (!ok) process.exitCode = 2;
} finally {
  await browser.close();
}
