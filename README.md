# PDF Diff & Annotate

A Progressive Web App for iPad that compares two related PDFs — an old, annotated copy
and a revised new copy — and produces an annotated new PDF you can export to PDF Expert,
Files, or any iOS share target.

> Reference / personal tool. No data leaves the device.

## Features

- **Drop in two PDFs**: old (annotated) and new (revised). Drag, tap, or paste.
- **Automatic text diff**: every change (insertion, deletion, modification) is surfaced as
  a coloured highlight on the new PDF, with a matching ghost on the old.
- **Confirm / reject / edit** every detected change before it's committed.
- **Copy old annotations forward**: highlights, underline/strikethrough, sticky notes, and
  freehand ink are re-anchored to the matching text in the new PDF (text-anchored
  re-flow). Pencil/ink falls back to coordinate copy with an "approximate" flag.
- **Quick overview**: vertical minimap with per-page change dots and a right-rail change
  list — tap a row to jump both panes to that hunk.
- **Smooth scrolling, synced panes**: scroll one pane, the other follows by document
  fraction so different page sizes still align.
- **Dark / Light / Auto** themes.
- **Fully offline**: all libraries vendored; no network needed after install.
- **Export**: Web Share API → share sheet (PDF Expert, Files, Mail), or download fallback.

## Install on iPad

1. Serve the folder (see "Run locally") or push to any static host.
2. Open the URL in **Safari** on the iPad.
3. Share → **Add to Home Screen**.
4. Launch from the home-screen icon — opens in standalone mode.

## Run locally

No build step. From the repo root:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/pdf-diff/` on the iPad (same Wi‑Fi, using the Mac's LAN
IP) or on desktop Safari/Chrome.

## Project layout

```
pdf-diff/
├── index.html
├── app.css
├── app.js                  # bootstrap + session state + orchestration
├── manifest.json
├── sw.js                   # cache-first service worker
├── icon.svg                # master icon
├── icons/                  # 152, 167, 180, 192, 512, 1024 PNGs
├── src/
│   ├── store.js            # IndexedDB project store
│   ├── pdf/
│   │   ├── render.js       # PDF.js renderer w/ virtualized scroll
│   │   ├── extract.js      # word tokens + bboxes
│   │   ├── annotations.js  # pdf-lib read/write annot dictionaries
│   │   └── export.js       # build + share annotated PDF
│   ├── diff/
│   │   ├── tokenize.js     # word→PUA encoding for fast diff
│   │   ├── diff.js         # diff-match-patch driver, hunk grouping
│   │   ├── anchor.js       # re-anchor old annots to new text
│   │   └── worker.js       # Web Worker host for diff
│   └── ui/
│       ├── viewer.js       # two-pane sync scroll
│       ├── overlay.js      # diff highlight quads
│       ├── changelist.js   # right-rail list
│       ├── minimap.js      # left-rail page map
│       ├── toolbar.js      # popup quad toolbar
│       └── theme.js        # light/dark/auto cycle
├── vendor/                 # pdfjs, pdf-lib, diff-match-patch, idb-keyval
└── scripts/
    └── render_icons.sh     # regenerate PNG icons from icon.svg via sips
```

## Tech

- Vanilla HTML/CSS/JS, ESM modules — no bundler, no framework.
- [PDF.js](https://mozilla.github.io/pdf.js/) — rendering + positioned text content.
- [pdf-lib](https://pdf-lib.js.org/) — reads existing annotations and writes the export.
- [diff-match-patch](https://github.com/google/diff-match-patch) — diffing + fuzzy match
  for re-anchoring.
- [idb-keyval](https://github.com/jakearchibald/idb-keyval) — IndexedDB key/value shim.
- Service worker + Web App Manifest for installable, offline-capable PWA.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `J` / `K` | Next / previous change |
| `Y` | Accept the current change |
| `N` | Reject the current change |

## Limitations (v1)

- Scanned PDFs without a text layer: no diff is possible. A banner explains this.
- Image / figure-region diffing isn't done — figures pass through unchanged.
- The "Copy old annotations" flow uses text-anchored re-flow for marked-up text;
  freehand ink and stamps are coordinate-copied and may need a manual nudge if the
  page layout shifted.

## Disclaimer

Use only for documents you have rights to. All processing is local to the device.
