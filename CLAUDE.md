# 新連載作成アシスタント Ver.1

GLOの新規連載登録時に必要な情報を、カテゴリコード（例：`gr1966`）を起点に自動取得・整形する社内ツール。取得結果を社内CMS「MediaWeaver」へ貼り付ける。

- 本番URL：https://shinrensai-assistant.vercel.app/
- API直接確認：`https://shinrensai-assistant.vercel.app/api/fetch-info?code=gr1966`
- 詳細な経緯は `docs/handover.md`（引継ぎメモ 2026/08/18版）を必ず読むこと

## 技術構成・運用

- フロントエンド：HTML / CSS / Vanilla JS（`index.html`, `style.css`, `app.js`）
- バックエンド：Vercelサーバーレス関数（`api/fetch-info.js`）
- デプロイ：`main` へpush → Vercel自動デプロイ。`Ready` を確認してから本番を再読み込み
- Vercel team: `glo11`（team_yuGFJPeltuXEV7ruOUrJAZHA）

## 環境変数（Vercel）

`KINTONE_BASE_URL` / `KINTONE_API_TOKEN` / `KINTONE_APP_ID` / `SHEET_GAS_URL` / `ARTICLE_SHEET_URL`（完全URLでもIDのみでも可） / `MEDIAWEAVER_URL`

※ GASを使わない場合のみ `SHEET_ID` / `GOOGLE_API_KEY` / `SHEET_NAME`。

## 次にやること（優先順）

1. **`<h1>`基準のカテゴリ説明取得版 `fetch-info.js` の本番反映・検証**
   - 修正版は作成済みだが、push・動作確認が完了したかは未確認。まずgit logと本番の挙動で状態を確認する
   - 方針：カテゴリID → kintoneレコード → 登録済み出版実績URL → そのページの `<h1>` → h1直後からキャッチ抽出。**タイトル部分一致で出版実績を探さない**
   - 最優先テスト：`gr1945`（「共感と信頼のサステナ経営」）で、カテゴリ説明が「利益を追わない企業に、未来はない。利益だけ追う企業にも、未来はない。」になること
2. **②書籍登録「紹介文」の `<br><br>` 二重問題の修正**
   - 空行を除去して `<br>` 1つで連結する `textToBrCompact()` を紹介文のみに適用。著者紹介は別ルールなので既存 `textToBr()` を残す
3. **複数書籍で回帰テスト**（`docs/handover.md` §5の検証表に従う。テスト候補：gr1966 / gr1945）
4. 機能安定後にUI全体を再設計（§6の方向性：作業手順に沿った業務ツールへ）

現段階では新機能追加より**取得精度の検証を優先**する。

## 壊してはいけない実装済みロジック

- API処理順：kintone → 出版実績 → 記事下リンク → 確認用リンク生成 → JSON返却（途中で早期returnしない）
- 1ソースの取得失敗で他を止めない設計。失敗項目は「取得できませんでした」表示＋手入力補完
- 著者名行の判定条件：`名前（かな）`形式／先頭が数字でない／括弧内がかな・カナ等／異常に長くない
- サマリー本文：内容紹介から改行・空行を削除して一続きで表示。出典文の著者名は半角スペース除去済み
- 本文テンプレート：C列HTMLの `grxxxx`・`gr●●●●` →カテゴリID、`xxxxxxxx`・`●●●●●●●●` →書籍タイトル置換。タイトル自体に『』が付く場合は二重にならないよう除去
- kintone直リンク：`/k/{APP_ID}/show#record={recordId}`
- 確認用リンクは折りたたみ式を維持
- 出版実績スクレイパー：`<head>`・HTMLコメント除去、STOP_MARKERS（「書籍を購入」「出版実績一覧へ」「03-5411-7188」等）でフッター打ち切り。bot対策で403が返ることがある

## Googleスプレッドシート取得（GAS経由）

会社のWorkspaceポリシーで外部共有禁止のためSheets APIは403になる。GASウェブアプリ（`SHEET_GAS_URL`）経由で取得する。GASのデプロイは「アクセスできるユーザー＝**全員**」必須。組織内限定だとログインHTMLが返り `Unexpected token '<'` になる。確認はシークレットウィンドウでGAS URLを直接開いてJSONが返るかを見る。

## 作業ルール

- 修正後は `node --check` で構文確認してからpush
- 本番反映前にAPI直叩き（`?code=gr1966` 等）で確認できる
- Vercel Deployment Protectionの変更はダッシュボードから手動（APIでは不可）
