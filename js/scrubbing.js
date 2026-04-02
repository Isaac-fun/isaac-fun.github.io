class ScrubVideo {
  constructor(section) {
    this.section     = section;
    this.canvas      = section.querySelector('canvas');
    this.ctx         = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.figcaption  = section.querySelector('figcaption');
    this.folder      = section.dataset.folder;
    this.totalImages = parseInt(section.dataset.frames, 10);

    // LRU frame cache — stores { bitmap/img, lastUsed } keyed by index
    this.frameCache  = new Map();

    // Mobile gets a smaller budget to stay well under OS memory limits.
    // Desktop gets more for smoother scrubbing.
    this.FRAME_BUDGET = this.isMobile() ? 20 : 50;

    // Scroll state
    this.currentFrameIndex = 0;
    this.lastFrameIndex    = -1;
    this.lastDrawnFrame    = -1;
    this.pendingRender     = false;
    this.isInView          = false;

    // Cached layout metrics
    this.rectTop    = 0;
    this.rectHeight = 0;
    this.winHeight  = 0;

    // Batched DOM writes
    this.targetFilter  = '';
    this.targetOpacity = '';
    this.lastFilter    = '';
    this.lastOpacity   = '';

    // Concurrency-limited loader
    // Mobile: fewer parallel requests to avoid saturating a slow radio
    this.MAX_CONCURRENT = this.isMobile() ? 2 : 4;
    this.activeLoads    = new Set();
    this.loadQueue      = [];

    this.init();
  }

  isMobile() {
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
      || window.innerWidth < 768;
  }

  init() {
    this.canvas.style.willChange = 'contents';
    this.resize();

    this.observer = new IntersectionObserver((entries) => {
      this.isInView = entries[0].isIntersecting;
      if (this.isInView) {
        this.updateScrollMath();
        this.onScroll();
        this.reprioritizeQueue();
        this.drainQueue();
      } else {
        // When off-screen, cancel pending loads and free distant frames
        this.loadQueue = [];
        this.evictDistantFrames(0); // Keep only a tiny window around current pos
      }
    }, { rootMargin: '100% 0px' });
    this.observer.observe(this.section);

    this.loadFrame(0).then(() => {
      this.scheduleRender();
      this.buildAndStartQueue();
    });

    window.addEventListener('scroll', () => { if (this.isInView) this.onScroll(); }, { passive: true });
    window.addEventListener('resize', () => this.debouncedResize(), { passive: true });
  }

  // ─── LRU Cache ────────────────────────────────────────────────────────────────

  /** Get a frame from cache, updating its last-used timestamp. */
  getFrame(index) {
    const entry = this.frameCache.get(index);
    if (!entry) return null;
    entry.lastUsed = performance.now();
    return entry.data;
  }

  /** Store a frame in cache, then evict if over budget. */
  storeFrame(index, data) {
    this.frameCache.set(index, { data, lastUsed: performance.now() });
    this.evictIfOverBudget();
  }

  hasFrame(index) {
    return this.frameCache.has(index);
  }

  /**
   * If the cache is over budget, evict the frame that is:
   *   1. Furthest from the current scroll position (distance-first)
   *   2. Least recently used as a tiebreaker
   * This keeps the frames the user is most likely to need next.
   */
  evictIfOverBudget() {
    if (this.frameCache.size <= this.FRAME_BUDGET) return;

    const pivot = this.currentFrameIndex;
    // Sort entries: furthest distance first, then oldest lastUsed
    const sorted = [...this.frameCache.entries()].sort(([ai, a], [bi, b]) => {
      const distDiff = Math.abs(bi - pivot) - Math.abs(ai - pivot);
      return distDiff !== 0 ? distDiff : a.lastUsed - b.lastUsed;
    });

    const toEvict = sorted.slice(0, this.frameCache.size - this.FRAME_BUDGET);
    for (const [index, entry] of toEvict) {
      entry.data?.close?.(); // Free the GPU/memory bitmap
      this.frameCache.delete(index);
      // Put it back on the load queue in case the user scrolls back
      if (!this.loadQueue.includes(index)) {
        this.loadQueue.push(index);
      }
    }
  }

  /**
   * When the section goes off-screen, aggressively free frames
   * outside a small window around the current position.
   */
  evictDistantFrames(keepRadius = 5) {
    const pivot = this.currentFrameIndex;
    for (const [index, entry] of this.frameCache.entries()) {
      if (Math.abs(index - pivot) > keepRadius) {
        entry.data?.close?.();
        this.frameCache.delete(index);
      }
    }
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  buildAndStartQueue() {
    const order = this.buildPriorityOrder(0);
    this.loadQueue = order.filter(i => i !== 0 && !this.hasFrame(i));
    this.drainQueue();
  }

  buildPriorityOrder(pivot) {
    const order = [];
    const n = this.totalImages;
    let lo = pivot - 1;
    let hi = pivot + 1;
    order.push(pivot);
    while (lo >= 0 || hi < n) {
      if (hi < n)  order.push(hi++);
      if (lo >= 0) order.push(lo--);
    }
    return order;
  }

  reprioritizeQueue() {
    const pivot = this.currentFrameIndex;
    this.loadQueue = this.loadQueue
      .filter(i => !this.hasFrame(i) && !this.activeLoads.has(i))
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
        if (typeof createImageBitmap === 'function') {
          createImageBitmap(img)
            .then(bitmap => {
              this.storeFrame(index, bitmap);
              resolve();
            })
            .catch(() => {
              this.storeFrame(index, img);
              resolve();
            });
        } else {
          this.storeFrame(index, img);
          resolve();
        }
      };

      img.onerror = resolve;
      img.src = `${this.folder}${index + 1}.png`; // ← swap .png → .webp for huge gains
    });
  }

  // ─── Layout ──────────────────────────────────────────────────────────────────

  debouncedResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this.resize(), 100);
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

    if (Math.abs(newFrameIndex - this.currentFrameIndex) > 5) {
      this.currentFrameIndex = newFrameIndex;
      this.reprioritizeQueue();
      this.drainQueue();
    } else {
      this.currentFrameIndex = newFrameIndex;
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

    // getFrame() updates lastUsed timestamp — important for LRU eviction
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
    // Free all GPU bitmap memory
    for (const entry of this.frameCache.values()) {
      entry.data?.close?.();
    }
    this.frameCache.clear();
  }
}

window.addEventListener('load', () => {
  document.querySelectorAll('.scrub-section').forEach(section => new ScrubVideo(section));
});