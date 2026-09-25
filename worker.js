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
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return withHeaders(await env.ASSETS.fetch(request), url.host);
  },
};

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
