/* Časová spoušť – časosběrná PWA pro iPhone (Safari / Home Screen)
 * Vlastní fotoaparát přes getUserMedia, snímky do IndexedDB, export přes Sdílet.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Nastavení (localStorage, bezpečně) ---------- */
const DEFAULTS = {
  ratio: '3:2', intervalVal: 5, intervalUnit: 1, stopMode: 'count', countVal: 100,
  durationVal: 10, durationUnit: 60, delayVal: 3, resSel: 'max', camSel: 'environment',
  flashMode: 'off', qualitySel: '0.9', gridChk: false, afLock: false, aeLock: false,
  beepSec: '3', beepShot: true, beepVol: '0.6'
};
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cs-cfg') || '{}') }; } catch (e) {}
function saveCfg() { try { localStorage.setItem('cs-cfg', JSON.stringify(cfg)); } catch (e) {} }

/* ---------- Stav ---------- */
const video = $('video');
let stream = null, track = null;
let running = false, timer = null, ticker = null, wakeLock = null;
let t0 = 0, shotIndex = 0, taken = 0, missed = 0, total = 0, intervalMs = 5000;
let photoCount = 0;
let torchOn = false;
let lastRes = { w: 0, h: 0 };
let failStreak = 0;

/* ---------- Pomocné UI ---------- */
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function setStatus(text, cls = '') {
  const s = $('statusPill'); s.textContent = text; s.className = cls;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function camMsg(text) {
  const m = $('camMsg');
  if (text) { m.textContent = text; m.hidden = false; } else m.hidden = true;
}

/* ---------- IndexedDB ---------- */
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const rq = indexedDB.open('casova-spoust', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function dbAdd(rec) { const d = await db(); return req(d.transaction('photos', 'readwrite').objectStore('photos').add(rec)); }
async function dbCount() { const d = await db(); return req(d.transaction('photos').objectStore('photos').count()); }
async function dbKeys() { const d = await db(); return req(d.transaction('photos').objectStore('photos').getAllKeys()); }
async function dbGet(id) { const d = await db(); return req(d.transaction('photos').objectStore('photos').get(id)); }
async function dbClear() { const d = await db(); return req(d.transaction('photos', 'readwrite').objectStore('photos').clear()); }

/* ---------- Poměr stran a náhled ---------- */
const RATIOS = { '3:2': 3 / 2, '4:3': 4 / 3, '16:9': 16 / 9 };
function ratioValue() { return RATIOS[cfg.ratio] || 1.5; }
// Podle orientace snímku (na výšku se poměr otočí: 2:3, 9:16)
function targetRatio() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const r = ratioValue();
  return vw && vh && vh > vw ? 1 / r : r;
}
function updatePreviewAspect() {
  const r = targetRatio();
  const w = $('previewWrap');
  w.style.aspectRatio = String(r);
  // omezit podle dostupné výšky, aby se náhled vešel
  const stage = $('stage');
  const maxW = stage.clientWidth - 12, maxH = stage.clientHeight;
  let width = maxW, height = width / r;
  if (height > maxH) { height = maxH; width = height * r; }
  w.style.width = Math.floor(width) + 'px';
  w.style.height = Math.floor(height) + 'px';
}
function applyRatioUI() {
  document.querySelectorAll('#ratioSeg button').forEach((b) =>
    b.classList.toggle('active', b.dataset.ratio === cfg.ratio));
  updatePreviewAspect();
}

/* ---------- Kamera ---------- */
function videoConstraints() {
  // Nižší snímkovací frekvence = menší zátěž při 12Mpx proudu (pro časosběr stačí)
  const v = { facingMode: { ideal: cfg.camSel }, frameRate: { ideal: 10, max: 15 } };
  if (cfg.resSel === 'max') { v.width = { ideal: 4032 }; v.height = { ideal: 3024 }; }
  else if (cfg.resSel === '1080') { v.width = { ideal: 1920 }; v.height = { ideal: 1080 }; }
  else { v.width = { ideal: 1280 }; v.height = { ideal: 720 }; }
  return v;
}
async function startCamera() {
  stopCamera();
  camMsg('');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    camMsg('Tento prohlížeč nepodporuje přístup ke kameře (je nutné HTTPS a Safari na iOS 14.3+).');
    return false;
  }
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: false });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cfg.camSel }, audio: false });
    }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise((r) => {
      if (video.videoWidth) return r();
      video.onloadedmetadata = () => r();
      setTimeout(r, 2000);
    });
    $('resInfo').textContent = `${video.videoWidth}×${video.videoHeight}`;
    lastRes = { w: video.videoWidth, h: video.videoHeight };
    updatePreviewAspect();
    track.addEventListener('ended', () => { if (!document.hidden) startCamera(); });
    // znovu aplikovat blesk a zámek AF
    await applyFlashState();
    if (cfg.afLock) await applyAfLock(true, true);
    if (cfg.aeLock) { await sleep(800); await applyAeLock(true, true); } // chvíli počkat, až se expozice ustálí
    updateButtons();
    return true;
  } catch (e) {
    const msg = e.name === 'NotAllowedError'
      ? 'Přístup k fotoaparátu je zamítnut. Povol ho v Nastavení iOS (Safari → Fotoaparát) a načti aplikaci znovu.'
      : `Kameru se nepodařilo spustit (${e.name || e}).`;
    camMsg(msg);
    return false;
  }
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; track = null; torchOn = false;
}
video.addEventListener('resize', () => {
  $('resInfo').textContent = `${video.videoWidth}×${video.videoHeight}`;
  updatePreviewAspect();
});
window.addEventListener('resize', updatePreviewAspect);
window.addEventListener('orientationchange', () => setTimeout(updatePreviewAspect, 300));

/* ---------- Blesk (torch) ---------- */
async function setTorch(on) {
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    torchOn = !!on;
    return true;
  } catch (e) {
    return false;
  }
}
async function applyFlashState() {
  if (!track || cfg.camSel === 'user') { updateButtons(); return; }
  if (cfg.flashMode === 'on') {
    const ok = await setTorch(true);
    if (!ok) toast('Blesk (svítilna) tento iPhone/Safari nepodporuje, nebo vyžaduje iOS 17.5+.');
  } else {
    await setTorch(false);
  }
  updateButtons();
}

/* ---------- Zámek autofokusu ---------- */
// Safari na iOS focusMode v MediaTrack API často neposkytuje – proto ověřujeme skutečné nastavení.
async function applyAfLock(lock, silent = false) {
  if (!track) return false;
  const caps = (track.getCapabilities && track.getCapabilities()) || {};
  const modes = caps.focusMode || [];
  const want = lock ? (modes.includes('manual') ? 'manual' : modes.includes('single-shot') ? 'single-shot' : 'manual')
                    : (modes.includes('continuous') ? 'continuous' : 'continuous');
  try {
    await track.applyConstraints({ advanced: [{ focusMode: want }] });
    const st = (track.getSettings && track.getSettings()) || {};
    if (st.focusMode && lock && st.focusMode === 'continuous') throw new Error('nezměněno');
    if (!st.focusMode && !modes.length) throw new Error('nepodporováno');
    return true;
  } catch (e) {
    if (lock) {
      cfg.afLock = false; saveCfg(); updateButtons();
      if (!silent) toast('Tento iPhone/Safari neumožňuje zamknout ostření z webové aplikace (focusMode není dostupný).', 5000);
    }
    return false;
  }
}

/* ---------- Zámek expozice a vyvážení bílé (AE/AWB) ---------- */
// Zamkne aktuální expozici a barevnou teplotu, aby časosběr neblikal. Co Safari nepodporuje, ověřujeme
// ze skutečného nastavení stopy (getSettings), ne jen podle toho, že applyConstraints nehodil chybu.
async function applyAeLock(lock, silent = false) {
  if (!track) return false;
  const caps = (track.getCapabilities && track.getCapabilities()) || {};
  const st0 = (track.getSettings && track.getSettings()) || {};
  const defs = [
    { key: 'exposureMode', label: 'expozice', modes: caps.exposureMode || [],
      manual: () => { const o = {}; ['exposureTime', 'iso'].forEach((k) => { if (st0[k] != null) o[k] = st0[k]; }); return o; } },
    { key: 'whiteBalanceMode', label: 'vyvážení bílé', modes: caps.whiteBalanceMode || [],
      manual: () => { const o = {}; if (st0.colorTemperature != null) o.colorTemperature = st0.colorTemperature; return o; } }
  ];
  const done = [];
  for (const d of defs) {
    if (!d.modes.length) continue;
    if (!lock) { try { await track.applyConstraints({ advanced: [{ [d.key]: 'continuous' }] }); } catch (e) {} continue; }
    const order = ['single-shot', 'manual'].filter((m) => d.modes.includes(m));
    for (const m of order) {
      const c = { [d.key]: m };
      if (m === 'manual') { const extra = d.manual(); if (!Object.keys(extra).length) continue; Object.assign(c, extra); }
      try {
        await track.applyConstraints({ advanced: [c] });
        const s = (track.getSettings && track.getSettings()) || {};
        if (s[d.key] !== 'continuous') { done.push(d.label); break; }
      } catch (e) {}
    }
  }
  if (!lock) return true;
  if (!done.length) {
    cfg.aeLock = false; saveCfg(); updateButtons();
    if (!silent) toast('Tento iPhone/Safari neumožňuje zamknout expozici ani vyvážení bílé z webové aplikace.', 5500);
    return false;
  }
  if (!silent) toast('Zamčeno: ' + done.join(' + ') + (done.length < 2 ? ' (druhou věc tento iPhone nepodporuje).' : '.'), 4500);
  return true;
}

/* ---------- Zvukový odpočet před snímkem ---------- */
// Web Audio API: krátké pípnutí každou sekundu před snímkem (3‑2‑1) + volitelný vyšší tón v okamžiku snímku.
// iOS dovolí zvuk jen tehdy, když se AudioContext poprvé „odemkne“ klepnutím uživatele (tlačítko Start / Vyzkoušet).
let actx = null, beepTimers = [];
function unlockAudio() {
  try {
    // iOS 17+: typ relace „playback“ = zvuk hraje i při ztišeném iPhonu (boční přepínač)
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) {}
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!actx) actx = new AC();
    if (actx.state !== 'running') actx.resume().catch(() => {});
    // tichý buffer – spolehlivé odemknutí zvuku na iOS
    const b = actx.createBuffer(1, 1, 22050), src = actx.createBufferSource();
    src.buffer = b; src.connect(actx.destination); src.start(0);
  } catch (e) {}
}
function beep(freq = 1000, durMs = 120) {
  const vol = parseFloat(cfg.beepVol) || 0;
  if (!actx || vol <= 0) return;
  try {
    if (actx.state !== 'running') actx.resume().catch(() => {}); // po návratu z pozadí bývá „interrupted“
    const t = actx.currentTime + 0.01, d = durMs / 1000;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    // krátký náběh/doběh, aby pípnutí „necvakalo“
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.setValueAtTime(vol, t + d - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(actx.destination);
    o.start(t); o.stop(t + d + 0.02);
  } catch (e) {}
}
function showCountdown(n) {
  const el = $('cdNum'); if (!el) return;
  if (!n) { el.hidden = true; return; }
  el.textContent = n; el.hidden = false;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  clearTimeout(showCountdown._t); showCountdown._t = setTimeout(() => (el.hidden = true), 950);
}
function clearBeeps() { beepTimers.forEach(clearTimeout); beepTimers = []; showCountdown(0); }
// Naplánuje pípnutí na due-N s … due-1 s. Pípnutí, která by padla do minulosti
// (krátký interval nebo zpoždění), se vynechají – odpočet se nikdy nepřekrývá s předchozím snímkem.
function scheduleBeeps(due) {
  clearBeeps();
  const n = parseInt(cfg.beepSec, 10) || 0;
  if (!n) return;
  const now = Date.now();
  // u prvního snímku (po odpočtu před startem) tolerujeme pár ms zpoždění, jinak by se ztratilo první „3“
  const tol = shotIndex === 0 ? -250 : 150;
  for (let k = n; k >= 1; k--) {
    const at = due - k * 1000;
    if (at < now + tol) continue;
    beepTimers.push(setTimeout(() => {
      if (!running || document.hidden) return;
      beep(k === 1 ? 1100 : 880, 110); showCountdown(k);
    }, Math.max(0, at - now)));
  }
}

/* ---------- Pořízení snímku ---------- */
function stamp() {
  const d = new Date(), p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function grabBlob() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error('Kamera není připravena');
  const r = targetRatio();
  let cw, ch;
  if (vw / vh > r) { ch = vh; cw = Math.round(vh * r); } else { cw = vw; ch = Math.round(vw / r); }
  const sx = Math.floor((vw - cw) / 2), sy = Math.floor((vh - ch) / 2);
  // Jeden opakovaně použitý canvas: Safari na iOS jinak drží staré 12Mpx canvasy v paměti
  // a po pár desítkách snímků hlásí "Total canvas memory use exceeds the maximum limit".
  const c = getCanvas();
  if (c.width !== cw) c.width = cw;
  if (c.height !== ch) c.height = ch;
  const ctx = c.getContext('2d');
  ctx.drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res({ blob: b, w: cw, h: ch }) : rej(new Error('toBlob selhal'))), 'image/jpeg', parseFloat(cfg.qualitySel)));
}
let thumbCanvas = null;
function makeThumb() {
  const src = workCanvas;
  const tw = 480, th = Math.max(1, Math.round(src.height * tw / src.width));
  const c = thumbCanvas || (thumbCanvas = document.createElement('canvas'));
  c.width = tw; c.height = th;
  c.getContext('2d').drawImage(src, 0, 0, tw, th);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.6));
}
let workCanvas = null;
function getCanvas() { return workCanvas || (workCanvas = document.createElement('canvas')); }
function releaseCanvas() {
  if (!workCanvas) return;
  workCanvas.width = 1; workCanvas.height = 1;
  const x = workCanvas.getContext('2d'); if (x) x.clearRect(0, 0, 1, 1);
}
async function captureOne() {
  const useShotFlash = cfg.flashMode === 'shot' && cfg.camSel !== 'user';
  if (useShotFlash) { await setTorch(true); await sleep(450); }
  let out;
  try { out = await grabBlob(); }
  finally { if (useShotFlash) await setTorch(false); }
  const thumb = await makeThumb().catch(() => null); // malý náhled pro rychlé přehrání ve videu
  const n = String(photoCount + 1).padStart(4, '0');
  await dbAdd({ name: `CS_${stamp()}_${n}.jpg`, blob: out.blob, thumb, ts: Date.now(), w: out.w, h: out.h });
  photoCount++;
  // vizuální záblesk obrazovky
  const f = $('shutterFlash'); f.classList.add('on'); requestAnimationFrame(() => setTimeout(() => f.classList.remove('on'), 60));
  updateThumb(out.blob);
}
let lastThumbUrl = null;
function updateThumb(blob) {
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  const img = $('thumbImg');
  if (blob) { lastThumbUrl = URL.createObjectURL(blob); img.src = lastThumbUrl; img.hidden = false; }
  else { img.hidden = true; img.removeAttribute('src'); lastThumbUrl = null; }
  $('thumbCount').textContent = photoCount;
}

/* ---------- Časosběr ---------- */
function computePlan() {
  intervalMs = Math.max(1, parseFloat(cfg.intervalVal) || 1) * parseFloat(cfg.intervalUnit) * 1000;
  if (cfg.stopMode === 'count') total = Math.max(1, Math.floor(parseFloat(cfg.countVal) || 1));
  else if (cfg.stopMode === 'duration') {
    const durMs = Math.max(1, parseFloat(cfg.durationVal) || 1) * parseFloat(cfg.durationUnit) * 1000;
    total = Math.floor(durMs / intervalMs) + 1;
  } else total = Infinity;
}
async function acquireWake() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}
function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }

async function startTimelapse() {
  if (running) return;
  if (!track || track.readyState !== 'live') { if (!(await startCamera())) return; }
  computePlan();
  if (cfg.flashMode === 'shot' && intervalMs < 2000) {
    toast('Pro záblesk při každém snímku zvol interval alespoň 2 s.'); return;
  }
  // Kontrola místa: odhad ~0,25 B/pixel (JPEG q0,9)
  if (total !== Infinity) {
    const need = total * (video.videoWidth * video.videoHeight) * 0.25 / 1e6;
    const left = await storageLeftMB();
    if (need > left * 0.8 && !confirm(`Plánovaných ${total} snímků zabere ≈ ${fmtMB(need)}, v úložišti prohlížeče zbývá ≈ ${fmtMB(left)}. Přesto začít?`)) return;
  }
  failStreak = 0;
  running = true; taken = 0; missed = 0; shotIndex = 0;
  updateButtons();
  await acquireWake();
  if (!wakeLock) toast('Zámek displeje není dostupný – vypni v iOS automatický zámek (Nastavení → Displej a jas).', 6000);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  const delay = Math.max(0, parseInt(cfg.delayVal, 10) || 0);
  t0 = Date.now() + delay * 1000;
  $('progress').hidden = false;
  ticker = setInterval(renderProgress, 250);
  renderProgress();
  scheduleNext();
}
function scheduleNext() {
  if (!running) return;
  const due = t0 + shotIndex * intervalMs;
  scheduleBeeps(due);
  timer = setTimeout(tick, Math.max(0, due - Date.now()));
}
async function tick() {
  if (!running) return;
  // Pokud jsme zaspali (aplikace na pozadí), zmeškané snímky přeskočíme
  const late = Math.floor((Date.now() - (t0 + shotIndex * intervalMs)) / intervalMs);
  if (late > 0) { missed += late; shotIndex += late; }
  if (shotIndex >= total) return finish();
  if (document.hidden || !track || track.readyState !== 'live') {
    missed++; shotIndex++;
  } else {
    try {
      if (cfg.beepShot && parseInt(cfg.beepSec, 10)) beep(1600, 260); // tón „cvak“ v okamžiku snímku
      await captureOne(); taken++; failStreak = 0;
      if (taken % 25 === 0 && (await storageLeftMB()) < 300) {
        return finish(true, 'Došlo místo v úložišti prohlížeče (zbývá < 300 MB). Uložené snímky hned exportuj.');
      }
    } catch (e) {
      missed++; failStreak++;
      if (e && (e.name === 'QuotaExceededError' || failStreak >= 3)) {
        return finish(true, e.name === 'QuotaExceededError'
          ? 'Úložiště prohlížeče je plné – snímání zastaveno. Exportuj a smaž snímky.'
          : 'Snímání se opakovaně nezdařilo, zastaveno: ' + (e.message || e));
      }
      toast('Snímek se nepodařil: ' + (e.message || e));
    }
    shotIndex++;
  }
  if (shotIndex >= total) return finish();
  scheduleNext();
}
function finish(manual = false, reason = '') {
  running = false;
  clearTimeout(timer); clearInterval(ticker); clearBeeps();
  releaseWake();
  releaseCanvas();
  $('progress').hidden = true;
  updateButtons();
  setStatus(manual ? 'Zastaveno' : 'Hotovo', '');
  const msg = (reason ? reason + ' ' : '') + `${manual ? 'Zastaveno' : 'Časosběr dokončen'}: uloženo ${taken} snímků` + (missed ? `, zmeškáno ${missed}` : '') + '.';
  toast(msg, 9000);
  refreshExport();
}

/* ---------- Úložiště ---------- */
async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch (e) {}
  return null;
}
async function storageLeftMB() {
  const s = await storageEstimate();
  return s && s.quota ? (s.quota - s.usage) / 1e6 : Infinity;
}
const fmtMB = (mb) => (mb < 1000 ? mb.toFixed(0) + ' MB' : (mb / 1000).toFixed(1) + ' GB');
function renderProgress() {
  if (!running) return;
  const now = Date.now();
  if (now < t0) { setStatus(`Start za ${Math.ceil((t0 - now) / 1000)} s`, 'warn'); $('progressText').textContent = 'Připrav telefon…'; $('progressFill').style.width = '0%'; return; }
  const nextIn = Math.max(0, (t0 + shotIndex * intervalMs - now) / 1000);
  setStatus('● Snímám', 'rec');
  if (total === Infinity) {
    $('progressFill').style.width = '100%';
    $('progressText').textContent = `Snímků: ${taken} · další za ${Math.ceil(nextIn)} s${missed ? ` · zmeškáno ${missed}` : ''}`;
  } else {
    $('progressFill').style.width = Math.min(100, (shotIndex / total) * 100) + '%';
    const remain = Math.max(0, (total - shotIndex) * (intervalMs / 1000) - (intervalMs / 1000 - nextIn));
    $('progressText').textContent = `Snímek ${Math.min(taken + 1, total)} / ${total} · další za ${Math.ceil(nextIn)} s · zbývá ${fmtTime(remain)}${missed ? ` · zmeškáno ${missed}` : ''}`;
  }
}

/* ---------- Tlačítka ---------- */
function updateButtons() {
  $('startBtn').classList.toggle('rec', running);
  const fb = $('flashBtn');
  const label = { off: 'vyp', on: 'svítí', shot: 'záblesk' }[cfg.flashMode];
  fb.textContent = 'Blesk: ' + label;
  fb.classList.toggle('on', cfg.flashMode !== 'off' && cfg.camSel !== 'user');
  fb.disabled = cfg.camSel === 'user';
  const ab = $('afBtn');
  ab.textContent = 'AF: ' + (cfg.afLock ? 'zap' : 'vyp');
  ab.classList.toggle('on', cfg.afLock);
  const eb = $('aeBtn');
  eb.textContent = 'AE/WB: ' + (cfg.aeLock ? 'zap' : 'vyp');
  eb.classList.toggle('on', cfg.aeLock);
  $('grid').classList.toggle('on', !!cfg.gridChk);
  if (!running && $('statusPill').className !== 'warn') setStatus('Připraveno');
}
$('startBtn').addEventListener('click', () => {
  if (running) return finish(true);
  if (parseInt(cfg.beepSec, 10)) unlockAudio(); // musí proběhnout přímo v klepnutí (pravidlo iOS)
  startTimelapse();
});

document.querySelectorAll('#ratioSeg button').forEach((b) => b.addEventListener('click', () => {
  cfg.ratio = b.dataset.ratio; saveCfg(); applyRatioUI();
}));
$('flashBtn').addEventListener('click', async () => {
  const order = ['off', 'on', 'shot'];
  cfg.flashMode = order[(order.indexOf(cfg.flashMode) + 1) % order.length];
  $('flashMode').value = cfg.flashMode; saveCfg();
  await applyFlashState();
});
$('afBtn').addEventListener('click', async () => {
  cfg.afLock = !cfg.afLock; saveCfg(); updateButtons();
  const ok = await applyAfLock(cfg.afLock);
  if (cfg.afLock && ok) toast('Ostření zamknuto.');
  updateButtons();
});
$('aeBtn').addEventListener('click', async () => {
  cfg.aeLock = !cfg.aeLock; saveCfg(); updateButtons();
  if (!track) { toast('Kamera není spuštěná.'); cfg.aeLock = false; saveCfg(); updateButtons(); return; }
  if (cfg.aeLock) toast('Zamykám aktuální expozici a barvy…', 1500);
  await applyAeLock(cfg.aeLock);
  updateButtons();
});

/* ---------- Nastavení – formulář ---------- */
const FIELDS = ['intervalVal', 'intervalUnit', 'stopMode', 'countVal', 'durationVal', 'durationUnit', 'delayVal', 'resSel', 'camSel', 'flashMode', 'qualitySel', 'beepSec', 'beepVol'];
function loadForm() {
  FIELDS.forEach((k) => ($(k).value = cfg[k]));
  $('gridChk').checked = !!cfg.gridChk;
  $('beepShot').checked = !!cfg.beepShot;
  showModeRows(); renderEstimate();
}
function showModeRows() {
  $('rowCount').hidden = cfg.stopMode !== 'count';
  $('rowDuration').hidden = cfg.stopMode !== 'duration';
}
function renderEstimate() {
  computePlan();
  const el = $('estimate');
  if (total === Infinity) { el.textContent = 'Snímání poběží, dokud ho ručně nezastavíš.'; return; }
  const secs = (total - 1) * intervalMs / 1000;
  const w = lastRes.w || 1920, h = lastRes.h || 1080;
  const r = ratioValue();
  const portrait = h > w;
  const rr = portrait ? 1 / r : r;
  const cropPx = (w / h > rr) ? (h * rr) * h : w * (w / rr);
  const mb = total * cropPx * 0.25 / 1e6;
  el.textContent = `Plán: ${total} snímků za ${fmtTime(secs)} · video při 25 fps ≈ ${(total / 25).toFixed(1)} s · místo ≈ ${fmtMB(mb)} (odhad).`;
}
FIELDS.forEach((k) => $(k).addEventListener('change', async () => {
  const prev = { res: cfg.resSel, cam: cfg.camSel };
  cfg[k] = $(k).value; saveCfg(); showModeRows(); renderEstimate(); updateButtons();
  if (k === 'flashMode') await applyFlashState();
  if ((k === 'resSel' && prev.res !== cfg.resSel) || (k === 'camSel' && prev.cam !== cfg.camSel)) {
    if (running) { toast('Změna kamery/rozlišení za běhu není možná.'); $(k).value = prev[k === 'resSel' ? 'res' : 'cam']; cfg[k] = $(k).value; saveCfg(); return; }
    needRestart = true; // kamera se spustí znovu po zavření nastavení
  }
}));
let needRestart = false;
$('intervalVal').addEventListener('input', () => { cfg.intervalVal = $('intervalVal').value; renderEstimate(); });
$('countVal').addEventListener('input', () => { cfg.countVal = $('countVal').value; renderEstimate(); });
$('durationVal').addEventListener('input', () => { cfg.durationVal = $('durationVal').value; renderEstimate(); });
$('gridChk').addEventListener('change', () => { cfg.gridChk = $('gridChk').checked; saveCfg(); updateButtons(); });
$('beepShot').addEventListener('change', () => { cfg.beepShot = $('beepShot').checked; saveCfg(); });
$('beepTest').addEventListener('click', () => { // ukázka: 3‑2‑1 a tón snímku
  unlockAudio();
  const n = parseInt(cfg.beepSec, 10) || 3;
  for (let k = n; k >= 1; k--) setTimeout(() => beep(k === 1 ? 1100 : 880, 110), (n - k) * 1000 + 50);
  if (cfg.beepShot) setTimeout(() => beep(1600, 260), n * 1000 + 50);
  if (!(parseFloat(cfg.beepVol) > 0)) toast('Hlasitost je nastavená na „Ztlumeno“.');
});
// Když se nic nesnímá, kameru na dobu nastavení vypneme – 12Mpx proud jinak zpomaluje klávesnici.
$('settingsBtn').addEventListener('click', () => {
  if (!running) { stopCamera(); video.srcObject = null; }
  loadForm(); $('settingsSheet').hidden = false;
});
$('closeSettings').addEventListener('click', async () => {
  saveCfg(); $('settingsSheet').hidden = true;
  if (!running) { needRestart = false; await startCamera(); applyRatioUI(); }
});

/* ---------- Export / galerie ---------- */
let BATCH = 40;
try { BATCH = parseInt(localStorage.getItem('cs-batch'), 10) || 40; } catch (e) {}
function sharedSet() { try { return new Set(JSON.parse(localStorage.getItem('cs-shared') || '[]')); } catch (e) { return new Set(); } }
function markShared(key) { try { const s = sharedSet(); s.add(key); localStorage.setItem('cs-shared', JSON.stringify([...s])); } catch (e) {} }
async function refreshExport() {
  photoCount = await dbCount();
  $('thumbCount').textContent = photoCount;
}
async function showExport() {
  await refreshExport();
  const keys = await dbKeys();
  $('exportInfo').textContent = photoCount ? `Uloženo ${photoCount} snímků v aplikaci. Sdílej je po dávkách (max. ${BATCH} na dávku, aby to iOS zvládl).` : 'Zatím žádné snímky.';
  const list = $('batchList'); list.innerHTML = '';
  $('batchSel').value = String(BATCH);
  $('fmtSel').value = FMT;
  const done = sharedSet();
  for (let i = 0; i < keys.length; i += BATCH) {
    const ids = keys.slice(i, i + BATCH);
    const mark = `${ids[0]}-${ids[ids.length - 1]}`;
    const b = document.createElement('button');
    b.className = 'batch' + (done.has(mark) ? ' done' : '');
    const label = `${FMT === 'zip' ? 'ZIP' : 'Sdílet'} snímky ${i + 1}–${i + ids.length}`;
    b.textContent = done.has(mark) ? `✓ ${label}` : label;
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      const prev = b.textContent;
      const ok = await shareBatch(ids, FMT === 'zip', `Snimky_${i + 1}-${i + ids.length}.zip`,
        (k, n) => { b.textContent = `Připravuji ZIP ${k} / ${n}…`; });
      b.disabled = false;
      if (ok) { markShared(mark); b.classList.add('done'); b.textContent = `✓ ${label}`; } else b.textContent = prev;
    });
    list.appendChild(b);
  }
  const est = await storageEstimate();
  let persisted = '';
  try { if (navigator.storage && navigator.storage.persisted) persisted = (await navigator.storage.persisted()) ? ' · trvalé úložiště povoleno' : ' · úložiště může iOS při nedostatku místa smazat'; } catch (e) {}
  $('storageInfo').textContent = est ? `Úložiště prohlížeče: využito ${fmtMB(est.usage / 1e6)} z ${fmtMB(est.quota / 1e6)}${persisted}.` : '';
  const last = keys.length ? await dbGet(keys[keys.length - 1]) : null;
  const img = $('lastFull');
  if (last) { if (img.dataset.url) URL.revokeObjectURL(img.dataset.url); const u = URL.createObjectURL(last.blob); img.dataset.url = u; img.src = u; img.hidden = false; } else img.hidden = true;
  $('exportSheet').hidden = false;
}
async function shareBatch(ids, asZip, zipName, onProg) {
  try {
    let files = [];
    if (asZip) files = [await makeZip(ids, zipName, onProg)];
    else for (const id of ids) { const r = await dbGet(id); files.push(new File([r.blob], r.name, { type: 'image/jpeg' })); }
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return true; }
    if (asZip) { // záloha: klasické stažení souboru
      const u = URL.createObjectURL(files[0]);
      const a = document.createElement('a'); a.href = u; a.download = files[0].name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      return true;
    }
    toast('Sdílení souborů tento prohlížeč nepodporuje.');
  } catch (e) { if (e.name !== 'AbortError') toast('Sdílení selhalo: ' + (e.message || e), 6000); }
  return false;
}

/* ---------- ZIP bez komprese (JPEG se už nezmenší) ---------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function dosDateTime(ts) {
  const d = new Date(ts || Date.now());
  return { t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
           d: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
async function makeZip(ids, name, onProg) {
  const enc = new TextEncoder(), parts = [], entries = [];
  let off = 0;
  for (let k = 0; k < ids.length; k++) {
    const r = await dbGet(ids[k]);
    if (!r) continue;
    const crc = crc32(new Uint8Array(await r.blob.arrayBuffer())); // po souboru, paměť se hned uvolní
    const size = r.blob.size, nm = enc.encode(r.name), dt = dosDateTime(r.ts);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dt.t, true); h.setUint16(12, dt.d, true); h.setUint32(14, crc, true);
    h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, nm, r.blob);
    entries.push({ nm, crc, size, off, dt });
    off += 30 + nm.length + size;
    if (onProg) onProg(k + 1, ids.length);
  }
  let cdSize = 0;
  for (const e of entries) {
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, e.dt.t, true); c.setUint16(14, e.dt.d, true); c.setUint32(16, e.crc, true);
    c.setUint32(20, e.size, true); c.setUint32(24, e.size, true); c.setUint16(28, e.nm.length, true);
    c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true);
    c.setUint32(38, 0, true); c.setUint32(42, e.off, true);
    parts.push(c.buffer, e.nm); cdSize += 46 + e.nm.length;
  }
  const z = new DataView(new ArrayBuffer(22));
  z.setUint32(0, 0x06054b50, true); z.setUint16(8, entries.length, true); z.setUint16(10, entries.length, true);
  z.setUint32(12, cdSize, true); z.setUint32(16, off, true);
  parts.push(z.buffer);
  return new File(parts, name, { type: 'application/zip' });
}
window.CS_zip = { makeZip, crc32 }; // pro testování

let FMT = 'img';
try { FMT = localStorage.getItem('cs-fmt') === 'zip' ? 'zip' : 'img'; } catch (e) {}
$('fmtSel').addEventListener('change', () => {
  FMT = $('fmtSel').value === 'zip' ? 'zip' : 'img';
  try { localStorage.setItem('cs-fmt', FMT); } catch (e) {}
  showExport();
});
$('batchSel').addEventListener('change', () => {
  BATCH = parseInt($('batchSel').value, 10) || 40;
  try { localStorage.setItem('cs-batch', String(BATCH)); } catch (e) {}
  showExport();
});
$('thumbBtn').addEventListener('click', showExport);
$('closeExport').addEventListener('click', () => ($('exportSheet').hidden = true));
$('clearBtn').addEventListener('click', async () => {
  if (!photoCount) return;
  if (!confirm(`Opravdu smazat všech ${photoCount} snímků z aplikace? Co jsi neuložil do Fotek/Souborů, bude pryč.`)) return;
  await dbClear(); photoCount = 0; updateThumb(null);
  $('exportSheet').hidden = true; toast('Snímky smazány.');
});

/* ---------- Galerie: výběr a mazání snímků ---------- */
async function dbPut(rec) { const d = await db(); return req(d.transaction('photos', 'readwrite').objectStore('photos').put(rec)); }
async function dbDelete(ids) {
  const d = await db();
  const tx = d.transaction('photos', 'readwrite'), st = tx.objectStore('photos');
  ids.forEach((id) => st.delete(id));
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
async function thumbOf(rec) {
  if (rec.thumb) return rec.thumb;
  const bmp = await createImageBitmap(rec.blob);
  const tw = 480, th = Math.max(1, Math.round(bmp.height * tw / bmp.width));
  const c = document.createElement('canvas'); c.width = tw; c.height = th;
  c.getContext('2d').drawImage(bmp, 0, 0, tw, th); bmp.close();
  const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.6));
  c.width = c.height = 1;
  if (b) { rec.thumb = b; dbPut(rec).catch(() => {}); } // příště už se nebude počítat znovu
  return b;
}
let gKeys = [], gSel = new Set(), gView = -1, gToken = 0, viewUrl = null;

async function afterDelete() {
  photoCount = await dbCount();
  const keys = await dbKeys();
  if (keys.length) { const last = await dbGet(keys[keys.length - 1]); updateThumb(last.blob); } else updateThumb(null);
}
function updateGalBar() {
  $('galInfo').textContent = `Snímků: ${gKeys.length} · označeno: ${gSel.size}. Klepnutím na snímek ho zvětšíš, kroužkem v rohu ho označíš.`;
  const b = $('galDelete'); b.textContent = gSel.size ? `🗑 Smazat označené (${gSel.size})` : '🗑 Smazat označené';
  b.disabled = !gSel.size;
}
function renumberCells() {
  [...$('galGrid').children].forEach((c, i) => { c.dataset.i = i; c.querySelector('.gnum').textContent = i + 1; });
}
function removeCells(idxDesc) {
  const grid = $('galGrid');
  idxDesc.forEach((i) => { const c = grid.children[i]; if (c) { if (c._u) URL.revokeObjectURL(c._u); c.remove(); } });
  renumberCells();
}
async function openGallery() {
  if (running) { toast('Nejdřív zastav snímání.'); return; }
  gKeys = await dbKeys(); gSel.clear();
  if (!gKeys.length) { toast('Zatím nejsou žádné snímky.'); return; }
  $('gallerySheet').hidden = false;
  renderGallery();
}
async function renderGallery() {
  const my = ++gToken, grid = $('galGrid');
  [...grid.children].forEach((c) => { if (c._u) URL.revokeObjectURL(c._u); });
  grid.innerHTML = '';
  gKeys.forEach((id, i) => {
    const c = document.createElement('div');
    c.className = 'gcell' + (gSel.has(id) ? ' sel' : ''); c.dataset.i = i;
    c.innerHTML = '<img alt=""><span class="gnum">' + (i + 1) + '</span><span class="chk"></span>';
    grid.appendChild(c);
  });
  updateGalBar();
  for (let i = 0; i < gKeys.length; i++) { // miniatury po jedné, aby se nezahltila paměť
    if (my !== gToken) return;
    const id = gKeys[i];
    try {
      const rec = await dbGet(id); if (!rec) continue;
      const tb = await thumbOf(rec); if (!tb) continue;
      const cell = grid.children[gKeys.indexOf(id)];
      if (!cell || my !== gToken) return;
      cell._u = URL.createObjectURL(tb); cell.querySelector('img').src = cell._u;
    } catch (e) {}
  }
}
function toggleSel(i) {
  const id = gKeys[i]; if (id == null) return;
  if (gSel.has(id)) gSel.delete(id); else gSel.add(id);
  const c = $('galGrid').children[i]; if (c) c.classList.toggle('sel', gSel.has(id));
  updateGalBar();
}
async function deleteSelected() {
  if (!gSel.size) return;
  if (!confirm(`Smazat ${gSel.size} označených snímků z aplikace? Co nemáš uložené ve Fotkách/Souborech, bude pryč.`)) return;
  const ids = [...gSel];
  try { await dbDelete(ids); } catch (e) { toast('Mazání selhalo: ' + (e.message || e)); return; }
  const del = new Set(ids);
  const idx = []; gKeys.forEach((id, i) => { if (del.has(id)) idx.push(i); });
  gKeys = gKeys.filter((id) => !del.has(id)); gSel.clear();
  removeCells(idx.reverse());
  updateGalBar();
  await afterDelete();
  toast(`Smazáno ${ids.length} snímků.`);
  if (!gKeys.length) closeGallery();
}
function closeGallery() {
  gToken++;
  $('viewerSheet').hidden = true; clearViewer();
  [...$('galGrid').children].forEach((c) => { if (c._u) URL.revokeObjectURL(c._u); });
  $('galGrid').innerHTML = '';
  $('gallerySheet').hidden = true;
  if (!$('exportSheet').hidden) showExport();
}
function clearViewer() { if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = null; } $('viewImg').removeAttribute('src'); }
async function showViewer(i) {
  if (i < 0 || i >= gKeys.length) return;
  gView = i;
  const rec = await dbGet(gKeys[i]);
  if (!rec) return;
  clearViewer();
  viewUrl = URL.createObjectURL(rec.blob);
  $('viewImg').src = viewUrl;
  const sel = gSel.has(gKeys[i]);
  $('viewLbl').textContent = `Snímek ${i + 1} / ${gKeys.length}${rec.w ? ` · ${rec.w}×${rec.h}` : ''}`;
  $('viewSel').textContent = sel ? '☑ Označeno' : '☐ Označit';
  $('viewerSheet').hidden = false;
}
async function deleteViewed() {
  const i = gView; if (i < 0 || i >= gKeys.length) return;
  if (!confirm(`Smazat snímek č. ${i + 1} z aplikace? Co nemáš uložené ve Fotkách/Souborech, bude pryč.`)) return;
  const id = gKeys[i];
  try { await dbDelete([id]); } catch (e) { toast('Mazání selhalo: ' + (e.message || e)); return; }
  gKeys.splice(i, 1); gSel.delete(id);
  removeCells([i]); updateGalBar();
  await afterDelete();
  if (!gKeys.length) { closeGallery(); return; }
  await showViewer(Math.min(i, gKeys.length - 1));
}
$('galleryBtn').addEventListener('click', openGallery);
$('galGrid').addEventListener('click', (e) => {
  const cell = e.target.closest('.gcell'); if (!cell) return;
  const i = parseInt(cell.dataset.i, 10);
  if (e.target.classList.contains('chk')) toggleSel(i); else showViewer(i);
});
$('galAll').addEventListener('click', () => { gKeys.forEach((id) => gSel.add(id)); [...$('galGrid').children].forEach((c) => c.classList.add('sel')); updateGalBar(); });
$('galNone').addEventListener('click', () => { gSel.clear(); [...$('galGrid').children].forEach((c) => c.classList.remove('sel')); updateGalBar(); });
$('galDelete').addEventListener('click', deleteSelected);
$('closeGallery').addEventListener('click', closeGallery);
$('viewPrev').addEventListener('click', () => showViewer(gView - 1));
$('viewNext').addEventListener('click', () => showViewer(gView + 1));
$('viewSel').addEventListener('click', () => { toggleSel(gView); const s = gSel.has(gKeys[gView]); $('viewSel').textContent = s ? '☑ Označeno' : '☐ Označit'; });
$('viewDel').addEventListener('click', deleteViewed);
$('closeViewer').addEventListener('click', () => { $('viewerSheet').hidden = true; clearViewer(); });

/* ---------- Životní cyklus ---------- */
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    if (running) setStatus('Na pozadí – snímání pozastaveno', 'warn');
  } else {
    if (running) { await acquireWake(); }
    if (!track || track.readyState !== 'live') await startCamera();
    updateButtons();
  }
});

/* ---------- Spolupráce s modulem Video ---------- */
window.CS = { isRunning: () => running };
window.addEventListener('cs-video-open', () => { stopCamera(); video.srcObject = null; });
window.addEventListener('cs-video-close', async () => { await refreshExport(); await startCamera(); applyRatioUI(); });

/* ---------- Start ---------- */
(async function init() {
  applyRatioUI(); updateButtons();
  await refreshExport();
  try {
    const keys = await dbKeys();
    if (keys.length) { const last = await dbGet(keys[keys.length - 1]); updateThumb(last.blob); }
  } catch (e) {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await startCamera();
  updatePreviewAspect();
})();
