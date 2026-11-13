"""Synthetic room with known dimensions -> frontend/public/demos/synthetic.bin

Ground truth (meters): room 4.0 (W) x 3.0 (D) x 2.5 (H), door 0.86 x 2.03,
couch 2.0 x 0.9 x 0.85. Goes through the real `postprocess` path starting from a
camera-0 OpenCV frame, so it also tests gravity alignment.

    .venv/bin/python backend/make_synthetic.py
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from inference import postprocess  # noqa: E402
from payload import encode_payload, upsert_manifest  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMOS = os.path.join(ROOT, "frontend", "public", "demos")

W, D, H = 4.0, 3.0, 2.5
DOOR = dict(x0=0.3, w=0.86, h=2.03)  # on back wall z=-D/2
COUCH = dict(x0=-W / 2, x1=-W / 2 + 0.9, z0=-1.0, z1=1.0, h=0.85)


def plane(rng, n, origin, u, v, su, sv):
    a, b = rng.random(n), rng.random(n)
    return origin + np.outer(a * su, u) + np.outer(b * sv, v), a * su, b * sv


def make_room(n_total=300_000, seed=0):
    rng = np.random.default_rng(seed)
    X, Y, Z = np.eye(3)
    dens = n_total / (W * D + 2 * W * H + 2 * D * H)
    P, C = [], []

    # floor: wood planks along x
    p, a, b = plane(rng, int(W * D * dens), np.array([-W / 2, 0, -D / 2]), X, Z, W, D)
    plank = np.floor(b / 0.18).astype(int)
    base = np.array([0.62, 0.45, 0.30]) + 0.06 * ((plank * 7919 % 5)[:, None] / 4 - 0.5)
    under_couch = (p[:, 0] < COUCH["x1"]) & (p[:, 2] > COUCH["z0"]) & (p[:, 2] < COUCH["z1"])
    P.append(p[~under_couch]), C.append(base[~under_couch])

    # back wall (z=-D/2) with door
    p, a, b = plane(rng, int(W * H * dens), np.array([-W / 2, 0, -D / 2]), X, Y, W, H)
    c = np.tile([0.88, 0.86, 0.80], (len(p), 1))
    dx = p[:, 0] - DOOR["x0"]
    door = (dx >= 0) & (dx <= DOOR["w"]) & (p[:, 1] <= DOOR["h"])
    trim = ~door & (dx >= -0.05) & (dx <= DOOR["w"] + 0.05) & (p[:, 1] <= DOOR["h"] + 0.05)
    c[door] = [0.40, 0.24, 0.13]
    c[trim] = [0.98, 0.98, 0.96]
    knob = door & (np.hypot(dx - (DOOR["w"] - 0.08), p[:, 1] - 1.0) < 0.03)
    c[knob] = [0.85, 0.75, 0.3]
    P.append(p), C.append(c)

    # front wall (z=+D/2)
    p, _, _ = plane(rng, int(W * H * dens), np.array([-W / 2, 0, D / 2]), X, Y, W, H)
    P.append(p), C.append(np.tile([0.80, 0.84, 0.88], (len(p), 1)))

    # right wall (x=+W/2) with window
    p, _, _ = plane(rng, int(D * H * dens), np.array([W / 2, 0, -D / 2]), Z, Y, D, H)
    c = np.tile([0.86, 0.88, 0.82], (len(p), 1))
    win = (np.abs(p[:, 2]) < 0.6) & (p[:, 1] > 0.9) & (p[:, 1] < 2.1)
    c[win] = [0.60, 0.78, 0.95]
    P.append(p), C.append(c)

    # left wall (x=-W/2), minus area hidden behind couch
    p, _, _ = plane(rng, int(D * H * dens), np.array([-W / 2, 0, -D / 2]), Z, Y, D, H)
    hidden = (p[:, 1] < COUCH["h"]) & (p[:, 2] > COUCH["z0"]) & (p[:, 2] < COUCH["z1"])
    P.append(p[~hidden]), C.append(np.tile([0.90, 0.85, 0.80], ((~hidden).sum(), 1)))

    # couch: top, front face, two ends
    cw, cd, chh = COUCH["z1"] - COUCH["z0"], COUCH["x1"] - COUCH["x0"], COUCH["h"]
    cn = int(dens * 1.5)
    couch_col = [0.28, 0.36, 0.52]
    for origin, u, v, su, sv in [
        ([COUCH["x0"], chh, COUCH["z0"]], X, Z, cd, cw),
        ([COUCH["x1"], 0, COUCH["z0"]], Z, Y, cw, chh),
        ([COUCH["x0"], 0, COUCH["z0"]], X, Y, cd, chh),
        ([COUCH["x0"], 0, COUCH["z1"]], X, Y, cd, chh),
    ]:
        p, _, _ = plane(rng, int(cn * su * sv), np.array(origin), u, v, su, sv)
        P.append(p), C.append(np.tile(couch_col, (len(p), 1)))

    pts = np.concatenate(P)
    cols = np.concatenate(C)
    pts += rng.normal(0, 0.003, pts.shape)
    cols = np.clip(cols + rng.normal(0, 0.03, cols.shape), 0, 1)
    return pts, cols


def look_c2w(pos, yaw, pitch, roll=0.0):
    """OpenCV cam2world (x right, y down, z forward) in a Y-up world."""
    fwd = np.array([np.sin(yaw) * np.cos(pitch), np.sin(pitch), -np.cos(yaw) * np.cos(pitch)])
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    cr, sr = np.cos(roll), np.sin(roll)
    right, down = cr * right + sr * down, -sr * right + cr * down
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, down, fwd, pos
    return m


def make_cameras(n=16, yaw_span=2 * np.pi, seed=1):
    rng = np.random.default_rng(seed)
    cams = []
    for i in range(n):
        yaw = yaw_span * i / n + rng.normal(0, 0.05)
        pos = np.array([0.8 * np.sin(yaw) * 0.5, 1.45 + rng.normal(0, 0.05), 0.3 * np.cos(yaw)])
        cams.append(look_c2w(pos, yaw, np.radians(-12 + rng.normal(0, 4)), np.radians(rng.normal(0, 2))))
    return np.stack(cams)


def make_views(yaw_span=2 * np.pi, n_cams=16, seed=0):
    """Synthetic 'MapAnything output' expressed in camera-0's OpenCV frame."""
    pts, cols = make_room(seed=seed)
    c2ws = make_cameras(n_cams, yaw_span)
    to_cam0 = np.linalg.inv(c2ws[0])
    pts_cv = pts @ to_cam0[:3, :3].T + to_cam0[:3, 3]
    c2ws_cv = to_cam0 @ c2ws
    K = np.array([[400.0, 0, 259], [0, 400.0, 196], [0, 0, 1]])
    split = np.array_split(np.random.default_rng(seed).permutation(len(pts)), n_cams)
    return [
        {
            "pts": pts_cv[idx],
            "conf": np.ones(len(idx)),
            "mask": np.ones(len(idx), bool),
            "rgb": cols[idx],
            "c2w": c2ws_cv[i],
            "K": K,
            "width": 518,
            "height": 392,
            "metric_scale": 1.0,
        }
        for i, idx in enumerate(split)
    ]


if __name__ == "__main__":
    header, xyz, rgb = postprocess(make_views())
    os.makedirs(DEMOS, exist_ok=True)
    out = os.path.join(DEMOS, "synthetic.bin")
    with open(out, "wb") as f:
        f.write(encode_payload(header, xyz, rgb))
    upsert_manifest(
        os.path.join(DEMOS, "demos.json"),
        "synthetic",
        "Synthetic room (4×3×2.5 m, door 86×203 cm)",
        "synthetic.bin",
    )
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB)")
