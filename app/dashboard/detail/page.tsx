"use client";

// 【orochi_bridge_design.md §3-1】カンニッポ → OROCHI へ push される AI監査サマリの形。
//  金額・仕訳明細は含まない（label は要約テキストのみ）。severity に "error" は使わない。
type AiAuditFinding = {
  label: string;
  severity: 'info' | 'warn';
  judgmentStatus: 'PENDING' | 'OK' | 'NG';
};
type AiAuditSummary = {
  updatedAt?: number;
  sourceReportDocId?: string | null;
  targetYearMonth?: string | null;
  findings?: AiAuditFinding[];
  cleared?: boolean;
};
// 【§1-2】カンニッポ側の表示ラベルと同一。ここを勝手に変えないこと。
const AI_JUDGMENT_LABEL: Record<string, string> = {
  PENDING: '⚠️未対応',
  OK: '🟢問題なし',
  NG: '❌異常',
};


import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { db, auth } from '../../../lib/firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

// 店舗リスト（デフォルト初期値。実際の店舗はタスクごとに動的に保持する）
const SHOPS = ['Yahoo!', '楽天市場', 'Amazon', 'au PAY', 'Qoo10', 'その他'];

// ★ 要件2: 店舗リストを「固定配列」ではなくタスク単位の動的な {key, name} 配列として扱う。
//   - key: monthlyData の保存キー（不変。リネームしてもデータが移動しない）
//   - name: 画面表示・編集用の店舗名
//   既存データ（店舗名をキーに保存）との互換のため、デフォルトは key=name とする。
const getTaskShops = (task: any): { key: string; name: string }[] => {
  const s = task?.details?.shops;
  if (Array.isArray(s) && s.length > 0) {
    return s.map((x: any) => (typeof x === 'string' ? { key: x, name: x } : { key: x.key, name: x.name }));
  }
  return SHOPS.map((n) => ({ key: n, name: n }));
};

// ★ 要件3: ECオロチとは独立した「その他の事業」枠（最低2枠）。
//   no:"6" タスクの details.otherBusinesses に保持する。
const getOtherBusinesses = (task: any): { id: string; title: string; monthlyData: any }[] => {
  const o = task?.details?.otherBusinesses;
  if (Array.isArray(o) && o.length > 0) return o;
  return [
    { id: 'other1', title: 'その他事業1', monthlyData: {} },
    { id: 'other2', title: 'その他事業2', monthlyData: {} },
  ];
};

// その他事業の指定月合計（全事業の合算）
const calculateOtherMonthly = (businesses: any[], month: number) => {
  let sales = 0, purchase = 0;
  (businesses || []).forEach((b) => {
    const m = b?.monthlyData?.[month];
    if (m) { sales += m.sales || 0; purchase += m.purchase || 0; }
  });
  return { sales, purchase };
};

// ★ 期ごとの対象「月位置」（monthlyData/mfDataの保存キー）
// 決算月に関わらず常に固定。第1期=1-5, 第2期=6-9, 第3期=10-12という「位置番号」でデータは保存されているため、
// ここを決算月で動的に変えると既存データのキーと不一致になり、保存済みデータが表示できなくなる。
const getTermMonths = (term: number): number[] => {
  if (term === 1) return [1, 2, 3, 4, 5];
  if (term === 2) return [6, 7, 8, 9];
  return [10, 11, 12];
};

// ★ 表示専用: 月位置(1-12)を決算月に応じた実際の暦月に変換する（データキーには使わない）
// closingMonth 未設定(個人事業主)は12月決算とみなし、従来通り position=暦月 になる
const getCalendarMonth = (closingMonth: number | undefined, position: number): number => {
  const cm = closingMonth && closingMonth >= 1 && closingMonth <= 12 ? closingMonth : 12;
  const start = (cm % 12) + 1; // 期首月（決算月の翌月）
  return ((start - 1 + (position - 1)) % 12) + 1;
};

// ★ 「お客様入力欄」が未入力かどうかの判定。
// sales_input/sales_check は会計ソフト連携で自動入力されるため対象外（手入力の未入力探しUXとは無関係）。
const isUnfilledManualTask = (task: any): boolean => {
  if (!task) return false;
  if (task.type === 'sales_input' || task.type === 'sales_check') return false;
  return !task.clientInput;
};

// ★ 任意のタスク配列から未入力の手入力タスク件数を数える（期の切替タブのバッジ等に使用）
const countUnfilledManualTasks = (taskList: any[] | undefined | null): number => {
  if (!Array.isArray(taskList)) return 0;
  return taskList.filter(isUnfilledManualTask).length;
};

// ★ 月位置(1-12)と対象年度(year)から、実際の暦年月(calendar year/month)を算出する。
// MFクラウドAPIへの問い合わせ(YYYY-MM形式)に必要。ロジックはgetFiscalYearLabelと同じ基準
// （決算月が属する年をyearとする）に合わせてある。
const getCalendarYearMonth = (closingMonth: number | undefined, year: number, position: number): { year: number; month: number } => {
  const cm = closingMonth && closingMonth >= 1 && closingMonth <= 12 ? closingMonth : 12;
  const month = getCalendarMonth(closingMonth, position);
  if (cm === 12) return { year, month };
  const startMonth = (cm % 12) + 1;
  return { year: month >= startMonth ? year - 1 : year, month };
};

// MFクラウド連携API(マネーフォワードのMCPテスト/functions)のベースURL
const MF_API_BASE = 'https://mf-accounting-poc.web.app';

// 会計システムごとのWeb UIリンク先（クリックで実際の画面を開く用。事業者切替は各サービス側のUIで行う）
const ACCOUNTING_SYSTEM_URLS: Record<string, string> = {
  mf: 'https://biz.moneyforward.com/',
  freee: 'https://secure.freee.co.jp/',
};

// ★ 対象年度の表記。法人(決算月が12月以外)は事業年度の期間を明示する
// 年度は「決算月(期末)が属する年」を基準とする
// 個人/12月決算: "2025年度" / 例:5月決算法人で2026年度: "2025年6月〜2026年5月"
const getFiscalYearLabel = (closingMonth: number | undefined, year: number): string => {
  const cm = closingMonth && closingMonth >= 1 && closingMonth <= 12 ? closingMonth : 12;
  if (cm === 12) return `${year}年度`;
  const startMonth = (cm % 12) + 1; // 期首月（決算月の翌月、前年）
  return `${year - 1}年${startMonth}月〜${year}年${cm}月`;
};

// ★通常タスク (No.1～13)
const INITIAL_TASKS = [
  { 
    no: "1", name: '連携の認証の切れた預金・カードの再認証', clientInput: '', officeStatus: '未',
    manual: `<div class="note"><p><i class="fas fa-exclamation-triangle"></i> <strong>注意：</strong> 再認証を長期間行わないと、明細が取得できなくなり、月次処理に支障が出ます。</p></div><p><strong>手順：</strong></p><ol><li>マネーフォワードのトップページや「口座」メニューから連携口座一覧を表示します。</li><li>エラーが表示されている口座（「要再認証」など）の「<span class="action-target">再認証</span>」または「<span class="action-target">更新</span>」ボタンをクリックします。</li><li>画面の指示に従い、金融機関のサイトでID・パスワード等を入力して再認証を完了させてください。</li></ol>` 
  },
  { 
    no: "2", name: '預金の仕訳登録', clientInput: '', officeStatus: '未',
    manual: `<p>銀行口座から自動で取得された入出金明細（明細一覧）を1件ずつ確認し、それぞれに正しい勘定科目（家賃、水道光熱費、売上など）を割り当てて「仕訳」として登録する作業です。</p><div class="attention"><p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> 入出金明細を放置したり誤った科目で登録したりすると、損益計算書や貸借対照表の数字が実態と合わなくなります。経費の計上漏れがあれば本来より多く税金を払うことになり、決算・確定申告時の集計もやり直しが必要になります。</p></div><p><strong>手順：</strong></p><ol><li>マネーフォワードの「自動で仕訳」メニューから、口座ごとの明細一覧を開きます。</li><li>各明細の内容（摘要）を確認し、該当する勘定科目・補助科目を選択します。</li><li>内容に迷う場合は自己判断で確定せず、事務所へ確認のうえ登録してください。</li><li>「登録」ボタンを押して仕訳として確定します。</li></ol><div class="note"><p><i class="fas fa-lightbulb"></i> <strong>ポイント：</strong> 家賃や光熱費などの定期的な支払いは「自動仕訳ルール」を設定すると、次回以降は自動で正しい科目に振り分けられ効率的です。</p></div>`
  },
  { 
    no: "3", name: 'クレジットカードの仕訳登録', clientInput: '', officeStatus: '未',
    manual: `
      <h3 style="margin-top:0;">マネーフォワード クレジットカード連携・登録時の注意点</h3>

      <div class="attention" style="background-color: #fff1f0; border: 1px solid #ffa39e; border-left: 5px solid #f5222d; padding: 15px; margin-bottom: 20px; border-radius: 4px; color: #333;">
        <h4 style="color: #a8071a; margin-top: 0; font-weight: bold; border: none; padding: 0;">⚠️ 【最重要】未払金残高不一致の防止</h4>
        <p style="font-size: 0.9em; margin-bottom: 10px;">カードを連携させたまま何も設定せずに仕訳を計上すると、1つのカードに複数の補助科目が作られてしまいます。これが残高不一致の最大の原因です。</p>

        <div style="display: flex; align-items: center; gap: 10px; background: #fff; padding: 10px; border-radius: 4px;">
          <div style="flex: 1; text-align: center; border: 1px dashed #ffa39e; padding: 10px; border-radius: 4px;">
             <strong style="color: #f5222d;">❌ 誤った状態</strong><br>
             <span style="font-size: 0.8em; color: #666;">カード利用時：</span> アメックス<br>
             <span style="font-size: 0.8em; color: #666;">預金引落時：</span> アメックス２
          </div>
          <div style="font-size: 1.5em; color: #f5222d;">➡️</div>
          <div style="flex: 1; text-align: center; border: 1px solid #f5222d; padding: 10px; border-radius: 4px; background: #fff1f0;">
             <strong style="color: #a8071a;">💥 残高がズレる！</strong><br>
             <span style="font-size: 0.85em;">アメックス残高： 100円</span><br>
             <span style="font-size: 0.85em; color: red;">アメックス２残高： -100円</span>
          </div>
        </div>
      </div>

      <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">

      <h4>⚙️ 初期設定（連携後に必ず行うこと）</h4>

      <div style="display: flex; gap: 15px; margin-bottom: 20px;">
        <div style="flex: 1; background-color: #f0f5ff; border: 1px solid #adc6ff; padding: 15px; border-radius: 4px; color: #333;">
          <h4 style="color: #1d39c4; font-weight: bold; margin-top: 0; border: none; padding: 0;">1. 補助科目の集約</h4>
          <p style="font-size: 0.85em;">「Amazonマスター」「ポイント」など複数に分かれた科目を1つにまとめます。</p>
          <div style="background: #fff; border: 1px solid #ccc; padding: 8px; font-size: 0.8em; border-radius: 3px; font-family: monospace;">
            [自動で仕訳] ＞ [連携サービスから入力] ＞ [登録済一覧] ＞ [科目設定]
          </div>
        </div>

        <div style="flex: 1; background-color: #f0f5ff; border: 1px solid #adc6ff; padding: 15px; border-radius: 4px; color: #333;">
          <h4 style="color: #1d39c4; font-weight: bold; margin-top: 0; border: none; padding: 0;">2. 名称変更と削除</h4>
          <p style="font-size: 0.85em;">シンプルな名称（例: 三井住友カード）に変更し、不要な科目をゴミ箱で削除します。</p>
          <div style="background: #fff; border: 1px solid #ccc; padding: 8px; font-size: 0.8em; border-radius: 3px; font-family: monospace;">
            [各種設定] ＞ [勘定科目] ＞ 普通預金/未払金 の名称修正
          </div>
        </div>
      </div>

      <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">

      <h4>🔄 預金引き落とし時の注意とルール修正</h4>

      <div class="note" style="background-color: #f6ffed; border: 1px solid #b7eb8f; border-left: 5px solid #52c41a; padding: 15px; margin-bottom: 20px; border-radius: 4px; color: #333;">
        <h4 style="color: #237804; margin-top: 0; font-weight: bold; border: none; padding: 0;">💡 3. 引き落とし時の「補助科目」を一致させる</h4>
        <p style="font-size: 0.9em;">預金から引落とされた際の未払金補助科目を、カード利用時の補助科目と<strong>完全に一致</strong>させます。</p>

        <h4 style="color: #237804; font-weight: bold; margin-top: 15px; border: none; padding: 0;">💡 4. 自動仕訳ルールの修正</h4>
        <p style="font-size: 0.9em; margin-bottom: 5px;">一度間違えると次回も間違ったルールが適用されるため、ルールの修正が必須です。</p>
        <div style="background: #fff; border: 1px solid #b7eb8f; padding: 8px; font-size: 0.85em; border-radius: 3px;">
          [自動で仕訳] ＞ [自動仕訳ルール] ＞ 口座を検索 ＞ 勘定科目を「未払金」、補助科目を「正しい名称」に修正
        </div>
      </div>

      <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">

      <h4>📝 既に誤って計上してしまっている場合</h4>

      <div style="background-color: #fafafa; border: 1px dashed #d9d9d9; padding: 15px; border-radius: 4px; color: #333;">
        <h4 style="font-weight: bold; margin-top: 0; border: none; padding: 0;">5. 仕訳の一括編集と残高確認</h4>
        <ul style="font-size: 0.9em; padding-left: 20px;">
          <li><strong>一括修正：</strong> [会計帳簿] ＞ [仕訳帳] ＞ [一括編集] にて、誤った補助科目を検索し正しいものに一括変更します。</li>
          <li><strong>最終確認：</strong> [会計帳簿] ＞ [残高試算表(貸借対照表)] にて、不要な科目が残っていないか、マイナス残高がないか確認します。</li>
        </ul>
      </div>
    `
  },
  { 
    no: "3(2)", name: '仕訳取り込みツールにてクレジットカード取り込み', clientInput: '', officeStatus: '未',
    manual: `<p>クレジットカード会社からダウンロードした利用明細のCSVファイルを、専用のCSV変換ツールで会計ソフトの仕訳フォーマットに変換し、まとめてマネーフォワードに取り込む作業です。</p><div class="note"><p><i class="fas fa-lightbulb"></i> <strong>なぜこの手順があるか：</strong> カードの利用件数が多い場合、1件ずつ手入力すると時間がかかるうえ入力ミスも発生しやすくなります。CSV一括取り込みを使うことで、件数が多くても正確かつ短時間で仕訳を登録できます。</p></div><p><strong>おおまかな流れ：</strong></p><ol><li>カード会社の会員サイトから、対象期間の利用明細CSVをダウンロードします。</li><li>専用のCSV変換ツールに読み込ませ、会計ソフト取り込み用の形式に変換します。</li><li>変換後のファイルをマネーフォワードの仕訳データ取り込み機能からアップロードします。</li><li>取り込み後は仕訳帳を開き、件数・金額に誤りがないか必ず確認してください。</li></ol><div class="attention"><p><i class="fas fa-exclamation-triangle"></i> <strong>注意：</strong> 取り込み後の科目や金額が誤っていると、未払金や経費の残高がずれる原因になります。取り込み後は必ず内容を確認してください。</p></div>`
  },
  { 
    no: "4", name: '現金の仕訳登録', clientInput: '', officeStatus: '未',
    manual: `<p>クレジットカードや銀行口座の明細には出てこない、現金で支払った経費（電車賃、消耗品の現金購入、来客用のお茶代など）を、手元の領収書・レシートを見ながら会計ソフトに入力する作業です。</p><div class="attention"><p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> 現金払いの経費は自動連携されないため、入力を忘れるとその分の経費が計上されず、本来より多く税金を払うことになります。また、現金の帳簿上の残高と実際の手元現金が合わなくなる原因にもなります。</p></div><p><strong>手順：</strong></p><ol><li>手元の領収書・レシートを日付順に並べます。</li><li>マネーフォワードの「振替伝票」など現金取引の入力画面を開きます。</li><li>日付・金額・内容を確認し、該当する勘定科目（旅費交通費、消耗品費など）と「現金」で仕訳を1件ずつ登録します。</li><li>入力済みの領収書は、電子帳簿保存法対応のため、後で見返せるよう保管しておいてください。</li></ol>`
  },
  { 
    no: "5", name: '各ECサイトからの入金明細、出店料の明細をダウンロードして保管', clientInput: '', officeStatus: '未',
    manual: `<p>各ECサイトの管理画面から、当月分の明細をダウンロードし、<strong>Googleドライブ</strong>の指定フォルダに保管してください。</p><p>各サイトの明細の見方は以下を参照してください。</p><div class="visual-aid-container"><h4 style="margin-top:0;">Yahoo!ショッピング明細の例</h4><img src="/images/manual/yahoo_sample.png" alt="Yahoo明細見本" style="max-width:100%; border:1px solid #ddd; margin-bottom:15px;"><h4 style="margin-top:0;">楽天市場明細の例</h4><img src="/images/manual/rakuten_sample.png" alt="楽天明細見本" style="max-width:100%; border:1px solid #ddd;"></div>`
  },
  { 
    no: "6", name: 'ECオロチから「売上仕入」シートに入力（売上・仕入・手数料）', clientInput: '', officeStatus: '未',
    type: 'sales_input',
    details: { monthlyData: {} },
    manual: `<p>ECオロチの集計データを店舗ごとに入力してください。</p><div class="note"><p><strong><i class="fas fa-calculator"></i> 手数料の考え方（決算整理時）</strong></p><p>ECオロチの手数料は「理論値」であり、実際のキャンペーン割引等は反映されていません。</p><p>そのため、決算時の仕訳では、以下の計算式で手数料を算出することを推奨します（逆算アプローチ）。</p><code class="code-like">実際の手数料 = ECオロチ売上(総額) - 会計ソフト入金額(純額)</code><p>※これにより、割引適用後の「正しい経費」が自動的に計上されます。</p></div>`
  },
  { 
    no: "7", name: '売上仕入集計と会計ソフト損益計算書の比較確認（仕入差異チェック）', clientInput: '', officeStatus: '未',
    type: 'sales_check',
    details: { mfData: {} },
    manual: `<div class="attention"><p><strong><i class="fas fa-balance-scale"></i> 判定基準とロジック</strong></p><ul><li><strong>仕入（Purchases）：</strong> <span style="color:red;">重要チェック項目</span>です。クレカ連携ズレは数日程度のため、<strong>誤差10%以内</strong>であることを確認します。</li><li><strong>売上・手数料（Sales）：</strong> 入金サイクル（約2週間）のズレにより、単月では一致しません。</li></ul></div><div class="visual-aid-container" style="text-align:left;"><h4>手数料の差異について（理論値 vs 実数値）</h4><p>ECオロチの手数料（理論値）より、実際の入金から計算した手数料が<strong>安い（入金が多い）場合</strong>は、キャンペーン割引等の「有利差異」であるため、<strong>問題ありません。</strong></p><p>逆に、理論値よりも手数料が著しく高い（入金が少なすぎる）場合は、以下の原因を確認してください。</p><ul><li>返金・キャンセル処理の反映漏れ</li><li>その他、予期せぬペナルティや調整金の発生</li></ul></div>`
  },
  { 
    no: "8", name: '会計ソフト未払金残高の過少・過大確認（マイナス残高等）', clientInput: '', officeStatus: '未',
    manual: `<p>会計ソフト（貸借対照表）に計上されている「未払金」（クレジットカードで利用したがまだ引き落とされていない金額）の残高が、実態に対して少なすぎたり多すぎたりしていないかを確認する作業です。</p><div class="attention"><p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> タスクNo.3で触れた補助科目のズレなどが原因で、未払金がマイナス残高になったり、実際のカード利用状況とかけ離れた金額になっていることがあります。放置すると決算書の負債の金額が誤ったまま確定申告に反映されてしまいます。</p></div><p><strong>手順：</strong></p><ol><li>マネーフォワードの「会計帳簿」＞「残高試算表（貸借対照表）」を開きます。</li><li>「未払金」の行、および各カードの補助科目ごとの内訳を確認します。</li><li>マイナス残高になっている補助科目や、実際のカード利用状況から見て明らかに金額が合わない補助科目がないか確認します。</li><li>おかしい場合は、該当する仕訳を仕訳帳で検索し、科目や金額の誤りを修正します。</li></ol>`
  },
  { 
    no: "9", name: 'Amazon使用履歴のExcelダウンロード保管', clientInput: '', officeStatus: '未',
    manual: `
      <p>Amazonの「注文履歴レポート」をダウンロードしてください。</p>
      <div class="note">
        <p><strong><i class="fas fa-info-circle"></i> ダウンロードが困難な場合</strong></p>
        <p>データ容量の都合やエラー等でダウンロードができない場合は、税務調査があった際に即座に<strong>「マイアカウント」の注文履歴画面</strong>を提示できるよう、ID・パスワードの管理を徹底してください。</p>
      </div>
    `
  },
  { 
    no: "10", name: 'Amazon領収書一括ダウンロード保管', clientInput: '', officeStatus: '未',
    manual: `
      <p>電子帳簿保存法対応のため、領収書データを保存してください。</p>
      <div class="note">
        <p><strong><i class="fas fa-info-circle"></i> 一括取得が困難な場合</strong></p>
        <p>ツールが使えない場合などは、上記No.9と同様に、<strong>必要な時にいつでも管理画面から領収書を表示・印刷できる状態</strong>にしておくことで代替とします。</p>
      </div>
    `
  },
  { 
    no: "11", name: '自動連携カードの私用Amazon利用分の金額記入', clientInput: '', officeStatus: '未',
    manual: `<p>事業用のクレジットカードで、事業に関係のない個人的な買い物（家族の日用品など）をAmazonで行った場合、その合計金額をこの欄に入力してください。</p><div class="attention"><p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> 事業用カードの利用額はそのままでは全額「経費」として会計ソフトに取り込まれます。プライベートな購入分を除外しないと経費が本来より過大になり、税務調査で個人的な支出を経費に混ぜていると指摘される可能性があります。</p></div><p><strong>確認方法：</strong></p><ol><li>Amazonの「注文履歴」を開き、対象月の注文を確認します。</li><li>事業に関係のない商品（プライベート利用の商品）を洗い出し、その金額を合計します。</li><li>合計金額をこのタスクの入力欄に記入してください。</li></ol><div class="note"><p><i class="fas fa-lightbulb"></i> <strong>ポイント：</strong> 迷う商品がある場合は、自己判断せずに事務所へご相談ください。この金額は、タスクNo.25の決算整理仕訳で「事業主貸」などの科目に振り替える処理に使用します。</p></div>`
  },
  { 
    no: "12", name: '仕入時Amazonポイントの私用使用分の金額記入', clientInput: '', officeStatus: '未',
    manual: `<div class="attention"><p>事業の仕入等で貯まったAmazonポイントを、家族の買い物など個人的な用途で使用した場合、その使用したポイント分の金額をこの欄に入力してください。</p></div><div class="note"><p><i class="fas fa-lightbulb"></i> <strong>なぜ重要か：</strong> 事業のポイントは本来、事業の資産です。それを個人的に使うと、その分だけ事業から個人へ利益が移転したことになります。入力を忘れると、タスクNo.25の決算整理仕訳で正しく「雑収入」として計上できず、申告漏れの原因になります。</p></div><p><strong>確認方法：</strong></p><ol><li>Amazonの「ポイント履歴」画面で、対象月に私用の買い物へ使用したポイント数（金額換算）を確認します。</li><li>その金額をこのタスクの入力欄に記入してください。</li></ol>`
  },
  { 
    no: "13", name: 'その月特異事項（高額な購入、契約変更など）', clientInput: '', officeStatus: '未',
    type: 'textarea',
    manual: `
      <p>通常の仕入以外で、メモしておきたい事項があれば入力してください。</p>
      <p>例：</p>
      <ul>
        <li>3/16 パソコン購入 (141,955円)</li>
        <li>10/1 ○○システム前払金 (1年分)</li>
        <li>事務所移転、家賃変更など</li>
      </ul>
    `
  },
];

// ★確定申告（第3期）専用タスク
const TAX_RETURN_TASKS = [
  { 
    no: "14", name: '[書類] 確定申告・控除関係書類のアップロード', clientInput: '', officeStatus: '未',
    manual: `
      <p>以下の書類が該当する場合は、写真またはPDFでGoogleドライブへアップロードしてください。</p>
      <ul style="list-style: none; padding: 0;">
        <li>✅ <strong>源泉徴収票</strong>（給与所得がある方）</li>
        <li>✅ <strong>国民健康保険・国民年金</strong> 控除証明書</li>
        <li>✅ <strong>生命保険・地震保険</strong> 控除証明書</li>
        <li>✅ <strong>ふるさと納税</strong> 寄付金受領証（またはXMLデータ）</li>
        <li>✅ <strong>小規模企業共済</strong> 掛金払込証明書</li>
        <li>✅ <strong>特定口座年間取引報告書</strong>（株・投資信託等）</li>
        <li>✅ その他、不動産売買や住宅ローン控除等の書類</li>
      </ul>
    `
  },
  { 
    no: "15", name: '[書類] 12月末時点の残高証憑の保存', clientInput: '', officeStatus: '未',
    manual: `
      <p>12月31日時点の残高がわかる資料を保存してください。</p>
      <ul>
        <li><strong>預金通帳：</strong> 12/31の残高が記載されているページのコピー</li>
        <li><strong>ネットバンキング：</strong> 12/31時点の残高証明または明細画面のスクショ</li>
        <li><strong>各ECモール：</strong> 12/31時点で「入金待ち（未入金）」となっている残高がわかる管理画面のコピー</li>
      </ul>
    `
  },
  { 
    no: "16", name: '[Yahoo!] 12月売上（翌年入金分）の計上・明細保存', clientInput: '', officeStatus: '未',
    manual: `
      <p>Yahoo!ショッピングの12月売上（翌年1月以降に入金される分）を売掛金として計上する必要があります。</p>
      <img src="/images/manual/yahoo_sample.png" alt="Yahoo明細見本" style="max-width:100%; border:1px solid #ddd; margin:10px 0;">
      <div class="attention">
        <p><strong><i class="fas fa-exclamation-circle"></i> 二重計上注意</strong></p>
        <p>画像赤枠の「合計」のうち、<strong>12/31時点で未入金のものだけ</strong>を計上してください。</p>
      </div>
    `
  },
  { 
    no: "17", name: '[楽天市場] 年末締めの未払・売掛計上処理', clientInput: '', officeStatus: '未',
    manual: `
      <div class="attention">
        <p><strong><i class="fas fa-exclamation-circle"></i> 25日締めのため調整が必要です</strong></p>
        <p>ここでも、<strong>既に計上済みのもの（12/25以前の売上など）を二重計上しないよう</strong>ご注意ください。</p>
      </div>
      <p><strong>手順1：販売手数料の未払計上</strong></p>
      <ul>
        <li>翌年1月10日締め分の請求書を用意します。</li>
        <li>請求合計金額を<strong>「12/31　販売手数料 / 買掛金」</strong>として計上します。</li>
      </ul>
      <p><strong>手順2：年末売上の売掛計上</strong></p>
      <ul>
        <li>ECオロチの売上分析で<strong>「12/26 ～ 12/31」</strong>を表示・印刷します。</li>
        <li>その売上合計を<strong>「12/31　売掛金 / 売上高」</strong>として計上します。</li>
      </ul>
    `
  },
  { 
    no: "18", name: '[au Wowma!] 12月売上（翌年入金分）の計上', clientInput: '', officeStatus: '未',
    manual: `
      <p>au PAY マーケットの12月売上（未入金分）を計上します。</p>
      <img src="/images/manual/au_sample.png" alt="au明細見本" style="max-width:100%; border:1px solid #ddd; margin:10px 0;">
      <div class="note">
        <p><strong>GMOペイメント明細について：</strong> GMOペイメントの明細はau PAYに含まれているため、重複して計上しないようご注意ください。</p>
      </div>
      <div class="attention">
        <p><strong><i class="fas fa-exclamation-circle"></i> 二重計上注意</strong></p>
        <p>12月末時点で入金済みの売上は対象外です。</p>
      </div>
    `
  },
  { 
    no: "19", name: '[Qoo10] 12月売上（翌年入金分）の計上', clientInput: '', officeStatus: '未',
    manual: `
      <p>Qoo10の12月売上（未入金分）および販売手数料を計上してください。</p>
      <img src="/images/manual/qoo10_sample.png" alt="Qoo10明細見本" style="max-width:100%; border:1px solid #ddd; margin:10px 0;">
      <div class="attention">
        <p><strong><i class="fas fa-exclamation-circle"></i> 二重計上注意</strong></p>
        <p>12月末時点で入金済みの売上は対象外です。</p>
      </div>
    `
  },
  { 
    no: "20", name: '[決算] 売上・仕入の最終突合', clientInput: '', officeStatus: '未',
    manual: `<p>月次で行っていたタスクNo.7の売上・仕入突合チェックを、決算にあたって年間（1年分）の合計値で改めて確認する作業です。</p><div class="attention"><p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> 月次のチェックで見逃していた小さなズレも、年間で積み重なると大きな金額の差異になっている場合があります。決算・確定申告の数字を確定する前の最後の確認ポイントです。</p></div><p><strong>手順：</strong></p><ol><li>ECオロチの年間売上・仕入集計を出力します。</li><li>マネーフォワードの年間の損益計算書（売上高・仕入高）を確認します。</li><li>タスクNo.7と同じ判定基準（仕入は誤差10%以内が目安）で、大きな乖離がないか確認します。</li><li>乖離が大きい場合は、どの月に原因があるか月別に遡って確認してください。</li></ol>`
  },
  { 
    no: "21", name: '[決算] 預金残高の一致確認（MF vs 通帳）', clientInput: '', officeStatus: '未',
    manual: `
      <p>マネーフォワードの「残高試算表」に表示される12/31時点の預金残高が、実際の通帳（またはネットバンキング）の残高と1円単位で一致しているか確認してください。</p>
      <div class="attention">
        <p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> 決算書の預金残高は通帳と完全に一致している必要があります。ズレたまま申告すると、税務調査で仕訳の計上漏れやミスを指摘される原因になります。</p>
      </div>
      <p><strong>手順：</strong></p>
      <ol>
        <li>マネーフォワードの「会計帳簿」＞「残高試算表（貸借対照表）」で、対象口座の12/31時点残高を確認します。</li>
        <li>通帳の記帳、またはネットバンキングの12/31時点残高を確認します。</li>
        <li>両者を突き合わせ、金額が一致しているか確認します。</li>
      </ol>
      <p>一致していない場合、利息の計上漏れや、日付のズレ（未達・未記帳の入出金）がないか確認してください。</p>
    `
  },
  { 
    no: "22", name: '[決算] 未払金残高の一致確認（カード利用分）', clientInput: '', officeStatus: '未',
    manual: `
      <p>マネーフォワードの「未払金」残高が、<strong>翌年1月・2月引き落とし予定額の合計（※12月利用分まで）</strong>と一致しているか確認してください。</p>
      <div class="attention">
        <p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> 未払金は「12月末までにカードで使ったが、まだ引き落とされていない金額」を表す負債です。ここがズレていると、決算書の負債の金額が実態と合わず、正しい利益・税額が計算できません。</p>
      </div>
      <p><strong>手順：</strong></p>
      <ol>
        <li>各クレジットカードの会員サイトで、翌年1月・2月の引き落とし予定明細を確認します。</li>
        <li>その中から「12月利用分まで」の金額を合計します（翌年1月の利用分など、翌年に使った分は含めません）。</li>
        <li>マネーフォワードの残高試算表で「未払金」（カードごとの補助科目）の残高と突き合わせます。</li>
        <li>一致しない場合は、タスクNo.3・No.8の内容を参考に、仕訳の科目や金額のズレを確認してください。</li>
      </ol>
    `
  },
  { 
    no: "23", name: '[決算] 売掛金残高の一致確認（売上入金待ち）', clientInput: '', officeStatus: '未',
    manual: `
      <p>マネーフォワードの「売掛金」残高が、上記No.16～19で計上した「年末売上（未入金分）」の合計と一致しているか確認してください。</p>
      <div class="attention">
        <p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> 売掛金は「12月末までに売上は発生しているが、まだ入金されていない金額」を表す資産です。ここがズレていると、売上の計上漏れ・二重計上のいずれかが起きている可能性があります。</p>
      </div>
      <p><strong>手順：</strong></p>
      <ol>
        <li>タスクNo.16～19でそれぞれ計上した「年末売上（未入金分）」の金額を合計します。</li>
        <li>マネーフォワードの残高試算表で「売掛金」の残高を確認します。</li>
        <li>両者を突き合わせ、一致しているか確認します。</li>
        <li>一致しない場合は、いずれかのモールで計上漏れ・二重計上がないか、No.16～19の仕訳を再確認してください。</li>
      </ol>
    `
  },
  { 
    no: "24", name: '[決算] マイナス残高の確認・修正', clientInput: '', officeStatus: '未',
    manual: `
      <p>残高試算表（貸借対照表）を見て、残高がマイナスになっている科目（△表示）がないか確認してください。</p>
      <div class="attention">
        <p><i class="fas fa-exclamation-triangle"></i> <strong>なぜ重要か：</strong> 資産や負債の科目が通常あり得ないマイナス残高になっている場合、仕訳ミスや計上漏れの可能性が高いです。そのまま申告すると決算書の信頼性が損なわれ、税務調査で指摘される原因になります。</p>
      </div>
      <p><strong>手順：</strong></p>
      <ol>
        <li>マネーフォワードの「会計帳簿」＞「残高試算表（貸借対照表）」を開きます。</li>
        <li>各科目（特に未払金・売掛金・預金など）の残高に「△」（マイナス）表示がないか確認します。</li>
        <li>マイナスになっている科目があれば、該当する仕訳を仕訳帳で検索し、内容を確認します。</li>
        <li>自力で原因が分からない場合は、事務所へご相談ください。</li>
      </ol>
    `
  },
  { 
    no: "25", name: '[決算] 決算整理仕訳（家事按分・ポイント等）', clientInput: '', officeStatus: '未',
    manual: `
      <p>振替伝票にて、以下の決算仕訳を計上してください（仕訳辞書の「決算仕訳」を利用）。</p>
      <ul>
        <li><strong>家事按分：</strong> 自宅家賃、電気代、スマホ代などのうち、プライベート相当額を「事業主貸」へ振り替え。</li>
        <li><strong>ポイント収入：</strong> カードやAmazonポイントの私用利用分を「雑収入」として計上。</li>
      </ul>
    `
  },
];

function DetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const clientId = searchParams.get('id');
  const urlYear = searchParams.get('year');

  const [currentYear, setCurrentYear] = useState(() => {
    if (urlYear) return parseInt(urlYear);
    const today = new Date();
    const currentMonth = today.getMonth() + 1; // 1-12
    const currentFullYear = today.getFullYear();
    if (currentMonth <= 3) return currentFullYear - 1;
    return currentFullYear;
  });

  const [activeTerm, setActiveTerm] = useState(() => {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    if (currentMonth <= 3) return 3;
    if (currentMonth <= 5) return 1;
    if (currentMonth <= 9) return 2;
    return 3;
  });

  const [clientName, setClientName] = useState('');
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | 'changed'>('saved');
  const [fullData, setFullData] = useState<any>(null);
  // 【orochi_bridge_design.md §3-1/§3-4】カンニッポから push された AI監査サマリ（表示専用）。
  //  この画面は書き込まない。判定の正本はカンニッポ側 auditReports の userStatus。
  const aiAuditSummary: AiAuditSummary | null = fullData?.aiAuditSummary || null;
  const [isAdmin, setIsAdmin] = useState(false);
  const [openManualId, setOpenManualId] = useState<number | null>(null);
  const [openInputId, setOpenInputId] = useState<number | null>(null);
  
  const [clientStatus, setClientStatus] = useState<'未着手' | '進行中' | '完了'>('未着手');

  // ★ 重要: Firestoreからの保存済みタスクの読み込み・マージが完了するまでtrueにしない。
  // これがfalseの間にsaveDataToFirestoreを呼ぶと、まだ空のtasks(初期値[])やロード中の
  // デフォルト値がそのまま保存され、既存の顧客入力を全て上書き消去してしまう事故につながる
  // （実際に複数の顧問先でこの事故が発生したことが判明したため、安全装置として追加）。
  const [tasksReady, setTasksReady] = useState(false);
  
  // 印刷用ステート
  const [printTarget, setPrintTarget] = useState<'1' | '2' | '3' | 'yearly' | null>(null);

  // ★ デバッグ用: Firestoreの生データをその場で確認するための一時表示
  const [showDebug, setShowDebug] = useState(false);

  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ★ 未入力の手入力タスクへジャンプするための行参照とインデックス一覧
  const taskRowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});
  const unfilledTaskIndices = tasks.reduce<number[]>((acc, t, i) => {
    if (isUnfilledManualTask(t)) acc.push(i);
    return acc;
  }, []);
  const [jumpCursor, setJumpCursor] = useState(0);

  const jumpToUnfilledTask = () => {
    if (unfilledTaskIndices.length === 0) return;
    const idx = unfilledTaskIndices[jumpCursor % unfilledTaskIndices.length];
    const el = taskRowRefs.current[idx];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prevBg = el.style.backgroundColor;
      const prevTransition = el.style.transition;
      el.style.transition = 'background-color 0.3s ease';
      el.style.backgroundColor = 'rgba(234, 179, 8, 0.25)';
      window.setTimeout(() => {
        el.style.backgroundColor = prevBg;
        window.setTimeout(() => { el.style.transition = prevTransition; }, 350);
      }, 1200);
    }
    setJumpCursor((c) => (c + 1) % unfilledTaskIndices.length);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setIsAdmin(!!user);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const fetchClientData = async () => {
      if (!clientId) return;
      try {
        const docRef = doc(db, "clients", clientId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          const data = docSnap.data();
          setFullData(data);
          setClientName(data.name);
          loadTasksForTerm(data, activeTerm, currentYear);
        } else {
          if(isAdmin) router.push('/dashboard');
        }
      } catch (error) {
        console.error("エラー:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchClientData();
  }, [clientId, router, isAdmin, currentYear]);

  useEffect(() => {
    if (fullData) {
        loadTasksForTerm(fullData, activeTerm, currentYear);
    }
  }, [currentYear]);

  // ★ 会計連携（MF/freee共通）: 月次チェックパネル用データ
  const [mfPanel, setMfPanel] = useState<{
    loading: boolean;
    error: string | null;
    connectedAccounts: { id: string; name: string; isManual: boolean; lastTransactionDate: string | null; stale: boolean; syncStatus?: string | null }[];
    unconfirmedCount: number | null;
    negativeBalances: { name: string; amount: number; type: string }[];
    monthlySales: Record<string, { sales: number; purchase: number }>;
  }>({ loading: false, error: null, connectedAccounts: [], unconfirmedCount: null, negativeBalances: [], monthlySales: {} });

  const termOfficeStatus: string = fullData?.[`year_${currentYear}`]?.[`term${activeTerm}`]?.officeStatus || '未チェック';
  // 顧問先本人が自分の未仕訳を一括登録できるよう、このパネル自体は管理者・顧問先の両方に表示する
  // （個別のロック解除操作など事務所限定の操作は isAdmin で別途ガードする）。
  const accountingSystem: 'mf' | 'freee' | null = fullData?.accountingSystem || null;
  const isMfLinked = accountingSystem === 'mf';
  const isFreeeLinked = accountingSystem === 'freee';
  const isAccountingLinked = isMfLinked || isFreeeLinked;

  // 表示中の期タブの対象月を実際の暦年月(YYYY-MM)に変換
  const getActiveTermCalendarMonths = () => {
    const positions = getTermMonths(activeTerm);
    return positions.map(p => getCalendarYearMonth(fullData?.closingMonth, currentYear, p));
  };

  // 表示中の期タブの対象月範囲を startDate/endDate(YYYY-MM-DD) に変換
  const getActiveTermDateRange = () => {
    const ym = getActiveTermCalendarMonths();
    const sorted = [...ym].sort((a, b) => (a.year - b.year) || (a.month - b.month));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const lastDay = new Date(last.year, last.month, 0).getDate();
    return {
      startDate: `${first.year}-${String(first.month).padStart(2, '0')}-01`,
      endDate: `${last.year}-${String(last.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  };

  const fetchMfPanelData = async (overwriteMfData: boolean) => {
    if (!clientId || !fullData) return;
    const provider = fullData.accountingSystem;
    if (provider !== 'mf' && provider !== 'freee') return;
    setMfPanel(prev => ({ ...prev, loading: true, error: null }));
    try {
      const ym = getActiveTermCalendarMonths();
      const sorted = [...ym].sort((a, b) => (a.year - b.year) || (a.month - b.month));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const lastDay = new Date(last.year, last.month, 0).getDate();
      const startDate = `${first.year}-${String(first.month).padStart(2, '0')}-01`;
      const endDate = `${last.year}-${String(last.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const monthsParam = ym.map(m => `${m.year}-${String(m.month).padStart(2, '0')}`).join(',');

      // 各エンドポイントは独立して成否を扱う。1つが失敗(スコープ不足等)しても
      // 他の取得済みデータまで消さない。
      const fetchJson = async (url: string) => {
        const res = await fetch(url);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `取得に失敗しました(${res.status})`);
        return body;
      };

      // 位置(position)キーに変換してtask No.7 details.mfDataへ自動反映・自動保存する。
      // MF・freeeいずれも{'YYYY-MM': {sales, purchase}}形式で返るため共通化している。
      const applyMonthlySalesAutoWrite = (salesData: Record<string, { sales: number; purchase: number }>) => {
        setTasks(prevTasks => {
          const nextTasks = prevTasks.map((t: any) => {
            if (t.no !== '7') return t;
            const nextMfData: any = { ...(t.details?.mfData || {}) };
            getTermMonths(activeTerm).forEach((position, idx) => {
              const key = `${ym[idx].year}-${String(ym[idx].month).padStart(2, '0')}`;
              const fetched = salesData[key];
              if (fetched) nextMfData[position] = { sales: fetched.sales, purchase: fetched.purchase };
            });
            return { ...t, details: { ...t.details, mfData: nextMfData } };
          });
          saveDataToFirestore(nextTasks, activeTerm, currentYear);
          return nextTasks;
        });
      };

      if (provider === 'mf') {
        const [accResult, unResult, negResult, salesResult] = await Promise.allSettled([
          fetchJson(`${MF_API_BASE}/api/connected-accounts?clientId=${clientId}`),
          fetchJson(`${MF_API_BASE}/api/unconfirmed-count?clientId=${clientId}&startDate=${startDate}&endDate=${endDate}`),
          fetchJson(`${MF_API_BASE}/api/negative-balances?clientId=${clientId}`),
          fetchJson(`${MF_API_BASE}/api/monthly-sales-purchase?clientId=${clientId}&months=${monthsParam}`),
        ]);

        const errors: string[] = [];
        if (accResult.status === 'rejected') errors.push(`口座連携: ${accResult.reason.message}`);
        if (unResult.status === 'rejected') errors.push(`未仕訳件数: ${unResult.reason.message}`);
        if (negResult.status === 'rejected') errors.push(`マイナス残高: ${negResult.reason.message}`);
        if (salesResult.status === 'rejected') errors.push(`MF売上仕入: ${salesResult.reason.message}`);

        setMfPanel({
          loading: false,
          error: errors.length > 0 ? errors.join(' / ') : null,
          connectedAccounts: accResult.status === 'fulfilled' ? (accResult.value.accounts || []) : [],
          unconfirmedCount: unResult.status === 'fulfilled' ? (unResult.value.count ?? null) : null,
          negativeBalances: negResult.status === 'fulfilled' ? (negResult.value.balances || []) : [],
          monthlySales: salesResult.status === 'fulfilled' ? (salesResult.value.data || {}) : {},
        });

        if (overwriteMfData && salesResult.status === 'fulfilled') {
          applyMonthlySalesAutoWrite(salesResult.value.data || {});
        }
        return;
      }

      // freee: 未仕訳件数は取得不可（銀行明細許可未申請。space.md 10章参照）。
      // 月次売上仕入はtrial_plの累計差分から単月値を算出し(freee.js::getMonthlySalesPurchase参照)、
      // MFと同じ{'YYYY-MM': {sales, purchase}}形式で返る。mfDataへの自動反映もMFと同様に行う。
      const [accResult, negResult, salesResult] = await Promise.allSettled([
        fetchJson(`${MF_API_BASE}/api/freee-connected-accounts?clientId=${clientId}`),
        fetchJson(`${MF_API_BASE}/api/freee-negative-balances?clientId=${clientId}`),
        fetchJson(`${MF_API_BASE}/api/freee-monthly-sales-purchase?clientId=${clientId}&months=${monthsParam}`),
      ]);

      const errors: string[] = [];
      if (accResult.status === 'rejected') errors.push(`口座連携: ${accResult.reason.message}`);
      if (negResult.status === 'rejected') errors.push(`マイナス残高: ${negResult.reason.message}`);
      if (salesResult.status === 'rejected') errors.push(`freee売上仕入: ${salesResult.reason.message}`);

      const freeeMonthlySales = salesResult.status === 'fulfilled' ? (salesResult.value.data || {}) : {};

      setMfPanel({
        loading: false,
        error: errors.length > 0 ? errors.join(' / ') : null,
        connectedAccounts: accResult.status === 'fulfilled'
          ? (accResult.value.accounts || []).map((a: any) => ({
              id: a.id, name: a.name, isManual: false,
              lastTransactionDate: a.lastSyncedAt,
              // "wallet"(現金)は銀行同期の対象外でsync_statusが常にunsupportedになる仕様のため、
              // 異常判定から除外する（実際に同期対象なのはbank_account/credit_card等）。
              stale: a.type !== 'wallet' && a.syncStatus !== 'success',
              syncStatus: a.syncStatus,
            }))
          : [],
        unconfirmedCount: null,
        negativeBalances: negResult.status === 'fulfilled' ? (negResult.value.balances || []) : [],
        monthlySales: freeeMonthlySales,
      });

      if (overwriteMfData && salesResult.status === 'fulfilled') {
        applyMonthlySalesAutoWrite(freeeMonthlySales);
      }
    } catch (err: any) {
      setMfPanel(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  useEffect(() => {
    if (isAccountingLinked) {
      // 承認完了(確定済み)の期はmfDataを自動上書きしない。手動再取得ボタンのみで更新する
      // （freeeは現状mfDataへの自動書き込み自体を行わないため、この引数は実質MFのみに影響）。
      fetchMfPanelData(termOfficeStatus !== '承認完了');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAccountingLinked, clientId, activeTerm, currentYear]);

  // ★ ルール適用済み未仕訳の一括登録（既定科目が設定されている連携口座/カードの明細のみ対象）
  const [bulkJournal, setBulkJournal] = useState<{
    open: boolean;
    loading: boolean;
    executing: boolean;
    error: string | null;
    matched: { transactionId: string; date: string; value: number; side: string; content: string | null; accountId: string; subAccountId: string | null }[];
    unmatchedCount: number;
    totalCount: number;
    results: { transactionId: string; success: boolean; error?: string }[] | null;
  }>({ open: false, loading: false, executing: false, error: null, matched: [], unmatchedCount: 0, totalCount: 0, results: null });

  const openBulkJournalPreview = async () => {
    if (!clientId) return;
    setBulkJournal(prev => ({ ...prev, open: true, loading: true, error: null, results: null }));
    try {
      const { startDate, endDate } = getActiveTermDateRange();
      const res = await fetch(
        `${MF_API_BASE}/api/rule-matched-transactions?clientId=${clientId}&startDate=${startDate}&endDate=${endDate}`
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'ルール適用済み明細の取得に失敗しました。');
      setBulkJournal(prev => ({
        ...prev,
        loading: false,
        matched: body.matched || [],
        unmatchedCount: body.unmatchedCount || 0,
        totalCount: body.totalCount || 0,
      }));
    } catch (err: any) {
      setBulkJournal(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  const executeBulkJournal = async () => {
    if (!clientId || bulkJournal.matched.length === 0) return;
    setBulkJournal(prev => ({ ...prev, executing: true, error: null }));
    try {
      const res = await fetch(`${MF_API_BASE}/api/bulk-journalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          items: bulkJournal.matched.map(m => ({ transactionId: m.transactionId, accountId: m.accountId, subAccountId: m.subAccountId })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || '一括登録に失敗しました。');
      setBulkJournal(prev => ({ ...prev, executing: false, results: body.results || [] }));
      // 未仕訳件数バッジを最新化する。
      fetchMfPanelData(false);
    } catch (err: any) {
      setBulkJournal(prev => ({ ...prev, executing: false, error: err.message }));
    }
  };

  // 印刷モードがオンになったら印刷ダイアログを呼ぶ
  useEffect(() => {
    if (printTarget) {
      setTimeout(() => {
        window.print();
      }, 800); // レンダリング待ち
    }
  }, [printTarget]);

  const loadTasksForTerm = (data: any, term: number, year: number) => {
    const termKey = `year_${year}_term${term}_tasks`;
    const savedTasks = data[termKey];
    
    const statusKey = `year_${year}`;
    const termStatus = data[statusKey]?.[`term${term}`]?.clientStatus || '未着手';
    setClientStatus(termStatus);

    let baseTasks = JSON.parse(JSON.stringify(INITIAL_TASKS));
    if (term === 3) {
      baseTasks = [...baseTasks, ...JSON.parse(JSON.stringify(TAX_RETURN_TASKS))];
    }

    if (savedTasks) {
      const mergedTasks = baseTasks.map((initTask: any) => {
        const saved = savedTasks.find((t: any) => t.no === initTask.no);
        if (saved) {
          return { 
            ...initTask,
            clientInput: saved.clientInput,
            officeStatus: saved.officeStatus,
            memo: saved.memo,
            details: saved.details || initTask.details 
          };
        }
        return initTask;
      });
      const customTasks = savedTasks.filter((t: any) => t.no.startsWith("custom-"));
      setTasks([...mergedTasks, ...customTasks]);
    } else {
      setTasks(baseTasks);
    }
    // Firestoreとのマージが完了し、tasksが安全に保存対象になったことを示す。
    setTasksReady(true);
  };

  const saveDataToFirestore = async (currentTasks: any[], term: number, year: number, newClientStatus?: string) => {
    if (!clientId) return;
    if (!tasksReady) {
      // Firestoreからの読み込み・マージが終わる前に呼ばれた保存は、まだ空/デフォルトの
      // tasksを書き込んで既存データを消してしまう危険があるため、必ず無視する。
      console.warn('saveDataToFirestore: tasksReadyになる前の保存要求を無視しました。');
      return;
    }
    setSaveStatus('saving');
    try {
      const docRef = doc(db, "clients", clientId);
      
      // ★ 修正: Firestoreエラー対策。JSON変換を挟むことで、保存不可能な「undefined」を綺麗に取り除く
      const cleanTasks = JSON.parse(JSON.stringify(currentTasks));

      const total = cleanTasks.length;
      const completed = cleanTasks.filter((t: any) => t.officeStatus === 'OK').length;
      const isStarted = cleanTasks.some((t: any) => t.officeStatus === 'OK' || t.officeStatus === '要確認');
      
      let newOfficeStatus = '未チェック';
      if (completed === total) newOfficeStatus = '承認完了';
      else if (isStarted) newOfficeStatus = 'チェック中';

      const termKey = `year_${year}_term${term}_tasks`;
      const officeStatusKey = `year_${year}.term${term}.officeStatus`;
      const clientStatusKey = `year_${year}.term${term}.clientStatus`;
      const completedAtKey = `year_${year}.term${term}.completedAt`;

      const statusToSave = newClientStatus || clientStatus;

      const updates: any = {
        [termKey]: cleanTasks, // ★修正: クリーニング済みのタスクデータを渡す
        [officeStatusKey]: newOfficeStatus,
        [clientStatusKey]: statusToSave
      };

      if (statusToSave === '完了') {
        updates[completedAtKey] = new Date().toISOString();
      }

      await updateDoc(docRef, updates);

      setFullData((prev: any) => {
        const newYearData = prev[`year_${year}`] || {};
        const newTermData = newYearData[`term${term}`] || {};
        return {
          ...prev,
          [termKey]: cleanTasks,
          [`year_${year}`]: {
            ...newYearData,
            [`term${term}`]: { 
                ...newTermData, 
                officeStatus: newOfficeStatus,
                clientStatus: statusToSave,
                completedAt: statusToSave === '完了' ? new Date().toISOString() : newTermData.completedAt
            }
          }
        };
      });

      setSaveStatus('saved');
    } catch (error) {
      console.error("保存エラー:", error);
      setSaveStatus('error');
    }
  };

  const handleSubmit = async () => {
    if (!confirm('この期間の作業を完了とし、事務所へ提出しますか？')) return;
    setClientStatus('完了');
    await saveDataToFirestore(tasks, activeTerm, currentYear, '完了');
    alert('提出しました！');
  };

  const updateStatusToInProgress = () => {
    if (clientStatus === '未着手' || clientStatus === '完了') {
        setClientStatus('進行中');
        return '進行中';
    }
    return undefined;
  };

  const addCustomTask = () => {
    const newTask = {
      no: `custom-${Date.now()}`,
      name: '（追加項目を入力してください）',
      clientInput: '',
      officeStatus: '未',
      isCustom: true,
    };
    const newTasks = [...tasks, newTask];
    setTasks(newTasks);
    triggerAutoSave(newTasks);
  };

  const deleteCustomTask = (index: number) => {
    if(!confirm('この項目を削除しますか？')) return;
    const newTasks = tasks.filter((_, i) => i !== index);
    setTasks(newTasks);
    triggerAutoSave(newTasks);
  };

  const handleInputChange = (index: number, field: string, value: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    newTasks[index] = { ...newTasks[index], [field]: value };
    setTasks(newTasks);
    
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 修正: 直接変更せず、ディープコピーをしてから書き換える（確実な保存のため）
  const handleOrochiDataChange = (taskIndex: number, month: number, shop: string, field: string, value: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex])); // ディープコピー
    
    if (!task.details) task.details = { monthlyData: {} };
    if (!task.details.monthlyData) task.details.monthlyData = {};
    if (!task.details.monthlyData[month]) task.details.monthlyData[month] = {};
    if (!task.details.monthlyData[month][shop]) task.details.monthlyData[month][shop] = {};
    
    task.details.monthlyData[month][shop][field] = value === '' ? 0 : parseFloat(value);
    task.clientInput = "詳細データ入力済";
    
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 要件2: 店舗の追加
  const handleAddShop = (taskIndex: number) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex]));
    if (!task.details) task.details = { monthlyData: {} };
    const shops = getTaskShops(task);
    shops.push({ key: `shop_${Date.now()}`, name: '新規店舗' });
    task.details.shops = shops;
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 要件2: 店舗名のインライン編集（key は変えないのでデータは移動しない）
  const handleRenameShop = (taskIndex: number, shopKey: string, newName: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex]));
    if (!task.details) task.details = { monthlyData: {} };
    const shops = getTaskShops(task);
    const target = shops.find((s) => s.key === shopKey);
    if (target) target.name = newName;
    task.details.shops = shops;
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 要件2: 店舗の削除（入力済みデータも合わせて削除）
  const handleDeleteShop = (taskIndex: number, shopKey: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex]));
    if (!task.details) task.details = { monthlyData: {} };
    const shops = getTaskShops(task).filter((s) => s.key !== shopKey);
    task.details.shops = shops;
    if (task.details.monthlyData) {
      Object.keys(task.details.monthlyData).forEach((m) => {
        if (task.details.monthlyData[m]) delete task.details.monthlyData[m][shopKey];
      });
    }
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 要件3: その他事業の月次データ入力
  const handleOtherDataChange = (taskIndex: number, bizId: string, month: number, field: string, value: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex]));
    if (!task.details) task.details = { monthlyData: {} };
    const businesses = getOtherBusinesses(task);
    const biz = businesses.find((b) => b.id === bizId);
    if (biz) {
      if (!biz.monthlyData) biz.monthlyData = {};
      if (!biz.monthlyData[month]) biz.monthlyData[month] = {};
      biz.monthlyData[month][field] = value === '' ? 0 : parseFloat(value);
    }
    task.details.otherBusinesses = businesses;
    task.clientInput = "詳細データ入力済";
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 要件3: その他事業のタイトル（事業名）編集
  const handleOtherTitleChange = (taskIndex: number, bizId: string, value: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex]));
    if (!task.details) task.details = { monthlyData: {} };
    const businesses = getOtherBusinesses(task);
    const biz = businesses.find((b) => b.id === bizId);
    if (biz) biz.title = value;
    task.details.otherBusinesses = businesses;
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 要件3: その他事業の枠を追加
  const handleAddOtherBusiness = (taskIndex: number) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex]));
    if (!task.details) task.details = { monthlyData: {} };
    const businesses = getOtherBusinesses(task);
    businesses.push({ id: `other_${Date.now()}`, title: `その他事業${businesses.length + 1}`, monthlyData: {} });
    task.details.otherBusinesses = businesses;
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 要件3: その他事業の枠を削除
  const handleDeleteOtherBusiness = (taskIndex: number, bizId: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex]));
    if (!task.details) task.details = { monthlyData: {} };
    const businesses = getOtherBusinesses(task).filter((b) => b.id !== bizId);
    task.details.otherBusinesses = businesses;
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  // ★ 修正: ディープコピーで確実に変更を検知させる
  const handleMfDataChange = (taskIndex: number, month: number, field: string, value: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = JSON.parse(JSON.stringify(newTasks[taskIndex])); // ディープコピー
    
    if (!task.details) task.details = { mfData: {} };
    if (!task.details.mfData) task.details.mfData = {};
    if (!task.details.mfData[month]) task.details.mfData[month] = {};
    
    task.details.mfData[month][field] = value === '' ? 0 : parseFloat(value);
    
    newTasks[taskIndex] = task;
    setTasks(newTasks);
    
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  const triggerAutoSave = (newTasks: any[], newStatus?: string) => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      saveDataToFirestore(newTasks, activeTerm, currentYear, newStatus);
    }, 2000);
  };

  const handleTabChange = async (newTerm: number) => {
    if (activeTerm === newTerm) return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
      await saveDataToFirestore(tasks, activeTerm, currentYear);
    }
    setActiveTerm(newTerm);
    if (fullData) loadTasksForTerm(fullData, newTerm, currentYear);
  };

  const handleYearChange = async (newYear: number) => {
    if (currentYear === newYear) return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
      await saveDataToFirestore(tasks, activeTerm, currentYear);
    }
    setCurrentYear(newYear);
  };

  const calculateMonthlyTotal = (monthlyData: any, month: number) => {
    let sales = 0, purchase = 0, fee = 0;
    const shops = monthlyData?.[month] || {};
    Object.values(shops).forEach((s: any) => {
      sales += s.sales || 0;
      purchase += s.purchase || 0;
      fee += s.fee || 0;
    });
    return { sales, purchase, fee };
  };

  // 年間合計計算用
  const calculateYearlyTotal = () => {
    let yearlyOrochiSales = 0;
    let yearlyOrochiPurchase = 0;
    let yearlyOrochiFee = 0;
    let yearlyMfSales = 0;
    let yearlyMfPurchase = 0;
    let yearlyOtherSales = 0;
    let yearlyOtherPurchase = 0;

    [1, 2, 3].forEach(term => {
      let termTasks: any[] = [];
      if (term === activeTerm) {
        termTasks = tasks;
      } else if (fullData) {
        const termKey = `year_${currentYear}_term${term}_tasks`;
        termTasks = fullData[termKey] || [];
      }

      const orochiTask = termTasks.find((t: any) => t.no === "6");
      if (orochiTask?.details?.monthlyData) {
        Object.values(orochiTask.details.monthlyData).forEach((shops: any) => {
          Object.values(shops).forEach((s: any) => {
            yearlyOrochiSales += s.sales || 0;
            yearlyOrochiPurchase += s.purchase || 0;
            yearlyOrochiFee += s.fee || 0;
          });
        });
      }

      // ★ 要件3: その他事業の年間合算
      if (orochiTask?.details?.otherBusinesses) {
        orochiTask.details.otherBusinesses.forEach((b: any) => {
          Object.values(b?.monthlyData || {}).forEach((m: any) => {
            yearlyOtherSales += m.sales || 0;
            yearlyOtherPurchase += m.purchase || 0;
          });
        });
      }

      const mfTask = termTasks.find((t: any) => t.no === "7");
      if (mfTask?.details?.mfData) {
        Object.values(mfTask.details.mfData).forEach((m: any) => {
          yearlyMfSales += m.sales || 0;
          yearlyMfPurchase += m.purchase || 0;
        });
      }
    });

    // ★ 要件3: 総売上高・総仕入高（ECオロチ合算 + その他事業合算）
    const yearlyTotalSales = yearlyOrochiSales + yearlyOtherSales;
    const yearlyTotalPurchase = yearlyOrochiPurchase + yearlyOtherPurchase;

    return {
      yearlyOrochiSales, yearlyOrochiPurchase, yearlyOrochiFee,
      yearlyMfSales, yearlyMfPurchase,
      yearlyOtherSales, yearlyOtherPurchase,
      yearlyTotalSales, yearlyTotalPurchase,
    };
  };

  if (loading) return <div className="p-8 text-white">データを読み込んでいます...</div>;
  if (!clientId) return <div className="p-8 text-white">URLが無効です</div>;

  // ▼▼▼ 印刷プレビュー用レイアウト ▼▼▼
  if (printTarget) {
      const termsToPrint = printTarget === 'yearly' ? [1, 2, 3] : [parseInt(printTarget)];
      const yearly = calculateYearlyTotal();
  
      return (
        <div className="bg-white text-black min-h-screen font-sans pb-20">
          {/* コントロールバー（印刷時は非表示） */}
          <div className="print:hidden bg-gray-800 text-white p-4 flex justify-between items-center sticky top-0 z-50 shadow-lg">
             <div className="flex items-center gap-4">
               <button onClick={() => setPrintTarget(null)} className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded text-sm transition-colors font-bold">← 編集画面に戻る</button>
               <span className="text-sm text-gray-300">印刷プレビューモード</span>
             </div>
             <button onClick={() => window.print()} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 font-bold rounded shadow-lg flex items-center gap-2 text-white">
               <i className="fas fa-print"></i> 印刷ダイアログを開く
             </button>
          </div>
  
          {/* 印刷本体 */}
          <div className="p-8 max-w-[1000px] mx-auto print:p-0">
              <div className="text-right text-sm text-gray-500 mb-2">印刷日: {new Date().toLocaleDateString('ja-JP')}</div>
              <div className="border-b-2 border-black pb-4 mb-8 flex justify-between items-end">
                  <div>
                      <div className="text-sm mb-1">税理士小原司事務所</div>
                      <h1 className="text-3xl font-bold">{clientName} 様</h1>
                  </div>
                  <div className="text-right">
                      <h2 className="text-xl font-bold border border-black px-4 py-1.5 inline-block bg-gray-100 whitespace-nowrap">
                          {getFiscalYearLabel(fullData?.closingMonth, currentYear)} 作業報告書 ({printTarget === 'yearly' ? '年間合計' : `第${printTarget}期`})
                      </h2>
                  </div>
              </div>
  
              {termsToPrint.map(term => {
                  const termTasks = term === activeTerm ? tasks : (fullData?.[`year_${currentYear}_term${term}_tasks`] || []);
                  const termMonths = getTermMonths(term);
  
                  let termOrochiSales = 0;
                  let termOrochiPurchase = 0;
                  let termOrochiFee = 0;
                  let termMfSales = 0;
                  let termMfPurchase = 0;
                  let termOtherSales = 0;
                  let termOtherPurchase = 0;

                  const orochiTask = termTasks.find((t: any) => t.no === "6");
                  const mfTask = termTasks.find((t: any) => t.no === "7");

                  termMonths.forEach(month => {
                      const orochiTotal = calculateMonthlyTotal(orochiTask?.details?.monthlyData, month);
                      const mfData = mfTask?.details?.mfData?.[month] || { sales: 0, purchase: 0 };
                      const otherTotal = calculateOtherMonthly(orochiTask?.details?.otherBusinesses, month);
                      termOrochiSales += orochiTotal.sales;
                      termOrochiPurchase += orochiTotal.purchase;
                      termOrochiFee += orochiTotal.fee;
                      termMfSales += mfData.sales;
                      termMfPurchase += mfData.purchase;
                      termOtherSales += otherTotal.sales;
                      termOtherPurchase += otherTotal.purchase;
                  });
                  const termTotalSales = termOrochiSales + termOtherSales;
                  const termTotalPurchase = termOrochiPurchase + termOtherPurchase;
  
                  return (
                      <div key={term} className="mb-12">
                          <h3 className="text-lg font-bold bg-gray-200 px-3 py-2 border-l-4 border-gray-700 mb-4" style={{ pageBreakAfter: 'avoid' }}>
                              第{term}期 ({getCalendarMonth(fullData?.closingMonth, termMonths[0])}月〜{getCalendarMonth(fullData?.closingMonth, termMonths[termMonths.length-1])}月)
                          </h3>
  
                          {/* タスクリスト */}
                          <table className="w-full text-xs border-collapse mb-8 border border-gray-400">
                              <thead>
                                  <tr className="bg-gray-100 border-b-2 border-gray-400">
                                      <th className="border border-gray-400 p-2 w-10">No</th>
                                      <th className="border border-gray-400 p-2 text-left">確認項目</th>
                                      <th className="border border-gray-400 p-2 w-48">お客様入力</th>
                                      <th className="border border-gray-400 p-2 w-20">事務所判定</th>
                                      <th className="border border-gray-400 p-2 w-48 text-left">管理者メモ</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  {termTasks.map((t: any, i: number) => (
                                      <tr key={i}>
                                          <td className="border border-gray-400 p-2 text-center">{t.no}</td>
                                          <td className="border border-gray-400 p-2">{t.name}</td>
                                          <td className="border border-gray-400 p-2 text-gray-800">{t.clientInput}</td>
                                          <td className="border border-gray-400 p-2 text-center font-bold">{t.officeStatus}</td>
                                          <td className="border border-gray-400 p-2">{t.memo}</td>
                                      </tr>
                                  ))}
                              </tbody>
                          </table>
  
                          {/* 簡易売上・突合表 (期計のみ) */}
                          <div className="flex gap-4 items-start" style={{ pageBreakInside: 'avoid' }}>
                              <div className="flex-1">
                                  <h4 className="font-bold text-sm mb-2">■ ECオロチ集計 (期計)</h4>
                                  <table className="w-full text-xs text-center border-collapse border border-gray-400">
                                      <thead>
                                          <tr className="bg-gray-100">
                                              <th className="border border-gray-400 p-1.5">売上合計</th>
                                              <th className="border border-gray-400 p-1.5">仕入合計</th>
                                              <th className="border border-gray-400 p-1.5">手数料合計</th>
                                          </tr>
                                      </thead>
                                      <tbody>
                                          <tr>
                                              <td className="border border-gray-400 p-2 text-base">{termOrochiSales.toLocaleString()}</td>
                                              <td className="border border-gray-400 p-2 text-base">{termOrochiPurchase.toLocaleString()}</td>
                                              <td className="border border-gray-400 p-2 text-base text-red-600">△ {termOrochiFee.toLocaleString()}</td>
                                          </tr>
                                      </tbody>
                                  </table>
                              </div>
                              <div className="flex-1">
                                  <h4 className="font-bold text-sm mb-2">■ 会計ソフト突合 (期計)</h4>
                                  <table className="w-full text-xs text-center border-collapse border border-gray-400">
                                      <thead>
                                          <tr className="bg-gray-100">
                                              <th className="border border-gray-400 p-1.5">会計ソフト売上</th>
                                              <th className="border border-gray-400 p-1.5">会計ソフト仕入</th>
                                              <th className="border border-gray-400 p-1.5">仕入差異</th>
                                          </tr>
                                      </thead>
                                      <tbody>
                                          <tr>
                                              <td className="border border-gray-400 p-2 text-base">{termMfSales.toLocaleString()}</td>
                                              <td className="border border-gray-400 p-2 text-base">{termMfPurchase.toLocaleString()}</td>
                                              <td className="border border-gray-400 p-2 text-base">
                                                  {termMfPurchase ? ((Math.abs(termOrochiPurchase - termMfPurchase) / termMfPurchase) * 100).toFixed(1) + '%' : '-'}
                                              </td>
                                          </tr>
                                      </tbody>
                                  </table>
                              </div>
                          </div>

                          {/* ★ 要件3: その他事業 + 総集計 (期計) */}
                          {(termOtherSales > 0 || termOtherPurchase > 0) && (
                              <div className="mt-4" style={{ pageBreakInside: 'avoid' }}>
                                  <h4 className="font-bold text-sm mb-2">■ その他事業 集計 (期計)</h4>
                                  <table className="w-1/2 text-xs text-center border-collapse border border-gray-400">
                                      <thead>
                                          <tr className="bg-gray-100">
                                              <th className="border border-gray-400 p-1.5">売上合計</th>
                                              <th className="border border-gray-400 p-1.5">仕入合計</th>
                                          </tr>
                                      </thead>
                                      <tbody>
                                          <tr>
                                              <td className="border border-gray-400 p-2 text-base">{termOtherSales.toLocaleString()}</td>
                                              <td className="border border-gray-400 p-2 text-base">{termOtherPurchase.toLocaleString()}</td>
                                          </tr>
                                      </tbody>
                                  </table>
                              </div>
                          )}

                          <div className="mt-4" style={{ pageBreakInside: 'avoid' }}>
                              <h4 className="font-bold text-sm mb-2">■ 総集計 (期計)　＝　ECオロチ ＋ その他事業</h4>
                              <table className="w-full text-sm text-center border-collapse border-2 border-gray-700">
                                  <thead>
                                      <tr className="bg-gray-200">
                                          <th className="border border-gray-500 p-2">総売上高</th>
                                          <th className="border border-gray-500 p-2">総仕入高</th>
                                      </tr>
                                  </thead>
                                  <tbody>
                                      <tr>
                                          <td className="border border-gray-500 p-2 text-lg font-bold">{termTotalSales.toLocaleString()} 円</td>
                                          <td className="border border-gray-500 p-2 text-lg font-bold">{termTotalPurchase.toLocaleString()} 円</td>
                                      </tr>
                                  </tbody>
                              </table>
                          </div>
                      </div>
                  )
              })}
  
              {printTarget === 'yearly' && (
                  <div className="mt-8 pt-8 border-t-2 border-black" style={{ pageBreakInside: 'avoid' }}>
                      <h3 className="text-xl font-bold bg-black text-white px-4 py-2 mb-6 inline-block">
                          {getFiscalYearLabel(fullData?.closingMonth, currentYear)} 年間合計表
                      </h3>
                      <div className="flex gap-8">
                          <table className="w-1/2 text-sm border-collapse border border-gray-400">
                              <tbody>
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left w-1/2">オロチ売上 (年間)</th>
                                      <td className="border border-gray-400 p-3 text-right font-bold text-lg">{yearly.yearlyOrochiSales.toLocaleString()} 円</td>
                                  </tr>
                                  {/* ★ 修正: 販売手数料の行を追加 */}
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left w-1/2">オロチ販売手数料 (年間)</th>
                                      <td className="border border-gray-400 p-3 text-right font-bold text-lg text-red-600">△ {yearly.yearlyOrochiFee.toLocaleString()} 円</td>
                                  </tr>
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left">会計ソフト売上 (年間)</th>
                                      <td className="border border-gray-400 p-3 text-right font-bold text-lg">{yearly.yearlyMfSales.toLocaleString()} 円</td>
                                  </tr>
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left">その他事業 売上 (年間)</th>
                                      <td className="border border-gray-400 p-3 text-right font-bold text-lg">{yearly.yearlyOtherSales.toLocaleString()} 円</td>
                                  </tr>
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left">売上差異</th>
                                      <td className="border border-gray-400 p-3 text-right">
                                          {yearly.yearlyMfSales ? ((Math.abs((yearly.yearlyOrochiSales - yearly.yearlyOrochiFee) - yearly.yearlyMfSales) / yearly.yearlyMfSales) * 100).toFixed(1) + '%' : '-'}
                                      </td>
                                  </tr>
                              </tbody>
                          </table>
                          <table className="w-1/2 text-sm border-collapse border border-gray-400">
                              <tbody>
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left w-1/2">オロチ仕入 (年間)</th>
                                      <td className="border border-gray-400 p-3 text-right font-bold text-lg">{yearly.yearlyOrochiPurchase.toLocaleString()} 円</td>
                                  </tr>
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left">その他事業 仕入 (年間)</th>
                                      <td className="border border-gray-400 p-3 text-right font-bold text-lg">{yearly.yearlyOtherPurchase.toLocaleString()} 円</td>
                                  </tr>
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left">会計ソフト仕入 (年間)</th>
                                      <td className="border border-gray-400 p-3 text-right font-bold text-lg">{yearly.yearlyMfPurchase.toLocaleString()} 円</td>
                                  </tr>
                                  <tr>
                                      <th className="border border-gray-400 p-3 bg-gray-100 text-left">仕入差異</th>
                                      <td className="border border-gray-400 p-3 text-right">
                                          {yearly.yearlyMfPurchase ? ((Math.abs(yearly.yearlyOrochiPurchase - yearly.yearlyMfPurchase) / yearly.yearlyMfPurchase) * 100).toFixed(1) + '%' : '-'}
                                      </td>
                                  </tr>
                              </tbody>
                          </table>
                      </div>

                      {/* ★ 要件3: 年間 総売上高・総仕入高 (ECオロチ + その他事業) */}
                      <div className="mt-6">
                          <table className="w-full text-base border-collapse border-2 border-black">
                              <thead>
                                  <tr className="bg-black text-white">
                                      <th className="border border-black p-3">{getFiscalYearLabel(fullData?.closingMonth, currentYear)} 総売上高（年間）</th>
                                      <th className="border border-black p-3">{getFiscalYearLabel(fullData?.closingMonth, currentYear)} 総仕入高（年間）</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  <tr>
                                      <td className="border border-black p-3 text-right text-2xl font-bold">{yearly.yearlyTotalSales.toLocaleString()} 円</td>
                                      <td className="border border-black p-3 text-right text-2xl font-bold">{yearly.yearlyTotalPurchase.toLocaleString()} 円</td>
                                  </tr>
                              </tbody>
                          </table>
                          <p className="text-xs text-gray-500 mt-1">※ 総売上高・総仕入高 ＝ ECオロチ合算 ＋ その他事業合算</p>
                      </div>
                  </div>
              )}
          </div>
        </div>
      );
  }
  // ▲▲▲ ここまで印刷プレビュー用 ▲▲▲

  const currentMonths = getTermMonths(activeTerm);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 flex flex-col">
      <div className="flex-grow">
          {/* ヘッダー */}
          <div className="mb-6 flex items-center justify-between border-b border-gray-800 pb-4">
            <div className="flex items-center gap-6">
              {isAdmin && (
                <button onClick={() => router.push('/dashboard')} className="text-gray-400 hover:text-white flex items-center text-sm transition-colors border border-gray-700 px-3 py-1 rounded">← 一覧</button>
              )}
              <div>
                <div className="text-[10px] text-gray-400 mb-0.5">税理士小原司事務所</div>
                <h1 className="text-2xl font-bold flex items-center gap-2 mb-2">{clientName}</h1>
                
                <div className="flex items-center gap-2 bg-yellow-500/10 p-2 rounded border-2 border-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.3)]">
                  <span className="text-xs text-yellow-300 font-bold px-1 uppercase tracking-wider">対象年度</span>
                  <select 
                    value={currentYear} 
                    onChange={(e) => handleYearChange(Number(e.target.value))}
                    className="bg-transparent border-none text-yellow-400 text-3xl font-extrabold focus:ring-0 cursor-pointer hover:text-yellow-300 transition-colors"
                    style={{ WebkitAppearance: 'none', MozAppearance: 'none' }}
                  >
                    <option value={2025} className="bg-gray-800 text-lg">2025年度</option>
                    <option value={2026} className="bg-gray-800 text-lg">2026年度</option>
                    <option value={2027} className="bg-gray-800 text-lg">2027年度</option>
                  </select>
                  <span className="text-yellow-500 text-sm ml-[-5px]">▼</span>
                </div>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              {/* ★ 修正: マウスが離れないように透明な橋渡し（pt-2）を追加 */}
              <div className="relative group mr-2">
                <button className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded flex items-center gap-2 text-sm border border-gray-600 transition-colors shadow">
                  <i className="fas fa-print"></i> 印刷・PDF出力
                </button>
                <div className="absolute right-0 pt-2 w-48 hidden group-hover:block z-50">
                  <div className="bg-white text-gray-800 rounded shadow-xl border border-gray-200 overflow-hidden">
                    <button onClick={() => setPrintTarget('1')} className="block w-full text-left px-4 py-2.5 hover:bg-blue-50 text-sm border-b border-gray-100">第1期を印刷</button>
                    <button onClick={() => setPrintTarget('2')} className="block w-full text-left px-4 py-2.5 hover:bg-blue-50 text-sm border-b border-gray-100">第2期を印刷</button>
                    <button onClick={() => setPrintTarget('3')} className="block w-full text-left px-4 py-2.5 hover:bg-blue-50 text-sm border-b border-gray-100">第3期を印刷</button>
                    <button onClick={() => setPrintTarget('yearly')} className="block w-full text-left px-4 py-3 hover:bg-blue-50 text-sm font-bold text-blue-600 bg-blue-50/30">年間合計として印刷</button>
                  </div>
                </div>
              </div>

              {/* ★ 新設: 強制的な手動保存ボタン */}
              <button 
                onClick={() => {
                  if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
                  saveDataToFirestore(tasks, activeTerm, currentYear);
                }}
                className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded flex items-center gap-2 text-sm transition-colors shadow mr-2 font-bold"
              >
                <i className="fas fa-save"></i> データを保存
              </button>

              {/* ★ デバッグ用: 生データ確認ボタン（一時対応） */}
              {isAdmin && (
                <button
                  onClick={() => setShowDebug(v => !v)}
                  className="bg-purple-700 hover:bg-purple-600 text-white px-3 py-1.5 rounded flex items-center gap-2 text-xs transition-colors shadow mr-2"
                >
                  <i className="fas fa-bug"></i> 生データ表示
                </button>
              )}

              <div className="flex flex-col items-end">
                  <span className="text-[10px] text-gray-400 mb-1">現在のステータス</span>
                  <span className={`text-xs px-2 py-1 rounded font-bold border ${
                      clientStatus === '完了' ? 'bg-blue-900 text-blue-200 border-blue-700' :
                      clientStatus === '進行中' ? 'bg-blue-900/40 text-blue-300 border-blue-800/50' :
                      'bg-gray-700 text-gray-400 border-gray-600'
                  }`}>
                      {clientStatus}
                  </span>
              </div>
              
              {saveStatus === 'saved' && <span className="text-sm text-gray-500 flex items-center gap-1 ml-2"><span className="w-2 h-2 bg-green-500 rounded-full"></span> 保存済</span>}
              {saveStatus === 'saving' && <span className="text-sm text-blue-400 flex items-center gap-1 ml-2 animate-pulse"><span className="w-2 h-2 bg-blue-400 rounded-full"></span> 保存中</span>}
              {saveStatus === 'changed' && <span className="text-sm text-yellow-500 flex items-center gap-1 ml-2"><span className="w-2 h-2 bg-yellow-500 rounded-full"></span> 待機中</span>}
            </div>

            {/* ★ デバッグ用パネル（一時対応・isAdminのみ） */}
            {isAdmin && showDebug && (() => {
              const debugInfo = [1, 2, 3].map((term) => {
                const termTasks = term === activeTerm ? tasks : (fullData?.[`year_${currentYear}_term${term}_tasks`] || []);
                const orochiTask = termTasks.find((t: any) => t.no === "6");
                const mfTask = termTasks.find((t: any) => t.no === "7");
                return {
                  term,
                  monthlyDataKeys: orochiTask?.details?.monthlyData ? Object.keys(orochiTask.details.monthlyData) : [],
                  monthlyData: orochiTask?.details?.monthlyData || null,
                  otherBusinesses: orochiTask?.details?.otherBusinesses || null,
                  mfDataKeys: mfTask?.details?.mfData ? Object.keys(mfTask.details.mfData) : [],
                  mfData: mfTask?.details?.mfData || null,
                };
              });
              return (
                <div className="fixed top-16 right-4 z-[100] w-[520px] max-h-[80vh] overflow-auto bg-black border-2 border-purple-500 rounded-lg p-4 shadow-2xl">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-purple-300 font-bold text-sm">生データ (closingMonth={String(fullData?.closingMonth)} / isCorporate={String(fullData?.isCorporate)} / year={currentYear})</span>
                    <button onClick={() => setShowDebug(false)} className="text-gray-400 hover:text-white text-xs">✕閉じる</button>
                  </div>
                  <pre className="text-[10px] text-green-300 whitespace-pre-wrap break-all">{JSON.stringify(debugInfo, null, 2)}</pre>
                </div>
              );
            })()}
          </div>

          <div className="flex gap-2 mb-6 p-1 bg-gray-800 rounded-lg border border-gray-700">
            {[1, 2, 3].map((term) => {
                const isActive = activeTerm === term;
                const tMonths = getTermMonths(term);
                const monthsText = `${getCalendarMonth(fullData?.closingMonth, tMonths[0])}月～${getCalendarMonth(fullData?.closingMonth, tMonths[tMonths.length-1])}月`;
                const termLabel = term === 3 ? "決算・確定申告" : `第${term}期`;
                // ★ 期タブを開かなくても未入力件数が一目でわかるようにバッジ表示
                const termTasksForBadge = term === activeTerm ? tasks : (fullData?.[`year_${currentYear}_term${term}_tasks`] || []);
                const termUnfilledCount = countUnfilledManualTasks(termTasksForBadge);

                return (
                  <button
                    key={term}
                    onClick={() => handleTabChange(term)}
                    className={`relative flex-1 py-3 px-4 rounded-md transition-all duration-200 flex flex-col items-center justify-center gap-1
                        ${isActive
                            ? 'bg-blue-600 text-white shadow-lg transform scale-[1.02] border border-blue-400 ring-2 ring-blue-500/30 font-bold z-10'
                            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
                        }`}
                  >
                    {termUnfilledCount > 0 && (
                      <span
                        title={`未入力 ${termUnfilledCount}件`}
                        className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-yellow-500 text-gray-900 text-[10px] font-bold border border-yellow-300 shadow z-20"
                      >
                        {termUnfilledCount}
                      </span>
                    )}
                    <span className={`text-xs ${isActive ? 'text-blue-100 opacity-90' : 'text-gray-500'}`}>
                        {monthsText}
                    </span>
                    <span className={`text-lg ${isActive ? 'text-white' : ''}`}>
                        {termLabel}
                    </span>
                  </button>
                );
            })}
          </div>

          {isAccountingLinked && (
            <div className="bg-gray-800 rounded border border-gray-700 shadow-xl mb-6 p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm text-blue-300 flex items-center gap-2">
                  <i className="fas fa-plug"></i> 月次チェック（{isMfLinked ? 'MFクラウド' : 'freee'}連携:{' '}
                  {ACCOUNTING_SYSTEM_URLS[accountingSystem || ''] ? (
                    <a
                      href={ACCOUNTING_SYSTEM_URLS[accountingSystem || '']}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-blue-200"
                      title={`${isMfLinked ? 'MFクラウド' : 'freee'}を新しいタブで開く`}
                    >
                      {(isMfLinked ? fullData?.mfOfficeName : fullData?.freeeCompanyName) || ''} <i className="fas fa-external-link-alt text-[10px]"></i>
                    </a>
                  ) : (
                    (isMfLinked ? fullData?.mfOfficeName : fullData?.freeeCompanyName) || ''
                  )}
                  ）
                </h3>
                <div className="flex items-center gap-2">
                  {mfPanel.loading && <span className="text-xs text-gray-400 animate-pulse">取得中...</span>}
                  <button
                    onClick={() => fetchMfPanelData(false)}
                    className="text-xs bg-gray-700 hover:bg-gray-600 border border-gray-600 text-gray-200 px-2 py-1 rounded"
                  >
                    <i className="fas fa-sync-alt"></i> 再取得
                  </button>
                </div>
              </div>

              {mfPanel.error && (
                <p className="text-xs text-red-400 mb-3">⚠ {mfPanel.error}</p>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
                <div className="bg-gray-900/60 border border-gray-700 rounded p-3">
                  <div className="text-gray-400 mb-1">口座連携</div>
                  {(() => {
                    const staleAccounts = mfPanel.connectedAccounts.filter(a => a.stale);
                    return staleAccounts.length > 0 ? (
                      <>
                        <div className="text-lg font-bold text-red-400">⚠ {staleAccounts.length}件 要確認</div>
                        <ul className="text-[10px] text-red-300 mt-1 space-y-0.5">
                          {staleAccounts.slice(0, 4).map(a => (
                            <li key={a.id}>
                              {a.name}（{a.lastTransactionDate ? `最終取込 ${a.lastTransactionDate}` : '取込履歴なし'}）
                            </li>
                          ))}
                        </ul>
                        <div className="text-[9px] text-gray-500 mt-1">
                          直近取引日ベースの推定です（同期停止の疑い）。No.1の手順でMFクラウド画面を確認してください。
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-lg font-bold text-white">{mfPanel.connectedAccounts.length}件 連携中</div>
                        <div className="text-[9px] text-gray-500 mt-1">直近取引日ベースの推定で異常なし。</div>
                      </>
                    );
                  })()}
                </div>

                <div className="bg-gray-900/60 border border-gray-700 rounded p-3">
                  <div className="text-gray-400 mb-1">未仕訳件数（対象期間のみ）</div>
                  {isMfLinked ? (
                    <>
                      <div className={`text-lg font-bold ${mfPanel.unconfirmedCount ? 'text-yellow-400' : 'text-white'}`}>
                        {mfPanel.unconfirmedCount === null ? '-' : `${mfPanel.unconfirmedCount}件`}
                      </div>
                      {!!mfPanel.unconfirmedCount && (
                        <button
                          onClick={openBulkJournalPreview}
                          className="mt-2 text-[10px] bg-blue-700 hover:bg-blue-600 text-white px-2 py-1 rounded w-full"
                        >
                          ⚡ 既定科目ぶんを一括登録
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="text-sm text-gray-400">件数は未対応</div>
                      <a
                        href="https://secure.freee.co.jp/wallet_txns/stream?registration_status=unreconciled"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-block text-[10px] bg-blue-700 hover:bg-blue-600 text-white px-2 py-1 rounded w-full text-center"
                      >
                        freeeで未処理明細を確認 <i className="fas fa-external-link-alt text-[9px]"></i>
                      </a>
                      <div className="text-[9px] text-gray-500 mt-1">
                        ※freee側の画面右上で対象の事業所（{fullData?.freeeCompanyName || '該当の顧問先'}）に切り替えてから確認してください。
                      </div>
                    </>
                  )}
                </div>

                <div className="bg-gray-900/60 border border-gray-700 rounded p-3 lg:col-span-2">
                  <div className="text-gray-400 mb-1">マイナス残高</div>
                  {mfPanel.negativeBalances.length === 0 ? (
                    <div className="text-white">なし</div>
                  ) : (
                    <ul className="space-y-0.5">
                      {mfPanel.negativeBalances.slice(0, 6).map((b, i) => (
                        <li key={i} className={`flex justify-between ${b.name === '現金' ? 'text-red-400 font-bold' : 'text-yellow-300'}`}>
                          <span>{b.name}</span>
                          <span>{b.amount.toLocaleString()}円</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 【orochi_bridge_design.md §3-4】カンニッポのAI監査結果（clients/{id}.aiAuditSummary）。
                    ・この画面から findings を編集・削除するUIは作らない（正本はカンニッポ側・§3-1）。
                    ・判定ラベル（⚠️未対応／🟢問題なし／❌異常）はカンニッポと同じ文言を使う（§1-2・変更禁止）。
                    ・aiAuditSummary は year_*_term*_tasks とは完全に独立したフィールド（§0-3）。 */}
                <div className="bg-gray-900/60 border border-gray-700 rounded p-3 lg:col-span-2">
                  <div className="text-gray-400 mb-1 flex items-center justify-between">
                    <span>AI監査 指摘事項</span>
                    {aiAuditSummary?.updatedAt && (
                      <span className="text-[9px] text-gray-500">
                        カンニッポから反映：{new Date(Number(aiAuditSummary.updatedAt)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                        {aiAuditSummary.targetYearMonth ? `（対象 ${aiAuditSummary.targetYearMonth}）` : ''}
                      </span>
                    )}
                  </div>
                  {!aiAuditSummary ? (
                    <div className="text-gray-500">カンニッポからの反映はまだありません。</div>
                  ) : (aiAuditSummary.findings || []).length === 0 ? (
                    <div className="text-white">指摘はありません。</div>
                  ) : (
                    <ul className="space-y-1 max-h-56 overflow-y-auto">
                      {(aiAuditSummary.findings || []).map((f: AiAuditFinding, i: number) => (
                        <li key={i} className="flex gap-2 items-start">
                          <span className="shrink-0 text-[10px] leading-5">{AI_JUDGMENT_LABEL[f.judgmentStatus] || AI_JUDGMENT_LABEL.PENDING}</span>
                          <span className={f.severity === 'warn' ? 'text-yellow-300' : 'text-gray-300'}>{f.label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="text-[9px] text-gray-500 mt-2">
                    詳細・判定の変更はカンニッポ側で行ってください（この画面は表示専用です）。
                  </div>
                </div>
              </div>

              {isAccountingLinked && termOfficeStatus === '承認完了' && (
                <p className="text-[10px] text-gray-500 mt-2">
                  この期は承認完了済みのため、会計ソフトの売上・仕入は自動更新されません（下部の「🔄 最新の会計ソフト値を再取得」ボタンから手動更新できます）。
                </p>
              )}
            </div>
          )}

          {bulkJournal.open && (
            <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-50 p-4">
              <div className="bg-gray-800 border border-gray-600 rounded-lg w-full max-w-2xl shadow-2xl max-h-[85vh] flex flex-col">
                <div className="p-5 border-b border-gray-700 flex justify-between items-center">
                  <h3 className="text-lg font-bold flex items-center gap-2">
                    <i className="fas fa-bolt text-blue-400"></i> 既定科目ぶんの一括仕訳登録
                  </h3>
                  <button
                    onClick={() => setBulkJournal({ open: false, loading: false, executing: false, error: null, matched: [], unmatchedCount: 0, totalCount: 0, results: null })}
                    className="text-gray-400 hover:text-white"
                  >✕</button>
                </div>

                <div className="p-5 overflow-y-auto flex-1">
                  {bulkJournal.loading && <p className="text-sm text-gray-400 animate-pulse">対象明細を確認中...</p>}
                  {bulkJournal.error && <p className="text-sm text-red-400 mb-3">⚠ {bulkJournal.error}</p>}

                  {!bulkJournal.loading && !bulkJournal.results && (
                    <>
                      <p className="text-sm text-gray-300 mb-3">
                        対象期間の未仕訳 <span className="font-bold text-white">{bulkJournal.totalCount}件</span> のうち、
                        連携口座に既定科目（白）が設定済みの
                        <span className="font-bold text-blue-300"> {bulkJournal.matched.length}件</span> を
                        MFクラウド上でそのまま仕訳登録します。
                        {bulkJournal.unmatchedCount > 0 && (
                          <> 既定科目未設定（AI推測＝青）の {bulkJournal.unmatchedCount}件 は対象外のまま残ります（従来通り手動対応）。</>
                        )}
                      </p>
                      {bulkJournal.matched.length > 0 && (
                        <div className="border border-gray-700 rounded overflow-hidden mb-3">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-900 text-gray-400">
                              <tr>
                                <th className="p-2 text-left">日付</th>
                                <th className="p-2 text-left">内容</th>
                                <th className="p-2 text-right">金額</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bulkJournal.matched.slice(0, 20).map((m) => (
                                <tr key={m.transactionId} className="border-t border-gray-700">
                                  <td className="p-2">{m.date}</td>
                                  <td className="p-2 text-gray-300">{m.content || '-'}</td>
                                  <td className="p-2 text-right">{m.value.toLocaleString()}円</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {bulkJournal.matched.length > 20 && (
                            <div className="text-[10px] text-gray-500 p-2 bg-gray-900">他 {bulkJournal.matched.length - 20}件（表示省略）</div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {bulkJournal.results && (
                    <div>
                      <p className="text-sm mb-2">
                        登録結果: <span className="text-green-400 font-bold">成功 {bulkJournal.results.filter(r => r.success).length}件</span>
                        {' / '}
                        <span className="text-red-400 font-bold">失敗 {bulkJournal.results.filter(r => !r.success).length}件</span>
                      </p>
                      {bulkJournal.results.some(r => !r.success) && (
                        <ul className="text-xs text-red-300 space-y-1 max-h-40 overflow-y-auto border border-red-900/50 rounded p-2 bg-red-900/10">
                          {bulkJournal.results.filter(r => !r.success).map(r => (
                            <li key={r.transactionId}>{r.transactionId}: {r.error}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

                <div className="p-4 border-t border-gray-700 flex justify-end gap-3">
                  <button
                    onClick={() => setBulkJournal({ open: false, loading: false, executing: false, error: null, matched: [], unmatchedCount: 0, totalCount: 0, results: null })}
                    className="px-4 py-2 text-sm text-gray-300 hover:text-white"
                  >
                    {bulkJournal.results ? '閉じる' : 'キャンセル'}
                  </button>
                  {!bulkJournal.results && (
                    <button
                      onClick={executeBulkJournal}
                      disabled={bulkJournal.loading || bulkJournal.executing || bulkJournal.matched.length === 0}
                      className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded font-bold"
                    >
                      {bulkJournal.executing ? '登録中...' : `${bulkJournal.matched.length}件を登録する`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="bg-gray-800 rounded border border-gray-700 overflow-hidden shadow-xl mb-8">
            <div className="px-4 py-2 bg-gray-750 border-b border-gray-700 flex justify-between items-center">
                <div className="flex items-center gap-4">
                  <h3 className="font-bold text-sm text-gray-200">
                    第{activeTerm}期 {activeTerm === 3 ? "＋ 決算・確定申告" : ""} タスクチェックリスト
                  </h3>
                  {activeTerm === 3 && isAdmin && (
                    <button onClick={addCustomTask} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded flex items-center gap-1">
                      <i className="fas fa-plus"></i> 追加資料を追加
                    </button>
                  )}
                </div>
                {unfilledTaskIndices.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1 text-xs font-bold text-yellow-300 bg-yellow-900/30 px-2 py-1 rounded border border-yellow-700 animate-pulse">
                      <i className="fas fa-exclamation-triangle"></i> 未入力: {unfilledTaskIndices.length}件
                    </span>
                    <button
                      onClick={jumpToUnfilledTask}
                      className="text-xs bg-yellow-600 hover:bg-yellow-500 text-gray-900 font-bold px-2 py-1 rounded flex items-center gap-1 transition-colors"
                    >
                      次の未入力へ <i className="fas fa-arrow-down"></i>
                    </button>
                  </div>
                ) : (
                  <span className="text-[10px] text-green-300 bg-green-900/30 px-2 py-0.5 rounded border border-green-700 flex items-center gap-1">
                    <i className="fas fa-check"></i> すべて入力済みです
                  </span>
                )}
            </div>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-900 text-gray-400 text-xs border-b border-gray-700">
                  <th className="px-2 py-2 w-10 text-center border-r border-gray-700">No</th>
                  <th className="px-3 py-2 border-r border-gray-700">確認項目</th>
                  <th className="px-2 py-2 w-32 border-r border-gray-700 bg-blue-900/20 text-blue-200 font-bold border-b-2 border-blue-500">
                    お客様入力欄
                  </th>
                  <th className="px-2 py-2 w-24 border-r border-gray-700">事務所判定</th>
                  <th className="px-3 py-2 w-64">管理者メモ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700 text-sm">
                {tasks.map((task, index) => (
                  <React.Fragment key={index}>
                    <tr ref={(el) => { taskRowRefs.current[index] = el; }} className="hover:bg-gray-750 transition-colors group">
                      <td className="px-2 py-1 text-center text-gray-500 text-xs font-mono border-r border-gray-700 bg-gray-800/30 align-top pt-3">
                        {task.isCustom && isAdmin ? (
                          <button onClick={() => deleteCustomTask(index)} className="text-red-400 hover:text-red-300">
                            <i className="fas fa-trash"></i>
                          </button>
                        ) : (
                          task.no
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-200 border-r border-gray-700 leading-tight align-top">
                        <div className="flex items-start justify-between">
                            {task.isCustom && isAdmin ? (
                              <input type="text" value={task.name} onChange={(e) => handleInputChange(index, 'name', e.target.value)} className="bg-gray-900 border border-gray-600 text-white w-full rounded px-2 py-1" />
                            ) : (
                              <span>{task.name}</span>
                            )}
                            <div className="flex gap-2">
                                {(task.type === 'sales_input' || task.type === 'sales_check') && (
                                    <button onClick={() => setOpenInputId(openInputId === index ? null : index)} className={`ml-2 text-xs px-2 py-0.5 rounded border transition-colors flex-shrink-0 ${openInputId === index ? 'bg-green-700 text-white border-green-600' : 'bg-green-900/30 text-green-400 border-green-800 hover:bg-green-800'}`}>
                                        {openInputId === index ? '▲ 閉じる' : '📊 データ入力・確認'}
                                    </button>
                                )}
                                {task.manual && (
                                    <button onClick={() => setOpenManualId(openManualId === index ? null : index)} className="ml-2 text-xs bg-gray-700 hover:bg-blue-600 text-blue-300 hover:text-white px-2 py-0.5 rounded border border-blue-900/50 transition-colors flex-shrink-0">
                                        {openManualId === index ? '▲ 閉じる' : '？ 手順'}
                                    </button>
                                )}
                            </div>
                        </div>
                      </td>
                      
                      <td className="px-2 py-2 border-r border-gray-700 align-top pt-3 bg-gray-800/20">
                        <div className="relative">
                          {isUnfilledManualTask(task) && (
                            <span
                              title="未入力です"
                              className="absolute -top-2 -right-2 z-10 w-4 h-4 rounded-full bg-red-500 border border-red-300 text-white text-[10px] font-bold flex items-center justify-center shadow animate-pulse"
                            >
                              !
                            </span>
                          )}
                          {task.type === 'textarea' ? (
                              <textarea
                                value={task.clientInput || ''}
                                onChange={(e) => handleInputChange(index, 'clientInput', e.target.value)}
                                className={`w-full text-xs px-2 py-1 rounded border focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400 shadow-inner
                                  ${isUnfilledManualTask(task) ? 'border-yellow-500/70 ring-2 ring-yellow-500/20' : 'border-gray-300'}`}
                                style={{ minHeight: '120px', lineHeight: '1.4' }}
                                placeholder="PC購入(15万)、○○システム前払い等"
                              />
                          ) : (
                              <input
                                type="text"
                                value={task.clientInput || ''}
                                readOnly={task.type === 'sales_input' || task.type === 'sales_check'}
                                onChange={(e) => handleInputChange(index, 'clientInput', e.target.value)}
                                className={`w-full text-xs px-2 py-1 rounded border focus:outline-none focus:ring-2 focus:ring-blue-500 h-8 shadow-inner transition-all
                                  ${(task.type === 'sales_input' || task.type === 'sales_check')
                                    ? 'bg-gray-900 border-gray-700 text-gray-400 cursor-pointer hover:bg-gray-800'
                                    : task.clientInput
                                      ? 'bg-white border-gray-300 text-gray-900'
                                      : 'bg-white border-yellow-500/70 text-gray-900 placeholder-gray-400 ring-2 ring-yellow-500/20'
                                  }`}
                                placeholder={(task.type === 'sales_input' || task.type === 'sales_check') ? "📊 ボタンから入力" : "✏️ ここに入力してください"}
                                onClick={() => {
                                  if(task.type === 'sales_input' || task.type === 'sales_check') setOpenInputId(openInputId === index ? null : index)
                                }}
                              />
                          )}
                        </div>
                      </td>

                      <td className="px-2 py-2 border-r border-gray-700 text-center align-top pt-3">
                         <select value={task.officeStatus || '未'} onChange={(e) => handleInputChange(index, 'officeStatus', e.target.value)} disabled={!isAdmin} className={`text-xs rounded px-1 py-0.5 border focus:outline-none w-full h-7 ${!isAdmin ? 'opacity-50 cursor-not-allowed' : ''} ${task.officeStatus === 'OK' ? 'bg-green-900/30 text-green-400 border-green-800' : task.officeStatus === '要確認' ? 'bg-red-900/30 text-red-400 border-red-800' : 'bg-gray-700 text-gray-400 border-gray-600'}`}>
                             <option value="未">未</option><option value="OK">OK</option><option value="要確認">要確認</option>
                         </select>
                      </td>

                      <td className="px-2 py-2 align-top pt-3">
                        <input type="text" value={task.memo || ''} onChange={(e) => handleInputChange(index, 'memo', e.target.value)} disabled={!isAdmin} placeholder={isAdmin ? "特記事項なし" : ""} className={`w-full bg-transparent border-b border-transparent focus:border-blue-500 focus:outline-none text-xs py-1 text-gray-400 focus:text-white transition-colors h-7 ${!isAdmin ? 'cursor-not-allowed' : 'group-hover:border-gray-600'}`}/>
                      </td>
                    </tr>

                    {openInputId === index && task.type === 'sales_input' && (() => {
                        const shops = getTaskShops(task);
                        const businesses = getOtherBusinesses(task);
                        const termOrochi = currentMonths.reduce((acc, m) => {
                            const t = calculateMonthlyTotal(task.details?.monthlyData, m);
                            acc.sales += t.sales; acc.purchase += t.purchase; acc.fee += t.fee; return acc;
                        }, { sales: 0, purchase: 0, fee: 0 });
                        const termOther = currentMonths.reduce((acc, m) => {
                            const t = calculateOtherMonthly(businesses, m);
                            acc.sales += t.sales; acc.purchase += t.purchase; return acc;
                        }, { sales: 0, purchase: 0 });
                        const termTotalSales = termOrochi.sales + termOther.sales;
                        const termTotalPurchase = termOrochi.purchase + termOther.purchase;

                        return (
                        <tr className="bg-gray-800/80">
                            <td colSpan={5} className="px-4 py-4 border-b border-gray-700">
                                {/* === ECオロチ集計（多店舗対応） === */}
                                <div className="overflow-x-auto">
                                    <div className="flex items-center justify-between mb-2">
                                        <h4 className="text-sm font-bold text-green-400">📊 ECオロチ集計データ入力（多店舗対応）</h4>
                                        <button onClick={() => handleAddShop(index)} className="text-xs bg-green-700 hover:bg-green-600 text-white px-3 py-1 rounded flex items-center gap-1 border border-green-500">
                                            <i className="fas fa-plus"></i> 店舗を追加
                                        </button>
                                    </div>
                                    <table className="w-full text-xs text-center border-collapse min-w-[640px]">
                                        <thead><tr className="bg-gray-900 text-gray-400"><th className="p-2 border border-gray-700 w-16">月</th><th className="p-2 border border-gray-700 min-w-[140px]">店舗（編集可）</th><th className="p-2 border border-gray-700 bg-yellow-900/10 text-yellow-200">売上合計</th><th className="p-2 border border-gray-700 bg-yellow-900/10 text-yellow-200">仕入合計</th><th className="p-2 border border-gray-700 bg-yellow-900/10 text-yellow-200">手数料合計</th></tr></thead>
                                        <tbody>
                                            {currentMonths.map(month => (
                                                <React.Fragment key={month}>
                                                    {shops.map((shop, shopIndex) => (
                                                        <tr key={`${month}-${shop.key}`} className="hover:bg-gray-700">
                                                            {shopIndex === 0 && <td rowSpan={shops.length} className="p-2 border border-gray-700 font-bold bg-gray-800">{getCalendarMonth(fullData?.closingMonth, month)}月</td>}
                                                            <td className="p-1 border border-gray-700">
                                                                <div className="flex items-center gap-1">
                                                                    <input type="text" value={shop.name} onChange={(e) => handleRenameShop(index, shop.key, e.target.value)} className="w-full h-8 bg-gray-800 border border-gray-600 text-white px-2 rounded text-left focus:border-green-500" placeholder="店舗名" />
                                                                    {shops.length > 1 && (
                                                                        <button onClick={() => handleDeleteShop(index, shop.key)} title="この店舗を削除" className="text-red-400 hover:text-red-300 px-1 flex-shrink-0"><i className="fas fa-times"></i></button>
                                                                    )}
                                                                </div>
                                                            </td>
                                                            <td className="p-1 border border-gray-700"><input type="number" value={task.details?.monthlyData?.[month]?.[shop.key]?.sales || ''} onChange={(e) => handleOrochiDataChange(index, month, shop.key, 'sales', e.target.value)} className="w-full h-8 bg-gray-900 border border-gray-600 text-white px-2 rounded text-right focus:border-green-500" placeholder="0" /></td>
                                                            <td className="p-1 border border-gray-700"><input type="number" value={task.details?.monthlyData?.[month]?.[shop.key]?.purchase || ''} onChange={(e) => handleOrochiDataChange(index, month, shop.key, 'purchase', e.target.value)} className="w-full h-8 bg-gray-900 border border-gray-600 text-white px-2 rounded text-right focus:border-green-500" placeholder="0" /></td>
                                                            <td className="p-1 border border-gray-700"><input type="number" value={task.details?.monthlyData?.[month]?.[shop.key]?.fee || ''} onChange={(e) => handleOrochiDataChange(index, month, shop.key, 'fee', e.target.value)} className="w-full h-8 bg-gray-900 border border-gray-600 text-white px-2 rounded text-right focus:border-green-500" placeholder="0" /></td>
                                                        </tr>
                                                    ))}
                                                </React.Fragment>
                                            ))}
                                            <tr key="term-total" className="bg-gray-900/80 font-bold border-t-2 border-gray-500">
                                                <td colSpan={2} className="p-2 border border-gray-700 text-yellow-400 text-right">ECオロチ 期計</td>
                                                <td className="p-2 border border-gray-700 text-right text-yellow-400">{termOrochi.sales.toLocaleString()}</td>
                                                <td className="p-2 border border-gray-700 text-right text-yellow-400">{termOrochi.purchase.toLocaleString()}</td>
                                                <td className="p-2 border border-gray-700 text-right text-yellow-400">{termOrochi.fee.toLocaleString()}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>

                                {/* === その他事業（ECオロチとは独立） === */}
                                <div className="mt-6 overflow-x-auto">
                                    <div className="flex items-center justify-between mb-2">
                                        <h4 className="text-sm font-bold text-purple-300">🏷️ その他の事業（ECオロチ以外）</h4>
                                        <button onClick={() => handleAddOtherBusiness(index)} className="text-xs bg-purple-700 hover:bg-purple-600 text-white px-3 py-1 rounded flex items-center gap-1 border border-purple-500">
                                            <i className="fas fa-plus"></i> その他事業の枠を追加
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        {businesses.map((biz) => {
                                            const bizTerm = currentMonths.reduce((acc, m) => {
                                                const md = biz.monthlyData?.[m] || {};
                                                acc.sales += md.sales || 0; acc.purchase += md.purchase || 0; return acc;
                                            }, { sales: 0, purchase: 0 });
                                            return (
                                                <div key={biz.id} className="bg-purple-900/10 border border-purple-800/50 rounded-lg p-3">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <input type="text" value={biz.title} onChange={(e) => handleOtherTitleChange(index, biz.id, e.target.value)} className="flex-grow h-8 bg-gray-800 border border-purple-600 text-purple-100 px-2 rounded text-sm font-bold focus:border-purple-400" placeholder="事業名を入力" />
                                                        {businesses.length > 1 && (
                                                            <button onClick={() => handleDeleteOtherBusiness(index, biz.id)} title="この事業枠を削除" className="text-red-400 hover:text-red-300 px-1 flex-shrink-0"><i className="fas fa-trash"></i></button>
                                                        )}
                                                    </div>
                                                    <table className="w-full text-xs text-center border-collapse">
                                                        <thead><tr className="bg-gray-900 text-gray-400"><th className="p-1.5 border border-gray-700 w-14">月</th><th className="p-1.5 border border-gray-700 bg-yellow-900/10 text-yellow-200">売上</th><th className="p-1.5 border border-gray-700 bg-yellow-900/10 text-yellow-200">仕入</th></tr></thead>
                                                        <tbody>
                                                            {currentMonths.map(month => (
                                                                <tr key={month} className="hover:bg-gray-700">
                                                                    <td className="p-1 border border-gray-700 font-bold bg-gray-800">{getCalendarMonth(fullData?.closingMonth, month)}月</td>
                                                                    <td className="p-1 border border-gray-700"><input type="number" value={biz.monthlyData?.[month]?.sales || ''} onChange={(e) => handleOtherDataChange(index, biz.id, month, 'sales', e.target.value)} className="w-full h-7 bg-gray-900 border border-gray-600 text-white px-2 rounded text-right focus:border-purple-500" placeholder="0" /></td>
                                                                    <td className="p-1 border border-gray-700"><input type="number" value={biz.monthlyData?.[month]?.purchase || ''} onChange={(e) => handleOtherDataChange(index, biz.id, month, 'purchase', e.target.value)} className="w-full h-7 bg-gray-900 border border-gray-600 text-white px-2 rounded text-right focus:border-purple-500" placeholder="0" /></td>
                                                                </tr>
                                                            ))}
                                                            <tr className="bg-gray-900/80 font-bold border-t-2 border-gray-500">
                                                                <td className="p-1 border border-gray-700 text-purple-300 text-right">期計</td>
                                                                <td className="p-1 border border-gray-700 text-right text-purple-300">{bizTerm.sales.toLocaleString()}</td>
                                                                <td className="p-1 border border-gray-700 text-right text-purple-300">{bizTerm.purchase.toLocaleString()}</td>
                                                            </tr>
                                                        </tbody>
                                                    </table>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* === 総集計（ECオロチ + その他事業） === */}
                                <div className="mt-6 p-4 bg-gradient-to-r from-indigo-900/40 to-gray-900 border-2 border-indigo-500 rounded-lg shadow-lg">
                                    <h5 className="text-sm font-bold text-indigo-200 mb-3 flex items-center gap-2">
                                        <i className="fas fa-layer-group"></i> 総集計（第{activeTerm}期）　＝　ECオロチ合算 ＋ その他事業合算
                                    </h5>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="bg-gray-800 p-3 rounded border border-indigo-700">
                                            <div className="text-xs text-gray-400 mb-1">総売上高</div>
                                            <div className="text-2xl font-mono text-indigo-200">{termTotalSales.toLocaleString()} <span className="text-xs">円</span></div>
                                            <div className="text-[10px] text-gray-500 mt-1">オロチ {termOrochi.sales.toLocaleString()} ＋ その他 {termOther.sales.toLocaleString()}</div>
                                        </div>
                                        <div className="bg-gray-800 p-3 rounded border border-indigo-700">
                                            <div className="text-xs text-gray-400 mb-1">総仕入高</div>
                                            <div className="text-2xl font-mono text-indigo-200">{termTotalPurchase.toLocaleString()} <span className="text-xs">円</span></div>
                                            <div className="text-[10px] text-gray-500 mt-1">オロチ {termOrochi.purchase.toLocaleString()} ＋ その他 {termOther.purchase.toLocaleString()}</div>
                                        </div>
                                    </div>
                                </div>
                            </td>
                        </tr>
                        );
                    })()}

                    {openInputId === index && task.type === 'sales_check' && (
                        <tr className="bg-gray-800/80">
                            <td colSpan={5} className="px-4 py-4 border-b border-gray-700">
                                <div className="overflow-x-auto">
                                    <div className="flex items-center justify-between mb-2">
                                      <h4 className="text-sm font-bold text-blue-400">⚖️ 会計ソフト突合確認表</h4>
                                      {isAdmin && (fullData?.accountingSystem === 'mf' || fullData?.accountingSystem === 'freee') && termOfficeStatus === '承認完了' && (
                                        <button
                                          onClick={() => {
                                            if (window.confirm('この期は承認完了済みです。会計ソフトの最新値で売上・仕入を上書きしますか？')) {
                                              fetchMfPanelData(true);
                                            }
                                          }}
                                          className="text-[10px] bg-yellow-700 hover:bg-yellow-600 text-white px-2 py-1 rounded"
                                        >
                                          🔄 最新の会計ソフト値を再取得
                                        </button>
                                      )}
                                    </div>
                                    <table className="w-full text-xs text-center border-collapse min-w-[600px] mb-4">
                                        <thead><tr className="bg-gray-900 text-gray-400"><th className="p-2 border border-gray-700 w-16">月</th><th className="p-2 border border-gray-700 text-green-300">オロチ売上</th><th className="p-2 border border-gray-700 text-green-300">オロチ仕入</th><th className="p-2 border border-gray-700 text-blue-300 bg-blue-900/20">会計ソフト売上 (参考)</th><th className="p-2 border border-gray-700 text-blue-300 bg-blue-900/20">会計ソフト仕入 (判定対象)</th><th className="p-2 border border-gray-700">売上差異</th><th className="p-2 border border-gray-700 font-bold border-l-2 border-l-gray-500">仕入判定 (10%未満)</th></tr></thead>
                                        <tbody>
                                            {(() => {
                                                let termOrochiSales = 0;
                                                let termOrochiPurchase = 0;
                                                let termOrochiFee = 0;
                                                let termMfSales = 0;
                                                let termMfPurchase = 0;

                                                const rows = currentMonths.map(month => {
                                                    const orochiTask = tasks.find(t => t.no === "6");
                                                    const orochiTotal = calculateMonthlyTotal(orochiTask?.details?.monthlyData, month);
                                                    const mfData = task.details?.mfData?.[month] || { sales: 0, purchase: 0 };
                                                    
                                                    termOrochiSales += orochiTotal.sales;
                                                    termOrochiPurchase += orochiTotal.purchase;
                                                    termOrochiFee += orochiTotal.fee;
                                                    termMfSales += mfData.sales;
                                                    termMfPurchase += mfData.purchase;

                                                    const salesDiffVal = (orochiTotal.sales - orochiTotal.fee) - mfData.sales;
                                                    const salesDiffRate = mfData.sales ? (Math.abs(salesDiffVal) / mfData.sales) * 100 : 0;
                                                    const purchaseDiffVal = Math.abs(orochiTotal.purchase - mfData.purchase);
                                                    const purchaseDiffRate = mfData.purchase ? (purchaseDiffVal / mfData.purchase) * 100 : 0;
                                                    const isPurchaseOk = purchaseDiffRate <= 10;

                                                    return (
                                                        <tr key={month} className="hover:bg-gray-700">
                                                            <td className="p-2 border border-gray-700 font-bold">{getCalendarMonth(fullData?.closingMonth, month)}月</td>
                                                            <td className="p-2 border border-gray-700 text-right">{orochiTotal.sales.toLocaleString()}</td>
                                                            <td className="p-2 border border-gray-700 text-right">{orochiTotal.purchase.toLocaleString()}</td>
                                                            {(fullData?.accountingSystem === 'mf' || fullData?.accountingSystem === 'freee') ? (
                                                              <>
                                                                <td className="p-2 border border-gray-700 bg-blue-900/10 text-right text-blue-200">{mfData.sales ? mfData.sales.toLocaleString() : '-'}</td>
                                                                <td className="p-2 border border-gray-700 bg-blue-900/10 text-right text-blue-200">{mfData.purchase ? mfData.purchase.toLocaleString() : '-'}</td>
                                                              </>
                                                            ) : (
                                                              <>
                                                                <td className="p-2 border border-gray-700 bg-blue-900/10"><input type="number" value={mfData.sales || ''} onChange={(e) => handleMfDataChange(index, month, 'sales', e.target.value)} className="w-full h-8 bg-gray-800 border border-gray-600 text-white px-2 rounded text-right focus:border-blue-500" placeholder="会計ソフト売上" /></td>
                                                                <td className="p-2 border border-gray-700 bg-blue-900/10"><input type="number" value={mfData.purchase || ''} onChange={(e) => handleMfDataChange(index, month, 'purchase', e.target.value)} className="w-full h-8 bg-gray-800 border border-gray-600 text-white px-2 rounded text-right focus:border-blue-500" placeholder="会計ソフト仕入" /></td>
                                                              </>
                                                            )}
                                                            <td className="p-2 border border-gray-700 text-right text-gray-400">{mfData.sales ? <span>{salesDiffRate.toFixed(1)}% <span className="text-[9px] block text-gray-500">(入金ズレ)</span></span> : '-'}</td>
                                                            <td className={`p-2 border-t border-b border-r border-gray-700 border-l-2 border-l-gray-500 text-center font-bold ${isPurchaseOk ? 'text-green-400' : 'text-red-400'}`}>{mfData.purchase > 0 ? (isPurchaseOk ? 'OK' : '要確認') : '-'}{mfData.purchase > 0 && <div className="text-[9px] font-normal opacity-70">差異:{purchaseDiffRate.toFixed(1)}%</div>}</td>
                                                        </tr>
                                                    );
                                                });

                                                const termSalesDiffVal = (termOrochiSales - termOrochiFee) - termMfSales;
                                                const termSalesDiffRate = termMfSales ? (Math.abs(termSalesDiffVal) / termMfSales) * 100 : 0;
                                                const termPurchaseDiffVal = Math.abs(termOrochiPurchase - termMfPurchase);
                                                const termPurchaseDiffRate = termMfPurchase ? (termPurchaseDiffVal / termMfPurchase) * 100 : 0;
                                                const isTermPurchaseOk = termPurchaseDiffRate <= 10;

                                                rows.push(
                                                    <tr key="term-total" className="bg-gray-900/80 font-bold border-t-2 border-gray-500">
                                                        <td className="p-2 border border-gray-700 text-yellow-400">期計</td>
                                                        <td className="p-2 border border-gray-700 text-right text-yellow-400">{termOrochiSales.toLocaleString()}</td>
                                                        <td className="p-2 border border-gray-700 text-right text-yellow-400">{termOrochiPurchase.toLocaleString()}</td>
                                                        <td className="p-2 border border-gray-700 text-right text-blue-300">{termMfSales.toLocaleString()}</td>
                                                        <td className="p-2 border border-gray-700 text-right text-blue-300">{termMfPurchase.toLocaleString()}</td>
                                                        <td className="p-2 border border-gray-700 text-right text-gray-400">{termMfSales ? <span>{termSalesDiffRate.toFixed(1)}%</span> : '-'}</td>
                                                        <td className={`p-2 border-t border-b border-r border-gray-700 border-l-2 border-l-gray-500 text-center font-bold ${isTermPurchaseOk ? 'text-green-400' : 'text-red-400'}`}>
                                                            {termMfPurchase > 0 ? (isTermPurchaseOk ? 'OK' : '要確認') : '-'}
                                                            {termMfPurchase > 0 && <div className="text-[9px] font-normal opacity-70">差異:{termPurchaseDiffRate.toFixed(1)}%</div>}
                                                        </td>
                                                    </tr>
                                                );

                                                return rows;
                                            })()}
                                        </tbody>
                                    </table>

                                    {/* ★ 修正: 年間合計パネルに販売手数料を追加 */}
                                    {(() => {
                                        const yearly = calculateYearlyTotal();
                                        const yearlySalesDiffVal = (yearly.yearlyOrochiSales - yearly.yearlyOrochiFee) - yearly.yearlyMfSales;
                                        const yearlySalesDiffRate = yearly.yearlyMfSales ? (Math.abs(yearlySalesDiffVal) / yearly.yearlyMfSales) * 100 : 0;
                                        const yearlyPurchaseDiffVal = Math.abs(yearly.yearlyOrochiPurchase - yearly.yearlyMfPurchase);
                                        const yearlyPurchaseDiffRate = yearly.yearlyMfPurchase ? (yearlyPurchaseDiffVal / yearly.yearlyMfPurchase) * 100 : 0;
                                        const isYearlyPurchaseOk = yearlyPurchaseDiffRate <= 10;

                                        return (
                                            <div className="mt-4 p-4 bg-gray-900 border border-gray-600 rounded-lg shadow-inner">
                                                <h5 className="text-sm font-bold text-yellow-400 mb-3 flex items-center gap-2">
                                                    <i className="fas fa-chart-line"></i> {getFiscalYearLabel(fullData?.closingMonth, currentYear)} 年間合計 (第1期〜第3期合算)
                                                </h5>
                                                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                                                    <div className="bg-gray-800 p-3 rounded border border-gray-700 flex flex-col justify-center">
                                                        <div className="text-xs text-gray-400 mb-1">オロチ売上 (年間)</div>
                                                        <div className="text-xl font-mono text-green-300">{yearly.yearlyOrochiSales.toLocaleString()} <span className="text-xs">円</span></div>
                                                    </div>
                                                    <div className="bg-gray-800 p-3 rounded border border-gray-700 flex flex-col justify-center">
                                                        <div className="text-xs text-gray-400 mb-1">オロチ手数料 (年間)</div>
                                                        <div className="text-xl font-mono text-yellow-300">△ {yearly.yearlyOrochiFee.toLocaleString()} <span className="text-xs">円</span></div>
                                                    </div>
                                                    <div className="bg-blue-900/20 p-3 rounded border border-blue-900/50 flex flex-col justify-center relative overflow-hidden">
                                                        <div className="text-xs text-blue-200 mb-1">会計ソフト売上 (年間)</div>
                                                        <div className="text-xl font-mono text-blue-300">{yearly.yearlyMfSales.toLocaleString()} <span className="text-xs">円</span></div>
                                                        <div className="text-xs text-gray-400 mt-1">差異: {yearlySalesDiffRate.toFixed(1)}%</div>
                                                    </div>
                                                    <div className="bg-gray-800 p-3 rounded border border-gray-700 flex flex-col justify-center">
                                                        <div className="text-xs text-gray-400 mb-1">オロチ仕入 (年間)</div>
                                                        <div className="text-xl font-mono text-green-300">{yearly.yearlyOrochiPurchase.toLocaleString()} <span className="text-xs">円</span></div>
                                                    </div>
                                                    <div className={`p-3 rounded border flex flex-col justify-center ${isYearlyPurchaseOk ? 'bg-green-900/20 border-green-900/50' : 'bg-red-900/20 border-red-900/50'}`}>
                                                        <div className="flex justify-between items-start mb-1">
                                                            <div className={`text-xs ${isYearlyPurchaseOk ? 'text-green-200' : 'text-red-200'}`}>会計ソフト仕入 (年間)</div>
                                                            <span className={`text-xs font-bold px-2 py-0.5 rounded ${isYearlyPurchaseOk ? 'bg-green-800 text-green-100' : 'bg-red-800 text-red-100'}`}>
                                                                {yearly.yearlyMfPurchase > 0 ? (isYearlyPurchaseOk ? 'OK' : '要確認') : '未判定'}
                                                            </span>
                                                        </div>
                                                        <div className="text-xl font-mono text-white">{yearly.yearlyMfPurchase.toLocaleString()} <span className="text-xs">円</span></div>
                                                        <div className="text-xs text-gray-400 mt-1">差異: {yearlyPurchaseDiffRate.toFixed(1)}%</div>
                                                    </div>
                                                </div>

                                                {/* ★ 要件3: 総売上高・総仕入高 (ECオロチ + その他事業) */}
                                                <div className="mt-4 pt-4 border-t border-gray-700 grid grid-cols-2 gap-4">
                                                    <div className="bg-indigo-900/30 p-3 rounded border-2 border-indigo-500 flex flex-col justify-center">
                                                        <div className="text-xs text-indigo-200 mb-1">総売上高 (年間)　＝ オロチ ＋ その他事業</div>
                                                        <div className="text-2xl font-mono text-indigo-100">{yearly.yearlyTotalSales.toLocaleString()} <span className="text-xs">円</span></div>
                                                        <div className="text-[10px] text-gray-400 mt-1">オロチ {yearly.yearlyOrochiSales.toLocaleString()} ＋ その他 {yearly.yearlyOtherSales.toLocaleString()}</div>
                                                    </div>
                                                    <div className="bg-indigo-900/30 p-3 rounded border-2 border-indigo-500 flex flex-col justify-center">
                                                        <div className="text-xs text-indigo-200 mb-1">総仕入高 (年間)　＝ オロチ ＋ その他事業</div>
                                                        <div className="text-2xl font-mono text-indigo-100">{yearly.yearlyTotalPurchase.toLocaleString()} <span className="text-xs">円</span></div>
                                                        <div className="text-[10px] text-gray-400 mt-1">オロチ {yearly.yearlyOrochiPurchase.toLocaleString()} ＋ その他 {yearly.yearlyOtherPurchase.toLocaleString()}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            </td>
                        </tr>
                    )}

                    {openManualId === index && task.manual && (
                        <tr className="bg-gray-800/50">
                            <td colSpan={5} className="px-4 py-3 border-b border-gray-700">
                                <div className="manual-content bg-white border-2 border-blue-500 rounded p-4 text-sm text-gray-800 leading-relaxed shadow-lg">
                                    <div className="flex items-center gap-2 mb-3 text-blue-600 font-bold border-b border-gray-200 pb-2">
                                        <i className="fas fa-book-open"></i> 作業手順・ポイント
                                    </div>
                                    <div dangerouslySetInnerHTML={{ __html: task.manual }} />
                                </div>
                            </td>
                        </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-center mb-12">
              <button 
                onClick={handleSubmit}
                disabled={clientStatus === '完了'}
                className={`px-8 py-3 rounded font-bold text-white shadow-lg transition-all transform hover:scale-105 flex items-center gap-2 ${
                    clientStatus === '完了' 
                    ? 'bg-gray-600 cursor-not-allowed opacity-70' 
                    : 'bg-blue-600 hover:bg-blue-500'
                }`}
              >
                {clientStatus === '完了' ? (
                    <>
                        <i className="fas fa-check-circle"></i> 提出済み
                    </>
                ) : (
                    <>
                        <i className="fas fa-paper-plane"></i> 作業を完了して提出する
                    </>
                )}
              </button>
          </div>
      </div>

      <footer className="mt-12 border-t border-gray-800 pt-6 pb-2 text-center">
          <div className="flex flex-col items-center justify-center gap-2">
              <img src="/images/logo.png" alt="Ohara Management Systems Logo" className="h-8 mb-1 opacity-80" onError={(e) => e.currentTarget.style.display = 'none'} />
              <p className="text-gray-500 text-xs">
                  システム管理・運営：㈱オハラ・マネジメント・システムズ
              </p>
              <p className="text-gray-600 text-[10px]">
                  &copy; Tax Accountant Tsukasa Ohara Office. All Rights Reserved.
              </p>
          </div>
      </footer>
    </div>
  );
}

export default function ClientDetail() {
  return (
    <Suspense fallback={<div className="p-8 text-white">読み込み中...</div>}>
      <DetailContent />
    </Suspense>
  );
}