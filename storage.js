'use strict';
/*
 * Where games are saved between visits.
 *  - DATABASE_URL set  -> Postgres (e.g. a free Neon database) — use this on Render
 *  - otherwise         -> JSON files in DATA_DIR (default ./data) — fine for your own computer / home server
 */
const fs = require('fs');
const path = require('path');

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, key.replace(/[^A-Za-z0-9_-]/g, '') + '.json');
  return {
    name: `files in ${dir}`,
    async loadAll() {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
        .filter(Boolean);
    },
    async save(key, data) {
      const tmp = file(key) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file(key));
    },
    async remove(key) { try { fs.unlinkSync(file(key)); } catch { /* already gone */ } },
  };
}

function pgStore(url, PoolImpl) {
  const Pool = PoolImpl || require('pg').Pool;
  const local = /localhost|127\.0\.0\.1/.test(url || '');
  const pool = new Pool({ connectionString: url, ssl: local || !url ? false : { rejectUnauthorized: false }, max: 3 });
  const ready = pool.query(`CREATE TABLE IF NOT EXISTS hf_rooms (
    key text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  return {
    name: 'postgres',
    async loadAll() {
      await ready;
      const r = await pool.query('SELECT data FROM hf_rooms');
      return r.rows.map((x) => (typeof x.data === 'string' ? JSON.parse(x.data) : x.data));
    },
    async save(key, data) {
      await ready;
      await pool.query(
        'INSERT INTO hf_rooms (key, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
        [key, JSON.stringify(data)],
      );
    },
    async remove(key) {
      await ready;
      await pool.query('DELETE FROM hf_rooms WHERE key = $1', [key]);
    },
  };
}

function createStore(opts = {}) {
  const url = opts.databaseUrl !== undefined ? opts.databaseUrl : process.env.DATABASE_URL;
  if (url || opts.Pool) return pgStore(url, opts.Pool);
  return fileStore(opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
}

module.exports = { createStore };
