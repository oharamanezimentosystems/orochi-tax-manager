'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, CheckSquare, Square, AlertTriangle, ExternalLink } from 'lucide-react';

// ▼ 型定義
type TaskStatus = 'pending' | 'completed';

// ▼ モックデータ：手順5の入力フォーム用
const SALES_FORM_DEFAULT = {
  orochiSales: 0,
  orochiCost: 0,
  orochiFee: 0,
  amazonPoints: 0,
  mfSales: 0,
  mfCost: 0,
};

export default function ClientPage() {
  // 状態管理
  const [tasks, setTasks] = useState({
    task1: false,
    task2: false,
    task5: false,
  });
  const [salesData, setSalesData] = useState(SALES_FORM_DEFAULT);
  const [manualOpen, setManualOpen] = useState<string | null>(null);

  // マニュアル開閉トグル
  const toggleManual = (id: string) => {
    setManualOpen(manualOpen === id ? null : id);
  };

  // タスク完了トグル
  const toggleTask = (key: string) => {
    setTasks((prev) => ({ ...prev, [key]: !prev[key as keyof typeof tasks] }));
  };

  // ---------------------------------------------------------
  // 計算ロジック (要件定義書 4-2準拠)
  // ---------------------------------------------------------
  const orochiNetSales = salesData.orochiSales - salesData.orochiFee; // 手数料控除後
  const diffAmount = Math.abs(orochiNetSales - salesData.mfSales);
  const diffRatio = salesData.mfSales > 0 ? diffAmount / salesData.mfSales : 0;
  const isAlert = diffRatio > 0.1; // 10%超えでアラート

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 pb-20">
      {/* ヘッダー */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-lg font-bold text-gray-900">月次作業報告</h1>
            <p className="text-sm text-gray-500">2025年 第1期（対象：1月分）</p>
          </div>
          <div className="text-right text-sm">
            <span className="block text-gray-500">提出期限</span>
            <span className="font-bold text-red-600">あと15日</span>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        
        {/* --- タスク1: 通常のチェック系 --- */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-4 flex items-start gap-3">
            <button 
              onClick={() => toggleTask('task1')}
              className="mt-1 text-gray-400 hover:text-blue-600 transition-colors"
            >
              {tasks.task1 ? <CheckSquare className="w-6 h-6 text-blue-600" /> : <Square className="w-6 h-6" />}
            </button>
            <div className="flex-1">
              <div className="flex justify-between items-center mb-1">
                <h3 className="font-bold text-gray-900">１．連携の認証が切れた預金・カードの再認証</h3>
                <button 
                  onClick={() => toggleManual('task1')}
                  className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                >
                  {manualOpen === 'task1' ? '手順を閉じる' : '手順を見る'}
                  {manualOpen === 'task1' ? <ChevronDown className="w-4 h-4"/> : <ChevronRight className="w-4 h-4"/>}
                </button>
              </div>
              <p className="text-sm text-gray-500">マネーフォワードの連携ステータスを確認し、エラーが出ていないかチェックしてください。</p>

              {/* ▼▼▼ マニュアル展開エリア (HTML埋め込み想定) ▼▼▼ */}
              {manualOpen === 'task1' && (
                <div className="mt-4 p-4 bg-blue-50 rounded border border-blue-100 text-sm animate-in fade-in slide-in-from-top-2">
                  <h4 className="font-bold text-blue-800 mb-2">【作業手順】</h4>
                  <p className="mb-2">1. マネーフォワードにログインします。</p>
                  <p className="mb-2">2. トップページの口座一覧を確認し、<span className="text-red-600 font-bold">赤字で「再連携」</span>となっている項目がないか確認します。</p>
                  <div className="bg-white p-2 border border-blue-200 text-center text-gray-400 my-2">
                    (ここにスクショ画像が入ります)
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* --- タスク5: 数値入力フォーム (売上突合) --- */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-yellow-50">
             <div className="flex justify-between items-center">
                <h3 className="font-bold text-gray-900">５．売上・仕入の入力と確認</h3>
                 <button 
                  onClick={() => toggleManual('task5')}
                  className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                >
                  手順を見る <ChevronRight className="w-4 h-4"/>
                </button>
             </div>
             <p className="text-sm text-gray-600 mt-1">ECオロチの集計データと、会計ソフト(MF)の入金データを入力してください。</p>
          </div>

          <div className="p-6 space-y-6">
            
            {/* 入力エリア */}
            <div className="grid md:grid-cols-2 gap-8">
              {/* 左：ECオロチ (黄色セル) */}
              <div className="space-y-4">
                <h4 className="font-bold text-gray-700 border-b pb-2 flex items-center gap-2">
                  <span className="w-3 h-3 bg-yellow-400 rounded-full"></span> 
                  ECオロチ (1月発生分)
                </h4>
                <div>
                  <label className="block text-sm font-medium mb-1">売上合計</label>
                  <input 
                    type="number" 
                    className="w-full p-2 border border-gray-300 rounded bg-yellow-50 focus:ring-2 focus:ring-yellow-400 outline-none"
                    value={salesData.orochiSales}
                    onChange={(e) => setSalesData({...salesData, orochiSales: Number(e.target.value)})}
                  />
                </div>
                 <div>
                  <label className="block text-sm font-medium mb-1">販売手数料</label>
                  <input 
                    type="number" 
                    className="w-full p-2 border border-gray-300 rounded bg-yellow-50 focus:ring-2 focus:ring-yellow-400 outline-none"
                    value={salesData.orochiFee}
                    onChange={(e) => setSalesData({...salesData, orochiFee: Number(e.target.value)})}
                  />
                </div>
                 <div>
                  <label className="block text-sm font-medium mb-1">仕入合計</label>
                  <input 
                    type="number" 
                    className="w-full p-2 border border-gray-300 rounded bg-yellow-50 focus:ring-2 focus:ring-yellow-400 outline-none"
                    value={salesData.orochiCost}
                    onChange={(e) => setSalesData({...salesData, orochiCost: Number(e.target.value)})}
                  />
                </div>
              </div>

              {/* 右：MF (入金) */}
              <div className="space-y-4">
                <h4 className="font-bold text-gray-700 border-b pb-2">MF会計 (2月入金分)</h4>
                <div>
                  <label className="block text-sm font-medium mb-1">売上高 (入金ベース)</label>
                  <input 
                    type="number" 
                    className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-400 outline-none"
                    value={salesData.mfSales}
                    onChange={(e) => setSalesData({...salesData, mfSales: Number(e.target.value)})}
                  />
                </div>
                 <div className="pt-[72px]"> {/* 高さ合わせ */}
                  <label className="block text-sm font-medium mb-1">仕入高</label>
                  <input 
                    type="number" 
                    className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-400 outline-none"
                    value={salesData.mfCost}
                    onChange={(e) => setSalesData({...salesData, mfCost: Number(e.target.value)})}
                  />
                </div>
              </div>
            </div>

            {/* 判定エリア */}
            <div className="bg-gray-100 p-4 rounded-lg">
              <h4 className="font-bold text-sm text-gray-600 mb-3">システム判定結果 (誤差10%以内目標)</h4>
              
              <div className="flex items-center justify-between bg-white p-3 rounded border border-gray-200">
                <div className="text-sm">
                  <span className="block text-gray-500 text-xs">比較対象額 (オロチ売上 - 手数料)</span>
                  <span className="font-mono font-bold text-lg">{orochiNetSales.toLocaleString()} 円</span>
                </div>
                <div className="text-gray-400">vs</div>
                <div className="text-sm text-right">
                  <span className="block text-gray-500 text-xs">MF売上高</span>
                  <span className="font-mono font-bold text-lg">{salesData.mfSales.toLocaleString()} 円</span>
                </div>
                
                {/* 判定バッジ */}
                <div className="ml-4 pl-4 border-l border-gray-200">
                  {isAlert ? (
                    <div className="flex items-center text-red-600 font-bold gap-1">
                       <AlertTriangle className="w-5 h-5" />
                       NG ({(diffRatio * 100).toFixed(1)}%)
                    </div>
                  ) : (
                    <div className="flex items-center text-green-600 font-bold gap-1">
                       <CheckSquare className="w-5 h-5" />
                       OK
                    </div>
                  )}
                </div>
              </div>

              {/* NGの場合のみ表示する理由入力欄 */}
              {isAlert && (
                <div className="mt-3 animate-in fade-in slide-in-from-top-2">
                  <label className="block text-sm font-bold text-red-600 mb-1">
                    差異が大きいため、理由を入力してください (必須)
                  </label>
                  <textarea 
                    className="w-full p-2 border border-red-300 rounded bg-red-50 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                    placeholder="例：〇〇キャンペーンの影響で手数料計算が特殊だったため"
                    rows={2}
                  />
                </div>
              )}
            </div>

            {/* 完了チェック */}
            <div className="flex justify-end pt-4 border-t border-gray-100">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input 
                  type="checkbox" 
                  checked={tasks.task5}
                  onChange={() => toggleTask('task5')}
                  disabled={isAlert /* 理由入力がないと押せない制御を入れる予定 */}
                  className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className={`font-bold ${tasks.task5 ? 'text-blue-600' : 'text-gray-500'}`}>
                  入力内容を確認し、完了とする
                </span>
              </label>
            </div>

          </div>
        </section>

      </main>

      {/* フッター（提出ボタン） */}
      <footer className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <div className="text-sm text-gray-500">
            完了済みタスク: <span className="font-bold text-gray-900">1 / 10</span>
          </div>
          <button className="bg-gray-300 text-gray-500 px-8 py-3 rounded-full font-bold cursor-not-allowed">
            まだ提出できません
          </button>
        </div>
      </footer>
    </div>
  );
}