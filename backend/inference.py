"""MapAnything inference + post-processing.

`run_model` needs torch/mapanything (GPU container only). Everything else is
numpy-only so it can be tested locally on the Mac.
"""

import time

import numpy as np

MAX_POINTS = 400_000
CONF_PERCENTILE = 20
MODEL_ID = "facebook/map-anything-apache"


# --------------------------------------------------------------------------- GPU side
def load_model(device="cuda"):
    from mapanything.models import MapAnything

    return MapAnything.from_pretrained(MODEL_ID).to(device).eval()


def run_model(model, paths):
    """paths -> (views as numpy dicts, timing dict)."""
    import torch
    from mapanything.utils.image import load_images

    t0 = time.perf_counter()
    views = load_images([str(p) for p in paths])
    t1 = time.perf_counter()
    with torch.no_grad():
        preds = model.infer(
            views,
            memory_efficient_inference=True,
            use_amp=True,
            amp_dtype="bf16",
            apply_mask=True,
            mask_edges=True,
        )
    torch.cuda.synchronize()
    t2 = time.perf_counter()
    out = [_pred_to_numpy(p) for p in preds]
    return out, {"load": round((t1 - t0) * 1000), "infer": round((t2 - t1) * 1000)}


def _pred_to_numpy(pred):
    def f(key):
        return pred[key][0].detach().float().cpu().numpy()

    pts = f("pts3d")  # (H,W,3)
    h, w = pts.shape[:2]
    msf = pred.get("metric_scaling_factor")
    return {
        "pts": pts,
        "conf": f("conf"),  # (H,W)
        "mask": f("mask")[..., 0] > 0.5,  # (H,W)
        "rgb": f("img_no_norm"),  # (H,W,3) 0..1
        "c2w": f("camera_poses"),  # (4,4) OpenCV cam2world
        "K": f("intrinsics"),  # (3,3)
        "width": int(w),
        "height": int(h),
        "metric_scale": float(msf.float().mean()) if msf is not None else None,
    }


# --------------------------------------------------------------------------- numpy side
def _normalize(v):
    return v / (np.linalg.norm(v) + 1e-12)


def rotation_a_to_b(a, b):
    """Rotation matrix mapping unit vector a onto unit vector b (Rodrigues)."""
    a, b = _normalize(a), _normalize(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:  # opposite: rotate 180° about any axis perpendicular to a
        axis = _normalize(np.cross(a, [1.0, 0, 0] if abs(a[0]) < 0.9 else [0, 1.0, 0]))
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def estimate_up(c2ws):
    """Gravity 'up' in world coords from OpenCV cam2world poses.

    Phones are held roughly level (no roll) but pitched up/down, so each camera's
    right axis (+X) is ~horizontal: up = direction most perpendicular to all of
    them. Falls back to mean of camera up axes (-Y) when yaw spread is too small.
    """
    rights = c2ws[:, :3, 0]
    ups = -c2ws[:, :3, 1]
    mean_up = _normalize(ups.mean(0))
    _, s, vt = np.linalg.svd(rights)
    if len(c2ws) >= 3 and s[1] > 0.2 * s[0]:
        up = vt[2]
        method = "right-axes-svd"
    else:
        xm = _normalize(rights.mean(0))
        up = mean_up - np.dot(mean_up, xm) * xm
        method = "mean-up"
    up = _normalize(up)
    if np.dot(up, mean_up) < 0:
        up = -up
    if np.degrees(np.arccos(np.clip(np.dot(up, mean_up), -1, 1))) > 45:
        up, method = mean_up, "mean-up(fallback)"
    return up, method


def refine_floor(xyz, max_tilt_deg=20, iters=300, tol=0.02, seed=0):
    """RANSAC a near-horizontal plane among the lowest points (assumes rough Y-up).

    Returns a unit normal (pointing +Y-ish) or None if no convincing floor.
    """
    rng = np.random.default_rng(seed)
    low = xyz[xyz[:, 1] < np.percentile(xyz[:, 1], 30)]
    if len(low) > 60_000:
        low = low[rng.choice(len(low), 60_000, replace=False)]
    if len(low) < 100:
        return None
    cos_max = np.cos(np.radians(max_tilt_deg))
    best_n, best_count, best_mask = None, 0, None
    for _ in range(iters):
        a, b, c = low[rng.choice(len(low), 3, replace=False)]
        n = np.cross(b - a, c - a)
        norm = np.linalg.norm(n)
        if norm < 1e-9:
            continue
        n /= norm
        if n[1] < 0:
            n = -n
        if n[1] < cos_max:
            continue
        mask = np.abs((low - a) @ n) < tol
        cnt = int(mask.sum())
        if cnt > best_count:
            best_n, best_count, best_mask = n, cnt, mask
    if best_n is None or best_count < 0.2 * len(low):
        return None
    inl = low[best_mask]
    _, _, vt = np.linalg.svd(inl - inl.mean(0), full_matrices=False)
    n = vt[2]
    return n if n[1] > 0 else -n


def postprocess(views, timing=None, max_points=MAX_POINTS, seed=0):
    """List of per-view numpy dicts -> (header, xyz float32 [N,3], rgb uint8 [N,3])."""
    t0 = time.perf_counter()
    pts_all, col_all, n_raw = [], [], 0
    for v in views:
        pts = v["pts"].reshape(-1, 3)
        conf = v["conf"].reshape(-1)
        valid = v["mask"].reshape(-1) & np.isfinite(pts).all(1)
        n_raw += pts.shape[0]
        if not valid.any():
            continue
        thr = np.percentile(conf[valid], CONF_PERCENTILE)
        keep = valid & (conf >= thr)
        pts_all.append(pts[keep])
        col_all.append(v["rgb"].reshape(-1, 3)[keep])
    xyz = np.concatenate(pts_all).astype(np.float64)
    rgb = (np.clip(np.concatenate(col_all), 0, 1) * 255 + 0.5).astype(np.uint8)
    n_filtered = len(xyz)

    if n_filtered > max_points:
        idx = np.random.default_rng(seed).choice(n_filtered, max_points, replace=False)
        xyz, rgb = xyz[idx], rgb[idx]

    # Gravity-align: rotate so up -> +Y. Result is right-handed Y-up = Three.js convention.
    c2ws = np.stack([v["c2w"] for v in views]).astype(np.float64)
    up, up_method = estimate_up(c2ws)
    R = rotation_a_to_b(up, np.array([0.0, 1.0, 0.0]))
    xyz = xyz @ R.T
    floor_n = refine_floor(xyz)
    if floor_n is not None:
        R2 = rotation_a_to_b(floor_n, np.array([0.0, 1.0, 0.0]))
        xyz = xyz @ R2.T
        R = R2 @ R
        up_method += f"+floor({np.degrees(np.arccos(np.clip(floor_n[1], -1, 1))):.1f}°)"
    # Recenter: XZ median at origin, robust floor at y=0.
    floor_y = np.percentile(xyz[:, 1], 2)
    offset = np.array([-np.median(xyz[:, 0]), -floor_y, -np.median(xyz[:, 2])])
    xyz += offset
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = offset
    c2ws = T @ c2ws

    cameras = []
    for v, c2w in zip(views, c2ws):
        K = v["K"]
        cameras.append(
            {
                "c2w": [round(float(x), 6) for x in c2w.reshape(-1)],  # row-major, OpenCV cam axes
                "fx": float(K[0, 0]),
                "fy": float(K[1, 1]),
                "cx": float(K[0, 2]),
                "cy": float(K[1, 2]),
                "width": v["width"],
                "height": v["height"],
            }
        )

    ms = [v.get("metric_scale") for v in views if v.get("metric_scale") is not None]
    t_post = round((time.perf_counter() - t0) * 1000)
    header = {
        "version": 1,
        "units": "meters",
        "metricScale": float(np.mean(ms)) if ms else None,
        "bbox": {"min": xyz.min(0).round(4).tolist(), "max": xyz.max(0).round(4).tolist()},
        "floorY": 0.0,
        "cameras": cameras,
        "up": [0, 1, 0],
        "upMethod": up_method,
        "timingMs": {**(timing or {}), "post": t_post},
        "numImages": len(views),
    }
    print(
        f"[postprocess] raw={n_raw} filtered={n_filtered} final={len(xyz)} "
        f"up={np.round(up, 3).tolist()} ({up_method}) bbox_size={np.round(xyz.max(0) - xyz.min(0), 2).tolist()} "
        f"timing={header['timingMs']}"
    )
    return header, xyz.astype(np.float32), rgb
