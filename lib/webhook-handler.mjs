// LINE Webhook処理 — 署名検証（HMAC-SHA256 + timingSafeEqual）とイベントルーティング
import crypto from 'node:crypto';
import { subscribeOnText, subscribeOffText, welcomeText } from './line-client.mjs';

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
export async function handleEvents(events, { store, line, config }) {
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
