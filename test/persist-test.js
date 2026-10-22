'use strict';
// Starts the real server as a separate process, plays a bit, kills it, restarts it, and checks the game survived.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-persist-'));
const PORT = 3200 + Math.floor(Math.random() * 500);
const url = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));

function startServer() {
  const env = { ...process.env, PORT, DATA_DIR: dataDir };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    child.stdout.on('data', (d) => { if (/running on/.test(String(d))) resolve(child); });
  });
}
async function connect(name, code) {
  const c = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  c.last = null;
  c.on('state', (s) => { c.last = s; });
  await new Promise((r) => c.on('connect', r));
  const res = await emit(c, 'join', { name, code });
  assert(res.ok, 'join ' + name + ' ' + JSON.stringify(res));
  await wait(40);
  return c;
}

(async () => {
  let srv = await startServer();
  const names = ['James', 'Kate', 'Sam', 'Mia'];
  const first = await connect('James');
  const code = first.last.code;
  const cs = [first];
  for (const n of names.slice(1)) cs.push(await connect(n, code));
  assert((await emit(cs[0], 'start', {})).ok);
  await wait(50);
  // seat 0 draws and discards; then seat 1 draws (mid-turn when the server dies)
  const bySeat = (s) => cs.find((c) => c.last.you.seat === s);
  assert((await emit(bySeat(0), 'action', { type: 'draw' })).ok);
  await wait(30);
  const c0 = bySeat(0).last.game.hand[0];
  assert((await emit(bySeat(0), 'action', { type: 'discard', cardId: c0.id })).ok);
  await wait(30);
  assert((await emit(bySeat(1), 'action', { type: 'draw' })).ok);
  cs[2].emit('chat', { text: 'back after lunch' });
  await wait(100);
  const before = cs.map((c) => c.last.game.hand.map((x) => x.id).sort().join());
  const beforeTop = cs[0].last.game.discardTop.id;

  srv.kill('SIGTERM');
  await new Promise((r) => srv.on('exit', r));
  cs.forEach((c) => c.close());

  srv = await startServer();
  const again = [];
  for (const n of names) again.push(await connect(n, code));  // no tokens: rejoin by name
  const g = again[0].last.game;
  assert(g, 'game restored');
  assert.strictEqual(g.turn, 1, 'still seat 1');
  assert.strictEqual(g.turnPhase, 'play', 'still mid-turn');
  assert.strictEqual(g.discardTop.id, beforeTop, 'discard pile kept');
  again.forEach((c, i) => assert.strictEqual(c.last.game.hand.map((x) => x.id).sort().join(), before[i], 'hand kept for ' + names[i]));
  assert(again[0].last.chat.some((m) => m.text === 'back after lunch'), 'chat kept');
  // and play continues
  const s1 = again.find((c) => c.last.you.seat === 1);
  assert((await emit(s1, 'action', { type: 'discard', cardId: s1.last.game.hand[0].id })).ok, 'continue playing');
  await wait(50);
  assert.strictEqual(again[0].last.game.turn, 2);

  again.forEach((c) => c.close());
  srv.kill('SIGTERM');
  console.log('persist test OK — game', code, 'survived a restart');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
