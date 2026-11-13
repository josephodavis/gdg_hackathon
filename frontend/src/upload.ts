import { API_URL, reconstruct, shrinkImage } from './api';

const MIN = 2, MAX = 30, MAX_MB = 15;
const isImage = (f: File) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name);

export interface UploadHooks {
  isBusy: () => boolean;
  onStatus: (state: 'uploading' | 'reconstructing' | 'error', label: string) => void;
  onResult: (buf: ArrayBuffer) => void;
}

export class UploadPanel {
  files: File[] = [];
  private hooks: UploadHooks;
  private els = {
    dz: document.getElementById('dropzone')!,
    input: document.getElementById('file-input') as HTMLInputElement,
    pick: document.getElementById('pick-btn')!,
    thumbs: document.getElementById('thumbs')!,
    count: document.getElementById('file-count')!,
    go: document.getElementById('reconstruct-btn') as HTMLButtonElement,
  };

  constructor(hooks: UploadHooks) {
    this.hooks = hooks;
    const { dz, input, pick, go } = this.els;
    pick.onclick = () => input.click();
    input.onchange = () => {
      this.add([...(input.files ?? [])]);
      input.value = '';
    };
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('over');
      this.add([...(e.dataTransfer?.files ?? [])]);
    });
    go.onclick = () => this.run();
    this.render();
  }

  add(list: File[]) {
    const seen = new Set(this.files.map((f) => f.name + f.size));
    for (const f of list) {
      if (!isImage(f) || seen.has(f.name + f.size)) continue;
      seen.add(f.name + f.size);
      this.files.push(f);
    }
    this.renderThumbs();
    this.render();
  }

  clear() {
    this.files = [];
    this.renderThumbs();
    this.render();
  }

  private urls = new Map<File, string>();

  /** Rebuild thumbnails — only when the file list changes. */
  private renderThumbs() {
    const { thumbs } = this.els;
    for (const [f, u] of this.urls) {
      if (!this.files.includes(f)) {
        URL.revokeObjectURL(u);
        this.urls.delete(f);
      }
    }
    thumbs.innerHTML = '';
    for (const f of this.files.slice(0, 30)) {
      if (!this.urls.has(f)) this.urls.set(f, URL.createObjectURL(f));
      const img = document.createElement('img');
      img.src = this.urls.get(f)!;
      img.title = f.name;
      img.onerror = () => {
        const d = document.createElement('div');
        d.className = 'heic';
        d.textContent = f.name.split('.').pop()!.toUpperCase();
        d.title = f.name;
        img.replaceWith(d);
      };
      thumbs.appendChild(img);
    }
  }

  /** Count + button state — cheap, called on every app state change. */
  render() {
    const { count, go } = this.els;
    const n = this.files.length;
    const big = this.files.filter((f) => f.size > MAX_MB * 1024 * 1024).length;
    let msg = `${n} photo${n === 1 ? '' : 's'}`;
    if (n > MAX) msg += ` · max ${MAX}`;
    else if (n > 0 && n < MIN) msg += ` · need ${MIN}+`;
    else if (n > 0 && n < 10) msg += ' · 10+ is better';
    if (big) msg += ` · ${big} over ${MAX_MB} MB`;
    count.innerHTML = n ? `${msg} · <button class="link" id="clear-files">clear</button>` : msg;
    document.getElementById('clear-files')?.addEventListener('click', () => this.clear());
    go.disabled = n < MIN || n > MAX || this.hooks.isBusy();
  }

  async run() {
    const { onStatus, onResult } = this.hooks;
    if (!API_URL) {
      onStatus('error', 'GPU backend not configured (set VITE_API_URL). Try a demo scene instead.');
      return;
    }
    this.els.go.disabled = true;
    try {
      onStatus('uploading', 'Preparing photos');
      const shrunk = await Promise.all(this.files.map((f) => shrinkImage(f)));
      const mb = shrunk.reduce((s, x) => s + x.blob.size, 0) / 1e6;
      const buf = await reconstruct(
        shrunk.map((s) => s.blob),
        shrunk.map((s) => s.name),
        (phase, pct) =>
          phase === 'uploading'
            ? onStatus('uploading', `Uploading ${shrunk.length} photos (${mb.toFixed(1)} MB) ${pct ?? 0}%`)
            : onStatus('reconstructing', 'Reconstructing on GPU'),
      );
      onResult(buf);
    } catch (e) {
      console.warn('reconstruct failed:', e);
      onStatus('error', `Reconstruction failed: ${(e as Error).message}`);
    } finally {
      this.render();
    }
  }
}
