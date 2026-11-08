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
  const key = await webcrypto.subtle.importKey('raw', enc.encode(passphrase),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = new Uint8Array(nonce.length + bodyBytes.length);
  data.set(nonce, 0); data.set(bodyBytes, nonce.length);
  return new Uint8Array(await webcrypto.subtle.sign('HMAC', key, data));
}

export async function signCommand(passphrase, nonce, cmd) {
  const body = JSON.stringify(cmd);
  const mac = toHex(await hmac(passphrase, nonce, enc.encode(body)));
  return encodeJson({ body, mac });
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
