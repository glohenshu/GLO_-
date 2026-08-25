// ============================================================
// 新規一括集中アシスタント Ver.0.2 ── データ取得API
//
// 新規連載なので参照元の過去連載は無い。取りに行くのは2つだけ。
//
//   1. GLO連載情報   … 書籍タイトル / カテゴリID / 第1回配信日時 / 制作No / $id
//   2. スプレッドシート … 「毎月の記事下リンク」B列・C列
//
// 再掲連載作成アシスタント（apps/reprint-assistant/api/reprint-data.js）から
// 記事データアプリ341の参照元探索を落としたもの。
//
// 2つは互いに独立させる。1つ失敗しても残りは使えるようにし、
// 途中で早期returnしない（GLOツール共通の方針）。
//
// APIトークン・GASのURLはこのファイルの中だけで使い、
// レスポンスにもフロントにも出さない。
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const base = envValue('KINTONE_BASE_URL');
  const seriesToken = envValue('KINTONE_API_TOKEN');
  const seriesAppId = envValue('KINTONE_APP_ID');

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

    // GLO連載情報アプリ（今回作る一括集中連載）
    series: {
      status: 'error',
      message: '',
      data: null,
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
  // 1. GLO連載情報アプリ
  // ============================================================

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
      throw new Error(`カテゴリID「${categoryCode}」のレコードが見つかりません`);
    }

    const record = records[0];

    const seriesData = {
      recordId: record['$id']?.value || '',

      categoryCode: record['カテゴリID']?.value || categoryCode,

      bookTitle: record['書籍タイトル']?.value || '',

      // 一括集中の日付の扱いは未確定。取得だけしておき、画面では使わない
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

    // 書籍タイトルは記事下の『』に入る。無いと一覧リンクが作れない
    if (!seriesData.bookTitle) {
      result.warnings.push('書籍タイトルが未登録です');
    }
  } catch (e) {
    result.series.message = String(e.message || e);
  }

  // ============================================================
  // 2. スプレッドシート「毎月の記事下リンク」
  // ============================================================

  const sheet = await sheetPromise;

  result.sheet = {
    status: sheet.status,
    message: sheet.message,
    rows: sheet.rows,
    rowCount: Array.isArray(sheet.rows) ? sheet.rows.length : 0,
  };

  if (sheet.status !== 'ok') {
    result.warnings.push(`記事下リンクを取得できませんでした：${sheet.message}`);
  }

  if (summaryOnly) {
    return res.status(200).json({
      status: result.status,
      categoryCode,

      series: {
        status: result.series.status,
        message: result.series.message,
        bookTitle: (result.series.data && result.series.data.bookTitle) || '',
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
// GASウェブアプリ経由で取得する。
// GASのデプロイは「アクセスできるユーザー＝全員」でないとログインHTMLが返る。
//
// この関数は決して throw しない。記事下だけ取れなくても
// kintone取得と①前回記事タブはそのまま使えるようにしておく。
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
        throw new Error('GASの応答形式が不正です（valuesが配列ではありません）');
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
      throw new Error('SHEET_GAS_URL（またはSHEET_ID/GOOGLE_API_KEY）が未設定です');
    }

    const sheetName = envValue('SHEET_NAME');

    const range = sheetName ? `${encodeURIComponent(sheetName)}!B:C` : 'B:C';

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

// GLO連載情報はカテゴリIDで1件なのでページングは要らない
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
