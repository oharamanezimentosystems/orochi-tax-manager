# マネーフォワード クレジットカード連携・登録時の注意点

<div class="attention" style="background-color: #fff1f0; border: 1px solid #ffa39e; border-left: 5px solid #f5222d; padding: 15px; margin-bottom: 20px; border-radius: 4px;">
  <h4 style="color: #a8071a; margin-top: 0; font-weight: bold;">⚠️ 【最重要】未払金残高不一致の防止</h4>
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

---

## ⚙️ 初期設定（連携後に必ず行うこと）

<div style="display: flex; gap: 15px; margin-bottom: 20px;">
  <div style="flex: 1; background-color: #f0f5ff; border: 1px solid #adc6ff; padding: 15px; border-radius: 4px;">
    <h4 style="color: #1d39c4; font-weight: bold; margin-top: 0;">1. 補助科目の集約</h4>
    <p style="font-size: 0.85em;">「Amazonマスター」「ポイント」など複数に分かれた科目を1つにまとめます。</p>
    <div style="background: #fff; border: 1px solid #ccc; padding: 8px; font-size: 0.8em; border-radius: 3px; font-family: monospace;">
      [自動で仕訳] ＞ [連携サービスから入力] ＞ [登録済一覧] ＞ [科目設定]
    </div>
  </div>

  <div style="flex: 1; background-color: #f0f5ff; border: 1px solid #adc6ff; padding: 15px; border-radius: 4px;">
    <h4 style="color: #1d39c4; font-weight: bold; margin-top: 0;">2. 名称変更と削除</h4>
    <p style="font-size: 0.85em;">シンプルな名称（例: 三井住友カード）に変更し、不要な科目をゴミ箱で削除します。</p>
    <div style="background: #fff; border: 1px solid #ccc; padding: 8px; font-size: 0.8em; border-radius: 3px; font-family: monospace;">
      [各種設定] ＞ [勘定科目] ＞ 普通預金/未払金 の名称修正
    </div>
  </div>
</div>

---

## 🔄 預金引き落とし時の注意とルール修正

<div class="note" style="background-color: #f6ffed; border: 1px solid #b7eb8f; border-left: 5px solid #52c41a; padding: 15px; margin-bottom: 20px; border-radius: 4px;">
  <h4 style="color: #237804; margin-top: 0; font-weight: bold;">💡 3. 引き落とし時の「補助科目」を一致させる</h4>
  <p style="font-size: 0.9em;">預金から引落とされた際の未払金補助科目を、カード利用時の補助科目と**完全に一致**させます。</p>
  
  <h4 style="color: #237804; font-weight: bold; margin-top: 15px;">💡 4. 自動仕訳ルールの修正</h4>
  <p style="font-size: 0.9em; margin-bottom: 5px;">一度間違えると次回も間違ったルールが適用されるため、ルールの修正が必須です。</p>
  <div style="background: #fff; border: 1px solid #b7eb8f; padding: 8px; font-size: 0.85em; border-radius: 3px;">
    [自動で仕訳] ＞ [自動仕訳ルール] ＞ 口座を検索 ＞ 勘定科目を「未払金」、補助科目を「正しい名称」に修正
  </div>
</div>

---

## 📝 既に誤って計上してしまっている場合

<div style="background-color: #fafafa; border: 1px dashed #d9d9d9; padding: 15px; border-radius: 4px;">
  <h4 style="font-weight: bold; margin-top: 0;">5. 仕訳の一括編集と残高確認</h4>
  <ul style="font-size: 0.9em; padding-left: 20px;">
    <li><strong>一括修正：</strong> [会計帳簿] ＞ [仕訳帳] ＞ [一括編集] にて、誤った補助科目を検索し正しいものに一括変更します。</li>
    <li><strong>最終確認：</strong> [会計帳簿] ＞ [残高試算表(貸借対照表)] にて、不要な科目が残っていないか、マイナス残高がないか確認します。</li>
  </ul>
</div>