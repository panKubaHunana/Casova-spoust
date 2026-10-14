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
  flashMode: 'off', qualitySel: '0.9', gridChk: false, afLock: false
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
function ratioValue() { return cfg.ratio === '16:9' ? 16 / 9 : 3 / 2; }
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
  clearTimeout(timer); clearInterval(ticker);
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
  ab.textContent = 'AF zámek: ' + (cfg.afLock ? 'zap' : 'vyp');
  ab.classList.toggle('on', cfg.afLock);
  $('grid').classList.toggle('on', !!cfg.gridChk);
  if (!running && $('statusPill').className !== 'warn') setStatus('Připraveno');
}
$('startBtn').addEventListener('click', () => (running ? finish(true) : startTimelapse()));

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

/* ---------- Nastavení – formulář ---------- */
const FIELDS = ['intervalVal', 'intervalUnit', 'stopMode', 'countVal', 'durationVal', 'durationUnit', 'delayVal', 'resSel', 'camSel', 'flashMode', 'qualitySel'];
function loadForm() {
  FIELDS.forEach((k) => ($(k).value = cfg[k]));
  $('gridChk').checked = !!cfg.gridChk;
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
  const done = sharedSet();
  for (let i = 0; i < keys.length; i += BATCH) {
    const ids = keys.slice(i, i + BATCH);
    const mark = `${ids[0]}-${ids[ids.length - 1]}`;
    const b = document.createElement('button');
    b.className = 'batch' + (done.has(mark) ? ' done' : '');
    const label = `Sdílet snímky ${i + 1}–${i + ids.length}`;
    b.textContent = done.has(mark) ? `✓ ${label}` : label;
    b.addEventListener('click', async () => {
      if (await shareBatch(ids)) { markShared(mark); b.classList.add('done'); b.textContent = `✓ ${label}`; }
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
async function shareBatch(ids) {
  try {
    const files = [];
    for (const id of ids) { const r = await dbGet(id); files.push(new File([r.blob], r.name, { type: 'image/jpeg' })); }
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return true; }
    toast('Sdílení souborů tento prohlížeč nepodporuje.');
  } catch (e) { if (e.name !== 'AbortError') toast('Sdílení selhalo: ' + (e.message || e)); }
  return false;
}
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
