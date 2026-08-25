/* ============================================================
   新規一括集中アシスタント 回帰テスト

   ブラウザ用の app.js を、最小限のDOMスタブを噛ませてNodeで動かす。
   ビルドもテストフレームワークも使わない。

     node apps/bulk-assistant/test/run-tests.js

   検証したいのは「誤ったHTMLを作らないこと」なので、
   見た目ではなく生成HTMLと、コピーを止める条件を中心に確認する。

   このアプリは日付もkintoneも使わないため、日付の固定はしていない。
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
  PREV_TITLE_FALLBACK, PREV_COPY_LABEL, COPIED_LABEL, TAB_NAMES,
  clampEpisodeCount, parseCountInput, setEpisodeCount, commitPrevCount,
  buildRows, renderPrevTable, updatePrevRow,
  applyBulkIds, clearArticleIds,
  buildPreviousHtmlFor, buildPreviousArticleHtml,
  switchTab, escapeHtml,
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
    fetch: () => Promise.reject(new Error('このアプリは通信しない')),
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(APP_SOURCE, sandbox, { filename: 'app.js' });

  return sandbox.__exports;
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
// 1. 起動と回数
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

  return app.state.rows[2].articleId === '' || `→ ${app.state.rows[2].articleId}`;
});

// ============================================================
// 2. 前回記事の表示
// ============================================================

group('前回記事の表示');

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
// 3. 生成HTML
// ============================================================

group('生成HTML');

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
// 4. コピー済み表示
// ============================================================

group('コピー済み表示');

check('コピーすると「コピー済み ✓」になる', () => {
  const app = loadApp();

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  const button = app.state.rows[1].el.button;

  button.dispatch('click');

  // copyText が Promise なので1周待つ
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

check('コピー済みは回ごとに残る（他の回は消さない）', () => {
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
// 5. 記事IDの一括貼り付け
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
    app.state.rows[1].el.button.disabled === false ||
    '→ コピーが止まったまま'
  );
});

// ============================================================
// 6. タブ
// ============================================================

group('タブ');

check('今あるタブは①だけ', () => {
  const app = loadApp();

  return app.TAB_NAMES.join(',') === 'prev' || `→ ${app.TAB_NAMES.join(',')}`;
});

check('知らないタブ名では切り替えない', () => {
  const app = loadApp();

  app.switchTab('bottom');

  return app.state.activeTab === 'prev' || `→ ${app.state.activeTab}`;
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
