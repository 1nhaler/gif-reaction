import { MAX_GIF_BYTES, MAX_START_HOLD_MS } from './constants';
import { base64LengthFor, isBase64 } from './base64';
import { type FitMode, isFitMode } from './fit';
import { isRoomCode } from './room';

export type Phase = 'idle' | 'starting' | 'holding' | 'playing' | 'ending';

/** What the page hook reports about itself. */
export interface TabStatus {
  /** The bridge could reach the page hook. */
  hookReady: boolean;
  /** The browser has everything the hook needs (WebCodecs, track processor). */
  supported: boolean;
  room: string | null;
  phase: Phase;
  cameraOn: boolean;
  error: string | null;
}

export type PopupRequest =
  | { type: 'status' }
  | { type: 'start'; room: string; gifBase64: string; fit: FitMode; startHoldMs: number }
  | { type: 'stop'; room: string };

export type TabReply = { ok: true; status: TabStatus } | { ok: false; error: string; status?: TabStatus };

const MAX_BASE64_LENGTH = base64LengthFor(MAX_GIF_BYTES) + 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a message arriving from the popup. Anything unexpected is dropped. */
export function parsePopupRequest(raw: unknown): PopupRequest | null {
  if (!isRecord(raw)) return null;
  switch (raw['type']) {
    case 'status':
      return { type: 'status' };
    case 'stop':
      return isRoomCode(raw['room']) ? { type: 'stop', room: raw['room'] } : null;
    case 'start': {
      const { room, gifBase64, fit, startHoldMs } = raw;
      if (!isRoomCode(room)) return null;
      if (typeof gifBase64 !== 'string' || gifBase64.length === 0 || gifBase64.length > MAX_BASE64_LENGTH) return null;
      if (!isBase64(gifBase64)) return null;
      if (!isFitMode(fit)) return null;
      if (typeof startHoldMs !== 'number' || !Number.isInteger(startHoldMs) || startHoldMs < 0 || startHoldMs > MAX_START_HOLD_MS) {
        return null;
      }
      return { type: 'start', room, gifBase64, fit, startHoldMs };
    }
    default:
      return null;
  }
}

/** Messages the bridge sends to the page hook over the private channel. */
export type HookRequest =
  | { id: number; cmd: 'status' }
  | { id: number; cmd: 'start'; room: string; gif: ArrayBuffer; fit: FitMode; startHoldMs: number }
  | { id: number; cmd: 'stop'; room: string };

export type HookReply = { id: number; ok: true; status: TabStatus } | { id: number; ok: false; error: string; status: TabStatus };

export function parseHookRequest(raw: unknown): HookRequest | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  switch (raw['cmd']) {
    case 'status':
      return { id, cmd: 'status' };
    case 'stop':
      return isRoomCode(raw['room']) ? { id, cmd: 'stop', room: raw['room'] } : null;
    case 'start': {
      const { room, gif, fit, startHoldMs } = raw;
      if (!isRoomCode(room)) return null;
      if (!(gif instanceof ArrayBuffer) || gif.byteLength === 0 || gif.byteLength > MAX_GIF_BYTES) return null;
      if (!isFitMode(fit)) return null;
      if (typeof startHoldMs !== 'number' || !Number.isInteger(startHoldMs) || startHoldMs < 0 || startHoldMs > MAX_START_HOLD_MS) {
        return null;
      }
      return { id, cmd: 'start', room, gif, fit, startHoldMs };
    }
    default:
      return null;
  }
}

const PHASES: readonly Phase[] = ['idle', 'starting', 'holding', 'playing', 'ending'];

/** Validates a status object that crossed a boundary before the popup displays it. */
export function parseTabStatus(raw: unknown): TabStatus | null {
  if (!isRecord(raw)) return null;
  const { hookReady, supported, room, phase, cameraOn, error } = raw;
  if (typeof hookReady !== 'boolean' || typeof supported !== 'boolean' || typeof cameraOn !== 'boolean') return null;
  if (typeof phase !== 'string' || !PHASES.includes(phase as Phase)) return null;
  if (room !== null && !isRoomCode(room)) return null;
  if (error !== null && typeof error !== 'string') return null;
  return {
    hookReady,
    supported,
    room: room as string | null,
    phase: phase as Phase,
    cameraOn,
    error: error === null ? null : error.slice(0, 300),
  };
}

/** Validates a reply that came back from a tab before the popup acts on it. */
export function parseTabReply(raw: unknown): TabReply | null {
  if (!isRecord(raw) || typeof raw['ok'] !== 'boolean') return null;
  const status = raw['status'] === undefined ? undefined : parseTabStatus(raw['status']);
  if (raw['status'] !== undefined && !status) return null;
  if (raw['ok']) return status ? { ok: true, status } : null;
  const error = typeof raw['error'] === 'string' ? raw['error'].slice(0, 300) : 'Something went wrong.';
  return status ? { ok: false, error, status } : { ok: false, error };
}
