# Meet GIF Reactions

A Chrome extension for reacting in Google Meet with a short gif instead of emotes, talking, or showing your face. Paste a Giphy link, press **Go**, and your video tile shows the gif for up to 5 seconds. Everyone who sees your tile sees the gif, because it is your video.

- Audio and screen sharing are never touched.
- If your camera is **on**, the gif replaces your picture, then your camera comes back.
- If your camera is **off**, the extension switches it on for the gif and off again afterwards. The real camera is never turned on in that case, so your camera light stays off.
- If you toggle your camera yourself mid-reaction, the reaction is cancelled and your choice wins.

## Install (for yourself or friends)

1. Download the release zip (or run `npm run package`) and unzip it. You should see a folder containing `manifest.json`.
2. Open `chrome://extensions` in Chrome (or Edge, Brave and other Chromium browsers).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder.
5. Open your Meet call, then **reload the Meet tab once** so the extension is active from the start of the page.

To check a download, compare its SHA-256 with the `.sha256` file published next to the zip.

## Use

1. Join a Meet call in a tab, and keep that tab active in the window.
2. Click the extension icon. The popup shows the room code of the tab it will act on.
3. Paste a Giphy link: a gif page link (`giphy.com/gifs/...`) or a media link (`media.giphy.com/media/...`). A preview appears. Problems with the link are shown next to the preview.
4. Pick how the gif fills your tile: **Fill** (crop to cover, the default), **Fit** (whole gif, black bars) or **Stretch**. The choice is remembered per gif.
5. Press **Go**. The button becomes **Stop** while the reaction runs.

Gifs longer than 5 seconds are cut off at 5. Shorter gifs play once and end early.

**Settings → Start hold:** shows the gif's first frame still for this many milliseconds before it starts moving. It is off (0) by default. If viewers tend to miss the beginning of the gif, raise it to a few hundred milliseconds.

## Requirements

- A Chromium browser, version 111 or newer (uses WebCodecs and Chrome's track processing APIs). Firefox and Safari are not supported.
- Google Meet only for now.

## Privacy

- Nothing is recorded, logged, or sent anywhere. There is no server.
- The only network requests are the popup downloading the gif you pasted, directly from Giphy. Giphy can see your IP address when that happens.
- Everything the extension remembers (your last link, start hold, fit per gif) is stored with `chrome.storage.local`, in this browser only.
- Permissions: Meet pages (to hook the camera), `*.giphy.com` (to download the gif), and local storage. Nothing else.

## Security

Input is treated as hostile.

- The pasted text is **never fetched**. It is parsed with the browser's URL parser, the gif ID is extracted with a strict pattern, and every download URL is rebuilt from a fixed `https://media.giphy.com/media/<id>/…` template.
- Only `https`, only Giphy hosts (exact match), no credentials, no custom ports, no IP hosts, printable ASCII only, length-capped.
- The URL is checked again before every download and again on the final address after redirects. The response must be a real GIF (content type and file signature) within a 10 MB cap.
- Messages between the popup, the extension's content script and the page are validated field by field. The page hook only accepts commands over a private message channel set up before any page script runs, and only for the meeting they were made for.
- Stored data is re-validated every time it is read.
- No `eval`, no HTML string injection, no inline scripts, no remote code. `npm run audit` enforces this on the source.
- There is no sharing, export, or sync. A feature like that would need its own security review.

## How it works

Three parts:

- **Page hook** (`src/hook`), injected into the Meet page before Meet runs. It wraps `getUserMedia`. For a camera request it hands Meet a generated video track instead of the raw camera, fed by the real camera frame by frame. Audio tracks pass straight through. During a reaction, gif frames are drawn into that track instead of camera frames.
- **Bridge** (`src/bridge`), a content script that relays validated messages between the popup and the hook.
- **Popup** (`src/popup`), the interface. It downloads and previews the gif, and sends it to the active Meet tab.

The gif is decoded in the page with WebCodecs `ImageDecoder`, from bytes the popup downloaded. The page never loads anything from Giphy, so Meet's content security policy cannot interfere.

Camera on/off is decided by whether Meet holds a live video track from the extension. To switch Meet's camera for a reaction the extension presses Meet's own keyboard shortcut (Ctrl+E, Cmd+E on a Mac), and if that has no effect it clicks the camera button, which it finds by the shortcut hint in the button label rather than translated text.

The reaction rules live in one place, `src/shared/reaction.ts`, and are covered by unit tests.

## Known limitations

- It depends on how Meet behaves, which Google can change at any time. The riskiest parts are the camera switching (shortcut and button lookup) and Meet turning its camera off by stopping the track.
- Meet receives a generated track rather than the raw camera track. Meet features that read camera-specific settings may behave differently. If you see quality problems, please report them.
- After installing, a Meet tab that was already open must be reloaded. If the camera was already on and not routed through the extension, **Go** says so rather than guessing.
- Camera on means the camera feed passes through the extension all the time, which costs a little CPU.
- If Meet clones the camera track for another purpose, only the track Meet received first is tracked.
- Giphy gif page links are supported. Short links (`gph.is`) are not.
- Zoom and other meeting apps are not supported yet.

## Development

```
npm install
npm run check      # typecheck, security audit, unit tests, build
npm run e2e        # real Chromium with a fake camera (downloads a bundled Chromium via npm)
npm run package    # release/meet-gif-reactions-v<version>.zip plus checksum
```

`npm run e2e` runs the built hook against a stand-in for Meet and checks, among other things, that a camera-off reaction never requests the real camera, and that the popup works under the extension's content security policy. Set `CHROME_PATH` to use your own Chrome instead of the bundled one. It cannot load the extension itself, so it injects the built scripts the way the extension would; it does not run against the real Meet.

Layout:

```
src/shared   pure logic with unit tests: URL parsing, download checks, reaction state machine, storage, messages
src/hook     page hook: camera interception, gif decoding and drawing, Meet camera control
src/bridge   content script relaying popup <-> hook
src/popup    popup logic (static/popup.html and popup.css are the page)
test         unit tests (node:test)
e2e          browser checks
```

## Ideas for later

- Progress or countdown indicator in the popup
- Favorites with one-click or hotkey triggers (storage already reserves a `favorites` list)
- A finish hold (keep the last frame briefly before switching back)
- Zoom web, then Firefox
- Giphy search (needs a per-user API key)

## License

MIT
