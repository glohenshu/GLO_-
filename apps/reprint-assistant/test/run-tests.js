/* ============================================================
   再掲連載作成アシスタント 回帰テスト

   ブラウザ用の app.js を、最小限のDOMスタブを噛ませてNodeで動かす。
   ビルドもテストフレームワークも使わない。

     node apps/reprint-assistant/test/run-tests.js

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
  MIN_EPISODE_COUNT, MAX_EPISODE_COUNT,
  PREV_TITLE_FALLBACK, PREV_COPY_LABEL, COPIED_LABEL, NEXT_LINK_PLACEHOLDER,
  applySourceSelection, setEpisodeCount, parseCountInput, clampEpisodeCount,
  getCategoryCode, toCategoryDigits, hasUnusableCodeChars,
  buildRows, renderPrevTable, renderBottomTable, updatePrevRow,
  applyBulkIds, clearArticleIds,
  buildPreviousHtmlFor, buildPreviousArticleHtml,
  buildNextArticleHtml, buildArticleBottomHtml, buildFinalEpisodeHtml,
  removeDroppedParagraphs, getListTarget, sheetBlockReason, buildNextArticleTemplateHtml,
  resolveNextLink, bottomCopyBlockReason, findSheetRowForRow,
  parsePeriodParts, assignRowYears, fmtPeriodRange,
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

// 参照元 gr1334（8回）／今回 gr1974
function makeArticles(count, overrides = {}) {
  const articles = [];

  for (let i = 1; i <= count; i++) {
    articles.push({
      recordId: String(1000 + i),
      categoryCode: 'gr1334',
      bookTitle: '七つのショートしょーと',
      episodeLabel: i === count ? '最終回' : `第${i}回`,
      episodeNumber: String(i),
      articleId: String(20000 + i),
      articleUrl: `https://renaissance-media.jp/articles/-/${20000 + i}`,
      articleTitle: `参照元の第${i}回タイトル`,
      publishedAt: `2024-01-${String(i).padStart(2, '0')}T10:00:00Z`,
      serialType: '通常',
      ...(overrides[i] || {}),
    });
  }

  return articles;
}

const SERIES = {
  recordId: '2161',
  categoryCode: 'gr1974',
  bookTitle: '七つのショートしょーと［人気連載ピックアップ］',
  firstDeliveryAt: '2026-08-28T10:00:00Z', // 日本時間 2026/08/28 19:00
  productionNo: '22818',
};

// C列HTML。実データに合わせて <p> と <p align="center"> を混在させる
const C_HTML = [
  '<p>【連載記事一覧】<br />',
  '<a href="/category/grxxxx" target="_blank">『xxxxxxxx』の記事一覧はこちら</a></p>',
  '<p align="center"><strong><span style="color:#FF0000;">【イチオシ記事】</span></strong><br />',
  '<a href="/articles/-/11111">イチオシのタイトル</a></p>',
  '<p align="center"><strong><span>【注目記事】</span></strong><br />',
  '<a href="/articles/-/22222">注目のタイトル</a></p>',
  '<p><strong>【人気記事】</strong><br />',
  '<a href="/articles/-/33333">人気のタイトル</a></p>',
  '<p>※本記事はゴールドライフオンラインの定型文です。</p>',
].join('\n');

// 記事下シート [B列, C列]。2026年の曜日で書く（8/23は日曜）
const SHEET_ROWS = [
  ['8月第二週\n8/2（日）〜8/8（土）', C_HTML],
  ['8月第三週\n8/9（日）〜8/15（土）', C_HTML],
  ['8月第四週\n8/16（日）〜8/22（土）', C_HTML],
  ['8月第五週\n8/23（日）〜8/29（土）', C_HTML],
  ['9月第一週\n8/30（日）〜9/5（土）', C_HTML],
];

// ------------------------------------------------------------
// セットアップ
// ------------------------------------------------------------

function setup(options = {}) {
  const app = loadApp();
  const { state } = app;

  const articles =
    options.articles || makeArticles(options.sourceCount || 8);

  state.series = options.series === undefined ? SERIES : options.series;

  state.sourceCandidates = [
    {
      categoryCode: 'gr1334',
      bookTitle: '七つのショートしょーと',
      serialType: '通常',
      count: articles.length,
      articles,
    },
  ];

  const sheetRows =
    options.sheetRows === undefined ? SHEET_ROWS : options.sheetRows;

  state.sheetStatus = options.sheetStatus || (sheetRows ? 'ok' : 'error');
  state.sheetMessage = options.sheetMessage || '';
  state.sheetRows = sheetRows;

  app.applySourceSelection('gr1334');

  if (options.episodeCount) {
    state.episodeCount = options.episodeCount;
  }

  app.buildRows();
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

// ------------------------------------------------------------
// 最小のテストランナー
// ------------------------------------------------------------

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
}

// コピー処理だけは非同期なので、Promiseを返すテストも受け付ける。
// 実行順は変えたくないので、結果の器だけ先に並べて後から埋める
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
// 1. 回数入力
// ============================================================

group('カテゴリコード入力');

check('数字だけ入力すると gr を付けて問い合わせる', () => {
  const app = loadApp();

  app.el.codeInput.value = '1974';

  return app.getCategoryCode() === 'gr1974' || `→ ${app.getCategoryCode()}`;
});

check('gr 付きで貼り付けても二重にならない', () => {
  const app = loadApp();

  const cases = ['gr1974', 'GR1974', ' gr1974 '];
  const got = cases.map((value) => {
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

check('数字以外は落とす', () => {
  const app = loadApp();

  return (
    (app.toCategoryDigits('19a74') === '1974' &&
      app.toCategoryDigits('19-74') === '1974' &&
      app.toCategoryDigits('あ') === '') ||
    `→ ${app.toCategoryDigits('19a74')} / ${app.toCategoryDigits('19-74')}`
  );
});

check('空欄なら問い合わせないよう空文字を返す', () => {
  const app = loadApp();

  app.el.codeInput.value = '   ';

  return app.getCategoryCode() === '' || `→ ${app.getCategoryCode()}`;
});

check('入力欄で数字以外を打つと取り除いて理由を出す', () => {
  const app = loadApp();

  app.el.codeInput.value = '19a74';
  app.el.codeInput.dispatch('input');

  return (
    (app.el.codeInput.value === '1974' &&
      app.el.fetchStatus.textContent.includes('半角数字') &&
      app.el.fetchStatus.className.includes('error')) ||
    `→ ${app.el.codeInput.value} / ${app.el.fetchStatus.textContent}`
  );
});

check('全角数字と gr は黙って直す（咎めない）', () => {
  const app = loadApp();

  app.el.codeInput.value = 'gr１９７４';
  app.el.codeInput.dispatch('input');

  return (
    (app.el.codeInput.value === '1974' &&
      !app.el.fetchStatus.className.includes('error')) ||
    `→ ${app.el.codeInput.value} / ${app.el.fetchStatus.textContent}`
  );
});

check('直したあとは警告が消える', () => {
  const app = loadApp();

  app.el.codeInput.value = '19a74';
  app.el.codeInput.dispatch('input');

  app.el.codeInput.value = '1975';
  app.el.codeInput.dispatch('input');

  return (
    (!app.el.fetchStatus.className.includes('error') &&
      app.el.fetchStatus.textContent === '') ||
    `→ ${app.el.fetchStatus.textContent}`
  );
});

group('回数入力');

check('全角数字「１０」を10として読む', () => {
  const app = loadApp();
  return app.parseCountInput('１０') === 10 || `→ ${app.parseCountInput('１０')}`;
});

check('「8回」のような余計な文字を落として読む', () => {
  const app = loadApp();
  return app.parseCountInput('8回') === 8 || `→ ${app.parseCountInput('8回')}`;
});

check('空欄・記号だけの入力は数値にしない', () => {
  const app = loadApp();
  return (
    Number.isNaN(app.parseCountInput('')) &&
    Number.isNaN(app.parseCountInput('　-'))
  );
});

check('上限200を超える入力は200に丸める', () => {
  const app = setup();
  app.setEpisodeCount(9999);
  return app.state.episodeCount === 200 || `→ ${app.state.episodeCount}`;
});

check('0や負値は下限1に丸める（0行にはしない）', () => {
  const app = setup();
  app.setEpisodeCount(0);
  const zero = app.state.episodeCount;
  app.setEpisodeCount(-5);
  return (
    (zero === 1 && app.state.episodeCount === 1) ||
    `→ 0のとき${zero} / -5のとき${app.state.episodeCount}`
  );
});

check('小数は切り捨てる', () => {
  const app = setup();
  app.setEpisodeCount(3.9);
  return app.state.episodeCount === 3 || `→ ${app.state.episodeCount}`;
});

check('参照元が未選択なら回数を変えられない', () => {
  const app = loadApp();
  app.state.selectedSource = null;
  app.state.sourceCount = 0;
  app.setEpisodeCount(5);
  return app.state.episodeCount === 0 || `→ ${app.state.episodeCount}`;
});

// ============================================================
// 2. 記事IDの一括貼り付け
// ============================================================

group('一括貼り付け');

check('空行・前後の空白・CRLFが混ざっても各回へ順に入る', () => {
  const app = setup();

  app.el.bulkInput.value = '  30001  \r\n\r\n30002\n\n  30003\r30004  ';
  app.applyBulkIds();

  const ids = app.state.rows.slice(0, 4).map((row) => row.articleId);

  return (
    ids.join(',') === '30001,30002,30003,30004' || `→ ${ids.join(',')}`
  );
});

check('回数を超えた分は退避され、回数を増やすと戻る', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bulkInput.value = '30001\n30002\n30003\n30004\n30005';
  app.applyBulkIds();

  const before = app.state.rows.length;

  app.setEpisodeCount(5);

  const ids = app.state.rows.map((row) => row.articleId);

  return (
    (before === 3 && ids.join(',') === '30001,30002,30003,30004,30005') ||
    `→ ${before}行 / ${ids.join(',')}`
  );
});

check('超過したことがステータスに出る', () => {
  const app = setup({ episodeCount: 2 });

  app.el.bulkInput.value = '30001\n30002\n30003';
  app.applyBulkIds();

  return (
    app.el.bulkStatus.textContent.includes('1件は再掲連載回数を超えています') ||
    `→ ${app.el.bulkStatus.textContent}`
  );
});

check('貼り付け件数が少ないとき、後ろの回のIDを消さない', () => {
  const app = setup({ episodeCount: 4 });

  app.el.bulkInput.value = '30001\n30002\n30003\n30004';
  app.applyBulkIds();

  app.el.bulkInput.value = '40001\n40002';
  app.applyBulkIds();

  const ids = app.state.rows.map((row) => row.articleId);

  return (
    ids.join(',') === '40001,40002,30003,30004' || `→ ${ids.join(',')}`
  );
});

check('「記事IDをすべて消す」で退避分も消える', () => {
  const app = setup({ episodeCount: 3 });

  app.el.bulkInput.value = '30001\n30002\n30003\n30004\n30005';
  app.applyBulkIds();
  app.clearArticleIds();
  app.setEpisodeCount(5);

  const ids = app.state.rows.map((row) => row.articleId);

  return ids.every((id) => id === '') || `→ ${ids.join(',')}`;
});

// ============================================================
// 3. 前回記事タブ
// ============================================================

group('前回記事');

check('第1回にはコピーボタンを作らない', () => {
  const app = setup();
  return app.state.rows[0].el.button === null;
});

check('第2回は第1回のID・タイトルを参照する', () => {
  const app = setup();

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  const html = app.buildPreviousHtmlFor(1);

  return (
    (html.includes('/articles/-/30001') &&
      html.includes('【前回の記事を読む】第1回のタイトル')) ||
    `→ ${html}`
  );
});

check('前回タイトルが空なら ●▼■ を使う', () => {
  const app = setup();

  typeInto(app, 0, { id: '30001', title: '' });

  return (
    app.buildPreviousHtmlFor(1).includes('【前回の記事を読む】●▼■') ||
    `→ ${app.buildPreviousHtmlFor(1)}`
  );
});

check('前回IDが無ければHTMLを作らずボタンを無効にする', () => {
  const app = setup();

  typeInto(app, 0, { id: '', title: 'タイトルだけ入力' });

  return (
    (app.buildPreviousHtmlFor(1) === '' &&
      app.state.rows[1].el.button.disabled === true) ||
    '→ HTMLかボタン状態が期待と異なる'
  );
});

check('記号入りのタイトルをエスケープする', () => {
  const app = setup();

  typeInto(app, 0, { id: '30001', title: 'A&B<C>D "E"' });

  const html = app.buildPreviousHtmlFor(1);

  return (
    (html.includes('A&amp;B&lt;C&gt;D') &&
      !html.includes('<C>') &&
      html.split('<a ').length === 2) ||
    `→ ${html}`
  );
});

check('前回タイトルを変えるとコピー済みが外れる', () => {
  const app = setup();

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  // クリップボードを介さず、コピー済みの状態だけ作る
  const row = app.state.rows[1];
  row.copiedHtml = app.buildPreviousHtmlFor(1);
  app.state.copiedStash.set(row.number, row.copiedHtml);
  app.updatePrevRow(1);

  const copied = row.el.button.textContent === app.COPIED_LABEL;

  typeInto(app, 0, { title: '直したタイトル' });

  return (
    (copied && row.el.button.textContent === app.PREV_COPY_LABEL) ||
    `→ コピー直後:${copied} / 変更後:${row.el.button.textContent}`
  );
});

check('前回IDを変えるとコピー済みが外れる', () => {
  const app = setup();

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  const row = app.state.rows[1];
  row.copiedHtml = app.buildPreviousHtmlFor(1);
  app.state.copiedStash.set(row.number, row.copiedHtml);
  app.updatePrevRow(1);

  typeInto(app, 0, { id: '39999' });

  return (
    row.el.button.textContent === app.PREV_COPY_LABEL ||
    `→ ${row.el.button.textContent}`
  );
});

check('10→8→10 と回数を戻すとID・タイトルが復元する', () => {
  const app = setup({ episodeCount: 10 });

  typeInto(app, 8, { id: '30009', title: '第9回のタイトル' });
  typeInto(app, 9, { id: '30010', title: '最終回のタイトル' });

  app.setEpisodeCount(8);
  app.setEpisodeCount(10);

  const rows = app.state.rows;

  return (
    (rows[8].articleId === '30009' &&
      rows[8].articleTitle === '第9回のタイトル' &&
      rows[9].articleId === '30010' &&
      rows[9].articleTitle === '最終回のタイトル') ||
    `→ ${rows[8].articleId}/${rows[8].articleTitle} , ${rows[9].articleId}/${rows[9].articleTitle}`
  );
});

check('日本語・英数字・絵文字をそれぞれ1文字として数える', () => {
  const app = setup();

  // Array.from() で数えているのでサロゲートペアの絵文字も1文字になる。
  // ZWJで繋いだ結合絵文字（👨‍👩‍👧など）は分解されるが、
  // 記事タイトルで使うことはないため許容する
  typeInto(app, 0, { title: 'あA😀' });

  return (
    app.state.rows[0].el.titleCount.textContent === '3文字' ||
    `→ ${app.state.rows[0].el.titleCount.textContent}`
  );
});

// ============================================================
// 4. 記事下タブ：続きを読む
// ============================================================

group('記事下・続きを読む');

check('第N回は参照元の第N+1回を指す', () => {
  const app = setup();

  const link = app.resolveNextLink(app.state.rows[0]);

  return (
    (link.kind === 'ok' &&
      link.html.includes('/articles/-/20002') &&
      link.html.includes('参照元の第2回タイトル')) ||
    `→ ${link.kind} / ${link.html}`
  );
});

check('最後の行は参照元に次回が残っていても最終回扱い', () => {
  const app = setup({ episodeCount: 5 });

  const last = app.state.rows[4];
  const link = app.resolveNextLink(last);

  return (
    (last.isFinal &&
      link.kind === 'final' &&
      link.html.includes('試し読み連載は今回で最終回です')) ||
    `→ ${link.kind}`
  );
});

check('最終回メッセージが指定どおりの1文', () => {
  const app = setup();

  const expected =
    '<p align="center">' +
    '試し読み連載は今回で最終回です。ご愛読ありがとうございました。' +
    '</p>';

  return app.buildFinalEpisodeHtml() === expected || `→ ${app.buildFinalEpisodeHtml()}`;
});

check('最終回メッセージに余白の段落を足さない（C列側に入っている）', () => {
  const app = setup();

  return (
    !app.buildFinalEpisodeHtml().includes('<p>　</p>') ||
    '→ 余白が二重になる'
  );
});

check('参照元の回数を超えたらHTMLを作らず理由を出す', () => {
  const app = setup({ episodeCount: 12 });

  // 第10回 → 参照元 第11回（参照元は8回まで）
  const link = app.resolveNextLink(app.state.rows[9]);
  const reason = app.bottomCopyBlockReason(link, null, '');

  return (
    (link.kind === 'no-episode' &&
      !link.html &&
      reason === '参照元に該当回がありません') ||
    `→ ${link.kind} / ${reason}`
  );
});

check('参照元を超えた回はテンプレをコピーできる', () => {
  const app = setup({ episodeCount: 9 });

  // 第8回 → 参照元 第9回（参照元は8回まで）。最終回は第9回なので通常回扱い
  const cell = findNodes(
    app.el.bottomBody.children[7],
    (n) => n.className.includes('col-act')
  )[0];
  const button = cell.children[0];

  return (
    (button.textContent === '記事下テンプレをコピー' &&
      button.disabled === false &&
      button.className.includes('template')) ||
    `→ ${button.textContent} / disabled=${button.disabled}`
  );
});

check('テンプレは続きを読むのリンク先をプレースホルダーにする', () => {
  const app = setup();

  const html = app.buildNextArticleTemplateHtml();

  return (
    (html.includes('/articles/-/●●●●●') &&
      html.includes('●▼■') &&
      html.includes('▶この話の続きを読む')) ||
    `→ ${html}`
  );
});

check('テンプレでも記事下（一覧＋イチオシ）は正しく作る', () => {
  const app = setup({ episodeCount: 9 });

  const row = app.state.rows[7];
  const hit = app.findSheetRowForRow(row);
  const bottomHtml = app.buildArticleBottomHtml(hit.html, row.isFinal);

  return (
    (bottomHtml.includes('/category/gr1334') &&
      bottomHtml.includes('【イチオシ記事】') &&
      !bottomHtml.includes('【注目記事】')) ||
    '→ 記事下の中身が通常回と違う'
  );
});

check('シートが取れないときはテンプレも渡さない', () => {
  const app = setup({ episodeCount: 9, sheetRows: null, sheetStatus: 'error' });

  const cell = findNodes(
    app.el.bottomBody.children[7],
    (n) => n.className.includes('col-act')
  )[0];
  const button = cell.children[0];

  return (
    button.disabled === true ||
    `→ ${button.textContent} / disabled=${button.disabled}`
  );
});

check('参照元に記事IDが無い回はコピーを止める', () => {
  const app = setup({
    articles: makeArticles(8, { 2: { articleId: '' } }),
  });

  const link = app.resolveNextLink(app.state.rows[0]);
  const reason = app.bottomCopyBlockReason(link, null, '');

  return (
    (link.kind === 'no-id' && reason === '参照元に記事IDがありません') ||
    `→ ${link.kind} / ${reason}`
  );
});

check('参照元の記事タイトルの記号をエスケープする', () => {
  const app = setup({
    articles: makeArticles(8, {
      2: { articleTitle: '妻は「もう限界」<br>と言った & 泣いた' },
    }),
  });

  const link = app.resolveNextLink(app.state.rows[0]);

  return (
    (link.html.includes('&lt;br&gt;') &&
      link.html.includes('&amp;') &&
      link.html.split('<a ').length === 2) ||
    `→ ${link.html}`
  );
});

// ============================================================
// 5. 参照元タイトルの確認手段
// ============================================================

group('参照元タイトルの確認');

// 記事下タブ1行目の「この話の続きを読む」セルを取り出す
function nextCellOf(app, index = 0) {
  return findNodes(
    app.el.bottomBody.children[index],
    (n) => n.className.includes('col-next')
  )[0];
}

check('参照元の回・IDが記事URLへのリンクになる', () => {
  const app = setup();

  const anchors = findNodes(nextCellOf(app), (n) => n.tagName === 'A');

  return (
    (anchors.length === 1 &&
      anchors[0].href === 'https://renaissance-media.jp/articles/-/20002' &&
      anchors[0].textContent.includes('ID 20002')) ||
    `→ ${anchors.map((a) => a.href).join(',')}`
  );
});

check('記事URLが空でも他の記事からURLの形を借りてリンクを作る', () => {
  const app = setup({
    articles: makeArticles(8, { 2: { articleUrl: '' } }),
  });

  const anchors = findNodes(nextCellOf(app), (n) => n.tagName === 'A');

  return (
    (anchors.length === 1 &&
      anchors[0].href === 'https://renaissance-media.jp/articles/-/20002') ||
    `→ ${anchors.map((a) => a.href).join(',') || 'リンクなし'}`
  );
});

check('記事URLが1件も無ければリンクにしない（誤ったURLを作らない）', () => {
  const app = setup({
    articles: makeArticles(8).map((a) => ({ ...a, articleUrl: '' })),
  });

  const anchors = findNodes(nextCellOf(app), (n) => n.tagName === 'A');

  return (
    (anchors.length === 0 &&
      textOf(nextCellOf(app)).includes('ID 20002')) ||
    `→ ${anchors.length}件のリンク`
  );
});

check('タイトルに " や < > が入ると「要確認」を出す', () => {
  const app = setup({
    articles: makeArticles(8, {
      2: { articleTitle: '妻は "もう限界" と言った' },
    }),
  });

  const text = textOf(nextCellOf(app));

  return (
    text.includes('要確認：HTMLで意味を持つ記号') || `→ ${text}`
  );
});

check('文字化け・半角カナ・機種依存文字を「要確認」にする', () => {
  const app = setup({
    articles: makeArticles(8, {
      2: { articleTitle: '第①話 ｶﾀｶﾅ と 文字化け�' },
    }),
  });

  const text = textOf(nextCellOf(app));

  return (
    (text.includes('半角カナ') &&
      text.includes('機種依存の記号') &&
      text.includes('文字化けの疑い')) ||
    `→ ${text}`
  );
});

check('普通のタイトルでは「要確認」を出さない', () => {
  const app = setup();

  return !textOf(nextCellOf(app)).includes('要確認') || '→ 誤検知している';
});

check('?? の連続を「文字化けの可能性」として拾う', () => {
  // gr1528 の実データにある形。ダッシュだったと思われる箇所が ?? になっている
  const app = setup({
    articles: makeArticles(8, {
      2: { articleTitle: 'その真意とは??大嫌いだった夫に私が恋をした理由。' },
    }),
  });

  const text = textOf(nextCellOf(app));

  return text.includes('?? の連続') || `→ ${text}`;
});

check('半角の ! ? や…では「要確認」を出さない（目印を増やしすぎない）', () => {
  const app = setup({
    articles: makeArticles(8, {
      2: { articleTitle: '本当にそれでいいのか!? 妻の一言に……' },
    }),
  });

  return !textOf(nextCellOf(app)).includes('要確認') || '→ 誤検知している';
});

check('「要確認」を出してもHTML生成は止めない', () => {
  const app = setup({
    articles: makeArticles(8, { 2: { articleTitle: 'A & B "C"' } }),
  });

  const link = app.resolveNextLink(app.state.rows[0]);

  return (
    (link.kind === 'ok' && link.html.includes('A &amp; B')) ||
    `→ ${link.kind} / ${link.html}`
  );
});

// ============================================================
// 6. 記事下タブ：一覧リンクと段落の出し分け
// ============================================================

group('記事下・一覧とイチオシ');

check('通常回は参照元（gr1334）の一覧へ送る', () => {
  const app = setup();
  const html = app.buildArticleBottomHtml(C_HTML, false);
  const codes = [...html.matchAll(/\/category\/([A-Za-z0-9]+)/g)].map((m) => m[1]);

  return (
    (codes.length === 1 &&
      codes[0] === 'gr1334' &&
      html.includes('『七つのショートしょーと』')) ||
    `→ ${codes.join(',')}`
  );
});

check('最終回は今回（gr1974）の一覧へ送る', () => {
  const app = setup();
  const html = app.buildArticleBottomHtml(C_HTML, true);
  const codes = [...html.matchAll(/\/category\/([A-Za-z0-9]+)/g)].map((m) => m[1]);

  return (
    (codes.length === 1 &&
      codes[0] === 'gr1974' &&
      html.includes('『七つのショートしょーと』')) ||
    `→ ${codes.join(',')}`
  );
});

check('一覧リンクの書籍名から［◯◯連載ピックアップ］を外す', () => {
  const app = setup();

  // 通常回は参照元、最終回は今回。どちらもピックアップ表記は出さない
  const normal = app.buildArticleBottomHtml(C_HTML, false);
  const final = app.buildArticleBottomHtml(C_HTML, true);

  return (
    (!normal.includes('連載ピックアップ') &&
      !final.includes('連載ピックアップ') &&
      final.includes('『七つのショートしょーと』')) ||
    '→ ピックアップ表記が残っている'
  );
});

check('半角［］のピックアップ表記も外す', () => {
  const app = setup();

  app.state.series = {
    ...SERIES,
    bookTitle: '七つのショートしょーと[注目連載ピックアップ]',
  };

  return (
    app.getListTarget(true).bookTitle === '七つのショートしょーと' ||
    `→ ${app.getListTarget(true).bookTitle}`
  );
});

check('プレースホルダーを残さない', () => {
  const app = setup();

  const normal = app.buildArticleBottomHtml(C_HTML, false);
  const final = app.buildArticleBottomHtml(C_HTML, true);

  return (
    !/grxxxx|gr●●●●|xxxxxxxx|●●●●●●●●/.test(normal + final) ||
    '→ 未置換のプレースホルダーが残っている'
  );
});

check('書籍タイトルの『』が二重にならない', () => {
  const app = setup();

  app.state.series = { ...SERIES, bookTitle: '『七つのショートしょーと』' };

  const html = app.buildArticleBottomHtml(C_HTML, true);

  return !html.includes('『『') || `→ ${html}`;
});

check('通常回は【注目記事】【人気記事】を落とし、【イチオシ記事】を残す', () => {
  const app = setup();
  const html = app.buildArticleBottomHtml(C_HTML, false);

  return (
    (!html.includes('【注目記事】') &&
      !html.includes('【人気記事】') &&
      html.includes('【イチオシ記事】') &&
      html.includes('【連載記事一覧】') &&
      html.includes('定型文')) ||
    '→ 残す・落とすの組み合わせが違う'
  );
});

check('最終回は【注目記事】を残し、【人気記事】だけ落とす', () => {
  const app = setup();
  const html = app.buildArticleBottomHtml(C_HTML, true);

  return (
    (html.includes('【注目記事】') &&
      !html.includes('【人気記事】') &&
      html.includes('【イチオシ記事】')) ||
    '→ 残す・落とすの組み合わせが違う'
  );
});

check('C列に［人気連載ピックアップ］があっても【人気記事】と誤判定しない', () => {
  const app = setup();

  // 【人気記事】ではなく、書籍名にピックアップ表記が入っている段落
  const html =
    '<p>『プレナイト［人気連載ピックアップ］』連載記事一覧はこちら</p>\n' +
    '<p>【人気記事】消える段落</p>';

  const result = app.removeDroppedParagraphs(html, true);

  return (
    (result.includes('［人気連載ピックアップ］') &&
      !result.includes('【人気記事】')) ||
    `→ ${result}`
  );
});

check('段落を落としても他のタグを壊さない', () => {
  const app = setup();
  const html = app.buildArticleBottomHtml(C_HTML, false);

  const open = (html.match(/<p\b/g) || []).length;
  const close = (html.match(/<\/p>/g) || []).length;

  return (
    (open === close && open === 3) || `→ <p>${open}個 / </p>${close}個`
  );
});

// ============================================================
// 7. 記事下タブ：期間判定
// ============================================================

group('記事下・期間判定');

check('公開予定日から正しい週の行を拾う', () => {
  const app = setup();

  // 第1回 8/28 → 8/23〜8/29、第3回 8/30 → 8/30〜9/5
  const first = app.findSheetRowForRow(app.state.rows[0]);
  const third = app.findSheetRowForRow(app.state.rows[2]);

  return (
    (app.fmtPeriodRange(first.period) === '2026/8/23〜2026/8/29' &&
      app.fmtPeriodRange(third.period) === '2026/8/30〜2026/9/5') ||
    `→ ${app.fmtPeriodRange(first.period)} / ${app.fmtPeriodRange(third.period)}`
  );
});

check('シートに無い週は「該当なし」にして別の行を使わない', () => {
  const app = setup({ episodeCount: 20 });

  // 第20回は 2026/9/16。シートは9/5までしかない
  const hit = app.findSheetRowForRow(app.state.rows[19]);
  const link = app.resolveNextLink(app.state.rows[19]);
  const reason = app.bottomCopyBlockReason(link, hit, '');

  return (
    (hit === null && Boolean(reason)) ||
    `→ hit=${hit && app.fmtPeriodRange(hit.period)} / reason=${reason}`
  );
});

check('同じ期間の行が複数あるときは下の行を採用する', () => {
  const rows = [
    ['8月第五週\n8/23（日）〜8/29（土）', '<p>古い方</p>'],
    ['8月第五週\n8/23（日）〜8/29（土）', '<p>新しい方</p>'],
  ];

  const app = setup({ sheetRows: rows });
  const hit = app.findSheetRowForRow(app.state.rows[0]);

  return hit.html === '<p>新しい方</p>' || `→ ${hit.html}`;
});

check('B列の3つの表記ゆれをすべて読める', () => {
  const app = loadApp();

  const a = app.parsePeriodParts('8/23（日）〜8/29（土）');
  const b = app.parsePeriodParts('6/1（日）～7（土）');
  const c = app.parsePeriodParts('4/1～15');

  return (
    (a && a.sm === 8 && a.sd === 23 && a.em === 8 && a.ed === 29 &&
      b && b.sm === 6 && b.sd === 1 && b.em === 6 && b.ed === 7 &&
      c && c.sm === 4 && c.sd === 1 && c.em === 4 && c.ed === 15) ||
    `→ ${JSON.stringify([a, b, c])}`
  );
});

check('波ダッシュ2種（〜 U+301C / ～ U+FF5E）を同じに扱う', () => {
  const app = loadApp();

  const a = app.parsePeriodParts('8/23（日）〜8/29（土）');
  const b = app.parsePeriodParts('8/23（日）～8/29（土）');

  return JSON.stringify(a) === JSON.stringify(b) || `→ ${JSON.stringify([a, b])}`;
});

check('年またぎ（12/28〜1/3）で終了側の年を1つ進める', () => {
  const app = setup({
    sheetRows: [
      ['12月第四週\n12/20（日）〜12/26（土）', C_HTML],
      ['1月第一週\n12/27（日）〜1/2（土）', C_HTML],
    ],
    series: { ...SERIES, firstDeliveryAt: '2026-12-30T10:00:00Z' },
  });

  const hit = app.findSheetRowForRow(app.state.rows[0]);

  return (
    (hit && app.fmtPeriodRange(hit.period) === '2026/12/27〜2027/1/2') ||
    `→ ${hit && app.fmtPeriodRange(hit.period)}`
  );
});

check('曜日から年を推定する（今日に近い年だけで決めない）', () => {
  const app = loadApp();

  // 2025年の曜日で書いた行。2026年として読むと曜日が合わない
  const rows = [['8月\n8/24（日）〜8/30（土）', '<p>x</p>']];
  const parsed = app.assignRowYears(rows, new Date(2026, 7, 19));

  return parsed[0].year === 2025 || `→ ${parsed[0].year}`;
});

// ============================================================
// 8. 取得失敗時の切り分け
// ============================================================

group('取得失敗の切り分け');

check('シートが取れなくても前回記事タブは使える', () => {
  const app = setup({ sheetRows: null, sheetStatus: 'error' });

  typeInto(app, 0, { id: '30001', title: '第1回のタイトル' });

  return (
    app.buildPreviousHtmlFor(1).includes('/articles/-/30001') ||
    '→ 前回記事HTMLが作れない'
  );
});

check('シートが取れないときは記事下のコピーを止める', () => {
  const app = setup({ sheetRows: null, sheetStatus: 'error' });

  const link = app.resolveNextLink(app.state.rows[0]);
  const reason = app.bottomCopyBlockReason(link, null, '');

  return Boolean(reason) || '→ コピーが止まっていない';
});

check('第1回配信日時が無ければ公開予定日を出さない', () => {
  const app = setup({ series: { ...SERIES, firstDeliveryAt: '' } });

  return (
    app.state.rows.every((row) => row.planned === null) ||
    '→ 予定日が算出されている'
  );
});

check('C列が空の週はコピーを止める', () => {
  const app = setup({
    sheetRows: [['8月第五週\n8/23（日）〜8/29（土）', '']],
  });

  const row = app.state.rows[0];
  const hit = app.findSheetRowForRow(row);
  const link = app.resolveNextLink(row);
  const bottomHtml = hit ? app.buildArticleBottomHtml(hit.html, row.isFinal) : '';
  const reason = app.bottomCopyBlockReason(link, hit, bottomHtml);

  return Boolean(reason) || '→ コピーが止まっていない';
});

// ============================================================
// 9. 画面表示（今回の変更の回帰）
// ============================================================

group('画面表示');

check('記事下の期間表示は yyyy/m/d〜yyyy/m/d の1行だけ', () => {
  const app = setup();

  const rows = app.el.bottomBody.children;
  const sheetCell = findNodes(rows[0], (n) => n.className.includes('col-sheet'))[0];
  const text = textOf(sheetCell).trim();

  return (
    (text === '2026/8/23〜2026/8/29' && !text.includes('週')) || `→ ${text}`
  );
});

check('記事下に一覧リンクの注記を出さない', () => {
  const app = setup();

  const text = textOf(app.el.bottomBody);

  return !text.includes('一覧：/category/') || '→ 一覧の注記が残っている';
});

check('記事下をコピーするとボタンが「コピー済み ✓」になる', async () => {
  const app = setup();

  const cell = findNodes(
    app.el.bottomBody.children[0],
    (n) => n.className.includes('col-act')
  )[0];
  const button = cell.children[0];

  button.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  return (
    (button.textContent === app.COPIED_LABEL &&
      button.className.includes('copied')) ||
    `→ ${button.textContent}`
  );
});

check('記事下のコピー済み表示は最後の1件だけ', async () => {
  const app = setup();

  const buttonOf = (index) =>
    findNodes(
      app.el.bottomBody.children[index],
      (n) => n.className.includes('col-act')
    )[0].children[0];

  const first = buttonOf(0);
  const second = buttonOf(1);

  first.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const firstCopied = first.textContent === app.COPIED_LABEL;

  second.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  return (
    (firstCopied &&
      second.textContent === app.COPIED_LABEL &&
      first.textContent === '記事下まとめてコピー' &&
      !first.className.includes('copied')) ||
    `→ 1件目:${first.textContent} / 2件目:${second.textContent}`
  );
});

check('テンプレのボタンも元のラベルに戻る', async () => {
  const app = setup({ episodeCount: 9 });

  const buttonOf = (index) =>
    findNodes(
      app.el.bottomBody.children[index],
      (n) => n.className.includes('col-act')
    )[0].children[0];

  const template = buttonOf(7);
  const normal = buttonOf(0);

  template.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  normal.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  return (
    (template.textContent === '記事下テンプレをコピー' &&
      normal.textContent === app.COPIED_LABEL) ||
    `→ テンプレ:${template.textContent} / 通常:${normal.textContent}`
  );
});

check('記事タイトル欄に例文のプレースホルダーを置かない', () => {
  const app = setup();

  const placeholder = app.state.rows[0].el.titleInput.placeholder;

  return !placeholder || `→ ${placeholder}`;
});

check('期間のツールチップにB列原文と誘導先を残す', () => {
  const app = setup();

  const cell = findNodes(
    app.el.bottomBody.children[0],
    (n) => n.className.includes('col-sheet')
  )[0];
  const range = findNodes(cell, (n) => n.className.includes('range'))[0];

  return (
    (range.title.includes('8月第五週') &&
      range.title.includes('8/23（日）〜8/29（土）') &&
      range.title.includes('/category/gr1334')) ||
    `→ ${range.title}`
  );
});

check('最終回のツールチップは今回の一覧を指す', () => {
  const app = setup({ episodeCount: 3 });

  const rows = app.el.bottomBody.children;
  const cell = findNodes(
    rows[rows.length - 1],
    (n) => n.className.includes('col-sheet')
  )[0];
  const range = findNodes(cell, (n) => n.className.includes('range'))[0];

  return (
    range.title.includes('/category/gr1974') || `→ ${range.title}`
  );
});

check('参照元が未選択のときは作業行を作らない', () => {
  const app = loadApp();

  app.state.series = SERIES;
  app.buildRows();

  return app.state.rows.length === 0 || `→ ${app.state.rows.length}行`;
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
