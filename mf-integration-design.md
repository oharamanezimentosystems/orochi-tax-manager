# MFクラウド（将来freee）連携 詳細設計書 (mf-integration-design.md)

## 0. 前提・関連ドキュメント
- 全体のデータ構造・集計ロジックは `space.md` を参照。本書はその追加分のみ記載する。
- MF Cloud APIとのOAuth連携基盤（Firebase Functions）は、別プロジェクト
  `C:\Users\t_oha\マネーフォワードのMCPテスト` で先行実装済み。
  Firebaseプロジェクトは本アプリと**同一の `orochi-tax-manager`**（Hostingサイト名・
  Functions名のみ `mf-accounting-poc` / `mfAccountingApi` で分離）。
  よってクロスプロジェクト認証は不要で、同じFirestoreに直接読み書きできる。
- 実装は `functions/src/moneyforward.js` の関数群（`getValidAccessToken`,
  `getCurrentOffice`, `fetchTrialBalanceProfitLoss` 等）をベースに拡張する。
  ただし月次売上・仕入の取得は `trial_balance_pl`（累計・単月しか取れない）ではなく、
  月別カラムを一度に返す推移系レポートAPI（`reports/transition_pl` 等）に置き換える。

## 1. 目的
顧問先詳細画面での月次チェック作業（口座連携エラー確認・未仕訳件数の把握・
マイナス残高チェック・MF売上仕入との突合）を、手入力から自動連携に置き換える。
画面を開くだけで最新情報が反映される状態を目指す。将来のfreee連携にも
対応できるよう抽象化しておく。

## 2. 全体アーキテクチャ
- 顧問先詳細画面 (`app/dashboard/detail/page.tsx`) を開いたタイミングで、
  Firebase Functions経由で連携先（MFまたはfreee）から最新データを取得し、
  画面に反映する（**自動・都度取得**。手動ボタンでの取得ではない）。
- プロバイダ抽象化: `AccountingProvider` インターフェースを設け、
  `moneyforwardProvider.js` と（将来）`freeeProvider.js` を実装する。
  `clients/{id}.accountingSystem` の値でFunctions側が実装を切り替える。
  インターフェースはMF固有の用語に寄せず、以下の共通メソッド名にする。
  - `getConnectedAccountsStatus()` — 連携口座のエラー有無
  - `getUnconfirmedTransactionCount(startMonth, endMonth)` — 未仕訳件数
  - `getNegativeBalances()` — マイナス残高一覧（現金／資産／負債の補助科目含む）
  - `getMonthlySalesPurchase(startMonth, endMonth)` — 月次売上・仕入

## 3. 認可・トークン管理
- MFのアクセストークンは「1事業者(office)＝1トークン」に紐づく仕様のため、
  **顧問先ごとに個別のOAuth認可が必要**（1回のログインで複数顧問先はカバーできない）。
- 事務所スタッフが管理画面から顧問先を選び、MFにログイン→認可→事業者名取得→
  OROCHIの `clients` ドキュメントと紐付ける。
- トークン保存先を現行の固定ドキュメント `oauth_tokens/default` から
  **`oauth_tokens/{clientsドキュメントID}`** に変更する（顧問先ごとに分離）。
- リフレッシュトークンで自動更新。失効・認可エラー時は画面に警告表示する
  （「連携エラー確認」の一部として扱う）。

## 4. Firestoreデータ変更
`clients/{id}` に追加:
- `accountingSystem: 'mf' | 'freee' | null`（未設定=従来通りの手入力運用。移行は顧問先ごとに段階的に行う）
- `mfOfficeId` / `mfOfficeName`（連携先事業者情報。表示用・非機密）

`oauth_tokens/{clientsドキュメントID}`（新規コレクション。Functions内部専用、フロントエンドから直接読めないFirestoreルールにする）:
- `access_token`, `refresh_token`, `expires_at`, `provider: 'mf' | 'freee'`

タスクNo.7 (`sales_check`) の `details.mfData` 構造自体は変更なし。書き込み元が
手入力から自動取得に変わる（6章）。

## 5. 画面構成
顧問先詳細画面に「月次チェック」パネルを新設し、表示中の期タブに連動させる:
1. **口座連携エラー**（あれば赤バッジ表示）
2. **未仕訳件数**（★対象期タブの月範囲のみでカウント。`getTermMonths(closingMonth, term)` の
   月配列をそのまま `startMonth`/`endMonth` としてAPIに渡す。6月決算の第1期タブなら
   6〜10月分のみを集計し、翌期分は含めない）
3. **マイナス残高アラート**（現金を最上部・強調表示。資産科目・未払金の補助科目ズレ
   （カード利用と引き落としの補助科目不一致等）も一覧表示）
4. **MF売上・仕入**（6章の通り自動反映）
5. **AI監査 指摘事項**（グレーアウト表示、「今後実装予定」ラベルのみ。今回は
   クリックしても何も起きないプレースホルダー。データ構造は着手時に設計する）

`accountingSystem` が未設定の顧問先は、このパネルごと非表示にし、従来のUIのまま変更しない。

### 5.1 MF連携設定の設置場所
連携設定（顧問先ごとのMF認可・`accountingSystem`/`mfOfficeId`の紐付け）は、
**税理士事務所側の管理ダッシュボード（`app/dashboard/page.tsx`の「顧問先設定モーダル」）
にのみ設置する**。既存の顧問先向け画面（`app/client/page.tsx`）には一切露出させない
（顧問先はMFの認可情報に触れる必要がなく、事務所側が代理で設定する運用のため）。

仕訳内容そのもののチェック（自動仕訳登録・ルールマッチング等）は、既に別の自作ツールで
対応済みのため本アプリでは扱わない（無在庫販売グループでAmazon仕入が仕訳の95%を占める
という業務特性上、そちらのツールに任せる）。

## 6. mfData（突合タスク）の自動化方針 ★仕様変更の核心部分
- **連携済み・未確定の期**：画面を開くたびにMF APIから対象期の月次売上・仕入を自動取得し、
  `mfData` を自動入力・保存する。**手入力欄（数値input）は撤去**し、表示専用にする。
  - 理由：MFの数値が絶対値であり、過去の手入力値は「入力時点のMF画面の転記」に過ぎない。
    MF側で後日仕訳修正が入った場合も、開くたびの自動再取得で反映される。
- **連携済み・確定済みの期（`officeStatus === '承認完了'`）**：**ロックする**。
  自動での上書きは行わず、既存の確定値をそのまま保持する。再取得したい場合のみ、
  明示的な「🔄 最新のMF値を再取得」ボタンを表示し、押した場合のみ上書きする
  （確認ダイアログを挟む）。
  - 判定は既存の `officeStatus`（'未チェック' / 'チェック中' / '承認完了'）を流用する。
    追加のロックフラグは持たない。
- **未連携の顧問先（`accountingSystem` 未設定）**：自動取得ロジックは一切走らない。
  既存の手入力UI・既存データともに変更なし。
- 保存方式：取得のたびに **Firestoreの `mfData` へ上書き保存する**（表示専用のその場計算に
  はしない）。理由：期計パネル・年間合計表・印刷プレビューなど、detail画面外でも
  `mfData` をFirestoreから読む既存ロジックが複数あり、保存経路を変えない方が影響範囲を
  抑えられる。

## 7. 未仕訳件数バッジの月範囲について
`app/dashboard/page.tsx` の一覧表示、および `detail/page.tsx` のタブ切り替えは
`closingMonth` に応じて期ごとの対象月が動的に変わる（`space.md` 4章参照）。
未仕訳バッジもこのロジックに完全に追従させ、**表示中の期タブの対象月のみ**を
カウント範囲としてAPIに渡す。期をまたいだ集計や「全期間の未仕訳件数」は表示しない。

## 8. 段階的移行
- 一気に全顧問先を移行するのではなく、`accountingSystem` を顧問先ごとに個別設定できる
  ことを前提に、連携が完了した顧問先から順次自動化に切り替わる設計とする。
- 既存の手入力データ（過去期間分、および未連携顧問先の全データ）は一切削除・変更しない。

## 9. 付随バグ修正（今回の実装に含める）
`app/dashboard/page.tsx` の「顧問先設定モーダル」で、顧問先名が編集できない不具合がある。
- 383行目: 顧問先名の `<input>` が `disabled` かつ `onChange` 未実装で、常に表示専用になっている。
- `saveSettings()`（112〜128行目）の `updateDoc` 呼び出しにも `name` フィールドが含まれておらず、
  仮に上のinputを直しても保存されない。
- 修正方針: `disabled` を外し `onChange={(e) => setEditingClient({...editingClient, name: e.target.value})}`
  を追加。`saveSettings()` の `updateDoc` に `name: editingClient.name` を追加する。
  ダッシュボード一覧・詳細画面など `client.name` を参照している箇所（`clients` state）は
  既存の `fetchClients`/`setClients` の更新経路で反映されるため、追加対応は不要。

## 10. 実装完了・実データ確認済み（2026-09-05）
本設計書に基づき、`AccountingProvider`の4メソッド（口座連携・未仕訳件数・マイナス残高・
月次売上仕入）を`functions/src/moneyforward.js`に実装し、井上和也様（個人事業主・実データ）
にて実際にMFクラウドと連携して動作確認済み。

- 未仕訳件数: `GET /api/v3/transactions?journalizing_statuses=none`の`metadata.total_count`を
  そのまま採用（取引明細単位）。対象期タブの月範囲(YYYY-MM-DD開始日〜終了日)で正しく絞り込めることを確認。
  実測値: 82件（第2期・6〜9月）。
- マイナス残高: `GET /api/v3/reports/trial_balance_bs`を`with_sub_accounts=true`で取得し、
  全科目・全補助科目のうち`closing_balance`がマイナスの葉ノード(account/sub_account)を抽出する
  方式で実装（カテゴリ絞り込みなし）。実測でカード科目の補助科目マイナス（イオンセレクト(ゴールド) -270円）
  を検出できることを確認。
- 月次売上仕入: `GET /api/v3/reports/transition_pl`（月次推移表）を採用（design doc 0章の方針通り、
  `trial_balance_pl`ではなく推移表APIに変更）。会計年度をMFの`accounting_periods`から対象月ベースで
  自動判定し、暦月⇔MF列番号の変換ロジックで実装。task No.7の`mfData`へ自動反映・自動保存し、
  画面を開くたびに最新値に更新されることを確認。
- 口座連携: `GET /api/v3/connected_accounts`はエラー状態を含まないAPI仕様のため、design doc 5章の
  「エラー有無の確認」は実現不可と判明。件数一覧の表示に留め、認証エラー自体はNo.1タスクの手順に
  従いMFクラウド画面で確認する運用とした（画面上にもその旨を明記）。

### 追加で必要になったOAuthスコープ
上記4機能のうち口座連携・未仕訳件数の取得には、当初の`offices.read report.read`に加えて
`mfc/accounting/connected_account.read`と`mfc/accounting/transaction.read`が必要だった。
`functions/src/config.js`のSCOPEデフォルト値と`.env.orochi-tax-manager`を更新済み。
**この変更以降に新規で顧問先を連携する場合は問題ないが、スコープ変更前に既に連携済みだった
顧問先（井上和也様含む）は再認可が必要**（管理ダッシュボードの顧問先設定モーダルから
「連携し直す（再認可）」を実行するだけでよい）。
