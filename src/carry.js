// Carry-forward pipeline — fast path.
//
// Reading: PDF.js (tolerant of complex Boeing PDFs).
// Writing: pdf-lib to load + construct annotation dicts only. We DO NOT call
//   doc.save() because that re-serializes the entire document, which is
//   minutes on a Boeing FCTM. Instead we append an **incremental update**:
//   the original PDF bytes are kept verbatim, and we append just the new
//   annotation objects + updated page objects + a tiny xref/trailer. This
//   is exactly how Acrobat saves an edit and is ~100× faster.

import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

const { PDFDocument, PDFName, PDFString, PDFRef, PDFArray } = window.PDFLib;

const TEXT_SUBTYPES = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut']);
const GEO_SUBTYPES  = new Set(['Ink', 'Square', 'Circle', 'Line']);

const LOAD_OPTS = {
  ignoreEncryption: true,
  throwOnInvalidObject: false,
  updateMetadata: false,
  capNumbers: false,
  parseSpeed: 1500,
};

const SEARCH_RADIUS = 8;

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

  // Verify the new PDF uses a classical xref table — required for our
  // incremental-update writer. (Boeing FCTMs typically do.)
  const xrefInfo = locateOriginalXref(newBytes);
  if (!xrefInfo) {
    return {
      blob: new Blob([newBytes], { type: 'application/pdf' }),
      carried: 0, stale: [],
      message: 'Could not locate xref in the new PDF — output unchanged. (This format is unsupported by the fast writer.)',
    };
  }

  const oldIndex = new LazyIndex(oldPdfjs);
  const newIndex = new LazyIndex(newPdfjs);

  onProgress('Opening new PDF…');
  // pdf-lib's load on a 3 MB Boeing PDF is ~5s. We only use it to look up
  // existing page refs and to construct + register new annotation objects.
  const newDoc = await PDFDocument.load(newBytes.slice(0), LOAD_OPTS);
  const ctx = newDoc.context;

  // Snapshot the highest existing object number so we know which refs we add.
  const baseSize = ctx.largestObjectNumber + 1;

  const ledger = {
    newRefs: [],                           // refs of brand-new annotation objects
    modifiedPages: new Map(),              // pageRef.tagged → { ref, page }
    addRef(ref) { this.newRefs.push(ref); },
    addModifiedPage(page) {
      const key = `${page.ref.objectNumber}-${page.ref.generationNumber}`;
      if (!this.modifiedPages.has(key)) this.modifiedPages.set(key, { ref: page.ref, page });
    },
  };

  onProgress(`Carrying ${annots.length} annotations…`);
  let carried = 0;
  const stale = [];

  for (let idx = 0; idx < annots.length; idx++) {
    const a = annots[idx];
    if (idx % 10 === 0) {
      onProgress(`Carrying — ${idx}/${annots.length}`);
      await yieldToUI();
    }
    const expected = approxPageIndex(a.page, nOld, nNew);

    if (TEXT_SUBTYPES.has(a.subtype)) {
      const oldPage = await oldIndex.get(a.page);
      const anchor = extractAnchorTextFromQuads(oldPage, a.quads);
      if (!anchor || anchor.length < 3) continue;
      const hit = await searchInIndex(newIndex, anchor, expected, SEARCH_RADIUS);
      if (hit) {
        addTextMark(newDoc, hit.pageIndex, a.subtype, hit.quads, a.color, a.contents, ledger);
        carried++;
      } else {
        stale.push({ subtype: a.subtype, oldPage: a.page + 1, text: anchor });
      }
    } else if (a.subtype === 'FreeText') {
      const oldPage = await oldIndex.get(a.page);
      const phrase = pickPhrase(extractWordsInRect(oldPage, a.rect, 4), 6);
      const hit = phrase ? await searchInIndex(newIndex, phrase, expected, SEARCH_RADIUS) : null;
      const target = hit
        ? { pageIndex: hit.pageIndex, x: hit.rect.x0, y: hit.rect.y0 }
        : { pageIndex: expected, x: 36, y: 36 };
      addFreeText(newDoc, target.pageIndex, target.x, target.y, a, a.color, a.contents, ledger);
      carried++;
    } else if (GEO_SUBTYPES.has(a.subtype)) {
      const oldPage = await oldIndex.get(a.page);
      const phrase = pickPhrase(extractWordsAboveRect(oldPage, a.rect, 50), 6);
      let dx = 0, dy = 0, targetPage = expected;
      if (phrase) {
        const hit = await searchInIndex(newIndex, phrase, expected, SEARCH_RADIUS);
        if (hit) {
          const oldHit = locateWordsInPage(oldPage, phrase);
          if (oldHit.length) {
            const oldR = boundQuads(oldHit);
            dx = hit.rect.x0 - oldR.x0;
            dy = hit.rect.y0 - oldR.y0;
            targetPage = hit.pageIndex;
          }
        }
      }
      addGeometry(newDoc, targetPage, a, dx, dy, ledger);
      carried++;
    }
  }

  for (const s of stale) {
    const pi = approxPageIndex(s.oldPage - 1, nOld, nNew);
    const page = newDoc.getPage(pi);
    addSticky(newDoc, pi,
      page.getWidth() - 28, page.getHeight() - 28,
      `⚠ Was annotated on old page ${s.oldPage} (${s.subtype}). Text not found in new PDF:\n\n"${s.text.slice(0, 300)}"`,
      [0.85, 0.20, 0.20], ledger);
  }

  onProgress('Writing incremental update…');
  const updateBytes = buildIncrementalUpdate(newBytes, newDoc, ledger, xrefInfo);
  const outBlob = new Blob([newBytes, updateBytes], { type: 'application/pdf' });
  return { blob: outBlob, carried, stale, message: null };
}

// ---------------------------------------------------------------------------
// Incremental-update writer
// ---------------------------------------------------------------------------
//
// PDF spec: keep the original file bytes, append new/updated objects, an xref
// subsection covering those objects, and a trailer whose /Prev points at the
// previous xref. A renderer reads the latest xref last → finds the new objects.

function locateOriginalXref(bytes) {
  // Scan the last 2 KB for "startxref\n<N>\n%%EOF" (with possible \r\n).
  // The xref may be a classical "xref" table OR an xref-stream object
  // (PDF 1.5+). Either is fine — our classical appendix's /Prev can point
  // at either format and PDF readers will follow the chain.
  const tailLen = Math.min(2048, bytes.length);
  const tail = bytes.subarray(bytes.length - tailLen);
  const decoded = new TextDecoder('latin1').decode(tail);
  const m = decoded.match(/startxref\s+(\d+)\s+%%EOF/);
  if (!m) return null;
  return { prevXref: parseInt(m[1], 10) };
}

function buildIncrementalUpdate(originalBytes, doc, ledger, xrefInfo) {
  const enc = new TextEncoder();
  const chunks = [];
  let cursor = originalBytes.length;

  // PDF spec: incremental sections must start on a fresh line.
  if (originalBytes[originalBytes.length - 1] !== 0x0A) {
    chunks.push(new Uint8Array([0x0A]));
    cursor += 1;
  }

  // Re-serialize each modified page (it now has additional /Annots refs).
  // Each modified page keeps its original (objNum, gen) so renderers replace
  // the existing entry.
  const pageRefs = [];
  for (const { ref, page } of ledger.modifiedPages.values()) {
    pageRefs.push({ ref, body: page.node });
  }

  // New annotation objects get freshly-allocated obj numbers (pdf-lib did
  // this for us when we registered them).
  const annotRefs = ledger.newRefs.map((ref) => ({ ref, body: doc.context.lookup(ref) }));

  const entries = [];           // { objNum, gen, offset }
  const writeIndirect = ({ ref, body }) => {
    const header = enc.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    chunks.push(header);
    const offset = cursor;
    cursor += header.length;

    const bodySize = body.sizeInBytes();
    const buf = new Uint8Array(bodySize);
    body.copyBytesInto(buf, 0);
    chunks.push(buf);
    cursor += bodySize;

    const footer = enc.encode('\nendobj\n');
    chunks.push(footer);
    cursor += footer.length;

    entries.push({ objNum: ref.objectNumber, gen: ref.generationNumber, offset });
  };

  for (const e of pageRefs)  writeIndirect(e);
  for (const e of annotRefs) writeIndirect(e);

  // -------- xref subsection --------
  const xrefStart = cursor;
  entries.sort((a, b) => a.objNum - b.objNum);

  // Always include the free-list head entry (object 0).
  // We group consecutive object numbers into subsections per spec.
  const subsections = [];
  // Object 0, always a single entry.
  subsections.push({ start: 0, rows: [{ offset: 0, gen: 65535, type: 'f' }] });

  let i = 0;
  while (i < entries.length) {
    let j = i;
    while (j + 1 < entries.length && entries[j + 1].objNum === entries[j].objNum + 1) j++;
    const rows = [];
    for (let k = i; k <= j; k++) {
      rows.push({ offset: entries[k].offset, gen: entries[k].gen, type: 'n' });
    }
    subsections.push({ start: entries[i].objNum, rows });
    i = j + 1;
  }

  let xrefStr = 'xref\n';
  for (const sub of subsections) {
    xrefStr += `${sub.start} ${sub.rows.length}\n`;
    for (const row of sub.rows) {
      xrefStr += row.offset.toString().padStart(10, '0') + ' ' +
                 row.gen.toString().padStart(5, '0') + ' ' + row.type + ' \n';
    }
  }
  chunks.push(enc.encode(xrefStr));
  cursor += xrefStr.length;

  // -------- trailer --------
  const trailer = doc.context.trailerInfo || {};
  const rootRef = trailer.Root;
  const infoRef = trailer.Info;
  const id = trailer.ID;
  const newSize = doc.context.largestObjectNumber + 1;

  let trailerStr = `trailer\n<< /Size ${newSize} /Prev ${xrefInfo.prevXref}`;
  if (rootRef && rootRef.objectNumber !== undefined) {
    trailerStr += ` /Root ${rootRef.objectNumber} ${rootRef.generationNumber} R`;
  }
  if (infoRef && infoRef.objectNumber !== undefined) {
    trailerStr += ` /Info ${infoRef.objectNumber} ${infoRef.generationNumber} R`;
  }
  if (id) {
    // ID is a PDFArray of two PDFHexString — copy its bytes.
    const idSize = id.sizeInBytes();
    const idBuf = new Uint8Array(idSize);
    id.copyBytesInto(idBuf, 0);
    trailerStr += ' /ID ' + new TextDecoder('latin1').decode(idBuf);
  }
  trailerStr += ` >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(enc.encode(trailerStr));

  // Concatenate.
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Annotation writers
// ---------------------------------------------------------------------------

function addTextMark(doc, pageIndex, subtype, quads, color, contents, ledger) {
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
  appendAnnot(page, ctx, dict, ledger);
}

function addFreeText(doc, pageIndex, x, y, oldAnnot, color, contents, ledger) {
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
  appendAnnot(page, ctx, dict, ledger);
}

function addGeometry(doc, pageIndex, a, dx, dy, ledger) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const r = [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
  let dict;
  if (a.subtype === 'Square' || a.subtype === 'Circle' || a.subtype === 'Line') {
    dict = ctx.obj({
      Type: 'Annot', Subtype: a.subtype,
      Rect: r, C: a.color.slice(0, 3),
      BS: ctx.obj({ W: 1.5 }),
      Contents: PDFString.of(a.contents || ''), F: 4,
    });
    if (a.subtype === 'Line') dict.set(PDFName.of('L'), ctx.obj([r[0], r[1], r[2], r[3]]));
  } else if (a.subtype === 'Ink') {
    const translated = a.inkList.map((s) => s.map(([x, y]) => [x + dx, y + dy]));
    const inkArr = ctx.obj(translated.map((s) => ctx.obj(s.flatMap(([x, y]) => [x, y]))));
    dict = ctx.obj({
      Type: 'Annot', Subtype: 'Ink',
      Rect: r, C: a.color.slice(0, 3),
      BS: ctx.obj({ W: 1.5 }),
      Contents: PDFString.of(a.contents || ''), F: 4,
    });
    dict.set(PDFName.of('InkList'), inkArr);
  }
  if (dict) appendAnnot(page, ctx, dict, ledger);
}

function addSticky(doc, pageIndex, x, y, contents, color, ledger) {
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
  appendAnnot(page, ctx, dict, ledger);
}

function appendAnnot(page, ctx, dict, ledger) {
  const ref = ctx.register(dict);
  const existing = page.node.get(PDFName.of('Annots'));
  if (existing && existing.array) {
    // Mutating the existing /Annots array in place doesn't help us in
    // incremental mode — that array might be its own indirect object we'd
    // need to re-serialize too. So replace with a new direct array that
    // includes the existing entries plus our new ref. Then the only thing
    // we re-emit per modified page is the page dict.
    const merged = ctx.obj([...existing.array, ref]);
    page.node.set(PDFName.of('Annots'), merged);
  } else {
    page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  }
  ledger.addRef(ref);
  ledger.addModifiedPage(page);
}

// ---------------------------------------------------------------------------
// Lazy per-page index
// ---------------------------------------------------------------------------

class LazyIndex {
  constructor(pdfDoc) { this.pdfDoc = pdfDoc; this.cache = new Map(); this.numPages = pdfDoc.numPages; }
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
        words.push({ text: part, x: x + f0 * itemW, y, w: Math.max(1, (f1 - f0) * itemW), h: itemH });
        cursor += part.length;
      }
    }
    const info = { width: vp.width, height: vp.height, words, norm: normalize(words.map((w) => w.text).join(' ')) };
    this.cache.set(pageIndex, info);
    return info;
  }
}

async function searchInIndex(index, needle, startPage, radius) {
  const tries = spiral(startPage, radius, index.numPages);
  for (const pi of tries) {
    const page = await index.get(pi);
    if (!page) continue;
    if (page.norm.includes(normalize(needle))) {
      const quads = locateWordsInPage(page, needle);
      if (quads.length) return { pageIndex: pi, quads, rect: boundQuads(quads) };
    }
  }
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
    if (d === 0) { if (center >= 0 && center < count) out.push(center); continue; }
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
  const out = [];
  for (let i = 0; i + 7 < qp.length; i += 8) {
    out.push({ x1: qp[i], y1: qp[i+1], x2: qp[i+2], y2: qp[i+3], x3: qp[i+4], y3: qp[i+5], x4: qp[i+6], y4: qp[i+7] });
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
// Anchor / word helpers
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
      const cx = w.x + w.w / 2, cy = w.y;
      if (cx >= rect.x0 - 1 && cx <= rect.x1 + 1 && cy >= rect.y0 - 1 && cy <= rect.y1 + 1) out.push(w.text);
    }
  }
  const cleaned = [];
  for (const t of out) if (cleaned[cleaned.length - 1] !== t) cleaned.push(t);
  return cleaned.join(' ');
}
function extractWordsInRect(pageInfo, rect, pad = 0) {
  if (!pageInfo) return [];
  const [x0, y0, x1, y1] = [rect[0]-pad, rect[1]-pad, rect[2]+pad, rect[3]+pad];
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
        x1: r.x0, y1: r.y + r.h, x2: r.x1, y2: r.y + r.h,
        x3: r.x0, y3: r.y,        x4: r.x1, y4: r.y,
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
