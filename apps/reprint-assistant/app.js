/* ============================================================
   再掲連載作成アシスタント Ver.0.3

   これからMediaWeaverで作る再掲連載の記事を組み立てるための作業支援ツール。
   今回作る記事はまだ記事データアプリに存在しないため、
   記事IDは画面で手入力し、公開予定日はGLO連載情報の第1回配信日時から算出する。

   ・kintone／スプレッドシートへは直接アクセスしない。/api/reprint-data のみ
   ・APIトークン・GASのURLはこのファイルに一切置かない
   ============================================================ */

const API_ENDPOINT = '/api/reprint-data';

// 再掲連載回数の範囲。
// 1回だけの再掲（最終回のみ）もありうるので下限は1。
// 上限は打ち間違いで数百行を作ってしまわないための歯止め
const MIN_EPISODE_COUNT = 1;
const MAX_EPISODE_COUNT = 200;

// ------------------------------------------------------------
// 状態
// ------------------------------------------------------------

const state = {
  // GLO連載情報アプリの1レコード（今回作る再掲連載）
  series: null,

  // 記事データアプリ341から作った参照元候補
  sourceCandidates: [],
  selectedSource: null,

  // 参照元候補そのものが取れなかったときの理由
  sourceError: '',

  // 参照元の「回数 → 記事」対応表
  sourceByEpisode: new Map(),

  // 選択中の参照元の記事数。「参照元の回数に戻す」の戻り先
  sourceCount: 0,

  // 実際に作る再掲連載の回数。参照元の記事数を初期値に、画面で変更できる
  episodeCount: 0,

  // 回数を減らして消えた行の記事IDを覚えておく。
  // 回数を戻したときに入力し直さずに済むようにする（回数 → 記事ID）
  idStash: new Map(),

  // 今回の記事タイトルも同じく回数ごとに退避する（回数 → タイトル）。
  // 10回 → 8回 → 10回 と戻したときに入力し直さずに済むようにする
  titleStash: new Map(),

  // コピー済み表示も回数ごとに退避する（回数 → コピーしたHTML）。
  // 中身が変わっていれば updatePrevRow() が解除するので、そのまま戻してよい
  copiedStash: new Map(),

  // 作業行。再掲連載回数ぶん作る
  // { number, label, isFinal, planned, articleId, articleTitle, copiedHtml, el }
  rows: [],

  // スプレッドシート「毎月の記事下リンク」。rows は [B列, C列] の配列
  sheetRows: null,
  sheetStatus: 'error',
  sheetMessage: '',

  // 年を推定済みの行。sheetRows が変わったときだけ作り直す
  parsedSheetRows: null,
  parsedSheetSource: null,

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
  seriesFirst: document.getElementById('series-first'),
  seriesProdNo: document.getElementById('series-prodno'),
  sourceSelect: document.getElementById('source-select'),
  sourceStatus: document.getElementById('source-status'),
  countInput: document.getElementById('count-input'),
  countMinus: document.getElementById('count-minus'),
  countPlus: document.getElementById('count-plus'),
  countSource: document.getElementById('count-source'),
  countReset: document.getElementById('count-reset'),
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

  prevBody: document.getElementById('prev-body'),
  bottomBody: document.getElementById('bottom-body'),

  toast: document.getElementById('toast'),
};

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------

el.fetchBtn.addEventListener('click', () => {
  fetchReprintData();
});

el.codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    fetchReprintData();
  }
});

el.sourceSelect.addEventListener('change', () => {
  applySourceSelection(el.sourceSelect.value);
  buildRows();
  renderPrevTable();
  renderBottomTable();
});

// ---- 再掲連載回数 ----

el.countMinus.addEventListener('click', () => {
  setEpisodeCount(state.episodeCount - 1);
});

el.countPlus.addEventListener('click', () => {
  setEpisodeCount(state.episodeCount + 1);
});

el.countReset.addEventListener('click', () => {
  setEpisodeCount(state.sourceCount);
});

// 入力途中（空欄・全角のみ等）はまだ反映しない。
// 数として読める値になった時点で行を作り直す
el.countInput.addEventListener('input', () => {
  const value = parseCountInput(el.countInput.value);

  if (!Number.isFinite(value) || value < MIN_EPISODE_COUNT) return;

  setEpisodeCount(value);
});

// 確定時に表示を正規化する。読めない値のときは今の回数に戻す
el.countInput.addEventListener('change', () => {
  commitCountInput();
});

el.countInput.addEventListener('blur', () => {
  commitCountInput();
});

el.countInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    setEpisodeCount(state.episodeCount + (event.key === 'ArrowUp' ? 1 : -1));
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    commitCountInput();
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
    switchTab(state.activeTab === 'prev' ? 'bottom' : 'prev');

    const next = el.tabButtons.find(
      (tab) => tab.dataset.tab === state.activeTab
    );

    if (next) next.focus();
  });
});

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

// URLに ?code= が付いていれば初期表示で取得しておく
(function initFromQuery() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').trim();

  if (code) {
    el.codeInput.value = code;
    fetchReprintData();
  }
})();

// ------------------------------------------------------------
// API取得
// ------------------------------------------------------------

async function fetchReprintData() {
  const code = el.codeInput.value.trim();

  if (!code) {
    setStatus('カテゴリコードを入力してください', true);
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

      resetView();
      setStatus(message, true);
      return;
    }

    // スプレッドシートは kintone と独立して扱う。
    // 記事下だけ取れなくても、前回記事タブは最後まで使えるようにする。
    const sheet = json.sheet || {};

    state.sheetStatus = sheet.status === 'ok' ? 'ok' : 'error';
    state.sheetRows =
      sheet.status === 'ok' && Array.isArray(sheet.rows) ? sheet.rows : null;
    state.sheetMessage = String(sheet.message || '');
    state.parsedSheetRows = null;
    state.parsedSheetSource = null;

    const series = json.series || {};

    if (series.status !== 'ok' || !series.data) {
      resetView();
      renderWarnings(json.warnings);
      setStatus(
        series.message || 'GLO連載情報を取得できませんでした',
        true
      );
      return;
    }

    state.series = series.data;

    // カテゴリコードが変わったので、前のレコードの入力は引き継がない
    state.rows = [];
    state.idStash.clear();
    state.titleStash.clear();
    state.copiedStash.clear();
    state.sourceCount = 0;
    state.episodeCount = 0;
    setBulkStatus('');

    const source = json.source || {};

    state.sourceCandidates = Array.isArray(source.candidates)
      ? source.candidates
      : [];

    // 参照元候補そのものが取れなかった場合は、その理由を選択欄の横に出す
    state.sourceError =
      source.status === 'ok' ? '' : String(source.message || '');

    renderWarnings(json.warnings);
    renderCommon();
    renderSourceCandidates();

    buildRows();
    renderPrevTable();
    renderBottomTable();

    el.sectionTabs.hidden = false;
    switchTab(state.activeTab);

    setStatus(`取得しました（${new Date().toLocaleTimeString('ja-JP')}）`);

  } catch (e) {
    resetView();
    setStatus(`通信エラー：${String(e.message || e)}`, true);

  } finally {
    el.fetchBtn.disabled = false;
  }
}

function setStatus(message, isError = false) {
  el.fetchStatus.textContent = message;
  el.fetchStatus.classList.toggle('error', Boolean(isError));
}

function resetView() {
  state.series = null;
  state.sourceCandidates = [];
  state.selectedSource = null;
  state.sourceError = '';
  state.sourceByEpisode = new Map();
  state.sourceCount = 0;
  state.episodeCount = 0;
  state.idStash.clear();
  state.titleStash.clear();
  state.copiedStash.clear();
  state.rows = [];

  renderCountControl();

  el.warnings.hidden = true;
  el.warningsList.textContent = '';

  el.sectionCommon.hidden = true;
  el.sectionTabs.hidden = true;

  el.sourceSelect.textContent = '';
  el.prevBody.textContent = '';
  el.bottomBody.textContent = '';
  el.bulkStatus.textContent = '';
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

  el.seriesTitle.textContent = series.bookTitle || '（書籍タイトルなし）';
  el.seriesTitle.title = series.bookTitle || '';

  el.seriesCode.textContent = series.categoryCode || '—';

  el.seriesFirst.textContent = series.firstDeliveryAt
    ? fmtDateTime(getFirstDeliveryParts())
    : '未登録';

  el.seriesFirst.classList.toggle('warn', !series.firstDeliveryAt);

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

  el.sheetStatus.textContent =
    `記事下データ：取得失敗（${state.sheetMessage || '理由不明'}）`;
  el.sheetStatus.classList.add('warn');
  el.sheetStatus.title = state.sheetMessage || '';
}

// ------------------------------------------------------------
// 参照元候補
// ------------------------------------------------------------

function renderSourceCandidates() {
  el.sourceSelect.textContent = '';

  const candidates = state.sourceCandidates;

  if (!candidates.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '参照元候補が見つかりません';
    el.sourceSelect.appendChild(option);
    el.sourceSelect.disabled = true;

    applySourceSelection('');
    return;
  }

  el.sourceSelect.disabled = false;

  // 自動確定はしない。先頭候補を初期表示にするだけ
  for (const candidate of candidates) {
    const option = document.createElement('option');

    option.value = candidate.categoryCode || '';

    option.textContent = [
      candidate.categoryCode || '（コード不明）',
      candidate.bookTitle || '（タイトル不明）',
      `${candidate.count || 0}回`,
    ].join('｜');

    el.sourceSelect.appendChild(option);
  }

  el.sourceSelect.selectedIndex = 0;
  applySourceSelection(el.sourceSelect.value);
}

// 参照元を選び直した時点で、再掲連載回数はその参照元の記事数に戻す。
// 回数を手で変えていても、参照元が変われば基準そのものが変わるため。
function applySourceSelection(categoryCode) {
  state.selectedSource =
    state.sourceCandidates.find(
      (candidate) => candidate.categoryCode === categoryCode
    ) || null;

  state.sourceByEpisode = buildEpisodeMap(
    state.selectedSource ? state.selectedSource.articles : []
  );

  state.sourceCount = state.selectedSource
    ? countSourceArticles(state.selectedSource)
    : 0;

  state.episodeCount = clampEpisodeCount(state.sourceCount);

  renderSourceStatus();
  renderCountControl();
}

function countSourceArticles(candidate) {
  if (Array.isArray(candidate.articles)) return candidate.articles.length;

  const count = Number(candidate.count);

  return Number.isFinite(count) && count > 0 ? count : 0;
}

function renderSourceStatus() {
  if (!state.selectedSource) {
    el.sourceStatus.textContent = state.sourceError || '参照元が未選択です';
    el.sourceStatus.classList.add('warn');
    return;
  }

  if (!state.episodeCount) {
    el.sourceStatus.textContent = '参照元に記事がありません';
    el.sourceStatus.classList.add('warn');
    return;
  }

  el.sourceStatus.textContent =
    state.episodeCount === 1
      ? '最終回のみの1行を作成しました'
      : `第1回〜最終回の${state.episodeCount}行を作成しました`;

  el.sourceStatus.classList.remove('warn');
}

// ------------------------------------------------------------
// 再掲連載回数
//
// 参照元の記事数を初期値にするが、実際に何回で再掲するかは運用の判断。
// 回数を変えたら作業行を作り直す。入力済みの記事IDは
// state.idStash に退避してあるので、行が復活したときに戻る。
// ------------------------------------------------------------

// min には、参照元に記事が無いときの0行を許すかどうかを渡す。
// 画面から回数を変える場合は必ず1以上にする
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

function commitCountInput() {
  const value = parseCountInput(el.countInput.value);

  setEpisodeCount(Number.isFinite(value) ? value : state.episodeCount);
}

function setEpisodeCount(value) {
  // 参照元が未選択のうちは回数という概念自体が無い
  if (!state.selectedSource || !state.sourceCount) {
    renderCountControl();
    return;
  }

  const next = clampEpisodeCount(value, MIN_EPISODE_COUNT);

  if (next !== state.episodeCount) {
    state.episodeCount = next;

    buildRows();
    renderPrevTable();
    renderBottomTable();
    renderSourceStatus();
  }

  renderCountControl();
}

function renderCountControl() {
  const hasSource = Boolean(state.selectedSource) && state.sourceCount > 0;
  const count = state.episodeCount;

  el.countInput.disabled = !hasSource;
  el.countMinus.disabled = !hasSource || count <= MIN_EPISODE_COUNT;
  el.countPlus.disabled = !hasSource || count >= MAX_EPISODE_COUNT;
  el.countReset.disabled = !hasSource || count === state.sourceCount;

  // 入力中のカーソルが飛ばないよう、違うときだけ書き換える
  const text = hasSource ? String(count) : '';

  if (el.countInput.value !== text) el.countInput.value = text;

  if (!hasSource) {
    el.countSource.textContent = '参照元：—';
    el.countSource.classList.remove('warn');
    return;
  }

  const diff = count - state.sourceCount;

  el.countSource.textContent = diff
    ? `参照元：${state.sourceCount}回（${diff > 0 ? '+' : '−'}${Math.abs(diff)}回）`
    : `参照元：${state.sourceCount}回`;

  el.countSource.classList.toggle('warn', diff !== 0);
}

// 参照先は公開日時ではなく回数で突き合わせる。
// 「回数・数値」→「第N回」ラベル→並び順、の順に解決する。
// 「最終回」は数値もラベルも持たないことがあるため、
// 並び順（回数順ソート済み）からの推定を最後の手段として残す。
function resolveEpisodeNumber(article, index) {
  const numeric = Number(article && article.episodeNumber);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const match = String((article && article.episodeLabel) || '').match(
    /第(\d+)回/
  );

  if (match) {
    return Number(match[1]);
  }

  return index + 1;
}

function buildEpisodeMap(articles) {
  const map = new Map();

  if (!Array.isArray(articles)) return map;

  articles.forEach((article, index) => {
    const number = resolveEpisodeNumber(article, index);

    // 同じ回数が重複する場合は先に出てきた方を優先する
    if (!map.has(number)) {
      map.set(number, article);
    }
  });

  return map;
}

// ------------------------------------------------------------
// 作業行の生成
//
// 行数は再掲連載回数（初期値は参照元の記事数）に合わせる。
// 最後の行は参照元に次の回が残っていても必ず「最終回」とし、
// 記事下では続きを読むの代わりに固定文言を出す。
//
// 入力済みの記事IDは回数で覚えておき、
// 参照元を選び直しても、回数を増減しても同じ回に戻す。
// ------------------------------------------------------------

function buildRows() {
  stashRowInputs();

  state.rows = [];

  const total = state.episodeCount;

  if (!state.selectedSource || !total) return;

  const base = getFirstDeliveryParts();

  for (let index = 0; index < total; index++) {
    const number = index + 1;
    const isFinal = index === total - 1;

    state.rows.push({
      number,
      label: isFinal ? '最終回' : `第${number}回`,
      isFinal,

      // 再掲は毎日更新。第1回配信日時から1日ずつ足す
      planned: base ? addDays(base, index) : null,

      articleId: state.idStash.get(number) || '',
      articleTitle: state.titleStash.get(number) || '',

      // コピー済み表示の根拠。この回で実際にコピーしたHTMLを覚えておく
      copiedHtml: state.copiedStash.get(number) || '',

      el: null,
    });
  }
}

// 行を作り直す前に、今表示している記事ID・記事タイトルを回数ごとに退避する。
// 空にした行も空のまま覚える（消したはずの入力が復活しないように）
function stashRowInputs() {
  for (const row of state.rows) {
    state.idStash.set(row.number, String(row.articleId || ''));
    state.titleStash.set(row.number, String(row.articleTitle || ''));
    state.copiedStash.set(row.number, String(row.copiedHtml || ''));
  }
}

// ------------------------------------------------------------
// 公開予定日時
//
// 今回の記事は記事データアプリに無いため、公開日時は取得できない。
// GLO連載情報の「第1回配信日時」を日本時間で読み、そこから1日ずつ足す。
// ------------------------------------------------------------

function getFirstDeliveryParts() {
  return parseJstParts(state.series && state.series.firstDeliveryAt);
}

// kintoneの日時はUTC表記で返るため、必ずAsia/Tokyoに直してから使う。
// 実行環境のタイムゾーンに依存させない。
function parseJstParts(value) {
  if (!value) return null;

  const date = new Date(value);

  if (isNaN(date)) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type) => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : NaN;
  };

  const y = get('year');
  const m = get('month');
  const d = get('day');
  const hh = get('hour');
  const mi = get('minute');

  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }

  return {
    y,
    m,
    d,
    hh: Number.isFinite(hh) ? hh % 24 : 0,
    mi: Number.isFinite(mi) ? mi : 0,
  };
}

// 日本時間の壁時計をそのまま持ち回るため、
// 取り出した年月日時分から素のDateを組み立てて日数を足す。
function addDays(parts, days) {
  return new Date(parts.y, parts.m - 1, parts.d + days, parts.hh, parts.mi);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

// 一覧に小さく出す用：8/20 21:00
function fmtPlannedShort(date) {
  return (
    `${date.getMonth() + 1}/${date.getDate()} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

// 共通エリア用：2026/08/20 21:00
function fmtDateTime(parts) {
  if (!parts) return '未登録';

  return (
    `${parts.y}/${pad2(parts.m)}/${pad2(parts.d)} ` +
    `${pad2(parts.hh)}:${pad2(parts.mi)}`
  );
}

// 期間が見つからないときの確認用：2026/08/20
function fmtYmd(date) {
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(
    date.getDate()
  )}`;
}

// 期間の確認表示用：2026/8/23
function fmtYmdShort(date) {
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

// ------------------------------------------------------------
// タブ
// ------------------------------------------------------------

function switchTab(name) {
  state.activeTab = name === 'bottom' ? 'bottom' : 'prev';

  el.tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === state.activeTab;

    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  el.panelPrev.hidden = state.activeTab !== 'prev';
  el.panelBottom.hidden = state.activeTab !== 'bottom';
}

// ============================================================
// ① 前回記事タブ
//
// 今回作る記事のIDを各回に入力し、
// 第2回以降は「1つ前の行の今回の記事ID」を前回記事として使う。
// 過去の再掲記事をkintoneから取ってくることはしない。
// ============================================================

// タイトル未入力のままでもHTMLは作れる。その場合の差し込み文字
const PREV_TITLE_FALLBACK = '●▼■';

const PREV_COPY_LABEL = 'HTMLコピー';
const PREV_COPIED_LABEL = 'コピー済み ✓';

function renderPrevTable() {
  el.prevBody.textContent = '';

  if (!state.rows.length) {
    el.prevBody.appendChild(
      createEmptyRow(5, '参照元連載を選択すると作業行を作成します')
    );
    return;
  }

  // 前回記事タブは記事ID・記事タイトルの入力に集中する。
  // 公開予定日は記事下タブに出す
  state.rows.forEach((row, index) => {
    const tr = document.createElement('tr');

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
  cell.appendChild(
    createLine(`前回：${previous.label}／ID ${previousId}`)
  );

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
  row.el.button.textContent = copied ? PREV_COPIED_LABEL : PREV_COPY_LABEL;
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
    setBulkStatus('先に参照元連載を選択してください', true);
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
  // 再掲連載回数を増やしたときに貼り直さずに済む
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
      `（${ids.length - state.rows.length}件は再掲連載回数を超えています。` +
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
  el.bulkStatus.textContent = message;
  el.bulkStatus.classList.toggle('warn', Boolean(isWarn));
}

// ============================================================
// ② 記事下タブ
//
//   この話の続きを読む（最終回は固定文言）
//     ↓
//   連載一覧
//     ↓
//   イチオシ
//
// 連載一覧・イチオシはスプレッドシートC列を元にする。
// ただし再掲連載では【注目記事】【人気記事】の段落を落とす（後述）。
// 新連載作成アシスタントの <p>あ</p> 3行はここでは付けない。
// ============================================================

function renderBottomTable() {
  el.bottomBody.textContent = '';

  if (!state.rows.length) {
    el.bottomBody.appendChild(
      createEmptyRow(5, '参照元連載を選択すると作業行を作成します')
    );
    return;
  }

  for (const row of state.rows) {
    const link = resolveNextLink(row);
    const hit = findSheetRowForRow(row);
    // 連載記事一覧の誘導先は回によって変わる（通常回＝参照元／最終回＝今回）
    const bottomHtml = hit ? buildArticleBottomHtml(hit.html, row.isFinal) : '';

    const tr = document.createElement('tr');

    tr.appendChild(createCell(row.label, 'col-ep ep-no'));
    tr.appendChild(createPlannedCell(row));
    tr.appendChild(createNextCell(link));
    tr.appendChild(createSheetCell(row, hit, bottomHtml));

    const actionCell = document.createElement('td');
    actionCell.className = 'col-act';

    const reason = bottomCopyBlockReason(link, hit, bottomHtml);

    if (reason) {
      actionCell.appendChild(
        createDisabledButton('記事下まとめてコピー', reason)
      );
    } else {
      actionCell.appendChild(
        createCopyButton(
          '記事下まとめてコピー',
          () => `${link.html}\n${bottomHtml}`,
          '記事下HTMLをコピーしました',
          'strong'
        )
      );
    }

    tr.appendChild(actionCell);

    el.bottomBody.appendChild(tr);
  }
}

// 今回の第N回 → 参照元の第(N+1)回。公開日時ではなく回数で突き合わせる。
// kind が 'ok' か 'final' のときだけ html を持つ。
function resolveNextLink(row) {
  if (row.isFinal) {
    return { kind: 'final', html: buildFinalEpisodeHtml() };
  }

  if (!state.selectedSource) {
    return { kind: 'no-source', html: '' };
  }

  const nextNumber = row.number + 1;
  const source = state.sourceByEpisode.get(nextNumber);

  if (!source) {
    return { kind: 'no-episode', nextNumber, html: '' };
  }

  if (!source.articleId) {
    return { kind: 'no-id', nextNumber, source, html: '' };
  }

  return {
    kind: 'ok',
    nextNumber,
    source,
    html: buildNextArticleHtml(source.articleId, source.articleTitle),
  };
}

function createNextCell(link) {
  const cell = document.createElement('td');
  cell.className = 'col-next';

  if (link.kind === 'final') {
    cell.appendChild(
      createLine('本連載は今回で最終回です。ご愛読ありがとうございました。', 'final')
    );
    return cell;
  }

  if (link.kind === 'no-source') {
    cell.appendChild(createLine('参照元を選択してください', 'warn'));
    return cell;
  }

  if (link.kind === 'no-episode') {
    cell.appendChild(createLine('参照元に該当回がありません', 'warn'));

    cell.appendChild(
      createLine(
        state.sourceCount && link.nextNumber > state.sourceCount
          ? `参照元は${state.sourceCount}回まで（第${link.nextNumber}回が必要です）`
          : `参照元に第${link.nextNumber}回が見つかりません`,
        'sub'
      )
    );

    return cell;
  }

  if (link.kind === 'no-id') {
    cell.appendChild(
      createLine(
        `参照元 ${
          link.source.episodeLabel || `第${link.nextNumber}回`
        } に記事IDがありません`,
        'warn'
      )
    );
    return cell;
  }

  const source = link.source;

  cell.appendChild(
    createLine(
      `参照元 ${
        source.episodeLabel || `第${link.nextNumber}回`
      }／ID ${source.articleId}`,
      'mono-id'
    )
  );

  cell.appendChild(
    createLine(source.articleTitle || '（記事タイトルなし）', 'sub ellip')
  );

  return cell;
}

// 記事下リンク（連載一覧＋イチオシ）の状態。
// 誤ったHTMLを作らないよう、取れていない理由をそのまま出す。
function createSheetCell(row, hit, bottomHtml) {
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

  if (!row.planned) {
    cell.appendChild(
      createLine('記事下リンク：公開予定日を算出できません', 'warn')
    );
    cell.appendChild(
      createLine('第1回配信日時が未登録です', 'sub')
    );
    return cell;
  }

  if (!hit) {
    cell.appendChild(
      createLine('記事下リンク：該当期間が見つかりません', 'warn')
    );
    cell.appendChild(
      createLine(`予定公開日：${fmtYmd(row.planned)}`, 'sub')
    );
    return cell;
  }

  if (!bottomHtml) {
    cell.appendChild(
      createLine(`記事下：${fmtPeriodRange(hit.period)}（C列が空です）`, 'warn')
    );
    return cell;
  }

  // B列の「8月第四週 8/23（日）〜8/29（土）」はそのままでは読みにくいので、
  // 判定した年を含む期間だけを出す
  cell.appendChild(createLine(fmtPeriodRange(hit.period), 'range'));

  return cell;
}

// 期間の表示は 2026/8/23〜2026/8/29 の形に統一する
function fmtPeriodRange(period) {
  return `${fmtYmdShort(period.start)}〜${fmtYmdShort(period.end)}`;
}

// 揃っていないものを押せてしまうと誤ったHTMLが貼られるため、
// コピーできない場合はボタン自体を無効にして理由を出す
function bottomCopyBlockReason(link, hit, bottomHtml) {
  if (link.kind === 'no-source') {
    return '参照元が未選択です';
  }

  if (link.kind === 'no-episode') {
    return '参照元に該当回がありません';
  }

  if (link.kind === 'no-id') {
    return '参照元に記事IDがありません';
  }

  if (state.sheetStatus !== 'ok') {
    return state.sheetMessage
      ? `記事下データを取得できませんでした（${state.sheetMessage}）`
      : '記事下データを取得できませんでした';
  }

  if (!hit) {
    return '記事下リンクの該当期間が見つかりません';
  }

  if (!bottomHtml) {
    return '記事下リンクのC列が空です';
  }

  return '';
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

// 最終回の記事下は「続きを読む」の代わりにこの固定文言を置く
function buildFinalEpisodeHtml() {
  return '<p>本連載は今回で最終回です。ご愛読ありがとうございました。</p>';
}

// C列は「連載記事一覧 → 【イチオシ記事】 →【注目記事】→（定型文）」の並び。
// 古い行には【人気記事】も入っている。いずれも1つの <p>…</p> に収まっているので、
// 落とすときはその段落だけを丸ごと消す。
//
// 再掲連載で落とすものは通常回と最終回で違う。
//   通常回：【注目記事】【人気記事】を落とす（残すのは【イチオシ記事】）
//   最終回：【人気記事】だけ落とす（【注目記事】は残す）
// このため注目・人気を1本の正規表現にまとめず、ラベルごとに分けている。
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
//   通常回：まだ読める参照元連載へ送る（例：/category/gr1334）
//   最終回：今回作った再掲連載の一覧へ送る（例：/category/gr1974）
//
// 表示するタイトルもリンク先と揃える。食い違うと読者が別の連載に飛ばされる。
function getListTarget(isFinal) {
  const series = state.series;
  const source = state.selectedSource;

  const target = isFinal
    ? {
        categoryCode: (series && series.categoryCode) || '',
        bookTitle: (series && series.bookTitle) || '',
      }
    : {
        categoryCode: (source && source.categoryCode) || '',
        bookTitle: (source && source.bookTitle) || '',
      };

  return {
    categoryCode: String(target.categoryCode).trim(),
    bookTitle: stripBookTitleBrackets(target.bookTitle),
  };
}

// タイトル自体に『』が付いている場合は外す。
// テンプレート側に『』があるため二重化を防ぐ
function stripBookTitleBrackets(value) {
  const title = String(value || '').trim();
  const match = title.match(/^『(.*)』$/);

  return match ? match[1] : title;
}

// スプレッドシートC列HTMLのプレースホルダーを、
// その回の誘導先（通常回＝参照元／最終回＝今回）に置き換える。
function buildArticleBottomHtml(cHtml, isFinal) {
  // 置換より先に落とす。
  // 書籍タイトルを入れてから消すと、タイトル次第で判定が変わりうる
  let c = removeDroppedParagraphs(String(cHtml || '').trim(), isFinal).trim();

  if (!c) return '';

  const { categoryCode, bookTitle } = getListTarget(isFinal);

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

// 生成HTMLに埋め込む値のエスケープ。
// 記事タイトルに & や < が入っていてもCMS側で壊れないようにする。
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================
// スプレッドシート「毎月の記事下リンク」との突き合わせ
//
// 新連載作成アシスタントの parsePeriodParts() / assignRowYears() /
// findSheetRow() と同じ考え方をそのまま使う。
// B列に年が無く1年以上分の行が積み上がっているため、
// 行ごとの年を推定してから公開予定日と突き合わせる。
// ============================================================

// B列の期間文字列から 月日 を取り出す
//
// 実データには以下の表記ゆれがある。
//   「8/23（日）〜8/29（土）」  終了側に月あり
//   「6/1（日）～7（土）」      終了側は日のみ（月は開始と同じ）
//   「4/1～15」                 曜日なし・終了側は日のみ
// 波ダッシュは ～(U+FF5E) と 〜(U+301C) の両方が混在している。
function parsePeriodParts(text) {
  const line = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /\d{1,2}\s*\/\s*\d{1,2}/.test(l));

  if (!line) return null;

  const m = line.match(
    /(\d{1,2})\s*\/\s*(\d{1,2})[^0-9]*?[～〜~][^0-9]*?(?:(\d{1,2})\s*\/\s*)?(\d{1,2})/
  );

  if (!m) return null;

  const sm = +m[1];
  const sd = +m[2];
  const em = m[3] ? +m[3] : sm;
  const ed = +m[4];

  if (!sm || !sd || !em || !ed) return null;
  if (sm > 12 || em > 12 || sd > 31 || ed > 31) return null;

  return { sm, sd, em, ed };
}

// 最終行を anchorYear として、下から上へ年を割り当てる
function assignYearsFrom(parsed, idxs, anchorYear) {
  let year = anchorYear;
  let prevSm = null;

  for (let k = idxs.length - 1; k >= 0; k--) {
    const p = parsed[idxs[k]];
    if (prevSm !== null && p.parts.sm > prevSm) year -= 1;
    p.year = year;
    prevSm = p.parts.sm;
  }
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// B列には「8/23（日）」のように曜日が書かれている行が多い。
// 曜日は年を一意に特定できるため、割り当てた年の正しさを採点できる。
function scoreWeekdays(parsed, idxs) {
  let score = 0;

  for (const i of idxs) {
    const p = parsed[i];
    const m = String((p.row && p.row[0]) || '').match(
      /(\d{1,2})\s*\/\s*(\d{1,2})\s*[（(]\s*([日月火水木金土])\s*[）)]/
    );

    if (!m) continue;

    const d = new Date(p.year, p.parts.sm - 1, p.parts.sd);
    if (WEEKDAYS[d.getDay()] === m[3]) score += 1;
  }

  return score;
}

function assignRowYears(rows, today) {
  const parsed = rows.map((row) => ({
    row,
    parts: parsePeriodParts((row && row[0]) || ''),
    year: null,
  }));

  const idxs = parsed
    .map((p, i) => (p.parts ? i : -1))
    .filter((i) => i >= 0);

  if (!idxs.length) return parsed;

  // 「今日に近い年」だけで決めるとシートが数か月未更新のときにずれるため、
  // まずB列の曜日と一致する数で採点し、同点なら今日に近い年を採る。
  const last = parsed[idxs[idxs.length - 1]].parts;
  const ty = today.getFullYear();
  let best = null;

  for (const y of [ty - 2, ty - 1, ty, ty + 1]) {
    assignYearsFrom(parsed, idxs, y);

    const score = scoreWeekdays(parsed, idxs);
    const dist = Math.abs(new Date(y, last.sm - 1, last.sd) - today);

    if (
      !best ||
      score > best.score ||
      (score === best.score && dist < best.dist)
    ) {
      best = { y, score, dist };
    }
  }

  assignYearsFrom(parsed, idxs, best.y);

  return parsed;
}

// 20行前後を突き合わせるので、年の推定結果は使い回す
function getParsedSheetRows() {
  if (!Array.isArray(state.sheetRows)) return null;

  if (state.parsedSheetSource !== state.sheetRows) {
    state.parsedSheetRows = assignRowYears(state.sheetRows, new Date());
    state.parsedSheetSource = state.sheetRows;
  }

  return state.parsedSheetRows;
}

// 最終行から上方向へ検索し、最初に一致した行を採用する。
//
// 年を推定したうえで突き合わせるため、該当週の行がまだ無い場合は
// 「該当なし」になる。別の年の行に一致して古いリンクを貼ることを防ぐ。
function findSheetRowForRow(row) {
  const planned = row && row.planned;
  const parsed = getParsedSheetRows();

  if (!planned || !parsed) return null;

  // 時刻を落として日付だけで比較する
  const target = new Date(
    planned.getFullYear(),
    planned.getMonth(),
    planned.getDate()
  );

  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i];
    if (!p.parts || p.year === null) continue;

    const { sm, sd, em, ed } = p.parts;

    // 12/28〜1/3 のような年またぎは終了側の年を1つ進める
    const sy = p.year;
    const ey = em < sm ? p.year + 1 : p.year;

    const start = new Date(sy, sm - 1, sd);
    const end = new Date(ey, em - 1, ed);

    if (target >= start && target <= end) {
      return {
        period: {
          start,
          end,
          label: String((p.row && p.row[0]) || '')
            .replace(/\s*\n\s*/g, ' ')
            .trim(),
        },
        html: (p.row && p.row[1]) || '',
      };
    }
  }

  return null;
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

function createPlannedCell(row) {
  const cell = document.createElement('td');
  cell.className = 'col-date';

  if (!row.planned) {
    cell.textContent = '—';
    cell.classList.add('warn');
    cell.title = '第1回配信日時が未登録です';
    return cell;
  }

  cell.textContent = fmtPlannedShort(row.planned);
  cell.title = fmtYmd(row.planned);

  return cell;
}

function createLine(text, className) {
  const line = document.createElement('div');
  line.className = 'line' + (className ? ` ${className}` : '');
  line.textContent = text;
  line.title = text;
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
// 記事IDは画面で書き換わるため、描画時のテキストを持たせない。
function createCopyButton(label, getText, toastMessage, modifier) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'copy mini' + (modifier ? ` ${modifier}` : '');
  button.textContent = label;

  button.addEventListener('click', () => {
    if (button.disabled) return;

    const text = getText();

    if (!text) {
      showToast('コピーする内容がありません');
      return;
    }

    copyText(text).then((ok) => {
      if (ok) {
        button.classList.add('copied');
        showToast(toastMessage);
      } else {
        showToast('コピーできませんでした');
      }
    });
  });

  return button;
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
