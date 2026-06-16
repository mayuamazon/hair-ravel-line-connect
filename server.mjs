// hair-ravel LINE Connect — サロンオーナー所有のLINE連携サーバー（依存ゼロ・Node 18+）
// 分散型設計：このサーバーは各オーナーの環境（自身のVercel/Mac/VPS）で動き、
// トークン・顧客データが開発者のサーバーを経由することは構造上ありえない。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackend } from './lib/store-backends.mjs';
import { createMarkdownStore, jstToday } from './lib/markdown-store.mjs';
import { createSecretStore } from './lib/secret-store.mjs';
import { VALID_STAFF_KEYS } from './lib/staff.mjs';
import { verifySignature, handleEvents } from './lib/webhook-handler.mjs';
import { isSorosoroDay } from './lib/visit-timing.mjs';
import {
  createLineClient, buildConfirmFlex, buildReminderFlex, buildThankYouFlex, buildProposalFlex,
  sorosoroText, ownerBookingText, ownerHearingText, vacancyText, ownerTodayListText,
  ownerAcceptedText, welcomeText, subscribeOnText,
} from './lib/line-client.mjs';
import { buildExportBundle, buildExportModel, assignCustomerNumbers } from './lib/drive-export.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 設定
export async function loadConfig(env = process.env, overrides = {}) {
  const secretStore = createSecretStore({ configDir: overrides.configDir, passphrase: overrides.passphrase });
  const loaded = await secretStore.load(env);
  const config = {
    salonName: 'Hair ravel',
    ownerName: '中村',
    storage: 'fs',
    dataDir: path.join(MODULE_DIR, 'data'),
    lineApiBase: env.LINE_API_BASE || 'https://api.line.me',
    githubApiBase: env.GITHUB_API_BASE || undefined,
    port: Number(env.HR_PORT || 8787),
    host: env.HR_HOST || '127.0.0.1',
    ...loaded,
    ...overrides,
  };
  // スタッフ個人のLINE User ID を staffUserIds にまとめる
  config.staffUserIds = {
    nakamura: config.nakamuraUserId || '',
    matsuyoshi: config.matsuyoshiUserId || '',
  };
  config._secretStore = secretStore;
  return config;
}

// ---------------------------------------------------------------- 補助
// staff フィールドの正規化（nakamura/matsuyoshi/'' のみ許可、それ以外は '' に正規化）
const normalizeStaff = v => {
  const s = String(v ?? '');
  return VALID_STAFF_KEYS.has(s) ? s : '';
};

const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const bearerOf = req => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
// 管理系の認可：ADMIN_TOKEN設定時はトークン必須／未設定時はlocalhostのみ許可
const adminOk = (req, config) => {
  const t = bearerOf(req) || req.headers['x-admin-token'] || '';
  if (config.adminToken) return !!t && safeEq(t, config.adminToken);
  return isLocal(req);
};
const cronOk = (req, config) => !!config.cronSecret && safeEq(bearerOf(req), config.cronSecret);

// booking → 顧客 のマッチング（line_user_id一致 → 電話番号(数字のみ) → 名前(空白除去)の順）
const onlyDigits = s => String(s || '').replace(/\D/g, '');
const normName = s => String(s || '').replace(/[\s　]/g, '');
function matchCustomerFor(booking, customers) {
  return customers.find(c => booking.line_user_id && c.line_user_id === booking.line_user_id)
    || customers.find(c => booking.phone && onlyDigits(c.phone) && onlyDigits(c.phone) === onlyDigits(booking.phone))
    || customers.find(c => normName(c.name) && normName(c.name) === normName(booking.name))
    || null;
}

function readBody(req, limit = 6 * 1024 * 1024) {
  // Vercel等のランタイムが先にボディを読み終えている場合はそれを使う
  if (req.rawBody !== undefined) {
    return Promise.resolve(Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody));
  }
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
    return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const html = (res, status, body) => {
  // 画面HTMLは常に最新を取得させる（古い版がキャッシュされてボタンが効かない事故を防ぐ）
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, must-revalidate',
  });
  res.end(body);
};
const baseUrlOf = (req, config) =>
  config.baseUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`;

// 'YYYY-MM-DD' → 'YYYYMMDD'（insight APIのdate引数形式）
const ymdCompact = ymd => String(ymd || '').replace(/-/g, '');
// 当月（JST）の 'YYYY-MM' を返す
const jstMonth = () => jstToday().slice(0, 7);
// 前月末日（=今月1日の前日）を 'YYYY-MM-DD' で返す
function prevMonthLastDay() {
  const t = jstToday();              // YYYY-MM-DD（JST基準）
  const firstOfMonth = t.slice(0, 8) + '01';
  return jstAddDays(firstOfMonth, -1);
}
// 'YYYY-MM-DD' に日数を足した 'YYYY-MM-DD'（UTC基準の純粋な日付計算）
function jstAddDays(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- メッセージ・プレビュー
// Flexメッセージ（line-client.mjsの bubble() 構造）を管理画面用の「見た目」データに変換する。
// altTextやJSONは出さず、ヘッダ色帯・本文行（text/label:value）・フッターボタンの配列だけを返す。
function flexToPreview(flexMsg) {
  const bubble = flexMsg?.contents || {};
  const headerBox = bubble.header;
  const headerTextNode = headerBox?.contents?.find(c => c.type === 'text');
  const lines = [];
  for (const c of (bubble.body?.contents || [])) {
    if (c.type === 'text') {
      lines.push({ text: c.text });
    } else if (c.type === 'box') {
      // baselineの行は label/value、それ以外（ネストbox）は内部のtextを拾って value 行にする
      const texts = (c.contents || []).filter(x => x.type === 'text');
      if (c.layout === 'baseline' && texts.length >= 2) {
        lines.push({ label: texts[0].text, value: texts[1].text });
      } else if (texts.length) {
        for (const t of texts) lines.push({ text: t.text });
      }
    }
  }
  const buttons = (bubble.footer?.contents || [])
    .filter(c => c.type === 'button')
    .map(c => c.action?.label || '')
    .filter(Boolean);
  return {
    kind: 'flex',
    headerText: headerTextNode ? headerTextNode.text : '',
    headerColor: headerBox ? (headerBox.backgroundColor || '') : '',
    lines,
    buttons,
  };
}
// テキスト系メッセージのプレビュー（改行はそのまま保持してUI側で再現する）
function textToPreview(text) {
  return { kind: 'text', text: String(text ?? '') };
}

// LINE自動配信カタログ（全14種）。各 build(sample) は実ビルダーを呼びプレビュー用に変換した結果を返す。
// config と baseUrl に依存するためファクトリ関数で都度生成する。
function buildLineMessages(config, baseUrl) {
  const salonName = config.salonName || 'Hair ravel';
  const ownerName = config.ownerName || '中村';
  const adminUrl = config.adminUrl || (baseUrl + '/admin');
  // 共通サンプルデータ（仕様の固定値）
  const sample = {
    salonName, ownerName,
    name: '田中 花子', line_display_name: '花子', phone: '090-1234-5678',
    services: ['カット', 'カラー'],
    preferred_date: '2026-07-01', confirmed_date: '2026-07-01', time: '14:00',
    price: '¥9,900',
    hearing_concerns: ['くせ毛・うねり', 'ダメージ'], hearing_style: 'ふんわりボブ',
    proposed_date: '2026-07-03', proposed_time: '11:00',
  };
  // ビルダーに渡す予約風サンプル（テキスト系ビルダーが参照するキーをまとめて用意）
  const sampleBooking = {
    name: sample.name, line_display_name: sample.line_display_name, phone: sample.phone,
    services: sample.services,
    preferred_date: sample.preferred_date, preferred_time: sample.time,
    confirmed_date: sample.confirmed_date, confirmed_time: sample.time,
    hearing_concerns: sample.hearing_concerns, hearing_style: sample.hearing_style,
    hearing_photo: '', notes: '',
  };
  // 月次レポートのサンプル（buildMonthlyReportは外部依存があるためここはサンプル固定値）
  const monthlyReportSampleText = [
    `📊 ${jstMonth()} ${salonName} 月次レポート`,
    '👥友だち 128人（前月比 +12）',
    '📨今月の配信 84/200通',
    '🆕新規予約 9 ・✅確定 7 ・💈来店 6',
  ].join('\n');

  return [
    { key: 'owner_new_booking', label: '新規予約の通知', timing: '予約が入った時', audience: 'オーナー', free: false,
      build: () => textToPreview(ownerBookingText(sampleBooking, adminUrl)) },
    { key: 'confirm', label: '予約確定カード', timing: '確定した時', audience: 'お客様', free: false,
      build: () => flexToPreview(buildConfirmFlex({ salonName, date: sample.confirmed_date, time: sample.time, services: sample.services, price: sample.price })) },
    { key: 'reminder', label: '前日リマインド＋ヒアリング', timing: '毎朝3時', audience: 'お客様', free: false,
      build: () => flexToPreview(buildReminderFlex({ salonName, date: sample.confirmed_date, time: sample.time, services: sample.services, hearingUrl: baseUrl + '/hearing/sample' })) },
    { key: 'owner_hearing', label: 'ヒアリング受信の通知', timing: 'ヒアリング送信時', audience: 'オーナー', free: false,
      build: () => textToPreview(ownerHearingText(sampleBooking, adminUrl)) },
    { key: 'thankyou', label: 'サンクス＋ホームケア', timing: '毎朝1時', audience: 'お客様', free: false,
      build: () => flexToPreview(buildThankYouFlex({ salonName, name: sample.name, visitDate: sample.confirmed_date, services: sample.services, careUrl: config.careUrl, reviewUrl: config.reviewUrl })) },
    { key: 'sorosoro', label: 'そろそろ再来店のご案内', timing: '次回目安-14日', audience: 'お客様', free: false,
      build: () => textToPreview(sorosoroText({ name: sample.name, salonName, ownerName, services: sample.services })) },
    { key: 'vacancy', label: '空き枠アラート', timing: '手動配信時', audience: '購読者', free: false,
      build: () => textToPreview(vacancyText({ salonName, date: sample.confirmed_date, slots: ['14:00〜', '16:30〜'] })) },
    { key: 'owner_today', label: '本日の一覧', timing: 'ボタンを押した時', audience: 'オーナー', free: false,
      build: () => textToPreview(ownerTodayListText({ dateLabel: '7/1', bookings: [{ ...sampleBooking, status: 'confirmed', line_user_id: 'Usample', _customer: null, _lastCarte: null }] })) },
    { key: 'proposal', label: '別日のご提案', timing: '別日提案時', audience: 'お客様', free: false,
      build: () => flexToPreview(buildProposalFlex({ salonName, name: sample.name, origDate: sample.preferred_date, origTime: sample.time, date: sample.proposed_date, time: sample.proposed_time, bookingId: 'sample' })) },
    { key: 'owner_response', label: '提案への応答通知', timing: 'お客様が応答時', audience: 'オーナー', free: false,
      build: () => textToPreview(ownerAcceptedText({ name: sample.name, confirmed_date: sample.proposed_date, confirmed_time: sample.proposed_time, services: sample.services })) },
    { key: 'monthly_report', label: '月次レポート', timing: '毎月1日', audience: 'オーナー', free: false,
      build: () => textToPreview(monthlyReportSampleText) },
    { key: 'welcome', label: '友だち追加あいさつ', timing: '友だち追加時', audience: 'お客様', free: true,
      build: () => textToPreview(welcomeText({ salonName, bookingUrl: config.bookingUrl || (baseUrl + '/booking') })) },
    { key: 'subscribe_reply', label: '空き枠通知の登録/解除返信', timing: '登録・解除時', audience: 'お客様', free: true,
      build: () => textToPreview(subscribeOnText) },
    { key: 'accept_reply', label: '予約承諾ボタンの返信', timing: 'お客様がOKを押した時', audience: 'お客様', free: true,
      build: () => flexToPreview(buildConfirmFlex({ salonName, date: sample.proposed_date, time: sample.proposed_time, services: sample.services, price: sample.price })) },
  ];
}

// オーナー通知（LINE_OWNER_USER_ID未設定/PLACEHOLDERならスキップ — 追補§7-4）
// 送信は配信上限ガード（guardedPush）を通す。ガード未設定の経路では素のpushにフォールバック。
async function notifyOwner(ctx, text) {
  const { config, line, store, guardedPush } = ctx;
  const id = config.ownerUserId || '';
  if (!id || id.includes('PLACEHOLDER')) {
    await store.appendLog('オーナー通知スキップ（LINE_OWNER_USER_ID未設定）');
    return false;
  }
  const send = guardedPush || ((to, msgs) => line.push(to, msgs));
  await send(id, [{ type: 'text', text }], 'オーナー通知');
  return true;
}

// スタッフ個人への通知（フェーズ3）
// staffKey に対応する staffUserIds[staffKey] があればそこへ送信。
// 無い／空／staffKey が ''（指名なし）／PLACEHOLDERの場合は ownerUserId へフォールバック。
// 既存の notifyOwner 定義・呼び出し箇所は一切変更しない。
async function notifyStaff(ctx, text, staffKey) {
  const { config, line, store, guardedPush } = ctx;
  const send = guardedPush || ((to, msgs) => line.push(to, msgs));

  // staffKey が有効で対応するIDが設定されているか判定
  const staffId = (staffKey && config.staffUserIds && config.staffUserIds[staffKey]) || '';
  const staffIdValid = staffId && !staffId.includes('PLACEHOLDER');

  if (staffIdValid) {
    await send(staffId, [{ type: 'text', text }], `スタッフ通知（${staffKey}）`);
    return true;
  }

  // フォールバック：ownerUserId へ
  const ownerId = config.ownerUserId || '';
  if (!ownerId || ownerId.includes('PLACEHOLDER')) {
    await store.appendLog('スタッフ通知スキップ（staffId未設定かつLINE_OWNER_USER_ID未設定）');
    return false;
  }
  await send(ownerId, [{ type: 'text', text }], 'スタッフ通知（ownerフォールバック）');
  return true;
}

// ---------------------------------------------------------------- アプリ本体
export async function createApp(config) {
  const backend = createBackend({ ...config, fetchImpl: config.fetchImpl });
  const store = createMarkdownStore(backend);
  const line = createLineClient({
    accessToken: config.accessToken || '',
    apiBase: config.lineApiBase,
    fetchImpl: config.fetchImpl || fetch,
  });
  // ---------- 配信上限ガード（200通/月の無料枠を超えないための安全機構） ----------
  // 結果を60秒キャッシュしてcronの大量送信時にAPIを叩きすぎない。
  // 取得失敗時はfail-open（true＝送信を止めない）：監視API都合で正常配信を妨げない。
  let _quotaCache = { at: 0, allow: true };
  async function quotaAllows() {
    const now = Date.now();
    if (now - _quotaCache.at < 60 * 1000) return _quotaCache.allow;
    let allow = true;
    try {
      const quota = await line.getMessageQuota();
      const cons = await line.getQuotaConsumption();
      // type:'none' は無制限。type:'limited' のときだけ上限判定する。
      if (quota && quota.type === 'limited' && Number(cons?.totalUsage) >= Number(quota.value)) {
        allow = false;
      }
    } catch {
      allow = true; // fail-open
    }
    _quotaCache = { at: now, allow };
    return allow;
  }
  // 送信関数を薄くラップ：上限到達ならログを残して送らない（reply＝無料は対象外）。
  async function guardedPush(to, messages, label) {
    if (!(await quotaAllows())) {
      await store.appendLog(`配信上限(200通)到達のためスキップ: ${label}`);
      return { skipped: true };
    }
    return line.push(to, messages);
  }
  async function guardedMulticast(ids, messages, label) {
    if (!(await quotaAllows())) {
      await store.appendLog(`配信上限(200通)到達のためスキップ: ${label}`);
      return { skipped: true };
    }
    return line.multicast(ids, messages);
  }

  // ---------- ON/OFFトグルの適用ヘルパー ----------
  // 1リクエスト/cron内でトグルを1回だけ取得し、その結果でキーごとに送信可否を判定する。
  // toggleAllows(toggles, key)：offなら false を返しスキップログを残す（既定on=true＝現行挙動）。
  async function loadToggles() {
    try { return await store.getLineToggles(); }
    catch { return {}; } // 取得失敗時は全on扱い（送信を止めない）
  }
  async function toggleAllows(toggles, key) {
    if (toggles && toggles[key] === false) {
      await store.appendLog(`〔${key}〕はオフのため送信スキップ`);
      return false;
    }
    return true;
  }

  // ---------- ライブ統計（配信量＋友だち数）。LINE未設定/取得失敗でも例外を投げず各値nullで返す ----------
  // used=消費数, limit=quota.value（type:'none'なら無制限＝null）, remaining=limit-used。
  // followers/blocks はJST前日のinsight（当日分は未確定のため）。statusがready以外はfollowers=null。
  async function buildLineStats() {
    if (!config.accessToken) {
      return { used: null, limit: null, remaining: null, followers: null, blocks: null, followersStatus: null, asOf: jstToday(-1), error: 'LINE未設定' };
    }
    const out = { used: null, limit: null, remaining: null, followers: null, blocks: null, followersStatus: null, asOf: jstToday(-1) };
    try {
      const quota = await line.getMessageQuota();
      const cons = await line.getQuotaConsumption();
      out.used = Number(cons?.totalUsage) || 0;
      out.limit = quota && quota.type === 'none' ? null : (Number(quota?.value) || 0);
      out.remaining = out.limit != null ? out.limit - out.used : null;
    } catch (e) {
      out.error = 'LINE統計を取得できませんでした';
    }
    try {
      const ins = await line.getInsightFollowers(ymdCompact(jstToday(-1)));
      if (ins && ins.status === 'ready') {
        out.followers = Number(ins.followers) || 0;
        out.blocks = Number(ins.blocks) || 0;
        out.followersStatus = 'ready';
      } else {
        out.followers = null;
        out.blocks = ins ? (Number(ins.blocks) || null) : null;
        out.followersStatus = ins ? ins.status : null;
      }
    } catch (e) {
      out.followers = null;
      if (!out.error) out.error = 'LINE統計を取得できませんでした';
    }
    return out;
  }

  // ---------- 月次レポート（当月JSTの集計。クーポンは扱わない＝今ある数字のみ） ----------
  async function buildMonthlyReport() {
    const month = jstMonth();              // 'YYYY-MM'
    const today = jstToday();              // 'YYYY-MM-DD'
    const stats = await buildLineStats();  // friends/blocks/sent(used)/limit を流用
    // 前月比：当月のfollowers − 前月末日のfollowers（どちらか取れない/unreadyなら null）
    let friendsDelta = null;
    if (stats.followers != null && config.accessToken) {
      try {
        const prev = await line.getInsightFollowers(ymdCompact(prevMonthLastDay()));
        if (prev && prev.status === 'ready') friendsDelta = stats.followers - (Number(prev.followers) || 0);
      } catch { friendsDelta = null; }
    }
    // 予約集計（当月）：created_at が当月＝新規、status=confirmed かつ confirmed_date が当月＝確定、
    // confirmed_date が当月かつ今日以前＝来店。
    const bookings = await store.listBookings();
    const inMonth = ymd => String(ymd || '').slice(0, 7) === month;
    const newBookings = bookings.filter(b => inMonth(b.created_at)).length;
    const confirmed = bookings.filter(b => b.status === 'confirmed' && inMonth(b.confirmed_date)).length;
    const visits = bookings.filter(b => inMonth(b.confirmed_date) && String(b.confirmed_date) <= today).length;
    return {
      month,
      friends: stats.followers,
      friendsDelta,
      blocks: stats.blocks,
      sent: stats.used,
      limit: stats.limit,
      newBookings, confirmed, visits,
    };
  }
  // レポート → オーナーへ送る1通のテキスト
  function monthlyReportText(r) {
    const delta = r.friendsDelta == null ? '—' : (r.friendsDelta >= 0 ? `+${r.friendsDelta}` : `${r.friendsDelta}`);
    const friends = r.friends == null ? '—' : `${r.friends}`;
    const sent = r.sent == null ? '—' : `${r.sent}`;
    const limit = r.limit == null ? '無制限' : `${r.limit}`;
    return [
      `📊 ${r.month} ${config.salonName} 月次レポート`,
      `👥友だち ${friends}人（前月比 ${delta}）`,
      `📨今月の配信 ${sent}/${limit}通`,
      `🆕新規予約 ${r.newBookings} ・✅確定 ${r.confirmed} ・💈来店 ${r.visits}`,
    ].join('\n');
  }

  // ctx は webhook-handler 等に渡す共有コンテキスト。
  // notifyOwner は ctx 自身を参照するため、先に器を作ってから後付けする（循環参照を避ける）。
  // 送信は配信上限ガードを通すため guardedPush/guardedMulticast を ctx に載せる。
  const ctx = { config, store, line, guardedPush, guardedMulticast, quotaAllows };
  ctx.notifyOwner = text => notifyOwner(ctx, text);
  // webhook側がトグルを参照するためのヘルパー（welcome/subscribe_reply/accept_reply の返信文だけを抑制する）
  ctx.loadToggles = loadToggles;
  ctx.toggleAllows = toggleAllows;

  // テキスト類（CSV/JSON/HTML）の即時再生成。失敗してもカルテ保存自体は成立させる。
  const reexport = async () => {
    try { await buildExportBundle(store, config); }
    catch (e) { await store.appendLog('エクスポート失敗: ' + e.message).catch(() => {}); }
  };

  // publicフォルダの場所を解決（Vercel等のバンドル環境ではMODULE_DIRが移動することがあるため複数候補を試す）
  const readPublic = async name => {
    const candidates = [
      path.join(MODULE_DIR, 'public', name),
      path.join(process.cwd(), 'public', name),
      path.join(MODULE_DIR, '..', 'public', name),
    ];
    for (const c of candidates) {
      try { return await fs.readFile(c, 'utf8'); } catch {}
    }
    console.error(`public/${name} が見つかりません（探索先: ${candidates.join(' | ')}）`);
    return null;
  };
  const setupHtml = (await readPublic('setup.html')) || '<h1>setup.html が配備されていません</h1>';
  const hearingHtml = (await readPublic('hearing.html')) || '<h1>hearing.html が配備されていません</h1>';
  const bookingHtml = await readPublic('booking.html');
  const karteHtml = await readPublic('karte.html');
  const adminHtml = await readPublic('admin.html');

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://internal');
    const p = url.pathname;
    const method = req.method;

    try {
      const raw = (method === 'POST' || method === 'PUT') ? await readBody(req) : null;
      const body = () => { try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { return null; } };

      // ---------- 画面 ----------
      if (method === 'GET' && (p === '/' || p === '/setup')) return html(res, 200, setupHtml);
      if (method === 'GET' && p === '/booking' && bookingHtml) {
        const cfg = { salonName: config.salonName, liffId: config.liffId || '' };
        return html(res, 200, bookingHtml.replace('/*__CFG__*/null', JSON.stringify(cfg)));
      }
      if (method === 'GET' && p === '/karte' && karteHtml) return html(res, 200, karteHtml);
      // 公開デモ（認証不要・サーバー非接続・サンプルデータ）。提案でクライアントに見せる用。
      if (method === 'GET' && p === '/demo' && karteHtml) return html(res, 200, karteHtml.replace('/*__DEMO__*/false', 'true'));
      if (method === 'GET' && p === '/admin' && adminHtml) return html(res, 200, adminHtml);

      if (method === 'GET' && p.startsWith('/hearing/')) {
        const id = decodeURIComponent(p.split('/')[2] || '');
        const b = await store.getBooking(id);
        const pub = b ? {
          id: b.id, name: b.name,
          date: b.confirmed_date || b.preferred_date, time: b.confirmed_time || b.preferred_time,
          services: b.services || [], salonName: config.salonName,
        } : null;
        return html(res, b ? 200 : 404, hearingHtml.replace('/*__BOOKING__*/null', JSON.stringify(pub)));
      }

      if (method === 'GET' && p === '/healthz') return json(res, 200, { ok: true, storage: backend.kind });

      // ---------- LINE Webhook（署名検証必須 — 追補§7-1） ----------
      if (method === 'POST' && p === '/api/line/webhook') {
        if (!config.channelSecret) return json(res, 503, { error: 'LINE_CHANNEL_SECRET が未設定です' });
        const sig = req.headers['x-line-signature'] || '';
        if (!verifySignature(config.channelSecret, raw, sig)) return json(res, 401, { error: 'bad signature' });
        const payload = body();
        const handled = await handleEvents(payload?.events, ctx);
        return json(res, 200, { ok: true, handled });
      }

      // ---------- 予約（LP/LIFFフォームから） ----------
      if (method === 'POST' && p === '/api/booking') {
        const d = body();
        if (!d || !d.name || !d.preferred_date) return json(res, 400, { error: 'name と preferred_date は必須です' });
        // LINE経由の予約のみ、LINEの表示名をプロフィールAPIから自動取得して記載する
        let line_display_name = '';
        if (d.line_user_id && config.accessToken) {
          try { line_display_name = (await line.getProfile(d.line_user_id)).displayName || ''; }
          catch (e) { await store.appendLog(`LINEプロフィール取得失敗: ${e.message}`); }
        }
        const booking = await store.createBooking({ ...d, line_display_name });
        await store.appendLog(`予約受付 ${booking.name} ${booking.preferred_date} ${booking.preferred_time}`);
        let notified = false;
        try {
          const toggles = await loadToggles();
          if (await toggleAllows(toggles, 'owner_new_booking')) {
            // 新規予約通知：担当スタッフ本人へ（未設定/指名なしは ownerUserId へフォールバック）
            notified = await notifyStaff(ctx, ownerBookingText(booking, config.adminUrl || `${baseUrlOf(req, config)}/admin`), booking.staff || '');
          }
        } catch (e) { await store.appendLog(`オーナー通知失敗: ${e.message}`); }
        return json(res, 200, { ok: true, id: booking.id, notified, hearingUrl: `${baseUrlOf(req, config)}/hearing/${booking.id}` });
      }

      // ---------- 予約確定（管理者） → ②確定Flex ----------
      {
        const m = /^\/api\/bookings\/([^/]+)\/confirm$/.exec(p);
        if (method === 'POST' && m) {
          if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
          const d = body() || {};
          const before = await store.getBooking(m[1]);
          if (!before) return json(res, 404, { error: 'booking not found' });
          const staffPatch = d.staff !== undefined ? { staff: normalizeStaff(d.staff) } : {};
          const b = await store.updateBooking(m[1], {
            status: 'confirmed',
            confirmed_date: d.confirmed_date || before.preferred_date,
            confirmed_time: d.confirmed_time || before.preferred_time,
            price: d.price ?? before.price ?? '',
            ...staffPatch,
          });
          let pushed = false;
          if (b.line_user_id && await toggleAllows(await loadToggles(), 'confirm')) {
            try {
              const r = await guardedPush(b.line_user_id, [buildConfirmFlex({
                salonName: config.salonName, date: b.confirmed_date, time: b.confirmed_time,
                services: b.services, price: b.price,
              })], '確定Flex');
              pushed = !(r && r.skipped);
            } catch (e) { await store.appendLog(`確定通知失敗 ${b.id}: ${e.message}`); }
          }
          await store.appendLog(`予約確定 ${b.name} ${b.confirmed_date} ${b.confirmed_time}${pushed ? '（顧客へFlex送信）' : ''}`);
          return json(res, 200, { ok: true, booking: b, pushed });
        }
      }

      // ---------- 別日提案（管理者） → 顧客へ提案Flex（postbackで承諾/選び直し） ----------
      {
        const m = /^\/api\/bookings\/([^/]+)\/propose$/.exec(p);
        if (method === 'POST' && m) {
          if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
          const d = body() || {};
          if (!d.date || !d.time) return json(res, 400, { error: 'date と time は必須です' });
          const before = await store.getBooking(m[1]);
          if (!before) return json(res, 404, { error: 'booking not found' });
          const proposeStaffPatch = d.staff !== undefined ? { staff: normalizeStaff(d.staff) } : {};
          const b = await store.updateBooking(m[1], {
            status: 'proposed', proposed_date: d.date, proposed_time: d.time,
            ...proposeStaffPatch,
          });
          let pushed = false;
          if (b.line_user_id && await toggleAllows(await loadToggles(), 'proposal')) {
            try {
              const r = await guardedPush(b.line_user_id, [buildProposalFlex({
                salonName: config.salonName, name: b.name,
                origDate: b.preferred_date, origTime: b.preferred_time,
                date: b.proposed_date, time: b.proposed_time, bookingId: b.id,
              })], '別日提案');
              pushed = !(r && r.skipped);
            } catch (e) { await store.appendLog(`別日提案の送信失敗 ${b.id}: ${e.message}`); }
          }
          await store.appendLog(`別日提案 ${b.name} ${b.proposed_date} ${b.proposed_time}`);
          return json(res, 200, { ok: true, booking: b, pushed });
        }
      }

      if (method === 'GET' && p === '/api/bookings') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, { bookings: await store.listBookings() });
      }

      // ---------- 担当スタッフの割り当て/変更（管理者） ----------
      {
        const m = /^\/api\/bookings\/([^/]+)\/staff$/.exec(p);
        if (method === 'POST' && m) {
          if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
          const d = body() || {};
          const before = await store.getBooking(m[1]);
          if (!before) return json(res, 404, { error: 'booking not found' });
          const b = await store.updateBooking(m[1], { staff: normalizeStaff(d.staff) });
          await store.appendLog(`担当変更 ${b.name} → ${b.staff || '指名なし'}`);
          return json(res, 200, { ok: true, booking: b });
        }
      }

      // ---------- 顧客・カルテ同期（カルテUI ⇄ サーバー） ----------
      // GET /api/sync → サーバーの全顧客・全カルテ（カルテはrecipes復元済み）
      if (method === 'GET' && p === '/api/sync') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const customers = await store.listCustomers();
        const cartes = await store.listCartes();
        return json(res, 200, { customers, cartes });
      }

      // POST /api/sync → 一括upsert（初回移行用）
      if (method === 'POST' && p === '/api/sync') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const d = body() || {};
        const customers = Array.isArray(d.customers) ? d.customers : [];
        const cartes = Array.isArray(d.cartes) ? d.cartes : [];
        for (const c of customers) if (c && c.id) await store.upsertCustomer(c);
        for (const k of cartes) if (k && k.id) await store.upsertCarte(k);
        await store.appendLog(`一括同期 顧客${customers.length}件・カルテ${cartes.length}件`);
        return json(res, 200, { ok: true, customers: customers.length, cartes: cartes.length });
      }

      // POST /api/customers → 顧客1件upsert
      if (method === 'POST' && p === '/api/customers') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const d = body();
        if (!d || !d.id) return json(res, 400, { error: 'id は必須です' });
        await store.upsertCustomer(d);
        await reexport();   // テキスト類を即時再生成（SPEC §7）
        await store.appendLog('顧客同期 1件');
        return json(res, 200, { ok: true });
      }

      // POST /api/cartes → カルテ1件upsert（写真メタは保持・バイトは別API）
      if (method === 'POST' && p === '/api/cartes') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const d = body();
        if (!d || !d.id) return json(res, 400, { error: 'id は必須です' });
        await store.upsertCarte(d);
        await reexport();   // カルテ保存ごとに即時エクスポート（SPEC §7）
        await store.appendLog('カルテ同期 1件');
        return json(res, 200, { ok: true });
      }

      // POST /api/cartes/:id/photos → 写真の原本＋サムネを保存し、カルテの写真メタを更新（§6）
      {
        const m = /^\/api\/cartes\/([^/]+)\/photos$/.exec(p);
        if (method === 'POST' && m) {
          if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
          const carteId = decodeURIComponent(m[1]);
          const d = body() || {};
          const cartes = await store.listCartes();
          const carte = cartes.find(k => k.id === carteId);
          if (!carte) return json(res, 404, { error: 'carte not found' });
          const customers = await store.listCustomers();
          const numOf = assignCustomerNumbers(customers);
          const cust = customers.find(c => c.id === carte.customer_id);
          if (!cust) return json(res, 400, { error: 'customer not found' });
          const folder = `${numOf.get(cust.id)}_${String(cust.kana || '').replace(/[\/\\:*?"<>|\s　]/g, '')}`;
          const ymd = String(carte.date || '').slice(0, 10).replace(/-/g, '');
          const incoming = Array.isArray(d.photos) ? d.photos : [];
          const meta = [];
          for (const ph of incoming) {
            const type = ph.type === 'before' ? 'before' : 'after';
            const seq = ph.seq || 1;
            const name = `${carteId}_${ymd}_${type}_${seq}.jpg`;
            await store.saveCartePhoto({ folder, name, originalB64: ph.original, thumbB64: ph.thumb });
            meta.push({ name, type, seq });
          }
          const merged = [...(carte.photos || []).filter(p => !meta.some(x => x.name === p.name)), ...meta];
          await store.upsertCarte({ ...carte, photos: merged });
          await reexport();
          await store.appendLog(`カルテ写真保存 ${meta.length}枚`);
          return json(res, 200, { ok: true, photos: merged });
        }
      }

      // POST /api/export → 全データをDrive書き出し形式で再生成（手動）
      if (method === 'POST' && p === '/api/export') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const r = await buildExportBundle(store, config);
        await store.appendLog(`エクスポート実行 顧客${r.customers}・カルテ${r.cartes}`);
        return json(res, 200, { ok: true, ...r });
      }

      // GET/POST /api/cron/export → 日次の全再生成（§7 差分同期の簡易版）
      if ((method === 'GET' || method === 'POST') && p === '/api/cron/export') {
        if (!(cronOk(req, config) || adminOk(req, config))) return json(res, 401, { error: 'unauthorized' });
        const r = await buildExportBundle(store, config);
        await store.appendLog(`差分エクスポート(cron) 顧客${r.customers}・カルテ${r.cartes}`);
        return json(res, 200, { ok: true, ...r });
      }

      // ---------- ④来店前ヒアリング ----------
      if (method === 'POST' && p === '/api/hearing') {
        const d = body();
        if (!d || !d.bookingId) return json(res, 400, { error: 'bookingId は必須です' });
        const before = await store.getBooking(d.bookingId);
        if (!before) return json(res, 404, { error: 'booking not found' });
        let photoPath = '';
        if (d.photoDataUrl) {
          const pm = /^data:image\/(png|jpe?g|webp|heic);base64,([A-Za-z0-9+/=]+)$/.exec(d.photoDataUrl);
          if (!pm) return json(res, 400, { error: '写真の形式が不正です' });
          photoPath = await store.savePhoto(`ヒアリング_${d.bookingId}.${pm[1] === 'jpeg' ? 'jpg' : pm[1]}`, pm[2]);
        }
        const b = await store.updateBooking(d.bookingId, {
          hearing_concerns: Array.isArray(d.concerns) ? d.concerns : [],
          hearing_style: d.style || '',
          ...(photoPath ? { hearing_photo: photoPath } : {}),
        });
        try {
          if (await toggleAllows(await loadToggles(), 'owner_hearing')) {
            await notifyOwner(ctx, ownerHearingText(b, config.adminUrl || `${baseUrlOf(req, config)}/admin`));
          }
        } catch (e) { await store.appendLog(`ヒアリング通知失敗: ${e.message}`); }
        await store.appendLog(`ヒアリング回答 ${b.name}`);
        return json(res, 200, { ok: true });
      }

      // ---------- 本日のご予約・来店一覧 → オーナーLINEへ（管理画面ボタン） ----------
      if (method === 'POST' && p === '/api/admin/notify-today') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const today = jstToday();
        const targets = (await store.listBookings())
          .filter(b => (b.confirmed_date || b.preferred_date) === today)
          .sort((a, b) => String(a.confirmed_time || a.preferred_time).localeCompare(String(b.confirmed_time || b.preferred_time)));
        // 「秘書」化のための付帯データを各予約に添える（マッチングはここで行う）
        const customers = await store.listCustomers();
        const allCartes = await store.listCartes();
        for (const b of targets) {
          const cust = matchCustomerFor(b, customers);
          b._customer = cust;
          // その顧客の過去（date < 今日）の最新カルテ1件
          b._lastCarte = cust
            ? allCartes
              .filter(k => k.customer_id === cust.id && String(k.date) < today)
              .sort((a, c) => String(c.date).localeCompare(String(a.date)))[0] || null
            : null;
        }
        const dateLabel = `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))}`;
        if (!(await toggleAllows(await loadToggles(), 'owner_today'))) {
          return json(res, 200, { ok: false, error: '本日の一覧の自動配信がオフになっています（設定で確認してください）' });
        }
        try {
          const todayText = ownerTodayListText({ dateLabel, bookings: targets, today });
          const send = guardedPush || ((to, msgs) => line.push(to, msgs));

          // 送信先IDを収集（中村・松吉の両方。設定があるIDのみ。重複はユニーク化）
          const staffUserIds = config.staffUserIds || {};
          const candidateIds = [
            staffUserIds.nakamura,
            staffUserIds.matsuyoshi,
          ].filter(id => id && !id.includes('PLACEHOLDER'));

          // スタッフIDが1件も設定されていない場合は従来どおり ownerUserId の1件のみ
          const ownerFallback = config.ownerUserId || '';
          let recipientIds;
          if (candidateIds.length > 0) {
            // ユニーク化（ownerUserIdと中村IDが同一の場合でも重複しない）
            recipientIds = [...new Set(candidateIds)];
          } else if (ownerFallback && !ownerFallback.includes('PLACEHOLDER')) {
            recipientIds = [ownerFallback];
          } else {
            recipientIds = [];
          }

          if (recipientIds.length === 0) {
            return json(res, 200, { ok: false, error: 'オーナーのLINE User IDが未設定です（設定画面へ）' });
          }

          for (const id of recipientIds) {
            await send(id, [{ type: 'text', text: todayText }], '本日一覧通知');
          }
          await store.appendLog(`本日一覧をLINE通知（${targets.length}件・送信先${recipientIds.length}名）`);
          return json(res, 200, { ok: true, count: targets.length });
        } catch (e) {
          await store.appendLog(`本日一覧通知失敗: ${e.message}`);
          return json(res, 200, { ok: false, error: 'LINEに送信できませんでした。トークンを確認してください。' });
        }
      }

      // ---------- 管理画面ライブ統計（配信量＋友だち数） ----------
      if (method === 'GET' && p === '/api/admin/line-stats') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, await buildLineStats());
      }

      // ---------- 月次レポート（数字の取得のみ・送信なし） ----------
      if (method === 'GET' && p === '/api/admin/monthly-report') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, await buildMonthlyReport());
      }

      // ---------- LINE自動配信カタログ（トグル状態＋プレビュー付き） ----------
      if (method === 'GET' && p === '/api/admin/line-messages') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const toggles = await loadToggles();
        const catalog = buildLineMessages(config, baseUrlOf(req, config));
        const messages = catalog.map(m => ({
          key: m.key, label: m.label, timing: m.timing, audience: m.audience, free: m.free,
          on: toggles[m.key] !== false, // 既定on=true
          preview: m.build(),
        }));
        return json(res, 200, { messages });
      }

      // ---------- LINE自動配信トグルの保存（key単位） ----------
      if (method === 'POST' && p === '/api/admin/line-messages') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const d = body() || {};
        const valid = new Set(buildLineMessages(config, baseUrlOf(req, config)).map(m => m.key));
        if (!d.key || !valid.has(d.key)) return json(res, 400, { error: 'invalid key' });
        await store.setLineToggle(d.key, !!d.on);
        await store.appendLog(`LINE自動配信トグル変更 〔${d.key}〕→ ${d.on ? 'オン' : 'オフ'}`);
        return json(res, 200, { ok: true });
      }

      // ---------- 月次レポートをオーナーへ1通push（cron secret または 管理者） ----------
      if ((method === 'GET' || method === 'POST') && p === '/api/cron/monthly-report') {
        if (!(cronOk(req, config) || adminOk(req, config))) return json(res, 401, { error: 'unauthorized' });
        const report = await buildMonthlyReport();
        let notified = false;
        try {
          if (await toggleAllows(await loadToggles(), 'monthly_report')) {
            notified = await notifyOwner(ctx, monthlyReportText(report));
          }
        } catch (e) { await store.appendLog(`月次レポート通知失敗: ${e.message}`); }
        await store.appendLog(`月次レポートをオーナーへ送信（${report.month}）`);
        return json(res, 200, { ok: true, notified, report });
      }

      // ---------- ⑦空き枠アラート（cron secret または 管理者） ----------
      if (method === 'POST' && p === '/api/vacancy-alert') {
        if (!(cronOk(req, config) || adminOk(req, config))) return json(res, 401, { error: 'unauthorized' });
        const d = body() || {};
        if (!(await toggleAllows(await loadToggles(), 'vacancy'))) {
          return json(res, 200, { ok: true, sent: 0, skipped: true });
        }
        const ids = await store.activeSubscriberIds();
        if (!ids.length) return json(res, 200, { ok: true, sent: 0 });
        const mr = await guardedMulticast(ids, [{
          type: 'text',
          text: vacancyText({ salonName: config.salonName, date: d.date || jstToday(), slots: d.slots, custom: d.text }),
        }], '空き枠アラート');
        if (mr && mr.skipped) return json(res, 200, { ok: true, sent: 0, skipped: true });
        await store.appendLog(`空き枠アラート送信 ${ids.length}名`);
        return json(res, 200, { ok: true, sent: ids.length });
      }

      // ---------- ③前日リマインドcron（cron secret または 管理者） ----------
      if ((method === 'GET' || method === 'POST') && p === '/api/cron/reminder') {
        if (!(cronOk(req, config) || adminOk(req, config))) return json(res, 401, { error: 'unauthorized' });
        const tomorrow = jstToday(1);
        const targets = (await store.listBookings())
          .filter(b => b.status === 'confirmed' && b.confirmed_date === tomorrow && b.line_user_id);
        let sent = 0;
        const reminderOn = await toggleAllows(await loadToggles(), 'reminder');
        for (const b of (reminderOn ? targets : [])) {
          try {
            const r = await guardedPush(b.line_user_id, [buildReminderFlex({
              salonName: config.salonName, date: b.confirmed_date, time: b.confirmed_time,
              services: b.services, hearingUrl: `${baseUrlOf(req, config)}/hearing/${b.id}`,
            })], '前日リマインド');
            if (!(r && r.skipped)) sent++;
          } catch (e) { await store.appendLog(`リマインド失敗 ${b.id}: ${e.message}`); }
        }
        await store.appendLog(`前日リマインドcron 対象${targets.length}件 送信${sent}件`);
        return json(res, 200, { ok: true, targets: targets.length, sent });
      }

      // ---------- ⑤サンクス + ⑥そろそろ cron（cron secret または 管理者） ----------
      if ((method === 'GET' || method === 'POST') && p === '/api/cron/thank-you') {
        if (!(cronOk(req, config) || adminOk(req, config))) return json(res, 401, { error: 'unauthorized' });
        const yesterday = jstToday(-1);
        const today = jstToday();
        const all = (await store.listBookings()).filter(b => b.status === 'confirmed' && b.line_user_id);
        // トグルはcron内で1回だけ取得（thankyou/sorosoro/monthly_reportで共用）
        const toggles = await loadToggles();
        const thankyouOn = await toggleAllows(toggles, 'thankyou');
        const sorosoroOn = await toggleAllows(toggles, 'sorosoro');
        // サンクスLINEでカルテのproductsを参照するため顧客・カルテ一覧を先取り
        const thankyouCustomers = thankyouOn ? await store.listCustomers() : [];
        const thankyouCartes = thankyouOn ? await store.listCartes() : [];
        let thanks = 0, sorosoro = 0;
        for (const b of all) {
          try {
            if (b.confirmed_date === yesterday) {
              if (!thankyouOn) continue;
              // 昨日来店に対応するカルテを探し、productsを取得
              const cust = matchCustomerFor(b, thankyouCustomers);
              const karte = cust
                ? thankyouCartes.find(k => k.customer_id === cust.id && k.date === yesterday)
                : null;
              const products = (karte && Array.isArray(karte.products) && karte.products.length)
                ? karte.products : undefined;
              const r = await guardedPush(b.line_user_id, [buildThankYouFlex({
                salonName: config.salonName, name: b.name, visitDate: b.confirmed_date,
                services: b.services, careUrl: config.careUrl, reviewUrl: config.reviewUrl,
                products,
              })], 'サンクスLINE');
              if (!(r && r.skipped)) thanks++;
            } else if (isSorosoroDay(b.confirmed_date, b.services, today)) {
              if (!sorosoroOn) continue;
              const r = await guardedPush(b.line_user_id, [{
                type: 'text',
                text: sorosoroText({ name: b.name, salonName: config.salonName, ownerName: config.ownerName, services: b.services }),
              }], 'そろそろリマインド');
              if (!(r && r.skipped)) sorosoro++;
            }
          } catch (e) { await store.appendLog(`サンクス/そろそろ失敗 ${b.id}: ${e.message}`); }
        }
        await store.appendLog(`サンクスcron サンクス${thanks}件・そろそろ${sorosoro}件`);
        // 月初(JST 1日)はこの日次cronの中で月次レポートもオーナーへ1通送る
        // （Hobbyプランのcron本数制限を避けるため専用cronは作らない）
        let monthlyReportSent = false;
        if (today.slice(8, 10) === '01' && await toggleAllows(toggles, 'monthly_report')) {
          try {
            monthlyReportSent = await notifyOwner(ctx, monthlyReportText(await buildMonthlyReport()));
            await store.appendLog('月次レポートをオーナーへ送信');
          } catch (e) { await store.appendLog(`月次レポート送信失敗: ${e.message}`); }
        }
        return json(res, 200, { ok: true, thanks, sorosoro, monthlyReportSent });
      }

      // ---------- 設定（管理者のみ・秘密はマスク） ----------
      if (method === 'GET' && p === '/api/settings') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized', needAdminToken: !!config.adminToken });
        const masked = config._secretStore.masked(config);
        masked.webhookUrl = `${baseUrlOf(req, config)}/api/line/webhook`;
        masked.storageKind = backend.kind;
        return json(res, 200, masked);
      }

      if (method === 'POST' && p === '/api/settings') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const d = body();
        if (!d) return json(res, 400, { error: 'invalid json' });
        let saved;
        try { saved = await config._secretStore.saveFileSettings(d); }
        catch (e) { return json(res, 409, { error: e.message, hint: 'Vercel運用の場合は環境変数で設定してください（このAPIは不要）' }); }
        // 実行中の設定にも反映（環境変数が優先のキーは上書きしない）
        const envKeys = new Set(config._sources?.env || []);
        for (const [k, v] of Object.entries(saved)) if (!envKeys.has(k)) config[k] = v;
        await store.appendLog('設定を暗号化保存（値はログに残しません）');
        return json(res, 200, { ok: true, saved: Object.keys(saved) });
      }

      // ---------- 接続テスト（トークンは一時利用のみ・保存しない） ----------
      if (method === 'POST' && p === '/api/line/test') {
        if (!adminOk(req, config)) return json(res, 401, { error: 'unauthorized' });
        const d = body() || {};
        const token = d.accessToken || config.accessToken;
        if (!token) return json(res, 400, { error: 'アクセストークンが未設定です' });
        try {
          const probe = createLineClient({ accessToken: token, apiBase: config.lineApiBase, fetchImpl: config.fetchImpl || fetch });
          const info = await probe.getBotInfo();
          return json(res, 200, { ok: true, bot: { displayName: info.displayName, basicId: info.basicId } });
        } catch (e) {
          return json(res, 200, { ok: false, error: 'LINEに接続できませんでした。トークンを確認してください。' });
        }
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: status === 413 ? 'payload too large' : 'internal error' });
    }
  };
}

// ---------------------------------------------------------------- Vercel対応
// Vercelはリポジトリ直下の server.mjs を「Nodeサーバーのエントリポイント」として自動認識し、
// 「デフォルトエクスポート＝リクエストハンドラ（関数）」を要求する。ここで遅延初期化して応える。
let _vercelHandler = null;
export default async function vercelEntry(req, res) {
  try {
    if (!_vercelHandler) _vercelHandler = loadConfig(process.env).then(createApp);
    return await (await _vercelHandler)(req, res);
  } catch (e) {
    _vercelHandler = null; // 失敗時は次のリクエストで再初期化
    console.error('hair-ravel 起動/処理エラー:', e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'startup error' }));
  }
}

// @vercel/nft（ファイルトレーサ）に public/ を関数バンドルへ同梱させる静的ヒント。実行はされない。
if (process.env.HR_NFT_TRACE === '1') {
  readFileSync(path.join(MODULE_DIR, 'public', 'setup.html'));
  readFileSync(path.join(MODULE_DIR, 'public', 'hearing.html'));
  readFileSync(path.join(MODULE_DIR, 'public', 'booking.html'));
  readFileSync(path.join(MODULE_DIR, 'public', 'karte.html'));
  readFileSync(path.join(MODULE_DIR, 'public', 'admin.html'));
}

// ---------------------------------------------------------------- 起動（直接実行時のみ）
// 注意: トップレベルawaitは使わない（Vercel等のバンドラがCJS変換する環境で致命傷になるため）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const config = await loadConfig();
    const handler = await createApp(config);
    http.createServer(handler).listen(config.port, config.host, () => {
      console.log(`hair-ravel LINE Connect 起動: http://${config.host}:${config.port}/setup`);
      console.log(`データ保存先: ${config.storage === 'github' ? `GitHub ${config.githubRepo}` : config.dataDir}`);
      console.log('トークンはこの環境の外に送信されません（送信先は api.line.me のみ）');
    });
  })().catch(e => { console.error('起動失敗:', e); process.exit(1); });
}
