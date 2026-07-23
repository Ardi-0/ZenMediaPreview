# Implementation Ideas / Design Docs

## Architecture Overview

The project uses Firefox's `JSWindowActor` IPC mechanism to stream video frames from page-level `<video>` elements into the browser's sidebar chrome UI:

```
Content Process (tab)           Chrome Process (sidebar)
───────────────                 ──────────────────
<video> element                           ┌─ <canvas zsp-canvas>
    │                                     │  ◄ Live preview rendered here
    ▼                                     └───────────────────────
OffscreenCanvas (downscale frame)  ◄─ IPC sendAsyncMessage("ZenPiP:Frame", {buf, width, height}, [transferable])
    │
sendAsyncMessage("ZenPiP:MirrorStarted") ►─ parent-actor.js
                                             manage sources / tick loop
```

## Cross-process messaging protocol

| Direction | Message Name | Payload | Purpose |
|--|--|--|--|
| Child → Parent | `ZenPiP:MirrorStarted` | `{width, height}` | Video detected & ready to stream. Registers this tab as a potential source with the sidebar controller. |
| Child → Parent | `ZenPiP:Frame` | `{buf (transferable ArrayBuffer), width, height}` | Captured RGBA frame. Zero-copy via structured clone transferables. |
| Child → Parent | `ZenPiP:SourceVisibility` | `{hidden: boolean}` | Document.visibilityState change from the source tab. Used to hide preview when user switches away. |
| Child → Parent | `ZenPiP:VideoStopped` | `{reason: string}` | Video ended/paused/emptied/muted. Unregisters this source. |
| Parent → Child | `ZenPiP:Tick` | `{quality: string}` | Trigger frame capture at the parent-configured framerate / resolution cap. |
| Parent → Child | `ZenPiP:Stop` | `{}` | Forced stop (tab destroyed, actor destroys). |

## Frame pipeline details (`content-actor.js`)

1. **Detection phase** – Listens for `playing`, `pause`, `volumechange`, `ended`, `emptied` events on `<video>` elements in moz-system-group capture phase (catches all videos before page JS can prevent default).
2. **"Audible" filter** – A video must satisfy `!muted && volume > 0` to qualify. This prevents flashing silent/background tab previews.
3. **Downscale** – `<video>` is drawn onto an `OffscreenCanvas` (or `<canvas>` fallback) at the configured max dimension via `ctx.drawImage(video, ...)`. Maintains aspect ratio; rounds dimensions to even numbers for compatibility.
4. **Capture & ship** – `ctx.getImageData(0, 0, w, h)` extracts RGBA pixels. The underlying `ArrayBuffer` is sent as a transferable in `sendAsyncMessage("ZenPiP:Frame", ..., [img.data.buffer])` — zero-copy across process boundary.
5. **Tick-driven sampling** – Parent dictates the capture rate via periodic `ZenPiP:Tick` messages (10-30fps configurable). Content actor applies configured quality cap on each tick.

## Source management (`parent-actor.js`)

- The parent maintains a `_tickInterval` timer that fires `ZenPiP:Tick` at the user-configured framerate reading from `AboutConfig`.
- **Quality lookup**: Reads `mod.zenmediapreview.quality` (default `"480"`) on each tick — allows live changes without restart.
- Registers/unregisters sources, maps browsingContext IDs to `{startTick, stopTick}` callbacks + owner window reference for timer ownership.

## Controller surface (`main.uc.js`) – `ZenPiPController`

A controller object published as `window.ZenPiPController`, consumed by all other module code:

| Method | Purpose / Effect |
|--|--|
| `getActiveBC()` → `{BrowsingContext}` or `null` | Returns the currently streaming source's browsing context. Used to verify incoming frames belong to active tab. |
| `drawFrame({buf, width, height})` → void | Creates an `ImageData` from the transferable buffer, paints it onto the sidebar `<canvas>` via 2D context `putImageData`. Sets canvas intrinsic dimensions and CSS `aspect-ratio` custom property. |
| `setSourceTabActive(boolean)` → void | Tracks whether the source tab is the selected/rearmost tab in sidebar. Hides preview when user switches away from the video's tab to avoid flicker. |
| `registerSource(id, callbacks)` / `unregisterSource(id)` → void | Manages the active-actor registry: `{startTick(win), stopTick(), win}`. Keys by browsing context ID so each tab gets one actor regardless of frame count (`allFrames: true`). |
| `offerVideo(width, height, browsingContext)` → void | Called once per new video. Registers it in `availableSources` Map and auto-activates if no current source or this matches the active media controller. |
| `notifySourceStopped(browsingContext)` → void | Removes source from `availableSources`. Deactivates active media player; finds next best audible alternative source, falls back to hideVideo. |
| `_activateSource(width, height, browsingContext)` → void | Stops previous tick, activates new one, sets canvas aspect ratio. Updates tab-active state for visibility decisions. |
| `hideVideo()` → void | Clears active source, stops streaming, clears canvas. Called on playback end or when no remaining sources exist. |

### Active-source selection strategy (current)

1. Check `MediaControlService.getActiveMediaController().browsingContext.id` — this represents whichever tab's video is currently playing (via the native media controller).
2. Look up that BC in `availableSources`; verify it isn't muted (`tab.linkedBrowser.muted`).
3. If the active controller is muted, fallback to any other available non-muted source from the Map.
4. Tab mute/unmute fires `TabAttrModified` on `gBrowser.tabContainer`, which triggers re-add or removal of sources accordingly.

## UI & visibility management (`main.uc.js`) – CSS-driven approach

### DOM structure in sidebar:
```
#navigator-toolbox (the sidebar chrome element)
  └─ #zsp-wrap  (<div>)           ← grid animation wrapper
       └─ #zsp-inner  (<div>)     ← overflow:hidden border-radius container
            └─ #zsp-canvas         ← the actual canvas rendering frames
  ── (sibling) ──
  #zen-media-controls-toolbar      ← media player controls
```

### Visibility logic — `updateVisibility()`

The preview is shown when all conditions hold:
- `isStreaming` === true (a source has been activated and tick loop running)
- `sourceTabActive` === false (user navigated away from the video's tab)
- `mediaPlayerVisible()` === true (`#zen-media-controls-toolbar` not hidden/display:none AND visible in DOM tree)

### Grid animation technique

Uses CSS grid template-rows animation instead of opacity/transform:
```css
.zsp-animate-in { display: grid; grid-template-rows: 0fr; transition: ... }
.zsp-open       { grid-template-rows: 1fr; margin: 0 6px }
:not(:hover, [zen-expanded], [zen-has-hover]) .zsp-open { grid-template-rows: 0fr }
```
This makes the element a true DOM child that respects clip-path transitions in both native compact mode and StormAnon's expand-on-hover extension — no fixed positioning needed.

### Collapse detection

Three signals watched via MutationObserver on `#navigator-toolbox`:
1. `[zen-expanded="true"]` attribute (native compact)
2. `:hover` pseudo-class (mouse enters sidebar)
3. `[zen-has-hover]` attribute (StormAnon mod indicator)
4. `mouseenter` / `mouseleave` events with delayed cleanup — after animation completes, the wrapper resets to `display: none` if still collapsed.

### Player hover margin

When hovering the media player controls, they expand upward. The wrap adds a `.zsp-player-hover` class that sets `margin-bottom: 70px` to prevent visual overlap between preview and expanded controls. Observed via MutationObserver on `#zen-media-controls-toolbar` attributes + parent child list changes, plus toolbox attribute/event listeners for sidebar state transitions.

## Known behaviors / design decisions

- **No silent video filtering per-tab**: All muted tabs are ignored globally during active-source selection. A video resuming after pause/seek doesn't trigger unless audible again (enforced in `handleEvent`).
- **Frame held through seeks**: `_captureFrame` does NOT skip frames when `video.seeking`. Frames stall on the last captured frame rather than "buffering" flicker — preferred for music videos where visual is secondary.
- **OffscreenCanvas fallback to document canvas**: If `OffscreenCanvas` isn't available in the content process, falls back to a regular `<canvas>` created via `document.createElement("canvas")`. This avoids IPC issues with certain canvases (e.g., Spotify embeds).
- **Actor `allFrames: true` + moz-system-group capture**: Handles media elements in `<iframe>`s and across frame hierarchy. Events bubble from all frames to the top-level actor parent.
- **Canvas context loss handling** (`content-actor.js`) The sidebar canvas fires `contextlost` events during heavy GPU workloads or tab suspension; a placeholder clears via try/catch but resizes only if explicitly resized — no re-initialization of GL state at present due to Firefox 142+ eSR (extra sandboxed renderer) limitations.

## Current state of rendering pipeline

- OffscreenCanvas capture ✅
- Transferable buffer IPC ✅
- Canvas putImageData draw with correct dimensions ✅
- Context loss listener registered ✅
- Re-initialization on contextlost ❌ not implemented — canvas just clears and re-draws as frames resume

---

*Document last updated: 2026-07-23*
