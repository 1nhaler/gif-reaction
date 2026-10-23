/**
 * Meet's camera button label ends with its shortcut, e.g. "Turn off camera
 * (ctrl + e)", and the shortcut hint stays in Latin letters whatever the UI
 * language. Matching the hint keeps us independent of the translated text.
 */
const CAMERA_HINT_RE = /\(\s*(?:ctrl|control|cmd|command|⌘)\s*\+?\s*e\s*\)/i;

export function isCameraToggleLabel(label: string | null | undefined): boolean {
  return typeof label === 'string' && CAMERA_HINT_RE.test(label);
}

/** Meet marks its toggles with data-is-muted="true|false". */
export function cameraStateFromAttribute(value: string | null | undefined): 'on' | 'off' | 'unknown' {
  if (value === 'false') return 'on';
  if (value === 'true') return 'off';
  return 'unknown';
}
