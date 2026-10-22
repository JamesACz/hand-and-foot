'use strict';
// Spins up the server and connects 4 clients: create/join, chat, start, play turns, reconnect.
const assert = require('assert');
const { io } = require('socket.io-client');
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'));
delete process.env.DATABASE_URL;
const { server, rooms, ready } = require('../server');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const nextState = (s) => new Promise((res) => s.once('state', res));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const names = ['James', 'Kate', 'Sam', 'Mia'];
  const clients = names.map(() => io(url, { transports: ['websocket'], forceNew: true }));
  const latest = clients.map(() => null);
  clients.forEach((c, i) => c.on('state', (st) => { latest[i] = st; }));
  await Promise.all(clients.map((c) => new Promise((r) => c.on('connect', r))));

  const created = await emit(clients[0], 'join', { name: 'James' });
  assert(created.ok && created.code.length === 4, 'create');
  const tokens = [created.token];
  for (let i = 1; i < 4; i++) {
    const r = await emit(clients[i], 'join', { name: names[i], code: created.code.toLowerCase() });
    assert(r.ok, 'join ' + i);
    tokens.push(r.token);
  }
  const fifth = io(url, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => fifth.on('connect', r));
  const full = await emit(fifth, 'join', { name: 'Extra', code: created.code });
  assert(/4 players/.test(full.error), 'room full');
  fifth.close();

  // seat swap: Kate (seat 1) moves to seat 2, Sam goes to 1
  await emit(clients[1], 'sit', { seat: 2 });
  await wait(50);
  assert.strictEqual(latest[0].seats[2].name, 'Kate');
  assert.strictEqual(latest[0].seats[1].name, 'Sam');

  // non-host can't start
  const bad = await emit(clients[1], 'start', {});
  assert(bad.error, 'non-host start blocked');
  const ok = await emit(clients[0], 'start', {});
  assert(ok.ok, 'start');
  await wait(50);

  // privacy: each client only sees their own hand
  const handIds = latest.map((st) => st.game.hand.map((c) => c.id));
  assert(handIds.every((h) => h.length === 11), 'hands of 11');
  const all = new Set(handIds.flat());
  assert.strictEqual(all.size, 44, 'hands are distinct');

  // chat
  clients[2].emit('chat', { text: '  good luck <b>all</b>  ' });
  await wait(50);
  const last = latest[0].chat[latest[0].chat.length - 1];
  assert.strictEqual(last.text, 'good luck <b>all</b>');
  assert.strictEqual(last.name, 'Sam');

  // play a few turns: whoever's turn draws and discards
  const seatOf = (i) => latest[i].you.seat;
  for (let k = 0; k < 8; k++) {
    const turn = latest[0].game.turn;
    const i = latest.findIndex((st, idx) => seatOf(idx) === turn);
    const notMe = latest.findIndex((st, idx) => seatOf(idx) !== turn);
    const wrong = await emit(clients[notMe], 'action', { type: 'draw' });
    assert(/not your turn/.test(wrong.error), 'turn enforced');
    assert((await emit(clients[i], 'action', { type: 'draw' })).ok, 'draw');
    await wait(30);
    const card = latest[i].game.hand[0];
    assert((await emit(clients[i], 'action', { type: 'discard', cardId: card.id })).ok, 'discard');
    await wait(30);
  }
  assert(latest[0].game.discardCount >= 8);

  // reconnect: Mia drops and rejoins with her token, keeps her seat and hand
  const miaSeat = latest[3].you.seat;
  const miaHand = latest[3].game.hand.map((c) => c.id).sort().join();
  clients[3].close();
  await wait(80);
  assert.strictEqual(latest[0].seats[miaSeat].connected, false, 'shows offline');
  const mia2 = io(url, { transports: ['websocket'], forceNew: true });
  let mia2State = null;
  mia2.on('state', (s) => { mia2State = s; });
  await new Promise((r) => mia2.on('connect', r));
  const rj = await emit(mia2, 'join', { name: 'Mia', code: created.code, token: tokens[3] });
  assert(rj.ok, 'rejoin');
  await wait(50);
  assert.strictEqual(mia2State.you.seat, miaSeat);
  assert.strictEqual(mia2State.game.hand.map((c) => c.id).sort().join(), miaHand, 'hand kept');
  assert.strictEqual(latest[0].seats[miaSeat].connected, true, 'back online');

  // name reclaim: Sam opens the game on another device with no token (e.g. iPhone home-screen app)
  const samSeat = latest[2].you.seat;
  const sam2 = io(url, { transports: ['websocket'], forceNew: true });
  let sam2State = null;
  sam2.on('state', (s) => { sam2State = s; });
  await new Promise((r) => sam2.on('connect', r));
  const kicked = new Promise((r) => clients[2].once('kicked', r));
  const rc = await emit(sam2, 'join', { name: '  sam ', code: created.code });
  assert(rc.ok && rc.token === tokens[2], 'reclaim by name gives same token');
  await kicked;
  await wait(50);
  assert.strictEqual(sam2State.you.seat, samSeat, 'reclaimed seat');
  const stranger = await emit(sam2, 'join', { name: 'Bob', code: created.code });
  assert(/already started/.test(stranger.error), 'new names blocked after start');
  sam2.close();

  // saved to disk
  const { flushSaves } = require('../server');
  await flushSaves();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, created.code + '.json'), 'utf8'));
  assert.strictEqual(saved.players.length, 4);
  assert(saved.game && saved.game.players.length === 4, 'game saved');

  console.log('socket test OK — room', created.code, '| rooms in memory:', rooms.size);
  clients.forEach((c) => c.close());
  mia2.close();
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
