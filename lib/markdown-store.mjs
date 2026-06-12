// Markdownデータ層 — 原則③「プレーンテキストによる超軽量データ保持」
// 予約・購読者・送信ログをすべて人間が読めるMarkdownで保持する。
// フロントマターはJSON互換のYAMLフロースタイル（10年後もどのパーサでも読める）。
import crypto from 'node:crypto';

const DIR_BOOKINGS = '予約';
const DIR_PHOTOS = '写真';
const DIR_LOGS = 'ログ';
const SUBSCRIBERS_PATH = '購読者/alert_subscribers.md';

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
    savePhoto, appendLog, maskId,
  };
}
