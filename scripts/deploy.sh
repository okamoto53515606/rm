#!/usr/bin/env bash
# AWS へデプロイ（S3 + CloudFront）
#
#   ./scripts/deploy.sh                                  # 既定のAWS認証情報を使う
#   AWS_PROFILE=my-profile ./scripts/deploy.sh           # プロファイルを指定
#   AWS_PROFILE=my-profile DOMAIN_NAME=mask.example.com \
#     ACM_CERT_ARN=arn:aws:acm:us-east-1:... ./scripts/deploy.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

STACK_NAME="${STACK_NAME:-rm}"
REGION="${AWS_REGION:-ap-northeast-1}"
PROFILE="${AWS_PROFILE:-}"
DOMAIN_NAME="${DOMAIN_NAME:-}"
ACM_CERT_ARN="${ACM_CERT_ARN:-}"

if [ -n "$DOMAIN_NAME" ] && [ -z "$ACM_CERT_ARN" ]; then
  echo "エラー: DOMAIN_NAME を指定する場合は ACM_CERT_ARN（us-east-1）も必要です。" >&2
  exit 1
fi

# プロファイルが指定されたときだけ --profile を付ける（未指定なら既定の認証情報）
AWS_OPTS=(--region "$REGION")
if [ -n "$PROFILE" ]; then
  AWS_OPTS+=(--profile "$PROFILE")
fi

echo "============================================"
echo " rm デプロイ"
echo "  profile : ${PROFILE:-（既定の認証情報）}"
echo "  region  : $REGION"
echo "  stack   : $STACK_NAME"
echo "  domain  : ${DOMAIN_NAME:-（CloudFront 既定ドメイン）}"
echo "============================================"

# ---- 1. ビルド ----
if [ ! -d node_modules ]; then
  echo "[1/5] 依存パッケージをインストール..."
  npm ci
else
  echo "[1/5] 依存パッケージは導入済み"
fi
echo "[2/5] ビルド..."
npm run build

# ---- 2. スタック ----
echo "[3/5] CloudFormation スタックを適用..."
aws cloudformation deploy \
  "${AWS_OPTS[@]}" \
  --stack-name "$STACK_NAME" \
  --template-file template.yaml \
  --no-fail-on-empty-changeset \
  --parameter-overrides "DomainName=$DOMAIN_NAME" "AcmCertificateArn=$ACM_CERT_ARN"

BUCKET=$(aws cloudformation describe-stacks "${AWS_OPTS[@]}" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
DIST_ID=$(aws cloudformation describe-stacks "${AWS_OPTS[@]}" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)
SITE_URL=$(aws cloudformation describe-stacks "${AWS_OPTS[@]}" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)

# ---- 3. アップロード ----
echo "[4/5] ファイルを S3 へアップロード..."
# HTML は毎回検証させる（robots.txt / sitemap.xml と同じ扱い）
for page in dist/*.html; do
  name=$(basename "$page")
  aws s3 cp "$page" "s3://$BUCKET/$name" \
    "${AWS_OPTS[@]}" \
    --cache-control "no-cache" --content-type "text/html; charset=utf-8"
done

# クローラが読むファイル（MIME と短いキャッシュを明示）
aws s3 cp dist/robots.txt "s3://$BUCKET/robots.txt" \
  "${AWS_OPTS[@]}" \
  --cache-control "public, max-age=3600" --content-type "text/plain; charset=utf-8"
aws s3 cp dist/sitemap.xml "s3://$BUCKET/sitemap.xml" \
  "${AWS_OPTS[@]}" \
  --cache-control "public, max-age=3600" --content-type "application/xml"
if [ -f dist/llms.txt ]; then
  aws s3 cp dist/llms.txt "s3://$BUCKET/llms.txt" \
    "${AWS_OPTS[@]}" \
    --cache-control "public, max-age=3600" --content-type "text/plain; charset=utf-8"
fi

# OGP 画像（SNS のクローラが読むため MIME を明示し、キャッシュは短めに）
aws s3 cp dist/og.jpg "s3://$BUCKET/og.jpg" \
  "${AWS_OPTS[@]}" \
  --cache-control "public, max-age=86400" --content-type "image/jpeg"

# ハッシュ付きアセットは長期キャッシュ
aws s3 sync dist "s3://$BUCKET" \
  "${AWS_OPTS[@]}" \
  --delete \
  --exclude "*.html" \
  --exclude "robots.txt" --exclude "sitemap.xml" --exclude "llms.txt" \
  --exclude "og.jpg" \
  --exclude "wasm/*" --exclude "models/*" --exclude "ocr/*" \
  --cache-control "public, max-age=31536000, immutable"

# WASM は MIME が重要
aws s3 sync dist/wasm "s3://$BUCKET/wasm" \
  "${AWS_OPTS[@]}" \
  --exclude "*" --include "*.wasm" \
  --content-type "application/wasm" \
  --cache-control "public, max-age=604800"
aws s3 sync dist/wasm "s3://$BUCKET/wasm" \
  "${AWS_OPTS[@]}" \
  --exclude "*.wasm" \
  --content-type "application/javascript; charset=utf-8" \
  --cache-control "public, max-age=604800"

# 顔検出モデル
aws s3 sync dist/models "s3://$BUCKET/models" \
  "${AWS_OPTS[@]}" \
  --content-type "application/octet-stream" \
  --cache-control "public, max-age=604800"

# ローカルOCR（worker / core / 言語モデル）
aws s3 sync dist/ocr "s3://$BUCKET/ocr" \
  "${AWS_OPTS[@]}" \
  --exclude "*" --include "*.js" \
  --content-type "application/javascript; charset=utf-8" \
  --cache-control "public, max-age=604800"
aws s3 sync dist/ocr "s3://$BUCKET/ocr" \
  "${AWS_OPTS[@]}" \
  --exclude "*.js" \
  --content-type "application/octet-stream" \
  --cache-control "public, max-age=604800"

# ---- 4. キャッシュ無効化 ----
echo "[5/5] CloudFront のキャッシュを無効化..."
aws cloudfront create-invalidation \
  "${AWS_OPTS[@]}" \
  --distribution-id "$DIST_ID" \
  --paths "/*" >/dev/null

echo ""
echo "============================================"
echo " デプロイ完了"
echo " URL: $SITE_URL"
echo "============================================"
