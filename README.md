# TrueScale

**Phone photos in, a real-scale 3D room out.** Take 10–30 photos of a room, get a *metric* point cloud in the browser, click any two points to get a real-world distance in cm, and drop in a box to check whether that couch fits.

Use cases: renters documenting move-in/move-out condition, "will this couch fit?", contractors quoting jobs without a site visit.

<img width="982" height="555" alt="Screenshot 2026-11-13 at 8 32 38 PM" src="https://github.com/user-attachments/assets/42adf192-2293-47bf-b445-dd9333829d82" />

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
python3 -m venv .venv && .venv/bin/pip install modal numpy pillow pillow-heif httpx
.venv/bin/modal deploy backend/modal_app.py          # prints https://…modal.run URL (GPU: L4 → A10G → L40S fallback)

# cache a demo scene from a folder of photos (via the deployed HTTP endpoint)
.venv/bin/python backend/cache_demo.py samples/lkd_lobby --name "LKD lobby"

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

## Performance (15 × 24 MP iPhone photos, measured)

| Step | Time |
|---|---|
| Cold start (GPU allocation + model load) | ~37 s |
| Browser: shrink photos to 1600 px JPEG | 73 MB → 6 MB |
| Server: load images / MapAnything inference / post-process | 0.6 s / 4–5 s / 0.5 s |
| Warm round trip (HTTP) | ~9 s |
| Browser end to end (select → 3D view) | ~27 s (headless, software GL) |

## Accuracy

| Scene | Object | Real | Measured | Error |
|---|---|---|---|---|
| Synthetic (ground truth) | Door height (clicked 1.5 cm in from each edge) | 200.0 cm | 201.2 cm | +0.6% |
| Synthetic (ground truth) | Door width (clicked 1.5 cm in from each edge) | 83.0 cm | 84.7 cm | +2.0% |

Metric scale is estimated from the images, so expect a few % error on real scenes.
