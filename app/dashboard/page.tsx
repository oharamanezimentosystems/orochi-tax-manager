"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { db, auth } from '../../lib/firebase';
import { signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, doc, updateDoc, addDoc } from 'firebase/firestore';

type StatusType = '未着手' | '進行中' | '完了' | '未チェック' | 'チェック中' | '承認完了';

interface PeriodStatus {
  clientStatus: '未着手' | '進行中' | '完了';
  officeStatus: '未チェック' | 'チェック中' | '承認完了';
}

interface ClientData {
  id: string;
  name: string;
  email?: string;
  [key: string]: any; 
}

export default function Dashboard() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientData[]>([]);
  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState(2026);

  // モーダル管理
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAddClientOpen, setIsAddClientOpen] = useState(false); 
  const [isManualOpen, setIsManualOpen] = useState(false);       
  const [editingClient, setEditingClient] = useState<ClientData | null>(null);
  const [newClientName, setNewClientName] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        router.push('/');
      } else {
        setUserEmail(user.email);
        fetchClients();
      }
    });
    return () => unsubscribe();
  }, [router]);

  const fetchClients = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, "clients"));
      const clientsData = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as ClientData[];
      setClients(clientsData);
    } catch (error) {
      console.error("データの取得に失敗しました:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    router.push('/');
  };

  // 顧問先設定
  const openSettings = (e: React.MouseEvent, client: ClientData) => {
    e.stopPropagation();
    setEditingClient({ ...client });
    setIsSettingsOpen(true);
  };

  const saveSettings = async () => {
    if (!editingClient) return;
    try {
      const docRef = doc(db, "clients", editingClient.id);
      await updateDoc(docRef, { email: editingClient.email });
      setClients(prev => prev.map(c => c.id === editingClient.id ? editingClient : c));
      setIsSettingsOpen(false);
      alert('設定を保存しました');
    } catch (error) {
      console.error("保存エラー:", error);
      alert('保存に失敗しました');
    }
  };

  // 顧問先追加
  const handleAddClient = async () => {
    if (!newClientName.trim()) return alert('顧問先名を入力してください');
    try {
      const docRef = await addDoc(collection(db, "clients"), {
        name: newClientName,
        email: '',
        createdAt: new Date()
      });
      alert('顧問先を追加しました');
      setNewClientName('');
      setIsAddClientOpen(false);
      fetchClients(); 
    } catch (error) {
      console.error("追加エラー:", error);
      alert('追加に失敗しました');
    }
  };

  // URLコピー機能
  const copyClientUrl = (e: React.MouseEvent, clientId: string) => {
    e.stopPropagation(); 
    const origin = window.location.origin;
    const url = `${origin}/dashboard/detail?id=${clientId}`;
    
    navigator.clipboard.writeText(url).then(() => {
      alert(`以下のURLをコピーしました！\n顧問先に送信してください。\n\n${url}`);
    }).catch(err => {
      console.error('コピー失敗:', err);
      alert('コピーに失敗しました。手動でコピーしてください。\n' + url);
    });
  };

  // ★メール起動機能（修正版）
  const sendReminderMail = (e: React.MouseEvent, client: ClientData) => {
    e.stopPropagation();
    
    // メールアドレスの存在チェック（空白除去して確認）
    const toEmail = client.email ? client.email.trim() : '';
    
    if (!toEmail) {
      alert("メールアドレスが登録されていません。「設定」ボタンから登録してください。");
      return;
    }

    const origin = window.location.origin;
    const url = `${origin}/dashboard/detail?id=${client.id}`;
    
    const subject = `【重要】月次会計処理の進捗確認のお願い（${client.name}様）`;
    const body = `お世話になっております。
税理士小原司事務所です。

現在、月次会計処理の進捗確認を行っております。
以下の専用URLより、現在の状況をご確認・ご入力いただき、完了まで進めていただけますでしょうか。

■専用URL（ログイン不要）
${url}

ご不明な点がございましたら、本メールまたはメモアプリにてご返信ください。
何卒よろしくお願い申し上げます。`;

    // Gmail作成画面URLの生成 (toパラメータを確実に埋め込む)
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(toEmail)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    
    // 新しいタブで開く
    window.open(gmailUrl, '_blank');
  };

  const getStatusColor = (status: StatusType, type: 'client' | 'office') => {
    if (type === 'client') {
      switch (status) {
        case '完了': return 'bg-blue-900 text-blue-200 border-blue-700';
        case '進行中': return 'bg-blue-900/40 text-blue-300 border-blue-800/50';
        default: return 'bg-gray-700 text-gray-400 border-gray-600';
      }
    } else {
      switch (status) {
        case '承認完了': return 'bg-green-900 text-green-200 border-green-700';
        case 'チェック中': return 'bg-yellow-900 text-yellow-200 border-yellow-700';
        default: return 'bg-gray-700 text-gray-500 border-gray-600';
      }
    }
  };

  const getStatusForYear = (client: ClientData, termKey: string) => {
    const yearData = client[`year_${selectedYear}`];
    if (yearData && yearData[termKey]) {
      return yearData[termKey] as PeriodStatus;
    }
    return { clientStatus: '未着手', officeStatus: '未チェック' } as PeriodStatus;
  };

  if (loading) return <div className="min-h-screen bg-gray-900 text-white flex justify-center items-center">読み込み中...</div>;

  return (
    <div className="min-h-screen bg-gray-900 text-white flex">
      <aside className="w-64 bg-gray-800 border-r border-gray-700 hidden md:flex flex-col">
        <div className="p-6">
          <div className="text-gray-400 text-xs mb-1 font-bold">税理士小原司事務所</div>
          <h1 className="text-2xl font-bold text-blue-500">OROCHI</h1>
          <p className="text-xs text-gray-500 mt-1">管理者コンソール</p>
        </div>
        <nav className="mt-6 flex-1 px-4 space-y-2">
          <button className="w-full text-left block py-2.5 px-4 bg-blue-600 rounded text-white font-medium">進捗マトリクス</button>
          
          <button onClick={() => setIsManualOpen(true)} className="w-full text-left block py-2.5 px-4 rounded hover:bg-gray-700 text-gray-300 mt-4 border border-gray-600">
             📖 業務マニュアル
          </button>
        </nav>
        <div className="p-4 border-t border-gray-700">
          <button onClick={handleLogout} className="text-sm text-gray-400 hover:text-white">ログアウト</button>
        </div>
      </aside>

      <main className="flex-1 p-8 overflow-x-auto relative flex flex-col min-h-screen">
        <div className="flex-grow">
            <header className="flex justify-between items-center mb-8">
            <div>
                <h2 className="text-2xl font-bold text-white flex items-center gap-4">
                進捗管理マトリクス
                <select 
                    value={selectedYear} 
                    onChange={(e) => setSelectedYear(Number(e.target.value))}
                    className="bg-gray-800 border border-gray-600 text-white text-lg rounded px-3 py-1 focus:ring-2 focus:ring-blue-500"
                >
                    <option value={2025}>2025年度</option>
                    <option value={2026}>2026年度</option>
                    <option value={2027}>2027年度</option>
                </select>
                </h2>
                <p className="text-gray-400 text-sm mt-1">顧問先ごとの各期進捗およびチェック状況一覧</p>
            </div>
            <div className="flex items-center space-x-4">
                <button 
                onClick={() => setIsAddClientOpen(true)}
                className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded font-bold shadow flex items-center gap-2"
                >
                <i className="fas fa-plus"></i> 顧問先追加
                </button>
                <div className="text-right">
                <div className="text-sm font-bold">管理者</div>
                <div className="text-xs text-gray-400">{userEmail}</div>
                </div>
                <div className="h-10 w-10 bg-blue-600 rounded-full flex items-center justify-center font-bold text-lg">A</div>
            </div>
            </header>

            <div className="bg-gray-800 rounded-lg border border-gray-700 shadow-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
                <thead>
                <tr className="bg-gray-900 text-gray-300 text-sm border-b border-gray-700">
                    <th className="p-4 border-r border-gray-700 w-1/4">顧問先名 / 操作</th>
                    <th className="p-4 border-r border-gray-700 text-center w-1/4">第1期(1月～5月)</th>
                    <th className="p-4 border-r border-gray-700 text-center w-1/4">第2期(6月～9月)</th>
                    <th className="p-4 text-center w-1/4">第3期(10月～12月)</th>
                </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                {clients.map((client) => (
                    <tr 
                    key={client.id} 
                    className="hover:bg-gray-750 transition-colors cursor-pointer"
                    onClick={() => router.push(`/dashboard/detail?id=${client.id}&year=${selectedYear}`)}
                    >
                    <td className="p-4 border-r border-gray-700">
                        <div className="flex justify-between items-start">
                        <div>
                            <div className="font-bold text-white text-lg">{client.name}</div>
                            <div className="text-xs text-gray-500 font-normal mt-1">{client.email || "(メール未設定)"}</div>
                        </div>
                        <div className="flex gap-1">
                            <button 
                            onClick={(e) => copyClientUrl(e, client.id)}
                            className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-2 py-1 rounded border border-blue-500 flex items-center gap-1"
                            title="配布用URLをコピー"
                            >
                            <i className="fas fa-link"></i> URL
                            </button>
                            <button 
                            onClick={(e) => sendReminderMail(e, client)}
                            className="bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-xs px-2 py-1 rounded border border-gray-600 flex items-center gap-1"
                            title="催促メールを作成"
                            >
                            <i className="fas fa-envelope"></i>
                            </button>
                            <button 
                            onClick={(e) => openSettings(e, client)}
                            className="text-gray-400 hover:text-white p-1 rounded hover:bg-gray-600"
                            title="顧問先設定"
                            >
                            <i className="fas fa-cog"></i>
                            </button>
                        </div>
                        </div>
                    </td>
                    {['term1', 'term2', 'term3'].map((termKey) => {
                        const status = getStatusForYear(client, termKey);
                        return (
                        <td key={termKey} className="p-4 border-r border-gray-700 last:border-r-0 align-top">
                            <div className="flex flex-col gap-2 pointer-events-none">
                            <div className="flex justify-between items-center bg-gray-900/50 p-2 rounded border border-gray-700/50">
                                <span className="text-[10px] text-gray-400 uppercase tracking-wider">顧問先</span>
                                <span className={`text-xs px-2 py-0.5 rounded border ${getStatusColor(status.clientStatus, 'client')}`}>
                                {status.clientStatus}
                                </span>
                            </div>
                            <div className="flex justify-between items-center bg-gray-900/50 p-2 rounded border border-gray-700/50">
                                <span className="text-[10px] text-gray-400 uppercase tracking-wider">事務所</span>
                                <span className={`text-xs px-2 py-0.5 rounded border ${getStatusColor(status.officeStatus, 'office')}`}>
                                {status.officeStatus}
                                </span>
                            </div>
                            </div>
                        </td>
                        );
                    })}
                    </tr>
                ))}
                </tbody>
            </table>
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

        {/* 顧問先設定モーダル */}
        {isSettingsOpen && editingClient && (
          <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-50">
            <div className="bg-gray-800 border border-gray-600 p-6 rounded-lg w-full max-w-md shadow-2xl">
              <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                <i className="fas fa-cog text-gray-400"></i> 顧問先設定
              </h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">顧問先名</label>
                  <input type="text" value={editingClient.name} className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white" disabled />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">連絡用メールアドレス</label>
                  <input type="email" value={editingClient.email || ''} onChange={(e) => setEditingClient({...editingClient, email: e.target.value})} className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 outline-none" />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-8">
                <button onClick={() => setIsSettingsOpen(false)} className="px-4 py-2 text-sm text-gray-300 hover:text-white transition-colors">キャンセル</button>
                <button onClick={saveSettings} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-bold shadow-lg">保存する</button>
              </div>
            </div>
          </div>
        )}

        {/* 顧問先追加モーダル */}
        {isAddClientOpen && (
          <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-50">
            <div className="bg-gray-800 border border-gray-600 p-6 rounded-lg w-full max-w-md shadow-2xl">
              <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                <i className="fas fa-user-plus text-green-400"></i> 新規顧問先追加
              </h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">顧問先名（会社名・氏名）</label>
                  <input type="text" value={newClientName} onChange={(e) => setNewClientName(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-green-500 outline-none" placeholder="例: 株式会社オロチ商事" />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-8">
                <button onClick={() => setIsAddClientOpen(false)} className="px-4 py-2 text-sm text-gray-300 hover:text-white transition-colors">キャンセル</button>
                <button onClick={handleAddClient} className="px-4 py-2 text-sm bg-green-600 hover:bg-green-500 text-white rounded font-bold shadow-lg">追加する</button>
              </div>
            </div>
          </div>
        )}

        {/* スタッフ用マニュアルモーダル */}
        {isManualOpen && (
          <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-50 p-4">
            <div className="bg-white text-gray-800 rounded-lg w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="p-4 border-b bg-gray-100 flex justify-between items-center">
                <h3 className="text-xl font-bold text-gray-700 flex items-center gap-2">
                  <i className="fas fa-book"></i> オロチグループ会計処理マニュアル（スタッフ用）
                </h3>
                <button onClick={() => setIsManualOpen(false)} className="text-gray-500 hover:text-gray-800 text-2xl font-bold">×</button>
              </div>
              <div className="p-6 overflow-y-auto manual-content">
                <div className="mb-8">
                  <h4 className="text-lg font-bold border-b-2 border-blue-500 mb-4 pb-2">1. オロチグループの商流と会計処理フロー</h4>
                  <p>ECオロチは「無在庫販売」の管理システムです。売上が立つと同時に自動で仕入処理が走るのが特徴です。</p>
                  <div className="border p-2 rounded bg-gray-50 my-4 text-center">
                    <img src="/images/manual/orochi_flow.png" alt="商流図" className="max-w-full h-auto mx-auto border shadow-sm" />
                    <p className="text-xs text-gray-500 mt-2">※「ネット販売業の確定申告について.pdf」より抜粋</p>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
                    <div className="bg-blue-50 p-4 rounded border border-blue-200">
                      <h5 className="font-bold text-blue-800 mb-2">① 期中（月次）の処理基準</h5>
                      <ul className="list-disc pl-5 text-sm space-y-2">
                        <li><strong>売上：</strong> <span className="text-red-600 font-bold">入金基準</span>（通帳・入金明細ベース）</li>
                        <li><strong>仕入：</strong> <span className="text-red-600 font-bold">発生主義</span>（クレジットカード利用日ベース）</li>
                        <li>※このため、月次では売上と仕入のタイミングがズレて利益が歪みますが、期中は許容します。</li>
                      </ul>
                    </div>
                    <div className="bg-red-50 p-4 rounded border border-red-200">
                      <h5 className="font-bold text-red-800 mb-2">② 決算（期末）の処理基準</h5>
                      <ul className="list-disc pl-5 text-sm space-y-2">
                        <li><strong>売上：</strong> <span className="font-bold">発生主義</span>に修正（12月末までの未入金分を売掛金計上）</li>
                        <li><strong>仕入：</strong> <span className="font-bold">発生主義</span>（12月末までの未払分を未払金計上）</li>
                        <li>※「売上 - (MF入金 + 売掛金) = 差額」で手数料を逆算計上し、最終的な利益を確定させます。</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div>
                  <h4 className="text-lg font-bold border-b-2 border-blue-500 mb-4 pb-2">2. システムの運用ルール</h4>
                  <ul className="list-disc pl-5 space-y-2">
                    <li><strong>顧問先へのURL配布：</strong> ダッシュボードの「URL」ボタンを押してコピーし、LINE等で送ります。ID/PASSは不要です。</li>
                    <li><strong>進捗チェック：</strong> 「事務所判定」欄を使い、<span className="bg-green-100 text-green-800 px-2 py-0.5 rounded">OK</span> または <span className="bg-red-100 text-red-800 px-2 py-0.5 rounded">要確認</span> を記録してください。</li>
                    <li><strong>データの保存：</strong> 入力内容は自動保存されます。</li>
                  </ul>
                </div>
              </div>
              <div className="p-4 border-t bg-gray-50 text-right">
                <button onClick={() => setIsManualOpen(false)} className="px-6 py-2 bg-gray-500 hover:bg-gray-600 text-white rounded">閉じる</button>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}