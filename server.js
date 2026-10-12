const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const GRACE_MS = 90 * 1000;     // how long a disconnected player keeps their seat
const CHOOSE_SECONDS = 15;      // time the drawer has to pick a word
const DRAW_SECONDS = 60;        // time to guess each word
const MAX_PLAYERS = 12;

// Edit this list to change the words. Keep them short and simple.
const WORDS = [
  'apple', 'banana', 'bicycle', 'house', 'tree', 'car', 'airplane', 'boat',
  'cat', 'dog', 'fish', 'elephant', 'giraffe', 'penguin', 'snake', 'spider',
  'sun', 'moon', 'star', 'cloud', 'rainbow', 'mountain', 'volcano', 'river',
  'pizza', 'burger', 'ice cream', 'cake', 'carrot', 'mushroom', 'banana split',
  'guitar', 'piano', 'drum', 'camera', 'phone', 'laptop', 'clock', 'umbrella',
  'hat', 'shoe', 'glasses', 'crown', 'key', 'lock', 'ladder', 'bridge',
  'castle', 'rocket', 'robot', 'ghost', 'dragon', 'pirate', 'snowman', 'beach',
];

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function randomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function pickWords(n) {
  const pool = [...WORDS];
  const out = [];
  while (out.length < n && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// "apple" -> "_ _ _ _ _", "ice cream" -> "_ _ _   _ _ _ _ _"
function hintFor(word) {
  return word.split('').map(c => (c === ' ' ? '  ' : '_ ')).join('').trimEnd();
}

function onlinePlayers(room) {
  return [...room.players.values()].filter(p => p.connected);
}

function isOnline(room, id) {
  const p = room.players.get(id);
  return !!p && p.connected;
}

function allGuessed(room) {
  const guessers = onlinePlayers(room).filter(p => p.id !== room.drawerId);
  return guessers.length > 0 && guessers.every(p => room.guessed.has(p.id));
}

function publicState(room) {
  return {
    code: room.code,
    owner: room.owner,
    state: room.state,
    round: room.round,
    rounds: room.rounds,
    drawerId: room.drawerId,
    endsIn: room.endsAt ? Math.max(0, room.endsAt - Date.now()) : 0,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
    })),
  };
}

// Sends an event to everyone in the room, skipping anyone who muted fromId.
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

// The drawer gets the word, everyone else gets only the blank hint.
function sendWordInfo(room, p) {
  if (room.state === 'choosing' && p.id === room.drawerId) {
    io.to(p.socketId).emit('choices', room.choices);
  } else if (room.state === 'drawing') {
    if (p.id === room.drawerId) io.to(p.socketId).emit('word', { word: room.word });
    else io.to(p.socketId).emit('hint', { hint: hintFor(room.word) });
  }
}

function syncRoom(room) {
  broadcast(room, 'state', publicState(room));
  for (const p of room.players.values()) {
    if (p.connected) sendWordInfo(room, p);
  }
}

function startGame(room) {
  for (const p of room.players.values()) p.score = 0;
  room.order = [...room.players.keys()];
  room.drawerIdx = -1;
  room.round = 1;
  nextTurn(room);
}

function nextTurn(room) {
  clearTimeout(room.timer);
  if (onlinePlayers(room).length < 2) return endGame(room);

  do {
    room.drawerIdx++;
    if (room.drawerIdx >= room.order.length) {
      room.drawerIdx = 0;
      room.round++;
    }
    if (room.round > room.rounds) return endGame(room);
  } while (!isOnline(room, room.order[room.drawerIdx]));

  room.drawerId = room.order[room.drawerIdx];
  room.state = 'choosing';
  room.word = null;
  room.choices = pickWords(3);
  room.guessed = new Set();
  room.strokes = [];
  room.endsAt = Date.now() + CHOOSE_SECONDS * 1000;
  broadcast(room, 'clear', {});
  room.timer = setTimeout(() => chooseWord(room, room.choices[0]), CHOOSE_SECONDS * 1000);
  syncRoom(room);
}

function chooseWord(room, word) {
  if (room.state !== 'choosing') return;
  clearTimeout(room.timer);
  room.word = word;
  room.state = 'drawing';
  room.endsAt = Date.now() + DRAW_SECONDS * 1000;
  room.timer = setTimeout(() => endTurn(room), DRAW_SECONDS * 1000);
  syncRoom(room);
}

function endTurn(room) {
  if (room.state !== 'choosing' && room.state !== 'drawing') return;
  clearTimeout(room.timer);
  const word = room.word;
  room.state = 'reveal';
  room.endsAt = 0;
  broadcast(room, 'system', { text: word ? `The word was "${word}".` : 'Nobody picked a word.' });
  syncRoom(room);
  room.timer = setTimeout(() => nextTurn(room), 4000);
}

function endGame(room) {
  clearTimeout(room.timer);
  room.state = 'over';
  room.drawerId = null;
  room.word = null;
  room.endsAt = 0;
  const results = [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score }));
  broadcast(room, 'gameover', { results });
  syncRoom(room);
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  clearTimeout(p.graceTimer);
  room.players.delete(id);

  if (room.players.size === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }

  if (room.owner === id) {
    const next = onlinePlayers(room)[0] || [...room.players.values()][0];
    room.owner = next.id;
  }

  if (room.state === 'drawing' || room.state === 'choosing') {
    if (id === room.drawerId) return endTurn(room);
    if (room.state === 'drawing' && allGuessed(room)) return endTurn(room);
  }

  const inGame = ['choosing', 'drawing', 'reveal'].includes(room.state);
  if (inGame && onlinePlayers(room).length < 2) return endGame(room);

  syncRoom(room);
}

function cleanSegment(s) {
  if (!s || typeof s !== 'object') return null;
  const coords = [s.x0, s.y0, s.x1, s.y1];
  if (!coords.every(v => typeof v === 'number' && v >= 0 && v <= 1)) return null;
  const color = /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : '#111111';
  const size = Math.min(40, Math.max(1, Number(s.size) || 6));
  return { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, color, size };
}

function getRoom(socket) {
  const code = socket.data.code;
  return code ? rooms.get(code) : undefined;
}

function moderate(socket, targetId, ban) {
  const room = getRoom(socket);
  if (!room || room.owner !== socket.data.playerId) return;
  const id = String(targetId || '');
  if (!id || id === room.owner || !room.players.has(id)) return;
  if (ban) room.banned.add(id);
  sendTo(room, id, 'kicked', { ban });
  removePlayer(room, id);
}

io.on('connection', socket => {
  socket.data = {};

  socket.on('join', (data = {}) => {
    const playerId = String(data.playerId || '').slice(0, 64);
    if (!playerId) return socket.emit('joinError', 'Missing player id. Please reload the page.');
    const name = String(data.name || '').trim().slice(0, 16) || 'Player';

    let room;
    if (data.create) {
      room = {
        code: randomCode(),
        owner: playerId,
        players: new Map(),
        banned: new Set(),
        state: 'lobby',
        rounds: 3,
        round: 0,
        order: [],
        drawerIdx: -1,
        drawerId: null,
        word: null,
        choices: [],
        guessed: new Set(),
        strokes: [],
        endsAt: 0,
        timer: null,
      };
      rooms.set(room.code, room);
    } else {
      room = rooms.get(String(data.code || '').trim().toUpperCase());
      if (!room) return socket.emit('joinError', 'Room not found. Check the code.');
    }

    if (room.banned.has(playerId)) return socket.emit('joinError', 'You were banned from this room.');

    let p = room.players.get(playerId);
    if (p) {
      // Reconnect: the player keeps their seat, score, and turn.
      clearTimeout(p.graceTimer);
      p.connected = true;
      p.socketId = socket.id;
    } else {
      if (room.players.size >= MAX_PLAYERS) return socket.emit('joinError', 'This room is full.');
      p = {
        id: playerId,
        name,
        score: 0,
        socketId: socket.id,
        connected: true,
        graceTimer: null,
        muted: new Set(),
      };
      room.players.set(playerId, p);
      if (room.state !== 'lobby' && room.state !== 'over') room.order.push(playerId);
    }

    socket.data = { code: room.code, playerId };
    socket.emit('joined', { code: room.code, playerId, isOwner: room.owner === playerId });
    socket.emit('strokes', room.strokes);
    syncRoom(room);
  });

  socket.on('leave', () => {
    const room = getRoom(socket);
    if (room) removePlayer(room, socket.data.playerId);
    socket.data = {};
  });

  socket.on('settings', (data = {}) => {
    const room = getRoom(socket);
    if (!room || room.owner !== socket.data.playerId) return;
    if (room.state !== 'lobby' && room.state !== 'over') return;
    room.rounds = Math.min(5, Math.max(1, parseInt(data.rounds, 10) || 3));
    syncRoom(room);
  });

  socket.on('start', () => {
    const room = getRoom(socket);
    if (!room || room.owner !== socket.data.playerId) return;
    if (room.state !== 'lobby' && room.state !== 'over') return;
    if (onlinePlayers(room).length < 2) {
      return socket.emit('notice', 'You need at least 2 players to start.');
    }
    startGame(room);
  });

  socket.on('choose', word => {
    const room = getRoom(socket);
    if (!room || room.state !== 'choosing' || socket.data.playerId !== room.drawerId) return;
    if (!room.choices.includes(word)) return;
    chooseWord(room, word);
  });

  socket.on('stroke', seg => {
    const room = getRoom(socket);
    if (!room || room.state !== 'drawing' || socket.data.playerId !== room.drawerId) return;
    const clean = cleanSegment(seg);
    if (!clean) return;
    if (room.strokes.length < 20000) room.strokes.push(clean);
    broadcast(room, 'stroke', clean, room.drawerId);
  });

  socket.on('clear', () => {
    const room = getRoom(socket);
    if (!room || room.state !== 'drawing' || socket.data.playerId !== room.drawerId) return;
    room.strokes = [];
    broadcast(room, 'clear', {});
  });

  socket.on('guess', text => {
    const room = getRoom(socket);
    const me = room && room.players.get(socket.data.playerId);
    if (!me) return;
    const msg = String(text || '').trim().slice(0, 80);
    if (!msg) return;

    if (room.state === 'drawing' && room.word) {
      const correct = msg.toLowerCase() === room.word.toLowerCase();
      if (correct && me.id !== room.drawerId && !room.guessed.has(me.id)) {
        room.guessed.add(me.id);
        const secondsLeft = Math.max(0, room.endsAt - Date.now()) / 1000;
        const points = 100 + Math.round(secondsLeft * 2);
        me.score += points;
        const drawer = room.players.get(room.drawerId);
        if (drawer) drawer.score += 25;
        sendTo(room, me.id, 'correct', { points });
        broadcast(room, 'system', { text: `${me.name} guessed the word!` });
        syncRoom(room);
        if (allGuessed(room)) endTurn(room);
        return;
      }
      // Never let the answer appear in chat during a turn.
      if (correct) return;
    }

    broadcast(room, 'chat', { name: me.name, text: msg, from: me.id }, me.id);
  });

  socket.on('kick', id => moderate(socket, id, false));
  socket.on('ban', id => moderate(socket, id, true));

  socket.on('mute', ({ id, on } = {}) => {
    const room = getRoom(socket);
    const me = room && room.players.get(socket.data.playerId);
    if (!me || !id) return;
    if (on) me.muted.add(String(id));
    else me.muted.delete(String(id));
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    const p = room && room.players.get(socket.data.playerId);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.graceTimer = setTimeout(() => removePlayer(room, p.id), GRACE_MS);
    syncRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`Doodle Room is running on port ${PORT}`);
});
