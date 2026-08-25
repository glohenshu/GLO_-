# 新規一括集中アシスタント 引継ぎメモ

更新日: 2026-08-25（Ver.0.1）
対象リポジトリ: `https://github.com/glohenshu/GLO_-.git`
対象アプリ: `apps/bulk-assistant`
Vercel Project: 未作成（作るときは Root Directory を `apps/bulk-assistant` にする）

---

## 1. アプリの目的

新規の一括集中連載をMediaWeaver（MW）で作るときの作業支援ツール。
再掲連載作成アシスタント（`apps/reprint-assistant`）の①前回記事タブを流用して作った。

1. MWで今回の記事の下書きを作り、採番された記事IDを取得
2. 本アプリで回数を決める
3. 記事IDとタイトルを入力
4. 1つ前の回のID・タイトルから「前回の記事を読む」HTMLを生成
5. MWへ貼り付ける

---

## 2. 再掲連載アシスタントとの違い

| | 再掲（reprint-assistant） | 新規一括集中（bulk-assistant） |
|---|---|---|
| 参照元の過去連載 | 使う（kintone 記事データアプリ341から抽出） | 無い |
| カテゴリコード入力 | あり | **無い** |
| kintone / スプレッドシート | `/api/reprint-data` 経由で使う | **一切使わない。通信しない** |
| 回数の初期値 | 参照元の記事数 | 8回（`DEFAULT_EPISODE_COUNT`） |
| タブ | ①前回記事／②記事下／③次回更新日 | **①前回記事リンク作成のみ** |

APIも環境変数も無いので、`apps/bulk-assistant` は静的3ファイルだけで動く。

---

## 3. 構成

```text
apps/
└─ bulk-assistant/
   ├─ index.html
   ├─ app.js
   ├─ style.css        （reprint-assistant からそのままコピー）
   └─ test/
      └─ run-tests.js
```

`style.css` は reprint-assistant と同じもの。②③タブを足すときにそのまま使えるよう、
使っていないクラスも残してある。**基調色の深緑 `#1B6B52` は変えない**（GLOツール共通）。

---

## 4. ① 前回記事リンク作成タブ

列：`回` / `今回の記事ID` / `今回の記事タイトル` / `前回記事` / `操作`

- 回数はタブ内の「回数」で決める（`#prev-count`）。1〜200回。全角数字も受ける
- 開いた時点で8行できている。参照元から回数が決まらないため、既定値を置いている
- 最後の行のラベルは `最終回`（`tr.is-final`）
- 記事IDは個別入力と一括貼り付け（1行1ID・空行無視・CRLF可）に対応
- 記事タイトルは任意入力。**プレースホルダーは置かない**（入力済みに見えるため）
- タイトル欄の直下に `18文字` のように `Array.from(value).length` で文字数を出す
- 第2回以降は1つ前の回のID・タイトルを参照する

生成HTML（再掲側と同じ）:

```html
<p align="center"><a href="/articles/-/30001" target="_blank"><strong><span style="color:#0000CD;">【前回の記事を読む】入力したタイトル</span></strong></a></p>
```

タイトル未入力なら `●▼■` を使う。タイトルはコピーの必須条件ではなく、前回IDがあればコピーできる。

- **第1回はコピーボタン自体を作らない**
- ボタンは `HTMLコピー` → コピー成功後 `コピー済み ✓`（`copied` クラス）。
  **前回記事タブは回ごとに残す**（どこまで進んだかを一覧で分かるようにするため）
- コピー時のHTMLを `row.copiedHtml` に保持し、`syncPrevCopiedState()` で
  現在の生成HTMLと突き合わせて、内容が変わればコピー済みを自動解除する
- 回数を減らして消えた行の入力は `state.idStash` / `state.titleStash` / `state.copiedStash` に
  退避する。`10→8→10` で後半の入力が戻る。一括貼り付けの超過分も退避する
- 空にした行は**空のまま覚える**。消したはずの入力が回数を戻したときに復活しないようにする

---

## 5. 壊してはいけない実装

- 記事IDが未入力の回はコピーボタンを無効にする。誤ったリンクを貼らせない
- タイトルは `escapeHtml()` を通す（`&` `<` `>` `"`）
- `switchTab()` は `TAB_NAMES` に無い名前を弾く。②③を足すときは
  `TAB_NAMES` と `el` のパネル参照を両方増やすこと
- 起動時の描画（`setEpisodeCount(DEFAULT_EPISODE_COUNT)`）は**app.jsの末尾**で呼ぶ。
  `PREV_TITLE_FALLBACK` などの `const` より前に呼ぶとTDZで落ちる

---

## 6. テスト

```bash
node apps/bulk-assistant/test/run-tests.js
```

DOMをスタブして `app.js` をそのままNodeで動かす。31件。
日付もkintoneも使わないため、日付の固定はしていない。

カバー範囲：回数入力（全角・上下限・読めない値・退避と復活）／前回記事の表示／
生成HTML（エスケープ・フォールバック・参照先）／コピー済み表示／一括貼り付け／タブ。

修正後は構文確認もする。

```bash
node --check apps/bulk-assistant/app.js
```

---

## 7. 次にやること

1. Vercelプロジェクトの作成（Root Directory `apps/bulk-assistant`）
2. ②以降のタブの要件確認。一括集中で「記事下」「次回更新日」が要るかは未確認
3. 実運用の記事IDで通し確認
