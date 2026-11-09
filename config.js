// ============================================================================
// 誰是臥底 - 雲端資料庫設定檔 (可於此處預設，或直接在網頁右上角「雲端設定」介面中設定)
// ============================================================================
// 支援兩種雲端資料庫模式：
// 1. Firebase Realtime Database (最推薦！只需填寫 databaseURL 即可同步題庫與房間)
//    例如: "https://your-project-default-rtdb.firebaseio.com"
// 2. Supabase (填寫 supabaseUrl 與 supabaseAnonKey)
//
// 註：即使尚未填寫以下設定，本網頁亦內建「WebRTC 跨裝置即時連線 (PeerJS)」與
//     「瀏覽器持久化儲存 (LocalStorage)」，可直接掃碼開房遊玩！
// ============================================================================

window.CLOUD_CONFIG = {
  // 模式選擇: "firebase" | "supabase" | "auto"
  provider: "auto",

  // 【方式一：Firebase Realtime Database】
  // 至 https://console.firebase.google.com/ 建立專案 -> Realtime Database -> 以測試模式啟動
  // 將資料庫網址貼在下方即可，全網開啟此網頁的人都會自動共用雲端題庫！
  firebaseDatabaseURL: "",

  // 【方式二：Supabase】
  // 若使用 Supabase，請建立名為 `uc_store` 的資料表 (欄位: id text primary key, data jsonb, updated_at timestamptz)
  supabaseUrl: "",
  supabaseAnonKey: ""
};

