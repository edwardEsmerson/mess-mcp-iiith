# IIITH Mess MCP

An [MCP](https://modelcontextprotocol.io) server for the IIIT Hyderabad mess (dining) portal. Connect it to Claude or any other MCP client and manage your meals in plain language:

> "What's for dinner at Kadamba tonight?"
> "Cancel my lunch on Friday and register me at Yuktahar for dinner instead."
> "How much is my mess bill this month?"

> [!NOTE]
> Work in progress. Local (stdio) and self-hosted HTTP with your own key work today. One-click setup on claude.ai (OAuth) is next; see [Roadmap](#roadmap).

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
- **A mess portal API key.** Go to [dining.iiit.ac.in](https://dining.iiit.ac.in) → Settings → Auth Keys → **Create**. Make a separate key just for this, so you can revoke it without affecting anything else. Treat it like a password: anyone with it can register, cancel and change meals on your account.
- Node.js 20.6 or newer.

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

### Option 2: hosted (Streamable HTTP)

Run one server that several people (or several of your devices) connect to over HTTP. Each client sends **its own** key in the `Authorization` header; the server doesn't store keys.

```bash
PORT=3000 npm run start:http
# -> mess-mcp-iiith listening on http://127.0.0.1:3000/mcp
```

Configuration (environment variables, see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Interface to bind |
| `PORT` | `3000` | Port to listen on |
| `ALLOWED_HOSTS` | localhost only | Public hostname(s) clients use, comma-separated. **Required** behind a tunnel or reverse proxy |
| `ALLOWED_ORIGINS` | none | Browser origins allowed to call `/mcp` |
| `MESS_API_URL` | `https://mess.iiit.ac.in/api` | Portal API base URL |

To make it reachable from outside campus, run it on a campus machine and expose it with a tunnel such as [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), then set `ALLOWED_HOSTS` to the public hostname.

**Connecting a client**

Claude Code:

```bash
claude mcp add --transport http mess https://your-host/mcp \
  --header "Authorization: Bearer your-key" -s user
```

Or in a project's `.mcp.json`, reading the key from your environment:

```json
{
  "mcpServers": {
    "mess": {
      "type": "http",
      "url": "https://your-host/mcp",
      "headers": { "Authorization": "Bearer ${MESS_API_KEY}" }
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "mess": { "url": "https://your-host/mcp", "headers": { "Authorization": "Bearer your-key" } } } }
```

VS Code (`.vscode/mcp.json`):

```json
{ "servers": { "mess": { "type": "http", "url": "https://your-host/mcp", "headers": { "Authorization": "Bearer your-key" } } } }
```

claude.ai and Claude Desktop custom connectors need OAuth, which isn't built yet.

## Development

```bash
npm run build        # compile to dist/
npm run typecheck    # type-check only
npm start            # stdio server (needs MESS_API_KEY)
npm run start:http   # HTTP server
```

Try it interactively with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector -e MESS_API_KEY=your-key node dist/stdio.js
```

## Roadmap

- [x] Port tools to `McpServer.registerTool` with zod validation and tool annotations
- [x] Streamable HTTP transport with per-request bearer keys
- [ ] OAuth sign-in (paste your dining key once), so claude.ai, Claude Desktop and Claude Code's `/mcp` can connect with just a URL
- [ ] Dockerfile and a Cloudflare Tunnel hosting guide
- [ ] Publish to npm for `npx` installs

## Credits

Thanks to [NJP6969/IIITH-mess-MCP](https://github.com/NJP6969/IIITH-mess-MCP), which first mapped out the portal API endpoints. MIT licensed; see [LICENSE](LICENSE).

This is an unofficial student project and is not affiliated with the IIIT Hyderabad mess administration.
