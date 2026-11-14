// OGP 画像（1200x630）を生成する。
//   node scripts/gen-og.mjs            -> public/og.jpg を更新
//   node scripts/gen-og.mjs --preview  -> test-image-secret/og-preview.jpg に出力
//
// 右側のアプリ画面は assets/og-shot.jpg を使う（初回は public/og.jpg から自動で切り出す）。
// 文言を変えたいときは下の COPY を編集して再実行する。

import { chromium } from 'playwright-core';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { findChrome, ROOT } from './test-images-lib.mjs';

const COPY = {
  mark: 'rm',
  lines: ['写真の顔・スクショの秘密を', 'ブラウザだけで隠す'],
  pills: ['無通信', 'MIT'],
  url: 'rm.okamomedia.tokyo',
};

// 元画像（public/og.jpg）内のブラウザモックの位置
const SHOT = { x: 620, y: 140, w: 522, h: 353 };
const W = 1200;
const H = 630;

const ASSETS = path.join(ROOT, 'assets');
const SHOT_FILE = path.join(ASSETS, 'og-shot.jpg');
const OG = path.join(ROOT, 'public', 'og.jpg');
const preview = process.argv.includes('--preview');
const OUT = preview
  ? path.join(ROOT, 'test-image-secret', 'og-preview.jpg')
  : OG;

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
});

try {
  // 1. アプリ画面の切り出し（初回のみ）
  if (!existsSync(SHOT_FILE)) {
    if (!existsSync(OG)) throw new Error(`${OG} がありません`);
    const tmp = await browser.newPage();
    await tmp.setContent('<canvas id="c"></canvas>');
    const dataUrl = await tmp.evaluate(
      async ({ src, shot, w, h }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.getElementById('c');
        c.width = shot.w;
        c.height = shot.h;
        c.getContext('2d').drawImage(img, shot.x, shot.y, shot.w, shot.h, 0, 0, shot.w, shot.h);
        return c.toDataURL('image/jpeg', 0.94);
      },
      {
        src: `data:image/jpeg;base64,${readFileSync(OG).toString('base64')}`,
        shot: SHOT,
        w: W,
        h: H,
      }
    );
    mkdirSync(ASSETS, { recursive: true });
    writeFileSync(SHOT_FILE, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`切り出し: ${SHOT_FILE}`);
    await tmp.close();
  }

  const shotUrl = `data:image/jpeg;base64,${readFileSync(SHOT_FILE).toString('base64')}`;

  // 2. テンプレートを描画
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; }
      body {
        position: relative;
        overflow: hidden;
        background:
          linear-gradient(90deg, rgba(8,8,10,0) 25%, rgba(8,8,10,0.38) 42%, rgba(8,8,10,0.62) 48%, #08080a 100%),
          linear-gradient(180deg, #1d2236 0%, #0d0e13 100%);
        font-family: 'Noto Sans CJK JP', 'Noto Sans JP', sans-serif;
        color: #eef0f6;
      }
      .mark {
        position: absolute; left: 76px; top: 122px;
        font-size: 120px; font-weight: 800; letter-spacing: -0.02em;
        line-height: 1; color: #f2f4f9;
      }
      .brandbar {
        position: absolute; left: 76px; top: 250px;
        width: 64px; height: 6px; border-radius: 3px; background: #889bff;
      }
      .tag {
        position: absolute; left: 82px; top: 265px;
        font-size: 25px; font-weight: 500; line-height: 43px;
        letter-spacing: -0.05em; color: #e3e9f9;
      }
      .pills {
        position: absolute; left: 82px; top: 384px;
        display: flex; gap: 16px;
      }
      .pills span {
        display: inline-flex; align-items: center; justify-content: center;
        height: 46px; padding: 0 20px;
        border: 1px solid rgba(157, 178, 255, 0.45);
        border-radius: 999px;
        background: rgba(82, 110, 200, 0.12);
        font-size: 19px; font-weight: 500; color: #cdd6ee;
      }
      .url {
        position: absolute; left: 84px; top: 539px;
        font-size: 25px; font-weight: 400; letter-spacing: -0.01em;
        color: #8698e8;
      }
      .shot {
        position: absolute; left: ${SHOT.x}px; top: ${SHOT.y}px;
        width: ${SHOT.w}px; height: ${SHOT.h}px;
        border-radius: 15px;
        background-image: url('${shotUrl}');
        background-size: ${SHOT.w}px ${SHOT.h}px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.07);
      }
    </style></head><body>
      <div class="mark">${COPY.mark}</div>
      <div class="brandbar"></div>
      <div class="tag">${COPY.lines.join('<br>')}</div>
      <div class="pills">${COPY.pills.map((p) => `<span>${p}</span>`).join('')}</div>
      <div class="url">${COPY.url}</div>
      <div class="shot"></div>
    </body></html>`,
    { waitUntil: 'load' }
  );
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, buf);
  console.log(`出力: ${OUT} (${(buf.length / 1024).toFixed(1)} KB)`);
} finally {
  await browser.close();
}
