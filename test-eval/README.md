# ブラウザ内検出のテスト（Ollama 対象外）

顔（MediaPipe）・ナンバープレート・機密文字列（Tesseract OCR）を、
**ブラウザ内の処理だけで**評価するためのハーネスです。
Ollama / 外部 VLM は使いません。

## 使い方

```bash
npm run test:eval:gen   # 合成テスト画像を生成（初回・ジェネレータ変更時）
npm run test:eval       # ヘッドレス Chromium で評価
# 特定の画像だけ: npm run test:eval -- --filter=plate
```

結果は `test-image-secret/eval-out/` に出力されます。

- `report.json` — 画像ごとの検出結果・正解との一致・処理時間
- `<id>.png` — オーバーレイ（正解 = 緑の破線、検出 = 実線）

Vite dev サーバーは自動で起動・停止します。既に起動していれば再利用します。
Chromium が見つからない場合は `npx playwright install chromium` を実行するか、
`CHROME_PATH` を指定してください。

## テストデータ

`test-image-secret/` は `.gitignore` 済みです（画像・レポートはコミットされません）。

| 種別 | 内容 | 出所 |
|---|---|---|
| 合成プレート | 正面・小さい・8度傾き・2台・夜間・白い看板（誤検出用） | `test-eval/gen.ts` で生成 |
| 合成の機密文字列 | 明るい画面・ターミナル・表形式・機密なし（誤検出用） | 同上 |
| 実写真の顔 | `IMG_2864.jpeg` | ローカル（コミット禁止） |
| 実写真のプレート | `IMG_0191.jpeg`（実ナンバーを含む） | ローカル（コミット禁止） |
| 実スクショ | `deepseek1.png`（追跡ID・マスク済みキー） | ローカル（コミット禁止） |
| 顔の追加素材 | `faces/obama.jpg`, `faces/biden.jpg` | Wikimedia Commons の公有領域肖像 |

顔の 2 人合成テストは、上の公有領域肖像を使います。
再取得する場合:

```bash
curl -sSL -o test-image-secret/faces/obama.jpg \
  'https://commons.wikimedia.org/wiki/Special:FilePath/President_Barack_Obama.jpg?width=1000'
curl -sSL -o test-image-secret/faces/biden.jpg \
  'https://commons.wikimedia.org/wiki/Special:FilePath/Joe_Biden_presidential_portrait.jpg?width=1000'
```

実データを追加する場合は `test-eval/dataset.json` に、
画像パスと正解矩形（0〜1 の正規化座標）を追記してください。

## 判定方法

- **再現率** = 正解のうち、検出で覆えた割合
- **適合率** = 検出のうち、正解に重なった割合
- 対応付けは次のいずれか
  - IoU 0.25 以上
  - 正解面積の 50% 以上を検出が覆う（OCR の行が正解より広い場合）
  - 検出の中心が正解の内側（顔の箱が正解の内側に収まる場合）

## マスク前→後の比較レポート

```bash
npm run test:compare
```

`test-image-secret/eval-out/compare/report.html` に、全画像の
「マスク前 / 検出枠 / マスク後（自動検出で書き出し）」を 3 枚並べた
自己完結 HTML レポートを出力します。書き出した JPEG は `compare/after/` に保存されます。

- 赤枠 = 黒塗り（機密文字列） / 青枠 = モザイク＋ぼかし（顔・プレート）
- 検出 0 件の画像も一覧の先頭に表示されます
- 実写真を含むため、レポートは共有しないでください

## 1枚だけ調べる

```bash
node scripts/detect-one.mjs test-image-secret/20261110/IMG_1369.jpeg
node scripts/detect-one.mjs test-image-secret/20261110/IMG_1369.jpeg --ollama  # lfm3-vl:2b
node scripts/face-probe.mjs test-image-secret/20261110/IMG_1369.jpeg  # 解像度・しきい値別の顔数
node scripts/ocr-debug.mjs <file> [psm] [--safe|--shape|--tokens|--stats]
```

実写真を扱うときは `--safe`（本文を出さない）や `--stats`（文字種の内訳だけ）を使ってください。
`--box=x,y,w,h` を付けると、その矩形をプレート切り出しと同じ条件で OCR できます。

## OCR の切り分け

検出漏れが「OCR の誤読」か「正規表現の取りこぼし」かを確認できます。

```bash
node scripts/ocr-debug.mjs test-image-secret/deepseek1.png      # PSM 3（アプリと同じ）
node scripts/ocr-debug.mjs test-image-secret/synthetic/secret_terminal.png 6
```

## 既知の制約

- ターミナルの `-----BEGIN OPENSSH PRIVATE KEY-----` 行は、PSM 3（全体）では
  Tesseract が行ごと落とすことがあります。PSM 6 なら読めますが、写真全体に
  PSM 6 を適用すると非常に遅いため、既定では使っていません。
- 顔のテストは実在人物の公有領域肖像を使っています。ローカル検証のみに使い、
  再配布しないでください。
