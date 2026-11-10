// ============================================================================
// 誰是臥底 - 雲端題庫持久化與多機房間同步服務 (cloud_service.js)
// ============================================================================

(function () {
  const STORAGE_KEYS = {
    CUSTOM_WORDS: "uc_custom_words_v1",
    DELETED_DEFAULT_IDS: "uc_deleted_defaults_v1",
    CLOUD_SETTINGS: "uc_cloud_settings_v1",
    PLAYER_PROFILE: "uc_player_profile_v1",
    ROOM_CACHE_PREFIX: "uc_room_state_"
  };

  // 解析並正規化 Firebase URL (支援使用者直接貼上整段 firebaseConfig 程式碼或純網址)
  function extractFirebaseUrl(input) {
    if (!input || typeof input !== "string") return "";
    const trimmed = input.trim();
    const match = trimmed.match(/https:\/\/[a-zA-Z0-9-]+\.(?:firebaseio\.com|[a-zA-Z0-9-]+\.firebasedatabase\.app)/);
    if (match) {
      return match[0].replace(/\/+$/, "");
    }
    if (trimmed.startsWith("https://")) {
      return trimmed.replace(/\/+$/, "");
    }
    return "";
  }

  class CloudService {
    constructor() {
      this.settings = this.loadSettings();
      this.listeners = new Set();
      this.roomListeners = new Set();
      this.currentRoomCode = null;
      this.isHost = false;
      this.peer = null;
      this.clientConnections = new Map(); // peerId -> DataConnection (Host 用)
      this.peerToPlayerId = new Map();    // peerId -> playerId (Host 追蹤斷線離開用)
      this.hostConnection = null;         // DataConnection (Client 用)
      this.firebasePollTimer = null;
      this.broadcastChannel = null;
      this.connectionStatus = "local"; // "cloud" | "p2p" | "local"

      this.initBroadcastChannel();
      this.checkUrlCloudParams();
    }

    // 支援透過網址參數自動帶入雲端資料庫設定 (方便分享給朋友或跨裝置直接共用題庫)
    checkUrlCloudParams() {
      try {
        const params = new URLSearchParams(window.location.search);
        const fbUrl = params.get("fb");
        if (fbUrl) {
          const cleanUrl = extractFirebaseUrl(decodeURIComponent(fbUrl));
          if (cleanUrl) {
            this.saveSettings({
              ...this.settings,
              provider: "firebase",
              firebaseDatabaseURL: cleanUrl
            });
          }
        }
      } catch (e) {
        console.warn("解析網址雲端參數失敗:", e);
      }
    }

    loadSettings() {
      const defaultCfg = window.CLOUD_CONFIG || {};
      let saved = {};
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.CLOUD_SETTINGS);
        if (raw) saved = JSON.parse(raw);
      } catch (e) {}

      const fbUrl = extractFirebaseUrl(saved.firebaseDatabaseURL || defaultCfg.firebaseDatabaseURL || "");
      const sbUrl = (saved.supabaseUrl || defaultCfg.supabaseUrl || "").trim().replace(/\/+$/, "");
      const sbKey = (saved.supabaseAnonKey || defaultCfg.supabaseAnonKey || "").trim();

      let provider = saved.provider || defaultCfg.provider || "auto";
      if (provider === "auto") {
        if (fbUrl) provider = "firebase";
        else if (sbUrl && sbKey) provider = "supabase";
        else provider = "none";
      }

      return {
        provider,
        firebaseDatabaseURL: fbUrl,
        supabaseUrl: sbUrl,
        supabaseAnonKey: sbKey
      };
    }

    saveSettings(newSettings) {
      const fbUrl = extractFirebaseUrl(newSettings.firebaseDatabaseURL || "");
      const sbUrl = (newSettings.supabaseUrl || "").trim().replace(/\/+$/, "");
      const sbKey = (newSettings.supabaseAnonKey || "").trim();
      let provider = newSettings.provider || "auto";
      if (provider === "auto") {
        if (fbUrl) provider = "firebase";
        else if (sbUrl && sbKey) provider = "supabase";
        else provider = "none";
      }

      this.settings = {
        provider,
        firebaseDatabaseURL: fbUrl,
        supabaseUrl: sbUrl,
        supabaseAnonKey: sbKey
      };
      localStorage.setItem(STORAGE_KEYS.CLOUD_SETTINGS, JSON.stringify(this.settings));
      this.notifyStatusChange();
      return this.settings;
    }

    isCloudConfigured() {
      if (this.settings.provider === "firebase" && this.settings.firebaseDatabaseURL) return true;
      if (this.settings.provider === "supabase" && this.settings.supabaseUrl && this.settings.supabaseAnonKey) return true;
      return false;
    }

    getCloudTypeLabel() {
      if (this.settings.provider === "firebase" && this.settings.firebaseDatabaseURL) {
        return "Firebase 雲端即時資料庫";
      }
      if (this.settings.provider === "supabase" && this.settings.supabaseUrl && this.settings.supabaseAnonKey) {
        return "Supabase 雲端資料庫";
      }
      return "WebRTC 雲端連線 + 本機儲存";
    }

    initBroadcastChannel() {
      if ("BroadcastChannel" in window) {
        this.broadcastChannel = new BroadcastChannel("uc_game_sync_channel");
        this.broadcastChannel.onmessage = (event) => {
          const msg = event.data;
          if (!msg) return;
          if (msg.type === "ROOM_STATE_UPDATE" && msg.roomCode === this.currentRoomCode) {
            this.emitRoomState(msg.state);
          } else if (msg.type === "CLIENT_ACTION" && this.isHost && msg.roomCode === this.currentRoomCode) {
            if (this.onHostReceiveAction) {
              this.onHostReceiveAction(msg.action);
            }
          } else if (msg.type === "WORDBANK_UPDATED") {
            if (this.onWordBankRemoteUpdate) {
              this.onWordBankRemoteUpdate();
            }
          }
        };
      }

      window.addEventListener("storage", (e) => {
        if (this.currentRoomCode && e.key === STORAGE_KEYS.ROOM_CACHE_PREFIX + this.currentRoomCode && e.newValue) {
          try {
            const state = JSON.parse(e.newValue);
            this.emitRoomState(state);
          } catch (err) {}
        }
      });
    }

    // ========================================================================
    // 題庫資料存取與雲端同步 (Word Bank Persistence)
    // ========================================================================

    getLocalCustomWords() {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.CUSTOM_WORDS);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    }

    saveLocalCustomWords(words) {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_WORDS, JSON.stringify(words));
    }

    getDeletedDefaultIds() {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.DELETED_DEFAULT_IDS);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    }

    saveDeletedDefaultIds(ids) {
      localStorage.setItem(STORAGE_KEYS.DELETED_DEFAULT_IDS, JSON.stringify(ids));
    }

    // 合併預設題庫與新增題庫，並依詞語組合自動去重
    mergeWords(baseList, newList) {
      const map = new Map();
      const makeKey = (a, b) => {
        const w1 = String(a || "").trim();
        const w2 = String(b || "").trim();
        return [w1, w2].sort().join("||");
      };

      for (const item of baseList) {
        if (!item || !item.wordA || !item.wordB) continue;
        map.set(makeKey(item.wordA, item.wordB), item);
      }
      for (const item of newList) {
        if (!item || !item.wordA || !item.wordB) continue;
        const key = makeKey(item.wordA, item.wordB);
        if (!map.has(key)) {
          map.set(key, item);
        } else {
          // 若已有相同詞組，更新其分類或提示
          const existing = map.get(key);
          map.set(key, {
            ...existing,
            category: item.category || existing.category,
            hint: item.hint || existing.hint
          });
        }
      }
      return Array.from(map.values());
    }

    // 從雲端拉取最新自訂題庫並與本地合併
    async fetchAndSyncWordBank() {
      let localCustom = this.getLocalCustomWords();
      let deletedIds = this.getDeletedDefaultIds();
      let cloudSynced = false;

      if (this.settings.provider === "firebase" && this.settings.firebaseDatabaseURL) {
        try {
          const res = await fetch(`${this.settings.firebaseDatabaseURL}/uc_wordbank.json`);
          if (res.ok) {
            const data = await res.json();
            if (data) {
              const cloudCustom = Array.isArray(data.customWords) ? data.customWords : [];
              const cloudDeleted = Array.isArray(data.deletedDefaultIds) ? data.deletedDefaultIds : [];
              localCustom = this.mergeWords(cloudCustom, localCustom);
              deletedIds = Array.from(new Set([...cloudDeleted, ...deletedIds]));
              this.saveLocalCustomWords(localCustom);
              this.saveDeletedDefaultIds(deletedIds);
              // 若本地有新詞但雲端還沒有，回寫至雲端
              if (localCustom.length > cloudCustom.length || deletedIds.length > cloudDeleted.length) {
                await this.pushWordBankToCloud(localCustom, deletedIds);
              }
            } else if (localCustom.length > 0) {
              await this.pushWordBankToCloud(localCustom, deletedIds);
            }
            cloudSynced = true;
          }
        } catch (err) {
          console.warn("Firebase 題庫同步失敗，使用本機快取:", err);
        }
      } else if (this.settings.provider === "supabase" && this.settings.supabaseUrl && this.settings.supabaseAnonKey) {
        try {
          const res = await fetch(`${this.settings.supabaseUrl}/rest/v1/uc_store?id=eq.wordbank&select=data`, {
            headers: {
              "apikey": this.settings.supabaseAnonKey,
              "Authorization": `Bearer ${this.settings.supabaseAnonKey}`
            }
          });
          if (res.ok) {
            const rows = await res.json();
            if (rows && rows.length > 0 && rows[0].data) {
              const cloudData = rows[0].data;
              const cloudCustom = Array.isArray(cloudData.customWords) ? cloudData.customWords : [];
              const cloudDeleted = Array.isArray(cloudData.deletedDefaultIds) ? cloudData.deletedDefaultIds : [];
              localCustom = this.mergeWords(cloudCustom, localCustom);
              deletedIds = Array.from(new Set([...cloudDeleted, ...deletedIds]));
              this.saveLocalCustomWords(localCustom);
              this.saveDeletedDefaultIds(deletedIds);
            }
            cloudSynced = true;
          }
        } catch (err) {
          console.warn("Supabase 題庫同步失敗，使用本機快取:", err);
        }
      }

      const defaults = (window.DEFAULT_WORD_BANK || []).filter(w => !deletedIds.includes(w.id));
      const allWords = this.mergeWords(defaults, localCustom);

      return {
        allWords,
        customWords: localCustom,
        defaultCount: defaults.length,
        customCount: localCustom.length,
        cloudSynced
      };
    }

    async pushWordBankToCloud(customWords, deletedDefaultIds) {
      const payload = {
        customWords: customWords || this.getLocalCustomWords(),
        deletedDefaultIds: deletedDefaultIds || this.getDeletedDefaultIds(),
        updatedAt: Date.now()
      };

      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({ type: "WORDBANK_UPDATED" });
      }

      if (this.settings.provider === "firebase" && this.settings.firebaseDatabaseURL) {
        try {
          const res = await fetch(`${this.settings.firebaseDatabaseURL}/uc_wordbank.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          return res.ok;
        } catch (e) {
          console.error("推送題庫至 Firebase 失敗:", e);
          return false;
        }
      } else if (this.settings.provider === "supabase" && this.settings.supabaseUrl && this.settings.supabaseAnonKey) {
        try {
          const res = await fetch(`${this.settings.supabaseUrl}/rest/v1/uc_store`, {
            method: "POST",
            headers: {
              "apikey": this.settings.supabaseAnonKey,
              "Authorization": `Bearer ${this.settings.supabaseAnonKey}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates"
            },
            body: JSON.stringify({
              id: "wordbank",
              data: payload,
              updated_at: new Date().toISOString()
            })
          });
          return res.ok;
        } catch (e) {
          console.error("推送題庫至 Supabase 失敗:", e);
          return false;
        }
      }
      return false;
    }

    // 新增單筆或多筆題庫並同步至雲端
    async addCustomWords(newWordItems) {
      const currentCustom = this.getLocalCustomWords();
      const allDefaults = window.DEFAULT_WORD_BANK || [];
      const existingKeys = new Set();

      const makeKey = (a, b) => [String(a).trim(), String(b).trim()].sort().join("||");
      allDefaults.forEach(w => existingKeys.add(makeKey(w.wordA, w.wordB)));
      currentCustom.forEach(w => existingKeys.add(makeKey(w.wordA, w.wordB)));

      let addedCount = 0;
      let duplicateCount = 0;
      const itemsToAdd = [];

      for (const raw of newWordItems) {
        const wA = String(raw.wordA || "").trim();
        const wB = String(raw.wordB || "").trim();
        if (!wA || !wB || wA === wB) continue;
        const key = makeKey(wA, wB);
        if (existingKeys.has(key)) {
          duplicateCount++;
          continue;
        }
        existingKeys.add(key);
        addedCount++;
        itemsToAdd.push({
          id: "custom_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
          wordA: wA,
          wordB: wB,
          category: String(raw.category || "自訂題庫").trim() || "自訂題庫",
          hint: String(raw.hint || "").trim(),
          isCustom: true,
          createdAt: Date.now()
        });
      }

      const updatedCustom = [...itemsToAdd, ...currentCustom];
      this.saveLocalCustomWords(updatedCustom);
      const cloudOk = await this.pushWordBankToCloud(updatedCustom, this.getDeletedDefaultIds());

      return {
        addedCount,
        duplicateCount,
        cloudOk,
        totalCustom: updatedCustom.length
      };
    }

    async deleteWordById(wordId) {
      if (String(wordId).startsWith("default_")) {
        const deleted = this.getDeletedDefaultIds();
        if (!deleted.includes(wordId)) {
          deleted.push(wordId);
          this.saveDeletedDefaultIds(deleted);
        }
      } else {
        const custom = this.getLocalCustomWords().filter(w => w.id !== wordId);
        this.saveLocalCustomWords(custom);
      }
      await this.pushWordBankToCloud(this.getLocalCustomWords(), this.getDeletedDefaultIds());
    }

    async restoreDefaultWords() {
      this.saveDeletedDefaultIds([]);
      await this.pushWordBankToCloud(this.getLocalCustomWords(), []);
    }

    // 測試雲端資料庫連線
    async testCloudConnection(testSettings) {
      const cfg = testSettings || this.settings;
      if (cfg.provider === "firebase" && cfg.firebaseDatabaseURL) {
        const url = extractFirebaseUrl(cfg.firebaseDatabaseURL);
        if (!url) return { ok: false, message: "Firebase 網址格式不正確" };
        try {
          const res = await fetch(`${url}/uc_ping.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ping: Date.now() })
          });
          if (res.ok) {
            return { ok: true, message: "Firebase 雲端資料庫讀寫測試成功！" };
          } else {
            return { ok: false, message: `連線回應狀態碼 ${res.status}，請確認 Realtime Database 規則 (Rules) 已開啟讀寫權限 (.read: true, .write: true)` };
          }
        } catch (e) {
          return { ok: false, message: "無法連線至 Firebase，請檢查網址是否正確：" + e.message };
        }
      } else if (cfg.provider === "supabase" && cfg.supabaseUrl && cfg.supabaseAnonKey) {
        try {
          const res = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/rest/v1/uc_store?select=id&limit=1`, {
            headers: {
              "apikey": cfg.supabaseAnonKey,
              "Authorization": `Bearer ${cfg.supabaseAnonKey}`
            }
          });
          if (res.ok) {
            return { ok: true, message: "Supabase 雲端資料庫連線成功！" };
          } else {
            return { ok: false, message: `Supabase 回應 ${res.status}，請確認已建立 uc_store 資料表且開啟 RLS 權限` };
          }
        } catch (e) {
          return { ok: false, message: "無法連線至 Supabase：" + e.message };
        }
      }
      return { ok: false, message: "請先選擇並填寫雲端資料庫設定" };
    }

    // ========================================================================
    // 多機連線房間同步系統 (Multi-Device Room Sync: Firebase + PeerJS WebRTC + Local)
    // ========================================================================

    getPeerIdForRoom(roomCode) {
      return `uc-tw-game-2026-room-${roomCode}`;
    }

    // 房主建立房間
    async createRoomAsHost(roomCode, initialRoomState, onActionCallback) {
      this.cleanupRoomConnections();
      this.currentRoomCode = roomCode;
      this.isHost = true;
      this.onHostReceiveAction = onActionCallback;

      // 1. 儲存至本機與 BroadcastChannel
      await this.publishRoomState(initialRoomState);

      // 2. 若有設定 Firebase，啟動雲端輪詢監聽玩家動作與狀態同步
      if (this.settings.provider === "firebase" && this.settings.firebaseDatabaseURL) {
        this.connectionStatus = "cloud";
        this.startFirebaseRoomSync(roomCode, true);
      }

      // 3. 同時啟動 PeerJS WebRTC 讓跨網路手機 (免設定 Firebase) 也能直接輸入房號連線！
      this.initHostPeerJS(roomCode, onActionCallback);
      this.notifyStatusChange();
    }

    // 玩家加入房間
    async joinRoomAsClient(roomCode, playerInfo, onStateReceived, onError) {
      this.cleanupRoomConnections();
      this.currentRoomCode = roomCode;
      this.isHost = false;

      let joinedSuccess = false;

      // 1. 檢查本機/同瀏覽器分頁是否已有此房間
      const localRaw = localStorage.getItem(STORAGE_KEYS.ROOM_CACHE_PREFIX + roomCode);
      if (localRaw) {
        try {
          const localState = JSON.parse(localRaw);
          if (localState && localState.roomCode === roomCode) {
            joinedSuccess = true;
            this.sendActionToHost({ type: "JOIN_ROOM", player: playerInfo });
            onStateReceived(localState);
          }
        } catch (e) {}
      }

      // 2. 若有設定 Firebase，從 Firebase 讀取房間並直接寫入玩家加入狀態
      if (this.settings.provider === "firebase" && this.settings.firebaseDatabaseURL) {
        try {
          const res = await fetch(`${this.settings.firebaseDatabaseURL}/uc_rooms/${roomCode}.json`);
          if (res.ok) {
            const fbRoom = await res.json();
            if (fbRoom && fbRoom.roomCode === roomCode) {
              joinedSuccess = true;
              this.connectionStatus = "cloud";
              // 將自己寫入 Firebase players 或 actions
              await this.sendActionToHost({ type: "JOIN_ROOM", player: playerInfo });
              onStateReceived(fbRoom);
              this.startFirebaseRoomSync(roomCode, false);
              this.notifyStatusChange();
            }
          }
        } catch (e) {
          console.warn("Firebase 讀取房間失敗，嘗試 P2P 連線:", e);
        }
      }

      // 3. 啟動 PeerJS 連線至房主 (支援跨手機/跨網路免資料庫連線)
      if (window.Peer) {
        try {
          await this.connectClientPeerJS(roomCode, playerInfo, (state) => {
            if (!joinedSuccess) {
              joinedSuccess = true;
            }
            onStateReceived(state);
          }, (errMsg) => {
            if (!joinedSuccess && onError) {
              onError(errMsg);
            }
          });
        } catch (e) {
          if (!joinedSuccess && onError) {
            onError("無法連線至房間，請確認房號是否正確或房主仍在線上");
          }
        }
      } else if (!joinedSuccess && onError) {
        onError("找不到該房間，請確認房號是否正確");
      }
    }

    initHostPeerJS(roomCode, onActionCallback) {
      if (!window.Peer) return;
      try {
        const peerId = this.getPeerIdForRoom(roomCode);
        this.peer = new window.Peer(peerId, {
          debug: 0
        });

        this.peer.on("open", () => {
          if (this.connectionStatus === "local") {
            this.connectionStatus = "p2p";
            this.notifyStatusChange();
          }
        });

        this.peer.on("connection", (conn) => {
          conn.on("open", () => {
            this.clientConnections.set(conn.peer, conn);
            // 立即發送最新房間狀態給新連線的玩家
            const latestRaw = localStorage.getItem(STORAGE_KEYS.ROOM_CACHE_PREFIX + roomCode);
            if (latestRaw) {
              try {
                conn.send({ type: "ROOM_STATE_UPDATE", state: JSON.parse(latestRaw) });
              } catch (e) {}
            }
          });

          conn.on("data", (data) => {
            if (data && data.type === "CLIENT_ACTION") {
              const act = data.action;
              if (act) {
                const pid = (act.player && act.player.id) || act.playerId || act.voterId;
                if (pid) {
                  this.peerToPlayerId.set(conn.peer, pid);
                }
                if (onActionCallback) {
                  onActionCallback(act);
                }
              }
            }
          });

          conn.on("close", () => {
            this.clientConnections.delete(conn.peer);
            const leftPlayerId = this.peerToPlayerId.get(conn.peer);
            if (leftPlayerId) {
              this.peerToPlayerId.delete(conn.peer);
              if (onActionCallback) {
                onActionCallback({ type: "LEAVE_ROOM", playerId: leftPlayerId });
              }
            }
          });
        });

        this.peer.on("error", (err) => {
          console.warn("PeerJS Host 提示:", err.type || err);
        });
      } catch (e) {
        console.warn("初始化 PeerJS 失敗:", e);
      }
    }

    connectClientPeerJS(roomCode, playerInfo, onStateReceived, onError) {
      return new Promise((resolve) => {
        const peer = new window.Peer({ debug: 0 });
        this.peer = peer;
        let connected = false;

        const timeout = setTimeout(() => {
          if (!connected) {
            onError("連線逾時，請確認房號是否正確且房主保持畫面開啟");
            resolve(false);
          }
        }, 7500);

        peer.on("open", () => {
          const hostPeerId = this.getPeerIdForRoom(roomCode);
          const conn = peer.connect(hostPeerId, { reliable: true });
          this.hostConnection = conn;

          conn.on("open", () => {
            connected = true;
            clearTimeout(timeout);
            if (this.connectionStatus === "local") {
              this.connectionStatus = "p2p";
              this.notifyStatusChange();
            }
            conn.send({
              type: "CLIENT_ACTION",
              action: { type: "JOIN_ROOM", player: playerInfo }
            });
            resolve(true);
          });

          conn.on("data", (data) => {
            if (data && data.type === "ROOM_STATE_UPDATE" && data.state) {
              localStorage.setItem(STORAGE_KEYS.ROOM_CACHE_PREFIX + roomCode, JSON.stringify(data.state));
              onStateReceived(data.state);
              this.emitRoomState(data.state);
            }
          });

          conn.on("close", () => {
            console.log("與房主的 P2P 連線已結束");
          });

          conn.on("error", (err) => {
            clearTimeout(timeout);
            if (!connected) onError("連線發生錯誤: " + err);
            resolve(false);
          });
        });

        peer.on("error", (err) => {
          clearTimeout(timeout);
          if (!connected) {
            onError("找不到房間 (" + roomCode + ")，請確認房號是否輸入正確");
          }
          resolve(false);
        });
      });
    }

    startFirebaseRoomSync(roomCode, isHost) {
      if (this.firebasePollTimer) clearInterval(this.firebasePollTimer);
      const baseUrl = this.settings.firebaseDatabaseURL;
      if (!baseUrl) return;

      this.firebasePollTimer = setInterval(async () => {
        if (!this.currentRoomCode || this.currentRoomCode !== roomCode) return;
        try {
          if (isHost) {
            // 房主檢查是否有來自玩家的待處理動作佇列
            const res = await fetch(`${baseUrl}/uc_room_actions/${roomCode}.json`);
            if (res.ok) {
              const actionsObj = await res.json();
              if (actionsObj && typeof actionsObj === "object") {
                // 清空已讀取的動作並依序執行
                await fetch(`${baseUrl}/uc_room_actions/${roomCode}.json`, { method: "DELETE" });
                const actionKeys = Object.keys(actionsObj);
                for (const k of actionKeys) {
                  if (this.onHostReceiveAction && actionsObj[k]) {
                    this.onHostReceiveAction(actionsObj[k]);
                  }
                }
              }
            }
          } else {
            // 玩家端拉取最新房間狀態
            const res = await fetch(`${baseUrl}/uc_rooms/${roomCode}.json`);
            if (res.ok) {
              const state = await res.json();
              if (state && state.roomCode === roomCode) {
                localStorage.setItem(STORAGE_KEYS.ROOM_CACHE_PREFIX + roomCode, JSON.stringify(state));
                this.emitRoomState(state);
              }
            }
          }
        } catch (e) {}
      }, 1200);
    }

    // 房主發布最新房間狀態給所有端點
    async publishRoomState(roomState) {
      if (!roomState || !roomState.roomCode) return;
      const roomCode = roomState.roomCode;
      roomState.updatedAt = Date.now();

      // 1. 本機儲存
      localStorage.setItem(STORAGE_KEYS.ROOM_CACHE_PREFIX + roomCode, JSON.stringify(roomState));

      // 2. 同裝置跨分頁廣播
      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({
          type: "ROOM_STATE_UPDATE",
          roomCode,
          state: roomState
        });
      }

      // 3. PeerJS WebRTC 廣播給所有連線手機
      for (const [peerId, conn] of this.clientConnections.entries()) {
        try {
          if (conn && conn.open) {
            conn.send({ type: "ROOM_STATE_UPDATE", state: roomState });
          }
        } catch (e) {}
      }

      // 4. Firebase 雲端房間同步
      if (this.settings.provider === "firebase" && this.settings.firebaseDatabaseURL) {
        try {
          await fetch(`${this.settings.firebaseDatabaseURL}/uc_rooms/${roomCode}.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(roomState)
          });
        } catch (e) {}
      }
    }

    // 玩家發送操作給房主 (如：加入房間、已看牌、送出發言描述、投票)
    async sendActionToHost(action) {
      if (!this.currentRoomCode) return;
      const roomCode = this.currentRoomCode;

      if (this.isHost && this.onHostReceiveAction) {
        this.onHostReceiveAction(action);
        return;
      }

      // 1. BroadcastChannel (同瀏覽器分頁)
      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({
          type: "CLIENT_ACTION",
          roomCode,
          action
        });
      }

      // 2. PeerJS WebRTC 傳送給房主
      if (this.hostConnection && this.hostConnection.open) {
        try {
          this.hostConnection.send({
            type: "CLIENT_ACTION",
            action
          });
        } catch (e) {}
      }

      // 3. Firebase Action Queue
      if (this.settings.provider === "firebase" && this.settings.firebaseDatabaseURL) {
        try {
          await fetch(`${this.settings.firebaseDatabaseURL}/uc_room_actions/${roomCode}.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...action, ts: Date.now() })
          });
        } catch (e) {}
      }
    }

    onRoomStateChange(cb) {
      this.roomListeners.add(cb);
      return () => this.roomListeners.delete(cb);
    }

    emitRoomState(state) {
      for (const cb of this.roomListeners) {
        try {
          cb(state);
        } catch (e) {}
      }
    }

    onStatusChange(cb) {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    }

    notifyStatusChange() {
      for (const cb of this.listeners) {
        try {
          cb(this.getStatusSummary());
        } catch (e) {}
      }
    }

    getStatusSummary() {
      return {
        isCloudConfigured: this.isCloudConfigured(),
        cloudLabel: this.getCloudTypeLabel(),
        connectionStatus: this.connectionStatus,
        settings: this.settings
      };
    }

    async leaveCurrentRoom(playerId) {
      if (this.currentRoomCode && playerId && !this.isHost) {
        await this.sendActionToHost({
          type: "LEAVE_ROOM",
          playerId
        });
        await new Promise(r => setTimeout(r, 150));
      }
      this.cleanupRoomConnections();
    }

    cleanupRoomConnections() {
      if (this.firebasePollTimer) {
        clearInterval(this.firebasePollTimer);
        this.firebasePollTimer = null;
      }
      if (this.hostConnection) {
        try { this.hostConnection.close(); } catch (e) {}
        this.hostConnection = null;
      }
      for (const conn of this.clientConnections.values()) {
        try { conn.close(); } catch (e) {}
      }
      this.clientConnections.clear();
      this.peerToPlayerId.clear();
      if (this.peer) {
        try { this.peer.destroy(); } catch (e) {}
        this.peer = null;
      }
      this.currentRoomCode = null;
      this.isHost = false;
    }
  }

  window.cloudService = new CloudService();
})();

