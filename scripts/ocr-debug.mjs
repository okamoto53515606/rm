// OCR デバッグページをヘッドレスで開き、行テキストと座標を表示する。
//   node scripts/ocr-debug.mjs test-image-secret/deepseek1.png

import { chromium } from 'playwright-core';
import { BASE, ensureServer, launchBrowser, stopServer } from './test-images-lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'test-image-secret/deepseek1.png';
const psm = args.find((a) => /^\d+$/.test(a)) ?? '3';
const safe = args.includes('--safe');
const shape = args.includes('--shape');
const tokens = args.includes('--tokens');
const stats = args.includes('--stats');
const hints = args.includes('--hints');
const plateTest = args.includes('--plate-test');
const PLATE_TESTS = [
  ['loose-sep', /\d{2,4}\s*[^\dA-Za-z]{1,2}\s*\d{2,4}/],
  ['loose-sep-line', /^[\s\S]{0,6}\d{2,4}\s*[^\dA-Za-z]{1,2}\s*\d{2,4}[\s\S]{0,4}$/],
  ['six-digits', /\d{6,}/],
];
const box = args.find((a) => a.startsWith('--box='))?.slice('--box='.length);
const target = args.find((a) => a.startsWith('--target='))?.slice('--target='.length) ?? '700';
const orient = args.includes('--orient=none') ? 'none' : 'from-image';
const rotate = args.find((a) => a.startsWith('--rotate='))?.slice('--rotate='.length) ?? '0';

/** 秘密値を出さずに、文字種と長さだけを表示する */
function redact(text) {
  const chars = [...text];
  const upper = (text.match(/[A-Z]/g) ?? []).length;
  const lower = (text.match(/[a-z]/g) ?? []).length;
  const digit = (text.match(/[0-9]/g) ?? []).length;
  const symbol = chars.length - upper - lower - digit;
  const head = text.slice(0, 3).replace(/[^A-Za-z0-9_-]/g, '?');
  return `${head}… (len ${chars.length}, upper ${upper}, lower ${lower}, digit ${digit}, symbol ${symbol})`;
}

/** 長いトークンの「形」だけを表示する（既知の接頭辞以外は中身を出さない） */
function tokenShapes(text) {
  const known = /^(?:sk-|AIza|AKIA|ASIA|gh[pousr]_|github_pat_|xox[baprs]-|eyJ|-----)/;
  return text
    .split(/[^A-Za-z0-9_-]+/)
    .filter((t) => t.length >= 8)
    .map((t) => {
      const upper = (t.match(/[A-Z]/g) ?? []).length;
      const lower = (t.match(/[a-z]/g) ?? []).length;
      const digit = (t.match(/[0-9]/g) ?? []).length;
      const kind =
        upper && lower && digit
          ? 'mixed'
          : upper && lower
            ? 'alpha'
            : upper
              ? 'UPPER'
              : lower
                ? 'lower'
                : digit
                  ? 'digits'
                  : 'symbols';
      const head = known.test(t) ? t.slice(0, 4) : '';
      return `${head}[len ${t.length}, ${kind}]`;
    })
    .join(' ');
}

/** 行の文字種の内訳（内容は出さない） */
function charStats(text) {
  const chars = [...text];
  const kanji = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const digit = (text.match(/[0-9]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const other = chars.length - kanji - kana - digit - latin;
  return `len ${chars.length}, kanji ${kanji}, kana ${kana}, digit ${digit}, latin ${latin}, other ${other}`;
}

const server = await ensureServer();
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(
    `${BASE}/ocr-debug.html?file=${encodeURIComponent(file)}&psm=${psm}&orient=${orient}&rotate=${rotate}${box ? `&box=${encodeURIComponent(box)}&target=${target}` : ''}`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(() => window.__OCR?.done === true, null, {
    timeout: 300_000,
    polling: 500,
  });
  const data = await page.evaluate(() => window.__OCR);
  if (data.error) throw new Error(data.error);
  console.log(`file: ${data.file}  psm: ${data.psm}  canvas: ${data.width}x${data.height}  ${data.ms}ms`);
  for (const line of data.lines) {
    const b = line.bbox;
    const shown = safe ? '' : shape ? redact(line.text) : line.text;
    const extra = tokens ? `  ${tokenShapes(line.text)}` : '';
    const counts = stats ? `  (${charStats(line.text)})` : '';
    const hintText = hints
      ? `  hints:[${[
          ['@', line.text.includes('@')],
          ['prompt', /[$#]\s*$/.test(line.text)],
          ['/home/', line.text.includes('/home/')],
          ['~/', line.text.includes('~/')],
          ['aws', /aws[_-]/i.test(line.text)],
          ['secret', /secret/i.test(line.text)],
          ['access_key', /access[_-]?key/i.test(line.text)],
          ['eq', line.text.includes('=')],
        ]
          .filter(([, ok]) => ok)
          .map(([n]) => n)
          .join('|') || '-'}]`
      : '';
    const plateHits = plateTest
      ? `  plate:[${PLATE_TESTS.filter(([, re]) => re.test(line.text)).map(([n]) => n).join('|') || '-'}]`
      : '';
    console.log(
      `${line.match ? '●' : ' '} ${String(line.match ?? '').padEnd(16)} [${b.x0},${b.y0},${b.x1},${b.y1}] ${String(Math.round(line.confidence)).padStart(3)}  ${shown}${extra}${counts}${hintText}${plateHits}`,
    );
  }
} finally {
  await browser.close();
  stopServer(server);
}
