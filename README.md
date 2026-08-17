\# 新連載作成アシスタント Ver.1



GLOの新連載作成業務（著者登録・書籍登録・カテゴリ登録・サマリー作成・本文テンプレート作成）を補助するWebアプリです。



\## 必要な環境変数



| 変数名 | 内容 |

|---|---|

| `KINTONE\_BASE\_URL` | kintoneのURL（例: https://xxxx.cybozu.com） |

| `KINTONE\_API\_TOKEN` | 「GLO連載情報」アプリのAPIトークン（レコード閲覧権限） |

| `KINTONE\_APP\_ID` | 「GLO連載情報」のアプリID |

| `SHEET\_GAS\_URL` | 「毎月の記事下リンク」GASウェブアプリのURL（https://script.google.com/macros/s/〜/exec） |



※ 共有ドライブの外部共有制限のため、スプレッドシートはGASウェブアプリ経由で取得します。

※ GAS側の doGet は `{ values: \[\[B列, C列], ...] }` 形式のJSONを返すこと。

※ 環境変数の追加・変更後は再デプロイが必要です。

