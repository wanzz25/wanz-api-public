'use strict';
const fs = require('fs');
const path = require('path');

const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const useRedis = !!(UP_URL && UP_TOKEN);

// ---------- Redis (Upstash REST) ----------
async function call(body, pipeline) {
  const axios = require('axios');
  const r = await axios.post(pipeline ? UP_URL + '/pipeline' : UP_URL, body, {
    headers: { Authorization: 'Bearer ' + UP_TOKEN },
    timeout: 8000
  });
  return r.data;
}
async function cmd(...args) {
  const d = await call(args, false);
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function pipe(cmds) {
  const d = await call(cmds, true);
  return d.map(x => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

const redisStore = {
  async getUserBySub(sub) {
    const v = await cmd('GET', 'wanz:user:' + sub);
    return v ? JSON.parse(v) : null;
  },
  async getUserByKey(key) {
    const sub = await cmd('GET', 'wanz:key:' + key);
    return sub ? redisStore.getUserBySub(sub) : null;
  },
  async saveUser(user) {
    await pipe([
      ['SET', 'wanz:user:' + user.sub, JSON.stringify(user)],
      ['SET', 'wanz:key:' + user.apikey, user.sub]
    ]);
  },
  async rotateKey(user, newKey) {
    const old = user.apikey;
    user.apikey = newKey;
    await pipe([
      ['SET', 'wanz:user:' + user.sub, JSON.stringify(user)],
      ['SET', 'wanz:key:' + newKey, user.sub],
      ['DEL', 'wanz:key:' + old]
    ]);
    return user;
  },
  async incrUsage(id, day) {
    const k = `wanz:usage:${id}:${day}`;
    const r = await pipe([['INCR', k], ['EXPIRE', k, 172800]]);
    return Number(r[0]);
  },
  async getUsage(id, day) {
    return Number((await cmd('GET', `wanz:usage:${id}:${day}`)) || 0);
  }
};

// ---------- File JSON ----------
const DB_FILE = process.env.DB_FILE ||
  path.join(process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'data'), 'db.json');
let db = { users: {}, keys: {}, usage: {} };
let timer = null;

function load() {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (_) {}
}
function flushSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      const minDay = new Date(Date.now() + 7 * 3600e3 - 2 * 86400e3).toISOString().slice(0, 10);
      for (const k of Object.keys(db.usage)) if (k.split('|')[1] < minDay) delete db.usage[k];
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    } catch (e) { console.error('DB flush gagal:', e.message); }
  }, 1500);
  if (timer.unref) timer.unref();
}

const fileStore = {
  async getUserBySub(sub) { return db.users[sub] || null; },
  async getUserByKey(key) { return db.users[db.keys[key]] || null; },
  async saveUser(user) {
    db.users[user.sub] = user;
    db.keys[user.apikey] = user.sub;
    flushSoon();
  },
  async rotateKey(user, newKey) {
    delete db.keys[user.apikey];
    user.apikey = newKey;
    db.users[user.sub] = user;
    db.keys[newKey] = user.sub;
    flushSoon();
    return user;
  },
  async incrUsage(id, day) {
    const k = id + '|' + day;
    db.usage[k] = (db.usage[k] || 0) + 1;
    flushSoon();
    return db.usage[k];
  },
  async getUsage(id, day) { return db.usage[id + '|' + day] || 0; }
};

if (!useRedis) {
  load();
  if (process.env.VERCEL) {
    console.warn('[store] Vercel tanpa Upstash/KV: data akun HILANG tiap redeploy/cold start. Set UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN.');
  }
}

module.exports = Object.assign({ mode: useRedis ? 'redis' : 'file', DB_FILE }, useRedis ? redisStore : fileStore);
