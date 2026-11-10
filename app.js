// ============================================================================
// 誰是臥底 Online - 核心遊戲邏輯與題庫管理系統 (app.js)
// ============================================================================

const AVATARS = ["🕵️", "🦊", "🐼", "🦁", "🐸", "🐱", "🐶", "🦉", "🦄", "🐧", "🐯", "🐨"];

const AppState = {
  activeTab: "game", // "game" | "wordbank" | "cloud" | "rules"
  myPlayer: {
    id: "",
    name: "",
    avatar: "🕵️"
  },
  // 若房主在同機新增「本機代管玩家」方便單機或少手機混玩時切換視角
  viewingPlayerId: "",

  // 房間內展開修改個人暱稱與頭像面板
  isEditingProfileInRoom: false,
  roomDraftAvatar: "",

  // 房間狀態 (與雲端/PeerJS 同步)
  room: null,

  // 個人翻牌顯示狀態
  cardRevealed: false,

  // 題庫資料
  wordBank: {
    allWords: [],
    customWords: [],
    defaultCount: 120,
    customCount: 0,
    cloudSynced: false
  },

  // 題庫篩選條件
  wbFilter: {
    search: "",
    category: "ALL",
    source: "ALL", // "ALL" | "DEFAULT" | "CUSTOM"
    page: 1,
    pageSize: 24
  },

  // 已在本房間玩過的題目 ID 紀錄，避免重複抽題
  usedWordIds: new Set()
};

// ============================================================================
// 初始化與個人檔案
// ============================================================================

function initPlayerProfile() {
  // 每個瀏覽器分頁擁有獨立 session playerId，方便同一台電腦開多分頁測試多機連線
  let tabPlayerId = sessionStorage.getItem("uc_tab_player_id");
  if (!tabPlayerId) {
    tabPlayerId = "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 6);
    sessionStorage.setItem("uc_tab_player_id", tabPlayerId);
  }

  let savedProfile = null;
  try {
    const raw = localStorage.getItem("uc_player_profile_v1");
    if (raw) savedProfile = JSON.parse(raw);
  } catch (e) {}

  const randomAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  const randomSuffix = Math.floor(100 + Math.random() * 900);

  AppState.myPlayer = {
    id: tabPlayerId,
    name: (savedProfile && savedProfile.name) ? savedProfile.name : `特務${randomSuffix}`,
    avatar: (savedProfile && savedProfile.avatar) ? savedProfile.avatar : randomAvatar
  };
  AppState.viewingPlayerId = AppState.myPlayer.id;
}

function savePlayerProfile(name, avatar) {
  AppState.myPlayer.name = (name || "").trim() || AppState.myPlayer.name;
  AppState.myPlayer.avatar = avatar || AppState.myPlayer.avatar;
  localStorage.setItem("uc_player_profile_v1", JSON.stringify({
    name: AppState.myPlayer.name,
    avatar: AppState.myPlayer.avatar
  }));

  // 若已在房間中，同步更新名稱與頭像
  if (AppState.room) {
    window.cloudService.sendActionToHost({
      type: "UPDATE_PLAYER_PROFILE",
      playerId: AppState.myPlayer.id,
      name: AppState.myPlayer.name,
      avatar: AppState.myPlayer.avatar
    });
  }
}

// ============================================================================
// 房間建立、加入與房主權威狀態機 (3~20 人支援 + 思考秒數倒數)
// ============================================================================

function createInitialRoomState(roomCode, hostPlayer) {
  return {
    roomCode,
    hostId: hostPlayer.id,
    phase: "LOBBY", // "LOBBY" | "SPEAKING" | "VOTING" | "GAME_OVER"
    round: 1,
    settings: {
      maxPlayers: 8,           // 可自由調整 3 ~ 20 人
      thinkingTimeSeconds: 30, // 每人思考發言秒數 (0 代表不限時)
      undercoverCount: 1,
      blankCount: 0,
      category: "ALL",
      randomSwapWords: true,
      revealRoleOnEliminate: true
    },
    players: [
      {
        id: hostPlayer.id,
        name: hostPlayer.name,
        avatar: hostPlayer.avatar,
        isHost: true,
        isLocalBot: false,
        role: null,        // "CIVILIAN" | "UNDERCOVER" | "BLANK"
        word: "",
        alive: true,
        cardChecked: false,
        votedFor: null
      }
    ],
    currentWordPair: null, // { id, civilianWord, undercoverWord, category, hint }
    speakingOrder: [],     // array of playerIds
    currentSpeakerIdx: 0,
    speakerDeadline: null, // 當前發言者思考截止時間戳 (ms)
    speakerTotalSeconds: 30,
    clues: [],             // [{ round, playerId, playerName, playerAvatar, text, time }]
    voteTieCandidates: [], // 若平票 PK 時限定可投對象
    voteHistory: [],       // [{ round, votes: { voterId: targetId }, eliminatedId, isTie }]
    winner: null,          // "CIVILIAN" | "UNDERCOVER" | "BLANK"
    winReason: "",
    updatedAt: Date.now()
  };
}

// 依據玩家人數自動計算建議的臥底與白板數量 (支援 3~20人)
function getRecommendedRoleCounts(playerCount) {
  if (playerCount <= 4) return { undercover: 1, blank: 0 };
  if (playerCount <= 6) return { undercover: 1, blank: 1 };
  if (playerCount <= 8) return { undercover: 2, blank: 1 };
  if (playerCount <= 11) return { undercover: 3, blank: 1 };
  if (playerCount <= 14) return { undercover: 4, blank: 1 };
  if (playerCount <= 17) return { undercover: 5, blank: 2 };
  return { undercover: 6, blank: 2 }; // 18~20人
}

function clampRoleSettings(playerCount, settings) {
  const count = Math.max(3, Math.min(20, playerCount));
  let uc = parseInt(settings.undercoverCount, 10);
  if (isNaN(uc)) uc = 1;
  let blank = parseInt(settings.blankCount, 10);
  if (isNaN(blank)) blank = 0;

  // 臥底至少 1 人，且 (臥底 + 白板) 必須小於總人數的一半 (3人局例外：2平民 + 1臥底)
  const maxSpecial = count === 3 ? 1 : Math.floor((count - 1) / 2);
  if (uc < 1) uc = 1;
  if (uc > maxSpecial) uc = maxSpecial;
  if (blank < 0) blank = 0;
  if (uc + blank > maxSpecial) {
    blank = Math.max(0, maxSpecial - uc);
  }
  return { undercoverCount: uc, blankCount: blank };
}

function resetSpeakerTimer(room, extraSeconds = 0) {
  const baseSec = Math.max(0, parseInt(room.settings.thinkingTimeSeconds ?? 30, 10) || 0);
  if (baseSec <= 0 && extraSeconds <= 0) {
    room.speakerDeadline = null;
    room.speakerTotalSeconds = 0;
    return;
  }
  const totalSec = baseSec + extraSeconds;
  room.speakerTotalSeconds = totalSec;
  room.speakerDeadline = Date.now() + totalSec * 1000;
}

// 房主處理所有玩家發送過來的 Action
function handleHostAction(action) {
  if (!AppState.room || AppState.room.hostId !== AppState.myPlayer.id) return;
  const room = JSON.parse(JSON.stringify(AppState.room));

  switch (action.type) {
    case "JOIN_ROOM": {
      const p = action.player;
      if (!p || !p.id) break;
      const existing = room.players.find(x => x.id === p.id);
      if (existing) {
        existing.name = p.name || existing.name;
        existing.avatar = p.avatar || existing.avatar;
      } else {
        const maxAllowed = Math.max(3, Math.min(20, parseInt(room.settings.maxPlayers, 10) || 8));
        if (room.players.length >= 20) {
          break;
        }
        // 若實際加入人數超過原本設定的座位數 (且未滿 20 人)，自動擴充座位上限
        if (room.players.length >= maxAllowed && room.players.length < 20) {
          room.settings.maxPlayers = room.players.length + 1;
        }
        if (room.phase !== "LOBBY") {
          // 遊戲進行中加入視為觀戰或等待下一局
          room.players.push({
            id: p.id,
            name: p.name,
            avatar: p.avatar || "🕵️",
            isHost: false,
            isLocalBot: !!p.isLocalBot,
            role: null,
            word: "",
            alive: false,
            cardChecked: false,
            votedFor: null
          });
        } else {
          room.players.push({
            id: p.id,
            name: p.name,
            avatar: p.avatar || "🕵️",
            isHost: false,
            isLocalBot: !!p.isLocalBot,
            role: null,
            word: "",
            alive: true,
            cardChecked: false,
            votedFor: null
          });
          // 自動調整合法角色人數
          const clamped = clampRoleSettings(room.players.length, room.settings);
          room.settings.undercoverCount = clamped.undercoverCount;
          room.settings.blankCount = clamped.blankCount;
        }
      }
      break;
    }

    case "UPDATE_PLAYER_PROFILE": {
      const target = room.players.find(x => x.id === action.playerId);
      if (target) {
        if (action.name && String(action.name).trim()) {
          target.name = String(action.name).trim().slice(0, 12);
        }
        if (action.avatar) {
          target.avatar = action.avatar;
        }
        // 同步更新歷史發言紀錄中的名稱與頭像
        if (Array.isArray(room.clues)) {
          room.clues.forEach(c => {
            if (c.playerId === target.id) {
              c.playerName = target.name;
              c.playerAvatar = target.avatar;
            }
          });
        }
      }
      break;
    }

    case "LEAVE_ROOM":
    case "REMOVE_PLAYER": {
      const targetId = action.playerId;
      if (!targetId) break;
      const leavingPlayer = room.players.find(x => x.id === targetId && !x.isHost);
      if (!leavingPlayer) break;

      room.players = room.players.filter(x => x.id !== targetId || x.isHost);

      if (room.phase === "LOBBY") {
        const clamped = clampRoleSettings(room.players.length, room.settings);
        room.settings.undercoverCount = clamped.undercoverCount;
        room.settings.blankCount = clamped.blankCount;
      } else if (room.phase === "SPEAKING" || room.phase === "VOTING") {
        const currentSpeakerId = room.speakingOrder[room.currentSpeakerIdx];
        const removedSpeakerIdx = room.speakingOrder.indexOf(targetId);
        if (removedSpeakerIdx !== -1) {
          room.speakingOrder.splice(removedSpeakerIdx, 1);
          if (removedSpeakerIdx < room.currentSpeakerIdx) {
            room.currentSpeakerIdx = Math.max(0, room.currentSpeakerIdx - 1);
          } else if (room.currentSpeakerIdx >= room.speakingOrder.length) {
            room.currentSpeakerIdx = Math.max(0, room.speakingOrder.length - 1);
          }
        }
        if (room.voteTieCandidates) {
          room.voteTieCandidates = room.voteTieCandidates.filter(id => id !== targetId);
        }

        // 若剩餘玩家不足 2 人或已達成勝負條件
        const winCheck = evaluateVictoryCondition(room);
        if (winCheck.isOver) {
          room.phase = "GAME_OVER";
          room.winner = winCheck.winner;
          room.winReason = winCheck.reason;
          room.speakerDeadline = null;
        } else if (room.phase === "SPEAKING" && currentSpeakerId === targetId) {
          resetSpeakerTimer(room);
        } else if (room.phase === "VOTING") {
          const allAliveVoted = room.players.filter(x => x.alive).every(x => !!x.votedFor);
          if (allAliveVoted && room.players.filter(x => x.alive).length > 0) {
            resolveVotingRound(room);
          }
        }
      }
      break;
    }

    case "UPDATE_SETTINGS": {
      if (room.phase !== "LOBBY") break;
      room.settings = {
        ...room.settings,
        ...action.settings
      };
      // 正規化房間人數上限 (3 ~ 20 人)
      let maxP = parseInt(room.settings.maxPlayers, 10);
      if (isNaN(maxP)) maxP = 8;
      maxP = Math.max(3, Math.min(20, maxP));

      // 若調低人數上限且場上有超額的本機測試座位，自動移除多餘的本機測試座位
      while (room.players.length > maxP) {
        const lastBotIdx = room.players.map(p => p.isLocalBot).lastIndexOf(true);
        if (lastBotIdx !== -1) {
          room.players.splice(lastBotIdx, 1);
        } else {
          maxP = room.players.length;
          break;
        }
      }
      room.settings.maxPlayers = maxP;

      // 正規化每人思考秒數 (0 ~ 300 秒)
      let thinkSec = parseInt(room.settings.thinkingTimeSeconds, 10);
      if (isNaN(thinkSec) || thinkSec < 0) thinkSec = 0;
      if (thinkSec > 300) thinkSec = 300;
      room.settings.thinkingTimeSeconds = thinkSec;

      const clamped = clampRoleSettings(Math.max(room.players.length, 3), room.settings);
      room.settings.undercoverCount = clamped.undercoverCount;
      room.settings.blankCount = clamped.blankCount;
      break;
    }

    case "MARK_CARD_CHECKED": {
      const p = room.players.find(x => x.id === action.playerId);
      if (p) {
        p.cardChecked = true;
      }
      break;
    }

    case "SUBMIT_CLUE": {
      const p = room.players.find(x => x.id === action.playerId);
      if (!p || !p.alive) break;
      const text = String(action.text || "").trim();
      if (text) {
        room.clues.push({
          round: room.round,
          playerId: p.id,
          playerName: p.name,
          playerAvatar: p.avatar,
          text,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        });
      }
      // 若是當前發言者送出描述，自動推進至下一位發言者並重設思考計時
      const currentSpeakerId = room.speakingOrder[room.currentSpeakerIdx];
      if (currentSpeakerId === p.id) {
        if (room.currentSpeakerIdx < room.speakingOrder.length - 1) {
          room.currentSpeakerIdx++;
          resetSpeakerTimer(room);
        } else {
          room.phase = "VOTING";
          room.speakerDeadline = null;
          room.voteTieCandidates = [];
          room.players.forEach(pl => { pl.votedFor = null; });
        }
      }
      break;
    }

    case "NEXT_SPEAKER": {
      if (room.currentSpeakerIdx < room.speakingOrder.length - 1) {
        room.currentSpeakerIdx++;
        resetSpeakerTimer(room);
      } else {
        // 全員發言完畢，進入投票階段
        room.phase = "VOTING";
        room.speakerDeadline = null;
        room.voteTieCandidates = [];
        room.players.forEach(p => { p.votedFor = null; });
      }
      break;
    }

    case "EXTEND_SPEAKER_TIME": {
      if (room.phase === "SPEAKING") {
        const extra = parseInt(action.seconds, 10) || 15;
        const now = Date.now();
        const base = (room.speakerDeadline && room.speakerDeadline > now) ? room.speakerDeadline : now;
        room.speakerDeadline = base + extra * 1000;
        room.speakerTotalSeconds = (room.speakerTotalSeconds || 30) + extra;
      }
      break;
    }

    case "START_VOTING": {
      room.phase = "VOTING";
      room.speakerDeadline = null;
      room.voteTieCandidates = [];
      room.players.forEach(p => { p.votedFor = null; });
      break;
    }

    case "CAST_VOTE": {
      if (room.phase !== "VOTING") break;
      const voter = room.players.find(x => x.id === action.voterId);
      if (!voter || !voter.alive) break;
      voter.votedFor = action.targetId || "ABSTAIN";

      // 檢查是否所有存活玩家都已投票
      const allAliveVoted = room.players.filter(x => x.alive).every(x => !!x.votedFor);
      if (allAliveVoted) {
        resolveVotingRound(room);
      }
      break;
    }

    case "FORCE_RESOLVE_VOTE": {
      if (room.phase === "VOTING") {
        resolveVotingRound(room);
      }
      break;
    }

    default:
      break;
  }

  AppState.room = room;
  window.cloudService.publishRoomState(room);
  renderApp();
}

// 房主開始新局並發牌
function startNewGameRound() {
  if (!AppState.room || AppState.room.hostId !== AppState.myPlayer.id) return;
  const room = JSON.parse(JSON.stringify(AppState.room));

  if (room.players.length < 3 || room.players.length > 20) {
    showToast("遊戲人數需為 3 ~ 20 人！目前為 " + room.players.length + " 人", "warning");
    return;
  }

  // 1. 篩選題庫
  let pool = AppState.wordBank.allWords || [];
  if (room.settings.category && room.settings.category !== "ALL") {
    if (room.settings.category === "CUSTOM_ONLY") {
      pool = pool.filter(w => w.isCustom);
    } else {
      pool = pool.filter(w => w.category === room.settings.category);
    }
  }

  if (pool.length === 0) {
    showToast("該分類下沒有題目，已自動切換為全部題庫", "info");
    pool = AppState.wordBank.allWords || [];
  }

  // 優先挑選尚未玩過的題目
  let unusedPool = pool.filter(w => !AppState.usedWordIds.has(w.id));
  if (unusedPool.length === 0) {
    AppState.usedWordIds.clear();
    unusedPool = pool;
  }

  const chosen = unusedPool[Math.floor(Math.random() * unusedPool.length)];
  AppState.usedWordIds.add(chosen.id);

  // 2. 決定平民詞與臥底詞是否隨機互換
  const swap = room.settings.randomSwapWords ? (Math.random() < 0.5) : false;
  const civilianWord = swap ? chosen.wordB : chosen.wordA;
  const undercoverWord = swap ? chosen.wordA : chosen.wordB;

  room.currentWordPair = {
    id: chosen.id,
    civilianWord,
    undercoverWord,
    category: chosen.category,
    hint: chosen.hint || ""
  };

  // 3. 分配角色 (平民 / 臥底 / 白板)
  const clamped = clampRoleSettings(room.players.length, room.settings);
  const ucCount = clamped.undercoverCount;
  const blankCount = clamped.blankCount;

  const indices = room.players.map((_, idx) => idx);
  // 洗牌演算法 (Fisher-Yates)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const ucSet = new Set(indices.slice(0, ucCount));
  const blankSet = new Set(indices.slice(ucCount, ucCount + blankCount));

  room.players.forEach((p, idx) => {
    p.alive = true;
    p.cardChecked = false;
    p.votedFor = null;
    if (ucSet.has(idx)) {
      p.role = "UNDERCOVER";
      p.word = undercoverWord;
    } else if (blankSet.has(idx)) {
      p.role = "BLANK";
      p.word = "";
    } else {
      p.role = "CIVILIAN";
      p.word = civilianWord;
    }
  });

  // 4. 決定第一輪發言順序（貼心規則：避免白板在第一輪第一個發言）
  room.round = 1;
  room.phase = "SPEAKING";
  room.clues = [];
  room.voteTieCandidates = [];
  room.voteHistory = [];
  room.winner = null;
  room.winReason = "";

  setupSpeakingOrderForRound(room, true);

  AppState.cardRevealed = false;
  AppState.room = room;
  window.cloudService.publishRoomState(room);
  renderApp();
  showToast("🎲 已發牌！請各位玩家在手機上點擊翻開自己的詞語卡", "success");
}

function setupSpeakingOrderForRound(room, avoidBlankFirst = false) {
  const alivePlayers = room.players.filter(p => p.alive);
  if (alivePlayers.length === 0) return;

  let startIdx = Math.floor(Math.random() * alivePlayers.length);
  if (avoidBlankFirst && alivePlayers.length > 1) {
    const nonBlankIndices = alivePlayers
      .map((p, idx) => (p.role !== "BLANK" ? idx : -1))
      .filter(idx => idx !== -1);
    if (nonBlankIndices.length > 0) {
      startIdx = nonBlankIndices[Math.floor(Math.random() * nonBlankIndices.length)];
    }
  }

  const order = [];
  for (let i = 0; i < alivePlayers.length; i++) {
    order.push(alivePlayers[(startIdx + i) % alivePlayers.length].id);
  }
  room.speakingOrder = order;
  room.currentSpeakerIdx = 0;
  resetSpeakerTimer(room);
}

// 結算投票與勝負判定
function resolveVotingRound(room) {
  const tally = {};
  const voteRecord = {};

  const alivePlayers = room.players.filter(p => p.alive);
  alivePlayers.forEach(voter => {
    const targetId = voter.votedFor || "ABSTAIN";
    voteRecord[voter.id] = targetId;
    if (targetId && targetId !== "ABSTAIN") {
      tally[targetId] = (tally[targetId] || 0) + 1;
    }
  });

  let maxVotes = 0;
  for (const targetId of Object.keys(tally)) {
    if (tally[targetId] > maxVotes) {
      maxVotes = tally[targetId];
    }
  }

  const topCandidates = Object.keys(tally).filter(id => tally[id] === maxVotes);

  // 無人投票或全員棄票
  if (maxVotes === 0) {
    room.voteHistory.push({
      round: room.round,
      votes: voteRecord,
      eliminatedId: null,
      isTie: true,
      note: "全員棄票，無人出局"
    });
    room.round++;
    room.phase = "SPEAKING";
    room.voteTieCandidates = [];
    room.players.forEach(p => { p.votedFor = null; });
    setupSpeakingOrderForRound(room, false);
    return;
  }

  // 平票情況處理
  if (topCandidates.length > 1) {
    // 若尚未進行過 PK 投票，進入平票 PK 重投；若已經是 PK 仍平票，則無人出局進入下一輪
    if (!room.voteTieCandidates || room.voteTieCandidates.length === 0) {
      room.voteHistory.push({
        round: room.round,
        votes: voteRecord,
        eliminatedId: null,
        isTie: true,
        note: `平票進入 PK 重投（最高票 ${maxVotes} 票）`
      });
      room.voteTieCandidates = topCandidates;
      room.players.forEach(p => { p.votedFor = null; });
      return;
    } else {
      room.voteHistory.push({
        round: room.round,
        votes: voteRecord,
        eliminatedId: null,
        isTie: true,
        note: "PK 再次平票，本輪無人出局"
      });
      room.voteTieCandidates = [];
      room.round++;
      room.phase = "SPEAKING";
      room.players.forEach(p => { p.votedFor = null; });
      setupSpeakingOrderForRound(room, false);
      return;
    }
  }

  // 單一最高票玩家出局
  const eliminatedId = topCandidates[0];
  const eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
  if (eliminatedPlayer) {
    eliminatedPlayer.alive = false;
  }

  room.voteHistory.push({
    round: room.round,
    votes: voteRecord,
    eliminatedId,
    isTie: false,
    note: `${eliminatedPlayer ? eliminatedPlayer.name : "玩家"} 以 ${maxVotes} 票出局`
  });

  room.voteTieCandidates = [];
  room.players.forEach(p => { p.votedFor = null; });

  // 檢查勝負條件
  const gameOverCheck = evaluateVictoryCondition(room);
  if (gameOverCheck.isOver) {
    room.phase = "GAME_OVER";
    room.winner = gameOverCheck.winner;
    room.winReason = gameOverCheck.reason;
  } else {
    room.round++;
    room.phase = "SPEAKING";
    setupSpeakingOrderForRound(room, false);
  }
}

function evaluateVictoryCondition(room) {
  const alive = room.players.filter(p => p.alive);
  const aliveCivilians = alive.filter(p => p.role === "CIVILIAN").length;
  const aliveUndercovers = alive.filter(p => p.role === "UNDERCOVER").length;
  const aliveBlanks = alive.filter(p => p.role === "BLANK").length;

  // 1. 臥底與白板全數出局 -> 平民勝利
  if (aliveUndercovers === 0 && aliveBlanks === 0) {
    return {
      isOver: true,
      winner: "CIVILIAN",
      reason: "所有臥底與白板皆已被找出並淘汰，平民陣營獲勝！"
    };
  }

  // 2. 臥底存活且人數達到或超過平民（或總存活人數 <= 2） -> 臥底勝利
  if (aliveUndercovers > 0 && (alive.length <= 2 || aliveCivilians <= aliveUndercovers)) {
    return {
      isOver: true,
      winner: "UNDERCOVER",
      reason: `臥底成功潛伏至最後（剩餘平民 ${aliveCivilians} 人 vs 臥底 ${aliveUndercovers} 人），臥底陣營獲勝！`
    };
  }

  // 3. 臥底已全數出局，但白板存活到最後 (剩餘總人數 <= 2 或平民 <= 白板) -> 白板勝利
  if (aliveUndercovers === 0 && aliveBlanks > 0 && (alive.length <= 2 || aliveCivilians <= aliveBlanks)) {
    return {
      isOver: true,
      winner: "BLANK",
      reason: "白板在沒有題目的情況下神級演技存活到最後，白板逆襲獲勝！"
    };
  }

  return { isOver: false };
}

// ============================================================================
// Excel 匯入與匯出功能 (支援 .xlsx / .xls / .csv)
// ============================================================================

async function handleExcelFileUpload(file) {
  if (!file) return;
  if (!window.XLSX) {
    showToast("Excel 解析元件載入中，請稍後再試", "error");
    return;
  }

  try {
    const data = await file.arrayBuffer();
    const workbook = window.XLSX.read(data, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const rows = window.XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });

    if (!rows || rows.length === 0) {
      showToast("Excel 檔案內容為空", "warning");
      return;
    }

    const parsedItems = [];

    // 智慧偵測欄位位置
    const firstRow = rows[0].map(c => String(c || "").trim());
    let colA = 0;
    let colB = 1;
    let colCat = 2;
    let colHint = 3;
    let startRowIdx = 0;

    // 檢查第一列是否為標題列
    const headerKeywords = ["詞語", "題目", "平民", "臥底", "編號", "word", "分類", "類別"];
    const isHeaderRow = firstRow.some(cell =>
      headerKeywords.some(kw => cell.toLowerCase().includes(kw))
    );

    if (isHeaderRow) {
      startRowIdx = 1;
      // 若第一欄是「編號 / 序號 / ID」
      if (firstRow[0].includes("編號") || firstRow[0].includes("序號") || firstRow[0].toLowerCase() === "id") {
        colA = 1;
        colB = 2;
        colCat = 3;
        colHint = 4;
      }
      // 精確尋找標題名稱
      firstRow.forEach((h, idx) => {
        if (h.includes("詞語A") || h.includes("平民") || h.includes("題目A") || h.includes("題目1")) colA = idx;
        else if (h.includes("詞語B") || h.includes("臥底") || h.includes("題目B") || h.includes("題目2")) colB = idx;
        else if (h.includes("分類") || h.includes("類別")) colCat = idx;
        else if (h.includes("提示") || h.includes("說明") || h.includes("相似")) colHint = idx;
      });
    } else {
      // 無標題列時，判斷第 0 欄是否為純數字編號
      if (rows[0].length >= 3 && /^\d+$/.test(String(rows[0][0]).trim())) {
        colA = 1;
        colB = 2;
        colCat = 3;
        colHint = 4;
      }
    }

    for (let i = startRowIdx; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const wA = String(r[colA] || "").trim();
      const wB = String(r[colB] || "").trim();
      const cat = String(r[colCat] || "自訂匯入").trim() || "自訂匯入";
      const hint = String(r[colHint] || "").trim();

      if (wA && wB && wA !== wB) {
        parsedItems.push({ wordA: wA, wordB: wB, category: cat, hint });
      }
    }

    if (parsedItems.length === 0) {
      showToast("未偵測到有效的兩兩一組詞語，請確認 Excel 欄位格式", "warning");
      return;
    }

    const result = await window.cloudService.addCustomWords(parsedItems);
    await refreshWordBank();
    renderApp();

    const syncText = result.cloudOk
      ? "並已永久同步至雲端資料庫！"
      : "已儲存（若設定雲端資料庫即可跨網永久同步）！";
    showToast(
      `✅ 成功從「${file.name}」匯入 ${result.addedCount} 組新題庫（略過 ${result.duplicateCount} 組重複題目），${syncText}`,
      "success"
    );
  } catch (err) {
    console.error("解析 Excel 失敗:", err);
    showToast("解析 Excel 檔案失敗：" + err.message, "error");
  }
}

function exportWordBankToExcel(onlyDefault = false) {
  if (!window.XLSX) {
    // 若無 XLSX 則直接觸發下載靜態檔案
    window.location.href = "./wordbank_120.xlsx";
    return;
  }

  const list = onlyDefault
    ? (window.DEFAULT_WORD_BANK || [])
    : (AppState.wordBank.allWords || window.DEFAULT_WORD_BANK || []);

  const sheetData = [
    ["編號", "詞語A", "詞語B", "分類", "相似處提示", "來源"]
  ];

  list.forEach((item, idx) => {
    sheetData.push([
      idx + 1,
      item.wordA,
      item.wordB,
      item.category || "未分類",
      item.hint || "",
      item.isCustom ? "新增題庫" : "預設精選"
    ]);
  });

  const ws = window.XLSX.utils.aoa_to_sheet(sheetData);
  ws["!cols"] = [
    { wch: 8 },
    { wch: 18 },
    { wch: 18 },
    { wch: 16 },
    { wch: 42 },
    { wch: 12 }
  ];
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "誰是臥底題庫");

  const filename = onlyDefault
    ? "誰是臥底_120組精選題庫.xlsx"
    : `誰是臥底_完整雲端題庫_${list.length}組.xlsx`;
  window.XLSX.writeFile(wb, filename);
  showToast(`📥 已下載 Excel 檔案：${filename}`, "success");
}

// ============================================================================
// UI 渲染與互動輔助
// ============================================================================

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const colors = {
    success: "bg-emerald-600 border-emerald-400 text-white",
    warning: "bg-amber-500 border-amber-300 text-slate-950 font-semibold",
    error: "bg-rose-600 border-rose-400 text-white",
    info: "bg-indigo-600 border-indigo-400 text-white"
  };

  const el = document.createElement("div");
  el.className = `px-4 py-3 rounded-xl border shadow-xl backdrop-blur-md transition-all duration-300 transform translate-y-0 opacity-100 text-sm flex items-center gap-2 ${colors[type] || colors.info}`;
  el.innerHTML = `<span class="flex-1">${escapeHtml(message)}</span>`;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add("opacity-0", "translate-y-2");
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getActiveViewingPlayer() {
  if (!AppState.room) return AppState.myPlayer;
  const found = AppState.room.players.find(p => p.id === AppState.viewingPlayerId);
  if (found) return found;
  const me = AppState.room.players.find(p => p.id === AppState.myPlayer.id);
  if (me) {
    AppState.viewingPlayerId = me.id;
    return me;
  }
  return AppState.room.players[0] || AppState.myPlayer;
}

function renderQRCodeIfNeeded() {
  const qrContainer = document.getElementById("room-qrcode");
  if (!qrContainer || !AppState.room || !window.QRCode) return;
  const inviteUrl = getRoomInviteUrl(AppState.room.roomCode);
  if (qrContainer.dataset.renderedUrl === inviteUrl) return;
  qrContainer.innerHTML = "";
  qrContainer.dataset.renderedUrl = inviteUrl;
  new window.QRCode(qrContainer, {
    text: inviteUrl,
    width: 148,
    height: 148,
    colorDark: "#0f172a",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M
  });
}

function getRoomInviteUrl(roomCode) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomCode);
  const settings = window.cloudService.settings;
  if (settings.provider === "firebase" && settings.firebaseDatabaseURL) {
    url.searchParams.set("fb", settings.firebaseDatabaseURL);
  }
  return url.toString();
}

function renderApp() {
  // 更新頂部導覽列徽章
  const wbBadge = document.getElementById("nav-wb-count");
  if (wbBadge) {
    wbBadge.textContent = `${AppState.wordBank.allWords.length}組`;
  }

  const cloudBadge = document.getElementById("nav-cloud-badge");
  if (cloudBadge) {
    const summary = window.cloudService.getStatusSummary();
    if (summary.isCloudConfigured) {
      cloudBadge.className = "px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1.5";
      cloudBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><span>雲端已連線</span>`;
    } else {
      cloudBadge.className = "px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 flex items-center gap-1.5";
      cloudBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-indigo-400"></span><span>P2P 連線模式</span>`;
    }
  }

  // 切換頁籤高亮
  ["game", "wordbank", "cloud", "rules"].forEach(tab => {
    const btn = document.getElementById(`tab-btn-${tab}`);
    const panel = document.getElementById(`tab-panel-${tab}`);
    if (btn) {
      if (AppState.activeTab === tab) {
        btn.className = "px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 transition flex items-center gap-1.5";
      } else {
        btn.className = "px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800/70 transition flex items-center gap-1.5";
      }
    }
    if (panel) {
      panel.classList.toggle("hidden", AppState.activeTab !== tab);
    }
  });

  if (AppState.activeTab === "game") {
    renderGameTab();
  } else if (AppState.activeTab === "wordbank") {
    renderWordBankTab();
  } else if (AppState.activeTab === "cloud") {
    renderCloudSettingsTab();
  }
}

// ============================================================================
// 渲染：遊戲主畫面 (大廳 / 等候室 / 發言 / 投票 / 結算)
// ============================================================================

function renderGameTab() {
  const container = document.getElementById("tab-panel-game");
  if (!container) return;

  if (!AppState.room) {
    stopSpeakerCountdownTicker();
    container.innerHTML = renderLobbyHomeHtml();
    bindLobbyHomeEvents();
    return;
  }

  const room = AppState.room;
  const isHost = room.hostId === AppState.myPlayer.id;
  const viewingPlayer = getActiveViewingPlayer();
  const localBots = room.players.filter(p => p.id === AppState.myPlayer.id || p.isLocalBot);
  const maxPlayers = Math.max(3, Math.min(20, parseInt(room.settings.maxPlayers, 10) || 8));

  let phaseHtml = "";
  if (room.phase === "LOBBY") {
    phaseHtml = renderRoomWaitingHtml(room, isHost, viewingPlayer);
  } else if (room.phase === "SPEAKING" || room.phase === "VOTING") {
    phaseHtml = renderInGameHtml(room, isHost, viewingPlayer);
  } else if (room.phase === "GAME_OVER") {
    phaseHtml = renderGameOverHtml(room, isHost, viewingPlayer);
  }

  // 房間內隨時展開修改個人暱稱與頭像面板
  const draftAv = AppState.roomDraftAvatar || viewingPlayer.avatar;
  const editProfilePanelHtml = AppState.isEditingProfileInRoom ? `
    <div class="mb-4 p-4 rounded-2xl bg-slate-900 border border-indigo-500/50 shadow-xl">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-bold text-white flex items-center gap-2">
          <span>✏️ 修改房間內顯示暱稱與頭像</span>
          <span class="text-xs text-indigo-300 font-normal">（修改後全員畫面即時同步）</span>
        </div>
        <button id="btn-cancel-room-profile" type="button" class="text-xs text-slate-400 hover:text-white">✕ 關閉</button>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
        <div class="md:col-span-4">
          <input id="input-room-player-name" type="text" maxlength="12" value="${escapeHtml(viewingPlayer.name)}"
            placeholder="輸入新暱稱..."
            class="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-500" />
        </div>
        <div class="md:col-span-6 flex flex-wrap gap-1.5">
          ${AVATARS.map(av => `
            <button type="button" data-room-avatar-pick="${av}"
              class="w-9 h-9 rounded-xl text-lg flex items-center justify-center border transition ${draftAv === av ? "bg-indigo-600/30 border-indigo-400 scale-105 shadow" : "bg-slate-950 border-slate-800 hover:bg-slate-800"}">
              ${av}
            </button>
          `).join("")}
        </div>
        <div class="md:col-span-2 flex justify-end">
          <button id="btn-save-room-profile" type="button"
            class="w-full py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow transition">
            💾 儲存修改
          </button>
        </div>
      </div>
    </div>
  ` : "";

  // 若房主有新增同機玩家，提供視角切換器方便同機輪流看牌/投票
  const switcherHtml = (isHost && localBots.length > 1) ? `
    <div class="mb-4 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-2">
      <div class="text-xs text-amber-300 font-medium flex items-center gap-1.5">
        <span>📱 同機多玩家視角切換（點擊切換目前操作與看牌的玩家）：</span>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${localBots.map(p => `
          <button data-switch-player="${escapeHtml(p.id)}"
            class="px-3 py-1 rounded-lg text-xs font-semibold transition ${p.id === viewingPlayer.id ? "bg-amber-400 text-slate-950 shadow" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}">
            ${escapeHtml(p.avatar)} ${escapeHtml(p.name)} ${p.cardChecked ? "✓" : ""}
          </button>
        `).join("")}
      </div>
    </div>
  ` : "";

  container.innerHTML = `
    <div class="max-w-5xl mx-auto">
      <!-- 房間頂部資訊列 -->
      <div class="mb-4 p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-3 shadow-lg">
        <div class="flex items-center gap-3">
          <div class="px-3.5 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 font-mono font-bold text-lg tracking-wider">
            房號 #${escapeHtml(room.roomCode)}
          </div>
          <div>
            <div class="text-sm font-semibold text-white flex items-center gap-2">
              <span>目前人數：${room.players.length} / ${maxPlayers} 人</span>
              <span class="px-2 py-0.5 rounded-md text-xs ${room.phase === "LOBBY" ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}">
                ${room.phase === "LOBBY" ? "等候準備中" : room.phase === "SPEAKING" ? `第 ${room.round} 輪・發言描述` : room.phase === "VOTING" ? `第 ${room.round} 輪・全民投票` : "本局結算"}
              </span>
            </div>
            <div class="text-xs text-slate-400 mt-1 flex flex-wrap items-center gap-2">
              <span>您的身分：${escapeHtml(viewingPlayer.avatar)} <strong class="text-slate-200">${escapeHtml(viewingPlayer.name)}</strong> ${isHost ? '<span class="text-amber-400">(房主)</span>' : ""}</span>
              <button id="btn-toggle-room-profile" type="button"
                class="px-2 py-0.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/35 text-indigo-300 border border-indigo-500/40 text-[11px] font-semibold transition">
                ✏️ 改名/換頭像
              </button>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button id="btn-copy-invite" class="px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">
            🔗 複製房間邀請連結
          </button>
          ${isHost && room.phase !== "LOBBY" ? `
            <button id="btn-back-to-lobby" class="px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 transition">
              ⚙️ 返回房間設定
            </button>
          ` : ""}
          <button id="btn-leave-room" class="px-3 py-1.5 rounded-xl text-xs font-medium bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 transition">
            離開房間
          </button>
        </div>
      </div>

      ${editProfilePanelHtml}
      ${switcherHtml}
      ${phaseHtml}
    </div>
  `;

  bindRoomEvents();
  if (room.phase === "LOBBY") {
    stopSpeakerCountdownTicker();
    renderQRCodeIfNeeded();
  } else if (room.phase === "SPEAKING") {
    startSpeakerCountdownTicker();
  } else {
    stopSpeakerCountdownTicker();
  }
}

function renderLobbyHomeHtml() {
  const p = AppState.myPlayer;
  return `
    <div class="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-6">
      <!-- 左側：個人檔案設定 -->
      <div class="md:col-span-5 p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl flex flex-col justify-between">
        <div>
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/15 text-indigo-300 text-xs font-semibold mb-4 border border-indigo-500/30">
            <span>🕵️ 步驟 1：設定您的玩家檔案</span>
          </div>
          <h2 class="text-xl font-bold text-white mb-4">個人暱稱與頭像</h2>

          <div class="mb-4">
            <label class="block text-xs font-medium text-slate-400 mb-1.5">您的遊戲暱稱（進房後也可隨時修改）</label>
            <input id="input-player-name" type="text" maxlength="12" value="${escapeHtml(p.name)}"
              placeholder="輸入暱稱..."
              class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white focus:outline-none focus:border-indigo-500 text-sm" />
          </div>

          <div class="mb-4">
            <label class="block text-xs font-medium text-slate-400 mb-1.5">選擇代表頭像</label>
            <div class="grid grid-cols-6 gap-2">
              ${AVATARS.map(av => `
                <button type="button" data-avatar-pick="${av}"
                  class="h-10 rounded-xl text-xl flex items-center justify-center border transition ${p.avatar === av ? "bg-indigo-600/30 border-indigo-400 scale-105 shadow" : "bg-slate-950 border-slate-800 hover:bg-slate-800"}">
                  ${av}
                </button>
              `).join("")}
            </div>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800/80 text-xs text-slate-400 leading-relaxed">
          💡 <strong class="text-slate-200">支援 3 ~ 20 人遊玩</strong>：每人用自己的手機掃描房主 QR Code 或輸入 4 碼房號即可同步看牌與投票！
        </div>
      </div>

      <!-- 右側：建立房間或加入房間 -->
      <div class="md:col-span-7 flex flex-col gap-6">
        <!-- 建立新房間 -->
        <div class="p-6 rounded-3xl bg-gradient-to-br from-indigo-950/90 via-slate-900 to-slate-900 border border-indigo-500/30 shadow-xl">
          <div class="flex items-start justify-between gap-4">
            <div>
              <span class="inline-block px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-semibold mb-2">
                房主專用
              </span>
              <h3 class="text-xl font-bold text-white mb-1">建立新遊戲房間 (3~20人)</h3>
              <p class="text-xs text-slate-300 leading-relaxed mb-5">
                建立房間後會產生專屬 4 碼房號與 QR Code，朋友掃碼即可加入。可自由調整房間人數 (3~20人)、每人思考秒數、臥底與白板人數！
              </p>
            </div>
            <div class="text-4xl">👑</div>
          </div>
          <button id="btn-create-room"
            class="w-full py-3.5 px-6 rounded-2xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold text-base shadow-lg shadow-indigo-600/30 transition flex items-center justify-center gap-2">
            <span>🚀 立即建立房間</span>
          </button>
        </div>

        <!-- 加入現有房間 -->
        <div class="p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl">
          <span class="inline-block px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-300 text-xs font-semibold mb-2">
            玩家加入
          </span>
          <h3 class="text-xl font-bold text-white mb-1">輸入房號加入房間</h3>
          <p class="text-xs text-slate-400 mb-4">請輸入房主畫面上的 4 位數房間號碼：</p>

          <div class="flex gap-3">
            <input id="input-join-code" type="text" maxlength="6" placeholder="例如：8492"
              class="flex-1 px-4 py-3 rounded-2xl bg-slate-950 border border-slate-700 text-white font-mono text-lg tracking-widest uppercase focus:outline-none focus:border-emerald-500" />
            <button id="btn-join-room"
              class="px-6 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg shadow-emerald-600/25 transition whitespace-nowrap">
              加入房間 →
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderRoomWaitingHtml(room, isHost, viewingPlayer) {
  const categories = getAvailableCategories();
  const count = room.players.length;
  const maxPlayers = Math.max(3, Math.min(20, parseInt(room.settings.maxPlayers, 10) || 8));
  const thinkSec = parseInt(room.settings.thinkingTimeSeconds ?? 30, 10) || 0;
  const ucCount = room.settings.undercoverCount;
  const blankCount = room.settings.blankCount;
  const civCount = Math.max(1, count - ucCount - blankCount);

  return `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <!-- 左側：房間玩家座位表 (3~20人) & QR Code -->
      <div class="lg:col-span-7 p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl flex flex-col justify-between">
        <div>
          <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div>
              <h3 class="text-lg font-bold text-white">房間玩家列表 (${count} / ${maxPlayers} 人)</h3>
              <p class="text-xs text-slate-400">支援 3 ~ 20 人同樂・玩家離開房間會自動釋出座位</p>
            </div>
            <div class="flex items-center gap-2">
              <button id="btn-quick-edit-name" type="button"
                class="px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-500/20 hover:bg-indigo-500/35 text-indigo-300 border border-indigo-500/40 transition">
                ✏️ 修改我的名字
              </button>
              ${isHost && count < 20 ? `
                <button id="btn-add-local-player"
                  class="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 transition">
                  + 新增同機測試座位
                </button>
              ` : ""}
            </div>
          </div>

          <!-- 動態座位網格 (3 ~ 20 個座位) -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 max-h-[420px] overflow-y-auto pr-1">
            ${Array.from({ length: maxPlayers }).map((_, idx) => {
              const p = room.players[idx];
              if (p) {
                const isMe = p.id === viewingPlayer.id;
                return `
                  <div class="relative p-3 rounded-2xl bg-slate-950 border ${isMe ? "border-indigo-500/80 ring-1 ring-indigo-500/40" : "border-slate-800"} flex flex-col items-center text-center">
                    <span class="absolute top-2 left-2.5 text-[10px] font-mono text-slate-500">#${idx + 1}</span>
                    ${p.isHost ? `<span class="absolute top-2 right-2.5 text-xs" title="房主">👑</span>` : (isHost ? `
                      <button data-kick-player="${escapeHtml(p.id)}" class="absolute top-1.5 right-2 text-slate-500 hover:text-rose-400 text-xs" title="移除此玩家">✕</button>
                    ` : "")}
                    <div class="text-3xl mb-1 mt-1">${escapeHtml(p.avatar)}</div>
                    <div class="text-sm font-bold text-white truncate w-full">${escapeHtml(p.name)}</div>
                    <div class="flex items-center gap-1.5 mt-1">
                      <span class="text-[11px] ${p.isLocalBot ? "text-amber-400" : "text-emerald-400"}">
                        ${p.isLocalBot ? "同機座位" : "已連線"}
                      </span>
                      ${isMe ? `
                        <button type="button" data-open-profile-edit="1" class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/40">
                          改名
                        </button>
                      ` : ""}
                    </div>
                  </div>
                `;
              } else {
                return `
                  <div class="p-3 rounded-2xl bg-slate-950/40 border border-dashed border-slate-800 flex flex-col items-center justify-center text-center min-h-[104px]">
                    <div class="text-xl text-slate-700 mb-1">🪑</div>
                    <div class="text-xs text-slate-600">等待加入 (${idx + 1})</div>
                  </div>
                `;
              }
            }).join("")}
          </div>
        </div>

        <!-- 掃碼與連線提示區 -->
        <div class="p-4 rounded-2xl bg-slate-950/90 border border-slate-800 flex flex-col sm:flex-row items-center gap-4">
          <div id="room-qrcode" class="p-2 bg-white rounded-xl shrink-0"></div>
          <div class="text-center sm:text-left">
            <div class="text-sm font-bold text-white mb-1">📱 邀請朋友用手機加入房間</div>
            <p class="text-xs text-slate-400 leading-relaxed mb-2">
              請朋友使用手機相機掃描左側 QR Code，或打開本網頁輸入房號 <strong class="text-indigo-400 font-mono text-sm">${escapeHtml(room.roomCode)}</strong> 即可同步連線看牌！進入房間後點擊上方「✏️ 修改我的名字」即可隨時改名。
            </p>
          </div>
        </div>
      </div>

      <!-- 右側：人數上限、思考秒數與角色配置 -->
      <div class="lg:col-span-5 p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-1">
            <h3 class="text-lg font-bold text-white">遊戲規則與角色配置</h3>
            ${isHost ? `
              <button id="btn-auto-recommend-roles" type="button"
                class="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 text-[11px] font-semibold transition">
                ✨ 依人數推薦配置
              </button>
            ` : ""}
          </div>
          <p class="text-xs text-slate-400 mb-4">${isHost ? "您是房主，可自由設定 3~20 人、思考秒數與臥底白板數量" : "等待房主調整設定並開始遊戲"}</p>

          <!-- 陣營人數即時預覽 -->
          <div class="grid grid-cols-3 gap-2.5 mb-4">
            <div class="p-2.5 rounded-2xl bg-sky-500/10 border border-sky-500/30 text-center">
              <div class="text-xs text-sky-300">平民人數</div>
              <div class="text-2xl font-extrabold text-white mt-0.5">${civCount}</div>
            </div>
            <div class="p-2.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-center">
              <div class="text-xs text-rose-300">臥底人數</div>
              <div class="text-2xl font-extrabold text-white mt-0.5">${ucCount}</div>
            </div>
            <div class="p-2.5 rounded-2xl bg-purple-500/10 border border-purple-500/30 text-center">
              <div class="text-xs text-purple-300">白板人數</div>
              <div class="text-2xl font-extrabold text-white mt-0.5">${blankCount}</div>
            </div>
          </div>

          <div class="space-y-3">
            <!-- 1. 房間座位人數上限調整 (3~20人) -->
            <div class="p-3 rounded-2xl bg-slate-950 border border-slate-800">
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm font-semibold text-white">👥 房間設定人數 (3~20人)</div>
                  <div class="text-xs text-slate-400">可自行調整本局預計遊玩座位數</div>
                </div>
                <div class="flex items-center gap-1.5">
                  <button ${!isHost ? "disabled" : ""} data-adj-maxplayers="-1"
                    class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white font-bold">-</button>
                  <input id="input-max-players" type="number" min="3" max="20" value="${maxPlayers}" ${!isHost ? "disabled" : ""}
                    class="w-14 py-1 rounded-lg bg-slate-900 border border-slate-700 text-center font-bold text-white text-sm focus:outline-none focus:border-indigo-500" />
                  <button ${!isHost ? "disabled" : ""} data-adj-maxplayers="1"
                    class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white font-bold">+</button>
                </div>
              </div>
            </div>

            <!-- 2. 每人思考/發言秒數設定 -->
            <div class="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm font-semibold text-white">⏱️ 每人思考/發言秒數</div>
                  <div class="text-xs text-slate-400">${thinkSec === 0 ? "目前為不限時間" : `每人輪流發言倒數 ${thinkSec} 秒`}</div>
                </div>
                <div class="flex items-center gap-1.5">
                  <button ${!isHost ? "disabled" : ""} data-adj-think="-5"
                    class="px-2 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white text-xs font-bold">-5s</button>
                  <input id="input-think-seconds" type="number" min="0" max="300" step="5" value="${thinkSec}" ${!isHost ? "disabled" : ""}
                    class="w-16 py-1 rounded-lg bg-slate-900 border border-slate-700 text-center font-bold text-amber-300 text-sm focus:outline-none focus:border-indigo-500" />
                  <button ${!isHost ? "disabled" : ""} data-adj-think="5"
                    class="px-2 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white text-xs font-bold">+5s</button>
                </div>
              </div>
              ${isHost ? `
                <div class="flex flex-wrap gap-1.5 pt-1">
                  ${[
                    { label: "不限時", val: 0 },
                    { label: "15秒", val: 15 },
                    { label: "30秒", val: 30 },
                    { label: "45秒", val: 45 },
                    { label: "60秒", val: 60 },
                    { label: "90秒", val: 90 }
                  ].map(preset => `
                    <button type="button" data-preset-think="${preset.val}"
                      class="px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition ${thinkSec === preset.val ? "bg-amber-400 text-slate-950 border-amber-300" : "bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800"}">
                      ${preset.label}
                    </button>
                  `).join("")}
                </div>
              ` : ""}
            </div>

            <!-- 3. 臥底人數調整 -->
            <div class="flex items-center justify-between p-3 rounded-2xl bg-slate-950 border border-slate-800">
              <div>
                <div class="text-sm font-semibold text-white">🕵️ 臥底人數</div>
                <div class="text-xs text-slate-400">拿到與平民高度相似的另一個詞</div>
              </div>
              <div class="flex items-center gap-2">
                <button ${!isHost ? "disabled" : ""} data-adj-role="uc" data-delta="-1"
                  class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white font-bold">-</button>
                <span class="w-6 text-center font-bold text-white">${ucCount}</span>
                <button ${!isHost ? "disabled" : ""} data-adj-role="uc" data-delta="1"
                  class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white font-bold">+</button>
              </div>
            </div>

            <!-- 4. 白板人數調整 -->
            <div class="flex items-center justify-between p-3 rounded-2xl bg-slate-950 border border-slate-800">
              <div>
                <div class="text-sm font-semibold text-white">🃏 白板人數 (可選)</div>
                <div class="text-xs text-slate-400">沒有詞語，需聽別人描述猜測並偽裝</div>
              </div>
              <div class="flex items-center gap-2">
                <button ${!isHost ? "disabled" : ""} data-adj-role="blank" data-delta="-1"
                  class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white font-bold">-</button>
                <span class="w-6 text-center font-bold text-white">${blankCount}</span>
                <button ${!isHost ? "disabled" : ""} data-adj-role="blank" data-delta="1"
                  class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white font-bold">+</button>
              </div>
            </div>

            <!-- 5. 題庫分類選擇 -->
            <div class="p-3 rounded-2xl bg-slate-950 border border-slate-800">
              <label class="block text-xs font-medium text-slate-400 mb-1.5">📚 抽選題庫範圍（目前共 ${AppState.wordBank.allWords.length} 組）</label>
              <select id="select-room-category" ${!isHost ? "disabled" : ""}
                class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-500">
                <option value="ALL" ${room.settings.category === "ALL" ? "selected" : ""}>全部題庫 (${AppState.wordBank.allWords.length} 組)</option>
                ${AppState.wordBank.customCount > 0 ? `
                  <option value="CUSTOM_ONLY" ${room.settings.category === "CUSTOM_ONLY" ? "selected" : ""}>⭐ 僅使用自訂/上傳題庫 (${AppState.wordBank.customCount} 組)</option>
                ` : ""}
                ${categories.map(c => `
                  <option value="${escapeHtml(c.name)}" ${room.settings.category === c.name ? "selected" : ""}>
                    ${escapeHtml(c.name)} (${c.count} 組)
                  </option>
                `).join("")}
              </select>
            </div>

            <!-- 6. 淘汰公開身分開關 -->
            <label class="flex items-center justify-between p-3 rounded-2xl bg-slate-950 border border-slate-800 cursor-pointer">
              <div>
                <div class="text-sm font-semibold text-white">淘汰時公開陣營身分</div>
                <div class="text-xs text-slate-400">出局時顯示為平民/臥底/白板（不洩漏題目）</div>
              </div>
              <input id="chk-reveal-role" type="checkbox" ${room.settings.revealRoleOnEliminate ? "checked" : ""} ${!isHost ? "disabled" : ""}
                class="w-5 h-5 accent-indigo-600 rounded" />
            </label>
          </div>
        </div>

        <div class="mt-5">
          ${isHost ? `
            <button id="btn-start-game" ${count < 3 ? "disabled" : ""}
              class="w-full py-4 px-6 rounded-2xl font-bold text-base shadow-lg transition flex items-center justify-center gap-2 ${count >= 3 ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/30" : "bg-slate-800 text-slate-500 cursor-not-allowed"}">
              <span>${count >= 3 ? `🎲 開始發牌 (${count} 人局)` : `還差 ${3 - count} 人即可開始 (支援 3~20 人)`}</span>
            </button>
          ` : `
            <div class="w-full py-3.5 px-6 rounded-2xl bg-slate-800/80 text-slate-300 text-sm font-medium text-center border border-slate-700">
              ⏳ 等待房主開始發牌... (目前 ${count} / ${maxPlayers} 人)
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

// 渲染：遊戲進行中（看牌 + 輪流發言 + 思考倒數計時 + 即時投票）
function renderInGameHtml(room, isHost, viewingPlayer) {
  const isBlank = viewingPlayer.role === "BLANK";
  const myWordText = isBlank ? "【白板】無題目" : (viewingPlayer.word || "尚未分配");
  const currentSpeakerId = room.speakingOrder[room.currentSpeakerIdx];
  const currentSpeaker = room.players.find(p => p.id === currentSpeakerId);
  const isMyTurnToSpeak = room.phase === "SPEAKING" && currentSpeakerId === viewingPlayer.id;
  const thinkSec = parseInt(room.settings.thinkingTimeSeconds ?? 30, 10) || 0;

  // 投票候選人過濾（若處於平票 PK，只能投給 PK 候選人）
  const isTiePk = room.voteTieCandidates && room.voteTieCandidates.length > 0;

  return `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <!-- 左側：我的專屬秘密詞語卡 + 本輪進度 -->
      <div class="lg:col-span-5 flex flex-col gap-5">
        <!-- 秘密詞語翻牌卡 -->
        <div class="p-6 rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-950/50 to-slate-900 border border-indigo-500/40 shadow-xl text-center relative overflow-hidden">
          <div class="flex items-center justify-between mb-3">
            <span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              🔒 ${escapeHtml(viewingPlayer.name)} 的秘密詞語卡
            </span>
            <span class="text-xs ${viewingPlayer.alive ? "text-emerald-400" : "text-rose-400 font-bold"}">
              ${viewingPlayer.alive ? "● 存活中" : "✕ 已淘汰出局"}
            </span>
          </div>

          <div id="btn-toggle-word-card"
            class="my-3 py-8 px-4 rounded-2xl border-2 border-dashed transition cursor-pointer select-none ${AppState.cardRevealed ? "bg-indigo-950/80 border-indigo-400" : "bg-slate-950/90 border-slate-700 hover:border-indigo-500/60"}">
            ${AppState.cardRevealed ? `
              <div class="text-xs text-indigo-300 mb-1">您的本局題目（再點一下即可隱藏防偷看）：</div>
              <div class="text-3xl font-extrabold tracking-wide ${isBlank ? "text-purple-300" : "text-white"} my-2">
                ${escapeHtml(myWordText)}
              </div>
              <div class="text-xs text-slate-400 mt-2">
                ${isBlank ? "請仔細聽別人的描述，推理出題目並假裝自己有詞！" : "⚠️ 您不確定自己是平民還是臥底，描述時請拿捏分寸！"}
              </div>
            ` : `
              <div class="text-4xl mb-2">🃏</div>
              <div class="text-base font-bold text-white">點擊此處翻開查看您的詞語</div>
              <div class="text-xs text-slate-400 mt-1">看完後再次點擊即可蓋牌，防止旁人偷看</div>
            `}
          </div>

          <div class="flex items-center justify-between text-xs text-slate-400 mt-2">
            <span>分類提示：${escapeHtml(room.currentWordPair ? room.currentWordPair.category : "精選題庫")}</span>
            <span>已看牌人數：${room.players.filter(p => p.cardChecked).length} / ${room.players.length}</span>
          </div>
        </div>

        <!-- 階段指引與發言輸入框 -->
        ${room.phase === "SPEAKING" ? `
          <div class="p-5 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-base font-bold text-white">🎙️ 第 ${room.round} 輪：輪流發言描述</h3>
              <span class="text-xs text-amber-300 font-medium">
                進度 ${room.currentSpeakerIdx + 1} / ${room.speakingOrder.length}
              </span>
            </div>

            <!-- 當前發言者與思考倒數計時器 -->
            <div class="p-3.5 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 mb-4 space-y-2.5">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2.5">
                  <span class="text-2xl">${currentSpeaker ? escapeHtml(currentSpeaker.avatar) : "🎙️"}</span>
                  <div>
                    <div class="text-xs text-indigo-300">目前輪到發言：</div>
                    <div class="text-sm font-bold text-white">${currentSpeaker ? escapeHtml(currentSpeaker.name) : "等待中"}</div>
                  </div>
                </div>
                ${isMyTurnToSpeak ? `
                  <span class="px-2.5 py-1 rounded-lg bg-amber-400 text-slate-950 text-xs font-extrabold animate-bounce">
                    輪到您了！
                  </span>
                ` : ""}
              </div>

              ${thinkSec > 0 && room.speakerDeadline ? `
                <div class="pt-1 border-t border-indigo-500/20">
                  <div class="flex items-center justify-between text-xs mb-1.5">
                    <span class="text-slate-300 flex items-center gap-1">
                      ⏱️ 思考與發言倒數：
                      <strong id="speaker-timer-text" class="text-base font-mono font-extrabold text-amber-300">-- 秒</strong>
                    </span>
                    ${(isHost || isMyTurnToSpeak) ? `
                      <button id="btn-extend-time" type="button"
                        class="px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 text-[11px] font-semibold transition">
                        +15秒
                      </button>
                    ` : ""}
                  </div>
                  <div class="w-full h-2 rounded-full bg-slate-950 overflow-hidden">
                    <div id="speaker-timer-bar" class="h-full bg-gradient-to-r from-emerald-400 to-amber-400 transition-all duration-200" style="width: 100%"></div>
                  </div>
                </div>
              ` : `
                <div class="text-[11px] text-slate-400 pt-1 border-t border-indigo-500/20">
                  ⏱️ 本局設定為不限思考時間
                </div>
              `}
            </div>

            <!-- 發言順序條 -->
            <div class="flex flex-wrap gap-1.5 mb-4">
              ${room.speakingOrder.map((pid, idx) => {
                const sp = room.players.find(x => x.id === pid);
                if (!sp) return "";
                const active = idx === room.currentSpeakerIdx;
                const done = idx < room.currentSpeakerIdx;
                return `
                  <span class="px-2.5 py-1 rounded-lg text-xs font-medium border ${active ? "bg-indigo-600 text-white border-indigo-400" : done ? "bg-slate-800/60 text-slate-500 border-slate-800 line-through" : "bg-slate-950 text-slate-300 border-slate-800"}">
                    ${idx + 1}. ${escapeHtml(sp.name)}
                  </span>
                `;
              }).join("")}
            </div>

            <!-- 文字描述紀錄輸入（可口頭描述，亦可輸入文字讓遠端與所有人查看） -->
            ${viewingPlayer.alive ? `
              <div class="mb-3">
                <label class="block text-xs text-slate-400 mb-1">✏️ 輸入本輪一句話描述（或現場口頭發言後點下一位）：</label>
                <div class="flex gap-2">
                  <input id="input-clue-text" type="text" maxlength="40" placeholder="用一句話形容您的詞語（不可直接說出字面）..."
                    class="flex-1 px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-500" />
                  <button id="btn-submit-clue"
                    class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold whitespace-nowrap">
                    送出描述
                  </button>
                </div>
              </div>
            ` : ""}

            <div class="flex gap-2 mt-3">
              ${(isHost || isMyTurnToSpeak) ? `
                <button id="btn-next-speaker"
                  class="flex-1 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold border border-slate-700 transition">
                  ${room.currentSpeakerIdx < room.speakingOrder.length - 1 ? "⏭️ 下一位發言" : "🗳️ 發言完畢，開始投票"}
                </button>
              ` : ""}
              ${isHost ? `
                <button id="btn-start-voting-now"
                  class="py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-extrabold transition">
                  🗳️ 直接進入投票
                </button>
              ` : ""}
            </div>
          </div>
        ` : `
          <div class="p-5 rounded-3xl bg-amber-500/10 border border-amber-500/40 shadow-xl">
            <h3 class="text-base font-bold text-amber-300 mb-1">
              🗳️ 第 ${room.round} 輪：${isTiePk ? "⚡ 平票 PK 重新投票！" : "全民同步投票階段"}
            </h3>
            <p class="text-xs text-slate-300 leading-relaxed mb-3">
              ${isTiePk
                ? "上一輪最高票出現平手！請在右側標示「PK 候選」的玩家中投出您認為的臥底。"
                : "請在右側玩家列表中點擊您懷疑是「臥底」的對象進行投票。全員投票完成後將自動公佈結果！"}
            </p>
            <div class="text-xs text-slate-400 mb-3">
              已投票人數：<strong class="text-white">${room.players.filter(p => p.alive && p.votedFor).length} / ${room.players.filter(p => p.alive).length}</strong>
            </div>
            ${isHost ? `
              <button id="btn-force-resolve-vote"
                class="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-extrabold transition">
                ⚡ 立即結算目前票數
              </button>
            ` : ""}
          </div>
        `}
      </div>

      <!-- 右側：玩家狀態與投票面板 + 發言紀錄牆 -->
      <div class="lg:col-span-7 flex flex-col gap-5">
        <!-- 玩家卡片與投票區 -->
        <div class="p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-base font-bold text-white">
              ${room.phase === "VOTING" ? "👇 點擊下方玩家頭像投出懷疑票" : "👥 場上玩家狀態"}
            </h3>
            ${room.phase === "VOTING" && viewingPlayer.alive ? `
              <button data-vote-target="ABSTAIN"
                class="px-3 py-1 rounded-lg text-xs font-semibold border transition ${viewingPlayer.votedFor === "ABSTAIN" ? "bg-amber-400 text-slate-950 border-amber-300" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"}">
                🏳️ 棄票不投
              </button>
            ` : ""}
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            ${room.players.map((p, idx) => {
              const isPKCandidate = !isTiePk || room.voteTieCandidates.includes(p.id);
              const canVoteThis = room.phase === "VOTING" && viewingPlayer.alive && p.alive && p.id !== viewingPlayer.id && isPKCandidate;
              const isMyVoteTarget = viewingPlayer.votedFor === p.id;

              let roleBadge = "";
              if (!p.alive && room.settings.revealRoleOnEliminate) {
                const roleLabel = p.role === "UNDERCOVER" ? "臥底" : p.role === "BLANK" ? "白板" : "平民";
                const roleColor = p.role === "UNDERCOVER" ? "bg-rose-500/20 text-rose-300" : p.role === "BLANK" ? "bg-purple-500/20 text-purple-300" : "bg-sky-500/20 text-sky-300";
                roleBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold ${roleColor}">已出局 (${roleLabel})</span>`;
              } else if (!p.alive) {
                roleBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300">已出局</span>`;
              }

              return `
                <div ${canVoteThis ? `data-vote-target="${escapeHtml(p.id)}"` : ""}
                  class="relative p-3.5 rounded-2xl border transition flex flex-col items-center text-center ${!p.alive ? "bg-slate-950/40 border-slate-800/60 opacity-55" : isMyVoteTarget ? "bg-rose-950/70 border-rose-400 ring-2 ring-rose-500/50 cursor-pointer" : canVoteThis ? "bg-slate-950 border-slate-700 hover:border-amber-400 cursor-pointer" : "bg-slate-950 border-slate-800"}">
                  <span class="absolute top-2 left-2.5 text-[10px] font-mono text-slate-500">#${idx + 1}</span>
                  ${isTiePk && isPKCandidate && p.alive ? `<span class="absolute top-1.5 right-2 px-1.5 py-0.5 rounded bg-amber-500 text-slate-950 text-[9px] font-extrabold">PK</span>` : ""}
                  <div class="text-3xl mb-1 mt-1">${escapeHtml(p.avatar)}</div>
                  <div class="text-sm font-bold text-white truncate w-full">${escapeHtml(p.name)}</div>

                  <div class="mt-2 flex flex-col items-center gap-1 min-h-[24px]">
                    ${!p.alive ? roleBadge : room.phase === "VOTING" ? `
                      <span class="text-[11px] ${p.votedFor ? "text-emerald-400 font-semibold" : "text-slate-500"}">
                        ${p.votedFor ? "✓ 已投票" : "思考中..."}
                      </span>
                    ` : `
                      <span class="text-[11px] ${p.cardChecked ? "text-emerald-400" : "text-amber-400"}">
                        ${p.cardChecked ? "✓ 已看牌" : "尚未看牌"}
                      </span>
                    `}
                    ${isMyVoteTarget ? `<span class="px-2 py-0.5 rounded bg-rose-500 text-white text-[10px] font-bold">🎯 您的投票對象</span>` : ""}
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>

        <!-- 發言與投票紀錄牆 -->
        <div class="p-5 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl flex-1">
          <h4 class="text-sm font-bold text-white mb-3">💬 玩家發言描述與投票紀錄</h4>
          <div class="space-y-2 max-h-60 overflow-y-auto pr-1">
            ${room.clues.length === 0 && room.voteHistory.length === 0 ? `
              <div class="text-xs text-slate-500 py-6 text-center">尚無發言紀錄，玩家可口頭描述或在左側輸入文字紀錄</div>
            ` : ""}
            ${room.clues.map(c => `
              <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 text-xs flex items-start gap-2.5">
                <span class="text-lg">${escapeHtml(c.playerAvatar)}</span>
                <div class="flex-1">
                  <div class="flex items-center justify-between">
                    <span class="font-bold text-slate-200">${escapeHtml(c.playerName)} <span class="text-[10px] text-indigo-400">(第${c.round}輪)</span></span>
                    <span class="text-[10px] text-slate-500">${escapeHtml(c.time)}</span>
                  </div>
                  <div class="text-slate-300 mt-0.5">${escapeHtml(c.text)}</div>
                </div>
              </div>
            `).join("")}
            ${room.voteHistory.map(vh => `
              <div class="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
                🗳️ <strong>第 ${vh.round} 輪投票結果：</strong>${escapeHtml(vh.note)}
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </div>
  `;
}

// 渲染：遊戲結束結算與真相揭曉
function renderGameOverHtml(room, isHost) {
  const pair = room.currentWordPair || { civilianWord: "?", undercoverWord: "?", category: "", hint: "" };
  const bannerColor = room.winner === "CIVILIAN"
    ? "from-sky-600/30 via-indigo-900/40 to-slate-900 border-sky-400/50"
    : room.winner === "UNDERCOVER"
      ? "from-rose-600/30 via-rose-950/40 to-slate-900 border-rose-400/50"
      : "from-purple-600/30 via-purple-950/40 to-slate-900 border-purple-400/50";

  const winnerTitle = room.winner === "CIVILIAN"
    ? "🎉 平民陣營獲勝！"
    : room.winner === "UNDERCOVER"
      ? "🕵️ 臥底陣營獲勝！"
      : "🃏 白板逆襲獲勝！";

  return `
    <div class="space-y-6">
      <!-- 勝負橫幅與題目真相 -->
      <div class="p-8 rounded-3xl bg-gradient-to-br ${bannerColor} border shadow-2xl text-center">
        <div class="text-4xl font-extrabold text-white mb-2">${winnerTitle}</div>
        <p class="text-sm text-slate-200 mb-6">${escapeHtml(room.winReason)}</p>

        <!-- 本局兩兩一組詞語揭曉 -->
        <div class="max-w-xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <div class="p-4 rounded-2xl bg-slate-950/80 border border-sky-500/40">
            <div class="text-xs text-sky-300 font-semibold mb-1">👥 平民詞語</div>
            <div class="text-2xl font-extrabold text-white">${escapeHtml(pair.civilianWord)}</div>
          </div>
          <div class="p-4 rounded-2xl bg-slate-950/80 border border-rose-500/40">
            <div class="text-xs text-rose-300 font-semibold mb-1">🕵️ 臥底詞語</div>
            <div class="text-2xl font-extrabold text-white">${escapeHtml(pair.undercoverWord)}</div>
          </div>
        </div>

        ${pair.hint ? `
          <div class="text-xs text-slate-300 mb-6">💡 相似處解析：${escapeHtml(pair.hint)}（分類：${escapeHtml(pair.category)}）</div>
        ` : ""}

        ${isHost ? `
          <div class="flex flex-wrap justify-center gap-3">
            <button id="btn-play-again"
              class="px-8 py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-base shadow-lg shadow-indigo-600/30 transition">
              🔄 再來一局（自動換新題目）
            </button>
            <button id="btn-back-to-lobby-2"
              class="px-6 py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-sm border border-slate-700 transition">
              ⚙️ 調整人數或角色設定
            </button>
          </div>
        ` : `
          <div class="text-sm text-indigo-300 font-medium">等待房主開啟下一局...</div>
        `}
      </div>

      <!-- 全員真實身分揭曉列表 -->
      <div class="p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl">
        <h3 class="text-lg font-bold text-white mb-4">📋 全員真實身分與詞語揭曉</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          ${room.players.map(p => {
            const roleName = p.role === "UNDERCOVER" ? "🕵️ 臥底" : p.role === "BLANK" ? "🃏 白板" : "👥 平民";
            const badgeStyle = p.role === "UNDERCOVER"
              ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
              : p.role === "BLANK"
                ? "bg-purple-500/20 text-purple-300 border-purple-500/40"
                : "bg-sky-500/20 text-sky-300 border-sky-500/40";
            return `
              <div class="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex items-center gap-3">
                <div class="text-3xl">${escapeHtml(p.avatar)}</div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-1">
                    <span class="font-bold text-white text-sm truncate">${escapeHtml(p.name)}</span>
                    <span class="px-2 py-0.5 rounded-md text-[11px] font-bold border ${badgeStyle}">${roleName}</span>
                  </div>
                  <div class="text-xs text-slate-300 mt-1">
                    詞語：<strong class="text-white">${p.role === "BLANK" ? "（無詞語）" : escapeHtml(p.word)}</strong>
                  </div>
                  <div class="text-[11px] mt-0.5 ${p.alive ? "text-emerald-400" : "text-slate-500"}">
                    ${p.alive ? "存活至最後" : "投票淘汰出局"}
                  </div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// 渲染：題庫管理與 Excel 上傳/下載專區
// ============================================================================

function getAvailableCategories() {
  const counts = {};
  (AppState.wordBank.allWords || []).forEach(w => {
    const c = w.category || "未分類";
    counts[c] = (counts[c] || 0) + 1;
  });
  return Object.keys(counts).map(name => ({ name, count: counts[name] }));
}

function renderWordBankTab() {
  const container = document.getElementById("tab-panel-wordbank");
  if (!container) return;

  const categories = getAvailableCategories();
  const f = AppState.wbFilter;
  const kw = f.search.trim().toLowerCase();

  const filtered = (AppState.wordBank.allWords || []).filter(item => {
    if (f.category !== "ALL" && item.category !== f.category) return false;
    if (f.source === "DEFAULT" && item.isCustom) return false;
    if (f.source === "CUSTOM" && !item.isCustom) return false;
    if (kw) {
      const hay = `${item.wordA} ${item.wordB} ${item.category} ${item.hint || ""}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / f.pageSize));
  if (f.page > totalPages) f.page = totalPages;
  const startIdx = (f.page - 1) * f.pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + f.pageSize);

  const cloudSummary = window.cloudService.getStatusSummary();

  container.innerHTML = `
    <div class="max-w-5xl mx-auto space-y-6">
      <!-- 頂部統計與 Excel 檔案專區 -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- 新增單組題庫 -->
        <div class="lg:col-span-6 p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-lg font-bold text-white">➕ 線上新增題庫（兩兩一組）</h3>
            <span class="px-2.5 py-1 rounded-full text-xs ${cloudSummary.isCloudConfigured ? "bg-emerald-500/20 text-emerald-300" : "bg-indigo-500/20 text-indigo-300"}">
              ${cloudSummary.isCloudConfigured ? "☁️ 自動同步至雲端網路" : "💾 儲存並支援匯出/雲端同步"}
            </span>
          </div>
          <p class="text-xs text-slate-400 mb-4">請輸入兩個特徵非常相似的詞語（例如：水餃 vs 鍋貼、拿鐵 vs 卡布奇諾）：</p>

          <div class="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label class="block text-xs text-slate-400 mb-1">詞語 A (平民/臥底)</label>
              <input id="input-add-word-a" type="text" placeholder="例如：滷肉飯"
                class="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label class="block text-xs text-slate-400 mb-1">詞語 B (臥底/平民)</label>
              <input id="input-add-word-b" type="text" placeholder="例如：肉燥飯"
                class="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-500" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label class="block text-xs text-slate-400 mb-1">分類標籤</label>
              <input id="input-add-category" type="text" value="自訂題庫" placeholder="例如：美食小吃"
                class="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label class="block text-xs text-slate-400 mb-1">相似處提示 (選填)</label>
              <input id="input-add-hint" type="text" placeholder="例如：台灣南北稱呼與肥瘦差異"
                class="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-500" />
            </div>
          </div>

          <button id="btn-add-word-pair"
            class="w-full py-3 px-5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-lg shadow-indigo-600/25 transition">
            ✨ 新增至雲端題庫
          </button>
        </div>

        <!-- Excel 批次上傳與範本下載 -->
        <div class="lg:col-span-6 p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl flex flex-col justify-between">
          <div>
            <h3 class="text-lg font-bold text-white mb-1">📊 Excel 題庫文檔上傳與匯出 (.xlsx)</h3>
            <p class="text-xs text-slate-400 mb-4">
              已為您準備好兩兩一組的 120 組精選題庫 Excel 檔！您可下載編輯後直接拖曳或點擊上傳，系統會自動去重並同步至雲端網路。
            </p>

            <!-- 上傳拖曳區 -->
            <label for="input-excel-upload"
              class="block p-5 rounded-2xl border-2 border-dashed border-indigo-500/50 hover:border-indigo-400 bg-indigo-950/20 hover:bg-indigo-950/40 text-center cursor-pointer transition mb-4">
              <div class="text-3xl mb-1">📤</div>
              <div class="text-sm font-bold text-white">點擊選擇或拖曳上傳 Excel 題庫檔 (.xlsx / .csv)</div>
              <div class="text-xs text-slate-400 mt-1">支援欄位：「詞語A、詞語B、分類、相似處提示」或任意兩欄對照表</div>
              <input id="input-excel-upload" type="file" accept=".xlsx,.xls,.csv" class="hidden" />
            </label>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <a href="./wordbank_120.xlsx" download="誰是臥底_120組精選題庫.xlsx" id="btn-download-default-excel"
              class="py-2.5 px-4 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 text-xs font-bold text-center transition flex items-center justify-center gap-1.5">
              <span>📥 下載 120 組精選 Excel 文檔</span>
            </a>
            <button id="btn-export-all-excel"
              class="py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition flex items-center justify-center gap-1.5">
              <span>💾 匯出目前完整題庫 (${AppState.wordBank.allWords.length}組)</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 題庫瀏覽、搜尋與管理列表 -->
      <div class="p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 class="text-lg font-bold text-white">
              📚 雲端題庫總覽（共 ${AppState.wordBank.allWords.length} 組：預設 ${AppState.wordBank.defaultCount} 組 + 新增 ${AppState.wordBank.customCount} 組）
            </h3>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input id="input-wb-search" type="text" value="${escapeHtml(f.search)}" placeholder="🔍 搜尋詞語或分類..."
              class="px-3.5 py-1.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-xs focus:outline-none focus:border-indigo-500" />

            <select id="select-wb-category"
              class="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-xs">
              <option value="ALL" ${f.category === "ALL" ? "selected" : ""}>所有分類</option>
              ${categories.map(c => `
                <option value="${escapeHtml(c.name)}" ${f.category === c.name ? "selected" : ""}>${escapeHtml(c.name)} (${c.count})</option>
              `).join("")}
            </select>

            <select id="select-wb-source"
              class="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-xs">
              <option value="ALL" ${f.source === "ALL" ? "selected" : ""}>全部來源</option>
              <option value="DEFAULT" ${f.source === "DEFAULT" ? "selected" : ""}>預設精選 (120組)</option>
              <option value="CUSTOM" ${f.source === "CUSTOM" ? "selected" : ""}>使用者新增 (${AppState.wordBank.customCount}組)</option>
            </select>
          </div>
        </div>

        <!-- 題庫卡片網格 -->
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 mb-5">
          ${pageItems.map((item, idx) => `
            <div class="p-3.5 rounded-2xl bg-slate-950 border ${item.isCustom ? "border-emerald-500/40" : "border-slate-800"} flex flex-col justify-between">
              <div>
                <div class="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
                  <span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-indigo-300 font-medium">
                    ${escapeHtml(item.category || "未分類")}
                  </span>
                  <div class="flex items-center gap-2">
                    ${item.isCustom ? `<span class="text-emerald-400 font-semibold">★ 新增</span>` : `<span class="text-slate-600">#${startIdx + idx + 1}</span>`}
                    <button data-delete-word="${escapeHtml(item.id)}" class="text-slate-500 hover:text-rose-400 transition" title="刪除此題組">🗑️</button>
                  </div>
                </div>
                <div class="flex items-center justify-between gap-2 my-1">
                  <div class="flex-1 p-2 rounded-xl bg-slate-900 text-center font-bold text-white text-sm">
                    ${escapeHtml(item.wordA)}
                  </div>
                  <span class="text-xs text-slate-500 font-bold">VS</span>
                  <div class="flex-1 p-2 rounded-xl bg-slate-900 text-center font-bold text-white text-sm">
                    ${escapeHtml(item.wordB)}
                  </div>
                </div>
              </div>
              ${item.hint ? `<div class="text-[11px] text-slate-400 mt-1.5 truncate" title="${escapeHtml(item.hint)}">💡 ${escapeHtml(item.hint)}</div>` : ""}
            </div>
          `).join("")}
        </div>

        <!-- 分頁控制 -->
        <div class="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-slate-800">
          <div>顯示 ${filtered.length} 組中的第 ${filtered.length > 0 ? startIdx + 1 : 0} ~ ${Math.min(startIdx + f.pageSize, filtered.length)} 組</div>
          <div class="flex items-center gap-2">
            <button id="btn-wb-prev" ${f.page <= 1 ? "disabled" : ""}
              class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white">上一頁</button>
            <span>第 ${f.page} / ${totalPages} 頁</span>
            <button id="btn-wb-next" ${f.page >= totalPages ? "disabled" : ""}
              class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white">下一頁</button>
          </div>
        </div>
      </div>
    </div>
  `;

  bindWordBankEvents();
}

// ============================================================================
// 渲染：雲端資料庫串接設定 (Firebase / Supabase)
// ============================================================================

function renderCloudSettingsTab() {
  const container = document.getElementById("tab-panel-cloud");
  if (!container) return;

  const s = window.cloudService.settings;
  const isConfigured = window.cloudService.isCloudConfigured();

  container.innerHTML = `
    <div class="max-w-3xl mx-auto space-y-6">
      <div class="p-6 rounded-3xl bg-slate-900/90 border border-slate-800 shadow-xl">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-xl font-bold text-white">☁️ 雲端資料庫串接設定（永久保存網路新增題庫）</h2>
          <span class="px-3 py-1 rounded-full text-xs font-bold ${isConfigured ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40" : "bg-amber-500/20 text-amber-300 border border-amber-500/40"}">
            ${isConfigured ? "✓ 已啟用雲端資料庫同步" : "目前使用本機 + WebRTC 連線"}
          </span>
        </div>
        <p class="text-xs text-slate-400 leading-relaxed mb-6">
          為了讓您在純前端環境（如 GitHub Pages / Vercel）新增或上傳 Excel 後的題庫能<strong>永久保存在網際網路上</strong>，供所有手機與未來的場次共用，您可以串接免費的 <strong>Firebase Realtime Database</strong> 或 <strong>Supabase</strong>。
        </p>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">選擇雲端資料庫服務商</label>
            <select id="select-cloud-provider"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm">
              <option value="firebase" ${s.provider === "firebase" || s.provider === "none" ? "selected" : ""}>🔥 Google Firebase Realtime Database（最推薦！只需貼上 1 個網址）</option>
              <option value="supabase" ${s.provider === "supabase" ? "selected" : ""}>⚡ Supabase (PostgreSQL REST API)</option>
            </select>
          </div>

          <!-- Firebase 設定欄 -->
          <div id="cloud-box-firebase" class="${s.provider === "supabase" ? "hidden" : ""} p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3">
            <div>
              <label class="block text-xs font-semibold text-indigo-300 mb-1">Firebase Realtime Database 網址 (databaseURL)</label>
              <input id="input-firebase-url" type="text" value="${escapeHtml(s.firebaseDatabaseURL)}"
                placeholder="例如：https://your-project-default-rtdb.firebaseio.com"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-white text-sm font-mono focus:outline-none focus:border-indigo-500" />
              <p class="text-[11px] text-slate-400 mt-1.5">
                💡 支援直接貼上資料庫網址，或整段 <code>firebaseConfig</code> 程式碼，系統會自動擷取網址！
              </p>
            </div>
            <div class="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 text-xs text-slate-300 space-y-1">
              <div class="font-bold text-white mb-1">📖 1 分鐘免費申請 Firebase 步驟：</div>
              <div>1. 前往 <a href="https://console.firebase.google.com/" target="_blank" class="text-indigo-400 underline">Firebase Console</a> 新增專案。</div>
              <div>2. 點擊左側選單「建構 (Build)」→「<strong>Realtime Database</strong>」→ 點擊「建立資料庫」。</div>
              <div>3. 安全性規則選擇「<strong>以測試模式啟動 (Start in test mode)</strong>」啟用讀寫權限。</div>
              <div>4. 複製畫面頂端的 <code>https://xxx-default-rtdb.firebaseio.com/</code> 貼到上方輸入框即可！（也可寫入專案的 <code>config.js</code> 永久生效）</div>
            </div>
          </div>

          <!-- Supabase 設定欄 -->
          <div id="cloud-box-supabase" class="${s.provider === "supabase" ? "" : "hidden"} p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3">
            <div>
              <label class="block text-xs font-semibold text-emerald-300 mb-1">Supabase Project URL</label>
              <input id="input-supabase-url" type="text" value="${escapeHtml(s.supabaseUrl)}"
                placeholder="https://xxxx.supabase.co"
                class="w-full px-4 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white text-sm font-mono" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-emerald-300 mb-1">Supabase Anon Public Key</label>
              <input id="input-supabase-key" type="password" value="${escapeHtml(s.supabaseAnonKey)}"
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6..."
                class="w-full px-4 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white text-sm font-mono" />
            </div>
            <div class="text-[11px] text-slate-400">
              請在 Supabase SQL Editor 執行：<code>create table uc_store (id text primary key, data jsonb, updated_at timestamptz);</code> 並關閉 RLS 或允許 Anon 讀寫。
            </div>
          </div>

          <div class="flex flex-wrap gap-3 pt-2">
            <button id="btn-save-cloud"
              class="px-6 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-lg shadow-indigo-600/25 transition">
              💾 儲存並測試雲端連線
            </button>
            <button id="btn-copy-cloud-share-url"
              class="px-5 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 transition">
              🔗 複製帶有此雲端設定的專屬網址
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  bindCloudSettingsEvents();
}

// ============================================================================
// 事件綁定
// ============================================================================

function bindLobbyHomeEvents() {
  const nameInput = document.getElementById("input-player-name");
  if (nameInput) {
    nameInput.addEventListener("change", () => {
      savePlayerProfile(nameInput.value, AppState.myPlayer.avatar);
    });
  }

  document.querySelectorAll("[data-avatar-pick]").forEach(btn => {
    btn.addEventListener("click", () => {
      const av = btn.getAttribute("data-avatar-pick");
      const currentName = nameInput ? nameInput.value : AppState.myPlayer.name;
      savePlayerProfile(currentName, av);
      renderApp();
    });
  });

  const btnCreate = document.getElementById("btn-create-room");
  if (btnCreate) {
    btnCreate.addEventListener("click", async () => {
      if (nameInput) savePlayerProfile(nameInput.value, AppState.myPlayer.avatar);
      const roomCode = String(Math.floor(1000 + Math.random() * 9000));
      const initialRoom = createInitialRoomState(roomCode, AppState.myPlayer);
      AppState.room = initialRoom;
      AppState.viewingPlayerId = AppState.myPlayer.id;
      await window.cloudService.createRoomAsHost(roomCode, initialRoom, handleHostAction);
      renderApp();
      showToast(`🎉 已建立房間 #${roomCode}！請朋友掃描 QR Code 或輸入房號加入`, "success");
    });
  }

  const btnJoin = document.getElementById("btn-join-room");
  const codeInput = document.getElementById("input-join-code");
  if (btnJoin && codeInput) {
    const doJoin = async () => {
      if (nameInput) savePlayerProfile(nameInput.value, AppState.myPlayer.avatar);
      const code = codeInput.value.trim();
      if (!code) {
        showToast("請輸入 4 位數房間號碼", "warning");
        return;
      }
      btnJoin.disabled = true;
      btnJoin.textContent = "連線中...";
      await window.cloudService.joinRoomAsClient(
        code,
        AppState.myPlayer,
        (state) => {
          AppState.room = state;
          AppState.viewingPlayerId = AppState.myPlayer.id;
          renderApp();
        },
        (errMsg) => {
          showToast(errMsg, "error");
          renderApp();
        }
      );
    };
    btnJoin.addEventListener("click", doJoin);
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJoin();
    });
  }
}

let speakerTimerInterval = null;
let lastAutoAdvancedDeadline = 0;

function stopSpeakerCountdownTicker() {
  if (speakerTimerInterval) {
    clearInterval(speakerTimerInterval);
    speakerTimerInterval = null;
  }
}

function startSpeakerCountdownTicker() {
  stopSpeakerCountdownTicker();
  const updateTimerDom = () => {
    const room = AppState.room;
    if (!room || room.phase !== "SPEAKING" || !room.speakerDeadline) return;

    const textEl = document.getElementById("speaker-timer-text");
    const barEl = document.getElementById("speaker-timer-bar");
    const now = Date.now();
    const remainMs = Math.max(0, room.speakerDeadline - now);
    const remainSec = Math.ceil(remainMs / 1000);
    const totalMs = Math.max(1000, (room.speakerTotalSeconds || room.settings.thinkingTimeSeconds || 30) * 1000);
    const pct = Math.max(0, Math.min(100, (remainMs / totalMs) * 100));

    if (textEl) {
      textEl.textContent = `${remainSec} 秒`;
      if (remainSec <= 5) {
        textEl.className = "text-base font-mono font-extrabold text-rose-400 animate-pulse";
      } else if (remainSec <= 10) {
        textEl.className = "text-base font-mono font-extrabold text-amber-300";
      } else {
        textEl.className = "text-base font-mono font-extrabold text-emerald-300";
      }
    }

    if (barEl) {
      barEl.style.width = `${pct}%`;
      if (remainSec <= 5) {
        barEl.className = "h-full bg-rose-500 transition-all duration-200";
      } else {
        barEl.className = "h-full bg-gradient-to-r from-emerald-400 to-amber-400 transition-all duration-200";
      }
    }

    // 時間到時，由房主自動切換至下一位發言者 (或進入投票)
    if (remainMs <= 0 && room.hostId === AppState.myPlayer.id) {
      if (lastAutoAdvancedDeadline !== room.speakerDeadline) {
        lastAutoAdvancedDeadline = room.speakerDeadline;
        showToast("⏰ 思考時間到！自動切換至下一位", "warning");
        handleHostAction({ type: "NEXT_SPEAKER" });
      }
    }
  };

  updateTimerDom();
  speakerTimerInterval = setInterval(updateTimerDom, 200);
}

function bindRoomEvents() {
  const room = AppState.room;
  if (!room) return;
  const viewingPlayer = getActiveViewingPlayer();

  // 房間內展開/關閉修改個人暱稱與頭像面板
  const openEditProfile = () => {
    AppState.isEditingProfileInRoom = !AppState.isEditingProfileInRoom;
    AppState.roomDraftAvatar = viewingPlayer.avatar;
    renderApp();
    if (AppState.isEditingProfileInRoom) {
      const inp = document.getElementById("input-room-player-name");
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  };

  const btnToggleProfile = document.getElementById("btn-toggle-room-profile");
  if (btnToggleProfile) btnToggleProfile.addEventListener("click", openEditProfile);

  const btnQuickEditName = document.getElementById("btn-quick-edit-name");
  if (btnQuickEditName) btnQuickEditName.addEventListener("click", openEditProfile);

  document.querySelectorAll("[data-open-profile-edit]").forEach(btn => {
    btn.addEventListener("click", openEditProfile);
  });

  const btnCancelProfile = document.getElementById("btn-cancel-room-profile");
  if (btnCancelProfile) {
    btnCancelProfile.addEventListener("click", () => {
      AppState.isEditingProfileInRoom = false;
      renderApp();
    });
  }

  document.querySelectorAll("[data-room-avatar-pick]").forEach(btn => {
    btn.addEventListener("click", () => {
      AppState.roomDraftAvatar = btn.getAttribute("data-room-avatar-pick");
      const nameVal = document.getElementById("input-room-player-name")?.value || viewingPlayer.name;
      renderApp();
      const inp = document.getElementById("input-room-player-name");
      if (inp) inp.value = nameVal;
    });
  });

  const btnSaveProfile = document.getElementById("btn-save-room-profile");
  const inputRoomName = document.getElementById("input-room-player-name");
  if (btnSaveProfile && inputRoomName) {
    const commitProfileSave = () => {
      const newName = inputRoomName.value.trim();
      if (!newName) {
        showToast("請輸入暱稱", "warning");
        return;
      }
      const newAvatar = AppState.roomDraftAvatar || viewingPlayer.avatar;
      if (viewingPlayer.id === AppState.myPlayer.id) {
        savePlayerProfile(newName, newAvatar);
      } else {
        window.cloudService.sendActionToHost({
          type: "UPDATE_PLAYER_PROFILE",
          playerId: viewingPlayer.id,
          name: newName,
          avatar: newAvatar
        });
      }
      AppState.isEditingProfileInRoom = false;
      renderApp();
      showToast(`✅ 已將名稱更新為「${newName}」`, "success");
    };
    btnSaveProfile.addEventListener("click", commitProfileSave);
    inputRoomName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commitProfileSave();
    });
  }

  // 複製房間邀請連結
  const btnCopyInvite = document.getElementById("btn-copy-invite");
  if (btnCopyInvite) {
    btnCopyInvite.addEventListener("click", () => {
      const url = getRoomInviteUrl(room.roomCode);
      navigator.clipboard.writeText(url).then(() => {
        showToast("✅ 已複製房間邀請連結！傳給朋友點擊即可直接加入房間", "success");
      });
    });
  }

  // 離開房間 (自動通知房主移除該成員，無需房主手動踢人)
  const btnLeave = document.getElementById("btn-leave-room");
  if (btnLeave) {
    btnLeave.addEventListener("click", async () => {
      btnLeave.disabled = true;
      btnLeave.textContent = "離開中...";
      stopSpeakerCountdownTicker();
      await window.cloudService.leaveCurrentRoom(AppState.myPlayer.id);
      AppState.room = null;
      AppState.isEditingProfileInRoom = false;
      const url = new URL(window.location.href);
      url.searchParams.delete("room");
      window.history.replaceState({}, "", url.toString());
      renderApp();
      showToast("已離開房間", "info");
    });
  }

  // 返回等候大廳
  const backToLobbyBtns = [
    document.getElementById("btn-back-to-lobby"),
    document.getElementById("btn-back-to-lobby-2")
  ];
  backToLobbyBtns.forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        if (room.hostId !== AppState.myPlayer.id) return;
        room.phase = "LOBBY";
        room.speakerDeadline = null;
        window.cloudService.publishRoomState(room);
        renderApp();
      });
    }
  });

  // 同機多玩家視角切換
  document.querySelectorAll("[data-switch-player]").forEach(btn => {
    btn.addEventListener("click", () => {
      AppState.viewingPlayerId = btn.getAttribute("data-switch-player");
      AppState.cardRevealed = false;
      AppState.isEditingProfileInRoom = false;
      renderApp();
    });
  });

  // 新增同機玩家/測試座位 (最高支援 20 人)
  const btnAddLocal = document.getElementById("btn-add-local-player");
  if (btnAddLocal) {
    btnAddLocal.addEventListener("click", () => {
      if (room.players.length >= 20) return;
      const seatNum = room.players.length + 1;
      const botPlayer = {
        id: "local_" + Date.now() + "_" + seatNum,
        name: `玩家${seatNum}號`,
        avatar: AVATARS[seatNum % AVATARS.length],
        isLocalBot: true
      };
      handleHostAction({ type: "JOIN_ROOM", player: botPlayer });
    });
  }

  // 移除玩家
  document.querySelectorAll("[data-kick-player]").forEach(btn => {
    btn.addEventListener("click", () => {
      const pid = btn.getAttribute("data-kick-player");
      handleHostAction({ type: "REMOVE_PLAYER", playerId: pid });
    });
  });

  // 調整房間人數上限 (3 ~ 20 人)
  document.querySelectorAll("[data-adj-maxplayers]").forEach(btn => {
    btn.addEventListener("click", () => {
      const delta = parseInt(btn.getAttribute("data-adj-maxplayers"), 10);
      const cur = parseInt(room.settings.maxPlayers, 10) || 8;
      handleHostAction({
        type: "UPDATE_SETTINGS",
        settings: { maxPlayers: Math.max(3, Math.min(20, cur + delta)) }
      });
    });
  });

  const inputMaxPlayers = document.getElementById("input-max-players");
  if (inputMaxPlayers) {
    inputMaxPlayers.addEventListener("change", () => {
      const val = parseInt(inputMaxPlayers.value, 10) || 8;
      handleHostAction({
        type: "UPDATE_SETTINGS",
        settings: { maxPlayers: Math.max(3, Math.min(20, val)) }
      });
    });
  }

  // 調整每人思考秒數
  document.querySelectorAll("[data-adj-think]").forEach(btn => {
    btn.addEventListener("click", () => {
      const delta = parseInt(btn.getAttribute("data-adj-think"), 10);
      const cur = parseInt(room.settings.thinkingTimeSeconds ?? 30, 10) || 0;
      handleHostAction({
        type: "UPDATE_SETTINGS",
        settings: { thinkingTimeSeconds: Math.max(0, Math.min(300, cur + delta)) }
      });
    });
  });

  const inputThinkSec = document.getElementById("input-think-seconds");
  if (inputThinkSec) {
    inputThinkSec.addEventListener("change", () => {
      const val = parseInt(inputThinkSec.value, 10);
      handleHostAction({
        type: "UPDATE_SETTINGS",
        settings: { thinkingTimeSeconds: isNaN(val) ? 30 : Math.max(0, Math.min(300, val)) }
      });
    });
  }

  document.querySelectorAll("[data-preset-think]").forEach(btn => {
    btn.addEventListener("click", () => {
      const val = parseInt(btn.getAttribute("data-preset-think"), 10) || 0;
      handleHostAction({
        type: "UPDATE_SETTINGS",
        settings: { thinkingTimeSeconds: val }
      });
    });
  });

  // 依目前人數一鍵套用推薦臥底與白板數量
  const btnAutoRec = document.getElementById("btn-auto-recommend-roles");
  if (btnAutoRec) {
    btnAutoRec.addEventListener("click", () => {
      const rec = getRecommendedRoleCounts(Math.max(3, room.players.length));
      handleHostAction({
        type: "UPDATE_SETTINGS",
        settings: {
          undercoverCount: rec.undercover,
          blankCount: rec.blank
        }
      });
      showToast(`✨ 已套用 ${room.players.length} 人局推薦配置：${rec.undercover} 臥底、${rec.blank} 白板`, "info");
    });
  }

  // 調整臥底與白板人數
  document.querySelectorAll("[data-adj-role]").forEach(btn => {
    btn.addEventListener("click", () => {
      const roleType = btn.getAttribute("data-adj-role");
      const delta = parseInt(btn.getAttribute("data-delta"), 10);
      const newSettings = { ...room.settings };
      if (roleType === "uc") {
        newSettings.undercoverCount = (newSettings.undercoverCount || 1) + delta;
      } else if (roleType === "blank") {
        newSettings.blankCount = (newSettings.blankCount || 0) + delta;
      }
      handleHostAction({ type: "UPDATE_SETTINGS", settings: newSettings });
    });
  });

  // 選擇題庫分類
  const selCat = document.getElementById("select-room-category");
  if (selCat) {
    selCat.addEventListener("change", () => {
      handleHostAction({ type: "UPDATE_SETTINGS", settings: { category: selCat.value } });
    });
  }

  // 淘汰公開身分開關
  const chkReveal = document.getElementById("chk-reveal-role");
  if (chkReveal) {
    chkReveal.addEventListener("change", () => {
      handleHostAction({ type: "UPDATE_SETTINGS", settings: { revealRoleOnEliminate: chkReveal.checked } });
    });
  }

  // 開始發牌 / 再來一局
  const btnStart = document.getElementById("btn-start-game");
  if (btnStart) {
    btnStart.addEventListener("click", startNewGameRound);
  }
  const btnAgain = document.getElementById("btn-play-again");
  if (btnAgain) {
    btnAgain.addEventListener("click", startNewGameRound);
  }

  // 翻開/蓋上秘密詞語卡
  const btnCard = document.getElementById("btn-toggle-word-card");
  if (btnCard) {
    btnCard.addEventListener("click", () => {
      AppState.cardRevealed = !AppState.cardRevealed;
      if (AppState.cardRevealed && !viewingPlayer.cardChecked) {
        window.cloudService.sendActionToHost({
          type: "MARK_CARD_CHECKED",
          playerId: viewingPlayer.id
        });
      }
      renderApp();
    });
  }

  // 延長思考時間 +15秒
  const btnExtendTime = document.getElementById("btn-extend-time");
  if (btnExtendTime) {
    btnExtendTime.addEventListener("click", () => {
      window.cloudService.sendActionToHost({
        type: "EXTEND_SPEAKER_TIME",
        seconds: 15
      });
    });
  }

  // 送出文字發言描述
  const btnClue = document.getElementById("btn-submit-clue");
  const inputClue = document.getElementById("input-clue-text");
  if (btnClue && inputClue) {
    const sendClue = () => {
      const val = inputClue.value.trim();
      if (!val) return;
      window.cloudService.sendActionToHost({
        type: "SUBMIT_CLUE",
        playerId: viewingPlayer.id,
        text: val
      });
      inputClue.value = "";
    };
    btnClue.addEventListener("click", sendClue);
    inputClue.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendClue();
    });
  }

  // 下一位發言 / 進入投票
  const btnNextSpeaker = document.getElementById("btn-next-speaker");
  if (btnNextSpeaker) {
    btnNextSpeaker.addEventListener("click", () => {
      window.cloudService.sendActionToHost({ type: "NEXT_SPEAKER" });
    });
  }
  const btnStartVotingNow = document.getElementById("btn-start-voting-now");
  if (btnStartVotingNow) {
    btnStartVotingNow.addEventListener("click", () => {
      window.cloudService.sendActionToHost({ type: "START_VOTING" });
    });
  }

  // 玩家點擊投票
  document.querySelectorAll("[data-vote-target]").forEach(el => {
    el.addEventListener("click", () => {
      const targetId = el.getAttribute("data-vote-target");
      window.cloudService.sendActionToHost({
        type: "CAST_VOTE",
        voterId: viewingPlayer.id,
        targetId
      });
    });
  });

  // 房主強制結算投票
  const btnForceVote = document.getElementById("btn-force-resolve-vote");
  if (btnForceVote) {
    btnForceVote.addEventListener("click", () => {
      window.cloudService.sendActionToHost({ type: "FORCE_RESOLVE_VOTE" });
    });
  }
}

function bindWordBankEvents() {
  const btnAdd = document.getElementById("btn-add-word-pair");
  if (btnAdd) {
    btnAdd.addEventListener("click", async () => {
      const wA = document.getElementById("input-add-word-a").value.trim();
      const wB = document.getElementById("input-add-word-b").value.trim();
      const cat = document.getElementById("input-add-category").value.trim() || "自訂題庫";
      const hint = document.getElementById("input-add-hint").value.trim();

      if (!wA || !wB) {
        showToast("請填寫「詞語 A」與「詞語 B」", "warning");
        return;
      }
      if (wA === wB) {
        showToast("兩個詞語必須相似但不能完全相同喔！", "warning");
        return;
      }

      const res = await window.cloudService.addCustomWords([{ wordA: wA, wordB: wB, category: cat, hint }]);
      if (res.addedCount === 0) {
        showToast("此組詞語已存在於題庫中！", "warning");
        return;
      }
      await refreshWordBank();
      renderApp();
      showToast(`✅ 已成功新增「${wA} vs ${wB}」並同步儲存！`, "success");
    });
  }

  const fileInput = document.getElementById("input-excel-upload");
  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        handleExcelFileUpload(file);
        fileInput.value = "";
      }
    });
  }

  const btnExportAll = document.getElementById("btn-export-all-excel");
  if (btnExportAll) {
    btnExportAll.addEventListener("click", () => exportWordBankToExcel(false));
  }

  const searchInput = document.getElementById("input-wb-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      AppState.wbFilter.search = searchInput.value;
      AppState.wbFilter.page = 1;
      renderWordBankTab();
      const newSearch = document.getElementById("input-wb-search");
      if (newSearch) {
        newSearch.focus();
        newSearch.setSelectionRange(newSearch.value.length, newSearch.value.length);
      }
    });
  }

  const catSelect = document.getElementById("select-wb-category");
  if (catSelect) {
    catSelect.addEventListener("change", () => {
      AppState.wbFilter.category = catSelect.value;
      AppState.wbFilter.page = 1;
      renderWordBankTab();
    });
  }

  const srcSelect = document.getElementById("select-wb-source");
  if (srcSelect) {
    srcSelect.addEventListener("change", () => {
      AppState.wbFilter.source = srcSelect.value;
      AppState.wbFilter.page = 1;
      renderWordBankTab();
    });
  }

  document.querySelectorAll("[data-delete-word]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delete-word");
      await window.cloudService.deleteWordById(id);
      await refreshWordBank();
      renderWordBankTab();
      showToast("已移除該題組", "info");
    });
  });

  const btnPrev = document.getElementById("btn-wb-prev");
  if (btnPrev) {
    btnPrev.addEventListener("click", () => {
      if (AppState.wbFilter.page > 1) {
        AppState.wbFilter.page--;
        renderWordBankTab();
      }
    });
  }
  const btnNext = document.getElementById("btn-wb-next");
  if (btnNext) {
    btnNext.addEventListener("click", () => {
      AppState.wbFilter.page++;
      renderWordBankTab();
    });
  }
}

function bindCloudSettingsEvents() {
  const providerSel = document.getElementById("select-cloud-provider");
  const fbBox = document.getElementById("cloud-box-firebase");
  const sbBox = document.getElementById("cloud-box-supabase");

  if (providerSel && fbBox && sbBox) {
    providerSel.addEventListener("change", () => {
      const isSb = providerSel.value === "supabase";
      fbBox.classList.toggle("hidden", isSb);
      sbBox.classList.toggle("hidden", !isSb);
    });
  }

  const btnSave = document.getElementById("btn-save-cloud");
  if (btnSave) {
    btnSave.addEventListener("click", async () => {
      const provider = providerSel ? providerSel.value : "firebase";
      const fbUrl = (document.getElementById("input-firebase-url")?.value || "").trim();
      const sbUrl = (document.getElementById("input-supabase-url")?.value || "").trim();
      const sbKey = (document.getElementById("input-supabase-key")?.value || "").trim();

      const saved = window.cloudService.saveSettings({
        provider,
        firebaseDatabaseURL: fbUrl,
        supabaseUrl: sbUrl,
        supabaseAnonKey: sbKey
      });

      if (!window.cloudService.isCloudConfigured()) {
        renderApp();
        showToast("已切換為本機儲存 + WebRTC 即時連線模式", "info");
        return;
      }

      btnSave.disabled = true;
      btnSave.textContent = "測試連線與同步中...";
      const testRes = await window.cloudService.testCloudConnection(saved);
      await refreshWordBank();
      renderApp();

      if (testRes.ok) {
        showToast("✅ " + testRes.message + " 題庫已與雲端完成雙向同步！", "success");
      } else {
        showToast("⚠️ " + testRes.message, "warning");
      }
    });
  }

  const btnCopyShare = document.getElementById("btn-copy-cloud-share-url");
  if (btnCopyShare) {
    btnCopyShare.addEventListener("click", () => {
      const fbUrl = (document.getElementById("input-firebase-url")?.value || "").trim();
      if (!fbUrl) {
        showToast("請先填寫 Firebase Realtime Database 網址", "warning");
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set("fb", fbUrl);
      navigator.clipboard.writeText(url.toString()).then(() => {
        showToast("✅ 已複製專屬雲端網址！任何人打開此連結都會自動連接您的雲端題庫", "success");
      });
    });
  }
}

// ============================================================================
// 啟動流程
// ============================================================================

async function refreshWordBank() {
  const wb = await window.cloudService.fetchAndSyncWordBank();
  AppState.wordBank = wb;
}

window.addEventListener("DOMContentLoaded", async () => {
  initPlayerProfile();
  await refreshWordBank();

  // 綁定頂部導覽切換
  ["game", "wordbank", "cloud", "rules"].forEach(tab => {
    const btn = document.getElementById(`tab-btn-${tab}`);
    if (btn) {
      btn.addEventListener("click", () => {
        AppState.activeTab = tab;
        renderApp();
      });
    }
  });

  // 監聽房間狀態更新 (來自房主廣播)
  window.cloudService.onRoomStateChange((newState) => {
    if (newState && (!AppState.room || newState.roomCode === AppState.room.roomCode)) {
      AppState.room = newState;
      renderApp();
    }
  });

  // 監聽跨分頁題庫更新
  window.cloudService.onWordBankRemoteUpdate = async () => {
    await refreshWordBank();
    renderApp();
  };

  // 當玩家直接關閉分頁或重新整理離開時，自動通知房主移除該玩家
  const notifyLeaveOnUnload = () => {
    if (AppState.room && AppState.room.hostId !== AppState.myPlayer.id) {
      window.cloudService.sendActionToHost({
        type: "LEAVE_ROOM",
        playerId: AppState.myPlayer.id
      });
    }
  };
  window.addEventListener("pagehide", notifyLeaveOnUnload);
  window.addEventListener("beforeunload", notifyLeaveOnUnload);

  renderApp();

  // 若網址帶有 ?room=XXXX 參數，自動加入該房間
  const params = new URLSearchParams(window.location.search);
  const autoRoom = params.get("room");
  if (autoRoom) {
    showToast(`正在自動加入房間 #${autoRoom}...`, "info");
    await window.cloudService.joinRoomAsClient(
      autoRoom.trim(),
      AppState.myPlayer,
      (state) => {
        AppState.room = state;
        AppState.viewingPlayerId = AppState.myPlayer.id;
        renderApp();
        showToast(`✅ 已成功加入房間 #${autoRoom}`, "success");
      },
      (err) => {
        showToast(err, "warning");
      }
    );
  }
});

