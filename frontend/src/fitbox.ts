import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { fromDisplay, getUnits, onUnits, toDisplay, toggleUnits, type Units } from './units';
import type { Viewer } from './viewer';

const OK = 0x34d399, BAD = 0xf87171;
const FLOOR_MARGIN = 0.04; // ignore floor points this close above floor
const MIN_HITS = 40, HIT_FRAC = 0.001;

export class FitBox {
  group = new THREE.Group();
  private mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  private tc: TransformControls;
  private label = document.createElement('div');
  private labelObj: CSS2DObject;
  private dirty = false;
  placed = false;
  dragging = false;
  inside = 0;
  private dims = { w: 2, d: 0.9, h: 0.85 };
  private viewer: Viewer;
  private els: { w: HTMLInputElement; d: HTMLInputElement; h: HTMLInputElement; btn: HTMLButtonElement; units: HTMLButtonElement; status: HTMLElement };

  constructor(viewer: Viewer, els: FitBox['els']) {
    this.viewer = viewer;
    this.els = els;
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    // Outline drawn on top of the cloud so the box stays readable inside furniture/walls.
    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.mesh.geometry),
      new THREE.LineBasicMaterial({ color: OK, depthTest: false, transparent: true }),
    );
    this.edges.renderOrder = 997;
    this.mesh.add(this.edges);
    this.group.add(this.mesh);
    this.label.className = 'm-label';
    this.labelObj = new CSS2DObject(this.label);
    this.group.add(this.labelObj);
    this.group.visible = false;
    viewer.scene.add(this.group);

    this.tc = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.tc.setSpace('local');
    this.setMode('translate');
    this.tc.addEventListener('dragging-changed', (e) => {
      this.dragging = !!e.value;
      viewer.controls.enabled = !e.value;
    });
    this.tc.addEventListener('objectChange', () => {
      // Free to raise (shelves, tabletops) but never sink below the floor.
      if (this.group.position.y < viewer.floorY) this.group.position.y = viewer.floorY;
      this.dirty = true;
    });
    viewer.scene.add(this.tc.getHelper());
    this.tc.getHelper().visible = false;

    els.btn.onclick = () => (this.placed ? this.remove() : this.place());
    // Only re-read the edited field: the others show rounded values and must not overwrite exact dims.
    for (const k of ['w', 'd', 'h'] as const) els[k].oninput = () => this.readDim(k);
    els.units.onclick = () => toggleUnits();
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, select, textarea') || !this.placed) return;
      if (e.key === 'r' || e.key === 'R') this.setMode(this.tc.mode === 'translate' ? 'rotate' : 'translate');
      if (e.key === 'f' || e.key === 'F') this.dropToFloor();
    });
    viewer.onFrame(() => {
      if (this.dirty && this.placed) {
        this.dirty = false;
        this.check();
      }
    });
    viewer.onLoad(() => this.remove());
    // dims live in meters; inputs are rendered from them in the current units (no drift on toggle)
    onUnits((u) => this.applyUnits(u));
    this.applyDims();
  }

  /** True while the pointer is over/using the gizmo (so measure clicks are ignored). */
  get busy() {
    return this.placed && (this.dragging || this.tc.axis !== null);
  }

  private setMode(m: 'translate' | 'rotate') {
    this.tc.setMode(m);
    this.tc.showX = m === 'translate';
    this.tc.showZ = m === 'translate';
    this.tc.showY = true; // translate: up/down arrow; rotate: turn about vertical
  }

  dropToFloor() {
    if (!this.placed) return;
    this.group.position.y = this.viewer.floorY;
    this.check();
  }

  private readDim(k: 'w' | 'd' | 'h') {
    const v = +this.els[k].value;
    if (!(v > 0)) return; // ignore empty/partial input
    this.dims[k] = fromDisplay(v);
    this.applyDims();
  }

  private applyUnits(u: Units) {
    this.els.units.textContent = u;
    for (const k of ['w', 'd', 'h'] as const) {
      this.els[k].value = String(toDisplay(this.dims[k], u));
      this.els[k].step = u === 'cm' ? '1' : '0.5';
    }
    if (this.placed) this.check();
  }

  private applyDims() {
    this.mesh.scale.set(this.dims.w, this.dims.h, this.dims.d);
    this.mesh.position.y = this.dims.h / 2;
    this.labelObj.position.set(0, this.dims.h + 0.08, 0);
    this.dirty = true;
  }

  place() {
    const v = this.viewer;
    if (!v.points) return;
    // Drop it where the view center hits the floor, else at the room center.
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, -0.2), v.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -v.floorY), new THREE.Vector3());
    const c = v.bounds.getCenter(new THREE.Vector3());
    const p = hit && v.bounds.containsPoint(new THREE.Vector3(hit.x, c.y, hit.z)) ? hit : c;
    this.group.position.set(p.x, v.floorY, p.z);
    this.group.rotation.set(0, 0, 0);
    this.group.visible = true;
    this.tc.attach(this.group);
    this.tc.getHelper().visible = true;
    this.tc.size = 0.8;
    this.placed = true;
    this.els.btn.textContent = 'Remove box';
    this.check();
  }

  remove() {
    this.tc.detach();
    this.tc.getHelper().visible = false;
    this.group.visible = false;
    this.placed = false;
    this.els.btn.textContent = 'Place box';
    this.els.status.textContent = '';
    this.els.status.className = 'fit-status';
  }

  /** Count cloud points inside the box (box-local test). */
  check() {
    const pts = this.viewer.points;
    if (!pts) return;
    const pos = pts.geometry.getAttribute('position').array as Float32Array;
    this.group.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    const e = inv.elements; // column-major
    const hw = this.dims.w / 2, hd = this.dims.d / 2, h = this.dims.h;
    let n = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const ly = e[1] * x + e[5] * y + e[9] * z + e[13];
      if (ly < FLOOR_MARGIN || ly > h) continue;
      const lx = e[0] * x + e[4] * y + e[8] * z + e[12];
      if (lx < -hw || lx > hw) continue;
      const lz = e[2] * x + e[6] * y + e[10] * z + e[14];
      if (lz < -hd || lz > hd) continue;
      n++;
    }
    this.inside = n;
    const collide = n > Math.max(MIN_HITS, (pos.length / 3) * HIT_FRAC);
    const b = this.viewer.bounds, p = this.group.position;
    const outside = !collide && (p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z);
    if (outside) {
      this.mesh.material.color.setHex(0x8c93a1);
      this.edges.material.color.setHex(0x8c93a1);
      this.label.style.borderColor = '#8c93a1';
      this.els.status.textContent = 'Outside the scan';
      this.els.status.className = 'fit-status';
      return;
    }
    const col = collide ? BAD : OK;
    this.mesh.material.color.setHex(col);
    this.edges.material.color.setHex(col);
    const u = getUnits(), f = (m: number) => toDisplay(m, u);
    const lift = this.group.position.y - this.viewer.floorY;
    this.label.textContent = `${f(this.dims.w)}×${f(this.dims.d)}×${f(this.dims.h)} ${u}` + (lift > 0.01 ? ` · ↑ ${f(lift)} ${u}` : '');
    this.label.style.borderColor = collide ? '#f87171' : '#34d399';
    this.els.status.textContent = collide ? `✕ Collides (${n.toLocaleString()} pts)` : '✓ Fits';
    this.els.status.className = `fit-status ${collide ? 'bad' : 'ok'}`;
  }
}
