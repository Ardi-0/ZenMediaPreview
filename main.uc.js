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
    branch.setBoolPref("hide-on-collapse", true);
  } catch (_) {}

  // Toggle zsp-hide-on-collapse class based on pref
  function applyCollapsePref() {
    try {
      if (Services.prefs.getBoolPref("mod.zenmediapreview.hide-on-collapse", true)) {
        document.documentElement.classList.add("zsp-hide-on-collapse");
      } else {
        document.documentElement.classList.remove("zsp-hide-on-collapse");
      }
    } catch (_) {
      document.documentElement.classList.add("zsp-hide-on-collapse");
    }
  }
  applyCollapsePref();
  try {
    Services.prefs.addObserver("mod.zenmediapreview.hide-on-collapse", () => applyCollapsePref());
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
      margin: calc(-45px + var(--zsp-mt, 0px)) 6px;
    }
    #zsp-wrap.zsp-open {
      grid-template-rows: 1fr;
      position: relative;
      z-index: 2;
    }
    #zsp-wrap.zsp-open:not(.zsp-player-hover) {
      margin: calc(-45px + var(--zsp-mt, 0px)) 6px calc(-10px + var(--zsp-mb, 0px));
    }
    #zsp-wrap.zsp-open.zsp-player-hover {
      margin: calc(-45px + var(--zsp-mt, 0px)) 6px calc(70px + var(--zsp-ho, 0px));
    }
    #zsp-wrap[hidden] {
      display: none !important;
    }
    /* Hide preview when sidebar is collapsed — only if pref is enabled */
    html.zsp-hide-on-collapse #navigator-toolbox:not(:is(:hover, [zen-expanded="true"], [zen-has-hover])) #zsp-wrap.zsp-open {
      grid-template-rows: 0fr;
      margin: calc(-45px + var(--zsp-mt, 0px)) 6px 0;
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
    #zsp-toggle {
      list-style-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round'><rect x='2' y='2' width='20' height='20' rx='2.18'/><path d='M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z'/></svg>");
    }
    #zsp-toggle[state="hidden"] {
      list-style-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round'><rect x='2' y='2' width='20' height='20' rx='2.18'/><path d='M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z'/><line x1='1' y1='1' x2='23' y2='23'/></svg>");
    }
  `;
  document.documentElement.appendChild(styleEl);

  const wrap = document.createElement("div");
  wrap.id = "zsp-wrap";
  const inner = document.createElement("div");
  inner.id = "zsp-inner";
  const canvas = document.createElement("canvas");
  canvas.id = "zsp-canvas";
  let canvasCtx = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });
  canvas.addEventListener("contextlost", (e) => {
    e.preventDefault();
    log("Canvas context lost, waiting for restore...");
  });
  canvas.addEventListener("contextrestored", () => {
    log("Canvas context restored");
    canvasCtx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  });
  inner.appendChild(canvas);
  wrap.appendChild(inner);
  musicPlayerUI.parentNode.insertBefore(wrap, musicPlayerUI);

  // Apply user preferences directly as CSS custom properties.
  // The CSS fallback IS the default. Pref value replaces it.
  const MARGIN_PREFS = ["mod.zenmediapreview.margin-top", "mod.zenmediapreview.margin-bottom", "mod.zenmediapreview.player-hover-offset"];
  function getMarginPref(name, defaultVal) {
    try {
      const v = parseInt(Services.prefs.getStringPref("mod.zenmediapreview." + name, String(defaultVal)), 10);
      return isNaN(v) ? defaultVal : v;
    } catch (_) { return defaultVal; }
  }
  function applyMarginPrefs() {
    const mt = getMarginPref("margin-top", 0);
    const mb = getMarginPref("margin-bottom", 0);
    const ho = getMarginPref("player-hover-offset", 0);
    wrap.style.setProperty("--zsp-mt", mt + "px");
    wrap.style.setProperty("--zsp-mb", mb + "px");
    wrap.style.setProperty("--zsp-ho", ho + "px");
    musicPlayerUI.style.marginTop = "0";
  }
  applyMarginPrefs();
  try { setInterval(applyMarginPrefs, 2000); } catch (_) {}

  // Toggle button: both on preview panel and in media player toolbar
  // --- toolbar button ---
  (function addToolbarBtn() {
    const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    const btn = document.createElementNS(XUL_NS, "toolbarbutton");
    btn.id = "zsp-toggle";
    btn.setAttribute("tooltiptext", "Show/Hide Video Preview");
    btn.setAttribute("class", "toolbarbutton-1 chromeclass-toolbar-additional");
    btn.addEventListener("click", () => {
      const hidden = wrap.hasAttribute("hidden");
      if (hidden) {
        wrap.removeAttribute("hidden");
        btn.removeAttribute("state");
      } else {
        wrap.setAttribute("hidden", "");
        btn.setAttribute("state", "hidden");
      }
      updateVisibility();
    });
    // Insert inside the media buttons row, after the PiP button
    const pipBtn = document.querySelector("#zen-media-pip-button");
    const target = document.querySelector("#zen-media-buttons-hbox");
    if (target) {
      if (pipBtn) {
        pipBtn.parentNode.insertBefore(btn, pipBtn.nextSibling);
      } else {
        target.appendChild(btn);
      }
    }
  })();

  // Update sourceTabActive when user switches tabs
  gBrowser.tabContainer.addEventListener("TabSelect", () => {
    if (sourceBC) {
      try {
        const newActive = gBrowser.selectedBrowser?.browsingContext?.id === (sourceBC.top?.id || sourceBC.id);
        if (newActive !== sourceTabActive) {
          sourceTabActive = newActive;
          updateVisibility();
        }
      } catch (_) {}
    }
  });

  // When hovering the media player it expands upward — push the preview up
  // to prevent overlap.
  musicPlayerUI.addEventListener("mouseenter", () => wrap.classList.add("zsp-player-hover"));
  musicPlayerUI.addEventListener("mouseleave", () => wrap.classList.remove("zsp-player-hover"));

  // Click on the preview toggles play/pause of the source video.
  wrap.addEventListener("click", () => {
    if (!sourceBC) return;
    try {
      const info = actorRegistry.get(sourceBC.id);
      if (info && info.actor) info.actor.sendAsyncMessage("ZenPiP:TogglePlay", {});
    } catch (_) {}
  });

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
  let _visibilityPending = false;
  const availableSources = new Map();
  const actorRegistry = new Map();
  const sourceMeta = new Map();

  let _dpr = window.devicePixelRatio || 1;
  let _offCanvas = null;
  let _offCtx = null;
  function resizeCanvasToDisplaySize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * _dpr));
    const h = Math.max(1, Math.round(rect.height * _dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  const canvasResizeObserver = new ResizeObserver(() => resizeCanvasToDisplaySize());
  canvasResizeObserver.observe(canvas);
  window.addEventListener("resize", () => {
    const newDpr = window.devicePixelRatio || 1;
    if (newDpr !== _dpr) {
      _dpr = newDpr;
      resizeCanvasToDisplaySize();
    }
  });
  resizeCanvasToDisplaySize();

  function setAspect(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    wrap.style.setProperty("--zsp-aspect", `${w} / ${h}`);
    requestAnimationFrame(() => resizeCanvasToDisplaySize());
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
    try {
      if (!Services.prefs.getBoolPref("mod.zenmediapreview.hide-on-collapse", true)) return false;
    } catch (_) {}
    const tb = document.querySelector("#navigator-toolbox");
    return tb && !tb.matches(":hover, [zen-expanded='true'], [zen-has-hover]");
  }

  function getActiveMediaBC() {
    try {
      const service = Cc["@mozilla.org/media/mediacontrolservice;1"].getService();
      const controller = service.getActiveMediaController();
      return controller?.browsingContext?.id || null;
    } catch (_) { return null; }
  }

  function setMediaPlayerVisible(visible) {
    const mu = document.querySelector(MUSIC_PLAYER_SELECTORS);
    if (!mu) return;
    if (visible) {
      mu.style.removeProperty("display");
    } else {
      mu.style.display = "none";
    }
  }

  function isTabMuted(bcId) {
    try {
      for (const tab of gBrowser.tabs) {
        const bc = tab.linkedBrowser?.browsingContext;
        if (bc && bc.id === bcId) return tab.linkedBrowser.muted;
      }
    } catch (_) {}
    return false;
  }

  function findAudible() {
    const activeId = getActiveMediaBC();
    if (activeId && availableSources.has(activeId) && !isTabMuted(activeId))
      return availableSources.get(activeId);
    for (const [id, src] of availableSources)
      if (!isTabMuted(id)) return src;
    return null;
  }

  // Sync preview with the active media controller
  // Hide the media player when the active controller tab is muted
  try {
    const MEDIA_CTRL_TOPIC = "media-controller-changed";
    Services.obs.addObserver({
      observe(subject, topic) {
        if (topic !== MEDIA_CTRL_TOPIC) return;
        try {
          const bcId = getActiveMediaBC();
          if (!bcId) {
            if (sourceBC) return; // paused, keep the last frame visible
            return;
          }
          if (sourceBC && sourceBC.id === bcId) return;
          if (isTabMuted(bcId)) {
            setMediaPlayerVisible(false);
            const alt = findAudible();
            if (alt && alt.bc.id !== bcId) {
              window.ZenPiPController._activateSource(alt.width, alt.height, alt.bc);
            } else if (sourceBC || isStreaming) {
              sourceBC = null;
              isStreaming = false;
              updateVisibility();
              safe(() => canvasCtx.clearRect(0, 0, canvas.width, canvas.height));
            }
            return;
          }
          setMediaPlayerVisible(true);
          const src = availableSources.get(bcId);
          if (src) {
            window.ZenPiPController._activateSource(src.width, src.height, src.bc);
          } else {
            sourceBC = null;
            isStreaming = false;
            updateVisibility();
            safe(() => canvasCtx.clearRect(0, 0, canvas.width, canvas.height));
          }
        } catch (_) {}
      }
    }, MEDIA_CTRL_TOPIC);
  } catch (e) {
    err("MediaControlService observer failed:", e);
  }

  // Handle tab mute/unmute (tab-level mute doesn't fire volumechange on the video element)
  try {
    gBrowser.tabContainer.addEventListener("TabAttrModified", (e) => {
      const changed = e.detail?.changed;
      if (!changed || !changed.includes("muted")) return;
      const browser = e.target.linkedBrowser;
      if (!browser) return;
      const bcId = browser.browsingContext?.id;
      if (!bcId) return;

      if (browser.muted) {
        const src = availableSources.get(bcId);
        if (!src) return;
        log("tab muted, stopping source", bcId);
        const info = actorRegistry.get(bcId);
        if (info) info.stopTick();
        availableSources.delete(bcId);
        if (bcId === getActiveMediaBC()) {
          setMediaPlayerVisible(false);
        }
        if (sourceBC && sourceBC.id === bcId) {
          sourceBC = null;
          isStreaming = false;
          const alt = findAudible();
          if (alt) {
            window.ZenPiPController._activateSource(alt.width, alt.height, alt.bc);
          } else {
            updateVisibility();
            safe(() => canvasCtx.clearRect(0, 0, canvas.width, canvas.height));
          }
        }
      } else {
        if (bcId === getActiveMediaBC()) {
          setMediaPlayerVisible(true);
        }
        if (actorRegistry.has(bcId) && !availableSources.has(bcId)) {
          const meta = sourceMeta.get(bcId);
          if (meta) {
            log("tab unmuted, re-adding source", bcId);
            const bc = browser.browsingContext;
            availableSources.set(bcId, { bc, width: meta.width, height: meta.height });
            const info = actorRegistry.get(bcId);
            if (info) info.startTick(info.win || window);
            if (!sourceBC || (bcId === getActiveMediaBC() && sourceBC.id !== bcId)) {
              window.ZenPiPController._activateSource(meta.width, meta.height, bc);
            }
          }
        }
      }
    });
  } catch (_) {}

  function updateVisibility() {
    if (_visibilityPending) return;
    _visibilityPending = true;
    requestAnimationFrame(() => {
      _visibilityPending = false;
      applyMarginPrefs();
      const userHidden = wrap.hasAttribute("hidden");
      const shouldShow = !userHidden && isStreaming && !sourceTabActive && mediaPlayerVisible();
      const isOpen = wrap.classList.contains("zsp-open");

      if (shouldShow && !isOpen) {
        wrap.classList.add("zsp-animate-in");
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!userHidden && isStreaming && !sourceTabActive && mediaPlayerVisible()) {
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
    });
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
        resizeCanvasToDisplaySize();
        if (!_offCanvas || _offCanvas.width !== width || _offCanvas.height !== height) {
          _offCanvas = document.createElement("canvas");
          _offCanvas.width = width;
          _offCanvas.height = height;
          _offCtx = _offCanvas.getContext("2d", { alpha: false });
        }
        const img = new ImageData(new Uint8ClampedArray(buf), width, height);
        _offCtx.putImageData(img, 0, 0);
        canvasCtx.drawImage(_offCanvas, 0, 0, canvas.width, canvas.height);
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
      sourceMeta.set(id, { width, height });
      availableSources.set(id, { bc: browsingContext, width, height });
      // If this source is the active media controller, show the media player
      if (id === getActiveMediaBC()) {
        setMediaPlayerVisible(true);
      }
      // Only auto-activate if no current source, or this IS the active media session
      if (!sourceBC || id === getActiveMediaBC()) {
        this._activateSource(width, height, browsingContext);
      }
    },
    notifySourceStopped(bc) {
      sourceMeta.delete(bc.id);
      availableSources.delete(bc.id);
      if (bc.id === getActiveMediaBC()) {
        setMediaPlayerVisible(false);
      }
      if (sourceBC && sourceBC.id === bc.id) {
        sourceBC = null;
        isStreaming = false;
        const alt = findAudible();
        if (alt) {
          window.ZenPiPController._activateSource(alt.width, alt.height, alt.bc);
        } else {
          updateVisibility();
          safe(() => canvasCtx.clearRect(0, 0, canvas.width, canvas.height));
        }
      }
    },
    _activateSource(width, height, browsingContext) {
      log("showVideo", width, "x", height, "tab", browsingContext?.id);
      safe(() => canvasCtx.clearRect(0, 0, canvas.width, canvas.height));
      setAspect(width, height);
      // Stop previous source's tick to save CPU/IPC
      if (sourceBC && sourceBC.id !== browsingContext.id) {
        const prevInfo = actorRegistry.get(sourceBC.id);
        if (prevInfo) prevInfo.stopTick();
      }
      sourceBC = browsingContext;
      try {
        sourceTabActive =
          gBrowser?.selectedBrowser?.browsingContext?.id === (sourceBC.top?.id || sourceBC.id);
      } catch (_) {
        sourceTabActive = false;
      }
      isStreaming = true;
      const info = actorRegistry.get(browsingContext.id);
      if (info) {
        info.startTick(info.win || window);
      } else {
        log("_activateSource: no actor registered for", browsingContext.id, "– preview won't stream");
        isStreaming = false;
      }
      applyMarginPrefs();
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
          waiting: { capture: true, mozSystemGroup: true },
          seeking: { capture: true, mozSystemGroup: true },
          seeked: { capture: true, mozSystemGroup: true },
          canplay: { capture: true, mozSystemGroup: true },
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
