'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const wordLists = require('./words');

// ---------------------------------------------------------------------------
// Settings you may want to change
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const HARD_MAX_PLAYERS = 8;            // no room can ever hold more than this
const MAX_ROOMS = 40;                  // protects the free server from overload
const GRACE_MS = 90 * 1000;            // a disconnected player keeps their seat this long
const DRAWER_GONE_MS = 20 * 1000;      // skip a drawer who stays offline this long
const CHOOSE_SECONDS = 15;             // time the drawer has to pick a word
const REVEAL_MS = 5000;                // how long the score summary shows after each turn
const TEMP_BAN_MS = 5 * 60 * 1000;     // a vote-kicked player cannot rejoin for this long
const DRAW_TIMES = [30, 45, 60, 80, 100, 120];

// Avatar parts: color, eyes, mouth, accessory, extra. Must match index.html.
const AV_COUNTS = [12, 8, 8, 10, 6];

const REPORT_REASONS = ['Inappropriate drawing', 'Abusive chat', 'Cheating', 'Spam'];

// Limits on drawing data, so one player cannot flood the server
const MAX_OPS = 6000;
const MAX_POINTS = 120000;
const MAX_POINTS_PER_CHUNK = 200;

// Words live in words.js (easy, medium and hard lists). Edit that file to change them.

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 }); // 100 KB per message is plenty

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round4 = v => Math.round(v * 10000) / 10000;
const stripControl = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '');
const normalize = s => stripControl(s).toLowerCase().trim().replace(/\s+/g, ' ');

function sanitizeName(s) {
  return stripControl(s).trim().slice(0, 16) || 'Player';
}

// ----- Word pools by difficulty -----
const LEVELS = ['easy', 'medium', 'hard'];
const DIFFICULTIES = ['easy', 'medium', 'hard', 'mixed'];
const LEVEL_MULT = { easy: 1, medium: 1.25, hard: 1.5, custom: 1 }; // harder words earn more points
const POOLS = { easy: [], medium: [], hard: [] };
(function buildPools() {
  const seen = new Set();
  for (const lvl of LEVELS) {
    for (const raw of wordLists[lvl] || []) {
      const w = normalize(raw);
      if (!w || seen.has(w)) continue; // the easier list wins if a word is repeated
      seen.add(w);
      POOLS[lvl].push(w);
    }
  }
})();

function sanitizeAvatar(a) {
  const out = [];
  for (let i = 0; i < AV_COUNTS.length; i++) {
    const v = Array.isArray(a) ? Number(a[i]) : 0;
    out.push(Number.isInteger(v) && v >= 0 && v < AV_COUNTS[i] ? v : 0);
  }
  return out;
}

function parseCustomWords(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\n,]+/)) {
    const w = normalize(raw);
    if (w.length < 3 || w.length > 30) continue;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} '\-]*$/u.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 200) break;
  }
  return out;
}

// Token-bucket rate limiter: allows `burst` quick actions, then `rate` per second
function makeLimiter(rate, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const t = Date.now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * rate);
    last = t;
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  };
}

// True when the two strings differ by exactly one edit
function isOneEditAway(a, b) {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (b.length < 3) return false;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n] === 1;
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

// ---------------------------------------------------------------------------
// Rooms and players
// ---------------------------------------------------------------------------
function createRoom(ownerId, isPublic) {
  const room = {
    code: randomCode(),
    owner: ownerId,
    players: new Map(),
    banned: new Set(),
    tempBans: new Map(),
    settings: { rounds: 3, drawTime: 60, maxPlayers: HARD_MAX_PLAYERS, difficulty: 'medium', isPublic: !!isPublic, customWords: [], customOnly: false },
    state: 'lobby', // lobby | choosing | drawing | reveal | paused | over
    round: 0,
    order: [],
    drawerIdx: -1,
    drawerId: null,
    word: null,
    wordLevel: 'easy',
    choices: [],
    guessed: new Set(),
    turnPoints: new Map(),
    revealed: new Set(),
    ops: [],
    pointCount: 0,
    endsAt: 0,
    timer: null,
    hintTimers: [],
    drawerGoneTimer: null,
    kickVotes: new Map(),
    reports: new Map(),
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

const touch = room => { room.lastActive = Date.now(); };
const onlinePlayers = room => [...room.players.values()].filter(p => p.connected);
const isOnline = (room, id) => {
  const p = room.players.get(id);
  return !!p && p.connected;
};

function allGuessed(room) {
  const guessers = onlinePlayers(room).filter(p => p.id !== room.drawerId);
  return guessers.length > 0 && guessers.every(p => room.guessed.has(p.id));
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.drawerGoneTimer);
  room.hintTimers.forEach(clearTimeout);
  for (const p of room.players.values()) clearTimeout(p.graceTimer);
  rooms.delete(room.code);
}

function findPublicRoom() {
  let best = null;
  for (const r of rooms.values()) {
    if (!r.settings.isPublic) continue;
    if (r.players.size >= r.settings.maxPlayers) continue;
    const online = onlinePlayers(r).length;
    if (online === 0) continue;
    if (!best || online > onlinePlayers(best).length) best = r;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Sending data to players
// ---------------------------------------------------------------------------
function stateFor(room, forId) {
  const s = room.settings;
  return {
    code: room.code,
    owner: room.owner,
    state: room.state,
    round: room.round,
    rounds: s.rounds,
    drawerId: room.drawerId,
    endsIn: room.endsAt ? Math.max(0, room.endsAt - Date.now()) : 0,
    settings: {
      rounds: s.rounds,
      drawTime: s.drawTime,
      maxPlayers: s.maxPlayers,
      difficulty: s.difficulty,
      isPublic: s.isPublic,
      customOnly: s.customOnly,
      customCount: s.customWords.length,
      customWords: forId === room.owner ? s.customWords.join(', ') : undefined,
    },
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      avatar: p.avatar,
      guessed: room.guessed.has(p.id),
    })),
  };
}

// Sends an event to everyone in the room, skipping anyone who muted `fromId`
function broadcast(room, event, data, fromId) {
  for (const p of room.players.values()) {
    if (!p.connected) continue;
    if (fromId && p.muted.has(fromId)) continue;
    io.to(p.socketId).emit(event, data);
  }
}

function sendTo(room, id, event, data) {
  const p = room.players.get(id);
  if (p && p.connected) io.to(p.socketId).emit(event, data);
}

function hintArray(room) {
  return [...room.word].map((ch, i) => {
    if (ch === ' ') return ' ';
    if (!/[\p{L}\p{N}]/u.test(ch) || room.revealed.has(i)) return ch;
    return '_';
  });
}

// The drawer, and anyone who already guessed, sees the word. Everyone else sees blanks.
function sendWordInfo(room, p) {
  if (room.state === 'choosing' && p.id === room.drawerId) {
    io.to(p.socketId).emit('choices', room.choices);
  } else if (room.state === 'drawing') {
    if (p.id === room.drawerId || room.guessed.has(p.id)) io.to(p.socketId).emit('word', { word: room.word });
    else io.to(p.socketId).emit('hint', { hint: hintArray(room) });
  }
}

function sendOps(room, p) {
  const drawerMuted = room.drawerId && p.muted.has(room.drawerId);
  io.to(p.socketId).emit('sync', { ops: drawerMuted ? [] : room.ops });
}

function syncRoom(room) {
  for (const p of room.players.values()) {
    if (!p.connected) continue;
    io.to(p.socketId).emit('state', stateFor(room, p.id));
    sendWordInfo(room, p);
  }
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------
function pickWords(room, n) {
  const st = room.settings;
  const custom = st.customWords;
  const take = (pool, count) => {
    const p = [...pool];
    const out = [];
    while (out.length < count && p.length > 0) out.push(p.splice(Math.floor(Math.random() * p.length), 1)[0]);
    return out;
  };
  const tag = (words, level) => words.map(w => ({ word: w, level: custom.includes(w) ? 'custom' : level }));

  if (st.customOnly && custom.length >= 3) return tag(take(custom, n), 'custom');

  if (st.difficulty === 'mixed') {
    // One easy, one medium and one hard word, in random order
    const picks = [
      ...tag(take([...POOLS.easy, ...custom], 1), 'easy'),
      ...tag(take(POOLS.medium, 1), 'medium'),
      ...tag(take(POOLS.hard, 1), 'hard'),
    ];
    for (let i = picks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [picks[i], picks[j]] = [picks[j], picks[i]];
    }
    return picks;
  }
  return tag(take([...POOLS[st.difficulty], ...custom], n), st.difficulty);
}

function startGame(room) {
  for (const p of room.players.values()) p.score = 0;
  room.order = [...room.players.keys()];
  room.drawerIdx = -1;
  room.round = 1;
  room.kickVotes.clear();
  nextTurn(room);
}

function nextTurn(room) {
  clearTimeout(room.timer);
  clearTimeout(room.drawerGoneTimer);

  if (onlinePlayers(room).length < 2) {
    if (room.players.size >= 2) {
      // Someone is probably just switching apps. Wait for them instead of ending the game.
      room.state = 'paused';
      room.drawerId = null;
      room.word = null;
      room.endsAt = 0;
      room.timer = setTimeout(() => {
        if (room.state !== 'paused') return;
        if (onlinePlayers(room).length < 2) endGame(room);
        else nextTurn(room);
      }, GRACE_MS);
      syncRoom(room);
      return;
    }
    return endGame(room);
  }

  let guard = room.order.length * 2 + 2;
  do {
    room.drawerIdx++;
    if (room.drawerIdx >= room.order.length) {
      room.drawerIdx = 0;
      room.round++;
    }
    if (room.round > room.settings.rounds) return endGame(room);
    if (--guard < 0) return endGame(room);
  } while (!isOnline(room, room.order[room.drawerIdx]));

  room.drawerId = room.order[room.drawerIdx];
  room.state = 'choosing';
  room.word = null;
  room.choices = pickWords(room, 3);
  room.guessed = new Set();
  room.turnPoints = new Map();
  room.revealed = new Set();
  room.ops = [];
  room.pointCount = 0;
  room.endsAt = Date.now() + CHOOSE_SECONDS * 1000;
  broadcast(room, 'clear', {});
  room.timer = setTimeout(() => chooseWord(room, room.choices[0].word), CHOOSE_SECONDS * 1000);
  syncRoom(room);
}

function chooseWord(room, word) {
  if (room.state !== 'choosing' || !word) return;
  const picked = room.choices.find(c => c.word === word);
  if (!picked) return;
  clearTimeout(room.timer);
  room.word = word;
  room.wordLevel = picked.level;
  room.state = 'drawing';
  room.revealed = new Set();
  room.endsAt = Date.now() + room.settings.drawTime * 1000;
  room.timer = setTimeout(() => endTurn(room), room.settings.drawTime * 1000);
  scheduleHints(room);
  syncRoom(room);
}

// Reveals a few letters as the time runs down
function scheduleHints(room) {
  room.hintTimers.forEach(clearTimeout);
  room.hintTimers = [];
  const hidden = [...room.word].filter(ch => /[\p{L}\p{N}]/u.test(ch)).length;
  const maxReveal = Math.min(3, Math.floor(hidden / 2.5));
  const fractions = [0.45, 0.65, 0.82];
  for (let k = 0; k < maxReveal; k++) {
    room.hintTimers.push(setTimeout(() => revealLetter(room), room.settings.drawTime * 1000 * fractions[k]));
  }
}

function revealLetter(room) {
  if (room.state !== 'drawing' || !room.word) return;
  const candidates = [];
  [...room.word].forEach((ch, i) => {
    if (/[\p{L}\p{N}]/u.test(ch) && !room.revealed.has(i)) candidates.push(i);
  });
  if (candidates.length <= 1) return; // always keep at least one letter hidden
  room.revealed.add(candidates[Math.floor(Math.random() * candidates.length)]);
  const hint = hintArray(room);
  for (const p of room.players.values()) {
    if (p.connected && p.id !== room.drawerId && !room.guessed.has(p.id)) {
      io.to(p.socketId).emit('hint', { hint });
    }
  }
}

function endTurn(room) {
  if (room.state !== 'choosing' && room.state !== 'drawing') return;
  clearTimeout(room.timer);
  clearTimeout(room.drawerGoneTimer);
  room.hintTimers.forEach(clearTimeout);
  room.hintTimers = [];

  const word = room.word;
  const results = [...room.players.values()]
    .map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      gained: room.turnPoints.get(p.id) || 0,
      total: p.score,
      connected: p.connected,
    }))
    .sort((a, b) => b.total - a.total);

  room.state = 'reveal';
  room.endsAt = 0;
  broadcast(room, 'turnEnd', { word, level: room.wordLevel, results });
  syncRoom(room);
  room.timer = setTimeout(() => nextTurn(room), REVEAL_MS);
}

function endGame(room) {
  clearTimeout(room.timer);
  clearTimeout(room.drawerGoneTimer);
  room.hintTimers.forEach(clearTimeout);
  room.hintTimers = [];
  room.state = 'over';
  room.round = Math.min(room.round, room.settings.rounds);
  room.drawerId = null;
  room.word = null;
  room.endsAt = 0;
  room.guessed = new Set();
  const results = [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar }));
  broadcast(room, 'gameover', { results });
  syncRoom(room);
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  clearTimeout(p.graceTimer);
  room.players.delete(id);
  room.kickVotes.delete(id);
  room.guessed.delete(id);

  if (room.players.size === 0) {
    destroyRoom(room);
    return;
  }

  if (room.owner === id) {
    const next = onlinePlayers(room)[0] || [...room.players.values()][0];
    room.owner = next.id;
    broadcast(room, 'system', { text: `${next.name} is now the host.` });
  }

  const inGame = ['choosing', 'drawing', 'reveal', 'paused'].includes(room.state);
  if (inGame && room.players.size < 2) return endGame(room);

  if (room.state === 'drawing' || room.state === 'choosing') {
    if (id === room.drawerId) return endTurn(room);
    if (room.state === 'drawing' && allGuessed(room)) return endTurn(room);
  }

  syncRoom(room);
}

function leaveCurrentRoom(socket) {
  const code = socket.data.code;
  if (!code) return;
  const room = rooms.get(code);
  if (room) removePlayer(room, socket.data.playerId);
  socket.data = {};
}

// ---------------------------------------------------------------------------
// Drawing data validation
// ---------------------------------------------------------------------------
function cleanOp(o) {
  if (!o || typeof o !== 'object') return null;
  const sid = o.sid;
  if (!Number.isInteger(sid) || sid < 0 || sid > 1e9) return null;
  const c = /^#[0-9a-fA-F]{6}$/.test(o.c) ? o.c.toLowerCase() : '#111111';

  if (o.t === 'f') {
    if (typeof o.x !== 'number' || typeof o.y !== 'number') return null;
    if (o.x < 0 || o.x > 1 || o.y < 0 || o.y > 1) return null;
    return { t: 'f', sid, c, x: round4(o.x), y: round4(o.y) };
  }

  const p = o.p;
  if (!Array.isArray(p) || p.length < 2 || p.length > MAX_POINTS_PER_CHUNK * 2 || p.length % 2 !== 0) return null;
  const pts = [];
  for (const v of p) {
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) return null;
    pts.push(round4(v));
  }
  const w = clamp(Number(o.w) || 8, 1, 60);
  return { t: 's', sid, c, w, p: pts };
}

const opPoints = op => (op.t === 'f' ? 50 : op.p.length / 2);

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------
io.on('connection', socket => {
  socket.data = {};

  const limits = {
    chat: makeLimiter(1.2, 4),
    draw: makeLimiter(35, 60),
    misc: makeLimiter(3, 12),
  };

  const getRoom = () => (socket.data.code ? rooms.get(socket.data.code) : undefined);
  const getMe = room => (room ? room.players.get(socket.data.playerId) : undefined);

  // Lets the page check that the connection is still alive after the phone wakes up
  socket.on('hello', cb => {
    if (typeof cb === 'function') cb(true);
  });

  socket.on('listRooms', cb => {
    if (typeof cb !== 'function') return;
    if (!limits.misc()) return cb([]);
    const list = [];
    for (const r of rooms.values()) {
      if (!r.settings.isPublic) continue;
      const online = onlinePlayers(r).length;
      if (online === 0) continue;
      const host = r.players.get(r.owner);
      list.push({
        code: r.code,
        host: host ? host.name : '',
        players: online,
        max: r.settings.maxPlayers,
        state: r.state,
        round: r.round,
        rounds: r.settings.rounds,
        full: r.players.size >= r.settings.maxPlayers,
      });
    }
    list.sort((a, b) => b.players - a.players);
    cb(list.slice(0, 30));
  });

  socket.on('join', (d = {}) => {
    if (!limits.misc()) return socket.emit('joinError', 'Too many attempts. Wait a moment and try again.');
    const playerId = stripControl(d.playerId).slice(0, 64);
    if (!playerId) return socket.emit('joinError', 'Missing player id. Please reload the page.');
    const name = sanitizeName(d.name);
    const avatar = sanitizeAvatar(d.avatar);

    let room;
    if (d.quick) {
      room = findPublicRoom();
      if (!room) {
        if (rooms.size >= MAX_ROOMS) return socket.emit('joinError', 'The server is busy right now. Try again in a few minutes.');
        room = createRoom(playerId, true);
      }
    } else if (d.create) {
      if (rooms.size >= MAX_ROOMS) return socket.emit('joinError', 'The server is busy right now. Try again in a few minutes.');
      room = createRoom(playerId, false);
    } else {
      room = rooms.get(String(d.code || '').trim().toUpperCase());
      if (!room) return socket.emit('joinError', 'Room not found. Check the code.');
    }

    if (room.banned.has(playerId)) return socket.emit('joinError', 'You were banned from this room.');
    const bannedUntil = room.tempBans.get(playerId);
    if (bannedUntil && bannedUntil > Date.now()) {
      return socket.emit('joinError', 'You were removed by a vote. You can rejoin in a few minutes.');
    }

    // Joining a different room than the one this connection was in
    if (socket.data.code && socket.data.code !== room.code) leaveCurrentRoom(socket);

    let p = room.players.get(playerId);
    if (p) {
      // Reconnect: the player keeps their seat, score, and turn.
      clearTimeout(p.graceTimer);
      p.connected = true;
      p.socketId = socket.id;
      if (room.drawerId === playerId) clearTimeout(room.drawerGoneTimer);
    } else {
      if (room.players.size >= room.settings.maxPlayers) return socket.emit('joinError', 'This room is full.');
      p = {
        id: playerId,
        name,
        avatar,
        score: 0,
        socketId: socket.id,
        connected: true,
        graceTimer: null,
        muted: new Set(),
      };
      room.players.set(playerId, p);
      if (['choosing', 'drawing', 'reveal', 'paused'].includes(room.state) && !room.order.includes(playerId)) {
        room.order.push(playerId);
      }
    }

    socket.data = { code: room.code, playerId };
    touch(room);
    socket.emit('joined', { code: room.code, playerId, isOwner: room.owner === playerId });
    sendOps(room, p);

    if (room.state === 'paused' && onlinePlayers(room).length >= 2) {
      clearTimeout(room.timer);
      nextTurn(room);
    } else {
      syncRoom(room);
    }
  });

  socket.on('leave', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('settings', (d = {}) => {
    if (!limits.misc()) return;
    const room = getRoom();
    if (!room || room.owner !== socket.data.playerId) return;
    if (room.state !== 'lobby' && room.state !== 'over') return;
    const s = room.settings;
    s.rounds = clamp(parseInt(d.rounds, 10) || 3, 1, 8);
    const dt = parseInt(d.drawTime, 10);
    s.drawTime = DRAW_TIMES.includes(dt) ? dt : 60;
    s.maxPlayers = clamp(parseInt(d.maxPlayers, 10) || HARD_MAX_PLAYERS, Math.max(2, room.players.size), HARD_MAX_PLAYERS);
    s.difficulty = DIFFICULTIES.includes(d.difficulty) ? d.difficulty : 'medium';
    s.isPublic = !!d.isPublic;
    s.customWords = parseCustomWords(d.customWords);
    s.customOnly = !!d.customOnly && s.customWords.length >= 3;
    touch(room);
    syncRoom(room);
  });

  socket.on('start', () => {
    if (!limits.misc()) return;
    const room = getRoom();
    if (!room || room.owner !== socket.data.playerId) return;
    if (room.state !== 'lobby' && room.state !== 'over') return;
    if (onlinePlayers(room).length < 2) {
      return socket.emit('notice', 'You need at least 2 players to start.');
    }
    touch(room);
    startGame(room);
  });

  socket.on('choose', word => {
    const room = getRoom();
    if (!room || room.state !== 'choosing' || socket.data.playerId !== room.drawerId) return;
    if (!room.choices.some(c => c.word === word)) return;
    touch(room);
    chooseWord(room, word);
  });

  socket.on('draw', op => {
    if (!limits.draw()) return;
    const room = getRoom();
    if (!room || room.state !== 'drawing' || socket.data.playerId !== room.drawerId) return;
    const clean = cleanOp(op);
    if (!clean) return;
    if (room.ops.length >= MAX_OPS || room.pointCount + opPoints(clean) > MAX_POINTS) return;
    room.ops.push(clean);
    room.pointCount += opPoints(clean);
    for (const p of room.players.values()) {
      if (!p.connected || p.id === room.drawerId || p.muted.has(room.drawerId)) continue;
      io.to(p.socketId).emit('draw', clean);
    }
  });

  socket.on('undo', () => {
    if (!limits.misc()) return;
    const room = getRoom();
    if (!room || room.state !== 'drawing' || socket.data.playerId !== room.drawerId) return;
    if (room.ops.length === 0) return;
    const lastSid = room.ops[room.ops.length - 1].sid;
    room.ops = room.ops.filter(o => o.sid !== lastSid);
    room.pointCount = room.ops.reduce((sum, o) => sum + opPoints(o), 0);
    for (const p of room.players.values()) {
      if (p.connected) sendOps(room, p);
    }
  });

  socket.on('clear', () => {
    if (!limits.misc()) return;
    const room = getRoom();
    if (!room || room.state !== 'drawing' || socket.data.playerId !== room.drawerId) return;
    room.ops = [];
    room.pointCount = 0;
    broadcast(room, 'clear', {});
  });

  socket.on('guess', text => {
    const room = getRoom();
    const me = getMe(room);
    if (!me) return;
    if (!limits.chat()) return socket.emit('notice', 'You are sending messages too fast.');
    const msg = stripControl(text).trim().slice(0, 80);
    if (!msg) return;
    touch(room);

    if (room.state === 'drawing' && room.word) {
      const isDrawer = me.id === room.drawerId;
      const hasGuessed = room.guessed.has(me.id);
      const answer = normalize(room.word);
      const guess = normalize(msg);

      if (!isDrawer && !hasGuessed) {
        if (guess === answer) {
          room.guessed.add(me.id);
          const left = Math.max(0, room.endsAt - Date.now());
          const base = 100 + 200 * (left / (room.settings.drawTime * 1000));
          const points = Math.round(base * (LEVEL_MULT[room.wordLevel] || 1));
          me.score += points;
          room.turnPoints.set(me.id, (room.turnPoints.get(me.id) || 0) + points);
          const drawer = room.players.get(room.drawerId);
          if (drawer) {
            const bonus = Math.ceil(points / 4);
            drawer.score += bonus;
            room.turnPoints.set(drawer.id, (room.turnPoints.get(drawer.id) || 0) + bonus);
          }
          sendTo(room, me.id, 'correct', { points });
          broadcast(room, 'system', { text: `${me.name} guessed the word!`, kind: 'good', who: me.id });
          syncRoom(room);
          if (allGuessed(room)) endTurn(room);
          return;
        }
        if (isOneEditAway(guess, answer)) socket.emit('close', {});
        // A wrong guess falls through and shows in the chat for everyone
      } else {
        // The drawer and players who already guessed chat privately, so nobody can leak the word
        if (guess === answer) return;
        for (const p of room.players.values()) {
          if (!p.connected || p.muted.has(me.id)) continue;
          if (p.id === room.drawerId || room.guessed.has(p.id)) {
            io.to(p.socketId).emit('chat', { name: me.name, text: msg, from: me.id, priv: true });
          }
        }
        return;
      }
    }

    broadcast(room, 'chat', { name: me.name, text: msg, from: me.id }, me.id);
  });

  // ----- Moderation -----
  function removeForModeration(targetId, ban, reason) {
    const room = getRoom();
    if (!room || room.owner !== socket.data.playerId) return;
    const id = String(targetId || '');
    if (!id || id === room.owner || !room.players.has(id)) return;
    if (ban) room.banned.add(id);
    sendTo(room, id, 'kicked', { ban, reason });
    removePlayer(room, id);
  }
  socket.on('kick', id => {
    if (limits.misc()) removeForModeration(id, false, 'host');
  });
  socket.on('ban', id => {
    if (limits.misc()) removeForModeration(id, true, 'host');
  });

  socket.on('mute', (d = {}) => {
    if (!limits.misc()) return;
    const room = getRoom();
    const me = getMe(room);
    if (!me || !d.id) return;
    if (d.on) me.muted.add(String(d.id));
    else me.muted.delete(String(d.id));
  });

  socket.on('votekick', targetId => {
    if (!limits.misc()) return;
    const room = getRoom();
    const me = getMe(room);
    const id = String(targetId || '');
    const target = room && room.players.get(id);
    if (!me || !target || id === me.id) return;
    if (id === room.owner) return socket.emit('notice', "The host can't be vote-kicked.");

    const eligible = onlinePlayers(room).filter(p => p.id !== id);
    if (eligible.length < 2) return socket.emit('notice', 'Vote kick needs at least 3 players in the room.');

    const votes = room.kickVotes.get(id) || new Set();
    if (votes.has(me.id)) return socket.emit('notice', 'You already voted to kick this player.');
    votes.add(me.id);
    room.kickVotes.set(id, votes);

    const needed = Math.floor(eligible.length / 2) + 1;
    const count = [...votes].filter(v => room.players.has(v)).length;
    broadcast(room, 'system', { text: `${me.name} voted to kick ${target.name} (${count}/${needed}).` });

    if (count >= needed) {
      room.tempBans.set(id, Date.now() + TEMP_BAN_MS);
      broadcast(room, 'system', { text: `${target.name} was removed by vote.` });
      sendTo(room, id, 'kicked', { ban: false, reason: 'vote' });
      removePlayer(room, id);
    }
  });

  socket.on('report', (d = {}) => {
    if (!limits.misc()) return;
    const room = getRoom();
    const me = getMe(room);
    const id = String(d.id || '');
    const target = room && room.players.get(id);
    if (!me || !target || id === me.id) return;
    const reason = REPORT_REASONS.includes(d.reason) ? d.reason : 'Other';

    const byReporter = room.reports.get(id) || new Map();
    if (byReporter.has(me.id)) return socket.emit('notice', 'You already reported this player.');
    byReporter.set(me.id, reason);
    room.reports.set(id, byReporter);

    // Reports appear in the server logs (on Render: your service > Logs)
    console.log(`[REPORT] room=${room.code} target="${target.name}" (${id.slice(0, 8)}) reason="${reason}" reporter="${me.name}" totalReports=${byReporter.size}`);

    socket.emit('notice', 'Thanks, your report was sent.');
    if (room.owner !== me.id && room.owner !== id) {
      sendTo(room, room.owner, 'system', {
        text: `${target.name} was reported: ${reason} (${byReporter.size} report${byReporter.size > 1 ? 's' : ''}).`,
      });
    }
  });

  socket.on('disconnect', () => {
    const room = getRoom();
    const p = getMe(room);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.graceTimer = setTimeout(() => removePlayer(room, p.id), GRACE_MS);

    if (room.drawerId === p.id && (room.state === 'choosing' || room.state === 'drawing')) {
      clearTimeout(room.drawerGoneTimer);
      room.drawerGoneTimer = setTimeout(() => {
        const dp = room.players.get(p.id);
        const stillDrawing = room.drawerId === p.id && (room.state === 'choosing' || room.state === 'drawing');
        if (dp && !dp.connected && stillDrawing) {
          broadcast(room, 'system', { text: `${dp.name} lost connection, skipping their turn.` });
          endTurn(room);
        }
      }, DRAWER_GONE_MS);
    }
    syncRoom(room);
  });
});

// ---------------------------------------------------------------------------
// Housekeeping: remove empty or forgotten rooms so the free server stays light
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const idleFor = now - room.lastActive;
    if (onlinePlayers(room).length === 0 && idleFor > 2 * 60 * 1000) destroyRoom(room);
    else if (idleFor > 3 * 60 * 60 * 1000) destroyRoom(room);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Doodle Room is running on port ${PORT}`);
});
