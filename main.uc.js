// ==UserScript==
// @name           Zen Media Preview
// @version        1.0.0
// @description    Live video preview in the sidebar, docked above media controls. Compatible with sidebar-expand-on-hover and compact mode.
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

  // Register default preferences (visible in about:config / sin mod settings)
  try {
    const branch = Services.prefs.getDefaultBranch("mod.zenmediapreview.");
    branch.setStringPref("quality", "480");
    branch.setIntPref("framerate", 20);
  } catch (_) {}

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
      display: none;
    }
    #zsp-wrap.zsp-animate-in {
      display: grid;
      grid-template-rows: 0fr;
      transition: grid-template-rows ${ANIM_MS}ms ease, margin ${ANIM_MS}ms ease;
      margin: 0;
    }
    #zsp-wrap.zsp-open {
      grid-template-rows: 1fr;
      position: relative;
      z-index: 2;
    }
    #zsp-wrap.zsp-open:not(.zsp-player-hover) {
      margin: 0 6px;
    }
    #zsp-wrap.zsp-open.zsp-player-hover {
      margin: 0 6px 70px;
    }
    /* Hide preview when sidebar is collapsed (native compact + StormAnon mod) */
    #navigator-toolbox:not(:is(:hover, [zen-expanded="true"], [zen-has-hover])) #zsp-wrap.zsp-open {
      grid-template-rows: 0fr;
      margin: 0;
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

  // Re-check visibility whenever the media player's hidden/display state changes.
  const mpObserver = new MutationObserver(() => updateVisibility());
  mpObserver.observe(musicPlayerUI, { attributes: true, attributeFilter: ["hidden", "style"] });
  // Also watch the parent for the player being added/removed.
  if (musicPlayerUI.parentNode) {
    new MutationObserver(() => updateVisibility()).observe(musicPlayerUI.parentNode, {
      childList: true,
      subtree: false,
    });
  }
  // Re-check visibility on sidebar expand/collapse (compact mode + StormAnon)
  const toolbox = document.querySelector("#navigator-toolbox");
  if (toolbox) {
    const tbObserver = new MutationObserver(() => updateVisibility());
    tbObserver.observe(toolbox, { attributes: true, attributeFilter: ["zen-expanded", "zen-has-hover"] });
    toolbox.addEventListener("mouseenter", () => updateVisibility());
    toolbox.addEventListener("mouseleave", () => {
      clearTimeout(_collapseCleanupTimer);
      _collapseCleanupTimer = setTimeout(() => {
        if (isSidebarCollapsed() && wrap.classList.contains("zsp-open")) {
          wrap.classList.remove("zsp-open");
          wrap.classList.remove("zsp-animate-in");
        }
      }, ANIM_MS + 50);
      updateVisibility();
    });
  }

  // Clean up after collapse animation completes
  wrap.addEventListener("transitionend", (e) => {
    if (e.propertyName !== "grid-template-rows") return;
    clearTimeout(_collapseCleanupTimer);
    if (isSidebarCollapsed() && wrap.classList.contains("zsp-open")) {
      wrap.classList.remove("zsp-open");
      wrap.classList.remove("zsp-animate-in");
    }
  });

  // --- state ---------------------------------------------------------------
  let isStreaming = false;
  let sourceTabActive = false;
  let sourceBC = null;
  let _collapseCleanupTimer = null;
  const availableSources = new Map();
  const actorRegistry = new Map();

  function setAspect(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    wrap.style.setProperty("--zsp-aspect", `${w} / ${h}`);
  }

  function mediaPlayerVisible() {
    try {
      const mu = document.querySelector(MUSIC_PLAYER_SELECTORS);
      if (!mu || !mu.isConnected) return false;
      if (mu.hidden || mu.hasAttribute("hidden")) return false;
      return getComputedStyle(mu).display !== "none";
    } catch (_) { return true; }
  }

  function isSidebarCollapsed() {
    const tb = document.querySelector("#navigator-toolbox");
    return tb && !tb.matches(":hover, [zen-expanded='true'], [zen-has-hover]");
  }

  function isTabFocused(bc) {
    try {
      return gBrowser?.selectedBrowser?.browsingContext?.id === bc.id;
    } catch (_) {
      return false;
    }
  }

  // Sync preview with the active media controller (what the media player shows)
  try {
    const MEDIA_CTRL_TOPIC = "media-controller-changed";
    Services.obs.addObserver({
      observe(subject, topic) {
        if (topic !== MEDIA_CTRL_TOPIC) return;
        try {
          const controller = subject.getActiveMediaController();
          if (!controller) return;
          const bcId = controller.browsingContext?.id;
          if (!bcId) return;
          if (sourceBC && sourceBC.id === bcId) return;
          const src = availableSources.get(bcId);
          if (src) {
            window.ZenPiPController._activateSource(src.width, src.height, src.bc);
          }
        } catch (_) {}
      }
    }, MEDIA_CTRL_TOPIC);
  } catch (_) {}

  function updateVisibility() {
    const shouldShow = isStreaming && !sourceTabActive && mediaPlayerVisible();
    const isOpen = wrap.classList.contains("zsp-open");

    if (shouldShow && !isOpen) {
      wrap.classList.add("zsp-animate-in");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (isStreaming && !sourceTabActive && mediaPlayerVisible()) {
            wrap.classList.add("zsp-open");
          } else {
            wrap.classList.remove("zsp-animate-in");
          }
        });
      });
    } else if (!shouldShow && isOpen) {
      wrap.classList.remove("zsp-open");
      clearTimeout(_collapseCleanupTimer);
      setTimeout(() => {
        if (!wrap.classList.contains("zsp-open")) {
          wrap.classList.remove("zsp-animate-in");
        }
      }, ANIM_MS);
    }
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
      // Only auto-activate if no current source, or this video is in the focused tab
      if (!sourceBC || isTabFocused(browsingContext)) {
        this._activateSource(width, height, browsingContext);
      }
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
      log("showVideo", width, "x", height, "tab", browsingContext?.id);
      setAspect(width, height);
      // Stop previous source's tick to save CPU/IPC
      if (sourceBC && sourceBC.id !== browsingContext.id) {
        const prevInfo = actorRegistry.get(sourceBC.id);
        if (prevInfo) prevInfo.stopTick();
      }
      sourceBC = browsingContext;
      try {
        sourceTabActive =
          gBrowser?.selectedBrowser?.browsingContext?.id === sourceBC.id;
      } catch (_) {
        sourceTabActive = false;
      }
      isStreaming = true;
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
