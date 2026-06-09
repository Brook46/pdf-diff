// Carry-forward pipeline.
//
// Pipeline:
//   1. Read every non-Link annotation from the old PDF via pdf-lib.
//   2. Extract per-page word positions from both PDFs via PDF.js (for anchor
//      matching and quad reconstruction in the new PDF).
//   3. For each old annotation, find the matching anchor text in the new PDF;
//      if found, add a fresh annotation in the new PDF at that location with
//      the same subtype, color, and contents. If not found, record it as stale.
//   4. For purely geometric annotations (Ink, Square, Line, Circle), translate
//      the geometry by the delta between the nearest surrounding text anchor's
//      position in old vs new. If no anchor matches, place at the proportional
//      page index and flag as approximate.
//   5. Return { blob, carried, stale } where blob is the resulting PDF.

import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

const { PDFDocument, PDFName, PDFString, PDFNumber, rgb } = window.PDFLib;

const TEXT_SUBTYPES = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut']);
const GEO_SUBTYPES = new Set(['Ink', 'Square', 'Circle', 'Line']);

export async function carry(oldBlob, newBlob, onProgress = () => {}) {
  onProgress('Reading old PDF…');
  const oldBytes = new Uint8Array(await oldBlob.arrayBuffer());
  const newBytes = new Uint8Array(await newBlob.arrayBuffer());
  const oldDoc = await PDFDocument.load(oldBytes.slice(0));
  const newDoc = await PDFDocument.load(newBytes.slice(0));

  const annots = readAllAnnotations(oldDoc);
  if (annots.length === 0) {
    return {
      blob: new Blob([newBytes], { type: 'application/pdf' }),
      carried: 0, stale: [],
      message: 'No annotations found in the old PDF. (If your marks were "flattened" into the page they cannot be read back.)'
    };
  }

  onProgress(`Indexing pages…`);
  const oldPdfjs = await pdfjsLib.getDocument({ data: oldBytes.slice(0), isEvalSupported: false }).promise;
  const newPdfjs = await pdfjsLib.getDocument({ data: newBytes.slice(0), isEvalSupported: false }).promise;
  const oldIndex = await buildIndex(oldPdfjs, (p, n) => onProgress(`Indexing old PDF — page ${p}/${n}`));
  const newIndex = await buildIndex(newPdfjs, (p, n) => onProgress(`Indexing new PDF — page ${p}/${n}`));

  onProgress('Carrying annotations…');
  let carried = 0;
  const stale = [];

  for (const a of annots) {
    if (TEXT_SUBTYPES.has(a.subtype)) {
      const anchor = extractAnchorTextFromQuads(oldIndex[a.page], a.quads);
      if (!anchor || anchor.length < 3) {
        // No usable underlying text — drop.
        continue;
      }
      const hit = findTextInIndex(newIndex, anchor);
      if (hit) {
        addTextMarkAnnotation(newDoc, hit.pageIndex, a.subtype, hit.quads, a.color, a.contents);
        carried++;
      } else {
        stale.push({ subtype: a.subtype, oldPage: a.page + 1, text: anchor });
      }
    } else if (a.subtype === 'FreeText') {
      const nearby = extractWordsInRect(oldIndex[a.page], a.rect, 4);
      const phrase = pickPhrase(nearby, 6);
      const hit = phrase ? findTextInIndex(newIndex, phrase) : null;
      const target = hit ? { pageIndex: hit.pageIndex, x: hit.rect.x0, y: hit.rect.y0 } : approxLocation(a, oldDoc, newDoc);
      addFreeText(newDoc, target.pageIndex, target.x, target.y, a, a.color, a.contents);
      carried++;
    } else if (GEO_SUBTYPES.has(a.subtype)) {
      // Anchor by the nearest text band above the geometry rect, then translate.
      const nearby = extractWordsAboveRect(oldIndex[a.page], a.rect, 50);
      const phrase = pickPhrase(nearby, 6);
      let dx = 0, dy = 0, targetPage = approxPageIndex(a.page, oldDoc, newDoc);
      if (phrase) {
        const hit = findTextInIndex(newIndex, phrase);
        if (hit) {
          // Where was that phrase in the OLD PDF? Subtract from new position.
          const oldHit = findTextInIndex({ [a.page]: oldIndex[a.page] }, phrase, a.page);
          if (oldHit) {
            dx = hit.rect.x0 - oldHit.rect.x0;
            dy = hit.rect.y0 - oldHit.rect.y0;
            targetPage = hit.pageIndex;
          }
        }
      }
      addGeometryAnnotation(newDoc, targetPage, a, dx, dy);
      carried++;
    }
  }

  // Stale items get a red sticky-note on the proportional new page.
  for (const s of stale) {
    const pi = approxPageIndex(s.oldPage - 1, oldDoc, newDoc);
    const page = newDoc.getPage(pi);
    const w = page.getWidth();
    const stickyText = `⚠ Was annotated on old page ${s.oldPage} (${s.subtype}). Text not found in new PDF:\n\n"${s.text.slice(0, 300)}"`;
    addSticky(newDoc, pi, w - 28, page.getHeight() - 28, stickyText, [0.85, 0.20, 0.20]);
  }

  onProgress('Writing output…');
  const bytes = await newDoc.save({ useObjectStreams: true });
  return {
    blob: new Blob([bytes], { type: 'application/pdf' }),
    carried,
    stale,
    message: null
  };
}

// ---------------------------------------------------------------------------
// Annotation reading (pdf-lib)
// ---------------------------------------------------------------------------

function readAllAnnotations(doc) {
  const out = [];
  const pages = doc.getPages();
  pages.forEach((page, pIdx) => {
    const annotsRef = page.node.get(PDFName.of('Annots'));
    if (!annotsRef) return;
    const annots = doc.context.lookup(annotsRef);
    if (!annots || !annots.array) return;
    for (const ref of annots.array) {
      try {
        const annot = doc.context.lookup(ref);
        if (!annot || !annot.dict) continue;
        const sub = annot.dict.get(PDFName.of('Subtype'))?.encodedName?.slice(1);
        if (!sub || sub === 'Link') continue;
        const rec = {
          page: pIdx,
          subtype: sub,
          rect: numArr(annot.dict.get(PDFName.of('Rect'))) || [0, 0, 0, 0],
          color: numArr(annot.dict.get(PDFName.of('C'))) || [1, 0.85, 0.30],
          contents: strVal(annot.dict.get(PDFName.of('Contents'))) || '',
          quads: parseQuads(numArr(annot.dict.get(PDFName.of('QuadPoints')))),
          inkList: parseInkList(annot.dict.get(PDFName.of('InkList')))
        };
        out.push(rec);
      } catch { /* skip malformed */ }
    }
  });
  return out;
}

function numArr(v) {
  if (!v || !v.array) return null;
  return v.array.map((n) => (n.numberValue !== undefined ? n.numberValue : (typeof n.value === 'number' ? n.value : 0)));
}
function strVal(v) {
  if (!v) return '';
  if (typeof v.value === 'string') return v.value;
  if (typeof v.asString === 'function') return v.asString();
  return '';
}
function parseQuads(flat) {
  if (!flat) return [];
  const out = [];
  for (let i = 0; i + 7 < flat.length; i += 8) {
    out.push({ x1: flat[i], y1: flat[i+1], x2: flat[i+2], y2: flat[i+3], x3: flat[i+4], y3: flat[i+5], x4: flat[i+6], y4: flat[i+7] });
  }
  return out;
}
function parseInkList(v) {
  if (!v || !v.array) return [];
  return v.array.map((path) => {
    const a = path.array || [];
    const pts = [];
    for (let i = 0; i + 1 < a.length; i += 2) pts.push([a[i].numberValue ?? 0, a[i+1].numberValue ?? 0]);
    return pts;
  });
}

// ---------------------------------------------------------------------------
// Per-page word index (PDF.js)
// ---------------------------------------------------------------------------
// Each page's index: { width, height, words: [{ text, x, y, w, h }] }
// Coordinates are PDF user-space (origin bottom-left, same as pdf-lib uses).
// We also store a "normalized" full-page string for substring search.

async function buildIndex(pdfDoc, onProgress) {
  const pages = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words = [];
    for (const item of content.items) {
      if (!item.str) continue;
      const tx = item.transform;
      const fontSize = Math.hypot(tx[2], tx[3]);
      const x = tx[4];
      const y = tx[5]; // baseline y in PDF space (bottom-up)
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
          y: y,                 // baseline y
          w: Math.max(1, (f1 - f0) * itemW),
          h: itemH
        });
        cursor += part.length;
      }
    }
    const norm = normalize(words.map((w) => w.text).join(' '));
    pages.push({ width: vp.width, height: vp.height, words, norm });
    if (onProgress) onProgress(i, pdfDoc.numPages);
  }
  return pages;
}

function normalize(s) { return s.replace(/\s+/g, ' ').trim().toLowerCase(); }

// ---------------------------------------------------------------------------
// Anchor text extraction (from quadpoints + word index)
// ---------------------------------------------------------------------------

function extractAnchorTextFromQuads(pageInfo, quads) {
  if (!pageInfo || !quads || !quads.length) return '';
  const out = [];
  for (const q of quads) {
    const xs = [q.x1, q.x2, q.x3, q.x4];
    const ys = [q.y1, q.y2, q.y3, q.y4];
    const rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    for (const w of pageInfo.words) {
      const cx = w.x + w.w / 2;
      const cy = w.y;        // baseline lies inside the highlight band
      if (cx >= rect.x0 - 1 && cx <= rect.x1 + 1 && cy >= rect.y0 - 1 && cy <= rect.y1 + 1) {
        out.push(w.text);
      }
    }
  }
  // Deduplicate consecutive repeats (multi-quad highlights of the same line can double-count)
  const cleaned = [];
  for (const t of out) {
    if (cleaned[cleaned.length - 1] !== t) cleaned.push(t);
  }
  return cleaned.join(' ');
}

function extractWordsInRect(pageInfo, rect, pad = 0) {
  if (!pageInfo) return [];
  const [x0, y0, x1, y1] = [rect[0]-pad, rect[1]-pad, rect[2]+pad, rect[3]+pad];
  return pageInfo.words.filter((w) => {
    const cx = w.x + w.w/2, cy = w.y;
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  }).map((w) => w.text);
}
function extractWordsAboveRect(pageInfo, rect, h = 50) {
  if (!pageInfo) return [];
  const [, y0, x1, y1] = rect;
  // "Above" in PDF coords = larger y. Old PDFs are bottom-up.
  return pageInfo.words.filter((w) => {
    const cx = w.x + w.w/2, cy = w.y;
    return cx >= rect[0] - 20 && cx <= x1 + 20 && cy >= y1 && cy <= y1 + h;
  }).map((w) => w.text);
}

function pickPhrase(words, n) {
  if (!words || words.length === 0) return '';
  return words.slice(0, n).join(' ');
}

// ---------------------------------------------------------------------------
// Anchor lookup in the new PDF
// ---------------------------------------------------------------------------

function findTextInIndex(index, needle, startPage = 0) {
  if (!needle) return null;
  const n = normalize(needle);
  if (n.length < 3) return null;
  const isArr = Array.isArray(index);
  const pageKeys = isArr ? index.map((_, i) => i) : Object.keys(index).map((k) => +k);
  // Search starting at startPage (gives sensible bias for old→new mapping)
  const ordered = [...pageKeys].sort((a, b) => Math.abs(a - startPage) - Math.abs(b - startPage));
  for (const pi of ordered) {
    const page = isArr ? index[pi] : index[pi];
    if (!page) continue;
    if (page.norm.includes(n)) {
      const quads = locateWordsInPage(page, needle);
      if (quads.length) {
        const rect = boundQuads(quads);
        return { pageIndex: pi, quads, rect };
      }
    }
  }
  // Backoff: try first 6/4 words
  for (const k of [6, 4]) {
    const short = needle.split(/\s+/).slice(0, k).join(' ');
    if (short.length < 8 || short === needle) continue;
    const sn = normalize(short);
    for (const pi of ordered) {
      const page = isArr ? index[pi] : index[pi];
      if (!page) continue;
      if (page.norm.includes(sn)) {
        const quads = locateWordsInPage(page, short);
        if (quads.length) {
          const rect = boundQuads(quads);
          return { pageIndex: pi, quads, rect };
        }
      }
    }
  }
  return null;
}

// Walk the page's word list and find the contiguous run of words that matches `needle`.
// Return PDF /QuadPoints-style quads suitable for the new highlight.
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
      // Group consecutive matched words by line and produce one quad per line.
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
      // Convert to QuadPoints (PDF user space, TL, TR, BL, BR ordering).
      return runs.map((r) => ({
        x1: r.x0,        y1: r.y + r.h,
        x2: r.x1,        y2: r.y + r.h,
        x3: r.x0,        y3: r.y,
        x4: r.x1,        y4: r.y,
        rect: { x0: r.x0, y0: r.y, x1: r.x1, y1: r.y + r.h }
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
// Writing annotations to pdf-lib doc
// ---------------------------------------------------------------------------

function addTextMarkAnnotation(doc, pageIndex, subtype, quads, color, contents) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  // Flatten quads into PDF QuadPoints array
  const qp = [];
  for (const q of quads) {
    qp.push(q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4);
  }
  // Rect = bounding box of all quads
  const r = boundQuads(quads);
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: [r.x0, r.y0, r.x1, r.y1],
    QuadPoints: qp,
    C: color.slice(0, 3),
    Contents: PDFString.of(contents || ''),
    T: PDFString.of('Carried'),
    F: 4,
    CA: 0.55
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
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: rect,
    Contents: PDFString.of(contents || ''),
    DA: PDFString.of(`/Helv 10 Tf 0 0 0 rg`),
    C: color.slice(0, 3),
    T: PDFString.of('Carried note'),
    F: 4
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
      Type: 'Annot',
      Subtype: a.subtype,
      Rect: r,
      C: a.color.slice(0, 3),
      BS: ctx.obj({ W: 1.5 }),
      Contents: PDFString.of(a.contents || ''),
      F: 4
    });
    if (a.subtype === 'Line') {
      dict.set(PDFName.of('L'), ctx.obj([r[0], r[1], r[2], r[3]]));
    }
  } else if (a.subtype === 'Ink') {
    const translated = a.inkList.map((stroke) => stroke.map(([x, y]) => [x + dx, y + dy]));
    const inkArr = ctx.obj(translated.map((s) => ctx.obj(s.flatMap(([x, y]) => [x, y]))));
    dict = ctx.obj({
      Type: 'Annot',
      Subtype: 'Ink',
      Rect: r,
      C: a.color.slice(0, 3),
      BS: ctx.obj({ W: 1.5 }),
      Contents: PDFString.of(a.contents || ''),
      F: 4
    });
    dict.set(PDFName.of('InkList'), inkArr);
  }
  if (dict) appendAnnot(page, ctx, dict);
}

function addSticky(doc, pageIndex, x, y, contents, color) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [x - 12, y - 12, x + 12, y + 12],
    Contents: PDFString.of(contents),
    C: color.slice(0, 3),
    Name: 'Note',
    T: PDFString.of('Stale annotation'),
    F: 4,
    Open: false
  });
  appendAnnot(page, ctx, dict);
}

function appendAnnot(page, ctx, dict) {
  const ref = ctx.register(dict);
  const existing = page.node.get(PDFName.of('Annots'));
  if (existing && existing.array) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  }
}

function approxPageIndex(oldPageIdx, oldDoc, newDoc) {
  const n = newDoc.getPageCount();
  const o = oldDoc.getPageCount();
  if (o <= 0) return 0;
  return Math.max(0, Math.min(n - 1, Math.round(oldPageIdx * n / o)));
}
function approxLocation(a, oldDoc, newDoc) {
  const pageIndex = approxPageIndex(a.page, oldDoc, newDoc);
  const page = newDoc.getPage(pageIndex);
  return { pageIndex, x: page.getWidth() - 220, y: page.getHeight() - 20 };
}

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
