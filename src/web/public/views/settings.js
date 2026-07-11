let apiCall, toastFn;
let currentSection = 'instance';
let settingsData = null;
let ready = false;

export async function initSettings(api, toast) {
  apiCall = api; toastFn = toast;
  const container = document.getElementById('tab-settings');
  if (!ready) { buildLayout(container); ready = true; }
  await loadData();
  renderSection();
}

function buildLayout(container) {
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'settings-page';

  const sidebar = document.createElement('aside');
  sidebar.className = 'settings-sidebar';
  const title = document.createElement('div');
  title.className = 'smallcaps title';
  title.textContent = 'Settings';
  sidebar.appendChild(title);

  const nav = document.createElement('nav');
  const sections = [
    { id: 'instance', label: 'Instance', hint: 'Name, version' },
    { id: 'models', label: 'Ollama', hint: 'Model, health' },
    { id: 'databases', label: 'Databases', hint: 'Health, storage' },
    { id: 'memory', label: 'Memory', hint: 'Retention, indexing' },
    { id: 'identity', label: 'Identity', hint: 'Reflection' },
    { id: 'features', label: 'Features', hint: 'Toggles' },
  ];

  sections.forEach(s => {
    const btn = document.createElement('button');
    btn.className = `nav-btn${s.id === currentSection ? ' active' : ''}`;
    btn.innerHTML = `<span class="name">${s.label}</span><span class="hint">${s.hint}</span>`;
    btn.addEventListener('click', () => {
      currentSection = s.id;
      nav.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSection();
    });
    nav.appendChild(btn);
  });
  sidebar.appendChild(nav);

  const detail = document.createElement('div');
  detail.className = 'settings-detail';
  const inner = document.createElement('div');
  inner.className = 'settings-detail-inner';
  inner.id = 'settings-content';
  detail.appendChild(inner);

  page.append(sidebar, detail);
  container.appendChild(page);
}

async function loadData() {
  try {
    settingsData = await apiCall('/api/settings');
  } catch (err) {
    const c = document.getElementById('settings-content');
    if (c) c.innerHTML = `<div style="color:var(--err);padding:32px">Failed to load: ${err.message}</div>`;
  }
}

function renderSection() {
  const c = document.getElementById('settings-content');
  if (!c || !settingsData) return;
  const renderers = { instance: rInstance, models: rModels, databases: rDatabases, memory: rMemory, identity: rIdentity, features: rFeatures };
  (renderers[currentSection] || rInstance)(c);
}

function hdr(title, lede) {
  return `<div class="section-header"><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</div>`;
}
function fld(label, hint, content) {
  return `<div class="field"><div><div class="smallcaps field-label">${label}</div>${hint ? `<div class="field-hint">${hint}</div>` : ''}</div><div>${content}</div></div>`;
}
function val(v) { return `<div class="field-value">${v}</div>`; }
function badge(state, text) { return `<span class="status-badge ${state}"><span class="dot"></span>${text}</span>`; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function rInstance(c) {
  const i = settingsData.info;
  c.innerHTML = hdr('Instance', 'The local companion identity and running version.')
    + fld('Name', 'How this companion identifies itself locally.', `<input class="field-input" value="${esc(i.name)}" readonly>`)
    + fld('Version', 'Running release.', val(esc(i.version)))
    + '<div style="border-top:1px solid var(--rule);padding-top:18px"></div>';
}

function rModels(c) {
  const llm = settingsData.info.llm || {};
  const badgeState = llm.status === 'online' ? 'ok' : (llm.status === 'offline' ? 'warn' : 'err');
  const models = Array.isArray(llm.installedModels) ? llm.installedModels : [];
  c.innerHTML = hdr('Ollama', 'Local model selection and backend health.')
    + fld('Provider', 'This branch supports only Ollama.', val('ollama'))
    + fld('Selected model', 'Configured in forge.config.yaml as llm.model.', val(esc(settingsData.info.localModel || llm.model || 'unknown')))
    + fld('Ollama base URL', 'Read-only in phase one. Edit forge.config.yaml to change.', val(esc(llm.baseUrl || 'n/a')))
    + fld('Health', 'Connectivity and selected-model availability.', `${badge(badgeState, esc(llm.status || 'unknown'))}${llm.message ? `<div class="field-hint" style="margin-top:8px;max-width:520px">${esc(llm.message)}</div>` : ''}`)
    + fld('Installed models', 'Reported by Ollama /api/tags.', models.length
      ? `<div class="field-value">${models.map(m => `<div>${esc(m)}</div>`).join('')}</div>`
      : val('No models reported'));
}

function rDatabases(c) {
  const dbs = settingsData.info.databases || [];
  c.innerHTML = hdr('Databases', 'Local SQLite stores for memory and message history.')
    + dbs.map(db => `<div class="db-row">
        <div>
          <div class="mono" style="font-size:13px;color:var(--ink)">${esc(db.name)}</div>
          <div style="font-size:11.5px;color:var(--ink-mute);margin-top:2px">${db.ok ? 'healthy' : esc(db.error || 'error')}</div>
        </div>
        <div></div><div></div>
        ${badge(db.ok ? 'ok' : 'err', db.ok ? 'healthy' : 'error')}
      </div>`).join('');
}

function rMemory(c) {
  const memory = settingsData.info.memory || {};
  const retentionDays = memory.retentionDays ?? 30;
  const contextWindowTokens = memory.contextWindowTokens ?? 80000;
  const embeddings = memory.embeddings || {};
  const embeddingConfig = embeddings.configuration || {};
  const embeddingHealth = embeddings.health || {};
  const embeddingIndex = embeddings.index || {};
  const reindex = embeddings.reindex || {};
  const configured = embeddingConfig.enabled === true && Boolean(embeddingConfig.model);
  const healthStatus = embeddingHealth.status || (configured ? 'unknown' : 'disabled');
  const healthBadge = embeddingHealth.ok === true ? 'ok' : (healthStatus === 'disabled' || healthStatus === 'offline' ? 'warn' : 'err');
  const reindexStatus = reindex.status || 'idle';
  const reindexBadge = reindexStatus === 'completed' ? 'ok' : (reindexStatus === 'running' || reindexStatus === 'idle' ? 'warn' : 'err');
  const current = embeddingIndex.indexed ?? 0;
  const active = embeddingIndex.active ?? 0;
  const pending = embeddingIndex.pending ?? 0;
  const stale = embeddingIndex.stale ?? 0;
  const failed = embeddingIndex.failed ?? 0;
  const fallback = embeddingHealth.ok === true
    ? 'Hybrid recall is available. FTS5 remains the local fallback.'
    : 'FTS5-only fallback is active until embeddings are available.';
  const controlLabel = reindexStatus === 'failed' ? 'Retry' : (reindexStatus === 'running' ? 'Reindexing' : 'Reindex');

  c.innerHTML = hdr('Memory', 'Local FTS5 recall for explicit memories and chat context.')
    + fld('Retention', 'How long raw turns stay before future summarization work.', val(`${retentionDays} days`))
    + fld('Context window', 'Target context size for chat prompts.', val(`${Math.round(contextWindowTokens / 1000)}k tokens`))
    + fld('Indexing', 'FTS5 updates immediately when memories change.', val('immediate'))
    + fld('Embedding model', 'Read-only; configured separately from the chat model.', val(esc(embeddingConfig.model || 'Not configured')))
    + fld('Embedding endpoint', 'Local Ollama endpoint for memory vectors.', val(esc(embeddingConfig.baseUrl || embeddingHealth.baseUrl || 'n/a')))
    + fld('Embedding health', 'Embedding availability is independent from chat-model health.', `${badge(healthBadge, esc(healthStatus))}${embeddingHealth.message ? `<div class="field-hint" style="margin-top:8px;max-width:520px">${esc(embeddingHealth.message)}</div>` : ''}`)
    + fld('Recall fallback', 'Saved memories remain searchable when embedding work is unavailable.', val(fallback))
    + fld('Embedding index', 'Current-model vectors for active memories.', val(`${current} indexed / ${active} active; ${pending} pending, ${stale} stale, ${failed} failed`))
    + fld('Backfill', 'Creates or refreshes local vectors without changing configuration.', `${badge(reindexBadge, esc(reindexStatus))}${reindex.message ? `<div class="field-hint" style="margin-top:8px;max-width:520px">${esc(reindex.message)}</div>` : ''}<div style="margin-top:10px"><button id="memory-embeddings-reindex" class="btn" type="button" ${configured && reindexStatus !== 'running' ? '' : 'disabled'}>${controlLabel}</button><div id="memory-embeddings-error" class="field-error" hidden></div></div>`);

  const reindexButton = document.getElementById('memory-embeddings-reindex');
  reindexButton?.addEventListener('click', async () => {
    reindexButton.disabled = true;
    const error = document.getElementById('memory-embeddings-error');
    if (error) error.hidden = true;

    try {
      const result = await apiCall('/api/settings/memory/embeddings/reindex', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadData();
      renderSection();

      if (result?.error) throw new Error(result.error);
      if (result?.reindex?.status === 'failed') {
        throw new Error(result.reindex.message || 'Embedding reindex did not complete');
      }
      toastFn(result?.alreadyRunning ? 'Memory embedding reindex is already running' : 'Memory embedding reindex completed', 'success');
    } catch (err) {
      const updatedError = document.getElementById('memory-embeddings-error');
      if (updatedError) {
        updatedError.textContent = err?.message || 'Could not reindex memory embeddings';
        updatedError.hidden = false;
      }
      toastFn('Could not reindex memory embeddings', 'error');
    } finally {
      const updatedButton = document.getElementById('memory-embeddings-reindex');
      if (updatedButton && updatedButton.textContent !== 'Reindexing') updatedButton.disabled = false;
    }
  });
}

function rIdentity(c) {
  const reflection = settingsData.info.identity?.reflection || {};
  const enabled = reflection.enabled === true;
  const cadenceTurns = reflection.cadenceTurns ?? 1;
  const recentNotes = reflection.recentNotesInContext ?? 5;

  c.innerHTML = hdr('Identity', 'Local identity controls.')
    + fld('Reflection', 'Persists the enabled flag only.', `
      <label class="settings-switch">
        <input id="identity-reflection-enabled" type="checkbox" ${enabled ? 'checked' : ''}>
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-text">${enabled ? 'Enabled' : 'Disabled'}</span>
      </label>
      <div id="identity-reflection-error" class="field-error" hidden></div>
    `)
    + fld('Cadence', 'Read-only.', val(`${cadenceTurns} turn${cadenceTurns === 1 ? '' : 's'}`))
    + fld('Recent notes', 'Read-only.', val(`${recentNotes}`));

  const toggle = document.getElementById('identity-reflection-enabled');
  const text = c.querySelector('.settings-switch .switch-text');
  const error = document.getElementById('identity-reflection-error');
  toggle?.addEventListener('change', async () => {
    const next = toggle.checked;
    const previous = !next;
    setReflectionToggleText(text, next);
    toggle.disabled = true;
    if (error) error.hidden = true;

    try {
      const result = await apiCall('/api/settings/identity/reflection', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: next }),
      });
      if (result?.error) throw new Error(result.error);
      settingsData.info.identity = result.identity;
      setReflectionToggleText(text, result.identity?.reflection?.enabled === true);
      toastFn(`Identity reflection ${next ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      toggle.checked = previous;
      setReflectionToggleText(text, previous);
      if (error) {
        error.textContent = err?.message || 'Could not save identity reflection';
        error.hidden = false;
      }
      toastFn('Could not save identity reflection', 'error');
    } finally {
      toggle.disabled = false;
    }
  });
}

function setReflectionToggleText(el, enabled) {
  if (el) el.textContent = enabled ? 'Enabled' : 'Disabled';
}

function rFeatures(c) {
  c.innerHTML = hdr('Features', 'Switch major subsystems on or off. Saved to the active config file.')
    + '<div id="features-list"><div class="field-hint">Loading…</div></div>';
  loadFeatureToggles();
}

async function loadFeatureToggles() {
  const list = document.getElementById('features-list');
  if (!list) return;

  try {
    const result = await apiCall('/api/settings/toggles');
    if (result?.error) throw new Error(result.error);
    renderFeatureToggles(list, Array.isArray(result?.toggles) ? result.toggles : []);
  } catch (err) {
    list.innerHTML = `<div class="field-error">Failed to load feature toggles: ${esc(err?.message || 'unknown error')}</div>`;
  }
}

function restartTag() {
  return '<span style="display:inline-block;margin-left:8px;padding:1px 7px;border-radius:99px;font-size:10px;letter-spacing:0.04em;text-transform:uppercase;background:color-mix(in srgb, var(--warn) 16%, transparent);color:var(--warn)">restart required</span>';
}

function renderFeatureToggles(list, toggles) {
  list.innerHTML = toggles.map((t, index) => fld(
    `${esc(t.label)}${t.restartRequired ? restartTag() : ''}`,
    esc(t.hint || ''),
    `<label class="settings-switch">
      <input id="feature-toggle-${index}" data-path="${esc(t.path)}" type="checkbox" ${t.enabled ? 'checked' : ''}>
      <span class="track"><span class="thumb"></span></span>
      <span class="switch-text">${t.enabled ? 'Enabled' : 'Disabled'}</span>
    </label>`,
  )).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', async () => {
      const next = input.checked;
      const text = input.closest('.settings-switch')?.querySelector('.switch-text');
      if (text) text.textContent = next ? 'Enabled' : 'Disabled';
      input.disabled = true;

      try {
        const result = await apiCall('/api/settings/toggles', {
          method: 'PATCH',
          body: JSON.stringify({ path: input.dataset.path, enabled: next }),
        });
        if (result?.error) throw new Error(result.error);
        toastFn(result?.restartRequired ? 'Saved — restart Forge to apply' : 'Saved', 'success');
        input.disabled = false;
      } catch (err) {
        toastFn(err?.message || 'Could not save feature toggle', 'error');
        // Re-fetch and re-render so the switch reflects the persisted state.
        loadFeatureToggles();
      }
    });
  });
}
