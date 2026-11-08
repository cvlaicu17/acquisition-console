import { STALE_AFTER_MS } from './protocol.js';
import { Client } from './client.js';
import { connectBle, webBluetoothSupported } from './webble.js';
import { SimLink, SIM_PASSPHRASE } from './sim.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const KEY_STORE = 'lee.passphrase';
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: page still works */ } },
};

let keyOverride = null; // tests only
let client = null, sim = null, status = null, lastStatusAt = 0, demo = false, busy = false, wakeLock = null;

// ---- small helpers ----------------------------------------------------------------------------
function log(s) {
  const el = $('log'), t = new Date().toLocaleTimeString();
  el.textContent = `${t}  ${s}\n` + el.textContent.split('\n').slice(0, 59).join('\n');
}
const setMsg = (s, bad) => { $('msg').textContent = s || ' '; $('msg').className = 'small ' + (bad ? 'bad' : 'dim'); };
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const cls = (v, warnAt, badAt) => (v >= badAt ? 'er' : v >= warnAt ? 'wr' : 'ok');
function rows(tableId, list) {
  const tb = $(tableId).tBodies[0]; tb.textContent = '';
  for (const [k, v, c] of list) {
    const tr = tb.insertRow(); tr.insertCell().textContent = k;
    const td = tr.insertCell(); td.textContent = v; if (c) td.className = c;
  }
}
const isStale = () => !client || Date.now() - lastStatusAt > STALE_AFTER_MS;

// ---- rendering ----------------------------------------------------------------------------------
function render() {
  const s = status, stale = isStale();
  $('stale').hidden = !client || !stale;
  const st = $('state');
  st.textContent = client && s ? s.state : '—';
  st.className = 'state s-' + (client && s ? s.state : 'none');
  $('elapsed').textContent = s && client && s.state === 'recording' ? mmss(s.el) + (s.run ? ' / ' + mmss(s.run) : '') : '--:--';
  $('bag').textContent = (s && s.bag) || ' ';
  $('errline').hidden = !(s && s.err); $('errline').textContent = s && s.err || '';
  const w = $('warns'); w.textContent = '';
  for (const t of (s && s.warn) || []) { const d = document.createElement('div'); d.className = 'warnitem'; d.textContent = t; w.append(d); }

  const connected = !!client;
  $('btnConnect').hidden = connected; $('btnDisconnect').hidden = !connected; $('btnDemo').hidden = connected;
  $('btnStart').disabled = !(connected && !stale && s && s.state === 'idle' && !busy);
  $('btnStop').disabled = !(connected && s && ['starting', 'recording', 'error'].includes(s.state));

  const sens = [];
  if (s && client) {
    (s.cam || []).forEach((c, i) => sens.push([`camera${i}`, `${c.fr} fr  ${Number(c.hz).toFixed(1)} Hz  lost ${c.lost}  drop ${c.drop}`, c.lost || c.drop ? 'er' : 'ok']));
    if (s.imu) sens.push(['IMU', `${s.imu.hz} Hz  gaps ${s.imu.gap}`, s.imu.gap ? 'er' : 'ok']);
    if (s.pico) sens.push(['Pico link', s.pico, s.pico === 'ok' ? 'ok' : 'er']);
    if (s.gnss) sens.push(['GNSS', s.gnss.fix >= 2 ? `fix ${s.gnss.fix}, ${s.gnss.sats} sats` : 'no fix', s.gnss.fix >= 2 ? 'ok' : 'wr']);
  }
  rows('sens', sens.length ? sens : [['—', s && client && s.state === 'idle' ? 'recorder idle' : 'no data']]);

  const h = [];
  if (s && client) {
    if (s.disk) h.push(['Disk free', `${Number(s.disk.free_gb).toFixed(1)} GB`, s.disk.free_gb < 20 ? 'er' : s.disk.free_gb < 60 ? 'wr' : 'ok'],
      ['Write rate', `${Number(s.disk.mbs).toFixed(1)} MB/s`]);
    if (s.temp) h.push(['CPU temp', `${s.temp.cpu} °C`, cls(s.temp.cpu, 75, 90)], ['NVMe temp', `${s.temp.nvme} °C`, cls(s.temp.nvme, 70, 80)]);
    const skew = s.t - Date.now() / 1000;
    h.push(['Clock vs phone', `${skew >= 0 ? '+' : ''}${skew.toFixed(0)} s`, Math.abs(skew) > 5 ? 'wr' : 'ok']);
    $('btnTime').hidden = !(Math.abs(skew) > 5 && s.state === 'idle');
  } else $('btnTime').hidden = true;
  rows('host2', h.length ? h : [['—', 'no data']]);
}

let nStatus = 0;
function onStatus(s) { if (nStatus++ === 0) log('first status received (state ' + s.state + ')'); status = s; lastStatusAt = Date.now(); render(); }

function fillPresets(list) {
  const sel = $('preset'), keep = sel.value; sel.textContent = '';
  for (const p of list) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.append(o); }
  if (keep) sel.value = keep;
}

// ---- connection ---------------------------------------------------------------------------------
async function attach(link, name) {
  client = new Client(link, () => keyOverride ?? (demo ? SIM_PASSPHRASE : $('key').value.trim()));   // trim: phone keyboards append a space; Demo never touches the real passphrase box
  client.on('status', onStatus);
  client.on('event', (e) => {
    if (e.ev === 'hello') { fillPresets(e.presets || []); $('host').textContent = `${e.name || ''}  (${e.host || ''})  fw ${e.fw || '?'}`; $('conn').textContent = demo ? 'demo' : (e.name || 'connected'); log('hello from ' + (e.host || '?')); }
    else if (e.ev) log('event ' + JSON.stringify(e));
  });
  client.on('disconnect', () => { log('link lost'); detach(); });
  $('conn').textContent = demo ? 'demo' : 'connected'; $('conn').className = 'pill ' + (demo ? 'demo' : 'on');
  log('connected to ' + name);
  requestWake();
  render();
}
function detach() {
  client = null; status = null; demo = false; sim = null;
  $('conn').textContent = 'disconnected'; $('conn').className = 'pill off';
  $('demoCard').hidden = true; $('unsupported').hidden = webBluetoothSupported(); releaseWake(); render();
}
async function requestWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ } }
function releaseWake() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && client) requestWake(); });

$('btnConnect').onclick = async () => {
  store.set(KEY_STORE, $('key').value.trim());
  try { const link = await connectBle(); await attach(link, link.name); }
  catch (e) { if (e.name !== 'NotFoundError') log('connect failed: ' + e.message); setMsg(e.message, true); }
};
$('btnDisconnect').onclick = () => { client?.close(); };
$('btnDemo').onclick = () => startDemo();
function startDemo() {
  demo = true; sim = new SimLink({ tickMs: Number(q.get('tick')) || 1000 });
  $('demoCard').hidden = false; $('unsupported').hidden = true; return attach(sim, 'simulator');
}
$('dWarn').onclick = () => sim?.injectWarning();
$('dStall').onclick = () => { if (sim) { sim.stallStatus(!sim.stalled); log('status ' + (sim.stalled ? 'stalled' : 'resumed')); } };
$('dDrop').onclick = () => sim?.dropLink();

// ---- commands -----------------------------------------------------------------------------------
async function send(cmd) {
  busy = true; render(); setMsg('sending ' + cmd.c + '…');
  try {
    const r = await client.command(cmd);
    if (r.ok) { setMsg(`${cmd.c}: accepted`); log(`${cmd.c} ok`); }
    else { setMsg(`${cmd.c} refused: ${r.err}` + (r.err === 'auth' ? ' (wrong passphrase: retype it above and reconnect)' : ''), true); log(`${cmd.c} refused: ${r.err}`); }
    return r;
  } catch (e) { setMsg(`${cmd.c} failed: ${e.message}`, true); log(`${cmd.c} failed: ${e.message}`); }
  finally { busy = false; render(); }
}
$('btnStart').onclick = () => send({ c: 'start', preset: $('preset').value, sec: Number($('dur').value) });
$('btnTime').onclick = () => send({ c: 'set_time', unix: Math.round(Date.now() / 1000) });

// Stop is hold-to-confirm: a tap in a pocket or with a glove must not end a flight's recording.
const HOLD_MS = 800;
{
  const b = $('btnStop'), fill = b.querySelector('.fill'); let t0 = 0, raf = 0;
  const reset = () => { cancelAnimationFrame(raf); t0 = 0; fill.style.width = '0'; };
  const step = () => {
    if (!t0) return;
    const f = (performance.now() - t0) / HOLD_MS; fill.style.width = Math.min(100, f * 100) + '%';
    if (f >= 1) { reset(); send({ c: 'stop' }); } else raf = requestAnimationFrame(step);
  };
  b.addEventListener('pointerdown', (e) => { if (b.disabled) return; b.setPointerCapture(e.pointerId); t0 = performance.now(); raf = requestAnimationFrame(step); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, reset);
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !b.disabled) send({ c: 'stop' }); });
}

// ---- boot ---------------------------------------------------------------------------------------
$('key').value = store.get(KEY_STORE);
$('key').addEventListener('change', () => { $('key').value = $('key').value.trim(); store.set(KEY_STORE, $('key').value); });
$('unsupported').hidden = webBluetoothSupported();
$('btnConnect').disabled = !webBluetoothSupported();
setInterval(render, 500); // keeps the stale banner honest when no status arrives to trigger a render
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();

// Scripted end-to-end run against the simulator, for headless checks: ?demo&selftest
if (q.has('demo')) startDemo().then(() => { if (q.has('selftest')) selftest(); });
async function selftest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = (ok, what) => { log((ok ? 'PASS ' : 'FAIL ') + what); document.title = (document.title.startsWith('FAIL') || !ok ? 'FAIL' : 'PASS') + ' selftest'; };
  await wait(1500);
  out(status?.state === 'idle', 'status arrives, idle');
  out($('preset').options.length === 2, 'presets from hello');
  const r1 = await send({ c: 'start', preset: 'stereo40', sec: 0 });
  out(r1?.ok === true, 'start accepted');
  await wait(4500);
  out(status?.state === 'recording' && status.cam.length === 2, 'recording with 2 cameras');
  const r2 = await send({ c: 'start', preset: 'stereo40', sec: 0 });
  out(r2?.ok === false && r2.err === 'busy', 'second start refused (busy)');
  keyOverride = 'wrong';
  const r3 = await send({ c: 'stop' }); keyOverride = null;
  out(r3?.ok === false && r3.err === 'auth', 'wrong passphrase refused');
  const r4 = await send({ c: 'stop' });
  out(r4?.ok === true, 'stop accepted');
  await wait(3000);
  out(status?.state === 'idle', 'back to idle');
  sim.stallStatus(true); await wait(4500);
  out(!$('stale').hidden, 'stale banner after status stalls');
  log('SELFTEST DONE');
}
