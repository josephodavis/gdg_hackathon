import './ui.css';
import { fetchDemo, fetchDemos, type DemoEntry } from './api';
import { decodePayload } from './payload';
import { Viewer } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- state machine
type State = 'idle' | 'uploading' | 'reconstructing' | 'building' | 'viewing' | 'error';
let state: State = 'idle';
let phaseStart = 0;
let phaseLabel = '';
let timer: number | undefined;

const statusEl = $('status');
const statusText = $('status-text');
const statusDemoBtn = $('status-demo-btn');

export function setState(s: State, label = '') {
  state = s;
  phaseLabel = label;
  phaseStart = performance.now();
  clearInterval(timer);
  const busy = s === 'uploading' || s === 'reconstructing' || s === 'building';
  statusEl.classList.toggle('hidden', s === 'viewing' || s === 'idle');
  statusEl.classList.toggle('error', s === 'error');
  statusDemoBtn.classList.toggle('hidden', s !== 'error');
  const render = () => {
    const secs = ((performance.now() - phaseStart) / 1000).toFixed(0);
    statusText.textContent = busy ? `${phaseLabel} · ${secs}s` : phaseLabel;
  };
  render();
  if (busy) timer = window.setInterval(render, 250);
  document.body.dataset.state = s;
}
export const getState = () => state;

// ---------------------------------------------------------------- viewer
const viewer = new Viewer($('viewport'));
(window as unknown as { viewer: Viewer }).viewer = viewer; // handy in devtools

export function showPayload(buf: ArrayBuffer, label: string) {
  setState('building', 'Building view');
  const p = decodePayload(buf);
  viewer.load(p);
  const h = p.header;
  const s = viewer.bounds.getSize(viewer.bounds.min.clone());
  const t = h.timingMs ?? {};
  $('scene-info').textContent =
    `${label}: ${h.numPoints.toLocaleString()} pts · ${h.numImages} photos · ` +
    `${s.x.toFixed(1)}×${s.z.toFixed(1)}×${s.y.toFixed(1)} m` +
    (t.infer ? ` · GPU ${(t.infer / 1000).toFixed(1)}s` : '');
  setState('viewing');
}

// ---------------------------------------------------------------- demos
const demoSelect = $<HTMLSelectElement>('demo-select');
let demos: DemoEntry[] = [];

export async function loadDemo(id?: string) {
  try {
    if (!demos.length) throw new Error('No demo scenes found.');
    const d = demos.find((x) => x.id === id) ?? demos[0];
    demoSelect.value = d.id;
    setState('building', `Loading ${d.name}`);
    showPayload(await fetchDemo(d.file), d.name);
  } catch (e) {
    console.error(e);
    setState('error', `Couldn't load demo: ${(e as Error).message}`);
  }
}

async function initDemos() {
  try {
    demos = await fetchDemos();
  } catch (e) {
    console.error(e);
  }
  // Real scans first, synthetic last.
  demos.sort((a, b) => Number(a.id === 'synthetic') - Number(b.id === 'synthetic'));
  demoSelect.innerHTML = demos.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
  demoSelect.onchange = () => loadDemo(demoSelect.value);
  await loadDemo(new URLSearchParams(location.search).get('demo') ?? undefined);
}
statusDemoBtn.onclick = () => loadDemo(demoSelect.value);

// ---------------------------------------------------------------- view controls
$<HTMLInputElement>('point-size').oninput = (e) => viewer.setPointSize(+(e.target as HTMLInputElement).value);
$<HTMLInputElement>('toggle-frustums').onchange = (e) => viewer.setFrustumsVisible((e.target as HTMLInputElement).checked);
$<HTMLInputElement>('toggle-grid').onchange = (e) => viewer.setGridVisible((e.target as HTMLInputElement).checked);

export { viewer };
initDemos();
