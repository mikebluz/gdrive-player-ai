//! bloops-dsp — Phase 1: the Bloops voice engine core.
//!
//! One WASM instance inside one AudioWorklet renders every core-mode voice
//! into per-layer stereo buses ("slots"), which the host connects to the
//! existing per-layer WebAudio chains. Notes arrive as scheduled events
//! (Bloom dispatches ≥0.3 s ahead) and start sample-accurately inside the
//! render loop. Fixed voice pool — the allocator CANNOT leak; overflow
//! steals the most-decayed voice, mirroring the app's steal policy.
//!
//! Voice kinds (matching the app's presets in 04-instruments-samples):
//!   0 sine   Tone.Synth, sine osc, note ADSR
//!   1 fm     Tone.FMSynth  h3    i10  square mod, modEnv .5/0/1/.5, note ADSR
//!   2 bass   Tone.MonoSynth square → 2×biquad LP (env-swept) → note ADSR
//!   3 bell   Tone.FMSynth  h2.14 i4   sine mod, modEnv .001/.5/.2/.5, FIXED amp .001/2/0/.8
//!   4 xylo   Tone.FMSynth  h7    i4   sine mod, modEnv .001/.2/0/.2,  FIXED amp .001/.5/0/.3
//!   5 am     Tone.AMSynth  h2         square mod, modEnv .5/0/1/.5,   note ADSR
//!   6 pad    Tone.AMSynth  h1.5       sine mod,  modEnv 1/.5/.5/2,    FIXED amp 1.2/.5/.7/2.5
//!   7 duo    Tone.DuoSynth: sine@f + saw@1.5f, each through a MonoSynth-
//!            default LP (Q6 -12dB, filterEnv .6/.2/.5/2 base200 oct3),
//!            5 Hz vibrato, note ADSR
//!   8 noise  Tone.NoiseSynth, p0 = color (0 white, 1 pink, 2 brown), note ADSR
//!   9 kick   Tone.MembraneSynth: sine, freq sweeps 10f→f exp over 50 ms,
//!            FIXED amp .001/.4/.01/1.4
//!  10 metal  Tone.MetalSynth-ish: square-FM h5.1 i32 → highpass 4 kHz,
//!            FIXED amp .001/1.4/0/.2
//!  11 pluck  Tone.PluckSynth: Karplus-Strong, dampening 4 kHz, resonance .7
//!  12 wavetable  legacy default stack: sine 1.0 + saw 0.5 + tri 0.3, note ADSR
//!
//! Every kind's depth/resonance is CALIBRATED against recorded Tone output
//! (see CAL / BASS_Q and the voice-ab harness) — matching the sound projects
//! were built on beats deriving from Tone's internals (proven twice: FM depth
//! ×0.25, bass per-section Q 1.6 vs the "obvious" 4).
//!
//! Flat C ABI, no allocation in the audio path, single-threaded.

#![allow(static_mut_refs)]

mod sample;
mod strip;

const MAX_VOICES: usize = 256;
pub(crate) const SLOTS: usize = 16;
pub(crate) const BLOCK: usize = 128;
pub(crate) const TAU: f32 = core::f32::consts::TAU;

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Free,
    Scheduled,
    Playing,
    Released,
}

#[derive(Clone, Copy)]
struct Voice {
    stage: Stage,
    slot: usize,
    kind: u32,
    freq: f32,
    vel: f32,
    gain_l: f32,
    gain_r: f32,
    t_start: f64,
    t_rel: f64,
    // amp envelope (note ADSR, or the preset's fixed envelope)
    a: f32,
    d: f32,
    s: f32,
    r: f32,
    env: f32,
    rel_from: f32,
    // synth params (set per kind at note-on)
    harm: f32,     // modulator freq ratio
    idx: f32,      // FM index × per-kind calibration × velocity
    mod_sine: bool, // modulator wave: sine (true) or band-limited square
    me_a: f32, me_d: f32, me_s: f32, me_r: f32, // modulation envelope
    // oscillators
    ph_c: f32,
    ph_m: f32,
    kmax: u32, // square-modulator partial cap
    // bass filter: 2 cascaded biquad LP sections + control-rate coeffs
    fs: [f32; 8],
    fc_b: [f32; 3],
    fc_a: [f32; 2],
    fc_n: u32,
    p0: f32,   // generic per-kind param (noise color, wave id, …)
    aux0: u32, // per-kind int state (PRNG, pluck buffer index)
    aux1: u32, // per-kind int state (pluck delay length / write pos)
    // ---- design-voice state ----
    d_flags: u32,
    d_ftype: u32,
    d_fcut: f32,
    d_fq: f32,
    d_foct: f32, // precomputed fenv octaves (amount + vel·velocity)
    d_fa: f32, d_fd: f32, d_fs: f32, d_fr: f32,
    d_uni: u32,
    d_spread: f32,
    d_sub: f32,
    d_subsq: bool,
    d_ring: f32,
    d_ringratio: f32,
    d_lshape: [i32; 2],
    d_lrate: [f32; 2],
    d_e2: [f32; 4],
    d_macro: [f32; 4],
    d_nroutes: u32,
    d_routes: [[f32; 3]; MAX_ROUTES],
    // dedicated PITCH ENVELOPE (drum "boom→thud"): a fast AD that adds
    // d_pe_amt CENTS to the pitch (deep range, independent of the ±1200-cent mod
    // matrix). Attacks to peak over d_pe_atk, decays to 0 over d_pe_dec. Off when
    // amt == 0 (flag bit 64), so it's byte-identical when unused.
    d_pe_amt: f32,
    d_pe_atk: f32,
    d_pe_dec: f32,
    // control-rate mod values (updated every 16 frames)
    m_pitch: f32, // frequency multiplier
    m_amp: f32,
    m_pan: f32,
    m_n: u32,
    tag: u32,     // host handle for held notes (0 = none)
    bend: f32,    // live pitch-bend multiplier (slewed toward bend_t)
    bend_t: f32,
    // design filter (2 sections) + unison/sub/ring phases
    g_s: [f32; 8],
    g_b: [f32; 3],
    g_a: [f32; 2],
    uni_ph: [f32; MAX_UNI],
    sub_ph: f32,
    ring_ph: f32,
}

const VOICE0: Voice = Voice {
    stage: Stage::Free, slot: 0, kind: 0, freq: 440.0, vel: 1.0,
    gain_l: 0.707, gain_r: 0.707, t_start: 0.0, t_rel: 0.0,
    a: 0.01, d: 0.1, s: 0.5, r: 0.1, env: 0.0, rel_from: 0.0,
    harm: 1.0, idx: 0.0, mod_sine: true,
    me_a: 0.001, me_d: 0.001, me_s: 1.0, me_r: 0.1,
    ph_c: 0.0, ph_m: 0.0, kmax: 1,
    fs: [0.0; 8], fc_b: [0.0; 3], fc_a: [0.0; 2], fc_n: 0,
    p0: 0.0, aux0: 1, aux1: 0,
    d_flags: 0, d_ftype: 0, d_fcut: 12000.0, d_fq: 0.7, d_foct: 0.0,
    d_fa: 0.001, d_fd: 0.001, d_fs: 1.0, d_fr: 0.1,
    d_uni: 1, d_spread: 20.0, d_sub: 0.0, d_subsq: false,
    d_ring: 0.0, d_ringratio: 1.0,
    d_lshape: [-1; 2], d_lrate: [1.0; 2], d_e2: [-1.0, 0.001, 1.0, 0.1],
    d_macro: [0.0; 4], d_nroutes: 0, d_routes: [[0.0; 3]; MAX_ROUTES],
    d_pe_amt: 0.0, d_pe_atk: 0.001, d_pe_dec: 0.05,
    m_pitch: 1.0, m_amp: 1.0, m_pan: 0.0, m_n: 0,
    tag: 0, bend: 1.0, bend_t: 1.0,
    g_s: [0.0; 8], g_b: [0.0; 3], g_a: [0.0; 2],
    uni_ph: [0.0; MAX_UNI], sub_ph: 0.0, ring_ph: 0.0,
};

static mut VOICES: [Voice; MAX_VOICES] = [VOICE0; MAX_VOICES];
pub(crate) static mut OUT: [[[f32; BLOCK]; 2]; SLOTS] = [[[0.0; BLOCK]; 2]; SLOTS];
pub(crate) static mut SR: f32 = 44100.0;
pub(crate) static mut DT: f32 = 1.0 / 44100.0;
static mut LAST_T: f64 = -1.0;

// ---- Design-voice parameter STAGING buffer --------------------------------
// The host writes one note's design params here, then calls note_ex(); the
// port serializes messages so staging→note is atomic. Layout (f32 slots):
//   0  flags: 1 filter | 2 filterEnv | 4 sub | 8 ring | 16 unison | 32 modmatrix
//   1  filter type (0 lp / 1 hp / 2 bp)     2 cutoff Hz        3 Q
//   4  fenv amount (-100..100)              5 fenv vel (0..100)
//   6..9  fenv a/d/s/r (s, s, 0..1, s)
//   10 unison count (2..7)                  11 spread cents
//   12 sub level 0..1                       13 sub shape (0 sine / 1 square)
//   14 ring level 0..1                      15 ring ratio
//   16 harmonicity override (-1 none)       17 modIndex override (-1 none)
//   18 lfo1 shape (0 sine/1 tri/2 saw/3 sq/4 smooth/5 sharp, -1 off)
//   19 lfo1 rate Hz                         20 lfo2 shape    21 lfo2 rate
//   22..25 env2 a/d/s/r (-1 a = off)
//   26..29 macro1..4 (0..1)
//   30 route count N (max 8)
//   31.. routes ×3: src (0 lfo1/1 lfo2/2 env2/3 vel/4..7 macro1-4),
//                   dest (0 pitch/1 cutoff/2 reso/3 amp/4 pan), amount -1..1
static mut NOTE_CURSOR: usize = 0; // voice index used by the last note()
const PARAMS_LEN: usize = 64;
pub(crate) static mut PARAMS: [f32; PARAMS_LEN] = [0.0; PARAMS_LEN];

// Bumped on every DSP change — surfaced in the worklet-ready log so a stale
// cached .wasm is immediately visible.
const CORE_REV: u32 = 10;

#[no_mangle]
pub extern "C" fn core_rev() -> u32 {
    CORE_REV
}

#[no_mangle]
pub extern "C" fn params_ptr() -> *mut f32 {
    unsafe { PARAMS.as_mut_ptr() }
}

const MAX_ROUTES: usize = 8;
const MAX_UNI: usize = 7;
// Full-scale mod ranges (match 20-sound-design SD_DEST_RANGE):
// pitch 1200 cents, cutoff 4000 Hz, reso 8 Q, amp 0.9, pan 1.
const DEST_RANGE: [f32; 5] = [1200.0, 4000.0, 8.0, 0.9, 1.0];
// Per-section Q mapping for the -24dB design filter — derived from the bass
// calibration (preset Q4 → measured per-section 1.6 = ×0.4).
const DESIGN_Q_SCALE: f32 = 0.4;

// Per-kind depth calibration, tuned against recorded Tone spectra with the
// voice-ab harness. Index = kind. fm's 0.25 was swept 2026-07-03 (every
// partial within 1 dB of Tone). Others start at fm's value (same Multiply
// topology) and get their own sweep before ear-testing.
// Swept values (voice-ab/voice2-ab, 2026-07-03): fm 0.25, bell 0.25,
// xylo 0.3, am 0.3, pad 0.3, duo 1.6 (static-cutoff scaler: 2500·1.6 =
// 4 kHz matched the recorded rolloff within 1 dB/partial) — each vs its
// recorded Tone spectrum. Indices 8+ unused-by-depth kinds default 1.
static mut CAL: [f32; 16] = [1.0, 0.25, 1.0, 0.25, 0.3, 0.3, 0.3, 1.6,
                             1.0, 1.0, 0.25, 1.0, 1.0, 1.0, 1.0, 1.0];
// Per-kind OUTPUT GAIN, swept against recorded Tone levels (corrected pan
// law): FM/AM family 0.32; duo 1.9; noise 0.5 (pink/brown carry an extra
// 0.82 colour factor in-render); kick 0.85; metal 0.5 (NO Tone reference —
// MetalSynth records silent even when triggered per its own signature, and
// the app's playNote mistriggers it too, so the core version is tuned to
// be musical rather than matched); pluck 1.0; wavetable 1.4.
static mut GAIN: [f32; 16] = [1.0, 0.32, 1.0, 0.32, 0.32, 0.32, 0.32, 1.9,
                              0.5, 0.85, 0.5, 1.0, 1.4, 1.0, 1.0, 1.0];

#[no_mangle]
pub extern "C" fn set_kind_cal(kind: u32, k: f32) {
    unsafe { CAL[(kind as usize).min(15)] = k.clamp(0.01, 4.0) }
}

#[no_mangle]
pub extern "C" fn set_kind_gain(kind: u32, g: f32) {
    unsafe { GAIN[(kind as usize).min(15)] = g.clamp(0.05, 4.0) }
}

// Back-compat alias used by the fm harness.
#[no_mangle]
pub extern "C" fn set_fm_cal(k: f32) {
    set_kind_cal(1, k);
}

// ---- bass (MonoSynth preset) constants -----------------------------------
const BASS_FBASE: f32 = 80.0;
const BASS_FOCT: f32 = 3.2;
const BASS_FA: f32 = 0.005;
const BASS_FD: f32 = 0.18;
const BASS_FS: f32 = 0.4;
const BASS_FR: f32 = 0.4;
// Per-section resonance — calibrated: 1.6 matches every partial ≤1 dB
// (194 Hz resonant peak exact); the preset's nominal Q=4 per section
// measured +11 dB hot. Tone's -24 rolloff doesn't distribute Q naively.
static mut BASS_Q: f32 = 1.6;

#[no_mangle]
pub extern "C" fn set_bass_q(q: f32) {
    unsafe { BASS_Q = q.clamp(0.1, 12.0) }
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    unsafe {
        SR = sample_rate;
        DT = 1.0 / sample_rate;
        for v in VOICES.iter_mut() {
            *v = VOICE0;
        }
        // Full reset of ALL engine globals — init() is the golden-render
        // test's section boundary, so every run must be bit-deterministic.
        LAST_T = -1.0;
        NOTE_CURSOR = 0;
        for o in PLUCK_OWNER.iter_mut() {
            *o = -1;
        }
        for b in OUT.iter_mut() {
            for c in b.iter_mut() {
                for f in c.iter_mut() {
                    *f = 0.0;
                }
            }
        }
    }
    strip::reset_all();
    sample::reset_all();
}

#[no_mangle]
pub extern "C" fn out_ptr(slot: u32, ch: u32) -> *mut f32 {
    unsafe { OUT[(slot as usize) % SLOTS][(ch as usize) & 1].as_mut_ptr() }
}

fn alloc_voice() -> usize {
    unsafe {
        for (i, v) in VOICES.iter().enumerate() {
            if v.stage == Stage::Free {
                return i;
            }
        }
        let mut best = 0usize;
        let mut best_score = f32::MAX;
        for (i, v) in VOICES.iter().enumerate() {
            let score = match v.stage {
                Stage::Released => v.env,
                _ => 1.0 + v.t_start as f32 * 1e-9,
            };
            if score < best_score {
                best_score = score;
                best = i;
            }
        }
        best
    }
}

// ---- pluck (Karplus-Strong) delay-line pool --------------------------------
const PLUCK_BUFS: usize = 32;
const PLUCK_LEN: usize = 2048;
static mut PLUCK: [[f32; PLUCK_LEN]; PLUCK_BUFS] = [[0.0; PLUCK_LEN]; PLUCK_BUFS];
static mut PLUCK_OWNER: [i32; PLUCK_BUFS] = [-1; PLUCK_BUFS];

#[inline(always)]
fn xorshift(state: &mut u32) -> f32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    (x as f32 / u32::MAX as f32) * 2.0 - 1.0
}

#[no_mangle]
pub extern "C" fn note(
    slot: u32, kind: u32, freq: f32, vel: f32, pan: f32, t_start: f64, dur: f32,
    a: f32, d: f32, s: f32, r: f32, detune: f32, p0: f32, tag: u32,
) {
    unsafe {
        let i = alloc_voice();
        NOTE_CURSOR = i;
        // free a pluck buffer this voice may have owned in a past life
        for o in PLUCK_OWNER.iter_mut() {
            if *o == i as i32 {
                *o = -1;
            }
        }
        let v = &mut VOICES[i];
        let f = freq * exp2f(detune / 1200.0);
        // Pan law matches the node engine exactly: at pan 0 playNote creates
        // NO panner — the mono voice upmixes at unity into both channels —
        // and only a non-zero pan goes through a StereoPannerNode
        // (L=cos, R=sin equal-power). Splitting equal-power at center was
        // -3 dB per channel vs the old engine in the mix.
        let p = pan.clamp(-1.0, 1.0);
        let (gl, gr) = if p.abs() < 0.005 {
            (1.0, 1.0)
        } else {
            let ang = (p + 1.0) * 0.25 * core::f32::consts::PI;
            (ang.cos(), ang.sin())
        };
        let vel = vel.clamp(0.0, 1.0);
        let cal = CAL[(kind as usize).min(15)];
        let out_gain = GAIN[(kind as usize).min(15)];
        // per-kind synth params (see the header table)
        let (harm, idx, mod_sine, me, amp_fixed): (f32, f32, bool, [f32; 4], Option<[f32; 4]>) =
            match kind {
                1 => (3.0, 10.0 * cal * vel, false, [0.5, 0.001, 1.0, 0.5], None),
                3 => (2.14, 4.0 * cal * vel, true, [0.001, 0.5, 0.2, 0.5], Some([0.001, 2.0, 0.0, 0.8])),
                4 => (7.0, 4.0 * cal * vel, true, [0.001, 0.2, 0.0, 0.2], Some([0.001, 0.5, 0.0, 0.3])),
                5 => (2.0, cal * vel, false, [0.5, 0.001, 1.0, 0.5], None),
                6 => (1.5, cal * vel, true, [1.0, 0.5, 0.5, 2.0], Some([1.2, 0.5, 0.7, 2.5])),
                9 => (1.0, 0.0, true, [0.001, 0.001, 1.0, 0.1], Some([0.001, 0.4, 0.01, 1.4])),
                // pluck: NO shaping amp envelope — the Karplus-Strong string IS
                // the envelope (Tone.PluckSynth has none; its triggerRelease
                // just ramps the string's resonance down over ~1 s). A fixed
                // transparent env (sustain 1, 1 s release past the note gate)
                // lets the string ring naturally instead of chopping it at the
                // note duration ("pluck sounds abbreviated").
                // release 3.0: the exponential amp release attenuates ~7x
                // faster early-on than Tone's post-gate resonance ramp (1 s,
                // linear-ish) — at 3.0 the two track for low, long-ringing
                // strings (the audible case; mid/high strings die first).
                11 => (1.0, 0.0, true, [0.001, 0.001, 1.0, 0.1], Some([0.003, 0.001, 1.0, 3.0])),
                10 => (5.1, 32.0 * cal * vel, false, [0.001, 0.001, 1.0, 0.1], Some([0.001, 1.4, 0.0, 0.2])),
                // hard sync (kind 14): harm = slave/master ratio (from p0, ≥1);
                // idx = ratio-SWEEP depth (0 = static ratio; set via the design
                // modIndex override dp[17]) driven by the mod envelope below —
                // defaults shape the classic 0.4 s sync sweep.
                14 => (p0.max(1.0), 0.0, true, [0.001, 0.4, 0.0, 0.3], None),
                _ => (1.0, 0.0, true, [0.001, 0.001, 1.0, 0.1], None),
            };
        let (aa, dd, ss, rr) = match amp_fixed {
            Some(e) => (e[0], e[1], e[2], e[3]),
            None => (a, d, s, r),
        };
        *v = Voice {
            stage: Stage::Scheduled,
            slot: (slot as usize) % SLOTS,
            kind,
            freq: f,
            vel,
            gain_l: gl * out_gain,
            gain_r: gr * out_gain,
            t_start,
            // dur < 0 = HOLD until release_tag (live press-and-hold)
            t_rel: if dur < 0.0 { 1.0e15 } else { t_start + dur.max(0.02) as f64 },
            a: aa.max(0.001),
            d: dd.max(0.001),
            s: ss.clamp(0.0, 1.0),
            r: rr.max(0.02),
            env: 0.0,
            rel_from: 0.0,
            harm,
            idx,
            mod_sine,
            me_a: me[0].max(0.001), me_d: me[1].max(0.001), me_s: me[2], me_r: me[3].max(0.02),
            ph_c: 0.0,
            ph_m: 0.0,
            kmax: {
                let fm = f * harm;
                let nyq = SR * 0.5;
                if fm <= 0.0 { 1 } else { ((nyq / fm) as u32).clamp(1, 21) | 1 }
            },
            fs: [0.0; 8],
            fc_b: [0.0; 3],
            fc_a: [0.0; 2],
            fc_n: 0,
            p0,
            aux0: (i as u32).wrapping_mul(2654435761).wrapping_add(1) | 1, // PRNG seed
            aux1: 0,
            tag,
            ..VOICE0 // design fields default off; note_ex fills them after
        };
        // pluck: claim a delay buffer and load the noise burst
        if kind == 11 {
            let mut slot_b = usize::MAX;
            for (bi, o) in PLUCK_OWNER.iter().enumerate() {
                if *o < 0 {
                    slot_b = bi;
                    break;
                }
            }
            if slot_b == usize::MAX {
                slot_b = i % PLUCK_BUFS; // steal deterministically
            }
            PLUCK_OWNER[slot_b] = i as i32;
            let n = ((SR / v.freq.max(20.0)) as usize).clamp(2, PLUCK_LEN);
            let mut seed = v.aux0;
            // PINK noise burst (Kellet filter) — Tone.PluckSynth excites with
            // pink, not white; white measured a ~3x-hot, brighter attack.
            let (mut p0, mut p1, mut p2) = (0.0f32, 0.0f32, 0.0f32);
            for k in 0..n {
                let w = xorshift(&mut seed);
                p0 = 0.99765 * p0 + w * 0.0990460;
                p1 = 0.96300 * p1 + w * 0.2965164;
                p2 = 0.57000 * p2 + w * 1.0526913;
                // Ramped fill: Tone's noise feeds the comb gradually through
                // the damping filter, so the first output pass is soft — an
                // instantly-full buffer gave a ~3x-hot attack click. The 0.9
                // level lands the decay tail on the recorded Tone curve.
                PLUCK[slot_b][k] = (p0 + p1 + p2 + w * 0.1848) * 0.2
                    * ((k + 1) as f32 / n as f32) * 0.9;
            }
            v.aux0 = slot_b as u32; // repurpose: buffer index
            v.aux1 = n as u32;      // delay length; fs[1] = write pos cursor
            v.fs[0] = 0.0;          // damping filter state
            v.fs[1] = 0.0;          // read/write position
        }
    }
}

/// note() plus design params from the staging buffer (see PARAMS layout).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn note_ex(
    slot: u32, kind: u32, freq: f32, vel: f32, pan: f32, t_start: f64, dur: f32,
    a: f32, d: f32, s: f32, r: f32, detune: f32, p0: f32, tag: u32,
) {
    unsafe {
        let idx_before = NOTE_CURSOR;
        note(slot, kind, freq, vel, pan, t_start, dur, a, d, s, r, detune, p0, tag);
        let i = idx_before; // note() stored the voice index here
        let v = &mut VOICES[i];
        let q = &PARAMS;
        let flags = q[0] as u32;
        v.d_flags = flags;
        if flags & 1 != 0 {
            v.d_ftype = q[1] as u32;
            v.d_fcut = q[2].clamp(20.0, 20000.0);
            v.d_fq = q[3].clamp(0.1, 20.0);
        }
        if flags & 2 != 0 {
            // fenv octaves: amount/100·5 + vel-part/100·5·velocity (node math)
            v.d_foct = (q[4] / 100.0) * 5.0 + (q[5] / 100.0) * 5.0 * v.vel;
            v.d_fa = q[6].max(0.001);
            v.d_fd = q[7].max(0.001);
            v.d_fs = q[8].clamp(0.0, 1.0);
            v.d_fr = q[9].max(0.001);
        }
        if flags & 16 != 0 {
            v.d_uni = (q[10] as u32).clamp(2, MAX_UNI as u32);
            v.d_spread = q[11].clamp(0.0, 100.0);
        }
        if flags & 4 != 0 {
            v.d_sub = q[12].clamp(0.0, 1.0);
            v.d_subsq = q[13] > 0.5;
        }
        if flags & 8 != 0 {
            v.d_ring = q[14].clamp(0.0, 1.0);
            v.d_ringratio = q[15].clamp(0.25, 8.0);
        }
        if q[16] >= 0.0 { v.harm = q[16]; }
        if q[17] >= 0.0 { v.idx = q[17] * CAL[(kind as usize).min(15)] * v.vel; }
        if flags & 32 != 0 {
            v.d_lshape = [q[18] as i32, q[20] as i32];
            v.d_lrate = [q[19].max(0.01), q[21].max(0.01)];
            v.d_e2 = [q[22], q[23].max(0.001), q[24].clamp(0.0, 1.0), q[25].max(0.001)];
            v.d_macro = [q[26], q[27], q[28], q[29]];
            v.d_nroutes = (q[30] as u32).min(MAX_ROUTES as u32);
            for k in 0..v.d_nroutes as usize {
                v.d_routes[k] = [q[31 + k * 3], q[32 + k * 3], q[33 + k * 3]];
            }
        }
        if flags & 64 != 0 {
            // dedicated pitch envelope — dp[55] amount (cents, signed),
            // dp[56] attack (s), dp[57] decay (s).
            v.d_pe_amt = q[55].clamp(-9600.0, 9600.0);
            v.d_pe_atk = q[56].max(0.0);
            v.d_pe_dec = q[57].max(0.001);
        }
    }
}

/// Release a held note (grid press-up). r overrides the release seconds
/// (<=0 keeps the voice's own).
#[no_mangle]
pub extern "C" fn release_tag(tag: u32, r: f32) {
    if tag == 0 {
        return;
    }
    sample::release_tag(tag, r);
    unsafe {
        for v in VOICES.iter_mut() {
            if v.tag != tag {
                continue;
            }
            match v.stage {
                Stage::Scheduled => v.stage = Stage::Free,
                Stage::Playing => {
                    if r > 0.0 { v.r = r; }
                    v.stage = Stage::Released;
                    v.rel_from = v.env;
                    v.t_rel = 0.0; // anchor at the next processed block
                }
                _ => {}
            }
        }
    }
}

/// Live pitch bend for a held note (Radial Tone slide): cents, slewed.
#[no_mangle]
pub extern "C" fn bend_tag(tag: u32, cents: f32) {
    sample::bend_tag(tag, cents);
    if tag == 0 {
        return;
    }
    unsafe {
        for v in VOICES.iter_mut() {
            if v.tag == tag && v.stage != Stage::Free {
                v.bend_t = exp2f(cents.clamp(-4800.0, 4800.0) / 1200.0);
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn cancel_from(slot: u32, t: f64) {
    sample::cancel_from((slot as usize) % SLOTS, t);
    unsafe {
        let s = (slot as usize) % SLOTS;
        for v in VOICES.iter_mut() {
            if v.slot == s && v.stage == Stage::Scheduled && v.t_start >= t {
                v.stage = Stage::Free;
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn stop_before(slot: u32, t: f64) {
    sample::stop_before((slot as usize) % SLOTS, t);
    unsafe {
        let s = (slot as usize) % SLOTS;
        for v in VOICES.iter_mut() {
            if v.slot != s {
                continue;
            }
            match v.stage {
                Stage::Scheduled if v.t_start < t => v.stage = Stage::Free,
                Stage::Playing if v.t_start < t => {
                    v.stage = Stage::Released;
                    v.rel_from = v.env;
                    v.r = v.r.min(0.05);
                    v.t_rel = 0.0; // sentinel: anchor at the next processed block
                }
                _ => {}
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn stop_all() {
    sample::stop_all();
    unsafe {
        for v in VOICES.iter_mut() {
            match v.stage {
                Stage::Scheduled => v.stage = Stage::Free,
                Stage::Playing | Stage::Released => {
                    v.rel_from = v.env;
                    v.r = 0.03;
                    v.stage = Stage::Released;
                    v.t_rel = 0.0;
                }
                Stage::Free => {}
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn active_voices() -> u32 {
    unsafe { VOICES.iter().filter(|v| v.stage != Stage::Free).count() as u32 }
}

#[inline(always)]
fn exp2f(x: f32) -> f32 {
    (x * core::f32::consts::LN_2).exp()
}

/// Band-limited square via additive odd partials (matches WebAudio's native
/// square construction).
#[inline(always)]
fn square_additive(ph: f32, kmax: u32) -> f32 {
    let mut s = 0.0f32;
    let mut k = 1u32;
    while k <= kmax {
        s += ((k as f32) * ph * TAU).sin() / (k as f32);
        k += 2;
    }
    s * (4.0 / core::f32::consts::PI)
}

/// Correct polyBLEP band-limited square (bass oscillator).
#[inline(always)]
fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

#[inline(always)]
fn saw_blep(ph: f32, dt: f32) -> f32 {
    (2.0 * ph - 1.0) - poly_blep(ph, dt)
}

#[inline(always)]
fn square_blep2(ph: f32, dt: f32) -> f32 {
    let base = if ph < 0.5 { 1.0 } else { -1.0 };
    let ph2 = if ph < 0.5 { ph + 0.5 } else { ph - 0.5 };
    base + poly_blep(ph, dt) - poly_blep(ph2, dt)
}

/// ADSR held-value at tn (linear attack, exponential decay to sustain).
#[inline(always)]
fn adsr_held(tn: f32, a: f32, d: f32, s: f32) -> f32 {
    if tn < a {
        tn / a
    } else if tn < a + d {
        s + (1.0 - s) * (-4.6 * ((tn - a) / d)).exp()
    } else {
        s
    }
}

/// Bass filter-envelope value (0..1).
#[inline(always)]
fn bass_fenv(tn: f32, released: bool, tr: f32) -> f32 {
    let held = adsr_held(tn, BASS_FA, BASS_FD, BASS_FS);
    if released {
        held * (-6.9 * (tr / BASS_FR).min(1.0)).exp()
    } else {
        held
    }
}

/// RBJ biquad coefficients (0 lp / 1 hp / 2 bp), normalized by a0.
#[inline(always)]
fn biquad_coeffs(ftype: u32, fc: f32, q: f32, sr: f32) -> ([f32; 3], [f32; 2]) {
    let fc = fc.clamp(10.0, sr * 0.45);
    let w0 = TAU * fc / sr;
    let (sw, cw) = (w0.sin(), w0.cos());
    let alpha = sw / (2.0 * q.max(0.05));
    let a0 = 1.0 + alpha;
    let b = match ftype {
        1 => [(1.0 + cw) * 0.5 / a0, -(1.0 + cw) / a0, (1.0 + cw) * 0.5 / a0],
        2 => [alpha / a0, 0.0, -alpha / a0],
        _ => [(1.0 - cw) * 0.5 / a0, (1.0 - cw) / a0, (1.0 - cw) * 0.5 / a0],
    };
    (b, [(-2.0 * cw) / a0, (1.0 - alpha) / a0])
}

/// One basic-wave sample: 0 square, 1 triangle, 2 sawtooth, 3 pulse(0.4), 4 sine.
#[inline(always)]
fn wave_sample(wave: u32, ph: f32, dt: f32) -> f32 {
    match wave {
        0 => square_blep2(ph, dt),
        1 => 1.0 - 4.0 * (ph - 0.5).abs(),
        2 => saw_blep(ph, dt),
        3 => {
            // pulse width 0.4 via two-blep rectangle
            let w = 0.4;
            let base = if ph < w { 1.0 } else { -1.0 };
            let ph2 = if ph < w { ph + (1.0 - w) } else { ph - w };
            base + poly_blep(ph, dt) - poly_blep(ph2, dt)
        }
        _ => (ph * TAU).sin(),
    }
}

/// Stateless per-voice random in [-1,1] for smooth/sharp LFOs.
#[inline(always)]
pub(crate) fn hash_rand(seed: u32, k: u32) -> f32 {
    let mut x = seed ^ k.wrapping_mul(2654435761);
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    (x as f32 / u32::MAX as f32) * 2.0 - 1.0
}

/// Design LFO value at tn: shapes 0 sine/1 tri/2 saw/3 square/4 smooth/5 sharp.
#[inline(always)]
fn lfo_val(shape: i32, rate: f32, tn: f32, seed: u32) -> f32 {
    if shape < 0 {
        return 0.0;
    }
    let x = tn * rate;
    let ph = x - x.floor();
    match shape {
        0 => (ph * TAU).sin(),
        1 => 1.0 - 4.0 * (ph - 0.5).abs(),
        2 => ph * 2.0 - 1.0,
        3 => if ph < 0.5 { 1.0 } else { -1.0 },
        4 => {
            let k = x.floor() as u32;
            let a = hash_rand(seed, k);
            let b = hash_rand(seed, k.wrapping_add(1));
            a + (b - a) * ph
        }
        _ => hash_rand(seed, x.floor() as u32),
    }
}

/// RBJ lowpass coefficients, normalized by a0.
#[inline(always)]
fn lp_coeffs(fc: f32, q: f32, sr: f32) -> ([f32; 3], [f32; 2]) {
    let fc = fc.clamp(10.0, sr * 0.45);
    let w0 = TAU * fc / sr;
    let (sw, cw) = (w0.sin(), w0.cos());
    let alpha = sw / (2.0 * q.max(0.05));
    let a0 = 1.0 + alpha;
    (
        [(1.0 - cw) * 0.5 / a0, (1.0 - cw) / a0, (1.0 - cw) * 0.5 / a0],
        [(-2.0 * cw) / a0, (1.0 - alpha) / a0],
    )
}

#[no_mangle]
pub extern "C" fn process(t_block: f64, frames: u32) {
    let frames = (frames as usize).min(BLOCK);
    unsafe {
        // RENDER-GAP GUARD: when every worklet output is disconnected (layer
        // chains torn down between plays) the graph stops pulling this node
        // and process() isn't called — voices mid-release FREEZE. On resume,
        // their fade tails would replay as a ghost blip of the PREVIOUS play
        // (measured on the user's project: last-play riff/motif tails at the
        // next press). After any gap, those fades are long past due — free
        // them silently instead of resuming them.
        if LAST_T >= 0.0 && t_block - LAST_T > 0.25 {
            for v in VOICES.iter_mut() {
                if v.stage == Stage::Released {
                    v.stage = Stage::Free;
                }
            }
            sample::free_released();
        }
        LAST_T = t_block;
        for slot in OUT.iter_mut() {
            for ch in slot.iter_mut() {
                for f in ch.iter_mut().take(frames) {
                    *f = 0.0;
                }
            }
        }
        let dt = DT;
        for v in VOICES.iter_mut() {
            if v.stage == Stage::Free {
                continue;
            }
            let block_end = t_block + frames as f64 * dt as f64;
            if v.stage == Stage::Scheduled {
                if v.t_start >= block_end {
                    continue;
                }
                v.stage = Stage::Playing;
            }
            if v.stage == Stage::Released && v.t_rel <= 0.0 {
                v.t_rel = t_block;
            }
            let out = &mut OUT[v.slot];
            let mut t = t_block;
            for f in 0..frames {
                let inc_c = v.freq * dt * v.bend;
                let inc_m = v.freq * v.harm * dt * v.bend;
                if t < v.t_start {
                    t += dt as f64;
                    continue;
                }
                let tn = (t - v.t_start) as f32;
                // ---- amp envelope (linear attack, exp decay/release) ------
                let env = if v.stage == Stage::Released || t >= v.t_rel {
                    if v.stage != Stage::Released {
                        v.stage = Stage::Released;
                        v.rel_from = v.env;
                        v.t_rel = t;
                    }
                    let tr = (t - v.t_rel) as f32;
                    if tr >= v.r {
                        v.stage = Stage::Free;
                        break;
                    }
                    let x = tr / v.r;
                    let e = v.rel_from * (-6.9 * x).exp();
                    if x > 0.95 { e * (1.0 - x) * 20.0 } else { e }
                } else if tn < v.a {
                    tn / v.a
                } else if tn < v.a + v.d {
                    let x = (tn - v.a) / v.d;
                    if v.s < 0.01 {
                        // percussive decay: Tone's exponential decay toward
                        // ~zero has a rate that scales SUB-linearly with the
                        // decay time — fitted from recorded bell (2 s: -9.7/x)
                        // and xylo (0.5 s: -5.6/x): rate ≈ 7.35·d^0.4 per x.
                        let rate = 7.35 * v.d.powf(0.4);
                        (-(rate) * x).exp()
                    } else {
                        v.s + (1.0 - v.s) * (-4.6 * x).exp()
                    }
                } else {
                    v.s
                };
                v.env = env;
                let amp = env * v.vel;
                // ---- control-rate update (every 16 frames): bend slew + mods
                if v.m_n == 0 {
                    if (v.bend - v.bend_t).abs() > 1.0e-6 {
                        v.bend += 0.35 * (v.bend_t - v.bend);
                    }
                }
                if v.d_flags & (1 | 2 | 32 | 64) != 0 {
                    if v.m_n == 0 {
                        let mut m = [0f32; 5]; // pitch cents, cut Hz, res Q, amp, pan
                        // dedicated pitch envelope: adds CENTS to the pitch (deep,
                        // independent of the mod-matrix ±1200 clamp). AD to 0.
                        if v.d_pe_amt != 0.0 {
                            m[0] += v.d_pe_amt * adsr_held(tn, v.d_pe_atk, v.d_pe_dec, 0.0);
                        }
                        for k in 0..v.d_nroutes as usize {
                            let ro = v.d_routes[k];
                            let srcv = match ro[0] as u32 {
                                0 => lfo_val(v.d_lshape[0], v.d_lrate[0], tn, v.aux0),
                                1 => lfo_val(v.d_lshape[1], v.d_lrate[1], tn, v.aux0 ^ 0x9e3779b9),
                                2 => {
                                    if v.d_e2[0] < 0.0 { 0.0 } else {
                                        let held = adsr_held(tn, v.d_e2[0], v.d_e2[1], v.d_e2[2]);
                                        if v.stage == Stage::Released {
                                            let tr = (t - v.t_rel) as f32;
                                            held * (-6.9 * (tr / v.d_e2[3]).min(1.0)).exp()
                                        } else { held }
                                    }
                                }
                                3 => v.vel,
                                x => v.d_macro[((x.saturating_sub(4)) as usize).min(3)],
                            };
                            let dj = (ro[1] as usize).min(4);
                            m[dj] += ro[2] * DEST_RANGE[dj] * srcv;
                        }
                        v.m_pitch = exp2f(m[0] / 1200.0);
                        v.m_amp = (1.0 + m[3]).max(0.0);
                        v.m_pan = m[4].clamp(-1.0, 1.0);
                        if v.d_flags & 1 != 0 {
                            // cutoff: filter-env base·2^(oct·env) + mod Hz —
                            // same anchor points as the node's _sdFilterEnvShape
                            let base = if v.d_flags & 2 != 0 {
                                let held = adsr_held(tn, v.d_fa, v.d_fd, v.d_fs);
                                let e = if v.stage == Stage::Released {
                                    let tr = (t - v.t_rel) as f32;
                                    held * (-6.9 * (tr / v.d_fr).min(1.0)).exp()
                                } else { held };
                                v.d_fcut * exp2f(v.d_foct * e)
                            } else { v.d_fcut };
                            let fc = (base + m[1]).clamp(20.0, 20000.0);
                            let q = ((v.d_fq + m[2]) * DESIGN_Q_SCALE).clamp(0.3, 12.0);
                            let (b, a) = biquad_coeffs(v.d_ftype, fc, q, SR);
                            v.g_b = b;
                            v.g_a = a;
                        }
                        v.m_n = 16;
                    }
                }
                if v.m_n == 0 { v.m_n = 16; }
                v.m_n -= 1;
                // ---- modulation envelope (FM/AM kinds) --------------------
                let me = if v.kind == 0 || v.kind == 2 {
                    0.0
                } else {
                    let held = adsr_held(tn, v.me_a, v.me_d, v.me_s);
                    if v.stage == Stage::Released {
                        let tr = (t - v.t_rel) as f32;
                        held * (-6.9 * (tr / v.me_r).min(1.0)).exp()
                    } else {
                        held
                    }
                };
                // ---- oscillator -------------------------------------------
                let sample = match v.kind {
                    1 | 3 | 4 => {
                        // FM family: f_inst = f · (1 + idx·me·mod)
                        let m = if v.mod_sine {
                            (v.ph_m * TAU).sin()
                        } else {
                            square_additive(v.ph_m, v.kmax)
                        };
                        let inst_inc = inc_c * (1.0 + v.idx * me * m);
                        v.ph_c += inst_inc;
                        v.ph_m += inc_m;
                        if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                        if v.ph_c < 0.0 { v.ph_c += 1.0; }
                        if v.ph_m >= 1.0 { v.ph_m -= 1.0; }
                        (v.ph_c * TAU).sin()
                    }
                    5 | 6 => {
                        // AM family: carrier × AudioToGain(mod·me·depth)
                        let m = if v.mod_sine {
                            (v.ph_m * TAU).sin()
                        } else {
                            square_additive(v.ph_m, v.kmax)
                        };
                        v.ph_c += inc_c;
                        v.ph_m += inc_m;
                        if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                        if v.ph_m >= 1.0 { v.ph_m -= 1.0; }
                        let g = (v.idx * me * m + 1.0) * 0.5;
                        (v.ph_c * TAU).sin() * g.clamp(0.0, 1.0)
                    }
                    2 => {
                        // bass: polyBLEP square → 2×biquad LP (env-swept)
                        if v.fc_n == 0 {
                            let tr = if v.stage == Stage::Released { (t - v.t_rel) as f32 } else { 0.0 };
                            let fe = bass_fenv(tn, v.stage == Stage::Released, tr);
                            let fc = BASS_FBASE * exp2f(BASS_FOCT * fe);
                            let (b, a) = lp_coeffs(fc, BASS_Q, SR);
                            v.fc_b = b;
                            v.fc_a = a;
                            v.fc_n = 16;
                        }
                        v.fc_n -= 1;
                        v.ph_c += inc_c;
                        if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                        let x = square_blep2(v.ph_c, inc_c);
                        let y1 = v.fc_b[0] * x + v.fc_b[1] * v.fs[0] + v.fc_b[2] * v.fs[1]
                            - v.fc_a[0] * v.fs[2] - v.fc_a[1] * v.fs[3];
                        v.fs[1] = v.fs[0]; v.fs[0] = x;
                        v.fs[3] = v.fs[2]; v.fs[2] = y1;
                        let y2 = v.fc_b[0] * y1 + v.fc_b[1] * v.fs[4] + v.fc_b[2] * v.fs[5]
                            - v.fc_a[0] * v.fs[6] - v.fc_a[1] * v.fs[7];
                        v.fs[5] = v.fs[4]; v.fs[4] = y1;
                        v.fs[7] = v.fs[6]; v.fs[6] = y2;
                        y2
                    }
                    7 => {
                        // duo: sine@f + polyBLEP saw@1.5f through a STATIC,
                        // mostly-open LP (measured: Tone DuoSynth's default
                        // filter env barely moves — spectrum shows a gentle
                        // rolloff, not a 565 Hz knee), shared 5 Hz vibrato.
                        // Cutoff = 2500·CAL[7] (calibrated vs recorded rolloff).
                        if v.fc_n == 0 {
                            let fc = 2500.0 * CAL[7];
                            let (b, a) = lp_coeffs(fc, 1.0, SR);
                            v.fc_b = b;
                            v.fc_a = a;
                            v.fc_n = 4096;
                        }
                        v.fc_n -= 1;
                        let vib = 1.0 + 0.3 * 0.03 * (tn * 5.0 * TAU).sin(); // ±~0.9% (vibratoAmount .3)
                        v.ph_c += inc_c * vib;
                        v.ph_m += inc_c * 1.5 * vib;
                        if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                        if v.ph_m >= 1.0 { v.ph_m -= 1.0; }
                        let x0 = (v.ph_c * TAU).sin();
                        let x1 = saw_blep(v.ph_m, inc_c * 1.5);
                        // one LP section per sub-voice (rolloff -12)
                        let y0 = v.fc_b[0] * x0 + v.fc_b[1] * v.fs[0] + v.fc_b[2] * v.fs[1]
                            - v.fc_a[0] * v.fs[2] - v.fc_a[1] * v.fs[3];
                        v.fs[1] = v.fs[0]; v.fs[0] = x0;
                        v.fs[3] = v.fs[2]; v.fs[2] = y0;
                        let y1 = v.fc_b[0] * x1 + v.fc_b[1] * v.fs[4] + v.fc_b[2] * v.fs[5]
                            - v.fc_a[0] * v.fs[6] - v.fc_a[1] * v.fs[7];
                        v.fs[5] = v.fs[4]; v.fs[4] = x1;
                        v.fs[7] = v.fs[6]; v.fs[6] = y1;
                        (y0 + y1) * 0.5
                    }
                    8 => {
                        // noise: p0 = 0 white / 1 pink (Kellet) / 2 brown
                        let w = xorshift(&mut v.aux0);
                        if v.p0 < 0.5 {
                            w
                        } else if v.p0 < 1.5 {
                            v.fs[0] = 0.99765 * v.fs[0] + w * 0.0990460;
                            v.fs[1] = 0.96300 * v.fs[1] + w * 0.2965164;
                            v.fs[2] = 0.57000 * v.fs[2] + w * 1.0526913;
                            // 0.82: measured Tone pink/white level ratio
                            (v.fs[0] + v.fs[1] + v.fs[2] + w * 0.1848) * 0.2 * 0.82
                        } else {
                            v.fs[0] = (v.fs[0] + 0.02 * w) / 1.02;
                            v.fs[0] * 3.5 * 0.82
                        }
                    }
                    9 => {
                        // kick (MembraneSynth): sine, freq 10f→f exp over 50 ms
                        let sweep = if tn < 0.05 {
                            10.0 * (0.1f32).powf(tn / 0.05)
                        } else {
                            1.0
                        };
                        v.ph_c += inc_c * sweep;
                        if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                        (v.ph_c * TAU).sin()
                    }
                    10 => {
                        // metal: square-FM (h5.1, idx from table) → HP 4 kHz
                        if v.fc_n == 0 {
                            let fc = 4000.0f32.clamp(10.0, SR * 0.45);
                            let w0 = TAU * fc / SR;
                            let (sw, cw) = (w0.sin(), w0.cos());
                            let alpha = sw / (2.0 * 1.0);
                            let a0 = 1.0 + alpha;
                            v.fc_b = [(1.0 + cw) * 0.5 / a0, -(1.0 + cw) / a0, (1.0 + cw) * 0.5 / a0];
                            v.fc_a = [(-2.0 * cw) / a0, (1.0 - alpha) / a0];
                            v.fc_n = 4096; // static filter
                        }
                        v.fc_n -= 1;
                        let m = square_additive(v.ph_m, v.kmax);
                        let inst_inc = inc_c * (1.0 + v.idx * me * m);
                        v.ph_c += inst_inc;
                        v.ph_m += inc_m;
                        if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                        if v.ph_c < 0.0 { v.ph_c += 1.0; }
                        if v.ph_m >= 1.0 { v.ph_m -= 1.0; }
                        let x = square_blep2(v.ph_c, inst_inc.abs().max(1e-6));
                        let y = v.fc_b[0] * x + v.fc_b[1] * v.fs[0] + v.fc_b[2] * v.fs[1]
                            - v.fc_a[0] * v.fs[2] - v.fc_a[1] * v.fs[3];
                        v.fs[1] = v.fs[0]; v.fs[0] = x;
                        v.fs[3] = v.fs[2]; v.fs[2] = y;
                        y
                    }
                    11 => {
                        // pluck (Karplus-Strong)
                        let bi = (v.aux0 as usize) % PLUCK_BUFS;
                        let n = (v.aux1 as usize).clamp(2, PLUCK_LEN);
                        let pos = v.fs[1] as usize % n;
                        let nxt = (pos + 1) % n;
                        // damped average; resonance 0.7 is PER-CYCLE feedback
                        // in Tone's PluckSynth (measured: the string decays in
                        // ~10 cycles — a short pluck tick, not a long ring).
                        let alpha = (TAU * 4000.0 / SR).min(1.0);
                        v.fs[0] += alpha * (0.5 * (PLUCK[bi][pos] + PLUCK[bi][nxt]) - v.fs[0]);
                        // OUTPUT the FILTERED signal (lowpass-comb topology):
                        // emitting the raw buffer made the first noise pass a
                        // ~6x-hot click vs Tone (measured 0.40 vs 0.063 rms).
                        let out_s = v.fs[0];
                        // resonance is applied once per pass through the
                        // write head = once per string CYCLE (Tone comb).
                        // 0.73 (not the preset's 0.7): the damping average
                        // adds its own per-cycle loss — measured effective
                        // decay matched Tone's recorded 0.69/cycle at 0.73.
                        PLUCK[bi][pos] = v.fs[0] * 0.73;
                        v.fs[1] = nxt as f32;
                        out_s
                    }
                    12 => {
                        // wavetable (legacy default): sine 1.0 + saw 0.5 + tri 0.3
                        v.ph_c += inc_c;
                        if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                        let sine = (v.ph_c * TAU).sin();
                        let saw = saw_blep(v.ph_c, inc_c);
                        let tri = 1.0 - 4.0 * (v.ph_c - 0.5).abs(); // naive triangle
                        sine + saw * 0.5 + tri * 0.3
                    }
                    13 => {
                        // basic wave (p0: 0 sq/1 tri/2 saw/3 pulse/4 fat) with
                        // optional unison (design). fat = saw ×3 spread 30 by
                        // default; unison overrides count/spread.
                        let wave = if v.p0 >= 3.5 { 2 } else { v.p0 as u32 };
                        let (n_uni, spread) = if v.d_flags & 16 != 0 {
                            (v.d_uni as usize, v.d_spread)
                        } else if v.p0 >= 3.5 {
                            (3usize, 30.0f32)
                        } else {
                            (1usize, 0.0f32)
                        };
                        if n_uni <= 1 {
                            v.ph_c += inc_c * v.m_pitch;
                            if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                            wave_sample(wave, v.ph_c, inc_c)
                        } else {
                            let mut acc = 0.0f32;
                            let norm = 1.4 / n_uni as f32; // calibrated: 1/n was 3 dB quiet, 1/sqrt(n) 7 dB hot vs recorded Tone fat
                            for u in 0..n_uni {
                                // spread cents distributed evenly across ±spread/2
                                let frac = if n_uni > 1 { u as f32 / (n_uni - 1) as f32 - 0.5 } else { 0.0 };
                                let det = exp2f(frac * spread / 1200.0);
                                let inc = inc_c * det * v.m_pitch;
                                v.uni_ph[u] += inc;
                                if v.uni_ph[u] >= 1.0 { v.uni_ph[u] -= 1.0; }
                                acc += wave_sample(wave, v.uni_ph[u], inc);
                            }
                            acc * norm
                        }
                    }
                    14 => {
                        // HARD SYNC: a saw SLAVE (ph_c) resets every MASTER
                        // (ph_m, at the note freq) cycle. ratio = harm; with
                        // idx>0 the ratio sweeps 1→harm scaled by idx·me
                        // (min 1) — the classic sync sweep on the same mod
                        // envelope the FM family uses. Both discontinuity
                        // families get polyBLEP smoothing: a jump J anchored
                        // at a wrap is cancelled by −(J/2)·poly_blep, which
                        // steps +J across the wrap and decays to 0 — the
                        // corrected signal is continuous (checked both sides).
                        let sweep = if v.idx > 0.0 { (v.idx * me).min(1.0) } else { 1.0 };
                        let ratio = (1.0 + (v.harm - 1.0) * sweep).max(1.0);
                        let inc = inc_c * v.m_pitch;
                        let inc_s = inc * ratio;
                        v.ph_m += inc;
                        if v.ph_m >= 1.0 {
                            v.ph_m -= 1.0;
                            // sync reset: fraction a past the wrap; slave
                            // phase AT the wrap = continuation minus the
                            // post-wrap advance
                            let a = (v.ph_m / inc.max(1.0e-9)).min(1.0);
                            let ph_w = v.ph_c + (1.0 - a) * inc_s;
                            let v_cont = 2.0 * (ph_w - ph_w.floor()) - 1.0;
                            v.ph_c = (a * inc_s).min(0.999);
                            let raw = 2.0 * v.ph_c - 1.0;
                            let j = v_cont - raw;
                            raw - 0.5 * j * poly_blep(v.ph_m, inc)
                        } else {
                            v.ph_c += inc_s;
                            if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                            let mut o = saw_blep(v.ph_c, inc_s);
                            // pre-correct the sync reset landing next sample
                            if v.ph_m > 1.0 - inc {
                                let ph_w = v.ph_c + (1.0 - v.ph_m) * ratio;
                                let v_cont = 2.0 * (ph_w - ph_w.floor()) - 1.0;
                                let j = v_cont - (-1.0);
                                o -= 0.5 * j * poly_blep(v.ph_m, inc);
                            }
                            o
                        }
                    }
                    _ => {
                        // sine (with optional unison)
                        if v.d_flags & 16 != 0 && v.d_uni > 1 {
                            let n_uni = v.d_uni as usize;
                            let mut acc = 0.0f32;
                            let norm = 1.4 / n_uni as f32; // calibrated: 1/n was 3 dB quiet, 1/sqrt(n) 7 dB hot vs recorded Tone fat
                            for u in 0..n_uni {
                                let frac = u as f32 / (n_uni - 1) as f32 - 0.5;
                                let det = exp2f(frac * v.d_spread / 1200.0);
                                let inc = inc_c * det * v.m_pitch;
                                v.uni_ph[u] += inc;
                                if v.uni_ph[u] >= 1.0 { v.uni_ph[u] -= 1.0; }
                                acc += (v.uni_ph[u] * TAU).sin();
                            }
                            acc * norm
                        } else {
                            v.ph_c += inc_c * v.m_pitch;
                            if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                            (v.ph_c * TAU).sin()
                        }
                    }
                };
                // ---- design chain: sub → ring → amp-mod → filter ----------
                // (matches the node engine's insertion order; pan-mod applies
                // at the output stage below via m_pan.)
                let sample = if v.d_flags != 0 || v.d_nroutes > 0 {
                    let mut sd = sample;
                    if v.d_flags & 4 != 0 && v.d_sub > 0.0 {
                        v.sub_ph += inc_c * 0.5;
                        if v.sub_ph >= 1.0 { v.sub_ph -= 1.0; }
                        let sub = if v.d_subsq { square_blep2(v.sub_ph, inc_c * 0.5) } else { (v.sub_ph * TAU).sin() };
                        sd += sub * v.d_sub * v.vel;
                    }
                    if v.d_flags & 8 != 0 && v.d_ring > 0.0 {
                        v.ring_ph += inc_c * v.d_ringratio;
                        if v.ring_ph >= 1.0 { v.ring_ph -= 1.0; }
                        sd *= 1.0 + v.d_ring * (v.ring_ph * TAU).sin();
                    }
                    sd *= v.m_amp;
                    if v.d_flags & 1 != 0 {
                        let y1 = v.g_b[0] * sd + v.g_b[1] * v.g_s[0] + v.g_b[2] * v.g_s[1]
                            - v.g_a[0] * v.g_s[2] - v.g_a[1] * v.g_s[3];
                        v.g_s[1] = v.g_s[0]; v.g_s[0] = sd;
                        v.g_s[3] = v.g_s[2]; v.g_s[2] = y1;
                        let y2 = v.g_b[0] * y1 + v.g_b[1] * v.g_s[4] + v.g_b[2] * v.g_s[5]
                            - v.g_a[0] * v.g_s[6] - v.g_a[1] * v.g_s[7];
                        v.g_s[5] = v.g_s[4]; v.g_s[4] = y1;
                        v.g_s[7] = v.g_s[6]; v.g_s[6] = y2;
                        y2
                    } else {
                        sd
                    }
                } else {
                    sample
                };
                // pan-mod: recompute output gains at control rate via m_pan
                let (gl, gr) = if v.m_pan != 0.0 {
                    let pn = v.m_pan.clamp(-1.0, 1.0);
                    let ang = (pn + 1.0) * 0.25 * core::f32::consts::PI;
                    (ang.cos() * core::f32::consts::SQRT_2 * v.gain_l.max(v.gain_r),
                     ang.sin() * core::f32::consts::SQRT_2 * v.gain_l.max(v.gain_r))
                } else {
                    (v.gain_l, v.gain_r)
                };
                out[0][f] += sample * amp * gl;
                out[1][f] += sample * amp * gr;
                t += dt as f64;
            }
        }
    }
    // Phase 3: sample voices render into the same slot buses.
    sample::process(t_block, frames as usize);
    // Phase 2: per-slot layer strips + FX (no-op for disabled strips, so
    // Phase-1 output — and the existing golden baseline — is untouched).
    strip::process_strips(t_block, frames);
}
