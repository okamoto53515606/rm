// アプリ全体で使う型定義

export type EffectKind = 'mosaic+blur' | 'mosaic' | 'blur' | 'fill';
export type MaskKind = 'rect' | 'ellipse' | 'polygon';
export type MaskSource = 'auto' | 'manual';
export type DetectProvider = 'local' | 'ollama';

/** 画像の原寸ピクセル座標での矩形 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 隠す範囲。座標はすべて原寸画像のピクセルで保持する */
export interface Mask {
  id: string;
  kind: MaskKind;
  box: Box;
  /** polygon のときだけ使う。x,y を交互に並べた配列 */
  points?: number[];
  effect: EffectKind;
  label: string;
  source: MaskSource;
}

export type Raster = ImageBitmap | HTMLCanvasElement;

export type PhotoStatus = 'decoding' | 'ready' | 'detecting' | 'error';

export interface PhotoDoc {
  id: string;
  file: File;
  name: string;
  width: number;
  height: number;
  raster: Raster;
  thumbnail: string;
  masks: Mask[];
  status: PhotoStatus;
  verified: boolean;
  message?: string;
  /** 直近の検出エラー（写真自体は利用可能なままにする） */
  lastError?: string;
}

export type Category = 'face' | 'plate' | 'secret' | 'other';

/** 検出結果。座標は画像全体を 0〜1 に正規化したもの */
export interface Detection {
  category: Category;
  label: string;
  box: { x: number; y: number; w: number; h: number };
  confidence?: number;
}

export interface DetectSettings {
  provider: DetectProvider;
  ollamaEndpoint: string;
  ollamaModel: string;
  /** 顔の矩形をブラウザ内の顔検出で補正する */
  refineFaces: boolean;
  /** ローカルOCRで文字も検出する */
  ocr: boolean;
  /** 進捗メッセージ（UI表示用） */
  onProgress?: (message: string) => void;
}

export interface ExportOptions {
  maxLongSide: number | null;
  quality: number;
}
