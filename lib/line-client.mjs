// LINE Messaging API クライアント + メッセージビルダー
// アクセストークンは「このインスタンス（オーナーの環境）」内でのみ使用。外部送信先は api.line.me のみ。
import { getNextVisitDays, recommendHomecare, monthsLabel } from './visit-timing.mjs';

const COLOR = {
  burgundy: '#7B3B4B',  // ②予約確定
  orange: '#ED9A4C',    // ③前日リマインド
  ink: '#3D2B1F',
  accent: '#8C6B5A',
  sub: '#B8A090',
  bg: '#FFFDF9',
};

export function createLineClient({ accessToken, apiBase = 'https://api.line.me', fetchImpl = fetch }) {
  async function call(path, body) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LINE API ${path} 失敗 ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
  }
  return {
    reply: (replyToken, messages) => call('/v2/bot/message/reply', { replyToken, messages }),
    push: (to, messages) => call('/v2/bot/message/push', { to, messages }),
    async multicast(ids, messages) {
      // multicastは1回500件まで（追補引き継ぎ書 §7-3）
      for (let i = 0; i < ids.length; i += 500) {
        await call('/v2/bot/message/multicast', { to: ids.slice(i, i + 500), messages });
      }
      return { sent: ids.length };
    },
    getBotInfo: () => call('/v2/bot/info'),
    getProfile: userId => call('/v2/bot/profile/' + encodeURIComponent(userId)),
  };
}

// ---------- 共通Flexパーツ ----------
const text = (t, opt = {}) => ({ type: 'text', text: t, wrap: true, ...opt });
const row = (label, value) => ({
  type: 'box', layout: 'baseline', spacing: 'sm', contents: [
    text(label, { color: COLOR.sub, size: 'sm', flex: 2 }),
    text(value, { color: COLOR.ink, size: 'sm', flex: 5 }),
  ],
});
const uriButton = (label, uri, style = 'primary') => ({
  type: 'button', style, height: 'sm', color: style === 'primary' ? COLOR.accent : undefined,
  action: { type: 'uri', label, uri },
});
const bubble = ({ headerText, headerColor, bodyContents, footerContents }) => ({
  type: 'bubble',
  ...(headerText ? {
    header: {
      type: 'box', layout: 'vertical', backgroundColor: headerColor, paddingAll: 'lg',
      contents: [text(headerText, { color: '#FFFFFF', weight: 'bold', size: 'md' })],
    },
  } : {}),
  body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', backgroundColor: COLOR.bg, contents: bodyContents },
  ...(footerContents && footerContents.length ? {
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: COLOR.bg, contents: footerContents },
  } : {}),
});

// ---------- ②予約確定通知（バーガンディヘッダー） ----------
export function buildConfirmFlex({ salonName, date, time, services, price }) {
  const body = [
    text('ご予約が確定しました。ご来店を心よりお待ちしております。', { size: 'sm', color: COLOR.ink }),
    row('日時', `${date} ${time}`),
    row('メニュー', (services || []).join(' / ') || '—'),
  ];
  if (price) body.push(row('料金', `${price}`));
  return {
    type: 'flex',
    altText: `【${salonName}】ご予約確定：${date} ${time}`,
    contents: bubble({ headerText: `✂️ ${salonName}｜ご予約確定`, headerColor: COLOR.burgundy, bodyContents: body }),
  };
}

// ---------- ③前日リマインド + ヒアリングリンク（オレンジヘッダー） ----------
export function buildReminderFlex({ salonName, date, time, services, hearingUrl }) {
  return {
    type: 'flex',
    altText: `【${salonName}】明日のご予約のお知らせ（${time}）`,
    contents: bubble({
      headerText: '📅 明日のご予約のお知らせ',
      headerColor: COLOR.orange,
      bodyContents: [
        row('日時', `${date} ${time}`),
        row('メニュー', (services || []).join(' / ') || '—'),
        text('ご来店前に気になることがあれば、下のフォームから教えてください（任意・1分）。', { size: 'xs', color: COLOR.sub }),
      ],
      footerContents: hearingUrl ? [uriButton('来店前ヒアリングに答える', hearingUrl)] : [],
    }),
  };
}

// ---------- ⑤サンクスLINE + ホームケア提案（オフホワイト） ----------
export function buildThankYouFlex({ salonName, name, visitDate, services, careUrl, reviewUrl, products }) {
  const nextDays = getNextVisitDays(services);
  const care = (products && products.length) ? products : recommendHomecare(services);
  const footer = [];
  if (careUrl) footer.push(uriButton('ホームケアの詳しい使い方', careUrl));
  if (reviewUrl) footer.push(uriButton('Googleマップで感想を書く', reviewUrl, 'secondary'));
  const body = [
    text('昨日はありがとうございました ✨', { weight: 'bold', size: 'md', color: COLOR.accent }),
    text(`${name}さま、${(services || []).join(' / ')}でのご来店、心より感謝いたします。`, { size: 'sm', color: COLOR.ink }),
    row('次回目安', `約${nextDays}日後（${monthsLabel(nextDays)}ごろ）`),
    row('おすすめケア', care.join(' + ')),
    text('髪の状態で気になることがあれば、いつでもLINEでご相談くださいね。', { size: 'xs', color: COLOR.sub }),
  ];
  if (reviewUrl) {
    body.push(text('もし仕上がりを気に入っていただけたら、Googleマップでひとこと感想をいただけるととても励みになります。もちろん任意です☺️', { size: 'xs', color: COLOR.sub, wrap: true }));
  }
  return {
    type: 'flex',
    altText: `【${salonName}】昨日はありがとうございました✨`,
    contents: bubble({
      bodyContents: body,
      footerContents: footer,
    }),
  };
}

// ---------- ⑥そろそろリマインド（プレーンテキスト） ----------
export function sorosoroText({ name, salonName, ownerName, services }) {
  const days = getNextVisitDays(services);
  const label = (services || []).join(' / ') || '前回の施術';
  return [
    `${name}さん、こんにちは☺️`,
    `${salonName} ${ownerName}です。`,
    '',
    `前回の${label}から そろそろ${monthsLabel(days)}が近づいてきました！`,
    '髪の状態はいかがでしょうか？✨',
    '',
    '気になりはじめたら、お気軽にご予約・ご相談くださいね😊',
    '',
    `${salonName} ${ownerName}`,
  ].join('\n');
}

// ---------- 本日のご予約・来店一覧 → オーナー通知（「秘書」化・管理画面ボタン用） ----------
// データ取得はしない。server.mjs側で各bookingに _customer（顧客 or null）と
// _lastCarte（過去の最新カルテ or null）を添えて渡す。データのある行だけ表示する。
function jstMonthNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCMonth() + 1; // 1-12
}
function mdLabel(ymd) {
  // 'YYYY-MM-DD' → 'M/D'（先頭ゼロ落とし）
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? `${Number(m[1])}/${Number(m[2])}` : '';
}
export function ownerTodayListText({ dateLabel, bookings }) {
  if (!bookings.length) {
    return `📋 本日のご予約・来店（${dateLabel}）\n\n本日のご予約はありません。`;
  }
  const thisMonth = jstMonthNow();
  const blocks = bookings.map(b => {
    const head = `${b.confirmed_time || b.preferred_time || '--:--'}　${b.name}（${(b.services || []).join(' / ') || '—'}）`
      + (b.status === 'confirmed' ? '✅' : '⏳承認待ち')
      + (b.line_user_id ? ' 💬LINE' : '');
    const sub = [];
    const c = b._customer;
    // 🎂 誕生日行（birthdayがYYYY-MM-DDのときのみ）
    if (c && c.birthday) {
      const md = mdLabel(c.birthday);
      if (md) {
        const bm = Number(c.birthday.slice(5, 7));
        sub.push(`　🎂 ${md} お誕生日${bm === thisMonth ? '（今月！）' : ''}`);
      }
    }
    // 📒 前回行（過去カルテの最新1件。フリーメモは60文字で…）
    const lc = b._lastCarte;
    if (lc) {
      const menu = (lc.services || []).join('＋') || '前回の施術';
      let line = `　📒 前回 ${mdLabel(lc.date)} ${menu}`;
      const memo = String(lc.memo || '');
      if (memo) line += `「${memo.length > 60 ? memo.slice(0, 60) + '…' : memo}」`;
      sub.push(line);
    }
    // ✏️ ヒアリング行（予約のhearing_concerns / hearing_styleがあれば）
    const concerns = (b.hearing_concerns || []).join('・');
    const style = b.hearing_style || '';
    if (concerns || style) {
      sub.push(`　✏️ ヒアリング：${[concerns, style].filter(Boolean).join('／')}`);
    }
    return [head, ...sub].join('\n');
  });
  return [`📋 本日のご予約・来店（${dateLabel}）`, '', ...blocks, '', `計${bookings.length}件`].join('\n');
}

// ---------- ①新規予約リクエスト → オーナー通知 ----------
export function ownerBookingText(b, adminUrl) {
  return [
    '📅 新しい予約リクエストが届きました',
    '',
    `👤 ${b.name}${b.line_display_name ? `（LINE: ${b.line_display_name}）` : ''}`,
    `📞 ${b.phone || '—'}`,
    `✂️ ${(b.services || []).join(' / ') || '—'}`,
    `🗓 ${b.preferred_date}（${b.preferred_time}）`,
    b.notes ? `📝 ${b.notes}` : null,
    '',
    '管理画面で確定してください：',
    adminUrl,
  ].filter(v => v !== null).join('\n');
}

// ---------- ④ヒアリング回答 → オーナー通知 ----------
export function ownerHearingText(b, adminUrl) {
  return [
    '✏️ 来店前ヒアリングが届きました',
    '',
    `👤 ${b.name}`,
    `🗓 ${b.confirmed_date || b.preferred_date}（${b.confirmed_time || b.preferred_time}）`,
    `✂️ ${(b.services || []).join(' / ') || '—'}`,
    '',
    `【お悩み】${(b.hearing_concerns || []).join('・') || '—'}`,
    `【理想のスタイル】${b.hearing_style || '—'}`,
    `【写真】${b.hearing_photo ? 'あり（データフォルダで確認できます）' : 'なし'}`,
    '',
    `管理画面：${adminUrl}`,
  ].join('\n');
}

// ---------- ⑦空き枠アラート ----------
export function vacancyText({ salonName, date, slots, custom }) {
  if (custom) return custom;
  return [
    `🔔【${salonName}】空き枠のお知らせ`,
    '',
    `${date} に空きが出ました！`,
    ...(slots && slots.length ? ['', ...slots.map(s => `・${s}`)] : []),
    '',
    'ご予約はお早めにどうぞ☺️',
  ].join('\n');
}

// ---------- 友だち追加ウェルカム / 購読の返信 ----------
export function welcomeText({ salonName, bookingUrl }) {
  return [
    `友だち追加ありがとうございます✨ ${salonName}です。`,
    '',
    bookingUrl ? `ご予約はこちらから：\n${bookingUrl}` : 'ご予約・ご相談はこのトークにどうぞ。',
    '',
    'メニューの「空き枠通知を受け取る」を押すと、キャンセルが出たときにすぐお知らせします🔔',
  ].join('\n');
}
export const subscribeOnText = '空き枠通知を登録しました🔔\nキャンセルが出たらすぐにお知らせします。\n解除はメニューからいつでもできます。';
export const subscribeOffText = '空き枠通知を解除しました。\nまた必要になったら、いつでも登録してくださいね☺️';
