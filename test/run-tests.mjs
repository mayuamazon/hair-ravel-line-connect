// hair-ravel LINE Connect 自己検証テスト
// 実行: node test/run-tests.mjs
// 外部送信ゼロ：LINE API・GitHub APIはローカルモックに差し替えて検証する。
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { encryptJson, decryptJson, createSecretStore } from '../lib/secret-store.mjs';
import { serializeFrontmatter, parseFrontmatter, createMarkdownStore, jstToday, daysBetween } from '../lib/markdown-store.mjs';
import { createFsBackend, createGithubBackend } from '../lib/store-backends.mjs';
import { getNextVisitDays, isSorosoroDay, recommendHomecare } from '../lib/visit-timing.mjs';
import { buildConfirmFlex, buildReminderFlex, buildThankYouFlex, sorosoroText, ownerBookingText } from '../lib/line-client.mjs';
import { verifySignature } from '../lib/webhook-handler.mjs';
import { loadConfig, createApp } from '../server.mjs';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`); }
}
const section = t => console.log(`\n■ ${t}`);

const TMP = path.join(os.tmpdir(), `hr-test-${Date.now()}`);
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ================================================================ 1. 暗号化ストア
section('秘密情報ストア（AES-256-GCM）');
{
  const blob = encryptJson({ accessToken: 'secret-token-1234' }, 'correct-pass');
  ok(blob.alg === 'aes-256-gcm' && !JSON.stringify(blob).includes('secret-token'), '暗号化後に平文トークンが含まれない');
  ok(decryptJson(blob, 'correct-pass').accessToken === 'secret-token-1234', '正しい合言葉で復号できる');
  let threw = false;
  try { decryptJson(blob, 'wrong-pass'); } catch { threw = true; }
  ok(threw, '間違った合言葉では復号できない');

  const ss = createSecretStore({ configDir: path.join(TMP, 'cfg'), passphrase: 'pp' });
  await ss.saveFileSettings({ accessToken: 'tok_ABCDEFGH', salonName: 'テスト', githubToken: '' });
  const loaded = await ss.load({});
  ok(loaded.accessToken === 'tok_ABCDEFGH' && loaded.salonName === 'テスト', '暗号化ファイルからの読み込み');
  const masked = ss.masked(loaded);
  ok(masked.accessToken === '••••EFGH' && !JSON.stringify(masked).includes('tok_ABCDEFGH'), 'マスク表示にフル値が含まれない');
  const envLoaded = await ss.load({ LINE_CHANNEL_ACCESS_TOKEN: 'env_token_99' });
  ok(envLoaded.accessToken === 'env_token_99', '環境変数がファイル設定より優先される');
}

// ================================================================ 2. フロントマター & Markdownストア
section('Markdownデータ層');
{
  const fm = { id: 'bk1', name: '田中 花子', services: ['カット', 'カラー'], notes: '備考: 明るめ希望' };
  const parsed = parseFrontmatter(serializeFrontmatter(fm) + '\n本文');
  ok(parsed.name === '田中 花子' && parsed.notes === '備考: 明るめ希望', 'コロン入り文字列のラウンドトリップ');
  ok(Array.isArray(parsed.services) && parsed.services[1] === 'カラー', '配列のラウンドトリップ');

  const store = createMarkdownStore(createFsBackend({ dataDir: path.join(TMP, 'data') }));
  const b = await store.createBooking({
    name: '田中/花子', phone: '090-1111-2222', line_user_id: 'U1234abcd',
    services: ['カット', 'カラー'], preferred_date: '2026-07-01', preferred_time: '14:00', notes: 'メモ',
  });
  ok(/^bk/.test(b.id), '予約IDの発行');
  ok(!b._path.includes('/田中/'), 'ファイル名のサニタイズ（スラッシュ除去）');
  const got = await store.getBooking(b.id);
  ok(got && got.name === '田中/花子' && got.status === 'pending', '予約の読み戻し');
  await store.updateBooking(b.id, { status: 'confirmed', confirmed_date: '2026-07-01', confirmed_time: '14:00' });
  ok((await store.getBooking(b.id)).status === 'confirmed', '予約の更新');

  await store.setSubscriber('U1234abcd', true);
  await store.setSubscriber('U5678efab', true);
  await store.setSubscriber('U1234abcd', false);
  const subs = await store.readSubscribers();
  ok(subs.length === 2 && subs.find(s => s.line_user_id === 'U1234abcd').active === false, '購読者の登録・解除');
  ok((await store.activeSubscriberIds()).join() === 'U5678efab', 'アクティブ購読者の抽出');
  const subMd = await store.backend.readFile('購読者/alert_subscribers.md');
  ok(subMd.includes('| U5678efab | true |'), '購読者がMarkdownテーブルで保存される');
}

// ================================================================ 3. GitHubバックエンド（モックAPI）
section('GitHubバックエンド（オーナーrepo保存）');
{
  const files = new Map();
  const gh = http.createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const m = /^\/repos\/owner\/salon-data\/contents\/(.+)$/.exec(u);
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!m) return send(404, {});
    const p = m[1];
    if (req.method === 'GET') {
      if (files.has(p)) return send(200, { type: 'file', content: files.get(p), sha: 'sha-' + p });
      const children = [...files.keys()].filter(k => k.startsWith(p + '/'));
      if (children.length) return send(200, children.map(k => ({ type: 'file', name: k.slice(p.length + 1) })));
      return send(404, {});
    }
    if (req.method === 'PUT') {
      let raw = ''; for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      if (files.has(p) && !body.sha) return send(409, { message: 'sha required' });
      files.set(p, body.content);
      return send(200, { content: { sha: 'sha-' + p } });
    }
    send(405, {});
  });
  const port = await listen(gh);
  const be = createGithubBackend({ token: 'ghp_test', repo: 'owner/salon-data', apiBase: `http://127.0.0.1:${port}` });
  await be.writeFile('予約/test.md', '# こんにちは');
  ok(await be.readFile('予約/test.md') === '# こんにちは', '書き込み→読み込み（base64往復）');
  await be.writeFile('予約/test.md', '# 更新済み');
  ok(await be.readFile('予約/test.md') === '# 更新済み', '既存ファイルの更新（sha付きPUT）');
  await be.writeFile('予約/two.md', 'x');
  ok((await be.listDir('予約')).sort().join() === 'test.md,two.md', 'ディレクトリ一覧');
  ok(await be.readFile('存在しない.md') === null, '未存在ファイルはnull');
  gh.close();
}

// ================================================================ 4. 来店タイミングロジック
section('来店タイミング & ホームケア（追補§2-⑤⑥）');
{
  ok(getNextVisitDays(['縮毛矯正', 'カット']) === 100, '縮毛矯正+カット → 100日');
  ok(getNextVisitDays(['パーマ']) === 75, 'パーマ → 75日');
  ok(getNextVisitDays(['カット']) === 50, 'カット → 50日');
  ok(getNextVisitDays(['トリートメント']) === 45, 'トリートメント → 45日');
  const today = jstToday();
  ok(isSorosoroDay(jstToday(-36), ['カット'], today) === true, 'カット36日後＝そろそろ該当（50-14）');
  ok(isSorosoroDay(jstToday(-35), ['カット'], today) === false, '35日後は非該当');
  ok(recommendHomecare(['縮毛矯正']).includes('コネクタージェル'), '縮毛矯正 → コネクタージェル');
  ok(recommendHomecare(['カラー']).includes('CMCトリートメント'), 'カラー → CMCトリートメント');
  ok(daysBetween('2026-06-01', '2026-06-11') === 10, '日数計算');
}

// ================================================================ 5. メッセージビルダー
section('Flexメッセージ & 文面');
{
  const cf = buildConfirmFlex({ salonName: 'Hair ravel', date: '2026-07-01', time: '14:00', services: ['カット'], price: '¥6,600' });
  ok(cf.type === 'flex' && cf.contents.type === 'bubble', '確定Flexの基本構造');
  ok(cf.contents.header.backgroundColor === '#7B3B4B', '確定Flexはバーガンディヘッダー');
  ok(JSON.stringify(cf).includes('¥6,600'), '料金の表示');

  const rf = buildReminderFlex({ salonName: 'Hair ravel', date: '2026-07-01', time: '14:00', services: ['カラー'], hearingUrl: 'http://x/hearing/bk1' });
  ok(rf.contents.header.backgroundColor === '#ED9A4C', 'リマインドFlexはオレンジヘッダー');
  ok(JSON.stringify(rf).includes('http://x/hearing/bk1'), 'ヒアリングURLがbookingId基準（追補§7-2）');

  const tf = buildThankYouFlex({ salonName: 'Hair ravel', name: '田中', services: ['カラー'], reviewUrl: 'https://g.page/r/x', careUrl: '' });
  const tfs = JSON.stringify(tf);
  ok(tfs.includes('CMCトリートメント') && tfs.includes('口コミ'), 'サンクスFlexにケア提案と口コミボタン');
  const tf2 = JSON.stringify(buildThankYouFlex({ salonName: 's', name: 'n', services: ['カット'] }));
  ok(!tf2.includes('口コミ'), '口コミURL未設定ならボタン非表示（追補§7-5）');

  ok(sorosoroText({ name: '田中 花子', salonName: 'Hair ravel', ownerName: '中村', services: ['カット', 'カラー'] }).includes('田中 花子さん、こんにちは'), 'そろそろ文面');
  ok(ownerBookingText({ name: '田中', phone: '090', services: ['カット'], preferred_date: '2026-07-01', preferred_time: '14:00' }, 'http://a/admin').includes('新しい予約リクエスト'), 'オーナー通知文面');
}

// ================================================================ 6. Webhook署名検証
section('Webhook署名検証（HMAC-SHA256 / timing-safe）');
{
  const secret = 'channel-secret';
  const body = Buffer.from(JSON.stringify({ events: [] }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');
  ok(verifySignature(secret, body, sig) === true, '正しい署名を受理');
  ok(verifySignature(secret, body, sig.slice(0, -2) + 'xx') === false, '改ざん署名を拒否');
  ok(verifySignature(secret, body, '') === false, '署名なしを拒否');
  ok(verifySignature(secret, body, 'short') === false, '長さ不一致でも例外を出さない');
}

// ================================================================ 7. E2E（実サーバー + モックLINE API）
section('E2E：サーバー一気通貫（モックLINE API使用・外部送信なし）');
{
  // --- モックLINE API ---
  const lineCalls = [];
  const mockLine = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    lineCalls.push({ path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v2/bot/info') return res.end(JSON.stringify({ displayName: 'テストサロンBot', basicId: '@test' }));
    if (req.url.startsWith('/v2/bot/profile/')) return res.end(JSON.stringify({ displayName: 'テスト顧客', userId: req.url.split('/').pop() }));
    res.end('{}');
  });
  const linePort = await listen(mockLine);

  // --- 本体サーバー ---
  const dataDir = path.join(TMP, 'e2e-data');
  const config = await loadConfig({}, {
    salonName: 'テストサロン', ownerName: '中村',
    accessToken: 'test-access-token', channelSecret: 'test-channel-secret',
    ownerUserId: 'Uowner000000', cronSecret: 'cron-secret-1', adminToken: '',
    reviewUrl: 'https://g.page/r/review', baseUrl: 'http://salon.example',
    storage: 'fs', dataDir, lineApiBase: `http://127.0.0.1:${linePort}`,
    configDir: path.join(TMP, 'e2e-cfg'), passphrase: 'e2e-pass',
  });
  const app = http.createServer(await createApp(config));
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const lastLine = () => lineCalls[lineCalls.length - 1];

  // ① 予約 → オーナー通知
  const r1 = await post('/api/booking', {
    name: '田中 花子', phone: '090-1111-2222', line_user_id: 'Ucustomer001',
    services: ['カット', 'カラー'], preferred_date: jstToday(1), preferred_time: '14:00', notes: '初めてです',
  });
  const j1 = await r1.json();
  ok(r1.status === 200 && j1.ok && j1.id, '予約API：登録成功');
  ok(j1.notified === true && lastLine().path === '/v2/bot/message/push'
     && lastLine().body.to === 'Uowner000000'
     && lastLine().body.messages[0].text.includes('田中 花子'), '予約API：①オーナーにプッシュ通知');
  ok(lastLine().body.messages[0].text.includes('LINE: テスト顧客'), '予約API：オーナー通知にLINE表示名を記載');
  {
    const all = (await (await fetch(base + '/api/bookings')).json()).bookings;
    const rec = all.find(b => b.id === j1.id);
    ok(rec && rec.line_display_name === 'テスト顧客', '予約API：LINE表示名をプロフィールAPIから自動取得・保存');
  }
  ok(j1.hearingUrl === `http://salon.example/hearing/${j1.id}`, '予約API：ヒアリングURLはbookingId基準');
  const files = await fs.readdir(path.join(dataDir, '予約'));
  ok(files.length === 1 && files[0].endsWith('.md'), '予約API：Markdownファイルが生成される');

  // 必須項目バリデーション
  ok((await post('/api/booking', { phone: '090' })).status === 400, '予約API：name欠落で400');

  // ② 確定 → 顧客にFlex
  const r2 = await post(`/api/bookings/${j1.id}/confirm`, { price: '¥9,900' });
  const j2 = await r2.json();
  ok(r2.status === 200 && j2.booking.status === 'confirmed' && j2.pushed === true, '確定API：ステータス更新');
  ok(lastLine().body.to === 'Ucustomer001' && lastLine().body.messages[0].type === 'flex'
     && JSON.stringify(lastLine().body.messages[0]).includes('¥9,900'), '確定API：②顧客に確定Flex');

  // Webhook：署名不正 → 401（副作用なし）
  const badRes = await fetch(base + '/api/line/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'aW52YWxpZA==' },
    body: JSON.stringify({ events: [{ type: 'message', source: { userId: 'Uhacker' }, message: { type: 'text', text: '空き枠通知を登録する' } }] }),
  });
  ok(badRes.status === 401, 'Webhook：不正署名を401で拒否');
  ok((await fetch(base + '/healthz')).ok === true, 'healthz応答');

  // Webhook：正規署名で購読登録
  const signedPost = (payload) => {
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', 'test-channel-secret').update(raw).digest('base64');
    return fetch(base + '/api/line/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sig }, body: raw,
    });
  };
  const w1 = await signedPost({ events: [{ type: 'message', replyToken: 'rt1', source: { userId: 'Usub001' }, message: { type: 'text', text: '空き枠通知を登録する' } }] });
  ok((await w1.json()).handled[0] === 'alert_on', 'Webhook：⑦テキストで購読登録');
  ok(lastLine().path === '/v2/bot/message/reply' && lastLine().body.replyToken === 'rt1', 'Webhook：登録完了の返信');
  await signedPost({ events: [{ type: 'message', replyToken: 'rt2', source: { userId: 'Usub002' }, message: { type: 'text', text: '空き枠通知を登録する' } }] });
  const w3 = await signedPost({ events: [{ type: 'postback', replyToken: 'rt3', source: { userId: 'Usub002' }, postback: { data: 'action=alert_off' } }] });
  ok((await w3.json()).handled[0] === 'alert_off', 'Webhook：postbackで購読解除');
  const w4 = await signedPost({ events: [{ type: 'follow', replyToken: 'rt4', source: { userId: 'Unew01' } }] });
  ok((await w4.json()).handled[0] === 'follow', 'Webhook：友だち追加でウェルカム');

  // ⑦ 空き枠アラート（cron secret／管理者の両方から実行可）
  const v1 = await post('/api/vacancy-alert', { date: jstToday(2) });
  ok(v1.status === 200, '空き枠API：管理者（localhost）から実行可＝管理画面ボタン対応');
  const v2 = await post('/api/vacancy-alert', { date: jstToday(2), slots: ['14:00〜'] }, { Authorization: 'Bearer cron-secret-1' });
  const vj = await v2.json();
  ok(vj.sent === 1, '空き枠API：アクティブ購読者のみに送信（解除者を除外）');
  ok(lastLine().path === '/v2/bot/message/multicast' && lastLine().body.to.join() === 'Usub001', '空き枠API：multicast送信');

  // 管理画面・本日一覧のオーナーLINE通知
  ok((await (await fetch(base + '/admin')).text()).includes('予約一覧を見る'), '管理画面：配信OK（予約一覧ボタンあり）');
  ok((await (await fetch(base + '/karte')).text()).includes('/api/bookings'), 'カルテ画面：サーバー予約連携コードを同梱');
  const b4 = await (await post('/api/booking', { name: '本日 花子', line_user_id: 'Ucustomer004', services: ['カット'], preferred_date: jstToday(), preferred_time: '11:30' })).json();
  await post(`/api/bookings/${b4.id}/confirm`, {});
  const nt = await (await post('/api/admin/notify-today', {})).json();
  ok(nt.ok === true && nt.count >= 1, '本日一覧通知API：送信成功');
  ok(lastLine().body.to === 'Uowner000000'
     && lastLine().body.messages[0].text.includes('本日のご予約・来店')
     && lastLine().body.messages[0].text.includes('本日 花子'), '本日一覧通知API：オーナーLINEに本日の一覧');

  // ③ 前日リマインドcron（確定済み・明日 = j1）
  const c1 = await fetch(base + '/api/cron/reminder', { headers: { Authorization: 'Bearer cron-secret-1' } });
  const cj1 = await c1.json();
  ok(cj1.sent === 1, 'リマインドcron：明日の確定予約に送信');
  ok(JSON.stringify(lastLine().body.messages[0]).includes(`/hearing/${j1.id}`), 'リマインドcron：③ヒアリングリンク入りFlex');

  // ④ ヒアリング → 予約更新 + オーナー通知
  const png1px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const h1 = await post('/api/hearing', { bookingId: j1.id, concerns: ['くせ毛・うねり', 'ダメージ'], style: 'ふんわりボブ', photoDataUrl: `data:image/png;base64,${png1px}` });
  ok(h1.status === 200, 'ヒアリングAPI：送信成功');
  ok(lastLine().body.to === 'Uowner000000' && lastLine().body.messages[0].text.includes('ふんわりボブ')
     && lastLine().body.messages[0].text.includes('くせ毛・うねり'), 'ヒアリングAPI：④オーナーに通知');
  const photoFiles = await fs.readdir(path.join(dataDir, '写真'));
  ok(photoFiles.length === 1 && photoFiles[0].includes(j1.id), 'ヒアリングAPI：写真がデータフォルダに保存');
  ok(JSON.stringify(await (await fetch(base + `/hearing/${j1.id}`)).text()).includes('田中 花子'), 'ヒアリング画面：予約情報を表示');
  ok((await fetch(base + '/hearing/bk_nothing')).status === 404, 'ヒアリング画面：未知IDは404');

  // ⑤⑥ サンクス + そろそろ cron
  const b2 = await (await post('/api/booking', { name: '渡辺 久美子', line_user_id: 'Ucustomer002', services: ['カラー'], preferred_date: jstToday(-1), preferred_time: '10:00' })).json();
  await post(`/api/bookings/${b2.id}/confirm`, { confirmed_date: jstToday(-1) });
  const b3 = await (await post('/api/booking', { name: '佐藤 美咲', line_user_id: 'Ucustomer003', services: ['カット'], preferred_date: jstToday(-36), preferred_time: '11:00' })).json();
  await post(`/api/bookings/${b3.id}/confirm`, { confirmed_date: jstToday(-36) });
  const c2 = await fetch(base + '/api/cron/thank-you', { headers: { Authorization: 'Bearer cron-secret-1' } });
  const cj2 = await c2.json();
  ok(cj2.thanks === 1, 'サンクスcron：⑤昨日来店分にFlex送信');
  ok(cj2.sorosoro === 1, 'サンクスcron：⑥そろそろ該当（カット36日前）に送信');
  const soroCall = lineCalls.filter(c => c.path === '/v2/bot/message/push' && c.body.to === 'Ucustomer003').pop();
  ok(soroCall && soroCall.body.messages[0].text.includes('そろそろ'), 'サンクスcron：そろそろ文面の確認');

  // 設定API（localhost・マスク）
  const s1 = await (await fetch(base + '/api/settings')).json();
  ok(s1.accessToken === '••••oken' && !JSON.stringify(s1).includes('test-access-token'), '設定API：トークンはマスクのみ');
  ok(s1.webhookUrl === 'http://salon.example/api/line/webhook', '設定API：Webhook URLの提示');
  const s2 = await post('/api/settings', { salonName: '保存テスト', accessToken: 'new-token-XYZ' });
  ok((await s2.json()).ok === true, '設定API：暗号化保存');
  const cfgFiles = await fs.readFile(path.join(TMP, 'e2e-cfg', 'settings.enc.json'), 'utf8');
  ok(!cfgFiles.includes('new-token-XYZ'), '設定ファイルに平文トークンが存在しない');

  // 接続テストAPI（トークン一時利用）
  const t1 = await (await post('/api/line/test', { accessToken: 'probe-token' })).json();
  ok(t1.ok === true && t1.bot.displayName === 'テストサロンBot', '接続テストAPI：Bot情報取得');
  ok(lastLine().path === '/v2/bot/info' && lastLine().auth === 'Bearer probe-token', '接続テストAPI：渡したトークンを一時利用');

  // ADMIN_TOKEN ゲート（リモート運用想定）
  const gateCfg = await loadConfig({}, { ...config, adminToken: 'admin-tok-1', _secretStore: undefined, configDir: path.join(TMP, 'gate-cfg'), passphrase: 'x' });
  const gateApp = http.createServer(await createApp(gateCfg));
  const gatePort = await listen(gateApp);
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/settings`)).status === 401, 'ADMIN_TOKEN設定時：トークンなしは401');
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/settings`, { headers: { 'X-Admin-Token': 'admin-tok-1' } })).status === 200, 'ADMIN_TOKEN設定時：正しいトークンで許可');
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/cron/reminder`)).status === 401, 'ADMIN_TOKEN設定時：cronも認証なしは401');
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/cron/thank-you`, { headers: { Authorization: 'Bearer wrong-secret' } })).status === 401, 'ADMIN_TOKEN設定時：不正Bearerは401');
  gateApp.close();

  app.close(); mockLine.close();
}

// ================================================================ 8. Vercelアダプタ（api/index.mjs）
section('Vercelアダプタ（Deployボタン経路のスモークテスト）');
{
  const saved = {};
  const testEnv = {
    SALON_NAME: 'アダプタサロン', HR_STORAGE: 'fs',
    DATA_DIR: path.join(TMP, 'adapter-data'), ADMIN_TOKEN: 'adp-admin-1',
  };
  for (const [k, v] of Object.entries(testEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const { default: vercelHandler, config: fnConfig } = await import('../api/index.mjs');
    ok(fnConfig?.api?.bodyParser === false, 'bodyParser無効化（Webhook署名検証のため）');
    const srv = http.createServer(vercelHandler);
    const port = await listen(srv);
    const base = `http://127.0.0.1:${port}`;
    ok((await (await fetch(base + '/healthz')).json()).ok === true, 'アダプタ経由でhealthz応答');
    ok((await (await fetch(base + '/setup')).text()).includes('LINE CONNECT'), 'アダプタ経由で設定画面');
    ok((await (await fetch(base + '/karte')).text()).includes('hair ravel'), 'アダプタ経由でカルテ画面（同梱確認）');
    ok((await (await fetch(base + '/admin')).text()).includes('予約一覧を見る'), 'アダプタ経由で管理画面');
    const bk = await (await fetch(base + '/api/booking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '複製 太郎', preferred_date: jstToday(3), preferred_time: '12:00' }),
    })).json();
    ok(bk.ok === true, 'アダプタ経由で予約API');
    ok((await fetch(base + '/api/settings')).status === 401, 'アダプタ経由でもADMIN_TOKENゲート有効');
    ok((await fetch(base + '/api/settings', { headers: { 'X-Admin-Token': 'adp-admin-1' } })).status === 200, 'アダプタ経由で管理トークン認証');
    srv.close();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ================================================================ 結果
console.log('\n' + '═'.repeat(46));
console.log(`結果: ${pass} 成功 / ${fail} 失敗`);
if (failures.length) { console.log('失敗項目:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
