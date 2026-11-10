// ブラウザ内検出（顔・ナンバープレート・機密文字列）の評価ハーネス。
// Ollama は使わない。test-image-secret/ の画像と正解データを読み、
// 検出結果を IoU / カバー率で照合して精度と処理時間を集計する。

import { detect } from '../src/detect';
import type { Category, Detection } from '../src/types';

type BoxN = { x: number; y: number; w: number; h: number };

interface GtItem {
  category: Category;
  box: BoxN;
  note?: string;
}

interface ImageSpec {
  id: string;
  file: string;
  tags?: string[];
  gt?: GtItem[];
  expect?: Partial<Record<Category, number>>;
  note?: string;
}

interface Dataset {
  images: ImageSpec[];
}

interface ImageResult {
  id: string;
  file: string;
  tags: string[];
  note?: string;
  ms: number;
  error?: string;
  detections: Detection[];
  gt: GtItem[];
  expect?: Partial<Record<Category, number>>;
  gtCovered: number;
  detMatched: number;
  counts: Partial<Record<Category, number>>;
  misses: GtItem[];
  extras: Detection[];
  labelMismatch: number;
  perGt: { category: Category; covered: boolean }[];
  matchedDets: number[];
}

interface Agg {
  images: number;
  gt: number;
  gtCovered: number;
  det: number;
  detMatched: number;
  ms: number;
  errors: number;
}

interface Summary {
  overall: Agg;
  byCategory: Partial<Record<Category, Agg>>;
}

const MAX_OVERLAY_W = 900;

const statusEl = document.getElementById('status') as HTMLDivElement;
const imagesEl = document.getElementById('images') as HTMLDivElement;
const summaryHost = document.getElementById('summaryHost') as HTMLDivElement;

function setStatus(message: string): void {
  statusEl.textContent = message;
}

async function loadDataset(url: string): Promise<Dataset> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { images: [] };
    const data = (await res.json()) as Dataset;
    return Array.isArray(data.images) ? data : { images: [] };
  } catch {
    return { images: [] };
  }
}

function area(b: BoxN): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

function intersection(a: BoxN, b: BoxN): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/**
 * 検出と正解の対応判定。
 * - IoU 0.25 以上
 * - または正解の面積の 50% 以上を覆う（OCR の行が正解より広い場合）
 * - または検出の中心が正解の内側（顔の箱が正解の内側に収まる場合）
 */
function isHit(gt: BoxN, det: BoxN): boolean {
  const inter = intersection(gt, det);
  if (inter <= 0) return false;
  const union = area(gt) + area(det) - inter;
  const iou = union > 0 ? inter / union : 0;
  const cov = area(gt) > 0 ? inter / area(gt) : 0;
  const cx = det.x + det.w / 2;
  const cy = det.y + det.h / 2;
  const centerIn =
    cx >= gt.x && cx <= gt.x + gt.w && cy >= gt.y && cy <= gt.y + gt.h;
  return iou >= 0.25 || cov >= 0.5 || centerIn;
}

function countByCategory(dets: Detection[]): Partial<Record<Category, number>> {
  const counts: Partial<Record<Category, number>> = {};
  for (const d of dets) counts[d.category] = (counts[d.category] ?? 0) + 1;
  return counts;
}

function drawOverlay(spec: ImageSpec, raster: ImageBitmap, dets: Detection[]): HTMLCanvasElement {
  const scale = Math.min(1, MAX_OVERLAY_W / raster.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(raster.width * scale));
  canvas.height = Math.max(1, Math.round(raster.height * scale));
  canvas.dataset.id = spec.id;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.drawImage(raster, 0, 0, canvas.width, canvas.height);

  const W = canvas.width;
  const H = canvas.height;
  const font = `${Math.max(11, Math.round(W / 60))}px system-ui, sans-serif`;
  ctx.font = font;
  ctx.lineWidth = Math.max(2, Math.round(W / 400));

  // 正解 = 緑の破線
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#3ddc84';
  for (const g of spec.gt ?? []) {
    const x = g.box.x * W;
    const y = g.box.y * H;
    const w = g.box.w * W;
    const h = g.box.h * H;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(61, 220, 132, 0.9)';
    ctx.fillText(`GT:${g.category}`, x + 2, Math.max(12, y - 4));
  }
  ctx.setLineDash([]);

  // 検出 = 赤の実線
  for (const d of dets) {
    const x = d.box.x * W;
    const y = d.box.y * H;
    const w = d.box.w * W;
    const h = d.box.h * H;
    ctx.strokeStyle = d.category === 'face' ? '#ffd166' : d.category === 'plate' ? '#4cc9f0' : '#ff5d73';
    ctx.strokeRect(x, y, w, h);
    const label = `${d.label} ${d.category}`;
    const tw = ctx.measureText(label).width;
    const ly = Math.max(12, y - 4);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(x, ly - font.length * 0.8, tw + 6, font.length * 1.1);
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.fillText(label, x + 3, ly);
  }
  return canvas;
}

function emptyAgg(): Agg {
  return { images: 0, gt: 0, gtCovered: 0, det: 0, detMatched: 0, ms: 0, errors: 0 };
}

function addTo(agg: Agg, r: ImageResult): void {
  agg.images += 1;
  agg.gt += r.gt.length;
  agg.gtCovered += r.gtCovered;
  agg.det += r.detections.length;
  agg.detMatched += r.detMatched;
  agg.ms += r.ms;
}

function summarize(results: ImageResult[]): Summary {
  const overall = emptyAgg();
  const byCategory: Partial<Record<Category, Agg>> = {};
  for (const r of results) {
    addTo(overall, r);
    if (r.error) overall.errors += 1;
    const cats = new Set<Category>([
      ...r.gt.map((g) => g.category),
      ...r.detections.map((d) => d.category),
    ]);
    for (const c of cats) {
      const agg = (byCategory[c] ??= emptyAgg());
      agg.images += 1;
      agg.gt += r.gt.filter((g) => g.category === c).length;
      agg.gtCovered += r.perGt.filter((p) => p.category === c && p.covered).length;
      const dets = r.detections.filter((d) => d.category === c);
      agg.det += dets.length;
      agg.detMatched += dets.filter((d) => r.matchedDets.includes(r.detections.indexOf(d))).length;
      agg.ms += r.ms;
      if (r.error) agg.errors += 1;
    }
  }
  return { overall, byCategory };
}

async function runImage(spec: ImageSpec): Promise<ImageResult> {
  const started = performance.now();
  const result: ImageResult = {
    id: spec.id,
    file: spec.file,
    tags: spec.tags ?? [],
    note: spec.note,
    ms: 0,
    detections: [],
    gt: spec.gt ?? [],
    expect: spec.expect,
    gtCovered: 0,
    detMatched: 0,
    counts: {},
    misses: [],
    extras: [],
    labelMismatch: 0,
    perGt: [],
    matchedDets: [],
  };
  let raster: ImageBitmap | null = null;
  try {
    setStatus(`${spec.id}: 読み込み中…`);
    const res = await fetch(`/${spec.file}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`画像を取得できません (${res.status})`);
    const blob = await res.blob();
    raster = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    setStatus(`${spec.id}: 検出中…`);
    result.detections = await detect(raster, {
      provider: 'local',
      ocr: true,
      refineFaces: false,
      ollamaEndpoint: '',
      ollamaModel: '',
      onProgress: (m) => setStatus(`${spec.id}: ${m}`),
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.ms = Math.round(performance.now() - started);
  }

  // 照合
  const matchedDets = new Set<number>();
  const perGt: { category: Category; covered: boolean }[] = [];
  const misses: GtItem[] = [];
  let labelMismatch = 0;
  for (const g of result.gt) {
    let covered = false;
    result.detections.forEach((d, i) => {
      if (isHit(g.box, d.box)) {
        covered = true;
        matchedDets.add(i);
        if (d.category !== g.category) labelMismatch += 1;
      }
    });
    perGt.push({ category: g.category, covered });
    if (!covered) misses.push(g);
  }
  result.misses = misses;
  result.extras = result.detections.filter((_, i) => !matchedDets.has(i));
  result.gtCovered = perGt.filter((p) => p.covered).length;
  result.detMatched = matchedDets.size;
  result.labelMismatch = labelMismatch;
  result.counts = countByCategory(result.detections);
  result.perGt = perGt;
  result.matchedDets = [...matchedDets];

  // 表示用
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  const status =
    result.error
      ? `<span class="err">ERROR: ${result.error}</span>`
      : `検出 ${result.detections.length} / 正解 ${result.gt.length}（一致 ${result.gtCovered}） / ${result.ms}ms`;
  caption.innerHTML = `<b>${spec.id}</b> — ${status}<br>${spec.file}${spec.note ? `<br>${spec.note}` : ''}`;
  figure.appendChild(caption);
  if (raster) figure.appendChild(drawOverlay(spec, raster, result.detections));
  imagesEl.appendChild(figure);

  if (raster) raster.close();
  return result;
}

function pct(n: number, d: number): string {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

function renderSummary(summary: Summary): void {
  const rows: { name: string; agg: Agg }[] = [
    { name: '全体', agg: summary.overall },
    ...Object.entries(summary.byCategory).map(([k, v]) => ({ name: k, agg: v as Agg })),
  ];
  const table = document.createElement('table');
  table.id = 'summary';
  table.innerHTML = `
    <thead><tr>
      <th>対象</th><th>画像</th><th>正解</th><th>検出</th><th>再現率</th><th>適合率</th><th>平均時間</th><th>エラー</th>
    </tr></thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody') as HTMLTableSectionElement;
  for (const { name, agg } of rows) {
    const tr = document.createElement('tr');
    const recall = agg.gt > 0 ? agg.gtCovered / agg.gt : 1;
    const precision = agg.det > 0 ? agg.detMatched / agg.det : 1;
    if (agg.gt > 0 && (recall < 0.8 || precision < 0.8)) tr.className = 'bad';
    tr.innerHTML = `
      <td>${name}</td>
      <td>${agg.images}</td>
      <td>${agg.gt}</td>
      <td>${agg.det}</td>
      <td>${agg.gt ? `${agg.gtCovered}/${agg.gt} (${pct(agg.gtCovered, agg.gt)})` : '—'}</td>
      <td>${agg.det ? `${agg.detMatched}/${agg.det} (${pct(agg.detMatched, agg.det)})` : '—'}</td>
      <td>${Math.round(agg.ms / Math.max(1, agg.images))}ms</td>
      <td>${agg.errors}</td>`;
    tbody.appendChild(tr);
  }
  summaryHost.appendChild(table);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const filter = params.get('filter');
  const [manual, synthetic] = await Promise.all([
    loadDataset('/test-eval/dataset.json'),
    loadDataset('/test-image-secret/synthetic/dataset.json'),
  ]);
  let specs = [...manual.images, ...synthetic.images];
  if (filter) specs = specs.filter((s) => s.id.includes(filter) || (s.tags ?? []).includes(filter));

  setStatus(`評価する画像: ${specs.length} 枚`);
  const results: ImageResult[] = [];
  for (const spec of specs) {
    results.push(await runImage(spec));
  }
  const summary = summarize(results);
  renderSummary(summary);
  setStatus(`完了: ${results.length} 枚`);

  const overlays: Record<string, string> = {};
  for (const canvas of imagesEl.querySelectorAll('canvas')) {
    const id = (canvas as HTMLCanvasElement).dataset.id;
    if (id) overlays[id] = (canvas as HTMLCanvasElement).toDataURL('image/png');
  }
  window.__OVERLAYS = overlays;
  window.__EVAL = { done: true, results, summary };
}

declare global {
  interface Window {
    __EVAL?: { done: boolean; results: ImageResult[]; summary: Summary; fatal?: string };
    __OVERLAYS?: Record<string, string>;
  }
}

main().catch((err) => {
  setStatus(`致命的なエラー: ${String(err)}`);
  window.__EVAL = {
    done: true,
    fatal: err instanceof Error ? err.stack ?? err.message : String(err),
    results: [],
    summary: { overall: emptyAgg(), byCategory: {} },
  };
});
