// PAKT — test.js — end-to-end proof the state machine is strict.
// Run: node test.js   (uses a throwaway DB, spins the real server)
'use strict';
process.env.PAKT_DB = '/tmp/pakt_test.db';
process.env.PORT = '4123';
process.env.PAKT_ADMIN_EMAILS = 'ops@pakt.test';
process.env.PAKT_RATE_LIMIT = '10000'; // the whole suite is one IP
process.env.PAKT_RATE_LIMIT_AUTH = '10000';
process.env.PAKT_RATE_LIMIT_MONEY = '10000';
process.env.PAKT_RATE_LIMIT_WRITE = '10000';
const fs = require('node:fs');
for (const f of ['/tmp/pakt_test.db', '/tmp/pakt_test.db-wal', '/tmp/pakt_test.db-shm']) { try { fs.unlinkSync(f); } catch {} }

const { server } = require('./server');
const { run, get } = require('./lib/db');
const escrow = require('./lib/escrow');

const BASE = 'http://localhost:4123';
let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log('  ✔', name); } else { failed++; console.log('  ✘ FAIL:', name); } };

async function api(method, path, { token, body, idem } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  await new Promise(r => server.listen(4123, r));
  console.log('\n— auth —');
  const brand = (await api('POST', '/api/signup', { body: { role: 'brand', name: 'Kova Coffee', email: 'kova@test.com', password: 'brewsecure1' } })).json;
  const creator = (await api('POST', '/api/signup', { body: { role: 'creator', name: 'Ria Vlogs', email: 'ria@test.com', password: 'riacreates1', handle: '@riavlogs', niche: 'food', followers: 42000, avg_likes: 2600, avg_comments: 140, account_age_months: 30 } })).json;
  ok(brand.token && creator.token, 'signup returns tokens for both roles');
  const dup = await api('POST', '/api/signup', { body: { role: 'brand', name: 'Xy Brand', email: 'kova@test.com', password: 'whatever12' } });
  ok(dup.status === 409, 'duplicate email rejected (409)');
  const badLogin = await api('POST', '/api/login', { body: { email: 'kova@test.com', password: 'wrongpass1' } });
  ok(badLogin.status === 401, 'wrong password rejected (401)');
  const noAuth = await api('GET', '/api/deals');
  ok(noAuth.status === 401, 'no token rejected (401)');

    const admin = (await api('POST', '/api/signup', { body: { role: 'brand', name: 'PAKT Ops', email: 'ops@pakt.test', password: 'opssecure12' } })).json;
  ok(admin.user.is_admin === true, 'operator promoted by PAKT_ADMIN_EMAILS, never by request body');
  const fakeAdmin = await api('POST', '/api/signup', { body: { role: 'brand', name: 'Sneaky', email: 'sneaky@test.com', password: 'sneaky12345', is_admin: true, role_admin: true } });
  ok(fakeAdmin.json.user.is_admin === false, 'is_admin cannot be smuggled in through signup');

  console.log('\n— discovery: fraud score + benchmarks —');
  const creators = (await api('GET', '/api/creators', { token: brand.token })).json;
  ok(Array.isArray(creators) && creators[0].authenticity && typeof creators[0].authenticity.score === 'number', 'creators list includes authenticity score');
  ok(creators[0].benchmark && creators[0].benchmark.low_cents > 0, 'creators list includes rate benchmark');
  ok(creators[0].email === undefined && creators[0].pass_hash === undefined, 'emails and hashes never leak');

  console.log('\n— escrow lifecycle —');
  const deal = (await api('POST', '/api/deals', { token: brand.token, body: { creator_id: creator.user.id, title: 'Reel: new cold brew', brief: 'One 30s reel featuring the summer cold brew line, tag @kovacoffee.', amount_cents: 18000 } })).json;
  ok(deal.state === 'DRAFT', 'deal created in DRAFT');
  const submitTooEarly = await api('POST', `/api/deals/${deal.id}/submit`, { token: creator.token, body: { content_url: 'https://instagram.com/p/x', caption: 'love it #ad' } });
  ok(submitTooEarly.status === 409, 'cannot submit before funding (409 illegal_transition)');
  const noIdem = await api('POST', `/api/deals/${deal.id}/fund`, { token: brand.token });
  ok(noIdem.status === 400, 'funding without Idempotency-Key rejected');
  const funded = (await api('POST', `/api/deals/${deal.id}/fund`, { token: brand.token, idem: 'fund-001' })).json;
  ok(funded.state === 'FUNDED' && funded.tracking_code, 'funded → FUNDED with tracking code');
  const refund2 = (await api('POST', `/api/deals/${deal.id}/fund`, { token: brand.token, idem: 'fund-001' })).json;
  ok(refund2.state === 'FUNDED', 'idempotent retry does not double-charge');
  const creatorFund = await api('POST', `/api/deals/${deal.id}/fund`, { token: creator.token, idem: 'fund-002' });
  ok(creatorFund.status === 403, 'creator cannot fund a deal (role guard)');

  const noDisclosure = await api('POST', `/api/deals/${deal.id}/submit`, { token: creator.token, body: { content_url: 'https://instagram.com/p/abc', caption: 'best coffee ever!!' } });
  ok(noDisclosure.status === 422, 'missing #ad disclosure blocked (compliance autopilot)');
  const submitted = (await api('POST', `/api/deals/${deal.id}/submit`, { token: creator.token, body: { content_url: 'https://instagram.com/p/abc', caption: 'Obsessed with the new cold brew ☕ #ad @kovacoffee' } })).json;
  ok(submitted.state === 'CONTENT_SUBMITTED' && submitted.auto_release_at > Date.now(), 'submitted with 72h auto-release armed');

  console.log('\n— ROI attribution —');
  const click = await api('GET', `/t/${funded.tracking_code}`);
  ok(click.status === 302, 'tracking link records click and redirects');
  await api('POST', `/api/track/${funded.tracking_code}/convert`, { body: { revenue_cents: 45000 } });
  await api('POST', `/api/track/${funded.tracking_code}/convert`, { body: { revenue_cents: 30000 } });
  const roiRep = (await api('GET', `/api/deals/${deal.id}/roi`, { token: brand.token })).json;
  ok(roiRep.clicks === 1 && roiRep.conversions === 2 && roiRep.revenue_cents === 75000, 'ROI report counts clicks/conversions/revenue');
  ok(roiRep.roas === +(75000 / 18000).toFixed(2), 'ROAS computed correctly');

  console.log('\n— instant payout on verify —');
  const paid = (await api('POST', `/api/deals/${deal.id}/verify`, { token: brand.token })).json;
  ok(paid.state === 'PAID' && paid.paid_at, 'verify → PAID instantly');
  const wallet = (await api('GET', '/api/wallet', { token: creator.token })).json;
  ok(wallet.total_paid_cents === 18000 - Math.floor(18000 * 0.12), 'creator wallet shows net payout (12% transparent fee)');
  const doubleVerify = await api('POST', `/api/deals/${deal.id}/verify`, { token: brand.token });
  ok(doubleVerify.status === 409, 'PAID is terminal — cannot verify twice');

  console.log('\n— dispute path (rule-based) —');
  const deal2 = (await api('POST', '/api/deals', { token: brand.token, body: { creator_id: creator.user.id, title: 'Story set', brief: '3 stories with swipe-up on launch day, morning slot.', amount_cents: 9000 } })).json;
  await api('POST', `/api/deals/${deal2.id}/fund`, { token: brand.token, idem: 'fund-deal2-key' });
  await api('POST', `/api/deals/${deal2.id}/submit`, { token: creator.token, body: { content_url: 'https://instagram.com/p/story2', caption: 'launch day! #sponsored' } });
  const dsp = (await api('POST', `/api/deals/${deal2.id}/dispute`, { token: brand.token, body: { reason: 'Posted in the evening, brief said morning slot.' } })).json;
  ok(dsp.status === 'open', 'brand can open dispute after submission');
  const noTokenResolve = await api('POST', `/api/disputes/${dsp.id}/resolve`, { body: { brief_violated: false, note: 'Content live, compliant, brief substantially met.' } });
  ok(noTokenResolve.status === 401, 'resolving a dispute with NO token is rejected (was wide open — it moved money)');
  const brandResolve = await api('POST', `/api/disputes/${dsp.id}/resolve`, { token: brand.token, body: { brief_violated: true, note: 'I would like my money back please.' } });
  ok(brandResolve.status === 403, 'the accusing brand cannot resolve its own dispute');
  const creatorReply = (await api('POST', `/api/disputes/${dsp.id}/respond`, { token: creator.token, body: { response: 'Posted 8:40am as agreed, timestamp is on the story archive.', evidence: 'screenshot-url' } })).json;
  ok(creatorReply.responded_at > 0, 'creator can put their side of a dispute on record');
  const dblReply = await api('POST', `/api/disputes/${dsp.id}/respond`, { token: creator.token, body: { response: 'saying it again louder for the record' } });
  ok(dblReply.status === 409, 'creator cannot respond twice');
  const queue = (await api('GET', '/api/disputes?status=open', { token: admin.token })).json;
  ok(Array.isArray(queue) && queue.some(d => d.id === dsp.id), 'operators get a queue of open disputes to work');
  const seenByCreator = (await api('GET', `/api/disputes/${dsp.id}`, { token: creator.token })).json;
  ok(seenByCreator.rule && seenByCreator.resolve_by > 0, 'both parties see the published rule and the resolution deadline');
  const res1 = (await api('POST', `/api/disputes/${dsp.id}/resolve`, { token: admin.token, body: { brief_violated: false, note: 'Content live, compliant, brief substantially met.' } })).json;
  ok(res1.deal.state === 'PAID', 'compliant creator wins dispute → paid (no ghosting possible)');

  console.log('\n— auto-release: brands cannot sit on money —');
  const deal3 = (await api('POST', '/api/deals', { token: brand.token, body: { creator_id: creator.user.id, title: 'UGC video', brief: 'One 20s UGC clip for ads usage, product in frame.', amount_cents: 12000 } })).json;
  await api('POST', `/api/deals/${deal3.id}/fund`, { token: brand.token, idem: 'fund-deal3-key' });
  await api('POST', `/api/deals/${deal3.id}/submit`, { token: creator.token, body: { content_url: 'https://instagram.com/p/ugc3', caption: 'so good #ad' } });
  run('UPDATE deals SET auto_release_at = ? WHERE id = ?', Date.now() - 1000, deal3.id); // simulate 72h passing
  const swept = escrow.sweepAutoReleases();
  ok(swept >= 1, 'sweep releases overdue deals');
  const d3 = (await api('GET', `/api/deals/${deal3.id}`, { token: creator.token })).json;
  ok(d3.state === 'PAID', '72h silence → creator auto-paid');

  console.log('\n— cancel only before content —');
  const deal4 = (await api('POST', '/api/deals', { token: brand.token, body: { creator_id: creator.user.id, title: 'Cancelled promo', brief: 'A reel we will cancel before any work happens.', amount_cents: 7000 } })).json;
  await api('POST', `/api/deals/${deal4.id}/fund`, { token: brand.token, idem: 'fund-deal4-key' });
  const cancelled = (await api('POST', `/api/deals/${deal4.id}/cancel`, { token: brand.token })).json;
  ok(cancelled.state === 'REFUNDED', 'brand can cancel a FUNDED deal (refund)');
  const cancelPaid = await api('POST', `/api/deals/${deal.id}/cancel`, { token: brand.token });
  ok(cancelPaid.status === 409, 'cannot cancel after payout');

  console.log('\n— hardening —');
  const badJson = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  ok(badJson.status === 400, 'malformed JSON rejected');
  const audit = (await api('GET', '/api/audit', { token: brand.token })).json;
  ok(audit.length > 5 && audit.some(a => a.action === 'deal.payout'), 'every money movement is in the audit log');

  console.log('\n— creator studio —');
  const ins = (await api('GET', '/api/studio/insights', { token: creator.token })).json;
  ok(ins.headline_insights?.length === 3 && ins.heatmap?.values?.length === 7, 'insights: 3 headlines + 7-day heatmap');
  const ins2 = (await api('GET', '/api/studio/insights', { token: creator.token })).json;
  ok(JSON.stringify(ins.golden_window) === JSON.stringify(ins2.golden_window), 'insights are stable per creator (seeded)');
  const hook = (await api('POST', '/api/studio/hook', { token: creator.token, body: { text: 'Why do 3 out of 4 cafes fail their first year?' } })).json;
  ok(hook.score >= 75, 'strong hook (question+number+curiosity) scores 75+');
  const weak = (await api('POST', '/api/studio/hook', { token: creator.token, body: { text: 'hey guys welcome back to another video today we will talk about food again' } })).json;
  ok(weak.score < 50, 'generic opener hook scores low');
  const cap = (await api('POST', '/api/studio/caption', { token: creator.token, body: { caption: 'Full recipe for this street food breakfast — save this for your next cafe run! #hyderabadfood #streetfood #ad', niche: 'food' } })).json;
  ok(cap.score >= 70 && cap.keywords_found.length >= 2, 'good caption passes preflight with keywords');
  const ideasRes = (await api('GET', '/api/studio/ideas', { token: creator.token })).json;
  ok(Array.isArray(ideasRes) && ideasRes.length === 5 && ideasRes[0].idea, 'idea engine returns 5 daily ideas');
  const rd = (await api('POST', '/api/studio/reach', { token: creator.token, body: { views_before: 10000, views_now: 4000, posts_per_week: 1, reels_pct: 20 } })).json;
  ok(rd.diagnoses.length >= 2 && rd.reach_change_pct === -60, 'reach doctor diagnoses stale mix + low cadence');
  const kit = (await api('GET', '/api/studio/mediakit', { token: creator.token })).json;
  ok(kit.authenticity > 0 && kit.deals_completed >= 3 && kit.total_earned_cents > 0, 'media kit compiles verified stats from deal history');
  const brandStudio = await api('GET', '/api/studio/insights', { token: brand.token });
  ok(brandStudio.status === 403, 'studio insights are creator-only');

  console.log('\n— the table: negotiation —');
  const neg = (await api('POST', '/api/negotiations', { token: brand.token, body: { creator_id: creator.user.id, title: 'Diwali launch reel', brief: 'One 30s reel for the Diwali collection, posted launch week.', amount_cents: 20000, note: 'Our standard rate for this scope.' } })).json;
  ok(neg.status === 'open' && neg.offers.length === 1, 'brand opens with first offer on the ledger');
  const selfAccept = await api('POST', `/api/negotiations/${neg.id}/accept`, { token: brand.token });
  ok(selfAccept.status === 409, 'cannot accept your own offer');
  const doubleOffer = await api('POST', `/api/negotiations/${neg.id}/counter`, { token: brand.token, body: { amount_cents: 21000 } });
  ok(doubleOffer.status === 409, 'strict alternation — cannot counter your own standing offer');
  const c1 = (await api('POST', `/api/negotiations/${neg.id}/counter`, { token: creator.token, body: { amount_cents: 32000, note: 'Launch-week slots are premium.' } })).json;
  ok(c1.offers.length === 2 && c1.offers[0].status === 'superseded', 'creator counters; old offer marked superseded');
  const c2 = (await api('POST', `/api/negotiations/${neg.id}/counter`, { token: brand.token, body: { amount_cents: 26000 } })).json;
  ok(c2.offers.length === 3, 'brand counters back — full history preserved');
  const msg = (await api('POST', `/api/negotiations/${neg.id}/message`, { token: creator.token, body: { text: 'call me on +91 98765 43210 or ria@gmail.com to settle this' } })).json;
  ok(msg.redacted === true, 'contact info in chat gets redacted');
  const vw = (await api('GET', `/api/negotiations/${neg.id}`, { token: brand.token })).json;
  ok(!/98765|gmail/.test(JSON.stringify(vw.messages)), 'redacted contacts never stored or shown');
  const acc = (await api('POST', `/api/negotiations/${neg.id}/accept`, { token: creator.token })).json;
  ok(acc.status === 'agreed' && acc.agreed_amount_cents === 26000 && acc.terms_hash?.length === 64, 'accept freezes agreement at ₹ standing offer + SHA-256 terms hash');
  const lateCounter = await api('POST', `/api/negotiations/${neg.id}/counter`, { token: brand.token, body: { amount_cents: 24000 } });
  ok(lateCounter.status === 409, 'table closed after agreement — no post-hoc price changes');
  const negDeal = (await api('POST', `/api/negotiations/${neg.id}/to-deal`, { token: brand.token })).json;
  ok(negDeal.amount_cents === 26000 && negDeal.state === 'DRAFT', 'FOOL-PROOF: deal auto-created at EXACTLY the agreed price');
  const negDeal2 = (await api('POST', `/api/negotiations/${neg.id}/to-deal`, { token: brand.token })).json;
  ok(negDeal2.id === negDeal.id, 'to-deal is idempotent — one agreement, one deal');


  console.log('\n— P0: the audit log is scoped, not a public feed —');
  const rival = (await api('POST', '/api/signup', { body: { role: 'creator', name: 'Rival Creator', email: 'rival@test.com', password: 'rivalpass12', handle: 'rivalcreator', niche: 'beauty', followers: 60000, avg_likes: 3000, avg_comments: 150 } })).json;
  const rivalAudit = (await api('GET', '/api/audit', { token: rival.token })).json;
  ok(rivalAudit.every(a => a.actor_id === rival.user.id || String(a.entity).includes(rival.user.id)),
    'a creator sees only events they are a party to');
  ok(!JSON.stringify(rivalAudit).includes('26000') && !JSON.stringify(rivalAudit).includes('18000'),
    "other creators' negotiated amounts and payouts are not readable");
  const ownAudit = (await api('GET', '/api/audit', { token: creator.token })).json;
  ok(ownAudit.some(a => a.action === 'deal.payout' && a.detail && typeof a.detail === 'object'),
    'your own payout events are still visible, with detail parsed as JSON');
  const adminAudit = (await api('GET', '/api/audit', { token: admin.token })).json;
  ok(adminAudit.length > rivalAudit.length, 'operators still see the whole trail');

  console.log('\n— P0: a wrong signup is no longer permanent —');
  run('UPDATE users SET followers=0, avg_likes=0, avg_comments=0, stats_updated_at=NULL WHERE id=?', rival.user.id);
  const asSeen = (await api('GET', '/api/creators', { token: brand.token })).json.find(c => c.id === rival.user.id);
  ok(asSeen.authenticity.tier === 'unverified' && asSeen.authenticity.score === null,
    'missing stats read as "unverified" — not 45/100 "high_risk" for data we never had');
  ok(asSeen.benchmark.low_cents === null, 'no follower count means no rate band, rather than a $20 one');
  const gated = await api('GET', '/api/studio/insights', { token: rival.token });
  ok(gated.status === 409 && gated.json.error === 'stats_missing', 'Studio asks for numbers instead of inventing them');
  const fixed = (await api('PATCH', '/api/me', { token: rival.token, body: { followers: 480000, avg_likes: 24000, avg_comments: 900, city: 'Mumbai' } })).json;
  ok(fixed.user.followers === 480000 && fixed.user.city === 'Mumbai', 'creator can correct their own profile');
  const rescored = (await api('GET', '/api/creators', { token: brand.token })).json.find(c => c.id === rival.user.id);
  ok(rescored.authenticity.tier === 'verified' && rescored.benchmark.low_cents > 0, 'corrected profile is scored and priced immediately');
  const unlocked = (await api('GET', '/api/studio/insights', { token: rival.token })).json;
  ok(unlocked.post_autopsies[0].reach > 0, 'Studio stops reporting "reach: 0" once the numbers exist');
  const brandEdit = await api('PATCH', '/api/me', { token: brand.token, body: { followers: 999999 } });
  ok(brandEdit.status === 400, 'a brand cannot give itself audience stats');
  const emptyPatch = await api('PATCH', '/api/me', { token: rival.token, body: {} });
  ok(emptyPatch.status === 400 && /can update/.test(emptyPatch.json.message), 'an empty patch says what is editable');

  console.log('\n— P2: validation is strict and explains itself —');
  const badRole = await api('POST', '/api/signup', { body: { role: 'influencer', name: 'Ritika M', email: 'r1@test.com', password: 'ritika123' } });
  ok(/brand, creator/.test(badRole.json.message), 'invalid enum lists the values that would work');
  const shortPw = await api('POST', '/api/signup', { body: { role: 'creator', name: 'Ritika M', email: 'r2@test.com', password: 'short' } });
  ok(/8 characters/.test(shortPw.json.message), 'password rule is stated, not implied');
  const noStats = await api('POST', '/api/signup', { body: { role: 'creator', name: 'Ritika M', email: 'r3@test.com', password: 'ritika123' } });
  ok(noStats.status === 400 && noStats.json.error === 'stats_required', 'creators cannot sign up into an unhireable blank profile');
  const pctGrowth = await api('POST', '/api/signup', { body: { role: 'creator', name: 'AJ Bose', email: 'r4@test.com', password: 'ajtech12345', handle: 'aj', niche: 'tech', followers: 210000, avg_likes: 5000, avg_comments: 200, growth_30d: 60 } });
  ok(pctGrowth.status === 400 && /percentage/.test(pctGrowth.json.message),
    'growth_30d: 60 is rejected, not silently zeroed into a clean fraud score');
  const brandStats = await api('POST', '/api/signup', { body: { role: 'brand', name: 'Confused Co', email: 'r5@test.com', password: 'confused123', followers: 5000 } });
  ok(brandStats.status === 400 && brandStats.json.error === 'not_for_this_role', 'brands are told these fields are not theirs');

  console.log('\n— P2: the score cannot be gamed by typing bigger numbers —');
  const inflated = (await api('POST', '/api/signup', { body: { role: 'creator', name: 'Inflated Ian', email: 'ian@test.com', password: 'ianpass1234', handle: 'ian', niche: 'tech', followers: 210000, avg_likes: 45000, avg_comments: 30 } })).json;
  const ianSeen = (await api('GET', '/api/creators', { token: brand.token })).json.find(c => c.id === inflated.user.id);
  ok(ianSeen.authenticity.tier !== 'verified', 'a 21% engagement rate at 210k followers no longer reads as "verified"');
  ok(ianSeen.authenticity.flags.some(f => /implausible/.test(f)), 'the score says why, in words a brand can act on');
  ok(ianSeen.authenticity.verification === 'self_reported', 'unbacked numbers are labelled self-reported');

  console.log('\n— P3: creators paste links the way Instagram gives them —');
  const deal5 = (await api('POST', '/api/deals', { token: brand.token, body: { creator_id: creator.user.id, title: 'Link normalization', brief: 'A reel where the creator pastes a bare link from the share sheet.', amount_cents: 6000 } })).json;
  await api('POST', '/api/deals/' + deal5.id + '/fund', { token: brand.token, idem: 'fund-deal5-key' });
  const bare = (await api('POST', '/api/deals/' + deal5.id + '/submit', { token: creator.token, body: { content_url: 'instagram.com/reel/Cx8kLm2', caption: 'monsoon chai run #ad' } })).json;
  ok(bare.state === 'CONTENT_SUBMITTED' && bare.content_url === 'https://instagram.com/reel/Cx8kLm2',
    'a scheme-less link is normalized, not rejected as an invalid field');
  const junkUrl = await api('POST', '/api/deals/' + deal5.id + '/submit', { token: creator.token, body: { content_url: 'not a link', caption: 'x #ad' } });
  ok(/instagram\.com/.test(junkUrl.json.message), 'a genuinely bad link gets an example of a good one');

  console.log('\n— P1: an amount without a unit is not a price —');
  const badCur = await api('POST', '/api/negotiations', { token: brand.token, body: { creator_id: creator.user.id, title: 'Bad currency', brief: 'Testing the currency whitelist on the table.', amount_cents: 5000, currency: 'RUPEES' } });
  ok(/USD, INR/.test(badCur.json.message), 'currency is validated against a list the error names');
  const negI = (await api('POST', '/api/negotiations', { token: brand.token, body: { creator_id: creator.user.id, title: 'Protein chai launch', brief: 'One reel plus one carousel for the Diwali protein range.', amount_cents: 250000, currency: 'INR', note: 'in rupees' } })).json;
  ok(negI.currency === 'INR' && negI.offers[0].display.startsWith('₹'), 'the table carries a currency and shows it on every offer');
  const accI = (await api('POST', '/api/negotiations/' + negI.id + '/accept', { token: creator.token })).json;
  ok(accI.agreed.currency === 'INR', 'the frozen agreement records the unit alongside the amount');
  const dealI = (await api('POST', '/api/negotiations/' + negI.id + '/to-deal', { token: brand.token })).json;
  ok(dealI.currency === 'INR' && dealI.amount_cents === 250000,
    'INR agreement becomes an INR deal — it used to silently become USD');
  await api('POST', '/api/deals/' + dealI.id + '/fund', { token: brand.token, idem: 'fund-inr-deal' });
  await api('POST', '/api/deals/' + dealI.id + '/submit', { token: creator.token, body: { content_url: 'https://instagram.com/reel/inr1', caption: 'protein chai, full macros in the carousel. Paid partnership. #ad' } });
  await api('POST', '/api/deals/' + dealI.id + '/verify', { token: brand.token });

  console.log('\n— P1: the creator can reconcile their own invoice —');
  const w = (await api('GET', '/api/wallet', { token: creator.token })).json;
  const inr = w.totals_by_currency.find(t => t.currency === 'INR');
  ok(inr.gross_cents === 250000 && inr.platform_fee_cents === 30000 && inr.net_cents === 220000,
    'wallet shows gross to 12% fee to net, per currency');
  ok(w.currency === 'MIXED' && w.totals_by_currency.length === 2, 'mixed-currency earnings are not summed into one meaningless number');
  ok(w.platform_fee_bps === 1200 && /GST/.test(w.fee_note), 'the fee and the tax position are stated, not buried in the ledger');
  ok(w.payouts.every(p => p.currency && p.gross_cents >= p.net_cents), 'every payout line carries its own currency');

  console.log('\n— P2: a media kit is a document sent to brands —');
  const kitSelf = (await api('GET', '/api/studio/mediakit', { token: rival.token })).json;
  ok(kitSelf.verification === 'self_reported' && /not yet corroborated/.test(kitSelf.verified_by),
    'zero completed deals cannot claim "verified from platform deal history"');
  const kitReal = (await api('GET', '/api/studio/mediakit', { token: creator.token })).json;
  ok(kitReal.verification === 'platform_verified' && /completed deal/.test(kitReal.verified_by), 'real deal history earns the verified claim');
  ok(kitReal.earned_by_currency.length === 2, 'earnings are reported per currency');

  console.log('\n— P3: Hook Lab no longer recommends gibberish —');
  const hk = (await api('POST', '/api/studio/hook', { token: creator.token, body: { text: 'hey guys welcome back to another video today we talk about coffee again' } })).json;
  ok(hk.rewrites.length > 0 && hk.rewrites.every(r => r.score > hk.score), 'every rewrite offered outscores the original');
  ok(hk.rewrites.every(r => !/hey guys|welcome back/i.test(r.text)), 'rewrites do not splice the generic opener back in');
  const strong = (await api('POST', '/api/studio/hook', { token: creator.token, body: { text: 'Why do 3 out of 4 cafes fail their first year?' } })).json;
  ok(strong.rewrites.length === 0 && /already beats/.test(strong.rewrites_note), 'a good hook is told to ship, not "improved" downward');

  console.log('\n— P3: contact redaction —');
  const r1 = (await api('POST', '/api/negotiations/' + neg.id + '/message', { token: creator.token, body: { text: 'bro just whatsapp me on 9845012345 or mail aj@ajtech.example, faster outside' } })).json;
  ok(r1.redacted && !/9845|ajtech/.test(r1.text), 'phone and email never reach the other side');
  ok(!/\]\w/.test(r1.text), 'overlapping patterns can no longer garble the placeholder');
  const r2 = (await api('POST', '/api/negotiations/' + neg.id + '/message', { token: creator.token, body: { text: 'telegram me, my handle is @aj_budget_tech_official_deals' } })).json;
  ok(!/dget_tech|official_deals/.test(r2.text), 'a handle is masked whole — no guessable remainder');
  const r3 = (await api('POST', '/api/negotiations/' + neg.id + '/message', { token: creator.token, body: { text: 'my number is nine eight four five zero one two three four five' } })).json;
  ok(r3.redacted, 'spelling the digits out is not a way around the filter');
  const r4 = (await api('POST', '/api/negotiations/' + neg.id + '/message', { token: brand.token, body: { text: 'please tag @kovacoffee in the reel and we are good' } })).json;
  ok(r4.redacted === false && /@kovacoffee/.test(r4.text), 'a legitimate brand tag is left alone');

  console.log('\n— one niche vocabulary, shared by every engine —');
  const beautyIdeas = (await api('GET', '/api/studio/ideas', { token: rival.token })).json;
  ok(beautyIdeas.every(i => i.niche === 'beauty'), 'a beauty creator gets beauty ideas, not a silent fallback to food');
  const beautyCap = (await api('POST', '/api/studio/caption', { token: rival.token, body: { caption: 'my full skincare routine, save this for tonight — serum order matters #skincare #ad', niche: 'beauty' } })).json;
  ok(beautyCap.niche_used === 'beauty' && beautyCap.keywords_found.includes('skincare'), 'caption SEO knows the same niches as the rate card');
  const badNiche = await api('POST', '/api/studio/caption', { token: rival.token, body: { caption: 'anything at all here', niche: 'underwater basket weaving' } });
  ok(/food, fitness/.test(badNiche.json.message), 'an unknown niche is named as invalid instead of quietly becoming food');
  const meta = (await api('GET', '/api/meta')).json;
  ok(meta.niches.length === 10 && meta.currencies.includes('INR') && meta.platform_fee_bps === 1200, '/api/meta publishes the vocabulary a client needs');

  console.log('\n— disputes cannot freeze escrow forever —');
  async function disputedDeal(title, idem) {
    const d = (await api('POST', '/api/deals', { token: brand.token, body: { creator_id: creator.user.id, title, brief: 'A deal that ends up in dispute for the SLA test.', amount_cents: 11000 } })).json;
    await api('POST', '/api/deals/' + d.id + '/fund', { token: brand.token, idem });
    await api('POST', '/api/deals/' + d.id + '/submit', { token: creator.token, body: { content_url: 'https://instagram.com/p/sla', caption: 'live and compliant #ad' } });
    const ds = (await api('POST', '/api/deals/' + d.id + '/dispute', { token: brand.token, body: { reason: 'Raising a dispute and then going completely quiet.' } })).json;
    return { d, ds };
  }
  const defended = await disputedDeal('SLA — creator defended', 'fund-sla-1');
  ok(defended.ds.resolve_by > Date.now(), 'opening a dispute starts a resolution clock');
  ok(defended.ds.funds === 'held_in_escrow', 'both parties are told where the money is while it is disputed');
  await api('POST', '/api/disputes/' + defended.ds.id + '/respond', { token: creator.token, body: { response: 'Content is live at the agreed URL and passed compliance.' } });
  const silent = await disputedDeal('SLA — creator silent', 'fund-sla-2');

  run('UPDATE users SET is_admin = 0 WHERE email = ?', 'ops@pakt.test');
  const skipped = escrow.sweepDisputeDeadlines();
  ok(skipped.skipped === true && /PAKT_ADMIN_EMAILS/.test(skipped.reason),
    'with no operator account the sweep does nothing rather than manufacture breaches nobody can action');
  run('UPDATE users SET is_admin = 1 WHERE email = ?', 'ops@pakt.test');

  run('UPDATE disputes SET deadline_at = ? WHERE id = ?', Date.now() + 60 * 60 * 1000, defended.ds.id);
  const warnPass = escrow.sweepDisputeDeadlines();
  ok(warnPass.warned >= 1, 'a dispute inside the last 24h gets an SLA warning before the deadline');
  ok(get('SELECT sla_warned_at FROM disputes WHERE id=?', defended.ds.id).sla_warned_at > 0, 'the warning is recorded on the dispute');

  run('UPDATE disputes SET deadline_at = ? WHERE id IN (?,?)', Date.now() - 1000, defended.ds.id, silent.ds.id);
  const breach = escrow.sweepDisputeDeadlines();
  ok(breach.escalated === 2, 'both overdue disputes escalate at the deadline');
  const afterDefended = (await api('GET', '/api/deals/' + defended.d.id, { token: creator.token })).json;
  const afterSilent = (await api('GET', '/api/deals/' + silent.d.id, { token: brand.token })).json;
  ok(afterDefended.state === 'DISPUTED' && afterSilent.state === 'DISPUTED',
    'NOBODY is paid or refunded automatically — a brief violation is a judgement call, not a timer');
  ok(afterDefended.dispute.sla_breached === true && afterDefended.dispute.funds === 'held_in_escrow',
    'both parties see the breach and that the money is still in escrow');
  const wallet0 = (await api('GET', '/api/wallet', { token: creator.token })).json;
  ok(!wallet0.payouts.some(p => p.deal_id === defended.d.id), 'no payout row was written for an escalated dispute');
  const escQueue = (await api('GET', '/api/disputes?status=escalated', { token: admin.token })).json;
  ok(escQueue.length === 2, 'operators get a dedicated escalated queue');
  const settledLate = (await api('POST', '/api/disputes/' + defended.ds.id + '/resolve', { token: admin.token, body: { brief_violated: false, note: 'Reviewed late: content live and compliant, brief met.' } })).json;
  ok(settledLate.deal.state === 'PAID', 'an operator can still resolve a dispute after it has escalated');
  const idempotentEsc = escrow.sweepDisputeDeadlines();
  ok(idempotentEsc.escalated === 0, 'escalation happens once, not on every sweep');

  console.log('\n— a mistyped draft is not permanent —');
  const draft = (await api('POST', '/api/deals', { token: brand.token, body: { creator_id: creator.user.id, title: 'Typo deal', brief: 'A draft created with the wrong number in it, as brands do.', amount_cents: 30000000 } })).json;
  ok(draft.state === 'DRAFT', 'draft created');
  const edited = (await api('PATCH', '/api/deals/' + draft.id, { token: brand.token, body: { amount_cents: 50000, title: 'Corrected deal' } })).json;
  ok(edited.amount_cents === 50000 && edited.title === 'Corrected deal', 'a DRAFT deal can be corrected');
  const emptyEdit = await api('PATCH', '/api/deals/' + draft.id, { token: brand.token, body: {} });
  ok(emptyEdit.status === 400, 'an empty edit says what is editable');
  const creatorEdit = await api('PATCH', '/api/deals/' + draft.id, { token: creator.token, body: { amount_cents: 99000 } });
  ok(creatorEdit.status === 403, 'a creator cannot edit the deal terms');
  const gone = (await api('DELETE', '/api/deals/' + draft.id, { token: brand.token })).json;
  ok(gone.ok === true, 'a DRAFT deal can be deleted');
  const goneCheck = await api('GET', '/api/deals/' + draft.id, { token: brand.token });
  ok(goneCheck.status === 404, 'it is really gone, not just hidden');
  const editPaid = await api('PATCH', '/api/deals/' + deal.id, { token: brand.token, body: { amount_cents: 1 } });
  ok(editPaid.status === 409 && /DRAFT/.test(editPaid.json.message), 'a funded or paid deal can never be edited');
  const delPaid = await api('DELETE', '/api/deals/' + deal.id, { token: brand.token });
  ok(delPaid.status === 409, 'a deal with money against it can never be deleted');

  console.log('\n— the agreed price stays agreed —');
  const neg2 = (await api('POST', '/api/negotiations', { token: brand.token, body: { creator_id: creator.user.id, title: 'Frozen terms', brief: 'Checking that a deal born of an agreement cannot be edited afterwards.', amount_cents: 40000 } })).json;
  await api('POST', '/api/negotiations/' + neg2.id + '/accept', { token: creator.token });
  const negDeal3 = (await api('POST', '/api/negotiations/' + neg2.id + '/to-deal', { token: brand.token })).json;
  const sneak = await api('PATCH', '/api/deals/' + negDeal3.id, { token: brand.token, body: { amount_cents: 500 } });
  ok(sneak.status === 409 && sneak.json.error === 'from_agreement',
    'a deal created from an accepted offer cannot be re-priced through the back door');
  const undo = (await api('DELETE', '/api/deals/' + negDeal3.id, { token: brand.token })).json;
  ok(undo.ok === true, 'it can still be deleted outright');
  const reconverted = (await api('POST', '/api/negotiations/' + neg2.id + '/to-deal', { token: brand.token })).json;
  ok(reconverted.amount_cents === 40000 && reconverted.id !== negDeal3.id,
    'and the table re-creates it at the agreed price, never at the edited one');

  console.log('\n— stat provenance is public —');
  const provenance = (await api('GET', '/api/creators', { token: brand.token })).json.find(c => c.id === rival.user.id);
  ok(provenance.stat_history.revisions === 3, 'the brand can see how many times the numbers changed');
  ok(provenance.stat_history.changes.some(c => c.field === 'followers' && c.from === '0' && c.to === '480000'),
    'with the actual before and after values — this is what audit scoping had hidden');
  const kitProv = (await api('GET', '/api/studio/mediakit', { token: rival.token })).json;
  ok(kitProv.stat_history.revisions === 3, 'the provenance travels with the media kit the creator sends out');
  const churnUser = (await api('POST', '/api/signup', { body: { role: 'creator', name: 'Churny', email: 'churn@test.com', password: 'churnpass12', handle: 'churny', niche: 'tech', followers: 200000, avg_likes: 6000, avg_comments: 200 } })).json;
  for (const likes of [7000, 8000, 9000]) {
    await api('PATCH', '/api/me', { token: churnUser.token, body: { avg_likes: likes } });
    // Distinct edit SESSIONS are counted by distinct timestamps, so these have
    // to land on different milliseconds. A 2ms gap collapsed under load about
    // once in thirty runs and took both churn assertions with it.
    await new Promise(r => setTimeout(r, 12));
  }
  const churned = (await api('GET', '/api/creators', { token: brand.token })).json.find(c => c.id === churnUser.user.id);
  ok(churned.authenticity.tier === 'watch' && churned.authenticity.flags.some(f => /separate edits/.test(f)),
    'three separate edits in a week costs the verified badge');
  ok(rescored.authenticity.tier === 'verified',
    'but one PATCH fixing several fields at once does not — that is the behaviour we asked for');

  console.log('\n— an account cannot get younger, or older than Instagram —');
  const ancient = await api('POST', '/api/signup', { body: { role: 'creator', name: 'Ancient', email: 'ancient@test.com', password: 'ancientpass1', handle: 'ancient', niche: 'food', followers: 1000, avg_likes: 100, avg_comments: 10, account_age_months: 600 } });
  ok(ancient.status === 400 && /predate Instagram/.test(ancient.json.message), 'a 50-year-old Instagram account is rejected at signup');
  const aged = await api('PATCH', '/api/me', { token: churnUser.token, body: { account_age_months: 400 } });
  ok(aged.status === 400, 'and cannot be reached by editing either');
  const younger = await api('PATCH', '/api/me', { token: creator.token, body: { account_age_months: 2 } });
  ok(younger.status === 400 && /backwards/.test(younger.json.message), 'account age cannot go backwards');
  const jump = await api('PATCH', '/api/me', { token: creator.token, body: { account_age_months: 90 } });
  ok(jump.status === 400 && /only grow with time/.test(jump.json.message), 'nor jump 60 months in an afternoon');
  const tick = await api('PATCH', '/api/me', { token: creator.token, body: { account_age_months: 31 } });
  ok(tick.status === 200, 'a normal one-month tick is fine');

  console.log('\n— imported Instagram creators are leads, not members —');
  const D = require('./lib/discovery');
  const node = (u, f, bio, media) => ({ id: 'ig_' + u, username: u, name: u, biography: bio, followers_count: f, media_count: 100, media: { data: media } });
  const walks = D.fromBusinessDiscovery(node('HYD.FoodWalks', 48200, 'Street food and cafe reviews. Biryani recipe threads.',
    [{ like_count: 3100, comments_count: 210 }, { comments_count: 150 }, { like_count: 4020, comments_count: 305 }]));
  ok(walks.handle === 'hyd.foodwalks', 'handle is normalized — @ stripped, lowercased, so it can match a signup');
  ok(walks.niche === 'food', 'niche inferred from the bio using the same taxonomy keywords signups are scored on');
  ok(walks.avg_likes === Math.round((3100 + 4020) / 2), 'a post with likes hidden is excluded from the like average, not counted as zero');
  ok(walks.avg_comments === Math.round((210 + 150 + 305) / 3), 'comments still average over every post that reported them');
  ok(walks.sample_size === 3, 'sample size is recorded so a 3-post average is not read as a stable one');
  ok(walks.growth_30d === undefined && walks.account_age_months === undefined,
    'growth and account age are never invented — Business Discovery does not return them');

  ok(D.upsert(walks) === 'inserted', 'first import inserts the prospect');
  ok(D.upsert(walks) === 'updated', 'a re-run updates in place rather than duplicating the creator');
  D.upsert(D.fromBusinessDiscovery(node('tiny.gym', 800, 'workout reps and protein', [{ like_count: 40, comments_count: 5 }])));
  ok(D.list({ minFollowers: 10000 }).length === 1 && D.list({ minFollowers: 0 }).length === 2, 'the 10k floor filters the directory');
  ok(D.list({ minFollowers: 0, niche: 'fitness' }).length === 1, 'niche filter works off the inferred niche');

  const disc = await api('GET', '/api/creators/discover', { token: brand.token });
  ok(disc.status === 200 && disc.json.count === 1, 'GET /api/creators/discover defaults to the 10k floor');
  const lead = disc.json.creators[0];
  ok(lead.on_pakt === false, 'an unclaimed creator is flagged as not on PAKT');
  ok(lead.authenticity === null && lead.provenance.unavailable.includes('authenticity'),
    'no authenticity score is invented for a prospect — fraudScore needs inputs we do not have');
  ok(lead.benchmark && lead.benchmark.low_cents > 0, 'but a rate benchmark is available, since that only needs followers and niche');
  ok((await api('GET', '/api/creators/discover')).status === 401, 'the discovery directory still requires auth');
  ok(!(await api('GET', '/api/creators', { token: brand.token })).json.some(c => c.handle === 'hyd.foodwalks'),
    'prospects never leak into /api/creators — a brand cannot open a deal against someone who never signed up');

  const claimer = await api('POST', '/api/signup', { body: { role: 'creator', name: 'Hyd Food Walks', email: 'walks@test.com', password: 'walkssecure1', handle: '@HYD.FoodWalks', niche: 'food', followers: 48200, avg_likes: 3560, avg_comments: 221 } });
  ok(claimer.status === 200, 'the real creator can sign up with the discovered handle');
  ok((await api('GET', '/api/creators/discover', { token: brand.token })).json.creators[0].on_pakt === true,
    'signing up claims the prospect row that was discovered for that handle');



  console.log('\n— the standing offer is the LAST one, even inside one millisecond —');
  /* latestOffer used to tiebreak equal created_at values on `id`, which is nine
     random bytes — so whenever two offers landed in the same millisecond, which
     one was "standing" was decided by chance. It surfaced as this suite failing
     roughly two runs in five with "cannot accept your own offer" while the other
     side's counter was plainly on the table. The price that gets frozen into the
     terms hash is read from this function, so the stakes are higher than a flake. */
  const race = (await api('POST', '/api/negotiations', { token: brand.token, body: { creator_id: creator.user.id, title: 'Same-millisecond table', brief: 'Offers exchanged fast enough to share a clock tick.', amount_cents: 10000 } })).json;
  // No awaited delay anywhere in here — these land on the same Date.now() value.
  await api('POST', `/api/negotiations/${race.id}/counter`, { token: creator.token, body: { amount_cents: 11000 } });
  await api('POST', `/api/negotiations/${race.id}/counter`, { token: brand.token, body: { amount_cents: 12000 } });
  await api('POST', `/api/negotiations/${race.id}/counter`, { token: creator.token, body: { amount_cents: 13000 } });
  const raceView = (await api('GET', `/api/negotiations/${race.id}`, { token: brand.token })).json;
  const stamps = new Set(raceView.offers.map(o => o.created_at));
  ok(raceView.offers.length === 4, 'all four offers are on the ledger');
  ok(raceView.offers.map(o => o.amount_cents).join(',') === '10000,11000,12000,13000',
    `history reads in insertion order${stamps.size < 4 ? ` (and ${4 - stamps.size + 1} of these really do share a timestamp)` : ''}`);
  const raceAccept = await api('POST', `/api/negotiations/${race.id}/accept`, { token: brand.token });
  ok(raceAccept.status === 200 && raceAccept.json.agreed_amount_cents === 13000,
    'the brand accepts the creator\'s 13000 — the standing offer is the last one inserted, not a random one of the tied pair');
  ok((await api('POST', `/api/negotiations/${race.id}/accept`, { token: creator.token })).status === 409,
    'and the creator still cannot accept their own');

  console.log('\n— the edge: a session can be ended, and a password rotated —');
  const NET = require('./lib/net');
  const sess = (await api('POST', '/api/signup', { body: { role: 'brand', name: 'Session Co', email: 'sess@test.com', password: 'sessionpass1' } })).json;
  ok((await api('GET', '/api/me', { token: sess.token })).status === 200, 'a fresh token works');
  ok((await api('POST', '/api/logout', { token: sess.token })).status === 200, 'logout succeeds');
  ok((await api('GET', '/api/me', { token: sess.token })).status === 401,
    'the token is dead immediately — there was no way to revoke a leaked session at all before this');
  ok((await api('POST', '/api/logout', { token: sess.token })).status === 200,
    'logging out twice is a success, not an error — the caller wanted the token gone and it is gone');
  ok((await api('POST', '/api/logout')).status === 401, 'logout still needs a token to identify the session');

  const pw = (await api('POST', '/api/signup', { body: { role: 'brand', name: 'Rotate Co', email: 'rotate@test.com', password: 'oldpassword1' } })).json;
  const otherDevice = (await api('POST', '/api/login', { body: { email: 'rotate@test.com', password: 'oldpassword1' } })).json;
  const wrongCurrent = await api('POST', '/api/me/password', { token: pw.token, body: { current_password: 'notitatall1', new_password: 'newpassword1' } });
  ok(wrongCurrent.status === 401, 'changing a password requires proving you know the current one');
  const same = await api('POST', '/api/me/password', { token: pw.token, body: { current_password: 'oldpassword1', new_password: 'oldpassword1' } });
  ok(same.status === 400, 'the new password has to actually be new');
  const rotated = await api('POST', '/api/me/password', { token: pw.token, body: { current_password: 'oldpassword1', new_password: 'newpassword1' } });
  ok(rotated.status === 200 && rotated.json.token, 'password rotates and hands back a fresh token');
  ok((await api('GET', '/api/me', { token: otherDevice.token })).status === 401,
    'every other session dies with it — leaving the intruder signed in would defeat the point');
  ok((await api('GET', '/api/me', { token: rotated.json.token })).status === 200, 'the caller stays signed in on this device');
  ok((await api('POST', '/api/login', { body: { email: 'rotate@test.com', password: 'oldpassword1' } })).status === 401
    && (await api('POST', '/api/login', { body: { email: 'rotate@test.com', password: 'newpassword1' } })).status === 200,
    'the old password no longer opens the account and the new one does');

  console.log('\n— the edge: one account cannot be brute-forced —');
  const bf = 'bruteforce@test.com';
  await api('POST', '/api/signup', { body: { role: 'brand', name: 'Brute Co', email: bf, password: 'realpassword1' } });
  let lockedAt = 0;
  for (let i = 1; i <= 10; i++) {
    const r = await api('POST', '/api/login', { body: { email: bf, password: 'wrongguess' + i } });
    if (r.status === 429 && !lockedAt) lockedAt = i;
  }
  ok(lockedAt > 0 && lockedAt <= 9, `the account stops answering after repeated failures (locked on attempt ${lockedAt})`);
  const stillLocked = await api('POST', '/api/login', { body: { email: bf, password: 'realpassword1' } });
  ok(stillLocked.status === 429 && /try again in/i.test(stillLocked.json.message),
    'even the correct password is refused while locked, and the message says for how long');
  ok((await api('POST', '/api/login', { body: { email: 'kova@test.com', password: 'brewsecure1' } })).status === 200,
    'the lock is per-account — everyone else signs in normally');
  ok(NET.loginBlocked('never-seen@test.com') === null, 'an account with no failures is never blocked');

  console.log('\n— the edge: the real client IP behind a proxy —');
  const fakeReq = (socket, headers = {}) => ({ socket: { remoteAddress: socket }, headers });
  ok(NET.isPrivatePeer('127.0.0.1') && NET.isPrivatePeer('10.1.2.3') && NET.isPrivatePeer('172.16.0.1') && NET.isPrivatePeer('192.168.1.9'),
    'loopback and RFC1918 addresses count as trusted peers');
  ok(!NET.isPrivatePeer('49.207.1.1') && !NET.isPrivatePeer('172.32.0.1'),
    'a public address does not — 172.32 is outside the private range, a classic off-by-one');
  ok(NET.clientIp(fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })) === '127.0.0.1',
    'with PAKT_TRUST_PROXY unset, X-Forwarded-For is ignored entirely — trusting it by default hands every attacker a fresh rate-limit bucket');
  ok(NET.clientIp(fakeReq('::ffff:49.207.1.1')) === '49.207.1.1',
    'IPv4-mapped IPv6 is normalized, so one client cannot occupy two buckets');

  console.log('\n— the edge: what every response now tells the browser —');
  const page = await fetch(BASE + '/app');
  const csp = page.headers.get('content-security-policy');
  ok(page.status === 200 && !!csp, 'the HTML that actually runs script carries a CSP');
  ok(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp),
    'the page cannot be framed, cannot load plugins, and cannot have its <base> rewritten');
  ok(/script-src[^;]*cdnjs\.cloudflare\.com/.test(csp) && !/script-src[^;]*\*/.test(csp),
    'script is pinned to the two CDNs the pages actually use, not a wildcard');
  ok(page.headers.get('x-frame-options') === 'DENY'
    && page.headers.get('x-content-type-options') === 'nosniff'
    && page.headers.get('referrer-policy') === 'strict-origin-when-cross-origin',
    'clickjacking, MIME sniffing and referrer leakage are all closed');
  ok(/camera=\(\)/.test(page.headers.get('permissions-policy') || ''),
    'nothing in PAKT asks for a camera, so nothing embedded in it can either');
  ok(!page.headers.get('strict-transport-security'),
    'HSTS is not sent over plain http — pinning a developer machine to https for six months is a real way to ruin an afternoon');

  const apiRes = await fetch(BASE + '/api/health');
  ok(!!apiRes.headers.get('content-security-policy'), 'API responses carry the headers too, not just the pages');
  ok(apiRes.headers.get('access-control-allow-origin') === null,
    'CORS is same-origin by default — it used to answer "*" to every caller on the internet');

  console.log('\n— the edge: limits are tiered by what a request costs —');
  ok(NET.tierFor('POST', '/api/login') === 'auth' && NET.tierFor('POST', '/api/signup') === 'auth',
    'login and signup are their own tier — 120/min is 120 password guesses a minute');
  ok(NET.tierFor('POST', '/api/deals/deal_x/fund') === 'money'
    && NET.tierFor('POST', '/api/disputes/dsp_x/resolve') === 'money'
    && NET.tierFor('POST', '/api/negotiations/neg_x/to-deal') === 'money',
    'everything that moves money shares the tightest tier');
  ok(NET.tierFor('GET', '/api/creators') === 'default' && NET.tierFor('PATCH', '/api/me') === 'write',
    'reading is cheap, writing is not, and they are counted separately');
  ok((await api('GET', '/api/nonexistent-route')).status === 404, 'an unknown route is still a clean 404');

  console.log('\n— the edge: a malformed request is a 400, not a stack trace —');
  const badPath = await fetch(BASE + '/api/%E0%A4%A', { redirect: 'manual' });
  ok(badPath.status === 400, 'a path that cannot be decoded is rejected before it reaches the router');
  ok((await api('GET', '/api/health')).status === 200, 'and the server is still serving afterwards');

  console.log(`\n${'='.repeat(44)}\n  RESULT: ${passed} passed, ${failed} failed\n${'='.repeat(44)}`);
  server.close();
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
