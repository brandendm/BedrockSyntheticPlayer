"""A small QR code encoder (byte mode, error correction M, versions 1-10: up to 213 bytes), standard library only, output as an SVG string.
Used for the phone link in the admin panel."""
from __future__ import annotations

# version -> (EC codewords per block, [(blocks, data codewords per block), ...]) for level M
_M = {1: (10, [(1, 16)]), 2: (16, [(1, 28)]), 3: (26, [(1, 44)]), 4: (18, [(2, 32)]), 5: (24, [(2, 43)]), 6: (16, [(4, 27)]),
      7: (18, [(4, 31)]), 8: (22, [(2, 38), (2, 39)]), 9: (22, [(3, 36), (2, 37)]), 10: (26, [(4, 43), (1, 44)])}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]}

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a, b):
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _rs(data: list[int], n: int) -> list[int]:
    gen = [1]
    for i in range(n):
        nxt = [0] * (len(gen) + 1)
        for j, c in enumerate(gen):
            nxt[j] ^= c
            nxt[j + 1] ^= _mul(c, _EXP[i])
        gen = nxt
    rem = [0] * n
    for b in data:
        f = b ^ rem[0]
        rem = rem[1:] + [0]
        for i in range(n):
            rem[i] ^= _mul(gen[i + 1], f)
    return rem


def _bch(value: int, poly: int, deg: int, bits: int) -> int:
    v = value << deg
    for i in range(bits - 1, deg - 1, -1):
        if v >> i & 1:
            v ^= poly << (i - deg)
    return (value << deg) | v


def _codewords(data: bytes) -> tuple[int, list[int]]:
    for ver in range(1, 11):
        ec, groups = _M[ver]
        cap = sum(n * d for n, d in groups)
        cbits = 8 if ver < 10 else 16
        if 4 + cbits + 8 * len(data) <= cap * 8:
            break
    else:
        raise ValueError("too long for this encoder (213 bytes)")
    bits = "0100" + format(len(data), f"0{cbits}b") + "".join(format(b, "08b") for b in data)
    bits += "0" * min(4, cap * 8 - len(bits))
    bits += "0" * (-len(bits) % 8)
    cw = [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]
    pad = [0xEC, 0x11]
    while len(cw) < cap:
        cw.append(pad[(len(cw) - len(bits) // 8) % 2])
    blocks, k = [], 0
    for n, d in groups:
        for _ in range(n):
            blocks.append(cw[k:k + d])
            k += d
    eccs = [_rs(b, ec) for b in blocks]
    out = []
    for i in range(max(len(b) for b in blocks)):
        for b in blocks:
            if i < len(b):
                out.append(b[i])
    for i in range(ec):
        for e in eccs:
            out.append(e[i])
    return ver, out


def _build(ver: int, cws: list[int], mask: int):
    n = 17 + 4 * ver
    mod = [[False] * n for _ in range(n)]
    fn = [[False] * n for _ in range(n)]

    def put(x, y, dark, func=True):
        mod[y][x] = dark
        if func:
            fn[y][x] = True

    # finder + separators
    for cx, cy in ((0, 0), (n - 7, 0), (0, n - 7)):
        for dy in range(-1, 8):
            for dx in range(-1, 8):
                x, y = cx + dx, cy + dy
                if 0 <= x < n and 0 <= y < n:
                    ring = max(abs(dx - 3), abs(dy - 3))
                    put(x, y, ring in (0, 1, 3) if 0 <= dx < 7 and 0 <= dy < 7 else False)
    # timing
    for i in range(8, n - 8):
        put(i, 6, i % 2 == 0)
        put(6, i, i % 2 == 0)
    # alignment
    pos = _ALIGN[ver]
    for ax in pos:
        for ay in pos:
            if (ax == 6 and ay == 6) or (ax == 6 and ay == pos[-1]) or (ax == pos[-1] and ay == 6):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    put(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)
    # format info (M = 00) and dark module
    fmt = _bch((0b00 << 3) | mask, 0x537, 10, 15) ^ 0x5412
    for i in range(15):
        bit = (fmt >> i) & 1 == 1
        if i < 6:
            put(8, i, bit)
        elif i < 8:
            put(8, i + 1, bit)
        elif i == 8:
            put(7, 8, bit)
        else:
            put(14 - i, 8, bit)
        if i < 8:
            put(n - 1 - i, 8, bit)
        else:
            put(8, n - 15 + i, bit)
    put(8, n - 8, True)
    # version info
    if ver >= 7:
        v = _bch(ver, 0x1F25, 12, 18)
        for i in range(18):
            bit = (v >> i) & 1 == 1
            a, b = n - 11 + i % 3, i // 3
            put(a, b, bit)
            put(b, a, bit)
    # data
    bits = [(c >> (7 - i)) & 1 for c in cws for i in range(8)]
    k = 0
    x = n - 1
    up = True
    while x > 0:
        if x == 6:
            x -= 1
        for step in range(n):
            y = n - 1 - step if up else step
            for dx in (0, 1):
                xx = x - dx
                if fn[y][xx]:
                    continue
                bit = bits[k] == 1 if k < len(bits) else False
                k += 1
                if (mask == 0 and (xx + y) % 2 == 0) or (mask == 1 and y % 2 == 0) or (mask == 2 and xx % 3 == 0) or \
                   (mask == 3 and (xx + y) % 3 == 0) or (mask == 4 and (y // 2 + xx // 3) % 2 == 0) or \
                   (mask == 5 and (xx * y) % 2 + (xx * y) % 3 == 0) or (mask == 6 and ((xx * y) % 2 + (xx * y) % 3) % 2 == 0) or \
                   (mask == 7 and ((xx + y) % 2 + (xx * y) % 3) % 2 == 0):
                    bit = not bit
                mod[y][xx] = bit
        x -= 2
        up = not up
    return mod


def _penalty(m) -> int:
    n = len(m)
    p = 0
    for grid in (m, [list(r) for r in zip(*m)]):
        for row in grid:
            run = 1
            for i in range(1, n):
                if row[i] == row[i - 1]:
                    run += 1
                else:
                    if run >= 5:
                        p += run - 2
                    run = 1
            if run >= 5:
                p += run - 2
            s = "".join("1" if c else "0" for c in row)
            p += 40 * (s.count("10111010000") + s.count("00001011101"))
    for y in range(n - 1):
        for x in range(n - 1):
            if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                p += 3
    dark = sum(map(sum, m))
    p += 10 * (abs(dark * 100 // (n * n) - 50) // 5)
    return p


def matrix(text: str) -> list[list[bool]]:
    ver, cws = _codewords(text.encode("utf-8"))
    return min((_build(ver, cws, mk) for mk in range(8)), key=_penalty)


def svg(text: str, scale: int = 8, border: int = 4) -> str:
    m = matrix(text)
    n = len(m)
    size = (n + 2 * border) * scale
    rects = "".join(f'<rect x="{(x + border) * scale}" y="{(y + border) * scale}" width="{scale}" height="{scale}"/>' for y in range(n) for x in range(n) if m[y][x])
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" shape-rendering="crispEdges">'
            f'<rect width="{size}" height="{size}" fill="#fff"/><g fill="#000">{rects}</g></svg>')
