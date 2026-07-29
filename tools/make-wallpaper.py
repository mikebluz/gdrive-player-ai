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

import zlib, struct, sys, os

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

# ── primitives ─────────────────────────────────────────────────────────────
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

def px(x, y, c):
    if 0 <= x < W and 0 <= y < H:
        buf[y][x] = c

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
            _ = base

# Deterministic noise — a seeded LCG, so re-running gives the identical file.
_seed = 20260729 + FRAME * 7919      # water only — see the land reseed below
def rnd():
    global _seed
    _seed = (_seed * 1103515245 + 12345) & 0x7FFFFFFF
    return _seed / 0x7FFFFFFF

# ── sky ────────────────────────────────────────────────────────────────────
gradient(0, 74, P['sky_top'], P['sky_mid'])
gradient(74, HORIZON, P['sky_mid'], P['sky_low'])
gradient(HORIZON - 16, HORIZON, P['sky_low'], P['sky_glow'])

# A moon, high and to the left of centre. It sat low over the water at first,
# which put it squarely behind a window at the desktop layout AND read as a
# warm dusk sun that the rest of the palette contradicts. High and pale is
# both truer to the colour scheme and lands in the open gap between the video
# window and the links.
SX, SY, SR = 238, 46, 8
for y in range(SY - SR, SY + SR + 1):
    for x in range(SX - SR, SX + SR + 1):
        d = ((x - SX) ** 2 + ((y - SY) * 1.15) ** 2) ** 0.5
        if d <= SR:
            px(x, y, P['sun'])
        elif d <= SR + 3 and BAYER[y % 4][x % 4] / 16.0 < (SR + 3 - d) / 3 * 0.5:
            px(x, y, mix(P['sky_glow'], P['sun'], 0.5))

# Cloud bars: solid through the middle, dithered only at the ends. Dithering
# the whole bar left them as scattered dashes that read as dirt on the screen
# rather than as cloud.
for cy, cx0, cw in ((72, 34, 120), (92, 206, 132), (58, 250, 78), (108, 16, 76)):
    for x in range(cx0, min(W, cx0 + cw)):
        edge = min(x - cx0, cx0 + cw - x) / 16.0
        for y in (cy, cy + 1, cy + 2):
            if edge >= 1.0 or BAYER[y % 4][x % 4] / 16.0 < edge:
                px(x, y, mix(buf[y][x], P['sky_glow'], 0.5))

# ── sea ────────────────────────────────────────────────────────────────────
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
ridge = []
for x in range(0, 176):
    t = x / 175.0
    base = H - 66 + int(38 * t * t)             # falls away to the right
    n = (rnd() - 0.5) * 3 + (2.4 if (x // 7) % 3 == 0 else 0)
    ridge.append(int(base + n))

for x, top in enumerate(ridge):
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
for x in range(0, 176):
    top = ridge[x]
    if rnd() < 0.5:
        px(x, top - 1, P['foam'])
    if rnd() < 0.25:
        px(x + 1, top - 2, P['foam'])

# spruce stand along the headland
for bx, h in ((14, 30), (27, 22), (38, 34), (52, 24), (63, 18), (78, 27), (92, 16), (104, 21), (120, 13)):
    conifer(bx, ridge[min(bx, 175)] - 1, h, P['tree_dk'], P['tree_md'], P['tree_lt'])

# ── lighthouse, on the right point ─────────────────────────────────────────
LX, LBASE = 344, H - 40
for x in range(LX - 20, LX + 22):                # its own small headland
    t = abs(x - LX) / 21.0
    top = LBASE - int(9 * (1 - t * t))
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
# The beam, thrown left over the water. Continuous and tapering — drawn with
# a per-pixel random gate it came out as a dashed line that read as a mistake
# rather than as light.
for i in range(54):
    bx, by = LX - 6 - i, TOP - 3 - int(i * 0.14)
    if bx < 0 or not (0 <= by < H - 1):
        continue
    a = 0.30 * (1 - i / 54.0)
    px(bx, by, mix(buf[by][bx], P['lamp'], a))
    px(bx, by + 1, mix(buf[by + 1][bx], P['lamp'], a * 0.55))
# keeper's house
for y in range(LBASE - 16, LBASE - 8):
    for x in range(LX + 7, LX + 19):
        px(x, y, P['house'] if y > LBASE - 14 else P['band'])

# ── gulls ──────────────────────────────────────────────────────────────────
for gx, gy in ((148, 38), (161, 30), (139, 52), (312, 26)):
    px(gx, gy, P['gull']); px(gx - 1, gy - 1, P['gull']); px(gx + 1, gy - 1, P['gull'])
    px(gx - 2, gy - 1, P['gull']); px(gx + 2, gy - 1, P['gull'])

# ── encode ─────────────────────────────────────────────────────────────────
def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data +
            struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

raw = b''.join(b'\x00' + bytes(v for pxl in row for v in pxl) for row in buf)
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 9))
       + chunk(b'IEND', b''))

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'img')
os.makedirs(out, exist_ok=True)
stem = 'wallpaper-maine-dusk' if DUSK else 'wallpaper-maine'
name = '%s.png' % stem if FRAME == 0 else '%s-%d.png' % (stem, FRAME)
path = os.path.join(out, name)
with open(path, 'wb') as f:
    f.write(png)
print('%s  %dx%d  %.1f KB' % (name, W, H, len(png) / 1024))
