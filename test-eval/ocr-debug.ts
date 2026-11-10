// OCR の生の行テキストと bbox を確認するデバッグページ。
// 検出漏れが「OCR の誤読」なのか「正規表現の取りこぼし」なのかを切り分ける。

import { matchSecret } from '../src/ocr';

type LineOut = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  match: string | null;
};

const OCR_MAX_SIDE = 1600;

function prepareCanvas(raster: ImageBitmap | HTMLCanvasElement): HTMLCanvasElement {
  const longSide = Math.max(raster.width, raster.height);
  const scale = longSide < OCR_MAX_SIDE ? Math.min(2, OCR_MAX_SIDE / longSide) : Math.min(1, OCR_MAX_SIDE / longSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(raster.width * scale));
  canvas.height = Math.max(1, Math.round(raster.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(raster, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function invertIfDark(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const stride = Math.max(4, Math.floor(d.length / 40_000 / 4) * 4);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += stride) {
    sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    n += 1;
  }
  if (!n || sum / n > 120) return;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  ctx.putImageData(img, 0, 0);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const file = params.get('file') ?? 'test-image-secret/deepseek1.png';
  const psm = params.get('psm') ?? '3';
  const invert = params.get('invert') !== '0';
  const boxParam = params.get('box');
  const target = Number(params.get('target') ?? 700);
  const orient = params.get('orient') === 'none' ? 'none' : 'from-image';
  const rotate = Number(params.get('rotate') ?? 0) % 360;
  const res = await fetch(`/${file}`, { cache: 'no-store' });
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: orient });
  let raster: ImageBitmap | HTMLCanvasElement = bitmap;
  if (rotate) {
    const rad = (rotate * Math.PI) / 180;
    const swap = rotate % 180 !== 0;
    const rotated = document.createElement('canvas');
    rotated.width = swap ? bitmap.height : bitmap.width;
    rotated.height = swap ? bitmap.width : bitmap.height;
    const rc = rotated.getContext('2d');
    if (rc) {
      rc.translate(rotated.width / 2, rotated.height / 2);
      rc.rotate(rad);
      rc.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    }
    raster = rotated;
  }
  let canvas: HTMLCanvasElement;
  if (boxParam) {
    // プレート切り出しの再現（アプリと同じ 12% の余白、幅 target px）
    const [bx, by, bw, bh] = boxParam.split(',').map(Number);
    const pad = 0.12;
    const x = Math.max(0, bx - bw * pad);
    const y = Math.max(0, by - bh * pad);
    const w = Math.min(1 - x, bw * (1 + pad * 2));
    const h = Math.min(1 - y, bh * (1 + pad * 2));
    const sw = w * raster.width;
    const sh = h * raster.height;
    canvas = document.createElement('canvas');
    const scale = Math.min(3, target / Math.max(1, sw));
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const cx = canvas.getContext('2d');
    if (cx) {
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(raster, x * raster.width, y * raster.height, sw, sh, 0, 0, canvas.width, canvas.height);
    }
  } else {
    canvas = prepareCanvas(raster);
    if (invert) invertIfDark(canvas);
  }

  const { createWorker } = await import('tesseract.js');
  const base = new URL('./', document.baseURI).href;
  const worker = await createWorker('eng+jpn', 1, {
    workerPath: new URL('ocr/worker.min.js', base).href,
    corePath: new URL('ocr/core', base).href,
    langPath: new URL('ocr/tessdata', base).href,
    cacheMethod: 'none',
    gzip: false,
    workerBlobURL: false,
  });
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const started = performance.now();
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
  const ms = Math.round(performance.now() - started);

  const lines: LineOut[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = (line.text ?? '').replace(/\s+/g, ' ').trim();
        lines.push({
          text,
          confidence: line.confidence,
          bbox: line.bbox,
          match: matchSecret(text),
        });
      }
    }
  }
  const payload = { file, psm, invert, ms, width: canvas.width, height: canvas.height, lines };
  (window as unknown as { __OCR?: unknown }).__OCR = { done: true, ...payload };
  document.getElementById('out')!.textContent = JSON.stringify(payload, null, 2);
  await worker.terminate();
}

main().catch((err) => {
  (window as unknown as { __OCR?: unknown }).__OCR = { done: true, error: String(err) };
  document.getElementById('out')!.textContent = String(err);
});
