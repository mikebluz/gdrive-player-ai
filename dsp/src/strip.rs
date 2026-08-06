//! Phase 2: per-slot layer STRIPS + FX in-core.
//!
//! Mirrors the WebAudio per-layer chain exactly (17-ambient `_ambBuildMod` /
//! `_ambApplyLayerFx`):
//!
//!   voices+input → vcf → [eq3] → vca → level → (rev send tap) → tranceGate
//!               → gate → pan → [dist → chorus → phaser → delay → autopan] → out
//!
//! plus a shared reverb-send bus (SEND) the host routes to the node-side
//! reverb. Everything is anchored to absolute render time, so strips are
//! bit-deterministic for the golden-render gate. A DISABLED strip is a pure
//! no-op — voice output passes through untouched (Phase-1 behaviour, and the
//! existing golden baseline).
//!
//! Tone-faithfulness notes (from tone@14.9.17 source):
//! - wet/dry is an equal-power CrossFade: dry·cos(w·π/2) + wet·sin(w·π/2).
//! - native lowpass/highpass biquads take Q in DECIBELS (RBJ q = 10^(Q/20));
//!   allpass takes dimensionless Q. The strip vcf is Tone.Filter(20000, Q .7),
//!   EQ3's crossovers are single biquads at 400/2500 Hz with Q=1 (dB).
//! - a DelayNode inside a feedback cycle keeps its TRUE delay (even
//!   sub-quantum); the render-quantum penalty lands on the FEEDBACK edge,
//!   which delivers one-quantum-old data (measured — see the QUANTUM note).
//! - Distortion: y = (3+k)·x·(20π/180)/(π+k|x|), k = amount·100, input
//!   clamped to ±1, 0 inside |x|<0.001. The Focus/Tone stack is an ADDITION
//!   (no Tone counterpart) and sits on the wet path only — see `strip_dist`.
//! - Chorus: L/R delays (3.5 ms) LFO-modulated ±3.5·depth ms, LFO phases
//!   0°/180° (spread 180), same-channel feedback 0.15.
//! - Phaser: 10 series allpass biquads per channel, freq swept linearly
//!   base..base·2^octaves by LFOs phased 0°/180°, Q 8.
//! - AutoPanner: mono-downmixed wet path panned by a ±depth sine LFO.
//! - VCA mod SUMS with base gain 1 (range [−d, 0]); VCF mod REPLACES the
//!   cutoff (carries the absolute Hz value); pan mod SUMS with the base pan.

use crate::{hash_rand, BLOCK, DT, OUT, PARAMS, SLOTS, SR, TAU};

const PI: f32 = core::f32::consts::PI;
const FRAC_PI_2: f32 = core::f32::consts::FRAC_PI_2;
const DELAY_LEN: usize = 48000; // 1 s at 48 kHz
const CH_LEN: usize = 4096; // chorus line: 3.5 ms ± 3.5 ms needs ≤ 0.7 kframes
const GLITCH_LEN: usize = 48000; // 1 s at 48 kHz — same footprint as the delay line
const GRAINS: usize = 4;         // concurrent grains per strip
const CHUNK: usize = 16; // control-rate granularity (matches design voices)

// ---- parameter ramp (mirrors cancel + setValueAtTime + linearRamp) ---------
#[derive(Clone, Copy)]
struct Ramp {
    t0: f64,
    v0: f32,
    t1: f64,
    v1: f32,
}
impl Ramp {
    const fn at(v: f32) -> Ramp {
        Ramp { t0: 0.0, v0: v, t1: 0.0, v1: v }
    }
    fn value(&self, t: f64) -> f32 {
        if t <= self.t0 || self.t1 <= self.t0 {
            self.v0
        } else if t >= self.t1 {
            self.v1
        } else {
            self.v0 + (self.v1 - self.v0) * (((t - self.t0) / (self.t1 - self.t0)) as f32)
        }
    }
}

// ---- strip mod source (the layer vca/vcf/pan LFO) ---------------------------
// Shapes: -1 off, 0 sine, 1 triangle, 2 saw, 3 square, 4 smooth, 5 sharp,
// 6 sampled curve (64 points staged via PARAMS — covers 'seq' and 'custom').
// Output maps the wave into [min, max] exactly like Tone.LFO. Phase anchors
// at t=0 absolute (node LFOs start when built — unpredictable — so parity is
// judged on rate/range/shape, which calibration measures).
#[derive(Clone, Copy)]
struct SMod {
    shape: i32,
    hz: f32,
    min: f32,
    max: f32,
    smooth: bool,
    curve: [f32; 64],
}
const SMOD0: SMod = SMod { shape: -1, hz: 1.0, min: 0.0, max: 0.0, smooth: false, curve: [0.0; 64] };

fn smod_val(m: &SMod, t: f64, seed: u32) -> f32 {
    let x = t * m.hz as f64;
    let ph = (x - x.floor()) as f32;
    let w = match m.shape {
        0 => (ph * TAU).sin(),
        1 => 1.0 - 4.0 * (ph - 0.5).abs(),
        2 => ph * 2.0 - 1.0,
        3 => {
            if ph < 0.5 { 1.0 } else { -1.0 }
        }
        4 | 5 => {
            // stochastic: node schedules uniform random points at 1/hz;
            // deterministic stateless hash here (smooth lerps, sharp holds)
            let k = x.floor() as i64 as u32;
            let a = hash_rand(seed, k);
            if m.shape == 4 {
                let b = hash_rand(seed, k.wrapping_add(1));
                a + (b - a) * ph
            } else {
                a
            }
        }
        _ => {
            // 6: sampled curve, values already 0..1
            let pos = ph * 64.0;
            let i = (pos as usize).min(63);
            let c0 = m.curve[i];
            let v01 = if m.smooth {
                let c1 = m.curve[(i + 1) & 63];
                c0 + (c1 - c0) * (pos - i as f32)
            } else {
                c0
            };
            return m.min + (m.max - m.min) * v01.clamp(0.0, 1.0);
        }
    };
    m.min + (m.max - m.min) * (w * 0.5 + 0.5)
}

// ---- native-spec biquads ----------------------------------------------------
// WebAudio lowpass/highpass: Q in dB → RBJ q = 10^(Q/20). Frequency clamped
// to (0, nyquist). DF2-transposed state [s1, s2] per channel.
pub(crate) fn nat_lp(fc: f32, q_db: f32, sr: f32) -> ([f32; 3], [f32; 2]) {
    let fc = fc.clamp(1.0, sr * 0.499);
    let w0 = TAU * fc / sr;
    let (sw, cw) = (w0.sin(), w0.cos());
    let q = 10f32.powf(q_db / 20.0);
    let alpha = sw / (2.0 * q.max(1.0e-4));
    let a0 = 1.0 + alpha;
    (
        [(1.0 - cw) * 0.5 / a0, (1.0 - cw) / a0, (1.0 - cw) * 0.5 / a0],
        [(-2.0 * cw) / a0, (1.0 - alpha) / a0],
    )
}
fn nat_hp(fc: f32, q_db: f32, sr: f32) -> ([f32; 3], [f32; 2]) {
    let fc = fc.clamp(1.0, sr * 0.499);
    let w0 = TAU * fc / sr;
    let (sw, cw) = (w0.sin(), w0.cos());
    let q = 10f32.powf(q_db / 20.0);
    let alpha = sw / (2.0 * q.max(1.0e-4));
    let a0 = 1.0 + alpha;
    (
        [(1.0 + cw) * 0.5 / a0, -(1.0 + cw) / a0, (1.0 + cw) * 0.5 / a0],
        [(-2.0 * cw) / a0, (1.0 - alpha) / a0],
    )
}
// Allpass: dimensionless Q (phaser stages).
fn nat_ap(fc: f32, q: f32, sr: f32) -> ([f32; 3], [f32; 2]) {
    let fc = fc.clamp(1.0, sr * 0.499);
    let w0 = TAU * fc / sr;
    let (sw, cw) = (w0.sin(), w0.cos());
    let alpha = sw / (2.0 * q.max(1.0e-4));
    let a0 = 1.0 + alpha;
    (
        [(1.0 - alpha) / a0, (-2.0 * cw) / a0, (1.0 + alpha) / a0],
        [(-2.0 * cw) / a0, (1.0 - alpha) / a0],
    )
}

// ---- denormal flush ---------------------------------------------------------
// WASM has no FTZ mode, and on x86 subnormal floats fall back to microcode —
// orders of magnitude slower than normal ops. Strips process SILENCE whenever
// their layer is idle, so every recursive path (biquad states, delay/chorus
// feedback lines) decays into the subnormal range and sits there, burning CPU
// on nothing. Flushing below 1e-18 is ~120 dB under the smallest audible tail
// (inaudible by construction) and stops the decay at true zero, where the
// arithmetic is fast again. Applied at every RECURSIVE write — never on the
// forward signal path, which passes through and can't accumulate.
#[inline(always)]
pub(crate) fn flush(x: f32) -> f32 {
    if x.abs() < 1.0e-18 { 0.0 } else { x }
}

// One-pole DC blocker (~10 Hz highpass): y = x - x1 + R*y1. The ASYMMETRIC
// dist flavors generate a DC component — fuzz clamps -0.9/+0.6, wavefold's
// +0.25 phase offset re-centres arbitrarily, crush's floor() rounds toward
// -inf — and that offset eats limiter headroom and thumps when a gate cuts
// the layer. Classic and overdrive are odd-symmetric (no DC) and are NOT
// routed through this, which also keeps the golden-pinned classic path
// byte-identical. R at 48 kHz ≈ 0.99869 → -3 dB near 10 Hz.
#[inline(always)]
fn dc_block(x: f32, s: &mut [f32; 2]) -> f32 {
    let r = 1.0 - TAU * 10.0 / unsafe { SR };
    let y = x - s[0] + r * s[1];
    s[0] = x;
    s[1] = flush(y);
    y
}

// ---- ZDF state-variable filter (Cytomic/Simper "linear SVF") ---------------
// The strip VCF's kernel since 2026-07-30. Same bilinear-warped transfer
// function as the RBJ biquad it replaced (verified: magnitude response matches
// to <0.1 dB across the band at low AND high Q), but with the two properties a
// MODULATED filter wants and a biquad lacks: coefficients are cheap enough to
// refresh every chunk unconditionally (one tan), so cutoff sweeps step at the
// chunk rate instead of the old 0.2%-cache stepping; and the resonant feedback
// lives in two integrators whose STATE can be saturated directly, which is the
// true VA topology the df2t_sat hack approximated. `k` = 1/Q(linear); native-
// lowpass "Q" arrives in dB and converts at the call site.
#[inline(always)]
pub(crate) fn svf_g(fc: f32, sr: f32) -> f32 {
    (core::f32::consts::PI * (fc.clamp(1.0, sr * 0.499) / sr)).tan()
}
// One LP sample. s = [ic1, ic2]. `sat` engages the integrator tanh (the VA
// resonance behavior) — below the call sites' Q threshold it stays off and the
// filter is exactly linear.
#[inline(always)]
pub(crate) fn svf_lp(x: f32, g: f32, k: f32, s: &mut [f32; 2], sat: bool) -> f32 {
    let a1 = 1.0 / (1.0 + g * (g + k));
    let v1 = (s[0] + g * (x - s[1])) * a1;
    let v2 = s[1] + g * v1;
    let (n1, n2) = (2.0 * v1 - s[0], 2.0 * v2 - s[1]);
    if sat {
        s[0] = flush(sat4(n1));
        s[1] = flush(sat4(n2));
    } else {
        s[0] = flush(n1);
        s[1] = flush(n2);
    }
    v2
}

pub(crate) fn df2t(x: f32, b: &[f32; 3], a: &[f32; 2], s: &mut [f32; 2]) -> f32 {
    let y = b[0] * x + s[0];
    s[0] = flush(b[1] * x - a[0] * y + s[1]);
    s[1] = flush(b[2] * x - a[1] * y);
    y
}

// tanh soft clip scaled so |x| ≤ 0.5 passes within 0.5% (transparent at
// musical levels) while runaway resonance compresses toward ±4 instead of
// ringing at whatever amplitude the pole math produces.
#[inline(always)]
pub(crate) fn sat4(x: f32) -> f32 {
    let v = x * 0.25;
    let e = (2.0 * v).exp();
    4.0 * ((e - 1.0) / (e + 1.0))
}


// ---- antiderivative anti-aliasing (ADAA) -------------------------------------
// A waveshaper multiplies harmonics and every one above Nyquist folds back as an
// inharmonic tone — the "digital harshness" oversampling exists to prevent.
// Measured before this existed (test/alias-measure.js): the classic curve aliased
// to -15 dB at 5 kHz with full drive, overdrive -17.
//
// First-order ADAA replaces f(x) with the AVERAGE of f over the segment between
// consecutive samples, computed from its antiderivative F:
//     y[n] = (F(x[n]) - F(x[n-1])) / (x[n] - x[n-1])
// That is a one-sample box filter applied in the WAVESHAPER's own domain, which
// suppresses the folded content at roughly 1x cost — no upsampling, no filters.
//
// 2x oversampling was measured first and rejected: with any half-band length it
// plateaued at +3.5 dB mean (worst case NEGATIVE, on the wavefolder) for ~2.5x
// the CPU, because 2x only moves Nyquist to 88 kHz and these curves generate
// harmonics far past it. ADAA is applied to the two SMOOTH curves only —
// classic and overdrive. The hard clip, the wavefolder and the bit crusher have
// discontinuous or deliberately-aliasing shapes where first-order ADAA earns
// little, so they keep their exact previous arithmetic.
//
// The subtraction is ill-conditioned when consecutive samples are close (0/0), so
// below a threshold it falls back to the direct curve at the midpoint — standard,
// and the reason ADAA needs a well-chosen epsilon rather than an exact test.
const ADAA_EPS: f32 = 1.0e-5;

/// classic: f(x) = A*x/(PI + k|x|). Odd, so F is even and only |x| is needed.
#[inline(always)]
fn f_classic(x: f32, a: f32, k: f32) -> f32 {
    if x.abs() < 0.001 { 0.0 } else { a * x / (PI + k * x.abs()) }
}
#[inline(always)]
fn cap_classic(x: f32, a: f32, k: f32) -> f32 {
    let ax = x.abs();
    if k < 1.0e-4 { return a * ax * ax / (2.0 * PI); }        // k -> 0: f is linear
    a * (ax / k - (PI / (k * k)) * (1.0 + k * ax / PI).ln())
}
/// overdrive: f(x) = tanh(g x)/tanh(g); F = ln(cosh(g x)) / (g tanh g).
#[inline(always)]
fn f_drive(x: f32, g: f32, t: f32) -> f32 {
    let e = (2.0 * g * x).exp();
    ((e - 1.0) / (e + 1.0)) / t
}
#[inline(always)]
fn cap_drive(x: f32, g: f32, t: f32) -> f32 {
    let z = (g * x).abs();
    // ln(cosh z) overflows in f32 well before z is large; past ~12 it is z - ln2
    // to far more precision than f32 carries.
    let lncosh = if z > 12.0 { z - core::f32::consts::LN_2 } else { (z.cosh()).ln() };
    lncosh / (g * t)
}
/// The ADAA step itself, shared by both curves.
#[inline(always)]
fn adaa(x: f32, xp: f32, fp: f32, f: impl Fn(f32) -> f32, cap: impl Fn(f32) -> f32) -> (f32, f32) {
    let fx = cap(x);
    let d = x - xp;
    let y = if d.abs() < ADAA_EPS { f(0.5 * (x + xp)) } else { (fx - fp) / d };
    (y, fx)
}

/// Equal-power wet/dry (Tone CrossFade): (dry gain, wet gain).
#[inline(always)]
fn xfade(w: f32) -> (f32, f32) {
    let a = w.clamp(0.0, 1.0) * FRAC_PI_2;
    (a.cos(), a.sin())
}

// ---- the strip --------------------------------------------------------------
#[derive(Clone, Copy)]
pub(crate) struct Strip {
    on: bool,
    // vcf: Tone.Filter(lowpass, 20000, Q 0.7) — always in the node chain, so
    // it always runs when the strip is enabled. Mod REPLACES the cutoff.
    vcf_mod: SMod,
    vcf_last: f32,
    // Static (hand-controllable) base cutoff Hz + resonance Q. When no VCF LFO is
    // engaged the cutoff holds here (a live filter knob); the reso applies either
    // way. Defaults 20000/0.7 reproduce the old fixed-open behaviour byte-for-byte.
    vcf_cutoff: f32,
    vcf_reso: f32,
    vcf_s: [[f32; 2]; 2],
    // eq3 (lazy, engaged only while a band ≠ 0 — matches the node splice)
    eq_on: bool,
    eq_g: [f32; 3],
    eq_b: [[f32; 3]; 4],
    eq_a: [[f32; 2]; 4],
    eq_s: [[[f32; 2]; 4]; 2], // [ch][lp400, hp400, lp2500, hp2500]
    // gains
    vca_mod: SMod,
    level: Ramp,
    gate: Ramp,
    rev: Ramp,
    /// Unit-schedule chop gate (host param 5) — a plain output multiplier the
    /// host schedules against the layer's UNIT grid, alongside the bar-synced
    /// trance gate. 1.0 = neutral, and nothing writes it unless a layer runs a
    /// unit schedule in 'chop' mode, so x*1.0 keeps every existing render
    /// bit-identical. Applied with tg_val (post send-tap) so a chopped slice
    /// still feeds the reverb — the wash rings through the hole.
    ug: Ramp,
    pan: Ramp,
    pan_mod: SMod,
    // stereo WIDTH (side-gain multiplier, live-morphable): in spread mode the
    // host emits the voice fan at FULL width and drives this to space/100, so
    // the fader reshapes SOUNDING voices in real time; pan mode drives it to
    // 0 (the node panner's point-source behaviour).
    width: Ramp,
    // MAIN (dry) output gain, applied to OUT after the whole FX chain but AFTER
    // the reverb SEND is already tapped (line ~643) — so 0 mutes the layer's
    // direct/dry+in-line-FX output while the parallel reverb wash keeps ringing.
    // Drives the per-layer "Wet only" toggle. 1.0 = neutral (skipped, byte-identical).
    main: f32,
    // trance gate (stateless bar-anchored step pattern)
    tg_on: bool,
    tg_steps: u32,
    tg_pat: u64,
    tg_depth: f32,
    tg_edge: f32,
    tg_anchor: f64,
    tg_bar: f32,
    // fx
    dist_on: bool,
    dist_k: f32,
    dist_wet: f32,
    dist_mode: u32,
    crush_cnt: [f32; 2],
    crush_hold: [f32; 2],
    // Distortion TONE STACK — both neutral-off, so a strip that never sets them
    // (or a 5-arg caller: a missing i32 arg coerces to 0) is byte-identical.
    // `foc` = a PRE-shaper high-pass: how much low end reaches the drive. Bass
    // into a waveshaper is what turns a chord to mud, so cutting it first is the
    // single most useful control on a distortion.
    // `tn` = a POST-shaper tilt: < 0 lowpass (dark, tames fizz), > 0 highpass
    // (bright, thins).
    // BOTH RUN ON THE WET PATH ONLY. The dry half of the Mix crossfade is
    // untouched, which is the whole point of a partial Mix — clean lows sitting
    // under a filtered dirty top. Coefficients are computed in strip_dist (they
    // only change when the host pushes), unlike the vcf's per-block recompute.
    dist_foc_on: bool,
    dist_foc_b: [f32; 3],
    dist_foc_a: [f32; 2],
    dist_foc_s: [[f32; 2]; 2],
    dist_tn_on: bool,
    dist_tn_b: [f32; 3],
    dist_tn_a: [f32; 2],
    dist_tn_s: [[f32; 2]; 2],
    // DC blocker state for the asymmetric dist flavors: [x1, y1] per channel.
    dist_dc_s: [[f32; 2]; 2],
    dist_adaa_x: [f32; 2],       // previous shaper input, per channel (ADAA)
    // ...and its antiderivative, CACHED. Computing F twice per sample (for x and
    // for x_prev) doubles the transcendentals and measured +45% CPU on a
    // dist-heavy scene; carrying F(x_prev) forward halves that back. The cache is
    // only valid while the curve's parameters hold still, hence the dirty flag.
    dist_adaa_f: [f32; 2],
    dist_adaa_dirty: bool,
    // SMOOTHED SHADOWS of the gain-like params a UI toggle can step. Wet only
    // (main 1→0) and Dry kill (a wet 0.35→1) were applied instantly, so flipping
    // either mid-note put a step in the signal — heard as a click. These follow
    // their target with a short per-block glide; the stages read the `_c` value.
    // `-1.0` means "not primed yet": the first block snaps so engaging a strip is
    // not a fade-in from silence.
    main_c: f32,
    dist_wet_c: f32,
    cho_wet_c: f32,
    pha_wet_c: f32,
    dly_wet_c: f32,
    ap_wet_c: f32,
    gl_wet_c: f32,
    fx_order: [u8; 5],
    // ---- GLITCH: one buffer stage, four read strategies (grain / repeat /
    // tape-stop / reverse). Runs AFTER the reorderable five so `fx_order` stays a
    // permutation of 0..4 and no existing routing changed. Feed-forward only —
    // the ring takes the stage INPUT, never its own output, so there is no
    // recursive path to flush.
    gl_on: bool,
    gl_mode: u8,     // 0 grain · 1 repeat · 2 tape-stop · 3 reverse
    gl_wet: f32,
    gl_size: f32,    // grain / slice length, seconds
    gl_rate: f32,    // grains per second (grain) · slices per second (others)
    gl_jit: f32,     // 0..1 read-position scatter
    gl_pitch: f32,   // ± semitones of per-grain pitch scatter
    gl_w: usize,     // ring write head
    gl_ph: f64,      // scheduler phase, in samples since the last spawn/slice
    gl_base: f64,    // captured read origin for repeat / reverse
    gl_pos: f64,     // read cursor within the current slice
    gl_rep: u32,     // slices played since the last capture
    gl_rng: u32,     // per-strip xorshift — deterministic, so golden reproduces
    gl_g: [[f32; 4]; GRAINS],   // per grain: [pos, inc, len, age] (all in samples)
    cho_on: bool,
    cho_wet: f32,
    cho_depth: f32,
    cho_rate: f32,
    cho_w: usize,
    pha_on: bool,
    pha_wet: f32,
    pha_oct: f32,
    pha_rate: f32,
    pha_s: [[[f32; 2]; 10]; 2],
    dly_on: bool,
    dly_ping: bool,
    dly_wet: f32,
    dly_t: f32,
    dly_fb: f32,
    dly_w: usize,
    // Stereo SPREAD of the delay wet (0..1): a Haas inter-channel offset on the
    // OUTPUT tap of the right channel (up to ~30 ms), scaled by spread. 0 = both
    // channels read at the same tap = byte-identical to the pre-spread delay.
    // The feedback path always reads at the base tap so the echo timing/decay is
    // unchanged — only the stereo image of what reaches the bus widens.
    dly_spread: f32,
    ap_on: bool,
    ap_wet: f32,
    ap_depth: f32,
    ap_rate: f32,
}

pub(crate) const STRIP0: Strip = Strip {
    on: false,
    vcf_mod: SMOD0,
    vcf_last: 0.0,
    vcf_cutoff: 20000.0,
    vcf_reso: 0.7,
    vcf_s: [[0.0; 2]; 2],
    eq_on: false,
    eq_g: [1.0; 3],
    eq_b: [[0.0; 3]; 4],
    eq_a: [[0.0; 2]; 4],
    eq_s: [[[0.0; 2]; 4]; 2],
    vca_mod: SMOD0,
    level: Ramp::at(1.0),
    gate: Ramp::at(1.0),
    rev: Ramp::at(0.0),
    ug: Ramp::at(1.0),
    pan: Ramp::at(0.0),
    pan_mod: SMOD0,
    width: Ramp::at(1.0),
    main: 1.0,
    tg_on: false,
    tg_steps: 16,
    tg_pat: 0,
    tg_depth: 1.0,
    tg_edge: 0.006,
    tg_anchor: 0.0,
    tg_bar: 2.0,
    dist_on: false,
    dist_k: 40.0,
    dist_wet: 0.0,
    dist_mode: 0,
    crush_cnt: [0.0; 2],
    crush_hold: [0.0; 2],
    dist_foc_on: false,
    dist_foc_b: [0.0; 3],
    dist_foc_a: [0.0; 2],
    dist_foc_s: [[0.0; 2]; 2],
    dist_tn_on: false,
    dist_tn_b: [0.0; 3],
    dist_tn_a: [0.0; 2],
    dist_tn_s: [[0.0; 2]; 2],
    dist_dc_s: [[0.0; 2]; 2],
    dist_adaa_x: [0.0; 2],
    dist_adaa_f: [0.0; 2],
    dist_adaa_dirty: true,
    cho_on: false,
    cho_wet: 0.0,
    cho_depth: 0.5,
    cho_rate: 1.5,
    cho_w: 0,
    pha_on: false,
    pha_wet: 0.0,
    pha_oct: 3.0,
    pha_rate: 0.5,
    pha_s: [[[0.0; 2]; 10]; 2],
    dly_on: false,
    dly_ping: false,
    dly_wet: 0.0,
    dly_t: 0.3,
    dly_fb: 0.35,
    dly_w: 0,
    dly_spread: 0.0,
    ap_on: false,
    ap_wet: 0.0,
    main_c: -1.0,
    dist_wet_c: -1.0,
    cho_wet_c: -1.0,
    pha_wet_c: -1.0,
    dly_wet_c: -1.0,
    ap_wet_c: -1.0,
    gl_wet_c: -1.0,
    fx_order: [0, 1, 2, 3, 4],
    gl_on: false,
    gl_mode: 0,
    gl_wet: 0.0,
    gl_size: 0.08,
    gl_rate: 20.0,
    gl_jit: 0.0,
    gl_pitch: 0.0,
    gl_w: 0,
    gl_ph: 0.0,
    gl_base: 0.0,
    gl_pos: 0.0,
    gl_rep: 0,
    gl_rng: 0x9E3779B9,
    gl_g: [[0.0; 4]; GRAINS],
    ap_depth: 1.0,
    ap_rate: 1.0,
};

pub(crate) static mut STRIPS: [Strip; SLOTS] = [STRIP0; SLOTS];
pub(crate) static mut IN_BUF: [[[f32; BLOCK]; 2]; SLOTS] = [[[0.0; BLOCK]; 2]; SLOTS];
pub(crate) static mut SEND: [[f32; BLOCK]; 2] = [[0.0; BLOCK]; 2];
static mut GBUF: [[[f32; GLITCH_LEN]; 2]; SLOTS] = [[[0.0; GLITCH_LEN]; 2]; SLOTS];
static mut DLINE: [[[f32; DELAY_LEN]; 2]; SLOTS] = [[[0.0; DELAY_LEN]; 2]; SLOTS];
static mut DPRE: [[f32; DELAY_LEN]; SLOTS] = [[0.0; DELAY_LEN]; SLOTS];
static mut CBUF: [[[f32; CH_LEN]; 2]; SLOTS] = [[[0.0; CH_LEN]; 2]; SLOTS];
// One-quantum-old wet history for the FEEDBACK edges (see QUANTUM note):
// the cycle-breaking delay lands on the feedback path, not the delay itself.
const QUANT: usize = 128;
static mut CFB: [[[f32; QUANT]; 2]; SLOTS] = [[[0.0; QUANT]; 2]; SLOTS]; // chorus
static mut DFB: [[[f32; QUANT]; 2]; SLOTS] = [[[0.0; QUANT]; 2]; SLOTS]; // delay/pingpong
// QUANTUM note (measured, chorus-probe + comb spectra): Chrome does NOT
// clamp a cycle-member DelayNode's delayTime — the first-pass wet keeps its
// true (even sub-quantum) delay; the cycle is broken by the FEEDBACK edge
// delivering one-render-quantum-OLD data. A blanket max(d, 128/sr) clamp
// killed the low half of the chorus sweep (node comb notches at ~1.6 ms
// stayed; core's vanished).

pub(crate) fn reset_all() {
    unsafe {
        for s in 0..SLOTS {
            reset_slot(s);
            STRIPS[s] = STRIP0;
        }
        for c in SEND.iter_mut() {
            for f in c.iter_mut() {
                *f = 0.0;
            }
        }
    }
}

fn reset_slot(slot: usize) {
    unsafe {
        for ch in 0..2 {
            for f in GBUF[slot][ch].iter_mut() {
                *f = 0.0;
            }
            for f in DLINE[slot][ch].iter_mut() {
                *f = 0.0;
            }
            for f in CBUF[slot][ch].iter_mut() {
                *f = 0.0;
            }
            for f in IN_BUF[slot][ch].iter_mut() {
                *f = 0.0;
            }
        }
        for f in DPRE[slot].iter_mut() {
            *f = 0.0;
        }
        for ch in 0..2 {
            for f in CFB[slot][ch].iter_mut() {
                *f = 0.0;
            }
            for f in DFB[slot][ch].iter_mut() {
                *f = 0.0;
            }
        }
    }
}

// Trance-gate value at absolute time t (mirrors _ambScheduleTg's schedule:
// at each step boundary, linear ramp from the previous step's value over
// min(edge, step/2), else hold).
fn tg_val(st: &Strip, t: f64) -> f32 {
    if !st.tg_on || st.tg_steps < 2 {
        return 1.0;
    }
    let steps = st.tg_steps.min(64) as i64;
    let step = (st.tg_bar as f64 / steps as f64).max(0.01);
    let x = (t - st.tg_anchor) / step;
    let k = x.floor();
    let within = ((x - k) * step) as f32;
    let off = 1.0 - st.tg_depth.clamp(0.0, 1.0);
    let v_at = |i: i64| -> f32 {
        let m = ((i % steps) + steps) % steps;
        if st.tg_pat >> m & 1 == 1 { 1.0 } else { off }
    };
    let idx = k as i64;
    let v = v_at(idx);
    let e = st.tg_edge.min(step as f32 * 0.5);
    if e > 0.0005 && within < e {
        let pv = v_at(idx - 1);
        pv + (v - pv) * (within / e)
    } else {
        v
    }
}

// ---- FX blocks (each processes the slot buffer in place) --------------------

// Distortion FLAVORS (dist_mode): 0 = classic (the ORIGINAL curve — must stay
// byte-identical, it's the golden-covered default) · 1 = overdrive (smooth
// symmetric tanh, warm) · 2 = fuzz (pre-gain + asymmetric hard clip + crossover
// gate sputter) · 3 = wavefold (triangle fold) · 4 = crush (bit-depth quantize).
fn fx_dist(buf: &mut [[f32; BLOCK]; 2], st: &mut Strip, frames: usize) {
    let (cd, cw) = xfade(st.dist_wet_c);
    let k = st.dist_k;
    if st.dist_mode == 4 {
        // CRUSH: bit-depth quantize + SAMPLE-RATE reduce (zero-order hold),
        // both coupled to Amount — k 0 → 8 bits @ 1× (near-clean), k 100 →
        // 2 bits @ ~12× downsample (full lo-fi). Stateful (per-channel hold
        // register + fractional counter), which is why it can't live in the
        // stateless waveshape match below.
        let lv = ((8.0 - k * 0.06) * core::f32::consts::LN_2).exp();
        let hold = 1.0 + k * 0.11;
        for (ci, ch) in buf.iter_mut().enumerate() {
            for x in ch.iter_mut().take(frames) {
                let dry = *x;
                let xin = if st.dist_foc_on {
                    df2t(dry, &st.dist_foc_b, &st.dist_foc_a, &mut st.dist_foc_s[ci])
                } else {
                    dry
                };
                st.crush_cnt[ci] += 1.0;
                if st.crush_cnt[ci] >= hold {
                    st.crush_cnt[ci] -= hold;
                    st.crush_hold[ci] = (xin.clamp(-1.0, 1.0) * lv).floor() / lv;
                }
                let y = if st.dist_tn_on {
                    df2t(st.crush_hold[ci], &st.dist_tn_b, &st.dist_tn_a, &mut st.dist_tn_s[ci])
                } else {
                    st.crush_hold[ci]
                };
                let y = dc_block(y, &mut st.dist_dc_s[ci]);
                *x = dry * cd + y * cw;
            }
        }
        return;
    }
    let scale = 20.0 * PI / 180.0;
    let mode = st.dist_mode;
    let tanhf = |v: f32| { let e = (2.0 * v).exp(); (e - 1.0) / (e + 1.0) };
    for (ci, ch) in buf.iter_mut().enumerate() {
        for x in ch.iter_mut().take(frames) {
            let dry = *x;
            // Focus: high-pass the signal ON ITS WAY INTO the shaper only.
            let xin = if st.dist_foc_on {
                df2t(dry, &st.dist_foc_b, &st.dist_foc_a, &mut st.dist_foc_s[ci])
            } else {
                dry
            };
            let xc = xin.clamp(-1.0, 1.0);
            let xp = st.dist_adaa_x[ci];
            let fp = if st.dist_adaa_dirty { f32::NAN } else { st.dist_adaa_f[ci] };
            st.dist_adaa_x[ci] = xc;
            let y = match mode {
                1 => {
                    // overdrive — smooth, so ADAA earns its keep here
                    let g = 1.0 + k * 0.12;
                    let t = tanhf(g);
                    let fprev = if fp.is_nan() { cap_drive(xp, g, t) } else { fp };
                    let (y, fx) = adaa(xc, xp, fprev, |v| f_drive(v, g, t), |v| cap_drive(v, g, t));
                    st.dist_adaa_f[ci] = fx;
                    y
                }
                2 => {
                    let g = 1.0 + k * 0.30;
                    let v = (g * xc).clamp(-0.9, 0.6) * 1.25;
                    if xc.abs() < 0.0002 * k { v * 0.25 } else { v }
                }
                3 => {
                    let g = 1.0 + k * 0.07;
                    let ph = (g * xc * 0.25 + 0.25).rem_euclid(1.0);
                    4.0 * (ph - 0.5).abs() - 1.0
                }
                4 => {
                    let lv = ((8.0 - k * 0.06) * core::f32::consts::LN_2).exp();
                    (xc * lv).floor() / lv
                }
                _ => {
                    // classic — the default curve, and the one most layers use
                    let a = (3.0 + k) * scale;
                    let fprev = if fp.is_nan() { cap_classic(xp, a, k) } else { fp };
                    let (y, fx) = adaa(xc, xp, fprev, |v| f_classic(v, a, k), |v| cap_classic(v, a, k));
                    st.dist_adaa_f[ci] = fx;
                    y
                }
            };
            // Tone: tilt the SHAPED signal before it meets the dry.
            let y = if st.dist_tn_on {
                df2t(y, &st.dist_tn_b, &st.dist_tn_a, &mut st.dist_tn_s[ci])
            } else {
                y
            };
            // Only the asymmetric flavors carry DC; classic/overdrive skip the
            // blocker entirely so their (golden-covered) output is untouched.
            let y = if mode == 2 || mode == 3 { dc_block(y, &mut st.dist_dc_s[ci]) } else { y };
            *x = dry * cd + y * cw;
        }
    }
    st.dist_adaa_dirty = false;   // both channels now carry a valid F(x_prev)
}

fn fx_chorus(slot: usize, st: &mut Strip, t: f64, frames: usize) {
    let sr = unsafe { SR };
    let (cd, cw) = xfade(st.cho_wet_c);
    let dt0 = 0.0035f32;
    let dev = dt0 * st.cho_depth.clamp(0.0, 1.0);
    let fb = 0.15f32;
    let mut i0 = 0;
    while i0 < frames {
        let n = (frames - i0).min(CHUNK);
        let tc = t + i0 as f64 * unsafe { DT } as f64;
        let ph = tc * st.cho_rate as f64;
        let s = ((ph - ph.floor()) as f32 * TAU).sin();
        // L phase 0°, R phase 180° (spread 180); TRUE delay, ≥1 sample
        let d_l = ((dt0 + dev * s) * sr).max(1.0);
        let d_r = ((dt0 - dev * s) * sr).max(1.0);
        for i in i0..i0 + n {
            let w = st.cho_w;
            let q = w % QUANT;
            for (ch, d) in [d_l, d_r].iter().enumerate() {
                let rp = w as f32 - d + CH_LEN as f32;
                let ri = rp as usize;
                let fr = rp - ri as f32;
                let (b0, b1) = unsafe {
                    (CBUF[slot][ch][ri % CH_LEN], CBUF[slot][ch][(ri + 1) % CH_LEN])
                };
                let wet = b0 + (b1 - b0) * fr;
                let x = unsafe { OUT[slot][ch][i] };
                unsafe {
                    let fb_old = CFB[slot][ch][q]; // wet from one quantum ago
                    CFB[slot][ch][q] = wet;
                    CBUF[slot][ch][w] = flush(x + fb * fb_old);
                    OUT[slot][ch][i] = x * cd + wet * cw;
                }
            }
            st.cho_w = (w + 1) % CH_LEN;
        }
        i0 += n;
    }
}

fn fx_phaser(st: &mut Strip, buf: &mut [[f32; BLOCK]; 2], t: f64, frames: usize) {
    let sr = unsafe { SR };
    let (cd, cw) = xfade(st.pha_wet_c);
    let base = 350.0f32;
    let fmax = base * (st.pha_oct * core::f32::consts::LN_2).exp();
    let mut i0 = 0;
    while i0 < frames {
        let n = (frames - i0).min(CHUNK);
        let tc = t + i0 as f64 * unsafe { DT } as f64;
        let ph = tc * st.pha_rate as f64;
        let s = ((ph - ph.floor()) as f32 * TAU).sin();
        // LFO phases 0°/180°; linear sweep base..base·2^oct (Tone.LFO mapping)
        let f_l = base + (fmax - base) * (s * 0.5 + 0.5);
        let f_r = base + (fmax - base) * (-s * 0.5 + 0.5);
        for (ch, fq) in [f_l, f_r].iter().enumerate() {
            let (b, a) = nat_ap(*fq, 8.0, sr);
            for i in i0..i0 + n {
                let x = buf[ch][i];
                let mut y = x;
                for stg in 0..10 {
                    y = df2t(y, &b, &a, &mut st.pha_s[ch][stg]);
                }
                buf[ch][i] = x * cd + y * cw;
            }
        }
        i0 += n;
    }
}

fn fx_delay(slot: usize, st: &mut Strip, frames: usize) {
    let sr = unsafe { SR };
    let (cd, cw) = xfade(st.dly_wet_c);
    let fb = st.dly_fb.clamp(0.0, 0.95);
    // TRUE delay on every read; the feedback edge is one quantum old (see
    // the QUANTUM note) — so echo k lands at k·d + (k−1)·128 samples.
    let d = ((st.dly_t.max(0.001) * sr) as usize).clamp(1, DELAY_LEN - 1);
    // Haas OUTPUT offset for the right channel (spread 0..1 → 0..~30 ms). The
    // feedback path stays on `d`; only the R output tap reads `d + haas`, so at
    // spread 0 (haas 0) every read is `d` and the block is byte-identical.
    let haas = ((st.dly_spread.clamp(0.0, 1.0) * 0.03 * sr) as usize).min(DELAY_LEN - 1 - d);
    let dr = (d + haas).min(DELAY_LEN - 1);
    for i in 0..frames {
        let w = st.dly_w;
        let q = w % QUANT;
        let rd = |line: &[f32; DELAY_LEN], d: usize| line[(w + DELAY_LEN - d) % DELAY_LEN];
        unsafe {
            if st.dly_ping {
                let l_out = rd(&DLINE[slot][0], d);
                let r_fb = rd(&DLINE[slot][1], d);        // R feedback tap (base)
                let r_out = rd(&DLINE[slot][1], dr);      // R output tap (Haas-offset)
                let pre_out = rd(&DPRE[slot], d);
                let (in_l, in_r) = (OUT[slot][0][i], OUT[slot][1][i]);
                let (l_old, r_old) = (DFB[slot][0][q], DFB[slot][1][q]);
                DFB[slot][0][q] = l_out;
                DFB[slot][1][q] = r_fb;
                // cross feedback: L out → R delay input, R out → L delay input
                DLINE[slot][0][w] = flush(in_l + fb * r_old);
                DLINE[slot][1][w] = flush(pre_out + fb * l_old);
                DPRE[slot][w] = flush(in_r);
                OUT[slot][0][i] = in_l * cd + l_out * cw;
                OUT[slot][1][i] = in_r * cd + r_out * cw;
            } else {
                for ch in 0..2 {
                    let fb_read = rd(&DLINE[slot][ch], d);                 // feedback tap (base)
                    let out_read = rd(&DLINE[slot][ch], if ch == 1 { dr } else { d }); // R output offset
                    let x = OUT[slot][ch][i];
                    let old = DFB[slot][ch][q];
                    DFB[slot][ch][q] = fb_read;
                    DLINE[slot][ch][w] = flush(x + fb * old);
                    OUT[slot][ch][i] = x * cd + out_read * cw;
                }
            }
        }
        st.dly_w = (w + 1) % DELAY_LEN;
    }
}

// Linear read of the glitch ring at a fractional position (already wrapped).
#[inline(always)]
fn gread(line: &[f32; GLITCH_LEN], pos: f64) -> f32 {
    let n = GLITCH_LEN as f64;
    let p = pos - (pos / n).floor() * n;          // wrap into [0, n)
    let i0 = p as usize % GLITCH_LEN;
    let i1 = (i0 + 1) % GLITCH_LEN;
    let fr = (p - p.floor()) as f32;
    line[i0] + (line[i1] - line[i0]) * fr
}
// Deterministic per-strip xorshift — golden must reproduce exactly, so this can
// never reach for a host RNG.
#[inline(always)]
fn grnd(st: &mut Strip) -> f32 {
    let mut x = st.gl_rng;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    st.gl_rng = x;
    (x >> 8) as f32 / 16777216.0
}
// GLITCH — one ring buffer, four read strategies. Every mode writes the stage
// input into the ring and reads it back somewhere else; `wet` crossfades against
// the untouched dry, so wet 0 is a bypass that still keeps the ring primed (a
// mode change then has history to work with instead of a second of silence).
fn fx_glitch(slot: usize, st: &mut Strip, buf: &mut [[f32; BLOCK]; 2], frames: usize) {
    let sr = unsafe { SR };
    let wet = st.gl_wet_c.clamp(0.0, 1.0);
    let dry = 1.0 - wet;
    let size = (st.gl_size.clamp(0.005, 0.9) as f64) * sr as f64;   // samples
    let rate = st.gl_rate.clamp(0.1, 200.0) as f64;
    let span = (GLITCH_LEN - 4) as f64;
    // SLICE-EDGE FADE. Repeat and Reverse jump the read head back at the end of
    // every slice, and a jump mid-waveform is a click — measured 21 and 24 clicks
    // per 3 s with peaks 40x a 220 Hz sine's own slew. Grain never needed this
    // (its Hann window already lands both ends at zero) and Tape-stop rides its
    // own speed ramp into silence, so only these two are enveloped. 4 ms, and
    // never more than a quarter of the slice so a short slice stays audible.
    let fade = (0.004 * sr as f64).min(size * 0.25).max(1.0);
    for i in 0..frames {
        let w = st.gl_w;
        for ch in 0..2 {
            unsafe { GBUF[slot][ch][w] = buf[ch][i]; }
        }
        let wf = w as f64;
        let mut y = [0.0f32; 2];
        match st.gl_mode {
            // ---- REPEAT: capture a slice, loop it, re-capture every `gl_rep` passes.
            1 => {
                if st.gl_pos >= size {
                    st.gl_pos -= size;
                    st.gl_rep += 1;
                    let reps = (rate.max(1.0)) as u32;              // rate doubles as "passes per capture"
                    if st.gl_rep >= reps { st.gl_rep = 0; st.gl_base = wf - size; }
                }
                if st.gl_base == 0.0 { st.gl_base = wf - size; }
                let p = st.gl_base + st.gl_pos;
                for ch in 0..2 { y[ch] = unsafe { gread(&GBUF[slot][ch], p) }; }
                let env = ((st.gl_pos / fade).min(1.0)).min(((size - st.gl_pos) / fade).max(0.0).min(1.0)) as f32;
                for ch in 0..2 { y[ch] *= env; }
                st.gl_pos += 1.0;
            }
            // ---- TAPE STOP: read rate ramps 1 → 0 across `size`, then re-arms.
            2 => {
                let period = (sr as f64 / rate.max(0.05)).max(size);
                if st.gl_ph >= period { st.gl_ph = 0.0; st.gl_base = wf; st.gl_pos = 0.0; }
                let frac = (st.gl_ph / size).min(1.0);
                let speed = 1.0 - frac;                              // 1 → 0
                let p = st.gl_base + st.gl_pos;
                for ch in 0..2 { y[ch] = unsafe { gread(&GBUF[slot][ch], p) }; }
                // Fade out with the speed so the stall lands in silence, not a DC hold.
                let g = speed as f32;
                for ch in 0..2 { y[ch] *= g; }
                st.gl_pos += speed;
                st.gl_ph += 1.0;
            }
            // ---- REVERSE: walk backwards through the last `size` seconds.
            3 => {
                if st.gl_pos >= size { st.gl_pos = 0.0; st.gl_base = wf; }
                let p = st.gl_base - st.gl_pos;
                for ch in 0..2 { y[ch] = unsafe { gread(&GBUF[slot][ch], p) }; }
                let env = ((st.gl_pos / fade).min(1.0)).min(((size - st.gl_pos) / fade).max(0.0).min(1.0)) as f32;
                for ch in 0..2 { y[ch] *= env; }
                st.gl_pos += 1.0;
            }
            // ---- GRAIN (default): overlapping windowed grains from scattered
            //      positions, each at its own pitch.
            _ => {
                let iv = (sr as f64 / rate).max(16.0);
                if st.gl_ph >= iv {
                    st.gl_ph -= iv;
                    // Claim the oldest finished slot; if all are busy this grain is dropped,
                    // which is a density ceiling rather than a glitch in the glitch.
                    let mut idx = usize::MAX;
                    for g in 0..GRAINS { if st.gl_g[g][2] <= 0.0 { idx = g; break; } }
                    if idx != usize::MAX {
                        // The lookback must cover how far this grain will TRAVEL, not
                        // just its length: a pitched-up grain reads faster than the
                        // write head advances and would overtake it mid-grain, landing
                        // on the oldest samples in the ring — a click right where the
                        // Hann window is at full gain (measured 2 per 3 s at ±24 st).
                        let semis = (grnd(st) * 2.0 - 1.0) * st.gl_pitch;
                        let inc = (2.0f32).powf(semis / 12.0);
                        let need = size * (inc.max(1.0) as f64);
                        let room = (span - need).max(0.0);
                        let back = need + (grnd(st) as f64) * (st.gl_jit.clamp(0.0, 1.0) as f64) * room;
                        st.gl_g[idx][0] = (wf - back) as f32;
                        st.gl_g[idx][1] = inc;
                        st.gl_g[idx][2] = size as f32;
                        st.gl_g[idx][3] = 0.0;
                    }
                }
                st.gl_ph += 1.0;
                for g in 0..GRAINS {
                    let len = st.gl_g[g][2];
                    if len <= 0.0 { continue; }
                    let age = st.gl_g[g][3];
                    if age >= len { st.gl_g[g][2] = 0.0; continue; }
                    // Hann window — no clicks at either edge however the grain is placed.
                    let ph = age / len;
                    let env = 0.5 - 0.5 * (core::f32::consts::TAU * ph).cos();
                    let pos = st.gl_g[g][0] as f64 + (age * st.gl_g[g][1]) as f64;
                    for ch in 0..2 { y[ch] += unsafe { gread(&GBUF[slot][ch], pos) } * env; }
                    st.gl_g[g][3] = age + 1.0;
                }
                // Overlapping Hann grains sum above unity; normalise by the count so
                // engaging the effect is not also a level jump.
                let norm = 1.0 / (GRAINS as f32).sqrt();
                for ch in 0..2 { y[ch] *= norm; }
            }
        }
        for ch in 0..2 { buf[ch][i] = buf[ch][i] * dry + y[ch] * wet; }
        st.gl_w = (w + 1) % GLITCH_LEN;
    }
}
fn fx_autopan(st: &Strip, buf: &mut [[f32; BLOCK]; 2], t: f64, frames: usize) {
    let (cd, cw) = xfade(st.ap_wet_c);
    let mut i0 = 0;
    while i0 < frames {
        let n = (frames - i0).min(CHUNK);
        let tc = t + i0 as f64 * unsafe { DT } as f64;
        let ph = tc * st.ap_rate as f64;
        let p = ((ph - ph.floor()) as f32 * TAU).sin() * st.ap_depth.clamp(0.0, 1.0);
        // wet path: mono downmix panned equal-power (AutoPanner channelCount 1)
        let xa = (p + 1.0) * 0.25 * PI;
        let (gl, gr) = (xa.cos(), xa.sin());
        for i in i0..i0 + n {
            let m = 0.5 * (buf[0][i] + buf[1][i]);
            buf[0][i] = buf[0][i] * cd + m * gl * cw;
            buf[1][i] = buf[1][i] * cd + m * gr * cw;
        }
        i0 += n;
    }
}

// ---- main entry: run every enabled strip over this block --------------------
pub(crate) fn process_strips(t_block: f64, frames: usize) {
    unsafe {
        for c in SEND.iter_mut() {
            for f in c.iter_mut().take(frames) {
                *f = 0.0;
            }
        }
        let dt = DT as f64;
        let sr = SR;
        for slot in 0..SLOTS {
            let st = &mut STRIPS[slot];
            if !st.on {
                continue;
            }
            // node-rendered voices arrive through the worklet input
            for ch in 0..2 {
                for i in 0..frames {
                    OUT[slot][ch][i] += IN_BUF[slot][ch][i];
                }
            }
            let seed = (slot as u32).wrapping_mul(0x9e3779b9) | 1;
            let mut i0 = 0;
            while i0 < frames {
                let n = (frames - i0).min(CHUNK);
                let tc = t_block + i0 as f64 * dt;
                let te = t_block + (i0 + n) as f64 * dt;
                // ---- vcf (always on; LFO carries the absolute cutoff, else the
                // static base cutoff knob). Resonance = the base Q either way. ----
                let cut = if st.vcf_mod.shape >= 0 {
                    smod_val(&st.vcf_mod, tc, seed ^ 0x1234_5678)
                } else {
                    st.vcf_cutoff
                };
                // ZDF SVF: coefficients refresh EVERY chunk (one tan — cheap
                // enough that the old 0.2% cutoff cache and its audible
                // stepping are gone; vcf_last survives only as the reset
                // sentinel other cmds poke). Q arrives in native-lowpass dB →
                // linear; k = 1/Q. Above ~8 dB the integrator tanh engages —
                // the VA resonance the df2t_sat kernel approximated.
                let g = svf_g(cut, sr);
                let k = 1.0 / 10f32.powf(st.vcf_reso / 20.0).max(1.0e-4);
                st.vcf_last = cut;
                let hot = st.vcf_reso > 8.0;
                for ch in 0..2 {
                    for i in i0..i0 + n {
                        OUT[slot][ch][i] = svf_lp(OUT[slot][ch][i], g, k, &mut st.vcf_s[ch], hot);
                    }
                }
                // ---- eq3 (engaged only while a band ≠ 0) --------------------
                if st.eq_on {
                    for ch in 0..2 {
                        for i in i0..i0 + n {
                            let x = OUT[slot][ch][i];
                            let lo = df2t(x, &st.eq_b[0], &st.eq_a[0], &mut st.eq_s[ch][0]);
                            let hm = df2t(x, &st.eq_b[1], &st.eq_a[1], &mut st.eq_s[ch][1]);
                            let mid = df2t(hm, &st.eq_b[2], &st.eq_a[2], &mut st.eq_s[ch][2]);
                            let hi = df2t(x, &st.eq_b[3], &st.eq_a[3], &mut st.eq_s[ch][3]);
                            OUT[slot][ch][i] =
                                lo * st.eq_g[0] + mid * st.eq_g[1] + hi * st.eq_g[2];
                        }
                    }
                }
                // ---- gains: vca·level, send tap, tg·gate (lerped per chunk) -
                // vca mod: Tone.LFO.connect uses connectSignal, which ZEROES
                // the gain param — so the node's real gain is the LFO value
                // ALONE, range [-depth, 0] (an inverted tremolo that passes
                // through silence each cycle, level scaled by depth). The
                // "base 1 + dip" story in 17-ambient's comment never matched
                // runtime (measured: node med 0.30×, p10 ~0 at depth 70).
                // Parity beats intent — projects were tuned on this sound.
                let vca0 = if st.vca_mod.shape >= 0 { smod_val(&st.vca_mod, tc, seed) } else { 1.0 };
                let vca1 = if st.vca_mod.shape >= 0 { smod_val(&st.vca_mod, te, seed) } else { 1.0 };
                let lv0 = st.level.value(tc);
                let lv1 = st.level.value(te);
                let rv0 = st.rev.value(tc);
                let rv1 = st.rev.value(te);
                let cut0 = tg_val(st, tc) * st.gate.value(tc) * st.ug.value(tc);
                let cut1 = tg_val(st, te) * st.gate.value(te) * st.ug.value(te);
                let inv = 1.0 / n as f32;
                for ch in 0..2 {
                    let mut k = 0.0f32;
                    for i in i0..i0 + n {
                        let f = k * inv;
                        k += 1.0;
                        let pre = OUT[slot][ch][i] * (vca0 + (vca1 - vca0) * f) * (lv0 + (lv1 - lv0) * f);
                        SEND[ch][i] += pre * (rv0 + (rv1 - rv0) * f);
                        OUT[slot][ch][i] = pre * (cut0 + (cut1 - cut0) * f);
                    }
                }
                // ---- pan: WIDTH-PRESERVING version of the node panner law.
                // The node's Tone.Panner is channelCount 1: it mono-downmixes
                // and applies the mono equal-power law — 0.707/ch at pan 0,
                // which the whole mix was calibrated around, but it COLLAPSES
                // per-voice stereo spread (measured width 0.000 — the old
                // "per-note pan doesn't survive to the bus" defect). Here the
                // MID component gets the exact node law (mono content stays
                // bit-identical at every pan), while the SIDE component passes
                // at 0.707, scaled down as |p|→1 (a hard-panned layer is a
                // point source, like the node). A deliberate improvement the
                // node engine can't have without re-levelling the whole mix:
                // spread actually spreads under core strips.
                let pv0 = (st.pan.value(tc)
                    + if st.pan_mod.shape >= 0 { smod_val(&st.pan_mod, tc, seed ^ 0xabcd) } else { 0.0 })
                .clamp(-1.0, 1.0);
                let pv1 = (st.pan.value(te)
                    + if st.pan_mod.shape >= 0 { smod_val(&st.pan_mod, te, seed ^ 0xabcd) } else { 0.0 })
                .clamp(-1.0, 1.0);
                let w0 = st.width.value(tc).clamp(0.0, 2.0);
                let w1 = st.width.value(te).clamp(0.0, 2.0);
                let mut k = 0.0f32;
                for i in i0..i0 + n {
                    let f = k * inv;
                    k += 1.0;
                    let p = pv0 + (pv1 - pv0) * f;
                    let x = (p + 1.0) * 0.25 * PI;
                    let gs = core::f32::consts::FRAC_1_SQRT_2
                        * (p.abs() * FRAC_PI_2).cos()
                        * (w0 + (w1 - w0) * f);
                    let l = OUT[slot][0][i];
                    let r = OUT[slot][1][i];
                    let m = 0.5 * (l + r);
                    let s = 0.5 * (l - r);
                    OUT[slot][0][i] = m * x.cos() + s * gs;
                    OUT[slot][1][i] = m * x.sin() - s * gs;
                }
                i0 += n;
            }
            // Glide the toggle-able gains toward their targets. One step per BLOCK
            // (2.7 ms at 48 k) with a 0.35 coefficient ≈ a 10 ms glide — inaudible
            // as a change, but enough that Wet only / Dry kill stop clicking.
            {
                let gl = |cur: &mut f32, tgt: f32| {
                    if *cur < 0.0 { *cur = tgt; } else { *cur += (tgt - *cur) * 0.08; }
                };
                gl(&mut st.dist_wet_c, st.dist_wet);
                gl(&mut st.cho_wet_c, st.cho_wet);
                gl(&mut st.pha_wet_c, st.pha_wet);
                gl(&mut st.dly_wet_c, st.dly_wet);
                gl(&mut st.ap_wet_c, st.ap_wet);
                gl(&mut st.gl_wet_c, st.gl_wet);
            }
            // ---- FX chain, processed in the strip's configurable fx_order
            // (default [0,1,2,3,4] = dist → chorus → phaser → delay → autopan,
            // byte-identical to the old fixed chain). Order lets a layer put,
            // e.g., delay BEFORE distortion.
            let order = st.fx_order;
            for k in 0..5 {
                match order[k] {
                    0 => if st.dist_on { fx_dist(&mut OUT[slot], st, frames); },
                    1 => if st.cho_on { fx_chorus(slot, st, t_block, frames); },
                    2 => if st.pha_on { fx_phaser(st, &mut OUT[slot], t_block, frames); },
                    3 => if st.dly_on { fx_delay(slot, st, frames); },
                    4 => if st.ap_on { fx_autopan(st, &mut OUT[slot], t_block, frames); },
                    _ => {}
                }
            }
            // GLITCH runs after the reorderable five — it is a destroy-the-signal
            // stage and belongs at the end of the chain, which is also why it is
            // not part of the fx_order permutation.
            if st.gl_on { fx_glitch(slot, st, &mut OUT[slot], frames); }
            // MAIN/dry output gain (layer "Wet only"): scales the post-FX direct
            // output. The reverb SEND was tapped pre-FX (above), so it survives a
            // 0 here — muting the dry while the wash rings. 1.0 = skipped/neutral.
            if st.main_c < 0.0 { st.main_c = st.main; }
            if st.main != 1.0 || st.main_c < 0.9995 {
                // PER-SAMPLE glide (~25 ms). A per-block glide leaves a staircase
                // whose first step carries most of the change — audible as a tick,
                // which is what Wet only was doing.
                for i in 0..frames {
                    st.main_c += (st.main - st.main_c) * 0.0008;
                    let g = st.main_c.clamp(0.0, 1.0);
                    for ch in 0..2 {
                        OUT[slot][ch][i] *= g;
                    }
                }
            }
        }
    }
}

// ---- C ABI ------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn in_ptr(slot: u32, ch: u32) -> *mut f32 {
    unsafe { IN_BUF[(slot as usize) % SLOTS][(ch as usize) % 2].as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn send_ptr(ch: u32) -> *mut f32 {
    unsafe { SEND[(ch as usize) % 2].as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn strip_enable(slot: u32, on: u32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        if st.on && on == 0 {
            // dropping to passthrough — stale input must not leak next enable
            reset_slot((slot as usize) % SLOTS);
        }
        st.on = on != 0;
        st.vcf_last = 0.0; // force coefficient refresh on next block
    }
}

#[no_mangle]
pub extern "C" fn strip_reset(slot: u32) {
    unsafe {
        let s = (slot as usize) % SLOTS;
        reset_slot(s);
        STRIPS[s] = STRIP0;
    }
}

/// GLITCH — one buffer stage, four read strategies.
/// mode: 0 grain · 1 repeat · 2 tape-stop · 3 reverse.
/// `size_s` = grain/slice length; `rate` = grains per second in grain mode, and
/// passes-per-capture (repeat) or re-arms per second (tape-stop) otherwise.
/// Engaging, or switching mode, clears the grain slots and read cursors so the
/// stage never starts mid-grain on stale state — the ring itself is KEPT, so the
/// effect has history to work with the instant it comes on.
#[no_mangle]
pub extern "C" fn strip_glitch(slot: u32, on: u32, mode: u32, wet: f32, size_s: f32, rate: f32, jitter: f32, pitch: f32) {
    unsafe {
        let s = (slot as usize) % SLOTS;
        let st = &mut STRIPS[s];
        let m = (mode % 4) as u8;
        if on != 0 && (!st.gl_on || st.gl_mode != m) {
            st.gl_g = [[0.0; 4]; GRAINS];
            st.gl_ph = 0.0;
            st.gl_pos = 0.0;
            st.gl_base = 0.0;
            st.gl_rep = 0;
            st.gl_rng = 0x9E3779B9 ^ ((s as u32) << 16);   // per-slot, still deterministic
        }
        st.gl_on = on != 0;
        st.gl_mode = m;
        st.gl_wet = wet.clamp(0.0, 1.0);
        st.gl_size = size_s.clamp(0.005, 0.9);
        st.gl_rate = rate.clamp(0.1, 200.0);
        st.gl_jit = jitter.clamp(0.0, 1.0);
        st.gl_pitch = pitch.clamp(0.0, 24.0);
    }
}

/// Instant set (mirrors `param.value = v`): which 0 gate, 1 level, 2 revSend, 3 pan.
#[no_mangle]
pub extern "C" fn strip_setv(slot: u32, which: u32, v: f32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        let r = match which {
            0 => &mut st.gate,
            1 => &mut st.level,
            2 => &mut st.rev,
            4 => &mut st.width,
            5 => &mut st.ug,
            _ => &mut st.pan,
        };
        *r = Ramp::at(v);
    }
}

/// Scheduled linear ramp (mirrors cancel + setValueAtTime(from) + linearRamp).
/// from < -1e5 → anchor at the current value.
#[no_mangle]
pub extern "C" fn strip_rampv(slot: u32, which: u32, t: f64, from: f32, target: f32, dur: f32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        let r = match which {
            0 => &mut st.gate,
            1 => &mut st.level,
            2 => &mut st.rev,
            4 => &mut st.width,
            5 => &mut st.ug,
            _ => &mut st.pan,
        };
        let v0 = if from < -1.0e5 { r.value(t) } else { from };
        *r = Ramp { t0: t, v0, t1: t + dur.max(0.005) as f64, v1: target };
    }
}

/// Layer mod LFO: target 0 vca, 1 vcf, 2 pan. shape -1 disengages. shape 6
/// reads a 64-point period curve (0..1) from the PARAMS staging buffer.
#[no_mangle]
pub extern "C" fn strip_mod(slot: u32, target: u32, shape: i32, hz: f32, min: f32, max: f32, smooth: u32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        let m = match target {
            0 => &mut st.vca_mod,
            1 => &mut st.vcf_mod,
            _ => &mut st.pan_mod,
        };
        m.shape = shape.min(6);
        m.hz = hz.max(0.001);
        m.min = min;
        m.max = max;
        m.smooth = smooth != 0;
        if shape == 6 {
            for (i, c) in m.curve.iter_mut().enumerate() {
                *c = PARAMS[i];
            }
        }
        if target == 1 {
            st.vcf_last = 0.0;
        }
    }
}

/// Static base cutoff (Hz) for the vcf — the hand filter knob. Held when no VCF
/// LFO is engaged; ignored (LFO wins) while it is. Clamped to a sane audio range.
#[no_mangle]
pub extern "C" fn strip_cutoff(slot: u32, hz: f32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        st.vcf_cutoff = hz.clamp(20.0, 20000.0);
        st.vcf_last = -1.0; // force a coefficient recompute next block
    }
}

/// Resonance (RBJ Q) for the vcf — applies with the static cutoff AND under an
/// LFO. Default 0.7 (Butterworth). Clamped to avoid self-oscillation blowups.
#[no_mangle]
pub extern "C" fn strip_reso(slot: u32, q: f32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        st.vcf_reso = q.clamp(0.1, 20.0);
        st.vcf_last = -1.0;
    }
}

#[no_mangle]
pub extern "C" fn strip_eq(slot: u32, low_db: f32, mid_db: f32, high_db: f32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        let want = low_db != 0.0 || mid_db != 0.0 || high_db != 0.0;
        if want && !st.eq_on {
            // engage: fresh filter state + crossover coefficients
            st.eq_s = [[[0.0; 2]; 4]; 2];
            let sr = SR;
            let (b0, a0) = nat_lp(400.0, 1.0, sr);
            let (b1, a1) = nat_hp(400.0, 1.0, sr);
            let (b2, a2) = nat_lp(2500.0, 1.0, sr);
            let (b3, a3) = nat_hp(2500.0, 1.0, sr);
            st.eq_b = [b0, b1, b2, b3];
            st.eq_a = [a0, a1, a2, a3];
        }
        st.eq_on = want;
        let db = |d: f32| (d.clamp(-24.0, 24.0) / 20.0 * core::f32::consts::LN_10).exp();
        st.eq_g = [db(low_db), db(mid_db), db(high_db)];
    }
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn strip_tg(
    slot: u32, on: u32, steps: u32, pat_lo: u32, pat_hi: u32,
    depth: f32, edge: f32, anchor: f64, bar: f32,
) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        st.tg_on = on != 0;
        st.tg_steps = steps.clamp(2, 64);
        st.tg_pat = (pat_lo as u64) | ((pat_hi as u64) << 32);
        st.tg_depth = depth.clamp(0.0, 1.0);
        st.tg_edge = edge.clamp(0.0, 0.08);
        st.tg_anchor = anchor;
        st.tg_bar = bar.max(0.1);
    }
}

#[no_mangle]
pub extern "C" fn strip_fxorder(slot: u32, a: u32, b: u32, c: u32, d: u32, e: u32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        let want = [a, b, c, d, e];
        // Validate it's a permutation of 0..5; else keep the identity order.
        let mut seen = [false; 5];
        let mut ok = true;
        for &v in want.iter() { if v > 4 || seen[v as usize] { ok = false; break; } seen[v as usize] = true; }
        st.fx_order = if ok { [a as u8, b as u8, c as u8, d as u8, e as u8] } else { [0, 1, 2, 3, 4] };
    }
}

/// `tilt` (−100..100, 0 neutral) and `focus` (0..100, 0 neutral) are the tone
/// stack — see the Strip fields. They are i32 ON PURPOSE: the JS→wasm coercion
/// turns a MISSING argument into 0 for an integer (but NaN for a float), so a
/// caller still on the old 5-arg signature keeps rendering the neutral, golden-
/// covered path instead of poisoning the buffer.
#[no_mangle]
pub extern "C" fn strip_dist(slot: u32, on: u32, amount: f32, wet: f32, mode: u32, tilt: i32, focus: i32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        let was_on = st.dist_on;
        if on != 0 && !st.dist_on { if st.dist_wet_c >= 0.0 { st.dist_wet_c = 0.0; } }   // fade in mid-playback; snap at render start
        st.dist_on = on != 0;
        if st.dist_on && !was_on {
            st.dist_dc_s = [[0.0; 2]; 2];   // stale DC estimate would step on re-engage
            st.dist_adaa_x = [0.0; 2];      // and a stale previous sample would click
            st.dist_adaa_f = [0.0; 2];
        }
        let new_k = amount.clamp(0.0, 1.0) * 100.0;
        if new_k != st.dist_k { st.dist_adaa_dirty = true; }   // F(x_prev) is for the OLD curve
        st.dist_k = new_k;
        st.dist_wet = wet.clamp(0.0, 1.0);
        if st.dist_mode != mode % 5 { st.dist_adaa_dirty = true; }
        st.dist_mode = mode % 5;   // 0 classic · 1 overdrive · 2 fuzz · 3 fold · 4 crush
        let sr = SR;
        // Focus: 30 Hz … 600 Hz high-pass, logarithmic. Q −3 dB = Butterworth
        // (0.707) — a tone control wants a gentle slope, not a resonant peak.
        let f = focus.clamp(0, 100);
        let was_foc = st.dist_foc_on;
        st.dist_foc_on = f > 0;
        if st.dist_foc_on {
            let (b, a) = nat_hp(30.0 * 20f32.powf(f as f32 / 100.0), -3.0, sr);
            st.dist_foc_b = b;
            st.dist_foc_a = a;
            if !was_foc { st.dist_foc_s = [[0.0; 2]; 2]; }   // stale state would ring on re-engage
        }
        // Tone: below 0 a lowpass sweeping 20 kHz → 400 Hz (dark), above 0 a
        // highpass sweeping 20 Hz → 2 kHz (bright). Exactly 0 bypasses.
        let t = tilt.clamp(-100, 100);
        let was_tn = st.dist_tn_on;
        st.dist_tn_on = t != 0;
        if st.dist_tn_on {
            let (b, a) = if t < 0 {
                nat_lp(400.0 * 50f32.powf(1.0 + t as f32 / 100.0), -3.0, sr)
            } else {
                nat_hp(20.0 * 100f32.powf(t as f32 / 100.0), -3.0, sr)
            };
            st.dist_tn_b = b;
            st.dist_tn_a = a;
            if !was_tn { st.dist_tn_s = [[0.0; 2]; 2]; }
        }
    }
}

#[no_mangle]
pub extern "C" fn strip_chorus(slot: u32, on: u32, wet: f32, depth: f32, rate: f32) {
    unsafe {
        let s = (slot as usize) % SLOTS;
        let st = &mut STRIPS[s];
        if on != 0 && !st.cho_on {
            for ch in 0..2 {
                for f in CBUF[s][ch].iter_mut() {
                    *f = 0.0;
                }
                for f in CFB[s][ch].iter_mut() {
                    *f = 0.0;
                }
            }
            st.cho_w = 0;
        }
        if on != 0 && !st.cho_on { if st.cho_wet_c >= 0.0 { st.cho_wet_c = 0.0; } }   // fade in mid-playback; snap at render start
        st.cho_on = on != 0;
        st.cho_wet = wet.clamp(0.0, 1.0);
        st.cho_depth = depth.clamp(0.0, 1.0);
        st.cho_rate = rate.max(0.01);
    }
}

#[no_mangle]
pub extern "C" fn strip_phaser(slot: u32, on: u32, wet: f32, octaves: f32, rate: f32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        if on != 0 && !st.pha_on {
            st.pha_s = [[[0.0; 2]; 10]; 2];
        }
        if on != 0 && !st.pha_on { if st.pha_wet_c >= 0.0 { st.pha_wet_c = 0.0; } }   // fade in mid-playback; snap at render start
        st.pha_on = on != 0;
        st.pha_wet = wet.clamp(0.0, 1.0);
        st.pha_oct = octaves.clamp(0.0, 8.0);
        st.pha_rate = rate.max(0.01);
    }
}

#[no_mangle]
pub extern "C" fn strip_delay(slot: u32, on: u32, ping: u32, wet: f32, time_s: f32, feedback: f32, spread: f32) {
    unsafe {
        let s = (slot as usize) % SLOTS;
        let st = &mut STRIPS[s];
        let want_ping = ping != 0;
        if on != 0 && (!st.dly_on || st.dly_ping != want_ping) {
            // fresh lines on engage or feedback-topology flip (node disposes+rebuilds)
            for ch in 0..2 {
                for f in DLINE[s][ch].iter_mut() {
                    *f = 0.0;
                }
                for f in DFB[s][ch].iter_mut() {
                    *f = 0.0;
                }
            }
            for f in DPRE[s].iter_mut() {
                *f = 0.0;
            }
            st.dly_w = 0;
        }
        if on != 0 && !st.dly_on { if st.dly_wet_c >= 0.0 { st.dly_wet_c = 0.0; } }   // fade in mid-playback; snap at render start
        st.dly_on = on != 0;
        st.dly_ping = want_ping;
        st.dly_wet = wet.clamp(0.0, 1.0);
        st.dly_t = time_s.clamp(0.001, (DELAY_LEN - 130) as f32 / SR);
        st.dly_fb = feedback.clamp(0.0, 0.95);
        st.dly_spread = spread.clamp(0.0, 1.0);
    }
}

/// Layer "Wet only": main (dry) output gain, 0..1. 1.0 = neutral. See Strip.main.
#[no_mangle]
pub extern "C" fn strip_mainout(slot: u32, gain: f32) {
    unsafe {
        STRIPS[(slot as usize) % SLOTS].main = gain.clamp(0.0, 1.0);
    }
}

#[no_mangle]
pub extern "C" fn strip_autopan(slot: u32, on: u32, wet: f32, depth: f32, rate: f32) {
    unsafe {
        let st = &mut STRIPS[(slot as usize) % SLOTS];
        if on != 0 && !st.ap_on { if st.ap_wet_c >= 0.0 { st.ap_wet_c = 0.0; } }   // fade in mid-playback; snap at render start
        st.ap_on = on != 0;
        st.ap_wet = wet.clamp(0.0, 1.0);
        st.ap_depth = depth.clamp(0.0, 1.0);
        st.ap_rate = rate.max(0.01);
    }
}
