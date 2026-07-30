class ScrubVideo {
  constructor(section) {
    this.section     = section;
    this.canvas      = section.querySelector('canvas');
    this.ctx         = this.canvas.getContext('2d', { alpha: true });
    this.figcaption  = section.querySelector('figcaption');
    this.folder      = section.dataset.folder;
    this.totalImages = parseInt(section.dataset.frames, 10);

    this.isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
              || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    this.USE_BITMAP     = !this.isIOS && typeof createImageBitmap === 'function';
    this.MAX_CONCURRENT = this.isIOS ? 2 : 4;

    // Simple flat array — no Map, no eviction while in view
    this.frames = new Array(this.totalImages).fill(null);

    this.currentFrameIndex = 0;
    this.lastFrameIndex    = -1;
    this.lastDrawnFrame    = -1;
    this.pendingRender     = false;
    this.isInView          = false;
    this.loadingStarted    = false; // Guard so we only kick off loading once

    this.rectTop    = 0;
    this.rectHeight = 0;
    this.winHeight  = 0;

    this.targetFilter  = '';
    this.targetOpacity = '';
    this.lastFilter    = '';
    this.lastOpacity   = '';

    this.activeLoads = new Set();
    this.loadQueue   = [];

    this.init();
  }

  init() {
    this.canvas.style.willChange = 'contents';
    this.resize();

    this.observer = new IntersectionObserver((entries) => {
      this.isInView = entries[0].isIntersecting;

      if (this.isInView) {
        this.updateScrollMath();
        this.syncScroll();

        // Kick off loading the first time we enter view
        if (!this.loadingStarted) {
          this.loadingStarted = true;
          this.startLoading();
        } else {
          // Re-entering view: restart any stalled queue
          this.drainQueue();
        }
      } else {
        // Fully off screen: cancel pending loads
        // Do NOT clear the frames array — we want frames to persist
        // so scrolling back is instant
        this.loadQueue = [];
      }
    }, { rootMargin: '20% 0px' });

    this.observer.observe(this.section);

    // Use pageYOffset for iOS Safari compat
    window.addEventListener('scroll',     () => { if (this.isInView) this.syncScroll(); }, { passive: true });
    window.addEventListener('touchmove',  () => { if (this.isInView) this.syncScroll(); }, { passive: true });
    window.addEventListener('resize',     () => this.debouncedResize(), { passive: true });
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  startLoading() {
    // Load frame 0 immediately so something is visible
    this.loadFrame(0).then(() => {
      this.scheduleRender();

      // Build full sequential queue starting from current position outward
      const pivot = this.currentFrameIndex;
      const order = this.buildPriorityOrder(pivot);
      this.loadQueue = order.filter(i => !this.frames[i]);
      this.drainQueue();
    });
  }

  buildPriorityOrder(pivot) {
    const order = [];
    let lo = pivot - 1, hi = pivot + 1;
    order.push(pivot);
    while (lo >= 0 || hi < this.totalImages) {
      if (hi < this.totalImages) order.push(hi++);
      if (lo >= 0)               order.push(lo--);
    }
    return order;
  }

  drainQueue() {
    while (this.activeLoads.size < this.MAX_CONCURRENT && this.loadQueue.length > 0) {
      const index = this.loadQueue.shift();
      if (this.frames[index] || this.activeLoads.has(index)) continue;
      this.activeLoads.add(index);
      this.loadFrame(index).then(() => {
        this.activeLoads.delete(index);
        if (this.isInView) this.scheduleRender();
        this.drainQueue();
      });
    }
  }

  // Bump a target index to the front of the queue
  prioritize(index) {
    this.loadQueue = [
      index,
      ...this.loadQueue.filter(i => i !== index)
    ];
  }

  loadFrame(index) {
    return new Promise((resolve) => {
      if (this.frames[index]) return resolve();

      const img    = new Image();
      img.decoding = 'async';

      img.onload = () => {
        if (this.USE_BITMAP) {
          createImageBitmap(img)
            .then(bitmap => { this.frames[index] = bitmap; resolve(); })
            .catch(()    => { this.frames[index] = img;    resolve(); });
        } else {
          this.frames[index] = img;
          resolve();
        }
      };

      img.onerror = resolve; // Don't stall the queue on a bad frame

      const frameTemplate = this.section.dataset.frameTemplate || `${index + 1}.png`;
      const frameName = frameTemplate.replace('{n}', index + 1);
      img.src = `${this.folder}${frameName}`;
    });
  }

  // ─── Layout ──────────────────────────────────────────────────────────────────

  debouncedResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this.resize(), 150);
  }

  resize() {
    this.winHeight      = window.innerHeight;
    this.canvas.width   = window.innerWidth;
    this.canvas.height  = this.winHeight;
    this.updateScrollMath();
    this.lastFrameIndex = -1;
    if (this.isInView) this.scheduleRender();
  }

  updateScrollMath() {
    const rect      = this.section.getBoundingClientRect();
    this.rectTop    = rect.top + (window.pageYOffset || window.scrollY);
    this.rectHeight = rect.height;
  }

  // ─── Scroll ───────────────────────────────────────────────────────────────────

  syncScroll() {
    // pageYOffset is more reliable than scrollY on older iOS Safari
    const scrollY        = window.pageYOffset || window.scrollY;
    const currentRectTop = this.rectTop - scrollY;
    let   progress       = (this.winHeight - currentRectTop) / (this.rectHeight + this.winHeight);
    progress             = Math.max(0, Math.min(progress, 1));

    const newIndex = Math.min(
      Math.floor(progress * this.totalImages),
      this.totalImages - 1
    );

    // If the target frame isn't loaded yet, move it to the front of the queue
    if (!this.frames[newIndex] && !this.activeLoads.has(newIndex)) {
      this.prioritize(newIndex);
      this.drainQueue();
    }

    this.currentFrameIndex = newIndex;

    const brightness   = Math.min(100, progress * 80);
    this.targetFilter  = `brightness(${brightness.toFixed(1)}%)`;
    this.targetOpacity = progress.toFixed(3);

    if (this.currentFrameIndex !== this.lastFrameIndex || this.targetFilter !== this.lastFilter) {
      this.scheduleRender();
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  scheduleRender() {
    if (this.pendingRender) return;
    this.pendingRender = true;
    requestAnimationFrame(() => this.render());
  }

  render() {
    this.pendingRender = false;

    if (this.targetFilter !== this.lastFilter) {
      this.canvas.style.filter = this.targetFilter;
      this.lastFilter          = this.targetFilter;
    }
    if (this.figcaption && this.targetOpacity !== this.lastOpacity) {
      this.figcaption.style.opacity = this.targetOpacity;
      this.lastOpacity              = this.targetOpacity;
    }

    // Find the best available frame: exact → nearest behind → nearest ahead
    let frame       = this.frames[this.currentFrameIndex];
    let actualDrawn = this.currentFrameIndex;

    if (!frame) {
      for (let i = this.currentFrameIndex - 1; i >= 0; i--) {
        if (this.frames[i]) { frame = this.frames[i]; actualDrawn = i; break; }
      }
    }
    if (!frame) {
      for (let i = this.currentFrameIndex + 1; i < this.totalImages; i++) {
        if (this.frames[i]) { frame = this.frames[i]; actualDrawn = i; break; }
      }
    }

    // Skip if nothing to draw or the canvas already shows this exact frame
    if (!frame) return;
    if (this.currentFrameIndex === this.lastFrameIndex && this.lastDrawnFrame === actualDrawn) return;

    this.lastFrameIndex = this.currentFrameIndex;
    this.lastDrawnFrame = actualDrawn;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  destroy() {
    if (this.observer) this.observer.disconnect();
    clearTimeout(this._resizeTimer);
    this.loadQueue = [];
    this.frames.forEach(f => f?.close?.());
  }
}

window.addEventListener('load', () => {
  document.querySelectorAll('.scrub-section').forEach(section => new ScrubVideo(section));
});