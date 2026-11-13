import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Viewer } from './viewer';

export type Units = 'cm' | 'in';

interface Measurement {
  id: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  group: THREE.Group;
  label: HTMLDivElement;
}

const COLOR = 0x38bdf8;

export function formatLength(m: number, units: Units): string {
  if (units === 'cm') return `${(m * 100).toFixed(1)} cm`;
  const inches = m / 0.0254;
  return inches >= 24 ? `${inches.toFixed(1)} in (${Math.floor(inches / 12)}′ ${(inches % 12).toFixed(1)}″)` : `${inches.toFixed(1)} in`;
}

/** Pick the actual cloud vertex under a screen position (NDC). */
export function pickPoint(viewer: Viewer, ndc: THREE.Vector2, raycaster = new THREE.Raycaster()): THREE.Vector3 | null {
  const pts = viewer.points;
  if (!pts) return null;
  const thr = viewer.diag * 0.005;
  raycaster.params.Points = { threshold: thr };
  raycaster.setFromCamera(ndc, viewer.camera);
  const hits = raycaster.intersectObject(pts, false);
  if (!hits.length) return null;
  // Among hits close in depth to the first one, take the vertex nearest the ray (avoids snapping to floaters).
  const front = hits[0].distance;
  let best = hits[0];
  for (const h of hits) {
    if (h.distance > front + thr * 3) break;
    if ((h.distanceToRay ?? 0) < (best.distanceToRay ?? 0)) best = h;
  }
  const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
  return new THREE.Vector3().fromBufferAttribute(pos, best.index!);
}

export class MeasureTool {
  active = false;
  units: Units = 'cm';
  private pending: THREE.Vector3 | null = null;
  private items: Measurement[] = [];
  private nextId = 1;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private hoverDirty = false;
  private down: { x: number; y: number; t: number } | null = null;
  /** Set by other tools (fit box drag) to suppress picking. */
  blocked = () => false;

  private hoverMarker: THREE.Mesh;
  private previewGroup = new THREE.Group();
  private previewLine: Line2;
  private previewLabel: HTMLDivElement;
  private markerGeom = new THREE.SphereGeometry(1, 16, 12);
  private markerMat = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true });
  private lineMat = new LineMaterial({ color: COLOR, linewidth: 3, depthTest: false, transparent: true });
  private previewMat = new LineMaterial({ color: COLOR, linewidth: 2, depthTest: false, transparent: true, dashed: true, dashSize: 0.03, gapSize: 0.02, opacity: 0.85 });

  private viewer: Viewer;
  private els: { btn: HTMLButtonElement; units: HTMLButtonElement; list: HTMLOListElement; hint: HTMLElement };

  constructor(viewer: Viewer, els: MeasureTool['els']) {
    this.viewer = viewer;
    this.els = els;
    this.hoverMarker = new THREE.Mesh(this.markerGeom, this.markerMat);
    this.hoverMarker.renderOrder = 999;
    this.hoverMarker.visible = false;
    viewer.scene.add(this.hoverMarker);

    this.previewLine = new Line2(new LineGeometry(), this.previewMat);
    this.previewLine.renderOrder = 998;
    this.previewLabel = document.createElement('div');
    this.previewLabel.className = 'm-label preview';
    const pl = new CSS2DObject(this.previewLabel);
    this.previewGroup.add(this.previewLine, pl);
    this.previewGroup.visible = false;
    viewer.scene.add(this.previewGroup);

    const canvas = viewer.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => (this.hoverMarker.visible = false));

    els.btn.onclick = () => this.toggle();
    els.units.onclick = () => this.setUnits(this.units === 'cm' ? 'in' : 'cm');
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === 'm' || e.key === 'M') this.toggle();
      else if (e.key === 'Escape') this.pending ? this.cancelPending() : this.active && this.toggle(false);
    });

    viewer.onFrame(() => this.frame());
    viewer.onLoad(() => this.clearAll());
  }

  toggle(on = !this.active) {
    this.active = on;
    this.cancelPending();
    this.els.btn.classList.toggle('active', on);
    this.els.btn.textContent = on ? 'Stop measuring' : 'Start measuring';
    this.viewer.container.classList.toggle('measuring', on);
    this.hoverMarker.visible = false;
    this.updateHint();
  }

  setUnits(u: Units) {
    this.units = u;
    this.els.units.textContent = u;
    for (const m of this.items) m.label.textContent = formatLength(m.a.distanceTo(m.b), u);
    this.renderList();
  }

  private updateHint() {
    const h = this.els.hint;
    h.classList.toggle('hidden', !this.active);
    h.textContent = this.pending ? 'Click the second point · Esc to cancel' : 'Click the first point · M to exit';
  }

  private onMove(e: PointerEvent) {
    if (!this.active) return;
    const r = this.viewer.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.hoverDirty = true;
  }

  private onUp(e: PointerEvent) {
    const d = this.down;
    this.down = null;
    if (!this.active || !d || e.button !== 0 || this.blocked()) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return; // it was an orbit drag
    this.onMove(e);
    const p = pickPoint(this.viewer, this.mouse, this.raycaster);
    if (!p) return;
    if (!this.pending) {
      this.pending = p;
    } else {
      this.add(this.pending, p);
      this.pending = null;
      this.previewGroup.visible = false;
    }
    this.updateHint();
  }

  private markerScale() {
    return this.viewer.diag * 0.004;
  }

  private frame() {
    const res = this.viewer.renderer.getSize(new THREE.Vector2());
    this.lineMat.resolution.copy(res);
    this.previewMat.resolution.copy(res);
    if (!this.active || !this.hoverDirty || this.blocked()) return;
    this.hoverDirty = false;
    const p = pickPoint(this.viewer, this.mouse, this.raycaster);
    this.hoverMarker.visible = !!p;
    if (!p) return;
    this.hoverMarker.position.copy(p);
    this.hoverMarker.scale.setScalar(this.markerScale());
    if (this.pending) {
      (this.previewLine.geometry as LineGeometry).setPositions([...this.pending.toArray(), ...p.toArray()]);
      this.previewLine.computeLineDistances();
      this.previewGroup.children[1].position.lerpVectors(this.pending, p, 0.5);
      this.previewLabel.textContent = formatLength(this.pending.distanceTo(p), this.units);
      this.previewGroup.visible = true;
    }
  }

  add(a: THREE.Vector3, b: THREE.Vector3) {
    const group = new THREE.Group();
    const geom = new LineGeometry();
    geom.setPositions([...a.toArray(), ...b.toArray()]);
    const line = new Line2(geom, this.lineMat);
    line.renderOrder = 998;
    group.add(line);
    for (const p of [a, b]) {
      const s = new THREE.Mesh(this.markerGeom, this.markerMat);
      s.position.copy(p);
      s.scale.setScalar(this.markerScale());
      s.renderOrder = 999;
      group.add(s);
    }
    const label = document.createElement('div');
    label.className = 'm-label';
    label.textContent = formatLength(a.distanceTo(b), this.units);
    const lo = new CSS2DObject(label);
    lo.position.lerpVectors(a, b, 0.5);
    group.add(lo);
    this.viewer.scene.add(group);
    this.items.push({ id: this.nextId++, a: a.clone(), b: b.clone(), group, label });
    this.renderList();
  }

  remove(id: number) {
    const i = this.items.findIndex((m) => m.id === id);
    if (i < 0) return;
    const m = this.items[i];
    this.viewer.scene.remove(m.group);
    m.group.traverse((o) => o instanceof Line2 && o.geometry.dispose());
    m.label.remove();
    this.items.splice(i, 1);
    this.renderList();
  }

  clearAll() {
    for (const m of [...this.items]) this.remove(m.id);
    this.nextId = 1;
    this.cancelPending();
  }

  private cancelPending() {
    this.pending = null;
    this.previewGroup.visible = false;
    this.updateHint();
  }

  private renderList() {
    const list = this.els.list;
    list.innerHTML = '';
    for (const m of this.items) {
      const li = document.createElement('li');
      li.innerHTML = `<div class="m-row"><span>${formatLength(m.a.distanceTo(m.b), this.units)}</span><button title="Delete">✕</button></div>`;
      li.querySelector('button')!.onclick = () => this.remove(m.id);
      li.onmouseenter = () => { li.classList.add('hl'); m.label.style.borderColor = '#ffa630'; };
      li.onmouseleave = () => { li.classList.remove('hl'); m.label.style.borderColor = ''; };
      list.appendChild(li);
    }
  }
}
