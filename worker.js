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
    const a = url.pathname.match(/^\/api\/auth\/(signup|login|logout|me|data|delete)$/);
    if (a) {
      // Accounts: writes must come from this site (blocks cross-site form tricks).
      if (request.method !== "GET") {
        const origin = request.headers.get("Origin");
        let same = false; try { same = !!origin && new URL(origin).host === url.host; } catch (e) {}
        if (!same) return json({ error: "Forbidden" }, 403, url.host);
      }
      const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts"));
      const fwd = new Request("https://accounts/" + a[1], { method: request.method, headers: { "content-type": "application/json", "cookie": request.headers.get("Cookie") || "", "x-ip": request.headers.get("CF-Connecting-IP") || "local", "x-secure": url.protocol === "https:" ? "1" : "0" }, body: request.method === "GET" ? null : await request.text() });
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
    if (!seat) {
      const taken = Object.values(meta.seats);
      seat = !taken.includes("a") ? "a" : !taken.includes("b") ? "b" : null;
      if (!seat) return fail("full");
      meta.seats[pid] = seat;
    }
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
    server.send(JSON.stringify({ t: "hello", you: { pid, seat, name }, players: this.players(meta, server), state }));
    this.broadcast({ t: "peers", players: this.players(meta) }, server);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  players(meta, extra, except) {
    const online = new Set();
    for (const ws of this.ctx.getWebSockets()) { if (ws === except) continue; const a = ws.deserializeAttachment(); if (a) online.add(a.pid); }
    if (extra) { const a = extra.deserializeAttachment(); if (a) online.add(a.pid); }
    return Object.entries(meta.seats).map(([pid, seat]) => ({ seat, name: (meta.names || {})[pid] || "Player", online: online.has(pid) }));
  }

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
    } else if (msg.t === "act" && (me.seat === "a" || me.seat === "b")) { // a move from either player, relayed to the other
      this.broadcast({ t: "act", from: me.seat, data: msg.data }, ws);
    } else if (msg.t === "emote" && EMOTES.includes(msg.e)) {
      this.broadcast({ t: "emote", from: me.seat, e: msg.e }, ws);
    } else return;
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async webSocketClose(ws) {
    const meta = await this.ctx.storage.get("meta");
    if (meta) this.broadcast({ t: "peers", players: this.players(meta, null, ws) }, ws);
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

    const s = await this.session(req);
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
      return json({ ok: true }, 200, null, { "set-cookie": this.cookie("", secure, 0) });
    }
    return json({ error: "Not found" }, 404);
  }
}
