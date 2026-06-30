# OROCHI System プロジェクト仕様書 (space.md)

## 1. プロジェクト概要
税理士小原司事務所が、無在庫販売システム「ECオロチ」を利用する事業者（顧問先）の月次・年次会計処理を効率的に進捗管理し、データチェックを行うためのWebアプリケーション。

## 2. 技術スタック
- **フレームワーク**: Next.js 14+ (App Router)
- **言語**: TypeScript
- **スタイリング**: Tailwind CSS
- **バックエンド/BaaS**: Firebase (Authentication, Firestore)
- **ホスティング**: 静的エクスポート (`output: 'export'`) による静的サイトホスティング (Firebase Hosting等を想定)

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
│       └── page.tsx       # 顧問先用タスク報告画面 (現在モックアップ)
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
決算月を起点に、期首＝決算月の翌月として各期の対象月を割り振る（5ヶ月・4ヶ月・3ヶ月）。
- 第1期: 期首から5ヶ月
- 第2期: 第3期の直前4ヶ月
- 第3期: 決算月およびその直前2ヶ月（計3ヶ月）

例) 5月決算法人: 第1期=6〜10月 / 第2期=11〜2月 / 第3期=3〜5月。12月決算(個人含む)は従来通り 1〜5 / 6〜9 / 10〜12 月（完全後方互換）。

- 実装関数: `getTermMonths(closingMonth, term)`（`app/dashboard/page.tsx` および `app/dashboard/detail/page.tsx` に各々定義。詳細画面の旧 `TERM_MONTHS` 定数は廃止）。
- 対象年度の表記: `getFiscalYearLabel(closingMonth, year)`。12月決算は「YYYY年度」、それ以外は「YYYY年M月〜YYYY+1年M月」（例: 5月決算→「2025年6月〜2026年5月」）。印刷プレビューの見出し・年間合計表に連動。
- 月次データ(`monthlyData[month]` / `mfData[month]`)は月番号キー方式のため、決算月変更後も非表示月のデータは保持される（非破壊マージ）。

### 売上入力タスク (`no: "6"`, `type: 'sales_input'`) の `details`
- `monthlyData[month][shopKey] = { sales, purchase, fee }`
  - **店舗は動的**。`details.shops = [{ key, name }]` で保持（`key`=不変の保存キー / `name`=表示・編集名）。
  - `details.shops` 未設定時はデフォルト `SHOPS`（`key=name`）を使用するため、旧データ（店舗名キー）と後方互換。
- `otherBusinesses = [{ id, title, monthlyData[month] = { sales, purchase } }]`
  - **ECオロチとは独立した「その他事業」枠**（デフォルト2枠、追加・削除・事業名編集可）。

### 突合タスク (`no: "7"`, `type: 'sales_check'`) の `details`
- `mfData[month] = { sales, purchase }`（マネーフォワード実績。仕入は誤差10%以内で判定）

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

## 6. デプロイ手順（Firebase Hosting）
静的エクスポートを `out/` に生成し、Firebase Hosting へデプロイする。

```bash
npm run build                                   # out/ を生成（output: 'export'）
firebase deploy --only hosting --project orochi-tax-manager
```

- Firebase プロジェクトID: `orochi-tax-manager`
- 公開ディレクトリ: `out`（`firebase.json` の `hosting.public`）
- `.firebaserc` は未コミットのため、デプロイ時は `--project orochi-tax-manager` を明示する。