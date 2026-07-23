# Zen Media Preview

A live video preview inside Zen Browser's sidebar, docked above the media controls.

![](https://img.shields.io/badge/Zen%20Browser-1.0%2B-blue)

## Features

- **Live preview** – mirrors any playing `<video>` element into the sidebar
- **Zero-config** – just install and play a video with sound
- **Expand-on-hover compatible** – works with [StormAnon's sidebar-expand-on-hover](https://github.com/StormAnon/zen-sidebar-expand-on-hover) and Zen's native compact mode
- **Smart visibility** – preview only shows when the sidebar is hovered/expanded **and** the sidebar media controls are visible
- **No `position: fixed`** – the preview is a real DOM child of the sidebar, so it respects clip‑path transitions, hover zones, and auto‑expand animations out of the box

## How it works

```
┌─────────────────────────────────┐
│  Sidebar (navigator-toolbox)    │
│  ┌───────────────────────────┐  │
│  │  Tabs                     │  │
│  ├───────────────────────────┤  │
│  │  🎬 Video Preview         │  │ ← inserted before media controls
│  ├───────────────────────────┤  │
│  │  Media Controls (player)  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

Two **JSWindowActors** capture frames from any audible `<video>` in any tab and ship them (as zero‑copy RGBA buffers) to a `<canvas>` in the sidebar.

## Installation

### Via Sine Mod Manager

1. Open Sine in Zen Browser
2. Add this repo URL:  
   `https://github.com/Ardi-0/ZenMediaPreview`
3. Install and restart

### Manual

1. Navigate to your profile's `chrome` folder:  
   `about:support` → *Profile Folder* → open → `chrome`
2. Create `sine-mods/ZenMediaPreview/` inside `chrome`
3. Copy all files from this repo into that folder
4. Restart Zen

## Requirements

- Zen Browser (Firefox fork with vertical tabs)
- A tab playing a **non‑muted** video (muted videos are ignored to avoid flashing)

## Preferences

| Preference | Default | Description |
|---|---|---|
| `mod.zenmediapreview.quality` | `480` | Max frame dimension (px) sent to the canvas |

Set in `about:config`.

## Compatibility

| Mod / Mode | Status |
|---|---|
| Native compact mode | ✅ |
| [StormAnon sidebar-expand-on-hover](https://github.com/StormAnon/zen-sidebar-expand-on-hover) | ✅ |
| Picture-in-Picture (PiP) | ✅ preview hides when PiP is active |
| Right‑sided sidebar | ✅ |
