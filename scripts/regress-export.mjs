// 検出→書き出しの通し回帰テスト。
//   1 枚ずつアプリに読み込み、OCR を ON にして検出し、マスクして保存する。
//   保存した JPEG を元画像と比べ、マスクが焼き込まれているか（差分が出ているか）を確認する。
//
//   node scripts/regress-export.mjs --browser=chromium --base=http://127.0.0.1:4311
//   node scripts/regress-export.mjs --browser=webkit --only=IMG_0191
//
// 画像の内容は表示しない。出力は件数と差分の割合のみ。

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright-core';
import { ROOT, launchBrowser } from './test-images-lib.mjs';

const args = process.argv.slice(2);
const engineName =
  args.find((a) => a.startsWith('--browser='))?.slice('--browser='.length) ?? 'chromium';
const base =
  args.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? 'http://127.0.0.1:4311';
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? '';
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) {
  console.error(`未対応のブラウザ: ${engineName}`);
  process.exit(1);
}

const SECRET_DIR = path.join(ROOT, 'test-image-secret');
const OUT_DIR = path.join(SECRET_DIR, 'eval-out', 'export');
mkdirSync(OUT_DIR, { recursive: true });

function collectFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'eval-out') continue;
      collectFiles(full, acc);
    } else if (/\.(jpe?g|png)$/i.test(name)) {
      if (!only || name.includes(only)) acc.push(full);
    }
  }
  return acc;
}

const files = collectFiles(SECRET_DIR).sort();
if (!files.length) {
  console.error('画像が見つかりません');
  process.exit(1);
}

const browser =
  engineName === 'chromium'
    ? await launchBrowser(chromium)
    : await engine.launch({ headless: true });

const rows = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });

  for (const file of files) {
    const name = path.basename(file);
    const started = Date.now();
    const row = { name, detected: '−', detail: '', export: '−', masked: '−', diff: '' };

    try {
      await page.goto(base, { waitUntil: 'load' });
      await page.setInputFiles('#fileInput', file);
      await page.waitForFunction(
        () => (document.querySelector('#photoCount')?.textContent ?? '').startsWith('1'),
        null,
        { timeout: 60_000 },
      );
      await page.check('#chkLocalOcr');
      await page.click('#btnDetectCurrent');
      await page.waitForFunction(
        () => {
          const s = document.querySelector('#statusText')?.textContent ?? '';
          return s.includes('検出が完了') || s.includes('できません') || s.includes('エラー');
        },
        null,
        { timeout: 180_000 },
      );

      row.detail = (await page.textContent('#detectStatus')) ?? '';
      const masks = await page
        .evaluate(() => document.querySelector('.photo-item .sub')?.textContent?.trim() ?? '')
        .catch(() => '');
      row.detected = masks.replace(/\s*か所$/, '') || '0';

      const count = Number.parseInt(row.detected, 10) || 0;
      if (count > 0) {
        await page.click('#btnExport');
        await page.waitForTimeout(400);
        const dialogVisible = await page
          .locator('#confirmDialog')
          .isVisible()
          .catch(() => false);
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 120_000 }),
          dialogVisible ? page.click('#confirmOk') : Promise.resolve(),
        ]);
        const saved = path.join(OUT_DIR, `${path.parse(name).name}.${engineName}.jpg`);
        await download.saveAs(saved);
        row.export = 'jpg';

        // 元画像と書き出し結果を同じ大きさで描いて比べる
        const diff = await compareInPage(page, file, saved);
        row.diff = `${diff.pct.toFixed(2)}% / block ${diff.blockMax.toFixed(0)}`;
        row.masked = diff.pct >= 0.5 || diff.blockMax >= 20 ? 'OK' : 'NG（差分なし）';
      }
    } catch (err) {
      row.detail = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    row.ms = Date.now() - started;
    rows.push(row);
    console.log(
      `${row.name.padEnd(26)} 検出 ${String(row.detected).padStart(2)}  書出 ${row.export.padEnd(3)}  ` +
        `マスク ${row.masked.padEnd(12)} 差分 ${String(row.diff).padStart(16)}  ${Math.round(row.ms / 100) / 10}s`,
    );
    if (row.detail.startsWith('ERROR')) console.log(`    ${row.detail.slice(0, 200)}`);
  }
} finally {
  await browser.close();
}

const ng = rows.filter((r) => r.masked.startsWith('NG'));
const err = rows.filter((r) => r.detail.startsWith('ERROR'));
console.log('');
console.log(`画像 ${rows.length} 枚 / 書き出し ${rows.filter((r) => r.export === 'jpg').length} 件`);
console.log(`マスク未反映 ${ng.length} 件 / エラー ${err.length} 件`);
if (ng.length) console.log(`  未反映: ${ng.map((r) => r.name).join(', ')}`);
if (err.length) console.log(`  エラー: ${err.map((r) => r.name).join(', ')}`);

// ===== helpers =====

async function compareInPage(page, originalPath, exportedPath) {
  await page.setContent('<input id="cmpA" type="file"><input id="cmpB" type="file"><canvas id="cmpC"></canvas>');
  await page.setInputFiles('#cmpA', originalPath);
  await page.setInputFiles('#cmpB', exportedPath);
  return page.evaluate(async () => {
    const read = (id) =>
      new Promise((resolve, reject) => {
        const f = document.getElementById(id).files[0];
        if (!f) return reject(new Error('file missing'));
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('read error'));
        r.readAsDataURL(f);
      });
    const load = (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode error'));
        img.src = src;
      });

    const [a, b] = await Promise.all([read('cmpA'), read('cmpB')]);
    const [imgA, imgB] = await Promise.all([load(a), load(b)]);
    // 縮小しすぎると「ぼかし」の差が平均化されて消えるため、大きめで比べる
    const W = 800;
    const H = Math.max(1, Math.round((W * imgA.height) / imgA.width));
    const draw = (img) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const da = draw(imgA);
    const db = draw(imgB);
    const diffAt = (i) =>
      (Math.abs(da[i] - db[i]) +
        Math.abs(da[i + 1] - db[i + 1]) +
        Math.abs(da[i + 2] - db[i + 2])) /
      3;

    let big = 0;
    let sum = 0;
    const n = W * H;
    for (let i = 0; i < da.length; i += 4) {
      const d = diffAt(i);
      sum += d;
      if (d > 40) big += 1;
    }

    // ブロック単位の平均差の最大値（JPEG の再エンコードノイズでは大きくならない）
    const B = 40;
    let blockMax = 0;
    for (let by = 0; by + B <= H; by += B) {
      for (let bx = 0; bx + B <= W; bx += B) {
        let s = 0;
        for (let y = by; y < by + B; y += 1) {
          for (let x = bx; x < bx + B; x += 1) {
            s += diffAt((y * W + x) * 4);
          }
        }
        const m = s / (B * B);
        if (m > blockMax) blockMax = m;
      }
    }
    return { pct: (big / n) * 100, mean: sum / n, blockMax };
  });
}
