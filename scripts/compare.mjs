// test-image-secret の全画像について「マスク前 / 検出枠 / マスク後」の比較レポートを作る。
//   npm run test:compare
// 出力: test-image-secret/eval-out/compare/report.html（自己完結 HTML）
//       test-image-secret/eval-out/compare/after/*.jpg（自動検出で書き出した JPEG）

import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BASE, ROOT, ensureServer, launchBrowser, stopServer } from './test-images-lib.mjs';

const SRC_DIR = path.join(ROOT, 'test-image-secret');
const OUT_DIR = path.join(SRC_DIR, 'eval-out', 'compare');
const AFTER_DIR = path.join(OUT_DIR, 'after');
const MANIFEST = path.join(SRC_DIR, 'compare-manifest.json');
const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;

const CAT_JA = { face: '顔', plate: 'ナンバープレート', secret: '機密文字列', other: 'その他' };
const EFFECT_JA = {
  'mosaic+blur': 'モザイク＋ぼかし',
  mosaic: 'モザイク',
  blur: 'ぼかし',
  fill: '黒塗り',
};

/** test-image-secret 配下の画像を再帰的に集める（eval-out は除外） */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (rel.startsWith('test-image-secret/eval-out/')) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (IMAGE_RE.test(name)) out.push(rel);
  }
  return out;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function afterName(file) {
  return (
    file
      .replace(/^test-image-secret\//, '')
      .replace(/[\\/]/g, '_')
      .replace(/\.[^.]+$/, '') + '_masked.jpg'
  );
}

function maskSummary(masks) {
  const counts = new Map();
  for (const m of masks) {
    const key = `${m.label}（${EFFECT_JA[m.effect] ?? m.effect}）`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${escapeHtml(k)} ×${n}`).join('、');
}

function buildHtml(results) {
  const ok = results.filter((r) => !r.error);
  const errors = results.filter((r) => r.error);
  const totals = { face: 0, plate: 0, secret: 0, other: 0 };
  let totalMs = 0;
  let totalMasks = 0;
  for (const r of ok) {
    totalMs += r.ms;
    totalMasks += r.masks.length;
    for (const [k, v] of Object.entries(r.counts ?? {})) totals[k] = (totals[k] ?? 0) + v;
  }
  const zero = ok.filter((r) => r.masks.length === 0);

  const rows = results
    .map((r, i) => {
      const meta = r.error
        ? `<span class="err">ERROR: ${escapeHtml(r.error)}</span>`
        : `${r.width}×${r.height} / ${r.ms}ms / 検出 ${r.detections.length} 件・マスク ${r.masks.length} か所`;
      const counts = Object.entries(r.counts ?? {})
        .map(([k, v]) => `${CAT_JA[k] ?? k} ${v}`)
        .join(' / ');
      const body = r.error
        ? `<p class="err">${escapeHtml(r.error)}</p>`
        : `<div class="grid">
            <figure><figcaption>マスク前</figcaption><img src="${r.before}" alt="before"></figure>
            <figure><figcaption>検出枠（赤=黒塗り / 青=モザイク＋ぼかし）</figcaption><img src="${r.overlay}" alt="overlay"></figure>
            <figure><figcaption>マスク後（自動検出で書き出し）</figcaption><img src="${r.after}" alt="after"></figure>
          </div>
          <p class="masks">${maskSummary(r.masks) || '検出なし'}</p>
          <p class="link"><a href="after/${encodeURIComponent(afterName(r.file))}" target="_blank" rel="noopener">書き出した JPEG を開く</a>（長辺2000px・品質0.86）</p>`;
      return `<article id="img-${i}">
        <h2><a href="#img-${i}">${escapeHtml(r.file)}</a></h2>
        <p class="meta">${meta}${counts ? ` — ${escapeHtml(counts)}` : ''}</p>
        ${body}
      </article>`;
    })
    .join('\n');

  const toc = results
    .map(
      (r, i) =>
        `<li><a href="#img-${i}" class="${r.error ? 'err' : ''}">${escapeHtml(r.file.replace(/^test-image-secret\//, ''))}</a>${r.error ? ' — ERROR' : `（${r.masks.length}）`}</li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rm マスク前→後 比較レポート</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#12141a; color:#e7e9ee; margin:0; padding:20px 24px 80px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .lead { color:#9aa3b2; font-size:13px; margin:0 0 18px; }
  table { border-collapse:collapse; font-size:13px; margin:0 0 18px; }
  th,td { border:1px solid #2c3140; padding:4px 10px; text-align:right; }
  th:first-child,td:first-child { text-align:left; }
  .toc { background:#1a1d26; border:1px solid #2c3140; border-radius:8px; padding:10px 16px 10px 30px; font-size:13px; margin:0 0 22px; columns:2; }
  .toc li { margin:2px 0; }
  a { color:#7cc4ff; }
  article { background:#1a1d26; border:1px solid #2c3140; border-radius:10px; padding:14px 16px; margin:0 0 18px; }
  article h2 { font-size:14px; margin:0 0 4px; word-break:break-all; }
  article h2 a { color:#e7e9ee; text-decoration:none; }
  .meta { color:#9aa3b2; font-size:12px; margin:0 0 10px; }
  .grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; }
  figure { margin:0; min-width:0; }
  figcaption { color:#9aa3b2; font-size:11px; margin-bottom:4px; }
  img { width:100%; height:auto; display:block; border-radius:4px; background:#000; }
  .masks { font-size:12px; color:#c8cdd8; margin:10px 0 4px; }
  .link { font-size:12px; margin:0; }
  .err { color:#ff8a80; }
  .warn { color:#ffd166; }
  @media (max-width: 900px) { .grid { grid-template-columns:1fr; } .toc { columns:1; } }
</style>
</head>
<body>
<h1>自動検出 マスク前 → マスク後</h1>
<p class="warn">このレポートには test-image-secret の実写真（顔・ナンバープレート）が含まれます。取り扱いに注意し、共有しないでください。</p>
<p class="lead">検出方法: ブラウザ内（Ollama なし） / 書き出し: 長辺 ${2000}px・JPEG 品質 0.86 / 生成: ${escapeHtml(new Date().toLocaleString('ja-JP'))}</p>
<table>
  <thead><tr><th>対象</th><th>画像</th><th>マスク合計</th><th>顔</th><th>ナンバー</th><th>機密文字列</th><th>平均時間</th><th>エラー</th></tr></thead>
  <tbody><tr>
    <td>全体</td><td>${results.length}</td><td>${totalMasks}</td>
    <td>${totals.face ?? 0}</td><td>${totals.plate ?? 0}</td><td>${totals.secret ?? 0}</td>
    <td>${ok.length ? Math.round(totalMs / ok.length) : 0}ms</td><td>${errors.length}</td>
  </tr></tbody>
</table>
${zero.length ? `<p class="warn">検出 0 件の画像: ${zero.map((r) => escapeHtml(r.file.replace(/^test-image-secret\//, ''))).join('、')}</p>` : ''}
${errors.length ? `<p class="err">エラー: ${errors.map((r) => escapeHtml(r.file)).join('、')}</p>` : ''}
<ol class="toc">${toc}</ol>
${rows}
</body>
</html>
`;
}

const server = await ensureServer();
const browser = await launchBrowser(chromium);
let exitCode = 0;
try {
  const images = walk(SRC_DIR).sort();
  if (!images.length) throw new Error('test-image-secret に画像がありません');
  writeFileSync(MANIFEST, JSON.stringify({ images }, null, 2) + '\n');
  console.log(`対象: ${images.length} 枚`);
  for (const file of images) console.log(`  ${file}`);

  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console]', msg.text());
  });
  await page.goto(`${BASE}/compare.html`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__COMPARE?.done === true, null, {
      timeout: 1_800_000,
      polling: 1000,
    });
  } catch (err) {
    const status = await page.evaluate(() => document.getElementById('status')?.textContent);
    throw new Error(`比較レポートの生成がタイムアウトしました（状態: ${status}）\n${String(err)}`);
  }
  const data = await page.evaluate(() => window.__COMPARE);
  if (data?.fatal) throw new Error(`比較ページで致命的なエラー:\n${data.fatal}`);

  mkdirSync(AFTER_DIR, { recursive: true });
  for (const r of data.results) {
    if (!r.afterFull) continue;
    const base64 = String(r.afterFull).split(',')[1] ?? '';
    writeFileSync(path.join(AFTER_DIR, afterName(r.file)), Buffer.from(base64, 'base64'));
  }

  const compact = data.results.map(({ before, overlay, after, afterFull, ...rest }) => rest);
  writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(compact, null, 2) + '\n');
  writeFileSync(path.join(OUT_DIR, 'report.html'), buildHtml(data.results));

  const errors = data.results.filter((r) => r.error);
  const totalMasks = data.results.reduce((n, r) => n + r.masks.length, 0);
  console.log(`\n${data.results.length} 枚を処理、マスク合計 ${totalMasks} か所、エラー ${errors.length} 件`);
  if (errors.length) exitCode = 1;
  console.log(`レポート: ${path.join(OUT_DIR, 'report.html')}`);
  console.log(`書き出し JPEG: ${AFTER_DIR}`);
} catch (err) {
  exitCode = 1;
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  stopServer(server);
}
process.exit(exitCode);
