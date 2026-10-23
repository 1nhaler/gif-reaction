/**
 * Keeps count of the video tracks we have handed to Meet that are still live.
 * Meet turns its camera off by stopping the track, so "no live tracks" is our
 * source of truth for "the camera is off".
 */

type Teardown = () => void;

const enabledDescriptor = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');

function isLive(track: MediaStreamTrack): boolean {
  return track.readyState === 'live' && track.enabled;
}

export class LiveTracks {
  private readonly tracks = new Map<MediaStreamTrack, Teardown>();
  private lastLive = 0;

  constructor(private readonly onChange: (live: number, previous: number) => void) {}

  count(): number {
    let n = 0;
    for (const t of this.tracks.keys()) if (isLive(t)) n += 1;
    return n;
  }

  /** Starts tracking a track; `teardown` runs once when it stops or ends. */
  add(track: MediaStreamTrack, teardown: Teardown): void {
    this.tracks.set(track, teardown);

    const nativeStop = track.stop.bind(track);
    track.stop = () => {
      nativeStop();
      this.release(track);
    };
    track.addEventListener('ended', () => this.release(track));

    // Some pages mute a camera by flipping `enabled` instead of stopping the track.
    if (enabledDescriptor?.get && enabledDescriptor.set) {
      const { get, set } = enabledDescriptor;
      Object.defineProperty(track, 'enabled', {
        configurable: true,
        enumerable: true,
        get: () => get.call(track) as boolean,
        set: (value: boolean) => {
          set.call(track, value);
          this.recompute();
        },
      });
    }
    this.recompute();
  }

  private release(track: MediaStreamTrack): void {
    const teardown = this.tracks.get(track);
    if (!teardown) return;
    this.tracks.delete(track);
    try {
      teardown();
    } catch {
      /* teardown is best effort */
    }
    this.recompute();
  }

  private recompute(): void {
    const live = this.count();
    if (live === this.lastLive) return;
    const previous = this.lastLive;
    this.lastLive = live;
    this.onChange(live, previous);
  }
}
