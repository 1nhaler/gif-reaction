/** Google Meet room codes look like abc-defg-hij. */
const ROOM_PATH_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/;

export function parseRoomCode(urlText: string | undefined | null): string | null {
  if (!urlText) return null;
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com') return null;
  const m = ROOM_PATH_RE.exec(url.pathname);
  return m?.[1] ?? null;
}

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(value);
}
