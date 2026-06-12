// Vercel用アダプタ — server.mjs のハンドラをそのままServerless Functionとして公開する。
// すべてのパスは vercel.json の rewrites でここに集約される。
import { loadConfig, createApp } from '../server.mjs';

let handlerPromise = null;

export default async function vercelHandler(req, res) {
  try {
    if (!handlerPromise) {
      handlerPromise = loadConfig(process.env).then(createApp);
    }
    const handler = await handlerPromise;
    return await handler(req, res);
  } catch (e) {
    handlerPromise = null; // 初期化失敗時は次のリクエストで再試行
    console.error('hair-ravel 起動/処理エラー:', e); // Vercelのログに原因を残す
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'startup error' }));
  }
}

// Webhook署名検証のため、ボディは生のまま受け取る（ヘルパーのJSONパースを無効化）
export const config = { api: { bodyParser: false } };
