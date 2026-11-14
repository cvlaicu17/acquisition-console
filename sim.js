// Simulated Jetson gateway, used by the Demo button and by the tests. It speaks the REAL wire
// protocol (chunk framing, single-use nonce, HMAC check) so the page code path is the production one;
// only the radio is missing. It deliberately uses 20-byte chunks to exercise reassembly.
import { webcrypto, Reassembler, chunk, encodeJson, decodeJson, verifyCommand, sealSecret, openSecret } from './protocol.js';

export const SIM_PASSPHRASE = 'demo-passphrase';

export class SimLink {
  constructor({ passphrase = SIM_PASSPHRASE, tickMs = 1000 } = {}) {
    this.pass = passphrase; this.chunkSize = 20; this.tickMs = tickMs;
    this.cb = { status: [], event: [], disconnect: [] };
    this.rx = new Reassembler(); this.nonce = null; this.seq = 0;
    this.state = 'idle'; this.t0 = 0; this.limit = 0; this.bag = ''; this.frames = [0, 0];
    this.stalled = false; this.warn = []; this.clockSkew = 0; this.closed = false;
    // bags as the gateway lists them: [name, MB, state, pct, note]
    this.bags = [['lee_2026-11-14_16-26-48', 22305, 'split', 0, '11 files'], ['lee_2026-11-14_21-11-15', 4548, 'local', 0, ''],
      ['test_single/lee_2026-11-14_21-09-18', 696, 'synced', 100, '']];
    // Wi-Fi like the gateway's: [ssid, signal, security, known, active]; one secured network needs 'letmein1'
    this.wifi = { mode: 'client', ssid: 'SM', signal: 100, ip: '192.168.68.170' };
    this.nets = [['SM', 100, 'WPA2', true, true], ['Andrei Wifi', 80, 'WPA2 WPA3', false, false], ['SM_Guest', 70, '', false, false]];
    this.hotspotPw = 'sim-hotspot-pw'; this.lastSecret = null;
    this.presets = [
      { id: 'stereo40', name: 'Stereo 40 Hz, auto exposure', maxSec: 3600 },
      { id: 'stereo40f8', name: 'Stereo 40 Hz, fixed 8 ms', maxSec: 3600 },
    ];
    this.timer = setInterval(() => this.tick(), tickMs);
    setTimeout(() => this.event({ ev: 'hello', v: 1, host: 'sim-jetson', fw: 'sim', net: [['wlP1p1s0', '192.168.68.159', 1], ['tailscale0', '100.93.241.45', 1], ['l4tbr0', '192.168.55.1', 0]], presets: this.presets }), 50);
    setTimeout(() => this.tick(), 20);
    setTimeout(() => this.pushBags(), 120);
  }
  async simConnect(cmd, nonce) {
    const n = this.nets.find((x) => x[0] === cmd.ssid);
    if (!n) return { ok: false, re: 'wifi_connect', err: 'failed' };
    let pw = '';
    if (cmd.sec) { try { pw = await openSecret(this.pass, nonce, cmd.sec); } catch { return { ok: false, re: 'wifi_connect', err: 'bad_secret' }; } }
    this.lastSecret = pw;                                   // tests: what the Jetson side received
    if (n[2] && !n[3] && pw !== 'letmein1') return { ok: false, re: 'wifi_connect', err: 'failed' };   // stays on the old network
    n[3] = true; this.wifi = { mode: 'client', ssid: n[0], signal: n[1], ip: '192.168.68.171' };
    return { ok: true, re: 'wifi_connect' };
  }
  bagsMsg() { return { bags: this.bags.map((b) => b.slice()), more: 0, free_gb: 285.2 }; }
  pushBags() { if (!this.closed) this.event({ ev: 'bags', ...this.bagsMsg() }); }
  syncBag(b) {   // phases like the gateway: compress -> upload (pct) -> verify -> synced
    b[2] = 'syncing'; b[3] = 0; b[4] = 'compress'; this.pushBags();
    const step = () => {
      if (this.closed) return;
      if (this.state !== 'idle') { b[2] = 'local'; b[3] = 0; b[4] = 'cancelled: recording started'; return this.pushBags(); }
      if (b[4] === 'compress') { b[4] = 'upload'; }
      else if (b[4] === 'upload' && b[3] < 100) { b[3] = Math.min(100, b[3] + 25); }
      else if (b[4] === 'upload') { b[4] = 'verify'; }
      else { b[2] = 'synced'; b[3] = 100; b[4] = ''; return this.pushBags(); }
      this.pushBags(); setTimeout(step, 300);
    };
    setTimeout(step, 300);
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
    reply(await this.exec(v.cmd, nonce));
  }
  onStatusChunk(f) { this.cb.status.push(f); }
  onEventChunk(f) { this.cb.event.push(f); }
  onDisconnect(f) { this.cb.disconnect.push(f); }
  close() { this.closed = true; clearInterval(this.timer); this.cb.disconnect.forEach((f) => f()); }

  // ---- simulated recorder ----
  exec(cmd, nonce) {
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
      case 'bags': return { ok: true, re: 'bags', ...this.bagsMsg() };
      case 'wifi_scan':
        this.nets.forEach((n) => { n[4] = this.wifi.mode === 'client' && n[0] === this.wifi.ssid; });
        return { ok: true, re: 'wifi_scan', nets: this.nets.map((n) => n.slice()) };
      case 'wifi_connect': return this.simConnect(cmd, nonce);
      case 'wifi_disconnect': this.wifi = { mode: 'off', ssid: '', signal: 0, ip: '' }; return { ok: true, re: 'wifi_disconnect' };
      case 'wifi_forget': {
        const n = this.nets.find((x) => x[0] === cmd.ssid && x[3]);
        if (!n) return { ok: false, re: 'wifi_forget', err: 'bad_arg' };
        n[3] = false; return { ok: true, re: 'wifi_forget' };
      }
      case 'hotspot':
        if (cmd.on) { this.prevWifi = this.prevWifi || { ...this.wifi }; this.wifi = { mode: 'hotspot', ssid: 'LEE-SIM', signal: 0, ip: '10.42.0.1' };
          return sealSecret(this.pass, nonce, this.hotspotPw).then((sec) => ({ ok: true, re: 'hotspot', ssid: 'LEE-SIM', ip: '10.42.0.1', sec })); }
        this.wifi = this.prevWifi || { mode: 'off', ssid: '', signal: 0, ip: '' }; this.prevWifi = null;
        return { ok: true, re: 'hotspot' };
      case 'hotspot_password':
        return sealSecret(this.pass, nonce, this.hotspotPw).then((sec) => ({ ok: true, re: 'hotspot_password', ssid: 'LEE-SIM', sec }));
      case 'sync': {
        const b = this.bags.find((x) => x[0] === cmd.bag);
        if (!b) return { ok: false, re: 'sync', err: 'bad_arg' };
        if (this.state !== 'idle' || this.bags.some((x) => x[2] === 'syncing')) return { ok: false, re: 'sync', err: 'busy' };
        if (b[2] !== 'local') return { ok: false, re: 'sync', err: ['split', 'unfinished'].includes(b[2]) ? 'not_syncable' : 'synced' };
        this.syncBag(b); return { ok: true, re: 'sync' };
      }
      case 'delete': {
        const i = this.bags.findIndex((x) => x[0] === cmd.bag);
        if (i < 0) return { ok: false, re: 'delete', err: 'bad_arg' };
        if (this.state !== 'idle') return { ok: false, re: 'delete', err: 'busy' };
        if (this.bags[i][2] !== 'synced') return { ok: false, re: 'delete', err: 'not_synced' };
        this.bags.splice(i, 1); setTimeout(() => this.pushBags(), 10); return { ok: true, re: 'delete', bag: cmd.bag };
      }
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
      net: [['wlP1p1s0', '192.168.68.159', 1], ['tailscale0', '100.93.241.45', 1], ['l4tbr0', '192.168.55.1', 0]],
      wifi: { ...this.wifi },
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
