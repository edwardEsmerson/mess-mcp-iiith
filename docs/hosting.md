# Hosting the server

This runs the HTTP server with OAuth so anyone at IIITH can add it to claude.ai, Claude Desktop, Claude Code and other clients with just a URL.

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

**Your own domain (optional):** a Cloudflare Worker on the domain forwards every request to the Funnel URL. The public instance runs this way at `mess.iiith-mess-mcp.tech`.

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
   PUBLIC_URL=https://mess.your-domain.tld
   ALLOWED_HOSTS=your-machine.your-tailnet.ts.net
   ```
   ```bash
   sudo systemctl restart mess-mcp
   ```

Keep Funnel running; the Worker depends on it. Cloudflare terminates TLS, so it can see traffic to the server, including the dining keys pasted on the sign-in page. Changing `PUBLIC_URL` invalidates existing tokens (they are bound to `PUBLIC_URL/mcp`), so everyone has to remove the connector and add the new URL. Keep `MCP_SECRET` the same.

## 5. Check it from outside

From a device that isn't on your tailnet (e.g. your phone on mobile data). A tailnet machine resolves the `.ts.net` name to its `100.x` address and skips Funnel entirely, so it proves nothing. Use your `PUBLIC_URL`:

```bash
curl -s https://your-public-url/.well-known/oauth-protected-resource/mcp
```

The `resource` in the reply must be `PUBLIC_URL/mcp`. Then add `PUBLIC_URL/mcp` as a custom connector in claude.ai and connect.

## Updating

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
- **Sign-in sends you to the `.ts.net` address:** `PUBLIC_URL` still has the Funnel URL. Set it to your domain and restart.
- **Sign-in page says it couldn't reach the mess portal:** the machine has lost campus network access (check with the `curl` from "What you need").
