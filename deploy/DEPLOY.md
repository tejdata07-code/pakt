# Deploying PAKT on a free subdomain

The whole thing costs ₹0 and stays up permanently. What follows is the exact
sequence, and then the reason each step is the way it is.

## What PAKT needs from a host

This is not a stateless web app, and the constraint decides the hosting choice:

| Need | Why | What it rules out |
|---|---|---|
| A process that never sleeps | `startSweeper()` runs every 60s and is what actually fires the 72h auto-release and the 7-day dispute SLA | Anything that scales to zero |
| A persistent disk | `pakt.db` holds every user, deal and ledger row | Ephemeral-filesystem tiers |
| Node 23.4+ | `node:sqlite` is unflagged from 23.4; on 22.5–23.3 it needs `--experimental-sqlite`, below that it does not exist | Hosts pinned to Node 20 |
| A long-running TCP listener | Plain `node:http`, not a handler function | Serverless/edge runtimes |

**A free tier that spins down after 15 minutes idle is not merely slower — it
silently breaks the product's headline guarantee.** A creator whose brand went
quiet would not be paid at 72 hours; they would be paid whenever the next
visitor happened to wake the process. That is the exact bug the sweeper was
written to fix.

---

## The build: Oracle Cloud Always Free + DuckDNS + Caddy

### 1. Get the machine

Oracle Cloud's Always Free tier includes Ampere A1 (ARM) instances that stay
free indefinitely. Create an **Ubuntu 22.04+ ARM** VM. In the VCN's default
security list, open **ingress TCP 80 and 443** from `0.0.0.0/0`.

> Ampere capacity in the Mumbai and Hyderabad regions is frequently exhausted.
> If you get "Out of capacity", retry over a day or two or pick another region
> — latency from India to Singapore is fine for this.

Then open the host firewall, which Oracle images ship locked down:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 2. Get the name

Register a subdomain at **duckdns.org** — free, permanent, no card, sign in with
GitHub/Google. Copy the token it shows you.

**Names are global and first-come-first-served.** `pakt.duckdns.org` is already
taken by someone else. Check a candidate before you settle on it — no A record
means it is free:

```bash
dig +short paktapp.duckdns.org   # prints nothing => available
```

Known free at the time of writing: `paktapp` · `getpakt` · `joinpakt` ·
`paktin` · `pakthq` · `paktdeals` · `paktexchange` · `paktpay` · `paktlive` ·
`paktindia` · `paktnow`.

### 3. Install Node and Caddy

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs caddy
node --version                  # must be >= 23.4
```

### 4. Lay out the app

Code and data live apart on purpose: the systemd unit mounts everything
read-only except the data directory, so the running process cannot rewrite its
own source.

```bash
sudo useradd --system --home /opt/pakt --shell /usr/sbin/nologin pakt
sudo mkdir -p /opt/pakt /var/lib/pakt /etc/pakt
sudo chown -R pakt:pakt /opt/pakt /var/lib/pakt

# from your laptop:
rsync -av --exclude 'pakt.db*' --exclude '.git' ./ user@VM_IP:/tmp/pakt/
# on the VM:
sudo cp -r /tmp/pakt/* /opt/pakt/ && sudo chown -R pakt:pakt /opt/pakt
```

### 5. Configure

```bash
sudo cp /opt/pakt/.env.example /etc/pakt/pakt.env
sudo nano /etc/pakt/pakt.env
sudo chmod 600 /etc/pakt/pakt.env
sudo chown pakt:pakt /etc/pakt/pakt.env
```

Three values matter and have no safe default:

- `PAKT_ADMIN_EMAILS` — without it no operator exists, so **no dispute can ever
  be resolved** and the SLA sweep deliberately does nothing.
- `PAKT_DB=/var/lib/pakt/pakt.db` — the persistent path, not the repo.
- `PAKT_TRUST_PROXY=1` — one proxy (Caddy) in front. Leave it at 0 behind a
  proxy and the entire internet shares one rate-limit bucket.

Also set `PAKT_HOST=127.0.0.1`. This is what makes trusting `X-Forwarded-For`
safe: if the origin is unreachable from outside, nobody can connect directly
and forge a header to launder their address.

### 6. Start

Everything from here is one command — `deploy/bootstrap.sh` does steps 3–8,
including DNS, the renewal cron, systemd, Caddy, backups and verification:

```bash
sudo bash /opt/pakt/deploy/bootstrap.sh paktapp.duckdns.org paktapp <duckdns-token> you@gmail.com
```

Or by hand:

```bash
sudo cp /opt/pakt/deploy/pakt.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pakt
sudo journalctl -u pakt -f          # check the startup warnings

sudo cp /opt/pakt/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # set your hostname
sudo systemctl restart caddy
```

Open `https://pakt.duckdns.org`. Certificate, renewal and redirect are Caddy's
problem from here.

### 7. Verify it is actually right

```bash
curl -s https://pakt.duckdns.org/api/health
curl -sI https://pakt.duckdns.org/app | grep -i -E 'content-security|strict-transport|x-frame'
curl -s https://pakt.duckdns.org/api/meta | head -c 400   # operators_configured must be true
```

Then confirm rate limiting sees real client addresses rather than the proxy —
if `PAKT_TRUST_PROXY` is wrong, a burst from one browser locks out everyone:

```bash
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code} " \
  -X POST https://pakt.duckdns.org/api/login \
  -H 'Content-Type: application/json' -d '{"email":"a@b.co","password":"nope1234"}'; done
```

You should see `401`s turn into `429`s — and a request from a *different*
network should still get `401`, not `429`.

### 8. Back up

SQLite with WAL cannot be safely copied with `cp` while the process is running.

```bash
sudo -u pakt sqlite3 /var/lib/pakt/pakt.db ".backup '/var/lib/pakt/backup-$(date +%F).db'"
```

Put that in a daily cron. The database is the entire company.

---

## Alternatives, and when to pick them

### Reaching it from India

Nothing here is geo-restricted — once DNS resolves and the certificate is
issued, the URL works from any connection anywhere, mobile data included. For
latency from Hyderabad, Oracle's **ap-hyderabad-1** and **ap-mumbai-1** regions
are the closest; Singapore adds roughly 60–80 ms, which is unnoticeable for this
app. Pick by whichever region actually has free Ampere capacity.

| Option | Free URL | Verdict |
|---|---|---|
| **Oracle Always Free + DuckDNS** | `pakt.duckdns.org` | **Recommended.** Real always-on VM, real disk, free indefinitely. Capacity can be hard to get. |
| Google Cloud `e2-micro` Always Free + DuckDNS | `pakt.duckdns.org` | Same shape, smaller machine, easier to obtain. Same setup as above. |
| Fly.io | `pakt.fly.dev` | Fastest to stand up; volumes work; no spin-down if autostop is off. No longer a true free tier — small allowance then pay-as-you-go. |
| Tailscale Funnel from a machine you own | `pakt.<tailnet>.ts.net` | Genuinely free, HTTPS, stable name, ten minutes. Only as reliable as the machine it runs on. Good for a demo link this week. |
| Cloudflare Tunnel | `<random>.trycloudflare.com` | Free and instant, but the quick-tunnel hostname changes on every restart. Stable names need a domain you own. |
| Render / Railway free tiers | `pakt.onrender.com` | **Do not use for this app.** Spin-down kills the sweeper and the ephemeral disk erases the database on restart. |
| Vercel / Netlify / Cloudflare Workers | — | Wrong shape entirely: serverless, no persistent disk, no long-running timer, no `node:sqlite`. |

---

## Before real money

The escrow machine is real; the payment provider is not. `payments.chargeBrand`
and `payments.payoutCreator` in `lib/services.js` return synthetic references.
They are called only from inside the state machine, so swapping in Razorpay
Route or Stripe Connect is a two-function change — and provider failure is
already handled safely, with funds staying in escrow.

Until that swap, **say plainly on the site that payments are simulated.** A
live-looking escrow product that does not move money is the one thing here that
could actually harm someone.
