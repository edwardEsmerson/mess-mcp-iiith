# IIITH Mess MCP

An [MCP](https://modelcontextprotocol.io) server for the IIIT Hyderabad mess (dining) portal. Connect it to Claude or any other MCP client and manage your meals in plain language:

> "What's for dinner at Kadamba tonight?"
> "Cancel my lunch on Friday and register me at Yuktahar for dinner instead."
> "How much is my mess bill this month?"

> [!NOTE]
> Work in progress. Local (stdio) works today, and the hosted server supports OAuth sign-in so claude.ai, Claude Desktop and Claude Code can connect with just a URL. See [Roadmap](#roadmap).

## What it can do

| Area | Tools |
|---|---|
| Menus & info | `get_mess_info`, `get_menu`, `get_meal_rates`, `get_meal_capacities`, `get_meal_timings` |
| Registrations | `get_registrations`, `get_registration`, `register_meal`, `cancel_meal`, `uncancel_meal`, `skip_meal` |
| Monthly | `get_monthly_registration`, `create_monthly_registration`, `delete_monthly_registration` |
| Extras | `get_extras`, `get_extra_registrations`, `register_extra`, `delete_extra_registration` |
| Bills & feedback | `get_bill`, `submit_feedback`, `get_meal_rating` |
| Rules | `get_registration_window`, `get_registration_max_date`, `get_cancellation_window`, `get_max_cancellations`, `get_cancellation_count` |
| Account | `get_user_info`, `reset_qr_token`, `get_preferences`, `update_preferences` |

Tools are annotated as read-only or destructive, so clients can ask before cancelling or deleting anything.

## Requirements

- **IIITH network or VPN.** The mess portal API is only reachable from campus. Whatever machine runs this server must be on the IIITH network.
- **A mess portal API key.** For the hosted server you paste it into a sign-in page instead of a config file. To create one, go to [dining.iiit.ac.in](https://dining.iiit.ac.in) → Settings → Auth Keys → **Create**. Make a separate key just for this, so you can revoke it without affecting anything else. Treat it like a password: anyone with it can register, cancel and change meals on your account.
- Node.js 22.13 or newer.

## Setup

```bash
git clone https://github.com/edwardEsmerson/mess-mcp-iiith.git
cd mess-mcp-iiith
npm install
npm run build
```

### Option 1: local (stdio)

The client starts the server on your machine. Simplest if you're on campus and only use it yourself.

**Claude Code**

```bash
claude mcp add mess -s user -e MESS_API_KEY=your-key -- node /path/to/mess-mcp-iiith/dist/stdio.js
```

**Claude Desktop, Cursor and others** (JSON config)

```json
{
  "mcpServers": {
    "mess": {
      "command": "node",
      "args": ["/path/to/mess-mcp-iiith/dist/stdio.js"],
      "env": { "MESS_API_KEY": "your-key" }
    }
  }
}
```

### Option 2: connect to a hosted server (claude.ai, Claude Desktop, Claude Code, Cursor, VS Code)

If someone on campus runs the hosted server (see [docs/hosting.md](docs/hosting.md)), you only need its URL, e.g. `https://mess.example.ts.net/mcp`. The first time you connect, a page opens asking for your dining auth key. The server checks the key with the portal, stores it encrypted and gives your app its own token. You never put the key in a config file.

**claude.ai / Claude Desktop / mobile:** Settings → Connectors → Add custom connector → paste the URL → Connect.

**Claude Code:**

```bash
claude mcp add --transport http mess https://your-host/mcp -s user
```

Then run `/mcp` in Claude Code and pick `mess` to sign in.

**Cursor** (`~/.cursor/mcp.json`) and **VS Code** (`.vscode/mcp.json`):

```json
{ "mcpServers": { "mess": { "url": "https://your-host/mcp" } } }
```

```json
{ "servers": { "mess": { "type": "http", "url": "https://your-host/mcp" } } }
```

If you revoke the key on the portal, the next request fails and your app asks you to sign in again. To disconnect, remove the connector in your app and delete the key on the portal.

### Option 3: host it yourself

Run the HTTP server on a machine on the IIITH network and expose it over HTTPS (Tailscale Funnel or Cloudflare Tunnel). Step by step: [docs/hosting.md](docs/hosting.md).

```bash
PUBLIC_URL=https://your-host MCP_SECRET=$(openssl rand -base64 32) npm run start:http
```

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | (required) | Public https origin clients use, no path. The MCP endpoint is `PUBLIC_URL/mcp` |
| `MCP_SECRET` | (required) | 32 random bytes, base64. Encrypts stored keys and signs sign-in pages |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Where to listen |
| `DATA_DIR` | `./data` | SQLite database location (systemd's `StateDirectory` takes precedence) |
| `ALLOWED_HOSTS` | `PUBLIC_URL`'s host + localhost | Extra `Host` headers to accept |
| `ALLOWED_ORIGINS` | `PUBLIC_URL`'s host | Extra browser origins to accept |
| `TRUST_PROXY` | `loopback` | Proxies trusted for client IPs (rate limiting) |
| `MESS_API_URL` | `https://mess.iiit.ac.in/api` | Portal API base URL |

**How sign-in works:** this server is both the MCP server (an OAuth resource server) and a small OAuth 2.1 authorization server. Clients find it through the `401` response and `/.well-known/oauth-protected-resource/mcp`. They identify themselves with a Client ID Metadata Document, or with Dynamic Client Registration as a fallback, and sign in with PKCE. Access tokens last an hour. Refresh tokens last 60 days and rotate on every use. Raw dining keys are not accepted on `/mcp`; use stdio if you want to pass a key directly.

## Development

```bash
npm run build        # compile to dist/
npm run typecheck    # type-check only
npm test             # end-to-end OAuth + MCP tests against a mock portal
npm start            # stdio server (needs MESS_API_KEY)
npm run start:http   # HTTP server (needs PUBLIC_URL and MCP_SECRET; PUBLIC_URL=http://localhost:3000 works locally)
```

Try it interactively with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector -e MESS_API_KEY=your-key node dist/stdio.js
```

## Roadmap

- [x] Port tools to `McpServer.registerTool` with zod validation and tool annotations
- [x] MCP TypeScript SDK v2 (spec 2026-07-28), stateless Streamable HTTP
- [x] OAuth sign-in (paste your dining key once), so claude.ai, Claude Desktop and Claude Code's `/mcp` can connect with just a URL
- [x] systemd unit and a hosting guide (Tailscale Funnel or Cloudflare Tunnel)
- [x] End-to-end test suite (`npm test`)
- [ ] Publish to npm for `npx` installs

## Credits

Thanks to [NJP6969/IIITH-mess-MCP](https://github.com/NJP6969/IIITH-mess-MCP), which first mapped out the portal API endpoints. MIT licensed; see [LICENSE](LICENSE).

This is an unofficial student project and is not affiliated with the IIIT Hyderabad mess administration.
