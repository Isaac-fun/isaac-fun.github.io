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
    this.FRAME_BUDGET   = this.isIOS ? 12 : 50;
    this.PRELOAD_RADIUS = this.isIOS ? 8  : 30;
    this.MAX_CONCURRENT = this.isIOS ? 1  : 4;

    this.frameCache = new Map();

    this.currentFrameIndex = 0;
    this.lastFrameIndex    = -1;
    this.lastDrawnFrame    = -1;
    this.pendingRender     = false;
    this.isInView          = false;

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
        this.onScroll();
        // ← THE FIX: always rebuild the queue when coming back into view.
        // onScroll() only calls buildWindowQueue if frameDelta > 3,
        // but if the user hasn't scrolled the index is the same and
        // frameDelta === 0, so nothing ever reloads.
        this.buildWindowQueue(this.currentFrameIndex);
      } else {
        // Off-screen: stop loading, free distant frames
        this.loadQueue = [];
        this.activeLoads.clear();
        this.evictOutsideRadius(3);
      }
    }, { rootMargin: '50% 0px' });
    this.observer.observe(this.section);

    this.loadFrame(0).then(() => {
      this.scheduleRender();
    });

    window.addEventListener('scroll', () => { if (this.isInView) this.onScroll(); }, { passive: true });
    window.addEventListener('resize', () => this.debouncedResize(), { passive: true });
  }

  // ─── LRU Cache ───────────────────────────────────────────────────────────────

  getFrame(index) {
    const entry = this.frameCache.get(index);
    if (!entry) return null;
    entry.lastUsed = performance.now();
    return entry.data;
  }

  hasFrame(index) {
    return this.frameCache.has(index);
  }

  storeFrame(index, data) {
    this.frameCache.set(index, { data, lastUsed: performance.now() });
    this.evictIfOverBudget();
  }

  evictIfOverBudget() {
    if (this.frameCache.size <= this.FRAME_BUDGET) return;
    const pivot = this.currentFrameIndex;
    const sorted = [...this.frameCache.entries()].sort(([ai, a], [bi, b]) => {
      const distDiff = Math.abs(bi - pivot) - Math.abs(ai - pivot);
      return distDiff !== 0 ? distDiff : a.lastUsed - b.lastUsed;
    });
    const evictCount = this.frameCache.size - this.FRAME_BUDGET;
    for (let i = 0; i < evictCount; i++) {
      const [index, entry] = sorted[i];
      this.freeEntry(entry);
      this.frameCache.delete(index);
    }
  }

  evictOutsideRadius(radius) {
    const pivot = this.currentFrameIndex;
    for (const [index, entry] of this.frameCache.entries()) {
      if (Math.abs(index - pivot) > radius) {
        this.freeEntry(entry);
        this.frameCache.delete(index);
      }
    }
  }

  freeEntry(entry) {
    if (!entry?.data) return;
    if (typeof entry.data.close === 'function') {
      entry.data.close();
    } else if (entry.data instanceof HTMLImageElement) {
      entry.data.onload  = null;
      entry.data.onerror = null;
      entry.data.src     = '';
    }
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  buildWindowQueue(pivot) {
    const lo = Math.max(0, pivot - this.PRELOAD_RADIUS);
    const hi = Math.min(this.totalImages - 1, pivot + this.PRELOAD_RADIUS);

    const order = [pivot];
    let l = pivot - 1, h = pivot + 1;
    while (l >= lo || h <= hi) {
      if (h <= hi) order.push(h++);
      if (l >= lo) order.push(l--);
    }

    // Merge with existing queue rather than replacing it —
    // avoids re-queuing frames already in-flight
    const inQueue = new Set(this.loadQueue);
    for (const i of order) {
      if (!this.hasFrame(i) && !this.activeLoads.has(i) && !inQueue.has(i)) {
        this.loadQueue.push(i);
        inQueue.add(i);
      }
    }

    // Re-sort so closest frames always drain first
    this.loadQueue.sort((a, b) =>
      Math.abs(a - pivot) - Math.abs(b - pivot)
    );

    this.drainQueue();
  }

  reprioritizeQueue() {
    const pivot = this.currentFrameIndex;
    this.loadQueue = this.loadQueue
      .filter(i => {
        if (this.hasFrame(i) || this.activeLoads.has(i)) return false;
        if (Math.abs(i - pivot) > this.PRELOAD_RADIUS) return false;
        return true;
      })
      .sort((a, b) => Math.abs(a - pivot) - Math.abs(b - pivot));
  }

  drainQueue() {
    while (this.activeLoads.size < this.MAX_CONCURRENT && this.loadQueue.length > 0) {
      const index = this.loadQueue.shift();
      if (this.hasFrame(index) || this.activeLoads.has(index)) continue;
      this.activeLoads.add(index);
      this.loadFrame(index).then(() => {
        this.activeLoads.delete(index);
        if (this.isInView) this.scheduleRender();
        this.drainQueue();
      });
    }
  }

  loadFrame(index) {
    return new Promise((resolve) => {
      if (this.hasFrame(index)) return resolve();

      const img    = new Image();
      img.decoding = 'async';

      img.onload = () => {
        if (this.USE_BITMAP) {
          createImageBitmap(img)
            .then(bitmap => { this.storeFrame(index, bitmap); resolve(); })
            .catch(()    => { this.storeFrame(index, img);    resolve(); });
        } else {
          this.storeFrame(index, img);
          resolve();
        }
      };

      img.onerror = resolve;
      img.src = `${this.folder}${index + 1}.png`;
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
    this.rectTop    = rect.top + window.scrollY;
    this.rectHeight = rect.height;
  }

  // ─── Scroll Handler ───────────────────────────────────────────────────────────

  onScroll() {
    const scrollY        = window.scrollY;
    const currentRectTop = this.rectTop - scrollY;
    let scrollProgress   = (this.winHeight - currentRectTop) / (this.rectHeight + this.winHeight);
    scrollProgress       = Math.max(0, Math.min(scrollProgress, 1));

    const newFrameIndex = Math.min(
      Math.floor(scrollProgress * this.totalImages),
      this.totalImages - 1
    );

    const frameDelta = Math.abs(newFrameIndex - this.currentFrameIndex);
    this.currentFrameIndex = newFrameIndex;

    if (frameDelta > 3) {
      this.buildWindowQueue(this.currentFrameIndex);
    } else if (frameDelta > 0) {
      this.reprioritizeQueue();
      this.drainQueue();
    }

    const brightness   = Math.min(100, scrollProgress * 80);
    this.targetFilter  = `brightness(${brightness.toFixed(1)}%)`;
    this.targetOpacity = scrollProgress.toFixed(3);

    if (this.currentFrameIndex !== this.lastFrameIndex || this.targetFilter !== this.lastFilter) {
      this.scheduleRender();
    }
  }

  // ─── Render Loop ─────────────────────────────────────────────────────────────

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

    let frame       = this.getFrame(this.currentFrameIndex);
    let actualDrawn = this.currentFrameIndex;

    if (!frame) {
      for (let i = this.currentFrameIndex - 1; i >= 0; i--) {
        const f = this.getFrame(i);
        if (f) { frame = f; actualDrawn = i; break; }
      }
    }
    if (!frame) {
      for (let i = this.currentFrameIndex + 1; i < this.totalImages; i++) {
        const f = this.getFrame(i);
        if (f) { frame = f; actualDrawn = i; break; }
      }
    }

    if (!frame || (this.currentFrameIndex === this.lastFrameIndex && this.lastDrawnFrame === actualDrawn)) {
      return;
    }

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
    for (const entry of this.frameCache.values()) this.freeEntry(entry);
    this.frameCache.clear();
  }
}

window.addEventListener('load', () => {
  document.querySelectorAll('.scrub-section').forEach(section => new ScrubVideo(section));
});