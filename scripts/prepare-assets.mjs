// ビルド/開発の前に、MediaPipe の WASM と顔検出モデルを public/ に用意する。
// - WASM  : node_modules から複製（CDN に依存しない）
// - model : 未取得なら公式バケットからダウンロード（リポジトリには含めない）
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const wasmSrc = path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = path.join(root, 'public/wasm');
const modelDir = path.join(root, 'public/models');
const modelPath = path.join(modelDir, 'face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

async function sizeOf(p) {
  try {
    return (await stat(p)).size;
  } catch {
    return -1;
  }
}

/**
 * 大きめのファイルを取得する。
 * 環境によっては Node の fetch（undici）が名前解決でタイムアウトするため、
 * 失敗したら curl に切り替える。
 */
async function download(url, dst) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 1024) throw new Error('ファイルサイズが不正です');
    await writeFile(dst, buf);
    return buf.byteLength;
  } catch (fetchErr) {
    try {
      execFileSync('curl', ['-fsSL', '--retry', '2', '--max-time', '180', '-o', dst, url], {
        stdio: 'ignore',
      });
      const size = await sizeOf(dst);
      if (size < 1024) throw new Error('ファイルサイズが不正です');
      return size;
    } catch {
      throw fetchErr;
    }
  }
}

await mkdir(wasmDst, { recursive: true });
await mkdir(modelDir, { recursive: true });

if (!existsSync(wasmSrc)) {
  console.error('[assets] @mediapipe/tasks-vision が未インストールです。npm install を実行してください。');
  process.exit(1);
}

await cp(wasmSrc, wasmDst, { recursive: true });
console.log(`[assets] wasm を複製しました -> public/wasm`);

if (await sizeOf(modelPath) > 0) {
  console.log('[assets] 顔検出モデルは取得済みです');
} else {
  console.log('[assets] 顔検出モデルをダウンロード中...');
  try {
    const size = await download(MODEL_URL, modelPath);
    console.log(`[assets] モデルを保存しました (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    console.warn(`[assets] モデルの取得に失敗しました: ${err}`);
    console.warn('[assets] ブラウザ内の顔検出は無効になります（Gemini / Ollama は利用可能です）');
  }
}

// ===== ローカルOCR（Tesseract.js）=====
// worker / core(WASM) / 英語モデルをすべて public/ocr に自己ホストする。
const ocrDir = path.join(root, 'public/ocr');
const ocrCoreDir = path.join(ocrDir, 'core');
const tessdataDir = path.join(ocrDir, 'tessdata');
const tesseractPkg = path.join(root, 'node_modules/tesseract.js');
const tesseractCore = path.join(root, 'node_modules/tesseract.js-core');
const TESSDATA_BASE = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/';
// 英語（APIキー・プロンプト等）と日本語（ナンバープレートの地名・ひらがな）
const TESSDATA = [
  { file: 'eng.traineddata', label: '英語' },
  { file: 'jpn.traineddata', label: '日本語' },
];

if (existsSync(tesseractPkg) && existsSync(tesseractCore)) {
  await mkdir(ocrCoreDir, { recursive: true });
  await mkdir(tessdataDir, { recursive: true });

  await cp(path.join(tesseractPkg, 'dist/worker.min.js'), path.join(ocrDir, 'worker.min.js'));

  // .wasm.js は wasm を内蔵しているため、これだけで動く
  for (const file of [
    'tesseract-core-relaxedsimd-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-lstm.wasm.js',
  ]) {
    const src = path.join(tesseractCore, file);
    if (existsSync(src)) await cp(src, path.join(ocrCoreDir, file));
  }
  console.log('[assets] OCR の worker/core を複製しました -> public/ocr');

  for (const lang of TESSDATA) {
    const dst = path.join(tessdataDir, lang.file);
    if ((await sizeOf(dst)) > 0) {
      console.log(`[assets] OCR ${lang.label}モデルは取得済みです`);
      continue;
    }
    console.log(`[assets] OCR ${lang.label}モデルをダウンロード中...`);
    try {
      const size = await download(TESSDATA_BASE + lang.file, dst);
      console.log(
        `[assets] ${lang.label}モデルを保存しました (${(size / 1024 / 1024).toFixed(1)} MB)`,
      );
    } catch (err) {
      console.warn(`[assets] OCR ${lang.label}モデルの取得に失敗しました: ${err}`);
      if (lang.file === 'eng.traineddata') {
        console.warn('[assets] ローカルOCRは無効になります（顔検出・Gemini・Ollama は利用可能です）');
      } else {
        console.warn('[assets] 日本語モデルが無いため、ローカルOCRは英語のみで動作します');
      }
    }
  }
} else {
  console.warn('[assets] tesseract.js が見つからないため、ローカルOCRは無効です');
}
