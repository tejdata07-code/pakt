// PAKT — escrow.js — the money state machine. Every transition is explicit;
// anything not in TRANSITIONS is rejected. Money moves only inside tx().
//
//  DRAFT ──fund──▶ FUNDED ──submit──▶ CONTENT_SUBMITTED ──verify──▶ PAID
//                    │                      │        ▲
//                 cancel                 dispute   auto-release (72h)
//                    ▼                      ▼
//                REFUNDED               DISPUTED ──resolve──▶ PAID | REFUNDED
//                                            └── 7-day SLA ──▶ resolved by rule
'use strict';
const { get, all, run, tx, audit } = require('./db');
const U = require('./util');
const S = require('./services');
const { CURRENCIES } = require('./taxonomy');

const AUTO_RELEASE_MS = 1000 * 60 * 60 * 72;      // brands cannot ghost: 72h to act after submission
const DISPUTE_SLA_MS = 1000 * 60 * 60 * 24 * 7;   // and cannot freeze escrow by disputing and going quiet
const CREATOR_RESPONSE_MS = 1000 * 60 * 60 * 24 * 3; // creator's window to put their side on record

const TRANSITIONS = {
  DRAFT:             { fund: 'FUNDED' },
  FUNDED:            { submit: 'CONTENT_SUBMITTED', cancel: 'REFUNDED' },
  CONTENT_SUBMITTED: { verify: 'PAID', dispute: 'DISPUTED', auto_release: 'PAID' },
  DISPUTED:          { resolve_creator: 'PAID', resolve_brand: 'REFUNDED' },
  PAID: {}, REFUNDED: {}, // terminal
};

function assertTransition(deal, action) {
  const next = (TRANSITIONS[deal.state] || {})[action];
  if (!next) U.err(409, 'illegal_transition', `Cannot "${action}" a deal in state ${deal.state}`);
  return next;
}

function loadDeal(dealId) {
  const d = get('SELECT * FROM deals WHERE id = ?', dealId);
  if (!d) U.err(404, 'not_found', 'Deal not found');
  return d;
}

function assertParty(deal, user, party) {
  if (party === 'brand' && deal.brand_id !== user.id) U.err(403, 'not_your_deal', 'Only the brand on this deal can do that');
  if (party === 'creator' && deal.creator_id !== user.id) U.err(403, 'not_your_deal', 'Only the creator on this deal can do that');
}

// ---------- create (DRAFT) ----------
function createDeal(brand, body) {
  const v = U.need(body, {
    creator_id: U.V.str(5, 60),
    title: U.V.str(3, 120),
    brief: U.V.str(10, 4000),
    amount_cents: U.V.money(500, 100000000), // $5 min — hard floor against spam deals
  });
  const opt = U.optional(body, {
    currency: U.V.oneOf(CURRENCIES),
    deal_type: U.V.oneOf(['one_off', 'retainer']),
  });
  const creator = get('SELECT * FROM users WHERE id = ? AND role = ?', v.creator_id, 'creator');
  if (!creator) U.err(404, 'creator_not_found', 'No creator with that id');
  const did = U.id('deal');
  run(`INSERT INTO deals (id, brand_id, creator_id, title, brief, amount_cents, currency, deal_type, state, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'DRAFT', ?)`,
    did, brand.id, v.creator_id, v.title, v.brief, v.amount_cents,
    opt.currency || 'USD', opt.deal_type || 'one_off', U.now());
  audit(brand.id, 'deal.create', 'deal:' + did, { amount_cents: v.amount_cents, currency: opt.currency || 'USD', deal_type: opt.deal_type || 'one_off' });
  return loadDeal(did);
}

/* ---------- edit / delete, DRAFT only ----------
   A draft used to be immortal: no edit route, no delete route, and cancel
   rejected anything that was not FUNDED. A brand who fat-fingered an amount
   was stuck with it in their list, one click away from funding it. */
function assertDraft(deal, verb) {
  if (deal.state !== 'DRAFT') {
    U.err(409, 'illegal_transition',
      `Only a DRAFT deal can be ${verb} — this one is ${deal.state}. Once money is in escrow the terms are fixed.`);
  }
}

function updateDeal(brand, dealId, body) {
  const d = loadDeal(dealId);
  assertParty(d, brand, 'brand');
  assertDraft(d, 'edited');
  // A deal born from an accepted offer carries that agreement's price. Editing
  // it here would be exactly the side-channel the terms hash exists to prevent.
  if (get('SELECT id FROM negotiations WHERE deal_id = ?', d.id)) {
    U.err(409, 'from_agreement',
      'This deal came from an accepted offer, so its terms are frozen by that agreement. Delete it and re-open the table if the price has to change.');
  }
  const patch = U.optional(body, {
    title: U.V.str(3, 120),
    brief: U.V.str(10, 4000),
    amount_cents: U.V.money(500, 100000000),
    currency: U.V.oneOf(CURRENCIES),
    deal_type: U.V.oneOf(['one_off', 'retainer']),
  });
  const keys = Object.keys(patch);
  if (!keys.length) U.err(400, 'nothing_to_update', 'Send at least one of: title, brief, amount_cents, currency, deal_type');
  const before = {}; for (const k of keys) before[k] = d[k];
  run(`UPDATE deals SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...keys.map(k => patch[k]), d.id);
  audit(brand.id, 'deal.update', 'deal:' + d.id, { before, after: patch });
  return loadDeal(d.id);
}

function deleteDeal(brand, dealId) {
  return tx(() => {
    const d = loadDeal(dealId);
    assertParty(d, brand, 'brand');
    assertDraft(d, 'deleted');
    // belt and braces: a DRAFT should never have money against it
    if (get('SELECT id FROM ledger WHERE deal_id = ?', d.id)) {
      U.err(409, 'has_money', 'This deal has ledger entries and cannot be deleted');
    }
    run('UPDATE negotiations SET deal_id = NULL WHERE deal_id = ?', d.id); // let the table re-convert
    run('DELETE FROM deals WHERE id = ?', d.id);
    audit(brand.id, 'deal.delete', 'deal:' + d.id, { title: d.title, amount_cents: d.amount_cents, currency: d.currency });
    return { ok: true, deleted: d.id };
  });
}

// ---------- fund (money locked, idempotent) ----------
function fundDeal(brand, dealId, idempotencyKey) {
  if (!U.isStr(idempotencyKey, 8, 128)) U.err(400, 'idempotency_required', 'Idempotency-Key header required to move money (8+ characters)');
  return tx(() => {
    const existing = get('SELECT * FROM ledger WHERE idempotency_key = ?', idempotencyKey);
    if (existing) return loadDeal(existing.deal_id); // safe retry — no double charge
    const d = loadDeal(dealId);
    assertParty(d, brand, 'brand');
    assertTransition(d, 'fund');
    const charge = S.payments.chargeBrand({ amount_cents: d.amount_cents, currency: d.currency, deal_id: d.id });
    if (!charge.ok) U.err(502, 'charge_failed', 'Payment provider declined the charge');
    const code = 't' + U.id('c').slice(2, 10);
    run(`UPDATE deals SET state='FUNDED', funded_at=?, tracking_code=? WHERE id=?`, U.now(), code, d.id);
    ledgerWrite(d, 'fund', d.amount_cents, idempotencyKey);
    audit(brand.id, 'deal.fund', 'deal:' + d.id, { ref: charge.ref, amount_cents: d.amount_cents, currency: d.currency });
    return loadDeal(d.id);
  });
}

// every money row carries its own currency — deriving it later is guesswork
function ledgerWrite(deal, kind, amount_cents, idempotencyKey) {
  run(`INSERT INTO ledger (id, deal_id, kind, amount_cents, currency, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?)`,
    U.id('led'), deal.id, kind, amount_cents, deal.currency, idempotencyKey, U.now());
}

// ---------- submit content (creator) ----------
function submitContent(creator, dealId, body) {
  const v = U.need(body, { content_url: U.V.url(), caption: U.V.str(1, 4000) });
  const url = U.normalizeUrl(v.content_url); // "instagram.com/reel/x" is a link, not a validation error
  const d = loadDeal(dealId);
  assertParty(d, creator, 'creator');
  assertTransition(d, 'submit');
  const comp = S.complianceCheck(v.caption);
  // Non-compliant content is rejected BEFORE state change — protects the brand from FTC/ASCI exposure.
  if (!comp.ok) U.err(422, 'compliance_failed', comp.notes.join('; '));
  run(`UPDATE deals SET state='CONTENT_SUBMITTED', submitted_at=?, content_url=?, caption=?,
       compliance_ok=1, compliance_notes=?, auto_release_at=? WHERE id=?`,
    U.now(), url, v.caption, JSON.stringify(comp.notes), U.now() + AUTO_RELEASE_MS, d.id);
  audit(creator.id, 'deal.submit', 'deal:' + d.id, { content_url: url });
  return loadDeal(d.id);
}

// ---------- instant payout (shared by verify / auto-release / dispute win) ----------
function payout(deal, trigger) {
  const fee = S.feeFor(deal.amount_cents);
  const net = deal.amount_cents - fee;
  const key = `payout:${deal.id}`; // idempotent by design — a deal can pay out exactly once
  if (get('SELECT id FROM ledger WHERE idempotency_key = ?', key)) return;
  const p = S.payments.payoutCreator({ amount_cents: net, currency: deal.currency, deal_id: deal.id, creator_id: deal.creator_id });
  if (!p.ok) U.err(502, 'payout_failed', 'Payout provider error — funds remain safe in escrow');
  ledgerWrite(deal, 'fee', fee, `fee:${deal.id}`);
  ledgerWrite(deal, 'payout', net, key);
  audit(null, 'deal.payout', 'deal:' + deal.id, { net, fee, currency: deal.currency, trigger, ref: p.ref });
}

function verifyDeal(brand, dealId) {
  return tx(() => {
    const d = loadDeal(dealId);
    assertParty(d, brand, 'brand');
    assertTransition(d, 'verify');
    payout(d, 'brand_verified');
    run(`UPDATE deals SET state='PAID', verified_at=?, paid_at=? WHERE id=?`, U.now(), U.now(), d.id);
    return loadDeal(d.id);
  });
}

function cancelDeal(brand, dealId) {
  return tx(() => {
    const d = loadDeal(dealId);
    assertParty(d, brand, 'brand');
    assertTransition(d, 'cancel'); // only possible from FUNDED — never after content exists
    ledgerWrite(d, 'refund', d.amount_cents, `refund:${d.id}`);
    run(`UPDATE deals SET state='REFUNDED' WHERE id=?`, d.id);
    audit(brand.id, 'deal.cancel', 'deal:' + d.id);
    return loadDeal(d.id);
  });
}

// ---------- auto-release sweep: brands cannot sit on money ----------
function sweepAutoReleases() {
  const due = all(`SELECT * FROM deals WHERE state='CONTENT_SUBMITTED' AND auto_release_at IS NOT NULL AND auto_release_at <= ?`, U.now());
  for (const d of due) {
    tx(() => {
      const fresh = loadDeal(d.id);
      if (fresh.state !== 'CONTENT_SUBMITTED') return;
      payout(fresh, 'auto_release_72h');
      run(`UPDATE deals SET state='PAID', verified_at=?, paid_at=? WHERE id=?`, U.now(), U.now(), fresh.id);
    });
  }
  return due.length;
}

/* ================= DISPUTES =================
   Previously this was one-sided: only a brand could open one, the creator
   had no endpoint to answer, and an unresolved dispute nulled the
   auto-release clock — so a brand could freeze a creator's money forever
   just by disputing and going quiet. Now: the creator gets a response
   window, and every dispute carries a deadline the platform must meet. */

function loadDispute(disputeId) {
  const dsp = get('SELECT * FROM disputes WHERE id = ?', disputeId);
  if (!dsp) U.err(404, 'not_found', 'Dispute not found');
  return dsp;
}

function openDispute(brand, dealId, body) {
  const v = U.need(body, { reason: U.V.str(10, 2000) });
  const opt = U.optional(body, { evidence: U.V.str(1, 4000) });
  return tx(() => {
    const d = loadDeal(dealId);
    assertParty(d, brand, 'brand');
    assertTransition(d, 'dispute');
    run(`UPDATE deals SET state='DISPUTED', auto_release_at=NULL WHERE id=?`, d.id);
    const did = U.id('dsp');
    run(`INSERT INTO disputes (id, deal_id, opened_by, reason, evidence, deadline_at, created_at) VALUES (?,?,?,?,?,?,?)`,
      did, d.id, brand.id, v.reason, opt.evidence ?? null, U.now() + DISPUTE_SLA_MS, U.now());
    audit(brand.id, 'dispute.open', 'dispute:' + did, { deal: d.id });
    return withDeadlines(get('SELECT * FROM disputes WHERE id = ?', did));
  });
}

/* The creator's side of the record. Without this, "rule-based, no
   favoritism" decided money using only the accuser's account of events. */
function respondToDispute(creator, disputeId, body) {
  const v = U.need(body, { response: U.V.str(10, 2000) });
  const opt = U.optional(body, { evidence: U.V.str(1, 4000) });
  return tx(() => {
    const dsp = loadDispute(disputeId);
    const d = loadDeal(dsp.deal_id);
    assertParty(d, creator, 'creator');
    if (dsp.status !== 'open') U.err(409, 'already_resolved', 'This dispute is already resolved');
    if (dsp.responded_at) U.err(409, 'already_responded', 'You have already responded to this dispute');
    run(`UPDATE disputes SET creator_response=?, creator_evidence=?, responded_at=? WHERE id=?`,
      v.response, opt.evidence ?? null, U.now(), disputeId);
    audit(creator.id, 'dispute.respond', 'dispute:' + disputeId, { deal: d.id });
    return withDeadlines(loadDispute(disputeId));
  });
}

/* Rule-based resolution — deterministic, published, no favoritism:
   Content is live at the agreed URL + passed compliance  →  creator is paid.
   Brand's dispute must show a concrete brief violation to win.
   Only a PAKT operator can make this call (see requireAdmin on the route);
   it used to be an open endpoint that moved money with no token at all. */
function resolveDispute(resolver, disputeId, body) {
  const v = U.need(body, { brief_violated: U.V.bool(), note: U.V.str(5, 2000) });
  return tx(() => {
    const dsp = loadDispute(disputeId);
    if (dsp.status !== 'open') U.err(409, 'already_resolved', 'This dispute is already resolved');
    const d = loadDeal(dsp.deal_id);
    const creatorWins = d.compliance_ok === 1 && !v.brief_violated;
    settle(d, dsp, creatorWins, v.note, resolver ? resolver.id : null, 'operator_decision');
    return { dispute: withDeadlines(loadDispute(disputeId)), deal: loadDeal(d.id) };
  });
}

function settle(deal, dsp, creatorWins, note, resolverId, trigger) {
  assertTransition(deal, creatorWins ? 'resolve_creator' : 'resolve_brand');
  if (creatorWins) {
    payout(deal, 'dispute_resolved_creator');
    run(`UPDATE deals SET state='PAID', paid_at=? WHERE id=?`, U.now(), deal.id);
  } else {
    ledgerWrite(deal, 'refund', deal.amount_cents, `refund:${deal.id}`);
    run(`UPDATE deals SET state='REFUNDED' WHERE id=?`, deal.id);
  }
  run(`UPDATE disputes SET status=?, resolution_note=?, resolved_at=? WHERE id=?`,
    creatorWins ? 'resolved_creator' : 'resolved_brand', note, U.now(), dsp.id);
  audit(resolverId, 'dispute.resolve', 'dispute:' + dsp.id, { creatorWins, trigger, deal: deal.id });
}

/* SLA sweep — warns, then escalates. It never moves money.

   An earlier version auto-settled at the deadline: compliant content plus any
   creator response meant the creator was paid. That rewarded a creator who
   under-delivered the brief and then filed a one-line non-answer, because the
   rule tested compliance and responsiveness and never tested delivery.
   Delivery is a judgement call, which is precisely what an operator is for.

   So the deadline now produces an escalation and a loud record, not a payout.
   Funds stay in escrow. The brand still cannot make the money disappear by
   going quiet — the dispute is visibly breaching its SLA and sitting in the
   operator queue — but nobody wins by default either. */
const SLA_WARN_BEFORE_MS = 1000 * 60 * 60 * 24; // 24h heads-up

const hasOperators = () => get(`SELECT COUNT(*) c FROM users WHERE is_admin = 1`).c > 0;

function sweepDisputeDeadlines() {
  // Escalating to an empty room is theatre. If no operator account exists,
  // say so rather than manufacturing SLA breaches nobody can act on.
  if (!hasOperators()) {
    return { skipped: true, reason: 'no operator accounts configured (set PAKT_ADMIN_EMAILS)', warned: 0, escalated: 0 };
  }
  const now = U.now();
  let warned = 0, escalated = 0;
  const open = all(`SELECT * FROM disputes WHERE status='open' AND deadline_at IS NOT NULL`);
  for (const dsp of open) {
    if (dsp.deadline_at <= now && !dsp.escalated_at) {
      run(`UPDATE disputes SET escalated_at = ? WHERE id = ?`, now, dsp.id);
      audit(null, 'dispute.sla_breached', 'dispute:' + dsp.id,
        { deal: dsp.deal_id, overdue_hours: Math.round((now - dsp.deadline_at) / 3600000), funds: 'held_in_escrow' });
      escalated++;
    } else if (dsp.deadline_at - now <= SLA_WARN_BEFORE_MS && !dsp.sla_warned_at) {
      run(`UPDATE disputes SET sla_warned_at = ? WHERE id = ?`, now, dsp.id);
      audit(null, 'dispute.sla_warning', 'dispute:' + dsp.id,
        { deal: dsp.deal_id, hours_left: Math.round((dsp.deadline_at - now) / 3600000) });
      warned++;
    }
  }
  return { skipped: false, warned, escalated };
}

function sweep() { return { deals: sweepAutoReleases(), disputes: sweepDisputeDeadlines() }; }

function withDeadlines(dsp) {
  if (!dsp) return dsp;
  const overdue = dsp.status === 'open' && dsp.deadline_at && dsp.deadline_at <= U.now();
  return {
    ...dsp,
    creator_respond_by: dsp.created_at ? dsp.created_at + CREATOR_RESPONSE_MS : null,
    resolve_by: dsp.deadline_at,
    sla_breached: !!overdue,
    funds: dsp.status === 'open' ? 'held_in_escrow' : 'released',
    rule: 'Compliant content that is live at the agreed URL is paid unless the brand shows a concrete brief violation.',
    sla_note: 'If the deadline passes without a decision, this dispute is escalated and the funds stay in escrow. Neither side wins by waiting.',
  };
}

function getDispute(user, disputeId) {
  const dsp = loadDispute(disputeId);
  const d = loadDeal(dsp.deal_id);
  if (d.brand_id !== user.id && d.creator_id !== user.id && !user.is_admin) {
    U.err(403, 'not_your_deal', 'You are not a party to this dispute');
  }
  return { ...withDeadlines(dsp), deal: d };
}

function listDisputes(user, status) {
  if (user.is_admin) {
    const rows = status === 'escalated'
      ? all(`SELECT * FROM disputes WHERE status='open' AND escalated_at IS NOT NULL ORDER BY deadline_at ASC LIMIT 200`)
      : status
        ? all(`SELECT * FROM disputes WHERE status = ? ORDER BY deadline_at ASC LIMIT 200`, status)
        : all(`SELECT * FROM disputes ORDER BY (status='open') DESC, escalated_at IS NOT NULL DESC, deadline_at ASC LIMIT 200`);
    return rows.map(withDeadlines);
  }
  const col = user.role === 'brand' ? 'brand_id' : 'creator_id';
  return all(`SELECT ds.* FROM disputes ds JOIN deals d ON d.id = ds.deal_id
              WHERE d.${col} = ? ORDER BY ds.created_at DESC LIMIT 100`, user.id).map(withDeadlines);
}

// ---------- reads ----------
function listDeals(user) {
  sweep();
  const col = user.role === 'brand' ? 'brand_id' : 'creator_id';
  return all(`SELECT * FROM deals WHERE ${col} = ? ORDER BY created_at DESC LIMIT 200`, user.id);
}

function getDeal(user, dealId) {
  sweep();
  const d = loadDeal(dealId);
  if (d.brand_id !== user.id && d.creator_id !== user.id) U.err(403, 'not_your_deal', 'You are not a party to this deal');
  const dsp = get(`SELECT * FROM disputes WHERE deal_id = ? ORDER BY created_at DESC LIMIT 1`, d.id);
  return dsp ? { ...d, dispute: withDeadlines(dsp) } : d;
}

/* The wallet used to return one number: net. The 12% fee was recorded in
   the ledger and shown to nobody, so a creator could not reconcile their
   own invoice without reading a raw system log. */
function wallet(creator) {
  sweep();
  const rows = all(
    `SELECT l.id, l.amount_cents AS net_cents, l.currency, l.created_at,
            d.id AS deal_id, d.title, d.amount_cents AS gross_cents
     FROM ledger l JOIN deals d ON d.id = l.deal_id
     WHERE d.creator_id = ? AND l.kind = 'payout' ORDER BY l.created_at DESC LIMIT 100`, creator.id);

  const payouts = rows.map(r => ({
    id: r.id, deal_id: r.deal_id, title: r.title,
    currency: r.currency || 'USD',
    gross_cents: r.gross_cents,
    platform_fee_cents: r.gross_cents - r.net_cents,
    net_cents: r.net_cents,
    paid_at: r.created_at,
  }));

  const byCurrency = {};
  for (const p of payouts) {
    const c = (byCurrency[p.currency] ||= { currency: p.currency, payouts: 0, gross_cents: 0, platform_fee_cents: 0, net_cents: 0 });
    c.payouts++; c.gross_cents += p.gross_cents; c.platform_fee_cents += p.platform_fee_cents; c.net_cents += p.net_cents;
  }
  const currencies = Object.keys(byCurrency);

  return {
    totals_by_currency: Object.values(byCurrency),
    // kept for existing clients; only meaningful when a single currency is in play
    total_paid_cents: payouts.reduce((s, p) => s + p.net_cents, 0),
    currency: currencies.length === 1 ? currencies[0] : currencies.length === 0 ? null : 'MIXED',
    platform_fee_bps: S.PLATFORM_FEE_BPS,
    fee_note: `PAKT deducts ${S.PLATFORM_FEE_BPS / 100}% at payout. Amounts are integer minor units. Income tax, TDS and GST on your earnings are yours to file — use gross_cents as the invoice value.`,
    payouts,
    payout_speed: 'instant_on_verification',
  };
}

module.exports = {
  createDeal, updateDeal, deleteDeal, fundDeal, submitContent, verifyDeal, cancelDeal,
  openDispute, respondToDispute, resolveDispute, getDispute, listDisputes,
  listDeals, getDeal, wallet,
  sweepAutoReleases, sweepDisputeDeadlines, sweep, hasOperators,
  AUTO_RELEASE_MS, DISPUTE_SLA_MS, CREATOR_RESPONSE_MS,
};
