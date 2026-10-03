"use client";

// 顧問先チェックの記録・除外設定の画面（Claude Code がブラウザ経由で操作する／事務所も閲覧・編集できる）。
//  ・本体は audit_records/{顧問先ID}（exceptions / history）。事務所のログイン済みユーザーのみ（Firestoreルールで制限）。
//  ・除外の登録は事務所の指示があったときだけ（指示書 §7）。「指示した人」を必須にして記録する。

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { db, auth } from '../../../lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';

type ExceptionItem = {
  target: string;
  items: string[];
  reason: string;
  instructedBy: string;
  addedAt: string;
  addedWith: string;
};
type HistoryItem = {
  year: number;
  term: number;
  checkedAt: string;
  summary: string;
  draftCreatedAt: string | null;
  checkedWith: string;
};
type ClientOption = { id: string; name: string };

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—';

const inputCls =
  'w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 outline-none';

export default function AuditRecordsPage() {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientId, setClientId] = useState('');
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // 除外フォーム
  const [exTarget, setExTarget] = useState('');
  const [exItems, setExItems] = useState('');
  const [exReason, setExReason] = useState('');
  const [exBy, setExBy] = useState('');
  // 履歴フォーム
  const [hYear, setHYear] = useState('');
  const [hTerm, setHTerm] = useState('');
  const [hSummary, setHSummary] = useState('');
  const [hDraft, setHDraft] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push('/');
        return;
      }
      setUserEmail(user.email);
      try {
        const snap = await getDocs(collection(db, 'clients'));
        setClients(snap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id) })));
      } catch (e) {
        console.error(e);
        setBanner({ tone: 'err', msg: '⚠️ 顧問先一覧の読み込みに失敗しました。' });
      }
    });
    return () => unsubscribe();
  }, [router]);

  const loadRecord = async (id: string) => {
    setClientId(id);
    setExceptions([]);
    setHistory([]);
    if (!id) return;
    try {
      const snap = await getDoc(doc(db, 'audit_records', id));
      const d = snap.exists() ? snap.data() : {};
      setExceptions((d.exceptions ?? []) as ExceptionItem[]);
      setHistory((d.history ?? []) as HistoryItem[]);
    } catch (e) {
      console.error(e);
      setBanner({ tone: 'err', msg: '⚠️ 記録の読み込みに失敗しました。' });
    }
  };

  const saveRecord = async (next: { exceptions?: ExceptionItem[]; history?: HistoryItem[] }, okMsg: string) => {
    setSaving(true);
    try {
      await setDoc(doc(db, 'audit_records', clientId), next, { merge: true });
      if (next.exceptions) setExceptions(next.exceptions);
      if (next.history) setHistory(next.history);
      setBanner({ tone: 'ok', msg: `✅ ${okMsg}` });
      return true;
    } catch (e) {
      console.error(e);
      setBanner({ tone: 'err', msg: '⚠️ 保存に失敗しました。' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addException = async () => {
    if (!clientId) return setBanner({ tone: 'err', msg: '⚠️ 顧問先を選択してください。' });
    if (!exTarget.trim() || !exItems.trim() || !exReason.trim() || !exBy.trim())
      return setBanner({ tone: 'err', msg: '⚠️ 対象・除外する項目・理由・指示した人をすべて入力してください。' });
    const item: ExceptionItem = {
      target: exTarget.trim(),
      items: exItems.split(/[,、]/).map((s) => s.trim()).filter(Boolean),
      reason: exReason.trim(),
      instructedBy: exBy.trim(),
      addedAt: new Date().toISOString(),
      addedWith: userEmail || '',
    };
    const next = [...exceptions.filter((e) => e.target !== item.target), item];
    if (await saveRecord({ exceptions: next }, '除外を登録しました。')) {
      setExTarget('');
      setExItems('');
      setExReason('');
      setExBy('');
    }
  };

  const removeException = async (target: string) => {
    await saveRecord({ exceptions: exceptions.filter((e) => e.target !== target) }, '除外を削除しました。');
  };

  const addHistory = async () => {
    if (!clientId) return setBanner({ tone: 'err', msg: '⚠️ 顧問先を選択してください。' });
    if (!hYear.trim() || !hTerm.trim() || !hSummary.trim())
      return setBanner({ tone: 'err', msg: '⚠️ 年度・期・指摘の要約を入力してください。' });
    const now = new Date().toISOString();
    const item: HistoryItem = {
      year: Number(hYear),
      term: Number(hTerm),
      checkedAt: now,
      summary: hSummary.trim(),
      draftCreatedAt: hDraft ? now : null,
      checkedWith: userEmail || '',
    };
    if (await saveRecord({ history: [...history, item].slice(-100) }, '履歴を記録しました。')) {
      setHSummary('');
      setHDraft(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <button onClick={() => router.push('/dashboard')} className="text-sm text-gray-400 hover:text-white mb-4">
          ← 一覧
        </button>
        <h1 className="text-2xl font-bold mb-1">チェック記録・除外設定</h1>
        <p className="text-sm text-gray-400 mb-6">
          顧問先ごとのチェック履歴（最終チェック日・指摘の要約・催促メールの下書き作成日）と、チェックから外す口座・カードの設定です。
          除外の登録は事務所の指示があったときだけ行ってください。
        </p>

        <details open className="mb-6 bg-gray-800 border border-gray-700 rounded p-4 text-sm">
          <summary className="cursor-pointer font-bold text-blue-300">📖 使い方</summary>
          <div className="mt-3 space-y-3 text-gray-300">
            <div>
              <div className="font-bold text-white">この画面は何をするところか</div>
              <ul className="list-disc ml-5 space-y-1 mt-1">
                <li><b>除外設定</b>：クラウド出納帳など、連携明細を使わない口座・カードを、チェックから外す設定です。</li>
                <li><b>チェック履歴</b>：いつ・どの期をチェックし、何を指摘し、催促メールの下書きをいつ作ったかの記録です。</li>
              </ul>
            </div>
            <div>
              <div className="font-bold text-white">操作</div>
              <ol className="list-decimal ml-5 space-y-1 mt-1">
                <li>上の「顧問先」を選ぶと、その顧問先の除外設定と履歴が表示されます。</li>
                <li>除外したい口座・カードがあるときは、名前・除外する項目・理由・指示した人を入れて「除外を登録」。</li>
                <li>除外を外すときは、その行の「削除」を押します。</li>
              </ol>
            </div>
            <div className="text-yellow-300">
              ※ 除外は事務所の指示があったときだけ登録してください（AIが自分の判断で追加することはありません）。
              マイナス残高は除外しない運用です。履歴は通常Claude Codeが自動で記録するので、手で入力するのは修正したいときだけです。
            </div>
          </div>
        </details>

        {banner && (
          <div
            data-testid="banner"
            className={`mb-4 px-4 py-2 rounded border text-sm flex justify-between items-center ${
              banner.tone === 'ok'
                ? 'bg-green-900/40 border-green-700 text-green-200'
                : 'bg-red-900/40 border-red-700 text-red-200'
            }`}
          >
            <span>{banner.msg}</span>
            <button onClick={() => setBanner(null)} className="ml-4 text-xs opacity-70 hover:opacity-100">
              閉じる
            </button>
          </div>
        )}

        <section className="bg-gray-800 border border-gray-700 rounded p-5 mb-6">
          <label htmlFor="client-select" className="block font-bold mb-2">顧問先</label>
          <select
            id="client-select"
            value={clientId}
            onChange={(e) => loadRecord(e.target.value)}
            className={inputCls}
          >
            <option value="">選択してください</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{c.id}）
              </option>
            ))}
          </select>
        </section>

        {clientId && (
          <>
            <section className="bg-gray-800 border border-gray-700 rounded p-5 mb-6">
              <h2 className="font-bold mb-3">除外設定</h2>
              {exceptions.length === 0 ? (
                <p className="text-sm text-gray-400 mb-4">登録はありません。</p>
              ) : (
                <ul className="divide-y divide-gray-700 text-sm mb-4">
                  {exceptions.map((e) => (
                    <li key={e.target} className="py-2 flex justify-between gap-3">
                      <div>
                        <div className="font-bold">{e.target}</div>
                        <div className="text-gray-300">除外する項目：{e.items.join('、')}</div>
                        <div className="text-gray-300">理由：{e.reason}</div>
                        <div className="text-gray-500 text-xs">
                          指示した人：{e.instructedBy}　登録：{fmt(e.addedAt)}　{e.addedWith}
                        </div>
                      </div>
                      <button
                        onClick={() => removeException(e.target)}
                        disabled={saving}
                        className="text-xs px-3 py-1 rounded border border-gray-600 hover:bg-gray-700 shrink-0 self-start"
                      >
                        削除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="space-y-2 text-sm">
                <input aria-label="対象の口座・カード名" placeholder="対象の口座・カード名" value={exTarget} onChange={(e) => setExTarget(e.target.value)} className={inputCls} />
                <input aria-label="除外する項目" placeholder="除外する項目（例: 未仕訳）。複数は読点で区切る" value={exItems} onChange={(e) => setExItems(e.target.value)} className={inputCls} />
                <input aria-label="理由" placeholder="理由" value={exReason} onChange={(e) => setExReason(e.target.value)} className={inputCls} />
                <input aria-label="指示した人" placeholder="指示した人（事務所の誰の指示か）" value={exBy} onChange={(e) => setExBy(e.target.value)} className={inputCls} />
                <button onClick={addException} disabled={saving} className="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white px-4 py-2 rounded">
                  {saving ? '保存中...' : '除外を登録'}
                </button>
              </div>
            </section>

            <section className="bg-gray-800 border border-gray-700 rounded p-5">
              <h2 className="font-bold mb-3">チェック履歴</h2>
              {history.length === 0 ? (
                <p className="text-sm text-gray-400 mb-4">履歴はまだありません。</p>
              ) : (
                <ul className="divide-y divide-gray-700 text-sm mb-4">
                  {[...history].reverse().map((h, i) => (
                    <li key={i} className="py-2">
                      <div>
                        <span className="font-bold text-blue-400">{h.year}年度 第{h.term}期</span>
                        <span className="text-gray-400 ml-2">チェック：{fmt(h.checkedAt)}</span>
                        <span className="text-gray-400 ml-2">下書き作成：{fmt(h.draftCreatedAt)}</span>
                      </div>
                      <div className="text-gray-300">{h.summary}</div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="space-y-2 text-sm">
                <div className="flex gap-2">
                  <input aria-label="年度" placeholder="年度（例: 2026）" value={hYear} onChange={(e) => setHYear(e.target.value)} className={inputCls} />
                  <input aria-label="期" placeholder="期（1〜3）" value={hTerm} onChange={(e) => setHTerm(e.target.value)} className={inputCls} />
                </div>
                <textarea aria-label="指摘の要約" placeholder="指摘の要約" value={hSummary} onChange={(e) => setHSummary(e.target.value)} className={inputCls} rows={3} />
                <label className="flex items-center gap-2 text-gray-300">
                  <input type="checkbox" checked={hDraft} onChange={(e) => setHDraft(e.target.checked)} />
                  顧問先宛てのGmail下書きを作成した
                </label>
                <button onClick={addHistory} disabled={saving} className="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white px-4 py-2 rounded">
                  {saving ? '保存中...' : '履歴を記録'}
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
