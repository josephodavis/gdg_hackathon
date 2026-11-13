"""Binary payload format shared by backend and frontend (see PLAN.md §4).

Layout (little-endian):
    uint32 headerLength | header JSON (utf-8) | zero pad to 4-byte boundary |
    float32 xyz [N,3] (meters, Y-up) | uint8 rgb [N,3]
"""

import json
import struct

import numpy as np


def encode_payload(header: dict, xyz: np.ndarray, rgb: np.ndarray) -> bytes:
    xyz = np.ascontiguousarray(xyz, dtype="<f4").reshape(-1, 3)
    rgb = np.ascontiguousarray(rgb, dtype=np.uint8).reshape(-1, 3)
    if len(xyz) != len(rgb):
        raise ValueError(f"xyz/rgb length mismatch: {len(xyz)} vs {len(rgb)}")
    header = {**header, "numPoints": int(len(xyz))}
    hbytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    pad = (-(4 + len(hbytes))) % 4
    return b"".join(
        [struct.pack("<I", len(hbytes)), hbytes, b"\x00" * pad, xyz.tobytes(), rgb.tobytes()]
    )


def decode_payload(buf: bytes):
    (hlen,) = struct.unpack_from("<I", buf, 0)
    header = json.loads(buf[4 : 4 + hlen].decode("utf-8"))
    off = 4 + hlen
    off += (-off) % 4
    n = header["numPoints"]
    xyz = np.frombuffer(buf, dtype="<f4", count=n * 3, offset=off).reshape(n, 3)
    off += n * 12
    rgb = np.frombuffer(buf, dtype=np.uint8, count=n * 3, offset=off).reshape(n, 3)
    return header, xyz, rgb


def upsert_manifest(manifest_path, demo_id: str, name: str, file: str):
    """Add/replace an entry in frontend/public/demos/demos.json."""
    import os

    items = []
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            items = json.load(f)
    items = [d for d in items if d["id"] != demo_id] + [{"id": demo_id, "name": name, "file": file}]
    with open(manifest_path, "w") as f:
        json.dump(items, f, indent=2)
