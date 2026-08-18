// ============================================================
// 再掲連載作成アシスタント Ver.0.3 ── データ取得API
//
// これから作る再掲連載の記事は、まだ記事データアプリに存在しない。
// そのため「今回の連載」は記事データアプリ(341)からではなく、
// GLO連載情報アプリ（KINTONE_APP_ID）からカテゴリIDで引く。
//
//   1. GLO連載情報   … 書籍タイトル / カテゴリID / 第1回配信日時 / 制作No / $id
//   2. 記事データ341 … 同じ書籍タイトルの過去連載＝参照元候補
//   3. スプレッドシート … 「毎月の記事下リンク」B列・C列
//
// 3つは互いに独立させる。1つ失敗しても残りは使えるようにし、
// 途中で早期returnしない（新連載作成アシスタントと同じ方針）。
//
// APIトークン・GASのURLはこのファイルの中だけで使い、
// レスポンスにもフロントにも出さない。
// ============================================================

// 記事データアプリ（過去連載の記事一覧）
const ARTICLE_APP_ID = '341';

const ARTICLE_FIELDS = [
  '$id',
  'カテゴリコード',
  '書籍タイトル',
  '連載回数',
  '回数・数値',
  '記事ID',
  '記事URL',
  '記事URL・文字列',
  '記事タイトル',
  '公開日時',
  '連載分類',
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const base = envValue('KINTONE_BASE_URL');
  const seriesToken = envValue('KINTONE_API_TOKEN');
  const seriesAppId = envValue('KINTONE_APP_ID');
  const articleToken = envValue('KINTONE_ARTICLE_API_TOKEN');

  const categoryCode = String(req.query.code || '').trim();

  // ?summary=1 は診断用。rows を返さず件数と末尾の期間だけ見る
  const summaryOnly = String(req.query.summary || '') === '1';

  if (!categoryCode) {
    return res.status(400).json({
      status: 'error',
      error: 'カテゴリコードを指定してください',
    });
  }

  const result = {
    status: 'ok',

    categoryCode,

    // GLO連載情報アプリ（今回作る再掲連載）
    series: {
      status: 'error',
      message: '',
      data: null,
    },

    // 記事データアプリ341（参照元＝過去連載の候補）
    source: {
      status: 'error',
      message: '',
      candidates: [],
    },

    // Googleスプレッドシート「毎月の記事下リンク」
    sheet: {
      status: 'error',
      message: '',
      rows: null,
      rowCount: 0,
    },

    warnings: [],
  };

  // スプレッドシートはkintoneと並行に取得する。
  // この関数は決して throw しない。
  const sheetPromise = fetchSheetData();

  // ============================================================
  // 1. GLO連載情報アプリ（今回の再掲連載）
  // ============================================================

  let seriesData = null;

  try {
    if (!base || !seriesToken || !seriesAppId) {
      throw new Error(
        'kintoneの環境変数（KINTONE_BASE_URL / KINTONE_API_TOKEN / KINTONE_APP_ID）が未設定です'
      );
    }

    const query = `カテゴリID = "${escapeQueryValue(categoryCode)}"`;

    const records = await fetchRecords({
      base,
      token: seriesToken,
      appId: seriesAppId,
      query,
    });

    if (!records.length) {
      throw new Error(
        `カテゴリID「${categoryCode}」のレコードが見つかりません`
      );
    }

    const record = records[0];

    const bookTitle = record['書籍タイトル']?.value || '';

    seriesData = {
      recordId: record['$id']?.value || '',

      categoryCode: record['カテゴリID']?.value || categoryCode,

      bookTitle,

      // ［注目連載ピックアップ］等を外したもの。過去連載の検索キー
      normalizedTitle: normalizeSeriesTitle(bookTitle),

      // 再掲の第1回。第2回以降はここから1日ずつ足して算出する
      firstDeliveryAt: record['第1回配信日時']?.value || '',

      productionNo: record['制作No']?.value || '',
    };

    // kintone該当レコードへの確認用リンク
    seriesData.kintoneUrl = seriesData.recordId
      ? `${base}/k/${seriesAppId}/show#record=${seriesData.recordId}`
      : '';

    result.series = {
      status: 'ok',
      message: '',
      data: seriesData,
    };

    if (!seriesData.bookTitle) {
      result.warnings.push('書籍タイトルが未登録です');
    }

    if (!seriesData.firstDeliveryAt) {
      result.warnings.push(
        '第1回配信日時が未登録です。公開予定日を算出できません'
      );
    }
  } catch (e) {
    result.series.message = String(e.message || e);
  }

  // ============================================================
  // 2. 記事データアプリ341（参照元候補）
  //
  // 書籍タイトルの部分一致で拾い、正規化後に完全一致するものだけ残す。
  // 「プレナイト2」のような別連載を巻き込まないため。
  // ============================================================

  try {
    if (!base || !articleToken) {
      throw new Error(
        '記事データアプリの環境変数（KINTONE_BASE_URL / KINTONE_ARTICLE_API_TOKEN）が未設定です'
      );
    }

    const normalizedTitle = seriesData?.normalizedTitle || '';

    if (!normalizedTitle) {
      throw new Error(
        '書籍タイトルが取得できないため過去連載を検索できません'
      );
    }

    const query =
      `書籍タイトル like "${escapeQueryValue(normalizedTitle)}" ` +
      `order by 公開日時 asc`;

    const records = await fetchAllRecords({
      base,
      token: articleToken,
      appId: ARTICLE_APP_ID,
      fields: ARTICLE_FIELDS,
      query,
    });

    const articles = records
      .map(mapArticle)

      // 今回入力したカテゴリコード自身は候補にしない
      .filter((article) => article.categoryCode !== categoryCode)

      // 「プレナイト」「プレナイト［人気連載ピックアップ］」だけを残す
      .filter(
        (article) =>
          normalizeSeriesTitle(article.bookTitle) === normalizedTitle
      );

    const candidates = groupSeriesCandidates(articles);

    result.source = {
      status: 'ok',
      message: '',
      candidates,
    };

    if (!candidates.length) {
      result.warnings.push(
        `「${normalizedTitle}」の過去連載が見つかりません`
      );
    }
  } catch (e) {
    result.source.message = String(e.message || e);
  }

  // ============================================================
  // 3. スプレッドシート
  // ============================================================

  const sheet = await sheetPromise;

  result.sheet = {
    status: sheet.status,
    message: sheet.message,
    rows: sheet.rows,
    rowCount: Array.isArray(sheet.rows) ? sheet.rows.length : 0,
  };

  if (sheet.status !== 'ok') {
    result.warnings.push(
      `記事下データ（スプレッドシート）を取得できませんでした：${sheet.message}`
    );
  }

  // ============================================================
  // 4. 診断用の簡易レスポンス
  // ============================================================

  if (summaryOnly) {
    return res.status(200).json({
      status: result.status,

      categoryCode,

      series: {
        status: result.series.status,
        message: result.series.message,
        data: result.series.data,
      },

      source: {
        status: result.source.status,
        message: result.source.message,
        candidates: result.source.candidates.map((candidate) => ({
          categoryCode: candidate.categoryCode,
          bookTitle: candidate.bookTitle,
          serialType: candidate.serialType,
          count: candidate.count,
          firstPublishedAt: candidate.firstPublishedAt,
          lastPublishedAt: candidate.lastPublishedAt,
          firstArticleTitle: candidate.firstArticleTitle,
        })),
      },

      // 記事下が取れない原因を切り分けるための最小限の情報
      sheet: {
        status: result.sheet.status,
        message: result.sheet.message,
        rowCount: result.sheet.rowCount,
        via: sheet.via,
        samplePeriods: Array.isArray(result.sheet.rows)
          ? result.sheet.rows
              .slice(-5)
              .map((row) => String((row && row[0]) || '').trim())
          : [],
      },

      warnings: result.warnings,
    });
  }

  return res.status(200).json(result);
}

// ============================================================
// Googleスプレッドシート「毎月の記事下リンク」取得
//
// 会社のWorkspaceポリシーで外部共有が禁止されているためSheets APIは403になる。
// 新連載作成アシスタント（api/fetch-info.js）と同じくGASウェブアプリ経由で取得する。
// GASのデプロイは「アクセスできるユーザー＝全員」でないとログインHTMLが返る。
//
// この関数は決して throw しない。記事下だけ取れなくても
// kintone取得・参照元選択はそのまま使えるようにしておく。
// ============================================================

async function fetchSheetData() {
  const gasUrl = envValue('SHEET_GAS_URL');

  try {
    if (gasUrl) {
      const r = await fetch(gasUrl, { redirect: 'follow' });

      if (!r.ok) {
        throw new Error(`GAS取得エラー (${r.status})`);
      }

      const text = await r.text();

      let json;

      try {
        json = JSON.parse(text);
      } catch (e) {
        // 組織内限定デプロイだとJSONではなくログインHTMLが返る。
        // 「Unexpected token」だけでは原因が分からないので明示する。
        throw new Error(
          text.trim().startsWith('<')
            ? 'GASがJSONではなくHTMLを返しました（デプロイのアクセス権を「全員」にしてください）'
            : `GASの応答を解釈できません：${String(e.message || e)}`
        );
      }

      if (!Array.isArray(json.values)) {
        throw new Error(
          'GASの応答形式が不正です（valuesが配列ではありません）'
        );
      }

      return {
        status: 'ok',
        message: '',
        rows: json.values,
        via: 'gas',
      };
    }

    // GASを使わない場合のみ Sheets API（APIキー）へフォールバック
    const sheetId = envValue('SHEET_ID');
    const apiKey = envValue('GOOGLE_API_KEY');

    if (!sheetId || !apiKey) {
      throw new Error(
        'SHEET_GAS_URL（またはSHEET_ID/GOOGLE_API_KEY）が未設定です'
      );
    }

    const sheetName = envValue('SHEET_NAME');

    const range = sheetName
      ? `${encodeURIComponent(sheetName)}!B:C`
      : 'B:C';

    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}` +
      `/values/${range}?key=${apiKey}`;

    const r = await fetch(url);

    if (!r.ok) {
      throw new Error(`Sheets API エラー (${r.status})`);
    }

    const json = await r.json();

    return {
      status: 'ok',
      message: '',
      rows: json.values || [],
      via: 'sheets-api',
    };
  } catch (e) {
    return {
      status: 'error',
      message: String(e.message || e),
      rows: null,
      via: gasUrl ? 'gas' : 'sheets-api',
    };
  }
}

// ============================================================
// kintone取得
// ============================================================

// 1ページだけ取得する（GLO連載情報はカテゴリIDで1件）
async function fetchRecords({ base, token, appId, query, fields }) {
  const params = new URLSearchParams();

  params.set('app', appId);

  if (query) {
    params.set('query', query);
  }

  if (Array.isArray(fields)) {
    fields.forEach((field, index) => {
      params.set(`fields[${index}]`, field);
    });
  }

  const url = `${base}/k/v1/records.json?${params.toString()}`;

  const response = await fetch(url, {
    headers: { 'X-Cybozu-API-Token': token },
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `kintone APIエラー (${response.status}): ${
        (json && (json.message || JSON.stringify(json))) || ''
      }`
    );
  }

  return (json && json.records) || [];
}

// 500件を超えても取得できるようページングする（記事データアプリ用）
async function fetchAllRecords({ base, token, appId, query, fields }) {
  const limit = 500;

  let offset = 0;
  const allRecords = [];

  while (true) {
    const records = await fetchRecords({
      base,
      token,
      appId,
      fields,
      query: `${query} limit ${limit} offset ${offset}`,
    });

    allRecords.push(...records);

    if (records.length < limit) {
      break;
    }

    offset += limit;
  }

  return allRecords;
}

// ============================================================
// 記事データアプリのレコード → アプリ内形式
// ============================================================

function mapArticle(record) {
  return {
    recordId: record['$id']?.value || '',
    categoryCode: record['カテゴリコード']?.value || '',
    bookTitle: record['書籍タイトル']?.value || '',
    episodeLabel: record['連載回数']?.value || '',
    episodeNumber: record['回数・数値']?.value || '',
    articleId: record['記事ID']?.value || '',
    articleUrl:
      record['記事URL']?.value || record['記事URL・文字列']?.value || '',
    articleTitle: record['記事タイトル']?.value || '',
    publishedAt: record['公開日時']?.value || '',
    serialType: record['連載分類']?.value || '',
  };
}

// ============================================================
// タイトル正規化
//
//   プレナイト［注目連載ピックアップ］
//   プレナイト［人気連載ピックアップ］
//     ↓
//   プレナイト
// ============================================================

function normalizeSeriesTitle(title) {
  return String(title || '')
    .replace(/［(?:注目|人気)連載ピックアップ］/g, '')
    .replace(/\[(?:注目|人気)連載ピックアップ\]/g, '')
    .trim();
}

// ============================================================
// 回数順の並び替え
//
// 公開日時ではなく 回数・数値 →「第N回」→ 最終回 の順で並べる。
// 過去連載は公開日時が飛んでいることがあるため、日付では並べない。
// ============================================================

function sortArticlesByEpisode(articles) {
  return [...articles].sort(
    (a, b) => episodeSortValue(a) - episodeSortValue(b)
  );
}

function episodeSortValue(article) {
  if (isFinalEpisode(article)) {
    return Number.MAX_SAFE_INTEGER;
  }

  const number = Number(article.episodeNumber);

  if (Number.isFinite(number) && number > 0) {
    return number;
  }

  const match = String(article.episodeLabel || '').match(/第(\d+)回/);

  if (match) {
    return Number(match[1]);
  }

  return Number.MAX_SAFE_INTEGER - 1;
}

function isFinalEpisode(article) {
  return /最終回/.test(String(article.episodeLabel || ''));
}

// ============================================================
// 参照元候補をカテゴリコード単位でまとめる
//
//   gr1528｜プレナイト［人気連載ピックアップ］｜20回
//   gr793 ｜プレナイト                        ｜20回
// ============================================================

function groupSeriesCandidates(articles) {
  const groups = new Map();

  for (const article of articles) {
    const key = article.categoryCode;

    if (!key) continue;

    if (!groups.has(key)) {
      groups.set(key, {
        categoryCode: article.categoryCode,
        bookTitle: article.bookTitle,
        serialType: article.serialType,
        articles: [],
      });
    }

    groups.get(key).articles.push(article);
  }

  const result = [...groups.values()].map((group) => {
    const sorted = sortArticlesByEpisode(group.articles);

    const dateSorted = [...sorted].sort(
      (a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0)
    );

    return {
      categoryCode: group.categoryCode,
      bookTitle: group.bookTitle,
      serialType: group.serialType,
      count: sorted.length,
      firstPublishedAt: dateSorted[0]?.publishedAt || '',
      lastPublishedAt:
        dateSorted[dateSorted.length - 1]?.publishedAt || '',
      firstArticleTitle: sorted[0]?.articleTitle || '',
      articles: sorted,
    };
  });

  // 参照元は新しい連載を上に出す
  result.sort(
    (a, b) =>
      new Date(b.firstPublishedAt || 0) -
      new Date(a.firstPublishedAt || 0)
  );

  return result;
}

// ============================================================
// 小物
// ============================================================

function envValue(name) {
  return String(process.env[name] || '').trim();
}

function escapeQueryValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
