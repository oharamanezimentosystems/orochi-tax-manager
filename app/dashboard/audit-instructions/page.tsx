"use client";

// 顧問先チェック指示書（Claude Code用）の保管・版管理画面。
//  ・本体は audit_instructions/current、版ごとの履歴は audit_instructions_history/v{n}。
//  ・事務所のログイン済みユーザーのみ（Firestoreルールで制限）。
//  ・上書きアップロードのたびに版番号が+1。過去の版はダウンロード・「この版に戻す」ができる。

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { db, auth } from '../../../lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, collection, getDocs, query, orderBy, limit, writeBatch } from 'firebase/firestore';

type InstructionVersion = {
  version: number;
  body: string;
  note: string;
  updatedAt: number;
  updatedBy: string;
};

// Firestoreの1ドキュメント上限(約1MiB)に収める
const MAX_BODY_CHARS = 300000;

const formatDateTime = (ms: number) =>
  new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

const downloadMarkdown = (v: InstructionVersion) => {
  const blob = new Blob([v.body], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-instructions-v${v.version}.md`;
  a.click();
  URL.revokeObjectURL(url);
};

export default function AuditInstructionsPage() {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [current, setCurrent] = useState<InstructionVersion | null>(null);
  const [history, setHistory] = useState<InstructionVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(null);
  const [note, setNote] = useState('');
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [saving, setSaving] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const curSnap = await getDoc(doc(db, 'audit_instructions', 'current'));
      setCurrent(curSnap.exists() ? (curSnap.data() as InstructionVersion) : null);
      const histSnap = await getDocs(
        query(collection(db, 'audit_instructions_history'), orderBy('version', 'desc'), limit(30))
      );
      setHistory(histSnap.docs.map((d) => d.data() as InstructionVersion));
    } catch (e) {
      console.error(e);
      setBanner({ tone: 'err', msg: '⚠️ 指示書の読み込みに失敗しました。' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        router.push('/');
      } else {
        setUserEmail(user.email);
        load();
      }
    });
    return () => unsubscribe();
  }, [router]);

  // 新しい版として保存（current と history を同時に書く）
  const saveNewVersion = async (body: string, versionNote: string) => {
    if (!body.trim()) {
      setBanner({ tone: 'err', msg: '⚠️ ファイルの内容が空です。' });
      return false;
    }
    if (body.length > MAX_BODY_CHARS) {
      setBanner({ tone: 'err', msg: `⚠️ ファイルが大きすぎます（${MAX_BODY_CHARS.toLocaleString()}文字まで）。` });
      return false;
    }
    if (!versionNote.trim()) {
      setBanner({ tone: 'err', msg: '⚠️ 改定メモを入力してください。' });
      return false;
    }
    setSaving(true);
    try {
      // 保存直前に最新の版番号を取り直す（他の担当者が先に更新していた場合に版が重ならないように）
      const latest = await getDoc(doc(db, 'audit_instructions', 'current'));
      const nextVersion = latest.exists() ? Number((latest.data() as InstructionVersion).version) + 1 : 1;
      const data: InstructionVersion = {
        version: nextVersion,
        body,
        note: versionNote.trim(),
        updatedAt: Date.now(),
        updatedBy: userEmail || '',
      };
      const batch = writeBatch(db);
      batch.set(doc(db, 'audit_instructions', 'current'), data);
      batch.set(doc(db, 'audit_instructions_history', `v${nextVersion}`), data);
      await batch.commit();
      setBanner({ tone: 'ok', msg: `✅ 指示書を v${nextVersion} として保存しました。` });
      return true;
    } catch (e) {
      console.error(e);
      setBanner({ tone: 'err', msg: '⚠️ 保存に失敗しました。' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setFileText(await file.text());
  };

  const handleUpload = async () => {
    if (fileText === null) {
      setBanner({ tone: 'err', msg: '⚠️ アップロードするファイルを選択してください。' });
      return;
    }
    if (await saveNewVersion(fileText, note)) {
      setFileText(null);
      setFileName('');
      setNote('');
      await load();
    }
  };

  const handleRestore = async (v: InstructionVersion) => {
    if (await saveNewVersion(v.body, `v${v.version} に戻す`)) {
      setRestoreTarget(null);
      await load();
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <button onClick={() => router.push('/dashboard')} className="text-sm text-gray-400 hover:text-white mb-4">
          ← 一覧
        </button>
        <h1 className="text-2xl font-bold mb-1">顧問先チェック指示書</h1>
        <p className="text-sm text-gray-400 mb-6">
          Claude Code で顧問先をチェックするための、窓口（MCP）の使い方の説明書を保管・版管理する画面です。
          改定したときは、ここへ上書きアップロードしてください（版番号が上がり、過去の版は残ります）。
        </p>

        <details open className="mb-6 bg-gray-800 border border-gray-700 rounded p-4 text-sm">
          <summary className="cursor-pointer font-bold text-blue-300">📖 使い方（MCP版）</summary>
          <div className="mt-3 space-y-3 text-gray-300">
            <div>
              <div className="font-bold text-white">チェックを実行する（各PCで1回だけ準備）</div>
              <ol className="list-decimal ml-5 space-y-1 mt-1">
                <li>管理者から「事務所の合言葉」を聞く。</li>
                <li>Claude Code に、専用の窓口（orochi-audit）を登録する。登録のコマンドは、下の「現在の版」の内容にある「使い方」を参照。</li>
                <li>登録後は、Claude Code に「顧問先をチェックして」と頼むだけです。チェックのルールと計算は窓口の側に入っているので、ファイルを配る必要はありません。</li>
                <li>顧問先の入力状況とMFの状況は読み取り専用で調べます。MFへの書き込みはできない作りです。<b>メールは送信されません</b>。</li>
                <li>結果は「🗂 チェック記録・除外」に履歴として残ります。同じ指摘のメールは7日あけて再作成されます。</li>
              </ol>
            </div>
            <div>
              <div className="font-bold text-white">この画面のファイルについて</div>
              <p className="mt-1">下の「現在の版」は、窓口の使い方の説明書です（保管・版管理用）。ルール自体は窓口のプログラムの中にあり、直すときは管理者が行います。</p>
            </div>
          </div>
        </details>

        {banner && (
          <div
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
          <h2 className="font-bold mb-3">現在の版</h2>
          {loading ? (
            <p className="text-sm text-gray-400">読み込み中...</p>
          ) : !current ? (
            <p className="text-sm text-gray-400">まだ登録されていません。下からアップロードしてください（v1になります）。</p>
          ) : (
            <div className="text-sm space-y-1">
              <div>
                <span className="text-blue-400 font-bold text-lg">v{current.version}</span>
                <span className="text-gray-400 ml-3">
                  {formatDateTime(current.updatedAt)}　{current.updatedBy}
                </span>
              </div>
              <div className="text-gray-300">改定メモ：{current.note}</div>
              <div className="pt-2">
                <button
                  onClick={() => downloadMarkdown(current)}
                  className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded"
                >
                  ダウンロード（v{current.version}）
                </button>
              </div>
              <details className="pt-3">
                <summary className="cursor-pointer text-gray-400">内容を表示</summary>
                <pre className="mt-2 bg-gray-900 border border-gray-700 rounded p-3 text-xs whitespace-pre-wrap max-h-96 overflow-auto">
                  {current.body}
                </pre>
              </details>
            </div>
          )}
        </section>

        <section className="bg-gray-800 border border-gray-700 rounded p-5 mb-6">
          <h2 className="font-bold mb-3">上書きアップロード（新しい版として保存）</h2>
          <div className="space-y-3 text-sm">
            <div>
              <input type="file" accept=".md,.txt,text/markdown,text/plain" onChange={handleFileChange} className="text-gray-300" />
              {fileName && <span className="ml-3 text-gray-400">{fileName}</span>}
            </div>
            <div>
              <label className="block text-gray-400 mb-1">改定メモ（何を変えたか）</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 outline-none"
              />
            </div>
            <button
              onClick={handleUpload}
              disabled={saving}
              className="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white px-4 py-2 rounded"
            >
              {saving ? '保存中...' : 'アップロードして保存'}
            </button>
          </div>
        </section>

        <section className="bg-gray-800 border border-gray-700 rounded p-5">
          <h2 className="font-bold mb-3">履歴</h2>
          {history.length === 0 ? (
            <p className="text-sm text-gray-400">履歴はまだありません。</p>
          ) : (
            <ul className="divide-y divide-gray-700 text-sm">
              {history.map((v) => (
                <li key={v.version} className="py-2 flex items-center justify-between gap-3">
                  <div>
                    <span className="font-bold text-blue-400">v{v.version}</span>
                    <span className="text-gray-400 ml-2">
                      {formatDateTime(v.updatedAt)}　{v.updatedBy}
                    </span>
                    <div className="text-gray-300">{v.note}</div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => downloadMarkdown(v)} className="text-xs px-3 py-1 rounded border border-gray-600 hover:bg-gray-700">
                      ダウンロード
                    </button>
                    {current && v.version !== current.version && (
                      restoreTarget === v.version ? (
                        <>
                          <button
                            onClick={() => handleRestore(v)}
                            disabled={saving}
                            className="text-xs px-3 py-1 rounded bg-orange-600 hover:bg-orange-500 disabled:opacity-50"
                          >
                            本当に戻す
                          </button>
                          <button onClick={() => setRestoreTarget(null)} className="text-xs px-3 py-1 rounded border border-gray-600 hover:bg-gray-700">
                            やめる
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setRestoreTarget(v.version)}
                          className="text-xs px-3 py-1 rounded border border-gray-600 hover:bg-gray-700"
                        >
                          この版に戻す
                        </button>
                      )
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
