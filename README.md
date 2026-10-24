# IIITH Mess MCP

Manage your IIIT Hyderabad mess (dining) account by chatting. Connect it to Claude, ChatGPT or another app that supports MCP connectors, then ask it to check menus, change your mess, cancel meals or show your bill:

- "What's for dinner at Kadamba tonight?"
- "Cancel my lunch on Friday and register me at Yuktahar for dinner instead."
- "How much is my mess bill this month?"

This is an unofficial student project. It is not affiliated with the IIIT Hyderabad mess administration.

## Use the hosted connector

A public instance is running. Every app asks for this address:

```
https://iiith-mess-mcp.tech/mcp
```

- Setup page, with step-by-step instructions and a copy button: https://iiith-mess-mcp.tech/
- Video guide: https://youtu.be/A3CGL5TJSxs
- Privacy details: https://iiith-mess-mcp.tech/privacy

The first time you connect, your app opens a sign-in page on that server and you paste a dining key once. The server checks the key with the portal, stores it encrypted and gives your app its own token. You never put the key in a config file.

Please read the privacy page before you connect. The server has to decrypt your key to use it, so whoever runs it can technically read it, or act on your account with it. Only connect if you trust them, and use a key you made just for this. The page also says how the server is hosted and who can see the traffic.

The steps below are the same as on the setup page, which is the easiest thing to send a friend.

## 1. Get a dining key

1. Open https://dining.iiit.ac.in and go to Settings, then Auth Keys.
2. Press Create. Make a new key just for this, so you can delete it later without affecting anything else.

Treat the key like a password: anyone with it can register, cancel and change meals on your account. Paste it only on the sign-in page your app opens. Never paste it into a chat, a GitHub issue or anywhere else public.

## 2. Add the connector to your app

Claude (claude.ai, the desktop app and mobile):

1. Open Settings, then Connectors.
2. Choose Add custom connector. Name it "IIITH Mess" and paste the address above.
3. Click Add, then Connect.
4. On the sign-in page that opens, paste your dining key and press Connect.
5. Start a new chat and ask about your meals.

If you can't find Add custom connector in the mobile app, add it from a computer first. It then shows up on your phone.

ChatGPT (needs a plan that includes developer mode):

1. On the ChatGPT website, open Settings, then Apps (called Connectors in some versions), then Advanced settings, and turn on Developer mode.
2. Go back and choose Create. Name it "IIITH Mess", paste the address and, if it asks for authentication, choose OAuth. Tick the box saying you trust the app and create it.
3. On the sign-in page that opens, paste your dining key and press Connect.
4. In a new chat, use the + button under the message box to turn on IIITH Mess.

ChatGPT changes these menus often, so names may differ. OpenAI's help pages have the current steps.

Claude Code:

```bash
claude mcp add --transport http mess https://iiith-mess-mcp.tech/mcp -s user
```

Then start Claude Code, type /mcp, pick mess and choose to sign in. A page opens in your browser: paste your dining key there.

Cursor and VS Code (and any other app with remote MCP servers): add a remote server (sometimes called HTTP or Streamable HTTP) with the address above. It needs no other settings. When the app asks you to sign in, paste your key on the page that opens.

For Cursor, put this in ~/.cursor/mcp.json:

```json
{ "mcpServers": { "mess": { "url": "https://iiith-mess-mcp.tech/mcp" } } }
```

For VS Code, put this in .vscode/mcp.json:

```json
{ "servers": { "mess": { "type": "http", "url": "https://iiith-mess-mcp.tech/mcp" } } }
```

## Disconnecting

1. Remove the connector in your app.
2. Delete the key on dining.iiit.ac.in under Settings, then Auth Keys. This is the step that matters: it stops the key working everywhere straight away, including the copy stored on the server.

If the portal rejects the key, the next request fails and your app asks you to sign in again. The privacy page explains when the server deletes its own copy.

## What it can do

Your app can register and cancel meals for you. Registrations are added to your bill and cancellations count toward your monthly limit, so read what it plans to do before you say yes. Tools are marked read-only, write or destructive, so apps can ask before cancelling or deleting anything.

There are 19 tools. Dates are YYYY-MM-DD in IST, and money is in paise.

Menus and messes:

- get_mess_info: the messes with their IDs, ratings and serving times. For a meal, only the messes serving it, with its rate and the seats left.
- get_menu: the menu for a day at every mess, or for one meal and/or mess.
- get_deadlines: today's date, the first date each change is still allowed for, and the cancellations used and allowed this month.

Meals:

- get_registrations: your meals over a date range (default: the next 7 days), with status and price.
- set_meal_mess: choose, or change, the mess for one or more meals. Charged to your bill.
- cancel_meal: opt out of meals. Not charged, but it uses one of your monthly cancellations. Can undo.
- skip_meal: say you won't come. You are still charged and no cancellation is used. Can undo.

Extras:

- get_extras: extra items on offer for a meal, and the ones you have registered.
- register_extra: register for an extra item. Charged to your bill.
- delete_extra_registration: delete an extra you registered.

Monthly registration:

- get_monthly_registration: your registration for a month.
- create_monthly_registration: register at one mess for a whole month. Charged to your bill.
- delete_monthly_registration: delete it.

Bill and feedback:

- get_bill: your bill for a month, split into what you already availed and what is upcoming.
- submit_feedback: anonymous rating (1 to 5) and remarks for a meal you ate.
- get_meal_rating: the average rating for a meal, for one mess or all.

Account:

- get_account: your profile and preferences.
- update_preferences: change your preferences: email reminders, daily QR token reset, feedback prompts and so on.
- reset_qr_token: reset the QR code used to verify meals. The old QR code stops working.

Version 0.3.0 merged 31 tools into these 19 and renamed some of them. register_meal is now set_meal_mess, uncancel_meal became the undo option of cancel_meal, and get_user_info and get_preferences became get_account. If your app saved permissions for the old names, allow the new ones again.

## Run it yourself

Both options below are secondary: most people should use the hosted connector. The mess portal API is only reachable from the IIITH network or VPN, so a server you run yourself has to be on campus, and so does the stdio option. You need Node.js 22.13 or newer.

Run it locally (stdio): your app starts the server on your computer and gives it your key directly, with no sign-in page.

```bash
git clone https://github.com/edwardEsmerson/mess-mcp-iiith.git
cd mess-mcp-iiith
npm install
npm run build
```

Claude Code:

```bash
claude mcp add mess -s user -e MESS_API_KEY=your-key -- node /path/to/mess-mcp-iiith/dist/stdio.js
```

Claude Desktop, Cursor and other apps (JSON config):

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

It isn't on npm yet, so there is no npx command.

Host a server for others: run the HTTP server on a machine on the IIITH network and make it reachable over HTTPS (Tailscale Funnel, optionally behind your own domain with a Cloudflare Worker). Step by step, with systemd, the Worker, the dashboard and troubleshooting: [docs/hosting.md](docs/hosting.md).

```bash
PUBLIC_URL=https://your-host MCP_SECRET=$(openssl rand -base64 32) npm run start:http
```

The server reads these environment variables. [.env.example](.env.example) has the same list with comments. The server doesn't load a .env file by itself: pass it with `node --env-file=.env dist/http.js`, or use systemd's EnvironmentFile as docs/hosting.md does.

- PUBLIC_URL (required): the public https origin clients use, with no path. The MCP endpoint is PUBLIC_URL/mcp. http://localhost works for local testing.
- MCP_SECRET (required): 32 random bytes, base64. Encrypts stored keys and signs sign-in pages. Generate one with `openssl rand -base64 32`.
- HOST and PORT (default 127.0.0.1 and 3000): where to listen.
- DATA_DIR (default ./data): where the SQLite database goes. systemd's StateDirectory takes precedence.
- ALLOWED_HOSTS: extra Host headers to accept, comma-separated. PUBLIC_URL's host, localhost and 127.0.0.1 are always allowed.
- ALLOWED_ORIGINS: extra browser origins to accept. Usually empty.
- TRUST_PROXY (default loopback): which proxies to trust for client addresses, in Express "trust proxy" syntax. Used for rate limiting.
- PROXY_SECRET: secret shared with the Cloudflare Worker so rate limits see each visitor's own address instead of one shared Cloudflare address. At least 20 characters. Set the same value on the Worker.
- DASHBOARD_PASSWORD: turns on the usage dashboard at /dashboard and Prometheus metrics at /metrics. At least 10 characters. Leave it empty to record nothing.
- HOSTING_NOTE: plain text shown on the /privacy page under "How this server is hosted", so users know who can see their traffic. Say so if a proxy like Cloudflare sits in front, because it can read the keys users paste.
- MESS_API_URL (default https://mess.iiit.ac.in/api): the portal API base URL.
- MESS_API_KEY: stdio mode only. Your dining key.

How sign-in works: the same server is both the MCP server (an OAuth resource server) and a small OAuth 2.1 authorization server. Clients find it through the 401 response and /.well-known/oauth-protected-resource/mcp. They identify themselves with a Client ID Metadata Document, or with Dynamic Client Registration as a fallback, and sign in with PKCE. Access tokens last an hour. Refresh tokens last 60 days and rotate on every use. Raw dining keys are not accepted on /mcp; use stdio if you want to pass a key directly.

## Contributing

Issues and pull requests are welcome. Never put a dining key or token in either.

```bash
npm install
npm run typecheck    # the static check; there is no linter
npm test             # builds, then runs every suite in test/ against a mock or fake portal (no real key needed)
npm start            # stdio server (needs MESS_API_KEY)
npm run start:http   # HTTP server (needs PUBLIC_URL and MCP_SECRET; PUBLIC_URL=http://localhost:3000 works locally)
```

CI runs the typecheck and the tests on Node 22 and 24 for every pull request. [AGENTS.md](AGENTS.md) has the conventions: the code layout, how to add a tool, the security rules and how to run a single test. When you change anything in src/auth/ or src/http.ts, add a case to test/e2e.test.mjs. When you add or change a tool, add one to test/tools.test.mjs.

To try the server interactively, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector -e MESS_API_KEY=your-key node dist/stdio.js
```

## Security

Never post a dining key or an mmcp_ token anywhere public, including issues, pull requests and screenshots. If you did, delete the key on dining.iiit.ac.in first. [SECURITY.md](SECURITY.md) explains what to do and how to report a vulnerability privately.

## Not done yet

- Publish to npm for npx installs. It is blocked for now (package.json is marked private), and it would only help people on the campus network, since the portal can't be reached from anywhere else.

## Credits

Thanks to [NJP6969/IIITH-mess-MCP](https://github.com/NJP6969/IIITH-mess-MCP), which first mapped out the portal API endpoints.

## License

MIT. See [LICENSE](LICENSE).
