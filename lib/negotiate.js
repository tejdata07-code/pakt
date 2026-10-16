// PAKT — negotiate.js — THE TABLE. Structured negotiation with an immutable
// offer ledger. The core guarantee: the accepted offer IS the deal price.
// No free-text prices, no manual amounts after agreement, no side-channel.
//
//  Brand opens with offer → parties alternate counters → one side accepts
//  → thread freezes (terms_hash) → deal is created AT the agreed price only.
'use strict';
const crypto = require('node:crypto');
const { get, all, run, tx, audit } = require('./db');
const U = require('./util');
const escrow = require('./escrow');
const { CURRENCIES, CURRENCY_MINOR, CURRENCY_SYMBOL } = require('./taxonomy');

/* ---------- contact-info redaction (anti-disintermediation) ----------
   Emails, phone numbers, messaging-app handoffs and @handles pushed into
   chat get masked. The original is NOT stored — redaction happens before
   write, so even we can't leak it. The message is flagged so patterns of
   evasion are visible.

   This is a single-pass range redactor. The previous version ran three
   global replaces in sequence over the same string, which had two real
   defects: a later pattern could match INSIDE the placeholder an earlier
   one had already written (producing garbled output like
   "[hidden — keep de]als on PAKT to stay protected]"), and the fixed
   {0,24} character window chopped handles mid-token, leaving a guessable
   remainder on screen. Collecting every match as a range, merging
   overlaps, then rebuilding the string once makes both impossible. */
const PLACEHOLDER = '[hidden — keep deals on PAKT to stay protected]';

const DIGIT_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|oh|double|triple)';
const CONTACT_INTENT = /\b(?:dm|dms|direct|message|msg|ping|reach|contact|email|mail|call|text|number|handle|offline|outside|off[\s-]?platform|whats\s?app|telegram|signal|snapchat|discord|insta|instagram)\b/i;

const ALWAYS = [
  // emails
  /[\w.+-]+@[\w-]+\.[\w.]{2,}/g,
  // obfuscated emails: "aj at gmail dot com"
  /[\w.+-]+\s*(?:\(|\[)?\s*(?:at)\s*(?:\)|\])?\s*[\w-]+\s*(?:\(|\[)?\s*(?:dot|\.)\s*(?:\)|\])?\s*[a-z]{2,6}\b/gi,
  // phone numbers (needs a long run — a 5-digit price is not a phone number)
  /(?:\+?\d[\d\s\-().]{8,}\d)/g,
  // spelled-out numbers, the classic way around a digit filter
  new RegExp(`\\b${DIGIT_WORD}(?:[\\s,-]+${DIGIT_WORD}){5,}`, 'gi'),
  // "whatsapp me on ...", "telegram: ..." — consume to the end of the clause
  // rather than a fixed character window, so nothing can be left dangling.
  // The lookahead keeps "the signal was strong" out of it.
  /\b(?:whats\s?app|telegram|signal|snapchat|discord)\b(?=[^.!?\n\r]*(?:\d|@|\bme\b|\bmy\b|\bdm\b|\bid\b|\bping\b|\breach\b|\bnumber\b|\bhandle\b))[^.!?\n\r]*/gi,
];
// @handles are only a handoff when the message is asking for one — brands
// legitimately say "tag @brand in the reel", and redacting that is noise.
const WHEN_CONTACT_INTENT = [
  /@[A-Za-z0-9._]{2,30}/g,
];

function redact(text) {
  const src = String(text ?? '');
  const patterns = CONTACT_INTENT.test(src) ? [...ALWAYS, ...WHEN_CONTACT_INTENT] : ALWAYS;

  const ranges = [];
  for (const rx of patterns) {
    rx.lastIndex = 0;
    for (const m of src.matchAll(rx)) {
      if (m[0].length) ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (!ranges.length) return { text: src, redacted: false };

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  let out = '', cursor = 0;
  for (const [s, e] of merged) { out += src.slice(cursor, s) + PLACEHOLDER; cursor = e; }
  out += src.slice(cursor);
  return { text: out, redacted: true };
}

function loadNeg(id) {
  const n = get('SELECT * FROM negotiations WHERE id = ?', id);
  if (!n) U.err(404, 'not_found', 'Negotiation not found');
  return n;
}
function assertParty(n, user) {
  if (n.brand_id !== user.id && n.creator_id !== user.id) U.err(403, 'not_your_table', 'You are not a party to this negotiation');
}
/* ---------- which offer is actually standing ----------
   This ordered by (created_at DESC, id DESC), and both halves of that are
   wrong together. created_at is Date.now(), so two offers exchanged inside the
   same millisecond tie — and the tiebreaker, `id`, is `off_` plus nine RANDOM
   bytes. Ties were therefore broken at random.

   The visible failure was the creator being told "you cannot accept your own
   offer" while the brand's counter was plainly on the table: latestOffer had
   handed back the creator's own superseded offer. The suite caught it in about
   two runs out of five. The real damage is worse than a flaky test — this
   function decides the price that gets frozen into the terms hash, so on a busy
   table it could have frozen the wrong number.

   rowid is SQLite's monotonic insertion counter and is exactly the "which of
   these happened last" that Date.now() cannot resolve at this granularity. */
function latestOffer(negId) {
  return get(`SELECT * FROM offers WHERE negotiation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, negId);
}

/* ---------- open: brand makes the first offer ---------- */
function open(brand, body) {
  const v = U.need(body, {
    creator_id: U.V.str(5, 60),
    title: U.V.str(3, 120),
    brief: U.V.str(10, 4000),
    amount_cents: U.V.money(500, 100000000),
  });
  const opt = U.optional(body, { currency: U.V.oneOf(CURRENCIES), note: U.V.str(1, 500) });
  const creator = get(`SELECT * FROM users WHERE id = ? AND role = 'creator'`, v.creator_id);
  if (!creator) U.err(404, 'creator_not_found', 'No creator with that id');
  const currency = opt.currency || 'USD';
  return tx(() => {
    const nid = U.id('neg');
    run(`INSERT INTO negotiations (id, brand_id, creator_id, title, brief, currency, created_at) VALUES (?,?,?,?,?,?,?)`,
      nid, brand.id, v.creator_id, v.title, v.brief, currency, U.now());
    run(`INSERT INTO offers (id, negotiation_id, by_user, amount_cents, note, created_at) VALUES (?,?,?,?,?,?)`,
      U.id('off'), nid, brand.id, v.amount_cents, opt.note ?? null, U.now());
    audit(brand.id, 'negotiation.open', 'neg:' + nid, { amount_cents: v.amount_cents, currency });
    return view(brand, nid);
  });
}

/* ---------- counter: strict alternation ---------- */
function counter(user, negId, body) {
  const v = U.need(body, { amount_cents: U.V.money(500, 100000000) });
  const opt = U.optional(body, { note: U.V.str(1, 500) });
  return tx(() => {
    const n = loadNeg(negId);
    assertParty(n, user);
    if (n.status !== 'open') U.err(409, 'table_closed', `This negotiation is ${n.status} — no further offers`);
    const last = latestOffer(negId);
    if (last.by_user === user.id) U.err(409, 'your_offer_stands', 'Your offer is already on the table — wait for the other side');
    run(`UPDATE offers SET status = 'superseded' WHERE id = ?`, last.id);
    run(`INSERT INTO offers (id, negotiation_id, by_user, amount_cents, note, created_at) VALUES (?,?,?,?,?,?)`,
      U.id('off'), negId, user.id, v.amount_cents, opt.note ?? null, U.now());
    audit(user.id, 'negotiation.counter', 'neg:' + negId, { amount_cents: v.amount_cents, currency: n.currency });
    return view(user, negId);
  });
}

/* ---------- accept: only the counterparty of the standing offer ---------- */
function accept(user, negId) {
  return tx(() => {
    const n = loadNeg(negId);
    assertParty(n, user);
    if (n.status !== 'open') U.err(409, 'table_closed', `This negotiation is already ${n.status}`);
    const last = latestOffer(negId);
    if (last.by_user === user.id) U.err(409, 'cannot_accept_own', 'You cannot accept your own offer — only the other side can');
    run(`UPDATE offers SET status = 'accepted' WHERE id = ?`, last.id);
    // freeze the agreement: hash of the exact terms both sides saw.
    // currency is part of the hash — an amount without a unit is not a price.
    const terms = {
      negotiation_id: n.id, title: n.title, brief: n.brief,
      amount_cents: last.amount_cents, currency: n.currency,
      brand_id: n.brand_id, creator_id: n.creator_id,
      accepted_by: user.id, accepted_offer_id: last.id, accepted_at: U.now(),
      platform_fee_bps: require('./services').PLATFORM_FEE_BPS,
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(terms)).digest('hex');
    run(`UPDATE negotiations SET status='agreed', agreed_amount_cents=?, agreed_offer_id=?, terms_hash=?, agreed_at=? WHERE id=?`,
      last.amount_cents, last.id, hash, U.now(), negId);
    audit(user.id, 'negotiation.accept', 'neg:' + negId, { amount_cents: last.amount_cents, currency: n.currency, terms_hash: hash });
    return view(user, negId);
  });
}

function decline(user, negId) {
  return tx(() => {
    const n = loadNeg(negId);
    assertParty(n, user);
    if (n.status !== 'open') U.err(409, 'table_closed', `Already ${n.status}`);
    run(`UPDATE negotiations SET status='declined' WHERE id=?`, negId);
    audit(user.id, 'negotiation.decline', 'neg:' + negId);
    return view(user, negId);
  });
}

/* ---------- chat with redaction ---------- */
function message(user, negId, body) {
  const v = U.need(body, { text: U.V.str(1, 1000) });
  const n = loadNeg(negId);
  assertParty(n, user);
  const r = redact(v.text);
  run(`INSERT INTO nmessages (id, negotiation_id, by_user, text, redacted, created_at) VALUES (?,?,?,?,?,?)`,
    U.id('msg'), negId, user.id, r.text, r.redacted ? 1 : 0, U.now());
  if (r.redacted) audit(user.id, 'negotiation.contact_redacted', 'neg:' + negId);
  return { ok: true, redacted: r.redacted, text: r.text };
}

/* ---------- convert agreement → deal at the EXACT agreed price ---------- */
function toDeal(brand, negId) {
  return tx(() => {
    const n = loadNeg(negId);
    if (n.brand_id !== brand.id) U.err(403, 'not_your_table', 'Only the brand on this negotiation can fund it');
    if (n.status !== 'agreed') U.err(409, 'not_agreed', 'No agreement yet — a deal can only be created from an accepted offer');
    if (n.deal_id) return escrow.getDeal(brand, n.deal_id); // idempotent
    // amount AND currency come from the frozen agreement, never from input
    const deal = escrow.createDeal(brand, {
      creator_id: n.creator_id, title: n.title, brief: n.brief,
      amount_cents: n.agreed_amount_cents, currency: n.currency,
    });
    run(`UPDATE negotiations SET deal_id = ? WHERE id = ?`, deal.id, negId);
    audit(brand.id, 'negotiation.to_deal', 'neg:' + negId, { deal: deal.id, amount_cents: n.agreed_amount_cents, currency: n.currency });
    return deal;
  });
}

/* ---------- reads ---------- */
function money(n, amount) {
  if (amount == null) return null;
  const cur = n.currency || 'USD';
  return { amount_cents: amount, currency: cur, minor_unit: CURRENCY_MINOR[cur], display: `${CURRENCY_SYMBOL[cur] || ''}${(amount / 100).toFixed(2)}` };
}

function list(user) {
  const rows = all(`SELECT * FROM negotiations WHERE brand_id = ? OR creator_id = ? ORDER BY created_at DESC LIMIT 100`, user.id, user.id);
  return rows.map(n => ({ ...n, standing: latestOffer(n.id), agreed: money(n, n.agreed_amount_cents) }));
}

function view(user, negId) {
  const n = loadNeg(negId);
  assertParty(n, user);
  const offers = all(`SELECT o.*, u.name as by_name, u.role as by_role FROM offers o JOIN users u ON u.id=o.by_user WHERE negotiation_id = ? ORDER BY o.created_at ASC, o.rowid ASC`, negId);
  return {
    ...n,
    offers: offers.map(o => ({ ...o, currency: n.currency, display: money(n, o.amount_cents).display })),
    agreed: money(n, n.agreed_amount_cents),
    messages: all(`SELECT m.*, u.name as by_name FROM nmessages m JOIN users u ON u.id=m.by_user WHERE negotiation_id = ? ORDER BY m.created_at ASC, m.rowid ASC`, negId),
  };
}

module.exports = { open, counter, accept, decline, message, toDeal, list, view, redact };
