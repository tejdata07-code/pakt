#!/usr/bin/env bash
# PAKT — one-shot server setup. Run ON THE VM, as a sudo-capable user.
#
#   sudo bash bootstrap.sh <hostname> <duckdns-subdomain> <duckdns-token> <operator-email>
#
# e.g.
#   sudo bash bootstrap.sh paktapp.duckdns.org paktapp 1a2b3c4d-... you@gmail.com
#
# Idempotent: safe to re-run after a failure or a code update.
set -euo pipefail

HOSTNAME_FQDN="${1:?usage: bootstrap.sh <fqdn> <duckdns-subdomain> <duckdns-token> <operator-email>}"
DUCK_SUB="${2:?missing duckdns subdomain}"
DUCK_TOKEN="${3:?missing duckdns token}"
ADMIN_EMAIL="${4:?missing operator email}"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 1. packages
apt-get update -qq
apt-get install -y curl rsync sqlite3 bind9-dnsutils ca-certificates gnupg

say "Installing Node 24 and Caddy"
# node:sqlite is unflagged from 23.4. Compare numerically — a string compare
# here quietly accepts Node 9, because "9" sorts after "2".
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>23||(a===23&&b>=4))?0:1)' 2>/dev/null
}
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
  node_ok || { echo "Node is still older than 23.4 — PAKT cannot run. Install Node 24 manually."; exit 1; }
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
node --version

# ---------------------------------------------------------------- 2. firewall
# Oracle's Ubuntu images ship with iptables closed. The VCN security list must
# ALSO allow 80/443 — that part is in the web console and cannot be done here.
say "Opening ports 80 and 443 on the host firewall"
iptables -C INPUT -m state --state NEW -p tcp --dport 80  -j ACCEPT 2>/dev/null || \
  iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
iptables -C INPUT -m state --state NEW -p tcp --dport 443 -j ACCEPT 2>/dev/null || \
  iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
(command -v netfilter-persistent >/dev/null && netfilter-persistent save) || \
  (apt-get install -y iptables-persistent && netfilter-persistent save) || true

# ---------------------------------------------------------------- 3. DNS
say "Pointing $HOSTNAME_FQDN at this machine"
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org)"
echo "    public IP: $PUBLIC_IP"
RESP="$(curl -fsS "https://www.duckdns.org/update?domains=${DUCK_SUB}&token=${DUCK_TOKEN}&ip=${PUBLIC_IP}")"
[ "$RESP" = "OK" ] || { echo "DuckDNS update failed: $RESP"; echo "Check the subdomain and token."; exit 1; }
echo "    duckdns: OK"

# Keep it pointed there. Oracle's default public IP is ephemeral — it can change
# on a stop/start, and a stale A record means the cert renewal fails silently.
cat > /usr/local/bin/duckdns-update <<UPD
#!/bin/sh
curl -fsS "https://www.duckdns.org/update?domains=${DUCK_SUB}&token=${DUCK_TOKEN}&ip=" >/dev/null 2>&1
UPD
chmod +x /usr/local/bin/duckdns-update
( crontab -l 2>/dev/null | grep -v duckdns-update; echo "*/5 * * * * /usr/local/bin/duckdns-update" ) | crontab -

say "Waiting for DNS to propagate"
for i in $(seq 1 30); do
  GOT="$(dig +short "$HOSTNAME_FQDN" @1.1.1.1 | head -1 || true)"
  [ "$GOT" = "$PUBLIC_IP" ] && { echo "    resolves to $GOT"; break; }
  echo "    attempt $i/30 (got '${GOT:-nothing}')..."; sleep 10
done
[ "$(dig +short "$HOSTNAME_FQDN" @1.1.1.1 | head -1)" = "$PUBLIC_IP" ] || {
  echo "DNS is not resolving to $PUBLIC_IP yet."
  echo "Let's Encrypt will fail until it does. Wait, then re-run this script."; exit 1; }

# ---------------------------------------------------------------- 4. app user
say "Creating the pakt user and directories"
id -u pakt >/dev/null 2>&1 || useradd --system --home /opt/pakt --shell /usr/sbin/nologin pakt
mkdir -p /opt/pakt /var/lib/pakt /etc/pakt /var/log/caddy

say "Installing application code"
# Code and data live apart: the systemd unit mounts everything read-only except
# /var/lib/pakt, so the running process cannot rewrite its own source.
rsync -a --delete \
  --exclude 'pakt.db' --exclude 'pakt.db-wal' --exclude 'pakt.db-shm' \
  --exclude '.git' --exclude '.env' --exclude '*.pdf' \
  "$SRC/" /opt/pakt/
chown -R pakt:pakt /opt/pakt /var/lib/pakt
chown -R caddy:caddy /var/log/caddy 2>/dev/null || true

# ---------------------------------------------------------------- 5. config
say "Writing /etc/pakt/pakt.env"
if [ ! -f /etc/pakt/pakt.env ]; then
  cat > /etc/pakt/pakt.env <<ENV
PAKT_ADMIN_EMAILS=${ADMIN_EMAIL}
PAKT_DB=/var/lib/pakt/pakt.db
PORT=4000
PAKT_HOST=127.0.0.1
PAKT_TRUST_PROXY=1
PAKT_RATE_LIMIT=120
PAKT_RATE_LIMIT_AUTH=10
PAKT_RATE_LIMIT_MONEY=30
PAKT_RATE_LIMIT_WRITE=60
PAKT_CORS_ORIGINS=
ENV
else
  echo "    already exists — leaving it alone"
fi
chown pakt:pakt /etc/pakt/pakt.env
chmod 600 /etc/pakt/pakt.env

# ---------------------------------------------------------------- 6. services
say "Starting PAKT"
cp /opt/pakt/deploy/pakt.service /etc/systemd/system/pakt.service
systemctl daemon-reload
systemctl enable pakt
systemctl restart pakt
sleep 2
systemctl is-active --quiet pakt || { journalctl -u pakt -n 40 --no-pager; exit 1; }

say "Configuring Caddy for $HOSTNAME_FQDN"
sed "s/PAKT_HOSTNAME_PLACEHOLDER/${HOSTNAME_FQDN}/" /opt/pakt/deploy/Caddyfile > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

# ---------------------------------------------------------------- 7. backups
say "Scheduling a nightly database backup"
cat > /usr/local/bin/pakt-backup <<'BK'
#!/bin/sh
# SQLite in WAL mode cannot be safely copied with cp while the process is
# running. .backup takes a consistent snapshot of a live database.
D=/var/lib/pakt
sqlite3 "$D/pakt.db" ".backup '$D/backup-$(date +%F).db'"
find "$D" -name 'backup-*.db' -mtime +14 -delete
BK
chmod +x /usr/local/bin/pakt-backup
( crontab -l 2>/dev/null | grep -v pakt-backup; echo "30 2 * * * /usr/local/bin/pakt-backup" ) | crontab -

# ---------------------------------------------------------------- 8. verify
say "Verifying"
sleep 5
echo -n "  health:   "; curl -fsS --max-time 20 "https://${HOSTNAME_FQDN}/api/health" || echo "FAILED"
echo
echo -n "  operators configured: "
curl -fsS --max-time 20 "https://${HOSTNAME_FQDN}/api/meta" | grep -o '"operators_configured":[a-z]*' || echo "could not read"
echo -n "  CSP header present:   "
curl -fsSI --max-time 20 "https://${HOSTNAME_FQDN}/app" | grep -qi content-security-policy && echo yes || echo NO

cat <<DONE

================================================================
  PAKT is live at  https://${HOSTNAME_FQDN}

  App        https://${HOSTNAME_FQDN}/app
  Forge      https://${HOSTNAME_FQDN}/forge
  Walkthrough https://${HOSTNAME_FQDN}/walkthrough

  Logs       journalctl -u pakt -f
  Restart    systemctl restart pakt
  Backup now /usr/local/bin/pakt-backup

  Operator account: sign up at /app with ${ADMIN_EMAIL}
  — is_admin is granted on signup/login from PAKT_ADMIN_EMAILS,
    never from anything you can put in a request body.

  PAYMENTS ARE SIMULATED. lib/services.js returns synthetic
  references. Say so on the site until Razorpay/Stripe is wired.
================================================================
DONE
