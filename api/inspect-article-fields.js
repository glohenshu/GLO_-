export default async function handler(req, res) {
  const base = String(
    process.env.KINTONE_BASE_URL || ''
  ).trim();

  const articleToken = String(
    process.env.KINTONE_ARTICLE_API_TOKEN || ''
  ).trim();

  // 診断で判明した記事データアプリ
  const articleAppId = '341';

  if (!base || !articleToken) {
    return res.status(500).json({
      error: '記事データアプリ用のkintone環境変数が未設定です',
    });
  }

  try {
    const url =
      `${base}/k/v1/app/form/fields.json?app=${encodeURIComponent(articleAppId)}`;

    const response = await fetch(url, {
      headers: {
        'X-Cybozu-API-Token': articleToken,
      },
    });

    const json = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: '記事データアプリのフィールド取得に失敗しました',
        detail: json,
      });
    }

    const properties = json.properties || {};

    const fields = Object.values(properties)
      .map((field) => ({
        code: field.code || '',
        label: field.label || '',
        type: field.type || '',
      }))
      .sort((a, b) =>
        String(a.label).localeCompare(String(b.label), 'ja')
      );

    // 今回の再掲アプリで使いそうな項目だけ別途抽出
    const keywords = [
      'カテゴリ',
      '記事',
      'タイトル',
      'URL',
      '連載',
      '回',
      '再掲',
      '紐づけ',
      '公開',
      '日時',
      'ID',
    ];

    const candidates = fields.filter((field) => {
      const text =
        `${field.label} ${field.code}`.toLowerCase();

      return keywords.some((word) =>
        text.includes(word.toLowerCase())
      );
    });

    return res.status(200).json({
      status: 'ok',
      articleAppId,
      fieldCount: fields.length,
      candidates,
      fields,
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e.message || e),
    });
  }
}