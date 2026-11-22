# Trains Maxxing

A VJ mixer for train videos that you run from your phone, plus an iPad kaleidoscope that feeds into it.

A laptop plugged into the projector shows the picture. Your phone is the mixing desk. Nothing needs the internet once it is installed.

## Set it up (once)

1. Install [Node.js](https://nodejs.org) (the LTS version) on the laptop.
2. Put this folder somewhere on the laptop.
3. Copy your videos into the `media` folder. Sub-folders become "crates" you can filter by.
4. Double-click **`start.command`** (Mac) or **`start.bat`** (Windows). The first run installs what it needs, which takes a minute and needs internet that one time.

On a Mac, if it says the file is from an unidentified developer, right-click it and choose Open.

If you prefer a terminal: `npm install`, then `npm start`.

## At the party

1. Connect the laptop to the projector or TV.
2. Start it (double-click as above). A browser window opens with a big QR code. Chrome works best.
3. Get the phone and the laptop on the same Wi-Fi. No Wi-Fi at the venue? Turn on the phone's hotspot and connect the laptop to it.
4. Scan the QR code with the phone camera. That's the remote.
5. Drag the browser window to the projector and press **F** for fullscreen.

On the phone, use "Add to Home Screen" to get it fullscreen like an app.

**Do this before the party:** open the Clips tab, scroll to the bottom and tap *Prepare all clips for smooth scratching*. It makes a copy of each clip that plays backwards and scrubs smoothly. Clips work without it, but scratching and reverse will stutter until a clip has been prepared (each clip is also prepared automatically the first time you use it).

Keys on the laptop: **F** fullscreen, **Q** show or hide the QR card, **B** blackout.

## The phone remote

The slider at the bottom is always there: left is deck A, right is deck B. Tap the **A** or **B** button beside it for a smooth glide.

| Tab | What it does |
| --- | --- |
| **Mix** | The two decks. Drag the filmstrip to scratch a train back and forth, flick it to throw it. ◀◀ plays backwards, ⇄ shunts back and forth by itself. Below: how A and B blend in the middle, the slider style (fade, cut, train wipe, split screen), and two overlay layers that sit on top. |
| **Clips** | Your library. Pick where to send (A, B or an overlay), then tap a clip. Turn on *Hold for GO* to line up several clips, then press GO on the Mix tab to start them all at the same moment. |
| **FX** | Hold pads (strobe, invert, glitch, freeze, rewind) work while your finger is down. Effect pads toggle; the square pad below changes the selected effect. Tap along with the music on TAP to set the beat. |
| **Auto** | Autopilot mixes by itself. Chill ↔ Chaos sets how busy it gets. It keeps going if your phone sleeps. Also: eight slots to save and recall a whole look. |
| **Tag** | Paint on the big screen with your finger, or throw up a shout-out in graffiti letters. |

Top bar: a small live picture of the big screen (tap to enlarge), **AUTO**, **BLACKOUT**, and a lock so your pocket cannot mix.

Portrait clips get a blurred copy of themselves behind them so there are no black bars. Change that per deck under ⋯ → Picture fit (Fill, Fit, Tile, Turn). *Split* slider style puts A and B side by side, which suits two portrait clips.

Clip sound is off by default. Each deck has a *Clip sound* slider under ⋯; click once on the laptop's window first, because browsers only allow sound after a click.

## The iPad kaleidoscope

1. Scan the small QR code on the big screen with the iPad (or find the link on the phone's Auto tab).
2. Safari warns the connection is "not private" the first time. That is expected, because the laptop makes its own security certificate: tap **Show Details**, then **visit this website**. The camera only works over this secure address.
3. Tap **Start camera**. Add it to the Home Screen for fullscreen.

Drag to move the picture, pinch to zoom, twist with two fingers to rotate. You can also feed it a photo or video from the iPad instead of the camera.

In the mixer it appears under **Live** on the Clips tab. Send it to a deck or overlay like any clip. The iPad shows **ON AIR** when it is on screen. It also works with no mixer at all.

Any phone can open the same link and use *Plain camera* to act as a roving camera.

## A second screen

A second laptop on its own projector can show the same picture. Start the app on the first laptop as usual, then on the second laptop open the *Second screen* address in Chrome (it is printed when the app starts, and shown at the bottom of the phone's Auto tab). Press **F** for fullscreen.

The screen that was opened first leads and the other follows its playheads, so the trains stay in step to within a frame or two. If the leading screen is closed, the other takes over. Clip sound and beat listening only happen on the leading screen. The second laptop fetches the videos from the first over Wi-Fi, so prepare your clips beforehand.

## If something is off

- **Phone says it cannot connect:** phone and laptop must be on the same network. Some venue and guest Wi-Fi networks block devices from talking to each other; use the phone's hotspot instead.
- **Scratching or reverse stutters:** that clip has not been prepared yet. Look for the ⚡ on its thumbnail.
- **A clip stays black for a while the first time:** the browser cannot play that format directly (common with iPhone HEVC video on Windows), so it waits for the prepared copy.
- **Phone screen keeps turning off:** set Auto-Lock to Never for the night.
- **Disk filling up:** prepared copies live in `data/cache`. *Free up space* on the Clips tab deletes them; your originals are never touched.
- **Strobe:** it flashes twice a beat. Go easy on it around people who are sensitive to flashing light.

## For whoever maintains this

- `server/` Node server: authoritative state, autopilot, media library, WebSocket hub, WebRTC signalling relay.
- `shared/` state model and effect list, used by both server and browsers.
- `public/stage/` the WebGL2 output. `public/remote/` the phone UI. `public/kaleido/` the kaleidoscope.
- No build step. `data/` holds the saved state, session token, certificate and cache; delete it to start fresh.
- Settings by environment variable: `TM_PORT` (8080), `TM_HTTPS_PORT` (8443), `TM_MEDIA`, `TM_DATA`, `TM_FFMPEG`. `TM_NO_TOKEN=1` turns the session token off (demos and trusted networks only).
- `npm test` runs the unit tests. `npm run e2e` drives the real pages in headless Chromium (needs Playwright and ffmpeg).

The remote link carries a session token; devices without it cannot connect to the controls. Thumbnails and video files are served without it to anyone on the same network.
