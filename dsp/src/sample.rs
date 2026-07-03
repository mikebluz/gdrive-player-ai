//! Phase 3: sample/pad playback in-core.
//!
//! PCM lives in wasm linear memory (bump allocator over memory.grow — the
//! rest of the engine stays statically allocated). The host loads each
//! decoded buffer once (`sample_load` + writes into `sample_ptr`), then
//! plays voices with `snote()` whose params arrive via the PARAMS staging
//! buffer (the note_ex pattern — the port serializes, so staging is atomic).
//!
//! A sample voice mirrors the node path (`_buildSampleAdsrVoice`):
//!   buffer read (linear interp, playbackRate) → [lowpass] → ADSR → gains
//! - rate = playbackRate · buffer_sr/engine_sr, bend_tag's slewed multiplier
//!   applies on top (pitch bends / glide), srate_tag ramps the base rate
//!   (sample portamento).
//! - slice windows are BUFFER-seconds (the bridge pre-multiplies by rate,
//!   exactly like the node path); window end frees the voice (source ended).
//! - loop: wraps inside [loop_a, loop_b) after the first pass (the seamless
//!   crossfaded loop buffers are host-prepared, same as node); pad voices
//!   are just loop + hold (dur < 0) + release_tag.
//! - reverse: reads backwards over the mirrored window (the node builds a
//!   reversed buffer copy; reading backwards is equivalent and free).
//! - envelope: the same linear-attack / exponential decay+release family as
//!   the synth voices (Tone envelope semantics, already ear-calibrated).
//! - gains: the bridge sends FINAL per-channel gains (norm · boost · vel ·
//!   pan law + makeup) so the node's exact leveling lives in one place.
//!
//! PARAMS layout for snote (f32 slots):
//!   0 sample id          1 rate (incl. sr ratio)   2 gain L    3 gain R
//!   4 attack s   5 decay s   6 sustain 0..1   7 release s
//!   8 window offset (buffer s)   9 window length (buffer s, <0 = to end)
//!   10 flags: 1 loop | 2 reverse
//!   11 loop start (buffer s)     12 loop end (buffer s, <=0 = whole buffer)
//!   13 filter cutoff Hz (<0 = none)   14 filter Q (dB, native lowpass)

use crate::{DT, OUT, PARAMS, SLOTS, SR};

const MAX_SAMPLES: usize = 96;
const MAX_SVOICES: usize = 64;

// ---- PCM heap (bump allocator over memory.grow) ------------------------------
#[derive(Clone, Copy)]
struct SampleDesc {
    base: usize, // byte offset of ch0 in linear memory
    len: u32,    // frames
    ch: u32,     // 1 or 2 (planar: ch0 then ch1)
    sr: f32,
    cap: u32, // allocated frames (reuse in place when a reload fits)
}
const SD0: SampleDesc = SampleDesc { base: 0, len: 0, ch: 0, sr: 44100.0, cap: 0 };
static mut SAMPLES: [SampleDesc; MAX_SAMPLES] = [SD0; MAX_SAMPLES];
static mut HEAP_TOP: usize = 0;

extern "C" {
    // provided by the wasm linker: first address past static data
    static __heap_base: u8;
}

fn heap_alloc(bytes: usize) -> usize {
    unsafe {
        if HEAP_TOP == 0 {
            HEAP_TOP = (&__heap_base as *const u8 as usize + 15) & !15;
        }
        let at = HEAP_TOP;
        let end = at + bytes;
        let have = core::arch::wasm32::memory_size(0) * 65536;
        if end > have {
            let need_pages = (end - have + 65535) / 65536;
            if core::arch::wasm32::memory_grow(0, need_pages) == usize::MAX {
                return 0; // OOM — caller reports failure
            }
        }
        HEAP_TOP = (end + 15) & !15;
        at
    }
}

/// Register (or replace) a sample buffer: `ch` planar channels of `len` f32
/// frames at `sr`. Returns the write pointer for channel 0 (channel c starts
/// at ptr + c·len), or 0 on failure. Replacing an id reuses its allocation
/// when the new data fits.
#[no_mangle]
pub extern "C" fn sample_load(id: u32, ch: u32, len: u32, sr: f32) -> *mut f32 {
    let idx = (id as usize) % MAX_SAMPLES;
    let ch = ch.clamp(1, 2);
    unsafe {
        let d = &mut SAMPLES[idx];
        let need = (ch * len) as usize * 4;
        if d.cap as usize * d.ch.max(1) as usize * 4 >= need && d.base != 0 {
            // reuse in place
        } else {
            let base = heap_alloc(need);
            if base == 0 {
                return core::ptr::null_mut();
            }
            d.base = base;
            d.cap = len;
        }
        d.len = len;
        d.ch = ch;
        d.sr = sr.max(1000.0);
        d.base as *mut f32
    }
}

#[no_mangle]
pub extern "C" fn sample_ptr(id: u32, c: u32) -> *mut f32 {
    unsafe {
        let d = &SAMPLES[(id as usize) % MAX_SAMPLES];
        if d.base == 0 || c >= d.ch {
            return core::ptr::null_mut();
        }
        (d.base + (c * d.len) as usize * 4) as *mut f32
    }
}

// ---- sample voices ------------------------------------------------------------
#[derive(Clone, Copy, PartialEq)]
enum SStage {
    Free,
    Scheduled,
    Playing,
    Released,
}

#[derive(Clone, Copy)]
struct SVoice {
    stage: SStage,
    slot: usize,
    sample: usize,
    pos: f64,  // buffer frames (fractional)
    rate: f32, // buffer frames per output frame (slewed toward rate_t)
    rate_t: f32,
    rate_slew: f32, // per-block slew factor for srate_tag glides (0 = snap)
    bend: f32,      // live bend multiplier (slewed, from bend_tag)
    bend_t: f32,
    gl: f32,
    gr: f32,
    t_start: f64,
    t_rel: f64,
    a: f32,
    d: f32,
    s: f32,
    r: f32,
    env: f32,
    rel_from: f32,
    win_a: f64, // window in buffer frames
    win_b: f64,
    looping: bool,
    loop_a: f64,
    loop_b: f64,
    reverse: bool,
    f_on: bool,
    f_b: [f32; 3],
    f_a: [f32; 2],
    f_s: [[f32; 2]; 2],
    tag: u32,
}
const SV0: SVoice = SVoice {
    stage: SStage::Free, slot: 0, sample: 0, pos: 0.0, rate: 1.0, rate_t: 1.0,
    rate_slew: 0.0, bend: 1.0, bend_t: 1.0, gl: 1.0, gr: 1.0, t_start: 0.0,
    t_rel: 0.0, a: 0.001, d: 0.001, s: 1.0, r: 0.05, env: 0.0, rel_from: 0.0,
    win_a: 0.0, win_b: 0.0, looping: false, loop_a: 0.0, loop_b: 0.0,
    reverse: false, f_on: false, f_b: [0.0; 3], f_a: [0.0; 2],
    f_s: [[0.0; 2]; 2], tag: 0,
};
static mut SVOICES: [SVoice; MAX_SVOICES] = [SV0; MAX_SVOICES];

pub(crate) fn reset_all() {
    unsafe {
        for v in SVOICES.iter_mut() {
            *v = SV0;
        }
        // NOTE: loaded samples survive init() — reloading PCM per golden
        // section would defeat the point; sections load their own ids.
    }
}

fn alloc_svoice() -> usize {
    unsafe {
        for (i, v) in SVOICES.iter().enumerate() {
            if v.stage == SStage::Free {
                return i;
            }
        }
        // steal the most-decayed (lowest envelope), matching the node policy
        let mut best = 0;
        let mut best_env = f32::MAX;
        for (i, v) in SVOICES.iter().enumerate() {
            if v.env < best_env {
                best_env = v.env;
                best = i;
            }
        }
        best
    }
}

/// Start a sample voice; params staged in PARAMS (layout above).
/// dur < 0 holds until release_tag.
#[no_mangle]
pub extern "C" fn snote(slot: u32, t_start: f64, dur: f32, tag: u32) {
    unsafe {
        let q = &PARAMS;
        let id = (q[0] as usize) % MAX_SAMPLES;
        let d = &SAMPLES[id];
        if d.base == 0 || d.len == 0 {
            return;
        }
        let bsr = d.sr;
        let rate = q[1].max(0.001) * bsr / SR;
        let frames = d.len as f64;
        let win_a = (q[8].max(0.0) as f64 * bsr as f64).min(frames);
        let win_b = if q[9] >= 0.0 {
            (win_a + q[9] as f64 * bsr as f64).min(frames)
        } else {
            frames
        };
        if win_b - win_a < 2.0 {
            return;
        }
        let flags = q[10] as u32;
        let looping = flags & 1 != 0;
        let reverse = flags & 2 != 0;
        let (la, lb) = if looping {
            let a = (q[11].max(0.0) as f64 * bsr as f64).min(frames);
            let b = if q[12] > 0.0 { (q[12] as f64 * bsr as f64).min(frames) } else { frames };
            if b - a >= 2.0 { (a, b) } else { (win_a, win_b) }
        } else {
            (0.0, 0.0)
        };
        let i = alloc_svoice();
        let v = &mut SVOICES[i];
        *v = SVoice {
            stage: SStage::Scheduled,
            slot: (slot as usize) % SLOTS,
            sample: id,
            pos: if reverse { win_b - 1.0 } else { win_a },
            rate,
            rate_t: rate,
            rate_slew: 0.0,
            gl: q[2],
            gr: q[3],
            t_start,
            t_rel: if dur < 0.0 { 1.0e15 } else { t_start + dur.max(0.005) as f64 },
            a: q[4].max(0.0),
            d: q[5].max(0.0),
            s: q[6].clamp(0.0, 1.0),
            r: q[7].max(0.01),
            win_a,
            win_b,
            looping,
            loop_a: la,
            loop_b: lb,
            reverse,
            f_on: q[13] >= 0.0,
            tag,
            ..SV0
        };
        if v.f_on {
            let (b, a) = crate::strip::nat_lp(q[13].max(40.0), if q[14] > 0.0 { q[14] } else { 0.7 }, SR);
            v.f_b = b;
            v.f_a = a;
        }
    }
}

/// Glide the base playback rate (sample portamento): reach `rate_mult` ×
/// the current NOMINAL rate over `ramp_s` seconds. rate_mult is relative to
/// the rate given at snote (an absolute retune uses a fresh factor).
#[no_mangle]
pub extern "C" fn srate_tag(tag: u32, rate_mult: f32, ramp_s: f32) {
    if tag == 0 {
        return;
    }
    unsafe {
        for v in SVOICES.iter_mut() {
            if v.stage == SStage::Free || v.tag != tag {
                continue;
            }
            v.rate_t = v.rate_t / (v.rate_t / v.rate).max(1.0e-9) * rate_mult.max(0.001);
            // per-block slew constant: reach ~99% in ramp_s
            let blocks = (ramp_s.max(0.005) * SR / 128.0).max(1.0);
            v.rate_slew = 1.0 - (0.01f32).powf(1.0 / blocks);
        }
    }
}

pub(crate) fn release_tag(tag: u32, r: f32) {
    unsafe {
        for v in SVOICES.iter_mut() {
            if v.stage == SStage::Free || v.tag != tag {
                continue;
            }
            if r > 0.0 {
                v.r = r;
            }
            if v.stage != SStage::Released {
                v.t_rel = 0.0; // sentinel: anchor at the next processed block
                v.stage = SStage::Released;
                v.rel_from = v.env;
            }
        }
    }
}

pub(crate) fn bend_tag(tag: u32, cents: f32) {
    unsafe {
        for v in SVOICES.iter_mut() {
            if v.stage != SStage::Free && v.tag == tag {
                v.bend_t = (cents / 1200.0 * core::f32::consts::LN_2).exp();
            }
        }
    }
}

pub(crate) fn cancel_from(slot: usize, t: f64) {
    unsafe {
        for v in SVOICES.iter_mut() {
            if v.slot == slot && v.stage == SStage::Scheduled && v.t_start >= t {
                v.stage = SStage::Free;
            }
        }
    }
}

pub(crate) fn stop_before(slot: usize, t: f64) {
    unsafe {
        for v in SVOICES.iter_mut() {
            if v.slot != slot {
                continue;
            }
            match v.stage {
                SStage::Scheduled if v.t_start < t => v.stage = SStage::Free,
                SStage::Playing if v.t_start < t => {
                    v.stage = SStage::Released;
                    v.rel_from = v.env;
                    v.r = v.r.min(0.05);
                    v.t_rel = 0.0;
                }
                _ => {}
            }
        }
    }
}

pub(crate) fn stop_all() {
    unsafe {
        for v in SVOICES.iter_mut() {
            match v.stage {
                SStage::Scheduled => v.stage = SStage::Free,
                SStage::Playing | SStage::Released => {
                    v.rel_from = v.env;
                    v.r = 0.03;
                    v.stage = SStage::Released;
                    v.t_rel = 0.0;
                }
                SStage::Free => {}
            }
        }
    }
}

pub(crate) fn free_released() {
    unsafe {
        for v in SVOICES.iter_mut() {
            if v.stage == SStage::Released {
                v.stage = SStage::Free;
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn active_svoices() -> u32 {
    unsafe { SVOICES.iter().filter(|v| v.stage != SStage::Free).count() as u32 }
}

#[inline(always)]
fn read_frame(d: &SampleDesc, pos: f64, c: u32) -> f32 {
    unsafe {
        let i = pos as usize;
        let fr = (pos - i as f64) as f32;
        let ch = c.min(d.ch - 1);
        let p = (d.base + (ch * d.len) as usize * 4) as *const f32;
        let a = *p.add(i.min(d.len as usize - 1));
        let b = *p.add((i + 1).min(d.len as usize - 1));
        a + (b - a) * fr
    }
}

pub(crate) fn process(t_block: f64, frames: usize) {
    unsafe {
        let dt = DT as f64;
        for v in SVOICES.iter_mut() {
            if v.stage == SStage::Free {
                continue;
            }
            let block_end = t_block + frames as f64 * dt;
            if v.stage == SStage::Scheduled {
                if v.t_start >= block_end {
                    continue;
                }
                v.stage = SStage::Playing;
            }
            if v.stage == SStage::Released && v.t_rel <= 0.0 {
                v.t_rel = t_block;
            }
            let d = SAMPLES[v.sample];
            if d.base == 0 {
                v.stage = SStage::Free;
                continue;
            }
            // rate slews (glide) + bend slews — control rate per block
            if v.rate_slew > 0.0 && (v.rate - v.rate_t).abs() > 1.0e-6 {
                v.rate += v.rate_slew * (v.rate_t - v.rate);
            } else if v.rate_slew <= 0.0 {
                v.rate = v.rate_t;
            }
            if (v.bend - v.bend_t).abs() > 1.0e-6 {
                v.bend += 0.35 * (v.bend_t - v.bend);
            }
            let step = (v.rate * v.bend) as f64;
            let out = &mut OUT[v.slot];
            let mut t = t_block;
            for f in 0..frames {
                if t < v.t_start {
                    t += dt;
                    continue;
                }
                let tn = (t - v.t_start) as f32;
                // ---- envelope (same family as the synth voices) -----------
                let env = if v.stage == SStage::Released || t >= v.t_rel {
                    if v.stage != SStage::Released {
                        v.stage = SStage::Released;
                        v.rel_from = v.env;
                        v.t_rel = t;
                    }
                    let tr = (t - v.t_rel) as f32;
                    if tr >= v.r {
                        v.stage = SStage::Free;
                        break;
                    }
                    let x = tr / v.r;
                    let e = v.rel_from * (-6.9 * x).exp();
                    if x > 0.95 { e * (1.0 - x) * 20.0 } else { e }
                } else if v.a > 0.0 && tn < v.a {
                    tn / v.a
                } else if v.d > 0.0 && tn < v.a + v.d {
                    let x = (tn - v.a) / v.d;
                    v.s + (1.0 - v.s) * (-4.6 * x).exp()
                } else {
                    v.s
                };
                v.env = env;
                // ---- buffer read + advance --------------------------------
                let l0 = read_frame(&d, v.pos, 0);
                let r0 = if d.ch > 1 { read_frame(&d, v.pos, 1) } else { l0 };
                if v.reverse {
                    v.pos -= step;
                    if v.pos <= v.win_a {
                        if v.looping {
                            v.pos = v.loop_b - 1.0;
                        } else {
                            v.stage = SStage::Free;
                        }
                    }
                } else {
                    v.pos += step;
                    if v.looping {
                        // a looping voice never ends at the window — only
                        // release frees it (loop_b may equal the window end,
                        // so the wrap must win over the end check)
                        if v.pos >= v.loop_b {
                            v.pos = v.loop_a + (v.pos - v.loop_b);
                        }
                    } else if v.pos >= v.win_b - 1.0 {
                        v.stage = SStage::Free;
                    }
                }
                // ---- optional per-note lowpass ----------------------------
                let (mut xl, mut xr) = (l0, r0);
                if v.f_on {
                    xl = crate::strip::df2t(xl, &v.f_b, &v.f_a, &mut v.f_s[0]);
                    xr = crate::strip::df2t(xr, &v.f_b, &v.f_a, &mut v.f_s[1]);
                }
                out[0][f] += xl * env * v.gl;
                out[1][f] += xr * env * v.gr;
                if v.stage == SStage::Free {
                    break;
                }
                t += dt;
            }
        }
    }
}
