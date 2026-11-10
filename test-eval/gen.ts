// テスト画像の合成ジェネレータ（ブラウザ内 canvas で描画）。
// 実際の写真では正解矩形を人手で測る必要があるが、合成画像なら
// 描画した位置がそのまま正解になるので、再現率・適合率を自動計算できる。
// 生成物は test-image-secret/synthetic/ に書き出す（gitignore 済み）。

type Category = 'face' | 'plate' | 'secret' | 'other';
type BoxN = { x: number; y: number; w: number; h: number };
type BoxP = { x: number; y: number; w: number; h: number };

interface GtItem {
  category: Category;
  box: BoxN;
  note?: string;
}

interface GenItem {
  id: string;
  file: string;
  tags: string[];
  expect: Partial<Record<Category, number>>;
  gt: GtItem[];
  note?: string;
  png: string;
}

type Scene = {
  canvas: HTMLCanvasElement;
  gt: GtItem[];
  expect: Partial<Record<Category, number>>;
  note?: string;
};

function create(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function ctxOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  return ctx;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function norm(b: BoxP, w: number, h: number): BoxN {
  return { x: b.x / w, y: b.y / h, w: b.w / w, h: b.h / h };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ===== 背景・車 =====

function drawAsphalt(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number): void {
  ctx.fillStyle = '#5f6165';
  ctx.fillRect(0, 0, w, h);
  const rnd = rng(seed);
  for (let i = 0; i < Math.round((w * h) / 900); i += 1) {
    const g = 70 + Math.round(rnd() * 90);
    ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.25 + rnd() * 0.4})`;
    const s = 1 + rnd() * 3;
    ctx.fillRect(rnd() * w, rnd() * h, s, s);
  }
}

function drawCar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  body: string,
): void {
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, body);
  grad.addColorStop(1, '#20251f');
  ctx.fillStyle = grad;
  roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.08);
  ctx.fill();

  // グリル
  ctx.fillStyle = '#14171a';
  roundRect(ctx, x + w * 0.06, y + h * 0.14, w * 0.88, h * 0.42, h * 0.05);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200,205,210,0.22)';
  ctx.lineWidth = Math.max(1, h * 0.006);
  for (let i = 1; i < 7; i += 1) {
    const yy = y + h * 0.14 + (h * 0.42 * i) / 7;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.08, yy);
    ctx.lineTo(x + w * 0.92, yy);
    ctx.stroke();
  }
}

/** ナンバープレートを描き、回転後の外接矩形（ピクセル）を返す */
function drawPlate(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { region: string; classNo: string; kana: string; num: string; rotate?: number; dim?: boolean },
): BoxP {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = ((opts.rotate ?? 0) * Math.PI) / 180;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rad);

  roundRect(ctx, -w / 2, -h / 2, w, h, h * 0.06);
  ctx.fillStyle = opts.dim ? '#c6c6c1' : '#f5f5ef';
  ctx.fill();
  ctx.strokeStyle = opts.dim ? '#58705b' : '#2e7d32';
  ctx.lineWidth = Math.max(2, h * 0.018);
  ctx.stroke();

  ctx.fillStyle = opts.dim ? '#436046' : '#1b5e20';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(h * 0.2)}px "Noto Sans CJK JP", "IPAGothic", sans-serif`;
  ctx.fillText(`${opts.region} ${opts.classNo}`, 0, -h * 0.25);
  ctx.font = `bold ${Math.round(h * 0.4)}px "Noto Sans CJK JP", "IPAGothic", sans-serif`;
  ctx.fillText(`${opts.kana} ${opts.num}`, 0, h * 0.17);
  ctx.restore();

  const bw = w * Math.abs(Math.cos(rad)) + h * Math.abs(Math.sin(rad));
  const bh = w * Math.abs(Math.sin(rad)) + h * Math.abs(Math.cos(rad));
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}

/** 文字を描いて、その行の矩形を返す */
function drawTextLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string,
): BoxP {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
  const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 20);
  return { x, y, w: ctx.measureText(text).width, h: size * 1.15 };
}

// ===== シーン =====

function scenePlateClear(): Scene {
  const W = 1600;
  const H = 1200;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  drawAsphalt(ctx, W, H, 11);
  drawCar(ctx, 120, 250, 1360, 820, '#3d4b40');
  const box = drawPlate(ctx, 580, 600, 440, 220, {
    region: '品川',
    classNo: '330',
    kana: 'あ',
    num: '12-34',
  });
  return {
    canvas,
    gt: [{ category: 'plate', box: norm(box, W, H) }],
    expect: { plate: 1 },
    note: '正面・等倍に近いプレート（合成）',
  };
}

function scenePlateSmall(): Scene {
  const W = 2000;
  const H = 1500;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  drawAsphalt(ctx, W, H, 21);
  drawCar(ctx, 200, 350, 1600, 1000, '#4a4f58');
  const box = drawPlate(ctx, 1010, 840, 260, 130, {
    region: '多摩',
    classNo: '304',
    kana: 'む',
    num: '56-78',
  });
  return {
    canvas,
    gt: [{ category: 'plate', box: norm(box, W, H) }],
    expect: { plate: 1 },
    note: '小さいプレート（長辺 2000px 中の 260px）',
  };
}

function scenePlateRotated(): Scene {
  const W = 1600;
  const H = 1200;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  drawAsphalt(ctx, W, H, 31);
  drawCar(ctx, 150, 280, 1300, 780, '#37404a');
  const box = drawPlate(ctx, 560, 610, 440, 220, {
    region: '練馬',
    classNo: '330',
    kana: 'さ',
    num: '98-76',
    rotate: -8,
  });
  return {
    canvas,
    gt: [{ category: 'plate', box: norm(box, W, H) }],
    expect: { plate: 1 },
    note: '8度傾いたプレート',
  };
}

function scenePlateTwo(): Scene {
  const W = 1800;
  const H = 1200;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  drawAsphalt(ctx, W, H, 41);
  drawCar(ctx, 40, 250, 820, 820, '#3a3f3a');
  drawCar(ctx, 940, 250, 820, 820, '#3f3a3a');
  const b1 = drawPlate(ctx, 260, 640, 380, 190, {
    region: '品川',
    classNo: '330',
    kana: 'あ',
    num: '11-11',
  });
  const b2 = drawPlate(ctx, 1160, 640, 380, 190, {
    region: '横浜',
    classNo: '330',
    kana: 'か',
    num: '22-22',
  });
  return {
    canvas,
    gt: [
      { category: 'plate', box: norm(b1, W, H) },
      { category: 'plate', box: norm(b2, W, H) },
    ],
    expect: { plate: 2 },
    note: '1枚に2台（プレート2枚）',
  };
}

function scenePlateNight(): Scene {
  const W = 1600;
  const H = 1200;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  ctx.fillStyle = '#171a1d';
  ctx.fillRect(0, 0, W, H);
  const rnd = rng(51);
  for (let i = 0; i < 900; i += 1) {
    const g = Math.round(rnd() * 40);
    ctx.fillStyle = `rgba(${g},${g},${g},0.5)`;
    ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
  }
  drawCar(ctx, 200, 320, 1200, 760, '#262b30');
  const box = drawPlate(ctx, 600, 640, 400, 200, {
    region: '大阪',
    classNo: '330',
    kana: 'な',
    num: '33-44',
    dim: true,
  });
  return {
    canvas,
    gt: [{ category: 'plate', box: norm(box, W, H) }],
    expect: { plate: 1 },
    note: '夜間・低コントラストのプレート',
  };
}

function scenePlateWallNegative(): Scene {
  const W = 1600;
  const H = 1200;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  ctx.fillStyle = '#cfc9bf';
  ctx.fillRect(0, 0, W, H);
  const rnd = rng(61);
  for (let y = 0; y < H; y += 40) {
    for (let x = 0; x < W; x += 80) {
      const g = 190 + Math.round(rnd() * 30);
      ctx.fillStyle = `rgb(${g},${g - 6},${g - 14})`;
      ctx.fillRect(x + 1, y + 1, 78, 38);
    }
  }
  // プレートではない白い横長の看板
  ctx.fillStyle = '#f2f2ee';
  ctx.fillRect(520, 520, 560, 160);
  ctx.fillStyle = '#9a9a96';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PARKING', 800, 600);
  return {
    canvas,
    gt: [],
    expect: { plate: 0 },
    note: '白い看板（プレートではない）→ 誤検出の確認',
  };
}

function secretLinesScene(
  id: string,
  opts: {
    bg: string;
    fg: string;
    lines: { text: string; secret: boolean }[];
    width?: number;
    height?: number;
    font?: string;
    lineHeight?: number;
    note?: string;
  },
): Scene {
  const W = opts.width ?? 1400;
  const H = opts.height ?? 800;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, W, H);
  const font = opts.font ?? '26px "DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace';
  const lh = opts.lineHeight ?? 70;
  const gt: GtItem[] = [];
  let y = 120;
  for (const line of opts.lines) {
    const box = drawTextLine(ctx, line.text, 60, y, font, opts.fg);
    if (line.secret) gt.push({ category: 'secret', box: norm(box, W, H), note: line.text.slice(0, 24) });
    y += lh;
  }
  void id;
  return {
    canvas,
    gt,
    expect: { secret: gt.length },
    note: opts.note,
  };
}

function sceneSecretLight(): Scene {
  return secretLinesScene('secret_light', {
    bg: '#ffffff',
    fg: '#1b1e23',
    lines: [
      { text: 'OPENAI_API_KEY=sk-proj-TESTAbCdEfGhIjKlMnOpQrStUvWx', secret: true },
      { text: 'AWS_ACCESS_KEY_ID=AKIATEST000000000000', secret: true },
      { text: 'GITHUB_TOKEN=ghp_TESTAbCdEfGhIjKlMnOpQrStUvWxYz01', secret: true },
      { text: 'DATABASE_URL=postgres://demo:password@db.internal:5432/app', secret: true },
    ],
    note: '明るい画面のキー4種（合成）',
  });
}

function sceneSecretTerminal(): Scene {
  return secretLinesScene('secret_terminal', {
    bg: '#14171f',
    fg: '#d7dae0',
    font: '24px "DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace',
    lineHeight: 64,
    lines: [
      {
        text: 'user@dev-box:~/work$ export OPENAI_API_KEY=sk-test-AbCdEfGhIjKlMnOpQrStUv',
        secret: true,
      },
      { text: 'user@dev-box:~/work$ cat ~/.ssh/id_rsa', secret: true },
      { text: '-----BEGIN OPENSSH PRIVATE KEY-----', secret: true },
      { text: 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', secret: false },
      { text: '-----END OPENSSH PRIVATE KEY-----', secret: false },
    ],
    note: '暗いターミナル（反転処理の確認）',
  });
}

function sceneSecretTable(): Scene {
  const W = 1400;
  const H = 520;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#16181d';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('API keys', 60, 40);

  const font = '24px "DejaVu Sans Mono", monospace';
  const gt: GtItem[] = [];
  const rows = [
    {
      name: '20261010-vscode-github-copilot',
      tracking: '48ce16a0-36c ... 529a197ef6df',
      key: 'sk-3045e*******f75a',
      created: '2026-10-10',
      used: '2026-11-05',
    },
    {
      name: '20260704-okamo-app',
      tracking: 'ca98d83b-bcf ... 90b46b6e1ec6',
      key: 'sk-1e125******7209',
      created: '2026-07-04',
      used: '2026-11-07',
    },
  ];
  let y = 120;
  for (const row of rows) {
    const tb = drawTextLine(ctx, row.tracking, 350, y, font, '#16181d');
    const kb = drawTextLine(ctx, row.key, 700, y, font, '#16181d');
    gt.push({ category: 'secret', box: norm(tb, W, H) });
    gt.push({ category: 'secret', box: norm(kb, W, H) });
    drawTextLine(ctx, row.name, 60, y, font, '#16181d');
    drawTextLine(ctx, row.created, 950, y, font, '#5b6270');
    drawTextLine(ctx, row.used, 1110, y, font, '#5b6270');
    y += 100;
  }
  return {
    canvas,
    gt,
    expect: { secret: gt.length },
    note: '表形式（追跡ID＋マスク済みキー）',
  };
}

function sceneSecretNegative(): Scene {
  const W = 1400;
  const H = 800;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#24272e';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '30px "Noto Sans CJK JP", system-ui, sans-serif';
  const lines = [
    'これはテスト用のスクリーンショットです。',
    '特に隠す必要のある情報は含まれていません。',
    '本日の会議は 15 時からです。資料は共有フォルダにあります。',
    'よろしくお願いします。',
  ];
  lines.forEach((line, i) => ctx.fillText(line, 80, 120 + i * 80));
  return {
    canvas,
    gt: [],
    expect: { secret: 0 },
    note: '機密情報なし → 誤検出の確認',
  };
}

async function loadBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  bmp: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
): BoxP {
  const scale = Math.min(w / bmp.width, h / bmp.height);
  const dw = bmp.width * scale;
  const dh = bmp.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.drawImage(bmp, dx, dy, dw, dh);
  return { x: dx, y: dy, w: dw, h: dh };
}

async function sceneFacesTwo(): Promise<Scene | null> {
  const [obama, biden] = await Promise.all([
    loadBitmap('/test-image-secret/faces/obama.jpg'),
    loadBitmap('/test-image-secret/faces/biden.jpg'),
  ]);
  if (!obama || !biden) return null;
  const W = 1600;
  const H = 1000;
  const canvas = create(W, H);
  const ctx = ctxOf(canvas);
  ctx.fillStyle = '#e9e9e4';
  ctx.fillRect(0, 0, W, H);
  const a = drawContain(ctx, obama, 60, 90, 700, 820);
  const b = drawContain(ctx, biden, 820, 90, 700, 820);
  // 顔の位置はおおよそ（人物写真の中央上部）
  const gt: GtItem[] = [
    {
      category: 'face',
      box: norm({ x: a.x + a.w * 0.18, y: a.y + a.h * 0.04, w: a.w * 0.64, h: a.h * 0.62 }, W, H),
    },
    {
      category: 'face',
      box: norm({ x: b.x + b.w * 0.18, y: b.y + b.h * 0.04, w: b.w * 0.64, h: b.h * 0.62 }, W, H),
    },
  ];
  return {
    canvas,
    gt,
    expect: { face: 2 },
    note: '2人の顔（公有領域の肖像を合成）',
  };
}

async function build(): Promise<GenItem[]> {
  const scenes: { id: string; tags: string[]; scene: Scene }[] = [
    { id: 'plate_clear', tags: ['plate', 'synthetic'], scene: scenePlateClear() },
    { id: 'plate_small', tags: ['plate', 'synthetic'], scene: scenePlateSmall() },
    { id: 'plate_rotated', tags: ['plate', 'synthetic'], scene: scenePlateRotated() },
    { id: 'plate_two', tags: ['plate', 'synthetic'], scene: scenePlateTwo() },
    { id: 'plate_night', tags: ['plate', 'synthetic'], scene: scenePlateNight() },
    { id: 'plate_wall_negative', tags: ['plate', 'synthetic', 'negative'], scene: scenePlateWallNegative() },
    { id: 'secret_light', tags: ['secret', 'synthetic'], scene: sceneSecretLight() },
    { id: 'secret_terminal', tags: ['secret', 'synthetic'], scene: sceneSecretTerminal() },
    { id: 'secret_table_masked', tags: ['secret', 'synthetic'], scene: sceneSecretTable() },
    { id: 'secret_negative', tags: ['secret', 'synthetic', 'negative'], scene: sceneSecretNegative() },
  ];
  const faces = await sceneFacesTwo();
  if (faces) scenes.push({ id: 'faces_two', tags: ['face', 'synthetic'], scene: faces });

  return scenes.map(({ id, tags, scene }) => ({
    id,
    file: `test-image-secret/synthetic/${id}.png`,
    tags,
    expect: scene.expect,
    gt: scene.gt,
    note: scene.note,
    png: scene.canvas.toDataURL('image/png'),
  }));
}

declare global {
  interface Window {
    __GEN_READY?: boolean;
    __generate?: () => Promise<GenItem[]>;
  }
}

window.__generate = build;
window.__GEN_READY = true;
