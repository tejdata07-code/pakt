// PAKT — studio.js — Creator Studio: the daily-use intelligence layer.
// All engines are deterministic (seeded by user id) so results are stable
// per creator. In production, replace the seeded synthetic history with
// real post data from the Meta Graph API after App Review.
'use strict';
const { get, all } = require('./db');
const auth = require('./auth');
const U = require('./util');
const S = require('./services');
const { NICHE_KEYWORDS, NICHE_TOPICS, normalizeNiche, NICHES } = require('./taxonomy');

/* Every engine below derives its numbers from the creator's audience size.
   With no stats on file they produced confident nonsense — "The one that
   popped", reach 0 — so the honest answer is to ask for the numbers first. */
function requireStats(user) {
  if (!S.hasStats(user)) {
    U.err(409, 'stats_missing',
      'Studio works off your audience numbers. Add followers and average likes/comments ' +
      '(PATCH /api/me) and every tool here starts working — until then any insight would be invented.');
  }
}

/* ---------- seeded pseudo-random (stable per creator) ---------- */
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

const SLOTS = ['6 AM', '9 AM', '12 PM', '3 PM', '6 PM', '9 PM'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FORMATS = ['reel', 'carousel', 'photo', 'story'];
const HOOKS = ['question', 'number', 'contrarian', 'story', 'shock'];

/* ================= PULSE — audience intelligence ================= */
function insights(user) {
  requireStats(user);
  const rnd = seeded(user.id);
  // stable per-creator "learned" traits
  const bestFormat = FORMATS[Math.floor(rnd() * 2)]; // reel or carousel (matches 2026 reality)
  const bestHook = HOOKS[Math.floor(rnd() * HOOKS.length)];
  const bestDay = DAYS[Math.floor(rnd() * 7)];
  const bestSlot = SLOTS[3 + Math.floor(rnd() * 3)]; // afternoons/evenings
  const saveMult = +(1.8 + rnd() * 1.6).toFixed(1);
  const convMult = +(2.2 + rnd() * 1.4).toFixed(1);
  const holdPct = Math.floor(28 + rnd() * 26);

  // heatmap 7×6, biased toward the best day/slot
  const heatmap = DAYS.map((d, di) => SLOTS.map((s, si) => {
    let v = rnd() * 45 + 10;
    if (d === bestDay) v += 25;
    if (s === bestSlot) v += 30;
    if (si >= 3) v += 12; // evenings generally stronger
    return Math.min(100, Math.round(v));
  }));

  // post autopsies — why the top posts worked
  const posts = Array.from({ length: 3 }, (_, i) => {
    const fmt = i === 0 ? bestFormat : FORMATS[Math.floor(rnd() * 3)];
    const reach = Math.floor(user.followers * (0.6 + rnd() * 2.4));
    return {
      title: ['The one that popped', 'Steady performer', 'The sleeper hit'][i],
      format: fmt,
      reach,
      saves: Math.floor(reach * (0.02 + rnd() * 0.05)),
      shares: Math.floor(reach * (0.01 + rnd() * 0.03)),
      why: [
        fmt === 'carousel' ? 'Swipe-through held attention — algorithm re-served it to non-finishers' : 'Strong first-3-seconds retention kept watch time high',
        `Posted inside your ${bestSlot} golden window — first-hour engagement spiked`,
        `${bestHook}-style hook out-performed your average hold by ${holdPct}%`,
      ].slice(0, 2 + Math.floor(rnd() * 2)),
    };
  });

  return {
    learned_from: '90 days of post history (demo: synthetic — connects to Meta Graph API in production)',
    headline_insights: [
      { stat: `${saveMult}×`, text: `Your followers save ${bestFormat}s ${saveMult}× more than any other format` },
      { stat: `${convMult}×`, text: `Posts in your ${bestDay} ${bestSlot} window convert ${convMult}× better` },
      { stat: `+${holdPct}%`, text: `${bestHook[0].toUpperCase() + bestHook.slice(1)}-style hooks hold your viewers ${holdPct}% longer` },
    ],
    best_format: bestFormat, best_hook_style: bestHook,
    golden_window: { day: bestDay, slot: bestSlot },
    heatmap: { days: DAYS, slots: SLOTS, values: heatmap },
    post_autopsies: posts,
  };
}

/* ================= HOOK LAB =================
   scoreHook is the scorer; hookScore wraps it with rewrites. They are split
   so the rewrites can be run BACK THROUGH the scorer before being offered.
   Previously the suggestions were blind string-splices of the user's own
   words — "Why does hey guys welcome back…?" was returned as advice and
   scored 82/100 when pasted back in. Nothing is suggested now unless it
   actually beats what the creator wrote. */
const CURIOSITY = /secret|nobody|mistake|truth|wrong|hidden|stop|never|why|actually|real reason/i;
const GENERIC_OPENERS = /^(hey guys|hi everyone|welcome back|so today|in this video)/i;
const FILLER = /^(hey|hi|hello|guys|everyone|welcome|back|to|another|video|so|today|we|will|talk|about|this|that|is|are|it|its|the|a|an|my|our|your|in|on|of|and|or|i|you|for|have|has|got|just|really|very|going|gonna|thing|things|some|something|special|new|guy|watch|watching)$/i;

function scoreHook(text) {
  const words = text.trim().split(/\s+/);
  let score = 40;
  const notes = [];
  if (words.length <= 12) { score += 15; notes.push({ ok: true, t: `Tight — ${words.length} words fits the 3-second read window` }); }
  else { notes.push({ ok: false, t: `${words.length} words is long for a hook — viewers decide in 3 seconds; aim ≤ 12` }); }
  if (/\?$|^(why|how|what|would you|did you)/i.test(text)) { score += 15; notes.push({ ok: true, t: 'Question framing — invites a mental answer, boosts hold' }); }
  else notes.push({ ok: false, t: 'No question framing — questions make viewers pause to answer' });
  if (/\d/.test(text)) { score += 10; notes.push({ ok: true, t: 'Contains a number — specificity signals substance' }); }
  else notes.push({ ok: false, t: 'No number — "3 mistakes" beats "some mistakes"' });
  if (CURIOSITY.test(text)) { score += 12; notes.push({ ok: true, t: 'Curiosity gap detected — viewers stay to close the loop' }); }
  else notes.push({ ok: false, t: 'No curiosity gap — tease what they don\'t know yet' });
  if (GENERIC_OPENERS.test(text)) { score -= 18; notes.push({ ok: false, t: 'Generic opener — "hey guys / welcome back" is scroll-past fuel' }); }
  return { score: Math.max(5, Math.min(100, score)), notes };
}

// pull the actual subject out of the hook, dropping the throat-clearing
function subjectOf(text) {
  const cleaned = text.replace(GENERIC_OPENERS, ' ').replace(/[^\w\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter(w => w && !FILLER.test(w) && !/^\d+$/.test(w));
  return (words.slice(0, 3).join(' ') || 'this').toLowerCase();
}

const TEMPLATES = [
  s => `Why do 9 out of 10 people get ${s} wrong?`,
  s => `3 ${s} mistakes nobody warns you about`,
  s => `The real reason your ${s} isn't working`,
  s => `What nobody tells you about ${s}`,
  s => `I tested ${s} for 7 days — here's the truth`,
  s => `Stop doing ${s} like this`,
];

function hookScore(body) {
  const { text } = U.need(body, { text: U.V.str(2, 300) });
  const base = scoreHook(text);
  const s = subjectOf(text);

  // only offer a rewrite that measurably outperforms the original
  const rewrites = TEMPLATES
    .map(t => t(s))
    .map(r => ({ text: r, score: scoreHook(r).score }))
    .filter(r => r.score > base.score)
    .sort((a, b) => b.score - a.score)
    .filter((r, i, arr) => arr.findIndex(x => x.text === r.text) === i)
    .slice(0, 3);

  return {
    score: base.score,
    verdict: base.score >= 75 ? 'scroll-stopper' : base.score >= 50 ? 'decent — sharpen it' : 'scroll-past risk',
    notes: base.notes,
    detected_subject: s,
    rewrites,
    rewrites_note: rewrites.length
      ? 'Each rewrite was scored by the same engine — the number next to it is what it would earn.'
      : 'Your hook already beats every rewrite we generate. Ship it.',
  };
}

/* ================= CAPTION PRE-FLIGHT ================= */
const GENERIC_TAGS = ['#love', '#instagood', '#follow', '#like4like', '#followme', '#viral', '#reels', '#fyp', '#explore', '#explorepage', '#instadaily', '#trending'];

function captionPreflight(body) {
  const { caption } = U.need(body, { caption: U.V.str(2, 4000) });
  const opt = U.optional(body, { niche: U.V.oneOf(NICHES) });
  const niche = normalizeNiche(opt.niche) || 'food';
  const items = [];
  let score = 30;
  const tags = caption.match(/#[\w]+/g) || [];
  const generic = tags.filter(t => GENERIC_TAGS.includes(t.toLowerCase()));
  if (tags.length >= 3 && tags.length <= 10) { score += 15; items.push({ ok: true, t: `${tags.length} hashtags — inside the 3–10 sweet spot` }); }
  else if (tags.length === 0) items.push({ ok: false, t: 'No hashtags — 3–10 niche tags still help categorization' });
  else items.push({ ok: false, t: `${tags.length} hashtags — over 10 reads as spam to the algorithm` });
  if (generic.length) { score -= 10; items.push({ ok: false, t: `Generic tags hurt in 2026: ${generic.join(' ')} — swap for niche-specific ones` }); }
  else if (tags.length) { score += 10; items.push({ ok: true, t: 'No junk tags — every tag is doing work' }); }
  const kws = NICHE_KEYWORDS[niche];
  const found = kws.filter(k => caption.toLowerCase().includes(k));
  if (found.length >= 2) { score += 20; items.push({ ok: true, t: `Social SEO strong — keywords found: ${found.slice(0, 3).join(', ')}` }); }
  else { items.push({ ok: false, t: `Weak keyword SEO — captions now outrank hashtags for discovery. Work in: ${kws.slice(0, 3).join(', ')}` }); }
  if (/save this|share this|send this|comment|tag someone|which one/i.test(caption)) { score += 15; items.push({ ok: true, t: 'Has a save/share CTA — the #1 ranking signal in 2026' }); }
  else items.push({ ok: false, t: 'No save/share CTA — sends and saves are what the algorithm rewards most' });
  if (caption.length >= 125) { score += 10; items.push({ ok: true, t: 'Caption long enough for keyword indexing' }); }
  const disclosed = /#ad\b|#sponsored\b|paid partnership/i.test(caption);
  items.push(disclosed
    ? { ok: true, t: 'Disclosure present — sponsored-ready' }
    : { ok: false, t: 'No disclosure — fine for organic; add #ad before submitting a PAKT deal' });
  // which vocabulary was actually used — the fallback used to be silent
  return { score: Math.max(5, Math.min(100, score)), niche_used: niche, hashtag_count: tags.length, keywords_found: found, items };
}

/* ================= IDEA ENGINE ================= */
const ANGLES = ['3 mistakes everyone makes with', 'What nobody tells you about', 'I tested {} for 7 days', 'Beginner vs pro:', 'The 60-second guide to', 'Ranking the most overrated', 'POV: your first time trying', 'The budget version of'];

function ideas(user, dateStr) {
  requireStats(user);
  const niche = normalizeNiche(user.niche) || 'food';
  const topics = NICHE_TOPICS[niche];
  const rnd = seeded(user.id + (dateStr || new Date().toISOString().slice(0, 10)));
  const fmts = ['reel', 'carousel', 'reel', 'story poll', 'carousel'];
  return Array.from({ length: 5 }, (_, i) => {
    const angle = ANGLES[Math.floor(rnd() * ANGLES.length)];
    const topic = topics[Math.floor(rnd() * topics.length)];
    return {
      idea: angle.includes('{}') ? angle.replace('{}', topic) : `${angle} ${topic}`,
      format: fmts[i],
      niche,
      why: ['saves-bait: people bookmark lists', 'share-bait: friends tag friends', 'watch-time: curiosity holds to the end', 'comment-bait: sparks debate', 'relatability: DM-share magnet'][Math.floor(rnd() * 5)],
    };
  });
}

/* ================= REACH DOCTOR ================= */
function reachDoctor(body) {
  const v = U.need(body, {
    views_before: U.V.int(0, 1e9),
    views_now: U.V.int(0, 1e9),
    posts_per_week: U.V.int(0, 100),
    reels_pct: U.V.int(0, 100),
  });
  const opt = U.optional(body, { saves_per_post: U.V.int(0, 1e9) });
  const saves = opt.saves_per_post ?? 0;
  const drop = v.views_before > 0 ? Math.round((1 - v.views_now / v.views_before) * 100) : 0;
  const dx = [];
  if (v.reels_pct < 40) dx.push({ severity: 'high', issue: 'Format mix is stale', fix: `Only ${v.reels_pct}% reels — the algorithm now distributes reels & carousels far wider than photos. Target 50–60% reels.` });
  if (v.posts_per_week < 2) dx.push({ severity: 'high', issue: 'Inconsistent cadence', fix: 'Under 2 posts/week signals inactive. 3–5/week sustained beats 10 in a burst.' });
  if (v.posts_per_week > 10) dx.push({ severity: 'med', issue: 'Flooding', fix: 'Back-to-back posts suppress each other. Cap at 1–2/day.' });
  if (v.views_now > 0 && saves / Math.max(v.views_now, 1) < 0.005) dx.push({ severity: 'high', issue: 'Low save ratio', fix: 'Saves + shares now outweigh likes. Make list/tutorial content people bookmark, and ask for the save.' });
  if (drop > 25) dx.push({ severity: 'med', issue: 'Possible dead-zone posting', fix: 'First-hour engagement decides distribution. Check your Pulse heatmap and post only in golden windows for 2 weeks.' });
  if (!dx.length) dx.push({ severity: 'low', issue: 'No structural problem found', fix: 'Your fundamentals look right — this is likely normal algorithm variance. Hold course 2–3 weeks before pivoting.' });
  return { reach_change_pct: -drop, diagnoses: dx, note: 'Diagnosis is heuristic, based on published 2026 ranking signals (watch time, saves, shares, consistency).' };
}

/* ================= MEDIA KIT =================
   A media kit is a document a creator sends to brands, so what it claims
   about provenance has to be true. It used to stamp "stats verified from
   platform deal history" on numbers typed in at signup by a creator with
   zero completed deals. It now says which of the two it is. */
function mediaKit(user) {
  requireStats(user);
  const payouts = all(
    `SELECT l.amount_cents, l.currency FROM ledger l JOIN deals d ON d.id = l.deal_id
     WHERE d.creator_id = ? AND l.kind = 'payout'`, user.id);
  const dealsDone = get(`SELECT COUNT(*) c FROM deals WHERE creator_id=? AND state='PAID'`, user.id).c;
  const disputes = get(`SELECT COUNT(*) c FROM disputes ds JOIN deals d ON d.id=ds.deal_id WHERE d.creator_id=? AND ds.status='resolved_brand'`, user.id).c;
  const revisions = all('SELECT * FROM stat_revisions WHERE user_id = ? ORDER BY at DESC LIMIT 25', user.id);
  const authenticity = S.fraudScore(user, dealsDone, revisions);

  const earned = {};
  for (const p of payouts) { const c = p.currency || 'USD'; earned[c] = (earned[c] || 0) + p.amount_cents; }

  const verified = dealsDone > 0;
  return {
    handle: user.handle || user.name, niche: user.niche, city: user.city,
    followers: user.followers,
    engagement_rate: authenticity.engagement_rate,
    authenticity: authenticity.score,
    verification: verified ? 'platform_verified' : 'self_reported',
    verified_by: verified
      ? `PAKT — audience figures corroborated by ${dealsDone} completed deal${dealsDone === 1 ? '' : 's'} on the platform`
      : 'Self-reported — entered by the creator and not yet corroborated by any completed PAKT deal',
    stats_updated_at: user.stats_updated_at || null,
    // the provenance travels with the document, so a brand reading the kit
    // sees the same edit history it would see on the profile
    stat_history: auth.statHistory(user.id, revisions),
    deals_completed: dealsDone, disputes_lost: disputes,
    total_earned_cents: payouts.reduce((s, r) => s + r.amount_cents, 0),
    earned_by_currency: Object.entries(earned).map(([currency, amount_cents]) => ({ currency, amount_cents })),
    rate_card: S.rateBenchmark(user.followers, user.niche),
  };
}

module.exports = { insights, hookScore, scoreHook, captionPreflight, ideas, reachDoctor, mediaKit, requireStats };
