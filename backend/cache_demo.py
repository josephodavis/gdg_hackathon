"""Reconstruct a photo folder via the deployed HTTP endpoint and save it as a cached demo.

    .venv/bin/python backend/cache_demo.py samples/lkd_lobby [--name "LKD lobby"] [--url https://...modal.run]
"""

import argparse
import os
import sys
import time

import httpx

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from modal_app import _read_scene  # noqa: E402  (local helper; downscales to 1600px JPEG)
from payload import decode_payload, upsert_manifest  # noqa: E402

DEFAULT_URL = "https://josephodavis--truescale-truescale-web.us-east.modal.run"
DEMOS = os.path.join(HERE, "..", "frontend", "public", "demos")

ap = argparse.ArgumentParser()
ap.add_argument("scene")
ap.add_argument("--name", default="")
ap.add_argument("--url", default=os.environ.get("TRUESCALE_URL", DEFAULT_URL))
a = ap.parse_args()

scene_id = os.path.basename(a.scene.rstrip("/"))
files = _read_scene(a.scene)
mb = sum(len(b) for _, b in files) / 1e6
print(f"POST {len(files)} images ({mb:.1f} MB) -> {a.url}/reconstruct")
t0 = time.perf_counter()
r = httpx.post(
    f"{a.url}/reconstruct",
    files=[("files", (n, b, "image/jpeg")) for n, b in files],
    timeout=300,
    follow_redirects=True,
)
dt = time.perf_counter() - t0
if r.status_code != 200:
    sys.exit(f"HTTP {r.status_code} after {dt:.1f}s: {r.text[:500]}")
header, xyz, _ = decode_payload(r.content)
out = os.path.join(DEMOS, f"{scene_id}.bin")
with open(out, "wb") as f:
    f.write(r.content)
size = [round(b - a_, 2) for a_, b in zip(header["bbox"]["min"], header["bbox"]["max"])]
print(
    f"{dt:.1f}s round trip | {len(r.content) / 1e6:.1f} MB | points={header['numPoints']} | "
    f"bbox size (m) x,y,z={size} | up={header.get('upMethod')} | metricScale={header.get('metricScale')} | "
    f"server timing={header['timingMs']}"
)
upsert_manifest(os.path.join(DEMOS, "demos.json"), scene_id, a.name or scene_id.replace("_", " ").title(), f"{scene_id}.bin")
print("wrote", out)
