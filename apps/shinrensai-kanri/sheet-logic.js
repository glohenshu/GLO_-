// ============================================================
// 「情報入力用」シートの読み方・書き方（画面に依存しない部分）
//
// ブラウザでは window.SheetLogic、テストでは require() で使う。
//
// 守っていること
//   1. 書くのは下の FIELDS の7列だけ。ほかの列（A〜I・K・P〜W）には一切書かない
//   2. 空いているセルだけ埋める。値が入っているセルは、画面で選んだときだけ上書きする
//   3. 行は制作No（C列）で探す。行番号は使わない。
//      「公開日順にソート」で行が動いても、別の作品に書き込まないため
//   4. 書き込む直前にシートを読み直し、セルの中身が画面に出したときのままかを確かめる。
//      その間に誰かが手で入れた値は上書きしない
//   5. 見出し行が想定と違えば、何も書かずに止める（列の並びが変わったとき用）
// ============================================================

(function (root) {
  'use strict';

  // 列番号は0始まり（A=0）。GAS（連載アプリにレコード作成.js）の COLUMN と同じ並び
  const COL = {
    done: 0,          // A 済
    code: 1,          // B カテゴリコード
    productionNo: 2,  // C 制作No
    releaseDate: 6,   // G 刊行日
    title: 7,         // H 書籍タイトル
    subtitle: 8,      // I サブタイトル
  };

  // 書き込む列
  const FIELDS = [
    { key: 'url', col: 13, letter: 'N', label: '出版実績URL', type: 'string' },
    { key: 'author', col: 9, letter: 'J', label: '著者名（P.N.）', type: 'string' },
    { key: 'catchCopy', col: 11, letter: 'L', label: 'キャッチ', type: 'string' },
    { key: 'intro', col: 12, letter: 'M', label: '内容紹介', type: 'string' },
    { key: 'pages', col: 14, letter: 'O', label: '分量', type: 'number' },
    { key: 'amazon', col: 23, letter: 'X', label: 'Amazon', type: 'string' },
    { key: 'rakuten', col: 24, letter: 'Y', label: '楽天', type: 'string' },
  ];

  // 見出し行の確認。見出しには改行や空白が入っているので、空白を除いて「含むか」で見る
  const HEADER_CHECKS = [
    { col: COL.productionNo, letter: 'C', text: '制作No' },
    { col: COL.releaseDate, letter: 'G', text: '刊行日' },
    { col: COL.title, letter: 'H', text: '書籍タイトル' },
    { col: COL.subtitle, letter: 'I', text: 'サブタイトル' },
    { col: 9, letter: 'J', text: '著者名' },
    { col: 11, letter: 'L', text: 'キャッチ' },
    { col: 12, letter: 'M', text: '内容紹介' },
    { col: 13, letter: 'N', text: '出版実績URL' },
    { col: 14, letter: 'O', text: '分量' },
    { col: 23, letter: 'X', text: 'Amazon' },
    { col: 24, letter: 'Y', text: '楽天' },
  ];

  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

  function checkHeader(headerRow) {
    const row = headerRow || [];
    return HEADER_CHECKS
      .filter((h) => !squash(row[h.col]).includes(h.text))
      .map((h) => `${h.letter}列の見出しが「${h.text}」ではありません（今：「${String(row[h.col] || '').replace(/\s+/g, ' ')}」）`);
  }


  const cell = (row, col) => String((row && row[col]) == null ? '' : row[col]);

  // 作品を見分けるキー。制作Noがあれば制作No、無ければ書籍タイトル
  function rowKey(row) {
    const no = cell(row, COL.productionNo).trim();
    return no ? `no:${no}` : `title:${cell(row, COL.title).trim()}`;
  }


  // values … Sheets API の values.get の結果（1行目が見出し）
  function parseRows(values) {
    const rows = [];

    (values || []).forEach((row, i) => {
      if (i === 0) return;
      const title = cell(row, COL.title).trim();
      if (!title) return;

      const current = {};
      FIELDS.forEach((f) => (current[f.key] = cell(row, f.col)));

      rows.push({
        rowIndex: i, // 0始まり。シート上の行番号は rowIndex + 1
        key: rowKey(row),
        done: cell(row, COL.done).trim(),
        code: cell(row, COL.code).trim(),
        productionNo: cell(row, COL.productionNo).trim(),
        releaseDate: cell(row, COL.releaseDate).trim(),
        title,
        subtitle: cell(row, COL.subtitle).trim(),
        current,
      });
    });

    return rows;
  }


  function isBlank(v) {
    return String(v == null ? '' : v).trim() === '';
  }

  // 「同じ値」とみなすか。末尾の空白・改行コード、URL末尾の / の有無、
  // 分量の「106」と「106.0」の違いでは「違う」と言わない
  function sameValue(field, a, b) {
    const norm = (v) => {
      let s = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
      if (field.type === 'number' && s !== '' && !isNaN(Number(s))) s = String(Number(s));
      if (/^https?:\/\//.test(s)) s = s.replace(/\/+$/, '');
      return s;
    };
    return norm(a) === norm(b);
  }


  // 1作品ぶんの「シートの今の値」と「取得した値」から、セルごとの扱いを決める
  //   fill    … シートが空で、取得できた → 書き込む（最初からチェックを入れる）
  //   differs … シートに別の値が入っている → 上書きは選んだときだけ（最初はチェックなし）
  //   same    … 同じ値 → 何もしない
  //   none    … 取得できなかった → 何もしない
  function planCells(row, fetchedValues) {
    const fetched = fetchedValues || {};

    return FIELDS.map((f) => {
      const current = row.current[f.key];
      const value = String(fetched[f.key] == null ? '' : fetched[f.key]);

      let state;
      if (isBlank(value)) state = 'none';
      else if (isBlank(current)) state = 'fill';
      else if (sameValue(f, current, value)) state = 'same';
      else state = 'differs';

      return {
        key: f.key,
        label: f.label,
        letter: f.letter,
        current,
        value,
        state,
        checked: state === 'fill',
      };
    });
  }


  // ============================================================
  // 書き込み
  //
  // pending … 書き込む予定のセル
  //   [{ key: 行のキー, title, field: FIELDS の key, value, expected: 画面に出したときのシートの値 }]
  // freshValues … 書き込む直前に読み直したシート
  //
  // 返り値 … { requests: Sheets API batchUpdate の requests, written: [...], skipped: [...] }
  // ============================================================

  function buildWrites(sheetId, freshValues, pending) {
    const problems = checkHeader((freshValues || [])[0]);
    if (problems.length) {
      return { requests: [], written: [], skipped: [], error: problems.join('\n') };
    }

    // 同じキーの行が2つあると、どちらに書くべきか決められない
    const byKey = new Map();
    const dupKeys = new Set();
    (freshValues || []).forEach((row, i) => {
      if (i === 0 || !cell(row, COL.title).trim()) return;
      const k = rowKey(row);
      if (byKey.has(k)) dupKeys.add(k);
      byKey.set(k, { row, rowIndex: i });
    });

    const requests = [];
    const written = [];
    const skipped = [];

    for (const p of pending) {
      const field = FIELDS.find((f) => f.key === p.field);
      const label = `${p.title}／${field ? field.label : p.field}`;

      if (!field) {
        skipped.push({ ...p, reason: `${label}：書き込み先の列がありません` });
        continue;
      }
      if (dupKeys.has(p.key)) {
        skipped.push({ ...p, reason: `${label}：同じ制作Noの行が2つあるため書きませんでした` });
        continue;
      }

      const hit = byKey.get(p.key);
      if (!hit) {
        skipped.push({ ...p, reason: `${label}：シートにこの作品の行が見つかりません（削除されたか、制作Noが変わっています）` });
        continue;
      }
      if (cell(hit.row, COL.title).trim() !== p.title) {
        skipped.push({ ...p, reason: `${label}：同じ制作Noの行の書籍タイトルが変わっています` });
        continue;
      }

      const now = cell(hit.row, field.col);
      if (!sameValue(field, now, p.expected) && !(isBlank(now) && isBlank(p.expected))) {
        skipped.push({ ...p, reason: `${label}：読み込んだあとにシートの値が変わっていたため書きませんでした` });
        continue;
      }

      requests.push(cellRequest(sheetId, hit.rowIndex, field, p.value));
      written.push({ ...p, rowNumber: hit.rowIndex + 1, letter: field.letter });
    }

    return { requests, written, skipped, error: '' };
  }


  // 1セルを書き換える Sheets API のリクエスト。
  // 値は「入力した文字」としてではなく、型を決めて入れる（= で始まる文が数式にならないように）
  function cellRequest(sheetId, rowIndex, field, value) {
    const v = String(value);
    const userEnteredValue =
      field.type === 'number' && v.trim() !== '' && !isNaN(Number(v))
        ? { numberValue: Number(v) }
        : { stringValue: v };

    return {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: field.col,
          endColumnIndex: field.col + 1,
        },
        rows: [{ values: [{ userEnteredValue }] }],
        fields: 'userEnteredValue',
      },
    };
  }


  const api = { COL, FIELDS, checkHeader, parseRows, rowKey, planCells, sameValue, buildWrites, cellRequest };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SheetLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
