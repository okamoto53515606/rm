import type { Detection, Raster } from './types';

type Progress = (message: string) => void;

const OCR_MAX_SIDE = 1600;

/** 小さいスクショは拡大してからOCRにかける（小さい文字の認識率が上がる） */
function prepareOcrCanvas(raster: Raster): HTMLCanvasElement {
  const longSide = Math.max(raster.width, raster.height);
  const scale =
    longSide < OCR_MAX_SIDE
      ? Math.min(2, OCR_MAX_SIDE / longSide)
      : Math.min(1, OCR_MAX_SIDE / longSide);
  const width = Math.max(1, Math.round(raster.width * scale));
  const height = Math.max(1, Math.round(raster.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(raster, 0, 0, width, height);
  }
  return canvas;
}

// ===== 検出パターン =====
// 完璧ではないが、APIキー・連絡先・端末情報の「見落とし」を減らすための保険。
const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: '秘密鍵' },
  // OCR は 0 を @ と読み違えることがあるため、@ も許容する
  { re: /\bAIza[0-9A-Za-z_@-]{25,}\b/i, label: 'APIキー' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/i, label: 'AWSキー' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/i, label: 'APIキー' },
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i, label: 'トークン' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i, label: 'トークン' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, label: 'トークン' },
  // 既に一部が伏せ字のキー（sk-3045e*******f75a など。OCR の空白揺れを許容）
  {
    re: /\bsk-[A-Za-z0-9]{2,}\s*[^A-Za-z0-9\s]{2,}\s*[A-Za-z0-9]{2,}\b/i,
    label: 'APIキー',
  },
  // UUID（完全形・中略形）
  {
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    label: 'ID（UUID）',
  },
  { re: /\b[0-9a-f]{6,}-[0-9a-f]{2,}(?:\.{2,}|…)[0-9a-f]{4,}\b/i, label: 'ID' },
  // 日付+名前のキー名（20261010-vscode-github-copilot など）
  { re: /\b20\d{6}-[A-Za-z0-9_-]{3,}\b/i, label: 'キー名/ID' },
  { re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i, label: '認証付きURL' },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, label: 'メールアドレス' },
  // ターミナルのプロンプト（OCRの空白揺れを許容）
  {
    re: /(?:^|\s)[A-Za-z0-9._-]+\s*@\s*[A-Za-z0-9._-]+(?:\s*-\s*[A-Za-z0-9._-]+)?\s*[:~][^\n]*[$#]/,
    label: 'ユーザー名・ホスト・パス',
  },
  { re: /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+/, label: 'ユーザー名・パス' },
  // 環境変数風の代入（GEMINI_API_KEY = ... など）
  {
    re: /(?:^|\s)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=]\s*\S+/,
    label: '認証情報',
  },
  {
    re: /(?:^|[^A-Za-z0-9])(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*\S+/i,
    label: '認証情報',
  },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, label: 'IPアドレス' },
  // 日本のナンバープレート。1行に収まる場合（例: 品川 330 あ 12-34）
  {
    re: /[一-龥]{1,4}\s*\d{2,3}\s*[-−–—－ー‐]?\s*[ぁ-ん]\s*\d{2,4}(?:\s*[-−–—－ー‐]\s*\d{1,4})?/,
    label: 'ナンバープレート',
  },
  // 2段組みの上段（地名＋分類番号。例: 品川 330）
  { re: /[一-龥]{1,4}\s*\d{2,3}$/, label: 'ナンバープレート' },
  // 2段組みの下段（ひらがな＋番号。例: あ 12-34）
  { re: /[ぁ-ん]\s*\d{2,4}\s*[-−–—－ー‐]\s*\d{2,4}$/, label: 'ナンバープレート候補' },
  // 下段の番号のみ読めた場合（例: «12-34, = / m< 12-34）。前後の誤読ノイズを少し許容する
  {
    re: /^.{0,6}\d{2,4}\s*[-−–—－ー‐]\s*\d{2,4}.{0,4}$/,
    label: 'ナンバープレート候補',
  },
  // ナンバープレートの数字部分（OCRは日本語部分を読めないため、数字列で拾う）
  {
    re: /\b\d{2,3}\b[^\n]{0,16}?\b\d{1,2}\s*[-−–—－ー‐]\s*\d{2,4}\b/,
    label: 'ナンバープレート候補',
  },
  { re: /^\d{2,4}\s*[-−–—－ー‐]\s*\d{2,4}$/, label: '数字列（ナンバー候補）' },
];

/** 1行のテキストから隠すべき情報を判定する */
export function matchSecret(text: string): string | null {
  for (const p of PATTERNS) {
    if (p.re.test(text)) return p.label;
  }
  return null;
}

// ===== Tesseract =====

type TesseractWorker = {
  recognize: (
    image: HTMLCanvasElement,
    options?: object,
    output?: object,
  ) => Promise<{ data: { blocks?: { paragraphs?: { lines?: OcrLine[] }[] }[] | null } }>;
  /** ページ分割モードなどのパラメータを切り替える */
  setParameters: (params: Record<string, string>) => Promise<unknown>;
};

interface OcrLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

let workerPromise: Promise<TesseractWorker> | null = null;
let progressSink: Progress | undefined;

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const base = new URL('./', document.baseURI).href;
      const options = {
        workerPath: new URL('ocr/worker.min.js', base).href,
        corePath: new URL('ocr/core', base).href,
        langPath: new URL('ocr/tessdata', base).href,
        cacheMethod: 'none',
        gzip: false,
        workerBlobURL: false,
        logger: (m: { status?: string; progress?: number }) => {
          if (!progressSink || !m.status) return;
          if (m.status === 'recognizing text') {
            progressSink(`OCR ${Math.round((m.progress ?? 0) * 100)}%`);
          } else if (/loading|initializing|language/i.test(m.status)) {
            progressSink('OCR エンジンを準備中…');
          }
        },
      };
      // 英語＋日本語。日本語モデルが無い場合は英語のみで続行する
      try {
        return (await createWorker('eng+jpn', 1, options)) as unknown as TesseractWorker;
      } catch (err) {
        console.warn('[ocr] 日本語モデルを読み込めないため英語のみで続行します', err);
        return (await createWorker('eng', 1, options)) as unknown as TesseractWorker;
      }
    })().catch((err) => {
      workerPromise = null;
      throw new Error(`OCR エンジンを読み込めませんでした: ${String(err)}`);
    });
  }
  return workerPromise;
}

/** 暗い画面（ターミナル等）は白黒反転してからOCRにかける */
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

/**
 * ブラウザ内OCR（外部送信なし）。
 * 英語＋日本語モデルを使用。APIキー・メール・端末プロンプト・パス・
 * 日本語のナンバープレートなどを検出する。
 */
export async function detectTextLocal(
  raster: Raster,
  onProgress?: Progress,
): Promise<Detection[]> {
  progressSink = onProgress;
  onProgress?.('OCR エンジンを準備中…');

  const canvas = prepareOcrCanvas(raster);
  invertIfDark(canvas);

  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: PSM_AUTO });
  onProgress?.('OCR 実行中…');
  const base = await worker.recognize(canvas, {}, { blocks: true, text: true });

  const out = linesToDetections(collectLines(base.data), canvas.width, canvas.height);

  // ナンバープレートは写真全体では小さすぎて読めないことが多い。
  // 見つからなければ、白くて明るい「プレートらしい領域」を探して拡大し直す。
  if (!out.some((d) => PLATE_LABELS.has(d.label))) {
    const plates = await detectPlatesInPhoto(worker, raster, onProgress);
    for (const d of plates) {
      if (out.some((e) => iou(e.box, d.box) > 0.3)) continue;
      out.push(d);
    }
  }
  return out;
}

const PSM_AUTO = '3';
const PSM_SINGLE_BLOCK = '6';

const PLATE_LABELS = new Set([
  'ナンバープレート',
  'ナンバープレート候補',
  '数字列（ナンバー候補）',
]);

/** プレートの縦横比（330mm x 165mm） */
const PLATE_ASPECT = 2.2;
/** 切り出し画像の幅（小さめのほうが Tesseract は読みやすい） */
const PLATE_CROP_TARGET_PX = 700;
/** 切り出し時の余白（プレートの外側に少し背景を入れると読みやすい） */
const PLATE_CROP_PADDING = 0.12;
/** ホットスポット探索の解像度 */
const HOTSPOT_WIDTH = 240;
/** 「白い」とみなす明るさ（0〜1） */
const WHITE_COLUMN_THRESHOLD = 0.45;

function collectLines(data: {
  blocks?: { paragraphs?: { lines?: OcrLine[] }[] }[] | null;
}): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) lines.push(line);
    }
  }
  return lines;
}

/**
 * OCR の行を、画像全体に対する 0〜1 の矩形へ変換する。
 */
function linesToDetections(
  lines: OcrLine[],
  width: number,
  height: number,
): Detection[] {
  const padX = Math.max(6, Math.round(width * 0.012));
  const padY = Math.max(4, Math.round(height * 0.008));
  const out: Detection[] = [];

  for (const line of lines) {
    const text = (line.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const label = matchSecret(text);
    if (!label) continue;

    const x0 = Math.max(0, line.bbox.x0 - padX);
    const y0 = Math.max(0, line.bbox.y0 - padY);
    const x1 = Math.min(width, line.bbox.x1 + padX);
    const y1 = Math.min(height, line.bbox.y1 + padY);
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;

    out.push({
      category: 'secret',
      label,
      box: {
        x: x0 / width,
        y: y0 / height,
        w: (x1 - x0) / width,
        h: (y1 - y0) / height,
      },
    });
  }
  return out;
}

function iou(a: { x: number; y: number; w: number; h: number }, b: typeof a): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

type Box = { x: number; y: number; w: number; h: number };

function clampBox(box: Box): Box {
  const x = Math.min(1, Math.max(0, box.x));
  const y = Math.min(1, Math.max(0, box.y));
  return {
    x,
    y,
    w: Math.min(1 - x, Math.max(0, box.w)),
    h: Math.min(1 - y, Math.max(0, box.h)),
  };
}

/**
 * 白くて明るい「プレートらしい領域」を探す。
 * 明るさのムラに強いよう、まず小さい窓で白い部分を探し、
 * その窓を横・縦に広げてプレート全体の矩形を求める。
 */
function findPlateRegion(raster: Raster): Box | null {
  const width = raster.width;
  const height = raster.height;
  const sw = HOTSPOT_WIDTH;
  const sh = Math.max(8, Math.round((sw * height) / width));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(raster, 0, 0, sw, sh);
  const px = ctx.getImageData(0, 0, sw, sh).data;

  // 白さ = 3 チャンネルの最小値（プレートは無彩色で明るい）
  const white = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i += 1) {
    white[i] = Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) / 255;
  }

  const iw = sw + 1;
  const integral = new Float64Array(iw * (sh + 1));
  for (let y = 0; y < sh; y += 1) {
    let row = 0;
    for (let x = 0; x < sw; x += 1) {
      row += white[y * sw + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + row;
    }
  }
  const sumRect = (x0: number, y0: number, x1: number, y1: number) =>
    integral[y1 * iw + x1] - integral[y0 * iw + x1] - integral[y1 * iw + x0] + integral[y0 * iw + x0];

  // 1) プレートの比率（横長）で、最も白い小窓を探す
  let seed = { score: 0, x: 0, y: 0, w: 0, h: 0 };
  for (let wf = 0.1; wf <= 0.4; wf += 0.02) {
    const bw = Math.round(sw * wf);
    const bh = Math.max(4, Math.round(bw / PLATE_ASPECT));
    const stepX = Math.max(2, Math.round(bw / 4));
    const stepY = Math.max(2, Math.round(bh / 2));
    for (let y0 = 0; y0 + bh <= sh; y0 += stepY) {
      for (let x0 = 0; x0 + bw <= sw; x0 += stepX) {
        const score = sumRect(x0, y0, x0 + bw, y0 + bh) / (bw * bh);
        if (score > seed.score) seed = { score, x: x0, y: y0, w: bw, h: bh };
      }
    }
  }
  if (seed.score < 0.55) return null;

  // 2) 種の帯の中で、白い列が続く範囲まで左右に広げる＝プレートの横幅
  const bandY0 = seed.y;
  const bandY1 = seed.y + seed.h;
  const bandH = Math.max(1, bandY1 - bandY0);
  const colMean: number[] = [];
  for (let x = 0; x < sw; x += 1) colMean.push(sumRect(x, bandY0, x + 1, bandY1) / bandH);
  const run = growRange(colMean, seed.x, seed.x + seed.w - 1, WHITE_COLUMN_THRESHOLD, 5);

  // 3) その横幅の中で、白い行が続く範囲まで上下に広げる＝プレートの高さ
  const rowMean: number[] = [];
  for (let y = 0; y < sh; y += 1) rowMean.push(sumRect(run[0], y, run[1] + 1, y + 1) / (run[1] + 1 - run[0]));
  const rows = growRange(rowMean, bandY0, bandY1 - 1, WHITE_COLUMN_THRESHOLD, 3);

  const box: Box = {
    x: run[0] / sw,
    y: rows[0] / sh,
    w: (run[1] + 1 - run[0]) / sw,
    h: (rows[1] + 1 - rows[0]) / sh,
  };
  // 極端な形（画面の大半・細すぎる帯）はプレートとみなさない
  if (box.w < 0.08 || box.w > 0.9 || box.h < 0.01 || box.h > 0.5) return null;
  const aspect = (box.w * width) / (box.h * height);
  if (aspect < 1.3 || aspect > 4.5) return null;
  return box;
}

/** しきい値を超える範囲を、小さな切れ目（gap 個まで）を許して左右へ広げる */
function growRange(
  values: number[],
  from: number,
  to: number,
  threshold: number,
  gap: number,
): [number, number] {
  let a = Math.max(0, Math.min(from, to));
  let b = Math.min(values.length - 1, Math.max(from, to));
  let miss = 0;
  while (a > 0) {
    if (values[a - 1] > threshold) {
      a -= 1;
      miss = 0;
    } else if (miss < gap) {
      miss += 1;
      a -= 1;
    } else break;
  }
  miss = 0;
  while (b < values.length - 1) {
    if (values[b + 1] > threshold) {
      b += 1;
      miss = 0;
    } else if (miss < gap) {
      miss += 1;
      b += 1;
    } else break;
  }
  return [a, b];
}

function padBox(box: Box, pad: number): Box {
  return clampBox({
    x: box.x - box.w * pad,
    y: box.y - box.h * pad,
    w: box.w * (1 + pad * 2),
    h: box.h * (1 + pad * 2),
  });
}

/** 元画像から切り出して、読みやすい大きさに整える */
function cropForOcr(
  raster: Raster,
  box: Box,
  targetWidth: number,
): HTMLCanvasElement | null {
  const sx = box.x * raster.width;
  const sy = box.y * raster.height;
  const sw = box.w * raster.width;
  const sh = box.h * raster.height;
  if (sw < 8 || sh < 6) return null;
  const scale = Math.min(3, targetWidth / sw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(raster, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * 写真からナンバープレートを探す。
 * 明るい矩形（プレート）を切り出して拡大し、番号らしき文字が読めたらその矩形を隠す。
 * 候補は 1 つだけ試して、読めなければ諦める（リトライしない）。
 */
async function detectPlatesInPhoto(
  worker: TesseractWorker,
  raster: Raster,
  onProgress?: Progress,
): Promise<Detection[]> {
  const region = findPlateRegion(raster);
  if (!region) return [];

  const crop = cropForOcr(raster, padBox(region, PLATE_CROP_PADDING), PLATE_CROP_TARGET_PX);
  if (!crop) return [];

  onProgress?.('OCR ナンバープレートを確認中…');
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_BLOCK });
    const { data } = await worker.recognize(crop, {}, { blocks: true, text: true });
    const hit = collectLines(data).some((line) => {
      const text = (line.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return false;
      const label = matchSecret(text);
      return label !== null && PLATE_LABELS.has(label);
    });
    if (!hit) return [];
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: PSM_AUTO });
  }

  // 数字が読めた = プレートとみなし、プレート全体を隠す
  return [
    {
      category: 'secret',
      label: 'ナンバープレート',
      box: region,
    },
  ];
}
