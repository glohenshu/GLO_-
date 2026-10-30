# 夜明け入力サポートツール 引継ぎメモ（2026/10/19 版）

（2026/10/29 に「新連載管理アシスタント」から改名。フォルダ名・Vercel のプロジェクト名・URL は変えていない）

置き場所：`apps/shinrensai-kanri/`
Vercel Project：`glo-shinrensai-kanri`（team glo11、Root Directory は `apps/shinrensai-kanri`）
本番URL：https://glo-shinrensai-kanri.vercel.app

サーバーは東京（`vercel.json` の `regions: ["hnd1"]`）で動かす。
既定のアメリカ（iad1）から楽天の検索結果を読むと、手元のPCと違う中身が返り、
楽天ブックスの商品が見つからなかった（2026/10/19、gr2021）。

## 1. 何をするアプリか

「新連載管理用シート（夜明け）」の「情報入力用」タブで、手入力していた7列を自動で埋める。
**シートとGASは今のまま使う**（412からの取得・402への登録・予告記事のHTML生成・並べ替え・リセット）。
このアプリは値を取ってきて、空いているセルに書き込むだけ。

| 列 | 項目 | 取り先 |
|---|---|---|
| N | 出版実績URL | 空なら、H列の書名で出版実績サイトを検索（`/?s=書名`）。入っていれば、そのページがあるか・同じ本かを確かめる |
| J | 著者名（P.N.） | 著者紹介の1行目から読みがなを外す |
| L | キャッチ | `product_detail_info` ブロック |
| M | 内容紹介 | 空行を残さない（シートの内容紹介に空行は無い）。「－－」は「――」に |
| O | 分量 | `itemprop="numberOfPages"`。電子のみの作品はページに無い |
| X | Amazon | 紙の本：`https://www.amazon.co.jp/exec/obidos/ASIN/{ISBN10}/`（タグ無し）。電子のみ：ページの `dp/B0…` |
| Y | 楽天 | 紙の本：楽天の検索結果でショップが「楽天ブックス」の商品 → `https://books.rakuten.co.jp/rb/{番号}/`。電子のみ：ページの `rk/…` |

G列の刊行日は、GASで412から入れる（§5）。H・Iは今のGASが412から入れているので触らない。

2026/10/19 に情報入力用の20行（gr2017〜2036）で、取った値とシートの値を突き合わせた：
URL・著者名・Amazon・楽天は20/20、分量19/20、キャッチ19/20、内容紹介18/20。
合わなかった4件は手で直した跡（gr2025 の「!!」、gr2024 の改行、gr2036 の全角スペース、gr2033 の分量）。

## 2. 書き込みの決まり（`sheet-logic.js`）

- 書くのは上の7列だけ
- 空いているセルだけ書く。値が入っているセルは、画面で「上書きする」にチェックしたときだけ
- 行は**制作No（C列）**で探す。行番号は使わない（「公開日順にソート」で行が動くため）
- 書く直前にシートを読み直す。セルが画面に出したときから変わっていたら書かない
- 見出し行が想定と違えば何も書かない（列の挿入・並べ替え対策）
- シートの読み書きは、ログインした本人のGoogleアカウントの権限で、ブラウザから Sheets API を直接呼ぶ。サービスアカウントや公開GASは使わない

## 3. 鍵

- 会社のGoogleアカウントでログイン（`login.html`）。サーバー側で、署名・宛先・期限・メール確認済み・ドメイン（gentosha.co.jp）・許可リストを確かめる（`api/_lib/session.js`）
- 通ったら、署名付きのCookie（10時間）を渡す。`middleware.js` が、ログイン画面以外の画面・API・JS をすべて止める
- 許可リストから外した人は、Cookieの期限内でも次の操作から止まる

## 4. 公開の手順

### Google Cloud（プロジェクト `glo-ga4-api`）
1. 「APIとサービス」で Google Sheets API が有効か確認する
2. 「Google Auth Platform」→「データアクセス」に `https://www.googleapis.com/auth/spreadsheets` を足す
3. ウェブ用クライアントID（`411622927186-nqlgb6d8des8fe300oqcgd1g9ki7vrok.apps.googleusercontent.com`）の「承認済みの JavaScript 生成元」に本番URLを足す（末尾の `/` なし）

### Vercel
1. team glo11 で新しいプロジェクトを作る。リポジトリはこのリポジトリ、Root Directory は `apps/shinrensai-kanri`
2. 環境変数を入れる

| 変数 | 値 |
|---|---|
| `GOOGLE_CLIENT_ID` | 上のクライアントID |
| `ALLOWED_EMAILS` | 使える人のメールアドレス（カンマ区切り） |
| `SESSION_SECRET` | 32文字以上のランダムな文字列。チャットやシートに貼らない |
| `SHEET_ID` | 書き込み先のシートID。**試すときはシートのコピーのIDにする** |
| `SHEET_NAME` | 省略可。既定は `情報入力用` |
| `ALLOWED_DOMAIN` | 省略可。既定は `gentosha.co.jp` |

3. デプロイ後、本番URLで次を確かめる
   - ログインしていない状態で `/`・`/app.js`・`/api/lookup` が開けないこと
   - **Vercel のサーバーから、出版実績サイトと楽天の検索結果を読めるか**（手元のPCからは読めた。海外のサーバーからは未確認）
   - シートのコピーで、①読み込み→②取得→③書き込み が通ること

## 5. GAS：刊行日を412から入れる

`許諾書アプリからデータ取得.js` と `許諾書アプリから新規一括集中データ取得.js` の **両方**の `FIELD_MAP` に1行足す。

```js
{ col: 6,  field: '刊行日' },        // G列：刊行日
```

412の刊行日は `yyyy-MM-dd` の文字列で返る。G列は日付の入力規則つきなので、日付として入るかを最初の実行で確かめる。

## 6. テスト

```bash
node apps/shinrensai-kanri/test/run-tests.js
```

ネットワークには出ない（出版実績・楽天・Google は偽物で返す）。84件。

手元で画面を動かすとき（`http://localhost:3000` はクライアントIDに登録済み）：

```bash
ALLOWED_EMAILS=自分のアドレス SHEET_ID=シートのコピーのID node apps/shinrensai-kanri/test/dev-server.js
```

## 7. 気をつけること

- `api/_lib/publication.js` の `htmlToText` / `cutAtStops` / `extractTitleBlock` は、ルートの `api/fetch-info.js` から移したもの。片方を直したら、もう片方も直す
- 逆に `extractStoreLinks` / `isbn13to10` は、ルートの `api/fetch-info.js` にも写してある（夜明けのAmazon・楽天の照合用、2026/10/30）。こちらも片方を直したら、もう片方も直す
- 内容紹介の改行の扱いは、新連載作成アシスタント（段落に空行を残す）とは**わざと違う**。シートの書き方に合わせている
- ルートの新連載作成アシスタントのURLの下で `apps/` 配下のファイルが読める（既存の2アプリも同じ）。秘密の値はコードに無いので漏れるものは無いが、気になるなら別途止める
