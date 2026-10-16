// PAKT — db.js — SQLite (built into Node 22+). One file on disk, ACID, zero deps.
'use strict';
/* node:sqlite is the whole reason this project has no dependencies, and it is
   also the most likely thing to fail on a host you did not configure. It landed
   in Node 22.5 behind --experimental-sqlite and only became available unflagged
   in 23.4. A host that defaults to Node 20 dies here with a bare
   ERR_UNKNOWN_BUILTIN_MODULE that says nothing about what to do next. */
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  const v = process.versions.node;
  console.error(
    `\nPAKT cannot start: node:sqlite is unavailable on Node ${v}.\n` +
    `  PAKT needs Node 23.4 or newer (24 LTS recommended), where node:sqlite is built in and unflagged.\n` +
    `  On Node 22.5-23.3 it exists but is flagged — run: node --experimental-sqlite server.js\n` +
    `  On anything older there is no built-in SQLite at all; upgrade Node.\n`);
  process.exit(1);
}
const path = require('node:path');

const DB_PATH = process.env.PAKT_DB || path.join(__dirname, '..', 'pakt.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('brand','creator')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  handle TEXT,
  niche TEXT,
  followers INTEGER DEFAULT 0,
  avg_likes INTEGER DEFAULT 0,
  avg_comments INTEGER DEFAULT 0,
  growth_30d REAL DEFAULT 0,
  account_age_months INTEGER DEFAULT 12,
  city TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES users(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  deal_type TEXT NOT NULL DEFAULT 'one_off' CHECK(deal_type IN ('one_off','retainer')),
  state TEXT NOT NULL DEFAULT 'DRAFT',
  compliance_ok INTEGER DEFAULT NULL,
  compliance_notes TEXT,
  content_url TEXT,
  caption TEXT,
  tracking_code TEXT UNIQUE,
  funded_at INTEGER, submitted_at INTEGER, verified_at INTEGER, paid_at INTEGER,
  auto_release_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  kind TEXT NOT NULL CHECK(kind IN ('fund','payout','refund','fee')),
  amount_cents INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  opened_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved_creator','resolved_brand')),
  resolution_note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS track_events (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  kind TEXT NOT NULL CHECK(kind IN ('click','conversion')),
  revenue_cents INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  detail TEXT,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS negotiations (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES users(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','agreed','declined')),
  agreed_amount_cents INTEGER,
  agreed_offer_id TEXT,
  terms_hash TEXT,
  deal_id TEXT REFERENCES deals(id),
  created_at INTEGER NOT NULL,
  agreed_at INTEGER
);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  negotiation_id TEXT NOT NULL REFERENCES negotiations(id),
  by_user TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','superseded')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nmessages (
  id TEXT PRIMARY KEY,
  negotiation_id TEXT NOT NULL REFERENCES negotiations(id),
  by_user TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  redacted INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_neg_brand ON negotiations(brand_id);
CREATE INDEX IF NOT EXISTS idx_neg_creator ON negotiations(creator_id);
CREATE INDEX IF NOT EXISTS idx_offers_neg ON offers(negotiation_id);
CREATE INDEX IF NOT EXISTS idx_deals_brand ON deals(brand_id);
CREATE INDEX IF NOT EXISTS idx_deals_creator ON deals(creator_id);
CREATE INDEX IF NOT EXISTS idx_deals_state ON deals(state);
CREATE INDEX IF NOT EXISTS idx_track_deal ON track_events(deal_id);
`);

/* ---------- migrations ----------
   Additive and idempotent: every column below is safe to run against an
   existing pakt.db on boot. Nothing here rewrites or drops data. */
function columns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
}
function addColumn(table, name, ddl) {
  if (columns(table).has(name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  return true;
}

// admin is a flag, not a role — the role CHECK constraint stays (brand|creator)
// and a human operator is always also a party on the platform.
addColumn("users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "stats_updated_at", "INTEGER");

// every money row remembers its own currency; deriving it later is guesswork
addColumn("ledger", "currency", "TEXT");
db.exec("UPDATE ledger SET currency = (SELECT d.currency FROM deals d WHERE d.id = ledger.deal_id) WHERE currency IS NULL");

// a negotiation is a price conversation — a price without a unit is not a price
addColumn("negotiations", "currency", "TEXT NOT NULL DEFAULT 'USD'");

// the creator side of a dispute, and a deadline so escrow can never be frozen forever
addColumn("disputes", "creator_response", "TEXT");
addColumn("disputes", "creator_evidence", "TEXT");
addColumn("disputes", "responded_at", "INTEGER");
addColumn("disputes", "deadline_at", "INTEGER");

/* Public record of every change to a creator's audience numbers.
   The audit log carries this too, but audit is scoped to the actor — which
   means the brand being priced off those numbers could never see that they
   had been rewritten. Provenance of a public metric is not commercial data;
   it belongs on the profile. */
db.exec(`
CREATE TABLE IF NOT EXISTS stat_revisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statrev_user ON stat_revisions(user_id);
`);

// SLA lifecycle on a dispute: warned before the deadline, escalated at it.
// Neither moves money — see escrow.sweepDisputeDeadlines.
addColumn("disputes", "sla_warned_at", "INTEGER");
addColumn("disputes", "escalated_at", "INTEGER");

db.exec(`
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit(entity);
CREATE INDEX IF NOT EXISTS idx_ledger_deal ON ledger(deal_id);
CREATE INDEX IF NOT EXISTS idx_disputes_deal ON disputes(deal_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
`);

// tiny helpers
const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

function audit(actor_id, action, entity, detail) {
  run('INSERT INTO audit (actor_id, action, entity, detail, at) VALUES (?,?,?,?,?)',
    actor_id || null, action, entity || null, detail ? JSON.stringify(detail).slice(0, 1000) : null, Date.now());
}

module.exports = { db, get, all, run, tx, audit, columns, DB_PATH };
