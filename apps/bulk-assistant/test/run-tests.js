/* ============================================================
   新規一括集中アシスタント 回帰テスト

   ブラウザ用の app.js を、最小限のDOMスタブを噛ませてNodeで動かす。
   ビルドもテストフレームワークも使わない。

     node apps/bulk-assistant/test/run-tests.js

   検証したいのは「誤ったHTMLを作らないこと」なので、
   見た目ではなく生成HTMLと、コピーを止める条件を中心に確認する。

   日付は 2026/08/19（水）に固定する。
   記事下シートのB列には年が無く、実行日から年を推定するため、
   固定しないと数年後にテストが落ちるだけの作りになってしまう。
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_PATH = path.join(__dirname, '..', 'app.js');
const TODAY_MS = new Date(2026, 7, 19, 10, 0, 0).getTime();

// ------------------------------------------------------------
// DOMスタブ
// ------------------------------------------------------------

function makeNode(tagName) {
  const classes = new Set();
  const handlers = new Map();

  const node = {
    tagName: String(tagName || '').toUpperCase(),
    children: [],
    ownText: '',
    dataset: {},
    style: {},
    title: '',
    type: '',
    value: '',
    placeholder: '',
    disabled: false,
    hidden: false,
    inputMode: '',
    autocomplete: '',
    spellcheck: true,
    colSpan: 1,

    classList: {
      add(...names) {
        names.forEach((name) => name && classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains(name) {
        return classes.has(name);
      },
    },

    appendChild(child) {
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter((c) => c !== child);
      return child;
    },
    setAttribute(name, value) {
      if (name === 'aria-label') node.ariaLabel = value;
    },
    removeAttribute() {},
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    dispatch(type, event) {
      const fn = handlers.get(type);
      if (fn) fn(event || {});
    },
    select() {},
    focus() {},

    // 親をたどらない簡易版。'input.id-input, input.title-input' のような
    // 「タグ＋クラス」だけを見て、自分自身が一致するかを返す
    closest(selector) {
      const match = String(selector || '')
        .split(',')
        .map((part) => part.trim())
        .some((part) => {
          const [tag, ...names] = part.split('.');
          if (tag && tag.toUpperCase() !== node.tagName) return false;
          return names.every((name) => classes.has(name));
        });

      return match ? node : null;
    },
    querySelector() {
      return makeNode('div');
    },
    querySelectorAll() {
      return [];
    },
  };

  Object.defineProperty(node, 'className', {
    get() {
      return [...classes].join(' ');
    },
    set(value) {
      classes.clear();
      String(value || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classes.add(name));
    },
  });

  Object.defineProperty(node, 'textContent', {
    get() {
      if (!node.children.length) return node.ownText;
      return node.children.map((c) => c.textContent).join('');
    },
    set(value) {
      node.children = [];
      node.ownText = String(value == null ? '' : value);
    },
  });

  return node;
}

// 表示テキストの確認用。行ごとに改行で区切って読めるようにする
function textOf(node) {
  if (!node) return '';
  if (!node.children.length) return node.ownText;
  return node.children.map(textOf).join('\n');
}

function findNodes(node, predicate, found = []) {
  if (!node) return found;
  if (predicate(node)) found.push(node);
  node.children.forEach((child) => findNodes(child, predicate, found));
  return found;
}

// ------------------------------------------------------------
// app.js の読み込み
//
// 1件ごとに読み直して状態を完全に分離する。
// state を跨いだ取り違えでテストが通ってしまうのを防ぐ。
// ------------------------------------------------------------

const APP_SOURCE =
  fs.readFileSync(APP_PATH, 'utf8') +
  `
;globalThis.__exports = {
  state, el,
  MIN_EPISODE_COUNT, MAX_EPISODE_COUNT, DEFAULT_EPISODE_COUNT,
  PREV_TITLE_FALLBACK, PREV_COPY_LABEL, COPIED_LABEL, TAB_NAMES, FINAL_MESSAGE,
  clampEpisodeCount, parseCountInput, setEpisodeCount, commitCountInput,
  syncBulkInputs, setBulkStatus,
  getCategoryCode, toCategoryDigits, isCodeQuery, renderCandidates,
  buildRows, renderPrevTable, updatePrevRow, renderCommon,
  applyBulkValues, clearArticleIds, clearArticleTitles, splitBulkLines,
  buildPreviousHtmlFor, buildPreviousArticleHtml,
  renderBottomTable, resolveNextLink, bottomCopyBlockReason, sheetBlockReason,
  buildNextArticleHtml, buildFinalEpisodeHtml, joinBottomHtml,
  buildArticleBottomHtml, removeDroppedParagraphs, getListTarget,
  buildRowDates, initPubFields, parseDateInput, parseTimeInput, fmtDateInput,
  renderPubGroups, normalizePubGroups, addPubGroup, removePubGroup,
  applyPubGroupChange, isGroupStartRow,
  findSheetRowForRow, parsePeriodParts, assignRowYears, fmtPeriodRange, fmtYmd,
  findRiskyTitleParts, switchTab, escapeHtml,
};
`;

const RealDate = Date;

class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(TODAY_MS);
    else super(...args);
  }
  static now() {
    return TODAY_MS;
  }
}

function loadApp() {
  const document = {
    getElementById: () => makeNode('div'),
    querySelector: () => makeNode('div'),
    querySelectorAll: () => [],
    createElement: (tag) => makeNode(tag),
    body: makeNode('body'),
    execCommand: () => true,
  };

  const sandbox = {
    document,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Date: FixedDate,
    location: { search: '' },
    history: { replaceState() {} },
    navigator: {},
    // 起動時のシート取得が後から表を作り直すと、テストの途中で状態が入れ替わる。
    // 決着しないPromiseを返して、通信は起きなかったものとして扱う
    fetch: () => new Promise(() => {}),
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(APP_SOURCE, sandbox, { filename: 'app.js' });

  return sandbox.__exports;
}

// ------------------------------------------------------------
// テストデータ
// ------------------------------------------------------------

const SERIES = {
  recordId: '2161',
  categoryCode: 'gr1974',
  bookTitle: '七つのショートしょーと',
  firstDeliveryAt: '2026-08-28T10:00:00Z',
  productionNo: '22818',
  kintoneUrl: 'https://example.cybozu.com/k/402/show#record=2161',
};

// スプレッドシートC列。実データに合わせて先頭に余白の段落を置き、
// 【注目記事】【人気記事】も入れて落とし分けを確認できるようにする。
// イチオシの記事IDを週ごとに変えて、週の切り替わりを確認できるようにする
function makeC(pickupId) {
  return [
    '<p>　</p>',
    '',
    '<p><span style="font-size:20px;">👉<a href="/category/grxxxx" target="_blank"><span style="color:#0000FF;">『xxxxxxxx』連載記事一覧は<u>こちら</u></span></a></span></p>',
    '',
    `<p><a href="/articles/-/${pickupId}" target="_blank"><strong><span style="color:#0000CD;">【イチオシ記事】</span></strong></a></p>`,
    '',
    '<p align="center"><strong><span>【注目記事】</span></strong><br />',
    '<a href="/articles/-/40002">注目のタイトル</a></p>',
    '',
    '<p><strong>【人気記事】</strong><br />',
    '<a href="/articles/-/40003">人気のタイトル</a></p>',
    '',
    '<p>　</p>',
    '',
    '<p>ゴールドライフオンライン（GLO）は、表現者を応援するウェブメディアです。<br />',
    'ゴールドライフオンライン（GLO）編集部：glo_henshu＠gentosha.co.jp</p>',
  ].join('\n');
}

const C_HTML = makeC('40001');

// 2026年の曜日で書く（8/16・8/23・8/30 が日曜）
const SHEET_ROWS = [
  ['8月第三週\n8/16（日）〜8/22（土）', makeC('41111')],
  ['8月第四週\n8/23（日）〜8/29（土）', makeC('42222')],
  ['9月第一週\n8/30（日）〜9/5（土）', makeC('43333')],
];

// 一括公開日 2026/08/18（火）21:00。
// GLO公開は全回 8/18、外部配信は 8/18 から1日ずつ
const PUB_DATE = '2026-08-18';
const PUB_TIME = '21:00';

// ------------------------------------------------------------
// セットアップ
// ------------------------------------------------------------

function setup(options = {}) {
  const app = loadApp();
  const { state } = app;

  const sheetRows =
    options.sheetRows === undefined ? SHEET_ROWS : options.sheetRows;

  state.sheetStatus = options.sheetStatus || (sheetRows ? 'ok' : 'error');
  state.sheetMessage = options.sheetMessage || '';
  state.sheetRows = sheetRows;

  // 取得済みかどうかは「失敗した」と書き分けるための別のフラグ。
  // テストでは取得を1回通した状態を既定にする
  state.sheetFetched =
    options.sheetFetched === undefined ? true : options.sheetFetched;

  state.series = options.series === undefined ? SERIES : options.series;

  // グループはアプリ側で書き換わる（追加・削除・並べ替え）。
  // テスト間で共有すると前のテストの結果を引きずるのでコピーを渡す
  state.pubGroups = options.pubGroups
    ? options.pubGroups.map((group) => ({ ...group }))
    : [
        {
          startNumber: 1,
          date: options.pubDate === undefined ? PUB_DATE : options.pubDate,
          mode: options.mode || 'bulk',
          time: options.pubTime === undefined ? PUB_TIME : options.pubTime,
        },
      ];

  app.renderPubGroups();

  if (options.episodeCount) app.setEpisodeCount(options.episodeCount);

  // 回数が既定と同じときは行が作り直されないので、日付は明示的に入れ直す
  app.buildRowDates();

  app.renderPrevTable();
  app.renderBottomTable();

  return app;
}

// その回の記事下C列（週判定の結果）を取り出す
function weekHtmlOf(app, index) {
  const hit = app.findSheetRowForRow(app.state.rows[index]);

  return hit ? hit.html : '';
}

// 画面で入力したときと同じ経路（prevBody の input イベント）を通す。
// 値を直接書き換えるとイベント配線の不具合を見逃すため
function typeInto(app, index, { id, title }) {
  const row = app.state.rows[index];

  if (id !== undefined) {
    row.el.input.value = id;
    app.el.prevBody.dispatch('input', { target: row.el.input });
  }

  if (title !== undefined) {
    row.el.titleInput.value = title;
    app.el.prevBody.dispatch('input', { target: row.el.titleInput });
  }
}

// 回数欄に入力したときと同じ経路を通す
function setCountByInput(app, value) {
  app.el.prevCount.value = String(value);
  app.el.prevCount.dispatch('input');
  app.el.prevCount.dispatch('change');
}

function pasteIds(app, text) {
  app.el.bulkInput.value = text;
  app.el.bulkApply.dispatch('click');
}

function pasteTitles(app, text) {
  app.el.bulkTitleInput.value = text;
  app.el.bulkApply.dispatch('click');
}

// ②の行から、コピーボタンと表示テキストを取り出す
function bottomRow(app, index) {
  const tr = app.el.bottomBody.children[index];

  return {
    tr,
    text: textOf(tr),
    button: findNodes(tr, (node) => node.tagName === 'BUTTON')[0] || null,
  };
}

// ------------------------------------------------------------
// 最小のテストランナー
// ------------------------------------------------------------

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
}

// コピー処理だけは非同期なので、Promiseを返すテストも受け付ける
const pending = [];

function check(name, fn) {
  const entry = { group: currentGroup, name, ok: false, detail: '' };

  results.push(entry);

  const settle = (value) => {
    entry.ok = value === true;
    if (!entry.ok) {
      entry.detail = typeof value === 'string' ? value : '期待と異なります';
    }
  };

  const fail = (error) => {
    entry.ok = false;
    entry.detail = `例外：${error && error.message}`;
  };

  try {
    const value = fn();

    if (value && typeof value.then === 'function') {
      pending.push(value.then(settle, fail));
    } else {
      settle(value);
    }
  } catch (error) {
    fail(error);
  }
}

// ============================================================
// 1. カテゴリコード入力
// ============================================================

group('連載の検索');

check('数字だけ入力すると gr を付けて問い合わせる', () => {
  const app = loadApp();

  app.el.searchInput.value = '1974';

  return app.getCategoryCode() === 'gr1974' || `→ ${app.getCategoryCode()}`;
});

check('gr 付きで貼り付けても二重にならない', () => {
  const app = loadApp();

  const got = ['gr1974', 'GR1974', ' gr1974 '].map((value) => {
    app.el.searchInput.value = value;
    return app.getCategoryCode();
  });

  return got.every((code) => code === 'gr1974') || `→ ${got.join(',')}`;
});

check('全角数字を半角に直す', () => {
  const app = loadApp();

  app.el.searchInput.value = '１９７４';

  return app.getCategoryCode() === 'gr1974' || `→ ${app.getCategoryCode()}`;
});

check('数字だけならコード、それ以外は書籍名の検索に回す', () => {
  const app = loadApp();

  const code = ['1974', 'gr1974', 'GR1974', '１９７４', ' 1974 '];
  const text = ['母が母', '母が母でなくなった日', 'gr', '七つの2', ''];

  return (
    (code.every((v) => app.isCodeQuery(v) === true) &&
      text.every((v) => app.isCodeQuery(v) === false)) ||
    '→ 判定が違います'
  );
});

check('候補を出して、押すとその連載のコードが分かる', () => {
  const app = loadApp();

  app.renderCandidates([
    {
      recordId: '2161',
      categoryCode: 'gr1974',
      bookTitle: '母が母でなくなった日',
      productionNo: '22818',
    },
    {
      recordId: '2100',
      categoryCode: 'gr1900',
      bookTitle: '母が母でなくなった日（続）',
      productionNo: '22000',
    },
  ]);

  const buttons = findNodes(
    app.el.candidatesList,
    (node) => node.tagName === 'BUTTON'
  );

  return (
    (app.el.candidates.hidden === false &&
      buttons.length === 2 &&
      buttons[0].dataset.code === 'gr1974' &&
      textOf(buttons[0]).includes('母が母でなくなった日') &&
      textOf(buttons[0]).includes('制作No 22818')) ||
    `→ ${buttons.length} / ${textOf(buttons[0])}`
  );
});

check('カテゴリIDが無い候補は選べない', () => {
  const app = loadApp();

  app.renderCandidates([
    { recordId: '1', categoryCode: '', bookTitle: 'コード未登録の連載' },
  ]);

  const button = findNodes(
    app.el.candidatesList,
    (node) => node.tagName === 'BUTTON'
  )[0];

  return (
    (button.disabled === true && button.title.includes('カテゴリID')) ||
    `→ ${button.disabled} / ${button.title}`
  );
});

check('候補が無ければ一覧そのものを閉じる', () => {
  const app = loadApp();

  app.renderCandidates([
    { recordId: '1', categoryCode: 'gr1', bookTitle: 'あ' },
  ]);
  app.renderCandidates([]);

  return (
    (app.el.candidates.hidden === true &&
      app.el.candidatesList.children.length === 0) ||
    '→ 一覧が残っています'
  );
});

// ============================================================
// 2. 起動と回数
// ============================================================

group('起動と回数');

check('開いた時点で既定の回数ぶん行ができている', () => {
  const app = loadApp();

  return (
    (app.state.episodeCount === app.DEFAULT_EPISODE_COUNT &&
      app.state.rows.length === app.DEFAULT_EPISODE_COUNT &&
      app.el.prevBody.children.length === app.DEFAULT_EPISODE_COUNT) ||
    `→ ${app.state.episodeCount} / ${app.state.rows.length}`
  );
});

check('全回とも第N回で通す（最終回とは呼ばない）', () => {
  const app = loadApp();

  setCountByInput(app, 4);

  const labels = app.state.rows.map((row) => row.label);

  return (
    labels.join(',') === '第1回,第2回,第3回,第4回' || `→ ${labels.join(',')}`
  );
});

check('一番最後の回だけ isFinal が立つ', () => {
  const app = loadApp();

  setCountByInput(app, 4);

  const flags = app.state.rows.map((row) => (row.isFinal ? '1' : '0'));

  return flags.join('') === '0001' || `→ ${flags.join('')}`;
});

check('1回だけのときはその回が一番最後の回になる', () => {
  const app = loadApp();

  setCountByInput(app, 1);

  return (
    (app.state.rows.length === 1 &&
      app.state.rows[0].label === '第1回' &&
      app.state.rows[0].isFinal === true) ||
    `→ ${app.state.rows.map((r) => r.label).join(',')}`
  );
});

check('全角数字で入力しても読める', () => {
  const app = loadApp();

  setCountByInput(app, '１２');

  return app.state.episodeCount === 12 || `→ ${app.state.episodeCount}`;
});

check('下限は1・上限は200で止まる', () => {
  const app = loadApp();

  app.setEpisodeCount(0);
  const low = app.state.episodeCount;

  app.setEpisodeCount(999);
  const high = app.state.episodeCount;

  return (
    (low === app.MIN_EPISODE_COUNT && high === app.MAX_EPISODE_COUNT) ||
    `→ ${low} / ${high}`
  );
});

check('読めない値を確定したら今の回数に戻す', () => {
  const app = loadApp();

  setCountByInput(app, 5);

  app.el.prevCount.value = 'あ';
  app.el.prevCount.dispatch('change');

  return (
    (app.state.episodeCount === 5 && app.el.prevCount.value === '5') ||
    `→ ${app.state.episodeCount} / ${app.el.prevCount.value}`
  );
});

check('回数を減らして戻すと入力が復活する', () => {
  const app = loadApp();

  setCountByInput(app, 10);
  typeInto(app, 9, { id: '30010', title: '10回目のタイトル' });

  setCountByInput(app, 8);
  setCountByInput(app, 10);

  const row = app.state.rows[9];

  return (
    (row.articleId === '30010' && row.articleTitle === '10回目のタイトル') ||
    `→ ${row.articleId} / ${row.articleTitle}`
  );
});

check('空にした行は空のまま覚える（復活させない）', () => {
  const app = loadApp();

  setCountByInput(app, 3);
  typeInto(app, 2, { id: '30003' });
  typeInto(app, 2, { id: '' });

  setCountByInput(app, 2);
  setCountByInput(app, 3);

  return (
    app.state.rows[2].articleId === '' || `→ ${app.state.rows[2].articleId}`
  );
});

// ============================================================
// 3. ① 前回記事の表示
// ============================================================

group('① 前回記事の表示');

check('第1回にはコピーボタンを作らない', () => {
  const app = loadApp();

  return app.state.rows[0].el.button === null || '→ ボタンがある';
});

check('第1回の前回記事欄は「なし」', () => {
  const app = loadApp();

  return (
    app.state.rows[0].el.prevCell.textContent === 'なし' ||
    `→ ${app.state.rows[0].el.prevCell.textContent}`
  );
});

check('前回の記事IDが無ければコピーを止める', () => {
  const app = loadApp();

  const row = app.state.rows[1];

  return (
    (row.el.button.disabled === true &&
      row.el.prevCell.textContent === '前回の記事IDを入力してください') ||
    `→ ${row.el.button.disabled} / ${row.el.prevCell.textContent}`
  );
});

check('前回の記事IDを入れるとコピーできるようになる', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  const row = app.state.rows[1];
  const text = textOf(row.el.prevCell);

  return (
    (row.el.button.disabled === false &&
      text.includes('前回：第1回／ID 30001') &&
      text.includes('第1回のタイトル')) ||
    `→ ${row.el.button.disabled} / ${text}`
  );
});

check('タイトル未入力でもコピーはできる', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001' });

  const row = app.state.rows[1];

  return (
    (row.el.button.disabled === false &&
      textOf(row.el.prevCell).includes('タイトル未入力')) ||
    `→ ${row.el.button.disabled} / ${textOf(row.el.prevCell)}`
  );
});

check('タイトルの文字数を出す（絵文字は1文字）', () => {
  const app = loadApp();

  typeInto(app, 0, { title: 'あいう😀' });

  return (
    app.state.rows[0].el.titleCount.textContent === '4文字' ||
    `→ ${app.state.rows[0].el.titleCount.textContent}`
  );
});

// ============================================================
// 4. ① 生成HTML
// ============================================================

group('① 生成HTML');

const EXPECTED_PREV =
  '<p align="center">' +
  '<a href="/articles/-/30001" target="_blank">' +
  '<strong><span style="color:#0000CD;">' +
  '【前回の記事を読む】第1回のタイトル' +
  '</span></strong></a></p>';

check('前回記事HTMLが期待どおり', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  const html = app.buildPreviousHtmlFor(1);

  return html === EXPECTED_PREV || `→ ${html}`;
});

check('タイトル未入力なら ●▼■ を差し込む', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001' });

  const html = app.buildPreviousHtmlFor(1);

  return (
    html.includes(`【前回の記事を読む】${app.PREV_TITLE_FALLBACK}`) || `→ ${html}`
  );
});

check('IDが無ければHTMLを作らない', () => {
  const app = loadApp();

  return app.buildPreviousHtmlFor(1) === '' || '→ HTMLができてしまう';
});

check('タイトルの記号をエスケープする', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001', title: '母と娘の<話>&"引用"' });

  const html = app.buildPreviousHtmlFor(1);

  return (
    (html.includes('母と娘の&lt;話&gt;&amp;&quot;引用&quot;') &&
      !html.includes('<話>')) ||
    `→ ${html}`
  );
});

check('参照するのは1つ前の回（第3回は第2回を見る）', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001', title: '一' });
  typeInto(app, 1, { id: '30002', title: '二' });

  const html = app.buildPreviousHtmlFor(2);

  return (
    (html.includes('/articles/-/30002') && html.includes('】二')) || `→ ${html}`
  );
});

// ============================================================
// 5. ① コピー済み表示
// ============================================================

group('① コピー済み表示');

check('コピーすると「コピー済み ✓」になる', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  const button = app.state.rows[1].el.button;

  button.dispatch('click');

  return Promise.resolve().then(() =>
    Promise.resolve().then(
      () =>
        (button.textContent === app.COPIED_LABEL &&
          button.classList.contains('copied')) ||
        `→ ${button.textContent}`
    )
  );
});

check('前の回の入力を直すとコピー済みが外れる', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  const button = app.state.rows[1].el.button;

  button.dispatch('click');

  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      typeInto(app, 0, { title: '直したタイトル' });

      return (
        (button.textContent === app.PREV_COPY_LABEL &&
          !button.classList.contains('copied')) ||
        `→ ${button.textContent}`
      );
    });
});

check('①のコピー済みは回ごとに残る（他の回は消さない）', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001', title: '一' });
  typeInto(app, 1, { id: '30002', title: '二' });

  const second = app.state.rows[1].el.button;
  const third = app.state.rows[2].el.button;

  second.dispatch('click');

  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      third.dispatch('click');
      return Promise.resolve().then(() => Promise.resolve());
    })
    .then(
      () =>
        (second.textContent === app.COPIED_LABEL &&
          third.textContent === app.COPIED_LABEL) ||
        `→ ${second.textContent} / ${third.textContent}`
    );
});

// ============================================================
// 6. 記事IDの一括貼り付け
// ============================================================

group('記事IDの一括貼り付け');

check('改行区切りで各回に入る', () => {
  const app = loadApp();

  setCountByInput(app, 3);
  pasteIds(app, '30001\n30002\n30003');

  const ids = app.state.rows.map((row) => row.articleId);

  return ids.join(',') === '30001,30002,30003' || `→ ${ids.join(',')}`;
});

check('CRLFと空行が混じっても分割できる', () => {
  const app = loadApp();

  setCountByInput(app, 3);
  pasteIds(app, '30001\r\n\r\n 30002 \r30003\n');

  const ids = app.state.rows.map((row) => row.articleId);

  return ids.join(',') === '30001,30002,30003' || `→ ${ids.join(',')}`;
});

check('回数を超えた分は退避され、増やすと入る', () => {
  const app = loadApp();

  setCountByInput(app, 2);
  pasteIds(app, '30001\n30002\n30003\n30004');

  const warned = app.el.bulkStatus.textContent.includes('回数を超えています');

  setCountByInput(app, 4);

  const ids = app.state.rows.map((row) => row.articleId);

  return (
    (warned && ids.join(',') === '30001,30002,30003,30004') ||
    `→ ${warned} / ${ids.join(',')}`
  );
});

check('貼り付けが足りない回は前の入力を残す', () => {
  const app = loadApp();

  setCountByInput(app, 3);
  pasteIds(app, '30001\n30002\n30003');
  pasteIds(app, '40001');

  const ids = app.state.rows.map((row) => row.articleId);

  return (
    (ids.join(',') === '40001,30002,30003' &&
      app.el.bulkStatus.textContent.includes('前の入力のまま')) ||
    `→ ${ids.join(',')} / ${app.el.bulkStatus.textContent}`
  );
});

check('両方とも空欄で反映を押したら理由を出す', () => {
  const app = loadApp();

  pasteIds(app, '   ');

  return (
    app.el.bulkStatus.textContent === '記事IDか記事タイトルを入力してください' ||
    `→ ${app.el.bulkStatus.textContent}`
  );
});

check('記事タイトルだけでも反映できる', () => {
  const app = setup({ episodeCount: 3 });

  pasteTitles(app, '一つ目\n二つ目\n三つ目');

  const titles = app.state.rows.map((row) => row.articleTitle);

  return (
    (titles.join(',') === '一つ目,二つ目,三つ目' &&
      app.el.bulkStatus.textContent.includes('記事タイトル 3件')) ||
    `→ ${titles.join(',')} / ${app.el.bulkStatus.textContent}`
  );
});

check('記事IDと記事タイトルを同時に流し込める', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bulkInput.value = '30001\n30002\n30003';
  app.el.bulkTitleInput.value = '一つ目\n二つ目\n三つ目';
  app.el.bulkApply.dispatch('click');

  const got = app.state.rows.map((row) => `${row.articleId}:${row.articleTitle}`);

  return (
    (got.join(',') === '30001:一つ目,30002:二つ目,30003:三つ目' &&
      app.el.bulkStatus.textContent.includes('記事ID 3件・記事タイトル 3件')) ||
    `→ ${got.join(',')} / ${app.el.bulkStatus.textContent}`
  );
});

check('タイトルの一括入力で文字数と表の表示も更新される', () => {
  const app = setup({ episodeCount: 3 });

  pasteIds(app, '30001\n30002\n30003');
  pasteTitles(app, 'あいう😀\n二つ目\n三つ目');
  app.renderBottomTable();

  return (
    (app.state.rows[0].el.titleCount.textContent === '4文字' &&
      app.state.rows[0].el.titleInput.value === 'あいう😀' &&
      textOf(app.state.rows[1].el.prevCell).includes('あいう😀') &&
      bottomRow(app, 0).text.includes('二つ目')) ||
    `→ ${app.state.rows[0].el.titleCount.textContent}`
  );
});

check('タイトルも回数を超えた分は退避され、増やすと入る', () => {
  const app = setup({ episodeCount: 2 });

  pasteTitles(app, '一つ目\n二つ目\n三つ目\n四つ目');

  const warned = app.el.bulkStatus.textContent.includes('回数を超えています');

  setCountByInput(app, 4);

  const titles = app.state.rows.map((row) => row.articleTitle);

  return (
    (warned && titles.join(',') === '一つ目,二つ目,三つ目,四つ目') ||
    `→ ${warned} / ${titles.join(',')}`
  );
});

check('記事タイトルだけを消せる（記事IDは残す）', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bulkInput.value = '30001\n30002\n30003';
  app.el.bulkTitleInput.value = '一つ目\n二つ目\n三つ目';
  app.el.bulkApply.dispatch('click');

  app.el.bulkTitleClear.dispatch('click');

  const ids = app.state.rows.map((row) => row.articleId);
  const titles = app.state.rows.map((row) => row.articleTitle);

  return (
    (ids.join(',') === '30001,30002,30003' &&
      titles.join(',') === ',,' &&
      app.state.rows[0].el.titleCount.textContent === '0文字') ||
    `→ ${ids.join(',')} / ${titles.join(',')}`
  );
});

check('記事タイトルを消すと退避分も消える', () => {
  const app = setup({ episodeCount: 2 });

  pasteTitles(app, '一つ目\n二つ目\n三つ目\n四つ目');
  app.el.bulkTitleClear.dispatch('click');

  setCountByInput(app, 4);

  return (
    app.state.rows.map((row) => row.articleTitle).join(',') === ',,,' ||
    `→ ${app.state.rows.map((row) => row.articleTitle).join(',')}`
  );
});

check('IDとタイトルの貼り付け欄は別々に同期する', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bulkInput.value = '30001';
  app.el.bulkInput.dispatch('input');

  app.el.bottomBulkTitleInput.value = '一つ目';
  app.el.bottomBulkTitleInput.dispatch('input');

  return (
    (app.el.bottomBulkInput.value === '30001' &&
      app.el.bulkTitleInput.value === '一つ目' &&
      app.el.bulkInput.value === '30001') ||
    `→ ${app.el.bottomBulkInput.value} / ${app.el.bulkTitleInput.value}`
  );
});

check('すべて消すと退避分も消える', () => {
  const app = loadApp();

  setCountByInput(app, 2);
  pasteIds(app, '30001\n30002\n30003\n30004');

  app.el.bulkClear.dispatch('click');

  setCountByInput(app, 4);

  const ids = app.state.rows.map((row) => row.articleId);

  return ids.join(',') === ',,,' || `→ ${ids.join(',')}`;
});

check('②の表にも記事ID・タイトルの入力欄がある', () => {
  const app = setup({ episodeCount: 3 });

  const refs = app.state.rows[0].elBottom;

  return (
    (Boolean(refs && refs.input && refs.titleInput && refs.titleCount) &&
      refs.input.className.includes('id-input') &&
      refs.titleInput.className.includes('title-input')) ||
    '→ ②に入力欄がありません'
  );
});

check('②で打ったタイトルが①にも入り、文字数も両方出る', () => {
  const app = setup({ episodeCount: 3 });

  const row = app.state.rows[0];

  row.elBottom.titleInput.value = 'あいう😀';
  app.el.bottomBody.dispatch('input', { target: row.elBottom.titleInput });

  return (
    (row.articleTitle === 'あいう😀' &&
      row.el.titleInput.value === 'あいう😀' &&
      row.el.titleCount.textContent === '4文字' &&
      row.elBottom.titleCount.textContent === '4文字') ||
    `→ ${row.el.titleInput.value} / ${row.el.titleCount.textContent}`
  );
});

check('①で打った記事IDが②にも入る', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002' });

  return (
    app.state.rows[1].elBottom.input.value === '30002' ||
    `→ ${app.state.rows[1].elBottom.input.value}`
  );
});

check('②で次の回のIDを打つと、その場で前の行の続きが更新される', () => {
  const app = setup({ episodeCount: 3 });

  app.switchTab('bottom');

  const row = app.state.rows[1];

  row.elBottom.input.value = '30002';
  app.el.bottomBody.dispatch('input', { target: row.elBottom.input });

  const first = bottomRow(app, 0);

  return (
    (first.text.includes('次回：第2回／ID 30002') &&
      first.button.disabled === false) ||
    `→ ${first.text}`
  );
});

check('入力しても②の表ごとは作り直さない（フォーカスが外れないように）', () => {
  const app = setup({ episodeCount: 3 });

  app.switchTab('bottom');

  const before = app.state.rows[1].elBottom.input;

  before.value = '30002';
  app.el.bottomBody.dispatch('input', { target: before });

  return (
    app.state.rows[1].elBottom.input === before || '→ 入力欄が作り直された'
  );
});

check('GLO公開と外部配信は別の列に出す', () => {
  const app = setup({ episodeCount: 3 });

  const refs = app.state.rows[1].elBottom;

  return (
    (textOf(refs.gloCell).includes('8/18') &&
      textOf(refs.extCell).includes('8/19') &&
      refs.gloCell.classList.contains('col-glo') &&
      refs.extCell.classList.contains('col-ext')) ||
    `→ ${textOf(refs.gloCell)} / ${textOf(refs.extCell)}`
  );
});

check('②タブの回数を変えると①も同じ回数になる', () => {
  const app = setup({ episodeCount: 8 });

  app.el.bottomCount.value = '14';
  app.el.bottomCount.dispatch('input');

  return (
    (app.state.episodeCount === 14 &&
      app.state.rows.length === 14 &&
      app.el.prevCount.value === '14') ||
    `→ ${app.state.episodeCount} / ${app.el.prevCount.value}`
  );
});

check('②タブから貼り付けても同じ行に入る', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bottomBulkInput.value = '30001\n30002\n30003';
  app.el.bottomBulkApply.dispatch('click');

  const ids = app.state.rows.map((row) => row.articleId);

  return ids.join(',') === '30001,30002,30003' || `→ ${ids.join(',')}`;
});

check('②タブから貼り付けると続きを読むにも効く', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bottomBulkInput.value = '30001\n30002\n30003';
  app.el.bottomBulkApply.dispatch('click');
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.text.includes('次回：第2回／ID 30002') &&
      row.button.disabled === false) ||
    `→ ${row.text}`
  );
});

check('貼り付け欄は①②で同じ内容になる', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bulkInput.value = '30001\n30002';
  app.el.bulkInput.dispatch('input');

  const forward = app.el.bottomBulkInput.value;

  app.el.bottomBulkInput.value = '40001\n40002';
  app.el.bottomBulkInput.dispatch('input');

  return (
    (forward === '30001\n30002' && app.el.bulkInput.value === '40001\n40002') ||
    `→ ${forward} / ${app.el.bulkInput.value}`
  );
});

check('反映の結果は①②の両方に出す', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bottomBulkInput.value = '30001\n30002\n30003';
  app.el.bottomBulkApply.dispatch('click');

  return (
    (app.el.bulkStatus.textContent === app.el.bottomBulkStatus.textContent &&
      app.el.bulkStatus.textContent.includes('3件を反映しました')) ||
    `→ ${app.el.bulkStatus.textContent} / ${app.el.bottomBulkStatus.textContent}`
  );
});

check('②タブの「すべて消す」も同じ行を消す', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bottomBulkInput.value = '30001\n30002\n30003';
  app.el.bottomBulkApply.dispatch('click');
  app.el.bottomBulkClear.dispatch('click');

  const ids = app.state.rows.map((row) => row.articleId);

  return ids.join(',') === ',,' || `→ ${ids.join(',')}`;
});

check('一括貼り付けの直後にコピーの可否が更新される', () => {
  const app = loadApp();

  setCountByInput(app, 2);
  pasteIds(app, '30001\n30002');

  return (
    app.state.rows[1].el.button.disabled === false || '→ コピーが止まったまま'
  );
});

// ============================================================
// 7. ② この話の続きを読む
// ============================================================

group('② この話の続きを読む');

check('第N回は第(N+1)回のID・タイトルを使う', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002', title: '第2回のタイトル' });
  app.renderBottomTable();

  const link = app.resolveNextLink(app.state.rows[0]);

  return (
    (link.kind === 'ok' &&
      link.html ===
        '<p>▶この話の続きを読む<br />\n' +
          '<span style="font-size:18px;">' +
          '<a href="/articles/-/30002" target="_blank">' +
          '<span style="color:#0000FF;">第2回のタイトル</span>' +
          '</a></span></p>') ||
    `→ ${link.kind} / ${link.html}`
  );
});

check('次の回のタイトル未入力なら ●▼■ を使う', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const link = app.resolveNextLink(app.state.rows[0]);

  return (
    link.html.includes(`>${app.PREV_TITLE_FALLBACK}<`) || `→ ${link.html}`
  );
});

check('最終回は固定の文言に差し替える', () => {
  const app = setup({ episodeCount: 3 });

  const link = app.resolveNextLink(app.state.rows[2]);

  return (
    (link.kind === 'final' &&
      link.html === `<p align="center">${app.FINAL_MESSAGE}</p>` &&
      app.FINAL_MESSAGE ===
        '試し読み連載は今回で最終回です。ご愛読ありがとうございました。') ||
    `→ ${link.html}`
  );
});

check('最終回の行に続きの文言を表示しない', () => {
  const app = setup({ episodeCount: 3 });

  const row = bottomRow(app, 2);

  return (
    (!row.text.includes('最終回です') && row.text.includes('—')) ||
    `→ ${row.text}`
  );
});

check('次の回のラベルは①タブと同じ第N回で出す', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 2, { id: '30003', title: '3回目のタイトル' });
  app.renderBottomTable();

  const row = bottomRow(app, 1);

  return (
    (row.text.includes('次回：第3回／ID 30003') &&
      !row.text.includes('最終回')) ||
    `→ ${row.text}`
  );
});

check('次の回の記事IDが無ければコピーを止める', () => {
  const app = setup({ episodeCount: 3 });

  const row = bottomRow(app, 0);

  return (
    (row.button.disabled === true &&
      row.button.title.includes('第2回の記事IDが未入力です')) ||
    `→ ${row.button.disabled} / ${row.button.title}`
  );
});

check('タイトルに記号が残っていたら要確認を出す（自動では直さない）', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002', title: 'その真意とは??大嫌いだった' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.text.includes('要確認') && row.button.disabled === false) ||
    `→ ${row.text}`
  );
});

// ============================================================
// 8. ② 記事下（連載一覧＋イチオシ）
// ============================================================

group('② 記事下');

check('【注目記事】【人気記事】は全回落とす', () => {
  const app = setup({ episodeCount: 3 });

  const html = app.buildArticleBottomHtml(weekHtmlOf(app, 0));

  return (
    (!html.includes('【注目記事】') &&
      !html.includes('【人気記事】') &&
      html.includes('【イチオシ記事】')) ||
    `→ ${html}`
  );
});

check('一番最後の回でも【注目記事】は残さない', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const last = app.state.rows[2];
  const hit = app.findSheetRowForRow(last);
  const html = app.joinBottomHtml(
    app.resolveNextLink(last).html,
    app.buildArticleBottomHtml(hit.html)
  );

  return (
    (last.isFinal === true &&
      !html.includes('【注目記事】') &&
      !html.includes('【人気記事】') &&
      html.includes('【イチオシ記事】')) ||
    `→ ${html}`
  );
});

check('grxxxx を今回のカテゴリコードに置き換える', () => {
  const app = setup({ episodeCount: 3 });

  const html = app.buildArticleBottomHtml(weekHtmlOf(app, 0));

  return (
    (html.includes('/category/gr1974') && !html.includes('grxxxx')) || `→ ${html}`
  );
});

check('xxxxxxxx を書籍タイトルに置き換える', () => {
  const app = setup({ episodeCount: 3 });

  const html = app.buildArticleBottomHtml(weekHtmlOf(app, 0));

  return (
    (html.includes('『七つのショートしょーと』') && !html.includes('xxxxxxxx')) ||
    `→ ${html}`
  );
});

check('最終回も今回のカテゴリコードへ送る（参照元が無いため）', () => {
  const app = setup({ episodeCount: 3 });

  const normal = app.buildArticleBottomHtml(weekHtmlOf(app, 0));
  const final = app.buildArticleBottomHtml(weekHtmlOf(app, 0));

  return (
    (normal.includes('/category/gr1974') && final.includes('/category/gr1974')) ||
    '→ 誘導先が違います'
  );
});

check('書籍名の［人気連載ピックアップ］は外す', () => {
  const app = setup({
    episodeCount: 3,
    series: {
      ...SERIES,
      bookTitle: '七つのショートしょーと［人気連載ピックアップ］',
    },
  });

  const target = app.getListTarget();

  return (
    target.bookTitle === '七つのショートしょーと' || `→ ${target.bookTitle}`
  );
});

check('書籍名の『』は二重にしない', () => {
  const app = setup({
    episodeCount: 3,
    series: { ...SERIES, bookTitle: '『七つのショートしょーと』' },
  });

  const html = app.buildArticleBottomHtml(weekHtmlOf(app, 0));

  return (
    (html.includes('『七つのショートしょーと』') &&
      !html.includes('『『')) ||
    `→ ${html}`
  );
});

check('C列の先頭の余白を続きを読むの上へ回す', () => {
  const app = setup({ episodeCount: 3 });

  const bottom = app.buildArticleBottomHtml(weekHtmlOf(app, 0));
  const joined = app.joinBottomHtml('<p>HEAD</p>', bottom);

  return (
    joined.startsWith('<p>　</p>\n<p>HEAD</p>\n') || `→ ${joined.slice(0, 60)}`
  );
});

check('余白の無いC列はそのまま後ろにつなぐ', () => {
  const app = setup({ episodeCount: 3 });

  const joined = app.joinBottomHtml('<p>HEAD</p>', '<p>BODY</p>');

  return joined === '<p>HEAD</p>\n<p>BODY</p>' || `→ ${joined}`;
});

check('まとめてコピーが指定の並びになる', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002', title: '第2回のタイトル' });
  app.renderBottomTable();

  const link = app.resolveNextLink(app.state.rows[0]);
  const bottom = app.buildArticleBottomHtml(weekHtmlOf(app, 0));
  const joined = app.joinBottomHtml(link.html, bottom);

  const order = [
    '<p>　</p>',
    '▶この話の続きを読む',
    '/articles/-/30002',
    '/category/gr1974',
    '『七つのショートしょーと』連載記事一覧は',
    '【イチオシ記事】',
    'ゴールドライフオンライン（GLO）は、表現者を応援する',
  ];

  let at = -1;

  for (const part of order) {
    const found = joined.indexOf(part, at + 1);

    if (found <= at) return `→ 並びが違います：${part}`;

    at = found;
  }

  return true;
});

// ============================================================
// 9. ② コピーを止める条件
// ============================================================

group('② コピーを止める条件');

check('シートが取れていなければ止める', () => {
  const app = setup({
    episodeCount: 3,
    sheetRows: null,
    sheetStatus: 'error',
    sheetMessage: 'GAS取得エラー (500)',
  });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.button.disabled === true &&
      row.button.title.includes('GAS取得エラー')) ||
    `→ ${row.button.disabled} / ${row.button.title}`
  );
});

check('連載情報が無ければ止める（プレースホルダーが残るため）', () => {
  const app = setup({ episodeCount: 3, series: null });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.button.disabled === true &&
      row.button.title.includes('連載情報を取得してください')) ||
    `→ ${row.button.disabled} / ${row.button.title}`
  );
});

check('C列が空なら止める', () => {
  const app = setup({
    episodeCount: 3,
    // 外部配信日 8/18 が入る週のC列を空にする
    sheetRows: [['8月第三週\n8/16（日）〜8/22（土）', '']],
  });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.button.disabled === true && row.button.title.includes('C列が空')) ||
    `→ ${row.button.disabled} / ${row.button.title}`
  );
});

check('取得前は「失敗」ではなく「取得してください」と出す', () => {
  const app = setup({ episodeCount: 3, sheetFetched: false, sheetRows: null });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.text.includes('カテゴリコードを取得してください') &&
      !row.text.includes('取得できませんでした') &&
      row.button.disabled === true) ||
    `→ ${row.text}`
  );
});

check('揃っていればコピーできる', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002', title: '第2回のタイトル' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.button.disabled === false &&
      row.button.textContent === '記事下まとめてコピー') ||
    `→ ${row.button.disabled} / ${row.button.textContent}`
  );
});

check('②のコピー済みは最後の1件だけ', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002', title: '二' });
  typeInto(app, 2, { id: '30003', title: '三' });
  app.renderBottomTable();

  const first = bottomRow(app, 0).button;
  const second = bottomRow(app, 1).button;

  first.dispatch('click');

  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      second.dispatch('click');
      return Promise.resolve().then(() => Promise.resolve());
    })
    .then(
      () =>
        (second.textContent === app.COPIED_LABEL &&
          first.textContent === '記事下まとめてコピー') ||
        `→ ${first.textContent} / ${second.textContent}`
    );
});

// ============================================================
// 10. 公開予定日時
// ============================================================

group('公開予定日時');

check('GLO公開は日付そのまま・時刻を1分ずつずらす', () => {
  const app = setup({ episodeCount: 3 });

  const got = app.state.rows.map(
    (row) =>
      `${app.fmtYmd(row.gloAt)} ${String(row.gloAt.getHours()).padStart(
        2,
        '0'
      )}:${String(row.gloAt.getMinutes()).padStart(2, '0')}`
  );

  return (
    got.join(' / ') ===
      '2026/08/18 21:00 / 2026/08/18 21:01 / 2026/08/18 21:02' ||
    `→ ${got.join(' / ')}`
  );
});

check('外部配信は1日ずつずらす・時刻はそのまま', () => {
  const app = setup({ episodeCount: 3 });

  const got = app.state.rows.map(
    (row) =>
      `${app.fmtYmd(row.extAt)} ${String(row.extAt.getHours()).padStart(
        2,
        '0'
      )}:${String(row.extAt.getMinutes()).padStart(2, '0')}`
  );

  return (
    got.join(' / ') ===
      '2026/08/18 21:00 / 2026/08/19 21:00 / 2026/08/20 21:00' ||
    `→ ${got.join(' / ')}`
  );
});

check('分が60を超えたら時に繰り上げる', () => {
  const app = setup({ episodeCount: 70, pubTime: '21:00' });

  const row = app.state.rows[69]; // 第70回 → 21:00 + 69分

  return (
    (row.gloAt.getHours() === 22 && row.gloAt.getMinutes() === 9) ||
    `→ ${row.gloAt.getHours()}:${row.gloAt.getMinutes()}`
  );
});

check('外部配信は月をまたいでも繰り上がる', () => {
  const app = setup({ episodeCount: 5, pubDate: '2026-08-30' });

  const got = app.state.rows.map((row) => app.fmtYmd(row.extAt));

  return (
    got.join(',') ===
      '2026/08/30,2026/08/31,2026/09/01,2026/09/02,2026/09/03' ||
    `→ ${got.join(',')}`
  );
});

check('ありえない日付は受け付けない', () => {
  const app = loadApp();

  return (
    (app.parseDateInput('2026-02-31') === null &&
      app.parseDateInput('2026-02-28') !== null &&
      app.parseTimeInput('25:00') === null &&
      app.parseTimeInput('21:00') !== null) ||
    '→ 判定が違います'
  );
});

check('公開日が空なら公開予定を出さずコピーも止める', () => {
  const app = setup({ episodeCount: 3, pubDate: '' });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (app.state.rows[0].gloAt === null &&
      row.button.disabled === true &&
      row.button.title.includes('このグループの開始日と時刻を入力してください')) ||
    `→ ${row.button.title}`
  );
});

// ============================================================
// 11. 公開グループ（分割公開）
// ============================================================

group('公開グループ');

// 管理シートの実例。第1〜10回が8/18 21:00、第11〜14回が8/31 14:00
const SPLIT_GROUPS = [
  {
    startNumber: 1,
    date: '2026-08-18',
    mode: 'bulk',
    time: '21:00',
  },
  {
    startNumber: 11,
    date: '2026-08-31',
    mode: 'bulk',
    time: '14:00',
  },
];

// 日時を「2026/08/18 21:00」の形で取り出す
function stamp(app, date) {
  if (!date) return 'なし';

  return `${app.fmtYmd(date)} ${String(date.getHours()).padStart(
    2,
    '0'
  )}:${String(date.getMinutes()).padStart(2, '0')}`;
}

check('① 日付を変えて同じロジックで追加できる', () => {
  const app = setup({ episodeCount: 14, pubGroups: SPLIT_GROUPS });

  const got = [10, 11, 12, 13].map(
    (i) => `${stamp(app, app.state.rows[i].gloAt)}／${stamp(app, app.state.rows[i].extAt)}`
  );

  return (
    got.join(' | ') ===
      [
        '2026/08/31 14:00／2026/08/31 14:00',
        '2026/08/31 14:01／2026/09/01 14:00',
        '2026/08/31 14:02／2026/09/02 14:00',
        '2026/08/31 14:03／2026/09/03 14:00',
      ].join(' | ') || `→ ${got.join(' | ')}`
  );
});

check('ずらしの起点はグループごとに戻る', () => {
  const app = setup({ episodeCount: 14, pubGroups: SPLIT_GROUPS });

  // 第10回は 21:09（1つ目の10本目）、第11回は 14:00（2つ目の1本目）
  return (
    (stamp(app, app.state.rows[9].gloAt) === '2026/08/18 21:09' &&
      stamp(app, app.state.rows[10].gloAt) === '2026/08/31 14:00') ||
    `→ ${stamp(app, app.state.rows[9].gloAt)} / ${stamp(
      app,
      app.state.rows[10].gloAt
    )}`
  );
});

check('前のグループは後ろのグループの手前で終わる', () => {
  const app = setup({ episodeCount: 14, pubGroups: SPLIT_GROUPS });

  const groups = app.state.rows.map((row) => row.groupIndex);

  return (
    groups.join('') === '00000000001111' || `→ ${groups.join('')}`
  );
});

check('② グループごとに時刻を変えられる（公開・外部とも同じ時刻）', () => {
  const app = setup({
    episodeCount: 12,
    pubGroups: [
      { startNumber: 1, date: '2026-08-18', mode: 'bulk', time: '21:00' },
      { startNumber: 11, date: '2026-08-31', mode: 'bulk', time: '14:00' },
    ],
  });

  const got = [0, 10, 11].map(
    (i) => `${stamp(app, app.state.rows[i].gloAt)}／${stamp(app, app.state.rows[i].extAt)}`
  );

  return (
    got.join(' | ') ===
      [
        '2026/08/18 21:00／2026/08/18 21:00',
        '2026/08/31 14:00／2026/08/31 14:00',
        '2026/08/31 14:01／2026/09/01 14:00',
      ].join(' | ') || `→ ${got.join(' | ')}`
  );
});

check('③ 毎日連載は1日ずつ・分ずらし無し・公開と外部配信が同一', () => {
  const app = setup({
    episodeCount: 4,
    pubGroups: [
      {
        startNumber: 1,
        date: '2026-08-31',
        mode: 'daily',
        time: '14:00',
      },
    ],
  });

  const got = app.state.rows.map(
    (row) => `${stamp(app, row.gloAt)}／${stamp(app, row.extAt)}`
  );

  return (
    got.join(' | ') ===
      [
        '2026/08/31 14:00／2026/08/31 14:00',
        '2026/09/01 14:00／2026/09/01 14:00',
        '2026/09/02 14:00／2026/09/02 14:00',
        '2026/09/03 14:00／2026/09/03 14:00',
      ].join(' | ') || `→ ${got.join(' | ')}`
  );
});

check('時刻はGLO公開と外部配信で共通', () => {
  const app = setup({
    episodeCount: 2,
    pubGroups: [
      { startNumber: 1, date: '2026-08-31', mode: 'bulk', time: '14:00' },
    ],
  });

  // 一括でも分ずらしが乗るのはGLO公開だけ。外部配信は時刻そのまま
  return (
    (stamp(app, app.state.rows[1].gloAt) === '2026/08/31 14:01' &&
      stamp(app, app.state.rows[1].extAt) === '2026/09/01 14:00') ||
    `→ ${stamp(app, app.state.rows[1].gloAt)} / ${stamp(
      app,
      app.state.rows[1].extAt
    )}`
  );
});

check('一括と毎日を混ぜられる', () => {
  const app = setup({
    episodeCount: 6,
    pubGroups: [
      {
        startNumber: 1,
        date: '2026-08-18',
        mode: 'bulk',
        time: '21:00',
      },
      {
        startNumber: 4,
        date: '2026-08-31',
        mode: 'daily',
        time: '14:00',
      },
    ],
  });

  const got = app.state.rows.map((row) => stamp(app, row.gloAt));

  return (
    got.join(' | ') ===
      [
        '2026/08/18 21:00',
        '2026/08/18 21:01',
        '2026/08/18 21:02',
        '2026/08/31 14:00',
        '2026/09/01 14:00',
        '2026/09/02 14:00',
      ].join(' | ') || `→ ${got.join(' | ')}`
  );
});

check('開始回が逆順でも並べ直して使う', () => {
  const app = setup({
    episodeCount: 6,
    pubGroups: [
      {
        startNumber: 4,
        date: '2026-08-31',
        mode: 'bulk',
        time: '14:00',
      },
      {
        startNumber: 1,
        date: '2026-08-18',
        mode: 'bulk',
        time: '21:00',
      },
    ],
  });

  const groups = app.normalizePubGroups().map((g) => g.startNumber);

  return (
    (groups.join(',') === '1,4' &&
      stamp(app, app.state.rows[0].gloAt) === '2026/08/18 21:00') ||
    `→ ${groups.join(',')} / ${stamp(app, app.state.rows[0].gloAt)}`
  );
});

check('先頭のグループは必ず第1回から始める', () => {
  const app = setup({
    episodeCount: 4,
    pubGroups: [
      {
        startNumber: 3,
        date: '2026-08-18',
        mode: 'bulk',
        time: '21:00',
      },
    ],
  });

  return (
    (app.normalizePubGroups()[0].startNumber === 1 &&
      app.state.rows[0].gloAt !== null) ||
    '→ 第1回に日付が入りません'
  );
});

check('開始回が重なったら1つ後ろへずらす', () => {
  const app = setup({
    episodeCount: 6,
    pubGroups: [
      {
        startNumber: 1,
        date: '2026-08-18',
        mode: 'bulk',
        time: '21:00',
      },
      {
        startNumber: 1,
        date: '2026-08-31',
        mode: 'bulk',
        time: '14:00',
      },
    ],
  });

  const groups = app.normalizePubGroups().map((g) => g.startNumber);

  return groups.join(',') === '1,2' || `→ ${groups.join(',')}`;
});

check('グループを追加すると直前の次の回から始まる', () => {
  const app = setup({ episodeCount: 14 });

  app.el.pubGroupAdd.dispatch('click');

  return (
    (app.state.pubGroups.length === 2 &&
      app.state.pubGroups[1].startNumber === 2 &&
      app.state.pubGroups[1].date === '') ||
    `→ ${JSON.stringify(app.state.pubGroups[1])}`
  );
});

check('グループを削除すると前のグループが最後まで受け持つ', () => {
  const app = setup({ episodeCount: 14, pubGroups: SPLIT_GROUPS });

  app.removePubGroup(1);

  return (
    (app.state.pubGroups.length === 1 &&
      stamp(app, app.state.rows[13].gloAt) === '2026/08/18 21:13') ||
    `→ ${app.state.pubGroups.length} / ${stamp(app, app.state.rows[13].gloAt)}`
  );
});

check('先頭のグループは削除できない', () => {
  const app = setup({ episodeCount: 14, pubGroups: SPLIT_GROUPS });

  app.removePubGroup(0);

  return app.state.pubGroups.length === 2 || `→ ${app.state.pubGroups.length}`;
});

check('2つ目のグループの先頭行に区切りを付ける', () => {
  const app = setup({ episodeCount: 14, pubGroups: SPLIT_GROUPS });

  const flags = app.state.rows.map((row) =>
    app.isGroupStartRow(row) ? '1' : '0'
  );

  return flags.join('') === '00000000001000' || `→ ${flags.join('')}`;
});

check('回数を超えたグループは理由を出す', () => {
  const app = setup({ episodeCount: 5, pubGroups: SPLIT_GROUPS });

  return (
    (app.el.pubStatus.textContent.includes('回数（5回）を超えています') &&
      app.el.pubStatus.classList.contains('warn')) ||
    `→ ${app.el.pubStatus.textContent}`
  );
});

check('グループごとの範囲を1行で確かめられる', () => {
  const app = setup({ episodeCount: 14, pubGroups: SPLIT_GROUPS });

  const text = app.el.pubStatus.textContent;

  return (
    (text.includes('第1〜10回') &&
      text.includes('第11〜14回') &&
      text.includes('（一括）')) ||
    `→ ${text}`
  );
});

check('分割すると記事下の週もグループごとに切り替わる', () => {
  const app = setup({
    episodeCount: 12,
    pubGroups: SPLIT_GROUPS,
    sheetRows: [
      ['8月第三週\n8/16（日）〜8/22（土）', makeC('41111')],
      ['8月第四週\n8/23（日）〜8/29（土）', makeC('42222')],
      ['9月第一週\n8/30（日）〜9/5（土）', makeC('43333')],
    ],
  });

  // 第1回 外部8/18 → 8/16〜、第11回 外部8/31 → 8/30〜
  return (
    (weekHtmlOf(app, 0).includes('/articles/-/41111') &&
      weekHtmlOf(app, 10).includes('/articles/-/43333')) ||
    '→ グループごとに週が切り替わっていません'
  );
});

// ============================================================
// 12. 記事下リンクの週判定（外部配信日で引く）
// ============================================================

group('記事下リンクの週判定');

check('外部配信日が属する週のC列を使う', () => {
  const app = setup({ episodeCount: 10 });

  // 第1回 8/18 → 8/16〜8/22、第6回 8/23 → 8/23〜8/29
  return (
    (weekHtmlOf(app, 0).includes('/articles/-/41111') &&
      weekHtmlOf(app, 5).includes('/articles/-/42222')) ||
    `→ 第1回と第6回で週が切り替わっていません`
  );
});

check('GLO公開日ではなく外部配信日で引く', () => {
  const app = setup({ episodeCount: 10 });

  // GLO公開は全回 8/18。それで引くと全回が同じ週になってしまう
  const ids = app.state.rows.map((row, index) =>
    weekHtmlOf(app, index).match(/\/articles\/-\/(4\d{4})/)[1]
  );

  return (
    new Set(ids).size > 1 || `→ 全回が同じ週になっています（${ids[0]}）`
  );
});

check('週をまたぐと画面の期間表示も変わる', () => {
  const app = setup({ episodeCount: 10 });

  return (
    (bottomRow(app, 0).text.includes('2026/8/16〜2026/8/22') &&
      bottomRow(app, 5).text.includes('2026/8/23〜2026/8/29')) ||
    `→ ${bottomRow(app, 0).text} ／ ${bottomRow(app, 5).text}`
  );
});

check('該当期間が無ければ黙って別の週を使わない', () => {
  const app = setup({ episodeCount: 3, pubDate: '2026-12-01' });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.text.includes('該当期間が見つかりません') &&
      row.button.disabled === true) ||
    `→ ${row.text}`
  );
});

check('B列の3つの表記ゆれを読める', () => {
  const app = loadApp();

  const got = [
    '8/23（日）〜8/29（土）',
    '6/1（日）～7（土）',
    '4/1～15',
  ].map((text) => {
    const p = app.parsePeriodParts(text);
    return p ? `${p.sm}/${p.sd}-${p.em}/${p.ed}` : 'null';
  });

  return (
    got.join(',') === '8/23-8/29,6/1-6/7,4/1-4/15' || `→ ${got.join(',')}`
  );
});

check('年またぎ（12/28〜1/3）を扱える', () => {
  const app = setup({
    episodeCount: 3,
    pubDate: '2026-12-30',
    sheetRows: [
      ['12月第四週\n12/20（日）〜12/26（土）', makeC('41111')],
      ['12月第五週\n12/27（日）〜1/2（土）', makeC('42222')],
    ],
  });

  // 12/30・12/31・1/1 のいずれも 12/27〜1/2 の行に入る
  const ids = app.state.rows.map((row, index) => {
    const hit = app.findSheetRowForRow(row);
    return hit ? hit.html.match(/\/articles\/-\/(4\d{4})/)[1] : 'なし';
  });

  return ids.join(',') === '42222,42222,42222' || `→ ${ids.join(',')}`;
});

check('シートが無いときは理由を出してコピーを止める', () => {
  const app = setup({
    episodeCount: 3,
    sheetRows: null,
    sheetStatus: 'error',
    sheetMessage: 'GAS取得エラー (500)',
  });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.button.disabled === true &&
      row.text.includes('スプレッドシートを取得できませんでした')) ||
    `→ ${row.text}`
  );
});

// ============================================================
// 11. タブ
// ============================================================

group('タブ');

check('タブは①②の2つ', () => {
  const app = loadApp();

  return (
    app.TAB_NAMES.join(',') === 'prev,bottom' || `→ ${app.TAB_NAMES.join(',')}`
  );
});

check('知らないタブ名では切り替えない', () => {
  const app = loadApp();

  app.switchTab('next');

  return app.state.activeTab === 'prev' || `→ ${app.state.activeTab}`;
});

check('②を開いたときに①の入力が反映される', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 1, { id: '30002', title: '第2回のタイトル' });

  // ①を開いている間は②を作り直さない
  const dirty = app.state.bottomDirty;

  app.switchTab('bottom');

  return (
    (dirty === true &&
      app.state.bottomDirty === false &&
      bottomRow(app, 0).text.includes('次回：第2回／ID 30002')) ||
    `→ ${dirty} / ${bottomRow(app, 0).text}`
  );
});

// ============================================================
// 結果
// ============================================================

Promise.all(pending).then(() => {
  let lastGroup = '';
  let ng = 0;

  for (const result of results) {
    if (result.group !== lastGroup) {
      console.log(`\n[${result.group}]`);
      lastGroup = result.group;
    }

    if (result.ok) {
      console.log(`  OK  ${result.name}`);
    } else {
      ng++;
      console.log(`  NG  ${result.name}`);
      if (result.detail) console.log(`      ${result.detail}`);
    }
  }

  console.log(`\n${results.length}件中 ${results.length - ng}件OK / ${ng}件NG`);

  process.exit(ng ? 1 : 0);
});
