// Markdownデータ層 — 原則③「プレーンテキストによる超軽量データ保持」
// 予約・購読者・送信ログをすべて人間が読めるMarkdownで保持する。
// フロントマターはJSON互換のYAMLフロースタイル（10年後もどのパーサでも読める）。
import crypto from 'node:crypto';

const DIR_BOOKINGS = '予約';
const DIR_PHOTOS = '写真';
const DIR_THUMBS = 'thumbs';
const DIR_LOGS = 'ログ';
const DIR_CARTES = 'カルテ';
const SUBSCRIBERS_PATH = '購読者/alert_subscribers.md';
const CUSTOMERS_PATH = '顧客/customers.csv';
const LINE_TOGGLES_PATH = '設定/配信トグル.json';

// ---------- JST日付ユーティリティ（VercelはUTC動作のため明示変換） ----------
const JST_MS = 9 * 60 * 60 * 1000;
export function jstToday(offsetDays = 0) {
  const d = new Date(Date.now() + JST_MS);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
export function jstNowIso() {
  return new Date(Date.now() + JST_MS).toISOString().replace(/\.\d+Z$/, '+09:00');
}
export function jstTimeLabel() {
  return new Date(Date.now() + JST_MS).toISOString().slice(11, 16);
}
export function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);
}

// ---------- フロントマター ----------
export function serializeFrontmatter(obj) {
  const lines = Object.entries(obj).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map(x => JSON.stringify(String(x))).join(', ')}]`;
    return `${k}: ${JSON.stringify(String(v ?? ''))}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text || '');
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const lm = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!lm) continue;
    const [, key, raw] = lm;
    try {
      out[key] = raw.startsWith('[') || raw.startsWith('"') ? JSON.parse(raw) : raw;
    } catch { out[key] = raw; }
  }
  return out;
}

const sanitizeName = s => String(s || '').replace(/[\/\\:*?"<>|\s　.]/g, '').slice(0, 30) || '名無し';

// ---------- CSV（顧客台帳） ----------
// 全フィールドをダブルクォートで囲み、内部の " は "" にエスケープ。
// 書き込み時に改行は全角スペースへ置換するため、パーサは複数行フィールド非対応でよい。
// 既存列順は変えない。引き継ぎ仕様で必要な allergy（アレルギー注意）・first_visit（初回来店日）を末尾に追加する。
const CUSTOMER_COLS = ['id', 'name', 'kana', 'phone', 'birthday', 'line_user_id', 'line_name', 'note', 'created_at', 'updated_at', 'allergy', 'first_visit'];
function csvField(v) {
  const s = String(v ?? '').replace(/\r?\n/g, '　'); // 改行は全角スペースへ
  return `"${s.replace(/"/g, '""')}"`;
}
function csvRow(values) {
  return values.map(csvField).join(',');
}
// 1行をクォート対応でパース（クォート内のカンマは保持・"" は " に復元）
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function createMarkdownStore(backend) {
  // ---------- 予約 ----------
  async function createBooking(input) {
    const id = 'bk' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const booking = {
      id,
      created_at: jstNowIso(),
      name: input.name || '',
      phone: input.phone || '',
      line_user_id: input.line_user_id || '',
      line_display_name: input.line_display_name || '',
      services: input.services || [],
      preferred_date: input.preferred_date || '',
      preferred_time: input.preferred_time || '',
      status: 'pending',
      confirmed_date: '',
      confirmed_time: '',
      proposed_date: '',
      proposed_time: '',
      price: input.price || '',
      hearing_concerns: [],
      hearing_style: '',
      hearing_photo: '',
      notes: input.notes || '',
      _path: '',
    };
    booking._path = `${DIR_BOOKINGS}/${booking.preferred_date || jstToday()}_${sanitizeName(booking.name)}_${id}.md`;
    await writeBooking(booking);
    return booking;
  }

  function bookingMarkdown(b) {
    const { _path, ...fm } = b;
    const body = [
      `# 予約：${b.name}（${b.preferred_date} ${b.preferred_time}）`,
      '',
      `- メニュー：${(b.services || []).join(' / ') || '未指定'}`,
      `- 状態：${b.status}${b.confirmed_date ? `（確定 ${b.confirmed_date} ${b.confirmed_time}）` : ''}`,
      b.proposed_date ? `- 提案中：${b.proposed_date} ${b.proposed_time}` : '',
      b.line_user_id ? `- LINE：${b.line_display_name || '（表示名なし）'}（${b.line_user_id}）` : '',
      b.notes ? `- 備考：${b.notes}` : '',
      b.hearing_style || (b.hearing_concerns || []).length
        ? `\n## 来店前ヒアリング\n- お悩み：${(b.hearing_concerns || []).join('・') || '—'}\n- 理想のスタイル：${b.hearing_style || '—'}\n- 写真：${b.hearing_photo ? b.hearing_photo : 'なし'}`
        : '',
    ].filter(Boolean).join('\n');
    return serializeFrontmatter(fm) + '\n' + body + '\n';
  }

  async function writeBooking(b) {
    await backend.writeFile(b._path, bookingMarkdown(b));
  }

  async function listBookings() {
    const names = await backend.listDir(DIR_BOOKINGS);
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const text = await backend.readFile(`${DIR_BOOKINGS}/${n}`);
      const fm = parseFrontmatter(text);
      if (fm && fm.id) out.push({ ...fm, _path: `${DIR_BOOKINGS}/${n}` });
    }
    out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return out;
  }

  async function getBooking(id) {
    return (await listBookings()).find(b => b.id === id) || null;
  }

  async function updateBooking(id, patch) {
    const b = await getBooking(id);
    if (!b) return null;
    Object.assign(b, patch);
    await writeBooking(b);
    return b;
  }

  // ---------- 空き枠通知の購読者 ----------
  async function readSubscribers() {
    const text = await backend.readFile(SUBSCRIBERS_PATH);
    if (!text) return [];
    const subs = [];
    for (const line of text.split('\n')) {
      const m = /^\|\s*(U[0-9a-f]+|[^\s|]+)\s*\|\s*(true|false)\s*\|\s*([^|]*)\|$/.exec(line.trim());
      if (m && m[1] !== 'line_user_id') subs.push({ line_user_id: m[1], active: m[2] === 'true', created_at: m[3].trim() });
    }
    return subs;
  }

  async function writeSubscribers(subs) {
    const rows = subs.map(s => `| ${s.line_user_id} | ${s.active} | ${s.created_at} |`);
    const md = [
      '# 空き枠通知 購読者リスト', '',
      '| line_user_id | active | created_at |',
      '|---|---|---|',
      ...rows, '',
    ].join('\n');
    await backend.writeFile(SUBSCRIBERS_PATH, md);
  }

  async function setSubscriber(lineUserId, active) {
    const subs = await readSubscribers();
    const hit = subs.find(s => s.line_user_id === lineUserId);
    if (hit) hit.active = active;
    else subs.push({ line_user_id: lineUserId, active, created_at: jstNowIso() });
    await writeSubscribers(subs);
    return subs;
  }

  async function activeSubscriberIds() {
    return (await readSubscribers()).filter(s => s.active).map(s => s.line_user_id);
  }

  // ---------- 写真 ----------
  async function savePhoto(name, base64) {
    const p = `${DIR_PHOTOS}/${name}`;
    await backend.writeFile(p, base64, { binaryBase64: true });
    return p;
  }

  // data:URL または素のbase64から本体だけ取り出す
  function stripDataUrl(b64) {
    const m = /^data:[^;]+;base64,(.+)$/s.exec(String(b64 || ''));
    return m ? m[1] : String(b64 || '');
  }

  // カルテ写真の二重保存：原本=写真/[folder]/[name]、サムネ=thumbs/[folder]/[name]（§6）
  async function saveCartePhoto({ folder, name, originalB64, thumbB64 }) {
    if (!folder || !name) throw new Error('folder と name は必須です');
    const orig = `${DIR_PHOTOS}/${folder}/${name}`;
    await backend.writeFile(orig, stripDataUrl(originalB64), { binaryBase64: true });
    let thumb = '';
    if (thumbB64) {
      thumb = `${DIR_THUMBS}/${folder}/${name}`;
      await backend.writeFile(thumb, stripDataUrl(thumbB64), { binaryBase64: true });
    }
    return { original: orig, thumb };
  }

  // ---------- 顧客台帳（CSV 1ファイル） ----------
  async function listCustomers() {
    const text = await backend.readFile(CUSTOMERS_PATH);
    if (!text) return [];
    const lines = text.split('\n').filter(l => l.length);
    if (!lines.length) return [];
    const header = parseCsvLine(lines[0]);
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const c = {};
      header.forEach((h, idx) => { c[h] = cells[idx] ?? ''; });
      if (c.id) out.push(c);
    }
    return out;
  }

  async function writeCustomers(list) {
    const rows = list.map(c => csvRow(CUSTOMER_COLS.map(k => c[k] ?? '')));
    const csv = [CUSTOMER_COLS.join(','), ...rows].join('\n') + '\n';
    await backend.writeFile(CUSTOMERS_PATH, csv);
  }

  // id一致で更新、無ければ追加。updated_atはサーバー側で必ず設定。created_atは新規時のみ。
  async function upsertCustomer(c) {
    const list = await listCustomers();
    const now = jstNowIso();
    const idx = list.findIndex(x => x.id === c.id);
    if (idx >= 0) {
      const merged = { ...list[idx] };
      for (const k of CUSTOMER_COLS) {
        if (k === 'created_at' || k === 'updated_at') continue;
        if (c[k] !== undefined) merged[k] = c[k];
      }
      merged.created_at = list[idx].created_at || c.created_at || now;
      merged.updated_at = now;
      list[idx] = merged;
    } else {
      const fresh = {};
      for (const k of CUSTOMER_COLS) fresh[k] = c[k] ?? '';
      fresh.created_at = c.created_at || now;
      fresh.updated_at = now;
      list.push(fresh);
    }
    await writeCustomers(list);
    return list.find(x => x.id === c.id);
  }

  // ---------- カルテ（1件1ファイル：カルテ/{date}_{name}_{id}.md） ----------
  // recipesはネストオブジェクトのため recipes_json（JSON文字列）として保持する。
  const RECIPE_LABELS = { color: 'カラー', perm: 'パーマ', straight: '縮毛矯正' };

  function carteMarkdown(k, fmExtra = {}) {
    const recipesObj = k.recipes && typeof k.recipes === 'object' ? k.recipes : {};
    // 写真はバイトを持たずメタのみ（[{name,type,seq}]）を photos_json に保持。原本/サムネは別途バイナリ保存。
    const photosMeta = Array.isArray(k.photos)
      ? k.photos.map(p => ({ name: p.name, type: p.type || 'after', seq: p.seq || 1 })).filter(p => p.name)
      : [];
    const fm = {
      id: k.id,
      customer_id: k.customer_id ?? k.customerId ?? '',
      date: k.date || '',
      services: Array.isArray(k.services) ? k.services : [],
      recipes_json: JSON.stringify(recipesObj || {}),
      products: Array.isArray(k.products) ? k.products : [],
      memo: k.memo || '',
      staff: k.staff || '',
      price: (k.price === 0 || k.price) ? String(k.price) : '',
      photos_json: JSON.stringify(photosMeta),
      created_at: fmExtra.created_at || k.created_at || jstNowIso(),
    };
    // 人間が読める本文サマリー
    const lines = [`# カルテ：${fm.date}`, ''];
    lines.push(`- メニュー：${fm.services.join(' / ') || '—'}`);
    for (const key of Object.keys(recipesObj)) {
      const r = recipesObj[key] || {};
      const label = RECIPE_LABELS[key] || key;
      const parts = [r.family, r.detail, r.memo].filter(Boolean).join('／');
      lines.push(`- ${label}：${parts || '—'}`);
    }
    if (fm.products.length) lines.push(`- 使用商品：${fm.products.join('・')}`);
    if (fm.memo) lines.push(`- メモ：${fm.memo}`);
    return serializeFrontmatter(fm) + '\n' + lines.join('\n') + '\n';
  }

  // フロントマターからカルテオブジェクトを復元（recipes_json → recipes に戻す）
  function carteFromFrontmatter(fm, _path) {
    let recipes = {};
    try { recipes = JSON.parse(fm.recipes_json || '{}'); } catch { recipes = {}; }
    let photos = [];
    try { photos = JSON.parse(fm.photos_json || '[]'); } catch { photos = []; }
    const priceRaw = fm.price;
    return {
      id: fm.id,
      customer_id: fm.customer_id || '',
      date: fm.date || '',
      services: Array.isArray(fm.services) ? fm.services : [],
      recipes,
      products: Array.isArray(fm.products) ? fm.products : [],
      memo: fm.memo || '',
      staff: fm.staff || '',
      price: (priceRaw === '' || priceRaw === undefined || priceRaw === null) ? null : Number(priceRaw),
      photos: Array.isArray(photos) ? photos : [],
      created_at: fm.created_at || '',
      _path,
    };
  }

  async function listCartes() {
    const names = await backend.listDir(DIR_CARTES);
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const text = await backend.readFile(`${DIR_CARTES}/${n}`);
      const fm = parseFrontmatter(text);
      if (fm && fm.id) out.push(carteFromFrontmatter(fm, `${DIR_CARTES}/${n}`));
    }
    out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return out;
  }

  // id一致なら同ファイル上書き（初回パスを維持）。photosは保存しない（容量対策）。
  async function upsertCarte(k) {
    const existing = await listCartes();
    const hit = existing.find(x => x.id === k.id);
    const cid = k.customer_id ?? k.customerId ?? (hit ? hit.customer_id : '');
    const path = hit
      ? hit._path
      : `${DIR_CARTES}/${k.date || jstToday()}_${sanitizeName(k._name || cid)}_${k.id}.md`;
    const created_at = hit ? hit.created_at : (k.created_at || jstNowIso());
    await backend.writeFile(path, carteMarkdown({ ...k, customer_id: cid }, { created_at }));
    return carteFromFrontmatter(parseFrontmatter(await backend.readFile(path)), path);
  }

  // ---------- LINE自動配信のON/OFFトグル（設定/配信トグル.json） ----------
  // ファイルが無い／キー未記載は既定on=true（現行挙動を変えない）。値はboolのみ。
  async function getLineToggles() {
    const text = await backend.readFile(LINE_TOGGLES_PATH);
    if (!text) return {};
    try {
      const obj = JSON.parse(text);
      const out = {};
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) out[k] = v !== false;
      }
      return out;
    } catch { return {}; }
  }
  async function setLineToggle(key, on) {
    const cur = await getLineToggles();
    cur[String(key)] = !!on;
    await backend.writeFile(LINE_TOGGLES_PATH, JSON.stringify(cur, null, 2) + '\n');
    return cur;
  }

  // ---------- 送信・受信ログ（監査用。トークン・全文User IDは書かない） ----------
  async function appendLog(line) {
    const p = `${DIR_LOGS}/${jstToday()}.md`;
    const cur = (await backend.readFile(p)) || `# 送受信ログ ${jstToday()}\n`;
    await backend.writeFile(p, cur + `- ${jstTimeLabel()} ${line}\n`);
  }
  const maskId = id => (id ? String(id).slice(0, 6) + '…' : '(不明)');

  return {
    backend,
    createBooking, listBookings, getBooking, updateBooking,
    readSubscribers, setSubscriber, activeSubscriberIds,
    listCustomers, upsertCustomer,
    listCartes, upsertCarte,
    getLineToggles, setLineToggle,
    savePhoto, saveCartePhoto, appendLog, maskId,
  };
}
