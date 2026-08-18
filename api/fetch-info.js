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
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/(p|div|h[1-6]|li|tr|section|article|dd|dt)>/gi,
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
    .replace(/\n{3,}/g, '\n\n')
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


  // ------------------------------------------------------------
  // タイトル直下キャッチ
  //
  // 出版実績ページは、kintoneの書籍タイトルではなく、
  // kintoneに登録されている「出版実績URL」から取得した
  // そのページ自身の <h1> を起点に解析する。
  //
  // h1終了直後 ～ 「ジャンル」直前のテキストを候補とし、
  // 「書籍を購入...」等を除外する。
  //
  // 文末記号で終わらない先頭行が複数ある場合は、
  // サブタイトル等とみなして除外する。
  // ------------------------------------------------------------

  let catchCopy = '';

  const h1 = extractMainH1(html);

  // <h1> が空のページは出版実績ページとして扱わない。
  // 削除済み商品のURLは HTTP 200 のまま <h1> が空の
  // 404ページが返る（ソフト404）ことがあり、ここで打ち切らないと
  // サイト共通の宣伝文をキャッチコピーとして取得してしまう。
  if (h1.title && h1.afterHtml) {
    const afterH1Text = htmlToText(h1.afterHtml);

    const genreIdx =
      afterH1Text.search(
        /(^|\n)ジャンル\s*(\n|$)/
      );

    if (genreIdx !== -1) {
      let lines =
        afterH1Text
          .slice(0, genreIdx)
          .split('\n')
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              !/^書籍を購/.test(l)
          );

      while (
        lines.length > 1 &&
        !/[。．！？!?…」』]$/.test(
          lines[0]
        )
      ) {
        lines.shift();
      }

      catchCopy =
        lines
          .join('\n')
          .slice(0, 400)
          .trim();
    }


    // ----------------------------------------------------------
    // フォールバック：
    // 「ジャンル」が見つからない場合も、h1直後から
    // 本文外マーカーまでの範囲でキャッチ候補を探す。
    // ----------------------------------------------------------

    if (!catchCopy) {
      let chunk =
        cutAtStops(afterH1Text);

      const stop =
        chunk.search(
          /■|ジャンル|著者名?[：:]/
        );

      if (stop !== -1) {
        chunk =
          chunk.slice(
            0,
            stop
          );
      }

      let lines =
        chunk
          .split('\n')
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              !/^書籍を購/.test(l)
          );

      while (
        lines.length > 1 &&
        !/[。．！？!?…」』]$/.test(
          lines[0]
        )
      ) {
        lines.shift();
      }

      catchCopy =
        lines
          .join('\n')
          .slice(0, 400)
          .trim();
    }
  }


  // ------------------------------------------------------------
  // 最終フォールバック：
  // og:description
  //
  // ただし <h1> の無いページ（削除済み商品のソフト404）では
  // og:description がサイト共通の宣伝文になっているため、
  // 出版実績ページと確認できた場合だけ使う。
  // ------------------------------------------------------------

  if (!catchCopy && h1.title) {
    const og =
      html.match(
        /property=["']og:description["'][^>]*content=["']([^"']+)["']/
      ) ||
      html.match(
        /content=["']([^"']+)["'][^>]*property=["']og:description["']/
      );

    if (og) {
      catchCopy =
        og[1].trim();
    }
  }


  return {
    authorBlock,
    intro,
    isbn,
    format,
    pubDate,
    catchCopy,
    rawText:
      text.slice(0, 4000),
  };
}
