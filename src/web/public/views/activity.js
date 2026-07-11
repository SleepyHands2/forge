let apiCall, toastFn;
let ready = false;
let currentSection = 'tools';

export async function initActivity(api, toast) {
  apiCall = api; toastFn = toast;
  const container = document.getElementById('tab-activity');
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
  title.textContent = 'Activity';
  sidebar.appendChild(title);

  const nav = document.createElement('nav');
  const sections = [
    { id: 'tools', label: 'Tool calls', hint: 'Every call, allowed or denied' },
    { id: 'runs', label: 'Scheduler runs', hint: 'Jobs and reminders' },
    { id: 'reminders', label: 'Reminders', hint: 'Pending and recent' },
  ];
  sections.forEach(s => {
    const btn = el('button', `nav-btn${s.id === currentSection ? ' active' : ''}`);
    btn.dataset.section = s.id;
    btn.innerHTML = `<span class="name">${s.label}</span><span class="hint">${s.hint}</span>`;
    btn.addEventListener('click', async () => {
      currentSection = s.id;
      nav.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await refresh();
    });
    nav.appendChild(btn);
  });
  sidebar.appendChild(nav);

  const detail = el('div', 'settings-detail');
  const inner = el('div', 'settings-detail-inner');
  inner.id = 'activity-content';
  detail.appendChild(inner);

  page.append(sidebar, detail);
  container.appendChild(page);
}

async function refresh() {
  const c = document.getElementById('activity-content');
  if (!c) return;
  try {
    if (currentSection === 'tools') {
      const data = await apiCall('/api/activity/tools?limit=100');
      renderToolCalls(c, data.calls || []);
    } else if (currentSection === 'runs') {
      const data = await apiCall('/api/activity/runs?limit=50');
      renderRuns(c, data.runs || []);
    } else {
      const data = await apiCall('/api/activity/reminders');
      renderReminders(c, data.pending || [], data.recent || []);
    }
  } catch (err) {
    c.innerHTML = `<div style="color:var(--err);padding:32px">Failed to load: ${esc(err.message)}</div>`;
  }
}

function header(title, lede) {
  return `<div class="section-header"><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</div>`;
}

function emptyNote(text) {
  return `<div style="font-size:12.5px;color:var(--ink-mute);font-style:italic;padding:8px 0">${text}</div>`;
}

function renderToolCalls(c, calls) {
  c.innerHTML = header('Tool calls', 'Every tool call the agent made — allowed or denied — with outcome, duration, and arguments.');

  if (calls.length === 0) {
    c.innerHTML += emptyNote('No tool calls yet.');
    return;
  }

  const list = el('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  calls.forEach(call => list.appendChild(toolCallRow(call)));
  c.appendChild(list);
}

function toolCallRow(call) {
  const row = el('div', 'db-row');
  row.style.alignItems = 'flex-start';
  const main = el('div');
  main.style.cssText = 'flex:1;min-width:0';

  let statusWord, statusColor;
  if (!call.allowed) {
    statusWord = 'denied'; statusColor = 'var(--err)';
  } else if (call.ok === false) {
    statusWord = 'error'; statusColor = 'var(--err)';
  } else if (call.ok === true) {
    statusWord = 'ok'; statusColor = 'var(--ok, #3a9c5f)';
  } else {
    statusWord = 'pending'; statusColor = 'var(--ink-mute)';
  }

  const top = el('div');
  top.style.cssText = 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap';
  top.innerHTML = [
    `<span class="mono" style="font-size:12.5px;color:var(--ink)">${esc(call.toolName)}</span>`,
    `<span class="mono smallcaps" style="font-size:10px;color:var(--ink-faint)">${esc(call.permission)}</span>`,
    `<span class="mono smallcaps" style="font-size:10px;color:${statusColor}">${statusWord}</span>`,
    call.durationMs !== null && call.durationMs !== undefined ? `<span class="mono" style="font-size:10.5px;color:var(--ink-faint)">${Number(call.durationMs)}ms</span>` : '',
    `<span style="font-size:11px;color:var(--ink-faint)">${esc(fmtTime(call.createdAt))}</span>`,
  ].join('');
  main.appendChild(top);

  if (call.argsSummary) {
    const args = el('div', 'mono');
    args.style.cssText = 'font-size:11px;color:var(--ink-mute);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    args.textContent = call.argsSummary;
    main.appendChild(args);
  }
  if (!call.allowed && call.deniedReason) {
    const reason = el('div');
    reason.style.cssText = 'font-size:11px;color:var(--err);margin-top:2px';
    reason.textContent = call.deniedReason;
    main.appendChild(reason);
  }
  if (call.error) {
    const err = el('div');
    err.style.cssText = 'font-size:11px;color:var(--err);margin-top:2px';
    err.textContent = call.error;
    main.appendChild(err);
  }

  row.appendChild(main);
  return row;
}

function renderRuns(c, runs) {
  c.innerHTML = header('Scheduler runs', 'Every scheduled job run and reminder tick — ok, error, or skipped for overlap.');

  if (runs.length === 0) {
    c.innerHTML += emptyNote('No scheduler runs yet.');
    return;
  }

  const colors = { ok: 'var(--ok, #3a9c5f)', error: 'var(--err)', skipped: 'var(--ink-mute)' };
  const list = el('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  runs.forEach(run => {
    const row = el('div', 'db-row');
    row.style.alignItems = 'flex-start';
    const main = el('div');
    main.style.cssText = 'flex:1;min-width:0';

    const top = el('div');
    top.style.cssText = 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap';
    top.innerHTML = [
      `<span class="mono" style="font-size:12.5px;color:var(--ink)">${esc(run.jobName)}</span>`,
      `<span class="mono smallcaps" style="font-size:10px;color:${colors[run.status] || 'var(--ink-mute)'}">${esc(run.status)}</span>`,
      run.durationMs !== null && run.durationMs !== undefined ? `<span class="mono" style="font-size:10.5px;color:var(--ink-faint)">${Number(run.durationMs)}ms</span>` : '',
      run.delivered ? `<span class="mono" style="font-size:10.5px;color:var(--accent-ink)">&rarr; telegram</span>` : '',
      `<span style="font-size:11px;color:var(--ink-faint)">${esc(fmtTime(run.createdAt))}</span>`,
    ].join('');
    main.appendChild(top);

    if (run.detail) {
      const detail = el('div');
      detail.style.cssText = 'font-size:11px;color:var(--ink-mute);margin-top:2px';
      detail.textContent = run.detail;
      main.appendChild(detail);
    }

    row.appendChild(main);
    list.appendChild(row);
  });
  c.appendChild(list);
}

function renderReminders(c, pending, recent) {
  c.innerHTML = header('Reminders', 'One-shot reminders — pending in due order, then the most recent delivered, cancelled, or failed.');

  const pendingTitle = el('div', 'smallcaps');
  pendingTitle.style.cssText = 'font-size:10.5px;color:var(--ink-mute);margin:4px 0 8px';
  pendingTitle.textContent = 'Pending';
  c.appendChild(pendingTitle);

  if (pending.length === 0) {
    c.innerHTML += emptyNote('No pending reminders.');
  } else {
    const list = el('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    pending.forEach(r => list.appendChild(reminderRow(r, true)));
    c.appendChild(list);
  }

  const divider = el('div');
  divider.style.cssText = 'border-top:1px solid var(--line, rgba(128,128,128,.25));margin:18px 0 12px';
  c.appendChild(divider);

  const recentTitle = el('div', 'smallcaps');
  recentTitle.style.cssText = 'font-size:10.5px;color:var(--ink-mute);margin:0 0 8px';
  recentTitle.textContent = 'Recent';
  c.appendChild(recentTitle);

  if (recent.length === 0) {
    c.innerHTML += emptyNote('No recent reminders.');
  } else {
    const list = el('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    recent.forEach(r => list.appendChild(reminderRow(r, false)));
    c.appendChild(list);
  }
}

function reminderRow(r, isPending) {
  const colors = { sent: 'var(--ok, #3a9c5f)', error: 'var(--err)', cancelled: 'var(--ink-mute)', pending: 'var(--accent-ink)' };
  const row = el('div', 'db-row');
  row.style.alignItems = 'flex-start';
  const main = el('div');
  main.style.cssText = 'flex:1;min-width:0';

  const content = el('div');
  content.style.cssText = 'font-size:13px;color:var(--ink);line-height:1.5';
  content.textContent = r.message;
  main.appendChild(content);

  const meta = el('div');
  meta.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--ink-mute)';
  meta.innerHTML = [
    `<span class="mono smallcaps" style="font-size:10px;color:${colors[r.status] || 'var(--ink-mute)'}">${esc(r.status)}</span>`,
    `<span>${isPending ? 'due' : 'was due'} ${esc(fmtTime(r.dueAt))}</span>`,
    r.sentAt ? `<span style="color:var(--ink-faint)">sent ${esc(fmtTime(r.sentAt))}</span>` : '',
  ].join('');
  main.appendChild(meta);

  if (r.error) {
    const err = el('div');
    err.style.cssText = 'font-size:11px;color:var(--err);margin-top:2px';
    err.textContent = r.error;
    main.appendChild(err);
  }

  row.appendChild(main);
  return row;
}
