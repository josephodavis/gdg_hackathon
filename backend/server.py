"""Provider-agnostic FastAPI app. Modal wraps it; on a plain GPU box run:

    cd backend && TRUESCALE_STANDALONE=1 uvicorn server:standalone_app --host 0.0.0.0 --port 8000
"""

import os
import tempfile
import time

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

MIN_FILES, MAX_FILES = 2, 30
MAX_BYTES = 15 * 1024 * 1024
NATIVE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif"}


def save_uploads(files: list[tuple[str, bytes]], out_dir: str) -> list[str]:
    """Write (filename, bytes) pairs to out_dir with extensions load_images accepts."""
    paths = []
    for i, (name, data) in enumerate(files):
        ext = os.path.splitext(name or "")[1].lower()
        path = os.path.join(out_dir, f"{i:03d}{ext if ext in NATIVE_EXTS else '.jpg'}")
        if ext in NATIVE_EXTS:
            with open(path, "wb") as f:
                f.write(data)
        else:  # webp/avif/etc -> jpeg
            import io

            from PIL import Image, ImageOps

            try:
                img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
            except Exception as e:
                raise HTTPException(400, f"Could not read image {name!r}: {e}")
            img.save(path, quality=92)
        paths.append(path)
    return paths


def reconstruct_bytes(model, files: list[tuple[str, bytes]]) -> bytes:
    from inference import postprocess, run_model
    from payload import encode_payload

    with tempfile.TemporaryDirectory() as d:
        paths = save_uploads(files, d)
        views, timing = run_model(model, paths)
    header, xyz, rgb = postprocess(views, timing)
    return encode_payload(header, xyz, rgb)


def create_app(get_model) -> FastAPI:
    app = FastAPI(title="TrueScale")
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.post("/reconstruct")
    def reconstruct(files: list[UploadFile] = File(...)):
        if not (MIN_FILES <= len(files) <= MAX_FILES):
            raise HTTPException(400, f"Send {MIN_FILES}-{MAX_FILES} images (got {len(files)}).")
        blobs = []
        for f in files:
            data = f.file.read()
            if len(data) > MAX_BYTES:
                raise HTTPException(413, f"{f.filename} is over 15 MB.")
            blobs.append((f.filename or "img.jpg", data))
        t0 = time.perf_counter()
        body = reconstruct_bytes(get_model(), blobs)
        print(f"[reconstruct] {len(blobs)} images -> {len(body) / 1e6:.1f} MB in {time.perf_counter() - t0:.1f}s")
        return Response(body, media_type="application/octet-stream")

    return app


def _standalone():
    from inference import load_model

    model = load_model()
    return create_app(lambda: model)


if os.environ.get("TRUESCALE_STANDALONE"):
    standalone_app = _standalone()
