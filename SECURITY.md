# Security policy

## Never share your dining key

Do not paste your dining auth key, any `mmcp_` token, or a screenshot or log that contains one into an issue, pull request, discussion or comment. Everything on GitHub is public and stays in the history even if you delete it.

Anyone with your key can register, cancel and change meals on your account.

If you already did, or you think a key leaked anywhere:

1. Go to [dining.iiit.ac.in](https://dining.iiit.ac.in) → Settings → Auth Keys and delete the key. The old key stops working at once, and any `mmcp_` token tied to it stops working too.
2. If you still want to use the connector, create a new key there and sign in again.
3. Edit or delete the post that contained it. This does not make the old key safe again, so do step 1 first.

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

https://github.com/edwardEsmerson/mess-mcp-iiith/security/advisories/new

Say what you found, how to reproduce it, and what an attacker could do with it. Use a made-up or already-deleted key in any example. This is a one-person student project, so replies are best effort, but I will read every report.

## What is in scope

- The sign-in and OAuth code in `src/auth/`: the `/authorize` page, `/token`, `/revoke`, `/register`, token and refresh-token handling.
- How dining keys are stored (encrypted at rest) and anything that could expose them.
- The guard that stops the server fetching private or internal addresses when it looks up client metadata.
- The `/mcp` endpoint, including its Host and Origin checks and which tokens it accepts.

## What is not in scope

- The dining portal itself (dining.iiit.ac.in and its API). It is run by the institute, so report problems there to them.
- Bugs in the apps that connect to this server (claude.ai, ChatGPT, Cursor and so on).
- A self-hosted copy that is set up badly, for example a weak `MCP_SECRET` or an open port.

Only the latest code on `main` gets fixes.
