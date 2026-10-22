'use strict';
// Checks the Postgres storage code against an in-memory Postgres.
const assert = require('assert');
const { newDb } = require('pg-mem');
const { createStore } = require('../storage');
const { Game } = require('../game');

(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const store = createStore({ Pool, databaseUrl: 'postgres://test' });
  const g = new Game(['A', 'B', 'C', 'D']);
  g.draw(g.turn);
  await store.save('ABCD', { code: 'ABCD', game: g, players: [], chat: [] });
  await store.save('ABCD', { code: 'ABCD', game: g, players: [{ name: 'x' }], chat: [] }); // upsert
  await store.save('_meta', { meta: true, vapid: { publicKey: 'p', privateKey: 'q' } });
  const all = await store.loadAll();
  assert.strictEqual(all.length, 2);
  const room = all.find((d) => d.code === 'ABCD');
  assert.strictEqual(room.players.length, 1);
  const g2 = Game.restore(room.game);
  assert.strictEqual(g2.view(g2.turn).hand.length, 13);
  g2.discardCard(g2.turn, g2.players[g2.turn].hand[0].id); // restored game still plays
  await store.remove('ABCD');
  assert.strictEqual((await store.loadAll()).length, 1);
  console.log('postgres storage test OK');
})().catch((e) => { console.error(e); process.exit(1); });
