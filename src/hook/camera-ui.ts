import { cameraStateFromAttribute, isCameraToggleLabel } from '../shared/camera-label';

/**
 * Pressing Meet's camera toggle, without relying on translated text.
 * Primary: Meet's own keyboard shortcut (Ctrl+E, or Cmd+E on a Mac).
 * Fallback: clicking the button, found by the shortcut hint in its label.
 */

export function findCameraButton(doc: Document = document): HTMLElement | null {
  const candidates = doc.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]');
  for (const el of candidates) {
    if (isCameraToggleLabel(el.getAttribute('aria-label'))) return el;
  }
  return null;
}

/** What Meet's own button says about the camera, independent of what we have intercepted. */
export function cameraUiState(doc: Document = document): 'on' | 'off' | 'unknown' {
  const button = findCameraButton(doc);
  return cameraStateFromAttribute(button?.getAttribute('data-is-muted'));
}

function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? navigator.platform ?? '');
}

export function pressCameraShortcut(doc: Document = document): void {
  const mac = isMac();
  const init: KeyboardEventInit = {
    key: 'e',
    code: 'KeyE',
    keyCode: 69,
    which: 69,
    ctrlKey: !mac,
    metaKey: mac,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const target: EventTarget = doc.activeElement ?? doc.body;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

export function clickCameraButton(doc: Document = document): boolean {
  const button = findCameraButton(doc);
  if (!button) return false;
  button.click();
  return true;
}
