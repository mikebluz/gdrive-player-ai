    // ============================================================
    // 22-midi.js — Web MIDI integration (device hub, input, output)
    // ============================================================
    // Layer 1 of "full MIDI integration": a single hub that owns the Web MIDI
    // access object, enumerates input + output devices (with hot-plug), persists
    // settings, routes incoming messages, and exposes output send helpers.
    //
    // Input note routing REUSES the proven grid handlers already in 08-grid-modes
    // (_midiHandleNoteOn / _midiHandleNoteOff). To avoid binding the same device
    // twice, this module flips the shared `_midiBound` flag so 08's self-binder
    // (bindWebMidi) short-circuits — this hub becomes the single owner.
    //
    // Adds over 08: a control panel (device on/off, output + channel, thru),
    // sustain pedal (CC64) hold, pitch-bend + CC capture, and output send
    // helpers (note on/off, CC, pitch bend, clock) used by later layers
    // (scheduler output, CC mapping). File import/export + CC-learn are separate.

    const MidiHub = {
      supported: (typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess),
      access: null,
      inputs: [],          // [{ id, name, port }]
      outputs: [],         // [{ id, name, port }]
      bound: false,
      settings: {
        enabled: true,           // master on/off for MIDI input routing
        disabledInputs: {},      // { [deviceId]: true } — per-device input mute
        outputId: '',            // selected output device id ('' = none)
        outputChannel: 1,        // 1..16
        thru: false,             // echo incoming messages to the selected output
        pitchBendRange: 2,       // semitones (for future input bend application)
        outputNotes: false,      // send sequencer step notes to the output
        outputClock: false,      // send MIDI clock (24ppq) + Start/Stop
        perLaneChannels: false,  // lane i → channel i+1 (else all on outputChannel)
      },
      // Live input state.
      _sustainHeld: false,
      _heldForSustain: new Set(),
      _lastBend: 0,              // -8192..8191
    };
    const _MIDI_LS_KEY = 'bloops-midi';
    // Claim ownership at load time so 08-grid-modes' self-binder (bindWebMidi)
    // short-circuits on `if (_midiBound) return` — this hub is the single device
    // owner. (08's _midiHandleNoteOn/Off note routing is still reused below.)
    try { if (typeof _midiBound !== 'undefined') _midiBound = true; } catch (e) {}

    function _midiLoadSettings() {
      try {
        const raw = localStorage.getItem(_MIDI_LS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s && typeof s === 'object') {
          const d = MidiHub.settings;
          if (typeof s.enabled === 'boolean') d.enabled = s.enabled;
          if (s.disabledInputs && typeof s.disabledInputs === 'object') d.disabledInputs = s.disabledInputs;
          if (typeof s.outputId === 'string') d.outputId = s.outputId;
          if (Number.isFinite(s.outputChannel)) d.outputChannel = Math.max(1, Math.min(16, s.outputChannel | 0));
          if (typeof s.thru === 'boolean') d.thru = s.thru;
          if (Number.isFinite(s.pitchBendRange)) d.pitchBendRange = Math.max(1, Math.min(24, s.pitchBendRange | 0));
          if (typeof s.outputNotes === 'boolean') d.outputNotes = s.outputNotes;
          if (typeof s.outputClock === 'boolean') d.outputClock = s.outputClock;
          if (typeof s.perLaneChannels === 'boolean') d.perLaneChannels = s.perLaneChannels;
        }
      } catch (e) {}
    }
    function _midiSaveSettings() {
      try { localStorage.setItem(_MIDI_LS_KEY, JSON.stringify(MidiHub.settings)); } catch (e) {}
    }

    // ---- Note ↔ frequency (equal temperament, honors the app's A4) ----------
    function _midiNoteToFreq(midi) {
      const A = (typeof masterFreqA === 'number' && masterFreqA > 0) ? masterFreqA : 440;
      return A * Math.pow(2, (midi - 69) / 12);
    }
    function _midiFreqToNote(freq) {
      if (!Number.isFinite(freq) || freq <= 0) return null;
      const A = (typeof masterFreqA === 'number' && masterFreqA > 0) ? masterFreqA : 440;
      return Math.max(0, Math.min(127, Math.round(12 * Math.log2(freq / A) + 69)));
    }

    // ---- Output send helpers (used live by Thru + Test, and by later layers) -
    function _midiSelectedOutput() {
      const id = MidiHub.settings.outputId;
      if (!id) return null;
      const o = MidiHub.outputs.find(x => x.id === id);
      return o ? o.port : null;
    }
    function _midiChan() { return Math.max(1, Math.min(16, MidiHub.settings.outputChannel | 0)) - 1; }
    function midiSendNoteOn(note, velocity, channel, when) {
      const out = _midiSelectedOutput(); if (!out) return;
      const ch = (channel == null ? _midiChan() : (channel & 0x0f));
      try { out.send([0x90 | ch, note & 0x7f, Math.max(1, Math.min(127, velocity | 0))], when); } catch (e) {}
    }
    function midiSendNoteOff(note, channel, when) {
      const out = _midiSelectedOutput(); if (!out) return;
      const ch = (channel == null ? _midiChan() : (channel & 0x0f));
      try { out.send([0x80 | ch, note & 0x7f, 0], when); } catch (e) {}
    }
    function midiSendCC(cc, value, channel) {
      const out = _midiSelectedOutput(); if (!out) return;
      const ch = (channel == null ? _midiChan() : (channel & 0x0f));
      try { out.send([0xb0 | ch, cc & 0x7f, value & 0x7f]); } catch (e) {}
    }
    function midiSendPitchBend(bend14, channel) {
      const out = _midiSelectedOutput(); if (!out) return;
      const ch = (channel == null ? _midiChan() : (channel & 0x0f));
      const v = Math.max(0, Math.min(16383, (bend14 | 0) + 8192));
      try { out.send([0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f]); } catch (e) {}
    }
    // Transport clock helpers (24 pulses/quarter). Used by the output layer.
    function midiSendClock() { const o = _midiSelectedOutput(); if (o) { try { o.send([0xf8]); } catch (e) {} } }
    function midiSendStart() { const o = _midiSelectedOutput(); if (o) { try { o.send([0xfa]); } catch (e) {} } }
    function midiSendStop()  { const o = _midiSelectedOutput(); if (o) { try { o.send([0xfc]); } catch (e) {} } }
    // Send a freq-based note for a fixed duration (for output-by-frequency).
    function midiSendFreqNote(freq, velocity, durationMs, channel) {
      const n = _midiFreqToNote(freq); if (n == null) return;
      midiSendNoteOn(n, velocity == null ? 100 : velocity, channel);
      const out = _midiSelectedOutput();
      const ch = (channel == null ? _midiChan() : (channel & 0x0f));
      const dur = Math.max(20, durationMs | 0);
      setTimeout(() => { try { if (out) out.send([0x80 | ch, n & 0x7f, 0]); } catch (e) {} }, dur);
    }

    // ---- Sequencer output: step notes + transport clock ---------------------
    // Convert a Tone audio time to the DOMHighResTimeStamp domain MIDI send()
    // expects, so scheduled output notes line up with the audio. Falls back to
    // "now" if the context can't provide a mapping.
    function _midiWhenFromAudio(at) {
      try {
        const ctx = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : null;
        if (ctx && typeof ctx.getOutputTimestamp === 'function') {
          const ts = ctx.getOutputTimestamp();
          if (ts && ts.contextTime != null && ts.performanceTime != null) return ts.performanceTime + (at - ts.contextTime) * 1000;
        }
        if (ctx && Number.isFinite(at)) return performance.now() + (at - ctx.currentTime) * 1000;
      } catch (e) {}
      return performance.now();
    }
    function _midiLaneChannel(laneIdx) {
      if (MidiHub.settings.perLaneChannels && Number.isFinite(laneIdx)) return laneIdx % 16;
      return _midiChan();
    }
    // Emit one sequencer step voice to the MIDI output. Cheap no-op (one boolean
    // check) when output notes are off — so it never taxes the audio path unless
    // the user has opted into MIDI output.
    function midiEmitNote(freq, params, durMs, audioTime, laneIdx) {
      if (!MidiHub.settings.outputNotes) return;
      const out = _midiSelectedOutput(); if (!out) return;
      const note = _midiFreqToNote(freq); if (note == null) return;
      const vol = (params && Number.isFinite(params.volume)) ? params.volume : 100;
      const vel = Math.max(1, Math.min(127, Math.round(vol / 100 * 127)));
      const ch = _midiLaneChannel(laneIdx);
      const when = _midiWhenFromAudio(audioTime);
      try { out.send([0x90 | ch, note & 0x7f, vel], when); } catch (e) {}
      try { out.send([0x80 | ch, note & 0x7f, 0], when + Math.max(20, durMs | 0)); } catch (e) {}
    }
    function midiAllNotesOff() {
      const out = _midiSelectedOutput(); if (!out) return;
      for (let ch = 0; ch < 16; ch++) { try { out.send([0xb0 | ch, 123, 0]); } catch (e) {} } // CC123
    }
    // Lookahead MIDI clock: every 25 ms, schedule 24-ppq pulses up to ~120 ms
    // ahead with timestamps (tight sync, low jitter), reading the live tempo.
    let _midiClockTimer = 0, _midiClockNext = 0;
    function _midiClockStop() { if (_midiClockTimer) { clearInterval(_midiClockTimer); _midiClockTimer = 0; } }
    function _midiClockStart() {
      _midiClockStop();
      _midiClockNext = performance.now();
      _midiClockTimer = setInterval(() => {
        const out = _midiSelectedOutput(); if (!out) { _midiClockStop(); return; }
        const bpm = (typeof tempoInput !== 'undefined' && tempoInput) ? (parseInt(tempoInput.value, 10) || 120) : 120;
        const pulseMs = (60000 / bpm) / 24;
        const horizon = performance.now() + 120;
        if (_midiClockNext < performance.now() - 200) _midiClockNext = performance.now(); // recover from a backgrounded tab
        let guard = 0;
        while (_midiClockNext < horizon && guard++ < 64) {
          try { out.send([0xf8], _midiClockNext); } catch (e) {}
          _midiClockNext += pulseMs;
        }
      }, 25);
    }
    // Called by the transport (playSequence / stopSequence) — see 07/08.
    function midiTransportStart() {
      if (!MidiHub.settings.outputClock) return;
      const out = _midiSelectedOutput(); if (!out) return;
      midiSendStart();
      _midiClockStart();
    }
    function midiTransportStop() {
      _midiClockStop();
      const out = _midiSelectedOutput(); if (!out) return;
      if (MidiHub.settings.outputClock) midiSendStop();
      if (MidiHub.settings.outputNotes) midiAllNotesOff();   // kill any ringing output notes
    }

    // ---- Incoming message routing -------------------------------------------
    function _midiThruEcho(data) {
      const out = _midiSelectedOutput(); if (!out) return;
      // Rewrite the channel nibble to the configured output channel so thru
      // lands where the user expects, then forward verbatim.
      try {
        const status = data[0];
        if (status >= 0x80 && status < 0xf0) out.send([(status & 0xf0) | _midiChan(), data[1] || 0, data[2] || 0]);
        else out.send(Array.from(data));
      } catch (e) {}
    }
    function _midiInNoteOn(midi, vel) {
      // A fresh strike on a note clears any pending sustain hold for it.
      MidiHub._heldForSustain.delete(midi);
      try { if (typeof _midiHandleNoteOn === 'function') _midiHandleNoteOn(midi, vel); } catch (e) {}
    }
    function _midiInNoteOff(midi) {
      if (MidiHub._sustainHeld) { MidiHub._heldForSustain.add(midi); return; } // hold until pedal up
      try { if (typeof _midiHandleNoteOff === 'function') _midiHandleNoteOff(midi); } catch (e) {}
    }
    function _midiSustainPedal(down) {
      MidiHub._sustainHeld = !!down;
      if (!down) {
        MidiHub._heldForSustain.forEach(m => { try { if (typeof _midiHandleNoteOff === 'function') _midiHandleNoteOff(m); } catch (e) {} });
        MidiHub._heldForSustain.clear();
      }
    }
    function _midiRouteMessage(e) {
      if (!MidiHub.settings.enabled) return;
      if (!e || !e.data || e.data.length < 1) return;
      const data = e.data, status = data[0], d1 = data[1] || 0, d2 = data[2] || 0, cmd = status & 0xf0;
      // Best-effort warm the audio context (the gesture that enabled MIDI is the
      // real unlock; this is a no-op when already running).
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e2) {}
      if (cmd === 0x90 && d2 > 0) _midiInNoteOn(d1, d2);
      else if (cmd === 0x80 || cmd === 0x90) _midiInNoteOff(d1);
      else if (cmd === 0xb0 && d1 === 64) _midiSustainPedal(d2 >= 64);              // CC64 sustain
      else if (cmd === 0xb0) { try { if (typeof _midiOnCC === 'function') _midiOnCC(d1, d2); } catch (e3) {} } // future CC-learn
      else if (cmd === 0xe0) MidiHub._lastBend = ((d2 << 7) | d1) - 8192;           // pitch bend captured
      if (MidiHub.settings.thru) _midiThruEcho(data);
    }

    // ---- Device enumeration + binding ---------------------------------------
    function _midiRefreshDevices() {
      if (!MidiHub.access) return;
      MidiHub.inputs = [];
      MidiHub.outputs = [];
      MidiHub.access.inputs.forEach(p => MidiHub.inputs.push({ id: p.id, name: (p.name || p.manufacturer || p.id), port: p }));
      MidiHub.access.outputs.forEach(p => MidiHub.outputs.push({ id: p.id, name: (p.name || p.manufacturer || p.id), port: p }));
      _midiWireInputs();
      _midiRenderPanel();
    }
    function _midiWireInputs() {
      MidiHub.inputs.forEach(({ id, port }) => {
        const muted = !!MidiHub.settings.disabledInputs[id];
        port.onmidimessage = muted ? null : _midiRouteMessage;
      });
    }
    function midiEnsureAccess() {
      if (!MidiHub.supported) return Promise.reject(new Error('Web MIDI not supported'));
      if (MidiHub.access) return Promise.resolve(MidiHub.access);
      // Claim ownership so 08's self-binder (bindWebMidi) short-circuits and we
      // don't get two onmidimessage handlers double-triggering notes.
      try { if (typeof _midiBound !== 'undefined') _midiBound = true; } catch (e) {}
      return navigator.requestMIDIAccess({ sysex: false }).then(access => {
        MidiHub.access = access;
        MidiHub.bound = true;
        access.onstatechange = () => { _midiRefreshDevices(); };
        _midiRefreshDevices();
        return access;
      });
    }

    // ---- Control panel UI ----------------------------------------------------
    function _midiPanelEl() { return document.getElementById('midi-panel'); }
    function openMidiPanel() {
      const overlay = document.getElementById('midi-overlay');
      if (!overlay) return;
      overlay.hidden = false;
      // Requesting access here happens inside the click gesture, so the
      // permission prompt (if any) is user-initiated.
      if (MidiHub.supported) {
        midiEnsureAccess().then(() => _midiRenderPanel()).catch(() => _midiRenderPanel());
      }
      _midiRenderPanel();
    }
    function closeMidiPanel() {
      const overlay = document.getElementById('midi-overlay');
      if (overlay) overlay.hidden = true;
    }
    function _midiRenderPanel() {
      const panel = _midiPanelEl(); if (!panel) return;
      const s = MidiHub.settings;
      if (!MidiHub.supported) {
        panel.innerHTML = '<div class="midi-note">Web MIDI isn’t supported in this browser. Try Chrome, Edge, or Safari 16.4+.</div>';
        return;
      }
      const inputsHtml = MidiHub.inputs.length
        ? MidiHub.inputs.map(d =>
            '<label class="midi-row"><input type="checkbox" data-midi-input="' + d.id + '"' +
            (s.disabledInputs[d.id] ? '' : ' checked') + '><span>' + _midiEsc(d.name) + '</span></label>').join('')
        : '<div class="midi-empty">No MIDI inputs detected — connect a controller.</div>';
      const outOpts = '<option value="">— none —</option>' + MidiHub.outputs.map(d =>
        '<option value="' + _midiEsc(d.id) + '"' + (d.id === s.outputId ? ' selected' : '') + '>' + _midiEsc(d.name) + '</option>').join('');
      const chanOpts = Array.from({ length: 16 }, (_, i) =>
        '<option value="' + (i + 1) + '"' + ((i + 1) === s.outputChannel ? ' selected' : '') + '>' + (i + 1) + '</option>').join('');
      panel.innerHTML =
        '<label class="midi-row midi-master"><input type="checkbox" id="midi-enabled"' + (s.enabled ? ' checked' : '') + '><span><b>MIDI input enabled</b></span></label>' +
        '<div class="midi-section"><div class="midi-section-title">Inputs</div>' + inputsHtml + '</div>' +
        '<div class="midi-section"><div class="midi-section-title">Output</div>' +
          '<div class="midi-row"><span class="midi-lbl">Device</span><select id="midi-output">' + outOpts + '</select></div>' +
          '<div class="midi-row"><span class="midi-lbl">Channel</span><select id="midi-output-chan">' + chanOpts + '</select></div>' +
          '<label class="midi-row"><input type="checkbox" id="midi-out-notes"' + (s.outputNotes ? ' checked' : '') + '><span>Send sequencer notes</span></label>' +
          '<label class="midi-row"><input type="checkbox" id="midi-out-perlane"' + (s.perLaneChannels ? ' checked' : '') + '><span>Per-lane channels (lane → ch)</span></label>' +
          '<label class="midi-row"><input type="checkbox" id="midi-out-clock"' + (s.outputClock ? ' checked' : '') + '><span>Send MIDI clock + Start/Stop</span></label>' +
          '<label class="midi-row"><input type="checkbox" id="midi-thru"' + (s.thru ? ' checked' : '') + '><span>MIDI Thru (echo input to output)</span></label>' +
          '<button type="button" class="midi-btn" id="midi-test">Send test note</button>' +
        '</div>' +
        '<div class="midi-note">Input plays the current sound at the played pitch (and records into the sequence when Keep/Perform is on). Sustain pedal (CC64) holds notes.</div>';
      _midiWirePanel();
    }
    function _midiEsc(str) { return String(str == null ? '' : str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    function _midiWirePanel() {
      const panel = _midiPanelEl(); if (!panel) return;
      const en = panel.querySelector('#midi-enabled');
      if (en) en.addEventListener('change', () => { MidiHub.settings.enabled = en.checked; _midiSaveSettings(); });
      panel.querySelectorAll('[data-midi-input]').forEach(cb => {
        cb.addEventListener('change', () => {
          const id = cb.getAttribute('data-midi-input');
          if (cb.checked) delete MidiHub.settings.disabledInputs[id];
          else MidiHub.settings.disabledInputs[id] = true;
          _midiWireInputs(); _midiSaveSettings();
        });
      });
      const outSel = panel.querySelector('#midi-output');
      if (outSel) outSel.addEventListener('change', () => { MidiHub.settings.outputId = outSel.value || ''; _midiSaveSettings(); });
      const chanSel = panel.querySelector('#midi-output-chan');
      if (chanSel) chanSel.addEventListener('change', () => { MidiHub.settings.outputChannel = parseInt(chanSel.value, 10) || 1; _midiSaveSettings(); });
      const thru = panel.querySelector('#midi-thru');
      if (thru) thru.addEventListener('change', () => { MidiHub.settings.thru = thru.checked; _midiSaveSettings(); });
      const outNotes = panel.querySelector('#midi-out-notes');
      if (outNotes) outNotes.addEventListener('change', () => { MidiHub.settings.outputNotes = outNotes.checked; _midiSaveSettings(); });
      const outPerLane = panel.querySelector('#midi-out-perlane');
      if (outPerLane) outPerLane.addEventListener('change', () => { MidiHub.settings.perLaneChannels = outPerLane.checked; _midiSaveSettings(); });
      const outClock = panel.querySelector('#midi-out-clock');
      if (outClock) outClock.addEventListener('change', () => {
        MidiHub.settings.outputClock = outClock.checked; _midiSaveSettings();
        // If toggled on/off mid-playback, start/stop the clock to match.
        if (!outClock.checked) { try { midiTransportStop(); } catch (e) {} }
      });
      const test = panel.querySelector('#midi-test');
      if (test) test.addEventListener('click', () => { midiSendNoteOn(60, 100); setTimeout(() => midiSendNoteOff(60), 300); });
    }

    function _midiInit() {
      _midiLoadSettings();
      const launch = document.getElementById('midi-launch-btn');
      if (launch) launch.addEventListener('click', openMidiPanel);
      const overlay = document.getElementById('midi-overlay');
      if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMidiPanel(); });
      const closeBtn = document.getElementById('midi-close-btn');
      if (closeBtn) closeBtn.addEventListener('click', closeMidiPanel);
      // Eagerly claim MIDI ownership + bind on the first user gesture, so a
      // controller works immediately without opening the panel (mirrors 08's
      // old behavior, now centralized here).
      if (MidiHub.supported && MidiHub.settings.enabled) {
        const once = () => {
          midiEnsureAccess().catch(() => {});
          document.removeEventListener('pointerdown', once);
          document.removeEventListener('keydown', once);
        };
        document.addEventListener('pointerdown', once, { once: true });
        document.addEventListener('keydown', once, { once: true });
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _midiInit);
    else _midiInit();
