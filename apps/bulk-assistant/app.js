/* ============================================================
   新規一括集中アシスタント Ver.0.2

   新規の一括集中連載をMediaWeaverで作るときの作業支援ツール。
   再掲連載作成アシスタント（apps/reprint-assistant）をもとにしているが、
   新規連載なので参照元の過去連載は無い。

   ・今回の記事IDとタイトルは画面で手入力する（MWで採番したものを貼る）
   ・kintone／スプレッドシートへは直接アクセスしない。/api/bulk-data のみ
   ・APIトークン・GASのURLはこのファイルに一切置かない
   ============================================================ */

const API_ENDPOINT = '/api/bulk-data';

// 作る回数の範囲。
// 1回だけ（最終回のみ）もありうるので下限は1。
// 上限は打ち間違いで数百行を作ってしまわないための歯止め
const MIN_EPISODE_COUNT = 1;
const MAX_EPISODE_COUNT = 200;

// 開いてすぐ入力できるように、最初から行を作っておく。
// 参照元から回数が決まる再掲側と違い、こちらは自分で決めるしかない
const DEFAULT_EPISODE_COUNT = 8;

// ------------------------------------------------------------
// 状態
// ------------------------------------------------------------

const state = {
  // GLO連載情報アプリの1レコード（今回作る一括集中連載）
  series: null,

  // 実際に作る回数
  episodeCount: 0,

  // 回数を減らして消えた行の入力を覚えておく。
  // 回数を戻したときに入力し直さずに済むようにする（回数 → 値）
  idStash: new Map(),
  titleStash: new Map(),
  copiedStash: new Map(),

  // 作業行。回数ぶん作る
  // { number, label, isFinal, articleId, articleTitle, copiedHtml, el }
  rows: [],

  // スプレッドシート「毎月の記事下リンク」。rows は [B列, C列] の配列
  sheetRows: null,
  sheetStatus: 'error',
  sheetMessage: '',

  // 使う週（sheetRows のインデックス）。
  // 一括集中の公開日の扱いが未確定なので、日付から自動判定せず画面で選ぶ
  weekIndex: -1,

  // ②のコピーボタン。コピー済み表示を1件だけにするために持つ
  copyButtons: [],

  // ①の入力は②の「続きを読む」に効く。
  // ②を開いていないときは作り直さず、開いたときにまとめて描き直す
  bottomDirty: true,

  activeTab: 'prev',
};

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------

const el = {
  codeInput: document.getElementById('code-input'),
  fetchBtn: document.getElementById('fetch-btn'),
  fetchStatus: document.getElementById('fetch-status'),

  warnings: document.getElementById('warnings'),
  warningsList: document.getElementById('warnings-list'),

  sectionCommon: document.getElementById('section-common'),
  seriesTitle: document.getElementById('series-title'),
  seriesCode: document.getElementById('series-code'),
  seriesProdNo: document.getElementById('series-prodno'),
  sheetStatus: document.getElementById('sheet-status'),
  kintoneLink: document.getElementById('kintone-link'),

  sectionTabs: document.getElementById('section-tabs'),
  tabButtons: Array.from(document.querySelectorAll('.tab')),
  panelPrev: document.getElementById('panel-prev'),
  panelBottom: document.getElementById('panel-bottom'),

  bulkInput: document.getElementById('bulk-input'),
  bulkApply: document.getElementById('bulk-apply'),
  bulkClear: document.getElementById('bulk-clear'),
  bulkStatus: document.getElementById('bulk-status'),

  prevCount: document.getElementById('prev-count'),
  prevCountMinus: document.getElementById('prev-count-minus'),
  prevCountPlus: document.getElementById('prev-count-plus'),
  prevBody: document.getElementById('prev-body'),

  weekSelect: document.getElementById('week-select'),
  weekStatus: document.getElementById('week-status'),
  bottomBody: document.getElementById('bottom-body'),

  toast: document.getElementById('toast'),
};

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------

el.fetchBtn.addEventListener('click', () => {
  fetchSeriesData();
});

// 入力できるのは半角数字だけ。
// 全角数字と、貼り付けで付いてくる gr は黙って直し、
// それ以外の文字が混ざっていたときだけ理由を出す
el.codeInput.addEventListener('input', () => {
  const raw = el.codeInput.value;
  const digits = toCategoryDigits(raw);

  if (digits !== raw) {
    el.codeInput.value = digits;

    if (hasUnusableCodeChars(raw)) {
      setStatus('カテゴリコードは半角数字で入力してください（grは不要）', true);
      return;
    }
  }

  if (el.fetchStatus.classList.contains('error')) setStatus('');
});

el.codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    fetchSeriesData();
  }
});

el.tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    switchTab(button.dataset.tab);
  });

  // 左右キーでもタブを移動できるようにする
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    stepTab(event.key === 'ArrowRight' ? 1 : -1);

    const next = el.tabButtons.find(
      (tab) => tab.dataset.tab === state.activeTab
    );

    if (next) next.focus();
  });
});

// ---- 回数 ----

el.prevCount.addEventListener('input', () => {
  const value = parseCountInput(el.prevCount.value);

  // 入力途中（空欄・全角のみ等）はまだ反映しない。
  // 数として読める値になった時点で行を作り直す
  if (!Number.isFinite(value) || value < MIN_EPISODE_COUNT) return;

  setEpisodeCount(value);
});

el.prevCount.addEventListener('change', () => commitPrevCount());
el.prevCount.addEventListener('blur', () => commitPrevCount());

el.prevCount.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    setEpisodeCount(state.episodeCount + (event.key === 'ArrowUp' ? 1 : -1));
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    commitPrevCount();
  }
});

el.prevCountMinus.addEventListener('click', () => {
  setEpisodeCount(state.episodeCount - 1);
});

el.prevCountPlus.addEventListener('click', () => {
  setEpisodeCount(state.episodeCount + 1);
});

// ---- 記事IDの一括貼り付け ----

el.bulkApply.addEventListener('click', () => {
  applyBulkIds();
});

el.bulkClear.addEventListener('click', () => {
  clearArticleIds();
});

// 記事ID・記事タイトルは行ごとに個別入力もできる。
// 入力した行の値は「次の行の前回記事」にだけ効くので、そこだけ更新する。
// （自分の行の前回記事欄・コピーボタンは1つ前の行の値で決まるため動かさない）
//
// ②の「この話の続きを読む」は逆に1つ前の行に効くので、
// そちらは行単位ではなく②全体を作り直す
el.prevBody.addEventListener('input', (event) => {
  const input = event.target.closest('input.id-input, input.title-input');

  if (!input) return;

  const index = Number(input.dataset.index);

  if (!Number.isInteger(index) || !state.rows[index]) return;

  const row = state.rows[index];

  if (input.classList.contains('id-input')) {
    row.articleId = input.value;
  } else {
    row.articleTitle = input.value;
    updateTitleCount(row);
  }

  updatePrevRow(index + 1);
  markBottomDirty();
});

// ---- 記事下リンクの週 ----

el.weekSelect.addEventListener('change', () => {
  const index = Number(el.weekSelect.value);

  state.weekIndex = Number.isInteger(index) ? index : -1;

  renderBottomTable();
});

// URLに ?code= が付いていれば初期表示で取得しておく。
// ?code=gr1974 でも ?code=1974 でも同じように受ける
(function initFromQuery() {
  const params = new URLSearchParams(location.search);
  const digits = toCategoryDigits(params.get('code'));

  if (digits) {
    el.codeInput.value = digits;
    fetchSeriesData();
  }
})();

// ------------------------------------------------------------
// カテゴリコード
// ------------------------------------------------------------

// 画面に出しているのは数字だけ。APIへ渡すときに gr を付け直す
function getCategoryCode() {
  const digits = toCategoryDigits(el.codeInput.value);

  return digits ? `gr${digits}` : '';
}

// 全角数字は半角に直し、先頭の gr と数字以外を落とす
function toCategoryDigits(value) {
  return String(value || '')
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0)
    )
    .replace(/^\s*[gG][rR]/, '')
    .replace(/[^0-9]/g, '');
}

// 直しようがない文字（英字・記号）が混ざっていたか。
// 全角数字と gr は自動で直すので、ここでは咎めない
function hasUnusableCodeChars(value) {
  return /[^0-9０-９\s]/.test(String(value || '').replace(/^\s*[gG][rR]/, ''));
}

// ------------------------------------------------------------
// API取得
// ------------------------------------------------------------

async function fetchSeriesData() {
  const code = getCategoryCode();

  if (!code) {
    setStatus('カテゴリコードの数字を入力してください', true);
    el.codeInput.focus();
    return;
  }

  el.fetchBtn.disabled = true;
  setStatus('取得中…');

  try {
    const response = await fetch(
      `${API_ENDPOINT}?code=${encodeURIComponent(code)}`,
      { cache: 'no-store' }
    );

    const json = await response.json().catch(() => null);

    if (!response.ok || !json) {
      const message =
        (json && (json.error || json.status)) ||
        `取得に失敗しました（HTTP ${response.status}）`;

      resetSeries();
      setStatus(message, true);
      return;
    }

    // スプレッドシートは kintone と独立して扱う。
    // 記事下だけ取れなくても、①前回記事タブは最後まで使えるようにする
    const sheet = json.sheet || {};

    state.sheetStatus = sheet.status === 'ok' ? 'ok' : 'error';
    state.sheetRows =
      sheet.status === 'ok' && Array.isArray(sheet.rows) ? sheet.rows : null;
    state.sheetMessage = String(sheet.message || '');

    renderWeekSelect();

    const series = json.series || {};

    if (series.status !== 'ok' || !series.data) {
      resetSeries();
      renderWarnings(json.warnings);
      setStatus(series.message || 'GLO連載情報を取得できませんでした', true);
      return;
    }

    // 別の連載に切り替えたときだけ入力を捨てる。
    // 先に回数と記事IDを入れてから取得する使い方があるので、
    // 初回の取得では入力を消さない
    const previousCode = state.series && state.series.categoryCode;
    const nextCode = series.data.categoryCode;

    if (previousCode && previousCode !== nextCode) {
      clearAllInputs();
    }

    state.series = series.data;

    renderWarnings(json.warnings);
    renderCommon();

    renderPrevTable();
    renderBottomTable();

    switchTab(state.activeTab);

    setStatus(`取得しました（${new Date().toLocaleTimeString('ja-JP')}）`);
  } catch (e) {
    resetSeries();
    setStatus(`通信エラー：${String(e.message || e)}`, true);
  } finally {
    el.fetchBtn.disabled = false;
  }
}

function setStatus(message, isError = false) {
  el.fetchStatus.textContent = message;
  el.fetchStatus.classList.toggle('error', Boolean(isError));
}

// 連載情報だけを捨てる。①タブの入力は消さない。
// カテゴリコードを取得できなくても①は使えるようにしておく
function resetSeries() {
  state.series = null;

  el.warnings.hidden = true;
  el.warningsList.textContent = '';

  el.sectionCommon.hidden = true;

  renderBottomTable();
}

// 別の連載に切り替えたときだけ呼ぶ。退避してある入力も消す
function clearAllInputs() {
  state.idStash.clear();
  state.titleStash.clear();
  state.copiedStash.clear();

  state.rows.forEach((row) => {
    row.articleId = '';
    row.articleTitle = '';
    row.copiedHtml = '';
  });

  setBulkStatus('');
  buildRows();
}

// ------------------------------------------------------------
// 警告
// ------------------------------------------------------------

function renderWarnings(warnings) {
  const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];

  el.warningsList.textContent = '';

  if (!list.length) {
    el.warnings.hidden = true;
    return;
  }

  for (const warning of list) {
    const li = document.createElement('li');
    li.textContent = String(warning);
    el.warningsList.appendChild(li);
  }

  el.warnings.hidden = false;
}

// ------------------------------------------------------------
// 共通エリア
// ------------------------------------------------------------

function renderCommon() {
  const series = state.series;

  if (!series) {
    el.sectionCommon.hidden = true;
    return;
  }

  el.seriesTitle.textContent = series.bookTitle || '（書籍タイトルなし）';
  el.seriesTitle.title = series.bookTitle || '';

  el.seriesCode.textContent = series.categoryCode || '—';
  el.seriesProdNo.textContent = series.productionNo || '—';

  if (series.kintoneUrl) {
    el.kintoneLink.href = series.kintoneUrl;
    el.kintoneLink.hidden = false;
  } else {
    el.kintoneLink.hidden = true;
  }

  renderSheetStatus();

  el.sectionCommon.hidden = false;
}

function renderSheetStatus() {
  if (state.sheetStatus === 'ok') {
    const count = Array.isArray(state.sheetRows) ? state.sheetRows.length : 0;

    el.sheetStatus.textContent = `記事下データ：取得済み（${count}行）`;
    el.sheetStatus.classList.remove('warn');
    el.sheetStatus.title = '';
    return;
  }

  el.sheetStatus.textContent = `記事下データ：取得失敗（${
    state.sheetMessage || '理由不明'
  }）`;
  el.sheetStatus.classList.add('warn');
  el.sheetStatus.title = state.sheetMessage || '';
}

// ------------------------------------------------------------
// 回数
// ------------------------------------------------------------

function clampEpisodeCount(value, min = 0) {
  const count = Math.floor(Number(value));

  if (!Number.isFinite(count) || count < min) return min;

  return Math.min(count, MAX_EPISODE_COUNT);
}

// 全角で入力されることがあるため半角に直してから読む
function parseCountInput(text) {
  const digits = String(text || '')
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0)
    )
    .replace(/[^0-9]/g, '');

  return digits ? Number(digits) : NaN;
}

// 確定時に表示を正規化する。読めない値のときは今の回数に戻す
function commitPrevCount() {
  const value = parseCountInput(el.prevCount.value);

  setEpisodeCount(Number.isFinite(value) ? value : state.episodeCount);
}

function setEpisodeCount(value) {
  const next = clampEpisodeCount(value, MIN_EPISODE_COUNT);

  if (next !== state.episodeCount) {
    state.episodeCount = next;

    buildRows();
    renderPrevTable();
    markBottomDirty();
  }

  renderCountControl();
}

function renderCountControl() {
  const count = state.episodeCount;

  el.prevCountMinus.disabled = count <= MIN_EPISODE_COUNT;
  el.prevCountPlus.disabled = count >= MAX_EPISODE_COUNT;

  // 入力中のカーソルが飛ばないよう、違うときだけ書き換える
  const text = count ? String(count) : '';

  if (el.prevCount.value !== text) el.prevCount.value = text;
}

// ------------------------------------------------------------
// 作業行の生成
//
// 入力済みの記事ID・タイトルは回数で覚えておき、
// 回数を増減しても同じ回に戻す。
// ------------------------------------------------------------

function buildRows() {
  stashRowInputs();

  state.rows = [];

  const total = state.episodeCount;

  if (!total) return;

  for (let index = 0; index < total; index++) {
    const number = index + 1;
    const isFinal = index === total - 1;

    state.rows.push({
      number,
      label: isFinal ? '最終回' : `第${number}回`,
      isFinal,

      articleId: state.idStash.get(number) || '',
      articleTitle: state.titleStash.get(number) || '',

      // コピー済み表示の根拠。この回で実際にコピーしたHTMLを覚えておく
      copiedHtml: state.copiedStash.get(number) || '',

      el: null,
    });
  }
}

// 行を作り直す前に、今表示している入力を回数ごとに退避する。
// 空にした行も空のまま覚える（消したはずの入力が復活しないように）
function stashRowInputs() {
  for (const row of state.rows) {
    state.idStash.set(row.number, String(row.articleId || ''));
    state.titleStash.set(row.number, String(row.articleTitle || ''));
    state.copiedStash.set(row.number, String(row.copiedHtml || ''));
  }
}

// ------------------------------------------------------------
// タブ
// ------------------------------------------------------------

const TAB_NAMES = ['prev', 'bottom'];

function switchTab(name) {
  if (!TAB_NAMES.includes(name)) return;

  state.activeTab = name;

  el.tabButtons.forEach((button) => {
    const on = button.dataset.tab === name;

    button.classList.toggle('is-active', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  el.panelPrev.hidden = name !== 'prev';
  el.panelBottom.hidden = name !== 'bottom';

  // ①で入力している間は②を作り直さない。開いたときにまとめて描き直す
  if (name === 'bottom' && state.bottomDirty) renderBottomTable();
}

function stepTab(direction) {
  const index = TAB_NAMES.indexOf(state.activeTab);
  const next = (index + direction + TAB_NAMES.length) % TAB_NAMES.length;

  switchTab(TAB_NAMES[next]);
}

// ①の入力は②の「続きを読む」に効く。
// ②を開いていないときは作り直さず、印だけ付けておく
function markBottomDirty() {
  state.bottomDirty = true;

  if (state.activeTab === 'bottom') renderBottomTable();
}

// ============================================================
// ① 前回記事リンク作成タブ
//
// 今回作る記事のIDを各回に入力し、
// 第2回以降は「1つ前の行の今回の記事ID」を前回記事として使う。
// ============================================================

// タイトル未入力のままでもHTMLは作れる。その場合の差し込み文字
const PREV_TITLE_FALLBACK = '●▼■';

const PREV_COPY_LABEL = 'HTMLコピー';

// 一覧を見ただけでどの回までコピーしたか分かるようにする
const COPIED_LABEL = 'コピー済み ✓';

function renderPrevTable() {
  el.prevBody.textContent = '';

  if (!state.rows.length) {
    el.prevBody.appendChild(
      createEmptyRow(5, '回数を入れると作業行を作成します')
    );
    return;
  }

  state.rows.forEach((row, index) => {
    const tr = document.createElement('tr');

    if (row.isFinal) tr.classList.add('is-final');

    tr.appendChild(createCell(row.label, 'col-ep ep-no'));

    // ---- 今回の記事ID ----
    const idCell = document.createElement('td');
    idCell.className = 'col-id';

    const input = document.createElement('input');

    input.type = 'text';
    input.className = 'id-input mono';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = '30001';
    input.value = row.articleId;
    input.dataset.index = String(index);
    input.setAttribute('aria-label', `${row.label}の今回の記事ID`);

    idCell.appendChild(input);
    tr.appendChild(idCell);

    // ---- 今回の記事タイトル ----
    // 次の回の【前回の記事を読む】と、1つ前の回の【この話の続きを読む】に使う
    const titleCell = document.createElement('td');
    titleCell.className = 'col-title';

    const titleInput = document.createElement('input');

    titleInput.type = 'text';
    titleInput.className = 'title-input';
    titleInput.autocomplete = 'off';
    titleInput.spellcheck = false;
    // 例文をプレースホルダーに置くと入力済みに見えるため、空欄のままにする
    titleInput.value = row.articleTitle;
    titleInput.dataset.index = String(index);
    titleInput.setAttribute('aria-label', `${row.label}の今回の記事タイトル`);

    const titleCount = document.createElement('div');
    titleCount.className = 'title-count';

    titleCell.appendChild(titleInput);
    titleCell.appendChild(titleCount);
    tr.appendChild(titleCell);

    // ---- 前回記事 ----
    const prevCell = document.createElement('td');
    prevCell.className = 'col-prev';
    tr.appendChild(prevCell);

    // ---- コピー ----
    // 第1回に前回記事は存在しないので、ボタンそのものを置かない
    const actionCell = document.createElement('td');
    actionCell.className = 'col-act';

    const button = index === 0 ? null : createPrevCopyButton(index);

    if (button) actionCell.appendChild(button);

    tr.appendChild(actionCell);

    row.el = { input, titleInput, titleCount, prevCell, button };

    updateTitleCount(row);

    el.prevBody.appendChild(tr);
  });

  state.rows.forEach((_, index) => updatePrevRow(index));
}

// 絵文字や結合文字を1文字として数えたいので Array.from() で数える。
// 文字数の上限は設けず、入力の目安として出すだけ
function updateTitleCount(row) {
  if (!row || !row.el || !row.el.titleCount) return;

  const length = Array.from(String(row.articleTitle || '')).length;

  row.el.titleCount.textContent = `${length}文字`;
}

// コピー内容は押した時点で組み立てる。
// コピーできたHTMLを覚えておき、中身が変わったら「コピー済み」を解除する
function createPrevCopyButton(index) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'copy mini prev-copy';
  button.textContent = PREV_COPY_LABEL;

  button.addEventListener('click', () => {
    if (button.disabled) return;

    const html = buildPreviousHtmlFor(index);

    if (!html) {
      showToast('コピーする内容がありません');
      return;
    }

    copyText(html).then((ok) => {
      if (!ok) {
        showToast('コピーできませんでした');
        return;
      }

      const row = state.rows[index];

      if (row) {
        row.copiedHtml = html;
        state.copiedStash.set(row.number, html);
      }

      updatePrevRow(index);
      showToast('前回記事HTMLをコピーしました');
    });
  });

  return button;
}

// 前回記事は「1つ前の行の今回の記事ID・記事タイトル」。
// IDが未入力のままコピーさせると誤ったリンクが貼られるので、ボタンを無効にする。
// タイトルは未入力でもよい（HTMLでは ●▼■ を使う）
function updatePrevRow(index) {
  const row = state.rows[index];

  if (!row || !row.el) return;

  const cell = row.el.prevCell;
  const button = row.el.button;

  cell.textContent = '';
  cell.className = 'col-prev';

  if (index === 0) {
    cell.textContent = 'なし';
    cell.classList.add('muted');
    return;
  }

  const previous = state.rows[index - 1];
  const previousId = String(previous.articleId || '').trim();
  const previousTitle = String(previous.articleTitle || '').trim();

  if (!previousId) {
    cell.textContent = '前回の記事IDを入力してください';
    cell.classList.add('warn');

    if (button) {
      button.disabled = true;
      button.title = '前回の記事IDを入力してください';
    }

    syncPrevCopiedState(index);
    return;
  }

  // 「今回の記事ID」列と見間違えないよう、どの回のIDかを明示する
  cell.appendChild(createLine(`前回：${previous.label}／ID ${previousId}`));

  cell.appendChild(
    previousTitle
      ? createLine(previousTitle, 'sub ellip')
      : createLine(
          `タイトル未入力（HTMLでは${PREV_TITLE_FALLBACK}を使用）`,
          'sub faint'
        )
  );

  if (button) {
    button.disabled = false;
    button.title = '';
  }

  syncPrevCopiedState(index);
}

// コピーしたときのHTMLと今のHTMLを突き合わせる。
// 前の回のID・タイトルが変わればHTMLも変わるので、そこで自動的に解除される
function syncPrevCopiedState(index) {
  const row = state.rows[index];

  if (!row || !row.el || !row.el.button) return;

  const current = buildPreviousHtmlFor(index);

  if (!current || row.copiedHtml !== current) {
    row.copiedHtml = '';
    state.copiedStash.set(row.number, '');
  }

  const copied = Boolean(row.copiedHtml);

  row.el.button.classList.toggle('copied', copied);
  row.el.button.textContent = copied ? COPIED_LABEL : PREV_COPY_LABEL;
}

function buildPreviousHtmlFor(index) {
  const previous = state.rows[index - 1];
  const previousId = String((previous && previous.articleId) || '').trim();

  if (!previousId) return '';

  return buildPreviousArticleHtml(
    previousId,
    (previous && previous.articleTitle) || ''
  );
}

function buildPreviousArticleHtml(articleId, title) {
  const label = String(title || '').trim() || PREV_TITLE_FALLBACK;

  return (
    `<p align="center">` +
    `<a href="/articles/-/${escapeHtml(articleId)}" target="_blank">` +
    `<strong>` +
    `<span style="color:#0000CD;">【前回の記事を読む】${escapeHtml(label)}</span>` +
    `</strong>` +
    `</a>` +
    `</p>`
  );
}

// ---- 記事IDの一括貼り付け ----

function applyBulkIds() {
  if (!state.rows.length) {
    setBulkStatus('先に回数を入力してください', true);
    return;
  }

  // スプレッドシートからのコピーは改行が \n / \r\n / \r のいずれにもなる。
  // 区切れないと1行目に全IDが入ってしまうため、どの改行でも分割する
  const ids = String(el.bulkInput.value || '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!ids.length) {
    setBulkStatus('記事IDが入力されていません', true);
    return;
  }

  // 行数を超えた分も回数ごとに退避しておく。
  // 回数を増やしたときに貼り直さずに済む
  ids.forEach((id, index) => {
    const number = index + 1;

    if (number > MAX_EPISODE_COUNT) return;

    state.idStash.set(number, id);

    const row = state.rows[index];

    if (!row) return;

    row.articleId = id;

    if (row.el) row.el.input.value = id;
  });

  state.rows.forEach((_, index) => updatePrevRow(index));
  markBottomDirty();

  const applied = Math.min(ids.length, state.rows.length);

  let message = `${applied}件を反映しました`;

  if (ids.length > state.rows.length) {
    message +=
      `（${ids.length - state.rows.length}件は回数を超えています。` +
      `回数を増やすと反映されます）`;
  } else if (ids.length < state.rows.length) {
    // 貼り付けた件数より後ろの回は書き換えない。
    // 前に入れたIDが残っていることがあるので「未入力」と決めつけない
    const rest = state.rows.slice(ids.length);
    const kept = rest.filter((row) => String(row.articleId || '').trim()).length;

    message += kept
      ? `（残り${rest.length}回のうち${kept}回は前の入力のままです）`
      : `（残り${rest.length}回は未入力）`;
  }

  setBulkStatus(message, ids.length > state.rows.length);
}

function clearArticleIds() {
  // 退避してある分（今は表示していない回）も一緒に消す。
  // 消したつもりのIDが回数を戻したときに復活しないようにする
  state.idStash.clear();

  state.rows.forEach((row) => {
    row.articleId = '';

    if (row.el) row.el.input.value = '';
  });

  state.rows.forEach((_, index) => updatePrevRow(index));
  markBottomDirty();

  setBulkStatus('記事IDを消しました');
}

function setBulkStatus(message, isWarn = false) {
  el.bulkStatus.textContent = message || '';
  el.bulkStatus.classList.toggle('warn', Boolean(message) && isWarn);
}

// ============================================================
// ② この話の続きタブ
//
// 第N回の記事下に貼るものを組み立てる。
//
//   <p>　</p>                       … C列先頭の余白を前に回したもの
//   <p>▶この話の続きを読む…</p>      … ①タブの第(N+1)回のID・タイトル
//   <p>…連載記事一覧…</p>           … C列。カテゴリコード・書籍タイトルを差し込む
//   <p>【イチオシ記事】</p>          … C列そのまま
//   <p>ゴールドライフオンライン…</p>  … C列そのまま
//
// 一括集中の公開日の扱いが未確定なので、C列の週は日付から自動判定せず
// 画面のプルダウンで選ぶ。選んだ週を全回に使う。
// ============================================================

function renderBottomTable() {
  el.bottomBody.textContent = '';
  state.copyButtons = [];
  state.bottomDirty = false;

  if (!state.rows.length) {
    el.bottomBody.appendChild(
      createEmptyRow(4, '①タブで回数を入れると作業行を作成します')
    );
    return;
  }

  const cHtml = getSelectedWeekHtml();

  for (const row of state.rows) {
    const link = resolveNextLink(row);
    const bottomHtml = buildArticleBottomHtml(cHtml, row.isFinal);
    const reason = bottomCopyBlockReason(link, cHtml, bottomHtml);

    const tr = document.createElement('tr');

    // 回ラベル列の左バーで、最終回と手当てが要る回を離れていても分かるようにする
    if (row.isFinal) tr.classList.add('is-final');
    if (needsAttention(link, reason)) tr.classList.add('is-flag');

    tr.appendChild(createCell(row.label, 'col-ep ep-no'));
    tr.appendChild(createNextCell(link));
    tr.appendChild(createSheetCell(row, cHtml, bottomHtml));

    const actionCell = document.createElement('td');
    actionCell.className = 'col-act';

    if (reason) {
      actionCell.appendChild(
        createDisabledButton('記事下まとめてコピー', reason)
      );
    } else {
      actionCell.appendChild(
        createCopyButton(
          '記事下まとめてコピー',
          () => joinBottomHtml(link.html, bottomHtml),
          '記事下HTMLをコピーしました',
          'strong'
        )
      );
    }

    tr.appendChild(actionCell);

    el.bottomBody.appendChild(tr);
  }
}

// そのまま貼れない回かどうか。
// コピーを止めている回と、タイトルに記号が残っている回を拾う
function needsAttention(link, reason) {
  if (reason) return true;
  if (link.kind !== 'ok') return false;

  return findRiskyTitleParts(link.title).length > 0;
}

// 今回の第N回 → 今回の第(N+1)回。①タブに入れた値をそのまま使う。
// kind が 'ok' か 'final' のときだけ html を持つ
function resolveNextLink(row) {
  if (row.isFinal) {
    return { kind: 'final', html: buildFinalEpisodeHtml() };
  }

  const next = state.rows[row.number]; // 0始まりなので row.number が次の行
  const nextId = String((next && next.articleId) || '').trim();
  const nextTitle = String((next && next.articleTitle) || '').trim();

  if (!next) {
    return { kind: 'no-episode', nextLabel: `第${row.number + 1}回`, html: '' };
  }

  // 表示は「第3回」ではなく①タブと同じ呼び方（最終回）に揃える
  if (!nextId) {
    return { kind: 'no-id', nextLabel: next.label, next, html: '' };
  }

  return {
    kind: 'ok',
    nextLabel: next.label,
    next,
    id: nextId,
    title: nextTitle,
    html: buildNextArticleHtml(nextId, nextTitle || PREV_TITLE_FALLBACK),
  };
}

function createNextCell(link) {
  const cell = document.createElement('td');
  cell.className = 'col-next';

  // 最終回に「続き」は無い。ここに文言を出すと、記事下にそのまま貼る文だと
  // 誤解されるので出さない（実際に貼る文言はコピーしたHTMLに入っている）
  if (link.kind === 'final') {
    cell.appendChild(
      createLine('—', 'faint', '最終回のため、続きを読むはありません')
    );
    return cell;
  }

  if (link.kind === 'no-id') {
    cell.appendChild(
      createLine(`${link.nextLabel}の記事IDを入力してください`, 'warn')
    );
    cell.appendChild(createLine('①タブで入力します', 'sub faint'));
    return cell;
  }

  if (link.kind === 'no-episode') {
    cell.appendChild(createLine('次の回がありません', 'warn'));
    return cell;
  }

  cell.appendChild(createLine(`次回：${link.nextLabel}／ID ${link.id}`));

  cell.appendChild(
    link.title
      ? createLine(link.title, 'sub ellip')
      : createLine(
          `タイトル未入力（HTMLでは${PREV_TITLE_FALLBACK}を使用）`,
          'sub faint'
        )
  );

  // 記号が残っているタイトルは、そのまま貼るとMWで崩れることがある。
  // 自動では直さず、目印だけ出す
  const risky = findRiskyTitleParts(link.title);

  if (risky.length) {
    cell.appendChild(
      createLine(
        `要確認：${risky.map((part) => part.label).join('／')}`,
        'sub warn',
        risky.map((part) => `${part.label}：${part.sample}`).join('\n')
      )
    );
  }

  return cell;
}

// 記事タイトルに混ざると表示崩れ・文字化けの原因になりうる記号。
//
// 半角の ! ? やダッシュはGLOのタイトルで普通に使われるため入れない。
// 目印が多すぎると見なくなるので、疑わしいものだけに絞る。
const RISKY_TITLE_RULES = [
  { re: /[<>&"]/g, label: 'HTMLで意味を持つ記号' },

  // 「――」がコピー経路で ?? に化けることがある。
  // 「!?」「!!」は普通に使うので、? の連続だけを疑う
  { re: /\?{2,}/g, label: '?? の連続（文字化けの可能性）' },
  { re: /[｡-ﾟ]/g, label: '半角カナ' },
  {
    re: /[①-⑳⑴-⒇Ⅰ-Ⅻⅰ-ⅹ㈱㈲㈹℡№〓㌀-㍿]/g,
    label: '機種依存の記号',
  },
  { re: /\uFFFD/g, label: '文字化けの疑い' },
  { re: /[\u0000-\u001F\u007F]/g, label: '制御文字' },
];

function findRiskyTitleParts(title) {
  const text = String(title || '');
  const found = [];

  for (const rule of RISKY_TITLE_RULES) {
    const matched = text.match(rule.re);

    if (!matched) continue;

    found.push({
      label: rule.label,
      sample: [...new Set(matched)].join(' '),
    });
  }

  return found;
}

// 記事下リンク（連載一覧＋イチオシ）の状態。
// 誤ったHTMLを作らないよう、取れていない理由をそのまま出す
function createSheetCell(row, cHtml, bottomHtml) {
  const cell = document.createElement('td');
  cell.className = 'col-sheet';

  if (state.sheetStatus !== 'ok') {
    cell.appendChild(
      createLine('記事下リンク：スプレッドシートを取得できませんでした', 'warn')
    );

    if (state.sheetMessage) {
      cell.appendChild(createLine(state.sheetMessage, 'sub ellip'));
    }

    return cell;
  }

  // 週を選んでいないのか、選んだ週のC列が空なのかは原因が違う。
  // まとめて「未選択」と出すと、シートを直せばよいことが伝わらない
  if (state.weekIndex < 0) {
    cell.appendChild(createLine('記事下リンク：週が未選択です', 'warn'));
    return cell;
  }

  if (!cHtml) {
    cell.appendChild(
      createLine(`記事下：${getSelectedWeekLabel()}（C列が空です）`, 'warn')
    );
    return cell;
  }

  if (!state.series) {
    cell.appendChild(
      createLine('記事下リンク：連載情報を取得してください', 'warn')
    );
    cell.appendChild(
      createLine('一覧リンクのカテゴリコードと書籍名に使います', 'sub')
    );
    return cell;
  }

  if (!bottomHtml) {
    cell.appendChild(createLine('記事下：C列が空です', 'warn'));
    return cell;
  }

  // 画面には選んだ週と誘導先だけを出す。
  // C列の原文はホバーで確認できるようツールチップに残しておく
  const target = getListTarget();

  const tooltip = [
    `シートB列：${getSelectedWeekLabel()}`,
    `一覧：/category/${target.categoryCode || '（コード不明）'}` +
      `『${target.bookTitle || 'タイトル不明'}』`,
  ].join('\n');

  cell.appendChild(createLine(getSelectedWeekLabel(), 'range', tooltip));

  cell.appendChild(
    createLine(
      `一覧：/category/${target.categoryCode}『${target.bookTitle}』`,
      'sub ellip',
      tooltip
    )
  );

  return cell;
}

// 揃っていないものを押せてしまうと誤ったHTMLが貼られるため、
// コピーできない場合はボタン自体を無効にして理由を出す
function bottomCopyBlockReason(link, cHtml, bottomHtml) {
  if (link.kind === 'no-id') {
    return `${link.nextLabel}の記事IDが未入力です`;
  }

  if (link.kind === 'no-episode') {
    return '次の回がありません';
  }

  return sheetBlockReason(cHtml, bottomHtml);
}

// 記事下リンク（連載一覧＋イチオシ）側だけの事情
function sheetBlockReason(cHtml, bottomHtml) {
  if (state.sheetStatus !== 'ok') {
    return state.sheetMessage
      ? `記事下データを取得できませんでした（${state.sheetMessage}）`
      : '記事下データを取得できませんでした';
  }

  if (state.weekIndex < 0) {
    return '記事下リンクの週が未選択です';
  }

  if (!cHtml) {
    return '記事下リンクのC列が空です';
  }

  // 連載情報が無いと grxxxx・xxxxxxxx が残ったままのHTMLになる
  if (!state.series) {
    return '連載情報を取得してください（一覧リンクのカテゴリコードと書籍名に使います）';
  }

  if (!bottomHtml) {
    return '記事下リンクのC列が空です';
  }

  return '';
}

// ---- 記事下リンクの週 ----

function renderWeekSelect() {
  el.weekSelect.textContent = '';

  const rows = Array.isArray(state.sheetRows) ? state.sheetRows : [];

  if (!rows.length) {
    state.weekIndex = -1;

    el.weekSelect.disabled = true;

    // 起動直後はまだ取得していないだけなので、失敗として出さない
    if (state.sheetStatus !== 'ok' && !state.sheetMessage) {
      el.weekStatus.textContent = 'カテゴリコードを取得すると選べます';
      el.weekStatus.classList.remove('warn');
      return;
    }

    el.weekStatus.textContent =
      state.sheetStatus === 'ok'
        ? 'スプレッドシートに行がありません'
        : `取得できませんでした（${state.sheetMessage}）`;
    el.weekStatus.classList.add('warn');
    return;
  }

  // シートは下に追記されていくので、最終行が最新の週になる。
  // 日付の仕様が決まるまでは、これを既定にして手で選べるようにしておく
  rows.forEach((row, index) => {
    const option = document.createElement('option');

    option.value = String(index);
    option.textContent = formatWeekLabel(row, index);

    el.weekSelect.appendChild(option);
  });

  state.weekIndex = rows.length - 1;

  el.weekSelect.disabled = false;
  el.weekSelect.value = String(state.weekIndex);

  el.weekStatus.textContent = '既定はシートの最終行（最新の週）です';
  el.weekStatus.classList.remove('warn');
}

// B列は「9月第一週\n8/30（日）〜9/5（土）」のように2行入っている。
// プルダウンでは1行にして、そのまま読めるようにする
function formatWeekLabel(row, index) {
  const label = String((row && row[0]) || '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('　');

  return label || `（B列が空の行 ${index + 1}行目）`;
}

function getSelectedWeekLabel() {
  const rows = Array.isArray(state.sheetRows) ? state.sheetRows : [];
  const row = rows[state.weekIndex];

  return row ? formatWeekLabel(row, state.weekIndex) : '';
}

function getSelectedWeekHtml() {
  const rows = Array.isArray(state.sheetRows) ? state.sheetRows : [];
  const row = rows[state.weekIndex];

  return String((row && row[1]) || '').trim();
}

// ------------------------------------------------------------
// 生成HTML
// ------------------------------------------------------------

function buildNextArticleHtml(articleId, articleTitle) {
  return (
    `<p>▶この話の続きを読む<br />\n` +
    `<span style="font-size:18px;">` +
    `<a href="/articles/-/${escapeHtml(articleId)}" target="_blank">` +
    `<span style="color:#0000FF;">${escapeHtml(articleTitle)}</span>` +
    `</a>` +
    `</span></p>`
  );
}

// 最終回はこの文言で固定する
const FINAL_MESSAGE = '試し読み連載は今回で最終回です。ご愛読ありがとうございました。';

function buildFinalEpisodeHtml() {
  return `<p align="center">${FINAL_MESSAGE}</p>`;
}

// スプレッドシートC列は先頭に余白の段落 <p>　</p> が入っている。
// そのまま後ろにつなぐと「続きを読む」の下に余白が来てしまうので、
// 余白は先頭へ回して、続きを読むの上に空きを作る。
//
//   <p>　</p>
//   <p>▶この話の続きを読む…</p>
//   <p>…連載記事一覧…</p>
const LEADING_SPACER_RE = /^\s*<p(?:\s[^>]*)?>(?:\s|　|&nbsp;)*<\/p>\s*/i;

function joinBottomHtml(headHtml, bottomHtml) {
  const body = String(bottomHtml || '');
  const match = body.match(LEADING_SPACER_RE);

  if (!match) return `${headHtml}\n${body}`;

  return `${match[0].trim()}\n${headHtml}\n${body.slice(match[0].length)}`;
}

// C列は「連載記事一覧 → 【イチオシ記事】 →【注目記事】→（定型文）」の並び。
// 古い行には【人気記事】も入っている。いずれも1つの <p>…</p> に収まっているので、
// 落とすときはその段落だけを丸ごと消す。
//
//   通常回：【注目記事】【人気記事】を落とす（残すのは【イチオシ記事】）
//   最終回：【人気記事】だけ落とす（【注目記事】は残す）
//
// 判定は必ず【注目記事】【人気記事】という記事ラベルで行う。
// 「注目」「人気」だけで判定すると、書籍タイトルの
// ［注目連載ピックアップ］［人気連載ピックアップ］まで巻き込む。
//
// 実データの注意点：
//   ・段落は <p> と <p align="center"> の両方がある
//   ・見出しは <strong><span> の内側にあり、途中に改行が入る行もある
// このため「同じ段落の中にラベルがある」ことを
// </p> をまたがない先読みで確かめてから、その段落の終わりまでを消す。
const DROP_ATTENTION_RE =
  /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?【注目記事】[\s\S]*?<\/p>[ \t]*(?:\r?\n)*/g;

const DROP_POPULAR_RE =
  /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?【人気記事】[\s\S]*?<\/p>[ \t]*(?:\r?\n)*/g;

// 全回まとめて注目記事を落としてから最終回を判定する、という順序にはしない。
// 先に落としてしまうと最終回で復元できないため、必ず isFinal で分岐させる。
function removeDroppedParagraphs(html, isFinal) {
  const source = String(html || '');

  if (isFinal) {
    // 最終回は【注目記事】を残す。落とすのは【人気記事】だけ
    return source.replace(DROP_POPULAR_RE, '');
  }

  return source.replace(DROP_ATTENTION_RE, '').replace(DROP_POPULAR_RE, '');
}

// 「連載記事一覧はこちら」の誘導先。
//
// 新規連載なので参照元は無い。通常回も最終回も今回のカテゴリコードへ送る。
// （再掲では通常回だけ参照元へ送るが、ここには参照元が存在しない）
function getListTarget() {
  const series = state.series;

  return {
    categoryCode: String((series && series.categoryCode) || '').trim(),
    bookTitle: stripBookTitleBrackets((series && series.bookTitle) || ''),
  };
}

// タイトル自体に『』が付いている場合は外す。
// テンプレート側に『』があるため二重化を防ぐ
function stripBookTitleBrackets(value) {
  const title = stripPickupSuffix(value);
  const match = title.match(/^『(.*)』$/);

  return match ? match[1] : title;
}

// 一覧リンクに出す書籍名は［注目連載ピックアップ］等を外した形にする
function stripPickupSuffix(value) {
  return String(value || '')
    .replace(/［(?:注目|人気)連載ピックアップ］/g, '')
    .replace(/\[(?:注目|人気)連載ピックアップ\]/g, '')
    .trim();
}

// スプレッドシートC列HTMLのプレースホルダーを今回の連載に置き換える
function buildArticleBottomHtml(cHtml, isFinal) {
  // 置換より先に落とす。
  // 書籍タイトルを入れてから消すと、タイトル次第で判定が変わりうる
  let c = removeDroppedParagraphs(String(cHtml || '').trim(), isFinal).trim();

  if (!c) return '';

  const { categoryCode, bookTitle } = getListTarget();

  // gr●●●● を先に置換する。
  // ●●●●●●●●（8個）を先に処理すると gr●●●●（4個）が壊れる
  if (categoryCode) {
    c = c.split('grxxxx').join(categoryCode);
    c = c.split('gr●●●●').join(categoryCode);
  }

  if (bookTitle) {
    c = c.split('xxxxxxxx').join(bookTitle);
    c = c.split('●●●●●●●●').join(bookTitle);
  }

  return c;
}

// ------------------------------------------------------------
// パーツ生成
// ------------------------------------------------------------

function createCell(text, className) {
  const cell = document.createElement('td');
  cell.className = className || '';
  cell.textContent = text;
  return cell;
}

// tooltip を渡すと、画面には出さずホバーしたときだけ見える補足になる
function createLine(text, className, tooltip) {
  const line = document.createElement('div');
  line.className = 'line' + (className ? ` ${className}` : '');
  line.textContent = text;
  line.title = tooltip || text;
  return line;
}

function createEmptyRow(colspan, text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');

  td.colSpan = colspan;
  td.className = 'empty';
  td.textContent = text;

  tr.appendChild(td);

  return tr;
}

// コピー内容は押した時点で組み立てる。
// 記事IDは画面で書き換わるため、描画時のテキストを持たせない
function createCopyButton(label, getText, toastMessage, modifier) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'copy mini' + (modifier ? ` ${modifier}` : '');
  button.textContent = label;

  // コピー済み表示を戻すときに使う
  button.dataset.label = label;

  button.addEventListener('click', () => {
    if (button.disabled) return;

    const text = getText();

    if (!text) {
      showToast('コピーする内容がありません');
      return;
    }

    copyText(text).then((ok) => {
      if (ok) {
        markCopiedButton(button);
        showToast(toastMessage);
      } else {
        showToast('コピーできませんでした');
      }
    });
  });

  state.copyButtons.push(button);

  return button;
}

// ②のコピー済み表示は最後にコピーした1件だけにする。
// 「作業が済んだ回」ではなく「いまクリップボードに入っているもの」を示す。
// ①は回ごとに残す（どこまで進んだかを一覧で見たいため）
function markCopiedButton(button) {
  for (const other of state.copyButtons) {
    if (other === button) continue;

    other.classList.remove('copied');
    other.textContent = other.dataset.label || '';
  }

  button.classList.add('copied');
  button.textContent = COPIED_LABEL;
}

function createDisabledButton(label, reason) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'copy mini strong';
  button.textContent = label;
  button.disabled = true;
  button.title = reason || '';

  return button;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------
// コピーとトースト
// ------------------------------------------------------------

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // 下のフォールバックへ
  }

  try {
    const area = document.createElement('textarea');

    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';

    document.body.appendChild(area);
    area.select();

    const ok = document.execCommand('copy');

    document.body.removeChild(area);

    return ok;
  } catch (e) {
    return false;
  }
}

let toastTimer = null;

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
  }, 1600);
}

// ------------------------------------------------------------
// 起動時の描画
//
// const の初期化より前に呼ぶと TDZ で落ちるため、
// ファイルの末尾でまとめて呼ぶ
// ------------------------------------------------------------

renderWeekSelect();
setEpisodeCount(DEFAULT_EPISODE_COUNT);
renderBottomTable();
