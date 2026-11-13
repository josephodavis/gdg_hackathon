# TrueScale

**Phone photos in, a real-scale 3D room out.** Take 10–30 photos of a room, get a *metric* point cloud in the browser, click any two points to get a real-world distance in cm, and drop in a box to check whether that couch fits.

Built on [MapAnything](https://github.com/facebookresearch/map-anything) (Meta, Apache-2.0 checkpoint `facebook/map-anything-apache`). It predicts metric 3D geometry and camera poses from images alone in one forward pass: no LiDAR, no reference object.

Use cases: renters documenting move-in/move-out condition, "will this couch fit?", contractors quoting jobs without a site visit.

## How it works

```
Browser (Vite + TS + Three.js) ──multipart──► Modal L4 GPU (FastAPI)
                                               load_images → MapAnything.infer
                                               mask + conf ≥ p20 filter, ≤400k pts
                                               gravity-align (camera right-axes + RANSAC floor)
             ◄──── binary payload (header JSON + float32 xyz + uint8 rgb) ────┘
```

## Run it

```bash
# backend (one-time: .venv/bin/modal setup)
python3 -m venv .venv && .venv/bin/pip install modal numpy pillow pillow-heif
.venv/bin/modal deploy backend/modal_app.py          # prints https://…modal.run URL

# cache a demo scene from a folder of photos
.venv/bin/modal run backend/modal_app.py --scene samples/kitchen

# frontend
cd frontend && npm install
echo "VITE_API_URL=https://<your-modal-url>" > .env.local
npm run dev                                          # http://localhost:5173
```

Before a live demo, uncomment `min_containers=1` in `backend/modal_app.py` and redeploy to avoid cold starts.

Tests: `.venv/bin/python backend/test_payload.py` (payload round trip, upright alignment on a synthetic room).

## Using it

- **Measure:** press `M` (or *Start measuring*), click two points. `Esc` cancels. Toggle cm/in.
- **Will it fit:** enter W×D×H in cm, then *Place box*. Drag the arrows to move it; `R` switches to rotate. Green means it fits, red means it collides with the scan.
- **Scenes:** cached demos in the dropdown; a live scan is added there too (*Save .bin* to keep it).

## Accuracy

| Scene | Object | Real | Measured | Error |
|---|---|---|---|---|
| Synthetic (ground truth) | Door height (clicked 1.5 cm in from each edge) | 200.0 cm | 201.2 cm | +0.6% |
| Synthetic (ground truth) | Door width (clicked 1.5 cm in from each edge) | 83.0 cm | 84.7 cm | +2.0% |
| _real scene_ | _door height_ | | | |
| _real scene_ | _door width_ | | | |

Metric scale is estimated from the images, so expect a few % error on real scenes.
