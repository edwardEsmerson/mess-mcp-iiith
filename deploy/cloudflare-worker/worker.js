// Forwards the public domain to the campus server's Tailscale Funnel URL.
// Cloudflare Tunnel can't be used because the campus network blocks port 7844.

// The server rate limits per visitor, but through the Funnel every request comes from Cloudflare.
// So the Worker passes the visitor's address along with PROXY_SECRET (a Worker secret, never in
// wrangler.toml); the server believes the address only when the secret matches its own.
const CLIENT_IP_HEADER = "X-Mess-Client-IP";
const PROXY_SECRET_HEADER = "X-Mess-Proxy-Secret";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.ORIGIN);
    const forwarded = new Request(target, request);
    // Drop whatever the visitor sent under these names so they can't pose as the Worker
    forwarded.headers.delete(CLIENT_IP_HEADER);
    forwarded.headers.delete(PROXY_SECRET_HEADER);
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (env.PROXY_SECRET && clientIp) {
      forwarded.headers.set(CLIENT_IP_HEADER, clientIp);
      forwarded.headers.set(PROXY_SECRET_HEADER, env.PROXY_SECRET.trim());
    }
    // Pass redirects (OAuth) through to the client instead of following them here.
    return fetch(forwarded, { redirect: "manual" });
  },
};
