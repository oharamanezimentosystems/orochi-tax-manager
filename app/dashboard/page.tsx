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
  completedAt?: string; // 完了日を追加
}

interface ClientData {
  id: string;
  name: string;
  email?: string;
  [key: string]: any; 
}

// 日付フォーマット関数
const formatDate = (dateString?: string) => {
  if (!dateString) return null;
  const date = new Date(dateString);
  return `${date.getMonth() + 1}/${date.getDate()}`;
};

// ★ 決算月に応じた各期の対象月を動的に算出
// 計算ルール: 第3期=決算月＋直前2ヶ月(計3) / 第2期=その直前4ヶ月 / 第1期=期首から5ヶ月
// closingMonth 未設定(個人事業主)は12月決算とみなし、従来通り 1-5 / 6-9 / 10-12 になる
const getTermMonths = (closingMonth: number | undefined, term: 1 | 2 | 3): number[] => {
  const cm = closingMonth && closingMonth >= 1 && closingMonth <= 12 ? closingMonth : 12;
  const start = (cm % 12) + 1; // 期首月（決算月の翌月）
  const fiscalMonths = Array.from({ length: 12 }, (_, i) => ((start - 1 + i) % 12) + 1);
  if (term === 1) return fiscalMonths.slice(0, 5);
  if (term === 2) return fiscalMonths.slice(5, 9);
  return fiscalMonths.slice(9, 12);
};

// ★ 期の月範囲ラベル（例: "1月～5月"）
const getTermRangeLabel = (closingMonth: number | undefined, term: 1 | 2 | 3): string => {
  const months = getTermMonths(closingMonth, term);
  return `${months[0]}月～${months[months.length - 1]}月`;
};

// MFクラウド連携（別Firebaseプロジェクト内のHostingサイト。認可完了後にこの画面へ戻る）
const MF_AUTH_LOGIN_URL = 'https://mf-accounting-poc.web.app/auth/login';
// freee連携も同じバックエンド(マネーフォワードのMCPテスト/functions)がまとめて担う。
// 【重要】freeeも実データアクセスは認可時に選んだ1事業所に限定されるため、MFと同様に
// 顧問先ごとに個別のOAuth認可が必要（実測で判明・当初の「1回で複数事業所」という
// 想定は誤りだった）。
const FREEE_AUTH_LOGIN_URL = 'https://mf-accounting-poc.web.app/freee/auth/login';

export default function Dashboard() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientData[]>([]);
  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // ★ 年度初期値の自動判定ロジック
  const [selectedYear, setSelectedYear] = useState(() => {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentFullYear = today.getFullYear();
    // 1月～3月は前年の確定申告時期なので「前年」をデフォルトに
    if (currentMonth <= 3) return currentFullYear - 1;
    // 4月以降は「今年」
    return currentFullYear;
  });

  // モーダル管理
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAddClientOpen, setIsAddClientOpen] = useState(false); 
  const [isManualOpen, setIsManualOpen] = useState(false);       
  const [editingClient, setEditingClient] = useState<ClientData | null>(null);
  const [newClientName, setNewClientName] = useState('');
  // 【2026-09-06追加・同日拡張】window.alert() を全面的に廃止。
  //  alert()はJS実行を止めるモーダルダイアログのため、①OAuthコールバック直後に自動発火する
  //  と以後のブラウザ自動操作を一切受け付けなくなり、②手動クリック起点（保存・追加・コピー等）
  //  でも「閉じるまで次の操作ができない」というUX上のデメリットは変わらない。
  //  画面上部の非ブロッキングなバナー1本に統一する（MF/freee連携・設定保存・顧問先追加・
  //  URLコピー・メール未登録など、この画面の通知はすべてこれを使う）。
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(null);

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

  // MF連携の認可完了後、/dashboard?mfConnected=1&clientId=...&officeName=... で戻ってくる
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mfConnected = params.get('mfConnected');
    const mfError = params.get('mfError');
    const freeeConnected = params.get('freeeConnected');
    const freeeError = params.get('freeeError');
    // 【2026-09-06修正】router.replace()は静的エクスポート配信のこのアプリだと実質フルページ遷移を
    //  引き起こし、setBannerした直後にReactの状態ごとリセットされてバナーが一瞬で消えてしまう
    //  （以前はalert()がJS実行を同期的にブロックしていたため露見しなかった副作用）。
    //  ページ遷移を伴わない window.history.replaceState でURLのクエリだけを消す。
    const clearQuery = () => window.history.replaceState(null, '', '/dashboard');
    if (mfConnected) {
      const officeName = params.get('officeName');
      setBanner({ tone: 'ok', msg: `✅ MFクラウドとの連携が完了しました${officeName ? `（${officeName}）` : ''}` });
      fetchClients();
      clearQuery();
    } else if (mfError) {
      setBanner({ tone: 'err', msg: `⚠️ MFクラウド連携に失敗しました: ${decodeURIComponent(mfError)}` });
      clearQuery();
    } else if (freeeConnected) {
      const companyName = params.get('companyName');
      setBanner({ tone: 'ok', msg: `✅ freeeとの連携が完了しました${companyName ? `（${companyName}）` : ''}` });
      fetchClients();
      clearQuery();
    } else if (freeeError) {
      setBanner({ tone: 'err', msg: `⚠️ freee連携に失敗しました: ${decodeURIComponent(freeeError)}` });
      clearQuery();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startMfConnect = (clientId: string) => {
    window.location.href = `${MF_AUTH_LOGIN_URL}?clientId=${encodeURIComponent(clientId)}`;
  };

  const startFreeeConnect = (clientId: string) => {
    window.location.href = `${FREEE_AUTH_LOGIN_URL}?clientId=${encodeURIComponent(clientId)}`;
  };

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
      // 【orochi_bridge_design.md §4】カンニッポ顧問先IDの対応表は **OROCHI側** が持つ。
      //  externalRefs は他の連携（MF/freee）とも共有するマップなので、**ドット記法で
      //  kannippoClientId 1フィールドだけ**を更新する（マップごと置き換えると兄弟フィールドが消える）。
      //  空文字は「対応付けなし」として null で保存する（空文字だと OROCHI 側のクエリに引っかかるため）。
      const kannippoId = String(editingClient.externalRefs?.kannippoClientId || '').trim();
      await updateDoc(docRef, {
        name: editingClient.name,
        email: editingClient.email,
        isCorporate: editingClient.isCorporate ?? false,
        closingMonth: editingClient.isCorporate ? (editingClient.closingMonth ?? 12) : 12,
        'externalRefs.kannippoClientId': kannippoId || null,
      });
      setClients(prev => prev.map(c => c.id === editingClient.id ? editingClient : c));
      setIsSettingsOpen(false);
      setBanner({ tone: 'ok', msg: '✅ 設定を保存しました' });
    } catch (error) {
      console.error("保存エラー:", error);
      setBanner({ tone: 'err', msg: '⚠️ 保存に失敗しました' });
    }
  };

  // 顧問先追加
  const handleAddClient = async () => {
    if (!newClientName.trim()) { setBanner({ tone: 'err', msg: '⚠️ 顧問先名を入力してください' }); return; }
    try {
      const docRef = await addDoc(collection(db, "clients"), {
        name: newClientName,
        email: '',
        createdAt: new Date()
      });
      setBanner({ tone: 'ok', msg: '✅ 顧問先を追加しました' });
      setNewClientName('');
      setIsAddClientOpen(false);
      fetchClients();
    } catch (error) {
      console.error("追加エラー:", error);
      setBanner({ tone: 'err', msg: '⚠️ 追加に失敗しました' });
    }
  };

  // URLコピー機能
  const copyClientUrl = (e: React.MouseEvent, clientId: string) => {
    e.stopPropagation();
    const origin = window.location.origin;
    const url = `${origin}/dashboard/detail?id=${clientId}`;

    navigator.clipboard.writeText(url).then(() => {
      setBanner({ tone: 'ok', msg: `✅ 以下のURLをコピーしました！顧問先に送信してください。\n${url}` });
    }).catch(err => {
      console.error('コピー失敗:', err);
      setBanner({ tone: 'err', msg: `⚠️ コピーに失敗しました。手動でコピーしてください。\n${url}` });
    });
  };

  // メール起動機能
  const sendReminderMail = (e: React.MouseEvent, client: ClientData) => {
    e.stopPropagation();
    const toEmail = client.email ? client.email.trim() : '';
    
    if (!toEmail) {
      setBanner({ tone: 'err', msg: '⚠️ メールアドレスが登録されていません。「設定」ボタンから登録してください。' });
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

    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(toEmail)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
          <button onClick={() => router.push('/dashboard/audit-instructions')} className="w-full text-left block py-2.5 px-4 rounded hover:bg-gray-700 text-gray-300 border border-gray-600">
             🧾 チェック指示書
          </button>
          <button onClick={() => router.push('/dashboard/audit-records')} className="w-full text-left block py-2.5 px-4 rounded hover:bg-gray-700 text-gray-300 border border-gray-600">
             🗂 チェック記録・除外
          </button>
        </nav>
        <div className="p-4 border-t border-gray-700">
          <button onClick={handleLogout} className="text-sm text-gray-400 hover:text-white">ログアウト</button>
        </div>
      </aside>

      <main className="flex-1 p-8 overflow-x-auto relative flex flex-col min-h-screen">
        {banner && (
          <div
            className={`mb-4 px-4 py-3 rounded border flex items-center justify-between whitespace-pre-line ${banner.tone === 'ok' ? 'bg-green-900/40 border-green-600 text-green-200' : 'bg-red-900/40 border-red-600 text-red-200'}`}
          >
            <span className="text-sm font-bold">{banner.msg}</span>
            <button onClick={() => setBanner(null)} className="text-xs opacity-70 hover:opacity-100 ml-4 shrink-0">✕ 閉じる</button>
          </div>
        )}
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
                    <th className="p-2 border-r border-gray-700 w-1/4">顧問先名 / 操作</th>
                    <th className="p-2 border-r border-gray-700 text-center w-1/4">第1期</th>
                    <th className="p-2 border-r border-gray-700 text-center w-1/4">第2期</th>
                    <th className="p-2 text-center w-1/4">第3期</th>
                </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                {clients.map((client) => (
                    <tr 
                    key={client.id} 
                    className="hover:bg-gray-750 transition-colors cursor-pointer"
                    onClick={() => router.push(`/dashboard/detail?id=${client.id}&year=${selectedYear}`)}
                    >
                    <td className="p-2 border-r border-gray-700">
                        <div className="flex justify-between items-start">
                        <div>
                            <div className="font-bold text-white text-sm flex items-center gap-1.5">
                              {client.name}
                              {client.accountingSystem === 'mf' ? (
                                <span
                                  className="text-[9px] font-normal bg-blue-900/50 text-blue-300 border border-blue-700 rounded px-1 py-0.5 flex items-center gap-0.5"
                                  title={client.mfOfficeName ? `MF連携済み（${client.mfOfficeName}）` : 'MF連携済み'}
                                >
                                  <i className="fas fa-plug"></i> MF
                                </span>
                              ) : client.accountingSystem === 'freee' ? (
                                <span className="text-[9px] font-normal bg-green-900/50 text-green-300 border border-green-700 rounded px-1 py-0.5 flex items-center gap-0.5">
                                  <i className="fas fa-plug"></i> freee
                                </span>
                              ) : null}
                            </div>
                            <div className="text-[10px] text-gray-500 font-normal">{client.email || "(メール未設定)"}</div>
                        </div>
                        <div className="flex gap-0.5">
                            <button
                            onClick={(e) => copyClientUrl(e, client.id)}
                            className="bg-blue-600 hover:bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded border border-blue-500 flex items-center gap-1"
                            title="配布用URLをコピー"
                            >
                            <i className="fas fa-link"></i> URL
                            </button>
                            <button
                            onClick={(e) => sendReminderMail(e, client)}
                            className="bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-[10px] px-1.5 py-0.5 rounded border border-gray-600 flex items-center gap-1"
                            title="催促メールを作成"
                            >
                            <i className="fas fa-envelope"></i>
                            </button>
                            <button
                            onClick={(e) => openSettings(e, client)}
                            className="text-gray-400 hover:text-white p-0.5 rounded hover:bg-gray-600"
                            title="顧問先設定"
                            >
                            <i className="fas fa-cog"></i>
                            </button>
                        </div>
                        </div>
                    </td>
                    {['term1', 'term2', 'term3'].map((termKey) => {
                        const status = getStatusForYear(client, termKey);
                        const termNum = Number(termKey.replace('term', '')) as 1 | 2 | 3;
                        return (
                        <td key={termKey} className="p-1.5 border-r border-gray-700 last:border-r-0 align-top">
                            <div className="flex flex-col gap-1 pointer-events-none">
                            <div className="text-center text-[10px] text-blue-300 font-mono">
                                {getTermRangeLabel(client.closingMonth, termNum)}
                                {client.isCorporate && <span className="ml-1 text-[9px] text-amber-400 align-middle">法人</span>}
                            </div>
                            <div className="flex justify-between items-center bg-gray-900/50 px-2 py-1 rounded border border-gray-700/50">
                                <span className="text-[9px] text-gray-400 uppercase tracking-wider">顧問先</span>
                                <div className="flex flex-col items-end">
                                    <span className={`text-[11px] px-1.5 py-0.5 rounded border ${getStatusColor(status.clientStatus, 'client')}`}>
                                    {status.clientStatus}
                                    </span>
                                    {/* ★完了日表示 */}
                                    {status.clientStatus === '完了' && status.completedAt && (
                                        <span className="text-[9px] text-green-400 font-mono">
                                            {formatDate(status.completedAt)} 完了
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="flex justify-between items-center bg-gray-900/50 px-2 py-1 rounded border border-gray-700/50">
                                <span className="text-[9px] text-gray-400 uppercase tracking-wider">事務所</span>
                                <span className={`text-[11px] px-1.5 py-0.5 rounded border ${getStatusColor(status.officeStatus, 'office')}`}>
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
          <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-50 p-4">
            <div className="bg-gray-800 border border-gray-600 rounded-lg w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col">
              <h3 className="text-xl font-bold p-6 pb-4 flex items-center gap-2 flex-shrink-0">
                <i className="fas fa-cog text-gray-400"></i> 顧問先設定
              </h3>
              <div className="space-y-4 px-6 pb-4 overflow-y-auto flex-1">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">顧問先名</label>
                  <input type="text" value={editingClient.name} onChange={(e) => setEditingClient({...editingClient, name: e.target.value})} className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 outline-none" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">連絡用メールアドレス</label>
                  <input type="email" value={editingClient.email || ''} onChange={(e) => setEditingClient({...editingClient, email: e.target.value})} className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 outline-none" />
                </div>

                {/* 法人設定 */}
                <div>
                  <label className="block text-sm text-gray-400 mb-1">事業形態</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="businessType"
                        checked={!editingClient.isCorporate}
                        onChange={() => setEditingClient({ ...editingClient, isCorporate: false })}
                        className="accent-blue-500"
                      />
                      <span className="text-white">個人事業主</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="businessType"
                        checked={!!editingClient.isCorporate}
                        onChange={() => setEditingClient({ ...editingClient, isCorporate: true, closingMonth: editingClient.closingMonth || 12 })}
                        className="accent-blue-500"
                      />
                      <span className="text-white">法人</span>
                    </label>
                  </div>
                </div>

                {/* 法人選択時のみ決算月セレクト */}
                {editingClient.isCorporate && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">決算月</label>
                    <select
                      value={editingClient.closingMonth || 12}
                      onChange={(e) => setEditingClient({ ...editingClient, closingMonth: Number(e.target.value) })}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 outline-none"
                    >
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                        <option key={m} value={m}>{m}月決算</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* MFクラウド連携設定（事務所側のみで設定。顧問先向け画面には出さない） */}
                <div className="border-t border-gray-700 pt-4">
                  <label className="block text-sm text-gray-400 mb-1">マネーフォワード連携</label>
                  {editingClient.accountingSystem === 'mf' ? (
                    <div className="space-y-2">
                      <p className="text-sm text-green-400 flex items-center gap-1">
                        <i className="fas fa-check-circle"></i> 連携済み{editingClient.mfOfficeName ? `（${editingClient.mfOfficeName}）` : ''}
                      </p>
                      <button
                        type="button"
                        onClick={() => startMfConnect(editingClient.id)}
                        className="text-xs text-blue-400 hover:text-blue-300 underline"
                      >
                        連携し直す（再認可）
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startMfConnect(editingClient.id)}
                      className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 border border-gray-600 text-white rounded"
                    >
                      MFクラウドと連携する
                    </button>
                  )}
                  <p className="text-xs text-gray-500 mt-1 mb-2">
                    クリックするとマネーフォワード側の認可画面に移動します。保存前でも即座に連携されます。
                  </p>
                  <details className="text-xs bg-gray-900/50 border border-gray-700 rounded px-3 py-2">
                    <summary className="text-gray-300 cursor-pointer select-none">連携手順を見る</summary>
                    <ol className="mt-2 space-y-1.5 text-gray-400 list-decimal list-inside">
                      <li>上のボタンを押すと、マネーフォワードのログイン画面に移動します。</li>
                      <li>
                        「アカウントを選択する」画面で、<span className="text-gray-200">事務所のMFアカウント</span>
                        （現在ログイン中のものが表示されていればそれを選択）でログインします。
                      </li>
                      <li>
                        「事業者を選択」画面が表示されるので、<span className="text-gray-200">この顧問先に対応する事業者名</span>
                        を一覧から選び「次へ」を押します（顧問先ごとに個別の認可が必要です。1人分の連携が他の顧問先には流用されません）。
                      </li>
                      <li>
                        「アプリとの連携を許可しますか？」画面で、アプリ名「オロチ税理士 会計連携」・連携する事業者名・
                        要求権限を確認し、「許可」を押します。
                      </li>
                      <li>
                        自動的にこの管理ダッシュボードに戻り、「連携済み（事業者名）」と表示されれば完了です。
                      </li>
                    </ol>
                    <p className="mt-2 text-amber-400/80">
                      ※ 権限（スコープ）の追加などでMFC側の要求権限が変わった場合、既に連携済みの顧問先も
                      「連携し直す（再認可）」から同じ手順を再度行う必要があります。
                    </p>
                  </details>
                </div>

                {/* freee連携設定（事務所側のみで設定。MFと同様、顧問先ごとに個別のOAuth認可が必要） */}
                <div className="border-t border-gray-700 pt-4">
                  <label className="block text-sm text-gray-400 mb-1">freee連携</label>
                  {editingClient.accountingSystem === 'freee' ? (
                    <div className="space-y-2">
                      <p className="text-sm text-green-400 flex items-center gap-1">
                        <i className="fas fa-check-circle"></i> 連携済み{editingClient.freeeCompanyName ? `（${editingClient.freeeCompanyName}）` : ''}
                      </p>
                      <button
                        type="button"
                        onClick={() => startFreeeConnect(editingClient.id)}
                        className="text-xs text-blue-400 hover:text-blue-300 underline"
                      >
                        連携し直す（再認可）
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startFreeeConnect(editingClient.id)}
                      className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 border border-gray-600 text-white rounded"
                    >
                      freeeと連携する
                    </button>
                  )}
                  <p className="text-xs text-gray-500 mt-1 mb-2">
                    クリックするとfreee側の認可画面に移動します。保存前でも即座に連携されます。
                  </p>
                  <details className="text-xs bg-gray-900/50 border border-gray-700 rounded px-3 py-2">
                    <summary className="text-gray-300 cursor-pointer select-none">連携手順を見る</summary>
                    <ol className="mt-2 space-y-1.5 text-gray-400 list-decimal list-inside">
                      <li>上のボタンを押すと、freeeのログイン画面（事務所の連携用アカウントで既にログイン済みならスキップ）に移動します。</li>
                      <li>
                        「アプリ連携する事業所を選択」画面が表示されるので、<span className="text-gray-200">この顧問先に対応する事業所名</span>
                        を一覧から選びます（顧問先ごとに個別の認可が必要です。freeeも1回の認可で他の顧問先の分は連携されません）。
                      </li>
                      <li>
                        「アプリ連携を開始しますか？」画面で、アプリ名「オロチ税理士 会計連携」・事業所名・
                        要求権限を確認し、「許可する」を押します。
                      </li>
                      <li>
                        自動的にこの管理ダッシュボードに戻り、「連携済み（事業所名）」と表示されれば完了です
                        （認可された事業所名はシステムが自動判定するため、追加の入力は不要です）。
                      </li>
                    </ol>
                    <p className="mt-2 text-amber-400/80">
                      ※ freeeの銀行明細（未仕訳明細）へのアクセス許可は申請していないため、未仕訳件数の表示は
                      対応していません（口座連携状況・残高・月次売上仕入のみ対応）。
                    </p>
                  </details>
                </div>
                {/* 【orochi_bridge_design.md §4】カンニッポ顧問先IDの対応表。
                    カンニッポ側のID（{tenantId}_{顧問先名}）とOROCHIの自動採番IDは無関係の別体系なので、
                    自動名寄せはせず、必ず人がここへ貼り付けて対応付ける。 */}
                <div className="border-t border-gray-700 pt-4">
                  <label className="block text-sm text-gray-400 mb-1">カンニッポ連携（AI監査 指摘事項の受け取り）</label>
                  <input
                    type="text"
                    value={editingClient.externalRefs?.kannippoClientId || ''}
                    onChange={(e) => setEditingClient({
                      ...editingClient,
                      externalRefs: { ...(editingClient.externalRefs || {}), kannippoClientId: e.target.value },
                    })}
                    placeholder="例: ohara_マルサン商会"
                    className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    カンニッポ側の顧問先IDを貼り付けると、カンニッポで「OROCHIへ反映」を押したときに
                    この顧問先の詳細画面へAI監査の指摘が表示されます。空欄なら受け取りません。
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    ※ この設定は表示だけに使われます。作業チェック表（各期のタスク）には一切影響しません。
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-3 p-6 pt-4 flex-shrink-0">
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

                <div className="mt-8">
                  <h4 className="text-lg font-bold border-b-2 border-blue-500 mb-4 pb-2">3. 顧問先チェック（Claude Code）</h4>
                  <ul className="list-disc pl-5 space-y-2">
                    <li><strong>🧾 チェック指示書：</strong> Claude Code が顧問先をチェックするときの手順書です。ダウンロードして各PCに置き、「audit-instructions-vN.md に従って顧問先をチェックして」と伝えます。改定は同じ画面で上書きアップロードします（古い版は残ります）。</li>
                    <li><strong>実行結果：</strong> 顧問先宛てのGmail<strong>下書き</strong>と事務所向けレポートができます。メールは自動送信されません。内容を確認して事務所で送ってください。</li>
                    <li><strong>🗂 チェック記録・除外：</strong> 顧問先ごとのチェック履歴と、チェックから外す口座・カード（例：クラウド出納帳で入力しているカード）の設定です。除外は事務所の指示があったときだけ登録します。マイナス残高は除外しません。</li>
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