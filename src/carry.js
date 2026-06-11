// Carry-forward pipeline (fast path).
//
// Performance design:
//  - Use PDF.js to read annotations (tolerant of complex Boeing PDFs).
//  - Index pages LAZILY: a page's word positions are extracted only when an
//    annotation actually needs to search it, then cached.
//  - For each old annotation we start the search at the *proportional* new
//    page index and spiral outward, so we rarely touch more than a handful
//    of pages per annotation.
//  - Save the output PDF with object streams DISABLED — saves ~10× faster
//    on large documents because it skips a deflate compression pass.

import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

const { PDFDocument, PDFName, PDFString } = window.PDFLib;

const TEXT_SUBTYPES = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut']);
const GEO_SUBTYPES = new Set(['Ink', 'Square', 'Circle', 'Line']);

const LOAD_OPTS = {
  ignoreEncryption: true,
  throwOnInvalidObject: false,
  updateMetadata: false,
  capNumbers: false,
  parseSpeed: 1500,
};

const SEARCH_RADIUS = 8;  // pages to spiral outward from proportional anchor

export async function carry(oldBlob, newBlob, onProgress = () => {}) {
  onProgress('Reading PDFs…');
  const oldBytes = new Uint8Array(await oldBlob.arrayBuffer());
  const newBytes = new Uint8Array(await newBlob.arrayBuffer());

  const [oldPdfjs, newPdfjs] = await Promise.all([
    pdfjsLib.getDocument({ data: oldBytes.slice(0), isEvalSupported: false }).promise,
    pdfjsLib.getDocument({ data: newBytes.slice(0), isEvalSupported: false }).promise,
  ]);
  const nOld = oldPdfjs.numPages, nNew = newPdfjs.numPages;

  onProgress('Reading annotations…');
  const annots = await readAllAnnotationsPdfjs(oldPdfjs);
  if (annots.length === 0) {
    return {
      blob: new Blob([newBytes], { type: 'application/pdf' }),
      carried: 0, stale: [],
      message: 'No annotation objects found in the old PDF. (If your marks were "flattened" into the page graphics, they cannot be read back.)',
    };
  }

  // Lazy per-page indexes.
  const oldIndex = new LazyIndex(oldPdfjs);
  const newIndex = new LazyIndex(newPdfjs);

  onProgress('Opening new PDF for writing…');
  let newDoc;
  try {
    newDoc = await PDFDocument.load(newBytes.slice(0), LOAD_OPTS);
  } catch {
    onProgress('Building output from scratch…');
    newDoc = await PDFDocument.create();
    for (let i = 1; i <= nNew; i++) {
      const p = await newPdfjs.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      newDoc.addPage([vp.width, vp.height]);
    }
  }

  onProgress(`Carrying ${annots.length} annotations…`);
  let carried = 0;
  const stale = [];

  for (let idx = 0; idx < annots.length; idx++) {
    const a = annots[idx];
    // Periodic progress + yield to UI thread.
    if (idx % 10 === 0) {
      onProgress(`Carrying — ${idx}/${annots.length}`);
      await yieldToUI();
    }
    const expected = approxPageIndex(a.page, nOld, nNew);

    if (TEXT_SUBTYPES.has(a.subtype)) {
      const oldPage = await oldIndex.get(a.page);
      const anchor = extractAnchorTextFromQuads(oldPage, a.quads);
      if (!anchor || anchor.length < 3) continue;
      const hit = await searchInNewPdf(newIndex, anchor, expected, SEARCH_RADIUS);
      if (hit) {
        addTextMarkAnnotation(newDoc, hit.pageIndex, a.subtype, hit.quads, a.color, a.contents);
        carried++;
      } else {
        stale.push({ subtype: a.subtype, oldPage: a.page + 1, text: anchor });
      }
    } else if (a.subtype === 'FreeText') {
      const oldPage = await oldIndex.get(a.page);
      const nearby = extractWordsInRect(oldPage, a.rect, 4);
      const phrase = pickPhrase(nearby, 6);
      const hit = phrase ? await searchInNewPdf(newIndex, phrase, expected, SEARCH_RADIUS) : null;
      const target = hit
        ? { pageIndex: hit.pageIndex, x: hit.rect.x0, y: hit.rect.y0 }
        : { pageIndex: expected, x: 36, y: 36 };
      addFreeText(newDoc, target.pageIndex, target.x, target.y, a, a.color, a.contents);
      carried++;
    } else if (GEO_SUBTYPES.has(a.subtype)) {
      const oldPage = await oldIndex.get(a.page);
      const nearby = extractWordsAboveRect(oldPage, a.rect, 50);
      const phrase = pickPhrase(nearby, 6);
      let dx = 0, dy = 0, targetPage = expected;
      if (phrase) {
        const hit = await searchInNewPdf(newIndex, phrase, expected, SEARCH_RADIUS);
        if (hit) {
          // Locate the same phrase on the OLD page to compute delta.
          const oldHit = locateWordsInPage(oldPage, phrase);
          if (oldHit.length) {
            const oldR = boundQuads(oldHit);
            dx = hit.rect.x0 - oldR.x0;
            dy = hit.rect.y0 - oldR.y0;
            targetPage = hit.pageIndex;
          }
        }
      }
      addGeometryAnnotation(newDoc, targetPage, a, dx, dy);
      carried++;
    }
  }

  for (const s of stale) {
    const pi = approxPageIndex(s.oldPage - 1, nOld, nNew);
    const page = newDoc.getPage(pi);
    const stickyText = `⚠ Was annotated on old page ${s.oldPage} (${s.subtype}). Text not found in new PDF:\n\n"${s.text.slice(0, 300)}"`;
    addSticky(newDoc, pi, page.getWidth() - 28, page.getHeight() - 28, stickyText, [0.85, 0.20, 0.20]);
  }

  onProgress('Writing output…');
  // useObjectStreams: false → skips the deflate compression pass.
  // ~10× faster save on big docs at the cost of a larger file.
  const bytes = await newDoc.save({ useObjectStreams: false });
  return {
    blob: new Blob([bytes], { type: 'application/pdf' }),
    carried,
    stale,
    message: null,
  };
}

// ---------------------------------------------------------------------------
// Lazy per-page index
// ---------------------------------------------------------------------------

class LazyIndex {
  constructor(pdfDoc) {
    this.pdfDoc = pdfDoc;
    this.cache = new Map();   // pageIndex -> pageInfo
    this.numPages = pdfDoc.numPages;
  }
  async get(pageIndex) {
    if (pageIndex < 0 || pageIndex >= this.numPages) return null;
    if (this.cache.has(pageIndex)) return this.cache.get(pageIndex);
    const page = await this.pdfDoc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words = [];
    for (const item of content.items) {
      if (!item.str) continue;
      const tx = item.transform;
      const fontSize = Math.hypot(tx[2], tx[3]);
      const x = tx[4], y = tx[5];
      const itemW = item.width || (item.str.length * fontSize * 0.5);
      const itemH = item.height || fontSize;
      const parts = item.str.split(/(\s+)/).filter(Boolean);
      let cursor = 0;
      const total = item.str.length || 1;
      for (const part of parts) {
        if (/^\s+$/.test(part)) { cursor += part.length; continue; }
        const f0 = cursor / total;
        const f1 = (cursor + part.length) / total;
        words.push({
          text: part,
          x: x + f0 * itemW,
          y: y,
          w: Math.max(1, (f1 - f0) * itemW),
          h: itemH,
        });
        cursor += part.length;
      }
    }
    const info = {
      width: vp.width, height: vp.height,
      words,
      norm: normalize(words.map((w) => w.text).join(' ')),
    };
    this.cache.set(pageIndex, info);
    return info;
  }
}

// ---------------------------------------------------------------------------
// Spiral search: from the proportional page, look at p, p±1, p±2, … up to radius.
// Returns the first match anywhere. Caches indexed pages along the way.
// ---------------------------------------------------------------------------

async function searchInNewPdf(index, needle, startPage, radius) {
  const tries = spiral(startPage, radius, index.numPages);
  for (const pi of tries) {
    const page = await index.get(pi);
    if (!page) continue;
    const n = normalize(needle);
    if (page.norm.includes(n)) {
      const quads = locateWordsInPage(page, needle);
      if (quads.length) return { pageIndex: pi, quads, rect: boundQuads(quads) };
    }
  }
  // Backoff: shorter phrases, same spiral.
  for (const k of [6, 4]) {
    const short = needle.split(/\s+/).slice(0, k).join(' ');
    if (short.length < 8 || short === needle) continue;
    const sn = normalize(short);
    for (const pi of tries) {
      const page = await index.get(pi);
      if (!page) continue;
      if (page.norm.includes(sn)) {
        const quads = locateWordsInPage(page, short);
        if (quads.length) return { pageIndex: pi, quads, rect: boundQuads(quads) };
      }
    }
  }
  return null;
}

function spiral(center, radius, count) {
  const out = [];
  for (let d = 0; d <= radius; d++) {
    if (d === 0) {
      if (center >= 0 && center < count) out.push(center);
      continue;
    }
    const a = center - d, b = center + d;
    if (a >= 0 && a < count) out.push(a);
    if (b >= 0 && b < count) out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Annotation reading — PDF.js
// ---------------------------------------------------------------------------

async function readAllAnnotationsPdfjs(pdf) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const anns = await page.getAnnotations();
    for (const a of anns) {
      const sub = a.subtype;
      if (!sub || sub === 'Link' || sub === 'Widget') continue;
      out.push({
        page: i - 1,
        subtype: sub,
        rect: a.rect || [0, 0, 0, 0],
        color: rgbFromPdfjs(a.color),
        contents: a.contentsObj?.str || a.contents || '',
        quads: pdfjsQuads(a.quadPoints),
        inkList: pdfjsInk(a.inkLists),
      });
    }
  }
  return out;
}

function rgbFromPdfjs(c) {
  if (c && c.length >= 3) return [c[0] / 255, c[1] / 255, c[2] / 255];
  return [1, 0.85, 0.30];
}
function pdfjsQuads(qp) {
  if (!qp || qp.length === 0) return [];
  // Flat [TL.x, TL.y, TR.x, TR.y, BL.x, BL.y, BR.x, BR.y, …]
  const out = [];
  for (let i = 0; i + 7 < qp.length; i += 8) {
    out.push({
      x1: qp[i],     y1: qp[i + 1],
      x2: qp[i + 2], y2: qp[i + 3],
      x3: qp[i + 4], y3: qp[i + 5],
      x4: qp[i + 6], y4: qp[i + 7],
    });
  }
  return out;
}
function pdfjsInk(ink) {
  if (!ink || !ink.length) return [];
  return ink.map((stroke) => {
    const pts = [];
    for (let i = 0; i + 1 < stroke.length; i += 2) pts.push([stroke[i], stroke[i + 1]]);
    return pts;
  });
}

// ---------------------------------------------------------------------------
// Anchor extraction + word-range lookup
// ---------------------------------------------------------------------------

function normalize(s) { return s.replace(/\s+/g, ' ').trim().toLowerCase(); }

function extractAnchorTextFromQuads(pageInfo, quads) {
  if (!pageInfo || !quads || !quads.length) return '';
  const out = [];
  for (const q of quads) {
    const xs = [q.x1, q.x2, q.x3, q.x4];
    const ys = [q.y1, q.y2, q.y3, q.y4];
    const rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    for (const w of pageInfo.words) {
      const cx = w.x + w.w / 2;
      const cy = w.y;
      if (cx >= rect.x0 - 1 && cx <= rect.x1 + 1 && cy >= rect.y0 - 1 && cy <= rect.y1 + 1) {
        out.push(w.text);
      }
    }
  }
  const cleaned = [];
  for (const t of out) if (cleaned[cleaned.length - 1] !== t) cleaned.push(t);
  return cleaned.join(' ');
}

function extractWordsInRect(pageInfo, rect, pad = 0) {
  if (!pageInfo) return [];
  const [x0, y0, x1, y1] = [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad];
  return pageInfo.words.filter((w) => {
    const cx = w.x + w.w / 2, cy = w.y;
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  }).map((w) => w.text);
}
function extractWordsAboveRect(pageInfo, rect, h = 50) {
  if (!pageInfo) return [];
  const [, , x1, y1] = rect;
  return pageInfo.words.filter((w) => {
    const cx = w.x + w.w / 2, cy = w.y;
    return cx >= rect[0] - 20 && cx <= x1 + 20 && cy >= y1 && cy <= y1 + h;
  }).map((w) => w.text);
}
function pickPhrase(words, n) { return words && words.length ? words.slice(0, n).join(' ') : ''; }

function locateWordsInPage(page, needle) {
  const target = normalize(needle).split(' ').filter(Boolean);
  if (!target.length) return [];
  const words = page.words;
  for (let i = 0; i <= words.length - target.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (normalize(words[i + j].text) !== target[j]) { ok = false; break; }
    }
    if (ok) {
      const runs = [];
      let cur = null;
      for (let j = 0; j < target.length; j++) {
        const w = words[i + j];
        if (cur && Math.abs(w.y - cur.y) <= 2) {
          cur.x1 = Math.max(cur.x1, w.x + w.w);
          cur.h = Math.max(cur.h, w.h);
        } else {
          if (cur) runs.push(cur);
          cur = { x0: w.x, y: w.y, x1: w.x + w.w, h: w.h };
        }
      }
      if (cur) runs.push(cur);
      return runs.map((r) => ({
        x1: r.x0, y1: r.y + r.h,
        x2: r.x1, y2: r.y + r.h,
        x3: r.x0, y3: r.y,
        x4: r.x1, y4: r.y,
        rect: { x0: r.x0, y0: r.y, x1: r.x1, y1: r.y + r.h },
      }));
    }
  }
  return [];
}

function boundQuads(quads) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of quads) {
    minX = Math.min(minX, q.rect.x0); minY = Math.min(minY, q.rect.y0);
    maxX = Math.max(maxX, q.rect.x1); maxY = Math.max(maxY, q.rect.y1);
  }
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

// ---------------------------------------------------------------------------
// Annotation writers
// ---------------------------------------------------------------------------

function addTextMarkAnnotation(doc, pageIndex, subtype, quads, color, contents) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const qp = [];
  for (const q of quads) qp.push(q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4);
  const r = boundQuads(quads);
  const dict = ctx.obj({
    Type: 'Annot', Subtype: subtype,
    Rect: [r.x0, r.y0, r.x1, r.y1],
    QuadPoints: qp,
    C: color.slice(0, 3),
    Contents: PDFString.of(contents || ''),
    T: PDFString.of('Carried'),
    F: 4, CA: 0.55,
  });
  appendAnnot(page, ctx, dict);
}

function addFreeText(doc, pageIndex, x, y, oldAnnot, color, contents) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const w = Math.max(180, oldAnnot.rect[2] - oldAnnot.rect[0]);
  const h = Math.max(40, oldAnnot.rect[3] - oldAnnot.rect[1]);
  const rect = [x, Math.max(20, y - h), x + w, y];
  const dict = ctx.obj({
    Type: 'Annot', Subtype: 'FreeText',
    Rect: rect,
    Contents: PDFString.of(contents || ''),
    DA: PDFString.of('/Helv 10 Tf 0 0 0 rg'),
    C: color.slice(0, 3),
    T: PDFString.of('Carried note'),
    F: 4,
  });
  appendAnnot(page, ctx, dict);
}

function addGeometryAnnotation(doc, pageIndex, a, dx, dy) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const r = [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
  let dict;
  if (a.subtype === 'Square' || a.subtype === 'Circle' || a.subtype === 'Line') {
    dict = ctx.obj({
      Type: 'Annot', Subtype: a.subtype,
      Rect: r,
      C: a.color.slice(0, 3),
      BS: ctx.obj({ W: 1.5 }),
      Contents: PDFString.of(a.contents || ''),
      F: 4,
    });
    if (a.subtype === 'Line') dict.set(PDFName.of('L'), ctx.obj([r[0], r[1], r[2], r[3]]));
  } else if (a.subtype === 'Ink') {
    const translated = a.inkList.map((s) => s.map(([x, y]) => [x + dx, y + dy]));
    const inkArr = ctx.obj(translated.map((s) => ctx.obj(s.flatMap(([x, y]) => [x, y]))));
    dict = ctx.obj({
      Type: 'Annot', Subtype: 'Ink',
      Rect: r,
      C: a.color.slice(0, 3),
      BS: ctx.obj({ W: 1.5 }),
      Contents: PDFString.of(a.contents || ''),
      F: 4,
    });
    dict.set(PDFName.of('InkList'), inkArr);
  }
  if (dict) appendAnnot(page, ctx, dict);
}

function addSticky(doc, pageIndex, x, y, contents, color) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const dict = ctx.obj({
    Type: 'Annot', Subtype: 'Text',
    Rect: [x - 12, y - 12, x + 12, y + 12],
    Contents: PDFString.of(contents),
    C: color.slice(0, 3),
    Name: 'Note',
    T: PDFString.of('Stale annotation'),
    F: 4, Open: false,
  });
  appendAnnot(page, ctx, dict);
}

function appendAnnot(page, ctx, dict) {
  const ref = ctx.register(dict);
  const existing = page.node.get(PDFName.of('Annots'));
  if (existing && existing.array) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
}

function approxPageIndex(oldPageIdx, oldCount, newCount) {
  if (oldCount <= 0) return 0;
  return Math.max(0, Math.min(newCount - 1, Math.round(oldPageIdx * newCount / oldCount)));
}

function yieldToUI() { return new Promise((r) => setTimeout(r, 0)); }

// ---------------------------------------------------------------------------
// Share / download
// ---------------------------------------------------------------------------

export async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return { shared: true };
    } catch (err) {
      if (err && err.name === 'AbortError') return { shared: false, cancelled: true };
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  return { shared: false };
}
