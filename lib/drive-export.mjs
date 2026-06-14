// カルテデータのエクスポート（引き継ぎ仕様 reference にバイト一致）
// アプリが止まってもDriveのCSV＋JSON＋写真原本だけで人間が読め、技術者が復元できる形を生成する。
// 写真原本/サムネは saveCartePhoto で別途バイナリ保存済み。ここはテキスト類＋HTMLを書き出す。
import { buildMobileViewHtml } from './mobile-view.mjs';

const CUSTOMER_HEADER = '顧客ID,名前（漢字）,ふりがな,アレルギー注意,電話番号,LINEユーザーID,担当者メモ,初回来店日,登録日';
const HISTORY_HEADER = '履歴ID,顧客ID,名前,来店日,担当者,メニュー,薬剤履歴,カラー履歴,仕上がり・次回提案メモ,金額,写真フォルダ,写真ファイル';

const BOM = '﻿';
const dateOnly = s => String(s || '').slice(0, 10);          // ISO/日付 → YYYY-MM-DD
const ymd = s => dateOnly(s).replace(/-/g, '');               // → YYYYMMDD
const sanitizeKana = s => String(s || '').replace(/[\/\\:*?"<>|\s　]/g, '');

// RFC4180風CSVフィールド（, " 改行 を含む時のみダブルクォート囲み・" は ""）
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = arr => arr.map(csvCell).join(',');

// 内部顧客IDの安定採番（created_at昇順→内部id昇順で 0001..）
export function assignCustomerNumbers(customers) {
  const sorted = [...customers].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  const map = new Map();
  sorted.forEach((c, i) => map.set(c.id, String(i + 1).padStart(4, '0')));
  return map;
}

// レシピ → 薬剤履歴／カラー履歴 の文字列化
function chemText(recipes) {
  const r = recipes || {};
  return [r.color?.detail, r.perm?.detail, r.straight?.detail].filter(Boolean).join(' ／ ');
}
function colorText(recipes) {
  const c = (recipes || {}).color || {};
  return [c.family, c.memo].filter(Boolean).join('／');
}

// 顧客の初回来店日：first_visit > 最古カルテ日 > 登録日(created_atの日付)
function firstVisitOf(cust, cartesOfCust) {
  if (cust.first_visit) return dateOnly(cust.first_visit);
  if (cartesOfCust.length) {
    return dateOnly(cartesOfCust.map(k => k.date).sort()[0]);
  }
  return dateOnly(cust.created_at);
}

// エクスポート用の中間表現を構築（CSV/JSON/HTML が同じ素材を使う）
export function buildExportModel({ customers, cartes, salonName, ownerName, now }) {
  const numOf = assignCustomerNumbers(customers);
  const custSorted = [...customers].sort((a, b) =>
    String(numOf.get(a.id)).localeCompare(String(numOf.get(b.id))));
  const cartesByCust = new Map();
  for (const k of cartes) {
    const arr = cartesByCust.get(k.customer_id) || [];
    arr.push(k); cartesByCust.set(k.customer_id, arr);
  }

  const customersOut = custSorted.map(c => {
    const num = numOf.get(c.id);
    const folder = `${num}_${sanitizeKana(c.kana)}`;
    const mine = (cartesByCust.get(c.id) || [])
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
    const visits = mine.map(k => {
      const photoNames = (k.photos || [])
        .slice()
        .sort((a, b) => (a.type === b.type ? (a.seq - b.seq) : (a.type === 'before' ? -1 : 1)))
        .map(p => p.name);
      return {
        履歴ID: k.id,
        来店日: dateOnly(k.date),
        担当者: k.staff || ownerName || '',
        メニュー: (k.services || []).join('＋'),
        薬剤履歴: chemText(k.recipes),
        カラー履歴: colorText(k.recipes),
        メモ: k.memo || '',
        金額: (k.price === 0 || k.price) ? Number(k.price) : null,
        写真フォルダ: `写真/${folder}/`,
        写真: photoNames,
        _photos: k.photos || [],
        _folder: folder,
      };
    });
    return {
      顧客ID: num,
      名前: c.name || '',
      ふりがな: c.kana || '',
      アレルギー注意: c.allergy || '',
      電話番号: c.phone || '',
      LINEユーザーID: c.line_user_id || '',
      担当者メモ: c.note || '',
      初回来店日: firstVisitOf(c, mine),
      登録日: dateOnly(c.created_at),
      _folder: folder,
      施術履歴: visits,
    };
  });
  return { salonName, now, customers: customersOut };
}

// ---- 各ファイル文字列の生成 ----
export function customerCsv(model) {
  const rows = model.customers.map(c => csvRow([
    c.顧客ID, c.名前, c.ふりがな, c.アレルギー注意, c.電話番号,
    c.LINEユーザーID, c.担当者メモ, c.初回来店日, c.登録日,
  ]));
  return BOM + [CUSTOMER_HEADER, ...rows].join('\r\n') + '\r\n';
}

export function historyCsv(model) {
  const rows = [];
  for (const c of model.customers) {
    for (const v of c.施術履歴) {
      rows.push(csvRow([
        v.履歴ID, c.顧客ID, c.名前, v.来店日, v.担当者, v.メニュー,
        v.薬剤履歴, v.カラー履歴, v.メモ,
        (v.金額 === 0 || v.金額) ? String(v.金額) : '',
        v.写真フォルダ, v.写真.join(', '),
      ]));
    }
  }
  return BOM + [HISTORY_HEADER, ...rows].join('\r\n') + '\r\n';
}

export function dataJson(model) {
  const doc = {
    サロン名: model.salonName,
    書き出し日時: model.now,
    形式バージョン: '1.0',
    顧客: model.customers.map(c => ({
      顧客ID: c.顧客ID,
      名前: c.名前,
      ふりがな: c.ふりがな,
      アレルギー注意: c.アレルギー注意,
      電話番号: c.電話番号,
      LINEユーザーID: c.LINEユーザーID,
      担当者メモ: c.担当者メモ,
      初回来店日: c.初回来店日,
      登録日: c.登録日,
      施術履歴: c.施術履歴.map(v => ({
        履歴ID: v.履歴ID,
        来店日: v.来店日,
        担当者: v.担当者,
        メニュー: v.メニュー,
        薬剤履歴: v.薬剤履歴,
        カラー履歴: v.カラー履歴,
        メモ: v.メモ,
        金額: v.金額,
        写真フォルダ: v.写真フォルダ,
        写真: v.写真,
      })),
    })),
  };
  return JSON.stringify(doc, null, 2);
}

export function readmeText(salonName) {
  return `【${salonName} カルテデータ】

このフォルダには、あなたのサロンの顧客データがすべて入っています。
アプリが使えなくなっても、このフォルダだけで内容を確認できます。

■ 顧客マスター.csv … お客様の一覧（ダブルクリックでExcelが開きます）
■ 施術履歴.csv     … 来店ごとの薬剤・カラー・メモの記録
■ 写真/            … お客様ごとのフォルダに、before/after写真が入っています
■ data.json        … システムを別の技術者が復元する時に使う完全データ
                     （普段は開かなくて大丈夫です）

※ CSVが文字化けする場合は、Excelの「データ→テキスト/CSVから」でUTF-8を指定して開いてください。
`;
}

// 一括エクスポート：テキスト類＋スマホビューHTMLを backend へ書き出す（写真原本/サムネは別途保存済み）
export async function buildExportBundle(store, config, opts = {}) {
  const now = opts.now || jstNowIsoLocal();
  const customers = await store.listCustomers();
  const cartes = await store.listCartes();
  const model = buildExportModel({
    customers, cartes,
    salonName: config.salonName || 'Hair ravel',
    ownerName: config.ownerName || '',
    now,
  });
  await store.backend.writeFile('顧客マスター.csv', customerCsv(model));
  await store.backend.writeFile('施術履歴.csv', historyCsv(model));
  await store.backend.writeFile('data.json', dataJson(model));
  await store.backend.writeFile('README.txt', readmeText(model.salonName));
  await store.backend.writeFile('カルテ_スマホ表示.html', buildMobileViewHtml(model));
  const carteCount = model.customers.reduce((n, c) => n + c.施術履歴.length, 0);
  return { customers: model.customers.length, cartes: carteCount };
}

function jstNowIsoLocal() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, '+09:00');
}
