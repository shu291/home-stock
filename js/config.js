// ここを自分の値に書き換える(README参照)。空のままなら「この端末だけ」のお試しモードで動く。
export const firebaseConfig = {
  apiKey: "AIzaSyDdZhv0v3J1H7j9IVk2OaiSpWSRlpqlKNw",
  authDomain: "home-stock-56ec9.firebaseapp.com",
  projectId: "home-stock-56ec9",
  appId: "1:288035091770:web:a1ea6fd31c6101b8e54c03",
};

// Gmail連携用 Google OAuth クライアントID(ウェブアプリ用)。空ならGmail取り込みは非表示。
export const googleClientId = "";

// 楽天ウェブサービス(商品名の検索用・任意)。空なら Open Food Facts だけで検索する。
export const rakutenApi = { applicationId: "874b8348-a98b-437b-a703-222bcebb8e6b", accessKey: "pk_lrndQCDJMBA5cc3FZk1TKfyZdvNbDgLipTPTNvWwk9X" };
