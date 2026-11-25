import http from "node:http";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const cache = new Map();
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";

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

  if (saved && Date.now() - saved.time < (key.includes("/statistics") ? 300_000 : 20_000)) {
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

    if (cache.size > 5000) {
      cache.delete(cache.keys().next().value);
    }

    return { ...payload, stale: false };
  } catch (error) {
    if (saved) return { ...saved.payload, stale: true };
    throw error;
  }
}


function newsPhoto(article) {
  const images = Array.isArray(article.images) ? article.images : [];
  for (const item of [...images.filter(i=>i?.type==='header'), ...images, article.image, article.thumbnail]) {
    const raw = typeof item==='string' ? item : item?.url || item?.href;
    if (!raw) continue;
    try { const u=new URL(raw.startsWith('//')?'https:'+raw:raw); if(u.protocol==='http:')u.protocol='https:'; if(allowedPhoto(u))return u.href; } catch {}
  }
  return null;
}
function allowedPhoto(u) { return u.protocol==='https:' && !u.username && !u.password && !u.port && /(^|\.)(espncdn\.com|espn\.com|espncdn\.net)$/.test(u.hostname); }

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

    if (incoming.pathname === "/api/news-image") {
      let u; try { u=new URL(incoming.searchParams.get('url')); } catch { return send(res,400,{error:'Invalid image'}); }
      if(!allowedPhoto(u))return send(res,400,{error:'Invalid image host'});
      const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'image/*'}});
      const type=r.headers.get('content-type')||'';
      if(!r.ok||!/^image\/(jpeg|png|webp|gif|avif)(;|$)/i.test(type))return send(res,502,{error:'Image unavailable'});
      const bytes=Buffer.from(await r.arrayBuffer());
      if(bytes.length>8_000_000)return send(res,502,{error:'Image too large'});
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'});return res.end(bytes);
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
        case "news": url=new URL(`${SITE}/news?limit=30`); if(team)url.searchParams.set("team",team); break;
        case "injuries": case "depthcharts":
          if(!team) return send(res,400,{error:"Team required"});
          url=new URL(`${SITE}/teams/${team}/${resource}`); if(season)url.searchParams.set("season",season); break;
        case "summary": {
          const event = p.get("event");
          if (!event || !/^\d{1,15}$/.test(event)) return send(res,400,{error:"Invalid event"});
          url = new URL(`${SITE}/summary`);
          url.searchParams.set("event",event);
          break;
        }
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

        case "teamplayers": {
          if (!team || !season) return send(res,400,{error:"Team and season required"});
          const rosterUrl = new URL(`${SITE}/teams/${team}/roster?season=${season}`);
          const roster = (await upstream(rosterUrl)).data;
          const athletes = (roster.athletes || []).flatMap(g=>g.items||[g]).map(a=>a.athlete||a).filter(a=>a.id);
          const players=[]; let failures=0; let next=0;
          await Promise.all(Array.from({length:10},async()=>{while(next<athletes.length){const a=athletes[next++];try {
            const result=await upstream(new URL(`${CORE}/seasons/${season}/types/2/athletes/${a.id}/statistics`));
            const categories=result.data.splits?.categories;
            if(!Array.isArray(categories)) {failures++;continue;}
            players.push({athlete:{...a,team:{id:team}},categories});
          }catch{failures++;}}}));
          return send(res,200,{data:{players,failures,total:athletes.length},fetchedAt:new Date().toISOString()});
        }
        case "leagueplayers": {
          const category = p.get("category") || "passing";
          const sorts = {passing:"passingYards",rushing:"rushingYards",receiving:"receivingYards",defensive:"totalTackles",scoring:"totalTouchdowns",kicking:"fieldGoalsMade",punting:"puntingYards",returning:"kickReturnYards"};
          if (!Object.hasOwn(sorts,category)) return send(res,400,{error:"Invalid category"});
          url = new URL(`${WEB}/statistics/byathlete`);
          for (const [k,v] of Object.entries({region:"us",lang:"en",contentorigin:"espn",isqualified:"false",limit:"1000",page:"1",sort:`${category}.${sorts[category]}:desc`,seasontype:"2"})) url.searchParams.set(k,v);
          if(season) url.searchParams.set("season",season);
          break;
        }
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
          if(resource === "playerstats") {
            if(!season) return send(res,400,{error:"Season required"});
            url = new URL(`${CORE}/seasons/${season}/types/2/athletes/${player}/statistics`);
          } else url = new URL(`${WEB}/athletes/${player}/${resource === "player" ? "overview" : "gamelog"}`);
          if (season) url.searchParams.set("season",season);
          break;
        default:
          return send(res, 400, { error: "Unknown resource" });
      }

      const result=await upstream(url);
      if(resource==='news') {
        const articles=Array.isArray(result.data.articles)?result.data.articles:[];
        return send(res,200,{...result,data:{...result.data,articles:articles.map(a=>({...a,photoUrl:newsPhoto(a)})),newsVersion:'6.0'}});
      }
      return send(res, 200, result);
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