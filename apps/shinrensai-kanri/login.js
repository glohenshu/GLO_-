// ログイン画面
//   Google のログインボタンを出す → 押されたら IDトークンを /api/login に渡す →
//   通ったら作業画面へ。通らなかった理由はそのまま画面に出す

(function () {
  const messageEl = document.getElementById('login-message');

  function showMessage(text, isError) {
    messageEl.textContent = text;
    messageEl.classList.toggle('is-error', Boolean(isError));
    messageEl.hidden = false;
  }

  async function onCredential(response) {
    showMessage('確認しています…', false);

    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential }),
      });
      const json = await r.json().catch(() => ({}));

      if (!r.ok) {
        showMessage(json.error || `ログインできませんでした（${r.status}）`, true);
        return;
      }

      location.replace('/');
    } catch (e) {
      showMessage(`ログインできませんでした（${e.message || e}）`, true);
    }
  }

  async function start() {
    let cfg;
    try {
      cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
    } catch (e) {
      showMessage('設定を読み込めませんでした。再読み込みしてください', true);
      return;
    }

    if (cfg.loggedIn) {
      location.replace('/');
      return;
    }

    if (!cfg.clientId) {
      showMessage('Vercel の環境変数 GOOGLE_CLIENT_ID が設定されていません', true);
      return;
    }

    // Google のスクリプトは async で読んでいるので、使えるようになるまで待つ
    const waitForGoogle = () =>
      new Promise((resolve) => {
        const tick = () => (window.google && google.accounts && google.accounts.id ? resolve() : setTimeout(tick, 50));
        tick();
      });
    await waitForGoogle();

    google.accounts.id.initialize({
      client_id: cfg.clientId,
      callback: onCredential,
      // 会社のアカウントを先に出す（選べるのは結局 /api/login の確認を通る人だけ）
      hd: 'gentosha.co.jp',
      ux_mode: 'popup',
    });

    google.accounts.id.renderButton(document.getElementById('google-button'), {
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      locale: 'ja',
    });
  }

  start();
})();
