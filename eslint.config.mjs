// eslint.config.mjs — a RATCHET, not a sweep.
//
// WHY THIS EXISTS. On 2026-09-28 a `let` declared below its first use threw
// `Cannot access 'servoOn' before initialization`, the error was swallowed by a
// fallback path, and the whole MSE broadcast silently degraded to the secondary
// audio path for a build cycle before a harvested device log revealed it. One
// lint rule catches that class in under a second. CLAUDE.md already records the
// same shape for 18-layer-v2.js's two IIFEs, where "a bare name from the wrong
// half throws into a surrounding catch and measures as a silent no-op" — so this
// is a documented, recurring trap, not a hypothetical. It also found a second,
// latent instance in 00-mse-audio.js's sourceopen wait on its first run.
//
// WHY A RATCHET. Run across everything, `no-use-before-define` reports ~700
// problems, because it is LEXICAL, not flow-sensitive: a `let` referenced inside
// a closure that is only INVOKED later is flagged and is usually fine. A gate
// that is 700-red on day one gets switched off, so instead it is enforced on the
// 25 files that are already clean, and the rest are listed below.
//
// THE LIST MAY ONLY SHRINK. Delete an entry once that file is clean; never add
// one. A new file is clean by construction, so nothing new is ever exempt.
export const legacyUseBeforeDefine = [
  'js/bloops/00-native-audio.js',                  // 7
  'js/bloops/01-core-state.js',                    // 9
  'js/bloops/02-wraps.js',                         // 4
  'js/bloops/03-audio-bus-fx.js',                  // 28
  'js/bloops/03b-core-voices.js',                  // 39
  'js/bloops/04-instruments-samples.js',           // 5
  'js/bloops/05-sequencer-core.js',                // 24
  'js/bloops/07-playback-scheduler.js',            // 2
  'js/bloops/08-grid-modes.js',                    // 1
  'js/bloops/09-generators-recording.js',          // 2
  'js/bloops/10-tracks.js',                        // 31
  'js/bloops/11-modes-persistence.js',             // 2
  'js/bloops/13-prog-pad.js',                      // 10
  'js/bloops/14-ui-menus-dnd.js',                  // 4
  'js/bloops/15-grid-build.js',                    // 1
  'js/bloops/16-grid-controls.js',                 // 2
  'js/bloops/17-ambient.js',                       // 323
  'js/bloops/18-layer-v2.js',                      // 185
  'js/bloops/20-sound-design.js',                  // 3
  'js/bloops/21-shape.js',                         // 9
  'js/bloops/24-studio.js',                        // 5
];

export default [
  {
    files: ['js/**/*.js', 'test/**/*.js', 'tools/**/*.mjs'],
    // the legacy list exempts THIS rule only (it used to be a global ignore,
    // which also hid those files from every other rule below)
    ignores: legacyUseBeforeDefine,
    languageOptions: { ecmaVersion: 2022, sourceType: 'script' },
    // Existing files carry eslint-disable comments for rules this config does not
    // enable; reporting them as unused is noise about a rule we are not running.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // The TDZ class. Functions and classes are exempt: hoisted declarations
      // are idiomatic throughout this codebase and are not the bug.
      'no-use-before-define': ['error', { variables: true, functions: false, classes: false }],
    },
  },
  { files: ['test/**/*.js', 'tools/**/*.mjs'], languageOptions: { sourceType: 'module' } },
  // NO BLOCKING DIALOGS IN THE APP (2026-10-01). Native prompt/confirm freeze
  // the main thread, which on the phone carries every frame to the speaker and
  // runs the note scheduler — playback glitched and distorted while one was
  // open. Use `uiPrompt` / `uiConfirm` (js/bloops/02-wraps.js, promises);
  // `alert` is routed to an in-page dialog there. Every bloops file, the
  // legacy ones included; only the helper itself may touch the natives.
  {
    files: ['js/bloops/**/*.js'],
    ignores: ['js/bloops/02-wraps.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script' },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-globals': ['error',
        { name: 'prompt', message: 'Blocks the main thread (phone audio glitches) — use uiPrompt().' },
        { name: 'confirm', message: 'Blocks the main thread (phone audio glitches) — use uiConfirm().' }],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'prompt', message: 'Blocks the main thread — use uiPrompt().' },
        { object: 'window', property: 'confirm', message: 'Blocks the main thread — use uiConfirm().' }],
    },
  },
];
