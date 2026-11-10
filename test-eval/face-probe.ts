// 顔検出の解像度・しきい値による検出数の違いを調べる診断ページ。
// 画像の中身は表示せず、顔の数と箱のサイズだけを返す。

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

type FaceBox = { x: number; y: number; w: number; h: number };
type ProbeOut = {
  scale: number;
  threshold: number;
  ms: number;
  count: number;
  boxes: FaceBox[];
};
type TileOut = { cols: number; rows: number; ms: number; count: number; boxes: FaceBox[] };

const base = new URL('./', document.baseURI).href;

function canvasAt(bmp: ImageBitmap, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

async function makeLandmarker(
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  threshold: number,
): Promise<FaceLandmarker> {
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: {
      modelAssetPath: new URL('models/face_landmarker.task', base).href,
      delegate,
    },
    runningMode: 'IMAGE' as const,
    numFaces: 30,
    minFaceDetectionConfidence: threshold,
    minFacePresenceConfidence: threshold,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return await FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

function iou(a: FaceBox, b: FaceBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** 画像を cols×rows に分割し、各タイルを maxSide に縮小して顔を検出する */
function detectTiled(
  landmarker: FaceLandmarker,
  bmp: ImageBitmap,
  cols: number,
  rows: number,
  tileSide = 1024,
): TileOut {
  const W = bmp.width;
  const H = bmp.height;
  const overlap = 0.15;
  const tw = W / (cols - (cols - 1) * overlap);
  const th = H / (rows - (rows - 1) * overlap);
  const boxes: FaceBox[] = [];
  const started = performance.now();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const sx = Math.min(W - tw, col * tw * (1 - overlap));
      const sy = Math.min(H - th, row * th * (1 - overlap));
      const scale = Math.min(1, tileSide / Math.max(tw, th));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(tw * scale));
      canvas.height = Math.max(1, Math.round(th * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, sx, sy, tw, th, 0, 0, canvas.width, canvas.height);
      const result = landmarker.detect(canvas);
      for (const landmarks of result.faceLandmarks) {
        let minX = 1;
        let minY = 1;
        let maxX = 0;
        let maxY = 0;
        for (const p of landmarks) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        }
        boxes.push({
          x: (sx + minX * tw) / W,
          y: (sy + minY * th) / H,
          w: ((maxX - minX) * tw) / W,
          h: ((maxY - minY) * th) / H,
        });
      }
    }
  }
  const unique: FaceBox[] = [];
  for (const b of boxes) {
    if (!unique.some((u) => iou(u, b) > 0.4)) unique.push(b);
  }
  return { cols, rows, ms: Math.round(performance.now() - started), count: unique.length, boxes: unique };
}

async function main(): Promise<void> {
  const file = new URLSearchParams(location.search).get('file');
  const tileSide = Number(new URLSearchParams(location.search).get('tile') ?? 1024);
  if (!file) throw new Error('file パラメータがありません');
  const res = await fetch(`/${file}`, { cache: 'no-store' });
  const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
  const fileset = await FilesetResolver.forVisionTasks(new URL('wasm', base).href);

  const out: ProbeOut[] = [];
  const tiles: TileOut[] = [];
  for (const threshold of [0.35, 0.15]) {
    const landmarker = await makeLandmarker(fileset, threshold);
    for (const scale of [1024, 1600, 2048]) {
      const canvas = canvasAt(bmp, scale);
      const started = performance.now();
      const result = landmarker.detect(canvas);
      const boxes: FaceBox[] = [];
      for (const landmarks of result.faceLandmarks) {
        let minX = 1;
        let minY = 1;
        let maxX = 0;
        let maxY = 0;
        for (const p of landmarks) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        }
        boxes.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
      }
      out.push({
        scale,
        threshold,
        ms: Math.round(performance.now() - started),
        count: boxes.length,
        boxes,
      });
    }
    if (threshold === 0.35) {
      tiles.push(detectTiled(landmarker, bmp, 2, 2, tileSide));
      tiles.push(detectTiled(landmarker, bmp, 3, 3, tileSide));
    }
    landmarker.close();
  }
  bmp.close();

  (window as unknown as { __PROBE?: unknown }).__PROBE = { done: true, file, out, tiles };
  document.getElementById('out')!.textContent = JSON.stringify({ file, out, tiles }, null, 2);
}

main().catch((err) => {
  (window as unknown as { __PROBE?: unknown }).__PROBE = { done: true, error: String(err) };
  document.getElementById('out')!.textContent = String(err);
});
