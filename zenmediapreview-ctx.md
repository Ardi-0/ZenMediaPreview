# ZenMediaPreview – project context

## Architecture

3 files loaded inside `#navigator-toolbox` (Zen's sidebar).

### main.uc.js
Chrome script that:
- Creates `<canvas>` inside sidebar (above `#zen-media-controls-toolbar`)
- Registers resource:// substitution + JSWindowActor pair
- Exposes `window.ZenPiPController` for the parent actor
- CSS: `display:none` by default, `zsp-open` class to show
- Observes `#navigator-toolbox:hover` / `[zen-expanded]` / `[zen-has-hover]` via CSS to hide preview when sidebar collapsed
- Observes `#zen-media-controls-toolbar` hidden/style changes to hide preview when media player gone (PiP)

### content-actor.js (JSWindowActorChild)
- Listens for `playing`, `volumechange`, `pause` on `<video>` elements
- Only starts mirroring if video is **audible** (`!muted && volume > 0`)
- Draws video → OffscreenCanvas → `getImageData` → sends RGBA buffer via IPC
- Max frame dimension: 480px (configurable via `mod.zenmediapreview.quality`)

### parent-actor.js (JSWindowActorParent)
- Receives frames, forwards to `controller.drawFrame()`
- Manages 33ms tick interval to request frames from content

## Key behaviors

- Preview hidden when: sidebar collapsed, source tab active, media player hidden (PiP), or no streaming
- `zsp-open` CSS class toggled by `updateVisibility()`
- `zsp-player-hover` CSS class adds `margin-bottom: 70px` when hovering media player (prevents overlap)
- Muted videos are skipped (intentional – avoids flash when autoplay muted plays)
