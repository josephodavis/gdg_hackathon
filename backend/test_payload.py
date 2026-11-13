"""Run: .venv/bin/python backend/test_payload.py"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from inference import postprocess  # noqa: E402
from make_synthetic import D, DOOR, H, W, make_views  # noqa: E402
from payload import decode_payload, encode_payload  # noqa: E402


def test_roundtrip():
    rng = np.random.default_rng(0)
    for n, extra in [(0, ""), (1, "x"), (1000, "xy"), (12345, "xyz")]:
        xyz = rng.normal(size=(n, 3)).astype(np.float32)
        rgb = rng.integers(0, 256, (n, 3), dtype=np.uint8)
        buf = encode_payload({"version": 1, "pad": extra}, xyz, rgb)
        h, x2, c2 = decode_payload(buf)
        assert h["numPoints"] == n and h["pad"] == extra
        assert np.array_equal(xyz, x2) and np.array_equal(rgb, c2)
        assert len(buf) % 4 == (n * 3) % 4  # positions 4-aligned
    print("roundtrip ok")


def test_alignment(yaw_span):
    header, xyz, _ = postprocess(make_views(yaw_span=yaw_span))
    size = np.array(header["bbox"]["max"]) - np.array(header["bbox"]["min"])
    # Height must be ~H (upright). Horizontal extent depends on yaw, but diagonal is invariant.
    horiz = np.hypot(size[0], size[2])
    print(f"  yaw_span={np.degrees(yaw_span):.0f}° height={size[1]:.3f} (want {H}) horiz={horiz:.2f}")
    assert abs(size[1] - H) < 0.05, size
    assert np.hypot(W, D) - 0.1 < horiz < np.hypot(W, D) * 1.45
    # floor near y=0: lowest 20% of points are within 2 cm of 0
    lo = np.sort(xyz[:, 1])[: len(xyz) // 5]
    assert np.abs(lo).max() < 0.03, np.abs(lo).max()


if __name__ == "__main__":
    test_roundtrip()
    test_alignment(2 * np.pi)
    test_alignment(np.radians(120))  # partial capture: pitch bias must not tilt the room
    print(f"alignment ok (door truth {DOOR['w'] * 100:.0f}x{DOOR['h'] * 100:.0f} cm)")
