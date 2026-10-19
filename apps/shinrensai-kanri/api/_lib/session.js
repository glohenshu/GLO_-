// ============================================================
// ログインの鍵
//
// 1. ログイン画面で Google のログインボタンを押すと、Google から IDトークンが届く
// 2. /api/login がそれを確かめる（verifyGoogleIdToken）
//      署名が Google のものか / 宛先が自分のクライアントIDか / 期限内か /
//      メールアドレスが確認済みか / 会社のドメインか / 許可リストに入っているか
// 3. 通ったら、このアプリが署名したCookie（セッション）を渡す
// 4. 以降は middleware.js と各APIが、そのCookieを確かめる（readSession）
//
// 秘密の値はすべて Vercel の環境変数に置く。
//   GOOGLE_CLIENT_ID … ウェブ アプリケーション種別のクライアントID（公開して問題ない値）
//   ALLOWED_EMAILS   … 使える人のメールアドレス。カンマ区切り
//   ALLOWED_DOMAIN   … 会社のドメイン。未設定なら gentosha.co.jp
//   SESSION_SECRET   … Cookieの署名に使う。32文字以上のランダムな文字列
// ============================================================

import crypto from 'node:crypto';

export const COOKIE_NAME = 'sk_session';

// ログインが切れるまでの時間。1日の作業の途中で切れない程度にする
export const SESSION_HOURS = 10;

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';


export function config() {
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || '').trim(),
    allowedDomain: String(process.env.ALLOWED_DOMAIN || 'gentosha.co.jp').trim().toLowerCase(),
    allowedEmails: String(process.env.ALLOWED_EMAILS || '')
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    secret: String(process.env.SESSION_SECRET || ''),
  };
}


// 設定漏れのまま公開すると「誰も入れない」か「鍵が弱い」のどちらかになる。
// どちらも黙って動かさず、何が足りないかを返す
export function configProblems(c = config()) {
  const out = [];
  if (!c.clientId) out.push('GOOGLE_CLIENT_ID');
  if (!c.allowedEmails.length) out.push('ALLOWED_EMAILS');
  if (c.secret.length < 32) out.push('SESSION_SECRET（32文字以上）');
  return out;
}


const b64url = (buf) => Buffer.from(buf).toString('base64url');


// ============================================================
// セッションCookie
//   値は「本文.署名」。本文は {e: メールアドレス, x: 期限（ミリ秒）}
// ============================================================

export function signSession(email, secret, now = Date.now()) {
  const body = b64url(JSON.stringify({ e: email, x: now + SESSION_HOURS * 3600 * 1000 }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}


export function verifySessionValue(value, secret, now = Date.now()) {
  if (!value || !secret) return null;

  const [body, sig] = String(value).split('.');
  if (!body || !sig) return null;

  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!data || typeof data.e !== 'string' || typeof data.x !== 'number') return null;
  if (data.x <= now) return null;

  return { email: data.e, expires: data.x };
}


export function cookieFromHeader(header, name = COOKIE_NAME) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}


// セッションを読んで、今も使ってよい人かを確かめる。
// ログイン後に許可リストから外した人は、Cookieの期限内でもここで止まる
export function readSession(cookieHeader, c = config(), now = Date.now()) {
  if (configProblems(c).length) return null;

  const s = verifySessionValue(cookieFromHeader(cookieHeader), c.secret, now);
  if (!s) return null;
  if (!c.allowedEmails.includes(s.email.toLowerCase())) return null;

  return s;
}


// SameSite は Lax にする。Strict だと、チャットなど別のサイトに貼ったリンクから
// 開いたときにCookieが送られず、毎回ログイン画面に戻されるため。
// Lax でも、別のサイトからの POST（書き込みや取得の依頼）にはCookieが付かない。
export function sessionCookie(value) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`;
}

export function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}


// ============================================================
// Google の IDトークンの確認
// ============================================================

let certCache = { keys: null, until: 0 };

async function googleKeys(fetchImpl, now) {
  if (certCache.keys && certCache.until > now) return certCache.keys;

  const r = await fetchImpl(GOOGLE_CERTS_URL);
  if (!r.ok) throw new Error(`Googleの公開鍵を取得できませんでした（${r.status}）`);

  const json = await r.json();
  // 公開鍵は数時間ごとに入れ替わる。Cache-Control に従い、無ければ1時間持つ
  const maxAge = Number((String(r.headers.get('cache-control') || '').match(/max-age=(\d+)/) || [])[1] || 3600);
  certCache = { keys: json.keys || [], until: now + maxAge * 1000 };

  return certCache.keys;
}


// 通らないときは理由を書いた Error を投げる。理由はそのまま画面に出す
export async function verifyGoogleIdToken(idToken, c = config(), { fetchImpl = fetch, now = Date.now(), keys } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('ログイン情報の形が正しくありません');

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('ログイン情報を読み取れません');
  }

  if (header.alg !== 'RS256') throw new Error('ログイン情報の署名方式が想定外です');

  const jwks = keys || (await googleKeys(fetchImpl, now));
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('ログイン情報の署名鍵が見つかりません');

  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url')
  );
  if (!ok) throw new Error('ログイン情報の署名が正しくありません');

  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error('Google以外が発行したログイン情報です');
  if (payload.aud !== c.clientId) throw new Error('このアプリ宛てのログイン情報ではありません');
  if (!(Number(payload.exp) * 1000 > now)) throw new Error('ログイン情報の期限が切れています。もう一度ログインしてください');

  const email = String(payload.email || '').toLowerCase();
  if (!email || payload.email_verified !== true) throw new Error('メールアドレスが確認されていないアカウントです');

  // hd は Google Workspace のアカウントにだけ付く。個人の Gmail はここで止まる
  if (String(payload.hd || '').toLowerCase() !== c.allowedDomain || !email.endsWith(`@${c.allowedDomain}`)) {
    throw new Error(`${c.allowedDomain} のアカウントでログインしてください`);
  }

  if (!c.allowedEmails.includes(email)) throw new Error(`${email} はこのアプリを使える人に登録されていません`);

  return { email };
}
