class ScrubVideo {
  constructor(section) {
    this.section = section;
    this.canvas = section.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.figcaption = section.querySelector('figcaption');
    this.folder = section.dataset.folder;
    this.totalImages = parseInt(section.dataset.frames, 10);
    this.frameTemplate = section.dataset.frameTemplate || '{n}.png';

    this.isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    this.USE_BITMAP = !this.isIOS && typeof createImageBitmap === 'function';
    this.MAX_CONCURRENT = this.isIOS ? 2 : 3;
    this.frames = new Array(this.totalImages).fill(null);

    this.currentFrameIndex = 0;
    this.lastFrameIndex = -1;
    this.lastDrawnFrame = -1;
    this.pendingRender = false;
    this.isInView = false;
    this.loadingStarted = false;
    this.scrollPending = false;
    this.renderPending = false;

    this.rectTop = 0;
    this.rectHeight = 0;
    this.winHeight = 0;
    this.canvasWidth = 0;
    this.canvasHeight = 0;

    this.targetFilter = '';
    this.targetOpacity = '';
    this.lastFilter = '';
    this.lastOpacity = '';

    this.activeLoads = new Set();
    this.loadQueue = [];

    this.init();
  }

  init() {
    this.canvas.style.willChange = 'transform';
    this.canvas.style.transform = 'translateZ(0)';
    this.canvas.style.touchAction = 'pan-y';
    this.resize();

    this.observer = new IntersectionObserver((entries) => {
      this.isInView = entries[0].isIntersecting;
      if (this.isInView) {
        this.updateScrollMath();
        this.scheduleSyncScroll();
        if (!this.loadingStarted) {
          this.loadingStarted = true;
          this.startLoading();
        } else {
          this.drainQueue();
        }
      } else {
        this.loadQueue = [];
      }
    }, { threshold: 0.01, rootMargin: '120px 0px' });

    this.observer.observe(this.section);

    window.addEventListener('scroll', () => { if (this.isInView) this.scheduleSyncScroll(); }, { passive: true });
    window.addEventListener('touchmove', () => { if (this.isInView) this.scheduleSyncScroll(); }, { passive: true });
    window.addEventListener('resize', () => this.debouncedResize(), { passive: true });
  }

  startLoading() {
    this.loadFrame(0).then(() => {
      this.scheduleRender();
      const pivot = this.currentFrameIndex;
      this.loadQueue = this.buildPriorityOrder(pivot).filter((index) => index >= 0 && index < this.totalImages && this.frames[index] === null);
      this.drainQueue();
    });
  }

  buildPriorityOrder(pivot) {
    const order = [pivot];
    let distance = 1;
    while (distance <= 12 && (pivot - distance >= 0 || pivot + distance < this.totalImages)) {
      if (pivot - distance >= 0) order.push(pivot - distance);
      if (pivot + distance < this.totalImages) order.push(pivot + distance);
      distance += 1;
    }
    return order;
  }

  drainQueue() {
    while (this.activeLoads.size < this.MAX_CONCURRENT && this.loadQueue.length > 0) {
      const index = this.loadQueue.shift();
      if (index === undefined || this.frames[index] !== null || this.activeLoads.has(index)) continue;
      this.activeLoads.add(index);
      this.loadFrame(index).then(() => {
        this.activeLoads.delete(index);
        if (this.isInView) this.scheduleRender();
        this.drainQueue();
      });
    }
  }

  prioritize(index) {
    this.loadQueue = [index, ...this.loadQueue.filter((item) => item !== index)];
  }

  loadFrame(index) {
    return new Promise((resolve) => {
      if (this.frames[index] !== null) return resolve();

      const img = new Image();
      img.decoding = 'async';
      img.src = `${this.folder}${this.frameTemplate.replace('{n}', index + 1)}`;

      img.onload = () => {
        if (this.USE_BITMAP) {
          createImageBitmap(img)
            .then((bitmap) => {
              this.frames[index] = bitmap;
              resolve();
            })
            .catch(() => {
              this.frames[index] = img;
              resolve();
            });
        } else {
          this.frames[index] = img;
          resolve();
        }
      };

      img.onerror = () => {
        this.frames[index] = false;
        resolve();
      };
    });
  }

  debouncedResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this.resize(), 150);
  }

  resize() {
    this.winHeight = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = Math.max(1, Math.round(window.innerWidth));
    const cssHeight = Math.max(1, Math.round(this.winHeight));
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    this.canvasWidth = cssWidth;
    this.canvasHeight = cssHeight;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.updateScrollMath();
    this.lastFrameIndex = -1;
    if (this.isInView) this.scheduleRender();
  }

  updateScrollMath() {
    const rect = this.section.getBoundingClientRect();
    this.rectTop = rect.top + (window.pageYOffset || window.scrollY);
    this.rectHeight = rect.height;
  }

  scheduleSyncScroll() {
    if (this.scrollPending) return;
    this.scrollPending = true;
    requestAnimationFrame(() => {
      this.scrollPending = false;
      if (this.isInView) this.syncScroll();
    });
  }

  syncScroll() {
    const scrollY = window.pageYOffset || window.scrollY;
    const currentRectTop = this.rectTop - scrollY;
    let progress = (this.winHeight - currentRectTop) / (this.rectHeight + this.winHeight);
    progress = Math.max(0, Math.min(progress, 1));

    const newIndex = Math.min(Math.round(progress * (this.totalImages - 1)), this.totalImages - 1);

    if (this.frames[newIndex] === null && !this.activeLoads.has(newIndex)) {
      this.prioritize(newIndex);
      this.drainQueue();
    }

    this.currentFrameIndex = newIndex;

    const brightness = Math.min(100, progress * 80);
    this.targetFilter = `brightness(${brightness.toFixed(1)}%)`;
    this.targetOpacity = progress.toFixed(3);

    if (this.currentFrameIndex !== this.lastFrameIndex || this.targetFilter !== this.lastFilter) {
      this.scheduleRender();
    }
  }

  scheduleRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderPending = false;
      this.render();
    });
  }

  render() {
    if (this.targetFilter !== this.lastFilter) {
      this.canvas.style.filter = this.targetFilter;
      this.lastFilter = this.targetFilter;
    }
    if (this.figcaption && this.targetOpacity !== this.lastOpacity) {
      this.figcaption.style.opacity = this.targetOpacity;
      this.lastOpacity = this.targetOpacity;
    }

    let frame = this.frames[this.currentFrameIndex];
    let actualDrawn = this.currentFrameIndex;

    if (!frame) {
      for (let i = this.currentFrameIndex - 1; i >= 0; i--) {
        if (this.frames[i]) {
          frame = this.frames[i];
          actualDrawn = i;
          break;
        }
      }
    }
    if (!frame) {
      for (let i = this.currentFrameIndex + 1; i < this.totalImages; i++) {
        if (this.frames[i]) {
          frame = this.frames[i];
          actualDrawn = i;
          break;
        }
      }
    }

    if (!frame) return;
    if (this.currentFrameIndex === this.lastFrameIndex && this.lastDrawnFrame === actualDrawn) return;

    this.lastFrameIndex = this.currentFrameIndex;
    this.lastDrawnFrame = actualDrawn;

    this.ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    this.ctx.drawImage(frame, 0, 0, this.canvasWidth, this.canvasHeight);
  }

  destroy() {
    if (this.observer) this.observer.disconnect();
    if (this.renderRaf) cancelAnimationFrame(this.renderRaf);
    clearTimeout(this._resizeTimer);
    this.loadQueue = [];
    this.frames.forEach((frame) => frame?.close?.());
  }
}

window.addEventListener('load', () => {
  document.querySelectorAll('.scrub-section').forEach((section) => new ScrubVideo(section));
});