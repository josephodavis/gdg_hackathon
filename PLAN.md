# PLAN.md — TrueScale (hackathon MVP)

> Hand-off plan for Claude Code. Read this whole file before writing code.
> Work milestone by milestone, commit after each one, and stop to report when a milestone's acceptance check passes or fails.

## 1. What we're building

**Pitch:** Take 10–30 phone photos of a room, get a metric-scale 3D reconstruction in the browser, click any two points and get a real-world distance in cm. Use cases: renters documenting move-in/move-out condition, "will this couch fit?", contractors quoting jobs without a site visit.

**Why it's different:** We use **MapAnything** (Meta, feed-forward), which predicts *metric* 3D geometry + camera poses from images alone, in one forward pass, with no LiDAR and no reference object. Most photo-based capture tools are only up-to-scale.

**Hard constraints**
- 3-hour build window. Demo reliability beats features. Always have a cached fallback.
- Developer machine is an **M1 MacBook (no CUDA)**. Model inference runs on a **cloud GPU (Modal)**; the Mac only runs the frontend.
- No Gaussian splats, no NeRF. Point clouds only.
- Use the **Apache-2.0 checkpoint: `facebook/map-anything-apache`** (not `facebook/map-anything`).

## 2. Architecture

```
Browser (Vite + TypeScript + Three.js)
  ├─ upload photos ──POST multipart──►  Modal GPU endpoint (FastAPI)
  │                                       ├─ load_images → MapAnything.infer
  │                                       ├─ filter (mask + confidence), subsample
  │                                       └─ encode binary payload
  ◄──────────── application/octet-stream ─┘
  ├─ render THREE.Points + camera frustums
  ├─ click-to-measure (raycast on points)
  └─ demo picker: load cached payloads from /public/demos/*.bin
```

## 3. Repo layout

```
truescale/
  PLAN.md
  README.md
  backend/
    modal_app.py        # Modal app: image, GPU class, FastAPI endpoint, CLI entrypoint for caching demos
    inference.py        # pure functions: run_model(paths) -> predictions; postprocess(preds) -> arrays
    payload.py          # encode_payload(header: dict, xyz: float32[N,3], rgb: uint8[N,3]) -> bytes
  frontend/
    index.html
    package.json
    vite.config.ts
    src/
      main.ts           # app wiring, state machine (idle → uploading → reconstructing → viewing → error)
      api.ts            # POST to VITE_API_URL, fetch demos, timeout + fallback
      payload.ts        # decodePayload(ArrayBuffer) -> { header, positions, colors }
      viewer.ts         # scene, camera, OrbitControls, Points, frustums, resize
      measure.ts        # measure tool: pick 2 points, draw line + label, list of measurements
      fitbox.ts         # (stretch) "will it fit" box
      ui.css
    public/demos/       # cached .bin payloads + thumbnails
  samples/
    <scene_name>/*.jpg  # demo photo sets (JPEG)
```

## 4. Binary payload format (backend ⇄ frontend contract)

Little-endian, in this order:

| Bytes | Content |
|---|---|
| 4 | `uint32` headerLength (bytes of UTF-8 JSON) |
| headerLength | header JSON (see below) |
| 0–3 | zero padding so the next offset is a multiple of 4 |
| N×3×4 | `float32` positions xyz, **meters**, already converted to Three.js convention (see §6) |
| N×3 | `uint8` colors rgb |

Header JSON:
```json
{
  "version": 1,
  "numPoints": 412345,
  "units": "meters",
  "metricScale": 1.73,
  "bbox": {"min": [x,y,z], "max": [x,y,z]},
  "cameras": [{"c2w": [16 floats, row-major], "fx": 0, "fy": 0, "cx": 0, "cy": 0, "width": 518, "height": 392}],
  "up": [0, 1, 0],
  "timingMs": {"load": 0, "infer": 0, "post": 0},
  "numImages": 18
}
```

Write a tiny round-trip test: encode in Python → decode in TS (or a Python decoder) → identical arrays.

## 5. Backend (Modal)

**Before writing inference code:** read the current MapAnything README in the repo (`facebookresearch/map-anything`) and confirm: install method, import paths, `model.infer(...)` arguments and output keys. The API below is from memory of the README and may have drifted, so the README wins.

Expected usage (verify):
```python
from mapanything.models import MapAnything
from mapanything.utils.image import load_images
model = MapAnything.from_pretrained("facebook/map-anything-apache").to("cuda")
views = load_images(list_of_image_paths)
preds = model.infer(views, memory_efficient_inference=False, use_amp=True, amp_dtype="bf16",
                    apply_mask=True, mask_edges=True)
# per view: pred["pts3d"] (B,H,W,3) world coords, metric; pred["conf"]; pred["mask"];
#           pred["camera_poses"] (cam2world); pred["intrinsics"]; pred["img_no_norm"] (colors)
#           pred["metric_scaling_factor"]
```

**modal_app.py requirements**
- Image: Debian slim, Python 3.12, `git` via apt, PyTorch with CUDA, MapAnything installed from GitHub, plus `fastapi`, `python-multipart`, `pillow`, `pillow-heif` (iPhone HEIC uploads), `numpy`.
- Bake model weights into the image (download in a build step) or store them in a `modal.Volume` so cold starts don't re-download them.
- `@app.cls(gpu="L4")` (A10G is also fine) with `@modal.enter()` loading the model once. Use `scaledown_window` of ~10 min. Add a comment showing how to set `min_containers=1` during the live demo to avoid cold starts.
- Serve a FastAPI app via `@modal.asgi_app()` with **CORS enabled** (allow all origins for the hackathon).
  - `POST /reconstruct`: multipart `files[]`. Validate 2–30 images, ≤15 MB each. Convert HEIC→JPEG. Save to a temp dir, run inference, return the binary payload.
  - `GET /health`: returns `{"ok": true}`.
- CLI entrypoint: `modal run backend/modal_app.py --scene samples/kitchen --out frontend/public/demos/kitchen.bin`, which runs the same pipeline remotely and writes the cached payload locally.
- If Modal API names have changed (`asgi_app`, `scaledown_window`, `min_containers`), check the current Modal docs and adapt.

**Post-processing (inference.py)**
1. For each view, keep points where `mask` is true AND `conf` ≥ that view's 20th percentile.
2. Concatenate all views. Colors come from the denormalized input image (`img_no_norm`, 0–1 float → uint8).
3. Subsample to **≤ 400,000 points** (random is fine; voxel downsample at ~1 cm if time allows).
4. Estimate **up** as the normalized mean of each camera's "up" axis (−Y column of the cam2world rotation in OpenCV convention). Rotate the cloud so up = +Y. This keeps the scene upright in the viewer.
5. Convert to Three.js convention (§6), compute bbox, build header, encode.
6. Log timings. Print the number of points before and after filtering.

## 6. Coordinate conventions

MapAnything outputs OpenCV-style camera coordinates (x right, y down, z forward). Three.js is y up, camera looks down −z. Apply the gravity alignment in step 4, then make sure the result renders upright. Verify visually with a scene where the floor is obvious. Apply the same transform to camera poses so frustums line up with the points.

## 7. Frontend

- **Stack:** Vite + vanilla TypeScript + `three` (OrbitControls, CSS2DRenderer from `three/examples/jsm`). No React. Keep dependencies minimal.
- **Config:** `VITE_API_URL` in `.env.local`. If it's unset or a request fails/times out (90 s), show an error with a one-click "Load demo scene" button.
- **Upload panel:** drag-and-drop or file picker, thumbnail grid, image count, "Reconstruct" button. Tips text: "10–30 overlapping photos, good light, walk around the space."
- **Progress:** a status line through the state machine (`uploading → reconstructing on GPU → building view`), with elapsed seconds.
- **Viewer**
  - `THREE.Points` + `BufferGeometry` (position Float32, color Uint8 normalized), `PointsMaterial` with `vertexColors`, `sizeAttenuation`, and a point-size slider.
  - Frame the camera on the bbox at load.
  - Camera frustums as small line pyramids, toggleable.
  - Grid helper on the floor (y = bbox.min.y), toggleable.
- **Measure tool (core feature)**
  - Toggle with button or `M`. Click point A, click point B → 3D line + midpoint label in **cm** (toggle to inches), with a live preview line while hovering after A.
  - Raycaster with `params.Points.threshold` scaled to the scene (e.g. 0.5% of the bbox diagonal). Pick the nearest hit to the ray origin.
  - Measurements list in a side panel, each with delete. `Esc` cancels the current measurement.
  - Show a small "±" note in the UI: "Metric scale estimated from images."
- **Demo picker:** dropdown listing `/demos/*.bin` (hardcode a `demos.json` manifest).

## 8. Milestones (with acceptance checks)

### Milestone 0 — before the hackathon (only if the rules allow pre-built code; otherwise do just the infra/account setup)
- [ ] Scaffold the repo per §3.
- [ ] Deploy the Modal app. `curl /health` works. One `POST /reconstruct` with `samples/<scene>` returns a payload. Record latency (cold and warm).
- [ ] Generate cached payloads for 2–3 sample scenes into `frontend/public/demos/`.
- **Accept:** the decoded payload has a sane numPoints and a bbox roughly the size of the real room (a few meters, not 0.01 or 1000).

### Milestone 1 — render (target 0:00–0:30)
- [ ] Vite app loads a demo `.bin`, decodes it, renders colored points upright with orbit controls.
- **Accept:** the scene is upright, recognizable, 60 fps-ish on the M1 in Chrome.

### Milestone 2 — measure (0:30–1:30)
- [ ] Measure tool per §7, with list, units toggle, delete, `Esc`.
- **Accept:** measuring a known object in a demo scene (door height ≈ 200–210 cm, standard door width ≈ 76–91 cm) gives a plausible value. Record the real-vs-measured numbers in README.

### Milestone 3 — live upload (1:30–2:00)
- [ ] Upload panel + progress + real call to the Modal endpoint + fallback to demo on failure.
- **Accept:** a fresh set of 10–15 phone photos goes end to end with no console errors.

### Milestone 4 — product feature (2:00–2:30), pick ONE
- **A. Will it fit (preferred):** inputs W × D × H in cm → translucent box resting on the floor plane (y = floor), `TransformControls` for translate + Y-rotation only. Box turns red if more than ~2% of points fall inside it (collision), green otherwise.
- **B. Before/after:** load two payloads of the same room side by side, with synced cameras.
- **Accept:** the feature works on a demo scene in under 3 clicks.

### Milestone 5 — demo hardening (2:30–3:00)
- [ ] Remove debug UI. Add a landing header with the pitch line.
- [ ] Make sure every failure path ends at "Load demo scene."
- [ ] README: what it is, how to run (`modal deploy`, `npm run dev`), the accuracy table.

## 9. Rules for Claude Code

- Verify external APIs (MapAnything, Modal) against current docs before relying on them. Don't guess function names.
- Prefer the simplest thing that works. No auth, no database, no state management library.
- Never commit secrets. Modal tokens stay in the user's environment.
- After each milestone: run it, report what works, what doesn't, and timings, then commit with a clear message.
- If a step is blocked for more than ~10 minutes (e.g. a MapAnything install issue), stop and report options instead of thrashing.
