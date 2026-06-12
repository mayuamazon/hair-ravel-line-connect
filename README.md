# hair-ravel LINE Connect

サロンオーナー所有のLINE連携サーバー。**依存パッケージゼロ（Node 18+のみ）**。

> **分散型設計：** このサーバーは各サロンオーナー自身の環境（自分のVercel / Mac / VPS）で動きます。
> LINEのトークン・顧客データが開発者（まゆ）のサーバーを経由することは**構造上ありえません**。
> 通信先は `api.line.me`（とGitHub保存を選んだ場合の `api.github.com`）のみです。

## 実装済み機能（追補引き継ぎ書の7機能すべて）

| # | 機能 | エンドポイント |
|---|---|---|
| ① | 新規予約 → オーナー通知 | `POST /api/booking` |
| ② | 予約確定Flex（バーガンディ） | `POST /api/bookings/:id/confirm` |
| ③ | 前日リマインドFlex（オレンジ）＋ヒアリングリンク | `GET/POST /api/cron/reminder` |
| ④ | 来店前ヒアリング（Webフォーム） | `GET /hearing/:id`・`POST /api/hearing` |
| ⑤ | サンクスFlex＋ホームケア提案＋口コミ | `GET/POST /api/cron/thank-you` |
| ⑥ | そろそろリマインド（離脱防止） | 同上cron内で自動判定 |
| ⑦ | 空き枠アラート（multicast・購読制） | `POST /api/vacancy-alert` ＋ Webhook |
| — | LINE Webhook受信（署名検証） | `POST /api/line/webhook` |
| — | スマホ用セットアップ画面 | `GET /setup` |

## かんたん導入（非エンジニアのオーナー向け）

**`../deploy/index.html`（かんたん導入ガイド）を渡してください。** 大きな文字の5ステップで、
準備シート（自動生成つき）→ Deploy to Vercelボタン → 仕上げチェックまで完結します。

### Deployボタンを有効化する手順（まゆ側・1回だけ）
```bash
../tools/publish-template.sh          # このフォルダを公開テンプレートrepoにする（gh CLI使用）
# → 表示されたURLを deploy/index.html の TEMPLATE_REPO に書き換えて完了
```
ボタンの中身：`https://vercel.com/new/clone?repository-url=…&env=SALON_NAME,…`
（Vercelが env欄を自動表示し、オーナーは準備シートの値を貼るだけ）

### Macでダブルクリック起動（Vercelを使わない方）
`はじめる.command` をダブルクリック → ブラウザが自動で開きます。
※ 配布時にmacOSが警告を出す場合は「右クリック→開く」。

## 画面一覧

| パス | 内容 |
|---|---|
| `/admin` | **管理画面** — 予約カレンダー（日タップで一覧・確定操作）／本日一覧のオーナーLINE通知／空き枠アラート配信／自動配信の一覧 |
| `/setup` | 設定画面（接続テスト・つぎにやることチェックリスト付き） |
| `/karte` | カルテ画面（顧客検索＆カルテ入力。カラー・パーマ・縮毛矯正の3種レシピ対応。**サーバー予約と自動連携**：本日の予約表示・LINE顧客の自動取り込み・事前ヒアリング表示・メニュープリセット） |
| `/hearing/:id` | 顧客向け来店前ヒアリングフォーム |

### 管理画面のLINE関連API
- `POST /api/admin/notify-today` — 本日のご予約・来店一覧をオーナーLINEへ送信（ADMIN_TOKEN）
- `POST /api/vacancy-alert` — cron secret に加えて管理者（ADMIN_TOKEN／localhost）からも実行可
- LINE経由の予約は、受付時にプロフィールAPIで**表示名を自動取得**して予約Markdownに記録（`line_display_name`）

## 使い方（手動セットアップ・3ステップ）

```bash
# 1. 起動（このフォルダで）
node server.mjs
# → http://127.0.0.1:8787/setup をスマホ/ブラウザで開く

# 2. 画面の案内に沿ってLINEチャネル情報を入力 →「接続テスト」

# 3. 保存方法を選ぶ
#    A) Vercelで運用（推奨）: 環境変数を生成 → 自分のVercelに貼る
#    B) この端末で運用: HR_STORE_KEY=合言葉 を付けて起動 → 暗号化保存
HR_STORE_KEY=あなたの合言葉 node server.mjs
```

## 環境変数一覧

| 変数 | 説明 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging APIトークン（長期） |
| `LINE_CHANNEL_SECRET` | Webhook署名検証用 |
| `LINE_OWNER_USER_ID` | オーナー通知の宛先 |
| `CRON_SECRET` | cron/空き枠APIの`Bearer`認証 |
| `ADMIN_TOKEN` | 設定画面・管理APIの鍵（リモート運用時必須） |
| `GOOGLE_MAPS_REVIEW_URL` | 任意。サンクスFlexの口コミボタン |
| `BOOKING_URL` / `CARE_URL` / `ADMIN_URL` | 任意。各種リンク |
| `SALON_NAME` / `OWNER_NAME` | 文面の署名 |
| `HR_STORAGE` | `fs`（既定）or `github` |
| `DATA_DIR` | fs時の保存先。**Google Driveの同期フォルダ推奨** |
| `GITHUB_REPO` / `GITHUB_TOKEN` | github時。自分の非公開repo＋Fine-grained PAT（Contents権限のみ） |
| `HR_STORE_KEY` | ローカル暗号化保存の合言葉 |
| `HR_PORT` / `HR_HOST` | 既定 8787 / 127.0.0.1 |

## データはすべてMarkdown（原則③）

```
DATA_DIR/
├── 予約/2026-07-01_田中花子_bk〇〇.md   ← フロントマター＋可読本文
├── 写真/ヒアリング_bk〇〇.jpg
├── 購読者/alert_subscribers.md          ← Markdownテーブル
└── ログ/2026-06-11.md                   ← 監査ログ（秘密情報は書かない）
```

解約しても、このフォルダ／リポジトリは**オーナーの手元にそのまま残ります**（原則①）。

## Vercelで運用する場合のcron設定

`vercel.json`：
```json
{
  "crons": [
    { "path": "/api/cron/thank-you", "schedule": "0 16 * * *" },
    { "path": "/api/cron/reminder",  "schedule": "0 18 * * *" }
  ]
}
```
> Vercel cronは**UTC**。JST 01:00 = UTC 16:00（前日）、JST 03:00 = UTC 18:00（前日）。
> Vercel運用時はファイルが揮発するため `HR_STORAGE=github` を選ぶこと。

## LINE Developers側の設定

1. Messaging APIチャネル作成 → トークン（長期）発行
2. Webhook URL: `https://あなたのデプロイ先/api/line/webhook` を登録・有効化
3. 応答メッセージはオフ
4. リッチメニュー（LINE Official Account Manager）:
   - 「空き枠通知を登録する」「空き枠通知を解除する」のテキスト送信ボタン
   - 予約ページへのリンクボタン

## セキュリティ設計

- Webhookは HMAC-SHA256 + `timingSafeEqual` で署名検証（不正は401）
- 管理API/設定画面は `ADMIN_TOKEN`（未設定時はlocalhostのみ許可）
- トークンの保存は「オーナーの環境変数」または「AES-256-GCM暗号化ファイル（scrypt鍵導出・データフォルダ外）」
- 設定APIのレスポンス・画面表示・ログにフル値のトークンは一切出ない（末尾4桁のみ）
- 接続テストはトークンを一時利用のみ（保存しない）

## テスト

```bash
node test/run-tests.mjs   # 76項目・外部送信ゼロ（LINE/GitHubはローカルモック）
```

## 制限・次のステップ

- 設定をAPI経由で保存した場合、LINE送信クライアントへの反映は**再起動後**（Vercelは環境変数変更で自動再デプロイ）
- Google Drive APIへの直接保存（OAuth）は本体引き継ぎ書 §7 Step 1 として別途実装予定（現状はDrive同期フォルダ運用でカバー）
- 既存 `hair-ravel-lp`（中村さん稼働中）はそのまま。本モジュールは新アプリ（マルチテナント展開）用の受け皿
