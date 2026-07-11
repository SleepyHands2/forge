import { initChat } from './chat.js';
import { initSettings } from './settings.js';
import { initMemory } from './memory.js';
import { initDocs } from './docs.js';
import { initActivity } from './activity.js';

const API = '';
let authToken = '';

export async function api(path, opts = {}) {
  const res = await apiRaw(path, opts);
  return res.json();
}

// Like api(), but returns the raw Response so callers can consume streamed
// bodies (e.g. token-by-token chat replies over SSE).
export async function apiRaw(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`${API}${path}`, { credentials: 'same-origin', ...opts, headers });
  if (res.status === 401) {
    showLogin();
    throw new Error('Unauthorized');
  }
  return res;
}

export function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function updateStatus(connected) {
  const pill = document.getElementById('status-pill');
  pill.innerHTML = connected
    ? '<span class="dot ok"></span><span class="label">connected</span>'
    : '<span class="dot err"></span><span class="label">disconnected</span>';
}

function showLogin() {
  document.getElementById('login-gate').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  document.getElementById('login-gate').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

async function doLogin() {
  const input = document.getElementById('login-token');
  const errEl = document.getElementById('login-error');
  const token = input.value.trim();
  if (!token) return;

  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      errEl.textContent = 'Invalid token';
      errEl.style.display = 'block';
      return;
    }
    authToken = token;
    errEl.style.display = 'none';
    init();
  } catch {
    errEl.textContent = 'Connection failed';
    errEl.style.display = 'block';
  }
}

async function loadPublicInfo() {
  try {
    const res = await fetch(`${API}/api/public/info`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const info = await res.json();
    document.querySelectorAll('.wordmark-name').forEach(el => { el.textContent = info.name || 'forge'; });
    document.querySelectorAll('.wordmark-tag').forEach(el => {
      el.textContent = info.version ? `memory · v${info.version}` : 'memory';
    });
  } catch {
    /* public info is cosmetic */
  }
}

let activeTab = localStorage.getItem('forge_tab') || 'chat';

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  activeTab = tab;
  localStorage.setItem('forge_tab', tab);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
  if (tab === 'settings') initSettings(api, toast);
  if (tab === 'memory') initMemory(api, toast);
  if (tab === 'docs') initDocs(api, toast);
  if (tab === 'activity') initActivity(api, toast);
}

async function init() {
  showApp();
  switchTab(activeTab);
  try {
    await initChat(api, toast, apiRaw);
    updateStatus(true);
  } catch {
    showLogin();
  }
}

loadPublicInfo();
init();
