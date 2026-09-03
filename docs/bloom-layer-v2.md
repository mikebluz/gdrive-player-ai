# Bloom Layer Model v2

Status: **slices 1–4 shipped (2026-09-01)** — the spine plays, has a card, Write is a
door, and there are three ways to fill a recorded part.
Built apart from v1 rather than migrated onto it. The two coexist.

---

## The model

> **A layer is an instrument and a part.**
> **A part is Live or Recorded. Write is the door between them.**

That is the whole thing. There is no `type`, no `generator`, no `role`.
A layer's identity is its **name**.

### The instrument

What makes the sound: `synth` · `kit` · `sample` · `speech`, plus its tone and
envelope. Slice 1 implements `synth` only.

### The part

Anything that can answer one question:

```
notesFor(layer, { E, cfg, key, cycleStart, cycleSec })  →  [{ at, freq, durMs }]
```

**A part is an interface, not a data shape.** Two kinds implement it:

- **Live** — the notes do not exist until playback; they are resolved from rules
  against the current context (key, chord, take). A key or chord change *moves*
  a live part, because it is re-resolved.
- **Recorded** — the notes already exist and are read back. A key change cannot
  re-resolve them, so it must **transpose** them instead.

"Authored" and "captured" are not separate kinds — a phrase you drew and a phrase
Write captured behave identically at play time. Where the notes came from is
provenance, not behaviour.

### Why Live/Recorded is the right axis

It predicts engine behaviour that in v1 looks like unrelated special cases:

| v1 special case | v2 explanation |
|---|---|
| A separate transposition path for a frozen loop under a section key change | Recorded parts transpose; live parts re-resolve |
| Placement (register/range/proximity) is inert on a mapped or composed phrase | Those are live-pitch controls |
| Variance applies per realization, but a frozen loop's is baked in | Variance is a live-stage treatment |
| The freeze gate short-circuits the emitter entirely | Recorded takes precedence over Live by definition |
| `_ambEuclidDeterministic` needs per-type special cases | It is really asking "is this part already effectively Recorded?" |

And **Write/Evolve is not a feature — it is the Live → Recorded transition.**
Thaw is the inverse.

### The Live pipeline

Three stages, each a pure function of one piece:

```
RHYTHM →  where the onsets fall inside one cycle   (pulse · euclid · chance · drawn)
PITCH  →  what each onset plays                    (chord · fixed · stack · anchor
                                                    walk · series · chance · drawn)
SHAPE  →  how many notes, how long each            (voices · length)
```

with **CYCLE** stating how long one pass is. Checked against every v1 behaviour:
a Pad is *every-unit onsets → chord voicing → long*; Drums is *euclid onsets → no
pitch → short, per lane*; a series Arp is *fixed-rate onsets → next chord tone*;
a pedal point is *one onset per progression cycle → scored note → fills it*.
None needed a special case.

### Not part of the assembly

Key/harmony, variance, placement, schedule gates and FX/mix apply to **every**
layer regardless of its pieces. They are treatments, not constituents — which is
what keeps the card from becoming the wall of pickers that killed
`bloom-composable-layers.md`.

---

## Isolation

- **Store**: `cfg.layers`, a new array beside `cfg.extras`. Absent → not one line
  of v2 runs. Verified: golden 82/82, arch 62/62, partseq 231, harness ✓.
- **Code**: `js/bloops/18-layer-v2.js`, loaded after 17.
- **Keys**: `v2:<id>`, a namespace nothing else uses.
- **One seam**: `window._v2Tick(E, now, horizon, lead, space, cfg)`, called once
  per tick from `_ambTick`.

## What is cribbed, not rebuilt

v2 only decides *what notes, when*. It installs the same capture sink the v1
window branch does — which is what stamps `_ambEmitKey` inside `playNote` — so
the playback gates, the rolling capture, the WASM core, the master chain, the
native broadcast and the offline bounce all see a v2 note exactly as they see a
v1 one (verified: pass 1 of a bounce reaches `_v2Tick` 34 times).

**CORRECTION (2026-09-01): the PER-LAYER CHAIN is NOT among them.** An earlier
version of this section claimed the chain, mixer and FX were reused. They are
not: `_ambSyncMods` enumerates v1 layers only, so no chain is built for a `v2:`
key and `_ambLayerDest('v2:1')` returns `undefined` — measured side by side with
a v1 motif, which gets both. A v2 note therefore takes playNote's DEFAULT routing
and bypasses `vcf → vca → levelGain → gate → pan → FX → bus` entirely. That one
gap is what makes FX, reverb sends, buses, spatialize, the trance gate, the unit
gate and a continuous Level fader all absent at once — Level currently works only
as a per-note volume. It is backlog item 1 for that reason. Harmony is resolved by asking `_ambProgSoundAt` for the **sounding**
chord rather than re-deriving it (rendering pitch classes without a sounding-space
resolver is the documented salt-plan trap).

---

## Slice 1 — verified

A live pad (`pulse(1)` + `chord(3)`), a live pulse line (`euclid(3,8)` + `fixed`)
and a recorded part (three stored notes) in one area under a C/F/G progression:

- The interface answers identically for both kinds.
- The two live parts **follow the changes** (bass root 36 → 41 on C → F).
- The recorded part **plays its stored notes** regardless — the polymorphism
  doing real work.
- `_ambEmitKey` is stamped `v2:1/2/3`, so gates, capture and routing all see them.

## Slice 2 — the card (shipped)

**Vocabulary now 3 rhythms x 4 pitches:** `pulse` · `euclid` · `chance`, and
`chord` · `stack` · `fixed` · `walk`. The `chance` rhythm and `walk` pitch roll an
ISOLATED seeded RNG keyed on (layer, cycle, step) — never `_ambRand`'s shared
stream — so a v2 layer can never shift a v1 layer's draws.

**The gate is the design claim made concrete.** Nothing asks "what kind of layer
is this". Every control declares the piece values it belongs to
(`data-v2when="kind:live;rhythm:euclid,chance"`) and one pass shows or hides it.
Verified by driving the real controls: euclid shows Steps/Pulses/Rotate; chance
swaps to Steps/Chance; walk drops Voices and adds Note/Span; recorded hides the
entire live block. A control's relevance is *computed*, not listed per type —
which is the whole reason there is no type.

**Render is signature-guarded.** An innerHTML rewrite destroys the control under
the finger and kills a slider drag after one pixel (the documented trap — it cost
a round on the Groove Humanize fader). `render` rebuilds only when the SET of
cards changes; a value edit re-applies the gate in place. Verified: the slider
survives its own input, a second edit on the same node lands, and only a
structural change (part kind, on/off, delete) rebuilds.

**Door:** Add layer → "Build your own → Layer". The v1 `gen`/`role` scaffolding is
retired from both doors (it still loads) — v2 supersedes it.

**Seams: two.** `_v2Tick` in the tick, and `_v2Render` in `_ambSyncLayerUnits` (so
cards repaint while STOPPED — the viz rAF does not run then, the documented
invisible-while-stopped trap).

## Slice 3 — Write, the door (shipped)

**Write is not a feature here; it is the Live → Recorded transition**, and the
part interface makes it almost nothing:

```
capture = ask the live part what it plays for one cycle, and keep the answer
release = play the rules again
```

Because a live part is a pure function of (cycle index, context), capturing is
deterministic and needs **no engine involvement** — no rolling capture buffer, no
freeze gate, no thaw handoff, and none of the seam bugs that machinery has
accumulated in v1. `V2.capture(E, L)` / `V2.release(E, L)`, offered from the
layer's ⋯ menu as *❄ Capture — keep what it plays* / *⚡ Release — back to live*.

**BOTH HALVES ARE ALWAYS NORMALIZED**, whichever is active: a captured layer
keeps its live spec so it can be released, and a live layer keeps its notes so a
release is not a one-way loss. Coercing only the active branch (the first cut)
would have silently dropped the other on the next normalize and made the door
one-way.

Capture takes the cycle that is **sounding now**, so it keeps what you just
heard rather than an unrelated realization; stopped, it takes cycle 0.

Verified end to end under a C → F progression: live plays 60/64/67 then
65/69/72 (it follows the changes); capture stores exactly the 3 notes that were
sounding; recorded then plays 60/64/67 on *every* cycle regardless of the chord;
both halves survive a normalize round trip; release restores the live behaviour
with the notes still present. Driven through the ⋯ menu in `npm run test:ui`,
not through the API.

**The door is ON THE CARD, not only in the ⋯ menu.** Selecting "Recorded" from
the Part dropdown on a layer with no notes was a silent dead end — nothing
authors notes, so the part played nothing and said nothing (reported, and a
textbook rule-6 failure: the state was reachable, the way to fill it was not).
The Part group now carries a Capture row that works from EITHER kind, reading
through the retained live spec, plus an explicit empty state when a recorded part
holds nothing.

## Slice 4 — three ways to fill a recorded part (shipped)

Capture alone was too narrow a door: it can only keep what the *rules* already
produce, so anything you wanted to state note by note was out of reach. Both of
the surfaces that could state it **already existed in v1** — what was missing was
a way to reach them from a v2 layer.

| Door | Where it comes from | What it produces |
|---|---|---|
| ❄ The live part | the layer's own rules, frozen | a cycle of whatever it was playing |
| ✎ Pattern grid | the euclid generator, made editable | onsets you place by hand |
| ♪ A phrase | the compose grid, via the saved bank | notes, times and lengths as written |

**The Pattern grid is the Euclid option's own surface — `drawn` is not a choice.**
It shipped first as a fourth Rhythm entry ("Drawn"), which meant a default card
AND a Euclid card both showed no grid at all: reported at once as *"where is the
layer grid"*. That is the same rule-6 failure as the recorded-part dead end, and
the doc claimed "not a second thing" while the UI shipped it as exactly that.

Now: picking **Pattern** (stored value `euclid`) shows the grid, generated live
from Pulses/Steps/Rotate. **The first cell tap SNAPSHOTS that generated pattern**
and becomes an override (`kind: 'drawn'`, internal state) — v1's exact idiom;
without the snapshot the tap would start from an empty grid and read as erasing
the pattern. A **↻** appears only once there is an edit to undo, and the knobs
redraw an edited grid, which is v1's contract, stated in the hint so it can never
read as data loss. An empty grid says it is silent, in amber: silence and a broken
control are otherwise indistinguishable.

Two things this arrangement requires. The `<select>` has no `drawn` option, and a
select whose value matches no option does **not** render empty — it silently falls
back to the FIRST one, so an edited pattern's card would claim "Pulse". Both the
markup and `applyGate` point it at the generator. And a cell tap toggles one cell
IN PLACE (a rebuild detaches the cell under the finger), so DOM and model must be
compared: a check that reads only the DOM cannot tell a correct edit from one that
quietly rewrote the rest of the row.

**A phrase is read, not re-authored.** A phrase step advances
`subdivision × duration` beats (`_ambGridStepAdv`'s rule), which makes the
conversion exact rather than approximate: walk the steps accumulating beats, and
every note's position is its own offset over the total. The CYCLE takes the
phrase's own length, snapped to the 1/48-bar grid (an inexact length walks off the
changes — the documented fractional-cadence rule). Two step shapes have to survive
the trip or the import is silently lossy: a **rest** (`freq: null`) contributes
time and no note, and a **chord** step carries `chord: [{freq}]` instead of a
single `freq`. Verified against a phrase containing both: C4 · rest · G4+B4 with
durations 1·1·2 imports as 3 notes at 0 / 0.5 / 0.5 over exactly 0.5 bars, and
plays back with the phrase's own articulation (250 / 250 / 500 ms).

`part.from` records which phrase it came from and is shown on the card. It is
**provenance, never behaviour** — a phrase you adopted and a cycle you captured are
the same part, which is the whole point of the Live/Recorded axis.

Every door leaves the live spec intact, so Release still works after adopting.
Gate: `npm run test:ui`, now **43 checks**, poison-verified in five places — the
grid hidden behind its own mode (5 checks fail, including a 0x0 rect), a tap that
starts from a blank grid, a select left pointing at a value it has no option for,
rests losing their time, and a chord losing a note. Each fails exactly the checks
that name it.

**NOT here yet: a multi-lane step sequencer.** v1's drum lanes are 8 lanes of one
kit; v2 has one row because it has one `synth` instrument. That arrives with the
`kit` instrument, backlog item 1 — it is a missing instrument, not a missing grid.

## Slice 5 — the signal chain, and the silence it uncovered (shipped)

**The chain.** `_ambSyncMods` enumerated v1 layers only, so no chain existed for a
`v2:` key and `_ambLayerDest` returned `undefined`. Fixed at three points, and the
design follows from this document's own position that **treatments are not
constituents**: Level, FX, bus, stereo and the schedule gates are the SAME fields
v1 uses, at the top level of the layer, coerced by v1's own normalizers. So one
resolver does it — `_ambLayerByKey` learns `v2:<id>`, `_ambWantSet` and
`_ambMixerLayers` learn `cfg.layers`, and the chain builder, the mixer, the
scheduler and the level mirror all reach a v2 layer with no change in any of them.

Measured after: a core strip is acquired (slot 0), `_ambLayerDest` returns a node,
Level sweeps the whole layer (20 → 100 is **8.4x** at the master tap, and the
gain node reads 0/1.207/4 at 0/70/100), a reverb send lifts the mix
0.124 → 0.203, and the layer has a mixer fader and a scheduler lane under its own
name. Level's two controls stay in sync both ways.

**AND THE DEFAULT TONE HAD BEEN SILENT SINCE SLICE 1.** `instrument.tone: ''`
means "whatever the grid uses"; v1 resolves that through `_ambLayerType` before
playNote ever sees it (a v1 motif with an empty tone sends `type: 'sawtooth'`),
and v2 passed the empty string straight through. Measured at the master tap:
tone `''` → peak **0.0000**, `'sine'` → **0.8428**. Every check across four slices
counted playNote CALLS or inspected the note list, and not one of them listened —
so a layer that emitted 12 notes per cycle and made no sound passed them all.

The rig that found it needed a **positive control** (a bare oscillator into the
same tap read 0.5012, so the zeros were real) and a **v1 control** (a motif in the
same rig read 0.2156, so it was v2's bug and not headless audio). It also killed a
plausible wrong answer cheaply: v2 does NOT kill the core worklet — v1 played
fine straight after — and v2 was silent with core strips off AND core voices off,
which is what pointed past routing at the note params themselves.

Staging was wrong in the same place: v1's emitters stage LOW (a motif at ×0.32 of
the cell) and let the Level fader lift, while v2 staged at 70 — **2.19x hotter per
note**, measured on a single note at the same tone, length and level. Now 32,
matching the motif, so a v2 layer and a v1 layer at the same Level sit together.

Gate: `npm run test:ui` is **58 checks**. Two of them assert what reaches
playNote — a resolved voice and v1's staging — which is the check whose absence
hid all of the above; poisoned, it reports `n:12, types:[""]` in one line.

## Slice 6 — Mix & FX, and the sweeps (shipped)

**The card has a Mix & FX group**: Reverb send, Width, Stereo mode, Tone
(cutoff), Delay (mix/time/feedback), Drive (mix/amount), Chorus. These are v1's
OWN fields, written **FLAT on the layer** — `_ambNormalizeFx` does `host.cutoff`,
`host.revSend`, `host.delay`, and `_ambApplyLayerFx` reads `lc.delay` straight off
it. There is no `L.fx` container; assuming one is what the first cut of this group
got wrong. Changes are pushed live (`_ambApplyLayerFx` + `_ambApplyLayerPan`)
rather than waiting for a re-anchor, because these are chain params, not note
material.

Measured audibly, not by field value: **delay fills the gaps between short notes
6.8x** (gap energy 0.0014 → 0.0095), **drive raises level 3x**, and **cutoff 8
takes the layer to 0.01x** — the filter closing. Every one of these was inert
before the chain existed.

**The sweeps.** Building the chain fixed the area-advance depart for free: that
path iterates `Object.keys(E.mod)`, so a v2 layer now departs like any other.
And **`E._v2Phase` joined `_ambResetClocks`** beside `E.clocks`/`runPhase`/
`bassPhase`/`arpState` — its keys are `v2:<id>` and ids are per-AREA, so without
it an area advance left area B's layer 1 inheriting area A's anchor, and a
stop→play reused a stale ABSOLUTE time (v1's documented "starts in the middle on
the second play"). Verified: phase resets with the v1 clocks, and two plays
anchor at 3.88 then 4.69 rather than reusing the first.

## Slice 7 — the kit instrument, and the multi-lane sequencer (shipped)

**`instrument.voice` is an enum now**: `synth` | `kit`. That is the whole reason
v2 had one row where v1 has eight — v1's drum lanes are 8 lanes of ONE KIT, so
the multi-lane sequencer was a missing INSTRUMENT, not a missing grid.

In the model it falls out rather than being bolted on: **a kit is eight parallel
rhythms with a fixed pitch each.** The RHYTHM stage gains a lane dimension
(`part.rhythm.lanes`, 8 rows coerced to `steps` exactly as `cells` is), and the
PITCH stage is answered by the lane itself — a drum's note IS its lane — which is
why the card's pitch pieces disappear under `voice:kit` and the gate needed only
one new token (`voice`).

Lane order, semitones and names are READ FROM v1 (`_AMB_VDRUM` /
`_AMB_DRUM_NAMES`) rather than duplicated, so a v2 kit plays the same drums a v1
Beat does: Kick · Snare · Hat · Clap · Open hat · Tom · Crash · Perc.

**Both realizations, because they take different players** — the documented
"audit the whole family" rule, and the exact shape that once made a v1 hang burst
silent: a **synth kit** is a recipe played by `_ambPlaySynthDrum` (which builds
its own params and takes a LANE INDEX), a **sample kit** is an ordinary note on
`sample:<id>` at `36 + _AMB_VDRUM[lane]`. Verified separately, and asserted so
that fixing one arm cannot hide the other: synth → 0 notes / N drums on lanes
0,1; tr808 → N `sample:tr808` notes / 0 drums.

**AND A V1 SWEEP CLAIMED THE LANES.** `_ambRefreshEuclidGrids` does
`host.querySelectorAll('.ambient-euclid-grid')` and **rewrites innerHTML**; v2
reuses that chrome, so the sweep replaced a kit's 8 drum lanes with a v1 euclid
grid — measured 8 rows → 4 on the very next `_ambSyncControls`. Three of my own
changes conspired: reusing the class, adding `data-phkey` (for the Level mirror,
which is how the sweep finds a key), and teaching `_ambLayerByKey` to resolve
`v2:`. Guarded with the same `.v2-layer` skip the `.ambient-collapse` and
`.ambient-grp-head` sweeps already carry — applied to all THREE euclid sweeps,
not just the one that bit.

Gate: **70 checks**, poison-verified — removing the sweep guard collapses the
lanes to 1 row and fails 4 checks; routing a synth kit down the sample arm fails
exactly the synth-path check.

## Slice 8 — the pitch vocabulary (shipped)

Three more pitch kinds, all pure functions of the pieces:

- **`anchor` — the pedal point.** One note held against the whole progression,
  scored by v1's own `_ambAnchorPc` (the chord-tone / key-colour tally with the
  tonic bias), so v2 picks the same note v1 would. **This is where the promise
  made when Drone and Pedal were retired as TYPES is kept** — measured over six
  cycles of C/F/G it yields exactly ONE pitch class (0 = C, the textbook
  I-pedal), matching `_ambAnchorPc`. Falls back to the key root with no
  progression.
- **`series` — the arp sweep.** Consecutive source tones, one per onset,
  `up` / `down` / `up & down`. Deterministic in the ONSET INDEX rather than a
  seed — that is what makes it a sweep and not a scatter, and it is why `idx`
  had to be threaded into `pitchesAt`. It re-resolves per chord, so it follows
  the changes: `60 64 67 72` over C, `65 69 72 77` over F.
- **`chance`** — one tone drawn per onset from an ISOLATED seeded stream, so it
  never shifts a v1 layer's draws and replays identically for a take.

`anchor` and `chance` take no parameters — the note is scored or drawn, which is
the point; `series` adds a Direction. Gate: **74 checks**, poison-verified —
making anchor re-pick per chord reads `anchorPcs: [0,5,7]` instead of `[0]`, and
zeroing the sweep index collapses it to a repeated root.

Still missing from the pipeline: **`drawn` pitch** (explicit notes per step). That
one is an editor, not a function — the melodic grid's note strip — so it belongs
with a note-level surface rather than here.

## Slice 9 — the voice list, and the bus (shipped)

**THE "SAMPLE INSTRUMENT" WAS NEVER AN ENGINE GAP — it was a broken picker.**
`_ambToneOptions()` returns an ARRAY of `{value,label}`; v2's `toneOptions` tested
`typeof opts === 'string'` before using it, so the check never passed and it fell
through to an eight-item fallback of basic waveforms. **Since slice 1, a v2 layer
could not be anything but a plain oscillator** — measured 8 options against v1's
**283**, with not one sample among them. Fixed by building the option HTML from
the array, as v1 does: 214 samples and 42 Design patches are now available, and a
sample plays through the ordinary note path with nothing else required
(`sample:piano` picked → stored → emitted → sounding at peak 0.234).

Worth recording precisely, because the first poison of this check PASSED: the
extra argument the old code also passed was harmless (JS ignores it). The bug was
entirely the ARRAY-AS-STRING test, and that is what the gate now poisons.

**Bus routing** is on the card — the only way a Bloom layer reaches the shared FX
returns. A bus change REBUILDS the chain rather than pushing live, because the
output is resolved through `_E.busNode(L)` at BUILD time (v1's documented rule);
poisoned, the chain identity does not change and the check fails.

Gate: **77 checks**.

## Slice 10 — the trance gate (shipped)

**The engine already drove this for v2 the moment the chain existed.**
`_ambScheduleStochastic` walks `_E.mod` — the chains — and `_ambScheduleTg`
resolves its layer through `_ambLayerByKey`, so once slice 5 gave v2 both, the
bar-synced gate worked with no engine change at all: measured on a sustained
chord, **quiet frames at 0.00000 against 0.288 loud**, versus a 1.2x ratio with
the gate off. This slice is a surface over working machinery.

On the card: a Gate toggle, then Steps / Depth / Edge and a step pattern once it
is on. **A BUTTON, not a select** — a `<select>` writes a STRING, `'0'` is
truthy, and `_ambNormalizeFx` does `tg.on = tg.on ? 1 : 0`, so an "Off" pick
would have switched the gate ON (poisoned: it never turns off).

**AND THE FIRST CUT KEPT A SECOND COPY OF A RULE V1 ALREADY OWNS.**
`_ambNormalizeFx` ALREADY resizes `tg.pattern` to `tg.steps` (pads with 1,
truncates) on the next getCfg; v2 was doing the same thing with a different pad
value, which is exactly how two copies of one rule come to disagree. Deleted —
v2 rebuilds the ROW and lets normalize own the store. **The tell was a poison
that PASSED**: removing v2's resize changed nothing, because something else was
already doing it.

Gate: **81 checks**.

## Slice 11 — spatialize, phaser, auto-pan (shipped)

**Spatialize worked already, for the same reason the trance gate did.**
`_ambSpatApply` lives inside `_ambCapSink` — the sink v2 installs per layer — and
resolves through `_ambLayerByKey`, so once the chain existed it only lacked a
surface and a call to v1's coercer. Measured: pan `null` on every note when off;
fan gives `0 30 -30 60 -60 …`, sweep gives `-60 -30 0 30 60 …`. Absent by
default, because `_ambNormalizeSpat` DELETES the field unless it is already an
object — `{}` is the whole opt-in.

Phaser and auto-pan joined the FX rows.

**THE RECURRING LESSON, THIRD TIME IN TWO SLICES: v1's normalizers own the
defaults, and v2 must not keep a second copy.** The first cut seeded
`{on:0, mode:'fan', width:60, steps:5}` on first engage — and a poison that
replaced it with a bare `{on:0}` PASSED, because `_ambNormalizeSpat` backfills
exactly those values on the next getCfg. Same shape as the `tg.pattern` resize
one slice earlier. **A poison that passes is the signal**: either the cause is
not what you wrote down, or something else already owns the rule. Both happened
today. With the duplicate removed, removing the normalize CALL now fails two
checks — the teeth are on the real owner.

Gate: **85 checks**.

## Slice 12 — reading a v1 layer as pieces (shipped)

The question that decides whether v2 could ever replace v1. It is two jobs, and
only one of them is interesting:

**Treatments copy 1:1.** They are already the SAME fields — the payoff of the
slice-5 decision that treatments are not constituents. Copied by an explicit
LIST, never a blind spread: a spread drags v1's generation fields (`density`,
`restProb`, `notes`…) onto a v2 layer where they mean nothing and normalize would
keep them for ever (poisoned: `density,notes` cross over).

**Pieces are DERIVED, per type** — the real translation, and the test of whether
the six-piece spine covers what v1 does. It does, for all seven:

| v1 | v2 pieces |
|---|---|
| Bed / Drone | `pulse(1)` → `chord(density)` |
| Motif / Riff | `pulse(density)` → `walk(range)` |
| Bass | `euclid(pulses, steps, rotate)` → `fixed` |
| Beat | **instrument `kit`** + lanes, or its euclid pattern on the kick |
| Arp | `pulse(steps)` → `series(dir)` |
| Pedal | `pulse(1)` → `anchor` |
| Texture | `chance(fill)` → `chord` |

**THE CYCLE IS `L1.unit`, AND NOTHING ELSE.** Every v1 layer carries a bar RATIO
(`{mode:'sync', ref:'bar', num, den}` — bed 2/1, motif 2/3, arp 3/1) which IS
v2's `part.bars`: no clock, no conversion. Reaching for `_ambNaturalUnitSec`
instead was wrong twice over — its signature is not `(L, type)`, so it returned
0.05 or threw, and every imported cycle collapsed to the 0.125 floor.

**Import is NON-DESTRUCTIVE**: it adds a v2 layer and leaves the original alone,
so the two can be compared side by side. `part.from` records the source key.

Door: **＋ Add layer → Build your own → "From a layer…"**, then pick one — driven
through the real menu in the gate, not the API. Verified end to end: the picker
lists `Bass · bass:1`, choosing it yields a v2 layer with `rhythm: euclid`,
`from: 'bass:1'`, a 390px card, and the v1 bass still present.

**One leak found and closed:** `_ambNormalizeFx` — which v2 calls for the shared
FX treatments — also backfills v1's WRITE store, and v2 has no such concept
(Live/Recorded IS its write model). Left in place it reads as if the layer should
freeze. `delete L.write` in v2's normalize.

Gate: **91 checks**.

## Slice 13 — Performance (shipped)

The gap the import made concrete: an imported layer was a skeleton because v2 had
no variance. Closed by routing v2's note params through **v1's own shared params
builder, `_ambApplyAdsr`** — one call, six behaviours, v1's exact semantics
instead of six reimplementations: humanize, velocity jitter, the envelope, fine
detune, glide and voiceTrim.

v2 keeps its envelope under `instrument`, so it passes a **shim**. Two properties
of that shim are load-bearing: it is **cached and STABLE per layer** (because
`_ambApplyAdsr` hangs `glideLayer` off it and playNote tracks the previous
frequency there — a fresh object per note silently disables portamento), and it
is **non-enumerable**, so `persistWorkspace` — which does serialise underscore
fields — never sees it.

**AND v2 WAS NEVER STAMPING `_ambKeyTime`.** Every v1 emitter sets it to the
note's time before resolving; v2 did not, and two things were quietly wrong:

- `_ambVelJitter01` seeds off it, so **Vel var never replayed for a take** — with
  a constant stamp its internal sequence counter simply keeps counting (measured:
  three runs of one take, three different volume streams).
- `_ambKeyRootPc` / `_ambPartKeyNow` / `_ambSectionKeyNow` resolve the key **in
  force at that note** from it — so without the stamp v2 read the key at the
  AUDIO CLOCK, which is wrong either side of a section or part key change. That
  one was a live correctness bug nobody had reported yet.

Verified: same take replays exactly, a new take differs, humanize deliberately
does NOT replay and stays inside v1's ±20 ms, glide reaches playNote on a stable
object, and −6 dB of voice trim halves the staging (32 → 16).

Gate: **97 checks**, poison-verified — dropping the stamp breaks the replay,
un-caching the shim breaks glide.

## Slice 14 — Variance, and the import becomes a clone (shipped)

**Rests · Ghosts · Len vary** — and in the v2 model they are TREATMENTS, not
pieces: they apply whatever the rhythm and pitch are, which is why the same three
work on a kit. Every draw is an ISOLATED seeded stream keyed on (layer, cycle,
onset), so a take replays exactly and v1's shared RNG is never touched.

Measured: rests at 50% take 16 onsets to 11 and replay identically; ghosts add
quieter hits (volume 13 against 32 — **a ghost at full level is just a doubled
note**, so the quieter level IS the feature); len vary scatters durations
68–159 ms. A ghost sits a third of the span after its onset so it reads as a flam
rather than a second onset; on a kit it sits at half the step, where a drum ghost
belongs.

**The import is now close to a clone.** `_V2_TREATMENTS` carries the whole
Performance/Variance family — `humanize`, `velVar`, `fine`, `portamento`,
`voiceTrim`, `restProb`, `ghosts`, `lenVary` — so a converted v1 layer keeps its
feel and not just its shape. What it still leaves behind is v1's PER-TYPE
generation variance (`rhythmVar`, `pitchVar`) and placement beyond Register.

Worth recording: the gate caught its own staleness here. `restProb` was on the
import check's "v1-only fields that must not leak" list, and became a legitimate
v2 treatment in this slice — so a green suite went red on a check that was
describing the old model. The right fix was to invert it: assert the family IS
carried.

Gate: **102 checks**, poison-verified — ghosts at full level and an unseeded
draw each fail exactly the check that names them.

## Slice 15 — the four schedule gates (shipped)

All four of v1's scheduling axes now apply to a v2 layer. Two needed wiring and
two already worked, and telling those apart took more measurement than the fix:

- **`when`** (which iterations play) and **`chordMask`** (which chords) are
  EMITTER-side in v1, so v2 has to ask — through `_ambCondFires` and
  `_ambChordGateOK`, v1's own helpers, never a second implementation. `when` is
  per CYCLE (`c` is exactly the iteration index it wants); `chordMask` is per
  NOTE, because one cycle can span several chords.
- **`unitGate`** and **`iterGate`** ride the playNote hook and already applied.

**THE UNIT MIRROR.** v1 indexes the unit schedule by a layer's `unit` — a bar
RATIO — and v2's cycle is `part.bars`. `normLayer` now derives the mirror on every
normalize (the same doctrine as the sections' bars mirror, and it cannot go stale
because normalize runs on every getCfg): 0.5 → 1/2, 0.75 → 3/4, 1.5 → 3/2, 3 →
3/1. It is load-bearing — poisoned away, `_ambUnitLaneBars` answers **0.03125
bars**, so the schedule addresses a thirty-second of a bar and silences
everything. It also makes a v2 layer legible to any v1 code that reads `unit`.

**FOUR PROBES READ THIS GATE AS BROKEN, AND ALL FOUR WERE MY FIXTURE.** Counting
at a playNote wrapper misses `unitGate`/`iterGate` entirely — the gate drops the
note INSIDE playNote, so a wrapper counts dropped notes as played (the documented
trap). And the store shape was invented rather than read: **`div` is clamped to a
minimum of 2, and a slot's value is a MASK ARRAY, not a number**, so
`{div:1, slots:{0:0}}` is silently a no-op. Use `_ambUnitGateSet` — the setter
knows the shape. With both corrected: 16/16 skipped fully closed, 8/16 with half
each unit off, and an all-on mask prunes itself away.

Gate: **109 checks**, poison-verified on the mirror and on `_ambCondFires`.

## Slice 16 — the gates get a surface (shipped)

Slice 15 made all four gates APPLY; they were still uneditable, which is the
documented "unreachable forever" failure — an engine-read store with no way to
touch it. Closed by joining v1's own enumerators rather than growing a second
surface:

- **`_ambChordMatrixRows`** now lists v2 layers, so the ⌗ Matrix and ▦ Passes
  edit a v2 layer's `chordMask` and `saltMask` beside every v1 layer, under its
  own name.
- **`_ambPartSeqLayers`** now includes `cfg.layers`, so v2 joins the per-layer
  normalize sweep (`partSeqs`, per-layer salt) — the documented "a new store must
  join EVERY sweep" rule, which this repo has paid for three times.
- **`when`** gets a CARD control, because it has no home in the matrices: v1
  edits it in the Scheduler's per-type Advanced block, which renders controls v2
  has no part in. The values are `_ambCondFires`' own vocabulary ('always',
  '1st', or a binary string), offered as Every cycle / Every other / Every 3rd /
  Every 4th / 2 on 2 off / First time only. Verified it gates: 16 → 8.

Gate: **113 checks**.

## Slice 17 — drawn pitch: the melodic step sequencer (shipped)

The eighth and last pitch kind, and the one that turns the pattern grid into
something you can write a LINE on. A note row sits under the grid — v1's own
melodic-euclid chrome (`.ambient-euclid-notes` / `.ambient-euclid-notelbl`, the
same `--eucols` so a label sits under its step) — and tapping a label raises that
step's note.

**It stores DEGREES, not absolute notes**, which is the whole reason a drawn line
still works under a progression: degree 3 is G over C and C over F. Measured, one
line across two chords: `67 60 60 60` then `72 65 65 65`. Poisoned to absolute
notes it reads `62 60 60 60` under both — the same four notes regardless of the
harmony, which is exactly what a step sequencer must not do here.

**The label asks the EMITTER what it will play** rather than formatting the
stored degree, so it can never promise a note the engine will not sound; poisoned
to read the raw degree it prints `3` where the layer plays `G4`.

**A silent step's label is DISABLED.** Editing the note of a step that does not
sound stores a value with no audible effect — a dead control, and one my own
first probe fell into by tapping a silent step and reading the result as a bug.
The cell above is what turns a step on.

Also in this slice: the step INDEX for a drawn pitch is the CELL index, not the
onset ordinal — with a sparse rhythm, step 5 must keep step 5's note even when it
is only the second onset.

**The pitch vocabulary is complete: 8 of 8.**

Gate: **117 checks**.

## Slice 18 — Glitch, Wet only, and two things checked rather than assumed (shipped)

**Glitch** (mix + mode, mirrored from `_AMB_GLITCH_MODES`) and **Wet only** finish
the FX set. Glitch is CORE-ONLY — a granulator has no sane Web Audio node build,
so with strips off the stage is simply absent and the hint says so rather than
failing silently, exactly as v1's own card does. Wet only is a BUTTON for the
trance gate's reason: a `<select>` writes a STRING and `'0'` is truthy. Measured:
the dry path goes 0.305 → 0 with no send up, which is v1's behaviour too (it
mutes the direct output and leaves the parallel wash).

**Per-FX Dry kill is deliberately NOT surfaced.** It is one checkbox per effect —
six more rows for a switch whose common intent (remove the dry) is exactly what
the layer-level Wet only already does. Recorded as a decision, not an omission.

**Two interactions checked rather than assumed.** The unit mirror made
`_ambIsCapturable` answer TRUE for a v2 layer, which had two possible
consequences: at an area boundary a capturable layer HARD-CUTS instead of fading
(correct — every v2 layer is unit-synced by construction), and Bar Lock might
capture it into a freeze that v2's emitter does not consult, which would double
every note. Measured over a real play with Bar Lock on: **11 notes, 0 instants
with more than one note, `E.freeze['v2:1']` null** — Bar Lock's capture path never
reaches v2. No bug, and now it is on the record instead of being a thing nobody
looked at.

`_ambAreaLoopBars` returns 0 with or without a v2 layer present, so it is not
affected either way.

Gate: **120 checks**.

## Slice 19 — placement: proximity (shipped)

Register is on the instrument and **`walk.span` already IS v1's Range**, so the
real gap in placement was PROXIMITY — how far consecutive notes may move. It is a
live-PITCH treatment: it shapes the relationship between successive picks
whatever kind is making them, which is why one control works on `walk` and on
`chance`.

Measured on a 12-note line, average semitone jump: **6.45 → 3.09 → 0.45** at
0 / 50 / 95; `chance` goes 4.09 → 0. The memory is ONE per cycle, which is what
keeps a proximity-shaped line deterministic and replayable rather than dependent
on where tick boundaries fall — poisoned to reset per note, the effect vanishes.

**Proximity 0 leaves the old behaviour byte-identical**, asserted rather than
assumed: a treatment that changes the default path is not absent-by-default.

Gate: **125 checks**.

## Slice 20 — the speech instrument (shipped) — THE INSTRUMENT SET IS COMPLETE

`instrument.voice` is now `synth` | `kit` | `speech`, and **v2's framing is better
than v1's here**: v1's spoken layers run a bespoke clock ("speak, then gap"),
while in v2 the PART decides when a line starts — so a line can land on a euclid
pulse, once a cycle, or wherever the rhythm puts it, like anything else.

- **Lines are DERIVED from the text, never stored** (`_ambSpokenLines`), so an
  edit cannot leave a stale split behind.
- **The rendered audio lives on the ENGINE in a WeakMap** — not on the layer
  (`persistWorkspace` serialises underscore fields, so AudioBuffers would land in
  the saved project) and not in `seqState` (`_ambResetClocks` empties that on
  EVERY play — the documented bug that made Sir Eel re-synthesise on the very
  press it had prepared for). Keyed per line AND per voice, so editing one
  sentence re-renders one line.
- **An unwritten line is SILENT, never a stall.** Rendering is seconds of
  inference and the tick is 150 ms — v1's "nothing loads during playback" rule.
  ✍ Write is a separate action and refuses while the transport is running.
- **`_ambVoiceChoices` reads `L.voice` meaning the TTS voice**, and in v2 that
  name is the INSTRUMENT enum — so the TTS voice is `instrument.speechVoice` and
  the helper gets a shim. Handing it a v2 layer would have offered
  'synth'/'kit'/'speech' as if they were voices.

Verified with a stubbed synth (this must not depend on a 60 MB model download):
3 lines written, the layer sounds at peak 0.84 through its own chain, the bank
never reaches the save, and it survives a stop.

**AND THE TRAP I HAD ALREADY WRITTEN DOWN, WALKED INTO ANYWAY:** the Words row
reused `.v2-cellrow`, putting a second element with that class EARLIER in the
card — so `querySelector('.v2-cellrow')` started returning the hidden Words row
and three checks failed on a pattern grid that was on screen the whole time. Same
shape as the duplicated Capture button in slice 4. It has its own class now.

Gate: **130 checks**. Two poisons here, and the FIRST VERSION OF ONE PASSED: a
40 ms-per-note stall slipped under a 200 ms threshold. Tightened to 50 ms — the
real path measures 0-1 ms. A poison that passes means the check is too weak, and
that is the fourth time today it has said something true.

## Slice 21 — the card gets a shape (shipped)

Reported as **"the v2 layer UI is a total mess, it needs logical subdivisions
and groupings of parameters"**, and the audit agreed, in numbers:

| | before | after |
|---|---|---|
| groups | 4 | 7 |
| rows visible on expand | 45 | 15 |
| card height at 390×780 | **2873px** | **1008px** |
| widest group (all open) | 18 ("Mix & FX") | 9 ("Mix") |
| duplicate labels | "Tone" ×2 | none |

**This was predicted by this very document and happened anyway.** §Treatments
says treatments are kept out of the part assembly *"which is what keeps the card
from becoming the wall of pickers that killed `bloom-composable-layers.md`"* —
the assembly stayed clean and the CARD became the wall, by accretion over
sixteen slices, each of which added three or four correct rows to whichever
group was nearest. No single slice was wrong; the sum was.

**The groups follow the model's own story**, which is why they are legible:
`Instrument → Part → Rhythm → Pitch`, then the treatments (`Motion`, `Mix`,
`FX`). Rhythm and Pitch were inside a 13-row "Part"; they are the two halves of
the live pipeline and each is now a group. Routing, filtering, time FX, gating
and movement were one 18-row group; the split is Mix (level · filter · reverb ·
bus · stereo · movement) vs FX (the effect stages).

Three mechanisms keep it from re-growing:

1. **Expanding opens the DEFAULT groups**, not all of them (`data-v2def`). The
   treatments fold to one line each. Opening all seven *is* the 2873px wall.
2. **An effect's own parameters are gated on the effect being engaged** — a new
   `on:` token in the same `data-v2when` vocabulary (`on:delay`, multi-valued,
   and `dryKill` counts because it engages a stage at mix 0 deliberately). FX is
   8 rows at rest and grows only around what you turn up. Measured 8 → 12 with
   delay and drive engaged.
3. **A folded group carries a summary of what is engaged inside it**
   (`Mix · level 70 · reverb 40 · bus B`, `FX · delay · chop`). The drum-solo
   lesson: state that can vanish while its widget keeps state gets reported as a
   bug. It shows only while folded — inside an open group the controls say it
   themselves.

**Two labels were duplicated and both were renamed**, per the naming rule
(divergent behaviour ⇒ divergent label; keys never move). `cutoff` was "Tone"
beside `instrument.tone`, also "Tone" — the voice and the filter under one
word. It is **Filter** now. The trance gate was "Gate"/"Gate steps"/… while this
card's *other* gates are the SCHEDULE gates (Plays, and the chord/section/unit
matrices); it is **Chop** now, and its grid is "Chop pattern" so "Pattern" stays
unique to the rhythm grid.

**Group open/closed state now survives a rebuild**, keyed on a stable
`data-v2grp` attribute — NOT the head's text, which now carries the summary and
therefore changes as you edit. Without this, any structure change (a rename, a
Live/Recorded switch) silently refolded whatever you had opened.

**The SHAPE is gated, not just the controls** — eight new checks in
`npm run test:ui` (138 total): the group list and that every group is named,
that expanding opens only the musical core, that an expanded card is under
1400px, that **no group exceeds 12 rows with every group open** (the accretion
check), that a folded group says what is engaged, that no two rows share a
label, that an FX param appears only once its stage is engaged, and that open
groups survive a rebuild. Six poisons, six named failures.

**A SEVENTH POISON PASSED, AND THAT WAS THE FINDING.** Relabelling the filter
back to "Tone" did not trip the duplicate check — because the structural probe
runs *after* the speech section, and a speech layer HIDES the pitched rows,
including `instrument.tone`. Only one "Tone" was visible, so the collision was
invisible. The probe now resets the layer to synth/live before measuring.
**A structural check must state the state it measures**; inheriting whatever the
previous section left is how a check comes to assert nothing.

**One real bug fell out of writing the gate:** the caret changes which groups
are folded, and a summary shows only while folded — but nothing repainted them,
so a group refolded by expanding the card came back with a blank head. The
collapse control now re-runs the gate exactly as a group head does.

Display-only: golden 82/82, arch 62/62, partseq 231, harness ✓ — untouched by
construction, since nothing outside `cardHtml`/`applyGate`/`render` moved.
390/620/900px: zero overflow, zero clipped or spilling text nodes.

## Slices 22-24 — the parity campaign begins (shipped)

The user asked for full parity so v1 can be retired. An audit first, because the
answer to "does v2 do everything v1 does" should be measured: **v1 exposes 119
distinct control tokens across its twelve types (three retired); the v2 card had
53 fields.** The gap is concentrated in generation, not treatment.

### Slice 22 — the five that were stored and unreachable

`reso`, `instrument.decay`, `instrument.sustain`, `fine` and `areaFadeMs` were
all read by the engine and had no control on the card — the reachability rule
broken quietly for eight slices. Each is now followed to the reader that
consumes it, not merely to the store: decay/sustain/fine through
`_ambApplyAdsr` into the note, `reso` to `_ambApplyLayerFilter`, `areaFadeMs` to
`_ambAreaFadeMap`.

Adding them would have made Mix 12 rows — which **the accretion check added in
slice 21 refused**, one slice after it was written. Mix split into **Mix** (the
layer's own sound: level, filter, resonance, fine, glide, voice trim) and
**Space** (where it goes: reverb, bus, width, stereo, move, area fade).

### Slice 23 — every sweep, and the normalize chokepoint

**Ten of v1's layer sweeps did not know `cfg.layers` existed.** Measured by
enumerating every function that walks `['bed','motif','texture','beat']` — 32 of
them — and checking which also touch `cfg.layers`: seven did, twenty-one did
not, of which ten were real (the rest are v1 Write/lock machinery v2 replaces).
One shared `_ambV2Each(cfg, fn)` now joins them: the area-depart fade, the LCM
advisory, `_ambForEachLayer`, `_ambKeyOfLayer` (a v2 layer has no `.type`, so
the `type:id` form could never match it), the warm-up's sample ids (a v2 kit is
a bare id, like a Beat's — the tone is caught by the existing regex, the kit is
not), the solo cancel sweep, `_ambTransposeArea`, the capture's "is anything
on" guard, and `bloomSeamWatch`.

**And the one that matters most: v2 had opted out of `_normalizeAmbientCfg`.**
It normalized LAZILY — only when the tick ran or the card rendered — which is
not what "normalize runs on every getCfg" means, and it had a measurable
consequence: the `unit` mirror v1 reads (capturable, the area fade, `unitGate`,
the scheduler lane) went **stale between renders**, and a loaded project's v2
layers were uncoerced until something happened to ask. `window._v2.normalizeAll`
is now called from the one chokepoint, in place.

This was found by accident — a free-clock change appeared to do nothing, and
instrumenting the mirror showed it running exactly once, during `add`. Reasoning
about it three times got nowhere; one `console.log` inside the function settled
it.

### Slice 24 — free-running cycles, and the per-layer note source

**Free cycles** (`part.clock: 'free'`, `part.ms`). A v2 layer was always
bar-synced, which made a whole class of v1 layer inexpressible — a pad on its
own 7.3s interval, the shape most ambient beds have — and *silently made Area
fade inert*, since v1 hard-cuts a bar-synced layer at an area boundary by
design. A free part writes v1's own `unit = {mode:'free'}`, so every consumer
that asks `unit.mode` reads it exactly as it reads a free v1 layer. Measured:
onsets at 0 / 0.7 / 1.4 s for a 700 ms cycle, `_ambIsCapturable` false, and the
area fade live at 1200 ms where a synced layer correctly reads 0.

**The per-layer note source**, and the finding that made it small: **v1's
`_ambNotesOf` applies an AREA PROGRESSION LOCK — an active area progression
overrides every layer's source.** So v2 was already at parity whenever a
progression was on; the gap existed only in a chromatic/key area. The fix is not
a second resolver but asking v1's: `_ambNotesOf` → `_ambSrcRootPc` /
`_ambScaleIntervals`, with `_ambProgStepOverride` set to the note's own onset
the way every v1 emitter does. Three lines buy the whole vocabulary (scale,
chord, wrap, prog, notes, yoke, `keyOv`) plus the key-transpose chokepoint.

**Proven behaviour-preserving before any UI was added**: byte-identical emitted
pitches on a keyed area and on a progression, comparing the old resolver against
the new one. The control is v1's own `_ambNotesButtonHtml` + `_ambOpenNotesMenu`
— reuse, so the vocabulary cannot drift — and it greys with
`ambient-src-locked` while the area progression is overriding it, which is the
only honest thing a per-layer control can do in that state.

`keyOv` is coerced and READ (it rides `_ambNotesOf`), so it works today; what it
lacks is a control, because v1 builds that one inline in its schema renderer
rather than as a reusable builder. That is the next slice.

Gates: `npm run test:ui` 151 checks (up from 138), poison-verified in eleven
places; golden 82/82, arch 62/62, partseq 231 throughout.

## Slices 25-27 — groove, the mod matrix, speed and harmony (shipped)

Three more from the parity list, and the pattern that made them cheap: **each
was a v1 HELPER v2 could call, not behaviour to reimplement.** Finding the
helper first is what turned sixty scattered knobs into a tractable list.

### Slice 25 — groove, and the Area macros arrive with it

`swing`, `accent` and `tight` wired through `_ambSwingSec`, `_ambAccentVol` and
`_ambTightOn`/`_ambTightChoke`; rests re-routed through `_ambEffRest`. **The
knobs are not the prize** — each of those helpers folds in the corresponding
AREA GROOVE macro, so before this a v2 layer felt no swing, no accent and no
density however the Groove panel was set. Measured: a layer with nothing of its
own now shuffles `0.3375 / 0.1625` under an area swing of 70.

`ring` turned out to be already covered — `_ambRingMs` reads `lenRatio`, which
is exactly v2's Length.

### Slice 26 — the mod matrix, which already worked

`L.mod` (VCA · VCO · VCF LFOs) **already modulated a v2 layer**: `_ambSyncMods`
walks `_ambWantSet` and `_ambSyncTarget` reads `L.mod`, both joined in slice 5.
Measured before a line was written — setting `L.mod` built a live source on the
v2 chain. It lacked only a control, so the slice is v1's own `_ambModTarget` +
`_ambWireModTarget`, deliberately NOT `_ambModUi` (which also emits the trance
gate, and v2 has that in FX as Chop — two controls over one field is what this
card was just cleaned of). Absent by default, seeded from `_ambDefaultMod` on
first touch, pruned back to absent when every depth returns to 0.

The duplicate-label gate had to learn a real distinction here: v1's mod targets
repeat Depth/Rate/Shape once each, disambiguated by their own sub-heading. The
rule is now "unique within the block it is READ in", keyed on
`.ambient-mod-target`'s `.ambient-mod-sub`.

### Slice 27 — speed, and what a recorded part does when the chords move

`speed` is v1's `_ambRateMult`, scaling the CYCLE (which is what "play this part
at half speed" means when the part is the cycle). Measured 2× halving the onset
spacing. **It is a `<select>`, so it writes a STRING** — and `_ambRateMult`
tests `Number.isFinite`, so an uncoerced store would have been deleted on the
next normalize and the control would have been dead on arrival. `parseFloat` in
normalize; poison-verified.

`harmony` (fixed / follow the key / lock to the chord) applies v1's
`_ambLockHarmonizeFreq` to a RECORDED part — the same function v1 uses on a
frozen loop, so a composed phrase behaves identically either side. **It needed a
piece v2 did not have: the key the part was WRITTEN in.** That helper transposes
from the captured key to the current one, so with nothing to move from the
setting did nothing (measured: identical pitches in C and in A minor). `part.key`
is stamped by all three doors — capture, compose, adopt — through one
`stampPartKey` so they cannot disagree; a part saved without one falls back to
the current key, i.e. a zero shift and never a surprise re-key. Verified: C‑D‑E‑G
in C major plays as A‑B‑C‑E in A minor, and `fixed` does not move.

Gates: `npm run test:ui` 166 checks, poison-verified in fifteen places across
these three slices; golden 82/82, arch 62/62, partseq 231.

**Coverage now: 113 live v1 tokens against 64 v2 card fields plus the mod matrix
and nine non-field controls.**

## Slices 28-30 — strum, the key override, rhythm vary (shipped)

### Slice 28 — strum, and the accretion check earning its keep again

`strum` + `strumFidelity`, spreading an onset's notes across a fraction of the
span in an order from v1's own `_ambStrumOrder` (a partial Fisher–Yates on the
seeded stream: fidelity 0 is low→high every time, higher wanders). Measured: a
4-note chord goes from `0,0,0,0` to `0,0.333,0.667,1` at strum 50, and the order
scrambles at fidelity 100.

Adding it took the card to **1467px**, which the accretion check refused — the
second time in this campaign it has forced a better grouping rather than a
bigger one. Strum is articulation, not "which note", so Pitch split and **Shape**
appeared, matching the model's own `part.shape`.

### Slice 29 — the key override, for almost nothing

`keyOv` had been coerced and READ since slice 24 (it rides `_ambNotesOf`); it
lacked a door, and v1 builds that control INLINE in its schema renderer.
Extracting it into `_ambKeyOvHtml(kk, inst)` and calling it from both turned out
to cost about ten lines — because **everything in that markup is keyed on
`data-kokey`, and v1's wiring is delegated on the panel host by that key.** A v2
card sits inside that host, and `_ambLayerByKey` has resolved `v2:` since slice
5, so the controls work with **no wiring in v2 at all**. Verified end to end
through v1's own handlers: mode → `{mode:'key',root:0,scale:'major'}`, root 9 →
root 9, and the layer plays A/B/C♯ where the area gives C/D/E, reverting on
Inherit. v1's own copy is pinned by a gate check too, since the extraction
touched its renderer and no audio gate can see a broken control.

### Slice 30 — rhythm vary

`part.rhythm.vary`, using v1's rule verbatim from all four of its euclid
renderers: a seed hit is dropped at 0.40× the setting, a silent slot added at
0.22×. Asymmetric on purpose — it thins harder than it thickens, which is what
keeps a varied pattern recognisable instead of filling in. Measured over six
cycles: a fixed `1357` becomes six distinct patterns, identical on replay.

**A poison that PASSED corrected a wrong diagnosis here.** A first measurement
showed onset COUNTS alternating `2,5,2,5` over four cycles, which looked like a
seed multiplied by the constant that built it folding its low bits; the mixing
constant was changed. Poisoning it back did not fail the gate — and measuring
the onset POSITIONS over eight cycles showed the original constant giving eight
distinct patterns. Both are fine. **Four samples of a count is not evidence
about a seed**, and the check now measures positions for exactly that reason.

Gates: `npm run test:ui` 176 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 31 — the sweep's pool, Hold, Max events (shipped)

- **`part.pitch.octaves`** bounds the series sweep to a pool of `N × octaves`
  and wraps inside it — v1's own sizing (`len = N * octs`), and the difference
  between an arpeggio and a scale run.
- **`part.pitch.randomness`** (Scatter): v1's rule — with that probability a
  note jumps to a random pool degree instead of following the direction. Seeded
  on the onset, so a scattered sweep still replays for a take.
- **`part.shape.holdSteps`** (Hold) sizes the note off the STEP GRID rather than
  the onset span. The two answer different questions and a sparse pattern is
  where that shows: measured 900 ms by Length against 500 ms by Hold on a 2-in-8
  euclid.
- **`part.shape.maxEvents`** caps a cycle's note-events, keeping the earliest —
  v1's rule, applied after every onset, voice and ghost so it is a ceiling on the
  whole cycle rather than one stage.

**The pool had to become OPT-IN, and the gate is what said so.** Wrapping it
unconditionally broke `down`: descending from the bottom degree wraps to the TOP
by definition, so the sweep read `60 · 79 · 76 · 72` instead of walking below the
base. Absent = the unbounded sweep, byte-identical; present = a bounded pool.
Because absence is now meaningful, `octaves: 2` is NOT pruned even though 2 is
v1's default — here it is a real choice.

Card after: 1369px expanded, widest group 10 rows with every group open, zero
overflow at 390px. Gates: `npm run test:ui` 181 checks, four poisons, four named
failures; golden 82/82, arch 62/62, partseq 231.

## Slice 32 — the scheduled tone, and `_ambCardKey` as a second free door

`toneSeq` (cycle the voice on the bar clock: 4 bars saw, then 4 bars sine) using
v1's `_ambToneSeqBoxHtml` and `_ambToneAt`. **Like the Key override, it needed no
wiring in v2** — and for a second, different reason worth knowing: that handler
is delegated on the panel host and resolves its layer through **`_ambCardKey`,
which falls back to `[data-phkey]` inside the card**. A v2 card has carried
`data-phkey="v2:<id>"` since slice 5 (it was added for the Level mirror), so
`_ambCardKey` already answers `v2:1`. **27 v1 call sites resolve a layer that
way**, so an unknown number of other v1 controls will drop onto a v2 card for
free; this is the second one tried and the second that worked.

Resolved per NOTE at the note's own time — a tone read once per tick would change
on bar boundaries a whole lookahead early. Measured: two 1-bar steps give
`sine, square, sine, square`, and switching it off gives `sine` throughout.

**Instrument split again.** The extra row took the card to 1406px, 6px over the
threshold — so rather than move the number (which is how a gate gets defanged),
the group was measured: Instrument was 456px of it and half of that was the
ADSR. **Envelope** is now its own folded group, which is where an envelope lives
on any synth anyway. Card back to ~1180px.

Gates: `npm run test:ui` 184 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 33 — chord voicing, through v1's own voicer

`part.pitch.chordMode` (Chaos · Chords · Chords+ · Monk) plus `spread`,
`variety` and `feel`, handed to **`_ambVoiceProgChord`** rather than
re-implemented — it is the most musically-loaded code in the app (inversions,
extensions, sus/aug, the variant menu and its seeded pick) and a second copy of
it would drift immediately. It reads a BED-shaped layer, so it takes a shim, the
same pattern `_ambApplyAdsr` uses: the field names differ (`voices` → `density`,
`instrument.register` → `register`), the meanings do not.

The voicer returns FREQUENCIES where v2's pitch contract is MIDI; the conversion
is exact and unrounded, so `midiToFreq` inverts it and any microtonal offset the
voicer applied survives.

Absent `chordMode` = the simple stack, byte-identical, and clearing it prunes all
four fields.

**A measurement trap worth recording.** The four modes first measured
*identical*, which looked like the shim not reaching the voicer — it was the
test. Extensions require `chordsplus`/`monk` **and** `variety > 0`; sus/aug
require `monk`. The probe had used `chords` *with* variety and `monk` *without*
it, so every mode collapsed to inversions only. Correct behaviour, wrong test.
What proved the wiring was `spread` (which changed the voicing immediately) and
then Monk + variety + a stochastic feel.

Gates: `npm run test:ui` 188 checks, three poisons, three named failures; golden
82/82, arch 62/62, partseq 231.

## Slices 34-35 — Subdivide, and the speech family (shipped)

### Slice 34 — Subdivide and Feel

`part.pitch.subdiv` + `feel`, resolved through **`_ambProgSpanAt`** — the same
function v1's bed uses. It answers both the sub-slot AND a `chordStep` that is
unique per group OCCURRENCE rather than per written chord, which is what keeps a
stochastic feel evolving instead of repeating every pass. Measured: Subdivide 1
holds one voicing per chord, 4 walks the inversions inside it, and a stochastic
feel picks differently while replaying identically for a take.

**A test-design note:** the first assertion hardcoded MIDI values taken from a
standalone probe, and this section of the gate carries state from the checks
above it (spread, variety, degree). Pinning the fixture rather than the
behaviour; it asserts the SHAPE now — sub1 constant, sub4 varying.

### Slice 35 — the speech family

Three findings, in order of how much they changed:

1. **The speech FX already worked.** `_ambLearnPlay` — which v2 has called since
   the speech instrument landed — resolves chop/order/reverse/rate/trim through
   `_ambSpeechOpt(L)`. They needed `_ambNormalizeSpeech` and a surface, nothing
   else. (My first field-extraction regex said `_ambLearnPlay` read only
   `L.level`, because it reaches the rest through that helper — grep for the
   HELPER, not just `L.<field>`.)
2. **`speakwhen` is superseded, not missing.** v1's spoken layers run a bespoke
   clock (speak, then gap, or every N bars, or on a cue). In v2 the RHYTHM
   decides when a line starts, so a line can land on a euclid pulse like
   anything else. That is the model doing its job; there is nothing to port.
3. **Words as notes is new capability** — `wordOut: speak | play | both` through
   v1's `_ambEmitWordPassage`, given a flat shim (the `adsrShim` pattern).
   Measured: `abc def.` plays MIDI 48·49·50 then 51·52·53 on the chromatic
   alphabet map, and `play` needs no rendered audio at all — which also makes a
   speech layer usable where no voice is available.

**A TDZ bug, and a poison that passed.** The word branch first referenced `at`
— the swung time — which is declared BELOW it in the same block: a ReferenceError
that made the whole speech branch emit nothing, silently. And counting NOTES
could not test the `wo !== 'play'` guard at all (an unrendered line is a no-op
either way), so that poison passed; the check now stubs the synth, writes real
lines and counts `_ambLearnPlay` calls, which IS the buffer path.

Gates: `npm run test:ui` 195 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 36 — follow salt (the "Keys" behaviour)

Salt sub-divides ONE chord instance into colour segments (C · C(no3) · Cmaj7),
and a chord layer samples its chord once at the onset and holds — so those
changes were inaudible on a v2 layer. `_ambBedSaltPlan` (v1's own) resolves the
whole segment plan for an onset and returns one note per TONE spanning the
contiguous run of segments it belongs to, which is why it is scheduling rather
than surgery: a shared tone gets a single long note (no retrigger, no envelope
restart), a leaver simply ends, an arrival starts at its boundary.

Its return shape — `{f, offSec, durMs}` — is exactly what v2's `notesFor`
contract needs, so the whole thing is one branch. Measured: a held chord is
`60/4000 64/4000 67/4000`; with salt following, the tone the colour drops ends
early while the shared ones ring on. No colours = a no-op, byte-identical.

**Pitch split for the third time.** The card measured 1422px, and Pitch had
become two questions — *which* notes, and *how the chord is laid out*. **Voicing**
(mode · spread · variety · subdivide · feel · salt re-voice) is now its own
folded group. That is the accretion check forcing a better grouping rather than
a bigger one three separate times in this campaign; it is the single most useful
check in the file.

**Two gate slips, both found by poisons that PASSED.** The leaver's exact length
is SEEDED on the take, so hardcoding `64/500` from a standalone probe pinned the
fixture, not the behaviour — it asserts the shape now (some tone ends early, some
rings the whole length). And the pruning check asserted on `delete
L.followSalt`, which removes the field whatever normalize does; what the
coercion line actually does is drop a FALSY stored value and canonicalise a
truthy one, so that is what it tests.

Gates: `npm run test:ui` 200 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 37 — articulation: slide and ornament

Both are v1's own helpers (`_ambSlideMs`, `_ambOrnamentFlicks`) and both work in
**DEGREES** — a slide fires on a leap of three or more source tones, an ornament
flicks to the neighbour degree. v2's pitch contract returns MIDI, so neither
could be called: the degree existed inside `pitchesAt` and went nowhere.

The fix is one stash and one field. `pitchesAt` records the resolved degree and
octave on the PART (which `_prox` already uses that way), and `notesFor` carries
them on the note — **only the FIRST voice of an onset**, because a slide and an
ornament are gestures on the LINE, not on each note of a chord.

Measured on a walking line with big leaps: slide glides 4 of 16 notes and adds
none (it fires on a leap, and only some of the time — "every note glides" would
mean it had been read as portamento, which is a different control); ornament
takes 16 notes to 30 and replays identically for a take. Both absent by default,
spending no draw.

Gates: `npm run test:ui` 203 checks, three poisons, three named failures; golden
82/82, arch 62/62, partseq 231.

## Slice 38 — shaping the line: contour, stutter, syncopate (and one NOT shipped)

Three of v1's short inline rules, ported verbatim:

- **Contour** biases the walk's step direction. **What it does in v2 is not what
  it does in v1**, and the comment says so: v1's motif accumulates from the
  previous note, so contour makes the line CLIMB; v2's walk scatters around a
  fixed centre, so contour raises or lowers the line's CENTRE OF GRAVITY.
  Measured as mean pitch — 59.1 plain, 63.3 at +100, 57.1 at −100.
- **Stutter** repeats the previous degree instead of stepping (v1's rule,
  consuming no further pick). Measured 9 repeats against 0 without it.
- **Syncopate** weights the odd slots of a chance fill. Measured: odd-slot hits
  go from 3/5 to 7/7.

**GRAVITY WAS WRITTEN, MEASURED AS A LITERAL NO-OP, AND REMOVED.** v1's motif
walks a chromatic-ish space and gravity pulls a stray note onto a chord tone;
**v2 picks by INDEX into the sounding tone set** (`set.ivs[k % N]`), so every
pick is already a chord tone and there is nothing to pull to. The code computed
a nearest tone that was always itself. A control that cannot do anything is
worse than an absent one, so it is not shipped — and a gate check pins that,
because "we left it out on purpose" is exactly the kind of decision that gets
re-litigated as an omission six months later.

**A measurement slip, the same shape as two earlier ones:** contour first read
as broken because the metric was up-vs-down TRANSITIONS, which is meaningless for
a scatter. Mean pitch showed it working immediately.

Gates: `npm run test:ui` 207 checks, three poisons, three named failures; golden
82/82, arch 62/62, partseq 231.

## Slice 39 — twist and motion

**Twist** — v1's rule: 0 is a single note per onset; as it rises the CHANCE and
the SIZE of a burst both grow (2..~7 notes) packed ≤120 ms apart. Each extra
note RE-PICKS, which is what makes it a flurry of walk-steps rather than a
repeat — so it asks `pitchesAt` again per burst note. Measured: 4 notes at
`0, 0.5, 1, 1.5` becomes 11 at `0, 0.12, 0.24, 0.5, …`, replaying identically.

**Motion** — a seeded detune wobble of ±18 cents × the amount, **ADDED** to
whatever `fine` already put on `params.detune`. v1 warns about exactly this
(both write the same field), and the poison for it initially PASSED because the
fixture had no `fine` — with nothing to add to, replacing and adding are
indistinguishable. The check sets `fine: 50` now and asserts the wobble stays
centred on it.

Gates: `npm run test:ui` 212 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 40 — home, Voice from, and five tokens that were never controls

**Home** — where Register sits in the walk WINDOW: floor (what v2 always did)
walks up from it, centre shifts the window down by half the span, ceiling by all
of it. v1's rule in its own shape. Measured as mean pitch: 58.5 → 53.3 → 48.3,
and absent = floor.

**Voice from** (auto / this device / the voice server). The routing does NOT
live in `_ambLearnSynth`, which takes `(text, voice)` and no layer — it is in
**`_ambLearnWarmUp(E, L)`**, which reads `_ambVoiceFrom(L)` and decides whether
to probe the server at all *before* any model is downloaded. v2's write path now
calls it and AWAITS its probe, because v1 documents the race: the pump asked for
line 0 within a second and beat the ping.

**And five of the remaining "missing" tokens turned out not to be controls at
all** — worth recording so they are not re-implemented:

| token | verdict |
|---|---|
| `sub` | a sub-HEADING in the schema (`ambient-grp-sub`), not a sub-oscillator |
| `poly` | drums-per-hit for v1's RANDOM beat generator; v2's kit is drawn lanes, so the user states it directly |
| `arpres` | a synced arp's note rate; v2's rhythm sets the rate outright |
| `rhythmseed` | fill-vs-euclid strategy — v2's rhythm KIND |
| `pitchseed` | random-vs-grounded — v2's pitch KIND |
| `fill` | v1's texture density — v2's `chance` rhythm |
| `livewrite` | v1's PUMP writes while playing; v2 has no pump — writing is an explicit act, which is the same guarantee stated as a model rather than a switch |

Gates: `npm run test:ui` 215 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 41 — the chord phrase, and the right voicer

v2 was calling `_ambVoiceProgChord`. **`_ambPickVoicing` is its superset**: it
delegates to that one when the source is a progression, and otherwise runs v1's
STRUCTURED voicer — a repeating phrase of `chordPhraseLen` chords, repeated
`chordRepeats` times, then a fresh one. That is what makes a chord layer sound
composed rather than chaotic when there is no progression to follow, and v2 had
none of it.

Switching to the superset was one call plus two shim fields, and the shim now
also carries `notes`/`keyOv` because `_ambPickVoicing` resolves the source
ITSELF (`_ambNotesOf(bed)`) rather than being handed one.

The phrase walks on the CYCLE index, which `pitchesAt` does not have — stashed
on the part as `_cyc`, exactly as `_prox` already is.

Measured over eight cycles: no mode gives one chord throughout; phrase 2 ×
repeats 2 gives **A B A B, then a fresh C D C D**; phrase 4 × repeats 1 stops
recurring. All replay identically for a take.

**A fixture-pinning slip, the third of its kind:** the check first demanded
eight DISTINCT chords from eight cycles, and got seven — the voicer draws a form
and a degree from a seeded RNG, so two can collide by chance. That was a claim
about the fixture's seed, not the behaviour; it asserts "stops recurring" now.

Gates: `npm run test:ui` 219 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 42 — phrasing: v1's gesture cells

With probability `phrasing`, an onset takes a shaped FIGURE — relative onsets
and durations with an ARRIVAL note (long, and leaned on x1.15) — instead of a
uniform note. v1's five cells, verbatim: arrival · run-up→arrival · dotted
figure · short–LONG pair · late pickup. With probability .35 the PREVIOUS
gesture repeats, which is the classical sequence device (same rhythm, new pitch
level).

The gesture is held on the LAYER, non-enumerable so it never reaches a save,
because a gesture persists ACROSS cycles and `mem` does not. It takes precedence
over Twist, exactly as v1's plan overrides its burst count.

Measured exactly: the dotted cell `[0, 0.42] [0.48, 0.13] [0.64, 0.32]` renders
as times `0, 0.48, 0.64` with durations `420, 130, 320` over a 1-second span,
and the arrival's volume is 37 against the others' 32 — v1's x1.15. Replays for
a take; absent = one note per onset, unchanged.

Gates: `npm run test:ui` 222 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 43 — Start, and a claim I had to withdraw

I had listed `phraseVary` as "the motif's phrase-length variance, probably
covered by `part.rhythm.vary`" and said I would verify rather than assert it.
**It was wrong.** `phraseVary` is **Start** — where the phrase BEGINS inside its
cycle — and v1's own comment says it and `startVary` are "one algorithm, two
copies, free to drift". Nothing in v2 did it.

So v2 gets ONE field, `startVary`, and with it the CASCADE, which is the real
prize: `_ambEffStart` falls back to the AREA's `startVary`, and that IS the
Groove panel's **Humanize** macro. A v2 layer that sets nothing now follows it,
and a groove bypass silences it — measured both ways.

**The offset is NOT `_ambStartOffset`, deliberately.** That helper draws from
`_ambRand`, the SHARED stream, and every draw v2 makes is isolated precisely so
a v2 layer cannot shift a v1 layer's numbers. Same rule, same slack, its own
seed — and the divergence is written down rather than silent.

Measured: on the 1 by default (`0,0,0,0`); at 100 each cycle starts somewhere
different and replays identically; the area cascade with no per-layer value
produces the same offsets; a bypass returns it to the 1.

Gates: `npm run test:ui` 226 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 44 — the re-audit, and a bug it found in my own work

Having just had to withdraw one coverage claim (`phraseVary`), I re-checked the
others instead of building the next feature. That immediately found a real
defect — **in slice 36, which I had shipped green.**

`_ambBedSaltPlan` asks `_ambVoiceCap(bed)`, which is `voiceCap` when set and
**DENSITY otherwise**. v2 handed it a bare `{ followSalt: 1 }`, so the cap
resolved to **1**, and `if (sounding.length >= cap) return` suppressed **every
ARRIVING colour tone**. Leavers worked; arrivals never appeared. Half the
feature, for six slices.

**The gate could not see it by construction**: it recorded pitch and duration
and NOT the onset time, so a note starting mid-chord was invisible. It records
`pitch/duration@onset` now and requires an arrival — poisoned, and the poison is
the exact original bug.

**The fix had its own bug, of a kind this file already records twice:** the new
shim field referenced `t`, which is `pitchesAt`'s local — the branch lives in
`notesFor`, where it is `p.pitch` — so it threw into the surrounding `catch`,
the plan came back null, and the layer fell silently to the plain path. What
settled it was calling the v1 helper DIRECTLY with each candidate shim and
diffing against the emit path (7 notes vs 3), then one `console.log` inside the
swallowing branch.

`voiceCap` also gets a control now — it was dismissed earlier as "nothing to cap
until followSalt exists", and followSalt now exists.

Measured after: 7 notes for a 3-voice chord under 90% colours — a leaver at
500 ms, arrivals at 1 s and 2.5 s, and the shared tones ringing the full 4 s.

Gates: `npm run test:ui` 227 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 45 — polyphonic euclid (and a THIRD wrong coverage claim)

I had `euclidVoices` down as "partly covered by `pitch.voices`". **Wrong, and
the third of these.** `pitch.voices` stacks N notes on ONE onset — a chord.
`euclidVoices` gives each voice its **own euclidean row**, its own degree and its
own octave (`_ambEuclidVoicePat`: pulses offset by `[0,2,-2,3,-3,1]`, rotate by
`v x steps/V`), so the voices INTERLOCK. Entirely different, and v2 had none of
it. Reading v1's hit loop is what settled it — the tell is `for (let v = 0; v <
Veff; v++)` wrapping the whole bar/slot walk, not sitting inside it.

The melodic twin of the kit's eight lanes, so the shape was already in the file.
Measured: 1 voice = the 3-note row it always was; 3 voices = 9 onsets across 8
slots on 3 distinct pitches; prunes back.

**Two bugs on the way, both already in this file's catalogue.** The block first
referenced `startOff`, declared BELOW it — TDZ, and the whole `notesFor` threw,
so the layer emitted nothing (0 notes). Then every voice played ONE pitch,
because the pitch was asked for with the layer's own kind (`chord`, voices 1)
instead of the source STACK the voices actually are — a chord's worth of rhythm
on a single note. The gate now requires all THREE of more onsets, more slots and
a tone each, so neither can come back quietly.

Gates: `npm run test:ui` 230 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 46 — the synth-kit editor

v1's own `_ambSynthKitUi` — eight role tabs, per-voice params, roll one drum,
hear it — rendered on the v2 card. **For the THIRD time it needed no wiring**:
its handlers resolve the layer through `_ambCardKey` → `_ambLayerByKey`, both of
which have answered `v2:<id>` since slice 5.

What it DID need was **`_ambBeatIsSynth` learning that a v2 layer keeps its kit
on the INSTRUMENT** (`instrument.kit`, not `kit`). That predicate drives the
editor's own visibility sweep, so without it the editor rendered, wired itself,
responded to clicks — and was `display:none`. Measured exactly that: present
true, tabs 8, role select works, roll writes a voice, `visible: false`.

Two traps, both this file's own:

- The row first reused **`.v2-cellrow`**, which is how the gate LOCATES the
  pattern grid — and the kit row sits earlier in the card, so three grid checks
  started measuring the wrong element. Its own class (`.v2-skrow`). Second time
  a shared class has done this (`.v2-textrow` was the first).
- The visibility poison PASSED, because the check reached the sweep only via
  `_ambSyncControls`. It calls **`_ambSyncSynthKit(E)` directly** now — the
  exact path — and the poison then fails as it should.

Gates: `npm run test:ui` 233 checks; golden 82/82, arch 62/62, partseq 231.

## Slice 47 — article fetching: the last gap closed

`_ambLearnFetch(sourceId, term, corpus, wantChars)` is **not layer-shaped** —
plain arguments in, `{title, text, url}` out — so v2 calls it directly and
stores the result as its own `instrument.text`. The source list
(`_AMB_LEARN_SOURCES`) and the Amount table (`_AMB_AMOUNTS`) are v1's, read by
id, so the two engines cannot offer different sources or different budgets, and
the fields are v1's own names (`source`, `term`, `amount`, `lineWords`,
`article`) so `_ambAmount` / `_ambLineWords` / `_ambSpokenLines` read them
without a shim.

`paste` short-circuits before any network call — the Words box IS the source
there, so the subject, budget and Fetch rows are gated away with it (a new
`src:net` token).

**A real bug found by the gate:** v2's `speechLines` called
`_ambSpokenLines(t, null)`, which threw the layer's **Line length** away before
the control existed. Passing `L` fixes it — and the FIRST attempt to test that
passed with the poison in, because the fixture was a comma-free sentence and
`_ambSplitLine` never splits mid-clause (a butchered phrase sounds worse than a
long one). A splittable fixture, and the poison fails as it should.

Also fixed: the gate's stepper check used a loose `.ambient-step-up` selector
that took whichever came first in the card — which stopped being Register the
moment a speech-gated stepper was added above it. It targets Register by
`:has()` now.

Gates: `npm run test:ui` 239 checks; golden 82/82, arch 62/62, partseq 231.

**THE PARITY CAMPAIGN IS COMPLETE.** Every one of v1's 119 schema tokens is now
implemented in v2, verified as covered under another name, or deliberately not
shipped with a gate pinning that decision.

## Slice 48 — every subsection closed on expand

Asked for directly. Expanding a card now opens NOTHING: you get the group HEADS
and their summaries, and unfold what you came for. The card measures **382px**
expanded, against 2873px when this work started and 1008px after the first
regrouping.

That only works because the folded-summary mechanism was already there — twelve
one-line heads reading `Rhythm · pulse · 8 steps`, `Mix · level 70`, `FX · none`
are a contents page; twelve bare labels would be a filing cabinet.

The group open/closed state still survives a REBUILD (a rename, a Live/Recorded
switch), so nothing you opened refolds under you. Only an explicit
collapse→expand resets to all-closed.

**The gate needed one structural change rather than twenty edits:** its `tap`
helper now opens the control's group first, which is exactly the move a user
makes. Two carve-outs were needed and both are real: a `.ambient-grp-head` must
NOT be auto-opened (that cancels the toggle the tap is testing — net zero), and
the grid probe has to open its own group before measuring, or every cell reports
a 0x0 box and reads as a touch-floor failure rather than "not visible yet".

Gates: `npm run test:ui` 242 checks; golden 82/82, arch 62/62, partseq 231.

## What is left — measured, 2026-09-01

Ordered by what each one costs you, not by size.

**1. ~~The per-layer signal chain~~ · ~~Mix & FX~~ — DONE (slices 5-6).**

**2. The rest of the sweeps.** Depart and **solo** are done (solo is one shared
state: `_ambComputeAnySolo` counts v2 layers, `_v2Tick` reads its answer, and the
card marks a soloed layer so the state is never invisible). Still open:
`_ambAreaLoopBars` → 0, so Bar Lock and the area loop length ignore v2 — arguably
correct, since a v2 layer has no Write and so is not "capturable" in v1's sense,
but it should be DECIDED rather than inherited. ~~Glitch~~ and ~~Wet-only~~ landed in slice 18; per-FX
**Dry-kill** is deliberately left off (six rows for what Wet only already does).

**MEASUREMENT NOTE for anyone extending the gate here: a single `_ambTick` is the
wrong instrument for "is this layer silenced".** A layer emits in one tick only if
its own clock says it is due, so 0 notes means "not due", not "muted" — that
produced two confident wrong readings in this work (`{}` for a correctly soloed
motif). Assert on the FLAG and on `_ambComputeAnySolo`, or measure over seconds at
the master tap; never on one tick's note count.

**3. ~~Instruments~~ — DONE. Kit (slice 7), samples (slice 9 — always a tone,
once the picker offered them), speech (slice 20). ~~the `speech` instrument~~ — kit, sample, speech.** `instrument.voice` is
hardcoded to `'synth'` in normalize. This is what blocks the multi-lane drum
sequencer: v1's drum lanes are 8 lanes of one kit, and v2 has one row because it
has one instrument. A missing instrument, not a missing grid.

**4. Area safety.** `E._v2Phase` is keyed `v2:<id>` and ids are per-AREA, so two
areas that each contain a layer id 1 share one phase store. Needs an area
qualifier before v2 is used in a multi-area project.

**5. ~~The rest of the vocabulary~~ — pitch is 8 of 8 (slice 17). Rhythm has
four; v1 has more shapes worth lifting.

**6. Treatments** — ~~variance~~ (slices 13-14: humanize, velVar, rests, ghosts,
len vary, glide, voice trim). ~~the schedule gates~~ (slices 15-16: all four apply, and
all four are editable — `chordMask`/`saltMask` from the ⌗/▦ matrices, `when` on
the card, `unitGate`/`iterGate` from the ⏱ Scheduler lane v2 already has).
~~placement~~ (slice 19 — `walk.span` was already Range, and Proximity landed).
Per-layer salt is editable from the ⌗/▦ matrices' Salt column, which v2 joined in
slice 16. **This item is closed.**

**7. ~~Import~~ — DONE (slice 12). It now carries the PERFORMANCE family too
(slice 13). What it still does NOT carry: v1's per-type generation variance
(`rhythmVar`, `pitchVar`) — `ghosts` and `restProb` are carried since slice 14
and placement since slice 19 — and the Write loop — v2 has no equivalent for the first two yet, and Live/Recorded
replaces the third. An imported layer is therefore a faithful SKELETON, not a clone, and the
original is left beside it so the two can be compared.

**Done and not on this list:** note-level editing of a recorded part, which the
compose grid now provides (slice 4) — it was item 3 before that landed.
