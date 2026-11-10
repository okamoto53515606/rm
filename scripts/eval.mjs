// ブラウザ内検出の自動評価。
//   1. Vite dev サーバーを起動（既に起動していれば再利用）
//   2. ヘッドレス Chromium で /eval.html を開き、検出を実行
//   3. 正解データと照合した結果とオーバーレイ画像を test-image-secret/eval-out/ に保存

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BASE, ROOT, ensureServer, launchBrowser, stopServer } from './test-images-lib.mjs';

const OUT_DIR = path.join(ROOT, 'test-image-secret', 'eval-out');
const filterArg = process.argv.find((arg) => arg.startsWith('--filter='));
const filter = filterArg ? filterArg.slice('--filter='.length) : '';
const url = `${BASE}/eval.html${filter ? `?filter=${encodeURIComponent(filter)}` : ''}`;

const server = await ensureServer();
const browser = await launchBrowser(chromium);
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console]', msg.text());
  });

  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__EVAL?.done === true, null, {
      timeout: 900_000,
      polling: 1000,
    });
  } catch (err) {
    const status = await page.evaluate(() => document.getElementById('status')?.textContent);
    throw new Error(`評価がタイムアウトしました（状態: ${status}）\n${String(err)}`);
  }

  const data = await page.evaluate(() => window.__EVAL);
  const overlays = await page.evaluate(() => window.__OVERLAYS ?? {});
  if (data?.fatal) throw new Error(`評価ページで致命的なエラー:\n${data.fatal}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(data, null, 2) + '\n');
  for (const [id, dataUrl] of Object.entries(overlays)) {
    const base64 = String(dataUrl).split(',')[1] ?? '';
    writeFileSync(path.join(OUT_DIR, `${id}.png`), Buffer.from(base64, 'base64'));
  }

  print(data);
  console.log(`\nレポート: ${path.join(OUT_DIR, 'report.json')}`);
  console.log(`オーバーレイ: ${path.join(OUT_DIR, '*.png')}`);
} catch (err) {
  exitCode = 1;
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  stopServer(server);
}
process.exit(exitCode);

function pad(value, width) {
  return String(value).padEnd(width);
}

function pct(n, d) {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

function print(data) {
  const results = data.results ?? [];
  console.log('\n=== 画像ごとの結果（ブラウザ内のみ・Ollama なし） ===\n');
  for (const r of results) {
    const counts = Object.entries(r.counts ?? {})
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    const marks = [];
    if (r.error) marks.push(`ERROR ${r.error}`);
    if (r.misses?.length) marks.push(`未検出 ${r.misses.length}`);
    if (r.extras?.length) marks.push(`余分 ${r.extras.length}`);
    if (r.labelMismatch) marks.push(`ラベル不一致 ${r.labelMismatch}`);
    console.log(
      `${pad(r.id, 24)} 検出=${pad(r.detections.length, 2)} 正解一致=${pad(`${r.gtCovered}/${r.gt.length}`, 5)} ${pad(`${r.ms}ms`, 7)} ${pad(counts, 26)} ${marks.join(' / ')}`,
    );
    if (r.note) console.log(`${' '.repeat(26)}${r.note}`);
  }

  console.log('\n=== 集計 ===\n');
  const rows = [
    ['全体', data.summary.overall],
    ...Object.entries(data.summary.byCategory ?? {}),
  ];
  console.log(
    ['対象', '画像', '正解', '検出', '再現率', '適合率', '平均時間', 'エラー'].map((s, i) => pad(s, i === 0 ? 8 : 10)).join(''),
  );
  for (const [name, agg] of rows) {
    const recall = agg.gt ? pct(agg.gtCovered, agg.gt) : '—';
    const precision = agg.det ? pct(agg.detMatched, agg.det) : '—';
    console.log(
      [
        pad(name, 8),
        pad(agg.images, 10),
        pad(agg.gt, 10),
        pad(agg.det, 10),
        pad(recall, 10),
        pad(precision, 10),
        pad(`${Math.round(agg.ms / Math.max(1, agg.images))}ms`, 10),
        pad(agg.errors, 10),
      ].join(''),
    );
  }
  console.log(
    '\n※ 再現率 = 正解のうち検出で覆えた割合 / 適合率 = 検出のうち正解に重なった割合',
  );
}
