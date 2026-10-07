// Forwards the public domain to the campus server's Tailscale Funnel URL.
// Cloudflare Tunnel can't be used because the campus network blocks port 7844.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.ORIGIN);
    // Pass redirects (OAuth) through to the client instead of following them here.
    return fetch(new Request(target, request), { redirect: "manual" });
  },
};
