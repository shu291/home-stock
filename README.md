# うちの在庫

家族で共有できる家の在庫管理アプリ(PWA・ビルド不要)。

- 在庫の一覧・＋/−・検索・カテゴリ/置き場所での絞り込み・期限
- 最低在庫を下回ると「買い物」リストに自動で出る → 「買った」で補充
- 取り込み: **レシート写真**(Tesseract.js で端末内OCR)/ **Gmailの注文確認メール**(Amazon・楽天)/ **テキスト貼り付け**
  - 取り込み前に必ず確認画面で名前・数量を直せる。同名品は数量を加算。Gmailは取り込み済みを自動で除外
- 家族共有: Firebase(Google ログイン + Firestore リアルタイム同期)。家族コードで参加
- `js/config.js` が空のままなら、この端末だけで動く「お試しモード」

## セットアップ(共有を使う場合)

1. [Firebase コンソール](https://console.firebase.google.com/)でプロジェクト作成(Spark=無料でOK。Storage は使わない)
2. Authentication → Sign-in method で **Google** を有効化。承認済みドメインに公開先(例 `<ユーザー名>.github.io`)を追加
3. Firestore Database を作成し、`firestore.rules` の内容をルールに貼って公開
4. プロジェクト設定 → ウェブアプリ追加 → 表示された設定を `js/config.js` の `firebaseConfig` に貼る
   (この値は公開されても問題ない設計。守っているのはルール)
5. (Gmail連携) Google Cloud Console の同プロジェクトで OAuth クライアントID(ウェブ)を作成し、
   承認済み JavaScript 生成元に公開URLを登録 → `googleClientId` に設定。
   OAuth同意画面は「テスト」のまま、テストユーザーに家族のGmailを追加すれば審査不要
6. GitHub Pages(Settings → Pages → main / root)で公開 → iPhone は Safari で開いて「ホーム画面に追加」

## 注意

- Amazon に公式APIは無いため、注文確認メールの本文を解析しています。メール書式が変わると拾えないことがあるので、確認画面で直してください(解析は `js/parse.js` の `parseOrderMail`)
- 日本語レシートのOCRは精度が高くありません。写真は明るく真上から撮ると改善します
- 写真・メール本文は保存しません。保存されるのは品目データだけです
