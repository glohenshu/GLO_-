// ============================================================
// 1作品ぶんの自動取得
//
//   N列が空         … 書名で出版実績サイトを検索し、書名が一致するページを探す
//   N列にURLがある  … そのページがあるか（削除済みでないか・同じ本か）を確かめる
// 見つかったページから、著者名・キャッチ・内容紹介・分量・Amazon・楽天を取る。
//
// 新連載作成アシスタントと同じく、1つの取得に失敗しても残りは止めない。
// 取れなかった項目は空にして、理由を notes に書く。
// ============================================================

import {
  SITE,
  UA,
  parsePublicationPage,
  amazonUrl,
  findRakutenBooksItem,
  searchResultLinks,
  extractTitleBlock,
  htmlToText,
  pubDateFromText,
  titleKey,
} from './publication.js';


const EMPTY_VALUES = {
  url: '',
  author: '',
  catchCopy: '',
  intro: '',
  pages: '',
  amazon: '',
  rakuten: '',
};


async function getText(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.text();
}


function failMessage(e, what) {
  // 出版実績サイトは bot 対策で 403 を返すことがある（新連載作成アシスタントでも起きている）
  if (e && e.status === 403) return `${what}に断られました（403）。時間をおいてやり直してください`;
  return `${what}を読めませんでした（${(e && e.message) || e}）`;
}


// サブタイトルの比べ方。シートは「――88歳から皆様に送るエール」、
// ページは「88歳から皆様に送るエール」のように、前後のダッシュの有無が違う
const subtitleKey = (s) => titleKey(s).replace(/^-+|-+$/g, '');

// 「2026/08/20」「2026-8-20」などを「2026-08-20」に揃える
export function dateKey(v) {
  const m = String(v || '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}


// 書名が同じページが複数あるとき、サブタイトル → 刊行日の順で絞る。
// gr2021「世界を歩くビジネスマンになるには」は、同じ書名の旧版（サブタイトル無し）がある
export function narrowByDetails(matched, { subtitle, releaseDate }) {
  let rest = matched;

  if (subtitle) {
    const bySub = rest.filter((m) => subtitleKey(extractTitleBlock(m.html).subtitle) === subtitleKey(subtitle));
    if (bySub.length) rest = bySub;
  }

  if (rest.length > 1 && dateKey(releaseDate)) {
    const byDate = rest.filter((m) => pubDateFromText(htmlToText(m.html)) === dateKey(releaseDate));
    if (byDate.length) rest = byDate;
  }

  return rest;
}


// 書名で検索して、書名が一致するページを1つに決める。
// 検索結果には似た書名の別の本が混ざるので、候補ページを開いて title01 の書名と突き合わせる
async function findPageByTitle(title, details, fetchImpl) {
  const searchUrl = `${SITE}/?s=${encodeURIComponent(title)}`;
  const candidates = searchResultLinks(await getText(searchUrl, fetchImpl));

  if (!candidates.length) {
    return { status: 'notfound', message: '出版実績ページがまだありません（サイト内検索で見つかりません）' };
  }

  const want = titleKey(title);
  const matched = [];

  // 候補はふつう1〜2件。多いときも先頭から順に見て、多すぎるときは打ち切る
  for (const url of candidates.slice(0, 8)) {
    const html = await getText(url, fetchImpl);
    if (titleKey(extractTitleBlock(html).title) === want) matched.push({ url, html });
  }

  const narrowed = narrowByDetails(matched, details);
  if (narrowed.length === 1) return { status: 'ok', ...narrowed[0] };

  if (!matched.length) {
    return {
      status: 'notfound',
      message: `書名が一致する出版実績ページがありません（検索結果 ${candidates.length} 件を確認）`,
      candidates: candidates.slice(0, 8),
    };
  }

  return {
    status: 'ambiguous',
    message: `同じ書名の出版実績ページが ${narrowed.length} 件あり、サブタイトルと刊行日でも1つに絞れません。URLを手で貼ってください`,
    candidates: narrowed.map((m) => m.url),
  };
}


// title … H列 書籍タイトル / url … N列 出版実績URL（空でもよい）
// subtitle … I列 / releaseDate … G列 刊行日（同じ書名のページが複数あるときの絞り込みに使う）
export async function lookupBook({ title, url, subtitle, releaseDate }, { fetchImpl = fetch } = {}) {
  const result = {
    status: 'error',
    message: '',
    candidates: [],
    values: { ...EMPTY_VALUES },
    notes: {},
  };

  title = String(title || '').trim();
  url = String(url || '').trim();

  if (!title && !url) {
    result.message = '書籍タイトルも出版実績URLも空です';
    return result;
  }

  // ------------------------------------------------------------
  // 出版実績ページを決める
  // ------------------------------------------------------------

  let html = '';

  if (url) {
    if (!/^https:\/\/www\.gentosha-book\.com\/products\/[^?#]+/.test(url)) {
      result.message = '出版実績URLが gentosha-book.com の商品ページではありません';
      return result;
    }

    try {
      html = await getText(url, fetchImpl);
    } catch (e) {
      result.message = e.status === 404
        ? '出版実績URLのページがありません（404）'
        : failMessage(e, '出版実績ページ');
      return result;
    }

    const pageTitle = extractTitleBlock(html).title;

    // 削除済み商品のURLは HTTP 200 で、書名の無いページを返す
    if (!pageTitle) {
      result.status = 'gone';
      result.message = '出版実績URLのページは削除されています（書名がありません）';
      return result;
    }

    if (title && titleKey(pageTitle) !== titleKey(title)) {
      result.status = 'mismatch';
      result.message = `出版実績URLのページは別の本です（ページの書名：${pageTitle}）`;
      return result;
    }

    result.values.url = url;
  } else {
    let found;
    try {
      found = await findPageByTitle(title, { subtitle, releaseDate }, fetchImpl);
    } catch (e) {
      result.message = failMessage(e, '出版実績サイト');
      return result;
    }

    if (found.status !== 'ok') {
      result.status = found.status;
      result.message = found.message;
      result.candidates = found.candidates || [];
      return result;
    }

    html = found.html;
    result.values.url = found.url;
  }

  // ------------------------------------------------------------
  // ページから取る
  // ------------------------------------------------------------

  const page = parsePublicationPage(html);

  result.values.author = page.author;
  result.values.catchCopy = page.catchCopy;
  result.values.intro = page.intro;
  result.values.pages = page.pages;
  result.values.amazon = amazonUrl(page.links);

  if (!page.author) result.notes.author = '著者紹介の1行目から著者名を読み取れませんでした';
  if (!page.pages) result.notes.pages = 'ページ数の記載がありません（電子のみの作品に多い）';
  if (!result.values.amazon) result.notes.amazon = 'ページにAmazonのリンクがありません';

  // 楽天：電子のみはページに直接載っている。紙の本は楽天の検索結果から探す
  if (page.links.isbn13) {
    try {
      const searchHtml = await getText(
        `https://search.rakuten.co.jp/search/mall/${page.links.isbn13}/?v=2`,
        fetchImpl
      );
      result.values.rakuten = findRakutenBooksItem(searchHtml);
      if (!result.values.rakuten) {
        result.notes.rakuten = '楽天の検索結果に楽天ブックスの商品がありません。手で貼ってください';
      }
    } catch (e) {
      result.notes.rakuten = failMessage(e, '楽天の検索結果') + '。手で貼ってください';
    }
  } else {
    result.values.rakuten = page.links.rakutenEbook;
    if (!result.values.rakuten) result.notes.rakuten = 'ページに楽天のリンクがありません';
  }

  result.status = 'ok';
  return result;
}
