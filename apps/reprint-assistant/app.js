/* ============================================================
   再掲連載作成アシスタント Ver.0.1

   ・kintoneへは直接アクセスしない。/api/reprint-data のみを使う
   ・APIトークン等の秘密情報はこのファイルに一切置かない
   ============================================================ */

const API_ENDPOINT = '/api/reprint-data';

// ------------------------------------------------------------
// 状態
// ------------------------------------------------------------

const state = {
  // APIレスポンスの currentSeries
  currentSeries: null,

  // APIレスポンスの sourceCandidates
  sourceCandidates: [],

  // 選択中の参照元（sourceCandidates の1要素）
  selectedSource: null,

  // 参照元の「回数 → 記事」対応表
  sourceByEpisode: new Map(),
};

// コピー用テキストはHTMLに埋め込まず、ここに退避して index で引く。
// data-* に入れると引用符やタグのエスケープ事故が起きるため。
const copyTexts = [];

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------

const el = {
  codeInput: document.getElementById('code-input'),
  fetchBtn: document.getElementById('fetch-btn'),
  fetchStatus: document.getElementById('fetch-status'),

  warnings: document.getElementById('warnings'),
  warningsList: document.getElementById('warnings-list'),

  sectionCurrent: document.getElementById('section-current'),
  currentTitle: document.getElementById('current-title'),
  currentCode: document.getElementById('current-code'),
  currentCount: document.getElementById('current-count'),
  currentType: document.getElementById('current-type'),

  sectionSource: document.getElementById('section-source'),
  sourceSelect: document.getElementById('source-select'),
  sourceStatus: document.getElementById('source-status'),

  sectionArticles: document.getElementById('section-articles'),
  articlesCount: document.getElementById('articles-count'),
  articleList: document.getElementById('article-list'),

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
  renderArticles();
});

// コピーボタンは一箇所で受ける
document.addEventListener('click', (event) => {
  const button = event.target.closest('button.copy');

  if (!button) return;

  const index = Number(button.dataset.copyIndex);

  if (!Number.isInteger(index) || !copyTexts[index]) {
    showToast('コピーする内容がありません');
    return;
  }

  copyText(copyTexts[index]).then((ok) => {
    if (ok) {
      button.classList.add('copied');
      showToast(button.dataset.copyLabel || 'コピーしました');
    } else {
      showToast('コピーできませんでした');
    }
  });
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

    if (!response.ok || !json || json.status !== 'ok') {
      const message =
        (json && (json.error || json.status)) ||
        `取得に失敗しました（HTTP ${response.status}）`;

      resetView();
      setStatus(message, true);
      return;
    }

    state.currentSeries = json.currentSeries || null;
    state.sourceCandidates = Array.isArray(json.sourceCandidates)
      ? json.sourceCandidates
      : [];

    renderWarnings(json.warnings);
    renderCurrentSeries();
    renderSourceCandidates();
    renderArticles();

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
  state.currentSeries = null;
  state.sourceCandidates = [];
  state.selectedSource = null;
  state.sourceByEpisode = new Map();

  copyTexts.length = 0;

  el.warnings.hidden = true;
  el.warningsList.textContent = '';

  el.sectionCurrent.hidden = true;
  el.sectionSource.hidden = true;
  el.sectionArticles.hidden = true;

  el.sourceSelect.textContent = '';
  el.articleList.textContent = '';
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
// 今回の再掲情報
// ------------------------------------------------------------

function renderCurrentSeries() {
  const series = state.currentSeries;

  if (!series) {
    el.sectionCurrent.hidden = true;
    return;
  }

  el.currentTitle.textContent = series.bookTitle || '（書籍タイトルなし）';
  el.currentCode.textContent = series.categoryCode || '—';
  el.currentCount.textContent = String(series.count || 0);
  el.currentType.textContent = series.serialType || '—';

  el.sectionCurrent.hidden = false;
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
    el.sectionSource.hidden = false;
    return;
  }

  el.sourceSelect.disabled = false;

  // 自動確定はしないが、先頭候補は初期表示にしてよい
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

  el.sectionSource.hidden = false;
}

function applySourceSelection(categoryCode) {
  state.selectedSource =
    state.sourceCandidates.find(
      (candidate) => candidate.categoryCode === categoryCode
    ) || null;

  state.sourceByEpisode = buildEpisodeMap(
    state.selectedSource ? state.selectedSource.articles : []
  );

  if (!state.selectedSource) {
    el.sourceStatus.textContent = '参照元が未選択です';
    el.sourceStatus.classList.add('warn');
    return;
  }

  const current = state.currentSeries;
  const currentCount = current ? Number(current.count || 0) : 0;
  const sourceCount = Number(state.selectedSource.count || 0);

  if (currentCount && sourceCount && currentCount !== sourceCount) {
    el.sourceStatus.textContent =
      `回数が一致しません（今回 ${currentCount}回 / 参照元 ${sourceCount}回）`;
    el.sourceStatus.classList.add('warn');
  } else {
    el.sourceStatus.textContent = `参照元 ${sourceCount}回`;
    el.sourceStatus.classList.remove('warn');
  }
}

// ------------------------------------------------------------
// 回数の解決
//
// 参照先は公開日時ではなく回数で突き合わせる。
// 「回数・数値」→「第N回」ラベル→並び順、の順に解決する。
// 「最終回」は数値もラベルも持たないことがあるため、
// 並び順（回数順ソート済み）からの推定を最後の手段として残す。
// ------------------------------------------------------------

function resolveEpisodeNumber(article, index) {
  const numeric = Number(article && article.episodeNumber);

  if (Number.isFinite(numeric) && numeric > 0) {
    return { number: numeric, inferred: false };
  }

  const match = String((article && article.episodeLabel) || '').match(/第(\d+)回/);

  if (match) {
    return { number: Number(match[1]), inferred: false };
  }

  return { number: index + 1, inferred: true };
}

function buildEpisodeMap(articles) {
  const map = new Map();

  if (!Array.isArray(articles)) return map;

  articles.forEach((article, index) => {
    const { number } = resolveEpisodeNumber(article, index);

    // 同じ回数が重複する場合は先に出てきた方を優先する
    if (!map.has(number)) {
      map.set(number, article);
    }
  });

  return map;
}

// ------------------------------------------------------------
// 記事一覧
// ------------------------------------------------------------

function renderArticles() {
  const series = state.currentSeries;

  copyTexts.length = 0;
  el.articleList.textContent = '';

  if (!series || !Array.isArray(series.articles) || !series.articles.length) {
    el.sectionArticles.hidden = true;
    return;
  }

  el.articlesCount.textContent = `全${series.articles.length}件`;

  series.articles.forEach((article, index) => {
    el.articleList.appendChild(buildArticleCard(article, index));
  });

  el.sectionArticles.hidden = false;
}

function buildArticleCard(article, index) {
  const { number } = resolveEpisodeNumber(article, index);

  const card = document.createElement('article');
  card.className = 'ep-card';

  // ---- 見出し行：回数 / タイトル / 記事ID ----
  const head = document.createElement('div');
  head.className = 'ep-head';

  const no = document.createElement('span');
  no.className = 'ep-no';
  no.textContent = article.episodeLabel || `第${number}回`;

  const title = document.createElement('span');
  title.className = 'ep-title';
  title.textContent = article.articleTitle || '（記事タイトルなし）';
  title.title = article.articleTitle || '';

  const id = document.createElement('span');
  id.className = 'ep-id';
  id.textContent = article.articleId ? `ID ${article.articleId}` : 'ID なし';

  head.append(no, title, id);

  // ---- 本体：前回 / 続き ----
  const body = document.createElement('div');
  body.className = 'ep-body';

  body.appendChild(buildPreviousBlock(article, index));
  body.appendChild(buildNextBlock(article, number));

  card.append(head, body);

  return card;
}

// ---- 【前回の記事を読む】 ----

function buildPreviousBlock(article, index) {
  const block = createBlock('前回の記事を読む');

  if (index === 0) {
    block.appendChild(createValue('なし', 'muted'));
    return block;
  }

  const previous = article.previousArticle;

  if (!previous) {
    block.appendChild(createValue('前回記事が取得できませんでした', 'warn'));
    return block;
  }

  block.appendChild(
    createValue(
      `前回：${previous.episodeLabel || '（回数不明）'} / ID ${
        previous.articleId || 'なし'
      }`
    )
  );

  if (previous.articleTitle) {
    block.appendChild(createSubValue(previous.articleTitle));
  }

  if (article.previousHtml) {
    block.appendChild(
      createCopyButton(
        article.previousHtml,
        '前回記事HTMLをコピー',
        '前回記事HTMLをコピーしました'
      )
    );
  } else {
    block.appendChild(createValue('前回記事の記事IDがありません', 'warn'));
  }

  return block;
}

// ---- 【この話の続きを読む】 ----

function buildNextBlock(article, number) {
  const block = createBlock('この話の続きを読む');

  if (article.isFinal) {
    block.appendChild(
      createValue(
        '本連載は今回で最終回です。ご愛読ありがとうございました。',
        'final'
      )
    );
    return block;
  }

  if (!state.selectedSource) {
    block.appendChild(createValue('参照元を選択してください', 'warn'));
    return block;
  }

  const nextNumber = number + 1;
  const source = state.sourceByEpisode.get(nextNumber);

  if (!source) {
    block.appendChild(createValue('参照元に該当回がありません', 'warn'));
    return block;
  }

  if (!source.articleId) {
    block.appendChild(
      createValue(
        `参照元 ${source.episodeLabel || `第${nextNumber}回`} に記事IDがありません`,
        'warn'
      )
    );
    return block;
  }

  block.appendChild(
    createValue(
      `参照元：${source.episodeLabel || `第${nextNumber}回`} / ID ${source.articleId}`
    )
  );

  block.appendChild(
    createSubValue(source.articleTitle || '（記事タイトルなし）')
  );

  block.appendChild(
    createCopyButton(
      buildNextArticleHtml(source.articleId, source.articleTitle),
      '続きを読むHTMLをコピー',
      '続きを読むHTMLをコピーしました'
    )
  );

  return block;
}

// ------------------------------------------------------------
// 「この話の続きを読む」HTML
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

// 生成HTMLに埋め込む値のエスケープ。
// 記事タイトルに & や < が入っていてもCMS側で壊れないようにする。
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ------------------------------------------------------------
// パーツ生成
// ------------------------------------------------------------

function createBlock(labelText) {
  const block = document.createElement('div');
  block.className = 'ep-block';

  const label = document.createElement('div');
  label.className = 'ep-label';
  label.textContent = labelText;

  block.appendChild(label);

  return block;
}

function createValue(text, modifier) {
  const value = document.createElement('div');
  value.className = 'ep-value' + (modifier ? ` ${modifier}` : '');
  value.textContent = text;
  return value;
}

function createSubValue(text) {
  const value = document.createElement('div');
  value.className = 'ep-subvalue';
  value.textContent = text;
  value.title = text;
  return value;
}

function createCopyButton(text, label, toastMessage) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'copy mini';
  button.textContent = label;

  copyTexts.push(text);
  button.dataset.copyIndex = String(copyTexts.length - 1);
  button.dataset.copyLabel = toastMessage;

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
