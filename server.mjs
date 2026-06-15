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
import { verifySignature, handleEvents } from './lib/webhook-handler.mjs';
import { isSorosoroDay } from './lib/visit-timing.mjs';
import {
  createLineClient, buildConfirmFlex, buildReminderFlex, buildThankYouFlex, buildProposalFlex,
  sorosoroText, ownerBookingText, ownerHearingText, vacancyText, ownerTodayListText,
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
  config._secretStore = secretStore;
  return config;
}

// ---------------------------------------------------------------- 補助
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

// オーナー通知（LINE_OWNER_USER_ID未設定/PLACEHOLDERならスキップ — 追補§7-4）
async function notifyOwner(ctx, text) {
  const { config, line, store } = ctx;
  const id = config.ownerUserId || '';
  if (!id || id.includes('PLACEHOLDER')) {
    await store.appendLog('オーナー通知スキップ（LINE_OWNER_USER_ID未設定）');
    return false;
  }
  await line.push(id, [{ type: 'text', text }]);
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
  // ctx は webhook-handler 等に渡す共有コンテキスト。
  // notifyOwner は ctx 自身を参照するため、先に器を作ってから後付けする（循環参照を避ける）。
  const ctx = { config, store, line };
  ctx.notifyOwner = text => notifyOwner(ctx, text);

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
          notified = await notifyOwner(ctx, ownerBookingText(booking, config.adminUrl || `${baseUrlOf(req, config)}/admin`));
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
          const b = await store.updateBooking(m[1], {
            status: 'confirmed',
            confirmed_date: d.confirmed_date || before.preferred_date,
            confirmed_time: d.confirmed_time || before.preferred_time,
            price: d.price ?? before.price ?? '',
          });
          let pushed = false;
          if (b.line_user_id) {
            try {
              await line.push(b.line_user_id, [buildConfirmFlex({
                salonName: config.salonName, date: b.confirmed_date, time: b.confirmed_time,
                services: b.services, price: b.price,
              })]);
              pushed = true;
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
          const b = await store.updateBooking(m[1], {
            status: 'proposed', proposed_date: d.date, proposed_time: d.time,
          });
          let pushed = false;
          if (b.line_user_id) {
            try {
              await line.push(b.line_user_id, [buildProposalFlex({
                salonName: config.salonName, name: b.name,
                origDate: b.preferred_date, origTime: b.preferred_time,
                date: b.proposed_date, time: b.proposed_time, bookingId: b.id,
              })]);
              pushed = true;
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
          await notifyOwner(ctx, ownerHearingText(b, config.adminUrl || `${baseUrlOf(req, config)}/admin`));
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
        try {
          const notified = await notifyOwner(ctx, ownerTodayListText({ dateLabel, bookings: targets }));
          if (!notified) return json(res, 200, { ok: false, error: 'オーナーのLINE User IDが未設定です（設定画面へ）' });
          await store.appendLog(`本日一覧をオーナーへLINE通知（${targets.length}件）`);
          return json(res, 200, { ok: true, count: targets.length });
        } catch (e) {
          await store.appendLog(`本日一覧通知失敗: ${e.message}`);
          return json(res, 200, { ok: false, error: 'LINEに送信できませんでした。トークンを確認してください。' });
        }
      }

      // ---------- ⑦空き枠アラート（cron secret または 管理者） ----------
      if (method === 'POST' && p === '/api/vacancy-alert') {
        if (!(cronOk(req, config) || adminOk(req, config))) return json(res, 401, { error: 'unauthorized' });
        const d = body() || {};
        const ids = await store.activeSubscriberIds();
        if (!ids.length) return json(res, 200, { ok: true, sent: 0 });
        await line.multicast(ids, [{
          type: 'text',
          text: vacancyText({ salonName: config.salonName, date: d.date || jstToday(), slots: d.slots, custom: d.text }),
        }]);
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
        for (const b of targets) {
          try {
            await line.push(b.line_user_id, [buildReminderFlex({
              salonName: config.salonName, date: b.confirmed_date, time: b.confirmed_time,
              services: b.services, hearingUrl: `${baseUrlOf(req, config)}/hearing/${b.id}`,
            })]);
            sent++;
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
        let thanks = 0, sorosoro = 0;
        for (const b of all) {
          try {
            if (b.confirmed_date === yesterday) {
              await line.push(b.line_user_id, [buildThankYouFlex({
                salonName: config.salonName, name: b.name, visitDate: b.confirmed_date,
                services: b.services, careUrl: config.careUrl, reviewUrl: config.reviewUrl,
              })]);
              thanks++;
            } else if (isSorosoroDay(b.confirmed_date, b.services, today)) {
              await line.push(b.line_user_id, [{
                type: 'text',
                text: sorosoroText({ name: b.name, salonName: config.salonName, ownerName: config.ownerName, services: b.services }),
              }]);
              sorosoro++;
            }
          } catch (e) { await store.appendLog(`サンクス/そろそろ失敗 ${b.id}: ${e.message}`); }
        }
        await store.appendLog(`サンクスcron サンクス${thanks}件・そろそろ${sorosoro}件`);
        return json(res, 200, { ok: true, thanks, sorosoro });
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
