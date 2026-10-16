// PAKT — services.js — payments adapter + fraud score + compliance + rate benchmarks.
'use strict';
const U = require('./util');
const { NICHE_MULT, normalizeNiche } = require('./taxonomy');

/* ================= PAYMENTS ADAPTER =================
   Swap these two functions for Razorpay Route / Stripe Connect in production:
   - chargeBrand: create order/paymentIntent, confirm, return provider ref
   - payoutCreator: create transfer/payout to creator's linked account
   Both are called INSIDE the escrow state machine, never directly by routes. */
const payments = {
  chargeBrand({ amount_cents, currency, deal_id }) {
    // PROD: const order = await razorpay.orders.create({amount, currency, receipt: deal_id})
    return { ok: true, provider: 'simulated', ref: 'chg_' + U.id('x').slice(2), amount_cents, currency, deal_id };
  },
  payoutCreator({ amount_cents, currency, deal_id, creator_id }) {
    // PROD: await razorpayX.payouts.create({...}) or stripe.transfers.create({...})
    return { ok: true, provider: 'simulated', ref: 'pay_' + U.id('x').slice(2), amount_cents, currency, deal_id, creator_id, instant: true };
  },
};

const PLATFORM_FEE_BPS = 1200; // 12% — transparent, single fee, no hidden charges
const feeFor = (amount_cents) => Math.floor((amount_cents * PLATFORM_FEE_BPS) / 10000);

/* ================= FRAUD / AUTHENTICITY SCORE =================
   Deterministic heuristic (0–100). Every input is SELF-REPORTED until the
   creator has platform deal history, and the output says so.

   Two things this deliberately does not do any more:
   1. Treat missing stats as fraud. A creator who skipped the optional
      fields used to score 45/"high_risk" with the flag "engagement far
      below organic norms" — describing data we never had. That is now
      `unverified`, which is what it always was.
   2. Reward inflation. A flat 35% ceiling meant a 200k account could claim
      a 21% engagement rate and score 85/"verified", out-ranking an honest
      one. The ceiling now scales with audience size, because engagement
      falls as audiences grow — that is the whole tell. */
const PLAUSIBLE_ER_CEILING = [
  { min: 500000, ceiling: 0.08, typical: '1–2%' },
  { min: 100000, ceiling: 0.12, typical: '1–3%' },
  { min: 10000, ceiling: 0.20, typical: '3–6%' },
  { min: 0, ceiling: 0.35, typical: '5–10%' },
];
const ceilingFor = (f) => PLAUSIBLE_ER_CEILING.find(b => f >= b.min);

const STATS_STALE_MS = 1000 * 60 * 60 * 24 * 90;

function hasStats(u) {
  return u.followers > 0 && (u.avg_likes > 0 || u.avg_comments > 0);
}

const RAPID_REVISION_MS = 1000 * 60 * 60 * 24 * 7;

function fraudScore(u, dealsCompleted = 0, statRevisions = []) {
  const verification = dealsCompleted > 0 ? 'platform_verified' : 'self_reported';

  // Missing data is missing data. It is not a risk signal, and showing it as
  // one made real creators unhireable for skipping an optional field.
  if (!hasStats(u)) {
    return {
      score: null, tier: 'unverified', engagement_rate: null,
      flags: [], notes: ['No audience stats on file yet — this is missing data, not a risk signal'],
      verification, deals_completed: dealsCompleted,
      stat_revisions: statRevisions.length,
      next_step: 'Add followers, avg_likes and avg_comments (PATCH /api/me) to get scored and priced',
    };
  }

  const flags = [], notes = [];
  let score = 100;
  const f = Math.max(u.followers, 1);
  const er = (u.avg_likes + u.avg_comments * 3) / f; // weighted engagement rate
  const band = ceilingFor(f);

  if (er < 0.005) { score -= 40; flags.push('Engagement far below organic norms (<0.5%)'); }
  else if (er < 0.015) { score -= 20; flags.push('Low engagement for audience size'); }
  else if (er > band.ceiling) {
    score -= 30;
    flags.push(`Engagement of ${(er * 100).toFixed(1)}% is implausible at ${f.toLocaleString('en-US')} followers — accounts this size typically run ${band.typical}`);
  }

  const likeCommentRatio = u.avg_comments > 0 ? u.avg_likes / u.avg_comments : Infinity;
  if (likeCommentRatio > 400) { score -= 15; flags.push('Almost no comments relative to likes'); }

  if (u.growth_30d > 0.5) { score -= 25; flags.push('Follower spike >50% in 30 days'); }
  else if (u.growth_30d > 0.25) { score -= 10; flags.push('Unusually fast recent growth'); }

  if (u.account_age_months < 3) { score -= 15; flags.push('Account younger than 3 months'); }
  if (f > 100000 && er < 0.01) { score -= 10; flags.push('Large audience, minimal interaction'); }

  if (verification === 'self_reported') notes.push('Stats are self-reported — not yet corroborated by completed PAKT deals');

  /* Revising your own numbers is legitimate — they change. Revising them
     repeatedly, right after being scored, is the tell. The full history is
     public on the profile either way; this only prices the pattern. */
  /* Count edit SESSIONS, not fields. One PATCH correcting followers, likes and
     comments together is a creator fixing their profile once — counting that
     as three revisions punished exactly the honest behaviour we asked for. */
  const recent = statRevisions.filter(r => Date.now() - r.at < RAPID_REVISION_MS);
  const recentSessions = new Set(recent.map(r => r.at)).size;
  const inFlux = recentSessions >= 3;
  if (inFlux) {
    score -= 15;
    flags.push(`Audience stats rewritten in ${recentSessions} separate edits in the last 7 days`);
  }
  if (recent.length) {
    const days = Math.floor((Date.now() - Math.max(...recent.map(r => r.at))) / 86400000);
    notes.push(`Audience stats were last changed ${days === 0 ? 'today' : days + ' day(s) ago'} — before/after values are on the profile`);
  } else if (statRevisions.length) {
    notes.push(`Audience stats revised ${statRevisions.length} time${statRevisions.length === 1 ? '' : 's'} since signup — full history on the profile`);
  }
  if (u.stats_updated_at && Date.now() - u.stats_updated_at > STATS_STALE_MS) {
    notes.push(`Stats last updated ${Math.floor((Date.now() - u.stats_updated_at) / 86400000)} days ago`);
  }

  score = Math.max(0, Math.min(100, score));
  // "verified" is a claim about stability as much as plausibility — you do not
  // get it while your own numbers are still moving underneath the score.
  let tier = score >= 80 ? 'verified' : score >= 55 ? 'watch' : 'high_risk';
  if (inFlux && tier === 'verified') tier = 'watch';
  return {
    score, tier, engagement_rate: +(er * 100).toFixed(2), flags, notes,
    verification, deals_completed: dealsCompleted,
    stat_revisions: statRevisions.length,
  };
}

/* ================= COMPLIANCE CHECKER =================
   FTC/ASCI disclosure scan. Runs automatically on every content submission.
   Presence is enforced; prominence is advised (buried disclosure is a real
   ASCI finding, but it is not our place to block a live post over it). */
const DISCLOSURE_PATTERNS = [/#ad\b/i, /#sponsored\b/i, /#paidpartnership\b/i, /paid partnership/i, /#advertisement\b/i, /#collab\b/i];
function complianceCheck(caption) {
  const notes = [];
  const text = caption || '';
  const hasDisclosure = DISCLOSURE_PATTERNS.some(rx => rx.test(text));
  if (!hasDisclosure) notes.push('Missing disclosure — add #ad, #sponsored, or "Paid partnership" to the caption');
  if (text.length < 10) notes.push('Caption too short to evaluate claims');
  if (hasDisclosure) {
    const idx = Math.min(...DISCLOSURE_PATTERNS.map(rx => { const m = text.match(rx); return m ? m.index : Infinity; }));
    if (idx > 300) notes.push('Advisory: disclosure sits far down the caption — ASCI expects it visible without tapping "more"');
    const tagsBefore = (text.slice(0, idx).match(/#[\w]+/g) || []).length;
    if (tagsBefore >= 8) notes.push('Advisory: disclosure is buried inside a hashtag block — move it to the first line');
  }
  return { ok: hasDisclosure, notes };
}

/* ================= RATE BENCHMARKS =================
   Public pricing transparency: "creators like you charge X–Y".
   Bands are per-post USD minor units, adjusted by niche multiplier.
   The currency is stated explicitly — these are not rupees. */
const BANDS = [
  { max: 5000,    lo: 2000,   hi: 6000 },
  { max: 15000,   lo: 5000,   hi: 15000 },
  { max: 50000,   lo: 12000,  hi: 40000 },
  { max: 150000,  lo: 30000,  hi: 90000 },
  { max: 500000,  lo: 70000,  hi: 250000 },
  { max: Infinity, lo: 200000, hi: 900000 },
];
function rateBenchmark(followers, niche) {
  const f = Number.isFinite(followers) && followers > 0 ? followers : 0;
  const key = normalizeNiche(niche);
  if (!f) {
    return {
      followers: 0, niche: key || 'general', currency: 'USD',
      low_cents: null, high_cents: null,
      note: 'No follower count on file — add your stats to see the band creators like you actually charge',
    };
  }
  const band = BANDS.find(b => f <= b.max);
  const m = NICHE_MULT[key] || 1.0;
  return {
    followers: f, niche: key || 'general', currency: 'USD',
    low_cents: Math.round(band.lo * m),
    high_cents: Math.round(band.hi * m),
    note: 'Per-post benchmark in USD minor units, from platform deal history for similar audience size and niche',
  };
}

module.exports = { payments, feeFor, PLATFORM_FEE_BPS, fraudScore, complianceCheck, rateBenchmark, hasStats };
