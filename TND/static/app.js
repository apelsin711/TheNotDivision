const $ = (id) => document.getElementById(id);

let socket = null;
const TND_API_BASE = (window.TND_API_BASE || "").trim().replace(/\/$/, "");

function websocketUrl() {
  const base = TND_API_BASE || window.location.origin;
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
let myId = null;
let roomCode = null;
let roomState = null;
let currentMediaKey = null;
let ytPlayer = null;
let ytReady = false;
let ytApiPromise = null;
let localStream = null;
let voiceEnabled = false;
let peerConnections = new Map();
let remoteAudioElements = new Map();
let pendingIce = new Map();
let toastTimer = null;
let lastAppliedPlaybackKey = "";

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function setConnection(online, label) {
  $("connectionDot").classList.toggle("online", online);
  $("connectionText").textContent = label;
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast("Нет соединения с комнатой");
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function connectToRoom(name, code) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  socket = new WebSocket(websocketUrl());
  setConnection(false, "Подключаемся…");
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join", name, code }));
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleServerMessage(message);
  });
  socket.addEventListener("close", () => {
    setConnection(false, "Не подключено");
    if (roomCode) showToast("Соединение с комнатой закрыто");
  });
  socket.addEventListener("error", () => showToast("Не удалось подключиться к серверу"));
}

function handleServerMessage(message) {
  if (message.type === "error") {
    showToast(message.message || "Ошибка");
    if (!roomCode) setConnection(false, "Не подключено");
    return;
  }
  if (message.type === "notice") {
    showToast(message.message);
    return;
  }
  if (message.type === "joined") {
    myId = message.id;
    roomCode = message.code;
    $("roomCode").textContent = roomCode;
    $("lobby").classList.add("hidden");
    $("room").classList.remove("hidden");
    setConnection(true, "В комнате");
    showToast(`Ты подключился к пати ${roomCode}`);
    renderState(message.state);
    return;
  }
  if (message.type === "state") {
    renderState(message.state);
    if (message.event === "media_changed") showToast("Видео обновлено");
    if (message.event === "playback_approved") showToast("Большинство одобрило действие");
    if (message.event === "proposal_rejected") showToast("Голосование отклонено");
    return;
  }
  if (message.type === "voice_signal") {
    handleVoiceSignal(message.from, message.signal);
  }
}

function renderState(state) {
  if (!state) return;
  roomState = state;
  renderPeople();
  renderQueue();
  renderProposal();
  renderChat();
  updatePlayer(state.current);
  updateVoicePeers();
}

function renderPeople() {
  const people = roomState?.participants || [];
  $("peopleCount").textContent = people.length;
  const list = $("peopleList");
  list.replaceChildren();
  people.forEach((person) => {
    const row = document.createElement("div");
    row.className = "person";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = (person.name || "?").slice(0, 1).toUpperCase();
    const name = document.createElement("div");
    name.className = "person-name";
    name.textContent = person.name + (person.id === myId ? " (ты)" : "");
    row.append(avatar, name);
    if (person.id === roomState.host) {
      const host = document.createElement("span");
      host.className = "host-tag";
      host.textContent = "HOST";
      row.append(host);
    }
    if (person.voice) {
      const mic = document.createElement("span");
      mic.className = "mic-tag";
      mic.textContent = "◖))";
      mic.title = "Микрофон включён";
      row.append(mic);
    }
    list.append(row);
  });
}

function renderQueue() {
  const queue = roomState?.queue || [];
  $("queueCount").textContent = queue.length;
  const list = $("queueList");
  list.replaceChildren();
  if (!queue.length) {
    const empty = document.createElement("div");
    empty.className = "empty-queue";
    empty.textContent = "Очередь пока пустая. Предложи первый ролик!";
    list.append(empty);
    return;
  }
  queue.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "queue-item";
    const number = document.createElement("div");
    number.className = "queue-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("div");
    copy.className = "queue-copy";
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = item.title;
    const meta = document.createElement("div");
    meta.className = "queue-meta";
    meta.textContent = `Добавил: ${item.added_by} · ${item.votes} голос(ов)`;
    copy.append(title, meta);
    const vote = document.createElement("button");
    vote.type = "button";
    vote.className = "queue-vote" + (item.voter_ids.includes(myId) ? " voted" : "");
    vote.textContent = `${item.votes} ↑`;
    vote.title = "Проголосовать за это видео";
    vote.addEventListener("click", () => send({ type: "vote_video", item_id: item.id }));
    row.append(number, copy, vote);
    list.append(row);
  });
}

function renderProposal() {
  const proposal = roomState?.proposal;
  const panel = $("proposalPanel");
  if (!proposal) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const actions = {
    play: "включить воспроизведение",
    pause: "поставить видео на паузу",
    seek: "перемотать видео",
  };
  const person = (roomState.participants || []).find((p) => p.id === proposal.proposer);
  const name = person?.name || "Участник";
  $("proposalText").textContent = `${name} предлагает ${actions[proposal.action] || "изменить видео"}. Одобрить?`;
  const total = roomState.participants.length || 1;
  const yesNeeded = Math.floor(total / 2) + 1;
  const cast = proposal.yes + proposal.no;
  $("proposalCount").textContent = `${proposal.yes} за · ${proposal.no} против · нужно ${yesNeeded}`;
  $("proposalProgress").style.width = `${Math.min(100, proposal.yes / yesNeeded * 100)}%`;
  const alreadyVoted = proposal.yes_ids.includes(myId) || proposal.no_ids.includes(myId);
  $("voteYes").disabled = false;
  $("voteNo").disabled = false;
  $("voteYes").textContent = proposal.yes_ids.includes(myId) ? "За ✓" : "За ✓";
  $("voteNo").textContent = proposal.no_ids.includes(myId) ? "Против ✓" : "Против";
  if (alreadyVoted) {
    $("voteYes").style.opacity = proposal.yes_ids.includes(myId) ? "1" : ".62";
    $("voteNo").style.opacity = proposal.no_ids.includes(myId) ? "1" : ".62";
  } else {
    $("voteYes").style.opacity = "1";
    $("voteNo").style.opacity = "1";
  }
}

function renderChat() {
  const messages = roomState?.chat || [];
  const box = $("chatMessages");
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 55;
  box.replaceChildren();
  if (!messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "chat-welcome";
    welcome.textContent = "Здесь появятся сообщения вашей пати 👋";
    box.append(welcome);
    return;
  }
  messages.forEach((message) => {
    const row = document.createElement("div");
    row.className = "chat-message";
    const avatar = document.createElement("div");
    avatar.className = "chat-avatar";
    avatar.textContent = (message.name || "?").slice(0, 1).toUpperCase();
    const body = document.createElement("div");
    body.className = "chat-message-body";
    const author = document.createElement("div");
    author.className = "chat-author";
    author.textContent = message.name || "Гость";
    const date = new Date((message.created_at || Date.now() / 1000) * 1000);
    const timeLabel = document.createElement("span");
    timeLabel.className = "chat-time";
    timeLabel.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    author.append(timeLabel);
    const text = document.createElement("div");
    text.className = "chat-text";
    text.textContent = message.text;
    body.append(author, text);
    row.append(avatar, body);
    box.append(row);
  });
  if (wasNearBottom) box.scrollTop = box.scrollHeight;
}

function youtubeVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const match = url.pathname.match(/^\/(embed|shorts|live)\/([^/?]+)/);
      return match ? match[2] : null;
    }
  } catch { /* invalid URL */ }
  return null;
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      ytApiPromise = null;
      showToast("Не удалось загрузить YouTube Player API");
      resolve();
    };
    document.head.append(script);
  });
  return ytApiPromise;
}

async function mountCurrentMedia(current) {
  if (ytPlayer && typeof ytPlayer.destroy === "function") {
    try { ytPlayer.destroy(); } catch { /* player already removed */ }
  }
  ytPlayer = null;
  ytReady = false;
  $("youtubeMount").replaceChildren();
  $("filePlayer").pause();
  $("filePlayer").removeAttribute("src");
  $("filePlayer").load();

  if (!current) {
    $("emptyPlayer").classList.remove("hidden");
    $("filePlayer").classList.add("hidden");
    $("youtubeMount").classList.add("hidden");
    $("currentTitle").textContent = "Ничего не выбрано";
    $("playerStatus").textContent = "Ожидаем видео";
    $("playPause").disabled = true;
    $("seekBar").disabled = true;
    $("seekBar").value = 0;
    $("currentTime").textContent = "0:00";
    $("duration").textContent = "0:00";
    return;
  }

  $("emptyPlayer").classList.add("hidden");
  $("currentTitle").textContent = current.title || "Видео";
  $("playPause").disabled = false;
  $("seekBar").disabled = false;
  const id = youtubeVideoId(current.url);
  if (id) {
    $("filePlayer").classList.add("hidden");
    $("youtubeMount").classList.remove("hidden");
    const mount = document.createElement("div");
    mount.id = "youtubePlayer";
    $("youtubeMount").append(mount);
    await loadYouTubeApi();
    if (!window.YT || !window.YT.Player) return;
    ytPlayer = new YT.Player("youtubePlayer", {
      width: "100%",
      height: "100%",
      videoId: id,
      playerVars: { autoplay: 0, controls: 0, rel: 0, playsinline: 1, enablejsapi: 1 },
      events: {
        onReady: () => {
          ytReady = true;
          applyPlaybackSnapshot(roomState?.current);
          updateDurationDisplay();
        },
        onStateChange: (event) => {
          if (event.data === YT.PlayerState.ENDED && myId === roomState?.host) send({ type: "next_video" });
        },
        onError: () => showToast("Это видео не удалось встроить. Проверь, разрешено ли встраивание на YouTube."),
      },
    });
  } else {
    $("youtubeMount").classList.add("hidden");
    $("filePlayer").classList.remove("hidden");
    const video = $("filePlayer");
    video.src = current.url;
    video.load();
    video.onloadedmetadata = () => {
      applyPlaybackSnapshot(roomState?.current);
      updateDurationDisplay();
    };
    video.onerror = () => showToast("Не удалось открыть файл. Нужна прямая ссылка на MP4/WebM с доступом для браузера.");
    video.onended = () => {
      if (myId === roomState?.host) send({ type: "next_video" });
    };
  }
  applyPlaybackSnapshot(current);
}

function updatePlayer(current) {
  const nextKey = current ? `${current.kind}|${current.url}` : "empty";
  if (nextKey !== currentMediaKey) {
    currentMediaKey = nextKey;
    lastAppliedPlaybackKey = "";
    mountCurrentMedia(current);
  } else if (current) {
    applyPlaybackSnapshot(current);
  } else {
    mountCurrentMedia(null);
  }
  if (current) {
    $("playerStatus").textContent = current.playing ? "● Воспроизводится" : "Ⅱ На паузе";
  }
}

function localPlayerIsPlaying() {
  if (ytPlayer && ytReady) return ytPlayer.getPlayerState() === YT.PlayerState.PLAYING || ytPlayer.getPlayerState() === YT.PlayerState.BUFFERING;
  const video = $("filePlayer");
  return !video.paused && !video.ended;
}

function applyPlaybackSnapshot(current) {
  if (!current) return;
  const signature = `${current.url}|${Math.round(current.time || 0)}|${current.playing}`;
  const targetTime = Math.max(0, Number(current.time) || 0);
  if (ytPlayer && ytReady) {
    try {
      const now = ytPlayer.getCurrentTime() || 0;
      if (Math.abs(now - targetTime) > 2.2) ytPlayer.seekTo(targetTime, true);
      if (current.playing && !localPlayerIsPlaying()) ytPlayer.playVideo();
      if (!current.playing && localPlayerIsPlaying()) ytPlayer.pauseVideo();
    } catch { /* player may still be initializing */ }
    return;
  }
  const video = $("filePlayer");
  if (video.classList.contains("hidden") || !video.src) return;
  if (video.readyState >= 1 && Math.abs(video.currentTime - targetTime) > 2.2) {
    try { video.currentTime = targetTime; } catch { /* metadata not ready */ }
  }
  if (current.playing && video.paused) {
    video.play().catch(() => {
      $("playerStatus").textContent = "Нажми ▶ для запуска на этом устройстве";
    });
  } else if (!current.playing && !video.paused) {
    video.pause();
  }
  lastAppliedPlaybackKey = signature;
}

function getPlayerTime() {
  if (ytPlayer && ytReady) {
    try { return ytPlayer.getCurrentTime() || 0; } catch { return 0; }
  }
  return $("filePlayer").currentTime || 0;
}

function getPlayerDuration() {
  if (ytPlayer && ytReady) {
    try { return ytPlayer.getDuration() || 0; } catch { return 0; }
  }
  return $("filePlayer").duration || 0;
}

function updateDurationDisplay() {
  const duration = getPlayerDuration();
  $("duration").textContent = formatTime(duration);
  $("seekBar").max = duration > 0 ? duration : 100;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function requestControl(action, value) {
  if (!roomState?.current) return;
  send({ type: "propose_control", action, value });
}

function sendReaction(emoji) {
  send({ type: "reaction", emoji });
}

function appendReaction(reaction) {
  const item = document.createElement("div");
  item.className = "floating-reaction";
  item.textContent = `${reaction.emoji}  ${reaction.name}`;
  $("reactionOverlay").append(item);
  setTimeout(() => item.remove(), 1800);
}

function appendChatLocally() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  if (send({ type: "chat", text })) input.value = "";
}

function setVoiceButton() {
  $("voiceToggle").classList.toggle("active", voiceEnabled);
  $("voiceToggle").textContent = voiceEnabled ? "Выключить микрофон" : "Включить микрофон";
  $("voiceHint").textContent = voiceEnabled ? "Микрофон включён · звук передаётся участникам пати" : "Микрофон выключен";
}

async function toggleVoice() {
  if (!voiceEnabled) {
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast("Для микрофона открой сайт через localhost или HTTPS");
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      voiceEnabled = true;
      setVoiceButton();
      send({ type: "voice_status", enabled: true });
      updateVoicePeers();
    } catch (error) {
      showToast(error.name === "NotAllowedError" ? "Браузер не получил разрешение на микрофон" : "Не удалось включить микрофон");
    }
  } else {
    voiceEnabled = false;
    if (localStream) localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    closeAllPeers();
    setVoiceButton();
    send({ type: "voice_status", enabled: false });
  }
}

function closePeer(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    try { pc.close(); } catch { /* already closed */ }
    peerConnections.delete(peerId);
  }
  pendingIce.delete(peerId);
  const audio = remoteAudioElements.get(peerId);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    remoteAudioElements.delete(peerId);
  }
}

function closeAllPeers() {
  [...peerConnections.keys()].forEach(closePeer);
}

function ensurePeer(peerId) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  peerConnections.set(peerId, pc);
  if (localStream) localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  pc.onicecandidate = (event) => {
    if (event.candidate) send({ type: "voice_signal", target: peerId, signal: { type: "ice", candidate: event.candidate } });
  };
  pc.ontrack = (event) => {
    let audio = remoteAudioElements.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      $("remoteAudios").append(audio);
      remoteAudioElements.set(peerId, audio);
    }
    audio.srcObject = event.streams[0];
    audio.play().catch(() => showToast("Нажми на страницу, чтобы разрешить звук голосового чата"));
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) closePeer(peerId);
  };
  return pc;
}

async function updateVoicePeers() {
  if (!roomState || !myId) return;
  const active = new Set();
  const others = roomState.participants.filter((p) => p.id !== myId && p.voice && voiceEnabled);
  for (const person of others) {
    active.add(person.id);
    const pc = ensurePeer(person.id);
    if (myId > person.id && !pc._offerStarted) {
      pc._offerStarted = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "voice_signal", target: person.id, signal: { type: "offer", description: pc.localDescription } });
      } catch (error) {
        pc._offerStarted = false;
        console.warn("WebRTC offer failed", error);
      }
    }
  }
  [...peerConnections.keys()].forEach((peerId) => {
    if (!active.has(peerId)) closePeer(peerId);
  });
}

async function handleVoiceSignal(from, signal) {
  if (!voiceEnabled || !signal) return;
  const pc = ensurePeer(from);
  try {
    if (signal.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.description));
      const pending = pendingIce.get(from) || [];
      for (const candidate of pending) await pc.addIceCandidate(new RTCIceCandidate(candidate));
      pendingIce.delete(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "voice_signal", target: from, signal: { type: "answer", description: pc.localDescription } });
    } else if (signal.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.description));
      const pending = pendingIce.get(from) || [];
      for (const candidate of pending) await pc.addIceCandidate(new RTCIceCandidate(candidate));
      pendingIce.delete(from);
    } else if (signal.type === "ice") {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } else {
        const list = pendingIce.get(from) || [];
        list.push(signal.candidate);
        pendingIce.set(from, list);
      }
    }
  } catch (error) {
    console.warn("WebRTC signal error", error);
    showToast("Не удалось соединить голосовой чат. Попробуйте выключить и включить микрофон.");
  }
}

$("createForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("createName").value.trim() || "Гость";
  connectToRoom(name, "");
});

$("joinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("joinName").value.trim() || "Гость";
  const code = $("joinCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) {
    showToast("Код комнаты должен состоять из 6 символов");
    return;
  }
  connectToRoom(name, code);
});

$("joinCode").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

$("copyCode").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode || "");
    showToast("Код комнаты скопирован");
  } catch {
    showToast(`Код комнаты: ${roomCode}`);
  }
});

$("addVideoForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = $("videoUrl").value.trim();
  const title = $("videoTitle").value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    showToast("Вставь полную ссылку, начинающуюся с https://");
    return;
  }
  if (send({ type: "add_video", url, title })) {
    $("videoUrl").value = "";
    $("videoTitle").value = "";
  }
});

$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  appendChatLocally();
});

$("chatInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    appendChatLocally();
  }
});

document.querySelectorAll("[data-emoji]").forEach((button) => {
  button.addEventListener("click", () => sendReaction(button.dataset.emoji));
});

$("playPause").addEventListener("click", () => {
  if (!roomState?.current) return;
  // A browser may block autoplay for a newly joined viewer. Let that viewer
  // start the already-approved stream locally without creating a new vote.
  if (roomState.current.playing && !localPlayerIsPlaying()) {
    if (ytPlayer && ytReady) ytPlayer.playVideo();
    else $("filePlayer").play().catch(() => showToast("Нажми ещё раз, чтобы разрешить воспроизведение"));
    return;
  }
  requestControl(roomState.current.playing ? "pause" : "play");
});

$("seekBar").addEventListener("input", () => {
  $("currentTime").textContent = formatTime(Number($("seekBar").value));
});
$("seekBar").addEventListener("change", () => {
  if (roomState?.current) requestControl("seek", Number($("seekBar").value));
});

$("fullscreen").addEventListener("click", () => {
  const stage = $("playerStage");
  if (document.fullscreenElement) document.exitFullscreen?.();
  else stage.requestFullscreen?.().catch(() => showToast("Полноэкранный режим недоступен"));
});

$("voteYes").addEventListener("click", () => {
  if (roomState?.proposal) send({ type: "vote_control", proposal_id: roomState.proposal.id, vote: "yes" });
});
$("voteNo").addEventListener("click", () => {
  if (roomState?.proposal) send({ type: "vote_control", proposal_id: roomState.proposal.id, vote: "no" });
});

$("voiceToggle").addEventListener("click", toggleVoice);

$("leaveRoom").addEventListener("click", () => {
  if (socket) socket.close();
  closeAllPeers();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  voiceEnabled = false;
  myId = null;
  roomCode = null;
  roomState = null;
  currentMediaKey = null;
  $("room").classList.add("hidden");
  $("lobby").classList.remove("hidden");
  setConnection(false, "Не подключено");
  setVoiceButton();
});

setInterval(() => {
  if (!roomState?.current) return;
  const now = getPlayerTime();
  const duration = getPlayerDuration();
  if (document.activeElement !== $("seekBar")) $("seekBar").value = duration > 0 ? Math.min(now, duration) : 0;
  $("currentTime").textContent = formatTime(now);
  if (duration > 0) $("duration").textContent = formatTime(duration);
  $("playPause").textContent = roomState.current.playing ? "Ⅱ" : "▶";
  $("playerStatus").textContent = roomState.current.playing ? "● Воспроизводится" : "Ⅱ На паузе";
}, 500);

window.addEventListener("beforeunload", () => {
  if (socket) socket.close();
  closeAllPeers();
});
