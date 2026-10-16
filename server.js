// PAKT — server.js — zero-dependency HTTP API. Run: node server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ApiError, sha256 } = require('./lib/util');
const { all, audit } = require('./lib/db');
const auth = require('./lib/auth');
const escrow = require('./lib/escrow');
const roi = require('./lib/roi');
const studio = require('./lib/studio');
const negotiate = require('./lib/negotiate');
const discovery = require('./lib/discovery');
const S = require('./lib/services');
const net = require('./lib/net');
const { NICHES, CURRENCIES } = require('./lib/taxonomy');

const PORT = process.env.PORT || 4000;
const HOST = process.env.PAKT_HOST || '0.0.0.0';
const MAX_BODY = 64 * 1024; // 64 KB — nobody needs more to make a deal

/* Rate limiting, client-IP resolution, CORS and security headers all moved to
   lib/net.js when this stopped being a localhost-only server. The limiter here
   was a single flat per-IP bucket reading req.socket.remoteAddress, which has
   two failure modes behind a reverse proxy: every request appears to come from
   127.0.0.1 so the whole internet shares one bucket, and 120/minute is 120
   password guesses a minute against a known email. See the header of net.js. */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, 'body_too_large', 'Request body over 64KB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'bad_json', 'Body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---- routes: [method, regex, handler(req, params, body)] ----
const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, service: 'pakt-api', time: Date.now() })],

  ['POST', /^\/api\/signup$/, (req, p, body) => auth.signup(body)],
  /* Per-IP limiting alone does not protect one account — a botnet spreads the
     guessing and every address stays under the limit. Failures are counted
     against the email too, with a cooldown rather than a permanent lock. */
  ['POST', /^\/api\/login$/, (req, p, body) => {
    const blocked = body && net.loginBlocked(body.email);
    if (blocked) {
      audit(null, 'login.throttled', null, { email_hash: sha256(String(body.email || '').toLowerCase()).slice(0, 16) });
      throw new ApiError(429, 'too_many_attempts',
        `Too many failed sign-in attempts for this account. Try again in ${Math.ceil(blocked.retryAfterSec / 60)} minute(s).`);
    }
    try {
      const out = auth.login(body);
      net.loginOk(body.email);
      return out;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) net.loginFailed(body && body.email);
      throw e;
    }
  }],
  /* There was no way to log out. A session lived 7 days and a leaked token
     could not be revoked by the person it was stolen from. */
  ['POST', /^\/api\/logout$/, (req) => auth.logout(req)],
  ['GET', /^\/api\/me$/, (req) => ({ user: auth.publicUser(auth.requireAuth(req)) })],
  // rotating a leaked password was impossible; this also mass-revokes sessions
  ['POST', /^\/api\/me\/password$/, (req, p, body) => auth.changePassword(auth.requireAuth(req), body)],
  // signing up wrong used to be permanent — nothing in the codebase could UPDATE users
  ['PATCH', /^\/api\/me$/, (req, p, body) => ({ user: auth.updateProfile(auth.requireAuth(req), body) })],
  ['GET', /^\/api\/meta$/, () => ({
    niches: NICHES, currencies: CURRENCIES,
    platform_fee_bps: S.PLATFORM_FEE_BPS,
    deal_states: ['DRAFT', 'FUNDED', 'CONTENT_SUBMITTED', 'PAID', 'DISPUTED', 'REFUNDED'],
    auto_release_hours: escrow.AUTO_RELEASE_MS / 3600000,
    dispute_sla_hours: escrow.DISPUTE_SLA_MS / 3600000,
    money_note: 'All amounts are integer minor units (cents/paise). 50000 means 500.00.',
    dispute_sla_behaviour: 'At the deadline a dispute is escalated to a PAKT operator and the funds stay in escrow. No side is paid automatically.',
    operators_configured: escrow.hasOperators(),
  })],

  // creator discovery — every profile ships with a fraud score and a rate benchmark
  ['GET', /^\/api\/creators$/, (req) => {
    auth.requireAuth(req);
    const creators = all(`SELECT * FROM users WHERE role='creator' ORDER BY followers DESC LIMIT 200`);
    // one grouped query, not one per creator — "verified" has to mean
    // "we have deal history", and that is a fact about the platform
    const done = new Map(all(`SELECT creator_id, COUNT(*) c FROM deals WHERE state='PAID' GROUP BY creator_id`).map(r => [r.creator_id, r.c]));
    // stat provenance is public: a brand pricing off these numbers must be able
    // to see that they were rewritten after the score it is looking at
    const revs = new Map();
    for (const r of auth.allStatRevisions()) {
      if (!revs.has(r.user_id)) revs.set(r.user_id, []);
      revs.get(r.user_id).push(r);
    }
    return creators.map(c => ({
      ...auth.publicUser(c),
      authenticity: S.fraudScore(c, done.get(c.id) || 0, revs.get(c.id) || []),
      stat_history: auth.statHistory(c.id, revs.get(c.id) || []),
      benchmark: S.rateBenchmark(c.followers, c.niche),
    }));
  }],
  /* Real Instagram creators imported via Business Discovery who have NOT
     signed up. Separate from /api/creators on purpose: these are leads, not
     members. They carry no authenticity score — fraudScore needs growth and
     account age, which Business Discovery does not return, and scoring them
     on nulls would invent a number. */
  ['GET', /^\/api\/creators\/discover$/, (req) => {
    auth.requireAuth(req);
    const q = new URL(req.url, 'http://x').searchParams;
    const rows = discovery.list({
      minFollowers: q.get('min_followers') ?? discovery.MIN_FOLLOWERS,
      niche: NICHES.includes(q.get('niche')) ? q.get('niche') : null,
      limit: q.get('limit') ?? 200,
    });
    return {
      min_followers: parseInt(q.get('min_followers') ?? discovery.MIN_FOLLOWERS, 10),
      count: rows.length,
      note: 'Discovered from public Instagram data. These creators have not joined PAKT — invite them; you cannot open a deal against an unclaimed profile.',
      creators: rows.map(r => ({ ...discovery.publicProspect(r), benchmark: S.rateBenchmark(r.followers, r.niche) })),
    };
  }],
  ['GET', /^\/api\/benchmarks$/, (req) => {
    const u = new URL(req.url, 'http://x');
    const followers = parseInt(u.searchParams.get('followers') || '10000', 10);
    return S.rateBenchmark(Number.isFinite(followers) ? followers : 10000, u.searchParams.get('niche'));
  }],

  // deals — the escrow lifecycle
  ['POST', /^\/api\/deals$/, (req, p, body) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return escrow.createDeal(u, body);
  }],
  ['GET', /^\/api\/deals$/, (req) => escrow.listDeals(auth.requireAuth(req))],
  ['GET', /^\/api\/deals\/([\w-]+)$/, (req, p) => escrow.getDeal(auth.requireAuth(req), p[0])],
  // a mistyped draft used to be permanent — no edit, no delete, and cancel
  // only worked from FUNDED
  ['PATCH', /^\/api\/deals\/([\w-]+)$/, (req, p, body) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return escrow.updateDeal(u, p[0], body);
  }],
  ['DELETE', /^\/api\/deals\/([\w-]+)$/, (req, p) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return escrow.deleteDeal(u, p[0]);
  }],
  ['POST', /^\/api\/deals\/([\w-]+)\/fund$/, (req, p) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return escrow.fundDeal(u, p[0], req.headers['idempotency-key']);
  }],
  ['POST', /^\/api\/deals\/([\w-]+)\/submit$/, (req, p, body) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'creator');
    return escrow.submitContent(u, p[0], body);
  }],
  ['POST', /^\/api\/deals\/([\w-]+)\/verify$/, (req, p) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return escrow.verifyDeal(u, p[0]);
  }],
  ['POST', /^\/api\/deals\/([\w-]+)\/cancel$/, (req, p) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return escrow.cancelDeal(u, p[0]);
  }],
  ['POST', /^\/api\/deals\/([\w-]+)\/dispute$/, (req, p, body) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return escrow.openDispute(u, p[0], body);
  }],
  ['POST', /^\/api\/disputes\/([\w-]+)\/respond$/, (req, p, body) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'creator');
    return escrow.respondToDispute(u, p[0], body);
  }],
  ['GET', /^\/api\/disputes$/, (req) => {
    const u = auth.requireAuth(req);
    const status = new URL(req.url, 'http://x').searchParams.get('status');
    return escrow.listDisputes(u, status);
  }],
  ['GET', /^\/api\/disputes\/([\w-]+)$/, (req, p) => escrow.getDispute(auth.requireAuth(req), p[0])],
  // moves money — was reachable with no Authorization header whatsoever
  ['POST', /^\/api\/disputes\/([\w-]+)\/resolve$/, (req, p, body) => {
    const u = auth.requireAuth(req); auth.requireAdmin(u);
    return escrow.resolveDispute(u, p[0], body);
  }],

  // ROI attribution
  ['GET', /^\/t\/([\w-]+)$/, (req, p) => ({ __redirect: roi.recordClick(p[0]).redirect })],
  ['POST', /^\/api\/track\/([\w-]+)\/convert$/, (req, p, body) => roi.recordConversion(p[0], body)],
  ['GET', /^\/api\/deals\/([\w-]+)\/roi$/, (req, p) => roi.report(auth.requireAuth(req), p[0])],

  // creator wallet + audit trail
  ['GET', /^\/api\/wallet$/, (req) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'creator');
    return escrow.wallet(u);
  }],

  // ---- Creator Studio: the daily-use intelligence layer ----
  ['GET', /^\/api\/studio\/insights$/, (req) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'creator');
    return studio.insights(u);
  }],
  ['POST', /^\/api\/studio\/hook$/, (req, p, body) => {
    auth.requireAuth(req);
    return studio.hookScore(body);
  }],
  ['POST', /^\/api\/studio\/caption$/, (req, p, body) => {
    auth.requireAuth(req);
    return studio.captionPreflight(body);
  }],
  ['GET', /^\/api\/studio\/ideas$/, (req) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'creator');
    return studio.ideas(u);
  }],
  ['POST', /^\/api\/studio\/reach$/, (req, p, body) => {
    auth.requireAuth(req);
    return studio.reachDoctor(body);
  }],
  ['GET', /^\/api\/studio\/mediakit$/, (req) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'creator');
    return studio.mediaKit(u);
  }],

  // ---- THE TABLE: structured negotiation ----
  ['POST', /^\/api\/negotiations$/, (req, p, body) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return negotiate.open(u, body);
  }],
  ['GET', /^\/api\/negotiations$/, (req) => negotiate.list(auth.requireAuth(req))],
  ['GET', /^\/api\/negotiations\/([\w-]+)$/, (req, p) => negotiate.view(auth.requireAuth(req), p[0])],
  ['POST', /^\/api\/negotiations\/([\w-]+)\/counter$/, (req, p, body) => negotiate.counter(auth.requireAuth(req), p[0], body)],
  ['POST', /^\/api\/negotiations\/([\w-]+)\/accept$/, (req, p) => negotiate.accept(auth.requireAuth(req), p[0])],
  ['POST', /^\/api\/negotiations\/([\w-]+)\/decline$/, (req, p) => negotiate.decline(auth.requireAuth(req), p[0])],
  ['POST', /^\/api\/negotiations\/([\w-]+)\/message$/, (req, p, body) => negotiate.message(auth.requireAuth(req), p[0], body)],
  ['POST', /^\/api\/negotiations\/([\w-]+)\/to-deal$/, (req, p) => {
    const u = auth.requireAuth(req); auth.requireRole(u, 'brand');
    return negotiate.toDeal(u, p[0]);
  }],

  /* The audit log is the platform's memory, not a public feed. Unscoped it
     returned the last 100 events to anyone with a session — every other
     creator's negotiated amounts, payouts and fees included. Callers now see
     their own actions and events on deals, negotiations and disputes they
     are a party to; operators see everything. */
  ['GET', /^\/api\/audit$/, (req) => scopedAudit(auth.requireAuth(req))],
];

function scopedAudit(user) {
  const rows = user.is_admin
    ? all('SELECT * FROM audit ORDER BY id DESC LIMIT 100')
    : all(`SELECT a.* FROM audit a
           WHERE a.actor_id = ?
              OR a.entity = 'user:' || ?
              OR a.entity IN (SELECT 'deal:' || id FROM deals WHERE brand_id = ? OR creator_id = ?)
              OR a.entity IN (SELECT 'neg:' || id FROM negotiations WHERE brand_id = ? OR creator_id = ?)
              OR a.entity IN (SELECT 'dispute:' || ds.id FROM disputes ds
                              JOIN deals d ON d.id = ds.deal_id WHERE d.brand_id = ? OR d.creator_id = ?)
           ORDER BY a.id DESC LIMIT 100`,
      user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id);
  // detail was stored as a JSON string and handed back as one — parse it
  return rows.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

/* Auto-release and the dispute SLA were only ever evaluated when somebody
   happened to call a read endpoint. A creator whose brand went silent got
   paid when they next opened the app — not at 72h. The guarantee needs a
   clock of its own. */
const SWEEP_MS = 60 * 1000;
function startSweeper() {
  const t = setInterval(() => {
    try {
      const r = escrow.sweep();
      const d = r.disputes;
      if (r.deals || d.warned || d.escalated) {
        console.log(`sweep: released ${r.deals} deal(s), warned ${d.warned}, escalated ${d.escalated} dispute(s)`);
      }
    } catch (e) { console.error('sweep failed', e); }
    /* Expired sessions were never deleted — the table only ever grew, and every
       stale row was a token that stayed on disk long after it stopped working.
       Cheap to clear, and it keeps the blast radius of a database leak to the
       sessions that are actually live. */
    try { require('./lib/db').run('DELETE FROM sessions WHERE expires_at < ?', Date.now()); }
    catch (e) { console.error('session sweep failed', e); }
  }, SWEEP_MS);
  t.unref();
  return t;
}

const server = http.createServer(async (req, res) => {
  const base = { ...net.securityHeaders(req), ...net.corsHeaders(req) };
  const send = (status, obj, extra) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      ...base, ...extra,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, base); return res.end(); }

    /* req.url is attacker-controlled and may not even be valid percent-encoding.
       A malformed path must be a clean 400, not an unhandled throw inside the
       router. Note the decode is only a validity GATE — routing still happens
       on the raw path, because decoding first is how "/api/deals/a%2Fb" turns
       into a different route than the one the client actually asked for. */
    const urlPath = req.url.split('?')[0];
    try { decodeURIComponent(urlPath); }
    catch { return send(400, { error: 'bad_path', message: 'Malformed request path' }); }

    const rl = net.rateLimit(req, urlPath);
    if (!rl.ok) {
      return send(429,
        { error: 'rate_limited', message: `Slow down — ${rl.limit} requests/minute on this endpoint`, retry_after_seconds: rl.retryAfter },
        { 'Retry-After': String(rl.retryAfter) });
    }

    // ---- static pages (landing + app live alongside server.js) ----
    /* An allowlist, never a path join against user input — the key is the URL
       and the value is a literal filename, so there is no traversal to attempt.
       Trimmed to the five pages that exist: the map had carried a dozen
       concept and site variants from earlier design rounds, all pointing at
       files that were deleted. */
    const pages = {
      '/': 'index.html', '/index.html': 'index.html',
      '/landing': 'landing.html', '/landing.html': 'landing.html',
      '/app': 'app.html', '/app.html': 'app.html',
      '/forge': 'forge.html', '/forge.html': 'forge.html',
      '/walkthrough': 'walkthrough.html', '/walkthrough.html': 'walkthrough.html',
    };
    if (req.method === 'GET' && pages[urlPath]) {
      const file = path.join(__dirname, pages[urlPath]);
      if (fs.existsSync(file)) {
        const html = fs.readFileSync(file);
        // the CSP matters most on the HTML responses — that is what runs script
        res.writeHead(200, { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
        return res.end(html);
      }
    }

    for (const [method, rx, handler] of routes) {
      if (req.method !== method) continue;
      const m = urlPath.match(rx);
      if (!m) continue;
      const body = (method === 'POST' || method === 'PATCH') ? await readBody(req) : undefined;
      const result = await handler(req, m.slice(1), body);
      if (result && result.__redirect) {
        res.writeHead(302, { ...base, Location: result.__redirect });
        return res.end();
      }
      return send(200, result);
    }
    send(404, { error: 'no_route', message: `No ${req.method} ${urlPath}` });
  } catch (e) {
    if (e instanceof ApiError) return send(e.status, { error: e.code, message: e.message });
    console.error(e);
    audit(null, 'server.error', null, { message: String(e.message).slice(0, 200) });
    send(500, { error: 'internal', message: 'Something broke on our side — it has been logged' });
  }
});

/* Slowloris and friends: a client that opens a socket and dribbles headers
   forever costs nothing to send and holds a connection each time. Node's
   defaults are generous for a trusted network and wrong for the open internet. */
server.headersTimeout = 20 * 1000;
server.requestTimeout = 30 * 1000;
server.keepAliveTimeout = 15 * 1000;
server.maxHeadersCount = 64;

/* Refuse to start misconfigured rather than start quietly wrong. Each of these
   is silent in development and expensive in production. */
function preflight() {
  const warn = [];
  if (!process.env.PAKT_ADMIN_EMAILS) {
    warn.push('PAKT_ADMIN_EMAILS is unset — no operator accounts exist, so the dispute SLA sweep does nothing and no dispute can ever be resolved.');
  }
  // TRUST_PROXY is not checked here: nothing at boot knows whether a proxy is
  // in front. lib/net.js warns the first time a forwarded request proves one is.
  if (!process.env.PAKT_DB) {
    warn.push(`PAKT_DB is unset — using ${require('./lib/db').DB_PATH}. On a host with an ephemeral filesystem this database is erased on every restart.`);
  }
  for (const w of warn) console.warn('  ! ' + w);
  return warn;
}

if (require.main === module) {
  preflight();
  server.listen(PORT, HOST, () => {
    console.log(`PAKT API listening on http://${HOST}:${PORT}  (db: ${require('./lib/db').DB_PATH})`);
    console.log(`  node ${process.versions.node} · trust_proxy=${net.TRUST_PROXY} · limits ${JSON.stringify(net.LIMITS)}`);
  });
  startSweeper();

  // Close the database cleanly so WAL is checkpointed instead of left behind.
  const bye = (sig) => () => {
    console.log(`\n${sig} — shutting down`);
    server.close(() => { try { require('./lib/db').db.close(); } catch {} process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', bye('SIGTERM'));
  process.on('SIGINT', bye('SIGINT'));
}
module.exports = { server, startSweeper, scopedAudit, preflight };
