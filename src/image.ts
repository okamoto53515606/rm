import type { Mask, Raster } from './types';
import { clamp } from './util';

// ===== 読み込み =====

export function isHeicFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return /\.(heic|heif)$/.test(name) || /hei[cf]/.test(file.type);
}

async function heicToJpeg(file: File): Promise<Blob> {
  const mod = await import('heic2any');
  const convert = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const out = await (convert as unknown as (o: object) => Promise<Blob | Blob[]>)({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.94,
  });
  const blob = Array.isArray(out) ? out[0] : out;
  if (!blob) throw new Error('HEIC を変換できませんでした');
  return blob;
}

function decodeWithImg(blob: Blob): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      createImageBitmap(img)
        .then((bmp) => {
          URL.revokeObjectURL(url);
          resolve(bmp);
        })
        .catch((err) => {
          URL.revokeObjectURL(url);
          reject(err);
        });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした（形式非対応の可能性）'));
    };
    img.src = url;
  });
}

/**
 * ファイルをデコードする。EXIF の向きは自動で反映する。
 * HEIC/HEIF は WASM で JPEG に変換してからデコードする。
 */
export async function decodeFile(file: File): Promise<{ raster: Raster; width: number; height: number }> {
  let blob: Blob = file;
  if (isHeicFile(file)) {
    try {
      blob = await heicToJpeg(file);
    } catch (err) {
      throw new Error(
        `HEIC の変換に失敗しました。この端末では HEIC を開けない可能性があります。JPEG/PNG で保存し直してください。(${String(err)})`,
      );
    }
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await decodeWithImg(blob);
  }
  return { raster: bitmap, width: bitmap.width, height: bitmap.height };
}

export function releaseRaster(raster: Raster): void {
  if (typeof ImageBitmap !== 'undefined' && raster instanceof ImageBitmap) {
    raster.close();
  }
}

export async function makeThumbnail(raster: Raster, size = 96): Promise<string> {
  const scale = Math.min(1, size / Math.max(raster.width, raster.height));
  const w = Math.max(1, Math.round(raster.width * scale));
  const h = Math.max(1, Math.round(raster.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(raster, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.72));
  return blob ? URL.createObjectURL(blob) : '';
}

// ===== 縮小 =====

export function downscale(raster: Raster, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(raster.width, raster.height));
  const w = Math.max(1, Math.round(raster.width * scale));
  const h = Math.max(1, Math.round(raster.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(raster, 0, 0, w, h);
  }
  return canvas;
}

// ===== マスク描画 =====

function tracePath(
  ctx: CanvasRenderingContext2D,
  mask: Mask,
  scale: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.beginPath();
  if (mask.kind === 'rect') {
    ctx.rect(x, y, w, h);
    return;
  }
  if (mask.kind === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const pts = mask.points ?? [];
  if (pts.length < 6) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(pts[0] * scale, pts[1] * scale);
  for (let i = 2; i < pts.length; i += 2) {
    ctx.lineTo(pts[i] * scale, pts[i + 1] * scale);
  }
  ctx.closePath();
}

function pixelate(
  ctx: CanvasRenderingContext2D,
  raster: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  minSide: number,
): void {
  const block = clamp(Math.round(minSide * 0.12), 8, 96);
  const tw = Math.max(1, Math.round(w / block));
  const th = Math.max(1, Math.round(h / block));
  const tmp = document.createElement('canvas');
  tmp.width = tw;
  tmp.height = th;
  const tctx = tmp.getContext('2d');
  if (!tctx) return;
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(raster, x / scale, y / scale, w / scale, h / scale, 0, 0, tw, th);

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
  ctx.imageSmoothingEnabled = prev;
}

function blurRegion(
  ctx: CanvasRenderingContext2D,
  raster: Raster,
  outW: number,
  outH: number,
  minSide: number,
): void {
  const radius = clamp(minSide * 0.18, 6, 72);
  ctx.filter = `blur(${radius.toFixed(1)}px)`;
  ctx.drawImage(raster, 0, 0, outW, outH);
  ctx.filter = 'none';
}

function applyMask(
  ctx: CanvasRenderingContext2D,
  raster: Raster,
  mask: Mask,
  scale: number,
  outW: number,
  outH: number,
): void {
  const x = mask.box.x * scale;
  const y = mask.box.y * scale;
  const w = mask.box.w * scale;
  const h = mask.box.h * scale;
  if (w < 1 || h < 1) return;

  const minSide = Math.min(w, h);
  ctx.save();
  tracePath(ctx, mask, scale, x, y, w, h);
  ctx.clip();

  switch (mask.effect) {
    case 'fill':
      ctx.fillStyle = '#000000';
      ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
      break;
    case 'mosaic':
      pixelate(ctx, raster, x, y, w, h, scale, minSide);
      break;
    case 'blur':
      blurRegion(ctx, raster, outW, outH, minSide);
      break;
    case 'mosaic+blur':
    default:
      pixelate(ctx, raster, x, y, w, h, scale, minSide);
      blurRegion(ctx, raster, outW, outH, minSide);
      break;
  }
  ctx.restore();
}

/**
 * 元画像にマスクを焼き込んだ canvas を返す。
 * maxLongSide を指定すると、長辺がその値以下になるよう縮小する。
 */
export function renderMasked(
  raster: Raster,
  masks: Mask[],
  maxLongSide: number | null,
): HTMLCanvasElement {
  const scale = maxLongSide
    ? Math.min(1, maxLongSide / Math.max(raster.width, raster.height))
    : 1;
  const w = Math.max(1, Math.round(raster.width * scale));
  const h = Math.max(1, Math.round(raster.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas を用意できませんでした');

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(raster, 0, 0, w, h);
  for (const mask of masks) {
    applyMask(ctx, raster, mask, scale, w, h);
  }
  return canvas;
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG への変換に失敗しました'))),
      'image/jpeg',
      quality,
    );
  });
}
