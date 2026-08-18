// 再掲連載作成アシスタント
// kintone 記事データアプリから
// ・今回の再掲連載
// ・「この話の続きを読む」参照元候補
// をまとめて取得するAPI

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

  const base = String(
    process.env.KINTONE_BASE_URL || ''
  ).trim();

  const token = String(
    process.env.KINTONE_ARTICLE_API_TOKEN || ''
  ).trim();

  const categoryCode = String(
    req.query.code || ''
  ).trim();

  const summaryOnly =
    String(req.query.summary || '') === '1';

  if (!base || !token) {
    return res.status(500).json({
      status: 'error',
      error: 'kintone環境変数が未設定です',
    });
  }

  if (!categoryCode) {
    return res.status(400).json({
      status: 'error',
      error: 'カテゴリコードを指定してください',
    });
  }

  try {
    // ============================================================
    // 1. 今回の再掲連載を取得
    // ============================================================

    const currentQuery =
      `カテゴリコード = "${escapeQueryValue(categoryCode)}" ` +
      `order by 公開日時 asc`;

    const currentRaw = await fetchAllRecords({
      base,
      token,
      query: currentQuery,
    });

    if (currentRaw.length === 0) {
      return res.status(404).json({
        status: 'not_found',
        categoryCode,
        error: `カテゴリコード「${categoryCode}」の記事が見つかりません`,
      });
    }

    let currentArticles =
      currentRaw.map(mapArticle);

    currentArticles =
      sortArticlesByEpisode(currentArticles);

    const currentBookTitle =
      currentArticles[0]?.bookTitle || '';

    const normalizedTitle =
      normalizeSeriesTitle(currentBookTitle);

    // ============================================================
    // 2. 「この話の続きを読む」の参照元候補を検索
    // ============================================================

    let candidateRaw = [];

    if (normalizedTitle) {
      const candidateQuery =
        `書籍タイトル like "${escapeQueryValue(normalizedTitle)}" ` +
        `order by 公開日時 asc`;

      candidateRaw = await fetchAllRecords({
        base,
        token,
        query: candidateQuery,
      });
    }

    let candidateArticles =
      candidateRaw
        .map(mapArticle)

        // 今回処理中のカテゴリは候補から除外
        .filter(
          (article) =>
            article.categoryCode !== categoryCode
        )

        // 「プレナイト」と
        // 「プレナイト［人気連載ピックアップ］」等だけを残す
        // 「プレナイト2」などの誤ヒットを防ぐ
        .filter(
          (article) =>
            normalizeSeriesTitle(article.bookTitle) ===
            normalizedTitle
        );

    // ============================================================
    // 3. 候補をカテゴリ単位でグループ化
    // ============================================================

    const sourceCandidates =
      groupSeriesCandidates(candidateArticles);

    // ============================================================
    // 4. 今回の再掲側に「前回記事」を設定
    // ============================================================

    currentArticles =
      currentArticles.map((article, index) => {
        const previous =
          index > 0
            ? currentArticles[index - 1]
            : null;

        return {
          ...article,

          isFinal:
            isFinalEpisode(article),

          previousArticle:
            previous
              ? {
                  episodeLabel:
                    previous.episodeLabel,

                  articleId:
                    previous.articleId,

                  articleTitle:
                    previous.articleTitle,

                  articleUrl:
                    previous.articleUrl,
                }
              : null,

          previousHtml:
            previous?.articleId
              ? buildPreviousArticleHtml(
                  previous.articleId
                )
              : '',
        };
      });

    // ============================================================
    // 5. データチェック
    // ============================================================

    const warnings =
      validateCurrentSeries(currentArticles);

    const currentSeries = {
      categoryCode,

      bookTitle:
        currentBookTitle,

      normalizedTitle,

      serialType:
        currentArticles[0]?.serialType || '',

      count:
        currentArticles.length,

      firstPublishedAt:
        currentArticles[0]?.publishedAt || '',

      lastPublishedAt:
        currentArticles[
          currentArticles.length - 1
        ]?.publishedAt || '',

      articles:
        currentArticles,
    };

    // ============================================================
    // 6. 診断しやすい簡易レスポンス
    // ============================================================

    if (summaryOnly) {
      return res.status(200).json({
        status: 'ok',

        currentSeries: {
          categoryCode:
            currentSeries.categoryCode,

          bookTitle:
            currentSeries.bookTitle,

          normalizedTitle:
            currentSeries.normalizedTitle,

          serialType:
            currentSeries.serialType,

          count:
            currentSeries.count,

          firstPublishedAt:
            currentSeries.firstPublishedAt,

          lastPublishedAt:
            currentSeries.lastPublishedAt,
        },

        sourceCandidates:
          sourceCandidates.map(
            (candidate) => ({
              categoryCode:
                candidate.categoryCode,

              bookTitle:
                candidate.bookTitle,

              serialType:
                candidate.serialType,

              count:
                candidate.count,

              firstPublishedAt:
                candidate.firstPublishedAt,

              lastPublishedAt:
                candidate.lastPublishedAt,

              firstArticleTitle:
                candidate.firstArticleTitle,
            })
          ),

        warnings,
      });
    }

    // ============================================================
    // 7. 本番用レスポンス
    // ============================================================

    return res.status(200).json({
      status: 'ok',

      currentSeries,

      sourceCandidates,

      warnings,
    });

  } catch (e) {
    return res.status(500).json({
      status: 'error',
      error: String(
        e.message || e
      ),
    });
  }
}


// ============================================================
// kintone レコード一括取得
// 500件を超えても取得できるようページング
// ============================================================

async function fetchAllRecords({
  base,
  token,
  query,
}) {
  const limit = 500;

  let offset = 0;
  let allRecords = [];

  while (true) {
    const params =
      new URLSearchParams();

    params.set(
      'app',
      ARTICLE_APP_ID
    );

    params.set(
      'query',
      `${query} limit ${limit} offset ${offset}`
    );

    ARTICLE_FIELDS.forEach(
      (field, index) => {
        params.set(
          `fields[${index}]`,
          field
        );
      }
    );

    const url =
      `${base}/k/v1/records.json?${params.toString()}`;

    const response =
      await fetch(url, {
        headers: {
          'X-Cybozu-API-Token':
            token,
        },
      });

    const json =
      await response.json();

    if (!response.ok) {
      throw new Error(
        `kintone記事データ取得エラー (${response.status}): ` +
        JSON.stringify(json)
      );
    }

    const records =
      json.records || [];

    allRecords.push(
      ...records
    );

    if (records.length < limit) {
      break;
    }

    offset += limit;
  }

  return allRecords;
}


// ============================================================
// kintoneレコード → アプリ内形式
// ============================================================

function mapArticle(record) {
  return {
    recordId:
      record['$id']?.value || '',

    categoryCode:
      record['カテゴリコード']?.value || '',

    bookTitle:
      record['書籍タイトル']?.value || '',

    episodeLabel:
      record['連載回数']?.value || '',

    episodeNumber:
      record['回数・数値']?.value || '',

    articleId:
      record['記事ID']?.value || '',

    articleUrl:
      record['記事URL']?.value ||
      record['記事URL・文字列']?.value ||
      '',

    articleTitle:
      record['記事タイトル']?.value || '',

    publishedAt:
      record['公開日時']?.value || '',

    serialType:
      record['連載分類']?.value || '',
  };
}


// ============================================================
// タイトル正規化
//
// プレナイト［注目連載ピックアップ］
// プレナイト［人気連載ピックアップ］
//
// ↓
//
// プレナイト
// ============================================================

function normalizeSeriesTitle(title) {
  return String(title || '')
    .replace(
      /［(?:注目|人気)連載ピックアップ］/g,
      ''
    )
    .replace(
      /\[(?:注目|人気)連載ピックアップ\]/g,
      ''
    )
    .trim();
}


// ============================================================
// 回数順に並び替え
//
// 第1回
// 第2回
// ...
// 第19回
// 最終回
// ============================================================

function sortArticlesByEpisode(
  articles
) {
  return [...articles].sort(
    (a, b) =>
      episodeSortValue(a) -
      episodeSortValue(b)
  );
}


function episodeSortValue(article) {
  if (
    isFinalEpisode(article)
  ) {
    return Number.MAX_SAFE_INTEGER;
  }

  const number =
    Number(article.episodeNumber);

  if (
    Number.isFinite(number) &&
    number > 0
  ) {
    return number;
  }

  const match =
    String(
      article.episodeLabel || ''
    ).match(/第(\d+)回/);

  if (match) {
    return Number(match[1]);
  }

  return (
    Number.MAX_SAFE_INTEGER - 1
  );
}


function isFinalEpisode(article) {
  return /最終回/.test(
    String(
      article.episodeLabel || ''
    )
  );
}


// ============================================================
// 元連載候補をカテゴリコード単位でまとめる
// ============================================================

function groupSeriesCandidates(
  articles
) {
  const groups =
    new Map();

  for (const article of articles) {
    const key =
      article.categoryCode;

    if (!key) {
      continue;
    }

    if (!groups.has(key)) {
      groups.set(key, {
        categoryCode:
          article.categoryCode,

        bookTitle:
          article.bookTitle,

        serialType:
          article.serialType,

        articles: [],
      });
    }

    groups
      .get(key)
      .articles
      .push(article);
  }

  const result =
    [...groups.values()]
      .map((group) => {
        const sorted =
          sortArticlesByEpisode(
            group.articles
          );

        const dateSorted =
          [...sorted].sort(
            (a, b) =>
              new Date(
                a.publishedAt || 0
              ) -
              new Date(
                b.publishedAt || 0
              )
          );

        return {
          categoryCode:
            group.categoryCode,

          bookTitle:
            group.bookTitle,

          serialType:
            group.serialType,

          count:
            sorted.length,

          firstPublishedAt:
            dateSorted[0]
              ?.publishedAt || '',

          lastPublishedAt:
            dateSorted[
              dateSorted.length - 1
            ]?.publishedAt || '',

          firstArticleTitle:
            sorted[0]
              ?.articleTitle || '',

          articles:
            sorted,
        };
      });

  // 参照候補は新しいものを上へ
  result.sort(
    (a, b) =>
      new Date(
        b.firstPublishedAt || 0
      ) -
      new Date(
        a.firstPublishedAt || 0
      )
  );

  return result;
}


// ============================================================
// 「前回の記事を読む」HTML
// ============================================================

function buildPreviousArticleHtml(
  articleId
) {
  return (
    `<p align="center">` +
    `<a href="/articles/-/${articleId}" target="_blank">` +
    `<strong>` +
    `<span style="color:#0000CD;">` +
    `【前回の記事を読む】●▼■` +
    `</span>` +
    `</strong>` +
    `</a>` +
    `</p>`
  );
}


// ============================================================
// データ警告
// ============================================================

function validateCurrentSeries(
  articles
) {
  const warnings = [];

  if (!articles.length) {
    warnings.push(
      '記事がありません'
    );

    return warnings;
  }

  const first =
    articles[0];

  if (
    Number(first.episodeNumber) !== 1
  ) {
    warnings.push(
      '第1回が確認できません'
    );
  }

  const numbers =
    articles
      .filter(
        (article) =>
          !isFinalEpisode(article)
      )
      .map(
        (article) =>
          Number(
            article.episodeNumber
          )
      )
      .filter(
        (number) =>
          Number.isFinite(number) &&
          number > 0
      );

  const duplicateNumbers =
    numbers.filter(
      (number, index) =>
        numbers.indexOf(number) !==
        index
    );

  if (
    duplicateNumbers.length
  ) {
    warnings.push(
      `回数が重複しています：${[
        ...new Set(
          duplicateNumbers
        ),
      ].join(', ')}`
    );
  }

  const finalCount =
    articles.filter(
      isFinalEpisode
    ).length;

  if (finalCount === 0) {
    warnings.push(
      '最終回が確認できません'
    );
  }

  if (finalCount > 1) {
    warnings.push(
      '最終回が複数あります'
    );
  }

  const missingArticleIds =
    articles.filter(
      (article) =>
        !article.articleId
    );

  if (
    missingArticleIds.length
  ) {
    warnings.push(
      `記事ID未設定：${missingArticleIds
        .map(
          (article) =>
            article.episodeLabel
        )
        .join(', ')}`
    );
  }

  return warnings;
}


// ============================================================
// kintoneクエリ文字列用
// ============================================================

function escapeQueryValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}