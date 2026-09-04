/* ===========================================================================
   GeoKosova — server statik + multiplayer.
   Zero varësi npm: http + SSE. Nis me:  node server.js

   Kyçi i Google Maps lexohet nga config.json ose nga env GMAPS_KEY dhe
   u shërbehet lojtarëve që lidhen me këtë server (shih README).
   =========================================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
/* Vetëm public/ shërbehet. server.js dhe config.json bien jashtë tij, pra
   nuk arrihen dot nga rrjeti — as me path të normalizuar, as me kodim. */
const PUBLIC = path.join(ROOT, "public");
const PORT = process.env.PORT || 8765;

/* ---------------------------------------------------------------- konfigurimi */
function loadKey() {
  if (process.env.GMAPS_KEY) return process.env.GMAPS_KEY.trim();
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    if (c && typeof c.gmapsKey === "string" && c.gmapsKey.trim()) return c.gmapsKey.trim();
  } catch (e) { /* config.json nuk ekziston — normale */ }
  return null;
}
const GMAPS_KEY = loadKey();

/* ---------------------------------------------------------------- pikëzimi
   Konvencioni i GeoGuessr-it:  S = 5000 · e^(−10d/D)
   D = diagonalja e drejtkëndëshit kufizues të hartës, me haversine (R = 6371 km).
   Pikë të plota nën D/100000, por gjithsesi nën 25 m.
   Për Kosovën D del 214 251 m, pra pragu bie në 25 m.                        */
const MAX_PER_ROUND = 5000;
const BB = { s: 41.8577, n: 43.2733, w: 20.0149, e: 21.7899 };

function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const la1 = a.lat * r, la2 = b.lat * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const MAP_SIZE = Math.min(
  distM({ lat: BB.s, lng: BB.w }, { lat: BB.n, lng: BB.e }),
  distM({ lat: BB.n, lng: BB.w }, { lat: BB.s, lng: BB.e })
);
const PERFECT_M = Math.max(25, MAP_SIZE / 100000);

function pointsFor(d) {
  if (d <= PERFECT_M) return MAX_PER_ROUND;
  return Math.round(MAX_PER_ROUND * Math.exp(-10 * d / MAP_SIZE));
}

/* ---------------------------------------------------------------- dhomat */
const rooms = new Map();
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // pa I,O,0,1
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

function newCode() {
  for (let t = 0; t < 200; t++) {
    let c = "";
    for (let i = 0; i < 4; i++) {
      c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!rooms.has(c)) return c;
  }
  throw new Error("no free room code");
}
function newId() { return crypto.randomBytes(9).toString("base64url"); }

function createRoom() {
  const code = newCode();
  const room = {
    code,
    hostId: null,
    createdAt: Date.now(),
    settings: { rounds: 5, diff: "normal", time: 30, area: "mixed" },
    players: new Map(),      // id -> { id, name, token, score, connected, res, guessed }
    phase: "lobby",          // lobby | loading | round | result | final
    round: 0,
    locations: [],           // [{ panoId, lat, lng, heading }] — vetëm në server
    guesses: new Map(),      // playerId -> { lat, lng, dist, pts }
    endsAt: null,
    timer: null,
    // roundEnd/final transmetohen një herë. Ruhen që klienti i rilidhur
    // gjatë atyre fazave të mos mbetet me ekran bosh.
    lastRoundEnd: null,
    lastFinal: null
  };
  rooms.set(code, room);
  return room;
}

function publicPlayers(room) {
  return [...room.players.values()]
    .map(p => ({
      id: p.id, name: p.name, score: p.score,
      connected: p.connected, guessed: room.guesses.has(p.id),
      isHost: p.id === room.hostId
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/* Gjendja që u dërgohet klientëve. Koordinatat e përgjigjes NUK futen këtu
   sa është raundi aktiv — përndryshe do të lexoheshin nga Network tab. */
function snapshot(room) {
  const loc = room.phase === "round" ? room.locations[room.round - 1] : null;
  return {
    type: "state",
    code: room.code,
    phase: room.phase,
    round: room.round,
    rounds: room.settings.rounds,
    settings: room.settings,
    hostId: room.hostId,
    players: publicPlayers(room),
    endsAt: room.endsAt,
    serverNow: Date.now(),      // klienti llogarit ofsetin e sahatit nga kjo
    pano: loc ? { panoId: loc.panoId, heading: loc.heading } : null,
    maxPerRound: MAX_PER_ROUND
  };
}

function send(res, obj) {
  try { res.write("data: " + JSON.stringify(obj) + "\n\n"); }
  catch (e) { /* lidhja u shkëput */ }
}
function broadcast(room, obj) {
  for (const p of room.players.values()) if (p.res) send(p.res, obj);
}
function pushState(room) { broadcast(room, snapshot(room)); }

/* ---------------------------------------------------------------- raundet */
function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function startRound(room, n) {
  clearTimer(room);
  room.round = n;
  room.guesses = new Map();
  room.lastRoundEnd = null;
  room.lastFinal = null;
  room.phase = "round";
  const secs = room.settings.time;
  room.endsAt = secs ? Date.now() + secs * 1000 : null;
  pushState(room);
  if (secs) {
    room.timer = setTimeout(() => endRound(room, "time"), secs * 1000 + 400);
  }
}

function allGuessed(room) {
  const active = [...room.players.values()].filter(p => p.connected);
  if (!active.length) return false;
  return active.every(p => room.guesses.has(p.id));
}

function endRound(room, reason) {
  if (room.phase !== "round") return;
  clearTimer(room);
  const loc = room.locations[room.round - 1];
  room.phase = "result";
  room.endsAt = null;

  const results = [...room.players.values()].map(p => {
    const g = room.guesses.get(p.id) || null;
    return {
      id: p.id, name: p.name,
      guess: g ? { lat: g.lat, lng: g.lng } : null,
      dist: g ? g.dist : null,
      pts: g ? g.pts : 0,
      score: p.score
    };
  }).sort((a, b) => b.pts - a.pts);

  room.lastRoundEnd = {
    type: "roundEnd",
    round: room.round,
    reason,
    answer: { lat: loc.lat, lng: loc.lng, panoId: loc.panoId },
    results,
    isLast: room.round >= room.settings.rounds
  };
  broadcast(room, room.lastRoundEnd);
  pushState(room);
}

function finishGame(room) {
  clearTimer(room);
  room.phase = "final";
  room.endsAt = null;
  room.lastFinal = {
    type: "final",
    standings: publicPlayers(room),
    rounds: room.settings.rounds,
    maxPerRound: MAX_PER_ROUND
  };
  broadcast(room, room.lastFinal);
  pushState(room);
}

/* ---------------------------------------------------------------- veprimet */
function handleAction(body, respond) {
  const { code, playerId, token, type, payload } = body || {};
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) return respond(404, { error: "room_not_found" });

  // "join" është i vetmi veprim pa identitet paraprak.
  if (type === "join") {
    const name = String((payload && payload.name) || "").trim().slice(0, 20) || "Lojtar";
    if (room.players.size >= 12) return respond(409, { error: "room_full" });
    if (room.phase !== "lobby") return respond(409, { error: "game_in_progress" });
    const p = {
      id: newId(), name, token: newId(),
      score: 0, connected: false, res: null
    };
    room.players.set(p.id, p);
    if (!room.hostId) room.hostId = p.id;
    pushState(room);
    return respond(200, { playerId: p.id, token: p.token, hostId: room.hostId, code: room.code });
  }

  const me = room.players.get(playerId);
  if (!me || me.token !== token) return respond(403, { error: "bad_identity" });
  const isHost = me.id === room.hostId;

  switch (type) {
    case "settings": {
      if (!isHost) return respond(403, { error: "not_host" });
      if (room.phase !== "lobby") return respond(409, { error: "not_lobby" });
      const s = payload || {};
      const rounds = [3, 5, 10].includes(+s.rounds) ? +s.rounds : room.settings.rounds;
      // 10..60 sekonda me hap 10, plus 0 = pa kufi.
      const time = [0, 10, 20, 30, 40, 50, 60].includes(+s.time) ? +s.time : room.settings.time;
      const diff = ["easy", "normal", "hard"].includes(s.diff) ? s.diff : room.settings.diff;
      const area = ["mixed", "all", "towns"].includes(s.area) ? s.area : room.settings.area;
      room.settings = { rounds, time, diff, area };
      pushState(room);
      return respond(200, { ok: true });
    }

    case "prepare": {
      // Hosti kërkon të nisë: kalojmë në "loading" derisa t'i dërgojë vendet.
      if (!isHost) return respond(403, { error: "not_host" });
      if (room.phase !== "lobby" && room.phase !== "final") {
        return respond(409, { error: "bad_phase" });
      }
      for (const p of room.players.values()) p.score = 0;
      room.locations = [];
      room.round = 0;
      room.phase = "loading";
      pushState(room);
      return respond(200, { ok: true, need: room.settings.rounds });
    }

    case "locations": {
      // Vendet i zgjedh shfletuesi i hostit (StreetViewService punon vetëm në klient).
      if (!isHost) return respond(403, { error: "not_host" });
      if (room.phase !== "loading") return respond(409, { error: "bad_phase" });
      const list = Array.isArray(payload && payload.locations) ? payload.locations : [];
      const clean = list.filter(l =>
        l && typeof l.panoId === "string" && l.panoId.length &&
        Number.isFinite(+l.lat) && Number.isFinite(+l.lng)
      ).slice(0, 10).map(l => ({
        panoId: l.panoId, lat: +l.lat, lng: +l.lng,
        heading: Number.isFinite(+l.heading) ? +l.heading : 0
      }));
      if (clean.length !== room.settings.rounds) {
        return respond(400, { error: "wrong_count", got: clean.length, need: room.settings.rounds });
      }
      room.locations = clean;
      startRound(room, 1);
      return respond(200, { ok: true });
    }

    case "guess": {
      if (room.phase !== "round") return respond(409, { error: "not_round" });
      if (room.guesses.has(me.id)) return respond(409, { error: "already_guessed" });
      const g = payload || {};
      const lat = +g.lat, lng = +g.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return respond(400, { error: "bad_guess" });
      }
      if (room.endsAt && Date.now() > room.endsAt + 2000) {
        return respond(409, { error: "too_late" });
      }
      const loc = room.locations[room.round - 1];
      const d = distM({ lat, lng }, { lat: loc.lat, lng: loc.lng });
      const pts = pointsFor(d);
      room.guesses.set(me.id, { lat, lng, dist: d, pts });
      me.score += pts;
      pushState(room);
      if (allGuessed(room)) setTimeout(() => endRound(room, "all"), 250);
      return respond(200, { ok: true });
    }

    case "forceEnd": {
      if (!isHost) return respond(403, { error: "not_host" });
      endRound(room, "host");
      return respond(200, { ok: true });
    }

    case "next": {
      if (!isHost) return respond(403, { error: "not_host" });
      if (room.phase !== "result") return respond(409, { error: "bad_phase" });
      if (room.round >= room.settings.rounds) finishGame(room);
      else startRound(room, room.round + 1);
      return respond(200, { ok: true });
    }

    case "backToLobby": {
      if (!isHost) return respond(403, { error: "not_host" });
      clearTimer(room);
      room.phase = "lobby";
      room.round = 0;
      room.locations = [];
      room.guesses = new Map();
      for (const p of room.players.values()) p.score = 0;
      pushState(room);
      return respond(200, { ok: true });
    }

    default:
      return respond(400, { error: "unknown_action" });
  }
}

/* ---------------------------------------------------------------- HTTP */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8"
};

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let n = 0; const chunks = [];
  req.on("data", c => {
    n += c.length;
    if (n > 256 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
    catch (e) { cb(null); }
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  /* ---- API ---- */
  if (p === "/api/config") {
    return json(res, 200, { hasKey: !!GMAPS_KEY, key: GMAPS_KEY || null });
  }

  if (p === "/api/room" && req.method === "POST") {
    const room = createRoom();
    return json(res, 200, { code: room.code });
  }

  if (p === "/api/action" && req.method === "POST") {
    return readBody(req, body => {
      if (!body) return json(res, 400, { error: "bad_json" });
      try { handleAction(body, (s, o) => json(res, s, o)); }
      catch (e) { json(res, 500, { error: "server", detail: String(e.message) }); }
    });
  }

  if (p === "/api/stream") {
    const code = String(u.searchParams.get("room") || "").toUpperCase();
    const playerId = u.searchParams.get("playerId");
    const token = u.searchParams.get("token");
    const room = rooms.get(code);
    if (!room) return json(res, 404, { error: "room_not_found" });
    const me = room.players.get(playerId);
    if (!me || me.token !== token) return json(res, 403, { error: "bad_identity" });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write("retry: 2000\n\n");

    if (me.res) { try { me.res.end(); } catch (e) {} }
    me.res = res;
    me.connected = true;
    send(res, snapshot(room));
    // Rilidhje gjatë rezultatit ose renditjes: ripërsërit eventin e humbur,
    // përndryshe klienti mbetet pa ekranin përkatës dhe pa rrugë përpara.
    if (room.phase === "result" && room.lastRoundEnd) send(res, room.lastRoundEnd);
    if (room.phase === "final" && room.lastFinal) send(res, room.lastFinal);
    pushState(room);

    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 20000);
    req.on("close", () => {
      clearInterval(ping);
      if (me.res === res) { me.res = null; me.connected = false; }
      // Nëse hosti bie, kalojmë hostin te lojtari i radhës i lidhur.
      if (room.hostId === me.id) {
        const nextHost = [...room.players.values()].find(x => x.connected);
        if (nextHost) room.hostId = nextHost.id;
      }
      if (room.phase === "round" && allGuessed(room)) endRound(room, "all");
      pushState(room);
    });
    return;
  }

  /* ---- skedarë statikë ---- */
  let rel;
  try { rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, ""); }
  catch (e) { return json(res, 400, { error: "bad_path" }); }
  const file = path.resolve(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    return json(res, 403, { error: "forbidden" });
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("404 — nuk u gjet");
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(buf);
  });
});

/* Pastro dhomat e vjetra. */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const live = [...room.players.values()].some(x => x.connected);
    if (!live && now - room.createdAt > ROOM_TTL_MS) { clearTimer(room); rooms.delete(code); }
  }
}, 10 * 60 * 1000).unref();

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error("\nPorti " + PORT + " është i zënë nga një proces tjetër.");
    console.error("Ndalo atë proces, ose nis me port tjetër:");
    console.error("  PORT=8766 node server.js\n");
  } else if (err.code === "EACCES") {
    console.error("\nNuk ka leje për portin " + PORT + ". Provo një port mbi 1024.\n");
  } else {
    console.error("\nServeri nuk u nis: " + err.message + "\n");
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log("GeoKosova");
  console.log("  Një lojtar : http://localhost:" + PORT + "/");
  console.log("  Multiplayer: http://localhost:" + PORT + "/multiplayer.html");
  console.log("  Pa kartë   : http://localhost:" + PORT + "/mapillary.html");
  console.log(GMAPS_KEY
    ? "  Kyçi i Google: i ngarkuar, u shërbehet lojtarëve të kësaj dhome."
    : "  Kyçi i Google: nuk u gjet — çdo lojtar do t'i duhet ta fusë vetë.\n" +
      "                 Krijo config.json me {\"gmapsKey\":\"AIza...\"} për ta shmangur këtë.");
});
