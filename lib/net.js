// PAKT — net.js — the edge layer: what the public internet is allowed to do to us.
//
// Everything here exists because "works on localhost" and "safe on the open
// internet" are different problems. On localhost there is one client, it is
// you, it is not hostile, and there is no proxy in front. In production every
// one of those stops being true, and three things break quietly:
//
//   1. The client IP stops being the socket address. Behind Caddy/nginx every
//      request arrives from 127.0.0.1, so a single per-IP rate limit bucket is
//      shared by the entire internet — the first visitor to click around fast
//      locks everyone else out.
//   2. The X-Forwarded-For header is attacker-controlled unless a proxy you
//      trust overwrote it. Reading it blindly is *worse* than ignoring it: a
//      spoofed header gives an attacker a fresh rate-limit bucket per request.
//   3. One global limit is the wrong shape. 120 requests/minute is generous for
//      browsing and absurd for a login form — it is 120 password guesses a
//      minute against a known email address.
//
// Zero dependencies, same as everything else here.
'use strict';

/* ================= CLIENT IP =================
   PAKT_TRUST_PROXY is the number of reverse proxies in front of this process.
   0 (the default) means "nothing is in front of me" — the socket address is
   the truth and X-Forwarded-For is ignored entirely.

   With N trusted hops the real client is the Nth entry FROM THE RIGHT. This
   matters and is the part people get wrong: a proxy APPENDS the address it
   actually saw. If a client sends a forged "X-Forwarded-For: 1.2.3.4", Caddy
   appends the real peer, giving "1.2.3.4, <real>". Taking the leftmost entry
   reads the forgery; taking the rightmost reads what the proxy observed. */
const TRUST_PROXY = Math.max(0, parseInt(process.env.PAKT_TRUST_PROXY || '0', 10) || 0);

// Only loopback and RFC1918 peers are allowed to speak for someone else. If a
// request reaches this process directly from the internet while a proxy is
// configured, its X-Forwarded-For is a forgery by definition — somebody found
// the origin and is trying to launder their address through it.
function isPrivatePeer(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a)) return true; // unique-local IPv6
  return false;
}

/* A boot-time warning about TRUST_PROXY can only ever be a guess — nothing at
   startup knows whether something sits in front. A request does: an X-Forwarded-For
   arriving from a loopback peer while TRUST_PROXY is 0 means a proxy is there and
   we are not listening to it, so every visitor is sharing one bucket. Warn once. */
let warnedProxy = false;
function clientIp(req) {
  const socketAddr = String(req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
  if (!TRUST_PROXY) {
    if (!warnedProxy && req.headers['x-forwarded-for'] && isPrivatePeer(socketAddr)) {
      warnedProxy = true;
      console.warn(
        '  ! A reverse proxy is forwarding to this process but PAKT_TRUST_PROXY=0.\n' +
        '    Every request looks like it came from ' + socketAddr + ', so the whole internet\n' +
        '    shares one rate-limit bucket. Set PAKT_TRUST_PROXY=1 and restart.');
    }
    return socketAddr;
  }
  if (!isPrivatePeer(socketAddr)) return socketAddr; // direct hit on the origin — trust nothing it claims
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return socketAddr;
  const chain = String(xff).split(',').map(s => s.trim()).filter(Boolean);
  if (!chain.length) return socketAddr;
  const idx = chain.length - TRUST_PROXY;
  return (chain[idx] || chain[0]).replace(/^::ffff:/, '');
}

// Caddy and nginx both set this. Used to decide whether HSTS is honest.
const isHttps = (req) =>
  String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
  !!req.socket.encrypted;

/* ================= TIERED RATE LIMITS =================
   One bucket per (scope, key, minute). In-memory, which is correct for a
   single always-on process and wrong the moment there are two — the comment
   on the original limiter already said Redis, and that is still the answer
   behind a load balancer.

   The tiers exist because the cost of a request is not uniform. Reading the
   creator directory is cheap and boring. Guessing a password is neither. */
const LIMITS = {
  default: parseInt(process.env.PAKT_RATE_LIMIT || '120', 10),   // per IP per minute
  auth: parseInt(process.env.PAKT_RATE_LIMIT_AUTH || '10', 10),  // login + signup
  money: parseInt(process.env.PAKT_RATE_LIMIT_MONEY || '30', 10),// fund/verify/cancel/resolve
  write: parseInt(process.env.PAKT_RATE_LIMIT_WRITE || '60', 10),// everything else that mutates
};

const buckets = new Map();
function take(scope, key, limit) {
  const minute = Math.floor(Date.now() / 60000);
  const k = `${scope}:${key}:${minute}`;
  const n = (buckets.get(k) || 0) + 1;
  buckets.set(k, n);
  // bounded memory: drop everything once a minute's worth of keys piles up
  if (buckets.size > 20000) buckets.clear();
  return { ok: n <= limit, limit, remaining: Math.max(0, limit - n), retryAfter: 60 - (Math.floor(Date.now() / 1000) % 60) };
}

// Which tier a request belongs to, by method and path.
const AUTH_PATHS = /^\/api\/(login|signup)$/;
const MONEY_PATHS = /^\/api\/(deals\/[\w-]+\/(fund|verify|cancel)|disputes\/[\w-]+\/resolve|negotiations\/[\w-]+\/to-deal)$/;
function tierFor(method, urlPath) {
  if (AUTH_PATHS.test(urlPath)) return 'auth';
  if (MONEY_PATHS.test(urlPath)) return 'money';
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') return 'write';
  return 'default';
}

function rateLimit(req, urlPath) {
  const ip = clientIp(req);
  const tier = tierFor(req.method, urlPath);
  // A request always spends from the global bucket as well, so a caller cannot
  // dodge the overall ceiling by spreading traffic across tiers.
  const global = take('all', ip, LIMITS.default);
  if (!global.ok) return { ...global, ip, tier: 'default' };
  if (tier === 'default') return { ...global, ip, tier };
  const scoped = take(tier, ip, LIMITS[tier]);
  return { ...scoped, ip, tier };
}

/* ================= LOGIN THROTTLE =================
   Per-IP limiting alone does not protect one account: a botnet spreads the
   guessing across thousands of addresses and each one stays under 10/minute.
   So failures are also counted against the EMAIL. After a threshold the
   account stops answering login attempts for a cooldown, regardless of who
   is asking.

   Deliberately not a permanent lock. A permanent lock hands anyone who knows
   your email address a denial-of-service button against your account. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_THRESHOLD = 8;
const fails = new Map(); // email -> {n, first, until}

function loginBlocked(email) {
  const e = String(email || '').toLowerCase();
  const rec = fails.get(e);
  if (!rec) return null;
  if (rec.until && rec.until > Date.now()) {
    return { retryAfterSec: Math.ceil((rec.until - Date.now()) / 1000) };
  }
  if (rec.until && rec.until <= Date.now()) fails.delete(e);
  return null;
}

function loginFailed(email) {
  const e = String(email || '').toLowerCase();
  const now = Date.now();
  let rec = fails.get(e);
  if (!rec || now - rec.first > FAIL_WINDOW_MS) rec = { n: 0, first: now, until: 0 };
  rec.n++;
  if (rec.n >= FAIL_THRESHOLD) rec.until = now + FAIL_WINDOW_MS;
  fails.set(e, rec);
  if (fails.size > 20000) fails.clear();
}

const loginOk = (email) => fails.delete(String(email || '').toLowerCase());

/* ================= CORS =================
   The app is served from the same origin as the API, so it needs no CORS at
   all — and "Access-Control-Allow-Origin: *" on a credentialed API is a habit
   worth not having. Origins are opt-in via PAKT_CORS_ORIGINS (comma-separated)
   for the day the frontend moves to its own host.

   Note this was never a CSRF hole: auth is a Bearer header, not a cookie, and
   a browser will not attach it cross-site on its own. Locking it down is about
   not handing out a read primitive to every page on the internet. */
const CORS_ORIGINS = new Set(
  String(process.env.PAKT_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
);

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !CORS_ORIGINS.size) return {};
  if (!CORS_ORIGINS.has(origin) && !CORS_ORIGINS.has('*')) return {};
  return {
    'Access-Control-Allow-Origin': CORS_ORIGINS.has('*') ? '*' : origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

/* ================= SECURITY HEADERS =================
   The CSP is written against what the pages actually load, not against a
   template. index.html and landing.html pull Three.js / GSAP / Motion from
   cdnjs and jsdelivr; every page uses Google Fonts or Fontshare; the Forge
   builds blob: URLs for canvas exports and MediaRecorder output.

   'unsafe-inline' is present and is a real weakening — every page in this repo
   is a single file with its styles and script inline, so removing it means
   hashing or noncing several thousand lines. What the policy still buys:
   script cannot be loaded from an arbitrary host, the page cannot be framed,
   forms cannot post elsewhere, and <base> cannot be rewritten. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com",
  "font-src 'self' data: https://fonts.gstatic.com https://api.fontshare.com https://cdn.fontshare.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join('; ');

function securityHeaders(req) {
  const h = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // nothing in PAKT asks for a camera, a microphone or a location, so
    // nothing embedded in it should be able to either
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  };
  // Only claim HTTPS-only when the request actually arrived over TLS. Sending
  // HSTS over plain http is ignored by browsers anyway, and on localhost it
  // would pin a developer's machine to https for six months.
  if (isHttps(req)) h['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  return h;
}

module.exports = {
  TRUST_PROXY, LIMITS,
  clientIp, isPrivatePeer, isHttps,
  rateLimit, tierFor,
  loginBlocked, loginFailed, loginOk,
  corsHeaders, securityHeaders, CSP,
};
