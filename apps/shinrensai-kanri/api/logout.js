// ログアウト：セッションCookieを消す
import { clearedCookie } from './_lib/session.js';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST で呼んでください' });
    return;
  }

  res.setHeader('Set-Cookie', clearedCookie());
  res.status(200).json({ ok: true });
}
