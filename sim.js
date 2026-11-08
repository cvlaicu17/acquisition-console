// Simulated Jetson gateway, used by the Demo button and by the tests. It speaks the REAL wire
// protocol (chunk framing, single-use nonce, HMAC check) so the page code path is the production one;
// only the radio is missing. It deliberately uses 20-byte chunks to exercise reassembly.
import { webcrypto, Reassembler, chunk, encodeJson, decodeJson, verifyCommand } from './protocol.js';

export const SIM_PASSPHRASE = 'demo-passphrase';

export class SimLink {
  constructor({ passphrase = SIM_PASSPHRASE, tickMs = 1000 } = {}) {
    this.pass = passphrase; this.chunkSize = 20; this.tickMs = tickMs;
    this.cb = { status: [], event: [], disconnect: [] };
    this.rx = new Reassembler(); this.nonce = null; this.seq = 0;
    this.state = 'idle'; this.t0 = 0; this.limit = 0; this.bag = ''; this.frames = [0, 0];
    this.stalled = false; this.warn = []; this.clockSkew = 0; this.closed = false;
    this.presets = [
      { id: 'stereo40', name: 'Stereo 40 Hz, auto exposure', maxSec: 3600 },
      { id: 'stereo40f8', name: 'Stereo 40 Hz, fixed 8 ms', maxSec: 3600 },
    ];
    this.timer = setInterval(() => this.tick(), tickMs);
    setTimeout(() => this.event({ ev: 'hello', v: 1, host: 'sim-jetson', fw: 'sim', presets: this.presets }), 50);
    setTimeout(() => this.tick(), 20);
  }
  // ---- link interface ----
  async readNonce() {
    this.nonce = webcrypto.getRandomValues(new Uint8Array(16));
    return this.nonce.slice();
  }
  async writeCommand(c) {
    // Like the real link, the whole message is cut into chunks and reassembled server-side.
    let msg = null; for (const part of chunk(c, 20)) msg = this.rx.push(part) ?? msg;
    if (!msg) return;
    const nonce = this.nonce; this.nonce = null;                    // single use, even when it fails
    let parsedId; try { parsedId = JSON.parse(decodeJson(msg).body).id; } catch { /* unsigned garbage: no id */ }
    const reply = (o) => setTimeout(() => this.event({ id: parsedId, ...o }), 30);
    if (!nonce) return reply({ ok: false, err: 'no_nonce' });
    const v = await verifyCommand(this.pass, nonce, msg);
    if (!v.ok) return reply({ ok: false, err: v.err });
    reply(this.exec(v.cmd));
  }
  onStatusChunk(f) { this.cb.status.push(f); }
  onEventChunk(f) { this.cb.event.push(f); }
  onDisconnect(f) { this.cb.disconnect.push(f); }
  close() { this.closed = true; clearInterval(this.timer); this.cb.disconnect.forEach((f) => f()); }

  // ---- simulated recorder ----
  exec(cmd) {
    switch (cmd.c) {
      case 'ping': return { ok: true, re: 'ping' };
      case 'start': {
        if (this.state !== 'idle') return { ok: false, re: 'start', err: 'busy', state: this.state };
        if (!this.presets.some((p) => p.id === cmd.preset)) return { ok: false, re: 'start', err: 'bad_preset' };
        this.state = 'starting'; this.t0 = Date.now(); this.limit = Math.max(0, cmd.sec | 0);
        this.bag = 'lee_' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        this.frames = [0, 0]; this.startAt = Date.now() + 2500;
        return { ok: true, re: 'start', state: 'starting' };
      }
      case 'stop':
        if (this.state === 'idle') return { ok: true, re: 'stop', state: 'idle' };       // idempotent
        this.state = 'stopping'; this.stopAt = Date.now() + 1500;
        return { ok: true, re: 'stop', state: 'stopping' };
      case 'set_time':
        if (this.state !== 'idle') return { ok: false, re: 'set_time', err: 'busy' };
        this.clockSkew = 0; return { ok: true, re: 'set_time' };
      default: return { ok: false, err: 'bad_cmd' };
    }
  }
  tick() {
    if (this.closed) return;
    const now = Date.now();
    if (this.state === 'starting' && now >= this.startAt) { this.state = 'recording'; this.t0 = now; }
    if (this.state === 'stopping' && now >= this.stopAt) { this.state = 'idle'; }
    if (this.state === 'recording') {
      const el = (now - this.t0) / 1000;
      this.frames = this.frames.map((f) => f + Math.round(40 * this.tickMs / 1000));
      if (this.limit && el >= this.limit) { this.state = 'stopping'; this.stopAt = now + 1500; }
    }
    if (this.stalled) return;
    this.notify(this.status(now));
  }
  status(now) {
    const rec = this.state === 'recording';
    const el = rec ? Math.round((now - this.t0) / 1000) : 0;
    return {
      v: 1, seq: this.seq++, t: Math.round(now / 1000) + this.clockSkew, state: this.state,
      bag: this.state === 'idle' ? '' : this.bag, el, run: this.limit,
      cam: rec ? this.frames.map((f, i) => ({ fr: f, hz: 39.9 + 0.1 * i, lost: 0, drop: 0, ring: 3 + i })) : [],
      imu: rec ? { hz: 2000, gap: 0 } : null,
      pico: 'ok', gnss: { fix: 3, sats: 11 },
      disk: { free_gb: 412.3 - el * 0.0112, mbs: rec ? 86.4 : 0 },
      temp: { cpu: rec ? 58 : 41, nvme: rec ? 52 : 38 },
      warn: this.warn.slice(), err: '',
    };
  }
  notify(obj) { for (const c of chunk(encodeJson(obj), this.chunkSize)) this.cb.status.forEach((f) => f(c)); }
  event(obj) { for (const c of chunk(encodeJson(obj), this.chunkSize)) this.cb.event.forEach((f) => f(c)); }

  // ---- fault injection (demo panel / tests) ----
  injectWarning(w = 'camera1 lost 3 frames') { this.warn = [w]; }
  clearWarnings() { this.warn = []; }
  stallStatus(on = true) { this.stalled = on; }
  dropLink() { this.close(); }
}
