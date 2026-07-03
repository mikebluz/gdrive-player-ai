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
//! modulation envelope A0.5 S1 R0.5). Frequency modulation follows Tone's
//! semantics: f_inst = f · (1 + index · mod(t) · modEnv(t)).
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
}

const VOICE0: Voice = Voice {
    stage: Stage::Free, slot: 0, kind: 0, freq: 440.0, vel: 1.0,
    gain_l: 0.707, gain_r: 0.707, t_start: 0.0, t_rel: 0.0,
    a: 0.01, d: 0.1, s: 0.5, r: 0.1, env: 0.0, rel_from: 0.0,
    ph_c: 0.0, ph_m: 0.0,
};

static mut VOICES: [Voice; MAX_VOICES] = [VOICE0; MAX_VOICES];
static mut OUT: [[[f32; BLOCK]; 2]; SLOTS] = [[[0.0; BLOCK]; 2]; SLOTS];
static mut SR: f32 = 44100.0;
static mut DT: f32 = 1.0 / 44100.0;

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
        };
    }
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
                    v.t_rel = -1.0;      // release "began in the past" marker unused; env math below uses rel_from
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

/// PolyBLEP-smoothed square for the FM modulator (band-limited enough that
/// the modulator doesn't alias harshly; Tone uses a band-limited square).
#[inline(always)]
fn square_blep(ph: f32, inc: f32) -> f32 {
    let mut s = if ph < 0.5 { 1.0 } else { -1.0 };
    // discontinuities at 0 and 0.5
    let t = ph;
    if t < inc {
        let x = t / inc;
        s -= x + x - x * x - 1.0;
    } else if t > 1.0 - inc {
        let x = (t - 1.0) / inc;
        s -= x * x + x + x + 1.0;
    }
    let t2 = if ph < 0.5 { ph + 0.5 } else { ph - 0.5 };
    if t2 < inc {
        let x = t2 / inc;
        s += x + x - x * x - 1.0;
    } else if t2 > 1.0 - inc {
        let x = (t2 - 1.0) / inc;
        s += x * x + x + x + 1.0;
    }
    s
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
                    // exponential-ish release
                    v.rel_from * (1.0 - tr / v.r) * (1.0 - tr / v.r)
                } else if tn < v.a {
                    tn / v.a
                } else if tn < v.a + v.d {
                    let x = (tn - v.a) / v.d;
                    1.0 - (1.0 - v.s) * (x * (2.0 - x)) // smooth decay to sustain
                } else {
                    v.s
                };
                v.env = env;
                let amp = env * v.vel;
                // ---- oscillator ----------------------------------------
                let sample = if v.kind == 1 {
                    // FM: modulation envelope A0.5 S1 R0.5 (like Tone's fm preset)
                    let me = if tn < FM_MOD_ATK { tn / FM_MOD_ATK } else { 1.0 };
                    let _ = FM_MOD_REL; // release tracks amp release; fine for phase 1
                    let m = square_blep(v.ph_m, inc_m);
                    // Tone semantics: f_inst = f · (1 + index·modEnv·m)
                    let inst_inc = inc_c * (1.0 + FM_INDEX * me * m);
                    v.ph_c += inst_inc;
                    v.ph_m += inc_m;
                    if v.ph_c >= 1.0 { v.ph_c -= 1.0; }
                    if v.ph_c < 0.0 { v.ph_c += 1.0; }
                    if v.ph_m >= 1.0 { v.ph_m -= 1.0; }
                    (v.ph_c * TAU).sin()
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
