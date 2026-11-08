import type { Category, Detection, DetectSettings, Raster } from './types';
import { bytesToBase64, clamp, iou } from './util';
import { downscale } from './image';
import { detectTextLocal } from './ocr';

export const GEMINI_MODEL_DEFAULT = 'gemini-3.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DETECT_MAX_SIDE = 1536;

const PROMPT = `あなたは写真・スクリーンショットのプライバシー保護アシスタントです。
この画像から「公開前に隠すべき領域」を検出してください。

対象（すべて、見落とさないよう探してください）:
1. 人の顔（集合写真の全員）
2. 車・バイクのナンバープレート
3. 認証情報: APIキー、アクセストークン、パスワード、秘密鍵、Cookie、接続文字列
4. 個人情報: メールアドレス、電話番号、住所、氏名、マイナンバー、生年月日
5. 端末・アカウント情報: ユーザー名、ホスト名/PC名、ターミナルのプロンプト（例: user@host:~/dir$）、ホームディレクトリやフォルダ名などのファイルパス、社内ドメイン名
6. ネットワーク情報: IPアドレス、ポート番号、内部URL、クラウドのアカウントID、バケット名

座標は画像全体を 0〜1000 に正規化した [上, 左, 下, 右] の整数で返してください。
- 顔は「眉からあごまで、耳を含む顔の輪郭」にぴったり合わせ、髪・帽子・首・背景は含めないでください。
- 文字列は、その文字列全体が隠れる最小限の矩形にしてください。
- 余白は最小限にし、対象より明らかに大きい箱は返さないでください。
ターミナルのスクリーンショットでは、ユーザー名・ホスト名・パスを含む行を1行ずつ矩形で囲んでください。
対象が無ければ objects を空配列にしてください。

出力は次の JSON のみ:
{"objects":[{"label":"face","box_2d":[ymin,xmin,ymax,xmax],"confidence":0.0}]}
label は face / license_plate / secret_text / other のいずれか。`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    objects: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING', enum: ['face', 'license_plate', 'secret_text', 'other'] },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
          confidence: { type: 'NUMBER' },
        },
        required: ['label', 'box_2d'],
      },
    },
  },
  required: ['objects'],
};

// ===== 共通 =====

async function rasterToJpegBase64(raster: Raster): Promise<string> {
  const canvas = downscale(raster, DETECT_MAX_SIDE);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('画像の変換に失敗しました'))),
      'image/jpeg',
      0.85,
    );
  });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
  }
  throw new Error('AI の応答を JSON として解釈できませんでした');
}

function categorize(label: string): Category {
  const l = label.toLowerCase();
  if (/face|顔|person|人|頭/.test(l)) return 'face';
  if (/plate|license|number|ナンバー|番号|車/.test(l)) return 'plate';
  if (/secret|text|key|token|password|credential|mail|phone|address|文字|機密|api|パスワード|住所|電話/.test(l))
    return 'secret';
  return 'other';
}

function labelJa(category: Category, raw: string): string {
  switch (category) {
    case 'face':
      return '顔';
    case 'plate':
      return 'ナンバープレート';
    case 'secret':
      return '機密文字列';
    default:
      return raw || 'その他';
  }
}

function toDetection(label: string, coords: number[]): Detection | null {
  if (!Array.isArray(coords) || coords.length < 4) return null;
  const nums = coords.slice(0, 4).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [ymin, xmin, ymax, xmax] = nums;
  const x = clamp(Math.min(xmin, xmax) / 1000, 0, 1);
  const y = clamp(Math.min(ymin, ymax) / 1000, 0, 1);
  const w = clamp(Math.abs(xmax - xmin) / 1000, 0, 1 - x);
  const h = clamp(Math.abs(ymax - ymin) / 1000, 0, 1 - y);
  if (w < 0.004 || h < 0.004) return null;
  const category = categorize(label);
  return { category, label: labelJa(category, label), box: { x, y, w, h } };
}

interface RawObject {
  label?: unknown;
  box_2d?: unknown;
  box2d?: unknown;
  box?: unknown;
  bbox?: unknown;
  confidence?: unknown;
}

function parseObjects(json: unknown): Detection[] {
  const root = json as { objects?: unknown } | unknown[] | null;
  let list: unknown[] = [];
  if (Array.isArray(root)) list = root;
  else if (root && typeof root === 'object' && Array.isArray((root as { objects?: unknown }).objects)) {
    list = (root as { objects: unknown[] }).objects;
  }
  const out: Detection[] = [];
  for (const item of list) {
    const o = item as RawObject;
    if (!o || typeof o !== 'object') continue;
    const coords = (o.box_2d ?? o.box2d ?? o.box ?? o.bbox) as number[] | undefined;
    const det = toDetection(String(o.label ?? 'other'), coords ?? []);
    if (!det) continue;
    if (typeof o.confidence === 'number' && Number.isFinite(o.confidence)) {
      det.confidence = o.confidence;
    }
    out.push(det);
  }
  return out;
}

function dedupe(list: Detection[]): Detection[] {
  const out: Detection[] = [];
  for (const d of list) {
    if (!out.some((e) => e.category === d.category && iou(e.box, d.box) > 0.7)) {
      out.push(d);
    }
  }
  return out;
}

// ===== Gemini =====

async function detectWithGemini(raster: Raster, settings: DetectSettings): Promise<Detection[]> {
  const key = settings.geminiKey.trim();
  if (!key) throw new Error('Gemini API キーを入力してください');
  const model = settings.geminiModel.trim() || GEMINI_MODEL_DEFAULT;
  const image = await rasterToJpegBase64(raster);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: PROMPT }, { inlineData: { mimeType: 'image/jpeg', data: image } }],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: 4096,
        },
      }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Gemini の応答がタイムアウトしました');
    }
    throw new Error(`Gemini に接続できませんでした（ネットワークまたは CORS）: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(`Gemini API キーが無効、または権限がありません: ${detail}`);
    }
    if (res.status === 429) {
      throw new Error(`Gemini の利用上限に達しました（時間をおいて再試行してください）: ${detail}`);
    }
    if (res.status === 404) {
      throw new Error(`モデル「${model}」が見つかりません。モデル名を確認してください: ${detail}`);
    }
    throw new Error(`Gemini API エラー (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (data.promptFeedback?.blockReason) {
    throw new Error(`画像が Gemini の安全フィルタで拒否されました: ${data.promptFeedback.blockReason}`);
  }
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('Gemini から検出結果が返りませんでした');
  return dedupe(parseObjects(extractJson(text)));
}

// ===== Ollama =====

function normalizeEndpoint(value: string): string {
  let s = value.trim().replace(/\/+$/, '');
  if (!s) throw new Error('Ollama のエンドポイントを入力してください');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

// ===== ローカルネットワークアクセス（LNA）=====
// 公開オリジンから localhost / LAN への fetch は、Chrome 142 以降
// 「ローカルネットワーク」の許可が必要になる。拒否と CORS を混同しないよう、
// パーミッション状態を先に確認してエラーメッセージを分岐する。

type LnaState = 'granted' | 'denied' | 'prompt' | 'unsupported';

type OllamaRequestInit = RequestInit & {
  targetAddressSpace?: 'local' | 'private' | 'public';
};

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost')
  );
}

async function lnaPermissionState(hostname: string): Promise<LnaState> {
  try {
    if (!navigator.permissions?.query) return 'unsupported';
    const name = isLoopbackHost(hostname) ? 'loopback-network' : 'local-network';
    const status = await navigator.permissions.query({ name: name as PermissionName });
    return status.state as LnaState;
  } catch {
    // 未対応ブラウザ（PermissionName が未知）は判定不能
    return 'unsupported';
  }
}

function lnaErrorMessage(state: LnaState, origin: string): string {
  if (state === 'denied') {
    return (
      'ローカルネットワークへのアクセスがブラウザでブロックされています。\n' +
      'アドレスバー左の「サイトの設定」→「ローカルネットワーク」を「許可」にしてから再試行してください。\n' +
      '（Chrome 142 以降、公開サイトから localhost への接続には許可が必要です）'
    );
  }
  if (state === 'prompt') {
    return (
      'ブラウザがローカルネットワークへのアクセス許可を確認しています。\n' +
      '表示されたダイアログで「許可」を選んでから、もう一度「この写真を検出」を押してください。'
    );
  }
  return (
    'Ollama に接続できませんでした。次の順に確認してください。\n' +
    '1) Ollama が起動しているか（ollama serve）\n' +
    `2) OLLAMA_ORIGINS=${origin} を設定して起動したか\n` +
    '3) ブラウザの「ローカルネットワーク」許可（アドレスバー左のサイト設定）\n' +
    '4) エンドポイントのURLが正しいか（例: http://localhost:11434）'
  );
}

async function detectWithOllama(raster: Raster, settings: DetectSettings): Promise<Detection[]> {
  const endpoint = normalizeEndpoint(settings.ollamaEndpoint);
  const model = settings.ollamaModel.trim();
  if (!model) throw new Error('Ollama のモデル名を入力してください');

  let hostname = '';
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    throw new Error('Ollama のエンドポイントURLが不正です（例: http://localhost:11434）');
  }

  const permission = await lnaPermissionState(hostname);
  if (permission === 'denied') {
    throw new Error(lnaErrorMessage(permission, location.origin));
  }

  const image = await rasterToJpegBase64(raster);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const init: OllamaRequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    // ローカル/LAN 向けであることを明示（未対応ブラウザでは無視される）
    targetAddressSpace: 'local',
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
      messages: [{ role: 'user', content: PROMPT, images: [image] }],
    }),
  };

  let res: Response;
  try {
    res = await fetch(`${endpoint}/api/chat`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Ollama の応答がタイムアウトしました');
    }
    const state = await lnaPermissionState(hostname);
    throw new Error(`${lnaErrorMessage(state, location.origin)}\n詳細: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 404) {
      throw new Error(`Ollama にモデル「${model}」がありません（ollama pull ${model}）: ${detail}`);
    }
    if (res.status === 403) {
      throw new Error(
        `Ollama がこのオリジンからのアクセスを拒否しました。OLLAMA_ORIGINS=${location.origin} を設定して再起動してください: ${detail}`,
      );
    }
    throw new Error(`Ollama エラー (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as { message?: { content?: string }; response?: string };
  const text = (data.message?.content ?? data.response ?? '').trim();
  if (!text) throw new Error('Ollama から検出結果が返りませんでした');
  return dedupe(parseObjects(extractJson(text)));
}

// ===== ブラウザ内（顔のみ） =====

type FaceLandmarkerLike = {
  detect: (image: HTMLCanvasElement) => { faceLandmarks: { x: number; y: number }[][] };
};

let landmarkerPromise: Promise<FaceLandmarkerLike> | null = null;

async function getLandmarker(): Promise<FaceLandmarkerLike> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision');
      const base = new URL('./', document.baseURI).href;
      const fileset = await FilesetResolver.forVisionTasks(new URL('wasm', base).href);
      const options = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: {
          modelAssetPath: new URL('models/face_landmarker.task', base).href,
          delegate,
        },
        runningMode: 'IMAGE' as const,
        numFaces: 10,
        minFaceDetectionConfidence: 0.35,
        minFacePresenceConfidence: 0.35,
      });
      try {
        return (await FaceLandmarker.createFromOptions(fileset, options('GPU'))) as unknown as FaceLandmarkerLike;
      } catch {
        return (await FaceLandmarker.createFromOptions(fileset, options('CPU'))) as unknown as FaceLandmarkerLike;
      }
    })().catch((err) => {
      landmarkerPromise = null;
      throw new Error(
        `ブラウザ内の顔検出モデルを読み込めませんでした。Gemini か Ollama をお使いください: ${String(err)}`,
      );
    });
  }
  return landmarkerPromise;
}

async function detectFacesLocal(raster: Raster): Promise<Detection[]> {
  const landmarker = await getLandmarker();
  const canvas = downscale(raster, 1024);
  const result = landmarker.detect(canvas);
  const out: Detection[] = [];
  for (const landmarks of result.faceLandmarks) {
    if (!landmarks.length) continue;
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
    const padX = (maxX - minX) * 0.1;
    const padY = (maxY - minY) * 0.12;
    const x = clamp(minX - padX, 0, 1);
    const y = clamp(minY - padY, 0, 1);
    const w = clamp(maxX - minX + padX * 2, 0, 1 - x);
    const h = clamp(maxY - minY + padY * 2, 0, 1 - y);
    if (w < 0.01 || h < 0.01) continue;
    out.push({ category: 'face', label: '顔', box: { x, y, w, h } });
  }
  return dedupe(out);
}

// ===== 入口 =====

interface BoxN {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 小さい方の面積に対する重なり率（大きい箱に小さい箱が含まれる場合に 1 へ近づく） */
function overlapRatio(a: BoxN, b: BoxN): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const minArea = Math.min(a.w * a.h, b.w * b.h);
  return minArea <= 0 ? 0 : inter / minArea;
}

/**
 * 汎用VLMの顔矩形は髪や背景まで含みがち。
 * ブラウザ内の顔検出（478ランドマーク）のタイトな矩形で置き換える。
 */
function mergeFaceBoxes(remote: Detection[], localFaces: Detection[]): Detection[] {
  if (!localFaces.length) return remote;
  const kept = remote.filter((d) => {
    if (d.category !== 'face') return true;
    return !localFaces.some((f) => overlapRatio(d.box, f.box) > 0.5);
  });
  return dedupe([...kept, ...localFaces]);
}

export async function detect(raster: Raster, settings: DetectSettings): Promise<Detection[]> {
  if (settings.provider === 'local') {
    const results: Detection[] = [];
    const errors: string[] = [];
    let faceOk = false;
    let ocrOk = false;

    try {
      results.push(...(await detectFacesLocal(raster)));
      faceOk = true;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    if (settings.ocr) {
      try {
        results.push(...(await detectTextLocal(raster, settings.onProgress)));
        ocrOk = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (!faceOk && !ocrOk) throw new Error(errors.join('\n'));
    if (errors.length) settings.onProgress?.(errors.join(' / '));
    return dedupe(results);
  }

  const remote =
    settings.provider === 'gemini'
      ? await detectWithGemini(raster, settings)
      : await detectWithOllama(raster, settings);

  if (!settings.refineFaces) return remote;

  try {
    const faces = await detectFacesLocal(raster);
    return mergeFaceBoxes(remote, faces);
  } catch {
    // 顔モデルが読み込めない環境では、外部AIの結果をそのまま使う
    return remote;
  }
}
