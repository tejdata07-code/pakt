// PAKT — roi.js — attribution: every funded deal gets a tracking code.
// Clicks hit GET /t/:code (redirect), conversions POST with revenue.
// The report answers the only question brands ask: "what did this deal earn me?"
'use strict';
const { get, all, run } = require('./db');
const U = require('./util');

function findByCode(code) {
  if (!U.isStr(code, 4, 40)) U.err(400, 'bad_code', 'Invalid tracking code');
  const d = get('SELECT * FROM deals WHERE tracking_code = ?', code);
  if (!d) U.err(404, 'not_found', 'Unknown tracking code');
  return d;
}

function recordClick(code) {
  const d = findByCode(code);
  run(`INSERT INTO track_events (id, deal_id, kind, revenue_cents, created_at) VALUES (?,?,?,0,?)`,
    U.id('evt'), d.id, 'click', U.now());
  return { redirect: d.content_url || 'https://instagram.com' };
}

function recordConversion(code, body) {
  const d = findByCode(code);
  const revenue = U.isInt(body?.revenue_cents, 0, 1e9) ? body.revenue_cents : 0;
  run(`INSERT INTO track_events (id, deal_id, kind, revenue_cents, created_at) VALUES (?,?,?,?,?)`,
    U.id('evt'), d.id, 'conversion', revenue, U.now());
  return { ok: true };
}

function report(user, dealId) {
  const d = get('SELECT * FROM deals WHERE id = ?', dealId);
  if (!d) U.err(404, 'not_found', 'Deal not found');
  if (d.brand_id !== user.id && d.creator_id !== user.id) U.err(403, 'not_your_deal', 'You are not a party to this deal');
  const clicks = get(`SELECT COUNT(*) c FROM track_events WHERE deal_id=? AND kind='click'`, d.id).c;
  const conv = get(`SELECT COUNT(*) c, COALESCE(SUM(revenue_cents),0) r FROM track_events WHERE deal_id=? AND kind='conversion'`, d.id);
  const spend = d.amount_cents;
  return {
    deal_id: d.id, title: d.title, state: d.state,
    tracking_code: d.tracking_code,
    tracking_url: d.tracking_code ? `/t/${d.tracking_code}` : null,
    clicks, conversions: conv.c, revenue_cents: conv.r, spend_cents: spend,
    roas: spend > 0 ? +(conv.r / spend).toFixed(2) : null,
    cost_per_click_cents: clicks > 0 ? Math.round(spend / clicks) : null,
  };
}

module.exports = { recordClick, recordConversion, report };
