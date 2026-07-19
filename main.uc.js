// ==UserScript==
// @name           Zen Media Preview
// @version        1.0.0
// @description    Minimal inline video preview docked above the sidebar media controls. Compatible with sidebar-expand-on-hover out of the box because the preview is a real DOM child of the sidebar (no position:fixed, no manual position tracking).
// ==/UserScript==

(function () {
  if (window.__zenMediaPreviewLoaded) return;
  window.__zenMediaPreviewLoaded = true;

  const MOD_ID = "ZenMediaPreview";
  const RES_KEY = "zen-media-preview";
  const ACTOR_NAME = "ZenMediaPreview";
  const ANIM_MS = 200;

  const log = (...a) => console.log("[ZenMediaPreview]", ...a);
  const err = (...a) => console.error("[ZenMediaPreview]", ...a);
  const safe = (fn) => {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  };

  const MUSIC_PLAYER_SELECTORS =
    "#zen-media-controls-toolbar, .zen-sidebar-bottom-buttons";

  const musicPlayerUI = document.querySelector(MUSIC_PLAYER_SELECTORS);
  if (!musicPlayerUI || !musicPlayerUI.parentNode) {
    err("Could not find the media controls toolbar.");
    return;
  }

  // --- DOM ---------------------------------------------------------------
  // The preview lives as a normal sibling right before the media controls,
  // inside the sidebar's own DOM subtree. Because it's a real descendant of
  // #navigator-toolbox, it automatically respects that element's clip-path
  // (used by mods like sidebar-expand-on-hover to visually collapse the
  // sidebar) — no fixed positioning, no per-frame coordinate math, no
  // compat hacks needed.
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    #zsp-wrap {
      display: grid;
      grid-template-rows: 0fr;
      transition: grid-template-rows ${ANIM_MS}ms ease;
      margin: 0 6px;
    }
    #zsp-wrap.zsp-open {
      grid-template-rows: 1fr;
      position: relative;
      z-index: 2;
    }
    #zsp-wrap.zsp-open.zsp-player-hover {
      margin-bottom: 70px;
    }
    #zsp-inner {
      overflow: hidden;
      min-height: 0;
      border-radius: var(--zen-border-radius, 8px);
      background: var(--lwt-accent-color-inactive, var(--toolbar-bgcolor, #1c1c1c));
    }
    #zsp-canvas {
      display: block;
      width: 100%;
      aspect-ratio: var(--zsp-aspect, 16 / 9);
      background: transparent;
    }
    #zen-media-controls-toolbar {
      position: relative;
      z-index: 1;
    }
  `;
  document.documentElement.appendChild(styleEl);

  const wrap = document.createElement("div");
  wrap.id = "zsp-wrap";
  const inner = document.createElement("div");
  inner.id = "zsp-inner";
  const canvas = document.createElement("canvas");
  canvas.id = "zsp-canvas";
  const canvasCtx = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });
  inner.appendChild(canvas);
  wrap.appendChild(inner);
  musicPlayerUI.parentNode.insertBefore(wrap, musicPlayerUI);

  // When hovering the media player it expands upward — push the preview up
  // to prevent overlap.
  musicPlayerUI.addEventListener("mouseenter", () => wrap.classList.add("zsp-player-hover"));
  musicPlayerUI.addEventListener("mouseleave", () => wrap.classList.remove("zsp-player-hover"));

  // --- sidebar expand-state detection (works with any expand-on-hover mod) ---
  // StormAnon / compact mode toggle tab-label opacity between 0 and 1.
  // Checking computed opacity is more reliable than measuring widths or
  // reading attributes because it reflects the real rendered state.
  let sidebarExpanded = true;
  let sidebarPollRaf = null;

  function updateSidebarState() {
    const tb = document.getElementById("navigator-toolbox");
    if (!tb) { sidebarExpanded = true; return; }
    let expanded = true;
    // 1. Native zen-expanded attribute
    if (tb.getAttribute("zen-expanded") === "true") { expanded = true; }
    // 2. Tab‑label opacity (works with StormAnon & native compact mode)
    else {
      try {
        const label = tb.querySelector(".tab-label-container");
        if (label) {
          expanded = parseFloat(getComputedStyle(label).opacity) > 0.1;
        } else {
          // Fallback: media‑player width
          const mu = document.querySelector(MUSIC_PLAYER_SELECTORS);
          if (mu && mu.isConnected) {
            expanded = mu.getBoundingClientRect().width > 60;
          }
        }
      } catch (_) { expanded = true; }
    }
    if (sidebarExpanded !== expanded) {
      sidebarExpanded = expanded;
      updateVisibility();
    }
  }

  function pollSidebarState() {
    if (!isStreaming) { sidebarPollRaf = null; return; }
    updateSidebarState();
    sidebarPollRaf = requestAnimationFrame(pollSidebarState);
  }

  updateSidebarState();

  // --- state ---------------------------------------------------------------
  let isStreaming = false;
  let sourceTabActive = false;
  let sourceBC = null;
  const availableSources = new Map();
  const actorRegistry = new Map();

  function setAspect(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    wrap.style.setProperty("--zsp-aspect", `${w} / ${h}`);
  }

  function updateVisibility() {
    const shouldShow = isStreaming && !sourceTabActive && sidebarExpanded;
    wrap.classList.toggle("zsp-open", shouldShow);
  }

  // Minimal controller surface expected by parent-actor.js (unchanged from
  // Zenslop — the capture/transport pipeline doesn't care where drawFrame()
  // ends up painting).
  window.ZenPiPController = {
    getActiveBC() {
      return sourceBC;
    },
    drawFrame({ buf, width, height }) {
      try {
        setAspect(width, height);
        const img = new ImageData(new Uint8ClampedArray(buf), width, height);
        canvasCtx.putImageData(img, 0, 0);
      } catch (e) {
        err("drawFrame error:", e?.name, e?.message);
      }
    },
    setSourceTabActive(active) {
      if (sourceTabActive === active) return;
      sourceTabActive = active;
      updateVisibility();
    },
    registerSource(id, callbacks) {
      if (!actorRegistry.has(id)) actorRegistry.set(id, callbacks);
    },
    unregisterSource(id) {
      actorRegistry.delete(id);
    },
    offerVideo(width, height, browsingContext) {
      const id = browsingContext.id;
      availableSources.set(id, { bc: browsingContext, width, height });
      this._activateSource(width, height, browsingContext);
    },
    notifySourceStopped(bc) {
      availableSources.delete(bc.id);
      if (sourceBC && sourceBC.id === bc.id) {
        sourceBC = null;
        isStreaming = false;
        updateVisibility();
        if (availableSources.size > 0) {
          const next = availableSources.values().next().value;
          this._activateSource(next.width, next.height, next.bc);
        }
      }
    },
    _activateSource(width, height, browsingContext) {
      availableSources.delete(browsingContext.id);
      log("showVideo", width, "x", height, "tab", browsingContext?.id);
      setAspect(width, height);
      sourceBC = browsingContext;
      try {
        sourceTabActive =
          gBrowser?.selectedBrowser?.browsingContext?.id === sourceBC.id;
      } catch (_) {
        sourceTabActive = false;
      }
      isStreaming = true;
      if (!sidebarPollRaf) sidebarPollRaf = requestAnimationFrame(pollSidebarState);
      const info = actorRegistry.get(browsingContext.id);
      if (info) info.startTick(info.win || window);
      updateVisibility();
    },
    hideVideo() {
      isStreaming = false;
      sourceBC = null;
      updateVisibility();
      safe(() => canvasCtx.clearRect(0, 0, canvas.width, canvas.height));
    },
  };

  // --- actor registration --------------------------------------------------
  // Same pattern as Zenslop: substitute a resource:// URI pointing at this
  // mod's own folder on disk, then register the JSWindowActor pair.
  try {
    const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const modDir = profileDir.clone();
    for (const seg of ["chrome", "sine-mods", MOD_ID]) modDir.append(seg);
    const modUri = Services.io.newFileURI(modDir);
    const resProto = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    if (!resProto.hasSubstitution(RES_KEY)) {
      resProto.setSubstitution(RES_KEY, modUri);
    }
    log("resource mapped to:", modUri.spec, "exists:", modDir.exists());

    ChromeUtils.registerWindowActor(ACTOR_NAME, {
      parent: { esModuleURI: `resource://${RES_KEY}/parent-actor.js` },
      child: {
        esModuleURI: `resource://${RES_KEY}/content-actor.js`,
        events: {
          playing: { capture: true, mozSystemGroup: true },
          pause: { capture: true, mozSystemGroup: true },
          volumechange: { capture: true, mozSystemGroup: true },
        },
      },
      messageManagerGroups: ["browsers"],
      allFrames: true,
    });
    log("Actor registered as", ACTOR_NAME);
  } catch (e) {
    err("Failed to register JSWindowActor:", e?.name, e?.message);
  }

  log("Zen Media Preview initialized.");
})();
