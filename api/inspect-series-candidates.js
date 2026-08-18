export default async function handler(req, res) {
  const base = String(
    process.env.KINTONE_BASE_URL || ''
  ).trim();

  const token = String(
    process.env.KINTONE_ARTICLE_API_TOKEN || ''
  ).trim();

  const appId = '341';

  const title = String(
    req.query.title || ''
  ).trim();

  if (!base || !token) {
    return res.status(500).json({
      error: 'kintone環境変数が未設定です',
    });
  }

  if (!title) {
    return res.status(400).json({
      error: 'titleを指定してください',
    });
  }

  try {
    const escapedTitle = title
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');

    const query =
      `書籍タイトル like "${escapedTitle}" order by 公開日時 asc`;

    const fields = [
      '$id',
      'カテゴリコード',
      '書籍タイトル',
      '連載回数',
      '回数・数値',
      '記事ID',
      '記事URL',
      '記事タイトル',
      '公開日時',
      '連載分類',
    ];

    const params = new URLSearchParams();

    params.set('app', appId);
    params.set('query', query);
    params.set('totalCount', 'true');

    fields.forEach((field, index) => {
      params.set(`fields[${index}]`, field);
    });

    const url =
      `${base}/k/v1/records.json?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        'X-Cybozu-API-Token': token,
      },
    });

    const json = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: '候補記事の取得に失敗しました',
        detail: json,
      });
    }

    const records = (json.records || []).map((r) => ({
      recordId: r['$id']?.value || '',
      categoryCode: r['カテゴリコード']?.value || '',
      bookTitle: r['書籍タイトル']?.value || '',
      episodeLabel: r['連載回数']?.value || '',
      episodeNumber: r['回数・数値']?.value || '',
      articleId: r['記事ID']?.value || '',
      articleUrl: r['記事URL']?.value || '',
      articleTitle: r['記事タイトル']?.value || '',
      publishedAt: r['公開日時']?.value || '',
      serialType: r['連載分類']?.value || '',
    }));

    const groupsMap = new Map();

    for (const record of records) {
      const key =
        `${record.categoryCode}__${record.bookTitle}__${record.serialType}`;

      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          categoryCode: record.categoryCode,
          bookTitle: record.bookTitle,
          serialType: record.serialType,
          articles: [],
        });
      }

      groupsMap.get(key).articles.push(record);
    }

    const groups = [...groupsMap.values()].map((group) => {
      const sorted = [...group.articles].sort((a, b) => {
        return (
          new Date(a.publishedAt || 0) -
          new Date(b.publishedAt || 0)
        );
      });

      return {
        categoryCode: group.categoryCode,
        bookTitle: group.bookTitle,
        serialType: group.serialType,
        count: sorted.length,
        firstPublishedAt:
          sorted[0]?.publishedAt || '',
        lastPublishedAt:
          sorted[sorted.length - 1]?.publishedAt || '',
        firstArticleTitle:
          sorted[0]?.articleTitle || '',
        articles: sorted,
      };
    });

    return res.status(200).json({
      status: 'ok',
      searchTitle: title,
      totalCount: json.totalCount || records.length,
      groupCount: groups.length,
      groups,
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e.message || e),
    });
  }
}