// ============================================================
// 新連載管理アシスタント（作業画面）
//
//   ① シートを読み込む … ログインした本人の権限で「情報入力用」を読む
//   ② 自動で取得       … 1作品ずつ /api/lookup に問い合わせる（出版実績・楽天）
//   ③ シートに書き込む … チェックの入ったセルだけ書く（決まりは sheet-logic.js）
//
// シートの読み書きは、このブラウザから Google の Sheets API を直接呼ぶ。
// アクセストークンはこの画面のメモリにだけ持ち、保存しない。
// ============================================================

(function () {
  'use strict';

  const L = window.SheetLogic;
  const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

  const state = {
    config: null,
    token: '',
    tokenUntil: 0,
    sheetTabId: null,   // 「情報入力用」タブの sheetId（数字）
    rows: [],           // SheetLogic.parseRows の結果
    lookups: new Map(), // 行のキー → /api/lookup の結果
    plans: new Map(),   // 行のキー → SheetLogic.planCells の結果（チェックの状態もここ）
    busy: false,
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach((c) => c && node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  function showStatus(text, kind) {
    const s = $('status');
    s.textContent = text;
    s.className = `message${kind ? ' is-' + kind : ''}`;
    s.hidden = !text;
  }

  function setBusy(on) {
    state.busy = on;
    $('load').disabled = on;
    $('lookup').disabled = on || !state.rows.length;
    $('write').disabled = on || !countChecked();
  }


  // ------------------------------------------------------------
  // Google のアクセストークン（シートの読み書き用）
  // ------------------------------------------------------------

  let tokenClient = null;
  let tokenWaiter = null;

  function waitForGoogle() {
    return new Promise((resolve) => {
      const tick = () => (window.google && google.accounts && google.accounts.oauth2 ? resolve() : setTimeout(tick, 50));
      tick();
    });
  }

  async function getToken() {
    if (state.token && Date.now() < state.tokenUntil - 60 * 1000) return state.token;

    await waitForGoogle();

    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: state.config.clientId,
        scope: SHEETS_SCOPE,
        hint: state.config.email,
        callback: (resp) => {
          const w = tokenWaiter;
          tokenWaiter = null;
          if (!w) return;
          if (resp.error) w.reject(new Error(`シートへのアクセスが許可されませんでした（${resp.error}）`));
          else w.resolve(resp);
        },
        error_callback: (err) => {
          const w = tokenWaiter;
          tokenWaiter = null;
          if (w) w.reject(new Error(`シートへのアクセスを確認できませんでした（${err.type || err.message || err}）`));
        },
      });
    }

    const resp = await new Promise((resolve, reject) => {
      tokenWaiter = { resolve, reject };
      // 2回目以降は、許可済みなら画面を出さずに返ってくる
      tokenClient.requestAccessToken({ prompt: '' });
    });

    // 本人以外のアカウントで許可されたら使わない（ログインした人の権限で書くため）
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SHEETS_SCOPE)) {
      throw new Error('シートの読み書きが許可されていません。もう一度「シートを読み込む」を押して、許可してください');
    }

    state.token = resp.access_token;
    state.tokenUntil = Date.now() + Number(resp.expires_in || 3600) * 1000;
    return state.token;
  }

  async function sheetsFetch(path, options) {
    const token = await getToken();
    const r = await fetch(`${SHEETS_API}/${path}`, {
      ...(options || {}),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (r.status === 401) {
      state.token = '';
      throw new Error('シートへのアクセスの期限が切れました。もう一度押してください');
    }

    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (json.error && json.error.message) || r.statusText;
      if (r.status === 403) throw new Error(`このシートを編集する権限がありません（${msg}）`);
      if (r.status === 404) throw new Error(`シートが見つかりません。Vercel の SHEET_ID を確認してください（${msg}）`);
      throw new Error(`シートを読み書きできませんでした（${r.status}：${msg}）`);
    }
    return json;
  }

  async function readSheet() {
    const id = encodeURIComponent(state.config.sheetId);
    const name = state.config.sheetName;

    if (state.sheetTabId === null) {
      const meta = await sheetsFetch(`${id}?fields=sheets.properties(sheetId,title)`);
      const tab = (meta.sheets || []).map((s) => s.properties).find((p) => p.title === name);
      if (!tab) throw new Error(`シートに「${name}」タブがありません`);
      state.sheetTabId = tab.sheetId;
    }

    // 表示どおりの文字で読む（制作No・日付・分量を、シートで見えている形で比べるため）
    const range = encodeURIComponent(`'${name}'!A1:Y`);
    const json = await sheetsFetch(`${id}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
    return json.values || [];
  }


  // ------------------------------------------------------------
  // ① シートを読み込む
  // ------------------------------------------------------------

  async function onLoad() {
    setBusy(true);
    showStatus('シートを読み込んでいます…');
    $('result').hidden = true;

    try {
      const values = await readSheet();
      const problems = L.checkHeader(values[0]);
      if (problems.length) {
        throw new Error(`「情報入力用」の列の並びが想定と違うため止めました。\n${problems.join('\n')}`);
      }

      state.rows = L.parseRows(values);
      state.lookups.clear();
      state.plans.clear();
      render();

      const blanks = state.rows.filter(hasBlank).length;
      showStatus(`${state.rows.length} 作品を読み込みました（空いているセルがある作品：${blanks}）。② 自動で取得 を押してください`, 'ok');
    } catch (e) {
      showStatus(String(e.message || e), 'error');
    } finally {
      setBusy(false);
    }
  }

  function hasBlank(row) {
    return L.FIELDS.some((f) => String(row.current[f.key] || '').trim() === '');
  }


  // ------------------------------------------------------------
  // ② 自動で取得
  // ------------------------------------------------------------

  async function onLookup() {
    const targets = state.rows.filter(hasBlank);
    if (!targets.length) {
      showStatus('空いているセルがある作品はありません', 'ok');
      return;
    }

    setBusy(true);

    // 出版実績サイトに一度に問い合わせないよう、1作品ずつ順番に取る
    for (let i = 0; i < targets.length; i++) {
      const row = targets[i];
      showStatus(`取得しています… ${i + 1} / ${targets.length}（${row.title}）`);

      let result;
      try {
        const r = await fetch('/api/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: row.title,
            url: row.current.url,
            subtitle: row.subtitle,
            releaseDate: row.releaseDate,
          }),
        });
        if (r.status === 401) {
          location.replace('/login.html');
          return;
        }
        result = await r.json();
        if (!r.ok) throw new Error(result.error || `HTTP ${r.status}`);
      } catch (e) {
        result = { status: 'error', message: `取得できませんでした（${e.message || e}）`, values: {}, notes: {} };
      }

      state.lookups.set(row.key, result);
      state.plans.set(row.key, L.planCells(row, result.values));
      renderBook(row);
    }

    const ready = countChecked();
    showStatus(
      ready
        ? `取得が終わりました。書き込むセル：${ready}。内容を確かめて ③ シートに書き込む を押してください`
        : '取得が終わりました。新しく書き込めるセルはありません',
      'ok'
    );
    setBusy(false);
  }


  // ------------------------------------------------------------
  // ③ シートに書き込む
  // ------------------------------------------------------------

  function pendingCells() {
    const out = [];
    for (const row of state.rows) {
      for (const c of state.plans.get(row.key) || []) {
        if (c.checked && (c.state === 'fill' || c.state === 'differs')) {
          out.push({ key: row.key, title: row.title, field: c.key, value: c.value, expected: c.current });
        }
      }
    }
    return out;
  }

  function countChecked() {
    return pendingCells().length;
  }

  async function onWrite() {
    const pending = pendingCells();
    if (!pending.length) return;

    const overwrites = pending.filter((p) => String(p.expected || '').trim() !== '').length;
    const ok = confirm(
      `${pending.length} セルを「${state.config.sheetName}」に書き込みます。` +
      (overwrites ? `\nそのうち ${overwrites} セルは、今入っている値を上書きします。` : '') +
      '\nよろしいですか？'
    );
    if (!ok) return;

    setBusy(true);
    showStatus('書き込む前に、シートを読み直しています…');

    try {
      const fresh = await readSheet();
      const plan = L.buildWrites(state.sheetTabId, fresh, pending);
      if (plan.error) throw new Error(`列の並びが変わっているため書き込みを止めました。\n${plan.error}`);

      if (plan.requests.length) {
        showStatus('書き込んでいます…');
        await sheetsFetch(`${encodeURIComponent(state.config.sheetId)}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({ requests: plan.requests }),
        });
      }

      renderResult(plan);

      // 書いたあとのシートを読み直して、画面を今の状態にする（取得結果は持ち越す）
      const after = await readSheet();
      state.rows = L.parseRows(after);
      for (const row of state.rows) {
        const lk = state.lookups.get(row.key);
        if (lk) state.plans.set(row.key, L.planCells(row, lk.values));
      }
      render();

      showStatus(
        `${plan.written.length} セルを書き込みました` + (plan.skipped.length ? `（書かなかったセル：${plan.skipped.length}）` : ''),
        plan.skipped.length ? 'warn' : 'ok'
      );
    } catch (e) {
      showStatus(String(e.message || e), 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderResult(plan) {
    const list = $('result-list');
    list.textContent = '';
    plan.written.forEach((w) => {
      const f = L.FIELDS.find((x) => x.key === w.field);
      list.appendChild(el('li', { text: `${w.letter}${w.rowNumber}　${w.title}／${f.label}` }));
    });
    plan.skipped.forEach((s) => list.appendChild(el('li', { class: 'is-warn', text: s.reason })));
    $('result').hidden = !(plan.written.length || plan.skipped.length);
  }


  // ------------------------------------------------------------
  // 表示
  // ------------------------------------------------------------

  const STATE_LABEL = {
    fill: '空欄に書き込む',
    differs: 'シートと違う',
    same: 'シートと同じ',
    none: '取得できず',
  };

  const LOOKUP_LABEL = {
    ok: '',
    notfound: '出版実績ページなし',
    gone: '出版実績ページ削除済み',
    mismatch: '出版実績URLが別の本',
    ambiguous: '候補が複数',
    error: '取得エラー',
  };

  function render() {
    const box = $('books');
    box.textContent = '';
    const onlyBlank = $('only-blank').checked;

    state.rows
      .filter((row) => !onlyBlank || hasBlank(row) || state.plans.has(row.key))
      .forEach((row) => box.appendChild(bookCard(row)));

    setBusy(state.busy);
  }

  function renderBook(row) {
    const old = document.querySelector(`[data-key="${CSS.escape(row.key)}"]`);
    const card = bookCard(row);
    if (old) old.replaceWith(card);
    else $('books').appendChild(card);
    setBusy(state.busy);
  }

  function bookCard(row) {
    const lookup = state.lookups.get(row.key);
    const plan = state.plans.get(row.key);

    const head = el('div', { class: 'book-head' }, [
      el('span', { class: 'book-meta', text: [row.productionNo && `制作No ${row.productionNo}`, row.code, `${row.rowIndex + 1}行目`].filter(Boolean).join('　') }),
      el('h3', { text: row.title }),
      lookup && lookup.status !== 'ok' ? el('span', { class: 'badge is-warn', text: LOOKUP_LABEL[lookup.status] || lookup.status }) : null,
    ]);

    const children = [head];

    if (lookup && lookup.message) {
      children.push(el('p', { class: 'book-message', text: lookup.message }));
    }
    if (lookup && lookup.candidates && lookup.candidates.length) {
      children.push(el('ul', { class: 'candidates' }, lookup.candidates.map((u) =>
        el('li', {}, [el('a', { href: u, target: '_blank', rel: 'noopener', text: decodeURI(u) })])
      )));
    }

    const table = el('table', { class: 'cells' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '項目' }),
        el('th', { text: 'シートの今の値' }),
        el('th', { text: '取得した値' }),
        el('th', { text: '書き込む' }),
      ])]),
    ]);
    const tbody = el('tbody');

    L.FIELDS.forEach((f, i) => {
      const c = plan ? plan[i] : null;
      const current = row.current[f.key];
      const note = lookup && lookup.notes && lookup.notes[f.key];

      let pick = el('span', { class: 'muted', text: plan ? STATE_LABEL[c.state] : '' });
      if (c && (c.state === 'fill' || c.state === 'differs')) {
        const box = el('input', {
          type: 'checkbox',
          checked: c.checked,
          onchange: (ev) => {
            c.checked = ev.target.checked;
            setBusy(state.busy);
          },
        });
        pick = el('label', { class: c.state === 'differs' ? 'pick is-overwrite' : 'pick' }, [
          box,
          c.state === 'differs' ? '上書きする' : '書き込む',
        ]);
      }

      tbody.appendChild(el('tr', { class: c ? `is-${c.state}` : '' }, [
        el('th', { scope: 'row' }, [f.label, el('span', { class: 'col-letter', text: `${f.letter}列` })]),
        el('td', {}, [valueBox(current, '（空欄）')]),
        el('td', {}, [c ? valueBox(c.value, note || '（取得できず）') : el('span', { class: 'muted', text: '―' })]),
        el('td', { class: 'pick-cell' }, [pick]),
      ]));
    });

    table.appendChild(tbody);
    children.push(el('div', { class: 'table-scroll' }, [table]));

    return el('article', { class: 'panel book', 'data-key': row.key }, children);
  }

  function valueBox(value, emptyText) {
    const v = String(value == null ? '' : value);
    if (!v.trim()) return el('span', { class: 'muted', text: emptyText });
    if (/^https?:\/\//.test(v)) {
      return el('a', { class: 'value url', href: v, target: '_blank', rel: 'noopener', text: v });
    }
    return el('div', { class: 'value', text: v });
  }


  // ------------------------------------------------------------
  // はじめに
  // ------------------------------------------------------------

  async function start() {
    try {
      state.config = await (await fetch('/api/config', { cache: 'no-store' })).json();
    } catch (e) {
      showStatus('設定を読み込めませんでした。再読み込みしてください', 'error');
      return;
    }

    if (!state.config.loggedIn) {
      location.replace('/login.html');
      return;
    }

    $('who-email').textContent = state.config.email;

    if (!state.config.sheetId) {
      showStatus('Vercel の環境変数 SHEET_ID が設定されていません', 'error');
      $('load').disabled = true;
      return;
    }

    $('load').addEventListener('click', onLoad);
    $('lookup').addEventListener('click', onLookup);
    $('write').addEventListener('click', onWrite);
    $('only-blank').addEventListener('change', render);
    $('logout').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      if (window.google && google.accounts && google.accounts.oauth2 && state.token) {
        google.accounts.oauth2.revoke(state.token, () => {});
      }
      location.replace('/login.html');
    });
  }

  start();
})();
