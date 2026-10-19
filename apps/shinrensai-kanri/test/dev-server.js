/* ============================================================
   手元で動かすための簡易サーバー（Vercel の代わり）

     ALLOWED_EMAILS=自分のアドレス SHEET_ID=試し用シートのID node apps/shinrensai-kanri/test/dev-server.js

   http://localhost:3000 で開く（Google のクライアントIDに登録してある生成元）。
   Vercel と同じく、先に middleware.js を通し、/api/○○ は api/○○.js を動かす。

   SHEET_ID には、本物のシートではなく「コピー」のIDを入れること。
   GOOGLE_CLIENT_ID と SESSION_SECRET は、未設定なら手元用の値を入れる。
   ============================================================ */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

process.env.GOOGLE_CLIENT_ID ||= '411622927186-nqlgb6d8des8fe300oqcgd1g9ki7vrok.apps.googleusercontent.com';
process.env.SESSION_SECRET ||= crypto.randomBytes(32).toString('hex');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      // 1. 入口の鍵
      const { default: middleware } = await import(pathToFileURL(path.join(APP, 'middleware.js')).href);
      const gate = middleware(new Request(url, { headers: { cookie: req.headers.cookie || '' } }));
      if (gate.headers.get('x-middleware-next') !== '1') {
        res.writeHead(gate.status, Object.fromEntries(gate.headers));
        res.end(await gate.text());
        return;
      }

      // 2. API（Vercel の Node 関数と同じ形の req / res を渡す）
      if (url.pathname.startsWith('/api/')) {
        const name = url.pathname.slice(5).replace(/[^a-z-]/g, '');
        const file = path.join(APP, 'api', `${name}.js`);
        if (!name || !fs.existsSync(file)) {
          res.writeHead(404).end();
          return;
        }
        const { default: handler } = await import(pathToFileURL(file).href);
        req.query = Object.fromEntries(url.searchParams);
        req.body = await readBody(req);
        res.status = (code) => ((res.statusCode = code), res);
        res.json = (obj) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(obj));
        };
        await handler(req, res);
        return;
      }

      // 3. 画面のファイル
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(APP, rel);
      if (!file.startsWith(APP) || rel.startsWith('api/') || rel.startsWith('test/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    } catch (e) {
      console.error(e);
      res.writeHead(500).end(String(e));
    }
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
