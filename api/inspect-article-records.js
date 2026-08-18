export default async function handler(req, res) {
  const base = String(
    process.env.KINTONE_BASE_URL || ''
  ).trim();

  const token = String(
    process.env.KINTONE_ARTICLE_API_TOKEN || ''
  ).trim();

  const appId = '341';

  const code = String(
    req.query.code || ''
  ).trim();

  if (!base || !token) {
    return res.status(500).json({
      error: 'kintone環境変数が未設定です',
    });
  }

  if (!code) {
    return res.status(400).json({
      error: 'カテゴリコードを指定してください',
    });
  }

  try {
    const fields = [
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

    const query =
      `カテゴリコード = "${code}" order by 公開日時 asc`;

    const params = new URLSearchParams();

    params.set('app', appId);
    params.set('query', query);

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
        error: '記事データ取得に失敗しました',
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
      articleUrlText: r['記事URL・文字列']?.value || '',
      articleTitle: r['記事タイトル']?.value || '',
      publishedAt: r['公開日時']?.value || '',
      serialType: r['連載分類']?.value || '',
    }));

    const serialTypes = [
      ...new Set(
        records
          .map((r) => r.serialType)
          .filter(Boolean)
      ),
    ];

    return res.status(200).json({
      status: 'ok',
      categoryCode: code,
      count: records.length,
      serialTypes,
      records,
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e.message || e),
    });
  }
}