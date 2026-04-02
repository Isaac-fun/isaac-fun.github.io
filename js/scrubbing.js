class ScrubVideo {
  constructor(section) {
    this.section      = section;
    this.canvas       = section.querySelector('canvas');
    this.ctx          = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.figcaption   = section.querySelector('figcaption');
    this.folder       = section.dataset.folder;
    this.totalImages  = parseInt(section.dataset.frames, 10);
    this.frames       = new Array(this.totalImages); // Stores ImageBitmap objects

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
    this.MAX_CONCURRENT = 4;
    this.activeLoads    = new Set();
    this.loadQueue      = [];

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
        this.reprioritizeQueue();
        this.drainQueue();
      }
    }, { rootMargin: '100% 0px' });
    this.observer.observe(this.section);

    // Load frame 0 first so something is visible immediately
    this.loadFrame(0).then(() => {
      this.scheduleRender();
      this.buildAndStartQueue();
    });

    window.addEventListener('scroll', () => { if (this.isInView) this.onScroll(); }, { passive: true });
    window.addEventListener('resize', () => this.debouncedResize(), { passive: true });
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  buildAndStartQueue() {
    const order = this.buildPriorityOrder(0);
    this.loadQueue = order.filter(i => i !== 0 && !this.frames[i]);
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
      .filter(i => !this.frames[i] && !this.activeLoads.has(i))
      .sort((a, b) => Math.abs(a - pivot) - Math.abs(b - pivot));
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

  /**
   * Uses new Image() to avoid any CORS issues, then converts to ImageBitmap
   * for fast GPU-ready drawing. Falls back to storing the raw img element
   * if createImageBitmap isn't supported.
   */
  loadFrame(index) {
    return new Promise((resolve) => {
      if (this.frames[index]) return resolve();

      const img    = new Image();
      img.decoding = 'async';

      img.onload = () => {
        if (typeof createImageBitmap === 'function') {
          createImageBitmap(img)
            .then(bitmap => {
              this.frames[index] = bitmap;
              resolve();
            })
            .catch(() => {
              // createImageBitmap failed — fall back to the img element directly
              this.frames[index] = img;
              resolve();
            });
        } else {
          // Browser doesn't support createImageBitmap (rare) — use img directly
          this.frames[index] = img;
          resolve();
        }
      };

      img.onerror = resolve; // Don't let one bad frame stall the queue
      img.src     = `${this.folder}${index + 1}.png`; // ← swap to .webp for huge speed gains
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

    // Try exact frame, then search backward, then forward
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
    // Free GPU bitmap memory for anything that was converted
    this.frames.forEach(f => f?.close?.());
  }
}

window.addEventListener('load', () => {
  document.querySelectorAll('.scrub-section').forEach(section => new ScrubVideo(section));
});