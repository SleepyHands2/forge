let messages = [];
let selectedMsgId = null;
let thinking = false;
let msgContainer = null;
let toastFn = () => {};
let apiCall = null;
let assistantName = 'forge';
let threadMetaConfig = { contextWindowTokens: 80000 };
const identityFileOrder = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'NOTES.md'];
const identityFallbackMeta = {
  'IDENTITY.md': { trust: 'high', modelWritable: false },
  'SOUL.md': { trust: 'high', modelWritable: false },
  'USER.md': { trust: 'high', modelWritable: false },
  'NOTES.md': { trust: 'lower-trust notes', modelWritable: true },
};

export function setMsgContainer(el) { msgContainer = el; }
export function setMessages(m) { messages = m; }
export function getMessages() { return messages; }
export function getThinking() { return thinking; }
export function setThinking(v) { thinking = v; }
export function setSelectedMsgId(v) { selectedMsgId = v; }
export function setToastFn(fn) { toastFn = fn; }
export function setApiCall(fn) { apiCall = fn; }
export function setAssistantName(name) {
  assistantName = name || 'forge';
}
export function setThreadMetaConfig(config) {
  threadMetaConfig = {
    ...threadMetaConfig,
    ...config,
  };
}

let ttsSpeakFn = null;
export function setTtsSpeak(fn) { ttsSpeakFn = fn; }

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function textToHtml(text) {
  if (!text) return '';
  const safe = renderGeneratedImages(esc(text));
  return safe.split(/\n\n+/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

// Replies that reference generated images (/api/images/*.png, plain or as
// markdown image syntax) render them inline. Runs on escaped text; the
// filename pattern admits no markup.
function renderGeneratedImages(safe) {
  const img = url => `<img class="gen-image" src="${url}" alt="generated image" loading="lazy">`;
  return safe
    .replace(/!\[[^\]]*\]\((\/api\/images\/[A-Za-z0-9_-]+\.png)\)/g, (_, url) => img(url))
    .replace(/(^|[\s>])(\/api\/images\/[A-Za-z0-9_-]+\.png)/g, (_, lead, url) => `${lead}${img(url)}`);
}

function formatIdentityTrust(file) {
  const trust = file?.trust || identityFallbackMeta[file?.name]?.trust || '';
  if (!trust) return file?.name === 'NOTES.md' ? 'lower-trust notes' : 'high trust';
  if (trust === 'high') return 'high trust';
  if (trust === 'lower') return 'lower trust';
  return String(trust).replace(/-/g, ' ');
}

function normalizeIdentityFiles(files = []) {
  const byName = new Map(files.map(file => [file.name, file]));
  return identityFileOrder.map(name => ({
    name,
    content: '',
    ...identityFallbackMeta[name],
    ...(byName.get(name) || {}),
  }));
}

function getProposalTarget(proposal) {
  return proposal?.targetFile || proposal?.filename || proposal?.fileName || proposal?.file || proposal?.name || 'IDENTITY.md';
}

function getProposalContent(proposal) {
  return proposal?.content || proposal?.proposedContent || proposal?.proposed || proposal?.body || '';
}

function getProposalReason(proposal) {
  return proposal?.reason || proposal?.summary || proposal?.description || '';
}

function getProposalCreated(proposal) {
  const raw = proposal?.createdAt || proposal?.created || proposal?.timestamp || proposal?.ts;
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(raw);
  return date.toLocaleString();
}

export function scrollToBottom(container) {
  const s = container?.querySelector?.('.chat-center')
    || container?.querySelector?.('.chat-scroll')
    || document.querySelector('.chat-center')
    || document.querySelector('.chat-scroll');
  if (!s) return;

  const scroll = () => { s.scrollTop = s.scrollHeight; };
  requestAnimationFrame(() => {
    scroll();
    requestAnimationFrame(scroll);
  });
}

export function renderAllMessages() {
  if (!msgContainer) return;
  msgContainer.innerHTML = '';
  messages.forEach((m, i) => {
    msgContainer.appendChild(m.role === 'assistant' ? mkAssistant(m, i, i === 0) : mkUser(m));
  });
  const lastA = messages.reduce((a, m, i) => m.role === 'assistant' ? i : a, -1);
  if (lastA >= 0) selectMessage(lastA);
  renderThreadMeta();
}

export function mkAssistant(msg, idx, first) {
  const div = el('div', `msg-assistant${selectedMsgId === idx ? ' selected' : ''}`);
  div.dataset.idx = idx;
  if (!first) div.style.marginTop = '36px';
  div.addEventListener('click', () => selectMessage(idx));

  div.appendChild(el('div', 'node-dot'));
  const sender = el('div', 'sender smallcaps');
  sender.textContent = assistantName;
  div.appendChild(sender);

  const prose = el('div', 'prose');
  prose.innerHTML = textToHtml(msg.text);
  div.appendChild(prose);

  if (msg.meta?.sources?.length) {
    const sources = el('div');
    sources.style.cssText = 'margin-top:8px;font-size:11px;color:var(--ink-mute);display:flex;gap:6px;flex-wrap:wrap;align-items:baseline';
    const label = el('span', 'smallcaps');
    label.style.cssText = 'font-size:9.5px;color:var(--ink-faint)';
    label.textContent = 'sources';
    sources.appendChild(label);
    const seen = new Set();
    msg.meta.sources.forEach(s => {
      const key = `${s.name}#${s.chunkIndex}`;
      if (seen.has(key)) return;
      seen.add(key);
      const chip = el('span', 'mono');
      chip.style.cssText = 'border:1px solid var(--rule);border-radius:4px;padding:1px 6px';
      chip.textContent = `${s.name} · part ${(s.chunkIndex ?? 0) + 1}`;
      chip.title = s.similarity !== undefined ? `similarity ${s.similarity}` : '';
      sources.appendChild(chip);
    });
    div.appendChild(sources);
  }

  if (msg.meta) {
    const meta = el('div', 'meta-line');
    const sep = '<span style="color:var(--ink-faint)">·</span>';
    meta.innerHTML = [
      `<span class="mono">${esc(msg.meta.model)}</span>`, sep,
      `<span class="mono">${msg.meta.input}↓ ${msg.meta.output}↑ tok</span>`, sep,
      `<span class="mono">${esc(msg.ts)}</span>`,
      '<div style="flex:1"></div>',
    ].join('');
    if (ttsSpeakFn && msg.text) {
      const speakBtn = el('button', 'msg-action');
      speakBtn.textContent = 'speak';
      speakBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        speakBtn.disabled = true;
        speakBtn.textContent = '…';
        try {
          await ttsSpeakFn(msg.text);
        } catch (err) {
          toastFn(err.message, 'error');
        }
        speakBtn.disabled = false;
        speakBtn.textContent = 'speak';
      });
      meta.appendChild(speakBtn);
    }
    const copyBtn = el('button', 'msg-action');
    copyBtn.textContent = 'copy';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(msg.text);
      toastFn('Copied', 'success');
    });
    meta.appendChild(copyBtn);
    div.appendChild(meta);
  }
  return div;
}

export function mkUser(msg) {
  const div = el('div', 'msg-user');
  div.appendChild(el('div', 'tick'));
  const wrap = el('div', 'bubble-wrap');
  const bubble = el('div', 'bubble');
  bubble.textContent = msg.text;
  const ts = el('div', 'bubble-ts');
  ts.textContent = msg.ts;
  bubble.appendChild(ts);
  wrap.appendChild(bubble);
  div.appendChild(wrap);
  return div;
}

export function mkThinking() {
  const div = el('div', 'thinking');
  div.appendChild(el('div', 'node-dot'));
  const sender = el('div', 'sender smallcaps');
  sender.textContent = assistantName;
  sender.style.color = 'var(--accent-ink)';
  sender.style.fontSize = '10px';
  sender.style.marginBottom = '6px';
  div.appendChild(sender);
  const dots = el('div');
  dots.style.cssText = 'display:flex;gap:5px;align-items:center;height:28px';
  for (let i = 0; i < 3; i++) {
    const d = el('span', 'forge-dot');
    d.style.animationDelay = i * 160 + 'ms';
    dots.appendChild(d);
  }
  div.appendChild(dots);
  return div;
}

export function selectMessage(idx) {
  selectedMsgId = idx;
  document.querySelectorAll('.msg-assistant').forEach(e =>
    e.classList.toggle('selected', parseInt(e.dataset.idx) === idx));
  renderInspector();
}

function renderPromptSection(ctx) {
  if (!ctx) {
    return `<section>
      <button class="trace-toggle" data-open="false">
        <span class="arrow">›</span>
        <span class="smallcaps" style="font-size:10px">Prompt</span>
        <span class="count">—</span>
      </button>
      <div class="trace-body" style="display:none">
        <div style="font-size:11px;color:var(--ink-faint);font-style:italic">
          No prompt data saved for this message.
        </div>
      </div>
    </section>`;
  }

  const msgCount = ctx.messages?.length || 0;
  let messagesHtml = '';
  if (ctx.messages && ctx.messages.length > 0) {
    messagesHtml = ctx.messages.map(m =>
      `<div class="prompt-msg">
        <div class="smallcaps prompt-role ${m.role}">${esc(m.role)}</div>
        <div class="prompt-content">${esc(m.content)}</div>
      </div>`
    ).join('');
  }

  return `<section>
      <button class="trace-toggle" data-open="false">
        <span class="arrow">›</span>
        <span class="smallcaps" style="font-size:10px">System prompt</span>
      </button>
      <div class="trace-body" style="display:none">
        <div class="prompt-content">${esc(ctx.system || '')}</div>
      </div>
    </section>
    <section>
      <button class="trace-toggle" data-open="false">
        <span class="arrow">›</span>
        <span class="smallcaps" style="font-size:10px">Messages</span>
        <span class="count">${msgCount}</span>
      </button>
      <div class="trace-body" style="display:none">
        ${messagesHtml || '<div style="font-size:11px;color:var(--ink-faint);font-style:italic">No messages in context.</div>'}
      </div>
    </section>`;
}

export function renderInspector() {
  const c = document.getElementById('inspector-panel');
  if (!c) return;
  const msg = selectedMsgId !== null ? messages[selectedMsgId] : null;

  if (!msg || msg.role !== 'assistant') {
    c.innerHTML = `<div class="inspector-empty">
      <div class="smallcaps" style="margin-bottom:8px">Inspector</div>
      Click any ${esc(assistantName)} reply to see the metadata that produced it.</div>`;
    return;
  }

  const meta = msg.meta || { model: '—', input: 0, output: 0 };
  c.innerHTML = `<div class="inspector">
    <div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span style="width:7px;height:7px;border-radius:50%;background:var(--accent)"></span>
        <div class="smallcaps">Inspector</div>
      </div>
      <div style="font-size:11.5px;color:var(--ink-mute);line-height:1.45">Metadata for this reply.</div>
    </div>
    <section>
      <button class="trace-toggle" data-open="true">
        <span class="arrow open">›</span>
        <span class="smallcaps" style="font-size:10px">Usage</span>
      </button>
      <div class="trace-body">
        <div class="usage-grid">
          <span style="color:var(--ink-mute)">model</span>
          <span class="mono" style="color:var(--ink)">${esc(meta.model)}</span>
          <span style="color:var(--ink-mute)">input</span>
          <span class="mono" style="color:var(--ink)">${meta.input.toLocaleString()} tok</span>
          <span style="color:var(--ink-mute)">output</span>
          <span class="mono" style="color:var(--ink)">${meta.output.toLocaleString()} tok</span>
        </div>
      </div>
    </section>
    ${renderPromptSection(msg.promptContext)}
  </div>`;

  c.querySelectorAll('.trace-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.nextElementSibling;
      const arrow = btn.querySelector('.arrow');
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      arrow.classList.toggle('open', !open);
    });
  });
}

export function renderThreadMeta() {
  const c = document.getElementById('threadmeta-panel');
  if (!c) return;
  // True context usage: the sliding-window prompt stats from the most recent
  // reply. The window is rebuilt every turn, so this never needs a "reset" —
  // older turns simply fall out (shown below when they do).
  const latest = [...messages].reverse().find(m => m.role === 'assistant' && m.meta?.context);
  const ctx = latest?.meta.context || null;
  const used = ctx ? ctx.estimatedPromptTokens : 0;
  const budget = ctx ? ctx.promptBudgetTokens : 0;
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
  const valueLabel = ctx
    ? `${(used / 1000).toFixed(1)}k / ${(budget / 1000).toFixed(1)}k tok`
    : '— / — tok';
  const omitted = ctx?.omittedHistoryMessages || 0;
  const omittedNote = omitted > 0
    ? `<div style="font-size:10.5px;color:var(--ink-faint)">${omitted} older message${omitted === 1 ? '' : 's'} out of context</div>`
    : '';
  const initial = assistantName.trim().slice(0, 1).toUpperCase() || 'F';

  c.innerHTML = `<div class="thread-meta">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="rail-stat">
        <div class="smallcaps stat-label" style="font-size:9.5px">context window</div>
        <div class="stat-value">${valueLabel}</div>
      </div>
      <div class="context-meter"><div class="fill" style="width:${pct}%"></div></div>
      ${omittedNote}
    </div>
    <div style="border-top:1px solid var(--rule);padding-top:14px">
      <div class="smallcaps" style="margin-bottom:8px">Agent</div>
      <div class="agent-row">
        <span class="initial" style="background:var(--accent-wash-strong);color:var(--accent-ink)">${esc(initial)}</span>
        <span class="name">${esc(assistantName)}</span>
        <div style="flex:1;min-width:8px"></div>
        <span class="time">now</span>
      </div>
    </div>
    <div style="border-top:1px solid var(--rule);padding-top:14px">
      <div class="smallcaps" style="margin-bottom:8px">Identity</div>
      <div id="identity-files" style="display:flex;flex-direction:column;gap:6px"></div>
      <div id="identity-proposals"></div>
    </div>
  </div>`;

  loadIdentityFiles();
}

async function loadIdentityFiles() {
  const container = document.getElementById('identity-files');
  if (!container || !apiCall) return;
  try {
    const data = await apiCall('/api/identity');
    renderIdentityFiles(container, normalizeIdentityFiles(data.files || []));
    renderIdentityProposals(data.proposals || []);
  } catch {
    container.innerHTML = '<div class="identity-empty">Identity files unavailable.</div>';
    renderIdentityProposals([]);
  }
}

function renderIdentityFiles(container, files) {
  container.innerHTML = '';
  for (const file of files) {
    const row = document.createElement('div');
    row.className = `identity-file${file.name === 'NOTES.md' ? ' low-trust' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'identity-file-meta';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const trust = document.createElement('span');
    trust.className = 'file-trust';
    trust.textContent = formatIdentityTrust(file);
    meta.append(name, trust);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openEditor(file));

    row.append(meta, editBtn);
    container.appendChild(row);
  }
}

function openEditor(file) {
  const panel = document.getElementById('threadmeta-panel');
  const existing = panel.querySelector('.identity-editor');
  if (existing) existing.remove();

  const editor = document.createElement('div');
  editor.className = 'identity-editor';
  const ta = document.createElement('textarea');
  ta.value = file.content;
  const btnRow = document.createElement('div');
  btnRow.className = 'btn-row';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary'; saveBtn.textContent = 'Save';
  btnRow.append(cancelBtn, saveBtn);
  editor.append(ta, btnRow);

  const filesContainer = document.getElementById('identity-files');
  filesContainer.parentNode.appendChild(editor);

  cancelBtn.addEventListener('click', () => editor.remove());
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await apiCall(`/api/identity/${file.name}`, {
        method: 'PUT', body: JSON.stringify({ content: ta.value }),
      });
      toastFn(`${file.name} saved`, 'success');
      editor.remove();
      await loadIdentityFiles();
    } catch {
      toastFn(`Could not save ${file.name}`, 'error');
      saveBtn.disabled = false;
    }
  });
}

function renderIdentityProposals(proposals) {
  const container = document.getElementById('identity-proposals');
  if (!container) return;
  const pending = proposals.filter(p => (p.status || 'pending') === 'pending');
  container.innerHTML = '';

  const section = document.createElement('div');
  section.className = 'identity-proposals';

  const header = document.createElement('div');
  header.className = 'identity-proposals-header';
  const title = document.createElement('div');
  title.className = 'smallcaps';
  title.textContent = 'Pending identity changes';
  const badge = document.createElement('span');
  badge.className = 'identity-count';
  badge.textContent = String(pending.length);
  header.append(title, badge);
  section.appendChild(header);

  if (pending.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'identity-empty';
    empty.textContent = 'No pending changes.';
    section.appendChild(empty);
  } else {
    pending.forEach(proposal => section.appendChild(renderProposalCard(proposal)));
  }

  container.appendChild(section);
}

function renderProposalCard(proposal) {
  const card = document.createElement('div');
  card.className = 'identity-proposal';

  const top = document.createElement('div');
  top.className = 'identity-proposal-top';
  const target = document.createElement('span');
  target.className = 'identity-proposal-target mono';
  target.textContent = getProposalTarget(proposal);
  top.appendChild(target);

  const created = getProposalCreated(proposal);
  if (created) {
    const time = document.createElement('span');
    time.className = 'identity-proposal-time';
    time.textContent = created;
    top.appendChild(time);
  }

  const content = document.createElement('pre');
  content.className = 'identity-proposal-content';
  content.textContent = getProposalContent(proposal);

  const reasonText = getProposalReason(proposal);
  const reason = document.createElement('div');
  reason.className = 'identity-proposal-reason';
  reason.textContent = reasonText || 'No reason provided.';

  const actions = document.createElement('div');
  actions.className = 'identity-proposal-actions';
  const approveBtn = proposalButton('Approve');
  const editApproveBtn = proposalButton('Edit & Approve');
  const rejectBtn = proposalButton('Reject', 'danger');
  actions.append(approveBtn, editApproveBtn, rejectBtn);

  approveBtn.addEventListener('click', () => actOnProposal(proposal, 'approve', approveBtn));
  editApproveBtn.addEventListener('click', () => openProposalEditor(card, proposal));
  rejectBtn.addEventListener('click', () => {
    if (window.confirm(`Reject identity change for ${getProposalTarget(proposal)}?`)) {
      actOnProposal(proposal, 'reject', rejectBtn);
    }
  });

  card.append(top, content, reason, actions);
  return card;
}

function proposalButton(label, tone = '') {
  const btn = document.createElement('button');
  btn.className = `identity-proposal-btn${tone ? ` ${tone}` : ''}`;
  btn.textContent = label;
  return btn;
}

function openProposalEditor(card, proposal) {
  const existing = card.querySelector('.identity-proposal-editor');
  if (existing) {
    existing.querySelector('textarea')?.focus();
    return;
  }

  const editor = document.createElement('div');
  editor.className = 'identity-proposal-editor';
  const ta = document.createElement('textarea');
  ta.value = getProposalContent(proposal);

  const row = document.createElement('div');
  row.className = 'btn-row';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'identity-proposal-btn';
  cancelBtn.textContent = 'Cancel';
  const approveBtn = document.createElement('button');
  approveBtn.className = 'identity-proposal-btn primary';
  approveBtn.textContent = 'Approve edited';
  row.append(cancelBtn, approveBtn);
  editor.append(ta, row);
  card.appendChild(editor);
  ta.focus();

  cancelBtn.addEventListener('click', () => editor.remove());
  approveBtn.addEventListener('click', () => actOnProposal(proposal, 'approve', approveBtn, ta.value));
}

async function actOnProposal(proposal, action, button, content) {
  if (!proposal?.id) {
    toastFn('Proposal is missing an id', 'error');
    return;
  }

  const buttons = button.closest('.identity-proposal')?.querySelectorAll('button') || [button];
  buttons.forEach(btn => { btn.disabled = true; });
  try {
    const body = content === undefined ? undefined : JSON.stringify({ content });
    await apiCall(`/api/identity/proposals/${proposal.id}/${action}`, {
      method: 'POST',
      ...(body ? { body } : {}),
    });
    toastFn(action === 'approve' ? 'Identity change approved' : 'Identity change rejected', 'success');
    await loadIdentityFiles();
  } catch {
    toastFn(`Could not ${action} identity change`, 'error');
    buttons.forEach(btn => { btn.disabled = false; });
  }
}
