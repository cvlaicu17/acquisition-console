import { STALE_AFTER_MS } from './protocol.js';
import { Client } from './client.js';
import { connectBle, webBluetoothSupported } from './webble.js';
import { SimLink, SIM_PASSPHRASE } from './sim.js';
import { HttpLink } from './httplink.js';

// Served by the Jetson itself over its hotspot (http://10.42.0.1/): no Bluetooth there; the same protocol over HTTP.
const HTTP_MODE = document.querySelector('meta[name="lee-transport"]')?.content === 'http';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const KEY_STORE = 'lee.passphrase';
const BUILD = 'babdbdc';   // publish_pages.sh writes the source commit here
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: page still works */ } },
};

let keyOverride = null; // tests only
let bags = null;         // last `bags` event / reply from the gateway: {bags: [[name, mb, state, pct, note]], more, free_gb}
let nets = null;         // last wifi_scan result: [[ssid, signal, security, known, active]]
let hotspotPw = '';      // shown while the Jetson runs its hotspot (arrives sealed)
let joining = '';        // ssid whose password box is open
let bagsRetry = 0;       // asks for the bag list while none arrived
let client = null, sim = null, status = null, lastStatusAt = 0, demo = false, busy = false, wakeLock = null;

// ---- small helpers ----------------------------------------------------------------------------
// ---- live view ---------------------------------------------------------------------------------------
// Over the hotspot page: start/stop the preview (lee-live: cameras without a bag) and show each camera's MJPEG
// stream from :8091. Over Bluetooth: how to get there. Streams are dropped while the page is hidden.
function renderLive() {
  const lv = status && client ? status.live : null, wf = status && client ? status.wifi : null;
  const on = !!lv && ['active', 'activating'].includes(lv.state), streaming = on && lv.stream === 'active';
  const rec = status && status.state !== 'idle';
  $('liveCtl').hidden = !client || demo;
  $('btnLive').textContent = on ? 'Stop preview' : 'Start preview';
  $('btnLive').disabled = busy || (!on && rec);
  $('liveState').textContent = !lv ? '' : on ? (streaming ? 'cameras streaming' : 'starting the cameras…') : (rec ? 'not while recording' : 'off');
  const hint = $('liveHint');
  if (HTTP_MODE) hint.textContent = 'Preview runs the cameras without recording. Stop it before you record.';
  else if (wf && wf.mode === 'hotspot') {
    hint.textContent = ''; hint.append('Join the Wi-Fi ' + wf.ssid + ', then open ');
    const a = document.createElement('a'); a.href = `http://${wf.ip || '10.42.0.1'}/`; a.textContent = a.href; hint.append(a, ' for the camera images.');
  } else hint.textContent = 'Camera images come over the Jetson\'s hotspot: switch it on below, join it, open the address shown here.';
  const show = HTTP_MODE && streaming && document.visibilityState === 'visible';
  $('cams').hidden = !(HTTP_MODE && on);
  ['cam0', 'cam1'].forEach((c) => {
    const img = document.querySelector(`#${c} img`), want = show ? `http://${location.hostname}:${lv.port}/${c}.mjpg` : '';
    if (want && img.dataset.src !== want) { img.dataset.src = want; img.src = want; }
    if (!want && img.dataset.src) { img.dataset.src = ''; img.removeAttribute('src'); }   // closes the stream
  });
}
$('btnLive').onclick = () => send({ c: 'live', on: !['active', 'activating'].includes(status?.live?.state) }, 20000);
for (const cam of document.querySelectorAll('.cam')) {
  const toggle = () => { cam.classList.toggle('max'); document.body.classList.toggle('noscroll', !!document.querySelector('.cam.max')); };
  cam.querySelector('button.max').onclick = (e) => { e.stopPropagation(); toggle(); };
  cam.querySelector('img').onclick = toggle;
}
document.addEventListener('visibilitychange', () => renderLive());

// ---- Jetson Wi-Fi -----------------------------------------------------------------------------------
let lastWifi = '', lastLive = '';
function renderWifi() {
  const wf = status && client ? status.wifi : null;
  const now = $('wifiNow'), hi = $('hotspotInfo');
  now.className = 'small';
  if (!client) now.textContent = 'connect to see the Wi-Fi';
  else if (!wf) now.textContent = '…';
  else if (wf.mode === 'client') now.textContent = `connected to ${wf.ssid} (${wf.signal}%)${wf.ip ? ' · ' + wf.ip : ''}`;
  else if (wf.mode === 'hotspot') now.textContent = `hotspot ${wf.ssid} · ${wf.ip || '10.42.0.1'}`;
  else if (wf.mode === 'off') now.textContent = 'Wi-Fi not connected';
  else now.textContent = 'no Wi-Fi device';
  const hs = wf && wf.mode === 'hotspot';
  hi.hidden = !hs;
  if (hs) {
    hi.textContent = '';
    hi.append('Join Wi-Fi ');
    const n = document.createElement('b'); n.textContent = wf.ssid; hi.append(n, ', password ');
    if (hotspotPw) { const p = document.createElement('b'); p.textContent = hotspotPw; hi.append(p); }
    else if (HTTP_MODE) hi.append('(you are on it)');
    else { const b = document.createElement('button'); b.className = 'ghost small'; b.textContent = 'show';
      b.onclick = async () => { const r = await send({ c: 'hotspot_password' }); if (r?.ok && r.secret) { hotspotPw = r.secret; renderWifi(); } }; hi.append(b); }
    hi.append(document.createElement('br'), `Then the Jetson is at ${wf.ip || '10.42.0.1'}.`);
  }
  $('btnHotspot').textContent = hs ? 'Hotspot off' : 'Hotspot on';
  $('btnHotspot').disabled = $('btnScan').disabled = !client || busy;
  $('btnWifiOff').hidden = !(wf && wf.mode === 'client'); $('btnWifiOff').disabled = busy;
  renderNets();
}
function renderNets() {
  const box = $('nets'); box.textContent = '';
  if (!client || !nets) return;
  if (!nets.length) { box.className = 'dim small'; box.textContent = 'no networks found'; return; }
  box.className = '';
  for (const [ssid, sig, sec, known, active] of nets) {
    const row = document.createElement('div'); row.className = 'bagrow';
    const info = document.createElement('div'); info.className = 'bi';
    const n = document.createElement('div'); n.className = 'bn'; n.textContent = ssid;
    const s = document.createElement('div'); s.className = 'bs';
    s.textContent = `${sig}% · ${sec || 'open'}${known ? ' · saved' : ''}${active ? ' · connected' : ''}`;
    info.append(n, s);
    if (joining === ssid) {
      const f = document.createElement('div'); f.className = 'netpw';
      const pw = document.createElement('input'); pw.type = 'password'; pw.placeholder = 'Wi-Fi password'; pw.autocomplete = 'off';
      const go = document.createElement('button'); go.className = 'primary small'; go.textContent = 'Join';
      go.onclick = () => wifiConnect(ssid, sec, pw.value);
      f.append(pw, go); info.append(f); setTimeout(() => pw.focus(), 0);
    }
    row.append(info);
    if (!active) {
      const bc = document.createElement('button'); bc.className = 'ghost'; bc.textContent = 'Connect';
      bc.disabled = busy || (HTTP_MODE && !known && !!sec);   // a new password must be sealed: Bluetooth page only
      if (HTTP_MODE && !known && sec) bc.title = 'new networks with a password: use the Bluetooth page';
      bc.onclick = () => { if (known || !sec) wifiConnect(ssid, sec, ''); else { joining = joining === ssid ? '' : ssid; renderNets(); } };
      row.append(bc);
    }
    if (known) {
      const bf = document.createElement('button'); bf.className = 'ghost'; bf.textContent = 'Forget'; bf.disabled = busy;
      bf.onclick = () => { if (confirm(`Forget ${ssid} on the Jetson?`)) send({ c: 'wifi_forget', ssid }, 20000).then(scanNets); };
      row.append(bf);
    }
    box.append(row);
  }
}
async function scanNets() {
  const r = await send({ c: 'wifi_scan' }, 40000);
  if (r?.ok) { nets = r.nets; renderNets(); }
}
async function wifiConnect(ssid, security, password) {
  joining = ''; renderNets();
  setMsg(`connecting the Jetson to ${ssid}… (up to a minute; it goes back to the previous network if this fails)`);
  const r = await send({ c: 'wifi_connect', ssid, security }, 90000, password ? { secret: password } : {});
  if (r?.ok) scanNets();
}
$('btnScan').onclick = scanNets;
renderLive();
$('btnHotspot').onclick = async () => {
  const on = !(status?.wifi?.mode === 'hotspot');
  if (on && !confirm('Switch the Jetson to hotspot mode?\n\nIt leaves its current Wi-Fi: no internet and no Tailscale until the hotspot is off.')) return;
  const r = await send({ c: 'hotspot', on }, 90000);
  if (r?.ok && on) { hotspotPw = r.secret || ''; renderWifi(); }
  if (r?.ok && !on) hotspotPw = '';
};
$('btnWifiOff').onclick = () => { if (confirm('Disconnect the Jetson from Wi-Fi?\n\nIt stays off Wi-Fi (no internet, no Tailscale) until you connect it again.')) send({ c: 'wifi_disconnect' }, 20000); };

// ---- bags ----------------------------------------------------------------------------------------
const gb = (mb) => (mb >= 1000 ? (mb / 1000).toFixed(1) + ' GB' : mb + ' MB');
const BAG_STATE = {
  local: ['on the Jetson only', ''], synced: ['in the vault ✓', 'ok'], syncing: ['syncing', 'wr'],
  recording: ['recording', 'wr'], split: ['split recording: cannot sync', 'dim'], unfinished: ['unfinished: cannot sync', 'er'],
};
function renderBags() {
  const box = $('bags'); box.textContent = '';
  $('bagsInfo').textContent = bags ? `${bags.bags.length + (bags.more || 0)} · ${Number(bags.free_gb).toFixed(0)} GB free` : '';
  if (!client || !bags) { box.textContent = client ? 'loading…' : 'connect to see the bags'; return; }
  if (!bags.bags.length) { box.textContent = 'no bags in ~/bags'; return; }
  const liveOn = ['active', 'activating'].includes(status?.live?.state);   // preview runs the cameras: no sync then
  const idle = status && status.state === 'idle' && !liveOn, syncing = bags.bags.some((b) => b[2] === 'syncing');
  for (const [name, mb, st, pct, note] of bags.bags) {
    const row = document.createElement('div'); row.className = 'bagrow';
    const info = document.createElement('div'); info.className = 'bi';
    const n = document.createElement('div'); n.className = 'bn'; n.textContent = name;
    const [label, c] = BAG_STATE[st] || [st, ''];
    const s = document.createElement('div'); s.className = 'bs';
    const what = st === 'syncing' ? `${label} ${note || ''} ${pct ? pct + '%' : ''}`.replace(/\s+/g, ' ').trim() : label;
    s.innerHTML = ''; s.append(gb(mb) + ' · ');
    const sp = document.createElement('span'); sp.className = c; sp.textContent = what; s.append(sp);
    if (note && st !== 'syncing') { const e = document.createElement('span'); e.className = st === 'local' ? 'er' : 'dim'; e.textContent = ' · ' + note; s.append(e); }
    info.append(n, s);
    const bSync = document.createElement('button'); bSync.className = 'ghost'; bSync.textContent = 'Sync';
    bSync.disabled = !(st === 'local' && idle && !syncing && !busy);
    bSync.onclick = () => send({ c: 'sync', bag: name });
    const bDel = document.createElement('button'); bDel.className = 'ghost'; bDel.textContent = 'Delete';
    bDel.disabled = !(st === 'synced' && !busy);
    bDel.onclick = () => { if (confirm(`Delete ${name} (${gb(mb)}) from the Jetson?\n\nThe vault keeps its copy.`)) send({ c: 'delete', bag: name }, 60000); };
    row.append(info, bSync, bDel); box.append(row);
  }
  if (bags.more) { const m = document.createElement('div'); m.className = 'dim small'; m.textContent = `+ ${bags.more} older`; box.append(m); }
}

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
// Jetson addresses: live while connected, the last known set (dimmed, with its age) otherwise.
const NET_STORE = 'lee.lastnet';
function loadLastNet() { try { return JSON.parse(store.get(NET_STORE)) || null; } catch { return null; } }
let lastNet = loadLastNet();   // {host, at, net}
function rememberNet(net, host) {
  if (demo || !Array.isArray(net) || !net.length) return;
  const key = JSON.stringify(net);
  if (lastNet && JSON.stringify(lastNet.net) === key && Date.now() - lastNet.at < 60000) return;
  lastNet = { host, at: Date.now(), net }; store.set(NET_STORE, JSON.stringify(lastNet));
}
function renderNet(live) {
  const box = $('net'); box.textContent = '';
  const src = live ? { net: status && status.net, host: status && status.host } : lastNet;
  const list = (src && src.net) || [];
  $('netAge').textContent = live ? '' : lastNet ? `(last seen ${new Date(lastNet.at).toLocaleString()})` : '';
  if (!list.length) { box.textContent = live ? 'no address reported' : 'not connected yet'; return; }
  for (const [ifn, ip, up] of list) {
    const b = document.createElement('button'); b.className = 'ghost small netrow' + (live && up ? '' : ' off');
    b.textContent = `${ifn}  ${ip}${up ? '' : '  (no link)'}`;
    b.onclick = async () => {
      const cmd = `ssh jetson@${ip}`;
      try { await navigator.clipboard.writeText(cmd); setMsg('copied: ' + cmd); } catch { setMsg(cmd); }
    };
    box.append(b);
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
  $('btnConnect').hidden = connected || HTTP_MODE; $('btnDisconnect').hidden = !connected || HTTP_MODE; $('btnDemo').hidden = connected || HTTP_MODE;
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
  renderNet(!!(s && client && s.net));
}

let nStatus = 0;
function onStatus(s) {
  rememberNet(s.net, $('host').textContent); if (nStatus++ === 0) log('first status received (state ' + s.state + ')');
  const changed = !status || status.state !== s.state;
  status = s; lastStatusAt = Date.now(); render();
  if (changed) renderBags();   // Sync is only offered while idle; rows are rebuilt only when needed (taps survive)
  const w = JSON.stringify(s.wifi || null);
  if (w !== lastWifi) { lastWifi = w; renderWifi(); }
  const l = JSON.stringify([s.live || null, s.state, w]);
  if (l !== lastLive) { lastLive = l; renderLive(); renderBags(); }
}

function fillPresets(list) {
  const sel = $('preset'), keep = sel.value; sel.textContent = '';
  for (const p of list) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; o.dataset.max = p.maxSec || 3600; sel.append(o); }
  if (keep) sel.value = keep;
  limitDurations();
}
// A preset allows up to maxSec (camera presets 1 h, Allan 24 h): longer durations are not offered.
function limitDurations() {
  const max = Number($('preset').selectedOptions[0]?.dataset.max || 3600), d = $('dur');
  for (const o of d.options) o.disabled = Number(o.value) > max;
  if (d.selectedOptions[0]?.disabled) d.value = '0';
}
$('preset').addEventListener('change', limitDurations);

// ---- connection ---------------------------------------------------------------------------------
async function attach(link, name) {
  client = new Client(link, () => keyOverride ?? (demo ? SIM_PASSPHRASE : $('key').value.trim()));   // trim: phone keyboards append a space; Demo never touches the real passphrase box
  client.on('status', onStatus);
  client.on('event', (e) => {
    if (e.ev === 'bags' || (e.re === 'bags' && e.ok)) { bags = e; renderBags(); }
    if (e.ev === 'hello') { fillPresets(e.presets || []); $('host').textContent = `${e.name || ''}  (${e.host || ''})  fw ${e.fw || '?'}`; $('conn').textContent = demo ? 'demo' : (e.name || 'connected'); log('hello from ' + (e.host || '?') + (e.net ? ' ' + e.net.filter((n) => n[2]).map((n) => n[1]).join(' ') : '')); }
    else if (e.ev && e.ev !== 'bags') log('event ' + JSON.stringify(e));   // bags: shown in its card, not the log
  });
  client.on('disconnect', () => { log(userDisconnect ? 'disconnected' : 'link lost'); userDisconnect = false; detach(); });
  $('conn').textContent = demo ? 'demo' : 'connected'; $('conn').className = 'pill ' + (demo ? 'demo' : 'on');
  log('connected to ' + name);
  // The list comes as an event after connecting; if that one notification was lost, ask for it.
  const askBags = () => { if (client && !bags && !busy && $('key').value.trim()) client.command({ c: 'bags' }).then((r) => { if (r?.ok) { bags = r; renderBags(); } }).catch(() => {}); };
  clearInterval(bagsRetry); setTimeout(askBags, 3000); bagsRetry = setInterval(() => { if (!client) clearInterval(bagsRetry); else askBags(); }, 10000);
  requestWake();
  render();
}
function detach() {
  client = null; status = null; demo = false; sim = null; bags = null; nets = null; hotspotPw = ''; joining = ''; renderBags(); renderWifi(); renderLive();
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
let userDisconnect = false;
$('btnDisconnect').onclick = () => { userDisconnect = true; client?.close(); };
$('btnDemo').onclick = () => startDemo();
function startDemo() {
  demo = true; sim = new SimLink({ tickMs: Number(q.get('tick')) || 1000 });
  $('demoCard').hidden = false; $('unsupported').hidden = true; return attach(sim, 'simulator');
}
$('dWarn').onclick = () => sim?.injectWarning();
$('dStall').onclick = () => { if (sim) { sim.stallStatus(!sim.stalled); log('status ' + (sim.stalled ? 'stalled' : 'resumed')); } };
$('dDrop').onclick = () => sim?.dropLink();

// ---- commands -----------------------------------------------------------------------------------
async function send(cmd, timeoutMs, opts) {
  busy = true; render(); renderBags(); renderWifi(); if (!/connecting/.test($('msg').textContent)) setMsg('sending ' + cmd.c + '…');
  try {
    const r = await client.command(cmd, timeoutMs, opts);
    if (r.ok) { setMsg(`${cmd.c}: accepted`); log(`${cmd.c} ok`); }
    else { setMsg(`${cmd.c} refused: ${r.err}` + (r.err === 'auth' ? ' (wrong passphrase: retype it above and reconnect)' : ''), true); log(`${cmd.c} refused: ${r.err}`); }
    return r;
  } catch (e) { setMsg(`${cmd.c} failed: ${e.message}`, true); log(`${cmd.c} failed: ${e.message}`); }
  finally { busy = false; render(); renderBags(); renderWifi(); renderLive(); }
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
// The hotspot page connects by itself; this saves the passphrase on the phone and proves it with a signed ping.
async function useKey() {
  const k = $('key').value.trim(); $('key').value = k; store.set(KEY_STORE, k);
  if (!k) { $('keyState').textContent = 'type the passphrase first'; $('keyState').className = 'small bad'; return; }
  $('keyState').textContent = 'checking…'; $('keyState').className = 'small dim';
  const r = await send({ c: 'ping' });
  const ok = r?.ok === true;
  $('keyState').textContent = ok ? 'passphrase OK, saved on this phone' : r?.err === 'auth' ? 'wrong passphrase' : 'no answer from the Jetson';
  $('keyState').className = 'small ' + (ok ? 'ok' : 'bad');
}
$('btnKey').onclick = useKey;
$('key').addEventListener('keydown', (e) => { if (e.key === 'Enter' && HTTP_MODE) { e.preventDefault(); useKey(); } });
$('key').addEventListener('change', () => { $('key').value = $('key').value.trim(); store.set(KEY_STORE, $('key').value); });
$('unsupported').hidden = HTTP_MODE || webBluetoothSupported();
$('btnConnect').disabled = !webBluetoothSupported();
if (HTTP_MODE) {   // straight onto the Jetson; the passphrase box still signs the commands
  $('btnConnect').hidden = $('btnDemo').hidden = true; $('keyRow').hidden = false;
  $('keyState').textContent = $('key').value ? 'saved on this phone' : 'type it once, then Use passphrase';
  attach(new HttpLink(''), 'Jetson over its hotspot');
}
setInterval(render, 500); // keeps the stale banner honest when no status arrives to trigger a render
$('build').textContent = BUILD; log('console build ' + BUILD);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();

// Scripted end-to-end run against the simulator, for headless checks: ?demo&selftest
if (q.has('demo')) startDemo().then(() => { if (q.has('selftest')) selftest(); });
async function selftest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = (ok, what) => { log((ok ? 'PASS ' : 'FAIL ') + what); document.title = (document.title.startsWith('FAIL') || !ok ? 'FAIL' : 'PASS') + ' selftest'; };
  await wait(1500);
  out(status?.state === 'idle', 'status arrives, idle');
  out($('preset').options.length === 3, 'presets from hello');
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
  const bag = 'lee_2026-11-14_21-11-15', rowText = () => [...document.querySelectorAll('.bagrow')].find((r) => r.textContent.includes(bag))?.textContent || '';
  out(document.querySelectorAll('.bagrow').length === 3, 'bag list shows 3 bags');
  const r5 = await send({ c: 'sync', bag }); await wait(700);
  out(r5?.ok === true && rowText().includes('syncing'), 'sync accepted, row shows syncing');
  await wait(2500);
  out(rowText().includes('in the vault'), 'row shows in the vault after sync');
  await scanNets(); await wait(200);
  out(document.querySelectorAll('#nets .bagrow').length === 3, 'wifi scan shows 3 networks');
  const hs = await send({ c: 'hotspot', on: true }); if (hs?.ok) hotspotPw = hs.secret || ''; await wait(1300);
  out(hs?.ok && $('wifiNow').textContent.startsWith('hotspot') && $('hotspotInfo').textContent.includes('sim-hotspot-pw'), 'hotspot on: name and password shown');
  await send({ c: 'hotspot', on: false }); hotspotPw = ''; await wait(1300);
  out($('wifiNow').textContent.includes('connected to SM'), 'hotspot off: back on SM');
  sim.stallStatus(true); await wait(4500);
  out(!$('stale').hidden, 'stale banner after status stalls');
  log('SELFTEST DONE');
}
