#!/bin/bash
# hair ravel LINE Connect — ダブルクリックで起動（Mac用）
# Vercelを使わず「この端末で運用」する方向けのかんたん起動スクリプトです。
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "──────────────────────────────────"
  echo " Node.js が見つかりませんでした。"
  echo " いまブラウザで開くページから（LTS版・推奨版）を"
  echo " ダウンロードしてインストール後、もう一度この"
  echo " ファイルをダブルクリックしてください。"
  echo "──────────────────────────────────"
  open "https://nodejs.org/ja"
  read -p "Enterキーで閉じます..."
  exit 1
fi

echo "──────────────────────────────────"
echo " hair ravel LINE Connect を起動します。"
echo " このまっくろい画面は閉じないでください。"
echo "（終わるときは、この画面で Ctrl と C を同時に押す）"
echo "──────────────────────────────────"

( sleep 1.5; open "http://127.0.0.1:8787/setup" ) &
node server.mjs
