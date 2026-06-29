    // ---- Custom sample loading (samples/manifest.json) ----
    // Each entry creates a Tone.Sampler that pitch-shifts the file across
    // the keyboard. type strings of the form 'sample:<id>' route through these.
    const sampleSamplers = new Map();

    // A cached, reversed copy of an AudioBuffer (for the Bloom sample "Reverse" toggle).
    // Web Audio can't play a buffer backwards, so we mirror the samples once per buffer.
    const _ambRevBufCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
    function _reverseAudioBuf(buf) {
      if (!buf) return buf;
      if (_ambRevBufCache) { const c = _ambRevBufCache.get(buf); if (c) return c; }
      try {
        const ac = (typeof Tone !== 'undefined') ? Tone.getContext().rawContext : null; if (!ac) return buf;
        const out = ac.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const s = buf.getChannelData(ch), d = out.getChannelData(ch);
          for (let i = 0, n = buf.length; i < n; i++) d[i] = s[n - 1 - i];
        }
        if (_ambRevBufCache) _ambRevBufCache.set(buf, out);
        return out;
      } catch (e) { return buf; }
    }

    // For drum-kit samples, snap any incoming pitch to the C2 row so each
    // pitch class triggers its native drum hit instead of pitch-shifting a
    // single sample across the keyboard. The kits' urls map covers C2-B2;
    // playing the snapped freq tells Tone.Sampler to use that exact mapped
    // file with no pitch shift.
    function snapDrumKitFreq(type, freq) {
      if (typeof freq !== 'number' || !isSampleType(type)) return freq;
      const meta = sampleSamplers.get(type.slice(7));
      if (!meta || !meta.drumKit) return freq;
      try {
        const midi = Math.round(Tone.Frequency(freq).toMidi());
        const pc = ((midi % 12) + 12) % 12;
        return Tone.Frequency(36 + pc, 'midi').toFrequency(); // 36 = C2
      } catch (e) {
        return freq;
      }
    }

    function isSampleType(type) {
      return typeof type === 'string' && type.startsWith('sample:');
    }

    // ---- Ensembles: user-built multi-tone voices ----
    // An ensemble is a composite voice referenced by the value 'ensemble:<id>'.
    // It appears everywhere a tone is picked (via getAllSoundOptions) and is
    // expanded at playNote time into its member tones. Shape of a def:
    //   { id, name, mode: 'stack'|'stackOffset'|'rr', members: [member] }
    //   member: { type, octave, detune, pan, level, attack, decay, sustain, release }
    //     type   = a real voice value ('sine', 'sample:piano', …) — never an ensemble
    //     octave/detune/pan/level honored in 'stackOffset' and 'rr' modes
    //     attack/decay/sustain/release = optional per-member ADSR overrides (ms / %)
    const ensembles = new Map();   // id -> def (runtime registry; persisted in the workspace snapshot)
    const _ensembleRR = {};        // id -> next member index (round-robin cursor; runtime only)
    function isEnsembleType(type) { return typeof type === 'string' && type.startsWith('ensemble:'); }
    function getEnsemble(id) { return ensembles.get(String(id)) || null; }
    // Power-preserving makeup for per-voice panning. The non-panned path sends
    // a mono voice to BOTH channels (acoustic power ∝ 2), but Tone.Panner
    // (equal-power) puts power ∝ 1 at EVERY pan angle (−3 dB) — center: 0.707
    // both; hard: 1.0 one side. So toggling pan/spread on (e.g. Bloom's Spread)
    // drops the level vs the no-panner baseline by a flat 3 dB regardless of
    // angle. A constant ×√2 makeup restores power parity at every pan position
    // so the level is the same with or without spread. (panNorm kept for the
    // call signature.)
    function _panMakeup(panNorm) { return Math.SQRT2; }
    // Expand an ensemble note into its member triggers. Each member flows
    // through playNote so it picks up the normal voice/FX/capture plumbing.
    function _playEnsemble(freq, params, durationMs, startTime, destination, trackIdx, laneIdx) {
      const id = params.type.slice(9); // 'ensemble:'.length === 9
      const def = ensembles.get(id);
      if (!def || !Array.isArray(def.members) || !def.members.length) {
        // Unknown / empty ensemble — stay audible with a plain sine.
        const p = { ...params, type: 'sine' };
        playNote(freq, p, durationMs, startTime, destination, trackIdx, laneIdx);
        return;
      }
      const mode = def.mode || 'stack';
      let members = def.members;
      // Default: honor the ensemble's own mode. Caller overrides (Bloom Seq
      // lock/unlock) force the behavior and ALWAYS keep per-member offsets so
      // stacked voices stay distinct (octave/detune/pan/level) instead of
      // piling on the same pitch and masking each other.
      let useOffsets = (mode !== 'stack');
      if (Number.isFinite(params._ensembleMemberIdx)) {
        const i = ((params._ensembleMemberIdx % members.length) + members.length) % members.length;
        members = [members[i]]; useOffsets = true;       // unlocked: one member per note, keep its offset
      } else if (params._ensembleForceStack) {
        members = def.members; useOffsets = true;          // locked: ALL members together, each distinct
      } else if (mode === 'rr') {
        const i = (_ensembleRR[id] | 0) % members.length;
        _ensembleRR[id] = (i + 1) % members.length;
        members = [members[i]];
      }
      members.forEach(m => {
        if (!m || isEnsembleType(m.type)) return; // never nest ensembles
        const p = { ...params };
        delete p._ensembleForceStack; delete p._ensembleMemberIdx;
        p.type = m.type || 'sine';
        ['attack', 'decay', 'sustain', 'release'].forEach(k => { if (Number.isFinite(m[k])) p[k] = m[k]; });
        let f = freq;
        if (useOffsets) {
          if (Number.isFinite(m.octave) && m.octave) f = freq * Math.pow(2, m.octave);
          if (Number.isFinite(m.detune) && m.detune) p.detune = (p.detune || 0) + m.detune;
          if (Number.isFinite(m.pan)) p.pan = m.pan;
          if (Number.isFinite(m.level)) {
            const base = (p.volume != null ? p.volume : 100);
            p.volume = Math.max(0, Math.min(100, Math.round(base * (m.level / 100))));
          }
        }
        delete p._detuneMod; // a single LFO node can't fan out to multiple voices
        try { playNote(f, p, durationMs, startTime, destination, trackIdx, laneIdx); } catch (e) {}
      });
    }
    // A "sliceable" sample is a SINGLE-buffer one-shot (imported / recorded /
    // TEXT-frozen) — one recording mapped to one note, not a drum kit. The 100+
    // multi-sampled tuned instruments (piano/organ/GM) map many notes and are
    // NOT sliceable; they keep their normal pitched behavior. Used to gate the
    // slice-mode control, the sliced grid voice, and "Send to Bloom (as Sample)".
    function isSliceableSample(type) {
      const id = (typeof type === 'string' && type.startsWith('sample:')) ? type.slice(7) : type;
      const info = (typeof sampleSamplers !== 'undefined') ? sampleSamplers.get(id) : null;
      if (!info || info.drumKit) return false;
      if (info.imported) return true;
      try { return !!info.urls && Object.keys(info.urls).length === 1; } catch (e) { return false; }
    }
    // Lets the offline export route sample-based notes through a parallel
    // bank of samplers bound to the offline audio context. When set, this
    // takes precedence over the live sampleSamplers map. When null, normal
    // live playback resolves through the registered live samplers.
    let _offlineSamplerOverride = null;
    // Strong references to synth wrappers created during an offline
    // export render. Without these the wrappers fall out of scope
    // immediately after playNote returns; Tone.js' audio nodes
    // appear to lose their scheduled events when the wrapper is
    // GC'd mid-render, manifesting as a silent WAV. Filled by playNote
    // when _offlineSamplerOverride is set; cleared in the export's
    // finally block alongside _offlineSamplerOverride.
    let _offlineVoiceRefs = null;
    // Sample tones are recorded a good bit quieter than the synth voices, so
    // they feel weak next to a sawtooth/FM at the same volume. Lift every
    // sampler's output by a fixed dB so samples sit at roughly synth level.
    // Applied once per sampler (idempotent) at the trigger funnel below.
    // Velocity can't do this — it's clamped to 0..1 — so it has to be the
    // sampler's own volume in dB.
    //
    // Why this is large: a Tone.Synth oscillator (sine/saw/square/etc.)
    // outputs at essentially full-scale amplitude (0 dBFS peak), whereas
    // recorded instrument / soundfont samples are mastered with headroom
    // and peak well below that — typically -12 dBFS or lower, with much
    // lower RMS. +6 dB only doubled the amplitude, nowhere near enough to
    // match a raw oscillator. +12 dB (4×) lands samples in the same
    // perceived-loudness ballpark as the synths; the master compressor
    // (-6 dB / 4:1) and -1 dB limiter absorb any peaks the boost adds.
    const SAMPLE_VOLUME_BOOST_DB = 12;
    function _boostSampler(s) {
      try {
        if (s && s.volume && !s._bloopsBoosted) {
          s.volume.value = SAMPLE_VOLUME_BOOST_DB;
          s._bloopsBoosted = true;
        }
      } catch (e) {}
      return s;
    }

    // Per-buffer loudness trim. The tuned instruments' source samples are
    // recorded at very different levels, so a flat boost leaves some far
    // quieter than others (most audible in Bloom's Bed, where 1/N staging
    // lowers them further). Scan each buffer's peak ONCE (cached on the
    // sampleSamplers entry, per mapped note) and return a gain that brings
    // quiet buffers UP toward a reference peak — never attenuates, capped so a
    // near-silent buffer can't blow up. Equalizes sample loudness everywhere
    // (grid presses + Bloom), not just the Bed.
    function _sampleNormGain(info, midi, audioBuf) {
      try {
        if (!info || !audioBuf) return 1;
        if (!info._normByMidi) info._normByMidi = {};
        const cached = info._normByMidi[midi];
        if (Number.isFinite(cached)) return cached;
        const ch = audioBuf.getChannelData(0);
        // Subsample the peak scan (≤ ~3k reads) so this stays cheap even when
        // several Bloom layers each hit fresh buffers in the same scheduling
        // window — a full per-sample scan there caused choppiness. A strided
        // peak slightly underestimates, which only nudges the gain up (capped).
        const N = ch.length;
        const stride = Math.max(1, Math.floor(N / 3000));
        let peak = 0;
        for (let i = 0; i < N; i += stride) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > peak) peak = a; }
        const REF_PEAK = 0.5, MAX_EXTRA = 3; // only boost (≥1×), cap at +9.5 dB
        let g = (peak > 1e-4) ? (REF_PEAK / peak) : 1;
        g = Math.max(1, Math.min(MAX_EXTRA, g));
        info._normByMidi[midi] = g;
        return g;
      } catch (e) { return 1; }
    }

    // ---- Full-ADSR per-note sample voice -------------------------------
    // Tone.Sampler only fades its voices in (attack) and out (release) — it
    // has no decay or sustain-LEVEL, and no per-note filter. To give samples
    // the same sculpting synths get, build a fresh voice per note straight
    // from the buffer:  ToneBufferSource → [Filter] → AmplitudeEnvelope →
    // Gain(boost) → dest.  The buffer is borrowed from the (already-loaded)
    // shared/lane/track sampler's internal buffer set — the nearest mapped
    // note — so there's no extra network load; playbackRate handles the
    // pitch shift (and microtonal detune, since it's a raw freq ratio).
    //
    // Returns { source, ampEnv, outGain, filter } wired but NOT triggered —
    // the caller triggers (scheduled or held) and disposes. Returns null to
    // signal "fall back to the shared sampler's attack/release path": during
    // offline export (the offline render keeps the simple path), when the
    // buffers aren't reachable, or on any construction failure.
    function _buildSampleAdsrVoice(sampler, id, tunedFreq, env, dest, opts) {
      if (_offlineSamplerOverride) return null;
      if (!sampler || !sampler._buffers || typeof sampler._buffers.get !== 'function'
          || typeof sampler._buffers.has !== 'function') return null;
      const info = (typeof sampleSamplers !== 'undefined') ? sampleSamplers.get(id) : null;
      if (!info || !info.urls) return null;
      // Nearest mapped MIDI that actually has a loaded buffer.
      let sampleMidi = null;
      try {
        const targetMidi = Math.round(Tone.Frequency(tunedFreq).toMidi());
        let bestD = Infinity;
        for (const noteName of Object.keys(info.urls)) {
          let m; try { m = Math.round(Tone.Frequency(noteName).toMidi()); } catch (e) { continue; }
          if (!sampler._buffers.has(m)) continue;
          const d = Math.abs(m - targetMidi);
          if (d < bestD) { bestD = d; sampleMidi = m; }
        }
      } catch (e) { return null; }
      if (sampleMidi == null) return null;
      let audioBuf;
      try {
        const tb = sampler._buffers.get(sampleMidi);
        audioBuf = (tb && typeof tb.get === 'function') ? tb.get() : null;
      } catch (e) { return null; }
      if (!audioBuf) return null;
      let sampleFreq;
      try { sampleFreq = Tone.Frequency(sampleMidi, 'midi').toFrequency(); } catch (e) { return null; }
      let playbackRate = (sampleFreq > 0 && tunedFreq > 0) ? tunedFreq / sampleFreq : 1;
      // Baked-in fine tune (cents) from sample capture — pulls the buffer into
      // tune relative to its mapped root so the keyboard tracks chromatically.
      if (info && Number.isFinite(info.tuneCents) && info.tuneCents) playbackRate *= Math.pow(2, -info.tuneCents / 1200);
      let source = null, ampEnv = null, outGain = null, filter = null, panNode = null, panMakeupNode = null, detuneScale = null, _padLoop = false, _loopBuf = null;
      try {
        const boost = Math.pow(10, SAMPLE_VOLUME_BOOST_DB / 20);
        // Per-note pan: place the voice in the stereo field (e.g. Bloom's
        // Space spread). The synth path has its own panner; samples skipped
        // it until now. Sits between outGain and the destination so it pans
        // the boosted, enveloped signal.
        const panNorm = (opts && Number.isFinite(opts.pan)) ? Math.max(-1, Math.min(1, opts.pan / 100)) : 0;
        let outTail = dest;
        if (Math.abs(panNorm) > 0.001) {
          // Makeup gain so panning doesn't drop level (equal-power compensation).
          const mk = _panMakeup(panNorm);
          let pdest = dest;
          if (mk > 1.001) { panMakeupNode = new Tone.Gain(mk).connect(dest); pdest = panMakeupNode; }
          panNode = new Tone.Panner(panNorm).connect(pdest);
          outTail = panNode;
        }
        outGain = new Tone.Gain(boost * _sampleNormGain(info, sampleMidi, audioBuf)).connect(outTail);
        // Slicing plays a mid-buffer window, so the cut edges can click — floor
        // the attack/release a touch on the slice path to fade them (the
        // non-slice path keeps its exact prior values).
        const _slicing = !!(opts && (Number.isFinite(opts.sliceDurSec) || (Number.isFinite(opts.sampleOffsetSec) && opts.sampleOffsetSec > 0)));
        // Honor the voice's full ADSR on every path — samples are sculptable
        // like synths. Single-buffer sample voices are seeded with a full-level
        // envelope (sustain 100, decay 0) when applied (see applyToneToAllCells)
        // so they play at natural level by default; the user can dial in decay/
        // sustain for fades. The slice path only floors attack/release a touch
        // so mid-buffer cut edges don't click.
        ampEnv = new Tone.AmplitudeEnvelope({
          attack:  _slicing ? Math.max(0.006, env.attack) : Math.max(0, env.attack),
          decay:   Math.max(0, env.decay),
          sustain: Math.max(0, Math.min(1, env.sustain)),
          release: _slicing ? Math.max(0.006, env.release) : Math.max(0.01, env.release),
        }).connect(outGain);
        let head = ampEnv;
        // Optional per-note lowpass (the "filter" hook). Driven by a
        // filterCutoff param; absent / wide-open → no node created.
        const cutoff = (opts && Number.isFinite(opts.filterCutoff)) ? opts.filterCutoff : null;
        if (cutoff != null && cutoff < 18000) {
          filter = new Tone.Filter({
            type: 'lowpass',
            frequency: Math.max(40, cutoff),
            Q: (opts && Number.isFinite(opts.filterQ)) ? Math.max(0, opts.filterQ) : 0.7,
          }).connect(head);
          head = filter;
        }
        // Pad voices loop their whole (pre-trimmed) buffer so the sound holds for
        // the full note duration. We loop by setting `loop` DIRECTLY on the native
        // AudioBufferSourceNode after start() (see the trigger sites) — Tone's
        // `loop` SETTER calls cancelStop()→cancelScheduledValues(), which cancels
        // the OneShotSource fade-in ramp and leaves the gain at 0 (silence). The
        // native property has no such side effect.
        _padLoop = !!(info && info.padLoop);
        // Seamless looping for a held tuned sample: swap in the crossfaded loop
        // buffer (keeps the natural attack, loops the body click-free). The loop
        // window is applied to the NATIVE node AFTER start (_applyVoiceLoop) —
        // Tone's `loop` setter would cancel the source's fade-in (→ silence).
        if (opts && opts.loop && !_slicing) {
          const _lp = _getSeamlessLoop(id + '#' + sampleMidi, audioBuf, info);
          if (_lp) _loopBuf = _lp;
        }
        // The seamless loop BUFFER is swapped in here, but looping is enabled on
        // the NATIVE node after start (_applyVoiceLoop) — NOT via Tone's loop
        // setter / constructor option, which cancels the source's fade-in ramp and
        // leaves the voice silent (the bug that made Motif/Texture drop out).
        let _srcBuf = _loopBuf ? _loopBuf.buffer : audioBuf;
        if (opts && opts.reverse && !_loopBuf) _srcBuf = _reverseAudioBuf(audioBuf);   // play backwards (whole sample or slice)
        source = new Tone.ToneBufferSource({ url: _srcBuf, playbackRate }).connect(head);
        // VCO automation: Bloom's per-layer pitch mod is a ±cents signal (it
        // drives a synth voice's `detune` directly). Tone.ToneBufferSource has
        // no connectable detune, so retarget it onto playbackRate — where pitch
        // lives for a sample: rate = base·2^(cents/1200), linearised for small
        // vibrato as base·(ln2/1200)·cents. A per-voice Gain applies that scale
        // and sums onto the constant playbackRate (the LFO is zero-mean, so the
        // sampled pitch centre is preserved); it's disposed with the voice.
        if (opts && opts.detuneMod && typeof opts.detuneMod.connect === 'function'
            && source.playbackRate && playbackRate > 0) {
          detuneScale = new Tone.Gain(playbackRate * (Math.LN2 / 1200));
          opts.detuneMod.connect(detuneScale);
          detuneScale.connect(source.playbackRate);
        }
      } catch (e) {
        try { source && source.dispose(); } catch (_) {}
        try { ampEnv && ampEnv.dispose(); } catch (_) {}
        try { outGain && outGain.dispose(); } catch (_) {}
        try { filter && filter.dispose(); } catch (_) {}
        try { panNode && panNode.dispose(); } catch (_) {}
        try { panMakeupNode && panMakeupNode.dispose(); } catch (_) {}
        try { detuneScale && detuneScale.dispose(); } catch (_) {}
        return null;
      }
      // Slice window for source.start(time, offset, duration). offset/duration
      // are pre-rate BUFFER seconds, so convert the caller's musical (output-time)
      // sampleOffsetSec/sliceDurSec by × playbackRate here — the one place that
      // knows the rate. (The buffer consumed for an output-time slice scales with
      // playbackRate, so a transposed slice still covers the right window.)
      let sliceOffset = (opts && Number.isFinite(opts.sampleOffsetSec)) ? Math.max(0, Math.min(audioBuf.duration, opts.sampleOffsetSec * playbackRate)) : 0;
      const sliceBufSec = (opts && Number.isFinite(opts.sliceDurSec)) ? Math.max(0.005, opts.sliceDurSec * playbackRate) : null;
      // Reversed buffer: a forward window [o, o+d] maps to [D−o−d, D−o] in the mirror.
      if (opts && opts.reverse && !_loopBuf) { const D = audioBuf.duration; sliceOffset = Math.max(0, D - sliceOffset - (sliceBufSec != null ? sliceBufSec : D)); }
      return { source, ampEnv, outGain, filter, panNode, detuneScale, sliceOffset, sliceBufSec, padLoop: _padLoop,
        loop: !!_loopBuf, loopStart: _loopBuf ? _loopBuf.loopStart : 0, loopEnd: _loopBuf ? _loopBuf.loopEnd : 0 };
    }
    // Dedicated LOOPING voice for pad samples, built from raw Web Audio nodes:
    //   native AudioBufferSourceNode(loop=true) → envGain (manual ADSR) →
    //   boostGain → [panner] → (Tone.connect) destination.
    // Tone's ToneBufferSource is a OneShotSource that can't loop without its
    // loop-setter cancelling its own fade-in ramp (→ silence), so pads bypass it
    // entirely. Returns a { release } handle (and start happens here at `when`),
    // or null if the buffer isn't reachable (caller falls back to a one-shot).
    // Live pad voices (native looping AudioBufferSourceNode graphs). Tracked so a
    // user Stop gesture can cut them immediately (they bypass the Tone-based
    // _activeSampleVoices registry). Each entry carries a fast click-free kill().
    const _activePadVoices = new Set();
    // Seamless-loop buffers, cached per sample id. A raw buffer looped 0→end
    // clicks at the seam (waveform jump) and re-triggers the onset every pass —
    // the "messy" loop. We bake a click-free loop ONCE: keep the natural attack
    // [0, e), then crossfade the loop tail [e−c, e) toward the pre-loop region
    // [s−c, s) so that wrapping e→s is continuous (the sample just before s flows
    // into s, which is untouched). loopStart=s, loopEnd=e.
    const _seamlessLoopCache = new Map();
    function _makeSeamlessLoopBuffer(audioBuf, info) {
      const ac = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : null;
      if (!ac || !audioBuf || !(audioBuf.duration > 0)) return null;
      const D = audioBuf.duration, sr = audioBuf.sampleRate;
      // Loop a steady region: skip the onset, stop a hair before the end (drops a
      // trailing release fade). A sample may pin its own window via info.
      let ls = Number.isFinite(info && info.loopStartSec) ? info.loopStartSec : D * 0.25;
      let le = Number.isFinite(info && info.loopEndSec)   ? info.loopEndSec   : D * 0.98;
      ls = Math.max(0, Math.min(ls, D - 0.02));
      le = Math.max(ls + 0.02, Math.min(le, D));
      const s = Math.floor(ls * sr), e = Math.min(audioBuf.length, Math.floor(le * sr));
      let c = Math.floor(Math.min(0.12, (le - ls) / 2) * sr);   // ≤120 ms crossfade, ≤ half the loop
      c = Math.min(c, s);                                        // need c samples before s to blend in
      if (c < 8 || e - s < 16) return null;                     // too short to loop usefully
      let out;
      try { out = ac.createBuffer(audioBuf.numberOfChannels, e, sr); } catch (x) { return null; }
      for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
        const srcD = audioBuf.getChannelData(ch);
        const dst = out.getChannelData(ch);
        dst.set(srcD.subarray(0, e));
        for (let k = 0; k < c; k++) {
          const t = (k + 0.5) / c;                  // 0..1 across the crossfade
          const wOut = Math.cos(t * Math.PI / 2);   // loop tail fades out (equal power)
          const wIn  = Math.sin(t * Math.PI / 2);   // pre-loop region fades in
          dst[e - c + k] = srcD[e - c + k] * wOut + srcD[s - c + k] * wIn;
        }
      }
      return { buffer: out, loopStart: s / sr, loopEnd: e / sr };
    }
    function _getSeamlessLoop(id, audioBuf, info) {
      if (_seamlessLoopCache.has(id)) return _seamlessLoopCache.get(id);
      let res = null;
      try { res = _makeSeamlessLoopBuffer(audioBuf, info); } catch (e) { res = null; }
      _seamlessLoopCache.set(id, res);   // cache null too — don't re-attempt a too-short buffer
      return res;
    }
    function _startPadVoice(id, tunedFreq, env, destNode, velocity, when, opts) {
      try {
        const ac = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : null;
        const info = sampleSamplers.get(id);
        const audioBuf = (typeof _getSampleAudioBuffer === 'function') ? _getSampleAudioBuffer(id) : null;
        if (!ac || !info || !audioBuf) return null;
        let rootFreq = 261.63;
        try { rootFreq = Tone.Frequency(info.rootNote || 'C4').toFrequency(); } catch (e) {}
        let playbackRate = (rootFreq > 0 && tunedFreq > 0) ? tunedFreq / rootFreq : 1;
        if (Number.isFinite(info.tuneCents) && info.tuneCents) playbackRate *= Math.pow(2, -info.tuneCents / 1200);

        // Seamless (crossfaded) loop buffer when available — keeps the natural
        // attack and loops the body without a seam click; falls back to the raw
        // buffer (whole-buffer loop) only if the sample is too short to bake.
        const lp = _getSeamlessLoop(id, audioBuf, info);
        const src = ac.createBufferSource();
        src.buffer = lp ? lp.buffer : audioBuf;
        src.loop = true;
        src.loopStart = lp ? lp.loopStart : 0;
        src.loopEnd   = lp ? lp.loopEnd   : audioBuf.duration;
        try { src.playbackRate.value = playbackRate; } catch (e) {}

        const envGain = ac.createGain(); envGain.gain.value = 0;
        const boostGain = ac.createGain(); boostGain.gain.value = Math.pow(10, SAMPLE_VOLUME_BOOST_DB / 20);
        src.connect(envGain); envGain.connect(boostGain);
        let tail = boostGain, panNode = null;
        if (opts && Number.isFinite(opts.pan) && Math.abs(opts.pan) > 0.01 && ac.createStereoPanner) {
          panNode = ac.createStereoPanner();
          try { panNode.pan.value = Math.max(-1, Math.min(1, opts.pan / 100)); } catch (e) {}
          boostGain.connect(panNode); tail = panNode;
        }
        try { if (typeof Tone.connect === 'function') Tone.connect(tail, destNode); else tail.connect(destNode.input || destNode); }
        catch (e) { try { tail.connect(ac.destination); } catch (_) {} }

        const t0 = (typeof when === 'number' && when >= 0) ? when : ac.currentTime;
        try { src.start(t0); } catch (e) {}
        const peak = Math.max(0.0001, velocity);
        const atk = Math.max(0.005, env.attack || 0);
        const dec = Math.max(0, env.decay || 0);
        const sus = Math.max(0, Math.min(1, env.sustain != null ? env.sustain : 1)) * peak;
        envGain.gain.setValueAtTime(0, t0);
        envGain.gain.linearRampToValueAtTime(peak, t0 + atk);
        if (dec > 0) envGain.gain.linearRampToValueAtTime(sus, t0 + atk + dec);
        else envGain.gain.setValueAtTime(sus, t0 + atk + 0.0005);

        let cleaned = false;
        const reg = {};
        // Tag with the Bloom layer key + start time (like _registerVoiceAtStart) so an
        // area transition can stop just this layer's looping voices via stopBloomVoicesBefore.
        try { if (typeof window !== 'undefined' && window._ambCaptureSink) { reg._ak = window._ambEmitKey || null; reg._akAt = Number.isFinite(window._ambEmitAt) ? window._ambEmitAt : null; } } catch (e) {}
        _activePadVoices.add(reg);
        const cleanup = () => {
          if (cleaned) return; cleaned = true;
          _activePadVoices.delete(reg);
          try { src.stop(); } catch (e) {}
          try { src.disconnect(); } catch (e) {}
          try { envGain.disconnect(); } catch (e) {}
          try { boostGain.disconnect(); } catch (e) {}
          try { panNode && panNode.disconnect(); } catch (e) {}
        };
        // Fast, click-free kill for a user Stop gesture — ramp to silence over
        // ~22 ms (ignoring the pad's long musical release) then dispose.
        reg.kill = () => {
          try {
            const now = ac.currentTime;
            envGain.gain.cancelScheduledValues(now);
            envGain.gain.setValueAtTime(envGain.gain.value, now);
            envGain.gain.linearRampToValueAtTime(0, now + 0.022);
            src.stop(now + 0.03);
          } catch (e) {}
          setTimeout(cleanup, 60);
        };
        let released = false;
        return {
          release: () => {
            if (released) return; released = true;
            const rel = Math.max(0.02, env.release || 0.1);
            try {
              const now = ac.currentTime;
              envGain.gain.cancelScheduledValues(now);
              envGain.gain.setValueAtTime(envGain.gain.value, now);
              envGain.gain.linearRampToValueAtTime(0, now + rel);
              src.stop(now + rel + 0.05);
            } catch (e) {}
            setTimeout(cleanup, (Math.max(0.02, env.release || 0.1) + 0.3) * 1000);
          },
          // Scheduled (sequence) use: hold for `holdSec` from t0, then release.
          scheduleStop: (holdSec) => {
            try {
              const rel = Math.max(0.02, env.release || 0.1);
              const relStart = t0 + Math.max(0, holdSec);
              envGain.gain.setValueAtTime(sus, relStart);
              envGain.gain.linearRampToValueAtTime(0, relStart + rel);
              src.stop(relStart + rel + 0.05);
              setTimeout(cleanup, ((relStart + rel + 0.1 - ac.currentTime) * 1000) + 100);
            } catch (e) {}
          },
        };
      } catch (e) { return null; }
    }
    // Enable the seamless loop on a built voice AFTER its source has started, by
    // setting the loop window on the native AudioBufferSourceNode directly (Tone's
    // ToneBufferSource.loop setter cancels the fade-in ramp → silence). No-op for
    // non-looping voices. Call right after v.source.start(...).
    function _applyVoiceLoop(v) {
      if (!v || !v.loop || !v.source) return;
      try {
        const ns = v.source._source;   // native AudioBufferSourceNode (Tone v14)
        if (ns) { ns.loop = true; ns.loopStart = v.loopStart; ns.loopEnd = v.loopEnd; }
      } catch (e) {}
    }
    function _disposeSampleAdsrVoice(v) {
      if (!v) return;
      try { v.source && v.source.dispose(); } catch (e) {}
      try { v.ampEnv && v.ampEnv.dispose(); } catch (e) {}
      try { v.outGain && v.outGain.dispose(); } catch (e) {}
      try { v.filter && v.filter.dispose(); } catch (e) {}
      try { v.panNode && v.panNode.dispose(); } catch (e) {}
      try { v.detuneScale && v.detuneScale.dispose(); } catch (e) {}
    }
    function getSampleEntry(type) {
      if (!isSampleType(type)) return null;
      const id = type.slice(7);
      if (_offlineSamplerOverride && _offlineSamplerOverride.has(id)) {
        return { sampler: _boostSampler(_offlineSamplerOverride.get(id)) };
      }
      const entry = sampleSamplers.get(id) || null;
      if (entry && entry.sampler) _boostSampler(entry.sampler);
      return entry;
    }
    function getAllSoundOptions() {
      const opts = SOUNDS.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }));
      for (const [id, info] of sampleSamplers) {
        opts.push({ value: 'sample:' + id, label: info.name });
      }
      for (const [id, def] of ensembles) {
        opts.push({ value: 'ensemble:' + id, label: (def && def.name) ? def.name : ('Ensemble ' + id) });
      }
      // "User" design patches (Design view, 20-sound-design.js — loaded later,
      // so guard by typeof). Each plays via its stored base voice + design.
      try { if (typeof _userPatchOptions === 'function') _userPatchOptions().forEach(o => opts.push(o)); } catch (e) {}
      return opts;
    }

    // Factory + table for the General MIDI batch. Each row is
    // [internalId, displayLabel, gmFolderName, octaveTier] — the
    // helper expands it into the same {id, label, baseUrl, urls}
    // shape the rest of REMOTE_INSTRUMENTS uses. Octave tiers:
    //   'high' → C3-C7  (piccolo, glockenspiel, tubular bells)
    //   'low'  → C1-C5  (basses, tuba, contrabass, timpani)
    //   'fx'   → C4 only (non-pitched sound effects)
    //   default → C2-C6 (everything else)
    function _buildGmInstruments() {
      const TIERS = {
        high: ['C3','C4','C5','C6','C7'],
        low:  ['C1','C2','C3','C4','C5'],
        fx:   ['C4'],
        mid:  ['C2','C3','C4','C5','C6'],
      };
      const mk = (id, label, gmName, tier = 'mid') => {
        const points = TIERS[tier] || TIERS.mid;
        const urls = {};
        for (const p of points) urls[p] = p + '.mp3';
        return {
          id,
          label,
          baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/' + gmName + '-mp3/',
          urls,
        };
      };
      // Note: ids must not collide with the manually-defined entries
      // above (piano, rhodes, harpsichord, clavinet, celesta,
      // vibraphone, marimba, eguitar, leadsquare, padpoly, organ,
      // guitar, violin, cello, flute) — those are handled by either
      // a different CDN (nbrosowsky) or a different sample source
      // (Salamander piano).
      const TABLE = [
        // KEYS
        ['pianobr',      'Bright Piano',  'bright_acoustic_piano'],
        ['pianoeg',      'Elec Grand',    'electric_grand_piano'],
        ['honkytonk',    'Honkytonk',     'honkytonk_piano'],
        ['organdrawbar', 'Drawbar Org',   'drawbar_organ'],
        ['organperc',    'Perc Organ',    'percussive_organ'],
        ['organrock',    'Rock Organ',    'rock_organ'],
        ['organchurch',  'Church Organ',  'church_organ'],
        ['organreed',    'Reed Organ',    'reed_organ'],
        ['accordion',    'Accordion',     'accordion'],
        ['harmonica',    'Harmonica',     'harmonica'],
        ['tangoaccord',  'Tango Accord',  'tango_accordion'],
        // MALLETS / pitched percussion
        ['glockenspiel', 'Glockenspiel',  'glockenspiel',   'high'],
        ['musicbox',     'Music Box',     'music_box',      'high'],
        ['xylophone',    'Xylophone',     'xylophone',      'high'],
        ['tubularbells', 'Tubular Bells', 'tubular_bells',  'high'],
        ['dulcimer',     'Dulcimer',      'dulcimer'],
        ['steeldrums',   'Steel Drums',   'steel_drums'],
        ['kalimba',      'Kalimba',       'kalimba'],
        ['timpani',      'Timpani',       'timpani',        'low'],
        ['tinklebell',   'Tinkle Bell',   'tinkle_bell',    'high'],
        ['agogo',        'Agogo',         'agogo'],
        ['woodblock',    'Woodblock',     'woodblock'],
        ['taikodrum',    'Taiko Drum',    'taiko_drum',     'low'],
        ['melodictom',   'Melodic Tom',   'melodic_tom'],
        ['synthdrum',    'Synth Drum',    'synth_drum'],
        ['revcymbal',    'Rev Cymbal',    'reverse_cymbal'],
        // STRINGS — additional guitars
        ['guitnylon',    'Nylon Gtr',     'acoustic_guitar_nylon'],
        ['guitsteel',    'Steel Gtr',     'acoustic_guitar_steel'],
        ['guitjazz',     'Jazz Gtr',      'electric_guitar_jazz'],
        ['guitclean',    'Clean Gtr',     'electric_guitar_clean'],
        ['guitmute',     'Muted Gtr',     'electric_guitar_muted'],
        ['guitod',       'Overdrive Gtr', 'overdriven_guitar'],
        ['guitdist',     'Dist Gtr',      'distortion_guitar'],
        ['guitharm',     'Gtr Harmonics', 'guitar_harmonics'],
        // STRINGS — basses (entirely new family for us)
        ['bassacoustic', 'Acoustic Bass', 'acoustic_bass',         'low'],
        ['bassefinger',  'Electric Bass', 'electric_bass_finger',  'low'],
        ['bassepick',    'Pick Bass',     'electric_bass_pick',    'low'],
        ['bassfret',     'Fretless Bass', 'fretless_bass',         'low'],
        ['bassslap1',    'Slap Bass 1',   'slap_bass_1',           'low'],
        ['bassslap2',    'Slap Bass 2',   'slap_bass_2',           'low'],
        ['basssynth1',   'Synth Bass 1',  'synth_bass_1',          'low'],
        ['basssynth2',   'Synth Bass 2',  'synth_bass_2',          'low'],
        // STRINGS — orchestral
        ['viola',        'Viola',         'viola'],
        ['contrabass',   'Contrabass',    'contrabass',     'low'],
        ['tremolostr',   'Tremolo Str',   'tremolo_strings'],
        ['pizzstr',      'Pizz Str',      'pizzicato_strings'],
        ['harp',         'Harp',          'orchestral_harp'],
        ['strens1',      'Strings',       'string_ensemble_1'],
        ['strens2',      'Strings 2',     'string_ensemble_2'],
        ['synstr1',      'Synth Str',     'synth_strings_1'],
        ['synstr2',      'Synth Str 2',   'synth_strings_2'],
        // WINDS — saxes
        ['saxsop',       'Soprano Sax',   'soprano_sax'],
        ['saxalto',      'Alto Sax',      'alto_sax'],
        ['saxtenor',     'Tenor Sax',     'tenor_sax'],
        ['saxbari',      'Baritone Sax',  'baritone_sax',   'low'],
        // WINDS — other reeds
        ['oboe',         'Oboe',          'oboe'],
        ['enghorn',      'English Horn',  'english_horn'],
        ['bassoon',      'Bassoon',       'bassoon',        'low'],
        ['clarinet',     'Clarinet',      'clarinet'],
        // WINDS — pipes
        ['piccolo',      'Piccolo',       'piccolo',        'high'],
        ['recorder',     'Recorder',      'recorder'],
        ['panflute',     'Pan Flute',     'pan_flute'],
        ['blownbottle',  'Blown Bottle',  'blown_bottle'],
        ['shakuhachi',   'Shakuhachi',    'shakuhachi'],
        ['whistle',      'Whistle',       'whistle',        'high'],
        ['ocarina',      'Ocarina',       'ocarina'],
        // WINDS — brass
        ['trumpet',      'Trumpet',       'trumpet'],
        ['trombone',     'Trombone',      'trombone'],
        ['tuba',         'Tuba',          'tuba',           'low'],
        ['trumpetmute',  'Muted Trumpet', 'muted_trumpet'],
        ['frenchhorn',   'French Horn',   'french_horn'],
        ['brasssec',     'Brass Section', 'brass_section'],
        ['brasssyn1',    'Synth Brass',   'synth_brass_1'],
        ['brasssyn2',    'Synth Brass 2', 'synth_brass_2'],
        // LEADS — synth leads (we already have leadsquare)
        ['leadsaw',      'Saw Lead',      'lead_2_sawtooth'],
        ['leadcal',      'Calliope Lead', 'lead_3_calliope'],
        ['leadchiff',    'Chiff Lead',    'lead_4_chiff'],
        ['leadchar',     'Charang Lead',  'lead_5_charang'],
        ['leadvoice',    'Voice Lead',    'lead_6_voice'],
        ['leadfifths',   'Fifths Lead',   'lead_7_fifths'],
        ['leadbass',     'Bass + Lead',   'lead_8_bass__lead'],
        // PADS — synth pads (we already have padpoly)
        ['padnew',       'New Age Pad',   'pad_1_new_age'],
        ['padwarm',      'Warm Pad',      'pad_2_warm'],
        ['padchoir',     'Choir Pad',     'pad_4_choir'],
        ['padbowed',     'Bowed Pad',     'pad_5_bowed'],
        ['padmetal',     'Metal Pad',     'pad_6_metallic'],
        ['padhalo',      'Halo Pad',      'pad_7_halo'],
        ['padsweep',     'Sweep Pad',     'pad_8_sweep'],
        // SYNTH FX
        ['fxrain',       'FX Rain',       'fx_1_rain'],
        ['fxsoundtrack', 'FX Soundtrack', 'fx_2_soundtrack'],
        ['fxcrystal',    'FX Crystal',    'fx_3_crystal'],
        ['fxatmos',      'FX Atmosphere', 'fx_4_atmosphere'],
        ['fxbright',     'FX Brightness', 'fx_5_brightness'],
        ['fxgoblins',    'FX Goblins',    'fx_6_goblins'],
        ['fxechoes',     'FX Echoes',     'fx_7_echoes'],
        ['fxscifi',      'FX Sci-Fi',     'fx_8_scifi'],
        // ENSEMBLE & VOICE
        ['choir',        'Choir Aahs',    'choir_aahs'],
        ['voiceoohs',    'Voice Oohs',    'voice_oohs'],
        ['orchhit',      'Orch Hit',      'orchestra_hit'],
        // ETHNIC
        ['sitar',        'Sitar',         'sitar'],
        ['banjo',        'Banjo',         'banjo'],
        ['shamisen',     'Shamisen',      'shamisen'],
        ['koto',         'Koto',          'koto'],
        ['bagpipe',      'Bagpipe',       'bagpipe'],
        ['fiddle',       'Fiddle',        'fiddle'],
        ['shanai',       'Shanai',        'shanai'],
        // SOUND EFFECTS — single-pitch, often non-tonal
        ['fretnoise',    'Fret Noise',    'guitar_fret_noise', 'fx'],
        ['breathnoise',  'Breath Noise',  'breath_noise',      'fx'],
        ['seashore',     'Seashore',      'seashore',          'fx'],
        ['bird',         'Bird Tweet',    'bird_tweet',        'fx'],
        ['phone',        'Telephone',     'telephone_ring',    'fx'],
        ['helicopter',   'Helicopter',    'helicopter',        'fx'],
        ['applause',     'Applause',      'applause',          'fx'],
        ['gunshot',      'Gunshot',       'gunshot',           'fx'],
      ];
      return TABLE.map(row => mk(row[0], row[1], row[2], row[3]));
    }

    // Open-source sample-based instruments. Each loads as a Tone.Sampler
    // connected to the master bus, then surfaces as a 'sample:<id>' tone
    // option alongside any local samples. Ranges are intentionally sparse —
    // Tone.Sampler pitch-shifts between provided sample points so 4–8 notes
    // is enough for keyboard coverage without bloating page-load fetches.
    const REMOTE_INSTRUMENTS = [
      {
        // Salamander Grand Piano — Tone.js's official example set, by
        // Alexander Holm under Creative Commons.
        id: 'piano',
        label: 'Piano',
        baseUrl: 'https://tonejs.github.io/audio/salamander/',
        urls: {
          'A0': 'A0.mp3', 'C1': 'C1.mp3', 'A1': 'A1.mp3', 'C2': 'C2.mp3',
          'A2': 'A2.mp3', 'C3': 'C3.mp3', 'A3': 'A3.mp3', 'C4': 'C4.mp3',
          'A4': 'A4.mp3', 'C5': 'C5.mp3', 'A5': 'A5.mp3', 'C6': 'C6.mp3',
          'A6': 'A6.mp3', 'C7': 'C7.mp3', 'A7': 'A7.mp3', 'C8': 'C8.mp3',
        },
      },
      {
        // tonejs-instruments by Nicholaus Brosowsky — VSCO-derived samples
        // hosted on GitHub Pages, mostly CC-licensed.
        id: 'organ',
        label: 'Organ',
        baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/organ/',
        urls: { 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3' },
      },
      {
        id: 'guitar',
        label: 'Guitar',
        baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/guitar-acoustic/',
        urls: {
          'E2': 'E2.mp3', 'A2': 'A2.mp3', 'D3': 'D3.mp3',
          'G3': 'G3.mp3', 'B3': 'B3.mp3', 'E4': 'E4.mp3',
        },
      },
      {
        id: 'violin',
        label: 'Violin',
        baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/violin/',
        urls: {
          'G3': 'G3.mp3', 'C4': 'C4.mp3', 'A4': 'A4.mp3',
          'C5': 'C5.mp3', 'E5': 'E5.mp3',
        },
      },
      {
        id: 'flute',
        label: 'Flute',
        baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/flute/',
        urls: {
          'C4': 'C4.mp3', 'E4': 'E4.mp3', 'A4': 'A4.mp3',
          'C5': 'C5.mp3', 'E5': 'E5.mp3', 'A5': 'A5.mp3',
        },
      },
      // ---- Additional keys (electric piano, harpsichord, clavinet) and
      // mallets — MusyngKite GM soundfont set, served via GitHub Pages
      // with permissive CORS. Sparse octave coverage; Tone.Sampler
      // pitch-shifts in between.
      {
        id: 'rhodes',
        label: 'Rhodes',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/electric_piano_1-mp3/',
        urls: { 'C2': 'C2.mp3', 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3' },
      },
      {
        id: 'epiano2',
        label: 'EP Chorus',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/electric_piano_2-mp3/',
        urls: { 'C2': 'C2.mp3', 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3' },
      },
      {
        id: 'harpsichord',
        label: 'Harpsichord',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/harpsichord-mp3/',
        urls: { 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3' },
      },
      {
        id: 'clavinet',
        label: 'Clavinet',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/clavinet-mp3/',
        urls: { 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3' },
      },
      {
        id: 'celesta',
        label: 'Celesta',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/celesta-mp3/',
        urls: { 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3', 'C7': 'C7.mp3' },
      },
      {
        id: 'vibraphone',
        label: 'Vibraphone',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/vibraphone-mp3/',
        urls: { 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3' },
      },
      {
        id: 'marimba',
        label: 'Marimba',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/marimba-mp3/',
        urls: { 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3' },
      },
      {
        id: 'cello',
        label: 'Cello',
        baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/cello/',
        urls: {
          'C2': 'C2.mp3', 'E2': 'E2.mp3', 'G2': 'G2.mp3',
          'C3': 'C3.mp3', 'E3': 'E3.mp3', 'G3': 'G3.mp3',
          'C4': 'C4.mp3',
        },
      },
      {
        id: 'eguitar',
        label: 'Electric Guitar',
        baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/guitar-electric/',
        urls: { 'E2': 'E2.mp3', 'A2': 'A2.mp3', 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'A3': 'A3.mp3', 'A4': 'A4.mp3' },
      },
      {
        // Square-wave lead — bright FM/synth lead from the GM bank.
        id: 'leadsquare',
        label: 'Square Lead',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/lead_1_square-mp3/',
        urls: { 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3' },
      },
      {
        id: 'padpoly',
        label: 'Poly Pad',
        baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/pad_3_polysynth-mp3/',
        urls: { 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3', 'C6': 'C6.mp3' },
      },
      // ---- General MIDI bank batch — every MusyngKite GM voice we
      // weren't already shipping. Each entry follows the exact
      // pattern above (id / label / baseUrl / urls). Octave coverage
      // tiers: HIGH (C3-C7) for piccolo / glockenspiel / tubular
      // bells, LOW (C1-C5) for basses / tuba / contrabass / timpani,
      // FX (just C4) for non-pitched sound-effects samples, MID
      // (C2-C6) for everything else — matches the existing entries'
      // density and lets Tone.Sampler pitch-shift between anchors.
      // CDN: gleitz.github.io/midi-js-soundfonts/MusyngKite (CC-BY).
      ..._buildGmInstruments(),
      // ---- Drum kits — CC0 / public-domain from tidalcycles/dirt-samples.
      // Each kit fans out 12 distinct hits across the chromatic C2-B2 row
      // (kick → C, rim → C#, snare → D, clap → D#, closed hat → E, open
      // hat → F, low tom → F#, mid tom → G, cowbell/cymbal → G#, crash/
      // ride → A, high tom → A#, perc → B). Picking a note in the grid
      // therefore plays a specific drum, not a pitch-shifted single hit.
      {
        id: 'tr808',
        label: 'TR-808',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/',
        urls: {
          'C2':   '808bd/BD0000.WAV',
          'C#2':  '808/RS.WAV',
          'D2':   '808sd/SD0000.WAV',
          'D#2':  '808/CP.WAV',
          'E2':   '808hc/HC00.WAV',
          'F2':   '808oh/OH00.WAV',
          'F#2':  '808lt/LT00.WAV',
          'G2':   '808mt/MT00.WAV',
          'G#2':  '808/CB.WAV',
          'A2':   '808/CH.WAV',
          'A#2':  '808ht/HT00.WAV',
          'B2':   '808/MA.WAV',
        },
      },
      {
        // Filenames use literal spaces, NOT percent-encoded ones — Tone v14
        // pipes urls values through `<a>.pathname.split('/').map(encodeURIComponent)`,
        // which double-encodes any pre-encoded `%20` (→ `%2520`) and 404s.
        // A literal space passes through cleanly to a single `%20`.
        id: 'drumtraks',
        label: 'DrumTraks',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/drumtraks/',
        urls: {
          'C2':   '006_DT Kick.wav',
          'C#2':  '008_DT Rimshot.wav',
          'D2':   '009_DT Snare.wav',
          'D#2':  '001_DT Claps.wav',
          'E2':   '004_DT Hat Closed.wav',
          'F2':   '005_DT Hat Open.wav',
          'F#2':  '011_DT Tom1.wav',
          'G2':   '012_DT Tom2.wav',
          'G#2':  '002_DT Cowbell.wav',
          'A2':   '003_DT Crash.wav',
          'A#2':  '007_DT Ride.wav',
          'B2':   '000_DT Cabasa.wav',
        },
      },
      {
        id: 'drumkit',
        label: 'Drum Kit',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/',
        urls: {
          'C2':   'bd/BT0AAD0.wav',
          'C#2':  'rs/rytm-rs.wav',
          'D2':   'sn/ST0T0S0.wav',
          'D#2':  'cp/HANDCLP0.wav',
          'E2':   'hh/000_hh3closedhh.wav',
          'F2':   'ho/HHOD0.wav',
          'F#2':  'lt/LT0D0.wav',
          'G2':   'mt/MT0D0.wav',
          'G#2':  'cb/rytm-cb.wav',
          'A2':   'cr/RIDED0.wav',
          'A#2':  'ht/HT0D0.wav',
          'B2':   'perc/000_perc0.wav',
        },
      },
      {
        // dr55 only ships 4 native samples — fill the rest with the Boss
        // DR-110 (dr2/) and a couple perc/ files so the chromatic mapping
        // is complete and the kit still feels mini-drum-machine flavoured.
        id: 'dr55',
        label: 'DR-55',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/',
        urls: {
          // Literal spaces (not %20) — see DrumTraks comment above.
          'C2':   'dr55/001_DR55 kick.wav',
          'C#2':  'dr55/002_DR55 rimshot.wav',
          'D2':   'dr55/003_DR55 snare.wav',
          'D#2':  'dr2/001_DR110CLP.WAV',
          'E2':   'dr55/000_DR55 hi hat.wav',
          'F2':   'dr2/004_DR110OHT.WAV',
          'F#2':  'perc/001_perc1.wav',
          'G2':   'perc/002_perc2.wav',
          'G#2':  'dr2/002_DR110CYM.WAV',
          'A2':   'dr2/000_DR110CHT.WAV',
          'A#2':  'dr2/005_DR110SNR.WAV',
          'B2':   'dr2/003_DR110KIK.WAV',
        },
      },
      {
        // Gritty rave / breakbeat kit — all 12 hits from one cohesive sample
        // folder (no cross-folder mixing needed).
        id: 'hardcore',
        label: 'Hardcore',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/hardcore/',
        urls: {
          'C2':   '004_hckick1.wav',
          'C#2':  '001_hchit1.wav',
          'D2':   '010_hcsnare1.wav',
          'D#2':  '011_hcsnare2.wav',
          'E2':   '000_hcclosedhh.wav',
          'F2':   '006_hcopenhh.wav',
          'F#2':  '005_hckick2.wav',
          'G2':   '003_hchit2.wav',
          'G#2':  '007_hcperc1.wav',
          'A2':   '002_hccrash.wav',
          'A#2':  '009_hcride.wav',
          'B2':   '008_hcperc2.wav',
        },
      },
      {
        // Classic house drum machine — only 8 native sounds, so a few roles
        // share a sample (cowbell↔rim, fx↔crash) to fill the chromatic row.
        id: 'house',
        label: 'House',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/house/',
        urls: {
          'C2':   '000_BD.wav',
          'C#2':  '001_CB.wav',
          'D2':   '007_SN.wav',
          'D#2':  '005_P1.wav',
          'E2':   '003_HH.wav',
          'F2':   '004_OH.wav',
          'F#2':  '006_P2.wav',
          'G2':   '002_FX.wav',
          'G#2':  '001_CB.wav',
          'A2':   '002_FX.wav',
          'A#2':  '005_P1.wav',
          'B2':   '007_SN.wav',
        },
      },
      {
        // Indian tabla — tuned hand-percussion; "kick" rows map to the deep bass
        // strokes, "hats/perc" rows to the higher flicks and hits.
        id: 'tabla',
        label: 'Tabla',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/tabla/',
        urls: {
          'C2':   '006_d_sharp_hit.wav',
          'C#2':  '003_dead_hit1.wav',
          'D2':   '009_hi_hit1.wav',
          'D#2':  '004_dead_hit2.wav',
          'E2':   '007_hi_flick1.wav',
          'F2':   '008_hi_flick2.wav',
          'F#2':  '000_bass_flick1.wav',
          'G2':   '001_bass_flick2.wav',
          'G#2':  '002_bass_lick1.wav',
          'A2':   '011_hi_hit2.wav',
          'A#2':  '012_hi_hit3.wav',
          'B2':   '013_hi_hit4.wav',
        },
      },
      {
        // Japanese taiko / shime percussion ("east" folder). 9 native samples;
        // a few roles share a hit to complete the row.
        id: 'taiko',
        label: 'Taiko',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/east/',
        urls: {
          'C2':   '006_taiko_1.wav',
          'C#2':  '000_nipon_wood_block.wav',
          'D2':   '007_taiko_2.wav',
          'D#2':  '001_ohkawa_mute.wav',
          'E2':   '003_shime_hi.wav',
          'F2':   '005_shime_mute.wav',
          'F#2':  '008_taiko_3.wav',
          'G2':   '002_ohkawa_open.wav',
          'G#2':  '000_nipon_wood_block.wav',
          'A2':   '004_shime_hi_2.wav',
          'A#2':  '006_taiko_1.wav',
          'B2':   '002_ohkawa_open.wav',
        },
      },
      {
        // Acoustic Gretsch kit (brushes + sticks) — 24 native one-shots, so every
        // role maps to a distinct real drum.
        id: 'gretsch',
        label: 'Gretsch (acoustic)',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/gretsch/',
        urls: {
          'C2':   '013_kick.wav',
          'C#2':  '021_snareghost.wav',
          'D2':   '020_snare.wav',
          'D#2':  '022_snarehard.wav',
          'E2':   '004_closedhat.wav',
          'F2':   '017_openhat.wav',
          'F#2':  '015_lotom.wav',
          'G2':   '012_hitom.wav',
          'G#2':  '006_cowbell.wav',
          'A2':   '019_ridecymbal.wav',
          'A#2':  '000_brushhitom.wav',
          'B2':   '018_ridebell.wav',
        },
      },
      {
        // DBX12 breakbeat kit — full 13-sample machine, one sound per role.
        id: 'dbx',
        label: 'DBX (break)',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/db/',
        urls: {
          'C2':   'dbs12kick1.wav',
          'C#2':  'dbs12hit1.wav',
          'D2':   'dbs12snare1.wav',
          'D#2':  'dbs12snare2.wav',
          'E2':   'dbs12closedhh.wav',
          'F2':   'dbs12openhh.wav',
          'F#2':  'dbs12kick2.wav',
          'G2':   'dbs12hit2.wav',
          'G#2':  'dbs12perc1.wav',
          'A2':   'dbs12crash.wav',
          'A#2':  'dbs12ride.wav',
          'B2':   'dbs12perc2.wav',
        },
      },
      {
        // Sequential Circuits Tom — 8 native sounds (literal spaces → %20, see
        // DrumTraks note); a few roles share a hit to complete the row.
        id: 'sequential',
        label: 'Sequential Tom',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/sequential/',
        urls: {
          'C2':   '003_Tom Kick.wav',
          'C#2':  '000_Tom Clap.wav',
          'D2':   '005_Tom Snare.wav',
          'D#2':  '000_Tom Clap.wav',
          'E2':   '002_Tom Hat Closed.wav',
          'F2':   '004_Tom Openhat.wav',
          'F#2':  '006_Tom Tom1.wav',
          'G2':   '007_Tom Tom2.wav',
          'G#2':  '001_Tom Crash.wav',
          'A2':   '001_Tom Crash.wav',
          'A#2':  '006_Tom Tom1.wav',
          'B2':   '005_Tom Snare.wav',
        },
      },
      {
        // Commodore 64 SID — lo-fi 8-bit chiptune percussion.
        id: 'sid',
        label: 'SID (8-bit)',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/sid/',
        urls: {
          'C2':   '002_basd.wav',
          'C#2':  '003_blipp01.wav',
          'D2':   '010_sidsnares.wav',
          'D#2':  '004_blipp02.wav',
          'E2':   '007_hihat01.wav',
          'F2':   '008_hihat02.wav',
          'F#2':  '011_tdrum.wav',
          'G2':   '001_bas.wav',
          'G#2':  '005_high.wav',
          'A2':   '006_high2.wav',
          'A#2':  '000_bas2.wav',
          'B2':   '009_lofidrums.wav',
        },
      },
      {
        // Peri — gritty electro kit with metallic FX percussion.
        id: 'peri',
        label: 'Peri (electro)',
        drumKit: true,
        baseUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/peri/',
        urls: {
          'C2':   '000_bd.wav',
          'C#2':  '007_xbigclang.wav',
          'D2':   '005_sd.wav',
          'D#2':  '004_ksh.wav',
          'E2':   '002_hh2.wav',
          'F2':   '003_hhx.wav',
          'F#2':  '008_xbong.wav',
          'G2':   '009_xbusket.wav',
          'G#2':  '010_xchinga.wav',
          'A2':   '014_xgillclank.wav',
          'A#2':  '006_sd-rev.wav',
          'B2':   '011_xfx1.wav',
        },
      },
    ];
    function loadRemoteInstruments() {
      REMOTE_INSTRUMENTS.forEach(inst => {
        if (sampleSamplers.has(inst.id)) return;
        try {
          const sampler = new Tone.Sampler({
            urls: inst.urls,
            baseUrl: inst.baseUrl,
            release: 1,
          }).connect(globalSendTap);
          sampleSamplers.set(inst.id, {
            sampler,
            name: inst.label,
            rootNote: 'C4',
            remote: true,
            drumKit: !!inst.drumKit,
            urls: inst.urls,
            baseUrl: inst.baseUrl,
          });
        } catch (e) {
          console.warn('Failed to register remote instrument', inst.id, e);
        }
      });
      // Grain entry — preload the source buffer so per-note GrainPlayer
      // instances (built lazily in playNote when the user picks Grain)
      // see a cached buffer and start producing audio without the
      // first-note silence the URL-fetch path would otherwise have.
      // The buffer is shared by reference across every grain voice;
      // each player owns its own grain settings + scheduling.
      if (!sampleSamplers.has('grain')) {
        try {
          const buffer = new Tone.ToneAudioBuffer(
            'https://tonejs.github.io/audio/salamander/A4.mp3'
          );
          sampleSamplers.set('grain', {
            kind: 'grain',
            name: 'Grain',
            buffer,
            // Salamander A4 sample → 440 Hz at native playback rate.
            // Used to compute detune so other pitches play in tune.
            baseFreq: 440,
          });
        } catch (e) {
          console.warn('Failed to register grain instrument', e);
        }
      }
    }

    async function loadSampleManifest() {
      try {
        const res = await fetch('samples/manifest.json', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const list = Array.isArray(data?.samples) ? data.samples : [];
        list.forEach(s => {
          if (!s || !s.id || !s.file) return;
          const rootNote = s.rootNote || 'C4';
          try {
            const urls = { [rootNote]: s.file };
            const sampler = new Tone.Sampler({
              urls,
              release: 1,
              baseUrl: 'samples/',
            }).connect(globalSendTap);
            sampleSamplers.set(s.id, {
              sampler,
              name: s.name || s.id,
              rootNote,
              urls,
              baseUrl: 'samples/',
            });
          } catch (e) {
            console.warn('Failed to load sample', s.id, e);
          }
        });
      } catch (e) {
        // No manifest, malformed JSON, or offline — just skip samples silently.
      }
    }

    // ---- User-imported samples (persisted in IndexedDB) ----
    let _importedDB = null;
    function getImportedDB() {
      if (_importedDB) return Promise.resolve(_importedDB);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('bloops-imported-samples', 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('blobs')) {
            db.createObjectStore('blobs', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => { _importedDB = req.result; resolve(req.result); };
        req.onerror = () => reject(req.error);
      });
    }
    async function persistImportedSample(id, name, blob, meta) {
      try {
        const db = await getImportedDB();
        const rec = { id, name, blob };
        if (meta && meta.rootNote) rec.rootNote = meta.rootNote;
        if (meta && Number.isFinite(meta.tuneCents)) rec.tuneCents = meta.tuneCents;
        if (meta && meta.padLoop) rec.padLoop = true;
        if (meta && Number.isFinite(meta.padAttack)) rec.padAttack = meta.padAttack;
        if (meta && Number.isFinite(meta.padRelease)) rec.padRelease = meta.padRelease;
        await new Promise((resolve, reject) => {
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').put(rec);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {
        console.warn('Failed to persist imported sample', id, e);
      }
    }
    async function loadImportedSamples() {
      try {
        const db = await getImportedDB();
        const records = await new Promise((resolve, reject) => {
          const tx = db.transaction('blobs', 'readonly');
          const req = tx.objectStore('blobs').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
        for (const rec of records) {
          if (!rec || !rec.id || !rec.blob) continue;
          try {
            const url = URL.createObjectURL(rec.blob);
            const rootNote = rec.rootNote || 'C4';
            const tuneCents = Number.isFinite(rec.tuneCents) ? rec.tuneCents : 0;
            const urls = { [rootNote]: url };
            const sampler = new Tone.Sampler({
              urls,
              release: 1,
            }).connect(globalSendTap);
            const _info = {
              sampler,
              name: rec.name || rec.id,
              rootNote,
              tuneCents,
              imported: true,
              urls,
              padLoop: !!rec.padLoop,
            };
            if (rec.padLoop) {
              if (Number.isFinite(rec.padAttack)) _info.padAttack = rec.padAttack;
              if (Number.isFinite(rec.padRelease)) _info.padRelease = rec.padRelease;
            }
            sampleSamplers.set(rec.id, _info);
          } catch (e) {
            console.warn('Failed to restore imported sample', rec.id, e);
          }
        }
      } catch (e) {
        // No DB or read failure — not fatal.
      }
    }
    // Delete a USER sample (imported file / captured recording / TTS / grab):
    // dispose its sampler, drop it from the live registry, and remove its
    // IndexedDB blob so it's gone across reloads. Built-in GM/soundfont voices
    // and drum kits are not user samples and aren't deletable. Cells/steps still
    // pointing at the id fall back to a sine at playback (playNote guards an
    // unknown sample), so no reference surgery is needed.
    async function deleteUserSample(id) {
      const info = sampleSamplers.get(id);
      if (!info || !info.imported) return false;
      try { if (info.sampler && info.sampler.dispose) info.sampler.dispose(); } catch (e) {}
      try { if (info.urls) Object.values(info.urls).forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} }); } catch (e) {}
      sampleSamplers.delete(id);
      try {
        const db = await getImportedDB();
        await new Promise((resolve) => {
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch (e) {}
      return true;
    }
    function makeImportedSampleId(filename) {
      const base = (filename || '')
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
      let id = 'imported-' + (base || 'sample');
      let n = 1;
      while (sampleSamplers.has(id)) {
        id = 'imported-' + (base || 'sample') + '-' + n++;
      }
      return id;
    }
    // Register an audio Blob/File as a single-buffer sample voice (mapped to
    // C4), persisting it to IndexedDB. Returns { id, name }. Shared by the file
    // importer and the "always listening" grab.
    async function registerSampleFromBlob(blob, friendly, opts) {
      const id = makeImportedSampleId(friendly || 'sample');
      const name = friendly || id;
      const url = URL.createObjectURL(blob);
      // opts.rootNote = the grid note that plays the buffer at natural pitch
      // (others pitch-shift relative to it). opts.tuneCents = a fine offset
      // baked into the voice so a captured sample can be pulled exactly in tune.
      const rootNote = (opts && opts.rootNote) || 'C4';
      const tuneCents = (opts && Number.isFinite(opts.tuneCents)) ? opts.tuneCents : 0;
      // A "pad" voice loops its (already-trimmed) buffer for as long as the
      // note event lasts — a held grid press sustains indefinitely, a
      // sequenced step holds for its slot. Flagged on the info + persisted so
      // it survives reload, and surfaced in the "Pads" tone family.
      const padLoop = !!(opts && opts.padLoop);
      // Pad swell envelope (ms) — how the held note fades in/out; stored on the
      // info + persisted so applyToneToAllCells can seed it when the pad is the
      // grid voice (see PAD_ENV there).
      const padAttack = (opts && Number.isFinite(opts.padAttack)) ? opts.padAttack : undefined;
      const padRelease = (opts && Number.isFinite(opts.padRelease)) ? opts.padRelease : undefined;
      const urls = { [rootNote]: url };
      const sampler = new Tone.Sampler({ urls, release: 1 }).connect(globalSendTap);
      const info = { sampler, name, rootNote, tuneCents, imported: true, urls, padLoop };
      if (padLoop) { if (padAttack != null) info.padAttack = padAttack; if (padRelease != null) info.padRelease = padRelease; }
      sampleSamplers.set(id, info);
      await persistImportedSample(id, name, blob, { rootNote, tuneCents, padLoop, padAttack, padRelease });
      return { id, name };
    }
    // Estimate the fundamental frequency (Hz) of an AudioBuffer via
    // autocorrelation on a mid-signal window (skips attack/silence), with a
    // parabolic refine for sub-sample accuracy. Returns null if too quiet /
    // unpitched. Used by the "Capture sample" pitch analysis.
    function _detectPitchHz(audioBuf) {
      try {
        const data = audioBuf.getChannelData(0);
        const sr = audioBuf.sampleRate || 44100;
        const size = Math.min(data.length, 16384);
        if (size < 512) return null;
        const start = Math.max(0, Math.floor(data.length / 2 - size / 2));
        const buf = data.subarray(start, start + size);
        let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
        if (rms < 0.004) return null; // effectively silent / no clear tone
        const MIN_F = 50, MAX_F = 1600;
        const maxLag = Math.min(buf.length - 1, Math.floor(sr / MIN_F));
        const minLag = Math.max(2, Math.floor(sr / MAX_F));
        const corr = new Float32Array(maxLag + 1);
        for (let lag = minLag; lag <= maxLag; lag++) {
          let c = 0; const lim = buf.length - lag;
          for (let i = 0; i < lim; i++) c += buf[i] * buf[i + lag];
          corr[lag] = c;
        }
        let bestLag = -1, best = 0;
        for (let lag = minLag; lag <= maxLag; lag++) { if (corr[lag] > best) { best = corr[lag]; bestLag = lag; } }
        if (bestLag <= 0 || best <= 0) return null;
        let lag = bestLag;
        if (bestLag > minLag && bestLag < maxLag) {
          const a = corr[bestLag - 1], b = corr[bestLag], c = corr[bestLag + 1], denom = a - 2 * b + c;
          if (denom !== 0) lag = bestLag + 0.5 * (a - c) / denom;
        }
        const hz = sr / lag;
        return (hz >= MIN_F && hz <= MAX_F) ? hz : null;
      } catch (e) { return null; }
    }
    // Hz → { midi, note, cents } where cents is the signed deviation from the
    // nearest equal-tempered note (−50..+50).
    function _hzToNoteInfo(hz) {
      if (!(hz > 0)) return null;
      const midiFloat = 69 + 12 * Math.log2(hz / 440);
      const midi = Math.round(midiFloat);
      const cents = Math.round((midiFloat - midi) * 100);
      let note = 'C4';
      try { note = Tone.Frequency(midi, 'midi').toNote(); } catch (e) {}
      return { midi, note, cents };
    }
    // Pop a file picker, register the chosen audio file as a Tone.Sampler,
    // and call onLoaded(id, friendlyName) once the buffer is ready. Persists
    // the blob in IndexedDB so it survives reloads.
    function triggerImportSample(onLoaded) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        const friendly = (file.name || 'sample').replace(/\.[^.]+$/, '');
        try {
          const { id, name } = await registerSampleFromBlob(file, friendly);
          if (typeof onLoaded === 'function') onLoaded(id, name);
        } catch (e) {
          console.warn('Failed to import sample', e);
          alert('Could not import this audio file.');
        }
      });
      input.click();
    }

    // Remembered between opens so re-importing from the same Drive folder is one tap.
    let _lastDriveSampleFolder = 'bloops/samples';
    // List the audio files directly inside a Drive folder (paged), keeping
    // anything whose MIME type is audio/* OR whose name has a known audio
    // extension (Drive often labels uploads application/octet-stream).
    async function _listDriveAudioFiles(folderId) {
      const AUDIO_EXT = /\.(mp3|wav|flac|aac|ogg|m4a|opus|aif|aiff)$/i;
      const out = [];
      let pageToken = null;
      do {
        const resp = await gapi.client.drive.files.list({
          q: `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
          fields: 'nextPageToken, files(id, name, mimeType)',
          pageSize: 200, spaces: 'drive', pageToken: pageToken || undefined,
        });
        const fs = (resp.result && resp.result.files) || [];
        for (const f of fs) {
          if ((f.mimeType && f.mimeType.indexOf('audio/') === 0) || AUDIO_EXT.test(f.name || '')) out.push(f);
        }
        pageToken = resp.result && resp.result.nextPageToken;
      } while (pageToken);
      out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      return out;
    }
    // Checkbox picker over the folder's audio files. Resolves to the chosen
    // file objects (or null if cancelled). Styled like the other sm-modal dialogs.
    function _showDriveSamplePicker(folder, files) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
        const modal = document.createElement('div'); modal.className = 'sm-modal drv-samp-modal';
        modal.innerHTML =
          '<div class="sm-title"></div>' +
          '<label class="drv-samp-row drv-samp-all"><input type="checkbox" id="drv-all" checked /> <span></span></label>' +
          '<div class="drv-samp-list"></div>' +
          '<div class="sm-footer">' +
            '<button type="button" class="sm-preview" id="drv-cancel">Cancel</button>' +
            '<button type="button" class="sm-apply" id="drv-go">Import</button>' +
          '</div>';
        overlay.appendChild(modal); document.body.appendChild(overlay);
        modal.querySelector('.sm-title').textContent = 'Import samples — ' + folder;
        modal.querySelector('.drv-samp-all span').innerHTML = '<b>Select all</b> (' + files.length + ')';
        // Build rows via DOM so file names can't inject markup.
        const list = modal.querySelector('.drv-samp-list');
        files.forEach((f, i) => {
          const row = document.createElement('label'); row.className = 'drv-samp-row';
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.i = String(i);
          const nm = document.createElement('span'); nm.className = 'drv-samp-name'; nm.textContent = f.name || ('file ' + (i + 1));
          row.appendChild(cb); row.appendChild(nm); list.appendChild(row);
        });
        const boxes = () => Array.from(list.querySelectorAll('input[type=checkbox]'));
        const allBox = modal.querySelector('#drv-all');
        allBox.addEventListener('change', () => boxes().forEach(b => { b.checked = allBox.checked; }));
        list.addEventListener('change', () => { const bs = boxes(); allBox.checked = bs.length > 0 && bs.every(b => b.checked); });
        const done = (val) => { try { overlay.remove(); } catch (e) {} resolve(val); };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
        modal.querySelector('#drv-cancel').addEventListener('click', () => done(null));
        modal.querySelector('#drv-go').addEventListener('click', () => {
          const picked = boxes().filter(b => b.checked).map(b => files[parseInt(b.dataset.i, 10)]).filter(Boolean);
          done(picked.length ? picked : null);
        });
      });
    }
    // Import one or more samples straight from a Google Drive folder: ask for the
    // folder path, sign in, list its audio files, let the user pick, then fetch +
    // register each (persisted to IndexedDB like a local import). onLoaded(id,name)
    // fires with the LAST imported sample so the caller can select it as the tone.
    async function triggerImportSampleFromDrive(onLoaded) {
      if (typeof googleSignInForDrive !== 'function' || typeof findDriveFolderByPath !== 'function'
          || typeof fetchDriveBinaryAsBlob !== 'function' || typeof gapi === 'undefined') {
        alert('Google Drive is not available in this build.'); return;
      }
      let folder;
      try { folder = prompt('Google Drive folder to import samples from (e.g. bloops/samples):', _lastDriveSampleFolder); }
      catch (e) { folder = null; }
      if (folder == null) return;
      folder = String(folder).trim();
      if (!folder) return;
      _lastDriveSampleFolder = folder;
      const progress = (typeof showRenderProgressModal === 'function') ? showRenderProgressModal('Reading Drive folder…') : null;
      try {
        if (progress) progress.setStatus('Connecting to Google Drive…');
        await googleSignInForDrive();
        if (progress) progress.setStatus('Finding “' + folder + '”…');
        const folderId = await findDriveFolderByPath(folder);
        if (!folderId) { if (progress) progress.close(); alert('Folder not found in your Drive:\n' + folder); return; }
        if (progress) progress.setStatus('Listing audio files…');
        const files = await _listDriveAudioFiles(folderId);
        if (progress) progress.close();
        if (!files.length) { alert('No audio files found in:\n' + folder); return; }
        const picks = await _showDriveSamplePicker(folder, files);
        if (!picks || !picks.length) return;
        const prog2 = (typeof showRenderProgressModal === 'function') ? showRenderProgressModal('Importing samples…') : null;
        let lastId = null, lastName = null, ok = 0;
        for (let i = 0; i < picks.length; i++) {
          const f = picks[i];
          if (prog2) { prog2.setStatus('Importing ' + (i + 1) + '/' + picks.length + ': ' + (f.name || '')); prog2.setProgress(i / picks.length); }
          try {
            const blob = await fetchDriveBinaryAsBlob(f.id);
            const friendly = (f.name || 'sample').replace(/\.[^.]+$/, '');
            const reg = await registerSampleFromBlob(blob, friendly);
            lastId = reg.id; lastName = reg.name; ok++;
          } catch (e) { console.warn('Drive sample import failed for', f.name, e); }
        }
        if (prog2) { prog2.markDone(); prog2.close(); }
        if (ok && lastId && typeof onLoaded === 'function') onLoaded(lastId, lastName);
        if (ok && typeof showToast === 'function') showToast('Imported ' + ok + ' sample' + (ok === 1 ? '' : 's') + ' from “' + folder + '”.');
        else if (!ok) alert('No samples could be imported from “' + folder + '”.');
      } catch (e) {
        if (progress) progress.close();
        console.error('Drive sample import failed', e);
        alert('Drive import failed: ' + ((e && e.message) || e));
      }
    }

    // Scale a chord note's params so N simultaneous voices sum to a roughly
    // single-voice loudness, keeping the master limiter from being driven
    // hard enough to clip the waveform into audible harmonic distortion.
    //
    // Tonal synth voices (sine/FM/AM/etc.) sum near-coherently — a pure
    // 4-voice sine chord peaks at +6 dB even with 1/√N scaling, which is
    // exactly what makes the -1 dB limiter audibly distort. Use 1/N so
    // the summed peak lands at ~single-voice level (≈0 dB) and the
    // limiter only kisses the very tips. Percussive / sample voices have
    // incoherent peaks that sum more like RMS, so 1/√N is correct there
    // and dropping further would just bury them.
    function chordVoiceParams(noteParams, chordSize, step) {
      const base = (noteParams && typeof noteParams === 'object') ? noteParams : (typeof noteParams === 'string' ? { type: noteParams } : {});
      const baseVol = base.volume ?? 100;
      const type = base.type || 'sine';
      const N = Math.max(1, chordSize);
      // RMS-style 1/√N voice scaling for ALL tones now. The previous
      // 1/N path for synths was too conservative — at typical 3–5 note
      // chord sizes each voice landed at 20–33 % of its solo volume, so
      // sequenced chords audibly dropped below grid taps (which skip
      // this normalization entirely). 1/√N matches the RMS sum of
      // uncorrelated voices and is what every other chord path in the
      // file (percussive, sampled) already uses.
      const scale = 1 / Math.sqrt(N);
      const out = { ...base, volume: baseVol * scale };
      // Chord-wide pan override: only applies when explicitly set to a
      // non-center value. At center (0 or absent), individual voice
      // pans pass through untouched, so a stereo-spread chord keeps
      // its per-voice positioning until the user actively dials the
      // master Pan slider to one side.
      if (step && Number.isFinite(step.chordPan) && step.chordPan !== 0) {
        out.pan = step.chordPan;
      }
      return out;
    }

    // Convert a Tone-style note value ('4n', '8n.', '16t', '2n', '1n', etc.)
    // to seconds at the given BPM, assuming a 4/4 quarter-note pulse.
    // Suffix . = dotted (×1.5), t = triplet (×2/3). Used by per-note
    // delay sync so the user can lock delay time to musical divisions.
    function noteValueToSec(notation, bpm) {
      const m = String(notation || '').match(/^(\d+)n([.t]?)$/);
      if (!m) return 0.25; // sane fallback if the string is malformed
      const denom = parseInt(m[1], 10);
      let beats = 4 / denom; // 4n = 1 beat, 8n = 0.5, 2n = 2, 1n = 4
      const sfx = m[2];
      if (sfx === '.') beats *= 1.5;
      else if (sfx === 't') beats *= 2 / 3;
      return Math.max(0.001, beats * (60 / (bpm || 120)));
    }

    // Fold a step-level bend into the per-note params object that playNote
    // expects, leaving non-bending steps' params untouched. The bend always
    // applies as a relative semitone offset so chord notes glide together.
    function paramsWithBend(noteParams, bend) {
      const base = (noteParams && typeof noteParams === 'object')
        ? { ...noteParams }
        : { type: typeof noteParams === 'string' ? noteParams : 'sine' };
      if (bend && Number.isFinite(bend.semitones) && bend.semitones !== 0) {
        base.bend = { semitones: bend.semitones, atFraction: bend.atFraction };
      }
      return base;
    }

    // Quick fade-to-silence then dispose. Calling synth.dispose() while
    // any signal is still flowing through it (release tail not fully at
    // -inf yet) produces a tiny click as the node disconnects mid-sample.
    // Across many loop iterations, those click positions drift within the
    // audio render quantum and surface as the "artifacts that change per
    // iteration" the user hears. Ramp volume to ~silence over 30ms first,
    // dispose 50ms later — the ramp guarantees zero discontinuity at
    // disconnect.
    function safeDisposeSynth(synth) {
      if (!synth) return;
      try {
        if (synth.volume && typeof synth.volume.rampTo === 'function') {
          synth.volume.rampTo(-80, 0.03);
          setTimeout(() => { try { synth.dispose(); } catch (e) {} }, 60);
        } else {
          synth.dispose();
        }
      } catch (e) {}
    }

    // === Voice pool (Phase 1: synth bodies only) ===
    // Bloops's hot path builds a fresh Tone synth per trigger, then disposes
    // ~100ms after the release tail ends. At Poly-mode density (multi-lane
    // × chord × 1/16) that's tens of constructions/sec — GC pressure that
    // shows up as the "audio gets weird the longer it loops" drift behind
    // ↻ Audio. Phase 1 pools the synth body for 14 common preset types; FX
    // chains stay per-note for now. Pluck/Noise/Duo/Wavetable/Grain/Kick/
    // Metal still construct per note — they're rarer or have unique APIs.
    // Pool is bypassed during offline export rendering since the offline
    // AudioContext can't host synths constructed in the live context.
    //
    // KILL SWITCH: set to false to bypass the pool entirely (back to the
    // pre-pool behavior — fresh synth per note). Live debug toggle.
    const VOICE_POOL_ENABLED = true;
    const VOICE_POOL_MAX_PER_PRESET = 8;
    const voicePools = new Map(); // preset key → { idle: [Tone synth] }
    function _ensurePool(key) {
      let p = voicePools.get(key);
      if (!p) { p = { idle: [] }; voicePools.set(key, p); }
      return p;
    }
    function _acquirePooledSynth(key, factory) {
      const v = _ensurePool(key).idle.pop();
      if (v) return v;
      try { return factory(); }
      catch (e) { console.warn('voice factory failed', key, e); return null; }
    }
    function _releasePooledSynth(key, synth) {
      if (!synth) return;
      const p = _ensurePool(key);
      // Disconnect FIRST, then reset volume/detune. Resetting volume to unity
      // (0 dB) while the synth is still wired to the lane bus snaps a still-
      // ringing oscillator's residual back to full level — a step that pops
      // audibly on a pure tone (sine). With the node already disconnected the
      // reset produces no output. (safeReleaseSynth has ramped to -80 dB, so
      // the disconnect itself lands at near-silence.)
      try { synth.disconnect(); } catch (e) {}
      try {
        if (synth.volume) { synth.volume.cancelScheduledValues(0); synth.volume.value = 0; }
        if (synth.detune) { synth.detune.cancelScheduledValues(0); synth.detune.value = 0; }
      } catch (e) {}
      if (p.idle.length < VOICE_POOL_MAX_PER_PRESET) p.idle.push(synth);
      else { try { synth.dispose(); } catch (e) {} }
    }
    // Mirrors safeDisposeSynth, but releases to the pool instead of disposing.
    // Same -80 dB ramp + 60 ms wait so the disconnect lands at near-silence
    // (otherwise the FX-chain disconnect that follows clicks).
    function safeReleaseSynth(key, synth) {
      if (!synth) return;
      try {
        if (synth.volume && typeof synth.volume.rampTo === 'function') {
          synth.volume.rampTo(-80, 0.03);
          setTimeout(() => { _releasePooledSynth(key, synth); }, 60);
        } else {
          _releasePooledSynth(key, synth);
        }
      } catch (e) {}
    }
    function _isPooledPreset(type) {
      switch (type) {
        case 'bell': case 'fm': case 'xylo':
        case 'am': case 'pad':
        case 'mono': case 'bass':
        case 'sine': case 'square': case 'triangle': case 'sawtooth': case 'pulse': case 'fat':
          return true;
        default:
          return false;
      }
    }
    // Acquire a pre-configured synth for the given preset. Returns null
    // when the preset isn't pooled. Each preset gets its own pool key so
    // the only per-trigger work is setting envelope/detune for the note —
    // modulation/filter/oscillator config is reused across acquisitions.
    function _buildPooledSynthForPreset(preset, env) {
      switch (preset) {
        case 'bell': {
          const s = _acquirePooledSynth('bell', () => new Tone.FMSynth());
          if (!s) return null;
          s.harmonicity.value = 2.14;
          s.modulationIndex.value = 4;
          s.oscillator.type = 'sine';
          s.modulation.type = 'sine';
          s.envelope.set({ attack: 0.001, decay: 2.0, sustain: 0, release: 0.8 });
          s.modulationEnvelope.set({ attack: 0.001, decay: 0.5, sustain: 0.2, release: 0.5 });
          return s;
        }
        case 'fm': {
          const s = _acquirePooledSynth('fm', () => new Tone.FMSynth());
          if (!s) return null;
          s.harmonicity.value = 3;
          s.modulationIndex.value = 10;
          s.oscillator.type = 'sine';
          s.modulation.type = 'square';
          s.envelope.set(env);
          s.modulationEnvelope.set({ attack: 0.5, decay: 0, sustain: 1, release: 0.5 });
          return s;
        }
        case 'xylo': {
          const s = _acquirePooledSynth('xylo', () => new Tone.FMSynth());
          if (!s) return null;
          s.harmonicity.value = 7;
          s.modulationIndex.value = 4;
          s.oscillator.type = 'sine';
          s.modulation.type = 'sine';
          s.envelope.set({ attack: 0.001, decay: 0.5, sustain: 0, release: 0.3 });
          s.modulationEnvelope.set({ attack: 0.001, decay: 0.2, sustain: 0, release: 0.2 });
          return s;
        }
        case 'am': {
          const s = _acquirePooledSynth('am', () => new Tone.AMSynth());
          if (!s) return null;
          s.harmonicity.value = 2;
          s.oscillator.type = 'sine';
          s.modulation.type = 'square';
          s.envelope.set(env);
          s.modulationEnvelope.set({ attack: 0.5, decay: 0, sustain: 1, release: 0.5 });
          return s;
        }
        case 'pad': {
          const s = _acquirePooledSynth('pad', () => new Tone.AMSynth());
          if (!s) return null;
          s.harmonicity.value = 1.5;
          s.oscillator.type = 'sine';
          s.modulation.type = 'sine';
          s.envelope.set({ attack: 1.2, decay: 0.5, sustain: 0.7, release: 2.5 });
          s.modulationEnvelope.set({ attack: 1.0, decay: 0.5, sustain: 0.5, release: 2.0 });
          return s;
        }
        case 'mono': {
          const s = _acquirePooledSynth('mono', () => new Tone.MonoSynth());
          if (!s) return null;
          s.oscillator.type = 'sawtooth';
          s.envelope.set(env);
          s.filterEnvelope.set({ attack: 0.01, decay: 0.3, sustain: 0.3, release: 2, baseFrequency: 200, octaves: 3 });
          s.filter.set({ Q: 6, type: 'lowpass', rolloff: -24 });
          return s;
        }
        case 'bass': {
          const s = _acquirePooledSynth('bass', () => new Tone.MonoSynth());
          if (!s) return null;
          s.oscillator.type = 'square';
          s.envelope.set(env);
          s.filterEnvelope.set({ attack: 0.005, decay: 0.18, sustain: 0.4, release: 0.4, baseFrequency: 80, octaves: 3.2 });
          s.filter.set({ Q: 4, type: 'lowpass', rolloff: -24 });
          return s;
        }
        case 'sine':
        case 'square':
        case 'triangle':
        case 'sawtooth':
        case 'pulse':
        case 'fat': {
          const s = _acquirePooledSynth('basic:' + preset, () => new Tone.Synth());
          if (!s) return null;
          if (preset === 'fat')        s.oscillator.set({ type: 'fatsawtooth', count: 3, spread: 30 });
          else if (preset === 'pulse') s.oscillator.set({ type: 'pulse', width: 0.4 });
          else                          s.oscillator.type = preset;
          s.envelope.set(env);
          return s;
        }
      }
      return null;
    }

    // Voice cap — limits simultaneous synth voices to keep the master
    // limiter from being driven into IM artifacts by overlapping release
    // tails. When a new voice would push the count over the cap, the
    // OLDEST active voice is stolen: its release is forced via
    // safeDisposeSynth (rampTo(-80) over ~30ms, then dispose), so the
    // perceived effect is "the quietest tail fades out a little earlier
    // than it would have decayed naturally." Per-note effect chains are
    // disposed alongside the stolen voice so their reverb/delay tail
    // stops with the source.
    //
    // Sample-type voices aren't tracked here — Tone.Sampler manages its
    // own internal polyphony. Warm-up synths (warmMasterChainOnce) and
    // sustain handles (startSustainedNote) also bypass this — they have
    // their own lifetimes and aren't a sequence-density problem.
    // 24 was fine on desktop but multi-lane looped playback at fast
    // subdivisions piles up enough concurrent voices on mobile Safari
    // to drive iOS into audio-thread underruns ("chops" over time). iOS
    // stays at 16 (still covers a five-voice chord across three lanes with
    // headroom and keeps the simultaneous-FX node count low enough to
    // sustain over long sessions); desktop gets the roomier 24 back —
    // a rich Bloom patch (bed + motif + texture + drone + pedal + arp …)
    // genuinely needs more than 16 concurrent voices, and starving it at 16
    // forced constant steals of the sustaining foundation (see _pickVoiceVictim).
    const _IS_IOS_LIKE = (() => {
      try {
        const ua = navigator.userAgent || '';
        if (/iPad|iPhone|iPod/.test(ua)) return true;
        // iPadOS 13+ reports as desktop Safari — detect via touch + Mac platform.
        return /Macintosh/.test(ua) && (navigator.maxTouchPoints | 0) > 1;
      } catch (e) { return false; }
    })();
    const VOICE_CAP = _IS_IOS_LIKE ? 16 : 24;
    const _activeVoices = []; // FIFO; oldest at index 0
    // Pick which voice to shed when over the cap. Stealing the OLDEST voice
    // unconditionally chops the long-sustaining FOUNDATION (bed / drone / pedal
    // pads start earliest, so they're always at index 0) every time a rapid short
    // layer fires. But "anything in its release tail" over-corrects the other way:
    // a short layer's notes (arp / texture / motif) enter release almost
    // immediately, so they'd get culled the instant they start — arp goes silent,
    // texture turns sparse/erratic. So score by how FAR a voice has DECAYED
    // (fraction of its release elapsed): steal the MOST-decayed (closest to
    // silent) voice — a freshly-released loud note scores ~0 and is spared, a tail
    // that's nearly rung out scores ~1 and goes first. A still-sustaining pad
    // isn't in release at all, so it's only taken when nothing is decaying (the
    // genuinely dense all-sustaining case → fall back to the oldest).
    // relAtCtx = time release begins; relDur = release length (seconds).
    function _pickVoiceVictim() {
      const now = (typeof Tone !== 'undefined' && Tone.context) ? Tone.context.now() : 0;
      let bestIdx = -1, bestFrac = -1;
      for (let i = 0; i < _activeVoices.length; i++) {
        const v = _activeVoices[i];
        const rs = v.relAtCtx;
        if (!Number.isFinite(rs) || rs > now) continue;          // still sustaining/attacking → spare
        const rd = Number.isFinite(v.relDur) ? v.relDur : 0;
        const frac = rd > 0.001 ? Math.min(1, (now - rs) / rd) : 1; // 0 = just released, 1 = rung out
        if (frac > bestFrac) { bestFrac = frac; bestIdx = i; }
      }
      return bestIdx >= 0 ? bestIdx : 0; // nothing decaying → oldest
    }
    function _registerVoice(entry) {
      _activeVoices.push(entry);
      // Voice stealing is meaningful only during LIVE playback, where
      // overlapping release tails can drive the master limiter into
      // IM crunch. During offline export rendering we schedule every
      // voice up front (no real-time pacing), so capping at 24 just
      // ramps every voice past the cap to -80 dB at offline t=0 —
      // which silently kills the entire render except the last 24
      // voices. Bypass the cap when an offline render is in flight.
      if (_offlineSamplerOverride) return;
      while (_activeVoices.length > VOICE_CAP) {
        const idx = _pickVoiceVictim();
        const victim = _activeVoices.splice(idx, 1)[0];
        if (!victim) break;
        _stealVoice(victim);
      }
    }
    function _unregisterVoice(entry) {
      const i = _activeVoices.indexOf(entry);
      if (i >= 0) _activeVoices.splice(i, 1);
    }
    // Voices dispatched with a future start time (a whole Bloom phrase is fired
    // synchronously, every note carrying its own future startTime) must NOT
    // count toward the steal-cap until they actually SOUND. Registering them
    // immediately makes the cap treat the entire scheduled phrase as
    // concurrent and shed its earliest notes before they ever play — the
    // ensemble "cuts out after a split second, then one voice finishes the
    // phrase" bug (force-stacking an ensemble multiplies the voice count, so a
    // single locked-ensemble phrase blows past VOICE_CAP at dispatch). Defer
    // far-ahead voices to their start; near-immediate voices (live presses,
    // the sequencer's ~100 ms lookahead) register right away as before. A stop
    // cancels anything still pending via silenceActiveVoices.
    const _VOICE_DEFER_MS = 150;
    const _pendingVoices = new Set();
    function _registerVoiceAtStart(entry, leadMs) {
      // Tag with the Bloom layer key + scheduled start time (when emitted inside a
      // Bloom layer) so a unit Lock / edit can cancel just this layer's
      // scheduled-ahead voices — optionally only those AT/AFTER a boundary.
      try {
        const tagged = (typeof window !== 'undefined' && window._ambCaptureSink);
        entry._ak = tagged ? (window._ambEmitKey || null) : null;
        entry._akAt = (tagged && Number.isFinite(window._ambEmitAt)) ? window._ambEmitAt : null;
      } catch (e) {}
      if (Number.isFinite(leadMs) && leadMs > _VOICE_DEFER_MS) {
        _pendingVoices.add(entry);
        entry.registerTimer = setTimeout(() => {
          entry.registerTimer = null;
          _pendingVoices.delete(entry);
          if (!entry._stolen) _registerVoice(entry);
        }, leadMs);
      } else {
        _registerVoice(entry);
      }
    }
    function _stealVoice(entry) {
      if (!entry || entry._stolen) return;
      entry._stolen = true;
      if (entry.registerTimer) { clearTimeout(entry.registerTimer); entry.registerTimer = null; }
      _pendingVoices.delete(entry);
      if (entry.disposeTimer) {
        clearTimeout(entry.disposeTimer);
        entry.disposeTimer = null;
      }
      if (entry.pooledPreset) {
        try { safeReleaseSynth(entry.pooledPreset, entry.synth); } catch (e) {}
      } else {
        try { safeDisposeSynth(entry.synth); } catch (e) {}
      }
      // Wait out safeDisposeSynth's fade (~60ms) before tearing down the
      // effect chain so the rampTo doesn't ring through a dead chain.
      setTimeout(() => {
        if (Array.isArray(entry.effectNodes)) {
          entry.effectNodes.forEach(n => { try { n.dispose(); } catch (e) {} });
        }
      }, 80);
    }

    // ---- Immediate silence ---------------------------------------------
    // Scheduled (playback) sample voices built by playNote are tracked here
    // so a user "stop" can cut them at once. HELD voices (live cell presses
    // via startSustainedNote) are deliberately NOT tracked — they belong to
    // the user's fingers, not to playback, and a stop shouldn't cut them.
    const _activeSampleVoices = new Set();
    // Live polyphony cap for scheduled sample voices. Each voice is a fresh
    // BufferSource→envelope→gain graph, so a dense Bloom stack (several layers ×
    // overlapping long notes) can pile up enough concurrent voices to overload
    // the audio render thread and glitch. Under the cap nothing changes; over
    // it, shed the OLDEST still-ringing voice (Set keeps insertion order, so the
    // first entry is the earliest-started — usually already in its release tail)
    // with a click-free fast kill. Held/sustained user notes aren't tracked here.
    const MAX_SAMPLE_VOICES = 48;
    // Same scheduled-ahead deferral as the synth path: a Bloom phrase fires
    // every sample voice up front with a future start, so counting them all
    // immediately would shed the phrase's earliest notes. Far-ahead sample
    // voices wait here until their start; a stop drains this set too.
    const _pendingSampleVoices = new Set();
    function _registerSampleVoiceAtStart(v, leadMs) {
      try {
        const tagged = (typeof window !== 'undefined' && window._ambCaptureSink);
        v._ak = tagged ? (window._ambEmitKey || null) : null;
        v._akAt = (tagged && Number.isFinite(window._ambEmitAt)) ? window._ambEmitAt : null;
      } catch (e) {}
      if (Number.isFinite(leadMs) && leadMs > _VOICE_DEFER_MS) {
        _pendingSampleVoices.add(v);
        v.registerTimer = setTimeout(() => {
          v.registerTimer = null;
          _pendingSampleVoices.delete(v);
          if (!v._killed) _registerSampleVoice(v);
        }, leadMs);
      } else {
        _registerSampleVoice(v);
      }
    }
    // Release-aware victim pick for the sample pool — same decay-fraction scoring
    // as the synth path's _pickVoiceVictim: steal the MOST-decayed (closest to
    // silent) voice so a sustaining sampled pad (bed / pedal) isn't chopped and a
    // freshly-released short note isn't culled before it sounds. relAtCtx / relDur
    // are stamped at registration; nothing decaying → fall back to the oldest.
    function _pickSampleVictim() {
      const now = (typeof Tone !== 'undefined' && Tone.context) ? Tone.context.now() : 0;
      let best = null, bestFrac = -1;
      for (const v of _activeSampleVoices) {
        const rs = v.relAtCtx;
        if (!Number.isFinite(rs) || rs > now) continue;          // still sustaining → spare
        const rd = Number.isFinite(v.relDur) ? v.relDur : 0;
        const frac = rd > 0.001 ? Math.min(1, (now - rs) / rd) : 1;
        if (frac > bestFrac) { bestFrac = frac; best = v; }
      }
      return best || _activeSampleVoices.values().next().value || null; // none decaying → oldest
    }
    function _registerSampleVoice(v) {
      if (!v) return;
      while (_activeSampleVoices.size >= MAX_SAMPLE_VOICES) {
        const victim = _pickSampleVictim();
        if (!victim) break;
        _activeSampleVoices.delete(victim);
        try { _killSampleVoiceFast(victim); } catch (e) {}
      }
      _activeSampleVoices.add(v);
    }
    function _unregisterSampleVoice(v) { if (v) _activeSampleVoices.delete(v); }
    // Fast, click-free kill of one sample voice: ramp its output to silence
    // over ~22 ms, then dispose. Cancels any pending natural-disposal timer.
    function _killSampleVoiceFast(v) {
      if (!v || v._killed) return;
      v._killed = true;
      if (v.registerTimer) { clearTimeout(v.registerTimer); v.registerTimer = null; }
      _pendingSampleVoices.delete(v);
      if (v.disposeTimer) { clearTimeout(v.disposeTimer); v.disposeTimer = null; }
      const now = (typeof Tone !== 'undefined' && Tone.context) ? Tone.context.now() : 0;
      try {
        if (v.outGain && v.outGain.gain && typeof v.outGain.gain.cancelScheduledValues === 'function') {
          v.outGain.gain.cancelScheduledValues(now);
          v.outGain.gain.setValueAtTime(v.outGain.gain.value, now);
          v.outGain.gain.linearRampToValueAtTime(0, now + 0.022);
        }
      } catch (e) {}
      try { if (v.source) v.source.stop(now + 0.03); } catch (e) {}
      setTimeout(() => _disposeSampleAdsrVoice(v), 60);
    }
    // Fade a sample voice out STARTING at a boundary time (atSec): hold its current
    // level until the boundary, then ramp to ~0 over fadeSec. Used to truncate a sample
    // that overruns a unit/area boundary with a user-set fade (vs the abrupt fast kill).
    function _fadeSampleVoiceFrom(v, atSec, fadeSec) {
      if (!v || v._killed) return;
      if (!(fadeSec > 0)) { _killSampleVoiceFast(v); return; }   // 0 → hard cut
      v._killed = true;
      if (v.registerTimer) { clearTimeout(v.registerTimer); v.registerTimer = null; }
      _pendingSampleVoices.delete(v); _activeSampleVoices.delete(v);
      if (v.disposeTimer) { clearTimeout(v.disposeTimer); v.disposeTimer = null; }
      const now = (typeof Tone !== 'undefined' && Tone.context) ? Tone.context.now() : 0;
      const start = Math.max(now, atSec || now);
      try {
        if (v.outGain && v.outGain.gain && typeof v.outGain.gain.cancelScheduledValues === 'function') {
          const g = v.outGain.gain;
          g.cancelScheduledValues(now);
          g.setValueAtTime(g.value, now);
          g.setValueAtTime(g.value, start);
          g.linearRampToValueAtTime(0.0001, start + fadeSec);
        }
      } catch (e) {}
      try { if (v.source) v.source.stop(start + fadeSec + 0.03); } catch (e) {}
      const ms = Math.max(0, (start + fadeSec - now) * 1000) + 80;
      setTimeout(() => _disposeSampleAdsrVoice(v), ms);
    }
    // Fade every sample voice of `key` that started BEFORE the boundary `atSec` out over
    // fadeSec from that boundary (removing them from the active sets so a follow-up
    // stopBloomVoicesBefore won't also hard-kill them). fadeSec<=0 → plain stop.
    function fadeBloomSampleVoicesFrom(key, atSec, fadeSec) {
      if (!key) return;
      if (!(fadeSec > 0)) { if (typeof stopBloomVoicesBefore === 'function') stopBloomVoicesBefore(key, atSec); return; }
      const hit = (v) => v && v._ak === key && (Number.isFinite(v._akAt) ? v._akAt < atSec : true);
      Array.from(_pendingSampleVoices).forEach(v => { if (hit(v)) _fadeSampleVoiceFrom(v, atSec, fadeSec); });
      Array.from(_activeSampleVoices).forEach(v => { if (hit(v)) _fadeSampleVoiceFrom(v, atSec, fadeSec); });
    }
    // Immediately silence every SCHEDULED playback voice — synths (a ~30 ms
    // safeDisposeSynth fade) and per-note samples (a ~22 ms ramp). Both are
    // click-free, so "immediate" doesn't mean a hard cut/pop. Called by every
    // user stop gesture (transport stop, Bloom stop) so release tails don't
    // keep ringing after the user asked for silence.
    // Cancel a Bloom layer's already-scheduled-ahead (pending, not-yet-sounding)
    // voices — used by Unit Lock so a freshly locked layer's next-unit, already
    // queued in the lookahead, is dropped and the locked unit takes over cleanly.
    // Only touches PENDING (future) voices, never what's currently sounding.
    // Cancel a Bloom layer's scheduled-ahead (not-yet-started) voices. With
    // `fromAt`, cancel ONLY voices whose scheduled start is at/after it (keeps the
    // currently-sounding iteration intact) — used so an edit re-does just the NEXT
    // iteration. Untagged voices (no start time) are kept when thresholding.
    function cancelBloomFutureVoices(key, fromAt) {
      if (!key) return;
      const hit = (e) => e && e._ak === key && (fromAt == null || (Number.isFinite(e._akAt) && e._akAt >= fromAt));
      Array.from(_pendingVoices).forEach(e => { if (hit(e)) { _pendingVoices.delete(e); try { _stealVoice(e); } catch (x) {} } });
      Array.from(_pendingSampleVoices).forEach(v => { if (hit(v)) { _pendingSampleVoices.delete(v); try { _killSampleVoiceFast(v); } catch (x) {} } });
      // Sample / pad voices register as ACTIVE immediately even when scheduled ahead,
      // so a voice scheduled to START at/after `fromAt` sits in the ACTIVE sets, not the
      // pending ones. It hasn't sounded yet (future start), so cancel it too — else it
      // begins after the boundary and bleeds into the next area (and piles up across
      // transitions = "samples run over and get louder"). _akAt >= fromAt = not-yet-sounded.
      for (let i = _activeVoices.length - 1; i >= 0; i--) { const e = _activeVoices[i]; if (hit(e)) { _activeVoices.splice(i, 1); try { _stealVoice(e); } catch (x) {} } }
      Array.from(_activeSampleVoices).forEach(v => { if (hit(v)) { _activeSampleVoices.delete(v); try { _killSampleVoiceFast(v); } catch (x) {} } });
      Array.from(_activePadVoices).forEach(r => { if (hit(r)) { _activePadVoices.delete(r); try { r.kill && r.kill(); } catch (x) {} } });
    }
    // Stop a Bloom layer's CURRENTLY-SOUNDING + pending voices whose start is BEFORE
    // `beforeAt` (the OUTGOING area's voices — the incoming area's start at/after the
    // boundary, so they're spared). Used at an area transition to GUARANTEE a departing
    // layer goes silent, regardless of routing: the gate-fade only silences gate-routed
    // voices, this also stops looping pad voices and anything that slipped the gate.
    function stopBloomVoicesBefore(key, beforeAt) {
      if (!key) return;
      const hit = (e) => e && e._ak === key && (beforeAt == null || (Number.isFinite(e._akAt) && e._akAt < beforeAt));
      Array.from(_pendingVoices).forEach(e => { if (hit(e)) { _pendingVoices.delete(e); try { _stealVoice(e); } catch (x) {} } });
      for (let i = _activeVoices.length - 1; i >= 0; i--) { const e = _activeVoices[i]; if (hit(e)) { _activeVoices.splice(i, 1); try { _stealVoice(e); } catch (x) {} } }
      Array.from(_pendingSampleVoices).forEach(v => { if (hit(v)) { _pendingSampleVoices.delete(v); try { _killSampleVoiceFast(v); } catch (x) {} } });
      Array.from(_activeSampleVoices).forEach(v => { if (hit(v)) { _activeSampleVoices.delete(v); try { _killSampleVoiceFast(v); } catch (x) {} } });
      Array.from(_activePadVoices).forEach(r => { if (hit(r)) { _activePadVoices.delete(r); try { r.kill && r.kill(); } catch (x) {} } });
    }
    function silenceActiveVoices() {
      // Drain pending (scheduled-ahead, not-yet-registered) voices too — a stop
      // must cancel notes the Bloom phrase dispatched for the near future, or
      // they'd register at their start time and ring on after the user stopped.
      const pendVictims = Array.from(_pendingVoices);
      _pendingVoices.clear();
      pendVictims.forEach(v => { try { _stealVoice(v); } catch (e) {} });
      const synthVictims = _activeVoices.splice(0, _activeVoices.length);
      synthVictims.forEach(v => { try { _stealVoice(v); } catch (e) {} });
      const pendSampVictims = Array.from(_pendingSampleVoices);
      _pendingSampleVoices.clear();
      pendSampVictims.forEach(v => { try { _killSampleVoiceFast(v); } catch (e) {} });
      const sampVictims = Array.from(_activeSampleVoices);
      _activeSampleVoices.clear();
      sampVictims.forEach(v => { try { _killSampleVoiceFast(v); } catch (e) {} });
      // Pad voices (native looping graphs) — cut them too.
      const padVictims = Array.from(_activePadVoices);
      _activePadVoices.clear();
      padVictims.forEach(r => { try { r.kill && r.kill(); } catch (e) {} });
    }

    // Click-and-hold sustain — start an attack on pointerdown, release on
    // pointerup. Returns a handle with .release(); the caller is expected
    // to call it exactly once. One-shot voices (pluck / kick / metal /
    // samples without a clean release) fall back to a normal short hit.
    // Held (sustained) ensemble: start one sustained member voice per member
    // and return a composite { release } that releases them together.
    function _startSustainedEnsemble(freq, params, startAt) {
      const id = params.type.slice(9);
      const def = ensembles.get(id);
      if (!def || !Array.isArray(def.members) || !def.members.length) {
        return startSustainedNote(freq, { ...params, type: 'sine' }, startAt);
      }
      const mode = def.mode || 'stack';
      const useOffsets = (mode !== 'stack');
      let members = def.members;
      if (mode === 'rr') {
        const i = (_ensembleRR[id] | 0) % members.length;
        _ensembleRR[id] = (i + 1) % members.length;
        members = [members[i]];
      }
      const handles = [];
      members.forEach(m => {
        if (!m || isEnsembleType(m.type)) return;
        const p = { ...params };
        p.type = m.type || 'sine';
        ['attack', 'decay', 'sustain', 'release'].forEach(k => { if (Number.isFinite(m[k])) p[k] = m[k]; });
        let f = freq;
        if (useOffsets) {
          if (Number.isFinite(m.octave) && m.octave) f = freq * Math.pow(2, m.octave);
          if (Number.isFinite(m.detune) && m.detune) p.detune = (p.detune || 0) + m.detune;
          if (Number.isFinite(m.pan)) p.pan = m.pan;
          if (Number.isFinite(m.level)) { const base = (p.volume != null ? p.volume : 100); p.volume = Math.max(0, Math.min(100, Math.round(base * (m.level / 100)))); }
        }
        delete p._detuneMod;
        try { const h = startSustainedNote(f, p, startAt); if (h) handles.push(h); } catch (e) {}
      });
      return {
        release: () => handles.forEach(h => { try { h && h.release && h.release(); } catch (e) {} }),
        setDetune: (c) => handles.forEach(h => { try { h && h.setDetune && h.setDetune(c); } catch (e) {} }),
      };
    }
    function startSustainedNote(freq, params = {}, startAt) {
      // Cold-start guard — same race as playNote. Optional `startAt`
      // (Tone audio time) lets multi-voice wrap auditions pin every
      // voice to the same instant; without it, each voice computes its
      // own Tone.now() during iteration and ends up scheduled a few ms
      // apart, sounding rolled rather than chordal. The cushion only
      // applies when the context is actually suspended (iOS auto-
      // suspends after idle time); a warm context fires triggerAttack
      // at Tone.now() and skips the extra delay so press-to-sound
      // latency on the second and later presses matches the audio
      // engine's natural lookAhead.
      let _coldStartAt = startAt;
      try {
        const ac = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
          ? Tone.context.rawContext : null;
        if (ac && ac.state === 'suspended' && _coldStartAt == null) {
          try { ac.resume(); } catch (e) {}
          if (typeof Tone.now === 'function') _coldStartAt = Tone.now() + 0.05;
        }
      } catch (e) {}

      // Low-latency trigger time for a warm interactive press: the raw
      // AudioContext.currentTime, NOT Tone.now() — Tone.now() adds the 25 ms
      // scheduling lookAhead, which is pure latency for a touch-driven note.
      // (The synth branch already does this inline; sampler / grain /
      // wavetable presses used to fall back to Tone.now(), so the DEFAULT
      // sample:piano cell paid the extra 25 ms on every tap.) Honors a pinned
      // startAt / cold-start shift via _coldStartAt when present.
      const _warmAt = () => {
        if (_coldStartAt != null) return _coldStartAt;
        try {
          const ac = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
            ? Tone.context.rawContext : null;
          if (ac) return ac.currentTime;
        } catch (e) {}
        return (typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0;
      };

      if (typeof params === 'string') params = { type: params };
      // "User" Design patches resolve to their stored base voice + params,
      // exactly like playNote does. Without this, a sustained GRID PRESS of a
      // user patch (cellParams.type === 'user:<id>') reached the oscillator
      // builder with that raw value and threw "invalid type: user:<id>", so
      // the press was silent — even though sequenced playback (via playNote,
      // which already resolves it) sounded fine. Done before the ensemble
      // check so a patch whose base voice is an ensemble still expands.
      if (typeof params.type === 'string' && params.type.indexOf('user:') === 0) {
        const _up = (typeof _resolveUserPatch === 'function') ? _resolveUserPatch(params.type) : null;
        if (_up) {
          const keep = {};
          ['bend', 'pan'].forEach(k => { if (params[k] != null) keep[k] = params[k]; });
          params = Object.assign({}, _up.params, { type: _up.baseType }, keep);
        } else {
          params = Object.assign({}, params, { type: 'sawtooth' }); // patch gone → audible fallback
        }
      }
      // Ensemble voice: hold one sustained voice per member, return a composite
      // handle that releases them together (the live-press / sustain path).
      if (isEnsembleType(params.type)) return _startSustainedEnsemble(freq, params, _coldStartAt);
      const {
        type = 'sine',
        attack = 10, decay = 100, sustain = 50, release = 1400, volume = 100, detune = 0,
        pan = 0,
        // Per-note FX mix levels — sustained cell press was destructuring
        // only env/volume/detune, so the per-cell reverb / delay / chorus
        // settings that scheduleStepAt → playNote applies during sequence
        // playback never reached the press path. Read every effect here
        // so the chain below can build the same per-note FX nodes (only
        // for effects with mix > 0 — silent ones cost nothing).
        reverb     = 0,
        reverbSize = 70,
        reverbTone = 50,
        delay         = 0,
        delayTime     = 250,
        delayFeedback = 40,
        delaySync     = null,
        distortion = 0,
        chorus     = 0, chorusFreq    = 4,   chorusDepth   = 70,
        vibrato    = 0, vibratoFreq   = 5,   vibratoDepth  = 30,
        tremolo    = 0, tremoloFreq   = 5,   tremoloDepth  = 70,
        phaser     = 0, phaserFreq    = 0.5, phaserOctaves = 3,
        autoFilter = 0, autoFilterFreq= 1,   autoFilterDepth = 100, autoFilterBaseFreq = 200,
        pingPong   = 0, pingPongTime  = 250, pingPongFeedback = 30, pingPongSync = null,
        autoPan    = 0, autoPanFreq   = 1,   autoPanDepth  = 100,
        fxOverrideGlobal = false,
      } = params;
      const atk = Math.max(attack / 1000, 0.005);
      const dec = Math.max(decay   / 1000, 0.01);
      const sus = Math.max(sustain / 100,  0.001);
      const rel = Math.max(release / 1000, 0.1);
      const env = { attack: atk, decay: dec, sustain: sus, release: rel };
      const velocity = Math.min(1, Math.max(0, volume / 100));

      // Sample types — Tone.Sampler supports triggerAttack/Release.
      if (isSampleType(type)) {
        // Grain is a special sample type: granular playback via
        // Tone.GrainPlayer rather than Tone.Sampler. Press-and-hold
        // sustains the player; release() stops + disposes it.
        if (type === 'sample:grain') {
          const grainInfo = sampleSamplers.get('grain');
          if (!grainInfo || !grainInfo.buffer) {
            return startSustainedNote(freq, { ...params, type: 'sine' }, startAt);
          }
          const baseFreq = grainInfo.baseFreq || 440;
          const cents = (typeof freq === 'number' && freq > 0)
            ? 1200 * Math.log2(freq / baseFreq) + (detune || 0)
            : (detune || 0);
          const rawRate = Number.isFinite(params.grainRate) ? params.grainRate : 1;
          const playbackRate = (Math.abs(rawRate) < 0.05) ? 0.05 * Math.sign(rawRate || 1) : rawRate;
          const rawBuffer = (grainInfo.buffer && typeof grainInfo.buffer.get === 'function')
            ? grainInfo.buffer.get() : null;
          const playerOpts = {
            grainSize: (params.grainSize != null) ? params.grainSize : 0.1,
            overlap:   (params.grainOverlap != null) ? params.grainOverlap : 0.05,
            playbackRate,
            detune: cents,
            loop: true,
            volume: Tone.gainToDb(Math.max(0.001, velocity)),
          };
          playerOpts.url = rawBuffer || 'https://tonejs.github.io/audio/salamander/A4.mp3';
          const player = new Tone.GrainPlayer(playerOpts).connect(
            fxOverrideGlobal ? masterLimiter : globalSendTap
          );
          const triggerAt = _warmAt();
          const fire = () => { try { player.start(triggerAt); } catch (e) {} };
          if (player.loaded) fire();
          else if (typeof grainInfo.buffer?.loaded?.then === 'function') {
            grainInfo.buffer.loaded.then(fire, () => {});
          } else {
            setTimeout(fire, 50);
          }
          let released = false;
          return { release: () => {
            if (released) return; released = true;
            try { player.stop(); } catch (e) {}
            setTimeout(() => { try { player.dispose(); } catch (e) {} }, 500);
          }};
        }
        const entry = getSampleEntry(type);
        if (!entry || !entry.sampler || !entry.sampler.loaded) {
          // Sampler hasn't finished its network fetch yet — the most
          // common cause of "first taps make no sound" on a cold load,
          // since the default tone is sample:piano. Fall back to a
          // Tone.Synth sine sustain so the press is audible and held;
          // the next press (likely a few hundred ms later) will use the
          // real sample.
          return startSustainedNote(freq, { ...params, type: 'sine' }, startAt);
        }
        const baseFreq = snapDrumKitFreq(type, freq);
        const tunedFreq = (typeof baseFreq === 'number') ? baseFreq * Math.pow(2, detune / 1200) : baseFreq;
        const sampleDest = fxOverrideGlobal ? masterLimiter : globalSendTap;
        // Pad-imported samples use the dedicated single-buffer looping voice.
        if ((sampleSamplers.get(type.slice(7)) || {}).padLoop) {
          const padH = _startPadVoice(type.slice(7), tunedFreq, env, sampleDest, velocity, _warmAt(), { pan });
          if (padH) return padH;
        }
        // Full-ADSR held voice: attack → decay → sustain (held), then release
        // on pointer-up — the sound editor's full envelope (+ optional filter)
        // shapes the held sample, not just a fade in/out. Tuned (non-drum)
        // samples LOOP seamlessly by default so a held note sustains past the
        // buffer instead of cutting off; drums and per-note-filtered samples
        // stay one-shot.
        const _si = sampleSamplers.get(type.slice(7)) || {};
        const _wantLoop = (params.loop || !_si.drumKit) && !Number.isFinite(params.filterCutoff);
        const v = _buildSampleAdsrVoice(entry.sampler, type.slice(7), tunedFreq, env, sampleDest,
          { filterCutoff: params.filterCutoff, filterQ: params.filterQ, pan, loop: _wantLoop });
        if (v) {
          const triggerAt = _warmAt();
          try {
            v.source.start(triggerAt);
            _applyVoiceLoop(v);
            v.ampEnv.triggerAttack(triggerAt, velocity);
          } catch (e) { _disposeSampleAdsrVoice(v); }
          let released = false;
          return { release: () => {
            if (released) return; released = true;
            try { v.ampEnv.triggerRelease(); } catch (e) {}
            setTimeout(() => _disposeSampleAdsrVoice(v), (Math.max(0.1, rel) + 0.3) * 1000);
          }};
        }
        // Fallback — shared sampler, attack/release fade only.
        try {
          if (typeof entry.sampler.attack  !== 'undefined') entry.sampler.attack  = Math.max(0, atk);
          if (typeof entry.sampler.release !== 'undefined') entry.sampler.release = Math.max(0.01, rel);
        } catch (e) {}
        try { entry.sampler.triggerAttack(tunedFreq, _warmAt(), velocity); } catch (e) {}
        let released = false;
        return { release: () => {
          if (released) return; released = true;
          try { entry.sampler.triggerRelease(tunedFreq, undefined); } catch (e) {}
        }};
      }

      // Pluck / kick / metal don't sustain naturally — fall through to a
      // short one-shot, no release work needed. Suppress the flashCell
      // active-loop outline so it doesn't fight the .sustaining
      // highlight during the press.
      if (type === 'pluck' || type === 'kick' || type === 'metal') {
        const prev = _suppressCellFlash;
        _suppressCellFlash = true;
        try { playNote(freq, params); }
        finally { _suppressCellFlash = prev; }
        return { release: () => {} };
      }

      const finalDest = fxOverrideGlobal ? masterLimiter : globalSendTap;
      // Per-note effect chain — mirrors the chain playNote builds for
      // sequence playback so a sustained press hears the same reverb,
      // delay, chorus, etc. the cell's params already specify. Built
      // backward from finalDest: chainHead is the synth's connect
      // target. effectNodes get disposed alongside the synth on
      // release so they don't leak.
      //
      // Fast path — when neither pan nor any FX is engaged we skip
      // the chain build entirely. Cells default to all zeros, so the
      // common cell-press path pays nothing for the FX support and
      // press-to-sound latency matches the pre-FX behaviour. The
      // _fxBuildersSus object below is only allocated when needed.
      let chainHead = finalDest;
      const sustainEffectNodes = [];
      const panNorm = Math.max(-1, Math.min(1, (pan || 0) / 100));
      const anyFxActive = (distortion > 0 || autoFilter > 0 || phaser > 0
        || vibrato > 0 || chorus > 0 || tremolo > 0 || delay > 0
        || pingPong > 0 || reverb > 0 || autoPan > 0);
      if (Math.abs(panNorm) > 0.001) {
        // Makeup gain so panning doesn't drop level (equal-power compensation).
        const mk = _panMakeup(panNorm);
        let tail = chainHead;
        if (mk > 1.001) { const g = new Tone.Gain(mk).connect(tail); sustainEffectNodes.unshift(g); tail = g; }
        const pn = new Tone.Panner(panNorm).connect(tail);
        sustainEffectNodes.unshift(pn);
        chainHead = pn;
      }
      const startLfo = (n) => { try { if (typeof n.start === 'function') n.start(); } catch (e) {} };
      const _bpm = (typeof tempoInput !== 'undefined' && tempoInput && tempoInput.value)
        ? (parseInt(tempoInput.value, 10) || 120)
        : 120;
      if (anyFxActive) {
        const _fxBuildersSus = {
          distortion: () => distortion > 0 ? new Tone.Distortion({
            distortion: Math.max(0, Math.min(1, distortion / 100)), wet: 1, oversample: '4x',
          }) : null,
          autoFilter: () => autoFilter > 0 ? new Tone.AutoFilter({
            frequency:     Math.max(0.01, autoFilterFreq),
            depth:         Math.max(0, Math.min(1, autoFilterDepth / 100)),
            baseFrequency: Math.max(20, autoFilterBaseFreq),
            octaves: 2.6,
            wet:     Math.max(0, Math.min(1, autoFilter / 100)),
          }) : null,
          phaser: () => phaser > 0 ? new Tone.Phaser({
            frequency: Math.max(0.01, phaserFreq),
            octaves:   Math.max(1, Math.min(7, phaserOctaves)),
            baseFrequency: 350,
            wet:       Math.max(0, Math.min(1, phaser / 100)),
          }) : null,
          vibrato: () => vibrato > 0 ? new Tone.Vibrato({
            frequency: Math.max(0.01, vibratoFreq),
            depth:     Math.max(0, Math.min(1, vibratoDepth / 100)),
            wet:       Math.max(0, Math.min(1, vibrato / 100)),
          }) : null,
          chorus: () => chorus > 0 ? new Tone.Chorus({
            frequency: Math.max(0.01, chorusFreq),
            depth:     Math.max(0, Math.min(1, chorusDepth / 100)),
            delayTime: 3.5, feedback: 0.1,
            wet:       Math.max(0, Math.min(1, chorus / 100)),
          }) : null,
          tremolo: () => tremolo > 0 ? new Tone.Tremolo({
            frequency: Math.max(0.01, tremoloFreq),
            depth:     Math.max(0, Math.min(1, tremoloDepth / 100)),
            wet:       Math.max(0, Math.min(1, tremolo / 100)),
          }) : null,
          delay: () => delay > 0 ? new Tone.FeedbackDelay({
            delayTime: delaySync
              ? noteValueToSec(delaySync, _bpm)
              : Math.max(0.001, (delayTime || 0) / 1000),
            feedback:  Math.max(0, Math.min(0.95, delayFeedback / 100)),
            wet:       Math.max(0, Math.min(1, delay / 100)),
          }) : null,
          pingPong: () => pingPong > 0 ? new Tone.PingPongDelay({
            delayTime: pingPongSync
              ? noteValueToSec(pingPongSync, _bpm)
              : Math.max(0.001, (pingPongTime || 0) / 1000),
            feedback:  Math.max(0, Math.min(0.95, pingPongFeedback / 100)),
            wet:       Math.max(0, Math.min(1, pingPong / 100)),
          }) : null,
          reverb: () => reverb > 0 ? new Tone.Freeverb({
            roomSize:  Math.max(0, Math.min(0.99, reverbSize / 100)),
            dampening: 500 + Math.max(0, Math.min(100, reverbTone)) * 95,
            wet:       Math.max(0, Math.min(1, reverb / 100)),
          }) : null,
          autoPan: () => autoPan > 0 ? new Tone.AutoPanner({
            frequency: Math.max(0.01, autoPanFreq),
            depth:     Math.max(0, Math.min(1, autoPanDepth / 100)),
            wet:       Math.max(0, Math.min(1, autoPan / 100)),
          }) : null,
        };
        const _fxOrderSus = (globalFx && Array.isArray(globalFx.fxOrder) && globalFx.fxOrder.length === FX_NAMES.length)
          ? globalFx.fxOrder
          : FX_NAMES;
        for (let i = _fxOrderSus.length - 1; i >= 0; i--) {
          const node = _fxBuildersSus[_fxOrderSus[i]]?.();
          if (!node) continue;
          startLfo(node);
          node.connect(chainHead);
          sustainEffectNodes.unshift(node);
          chainHead = node;
        }
      }
      const disposeSustainFxChain = () => {
        if (sustainEffectNodes.length === 0) return;
        sustainEffectNodes.forEach(n => { try { n.dispose(); } catch (e) {} });
      };
      let synth;
      // Voice pool — playNote already pulls pre-built synths for the
      // basic presets. The sustained-press path used to construct a
      // fresh Tone.AMSynth / FMSynth / MonoSynth per cell press, which
      // costs noticeable ms on mobile and shows up as press-to-sound
      // lag in the note grid. Pool acquisitions reuse a configured
      // synth body; we set the per-press env / detune below and route
      // the disconnect through safeReleaseSynth on release so it
      // returns to the pool instead of being disposed.
      // ---- Design voice chain (filter / mod / unison / sub / ring) ----------
      // Mirrors playNote so a sustained GRID/WRAP press of a Design patch
      // renders the SAME voice as its sequenced playback (it used to play only
      // the bare base oscillator, so lane and grid diverged in level/timbre).
      // Gated on _designVoice so plain cells keep their zero-cost fast path.
      // Held mode: filter-env / mod LFOs get a long dur so they reach and hold
      // their sustain; the amp envelope's release fades the whole voice on key
      // up. Every node is pushed onto sustainEffectNodes → disposed on release.
      const _sdOscD = (typeof _sdOscDesign === 'function') ? _sdOscDesign(params) : null;
      const _sdFreshVoice = (typeof _sdOscNeedsFreshVoice === 'function') && _sdOscNeedsFreshVoice(_sdOscD, type);
      const _designVoice = !!((params.filter && params.filter.on)
        || (params.filterEnv && params.filterEnv.on)
        || (params.modMatrix && params.modMatrix.length)
        || _sdFreshVoice);
      const _sdHeldDur = 3600; // ~"infinite" hold for held-press envelopes
      // Single start time for the WHOLE design voice (synth + filter env + sub +
      // ring + mod rig). A freshly-built design voice triggered at the raw
      // AudioContext currentTime can land in the past once the extra nodes are
      // built, which makes the amp envelope jump from 0 instantly = an onset
      // POP; it also left the filter env (which defaults to Tone.now()) running
      // ~one lookahead ahead of the synth. Use Tone.now() (the engine's 25 ms
      // lookahead) so every piece is scheduled together, slightly ahead, and
      // the graph is settled before audio starts. Plain cells keep raw-currentTime
      // low latency below — this cushion only applies to design voices.
      const _sdVoiceStart = (startAt != null) ? startAt
        : (_coldStartAt != null) ? _coldStartAt
        : ((typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0);
      let _sdVoiceFilter = null, _sdModPanner = null, _sdModGain = null, _sdRingGain = null, _sdSubEnv = null;
      if (_designVoice) {
        if (params.filter && params.filter.on && typeof _sdBuildVoiceFilter === 'function') {
          _sdVoiceFilter = _sdBuildVoiceFilter(params, { startTime: _sdVoiceStart, dur: _sdHeldDur, velocity });
          if (_sdVoiceFilter) { _sdVoiceFilter.connect(chainHead); sustainEffectNodes.unshift(_sdVoiceFilter); chainHead = _sdVoiceFilter; }
        }
        if (typeof _sdNeedsModPan === 'function' && _sdNeedsModPan(params)) {
          try { _sdModPanner = new Tone.Panner(0).connect(chainHead); sustainEffectNodes.unshift(_sdModPanner); chainHead = _sdModPanner; } catch (e) {}
        }
        if (typeof _sdNeedsModGain === 'function' && _sdNeedsModGain(params)) {
          try { _sdModGain = new Tone.Gain(1).connect(chainHead); sustainEffectNodes.unshift(_sdModGain); chainHead = _sdModGain; } catch (e) {}
        }
        if (_sdOscD && _sdOscD.ring > 0) {
          try { _sdRingGain = new Tone.Gain(1).connect(chainHead); sustainEffectNodes.unshift(_sdRingGain); chainHead = _sdRingGain; } catch (e) {}
        }
      }
      let pooledPresetKey = null;
      // Skip the pool for osc-design voices (unison / sub / ring) — they need a
      // freshly-built oscillator, exactly as playNote gates its pool.
      if (VOICE_POOL_ENABLED && !_sdFreshVoice && _isPooledPreset(type)) {
        const s = _buildPooledSynthForPreset(type, env);
        if (s) {
          try {
            s.connect(chainHead);
            synth = s;
            pooledPresetKey = (type === 'sine' || type === 'square' || type === 'triangle'
                              || type === 'sawtooth' || type === 'pulse' || type === 'fat')
              ? 'basic:' + type
              : type;
          } catch (e) {
            synth = null;
            pooledPresetKey = null;
          }
        }
      }
      if (synth) {
        // Already provided by the pool — skip the construction chain
        // and fall through to the trigger / handle plumbing below.
      } else if (type === 'fm') {
        synth = new Tone.FMSynth({
          harmonicity: (_sdOscD && _sdOscD.harmonicity != null) ? _sdOscD.harmonicity : 3,
          modulationIndex: (_sdOscD && _sdOscD.modIndex != null) ? _sdOscD.modIndex : 10,
          oscillator: { type: 'sine' }, envelope: env,
          modulation: { type: 'square' },
          modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 },
        }).connect(chainHead);
      } else if (type === 'duo') {
        // DuoSynth — Tone.OmniOscillator (used by Tone.Synth) doesn't
        // accept 'duo' as a type, so the generic fallback below silently
        // produced no sound on cell PRESS even though playNote handled
        // it correctly. Same params as the playNote duo branch.
        synth = new Tone.DuoSynth({
          voice0: { oscillator: { type: 'sine'    }, envelope: env },
          voice1: { oscillator: { type: 'sawtooth'}, envelope: env },
          harmonicity: (_sdOscD && _sdOscD.harmonicity != null) ? _sdOscD.harmonicity : 1.5,
          vibratoAmount: 0.3,
          vibratoRate: 5,
        }).connect(chainHead);
      } else if (type === 'am') {
        synth = new Tone.AMSynth({
          harmonicity: (_sdOscD && _sdOscD.harmonicity != null) ? _sdOscD.harmonicity : 2,
          oscillator: { type: 'sine' }, envelope: env,
          modulation: { type: 'square' },
          modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 },
        }).connect(chainHead);
      } else if (type === 'mono') {
        synth = new Tone.MonoSynth({
          oscillator: { type: 'sawtooth' }, envelope: env,
          filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.3, release: 2,
                            baseFrequency: 200, octaves: 3 },
        }).connect(chainHead);
      } else if (type === 'bass') {
        synth = new Tone.MonoSynth({
          oscillator: { type: 'square' }, envelope: env,
          filterEnvelope: { attack: 0.005, decay: 0.18, sustain: 0.4, release: 0.4,
                            baseFrequency: 80, octaves: 3.2 },
          filter: { Q: 4, type: 'lowpass', rolloff: -24 },
        }).connect(chainHead);
      } else if (type === 'pad') {
        synth = new Tone.AMSynth({
          harmonicity: 1.5,
          oscillator: { type: 'sine' },
          envelope: { attack: 1.2, decay: 0.5, sustain: 0.7, release: 2.5 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 1.0, decay: 0.5, sustain: 0.5, release: 2.0 },
        }).connect(chainHead);
      } else if (type === 'xylo') {
        synth = new Tone.FMSynth({
          harmonicity: 7,
          modulationIndex: 4,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.3 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.2 },
        }).connect(chainHead);
      } else if (type === 'bell') {
        synth = new Tone.FMSynth({
          harmonicity: 2.14, modulationIndex: 4,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 2.0, sustain: 0.5, release: 0.8 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0.2, release: 0.5 },
        }).connect(chainHead);
      } else if (type === 'wavetable') {
        // Wavetable in the sustain path: build the same osc-stack +
        // AmplitudeEnvelope structure playNote uses, but driven via
        // triggerAttack / triggerRelease so the press is held. The
        // default Tone.Synth fallback below would be silent here
        // because Tone.OmniOscillator rejects type='wavetable'.
        // Design wavetable position (4-frame morph) with legacy mix fallback.
        let _wtTypes, wt;
        if (params.wtPosition != null && typeof _sdWavetableGains === 'function') {
          _wtTypes = SD_WT_FRAMES; wt = _sdWavetableGains(params.wtPosition);
        } else {
          _wtTypes = ['sine', 'sawtooth', 'triangle'];
          wt = (Array.isArray(params.wavetableMix) && params.wavetableMix.length === 3)
            ? params.wavetableMix.map(v => Math.max(0, Math.min(1, Number(v) || 0)))
            : [1.0, 0.5, 0.3];
        }
        const ampEnv = new Tone.AmplitudeEnvelope({
          attack: env.attack, decay: env.decay,
          sustain: env.sustain, release: env.release,
        }).connect(chainHead);
        const wtOscs = [];
        const wtGains = [];
        _wtTypes.forEach((t, i) => {
          if (!(wt[i] > 0.0001)) return;
          const osc = new Tone.Oscillator({ type: t, frequency: freq, detune });
          const g = new Tone.Gain(wt[i]);
          osc.connect(g);
          g.connect(ampEnv);
          wtOscs.push(osc);
          wtGains.push(g);
        });
        const _triggerAt = _warmAt();
        try { ampEnv.triggerAttack(_triggerAt, velocity); } catch (e) {}
        wtOscs.forEach(o => { try { o.start(_triggerAt); } catch (e) {} });
        let released = false;
        return {
          release: () => {
            if (released) return; released = true;
            const releaseAt = Tone.now();
            try { ampEnv.triggerRelease(releaseAt); } catch (e) {}
            const stopAt = releaseAt + (env.release || 0.5) + 0.05;
            wtOscs.forEach(o => { try { o.stop(stopAt); } catch (e) {} });
            setTimeout(() => {
              wtOscs.forEach(o => { try { o.dispose(); } catch (e) {} });
              wtGains.forEach(g => { try { g.dispose(); } catch (e) {} });
              try { ampEnv.dispose(); } catch (e) {}
              disposeSustainFxChain();
            }, ((env.release || 0.5) + 0.5) * 1000);
          },
        };
      } else if (typeof type === 'string' && type.startsWith('noise')) {
        // NoiseSynth — Tone.OmniOscillator (used by Tone.Synth) doesn't
        // accept 'noise:white' as a type, so the generic fallback below
        // silently produced no sound on cell PRESS even though sequence
        // playback (playNote) handled noise correctly. Mirror playNote's
        // noise branch: parse the colour, build a NoiseSynth, and trigger
        // without a frequency argument since NoiseSynth.triggerAttack
        // takes (time, velocity) only.
        const colour = type.includes(':') ? type.split(':')[1] : 'white';
        synth = new Tone.NoiseSynth({
          noise: { type: colour },
          envelope: env,
        }).connect(chainHead);
      } else {
        // Design "unison": basic shapes become fat oscillators (count detuned
        // copies, `spread` cents) when the patch asks for >1 voice — mirrors
        // playNote so a unison patch sounds the same on press and playback.
        let oscOpts;
        if      (type === 'pulse') oscOpts = { type: 'pulse', width: 0.4 };
        else if (type === 'fat')   oscOpts = { type: 'fatsawtooth', count: (_sdOscD && _sdOscD.unison > 1 ? _sdOscD.unison : 3), spread: (_sdOscD ? _sdOscD.spread : 30) };
        else if (_sdOscD && _sdOscD.unison > 1) oscOpts = { type: 'fat' + type, count: _sdOscD.unison, spread: _sdOscD.spread };
        else                       oscOpts = { type };
        synth = new Tone.Synth({ oscillator: oscOpts, envelope: env }).connect(chainHead);
      }
      if (synth.detune && Number.isFinite(detune)) synth.detune.value = detune;
      // Trigger at the caller's pinned startAt (wrap chord audition) or
      // the cold-start-shifted _coldStartAt; otherwise fire at the raw
      // AudioContext.currentTime — Tone.now() would add the 25 ms
      // scheduling lookAhead which is needed for synchronised step
      // playback but pure overhead for a touch-driven sustained press.
      // NoiseSynth's signature is (time, velocity) — no freq — so it
      // gets its own trigger call.
      // Design voices share the lookahead-cushioned _sdVoiceStart (see above) so
      // the synth, filter env, sub and ring all fire together and never in the
      // past; plain cells keep the raw low-latency currentTime.
      let _triggerAt = _designVoice ? _sdVoiceStart : (startAt != null ? startAt : _coldStartAt);
      if (_triggerAt == null) {
        const ac = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
          ? Tone.context.rawContext : null;
        if (ac) _triggerAt = ac.currentTime;
      }
      const isNoise = typeof type === 'string' && type.startsWith('noise');
      try {
        if (isNoise) synth.triggerAttack(_triggerAt, velocity);
        else         synth.triggerAttack(freq, _triggerAt, velocity);
      } catch (e) {}

      // Design mod-matrix / ring-mod / sub-oscillator — built once the synth
      // exists, mirroring playNote. Held: LFOs run continuously, the sub
      // follows the amp envelope; all nodes ride sustainEffectNodes so the
      // release handler's disposeSustainFxChain() tears them down.
      if (_designVoice) {
        if (typeof _sdBuildModRig === 'function' && params.modMatrix && params.modMatrix.length) {
          try {
            const _modNodes = _sdBuildModRig(params,
              { synth, filter: _sdVoiceFilter, panner: _sdModPanner, gain: _sdModGain },
              { startTime: _sdVoiceStart, dur: _sdHeldDur, velocity });
            if (_modNodes && _modNodes.length) _modNodes.forEach(n => sustainEffectNodes.unshift(n));
          } catch (e) {}
        }
        if (_sdRingGain && _sdOscD && _sdOscD.ring > 0) {
          try {
            const ringOsc = new Tone.Oscillator({ frequency: freq * (_sdOscD.ringRatio || 1), type: 'sine' });
            const ringDepth = new Tone.Gain(_sdOscD.ring / 100);
            ringOsc.connect(ringDepth); ringDepth.connect(_sdRingGain.gain);
            ringOsc.start(_triggerAt); sustainEffectNodes.unshift(ringOsc, ringDepth);
          } catch (e) {}
        }
        if (_sdOscD && _sdOscD.sub > 0) {
          try {
            const subOsc = new Tone.Oscillator({ frequency: freq / 2, type: _sdOscD.subShape || 'sine' });
            _sdSubEnv = new Tone.AmplitudeEnvelope(env);
            const subGain = new Tone.Gain((_sdOscD.sub / 100) * velocity);
            subOsc.connect(_sdSubEnv); _sdSubEnv.connect(subGain); subGain.connect(chainHead);
            subOsc.start(_triggerAt); _sdSubEnv.triggerAttack(_triggerAt, velocity);
            sustainEffectNodes.unshift(subOsc, _sdSubEnv, subGain);
          } catch (e) {}
        }
      }

      let released = false;
      return {
        release: () => {
          if (released) return; released = true;
          try { synth.triggerRelease(); } catch (e) {}
          if (_sdSubEnv) { try { _sdSubEnv.triggerRelease(Tone.now()); } catch (e) {} }
          // Pooled voices return to the pool after the release tail so
          // the next press can reacquire them instantly. Non-pooled
          // presets keep the original dispose path. Per-note FX nodes
          // (sustainEffectNodes) are disposed alongside the synth so
          // each press's effect chain doesn't leak.
          const tailMs = (rel + 0.5) * 1000;
          if (pooledPresetKey) {
            setTimeout(() => {
              safeReleaseSynth(pooledPresetKey, synth);
              disposeSustainFxChain();
            }, tailMs);
          } else {
            setTimeout(() => {
              safeDisposeSynth(synth);
              disposeSustainFxChain();
            }, tailMs);
          }
        },
        // Used by Radial Tone to bend the live note as the user slides
        // their finger across the cell. Only touches `.detune` — the
        // previous version also ramped `.frequency`, which required
        // `cancelScheduledValues` and ended up clobbering the attack's
        // own frequency setting (the synth then either played at the
        // default 440 Hz or didn't sound at all). Detune is purely
        // additive on top of the oscillator's frequency, so a ramp here
        // can't fight the attack. Schedules at raw audio-context time
        // to bypass Tone's ~100 ms lookahead and feel responsive.
        setDetune: (cents) => {
          try {
            if (!synth || !synth.detune) return;
            const raw = (Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : null;
            const t = raw ? raw.currentTime + 0.005 : Tone.now();
            if (typeof synth.detune.linearRampToValueAtTime === 'function') {
              try { synth.detune.setValueAtTime(synth.detune.value, t); } catch (e) {}
              synth.detune.linearRampToValueAtTime(cents, t + 0.02);
            } else {
              synth.detune.value = cents;
            }
          } catch (e) {}
        },
      };
    }

    function playNote(freq, params = {}, durationMs, startTime, destination, trackIdx, laneIdx) {
      if (typeof params === 'string') params = { type: params };
      // "User" Design patches: resolve to the patch's stored voice (base
      // oscillator/sample + amp env + filter + design blocks), letting any
      // incoming step-level overrides (bend/pan/volume/detune from the
      // sequencer) win. Done before everything else so the rest of playNote
      // sees a concrete base type.
      if (typeof params.type === 'string' && params.type.indexOf('user:') === 0) {
        const _up = (typeof _resolveUserPatch === 'function') ? _resolveUserPatch(params.type) : null;
        if (_up) {
          const keep = {};
          ['bend', 'pan'].forEach(k => { if (params[k] != null) keep[k] = params[k]; });
          params = Object.assign({}, _up.params, { type: _up.baseType }, keep);
        } else {
          params = Object.assign({}, params, { type: 'sawtooth' }); // patch gone → audible fallback
        }
      }
      // Ensemble voices expand into their member tones BEFORE the capture hook,
      // so each member (not the wrapper) is what gets captured/replayed.
      if (isEnsembleType(params.type)) { _playEnsemble(freq, params, durationMs, startTime, destination, trackIdx, laneIdx); return; }
      // Bloom layer Freeze "recording": tee scheduled notes to the active
      // capture sink (set around a recording layer's emit in the Bloom tick).
      if (typeof window !== 'undefined' && window._ambCaptureSink) {
        try { window._ambCaptureSink(freq, params, durationMs, startTime); } catch (e) {}
        // Silent render (e.g. Shape It capturing a stopped Bloom): the note has
        // been captured — do NOT actually sound it. Scoped to captured (Bloom)
        // notes only, so live grid presses during the render still play.
        if (window._ambSilentCapture) return;
      }
      // Cold-start guard: if the AudioContext hasn't actually resumed yet
      // (very first gesture race — the gesture's resume() is async, the
      // synchronous call into playNote loses), kick the resume now and
      // shift the note's startTime ~60ms into the future so the audio
      // thread has time to come up before the event fires.
      try {
        const ac = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
          ? Tone.context.rawContext : null;
        if (ac && ac.state === 'suspended') {
          try { ac.resume(); } catch (e) {}
          if (startTime == null && typeof Tone.now === 'function') {
            startTime = Tone.now() + 0.06;
          }
        }
      } catch (e) {}

      if (typeof params === 'string') params = { type: params };
      const {
        type    = 'sine',
        attack  = 10,
        decay   = 100,
        sustain = 50,
        release = 1400,
        volume  = 100,
        detune  = 0,
        bend    = null,
        // Effect mix levels (0–100). Underlying params below shape the
        // sound — defaults match the values that were hard-coded before
        // these knobs existed, so old steps round-trip identically.
        reverb     = 0,
        reverbSize = 70,
        reverbTone = 50,
        delay         = 0,
        delayTime     = 250,
        delayFeedback = 40,
        // When set (Tone-style note value: '4n', '8n.', '16t', etc.), the
        // delay's time is computed from the current BPM at play time and
        // delayTime is ignored. null/empty = use delayTime in ms.
        delaySync     = null,
        distortion = 0,
        // ---- New modulation / time effects (all default off at mix=0). ----
        chorus        = 0, chorusFreq     = 4,    chorusDepth    = 70,
        vibrato       = 0, vibratoFreq    = 5,    vibratoDepth   = 30,
        tremolo       = 0, tremoloFreq    = 5,    tremoloDepth   = 70,
        phaser        = 0, phaserFreq     = 0.5,  phaserOctaves  = 3,
        autoFilter    = 0, autoFilterFreq = 1,    autoFilterDepth= 100, autoFilterBaseFreq = 200,
        pingPong      = 0, pingPongTime   = 250,  pingPongFeedback = 30, pingPongSync = null,
        autoPan       = 0, autoPanFreq    = 1,    autoPanDepth   = 100,
        // Per-note pan, -100..100. Inserted as a Tone.Panner after the
        // FX chain so each chord voice or subStep can sit in its own
        // spot in the stereo image. 0 = no panner created (saves a node).
        pan = 0,
        // When true, the per-note effect chain bypasses the master compressor
        // and global FX chain — track-level EQ/pan also gets skipped, since
        // the route reroutes straight to the master limiter. Keeps the note's
        // local FX settings as the only effects applied to that voice.
        fxOverrideGlobal = false,
      } = params;

      const atk = Math.max(attack  / 1000, 0.005);
      const dec = Math.max(decay   / 1000, 0.01);
      const sus = Math.max(sustain / 100,  0.001);
      const rel = Math.max(release / 1000, 0.1);
      const velocity = Math.min(1, Math.max(0, volume / 100));
      const env = { attack: atk, decay: dec, sustain: sus, release: rel };

      const targetDur = durationMs ? durationMs / 1000 : Math.max(atk + dec, 0.1);
      // Gate (time held before release is triggered). A sequenced/recorded
      // step must sound the SAME as holding that note on the grid for the
      // step's duration: attack → decay → HOLD at the sustain level for the
      // whole step → release. So the gate is the full step length and the
      // release tail extends past it (overlapping the next step, exactly as a
      // sustained instrument does). The old `targetDur - rel` subtracted the
      // entire release from the step, which — with the default 1400 ms
      // release — collapsed the gate to the 0.02 s floor, so the note skipped
      // its sustain plateau and decayed immediately. That made lane playback
      // sound quieter and "enveloped" versus a grid press. Peak safety for the
      // resulting overlap now lives in the master soft-clip ceiling, not here.
      const preReleaseDur = durationMs
        ? Math.max(0.02, targetDur)
        : atk + dec;
      // Tightened grace from 0.4s → 0.1s. The release envelope is
      // already done at preReleaseDur+rel; keeping disposed-but-silent
      // synths in the audio graph for an extra 400ms accumulated voice
      // count over long loops and contributed to "audio gets weird the
      // longer it loops" CPU pressure.
      const disposeMs = (preReleaseDur + rel + 0.1) * 1000;

      // Light up the corresponding cell in the note grid for the duration
      // of the note. Skipped during offline rendering (offline context's
      // currentTime doesn't match the live UI clock, so the timing math
      // would fire visuals at the wrong moment) and during sequence
      // playback (scheduleStepAt already handles cell highlighting via
      // step.cellIndex; calling flashCellByFreq there would double the
      // setTimeout queue per step for no visual difference).
      if (!_offlineSamplerOverride && !_suppressCellFlash) {
        flashCellByFreq(freq, startTime, Math.max(80, targetDur * 1000));
      }

      // Loaded sample (Tone.Sampler) — pitch-shifts the file to play any note.
      // Per-note effects are skipped on samples (the sampler is shared); pan
      // and EQ are still applied when called from track playback (per-track
      // sampler bound to the track's bus) or from a Poly-mode lane stream
      // (per-lane sampler bound to the lane's bus).
      if (isSampleType(type)) {
        // Grain is a special sample type — uses Tone.GrainPlayer (a
        // granular sampler, monophonic per instance) instead of the
        // shared Tone.Sampler. Each voice gets its own player so we
        // can play simultaneous notes; they share the cached buffer
        // by reference so the second-and-onward note's player picks
        // up the audio data without re-fetching.
        if (type === 'sample:grain') {
          const grainInfo = sampleSamplers.get('grain');
          if (!grainInfo || !grainInfo.buffer) {
            // Buffer registry missing — fall back to a sine so the
            // note is at least audible while we wait for grain to
            // initialize on the next tick.
            return playNote(freq, { ...params, type: 'sine' }, durationMs, startTime, destination, trackIdx, laneIdx);
          }
          const baseFreq = grainInfo.baseFreq || 440;
          const cents = (typeof freq === 'number' && freq > 0)
            ? 1200 * Math.log2(freq / baseFreq) + (detune || 0)
            : (detune || 0);
          // Same destination resolution as the synth path — voice
          // routes through the lane bus (live poly) or trackBus
          // (track playback) so per-lane / per-track mix applies.
          const laneDest = (Number.isFinite(laneIdx) && lanes[laneIdx]) ? getLaneBus(laneIdx) : null;
          const finalDest = destination || laneDest || globalSendTap;
          // Negative playback rate = reverse playback. Tone.GrainPlayer
          // accepts negative rates directly; clamp to a small absolute
          // value so a rate of exactly 0 doesn't lock the buffer.
          const rawRate = Number.isFinite(params.grainRate) ? params.grainRate : 1;
          const playbackRate = (Math.abs(rawRate) < 0.05) ? 0.05 * Math.sign(rawRate || 1) : rawRate;
          // Tone v14's GrainPlayer constructor wants the buffer as a
          // raw AudioBuffer or string URL — passing a wrapping
          // Tone.ToneAudioBuffer to `url` was producing silent voices.
          // Resolve to the underlying AudioBuffer when we have one
          // loaded; fall back to the source URL string so GrainPlayer
          // can do its own fetch (browser-cached after first time).
          const rawBuffer = (grainInfo.buffer && typeof grainInfo.buffer.get === 'function')
            ? grainInfo.buffer.get() : null;
          const playerOpts = {
            grainSize: (params.grainSize != null) ? params.grainSize : 0.1,
            overlap:   (params.grainOverlap != null) ? params.grainOverlap : 0.05,
            playbackRate,
            detune: cents,
            loop: true,
            volume: Tone.gainToDb(Math.max(0.001, velocity)),
          };
          if (rawBuffer) {
            playerOpts.url = rawBuffer;
          } else {
            playerOpts.url = 'https://tonejs.github.io/audio/salamander/A4.mp3';
          }
          const player = new Tone.GrainPlayer(playerOpts).connect(finalDest);
          try {
            console.log('[grain] fire freq=', freq,
              'cents=', cents.toFixed(1),
              'rate=', playbackRate,
              'rawBuffer=', !!rawBuffer,
              'bufferDur=', grainInfo.buffer?.duration);
          } catch (e) {}
          const triggerAt = (typeof startTime === 'number' && Number.isFinite(startTime))
            ? startTime : Tone.now();
          const dur = Math.max(0.05, targetDur);
          // Tone.GrainPlayer.start(time, offset, duration) plays
          // for `duration` seconds starting at `time` from `offset`
          // into the buffer. Loop is on so a duration longer than
          // the buffer wraps within itself, matching the "sustained
          // grain texture" expectation.
          // Design "Position" (grainOffset 0..1) seeks into the buffer.
          const _grainOff = Math.max(0, Math.min(0.999, Number.isFinite(params.grainOffset) ? params.grainOffset : 0))
            * ((grainInfo.buffer && grainInfo.buffer.duration) || 0);
          const fire = () => {
            try { player.start(triggerAt, _grainOff, dur); }
            catch (e) { console.warn('[grain] start failed', e); }
          };
          // Use the player's own loaded state; Tone.GrainPlayer
          // exposes `.loaded` once its internal buffer is ready.
          if (player.loaded) fire();
          else if (typeof grainInfo.buffer?.loaded?.then === 'function') {
            grainInfo.buffer.loaded.then(fire, (e) => console.warn('[grain] buffer load err', e));
          } else {
            // No clean readiness signal — schedule a slight delay so
            // the GrainPlayer has a tick to wire up its internal
            // source-from-URL.
            setTimeout(fire, 50);
          }
          // Lifecycle — same offline-skip / live-dispose pattern as
          // every other voice. Voice gets parked in the offline ref
          // pool during export; live path schedules a wall-clock
          // dispose past the duration tail.
          if (_offlineSamplerOverride) {
            if (Array.isArray(_offlineVoiceRefs)) _offlineVoiceRefs.push(player);
            return;
          }
          const grainLeadMs = (typeof startTime === 'number' && Number.isFinite(startTime))
            ? Math.max(0, (startTime - Tone.context.now()) * 1000) : 0;
          setTimeout(() => { try { player.dispose(); } catch (e) {} },
            grainLeadMs + (dur + 0.5) * 1000);
          return;
        }
        let sampler = null;
        // Per-track sampler is built lazily on first audio call too —
        // gate adoption on .loaded the same way the per-lane path does
        // so the first few track-playback notes don't fall back to a
        // sine while the sampler's buffers are still fetching. The
        // shared sampler is already loaded by app startup, so falling
        // through to it gives the right tone immediately; per-track
        // EQ + panner won't apply during that brief warm-up window
        // but the user hears the correct instrument instead of a sine.
        // Per-item-lane sampler stash, when present, wins over the
        // per-track sampler — those route straight to trackBus,
        // bypassing the per-item lane bus (and its FX chain). Without
        // this branch, sample-based steps in track playback came out
        // dry no matter what reverb / delay / etc. the lane was saved
        // with. Stash lives on the lane bus head (set in playTrackItem)
        // so the routing target naturally carries its own samplers.
        // The map carries null placeholders for sample types the lane
        // might use — `_materialize` builds the Tone.Sampler on first
        // hit so multi-track item starts don't fire N parallel HTTP
        // fetches at once (the bulk of the multi-track crash on iOS).
        const laneSamplerMap = destination && destination._laneSamplers;
        if (laneSamplerMap && typeof laneSamplerMap.get === 'function') {
          const sampleId = type.slice(7);
          let laneSamp = laneSamplerMap.get(sampleId);
          if (!laneSamp && typeof laneSamplerMap._materialize === 'function') {
            laneSamp = laneSamplerMap._materialize(sampleId);
          }
          if (laneSamp && laneSamp.loaded) sampler = laneSamp;
        }
        if (!sampler && Number.isFinite(trackIdx) && tracks[trackIdx]) {
          const trackSamp = getOrCreateTrackSampler(trackIdx, type.slice(7));
          if (trackSamp && trackSamp.loaded) sampler = trackSamp;
        }
        // Per-lane sampler is built lazily on first audio call, but its
        // buffers load asynchronously. While they load, only adopt the
        // lane sampler if it's actually .loaded — otherwise fall through
        // to the shared sampler (which is already loaded by app startup)
        // so the first few notes of a freshly-created lane don't sine-
        // fallback. Lane pan won't apply during that brief warm-up
        // window, but the tone and envelope stay correct.
        if (!sampler && Number.isFinite(laneIdx) && lanes[laneIdx]) {
          const laneSamp = getOrCreateLaneSampler(laneIdx, type.slice(7));
          if (laneSamp && laneSamp.loaded) sampler = laneSamp;
        }
        if (!sampler) {
          const entry = getSampleEntry(type);
          sampler = entry?.sampler || null;
        }
        if (sampler && sampler.loaded) {
          const baseFreq = snapDrumKitFreq(type, freq);
          const tunedFreq = (typeof baseFreq === 'number')
            ? baseFreq * Math.pow(2, detune / 1200)
            : baseFreq;
          const dur = Math.max(targetDur, 0.05);
          // Full-ADSR per-note voice (live): the sound editor's Attack /
          // Decay / Sustain / Release (and an optional filter) shape the
          // sample exactly as they shape synths. Falls back to the shared
          // sampler's attack/release fade when buffers aren't reachable or
          // during offline export.
          const sampleDest = fxOverrideGlobal ? masterLimiter
            : (destination
               || ((Number.isFinite(laneIdx) && lanes[laneIdx]) ? getLaneBus(laneIdx) : null)
               || globalSendTap);
          // Loop to fill the step via the seamless native looping voice (bounded
          // Pad-imported samples use the dedicated single-buffer looping voice,
          // bounded by scheduleStop to the step length.
          if ((sampleSamplers.get(type.slice(7)) || {}).padLoop
              && !Number.isFinite(params.sampleOffsetSec) && !Number.isFinite(params.sliceDurSec)) {
            const padAt = (typeof startTime === 'number' && Number.isFinite(startTime)) ? startTime : Tone.now();
            const padH = _startPadVoice(type.slice(7), tunedFreq, env, sampleDest, velocity, padAt, { pan });
            if (padH) { try { padH.scheduleStop(Math.max(0.02, targetDur)); } catch (e) {} return; }
          }
          // Loop ONLY when the caller explicitly asks (params.loop — e.g. the
          // Drone). SEQUENCED / Bloom-layer notes have a fixed length, so
          // defaulting them to loop made notes longer than the buffer re-attack
          // (glitchy, esp. a Bed pad on the piano grid-voice). Held GRID notes
          // still loop by default — that's startSustainedNote, not this path.
          const _wantLoop = !!params.loop
            && !Number.isFinite(params.sampleOffsetSec) && !Number.isFinite(params.sliceDurSec)
            && !Number.isFinite(params.filterCutoff);
          const v = _buildSampleAdsrVoice(sampler, type.slice(7), tunedFreq, env, sampleDest,
            { filterCutoff: params.filterCutoff, filterQ: params.filterQ, detuneMod: params._detuneMod, pan,
              sampleOffsetSec: params.sampleOffsetSec, sliceDurSec: params.sliceDurSec, loop: _wantLoop, reverse: !!params.reverse });
          if (v) {
            const triggerAt = (typeof startTime === 'number' && Number.isFinite(startTime)) ? startTime : Tone.now();
            // Portamento — glide the sample's playbackRate (= pitch) from the layer's previous
            // note up to the target over glideMs. Gated; default off → byte-identical. (The slice
            // window is computed at the target rate, so a brief glide may drift the slice slightly.)
            if (params.glideMs > 0 && params.glideLayer && v.source && v.source.playbackRate) {
              const tr = v.source.playbackRate.value, prev = params.glideLayer._glidePrevRate;
              if (prev > 0 && tr > 0 && prev !== tr) {
                const gl = Math.min(params.glideMs / 1000, Math.max(0.02, targetDur * 0.95));
                try { v.source.playbackRate.setValueAtTime(prev, triggerAt); v.source.playbackRate.exponentialRampToValueAtTime(tr, triggerAt + gl); } catch (e) {}
              }
              params.glideLayer._glidePrevRate = tr;
            }
            try {
              // Slice window when present (offset>0 or a bounded duration); else
              // the plain whole-buffer start — byte-identical to the prior path.
              if (v.sliceBufSec != null || v.sliceOffset > 0) v.source.start(triggerAt, v.sliceOffset, v.sliceBufSec != null ? v.sliceBufSec : undefined);
              else v.source.start(triggerAt);
              _applyVoiceLoop(v);
              // Hold for preReleaseDur (= the full step, ≥ 0.02), then release
              // over `rel` — same envelope timing the synth path uses, so a
              // sample voice and a synth voice sit identically in a slot.
              v.ampEnv.triggerAttackRelease(preReleaseDur, triggerAt, velocity);
              // When this voice enters its release tail + the tail length — drives
              // release-aware sample-voice stealing (_pickSampleVictim).
              v.relAtCtx = triggerAt + (Number.isFinite(preReleaseDur) ? preReleaseDur : 0);
              v.relDur = Number.isFinite(rel) ? rel : 0;
              try { v.source.stop(triggerAt + preReleaseDur + rel + 0.1); } catch (e) {}
            } catch (e) {
              _disposeSampleAdsrVoice(v);
              return;
            }
            // Track as a playback voice so a user stop can cut it immediately;
            // skip during offline export (no real-time stop there). Register at
            // the voice's real start (not now) so a scheduled-ahead phrase
            // doesn't trip the polyphony cap at dispatch time.
            const leadMs = (typeof startTime === 'number' && Number.isFinite(startTime))
              ? Math.max(0, (startTime - Tone.context.now()) * 1000) : 0;
            if (!_offlineSamplerOverride) _registerSampleVoiceAtStart(v, leadMs);
            v.disposeTimer = setTimeout(() => {
              _unregisterSampleVoice(v);
              _disposeSampleAdsrVoice(v);
            }, leadMs + (preReleaseDur + rel + 0.5) * 1000);
            return;
          }
          // Fallback — shared sampler, attack/release fade only (Tone.Sampler
          // has no decay / sustain-level). Captured per-voice at trigger time.
          try {
            if (typeof sampler.attack  !== 'undefined') sampler.attack  = Math.max(0, atk);
            if (typeof sampler.release !== 'undefined') sampler.release = Math.max(0.01, rel);
          } catch (e) {}
          try {
            sampler.triggerAttackRelease(tunedFreq, dur, startTime, velocity);
          } catch (e) {
            console.warn('Sample playback failed', type, e);
          }
          return;
        }
        // Sampler hasn't finished its network fetch yet — the most
        // common cause of "first taps make no sound" on a cold load,
        // since the default tone is sample:piano. Fall back to a sine
        // synth one-shot so the press is audible; the next press
        // (likely a few hundred ms later) will use the real sample.
        return playNote(freq, { ...params, type: 'sine' }, durationMs, startTime, destination, trackIdx, laneIdx);
      }

      // Per-note effect chain — order is synth → distortion → delay → reverb
      // → panner → destination. Built backward from the destination so each
      // new node's output is the previous head. `chainHead` becomes the
      // synth's connect target; effect nodes are disposed alongside the
      // synth so they don't leak. In Poly mode, route through the lane's
      // bus (Volume → Panner → masterBus + parallel FX sends) so lane-
      // level mix and per-lane FX sends apply.
      const laneDest = (Number.isFinite(laneIdx) && lanes[laneIdx]) ? getLaneBus(laneIdx) : null;
      const finalDest = fxOverrideGlobal ? masterLimiter : (destination || laneDest || globalSendTap);
      let chainHead = finalDest;
      const effectNodes = [];
      // Per-note pan sits closest to the destination so it pans the fully-
      // wet signal (reverb / delay tails included). Skip the node entirely
      // when pan is zero so we don't pay for an idle panner per voice.
      const panNorm = Math.max(-1, Math.min(1, (pan || 0) / 100));
      if (Math.abs(panNorm) > 0.001) {
        // Makeup gain so panning doesn't drop level (equal-power compensation).
        const mk = _panMakeup(panNorm);
        let tail = chainHead;
        if (mk > 1.001) { const g = new Tone.Gain(mk).connect(tail); effectNodes.unshift(g); tail = g; }
        const pn = new Tone.Panner(panNorm).connect(tail);
        effectNodes.unshift(pn);
        chainHead = pn;
      }
      // LFO-driven effects need .start() to begin oscillating; otherwise
      // they sit at their initial phase and produce no modulation.
      const startLfo = (n) => { try { if (typeof n.start === 'function') n.start(); } catch (e) {} };
      // Per-note FX chain follows the configured global order (same one
      // the master chain uses) so the user's reorder applies everywhere.
      // Each builder returns null when its mix is 0 — chain is built
      // backward so order[N-1] is closest to chainHead (just before the
      // panner toward dest), order[0] sits closest to the synth.
      const _fxBuilders = {
        distortion: () => distortion > 0 ? new Tone.Distortion({
          distortion: Math.max(0, Math.min(1, distortion / 100)),
          wet: 1, oversample: '4x',
        }) : null,
        autoFilter: () => autoFilter > 0 ? new Tone.AutoFilter({
          frequency:     Math.max(0.01, autoFilterFreq),
          depth:         Math.max(0, Math.min(1, autoFilterDepth / 100)),
          baseFrequency: Math.max(20, autoFilterBaseFreq),
          octaves:       2.6,
          wet:           Math.max(0, Math.min(1, autoFilter / 100)),
        }) : null,
        phaser: () => phaser > 0 ? new Tone.Phaser({
          frequency:    Math.max(0.01, phaserFreq),
          octaves:      Math.max(1, Math.min(7, phaserOctaves)),
          baseFrequency: 350,
          wet:          Math.max(0, Math.min(1, phaser / 100)),
        }) : null,
        vibrato: () => vibrato > 0 ? new Tone.Vibrato({
          frequency: Math.max(0.01, vibratoFreq),
          depth:     Math.max(0, Math.min(1, vibratoDepth / 100)),
          wet:       Math.max(0, Math.min(1, vibrato / 100)),
        }) : null,
        chorus: () => chorus > 0 ? new Tone.Chorus({
          frequency: Math.max(0.01, chorusFreq),
          depth:     Math.max(0, Math.min(1, chorusDepth / 100)),
          delayTime: 3.5, feedback: 0.1,
          wet:       Math.max(0, Math.min(1, chorus / 100)),
        }) : null,
        tremolo: () => tremolo > 0 ? new Tone.Tremolo({
          frequency: Math.max(0.01, tremoloFreq),
          depth:     Math.max(0, Math.min(1, tremoloDepth / 100)),
          wet:       Math.max(0, Math.min(1, tremolo / 100)),
        }) : null,
        delay: () => delay > 0 ? new Tone.FeedbackDelay({
          delayTime: delaySync
            ? noteValueToSec(delaySync, parseInt(tempoInput?.value, 10) || 120)
            : Math.max(0.001, (delayTime || 0) / 1000),
          feedback:  Math.max(0, Math.min(0.95, delayFeedback / 100)),
          wet:       Math.max(0, Math.min(1, delay / 100)),
        }) : null,
        pingPong: () => pingPong > 0 ? new Tone.PingPongDelay({
          delayTime: pingPongSync
            ? noteValueToSec(pingPongSync, parseInt(tempoInput?.value, 10) || 120)
            : Math.max(0.001, (pingPongTime || 0) / 1000),
          feedback:  Math.max(0, Math.min(0.95, pingPongFeedback / 100)),
          wet:       Math.max(0, Math.min(1, pingPong / 100)),
        }) : null,
        reverb: () => reverb > 0 ? new Tone.Freeverb({
          // reverbTone → dampening (Hz): 0 → 500 Hz (very damped),
          // 100 → 10000 Hz (open).
          roomSize:  Math.max(0, Math.min(0.99, reverbSize / 100)),
          dampening: 500 + Math.max(0, Math.min(100, reverbTone)) * 95,
          wet:       Math.max(0, Math.min(1, reverb / 100)),
        }) : null,
        autoPan: () => autoPan > 0 ? new Tone.AutoPanner({
          frequency: Math.max(0.01, autoPanFreq),
          depth:     Math.max(0, Math.min(1, autoPanDepth / 100)),
          wet:       Math.max(0, Math.min(1, autoPan / 100)),
        }) : null,
      };
      const _fxOrder = (globalFx && Array.isArray(globalFx.fxOrder) && globalFx.fxOrder.length === FX_NAMES.length)
        ? globalFx.fxOrder
        : FX_NAMES;
      for (let i = _fxOrder.length - 1; i >= 0; i--) {
        const node = _fxBuilders[_fxOrder[i]]?.();
        if (!node) continue;
        startLfo(node);
        node.connect(chainHead);
        effectNodes.unshift(node);
        chainHead = node;
      }
      // Per-voice subtractive filter + filter envelope (Design patches). Built
      // closest to the synth (before the FX chain) and only when the patch
      // turns it on, so ordinary cells pay nothing. Disposed with the chain.
      // _sdVoiceFilter / _sdModPanner are kept so the mod rig (below, after the
      // synth exists) can modulate their params.
      let _sdVoiceFilter = null, _sdModPanner = null, _sdModGain = null;
      if (params.filter && params.filter.on && typeof _sdBuildVoiceFilter === 'function') {
        _sdVoiceFilter = _sdBuildVoiceFilter(params, {
          startTime: (typeof startTime === 'number') ? startTime : undefined,
          dur: targetDur, velocity,
        });
        if (_sdVoiceFilter) { _sdVoiceFilter.connect(chainHead); effectNodes.unshift(_sdVoiceFilter); chainHead = _sdVoiceFilter; }
      }
      // A dedicated mod panner (base centred) when the matrix targets pan, so
      // it can be modulated independently of the static per-note panner above.
      if (typeof _sdNeedsModPan === 'function' && _sdNeedsModPan(params)) {
        try { _sdModPanner = new Tone.Panner(0).connect(chainHead); effectNodes.unshift(_sdModPanner); chainHead = _sdModPanner; } catch (e) {}
      }
      // A mod gain (base unity) when the matrix targets amp — modulated for
      // tremolo / AM on top of the voice's own envelope.
      if (typeof _sdNeedsModGain === 'function' && _sdNeedsModGain(params)) {
        try { _sdModGain = new Tone.Gain(1).connect(chainHead); effectNodes.unshift(_sdModGain); chainHead = _sdModGain; } catch (e) {}
      }
      const disposeEffectChain = () => {
        effectNodes.forEach(n => { try { n.dispose(); } catch (e) {} });
      };

      // Resolved oscillator-design (Phase 2: unison / FM-AM timbre / sub-osc).
      // Computed once; the construction branches + the sub-osc below read it.
      const _sdOscD = (typeof _sdOscDesign === 'function') ? _sdOscDesign(params) : null;

      // Ring mod: a gain (base unity) the synth feeds, whose gain is multiplied
      // by a modulator oscillator (built after the synth). Inserted before the
      // synth so the synth connects through it.
      let _sdRingGain = null;
      if (_sdOscD && _sdOscD.ring > 0) {
        try { _sdRingGain = new Tone.Gain(1).connect(chainHead); effectNodes.unshift(_sdRingGain); chainHead = _sdRingGain; } catch (e) {}
      }

      let synth;

      // Phase 1 voice pool — acquire a pre-configured synth body for
      // pooled presets instead of constructing one. Bypassed during
      // offline render (separate AudioContext) and for presets that
      // have their own lifecycle below (pluck/noise/wavetable early-
      // return; duo/kick/metal aren't pooled yet). pooledPreset gets
      // recorded on the voice entry so the dispose timer + steal path
      // route the synth back to the pool instead of disposing it.
      let pooledPreset = null;
      const _sdFreshVoice = (typeof _sdOscNeedsFreshVoice === 'function') && _sdOscNeedsFreshVoice(_sdOscD, type);
      if (VOICE_POOL_ENABLED && !_offlineSamplerOverride && !_sdFreshVoice && _isPooledPreset(type)) {
        synth = _buildPooledSynthForPreset(type, env);
        if (synth) {
          pooledPreset = type;
          try {
            synth.connect(chainHead);
            // A reacquired pooled synth is wired up now but won't be retriggered
            // until startTime (Bloom schedules up to ~1.2 s ahead). Its oscillator
            // runs continuously, so any leftover release-tail residual from its
            // previous note would leak through this whole window. Mute it until
            // the attack; the envelope is 0 at startTime, so lifting the mute
            // there is inaudible.
            if (synth.volume && typeof startTime === 'number' && Number.isFinite(startTime)
                && startTime > Tone.context.now()) {
              synth.volume.cancelScheduledValues(Tone.context.now());
              synth.volume.setValueAtTime(-200, Tone.context.now());
              synth.volume.setValueAtTime(0, startTime);
            }
          } catch (e) { synth = null; pooledPreset = null; }
        }
      }

      if (synth) {
        // Already provided by the pool — skip the construction chain.
      } else if (type === 'bell') {
        synth = new Tone.FMSynth({
          harmonicity: 2.14,
          modulationIndex: 4,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 2.0, sustain: 0, release: 0.8 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0.2, release: 0.5 },
        }).connect(chainHead);
      } else if (type === 'pluck') {
        // PluckSynth has no detune param — fold cents into the frequency.
        synth = new Tone.PluckSynth({
          attackNoise: 1,
          dampening: 4000,
          resonance: 0.7,
          release: 1,
        }).connect(chainHead);
        const tunedFreq = (typeof freq === 'number') ? freq * Math.pow(2, detune / 1200) : freq;
        synth.triggerAttackRelease(tunedFreq, Math.max(targetDur, 0.1), startTime, velocity);
        // Schedule disposal whether or not startTime was provided.
        // Previously this was gated on `startTime === undefined`, which was
        // fine when only offline rendering passed a startTime (it disposes
        // its context wholesale). The sequence playback path now passes a
        // startTime too, and skipping disposal there leaked synths every
        // step — the resulting voice pile-up showed up as glitchy /
        // distorted audio after a few seconds of playback.
        // Skip the dispose / register dance during offline export
        // (same reasoning as the main synth path below). Park a
        // strong ref so the wrapper survives until the render ends.
        if (_offlineSamplerOverride) {
          if (Array.isArray(_offlineVoiceRefs)) {
            _offlineVoiceRefs.push(synth);
            effectNodes.forEach(n => _offlineVoiceRefs.push(n));
          }
          return;
        }
        const pluckLeadMs = (typeof startTime === 'number' && Number.isFinite(startTime))
          ? Math.max(0, (startTime - Tone.context.now()) * 1000)
          : 0;
        const pluckEntry = { synth, effectNodes, disposeTimer: null, registerTimer: null };
        pluckEntry.disposeTimer = setTimeout(() => {
          _unregisterVoice(pluckEntry);
          safeDisposeSynth(synth);
          disposeEffectChain();
        }, pluckLeadMs + (targetDur + 1.5) * 1000);
        _registerVoiceAtStart(pluckEntry, pluckLeadMs);
        return;
      } else if (typeof type === 'string' && type.startsWith('noise')) {
        // NoiseSynth — like pluck, doesn't take a frequency, so it needs
        // its own trigger + early return. Type encodes the colour:
        // 'noise:white' (default), 'noise:pink', 'noise:brown'.
        const colour = type.includes(':') ? type.split(':')[1] : 'white';
        const ns = new Tone.NoiseSynth({
          noise: { type: colour },
          envelope: env,
        }).connect(chainHead);
        try { ns.triggerAttackRelease(preReleaseDur, startTime, velocity); } catch (e) {}
        if (_offlineSamplerOverride) {
          if (Array.isArray(_offlineVoiceRefs)) {
            _offlineVoiceRefs.push(ns);
            effectNodes.forEach(n => _offlineVoiceRefs.push(n));
          }
          return;
        }
        const noiseLeadMs = (typeof startTime === 'number' && Number.isFinite(startTime))
          ? Math.max(0, (startTime - Tone.context.now()) * 1000)
          : 0;
        const noiseEntry = { synth: ns, effectNodes, disposeTimer: null, registerTimer: null };
        noiseEntry.disposeTimer = setTimeout(() => {
          _unregisterVoice(noiseEntry);
          safeDisposeSynth(ns);
          disposeEffectChain();
        }, noiseLeadMs + disposeMs);
        _registerVoiceAtStart(noiseEntry, noiseLeadMs);
        return;
      } else if (type === 'fm') {
        synth = new Tone.FMSynth({
          harmonicity: (_sdOscD && _sdOscD.harmonicity != null) ? _sdOscD.harmonicity : 3,
          modulationIndex: (_sdOscD && _sdOscD.modIndex != null) ? _sdOscD.modIndex : 10,
          oscillator: { type: 'sine' },
          envelope: env,
          modulation: { type: 'square' },
          modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 },
        }).connect(chainHead);
      } else if (type === 'duo') {
        synth = new Tone.DuoSynth({
          voice0: { oscillator: { type: 'sine'    }, envelope: env },
          voice1: { oscillator: { type: 'sawtooth'}, envelope: env },
          harmonicity: (_sdOscD && _sdOscD.harmonicity != null) ? _sdOscD.harmonicity : 1.5,
          vibratoAmount: 0.3,
          vibratoRate: 5,
        }).connect(chainHead);
      } else if (type === 'am') {
        synth = new Tone.AMSynth({
          harmonicity: (_sdOscD && _sdOscD.harmonicity != null) ? _sdOscD.harmonicity : 2,
          oscillator: { type: 'sine' },
          envelope: env,
          modulation: { type: 'square' },
          modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 },
        }).connect(chainHead);
      } else if (type === 'mono') {
        synth = new Tone.MonoSynth({
          oscillator: { type: 'sawtooth' },
          envelope: env,
          filterEnvelope: {
            attack: 0.01, decay: 0.3, sustain: 0.3, release: 2,
            baseFrequency: 200, octaves: 3,
          },
          filter: { Q: 6, type: 'lowpass', rolloff: -24 },
        }).connect(chainHead);
      } else if (type === 'bass') {
        // Bass preset — square sub-oscillator through a snappy lowpass
        // filter envelope for a thick, punchy low end.
        synth = new Tone.MonoSynth({
          oscillator: { type: 'square' },
          envelope: env,
          filterEnvelope: {
            attack: 0.005, decay: 0.18, sustain: 0.4, release: 0.4,
            baseFrequency: 80, octaves: 3.2,
          },
          filter: { Q: 4, type: 'lowpass', rolloff: -24 },
        }).connect(chainHead);
      } else if (type === 'pad') {
        // Pad preset — slow-attack AM voice. Hardcoded envelope so the
        // pad character lands without the user having to dial in long
        // attack/release times themselves; per-step params can still
        // shape volume/detune/etc.
        synth = new Tone.AMSynth({
          harmonicity: 1.5,
          oscillator: { type: 'sine' },
          envelope: { attack: 1.2, decay: 0.5, sustain: 0.7, release: 2.5 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 1.0, decay: 0.5, sustain: 0.5, release: 2.0 },
        }).connect(chainHead);
      } else if (type === 'xylo') {
        // Xylophone-ish — high-harmonicity FM with a short percussive
        // envelope so each note pings and decays quickly.
        synth = new Tone.FMSynth({
          harmonicity: 7,
          modulationIndex: 4,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.3 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.2 },
        }).connect(chainHead);
      } else if (type === 'kick') {
        synth = new Tone.MembraneSynth({
          pitchDecay: 0.05,
          octaves: 10,
          envelope: { attack: 0.001, decay: 0.4, sustain: 0.01, release: 1.4 },
        }).connect(chainHead);
      } else if (type === 'metal') {
        synth = new Tone.MetalSynth({
          harmonicity: 5.1,
          modulationIndex: 32,
          resonance: 4000,
          octaves: 1.5,
          envelope: { attack: 0.001, decay: 1.4, release: 0.2 },
        }).connect(chainHead);
      } else if (type === 'wavetable') {
        // Wavetable: stack three native oscillators (sine + sawtooth
        // + triangle) blended at user-defined amplitudes, gated by
        // a single Tone.AmplitudeEnvelope.
        // Design wavetable: morph a 4-frame bank (sine→triangle→sawtooth→
        // square) by params.wtPosition (0-100). Falls back to the legacy
        // 3-osc sine/saw/tri mix for old `wavetableMix` data.
        let oscTypes, wt;
        if (params.wtPosition != null && typeof _sdWavetableGains === 'function') {
          oscTypes = SD_WT_FRAMES; wt = _sdWavetableGains(params.wtPosition);
        } else {
          oscTypes = ['sine', 'sawtooth', 'triangle'];
          wt = (Array.isArray(params.wavetableMix) && params.wavetableMix.length === 3)
            ? params.wavetableMix.map(v => Math.max(0, Math.min(1, Number(v) || 0)))
            : [1.0, 0.5, 0.3];
        }
        const ampEnv = new Tone.AmplitudeEnvelope({
          attack:  env.attack, decay: env.decay,
          sustain: env.sustain, release: env.release,
        }).connect(chainHead);
        const oscs = [];
        const gains = [];
        // When the mod matrix sweeps WT Pos, build a live 2-frame crossfade
        // (the two frames bracketing the base position) driven by a position
        // Signal that the mod rig writes into; otherwise the static blend.
        const _wtMod = params.wtPosition != null && params.modMatrix
          && params.modMatrix.some(r => r.dest === 'wtpos' && r.amount)
          && typeof _sdBuildModRig === 'function';
        if (_wtMod) {
          const N = SD_WT_FRAMES.length;
          const pp = Math.max(0, Math.min(1, (params.wtPosition || 0) / 100)) * (N - 1);
          const fi = Math.min(N - 2, Math.floor(pp)); const x0 = pp - fi;
          const oscA = new Tone.Oscillator({ type: SD_WT_FRAMES[fi], frequency: freq, detune });
          const oscB = new Tone.Oscillator({ type: SD_WT_FRAMES[fi + 1], frequency: freq, detune });
          const gA = new Tone.Gain(1), gB = new Tone.Gain(0);
          const xSig = new Tone.Signal(x0), inv = new Tone.Gain(-1);
          xSig.connect(gB.gain);          // gB.gain = x0 + mod
          xSig.connect(inv); inv.connect(gA.gain); // gA.gain = 1 - (x0 + mod)
          oscA.connect(gA); gA.connect(ampEnv);
          oscB.connect(gB); gB.connect(ampEnv);
          oscs.push(oscA, oscB); gains.push(gA, gB, xSig, inv);
          try {
            const mn = _sdBuildModRig(params,
              { synth: null, filter: _sdVoiceFilter, panner: _sdModPanner, gain: _sdModGain, wtpos: xSig },
              { startTime: (typeof startTime === 'number') ? startTime : undefined, dur: targetDur, velocity });
            if (mn) mn.forEach(n => gains.push(n));
          } catch (e) {}
        } else {
          oscTypes.forEach((t, i) => {
            if (!(wt[i] > 0.0001)) return;   // skip silent frames
            const osc = new Tone.Oscillator({ type: t, frequency: freq, detune });
            const g = new Tone.Gain(wt[i]);
            osc.connect(g);
            g.connect(ampEnv);
            oscs.push(osc);
            gains.push(g);
          });
        }
        const triggerAt = (typeof startTime === 'number' && Number.isFinite(startTime))
          ? startTime : Tone.now();
        // Portamento — glide each oscillator from the layer's previous note freq up to the
        // target over glideMs. Gated on glideMs > 0 (set only by _ambApplyAdsr when the
        // layer's Portamento > 0), so the default voice path is byte-identical. The previous
        // freq is tracked per-layer on the layer object so each layer glides independently.
        if (params.glideMs > 0 && typeof freq === 'number' && freq > 0 && params.glideLayer) {
          const prev = params.glideLayer._glidePrev;
          if (prev > 0 && prev !== freq) {
            const gl = Math.min(params.glideMs / 1000, Math.max(0.02, targetDur * 0.95));
            oscs.forEach(o => { try { if (o.frequency) { o.frequency.cancelScheduledValues(triggerAt); o.frequency.setValueAtTime(prev, triggerAt); o.frequency.exponentialRampToValueAtTime(freq, triggerAt + gl); } } catch (e) {} });
          }
          params.glideLayer._glidePrev = freq;
        }
        ampEnv.triggerAttackRelease(preReleaseDur, triggerAt, velocity);
        oscs.forEach(o => { try { o.start(triggerAt); } catch (e) {} });
        const stopAt = triggerAt + preReleaseDur + (env.release || 0.5) + 0.05;
        oscs.forEach(o => { try { o.stop(stopAt); } catch (e) {} });
        // Lifecycle — same offline-skip / live-dispose pattern as
        // every other synth path. All nodes get parked / disposed.
        if (_offlineSamplerOverride) {
          if (Array.isArray(_offlineVoiceRefs)) {
            oscs.forEach(o => _offlineVoiceRefs.push(o));
            gains.forEach(g => _offlineVoiceRefs.push(g));
            _offlineVoiceRefs.push(ampEnv);
            effectNodes.forEach(n => _offlineVoiceRefs.push(n));
          }
          return;
        }
        const wtLeadMs = (typeof startTime === 'number' && Number.isFinite(startTime))
          ? Math.max(0, (startTime - Tone.context.now()) * 1000) : 0;
        setTimeout(() => {
          oscs.forEach(o => { try { o.dispose(); } catch (e) {} });
          gains.forEach(g => { try { g.dispose(); } catch (e) {} });
          try { ampEnv.dispose(); } catch (e) {}
          disposeEffectChain();
        }, wtLeadMs + (preReleaseDur + (env.release || 0.5) + 0.5) * 1000);
        return;
      } else {
        // Sustainable waves: sine / square / triangle / sawtooth /
        // pulse / fat. (Wavetable is handled above as an FMSynth
        // preset — the additive-partials route through OmniOscillator
        // wasn't reliable on Tone v14.)
        // Design "unison" (Phase 2): basic shapes become Tone fat oscillators
        // (count detuned copies, `spread` cents) when a patch asks for >1 voice.
        const oscOpts = type === 'fat'
          ? { type: 'fatsawtooth', count: (_sdOscD && _sdOscD.unison > 1 ? _sdOscD.unison : 3), spread: (_sdOscD ? _sdOscD.spread : 30) }
          : type === 'pulse'
            ? { type: 'pulse', width: 0.4 }
            : (_sdOscD && _sdOscD.unison > 1)
              ? { type: 'fat' + type, count: _sdOscD.unison, spread: _sdOscD.spread }
              : { type };
        synth = new Tone.Synth({
          oscillator: oscOpts,
          envelope: env,
        }).connect(chainHead);
      }

      if (synth.detune) synth.detune.value = detune;
      // VCO automation: an optional modulation source (a Tone.LFO/Signal) is
      // summed into the voice's detune for continuous vibrato/drift. Used by
      // Bloom's per-layer mod. Disposing the synth severs the connection.
      if (synth.detune && params._detuneMod && typeof params._detuneMod.connect === 'function') {
        try { params._detuneMod.connect(synth.detune); } catch (e) {}
      }
      // Design mod-matrix: LFOs / Env2 / Vel / Macros → pitch / cutoff / reso /
      // pan. Built once the synth (and its .detune), filter and mod panner all
      // exist; nodes are pushed onto effectNodes so they're disposed with the
      // voice. No-op (and zero nodes) when the patch has no routings.
      if (typeof _sdBuildModRig === 'function' && params.modMatrix && params.modMatrix.length) {
        try {
          const _modNodes = _sdBuildModRig(params,
            { synth, filter: _sdVoiceFilter, panner: _sdModPanner, gain: _sdModGain },
            { startTime: (typeof startTime === 'number') ? startTime : undefined, dur: targetDur, velocity });
          if (_modNodes && _modNodes.length) _modNodes.forEach(n => effectNodes.unshift(n));
        } catch (e) {}
      }
      // Ring modulator (Phase 4 follow-up): a sine at freq×ratio drives the
      // ring gain inserted above, multiplying the voice for metallic timbres.
      if (_sdRingGain && _sdOscD && _sdOscD.ring > 0) {
        try {
          const ringOsc = new Tone.Oscillator({ frequency: freq * (_sdOscD.ringRatio || 1), type: 'sine' });
          const ringDepth = new Tone.Gain(_sdOscD.ring / 100);
          ringOsc.connect(ringDepth); ringDepth.connect(_sdRingGain.gain);
          const _rt = (typeof startTime === 'number') ? startTime : Tone.now();
          ringOsc.start(_rt);
          effectNodes.unshift(ringOsc, ringDepth);
        } catch (e) {}
      }
      // Design sub-oscillator (Phase 2): an extra oscillator one octave below
      // the note, following the amp envelope, mixed in for low-end weight. Only
      // built when the patch sets sub > 0; disposed with the voice chain.
      if (_sdOscD && _sdOscD.sub > 0) {
        try {
          const subOsc = new Tone.Oscillator({ frequency: freq / 2, type: _sdOscD.subShape || 'sine' });
          const subEnv = new Tone.AmplitudeEnvelope(env);
          const subGain = new Tone.Gain((_sdOscD.sub / 100) * velocity);
          subOsc.connect(subEnv); subEnv.connect(subGain); subGain.connect(chainHead);
          const _st = (typeof startTime === 'number') ? startTime : Tone.now();
          subOsc.start(_st);
          subEnv.triggerAttackRelease(preReleaseDur, _st);
          effectNodes.unshift(subOsc, subEnv, subGain);
        } catch (e) {}
      }
      synth.triggerAttackRelease(freq, preReleaseDur, startTime, velocity);
      // Portamento — glide the synth's base frequency from the layer's previous note up to
      // the target over glideMs (gated; oscillator-path layers handle their own glide). Covers
      // the .frequency synths (FM/AM/Duo/Mono/Membrane/Metal). Independent of the detune bend below.
      if (params.glideMs > 0 && typeof freq === 'number' && freq > 0 && params.glideLayer && synth.frequency) {
        const prev = params.glideLayer._glidePrev;
        const at = (typeof startTime === 'number' && Number.isFinite(startTime)) ? startTime : Tone.now();
        if (prev > 0 && prev !== freq) {
          const gl = Math.min(params.glideMs / 1000, Math.max(0.02, targetDur * 0.95));
          try { synth.frequency.cancelScheduledValues(at); synth.frequency.setValueAtTime(prev, at); synth.frequency.exponentialRampToValueAtTime(freq, at + gl); } catch (e) {}
        }
        params.glideLayer._glidePrev = freq;
      }

      // Pitch bend: ramp the synth's detune from `detune` cents to
      // `detune + bend.semitones * 100` cents over the first
      // `atFraction` of the step duration. Detune is independent of the
      // envelope, so the bend is fully audible across the entire
      // sustain + release tail (a frequency-Param ramp tended to be
      // truncated by the envelope's release window for short steps).
      // Pluck / kick / metal / noise / sample types early-return above,
      // so every synth that reaches here has an automatable .detune.
      if (bend && Number.isFinite(bend.semitones) && bend.semitones !== 0 && synth.detune
          && typeof synth.detune.linearRampToValueAtTime === 'function') {
        const bendStart = (typeof startTime === 'number') ? startTime : Tone.now();
        const at = Math.max(0, Math.min(1, Number.isFinite(bend.atFraction) ? bend.atFraction : 1));
        const bendArrive = bendStart + Math.max(0.001, targetDur * at);
        const startCents = Number.isFinite(detune) ? detune : 0;
        const endCents   = startCents + bend.semitones * 100;
        try {
          synth.detune.cancelScheduledValues(bendStart);
          synth.detune.setValueAtTime(startCents, bendStart);
          synth.detune.linearRampToValueAtTime(endCents, bendArrive);
        } catch (e) {}
      }

      // Skip voice tracking + dispose scheduling during offline export
      // rendering. Both are live-playback machinery (steal-cap keeps
      // overlapping release tails from crunching the limiter; the
      // dispose setTimeout reclaims nodes on wall-clock pacing). In
      // an offline render the synth's envelope drives its own release
      // tail, the synth becomes silent after that, and the offline
      // context is destroyed when the render completes — synths get
      // GC'd then. The wall-clock dispose timer would otherwise fire
      // mid-render and call safeDisposeSynth, which ramps volume to
      // -80 dB starting at offline-current-time and silences voices
      // that haven't played yet.
      //
      // Park a strong ref to the synth (and any per-note FX nodes)
      // in _offlineVoiceRefs so the wrappers survive until the
      // render's finally block clears them. Without this, the
      // wrappers would fall out of scope immediately and Tone.js'
      // scheduled events get dropped when the wrapper is GC'd
      // mid-render — the WAV came out silent.
      if (_offlineSamplerOverride) {
        if (Array.isArray(_offlineVoiceRefs)) {
          _offlineVoiceRefs.push(synth);
          effectNodes.forEach(n => _offlineVoiceRefs.push(n));
        }
        return;
      }
      // Always dispose. Sequence playback now passes a startTime and the
      // pre-fix gate (`if (startTime === undefined)`) silently skipped
      // cleanup, leaking a fresh synth + effect chain on every note.
      const synthLeadMs = (typeof startTime === 'number' && Number.isFinite(startTime))
        ? Math.max(0, (startTime - Tone.context.now()) * 1000)
        : 0;
      const voiceEntry = { synth, effectNodes, pooledPreset, disposeTimer: null, registerTimer: null };
      // When this voice enters its release tail (Tone-context time) + how long
      // that release lasts — drives release-aware voice stealing
      // (_pickVoiceVictim): a sustaining pad isn't chopped by a rapid short layer,
      // and a freshly-released short note isn't culled before it sounds. Sustain
      // ends after preReleaseDur; the tail then lasts `rel` seconds.
      {
        const _startCtx = (typeof startTime === 'number' && Number.isFinite(startTime)) ? startTime : Tone.now();
        voiceEntry.relAtCtx = _startCtx + (Number.isFinite(preReleaseDur) ? preReleaseDur : 0);
        voiceEntry.relDur = Number.isFinite(rel) ? rel : 0;
      }
      voiceEntry.disposeTimer = setTimeout(() => {
        _unregisterVoice(voiceEntry);
        if (pooledPreset) safeReleaseSynth(pooledPreset, synth);
        else              safeDisposeSynth(synth);
        // safeRelease/DisposeSynth ramps to -80 dB over ~30 ms before letting
        // go. Tear the per-note FX chain (incl. the pan Panner) down AFTER that
        // fade — disconnecting it mid-ramp rings the tail through a dead chain
        // and clicks (the steal path already waits this out).
        setTimeout(disposeEffectChain, 80);
      }, synthLeadMs + disposeMs);
      _registerVoiceAtStart(voiceEntry, synthLeadMs);
    }

