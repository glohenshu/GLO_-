/* ============================================================
   新連載管理アシスタント 回帰テスト

     node apps/shinrensai-kanri/test/run-tests.js

   ビルドもテストフレームワークも使わない（ほかのアシスタントと同じ）。
   ネットワークには出ない。出版実績ページ・楽天・Google はすべて偽物の fetch で返す。

   確かめたいのは次の3つ。
     1. 取ってくる値が、シートに今入っている値と同じ形になること
        （実データ20行で合わせた決まり：Amazonの形、内容紹介の改行、ダッシュ、著者名）
     2. シートの、書いてはいけないセルに書かないこと
     3. 鍵：許可リストに無い人・社外のアカウント・偽のログイン情報を通さないこと
   ============================================================ */

'use strict';

const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const APP = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(APP, rel)).href);

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  OK  ${name}`);
  } else {
    fail++;
    console.log(`  NG  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);


// ------------------------------------------------------------
// 偽の出版実績ページ（実物の構造をなぞったもの）
// ------------------------------------------------------------

function pubPage({ title, subtitle = '', catchCopy = '', intro = '', author = '', pages = '', pubDate = '2026/8/20', isbn = '', ebook = null }) {
  const paperList = `
    <ul id="isbnlist01">
      <li><a target="_blank" href="../../asin.php?isbn=${isbn}">Amazon</a></li>
      <li><a target="_blank" href="http://esearch.rakuten.co.jp/rms/sd/esearch/vc?sv=30&amp;sitem=${isbn}">楽天ブックス</a></li>
    </ul>`;
  const ebookList = ebook
    ? `<ul id="isbnlist02">
        <li><a target="_blank" href="${ebook.amazon}">Amazon</a></li>
        <li><a target="_blank" href="${ebook.rakuten}">楽天ブックス</a></li>
      </ul>`
    : '';

  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>
    <h1 class="jp">出版実績</h1>
    <div class="title01 clearfix"><h1 itemprop="name" class="main">${title}</h1>${subtitle ? `<p class="sub">${subtitle}</p>` : ''}</div>
    <div class="product_detail_info"><p>${catchCopy}</p></div>
    <dl><dt>判型</dt><dd>新書・<span itemprop="numberOfPages">${pages}</span>ページ</dd>
    <dt>出版年月日</dt><dd>${pubDate}</dd></dl>
    <!-- <div class="product_link">${paperList}${ebookList}</div> -->
    <div class="product_link">${paperList}${ebookList}</div>
    <div class="text"><p>■内容紹介</p><p>${intro}</p>
    <p>■著者紹介</p><p>${author}</p></div>
    <p>書籍を購入する</p>
  </body></html>`;
}

// 実物と同じく、商品とショップのURLにはショップごとの店舗コードが入る（楽天ブックスは book）
function rakutenSearch(itemId, shop = '楽天ブックス') {
  const code = shop === '楽天ブックス' ? 'book' : 'neowing';
  return `<div class="searchresultitem">
    <h2><a href="https://item.rakuten.co.jp/${code}/${itemId}/?variantId=${itemId}" class="title-link--3Yuev">書名</a></h2>
    <div class="merchant"><a class="list-shop--3i9dy" href="https://www.rakuten.co.jp/${code}/" data-rpp-url-copy="shop">${shop}</a></div>
  </div>`;
}

// URL → 返す中身 の対応で fetch を偽装する
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const hit = Object.keys(routes).find((k) => String(url) === k || String(url).startsWith(k));
    if (!hit) return { ok: false, status: 404, text: async () => '', json: async () => ({}), headers: new Map() };
    const r = routes[hit];
    const status = typeof r === 'object' && r.status ? r.status : 200;
    const body = typeof r === 'object' && r.body !== undefined ? r.body : r;
    return {
      ok: status < 400,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
      headers: { get: () => '' },
    };
  };
  impl.calls = calls;
  return impl;
}


(async () => {
  const pub = await load('api/_lib/publication.js');
  const { lookupBook, narrowByDetails, dateKey } = await load('api/_lib/lookup.js');

  // ==========================================================
  console.log('\n1. 出版実績ページから取る値の形');
  // ==========================================================

  eq('ISBN13→ISBN10（チェック数字がX）', pub.isbn13to10('9784344699984'), '434469998X');
  eq('ISBN13→ISBN10（gr2017 のシートの値と同じ）', pub.isbn13to10('9784344699823'), '4344699823');
  eq('978以外は作らない', pub.isbn13to10('9791234567896'), '');

  eq('Amazon（紙の本）はタグ無しの exec/obidos 形', pub.amazonUrl({ isbn13: '9784344699984', amazonEbook: 'https://www.amazon.co.jp/dp/B0XXXXXXXX' }),
    'https://www.amazon.co.jp/exec/obidos/ASIN/434469998X/');
  eq('Amazon（電子のみ）は dp 形', pub.amazonUrl({ isbn13: '', amazonEbook: 'https://www.amazon.co.jp/dp/B0HKZG3W37' }),
    'https://www.amazon.co.jp/dp/B0HKZG3W37');

  const ebookHtml = pubPage({
    title: '雲のきざはし',
    isbn: '',
    ebook: {
      amazon: 'http://www.amazon.co.jp/dp/B0HKZG3W37',
      rakuten: 'https://books.rakuten.co.jp/rk/75389e01d1223cc8915279d7632e69f2/?l-id=search-c-item-text-01',
    },
  });
  const ebookLinks = pub.extractStoreLinks(ebookHtml);
  eq('電子のみ：Amazonは https に揃える（gr2032 は http で載っていた）', ebookLinks.amazonEbook, 'https://www.amazon.co.jp/dp/B0HKZG3W37');
  eq('電子のみ：楽天は計測用パラメータを落とす', ebookLinks.rakutenEbook, 'https://books.rakuten.co.jp/rk/75389e01d1223cc8915279d7632e69f2/');
  eq('電子のみ：紙の本のISBNは空', ebookLinks.isbn13, '');

  const paperOnlyInComment = `<!-- <a href="../../asin.php?isbn=9784344699984">Amazon</a> --><div></div>`;
  eq('HTMLコメントの中のリンクは使わない', pub.extractStoreLinks(paperOnlyInComment).isbn13, '');

  eq('著者名：読みがなを外す', pub.authorNameFromBlock('大川 昂潤（おおかわ こうじゅん）\n1960年生まれ。'), '大川 昂潤');
  eq('著者名：読みがなが外国語読みでも外す（gr2028）', pub.authorNameFromBlock('全 大成（ジョン・デソン）'), '全 大成');
  eq('著者名：半角括弧', pub.authorNameFromBlock('瀧乃(たきの)'), '瀧乃');
  eq('著者名：読みがなが無い（gr2033）', pub.authorNameFromBlock('とこはれ\n東京都在住。'), 'とこはれ');
  eq('著者名：1行目が経歴の文章なら取らない', pub.authorNameFromBlock('1950年、東京都に生まれる。大学卒業後、商社に入社。'), '');

  eq('ダッシュ：「－－」はシートの「――」に', pub.normalizeDashes('生きていた－－'), '生きていた――');
  eq('ダッシュ：「——」はそのまま（gr2021 のシートも——）', pub.normalizeDashes('会いに行く——。'), '会いに行く——。');
  eq('ダッシュ：1つだけのものは触らない', pub.normalizeDashes('A－B'), 'A－B');

  eq('内容紹介：空行を残さない（シートの内容紹介に空行は無い）', pub.joinLines('一行目\n\n二行目\n\n\n\n三行目\n'), '一行目\n二行目\n三行目');

  const paperHtml = pubPage({
    title: '世界を歩くビジネスマンになるには',
    subtitle: '88歳から皆様に送るエール',
    catchCopy: '毎日3人に会う。その習慣が、世界の扉を開く。',
    intro: '故郷の三陸の漁村から、<br />\n東京へ。</p>\n<p>人に会いに行く－－。</p><p>&nbsp;</p><p>幻冬舎ルネッサンス運営のWebメディア「ゴールドライフオンライン」にて連載中。</p><p><a href="#">▶試し読みはこちら</a>',
    author: '千田 俊章（ちだ としあき）<br />1937年生まれ。',
    pages: '140',
    isbn: '9784344699984',
  });
  const parsed = pub.parsePublicationPage(paperHtml);
  eq('ページ：書名', parsed.title, '世界を歩くビジネスマンになるには');
  eq('ページ：キャッチ', parsed.catchCopy, '毎日3人に会う。その習慣が、世界の扉を開く。');
  eq('ページ：内容紹介（段落もただの改行・宣伝は落とす・ダッシュを揃える）', parsed.intro, '故郷の三陸の漁村から、\n東京へ。\n人に会いに行く――。');
  eq('ページ：著者名', parsed.author, '千田 俊章');
  eq('ページ：分量', parsed.pages, '140');
  eq('ページ：出版年月日', parsed.pubDate, '2026-08-20');
  eq('ページ：紙の本のISBN', parsed.links.isbn13, '9784344699984');

  eq('楽天：ショップが楽天ブックスの商品', pub.findRakutenBooksItem(rakutenSearch('18778713')), 'https://books.rakuten.co.jp/rb/18778713/');
  eq('楽天：ほかのショップの商品は使わない', pub.findRakutenBooksItem(rakutenSearch('999', 'ネオウィング 楽天市場店')), '');
  eq('楽天：楽天ブックスが2件目でも拾う',
    pub.findRakutenBooksItem(rakutenSearch('111', 'ネオウィング 楽天市場店') + rakutenSearch('18824158')),
    'https://books.rakuten.co.jp/rb/18824158/');
  eq('楽天：ショップ名の属性が無くても、ショップのURLで見分ける',
    pub.findRakutenBooksItem(
      '<a href="https://item.rakuten.co.jp/bookfan/bk-434469998x/">a</a><a href="https://www.rakuten.co.jp/bookfan/">bookfan</a>' +
      '<a href="https://item.rakuten.co.jp/book/18778713/?s-id=x">b</a><a href="https://www.rakuten.co.jp/book/">Rakuten Books</a>'
    ),
    'https://books.rakuten.co.jp/rb/18778713/');
  eq('楽天：ページ上部の楽天ブックスへのリンク（商品より前）は無視する',
    pub.findRakutenBooksItem('<a href="https://www.rakuten.co.jp/book/">本</a>' + rakutenSearch('999', 'ネオウィング 楽天市場店')),
    '');
  check('楽天：見つからなかったときの説明に、ページの題名と件数が入る',
    /「【楽天市場】X」.*「楽天ブックス」0件.*商品リンク0件/.test(pub.describeRakutenPage('<title>【楽天市場】X</title>')),
    pub.describeRakutenPage('<title>【楽天市場】X</title>'));

  eq('検索結果：商品ページだけ・重複なし',
    pub.searchResultLinks('<a href="https://www.gentosha-book.com/products/9784344700246/">a</a><a href="https://www.gentosha-book.com/products/9784344700246/">b</a><a href="https://www.gentosha-book.com/news/">c</a>'),
    ['https://www.gentosha-book.com/products/9784344700246/']);
  check('書名の比較：空白・ダッシュの種類の違いは同じ扱い', pub.titleKey('なぜ人は、分かっていても　変われないのか――') === pub.titleKey('なぜ人は、分かっていても変われないのか——'));
  check('書名の比較：違う書名は違う', pub.titleKey('距離を感じる日々') !== pub.titleKey('距離を感じる日々2'));

  eq('日付の揃え方', dateKey('2026/8/20'), '2026-08-20');


  // ==========================================================
  console.log('\n2. 1作品ぶんの自動取得（/api/lookup の中身）');
  // ==========================================================

  const NEW_URL = 'https://www.gentosha-book.com/products/9784344699984/';
  const OLD_URL = 'https://www.gentosha-book.com/products/4779001110/';
  const oldHtml = pubPage({ title: '世界を歩くビジネスマンになるには', pubDate: '2006/3/1' });

  {
    const f = fakeFetch({
      'https://www.gentosha-book.com/?s=': `<a href="${NEW_URL}">a</a><a href="${OLD_URL}">b</a>`,
      [NEW_URL]: paperHtml,
      [OLD_URL]: oldHtml,
      'https://search.rakuten.co.jp/search/mall/9784344699984/': rakutenSearch('18778713'),
    });
    const r = await lookupBook(
      { title: '世界を歩くビジネスマンになるには', url: '', subtitle: '――88歳から皆様に送るエール', releaseDate: '2026/08/20' },
      { fetchImpl: f }
    );
    eq('同じ書名の旧版があっても、サブタイトルで新しい方を選ぶ（gr2021）', [r.status, r.values.url], ['ok', NEW_URL]);
    eq('取った値', [r.values.author, r.values.pages, r.values.amazon, r.values.rakuten],
      ['千田 俊章', '140', 'https://www.amazon.co.jp/exec/obidos/ASIN/434469998X/', 'https://books.rakuten.co.jp/rb/18778713/']);
  }

  {
    const matched = [{ url: 'a', html: pubPage({ title: 'X', pubDate: '2026/8/20' }) }, { url: 'b', html: pubPage({ title: 'X', pubDate: '2019/1/1' }) }];
    eq('サブタイトルが無くても、刊行日で絞る', narrowByDetails(matched, { subtitle: '', releaseDate: '2026/08/20' }).map((m) => m.url), ['a']);
  }

  {
    const f = fakeFetch({ 'https://www.gentosha-book.com/?s=': '<p>見つかりませんでした</p>' });
    const r = await lookupBook({ title: '発売前の本', url: '' }, { fetchImpl: f });
    eq('検索で見つからなければ「ページなし」', [r.status, r.values.url], ['notfound', '']);
  }

  {
    // 実物のサイトは、検索結果が0件のとき 404 を返す
    const f = fakeFetch({ 'https://www.gentosha-book.com/?s=': { status: 404, body: '<title>ページが見つかりません</title>' } });
    const r = await lookupBook({ title: '兵機人類', url: '' }, { fetchImpl: f });
    eq('検索が 404（結果0件）なら、エラーではなく「ページなし」', [r.status, r.message.includes('まだありません')], ['notfound', true]);
  }

  {
    const f = fakeFetch({
      'https://www.gentosha-book.com/?s=': `<a href="${OLD_URL}">b</a>`,
      [OLD_URL]: pubPage({ title: '別の本' }),
    });
    const r = await lookupBook({ title: '発売前の本', url: '' }, { fetchImpl: f });
    eq('検索結果に書名が一致するページが無ければ「ページなし」（似た書名の別の本を入れない）', r.status, 'notfound');
  }

  {
    const f = fakeFetch({ [NEW_URL]: '<html><body><p>商品が見つかりません</p></body></html>' });
    const r = await lookupBook({ title: '世界を歩くビジネスマンになるには', url: NEW_URL }, { fetchImpl: f });
    eq('貼られたURLが削除済みページ（HTTP 200で書名なし）', r.status, 'gone');
  }

  {
    const f = fakeFetch({ [OLD_URL]: pubPage({ title: '別の本' }) });
    const r = await lookupBook({ title: '世界を歩くビジネスマンになるには', url: OLD_URL }, { fetchImpl: f });
    eq('貼られたURLが別の本', [r.status, r.values.author], ['mismatch', '']);
  }

  {
    const r = await lookupBook({ title: 'X', url: 'https://example.com/products/1/' }, { fetchImpl: fakeFetch({}) });
    eq('出版実績サイト以外のURLは開かない', [r.status, r.message.includes('gentosha-book.com')], ['error', true]);
  }

  {
    const f = fakeFetch({ 'https://www.gentosha-book.com/?s=': { status: 403, body: '' } });
    const r = await lookupBook({ title: 'X', url: '' }, { fetchImpl: f });
    check('403 のときは「断られた」と出す', r.status === 'error' && r.message.includes('403'), r.message);
  }

  {
    const f = fakeFetch({
      [NEW_URL]: paperHtml,
      'https://search.rakuten.co.jp/search/mall/': { status: 503, body: '' },
    });
    const r = await lookupBook({ title: '世界を歩くビジネスマンになるには', url: NEW_URL }, { fetchImpl: f });
    eq('楽天だけ取れなくても、ほかの値は返す', [r.status, r.values.author, r.values.rakuten, Boolean(r.notes.rakuten)], ['ok', '千田 俊章', '', true]);
  }


  // ==========================================================
  console.log('\n3. シートの読み方・書き方');
  // ==========================================================

  const L = require(path.join(APP, 'sheet-logic.js'));

  const HEADER = [
    'Kintone\n登録済み', 'カテゴリ\nコード', '制作No', '公開年月日', '曜日', '配信\n時間', '刊行日', '書籍タイトル', 'サブタイトル',
    '著者名（P.N.）', 'クライアント名', 'キャッチ\n（カテゴリ説明）', '内容紹介', '出版実績URL', '分量', 'ちょい読み', '印刷所',
    '原稿形態', '特殊', '備考（刊行時）', '備考（掲載時）', '本文\nデータ', '書影\n保存', 'Amazon \nアフィリエイト', '楽天\nアフィリエイト',
  ];
  const row = (o) => {
    const r = new Array(25).fill('');
    Object.entries(o).forEach(([k, v]) => (r[k] = v));
    return r;
  };

  eq('見出しが今のシートどおりなら問題なし', L.checkHeader(HEADER), []);
  {
    const moved = HEADER.slice();
    moved.splice(9, 0, '新しい列');
    check('列が1つ挿入されたら止める', L.checkHeader(moved).length > 0);
  }

  const values = [
    HEADER,
    row({ 0: '済', 1: 'gr2017', 2: '25288', 6: '2026/08/28', 7: 'ボタンのありか', 9: '大川 昂潤', 13: 'https://www.gentosha-book.com/products/9784344699823/', 14: '106' }),
    row({ 2: '25303', 7: '鰹がくれたこの道を' }),
    row({ 2: '', 7: '' }),
  ];
  const rows = L.parseRows(values);
  eq('書籍タイトルが空の行は読まない', rows.map((r) => r.title), ['ボタンのありか', '鰹がくれたこの道を']);
  eq('行のキーは制作No', rows.map((r) => r.key), ['no:25288', 'no:25303']);

  {
    const plan = L.planCells(rows[0], {
      url: 'https://www.gentosha-book.com/products/9784344699823',
      author: '大川 昂潤',
      catchCopy: 'あなたの愛で、今日も生きている。',
      pages: '106',
      amazon: 'https://www.amazon.co.jp/exec/obidos/ASIN/4344699823/',
      rakuten: '',
    });
    const s = Object.fromEntries(plan.map((c) => [c.key, c.state]));
    eq('セルの扱い', s, { url: 'same', author: 'same', catchCopy: 'fill', intro: 'none', pages: 'same', amazon: 'fill', rakuten: 'none' });
    eq('最初にチェックが入るのは空欄を埋めるセルだけ', plan.filter((c) => c.checked).map((c) => c.key), ['catchCopy', 'amazon']);
  }
  {
    const plan = L.planCells(rows[0], { author: '大川昂潤' });
    const c = plan.find((x) => x.key === 'author');
    eq('シートと違う値は「上書き」扱いで、最初はチェックなし', [c.state, c.checked], ['differs', false]);
  }

  const SHEET_ID = 619736651;
  const pendingFor = (r, field, value) => ({ key: r.key, title: r.title, field, value, expected: r.current[field] });

  {
    // 読み込んだあとに「公開日順にソート」で行の順番が変わった
    const fresh = [HEADER, values[2], values[1]];
    const plan = L.buildWrites(SHEET_ID, fresh, [pendingFor(rows[1], 'author', '森下 幸次')]);
    eq('行が動いても、制作Noで探した行に書く', plan.requests.map((q) => q.updateCells.range.startRowIndex), [1]);
    eq('書き込む列は J（著者名）', plan.requests.map((q) => q.updateCells.range.startColumnIndex), [9]);
  }

  {
    const fresh = [HEADER, values[1], row({ 2: '25303', 7: '鰹がくれたこの道を', 9: '森下幸次' })];
    const plan = L.buildWrites(SHEET_ID, fresh, [pendingFor(rows[1], 'author', '森下 幸次')]);
    eq('読み込んだあとに手で入れられた値は上書きしない', [plan.requests.length, plan.skipped.length], [0, 1]);
  }

  {
    const fresh = [HEADER, values[1], values[2], row({ 2: '25303', 7: '鰹がくれたこの道を' })];
    const plan = L.buildWrites(SHEET_ID, fresh, [pendingFor(rows[1], 'author', '森下 幸次')]);
    eq('同じ制作Noの行が2つあれば書かない', [plan.requests.length, plan.skipped.length], [0, 1]);
  }

  {
    const fresh = [HEADER, values[1], row({ 2: '25303', 7: '別の書名' })];
    const plan = L.buildWrites(SHEET_ID, fresh, [pendingFor(rows[1], 'author', '森下 幸次')]);
    eq('同じ制作Noでも書籍タイトルが変わっていたら書かない', plan.requests.length, 0);
  }

  {
    const fresh = [HEADER, values[1]];
    const plan = L.buildWrites(SHEET_ID, fresh, [pendingFor(rows[1], 'author', '森下 幸次')]);
    eq('行が消えていたら書かない', [plan.requests.length, plan.skipped.length], [0, 1]);
  }

  {
    const moved = HEADER.slice();
    moved.splice(9, 0, '新しい列');
    const plan = L.buildWrites(SHEET_ID, [moved, values[1], values[2]], [pendingFor(rows[1], 'author', '森下 幸次')]);
    check('書く直前に列の並びが変わっていたら全部止める', plan.requests.length === 0 && Boolean(plan.error));
  }

  {
    const fresh = [HEADER, values[1], values[2]];
    const plan = L.buildWrites(SHEET_ID, fresh, [pendingFor(rows[0], 'author', '大川昂潤')]);
    eq('上書きを選んだセルは、シートが画面のときのままなら書く', plan.requests.length, 1);
  }

  {
    const fields = Object.fromEntries(L.FIELDS.map((f) => [f.key, f]));
    eq('分量は数値で書く', L.cellRequest(1, 2, fields.pages, '140').updateCells.rows[0].values[0].userEnteredValue, { numberValue: 140 });
    eq('= で始まる文字は数式にせず、文字のまま書く', L.cellRequest(1, 2, fields.catchCopy, '=SUM(A1)').updateCells.rows[0].values[0].userEnteredValue, { stringValue: '=SUM(A1)' });
    eq('書き込み先の列は7列だけ（N・J・L・M・O・X・Y）', L.FIELDS.map((f) => f.letter).sort(), ['J', 'L', 'M', 'N', 'O', 'X', 'Y']);
  }


  // ==========================================================
  console.log('\n4. 鍵（ログイン・セッション・入口）');
  // ==========================================================

  const SECRET = 'x'.repeat(40);
  const CLIENT_ID = 'test-client.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.ALLOWED_EMAILS = 'fujimoto@gentosha.co.jp, Gglo_support@gentosha.co.jp';
  process.env.SESSION_SECRET = SECRET;
  delete process.env.ALLOWED_DOMAIN;

  const S = await load('api/_lib/session.js');
  const NOW = Date.UTC(2026, 9, 19, 3, 0, 0);

  {
    const v = S.signSession('fujimoto@gentosha.co.jp', SECRET, NOW);
    eq('セッション：正しいもの', S.verifySessionValue(v, SECRET, NOW + 1000).email, 'fujimoto@gentosha.co.jp');
    eq('セッション：期限切れ', S.verifySessionValue(v, SECRET, NOW + (S.SESSION_HOURS + 1) * 3600 * 1000), null);
    eq('セッション：別の秘密鍵で作ったもの', S.verifySessionValue(S.signSession('fujimoto@gentosha.co.jp', 'y'.repeat(40), NOW), SECRET, NOW), null);

    const [body, sig] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ e: 'someone@gentosha.co.jp', x: NOW + 1e9 })).toString('base64url');
    eq('セッション：中身を書き換えたもの', S.verifySessionValue(`${forged}.${sig}`, SECRET, NOW), null);
    eq('セッション：署名なし', S.verifySessionValue(body, SECRET, NOW), null);
  }

  {
    const c = S.config();
    const cookie = (email) => `a=1; ${S.COOKIE_NAME}=${S.signSession(email, SECRET, NOW)}; b=2`;
    eq('許可リストの人（大文字小文字は区別しない）', S.readSession(cookie('gglo_support@gentosha.co.jp'), c, NOW).email, 'gglo_support@gentosha.co.jp');
    eq('ログイン後に許可リストから外された人は通さない', S.readSession(cookie('former@gentosha.co.jp'), c, NOW), null);
    eq('Cookieが無い', S.readSession('', c, NOW), null);
    eq('SESSION_SECRET が短すぎる設定では誰も通さない', S.readSession(cookie('fujimoto@gentosha.co.jp'), { ...c, secret: 'short' }, NOW), null);
    check('Cookieは HttpOnly・Secure・SameSite=Lax', /HttpOnly/.test(S.sessionCookie('v')) && /Secure/.test(S.sessionCookie('v')) && /SameSite=Lax/.test(S.sessionCookie('v')));
  }

  // Google のIDトークンを、テスト用の鍵で作る
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const makeToken = (claims, key = privateKey, kid = 'k1') => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const good = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 600,
    email: 'fujimoto@gentosha.co.jp',
    email_verified: true,
    hd: 'gentosha.co.jp',
  };
  const verify = async (claims, opts = {}) => {
    try {
      return (await S.verifyGoogleIdToken(makeToken(claims, opts.key, opts.kid), S.config(), { now: NOW, keys: [jwk] })).email;
    } catch (e) {
      return `NG:${e.message}`;
    }
  };

  eq('IDトークン：許可リストの社員', await verify(good), 'fujimoto@gentosha.co.jp');
  check('IDトークン：許可リストに無い社員', (await verify({ ...good, email: 'other@gentosha.co.jp' })).includes('登録されていません'));
  check('IDトークン：個人のGmail（hd なし）', (await verify({ ...good, email: 'fujimoto@gmail.com', hd: undefined })).startsWith('NG:'));
  check('IDトークン：hd を偽っても、アドレスのドメインが違えば通さない', (await verify({ ...good, email: 'fujimoto@example.com' })).startsWith('NG:'));
  check('IDトークン：別のアプリ宛て', (await verify({ ...good, aud: 'other-app' })).includes('このアプリ宛て'));
  check('IDトークン：期限切れ', (await verify({ ...good, exp: Math.floor(NOW / 1000) - 1 })).includes('期限'));
  check('IDトークン：メール未確認', (await verify({ ...good, email_verified: false })).startsWith('NG:'));
  check('IDトークン：Google以外が発行', (await verify({ ...good, iss: 'https://evil.example' })).startsWith('NG:'));
  {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    check('IDトークン：Googleの鍵で署名されていない', (await verify(good, { key: other })).includes('署名'));
  }

  const { default: middleware } = await load('middleware.js');
  const req = (p, cookie) => new Request(`https://example.vercel.app${p}`, { headers: cookie ? { cookie } : {} });
  const okCookie = `${S.COOKIE_NAME}=${S.signSession('fujimoto@gentosha.co.jp', SECRET)}`;

  {
    const r = middleware(req('/'));
    eq('入口：ログインしていなければ画面はログインへ', [r.status, r.headers.get('location')], [302, '/login.html']);
  }
  eq('入口：ログインしていなければ API は 401', middleware(req('/api/lookup')).status, 401);
  eq('入口：ログインしていなければ app.js も返さない', middleware(req('/app.js')).status, 302);
  eq('入口：ログイン画面は開ける', middleware(req('/login.html')).headers.get('x-middleware-next'), '1');
  eq('入口：ログインしていれば通す', middleware(req('/', okCookie)).headers.get('x-middleware-next'), '1');


  console.log(`\n${pass + fail}件中 ${pass}件OK / ${fail}件NG`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
