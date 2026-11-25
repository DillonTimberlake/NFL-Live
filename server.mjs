import http from "node:http";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const cache = new Map();

const SITE =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function upstream(url) {
  const key = url.toString();
  const saved = cache.get(key);

  if (saved && Date.now() - saved.time < 20_000) {
    return { ...saved.payload, stale: false };
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Data provider returned HTTP ${response.status}`);
    }

    const payload = {
      data: await response.json(),
      fetchedAt: new Date().toISOString(),
    };

    cache.set(key, { time: Date.now(), payload });

    if (cache.size > 250) {
      cache.delete(cache.keys().next().value);
    }

    return { ...payload, stale: false };
  } catch (error) {
    if (saved) return { ...saved.payload, stale: true };
    throw error;
  }
}

export async function handler(req, res) {
  try {
    const incoming = new URL(req.url || "/", "http://localhost");

    if (req.method !== "GET") {
      return send(res, 405, { error: "Method not allowed" });
    }

    if (incoming.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    if (incoming.pathname === "/api/nfl") {
      const p = incoming.searchParams;
      const resource = p.get("resource") || "scoreboard";
      const season = p.get("season");
      const week = p.get("week");
      const team = p.get("team");

      if (season && !/^(19|20)\d{2}$/.test(season)) {
        return send(res, 400, { error: "Invalid season" });
      }

      if (week && (!/^\d+$/.test(week) || +week < 1 || +week > 18)) {
        return send(res, 400, { error: "Invalid week" });
      }

      if (team && !/^\d{1,4}$/.test(team)) {
        return send(res, 400, { error: "Invalid team" });
      }

      const player = p.get("player");
      if (player && !/^\d{1,10}$/.test(player)) return send(res,400,{error:"Invalid player"});
      const WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
      let url;

      switch (resource) {
        case "scoreboard":
          url = new URL(`${SITE}/scoreboard`);
          url.searchParams.set("limit", "1000");

          if (season && week) {
            url.searchParams.set("dates", season);
            url.searchParams.set("week", week);
            url.searchParams.set("seasontype", "2");
          }
          break;

        case "standings":
          url = new URL(
            "https://site.api.espn.com/apis/v2/sports/football/nfl/standings"
          );
          if (season) url.searchParams.set("season", season);
          url.searchParams.set("seasontype", "2");
          break;

        case "schedule":
          if (!team || !season) {
            return send(res, 400, {
              error: "Team and season are required",
            });
          }

          url = new URL(`${SITE}/teams/${team}/schedule`);
          url.searchParams.set("season", season);
          url.searchParams.set("seasontype", "2");
          break;

        case "roster":
        case "teamstats":
          if (!team) return send(res,400,{error:"Team required"});
          url = new URL(`${SITE}/teams/${team}/${resource === "roster" ? "roster" : "statistics"}`);
          if (season) url.searchParams.set("season",season);
          url.searchParams.set("seasontype","2");
          break;
        case "player":
        case "gamelog":
        case "playerstats":
          if (!player) return send(res,400,{error:"Player required"});
          url = new URL(`${WEB}/athletes/${player}/${({player:"overview",gamelog:"gamelog",playerstats:"stats"})[resource]}`);
          if (season) url.searchParams.set("season",season);
          break;
        default:
          return send(res, 400, { error: "Unknown resource" });
      }

      return send(res, 200, await upstream(url));
    }

    if (
      incoming.pathname === "/" ||
      incoming.pathname === "/index.html"
    ) {
      const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
      return send(res, 200, html, "text/html");
    }

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error.message);
    return send(res, 502, {
      error: "NFL data is temporarily unavailable. Try refreshing.",
    });
  }
}
export default handler;
if (!process.env.VERCEL) {
  http.createServer(handler).listen(PORT, HOST, () => console.log(`NFL LIVE is running at http://${HOST}:${PORT}`));
}