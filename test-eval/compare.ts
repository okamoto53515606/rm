// test-image-secret の全画像について、自動検出 → マスク書き出しを行い、
// 「マスク前 / 検出枠 / マスク後」のプレビューを返す。
// レポート HTML は scripts/compare.mjs が組み立てる。

import { detect } from '../src/detect';
import { downscale, renderMasked } from '../src/image';
import type { Category, Detection, Mask } from '../src/types';
import { iou } from '../src/util';

type Manifest = { images: string[] };

interface MaskInfo {
  category: Category;
  label: string;
  effect: Mask['effect'];
  box: { x: number; y: number; w: number; h: number };
}

interface CompareResult {
  file: string;
  width: number;
  height: number;
  ms: number;
  error?: string;
  detections: Detection[];
  masks: MaskInfo[];
  counts: Partial<Record<Category, number>>;
  before: string;
  overlay: string;
  after: string;
  afterFull: string;
}

const PREVIEW_MAX = 1000;
const EXPORT_MAX_SIDE = 2000;
const EXPORT_QUALITY = 0.86;

const statusEl = document.getElementById('status') as HTMLDivElement;

function setStatus(message: string): void {
  statusEl.textContent = message;
}

/** アプリの appendDetections と同じ規則でマスクを作る */
function masksFromDetections(
  detections: Detection[],
  width: number,
  height: number,
): { mask: Mask; category: Category }[] {
  const built: { mask: Mask; category: Category }[] = [];
  for (const d of detections) {
    let box = {
      x: d.box.x * width,
      y: d.box.y * height,
      w: d.box.w * width,
      h: d.box.h * height,
    };
    // 文字は端の半文字が残らないよう少し広げる
    if (d.category === 'secret') {
      const padX = Math.max(2, Math.round(width * 0.004));
      const padY = Math.max(2, Math.round(height * 0.004));
      const x0 = Math.max(0, box.x - padX);
      const y0 = Math.max(0, box.y - padY);
      const x1 = Math.min(width, box.x + box.w + padX);
      const y1 = Math.min(height, box.y + box.h + padY);
      box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    if (built.some((b) => iou(b.mask.box, box) > 0.6)) continue;
    built.push({
      mask: {
        id: `auto-${built.length + 1}`,
        kind: 'rect',
        box,
        effect: d.category === 'secret' ? 'fill' : 'mosaic+blur',
        label: d.label,
        source: 'auto',
      },
      category: d.category,
    });
  }
  return built;
}

/** プレビュー用に検出枠を描く */
function drawOverlay(
  preview: HTMLCanvasElement,
  masks: Mask[],
  sourceWidth: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = preview.width;
  canvas.height = preview.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.drawImage(preview, 0, 0);
  const scale = preview.width / sourceWidth;
  const fontSize = Math.max(11, Math.round(preview.width / 55));
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.lineWidth = Math.max(2, Math.round(preview.width / 350));
  for (const m of masks) {
    const x = m.box.x * scale;
    const y = m.box.y * scale;
    const w = m.box.w * scale;
    const h = m.box.h * scale;
    ctx.strokeStyle = m.effect === 'fill' ? '#ff5d73' : '#4cc9f0';
    ctx.strokeRect(x, y, w, h);
    const label = `${m.label}（${m.effect}）`;
    const tw = ctx.measureText(label).width;
    const ly = Math.max(fontSize, y - 3);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x, ly - fontSize * 0.85, tw + 6, fontSize * 1.15);
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.fillText(label, x + 3, ly);
  }
  return canvas;
}

function jpegDataUrl(canvas: HTMLCanvasElement, quality = 0.8): string {
  return canvas.toDataURL('image/jpeg', quality);
}

async function runOne(file: string): Promise<CompareResult> {
  const started = performance.now();
  const result: CompareResult = {
    file,
    width: 0,
    height: 0,
    ms: 0,
    detections: [],
    masks: [],
    counts: {},
    before: '',
    overlay: '',
    after: '',
    afterFull: '',
  };
  let raster: ImageBitmap | null = null;
  try {
    const res = await fetch(`/${file}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`画像を取得できません (${res.status})`);
    raster = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
    result.width = raster.width;
    result.height = raster.height;

    setStatus(`${file}: 検出中…`);
    result.detections = await detect(raster, {
      provider: 'local',
      ocr: true,
      refineFaces: false,
      ollamaEndpoint: '',
      ollamaModel: '',
      onProgress: (m) => setStatus(`${file}: ${m}`),
    });

    const masks = masksFromDetections(result.detections, raster.width, raster.height);
    result.masks = masks.map((b) => ({
      category: b.category,
      label: b.mask.label,
      effect: b.mask.effect,
      box: b.mask.box,
    }));
    for (const d of result.detections) {
      result.counts[d.category] = (result.counts[d.category] ?? 0) + 1;
    }

    const beforeCanvas = downscale(raster, PREVIEW_MAX);
    result.before = jpegDataUrl(beforeCanvas);
    result.overlay = jpegDataUrl(drawOverlay(beforeCanvas, masks.map((b) => b.mask), raster.width));

    setStatus(`${file}: マスク書き出し中…`);
    const afterCanvas = renderMasked(raster, masks.map((b) => b.mask), EXPORT_MAX_SIDE);
    result.afterFull = afterCanvas.toDataURL('image/jpeg', EXPORT_QUALITY);
    result.after = jpegDataUrl(downscale(afterCanvas, PREVIEW_MAX));
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.ms = Math.round(performance.now() - started);
    raster?.close();
  }
  return result;
}

async function main(): Promise<void> {
  const res = await fetch('/test-image-secret/compare-manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('compare-manifest.json がありません（scripts/compare.mjs から実行してください）');
  const manifest = (await res.json()) as Manifest;
  const results: CompareResult[] = [];
  for (let i = 0; i < manifest.images.length; i += 1) {
    setStatus(`${i + 1}/${manifest.images.length}`);
    results.push(await runOne(manifest.images[i]));
  }
  setStatus('完了');
  window.__COMPARE = { done: true, results };
}

declare global {
  interface Window {
    __COMPARE?: { done: boolean; results: CompareResult[]; fatal?: string };
  }
}

main().catch((err) => {
  setStatus(`エラー: ${String(err)}`);
  window.__COMPARE = {
    done: true,
    results: [],
    fatal: err instanceof Error ? err.stack ?? err.message : String(err),
  };
});
