/* Skládání stopmotion videa (MP4 / H.264) z nasnímaných fotek.
 * WebCodecs VideoEncoder + mp4-muxer (vendor/mp4-muxer.js, MIT).
 * Snímky se zpracovávají po jednom, aby nedošlo k vyčerpání paměti.
 */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- IndexedDB (stejná databáze jako aplikace) ---------- */
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
  const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function dbKeys() { const d = await db(); return rq(d.transaction('photos').objectStore('photos').getAllKeys()); }
  async function dbGet(id) { const d = await db(); return rq(d.transaction('photos').objectStore('photos').get(id)); }
  async function dbDelete(id) {
    const d = await db(); const tx = d.transaction('photos', 'readwrite'); tx.objectStore('photos').delete(id);
    return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  }
  // Snímky různých poměrů stran (např. 3:2 a 16:9 v jedné sadě) se oříznou na poměr prvního snímku, neroztáhnou se.
  function drawCover(ctx, img, w, h) {
    const s = Math.max(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  /* ---------- Stav ---------- */
  const DEF = { vFps: '12', vMode: 'normal', vRes: '1080', vQual: '0.2' };
  let vcfg = { ...DEF };
  try { vcfg = { ...DEF, ...JSON.parse(localStorage.getItem('cs-video') || '{}') }; } catch (e) {}
  const saveV = () => { try { localStorage.setItem('cs-video', JSON.stringify(vcfg)); } catch (e) {} };

  let keys = [], srcW = 0, srcH = 0;
  let seq = [], pos = 0, playing = false, showToken = 0;
  let building = false, cancelFlag = false, resultUrl = null, resultFile = null;
  const thumbCache = new Map();
  let prevCanvas = null, prevCtx = null;
  let workCanvas = null;
  let wake = null;

  function toast(t, ms) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), ms || 4500); }
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const fmtMB = (b) => (b / 1e6 < 1000 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e9).toFixed(2) + ' GB');
  function fmtT(sec) { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }

  /* ---------- Sekvence snímků ---------- */
  function buildSeq() {
    const n = keys.length;
    let a = Math.min(n, Math.max(1, parseInt($('vFrom').value, 10) || 1));
    let b = Math.min(n, Math.max(1, parseInt($('vTo').value, 10) || n));
    if (a > b) [a, b] = [b, a];
    const fwd = []; for (let i = a - 1; i <= b - 1; i++) fwd.push(i);
    if (vcfg.vMode === 'reverse') return fwd.reverse();
    if (vcfg.vMode === 'pingpong') { const back = fwd.slice(1, -1).reverse(); return fwd.concat(back); }
    return fwd;
  }
  function refreshSeq() {
    seq = buildSeq();
    if (pos >= seq.length) pos = 0;
    const fps = parseInt(vcfg.vFps, 10);
    $('vInfo').textContent = `Ve videu: ${seq.length} snímků · délka ≈ ${(seq.length / fps).toFixed(1)} s při ${fps} snímcích/s`;
    $('vSlider').max = Math.max(0, seq.length - 1);
  }

  /* ---------- Náhled ---------- */
  async function ensureThumb(rec) {
    if (rec.thumb) return rec.thumb;
    if (thumbCache.has(rec.id)) return thumbCache.get(rec.id);
    const bmp = await createImageBitmap(rec.blob);
    const tw = 480, th = Math.round(bmp.height * tw / bmp.width);
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    c.getContext('2d').drawImage(bmp, 0, 0, tw, th); bmp.close();
    const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.6));
    thumbCache.set(rec.id, b); c.width = c.height = 1;
    return b;
  }
  async function showFrame(p) {
    if (!seq.length) return;
    const my = ++showToken;
    pos = p;
    const rec = await dbGet(keys[seq[p]]);
    if (!rec) return;
    const tb = await ensureThumb(rec);
    const bmp = await createImageBitmap(tb);
    if (my !== showToken) { bmp.close(); return; }
    drawCover(prevCtx, bmp, prevCanvas.width, prevCanvas.height); bmp.close();
    $('vSlider').value = p;
    $('vFrameLbl').textContent = `${p + 1} / ${seq.length} (snímek č. ${seq[p] + 1})`;
  }
  async function playLoop() {
    const frameMs = 1000 / parseInt(vcfg.vFps, 10);
    const t0 = performance.now(), p0 = pos;
    let last = -1;
    while (playing) {
      const p = (p0 + Math.floor((performance.now() - t0) / frameMs)) % Math.max(1, seq.length);
      if (p !== last) { last = p; await showFrame(p); }
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
  function setPlaying(on) {
    playing = on && seq.length > 1;
    $('vPlay').textContent = playing ? '⏸ Pauza' : '▶ Přehrát';
    if (playing) playLoop();
  }

  /* ---------- Rozměry a kodek ---------- */
  function outDims(res) {
    const landscape = srcW >= srcH;
    if (res === 'orig') return { w: even(srcW), h: even(srcH) };
    const L = res === '4k' ? 3840 : 1920;
    return landscape ? { w: L, h: even(L * srcH / srcW) } : { w: even(L * srcW / srcH), h: L };
  }
  const CODECS = ['avc1.640028', 'avc1.64002a', 'avc1.640032', 'avc1.640033', 'avc1.640034', 'avc1.64003c', 'avc1.4d0034', 'avc1.42003c'];
  async function pickConfig(w, h, fps, bitrate) {
    if (!('VideoEncoder' in window)) return null;
    for (const codec of CODECS) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
      try { const s = await VideoEncoder.isConfigSupported(cfg); if (s && s.supported) return s.config || cfg; } catch (e) {}
    }
    return null;
  }
  function bitrateFor(w, h, fps) {
    return Math.round(Math.min(100e6, Math.max(2e6, w * h * fps * parseFloat(vcfg.vQual))));
  }
  async function checkCapabilities() {
    const el = $('vCap');
    if (!('VideoEncoder' in window)) { el.textContent = 'Tento prohlížeč nepodporuje WebCodecs (VideoEncoder) – video nelze složit.'; $('vBuild').disabled = true; return; }
    const fps = parseInt(vcfg.vFps, 10);
    const sel = $('vRes');
    const names = { 1080: 'Full HD', '4k': '4K', orig: 'Původní velikost' };
    let okAny = false;
    for (const opt of sel.options) {
      const d = outDims(opt.value);
      const c = await pickConfig(d.w, d.h, fps, bitrateFor(d.w, d.h, fps));
      opt.disabled = !c;
      opt.textContent = `${names[opt.value]} (${d.w}×${d.h})${c ? '' : ' – nepodporováno'}`;
      if (c) okAny = true;
    }
    if (sel.options[sel.selectedIndex].disabled) { const f = [...sel.options].find((o) => !o.disabled); if (f) { sel.value = f.value; vcfg.vRes = f.value; saveV(); } }
    el.textContent = okAny ? 'Kódování H.264 je na tomto iPhonu dostupné.' : 'Žádný z rozměrů tento iPhone nezakóduje.';
    $('vBuild').disabled = !okAny;
  }

  /* ---------- Skládání ---------- */
  async function acquireWake() { try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; } }
  function releaseWake() { try { if (wake) wake.release(); } catch (e) {} wake = null; }

  async function build() {
    if (building) return;
    seq = buildSeq();
    if (seq.length < 2) { toast('Vyber alespoň 2 snímky.'); return; }
    setPlaying(false);
    const fps = parseInt(vcfg.vFps, 10);
    const { w, h } = outDims(vcfg.vRes);
    const bitrate = bitrateFor(w, h, fps);
    const cfg = await pickConfig(w, h, fps, bitrate);
    if (!cfg) { toast('Tento rozměr iPhone nezakóduje, zvol jiné rozlišení.'); return; }

    building = true; cancelFlag = false;
    $('vBuild').hidden = true; $('vCancel').hidden = false; $('vResult').hidden = true;
    $('vProg').hidden = false;
    await acquireWake();
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }

    let encErr = null, enc = null;
    const t0 = performance.now();
    try {
      const target = new Mp4Muxer.ArrayBufferTarget();
      const muxer = new Mp4Muxer.Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
      enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
      enc.configure(cfg);

      workCanvas = workCanvas || document.createElement('canvas');
      workCanvas.width = w; workCanvas.height = h;
      const ctx = workCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const dur = Math.round(1e6 / fps);

      for (let i = 0; i < seq.length; i++) {
        if (cancelFlag) throw new Error('cancel');
        if (encErr) throw encErr;
        const rec = await dbGet(keys[seq[i]]);
        const bmp = await createImageBitmap(rec.blob);
        drawCover(ctx, bmp, w, h); bmp.close();
        const frame = new VideoFrame(workCanvas, { timestamp: Math.round(i * 1e6 / fps), duration: dur });
        enc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        while (enc.encodeQueueSize > 3) { await sleep(8); if (encErr) throw encErr; }
        const done = i + 1, el = (performance.now() - t0) / 1000;
        $('vBar').style.width = (done / seq.length * 100) + '%';
        $('vProgTxt').textContent = `Kódování ${done} / ${seq.length} · zbývá ≈ ${fmtT(el / done * (seq.length - done))}`;
      }
      await enc.flush();
      if (encErr) throw encErr;
      muxer.finalize();
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      resultFile = new File([blob], `Stopmotion_${new Date().toISOString().slice(0, 10)}_${w}x${h}_${fps}fps.mp4`, { type: 'video/mp4' });
      resultUrl = URL.createObjectURL(blob);
      $('vOut').src = resultUrl;
      $('vResInfo').textContent = `Hotovo: ${w}×${h}, ${fps} sn./s, ${(seq.length / fps).toFixed(1)} s, ${fmtMB(blob.size)}. Kódování trvalo ${fmtT((performance.now() - t0) / 1000)}.`;
      $('vResult').hidden = false;
    } catch (e) {
      if (e && e.message === 'cancel') toast('Skládání zrušeno.');
      else toast('Skládání videa selhalo: ' + ((e && (e.message || e.name)) || e), 9000);
    } finally {
      try { if (enc && enc.state !== 'closed') enc.close(); } catch (e) {}
      if (workCanvas) { workCanvas.width = 1; workCanvas.height = 1; }
      releaseWake();
      building = false;
      $('vBuild').hidden = false; $('vCancel').hidden = true; $('vProg').hidden = true;
    }
  }

  async function shareResult() {
    if (!resultFile) return;
    try {
      if (navigator.canShare && navigator.canShare({ files: [resultFile] })) await navigator.share({ files: [resultFile] });
      else toast('Sdílení souborů není dostupné.');
    } catch (e) { if (e.name !== 'AbortError') toast('Sdílení selhalo: ' + (e.message || e)); }
  }

  /* ---------- Smazání zobrazeného snímku ---------- */
  async function deleteCurrent() {
    if (building || !seq.length) return;
    setPlaying(false);
    if (keys.length <= 2) { toast('Zbývají jen 2 snímky – na video je potřeba aspoň 2.'); return; }
    const idx = seq[pos]; // index v poli keys
    if (!confirm(`Smazat snímek č. ${idx + 1} z aplikace? Co nemáš uložené ve Fotkách/Souborech, bude pryč.`)) return;
    const from0 = parseInt($('vFrom').value, 10) || 1, to0 = parseInt($('vTo').value, 10) || keys.length;
    const id = keys[idx];
    try { await dbDelete(id); } catch (e) { toast('Mazání selhalo: ' + (e.message || e)); return; }
    thumbCache.delete(id);
    keys = await dbKeys();
    const n = keys.length, num = idx + 1; // číslo smazaného snímku
    let nf = from0 > num ? from0 - 1 : from0, nt = to0 >= num ? to0 - 1 : to0;
    nf = Math.min(n, Math.max(1, nf)); nt = Math.min(n, Math.max(1, nt));
    if (nf > nt) nf = nt;
    $('vFrom').max = $('vTo').max = n; $('vFrom').value = nf; $('vTo').value = nt;
    $('vSrc').textContent = `Snímků v aplikaci: ${n} · zdroj ${srcW}×${srcH} (snímky jiného poměru se oříznou na poměr prvního)`;
    refreshSeq();
    pos = Math.min(pos, Math.max(0, seq.length - 1));
    await showFrame(pos);
    toast('Snímek smazán.', 2500);
  }

  /* ---------- Otevření a zavření ---------- */
  async function openVideo() {
    if (window.CS && window.CS.isRunning && window.CS.isRunning()) { toast('Nejdřív zastav snímání.'); return; }
    keys = await dbKeys();
    if (!keys.length) { toast('Zatím nejsou žádné snímky.'); return; }
    window.dispatchEvent(new Event('cs-video-open'));
    const first = await dbGet(keys[0]);
    srcW = first.w || 1920; srcH = first.h || 1080;
    prevCanvas = $('vCanvas'); prevCtx = prevCanvas.getContext('2d');
    prevCanvas.width = 480; prevCanvas.height = Math.max(2, Math.round(480 * srcH / srcW));
    prevCanvas.style.aspectRatio = `${srcW} / ${srcH}`;
    $('vFrom').value = 1; $('vTo').value = keys.length; $('vFrom').max = $('vTo').max = keys.length;
    $('vFps').value = vcfg.vFps; $('vMode').value = vcfg.vMode; $('vRes').value = vcfg.vRes; $('vQual').value = vcfg.vQual;
    $('vSrc').textContent = `Snímků v aplikaci: ${keys.length} · zdroj ${srcW}×${srcH} (snímky jiného poměru se oříznou na poměr prvního)`;
    $('vResult').hidden = true; $('vProg').hidden = true; $('vCancel').hidden = true; $('vBuild').hidden = false;
    $('videoSheet').hidden = false;
    refreshSeq(); pos = 0;
    await showFrame(0);
    checkCapabilities();
  }
  function closeVideo() {
    if (building) { toast('Skládání ještě běží – nejdřív ho zruš.'); return; }
    setPlaying(false);
    $('videoSheet').hidden = true;
    if (resultUrl) { $('vOut').pause(); }
    thumbCache.clear();
    window.dispatchEvent(new Event('cs-video-close'));
  }

  /* ---------- Události ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    $('videoBtn').addEventListener('click', openVideo);
    $('closeVideo').addEventListener('click', closeVideo);
    $('vPlay').addEventListener('click', () => setPlaying(!playing));
    $('vDel').addEventListener('click', deleteCurrent);
    $('vSlider').addEventListener('input', () => { setPlaying(false); showFrame(parseInt($('vSlider').value, 10)); });
    ['vFrom', 'vTo'].forEach((id) => $(id).addEventListener('change', () => { setPlaying(false); refreshSeq(); showFrame(0); }));
    [['vFps', 'vFps'], ['vMode', 'vMode'], ['vRes', 'vRes'], ['vQual', 'vQual']].forEach(([id, k]) =>
      $(id).addEventListener('change', async () => {
        vcfg[k] = $(id).value; saveV();
        const was = playing; setPlaying(false); refreshSeq();
        if (k === 'vFps' || k === 'vQual') await checkCapabilities();
        if (was) setPlaying(true);
      }));
    $('vBuild').addEventListener('click', build);
    $('vCancel').addEventListener('click', () => { cancelFlag = true; });
    $('vShare').addEventListener('click', shareResult);
  });
})();
