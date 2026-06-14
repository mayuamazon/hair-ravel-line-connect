// スマホ向けカルテ閲覧ビュー生成（引き継ぎ仕様 §5 の見た目・操作を踏襲）
// 【§6 本番方式】写真は base64 全埋め込みをやめ、thumbs/ への相対パス参照にする。
// データ（テキスト）はHTMLに埋め込む（写真バイトは含めない）＝顧客数百名でも軽量。
// 拡大時のみ原本 写真/ を相対参照。

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 閲覧ビュー用の軽量データ（写真は相対パスのみ。バイトを持たない）
function viewData(model) {
  const customers = model.customers.map(c => {
    const visits = c.施術履歴.slice().sort((a, b) => String(b.来店日).localeCompare(String(a.来店日)));
    return {
      name: c.名前, kana: c.ふりがな, allergy: c.アレルギー注意,
      tel: c.電話番号, memo: c.担当者メモ, since: c.初回来店日,
      last: visits[0] ? visits[0].来店日 : c.初回来店日,
      count: visits.length,
      visits: visits.map(v => ({
        date: v.来店日, staff: v.担当者, menu: v.メニュー,
        agent: v.薬剤履歴, color: v.カラー履歴, memo: v.メモ, price: v.金額,
        photos: (v._photos || []).slice()
          .sort((a, b) => (a.type === b.type ? (a.seq - b.seq) : (a.type === 'before' ? -1 : 1)))
          .map(p => ({
            type: p.type === 'before' ? 'before' : 'after',
            thumb: `thumbs/${v._folder}/${p.name}`,   // 相対参照（base64にしない）
            full: `写真/${v._folder}/${p.name}`,
          })),
      })),
    };
  });
  return { salon: model.salonName, customers };
}

export function buildMobileViewHtml(model) {
  const DATA_JSON = JSON.stringify(viewData(model));
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(model.salonName)} カルテ</title>
<style>
  :root{
    --paper:#FBFAFC; --card:#FFFFFF; --ink:#272231; --muted:#7A7488;
    --line:#ECE8F1; --plum:#6B4A86; --plum-soft:#F3EDF8;
    --alert:#BE2F49; --alert-soft:#FBE9ED; --ok:#3E7A5E;
    --r:16px; --shadow:0 1px 3px rgba(39,34,49,.06),0 6px 20px rgba(39,34,49,.05);
  }
  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent}
  html,body{margin:0}
  body{
    background:var(--paper); color:var(--ink);
    font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,system-ui,sans-serif;
    font-size:16px; line-height:1.6; -webkit-text-size-adjust:100%;
    padding-bottom:env(safe-area-inset-bottom);
  }
  .wrap{max-width:520px; margin:0 auto; padding:0 14px 48px}
  header{position:sticky; top:0; z-index:20; background:rgba(251,250,252,.86);
    backdrop-filter:saturate(1.2) blur(10px); margin:0 -14px; padding:14px 16px 12px; border-bottom:1px solid var(--line)}
  .brand{display:flex; align-items:baseline; gap:8px}
  .brand h1{font-size:18px; font-weight:700; letter-spacing:.04em; margin:0}
  .brand .tag{font-size:11px; color:var(--plum); font-weight:700; letter-spacing:.14em}
  .count{font-size:12px; color:var(--muted); margin:2px 0 12px}
  .search{position:relative}
  .search input{width:100%; border:1.5px solid var(--line); background:#fff; border-radius:12px;
    padding:13px 14px 13px 42px; font-size:16px; color:var(--ink); outline:none; transition:border-color .15s}
  .search input:focus{border-color:var(--plum)}
  .search svg{position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--muted)}
  .card{background:var(--card); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); margin-top:12px; overflow:hidden}
  .head{width:100%; text-align:left; border:0; background:transparent; cursor:pointer; display:flex; align-items:center; gap:12px; padding:16px; min-height:64px}
  .nm{flex:1; min-width:0}
  .nm .n{font-size:20px; font-weight:700; letter-spacing:.01em; line-height:1.25}
  .nm .k{font-size:12px; color:var(--muted); letter-spacing:.12em; margin-top:1px}
  .meta{display:flex; gap:6px; align-items:center; margin-top:7px; flex-wrap:wrap}
  .pill{font-size:11px; font-weight:600; color:var(--muted); background:#F4F2F7; border-radius:999px; padding:3px 9px; white-space:nowrap}
  .allergy{color:#fff; background:var(--alert); font-weight:700; letter-spacing:.02em}
  .chev{color:var(--muted); flex:none; transition:transform .2s}
  .card.open .chev{transform:rotate(180deg)}
  .body{display:none; padding:0 16px 8px; border-top:1px solid var(--line)}
  .card.open .body{display:block; animation:fade .2s ease}
  @keyframes fade{from{opacity:0; transform:translateY(-3px)}to{opacity:1;transform:none}}
  .ownerline{display:flex; gap:14px; flex-wrap:wrap; padding:13px 0 4px}
  .ownerline .it{font-size:13px; color:var(--muted)}
  .ownerline .it b{color:var(--ink); font-weight:600}
  .allergy-banner{display:flex; gap:9px; align-items:center; background:var(--alert-soft); color:var(--alert);
    border-radius:12px; padding:11px 13px; margin:10px 0 4px; font-size:14px; font-weight:700}
  .ownernote{font-size:14px; background:var(--plum-soft); color:#4a3a58; border-radius:12px; padding:11px 13px; margin:10px 0 2px}
  .ownernote span{font-size:11px; font-weight:700; color:var(--plum); letter-spacing:.1em; display:block; margin-bottom:2px}
  .visits{margin:14px 0 6px}
  .vh{display:flex; align-items:baseline; justify-content:space-between; margin:18px 0 9px}
  .vh .d{font-size:16px; font-weight:700}
  .vh .s{font-size:12px; color:var(--muted)}
  .visit{border-left:2px solid var(--plum-soft); padding-left:13px; position:relative}
  .visit:before{content:""; position:absolute; left:-5px; top:6px; width:8px; height:8px; border-radius:50%; background:var(--plum)}
  .menu{display:inline-block; font-size:13px; font-weight:700; color:var(--plum); background:var(--plum-soft); border-radius:8px; padding:3px 9px; margin-bottom:8px}
  .row{display:grid; grid-template-columns:54px 1fr; gap:8px; font-size:13.5px; margin:5px 0}
  .row .lab{color:var(--muted); font-weight:600; font-size:12px; padding-top:1px}
  .row .val{color:var(--ink); word-break:break-word}
  .row.memo .val{color:#4a4453}
  .photos{display:flex; gap:8px; margin:11px 0 4px; flex-wrap:wrap}
  .ph{position:relative; width:calc(50% - 4px); border-radius:12px; overflow:hidden; border:1px solid var(--line); background:#f0eef3; cursor:zoom-in}
  .ph img{display:block; width:100%; height:120px; object-fit:cover}
  .ph .lbl{position:absolute; left:6px; top:6px; font-size:10px; font-weight:800; letter-spacing:.08em; color:#fff; padding:3px 7px; border-radius:7px}
  .lbl.before{background:rgba(40,40,60,.82)}
  .lbl.after{background:rgba(107,74,134,.9)}
  .empty{text-align:center; color:var(--muted); font-size:14px; padding:48px 0}
  .lb{position:fixed; inset:0; background:rgba(20,17,26,.92); z-index:50; display:none; align-items:center; justify-content:center; padding:16px}
  .lb.on{display:flex}
  .lb img{max-width:100%; max-height:88vh; border-radius:10px}
  .lb .x{position:absolute; top:14px; right:16px; color:#fff; font-size:30px; background:none; border:0; line-height:1}
  :focus-visible{outline:2px solid var(--plum); outline-offset:2px}
  @media (prefers-reduced-motion:reduce){*{animation:none !important; transition:none !important}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><h1 id="salon"></h1><span class="tag">カルテ</span></div>
    <div class="count" id="count"></div>
    <div class="search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
      <input id="q" type="search" inputmode="search" placeholder="お名前・ふりがなで探す" autocomplete="off">
    </div>
  </header>
  <main id="list"></main>
  <p class="empty" id="empty" style="display:none">該当するお客様が見つかりません</p>
</div>
<div class="lb" id="lb"><button class="x" aria-label="閉じる">&times;</button><img id="lbimg" alt=""></div>
<script>
const DB = ${DATA_JSON};
document.getElementById('salon').textContent = DB.salon;
document.getElementById('count').textContent = 'お客様 ' + DB.customers.length + '名';
const esc = s => (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const yen = n => (n||n===0) ? '¥'+Number(n).toLocaleString('ja-JP') : '';
function visitHTML(v){
  let rows = '';
  if(v.agent) rows += '<div class="row"><div class="lab">薬剤</div><div class="val">'+esc(v.agent)+'</div></div>';
  if(v.color) rows += '<div class="row"><div class="lab">カラー</div><div class="val">'+esc(v.color)+'</div></div>';
  if(v.memo)  rows += '<div class="row memo"><div class="lab">メモ</div><div class="val">'+esc(v.memo)+'</div></div>';
  let photos = '';
  if(v.photos && v.photos.length){
    photos = '<div class="photos">' + v.photos.map(p=>
      '<div class="ph" data-full="'+esc(p.full)+'"><span class="lbl '+p.type+'">'+(p.type==='before'?'BEFORE':'AFTER')+'</span><img loading="lazy" src="'+esc(p.thumb)+'" alt=""></div>'
    ).join('') + '</div>';
  }
  return '<div class="visit"><div class="vh"><span class="d">'+esc(v.date)+'</span><span class="s">'+esc(v.staff)+(v.price?'　'+yen(v.price):'')+'</span></div>'
    + '<span class="menu">'+esc(v.menu)+'</span>'+rows+photos+'</div>';
}
function cardHTML(c){
  const allergyPill = c.allergy ? '<span class="pill allergy">⚠ '+esc(c.allergy)+'</span>' : '';
  const banner = c.allergy ? '<div class="allergy-banner"><span>⚠</span><span>アレルギー注意：'+esc(c.allergy)+'</span></div>' : '';
  const note = c.memo ? '<div class="ownernote"><span>担当者メモ</span>'+esc(c.memo)+'</div>' : '';
  const visits = c.visits.length ? c.visits.map(visitHTML).join('') : '<p style="color:var(--muted);font-size:14px;padding:8px 0">来店履歴はまだありません</p>';
  return '<div class="card" data-key="'+esc(c.name)+' '+esc(c.kana)+'">'
    + '<button class="head" aria-expanded="false"><div class="nm"><div class="n">'+esc(c.name)+'</div><div class="k">'+esc(c.kana)+'</div>'
    + '<div class="meta">'+allergyPill+'<span class="pill">最終 '+esc(c.last)+'</span><span class="pill">来店 '+c.count+'回</span></div></div>'
    + '<svg class="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></button>'
    + '<div class="body">'+banner+'<div class="ownerline"><span class="it">☎ <b>'+esc(c.tel)+'</b></span><span class="it">初回 <b>'+esc(c.since)+'</b></span></div>'+note
    + '<div class="visits">'+visits+'</div></div></div>';
}
const list = document.getElementById('list');
list.innerHTML = DB.customers.map(cardHTML).join('');
list.addEventListener('click', e=>{
  const head = e.target.closest('.head');
  if(head){ const card = head.closest('.card'); const open = card.classList.toggle('open'); head.setAttribute('aria-expanded', open); return; }
  const ph = e.target.closest('.ph');
  if(ph){ openLB(ph.dataset.full); }
});
const q = document.getElementById('q'), empty = document.getElementById('empty');
q.addEventListener('input', ()=>{
  const t = q.value.trim().toLowerCase(); let shown=0;
  document.querySelectorAll('.card').forEach(card=>{
    const hit = card.dataset.key.toLowerCase().includes(t);
    card.style.display = hit ? '' : 'none'; if(hit) shown++;
  });
  empty.style.display = shown? 'none':'block';
});
const lb=document.getElementById('lb'), lbimg=document.getElementById('lbimg');
function openLB(src){ lbimg.src=src; lb.classList.add('on'); }
lb.addEventListener('click', ()=>{ lb.classList.remove('on'); lbimg.src=''; });
</script>
</body>
</html>
`;
}
