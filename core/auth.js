'use strict';
const crypto = require('crypto');
const store = require('./store');

const DAILY_LIMIT = Math.max(1, parseInt(process.env.DAILY_LIMIT, 10) || 500);
const DEV_KEY = process.env.DEV_API_KEY || 'WanzzGantengBanget3369';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const INTERNAL_KEY = crypto.randomBytes(24).toString('hex'); // dipakai plugin lama, tidak pernah keluar server

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET belum di-set: login akan hilang tiap server restart.');
}

const KEY_RE = /^Api-[A-Za-z0-9]{8,40}-wanz$/;
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const COOKIE = 'wanz_session';
const SESSION_TTL = 30 * 24 * 3600;
const OPEN_PATHS = new Set(['/api/', '/api/logo-proxy', '/api/stats']);

// ---------- util ----------
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const b64u = s => Buffer.from(s).toString('base64url');
const hmac = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');

function generateApiKey() {
  let s;
  do {
    s = Array.from({ length: 16 }, () => ALNUM[crypto.randomInt(ALNUM.length)]).join('');
  } while (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)); // wajib ada huruf dan angka
  return `Api-${s}-wanz`;
}
async function uniqueKey() {
  for (let i = 0; i < 5; i++) {
    const k = generateApiKey();
    if (!(await store.getUserByKey(k))) return k;
  }
  throw new Error('Gagal membuat apikey unik');
}

// Hari limit mengikuti WIB (UTC+7), reset 00:00 WIB
const wibNow = () => Date.now() + 7 * 3600e3;
const today = () => new Date(wibNow()).toISOString().slice(0, 10);
const secondsToReset = () => Math.ceil(((Math.floor(wibNow() / 86400e3) + 1) * 86400e3 - wibNow()) / 1000);

// ---------- session ----------
function signSession(sub) {
  const body = b64u(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }));
  return body + '.' + hmac(body);
}
function readSession(req) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch (_) { return null; }
}
function setCookie(req, res, value, maxAge) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);
}

// ---------- Google ----------
async function defaultVerifier(idToken) {
  const axios = require('axios');
  const r = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
    params: { id_token: idToken }, timeout: 10000, validateStatus: () => true
  });
  const d = r.data || {};
  if (r.status !== 200) throw new Error('Token Google tidak valid');
  if (d.aud !== GOOGLE_CLIENT_ID) throw new Error('Client ID tidak cocok');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(d.iss)) throw new Error('Issuer salah');
  if (String(d.email_verified) !== 'true') throw new Error('Email Google belum terverifikasi');
  return { sub: String(d.sub), email: d.email, name: d.name || d.email, picture: d.picture || '' };
}
let verifier = defaultVerifier;

// ---------- cache lookup apikey (kurangi hit ke DB) ----------
const keyCache = new Map();
async function lookupKey(key) {
  const c = keyCache.get(key);
  if (c && c.exp > Date.now()) return c.user;
  const user = await store.getUserByKey(key);
  if (user) {
    if (keyCache.size > 5000) keyCache.clear();
    keyCache.set(key, { user, exp: Date.now() + 60000 });
  }
  return user;
}

// ---------- gate semua /api/* ----------
async function apiGate(req, res, next) {
  if (!req.path.startsWith('/api/') || OPEN_PATHS.has(req.path)) return next();

  const q = req.query.apikey;
  const key = String((Array.isArray(q) ? q[0] : q) || req.headers['x-api-key'] || '').trim();
  const fail = (code, error, extra) => res.status(code).json(Object.assign({ status: false, error }, extra));

  if (!key) return fail(401, 'Apikey wajib diisi. Login di /dashboard untuk dapat apikey gratis.');

  try {
    let isDev = false, user = null;
    if (safeEqual(key, DEV_KEY)) isDev = true;
    else if (KEY_RE.test(key)) user = await lookupKey(key);
    if (!isDev && !user) return fail(401, 'Apikey invalid atau tidak terdaftar');

    if (isDev) {
      res.setHeader('X-RateLimit-Limit', 'unlimited');
    } else {
      const used = await store.incrUsage(user.sub, today());
      const reset = secondsToReset();
      res.setHeader('X-RateLimit-Limit', DAILY_LIMIT);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, DAILY_LIMIT - used));
      res.setHeader('X-RateLimit-Reset', reset);
      if (used > DAILY_LIMIT) {
        res.setHeader('Retry-After', reset);
        return fail(429, `Limit harian ${DAILY_LIMIT} request sudah habis. Reset 00:00 WIB.`, { resetIn: reset });
      }
    }

    // plugin lama mengecek global.apikey.includes(req.query.apikey); ganti dengan key internal
    Object.defineProperty(req, 'query', {
      value: Object.assign({}, req.query, { apikey: INTERNAL_KEY }),
      writable: true, configurable: true, enumerable: true
    });
    next();
  } catch (e) {
    console.error('[gate]', e.message);
    fail(503, 'Layanan sementara bermasalah, coba lagi sebentar.');
  }
}

// ---------- handler /auth/* ----------
async function mePayload(user) {
  const used = await store.getUsage(user.sub, today());
  return {
    status: true,
    user: { email: user.email, name: user.name, picture: user.picture },
    apikey: user.apikey,
    plan: 'free',
    limit: DAILY_LIMIT,
    used: Math.min(used, DAILY_LIMIT),
    remaining: Math.max(0, DAILY_LIMIT - used),
    resetIn: secondsToReset()
  };
}
async function sessionUser(req, res) {
  const s = readSession(req);
  const user = s && (await store.getUserBySub(s.sub));
  if (!user) {
    res.status(401).json({ status: false, error: 'Belum login' });
    return null;
  }
  return user;
}

const handlers = {
  config(req, res) {
    res.json({ status: true, googleClientId: GOOGLE_CLIENT_ID, dailyLimit: DAILY_LIMIT, loginReady: !!GOOGLE_CLIENT_ID });
  },
  async google(req, res) {
    if (!GOOGLE_CLIENT_ID) return res.status(503).json({ status: false, error: 'Login Google belum dikonfigurasi (GOOGLE_CLIENT_ID kosong)' });
    const cred = req.body && req.body.credential;
    if (typeof cred !== 'string' || cred.length < 20 || cred.length > 4096) {
      return res.status(400).json({ status: false, error: "Field 'credential' tidak valid" });
    }
    let p;
    try { p = await verifier(cred); }
    catch (e) { return res.status(401).json({ status: false, error: 'Login Google gagal: ' + e.message }); }

    const now = new Date().toISOString();
    let user = await store.getUserBySub(p.sub);
    if (user) Object.assign(user, { email: p.email, name: p.name, picture: p.picture, lastLogin: now });
    else user = { sub: p.sub, email: p.email, name: p.name, picture: p.picture, apikey: await uniqueKey(), createdAt: now, lastLogin: now };
    await store.saveUser(user);

    setCookie(req, res, signSession(user.sub), SESSION_TTL);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await mePayload(user));
  },
  async me(req, res) {
    const user = await sessionUser(req, res);
    if (!user) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(await mePayload(user));
  },
  async regenerate(req, res) {
    const user = await sessionUser(req, res);
    if (!user) return;
    keyCache.delete(user.apikey);
    await store.rotateKey(user, await uniqueKey()); // kuota dihitung per akun, jadi ganti key tidak mereset limit
    res.setHeader('Cache-Control', 'no-store');
    res.json(await mePayload(user));
  },
  logout(req, res) {
    setCookie(req, res, '', 0);
    res.json({ status: true });
  }
};

function createRouter() {
  const express = require('express');
  const rateLimit = require('express-rate-limit');
  const r = express.Router();
  const limiter = rateLimit({
    windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false,
    validate: { trustProxy: false },
    message: { status: false, error: 'Terlalu banyak percobaan, coba lagi sebentar.' }
  });
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[auth]', e.message);
    if (!res.headersSent) res.status(500).json({ status: false, error: 'Terjadi kesalahan server' });
  });
  r.get('/auth/config', handlers.config);
  r.post('/auth/google', limiter, wrap(handlers.google));
  r.get('/auth/me', limiter, wrap(handlers.me));
  r.post('/auth/regenerate-key', limiter, wrap(handlers.regenerate));
  r.post('/auth/logout', handlers.logout);
  return r;
}

module.exports = {
  INTERNAL_KEY, DAILY_LIMIT, apiGate, createRouter, handlers,
  generateApiKey, signSession, readSession,
  _setVerifier: f => { verifier = f; }
};
