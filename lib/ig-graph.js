// PAKT — ig-graph.js — Meta Instagram Business Discovery client. Zero deps.
//
// What this endpoint can and cannot do, because the difference decides the
// whole import strategy:
//
//   CAN   — given a username you already know, return that account's public
//           followers_count, bio, website, media_count and recent media
//           (with like_count / comments_count).
//   CANNOT— search. There is no "list creators with >10k followers" query in
//           any Meta API. Discovery by follower range is a licensed-data
//           product (Modash, Phyllo, HypeAuditor), not a Graph call.
//
// So this module enriches a handle list you supply. It does not find one.
//
// Requirements: IG_USER_ID is *your* Instagram Business account id, and
// IG_ACCESS_TOKEN a token for it with instagram_basic +
// instagram_manage_insights. The target account must itself be a Business
// or Creator account — personal accounts return an error, which we surface
// per-handle rather than failing the run.
'use strict';

const API_VERSION = process.env.IG_API_VERSION || 'v25.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;
const MEDIA_LIMIT = 25; // recent posts to average engagement over

const FIELDS = (handle) =>
  `business_discovery.username(${handle}){id,username,name,biography,website,` +
  `followers_count,media_count,profile_picture_url,` +
  `media.limit(${MEDIA_LIMIT}){like_count,comments_count,timestamp,caption}}`;

function credentials() {
  const igUserId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!igUserId || !token) {
    const e = new Error(
      'Set IG_USER_ID and IG_ACCESS_TOKEN. IG_USER_ID is your own Instagram Business account id; ' +
      'the token needs instagram_basic and instagram_manage_insights. ' +
      'Business Discovery only works from a Business/Creator account you control.');
    e.code = 'missing_credentials';
    throw e;
  }
  return { igUserId, token };
}

/* One handle -> one business_discovery node.
   Resolves {ok:false, handle, error} instead of throwing on a per-handle
   failure (private account, personal account, typo, deleted) so one bad
   handle in a list of 500 does not abort the import. */
async function fetchOne(handle, { igUserId, token }) {
  const url = `${GRAPH}/${igUserId}?fields=${encodeURIComponent(FIELDS(handle))}&access_token=${encodeURIComponent(token)}`;
  let res, body;
  try {
    res = await fetch(url);
    body = await res.json();
  } catch (e) {
    return { ok: false, handle, error: `network: ${e.message}` };
  }
  if (body && body.error) {
    // 190 = bad/expired token, 4/17/32/613 = throttled. Both are run-fatal:
    // continuing just burns the rest of the list against the same wall.
    const { code, message } = body.error;
    const fatal = code === 190 || code === 4 || code === 17 || code === 32 || code === 613;
    return { ok: false, handle, fatal, error: `graph ${code}: ${message}` };
  }
  const node = body && body.business_discovery;
  if (!node) {
    return { ok: false, handle, error: 'no business_discovery node — handle not found, or not a Business/Creator account' };
  }
  return { ok: true, handle, node };
}

/* Sequential with a small gap. Business Discovery shares the app-level rate
   limit; firing a list concurrently is the fastest way to get throttled off
   it, and an import is not latency-sensitive. */
async function fetchMany(handles, { onResult, delayMs = 250 } = {}) {
  const creds = credentials();
  const out = [];
  for (let i = 0; i < handles.length; i++) {
    const r = await fetchOne(handles[i], creds);
    out.push(r);
    if (onResult) onResult(r, i + 1, handles.length);
    if (r.fatal) { r.abortedAfter = i + 1; break; }
    if (i < handles.length - 1 && delayMs) await new Promise(s => setTimeout(s, delayMs));
  }
  return out;
}

/* Confirm the credentials work before spending a run on them.
   Business Discovery fails in several different ways that all look alike from
   the outside — wrong id, unlinked Page, missing permission, expired token —
   so this reports which one it is instead of "no business_discovery node". */
async function verify(probeHandle) {
  const creds = credentials();
  const me = `${GRAPH}/${creds.igUserId}?fields=id,username,followers_count&access_token=${encodeURIComponent(creds.token)}`;
  let res;
  try { res = await (await fetch(me)).json(); }
  catch (e) { return { ok: false, stage: 'network', error: e.message }; }

  if (res && res.error) {
    const { code, message, type } = res.error;
    let hint = 'Check the token and the id.';
    if (code === 190) hint = 'The token is invalid or expired. Generate a fresh one in Graph API Explorer.';
    else if (code === 100) hint = 'IG_USER_ID does not look like an Instagram Business account id. It is NOT your @handle and NOT your Facebook Page id — read it from /me/accounts?fields=instagram_business_account.';
    else if (code === 200 || code === 10) hint = 'The token is missing a permission. You need instagram_basic and instagram_manage_insights, plus pages_show_list and pages_read_engagement.';
    return { ok: false, stage: 'identity', error: `graph ${code} (${type}): ${message}`, hint };
  }
  if (!res || !res.username) return { ok: false, stage: 'identity', error: 'no username returned — is IG_USER_ID an Instagram Business account?' };

  const out = { ok: true, as: { id: res.id, username: res.username, followers: res.followers_count } };
  if (probeHandle) {
    const probe = await fetchOne(normalize(probeHandle), creds);
    out.probe = probe.ok
      ? { ok: true, handle: probe.node.username, followers: probe.node.followers_count, posts: (probe.node.media && probe.node.media.data || []).length }
      : { ok: false, error: probe.error };
  }
  return out;
}
const normalize = (h) => String(h || '').trim().replace(/^@+/, '');

module.exports = { API_VERSION, MEDIA_LIMIT, credentials, fetchOne, fetchMany, verify };
