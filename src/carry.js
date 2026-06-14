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

// How many pages either side of the proportional anchor we look at.
// 25 catches Boeing-style section restructures without being so wide that
// short anchors match a random other instance of the same word.
const SEARCH_RADIUS = 25;
// Number of context words on each side of the highlight used to disambiguate.
const CONTEXT_WORDS = 4;

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
      const info = extractAnchorWithContext(oldPage, a.quads, CONTEXT_WORDS);
      if (!info || !isUsableAnchor(info.anchor)) continue;   // silently drop noise
      // Smart radius: 6+ word anchors are unique enough to scan the whole
      // document for; shorter anchors stay at the default 25-page window
      // (their context block + closest-to-expected scoring already prevents
      // pulling us into a different chapter).
      const aWordCount = wordsOf(info.anchor).length;
      const radius = aWordCount >= 6 ? nNew : SEARCH_RADIUS;
      const hit = await findBestMatch(newIndex, info, expected, radius);
      if (hit) {
        addTextMark(newDoc, hit.pageIndex, a.subtype, hit.quads, a.color, a.contents, ledger);
        carried++;
      } else if (info.anchor.split(/\s+/).length >= 2) {
        // Only flag genuinely missing multi-word anchors. Single-word misses
        // are usually noise we couldn't pin down, not an actual change.
        stale.push({ subtype: a.subtype, oldPage: a.page + 1, text: info.anchor });
      }
    } else if (a.subtype === 'FreeText') {
      const oldPage = await oldIndex.get(a.page);
      const phrase = pickPhrase(extractWordsInRect(oldPage, a.rect, 4), 8);
      const hit = phrase ? await findBestMatch(newIndex, { anchor: phrase, prefix: '', suffix: '' }, expected, SEARCH_RADIUS) : null;
      const target = hit
        ? { pageIndex: hit.pageIndex, x: hit.rect.x0, y: hit.rect.y0 }
        : { pageIndex: expected, x: 36, y: 36 };
      addFreeText(newDoc, target.pageIndex, target.x, target.y, a, a.color, a.contents, ledger);
      carried++;
    } else if (GEO_SUBTYPES.has(a.subtype)) {
      const oldPage = await oldIndex.get(a.page);
      const phrase = pickPhrase(extractWordsAboveRect(oldPage, a.rect, 50), 8);
      let dx = 0, dy = 0, targetPage = expected;
      if (phrase) {
        const hit = await findBestMatch(newIndex, { anchor: phrase, prefix: '', suffix: '' }, expected, SEARCH_RADIUS);
        if (hit) {
          const oldHit = locateWordsInPage(oldPage, phrase);
          if (oldHit && oldHit.quads.length) {
            const oldR = boundQuads(oldHit.quads);
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
  const updateBytes = await buildIncrementalUpdate(newBytes, newDoc, ledger, xrefInfo);
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
  // Find the LAST "startxref\n<N>\n%%EOF" block — many PDFs already contain
  // their own incremental updates so there can be several startxref markers
  // and we need to chain to the *most recent* one. matchAll + pick-last
  // (regex.match without /g returns only the FIRST, which is the wrong one).
  const tailLen = Math.min(8192, bytes.length);
  const tail = bytes.subarray(bytes.length - tailLen);
  const decoded = new TextDecoder('latin1').decode(tail);
  const matches = [...decoded.matchAll(/startxref\s+(\d+)\s+%%EOF/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { prevXref: parseInt(last[1], 10) };
}

// We emit our incremental update's xref as a PDF 1.5+ **xref stream** rather
// than a classical "xref" table. That keeps the format consistent with the
// original Boeing PDFs (which use xref streams) and satisfies strict readers
// like Apple's PDFKit (macOS Preview, iOS Files) — they refuse to follow a
// `/Prev` pointer from a classical table to an xref stream of a different
// format. xref streams are the canonical incremental-update format for any
// PDF 1.5+ file.
async function buildIncrementalUpdate(originalBytes, doc, ledger, xrefInfo) {
  const enc = new TextEncoder();
  const chunks = [];
  let cursor = originalBytes.length;

  if (originalBytes[originalBytes.length - 1] !== 0x0A) {
    chunks.push(new Uint8Array([0x0A]));
    cursor += 1;
  }

  // Modified pages (rewritten with new /Annots) + brand-new annotation objects.
  const writes = [];
  for (const { ref, page } of ledger.modifiedPages.values()) writes.push({ ref, body: page.node });
  for (const ref of ledger.newRefs) writes.push({ ref, body: doc.context.lookup(ref) });

  const entries = [];           // { objNum, gen, offset } for every indirect we write
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

  for (const e of writes) writeIndirect(e);

  // ---------------- xref stream ----------------
  // The xref stream IS itself an indirect object. Allocate the next obj number
  // for it (pdf-lib's largestObjectNumber already includes our additions).
  const xrefObjNum = doc.context.largestObjectNumber + 1;
  const xrefObjOffset = cursor;

  // Final xref entries — include obj 0 (free list head), every modified/new
  // object, and the xref stream itself (which is also a "new" object).
  const allEntries = [
    { objNum: 0, type: 0, field2: 0, field3: 65535 },
    ...entries.map((e) => ({ objNum: e.objNum, type: 1, field2: e.offset, field3: e.gen })),
    { objNum: xrefObjNum, type: 1, field2: xrefObjOffset, field3: 0 },
  ];
  allEntries.sort((a, b) => a.objNum - b.objNum);

  // Group into contiguous /Index [start count …] subsections.
  const index = [];
  let i = 0;
  while (i < allEntries.length) {
    let j = i;
    while (j + 1 < allEntries.length && allEntries[j + 1].objNum === allEntries[j].objNum + 1) j++;
    index.push(allEntries[i].objNum, j - i + 1);
    i = j + 1;
  }

  // Binary payload: /W [1 4 2] → 7 bytes per entry.
  const payload = new Uint8Array(allEntries.length * 7);
  let p = 0;
  for (const e of allEntries) {
    payload[p++] = e.type & 0xff;
    payload[p++] = (e.field2 >>> 24) & 0xff;
    payload[p++] = (e.field2 >>> 16) & 0xff;
    payload[p++] = (e.field2 >>> 8)  & 0xff;
    payload[p++] = (e.field2)        & 0xff;
    payload[p++] = (e.field3 >>> 8)  & 0xff;
    payload[p++] = (e.field3)        & 0xff;
  }
  const compressed = await deflate(payload);

  // Trailer metadata reused from the loaded doc.
  const trailer = doc.context.trailerInfo || {};
  const rootRef = trailer.Root;
  const infoRef = trailer.Info;
  const id = trailer.ID;
  const newSize = xrefObjNum + 1;

  let dictStr = `<< /Type /XRef /Size ${newSize} /Prev ${xrefInfo.prevXref}`;
  dictStr += ` /W [ 1 4 2 ] /Index [ ${index.join(' ')} ]`;
  if (rootRef && rootRef.objectNumber !== undefined) {
    dictStr += ` /Root ${rootRef.objectNumber} ${rootRef.generationNumber} R`;
  }
  if (infoRef && infoRef.objectNumber !== undefined) {
    dictStr += ` /Info ${infoRef.objectNumber} ${infoRef.generationNumber} R`;
  }
  if (id) {
    const idSize = id.sizeInBytes();
    const idBuf = new Uint8Array(idSize);
    id.copyBytesInto(idBuf, 0);
    dictStr += ' /ID ' + new TextDecoder('latin1').decode(idBuf);
  }
  dictStr += ` /Filter /FlateDecode /Length ${compressed.length} >>`;

  const xrefObjHeader = enc.encode(`${xrefObjNum} 0 obj\n${dictStr}\nstream\n`);
  chunks.push(xrefObjHeader);
  cursor += xrefObjHeader.length;
  chunks.push(compressed);
  cursor += compressed.length;
  const xrefObjFooter = enc.encode(`\nendstream\nendobj\nstartxref\n${xrefObjOffset}\n%%EOF\n`);
  chunks.push(xrefObjFooter);

  // Concatenate.
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Compress with zlib (deflate-with-zlib-header). /FlateDecode expects this format.
async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes); writer.close();
  const reader = cs.readable.getReader();
  const out = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  const total = out.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of out) { merged.set(c, off); off += c.length; }
  return merged;
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
      // Split on whitespace AND inner punctuation that Boeing PDFs love
      // (slash, comma, semicolon, parens, dash, dot in mid-string) so e.g.
      // "Cruise/Driftdown" → ["Cruise","/","Driftdown"]. The matcher then
      // skips the empty-after-normalize separator tokens and "Cruise
      // Driftdown" lines up with the needle.
      const parts = item.str.split(/(\s+|[\/,;:()\[\]"])/).filter(Boolean);
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
    // De-hyphenate soft-wrapped words: "auto-\nthrottle" gets emitted as two
    // tokens "auto-" then "throttle" on adjacent lines. Merge them so the
    // index has the original logical word — otherwise searches for
    // "auto-throttle" or "autothrottle" miss.
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i], b = words[i + 1];
      if (/-$/.test(a.text) && Math.abs(a.y - b.y) > a.h * 0.5) {
        a.text = a.text.replace(/-$/, '') + b.text;
        a.w = (a.w || 0) + (b.w || 0);
        words.splice(i + 1, 1);
        i--;
      }
    }
    const info = { width: vp.width, height: vp.height, words, norm: normalize(words.map((w) => w.text).join(' ')) };
    this.cache.set(pageIndex, info);
    return info;
  }
}

// Best-match lookup with disambiguating context.
//
// Each query has its own search radius based on how UNIQUE it is:
//  - Context-padded queries (anchor + prefix and/or suffix) are highly
//    unique, so we search the WHOLE document — no risk of false positives.
//  - The bare-anchor fallback is restricted to a local window so that
//    short anchors like "approach" don't grab a stray occurrence in a
//    different chapter.
async function findBestMatch(index, info, expected, localRadius) {
  const { anchor, prefix, suffix } = info;
  if (!anchor) return null;
  const aWords = wordsOf(anchor);
  const N = index.numPages;

  const queries = [];
  if (prefix && suffix) queries.push({ text: `${prefix} ${anchor} ${suffix}`, offset: wordsOf(prefix).length, count: aWords.length, radius: N });
  if (prefix)            queries.push({ text: `${prefix} ${anchor}`,           offset: wordsOf(prefix).length, count: aWords.length, radius: N });
  if (suffix)            queries.push({ text: `${anchor} ${suffix}`,           offset: 0,                      count: aWords.length, radius: N });
  // Bare anchor: full doc only when anchor itself is long enough to be
  // self-disambiguating; otherwise stay local.
  queries.push({ text: anchor, offset: 0, count: aWords.length, radius: aWords.length >= 6 ? N : localRadius, strict: aWords.length < 4 });

  for (const q of queries) {
    if (q.text.length < 3) continue;
    const tries = spiral(expected, q.radius, N);
    const hits = [];
    const nq = normalize(q.text);
    for (const pi of tries) {
      const page = await index.get(pi);
      if (!page || !page.norm.includes(nq)) continue;
      const located = locateWordsInPage(page, q.text);
      if (!located) continue;
      hits.push({ pageIndex: pi, ...located });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => Math.abs(a.pageIndex - expected) - Math.abs(b.pageIndex - expected));
    const pick = hits[0];
    if (q.strict && Math.abs(pick.pageIndex - expected) > Math.max(3, localRadius >> 1)) continue;
    // Trim quads to just the anchor portion when the query was context-padded.
    const matchedSpan = pick.wordEnd - pick.wordStart;
    if (q.offset > 0 || q.count < matchedSpan) {
      const page = await index.get(pick.pageIndex);
      const aStart = pick.wordStart + q.offset;
      const aEnd = aStart + q.count;
      const slice = page.words.slice(aStart, aEnd);
      const quads = buildLineQuads(slice);
      if (quads.length) return { pageIndex: pick.pageIndex, quads, rect: boundQuads(quads) };
    }
    return { pageIndex: pick.pageIndex, quads: pick.quads, rect: boundQuads(pick.quads) };
  }
  return null;
}

function wordsOf(s) { return (s || '').trim().split(/\s+/).filter(Boolean); }

// Treat empty, whitespace, or single-character anchors as noise we should
// drop silently — they have no meaningful target in the new PDF.
function isUsableAnchor(s) {
  if (!s) return false;
  const clean = s.replace(/[\s\p{P}]+/gu, '');
  return clean.length >= 3;
}

// Pull the highlighted text, plus a small prefix/suffix window of nearby
// words on the old page, by mapping the quad rects back to word indices
// in pageInfo.words.
function extractAnchorWithContext(pageInfo, quads, contextWords) {
  if (!pageInfo || !quads || !quads.length) return null;
  const seen = new Set();
  for (const q of quads) {
    const xs = [q.x1, q.x2, q.x3, q.x4];
    const ys = [q.y1, q.y2, q.y3, q.y4];
    const rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    for (let i = 0; i < pageInfo.words.length; i++) {
      const w = pageInfo.words[i];
      const cx = w.x + w.w / 2, cy = w.y;
      if (cx >= rect.x0 - 1 && cx <= rect.x1 + 1 && cy >= rect.y0 - 1 && cy <= rect.y1 + 1) seen.add(i);
    }
  }
  if (!seen.size) return null;
  const sorted = [...seen].sort((a, b) => a - b);
  const start = sorted[0], end = sorted[sorted.length - 1] + 1;
  const anchor = pageInfo.words.slice(start, end).map((w) => w.text).join(' ');
  const prefix = pageInfo.words.slice(Math.max(0, start - contextWords), start).map((w) => w.text).join(' ');
  const suffix = pageInfo.words.slice(end, Math.min(pageInfo.words.length, end + contextWords)).map((w) => w.text).join(' ');
  return { anchor, prefix, suffix };
}

function buildLineQuads(words) {
  if (!words || !words.length) return [];
  const runs = [];
  let cur = null;
  for (const w of words) {
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
    x1: r.x0, y1: r.y + r.h,  x2: r.x1, y2: r.y + r.h,
    x3: r.x0, y3: r.y,        x4: r.x1, y4: r.y,
    rect: { x0: r.x0, y0: r.y, x1: r.x1, y1: r.y + r.h },
  }));
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

// Normalize for matching: lowercase, collapse whitespace, fold ligatures and
// curly quotes, strip punctuation/symbols. This is used for the page-level
// substring filter and for word-by-word comparison so "approach," == "approach"
// and "• Engine Fire" == "engine fire".
const LIGATURES = { 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
function normalize(s) {
  if (!s) return '';
  return s
    .replace(/[ﬁﬂﬃﬄﬅﬆ]/g, (c) => LIGATURES[c])
    .replace(/[‐-―−]/g, '-')      // various hyphens/dashes → ASCII '-'
    .replace(/[‘’‚‛]/g, "'") // curly single quotes → '
    .replace(/[“”„‟]/g, '"') // curly double quotes → "
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')         // strip punctuation/symbols (keep apostrophe + hyphen)
    .replace(/\s+/g, ' ')
    .trim();
}

// Per-word normalize: like normalize() but also strips dangling apostrophes/hyphens
// so "approach." matches "approach" and "—" tokens drop out entirely.
function wnorm(s) {
  return normalize(s).replace(/^['-]+|['-]+$/g, '');
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

// Returns null if not found, otherwise { wordStart, wordEnd, quads }.
// Skips empty tokens (standalone punctuation like "-" that normalize() drops),
// so "Takeoff - Engine Failure" still matches the query "takeoff engine failure".
function locateWordsInPage(page, needle) {
  const target = normalize(needle).split(' ').filter(Boolean);
  if (!target.length) return null;
  const words = page.words;
  if (!page.wnorm) page.wnorm = words.map((w) => wnorm(w.text));
  const wn = page.wnorm;

  for (let i = 0; i < words.length; i++) {
    if (!wn[i]) continue;
    let wi = i, ti = 0;
    let lastMatched = i;
    while (ti < target.length && wi < words.length) {
      if (!wn[wi]) { wi++; continue; }
      if (wn[wi] !== target[ti]) break;
      lastMatched = wi;
      wi++; ti++;
    }
    if (ti === target.length) {
      const slice = words.slice(i, lastMatched + 1).filter((_, k) => !!wn[i + k]);
      return { wordStart: i, wordEnd: lastMatched + 1, quads: buildLineQuads(slice) };
    }
  }
  return null;
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

// Single-fire lock — prevents a second click of the share button from
// triggering a second download while the first is still in-flight.
let sharing = false;

export async function shareOrDownload(blob, filename) {
  if (sharing) return { shared: false, busy: true };
  sharing = true;
  try {
    // On a touch device the iOS/iPadOS share sheet is the right UX; on
    // desktop, calling navigator.share triggers Safari's share menu but
    // many platforms ALSO drop a file in ~/Downloads, producing two files.
    // Just download on desktop.
    const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 1;
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return { shared: true };
      } catch (err) {
        if (err && err.name === 'AbortError') return { shared: false, cancelled: true };
        // Any other error → fall through to download.
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    await new Promise((r) => setTimeout(r, 600));
    URL.revokeObjectURL(url); a.remove();
    return { shared: false };
  } finally {
    // Brief cooldown so a stray second click is debounced.
    setTimeout(() => { sharing = false; }, 1200);
  }
}
