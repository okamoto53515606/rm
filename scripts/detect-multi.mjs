// ブラウザ差の切り分け用: 実際の画面を操作して 1 枚を検出する。
//   node scripts/detect-multi.mjs test-image-secret/IMG_0191.jpeg --browser=firefox
//   --browser=chromium | firefox | webkit
//   --base=http://127.0.0.1:4311 （省略時は http://localhost:5173）
//
// dist を静的配信して比べる場合は、先に
//   (cd dist && python3 -m http.server 4311 --bind 127.0.0.1 &)
// などで配信しておく。画像の内容（OCR の文字列）は表示しない。

import { chromium, firefox, webkit } from 'playwright-core';
import { launchBrowser } from './test-images-lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('画像パスを指定してください');
  process.exit(1);
}
const engineName =
  args.find((a) => a.startsWith('--browser='))?.slice('--browser='.length) ?? 'chromium';
const base =
  args.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? 'http://localhost:5173';
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) {
  console.error(`未対応のブラウザ: ${engineName}`);
  process.exit(1);
}

const browser =
  engineName === 'chromium'
    ? await launchBrowser(chromium)
    : await engine.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', file);
  await page.waitForTimeout(1500);
  await page.check('#chkLocalOcr');
  await page.click('#btnDetectCurrent');

  await page.waitForFunction(
    () => {
      const s = document.querySelector('#statusText')?.textContent ?? '';
      return s.includes('検出が完了') || s.includes('できません') || s.includes('エラー');
    },
    { timeout: 180_000 },
  );

  const result = await page.evaluate(() => ({
    status: document.querySelector('#statusText')?.textContent,
    detail: document.querySelector('#detectStatus')?.textContent,
    items: [...document.querySelectorAll('.photo-item')].map((li) =>
      li.querySelector('.sub')?.textContent?.trim(),
    ),
    ua: navigator.userAgent,
  }));

  console.log(`[${engineName}] ${file}`);
  console.log(`  UA: ${result.ua}`);
  console.log(`  status: ${result.status}`);
  console.log(`  detail: ${result.detail}`);
  console.log(`  写真: ${JSON.stringify(result.items)}`);
  for (const e of errors.slice(0, 8)) console.log(`  x ${e.slice(0, 220)}`);
} finally {
  await browser.close();
}
