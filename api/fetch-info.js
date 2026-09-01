// 新連載作成アシスタント Ver.1
// 情報取得API：kintone / 出版実績ページ / Googleスプレッドシートを一括取得する。
// 一部の取得に失敗しても全体を停止せず、ソースごとに status を返す（仕様書 12章）。

export default async function handler(req, res) {
  const code = (req.query.code || '').trim();

  if (!code) {
    res.status(400).json({
      error: 'カテゴリコードが指定されていません',
    });
    return;
  }

  const result = {
    kintone: {
      status: 'error',
      message: '',
      data: null,
    },
    publication: {
      status: 'error',
      message: '',
      data: null,
    },
    sheet: {
      status: 'error',
      message: '',
      rows: null,
    },
    links: {
      kintone: '',
      publication: '',
      articleSheet: '',
      mediaweaver: '',
    },
  };

  // ============================================================
  // 1. kintone「GLO連載情報」
  // ============================================================

  let record = null;

  try {
    const base = process.env.KINTONE_BASE_URL;
    const token = process.env.KINTONE_API_TOKEN;
    const appId = process.env.KINTONE_APP_ID;

    if (!base || !token || !appId) {
      throw new Error('kintoneの環境変数が未設定です');
    }

    const query = encodeURIComponent(`カテゴリID = "${code}"`);
    const url =
      `${base}/k/v1/records.json?app=${appId}&query=${query}`;

    const r = await fetch(url, {
      headers: {
        'X-Cybozu-API-Token': token,
      },
    });

    if (!r.ok) {
      throw new Error(`kintone API エラー (${r.status})`);
    }

    const json = await r.json();

    if (!json.records || json.records.length === 0) {
      throw new Error(
        `カテゴリID「${code}」のレコードが見つかりません`
      );
    }

    const f = json.records[0];

    const recordId = f['$id']?.value ?? '';

    record = {
      bookTitle: f['書籍タイトル']?.value ?? '',
      categoryId: f['カテゴリID']?.value ?? '',
      firstDelivery: f['第1回配信日時']?.value ?? '',
      pubUrl: f['出版実績URL']?.value ?? '',
      productionNo: f['制作No']?.value ?? '',
      recordId,
    };

    result.kintone = {
      status: 'ok',
      message: '',
      data: record,
    };

    // kintone該当レコードへの確認用リンク
    if (recordId) {
      result.links.kintone =
        `${base}/k/${appId}/show#record=${recordId}`;
    }

    // 出版実績ページへの確認用リンク
    result.links.publication =
      record.pubUrl || '';

  } catch (e) {
    result.kintone.message =
      String(e.message || e);
  }

  // ============================================================
  // 2. 出版実績ページ
  // ============================================================

  try {
    const pubUrl = record?.pubUrl;

    if (!pubUrl) {
      throw new Error(
        '出版実績URLが取得できません'
      );
    }

    const r = await fetch(pubUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; GLO-Assistant/1.0)',
      },
    });

    if (!r.ok) {
      throw new Error(
        `ページ取得エラー (${r.status})`
      );
    }

    const html = await r.text();

    result.publication = {
      status: 'ok',
      message: '',
      data: parsePublicationPage(html),
    };

  } catch (e) {
    result.publication.message =
      String(e.message || e);
  }

  // ============================================================
  // 3. Googleスプレッドシート「毎月の記事下リンク」
  // ============================================================

  try {
    const gasUrl =
      process.env.SHEET_GAS_URL;

    if (gasUrl) {
      // GAS（ウェブアプリ）経由
      // 共有ドライブの外部共有制限がある場合はこちらを使用
      const r = await fetch(gasUrl, {
        redirect: 'follow',
      });

      if (!r.ok) {
        throw new Error(
          `GAS取得エラー (${r.status})`
        );
      }

      const json = await r.json();

      if (!Array.isArray(json.values)) {
        throw new Error(
          'GASの応答形式が不正です'
        );
      }

      result.sheet = {
        status: 'ok',
        message: '',
        rows: json.values,
      };

    } else {
      // Sheets API（APIキー）経由
      const sheetId =
        process.env.SHEET_ID;
      const apiKey =
        process.env.GOOGLE_API_KEY;

      if (!sheetId || !apiKey) {
        throw new Error(
          'SHEET_GAS_URL（またはSHEET_ID/GOOGLE_API_KEY）が未設定です'
        );
      }

      const sheetName =
        process.env.SHEET_NAME;

      const range = sheetName
        ? `${encodeURIComponent(sheetName)}!B:C`
        : 'B:C';

      const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;

      const r = await fetch(url);

      if (!r.ok) {
        throw new Error(
          `Sheets API エラー (${r.status})`
        );
      }

      const json = await r.json();

      result.sheet = {
        status: 'ok',
        message: '',
        rows: json.values || [],
      };
    }

  } catch (e) {
    result.sheet.message =
      String(e.message || e);
  }

  // ============================================================
  // 4. 確認用リンク
  // ============================================================

  // 「毎月の記事下リンク」
  //
  // ARTICLE_SHEET_URL は、
  // ・完全なGoogleスプレッドシートURL
  // ・スプレッドシートIDだけ
  //
  // のどちらでも使用可能。
  const articleSheetValue =
    String(
      process.env.ARTICLE_SHEET_URL || ''
    ).trim();

  if (articleSheetValue) {
    result.links.articleSheet =
      /^https?:\/\//i.test(articleSheetValue)
        ? articleSheetValue
        : `https://docs.google.com/spreadsheets/d/${articleSheetValue}/edit`;
  }

  // MediaWeaver
  result.links.mediaweaver =
    String(
      process.env.MEDIAWEAVER_URL || ''
    ).trim();

  // ============================================================
  // 全処理終了後に1回だけレスポンスを返す
  // ============================================================

  res.status(200).json(result);
}


// ============================================================
// 出版実績ページの解析
// ============================================================

function htmlToText(html) {
  let t = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // 改行コードを先に揃える。CRが残ったままだと空行の数を数えられない
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // </p> は段落の切れ目。ただの改行（<br>）と区別できるよう空行を作る。
    //
    // ページのHTMLは
    //   段落の中の改行 … `<br />` + ページ側の改行
    //   段落の切れ目   … `</p>` + ページ側の改行 + `<p>`
    // で、どちらも「\n + ページ側の改行」になっていた。
    // そのため段落かどうかを後段で見分けられず、著者紹介の段落が
    // 消えていた（gr1953 など）。
    //
    // `</p><p>` が改行なしで続くページもあるため改行3つにしておく。
    // 末尾の \n{4,} → \n\n\n で空行2つに揃うので、
    //   空行1つ    … ただの改行
    //   空行2つ    … 段落の切れ目
    // という形になる。app.js の compactLines() がこれを見ている。
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
        .replace(/[\t\u3000 ]+$/g, '')
        .replace(/^[\t ]+/g, '')
    )
    .join('\n')
    // 空行は最大2つまで。段落の切れ目（空行2つ）を潰さない
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}


// ============================================================
// フッター・ナビゲーション等の開始語
// これ以降は本文でない
// ============================================================

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


// ============================================================
// 著者セクションの見出し（ページ側の表記ゆれに対応）
// ページによって「■著者紹介」ではなく「■著者略歴」等になっている
// ============================================================

const AUTHOR_HEADINGS = [
  '■著者紹介',
  '■著者略歴',
  '■著者プロフィール',
  '■プロフィール',
];


// 出版実績ページの項目ラベル。
// 値が空欄のとき、次のラベル行を値として拾わないための判定に使う。
const FIELD_LABELS_RE =
  /^(ISBN|判型|出版年月日|発売日|定価|価格|内容紹介|著者紹介|著者略歴|著者プロフィール|プロフィール|著者|ジャンル|シリーズ|電子書籍のみ|新刊)$/;


// keepSubHeadings=true の場合、本文中の
// 「■5台のカメラ開発秘話」のような小見出しでは打ち切らず、
// 著者セクションの見出しまでを本文として扱う。
function cutAtStops(text, keepSubHeadings = false) {
  let cut = text.length;

  if (keepSubHeadings) {
    for (const h of AUTHOR_HEADINGS) {
      const i = text.indexOf(h);

      if (i !== -1) {
        cut = Math.min(cut, i);
      }
    }
  } else {
    const h = text.search(/\n■/);

    if (h !== -1) {
      cut = Math.min(cut, h);
    }
  }

  for (const m of STOP_MARKERS) {
    const i = text.indexOf(m);

    if (i !== -1) {
      cut = Math.min(cut, i);
    }
  }

  return text
    .slice(0, cut)
    .trim();
}


function sectionAfter(text, marker, keepSubHeadings = false) {
  const i = text.indexOf(marker);

  if (i === -1) {
    return '';
  }

  return cutAtStops(
    text.slice(i + marker.length),
    keepSubHeadings
  );
}


// ============================================================
// 出版実績ページ解析
// ============================================================

// 書名と副題を、ページの構造から取り出す。
//
// 出版実績ページは次の形になっている。
//
//   <div class="title01 …">
//     <h1 itemprop="name" class="main">書名</h1>
//     <p class="sub">副題</p>          ← 無い作品も多い
//   </div>
//   <div class="product_detail_info …">
//     <p>タイトル直下キャッチ</p>       ← 別のブロック
//
// キャッチは title01 の外にあるので、ここで拾うことはない。
//
// なお extractMainH1() が拾う <h1> はページ見出しの
// 「出版実績」であって書名ではない。書名はこちらを使うこと。
function extractTitleBlock(html) {
  const box = html.match(
    /<div[^>]*class="[^"]*\btitle01\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );

  if (!box) {
    return { title: '', subtitle: '' };
  }

  const inner = box[1];

  const t = inner.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const s = inner.match(
    /<p[^>]*class="[^"]*\bsub\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i
  );

  // 末尾に全角スペースが付いている書名があるため、
  // 通常の trim() だけでなく全角スペースも落とす
  const clean = (v) =>
    htmlToText(v)
      .replace(/\s+/g, ' ')
      .replace(/^[\s　]+|[\s　]+$/g, '');

  return {
    title: t ? clean(t[1]) : '',
    subtitle: s ? clean(s[1]) : '',
  };
}


function extractMainH1(html) {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);

  if (!m) {
    return {
      title: '',
      afterHtml: '',
    };
  }

  const fullMatch = m[0];
  const matchIndex = m.index ?? html.indexOf(fullMatch);

  return {
    title: htmlToText(m[1]).replace(/\s+/g, ' ').trim(),
    afterHtml: html.slice(matchIndex + fullMatch.length),
  };
}


// ============================================================
// 出版実績ページ解析
// ============================================================

function parsePublicationPage(html) {
  const text = htmlToText(html);

  // ------------------------------------------------------------
  // ■著者紹介
  // ------------------------------------------------------------

  let authorBlock = '';

  for (const heading of AUTHOR_HEADINGS) {
    authorBlock = sectionAfter(text, heading);

    if (authorBlock) {
      break;
    }
  }


  // ------------------------------------------------------------
  // ■内容紹介
  // 見出し表記ゆれに対応
  //
  // 内容紹介の中に「■5台のカメラ開発秘話」のような小見出しが
  // 入るページがあるため、■では打ち切らず著者セクションまで拾う。
  // ------------------------------------------------------------

  let intro =
    sectionAfter(
      text,
      '■内容紹介',
      true
    );

  if (!intro) {
    intro =
      sectionAfter(
        text,
        '内容紹介',
        true
      );
  }


  // ------------------------------------------------------------
  // ISBN
  // ------------------------------------------------------------

  const isbn =
    (
      text.match(
        /ISBN[：:\s]*([0-9\-Xx]{10,20})/
      ) || []
    )[1] || '';


  // ------------------------------------------------------------
  // 判型
  // ------------------------------------------------------------

  // 出版実績ページは「ラベル行の次の行が値」という構造のため、
  // [：:\s]* は改行をまたぐ必要がある（出版年月日はこれに依存している）。
  //
  // ただし判型が空欄のページ（電子書籍のみの作品など）では、
  // 次のラベル行「出版年月日」自体を値として拾ってしまうため、
  // 取得値が既知のラベルだった場合は空にする。
  let format =
    (
      text.match(
        /判型[：:\s]*([^\n]+)/
      ) || []
    )[1]?.trim() || '';

  if (FIELD_LABELS_RE.test(format)) {
    format = '';
  }


  // ------------------------------------------------------------
  // 出版年月日
  // ------------------------------------------------------------

  const pubDate =
    (
      text.match(
        /出版年月日[：:\s]*([0-9]{4}[\/年][0-9]{1,2}[\/月][0-9]{1,2}日?)/
      ) || []
    )[1] ||
    (
      text.match(
        /発売日[：:\s]*([0-9]{4}[\/年][0-9]{1,2}[\/月][0-9]{1,2}日?)/
      ) || []
    )[1] ||
    '';


  const titleBlock = extractTitleBlock(html);

  // ------------------------------------------------------------
  // タイトル直下キャッチ
  //
  // ページ上は title01（書名・副題）の次に置かれた
  // product_detail_info がキャッチのブロックになっている。
  //
  //   <div class="title01 …">
  //     <h1 class="main">書名</h1>
  //     <p class="sub">副題</p>
  //   </div>
  //   <div class="product_detail_info …">
  //     <p>キャッチ</p>          ← ここだけを読む
  //   </div>
  //
  // 以前は「h1 の後ろから『ジャンル』までの行を上から捨てていき、
  // 句読点で終わる行が来たら止める」方式だった。そのため書名が
  // 「」『』？！。 で終わる作品では書名の行で止まってしまい、
  // 書名と副題がキャッチに混入していた（gr1600〜1981 で17件）。
  // ブロックを指定して読めば、その取り違えは起きない。
  // ------------------------------------------------------------

  let catchCopy = '';

  const infoBlock = html.match(
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

  // product_detail_info が空タグのページがある。
  // その場合は副題がキャッチを兼ねているので副題を使う。
  if (!catchCopy) {
    catchCopy = titleBlock.subtitle || '';
  }

  return {
    authorBlock,
    intro,
    isbn,
    format,
    pubDate,
    catchCopy,
    title: titleBlock.title,
    subtitle: titleBlock.subtitle,
    rawText:
      text.slice(0, 4000),
  };
}
