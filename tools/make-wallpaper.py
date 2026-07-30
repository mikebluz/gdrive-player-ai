#!/usr/bin/env python3
"""
Generate the desktop wallpaper: a pixel-art Maine coastline.

    python3 tools/make-wallpaper.py            # → img/wallpaper-maine.png
    python3 tools/make-wallpaper.py --dusk     # warmer variant

Written as a GENERATOR rather than committed as a finished image so the
composition stays editable — move the horizon, add an island, change the hour
of the day, re-run. Output is a small indexed-feeling RGB PNG at 384x216 that
the page scales up with `image-rendering: pixelated`, which is what keeps the
pixels crisp instead of smeared.

No third-party imaging library is available here, so the PNG is encoded by
hand: signature, IHDR, one zlib-compressed IDAT of filter-0 scanlines, IEND.

Palette is tied to the site's forest-green scheme deliberately — the desktop
behind the windows should read as one surface with them, not as a photo
someone pasted on.
"""

import zlib, struct, sys, os, math

W, H = 384, 216
HORIZON = 122                      # low, so the busy part sits under the windows
DUSK = '--dusk' in sys.argv

# Frame cycling. The sea is the only thing that moves: --frame N re-rolls the
# chop and the moon path and leaves everything else pixel-identical, so the
# frames can be stepped through as an animation without any other part of the
# scene twitching. This is how water is animated in the games this borrows
# from — a few frames on a loop, not a shader.
FRAME = 0
for _a in sys.argv:
    if _a.startswith('--frame='):
        FRAME = int(_a.split('=')[1])

# LAYERS. The moon rises, so it cannot be baked into a single flat image — it
# has to come up from BEHIND the sea, which means three stacked pieces:
#
#   --layer=sky    sky gradient and cloud bars. Opaque, static, drawn first.
#   --layer=moon   the disc and its halo alone, on transparency, so the page
#                  can slide it upward independently of everything else.
#   --layer=water  the sea alone — gradient, chop, moon path — transparent
#                  above the waterline, so it occludes the moon while the moon
#                  is still below the horizon.
#   --layer=land   islands, granite, spruces, lighthouse, gulls, on
#                  transparency. It sits ABOVE the traffic, so a boat passes
#                  BEHIND the headland and out from behind an island rather
#                  than sliding over the top of them.
#   --sprite=NAME  one piece of traffic (boat | loon | whale) alone on a full
#                  transparent canvas, drawn at the height it belongs at, so
#                  the page only has to slide it sideways.
#
# --layer=sea still means water+land together, which is what the single-image
# renders use.
#
# --layer=all keeps the old single-image behaviour, which is what the --dusk
# variant and any still render still use.
LAYER = 'all'
SPRITE = ''
for _a in sys.argv:
    if _a.startswith('--layer='):
        LAYER = _a.split('=')[1]
    if _a.startswith('--sprite='):
        LAYER, SPRITE = 'sprite', _a.split('=')[1]
SKY   = LAYER in ('all', 'sky')
MOON  = LAYER in ('all', 'moon')
WATER = LAYER in ('all', 'sea', 'water')
LAND  = LAYER in ('all', 'sea', 'land')
SEA   = WATER or LAND

# ── palette ────────────────────────────────────────────────────────────────
# Values are deliberately LOW and close together. This is a wallpaper: windows
# sit on top of it, so it has to read as scenery at a glance and then get out
# of the way. An earlier pass with a bright sea and dense chop looked like
# static at 4x and fought the window chrome. Only the sun and the lighthouse
# lamp are allowed to be bright, because they are the two things the eye
# should find.
# Values are LOW-CONTRAST but no longer dark. This is a wallpaper: windows sit
# on top of it, so it has to read as scenery at a glance and then get out of
# the way. What made an early pass look like static at 4x was the chop DENSITY
# and the spread between the sea's lightest and darkest values — not the
# overall brightness. So the whole set was lifted together, keeping the
# intervals between neighbouring values roughly where they were.
P = {
    'sky_top':  (16, 42, 31),
    'sky_mid':  (24, 60, 45),
    'sky_low':  (38, 88, 66),
    'sky_glow': (72, 128, 96),
    'sun':      (208, 226, 198),
    'far_isle': (20, 50, 37),
    'mid_isle': (14, 38, 28),
    'sea_far':  (48, 100, 79),
    'sea_mid':  (32, 74, 59),
    'sea_near': (22, 55, 44),
    'sea_deep': (16, 41, 34),
    'glint':    (90, 154, 122),
    'foam':     (156, 188, 164),
    'rock_dk':  (28, 37, 30),
    'rock_md':  (50, 63, 51),
    'rock_lt':  (80, 97, 79),
    'tree_dk':  (12, 32, 21),
    'tree_md':  (23, 60, 39),
    'tree_lt':  (37, 88, 57),
    'trunk':    (32, 27, 22),
    'house':    (210, 220, 208),
    'band':     (166, 62, 38),
    'lamp':     (240, 170, 86),
    'gull':     (176, 194, 178),
}
if DUSK:                            # warmer sky, same sea
    P['sky_low']  = (86, 74, 52)
    P['sky_glow'] = (150, 112, 70)
    P['sun']      = (246, 200, 130)
    P['glint']    = (198, 158, 110)

buf = [[P['sky_top']] * W for _ in range(H)]
# Alpha is tracked per pixel so the moon and sea layers can be transparent
# wherever nothing was drawn. The sky layer is opaque by definition.
alpha = [[255 if SKY else 0] * W for _ in range(H)]

# ── primitives ─────────────────────────────────────────────────────────────
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

def px(x, y, c, a=255):
    if 0 <= x < W and 0 <= y < H:
        buf[y][x] = c
        alpha[y][x] = a

def band(y0, y1, c):
    for y in range(max(0, y0), min(H, y1)):
        for x in range(W):
            buf[y][x] = c

def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def gradient(y0, y1, top, bot):
    """Vertical ramp, ordered-dithered so it bands like real pixel art rather
    than fading like a JPEG."""
    for y in range(max(0, y0), min(H, y1)):
        t = (y - y0) / max(1, (y1 - y0 - 1))
        for x in range(W):
            base = mix(top, bot, t)
            # nudge one step up or down by the dither threshold
            n = (BAYER[y % 4][x % 4] / 16.0 - 0.5) * 0.10
            buf[y][x] = mix(top, bot, min(1, max(0, t + n)))
            alpha[y][x] = 255
            _ = base

# Deterministic noise — a seeded LCG, so re-running gives the identical file.
_seed = 20260729 + FRAME * 7919      # water only — see the land reseed below
def rnd():
    global _seed
    _seed = (_seed * 1103515245 + 12345) & 0x7FFFFFFF
    return _seed / 0x7FFFFFFF

# ── sky ────────────────────────────────────────────────────────────────────
if SKY:
    gradient(0, 74, P['sky_top'], P['sky_mid'])
    gradient(74, HORIZON, P['sky_mid'], P['sky_low'])
    gradient(HORIZON - 16, HORIZON, P['sky_low'], P['sky_glow'])
    # The sky layer sits behind everything and is the only opaque one, so it
    # has to cover the full canvas — the sea layer's transparency would
    # otherwise show the page through the bottom half.
    for _y in range(HORIZON, H):
        for _x in range(W):
            buf[_y][_x] = P['sky_glow']

# A moon, high and to the left of centre. It sat low over the water at first,
# which put it squarely behind a window at the desktop layout AND read as a
# warm dusk sun that the rest of the palette contradicts. High and pale is
# both truer to the colour scheme and lands in the open gap between the video
# window and the links.
# On its own layer the moon sits near the TOP of the canvas; the page slides
# the whole layer up from below the horizon, so this is where it ends up.
SX, SY, SR = (238, 46, 8) if LAYER == 'all' else (238, 30, 8)
if MOON:
    for y in range(SY - SR, SY + SR + 1):
        for x in range(SX - SR, SX + SR + 1):
            d = ((x - SX) ** 2 + ((y - SY) * 1.15) ** 2) ** 0.5
            if d <= SR:
                px(x, y, P['sun'])
            elif d <= SR + 3 and BAYER[y % 4][x % 4] / 16.0 < (SR + 3 - d) / 3 * 0.5:
                # On its own layer the halo must be ALPHA rather than a blend
                # toward the sky colour: the sky is a gradient and the moon
                # travels through it, so a baked blend would only match at one
                # height. In the single-image render it stays a blend.
                if LAYER == 'moon':
                    px(x, y, P['sun'], 110)
                else:
                    px(x, y, mix(P['sky_glow'], P['sun'], 0.5))

# Cloud bars: solid through the middle, dithered only at the ends. Dithering
# the whole bar left them as scattered dashes that read as dirt on the screen
# rather than as cloud.
for cy, cx0, cw in (((72, 34, 120), (92, 206, 132), (58, 250, 78), (108, 16, 76)) if SKY else ()):
    for x in range(cx0, min(W, cx0 + cw)):
        edge = min(x - cx0, cx0 + cw - x) / 16.0
        for y in (cy, cy + 1, cy + 2):
            if edge >= 1.0 or BAYER[y % 4][x % 4] / 16.0 < edge:
                px(x, y, mix(buf[y][x], P['sky_glow'], 0.5))

# ── sea ────────────────────────────────────────────────────────────────────
# Everything from here to the encoder is the FOREGROUND, in two halves: the
# WATER (gradient, chop, moon path) and then the LAND that stands in front of
# it. They are separate layers so animated traffic can be sandwiched between.
if WATER:
  gradient(HORIZON, HORIZON + 22, P['sea_far'], P['sea_mid'])
  gradient(HORIZON + 22, HORIZON + 54, P['sea_mid'], P['sea_near'])
  gradient(HORIZON + 54, H, P['sea_near'], P['sea_deep'])

  # Horizontal chop: short dashes, longer and sparser toward the foreground.
  # Kept deliberately thin — the density here is what decides whether the sea
  # reads as water or as noise, and every increase costs legibility.
  y = HORIZON + 2
  while y < H:
      density = 0.010 + (y - HORIZON) / (H - HORIZON) * 0.022
      ln = 3 + int((y - HORIZON) / 10)
      x = 0
      while x < W:
          if rnd() < density:
              c = P['glint'] if y < HORIZON + 26 else mix(P['sea_mid'], P['glint'], 0.5)
              for k in range(ln):
                  px(x + k, y, c)
              x += ln
          x += 1
      y += 3

  # Sun glitter — a narrow column of light under the sun. A wide one turned into
  # a blob of static, so this stays close to the sun's own width and thins out
  # fast with distance.
  for y in range(HORIZON + 1, H, 2):
      t = (y - HORIZON) / float(H - HORIZON)
      spread = 4 + int(t * 30)
      for _ in range(3):
          gx = SX + int((rnd() - 0.5) * spread * 2)
          if rnd() > 0.72 - t * 0.30:
              continue
          # dashes, not dots — moonlight breaks along the chop, and single
          # pixels at this scale just look like dust
          ln = 2 + int(rnd() * (2 + t * 4))
          c = P['sun'] if t < 0.18 else mix(P['glint'], P['sun'], max(0, .55 - t))
          for k in range(ln):
              px(gx + k, y, c)

# Reseed to a CONSTANT. Everything below draws with rnd() too — islands, the
# granite ridge, foam, spruces — and if it inherited the per-frame water seed
# the whole coastline would jitter between frames instead of only the sea.
_seed = 11061980

if LAND:

  # ── land ───────────────────────────────────────────────────────────────────
  def conifer(bx, by, h, dark, mid, lite):
      """A spruce: stacked tiers, widest at the base."""
      tiers = max(2, h // 4)
      for t in range(tiers):
          ty = by - int(h * (t + 1) / tiers)
          wdt = max(1, int((h / 3.4) * (1 - t / (tiers + 0.6))))
          for x in range(bx - wdt, bx + wdt + 1):
              for yy in range(ty, ty + max(2, h // tiers)):
                  if yy > by:
                      continue
                  shade = lite if (x < bx - wdt // 3 and rnd() < .5) else (dark if x > bx + wdt // 3 else mid)
                  px(x, yy, shade)
      for yy in range(by - 1, by + 2):
          px(bx, yy, dark)

  def islet(cx, base, wdt, ht, col, treed=True):
      """A low island: a soft hump with a ragged tree line."""
      for x in range(cx - wdt, cx + wdt + 1):
          t = abs(x - cx) / wdt
          top = base - int(ht * (1 - t * t) ** 0.7)
          top += int((rnd() - 0.5) * 2)
          for y in range(top, base + 1):
              px(x, y, col)
          if treed and rnd() < 0.30 and top < base - 1:
              hh = 2 + int(rnd() * 3)
              for y in range(top - hh, top):
                  px(x, y, col)

  # far islands, sitting right on the horizon
  islet(58, HORIZON, 46, 7, P['far_isle'])
  islet(150, HORIZON, 30, 5, P['far_isle'])
  islet(330, HORIZON, 40, 6, P['far_isle'])
  islet(232, HORIZON + 1, 18, 4, P['mid_isle'])

  # ── foreground headland, bottom-left ──────────────────────────────────────
  # Granite: a ridge line with lit tops and dark flanks, then tide line beneath.
  # The ridge used to stop dead at x=175, leaving a vertical cliff where the
  # land simply ended — the straight edge that made the whole mass read as a
  # rectangle. It now continues until the ridge line sinks past the bottom of
  # the canvas, so the shore RUNS OUT into the water on its own.
  #
  # Two scales of noise, because one is what made it look machined: a slow
  # undulation for the shape of the shoreline and a fine jitter for the granite.
  SHORE = 236
  ridge = []
  for x in range(0, SHORE):
      t = x / 175.0
      base = H - 66 + int(38 * t * t)             # falls away to the right
      n = (rnd() - 0.5) * 3 + (2.4 if (x // 7) % 3 == 0 else 0)
      n += 3.4 * math.sin(x * 0.051) + 2.0 * math.sin(x * 0.129 + 1.7)
      ridge.append(int(base + n))

  for x, top in enumerate(ridge):
      if top >= H:                                 # sunk below the waterline
          continue
      for y in range(top, H):
          d = y - top
          if d < 2:
              c = P['rock_lt']
          elif d < 6:
              c = P['rock_md'] if BAYER[y % 4][x % 4] > 5 else P['rock_lt']
          else:
              c = P['rock_dk'] if BAYER[y % 4][x % 4] > 3 else P['rock_md']
          px(x, y, c)

  # foam where the rock meets the water
  for x in range(0, SHORE):
      top = ridge[x]
      if top >= H:
          continue
      if rnd() < 0.5:
          px(x, top - 1, P['foam'])
      if rnd() < 0.25:
          px(x + 1, top - 2, P['foam'])

  # spruce stand along the headland
  for bx, h in ((14, 30), (27, 22), (38, 34), (52, 24), (63, 18), (78, 27), (92, 16), (104, 21), (120, 13)):
      conifer(bx, ridge[min(bx, SHORE - 1)] - 1, h, P['tree_dk'], P['tree_md'], P['tree_lt'])

  # ── lighthouse, on the right point ─────────────────────────────────────────
  LX, LBASE = 344, H - 40
  # The island is centred on the MIDPOINT of tower and keeper's house, not on
  # the tower, and its crown is cubic rather than quadratic so the top is flat
  # instead of domed. The first version was a narrow dome under the tower: the
  # house, eleven pixels to its right, stood on water.
  ISLE_C, ISLE_W, ISLE_H = LX + 5, 33, 10
  for x in range(ISLE_C - ISLE_W, ISLE_C + ISLE_W + 1):
      d = abs(x - ISLE_C) / float(ISLE_W)
      top = LBASE - int(ISLE_H * (1 - d ** 3))
      top += int((rnd() - 0.5) * 1.6)              # a rock, not an arch
      for y in range(top, H):
          px(x, y, P['rock_dk'] if BAYER[y % 4][x % 4] > 4 else P['rock_md'])

  TOP = LBASE - 32
  for y in range(TOP, LBASE - 8):                  # tower, tapering
      t = (y - TOP) / float(LBASE - 8 - TOP)
      hw = 3 + int(t * 2)
      for x in range(LX - hw, LX + hw + 1):
          px(x, y, P['house'] if x < LX + hw else mix(P['house'], P['rock_dk'], .35))
  for y in range(TOP + 11, TOP + 15):              # red band
      for x in range(LX - 4, LX + 5):
          px(x, y, P['band'])
  for y in range(TOP - 5, TOP):                    # lantern room
      for x in range(LX - 3, LX + 4):
          px(x, y, P['lamp'] if TOP - 4 <= y <= TOP - 2 else P['rock_dk'])
  for x in range(LX - 4, LX + 5):
      px(x, TOP - 6, P['rock_dk'])
  # The beam is NOT drawn here any more — it is its own layer so the page can
  # rotate it about the lamp. See --sprite=beam.
  # keeper's house
  for y in range(LBASE - 16, LBASE - 8):
      for x in range(LX + 7, LX + 19):
          px(x, y, P['house'] if y > LBASE - 14 else P['band'])

  # ── gulls ──────────────────────────────────────────────────────────────────
  for gx, gy in ((148, 38), (161, 30), (139, 52), (312, 26)):
      px(gx, gy, P['gull']); px(gx - 1, gy - 1, P['gull']); px(gx + 1, gy - 1, P['gull'])
      px(gx - 2, gy - 1, P['gull']); px(gx + 2, gy - 1, P['gull'])

# ── TRAFFIC ────────────────────────────────────────────────────────────────
# One piece of traffic per canvas, drawn at the height it belongs at, so the
# page only has to slide it sideways. Full-canvas rather than a tight sprite
# because that keeps the coordinate space identical to every other layer — no
# scaling maths to keep in sync when the wallpaper is `cover`-fitted.
#
# All three sit BETWEEN water and land, so they pass behind the headland, the
# spruces and the islands instead of over them. That is the whole reason the
# sea was split in two.
if LAYER == 'sprite':
    hull = P['rock_dk']; trim = P['foam']; wake = P['glint']

    if SPRITE == 'boat':
        # A lobster boat in the middle distance: low hull, small wheelhouse,
        # a short mast. Twelve pixels of it, which at 4x is plenty to read.
        BX, BY = 180, 138
        for x in range(BX, BX + 13):                       # hull
            px(x, BY, hull); px(x, BY + 1, hull)
        for x in range(BX + 1, BX + 12): px(x, BY + 2, hull)
        for x in range(BX + 3, BX + 8):                    # wheelhouse
            px(x, BY - 3, hull); px(x, BY - 2, hull)
        px(BX + 4, BY - 4, hull); px(BX + 5, BY - 4, hull)
        px(BX + 10, BY - 4, hull); px(BX + 10, BY - 3, hull)   # mast
        px(BX + 10, BY - 5, hull)
        px(BX + 4, BY - 3, trim); px(BX + 5, BY - 3, trim)     # lit window
        for k in range(6):                                     # wake
            if k % 2 == 0: px(BX - 2 - k, BY + 2, wake)

    elif SPRITE == 'loon':
        # Loons ride LOW — a long body barely above the surface and a black head
        # held up on a straight neck. The silhouette is the whole trick, so this
        # is drawn bigger than scale and placed in the MID water: the first pass
        # sat it in the near water, where a dark bird on the dark end of the sea
        # gradient was a smudge rather than a shape.
        LX2, LY = 250, 158
        for x in range(LX2, LX2 + 10): px(x, LY, hull)         # waterline
        for x in range(LX2 + 1, LX2 + 9): px(x, LY + 1, hull)  # body below it
        for x in range(LX2 + 2, LX2 + 7): px(x, LY - 1, hull)  # rounded back
        px(LX2 + 8, LY - 1, hull)                              # neck
        px(LX2 + 8, LY - 2, hull); px(LX2 + 8, LY - 3, hull)
        px(LX2 + 8, LY - 4, hull); px(LX2 + 9, LY - 4, hull)   # head
        px(LX2 + 10, LY - 4, hull)                             # bill
        px(LX2 + 3, LY, trim); px(LX2 + 5, LY, trim)           # flank checks
        for k in (2, 4, 7):                                    # wake
            px(LX2 - k, LY + 1, wake)

    elif SPRITE == 'whale':
        # Mid-breach: the body clear of the surface at an angle, flukes still
        # low. Drawn once at the top of its arc — the page throws the arc.
        WX, WY = 300, 150
        body = [(0,7),(1,6),(2,5),(3,4),(4,3),(5,2),(6,2),(7,1),(8,1),(9,1),(10,2),(11,3)]
        for dx, dy in body:
            for t in range(4):
                px(WX + dx, WY + dy + t, hull)
        px(WX + 12, WY + 4, hull); px(WX + 12, WY + 5, hull)   # tail stock
        px(WX + 13, WY + 6, hull); px(WX + 14, WY + 7, hull)   # flukes
        px(WX + 13, WY + 8, hull); px(WX + 15, WY + 8, hull)
        px(WX + 2, WY + 6, trim); px(WX + 3, WY + 6, trim)     # pale flank
        for k in range(5):                                     # spray
            px(WX - 1 - k, WY + 9 + (k // 2), wake)

    elif SPRITE == 'ufo':
        # A saucer, high in the sky. Drawn small and hard-edged: at this size a
        # dome, a hull and three lights is the whole vocabulary, and anything
        # more becomes mush at 4x.
        UX, UY = 190, 62
        for x in range(UX - 7, UX + 8): px(x, UY, P['rock_dk'])          # hull
        for x in range(UX - 5, UX + 6): px(x, UY + 1, P['rock_dk'])
        for x in range(UX - 3, UX + 4): px(x, UY - 1, P['house'])        # dome
        px(UX - 2, UY - 2, P['house']); px(UX - 1, UY - 2, P['house'])
        px(UX, UY - 2, P['house']); px(UX + 1, UY - 2, P['house'])
        for x in (UX - 4, UX, UX + 4): px(x, UY + 1, P['lamp'])          # lights
        px(UX - 9, UY, P['glint']); px(UX + 9, UY, P['glint'])           # motion streak
        px(UX - 11, UY, P['glint'])

    elif SPRITE == 'beam':
        # The lighthouse beam, on its own layer so the page can ROTATE it about
        # the lamp. Drawn pointing left and level; the CSS spins it and gates
        # its opacity so it only shows on the sweep across the water.
        LXb, TOPb = 344, (H - 40) - 32
        for i in range(62):
            bx, by = LXb - 6 - i, TOPb - 3
            if bx < 0:
                continue
            a = int(150 * (1 - i / 62.0))          # tapers out with distance
            px(bx, by, P['lamp'], a)
            px(bx, by + 1, P['lamp'], int(a * 0.5))

    elif SPRITE == 'sail':
        # A sloop: hull, mast, one triangular main. Sails read at this size far
        # better than hulls do, which is why it is mostly sail.
        SX2, SY2 = 120, 146
        for x in range(SX2, SX2 + 9): px(x, SY2, hull)
        for x in range(SX2 + 1, SX2 + 8): px(x, SY2 + 1, hull)
        for y in range(SY2 - 12, SY2): px(SX2 + 6, y, hull)      # mast
        for k in range(11):                                       # mainsail
            for x in range(SX2 + 6 - 1 - int(k * 0.55), SX2 + 6):
                px(x, SY2 - 12 + k + 1, trim)
        px(SX2 - 2, SY2 + 1, wake); px(SX2 - 4, SY2 + 1, wake)

    elif SPRITE == 'buoy':
        # A channel marker. It does not go anywhere — it just bobs, which is
        # what makes the moving traffic read as moving.
        BX2, BY2 = 210, 168
        for y in range(BY2 - 6, BY2 + 2): px(BX2, y, hull); px(BX2 + 1, y, hull)
        px(BX2, BY2 - 7, P['band']); px(BX2 + 1, BY2 - 7, P['band'])
        px(BX2, BY2 - 4, P['band']); px(BX2 + 1, BY2 - 4, P['band'])
        px(BX2 - 1, BY2 + 1, wake); px(BX2 + 2, BY2 + 1, wake)

    elif SPRITE == 'seal':
        # A head and a shoulder — a seal is mostly underwater, so most of the
        # drawing is what is NOT there.
        EX, EY = 80, 172
        for x in range(EX, EX + 6): px(x, EY, hull)
        px(EX + 1, EY - 1, hull); px(EX + 2, EY - 1, hull)
        px(EX + 5, EY - 1, hull); px(EX + 6, EY - 1, hull)       # head
        px(EX + 7, EY - 1, hull)
        px(EX + 6, EY - 2, hull)
        px(EX - 2, EY, wake); px(EX - 4, EY, wake)

    elif SPRITE == 'ferry':
        # Bigger, slower, further out — right up against the horizon so it
        # reads as distance rather than as a second lobster boat.
        FX, FY = 60, 127
        for x in range(FX, FX + 22): px(x, FY, hull); px(x, FY + 1, hull)
        for x in range(FX + 3, FX + 19): px(x, FY - 1, hull)
        for x in range(FX + 5, FX + 15): px(x, FY - 3, hull); px(x, FY - 2, hull)
        px(FX + 17, FY - 3, hull); px(FX + 17, FY - 4, hull)     # funnel
        for x in (FX + 6, FX + 9, FX + 12): px(x, FY - 2, trim)  # lit windows

# ── encode ─────────────────────────────────────────────────────────────────
def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data +
            struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

# The sky layer is opaque RGB (colour type 2); the moon and sea layers carry
# an alpha channel (type 6) so they can stack.
if SKY:
    raw = b''.join(b'\x00' + bytes(v for pxl in row for v in pxl) for row in buf)
    ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)
else:
    raw = b''.join(b'\x00' + bytes(v for x, pxl in enumerate(row)
                                   for v in (pxl[0], pxl[1], pxl[2], alpha[y][x]))
                   for y, row in enumerate(buf))
    ihdr = struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', ihdr)
       + chunk(b'IDAT', zlib.compress(raw, 9))
       + chunk(b'IEND', b''))

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'img')
os.makedirs(out, exist_ok=True)
stem = 'wallpaper-maine-dusk' if DUSK else 'wallpaper-maine'
if LAYER == 'sky':      name = 'wp-sky.png'
elif LAYER == 'moon':   name = 'wp-moon.png'
elif LAYER == 'water':  name = 'wp-water-%d.png' % FRAME
elif LAYER == 'land':   name = 'wp-land.png'
elif LAYER == 'sprite': name = 'wp-%s.png' % SPRITE
elif LAYER == 'sea':    name = 'wp-sea-%d.png' % FRAME
else:                 name = '%s.png' % stem if FRAME == 0 else '%s-%d.png' % (stem, FRAME)
path = os.path.join(out, name)
with open(path, 'wb') as f:
    f.write(png)
print('%s  %dx%d  %.1f KB' % (name, W, H, len(png) / 1024))
