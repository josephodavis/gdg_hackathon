import './ui.css';
import { fetchDemo, fetchDemos, type DemoEntry } from './api';
import { MeasureTool } from './measure';
import { decodePayload } from './payload';
import { UploadPanel } from './upload';
import { Viewer } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- state machine
// idle → uploading → reconstructing → building → viewing, any → error
type State = 'idle' | 'uploading' | 'reconstructing' | 'building' | 'viewing' | 'error';
const BUSY: State[] = ['uploading', 'reconstructing', 'building'];
let state: State = 'idle';
let busySince = 0;
let label = '';
let timer: number | undefined;
let upload: UploadPanel | undefined;

const statusEl = $('status');
const statusText = $('status-text');
const statusDemoBtn = $('status-demo-btn');

function renderStatus() {
  const busy = BUSY.includes(state);
  const secs = Math.floor((performance.now() - busySince) / 1000);
  statusText.textContent = busy && secs >= 1 ? `${label} · ${secs}s` : label;
}

function setState(s: State, l = '') {
  const wasBusy = BUSY.includes(state);
  const busy = BUSY.includes(s);
  if (busy && !wasBusy) busySince = performance.now();
  state = s;
  label = l;
  statusEl.classList.toggle('hidden', s === 'viewing' || s === 'idle');
  statusEl.classList.toggle('error', s === 'error');
  statusDemoBtn.classList.toggle('hidden', s !== 'error');
  clearInterval(timer);
  if (busy) timer = window.setInterval(renderStatus, 250);
  renderStatus();
  document.body.dataset.state = s;
  upload?.render();
}

// ---------------------------------------------------------------- viewer
const viewer = new Viewer($('viewport'));
(window as unknown as { viewer: Viewer }).viewer = viewer; // handy in devtools

function showPayload(buf: ArrayBuffer, name: string, downloadName?: string) {
  setState('building', 'Building view');
  const p = decodePayload(buf);
  viewer.load(p);
  const h = p.header;
  const s = viewer.bounds.getSize(viewer.bounds.min.clone());
  const t = h.timingMs ?? {};
  const info = $('scene-info');
  info.textContent =
    `${name}: ${h.numPoints.toLocaleString()} pts · ${h.numImages} photos · ` +
    `${s.x.toFixed(1)}×${s.z.toFixed(1)}×${s.y.toFixed(1)} m` +
    (t.infer ? ` · GPU ${(t.infer / 1000).toFixed(1)}s` : '');
  if (downloadName) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
    a.download = downloadName;
    a.textContent = ' · Save .bin';
    info.appendChild(a);
  }
  setState('viewing');
}

// ---------------------------------------------------------------- scenes (cached demos + live scans)
const demoSelect = $<HTMLSelectElement>('demo-select');
let demos: DemoEntry[] = [];
const scans = new Map<string, { name: string; buf: ArrayBuffer }>();

function renderSceneOptions(selected?: string) {
  const opts = [
    ...[...scans].map(([id, s]) => `<option value="${id}">${s.name}</option>`),
    ...demos.map((d) => `<option value="${d.id}">${d.name}</option>`),
  ];
  demoSelect.innerHTML = opts.join('');
  if (selected) demoSelect.value = selected;
}

async function loadScene(id?: string) {
  try {
    const scan = id ? scans.get(id) : undefined;
    if (scan) return showPayload(scan.buf, scan.name, `${id}.bin`);
    if (!demos.length) throw new Error('No demo scenes found.');
    const d = demos.find((x) => x.id === id) ?? demos[0];
    demoSelect.value = d.id;
    setState('building', `Loading ${d.name}`);
    showPayload(await fetchDemo(d.file), d.name);
  } catch (e) {
    console.warn(e);
    setState('error', `Couldn't load scene: ${(e as Error).message}`);
  }
}

async function initDemos() {
  try {
    demos = await fetchDemos();
  } catch (e) {
    console.warn(e);
  }
  // Real scans first, synthetic last.
  demos.sort((a, b) => Number(a.id === 'synthetic') - Number(b.id === 'synthetic'));
  renderSceneOptions();
  demoSelect.onchange = () => loadScene(demoSelect.value);
  await loadScene(new URLSearchParams(location.search).get('demo') ?? undefined);
}
statusDemoBtn.onclick = () => loadScene(scans.has(demoSelect.value) ? demos[0]?.id : demoSelect.value);

// ---------------------------------------------------------------- upload
upload = new UploadPanel({
  isBusy: () => BUSY.includes(state),
  onStatus: (s, l) => setState(s, l),
  onResult: (buf) => {
    const id = `scan-${scans.size + 1}`;
    const name = `Your scan ${scans.size + 1} (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    try {
      decodePayload(buf); // validate before storing
      scans.set(id, { name, buf });
      renderSceneOptions(id);
      showPayload(buf, name, `${id}.bin`);
    } catch (e) {
      setState('error', `Bad response from GPU backend: ${(e as Error).message}`);
    }
  },
});

// ---------------------------------------------------------------- view controls
$('view-photo').onclick = () => viewer.frame('photo');
$('view-overview').onclick = () => viewer.frame('overview');
$<HTMLInputElement>('point-size').oninput = (e) => viewer.setPointSize(+(e.target as HTMLInputElement).value);
$<HTMLInputElement>('toggle-frustums').onchange = (e) => viewer.setFrustumsVisible((e.target as HTMLInputElement).checked);
$<HTMLInputElement>('toggle-grid').onchange = (e) => viewer.setGridVisible((e.target as HTMLInputElement).checked);

// ---------------------------------------------------------------- measure
export const measure = new MeasureTool(viewer, {
  btn: $<HTMLButtonElement>('measure-btn'),
  units: $<HTMLButtonElement>('units-btn'),
  list: $<HTMLOListElement>('measure-list'),
  hint: $('hint'),
});

export { viewer };
initDemos();
