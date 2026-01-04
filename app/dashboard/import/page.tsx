"use client";

import React, { useState, useEffect } from 'react';
import { db } from '../../../lib/firebase';
import { collection, getDocs, doc, getDoc, updateDoc } from 'firebase/firestore';

interface Client {
  id: string;
  name: string;
}

export default function ImportPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState('');
  const [year, setYear] = useState(2025); // デフォルトは旧データ用に2025
  const [jsonData, setJsonData] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    const fetchClients = async () => {
      const snap = await getDocs(collection(db, "clients"));
      setClients(snap.docs.map(d => ({ id: d.id, name: d.data().name })));
    };
    fetchClients();
  }, []);

  const handleImport = async () => {
    if (!selectedClient) return alert('顧問先を選択してください');
    if (!jsonData.trim()) return alert('JSONデータを貼り付けてください');

    setStatus('処理中...');

    try {
      // 1. JSONパース
      const parsed = JSON.parse(jsonData);
      
      // 2. Firestore参照
      const docRef = doc(db, "clients", selectedClient);
      const docSnap = await getDoc(docRef);
      if (!docSnap.exists()) throw new Error("顧問先データが見つかりません");
      const currentData = docSnap.data();

      // 3. 更新用データ作成
      const updates: any = {};
      const terms = [1, 2, 3];

      // --- 売上データの整形 (Task 6) ---
      // parsed.sales_data = [{ month: 1, shop: "Yahoo!", sales: 100... }, ...]
      // これを { 1: { "Yahoo!": { sales: 100... } } } の形に変換してマージ
      if (parsed.sales_data && Array.isArray(parsed.sales_data)) {
        const groupedSales: any = {};
        parsed.sales_data.forEach((item: any) => {
            if (!groupedSales[item.month]) groupedSales[item.month] = {};
            groupedSales[item.month][item.shop] = {
                sales: item.sales || 0,
                purchase: item.purchase || 0,
                fee: item.fee || 0
            };
        });

        // 各期のタスクデータに反映
        terms.forEach(term => {
            const termKey = `year_${year}_term${term}_tasks`;
            const tasks = currentData[termKey] || []; // 既存タスクがあれば取得
            // Task 6を探す (なければ何もしない、あるいは新規作成も検討だが今回は既存がある前提)
            const taskIndex = tasks.findIndex((t: any) => t.no === "6");
            
            if (taskIndex >= 0) {
                const currentDetails = tasks[taskIndex].details || { monthlyData: {} };
                // 既存データにマージ
                const mergedMonthly = { ...currentDetails.monthlyData, ...groupedSales };
                tasks[taskIndex].details = { monthlyData: mergedMonthly };
                tasks[taskIndex].clientInput = "詳細データ入力済 (移行データ)";
                updates[termKey] = tasks;
            }
        });
      }

      // --- 管理表データ (Points, Notes, Status) ---
      // parsed.term_inputs = { term1: { points: "...", notes: "...", status: "完了" }, ... }
      if (parsed.term_inputs) {
        terms.forEach(term => {
            const termKey = `year_${year}_term${term}_tasks`;
            const termInput = parsed.term_inputs[`term${term}`];
            if (!termInput) return;

            // update対象のタスク配列（売上処理で更新されていればそれを使う）
            let tasks = updates[termKey] || currentData[termKey] || [];
            let isModified = false;

            // Task 12 (Points)
            if (termInput.points) {
                const ptIndex = tasks.findIndex((t: any) => t.no === "12");
                if (ptIndex >= 0) {
                    tasks[ptIndex].clientInput = termInput.points;
                    isModified = true;
                }
            }

            // Task 13 (Notes)
            if (termInput.notes) {
                const noteIndex = tasks.findIndex((t: any) => t.no === "13");
                if (noteIndex >= 0) {
                    tasks[noteIndex].clientInput = termInput.notes;
                    isModified = true;
                }
            }

            if (isModified) {
                updates[termKey] = tasks;
            }

            // ステータス更新
            if (termInput.status) {
                updates[`year_${year}.term${term}.clientStatus`] = termInput.status;
                // 完了なら事務所ステータスも承認待ち(チェック中)にしておく？ 
                // 今回はクライアントステータスのみ更新
            }
        });
      }

      // 4. 保存実行
      if (Object.keys(updates).length > 0) {
        await updateDoc(docRef, updates);
        setStatus('インポート完了！ データが保存されました。');
      } else {
        setStatus('更新するデータがありませんでした。');
      }

    } catch (e: any) {
      console.error(e);
      setStatus(`エラー: ${e.message}`);
      alert('JSONの形式が正しくないか、処理中にエラーが発生しました。\nコンソールを確認してください。');
    }
  };

  return (
    <div className="p-8 text-white bg-gray-900 min-h-screen">
      <h1 className="text-2xl font-bold mb-6">AIデータ移行ツール</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-4">
            <div className="bg-gray-800 p-4 rounded border border-gray-700">
                <h2 className="font-bold mb-4 text-blue-400">Step 1. データ準備</h2>
                <p className="text-sm text-gray-300 mb-2">
                    ChatGPT等のAIに「データ整理用プロンプト」を渡し、Excelのデータを貼り付けてJSONを作成させてください。
                </p>
                <div className="text-xs bg-black p-2 rounded text-gray-500 font-mono">
                    {`{ "sales_data": [...], "term_inputs": {...} }`}
                </div>
            </div>

            <div>
                <label className="block mb-1 font-bold">対象年度</label>
                <input type="number" value={year} onChange={e => setYear(Number(e.target.value))} className="bg-gray-800 border border-gray-600 rounded p-2 text-white w-24" />
            </div>
            
            <div>
                <label className="block mb-1 font-bold">取込先 顧問先</label>
                <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)} className="bg-gray-800 border border-gray-600 rounded p-2 text-white w-full">
                    <option value="">選択してください</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
            </div>
        </div>

        <div className="space-y-4">
            <h2 className="font-bold text-green-400">Step 2. データ取込</h2>
            <textarea 
                value={jsonData} 
                onChange={e => setJsonData(e.target.value)} 
                className="w-full h-96 bg-gray-800 border border-gray-600 rounded p-4 text-xs font-mono text-green-300 focus:outline-none focus:border-green-500"
                placeholder='AIが生成したJSONコードをここに貼り付けてください...'
            />
            
            <button onClick={handleImport} className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded font-bold text-white shadow-lg">
                インポート実行
            </button>
            
            {status && (
                <div className={`p-3 rounded text-center font-bold ${status.includes('エラー') ? 'bg-red-900/50 text-red-300' : 'bg-green-900/50 text-green-300'}`}>
                    {status}
                </div>
            )}
        </div>
      </div>
    </div>
  );
}