"use client";

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { db, auth } from '../../../lib/firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

// 店舗リスト
const SHOPS = ['Yahoo!', '楽天市場', 'Amazon', 'au PAY', 'Qoo10', 'その他'];

// 期ごとの対象月定義
const TERM_MONTHS = {
  1: [1, 2, 3, 4, 5],
  2: [6, 7, 8, 9],
  3: [10, 11, 12]
};

// ★通常タスク (No.1～13)
const INITIAL_TASKS = [
  { 
    no: "1", name: '連携の認証の切れた預金・カードの再認証', clientInput: '不要', officeStatus: 'OK',
    manual: `<div class="note"><p><i class="fas fa-exclamation-triangle"></i> <strong>注意：</strong> 再認証を長期間行わないと、明細が取得できなくなり、月次処理に支障が出ます。</p></div><p><strong>手順：</strong></p><ol><li>マネーフォワードのトップページや「口座」メニューから連携口座一覧を表示します。</li><li>エラーが表示されている口座（「要再認証」など）の「<span class="action-target">再認証</span>」または「<span class="action-target">更新</span>」ボタンをクリックします。</li><li>画面の指示に従い、金融機関のサイトでID・パスワード等を入力して再認証を完了させてください。</li></ol>` 
  },
  { 
    no: "2", name: '預金の仕訳登録', clientInput: '', officeStatus: '未',
    manual: `<p>銀行口座の入出金明細を確認し、適切な仕訳を登録します。</p><div class="note"><p><i class="fas fa-lightbulb"></i> <strong>ポイント：</strong> 家賃や光熱費などの定期的な支払いは「自動仕訳ルール」を設定すると効率的です。</p></div>`
  },
  { 
    no: "3", name: 'クレジットカードの仕訳登録', clientInput: '', officeStatus: '未',
    manual: `<p>クレジットカードの利用明細を仕訳登録します。</p><div class="visual-aid-container" style="text-align:left; margin-bottom: 20px;"><h4 style="margin-top:0;">月次作業フロー</h4><ol><li>「連携サービスから入力」画面で対象のカードを選択。</li><li>利用内容に応じた「勘定科目」を選択して登録。</li><li><strong>重要：</strong>貸方科目が「未払金」、補助科目が指定のものになっているか確認。</li></ol></div><details style="border: 1px solid #f1c40f; border-radius: 4px; background-color: #fffdf5;"><summary style="cursor:pointer; padding: 10px; font-weight:bold; color: #d35400; outline:none;"><i class="fas fa-exclamation-triangle"></i> 【重要】設定・入力ミスの防止</summary><div style="padding: 15px; border-top: 1px solid #f1c40f; font-size: 0.95em;"><p><strong>補助科目の集約：</strong>一つのカードで複数の補助科目ができないよう、名称を統一してください。</p></div></details>`
  },
  { 
    no: "3(2)", name: '仕訳取り込みツールにてクレジットカード取り込み', clientInput: '', officeStatus: '未',
    manual: `<p>専用のCSV変換ツールを使用して、大量のカード明細を一括で取り込む手順です。</p>`
  },
  { 
    no: "4", name: '現金の仕訳登録', clientInput: '', officeStatus: '未',
    manual: `<p>手元にある領収書・レシート（現金払い分）を入力します。</p>`
  },
  { 
    no: "5", name: '各ECサイトからの入金明細、出店料の明細をダウンロードして保管', clientInput: '', officeStatus: '未',
    manual: `<p>各ECサイトの管理画面から、当月分の明細をダウンロードし、<strong>Googleドライブ</strong>の指定フォルダに保管してください。</p><p>各サイトの明細の見方は以下を参照してください。</p><div class="visual-aid-container"><h4 style="margin-top:0;">Yahoo!ショッピング明細の例</h4><img src="/images/manual/yahoo_sample.png" alt="Yahoo明細見本" style="max-width:100%; border:1px solid #ddd; margin-bottom:15px;"><h4 style="margin-top:0;">楽天市場明細の例</h4><img src="/images/manual/rakuten_sample.png" alt="楽天明細見本" style="max-width:100%; border:1px solid #ddd;"></div>`
  },
  { 
    no: "6", name: 'ECオロチから「売上仕入」シートに入力（売上・仕入・手数料）', clientInput: '', officeStatus: '未',
    type: 'sales_input',
    details: { monthlyData: {} },
    manual: `<p>ECオロチの集計データを店舗ごとに入力してください。</p><div class="note"><p><strong><i class="fas fa-calculator"></i> 手数料の考え方（決算整理時）</strong></p><p>ECオロチの手数料は「理論値」であり、実際のキャンペーン割引等は反映されていません。</p><p>そのため、決算時の仕訳では、以下の計算式で手数料を算出することを推奨します（逆算アプローチ）。</p><code class="code-like">実際の手数料 = ECオロチ売上(総額) - MF入金額(純額)</code><p>※これにより、割引適用後の「正しい経費」が自動的に計上されます。</p></div>`
  },
  { 
    no: "7", name: '売上仕入集計とMF損益計算書の比較確認（仕入差異チェック）', clientInput: '', officeStatus: '未',
    type: 'sales_check',
    details: { mfData: {} },
    manual: `<div class="attention"><p><strong><i class="fas fa-balance-scale"></i> 判定基準とロジック</strong></p><ul><li><strong>仕入（Purchases）：</strong> <span style="color:red;">重要チェック項目</span>です。クレカ連携ズレは数日程度のため、<strong>誤差10%以内</strong>であることを確認します。</li><li><strong>売上・手数料（Sales）：</strong> 入金サイクル（約2週間）のズレにより、単月では一致しません。</li></ul></div><div class="visual-aid-container" style="text-align:left;"><h4>手数料の差異について（理論値 vs 実数値）</h4><p>ECオロチの手数料（理論値）より、実際の入金から計算した手数料が<strong>安い（入金が多い）場合</strong>は、キャンペーン割引等の「有利差異」であるため、<strong>問題ありません。</strong></p><p>逆に、理論値よりも手数料が著しく高い（入金が少なすぎる）場合は、以下の原因を確認してください。</p><ul><li>返金・キャンセル処理の反映漏れ</li><li>その他、予期せぬペナルティや調整金の発生</li></ul></div>`
  },
  { 
    no: "8", name: 'MF未払金残高の過少・過大確認（マイナス残高等）', clientInput: '', officeStatus: '未',
    manual: `<p>マネーフォワードの貸借対照表で「未払金」の残高を確認します。</p>`
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
    manual: `<p>事業用カードでプライベートなAmazon購入をした場合、その金額を入力してください。</p>`
  },
  { 
    no: "12", name: '仕入時Amazonポイントの私用使用分の金額記入', clientInput: '', officeStatus: '未',
    manual: `<div class="attention"><p>事業で貯めたポイントを個人利用した場合、その額を入力してください。</p></div>`
  },
  // No.13 特記事項 (テキストエリア)
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
    manual: `<p>タスクNo.7と同様の手順で、年間の売上・仕入についてECオロチとマネーフォワードに大きな乖離がないか最終確認を行ってください。</p>`
  },
  { 
    no: "21", name: '[決算] 預金残高の一致確認（MF vs 通帳）', clientInput: '', officeStatus: '未',
    manual: `
      <p>マネーフォワードの「残高試算表」の12/31時点の預金残高が、実際の通帳残高と1円単位で一致しているか確認してください。</p>
      <p>一致していない場合、利息の計上漏れや、日付のズレがないか確認してください。</p>
    `
  },
  { 
    no: "22", name: '[決算] 未払金残高の一致確認（カード利用分）', clientInput: '', officeStatus: '未',
    manual: `
      <p>マネーフォワードの「未払金」残高が、<strong>翌年1月・2月引き落とし予定額の合計（※12月利用分まで）</strong>と一致しているか確認してください。</p>
    `
  },
  { 
    no: "23", name: '[決算] 売掛金残高の一致確認（売上入金待ち）', clientInput: '', officeStatus: '未',
    manual: `
      <p>マネーフォワードの「売掛金」残高が、上記No.16～19で計上した「年末売上（未入金分）」の合計と一致しているか確認してください。</p>
    `
  },
  { 
    no: "24", name: '[決算] マイナス残高の確認・修正', clientInput: '', officeStatus: '未',
    manual: `
      <p>残高試算表（貸借対照表）を見て、残高がマイナスになっている科目（△表示）がないか確認してください。</p>
      <p>マイナスの場合は仕訳ミスや計上漏れの可能性が高いため、修正が必要です。</p>
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
  const [currentYear, setCurrentYear] = useState(urlYear ? parseInt(urlYear) : 2026);

  const [activeTerm, setActiveTerm] = useState(1);
  const [clientName, setClientName] = useState('');
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | 'changed'>('saved');
  const [fullData, setFullData] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [openManualId, setOpenManualId] = useState<number | null>(null);
  const [openInputId, setOpenInputId] = useState<number | null>(null);
  
  // 顧問先ステータス
  const [clientStatus, setClientStatus] = useState<'未着手' | '進行中' | '完了'>('未着手');

  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  // 年度変更時に再ロード
  useEffect(() => {
    if (fullData) {
        loadTasksForTerm(fullData, activeTerm, currentYear);
    }
  }, [currentYear]);

  const loadTasksForTerm = (data: any, term: number, year: number) => {
    const termKey = `year_${year}_term${term}_tasks`;
    const savedTasks = data[termKey];
    
    // 保存されたステータスを読み込む
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
  };

  const saveDataToFirestore = async (currentTasks: any[], term: number, year: number, newClientStatus?: string) => {
    if (!clientId) return;
    setSaveStatus('saving');
    try {
      const docRef = doc(db, "clients", clientId);
      const total = currentTasks.length;
      const completed = currentTasks.filter((t: any) => t.officeStatus === 'OK').length;
      const isStarted = currentTasks.some((t: any) => t.officeStatus === 'OK' || t.officeStatus === '要確認');
      
      let newOfficeStatus = '未チェック';
      if (completed === total) newOfficeStatus = '承認完了';
      else if (isStarted) newOfficeStatus = 'チェック中';

      const termKey = `year_${year}_term${term}_tasks`;
      const officeStatusKey = `year_${year}.term${term}.officeStatus`;
      const clientStatusKey = `year_${year}.term${term}.clientStatus`;

      const statusToSave = newClientStatus || clientStatus;

      await updateDoc(docRef, {
        [termKey]: currentTasks,
        [officeStatusKey]: newOfficeStatus,
        [clientStatusKey]: statusToSave
      });

      setFullData((prev: any) => {
        const newYearData = prev[`year_${year}`] || {};
        const newTermData = newYearData[`term${term}`] || {};
        return {
          ...prev,
          [termKey]: currentTasks,
          [`year_${year}`]: {
            ...newYearData,
            [`term${term}`]: { 
                ...newTermData, 
                officeStatus: newOfficeStatus,
                clientStatus: statusToSave 
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

  // 提出アクション
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

  const handleOrochiDataChange = (taskIndex: number, month: number, shop: string, field: string, value: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = newTasks[taskIndex];
    if (!task.details) task.details = { monthlyData: {} };
    if (!task.details.monthlyData[month]) task.details.monthlyData[month] = {};
    if (!task.details.monthlyData[month][shop]) task.details.monthlyData[month][shop] = {};
    task.details.monthlyData[month][shop][field] = value === '' ? 0 : parseFloat(value);
    task.clientInput = "詳細データ入力済";
    
    setTasks(newTasks);
    const newStatus = updateStatusToInProgress();
    triggerAutoSave(newTasks, newStatus);
  };

  const handleMfDataChange = (taskIndex: number, month: number, field: string, value: string) => {
    setSaveStatus('changed');
    const newTasks = [...tasks];
    const task = newTasks[taskIndex];
    if (!task.details) task.details = { mfData: {} };
    if (!task.details.mfData[month]) task.details.mfData[month] = {};
    task.details.mfData[month][field] = value === '' ? 0 : parseFloat(value);
    
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

  if (loading) return <div className="p-8 text-white">データを読み込んでいます...</div>;
  if (!clientId) return <div className="p-8 text-white">URLが無効です</div>;

  const currentMonths = TERM_MONTHS[activeTerm as keyof typeof TERM_MONTHS];

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 flex flex-col">
      <div className="flex-grow">
          {/* ヘッダー */}
          <div className="mb-4 flex items-center justify-between border-b border-gray-800 pb-4">
            <div className="flex items-center gap-4">
              {isAdmin && (
                <button onClick={() => router.push('/dashboard')} className="text-gray-400 hover:text-white flex items-center text-sm transition-colors border border-gray-700 px-3 py-1 rounded">← 一覧</button>
              )}
              <div>
                <div className="text-[10px] text-gray-400 mb-0.5">税理士小原司事務所</div>
                <h1 className="text-xl font-bold flex items-center gap-2">{clientName}</h1>
                <div className="mt-1">
                  <select 
                    value={currentYear} 
                    onChange={(e) => handleYearChange(Number(e.target.value))}
                    className="bg-gray-800 border border-gray-600 text-white text-xs rounded px-2 py-1 focus:ring-1 focus:ring-blue-500"
                  >
                    <option value={2025}>2025年度</option>
                    <option value={2026}>2026年度</option>
                    <option value={2027}>2027年度</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="flex items-center space-x-3">
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
          </div>

          <div className="flex border-b border-gray-700 mb-4">
            {[1, 2, 3].map((term) => (
              <button key={term} onClick={() => handleTabChange(term)} className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${activeTerm === term ? 'border-blue-500 text-blue-400 bg-gray-800/50' : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'}`}>
                第{term}期 ({TERM_MONTHS[term as keyof typeof TERM_MONTHS][0]}月～{TERM_MONTHS[term as keyof typeof TERM_MONTHS][TERM_MONTHS[term as keyof typeof TERM_MONTHS].length-1]}月)
              </button>
            ))}
          </div>

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
                <span className="text-[10px] text-yellow-500 bg-yellow-900/20 px-2 py-0.5 rounded border border-yellow-800">※黄色セルは入力必須</span>
            </div>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-900 text-gray-400 text-xs border-b border-gray-700">
                  <th className="px-2 py-2 w-10 text-center border-r border-gray-700">No</th>
                  <th className="px-3 py-2 border-r border-gray-700">確認項目</th>
                  <th className="px-2 py-2 w-32 border-r border-gray-700">顧問先入力</th>
                  <th className="px-2 py-2 w-24 border-r border-gray-700">事務所判定</th>
                  <th className="px-3 py-2 w-64">管理者メモ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700 text-sm">
                {tasks.map((task, index) => (
                  <React.Fragment key={index}>
                    <tr className="hover:bg-gray-750 transition-colors group">
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
                      
                      <td className="px-2 py-2 border-r border-gray-700 align-top pt-3">
                        {task.type === 'textarea' ? (
                            <textarea value={task.clientInput || ''} onChange={(e) => handleInputChange(index, 'clientInput', e.target.value)} className="w-full text-xs px-2 py-1 rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 bg-gray-700 border-gray-600 text-white" style={{ minHeight: '120px', lineHeight: '1.4' }} placeholder="PC購入(15万)、○○システム前払い等" />
                        ) : (
                            <input type="text" value={task.clientInput || ''} readOnly={task.type === 'sales_input' || task.type === 'sales_check'} onChange={(e) => handleInputChange(index, 'clientInput', e.target.value)} className={`w-full text-xs px-2 py-1 rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 h-7 ${(task.type === 'sales_input' || task.type === 'sales_check') ? 'bg-gray-900 border-gray-800 text-gray-400 cursor-not-allowed' : task.clientInput ? 'bg-gray-700 border-gray-600 text-white' : 'bg-yellow-900/20 border-yellow-700/50 text-yellow-200 placeholder-yellow-700'}`} placeholder={(task.type === 'sales_input' || task.type === 'sales_check') ? "ボタンから入力" : ""} />
                        )}
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

                    {/* Input Form & Manual rendering */}
                    {openInputId === index && task.type === 'sales_input' && (
                        <tr className="bg-gray-800/80">
                            <td colSpan={5} className="px-4 py-4 border-b border-gray-700">
                                <div className="overflow-x-auto">
                                    <h4 className="text-sm font-bold text-green-400 mb-2">📊 ECオロチ集計データ入力</h4>
                                    <table className="w-full text-xs text-center border-collapse min-w-[600px]">
                                        <thead><tr className="bg-gray-900 text-gray-400"><th className="p-2 border border-gray-700 w-16">月</th><th className="p-2 border border-gray-700">店舗</th><th className="p-2 border border-gray-700 bg-yellow-900/10 text-yellow-200">売上合計</th><th className="p-2 border border-gray-700 bg-yellow-900/10 text-yellow-200">仕入合計</th><th className="p-2 border border-gray-700 bg-yellow-900/10 text-yellow-200">手数料合計</th></tr></thead>
                                        <tbody>
                                            {currentMonths.map(month => (
                                                <React.Fragment key={month}>
                                                    {SHOPS.map((shop, shopIndex) => (
                                                        <tr key={`${month}-${shop}`} className="hover:bg-gray-700">
                                                            {shopIndex === 0 && <td rowSpan={SHOPS.length} className="p-2 border border-gray-700 font-bold bg-gray-800">{month}月</td>}
                                                            <td className="p-2 border border-gray-700">{shop}</td>
                                                            <td className="p-1 border border-gray-700"><input type="number" value={task.details?.monthlyData?.[month]?.[shop]?.sales || ''} onChange={(e) => handleOrochiDataChange(index, month, shop, 'sales', e.target.value)} className="w-full h-8 bg-gray-900 border border-gray-600 text-white px-2 rounded text-right focus:border-green-500" placeholder="0" /></td>
                                                            <td className="p-1 border border-gray-700"><input type="number" value={task.details?.monthlyData?.[month]?.[shop]?.purchase || ''} onChange={(e) => handleOrochiDataChange(index, month, shop, 'purchase', e.target.value)} className="w-full h-8 bg-gray-900 border border-gray-600 text-white px-2 rounded text-right focus:border-green-500" placeholder="0" /></td>
                                                            <td className="p-1 border border-gray-700"><input type="number" value={task.details?.monthlyData?.[month]?.[shop]?.fee || ''} onChange={(e) => handleOrochiDataChange(index, month, shop, 'fee', e.target.value)} className="w-full h-8 bg-gray-900 border border-gray-600 text-white px-2 rounded text-right focus:border-green-500" placeholder="0" /></td>
                                                        </tr>
                                                    ))}
                                                </React.Fragment>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </td>
                        </tr>
                    )}

                    {openInputId === index && task.type === 'sales_check' && (
                        <tr className="bg-gray-800/80">
                            <td colSpan={5} className="px-4 py-4 border-b border-gray-700">
                                <div className="overflow-x-auto">
                                    <h4 className="text-sm font-bold text-blue-400 mb-2">⚖️ マネーフォワード突合確認表</h4>
                                    <table className="w-full text-xs text-center border-collapse min-w-[600px]">
                                        <thead><tr className="bg-gray-900 text-gray-400"><th className="p-2 border border-gray-700 w-16">月</th><th className="p-2 border border-gray-700 text-green-300">オロチ売上</th><th className="p-2 border border-gray-700 text-green-300">オロチ仕入</th><th className="p-2 border border-gray-700 text-blue-300 bg-blue-900/20">MF売上 (参考)</th><th className="p-2 border border-gray-700 text-blue-300 bg-blue-900/20">MF仕入 (判定対象)</th><th className="p-2 border border-gray-700">売上差異</th><th className="p-2 border border-gray-700 font-bold border-l-2 border-l-gray-500">仕入判定 (10%未満)</th></tr></thead>
                                        <tbody>
                                            {currentMonths.map(month => {
                                                const orochiTask = tasks.find(t => t.no === "6");
                                                const orochiTotal = calculateMonthlyTotal(orochiTask?.details?.monthlyData, month);
                                                const mfData = task.details?.mfData?.[month] || { sales: 0, purchase: 0 };
                                                const salesDiffVal = (orochiTotal.sales - orochiTotal.fee) - mfData.sales;
                                                const salesDiffRate = mfData.sales ? (Math.abs(salesDiffVal) / mfData.sales) * 100 : 0;
                                                const purchaseDiffVal = Math.abs(orochiTotal.purchase - mfData.purchase);
                                                const purchaseDiffRate = mfData.purchase ? (purchaseDiffVal / mfData.purchase) * 100 : 0;
                                                const isPurchaseOk = purchaseDiffRate <= 10;

                                                return (
                                                    <tr key={month} className="hover:bg-gray-700">
                                                        <td className="p-2 border border-gray-700 font-bold">{month}月</td>
                                                        <td className="p-2 border border-gray-700 text-right">{orochiTotal.sales.toLocaleString()}</td>
                                                        <td className="p-2 border border-gray-700 text-right">{orochiTotal.purchase.toLocaleString()}</td>
                                                        <td className="p-2 border border-gray-700 bg-blue-900/10"><input type="number" value={mfData.sales || ''} onChange={(e) => handleMfDataChange(index, month, 'sales', e.target.value)} className="w-full h-8 bg-gray-800 border border-gray-600 text-white px-2 rounded text-right focus:border-blue-500" placeholder="MF売上" /></td>
                                                        <td className="p-2 border border-gray-700 bg-blue-900/10"><input type="number" value={mfData.purchase || ''} onChange={(e) => handleMfDataChange(index, month, 'purchase', e.target.value)} className="w-full h-8 bg-gray-800 border border-gray-600 text-white px-2 rounded text-right focus:border-blue-500" placeholder="MF仕入" /></td>
                                                        <td className="p-2 border border-gray-700 text-right text-gray-400">{mfData.sales ? <span>{salesDiffRate.toFixed(1)}% <span className="text-[9px] block text-gray-500">(入金ズレ)</span></span> : '-'}</td>
                                                        <td className={`p-2 border-t border-b border-r border-gray-700 border-l-2 border-l-gray-500 text-center font-bold ${isPurchaseOk ? 'text-green-400' : 'text-red-400'}`}>{mfData.purchase > 0 ? (isPurchaseOk ? 'OK' : '要確認') : '-'}{mfData.purchase > 0 && <div className="text-[9px] font-normal opacity-70">差異:{purchaseDiffRate.toFixed(1)}%</div>}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
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