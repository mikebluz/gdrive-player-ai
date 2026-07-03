//! bloops-dsp — Phase 1: the Bloops voice engine core.
//!
//! One WASM instance inside one AudioWorklet renders every core-mode voice
//! into per-layer stereo buses ("slots"), which the host connects to the
//! existing per-layer WebAudio chains. Notes arrive as scheduled events
//! (Bloom dispatches ≥0.3 s ahead) and start sample-accurately inside the
//! render loop. Fixed voice pool — the allocator CANNOT leak; overflow
//! steals the most-decayed voice, mirroring the app's steal policy.
//!
//! Phase-1 voice types: 0 = sine (Tone.Synth/sine), 1 = fm (Tone.FMSynth:
//! sine carrier, square modulator, harmonicity 3, modulationIndex 10,
//! modulation envelope A0.5 S1 R0.5; f_inst = f·(1 + index·modEnv·mod)),
//! 2 = bass (Tone.MonoSynth preset: polyBLEP square → 2×biquad lowpass with
//! an envelope-swept cutoff → amp ADSR). FM depth and bass resonance are
//! CALIBRATED against recorded Tone spectra (see FM_CAL / BASS_Q).
//!
//! Flat C ABI, no allocation in the audio path, single-threaded.

#![allow(static_mut_refs)]

const MAX_VOICES: usize = 256;
const SLOTS: usize = 16;
const BLOCK: usize = 128;
const TAU: f32 = core::f32::consts::TAU;

const FM_HARMONICITY: f32 = 3.0;
const FM_INDEX: f32 = 10.0;
const FM_MOD_ATK: f32 = 0.5;
const FM_MOD_REL: f32 = 0.5;

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Free,
    Scheduled,
    Playing,  // attack/decay/sustain until t_rel
    Released, // release tail
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
    t_rel: f64, // release begins (t_start + dur)
    // envelope
    a: f32,
    d: f32,
    s: f32,
    r: f32,
    env: f32,       // current level (tracked for release-from-here)
    rel_from: f32,  // level at release start
    // oscillators
    ph_c: f32,
    ph_m: f32,
    kmax: u32, // modulator partial count (band-limit at Nyquist)
    // bass (kind 2): 2 cascaded biquad LP sections + control-rate coeffs
    fs: [f32; 8],       // x1,x2,y1,y2 × 2 sections
    fc_b: [f32; 3],     // b0,b1,b2 (shared by both sections)
    fc_a: [f32; 2],     // a1,a2
    fc_n: u32,          // frames until next coefficient update
}

const VOICE0: Voice = Voice {
    stage: Stage::Free, slot: 0, kind: 0, freq: 440.0, vel: 1.0,
    gain_l: 0.707, gain_r: 0.707, t_start: 0.0, t_rel: 0.0,
    a: 0.01, d: 0.1, s: 0.5, r: 0.1, env: 0.0, rel_from: 0.0,
    ph_c: 0.0, ph_m: 0.0, kmax: 1,
    fs: [0.0; 8], fc_b: [0.0; 3], fc_a: [0.0; 2], fc_n: 0,
};

static mut VOICES: [Voice; MAX_VOICES] = [VOICE0; MAX_VOICES];
static mut OUT: [[[f32; BLOCK]; 2]; SLOTS] = [[[0.0; BLOCK]; 2]; SLOTS];
static mut SR: f32 = 44100.0;
static mut DT: f32 = 1.0 / 44100.0;
// FM depth calibration: scales the effective modulation index. Calibrated
// empirically against a recorded Tone.FMSynth spectrum (same note, same
// params): at 0.25 every measured partial matches Tone within 1 dB relative
// to the fundamental (fm-ab sweep, 2026-07-03). The factor folds in Tone's
// PeriodicWave normalization and Multiply-node scaling — matching the sound
// projects were built on matters more than deriving it analytically.
static mut FM_CAL: f32 = 0.25;

#[no_mangle]
pub extern "C" fn set_fm_cal(k: f32) {
    unsafe { FM_CAL = k.clamp(0.05, 4.0) }
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    unsafe {
        SR = sample_rate;
        DT = 1.0 / sample_rate;
        for v in VOICES.iter_mut() {
            *v = VOICE0;
        }
    }
}

#[no_mangle]
pub extern "C" fn out_ptr(slot: u32, ch: u32) -> *mut f32 {
    unsafe { OUT[(slot as usize) % SLOTS][(ch as usize) & 1].as_mut_ptr() }
}

fn alloc_voice() -> usize {
    unsafe {
        // free first
        for (i, v) in VOICES.iter().enumerate() {
            if v.stage == Stage::Free {
                return i;
            }
        }
        // steal: most-decayed released voice; else the earliest-started
        let mut best = 0usize;
        let mut best_score = f32::MAX;
        for (i, v) in VOICES.iter().enumerate() {
            let score = match v.stage {
                Stage::Released => v.env, // closest to silent wins
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

#[no_mangle]
pub extern "C" fn note(
    slot: u32, kind: u32, freq: f32, vel: f32, pan: f32, t_start: f64, dur: f32,
    a: f32, d: f32, s: f32, r: f32, detune: f32,
) {
    unsafe {
        let i = alloc_voice();
        let v = &mut VOICES[i];
        let f = freq * exp2f(detune / 1200.0);
        // equal-power pan, pan in [-1, 1]
        let ang = (pan.clamp(-1.0, 1.0) + 1.0) * 0.25 * TAU / 2.0;
        *v = Voice {
            stage: Stage::Scheduled,
            slot: (slot as usize) % SLOTS,
            kind,
            freq: f,
            vel: vel.clamp(0.0, 1.0),
            gain_l: ang.cos(),
            gain_r: ang.sin(),
            t_start,
            t_rel: t_start + dur.max(0.02) as f64,
            a: a.max(0.005),
            d: d.max(0.01),
            s: s.clamp(0.001, 1.0),
            r: r.max(0.02),
            env: 0.0,
            rel_from: 0.0,
            ph_c: 0.0,
            ph_m: 0.0,
            // band-limit the square modulator at Nyquist (odd partials only);
            // cap the sum for CPU sanity — 21 partials ≈ what matters audibly.
            kmax: {
                let fm = f * FM_HARMONICITY;
                let nyq = SR * 0.5;
                if fm <= 0.0 { 1 } else { ((nyq / fm) as u32).clamp(1, 21) | 1 }
            },
            fs: [0.0; 8],
            fc_b: [0.0; 3],
            fc_a: [0.0; 2],
            fc_n: 0,
        };
    }
}

// ---- bass (MonoSynth preset) constants -----------------------------------
// Tone.MonoSynth 'bass': square osc → lowpass (Q 4, rolloff -24 = 2 cascaded
// sections) → amp ADSR, with the cutoff driven by a FrequencyEnvelope:
// base 80 Hz, +3.2 octaves, A 5 ms / D 180 ms / S 0.4 / R 400 ms.
const BASS_FBASE: f32 = 80.0;
const BASS_FOCT: f32 = 3.2;
const BASS_FA: f32 = 0.005;
const BASS_FD: f32 = 0.18;
const BASS_FS: f32 = 0.4;
const BASS_FR: f32 = 0.4;
// Per-section resonance — calibrated against the recorded Tone spectrum:
// at 1.6 every partial matches within 1 dB (194 Hz resonant peak exact;
// bass-ab sweep 2026-07-03). Full preset-Q (4) per section measured +11 dB
// too resonant — Tone's -24 rolloff does NOT apply full Q to both sections.
static mut BASS_Q: f32 = 1.6;

#[no_mangle]
pub extern "C" fn set_bass_q(q: f32) {
    unsafe { BASS_Q = q.clamp(0.1, 12.0) }
}

/// Correct polyBLEP (verified spectrally this time): band-limited square.
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
fn square_blep2(ph: f32, dt: f32) -> f32 {
    let base = if ph < 0.5 { 1.0 } else { -1.0 };
    let ph2 = if ph < 0.5 { ph + 0.5 } else { ph - 0.5 };
    base + poly_blep(ph, dt) - poly_blep(ph2, dt)
}

/// Filter-envelope value (0..1) for the bass preset at time tn since note
/// start; releasing from t_rel like the amp envelope.
#[inline(always)]
fn bass_fenv(tn: f32, released: bool, tr: f32) -> f32 {
    let held = if tn < BASS_FA {
        tn / BASS_FA
    } else if tn < BASS_FA + BASS_FD {
        BASS_FS + (1.0 - BASS_FS) * (-4.6 * ((tn - BASS_FA) / BASS_FD)).exp()
    } else {
        BASS_FS
    };
    if released {
        held * (-6.9 * (tr / BASS_FR).min(1.0)).exp()
    } else {
        held
    }
}

/// RBJ lowpass coefficients into (b0,b1,b2,a1,a2), normalized by a0.
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

/// Drop queued/not-yet-started voices for a slot with t_start >= t.
#[no_mangle]
pub extern "C" fn cancel_from(slot: u32, t: f64) {
    unsafe {
        let s = (slot as usize) % SLOTS;
        for v in VOICES.iter_mut() {
            if v.slot == s && v.stage == Stage::Scheduled && v.t_start >= t {
                v.stage = Stage::Free;
            }
        }
    }
}

/// Force-release sounding voices for a slot that started before t
/// (area transitions / departures). Queued ones before t are dropped.
#[no_mangle]
pub extern "C" fn stop_before(slot: u32, t: f64) {
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
                    v.r = v.r.min(0.05); // fast, click-free
                    v.t_rel = 0.0;       // sentinel: release anchors at the next processed block
                }
                _ => {}
            }
        }
    }
}

/// Hard stop everything (user Stop) — quick ramp handled by short release.
#[no_mangle]
pub extern "C" fn stop_all() {
    unsafe {
        for v in VOICES.iter_mut() {
            match v.stage {
                Stage::Scheduled => v.stage = Stage::Free,
                Stage::Playing | Stage::Released => {
                    v.rel_from = v.env;
                    v.r = 0.03;
                    v.stage = Stage::Released;
                    v.t_rel = 0.0; // sentinel: anchor at the next processed block
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
    // 2^x via exp — std is available on wasm32-unknown-unknown
    (x * core::f32::consts::LN_2).exp()
}

/// Band-limited square via additive odd partials — matches how WebAudio's
/// native 'square' OscillatorNode (Tone's modulator) is built (Fourier
/// series, band-limited at Nyquist). kmax is chosen per voice from the
/// modulator frequency. (An earlier polyBLEP attempt had edge artifacts that
/// FM index 10 amplified into frequency chirps — audibly "harsh noise".)
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

#[no_mangle]
pub extern "C" fn process(t_block: f64, frames: u32) {
    let frames = (frames as usize).min(BLOCK);
    unsafe {
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
                    continue; // not yet
                }
                v.stage = Stage::Playing;
            }
            // A force-released voice (stop_before / stop_all) anchors its
            // release at the first block processed after the stop.
            if v.stage == Stage::Released && v.t_rel <= 0.0 {
                v.t_rel = t_block;
            }
            let out = &mut OUT[v.slot];
            let inc_c = v.freq * dt;
            let inc_m = v.freq * FM_HARMONICITY * dt;
            let mut t = t_block;
            for f in 0..frames {
                if t < v.t_start {
                    t += dt as f64;
                    continue;
                }
                // ---- amplitude envelope --------------------------------
                let tn = (t - v.t_start) as f32; // time since note start
                // Curves match Tone's envelope defaults: linear attack,
                // EXPONENTIAL decay toward sustain, EXPONENTIAL release
                // (with a short linear tail to land exactly at 0).
                let env = if v.stage == Stage::Released || t >= v.t_rel {
                    if v.stage != Stage::Released {
                        v.stage = Stage::Released;
                        v.rel_from = v.env;
                        v.t_rel = t; // release actually begins now
                    }
                    let tr = (t - v.t_rel) as f32;
                    if tr >= v.r {
                        v.stage = Stage::Free;
                        break;
                    }
                    let x = tr / v.r;
                    let e = v.rel_from * (-6.9 * x).exp(); // ~0.1% at end
                    if x > 0.95 { e * (1.0 - x) * 20.0 } else { e }
                } else if tn < v.a {
                    tn / v.a
                } else if tn < v.a + v.d {
                    let x = (tn - v.a) / v.d;
                    v.s + (1.0 - v.s) * (-4.6 * x).exp() // ~1% of gap at end
                } else {
                    v.s
                };
                v.env = env;
                let amp = env * v.vel;
                // ---- oscillator ----------------------------------------
                let sample = if v.kind == 1 {
                    // FM: modulation envelope A0.5 S1 R0.5 (Tone's fm preset) —
                    // the index fades in over 0.5 s AND mellows out over the
                    // release tail, which is a big part of the preset's sound.
                    let mut me = if tn < FM_MOD_ATK { tn / FM_MOD_ATK } else { 1.0 };
                    if v.stage == Stage::Released {
                        let tr = (t - v.t_rel) as f32;
                        me *= (1.0 - tr / FM_MOD_REL).max(0.0);
                    }
                    let m = square_additive(v.ph_m, v.kmax);
                    // Tone semantics: f_inst = f·(1 + index·modEnv·mod). Tone
                    // triggers the MODULATOR's envelope with the note velocity
                    // too, so depth scales with vel; FM_CAL matches the overall
                    // depth to the measured Tone spectrum.
                    let inst_inc = inc_c * (1.0 + FM_INDEX * FM_CAL * v.vel * me * m);
                    v.ph_c += inst_inc;
                    v.ph_m += inc_m;
                    if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                    if v.ph_c < 0.0 { v.ph_c += 1.0; }
                    if v.ph_m >= 1.0 { v.ph_m -= 1.0; }
                    (v.ph_c * TAU).sin()
                } else if v.kind == 2 {
                    // bass: polyBLEP square → 2×biquad LP (env-swept) — the
                    // MonoSynth preset. Coefficients update every 16 frames
                    // (0.36 ms — fine even for the 5 ms filter attack).
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
                    // section 1
                    let y1 = v.fc_b[0] * x + v.fc_b[1] * v.fs[0] + v.fc_b[2] * v.fs[1]
                        - v.fc_a[0] * v.fs[2] - v.fc_a[1] * v.fs[3];
                    v.fs[1] = v.fs[0]; v.fs[0] = x;
                    v.fs[3] = v.fs[2]; v.fs[2] = y1;
                    // section 2
                    let y2 = v.fc_b[0] * y1 + v.fc_b[1] * v.fs[4] + v.fc_b[2] * v.fs[5]
                        - v.fc_a[0] * v.fs[6] - v.fc_a[1] * v.fs[7];
                    v.fs[5] = v.fs[4]; v.fs[4] = y1;
                    v.fs[7] = v.fs[6]; v.fs[6] = y2;
                    y2
                } else {
                    // sine
                    v.ph_c += inc_c;
                    if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                    (v.ph_c * TAU).sin()
                };
                out[0][f] += sample * amp * v.gain_l;
                out[1][f] += sample * amp * v.gain_r;
                t += dt as f64;
            }
        }
    }
}
