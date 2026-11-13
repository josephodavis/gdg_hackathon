export interface DemoEntry {
  id: string;
  name: string;
  file: string;
}

export const API_URL: string | undefined = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || undefined;
export const RECONSTRUCT_TIMEOUT_MS = 120_000; // covers a Modal cold start

const base = import.meta.env.BASE_URL;

export async function fetchDemos(): Promise<DemoEntry[]> {
  const r = await fetch(`${base}demos/demos.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`demos.json: HTTP ${r.status}`);
  return r.json();
}

export async function fetchDemo(file: string): Promise<ArrayBuffer> {
  const r = await fetch(`${base}demos/${file}`);
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

export type Phase = 'uploading' | 'reconstructing';

/** POST photos to the GPU backend. Reports upload % then switches to 'reconstructing'. */
export function reconstruct(
  files: Blob[],
  names: string[],
  onPhase: (phase: Phase, pct?: number) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (!API_URL) return reject(new Error('No backend configured (VITE_API_URL is unset).'));
    const form = new FormData();
    files.forEach((f, i) => form.append('files', f, names[i]));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/reconstruct`);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = RECONSTRUCT_TIMEOUT_MS;
    xhr.upload.onprogress = (e) => e.lengthComputable && onPhase('uploading', Math.round((e.loaded / e.total) * 100));
    xhr.upload.onload = () => onPhase('reconstructing');
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response as ArrayBuffer);
      let msg = `HTTP ${xhr.status}`;
      try {
        const j = JSON.parse(new TextDecoder().decode(xhr.response as ArrayBuffer));
        if (j.detail) msg += `: ${typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)}`;
      } catch { /* not json */ }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Network error reaching the GPU backend.'));
    xhr.ontimeout = () => reject(new Error(`Timed out after ${RECONSTRUCT_TIMEOUT_MS / 1000}s.`));
    onPhase('uploading', 0);
    xhr.send(form);
  });
}

/** Downscale to <= maxSide JPEG in the browser (upload is the slow part). HEIC in Chrome can't decode → send original. */
export async function shrinkImage(file: File, maxSide = 1600): Promise<{ blob: Blob; name: string }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
  } catch {
    return { blob: file, name: file.name };
  }
}
