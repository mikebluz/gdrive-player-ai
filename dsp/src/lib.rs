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
//!
//! Every kind's depth/resonance is CALIBRATED against recorded Tone output
//! (see CAL / BASS_Q and the voice-ab harness) — matching the sound projects
//! were built on beats deriving from Tone's internals (proven twice: FM depth
//! ×0.25, bass per-section Q 1.6 vs the "obvious" 4).
//!
//! Flat C ABI, no allocation in the audio path, single-threaded.

#![allow(static_mut_refs)]

const MAX_VOICES: usize = 256;
const SLOTS: usize = 16;
const BLOCK: usize = 128;
const TAU: f32 = core::f32::consts::TAU;

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
}

const VOICE0: Voice = Voice {
    stage: Stage::Free, slot: 0, kind: 0, freq: 440.0, vel: 1.0,
    gain_l: 0.707, gain_r: 0.707, t_start: 0.0, t_rel: 0.0,
    a: 0.01, d: 0.1, s: 0.5, r: 0.1, env: 0.0, rel_from: 0.0,
    harm: 1.0, idx: 0.0, mod_sine: true,
    me_a: 0.001, me_d: 0.001, me_s: 1.0, me_r: 0.1,
    ph_c: 0.0, ph_m: 0.0, kmax: 1,
    fs: [0.0; 8], fc_b: [0.0; 3], fc_a: [0.0; 2], fc_n: 0,
};

static mut VOICES: [Voice; MAX_VOICES] = [VOICE0; MAX_VOICES];
static mut OUT: [[[f32; BLOCK]; 2]; SLOTS] = [[[0.0; BLOCK]; 2]; SLOTS];
static mut SR: f32 = 44100.0;
static mut DT: f32 = 1.0 / 44100.0;

// Per-kind depth calibration, tuned against recorded Tone spectra with the
// voice-ab harness. Index = kind. fm's 0.25 was swept 2026-07-03 (every
// partial within 1 dB of Tone). Others start at fm's value (same Multiply
// topology) and get their own sweep before ear-testing.
// Swept values (voice-ab, 2026-07-03): fm 0.25, bell 0.25, xylo 0.3,
// am 0.3, pad 0.3 — each matches its recorded Tone spectrum within ~1-2 dB
// relative to the fundamental.
static mut CAL: [f32; 8] = [1.0, 0.25, 1.0, 0.25, 0.3, 0.3, 0.3, 1.0];
// Per-kind OUTPUT GAIN: Tone's ModulationSynth family (FM/AM) runs ~7.5 dB
// quieter per voice than a bare oscillator×envelope — measured from recorded
// single-note envelopes (bell peak 0.139 vs core 0.333 at equal velocity).
// sine (Tone.Synth) and bass (MonoSynth) measured ~unity.
static mut GAIN: [f32; 8] = [1.0, 0.45, 1.0, 0.42, 0.42, 0.42, 0.45, 1.0];

#[no_mangle]
pub extern "C" fn set_kind_cal(kind: u32, k: f32) {
    unsafe { CAL[(kind as usize).min(7)] = k.clamp(0.01, 4.0) }
}

#[no_mangle]
pub extern "C" fn set_kind_gain(kind: u32, g: f32) {
    unsafe { GAIN[(kind as usize).min(7)] = g.clamp(0.05, 4.0) }
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
    }
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

#[no_mangle]
pub extern "C" fn note(
    slot: u32, kind: u32, freq: f32, vel: f32, pan: f32, t_start: f64, dur: f32,
    a: f32, d: f32, s: f32, r: f32, detune: f32,
) {
    unsafe {
        let i = alloc_voice();
        let v = &mut VOICES[i];
        let f = freq * exp2f(detune / 1200.0);
        let ang = (pan.clamp(-1.0, 1.0) + 1.0) * 0.25 * TAU / 2.0;
        let vel = vel.clamp(0.0, 1.0);
        let cal = CAL[(kind as usize).min(7)];
        let out_gain = GAIN[(kind as usize).min(7)];
        // per-kind synth params (see the header table)
        let (harm, idx, mod_sine, me, amp_fixed): (f32, f32, bool, [f32; 4], Option<[f32; 4]>) =
            match kind {
                1 => (3.0, 10.0 * cal * vel, false, [0.5, 0.001, 1.0, 0.5], None),
                3 => (2.14, 4.0 * cal * vel, true, [0.001, 0.5, 0.2, 0.5], Some([0.001, 2.0, 0.0, 0.8])),
                4 => (7.0, 4.0 * cal * vel, true, [0.001, 0.2, 0.0, 0.2], Some([0.001, 0.5, 0.0, 0.3])),
                5 => (2.0, cal * vel, false, [0.5, 0.001, 1.0, 0.5], None),
                6 => (1.5, cal * vel, true, [1.0, 0.5, 0.5, 2.0], Some([1.2, 0.5, 0.7, 2.5])),
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
            gain_l: ang.cos() * out_gain,
            gain_r: ang.sin() * out_gain,
            t_start,
            t_rel: t_start + dur.max(0.02) as f64,
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
        };
    }
}

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
            let inc_c = v.freq * dt;
            let inc_m = v.freq * v.harm * dt;
            let mut t = t_block;
            for f in 0..frames {
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
                    _ => {
                        // sine
                        v.ph_c += inc_c;
                        if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                        (v.ph_c * TAU).sin()
                    }
                };
                out[0][f] += sample * amp * v.gain_l;
                out[1][f] += sample * amp * v.gain_r;
                t += dt as f64;
            }
        }
    }
}
