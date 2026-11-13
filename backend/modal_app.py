"""TrueScale GPU backend on Modal.

Deploy:      .venv/bin/modal deploy backend/modal_app.py
Dev (hot):   .venv/bin/modal serve backend/modal_app.py
Cache demo:  .venv/bin/modal run backend/modal_app.py --scene samples/kitchen --out frontend/public/demos/kitchen.bin
"""

import os
import sys
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

MA_COMMIT = "3d10cf7a3016fc0f9bb13a071ee66c47b10be0d9"  # facebookresearch/map-anything, pinned
MODEL_ID = "facebook/map-anything-apache"  # Apache-2.0 checkpoint
# Fallback order when a type has no capacity. Override: TRUESCALE_GPU=A100 modal deploy ...
GPU = os.environ.get("TRUESCALE_GPU", "L4,A10G,L40S").split(",")


def _bake_weights():
    # Instantiating (not just snapshot_download) also caches any torch.hub encoder code.
    from mapanything.models import MapAnything

    MapAnything.from_pretrained(MODEL_ID)


image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.7.1", "torchvision==0.22.1")
    .run_commands(
        "git clone https://github.com/facebookresearch/map-anything.git /opt/map-anything"
        f" && cd /opt/map-anything && git checkout {MA_COMMIT}"
        " && cp README.md readme.md",  # pyproject says readme.md; Linux is case-sensitive
        "pip install -e /opt/map-anything",
    )
    .pip_install("fastapi[standard]", "python-multipart", "pillow-heif", "numpy")
    .env({"HF_HOME": "/cache/hf", "TORCH_HOME": "/cache/torch"})
    .run_function(_bake_weights, memory=16384)
    .add_local_python_source("inference", "payload", "server")
)

app = modal.App("truescale", image=image)


@app.cls(
    gpu=GPU,
    scaledown_window=600,  # keep warm 10 min after last request
    timeout=600,
    # LIVE DEMO: keep one GPU warm (bills while idle). Set to 0 and redeploy after the demo.
    min_containers=1,
)
class TrueScale:
    @modal.enter()
    def load(self):
        t0 = time.perf_counter()
        from inference import load_model

        self.model = load_model("cuda")
        print(f"[enter] model loaded in {time.perf_counter() - t0:.1f}s")

    @modal.method()
    def reconstruct(self, files: list[tuple[str, bytes]]) -> bytes:
        from server import reconstruct_bytes

        return reconstruct_bytes(self.model, files)

    @modal.asgi_app()
    def web(self):
        from server import create_app

        return create_app(lambda: self.model)


def _read_scene(scene_dir: str, max_side: int = 1600) -> list[tuple[str, bytes]]:
    """Read photos locally; downscale big ones to JPEG to cut upload time (model runs at 518px)."""
    import io

    exts = (".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp")
    names = sorted(n for n in os.listdir(scene_dir) if n.lower().endswith(exts))
    files = []
    try:
        from PIL import Image, ImageOps

        try:
            from pillow_heif import register_heif_opener

            register_heif_opener()
        except ImportError:
            pass
    except ImportError:
        Image = None
    for n in names:
        path = os.path.join(scene_dir, n)
        if Image is not None:
            try:
                img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
                img.thumbnail((max_side, max_side))
                buf = io.BytesIO()
                img.save(buf, "JPEG", quality=92)
                files.append((os.path.splitext(n)[0] + ".jpg", buf.getvalue()))
                continue
            except Exception as e:
                print(f"  (sending {n} as-is: {e})")
        with open(path, "rb") as f:
            files.append((n, f.read()))
    return files


@app.local_entrypoint()
def main(scene: str, out: str = "", name: str = ""):
    from payload import decode_payload, upsert_manifest

    scene = scene.rstrip("/")
    scene_id = os.path.basename(scene)
    out = out or os.path.join(HERE, "..", "frontend", "public", "demos", f"{scene_id}.bin")
    files = _read_scene(scene)
    print(f"Sending {len(files)} images ({sum(len(b) for _, b in files) / 1e6:.1f} MB) from {scene}")
    t0 = time.perf_counter()
    body = TrueScale().reconstruct.remote(files)
    dt = time.perf_counter() - t0
    with open(out, "wb") as f:
        f.write(body)
    header, xyz, _ = decode_payload(body)
    size = [round(b - a, 2) for a, b in zip(header["bbox"]["min"], header["bbox"]["max"])]
    print(
        f"Wrote {out} ({len(body) / 1e6:.1f} MB) in {dt:.1f}s round trip | points={header['numPoints']} "
        f"bbox size (m)={size} up={header.get('upMethod')} timing={header['timingMs']}"
    )
    upsert_manifest(
        os.path.join(os.path.dirname(out), "demos.json"),
        scene_id,
        name or scene_id.replace("_", " ").title(),
        os.path.basename(out),
    )
