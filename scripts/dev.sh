#!/usr/bin/env bash
# ローカル起動: 依存を入れて開発サーバーを立ち上げる
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -d node_modules ]; then
  echo "[dev] 依存パッケージをインストールします（初回のみ）..."
  npm install
fi

exec npm run dev
