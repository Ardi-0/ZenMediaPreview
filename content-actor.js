const MAX_FRAME_DIMENSION = 480;
const MAX_FRAMERATE = 30;

const DEBUG = false;

export class ZenMediaPreviewChild extends JSWindowActorChild {
  _debug(...args) {
    if (!DEBUG) return;
    try {
      console.log("[ZenMediaPreview/content]", ...args);
    } catch (_) {}
  }

  _encodeSize(w, h, maxDim = MAX_FRAME_DIMENSION) {
    const scale = Math.min(1, maxDim / Math.max(w, h));
    let tw = Math.max(2, Math.round(w * scale));
    let th = Math.max(2, Math.round(h * scale));
    tw -= tw % 2;
    th -= th % 2;
    return { tw, th };
  }

  handleEvent(event) {
    const target = event.target;
    this._debug(event.type, target?.tagName, "muted=", target?.muted, "vw=", target?.videoWidth);
    if (!target || target.tagName !== "VIDEO") return;

    if (event.type === "playing") {
      this._notifyPlaying(true);
      this._tryStart(target);
      return;
    }

    if (event.type === "waiting") {
      if (target === this._video) {
        this._notifyPlaying(false);
      }
      return;
    }

    if (event.type === "seeking") {
      if (target === this._video) {
        this._notifyPlaying(true);
        this._trySeekCapture();
        // Send the nearest cached thumbnail for scrubbing preview
        this._sendCachedFrame(target.currentTime);
      }
      return;
    }

    if (event.type === "seeked") {
      // Capture the frame at the new position. drawImage(video) works at
      // seeked because the seek is complete and frame is decoded.
      if (target === this._video) {
        // Use requestVideoFrameCallback to wait for the frame to actually
        // be presented – on seeked the promise resolves but drawImage may
        // still return the old frame.
        if (typeof target.requestVideoFrameCallback === "function") {
          target.requestVideoFrameCallback(() => {
            this._captureFrame(this._lastQuality);
          });
        } else {
          this._captureFrame(this._lastQuality);
          if (typeof this.contentWindow?.requestAnimationFrame === "function") {
            this.contentWindow.requestAnimationFrame(() => {
              this._captureFrame(this._lastQuality);
            });
          }
        }
        this._notifyPlaying(!target.paused && !target.ended);
      }
      return;
    }

    if (event.type === "canplay") {
      if (target === this._video) {
        this._notifyPlaying(true);
      }
      return;
    }

    if (event.type === "volumechange") {
      if (this._isAudible(target)) {
        if (!this._video && !target.paused && !target.ended) {
          this._tryStart(target);
        }
      } else if (target === this._video) {
        this._stopAndNotify("volumechange:muted");
      }
      return;
    }

    if (event.type === "pause" || event.type === "ended" || event.type === "emptied") {
      if (target !== this._video) return;
      this._notifyPlaying(false);
      // Don't stop mirror on pause — user may scrub and needs the preview.
      if (event.type !== "pause") {
        this._stopAndNotify("event:" + event.type);
      }
    }
  }

  _notifyPlaying(playing) {
    if (this._lastPlaying === playing) return;
    this._lastPlaying = playing;
    try {
      this.sendAsyncMessage("ZenPiP:PlayState", { playing });
    } catch (_) {}
  }

  _trySeekCapture() {
    this._captureFrame(this._lastQuality);
    if (!this._seekCaptureRAF) {
      this._seekCaptureRAF = this.contentWindow.requestAnimationFrame(() => {
        this._seekCaptureRAF = null;
        this._captureFrame(this._lastQuality);
      });
    }
  }

  // --- scrub cache ---------------------------------------------------------
  // Ring buffer of low-res thumbnails captured during playback. When the user
  // scrubs the timeline, the nearest cached frame is sent as a regular frame
  // so the preview updates at the scrub position.
  _initCache() {
    this._frameCache = [];
    this._lastCacheTime = 0;
    this._cacheCanvas = null;
    this._cacheCtx = null;
  }

  _cacheFrame(time) {
    const video = this._video;
    const win = this.contentWindow;
    if (!video || !win || video.readyState < 2 || video.seeking) return;
    const maxDim = 160;
    const { tw, th } = this._encodeSize(video.videoWidth, video.videoHeight, maxDim);
    if (!this._cacheCtx || !this._cacheCanvas ||
        this._cacheCanvas.width !== tw || this._cacheCanvas.height !== th) {
      if (typeof win.OffscreenCanvas === "function") {
        this._cacheCanvas = new win.OffscreenCanvas(tw, th);
      } else {
        this._cacheCanvas = win.document.createElement("canvas");
        this._cacheCanvas.width = tw;
        this._cacheCanvas.height = th;
      }
      this._cacheCtx = this._cacheCanvas.getContext("2d", { alpha: false });
    }
    try {
      this._cacheCtx.drawImage(video, 0, 0, tw, th);
      const img = this._cacheCtx.getImageData(0, 0, tw, th);
      this._frameCache.push({ time, buf: img.data.buffer, width: tw, height: th });
      if (this._frameCache.length > 200) this._frameCache.shift();
    } catch (_) {}
  }

  _sendCachedFrame(time) {
    if (this._frameCache.length === 0) return;
    let lo = 0, hi = this._frameCache.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._frameCache[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) {
      const dPrev = Math.abs(this._frameCache[lo - 1].time - time);
      const dCurr = Math.abs(this._frameCache[lo].time - time);
      if (dPrev <= dCurr) lo = lo - 1;
    }
    const entry = this._frameCache[lo];
    if (!entry) return;
    // Don't re-send the same frame
    if (entry.time === this._lastSentCacheTime) return;
    this._lastSentCacheTime = entry.time;
    try {
      this.sendAsyncMessage("ZenPiP:Frame", {
        buf: entry.buf.slice(0),
        width: entry.width,
        height: entry.height,
      });
    } catch (_) {}
  }

  _isAudible(video) {
    return !video.muted && video.volume > 0;
  }

  _tryStart(target) {
    this._debug("tryStart readyState=", target.readyState, "vw=", target.videoWidth, "audible=", this._isAudible(target), "hasVideo=", !!this._video);
    if (this._video) return;
    if (target.readyState < 2 || target.videoWidth === 0) return;
    if (!this._isAudible(target)) return;

    this._attachVideoListeners(target);
    this._startMirror(target);
  }

  _attachVideoListeners(video) {
    const onEnd = (e) => this._stopAndNotify("listener:" + e.type);
    video.addEventListener("ended", onEnd, { once: true });
    video.addEventListener("emptied", onEnd, { once: true });
    this._videoListeners = { onEnd };

    if (!this._pageHideBound) {
      this._pageHideBound = () => this._stopAndNotify("pagehide");
      this.contentWindow.addEventListener("pagehide", this._pageHideBound, {
        once: true,
      });
    }
  }

  _startMirror(video) {
    const win = this.contentWindow;
    const srcWidth = video.videoWidth;
    const srcHeight = video.videoHeight;
    const { tw, th } = this._encodeSize(srcWidth, srcHeight);

    this._video = video;
    this._lastFrameTime = -1;
    this._initCache();

    const ctxOpts = { alpha: false, willReadFrequently: true };
    try {
      let scaleCanvas;
      if (typeof win.OffscreenCanvas === "function") {
        scaleCanvas = new win.OffscreenCanvas(tw, th);
      } else {
        scaleCanvas = win.document.createElement("canvas");
        scaleCanvas.width = tw;
        scaleCanvas.height = th;
      }
      this._scaleCtx = scaleCanvas.getContext("2d", ctxOpts);
      this._scaleCanvas = scaleCanvas;
    } catch (e) {
      try {
        const fallbackCanvas = win.document.createElement("canvas");
        fallbackCanvas.width = tw;
        fallbackCanvas.height = th;
        this._scaleCtx = fallbackCanvas.getContext("2d", ctxOpts);
        this._scaleCanvas = fallbackCanvas;
      } catch (err2) {
        this._debug("canvas creation failed:", err2);
        this._stopAndNotify("canvas:construct");
        return;
      }
    }

    this._startTime = win.performance.now();
    this.sendAsyncMessage("ZenPiP:MirrorStarted", {
      width: srcWidth,
      height: srcHeight,
    });

    const doc = this.contentWindow?.document;
    if (doc && !this._visBound) {
      this._visBound = () => {
        const d = this.contentWindow?.document;
        if (d) this.sendAsyncMessage("ZenPiP:SourceVisibility", { hidden: d.hidden });
      };
      doc.addEventListener("visibilitychange", this._visBound);
    }
    if (doc) {
      this.sendAsyncMessage("ZenPiP:SourceVisibility", { hidden: doc.hidden });
    }
  }
  _captureFrame(quality) {
    const video = this._video;
    if (!video) return;
    if (!(video.videoWidth > 0)) return;
    if (!video.seeking && video.readyState < 2) return;

    const ct = video.currentTime;
    // Outside seeking: skip if no time advance (prevents duplicate frames during pause/stall)
    if (!video.seeking && ct === this._lastFrameTime) return;
    // During seeking: briefly skip the same position to avoid hammering drawImage
    if (video.seeking && ct === this._lastSentTime) return;

    const maxDim = parseInt(quality, 10) || MAX_FRAME_DIMENSION;
    const { tw, th } = this._encodeSize(video.videoWidth, video.videoHeight, maxDim);

    const ctx = this._scaleCtx;
    if (!ctx) return;
    if (this._scaleCanvas.width !== tw || this._scaleCanvas.height !== th) {
      this._scaleCanvas.width = tw;
      this._scaleCanvas.height = th;
    }

    try {
      ctx.drawImage(video, 0, 0, tw, th);
      const img = ctx.getImageData(0, 0, tw, th);
      this._lastSentTime = ct;
      if (!video.seeking) this._lastFrameTime = ct;
      this.sendAsyncMessage("ZenPiP:Frame", {
        buf: img.data.buffer,
        width: tw,
        height: th,
      }, [img.data.buffer]);
      // Periodically cache a low-res thumbnail for scrubbing preview
      if (!video.seeking) {
        const now = this.contentWindow?.performance.now() || 0;
        if (now - this._lastCacheTime >= 2000) {
          this._lastCacheTime = now;
          this._cacheFrame(ct);
        }
      }
    } catch (e) {
      this._debug("_captureFrame threw:", String(e), e?.name, e?.message);
    }
  }

  _stopAndNotify(reason) {
    this._debug("stopAndNotify reason=", reason, "hadVideo=", !!this._video);
    if (!this._video) return;
    this._teardown();
    try {
      this.sendAsyncMessage("ZenPiP:VideoStopped", { reason });
    } catch (e) {}
  }

  _teardown() {
    if (this._video && this._videoListeners) {
      try {
        this._video.removeEventListener("ended", this._videoListeners.onEnd);
        this._video.removeEventListener("emptied", this._videoListeners.onEnd);
      } catch (_) {}
    }
    if (this._pageHideBound) {
      try {
        this.contentWindow?.removeEventListener("pagehide", this._pageHideBound);
      } catch (_) {}
      this._pageHideBound = null;
    }
    if (this._visBound) {
      try {
        this.contentWindow?.document.removeEventListener("visibilitychange", this._visBound);
      } catch (_) {}
      this._visBound = null;
    }

    this._video = null;
    this._videoListeners = null;
    this._scaleCanvas = null;
    this._scaleCtx = null;
    this._lastFrameTime = -1;
    this._lastPlaying = false;
    this._lastSentTime = null;
    this._lastQuality = null;
    this._lastSentCacheTime = null;
    this._frameCache = null;
    this._cacheCanvas = null;
    this._cacheCtx = null;
    if (this._seekCaptureRAF) {
      try { this.contentWindow?.cancelAnimationFrame(this._seekCaptureRAF); } catch (_) {}
      this._seekCaptureRAF = null;
    }
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Tick") {
      this._lastQuality = msg.data?.quality;
      // During seeking the cache + seeked handler provide frames;
      // skip regular capture (drawImage returns the old pre-seek frame).
      if (this._video?.seeking) return;
      this._captureFrame(this._lastQuality);
      return;
    }
    if (msg.name === "ZenPiP:Stop") {
      this._stopAndNotify("parent:stop");
    }
  }

  didDestroy() {
    this._teardown();
  }
}