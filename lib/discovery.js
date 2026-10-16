// PAKT — discovery.js — creator prospects sourced from Instagram, not signups.
//
// A prospect is a real Instagram creator we found via Meta's Business
// Discovery API. They are NOT users: they never signed up, have no email,
// no password and no session, and a brand cannot open a deal against them.
// They live here so a brand can *find* them and invite them, and so that
// when the creator does sign up with that handle, their numbers are already
// on the platform with a provenance trail instead of being retyped from
// memory.
//
// Why a separate table and not a row in `users`: users.email and
// users.pass_hash are NOT NULL. Putting a real person in there means
// inventing credentials for them and rendering an account they never
// opened as if they had — which is exactly the fake-profile problem this
// import was meant to fix.
'use strict';
const { db, get, all, run } = require('./db');
const U = require('./util');
const { NICHES, NICHE_KEYWORDS } = require('./taxonomy');

db.exec(`
CREATE TABLE IF NOT EXISTS creator_prospects (
  handle TEXT PRIMARY KEY,
  ig_user_id TEXT,
  name TEXT,
  biography TEXT,
  website TEXT,
  profile_pic_url TEXT,
  followers INTEGER NOT NULL,
  media_count INTEGER,
  avg_likes INTEGER,
  avg_comments INTEGER,
  sample_size INTEGER NOT NULL DEFAULT 0,
  niche TEXT,
  niche_confidence REAL DEFAULT 0,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  claimed_by TEXT REFERENCES users(id),
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prospects_followers ON creator_prospects(followers);
CREATE INDEX IF NOT EXISTS idx_prospects_niche ON creator_prospects(niche);
`);

// PAKT's floor for a brand-discoverable creator. Overridable per import run,
// but this is the number the product promises.
const MIN_FOLLOWERS = 10000;

const normalizeHandle = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();

/* ---- niche inference ----
   Reuses the same NICHE_KEYWORDS the caption SEO and idea engine run on, so
   an imported creator is bucketed by the identical vocabulary a signed-up
   one is. Returns null rather than guessing: taxonomy.js exists because a
   silent fallback to `food` sent street-food ideas to a beauty creator. */
function inferNiche(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return { niche: null, confidence: 0 };
  let best = null, bestHits = 0, total = 0;
  for (const n of NICHES) {
    let hits = 0;
    for (const kw of NICHE_KEYWORDS[n]) if (s.includes(kw)) hits++;
    if (s.includes(n)) hits++; // the niche word itself in the bio counts
    total += hits;
    if (hits > bestHits) { bestHits = hits; best = n; }
  }
  if (!bestHits) return { niche: null, confidence: 0 };
  return { niche: best, confidence: +(bestHits / total).toFixed(2) };
}

/* ---- engagement from real posts ----
   Averaged over whatever recent media Meta returned. Accounts that hide
   like counts come back without like_count; those posts are excluded from
   the like average rather than counted as zero, which would manufacture a
   "no engagement" signal out of a privacy setting. sample_size is stored
   and shown so nobody mistakes a 3-post average for a stable one. */
function averageEngagement(media) {
  const posts = Array.isArray(media) ? media : [];
  const likes = posts.map(m => m && m.like_count).filter(Number.isFinite);
  const comments = posts.map(m => m && m.comments_count).filter(Number.isFinite);
  const mean = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  return { avg_likes: mean(likes), avg_comments: mean(comments), sample_size: Math.max(likes.length, comments.length) };
}

/* Map one Business Discovery node onto PAKT's shape.
   Deliberately absent: growth_30d and account_age_months. Business
   Discovery returns neither, and both feed the fraud score — growth needs
   two snapshots separated by time, and the age of an account is not the
   timestamp of its 25th-most-recent post. They stay null until the creator
   claims the profile and supplies them. */
function fromBusinessDiscovery(node) {
  const handle = normalizeHandle(node.username);
  if (!handle) return null;
  const followers = Number.isInteger(node.followers_count) ? node.followers_count : 0;
  const media = node.media && Array.isArray(node.media.data) ? node.media.data : [];
  const eng = averageEngagement(media);
  const bioText = [node.biography, ...media.slice(0, 10).map(m => m && m.caption)].filter(Boolean).join(' ');
  const { niche, confidence } = inferNiche(bioText);
  return {
    handle,
    ig_user_id: node.id ? String(node.id) : null,
    name: U.isStr(node.name, 1, 80) ? node.name : handle,
    biography: U.isStr(node.biography, 1, 1000) ? node.biography : null,
    website: U.normalizeUrl(node.website),
    profile_pic_url: U.normalizeUrl(node.profile_picture_url),
    followers,
    media_count: Number.isInteger(node.media_count) ? node.media_count : null,
    avg_likes: eng.avg_likes,
    avg_comments: eng.avg_comments,
    sample_size: eng.sample_size,
    niche, niche_confidence: confidence,
    source: 'instagram_business_discovery',
    fetched_at: U.now(),
  };
}

/* Upsert by handle. A re-run refreshes the numbers and the fetched_at
   stamp; it never clears a claim. */
function upsert(rec) {
  const existed = !!get('SELECT handle FROM creator_prospects WHERE handle = ?', rec.handle);
  run(`INSERT INTO creator_prospects
        (handle, ig_user_id, name, biography, website, profile_pic_url, followers, media_count,
         avg_likes, avg_comments, sample_size, niche, niche_confidence, source, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(handle) DO UPDATE SET
         ig_user_id=excluded.ig_user_id, name=excluded.name, biography=excluded.biography,
         website=excluded.website, profile_pic_url=excluded.profile_pic_url,
         followers=excluded.followers, media_count=excluded.media_count,
         avg_likes=excluded.avg_likes, avg_comments=excluded.avg_comments,
         sample_size=excluded.sample_size, niche=excluded.niche,
         niche_confidence=excluded.niche_confidence, source=excluded.source,
         fetched_at=excluded.fetched_at`,
    rec.handle, rec.ig_user_id, rec.name, rec.biography, rec.website, rec.profile_pic_url,
    rec.followers, rec.media_count, rec.avg_likes, rec.avg_comments, rec.sample_size,
    rec.niche, rec.niche_confidence, rec.source, rec.fetched_at);
  return existed ? 'updated' : 'inserted';
}

const engagementRate = (p) =>
  p.followers > 0 && p.sample_size > 0
    ? +(((p.avg_likes || 0) + (p.avg_comments || 0)) / p.followers * 100).toFixed(2)
    : null;

/* Public shape. growth_30d and account_age_months are reported as null with
   a stated reason rather than omitted — a brand pricing off these numbers
   should see which inputs we actually have. Note this does NOT carry an
   authenticity score: fraudScore reads account_age_months and growth_30d,
   and feeding it nulls would silently dock points for data we never had. */
function publicProspect(p) {
  return {
    handle: p.handle, name: p.name, biography: p.biography, website: p.website,
    profile_pic_url: p.profile_pic_url, niche: p.niche, niche_confidence: p.niche_confidence,
    followers: p.followers, media_count: p.media_count,
    avg_likes: p.avg_likes, avg_comments: p.avg_comments,
    engagement_rate: engagementRate(p),
    stats_from_posts: p.sample_size,
    growth_30d: null, account_age_months: null,
    on_pakt: !!p.claimed_by,
    authenticity: null,
    provenance: {
      source: p.source, fetched_at: p.fetched_at,
      note: p.sample_size
        ? `Followers and bio from Instagram Business Discovery; engagement averaged over ${p.sample_size} recent post(s).`
        : 'Followers and bio from Instagram Business Discovery; no public post metrics were returned for this account.',
      unavailable: ['growth_30d', 'account_age_months', 'authenticity'],
      unavailable_reason: 'Business Discovery returns neither growth over time nor account age. They are filled in when the creator claims this profile.',
    },
  };
}

function list({ minFollowers = MIN_FOLLOWERS, niche = null, limit = 200 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const min = Math.max(parseInt(minFollowers, 10) || 0, 0);
  return niche
    ? all('SELECT * FROM creator_prospects WHERE followers >= ? AND niche = ? ORDER BY followers DESC LIMIT ?', min, niche, lim)
    : all('SELECT * FROM creator_prospects WHERE followers >= ? ORDER BY followers DESC LIMIT ?', min, lim);
}

/* Called on creator signup: if this handle was already discovered, the row
   is now theirs. The prospect stays as the provenance record of where the
   numbers first came from. */
function claim(handle, userId) {
  const h = normalizeHandle(handle);
  if (!h) return false;
  const p = get('SELECT handle, claimed_by FROM creator_prospects WHERE handle = ?', h);
  if (!p || p.claimed_by) return false;
  run('UPDATE creator_prospects SET claimed_by = ?, claimed_at = ? WHERE handle = ?', userId, U.now(), h);
  return true;
}

module.exports = {
  MIN_FOLLOWERS, normalizeHandle, inferNiche, averageEngagement,
  fromBusinessDiscovery, upsert, list, claim, publicProspect, engagementRate,
};
