export default async function handler(req, res) {
  const base = String(process.env.KINTONE_BASE_URL || '').trim();
  const token = String(process.env.KINTONE_API_TOKEN || '').trim();
  const appId = String(process.env.KINTONE_APP_ID || '').trim();

  if (!base || !token || !appId) {
    return res.status(500).json({
      error: 'kintoneの環境変数が未設定です',
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
        error: 'kintone Get Form Fields API エラー',
        detail: json,
      });
    }

    const properties = json.properties || {};
    const target = properties['記事一覧_0'];

    if (!target) {
      const candidates = Object.values(properties)
        .filter((field) => field?.type === 'REFERENCE_TABLE')
        .map((field) => ({
          code: field.code,
          label: field.label,
        }));

      return res.status(200).json({
        status: 'not_found',
        targetFieldCode: '記事一覧_0',
        candidates,
      });
    }

    if (target.type !== 'REFERENCE_TABLE') {
      return res.status(200).json({
        status: 'wrong_type',
        fieldCode: target.code,
        label: target.label,
        type: target.type,
      });
    }

    const ref = target.referenceTable || {};

    return res.status(200).json({
      status: 'ok',
      fieldCode: target.code,
      label: target.label,
      type: target.type,

      relatedAppId: ref.relatedApp?.app || '',
      relatedAppCode: ref.relatedApp?.code || '',

      conditionField: ref.condition?.field || '',
      relatedField: ref.condition?.relatedField || '',

      filterCond: ref.filterCond || '',
      sort: ref.sort || '',
      displayFields: ref.displayFields || [],
      size: ref.size || '',
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e.message || e),
    });
  }
}