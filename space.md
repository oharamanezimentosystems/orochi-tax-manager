# OROCHI System プロジェクト仕様書 (space.md)

## 1. プロジェクト概要
税理士小原司事務所が、無在庫販売システム「ECオロチ」を利用する事業者（顧問先）の月次・年次会計処理を効率的に進捗管理し、データチェックを行うためのWebアプリケーション。

## 2. 技術スタック
- **フレームワーク**: Next.js 14+ (App Router)
- **言語**: TypeScript
- **スタイリング**: Tailwind CSS
- **バックエンド/BaaS**: Firebase (Authentication, Firestore)
- **ホスティング**: 静的エクスポート (`output: 'export'`) による静的サイトホスティング (Firebase Hosting等を想定)
- **MFクラウド／freee連携**: 別リポジトリ `C:\Users\t_oha\マネーフォワードのMCPテスト`（Firebase Functions、
  同一Functionsアプリ内でMF・freee両対応）がOAuth・データ取得・仕訳登録を担う。詳細は9章参照。

## 3. ディレクトリ構成
```text
/
├── app/
│   ├── layout.tsx         # ルートレイアウト
│   ├── page.tsx           # 管理者ログイン画面
│   ├── globals.css        # グローバルスタイル・手順書用CSS
│   ├── dashboard/         # 管理者向け機能
│   │   ├── page.tsx       # 進捗管理マトリクス
│   │   ├── detail/page.tsx# 顧問先別タスク管理・数値突合・印刷プレビュー
│   │   └── import/page.tsx# JSONデータインポート機能
│   └── client/            # 顧問先向け機能
│       └── page.tsx       # 顧問先用タスク報告画面（未使用のモックアップ。実際に顧問先へ
│                           # 配布されるURLは `dashboard/detail?id=...` であり、こちらではない）
├── lib/
│   └── firebase.ts        # Firebase初期化設定
├── public/                # 静的リソース (マニュアル用画像等)
└── next.config.ts         # Next.js設定 (output: 'export' 等)
```

## 4. データ構造（Firestore: `clients` コレクション）
顧問先ドキュメント内に、年度・期ごとのタスク配列を保持する。

- `year_{YYYY}_term{1|2|3}_tasks`: その期のタスク配列（`INITIAL_TASKS` をベースにマージ）
- 各タスク `task` の主なフィールド: `no`, `name`, `clientInput`, `officeStatus`, `memo`, `manual`(HTML文字列), `type`

### 法人設定（決算月の動的シフト）
顧問先ドキュメント直下に事業形態の設定を保持する。

- `isCorporate` (boolean): 法人なら `true`、個人事業主または未設定なら `false`。
- `closingMonth` (number): 決算月 (1〜12)。個人/未設定は実質12月決算扱い。
- 設定UI: ダッシュボードの「顧問先設定モーダル」(`app/dashboard/page.tsx`) で個人/法人を切り替え、法人時のみ決算月セレクトを表示。

#### 各期の対象月の動的算出ルール
**重要**: `monthlyData[key]` / `mfData[key]` の保存キーは「期内の位置番号(1〜12)」で固定・不変。第1期=1-5, 第2期=6-9, 第3期=10-12。決算月を変えてもこのキー自体はシフトしない（`app/dashboard/detail/page.tsx` の `getTermMonths(term)`）。
表示ラベル（画面上の「◯月」表記・タブの月範囲・印刷見出し）だけを、決算月をもとに位置番号→暦月へ変換して出す（`getCalendarMonth(closingMonth, position)`）。

- 例) 5月決算法人: 位置1〜5(第1期)は画面上「6月〜10月」、位置6〜9(第2期)は「11月〜2月」、位置10〜12(第3期)は「3月〜5月」と表示されるが、Firestore上の保存キーはあくまで1〜12のまま。
- 12月決算(個人含む)は position=暦月 となり従来通り 1〜5 / 6〜9 / 10〜12 月（完全後方互換）。
- **注意**: 保存キーを暦月に変換して使うと、既存の位置番号ベースの保存データと不整合になり画面上でデータが消えたように見える不具合を過去に起こしたため、保存キーとしては絶対に使わないこと。
- 対象年度の表記: `getFiscalYearLabel(closingMonth, year)`。年度は「決算月(期末)が属する年」を基準とする。12月決算は「YYYY年度」、それ以外は「YYYY-1年M月〜YYYY年M月」（例: 5月決算で2026年度→「2025年6月〜2026年5月」）。印刷プレビューの見出し・年間合計表に連動。
- ダッシュボード一覧（`app/dashboard/page.tsx`）の期間表記のみを担う `getTermMonths(closingMonth, term)` は月次データを参照しないため、暦月を直接返す実装のままで問題ない（detail側とは別実装）。

### 売上入力タスク (`no: "6"`, `type: 'sales_input'`) の `details`
- `monthlyData[month][shopKey] = { sales, purchase, fee }`
  - **店舗は動的**。`details.shops = [{ key, name }]` で保持（`key`=不変の保存キー / `name`=表示・編集名）。
  - `details.shops` 未設定時はデフォルト `SHOPS`（`key=name`）を使用するため、旧データ（店舗名キー）と後方互換。
- `otherBusinesses = [{ id, title, monthlyData[month] = { sales, purchase } }]`
  - **ECオロチとは独立した「その他事業」枠**（デフォルト2枠、追加・削除・事業名編集可）。

### 突合タスク (`no: "7"`, `type: 'sales_check'`) の `details`
- `mfData[month] = { sales, purchase }`（連携先会計ソフトの実績。仕入は誤差10%以内で判定）
- `accountingSystem`が`'mf'`または`'freee'`の顧問先は、この値は手入力ではなく連携先の会計ソフトAPIから
  画面を開くたびに自動取得・自動保存される（詳細は9・10章）。手入力欄は表示しない（読み取り専用表示。
  この読み取り専用判定は`accountingSystem`が`'mf'`／`'freee'`いずれの場合も効くようにすること。
  過去に`'mf'`のみを判定条件にしていたためfreee連携済みの顧問先で手入力欄が表示され続けるバグがあった）。

### 会計システム連携設定（顧問先ドキュメント直下）
- `accountingSystem`: `'mf' | 'freee' | null`。未設定の顧問先は本節の対象外で、従来通り
  タスクNo.7の`mfData`を手入力する。
- `mfOfficeId` / `mfOfficeName`: MFクラウド連携時の事業者ID・事業者名（表示用）。
- `mfConnectedAt`: 連携（認可）完了時刻（epoch ms）。
- これらは`app/dashboard/page.tsx`の「顧問先設定モーダル」の「MFクラウドと連携する」ボタン経由の
  OAuth認可完了時に、Functions側(`マネーフォワードのMCPテスト/functions/src/moneyforward.js`の
  `linkClientToOffice`)が自動的に書き込む。手動で設定する項目ではない。

### 集計ロジック
- ECオロチ期計/年計: `monthlyData` を `Object.values` で全店舗合算。
- **総売上高 = ECオロチ売上合算 + その他事業売上合算**
- **総仕入高 = ECオロチ仕入合算 + その他事業仕入合算**
- 総集計は「期計パネル」「年間合計パネル」「印刷・PDF出力プレビュー（各期＋年間合計表）」のすべてに反映。

## 5. 主な機能（実装済み）
- ダッシュボード（進捗マトリクス） / 顧問先別 詳細・数値突合 / JSONインポート
- クレジットカード仕訳の図解入りマニュアル（No.3。ダークモードでも視認性確保）
- ECオロチ売上の多店舗（複数アカウント）対応 + その他事業 + 総集計
- 印刷・PDF出力プレビュー（期別／年間）
- 法人化対応（決算月に応じた各期対象月の動的シフト。個人事業主＝12月決算で後方互換）
- ダッシュボード一覧の会計連携ステータスバッジ（MF/freee連携済み・未連携を顧問先名の横に表示）
- MFクラウド連携（口座連携状況・未仕訳件数・マイナス残高・月次売上仕入自動反映・
  ルール適用済み未仕訳の一括仕訳登録。詳細は9章）
- freee連携（口座連携状況・マイナス残高・**月次売上仕入自動反映はMFと同等**。未仕訳件数のみ
  非対応。詳細は10章）
- 突合パネル・印刷帳票のUI文言は、MF/freee共通の概念（売上仕入突合・未払金残高確認等）は
  「会計ソフト」という汎用表記に統一し、MF固有の操作手順（画面遷移等）のみ「マネーフォワード」表記を残す
- お客様入力欄の未入力可視化（期タブごとの未入力件数バッジ、テーブル上部の「未入力: N件」サマリーと
  次の未入力へジャンプする機能、未入力セルへの赤バッジ表示）

## 6. デプロイ手順（Firebase Hosting）
静的エクスポートを `out/` に生成し、Firebase Hosting へデプロイする。

```bash
npm run build                                   # out/ を生成（output: 'export'）
firebase deploy --only hosting --project orochi-tax-manager
```

- Firebase プロジェクトID: `orochi-tax-manager`
- 公開ディレクトリ: `out`（`firebase.json` の `hosting.public`）
- `.firebaserc` は未コミットのため、デプロイ時は `--project orochi-tax-manager` を明示する。

## 7. 顧問先名編集（顧問先設定モーダル）
`app/dashboard/page.tsx`の`saveSettings()`は`name`フィールドも含めて`updateDoc`する。
顧問先名の`<input>`も`onChange`で編集可能（過去に`disabled`のまま`onChange`未実装というバグが
あったが修正済み）。

## 8. 設計ドキュメントの関係
- **`space.md`（本ファイル）**: システム全体の「as-built」仕様書。実装済みの内容を常に最新化する。
- **`mf-integration-design.md`**: MFクラウド（将来freee）連携機能の詳細設計書。要件の背景・
  検討過程・未確定事項の記録が目的で、実装完了後も履歴として残す（実装状況は本章9に反映）。

## 9. MFクラウド連携

### 9-1. 全体アーキテクチャ
- 会計データAPIとの通信は、本プロジェクトとは別リポジトリの
  **`C:\Users\t_oha\マネーフォワードのMCPテスト`**（Firebase Functions, Node.js 20, Express）が担う。
  Firebaseプロジェクトは本アプリと同一の`orochi-tax-manager`（Hostingサイト名・Functions名のみ
  `mf-accounting-poc` / `mfAccountingApi`で分離）のため、同じFirestoreに直接読み書きできる
  （クロスプロジェクト認証は不要）。
- 顧問先詳細画面 (`app/dashboard/detail/page.tsx`) を開くと、`accountingSystem === 'mf'`の顧問先は
  自動的にFunctions経由でMFクラウドから最新データを取得する（手動ボタンではなく画面を開くたびに実行）。
  **この画面は事務所・顧問先の両方が同じURLで使う**ため、月次チェックパネル自体は`isAdmin`に
  依存せず表示する（承認完了期のロック解除操作など一部の操作のみ事務所限定）。
- MFのアクセストークンは1事業者(office)に紐づくため、**顧問先ごとに個別のOAuth認可が必要**。

### 9-2. Firestoreデータ
- `clients/{id}.accountingSystem` / `.mfOfficeId` / `.mfOfficeName` / `.mfConnectedAt`（4章参照）
- `oauth_tokens/{clientsドキュメントID}`: 顧問先ごとのアクセストークン・リフレッシュトークン。
  Functions内部専用（フロントエンドから直接読み書きしない）。
- `oauth_state/{state}`: OAuth認可フロー中のCSRF対策用一時ドキュメント（10分で失効・使い捨て）。

### 9-3. 認可（連携設定）
- 連携設定は**税理士事務所側の管理ダッシュボードのみ**で行う（`app/dashboard/page.tsx`の
  「顧問先設定モーダル」）。顧問先向け画面には連携ボタンを一切出さない。
- 手順: 「MFクラウドと連携する」ボタン→MFログイン→事業者選択→権限許可→自動的にダッシュボードへ
  リダイレクトし「連携済み」表示。具体的な手順はモーダル内の「連携手順を見る」に記載済み。
- 認可完了時、Functions側が事業者情報を取得して`clients`ドキュメントへ自動反映する
  （`moneyforward.js`の`linkClientToOffice`）。
- MFC側の要求スコープが変わった場合（機能追加でスコープを追加した場合等）、既存連携先も
  「連携し直す（再認可）」から同じ手順を再実行する必要がある。

### 9-4. 月次チェックパネル（顧問先詳細画面）
`accountingSystem === 'mf'`の顧問先にのみ表示する。表示中の期タブの対象月に連動。

1. **口座連携**: MFのv3 APIには認証エラー状態を返すフィールドが存在しないため、直接のエラー検知は
   不可能。代わりに「自動連携口座ごとの直近1年以内の最新明細取得日」を見て、10日
   （`moneyforward.js`の`STALE_DAYS`）以上新しい明細が来ていない口座を「同期停止の疑いあり」として
   警告表示するヒューリスティックを採用（手動口座は対象外）。
2. **未仕訳件数**: `getTermMonths`の月範囲のみを対象にカウント（期をまたがない）。
3. **マイナス残高**: 残高試算表(BS)から`closing_balance`がマイナスの科目・補助科目を全件抽出
   （現金を最上部に強調表示）。
4. **MF売上・仕入自動反映**: 月次推移表(`reports/transition_pl`)から取得し、タスクNo.7の`mfData`へ
   自動保存する。`officeStatus`が`'承認完了'`の期は自動上書きしない（ロック。事務所のみ「🔄 最新の
   MF値を再取得」ボタンで手動上書き可能）。未確定の期は画面を開くたびに自動上書き・自動保存する。
5. **AI監査 指摘事項**: 「今後実装予定」のプレースホルダーのみ（未実装）。

### 9-5. ルール適用済み未仕訳の一括仕訳登録
MFクラウド自体には未仕訳を一括承認する機能がなく（画面表示分＋30件ずつの手動確認が必要）、
月次作業の大半（無在庫販売グループでは仕訳の95%がAmazon仕入）を占める割に手間がかかるため、
以下のロジックで一括登録機能を実装している。

- 「白（既定科目）」＝連携口座・カードに`GET /api/v3/connected_accounts`の`account_id`/
  `sub_account_id`（既定科目）が設定されている状態、「青（AI推測）」＝未設定の状態、という
  MFクラウド画面の色分けに対応させている。
- 青（AI推測）の場合、MFが実際に何を推測表示しているかはAPIから一切取得できないため、
  **白（既定科目が設定済み）の明細のみ**を自動登録の対象にする。
- フロー: プレビュー取得(`GET /api/rule-matched-transactions`、対象件数・内容を提示)→
  顧問先または事務所スタッフが内容確認→実行(`POST /api/bulk-journalize`、
  `POST /api/v3/transactions/journalize`を明細ごとに呼び出し)→成功/失敗件数を表示。
- 顧問先本人が自分の共有URLから直接実行できることを前提とした機能のため、事務所側の確認画面を
  挟まず実行ボタン＝確定として扱う（サーバー側での追加確認は行わない）。

### 9-6. 認証モデル（重要な設計判断）
MFクラウドAPIの実データを返す`/api/*`エンドポイント（`マネーフォワードのMCPテスト/functions`）は、
Firebase IDトークンによる認証を要求**しない**。理由: 顧問先向け画面は元々ログイン不要（共有URLの
`clientId`自体が秘匿情報）という本アプリの既存の信頼モデルに合わせたもので、顧問先が自分の
共有URLから月次チェックパネル・一括仕訳登録を直接使えるようにするため。
**この結果、`clientId`を知っていれば誰でもこれらのAPI（一括仕訳登録＝実際の会計帳簿への書き込みを
含む）を呼び出せる**ため、共有URLの取り扱いには通常以上の注意が必要（合意済み）。

### 9-7. 必要なOAuthスコープ
`mfc/accounting/offices.read report.read connected_account.read transaction.read journal.write`
（`マネーフォワードのMCPテスト/functions/src/config.js`のSCOPEデフォルト値、`.env.orochi-tax-manager`
と一致させること）。

### 9-8. デプロイ（別リポジトリ）
```bash
cd "C:\Users\t_oha\マネーフォワードのMCPテスト"
firebase deploy --only functions --project orochi-tax-manager   # バックエンド(Functions)
```
フロントエンド側（本プロジェクト）の変更は通常通り6章の手順でデプロイする。両者は独立してデプロイ可能。

## 10. freee連携

同一Functionsアプリ（`マネーフォワードのMCPテスト/functions`）内に、MFと並行してfreee連携を実装済み
（`src/freee.js`）。フロントエンドの月次チェックパネルは`accountingSystem`の値（`'mf' | 'freee'`）で
表示を出し分ける単一実装（`app/dashboard/detail/page.tsx`）。

### 10-1. 【重要】OAuth認可は顧問先ごとに個別に必要（MFと同じ）
設計時点では「freeeのOAuthはアカウント単位なので1回の認可で複数事業所にアクセス可能」と想定していたが、
**実測で誤りと判明**。`GET /api/1/companies`は所属事業所を全件返す（認可スコープと無関係）が、
実際のデータ取得APIは認可時に選んだ1事業所以外を指定すると「この事業所にアクセスする権限がありません」
で拒否される。そのためMFと全く同じく、`stateStore.js`を流用して顧問先ごとに個別のOAuth認可・
個別トークン保存（`oauth_tokens_freee/{clientsドキュメントID}`）を行う。

認可完了時、`resolveAuthorizedCompany()`が「所属事業所一覧の中から実際にAPIアクセスできる1件」を
順に試して自動特定し（`GET /api/1/companies/{id}`を試行し成功した最初の1件）、`clients`ドキュメントへ
自動反映する（MFの`linkClientToOffice`と同じ役割）。事務所スタッフが手動でcompany_idを入力する必要はない。

### 10-2. Firestoreデータ
- `clients/{id}.accountingSystem`(`'freee'`) / `.freeeCompanyId` / `.freeeCompanyName` / `.freeeConnectedAt`
- `oauth_tokens_freee/{clientsドキュメントID}`: 顧問先ごとのアクセストークン・リフレッシュトークン。

### 10-3. アプリ登録・スコープ
- freeeアプリストア（`app.secure.freee.co.jp/developers`）に**税理士小原司事務所自身のfreeeアカウントの
  事業所コンテキストで**登録すること（顧問先の事業所コンテキストで登録すると、その顧問先のアプリに
  なってしまい編集権限エラー「更新権限がありません」が出る。事実、一度誤って水野様の事業所
  コンテキストで作成してしまい、事務所コンテキストに切り替えて作り直した経緯がある）。
- アプリタイプ: パブリックアプリ（顧問先数が将来6事業所以上になりうるため）。
- 金融サービス・銀行明細取得: いずれも「なし」で登録済み（銀行明細＝`wallet_txns`アクセスは審査制で
  承認されるとトークン全失効という重い副作用があるため見送り。詳細は10-5参照）。
- 権限: `[freee会計] 勘定科目`・`事業所情報`・`貸借対照表`・`損益計算書`・`口座`の参照のみ（更新権限は不要）。
- トークンエンドポイントは`application/x-www-form-urlencoded`で呼ぶこと（JSON形式でも通る場合があるが
  未検証。Client Secretは目視でのスクリーンショット書き起こしではなく、DOMから直接コピーして
  Secret Managerへ登録すること。実際に文字の誤読で`invalid_grant`エラーが発生した経緯がある）。

### 10-4. 月次チェックパネル（freee版・MFとの違い）
1. **口座連携**: `GET /api/1/walletables?with_sync_status=true&with_last_synced_at=true`の
   `sync_status`/`last_synced_at`で正式に判定可能（MFのような自前ヒューリスティックは不要）。
   `type === 'wallet'`（現金）は銀行同期の対象外で`sync_status`が常に`unsupported`になる仕様のため、
   異常判定から除外している。
2. **未仕訳件数**: 銀行明細（`wallet_txns`）アクセス権限を申請していないため**取得不可**。
   代わりに「freeeで未処理明細を確認」の外部リンク（`https://secure.freee.co.jp/wallet_txns/stream?registration_status=unreconciled`。
   事業所IDはURLに含めず、freee側で現在ログイン中の事業所に依存するセッションベースの画面のため、
   リンクの下に「対象の事業所に切り替えてから確認してください」の注記を併記している）を
   freee事業所の画面に直接張っている。
   - `walletable_type=credit_card`に絞れば銀行明細取得権限なしでもアクセスできないか検証したが、
     エンドポイント自体が権限でゲートされており（`403 このアプリケーションにはアクセス権限がない
     エンドポイントです`）、クレジットカード限定でも回避不可と判明済み（再検証不要）。
3. **マイナス残高**: 残高試算表(`reports/trial_bs`)から`closing_balance`がマイナスの科目を抽出
   （MFと同じロジック）。
4. **売上・仕入**: `reports/trial_pl`から**月別内訳を算出してMFと同じ形でタスクNo.7の`mfData`へ
   自動反映する**（`freee.js::getMonthlySalesPurchase`。当初「月別内訳は未実装」としていたが実装済み。
   算出方法は10-4a参照）。ロック（`officeStatus === '承認完了'`時は自動上書きしない）もMFと同じ挙動。
5. **AI監査 指摘事項**: MFと共通、プレースホルダーのみ。

### 10-4a. freeeの`trial_pl`パラメータ仕様（実測で確定・重要）
freeeの公式ドキュメントだけでは`fiscal_year`/`start_month`/`end_month`の意味が確定できず、
APIレスポンスのみで判断して「不具合では」と誤診断した経緯があるため、**freeeの実UI
（分析・レポート＞損益レポート、および会計帳簿＞損益計算書（月次）の月次推移表）と突き合わせて
実測確定した仕様**を記録する。

- `end_month`は**暦月そのもの**（1=1月〜12=12月）。会計年度内の位置番号ではない。
- `start_month`を省略し`fiscal_year`と`end_month`だけを指定すると、**その会計年度の真の期首から
  `end_month`までの累計**が返る（`start_month`を指定しても実質無視され、常に真の期首起点になる）。
- 単月（isolatedな1ヶ月）の値が欲しい場合は、対象月が会計年度の初月ならその累計値がそのまま単月値。
  それ以外は「対象月までの累計」－「直前月（会計年度内で時系列的に1つ前の暦月）までの累計」で算出する
  （`fiscalYear`をまたぐ場合の直前月ラップ処理を含め`getMonthlySalesPurchase`に実装済み）。
- 「年度を跨ぐ会計月指定はできません」エラーは、`start_month`→`end_month`が会計年度内で
  時系列的に**逆行**する組み合わせ（例: 期末に近い月→期首に近い月）を指定した場合に発生する。
- 事業所の`company.fiscal_years`（開始日・終了日）から対象月を含む年度を判定し、
  `fiscal_year`＝その年度開始日の西暦年を渡す（`freee.js::resolveFiscalYear`）。

### 10-5. 見送った機能（銀行明細アクセス）
未仕訳の正確な件数取得・MF同様の一括仕訳登録機能には、freeeの「銀行明細取得」権限
（`wallet_txns`アクセス、事前審査制）が必要。以下の理由で現時点では申請を見送っている。
- freeeは自前で一括登録・自動で経理機能を持つため、MFほど自作の価値が高くない。
- 審査には数週間かかる可能性があり、標準審査期間は非公開。
- **承認されると、その時点で発行済みの全アクセストークン・リフレッシュトークンが即時に強制失効する**
  （公式仕様）。つまり後から取得すると、その時点で連携済みの全顧問先に再認可を依頼する必要がある。
- 現在の`/api/*`エンドポイントの認証モデル（clientIdを知っていれば誰でも呼べる。9-6参照）は、
  freeeの審査基準（アクセス権限統制）と相性が悪く、素通りしない可能性が高いと判断した。
必要になった場合は、事前に上記の認証モデルの見直しとセットで検討すること。

## 11. 【重要・事故防止】`tasksReady`ガード（2026-09-05）

### 11-1. 発生した事故
`app/dashboard/detail/page.tsx`で、Firestoreからの保存済みタスク読み込み・マージ
（`loadTasksForTerm`）が完了する前に`saveDataToFirestore`が呼ばれ、まだ空／デフォルト値の
`tasks`（初期状態`useState<any[]>([])`、またはロード中の`baseTasks`）がそのまま保存され、
複数の顧問先（少なくとも1件は既に「完了」提出済みだった期）の入力済みデータが上書き消去される
事故が発生した。Firestoreのバージョン保持（PITR無効・既定1時間の巻き戻ししか効かない）では
発生から1時間以上経過しており復旧不能だった。

主な発火源は、MF/freee連携の月次自動反映処理（`applyMonthlySalesAutoWrite`。9-4/10-4の
自動保存）が、ページ読み込み直後の`tasks`未マージのタイミングで走ったことと推定される
（`tasks`状態が空のまま`setTasks(prevTasks => ...).map()`が実行され、ほぼ空の配列が
`saveDataToFirestore`に渡っていた）。

### 11-2. 対策（実装済み）
- `tasksReady`という状態フラグを追加。初期値`false`、`loadTasksForTerm`が
  Firestoreとのマージ（または新規期の場合はデフォルト値での初期化）を完了した時点で`true`にする。
- `saveDataToFirestore`の先頭で`tasksReady`が`false`なら**即座に保存を中断**するガードを追加
  （呼び出し元を個別に直す方式ではなく、保存処理の単一のチョークポイントで一律に防ぐ設計）。

### 11-3. 今後この仕組みを変更・削除する際の注意
- `saveDataToFirestore`を呼ぶ新しい経路を追加する場合、**必ずこのガードを経由させること**。
  ガードを迂回する独自の保存処理を新設しないこと。
- `loadTasksForTerm`を呼ばずに`tasks`を直接`setTasks`する新しいコードを書かないこと
  （`tasksReady`が実態と食い違い、ガードが無意味になる）。
- 顧問先データの復旧はFirestoreの標準機能では基本的にできない（PITR未使用・既定の
  バージョン保持は1時間のみ）。バックアップ拡張機能・定期エクスポートも現時点で未導入。
  よってこの節のガードが**唯一の防御線**である。安易に外さないこと。