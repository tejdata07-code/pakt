// PAKT — util.js — validation, errors, ids. Zero dependencies.
'use strict';
const crypto = require('node:crypto');

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const err = (status, code, message) => { throw new ApiError(status, code, message); };

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const now = () => Date.now();

// ---- strict validators ----
const isStr = (v, min = 1, max = 5000) => typeof v === 'string' && v.length >= min && v.length <= max;
const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const isEmail = (v) => isStr(v, 5, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const isUrl = (v) => { if (!isStr(v, 8, 2048)) return false; try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
const oneOf = (v, arr) => arr.includes(v);

/* ---- URL normalization ----
   Creators paste links the way Instagram's share sheet gives them:
   "instagram.com/reel/abc". Rejecting that with "invalid field" is a
   support ticket, not a validation. Prepend the scheme and move on. */
function normalizeUrl(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.') || u.hostname.length < 4) return null;
    return u.href;
  } catch { return null; }
}

/* ---- self-describing validators ----
   Every validator carries the sentence we show the user when it fails.
   "Field role is invalid" tells nobody anything; "must be one of:
   brand, creator" ends the guessing. */
const withHint = (fn, hint) => Object.assign(fn, { hint });
const V = {
  str: (min = 1, max = 5000) => withHint(v => isStr(v, min, max),
    min === max ? `must be text of exactly ${min} characters` : `must be text between ${min} and ${max} characters`),
  int: (min, max) => withHint(v => isInt(v, min, max), `must be a whole number between ${min} and ${max}`),
  num: (min, max) => withHint(v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max,
    `must be a number between ${min} and ${max}`),
  bool: () => withHint(v => typeof v === 'boolean', 'must be true or false'),
  email: () => withHint(isEmail, 'must be a valid email address, e.g. you@example.com'),
  url: () => withHint(v => normalizeUrl(v) !== null, 'must be a link, e.g. instagram.com/reel/abc or https://instagram.com/reel/abc'),
  oneOf: (arr) => withHint(v => arr.includes(v), `must be one of: ${arr.join(', ')}`),
  password: () => withHint(v => isStr(v, 8, 128), 'must be at least 8 characters'),
  // money is always integer minor units — say so, because "500" meaning ₹5 vs ₹500 is a support nightmare
  money: (min, max) => withHint(v => isInt(v, min, max),
    `must be a whole number in minor units — cents/paise, so 50000 means 500.00 (allowed range ${min}–${max})`),
  ratio: (min, max) => withHint(v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max,
    `must be a decimal ratio, not a percentage — 0.6 means +60% (allowed range ${min} to ${max})`),
};

const describeGot = (v) => {
  if (v === undefined) return 'nothing was provided';
  if (v === null) return 'got null';
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return `got ${s.length > 60 ? s.slice(0, 57) + '…' : s}`;
};

function fieldError(k, fn, value) {
  const hint = fn && fn.hint ? ` — ${fn.hint}` : '';
  err(400, 'invalid_field', `Field "${k}" is invalid${hint} (${describeGot(value)})`);
}

function need(obj, spec) { // spec: {field: validator}; throws 400 on first failure
  if (typeof obj !== 'object' || obj === null) err(400, 'bad_body', 'JSON object body required');
  const out = {};
  for (const [k, fn] of Object.entries(spec)) {
    if (!fn(obj[k])) fieldError(k, fn, obj[k]);
    out[k] = obj[k];
  }
  return out;
}

/* Optional fields are still validated. Silently coercing a bad value to a
   default is how "growth_30d: 60" (meaning +60%) becomes 0 and quietly
   erases the exact signal the fraud score exists to catch. */
function optional(obj, spec) {
  if (typeof obj !== 'object' || obj === null) return {};
  const out = {};
  for (const [k, fn] of Object.entries(spec)) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    if (!fn(v)) fieldError(k, fn, v);
    out[k] = v;
  }
  return out;
}

// ---- password hashing (scrypt) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `s1:${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [v, saltHex, hashHex] = String(stored).split(':');
  if (v !== 's1') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');

module.exports = {
  ApiError, err, id, now,
  isStr, isInt, isEmail, isUrl, oneOf, normalizeUrl,
  V, need, optional, fieldError,
  hashPassword, verifyPassword, sha256, token,
};
