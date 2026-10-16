#!/usr/bin/env node
// PAKT — import real Instagram creators into the prospect directory.
//
//   node tools/import-creators.js --check          # verify the token first
//   node tools/import-creators.js --handles=nasa,natgeo
//   node tools/import-creators.js --handles-file=handles.txt --min-followers=10000
//   node tools/import-creators.js --handles-file=handles.txt --dry-run
//
// Env: IG_USER_ID, IG_ACCESS_TOKEN  (see lib/ig-graph.js for what they are)
//
// This enriches handles you supply. Meta has no endpoint that *finds*
// creators by follower count — see the header of lib/ig-graph.js.
'use strict';
const fs = require('node:fs');
const graph = require('../lib/ig-graph');
const discovery = require('../lib/discovery');
const { audit } = require('../lib/db');

const args = new Map(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? 'true' : m[2]] : [a, 'true'];
}));

const dryRun = args.get('dry-run') === 'true';
const minFollowers = parseInt(args.get('min-followers') || String(discovery.MIN_FOLLOWERS), 10);
const delayMs = parseInt(args.get('delay-ms') || '250', 10);

function readHandles() {
  const out = [];
  if (args.has('handles')) out.push(...String(args.get('handles')).split(','));
  if (args.has('handles-file')) {
    const f = args.get('handles-file');
    if (!fs.existsSync(f)) { console.error(`handles-file not found: ${f}`); process.exit(2); }
    // one per line; # comments and blanks ignored
    out.push(...fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.replace(/#.*$/, '')));
  }
  const seen = new Set();
  return out.map(discovery.normalizeHandle).filter(h => h && !seen.has(h) && seen.add(h));
}

(async () => {
  /* --check answers "is my Meta token actually usable?" without importing
     anything. Run this first; every other failure mode is easier to read
     once you know the credentials themselves are good. */
  if (args.get('check') === 'true') {
    let v;
    try { v = await graph.verify(args.get('probe') || 'natgeo'); }
    catch (e) { console.error(e.message); process.exit(2); }
    if (!v.ok) {
      console.error(`✘ Credentials rejected at the ${v.stage} step.\n  ${v.error}${v.hint ? '\n  → ' + v.hint : ''}`);
      process.exit(1);
    }
    console.log(`✔ Token works. Authenticated as @${v.as.username} (id ${v.as.id}, ${(v.as.followers ?? 0).toLocaleString()} followers).`);
    if (v.probe) {
      console.log(v.probe.ok
        ? `✔ Business Discovery works. Probed @${v.probe.handle}: ${v.probe.followers.toLocaleString()} followers, ${v.probe.posts} recent posts readable.`
        : `✘ Business Discovery failed on the probe handle: ${v.probe.error}\n  → The token is valid but cannot read other accounts. This is usually a missing instagram_manage_insights permission, or the probe account is not a Business/Creator account.`);
      process.exit(v.probe.ok ? 0 : 1);
    }
    process.exit(0);
  }

  const handles = readHandles();
  if (!handles.length) {
    console.error('Nothing to import. Pass --handles=a,b,c or --handles-file=path.\n' +
      'Meta cannot search by follower count, so the handle list has to come from you\n' +
      '(your own outreach list, a licensed vendor export, or creators who applied).');
    process.exit(2);
  }
  if (!Number.isFinite(minFollowers) || minFollowers < 0) { console.error('--min-followers must be a whole number'); process.exit(2); }

  console.log(`Importing ${handles.length} handle(s) via Business Discovery ${graph.API_VERSION}`);
  console.log(`Floor: ${minFollowers.toLocaleString()} followers${dryRun ? '   [DRY RUN — nothing will be written]' : ''}\n`);

  const kept = [], belowFloor = [], failed = [];
  let results;
  try {
    results = await graph.fetchMany(handles, { delayMs, onResult: (r, i, n) => process.stdout.write(`\r  ${i}/${n} …`) });
  } catch (e) {
    console.error(`\n${e.message}`); process.exit(e.code === 'missing_credentials' ? 2 : 1);
  }
  process.stdout.write('\r');

  for (const r of results) {
    if (!r.ok) { failed.push(r); continue; }
    const rec = discovery.fromBusinessDiscovery(r.node);
    if (!rec) { failed.push({ handle: r.handle, error: 'unparseable node' }); continue; }
    if (rec.followers < minFollowers) { belowFloor.push(rec); continue; }
    rec.action = dryRun ? 'would-add' : discovery.upsert(rec);
    kept.push(rec);
  }

  for (const r of kept) {
    const er = discovery.engagementRate(r);
    console.log(
      `  ${r.action.padEnd(9)} @${r.handle.padEnd(24)} ${String(r.followers).padStart(9)} followers  ` +
      `${(r.niche || 'niche?').padEnd(10)} ${er === null ? 'engagement n/a' : er + '% engagement'} (${r.sample_size} posts)`);
  }
  for (const r of belowFloor) console.log(`  skipped   @${r.handle.padEnd(24)} ${String(r.followers).padStart(9)} followers  — under the ${minFollowers.toLocaleString()} floor`);
  for (const r of failed) console.log(`  FAILED    @${r.handle.padEnd(24)} ${r.error}`);

  const aborted = results.find(r => r.fatal);
  console.log(`\n${kept.length} imported · ${belowFloor.length} under floor · ${failed.length} failed`);
  if (aborted) console.log(`Run stopped early at handle ${aborted.abortedAfter}/${handles.length}: ${aborted.error}`);

  const noNiche = kept.filter(r => !r.niche).length;
  if (noNiche) console.log(`${noNiche} imported with no niche — their bio matched no taxonomy keyword. Set it by hand or they will not surface in niche-filtered search.`);
  const thinSample = kept.filter(r => r.sample_size > 0 && r.sample_size < 5).length;
  if (thinSample) console.log(`${thinSample} have engagement averaged over fewer than 5 posts — treat those rates as provisional.`);
  const noPosts = kept.filter(r => r.sample_size === 0).length;
  if (noPosts) console.log(`${noPosts} returned no post metrics at all (likes hidden, or no recent media) — they have follower counts only.`);

  if (!dryRun && kept.length) audit(null, 'creators.import', 'creator_prospects', { count: kept.length, source: 'instagram_business_discovery', min_followers: minFollowers });
  process.exit(failed.length && !kept.length ? 1 : 0);
})();
