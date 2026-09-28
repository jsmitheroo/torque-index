// Torque Index — Cloudflare Worker: serves the site and runs online battle rooms.
// Each room code maps to one Durable Object that relays moves between the two players.
import { DurableObject } from "cloudflare:workers";

const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const EMOTES = ["👏", "🔥", "😂", "😮", "GG"];

// Security headers added to every page and file the site serves.
function securityHeaders(host) {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      `connect-src 'self' wss://${host} ws://${host}`,
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

function withHeaders(res, host) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(securityHeaders(host))) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ping") {
      return withHeaders(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }), url.host);
    }
    const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)$/);
    if (m) {
      // Only pages on this site may open a room connection (stops other websites using your server).
      const origin = request.headers.get("Origin");
      if (origin) { try { if (new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 }); } catch (e) { return new Response("Forbidden", { status: 403 }); } }
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response("Bad room code", { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    const a = url.pathname.match(/^\/api\/(?:auth\/(signup|login|logout|me|data|delete)|x\/(lb-laps|lb-lap|lb-wins|lb-win|cup|cup-post|social|friend-add|friend-respond|friend-remove|invite|invite-clear|reviews|review|review-del|profile|notifs|notifs-read))$/);
    if (a) {
      // Accounts: writes must come from this site (blocks cross-site form tricks).
      if (request.method !== "GET") {
        const origin = request.headers.get("Origin");
        let same = false; try { same = !!origin && new URL(origin).host === url.host; } catch (e) {}
        if (!same) return json({ error: "Forbidden" }, 403, url.host);
      }
      const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts"));
      const fwd = new Request("https://accounts/" + (a[1] || a[2]) + url.search, { method: request.method, headers: { "content-type": "application/json", "cookie": request.headers.get("Cookie") || "", "x-ip": request.headers.get("CF-Connecting-IP") || "local", "x-secure": url.protocol === "https:" ? "1" : "0" }, body: request.method === "GET" ? null : await request.text() });
      return withHeaders(await stub.fetch(fwd), url.host);
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return withHeaders(await env.ASSETS.fetch(request), url.host);
  },
};

function json(obj, status = 200, host, extra = {}) {
  const r = new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
  return host ? withHeaders(r, host) : r;
}

const IDLE_MS = 3 * 60 * 60 * 1000; // rooms tidy themselves away after 3 idle hours
const RATE = 15, BURST = 40;         // messages per second per player, with a short burst allowance

export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.buckets = new Map(); }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(request.url);
    const create = url.searchParams.get("create") === "1";
    const pid = (url.searchParams.get("pid") || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || crypto.randomUUID();
    const name = (url.searchParams.get("name") || "Player").replace(/[<>"'`&\u0000-\u001f\u007f]/g, "").trim().slice(0, 16) || "Player";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const fail = (code) => { server.send(JSON.stringify({ t: "error", code })); server.close(4001, code); return new Response(null, { status: 101, webSocket: client }); };

    let meta = await this.ctx.storage.get("meta");
    if (!meta) {
      if (!create) return fail("notfound");
      meta = { created: Date.now(), seats: {} };
    }
    // one seat per person; a returning player keeps their seat
    let seat = meta.seats[pid];
    const watch = url.searchParams.get("watch") === "1";
    if (!seat && !watch) {
      const taken = Object.values(meta.seats);
      seat = ["a", "b", "c", "d"].find(s => !taken.includes(s)) || null;   // up to four players
      if (seat) meta.seats[pid] = seat;
    }
    if (!seat) seat = "s";                                                   // everyone else watches
    meta.names = meta.names || {};
    meta.names[pid] = name;
    await this.ctx.storage.put("meta", meta);
    // replace any older connection from the same player
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === server) continue;
      const a = ws.deserializeAttachment();
      if (a && a.pid === pid) { try { ws.close(4000, "replaced"); } catch (e) {} }
    }
    server.serializeAttachment({ pid, seat, name });
    const state = (await this.ctx.storage.get("state")) || null;
    server.send(JSON.stringify({ t: "hello", you: { pid, seat, name }, players: this.players(meta, server), watchers: this.watchers(), state }));
    this.broadcast({ t: "peers", players: this.players(meta), watchers: this.watchers() }, server);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  players(meta, extra, except) {
    const online = new Set();
    for (const ws of this.ctx.getWebSockets()) { if (ws === except) continue; const a = ws.deserializeAttachment(); if (a) online.add(a.pid); }
    if (extra) { const a = extra.deserializeAttachment(); if (a) online.add(a.pid); }
    return Object.entries(meta.seats).map(([pid, seat]) => ({ seat, name: (meta.names || {})[pid] || "Player", online: online.has(pid) }));
  }

  watchers(except) { let n = 0; for (const ws of this.ctx.getWebSockets()) { if (ws === except) continue; const a = ws.deserializeAttachment(); if (a && a.seat === "s") n++; } return n; }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { if (ws !== except) { try { ws.send(s); } catch (e) {} } }
  }

  // Flood protection: each player gets a small allowance of messages that refills over time.
  allow(ws, pid) {
    const now = Date.now();
    const b = this.buckets.get(pid) || { tokens: BURST, at: now, strikes: 0 };
    b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE);
    b.at = now;
    let ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    else if (++b.strikes > 200) { try { ws.close(4008, "too many messages"); } catch (e) {} }
    this.buckets.set(pid, b);
    return ok;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 64000) return;
    const me = ws.deserializeAttachment() || {};
    if (!this.allow(ws, me.pid || "?")) return;
    if (raw.includes("<")) return;                        // game data never contains HTML, so drop anything that tries
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "ping") { ws.send(JSON.stringify({ t: "pong" })); return; }
    if (msg.t === "state" && me.seat === "a") {           // only the host writes the shared game state
      if (!msg.state || typeof msg.state !== "object") return;
      await this.ctx.storage.put("state", msg.state);
      this.broadcast({ t: "state", state: msg.state }, ws);
    } else if (msg.t === "act" && ["a", "b", "c", "d"].includes(me.seat)) { // a move from a player, relayed to everyone else
      this.broadcast({ t: "act", from: me.seat, data: msg.data }, ws);
    } else if (msg.t === "chat") {                         // room chat: plain text only, short
      const text = String(msg.text || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
      if (text) this.broadcast({ t: "chat", from: me.seat, name: me.name, text, at: Date.now() }, ws);
    } else if (msg.t === "emote" && EMOTES.includes(msg.e)) {
      this.broadcast({ t: "emote", from: me.seat, e: msg.e }, ws);
    } else return;
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async webSocketClose(ws) {
    const meta = await this.ctx.storage.get("meta");
    if (meta) this.broadcast({ t: "peers", players: this.players(meta, null, ws), watchers: this.watchers(ws) }, ws);
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }
}

/* ============ Accounts: sign up, log in, and sync progress between devices ============ */
const SESSION_DAYS = 30;
const ITER = 100000;                                 // PBKDF2 rounds (the most Workers allow)
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,}$/;

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT UNIQUE COLLATE NOCASE, salt TEXT, hash TEXT, created INTEGER, data TEXT, updated INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid TEXT, expires INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS attempts(k TEXT PRIMARY KEY, n INTEGER, reset INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS laps(uid TEXT, track TEXT, car TEXT, t REAL, created INTEGER, PRIMARY KEY(uid,track))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wins(uid TEXT, game TEXT, n INTEGER, PRIMARY KEY(uid,game))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cup(week INTEGER, uid TEXT, t REAL, created INTEGER, PRIMARY KEY(week,uid))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS friends(a TEXT, b TEXT, status TEXT, created INTEGER, PRIMARY KEY(a,b))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY AUTOINCREMENT, to_uid TEXT, from_uid TEXT, code TEXT, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reviews(car TEXT, uid TEXT, rating INTEGER, text TEXT, created INTEGER, PRIMARY KEY(car,uid))`);
    try { this.sql.exec(`ALTER TABLE users ADD COLUMN seen INTEGER`); } catch (e) {}
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, kind TEXT, text TEXT, link TEXT, created INTEGER, read INTEGER DEFAULT 0)`);
  }
  // Counts attempts per key inside a time window; returns false once the limit is hit.
  limit(k, max, windowMs) {
    const now = Date.now();
    const row = this.sql.exec(`SELECT n, reset FROM attempts WHERE k=?`, k).toArray()[0];
    if (!row || row.reset < now) { this.sql.exec(`INSERT OR REPLACE INTO attempts(k,n,reset) VALUES(?,?,?)`, k, 1, now + windowMs); return true; }
    if (row.n >= max) return false;
    this.sql.exec(`UPDATE attempts SET n=n+1 WHERE k=?`, k); return true;
  }
  cookie(token, secure, maxAge) { return `ti_session=${token}; Path=/; HttpOnly; SameSite=Lax;${secure ? " Secure;" : ""} Max-Age=${maxAge}`; }
  async session(req) {
    const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)ti_session=([a-f0-9]{64})/);
    if (!m) return null;
    const row = this.sql.exec(`SELECT s.uid, s.expires, u.username, u.email, u.created, u.updated FROM sessions s JOIN users u ON u.id=s.uid WHERE s.token=?`, await sha256(m[1])).toArray()[0];
    if (!row || row.expires < Date.now()) return null;
    return { ...row, raw: m[1] };
  }
  async newSession(uid, secure) {
    const token = rand(32);
    this.sql.exec(`INSERT INTO sessions(token,uid,expires) VALUES(?,?,?)`, await sha256(token), uid, Date.now() + SESSION_DAYS * 864e5);
    this.sql.exec(`DELETE FROM sessions WHERE expires<?`, Date.now());
    return this.cookie(token, secure, SESSION_DAYS * 86400);
  }
  pub(u) { return { username: u.username, email: u.email, created: u.created, updated: u.updated || null }; }

  async fetch(req) {
    const route = new URL(req.url).pathname.slice(1);
    const ip = req.headers.get("x-ip") || "?";
    const secure = req.headers.get("x-secure") === "1";
    let body = {};
    if (req.method !== "GET") { const t = await req.text(); if (t.length > 300000) return json({ error: "Too much data" }, 413); try { body = JSON.parse(t || "{}"); } catch (e) { return json({ error: "Bad request" }, 400); } }

    if (route === "signup" && req.method === "POST") {
      if (!this.limit("su:" + ip, 5, 3600e3)) return json({ error: "Too many sign-ups from this network. Try again later." }, 429);
      const username = String(body.username || "").trim(), email = String(body.email || "").trim().toLowerCase(), pw = String(body.password || "");
      if (!USER_RE.test(username)) return json({ error: "Usernames are 3–20 letters, numbers or underscores.", field: "username" }, 400);
      if (!EMAIL_RE.test(email)) return json({ error: "That email address doesn't look right.", field: "email" }, 400);
      if (pw.length < 8 || pw.length > 200) return json({ error: "Passwords need at least 8 characters.", field: "password" }, 400);
      if (this.sql.exec(`SELECT 1 FROM users WHERE username=?`, username).toArray().length) return json({ error: "That username is taken.", field: "username" }, 409);
      if (this.sql.exec(`SELECT 1 FROM users WHERE email=?`, email).toArray().length) return json({ error: "There's already an account with that email. Try logging in.", field: "email" }, 409);
      const id = crypto.randomUUID(), salt = rand(16), hash = await hashPw(pw, salt), now = Date.now();
      const data = body.data && typeof body.data === "object" ? JSON.stringify(body.data) : null;
      this.sql.exec(`INSERT INTO users(id,email,username,salt,hash,created,data,updated) VALUES(?,?,?,?,?,?,?,?)`, id, email, username, salt, hash, now, data, data ? now : null);
      return json({ user: { username, email, created: now, updated: data ? now : null } }, 200, null, { "set-cookie": await this.newSession(id, secure) });
    }

    if (route === "login" && req.method === "POST") {
      const who = String(body.login || "").trim(), pw = String(body.password || "");
      if (!this.limit("li:" + ip, 20, 900e3) || !this.limit("lu:" + who.toLowerCase(), 10, 900e3)) return json({ error: "Too many attempts. Wait 15 minutes and try again." }, 429);
      const u = this.sql.exec(`SELECT * FROM users WHERE email=? OR username=?`, who.toLowerCase(), who).toArray()[0];
      const ok = u ? same(await hashPw(pw, u.salt), u.hash) : (await hashPw(pw, "00".repeat(16)), false);
      if (!ok) return json({ error: "Wrong username, email or password." }, 401);
      return json({ user: this.pub(u), data: u.data ? JSON.parse(u.data) : null }, 200, null, { "set-cookie": await this.newSession(u.id, secure) });
    }

    const q = new URL(req.url).searchParams;
    const s = await this.session(req);
    const pub = await this.publicRoutes(route, q, s);
    if (pub) return pub;
    if (route === "me") return json({ user: s ? this.pub(s) : null });
    if (!s) return json({ error: "Please log in." }, 401);

    if (route === "logout" && req.method === "POST") {
      this.sql.exec(`DELETE FROM sessions WHERE token=?`, await sha256(s.raw));
      return json({ ok: true }, 200, null, { "set-cookie": this.cookie("", secure, 0) });
    }
    if (route === "data" && req.method === "GET") {
      const u = this.sql.exec(`SELECT data FROM users WHERE id=?`, s.uid).toArray()[0];
      return json({ data: u && u.data ? JSON.parse(u.data) : null });
    }
    if (route === "data" && req.method === "PUT") {
      if (!this.limit("sy:" + s.uid, 120, 3600e3)) return json({ error: "Syncing too often." }, 429);
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return json({ error: "Bad data" }, 400);
      const now = Date.now();
      this.sql.exec(`UPDATE users SET data=?, updated=? WHERE id=?`, JSON.stringify(body.data), now, s.uid);
      return json({ ok: true, updated: now });
    }
    if (route === "delete" && req.method === "POST") {
      const u = this.sql.exec(`SELECT * FROM users WHERE id=?`, s.uid).toArray()[0];
      if (!u || !same(await hashPw(String(body.password || ""), u.salt), u.hash)) return json({ error: "That password isn't right.", field: "password" }, 401);
      this.sql.exec(`DELETE FROM sessions WHERE uid=?`, s.uid);
      this.sql.exec(`DELETE FROM users WHERE id=?`, s.uid);
      for (const t of ["laps","wins","cup","reviews","notifs"]) this.sql.exec(`DELETE FROM ${t} WHERE uid=?`, s.uid);
      this.sql.exec(`DELETE FROM friends WHERE a=? OR b=?`, s.uid, s.uid);this.sql.exec(`DELETE FROM invites WHERE to_uid=? OR from_uid=?`, s.uid, s.uid);
      return json({ ok: true }, 200, null, { "set-cookie": this.cookie("", secure, 0) });
    }
    const soc = await this.socialRoutes(route, body, s);
    if (soc) return soc;
    return json({ error: "Not found" }, 404);
  }

  notify(uid, kind, text, link) { this.sql.exec(`INSERT INTO notifs(uid,kind,text,link,created) VALUES(?,?,?,?,?)`, uid, kind, String(text).slice(0, 200), link || "", Date.now()); this.sql.exec(`DELETE FROM notifs WHERE uid=? AND id NOT IN (SELECT id FROM notifs WHERE uid=? ORDER BY id DESC LIMIT 50)`, uid, uid); }

  /* ---------- leaderboards, weekly cup, reviews (anyone can read) ---------- */
  async publicRoutes(route, q, s) {
    const TRACK_RE = /^[a-z]{2,16}$/, CAR_RE = /^[a-z0-9-]{2,90}$/;
    if (route === "lb-laps") {
      const track = String(q.get("track") || ""); if (!TRACK_RE.test(track)) return json({ error: "Bad track" }, 400);
      const top = this.sql.exec(`SELECT u.username, l.car, l.t, l.created FROM laps l JOIN users u ON u.id=l.uid WHERE l.track=? ORDER BY l.t ASC LIMIT 25`, track).toArray();
      const mine = s ? this.sql.exec(`SELECT car, t FROM laps WHERE uid=? AND track=?`, s.uid, track).toArray()[0] || null : null;
      return json({ top, mine });
    }
    if (route === "lb-wins") {
      const game = String(q.get("game") || ""); if (!/^(bb|cd|champ)$/.test(game)) return json({ error: "Bad game" }, 400);
      return json({ top: this.sql.exec(`SELECT u.username, w.n FROM wins w JOIN users u ON u.id=w.uid WHERE w.game=? ORDER BY w.n DESC LIMIT 25`, game).toArray() });
    }
    if (route === "cup") {
      const week = Math.floor(Date.now() / 6048e5);
      const top = this.sql.exec(`SELECT u.username, c.t FROM cup c JOIN users u ON u.id=c.uid WHERE c.week=? ORDER BY c.t ASC LIMIT 32`, week).toArray();
      const mine = s ? (this.sql.exec(`SELECT t FROM cup WHERE week=? AND uid=?`, week, s.uid).toArray()[0] || null) : null;
      return json({ week, top, mine, ends: (week + 1) * 6048e5 });
    }
    if (route === "profile") {
      const u = this.sql.exec(`SELECT id, username, created, data FROM users WHERE username=?`, String(q.get("u") || "").trim()).toArray()[0];
      if (!u) return json({ error: "No player with that name." }, 404);
      let d = {}; try { d = JSON.parse(u.data || "{}"); } catch (e) {}
      const pubGarage = d["ti-public"] !== false;
      const av = d["ti-avatar"] && typeof d["ti-avatar"] === "object" ? d["ti-avatar"] : null;
      const laps = this.sql.exec(`SELECT l.track, l.car, l.t, (SELECT COUNT(*)+1 FROM laps x WHERE x.track=l.track AND x.t<l.t) AS rank FROM laps l WHERE l.uid=? ORDER BY rank ASC, l.t ASC`, u.id).toArray();
      const wins = Object.fromEntries(this.sql.exec(`SELECT game, n FROM wins WHERE uid=?`, u.id).toArray().map(r => [r.game, r.n]));
      const reviews = this.sql.exec(`SELECT car, rating, text, created FROM reviews WHERE uid=? ORDER BY created DESC LIMIT 10`, u.id).toArray();
      const ach = d["ti-ach"] && typeof d["ti-ach"] === "object" ? Object.keys(d["ti-ach"]).length : 0;
      const friends = this.sql.exec(`SELECT COUNT(*) AS n FROM friends WHERE (a=? OR b=?) AND status='ok'`, u.id, u.id).toArray()[0].n;
      let rel = null;
      if (s && s.uid !== u.id) { const f = this.sql.exec(`SELECT a, status FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)`, s.uid, u.id, u.id, s.uid).toArray()[0]; rel = f ? (f.status === "ok" ? "friends" : f.a === s.uid ? "requested" : "incoming") : "none"; }
      return json({ username: u.username, created: u.created, avatar: av, garage: pubGarage && Array.isArray(d["ti-fav"]) ? d["ti-fav"].slice(0, 24) : null, laps, wins, reviews, ach, friends, me: s ? s.uid === u.id : false, rel });
    }
    if (route === "reviews") {
      const car = String(q.get("car") || ""); if (!CAR_RE.test(car)) return json({ error: "Bad car" }, 400);
      const items = this.sql.exec(`SELECT u.username, r.rating, r.text, r.created FROM reviews r JOIN users u ON u.id=r.uid WHERE r.car=? ORDER BY r.created DESC LIMIT 30`, car).toArray();
      const agg = this.sql.exec(`SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE car=?`, car).toArray()[0];
      const mine = s ? (this.sql.exec(`SELECT rating, text FROM reviews WHERE car=? AND uid=?`, car, s.uid).toArray()[0] || null) : null;
      return json({ n: agg.n, avg: agg.avg, items, mine });
    }
    return null;
  }

  /* ---------- things that need you signed in ---------- */
  async socialRoutes(route, body, s) {
    const now = Date.now(), uname = u => this.sql.exec(`SELECT id, username FROM users WHERE username=?`, String(u || "").trim()).toArray()[0];
    if (route === "lb-lap") {
      if (!this.limit("lb:" + s.uid, 200, 3600e3)) return json({ error: "Slow down" }, 429);
      const track = String(body.track || ""), car = String(body.car || ""), t = +body.t;
      if (!/^[a-z]{2,16}$/.test(track) || !/^[a-z0-9-]{2,90}$/.test(car) || !(t > 15 && t < 2000)) return json({ error: "Bad lap" }, 400);
      const old = this.sql.exec(`SELECT t FROM laps WHERE uid=? AND track=?`, s.uid, track).toArray()[0];
      const holder = this.sql.exec(`SELECT uid, t FROM laps WHERE track=? ORDER BY t ASC LIMIT 1`, track).toArray()[0];
      if (!old || t < old.t) this.sql.exec(`INSERT OR REPLACE INTO laps(uid,track,car,t,created) VALUES(?,?,?,?,?)`, s.uid, track, car, t, now);
      if (holder && holder.uid !== s.uid && t < holder.t) this.notify(holder.uid, "record", `${s.username} beat your lap record on ${track} (${t.toFixed(3)}s)`, "#leaderboards");
      const rank = this.sql.exec(`SELECT COUNT(*)+1 AS r FROM laps WHERE track=? AND t<?`, track, Math.min(t, old ? old.t : t)).toArray()[0].r;
      return json({ ok: true, best: !old || t < old.t, rank });
    }
    if (route === "lb-win") {
      if (!this.limit("lw:" + s.uid, 60, 3600e3)) return json({ error: "Slow down" }, 429);
      const game = String(body.game || ""); if (!/^(bb|cd|champ)$/.test(game)) return json({ error: "Bad game" }, 400);
      this.sql.exec(`INSERT INTO wins(uid,game,n) VALUES(?,?,1) ON CONFLICT(uid,game) DO UPDATE SET n=n+1`, s.uid, game);
      return json({ ok: true });
    }
    if (route === "cup-post") {
      if (!this.limit("cp:" + s.uid, 120, 3600e3)) return json({ error: "Slow down" }, 429);
      const week = Math.floor(now / 6048e5), t = +body.t;
      if (+body.week !== week) return json({ error: "That cup has finished" }, 409);
      if (!(t > 15 && t < 2000)) return json({ error: "Bad time" }, 400);
      const old = this.sql.exec(`SELECT t FROM cup WHERE week=? AND uid=?`, week, s.uid).toArray()[0];
      if (!old || t < old.t) this.sql.exec(`INSERT OR REPLACE INTO cup(week,uid,t,created) VALUES(?,?,?,?)`, week, s.uid, t, now);
      return json({ ok: true, best: !old || t < old.t });
    }
    if (route === "review") {
      if (!this.limit("rv:" + s.uid, 20, 3600e3)) return json({ error: "Slow down" }, 429);
      const car = String(body.car || ""), rating = Math.round(+body.rating), text = String(body.text || "").replace(/[<>]/g, "").trim().slice(0, 600);
      if (!/^[a-z0-9-]{2,90}$/.test(car) || !(rating >= 1 && rating <= 5)) return json({ error: "Pick 1 to 5 stars" }, 400);
      this.sql.exec(`INSERT OR REPLACE INTO reviews(car,uid,rating,text,created) VALUES(?,?,?,?,?)`, car, s.uid, rating, text, now);
      return json({ ok: true });
    }
    if (route === "review-del") { this.sql.exec(`DELETE FROM reviews WHERE car=? AND uid=?`, String(body.car || ""), s.uid); return json({ ok: true }); }
    if (route === "notifs") {
      const items = this.sql.exec(`SELECT id, kind, text, link, created, read FROM notifs WHERE uid=? ORDER BY id DESC LIMIT 30`, s.uid).toArray();
      return json({ items, unread: items.filter(i => !i.read).length });
    }
    if (route === "notifs-read") { this.sql.exec(`UPDATE notifs SET read=1 WHERE uid=?`, s.uid); return json({ ok: true }); }
    if (route === "social") {
      this.sql.exec(`UPDATE users SET seen=? WHERE id=?`, now, s.uid);
      const fr = this.sql.exec(`SELECT u.username, u.seen FROM friends f JOIN users u ON u.id = CASE WHEN f.a=? THEN f.b ELSE f.a END WHERE (f.a=? OR f.b=?) AND f.status='ok' ORDER BY u.username`, s.uid, s.uid, s.uid).toArray();
      const incoming = this.sql.exec(`SELECT u.username FROM friends f JOIN users u ON u.id=f.a WHERE f.b=? AND f.status='pending'`, s.uid).toArray().map(r => r.username);
      const outgoing = this.sql.exec(`SELECT u.username FROM friends f JOIN users u ON u.id=f.b WHERE f.a=? AND f.status='pending'`, s.uid).toArray().map(r => r.username);
      this.sql.exec(`DELETE FROM invites WHERE created<?`, now - 15 * 60e3);
      const invites = this.sql.exec(`SELECT i.id, u.username AS "from", i.code, i.created FROM invites i JOIN users u ON u.id=i.from_uid WHERE i.to_uid=? ORDER BY i.created DESC LIMIT 5`, s.uid).toArray();
      const unread = this.sql.exec(`SELECT COUNT(*) AS n FROM notifs WHERE uid=? AND read=0`, s.uid).toArray()[0].n;
      return json({ friends: fr.map(r => ({ username: r.username, online: !!r.seen && now - r.seen < 90e3, seen: r.seen || null })), incoming, outgoing, invites, unread });
    }
    if (route === "friend-add") {
      if (!this.limit("fa:" + s.uid, 30, 3600e3)) return json({ error: "Slow down" }, 429);
      const o = uname(body.username); if (!o) return json({ error: "No player with that username." }, 404); if (o.id === s.uid) return json({ error: "That's you!" }, 400);
      const rev = this.sql.exec(`SELECT status FROM friends WHERE a=? AND b=?`, o.id, s.uid).toArray()[0];
      if (rev) { this.sql.exec(`UPDATE friends SET status='ok' WHERE a=? AND b=?`, o.id, s.uid); return json({ ok: true, now: "friends" }); }
      this.sql.exec(`INSERT OR IGNORE INTO friends(a,b,status,created) VALUES(?,?,'pending',?)`, s.uid, o.id, now);
      this.notify(o.id, "friend", `${s.username} sent you a friend request`, "#friends");
      return json({ ok: true, now: "requested" });
    }
    if (route === "friend-respond") {
      const o = uname(body.username); if (!o) return json({ error: "Not found" }, 404);
      if (body.accept) this.sql.exec(`UPDATE friends SET status='ok' WHERE a=? AND b=? AND status='pending'`, o.id, s.uid);
      else this.sql.exec(`DELETE FROM friends WHERE a=? AND b=?`, o.id, s.uid);
      return json({ ok: true });
    }
    if (route === "friend-remove") { const o = uname(body.username); if (o) this.sql.exec(`DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)`, s.uid, o.id, o.id, s.uid); return json({ ok: true }); }
    if (route === "invite") {
      if (!this.limit("iv:" + s.uid, 40, 3600e3)) return json({ error: "Slow down" }, 429);
      const o = uname(body.username), code = String(body.code || "").toUpperCase();
      if (!o || !/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return json({ error: "Bad invite" }, 400);
      const ok = this.sql.exec(`SELECT 1 FROM friends WHERE ((a=? AND b=?) OR (a=? AND b=?)) AND status='ok'`, s.uid, o.id, o.id, s.uid).toArray().length;
      if (!ok) return json({ error: "You can only invite friends." }, 403);
      this.sql.exec(`INSERT INTO invites(to_uid,from_uid,code,created) VALUES(?,?,?,?)`, o.id, s.uid, code, now);
      this.notify(o.id, "invite", `${s.username} invited you to room ${code}`, "#room-" + code);
      return json({ ok: true });
    }
    if (route === "invite-clear") { this.sql.exec(`DELETE FROM invites WHERE id=? AND to_uid=?`, +body.id, s.uid); return json({ ok: true }); }
    return null;
  }
}
