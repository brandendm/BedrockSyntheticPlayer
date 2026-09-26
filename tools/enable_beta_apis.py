"""Turn on the "Beta APIs" experiment in a Bedrock world's level.dat (no client needed).

    python tools/enable_beta_apis.py "<BDS>/worlds/<world>/level.dat"

Bedrock level.dat = 8-byte header (int32 storage version, int32 payload length, little-endian)
followed by a little-endian NBT root compound. Beta APIs is the experiment key "gametest".
Stop the server before running this. A backup is written next to the file.
"""
from __future__ import annotations

import shutil
import struct
import sys
from pathlib import Path

END, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, BYTE_ARRAY, STRING, LIST, COMPOUND, INT_ARRAY, LONG_ARRAY = range(13)


class Reader:
    def __init__(self, b: bytes):
        self.b, self.i = b, 0

    def take(self, fmt: str):
        v = struct.unpack_from("<" + fmt, self.b, self.i)
        self.i += struct.calcsize("<" + fmt)
        return v[0]

    def string(self) -> str:
        n = self.take("H")
        s = self.b[self.i:self.i + n].decode("utf-8", "surrogateescape")
        self.i += n
        return s

    def payload(self, t: int):
        if t == BYTE: return self.take("b")
        if t == SHORT: return self.take("h")
        if t == INT: return self.take("i")
        if t == LONG: return self.take("q")
        if t == FLOAT: return self.take("f")
        if t == DOUBLE: return self.take("d")
        if t == STRING: return self.string()
        if t == BYTE_ARRAY:
            n = self.take("i"); v = self.b[self.i:self.i + n]; self.i += n; return v
        if t == INT_ARRAY: return [self.take("i") for _ in range(self.take("i"))]
        if t == LONG_ARRAY: return [self.take("q") for _ in range(self.take("i"))]
        if t == LIST:
            et, n = self.take("b"), self.take("i")
            return (et, [self.payload(et) for _ in range(n)])
        if t == COMPOUND:
            out = {}
            while True:
                ct = self.take("b")
                if ct == END:
                    return out
                name = self.string()
                out[name] = (ct, self.payload(ct))
        raise ValueError(f"bad tag {t}")


class Writer:
    def __init__(self):
        self.parts: list[bytes] = []

    def put(self, fmt: str, v):
        self.parts.append(struct.pack("<" + fmt, v))

    def string(self, s: str):
        e = s.encode("utf-8", "surrogateescape")
        self.put("H", len(e)); self.parts.append(e)

    def payload(self, t: int, v):
        if t == BYTE: self.put("b", v)
        elif t == SHORT: self.put("h", v)
        elif t == INT: self.put("i", v)
        elif t == LONG: self.put("q", v)
        elif t == FLOAT: self.put("f", v)
        elif t == DOUBLE: self.put("d", v)
        elif t == STRING: self.string(v)
        elif t == BYTE_ARRAY: self.put("i", len(v)); self.parts.append(bytes(v))
        elif t == INT_ARRAY: self.put("i", len(v)); [self.put("i", x) for x in v]
        elif t == LONG_ARRAY: self.put("i", len(v)); [self.put("q", x) for x in v]
        elif t == LIST:
            et, items = v
            self.put("b", et); self.put("i", len(items))
            for x in items: self.payload(et, x)
        elif t == COMPOUND:
            for name, (ct, cv) in v.items():
                self.put("b", ct); self.string(name); self.payload(ct, cv)
            self.put("b", END)
        else:
            raise ValueError(f"bad tag {t}")


def load(path: Path):
    raw = path.read_bytes()
    version, length = struct.unpack_from("<ii", raw, 0)
    r = Reader(raw[8:8 + length])
    assert r.take("b") == COMPOUND, "root is not a compound"
    root_name = r.string()
    return version, root_name, r.payload(COMPOUND)


def save(path: Path, version: int, root_name: str, root: dict):
    w = Writer()
    w.put("b", COMPOUND); w.string(root_name); w.payload(COMPOUND, root)
    body = b"".join(w.parts)
    path.write_bytes(struct.pack("<ii", version, len(body)) + body)


def enable(path: Path) -> bool:
    version, name, root = load(path)
    exp = root.get("experiments", (COMPOUND, {}))[1]
    if exp.get("gametest", (BYTE, 0))[1] == 1:
        return False
    exp["gametest"] = (BYTE, 1)
    exp["experiments_ever_used"] = (BYTE, 1)
    exp["saved_with_toggled_experiments"] = (BYTE, 1)
    root["experiments"] = (COMPOUND, exp)
    shutil.copy2(path, path.with_suffix(".dat.bak"))
    save(path, version, name, root)
    return True


if __name__ == "__main__":
    p = Path(sys.argv[1])
    changed = enable(p)
    _, _, root = load(p)
    exp = {k: v[1] for k, v in root["experiments"][1].items()}
    print(("Enabled" if changed else "Already enabled") + f" Beta APIs in {p}: {exp}")
