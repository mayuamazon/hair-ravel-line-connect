// LINE Webhook処理 — 署名検証（HMAC-SHA256 + timingSafeEqual）とイベントルーティング
// import方向は line-client.mjs ← webhook-handler.mjs の一方向のみ（循環させない）
import crypto from 'node:crypto';
import {
  subscribeOnText, subscribeOffText, welcomeText,
  buildConfirmFlex, ownerAcceptedText, ownerRepickText,
} from './line-client.mjs';

export function verifySignature(channelSecret, rawBody, signature) {
  if (!channelSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const TEXT_ON = '空き枠通知を登録する';
const TEXT_OFF = '空き枠通知を解除する';

// イベントを処理して概要を返す（返信失敗はログのみ、Webhook自体は成功扱い＝LINE再送ループ防止）
export async function handleEvents(events, ctx) {
  const { store, line, config } = ctx;
  // オーナーへのpush（server.mjsから渡されたnotifyOwnerを使う。無ければ無害なフォールバック）
  const notifyOwner = typeof ctx.notifyOwner === 'function' ? ctx.notifyOwner : async () => false;
  const handled = [];
  for (const ev of events || []) {
    const uid = ev.source?.userId || '';
    try {
      if (ev.type === 'follow') {
        if (ev.replyToken) {
          await line.reply(ev.replyToken, [{ type: 'text', text: welcomeText({ salonName: config.salonName, bookingUrl: config.bookingUrl }) }]);
        }
        await store.appendLog(`webhook follow ${store.maskId(uid)} → ウェルカム送信`);
        handled.push('follow');
        continue;
      }

      // ---------- 別日提案への応答（postback：booking_accept / booking_repick） ----------
      if (ev.type === 'postback') {
        const pd = new URLSearchParams(ev.postback?.data || '');
        const pa = pd.get('action');
        if (pa === 'booking_accept' || pa === 'booking_repick') {
          const handledTag = await handleProposalReply(ev, pd.get('id') || '', pa, ctx, notifyOwner);
          handled.push(handledTag);
          continue;
        }
      }

      let action = null;
      if (ev.type === 'message' && ev.message?.type === 'text') {
        const t = (ev.message.text || '').trim();
        if (t === TEXT_ON) action = 'on';
        if (t === TEXT_OFF) action = 'off';
      }
      if (ev.type === 'postback') {
        const data = new URLSearchParams(ev.postback?.data || '');
        if (data.get('action') === 'alert_on') action = 'on';
        if (data.get('action') === 'alert_off') action = 'off';
      }

      if (action && uid) {
        await store.setSubscriber(uid, action === 'on');
        if (ev.replyToken) {
          await line.reply(ev.replyToken, [{ type: 'text', text: action === 'on' ? subscribeOnText : subscribeOffText }]);
        }
        await store.appendLog(`webhook 空き枠通知${action === 'on' ? '登録' : '解除'} ${store.maskId(uid)}`);
        handled.push(`alert_${action}`);
      } else {
        handled.push('ignored');
      }
    } catch (e) {
      await store.appendLog(`webhookエラー ${store.maskId(uid)}: ${e.message}`).catch(() => {});
      handled.push('error');
    }
  }
  return handled;
}

// 別日提案への応答を処理する。proposed状態の予約だけが対象（二重押下・処理済みは無視）。
async function handleProposalReply(ev, id, action, ctx, notifyOwner) {
  const { store, line, config } = ctx;
  const reply = text => ev.replyToken ? line.reply(ev.replyToken, [{ type: 'text', text }]) : Promise.resolve();
  const b = id ? await store.getBooking(id) : null;

  if (!b) {
    await reply('この予約が見つかりませんでした。');
    return 'ignored';
  }

  if (action === 'booking_accept') {
    if (b.status !== 'proposed') {
      await reply('この予約はすでに処理済みです。');
      return 'booking_accept';
    }
    const updated = await store.updateBooking(id, {
      status: 'confirmed',
      confirmed_date: b.proposed_date,
      confirmed_time: b.proposed_time,
    });
    if (ev.replyToken) {
      await line.reply(ev.replyToken, [buildConfirmFlex({
        salonName: config.salonName, date: updated.confirmed_date, time: updated.confirmed_time,
        services: updated.services, price: updated.price,
      })]);
    }
    await notifyOwner(ownerAcceptedText(updated));
    await store.appendLog(`提案承諾 ${updated.name} ${updated.confirmed_date} ${updated.confirmed_time}`);
    return 'booking_accept';
  }

  // action === 'booking_repick'
  if (b.status !== 'proposed') {
    await reply('この予約はすでに処理済みです。');
    return 'booking_repick';
  }
  const notes = `${b.notes || ''}／お客様が別日時を希望`;
  const updated = await store.updateBooking(id, { status: 'cancelled', notes });
  const bookingUrl = config.bookingUrl || '';
  const guide = bookingUrl
    ? `かしこまりました。下のリンクからご都合の良い日時で改めてリクエストしてください☺️\n${bookingUrl}`
    : 'かしこまりました。メニューの予約ボタンからご都合の良い日時で改めてリクエストしてください☺️';
  await reply(guide);
  await notifyOwner(ownerRepickText(updated, bookingUrl));
  await store.appendLog(`提案を辞退 ${updated.name}（別日時希望）`);
  return 'booking_repick';
}
