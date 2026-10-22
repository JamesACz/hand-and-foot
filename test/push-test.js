'use strict';
// Verifies the server sends a push notification to a player when it becomes their turn while they're away.
// A local HTTP server stands in for Apple's/Google's push service.
const assert = require('assert');
const https = require('https');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // test-only: self-signed fake push service
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { io } = require('socket.io-client');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-push-'));
delete process.env.DATABASE_URL;
const { server, ready } = require('../server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));

(async () => {
  await ready;
  const received = [];
  const tls = { key: fs.readFileSync(path.join(__dirname, 'certs/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'certs/cert.pem')) };
  const pushSvc = https.createServer(tls, (req, res) => {
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => { received.push({ path: req.url, bytes: n, enc: req.headers['content-encoding'] }); res.statusCode = 201; res.end(); });
  });
  await new Promise((r) => pushSvc.listen(0, r));
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const pushBase = `https://localhost:${pushSvc.address().port}`;

  const fakeSub = (who) => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { endpoint: `${pushBase}/${who}`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  };

  const names = ['James', 'Kate', 'Sam', 'Mia'];
  const cs = [];
  let code;
  for (const n of names) {
    const c = io(url, { transports: ['websocket'], forceNew: true });
    c.last = null;
    c.on('state', (s) => { c.last = s; });
    await new Promise((r) => c.on('connect', r));
    const res = await emit(c, 'join', { name: n, code });
    code = res.code;
    assert((await emit(c, 'push-subscribe', { sub: fakeSub(n) })).ok);
    cs.push(c);
  }
  await wait(50);
  assert(cs[0].last.seats.every((s) => s.notify), 'everyone shows notifications on');

  // Kate (seat 1) puts her phone away
  cs[1].emit('visible', { visible: false });
  await wait(30);
  assert((await emit(cs[0], 'start', {})).ok);
  await wait(30);
  received.length = 0;
  // James (seat 0, first turn) plays; turn moves to Kate who is away → she gets a push
  assert((await emit(cs[0], 'action', { type: 'draw' })).ok);
  await wait(30);
  assert((await emit(cs[0], 'action', { type: 'discard', cardId: cs[0].last.game.hand[0].id })).ok);
  await wait(400);
  assert.deepStrictEqual(received.map((r) => r.path), ['/Kate'], 'only Kate notified');
  assert.strictEqual(received[0].enc, 'aes128gcm', 'payload is encrypted');

  // chat while Kate is away → she gets one chat push; repeated chat is throttled
  received.length = 0;
  cs[2].emit('chat', { text: 'your go Kate!' });
  await wait(200);
  cs[2].emit('chat', { text: 'hello??' });
  await wait(300);
  assert.deepStrictEqual(received.map((r) => r.path), ['/Kate'], 'one chat push, throttled');

  // Kate comes back: no more pushes to her while she's looking
  cs[1].emit('visible', { visible: true });
  received.length = 0;
  cs[2].emit('chat', { text: 'there you are' });
  await wait(300);
  assert.strictEqual(received.length, 0, 'no push while visible');

  // dead subscription (410) is removed
  pushSvc.removeAllListeners('request');
  pushSvc.on('request', (req, res) => { req.resume(); req.on('end', () => { res.statusCode = 410; res.end(); }); });
  cs[1].emit('visible', { visible: false });
  await wait(30);
  const kate = cs[1];
  assert((await emit(kate, 'action', { type: 'draw' })).ok);
  await wait(30);
  assert((await emit(kate, 'action', { type: 'discard', cardId: kate.last.game.hand[0].id })).ok);
  // Sam (seat 2) is visible → no push; make Sam away first for the 410 path
  await wait(50);
  cs[2].emit('visible', { visible: false });
  await wait(30);
  cs[3].emit('chat', { text: 'ping' });
  await wait(400);
  assert.strictEqual(cs[0].last.seats[2].notify, false, 'expired subscription dropped');

  console.log('push test OK');
  cs.forEach((c) => c.close());
  server.close(); pushSvc.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
