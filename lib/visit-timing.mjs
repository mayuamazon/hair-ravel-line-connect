// 次回来店タイミング & ホームケア自動判定 — 追補引き継ぎ書 §2-⑤⑥ のロジックを移植
import { daysBetween } from './markdown-store.mjs';

const has = (services, words) => (services || []).some(s => words.some(w => String(s).includes(w)));

// 次回来店日数（優先順位つき：長いものが勝つ）
export function getNextVisitDays(services) {
  if (has(services, ['縮毛矯正', 'ストレート'])) return 100;
  if (has(services, ['パーマ'])) return 75;
  if (has(services, ['カラー', 'カット'])) return 50;
  if (has(services, ['トリートメント'])) return 45;
  return 60; // メニュー不明時の汎用値
}

// 「そろそろリマインド」該当日か？ confirmed_date + nextVisitDays - 14 === today
export function isSorosoroDay(confirmedDate, services, todayYmd) {
  if (!confirmedDate) return false;
  return daysBetween(confirmedDate, todayYmd) === getNextVisitDays(services) - 14;
}

// ホームケア提案（product_selection_mode = "auto" のロジック）
export function recommendHomecare(services) {
  if (has(services, ['縮毛矯正', 'ストレート'])) return ['シャンプー', 'コネクタージェル'];
  if (has(services, ['パーマ', 'カラー', 'カット'])) return ['シャンプー', 'CMCトリートメント'];
  if (has(services, ['トリートメント'])) return ['シャンプー'];
  return ['シャンプー'];
}

// 「約◯ヶ月」表現（そろそろリマインド文面用）
export function monthsLabel(days) {
  const m = Math.round(days / 30);
  return m <= 1 ? '1ヶ月' : `${m}ヶ月`;
}
