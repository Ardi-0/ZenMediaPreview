# Releases

This file tracks Zen Media Preview releases with changelog details.

---

## Release History


---

### v1.1.0 – Initial Stable Release (2026-07-23)

**What's new:**

- Live video preview rendered in sidebar, docked above media controls
- Zero-config: installs and automatically mirrors any playing `<video>` with sound
- Smart visibility: preview only shown when sidebar is expanded/hovered and media controls are visible
- Compatible with native compact mode and StormAnon's sidebar-expand-on-hover extension
- Frame capture via JSWindowActor IPC – zero-copy RGBA transferables from content to chrome process
- Configurable quality (240p–1080p) and framerate (10fps–30fps) via `about:config`
- MediaControlService-synced: preview follows whichever tab's video is the active media controller
- Tab mute/unmute handling with source re-registration on unmute and audible fallback
- CSS grid animation for smooth sidebar collapse/expand transitions without fixed positioning

**Status:** Ready to push.


---

## How to Create a New Release

1. Update `theme.json` version field
2. Append a release block above "NEXT RELEASE BLOCK" in this file
3. Add an entry in MEMORY.md session notes
4. Commit changes:
   ```bash
   git add .
   git commit -m "bump: v<version>"
   git tag -a "v<version>" -m "<release-title> v<version>"
   git push origin main --tags
   ```
5. Create GitHub Release with this file block as the release body

