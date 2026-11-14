// Protocol client: turns a raw GATT-like `link` (real Web Bluetooth or the simulator) into
// status updates, events and authenticated request/reply commands.
//
// link = { readNonce(): Promise<Uint8Array>, writeCommand(bytes): Promise<void>,
//          onStatusChunk(fn), onEventChunk(fn), onDisconnect(fn), close(), chunkSize }
import { Reassembler, chunk, decodeJson, signCommand, sealSecret, openSecret } from './protocol.js';

export class Client {
  constructor(link, getKey) {
    this.link = link; this.getKey = getKey;
    this.h = { status: [], event: [], disconnect: [] };
    this.pending = new Map(); this.nextId = 1;
    const statusRx = new Reassembler(), eventRx = new Reassembler();
    link.onStatusChunk((c) => {
      const m = statusRx.push(c); if (!m) return;
      const s = decodeJson(m); if (s) this.h.status.forEach((f) => f(s));
    });
    link.onEventChunk((c) => {
      const m = eventRx.push(c); if (!m) return;
      const e = decodeJson(m); if (!e) return;
      const p = e.id !== undefined && this.pending.get(e.id);
      if (p) { this.pending.delete(e.id); clearTimeout(p.timer); p.resolve(e); }
      this.h.event.forEach((f) => f(e));
    });
    link.onDisconnect(() => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('disconnected')); }
      this.pending.clear(); this.h.disconnect.forEach((f) => f());
    });
  }
  on(kind, fn) { this.h[kind].push(fn); return this; }

  // Sends one authenticated command and resolves with the server's reply event.
  // A reply with ok:false still resolves (the caller shows e.err); only transport trouble rejects.
  // opts.secret: a string sealed into the command as `sec` (see sealSecret); a sealed `sec` in the reply is
  // opened into reply.secret. Both use this command's nonce, so nothing secret crosses the link in clear.
  async command(cmd, timeoutMs = 8000, opts = {}) {
    const key = this.getKey();
    if (!key) throw new Error('no passphrase set');
    const id = this.nextId++;
    const nonce = await this.link.readNonce();           // fresh, single use
    const body = { ...cmd, id };
    if (opts.secret !== undefined) body.sec = await sealSecret(key, nonce, opts.secret);
    const signed = await signCommand(key, nonce, body);
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('no reply')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try { await this.link.writeCommand(signed); }
    catch (e) { const p = this.pending.get(id); if (p) { clearTimeout(p.timer); this.pending.delete(id); } throw e; }
    const r = await reply;
    if (r.sec) { try { r.secret = await openSecret(key, nonce, r.sec); } catch { r.secret = undefined; } }
    return r;
  }
  close() { this.link.close(); }
}
