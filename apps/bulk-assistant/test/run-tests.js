/* ============================================================
   新規一括集中アシスタント 回帰テスト

   ブラウザ用の app.js を、最小限のDOMスタブを噛ませてNodeで動かす。
   ビルドもテストフレームワークも使わない。

     node apps/bulk-assistant/test/run-tests.js

   検証したいのは「誤ったHTMLを作らないこと」なので、
   見た目ではなく生成HTMLと、コピーを止める条件を中心に確認する。

   このアプリは公開日から週を自動判定しないため、日付の固定はしていない。
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_PATH = path.join(__dirname, '..', 'app.js');

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
  clampEpisodeCount, parseCountInput, setEpisodeCount, commitPrevCount,
  getCategoryCode, toCategoryDigits, hasUnusableCodeChars,
  buildRows, renderPrevTable, updatePrevRow, renderCommon,
  applyBulkIds, clearArticleIds,
  buildPreviousHtmlFor, buildPreviousArticleHtml,
  renderBottomTable, resolveNextLink, bottomCopyBlockReason, sheetBlockReason,
  buildNextArticleHtml, buildFinalEpisodeHtml, joinBottomHtml,
  buildArticleBottomHtml, removeDroppedParagraphs, getListTarget,
  renderWeekSelect, getSelectedWeekHtml, getSelectedWeekLabel, formatWeekLabel,
  findRiskyTitleParts, switchTab, escapeHtml,
};
`;

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
    location: { search: '' },
    history: { replaceState() {} },
    navigator: {},
    fetch: () => Promise.reject(new Error('テストではAPIを呼ばない')),
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
// 【注目記事】【人気記事】も入れて落とし分けを確認できるようにする
const C_HTML = [
  '<p>　</p>',
  '',
  '<p><span style="font-size:20px;">👉<a href="/category/grxxxx" target="_blank"><span style="color:#0000FF;">『xxxxxxxx』連載記事一覧は<u>こちら</u></span></a></span></p>',
  '',
  '<p><a href="/articles/-/40001" target="_blank"><strong><span style="color:#0000CD;">【イチオシ記事】</span></strong></a></p>',
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

// 別の週。選び直したときに中身が変わることを確認する
const C_HTML_OTHER = C_HTML.replace('/articles/-/40001', '/articles/-/49999');

const SHEET_ROWS = [
  ['8月第四週\n8/16（日）〜8/22（土）', C_HTML_OTHER],
  ['8月第五週\n8/23（日）〜8/29（土）', C_HTML],
];

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

  state.series = options.series === undefined ? SERIES : options.series;

  app.renderWeekSelect();

  if (options.episodeCount) app.setEpisodeCount(options.episodeCount);

  app.renderPrevTable();
  app.renderBottomTable();

  return app;
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

group('カテゴリコード入力');

check('数字だけ入力すると gr を付けて問い合わせる', () => {
  const app = loadApp();

  app.el.codeInput.value = '1974';

  return app.getCategoryCode() === 'gr1974' || `→ ${app.getCategoryCode()}`;
});

check('gr 付きで貼り付けても二重にならない', () => {
  const app = loadApp();

  const got = ['gr1974', 'GR1974', ' gr1974 '].map((value) => {
    app.el.codeInput.value = value;
    return app.getCategoryCode();
  });

  return got.every((code) => code === 'gr1974') || `→ ${got.join(',')}`;
});

check('全角数字を半角に直す', () => {
  const app = loadApp();

  app.el.codeInput.value = '１９７４';

  return app.getCategoryCode() === 'gr1974' || `→ ${app.getCategoryCode()}`;
});

check('直しようがない文字だけ理由を出す', () => {
  const app = loadApp();

  return (
    (app.hasUnusableCodeChars('19a74') === true &&
      app.hasUnusableCodeChars('１９７４') === false &&
      app.hasUnusableCodeChars('gr1974') === false) ||
    '→ 判定が違います'
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

check('最後の行だけ「最終回」になる', () => {
  const app = loadApp();

  setCountByInput(app, 4);

  const labels = app.state.rows.map((row) => row.label);

  return (
    labels.join(',') === '第1回,第2回,第3回,最終回' || `→ ${labels.join(',')}`
  );
});

check('1回だけのときは最終回だけになる', () => {
  const app = loadApp();

  setCountByInput(app, 1);

  return (
    (app.state.rows.length === 1 && app.state.rows[0].label === '最終回') ||
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

check('空欄で反映を押したら理由を出す', () => {
  const app = loadApp();

  pasteIds(app, '   ');

  return (
    app.el.bulkStatus.textContent === '記事IDが入力されていません' ||
    `→ ${app.el.bulkStatus.textContent}`
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

check('次の回が最終回なら「次回：最終回」と出す', () => {
  const app = setup({ episodeCount: 3 });

  typeInto(app, 2, { id: '30003', title: '最終回のタイトル' });
  app.renderBottomTable();

  const row = bottomRow(app, 1);

  return (
    (row.text.includes('次回：最終回／ID 30003') &&
      !row.text.includes('次回：第3回')) ||
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

check('通常回は【注目記事】【人気記事】を落とす', () => {
  const app = setup({ episodeCount: 3 });

  const html = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), false);

  return (
    (!html.includes('【注目記事】') &&
      !html.includes('【人気記事】') &&
      html.includes('【イチオシ記事】')) ||
    `→ ${html}`
  );
});

check('最終回は【注目記事】を残し【人気記事】だけ落とす', () => {
  const app = setup({ episodeCount: 3 });

  const html = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), true);

  return (
    (html.includes('【注目記事】') &&
      !html.includes('【人気記事】') &&
      html.includes('【イチオシ記事】')) ||
    `→ ${html}`
  );
});

check('grxxxx を今回のカテゴリコードに置き換える', () => {
  const app = setup({ episodeCount: 3 });

  const html = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), false);

  return (
    (html.includes('/category/gr1974') && !html.includes('grxxxx')) || `→ ${html}`
  );
});

check('xxxxxxxx を書籍タイトルに置き換える', () => {
  const app = setup({ episodeCount: 3 });

  const html = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), false);

  return (
    (html.includes('『七つのショートしょーと』') && !html.includes('xxxxxxxx')) ||
    `→ ${html}`
  );
});

check('最終回も今回のカテゴリコードへ送る（参照元が無いため）', () => {
  const app = setup({ episodeCount: 3 });

  const normal = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), false);
  const final = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), true);

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

  const html = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), false);

  return (
    (html.includes('『七つのショートしょーと』') &&
      !html.includes('『『')) ||
    `→ ${html}`
  );
});

check('C列の先頭の余白を続きを読むの上へ回す', () => {
  const app = setup({ episodeCount: 3 });

  const bottom = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), false);
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
  const bottom = app.buildArticleBottomHtml(app.getSelectedWeekHtml(), false);
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
    sheetRows: [['8月第五週\n8/23（日）〜8/29（土）', '']],
  });

  typeInto(app, 1, { id: '30002' });
  app.renderBottomTable();

  const row = bottomRow(app, 0);

  return (
    (row.button.disabled === true && row.button.title.includes('C列が空')) ||
    `→ ${row.button.disabled} / ${row.button.title}`
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
// 10. 記事下リンクの週
// ============================================================

group('記事下リンクの週');

check('既定はシートの最終行（最新の週）', () => {
  const app = setup({ episodeCount: 3 });

  return (
    (app.state.weekIndex === SHEET_ROWS.length - 1 &&
      app.getSelectedWeekLabel() === '8月第五週　8/23（日）〜8/29（土）') ||
    `→ ${app.state.weekIndex} / ${app.getSelectedWeekLabel()}`
  );
});

check('選び直すとC列が入れ替わる', () => {
  const app = setup({ episodeCount: 3 });

  app.el.weekSelect.value = '0';
  app.el.weekSelect.dispatch('change');

  const html = app.getSelectedWeekHtml();

  return (
    (html.includes('/articles/-/49999') && !html.includes('/articles/-/40001')) ||
    '→ C列が切り替わっていません'
  );
});

check('B列の2行を1行にして選べるようにする', () => {
  const app = setup({ episodeCount: 3 });

  return (
    app.formatWeekLabel(['9月第一週\n8/30（日）〜9/5（土）', ''], 0) ===
      '9月第一週　8/30（日）〜9/5（土）' ||
    `→ ${app.formatWeekLabel(['9月第一週\n8/30（日）〜9/5（土）', ''], 0)}`
  );
});

check('シートが無いときは選択欄を無効にする', () => {
  const app = setup({
    episodeCount: 3,
    sheetRows: null,
    sheetStatus: 'error',
    sheetMessage: 'GAS取得エラー (500)',
  });

  return (
    (app.el.weekSelect.disabled === true &&
      app.state.weekIndex === -1 &&
      app.el.weekStatus.textContent.includes('GAS取得エラー')) ||
    `→ ${app.el.weekSelect.disabled} / ${app.el.weekStatus.textContent}`
  );
});

check('起動直後は失敗ではなく案内を出す', () => {
  const app = loadApp();

  return (
    (app.el.weekStatus.textContent === 'カテゴリコードを取得すると選べます' &&
      !app.el.weekStatus.classList.contains('warn')) ||
    `→ ${app.el.weekStatus.textContent}`
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
