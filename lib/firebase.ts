import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// 提供いただいた設定値
const firebaseConfig = {
  apiKey: "AIzaSyANaPUC7LFXqAX62i_gvklxbkhmiJuJ8Lw",
  authDomain: "orochi-tax-manager.firebaseapp.com",
  projectId: "orochi-tax-manager",
  storageBucket: "orochi-tax-manager.firebasestorage.app",
  messagingSenderId: "855851330622",
  appId: "1:855851330622:web:b22e737871f54cafd2b56f",
  measurementId: "G-3BD9J67D6R"
};

// Next.jsの再レンダリング時に二重初期化エラーを防ぐためのチェック処理
// アプリが既に存在すればそれを取得し、なければ新しく初期化します
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// 認証機能とデータベース機能をエクスポート
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };