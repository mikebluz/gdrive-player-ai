//! bloops-dsp — Phase 0 spike: N concurrent FM voices computed in one sample
//! loop. Mirrors Tone.FMSynth's basic shape (carrier + modulator, harmonicity
//! 3, modulation index 10, ADSR amp envelope) with notes retriggering every
//! 0.6 s so the bench exercises envelope transitions, not just steady tones.
//!
//! Flat C ABI, no allocations in the audio path, single-threaded (WASM).

#![allow(static_mut_refs)]

const MAX_VOICES: usize = 1024;
const BLOCK: usize = 128;

const HARMONICITY: f32 = 3.0;
const MOD_INDEX: f32 = 10.0;
// Note cycle (seconds): attack, decay, sustain-until, release; retrigger at CYCLE.
const ATK: f32 = 0.01;
const DEC: f32 = 0.10;
const SUS_LEVEL: f32 = 0.5;
const REL_AT: f32 = 0.45;
const REL: f32 = 0.15;
const CYCLE: f32 = 0.6;
const TAU: f32 = core::f32::consts::TAU;

#[derive(Clone, Copy)]
struct Voice {
    ph_c: f32, // carrier phase 0..1
    ph_m: f32, // modulator phase 0..1
    freq: f32,
    t: f32, // seconds since (re)trigger
}

static mut VOICES: [Voice; MAX_VOICES] = [Voice { ph_c: 0.0, ph_m: 0.0, freq: 110.0, t: 0.0 }; MAX_VOICES];
static mut BUF: [f32; BLOCK] = [0.0; BLOCK];
static mut SR: f32 = 44100.0;
static mut N: usize = 0;

#[inline(always)]
fn env_at(t: f32) -> f32 {
    if t < ATK {
        t / ATK
    } else if t < ATK + DEC {
        1.0 - (1.0 - SUS_LEVEL) * ((t - ATK) / DEC)
    } else if t < REL_AT {
        SUS_LEVEL
    } else if t < REL_AT + REL {
        SUS_LEVEL * (1.0 - (t - REL_AT) / REL)
    } else {
        0.0
    }
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    unsafe { SR = sample_rate }
}

#[no_mangle]
pub extern "C" fn set_voices(n: u32) {
    unsafe {
        N = (n as usize).min(MAX_VOICES);
        for (i, v) in VOICES.iter_mut().enumerate().take(N) {
            // spread pitches and phases so voices don't correlate
            v.freq = 65.0 * (1.0 + (i % 24) as f32 * 0.12);
            v.t = (i as f32 * 0.037) % CYCLE;
            v.ph_c = 0.0;
            v.ph_m = 0.0;
        }
    }
}

#[no_mangle]
pub extern "C" fn buf_ptr() -> *mut f32 {
    unsafe { BUF.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn process(frames: u32) {
    let frames = (frames as usize).min(BLOCK);
    unsafe {
        let dt = 1.0 / SR;
        for f in 0..frames {
            BUF[f] = 0.0;
        }
        for v in VOICES.iter_mut().take(N) {
            let inc_c = v.freq * dt;
            let inc_m = v.freq * HARMONICITY * dt;
            let mut t = v.t;
            let (mut pc, mut pm) = (v.ph_c, v.ph_m);
            for f in 0..frames {
                let env = env_at(t);
                // FM: carrier phase modulated by the modulator output.
                let m = (pm * TAU).sin();
                let s = ((pc + MOD_INDEX * m * inc_c) * TAU).sin();
                BUF[f] += s * env;
                pc += inc_c;
                if pc >= 1.0 {
                    pc -= 1.0;
                }
                pm += inc_m;
                if pm >= 1.0 {
                    pm -= 1.0;
                }
                t += dt;
                if t >= CYCLE {
                    t -= CYCLE;
                }
            }
            v.ph_c = pc;
            v.ph_m = pm;
            v.t = t;
        }
        // normalize so the bench stays quiet regardless of N
        let g = 0.5 / (N.max(1) as f32);
        for f in 0..frames {
            BUF[f] *= g;
        }
    }
}
