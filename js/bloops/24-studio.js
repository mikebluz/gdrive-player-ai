// ============================================================
// TRACKS studio — a self-contained multi-track recorder / mixer view.
//   • Record takes (mic / line-in, picker + live monitor) WHILE hearing the
//     other tracks — the take lands at the position recording started.
//   • Per-track waveform + shared playhead; play / stop-in-place / ±5 s /
//     skip to start / end; click a waveform to seek.
//   • Mix: volume · pan · EQ (low/high shelf) · reverb + delay sends ·
//     mute / solo. Runs on its OWN native AudioContext (independent of
//     Tone's wrapper — native AudioWorkletNode works directly).
//   • Export mixdown (OfflineAudioContext → WAV) → Google Drive under
//     Tracks/YYYY/MM/DD/<name>.wav (name prompt prefilled with random
//     words) via window._drvBridge; falls back to a local download.
//   • Persistence: take WAVs in IndexedDB ('bloops-studio'), mix meta in
//     localStorage ('bloops-studio-tracks') — survives reload.
// Integration: 14-ui-menus-dnd calls window._studioShow() when the Tracks
// tab activates; everything here is lazy until then.
(function () {
  'use strict';
  const LS_META = 'bloops-studio-tracks';
  const LS_INPUT = 'bloops-studio-input';
  const DB_NAME = 'bloops-studio', DB_STORE = 'takes';
  const WORDS = ['amber','birch','cedar','delta','ember','fable','grove','harbor','indigo','juniper','kelp','lumen','meadow','nectar','onyx','prairie','quartz','raven','saffron','tundra','umber','velvet','willow','yonder','zephyr','canyon','drift','echo','fjord','glacier','hollow','isle','koi','lagoon','mesa','nimbus','opal','pine','reef','sable','thicket','vale','wren','aurora','basalt','cove','dune','fern'];

  let ctx = null, master = null, revConv = null, revBus = null, delNode = null, delFb = null, delBus = null;
  let tracks = [];            // {id,name,offset,gain,pan,mute,solo,eqLo,eqHi,rev,del, buffer, nodes:{}, canvas}
  let pos = 0, playing = false, playT0 = 0, playBase = 0, sources = [], raf = 0;
  let inited = false, dirty = null;
  // record state
  let rec = { on: false, stream: null, tap: null, src: null, sink: null, mon: null, pcm: [], chans: 1, firstFrame: -1, startPos: 0, t0: 0 };

  // ---------- infra ----------
  const $ = (id) => document.getElementById(id);
  const acx = () => {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    // shared reverb: generated stereo noise-decay IR (2 s)
    revConv = ctx.createConvolver();
    const sr = ctx.sampleRate, len = Math.floor(sr * 2);
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    revConv.buffer = ir;
    revBus = ctx.createGain(); revBus.gain.value = 1; revBus.connect(revConv); revConv.connect(master);
    // shared delay: 350 ms feedback echo
    delNode = ctx.createDelay(2); delNode.delayTime.value = 0.35;
    delFb = ctx.createGain(); delFb.gain.value = 0.38;
    delNode.connect(delFb); delFb.connect(delNode);
    delBus = ctx.createGain(); delBus.gain.value = 1; delBus.connect(delNode); delNode.connect(master);
    return ctx;
  };
  const openDb = () => new Promise((ok, no) => {
    const q = indexedDB.open(DB_NAME, 1);
    q.onupgradeneeded = (e) => { const d = e.target.result; if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE); };
    q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error);
  });
  const dbPut = async (id, blob) => { const d = await openDb(); await new Promise((ok) => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).put(blob, id); tx.oncomplete = ok; tx.onerror = ok; }); };
  const dbGet = async (id) => { const d = await openDb(); return new Promise((ok) => { const tx = d.transaction(DB_STORE, 'readonly'); const r = tx.objectStore(DB_STORE).get(id); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); }); };
  const dbDel = async (id) => { const d = await openDb(); await new Promise((ok) => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).delete(id); tx.oncomplete = ok; tx.onerror = ok; }); };
  const saveMeta = () => {
    clearTimeout(dirty);
    dirty = setTimeout(() => {
      try { localStorage.setItem(LS_META, JSON.stringify(tracks.map(t => ({ id: t.id, name: t.name, offset: t.offset, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo, eqLo: t.eqLo, eqHi: t.eqHi, rev: t.rev, del: t.del })))); } catch (e) {}
    }, 250);
  };
  const toast = (m) => { try { if (typeof showToast === 'function') showToast(m); else console.log('[Tracks]', m); } catch (e) {} };

  // WAV encode (16-bit PCM, self-contained)
  function wavEncode(buf) {
    const ch = Math.min(2, buf.numberOfChannels), sr = buf.sampleRate, n = buf.length;
    const bytes = 44 + n * ch * 2, ab = new ArrayBuffer(bytes), v = new DataView(ab);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, bytes - 8, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * ch * 2, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { let s = Math.max(-1, Math.min(1, chans[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
    return new Blob([ab], { type: 'audio/wav' });
  }

  // ---------- track graph ----------
  const anySolo = () => tracks.some(t => t.solo && !t.mute);
  const audible = (t) => !t.mute && (!anySolo() || t.solo);
  function ensureNodes(t) {
    if (t.nodes) return t.nodes;
    const c = acx();
    const lo = c.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 220;
    const hi = c.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 3200;
    const pan = c.createStereoPanner();
    const g = c.createGain();
    const rv = c.createGain(); const dl = c.createGain();
    lo.connect(hi); hi.connect(pan); pan.connect(g); g.connect(master);
    g.connect(rv); rv.connect(revBus); g.connect(dl); dl.connect(delBus);
    t.nodes = { lo, hi, pan, g, rv, dl };
    applyMix(t);
    return t.nodes;
  }
  function applyMix(t) {
    if (!t.nodes) return;
    t.nodes.lo.gain.value = t.eqLo; t.nodes.hi.gain.value = t.eqHi;
    t.nodes.pan.pan.value = t.pan;
    t.nodes.g.gain.value = audible(t) ? t.gain : 0;
    t.nodes.rv.gain.value = t.rev; t.nodes.dl.gain.value = t.del;
  }
  const applyAllMix = () => tracks.forEach(applyMix);
  const totalLen = () => tracks.reduce((m, t) => Math.max(m, t.offset + (t.buffer ? t.buffer.duration : 0)), 0);
  const timelineLen = () => Math.max(totalLen(), 1);   // shared lane scale (never 0-wide)

  // ---------- transport ----------
  function play() {
    const c = acx(); if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    if (playing) return;
    stopSources();
    const t0 = c.currentTime + 0.08;
    playT0 = t0; playBase = pos;
    tracks.forEach(t => {
      if (!t.buffer) return;
      ensureNodes(t);
      const local = pos - t.offset;                    // where the playhead sits inside this take
      if (local >= t.buffer.duration) return;
      const s = c.createBufferSource(); s.buffer = t.buffer; s.connect(t.nodes.lo);
      if (local >= 0) s.start(t0, local);
      else s.start(t0 - local, 0);                     // take starts later on the timeline
      sources.push(s);
    });
    playing = true;
    syncTransportUI();
    cancelAnimationFrame(raf);
    const step = () => {
      if (!playing) return;
      pos = playBase + (c.currentTime - playT0);
      const end = totalLen();
      if (!rec.on && end > 0 && pos >= end + 0.05) { stop(); pos = end; syncTransportUI(); drawAllHeads(); return; }
      drawAllHeads(); syncTimeUI();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function stopSources() { sources.forEach(s => { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} }); sources = []; }
  function stop() {
    if (playing) { pos = playBase + (acx().currentTime - playT0); playing = false; }
    stopSources();
    cancelAnimationFrame(raf);
    if (rec.on) finishRecord();
    syncTransportUI(); syncTimeUI(); drawAllHeads();
  }
  function seek(p) {
    const wasPlaying = playing;
    if (playing) { playing = false; stopSources(); cancelAnimationFrame(raf); }
    pos = Math.max(0, Math.min(p, Math.max(totalLen(), p)));
    if (wasPlaying) play(); else { syncTimeUI(); drawAllHeads(); }
  }

  // ---------- recording ----------
  const TAP_SRC = 'class ST extends AudioWorkletProcessor{constructor(){super();this._stop=false;this._buf=null;this._fill=0;this._ch=1;this.port.onmessage=e=>{if(e.data==="stop"){this._stop=true;this._flush();this.port.postMessage({t:"done"});}};}_flush(){if(this._buf&&this._fill>0){const out=this._buf.map(b=>b.slice(0,this._fill));this.port.postMessage({t:"d",ch:out.map(a=>a.buffer)},out.map(a=>a.buffer));}if(this._buf)this._buf=this._buf.map(()=>new Float32Array(4096));this._fill=0;}process(inputs){if(this._stop)return false;const inp=inputs[0];if(!inp||!inp.length||!inp[0].length)return true;if(this._buf===null){this._ch=Math.min(2,inp.length);this._buf=[];for(let c=0;c<this._ch;c++)this._buf.push(new Float32Array(4096));this.port.postMessage({t:"start",frame:currentFrame,sr:sampleRate,ch:this._ch});}const n=inp[0].length;let off=0;while(off<n){const take=Math.min(n-off,4096-this._fill);for(let c=0;c<this._ch;c++){const src=inp[c]||inp[0];this._buf[c].set(src.subarray(off,off+take),this._fill);}this._fill+=take;off+=take;if(this._fill>=4096)this._flush();}return true;}}registerProcessor("studio-tap",ST);';
  async function startRecord() {
    if (rec.on) { stop(); return; }
    const c = acx(); if (c.state === 'suspended') { try { await c.resume(); } catch (e) {} }
    const devId = ($('studio-input') && $('studio-input').value) || '';
    const clean = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream = null;
    if (devId) { try { stream = await navigator.mediaDevices.getUserMedia({ audio: { ...clean, deviceId: { exact: devId } } }); } catch (e) {} }
    if (!stream) { try { stream = await navigator.mediaDevices.getUserMedia({ audio: clean }); } catch (e) { toast('Microphone permission denied.'); return; } }
    try {
      if (!c._studioTapLoaded) { await c.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP_SRC], { type: 'text/javascript' }))); c._studioTapLoaded = true; }
    } catch (e) { toast('Recording unavailable (worklet failed).'); stream.getTracks().forEach(t => t.stop()); return; }
    rec.stream = stream;
    rec.pcm = []; rec.firstFrame = -1; rec.chans = 1;
    rec.tap = new AudioWorkletNode(c, 'studio-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    rec.tap.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'start') { rec.firstFrame = m.frame; rec.chans = m.ch; }
      else if (m.t === 'd') rec.pcm.push(m.ch.map(b => new Float32Array(b)));
      else if (m.t === 'done') commitRecord();
    };
    rec.src = c.createMediaStreamSource(stream);
    rec.src.connect(rec.tap);
    rec.sink = c.createGain(); rec.sink.gain.value = 0; rec.tap.connect(rec.sink); rec.sink.connect(c.destination);
    rec.mon = c.createGain(); rec.mon.gain.value = 0.9; rec.src.connect(rec.mon); rec.mon.connect(master);   // hear yourself (point 5)
    rec.startPos = pos;
    rec.on = true;
    play();                       // hear the other tracks while recording
    rec.t0 = playT0;              // transport anchor on the SAME clock as the tap
    syncTransportUI();
    toast('Recording — press ■ to finish.');
  }
  function finishRecord() {
    if (!rec.on) return;
    rec.on = false;
    try { rec.tap.port.postMessage('stop'); } catch (e) { commitRecord(); }
  }
  function teardownRec() {
    ['src', 'tap', 'sink', 'mon'].forEach(k => { try { if (rec[k]) rec[k].disconnect(); } catch (e) {} rec[k] = null; });
    try { if (rec.stream) rec.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    rec.stream = null;
  }
  async function commitRecord() {
    const c = acx();
    const pcm = rec.pcm, firstFrame = rec.firstFrame, chans = Math.max(1, rec.chans | 0), t0 = rec.t0, startPos = rec.startPos;
    teardownRec();
    rec.pcm = [];
    if (firstFrame < 0 || !pcm.length) { toast('Nothing recorded.'); syncTransportUI(); return; }
    const sr = c.sampleRate;
    let total = 0; pcm.forEach(b => { total += b[0].length; });
    // latency compensation: the performer hears late + input arrives late
    const comp = (c.outputLatency || c.baseLatency || 0) + 0.01;
    const sliceStart = Math.max(0, Math.round(((t0 + comp) - (firstFrame / sr)) * sr));
    const avail = Math.max(0, total - sliceStart);
    if (avail < sr * 0.2) { toast('Recording too short.'); syncTransportUI(); return; }
    const buf = c.createBuffer(chans, avail, sr);
    const dsts = []; for (let ch = 0; ch < chans; ch++) dsts.push(buf.getChannelData(ch));
    let w = 0, rdo = 0;
    for (const b of pcm) {
      const n = b[0].length, from = Math.max(0, sliceStart - rdo);
      if (from < n) { const cnt = Math.min(n - from, avail - w); if (cnt > 0) { for (let ch = 0; ch < chans; ch++) { const src = b[Math.min(ch, b.length - 1)]; dsts[ch].set(src.subarray(from, from + cnt), w); } w += cnt; } }
      rdo += n; if (w >= avail) break;
    }
    // edge de-click
    { const f = Math.min(Math.floor(avail / 4), Math.round(sr * 0.005)); for (let ch = 0; ch < chans; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < f; i++) { const g = i / f; d[i] *= g; d[avail - 1 - i] *= g; } } }
    const id = 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const t = { id, name: 'Take ' + (tracks.length + 1), offset: startPos, gain: 0.9, pan: 0, mute: false, solo: false, eqLo: 0, eqHi: 0, rev: 0, del: 0, buffer: buf, nodes: null, canvas: null };
    tracks.push(t);
    try { await dbPut(id, wavEncode(buf)); } catch (e) {}
    saveMeta();
    renderTracks();
    toast('Take saved — ' + buf.duration.toFixed(1) + 's at ' + fmtTime(startPos) + '.');
    syncTransportUI();
  }

  // ---------- waveforms ----------
  function drawWave(t) {
    const cv = t.canvas; if (!cv || !t.buffer) return;
    const w = cv.width = cv.clientWidth * (window.devicePixelRatio || 1);
    const h = cv.height = 72 * (window.devicePixelRatio || 1);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#141422'; g.fillRect(0, 0, w, h);
    const d = t.buffer.getChannelData(0), n = d.length, step = Math.max(1, Math.floor(n / w));
    g.fillStyle = '#7db8a8';
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      let mn = 1, mx = -1;
      const i0 = x * step, i1 = Math.min(n, i0 + step);
      for (let i = i0; i < i1; i++) { const s = d[i]; if (s < mn) mn = s; if (s > mx) mx = s; }
      if (mx < mn) continue;
      g.fillRect(x, mid + mn * mid * 0.92, 1, Math.max(1, (mx - mn) * mid * 0.92));
    }
    t._headX = -1;
    drawHead(t);
  }
  function drawHead(t) {
    const wrap = t.canvas && t.canvas.closest('.studio-wave'); if (!wrap) return;
    const line = wrap.querySelector('.studio-head'); if (!line) return;
    const T = timelineLen();
    if (pos < 0 || pos > T) { line.style.display = 'none'; return; }
    const x = (pos / T) * wrap.clientWidth;                // shared timeline → heads align across rows
    line.style.display = ''; line.style.left = x.toFixed(1) + 'px';
  }
  const drawAllHeads = () => tracks.forEach(drawHead);
  // Position every clip on the shared timeline (left = offset, width = duration).
  function layoutClips() {
    const T = timelineLen();
    tracks.forEach(t => {
      const clip = t.canvas && t.canvas.parentElement; if (!clip || !t.buffer) return;
      clip.style.left = ((t.offset / T) * 100) + '%';
      clip.style.width = Math.max(0.5, (t.buffer.duration / T) * 100) + '%';
      drawWave(t);                                          // redraw at the clip's new pixel width
    });
  }

  // ---------- UI ----------
  const fmtTime = (s) => { const m = Math.floor(s / 60), ss = s - m * 60; return m + ':' + (ss < 10 ? '0' : '') + ss.toFixed(1); };
  function syncTimeUI() { const el = $('studio-time'); if (el) el.textContent = fmtTime(Math.max(0, pos)) + ' / ' + fmtTime(totalLen()); }
  function syncTransportUI() {
    const pb = $('studio-play'); if (pb) { pb.textContent = playing ? '■' : '▶'; pb.title = playing ? 'Stop (playhead stays)' : 'Play from the playhead'; }
    const rb = $('studio-rec'); if (rb) { rb.classList.toggle('recording', rec.on); rb.textContent = rec.on ? '■ 🎤' : '🎤'; rb.title = rec.on ? 'Finish the take' : 'Record a take from the playhead (other tracks play; you hear your input)'; }
    syncTimeUI();
  }
  function mixCtl(t, key, min, max, step, label, title) {
    return '<label class="studio-ctl" title="' + title + '">' + label +
      '<input type="range" data-k="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + t[key] + '"></label>';
  }
  function renderTracks() {
    const host = $('studio-tracks'); if (!host) return;
    host.innerHTML = tracks.length ? '' : '<div class="studio-empty">No tracks yet — press 🎤 to record the first take.</div>';
    tracks.forEach(t => {
      const row = document.createElement('div');
      row.className = 'studio-track'; row.dataset.id = t.id;
      row.innerHTML =
        '<div class="studio-track-side">' +
          '<div class="studio-track-head"><input class="studio-name" value="' + String(t.name).replace(/[<>&"]/g, '') + '" title="Track name">' +
            '<button type="button" class="studio-mini studio-mute' + (t.mute ? ' on' : '') + '" title="Mute">M</button>' +
            '<button type="button" class="studio-mini studio-solo' + (t.solo ? ' on' : '') + '" title="Solo">S</button>' +
            '<button type="button" class="studio-mini studio-del" title="Delete track">✕</button></div>' +
          '<div class="studio-mix">' +
            mixCtl(t, 'gain', 0, 1.4, 0.01, '🔊', 'Volume') +
            mixCtl(t, 'pan', -1, 1, 0.01, '◐', 'Pan') +
            mixCtl(t, 'eqLo', -18, 18, 0.5, 'LO', 'Low shelf (220 Hz, dB)') +
            mixCtl(t, 'eqHi', -18, 18, 0.5, 'HI', 'High shelf (3.2 kHz, dB)') +
            mixCtl(t, 'rev', 0, 1, 0.01, '⛲', 'Reverb send') +
            mixCtl(t, 'del', 0, 1, 0.01, '⧖', 'Delay send') +
          '</div>' +
        '</div>' +
        '<div class="studio-wave"><div class="studio-clip" title="Drag to move this take on the timeline"><canvas></canvas></div><div class="studio-head"></div></div>';
      host.appendChild(row);
      t.canvas = row.querySelector('canvas');
    });
    layoutClips();
    syncTimeUI();
  }
  function wireHost() {
    const host = $('studio-tracks'); if (!host || host._wired) return; host._wired = true;
    host.addEventListener('input', (e) => {
      const row = e.target.closest('.studio-track'); if (!row) return;
      const t = tracks.find(x => x.id === row.dataset.id); if (!t) return;
      if (e.target.classList.contains('studio-name')) { t.name = e.target.value.slice(0, 40); saveMeta(); return; }
      const k = e.target.dataset.k; if (!k) return;
      t[k] = parseFloat(e.target.value);
      ensureNodes(t); applyMix(t); saveMeta();
    });
    host.addEventListener('click', async (e) => {
      const row = e.target.closest('.studio-track'); if (!row) return;
      const t = tracks.find(x => x.id === row.dataset.id); if (!t) return;
      if (e.target.classList.contains('studio-mute')) { t.mute = !t.mute; e.target.classList.toggle('on', t.mute); applyAllMix(); saveMeta(); return; }
      if (e.target.classList.contains('studio-solo')) { t.solo = !t.solo; e.target.classList.toggle('on', t.solo); applyAllMix(); saveMeta(); return; }
      if (e.target.classList.contains('studio-del')) {
        if (!confirm('Delete “' + t.name + '”? The take is removed for good.')) return;
        const wasPlaying = playing; if (playing) stop();
        tracks = tracks.filter(x => x !== t);
        try { Object.values(t.nodes || {}).forEach(n => n.disconnect()); } catch (e2) {}
        await dbDel(t.id); saveMeta(); renderTracks();
        if (wasPlaying) play();
        return;
      }
      const wave = e.target.closest('.studio-wave');
      if (wave && t.buffer) {
        if (host._clipDragged) { host._clipDragged = false; return; }   // a drag isn't a seek
        const r = wave.getBoundingClientRect();
        seek(((e.clientX - r.left) / r.width) * timelineLen());
      }
    });
    // Drag a clip horizontally to move its take on the timeline (a plain click
    // still falls through to seek). Pointer-captured → works for touch too.
    host.addEventListener('pointerdown', (e) => {
      const clip = e.target.closest('.studio-clip'); if (!clip) return;
      const row = e.target.closest('.studio-track'); if (!row) return;
      const t = tracks.find(x => x.id === row.dataset.id); if (!t || !t.buffer) return;
      const wave = clip.closest('.studio-wave');
      const T = timelineLen();                            // frozen during the drag
      const secPerPx = T / Math.max(1, wave.clientWidth);
      const st = { x0: e.clientX, off0: t.offset, moved: false };
      const move = (ev) => {
        const dx = ev.clientX - st.x0;
        if (!st.moved && Math.abs(dx) < 6) return;        // click tolerance
        st.moved = true;
        t.offset = Math.max(0, st.off0 + dx * secPerPx);
        clip.style.left = ((t.offset / T) * 100) + '%';
        drawHead(t);
      };
      const up = () => {
        clip.removeEventListener('pointermove', move);
        clip.removeEventListener('pointerup', up);
        clip.removeEventListener('pointercancel', up);
        if (!st.moved) return;                            // plain click → seek handler runs
        host._clipDragged = true; setTimeout(() => { host._clipDragged = false; }, 350);
        saveMeta(); layoutClips(); drawAllHeads(); syncTimeUI();
        if (playing) {                                    // re-schedule sources at the new offset
          const p = pos; playing = false; stopSources(); cancelAnimationFrame(raf);
          pos = p; play();
        }
      };
      try { clip.setPointerCapture(e.pointerId); } catch (e2) {}
      clip.addEventListener('pointermove', move);
      clip.addEventListener('pointerup', up);
      clip.addEventListener('pointercancel', up);
    });
  }
  async function fillInputs() {
    const sel = $('studio-input'); if (!sel) return;
    try {
      let devs = await navigator.mediaDevices.enumerateDevices();
      let ins = devs.filter(d => d.kind === 'audioinput');
      if (ins.length && ins.every(d => !d.label)) {
        try { const s0 = await navigator.mediaDevices.getUserMedia({ audio: true }); s0.getTracks().forEach(t => t.stop()); } catch (e) {}
        devs = await navigator.mediaDevices.enumerateDevices(); ins = devs.filter(d => d.kind === 'audioinput');
      }
      let saved = ''; try { saved = localStorage.getItem(LS_INPUT) || ''; } catch (e) {}
      sel.innerHTML = '<option value="">Default input</option>' + ins.filter(d => d.deviceId && d.deviceId !== 'default')
        .map((d, i) => '<option value="' + d.deviceId + '">' + (d.label || ('Input ' + (i + 1))).replace(/[<>&]/g, '') + '</option>').join('');
      if (saved && Array.from(sel.options).some(o => o.value === saved)) sel.value = saved;
    } catch (e) {}
  }

  // ---------- export ----------
  async function renderMixdown() {
    const len = totalLen(); if (!(len > 0.05)) { toast('Nothing to export.'); return null; }
    const sr = 44100;
    const oc = new OfflineAudioContext(2, Math.ceil((len + 2.5) * sr), sr);   // +2.5s reverb/delay tail
    const m = oc.createGain(); m.gain.value = 0.9; m.connect(oc.destination);
    const conv = oc.createConvolver();
    { const irLen = Math.floor(sr * 2), ir = oc.createBuffer(2, irLen, sr);
      for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.6); }
      conv.buffer = ir; }
    const rBus = oc.createGain(); rBus.connect(conv); conv.connect(m);
    const dl = oc.createDelay(2); dl.delayTime.value = 0.35;
    const fb = oc.createGain(); fb.gain.value = 0.38; dl.connect(fb); fb.connect(dl);
    const dBus = oc.createGain(); dBus.connect(dl); dl.connect(m);
    tracks.forEach(t => {
      if (!t.buffer || !audible(t)) return;
      const lo = oc.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 220; lo.gain.value = t.eqLo;
      const hi = oc.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 3200; hi.gain.value = t.eqHi;
      const pan = oc.createStereoPanner(); pan.pan.value = t.pan;
      const g = oc.createGain(); g.gain.value = t.gain;
      lo.connect(hi); hi.connect(pan); pan.connect(g); g.connect(m);
      const rv = oc.createGain(); rv.gain.value = t.rev; g.connect(rv); rv.connect(rBus);
      const dg = oc.createGain(); dg.gain.value = t.del; g.connect(dg); dg.connect(dBus);
      const s = oc.createBufferSource(); s.buffer = t.buffer; s.connect(lo); s.start(t.offset);
    });
    const rendered = await oc.startRendering();
    return wavEncode(rendered);
  }
  const randomName = () => { const a = WORDS[Math.floor(Math.random() * WORDS.length)]; let b = a; while (b === a) b = WORDS[Math.floor(Math.random() * WORDS.length)]; return a + '-' + b; };
  // Send the mixdown to the HOME PAGE RADIO. Always a local download, never
  // Drive: the radio plays files that ship with the site, so the mix has to
  // reach the project directory and be deployed. `npm run radio` picks up the
  // `radio--` prefix, encodes it to AAC and installs it with a manifest entry.
  async function exportToRadio() {
    let name = null;
    try { name = prompt('Name this radio track:', randomName()); } catch (e) {}
    if (name == null) return;
    const slug = (String(name).trim() || randomName()).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mix';
    toast('Rendering mixdown…');
    let blob = null;
    try { blob = await renderMixdown(); } catch (e) { toast('Render failed: ' + (e && e.message)); return; }
    if (!blob) return;
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'radio--' + slug + '.wav';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 8000);
      toast('Saved radio--' + slug + '.wav — run `npm run radio` to add it to the site.');
    } catch (e) { toast('Download failed: ' + (e && e.message)); }
  }
  async function exportMixdown() {
    let name = null;
    try { name = prompt('Name this mixdown:', randomName()); } catch (e) {}
    if (name == null) return;
    name = (String(name).trim() || randomName()).replace(/[\\/:*?"<>|]/g, '-');
    toast('Rendering mixdown…');
    let blob = null;
    try { blob = await renderMixdown(); } catch (e) { toast('Render failed: ' + (e && e.message)); return; }
    if (!blob) return;
    // Drive: Tracks/YYYY/MM/DD/<name>.wav
    const d = new Date();
    const path = 'Tracks/' + d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
    const br = window._drvBridge;
    if (br && typeof br.ready === 'function' && br.ready()) {
      try {
        const folderId = await br.findOrCreateDriveFolder(path);
        await br.uploadWavToDrive(name + '.wav', blob, folderId);
        toast('Uploaded “' + name + '.wav” → Drive/' + path);
        return;
      } catch (e) { toast('Drive upload failed (' + (e && e.message) + ') — downloading instead.'); }
    } else toast('Not signed in to Drive — downloading locally instead.');
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name + '.wav';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
    } catch (e) {}
  }

  // ---------- boot ----------
  async function loadPersisted() {
    let meta = []; try { meta = JSON.parse(localStorage.getItem(LS_META) || '[]'); } catch (e) {}
    if (!Array.isArray(meta) || !meta.length) return;
    const c = acx();
    for (const m of meta) {
      const blob = await dbGet(m.id);
      if (!blob) continue;
      let buf = null;
      try { buf = await c.decodeAudioData(await blob.arrayBuffer()); } catch (e) { continue; }
      tracks.push(Object.assign({ gain: 0.9, pan: 0, mute: false, solo: false, eqLo: 0, eqHi: 0, rev: 0, del: 0 }, m, { buffer: buf, nodes: null, canvas: null }));
    }
  }
  function wireTop() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('studio-play', () => { playing ? stop() : play(); });
    on('studio-rec', startRecord);
    on('studio-skip-start', () => seek(0));
    on('studio-skip-end', () => seek(totalLen()));
    on('studio-rew', () => seek(Math.max(0, pos - 5)));
    on('studio-ff', () => seek(pos + 5));
    on('studio-export', exportMixdown);
    on('studio-radio', exportToRadio);
    const sel = $('studio-input');
    if (sel) sel.addEventListener('change', () => { try { localStorage.setItem(LS_INPUT, sel.value); } catch (e) {} });
  }
  async function init() {
    if (inited) { renderTracks(); syncTransportUI(); return; }
    inited = true;
    wireTop(); wireHost();
    fillInputs();
    await loadPersisted();
    renderTracks();
    syncTransportUI();
  }
  window._studioShow = () => { init().catch(() => {}); };
  window._studioHide = () => { if (rec.on) stop(); else if (playing) stop(); };
  // test hooks (headless verification)
  window._studio = { get tracks() { return tracks; }, get pos() { return pos; }, get playing() { return playing; }, seek, play, stop, exportMixdown, exportToRadio, renderMixdown, randomName };
})();
