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

    if (event.type === "waiting" || event.type === "seeking") {
      if (target === this._video) {
        this._notifyPlaying(false);
      }
      return;
    }

    if (event.type === "seeked" || event.type === "canplay") {
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
      this._stopAndNotify("event:" + event.type);
    }
  }

  _notifyPlaying(playing) {
    if (this._lastPlaying === playing) return;
    this._lastPlaying = playing;
    try {
      this.sendAsyncMessage("ZenPiP:PlayState", { playing });
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

  _initWebGL(canvas, tw, th) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false }) ||
               canvas.getContext("experimental-webgl", { premultipliedAlpha: false });
    if (!gl) return null;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return null;
    }

    const buf = new ArrayBuffer(4 * tw * th);
    return { gl, tex, fbo, buf, tw, th };
  }

  _startMirror(video) {
    const win = this.contentWindow;
    const srcWidth = video.videoWidth;
    const srcHeight = video.videoHeight;
    const { tw, th } = this._encodeSize(srcWidth, srcHeight);

    this._video = video;
    this._lastFrameTime = -1;

    try {
      let glCanvas = null;
      if (typeof win.OffscreenCanvas === "function") {
        glCanvas = new win.OffscreenCanvas(tw, th);
      } else {
        glCanvas = win.document.createElement("canvas");
        glCanvas.width = tw; glCanvas.height = th;
      }
      const glState = this._initWebGL(glCanvas, tw, th);
      if (glState) {
        this._isWebGL = true;
        this._glCanvas = glCanvas;
        this._gl = glState.gl;
        this._glTex = glState.tex;
        this._glFbo = glState.fbo;
        this._glBuf = glState.buf;
        this._glState = glState;
      }
    } catch (e) {
      this._debug("WebGL setup failed:", e);
    }

    if (!this._isWebGL) {
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

  _resizeGL(tw, th) {
    const gl = this._gl;
    const state = this._glState;
    state.tw = tw; state.th = th;

    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const newSize = 4 * tw * th;
    if (!state.buf || state.buf.byteLength < newSize) {
      state.buf = new ArrayBuffer(newSize);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
  }

  _captureFrameGL(tw, th) {
    const gl = this._gl;
    const state = this._glState;

    if (state.tw !== tw || state.th !== th) {
      this._resizeGL(tw, th);
    }

    gl.bindTexture(gl.TEXTURE_2D, state.tex);

    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._video);
    } catch (e) {
      this._debug("texImage2D(video) failed, falling back:", e.message);
      return null;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
    const pixels = new Uint8Array(state.buf);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Firefox WebGL reads top-down, but putImageData expects bottom-up.
    // The premultiplied alpha and byte ordering are consistent; a simple
    // row-flip in-place keeps the transferable cheap.
    const rowBytes = tw * 4;
    const half = th >> 1;
    for (let y = 0; y < half; y++) {
      const topOff = y * rowBytes;
      const botOff = (th - 1 - y) * rowBytes;
      const topSlice = pixels.slice(topOff, topOff + rowBytes);
      const botSlice = pixels.slice(botOff, botOff + rowBytes);
      pixels.set(topSlice, botOff);
      pixels.set(botSlice, topOff);
    }

    return state.buf;
  }

  _captureFrame(quality) {
    const video = this._video;
    if (!video) return;
    if (!(video.videoWidth > 0) || video.readyState < 2) return;

    // Skip capture if video time hasn't advanced (avoids redundant IPC for
    // paused/stalled content). Note: we intentionally allow seek-through,
    // so only filter truly identical timestamps.
    const ct = video.currentTime;
    if (ct === this._lastFrameTime) return;
    this._lastFrameTime = ct;

    const maxDim = parseInt(quality, 10) || MAX_FRAME_DIMENSION;
    const { tw, th } = this._encodeSize(video.videoWidth, video.videoHeight, maxDim);

    if (this._isWebGL) {
      const buf = this._captureFrameGL(tw, th);
      if (buf) {
        try {
          this.sendAsyncMessage("ZenPiP:Frame", {
            buf,
            width: tw,
            height: th,
          }, [buf]);
          return;
        } catch (e) {
          this._debug("WebGL frame send failed:", e.message);
        }
      }
    }

    // Fallback: canvas2d getImageData path
    const ctx = this._scaleCtx;
    if (!ctx) return;
    if (this._scaleCanvas.width !== tw || this._scaleCanvas.height !== th) {
      this._scaleCanvas.width = tw;
      this._scaleCanvas.height = th;
    }

    try {
      ctx.drawImage(video, 0, 0, tw, th);
      const img = ctx.getImageData(0, 0, tw, th);
      this.sendAsyncMessage("ZenPiP:Frame", {
        buf: img.data.buffer,
        width: tw,
        height: th,
      }, [img.data.buffer]);
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

    if (this._gl) {
      try {
        if (this._glState) {
          this._gl.deleteFramebuffer(this._glState.fbo);
          this._gl.deleteTexture(this._glState.tex);
        }
      } catch (_) {}
      this._gl = null;
      this._glCanvas = null;
      this._glState = null;
      this._glBuf = null;
    }

    this._video = null;
    this._videoListeners = null;
    this._isWebGL = false;
    this._scaleCanvas = null;
    this._scaleCtx = null;
    this._lastFrameTime = -1;
    this._lastPlaying = false;
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Tick") {
      this._captureFrame(msg.data?.quality);
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
