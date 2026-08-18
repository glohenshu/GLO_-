export default async function handler(req, res) {
  const base = String(
    process.env.KINTONE_BASE_URL || ''
  ).trim();

  const token = String(
    process.env.KINTONE_ARTICLE_API_TOKEN || ''
  ).trim();

  const appId = '341';

  if (!base || !token) {
    return res.status(500).json({
      error: 'kintone環境変数が未設定です',
    });
  }

  try {
    const url =
      `${base}/k/v1/app/form/fields.json?app=${encodeURIComponent(appId)}`;

    const response = await fetch(url, {
      headers: {
        'X-Cybozu-API-Token': token,
      },
    });

    const json = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: '記事データアプリのフォーム取得に失敗しました',
        detail: json,
      });
    }

    const properties = json.properties || {};

    const target =
      properties['関連レコード一覧'];

    if (!target) {
      return res.status(200).json({
        status: 'not_found',
        fieldCode: '関連レコード一覧',
      });
    }

    const ref =
      target.referenceTable || {};

    return res.status(200).json({
      status: 'ok',

      fieldCode:
        target.code || '',

      label:
        target.label || '',

      type:
        target.type || '',

      referenceTableIsNull:
        target.referenceTable === null,

      relatedAppId:
        ref.relatedApp?.app || '',

      relatedAppCode:
        ref.relatedApp?.code || '',

      conditionField:
        ref.condition?.field || '',

      relatedField:
        ref.condition?.relatedField || '',

      filterCond:
        ref.filterCond || '',

      sort:
        ref.sort || '',

      displayFields:
        ref.displayFields || [],

      size:
        ref.size || '',
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e.message || e),
    });
  }
}