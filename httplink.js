// The transport of the page the Jetson serves over its hotspot (http://10.42.0.1/): the same signed protocol
// as over Bluetooth, carried by HTTP - GET /api/nonce, POST /api/cmd, and server-sent events for status and
// events. Same interface as WebBleLink, so Client and the page do not care which one they have.
import { chunk } from './protocol.js';

const enc = new TextEncoder();
const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));

export class HttpLink {
  constructor(base = '') {
    this.base = base; this.chunkSize = 4000; this.nonceHex = null; this.ended = false;
    this.cb = { status: [], event: [], disconnect: [] };
    this.es = new EventSource(base + '/api/events');
    this.es.addEventListener('status', (e) => this.deliver(this.cb.status, e.data));
    this.es.addEventListener('event', (e) => this.deliver(this.cb.event, e.data));
    this.es.onerror = () => { if (this.es.readyState === EventSource.CLOSED) this.end(); };   // else it reconnects by itself
  }
  deliver(list, text) { for (const c of chunk(enc.encode(text), this.chunkSize)) list.forEach((f) => f(c)); }
  async readNonce() {
    const r = await fetch(this.base + '/api/nonce', { cache: 'no-store' });
    this.nonceHex = (await r.text()).trim(); return fromHex(this.nonceHex);
  }
  async writeCommand(bytes) {
    const nonce = this.nonceHex; this.nonceHex = null;
    const r = await fetch(this.base + '/api/cmd', { method: 'POST', body: bytes, cache: 'no-store',
      headers: { 'X-Nonce': nonce || '', 'Content-Type': 'application/octet-stream' } });
    this.deliver(this.cb.event, await r.text());            // the reply, like a reply event over Bluetooth
  }
  onStatusChunk(f) { this.cb.status.push(f); }
  onEventChunk(f) { this.cb.event.push(f); }
  onDisconnect(f) { this.cb.disconnect.push(f); }
  end() { if (this.ended) return; this.ended = true; this.es.close(); this.cb.disconnect.forEach((f) => f()); }
  close() { this.end(); }
  get name() { return 'Jetson (hotspot)'; }
}
