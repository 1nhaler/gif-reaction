/**
 * Bridge. Runs in the extension's isolated world on Meet pages. It relays
 * validated requests from the popup to the page hook, over a private
 * MessageChannel, and relays the answers back.
 */
import { base64ToBytes } from '../shared/base64';
import { looksLikeGif } from '../shared/fetch-gif';
import {
  type HookReply,
  type HookRequest,
  type TabReply,
  type TabStatus,
  parsePopupRequest,
  parseTabStatus,
} from '../shared/protocol';
import { parseRoomCode } from '../shared/room';

const REQUEST_TIMEOUT_MS = 12_000;
const HANDSHAKE_WAIT_MS = 1500;

let port: MessagePort | null = null;
let resolvePort: (p: MessagePort) => void = () => undefined;
const portReady = new Promise<MessagePort>((resolve) => {
  resolvePort = resolve;
});

type Waiter = (reply: HookReply | null) => void;
const waiting = new Map<number, Waiter>();
let nextId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHookReply(raw: unknown): HookReply | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'number' || typeof raw['ok'] !== 'boolean') return null;
  const status = parseTabStatus(raw['status']);
  if (!status) return null;
  if (raw['ok']) return { id: raw['id'], ok: true, status };
  const error = typeof raw['error'] === 'string' ? raw['error'].slice(0, 300) : 'Something went wrong.';
  return { id: raw['id'], ok: false, error, status };
}

// ---- handshake -----------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
  if (port !== null || event.source !== window) return;
  const data: unknown = event.data;
  if (!isRecord(data) || data['__mgr'] !== 'hook-ready') return;

  const channel = new MessageChannel();
  port = channel.port1;
  port.onmessage = (e: MessageEvent) => {
    const reply = parseHookReply(e.data);
    if (!reply) return;
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  };
  port.start();
  window.postMessage({ __mgr: 'port' }, location.origin, [channel.port2]);
  resolvePort(port);
});
window.postMessage({ __mgr: 'bridge-ready' }, location.origin);

// ---- relaying --------------------------------------------------------------

function offlineStatus(): TabStatus {
  return { hookReady: false, supported: false, room: parseRoomCode(location.href), phase: 'idle', cameraOn: false, error: null };
}

function send(request: HookRequest, transfer: Transferable[] = []): Promise<HookReply | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(request.id);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    waiting.set(request.id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    port?.postMessage(request, transfer);
  });
}

async function waitForPort(): Promise<boolean> {
  if (port) return true;
  const result = await Promise.race([portReady, new Promise<null>((r) => setTimeout(() => r(null), HANDSHAKE_WAIT_MS))]);
  return result !== null;
}

function toTabReply(reply: HookReply | null): TabReply {
  if (!reply) return { ok: false, error: 'The page did not answer. Reload the Meet tab and try again.', status: offlineStatus() };
  return reply.ok ? { ok: true, status: reply.status } : { ok: false, error: reply.error, status: reply.status };
}

async function handle(raw: unknown): Promise<TabReply> {
  const request = parsePopupRequest(raw);
  if (!request) return { ok: false, error: 'Unrecognised request.' };

  if (!(await waitForPort())) {
    if (request.type === 'status') return { ok: true, status: offlineStatus() };
    return {
      ok: false,
      error: 'The extension is not active on this tab. Reload the Meet tab and try again.',
      status: offlineStatus(),
    };
  }

  const id = nextId++;
  if (request.type === 'status') return toTabReply(await send({ id, cmd: 'status' }));

  // Commands only act on the meeting they were made for.
  const room = parseRoomCode(location.href);
  if (room === null || request.room !== room) {
    return { ok: false, error: 'This tab is not in the meeting that reaction was meant for.', status: offlineStatus() };
  }

  if (request.type === 'stop') return toTabReply(await send({ id, cmd: 'stop', room }));

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(request.gifBase64);
  } catch {
    return { ok: false, error: 'The gif data was damaged.', status: offlineStatus() };
  }
  if (!looksLikeGif(bytes)) return { ok: false, error: 'That is not a valid gif.', status: offlineStatus() };
  const gif = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return toTabReply(await send({ id, cmd: 'start', room, gif, fit: request.fit, startHoldMs: request.startHoldMs }, [gif]));
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  // Only this extension's own pages may talk to us.
  if (sender.id !== chrome.runtime.id) return false;
  handle(raw)
    .catch((): TabReply => ({ ok: false, error: 'Something went wrong in the extension.' }))
    .then(sendResponse);
  return true; // keep the channel open for the async answer
});
