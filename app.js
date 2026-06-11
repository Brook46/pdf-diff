// Minimal orchestrator: drop two PDFs → carry annotations → share/download.

import { carry, shareOrDownload } from './src/carry.js';

// Service worker + auto-update.
// If a new SW is available we install it and reload once it's controlling
// the page, so users always get the latest code on next launch.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            // New version is installed and an old controller is still active.
            // Take over right away.
            sw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return; reloading = true;
        location.reload();
      });
    } catch {}
  });
}

// -------- Theme (Auto → Light → Dark) --------
const themeOrder = ['auto', 'light', 'dark'];
const themeIcons = {
  light: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3 M5.2 5.2 l2 2 M16.8 16.8 l2 2 M5.2 18.8 l2 -2 M16.8 7.2 l2 -2"/>',
  dark:  '<path d="M20 14.5 A8 8 0 1 1 9.5 4 A6.5 6.5 0 0 0 20 14.5 Z"/>',
  auto:  '<circle cx="12" cy="12" r="5"/><path d="M12 7 A5 5 0 0 1 12 17 Z" fill="currentColor" stroke="none"/><path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3"/>'
};
function applyTheme(mode) {
  document.body.dataset.theme = mode;
  const themeColor = (mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches))
    ? '#0f1115' : '#fafafa';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', themeColor));
  document.getElementById('theme-btn').innerHTML =
    `<svg viewBox="0 0 24 24" aria-hidden="true">${themeIcons[mode]}</svg>`;
  document.getElementById('theme-btn').title = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)} — tap to cycle`;
  try { localStorage.setItem('pdf-diff:theme', mode); } catch {}
}
applyTheme(localStorage.getItem('pdf-diff:theme') || 'auto');
document.getElementById('theme-btn').addEventListener('click', () => {
  const cur = document.body.dataset.theme || 'auto';
  applyTheme(themeOrder[(themeOrder.indexOf(cur) + 1) % themeOrder.length]);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (document.body.dataset.theme === 'auto') applyTheme('auto');
});

// -------- Dropzones --------
const files = { old: null, new: null };
let resultBlob = null;
let resultName = 'annotated.pdf';

for (const slot of ['old', 'new']) {
  const el = document.getElementById('dz-' + slot);
  const input = el.querySelector('input[type=file]');
  // The <label> wrapping the input handles click → file picker natively;
  // we don't add a JS click handler (iOS Safari rejects programmatic .click()
  // on file inputs unless inside a *direct* user-gesture handler).
  input.addEventListener('change', () => { if (input.files[0]) accept(slot, input.files[0]); });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-drag'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-drag'));
  el.addEventListener('drop', (e) => {
    e.preventDefault(); el.classList.remove('is-drag');
    const f = e.dataTransfer.files[0];
    if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) accept(slot, f);
  });
}

// Allow paste anywhere on the input screen.
window.addEventListener('paste', (e) => {
  if (document.getElementById('screen-input').hidden) return;
  const item = [...(e.clipboardData?.items || [])].find((it) => it.type === 'application/pdf');
  if (!item) return;
  const target = files.old ? 'new' : 'old';
  accept(target, item.getAsFile());
});

function accept(slot, file) {
  files[slot] = file;
  const el = document.getElementById('dz-' + slot);
  el.classList.add('has-file');
  el.querySelector('[data-filename]').textContent = file.name;
  document.getElementById('go-btn').disabled = !(files.old && files.new);
}

// -------- Carry button --------
document.getElementById('go-btn').addEventListener('click', run);

async function run() {
  show('working');
  setMsg('Reading PDFs…');
  try {
    const result = await carry(files.old, files.new, setMsg);
    resultBlob = result.blob;
    const base = (files.new.name || 'output').replace(/\.pdf$/i, '');
    resultName = `${base}__carried.pdf`;

    document.getElementById('stat-carried').textContent = String(result.carried);
    document.getElementById('stat-stale').textContent = String(result.stale.length);
    document.getElementById('result-subtitle').textContent = result.message
      ? result.message
      : `Your annotated PDF is ready. Tap below to save it or send it on to PDF Expert, Files, Mail, or AirDrop.`;

    const staleUl = document.getElementById('stale-list');
    const staleDetails = document.getElementById('stale-details');
    staleUl.innerHTML = '';
    if (result.stale.length) {
      staleDetails.hidden = false;
      for (const s of result.stale.slice(0, 200)) {
        const li = document.createElement('li');
        li.innerHTML = `<strong>p.${s.oldPage}</strong> · <code>${s.subtype}</code> — ${escapeHtml(truncate(s.text, 220))}`;
        staleUl.appendChild(li);
      }
    } else {
      staleDetails.hidden = true;
    }

    show('result');
  } catch (err) {
    show('input');
    alert('Could not process the PDFs.\n\n' + (err?.message || err));
  }
}

document.getElementById('share-btn').addEventListener('click', async () => {
  if (!resultBlob) return;
  await shareOrDownload(resultBlob, resultName);
});

document.getElementById('reset-btn').addEventListener('click', () => {
  files.old = files.new = null;
  resultBlob = null;
  for (const slot of ['old', 'new']) {
    const el = document.getElementById('dz-' + slot);
    el.classList.remove('has-file');
    el.querySelector('[data-filename]').textContent = '';
    el.querySelector('input').value = '';
  }
  document.getElementById('go-btn').disabled = true;
  show('input');
});

// -------- Screen switcher --------
function show(state) {
  document.getElementById('screen-input').hidden   = state !== 'input';
  document.getElementById('screen-working').hidden = state !== 'working';
  document.getElementById('screen-result').hidden  = state !== 'result';
}
function setMsg(s) { document.getElementById('working-msg').textContent = s; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function truncate(s, n) { return s.length > n ? s.slice(0, n-1) + '…' : s; }
