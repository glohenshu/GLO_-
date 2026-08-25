/* ============================================================
   新規一括集中アシスタント Ver.0.1

   新規の一括集中連載をMediaWeaverで作るときの作業支援ツール。
   再掲連載作成アシスタント（apps/reprint-assistant）の①前回記事タブを
   もとにしているが、こちらは参照元の過去連載を持たないため、
   kintone・スプレッドシートへは一切アクセスしない。

   ・記事IDとタイトルは画面で手入力する（MWで採番したものを貼る）
   ・APIトークン等はこのファイルに置かない。そもそも通信しない
   ============================================================ */

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

  activeTab: 'prev',
};

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------

const el = {
  tabButtons: Array.from(document.querySelectorAll('.tab')),
  panelPrev: document.getElementById('panel-prev'),

  bulkInput: document.getElementById('bulk-input'),
  bulkApply: document.getElementById('bulk-apply'),
  bulkClear: document.getElementById('bulk-clear'),
  bulkStatus: document.getElementById('bulk-status'),

  prevCount: document.getElementById('prev-count'),
  prevCountMinus: document.getElementById('prev-count-minus'),
  prevCountPlus: document.getElementById('prev-count-plus'),
  prevBody: document.getElementById('prev-body'),

  toast: document.getElementById('toast'),
};

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------

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
});

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
//
// 今は①だけ。②以降を足すときはここに名前を増やす
// ------------------------------------------------------------

const TAB_NAMES = ['prev'];

function switchTab(name) {
  if (!TAB_NAMES.includes(name)) return;

  state.activeTab = name;

  el.tabButtons.forEach((button) => {
    const on = button.dataset.tab === name;

    button.classList.toggle('is-active', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  el.panelPrev.hidden = name !== 'prev';
}

function stepTab(direction) {
  const index = TAB_NAMES.indexOf(state.activeTab);
  const next = (index + direction + TAB_NAMES.length) % TAB_NAMES.length;

  switchTab(TAB_NAMES[next]);
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
    // 次の回の【前回の記事を読む】に使う。必須ではない
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

  setBulkStatus('記事IDを消しました');
}

function setBulkStatus(message, isWarn = false) {
  el.bulkStatus.textContent = message || '';
  el.bulkStatus.classList.toggle('warn', Boolean(message) && isWarn);
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

setEpisodeCount(DEFAULT_EPISODE_COUNT);
