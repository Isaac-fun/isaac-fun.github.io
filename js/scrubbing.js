class ScrubVideo {
  constructor(section) {
    this.section = section;
    this.canvas = section.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d'); // alpha ON — no black box
    this.figcaption = section.querySelector('figcaption');
    this.folder = section.dataset.folder;
    this.totalImages = parseInt(section.dataset.frames, 10);
    this.images = new Array(this.totalImages);
    this.currentFrameIndex = 0;
    this.loadedCount = 0;
    this.isReady = false;
    this.pendingRender = false;
    this.rafId = null;
    this.lastFrameIndex = -1;
    this._resizeTimer = null;

    this.resizeCanvas();
    this.loadImages();
    this.addResizeListener();
  }

  loadImages() {
    let firstFrameReady = false;

    for (let i = 0; i < this.totalImages; i++) {
      const img = new Image();
      img.decoding = 'async';

      img.onload = () => {
        this.images[i] = img;
        this.loadedCount++;

        // Show first frame as soon as it arrives
        if (i === 0 && !firstFrameReady) {
          firstFrameReady = true;
          this.isReady = true;
          this.addScrollListener();
          this.scheduleRender();
        }
      };

      img.onerror = () => { this.loadedCount++; };
      img.src = `${this.folder}${i + 1}.png`;
    }
  }

  addScrollListener() {
    window.addEventListener('scroll', () => this.onScroll(), { passive: true });
  }

  addResizeListener() {
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => {
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => this.resizeCanvas(), 100);
      });
      this._ro.observe(this.section);
    } else {
      window.addEventListener('resize', () => {
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => this.resizeCanvas(), 100);
      });
    }
  }

  resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.lastFrameIndex = -1; // force re-render after resize
    this.scheduleRender();
  }

  onScroll() {
    const rect = this.section.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const scrollProgress = Math.min(
      Math.max((windowHeight - rect.top) / (rect.height + windowHeight), 0),
      1
    );

    const frameIndex = Math.min(
      Math.floor(scrollProgress * this.totalImages),
      this.totalImages - 1
    );

    this.currentFrameIndex = frameIndex;

    const brightness = Math.min(100, scrollProgress * 80);
    const opacity = Math.min(1, scrollProgress);

    this.canvas.style.filter = `brightness(${brightness.toFixed(1)}%)`;
    if (this.figcaption) {
      this.figcaption.style.opacity = opacity.toFixed(3);
    }

    // Only re-render if the frame changed
    if (frameIndex !== this.lastFrameIndex) {
      this.scheduleRender();
    }
  }

  scheduleRender() {
    if (this.pendingRender) return;
    this.pendingRender = true;
    this.rafId = requestAnimationFrame(() => {
      this.pendingRender = false;
      this.render();
    });
  }

  render() {
    const img = this.images[this.currentFrameIndex];
    if (!img || !this.isReady) return;

    // Skip if this frame is already displayed
    if (this.currentFrameIndex === this.lastFrameIndex) return;
    this.lastFrameIndex = this.currentFrameIndex;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    clearTimeout(this._resizeTimer);
  }
}

window.addEventListener('load', () => {
  document.querySelectorAll('.scrub-section').forEach(section => {
    new ScrubVideo(section);
  });
});