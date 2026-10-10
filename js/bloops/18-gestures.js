// ✋ GESTURES (2026-10-09) — phone gestures, each a SHORTCUT to a control that is
// already on screen, and each with a DESKTOP equivalent that runs the same code, so
// both can be developed side by side (user: "need to work more swipe actions into
// the mobile app, what's the desktop equivalent so we can still develop
// simultaneously").
//
//   gesture (phone)              desktop                         the button it shortcuts
//   shake                        R                               🎲 New take (Generate's, else the area's)
//   swipe ← → on the Part bar    drag · trackpad swipe · [ ]     the Part dropdown
//   swipe ← → on Generate        drag · trackpad swipe · ← →     Generate's tab row
//
// RULES: pointer events, so one handler serves a finger, a mouse drag and a pen; a
// swipe counts only past 42 px of mostly-sideways travel (taps and vertical scroll
// are untouched, nothing is preventDefault-ed); never from within 24 px of a screen
// edge (iOS's own back-swipe lives there); never while typing or dragging a slider.
(() => {
  'use strict';
  const THRESH = 42, SLOPE = 1.4, EDGE = 24;
  const typing = (el) => !!(el && el.closest && el.closest('input, textarea, select, [contenteditable], .g2-dial'));
  const toast = (msg) => { try { if (typeof showToast === 'function') showToast(msg, { ms: 1600 }); } catch (e) {} };

  // ── ONE SWIPE HELPER, by delegation: `match` picks the surface the swipe started
  // on; `skip` names parts of it that own horizontal drags (a roll, a strip, a dial).
  function swipeable(match, skip, cb) {
    let st = null;
    document.addEventListener('pointerdown', (ev) => {
      st = null;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const host = ev.target.closest && ev.target.closest(match); if (!host) return;
      if (typing(ev.target) || (skip && ev.target.closest(skip))) return;
      if (ev.clientX < EDGE || ev.clientX > window.innerWidth - EDGE) return;
      st = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, host };
    }, true);
    document.addEventListener('pointermove', (ev) => {
      if (!st || ev.pointerId !== st.id) return;
      const dx = ev.clientX - st.x, dy = ev.clientY - st.y;
      if (Math.abs(dx) < THRESH || Math.abs(dx) < Math.abs(dy) * SLOPE) return;
      const host = st.host; st = null;
      try { cb(dx < 0 ? 1 : -1, host); } catch (e) {}      // swipe LEFT = forward, like flicking a card away
    }, true);
    const end = () => { st = null; };
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
    // A TRACKPAD's two-finger sideways swipe arrives as wheel deltaX
    let acc = 0, accT = 0, cool = 0;
    document.addEventListener('wheel', (ev) => {
      const host = ev.target.closest && ev.target.closest(match); if (!host) return;
      if (skip && ev.target.closest(skip)) return;
      if (Math.abs(ev.deltaX) <= Math.abs(ev.deltaY) * SLOPE) return;
      const now = performance.now();
      if (now < cool) return;
      if (now - accT > 250) acc = 0;
      accT = now; acc += ev.deltaX;
      if (Math.abs(acc) < 120) return;
      const d = acc > 0 ? 1 : -1; acc = 0; cool = now + 650;
      try { cb(d, host); } catch (e) {}
    }, { passive: true });
  }

  // ── PARTS: step the Part dropdown, exactly as picking from it does
  function stepPart(d, host) {
    const sel = (host || document).querySelector('select.ambient-curpart-sel'); if (!sel || sel.disabled) return false;
    const n = sel.options.length; if (n < 2) return false;
    const i = Math.max(0, Math.min(n - 1, sel.selectedIndex + d));
    if (i === sel.selectedIndex) { toast(d > 0 ? 'That’s the last part.' : 'That’s the first part.'); return true; }
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    toast('▤ ' + (sel.options[i].textContent || ('Part ' + (i + 1))));
    return true;
  }
  swipeable('.ambient-curpart', null, stepPart);

  // ── GENERATE: step its tab row, skipping the dimmed slots
  const sheet = () => document.querySelector('.g2-ov .g2');
  function stepTab(d) {
    const g = sheet(); if (!g) return false;
    const tabs = Array.from(g.querySelectorAll('.g2-tabs .g2-tab')).filter((t) => !t.disabled && !t.classList.contains('off'));
    if (tabs.length < 2) return false;
    const cur = tabs.findIndex((t) => t.classList.contains('on'));
    const nx = tabs[Math.max(0, Math.min(tabs.length - 1, (cur < 0 ? 0 : cur) + d))];
    if (nx && !nx.classList.contains('on')) nx.click();
    return true;
  }
  // the picture, gap strips, dials and lane strips own their own drags
  swipeable('.g2-ov .g2-body', '.g2-roll, .g2-gaps, .g2-mbar, .g2-strip, .g2-steps, .steps, .g2-dial, .g2-odds', (d) => stepTab(d));

  // ── 🎲 ROLL: Generate's New take when the sheet is open, else the area's
  function roll(how) {
    const g = sheet();
    const b = g ? g.querySelector('.g2-foot [data-a="take"]') : document.getElementById('ambient-regen-btn');
    if (!b || b.disabled) return false;
    b.click();
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
    if (how === 'shake') toast('🎲 Shaken — a new take. ↶ Undo brings the last one back.');
    return true;
  }

  // ── KEYS (desktop): R rolls · [ ] step parts · ← → step Generate's tabs
  document.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || typing(document.activeElement)) return;
    const k = ev.key;
    if (k === 'r' || k === 'R') { if (roll('key')) ev.preventDefault(); return; }
    if (sheet() && (k === 'ArrowLeft' || k === 'ArrowRight')) { if (stepTab(k === 'ArrowRight' ? 1 : -1)) ev.preventDefault(); return; }
    if (!sheet() && (k === '[' || k === ']')) { if (stepPart(k === ']' ? 1 : -1)) ev.preventDefault(); }
  });

  // ── SHAKE (phone). iOS hands out motion only after a permission asked from a TAP —
  // asked once, the first time you press a 🎲 New take yourself (the moment it means
  // something), and remembered. A firm shake, at most once every 1.2 s, never while
  // typing (iOS's own shake-to-undo owns that).
  const KEY = 'bloopsShakeAsked';
  let motionOn = false, lastHit = 0, hits = 0, cool = 0;
  function listen() {
    if (motionOn) return; motionOn = true;
    window.addEventListener('devicemotion', (ev) => {
      const a = ev.accelerationIncludingGravity || ev.acceleration; if (!a) return;
      const m = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
      const now = performance.now();
      if (m < 24) return;                                   // ~2.5 g, well past walking or a tap
      if (now - lastHit > 600) hits = 0;
      lastHit = now; hits++;
      if (hits < 3 || now < cool || typing(document.activeElement)) return;
      hits = 0; cool = now + 1200;
      roll('shake');
    });
  }
  function askMotion() {
    try {
      const DM = window.DeviceMotionEvent;
      if (!DM) return;
      if (typeof DM.requestPermission !== 'function') { listen(); return; }   // Android, desktop: no prompt
      DM.requestPermission().then((r) => { try { localStorage.setItem(KEY, r); } catch (e) {} if (r === 'granted') listen(); }, () => {});
    } catch (e) {}
  }
  let asked = ''; try { asked = localStorage.getItem(KEY) || ''; } catch (e) {}
  if (asked === 'granted' && window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission !== 'function') listen();
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('.g2-foot [data-a="take"], #ambient-regen-btn');
    if (!t || !ev.isTrusted) return;
    let a2 = ''; try { a2 = localStorage.getItem(KEY) || ''; } catch (e) {}
    if (a2 === 'granted') { if (!motionOn) askMotion(); return; }   // re-arm after a reload (iOS keeps the grant)
    if (a2) return;                                                 // asked and refused: never nag
    askMotion();
    toast('🎲 Tip: shake the phone to roll a new take.');
  }, true);

  try { window._bloopsGestures = { roll, stepPart, stepTab }; } catch (e) {}
})();
