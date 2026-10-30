// 新連載作成アシスタント用：夜明けの Amazon・楽天リンクを返すGAS
//
// 「新連載管理用シート（夜明け）」の「情報入力用」タブから、
// カテゴリコード（B列）が一致する行の Amazon（X列）・楽天（Y列）だけを返す。
//
// デプロイ：新しいスタンドアロンのプロジェクトに貼り、ウェブアプリとして
//   実行ユーザー＝自分 / アクセスできるユーザー＝全員
// でデプロイする。URLを Vercel の環境変数 YOAKE_GAS_URL に入れる。
//
// 「全員」で公開するため、返すのはカテゴリコードで指定した行のX・Y列だけにする。
// 内容紹介・備考などほかの列は返さない。
//
// 呼び方：{ウェブアプリのURL}?code=gr2061
// 返す形：{ "code": "gr2061", "rows": [{ "amazon": "…", "rakuten": "…" }] }
//         失敗したときは { "error": "…" }

const YOAKE_SHEET_ID = '1N4WMRx0AzK2e0GYl1M6hKeTUjiMs0qM62IzXC22yj9s';
const YOAKE_SHEET_NAME = '情報入力用';

// 列番号は0始まり（A=0）。夜明け入力サポートツール（apps/shinrensai-kanri/sheet-logic.js）と同じ並び
const YOAKE_COL = {
  code: 1,     // B カテゴリコード
  amazon: 23,  // X Amazon アフィリエイト
  rakuten: 24, // Y 楽天 アフィリエイト
};

// 列が挿入・並べ替えされたら別の列を返してしまうので、見出しを確かめてから読む
const YOAKE_HEADERS = [
  { col: YOAKE_COL.code, text: 'カテゴリ' },
  { col: YOAKE_COL.amazon, text: 'Amazon' },
  { col: YOAKE_COL.rakuten, text: '楽天' },
];

function doGet(e) {
  try {
    const code = String((e && e.parameter && e.parameter.code) || '').trim().toLowerCase();

    // 指定なしで全行を返すことはしない
    if (!/^gr\d+$/.test(code)) {
      return yoakeJson_({ error: 'code に gr から始まるカテゴリコードを指定してください' });
    }

    const sheet = SpreadsheetApp.openById(YOAKE_SHEET_ID).getSheetByName(YOAKE_SHEET_NAME);
    if (!sheet) {
      return yoakeJson_({ error: `「${YOAKE_SHEET_NAME}」タブがありません` });
    }

    const values = sheet.getDataRange().getDisplayValues();
    const header = values[0] || [];

    // 見出しには改行や空白が入っている（「カテゴリ\nコード」「Amazon \nアフィリエイト」）
    const wrong = YOAKE_HEADERS.filter(
      (h) => !String(header[h.col] || '').replace(/\s+/g, '').includes(h.text)
    );
    if (wrong.length) {
      return yoakeJson_({
        error: `見出しが想定と違います（${wrong.map((h) => h.text).join('・')}）。列が動いていないか確かめてください`,
      });
    }

    const rows = values
      .slice(1)
      .filter((row) => String(row[YOAKE_COL.code] || '').trim().toLowerCase() === code)
      .map((row) => ({
        amazon: String(row[YOAKE_COL.amazon] || '').trim(),
        rakuten: String(row[YOAKE_COL.rakuten] || '').trim(),
      }));

    return yoakeJson_({ code, rows });
  } catch (err) {
    return yoakeJson_({ error: String((err && err.message) || err) });
  }
}

function yoakeJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
