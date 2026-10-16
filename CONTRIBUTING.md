# Contributing to Parts Bin

Thanks for helping. A few ground rules keep the project easy to work on.

## Getting started

```bash
npm install
npm start
npm test
```

Run against a scratch data folder so you don't touch your own inventory:

```bash
PARTSBIN_DATA=./tmp-data npm start
```

## Adding parts to the database

The easiest contribution. Edit [`db/cpus.json`](db/cpus.json) or [`db/gpus.json`](db/gpus.json):

- One entry per model, with a lowercase `key` in the same style as its neighbours
  (`i5-10500`, `r7-5800x3d`, `rtx4060ti`).
- Take specs from the manufacturer's spec sheet: cores, threads, base/boost clock, TDP, socket, memory types.
- Use the exact socket names already in the file (e.g. `LGA1151 (100/200)` vs `LGA1151 (300)`), because the
  optimizer compares them as text.
- **Never paste benchmark scores** from PassMark, Geekbench, 3DMark etc. CPU scores are computed by the app; a new
  architecture needs an IPC factor in `src/partsdb.js`.
- Run `npm test` (it checks keys are unique).

## Code

- Plain JavaScript, no build step for the interface. Keep the style of the surrounding code.
- Data logic (`model.js`, `partsdb.js`, `importers.js`, `optimizer.js`) must stay free of DOM code so it can be
  tested in Node. Add a test in `test/run.mjs` for anything you change there.
- Every change to the user's data goes through `commit()` in `app.js` (that's what saves it and makes undo work).
- The window never gets Node access; new OS features go in `main.js` behind a single-purpose IPC call in
  `preload.js`.
- Text must stay legible: the pixel font (Pixelify Sans) is only for large headings, everything people read is
  Atkinson Hyperlegible.

## Test fixtures

Fixtures from real machines must be anonymised: no hostnames, IPs, MAC addresses, serial numbers or user names.
`scripts/dump-scan.mjs` prints a raw scan; scrub it before committing.

## Pull requests

- Keep each PR to one change, with a short description of what and why.
- `npm test` must pass (CI runs it on Windows, macOS and Linux).
- Screenshots for visual changes are appreciated.

## Code of conduct

Be kind and assume good faith. Harassment or abuse of any kind gets you removed from the project.
