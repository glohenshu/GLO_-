// 画面が使う設定値
//
//   ログイン前 … クライアントIDだけ（ログインボタンに要る。公開して問題ない値）
//   ログイン後 … それに加えて、ログイン中のメールアドレスと書き込み先のシートID
//
// シートIDは SHEET_ID に置く。試すときはシートのコピーのIDを入れれば、本物のシートに書かずに済む。

import { config, readSession } from './_lib/session.js';

export default function handler(req, res) {
  const c = config();
  const session = readSession(req.headers.cookie, c);

  res.setHeader('Cache-Control', 'no-store');

  if (!session) {
    res.status(200).json({ clientId: c.clientId, loggedIn: false });
    return;
  }

  res.status(200).json({
    clientId: c.clientId,
    loggedIn: true,
    email: session.email,
    sheetId: String(process.env.SHEET_ID || '').trim(),
    sheetName: String(process.env.SHEET_NAME || '情報入力用').trim(),
  });
}
