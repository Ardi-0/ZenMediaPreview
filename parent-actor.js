const DEBUG = false;
const dlog = DEBUG ? (...a) => console.log(...a) : () => {};

export class ZenMediaPreviewParent extends JSWindowActorParent {
  _initPlayStates() {
    if (!this._playStates) {
      this._playStates = new Map();
    }
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Debug") {
      if (DEBUG) {
        const argsArr = Array.isArray(msg.data?.args) ? msg.data.args : null;
        if (argsArr && argsArr.length > 0) console.log(...argsArr);
      }
      return;
    }

    const win = this.browsingContext.topChromeWindow;
    if (!win) {
      console.error("[ZenMediaPreview/parent] No chrome window available");
      return;
    }

    switch (msg.name) {
      case "ZenPiP:MirrorStarted": {
        console.log("[ZenMediaPreview/parent] MirrorStarted from tab", this.browsingContext.id, msg.data.width, "x", msg.data.height);
        const controller = win.ZenPiPController;
        if (controller) {
          controller.registerSource(this.browsingContext.id, {
            startTick: (w) => { this._startTicking(w); },
            stopTick: () => { this._stopTicking(); },
            win,
            actor: this,
          });
          controller.offerVideo(msg.data.width, msg.data.height, this.browsingContext);
        }
        break;
      }

      case "ZenPiP:Frame": {
        const controller = win.ZenPiPController;
        if (!controller) return;

        const activeBC = typeof controller.getActiveBC === "function" ? controller.getActiveBC() : null;
        if (!activeBC || activeBC.id !== this.browsingContext.id) {
          return;
        }

        if (!this._tickInterval) {
          this._startTicking(win);
        }

        try {
          controller.drawFrame(msg.data);
        } catch (e) {
          console.error("[ZenMediaPreview/parent] drawFrame error:", e?.name, e?.message);
        }
        break;
      }

      case "ZenPiP:PlayState": {
        this._initPlayStates();
        const bcId = this.browsingContext.id;
        this._playStates.set(bcId, !!msg.data?.playing);
        dlog("[ZenMediaPreview/parent] PlayState", bcId, "=", msg.data?.playing);
        break;
      }

      case "ZenPiP:SourceVisibility": {
        const controller = win.ZenPiPController;
        if (!controller) break;
        const activeBC = typeof controller.getActiveBC === "function" ? controller.getActiveBC() : null;
        if (activeBC && activeBC.id === this.browsingContext.id) {
          controller.setSourceTabActive(!msg.data.hidden);
        }
        break;
      }

      case "ZenPiP:VideoStopped": {
        console.log("[ZenMediaPreview/parent] VideoStopped reason:", msg.data?.reason);
        const controller = win.ZenPiPController;
        if (controller) {
          controller.unregisterSource(this.browsingContext.id);
          controller.notifySourceStopped(this.browsingContext);
        }
        this._initPlayStates();
        this._playStates.delete(this.browsingContext.id);
        this._stopTicking();
        try {
          this.sendAsyncMessage("ZenPiP:Stop", {});
        } catch (_) {}
        break;
      }
    }
  }

  _isSourcePlaying(bcId) {
    this._initPlayStates();
    return this._playStates.get(bcId) !== false;
  }

  _startTicking(win) {
    this._stopTicking();
    this._timerWindow = win;
    let fps = 20;
    try {
      fps = Services.prefs.getIntPref("mod.zenmediapreview.framerate", 20);
    } catch (_) {}
    const baseInterval = Math.max(33, Math.round(1000 / fps));

    this._tickInterval = win.setInterval(() => {
      const bcId = this.browsingContext?.id;
      if (!bcId) return;

      // If the source isn't playing, use a slower effective rate by
      // skipping most ticks.
      if (!this._isSourcePlaying(bcId)) {
        this._skipCounter = (this._skipCounter || 0) + 1;
        if (this._skipCounter < 3) {
          return;
        }
        this._skipCounter = 0;
      }

      try {
        let quality = "480";
        try {
          quality = Services.prefs.getStringPref("mod.zenmediapreview.quality", "480");
        } catch (_) {}
        this.sendAsyncMessage("ZenPiP:Tick", { quality });
      } catch (e) {
        console.error("[ZenMediaPreview/parent] Tick error:", e?.name, e?.message);
      }
    }, baseInterval);

    dlog("[ZenMediaPreview/parent] Ticking started at", baseInterval, "ms interval");
  }

  _stopTicking() {
    if (this._tickInterval) {
      const win = this._timerWindow || this.browsingContext?.topChromeWindow;
      try {
        win?.clearInterval(this._tickInterval);
      } catch (_) {}
      this._tickInterval = null;
      this._timerWindow = null;
      this._skipCounter = 0;
    }
  }

  didDestroy() {
    this._stopTicking();
    try {
      this.sendAsyncMessage("ZenPiP:Stop", {});
    } catch (_) {}
    const win = this.browsingContext?.topChromeWindow;
    if (win && win.ZenPiPController) {
      win.ZenPiPController.unregisterSource(this.browsingContext.id);
      win.ZenPiPController.notifySourceStopped(this.browsingContext);
    }
  }
}
