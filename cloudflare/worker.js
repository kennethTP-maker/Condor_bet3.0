// Radar live proxy (Cloudflare Worker). Read-only for visitors. No keys in the code.
// Scheduled (cron trigger): asks GitHub to run the data workflow, because GitHub's own
// schedule often skips hours. Needs the secret GH_TOKEN (fine-grained token, this repo only,
// permission "Contents: Read and write").
// /kalshi/<markets|events|series...>?query  -> Kalshi public API
// /drafted/<slug>?df=...&dt=...             -> Drafted.gg results page
var ALLOWED_ORIGINS = ["https://kennethtp-maker.github.io", "http://localhost:8765"];
var KALSHI = "https://api.elections.kalshi.com/trade-api/v2/";
var KALSHI_PATHS = /^(markets|events|series)(\/[A-Za-z0-9_.-]+)?$/;
var ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
var DRAFTED_SLUGS = ["valkyrie-cup", "valhalla-cup", "valhalla-league", "valhalla-league-ehockey"];

function cors(origin) {
  var allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin"
  };
}

function reply(text, status, origin) {
  return new Response(text, { status: status, headers: cors(origin) });
}

// repository_dispatch: a fine-grained token only needs "Contents: Read and write" on this repo
var GH_DISPATCH = "https://api.github.com/repos/kennethTP-maker/Condor_bet3.0/dispatches";

// Ask GitHub to run the data workflow; keep the outcome in KV (STATUS) for troubleshooting.
async function dispatch(env) {
  var note = { at: new Date().toISOString(), status: 0, body: "" };
  if (!env.GH_TOKEN) {
    note.body = "GH_TOKEN missing";
  } else {
    try {
      var r = await fetch(GH_DISPATCH, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + String(env.GH_TOKEN).trim(),
          "Accept": "application/vnd.github+json",
          "User-Agent": "radar-live-cron",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ event_type: "radar-refresh" })
      });
      note.status = r.status;
      note.body = (await r.text()).slice(0, 300);
    } catch (e) {
      note.body = "fetch error: " + String(e);
    }
  }
  if (env.STATUS) await env.STATUS.put("last-cron", JSON.stringify(note));
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },

  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return reply(null, 204, origin);
    if (request.method !== "GET") return reply("Method not allowed", 405, origin);

    var upstream = "";
    var ttl = 10;
    var type = "application/json";

    if (url.pathname.indexOf("/kalshi/") === 0) {
      var path = url.pathname.slice(8);
      if (!KALSHI_PATHS.test(path)) return reply("Not allowed", 403, origin);
      upstream = KALSHI + path + url.search;
    } else if (url.pathname.indexOf("/drafted/") === 0) {
      var slug = url.pathname.slice(9);
      if (DRAFTED_SLUGS.indexOf(slug) < 0) return reply("Not allowed", 403, origin);
      var df = url.searchParams.get("df") || "";
      var dt = url.searchParams.get("dt") || "";
      if (!ISO.test(df) || !ISO.test(dt)) return reply("df and dt are required", 400, origin);
      upstream = "https://drafted.gg/" + slug + "/results?df=" + encodeURIComponent(df) + "&dt=" + encodeURIComponent(dt);
      ttl = 30;
      type = "text/html; charset=utf-8";
    } else {
      return reply("Radar live proxy OK", 200, origin);
    }

    var cache = caches.default;
    var key = new Request(upstream, { method: "GET" });
    var res = await cache.match(key);
    if (!res) {
      var r = await fetch(upstream, { headers: { "User-Agent": "radar-live-proxy/1.0", "Accept": type } });
      res = new Response(r.body, { status: r.status, headers: { "Content-Type": type, "Cache-Control": "public, max-age=" + ttl } });
      if (r.ok) ctx.waitUntil(cache.put(key, res.clone()));
    }
    var out = new Response(res.body, res);
    var h = cors(origin);
    for (var k in h) out.headers.set(k, h[k]);
    return out;
  }
};
