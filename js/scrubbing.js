class ScrubVideo {
  constructor(section) {
    this.section = section;
    this.canvas = section.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d'); // alpha ON per your comment
    this.figcaption = section.querySelector('figcaption');
    this.folder = section.dataset.folder;
    this.totalImages = parseInt(section.dataset.frames, 10);
    this.images = new Array(this.totalImages);
    
    // State
    this.currentFrameIndex = 0;
    this.lastFrameIndex = -1;
    this.lastDrawnFrame = -1; // Tracks the actual image drawn for fallback logic
    this.pendingRender = false;
    this.isInView = false;

    // Cached Layout Metrics (Crucial for low-end devices)
    this.rectTop = 0;
    this.rectHeight = 0;
    this.winHeight = 0;

    // Visual states for batching DOM writes
    this.targetFilter = '';
    this.targetOpacity = '';
    this.lastFilter = '';
    this.lastOpacity = '';

    this.init();
  }

  init() {
    this.resize();

    // 1. Intersection Observer: Only process scroll if section is nearby
    this.observer = new IntersectionObserver((entries) => {
      this.isInView = entries[0].isIntersecting;
      if (this.isInView) {
        this.updateScrollMath(); // Re-sync positions just in case DOM shifted
        this.onScroll(); 
      }
    }, { rootMargin: '100% 0px' }); // Start triggering one viewport height early
    this.observer.observe(this.section);

    // 2. Load the first frame immediately so the user sees something
    this.loadSingleImage(0).then(() => {
      this.scheduleRender();
      // 3. Load the rest in batches to avoid network freezing and long sequential waits
      this.loadRemainingImagesBatched();
    });

    // 4. Listeners
    window.addEventListener('scroll', () => this.isInView && this.onScroll(), { passive: true });
    window.addEventListener('resize', () => this.debouncedResize(), { passive: true });
  }

  // Load images in manageable batches (e.g., 10 at a time)
  async loadRemainingImagesBatched() {
    const batchSize = 10; 
    
    for (let i = 1; i < this.totalImages; i += batchSize) {
      const batch = [];
      for (let j = 0; j < batchSize && (i + j) < this.totalImages; j++) {
        batch.push(this.loadSingleImage(i + j));
      }
      // Wait for these 10 to finish before requesting the next 10
      await Promise.all(batch); 
      
      // Tell the render loop to check if it missed a frame while waiting
      if (this.isInView) this.scheduleRender(); 
    }
  }

  loadSingleImage(index) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async'; // Decodes off the main thread
      img.onload = () => {
        this.images[index] = img;
        resolve();
      };
      img.onerror = resolve; // Continue sequence even if one frame 404s
      
      // Note: Swap .png to .webp here and in your folder for massive speed gains
      img.src = `${this.folder}${index + 1}.png`;
    });
  }

  debouncedResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this.resize(), 100);
  }

  resize() {
    this.winHeight = window.innerHeight;
    this.canvas.width = window.innerWidth;
    this.canvas.height = this.winHeight;
    this.updateScrollMath();
    
    this.lastFrameIndex = -1; // Force a redraw
    if (this.isInView) this.scheduleRender();
  }

  updateScrollMath() {
    // Cache absolute positions so we don't query the DOM in the scroll loop
    const rect = this.section.getBoundingClientRect();
    this.rectTop = rect.top + window.scrollY; 
    this.rectHeight = rect.height;
  }

  onScroll() {
    // High-performance math using cached layout metrics
    const scrollY = window.scrollY;
    const currentRectTop = this.rectTop - scrollY;

    let scrollProgress = (this.winHeight - currentRectTop) / (this.rectHeight + this.winHeight);
    scrollProgress = Math.max(0, Math.min(scrollProgress, 1)); // Clamp 0 to 1

    this.currentFrameIndex = Math.min(
      Math.floor(scrollProgress * this.totalImages),
      this.totalImages - 1
    );

    const brightness = Math.min(100, scrollProgress * 80);
    this.targetFilter = `brightness(${brightness.toFixed(1)}%)`;
    this.targetOpacity = scrollProgress.toFixed(3);

    // Only wake up the render loop if visually necessary
    if (this.currentFrameIndex !== this.lastFrameIndex || this.targetFilter !== this.lastFilter) {
      this.scheduleRender();
    }
  }

  scheduleRender() {
    if (this.pendingRender) return;
    this.pendingRender = true;
    requestAnimationFrame(() => this.render());
  }

  render() {
    this.pendingRender = false;

    // Batch DOM style updates in rAF to prevent layout thrashing
    if (this.targetFilter !== this.lastFilter) {
      this.canvas.style.filter = this.targetFilter;
      this.lastFilter = this.targetFilter;
    }

    if (this.figcaption && this.targetOpacity !== this.lastOpacity) {
      this.figcaption.style.opacity = this.targetOpacity;
      this.lastOpacity = this.targetOpacity;
    }

    let img = this.images[this.currentFrameIndex];
    let actualFrameDrawn = this.currentFrameIndex;

    // Fallback to the closest loaded frame if the user scrubs too fast
    if (!img) {
      for (let i = this.currentFrameIndex - 1; i >= 0; i--) {
        if (this.images[i]) {
          img = this.images[i];
          actualFrameDrawn = i;
          break;
        }
      }
    }

    // If still no image, or we already drew this exact frame state, do nothing
    if (!img || (this.currentFrameIndex === this.lastFrameIndex && this.lastDrawnFrame === actualFrameDrawn)) {
      return;
    }

    this.lastFrameIndex = this.currentFrameIndex;
    this.lastDrawnFrame = actualFrameDrawn; 

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    if (this.observer) this.observer.disconnect();
    clearTimeout(this._resizeTimer);
  }
}

// Ensure the page's critical path is clear before initializing
window.addEventListener('load', () => {
  document.querySelectorAll('.scrub-section').forEach(section => {
    new ScrubVideo(section);
  });
});