    // ---- Custom sample loading (samples/manifest.json) ----
    // Each entry creates a Tone.Sampler that pitch-shifts the file across
    // the keyboard. type strings of the form 'sample:<id>' route through these.
    const sampleSamplers = new Map();

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
      let source = null, ampEnv = null, outGain = null, filter = null, panNode = null, detuneScale = null;
      try {
        const boost = Math.pow(10, SAMPLE_VOLUME_BOOST_DB / 20);
        // Per-note pan: place the voice in the stereo field (e.g. Bloom's
        // Space spread). The synth path has its own panner; samples skipped
        // it until now. Sits between outGain and the destination so it pans
        // the boosted, enveloped signal.
        const panNorm = (opts && Number.isFinite(opts.pan)) ? Math.max(-1, Math.min(1, opts.pan / 100)) : 0;
        let outTail = dest;
        if (Math.abs(panNorm) > 0.001) {
          panNode = new Tone.Panner(panNorm).connect(dest);
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
        // the full note duration. NOTE: Tone's ToneBufferSource (a OneShotSource)
        // schedules an auto-stop at the buffer end in start(); its `loop` setter
        // only cancels that stop when the source has ALREADY started. So loop set
        // here (pre-start) reads true but the source still stops after one play —
        // the trigger sites must re-assert `source.loop = true` AFTER start()
        // (see padLoop in the returned voice) to cancel the pending stop.
        const _padLoop = !!(info && info.padLoop);
        const _srcOpts = { url: audioBuf, playbackRate };
        if (_padLoop) { _srcOpts.loop = true; _srcOpts.loopStart = 0; _srcOpts.loopEnd = audioBuf.duration; }
        source = new Tone.ToneBufferSource(_srcOpts).connect(head);
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
        try { detuneScale && detuneScale.dispose(); } catch (_) {}
        return null;
      }
      // Slice window for source.start(time, offset, duration). offset/duration
      // are pre-rate BUFFER seconds, so convert the caller's musical (output-time)
      // sampleOffsetSec/sliceDurSec by × playbackRate here — the one place that
      // knows the rate. (The buffer consumed for an output-time slice scales with
      // playbackRate, so a transposed slice still covers the right window.)
      const sliceOffset = (opts && Number.isFinite(opts.sampleOffsetSec)) ? Math.max(0, Math.min(audioBuf.duration, opts.sampleOffsetSec * playbackRate)) : 0;
      const sliceBufSec = (opts && Number.isFinite(opts.sliceDurSec)) ? Math.max(0.005, opts.sliceDurSec * playbackRate) : null;
      return { source, ampEnv, outGain, filter, panNode, detuneScale, sliceOffset, sliceBufSec, padLoop: _padLoop };
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
    // to drive iOS into audio-thread underruns ("chops" over time). 16
    // still covers a five-voice chord across three lanes with headroom
    // and keeps the simultaneous-FX node count low enough for iOS to
    // sustain over long sessions.
    const VOICE_CAP = 16;
    const _activeVoices = []; // FIFO; oldest at index 0
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
        _stealVoice(_activeVoices.shift());
      }
    }
    function _unregisterVoice(entry) {
      const i = _activeVoices.indexOf(entry);
      if (i >= 0) _activeVoices.splice(i, 1);
    }
    function _stealVoice(entry) {
      if (!entry || entry._stolen) return;
      entry._stolen = true;
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
    function _registerSampleVoice(v) {
      if (!v) return;
      while (_activeSampleVoices.size >= MAX_SAMPLE_VOICES) {
        const oldest = _activeSampleVoices.values().next().value;
        if (!oldest) break;
        _activeSampleVoices.delete(oldest);
        try { _killSampleVoiceFast(oldest); } catch (e) {}
      }
      _activeSampleVoices.add(v);
    }
    function _unregisterSampleVoice(v) { if (v) _activeSampleVoices.delete(v); }
    // Fast, click-free kill of one sample voice: ramp its output to silence
    // over ~22 ms, then dispose. Cancels any pending natural-disposal timer.
    function _killSampleVoiceFast(v) {
      if (!v || v._killed) return;
      v._killed = true;
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
    // Immediately silence every SCHEDULED playback voice — synths (a ~30 ms
    // safeDisposeSynth fade) and per-note samples (a ~22 ms ramp). Both are
    // click-free, so "immediate" doesn't mean a hard cut/pop. Called by every
    // user stop gesture (transport stop, Bloom stop) so release tails don't
    // keep ringing after the user asked for silence.
    function silenceActiveVoices() {
      const synthVictims = _activeVoices.splice(0, _activeVoices.length);
      synthVictims.forEach(v => { try { _stealVoice(v); } catch (e) {} });
      const sampVictims = Array.from(_activeSampleVoices);
      _activeSampleVoices.clear();
      sampVictims.forEach(v => { try { _killSampleVoiceFast(v); } catch (e) {} });
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
        // Full-ADSR held voice: attack → decay → sustain (held), then release
        // on pointer-up — the sound editor's full envelope (+ optional filter)
        // shapes the held sample, not just a fade in/out.
        const sampleDest = fxOverrideGlobal ? masterLimiter : globalSendTap;
        const v = _buildSampleAdsrVoice(entry.sampler, type.slice(7), tunedFreq, env, sampleDest,
          { filterCutoff: params.filterCutoff, filterQ: params.filterQ, pan });
        if (v) {
          const triggerAt = _warmAt();
          try {
            v.source.start(triggerAt);
            // Re-assert loop AFTER start() — the setter cancels the OneShotSource
            // auto-stop only once started, so this is what actually makes a pad
            // loop indefinitely while held (vs. playing once and cutting off).
            if (v.padLoop) { try { v.source.loop = true; } catch (e) {} }
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
        const pn = new Tone.Panner(panNorm).connect(chainHead);
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
            distortion: Math.max(0, Math.min(1, distortion / 100)), wet: 1,
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
      let pooledPresetKey = null;
      if (VOICE_POOL_ENABLED && _isPooledPreset(type)) {
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
          harmonicity: 3, modulationIndex: 10,
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
          harmonicity: 1.5,
          vibratoAmount: 0.3,
          vibratoRate: 5,
        }).connect(chainHead);
      } else if (type === 'am') {
        synth = new Tone.AMSynth({
          harmonicity: 2,
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
        const wt = (Array.isArray(params.wavetableMix) && params.wavetableMix.length === 3)
          ? params.wavetableMix.map(v => Math.max(0, Math.min(1, Number(v) || 0)))
          : [1.0, 0.5, 0.3];
        const ampEnv = new Tone.AmplitudeEnvelope({
          attack: env.attack, decay: env.decay,
          sustain: env.sustain, release: env.release,
        }).connect(chainHead);
        const wtOscs = [];
        const wtGains = [];
        ['sine', 'sawtooth', 'triangle'].forEach((t, i) => {
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
        let oscOpts;
        if      (type === 'pulse') oscOpts = { type: 'pulse', width: 0.4 };
        else if (type === 'fat')   oscOpts = { type: 'fatsawtooth', count: 3, spread: 30 };
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
      let _triggerAt = startAt != null ? startAt : _coldStartAt;
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

      let released = false;
      return {
        release: () => {
          if (released) return; released = true;
          try { synth.triggerRelease(); } catch (e) {}
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
      // Ensemble voices expand into their member tones BEFORE the capture hook,
      // so each member (not the wrapper) is what gets captured/replayed.
      if (isEnsembleType(params.type)) { _playEnsemble(freq, params, durationMs, startTime, destination, trackIdx, laneIdx); return; }
      // Bloom layer Freeze "recording": tee scheduled notes to the active
      // capture sink (set around a recording layer's emit in the Bloom tick).
      if (typeof window !== 'undefined' && window._ambCaptureSink) {
        try { window._ambCaptureSink(freq, params, durationMs, startTime); } catch (e) {}
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
      const preReleaseDur = durationMs
        ? Math.max(0.02, targetDur - rel)
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
          const fire = () => {
            try { player.start(triggerAt, 0, dur); }
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
          const v = _buildSampleAdsrVoice(sampler, type.slice(7), tunedFreq, env, sampleDest,
            { filterCutoff: params.filterCutoff, filterQ: params.filterQ, detuneMod: params._detuneMod, pan,
              sampleOffsetSec: params.sampleOffsetSec, sliceDurSec: params.sliceDurSec });
          if (v) {
            const triggerAt = (typeof startTime === 'number' && Number.isFinite(startTime)) ? startTime : Tone.now();
            try {
              // Slice window when present (offset>0 or a bounded duration); else
              // the plain whole-buffer start — byte-identical to the prior path.
              if (v.sliceBufSec != null || v.sliceOffset > 0) v.source.start(triggerAt, v.sliceOffset, v.sliceBufSec != null ? v.sliceBufSec : undefined);
              else v.source.start(triggerAt);
              // Pad: re-assert loop AFTER start() to cancel the OneShotSource
              // auto-stop, so the buffer loops to fill the step (the explicit
              // stop below then bounds it to the slot).
              if (v.padLoop) { try { v.source.loop = true; } catch (e) {} }
              // Hold for preReleaseDur (= targetDur − release, ≥ 0.02), then
              // release over `rel` — same envelope timing the synth path uses,
              // so a sample voice and a synth voice sit identically in a slot.
              v.ampEnv.triggerAttackRelease(preReleaseDur, triggerAt, velocity);
              try { v.source.stop(triggerAt + preReleaseDur + rel + 0.1); } catch (e) {}
            } catch (e) {
              _disposeSampleAdsrVoice(v);
              return;
            }
            // Track as a playback voice so a user stop can cut it immediately;
            // skip during offline export (no real-time stop there).
            if (!_offlineSamplerOverride) _registerSampleVoice(v);
            const leadMs = (typeof startTime === 'number' && Number.isFinite(startTime))
              ? Math.max(0, (startTime - Tone.context.now()) * 1000) : 0;
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
        const pn = new Tone.Panner(panNorm).connect(chainHead);
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
          wet: 1,
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
      const disposeEffectChain = () => {
        effectNodes.forEach(n => { try { n.dispose(); } catch (e) {} });
      };

      let synth;

      // Phase 1 voice pool — acquire a pre-configured synth body for
      // pooled presets instead of constructing one. Bypassed during
      // offline render (separate AudioContext) and for presets that
      // have their own lifecycle below (pluck/noise/wavetable early-
      // return; duo/kick/metal aren't pooled yet). pooledPreset gets
      // recorded on the voice entry so the dispose timer + steal path
      // route the synth back to the pool instead of disposing it.
      let pooledPreset = null;
      if (VOICE_POOL_ENABLED && !_offlineSamplerOverride && _isPooledPreset(type)) {
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
        const pluckEntry = { synth, effectNodes, disposeTimer: null };
        pluckEntry.disposeTimer = setTimeout(() => {
          _unregisterVoice(pluckEntry);
          safeDisposeSynth(synth);
          disposeEffectChain();
        }, pluckLeadMs + (targetDur + 1.5) * 1000);
        _registerVoice(pluckEntry);
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
        const noiseEntry = { synth: ns, effectNodes, disposeTimer: null };
        noiseEntry.disposeTimer = setTimeout(() => {
          _unregisterVoice(noiseEntry);
          safeDisposeSynth(ns);
          disposeEffectChain();
        }, noiseLeadMs + disposeMs);
        _registerVoice(noiseEntry);
        return;
      } else if (type === 'fm') {
        synth = new Tone.FMSynth({
          harmonicity: 3,
          modulationIndex: 10,
          oscillator: { type: 'sine' },
          envelope: env,
          modulation: { type: 'square' },
          modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 },
        }).connect(chainHead);
      } else if (type === 'duo') {
        synth = new Tone.DuoSynth({
          voice0: { oscillator: { type: 'sine'    }, envelope: env },
          voice1: { oscillator: { type: 'sawtooth'}, envelope: env },
          harmonicity: 1.5,
          vibratoAmount: 0.3,
          vibratoRate: 5,
        }).connect(chainHead);
      } else if (type === 'am') {
        synth = new Tone.AMSynth({
          harmonicity: 2,
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
        const wt = (Array.isArray(params.wavetableMix) && params.wavetableMix.length === 3)
          ? params.wavetableMix.map(v => Math.max(0, Math.min(1, Number(v) || 0)))
          : [1.0, 0.5, 0.3];
        try {
          console.log('[wavetable] fire freq=', freq,
            'mix=', wt,
            'velocity=', velocity,
            'preReleaseDur=', preReleaseDur,
            'startTime=', startTime,
            'destination=', destination ? 'set' : 'null',
            'laneIdx=', laneIdx);
        } catch (e) {}
        const ampEnv = new Tone.AmplitudeEnvelope({
          attack:  env.attack, decay: env.decay,
          sustain: env.sustain, release: env.release,
        }).connect(chainHead);
        const oscTypes = ['sine', 'sawtooth', 'triangle'];
        const oscs = [];
        const gains = [];
        oscTypes.forEach((t, i) => {
          const osc = new Tone.Oscillator({
            type: t,
            frequency: freq,
            detune,
          });
          const g = new Tone.Gain(wt[i]);
          osc.connect(g);
          g.connect(ampEnv);
          oscs.push(osc);
          gains.push(g);
        });
        const triggerAt = (typeof startTime === 'number' && Number.isFinite(startTime))
          ? startTime : Tone.now();
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
        const oscOpts = type === 'fat'
          ? { type: 'fatsawtooth', count: 3, spread: 30 }
          : type === 'pulse'
            ? { type: 'pulse', width: 0.4 }
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
      synth.triggerAttackRelease(freq, preReleaseDur, startTime, velocity);

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
      const voiceEntry = { synth, effectNodes, pooledPreset, disposeTimer: null };
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
      _registerVoice(voiceEntry);
    }

