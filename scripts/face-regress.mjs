// test-image-secret 配下の画像すべてで顔検出を回し、件数と所要時間を JSON に出す。
//   node scripts/face-regress.mjs                      -> chromium / test-image-secret/face-regress.json
//   node scripts/face-regress.mjs --browser=webkit --out=path.json
// 変更前後で出力を取り、件数が減っていないか・増えた分が妥当かを比べる。
import { chromium, firefox, webkit } from 'playwright-core';
import { readdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE, ROOT, ensureServer, launchBrowser, stopServer } from './test-images-lib.mjs';

const EXT = /\.(jpe?g|png|webp|avif|bmp|gif)$/i;
const SKIP_DIR = new Set(['eval-out']);
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const OUT = outArg ? path.resolve(outArg) : path.join(ROOT, 'test-image-secret', 'face-regress.json');
const engineName =
  process.argv.find((a) => a.startsWith('--browser='))?.slice('--browser='.length) ?? 'chromium';
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) {
  console.error(`未対応のブラウザ: ${engineName}`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIR.has(name)) out.push(...walk(p));
    } else if (EXT.test(name) && !name.startsWith('og-') && !name.endsWith('_masked.jpg')) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(path.join(ROOT, 'test-image-secret')).sort();
if (!files.length) {
  console.error('画像が見つかりません');
  process.exit(1);
}

const server = await ensureServer();
const browser =
  engineName === 'chromium' ? await launchBrowser(chromium) : await engine.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(`${BASE}/README.md`, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  const results = await page.evaluate(
    async ({ paths }) => {
      const { detect } = await import('/src/detect.ts');
      const settings = { provider: 'local', ocr: false, refineFaces: false };
      const load = async (p) => {
        const blob = await (await fetch(`/${p}`, { cache: 'no-store' })).blob();
        return createImageBitmap(blob, { imageOrientation: 'from-image' });
      };
      // モデル初期化ぶんを計測から外すため、先に 1 枚ウォームアップする
      const warm = await load(paths[0]);
      await detect(warm, settings);
      warm.close();

      const out = [];
      for (const p of paths) {
        const raster = await load(p);
        const t0 = performance.now();
        let d = [];
        let error = null;
        try {
          d = await detect(raster, settings);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const ms = Math.round(performance.now() - t0);
        const faces = d.filter((x) => x.category === 'face');
        out.push({
          file: p,
          w: raster.width,
          h: raster.height,
          ms,
          faces: faces.length,
          boxes: faces.map((f) => ({
            x: +f.box.x.toFixed(3),
            y: +f.box.y.toFixed(3),
            w: +f.box.w.toFixed(3),
            h: +f.box.h.toFixed(3),
          })),
          other: d.length - faces.length,
          error,
        });
        raster.close();
      }
      return out;
    },
    { paths: files.map((f) => path.relative(ROOT, f).split(path.sep).join('/')) },
  );

  writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
  console.log(`出力: ${OUT}`);
  for (const r of results) {
    const mark = r.error ? 'ERR' : String(r.faces);
    console.log(
      `${String(r.faces).padStart(2)} 顔 ${String(r.ms).padStart(5)}ms  ${r.w}x${r.h}  ${r.file}${r.error ? `  ${r.error}` : ''}`,
    );
  }
} finally {
  await browser.close();
  stopServer(server);
}
