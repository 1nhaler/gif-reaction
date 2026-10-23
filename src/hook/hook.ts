/**
 * Page hook. Runs inside the Meet page (MAIN world) at document_start, before
 * Meet asks for the camera. It owns the video stream Meet receives and decides
 * what is drawn into it. It never touches audio or screen sharing.
 */
import { pickSyntheticSize, wantsAudio, wantsVideo } from '../shared/constraints';
import { type HookReply, type HookRequest, type TabStatus, parseHookRequest } from '../shared/protocol';
import { ReactionController, type ReactionEnv } from '../shared/reaction';
import { parseRoomCode } from '../shared/room';
import { cameraUiState, clickCameraButton, pressCameraShortcut } from './camera-ui';
import { makeSyntheticStream, wrapCameraStream } from './compositor';
import { GifPlayer } from './gif-player';
import { LiveTracks } from './tracks';

const INSTALLED = Symbol.for('meet-gif-reactions.installed');

function install(): void {
  const w = window as unknown as Record<symbol, unknown>;
  if (w[INSTALLED]) return;
  Object.defineProperty(w, INSTALLED, { value: true });

  const supported =
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    typeof MediaStreamTrackGenerator !== 'undefined' &&
    typeof MediaDevices !== 'undefined' &&
    GifPlayer.isSupported();

  const player = new GifPlayer();
  /** Counts camera-related events so a click fallback never doubles up on a toggle that worked. */
  let cameraEvents = 0;

  // `controller` and `tracks` refer to each other, so both are created before use.
  // eslint-disable-next-line prefer-const
  let controller: ReactionController;
  const tracks = new LiveTracks((live, previous) => {
    cameraEvents += 1;
    if (previous === 0 && live > 0) controller.onCameraOn();
    else if (previous > 0 && live === 0) controller.onCameraOff();
  });

  const env: ReactionEnv = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    isCameraOn: () => tracks.count() > 0,
    pressCameraToggle: () => {
      const eventsBefore = cameraEvents;
      pressCameraShortcut();
      // If Meet ignored the shortcut, fall back to clicking its button. Only do so when
      // nothing camera-related happened meanwhile, so a slow-but-working toggle is not undone.
      window.setTimeout(() => {
        if (cameraEvents === eventsBefore) clickCameraButton();
      }, 1200);
    },
    prepareGif: (data) => player.prepare(data),
    releaseGif: () => player.release(),
  };
  controller = new ReactionController(env);

  const deps = { controller, player, tracks };

  // ---- getUserMedia ---------------------------------------------------------

  if (supported) {
    const original = MediaDevices.prototype.getUserMedia;

    const synthetic = async (self: MediaDevices, constraints: MediaStreamConstraints): Promise<MediaStream> => {
      let audio: MediaStreamTrack[] = [];
      try {
        // Real audio is requested on its own; the camera is deliberately not requested at all.
        if (wantsAudio(constraints)) {
          audio = (await original.call(self, { audio: constraints.audio })).getAudioTracks();
        }
        return makeSyntheticStream(pickSyntheticSize(constraints.video), audio, deps);
      } catch (err) {
        for (const t of audio) t.stop();
        controller.failStart('Could not start the reaction stream.');
        // Never fall back to the real camera here.
        throw err instanceof DOMException ? err : new DOMException('Could not start the camera.', 'NotReadableError');
      }
    };

    const patched = async function (this: MediaDevices, constraints?: MediaStreamConstraints): Promise<MediaStream> {
      if (!wantsVideo(constraints)) return original.call(this, constraints);
      cameraEvents += 1;
      if (controller.shouldSynthesizeNextGrant()) return synthetic(this, constraints as MediaStreamConstraints);

      // Errors from the real request (permission denied, no camera) go to Meet untouched.
      const real = await original.call(this, constraints);
      try {
        return wrapCameraStream(real, deps);
      } catch {
        return real; // fail safe: hand Meet the untouched camera
      }
    };
    Object.defineProperty(patched, 'name', { value: 'getUserMedia' });
    MediaDevices.prototype.getUserMedia = patched;
  }

  // ---- status and commands --------------------------------------------------

  const currentRoom = () => parseRoomCode(location.href);

  const status = (): TabStatus => {
    const s = controller.snapshot();
    return {
      hookReady: true,
      supported,
      room: currentRoom(),
      phase: s.phase,
      cameraOn: tracks.count() > 0,
      error: s.error,
    };
  };

  const handle = async (req: HookRequest): Promise<HookReply> => {
    const fail = (error: string): HookReply => ({ id: req.id, ok: false, error, status: status() });
    if (req.cmd === 'status') return { id: req.id, ok: true, status: status() };

    if (req.room !== currentRoom()) return fail('This tab is not in the meeting that reaction was meant for.');

    if (req.cmd === 'stop') {
      controller.stop();
      return { id: req.id, ok: true, status: status() };
    }

    if (!supported) return fail('This browser is missing features the extension needs (WebCodecs).');
    if (tracks.count() === 0 && cameraUiState() === 'on') {
      return fail("Meet's camera is on but not routed through the extension. Reload the Meet tab and try again.");
    }
    player.fit = req.fit;
    const result = await controller.start({ gif: req.gif, startHoldMs: req.startHoldMs });
    return result.ok ? { id: req.id, ok: true, status: status() } : fail(result.error);
  };

  // ---- private channel to the bridge ---------------------------------------
  // The bridge lives in a different JavaScript world, so the two meet over
  // window messages. Only the handshake travels that way: it hands over one
  // MessagePort, and everything after that is private to the two ends. The first
  // port offered wins, and it is offered before any page script has run.

  let port: MessagePort | null = null;

  const announce = () => window.postMessage({ __mgr: 'hook-ready' }, location.origin);

  const onWindowMessage = (event: MessageEvent) => {
    if (port !== null || event.source !== window) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const tag = (data as { __mgr?: unknown }).__mgr;
    if (tag === 'bridge-ready') {
      announce();
    } else if (tag === 'port' && event.ports.length === 1 && event.ports[0]) {
      event.stopImmediatePropagation(); // page scripts never see the port
      port = event.ports[0];
      window.removeEventListener('message', onWindowMessage, true);
      const p = port;
      p.onmessage = (e: MessageEvent) => {
        const req = parseHookRequest(e.data);
        if (!req) return;
        void handle(req)
          .catch((): HookReply => ({ id: req.id, ok: false, error: 'Something went wrong in the page.', status: status() }))
          .then((reply) => p.postMessage(reply));
      };
      p.start();
    }
  };
  window.addEventListener('message', onWindowMessage, true);
  announce();
}

install();
