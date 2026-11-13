// One display-unit setting shared by all tools (measure, fit box).
export type Units = 'cm' | 'in';

const KEY = 'truescale.units';
let current: Units = 'cm';
try {
  if (localStorage.getItem(KEY) === 'in') current = 'in';
} catch { /* storage unavailable */ }
const listeners: Array<(u: Units) => void> = [];

export const getUnits = () => current;
export function setUnits(u: Units) {
  current = u;
  try { localStorage.setItem(KEY, u); } catch { /* ignore */ }
  for (const cb of listeners) cb(u);
}
export const toggleUnits = () => setUnits(current === 'cm' ? 'in' : 'cm');
export function onUnits(cb: (u: Units) => void) {
  listeners.push(cb);
  cb(current);
}

/** meters -> number in display units (cm: whole numbers, in: 1 decimal). */
export function toDisplay(m: number, u: Units = current): number {
  return u === 'cm' ? Math.round(m * 1000) / 10 : Math.round((m / 0.0254) * 10) / 10;
}
/** display-unit number -> meters */
export function fromDisplay(v: number, u: Units = current): number {
  return u === 'cm' ? v / 100 : v * 0.0254;
}
