// Wire contract between the phone page and the Jetson BLE gateway.
// Human-readable spec: Utils/ble_console/PROTOCOL.md. Keep the two in step.
// Pure ES module: runs in the browser and in Node (tests) unchanged.

export const PROTOCOL_VERSION = 1;

// 128-bit UUIDs; the middle bytes spell "lee" (6c 65 65) so they are easy to spot in a scanner.
const U = (n) => `a3f1000${n}-6c65-4e65-8a7e-4c4545000001`;
export const UUID = {
  service: U(0), // advertised
  status: U(1),  // notify (+read): framed JSON, ~1 Hz, server -> phone
  command: U(2), // write with response: framed JSON {body, mac}, phone -> server
  event: U(3),   // notify: framed JSON replies and one-off events, server -> phone
  auth: U(4),    // read: 16 fresh random bytes, valid for ONE command
};

export const NAME_PREFIX = 'LEE-'; // advertised local name, e.g. LEE-jetson-jp7

// ---- chunk framing -------------------------------------------------------------------------
// A BLE notification carries at most (ATT_MTU - 3) bytes, 20 on a stack that never negotiated.
// Every message is therefore cut into chunks; byte 0 of each chunk is a flag byte.
export const F_FIRST = 0x01;
export const F_LAST = 0x02;
export const MAX_MESSAGE = 4096;

// Node 18 has no global `crypto` in ES modules; browsers always do.
export const webcrypto = globalThis.crypto ?? (await import('node:crypto')).webcrypto;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function chunk(bytes, size = 20) {
  if (size < 2) throw new Error('chunk size must be >= 2');
  if (bytes.length > MAX_MESSAGE) throw new Error('message too long');
  const body = size - 1, out = [];
  for (let off = 0; off === 0 || off < bytes.length; off += body) {
    const part = bytes.subarray(off, Math.min(off + body, bytes.length));
    let flags = 0;
    if (off === 0) flags |= F_FIRST;
    if (off + body >= bytes.length) flags |= F_LAST;
    const c = new Uint8Array(1 + part.length);
    c[0] = flags; c.set(part, 1);
    out.push(c);
  }
  return out;
}

export class Reassembler {
  constructor() { this.buf = null; this.errors = 0; }
  // Returns the complete message (Uint8Array) when `c` finishes one, else null.
  push(c) {
    if (!c || c.length < 1) { this.errors++; return null; }
    const flags = c[0], part = c.subarray(1);
    if (flags & F_FIRST) { this.buf = []; this.len = 0; }          // a new message always wins
    else if (!this.buf) { this.errors++; return null; }              // continuation without a start
    this.len += part.length;
    if (this.len > MAX_MESSAGE) { this.buf = null; this.errors++; return null; }
    this.buf.push(part);
    if (!(flags & F_LAST)) return null;
    const msg = new Uint8Array(this.len);
    let o = 0; for (const p of this.buf) { msg.set(p, o); o += p.length; }
    this.buf = null;
    return msg;
  }
}

export const encodeJson = (obj) => enc.encode(JSON.stringify(obj));
export function decodeJson(bytes) {
  try { return JSON.parse(dec.decode(bytes)); } catch { return null; }
}

// ---- authentication ------------------------------------------------------------------------
// The page is public, so it holds no secret. The user types a passphrase once; it stays in this
// phone's localStorage. Each command is {body: "<json text>", mac: hex(HMAC-SHA256(key, nonce || body))}
// with `nonce` read from the AUTH characteristic immediately before. The server forgets the nonce
// after one use, so a captured command cannot be replayed.
export const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hmac(passphrase, nonce, bodyBytes) {
  const data = new Uint8Array(nonce.length + bodyBytes.length);
  data.set(nonce, 0); data.set(bodyBytes, nonce.length);
  if (!webcrypto.subtle) return hmacSha256(enc.encode(passphrase), data);   // plain-HTTP page (hotspot): no WebCrypto
  const key = await webcrypto.subtle.importKey('raw', enc.encode(passphrase),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await webcrypto.subtle.sign('HMAC', key, data));
}

// SHA-256 / HMAC in plain JS for the page the Jetson serves over http://10.42.0.1 in hotspot mode: browsers
// give crypto.subtle only to secure origins. Commands stay signed exactly as over Bluetooth. (Sealing secrets
// needs AES-GCM and is not offered there: new Wi-Fi passwords go over Bluetooth.)
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256(msg) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length, total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total); buf.set(msg); buf[len] = 0x80;
  const dv = new DataView(buf.buffer); dv.setUint32(total - 4, len * 8); dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  const w = new Uint32Array(64); const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32); const ov = new DataView(out.buffer); h.forEach((x, i) => ov.setUint32(4 * i, x)); return out;
}
export function hmacSha256(key, data) {
  if (key.length > 64) key = sha256(key);
  const k = new Uint8Array(64); k.set(key);
  const ipad = k.map((b) => b ^ 0x36), opad = k.map((b) => b ^ 0x5c);
  const inner = new Uint8Array(64 + data.length); inner.set(ipad); inner.set(data, 64);
  const outer = new Uint8Array(96); outer.set(opad); outer.set(sha256(inner), 64);
  return sha256(outer);
}

export async function signCommand(passphrase, nonce, cmd) {
  const body = JSON.stringify(cmd);
  const mac = toHex(await hmac(passphrase, nonce, enc.encode(body)));
  return encodeJson({ body, mac });
}

// Secrets over the unencrypted link (a Wi-Fi password to the Jetson, the hotspot password back): AES-256-GCM
// under K = HMAC-SHA256(passphrase, "lee-secret" + the command's single-use nonce); {iv, ct} in base64.
// Mirrors seal/unseal in the gateway.
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function secretKey(passphrase, nonce) {
  if (!webcrypto.subtle) throw new Error('needs Bluetooth (a secure page): not over the hotspot page');
  const k = await hmac(passphrase, enc.encode('lee-secret'), nonce);
  return webcrypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealSecret(passphrase, nonce, text) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(passphrase, nonce), enc.encode(text)));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function openSecret(passphrase, nonce, sealed) {
  const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, await secretKey(passphrase, nonce), unb64(sealed.ct));
  return new TextDecoder().decode(pt);
}

// Constant-time-ish compare (the gateway does the real check; the simulator reuses this).
export function macEquals(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyCommand(passphrase, nonce, signedBytes) {
  const m = decodeJson(signedBytes);
  if (!m || typeof m.body !== 'string' || typeof m.mac !== 'string') return { ok: false, err: 'format' };
  const want = toHex(await hmac(passphrase, nonce, enc.encode(m.body)));
  if (!macEquals(want, m.mac.toLowerCase())) return { ok: false, err: 'auth' };
  try { return { ok: true, cmd: JSON.parse(m.body) }; } catch { return { ok: false, err: 'format' }; }
}

// ---- status helpers --------------------------------------------------------------------------
export const STATES = ['idle', 'starting', 'recording', 'stopping', 'error'];
export const STALE_AFTER_MS = 3500; // status is 1 Hz; 3 missed + slack = "do not trust the screen"
