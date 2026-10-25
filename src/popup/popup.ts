import { bytesToBase64 } from '../shared/base64';
import { GifFetchError, fetchGif } from '../shared/fetch-gif';
import { type FitMode, isFitMode } from '../shared/fit';
import { parseGifInput } from '../shared/gif-source';
import { type PopupRequest, type TabReply, type TabStatus, parseTabReply } from '../shared/protocol';
import { parseRoomCode } from '../shared/room';
import {
  STORAGE_KEY,
  type StoredState,
  clampStartHold,
  defaultState,
  fitFor,
  recordGifUse,
  sanitizeStoredState,
} from '../shared/storage';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const urlInput = el<HTMLInputElement>('url');
const previewImg = el<HTMLImageElement>('preview-img');
const previewMsg = el<HTMLParagraphElement>('preview-msg');
const fitSelect = el<HTMLSelectElement>('fit');
const holdInput = el<HTMLInputElement>('hold');
const goButton = el<HTMLButtonElement>('go');
const statusLine = el<HTMLParagraphElement>('status');
const roomChip = el<HTMLSpanElement>('room');
const diagList = el<HTMLUListElement>('diag');

interface LoadedGif {
  id: string;
  bytes: ArrayBuffer;
  blobUrl: string;
  url: string;
}

let state: StoredState = defaultState();
let tab: { id: number; room: string } | null = null;
let gif: LoadedGif | null = null;
let status: TabStatus | null = null;
let sending = false;
let feedback: { text: string; error: boolean } | null = null;
let loadAbort: AbortController | null = null;
let debounce: ReturnType<typeof setTimeout> | undefined;

// ---- messaging ---------------------------------------------------------------

async function sendToTab(request: PopupRequest): Promise<TabReply> {
  if (!tab) return { ok: false, error: 'Open a Google Meet call in this window first.' };
  try {
    const raw: unknown = await chrome.tabs.sendMessage(tab.id, request);
    return parseTabReply(raw) ?? { ok: false, error: 'The Meet tab sent an unexpected answer.' };
  } catch {
    return { ok: false, error: 'The extension is not active on this tab. Reload the Meet tab and try again.' };
  }
}

async function saveState(): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch {
    /* storage is a convenience; the popup works without it */
  }
}

// ---- preview -------------------------------------------------------------------

function showPreview(kind: 'hint' | 'error', text: string): void {
  previewImg.hidden = true;
  previewImg.removeAttribute('src');
  previewMsg.hidden = false;
  previewMsg.textContent = text;
  previewMsg.classList.toggle('error', kind === 'error');
}

function clearGif(): void {
  if (gif) URL.revokeObjectURL(gif.blobUrl);
  gif = null;
}

async function loadPreview(text: string): Promise<void> {
  loadAbort?.abort();
  clearGif();

  if (text.trim() === '') {
    showPreview('hint', 'Paste a GIF link to preview it.');
    render();
    return;
  }
  const parsed = parseGifInput(text);
  if (!parsed.ok) {
    showPreview('error', parsed.message);
    render();
    return;
  }

  const abort = new AbortController();
  loadAbort = abort;
  showPreview('hint', 'Loading preview...');
  render();
  try {
    let mediaUrls = parsed.mediaUrls;
    if (mediaUrls.length === 0 && parsed.resolve) {
      showPreview('hint', 'Resolving link...');
      mediaUrls = await parsed.resolve(abort.signal);
      if (abort.signal.aborted) return;
    }
    const fetched = await fetchGif(mediaUrls, { fetch: window.fetch.bind(window), signal: abort.signal });
    if (abort.signal.aborted) return;
    const blobUrl = URL.createObjectURL(new Blob([fetched.bytes], { type: 'image/gif' }));
    gif = { id: parsed.id, bytes: fetched.bytes, blobUrl, url: text.trim() };
    previewMsg.hidden = true;
    previewImg.hidden = false;
    previewImg.src = blobUrl;
    fitSelect.value = fitFor(state, parsed.id);
  } catch (err) {
    if (abort.signal.aborted) return;
    showPreview('error', err instanceof GifFetchError ? err.message : 'Could not load that gif.');
  }
  render();
}

// ---- actions ---------------------------------------------------------------------

function readFit(): FitMode {
  return isFitMode(fitSelect.value) ? fitSelect.value : 'fill';
}

async function onGo(): Promise<void> {
  if (!tab || sending) return;

  if (status && status.phase !== 'idle') {
    const reply = await sendToTab({ type: 'stop', room: tab.room });
    status = reply.ok ? reply.status : (reply.status ?? status);
    render();
    return;
  }
  if (!gif) return;

  sending = true;
  feedback = null;
  render();
  const fit = readFit();
  const loaded = gif;
  const reply = await sendToTab({
    type: 'start',
    room: tab.room,
    gifBase64: bytesToBase64(new Uint8Array(loaded.bytes)),
    fit,
    startHoldMs: clampStartHold(holdInput.value),
  });
  sending = false;
  if (reply.ok) {
    state = recordGifUse(state, loaded.id, fit, Date.now(), loaded.url);
    void saveState();
  } else {
    feedback = { text: reply.error, error: true };
  }
  status = reply.ok ? reply.status : (reply.status ?? status);
  render();
}

// ---- rendering ---------------------------------------------------------------------

function setStatus(text: string, error = false): void {
  statusLine.textContent = text;
  statusLine.classList.toggle('error', error);
}

function setButton(label: string, enabled: boolean, stop = false): void {
  goButton.textContent = label;
  goButton.disabled = !enabled;
  goButton.classList.toggle('stop', stop);
}

type DiagOk = 'true' | 'warn' | 'false';
function diagItem(ok: DiagOk, label: string): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset['ok'] = ok;
  li.textContent = label;
  return li;
}

/** Returns true when a critical check failed (should block Go). */
function renderDiag(s: TabStatus | null): boolean {
  diagList.replaceChildren();

  // Only show the panel when the hook is reachable and has a diag snapshot.
  if (!s?.hookReady || !s.diag) {
    diagList.hidden = true;
    return false;
  }

  const { webCodecsOk, cameraButtonFound } = s.diag;
  const criticalFail = !webCodecsOk;

  // (We only flag it if cameraButtonFound so the user knows the button exists.)
  const cameraWarn = !cameraButtonFound;

  const items: HTMLLIElement[] = [
    diagItem(s.hookReady ? 'true' : 'false', 'Hook installed & reachable'),
    diagItem(webCodecsOk ? 'true' : 'false', 'WebCodecs API available'),
    diagItem(cameraButtonFound ? 'true' : 'warn',
      cameraButtonFound ? 'Camera shortcut recognized' : 'Camera button not found — shortcut may not work'),
  ];

  const allGreen = !criticalFail && !cameraWarn;
  diagList.hidden = allGreen;
  if (!allGreen) {
    for (const item of items) diagList.appendChild(item);
  }
  return criticalFail;
}

function render(): void {
  roomChip.hidden = tab === null;
  if (tab) roomChip.textContent = tab.room;

  const criticalFail = renderDiag(status ?? null);

  if (!tab) {
    setButton('Go', false);
    setStatus('Open a Google Meet call in this window to use reactions.');
    return;
  }
  if (!status || !status.hookReady) {
    setButton('Go', false);
    setStatus('Reload the Meet tab to activate the extension on it.');
    return;
  }
  if (!status.supported) {
    setButton('Go', false);
    setStatus('This browser is missing features the extension needs. Use a current version of Chrome.', true);
    return;
  }
  if (criticalFail) {
    setButton('Go', false);
    setStatus('Extension cannot be used — please wait for an update or try again later.', true);
    return;
  }

  switch (status.phase) {
    case 'idle':
      setButton(sending ? 'Starting...' : 'Go', gif !== null && !sending);
      if (status.error) setStatus(status.error, true);
      else if (feedback) setStatus(feedback.text, feedback.error);
      else setStatus(gif ? '' : 'Paste a GIF link above.');
      break;
    case 'starting':
      setButton('Stop', true, true);
      setStatus('Starting...');
      break;
    case 'holding':
    case 'playing':
      setButton('Stop', true, true);
      setStatus('Showing your gif.');
      break;
    case 'ending':
      setButton('Finishing...', false);
      setStatus('Switching the camera back.');
      break;
  }
}

let polling = false;
async function refreshStatus(): Promise<void> {
  if (polling || sending) return;
  polling = true;
  try {
    const reply = await sendToTab({ type: 'status' });
    status = reply.ok ? reply.status : null;
    render();
  } finally {
    polling = false;
  }
}

// ---- start up ---------------------------------------------------------------------------

async function init(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    state = sanitizeStoredState(stored[STORAGE_KEY]);
  } catch {
    state = defaultState();
  }
  urlInput.value = state.lastUrl;
  holdInput.value = String(state.settings.startHoldMs);
  fitSelect.value = state.settings.defaultFit;

  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const room = parseRoomCode(active?.url);
    tab = active?.id !== undefined && room !== null ? { id: active.id, room } : null;
  } catch {
    tab = null;
  }

  urlInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void loadPreview(urlInput.value), 200);
  });
  holdInput.addEventListener('change', () => {
    const value = clampStartHold(holdInput.value);
    holdInput.value = String(value);
    state = { ...state, settings: { ...state.settings, startHoldMs: value } };
    void saveState();
  });
  goButton.addEventListener('click', () => void onGo());
  window.addEventListener('pagehide', () => clearGif());

  render();
  void refreshStatus();
  setInterval(() => void refreshStatus(), 400);
  if (state.lastUrl) void loadPreview(state.lastUrl);
}

void init();
