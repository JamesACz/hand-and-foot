'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const webpush = require('web-push');
const { Game, GameError } = require('./game');
const { createStore } = require('./storage');

const PORT = process.env.PORT || 3000;
const SEAT_NAMES = ['North', 'East', 'South', 'West'];
const ROOM_TTL_MS = 45 * 24 * 60 * 60 * 1000;   // forget games untouched for 45 days
const CHAT_PUSH_GAP_MS = 10 * 60 * 1000;       // at most one chat notification per player per 10 min
const META_KEY = '_meta';

const store = createStore();
const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  // always check for a newer copy, so phones pick up updates straight away
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
}));
app.get('/health', (_req, res) => res.send('ok'));
let vapidPublic = null;
app.get('/vapid-public-key', (_req, res) => res.type('text').send(vapidPublic || ''));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

/** code -> room. Runtime-only fields on players: socketId, visible, lastChatPush */
const rooms = new Map();

// ---------- persistence ----------
function serialize(room) {
  return {
    code: room.code,
    hostToken: room.hostToken,
    lastActive: room.lastActive,
    chat: room.chat,
    players: room.players.map((p) => ({ token: p.token, name: p.name, seat: p.seat, subs: p.subs || [], lastSeen: p.lastSeen || null })),
    game: room.game,
  };
}
function revive(data) {
  return {
    code: data.code,
    hostToken: data.hostToken,
    lastActive: data.lastActive || Date.now(),
    chat: data.chat || [],
    players: (data.players || []).map((p) => ({ ...p, subs: p.subs || [], socketId: null, visible: false })),
    game: data.game ? Game.restore(data.game) : null,
  };
}
const saveTimers = new Map();
function scheduleSave(room) {
  clearTimeout(saveTimers.get(room.code));
  saveTimers.set(room.code, setTimeout(() => {
    saveTimers.delete(room.code);
    store.save(room.code, serialize(room)).catch((e) => console.error('save failed', room.code, e.message));
  }, 250));
}
async function flushSaves() {
  const pending = [...saveTimers.keys()];
  for (const code of pending) {
    clearTimeout(saveTimers.get(code));
    saveTimers.delete(code);
    const room = rooms.get(code);
    if (room) await store.save(code, serialize(room)).catch((e) => console.error('save failed', code, e.message));
  }
}

// ---------- notifications ----------
async function setupPush(meta) {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    if (meta && meta.vapid) ({ publicKey: pub, privateKey: priv } = meta.vapid);
    else {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey; priv = keys.privateKey;
      await store.save(META_KEY, { meta: true, vapid: keys }).catch((e) => console.error('could not save push keys', e.message));
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:hand-and-foot@example.com', pub, priv);
  vapidPublic = pub;
}

const isAway = (p) => !p.socketId || !p.visible;

function pushTo(room, p, payload) {
  if (!p.subs || !p.subs.length) return;
  const body = JSON.stringify({ url: `/?room=${room.code}`, ...payload });
  for (const sub of p.subs.slice()) {
    webpush.sendNotification(sub, body, { TTL: 24 * 3600, urgency: 'normal' }).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        p.subs = p.subs.filter((s) => s.endpoint !== sub.endpoint);
        broadcast(room);
      } else console.error('push failed', err.statusCode || err.message);
    });
  }
}

/** Compare game state before/after an action and notify whoever needs to know. */
function notifyAfterAction(room, before) {
  const g = room.game;
  if (!g) return;
  const lastText = g.log.length ? g.log[g.log.length - 1].text : '';
  if ((g.phase === 'roundEnd' || g.phase === 'gameOver') && before.phase === 'playing') {
    const r = g.lastRound;
    for (const p of room.players) {
      if (!isAway(p)) continue;
      const us = r.totals[p.seat % 2], them = r.totals[1 - (p.seat % 2)];
      pushTo(room, p, {
        title: g.phase === 'gameOver' ? 'Hand & Foot — game over' : `Hand & Foot — round ${r.round} over`,
        body: `${lastText} Score: you ${us}, them ${them}.`,
        tag: `round-${room.code}`,
      });
    }
    return;
  }
  if (g.phase === 'playing' && (g.turn !== before.turn || g.round !== before.round || before.phase !== 'playing')) {
    const p = room.players.find((x) => x.seat === g.turn);
    if (p && isAway(p)) pushTo(room, p, { title: "Your turn in Hand & Foot", body: lastText, tag: `turn-${room.code}` });
  }
}

function notifyGoOut(room, type) {
  const g = room.game;
  const a = g && g.goOutAsk;
  if (!a) return;
  const partnerSeat = (a.seat + 2) % 4;
  const target = room.players.find((x) => x.seat === (type === 'askGoOut' ? partnerSeat : a.seat));
  if (!target || !isAway(target)) return;
  if (type === 'askGoOut') {
    pushTo(room, target, { title: 'Hand & Foot — your partner is asking', body: `${g.names[a.seat]} asks: "May I go out?" Tap to answer.`, tag: `goout-${room.code}` });
  } else {
    pushTo(room, target, { title: `${g.names[partnerSeat]} said ${a.status === 'yes' ? 'yes' : 'no'}`, body: a.status === 'yes' ? 'You can go out this turn.' : "You can't go out this turn.", tag: `goout-${room.code}` });
  }
}

function notifyChat(room, from, text) {
  const now = Date.now();
  for (const p of room.players) {
    if (p === from || !isAway(p)) continue;
    if (p.lastChatPush && now - p.lastChatPush < CHAT_PUSH_GAP_MS) continue;
    p.lastChatPush = now;
    pushTo(room, p, { title: `${from.name} (Hand & Foot chat)`, body: text, tag: `chat-${room.code}` });
  }
}

// ---------- rooms ----------
function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sysChat(room, text) {
  room.chat.push({ sys: true, text, ts: Date.now() });
  if (room.chat.length > 300) room.chat.shift();
}

function roomView(room, me) {
  return {
    code: room.code,
    you: { name: me.name, seat: me.seat, isHost: room.hostToken === me.token },
    seats: SEAT_NAMES.map((label, s) => {
      const p = room.players.find((x) => x.seat === s);
      return {
        label,
        name: p ? p.name : null,
        connected: p ? !isAway(p) : false,
        lastSeen: p ? p.lastSeen : null,
        notify: p ? p.subs.length > 0 : false,
        isHost: p ? room.hostToken === p.token : false,
      };
    }),
    lobby: room.players.map((p) => ({ name: p.name, seat: p.seat })),
    chat: room.chat.slice(-150),
    game: room.game ? room.game.view(me.seat) : null,
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', roomView(room, p));
  }
  scheduleSave(room);
}

const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

io.on('connection', (socket) => {
  let room = null;
  let me = null;
  const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };

  socket.on('join', (msg = {}, ack) => {
    const name = clean(msg.name, 20);
    if (!name) return reply(ack, { error: 'Enter your name.' });
    let r;
    if (msg.code) {
      r = rooms.get(clean(msg.code, 8).toUpperCase());
      if (!r) return reply(ack, { error: 'No game with that code. Check it, or create a new game.' });
    } else {
      r = { code: newCode(), players: [], chat: [], game: null, hostToken: null, lastActive: Date.now() };
      rooms.set(r.code, r);
    }
    // 1) same device coming back (token)  2) same person on another device/app (same name)
    let p = msg.token ? r.players.find((x) => x.token === msg.token) : null;
    if (!p) p = r.players.find((x) => sameName(x.name, name)) || null;
    if (p) {
      if (p.socketId && p.socketId !== socket.id) io.to(p.socketId).emit('kicked', 'You opened this game on another device or app.');
      p.socketId = socket.id;
      p.visible = true;
      p.lastSeen = Date.now();
      if (!r.game) p.name = name;
    } else {
      if (r.game) return reply(ack, { error: `That game has already started. To rejoin, use exactly the name you played under (${r.players.map((x) => x.name).join(', ')}).` });
      if (r.players.length >= 4) return reply(ack, { error: 'That game already has 4 players.' });
      const taken = new Set(r.players.map((x) => x.seat));
      const seat = [0, 1, 2, 3].find((s) => !taken.has(s));
      p = { token: crypto.randomUUID(), name, seat, subs: [], socketId: socket.id, visible: true, lastSeen: Date.now() };
      r.players.push(p);
      if (!r.hostToken) r.hostToken = p.token;
      sysChat(r, `${name} joined.`);
    }
    room = r;
    me = p;
    reply(ack, { ok: true, code: r.code, token: p.token, name: p.name });
    broadcast(room);
  });

  socket.on('visible', (msg = {}) => {
    if (!room || !me || me.socketId !== socket.id) return;
    const v = !!msg.visible;
    if (v === me.visible) return;
    me.visible = v;
    me.lastSeen = Date.now();
    broadcast(room);
  });

  socket.on('push-subscribe', (msg = {}, ack) => {
    if (!room || !me) return reply(ack, { error: 'Join a game first.' });
    const sub = msg.sub;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return reply(ack, { error: 'Bad subscription.' });
    // a device belongs to one seat: remove it from anyone else in this room first
    for (const other of room.players) if (other !== me) other.subs = (other.subs || []).filter((s) => s.endpoint !== sub.endpoint);
    me.subs = (me.subs || []).filter((s) => s.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, keys: sub.keys }]).slice(-5);
    reply(ack, { ok: true });
    broadcast(room);
  });

  socket.on('push-unsubscribe', (msg = {}, ack) => {
    if (!room || !me) return;
    me.subs = (me.subs || []).filter((s) => s.endpoint !== msg.endpoint);
    reply(ack, { ok: true });
    broadcast(room);
  });

  socket.on('push-test', (_msg, ack) => {
    if (!room || !me) return;
    pushTo(room, me, { title: 'Hand & Foot', body: "Notifications are working. You'll hear from us when it's your turn.", tag: 'test' });
    reply(ack, { ok: true });
  });

  socket.on('sit', (msg = {}, ack) => {
    if (!room || !me) return;
    if (room.game) return reply(ack, { error: 'The game has started.' });
    const seat = Number(msg.seat);
    if (![0, 1, 2, 3].includes(seat)) return;
    const other = room.players.find((x) => x.seat === seat && x !== me);
    if (other) other.seat = me.seat; // swap seats
    me.seat = seat;
    reply(ack, { ok: true });
    broadcast(room);
  });

  socket.on('leave', () => {
    if (!room || !me || room.game) return;
    const r = room;
    r.players = r.players.filter((x) => x !== me);
    sysChat(r, `${me.name} left.`);
    if (r.hostToken === me.token) r.hostToken = r.players[0] ? r.players[0].token : null;
    if (!r.players.length) { rooms.delete(r.code); store.remove(r.code).catch(() => {}); } else broadcast(r);
    room = null;
    me = null;
  });

  socket.on('start', (_msg, ack) => {
    if (!room || !me) return;
    if (room.hostToken !== me.token) return reply(ack, { error: 'Only the host can start the game.' });
    if (room.players.length !== 4) return reply(ack, { error: 'You need 4 players to start.' });
    if (room.game && room.game.phase !== 'gameOver') return reply(ack, { error: 'A game is already running.' });
    const names = [0, 1, 2, 3].map((s) => room.players.find((x) => x.seat === s).name);
    const before = { phase: 'lobby', turn: -1, round: -1 };
    room.game = new Game(names);
    sysChat(room, `Game started: ${names[0]} & ${names[2]} vs ${names[1]} & ${names[3]}.`);
    reply(ack, { ok: true });
    broadcast(room);
    notifyAfterAction(room, before);
  });

  socket.on('action', (msg = {}, ack) => {
    if (!room || !me || !room.game) return reply(ack, { error: 'No game running.' });
    const g = room.game;
    const before = { phase: g.phase, turn: g.turn, round: g.round };
    try {
      switch (msg.type) {
        case 'draw': g.draw(me.seat); break;
        case 'pickup': g.pickup(me.seat, msg.pair, msg.plan); break;
        case 'meld': g.meld(me.seat, msg.plan); break;
        case 'discard': g.discardCard(me.seat, msg.cardId); break;
        case 'askGoOut': g.askGoOut(me.seat); break;
        case 'answerGoOut': g.answerGoOut(me.seat, !!msg.yes); break;
        case 'nextRound': g.nextRound(); break;
        case 'newGame':
          if (g.phase !== 'gameOver') throw new GameError('The game is still going.');
          room.game = new Game(g.names);
          before.phase = 'lobby';
          sysChat(room, 'New game started.');
          break;
        default: throw new GameError('Unknown action.');
      }
      reply(ack, { ok: true });
      broadcast(room);
      notifyAfterAction(room, before);
      if (msg.type === 'askGoOut' || msg.type === 'answerGoOut') notifyGoOut(room, msg.type);
    } catch (e) {
      if (!(e instanceof GameError)) console.error('action error', msg, e);
      reply(ack, { error: e instanceof GameError ? e.message : 'Something went wrong with that move.' });
    }
  });

  socket.on('chat', (msg = {}) => {
    if (!room || !me) return;
    const text = clean(msg.text, 300);
    if (!text) return;
    room.chat.push({ name: me.name, seat: me.seat, text, ts: Date.now() });
    if (room.chat.length > 300) room.chat.shift();
    broadcast(room);
    notifyChat(room, me, text);
  });

  socket.on('disconnect', () => {
    if (!room || !me || me.socketId !== socket.id) return;
    me.socketId = null;
    me.visible = false;
    me.lastSeen = Date.now();
    broadcast(room);
  });
});

// ---------- startup ----------
async function init() {
  const saved = await store.loadAll();
  const meta = saved.find((d) => d.meta);
  const now = Date.now();
  for (const d of saved) {
    if (d.meta || !d.code) continue;
    if (now - (d.lastActive || 0) > ROOM_TTL_MS) { store.remove(d.code).catch(() => {}); continue; }
    try { rooms.set(d.code, revive(d)); } catch (e) { console.error('could not restore room', d.code, e.message); }
  }
  await setupPush(meta);
  console.log(`Storage: ${store.name}. Restored ${rooms.size} game${rooms.size === 1 ? '' : 's'}.`);
}

// Forget games nobody has touched for a long time
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (now - r.lastActive > ROOM_TTL_MS) { rooms.delete(code); store.remove(code).catch(() => {}); }
}, 6 * 60 * 60 * 1000).unref();

// Save everything before the host shuts us down (Render does this before sleeping/redeploying)
async function shutdown(sig) {
  console.log(`${sig}: saving games…`);
  await flushSaves();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const ready = init();
if (require.main === module) {
  ready.then(() => server.listen(PORT, () => console.log(`Hand and Foot running on http://localhost:${PORT}`)))
    .catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}

module.exports = { server, rooms, ready, flushSaves };
