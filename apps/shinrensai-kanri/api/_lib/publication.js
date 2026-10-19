// ============================================================
// 出版実績ページ（gentosha-book.com）の読み取り
//
// 新連載作成アシスタントの api/fetch-info.js から、ページの解析部分を移してきたもの。
// あちらで直した不具合（段落の切れ目・連載宣伝の混入・キャッチの取り違え）を
// そのまま引き継ぐため、htmlToText / cutAtStops / extractTitleBlock の中身は変えていない。
// 片方を直したら、もう片方も直すこと。
// ============================================================

export const SITE = 'https://www.gentosha-book.com';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';


export function htmlToText(html) {
  let t = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // 改行コードを先に揃える。CRが残ったままだと空行の数を数えられない
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // </p> は段落の切れ目。<br> と見分けられるよう改行3つにする
    // （fetch-info.js の htmlToText() と同じ。理由はあちらのコメント）
    .replace(/<\/p>/gi, '\n\n\n')
    .replace(
      /<\/(div|h[1-6]|li|tr|section|article|dd|dt)>/gi,
      '\n'
    )
    .replace(/<[^>]+>/g, '');

  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");

  return t
    .split('\n')
    .map((l) =>
      l
        .replace(/[\t　 ]+$/g, '')
        .replace(/^[\t ]+/g, '')
    )
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}


// これ以降は本文でない（フッター・ナビゲーション）
const STOP_MARKERS = [
  '書籍を購',
  '出版実績一覧へ',
  'あなたも出版してみませんか',
  '出版のご相談はお気軽にどうぞ',
  '書籍検索',
  'サイト内検索',
  '公式SNS',
  'トップページ',
  'よくあるご質問',
  '資料請求',
  'テキストのコピーはできません',
];

// 内容紹介の末尾に足されるGLO連載の宣伝（fetch-info.js の cutIntroPromo() と同じ）
const INTRO_PROMO_MARKERS = [
  '幻冬舎ルネッサンス運営のWebメディア',
  '試し読みはこちら',
];

const AUTHOR_HEADINGS = [
  '■著者紹介',
  '■著者略歴',
  '■著者プロフィール',
  '■プロフィール',
];


function cutIntroPromo(text) {
  let cut = text.length;

  for (const m of INTRO_PROMO_MARKERS) {
    const i = text.indexOf(m);
    if (i !== -1) cut = Math.min(cut, i);
  }

  return text.slice(0, cut).trim();
}


function cutAtStops(text, keepSubHeadings = false) {
  let cut = text.length;

  if (keepSubHeadings) {
    for (const h of AUTHOR_HEADINGS) {
      const i = text.indexOf(h);
      if (i !== -1) cut = Math.min(cut, i);
    }
  } else {
    const h = text.search(/\n■/);
    if (h !== -1) cut = Math.min(cut, h);
  }

  for (const m of STOP_MARKERS) {
    const i = text.indexOf(m);
    if (i !== -1) cut = Math.min(cut, i);
  }

  return text.slice(0, cut).trim();
}


function sectionAfter(text, marker, keepSubHeadings = false) {
  const i = text.indexOf(marker);
  if (i === -1) return '';
  return cutAtStops(text.slice(i + marker.length), keepSubHeadings);
}


// 書名と副題。title01 ブロックの h1.main と p.sub から取る
// （fetch-info.js の extractTitleBlock() と同じ）。
// title01 が無いページは、削除済み商品のページ（HTTP 200で中身が空）。
export function extractTitleBlock(html) {
  const box = String(html || '').match(
    /<div[^>]*class="[^"]*\btitle01\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );

  if (!box) return { title: '', subtitle: '' };

  const inner = box[1];
  const t = inner.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const s = inner.match(/<p[^>]*class="[^"]*\bsub\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);

  const clean = (v) =>
    htmlToText(v)
      .replace(/\s+/g, ' ')
      .replace(/^[\s　]+|[\s　]+$/g, '');

  return {
    title: t ? clean(t[1]) : '',
    subtitle: s ? clean(s[1]) : '',
  };
}


// ============================================================
// 内容紹介の改行をシートの書き方に揃える
//
// シートの内容紹介には空行が無い。ページ上で段落が分かれているところも、
// ただの改行1つで書かれている（2026/10/19、情報入力用の20行すべてで空行0）。
// 予告記事のHTML生成は改行をそのまま <br> にするので、空行を残すと <br> が2つ並ぶ。
//
// 新連載作成アシスタントの compactLines() は段落の切れ目に空行を残すが、
// あちらは MediaWeaver に貼るための書き方。このシートとは決まりが違う。
// ============================================================

export function joinLines(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}


// ページのダッシュをシートの書き方に揃える。
//
// ページで「－－」（全角ハイフンマイナス U+FF0D）になっているところは、
// シートでは「――」（U+2015）で書かれている（gr2022・gr2032・gr2034）。
// 一方、ページで「——」（U+2014）のところは、シートも「——」のまま（gr2021）。
// なので直すのは「－」が2つ以上続くところだけ。1つだけのものは記号の可能性があるので触らない。
export function normalizeDashes(text) {
  return String(text || '').replace(/－{2,}/g, (m) => '―'.repeat(m.length));
}


// 著者紹介の1行目から、シートに入れる著者名（P.N.）を取り出す。
//
// 1行目は「大川 昂潤（おおかわ こうじゅん）」の形で、シートには読みがなを外した
// 「大川 昂潤」が入っている（20行すべてこの形で一致）。
// 「とこはれ」のように読みがなが無い作品もある。
// それ以外の形（経歴の文章が1行目に来ているなど）は取らずに空で返す。
export function authorNameFromBlock(authorBlock) {
  const first = String(authorBlock || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) || '';

  if (!first || first.length > 40 || /^[0-9０-９]/.test(first)) return '';

  const m = first.match(/^(.+?)\s*[（(][^（）()]*[）)]$/);
  if (m) return m[1].trim();

  // 読みがなが無い形。文章（句読点を含む・長い）は名前とみなさない
  if (first.length <= 20 && !/[。、，．]/.test(first)) return first;

  return '';
}


// ============================================================
// 出版実績ページの解析
// ============================================================

export function parsePublicationPage(html) {
  const text = htmlToText(html);
  const titleBlock = extractTitleBlock(html);

  let authorBlock = '';
  for (const heading of AUTHOR_HEADINGS) {
    authorBlock = sectionAfter(text, heading);
    if (authorBlock) break;
  }

  let intro = sectionAfter(text, '■内容紹介', true);
  if (!intro) intro = sectionAfter(text, '内容紹介', true);
  intro = cutIntroPromo(intro);

  // キャッチは title01 の次の product_detail_info ブロックだけを読む
  // （fetch-info.js と同じ。行の中身で判定すると書名が混入する）
  let catchCopy = '';
  const infoBlock = String(html || '').match(
    /<div[^>]*class="[^"]*\bproduct_detail_info\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (infoBlock) {
    catchCopy = htmlToText(infoBlock[1])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 400)
      .trim();
  }
  if (!catchCopy) catchCopy = titleBlock.subtitle || '';

  const pages = (String(html || '').match(/itemprop="numberOfPages"[^>]*>\s*([0-9]+)\s*</) || [])[1] || '';

  return {
    title: titleBlock.title,
    subtitle: titleBlock.subtitle,
    author: authorNameFromBlock(authorBlock),
    catchCopy: normalizeDashes(catchCopy),
    intro: normalizeDashes(joinLines(intro)),
    pages,
    pubDate: pubDateFromText(text),
    links: extractStoreLinks(html),
  };
}


// 出版年月日（「2026/8/20」など）→ 「2026-08-20」。比べるためだけに使う。
// ページは「ラベル行の次の行が値」の形なので、改行をまたいで探す（fetch-info.js と同じ）
export function pubDateFromText(text) {
  const m = String(text || '').match(/(?:出版年月日|発売日)[：:\s]*([0-9]{4})[\/年]([0-9]{1,2})[\/月]([0-9]{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}


// ============================================================
// 購入リンク
//
// ページには紙の本の欄（isbnlist01）と電子書籍の欄（isbnlist02）がある。
//   紙の本     … Amazon は `../../asin.php?isbn={ISBN13}`、楽天は楽天の検索結果へのリンク
//   電子のみ   … 紙の本の欄は isbn が空。電子書籍の欄に amazon.co.jp/dp/… と
//                books.rakuten.co.jp/rk/… が直接載っている
// 同じリンクがHTMLコメントの中にも残っているページがあるので、コメントは先に落とす。
// ============================================================

export function extractStoreLinks(html) {
  const live = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  const hrefs = [...live.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

  const isbnHref = hrefs.find((h) => /asin\.php\?isbn=97[89]\d{10}\b/.test(h));
  const isbn13 = isbnHref ? isbnHref.match(/97[89]\d{10}/)[0] : '';

  const amazonDp = hrefs.find((h) => /^https?:\/\/www\.amazon\.co\.jp\/dp\/[0-9A-Z]{10}/.test(h)) || '';
  const rakutenRk = hrefs.find((h) => /^https?:\/\/books\.rakuten\.co\.jp\/rk\/[0-9a-z]+/.test(h)) || '';

  return {
    isbn13,
    // http で載っているページがある（gr2032）。シートの値はすべて https
    amazonEbook: amazonDp
      ? amazonDp.match(/^https?:\/\/www\.amazon\.co\.jp\/dp\/[0-9A-Z]{10}/)[0].replace(/^http:/, 'https:')
      : '',
    // `?l-id=search-c-item-text-01` などの計測用パラメータは落とす（シートには付いていない）
    rakutenEbook: rakutenRk
      ? rakutenRk.replace(/[?#].*$/, '').replace(/\/?$/, '/').replace(/^http:/, 'https:')
      : '',
  };
}


// ISBN-13（978始まり）→ ISBN-10。Amazon の紙の本のURLは ISBN-10 で作る
export function isbn13to10(isbn13) {
  const s = String(isbn13 || '').replace(/-/g, '');
  if (!/^978\d{10}$/.test(s)) return '';

  const core = s.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
  const check = (11 - (sum % 11)) % 11;

  return core + (check === 10 ? 'X' : String(check));
}


// シートの形に合わせた Amazon のURL。
// 紙の本は `https://www.amazon.co.jp/exec/obidos/ASIN/{ISBN10}/`（アフィリエイトタグは付けない。
// ページの asin.php の転送先には `renaissancebo-22/ref=nosym/` が付くが、シートの値には無い）
export function amazonUrl(links) {
  const isbn10 = isbn13to10(links.isbn13);
  if (isbn10) return `https://www.amazon.co.jp/exec/obidos/ASIN/${isbn10}/`;
  return links.amazonEbook || '';
}


// ============================================================
// 楽天ブックス（紙の本）
//
// 出版実績ページには楽天の検索結果へのリンクしか無い。ふだん手でやっているのと同じく、
// 検索結果の中からショップが「楽天ブックス」の商品を探し、その商品番号で
// `https://books.rakuten.co.jp/rb/{番号}/` を作る（シートの値と同じ形）。
//
// 検索結果のクラス名には `title-link--3Yuev` のような変わりうる記号が付いているので、
// クラス名は当てにせず、ショップ名のリンクと商品リンクの並びで探す。
// ============================================================

export function findRakutenBooksItem(searchHtml) {
  const html = String(searchHtml || '');
  const marker = /data-rpp-url-copy="shop"[^>]*>\s*楽天ブックス\s*</g;

  let m;
  while ((m = marker.exec(html))) {
    // ショップ名は商品カードの下の方にある。その手前で最後に出てくる商品リンクが同じカードの商品
    const before = html.slice(Math.max(0, m.index - 8000), m.index);
    const items = [...before.matchAll(/href="https:\/\/item\.rakuten\.co\.jp\/book\/(\d+)\//g)];
    if (items.length) return `https://books.rakuten.co.jp/rb/${items[items.length - 1][1]}/`;
  }

  return '';
}


// ============================================================
// 出版実績サイトの検索結果から、商品ページの候補を取り出す
// ============================================================

export function searchResultLinks(html) {
  const live = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  const seen = new Set();
  const out = [];

  for (const m of live.matchAll(/href="(https:\/\/www\.gentosha-book\.com\/products\/[^"#?]+\/)"/g)) {
    const url = m[1];
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }

  return out;
}


// 書名どうしを比べるための正規化。
// 空白・ダッシュの種類・全角半角の違いで「別の本」と判定しないようにする
export function titleKey(title) {
  return String(title || '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[‐-‒–—―－ー-]/g, '-')
    .toLowerCase();
}
