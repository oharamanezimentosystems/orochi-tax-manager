# 顧問先チェック（Claude Code用・MCP版）

顧問先のチェックは、専用の窓口（MCPサーバー `orochi-audit`）で行う。チェックのルール（何を指摘するか・閾値・メールの方針）と、
データの取り方（期の計算・除外の適用・MF/freeeの取得）は、すべて窓口の側に入っている。**この文書を各PCに配る必要はない。**

## 使い方（各PCで1回だけ登録）
Claude Code に窓口を登録する（事務所の合言葉が必要。合言葉は事務所の管理者から聞く）。

```
claude mcp add --transport http orochi-audit https://asia-northeast1-orochi-tax-manager.cloudfunctions.net/orochiAuditMcp --header "x-audit-mcp-key: （合言葉）"
```

登録後は、Claude Code に「顧問先をチェックして」と頼むだけでよい。

## 窓口の機能
| 機能 | 内容 | 書き込み |
|---|---|---|
| `list_clients` | 顧問先一覧、今日の日付、既定の年度 | なし |
| `get_term_check` | 顧問先1社・1期分のチェック材料（期の範囲、承認完了のスキップ判定、タスク入力、売上仕入の突合、MF/freeeの口座連携・未仕訳・マイナス残高、カンニッポの指摘、メール下書きの可否） | なし |
| `get_audit_records` | 除外設定とチェック履歴 | なし |
| `record_check_result` | チェック結果の履歴を残す | `audit_records` の履歴のみ |
| `add_exception` | 除外設定の追加。**事務所の指示があったときだけ** | `audit_records` の除外のみ |

- MF/freeeへの書き込み、`clients` の入力データ（タスク・`mfData`・ステータス）の書き換え、メール送信は、窓口にそもそも無い。
- 窓口は取得専用が中心で、承認完了の期は `recheck` を指示しない限りスキップする。

## 窓口を直したいとき（管理者向け）
- 窓口のコードは、別フォルダ `C:\Users\t_oha\マネーフォワードのMCPテスト\functions\src\auditMcp.js`（Firebase Functions: `orochiAuditMcp`）。
- ルールの文章は同ファイルの `INSTRUCTIONS`、判定の計算は `get_term_check` 周辺。直したら `firebase deploy --only functions:orochiAuditMcp`。
- 合言葉の変更: `firebase functions:secrets:set AUDIT_MCP_KEY` のあと、上の関数を再デプロイし、各PCの登録をやり直す。
- 経緯: 旧版（md配布方式・v1）は、参照ファイルが他のPCに無い等の理由で廃止し、窓口に一本化した（2026-10-06）。
