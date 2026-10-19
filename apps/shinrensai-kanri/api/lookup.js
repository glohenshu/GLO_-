// 1作品ぶんの自動取得（中身は _lib/lookup.js）
//   POST { title: 書籍タイトル（H列）, url: 出版実績URL（N列。空でもよい）,
//          subtitle: サブタイトル（I列）, releaseDate: 刊行日（G列） }

import { readSession } from './_lib/session.js';
import { lookupBook } from './_lib/lookup.js';

export default async function handler(req, res) {
  // middleware.js でも止めているが、設定ミスで素通りしたときのためにここでも確かめる
  if (!readSession(req.headers.cookie)) {
    res.status(401).json({ error: 'ログインしてください' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST で呼んでください' });
    return;
  }

  const body = req.body || {};
  res.status(200).json(
    await lookupBook({
      title: body.title,
      url: body.url,
      subtitle: body.subtitle,
      releaseDate: body.releaseDate,
    })
  );
}
