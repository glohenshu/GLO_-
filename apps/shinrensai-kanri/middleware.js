// ============================================================
// 入口の鍵（Vercel Routing Middleware）
//
// 画面・API・JavaScript・CSS のどれも、ログインしていないと返さない。
// 通すのはログイン画面と、ログインに要るものだけ。
//
//   ページ … ログイン画面へ移す
//   API    … 401 を返す
//
// 続けて通すときは @vercel/functions の next() と同じく、
// `x-middleware-next: 1` を付けた空のレスポンスを返す
// （next() の中身がこれだけなので、パッケージは入れていない）。
// ============================================================

import { readSession } from './api/_lib/session.js';

export const config = {
  runtime: 'nodejs',
};

// ログインしていなくても開けるもの
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/login.js',
  '/style.css',
  '/api/login',
  '/api/config',
]);

export default function middleware(request) {
  const url = new URL(request.url);

  if (PUBLIC_PATHS.has(url.pathname) || readSession(request.headers.get('cookie'))) {
    return new Response(null, { headers: { 'x-middleware-next': '1' } });
  }

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'ログインしてください' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: '/login.html', 'Cache-Control': 'no-store' },
  });
}
