let apiCall, toastFn;
let ready = false;
let currentFilter = 'all';
let showCaptureLog = false;

export async function initMemory(api, toast) {
  apiCall = api; toastFn = toast;
  const container = document.getElementById('tab-memory');
  if (!ready) { buildLayout(container); ready = true; }
  await refresh();
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function buildLayout(container) {
  container.innerHTML = '';
  const page = el('div', 'settings-page');

  const sidebar = el('aside', 'settings-sidebar');
  const title = el('div', 'smallcaps title');
  title.textContent = 'Memory';
  sidebar.appendChild(title);

  const nav = document.createElement('nav');
  const filters = [
    { id: 'all', label: 'All memories', hint: 'Everything active' },
    { id: 'auto', label: 'Auto-captured', hint: 'Extracted from chat' },
    { id: 'manual', label: 'Manual', hint: 'Saved with /remember' },
    { id: 'log', label: 'Capture log', hint: 'Every extraction outcome' },
  ];
  filters.forEach(f => {
    const btn = el('button', `nav-btn${f.id === currentFilter && !showCaptureLog ? ' active' : ''}`);
    btn.dataset.filter = f.id;
    btn.innerHTML = `<span class="name">${f.label}</span><span class="hint">${f.hint}</span>`;
    btn.addEventListener('click', async () => {
      showCaptureLog = f.id === 'log';
      if (!showCaptureLog) currentFilter = f.id;
      nav.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await refresh();
    });
    nav.appendChild(btn);
  });
  sidebar.appendChild(nav);

  const detail = el('div', 'settings-detail');
  const inner = el('div', 'settings-detail-inner');
  inner.id = 'memory-content';
  detail.appendChild(inner);

  page.append(sidebar, detail);
  container.appendChild(page);
}

async function refresh() {
  const c = document.getElementById('memory-content');
  if (!c) return;
  try {
    if (showCaptureLog) {
      const data = await apiCall('/api/memories/captures?limit=100');
      renderCaptureLog(c, data.captures || []);
    } else {
      const query = currentFilter === 'all' ? '' : `?source=${currentFilter}`;
      const data = await apiCall(`/api/memories${query}`);
      renderMemories(c, data.memories || [], data.autoCapture || {});
    }
  } catch (err) {
    c.innerHTML = `<div style="color:var(--err);padding:32px">Failed to load: ${esc(err.message)}</div>`;
  }
}

function header(title, lede) {
  return `<div class="section-header"><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</div>`;
}

function renderMemories(c, memories, autoCapture) {
  const filterLabel = currentFilter === 'auto' ? 'Auto-captured memories'
    : currentFilter === 'manual' ? 'Manual memories' : 'Memories';
  const stateNote = autoCapture.enabled
    ? 'Automatic capture is on: durable facts are extracted after each reply, deduplicated, and saved here.'
    : 'Automatic capture is off (memory.auto.enabled). Only /remember saves memories.';
  c.innerHTML = header(filterLabel, stateNote);

  if (memories.length === 0) {
    c.innerHTML += '<div style="font-size:12.5px;color:var(--ink-mute);font-style:italic;padding:8px 0">No memories yet.</div>';
    return;
  }

  const list = el('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  memories.forEach(m => list.appendChild(memoryRow(m)));
  c.appendChild(list);
}

function memoryRow(m) {
  const row = el('div', 'db-row');
  row.style.alignItems = 'flex-start';

  const main = el('div');
  main.style.cssText = 'flex:1;min-width:0';

  const content = el('div');
  content.style.cssText = 'font-size:13px;color:var(--ink);line-height:1.5';
  content.textContent = m.content;
  main.appendChild(content);

  const meta = el('div');
  meta.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--ink-mute)';
  meta.innerHTML = [
    `<span class="mono">${esc(m.type)}</span>`,
    `<span class="mono" style="color:${m.source === 'auto' ? 'var(--accent-ink)' : 'var(--ink-mute)'}">${m.source}</span>`,
    `<span>${esc(fmtTime(m.created))}</span>`,
    `<span class="mono" style="color:var(--ink-faint)">${esc(m.id.slice(0, 8))}</span>`,
  ].join('');
  main.appendChild(meta);

  if (m.capture && m.capture.sourcePreview) {
    const src = el('div');
    src.style.cssText = 'margin-top:5px;font-size:11px;color:var(--ink-faint);font-style:italic';
    src.textContent = `From: "${m.capture.sourcePreview}"`;
    main.appendChild(src);
  }

  const del = el('button', 'identity-proposal-btn danger');
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    del.disabled = true;
    try {
      await deleteMemory(m.id);
      toastFn('Memory deleted', 'success');
      await refresh();
    } catch (err) {
      toastFn(`Could not delete: ${err.message}`, 'error');
      del.disabled = false;
    }
  });

  row.append(main, del);
  return row;
}

async function deleteMemory(id) {
  const data = await apiCall(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (data.error) throw new Error(data.error);
  return data;
}

function renderCaptureLog(c, captures) {
  c.innerHTML = header('Capture log', 'Every automatic extraction outcome — including duplicates, invalid output, and errors — so bad captures are easy to spot.');

  if (captures.length === 0) {
    c.innerHTML += '<div style="font-size:12.5px;color:var(--ink-mute);font-style:italic;padding:8px 0">No captures logged yet.</div>';
    return;
  }

  const colors = { created: 'var(--ok, #3a9c5f)', duplicate: 'var(--ink-mute)', invalid: 'var(--warn, #b98a2f)', error: 'var(--err)' };
  const list = el('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  captures.forEach(cap => {
    const row = el('div', 'db-row');
    row.style.alignItems = 'flex-start';
    const main = el('div');
    main.style.cssText = 'flex:1;min-width:0';

    const top = el('div');
    top.style.cssText = 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap';
    top.innerHTML = [
      `<span class="mono smallcaps" style="font-size:10px;color:${colors[cap.action] || 'var(--ink-mute)'}">${esc(cap.action)}</span>`,
      cap.similarity !== null && cap.similarity !== undefined ? `<span class="mono" style="font-size:10.5px;color:var(--ink-faint)">sim ${Number(cap.similarity).toFixed(3)}</span>` : '',
      `<span style="font-size:11px;color:var(--ink-faint)">${esc(fmtTime(cap.createdAt))}</span>`,
    ].join('');
    main.appendChild(top);

    if (cap.content) {
      const content = el('div');
      content.style.cssText = 'font-size:12.5px;color:var(--ink);margin-top:3px';
      content.textContent = cap.content;
      main.appendChild(content);
    }
    if (cap.reason) {
      const reason = el('div');
      reason.style.cssText = 'font-size:11px;color:var(--ink-mute);margin-top:2px';
      reason.textContent = cap.reason;
      main.appendChild(reason);
    }
    if (cap.sourcePreview) {
      const src = el('div');
      src.style.cssText = 'font-size:11px;color:var(--ink-faint);font-style:italic;margin-top:2px';
      src.textContent = `From: "${cap.sourcePreview}"`;
      main.appendChild(src);
    }

    row.appendChild(main);
    list.appendChild(row);
  });
  c.appendChild(list);
}
