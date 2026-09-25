// Torque Index — Cloudflare Worker: serves the site and runs online battle rooms.
// Each room code maps to one Durable Object that relays moves between the two players.
import { DurableObject } from "cloudflare:workers";

const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ping") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response("Bad room code", { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

const IDLE_MS = 3 * 60 * 60 * 1000; // rooms tidy themselves away after 3 idle hours

export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(request.url);
    const create = url.searchParams.get("create") === "1";
    const pid = (url.searchParams.get("pid") || "").slice(0, 64) || crypto.randomUUID();
    const name = (url.searchParams.get("name") || "Player").replace(/[<>]/g, "").slice(0, 16) || "Player";

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

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 64000) return;
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    const me = ws.deserializeAttachment() || {};
    if (msg.t === "ping") { ws.send(JSON.stringify({ t: "pong" })); return; }
    if (msg.t === "state" && me.seat === "a") {           // only the host writes the shared game state
      await this.ctx.storage.put("state", msg.state);
      this.broadcast({ t: "state", state: msg.state }, ws);
    } else if (msg.t === "act") {                          // a move from either player, relayed to the other
      this.broadcast({ t: "act", from: me.seat, data: msg.data }, ws);
    } else if (msg.t === "emote") {
      this.broadcast({ t: "emote", from: me.seat, e: String(msg.e || "").slice(0, 24) }, ws);
    }
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
