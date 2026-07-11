let apiCall, toastFn;
let ready = false;

const ACCEPT = '.pdf,.md,.txt,.csv';
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export async function initDocs(api, toast) {
  apiCall = api; toastFn = toast;
  const container = document.getElementById('tab-docs');
  if (!ready) { buildLayout(container); ready = true; }
  await refresh();
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function buildLayout(container) {
  container.innerHTML = '';
  const page = el('div', 'settings-page');

  const sidebar = el('aside', 'settings-sidebar');
  const title = el('div', 'smallcaps title');
  title.textContent = 'Documents';
  sidebar.appendChild(title);

  const hint = el('div');
  hint.style.cssText = 'font-size:11.5px;color:var(--ink-mute);line-height:1.5;margin-bottom:14px';
  hint.textContent = 'Uploaded documents are chunked and embedded locally. Relevant excerpts are retrieved into chat context, and replies cite their sources.';
  sidebar.appendChild(hint);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = ACCEPT;
  fileInput.multiple = true;
  fileInput.style.display = 'none';

  const uploadBtn = el('button', 'btn btn-primary');
  uploadBtn.textContent = 'Upload documents';
  uploadBtn.style.width = '100%';
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    await handleUpload(fileInput.files, uploadBtn);
    fileInput.value = '';
  });

  sidebar.append(uploadBtn, fileInput);

  const detail = el('div', 'settings-detail');
  const inner = el('div', 'settings-detail-inner');
  inner.id = 'docs-content';
  detail.appendChild(inner);

  page.append(sidebar, detail);
  container.appendChild(page);
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    });
    reader.addEventListener('error', () => reject(reader.error || new Error('File read failed.')));
    reader.readAsDataURL(file);
  });
}

async function handleUpload(files, button) {
  const list = Array.from(files || []);
  if (!list.length) return;
  button.disabled = true;
  button.textContent = 'Uploading…';

  for (const file of list) {
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    const max = isPdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
    if (file.size > max) {
      toastFn(`${file.name} is over the ${formatBytes(max)} limit.`, 'error');
      continue;
    }
    try {
      const data = await readAsBase64(file);
      const res = await apiCall('/api/documents', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, data }),
      });
      if (res.error) throw new Error(res.error);
      const doc = res.document;
      if (doc.status === 'ready') {
        toastFn(`${doc.name}: indexed ${doc.chunkCount} chunks`, 'success');
      } else {
        toastFn(`${doc.name}: ${doc.error || 'ingestion failed'}`, 'error');
      }
    } catch (err) {
      toastFn(`${file.name}: ${err.message}`, 'error');
    }
  }

  button.disabled = false;
  button.textContent = 'Upload documents';
  await refresh();
}

async function refresh() {
  const c = document.getElementById('docs-content');
  if (!c) return;
  try {
    const data = await apiCall('/api/documents');
    renderDocuments(c, data.documents || [], data.rag || {});
  } catch (err) {
    c.innerHTML = `<div style="color:var(--err);padding:32px">Failed to load: ${esc(err.message)}</div>`;
  }
}

function renderDocuments(c, documents, rag) {
  const note = rag.enabled
    ? 'Documents are retrieved into chat context when relevant. Excerpts are treated as untrusted reference data.'
    : 'Document retrieval is off (rag.enabled). Uploaded documents are stored but not injected into chat.';
  c.innerHTML = `<div class="section-header"><h1>Documents</h1><p class="lede">${esc(note)}</p></div>`;

  if (documents.length === 0) {
    c.innerHTML += '<div style="font-size:12.5px;color:var(--ink-mute);font-style:italic;padding:8px 0">No documents uploaded yet. Drop in a PDF, Markdown, text, or CSV file.</div>';
    return;
  }

  const list = el('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  documents.forEach(doc => list.appendChild(documentRow(doc)));
  c.appendChild(list);
}

function documentRow(doc) {
  const row = el('div', 'db-row');
  row.style.alignItems = 'flex-start';

  const main = el('div');
  main.style.cssText = 'flex:1;min-width:0';

  const name = el('div');
  name.style.cssText = 'font-size:13px;color:var(--ink)';
  name.innerHTML = `<span class="mono">${esc(doc.name)}</span>`;
  main.appendChild(name);

  const ok = doc.status === 'ready';
  const meta = el('div');
  meta.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;font-size:11px;color:var(--ink-mute)';
  meta.innerHTML = [
    `<span class="mono">${esc(doc.type)}</span>`,
    `<span>${formatBytes(doc.size)}</span>`,
    ok ? `<span>${doc.chunkCount} chunks</span>` : '',
    `<span style="color:${ok ? 'var(--ok, #3a9c5f)' : 'var(--err)'}">${ok ? 'ready' : 'failed'}</span>`,
    `<span>${esc(fmtTime(doc.created))}</span>`,
  ].filter(Boolean).join('');
  main.appendChild(meta);

  if (!ok && doc.error) {
    const err = el('div');
    err.style.cssText = 'margin-top:4px;font-size:11px;color:var(--err)';
    err.textContent = doc.error;
    main.appendChild(err);
  }

  const del = el('button', 'identity-proposal-btn danger');
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    del.disabled = true;
    try {
      const res = await apiCall(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
      if (res.error) throw new Error(res.error);
      toastFn(`${doc.name} deleted`, 'success');
      await refresh();
    } catch (err) {
      toastFn(`Could not delete: ${err.message}`, 'error');
      del.disabled = false;
    }
  });

  row.append(main, del);
  return row;
}
