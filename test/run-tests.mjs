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
import { buildConfirmFlex, buildReminderFlex, buildThankYouFlex, buildProposalFlex, sorosoroText, ownerBookingText, ownerTodayListText, ownerAcceptedText, ownerRepickText } from '../lib/line-client.mjs';
import { verifySignature } from '../lib/webhook-handler.mjs';
import { buildExportModel, customerCsv, historyCsv, dataJson, readmeText } from '../lib/drive-export.mjs';
import { buildMobileViewHtml } from '../lib/mobile-view.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, createApp } from '../server.mjs';
import { STAFF, NO_STAFF, VALID_STAFF_KEYS, staffByKey } from '../lib/staff.mjs';

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

// ================================================================ 2b. 顧客CSV & カルテ永続化
section('顧客CSV & カルテ永続化');
{
  const store = createMarkdownStore(createFsBackend({ dataDir: path.join(TMP, 'kc-data') }));
  // CSV往復：カンマ・ダブルクォート・改行・日本語入り
  const c1 = await store.upsertCustomer({
    id: 'c1', name: '佐藤, 美咲', kana: 'サトウ ミサキ', phone: '090-1234-5678',
    birthday: '1992-04-15', line_user_id: 'Uabc', line_name: 'みさき',
    note: 'ダブル"クォート"とカンマ,入り\n二行目',
  });
  ok(c1.created_at && c1.updated_at, '顧客upsert：created_at/updated_atがサーバー側で設定される');
  const list1 = await store.listCustomers();
  ok(list1.length === 1, '顧客list：1件');
  const got = list1[0];
  ok(got.name === '佐藤, 美咲', 'CSV往復：カンマ入りフィールドを正しく復元');
  ok(got.note.includes('"クォート"') && got.note.includes('カンマ,入り'), 'CSV往復：ダブルクォート・カンマのエスケープ復元');
  ok(!got.note.includes('\n') && got.note.includes('二行目'), 'CSV書き込み時に改行を全角スペースへ置換');
  // 同id上書きで件数が増えない
  await store.upsertCustomer({ id: 'c1', name: '佐藤 美咲（改名）' });
  const list2 = await store.listCustomers();
  ok(list2.length === 1 && list2[0].name === '佐藤 美咲（改名）', '同id上書きで件数が増えない・値が更新される');
  ok(list2[0].created_at === c1.created_at, 'created_atは新規時のみ（上書きで不変）');
  await store.upsertCustomer({ id: 'c2', name: '田中 結衣' });
  ok((await store.listCustomers()).length === 2, '別idは追加される');

  // カルテupsert往復：recipes_json経由でrecipesが復元される／photosが保存されない
  const k1 = await store.upsertCarte({
    id: 'k1', customerId: 'c1', date: '2026-05-02', services: ['カット', 'カラー'],
    recipes: { color: { family: '8Lv ベージュ', detail: 'OX6% 30分', memo: '乳化10分' } },
    products: ['オージュア クエンチ'], memo: '前髪は眉下キープ。',
    photos: { before: 'data:image/png;base64,AAAA' },
  });
  ok(k1.recipes && k1.recipes.color && k1.recipes.color.family === '8Lv ベージュ', 'カルテ往復：recipes_json経由でrecipesオブジェクトが復元される');
  ok(k1.customer_id === 'c1', 'カルテ往復：customerId→customer_idに正規化');
  ok(Array.isArray(k1.photos), 'カルテ：photosはメタ配列として保持される');
  const carteFiles = await fs.readdir(path.join(TMP, 'kc-data', 'カルテ'));
  ok(carteFiles.length === 1 && carteFiles[0].includes('k1'), 'カルテ：1件1ファイルで保存');
  const k1raw = await fs.readFile(path.join(TMP, 'kc-data', 'カルテ', carteFiles[0]), 'utf8');
  ok(!k1raw.includes('data:image') && !k1raw.includes('AAAA'), 'カルテ：写真バイトはMarkdownに保存されない');
  const carteText = await store.backend.readFile('カルテ/' + carteFiles[0]);
  ok(!carteText.includes('data:image'), 'カルテファイルに写真データが含まれない');
  ok(carteText.includes('カラー：8Lv ベージュ'), 'カルテ本文にラベル付きレシピサマリー');
  // 同id上書き：件数が増えない・同ファイルを維持
  await store.upsertCarte({ id: 'k1', customerId: 'c1', date: '2026-05-02', services: ['カット'], memo: '更新後メモ' });
  const cartes2 = await store.listCartes();
  ok(cartes2.length === 1 && cartes2[0].memo === '更新後メモ', 'カルテ同id上書きで件数が増えない・更新される');
  ok((await fs.readdir(path.join(TMP, 'kc-data', 'カルテ'))).length === 1, 'カルテ上書きで同一ファイルを維持');

  // ownerTodayListText（秘書化）の単体検証
  const txt = ownerTodayListText({
    dateLabel: '6/12',
    bookings: [{
      name: '田中 花子', confirmed_time: '14:00', services: ['カット', 'カラー'], status: 'confirmed', line_user_id: 'Ux',
      hearing_concerns: ['くせ毛・うねり', 'ダメージ'], hearing_style: 'ふんわりボブ',
      _customer: { id: 'c9', birthday: '2000-06-25' },
      _lastCarte: { date: '2026-05-02', services: ['カット', 'カラー'], memo: '前髪は眉下キープ。' },
    }],
  });
  ok(txt.includes('🎂 6/25 お誕生日（今月！）'), '本日一覧（秘書）：誕生日＋今月！表示');
  ok(txt.includes('📒 前回 5/2 カット＋カラー「前髪は眉下キープ。」'), '本日一覧（秘書）：前回カルテ行');
  ok(txt.includes('✏️ ヒアリング：くせ毛・うねり・ダメージ／ふんわりボブ'), '本日一覧（秘書）：ヒアリング行');
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
  ok(tfs.includes('CMCトリートメント') && tfs.includes('Googleマップで感想を書く'), 'サンクスFlexにケア提案と感想ボタン');
  ok(tfs.includes('もちろん任意です'), 'サンクスFlex：reviewUrlありで口コミお願い文言を追加');
  const tf2 = JSON.stringify(buildThankYouFlex({ salonName: 's', name: 'n', services: ['カット'] }));
  ok(!tf2.includes('感想を書く') && !tf2.includes('もちろん任意です'), '口コミURL未設定ならボタンも文言も非表示（追補§7-5）');

  ok(sorosoroText({ name: '田中 花子', salonName: 'Hair ravel', ownerName: '中村', services: ['カット', 'カラー'] }).includes('田中 花子さん、こんにちは'), 'そろそろ文面');
  ok(ownerBookingText({ name: '田中', phone: '090', services: ['カット'], preferred_date: '2026-07-01', preferred_time: '14:00' }, 'http://a/admin').includes('新しい予約リクエスト'), 'オーナー通知文面');

  // 別日提案Flex（アクセント色ヘッダー・postbackボタン）
  const pf = buildProposalFlex({ salonName: 'Hair ravel', name: '田中', origDate: '2026-07-01', origTime: '14:00', date: '2026-07-03', time: '15:00', bookingId: 'bkX' });
  const pfs = JSON.stringify(pf);
  ok(pf.contents.header.backgroundColor === '#8C6B5A' && pfs.includes('日時のご相談'), '提案Flexはアクセント色ヘッダー');
  ok(pfs.includes('action=booking_accept&id=bkX') && pfs.includes('action=booking_repick&id=bkX'), '提案Flexのpostback dataにbooking_accept/repick');
  ok(pfs.includes('2026-07-03') && pfs.includes('あいにく'), '提案Flexに提案日時と本文');
  ok(ownerAcceptedText({ name: '田中', confirmed_date: '2026-07-03', confirmed_time: '15:00', services: ['カット'] }).includes('承諾しました'), 'オーナー承諾通知文面');
  ok(ownerRepickText({ name: '田中' }, 'http://x/booking').includes('合わない'), 'オーナー選び直し通知文面');

  // ---------- タスク1：サンクスFlex「使ったアイテム」拡張 ----------
  // products あり + careUrl あり → 「使ったアイテムを見る」ボタン + 本日のアイテム行
  const tfP = buildThankYouFlex({ salonName: 'Hair ravel', name: '鈴木', services: ['カラー'],
    careUrl: 'https://salon.example/care', products: ['オージュア クエンチ', 'N. ポリッシュオイル'] });
  const tfPs = JSON.stringify(tfP);
  ok(tfPs.includes('使ったアイテムを見る'), 'サンクスFlex(products+careUrl)：「使ったアイテムを見る」ボタンが出る');
  ok(tfPs.includes('https://salon.example/care'), 'サンクスFlex(products)：careUrlに飛ぶ');
  ok(tfPs.includes('本日のアイテム'), 'サンクスFlex(products)：「本日のアイテム」行が出る');
  ok(tfPs.includes('オージュア クエンチ'), 'サンクスFlex(products)：商品名が本文に含まれる');
  ok(!tfPs.includes('ホームケアの詳しい使い方'), 'サンクスFlex(products+careUrl)：旧ボタン文言は出ない');
  // products なし + careUrl あり → 旧ボタン「ホームケアの詳しい使い方」
  const tfNP = buildThankYouFlex({ salonName: 'Hair ravel', name: '鈴木', services: ['カラー'],
    careUrl: 'https://salon.example/care' });
  const tfNPs = JSON.stringify(tfNP);
  ok(tfNPs.includes('ホームケアの詳しい使い方'), 'サンクスFlex(products無し)：旧ボタン文言が出る');
  ok(!tfNPs.includes('使ったアイテムを見る'), 'サンクスFlex(products無し)：「使ったアイテムを見る」は出ない');
  ok(!tfNPs.includes('本日のアイテム'), 'サンクスFlex(products無し)：アイテム行は出ない');
  // products あり + careUrl なし → ボタン不要、アイテム行のみ
  const tfPC = buildThankYouFlex({ salonName: 'Hair ravel', name: '鈴木', services: ['カラー'],
    products: ['エルジューダ MO'] });
  const tfPCs = JSON.stringify(tfPC);
  ok(tfPCs.includes('本日のアイテム') && tfPCs.includes('エルジューダ MO'), 'サンクスFlex(products+careUrl無し)：アイテム行は出る');
  ok(!tfPCs.includes('使ったアイテムを見る'), 'サンクスFlex(products+careUrl無し)：careUrlなしはボタンなし');

  // ---------- タスク2：ownerTodayListText 誕生日±3日強調 + 秘書文体 ----------
  // ① 誕生日当日 → 「🎂★ M/D お誕生日が近いです（本日！）」
  const todayBase = '2026-06-13';
  const txtBirth0 = ownerTodayListText({
    dateLabel: '6/13', today: todayBase,
    bookings: [{ name: '誕生日 花子', confirmed_time: '11:00', services: ['カット'], status: 'confirmed', line_user_id: 'Ux',
      _customer: { id: 'cB', birthday: '1990-06-13' }, _lastCarte: null }],
  });
  ok(txtBirth0.includes('🎂★') && txtBirth0.includes('本日！'), '誕生日当日：★強調＋本日！');
  // ② 2日後 → 「🎂★ M/D お誕生日が近いです（2日後）」
  const txtBirth2 = ownerTodayListText({
    dateLabel: '6/13', today: todayBase,
    bookings: [{ name: '誕生日 花子', confirmed_time: '11:00', services: ['カット'], status: 'confirmed', line_user_id: 'Ux',
      _customer: { id: 'cB', birthday: '1990-06-15' }, _lastCarte: null }],
  });
  ok(txtBirth2.includes('🎂★') && txtBirth2.includes('2日後'), '誕生日2日後：★強調＋2日後');
  // ③ 1日前 → 「🎂★ M/D お誕生日が近いです（1日前）」
  const txtBirthM1 = ownerTodayListText({
    dateLabel: '6/13', today: todayBase,
    bookings: [{ name: '誕生日 花子', confirmed_time: '11:00', services: ['カット'], status: 'confirmed', line_user_id: 'Ux',
      _customer: { id: 'cB', birthday: '1990-06-12' }, _lastCarte: null }],
  });
  ok(txtBirthM1.includes('🎂★') && txtBirthM1.includes('1日前'), '誕生日1日前：★強調＋1日前');
  // ④ 4日後 → ★なし（通常の「今月！」判定）
  const txtBirth4 = ownerTodayListText({
    dateLabel: '6/13', today: todayBase,
    bookings: [{ name: '誕生日 花子', confirmed_time: '11:00', services: ['カット'], status: 'confirmed', line_user_id: 'Ux',
      _customer: { id: 'cB', birthday: '1990-06-17' }, _lastCarte: null }],
  });
  ok(!txtBirth4.includes('🎂★'), '誕生日4日後：★強調なし');
  ok(txtBirth4.includes('（今月！）'), '誕生日4日後・今月：（今月！）は出る');
  // ⑤ 年またぎ（today=12/30, birthday=1/2 → 3日後）
  const txtBirthXY = ownerTodayListText({
    dateLabel: '12/30', today: '2026-12-30',
    bookings: [{ name: '正月 太郎', confirmed_time: '10:00', services: ['カット'], status: 'confirmed', line_user_id: 'Ux',
      _customer: { id: 'cC', birthday: '1985-01-02' }, _lastCarte: null }],
  });
  ok(txtBirthXY.includes('🎂★') && txtBirthXY.includes('3日後'), '年またぎ誕生日（12/30→1/2）：★強調＋3日後');
  // ⑥ 秘書文体：冒頭に「おはようございます」と件数が出る
  const txtGreet = ownerTodayListText({
    dateLabel: '6/13', today: todayBase,
    bookings: [{ name: 'テスト 花子', confirmed_time: '14:00', services: ['カット'], status: 'confirmed', line_user_id: 'Ux',
      _customer: null, _lastCarte: null }],
  });
  ok(txtGreet.includes('おはようございます') && txtGreet.includes('1件'), '秘書文体：冒頭の挨拶と件数');
  // ⑦ 予約なしの場合も「おはようございます」
  const txtEmpty = ownerTodayListText({ dateLabel: '6/13', today: todayBase, bookings: [] });
  ok(txtEmpty.includes('おはようございます') && txtEmpty.includes('ございません'), '予約なし：おはようございます');
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
  // 配信量は mockUsage で差し替え可能（既定5＝上限200未満なので既存の送信テストが通る）。
  let mockUsage = 5;
  const lineCalls = [];
  const mockLine = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    lineCalls.push({ path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v2/bot/info') return res.end(JSON.stringify({ displayName: 'テストサロンBot', basicId: '@test' }));
    if (req.url.startsWith('/v2/bot/profile/')) return res.end(JSON.stringify({ displayName: 'テスト顧客', userId: req.url.split('/').pop() }));
    // 監視API（B/C/D機能）
    if (req.url === '/v2/bot/message/quota') return res.end(JSON.stringify({ type: 'limited', value: 200 }));
    if (req.url === '/v2/bot/message/quota/consumption') return res.end(JSON.stringify({ totalUsage: mockUsage }));
    if (req.url.startsWith('/v2/bot/insight/followers')) return res.end(JSON.stringify({ status: 'ready', followers: 3, targetedReaches: 3, blocks: 0 }));
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
  ok((await (await fetch(base + '/karte')).text()).includes('/api/sync'), 'カルテ画面：顧客・カルテ同期コード（/api/sync）を同梱');

  // 顧客・カルテ同期API（一括 → 取得）
  const sync1 = await (await post('/api/sync', {
    customers: [
      { id: 'c1', name: '田中 花子', phone: '090-1111-2222', line_user_id: 'Ucustomer004', birthday: `${jstToday().slice(0,4)}-${jstToday().slice(5,7)}-25` },
    ],
    cartes: [
      { id: 'k1', customerId: 'c1', date: jstToday(-30), services: ['カット', 'カラー'],
        recipes: { color: { family: '8Lv ベージュ', detail: 'x', memo: '' } },
        memo: '前回メモ：顔まわりレイヤー気に入っていただけた', photos: { before: 'data:image/png;base64,ZZZ' } },
    ],
  })).json();
  ok(sync1.ok === true && sync1.customers === 1 && sync1.cartes === 1, '同期API：POST一括登録の件数');
  const sg = await (await fetch(base + '/api/sync')).json();
  ok(sg.customers.length === 1 && sg.customers[0].name === '田中 花子', '同期API：GETで顧客を返す');
  const gk = sg.cartes.find(k => k.id === 'k1');
  ok(gk && gk.recipes && gk.recipes.color && gk.recipes.color.family === '8Lv ベージュ', '同期API：GETでカルテのrecipesを復元して返す');
  ok(gk && Array.isArray(gk.photos) && !JSON.stringify(sg).includes('data:image'), '同期API：写真バイトはサーバーに保存されない（メタのみ）');
  // 単件upsert（k1は秘書通知で参照するため別idで検証）
  ok((await (await post('/api/customers', { id: 'c1', note: '追記メモ' })).json()).ok === true, '同期API：POST /api/customers 単件upsert');
  ok((await (await post('/api/cartes', { id: 'k99', customerId: 'c1', date: jstToday(-60), services: ['カット'], memo: 'm', photos: { x: 'y' } })).json()).ok === true, '同期API：POST /api/cartes 単件upsert（photos無視）');

  const b4 = await (await post('/api/booking', { name: '本日 花子', line_user_id: 'Ucustomer004', services: ['カット'], preferred_date: jstToday(), preferred_time: '11:30' })).json();
  await post(`/api/bookings/${b4.id}/confirm`, {});
  const nt = await (await post('/api/admin/notify-today', {})).json();
  ok(nt.ok === true && nt.count >= 1, '本日一覧通知API：送信成功');
  const todayMsg = lastLine().body.messages[0].text;
  ok(lastLine().body.to === 'Uowner000000'
     && todayMsg.includes('本日のご予約・来店')
     && todayMsg.includes('本日 花子'), '本日一覧通知API：オーナーLINEに本日の一覧');
  // 「秘書」化：誕生日（今月）＋過去カルテ（メモ付き）＋ヒアリングが本文に含まれる
  // ※ b4（本日 花子）は line_user_id=Ucustomer004 で顧客c1（誕生日=今月25日）にマッチ
  ok(todayMsg.includes('🎂') && todayMsg.includes('（今月！）'), '本日一覧（秘書）：誕生日（今月！）が本文に出る');
  ok(todayMsg.includes('📒 前回') && todayMsg.includes('顔まわりレイヤー'), '本日一覧（秘書）：過去カルテのメモ断片が本文に出る');

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

  // ============ 予約フォーム & 別日提案フロー ============
  // 予約フォーム配信（CFG注入・liffId未設定時は空）
  const bkHtml = await (await fetch(base + '/booking')).text();
  ok(bkHtml.includes('アプリエカラー') && bkHtml.includes('/api/booking'), '予約フォーム：メニューマスターとPOST先を同梱');
  {
    const cfgM = /const CFG = (\{[\s\S]*?\});/.exec(bkHtml);
    const cfg = cfgM ? JSON.parse(cfgM[1]) : null;
    ok(cfg && (cfg.liffId === '' || cfg.liffId === null), '予約フォーム：CFG注入・liffId未設定時は空');
    ok(cfg && typeof cfg.salonName === 'string' && cfg.salonName.length > 0, '予約フォーム：CFGにsalonNameを注入');
  }
  ok((await (await fetch(base + '/admin')).text()).includes('新着リクエスト'), '管理画面：新着リクエストセクションを含む');

  // 別日提案：認可なし（ADMIN_TOKENゲートはアプリ側）— gateAppで検証するためここではlocalhostで成功系
  // まず提案対象の新規予約を作る（line_user_idあり）
  const pb = await (await post('/api/booking', { name: '提案 太郎', phone: '080-0000-1111', line_user_id: 'Upropose01', services: ['カット（ナノバブル頭皮洗浄付き）'], preferred_date: jstToday(5), preferred_time: '14:00' })).json();
  // date/time欠落で400
  ok((await post(`/api/bookings/${pb.id}/propose`, { date: '' })).status === 400, '提案API：date/time欠落で400');
  // 提案成功 → status=proposed・proposed_date保存・顧客へFlex push
  const pr = await (await post(`/api/bookings/${pb.id}/propose`, { date: jstToday(6), time: '16:00' })).json();
  ok(pr.ok === true && pr.booking.status === 'proposed' && pr.booking.proposed_date === jstToday(6) && pr.pushed === true, '提案API：proposed化＋proposed_date保存＋push');
  ok(lastLine().body.to === 'Upropose01' && JSON.stringify(lastLine().body.messages[0]).includes('action=booking_accept&id='), '提案API：顧客へ提案Flex（postback dataにbooking_accept）');
  // line_user_idなし予約 → pushed:false
  const pb2 = await (await post('/api/booking', { name: '電話 のみ', phone: '080-2222-3333', services: ['カット（ナノバブル頭皮洗浄付き）'], preferred_date: jstToday(5), preferred_time: '15:00' })).json();
  const pr2 = await (await post(`/api/bookings/${pb2.id}/propose`, { date: jstToday(6), time: '17:00' })).json();
  ok(pr2.ok === true && pr2.pushed === false, '提案API：line_user_idなしはpushed:false（オーナーが電話連絡）');

  // Webhook booking_accept（署名付きpostback）→ proposed→confirmed・確定Flex reply＋オーナーpush
  const linesBeforeAccept = lineCalls.length;
  const wa = await signedPost({ events: [{ type: 'postback', replyToken: 'rtA', source: { userId: 'Upropose01' }, postback: { data: `action=booking_accept&id=${pb.id}` } }] });
  ok((await wa.json()).handled[0] === 'booking_accept', 'Webhook：booking_acceptを処理');
  {
    const after = lineCalls.slice(linesBeforeAccept);
    const replyFlex = after.find(c => c.path === '/v2/bot/message/reply' && c.body.replyToken === 'rtA' && c.body.messages[0].type === 'flex');
    const ownerPush = after.find(c => c.path === '/v2/bot/message/push' && c.body.to === 'Uowner000000' && c.body.messages[0].text.includes('承諾'));
    ok(!!replyFlex, 'Webhook booking_accept：顧客へ確定Flexをreply');
    ok(!!ownerPush, 'Webhook booking_accept：オーナーへ承諾通知をpush');
    const got = (await (await fetch(base + '/api/bookings')).json()).bookings.find(b => b.id === pb.id);
    ok(got && got.status === 'confirmed' && got.confirmed_date === jstToday(6) && got.confirmed_time === '16:00', 'Webhook booking_accept：proposed→confirmed（提案日時を確定）');
  }
  // 二重送信 → 2回目は「処理済み」replyで状態不変
  const wa2 = await signedPost({ events: [{ type: 'postback', replyToken: 'rtA2', source: { userId: 'Upropose01' }, postback: { data: `action=booking_accept&id=${pb.id}` } }] });
  ok((await wa2.json()).handled[0] === 'booking_accept', 'Webhook：二重booking_acceptもhandled');
  ok(lastLine().path === '/v2/bot/message/reply' && lastLine().body.replyToken === 'rtA2' && lastLine().body.messages[0].text.includes('すでに処理済み'), 'Webhook booking_accept二重：処理済みreply（状態は変えない）');

  // Webhook booking_repick → cancelled＋オーナーpush
  const pb3 = await (await post('/api/booking', { name: '辞退 花子', phone: '080-4444-5555', line_user_id: 'Urepick01', services: ['カット（ナノバブル頭皮洗浄付き）'], preferred_date: jstToday(7), preferred_time: '11:00', notes: '既存メモ' })).json();
  await post(`/api/bookings/${pb3.id}/propose`, { date: jstToday(8), time: '12:00' });
  const linesBeforeRepick = lineCalls.length;
  const wr = await signedPost({ events: [{ type: 'postback', replyToken: 'rtR', source: { userId: 'Urepick01' }, postback: { data: `action=booking_repick&id=${pb3.id}` } }] });
  ok((await wr.json()).handled[0] === 'booking_repick', 'Webhook：booking_repickを処理');
  {
    const after = lineCalls.slice(linesBeforeRepick);
    const ownerPush = after.find(c => c.path === '/v2/bot/message/push' && c.body.to === 'Uowner000000' && c.body.messages[0].text.includes('合わない'));
    ok(!!ownerPush, 'Webhook booking_repick：オーナーへ選び直し通知をpush');
    const got = (await (await fetch(base + '/api/bookings')).json()).bookings.find(b => b.id === pb3.id);
    ok(got && got.status === 'cancelled' && got.notes.includes('別日時を希望'), 'Webhook booking_repick：cancelled＋notesに別日時希望を追記');
  }

  // ADMIN_TOKEN ゲート（リモート運用想定）
  const gateCfg = await loadConfig({}, { ...config, adminToken: 'admin-tok-1', _secretStore: undefined, configDir: path.join(TMP, 'gate-cfg'), passphrase: 'x' });
  const gateApp = http.createServer(await createApp(gateCfg));
  const gatePort = await listen(gateApp);
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/settings`)).status === 401, 'ADMIN_TOKEN設定時：トークンなしは401');
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/settings`, { headers: { 'X-Admin-Token': 'admin-tok-1' } })).status === 200, 'ADMIN_TOKEN設定時：正しいトークンで許可');
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/cron/reminder`)).status === 401, 'ADMIN_TOKEN設定時：cronも認証なしは401');
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/cron/thank-you`, { headers: { Authorization: 'Bearer wrong-secret' } })).status === 401, 'ADMIN_TOKEN設定時：不正Bearerは401');
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/bookings/bkX/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"date":"2026-07-03","time":"15:00"}' })).status === 401, '提案API：ADMIN_TOKEN設定時に認可なしは401');
  ok((await fetch(`http://127.0.0.1:${gatePort}/api/admin/line-stats`)).status === 401, 'line-stats：ADMIN_TOKENなしは401');
  gateApp.close();

  // ============ B/C/D：配信量監視・ライブ統計・月次レポート ============
  // C. ライブ統計（adminOk）：used=5 / limit=200 / followers=3（前日insight）
  {
    const st = await (await fetch(base + '/api/admin/line-stats')).json();
    ok(st.used === 5 && st.limit === 200 && st.remaining === 195, 'line-stats：used/limit/remaining');
    ok(st.followers === 3 && st.followersStatus === 'ready', 'line-stats：友だち数（前日insight ready）');
  }

  // D. 月次レポート（adminOk）：当月予約をseedして newBookings/confirmed/visits・friends/sent が返る
  {
    // 当月・今日以前で確定した予約（来店扱い）を1件seed
    const mb = await (await post('/api/booking', { name: '月次 太郎', line_user_id: 'Umonthly01', services: ['カット'], preferred_date: jstToday(), preferred_time: '13:00' })).json();
    await post(`/api/bookings/${mb.id}/confirm`, { confirmed_date: jstToday() });
    const rep = await (await fetch(base + '/api/admin/monthly-report')).json();
    ok(rep.month === jstToday().slice(0, 7), 'monthly-report：当月(YYYY-MM)');
    ok(rep.newBookings >= 1 && rep.confirmed >= 1 && rep.visits >= 1, 'monthly-report：新規/確定/来店の集計');
    ok(rep.friends === 3 && rep.sent === 5 && rep.limit === 200, 'monthly-report：friends/sent/limit');
  }

  // D. cronで月次レポートをオーナーへ1通push（cronOk/adminOk）
  {
    const before = lineCalls.length;
    const cr = await fetch(base + '/api/cron/monthly-report', { headers: { Authorization: 'Bearer cron-secret-1' } });
    const crj = await cr.json();
    ok(cr.status === 200 && crj.ok === true && crj.notified === true, 'cron/monthly-report：実行成功・オーナー通知');
    const sent = lineCalls.slice(before).filter(c => c.path === '/v2/bot/message/push' && c.body.to === 'Uowner000000');
    ok(sent.length === 1 && sent[0].body.messages[0].text.includes('月次レポート'), 'cron/monthly-report：オーナーへ1通・本文に「月次レポート」');
  }

  // B. 配信上限ガード：mockUsage=200 で別アプリ（キャッシュ初期化）の確定API → 顧客Flexが送られない＋ログに「配信上限」
  {
    mockUsage = 200;
    const guardDir = path.join(TMP, 'guard-data');
    const gcfg = await loadConfig({}, {
      salonName: 'ガードサロン', ownerName: '中村',
      accessToken: 'test-access-token', channelSecret: 'test-channel-secret',
      ownerUserId: 'Uguard000000', adminToken: '',
      storage: 'fs', dataDir: guardDir, lineApiBase: `http://127.0.0.1:${linePort}`,
      configDir: path.join(TMP, 'guard-cfg'), passphrase: 'guard-pass',
    });
    const gApp = http.createServer(await createApp(gcfg));
    const gPort = await listen(gApp);
    const gBase = `http://127.0.0.1:${gPort}`;
    const gPost = (pp, bd, hd = {}) => fetch(gBase + pp, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hd }, body: JSON.stringify(bd) });
    // LINE連携の確定対象を作る
    const gb = await (await gPost('/api/booking', { name: '上限 花子', line_user_id: 'Uoverlimit01', services: ['カット'], preferred_date: jstToday(1), preferred_time: '10:00' })).json();
    const beforeG = lineCalls.length;
    const gc = await (await gPost(`/api/bookings/${gb.id}/confirm`, {})).json();
    const pushesToCustomer = lineCalls.slice(beforeG).filter(c => c.path === '/v2/bot/message/push' && c.body.to === 'Uoverlimit01');
    ok(pushesToCustomer.length === 0 && gc.pushed === false, '配信上限ガード：mockUsage=200で確定Flexを送らない（pushed:false）');
    const logTxt = await fs.readFile(path.join(guardDir, 'ログ', `${jstToday()}.md`), 'utf8').catch(() => '');
    ok(logTxt.includes('配信上限'), '配信上限ガード：ログに「配信上限」を記録');
    gApp.close();

    // mockUsageを5に戻すと別アプリ（新キャッシュ）では送られる
    mockUsage = 5;
    const g2 = await createApp(await loadConfig({}, {
      salonName: 'ガードサロン2', accessToken: 'test-access-token', channelSecret: 'test-channel-secret',
      ownerUserId: 'Uguard000000', adminToken: '', storage: 'fs', dataDir: path.join(TMP, 'guard2-data'),
      lineApiBase: `http://127.0.0.1:${linePort}`, configDir: path.join(TMP, 'guard2-cfg'), passphrase: 'g2',
    }));
    const g2App = http.createServer(g2);
    const g2Port = await listen(g2App);
    const g2Base = `http://127.0.0.1:${g2Port}`;
    const g2Post = (pp, bd) => fetch(g2Base + pp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bd) });
    const g2b = await (await g2Post('/api/booking', { name: '通常 太郎', line_user_id: 'Unormal01', services: ['カット'], preferred_date: jstToday(1), preferred_time: '11:00' })).json();
    const beforeG2 = lineCalls.length;
    const g2c = await (await g2Post(`/api/bookings/${g2b.id}/confirm`, {})).json();
    const pushG2 = lineCalls.slice(beforeG2).filter(c => c.path === '/v2/bot/message/push' && c.body.to === 'Unormal01');
    ok(pushG2.length === 1 && g2c.pushed === true, '配信上限ガード：mockUsage=5に戻すと確定Flexが送られる');
    g2App.close();
  }

  // ============ LINE自動配信 管理パネル（カタログ・トグル・プレビュー） ============
  // GET /api/admin/line-messages：14件・各にpreview・freeフラグ・401ゲート
  {
    const lm = await (await fetch(base + '/api/admin/line-messages')).json();
    ok(Array.isArray(lm.messages) && lm.messages.length === 14, 'line-messages：14件返る');
    ok(lm.messages.every(m => m.preview && typeof m.preview.kind === 'string'), 'line-messages：各にpreviewがある');
    const freeKeys = lm.messages.filter(m => m.free).map(m => m.key).sort().join(',');
    ok(freeKeys === 'accept_reply,subscribe_reply,welcome', 'line-messages：freeフラグは welcome/subscribe_reply/accept_reply のみtrue');
    ok(lm.messages.every(m => m.on === true), 'line-messages：既定は全on');
    // flexToPreview：confirmのプレビューに headerText とサンプルの「¥9,900」相当が含まれる
    const cm = lm.messages.find(m => m.key === 'confirm');
    ok(cm.preview.kind === 'flex' && cm.preview.headerText.includes('ご予約確定'), 'flexToPreview：confirmのheaderText');
    ok(JSON.stringify(cm.preview).includes('¥9,900'), 'flexToPreview：confirmプレビューに¥9,900');
  }
  // 別アプリ（ADMIN_TOKENあり）で401ゲートを検証
  {
    const lmGateCfg = await loadConfig({}, {
      salonName: 's', accessToken: 'test-access-token', channelSecret: 'test-channel-secret',
      ownerUserId: 'Uowner000000', adminToken: 'lm-tok', storage: 'fs', dataDir: path.join(TMP, 'lm-gate-data'),
      lineApiBase: `http://127.0.0.1:${linePort}`, configDir: path.join(TMP, 'lm-gate-cfg'), passphrase: 'lm',
    });
    const lmGate = http.createServer(await createApp(lmGateCfg));
    const lmPort = await listen(lmGate);
    ok((await fetch(`http://127.0.0.1:${lmPort}/api/admin/line-messages`)).status === 401, 'line-messages：ADMIN_TOKENなしは401');
    ok((await fetch(`http://127.0.0.1:${lmPort}/api/admin/line-messages`, { headers: { 'X-Admin-Token': 'lm-tok' } })).status === 200, 'line-messages：正しいトークンで200');
    // POST：不正keyは400
    ok((await fetch(`http://127.0.0.1:${lmPort}/api/admin/line-messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'lm-tok' }, body: JSON.stringify({ key: 'bogus', on: false }) })).status === 400, 'line-messages POST：不正keyは400');
    lmGate.close();
  }
  // POST：confirmをoff → /confirm で確定Flexが送られない（pushが増えない）＋ログにスキップ／確定自体は成立
  {
    const cb = await (await post('/api/booking', { name: 'トグル 花子', line_user_id: 'Utoggle01', services: ['カット'], preferred_date: jstToday(9), preferred_time: '10:00' })).json();
    // off
    ok((await (await post('/api/admin/line-messages', { key: 'confirm', on: false })).json()).ok === true, 'line-messages POST：confirmをoffに保存');
    const beforeOff = lineCalls.length;
    const cOff = await (await post(`/api/bookings/${cb.id}/confirm`, { price: '¥3,300' })).json();
    const pushedOff = lineCalls.slice(beforeOff).filter(c => c.path === '/v2/bot/message/push' && c.body.to === 'Utoggle01');
    ok(pushedOff.length === 0 && cOff.pushed === false, 'トグルoff：確定Flexが送られない（push増えない・pushed:false）');
    ok(cOff.booking.status === 'confirmed', 'トグルoff：確定自体は成立（status=confirmed）');
    const logTxt = await fs.readFile(path.join(dataDir, 'ログ', `${jstToday()}.md`), 'utf8').catch(() => '');
    ok(logTxt.includes('〔confirm〕はオフのため送信スキップ'), 'トグルoff：ログにスキップ記録');
    // on に戻すと送られる
    ok((await (await post('/api/admin/line-messages', { key: 'confirm', on: true })).json()).ok === true, 'line-messages POST：confirmをonに戻す');
    const cb2 = await (await post('/api/booking', { name: 'トグル 太郎', line_user_id: 'Utoggle02', services: ['カット'], preferred_date: jstToday(9), preferred_time: '11:00' })).json();
    const beforeOn = lineCalls.length;
    const cOn = await (await post(`/api/bookings/${cb2.id}/confirm`, {})).json();
    const pushedOn = lineCalls.slice(beforeOn).filter(c => c.path === '/v2/bot/message/push' && c.body.to === 'Utoggle02');
    ok(pushedOn.length === 1 && cOn.pushed === true, 'トグルon復帰：確定Flexが再び送られる');
  }
  // welcomeをoff → follow webhook でreplyが飛ばない（reply増えない）が followはhandled
  {
    ok((await (await post('/api/admin/line-messages', { key: 'welcome', on: false })).json()).ok === true, 'line-messages POST：welcomeをoffに保存');
    const beforeW = lineCalls.length;
    const wOff = await signedPost({ events: [{ type: 'follow', replyToken: 'rtWoff', source: { userId: 'Ufolloff' } }] });
    ok((await wOff.json()).handled[0] === 'follow', 'welcome off：follow自体はhandled');
    const replies = lineCalls.slice(beforeW).filter(c => c.path === '/v2/bot/message/reply' && c.body.replyToken === 'rtWoff');
    ok(replies.length === 0, 'welcome off：ウェルカムreplyが飛ばない');
    // 後続テストに影響しないようonへ戻す
    await post('/api/admin/line-messages', { key: 'welcome', on: true });
  }

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

    // Vercelのルートserver.mjs自動認識（デフォルトエクスポート＝ハンドラ）対応の検証
    const { default: rootEntry } = await import('../server.mjs');
    ok(typeof rootEntry === 'function', 'server.mjsのデフォルトエクスポートが関数');
    {
      const rootSrv = http.createServer(rootEntry);
      const rootPort = await listen(rootSrv);
      ok((await (await fetch(`http://127.0.0.1:${rootPort}/healthz`)).json()).ok === true, 'ルートエントリ経由でhealthz応答');
      ok((await (await fetch(`http://127.0.0.1:${rootPort}/booking`)).text()).includes('アプリエカラー'), 'ルートエントリ経由で予約フォーム配信');
      rootSrv.close();
    }
    const srv = http.createServer(vercelHandler);
    const port = await listen(srv);
    const base = `http://127.0.0.1:${port}`;
    ok((await (await fetch(base + '/healthz')).json()).ok === true, 'アダプタ経由でhealthz応答');
    ok((await (await fetch(base + '/setup')).text()).includes('LINE CONNECT'), 'アダプタ経由で設定画面');
    ok((await (await fetch(base + '/karte')).text()).includes('hair ravel'), 'アダプタ経由でカルテ画面（同梱確認）');
    ok((await (await fetch(base + '/admin')).text()).includes('予約一覧を見る'), 'アダプタ経由で管理画面');
    {
      const demo = await (await fetch(base + '/demo')).text();
      ok(demo.includes('const DEMO_MODE = true') || demo.includes('DEMO_MODE = true'), '公開デモ：DEMO_MODEがtrueで配信される');
      const karte = await (await fetch(base + '/karte')).text();
      ok(/DEMO_MODE\s*=\s*\/\*__DEMO__\*\/false/.test(karte), '通常/karteはDEMO_MODE=false（プレースホルダ未置換）');
      ok((await fetch(base + '/demo')).status === 200, '公開デモ：認証不要で200');
    }
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

// ================================================================ Driveエクスポート（引き継ぎ仕様）
section('Driveエクスポート＆スマホビュー（引き継ぎ仕様 reference 一致）');
{
  // reference を再現する fixture
  const customers = [
    { id: 'x1', name: '山田花子', kana: 'ヤマダハナコ', phone: '090-1234-5678', line_user_id: 'U1a2b3c4d5e6f7g8h9', note: '会話控えめ希望／前回クレーム対応済み・丁寧に', allergy: 'ジアミン', first_visit: '2025-06-01', created_at: '2025-06-01' },
    { id: 'x2', name: '佐藤美希', kana: 'サトウミキ', phone: '080-2222-3333', line_user_id: 'Uaa11bb22cc33dd44ee', note: '明るめ好み。指名は鈴木。子ども連れ来店多い', allergy: '', first_visit: '2025-09-14', created_at: '2025-09-14' },
    { id: 'x3', name: '高橋優', kana: 'タカハシユウ', phone: '070-4444-5555', line_user_id: 'Uzz99yy88xx77ww66vv', note: 'メンズ。短時間希望。物販興味あり', allergy: '', first_visit: '2026-01-20', created_at: '2026-01-20' },
  ];
  const cartes = [
    { id: 'H0042', customer_id: 'x1', date: '2026-03-01', staff: '鈴木', services: ['カット', 'カラー'], recipes: { color: { family: '8トーン アッシュ／白髪30%／根元のみ', detail: '○○社 ABC-7 1:1 オキシ3% 放置35分', memo: '' } }, memo: '色持ち良好。次回は7トーンで落ち着かせる提案', price: 8800, photos: [{ name: 'H0042_20260301_before_1.jpg', type: 'before', seq: 1 }, { name: 'H0042_20260301_after_1.jpg', type: 'after', seq: 1 }] },
    { id: 'H0051', customer_id: 'x1', date: '2026-04-20', staff: '鈴木', services: ['カラーリタッチ'], recipes: { color: { family: '7トーン アッシュ／新生部のみ', detail: '○○社 ABC-6 1:1 オキシ3% 放置30分', memo: '' } }, memo: '提案通り7トーン。本人満足', price: 6600, photos: [{ name: 'H0051_20260420_after_1.jpg', type: 'after', seq: 1 }] },
    { id: 'H0048', customer_id: 'x2', date: '2026-03-30', staff: '鈴木', services: ['カット', 'ハイライト'], recipes: { color: { family: 'ハイライト＋10トーンベージュ／白髪なし', detail: '△△社 ブリーチ 放置20分＋XY-10 1:2 放置25分', memo: '' } }, memo: 'ハイライト3回目。次回はローライト追加検討', price: 13200, photos: [{ name: 'H0048_20260330_before_1.jpg', type: 'before', seq: 1 }, { name: 'H0048_20260330_after_1.jpg', type: 'after', seq: 1 }, { name: 'H0048_20260330_after_2.jpg', type: 'after', seq: 2 }] },
    { id: 'H0055', customer_id: 'x3', date: '2026-05-11', staff: '田中', services: ['カット'], recipes: {}, memo: 'サイド短め。次回1ヶ月後目安', price: 4400, photos: [{ name: 'H0055_20260511_after_1.jpg', type: 'after', seq: 1 }] },
  ];
  const model = buildExportModel({ customers, cartes, salonName: 'サンプル美容室', ownerName: '', now: '2026-06-14T10:00:00+09:00' });

  // BOM
  const custOut = customerCsv(model);
  ok(Buffer.from(custOut, 'utf8').slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), 'CSVはUTF-8 BOM付き');

  // reference 完全一致（パスがある時のみ実行）
  const REF = '/Users/sasayamayu/Downloads/引き継ぎパッケージ/reference';
  if (existsSync(REF)) {
    ok(Buffer.from(custOut, 'utf8').equals(readFileSync(`${REF}/顧客マスター.csv`)), 'reference一致：顧客マスター.csv（バイト一致）');
    ok(Buffer.from(historyCsv(model), 'utf8').equals(readFileSync(`${REF}/施術履歴.csv`)), 'reference一致：施術履歴.csv（バイト一致）');
    const gotJson = JSON.stringify(JSON.parse(dataJson(model)));
    const refJson = JSON.stringify(JSON.parse(readFileSync(`${REF}/data.json`, 'utf8')));
    ok(gotJson === refJson, 'reference一致：data.json（構造一致・金額int・ID文字列ゼロ保持）');
    ok(readmeText('サンプル美容室') === readFileSync(`${REF}/README.txt`, 'utf8'), 'reference一致：README.txt');
  } else {
    console.log('  （reference不在のためバイト一致テストはスキップ）');
  }

  // data.json の型検証（reference不在でも実行）
  const doc = JSON.parse(dataJson(model));
  ok(doc.形式バージョン === '1.0' && doc.サロン名 === 'サンプル美容室', 'data.json：トップ項目');
  ok(doc.顧客[0].顧客ID === '0001' && typeof doc.顧客[0].顧客ID === 'string', 'data.json：顧客IDは文字列でゼロ埋め');
  ok(doc.顧客[0].施術履歴[0].金額 === 8800 && typeof doc.顧客[0].施術履歴[0].金額 === 'number', 'data.json：金額は整数');
  ok(doc.顧客[0].施術履歴[0].メモ === '色持ち良好。次回は7トーンで落ち着かせる提案', 'data.json：履歴のメモキー');

  // スマホビュー（§6 本番方式）
  const html = buildMobileViewHtml(model);
  ok(!html.includes('data:image'), 'スマホビュー：base64画像を埋め込まない（§6）');
  ok(html.includes('thumbs/0001_ヤマダハナコ/H0042_20260301_before_1.jpg'), 'スマホビュー：thumbsへ相対参照');
  ok(html.includes('写真/0001_ヤマダハナコ/H0042_20260301_before_1.jpg'), 'スマホビュー：拡大は原本を相対参照');
  ok(html.includes('allergy-banner') && html.includes('アレルギー注意：') && html.includes('ジアミン'), 'スマホビュー：アレルギー赤バナー最優先');
  ok(html.includes('prefers-reduced-motion') && html.includes('お名前・ふりがなで探す'), 'スマホビュー：検索とreduced-motion');
  ok(Buffer.byteLength(html, 'utf8') < 60000, 'スマホビュー：base64埋め込み版(153KB)より大幅に軽い');

  // E2E：写真取り込み → 写真/ thumbs/ 保存・命名、エクスポート生成
  const dataDir = path.join(TMP, 'export-e2e');
  const store = createMarkdownStore(createFsBackend({ dataDir }));
  await store.upsertCustomer({ id: 'x1', name: '山田花子', kana: 'ヤマダハナコ', phone: '090-1234-5678', allergy: 'ジアミン', first_visit: '2025-06-01', created_at: '2025-06-01' });
  await store.upsertCarte({ id: 'H0042', customer_id: 'x1', date: '2026-03-01', staff: '鈴木', services: ['カット', 'カラー'], recipes: { color: { family: '8トーン', detail: 'ABC-7', memo: '' } }, memo: 'OK', price: 8800 });
  const png1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await store.saveCartePhoto({ folder: '0001_ヤマダハナコ', name: 'H0042_20260301_before_1.jpg', originalB64: `data:image/png;base64,${png1}`, thumbB64: `data:image/png;base64,${png1}` });
  ok(existsSync(path.join(dataDir, '写真', '0001_ヤマダハナコ', 'H0042_20260301_before_1.jpg')), '写真取り込み：原本を 写真/[ID]_[ふりがな]/ に保存');
  ok(existsSync(path.join(dataDir, 'thumbs', '0001_ヤマダハナコ', 'H0042_20260301_before_1.jpg')), '写真取り込み：サムネを thumbs/ に保存（§6二重持ち）');
  const origBytes = await fs.readFile(path.join(dataDir, '写真', '0001_ヤマダハナコ', 'H0042_20260301_before_1.jpg'));
  ok(!origBytes.toString('utf8').startsWith('data:'), '写真取り込み：data:URLプレフィックスを除去して保存');
}

// ================================================================ エクスポートAPI（E2E）
section('エクスポートAPI（サーバー経由）');
{
  const dataDir = path.join(TMP, 'export-api');
  const config = await loadConfig({}, { salonName: 'API美容室', ownerName: '中村', storage: 'fs', dataDir, configDir: path.join(TMP, 'exp-cfg'), passphrase: 'x' });
  const app = http.createServer(await createApp(config));
  const port = await new Promise(r => app.listen(0, '127.0.0.1', () => r(app.address().port)));
  const base = `http://127.0.0.1:${port}`;
  const post = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });

  await post('/api/customers', { id: 'c1', name: '渡辺久美子', kana: 'ワタナベクミコ', phone: '090-7890-3456', allergy: '', created_at: '2025-10-01' });
  await post('/api/cartes', { id: 'k1', customer_id: 'c1', date: '2026-05-20', staff: '中村', services: ['カラー'], recipes: { color: { family: '6トーン', detail: 'ボーテ 6', memo: '' } }, memo: 'リタッチ', price: 6600 });
  // カルテ保存で即時エクスポートされている（SPEC §7）
  ok(existsSync(path.join(dataDir, '顧客マスター.csv')), 'カルテ保存で 顧客マスター.csv が即時生成される');
  ok(existsSync(path.join(dataDir, 'data.json')) && existsSync(path.join(dataDir, 'カルテ_スマホ表示.html')), 'data.json と スマホ表示HTML が生成される');

  // 写真取り込みAPI
  const png1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const rp = await (await post('/api/cartes/k1/photos', { photos: [{ type: 'after', seq: 1, original: `data:image/png;base64,${png1}`, thumb: `data:image/png;base64,${png1}` }] })).json();
  ok(rp.ok && rp.photos[0].name === 'k1_20260520_after_1.jpg', '写真API：[履歴ID]_[YYYYMMDD]_[type]_[連番].jpg 命名');
  const hist = readFileSync(path.join(dataDir, '施術履歴.csv'), 'utf8');
  ok(hist.includes('k1_20260520_after_1.jpg') && hist.includes('写真/0001_ワタナベクミコ/'), '写真API：施術履歴.csv に写真と原本フォルダが反映');

  // 認可ゲート（ADMIN_TOKEN設定アプリ）
  const gcfg = await loadConfig({}, { salonName: 's', storage: 'fs', dataDir: path.join(TMP, 'exp-gate'), adminToken: 'tk', configDir: path.join(TMP, 'exp-gate-cfg'), passphrase: 'x' });
  const gapp = http.createServer(await createApp(gcfg));
  const gport = await new Promise(r => gapp.listen(0, '127.0.0.1', () => r(gapp.address().port)));
  ok((await fetch(`http://127.0.0.1:${gport}/api/export`, { method: 'POST' })).status === 401, 'エクスポートAPI：ADMIN_TOKENなしは401');
  ok((await (await fetch(`http://127.0.0.1:${gport}/api/export`, { method: 'POST', headers: { 'X-Admin-Token': 'tk' } })).json()).ok === true, 'エクスポートAPI：正しいトークンで実行');
  app.close(); gapp.close();
}

// ================================================================ 9. フェーズ1：担当スタッフ
section('担当スタッフ（フェーズ1：データ基盤）');
{
  // ① スタッフ定義の基本構造
  ok(Array.isArray(STAFF) && STAFF.length === 2, 'STAFF：2名定義（nakamura/matsuyoshi）');
  ok(STAFF.every(s => s.key && s.name && s.color), 'STAFF：全員がkey/name/colorを持つ');
  ok(VALID_STAFF_KEYS.has('') && VALID_STAFF_KEYS.has('nakamura') && VALID_STAFF_KEYS.has('matsuyoshi'), 'VALID_STAFF_KEYS：空/nakamura/matsuyoshiを含む');
  ok(!VALID_STAFF_KEYS.has('unknown'), 'VALID_STAFF_KEYS：不正キーは含まない');

  // ② staffByKey の動作
  ok(staffByKey('nakamura').name === '中村', 'staffByKey：nakamura → 中村');
  ok(staffByKey('matsuyoshi').name === '松吉', 'staffByKey：matsuyoshi → 松吉');
  ok(staffByKey('').key === '' && staffByKey('').name === '指名なし', 'staffByKey：空キー → 指名なし');
  ok(staffByKey('bogus').name === '指名なし', 'staffByKey：不正キー → 指名なし にフォールバック');
  ok(NO_STAFF.key === '' && NO_STAFF.name === '指名なし', 'NO_STAFF：空キーと指名なし表示');

  // ③ 予約作成時に staff を保存できる
  const storeDir = path.join(TMP, 'staff-data');
  const staffStore = createMarkdownStore(createFsBackend({ dataDir: storeDir }));
  const bkWithStaff = await staffStore.createBooking({
    name: '担当テスト 花子', phone: '090-0000-1111',
    services: ['カット'], preferred_date: '2026-07-01', preferred_time: '11:00',
    staff: 'nakamura',
  });
  ok(bkWithStaff.staff === 'nakamura', '予約作成：staffフィールドを保存できる');

  const gotStaff = await staffStore.getBooking(bkWithStaff.id);
  ok(gotStaff && gotStaff.staff === 'nakamura', '予約読み戻し：staffが正しく復元される');

  // ④ staffフィールドのない旧予約は '' として扱う（後方互換）
  const bkNoStaff = await staffStore.createBooking({
    name: '旧予約 太郎', services: ['カラー'], preferred_date: '2026-06-01', preferred_time: '10:00',
  });
  // staff フィールドを持たない旧形式のMarkdownを直接書いて読み戻す
  const oldMd = `---\nid: "bk_legacy_001"\nname: "旧 花子"\nstatus: "pending"\nservices: ["カット"]\npreferred_date: "2026-05-01"\npreferred_time: "13:00"\ncreated_at: "2026-05-01T10:00:00+09:00"\n---\n\n# 予約：旧 花子\n`;
  const legacyPath = `予約/2026-05-01_旧花子_bk_legacy_001.md`;
  await staffStore.backend.writeFile(legacyPath, oldMd);
  const allBookings = await staffStore.listBookings();
  const legacy = allBookings.find(b => b.id === 'bk_legacy_001');
  ok(legacy && (legacy.staff === '' || legacy.staff === undefined || legacy.staff === null),
    '旧予約（staffなし）：listBookingsで壊れない（staff は空または未定義）');

  // ⑤ 予約更新で staff を変更できる
  await staffStore.updateBooking(bkWithStaff.id, { staff: 'matsuyoshi' });
  const updated = await staffStore.getBooking(bkWithStaff.id);
  ok(updated && updated.staff === 'matsuyoshi', '予約更新：staffを変更できる');

  // staff を '' に戻す（指名なしへの変更）
  await staffStore.updateBooking(bkWithStaff.id, { staff: '' });
  const cleared = await staffStore.getBooking(bkWithStaff.id);
  ok(cleared && cleared.staff === '', '予約更新：staffを空（指名なし）に変更できる');

  // ⑥ E2E：APIでstaffを保存・取得・更新できる
  const staffE2eDir = path.join(TMP, 'staff-e2e');
  const staffCfg = await loadConfig({}, {
    salonName: 'スタッフテスト', storage: 'fs', dataDir: staffE2eDir,
    adminToken: '', configDir: path.join(TMP, 'staff-e2e-cfg'), passphrase: 'sp',
  });
  const staffApp = http.createServer(await createApp(staffCfg));
  const staffPort = await listen(staffApp);
  const sBase = `http://127.0.0.1:${staffPort}`;
  const sPost = (pp, bd) => fetch(sBase + pp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bd) });

  // 予約作成（staff なし）
  const apiB1 = await (await sPost('/api/booking', { name: 'API テスト 花子', preferred_date: '2026-08-01', preferred_time: '14:00' })).json();
  ok(apiB1.ok && apiB1.id, 'API予約作成（staff なし）：成功');

  // /api/bookings/:id/confirm に staff を追加して更新できる
  const confR = await (await sPost(`/api/bookings/${apiB1.id}/confirm`, { staff: 'nakamura' })).json();
  ok(confR.ok && confR.booking.staff === 'nakamura', 'confirm API：staffを含めて更新できる');

  // GET /api/bookings でstaffが返ってくる
  const listR = await (await fetch(sBase + '/api/bookings')).json();
  const apiGot = listR.bookings.find(b => b.id === apiB1.id);
  ok(apiGot && apiGot.staff === 'nakamura', 'GET /api/bookings：staffが含まれる');

  // propose API でも staff を更新できる
  const apiB2 = await (await sPost('/api/booking', { name: 'API 提案 太郎', preferred_date: '2026-08-05', preferred_time: '10:00' })).json();
  const propR = await (await sPost(`/api/bookings/${apiB2.id}/propose`, { date: '2026-08-06', time: '15:00', staff: 'matsuyoshi' })).json();
  ok(propR.ok && propR.booking.staff === 'matsuyoshi', 'propose API：staffを含めて更新できる');

  // /api/bookings/:id/staff エンドポイント（担当者のみ変更）
  const apiB3 = await (await sPost('/api/booking', { name: 'API 担当変更 太郎', preferred_date: '2026-08-10', preferred_time: '11:00' })).json();
  const staffR1 = await (await sPost(`/api/bookings/${apiB3.id}/staff`, { staff: 'nakamura' })).json();
  ok(staffR1.ok && staffR1.booking.staff === 'nakamura', '担当スタッフAPI：nakamuraに割り当て成功');
  const staffR2 = await (await sPost(`/api/bookings/${apiB3.id}/staff`, { staff: '' })).json();
  ok(staffR2.ok && staffR2.booking.staff === '', '担当スタッフAPI：空（指名なし）に変更できる');
  // 不正なstaffキーは '' に正規化される
  const staffR3 = await (await sPost(`/api/bookings/${apiB3.id}/staff`, { staff: 'BOGUS_STAFF' })).json();
  ok(staffR3.ok && staffR3.booking.staff === '', '担当スタッフAPI：不正キーは空に正規化される');
  // 未存在IDは404
  ok((await sPost('/api/bookings/bk_nonexistent/staff', { staff: 'nakamura' })).status === 404, '担当スタッフAPI：未存在IDは404');

  staffApp.close();
}

// ================================================================ 10. フェーズ2：予約フォームからのスタッフ選択
section('フェーズ2：予約フォームからのスタッフ選択（POST /api/booking への staff 反映）');
{
  const f2Dir = path.join(TMP, 'phase2-data');
  const f2Cfg = await loadConfig({}, {
    salonName: 'フェーズ2テスト', storage: 'fs', dataDir: f2Dir,
    adminToken: '', configDir: path.join(TMP, 'phase2-cfg'), passphrase: 'ph2',
  });
  const f2App = http.createServer(await createApp(f2Cfg));
  const f2Port = await listen(f2App);
  const f2Base = `http://127.0.0.1:${f2Port}`;
  const f2Post = (pp, bd) => fetch(f2Base + pp, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bd),
  });

  // ① staff: 'nakamura' を渡すと予約に保存される
  const r1 = await f2Post('/api/booking', {
    name: '中村指名 花子', preferred_date: '2026-09-01', preferred_time: '11:00',
    services: ['カット'], staff: 'nakamura',
  });
  const j1 = await r1.json();
  ok(r1.status === 200 && j1.ok, 'フォームstaff：nakamura を渡して登録成功');
  const got1 = (await (await fetch(f2Base + '/api/bookings')).json()).bookings.find(b => b.id === j1.id);
  ok(got1 && got1.staff === 'nakamura', 'フォームstaff：nakamura が予約データに保存される');

  // ② staff: 'matsuyoshi' を渡すと予約に保存される
  const r2 = await f2Post('/api/booking', {
    name: '松吉指名 太郎', preferred_date: '2026-09-02', preferred_time: '13:00',
    services: ['カラー'], staff: 'matsuyoshi',
  });
  const j2 = await r2.json();
  ok(r2.status === 200 && j2.ok, 'フォームstaff：matsuyoshi を渡して登録成功');
  const got2 = (await (await fetch(f2Base + '/api/bookings')).json()).bookings.find(b => b.id === j2.id);
  ok(got2 && got2.staff === 'matsuyoshi', 'フォームstaff：matsuyoshi が予約データに保存される');

  // ③ staff を省略（おまかせ相当）すると '' が保存される
  const r3 = await f2Post('/api/booking', {
    name: 'おまかせ 次郎', preferred_date: '2026-09-03', preferred_time: '15:00',
    services: ['トリートメント'],
  });
  const j3 = await r3.json();
  ok(r3.status === 200 && j3.ok, 'フォームstaff省略：登録成功');
  const got3 = (await (await fetch(f2Base + '/api/bookings')).json()).bookings.find(b => b.id === j3.id);
  ok(got3 && (got3.staff === '' || got3.staff === undefined || got3.staff === null),
    'フォームstaff省略：staff が空（指名なし）として保存される');

  // ④ staff: '' を明示（おまかせを明示選択）→ '' が保存される
  const r4 = await f2Post('/api/booking', {
    name: 'おまかせ明示 三郎', preferred_date: '2026-09-04', preferred_time: '10:00',
    services: ['カット'], staff: '',
  });
  const j4 = await r4.json();
  ok(r4.status === 200 && j4.ok, 'フォームstaff空文字：登録成功');
  const got4 = (await (await fetch(f2Base + '/api/bookings')).json()).bookings.find(b => b.id === j4.id);
  ok(got4 && got4.staff === '', 'フォームstaff空文字：空文字が保存される（指名なし）');

  // ⑤ 不正な staff キーは '' に正規化される
  const r5 = await f2Post('/api/booking', {
    name: '不正スタッフ 四郎', preferred_date: '2026-09-05', preferred_time: '11:00',
    services: ['カット'], staff: 'BOGUS_STAFF_KEY',
  });
  const j5 = await r5.json();
  ok(r5.status === 200 && j5.ok, 'フォームstaff不正キー：登録は成功する（サーバーが正規化）');
  const got5 = (await (await fetch(f2Base + '/api/bookings')).json()).bookings.find(b => b.id === j5.id);
  ok(got5 && got5.staff === '', 'フォームstaff不正キー：空文字に正規化して保存される');

  // ⑥ 予約フォームHTML（/booking）に staff 選択UI が含まれる
  const bkHtml = await (await fetch(f2Base + '/booking')).text();
  ok(bkHtml.includes('nakamura') && bkHtml.includes('matsuyoshi'), '予約フォームHTML：nakamura/matsuyoshiのキーが含まれる');
  ok(bkHtml.includes('中村') && bkHtml.includes('松吉') && bkHtml.includes('おまかせ'), '予約フォームHTML：中村/松吉/おまかせの表示名が含まれる');
  ok(bkHtml.includes('state.staff'), '予約フォームHTML：state.staff を使ったJS処理が含まれる');

  f2App.close();
}

// ================================================================ 11. フェーズ3：スタッフへの直接通知
section('フェーズ3A：staffUserIds の設定と loadConfig');
{
  // ① LINE_NAKAMURA_USER_ID / LINE_MATSUYOSHI_USER_ID が config.staffUserIds に入る
  const cfg = await loadConfig({
    LINE_CHANNEL_ACCESS_TOKEN: 'tok_test',
    LINE_OWNER_USER_ID: 'Uowner001',
    LINE_NAKAMURA_USER_ID: 'Unakamura001',
    LINE_MATSUYOSHI_USER_ID: 'Umatsuyoshi001',
  }, { configDir: path.join(TMP, 'ph3-cfg'), passphrase: 'p3' });
  ok(cfg.staffUserIds && cfg.staffUserIds.nakamura === 'Unakamura001', 'loadConfig: staffUserIds.nakamura が正しく設定される');
  ok(cfg.staffUserIds && cfg.staffUserIds.matsuyoshi === 'Umatsuyoshi001', 'loadConfig: staffUserIds.matsuyoshi が正しく設定される');
  ok(cfg.ownerUserId === 'Uowner001', 'loadConfig: ownerUserId（既存）は変更されない');

  // ② LINE_MATSUYOSHI_USER_ID 未設定でも staffUserIds.matsuyoshi === '' になる（エラーにならない）
  const cfg2 = await loadConfig({
    LINE_OWNER_USER_ID: 'Uowner001',
    LINE_NAKAMURA_USER_ID: 'Unakamura001',
  }, { configDir: path.join(TMP, 'ph3-cfg2'), passphrase: 'p3b' });
  ok(cfg2.staffUserIds && cfg2.staffUserIds.nakamura === 'Unakamura001', 'loadConfig: 松吉ID未設定でも nakamura は取得できる');
  ok(cfg2.staffUserIds && (cfg2.staffUserIds.matsuyoshi === '' || cfg2.staffUserIds.matsuyoshi === undefined), 'loadConfig: 松吉ID未設定でも staffUserIds.matsuyoshi は空（エラーなし）');

  // ③ 両方未設定でも staffUserIds が存在する（エラーにならない）
  const cfg3 = await loadConfig({
    LINE_OWNER_USER_ID: 'Uowner001',
  }, { configDir: path.join(TMP, 'ph3-cfg3'), passphrase: 'p3c' });
  ok(cfg3.staffUserIds && typeof cfg3.staffUserIds === 'object', 'loadConfig: 両方未設定でも staffUserIds オブジェクトが存在する');
}

section('フェーズ3B：ownerBookingText に指名行が含まれる');
{
  // ① nakamura 指名の場合
  const textNakamura = ownerBookingText(
    { name: '田中 花子', services: ['カット'], preferred_date: '2026-07-01', preferred_time: '14:00', staff: 'nakamura' },
    'https://example.com/admin'
  );
  ok(textNakamura.includes('中村'), 'ownerBookingText：nakamura → 中村 が含まれる');
  ok(textNakamura.includes('ご指名'), 'ownerBookingText：「ご指名」の行が含まれる');

  // ② matsuyoshi 指名の場合
  const textMatsuyoshi = ownerBookingText(
    { name: '鈴木 太郎', services: ['カラー'], preferred_date: '2026-07-02', preferred_time: '11:00', staff: 'matsuyoshi' },
    'https://example.com/admin'
  );
  ok(textMatsuyoshi.includes('松吉'), 'ownerBookingText：matsuyoshi → 松吉 が含まれる');

  // ③ 指名なし（staff: ''）の場合
  const textNoStaff = ownerBookingText(
    { name: '山田 次郎', services: ['カット'], preferred_date: '2026-07-03', preferred_time: '10:00', staff: '' },
    'https://example.com/admin'
  );
  ok(textNoStaff.includes('指名なし'), 'ownerBookingText：staff空 → 指名なし が含まれる');

  // ④ staff フィールド自体がない場合（後方互換）
  const textLegacy = ownerBookingText(
    { name: '古い 予約', services: ['カット'], preferred_date: '2026-07-04', preferred_time: '09:00' },
    'https://example.com/admin'
  );
  // staff なし旧データはエラーにならない（指名なし or 省略どちらでもOK）
  ok(typeof textLegacy === 'string' && textLegacy.length > 0, 'ownerBookingText：staff フィールドなし旧データでエラーにならない');
}

section('フェーズ3C：ownerTodayListText に担当者名が含まれる');
{
  const bookings = [
    { confirmed_time: '11:00', name: '田中 花子', services: ['カット'], status: 'confirmed', line_user_id: 'U1', staff: 'nakamura', _customer: null, _lastCarte: null },
    { confirmed_time: '13:00', name: '鈴木 太郎', services: ['カラー'], status: 'confirmed', line_user_id: '', staff: 'matsuyoshi', _customer: null, _lastCarte: null },
    { confirmed_time: '15:00', name: '山田 次郎', services: ['トリートメント'], status: 'confirmed', line_user_id: '', staff: '', _customer: null, _lastCarte: null },
  ];
  const text = ownerTodayListText({ dateLabel: '7/1', bookings });
  ok(text.includes('【中村】'), 'ownerTodayListText：nakamura → 【中村】が含まれる');
  ok(text.includes('【松吉】'), 'ownerTodayListText：matsuyoshi → 【松吉】が含まれる');
  // 指名なしは「【指名なし】」か表示なしかどちらでもよいが、エラーにならない
  ok(typeof text === 'string' && text.includes('山田 次郎'), 'ownerTodayListText：指名なしでエラーにならない（山田 次郎が含まれる）');
}

section('フェーズ3D：notifyStaff と notify-today のE2Eテスト');
{
  // E2E共通セットアップ（LINE API はモック）
  const pushLog = [];
  const mockFetch = async (url, opts) => {
    if (url.includes('/v2/bot/message/push')) {
      const b = JSON.parse(opts.body);
      pushLog.push({ to: b.to, text: b.messages?.[0]?.text });
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes('/v2/bot/message/quota')) return { ok: true, json: async () => ({ type: 'none' }) };
    if (url.includes('/v2/bot/message/quota/consumption')) return { ok: true, json: async () => ({ totalUsage: 5 }) };
    return { ok: true, json: async () => ({}) };
  };

  const p3Dir = path.join(TMP, 'ph3-e2e');
  const p3Cfg = await loadConfig({
    LINE_CHANNEL_ACCESS_TOKEN: 'tok_test',
    LINE_OWNER_USER_ID: 'Uowner001',
    LINE_NAKAMURA_USER_ID: 'Unakamura001',
    LINE_MATSUYOSHI_USER_ID: 'Umatsuyoshi001',
  }, {
    salonName: 'フェーズ3テスト', storage: 'fs', dataDir: p3Dir,
    adminToken: '', configDir: path.join(TMP, 'ph3-e2e-cfg'), passphrase: 'ph3',
    fetchImpl: mockFetch,
  });
  const p3App = http.createServer(await createApp(p3Cfg));
  const p3Port = await listen(p3App);
  const p3Base = `http://127.0.0.1:${p3Port}`;
  const p3Post = (pp, bd) => fetch(p3Base + pp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bd) });

  // ① nakamura 指名 → nakamura の ID へ送信される
  pushLog.length = 0;
  const nakBooking = await p3Post('/api/booking', {
    name: '中村指名 花子', preferred_date: '2026-09-01', preferred_time: '11:00',
    services: ['カット'], staff: 'nakamura',
  });
  const nakJ = await nakBooking.json();
  ok(nakJ.ok, 'notifyStaff：nakamura指名で予約作成成功');
  ok(pushLog.some(l => l.to === 'Unakamura001'), 'notifyStaff：nakamura指名 → Unakamura001 へ送信');

  // ② matsuyoshi 指名 → matsuyoshi の ID へ送信される
  pushLog.length = 0;
  const matBooking = await p3Post('/api/booking', {
    name: '松吉指名 太郎', preferred_date: '2026-09-02', preferred_time: '13:00',
    services: ['カラー'], staff: 'matsuyoshi',
  });
  const matJ = await matBooking.json();
  ok(matJ.ok, 'notifyStaff：matsuyoshi指名で予約作成成功');
  ok(pushLog.some(l => l.to === 'Umatsuyoshi001'), 'notifyStaff：matsuyoshi指名 → Umatsuyoshi001 へ送信');

  // ③ 指名なし（staff: ''）→ ownerUserId（Uowner001）へフォールバック
  pushLog.length = 0;
  const noStaffBooking = await p3Post('/api/booking', {
    name: '指名なし 次郎', preferred_date: '2026-09-03', preferred_time: '15:00',
    services: ['トリートメント'], staff: '',
  });
  const noStaffJ = await noStaffBooking.json();
  ok(noStaffJ.ok, 'notifyStaff：指名なしで予約作成成功');
  ok(pushLog.some(l => l.to === 'Uowner001'), 'notifyStaff：指名なし → ownerUserId（Uowner001）へフォールバック');

  // ④ notify-today：中村・松吉の両IDへ送信される（重複なし）
  // まず今日の予約を作成してconfirmする
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayBk = await p3Post('/api/booking', {
    name: '本日 一覧テスト', preferred_date: today, preferred_time: '10:00',
    services: ['カット'], staff: 'nakamura',
  });
  const todayBkJ = await todayBk.json();
  await p3Post(`/api/bookings/${todayBkJ.id}/confirm`, { confirmed_date: today, confirmed_time: '10:00' });
  pushLog.length = 0;
  const notifyTodayR = await p3Post('/api/admin/notify-today', {});
  const notifyTodayJ = await notifyTodayR.json();
  ok(notifyTodayJ.ok, 'notify-today：両スタッフID設定時にok:true');
  const sentIds = pushLog.map(l => l.to);
  ok(sentIds.includes('Unakamura001'), 'notify-today：Unakamura001 へ送信される');
  ok(sentIds.includes('Umatsuyoshi001'), 'notify-today：Umatsuyoshi001 へ送信される');
  ok(new Set(sentIds).size === sentIds.length, 'notify-today：重複送信なし（ユニーク化）');
  // ownerUserIdと中村が同じ場合は重複しない（ここでは別IDなので送信件数は2件）
  ok(sentIds.length === 2, 'notify-today：送信先は2件（中村+松吉）');

  p3App.close();

  // ⑤ 松吉ID未設定の場合：notify-today は中村 + ownerUserId のみ（重複なし）
  const pushLog5 = [];
  const mockFetch5 = async (url, opts) => {
    if (url.includes('/v2/bot/message/push')) {
      const b = JSON.parse(opts.body);
      pushLog5.push({ to: b.to });
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes('/v2/bot/message/quota')) return { ok: true, json: async () => ({ type: 'none' }) };
    if (url.includes('/v2/bot/message/quota/consumption')) return { ok: true, json: async () => ({ totalUsage: 5 }) };
    return { ok: true, json: async () => ({}) };
  };
  const p3bDir = path.join(TMP, 'ph3-b');
  const p3bCfg = await loadConfig({
    LINE_CHANNEL_ACCESS_TOKEN: 'tok_test2',
    LINE_OWNER_USER_ID: 'Uowner002',
    LINE_NAKAMURA_USER_ID: 'Unakamura002',
    // matsuyoshi は未設定
  }, {
    salonName: '松吉未設定テスト', storage: 'fs', dataDir: p3bDir,
    adminToken: '', configDir: path.join(TMP, 'ph3-b-cfg'), passphrase: 'ph3b',
    fetchImpl: mockFetch5,
  });
  const p3bApp = http.createServer(await createApp(p3bCfg));
  const p3bPort = await listen(p3bApp);
  const p3bBase = `http://127.0.0.1:${p3bPort}`;
  const p3bPost = (pp, bd) => fetch(p3bBase + pp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bd) });

  // 今日の予約を作成
  const todayB = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const bkB = await (await p3bPost('/api/booking', { name: '松吉未設定 テスト', preferred_date: todayB, preferred_time: '09:00', services: ['カット'] })).json();
  await p3bPost(`/api/bookings/${bkB.id}/confirm`, { confirmed_date: todayB, confirmed_time: '09:00' });
  pushLog5.length = 0;
  const todayRb = await p3bPost('/api/admin/notify-today', {});
  const todayJb = await todayRb.json();
  ok(todayJb.ok, '松吉ID未設定: notify-today は ok:true（エラーにならない）');
  const sentIds5 = pushLog5.map(l => l.to);
  // nakamura IDが設定済みなので Unakamura002 へは送る。matsuyoshi未設定なので Uowner002 は松吉の代わりには送らない
  // （ownerIdとnakamuraIdが別の場合、未設定の松吉分はスキップ）
  ok(sentIds5.includes('Unakamura002'), '松吉ID未設定: nakamura(Unakamura002) へは送信される');
  ok(!sentIds5.includes(undefined) && !sentIds5.includes(''), '松吉ID未設定: 空/undefined への送信はない');
  ok(new Set(sentIds5).size === sentIds5.length, '松吉ID未設定: 重複送信なし');

  p3bApp.close();
}

// ================================================================ 結果
console.log('\n' + '═'.repeat(46));
console.log(`結果: ${pass} 成功 / ${fail} 失敗`);
if (failures.length) { console.log('失敗項目:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
