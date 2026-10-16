// PAKT — auth.js — signup/login, hashed sessions, role guards, profile edits.
'use strict';
const { get, all, run, audit } = require('./db');
const U = require('./util');
const { NICHES } = require('./taxonomy');

const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

/* Operators are promoted by env, never by request body — there is no
   "role: admin" a signup can smuggle in. Empty by default. */
const ADMIN_EMAILS = new Set(
  String(process.env.PAKT_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

/* ---------- profile fields ----------
   One spec, used by signup and by PATCH /api/me, so a value that is legal
   at signup stays legal at edit time and vice versa. */
const PROFILE_SPEC = {
  name: U.V.str(2, 80),
  handle: U.V.str(2, 40),
  niche: U.V.oneOf(NICHES),
  followers: U.V.int(0, 1e9),
  avg_likes: U.V.int(0, 1e9),
  avg_comments: U.V.int(0, 1e9),
  growth_30d: U.V.ratio(-1, 10),
  account_age_months: U.V.int(0, 600),
  city: U.V.str(2, 60),
};
const CREATOR_ONLY = ['handle', 'niche', 'followers', 'avg_likes', 'avg_comments', 'growth_30d', 'account_age_months'];
const STATS_FIELDS = ['followers', 'avg_likes', 'avg_comments', 'growth_30d', 'account_age_months'];
// Brands filter on these and the authenticity score is computed from them.
// Letting a creator skip them isn't a kindness — it renders them unhireable.
const REQUIRED_FOR_CREATOR = ['handle', 'niche', 'followers', 'avg_likes', 'avg_comments'];

/* ---------- account age is a fact about the world, not a free field ----------
   It cannot exceed the age of Instagram itself, it cannot go backwards, and
   it cannot grow faster than time does. Without this, "5 months old" became
   "600 months old" in a single PATCH and the under-3-months penalty was
   trivially escaped. */
const IG_LAUNCH_MS = Date.UTC(2010, 9, 1); // Instagram, October 2010
const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;
const maxPlausibleAge = () => Math.floor((Date.now() - IG_LAUNCH_MS) / MONTH_MS);

function checkAccountAge(next, prev, prevAt) {
  const max = maxPlausibleAge();
  if (next > max) {
    U.err(400, 'implausible_account_age',
      `account_age_months of ${next} would predate Instagram itself — the maximum today is ${max} (Instagram launched October 2010)`);
  }
  if (prev == null) return;
  if (next < prev) {
    U.err(400, 'account_age_decreased',
      `account_age_months cannot go backwards — it was ${prev}. An account only gets older.`);
  }
  const elapsed = prevAt ? Math.max(0, Math.floor((Date.now() - prevAt) / MONTH_MS)) : 0;
  const ceiling = prev + elapsed + 1; // one month of tolerance for rounding
  if (next > ceiling) {
    U.err(400, 'account_age_jumped',
      `account_age_months can only grow with time — it was ${prev} and ${elapsed} month(s) have passed, so ${ceiling} is the most it can be today.`);
  }
}

function normalizeHandle(h) {
  return typeof h === 'string' ? h.trim().replace(/^@+/, '') : h;
}

function signup(body) {
  const base = U.need(body, {
    role: U.V.oneOf(['brand', 'creator']),
    name: U.V.str(2, 80),
    email: U.V.email(),
    password: U.V.password(),
  });
  if (get('SELECT id FROM users WHERE email = ?', base.email.toLowerCase())) {
    U.err(409, 'email_taken', 'An account with this email already exists — log in instead');
  }
  if (body.handle !== undefined) body = { ...body, handle: normalizeHandle(body.handle) };

  if (base.role === 'creator') {
    const missing = REQUIRED_FOR_CREATOR.filter(k => body[k] === undefined || body[k] === null || body[k] === '');
    if (missing.length) {
      U.err(400, 'stats_required',
        `Creator accounts need ${missing.join(', ')}. Brands search and price on these numbers — ` +
        `an account without them shows as unverified and gets the lowest rate band. Copy them from Instagram Insights.`);
    }
  } else {
    rejectCreatorFields(body, 'brand');
  }

  const p = U.optional(body, PROFILE_SPEC);
  if (p.account_age_months !== undefined) checkAccountAge(p.account_age_months, null, null);
  const uid = U.id('usr');
  const email = base.email.toLowerCase();
  run(`INSERT INTO users (id, role, name, email, pass_hash, handle, niche, followers, avg_likes, avg_comments,
       growth_30d, account_age_months, city, is_admin, stats_updated_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid, base.role, base.name, email, U.hashPassword(base.password),
    p.handle ?? null, p.niche ?? null, p.followers ?? 0, p.avg_likes ?? 0, p.avg_comments ?? 0,
    p.growth_30d ?? 0, p.account_age_months ?? 12, p.city ?? null,
    ADMIN_EMAILS.has(email) ? 1 : 0, base.role === 'creator' ? U.now() : null, U.now());
  audit(uid, 'signup', 'user:' + uid, { role: base.role });
  /* If we had already discovered this handle on Instagram, the prospect row
     is now theirs — it stops showing as an uninvited lead and stays on as
     the record of where those first numbers came from. Required lazily:
     discovery.js reads the same db module this file does. */
  if (base.role === 'creator' && p.handle) {
    try { require('./discovery').claim(p.handle, uid); }
    catch { /* discovery is not load-bearing for signup */ }
  }
  return { user: publicUser(get('SELECT * FROM users WHERE id = ?', uid)), token: createSession(uid) };
}

function rejectCreatorFields(body, role) {
  const bad = CREATOR_ONLY.filter(k => body[k] !== undefined && body[k] !== null && body[k] !== '');
  if (bad.length) U.err(400, 'not_for_this_role', `${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} only for creator accounts — a ${role} account has no audience stats`);
}

function login(body) {
  const { email, password } = U.need(body, { email: U.V.email(), password: U.V.password() });
  const u = get('SELECT * FROM users WHERE email = ?', email.toLowerCase());
  if (!u || !U.verifyPassword(password, u.pass_hash)) U.err(401, 'bad_credentials', 'Email or password is incorrect');
  // keeps operator promotion working without a migration script
  const shouldBeAdmin = ADMIN_EMAILS.has(u.email) ? 1 : 0;
  if (u.is_admin !== shouldBeAdmin) { run('UPDATE users SET is_admin = ? WHERE id = ?', shouldBeAdmin, u.id); u.is_admin = shouldBeAdmin; }
  audit(u.id, 'login', 'user:' + u.id);
  return { user: publicUser(u), token: createSession(u.id) };
}

/* ---------- profile edits ----------
   Signing up wrong used to be permanent: there was no route anywhere that
   could UPDATE users, so a creator who skipped their stats was stuck as
   "high risk / 0 followers" forever, with a new email as the only escape. */
function updateProfile(user, body) {
  if (typeof body !== 'object' || body === null) U.err(400, 'bad_body', 'JSON object body required');
  if (body.handle !== undefined) body = { ...body, handle: normalizeHandle(body.handle) };
  if (user.role === 'brand') rejectCreatorFields(body, 'brand');

  const patch = U.optional(body, PROFILE_SPEC);
  const keys = Object.keys(patch);
  if (!keys.length) {
    const allowed = (user.role === 'creator' ? Object.keys(PROFILE_SPEC) : Object.keys(PROFILE_SPEC).filter(k => !CREATOR_ONLY.includes(k)));
    U.err(400, 'nothing_to_update', `Send at least one field to change. You can update: ${allowed.join(', ')}`);
  }
  const before = {}; for (const k of keys) before[k] = user[k];
  if (patch.account_age_months !== undefined) {
    checkAccountAge(patch.account_age_months, user.account_age_months, user.stats_updated_at);
  }

  const sets = keys.map(k => `${k} = ?`);
  const vals = keys.map(k => patch[k]);
  const touchesStats = keys.some(k => STATS_FIELDS.includes(k));
  if (touchesStats) { sets.push('stats_updated_at = ?'); vals.push(U.now()); }
  run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, user.id);

  // Every change to a public audience number becomes a public revision.
  // The audit entry below is scoped to the actor; this table is not, because
  // the brand pricing a deal off these numbers has to be able to see that
  // they were rewritten after it looked.
  for (const k of keys) {
    if (!STATS_FIELDS.includes(k) || before[k] === patch[k]) continue;
    run('INSERT INTO stat_revisions (id, user_id, field, old_value, new_value, at) VALUES (?,?,?,?,?,?)',
      U.id('rev'), user.id, k, String(before[k]), String(patch[k]), U.now());
  }
  audit(user.id, 'profile.update', 'user:' + user.id, { before, after: patch });
  return publicUser(get('SELECT * FROM users WHERE id = ?', user.id));
}

/* ---------- ending a session ----------
   There was no logout anywhere. A token lived 7 days and the person it was
   stolen from had no way to revoke it — closing the tab did nothing, because
   the session is server-side state and nothing ever deleted the row. */
function sessionTokenOf(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function logout(req) {
  const t = sessionTokenOf(req);
  if (!t) U.err(401, 'no_token', 'Authorization: Bearer <token> required');
  const s = get('SELECT * FROM sessions WHERE token_hash = ?', U.sha256(t));
  // Idempotent on purpose: logging out of an already-dead session is a success,
  // not an error. The caller wanted the token gone, and it is gone.
  if (s) {
    run('DELETE FROM sessions WHERE token_hash = ?', U.sha256(t));
    audit(s.user_id, 'logout', 'user:' + s.user_id);
  }
  return { ok: true, logged_out: true };
}

/* ---------- password change ----------
   The README listed "no password change" as a known gap. It is a security gap
   as much as a product one: until this existed, a password that leaked could
   never be rotated, and a session that leaked could not be mass-revoked.

   Changing the password kills EVERY session including the caller's, and hands
   back a fresh token. If the reason you are here is that someone else has your
   account, leaving their session alive would defeat the whole exercise. */
function changePassword(user, body) {
  const v = U.need(body, { current_password: U.V.password(), new_password: U.V.password() });
  const fresh = get('SELECT * FROM users WHERE id = ?', user.id);
  if (!U.verifyPassword(v.current_password, fresh.pass_hash)) {
    U.err(401, 'bad_credentials', 'Your current password is incorrect');
  }
  if (v.current_password === v.new_password) {
    U.err(400, 'password_unchanged', 'The new password must be different from the current one');
  }
  run('UPDATE users SET pass_hash = ? WHERE id = ?', U.hashPassword(v.new_password), user.id);
  const killed = all('SELECT token_hash FROM sessions WHERE user_id = ?', user.id).length;
  run('DELETE FROM sessions WHERE user_id = ?', user.id);
  audit(user.id, 'password.change', 'user:' + user.id, { sessions_revoked: killed });
  return {
    ok: true,
    sessions_revoked: killed,
    token: createSession(user.id),
    note: 'Every other device has been signed out. Use the token above to continue on this one.',
  };
}

function createSession(userId) {
  const t = U.token();
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', U.sha256(t), userId, U.now() + SESSION_TTL);
  return t;
}

function requireAuth(req) {
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) U.err(401, 'no_token', 'Authorization: Bearer <token> required');
  const s = get('SELECT * FROM sessions WHERE token_hash = ?', U.sha256(t));
  if (!s || s.expires_at < U.now()) U.err(401, 'bad_token', 'Session is invalid or expired — log in again');
  const u = get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!u) U.err(401, 'bad_token', 'Session user no longer exists');
  return u;
}

function requireRole(user, role) {
  if (user.role !== role) U.err(403, 'wrong_role', `This action requires a ${role} account`);
}

function requireAdmin(user) {
  if (!user.is_admin) U.err(403, 'admin_only', 'Only a PAKT operator can resolve disputes');
}

function publicUser(u) {
  const { pass_hash, email, is_admin, ...rest } = u;
  return { ...rest, is_admin: !!is_admin };
}

/* ---------- public stat provenance ---------- */
function statHistory(userId, rows) {
  const revs = rows || all('SELECT * FROM stat_revisions WHERE user_id = ? ORDER BY at DESC LIMIT 25', userId);
  return {
    revisions: revs.length,
    last_revised_at: revs.length ? revs[0].at : null,
    changes: revs.slice(0, 10).map(r => ({ field: r.field, from: r.old_value, to: r.new_value, at: r.at })),
  };
}
const allStatRevisions = () => all('SELECT * FROM stat_revisions ORDER BY at DESC LIMIT 2000');

module.exports = {
  signup, login, logout, changePassword, updateProfile,
  requireAuth, requireRole, requireAdmin, publicUser,
  statHistory, allStatRevisions, checkAccountAge, maxPlausibleAge,
  PROFILE_SPEC, REQUIRED_FOR_CREATOR, STATS_FIELDS,
};
