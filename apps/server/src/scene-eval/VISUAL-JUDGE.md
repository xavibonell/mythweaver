# Visual judge (strategy A) — score the RENDER, gate regressions

The text scene-judge (`rubric.ts`) reads a digest of the SceneMap and **ignores art** ("assume
placeholder tiles"). It is blind to defects that live only in pixels: unfinished wall corners, a door
opening onto a wall, a hole in an exterior wall, a prop used for the wrong job. The **visual judge**
scores those by looking at the actual rendered image, with a lens panel, and gates changes against a
pinned baseline so a regression can't ship on a claim of "I checked it."

## Pieces
- `capture.ts` — sink for the render. The renderer snapshots its WebGL framebuffer to a PNG and
  `POST`s it to `/scene/eval/capture`; it lands in `captures/<name>.png` (gitignored).
- `visual-rubric.ts` — the 5 dimensions, the **NOT_DEFECTS calibration list** (intentional
  courtyards/gardens, roofless view, placeholder art — edit this as taste is established), the lens
  set, and the JSON verdict parser. Defects carry a canonical `unit` (`#3`) + `region` (`nw…se`) so
  the lenses corroborate the *same* defect (consensus) instead of phrasing it three ways.
- `visual-judge.ts` — `runVisualJudge`: runs the lenses (parallel, temp 0, `allSettled` so one dead
  lens doesn't sink the run), medians the dimension scores, merges defects with a consensus count.
- `scripts/visual-judge.mjs` — CLI: judge / `--baseline` / `--gate`, `--repeat N` for stability.
- `visual-baseline.json` — pinned scores + observed spread per capture (committed; the gate ref).

## The loop (when changing the town builder)
```bash
# 1. capture the CURRENT render (see "Capture" below) → captures/building-house.png
npm run build
npm run scene:judge:visual -- --name building-house --baseline   # pin where we are (runs x3)

# 2. make a change, rebuild, re-capture, then gate:
npm run build
npm run scene:judge:visual -- --name building-house --gate        # runs x3, exit 1 if a dim regressed
```
The gate fails a dimension only when the drop exceeds the judge's own noise: `margin =
max(0.6, baselineSpread + 0.3)`. Always gate with the default `--repeat 3+` — a single run wobbles ±1
on `wallIntegrity`/`openingSanity`; the mean of 3 smooths it. Real Anthropic vision calls (~3/run).

## Capture (strategy A — the real pixels)
The render is a Phaser/WebGL canvas in the Scene Lab. `canvas.toDataURL` is blank on WebGL, and the
preview tab is hidden so RAF is throttled — so capture via `renderer.snapshot()` **and force render
steps** to make the snapshot fire, then POST it. In the Scene Lab (Component → building:house) console:
```js
const s = window.__mwScene, g = s.game, cam = s.cameras.main, gr = s.lastData.grid;
const W = gr.cols*16*2, H = gr.rows*16*2;            // 2× native ≈ 32px/tile, crisp for the judge
s.scale.resize(W+24, H+24); cam.setZoom(2); cam.centerOn(gr.cols*8, gr.rows*8);
const dataUrl = await new Promise((res) => {
  g.renderer.snapshot((img) => res(img.src));
  let n = 0; const tick = () => { if (n++ > 20) return; g.step(performance.now(), 16); setTimeout(tick, 40); }; tick();
});
await fetch('http://localhost:6984/scene/eval/capture', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name:'building-house', dataUrl }) });
```
A headless (Playwright) version of this would make `--gate` a single self-contained command — not yet built.
