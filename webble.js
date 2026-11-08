// Real transport: Web Bluetooth (Chrome/Edge on Android, desktop Chrome). Not available on iOS Safari.
import { UUID, NAME_PREFIX, chunk } from './protocol.js';

export const webBluetoothSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export async function connectBle() {
  // requestDevice must be called from a user gesture (a tap). The filter keeps the chooser short.
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [UUID.service] }, { namePrefix: NAME_PREFIX }],
    optionalServices: [UUID.service],
  });
  const link = new WebBleLink(device);
  await link.open();
  return link;
}

class WebBleLink {
  constructor(device) {
    this.device = device; this.chunkSize = 100; // phone -> server writes; long writes are handled by the stack
    this.cb = { status: [], event: [], disconnect: [] };
    this.userClosed = false;
    device.addEventListener('gattserverdisconnected', () => {
      if (this.userClosed) return;
      this.reconnect().catch(() => this.cb.disconnect.forEach((f) => f()));
    });
  }
  async open() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.service);
    this.chStatus = await svc.getCharacteristic(UUID.status);
    this.chCmd = await svc.getCharacteristic(UUID.command);
    this.chEvent = await svc.getCharacteristic(UUID.event);
    this.chAuth = await svc.getCharacteristic(UUID.auth);
    const rx = (list) => (ev) => { const v = new Uint8Array(ev.target.value.buffer.slice(
      ev.target.value.byteOffset, ev.target.value.byteOffset + ev.target.value.byteLength)); list.forEach((f) => f(v)); };
    this.chStatus.addEventListener('characteristicvaluechanged', rx(this.cb.status));
    this.chEvent.addEventListener('characteristicvaluechanged', rx(this.cb.event));
    await this.chStatus.startNotifications();
    await this.chEvent.startNotifications();
  }
  // Brief radio dropouts are normal at the edge of range: retry quietly before telling the UI.
  async reconnect() {
    let wait = 500;
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, wait)); wait *= 2;
      if (this.userClosed) return;
      try { await this.open(); return; } catch { /* try again */ }
    }
    throw new Error('reconnect failed');
  }
  async readNonce() { const v = await this.chAuth.readValue(); return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)); }
  async writeCommand(bytes) {
    for (const c of chunk(bytes, this.chunkSize)) await this.chCmd.writeValueWithResponse(c);
  }
  onStatusChunk(f) { this.cb.status.push(f); }
  onEventChunk(f) { this.cb.event.push(f); }
  onDisconnect(f) { this.cb.disconnect.push(f); }
  close() { this.userClosed = true; if (this.device.gatt.connected) this.device.gatt.disconnect(); }
  get name() { return this.device.name || 'LEE'; }
}
