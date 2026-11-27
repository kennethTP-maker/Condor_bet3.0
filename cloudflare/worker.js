/**
 * Radar live proxy — Cloudflare Worker (free plan is enough).
 *
 * Lets the NHL / eSoccer / eBasketball Radar pages on GitHub Pages read live public data that
 * browsers cannot fetch directly (Kalshi rejects cross-site browser requests; Drafted.gg sends no CORS headers).
 *
 *   GET /kalshi/<path>?<query>    -> https://api.elections.kalshi.com/trade-api/v2/<path>?<query>
 *                                    only markets, events and series (read-only, public data)
 *   GET /drafted/<slug>?df=..&dt=.. -> https://drafted.gg/<slug>/results?df=..&dt=..  (HTML)
 *
 * No keys or secrets are used. Responses are cached at the edge for a few seconds so many viewers
 * share one upstream request.
 */
const ALLOWED_ORIGINS = [
  "https://kennethtp-maker.github.io",
  "http://localhost:8765",
];
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2/";
const KALSHI_PATHS = /^(markets|events|series)(\/[A-Za-z0-9_.-]+)?$/;
const DRAFTED_SLUGS = new Set(["valkyrie-cup", "valhalla-cup", "valhalla-league", "valhalla-league-ehockey"]);

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET, OPTIONS", "Vary": "Origin" };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors(origin) });

    let upstream, ttl, type;
    if (url.pathname.startsWith("/kalshi/")) {
      const path = url.pathname.slice("/kalshi/".length);
      if (!KALSHI_PATHS.test(path)) return new Response("Not allowed", { status: 403, headers: cors(origin) });
      upstream = KALSHI + path + url.search;
      ttl = 10;
      type = "application/json";
    } else if (url.pathname.startsWith("/drafted/")) {
      const slug = url.pathname.slice("/drafted/".length);
      if (!DRAFTED_SLUGS.has(slug)) return new Response("Not allowed", { status: 403, headers: cors(origin) });
      const df = url.searchParams.get("df"), dt = url.searchParams.get("dt");
      if (!df || !dt || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(df + "") || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(dt + "")) {
        return new Response("df and dt (ISO UTC) are required", { status: 400, headers: cors(origin) });
      }
      upstream = `https://drafted.gg/${slug}/results?df=${encodeURIComponent(df)}&dt=${encodeURIComponent(dt)}`;
      ttl = 30;
      type = "text/html; charset=utf-8";
    } else {
      return new Response("Radar live proxy: use /kalshi/... or /drafted/<slug>", { headers: cors(origin) });
    }

    const cache = caches.default;
    const key = new Request(upstream, { method: "GET" });
    let res = await cache.match(key);
    if (!res) {
      const r = await fetch(upstream, { headers: { "User-Agent": "radar-live-proxy/1.0", "Accept": type } });
      res = new Response(r.body, { status: r.status, headers: { "Content-Type": type, "Cache-Control": `public, max-age=${ttl}` } });
      if (r.ok) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    Object.entries(cors(origin)).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  },
};
