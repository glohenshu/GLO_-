// ログイン：Google のIDトークンを確かめて、セッションCookieを渡す
//   POST { credential: IDトークン }

import {
  config,
  configProblems,
  verifyGoogleIdToken,
  signSession,
  sessionCookie,
} from './_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST で呼んでください' });
    return;
  }

  const c = config();
  const missing = configProblems(c);
  if (missing.length) {
    res.status(500).json({ error: `Vercel の環境変数が足りません：${missing.join('、')}` });
    return;
  }

  try {
    const { email } = await verifyGoogleIdToken((req.body || {}).credential, c);
    res.setHeader('Set-Cookie', sessionCookie(signSession(email, c.secret)));
    res.status(200).json({ email });
  } catch (e) {
    res.status(403).json({ error: String(e.message || e) });
  }
}
