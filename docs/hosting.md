# Hosting the server

This runs the HTTP server with OAuth so anyone at IIITH can add it to claude.ai, ChatGPT, Claude Code and other clients with just a URL.

## What you need

- A Linux machine with systemd that's **always on the IIITH network**, because the portal API is only reachable from campus. Check with:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://mess.iiit.ac.in/api/auth/me   # expect 401
  ```
- **A public HTTPS address.** claude.ai connects from Anthropic's servers, not from campus. These steps use Tailscale Funnel, which needs no domain. To use your own domain, put a Cloudflare Worker in front of Funnel (step 4). Cloudflare Tunnel does **not** work on campus: it needs outbound port 7844 (UDP and TCP), which the IIITH network blocks.
- Node.js 22.13+ (`sudo apt install nodejs npm` on Ubuntu 24.04+).

Resources are tiny: about 60 MB RAM, and a SQLite file that grows by a few KB per user.

## 1. Install

```bash
sudo git clone https://github.com/edwardEsmerson/mess-mcp-iiith.git /opt/mess-mcp
cd /opt/mess-mcp
sudo npm ci
sudo npm run build
```

## 2. Configure

Pick the public URL first. With Tailscale Funnel it's `https://<machine>.<tailnet>.ts.net`. **Use port 443.** claude.ai failed to connect to a Funnel on 8443 ("Couldn't reach this address") although the server was publicly reachable, so if 443 is busy, move whatever is there.

```bash
sudo install -m 600 /dev/null /etc/mess-mcp.env
sudo tee /etc/mess-mcp.env >/dev/null <<CONF
PUBLIC_URL=https://your-machine.your-tailnet.ts.net
MCP_SECRET=$(openssl rand -base64 32)
HOST=127.0.0.1
PORT=3000
CONF
```

Every setting is listed with comments in `.env.example` (the README has the same list). The ones used below are `PUBLIC_URL`, `MCP_SECRET`, `ALLOWED_HOSTS` (step 4), `PROXY_SECRET` (step 4), `HOSTING_NOTE` (step 6) and `DASHBOARD_PASSWORD` (step 7).

`MCP_SECRET` encrypts the stored dining keys. Back it up along with `/var/lib/mess-mcp/` (`mess-mcp.db`, plus the `-wal` and `-shm` files next to it). If you lose it, nothing leaks: everyone just has to reconnect.

## 3. Run it with systemd

```bash
sudo cp /opt/mess-mcp/deploy/mess-mcp.service /etc/systemd/system/
# Remove the OnFailure= line if you don't have a notify-failure@ unit
sudo systemctl daemon-reload
sudo systemctl enable --now mess-mcp
systemctl status mess-mcp
curl -s http://127.0.0.1:3000/healthz   # ok
```

The unit runs as a throwaway user (`DynamicUser=yes`) with a read-only view of the system. Its only writable directory is `/var/lib/mess-mcp`.

Logs: `journalctl -u mess-mcp -f`. Keys and tokens are never logged.

## 4. Expose it

**Tailscale Funnel:**

```bash
sudo tailscale funnel --bg --https=443 http://127.0.0.1:3000
tailscale funnel status
```

If Funnel isn't enabled for your tailnet yet, the command prints a link that turns it on. `--bg` keeps the setting across reboots. Funnel exposes everything served on that port, so don't mix private services into the 443 config.

**Your own domain (optional):** a Cloudflare Worker on the domain forwards every request to the Funnel URL. The public instance runs this way at `iiith-mess-mcp.tech`.

1. Add the domain to Cloudflare (free plan) and point its nameservers at Cloudflare. No DNS records are needed; the Worker's custom domain creates them.
2. Edit `deploy/cloudflare-worker/wrangler.toml`: set `pattern` to your hostname and `ORIGIN` to your Funnel URL (no path).
3. Deploy from your own computer:
   ```bash
   cd deploy/cloudflare-worker
   npx wrangler login
   npx wrangler deploy
   ```
4. On the server, make the domain the public URL and accept the Funnel hostname the Worker forwards to, then restart:
   ```bash
   # in /etc/mess-mcp.env
   PUBLIC_URL=https://your-domain.tld
   ALLOWED_HOSTS=your-machine.your-tailnet.ts.net
   ```
   ```bash
   sudo systemctl restart mess-mcp
   ```
5. **Let the rate limits tell visitors apart (recommended).** Through the Worker every request reaches the server from a Cloudflare address, so people connecting via the same Cloudflare location would share one rate limit, and one person hammering `/authorize` could lock the others out of signing in. The Worker passes each visitor's address in an `X-Mess-Client-IP` header along with a shared secret in `X-Mess-Proxy-Secret`. The server believes the address only when the secret equals its `PROXY_SECRET` (and otherwise uses the connection's address, as before), and the Worker overwrites both headers on every request so visitors can't forge them. Set the same secret in both places; nothing changes until both match, so the order doesn't matter:
   ```bash
   openssl rand -hex 32          # prints the secret; copy it
   ```
   On the server:
   ```bash
   sudoedit /etc/mess-mcp.env    # add a line: PROXY_SECRET=<the secret>
   sudo systemctl restart mess-mcp
   journalctl -u mess-mcp -n 5   # shows "Client IPs: trusting the Worker's address header ..."
   ```
   On your computer:
   ```bash
   cd deploy/cloudflare-worker
   npx wrangler secret put PROXY_SECRET   # paste the same secret when asked
   npx wrangler deploy                    # once, so the Worker sends the headers
   ```
   Check it: `curl -s https://your-domain.tld/healthz`, then `journalctl -u mess-mcp -n 5` should show "Client IPs: the proxy secret matched ...". If it says the secret "doesn't match PROXY_SECRET" instead, the two values differ. The log never contains addresses or the secret, and each line appears once per restart. To turn it off, remove the line and restart (and `npx wrangler secret delete PROXY_SECRET`). Requests that reach the Funnel URL directly carry no secret and are limited by connection address.

Keep Funnel running; the Worker depends on it. Cloudflare terminates TLS, so it can see traffic to the server, including the dining keys pasted on the sign-in page. Say so in `HOSTING_NOTE` (step 6) so users can find out. Changing `PUBLIC_URL` invalidates existing tokens (they are bound to `PUBLIC_URL/mcp`), so everyone has to remove the connector and add the new URL. Keep `MCP_SECRET` the same.

## 5. Check it from outside

From a device that isn't on your tailnet (e.g. your phone on mobile data). A tailnet machine resolves the `.ts.net` name to its `100.x` address and skips Funnel entirely, so it proves nothing. Use your `PUBLIC_URL`:

```bash
curl -s https://your-public-url/.well-known/oauth-protected-resource/mcp
```

The `resource` in the reply must be `PUBLIC_URL/mcp`. Then add `PUBLIC_URL/mcp` as a custom connector in claude.ai and connect.

## 6. Say how it's hosted (recommended)

The public `PUBLIC_URL/privacy` page tells users who can see their dining key. The server can't tell how you expose it, so by default the page only says that the operator hasn't described the setup. Set `HOSTING_NOTE` to add your own description under "How this server is hosted":

```bash
sudoedit /etc/mess-mcp.env       # add a line: HOSTING_NOTE="Runs on a machine on the IIITH campus network, behind Cloudflare."
sudo systemctl restart mess-mcp  # the pages are rendered once at startup
```

It is plain text (HTML is escaped). Be specific about anything in front of the server: a proxy like Cloudflare ends the secure connection and can read the dining keys users paste, while Tailscale Funnel only passes encrypted traffic along and can't. Open `PUBLIC_URL/privacy` to see how it reads. Leave it unset to show nothing.

## 7. Metrics dashboard (optional)

The server can count what it does and show it at `PUBLIC_URL/dashboard`: active users per day, tool calls and failures per tool, sign-ins, which apps are connected, and whether the mess portal is reachable. It's off until you pick a password:

```bash
sudoedit /etc/mess-mcp.env       # add a line: DASHBOARD_PASSWORD=something-you-will-remember
sudo systemctl restart mess-mcp
journalctl -u mess-mcp -n 3      # prints "Dashboard: PUBLIC_URL/dashboard"
```

(The old name `METRICS_TOKEN` is still read, so existing configs keep working.) Open `PUBLIC_URL/dashboard` and sign in with that password. The browser stays signed in for 30 days; changing the password signs everyone out. Use the 7/30/90 day buttons for the time range. It's on the public internet, so the password must be at least 10 characters, and wrong guesses are rate limited.

Only totals are stored, in the same SQLite file: counts per day, tool and outcome, plus which connection IDs made a call on which day (to count active users; deleted after 90 days). No keys, tokens, names or meal data. Daily totals are written once a minute and on shutdown.

The same numbers are at `PUBLIC_URL/metrics` in Prometheus format, for Grafana or alerting. Point a scraper at the local port so traffic stays on the machine:

```yaml
scrape_configs:
  - job_name: mess-mcp
    static_configs: [{ targets: ["127.0.0.1:3000"] }]
    authorization: { credentials_file: /etc/prometheus/mess-mcp-password }   # the DASHBOARD_PASSWORD
```

Prometheus counters restart from zero when the service restarts (Prometheus handles that); the dashboard's daily totals don't.

## Updating

**From your laptop** (works even if the server has no npm or git): one command builds, tests, copies and restarts. It asks for your sudo password on the server once.

```bash
npm run deploy -- your-ssh-host
```

**On the server**, if you installed from a git checkout:

```bash
cd /opt/mess-mcp
sudo git pull
sudo npm ci
sudo npm run build
sudo systemctl restart mess-mcp
```

## Troubleshooting

- **claude.ai says "Couldn't reach the MCP server":** run the step 5 check from outside your network. If it fails, the problem is Funnel or the Worker, not the app.
- **`Host ... is not allowed` (403):** the client used a hostname other than `PUBLIC_URL`'s. Add it to `ALLOWED_HOSTS`. Behind the Worker this means the `.ts.net` host is missing from it.
- **Several people get "Too many requests" (429) at the same time:** behind the Worker the server counts everyone from one Cloudflare location as a single visitor. Set up `PROXY_SECRET` (step 5 under "Your own domain").
- **Sign-in sends you to the `.ts.net` address:** `PUBLIC_URL` still has the Funnel URL. Set it to your domain and restart.
- **Sign-in page says it couldn't reach the mess portal:** the machine has lost campus network access (check with the `curl` from "What you need").
