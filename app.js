// 新連載作成アシスタント Ver.1 メインロジック

const state = {
  record: null,      // kintone
  pub: null,         // 出版実績
  sheetRows: null,   // [B, C] の配列
  authors: [],       // { name, kana, intro, sns: {x,instagram,facebook}, links: [] }
};

const $ = (id) => document.getElementById(id);

// ============================================================
// 共通ユーティリティ
// ============================================================

const pad = (n) => String(n).padStart(2, '0');

// 改行→<br> 変換（最終行の末尾には付けない）仕様書 5-4
function textToBr(text) {
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map((l, i) => (i < lines.length - 1 ? l + '<br>' : l)).join('\n');
}

// kintoneのDATETIME値 → 日本時間の {y,m,d,hh,mm}
function parseKintoneDatetime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  const p = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return { y: +get('year'), m: +get('month'), d: +get('day'), hh: get('hour'), mm: get('minute') };
}

function fmtDelivery(v) {
  const t = parseKintoneDatetime(v);
  return t ? `${t.y}/${pad(t.m)}/${pad(t.d)} ${t.hh}:${t.mm}` : '';
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('コピーしました');
  } catch {
    showToast('コピーに失敗しました');
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button.copy');
  if (!btn) return;
  if (btn.dataset.copyText != null) return copyText(btn.dataset.copyText);
  if (btn.dataset.copyTarget) {
    const el = $(btn.dataset.copyTarget);
    return copyText(el.value ?? el.textContent ?? '');
  }
});

// ============================================================
// タブ切り替え
// ============================================================

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === btn.dataset.tab));
});

// ============================================================
// 情報取得
// ============================================================

$('fetch-btn').addEventListener('click', fetchInfo);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchInfo(); });

async function fetchInfo() {
  const code = $('code-input').value.trim();
  const status = $('fetch-status');
  if (!code) { status.textContent = 'カテゴリコードを入力してください'; status.classList.add('error'); return; }

  status.classList.remove('error');
  status.textContent = '取得中…';
  $('fetch-btn').disabled = true;

  try {
    const r = await fetch(`/api/fetch-info?code=${encodeURIComponent(code)}`);
    const data = await r.json();

    state.record = data.kintone.status === 'ok' ? data.kintone.data : null;
    state.pub = data.publication.status === 'ok' ? data.publication.data : null;
    state.sheetRows = data.sheet.status === 'ok' ? data.sheet.rows : null;

    if (data.kintone.status !== 'ok') {
      status.textContent = `kintone：${data.kintone.message}（手入力で作業できます）`;
      status.classList.add('error');
    } else {
      status.textContent = '取得しました';
    }

    renderAll(data);
  } catch (e) {
    status.textContent = '通信エラーが発生しました';
    status.classList.add('error');
  } finally {
    $('fetch-btn').disabled = false;
  }
}

function renderAll(data) {
  renderBasicInfo(data);
  renderQuickLinks(data);
  buildAuthorsFromPub();
  renderAuthorCards();
  renderBookFields();
  renderCategoryTab();
  renderSummaryTab();
  renderTemplateTab();
}

// ============================================================
// 確認用リンク
// ============================================================

function setQuickLink(id, url) {
  const el = $(id);
  if (!el) return;

  const value = String(url || '').trim();

  if (value) {
    el.href = value;
    el.classList.remove('disabled');
    el.setAttribute('aria-disabled', 'false');
    el.removeAttribute('title');
  } else {
    el.href = '#';
    el.classList.add('disabled');
    el.setAttribute('aria-disabled', 'true');
    el.title = 'リンク先URLが未設定です';
  }
}

function renderQuickLinks(data) {
  const links = data.links || {};

  setQuickLink('link-kintone', links.kintone);
  setQuickLink('link-publication', links.publication);
  setQuickLink('link-article-sheet', links.articleSheet);
  setQuickLink('link-mediaweaver', links.mediaweaver);
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a.quick-link.disabled');
  if (!link) return;

  e.preventDefault();
  showToast('このリンクはまだ設定されていません');
});

// ============================================================
// 上部基本情報
// ============================================================

function renderBasicInfo(data) {
  const rec = state.record || {};
  $('basic-info').hidden = false;
  $('info-title').textContent = rec.bookTitle || '（書籍タイトル未取得）';
  $('info-category').textContent = rec.categoryId || $('code-input').value.trim();
  $('info-prodno').textContent = rec.productionNo || '—';
  $('info-delivery').textContent = fmtDelivery(rec.firstDelivery) || '—';

  const setBadge = (id, ok, message) => {
    const el = $(id);
    el.textContent = ok ? '取得済み' : `取得できませんでした（${message || '原因不明'}）`;
    el.className = ok ? 'ok' : 'ng';
  };
  setBadge('info-pub-status', data.publication.status === 'ok', data.publication.message);
  setBadge('info-sheet-status', data.sheet.status === 'ok', data.sheet.message);

  // 解析デバッグ：出版実績ページから抽出したテキストを表示
  if (state.pub?.rawText) {
    $('debug-wrap').hidden = false;
    $('debug-text').value = state.pub.rawText;
  } else {
    $('debug-wrap').hidden = true;
  }
}

// ============================================================
// ① 著者登録
// ============================================================

// ■著者紹介ブロックから著者を分割（名前行＝「名前（かな）」形式を区切りとみなす）
function buildAuthorsFromPub() {
  state.authors = [];
  const block = state.pub?.authorBlock || '';
  const lines = block.replace(/\r\n?/g, '\n').split('\n');

  const isNameLine = (l) => /^[^\s].{0,50}（[^）]+）\s*$/.test(l.trim()) && l.trim().length <= 60;

  let current = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (isNameLine(line) || (current === null && line.trim() !== '')) {
      if (current) state.authors.push(current);
      const m = line.trim().match(/^(.*?)（([^）]+)）\s*$/);
      current = {
        name: m ? m[1].trim() : line.trim(),
        kana: m ? m[2].trim() : '',
        intro: [],
        sns: { x: { on: false, url: '' }, instagram: { on: false, url: '' }, facebook: { on: false, url: '' } },
        links: [],
      };
    } else if (current) {
      current.intro.push(raw);
    }
  }
  if (current) state.authors.push(current);
  state.authors.forEach((a) => { a.intro = a.intro.join('\n').trim(); });

  if (state.authors.length === 0) state.authors.push(emptyAuthor());
}

function emptyAuthor() {
  return {
    name: '', kana: '', intro: '',
    sns: { x: { on: false, url: '' }, instagram: { on: false, url: '' }, facebook: { on: false, url: '' } },
    links: [],
  };
}

const SNS_DEFS = [
  { key: 'x', label: 'X（旧Twitter）', htmlName: 'X(旧Twitter)' },
  { key: 'instagram', label: 'Instagram', htmlName: 'Instagram' },
  { key: 'facebook', label: 'Facebook', htmlName: 'Facebook' },
];

$('add-author').addEventListener('click', () => {
  state.authors.push(emptyAuthor());
  renderAuthorCards();
});

function renderAuthorCards() {
  const wrap = $('author-cards');
  wrap.innerHTML = '';
  state.authors.forEach((a, idx) => wrap.appendChild(authorCard(a, idx)));
}

function authorCard(a, idx) {
  const card = document.createElement('div');
  card.className = 'author-card';
  card.innerHTML = `
    <div class="card-head">
      <h3>著者${state.authors.length > 1 ? idx + 1 : ''}</h3>
      ${state.authors.length > 1 ? '<button class="remove">削除</button>' : ''}
    </div>
    <div class="author-grid">
      <label>著者名<input type="text" class="a-name"></label>
      <label>著者名かな<input type="text" class="a-kana"></label>
    </div>
    <div class="btn-row">
      <button class="copy mini a-copy-name">著者名をコピー</button>
      <button class="copy mini a-copy-kana">かなをコピー</button>
    </div>

    <label class="block-label">著者紹介（原文・編集可）</label>
    <textarea class="a-intro" rows="6"></textarea>

    <div class="sns-block">
      <label class="block-label">関連リンク</label>
      <div class="sns-rows"></div>
      <div class="other-links"></div>
      <div class="btn-row"><button class="ghost add-link">＋ その他のリンクを追加</button></div>
    </div>

    <div class="output-block">
      <label class="block-label">MediaWeaver貼り付け用（著者紹介＋関連リンク）</label>
      <textarea class="a-output" rows="7" readonly></textarea>
      <div class="btn-row"><button class="copy a-copy-output">貼り付け用HTMLをコピー</button></div>
    </div>
  `;

  const q = (sel) => card.querySelector(sel);
  q('.a-name').value = a.name;
  q('.a-kana').value = a.kana;
  q('.a-intro').value = a.intro;

  q('.a-name').addEventListener('input', (e) => { a.name = e.target.value; syncAuthorDependents(); });
  q('.a-kana').addEventListener('input', (e) => { a.kana = e.target.value; });
  q('.a-intro').addEventListener('input', (e) => { a.intro = e.target.value; updateOutput(); });
  q('.a-copy-name').addEventListener('click', () => copyText(a.name));
  q('.a-copy-kana').addEventListener('click', () => copyText(a.kana));
  q('.a-copy-output').addEventListener('click', () => copyText(q('.a-output').value));
  if (q('.remove')) q('.remove').addEventListener('click', () => {
    state.authors.splice(idx, 1);
    renderAuthorCards();
    syncAuthorDependents();
  });

  // 固定SNS 3種
  const snsRows = q('.sns-rows');
  SNS_DEFS.forEach((def) => {
    const row = document.createElement('div');
    row.className = 'sns-row';
    row.innerHTML = `
      <span class="sns-name">${def.label}</span>
      <label class="switch"><input type="checkbox"> ON</label>
      <input type="text" placeholder="https://" hidden>
    `;
    const cb = row.querySelector('input[type="checkbox"]');
    const urlInput = row.querySelector('input[type="text"]');
    cb.checked = a.sns[def.key].on;
    urlInput.value = a.sns[def.key].url;
    urlInput.hidden = !a.sns[def.key].on;
    cb.addEventListener('change', () => {
      a.sns[def.key].on = cb.checked;
      urlInput.hidden = !cb.checked;
      updateOutput();
    });
    urlInput.addEventListener('input', () => { a.sns[def.key].url = urlInput.value; updateOutput(); });
    snsRows.appendChild(row);
  });

  // その他リンク
  const otherWrap = q('.other-links');
  function renderOtherLinks() {
    otherWrap.innerHTML = '';
    a.links.forEach((lk, li) => {
      const row = document.createElement('div');
      row.className = 'link-row';
      row.innerHTML = `
        <label>リンク名<input type="text" class="lk-name" placeholder="公式サイト"></label>
        <label>URL<input type="text" class="lk-url" placeholder="https://example.com"></label>
        <button class="remove-link">削除</button>
      `;
      row.querySelector('.lk-name').value = lk.name;
      row.querySelector('.lk-url').value = lk.url;
      row.querySelector('.lk-name').addEventListener('input', (e) => { lk.name = e.target.value; updateOutput(); });
      row.querySelector('.lk-url').addEventListener('input', (e) => { lk.url = e.target.value; updateOutput(); });
      row.querySelector('.remove-link').addEventListener('click', () => {
        a.links.splice(li, 1);
        renderOtherLinks();
        updateOutput();
      });
      otherWrap.appendChild(row);
    });
  }
  q('.add-link').addEventListener('click', () => {
    a.links.push({ name: '', url: '' });
    renderOtherLinks();
  });
  renderOtherLinks();

  // 貼り付け用HTML生成（仕様書 6-3 / 6-4）
  function updateOutput() {
    q('.a-output').value = buildAuthorHtml(a);
  }
  updateOutput();

  return card;
}

function buildAuthorHtml(a) {
  const links = [];
  SNS_DEFS.forEach((def) => {
    const s = a.sns[def.key];
    if (s.on && s.url.trim()) links.push({ name: def.htmlName, url: s.url.trim() });
  });
  a.links.forEach((lk) => {
    if (lk.name.trim() && lk.url.trim()) links.push({ name: lk.name.trim(), url: lk.url.trim() });
  });

  let intro = textToBr(a.intro);

  if (links.length === 0) return intro;

  const linkHtml = links
    .map((lk) => `${lk.name}<br>\n<a href="${lk.url}" target="_blank"><span style="color:#0000CD;">${lk.url}</span></a>`)
    .join('<br>\n');

  const introPart = intro ? intro + '<br>\n' : '';
  return `${introPart}▼関連リンク<br>\n${linkHtml}`;
}

// 著者名に依存するタブ（書籍・サマリー）を更新
function syncAuthorDependents() {
  renderBookFields();
  updateSummaryFinal();
}

// ============================================================
// ② 書籍登録
// ============================================================

const BOOK_FIELD_DEFS = [
  { key: 'author', label: '著者', calc: () => joinedAuthorNames().replace(/ /g, '') },
  { key: 'dispAuthor', label: '表示用著者名', calc: () => joinedAuthorNames() },
  { key: 'intro', label: '紹介文', textarea: true, calc: () => textToBr(state.pub?.intro || '') },
  { key: 'isbn', label: 'ISBN', calc: () => state.pub?.isbn || '' },
  { key: 'format', label: '判型', calc: () => splitFormat().format },
  { key: 'pages', label: 'ページ数', calc: () => splitFormat().pages },
  { key: 'release', label: '発売日', calc: () => releaseDate() },
  { key: 'publish', label: '公開日時', calc: () => fmtDelivery(state.record?.firstDelivery) },
];

function joinedAuthorNames() {
  return state.authors.map((a) => a.name.trim()).filter(Boolean).join('／');
}

// 「4-6・144ページ」→ 判型 / ページ数（仕様書 7-6）
function splitFormat() {
  const raw = (state.pub?.format || '').trim();
  if (!raw) return { format: '', pages: '' };
  const m = raw.match(/^(.*?)[・･]\s*([0-9,]+)\s*ページ/);
  if (m) return { format: m[1].trim(), pages: m[2].replace(/,/g, '') };
  const p = raw.match(/([0-9,]+)\s*ページ/);
  return { format: raw.replace(/[・･]?\s*[0-9,]+\s*ページ.*$/, '').trim(), pages: p ? p[1].replace(/,/g, '') : '' };
}

// 出版年月日 → yyyy/mm/dd 05:00（仕様書 7-7）
function releaseDate() {
  const raw = (state.pub?.pubDate || '').trim();
  const m = raw.match(/([0-9]{4})[\/年]([0-9]{1,2})[\/月]([0-9]{1,2})/);
  if (!m) return '';
  return `${m[1]}/${pad(+m[2])}/${pad(+m[3])} 05:00`;
}

function renderBookFields() {
  const wrap = $('book-fields');
  wrap.innerHTML = '';
  BOOK_FIELD_DEFS.forEach((def) => {
    const row = document.createElement('div');
    row.className = 'field';
    const inputId = `bf-${def.key}`;
    row.innerHTML = `
      <div class="fname">${def.label}</div>
      <div>${def.textarea
        ? `<textarea id="${inputId}" rows="5"></textarea>`
        : `<input type="text" id="${inputId}">`}</div>
      <div><button class="copy" data-copy-target="${inputId}">コピー</button></div>
    `;
    wrap.appendChild(row);
    $(inputId).value = def.calc() || '';
    if (!$(inputId).value) $(inputId).placeholder = '取得できませんでした';
  });
}

// ============================================================
// ③ カテゴリ
// ============================================================

function renderCategoryTab() {
  $('catch-copy').value = (state.pub?.catchCopy || '').trim();
}

// ============================================================
// ④ サマリー作成
// ============================================================

const SOURCE_TEMPLATES = {
  book: (a, t) => `※本記事は、${a}氏の書籍『${t}』（幻冬舎ルネッサンス）より、一部抜粋・編集したものです。`,
  novel: (a, t) => `※本記事は、${a}氏の小説『${t}』（幻冬舎ルネッサンス）より、一部抜粋・編集したものです。`,
  'gr-contest': (a, t, c, p) => `※本記事は、${a}氏の「${c}」${p}賞作品（幻冬舎ルネッサンス主催）『${t}』より、一部抜粋・編集したものです。`,
  'glo-contest': (a, t, c, p) => `※本記事は、${a}氏の「${c}」${p}賞作品（GLO主催）『${t}』より、一部抜粋・編集したものです。`,
  original: (a, t) => `※本記事は、${a}氏の書き下ろし小説『${t}』より、一部抜粋・編集したものです。`,
};

function renderSummaryTab() {
  $('summary-body').value = (state.pub?.intro || '').trim();
  updateSummaryFinal();
}

function currentSourceType() {
  return document.querySelector('input[name="source-type"]:checked')?.value || 'book';
}

function updateSummaryFinal() {
  const type = currentSourceType();
  $('contest-fields').hidden = !(type === 'gr-contest' || type === 'glo-contest');

  const body = $('summary-body').value.trim();
  const authors = joinedAuthorNames().replace(/ /g, '');
  const title = state.record?.bookTitle || '';
  const contest = $('contest-name').value.trim();
  const prize = $('contest-prize').value.trim();

  const source = SOURCE_TEMPLATES[type](authors, title, contest, prize);
  const final = body ? `${body}${source}` : source;

  $('summary-final').value = final;
  $('count-body').textContent = body.length;
  $('count-final').textContent = final.length;
}

['summary-body', 'contest-name', 'contest-prize'].forEach((id) => {
  $(id).addEventListener('input', updateSummaryFinal);
});
document.querySelectorAll('input[name="source-type"]').forEach((r) => {
  r.addEventListener('change', updateSummaryFinal);
});

// ============================================================
// ⑤ 本文テンプレート
// ============================================================

// B列の期間文字列（例「8/23（日）～8/29（土）」）を日付範囲に変換
function parsePeriod(text, baseYear, deliveryMonth) {
  const nums = [...String(text).matchAll(/(\d{1,2})\/(\d{1,2})/g)];
  if (nums.length < 2) return null;
  let [sm, sd] = [+nums[0][1], +nums[0][2]];
  let [em, ed] = [+nums[1][1], +nums[1][2]];

  let sy = baseYear, ey = baseYear;
  // 年またぎ補正（12月末～1月初など）
  if (em < sm) ey = sy + 1;
  if (deliveryMonth === 1 && sm === 12) { sy = baseYear - 1; ey = baseYear; }
  if (deliveryMonth === 12 && sm === 1) { sy = baseYear + 1; ey = baseYear + 1; }

  return {
    start: new Date(sy, sm - 1, sd),
    end: new Date(ey, em - 1, ed),
    label: String(text).trim(),
  };
}

// 最終行から上方向へ検索し、最初に一致した行を採用（仕様書 10-3）
function findSheetRow() {
  const t = parseKintoneDatetime(state.record?.firstDelivery);
  if (!t || !state.sheetRows) return null;
  const target = new Date(t.y, t.m - 1, t.d);

  for (let i = state.sheetRows.length - 1; i >= 0; i--) {
    const row = state.sheetRows[i];
    const period = parsePeriod(row?.[0] || '', t.y, t.m);
    if (!period) continue;
    if (target >= period.start && target <= period.end) {
      return { period, html: row?.[1] || '' };
    }
  }
  return null;
}

function buildTemplateHtml(cHtml) {
  const head = '<p>あ</p>\n\n<p>あ</p>\n\n<p>あ</p>\n\n';

  let c = String(cHtml || '');

  // カテゴリコード
  const categoryCode = String(
    state.record?.categoryId ||
    $('code-input').value.trim() ||
    ''
  ).trim();

  // 書籍タイトル
  let bookTitle = String(state.record?.bookTitle || '').trim();

  // タイトル自体に『』が付いている場合は外す
  // テンプレート側に『』があるため二重化を防ぐ
  const titleMatch = bookTitle.match(/^『(.*)』$/);
  if (titleMatch) bookTitle = titleMatch[1];

  // カテゴリコード置換
  if (categoryCode) {
    c = c.split('grxxxx').join(categoryCode);
    c = c.split('gr●●●●').join(categoryCode);
  }

  // 書籍タイトル置換
  if (bookTitle) {
    c = c.split('xxxxxxxx').join(bookTitle);
    c = c.split('●●●●●●●●').join(bookTitle);
  }

  return head + c;
}
function renderTemplateTab() {
  $('tpl-delivery').textContent = fmtDelivery(state.record?.firstDelivery) || '—';

  const hit = findSheetRow();
  if (hit && hit.html) {
    $('tpl-period').textContent = hit.period.label;
    $('tpl-c-status').textContent = '成功';
    $('tpl-manual-wrap').hidden = true;
    $('tpl-output').value = buildTemplateHtml(hit.html);
  } else {
    $('tpl-period').textContent = '該当期間が見つかりません';
    $('tpl-c-status').textContent = state.sheetRows ? '該当行なし' : '取得できませんでした';
    $('tpl-manual-wrap').hidden = false;
    $('tpl-output').value = buildTemplateHtml($('tpl-manual').value);
  }
}

$('tpl-manual').addEventListener('input', () => {
  $('tpl-output').value = buildTemplateHtml($('tpl-manual').value);
});