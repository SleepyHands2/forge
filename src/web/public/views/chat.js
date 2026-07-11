import { renderAllMessages, renderInspector, renderThreadMeta, mkUser, mkAssistant, mkThinking, selectMessage, setMessages, getMessages, getThinking, setThinking, scrollToBottom, setMsgContainer, setToastFn as setRenderToast, setApiCall, setAssistantName, setThreadMetaConfig, setTtsSpeak, textToHtml } from './chat-render.js';
import { startRecording } from './voice.js';

let apiCall, apiRawCall, toastFn;
let container, composerTextarea, attachmentListEl, fileInputEl, micBtnEl;
let chatReady = false;
let activeRecorder = null;

const ATTACHMENT_LIMITS = {
  maxFiles: 3,
  maxTextBytes: 128 * 1024,
  maxTextChars: 20000,
  maxImageBytes: 2 * 1024 * 1024,
  maxImageTotalBytes: 4 * 1024 * 1024,
};
const TEXT_ATTACHMENT_MIME_TYPES = {
  txt: new Set(['text/plain', 'text/*', 'application/octet-stream']),
  md: new Set(['text/markdown', 'text/x-markdown', 'text/plain', 'text/*', 'application/octet-stream']),
  json: new Set(['application/json', 'text/json', 'text/plain', 'text/*', 'application/octet-stream']),
  csv: new Set(['text/csv', 'application/csv', 'text/plain', 'text/*', 'application/octet-stream']),
};
const IMAGE_ATTACHMENT_MIME_TYPES = {
  jpg: new Set(['image/jpeg']),
  jpeg: new Set(['image/jpeg']),
  png: new Set(['image/png']),
  gif: new Set(['image/gif']),
  tif: new Set(['image/tiff']),
  tiff: new Set(['image/tiff']),
};
const TEXT_FILE_ONLY_PROMPT = 'Please analyze the attached document(s).';
const IMAGE_FILE_ONLY_PROMPT = 'Please analyze the attached image(s).';
const MIXED_FILE_ONLY_PROMPT = 'Please analyze the attached file(s).';

let selectedAttachments = [];

const RAIL_MIN = 180, RAIL_MAX = 360, RAIL_DEFAULT = 240;
const clamp = (lo, hi, v) => Math.min(hi, Math.max(lo, v));

let rails = loadRails();
function loadRails() {
  try {
    const v = JSON.parse(localStorage.getItem('forge_rails') || '{}');
    return {
      leftW: clamp(RAIL_MIN, RAIL_MAX, v.leftW || RAIL_DEFAULT),
      rightW: clamp(RAIL_MIN, RAIL_MAX, v.rightW || RAIL_DEFAULT),
      leftOpen: v.leftOpen ?? true, rightOpen: v.rightOpen ?? true,
    };
  } catch { return { leftW: RAIL_DEFAULT, rightW: RAIL_DEFAULT, leftOpen: true, rightOpen: true }; }
}
function saveRails() { localStorage.setItem('forge_rails', JSON.stringify(rails)); }

export async function initChat(api, toast, apiRaw) {
  apiCall = api; apiRawCall = apiRaw || null; toastFn = toast;
  setRenderToast(toast);
  setApiCall(api);
  container = document.getElementById('tab-chat');
  if (!chatReady) { buildLayout(); chatReady = true; }
  await loadMessages();
  await applyVoiceStatus();
}

async function applyVoiceStatus() {
  try {
    const status = await apiCall('/api/voice/status');
    if (micBtnEl) micBtnEl.style.display = status.stt?.enabled ? '' : 'none';
    setTtsSpeak(status.tts?.enabled ? speakText : null);
  } catch {
    if (micBtnEl) micBtnEl.style.display = 'none';
    setTtsSpeak(null);
  }
}

async function speakText(text) {
  if (!apiRawCall) throw new Error('Voice playback unavailable.');
  const res = await apiRawCall('/api/voice/speak', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('audio/')) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `TTS failed (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  audio.addEventListener('error', () => URL.revokeObjectURL(url));
  await audio.play();
}

async function toggleRecording() {
  if (activeRecorder) {
    const recorder = activeRecorder;
    activeRecorder = null;
    micBtnEl.classList.remove('recording');
    micBtnEl.disabled = true;
    try {
      const { base64, seconds } = await recorder.stop();
      if (seconds < 0.4) {
        toastFn('Recording too short.', 'error');
        return;
      }
      const data = await apiCall('/api/voice/transcribe', {
        method: 'POST',
        body: JSON.stringify({ data: base64 }),
      });
      if (data.error) throw new Error(data.error);
      composerTextarea.value = composerTextarea.value
        ? `${composerTextarea.value.trimEnd()} ${data.text}`
        : data.text;
      composerTextarea.dispatchEvent(new Event('input'));
      composerTextarea.focus();
    } catch (err) {
      toastFn(`Transcription failed: ${err.message}`, 'error');
    } finally {
      micBtnEl.disabled = false;
    }
    return;
  }

  try {
    activeRecorder = await startRecording();
    micBtnEl.classList.add('recording');
    toastFn('Recording… click the mic again to stop.', 'success');
  } catch (err) {
    activeRecorder = null;
    toastFn(`Microphone unavailable: ${err.message}`, 'error');
  }
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function buildLayout() {
  const page = el('div', 'chat-page');
  const scroll = el('div', 'chat-scroll');
  const cols = el('div', 'chat-columns');

  const leftRail = el('div', 'rail'); leftRail.id = 'rail-left';
  const leftInner = el('div', 'rail-inner'); leftInner.id = 'inspector-panel';
  leftRail.appendChild(leftInner);

  const rightRail = el('div', 'rail'); rightRail.id = 'rail-right';
  const rightInner = el('div', 'rail-inner'); rightInner.id = 'threadmeta-panel';
  rightRail.appendChild(rightInner);

  const center = el('div', 'paper-sheet chat-center');
  center.appendChild(el('div', 'thread-spine'));
  const mc = el('div'); mc.id = 'msg-container';
  setMsgContainer(mc);
  center.appendChild(mc);

  cols.append(leftRail, buildDivider('left'), center, buildDivider('right'), rightRail);
  scroll.appendChild(cols);
  page.appendChild(scroll);
  page.appendChild(buildComposer());
  container.appendChild(page);

  applyRailWidths();
  renderInspector();
  renderThreadMeta();
}

function buildDivider(side) {
  const div = el('div', 'rail-divider');
  const line = el('div', 'line');
  const grip = el('div', 'grip');
  div.append(line, grip);
  let moved = 0, lastX = 0;

  div.addEventListener('mousemove', (e) => {
    grip.style.top = (e.clientY - div.getBoundingClientRect().top) + 'px';
  });

  div.addEventListener('mousedown', (e) => {
    e.preventDefault(); lastX = e.clientX; moved = 0;
    div.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      const dx = ev.clientX - lastX; lastX = ev.clientX; moved += Math.abs(dx);
      const key = side === 'left' ? 'leftW' : 'rightW';
      rails[key] = clamp(RAIL_MIN, RAIL_MAX, rails[key] + (side === 'left' ? dx : -dx));
      rails[`${side}Open`] = true;
      applyRailWidths(); saveRails();
      grip.style.top = (ev.clientY - div.getBoundingClientRect().top) + 'px';
    };
    const onUp = () => {
      div.classList.remove('dragging');
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (moved < 4) { rails[`${side}Open`] = !rails[`${side}Open`]; applyRailWidths(); saveRails(); }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  div._side = side; div._grip = grip;
  return div;
}

function applyRailWidths() {
  for (const side of ['left', 'right']) {
    const rail = document.getElementById(`rail-${side}`);
    if (!rail) continue;
    const open = rails[`${side}Open`], w = rails[`${side}W`];
    rail.style.width = open ? w + 'px' : '0';
    rail.querySelector('.rail-inner').style.width = w + 'px';
  }
  document.querySelectorAll('.rail-divider').forEach(d => {
    const open = rails[`${d._side}Open`];
    d._grip.innerHTML = open ? '' : `<span class="grip-chevron">${d._side === 'left' ? '›' : '‹'}</span>`;
  });
}

function parseMeta(raw) {
  if (!raw) return null;
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      model: m.model, input: m.inputTokens || 0, output: m.outputTokens || 0,
      sources: Array.isArray(m.sources) && m.sources.length ? m.sources : null,
      context: m.context || null,
    };
  } catch { return null; }
}

function parsePromptContext(raw) {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'string' ? parseInt(ts) : ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function getFileExtension(file) {
  return file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
}

function getNormalizedMime(file, fallback = '') {
  return (file.type || fallback).split(';', 1)[0].trim().toLowerCase();
}

function isSupportedTextFile(file) {
  const ext = getFileExtension(file);
  const allowedMimes = TEXT_ATTACHMENT_MIME_TYPES[ext];
  const type = getNormalizedMime(file, 'text/plain');
  return Boolean(allowedMimes && allowedMimes.has(type));
}

function isSupportedImageFile(file) {
  const ext = getFileExtension(file);
  const allowedMimes = IMAGE_ATTACHMENT_MIME_TYPES[ext];
  const type = getNormalizedMime(file);
  return Boolean(allowedMimes && allowedMimes.has(type));
}

function getAttachmentKind(attachment) {
  return attachment.kind === 'image' ? 'image' : 'text';
}

function imageByteCount(extra = []) {
  return [...selectedAttachments, ...extra].reduce((sum, item) => (
    getAttachmentKind(item) === 'image' ? sum + item.size : sum
  ), 0);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    });
    reader.addEventListener('error', () => reject(reader.error || new Error('File read failed.')));
    reader.readAsDataURL(file);
  });
}

function getFileOnlyPrompt(attachments) {
  const hasImages = attachments.some(item => getAttachmentKind(item) === 'image');
  const hasText = attachments.some(item => getAttachmentKind(item) === 'text');
  if (hasImages && hasText) return MIXED_FILE_ONLY_PROMPT;
  if (hasImages) return IMAGE_FILE_ONLY_PROMPT;
  return TEXT_FILE_ONLY_PROMPT;
}

function getUnsupportedAttachmentMessage(file) {
  const ext = getFileExtension(file);
  if (TEXT_ATTACHMENT_MIME_TYPES[ext]) {
    return `${file.name} has an unsupported MIME type for .${ext}.`;
  }
  if (IMAGE_ATTACHMENT_MIME_TYPES[ext]) {
    return `${file.name} must be a supported image MIME type for .${ext}.`;
  }
  return `${file.name} is not a supported document or image.`;
}

function buildTextAttachment(file, content) {
  return {
    name: file.name,
    type: file.type || 'text/plain',
    size: file.size,
    content,
  };
}

function buildImageAttachment(file, data) {
  return {
    kind: 'image',
    name: file.name,
    type: getNormalizedMime(file),
    size: file.size,
    data,
  };
}

function isTextAttachmentCandidate(file) {
  const ext = getFileExtension(file);
  return Boolean(TEXT_ATTACHMENT_MIME_TYPES[ext]);
}

function isImageAttachmentCandidate(file) {
  const ext = getFileExtension(file);
  return Boolean(IMAGE_ATTACHMENT_MIME_TYPES[ext]);
}

function isSupportedAttachmentFile(file) {
  if (isTextAttachmentCandidate(file)) return isSupportedTextFile(file);
  if (isImageAttachmentCandidate(file)) return isSupportedImageFile(file);
  return false;
}

function textAttachmentCharCount(extra = []) {
  return [...selectedAttachments, ...extra].reduce((sum, item) => (
    getAttachmentKind(item) === 'text' ? sum + item.content.length : sum
  ), 0);
}

function makeAttachmentPayload(item) {
  if (getAttachmentKind(item) === 'image') {
    return {
      kind: 'image',
      name: item.name,
      type: item.type,
      size: item.size,
      data: item.data,
    };
  }
  return {
    name: item.name,
    type: item.type,
    size: item.size,
    content: item.content,
  };
}

function attachmentLabel(attachment) {
  return getAttachmentKind(attachment) === 'image' ? 'image' : 'doc';
}

function renderAttachments() {
  if (!attachmentListEl) return;
  attachmentListEl.innerHTML = '';
  attachmentListEl.hidden = selectedAttachments.length === 0;

  selectedAttachments.forEach((attachment, idx) => {
    const chip = el('div', 'attachment-chip');
    const meta = el('div', 'attachment-meta');
    const name = el('span', 'attachment-name');
    name.textContent = attachment.name;
    const kind = el('span', 'attachment-kind mono');
    kind.textContent = attachmentLabel(attachment);
    const size = el('span', 'attachment-size mono');
    size.textContent = formatBytes(attachment.size);
    meta.append(name, kind, size);

    const remove = el('button', 'attachment-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.textContent = 'x';
    remove.disabled = getThinking();
    remove.addEventListener('click', () => {
      selectedAttachments.splice(idx, 1);
      renderAttachments();
      container.querySelector('.composer')._updateBtn();
    });

    chip.append(meta, remove);
    attachmentListEl.appendChild(chip);
  });
}

function showAttachmentError(message) {
  toastFn(message, 'error');
}

async function handleAttachmentSelection(files) {
  const candidates = Array.from(files || []);
  if (!candidates.length) return;

  const remainingSlots = ATTACHMENT_LIMITS.maxFiles - selectedAttachments.length;
  if (remainingSlots <= 0) {
    showAttachmentError(`Attach up to ${ATTACHMENT_LIMITS.maxFiles} files.`);
    return;
  }

  const accepted = [];
  let skipped = 0;
  for (const file of candidates.slice(0, remainingSlots)) {
    if (!isSupportedAttachmentFile(file)) {
      skipped += 1;
      showAttachmentError(getUnsupportedAttachmentMessage(file));
      continue;
    }

    try {
      if (isImageAttachmentCandidate(file)) {
        if (file.size > ATTACHMENT_LIMITS.maxImageBytes) {
          skipped += 1;
          showAttachmentError(`${file.name} is over the ${formatBytes(ATTACHMENT_LIMITS.maxImageBytes)} image limit.`);
          continue;
        }
        if (imageByteCount([...accepted, { kind: 'image', size: file.size }]) > ATTACHMENT_LIMITS.maxImageTotalBytes) {
          skipped += 1;
          showAttachmentError(`${file.name} would exceed the ${formatBytes(ATTACHMENT_LIMITS.maxImageTotalBytes)} total image limit.`);
          continue;
        }
        const data = await readFileAsBase64(file);
        accepted.push(buildImageAttachment(file, data));
        continue;
      }

      if (file.size > ATTACHMENT_LIMITS.maxTextBytes) {
        skipped += 1;
        showAttachmentError(`${file.name} is over the ${formatBytes(ATTACHMENT_LIMITS.maxTextBytes)} text limit.`);
        continue;
      }
      const content = await file.text();
      if (textAttachmentCharCount([...accepted, { content }]) > ATTACHMENT_LIMITS.maxTextChars) {
        skipped += 1;
        showAttachmentError(`${file.name} would exceed the ${ATTACHMENT_LIMITS.maxTextChars.toLocaleString()} character text attachment limit.`);
        continue;
      }
      accepted.push(buildTextAttachment(file, content));
    } catch {
      skipped += 1;
      showAttachmentError(`Could not read ${file.name}.`);
    }
  }

  if (candidates.length > remainingSlots) {
    skipped += candidates.length - remainingSlots;
    showAttachmentError(`Attach up to ${ATTACHMENT_LIMITS.maxFiles} files.`);
  }

  if (accepted.length) {
    selectedAttachments.push(...accepted);
    renderAttachments();
    container.querySelector('.composer')._updateBtn();
  } else if (!skipped) {
    showAttachmentError('No files were attached.');
  }
}

async function loadMessages() {
  const data = await apiCall('/api/messages/poll?limit=50');
  const assistantName = data.agentName || 'forge';
  setAssistantName(assistantName);
  setThreadMetaConfig(data.ui || {});
  setMessages(data.messages.map(m => ({
    role: m.user === 'assistant' || m.userName === assistantName ? 'assistant' : 'user',
    text: m.text, ts: fmtTs(m.receivedAt), meta: parseMeta(m.llm_metadata),
    promptContext: parsePromptContext(m.prompt_context),
  })));
  renderAllMessages();
  scrollToBottom(container);
}

function buildComposer() {
  const wrapper = el('div', 'composer');
  const inner = el('div', 'composer-inner');
  const box = el('div', 'composer-box');

  composerTextarea = document.createElement('textarea');
  composerTextarea.className = 'composer-input';
  composerTextarea.placeholder = 'Write a message…';
  composerTextarea.rows = 1;

  fileInputEl = document.createElement('input');
  fileInputEl.type = 'file';
  fileInputEl.className = 'composer-file-input';
  fileInputEl.accept = '.txt,.md,.json,.csv,.jpg,.jpeg,.png,.gif,.tif,.tiff,text/plain,text/markdown,text/x-markdown,application/json,text/csv,application/csv,image/jpeg,image/png,image/gif,image/tiff';
  fileInputEl.multiple = true;

  const attachBtn = el('button', 'composer-attach');
  attachBtn.type = 'button';
  attachBtn.setAttribute('aria-label', 'Attach documents or images');
  attachBtn.title = 'Attach documents or images';
  attachBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48"/></svg>';

  micBtnEl = el('button', 'composer-attach composer-mic');
  micBtnEl.type = 'button';
  micBtnEl.setAttribute('aria-label', 'Record a voice message');
  micBtnEl.title = 'Record a voice message';
  micBtnEl.style.display = 'none';
  micBtnEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
  micBtnEl.addEventListener('click', toggleRecording);

  const sendBtn = el('button', 'composer-send idle');
  sendBtn.type = 'button';
  sendBtn.innerHTML = 'Send <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  box.append(attachBtn, micBtnEl, composerTextarea, sendBtn, fileInputEl);
  inner.appendChild(box);

  attachmentListEl = el('div', 'attachment-list');
  attachmentListEl.hidden = true;
  inner.appendChild(attachmentListEl);

  const hints = el('div', 'composer-hints');
  hints.innerHTML = '<span class="mono">⏎ send</span><span class="mono">⇧⏎ newline</span><div style="flex:1"></div><span class="mono" style="color:var(--ink-faint)">/remember · /forget</span>';
  inner.appendChild(hints);
  wrapper.appendChild(inner);

  const updateBtn = () => {
    const canSend = (composerTextarea.value.trim() || selectedAttachments.length > 0) && !getThinking();
    sendBtn.className = `composer-send ${canSend ? 'ready' : 'idle'}`;
    sendBtn.disabled = getThinking();
    attachBtn.disabled = getThinking();
  };
  composerTextarea.addEventListener('input', () => {
    composerTextarea.style.height = 'auto';
    composerTextarea.style.height = Math.min(composerTextarea.scrollHeight, 200) + 'px';
    updateBtn();
  });
  composerTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  attachBtn.addEventListener('click', () => fileInputEl.click());
  fileInputEl.addEventListener('change', async () => {
    await handleAttachmentSelection(fileInputEl.files);
    fileInputEl.value = '';
  });
  sendBtn.addEventListener('click', doSend);
  wrapper._updateBtn = updateBtn;
  renderAttachments();
  return wrapper;
}

async function doSend() {
  const text = composerTextarea.value.trim();
  const attachments = selectedAttachments.map(makeAttachmentPayload);
  if ((!text && !attachments.length) || getThinking()) return;
  const content = text || getFileOnlyPrompt(attachments);
  const msgs = getMessages();
  const mc = document.getElementById('msg-container');

  msgs.push({ role: 'user', text: content, ts: nowTs() });
  mc.appendChild(mkUser(msgs[msgs.length - 1]));
  composerTextarea.value = ''; composerTextarea.style.height = 'auto';
  setThinking(true);
  renderAttachments();
  container.querySelector('.composer')._updateBtn();

  const thinkEl = mkThinking();
  mc.appendChild(thinkEl);
  scrollToBottom(container);

  const idx = msgs.length;
  let streamEl = null;

  const appendToken = (tokenText) => {
    if (!tokenText) return;
    if (!streamEl) {
      thinkEl.remove();
      msgs.push({ role: 'assistant', text: tokenText, ts: nowTs(), meta: null });
      streamEl = mkAssistant(msgs[idx], idx, false);
      mc.appendChild(streamEl);
    } else {
      msgs[idx].text += tokenText;
      streamEl.querySelector('.prose').innerHTML = textToHtml(msgs[idx].text);
    }
    scrollToBottom(container);
  };

  const finalize = (data) => {
    if (attachments.length) {
      selectedAttachments = [];
      renderAttachments();
    }
    if (data.agentName) setAssistantName(data.agentName);
    thinkEl.remove();
    const msg = {
      role: 'assistant', text: data.reply, ts: nowTs(),
      meta: data.model && data.usage ? {
        model: data.model, input: data.usage.input, output: data.usage.output,
        sources: Array.isArray(data.sources) && data.sources.length ? data.sources : null,
        context: data.context || null,
      } : null,
      promptContext: parsePromptContext(data.prompt_context),
    };
    if (msgs.length > idx) msgs[idx] = msg; else msgs.push(msg);
    const finalEl = mkAssistant(msg, idx, false);
    if (streamEl) streamEl.replaceWith(finalEl); else mc.appendChild(finalEl);
    selectMessage(idx);
    renderThreadMeta();
  };

  // The server only persists completed replies, so drop any partial text to
  // keep the visible thread consistent with messages.db.
  const discardPartial = () => {
    if (streamEl) { streamEl.remove(); streamEl = null; }
    if (msgs.length > idx) msgs.splice(idx, 1);
  };

  try {
    const body = attachments.length ? { content, attachments } : { content };

    if (!apiRawCall) {
      const data = await apiCall('/api/messages', {
        method: 'POST', body: JSON.stringify(body),
      });
      if (data.error) throw new Error(data.error);
      finalize(data);
    } else {
      const res = await apiRawCall('/api/messages', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { Accept: 'text/event-stream' },
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        // Errors before the stream starts (validation, context too large)
        // still arrive as plain JSON with an HTTP status code.
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        finalize(data);
      } else {
        const outcome = await consumeEventStream(res, appendToken);
        if (outcome.error) throw new Error(outcome.error);
        if (!outcome.done) throw new Error('Connection lost before the reply completed.');
        finalize(outcome.done);
      }
    }
  } catch (err) {
    thinkEl.remove();
    discardPartial();
    toastFn('Error: ' + err.message, 'error');
  }

  setThinking(false);
  renderAttachments();
  container.querySelector('.composer')._updateBtn();
  scrollToBottom(container);
  composerTextarea.focus();
}

async function consumeEventStream(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = null;
  let error = null;

  const handleEvent = (raw) => {
    const evt = parseSseEvent(raw);
    if (!evt) return;
    if (evt.event === 'token') onToken((evt.data && evt.data.text) || '');
    else if (evt.event === 'done') done = evt.data;
    else if (evt.event === 'error') error = (evt.data && evt.data.error) || 'Stream failed.';
  };

  for (;;) {
    const { done: readDone, value } = await reader.read();
    if (readDone) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      handleEvent(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) handleEvent(buf);

  return { done, error };
}

function parseSseEvent(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; }
  catch { return null; }
}

function nowTs() { return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
